# mcp-fuse Quickstart

Five minutes to stop token-burning MCP error loops. No server changes, no client
changes.

## 1. Protect everything at once (recommended)

```bash
npx mcp-fuse init
```

Finds your MCP config, rewrites every stdio server entry to run behind the proxy,
and writes a `.mcp-fuse-backup` next to each file it touches. Then restart your
host. Scoping is least-surprise: a project `./.mcp.json` wins when present; global
host configs (Cursor, Claude Desktop) are only touched with `--all` or `--file`.

Useful variants:

```bash
npx mcp-fuse init --dry-run              # show what would change, write nothing
npx mcp-fuse init --all                  # include global host configs (Cursor, Claude Desktop)
npx mcp-fuse init --file ./my.mcp.json   # a specific config file
npx mcp-fuse init --unwrap               # undo
npx mcp-fuse init --fuse-config ./fuse.config.json   # bake in custom policy
```

## 2. Or wrap one server by hand

Change the server entry in your host config:

```jsonc
{
  "mcpServers": {
    "github": {
      // before: "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"]
      "command": "npx",
      "args": ["-y", "mcp-fuse", "wrap", "--", "npx", "-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." }   // env still works — the proxy passes it through
    }
  }
}
```

## What you get

- **Transient failures (5xx, connection resets) are retried silently** with
  exponential backoff inside a 5s budget — your agent sees a success, not a stack
  trace.
- **Rate limits are honored deterministically**: `Retry-After` beyond the budget
  becomes an instant, compact "do not re-invoke" message plus a cooldown — repeat
  calls fail fast in ~0ms instead of burning tokens.
- **Dead servers get circuit-broken**: after repeated failures, calls fail fast with
  clear guidance until the cooldown elapses.
- **Non-idempotent tools are never double-executed**: silent replay is gated on the
  tool's `readOnlyHint`/`idempotentHint` annotations; ambiguous failures on
  side-effect tools fail fast with "verify before re-invoking" guidance.
- **At most ONE compact error message per failure** reaches the model, with a
  machine-readable [MCP Error Policy](../spec/README.md) payload under `_meta`.

## Configuration (optional — defaults are safe)

`fuse.config.json`, passed via `wrap --config` or `init --fuse-config`:

```jsonc
{
  "defaults": {
    "maxAbsorptionMs": 5000,              // silent-retry budget per call
    "maxAbsorptionWithProgressMs": 20000  // when the host sent a progressToken
  },
  "circuit": { "failureThreshold": 5, "reopenAfterMs": 30000 },
  "tools": {
    "legacy_search": { "assumeIdempotent": true }  // un-annotated but safe to retry
  },
  "log": { "file": "/tmp/mcp-fuse.jsonl", "verbose": false }
}
```

## Debugging — nothing is hidden unrecoverably

The fuse suppresses errors from the *model's context*, never from you:

- `--verbose` prints every suppressed raw error and retry to stderr.
- `--log-file /path/audit.jsonl` (or `log.file` in config) appends a JSONL record
  for every absorbed retry, suppressed error (with full raw text), and circuit
  event.
- On shutdown the proxy prints a summary:
  `mcp-fuse: absorbed 14 retries, opened 1 circuit(s), suppressed 11 agent-visible errors (~38k tokens kept out of context)`

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Wrapped server can't find its API key | Fixed in ≥0.1.0 (full env passthrough). Update mcp-fuse. |
| Host reports the tool call timed out | Your host's tool timeout is below the absorption budget — lower `maxAbsorptionMs`. |
| A safe tool isn't being retried | Its server doesn't set `idempotentHint`/`readOnlyHint`. Add `"tools": {"<name>": {"assumeIdempotent": true}}`. |
| HTTP/SSE servers | Not wrappable yet — stdio only until M3. `init` skips them and says so. |
| Something looks swallowed | Run with `--verbose` or check the JSONL log — every suppressed byte is there. |
