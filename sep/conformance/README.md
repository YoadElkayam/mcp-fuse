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
| `honest` | executes, responds | control |

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

- Verdict-space check (SEP 4.3): a mode where `verify_charge` itself fails, to
  assert clients treat "could not determine" as terminal rather than as "absent".
- Declared-safe mode: a tool declared `idempotentHint: true` under the same battery,
  asserting replay IS performed (the gate must not be over-cautious either).
- Run the battery against hosts directly (Claude Code, Cursor) once a policy-aware
  client exists outside the proxy.
