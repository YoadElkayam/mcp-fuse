/**
 * Deterministic failure scenarios (docs/DESIGN.md §6.1, Phase 1).
 *
 * Scenarios are pure functions of (callIndex, elapsedMs) — no randomness — so the
 * identical sequence runs bare vs. wrapped, and each scenario doubles as a CI
 * regression test for the proxy.
 *
 * Error payloads are deliberately verbose and realistic: this is the raw text an
 * unprotected agent re-reads on every retry turn, and the thing mcp-fuse keeps out
 * of the context window.
 */

export interface ScenarioOutcome {
  kind: "success" | "error";
  /** Artificial latency before responding. */
  delayMs: number;
  /** Raw error text an unprotected agent would see. Present iff kind === "error". */
  errorText?: string;
}

/** callIndex is 1-based per tool; elapsedMs is time since server start. */
export type Scenario = (callIndex: number, elapsedMs: number) => ScenarioOutcome;

export interface ScenarioOptions {
  /** hard-down: how long the service stays unreachable. Default 30s. */
  hardDownWindowMs?: number;
}

const ok = (delayMs = 50): ScenarioOutcome => ({ kind: "success", delayMs });
const err = (errorText: string, delayMs = 80): ScenarioOutcome => ({
  kind: "error",
  delayMs,
  errorText,
});

const requestId = (callIndex: number): string =>
  `req_${callIndex.toString(16).padStart(4, "0")}`;

export function rateLimit429(callIndex: number): string {
  return [
    "HTTP 429 Too Many Requests",
    "",
    JSON.stringify(
      {
        error: {
          type: "rate_limit_error",
          message:
            "Number of requests per minute exceeded for tier 'starter'. Limit: 60 requests/min, burst 10. Your request has been rejected. Please retry after the interval indicated in the Retry-After header. Repeated violations may result in temporary suspension of API access for this key.",
          retry_after_seconds: 12,
          documentation_url: "https://api.example.com/docs/rate-limits",
        },
      },
      null,
      2,
    ),
    "",
    "Response headers:",
    "  retry-after: 12",
    "  x-ratelimit-limit-requests: 60",
    "  x-ratelimit-remaining-requests: 0",
    "  x-ratelimit-reset-requests: 2026-08-06T00:00:12Z",
    `  x-request-id: ${requestId(callIndex)}`,
    "  cf-ray: 8f1c2a4b5d6e7f80-IAD",
  ].join("\n");
}

export function serviceUnavailable503(callIndex: number): string {
  return [
    "HTTP 503 Service Unavailable",
    "",
    "upstream connect error or disconnect/reset before headers. reset reason: connection failure",
    "",
    `UserServiceError: failed to fetch user profile (request ${requestId(callIndex)})`,
    "    at UserRepository.findById (/srv/user-service/dist/repository.js:214:19)",
    "    at async UserService.getProfile (/srv/user-service/dist/service.js:88:22)",
    "    at async ToolHandler.getUserData (/srv/user-service/dist/tools.js:41:16)",
    "    at async McpServer.handleCallTool (/srv/user-service/node_modules/@modelcontextprotocol/sdk/dist/server/mcp.js:512:24)",
    "    at async StdioServerTransport.processMessage (/srv/user-service/node_modules/@modelcontextprotocol/sdk/dist/server/stdio.js:97:11)",
    "  caused by: ConnectionPoolTimeoutError: no connection available in pool 'users-primary' after 5000ms (0/20 idle, 20/20 busy, 47 queued)",
    "    at Pool.acquire (/srv/user-service/node_modules/pg-pool/index.js:45:11)",
    "    at async PostgresDriver.query (/srv/user-service/dist/driver.js:130:9)",
    "",
    "The service is experiencing elevated error rates. Status page: https://status.example.com",
  ].join("\n");
}

export function connRefused(): string {
  return [
    "Error: connect ECONNREFUSED 10.0.0.17:8443",
    "    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1615:16) {",
    "  errno: -61,",
    "  code: 'ECONNREFUSED',",
    "  syscall: 'connect',",
    "  address: '10.0.0.17',",
    "  port: 8443",
    "}",
    "",
    "FetchError: request to https://users.internal.example.com/v2/profile failed, reason: connect ECONNREFUSED 10.0.0.17:8443",
    "    at ClientRequest.<anonymous> (/srv/user-service/node_modules/node-fetch/lib/index.js:1501:11)",
    "    at ClientRequest.emit (node:events:518:28)",
    "    at emitErrorEvent (node:_http_client:101:11)",
  ].join("\n");
}

export function gatewayTimeout504(callIndex: number): string {
  return [
    "HTTP 504 Gateway Timeout",
    "",
    `The upstream server did not respond within 10000ms (request ${requestId(callIndex)}).`,
    "envoy overloaded: upstream request timeout after 3 attempts (per_try_timeout: 3333ms)",
    "  upstream cluster: users-primary | endpoints healthy: 1/4 | pending requests: 312",
    "",
    "Response headers:",
    "  server: envoy",
    "  x-envoy-upstream-service-time: 10004",
    `  x-request-id: ${requestId(callIndex)}`,
    "  x-envoy-overloaded: true",
    "",
    "If this persists, check upstream health at https://status.example.com or contact the on-call SRE.",
  ].join("\n");
}

export const DEFAULT_HARD_DOWN_WINDOW_MS = 30_000;

export function makeScenarios(
  options: ScenarioOptions = {},
): Record<string, Scenario> {
  const hardDownWindowMs = options.hardDownWindowMs ?? DEFAULT_HARD_DOWN_WINDOW_MS;
  return {
    /** Control: always succeeds. The "healthy service" baseline. */
    stable: () => ok(),

    /** Three 429s (Retry-After: 12), then recovery. */
    "rate-limit-storm": (i) => (i <= 3 ? err(rateLimit429(i)) : ok()),

    /** Unreachable for the first `hardDownWindowMs`, then recovery. */
    "hard-down": (_i, elapsedMs) =>
      elapsedMs < hardDownWindowMs ? err(connRefused(), 40) : ok(),

    /** Alternating failure/success: odd calls 503, even calls succeed. */
    flapping: (i) => (i % 2 === 1 ? err(serviceUnavailable503(i)) : ok()),

    /** Latency ramp into timeouts: 2s, 4s, 6s, then 10s + 504. */
    "slow-degrade": (i) =>
      i <= 3
        ? ok(i * 2000)
        : { kind: "error", delayMs: 10_000, errorText: gatewayTimeout504(i) },
  };
}

export const SCENARIO_NAMES = Object.keys(makeScenarios());
