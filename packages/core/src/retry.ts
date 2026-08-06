import type { RetryDirective } from "./types.js";

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
}

/** Decide whether attempt number `attempt` (1-based count of attempts already
 * made) should be retried, and after what delay. Pure function. */
export function nextRetry(
  directive: RetryDirective | undefined,
  attempt: number,
  random: () => number = Math.random,
): RetryDecision {
  const maxAttempts = directive?.maxAttempts ?? 0;
  const strategy = directive?.strategy ?? "none";
  if (strategy === "none" || attempt >= maxAttempts) {
    return { retry: false, delayMs: 0 };
  }

  // An authoritative afterMs (e.g. Retry-After) overrides computed backoff
  // for the next attempt.
  if (directive?.afterMs !== undefined) {
    return { retry: true, delayMs: directive.afterMs };
  }

  const initial = directive?.initialDelayMs ?? 1000;
  const max = directive?.maxDelayMs ?? 60_000;
  let delay =
    strategy === "exponential" ? initial * 2 ** (attempt - 1) : initial;
  delay = Math.min(delay, max);
  if (directive?.jitter) {
    delay = delay * (0.5 + random() / 2); // full jitter, 50–100% of computed delay
  }
  return { retry: true, delayMs: Math.round(delay) };
}
