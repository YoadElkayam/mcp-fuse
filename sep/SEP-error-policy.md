# SEP-XXXX: Structured Error Policy for MCP Failures

> **Working draft, pre-submission.** Not yet filed in the specification repository,
> no sponsor yet. Section owners are listed in [README.md](README.md); `TODO(owner)`
> marks text that owner still needs to write. Everything here is open to revision.

## 1. Preamble

- **Title:** Structured Error Policy for MCP Failures
- **Authors:** Yoad Elkayam (@YoadElkayam), aurumflux20 (@aurumflux20),
  johnyzaguirre-glean (@johnyzaguirre-glean). devmaha (@devmaha) opened the
  originating discussion and is invited as co-author.
- **Status:** pre-draft (no sponsor)
- **Type:** Standards Track
- **Created:** 2026-08-27
- **PR:** not yet opened
- **AI assistance disclosure:** parts of this document and of the reference
  implementation were drafted with AI assistance (Claude Code) under the direction of
  the authors, who understand and stand behind all of it. Per the MCP AI contribution
  policy this line will be kept current in the submitted PR.

## 2. Abstract

MCP failures surface at three layers (transport, JSON-RPC error, tool result with
`isError`) and all three render as free text for the model. This proposal adds an
optional, machine-readable **error policy** payload, attachable at each layer,
that tells a client *what kind* of failure occurred, *whether and when* a retry may
succeed, *whether the effect is safe to repeat*, and *how to reconcile* an ambiguous
outcome. It separates directives for machines from a short guidance string for the
model, and gates automatic replay on the tool's declared effect class. Clients that
understand only `category` and `retryable` still behave correctly.

## 3. Motivation

### 3.1 The gap

There is no standard way for a server to say "this failure is retryable, wait N
seconds" or "this call may have executed; check before retrying." `error.data` is
application-defined and `_meta` has no agreed shape. So the retry decision falls to
the language model, which reads the raw error, re-enters it into context, and
retries on a sampling outcome rather than a policy.

### 3.2 Evidence of fragmentation

TODO(devmaha, from #3188): three independent servers shipping incompatible
retry-after conventions (Docdex `-32029` with `retry_after_ms`, slack-mcp
`retry_after`, mcp-time-server-node `-32000` with `retryAfter` in seconds), and the
client-side symptoms in opencode, vercel/ai, and awslabs/mcp.

### 3.3 Evidence that inference cannot replace declaration

TODO(aurumflux20): fencescan scan of 671 published servers (27,153 declared tools):
32% of write-capable servers show no visible idempotency guard; annotations that
exist are sometimes not consulted at runtime. agent-money-test: careful static
inference of retry safety still produced roughly one false positive in three when
hand-verified. Link datasets and the false-positive writeup.

### 3.4 Cost to the model

Measured with the mcp-fuse reference implementation on deterministic failure
scenarios: unprotected agents re-read 200 to 250 token error payloads per retry
turn with the full conversation replayed each time; behind a policy-aware layer the
model receives one message of about 20 tokens. Benchmarks and method are in the
mcp-fuse repository (`examples/flaky-server`).

### 3.5 Operator cost

TODO(johnyzaguirre-glean): the support-ticket case for a correlation id; why
timestamp matching fails on busy multi-tenant servers.

### 3.6 Prior art

`google.rpc.RetryInfo` and `ErrorInfo`, gRPC retry policy, Envoy retry semantics,
Cloudflare's header-plus-body retry timing. SEP-1686 (Tasks) explicitly deferred a
general idempotency mechanism to a dedicated proposal.

## 4. Specification

### 4.1 Payload

```jsonc
{
  "version": "1",
  "category": "rate_limit",
  "retryable": true,
  "retry": {
    "afterMs": 12000,            // earliest retry, "not before" semantics
    "strategy": "fixed",         // none | fixed | exponential
    "maxAttempts": 3
  },
  "circuit": { "state": "open", "reopenAfterMs": 30000 },
  "reconcile": { "tool": "get_invoice", "arguments": { "id": "inv_123" } },
  "agentGuidance": "This tool is rate limited. The system retries automatically; do not re-invoke it yourself.",
  "detail": "upstream returned 429, retry-after: 12",
  "correlationId": "req_8f3a"
}
```

Field semantics:

- `version` (required): consumers MUST ignore payloads with an unknown major version.
- `category` (required): closed enum. TODO(johnyzaguirre-glean): final vocabulary
  and the code-to-class mapping (capability / reliability / governance), including
  the governance case (policy refused the action; escalate, do not retry, do not
  re-auth).
- `retryable`: whether the identical request can ever succeed. Defaults per category.
- `retry.afterMs`: earliest time at which a retry may succeed. This is a "not
  before" bound. Clients MUST NOT retry earlier. Clients whose own deadline falls
  before it SHOULD fail fast and remember the bound rather than block.
- `circuit`: advisory breaker state for this tool or server.
- `reconcile`: a bare pointer to the read that answers "did this land?" for an
  ambiguous outcome. It says only "this call is in the ambiguous state, run this."
  Which read applies is declared statically on the tool, and how to interpret the
  answer (the four-valued verdict space, and why "could not determine" is terminal
  for automatic handling) is specified in 4.3.
- `agentGuidance`: the ONLY text intended for the model. At most 500 characters,
  imperative, never a stack trace.
- `detail`: diagnostics for logs and humans. Clients SHOULD NOT forward it to the
  model.
- `correlationId`: TODO(johnyzaguirre-glean): server-generated; servers SHOULD emit
  it, intermediaries MUST pass it through unchanged.

### 4.2 Carriers

| Failure surface | Carrier |
|-----------------|---------|
| JSON-RPC error response | `error.data["io.modelcontextprotocol/error-policy"]` |
| Tool result with `isError: true` | `result._meta["io.modelcontextprotocol/error-policy"]` |
| HTTP transport error (opaque body) | `MCP-Error-Policy` response header, base64url JSON |

`_meta` preservation: multiple SDKs have been observed dropping `_meta` in transit
(raised in SEP-3182 review). Authors' position: a normative preservation requirement
(intermediaries and SDKs MUST pass unknown `_meta` keys through unchanged) rather
than a dedicated field, which would only move the problem. Flagged for the sponsor:
this requirement lands on SDK maintainers, not just on consumers of this SEP, so it
needs their visibility early. Until it is settled, the `error.data` carrier for
JSON-RPC errors is the reliable path.

### 4.3 Effect declaration and the replay gate

TODO(aurumflux20): tri-state effect class on the tool declaration replacing the
boolean reading of `idempotentHint`: safe to replay / unsafe but reversible /
unsafe and irreversible. Plus the static reconciliation pointer and its verdict
space: a reconciliation read yields exactly one of {effect found once, effect
authoritatively absent, effect found more than once, could not determine}, and
"could not determine" (the read itself failed or timed out) is terminal for
automatic handling: it MUST NOT be collapsed into "absent".

Normative behavior (all authors agree on this core):

- A client MUST NOT automatically replay a `tools/call` whose failure is ambiguous
  (timeout, mid-stream reset, opaque 5xx) against a tool that is not declared safe to
  replay. It SHOULD surface `agentGuidance` and, if a reconciliation pointer exists,
  run it before any retry.
- A client MAY replay failures that guarantee the request was never processed
  (connection refused, reset before any response bytes, HTTP 429, HTTP 503) subject
  to `retry.afterMs`.
- Tools declared read-only or idempotent MAY be replayed per the retry directive.

### 4.4 Minimal-consumer rule

A consumer that understands only `category` and `retryable` MUST still behave
correctly. All other fields refine behavior; none change its direction.

## 5. Rationale

- Directives and model-facing text are separated because the error text itself is
  what burns context; the payload lets the model be told once, briefly.
- "Not before" timing instead of "sleep this long": hosts have their own deadlines,
  and a middlebox that sleeps into a host timeout turns one failure into two.
- Replay gating on declared effect class rather than on error class alone: static
  inference of retry safety is unreliable (3.3), so the tool must declare it, and the
  client must consult it.
- Category enum kept small and closed so clients switch on it; granular codes stay
  server-defined for operators.

## 6. Backward Compatibility

Fully additive. All fields are optional, carried in existing extension points
(`error.data`, `_meta`, a new response header). Servers that emit nothing behave
exactly as today. Clients that ignore the payload behave exactly as today. The
only normative constraint on existing behavior is the replay gate in 4.3, which
restricts automatic retries clients were never guaranteed to be safe making.

## 7. Reference Implementation

- **mcp-fuse** (MIT, npm `mcp-fuse`, `mcp-fuse-core`): transparent stdio proxy that
  synthesizes the payload for servers that do not emit it (classifier), applies the
  retry directive with a deadline-aware budget, converts out-of-budget `afterMs` into
  circuit cooldown, enforces the replay gate using `readOnlyHint` and
  `idempotentHint`, and attaches the payload under `_meta`. JSON Schema and
  conformance examples in its `spec/` directory. Integration tests cover absorbed
  retries, gate enforcement (a non-idempotent tool executes exactly once), circuit
  opening, and payload attachment.
- **fencescan** (Apache-2.0): declaration-side scanner and the scan dataset behind
  section 3.3.
- TODO(all): a conformance test as required for Standards Track SEPs.

## 8. Security Implications

- `detail` may contain sensitive upstream error text; it is for operator logs and
  must not be forwarded to the model or to untrusted clients by default.
- `reconcile` names a read the client may execute automatically; it MUST be
  restricted to tools declared read-only, or a malicious server could use it to
  trigger side effects.
- `agentGuidance` is model-facing text supplied by the server and is therefore a
  prompt-injection surface, same as tool descriptions today. The 500 character cap
  and the imperative-only convention limit but do not remove this; hosts SHOULD apply
  the same trust treatment they apply to tool descriptions.
- Intermediaries that add or rewrite the payload (proxies) change what the model
  sees; they should log every suppressed raw error so nothing is unrecoverable.
