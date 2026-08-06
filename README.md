# mcp-fuse

**Deterministic failure handling for MCP. Stop letting your LLM debug your network.**

> Status: **pre-alpha** — spec draft + working stdio proxy (M2). Not yet published to npm.

## The problem

MCP surfaces errors as raw text payloads (HTTP 429s, stack traces, `isError: true` tool
results) intended for the LLM to read. That means a **stochastic model is handling
deterministic network failures**. The result is a familiar failure mode:

1. A tool call hits a rate limit or a down service.
2. The raw error lands in the context window.
3. The agent "helpfully" retries. And retries. And retries.
4. Tokens burn, the context fills with garbage, behavior degrades.

Retries, backoff, and circuit breaking are solved problems — in deterministic code.
They should never have been the model's job.

## The solution

Two pieces, shipped together:

1. **The standard — MCP Error Policy (MEP).** A structured JSON extension for MCP errors
   that categorizes failures (transient vs. permanent, rate-limit vs. auth) and carries
   explicit machine directives: backoff timing, retry budgets, circuit-breaker signals.
   See [`spec/`](spec/README.md).

2. **The delivery mechanism — a zero-config proxy.** A drop-in wrapper that sits between
   any MCP client and server. It intercepts errors, applies the resilience logic
   *silently* (retry, backoff, circuit-break), and forwards only a single compact,
   semantic instruction to the agent when — and only when — the agent actually needs
   to change course. No SDK changes, no server changes, no orchestration harness.

```
┌────────┐     ┌──────────────────────────────┐     ┌────────────┐
│ Agent /  │────▶│          mcp-fuse            │────▶│ MCP server │
│ MCP host │     │ classify → retry → breaker   │     │ (any)      │
│          │◀────│ → 1 semantic message, max    │◀────│            │
└────────┘     └──────────────────────────────┘     └────────────┘
```

## Quickstart

Wrap any stdio MCP server (working today — run from a checkout until npm publish):

```bash
mcp-fuse wrap -- node ./my-mcp-server.js
mcp-fuse wrap --config fuse.config.json -- npx @modelcontextprotocol/server-github
```

Or front a Streamable HTTP server (M3, not yet implemented):

```bash
mcp-fuse proxy --target http://localhost:8085/mcp --port 9090
```

That's it. Rate limits get honored, transient failures get retried with exponential
backoff, dead services get circuit-broken — and your agent sees at most one clean
message like:

> `Tool "search" is unavailable (service down, circuit open for 30s). Do not retry; use an alternative or tell the user.`

## Repository layout

| Path | Contents |
|------|----------|
| [`spec/`](spec/) | The MEP spec draft + JSON Schema + example payloads |
| [`packages/core`](packages/core/) | `@mcp-fuse/core` — types, error classifier, retry engine, circuit breaker |
| [`packages/proxy`](packages/proxy/) | `@mcp-fuse/proxy` — the CLI + stdio/HTTP proxies |
| [`middleware-java/`](middleware-java/) | Planned Java middleware (Spring/servlet filter) |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Full design plan and roadmap |
| [`examples/`](examples/) | Runnable demos (flaky server + agent, before/after) |

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
