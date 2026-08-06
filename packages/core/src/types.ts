/** MEP payload key while the extension is unofficial. Consumers must also accept
 * the future official key `io.modelcontextprotocol/error-policy`. */
export const ERROR_POLICY_META_KEY = "dev.mcp-fuse/error-policy";

/** HTTP response header carrying a base64url-encoded MEP payload. */
export const ERROR_POLICY_HTTP_HEADER = "MCP-Error-Policy";

export type ErrorCategory =
  | "transient"
  | "rate_limit"
  | "timeout"
  | "auth"
  | "permission"
  | "invalid_input"
  | "not_found"
  | "resource_exhausted"
  | "permanent"
  | "unknown";

export type RetryStrategy = "none" | "fixed" | "exponential";

export interface RetryDirective {
  strategy?: RetryStrategy;
  /** Authoritative earliest-retry delay (e.g. from Retry-After). */
  afterMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  jitter?: boolean;
}

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitDirective {
  state?: CircuitState;
  reopenAfterMs?: number;
}

/** The MCP Error Policy (MEP) v1 payload. Mirrors spec/error-policy.schema.json. */
export interface ErrorPolicy {
  version: "1";
  category: ErrorCategory;
  retryable?: boolean;
  retry?: RetryDirective;
  circuit?: CircuitDirective;
  /** The ONLY text intended for the model. Imperative, ≤500 chars, no stack traces. */
  agentGuidance?: string;
  /** Diagnostic detail for logs/humans. Never forwarded to the model. */
  detail?: string;
  correlationId?: string;
}

/** Normalized view of a raw MCP failure, from any of the three layers. */
export interface RawFailure {
  /** JSON-RPC error code, if the failure was a protocol error. */
  jsonrpcCode?: number;
  /** HTTP status, if the failure surfaced at the transport layer. */
  httpStatus?: number;
  /** Retry-After header value in milliseconds, if present. */
  retryAfterMs?: number;
  /** Error message / tool-result error text. */
  message?: string;
  /** True when the failure came from a CallToolResult with isError: true. */
  isToolResult?: boolean;
}

export const DEFAULT_RETRYABLE: Record<ErrorCategory, boolean> = {
  transient: true,
  rate_limit: true,
  timeout: true,
  auth: false,
  permission: false,
  invalid_input: false,
  not_found: false,
  resource_exhausted: false,
  permanent: false,
  unknown: true, // one cautious retry; see classifier
};
