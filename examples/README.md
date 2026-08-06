# Examples

- **`flaky-server/`** ✅ — a deterministic, deliberately unreliable stdio MCP server
  (scripted 429 storms, ECONNREFUSED windows, latency ramps) plus a naive-agent
  benchmark that measures the token cost of unprotected retry loops. The Phase 1
  benchmarking rig — see its [README](flaky-server/README.md).

Planned (M2 exit criterion — see [docs/DESIGN.md](../docs/DESIGN.md)):
- **`before-after/`** — the marketing demo: the same agent task run against the flaky
  server directly vs. through `mcp-fuse wrap`, with side-by-side token counts and
  transcripts showing the retry loop vs. one clean guidance message.
- **`claude-code/`** — a copy-paste `mcpServers` config snippet showing the one-line
  adoption path:

```jsonc
{
  "mcpServers": {
    "search": {
      // before: "command": "node", "args": ["./search-server.js"]
      "command": "npx",
      "args": ["mcp-fuse", "wrap", "--", "node", "./search-server.js"]
    }
  }
}
```
