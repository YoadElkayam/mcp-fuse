import type { ErrorPolicy } from "./types.js";

/**
 * The idempotency gate (spec/README.md "Idempotency gate", DESIGN §3.3).
 *
 * Failure classes that guarantee the upstream request was never processed —
 * the only ones safe to replay against a tool with side effects.
 */
const NOT_PROCESSED_PATTERN =
  /ECONNREFUSED|ECONNRESET|EPIPE|connection refused|reset before|HTTP\/?[\d.]*\s+(?:429|503)|too many requests|service unavailable/i;

/**
 * Whether a failed tools/call may be silently replayed, given the tool's
 * declared idempotency (readOnlyHint/idempotentHint from tools/list, or an
 * explicit operator override).
 */
export function silentRetryAllowed(
  policy: ErrorPolicy,
  toolIsIdempotent: boolean,
): boolean {
  if (!policy.retryable) return false;
  if (toolIsIdempotent) return true;
  if (policy.category === "rate_limit") return true;
  if (policy.category === "transient") {
    return NOT_PROCESSED_PATTERN.test(policy.detail ?? "");
  }
  // timeout / unknown: the request may have been processed — never replay.
  return false;
}

/** Guidance emitted when the gate blocks a retry the policy would otherwise allow. */
export const NON_IDEMPOTENT_GUIDANCE =
  "The tool call failed with an ambiguous error and was NOT retried automatically because the tool may have side effects. Verify whether the operation took effect before invoking it again.";
