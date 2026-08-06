# flaky-user-service

The Phase 1 benchmarking rig (docs/DESIGN.md §6.1): a deterministic, deliberately
unreliable stdio MCP server, plus a naive-agent benchmark that measures exactly what
an unprotected retry loop costs.

## Tools

| Tool | Annotations | Purpose |
|------|-------------|---------|
| `get_user_data` | `readOnlyHint`, `idempotentHint` | The flaky tool — behavior driven by the active scenario |
| `send_welcome_email` | non-idempotent | Counts every execution; makes double-sends *visible*, for idempotency-gate demos |

## Scenarios

All deterministic — pure functions of (call index, elapsed time). No randomness.

| Scenario | Script |
|----------|--------|
| `stable` | Always succeeds (control) |
| `rate-limit-storm` | Three 429s with `Retry-After: 12`, then recovery |
| `hard-down` | ECONNREFUSED for 30s (`FLAKY_DOWN_MS` to override), then recovery |
| `flapping` | Odd calls 503 (with fat stack trace), even calls succeed |
| `slow-degrade` | 2s → 4s → 6s latency ramp, then 10s-delay 504s |

## Run the server

```bash
pnpm build
node dist/server.js rate-limit-storm       # or FLAKY_SCENARIO=hard-down node dist/server.js
```

Env: `FLAKY_TELEMETRY=/path/to/file.jsonl` appends a JSONL record per tool call
(also logged to stderr).

## Run the benchmark

Simulates the pathological naive-agent loop (retry immediately until success or max
attempts) against a real SDK client connection, counts tokens over the exact
agent-visible bytes, and prints the with/without-fuse comparison — the "with" side
uses the actual `@mcp-fuse/core` classifier to generate the one guidance message:

```bash
node dist/bench.js --scenario rate-limit-storm
node dist/bench.js --scenario hard-down --max-attempts 8 --out results.jsonl
node dist/bench.js --scenario flapping --wrapped     # same scenario through the real proxy
```

Measured example (flapping): unprotected, the agent sees a 246-token 503 dump and
retries; wrapped, the proxy absorbs the failure below the protocol and the agent
sees **one successful call — zero error tokens**. For rate-limit-storm, the proxy
honors `Retry-After: 12` by failing fast with a ~21-token guidance message and
converting the wait into circuit cooldown (~0ms repeat calls) instead of hanging
the transport.

Methodology notes (per DESIGN §6.1): run N times and report the median when an LLM
is in the loop; this scripted bench is fully deterministic so single runs are exact.
Token counts use gpt-tokenizer (BPE) — an approximation of Claude tokenization,
labeled as such wherever quoted.

## Use with a real agent (Claude Code)

```jsonc
{
  "mcpServers": {
    "user-service": {
      "command": "node",
      "args": ["/abs/path/to/examples/flaky-server/dist/server.js", "rate-limit-storm"]
    }
  }
}
```

Then ask the agent to "fetch user 42's profile" and watch the retry loop. Once the
proxy (M2) lands, the before/after is the same config with
`"command": "npx", "args": ["mcp-fuse", "wrap", "--", "node", ...]`.
