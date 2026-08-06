# MCP Error Policy (MEP) — Specification Draft

**Version:** 1 (alpha) · **Status:** Draft

MEP is a structured extension to MCP error surfaces that separates *machine
directives* (retry timing, circuit state) from *model guidance* (one short imperative
sentence), so deterministic failure handling never has to pass through an LLM.

## Payload

The normative schema is [`error-policy.schema.json`](error-policy.schema.json).
Minimal conforming payload:

```json
{ "version": "1", "category": "transient", "retryable": true }
```

Full payload: see [`examples/`](examples/).

## Categories

| Category | Meaning | Default retryability |
|----------|---------|----------------------|
| `transient` | Temporary infrastructure failure (5xx, connection reset) | yes |
| `rate_limit` | Quota/throttle; honor `retry.afterMs` | yes, after delay |
| `timeout` | Upstream deadline exceeded | yes, cautiously |
| `auth` | Missing/expired credentials | no (needs human/config fix) |
| `permission` | Authenticated but forbidden | no |
| `invalid_input` | Request malformed; retrying identical input is futile | no (agent may *change* input) |
| `not_found` | Resource/method does not exist | no |
| `resource_exhausted` | Hard quota (billing, storage) — not time-based | no |
| `permanent` | Known-unrecoverable server error | no |
| `unknown` | Unclassified | one retry, then permanent |

## Attachment points

1. **JSON-RPC error responses** — `error.data["dev.mcp-fuse/error-policy"]`
2. **Tool results with `isError: true`** — `result._meta["dev.mcp-fuse/error-policy"]`
3. **HTTP transport responses** — header `MCP-Error-Policy: <base64url-encoded JSON>`

Consumers MUST ignore the payload if `version` is unrecognized. Producers MUST NOT
put stack traces or payloads >500 chars in `agentGuidance`.

## Consumer requirements (normative sketch)

- A consumer understanding only `category` + `retryable` MUST still behave correctly;
  all other fields are refinements.
- If `retry.afterMs` is present, consumers MUST NOT retry before it elapses.
- If `circuit.state` is `open`, consumers SHOULD NOT issue new requests to the same
  server/tool until `circuit.reopenAfterMs` elapses.
- Text shown to a model SHOULD be `agentGuidance` alone, never `detail`.

## Idempotency gate (normative)

Automatic (agent-invisible) replay of `tools/call` MUST be gated on the tool's
declared annotations from `tools/list`:

- Tools with `annotations.readOnlyHint` or `annotations.idempotentHint` set to
  `true` MAY be silently retried per the `retry` directive.
- All other tools MUST only be silently retried on failures that guarantee the
  request was never processed (connection refused, connection reset before any
  response bytes, HTTP 429, HTTP 503). Ambiguous failures — timeouts, mid-stream
  resets, opaque 5xx — MUST NOT be replayed automatically; consumers fail fast and
  surface `agentGuidance` instead.

A resilience layer must never be the component that double-executes a
state-mutating tool.
