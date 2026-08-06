# mcp-fuse

**Deterministic failure handling for MCP. Stop letting your LLM debug your network.**

When an MCP server rate-limits or dies, the raw error lands in your agent's context
window — and the agent retries, and retries, burning tokens and corrupting context.
mcp-fuse is a zero-config proxy that moves retries, backoff, and circuit breaking
back into deterministic code, forwarding at most **one compact, actionable message**
to the model.

## Protect every server you have

```bash
npx mcp-fuse init        # rewrites your MCP config (Claude Code/Desktop, Cursor); writes backups
npx mcp-fuse init --dry-run
npx mcp-fuse init --unwrap
```

## Or wrap one server

```bash
npx mcp-fuse wrap -- npx -y @modelcontextprotocol/server-github
```

## What it does

- Silent retry with exponential backoff for transient failures (deadline-aware, 5s budget)
- Honors `Retry-After` — long waits become instant fail-fast + cooldown, not hangs
- Circuit breaker per tool; open circuits fail in ~0ms
- Idempotency gate: never double-executes tools with side effects
  (gated on `readOnlyHint`/`idempotentHint` annotations)
- Attaches a machine-readable [MCP Error Policy](https://github.com/YoadElkayam/mcp-fuse/tree/main/spec)
  payload under `_meta` for policy-aware hosts
- Full audit trail: `--verbose`, `--log-file audit.jsonl` — nothing is hidden unrecoverably

Docs, spec, and measured benchmarks: **https://github.com/YoadElkayam/mcp-fuse**

MIT
