import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "./classifier.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { silentRetryAllowed } from "./idempotency.js";
import { nextRetry } from "./retry.js";
import type { ErrorPolicy } from "./types.js";

test("classify: HTTP 429 → rate_limit honoring Retry-After", () => {
  const policy = classify({ httpStatus: 429, retryAfterMs: 12_000 });
  assert.equal(policy.category, "rate_limit");
  assert.equal(policy.retryable, true);
  assert.equal(policy.retry?.afterMs, 12_000);
});

test("classify: 401 → auth, not retryable", () => {
  const policy = classify({ httpStatus: 401 });
  assert.equal(policy.category, "auth");
  assert.equal(policy.retryable, false);
  assert.equal(policy.retry, undefined);
});

test("classify: ECONNREFUSED message → transient", () => {
  const policy = classify({ message: "connect ECONNREFUSED 127.0.0.1:8085" });
  assert.equal(policy.category, "transient");
  assert.equal(policy.retryable, true);
});

test("classify: leading HTTP status line beats keywords buried in the trace", () => {
  const policy = classify({
    message:
      "HTTP 503 Service Unavailable\n\nupstream connect error\n  caused by: ConnectionPoolTimeoutError: no connection available after 5000ms",
  });
  assert.equal(policy.category, "transient");
});

test("classify: rate_limit gets rate-limit-specific guidance", () => {
  const policy = classify({ message: "HTTP 429 Too Many Requests\nretry-after: 12" });
  assert.equal(policy.category, "rate_limit");
  assert.match(policy.agentGuidance!, /rate limited/);
});

test("classify: JSON-RPC -32602 → invalid_input", () => {
  const policy = classify({ jsonrpcCode: -32602, message: "Invalid params" });
  assert.equal(policy.category, "invalid_input");
  assert.equal(policy.retryable, false);
});

test("classify: guidance never contains the raw message", () => {
  const policy = classify({ message: "Error: boom\n  at Object.<anonymous> (/srv/app.js:1:1)" });
  assert.ok(!policy.agentGuidance?.includes("at Object"));
  assert.ok((policy.agentGuidance?.length ?? 0) <= 500);
});

test("nextRetry: exponential backoff caps at maxDelayMs and stops at maxAttempts", () => {
  const directive = {
    strategy: "exponential" as const,
    initialDelayMs: 1000,
    maxDelayMs: 3000,
    maxAttempts: 3,
  };
  assert.deepEqual(nextRetry(directive, 1), { retry: true, delayMs: 1000 });
  assert.deepEqual(nextRetry(directive, 2), { retry: true, delayMs: 2000 });
  assert.deepEqual(nextRetry(directive, 3), { retry: false, delayMs: 0 });
});

test("nextRetry: afterMs overrides computed backoff", () => {
  const decision = nextRetry(
    { strategy: "fixed", afterMs: 12_000, maxAttempts: 3 },
    1,
  );
  assert.deepEqual(decision, { retry: true, delayMs: 12_000 });
});

test("classify: Retry-After quoted in error text becomes retry.afterMs", () => {
  const policy = classify({
    message: 'HTTP 429 Too Many Requests\n{"retry_after_seconds": 12}\nretry-after: 12',
  });
  assert.equal(policy.category, "rate_limit");
  assert.equal(policy.retry?.afterMs, 12_000);
});

test("idempotency gate: ambiguous failures never replay against non-idempotent tools", () => {
  const timeout: ErrorPolicy = { version: "1", category: "timeout", retryable: true };
  assert.equal(silentRetryAllowed(timeout, true), true);
  assert.equal(silentRetryAllowed(timeout, false), false);

  const rateLimit: ErrorPolicy = { version: "1", category: "rate_limit", retryable: true };
  assert.equal(silentRetryAllowed(rateLimit, false), true);

  const connRefused: ErrorPolicy = {
    version: "1",
    category: "transient",
    retryable: true,
    detail: "connect ECONNREFUSED 10.0.0.17:8443",
  };
  assert.equal(silentRetryAllowed(connRefused, false), true);

  const opaque500: ErrorPolicy = {
    version: "1",
    category: "transient",
    retryable: true,
    detail: "HTTP 500 Internal Server Error",
  };
  assert.equal(silentRetryAllowed(opaque500, false), false);

  const auth: ErrorPolicy = { version: "1", category: "auth", retryable: false };
  assert.equal(silentRetryAllowed(auth, true), false);
});

test("circuit breaker: forceCooldown opens for the given duration without a failure count", () => {
  let clock = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 5, reopenAfterMs: 30_000 }, () => clock);
  breaker.forceCooldown(12_000);
  assert.equal(breaker.state(), "open");
  assert.equal(breaker.reopenInMs(), 12_000);
  clock = 12_000;
  assert.equal(breaker.state(), "half_open");
  breaker.recordSuccess();
  assert.equal(breaker.state(), "closed");
});

test("circuit breaker: opens after threshold, half-opens after cooldown", () => {
  let clock = 0;
  const breaker = new CircuitBreaker(
    { failureThreshold: 2, reopenAfterMs: 1000 },
    () => clock,
  );
  assert.equal(breaker.state(), "closed");
  breaker.recordFailure();
  assert.equal(breaker.state(), "closed");
  breaker.recordFailure();
  assert.equal(breaker.state(), "open");
  assert.equal(breaker.allowRequest(), false);

  clock = 1000;
  assert.equal(breaker.state(), "half_open");
  assert.equal(breaker.allowRequest(), true); // single probe
  assert.equal(breaker.allowRequest(), false); // no concurrent probes

  breaker.recordSuccess();
  assert.equal(breaker.state(), "closed");
});
