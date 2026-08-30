import type { ErrorPolicy } from "./types.js";

/**
 * The idempotency gate (spec/README.md "Idempotency gate", DESIGN §3.3).
 *
 * For a tool not declared safe to replay, the only proof that the request was
 * not processed is STRUCTURAL: the request was never delivered (the transport
 * was not connected when we tried to send). Nothing in the text of a response
 * can prove non-execution: a 503 or a 429 can be returned after the effect
 * landed, and a body that says "connection reset" describes the server's own
 * upstream, not whether its side effect happened. The SEP conformance battery
 * (sep/conformance) caught two earlier text-based versions of this rule
 * replaying a side-effecting tool; this version is the fix.
 */
export interface GateContext {
  /** false only when the caller KNOWS the request never left (pre-send failure). */
  requestDelivered?: boolean;
}

/**
 * Whether a failed tools/call may be silently replayed, given the tool's
 * declared idempotency (readOnlyHint/idempotentHint from tools/list, or an
 * explicit operator override) and what is known about delivery.
 */
export function silentRetryAllowed(
  policy: ErrorPolicy,
  toolIsIdempotent: boolean,
  context: GateContext = {},
): boolean {
  if (!policy.retryable) return false;
  if (toolIsIdempotent) return true;
  // Side-effecting tool: replay only if the request provably never went out.
  return context.requestDelivered === false;
}

/** Guidance emitted when the gate blocks a retry the policy would otherwise allow. */
export const NON_IDEMPOTENT_GUIDANCE =
  "The tool call failed with an ambiguous error and was NOT retried automatically because the tool may have side effects. Verify whether the operation took effect before invoking it again.";
