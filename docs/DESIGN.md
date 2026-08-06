# mcp-fuse — Design Plan

**Status:** Draft v0.1 · August 2026
**Spec name:** MCP Error Policy (MEP), extension version `1`

---

## 1. Problem statement

MCP has three distinct layers where failures surface, and **all three are ultimately
rendered as text for the LLM**:

| Layer | Example | What the agent sees today |
|-------|---------|---------------------------|
| Transport | HTTP 429/500/503 on Streamable HTTP; stdio child crash | Connection error text, or nothing (hang) |
| Protocol (JSON-RPC) | `error: { code: -32603, message: "Internal error" }` | Opaque error string |
| Tool execution | `CallToolResult` with `isError: true` + free-text content | Raw stack trace / provider error dump |

None of these carry machine-readable semantics: *is this retryable? when? how many
times? should I stop calling this server entirely?* So the retry decision falls to the
model, which:

- **burns tokens** — each futile retry is a full tool-call round trip plus the error
  payload re-entering context;
- **corrupts context** — stack traces and repeated failures crowd out task-relevant
  content and prime the model toward failure-loop behavior;
- **behaves unpredictably** — whether the agent retries 0 or 15 times is a sampling
  outcome, not a policy.

Every serious agent team ends up hand-rolling a retry/backoff harness around MCP.
That logic is identical everywhere and belongs in the protocol layer.

## 2. Goals

1. **Define a structured Error Policy schema** that any MCP server, proxy, or client
   can emit/consume: error category, retry directives, circuit-breaker signals, and a
   compact agent-facing guidance string.
2. **Ship a zero-config drop-in proxy** that delivers the benefit *today*, with zero
   changes to existing servers or clients: wrap the server, error loops stop.
3. **Prove ROI measurably**: the proxy emits metrics (retries absorbed, estimated
   tokens saved) that make the value visible — the grassroots-adoption engine.
4. **Graduate the schema into the official MCP spec** via the SEP (Spec Enhancement
   Proposal) process, using proxy adoption as evidence.

### Non-goals

- Not an agent framework, planner, or orchestrator. mcp-fuse never *reasons*; it only
  executes deterministic policy.
- Not a general API gateway. Scope is MCP traffic only.
- No semantic error *recovery* (e.g., rewriting tool arguments). If deterministic
  policy can't fix it, the agent gets one clean message and decides.
- v1 does not try to fix server *hangs* beyond timeouts (no speculative hedging).

## 3. The standard: MCP Error Policy (MEP)

### 3.1 Schema (normative draft in `spec/error-policy.schema.json`)

```jsonc
{
  "version": "1",
  "category": "rate_limit",        // transient | rate_limit | timeout | auth |
                                   // permission | invalid_input | not_found |
                                   // resource_exhausted | permanent | unknown
  "retryable": true,
  "retry": {
    "strategy": "exponential",     // none | fixed | exponential
    "afterMs": 12000,              // authoritative "not before" (e.g. Retry-After)
    "initialDelayMs": 1000,
    "maxDelayMs": 60000,
    "maxAttempts": 3,
    "jitter": true
  },
  "circuit": {
    "state": "open",               // advisory breaker state for this server/tool
    "reopenAfterMs": 30000
  },
  "agentGuidance": "The search service is rate limited. The system will retry automatically; do not re-invoke this tool.",
  "detail": "upstream returned 429 (x-ratelimit-remaining: 0)",
  "correlationId": "req_8f3a"
}
```

Design rules:

- **Directives are for machines; `agentGuidance` is for the model.** Guidance is
  capped (≤500 chars), imperative, and never contains stack traces.
- **`category` is the contract; everything else is a hint.** A consumer that only
  understands `category` + `retryable` still behaves correctly.
- **Versioned from day one** (`version: "1"`), additive evolution only within a major.

### 3.2 Transport mapping — where the payload lives

MEP must attach to all three failure layers without breaking non-MEP consumers:

| Layer | Carrier |
|-------|---------|
| JSON-RPC error | `error.data["dev.mcp-fuse/error-policy"]` |
| Tool result (`isError: true`) | `result._meta["dev.mcp-fuse/error-policy"]` (MCP reserves `_meta` for extensions) |
| HTTP transport | `MCP-Error-Policy: <base64url(json)>` response header, so policy survives even when the body is an opaque 5xx |

On standardization the key migrates to `io.modelcontextprotocol/error-policy`; the
proxy will accept both indefinitely.

### 3.3 Interaction with tool annotations (idempotency)

Silent replay of `tools/call` is only safe when re-execution cannot cause damage.
MCP already carries the needed signal: `annotations.readOnlyHint` and
`annotations.idempotentHint` on tool definitions. MEP consumers (including the
proxy) MUST gate retry behavior on them:

| Tool annotation | Silent retry policy |
|-----------------|---------------------|
| `readOnlyHint` or `idempotentHint` true | Full silent retry per `retry` directive |
| Neither (or absent) | Retry ONLY failures that guarantee the request was never processed: connection refused, reset-before-response, HTTP 429, HTTP 503. Ambiguous failures (timeouts, mid-stream resets, opaque 5xx) fail fast with guidance — never replayed. |

This is a spec-level rule, not a proxy implementation detail: double-executing a
state-mutating tool (`send_email`, `create_order`) is the failure mode that keeps
production teams away from autonomous agents, and it must never be introduced by a
resilience layer. Side effect by design: servers that annotate their tools correctly
get better resilience for free — the standard incentivizes accurate annotations.

### 3.4 Producer/consumer roles

- **Policy-aware server**: attaches MEP at the source (best fidelity — it knows its
  own rate limits). SDK helper: `throw new McpError(...).withPolicy({...})`.
- **The proxy** (this repo): *synthesizes* MEP for servers that don't emit it, via the
  classifier (§4.3) — this is what makes adoption zero-cost.
- **Policy-aware client/host**: reads MEP and handles retries natively (endgame:
  Claude Code, other hosts do this themselves).

## 4. The delivery mechanism: the proxy

### 4.1 Deployment modes

1. **stdio wrapper** (v0 priority — most local MCP servers are stdio):
   `mcp-fuse wrap -- <server command>`. The proxy becomes the server process; it
   spawns the real server as a child and man-in-the-middles the JSON-RPC stream.
   Adoption = editing one line of `mcpServers` config.

   **Implementation strategy: SDK pair, not raw streams.** The proxy is built as an
   `@modelcontextprotocol/sdk` **Server** (facing the host on stdin/stdout) paired
   with an SDK **Client** (facing the child). The SDK owns JSON-RPC framing,
   chunking, backpressure, the `initialize` handshake, and reconnection — so
   child-crash recovery becomes "reconnect the client, replay the call" instead of
   hand-rolled session-state resurrection. The cost is that the proxy terminates the
   protocol rather than piping it, so it needs a **generic passthrough fallback**:
   any method/notification the proxy doesn't explicitly model (sampling, roots,
   elicitation, future extensions) is forwarded verbatim in both directions.
   Raw-stream interception is the fallback plan only if testing shows the SDK pair
   breaks transparency for server→client flows.
2. **HTTP reverse proxy**: `mcp-fuse proxy --target <url> --port <p>` for Streamable
   HTTP servers. Also handles transport-level errors (connect refused, 5xx, timeouts).
3. **Library middleware**: `withFuse(transport, policy?)` wrapping a TS-SDK transport,
   for teams embedding clients. (Java equivalent later, see §7.)

All three share `mcp-fuse-core`; the proxies are thin shells.

### 4.2 Request pipeline

```
client request ─▶ breaker check ─▶ forward to server ─▶ response
                     │                                    │
              open? fail fast                      error? classify
              (synthetic MEP error,                       │
               zero upstream calls)              retryable & budget left?
                                                    │yes         │no
                                              backoff+retry   emit ONE
                                              (silent)        semantic error
                                                              w/ MEP payload
```

Key behaviors:

- **Silent absorption**: retries happen entirely below the protocol surface. The
  client sees latency, not failure — bounded by the absorption budget below.
- **One semantic message, max**: when policy is exhausted, the agent receives a single
  `isError` result whose text is the `agentGuidance` string — never the raw upstream
  error. Raw detail goes to the proxy log, not the context window.
- **Circuit breaker per (server, tool)**: N consecutive terminal failures open the
  circuit; while open, calls fail fast with "do not retry, circuit open for Xs"
  guidance — this is what kills runaway loops even when the *model* keeps trying,
  because each futile attempt costs ~0 tokens of new error text and 0 upstream load.
- **`tools/list` degradation (later)**: while a circuit is open, optionally annotate
  or hide the affected tools so the model doesn't plan around dead capabilities.

#### The absorption budget: small, deadline-aware, keepalive-extended

Real hosts sever or time out tool calls aggressively; a proxy that blocks 30s waiting
on retries just trades one failure mode (error loop) for another (transport
collapse). Rules:

1. **Hard default budget: 5s** of total silent absorption per call (configurable;
   must stay below the measured host timeout — see the compatibility table task in
   Phase 1).
2. **Deadline-aware, not deadline-truncated**: before sleeping a backoff delay,
   check `delay + expected_attempt_time ≤ remaining_budget`. If it doesn't fit,
   fail fast *immediately* — never burn budget waiting for a retry that can't
   complete, and never let the host's timeout fire first.
3. **Long waits become circuit state, not blocking time**: when `Retry-After`
   (or computed backoff) exceeds the budget, flush guidance instantly AND record the
   earliest-retry timestamp on the breaker. Repeat calls inside the cooldown window
   fail fast in ~0ms with "still cooling down, retry available in Xs" — the agent
   gets an instant cheap answer instead of a hung transport.
4. **Progress-notification keepalive**: the MCP spec says implementations SHOULD
   reset request timeouts when progress notifications arrive. When the client's
   request carries a `progressToken`, the proxy emits synthetic progress
   ("retrying upstream, attempt 2/3") during absorption, legally extending the
   window with the client's cooperation. No token → strict 5s budget; token
   present → relaxed budget (default 20s, still capped).

#### The idempotency gate

Per spec §3.3, retry policy is gated on tool annotations synced from `tools/list`
(the proxy already observes and caches these):

- `readOnlyHint`/`idempotentHint` → full silent retry.
- Un-annotated or non-idempotent tools → silent retry only for
  guaranteed-not-processed failures (ECONNREFUSED, reset-before-response, 429, 503);
  ambiguous timeouts and mid-stream failures fail fast with guidance. A resilience
  layer must never be the thing that double-sends an email.

### 4.3 Classifier (the zero-config heart)

Synthesizes MEP from raw failures, in priority order:

1. Explicit MEP already present (pass through, trust the source).
2. HTTP status: 429 → `rate_limit` (honor `Retry-After`); 408/502/503/504 →
   `transient`; 401/403 → `auth`/`permission`; 400/404/422 → permanent-ish.
3. JSON-RPC codes: -32602 → `invalid_input`; -32601 → `not_found`; -32603 → `unknown`
   (retry once, then treat as permanent).
4. Message heuristics (conservative, tested corpus): `rate limit|too many requests`,
   `timeout|timed out|ETIMEDOUT`, `ECONNREFUSED|ECONNRESET|EPIPE|socket hang up`.
5. Fallback: `unknown`, retryable once.

Heuristics are data (a shipped, overridable ruleset), not code — community PRs to the
corpus are the cheapest contribution path.

### 4.4 Configuration

Zero-config default must be safe and good. Optional `fuse.config.json` for overrides:

```jsonc
{
  "defaults": { "maxAttempts": 3, "maxAbsorptionMs": 5000, "maxAbsorptionWithProgressMs": 20000 },
  "circuit": { "failureThreshold": 5, "reopenAfterMs": 30000 },
  "tools": {
    "expensive_tool": { "maxAttempts": 1 },
    "legacy_search": { "assumeIdempotent": true }
  },
  "rules": [ { "match": "quota exceeded", "category": "resource_exhausted" } ]
}
```

### 4.5 Observability — the ROI story

The proxy keeps counters and prints a session summary (and optional JSON lines log):

```
mcp-fuse: absorbed 14 transient failures, opened 1 circuit,
prevented ~11 agent-visible errors (~38k tokens of error payload kept out of context)
```

Token estimate = bytes of suppressed error text / 4, clearly labeled an estimate.
This line is the marketing. It goes in the README, the demo GIF, and every issue
report.

## 5. Package layout

| Package | Contents |
|---------|----------|
| `mcp-fuse-core` | MEP types, JSON Schema, classifier, retry engine, circuit breaker, metrics. Zero runtime deps. |
| `mcp-fuse` | CLI (`wrap`, `proxy`), stdio proxy, HTTP proxy. Depends on core (+ `@modelcontextprotocol/sdk` where useful). |
| `spec/` | Prose spec + JSON Schema + conformance examples (language-neutral; the Java port implements from here). |

## 6. Roadmap

| Milestone | Deliverable | Exit criterion |
|-----------|-------------|----------------|
| **M0 — Spec draft** | `spec/` v1alpha: schema, transport mapping, category semantics | Schema validates all examples; 2 external reviewers read it |
| **M1 — Core engine** | classifier + retry + breaker in `mcp-fuse-core`, fully unit-tested | Classifier corpus ≥ 50 real-world error samples, all categorized correctly |
| **M2 — stdio wrapper MVP** | `mcp-fuse wrap` works with real servers (filesystem, fetch, the flaky demo server) | Demo: agent + flaky server, before/after token counts across scripted scenarios, recorded |
| **M3 — HTTP proxy + metrics** | `mcp-fuse proxy`, session summary, JSONL logs | Fronting a real Streamable HTTP server in CI |
| **M4 — Launch** | npm publish, README with demo GIF + ROI numbers, blog post, submit to MCP community | First external issue filed 🎉 |
| **M5 — Standardization** | SEP draft for `io.modelcontextprotocol/error-policy`, host-side adoption conversations | SEP submitted with adoption data |
| **M6 — Java middleware** | Port of core + servlet/Spring filter, from the language-neutral spec + conformance suite | Passes the same conformance examples |

### 6.1 Near-term execution plan (Phases 1–3 → M1–M3)

**Phase 1 — The flaky server demo (baseline & telemetry).**
A deterministic Node.js MCP server exposing `get_user_data`, driven by **named,
scripted failure scenarios** rather than a random drop rate:

- `rate-limit-storm` — three 429s with `Retry-After`, then success
- `hard-down` — 30s window of ECONNREFUSED
- `flapping` — alternating success/5xx
- `slow-degrade` — latency ramp into timeouts

Scenarios are seeded and replayable, so the identical sequence runs bare vs. wrapped
— and each scenario doubles as a CI regression test for the proxy. Measurement
methodology: N runs per scenario, report the **median** (agents are stochastic);
token counts computed with a real tokenizer over the exact bytes that entered
context, not bytes/4. Also in this phase: **empirically measure host timeout
behavior** (Claude Code, Cursor, Windsurf — with and without progress notifications)
and publish the compatibility table; it calibrates the absorption budget and is
README material. Deliverable: the before/after telemetry that is the primary ROI
proof-point for the README and for standard adoption.

**Phase 2 — stdio man-in-the-middle (core plumbing).**
The SDK Server/Client pair per §4.1: SDK owns framing, backpressure, handshake, and
child reconnection; we own the interception pipeline (§4.2) and the generic
passthrough fallback for unmapped methods and server→client flows. `tools/call`
responses route through `mcp-fuse-core`; on exhausted policy the response is
reconstructed with `agentGuidance` text and the MEP payload under `_meta` /
`error.data`. Includes the `tools/list` annotation sync that feeds the idempotency
gate, and child-crash recovery (reconnect, replay only per the gate).

**Phase 3 — the CLI wrapper (zero-config DX).**
`mcp-fuse wrap -- npx @modelcontextprotocol/server-github` — sub-process I/O
management, stderr passthrough, signal forwarding and exit-code propagation, metrics
summary on shutdown. Zero code modification for the target server; adoption is one
edited line of `mcpServers` config.

## 7. Java strategy

Don't port early. The spec + conformance examples (`spec/examples/`) are the
portable artifact; the Java implementation (`middleware-java/`) starts after M4, once
the schema has survived contact with reality. Target: a servlet filter / Spring Boot
starter for HTTP MCP servers, plus a stdio wrapper jar.

## 8. Risks & open questions

- **Host timeout variance**: the 5s budget + progress keepalive (§4.2) is designed
  around measured host behavior, but hosts change; the Phase 1 compatibility table
  must be re-validated per host release, and keepalive only helps when the client
  sends a `progressToken` and honors the SHOULD-reset spec language.
- **SDK-pair transparency**: terminating the protocol (rather than piping bytes)
  risks dropping methods/capabilities the proxy doesn't model; the generic
  passthrough fallback must be tested against sampling, roots, and elicitation
  flows, with raw-stream interception as the escape hatch.
- **Un-annotated tools get degraded resilience**: the idempotency gate (§3.3) means
  most real-world tools (few authors set `idempotentHint` today) only get the
  guaranteed-not-processed retry class. Acceptable — correctness over convenience —
  and it pressures the ecosystem toward accurate annotations; `assumeIdempotent`
  config exists for users who know better.
- **Streaming/SSE pass-through**: proxying Streamable HTTP requires careful SSE
  handling; MVP may buffer non-streamed responses only.
- **Session state (HTTP mode)**: Streamable HTTP sessions (`Mcp-Session-Id`) must
  pass through transparently; breaker keys must incorporate session where relevant.
- **Over-suppression**: hiding errors too aggressively can mask real bugs. Mitigation:
  everything suppressed is logged verbatim; `--verbose` disables absorption.
- **`_meta` key namespace**: `dev.mcp-fuse/*` until/unless SEP lands; dual-key
  reading forever.

## 9. Prior art / positioning

- Envoy/Istio retry policies, AWS SDK retry modes, gRPC `RetryPolicy` +
  `google.rpc.RetryInfo` — MEP deliberately mirrors `google.rpc` error-detail thinking,
  adapted to "one consumer is an LLM".
- Various agent frameworks (LangChain, etc.) implement bespoke retries *inside the
  harness* — exactly the duplication MEP removes. The pitch: resilience belongs below
  the reasoning layer, in the protocol.
