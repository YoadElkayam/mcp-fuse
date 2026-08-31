# Conformance battery (working draft)

Standards Track SEPs with observable protocol behavior need a merged conformance
test before they go final. This battery is the starting point. Its modes are ported
from aurumflux20's [hostile-facilitator](https://github.com/aurumflux20/hostile-facilitator)
(payment-shaped) onto `tools/call` in general.

**The question it answers:** for ONE logical request against a side-effecting tool,
how many times did the effect actually execute, under each ambiguous outcome?
Pass means exactly one.

Fixture: [`examples/hostile-server`](../../examples/hostile-server) — the `charge`
tool records its effect *before* the failure mode fires, `verify_charge` is the
reconciliation read (ground truth), and `node dist/run.js` drives a client under
test through the battery.

| Mode | What the server does | Correct client behavior |
|------|----------------------|-------------------------|
| `settle-then-timeout` | executes, never responds | ambiguous: no replay, surface guidance / reconcile |
| `5xx-after-settle` | executes, returns 503 | a server response is not proof of non-execution: no replay |
| `duplicate` | executes, returns 429 inviting retry | same: no replay without a declared-safe effect class |
| `slow-answer` | executes, responds after the deadline | no replay after a deadline; late success must not confuse state |
| `verify-unavailable` | executes, fails ambiguously, **and `verify_charge` also fails** | "could not determine" is terminal: hold, never replay, never treat as absent |
| `declared-safe` | tool declares `idempotentHint: true`; server dedupes internally | replay IS expected — the gate must not refuse work it was told is safe |
| `honest` | executes, responds | control |

The last two close the battery in the other direction. Every mode above them asks
"did the client over-fire?" — but a retry gate fails two ways, and a maximally
paranoid client that replays nothing would score a perfect 5/5 on the original
five while being useless in production. `declared-safe` catches that. And
`verify-unavailable` is the recursive case of the SEP's own rule: the client is
unsure whether the effect landed, asks, and the asking fails too. A client that
resolves that to "absent" and replays has reintroduced the exact double-execution
the reconciliation pointer exists to prevent.

## Result for the reference implementation (mcp-fuse)

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

- Run the battery against hosts directly (Claude Code, Cursor) once a policy-aware
  client exists outside the proxy.
- Decide whether `verify-unavailable` should also assert *what the client surfaced*
  to the model, not only that it held. Holding silently is safe but unhelpful; the
  SEP's `agentGuidance` is the natural place for the difference.

## Scoring note

`verify-unavailable` and `declared-safe` invert the pass condition, so a suite that
scores every mode as "executions <= 1" will mark a broken client as passing
`declared-safe` (it never executed at all, which is the failure). Implementations
should score per-mode intent, not a single global rule.

Both modes are implemented in the upstream battery
([hostile-facilitator](https://github.com/aurumflux20/hostile-facilitator), 7 modes,
direction-aware scoring) with a self-check asserting a known-broken client fails
them and a known-correct client passes: the instrument is verified before it judges
anyone.
