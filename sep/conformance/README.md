# Conformance battery (working draft)

Standards Track SEPs with observable protocol behavior need a merged conformance
test before they go final. This battery is the starting point. Its modes are ported
from aurumflux20's [hostile-facilitator](https://github.com/aurumflux20/hostile-facilitator)
(payment-shaped) onto `tools/call` in general.

**The question it answers:** for a side-effecting tool, did each logical operation
execute the intended number of times under ambiguous outcomes? Most modes are one
logical request where pass means exactly one effect. The distinct-operation mode
uses two logical operations and passes only when both effects happen.

Fixture: [`examples/hostile-server`](../../examples/hostile-server) — the `charge`
tool records its effect *before* the failure mode fires, `charge_with_key` records
caller-supplied idempotency-key behavior, `verify_charge` is the reconciliation
read, and `node dist/run.js` drives a client under test through the fixture
battery. For `retry-original-key`, the fixture writes a temp ledger, records the
first keyed effect, then closes the child process before any tool result is sent;
if the proxy restarts the child, the retry sees the same ledger. This is a fixture
for retry-identity behavior, not a host-wide compliance claim.

| Mode | What the server does | Correct client behavior |
|------|----------------------|-------------------------|
| `settle-then-timeout` | executes, never responds | ambiguous: no replay, surface guidance / reconcile |
| `5xx-after-settle` | executes, returns 503 | a server response is not proof of non-execution: no replay |
| `duplicate` | executes, returns 429 inviting retry | same: no replay without a declared-safe effect class |
| `slow-answer` | executes, responds after the deadline | no replay after a deadline; late success must not confuse state |
| `verify-unavailable` | executes, fails ambiguously, **and `verify_charge` also fails** | "could not determine" is terminal: hold, never replay, never treat as absent |
| `retry-original-key` | executes with a caller-supplied idempotency key, persists the effect, then closes before returning a tool result | replay with the original key; one effect and two same-key attempts |
| `distinct-operation-key` | accepts two distinct logical operations with caller-supplied keys | use a distinct key per logical operation; both effects must happen |
| `declared-safe` | tool declares `idempotentHint: true`; server dedupes internally | replay IS expected — the gate must not refuse work it was told is safe |
| `honest` | executes, responds | control |

The last two close the battery in the other direction. Every mode above them asks
"did the client over-fire?" — but a retry gate fails two ways, and a maximally
paranoid client that replays nothing would score a perfect 5/5 on the original
five while being useless in production. `declared-safe` catches that. And
`verify-unavailable` is the recursive case of the SEP's own rule: the client is
unsure whether the effect landed, asks, and the asking fails too. A client that
resolves that to "absent" and replays has reintroduced the exact double-execution
the reconciliation pointer exists to prevent. The retry-identity modes cover the
key-stability failure in the same direction: a rotated key on retry creates a
duplicate effect, while one process-wide reused key dedupes a distinct operation
away.

## Result for the reference implementation (mcp-fuse)

From a source checkout with Node >=20 and pnpm >=9:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @mcp-fuse/example-hostile-server test
pnpm --filter @mcp-fuse/example-hostile-server conformance
```

The four fixture self-checks exercise correct and deliberately broken clients
using the battery's scorer. They do not establish that the proxy passes the
battery. The conformance command currently exits 1 for the failure below.
Each run retains isolated synthetic ledgers in the operating system's temporary
directory; these contain fixture counters, not real payments or credentials.

Current retry-identity run, 2026-09-05: **8 of 9 modes passed**. The real
dropped-response `retry-original-key` mode failed: the effect landed once, but
only one same-key attempt was observed after the child closed. That preserves the
transport-loss gap as a reproducible negative finding; the fixture no longer
models this case as a synthetic MCP `isError` response.

First run, 2026-08-30: **2 of 5 modes double-executed** (`5xx-after-settle`,
`duplicate`, three executions each). The gate treated HTTP 429 and 503 as
"guaranteed not processed" and replayed them. Second attempt matched only
connection-level phrases in the error text; the 503 body quoted Envoy's
"reset before headers" and the gate replayed it again. Both rules were inference
from text. The fix is structural: a side-effecting tool is replayed only when the
request provably never left the client. The rerun passes 5 of 5. The sequence is
recorded here on purpose: it is the SEP's argument for declaration over inference,
demonstrated twice on our own code.

## Open items

- Resolve the reference proxy's real dropped-response retry failure while
  preserving the original key. The fixture exists; this invariant is not yet
  satisfied by the reference proxy. Runtime/proxy changes are outside this PR.
- Run the battery against hosts directly (Claude Code, Cursor) once a policy-aware
  client exists outside the proxy.
- Decide whether `verify-unavailable` should also assert *what the client surfaced*
  to the model, not only that it held. Holding silently is safe but unhelpful; the
  SEP's `agentGuidance` is the natural place for the difference.

## Scoring note

`verify-unavailable`, `declared-safe`, and the retry-identity modes invert simple
global scoring rules. A suite that scores every mode as "effects <= 1" will mark a
broken client as passing `declared-safe` or `distinct-operation-key` when work was
not performed. A suite that ignores idempotency-key attempts will miss the
`retry-original-key` failure where a rotated key creates a duplicate effect.
Implementations should score per-mode intent, not a single global rule.

Both modes are implemented in the upstream battery
([hostile-facilitator](https://github.com/aurumflux20/hostile-facilitator), 7 modes,
direction-aware scoring) with a self-check asserting a known-broken client fails
them and a known-correct client passes: the instrument is verified before it judges
anyone.
