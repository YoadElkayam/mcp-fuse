import {
  DEFAULT_RETRYABLE,
  type ErrorCategory,
  type ErrorPolicy,
  type RawFailure,
} from "./types.js";

interface MessageRule {
  pattern: RegExp;
  category: ErrorCategory;
}

/** Conservative, overridable heuristics for servers that emit only free text.
 * Kept as data so the corpus can grow via community PRs. */
const MESSAGE_RULES: MessageRule[] = [
  { pattern: /rate.?limit|too many requests|429/i, category: "rate_limit" },
  { pattern: /quota exceeded|billing|payment required/i, category: "resource_exhausted" },
  { pattern: /timed?.?out|deadline exceeded|ETIMEDOUT|ESOCKETTIMEDOUT/i, category: "timeout" },
  { pattern: /ECONNREFUSED|ECONNRESET|EPIPE|EAI_AGAIN|socket hang up|service unavailable/i, category: "transient" },
  { pattern: /unauthorized|unauthenticated|invalid.{0,10}(token|api.?key)|expired.{0,10}(token|credential)/i, category: "auth" },
  { pattern: /forbidden|permission denied|access denied/i, category: "permission" },
  { pattern: /not found|no such (file|tool|method|resource)/i, category: "not_found" },
];

function categorizeHttp(status: number): ErrorCategory {
  if (status === 429) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 400 || status === 422) return "invalid_input";
  if (status >= 500) return "transient";
  return "unknown";
}

function categorizeJsonRpc(code: number): ErrorCategory {
  switch (code) {
    case -32700: // parse error
    case -32600: // invalid request
    case -32602: // invalid params
      return "invalid_input";
    case -32601: // method not found
      return "not_found";
    case -32603: // internal error — opaque; treat as unknown (one retry)
    default:
      return "unknown";
  }
}

function categorize(failure: RawFailure): ErrorCategory {
  if (failure.httpStatus !== undefined) return categorizeHttp(failure.httpStatus);
  if (failure.message) {
    // A status line at the start of the payload ("HTTP 503 Service Unavailable")
    // is a stronger signal than any keyword buried in a stack trace below it.
    const statusLine = failure.message.slice(0, 80).match(/\bHTTP\/?[\d.]*\s+(\d{3})\b/);
    if (statusLine) return categorizeHttp(Number(statusLine[1]));
    for (const rule of MESSAGE_RULES) {
      if (rule.pattern.test(failure.message)) return rule.category;
    }
  }
  if (failure.jsonrpcCode !== undefined) return categorizeJsonRpc(failure.jsonrpcCode);
  return "unknown";
}

function defaultGuidance(category: ErrorCategory, retryable: boolean): string {
  if (retryable) {
    switch (category) {
      case "rate_limit":
        return "This tool is rate limited. The system waits and retries automatically; do not re-invoke it yourself.";
      case "timeout":
        return "The tool timed out upstream. The system retries automatically; do not re-invoke this tool yourself.";
      default:
        return "A temporary infrastructure failure occurred. The system retries automatically; do not re-invoke this tool yourself.";
    }
  }
  switch (category) {
    case "auth":
      return "This tool's credentials are invalid or expired. Retrying cannot fix this; ask the user to re-authenticate.";
    case "permission":
      return "Access to this tool is forbidden for the current credentials. Do not retry.";
    case "invalid_input":
      return "The tool rejected the input as invalid. Do not repeat the identical call; fix the arguments or take a different approach.";
    case "not_found":
      return "The requested tool or resource does not exist. Do not retry with the same name.";
    case "resource_exhausted":
      return "A hard quota has been exhausted. Retrying will not help; inform the user.";
    default:
      return "This operation failed permanently. Do not retry; use an alternative approach or inform the user.";
  }
}

/** Extract a Retry-After value quoted inside raw error text (headers dumped into
 * the payload, "retry_after_seconds": 12, etc.). Seconds → milliseconds. */
function retryAfterFromMessage(message: string | undefined): number | undefined {
  const m = message?.match(/retry[-_ ]?after[^0-9]{0,15}?(\d{1,5})\b/i);
  return m ? Number(m[1]) * 1000 : undefined;
}

/** Synthesize an MCP Error Policy from a raw failure. Pure function; the proxy's
 * zero-config heart. */
export function classify(failure: RawFailure): ErrorPolicy {
  const category = categorize(failure);
  const retryable = DEFAULT_RETRYABLE[category];
  const policy: ErrorPolicy = {
    version: "1",
    category,
    retryable,
    agentGuidance: defaultGuidance(category, retryable),
    detail: failure.message,
  };
  if (retryable) {
    policy.retry = {
      strategy: category === "rate_limit" ? "fixed" : "exponential",
      afterMs: failure.retryAfterMs ?? retryAfterFromMessage(failure.message),
      initialDelayMs: 1000,
      maxDelayMs: 60_000,
      maxAttempts: category === "unknown" ? 1 : 3,
      jitter: true,
    };
  }
  return policy;
}
