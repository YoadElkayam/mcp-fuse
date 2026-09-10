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

Two independent measurements say the same thing: retry safety cannot be reliably
inferred, so it has to be declared.

**A static scan of the published ecosystem.** [fencescan][fs] read 755 MCP servers
from the npm registry; 671 scanned successfully (84 were unreachable or unpublishable),
covering 27,153 declared tools. Of the 671, **539 perform real writes, and 175 of those
— 32% — show no visible idempotency guard of any kind**: no idempotency key, no dedup
lookup, no conditional write. (Counted the stricter way — servers exposing an
effectful *tool* rather than any write — it is 150 of 470, the same 32%.) Narrowing to
the sharpest cut, 32 servers both write and carry retry logic with no guard the scanner
could see; among the 23 largest servers scanned (10,000+ downloads/month), 6 write with
no visible guard. Separately,
where an `idempotentHint` annotation *is* present, nothing in the protocol requires
the server to consult it at execution time, so its truth is not enforced by anything.

**A dynamic check that inference is not enough.** [agent-money-test][amt] infers
retry-safety from a server's own source — does a retry path wrap an effectful call
with no idempotency identity in scope. Hand-verified against real repositories, its
careful static inference still produced roughly one false positive in three: guards
that live in a service the repository calls rather than in the file being read, and
identity fields the scanner's patterns could not see. The tool's own history is the
argument — an early version accused a repository of having zero guards while it
shipped an entire `deriveIdempotencyKey` module, because a regular expression without
a word boundary could not match the name.

Inference (static or runtime) and observation both bottom out at the same limit: the
only party that reliably knows whether a tool is safe to replay is the tool. A spec
that lets it say so is strictly more reliable than any consumer guessing.

[fs]: https://github.com/aurumflux20/fencescan
[amt]: https://github.com/aurumflux20/agent-money-test

### 3.4 Cost to the model

Measured with the mcp-fuse reference implementation on deterministic failure
scenarios: unprotected agents re-read 200 to 250 token error payloads per retry
turn with the full conversation replayed each time; behind a policy-aware layer the
model receives one message of about 20 tokens. Benchmarks and method are in the
mcp-fuse repository (`examples/flaky-server`).

### 3.5 Operator cost

The third consumer of a failure is the operator on support duty (after
johnyzaguirre-glean, #2930). Without a correlation id, reconciling a user's "a tool
call failed sometime around 10:04" against server logs means matching timestamps,
which fails exactly when it matters most: on a busy multi-tenant server, ten
requests share that second. One optional string turns the search from a time window
into an exact grep. The model reads `agentGuidance` and the client switches on
`category`; the correlation id is the field those two consumers never touch, and
the reason it must be normative rather than conventional is that fields only
operators use are the first ones dropped.

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
- `category` (required): closed enum, final vocabulary (after
  johnyzaguirre-glean's #2930 and its thread): `transient`, `rate_limit`,
  `timeout`, `auth`, `permission`, `invalid_input`, `not_found`,
  `resource_exhausted`, `policy_blocked`, `permanent`, `unknown`. Categories are
  the wire values; the contract clients rely on is the **class** each maps to
  (grouping after HarperZ9):

  | Class | Categories | Client behavior |
  |-------|------------|-----------------|
  | reliability | transient, rate_limit, timeout, unknown | retry per the directive, subject to the replay gate (4.3) |
  | capability | auth, permission, invalid_input, not_found, resource_exhausted, permanent | stop; surface the required out-of-band action; retrying the identical call is pointless |
  | governance | policy_blocked | a policy layer refused a well-formed action: escalate for human approval and audit; do not retry, do not re-auth |

  `policy_blocked` is deliberately distinct from `permission`: permission is about
  the caller's identity, governance is about the action itself being disallowed,
  and the correct client responses differ, because re-authenticating cannot fix a
  policy refusal. Granular server-defined codes stay free-form in `detail` for
  operators; servers can add codes without breaking client logic.
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
- `correlationId`: a server-generated opaque identifier for this specific failed
  request (after johnyzaguirre-glean, #2930). Servers SHOULD generate one per
  request; intermediaries MUST pass it through unchanged; clients SHOULD include it
  when reporting a terminal failure to the user, so a person can paste it into a
  support ticket and an operator can grep server logs for the exact request. It
  exists for the operator, not for the model's reasoning. The strength is
  deliberate: a field only operators use is precisely the field that never gets
  adopted if it is merely suggested.

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

A tool declares its **effect class**, a three-state field that replaces the boolean
reading of `idempotentHint`:

- `safe-to-replay` — the call carries no external side effect, or the server
  deduplicates it internally; a client may replay it freely subject to `retry.afterMs`.
- `unsafe-reversible` — a replay may produce a second effect, but that effect can be
  undone (a charge that can be refunded, a record that can be deleted).
- `unsafe-irreversible` — a replay may produce a second effect that cannot be undone
  (a settled on-chain payment, an email sent).

The boolean `idempotentHint` cannot express this: a client acting on it treats a
refundable double-charge and an irreversible double-send identically, which forces it
to be either over-cautious about the first or under-informative about the second. The
effect class lets a client escalate its caution to match the cost.

A tool that is not `safe-to-replay` MAY also carry a **reconciliation pointer**: the
name of a read-only tool that answers "did this effect happen?" for a given call. When
an ambiguous failure occurs, a client runs the pointer before deciding, and the read
yields exactly one of four verdicts:

- **effect found once** — settle the call as done; do not replay.
- **effect authoritatively absent** — the effect provably did not happen; replay is
  now safe.
- **effect found more than once** — a prior replay already double-fired; this is a
  divergence to surface, not to retry.
- **could not determine** — the reconciliation read itself failed, timed out, or the
  provider cannot answer. **This verdict is terminal for automatic handling and MUST
  NOT be collapsed into "absent".** The failure the pointer exists to resolve is
  simply not resolved; a client that reads "could not determine" as "did not happen"
  reintroduces the exact double-fire the pointer was there to prevent. The correct
  behavior is to stop and surface, never to replay.

One level below the verdict space, the client's own plumbing can defeat it. Real
reconcile implementations have collapsed "read failed" into "not settled" through
ordinary idioms: a pipeline that converts a partial read into a no-match, an error
path that returns the same value as a genuine zero, a soft-404 that is HTTP 200
with "not available" prose ([soul-sol in #3188][plumb], with dated reproductions).
Two requirements follow:

- A reconcile reader MUST represent read-failure distinctly from authoritative
  absence all the way through its own code; a success-shaped response that does not
  affirmatively answer the question MUST map to "could not determine", never to
  "absent".
- A reconcile checker MUST be validated against positive controls: one case that
  must return settled and one that must return not-settled. A checker validated
  only against the negative is indistinguishable from a function that returns a
  constant.

[plumb]: https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/3188

Normative behavior (all authors agree on this core):

- A client MUST NOT automatically replay a `tools/call` whose failure is ambiguous
  (timeout, mid-stream reset, opaque 5xx) against a tool that is not declared safe to
  replay. It SHOULD surface `agentGuidance` and, if a reconciliation pointer exists,
  run it before any retry.
- A client MAY replay a request that provably never left the client (transport
  failure before send) subject to `retry.afterMs`. Nothing in a received response
  proves non-execution: 429 and 503 can arrive after the effect landed, and text
  describing a connection reset describes the server's upstream, not its side
  effect. Against a tool not declared safe to replay, a received response MUST NOT
  trigger automatic replay. (The conformance battery in `sep/conformance` caught
  two text-based versions of this rule replaying a side-effecting tool; the
  structural rule is the fix.)
- Tools declared read-only or idempotent MAY be replayed per the retry directive.

### 4.4 Caller-supplied identifiers ("the description is the interface")

A field reading of eight agent-payment toolkits ([aurumflux20 in #2930][csi]) found a
defect class this SEP must name: in three toolkits the idempotency mechanism was
implemented correctly and the parameter description defeated it. A description
saying the key must be "unique for every request" is accurate prose for a human
integrator, for whom "request" means the purchase. A model caller re-reads that
text on every call, with no memory of the last one, and executes it literally: it
mints a fresh key on retry, and the platform correctly records a second payment.
In MCP, a tool description is not documentation; it is the specification the
caller executes.

Normative (wording after HarperZ9 in the same thread):

- If a tool accepts a caller-supplied idempotency key, the tool contract or the key
  parameter's description MUST require the same value for every attempt of the same
  logical operation, and a different value for each distinct logical operation.
- The caller, host, or client MUST retain that value until the outcome is
  reconciled, and MUST NOT generate a replacement merely because an attempt timed
  out or failed ambiguously.

This rule lives in the tool contract rather than the error payload deliberately: by
the time an ambiguous result is being handled under 4.3, a rotated key has already
destroyed the identity that reconciliation depends on.

[csi]: https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2930

### 4.5 Minimal-consumer rule

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
- **Conformance battery** ([`sep/conformance`](conformance/README.md)): seven
  failure modes with direction-aware scoring (over-firing AND over-refusing), a
  fixture whose side effect is recorded before the failure fires, and a self-check
  history: it caught the reference implementation double-executing twice before the
  structural replay gate landed. Starting point for the SEP's required conformance
  test.

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
