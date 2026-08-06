# mcp-fuse Java middleware (planned — M6)

Java port of the resilience engine, implemented from the language-neutral artifacts:

- [`spec/error-policy.schema.json`](../spec/error-policy.schema.json) — the contract
- [`spec/examples/`](../spec/examples/) — conformance payloads both implementations must produce/accept

Planned deliverables:

- `mcp-fuse-core` — classifier, retry engine, circuit breaker (zero-dependency)
- `mcp-fuse-servlet` — servlet filter for HTTP MCP servers
- `mcp-fuse-spring-boot-starter` — auto-configuration for Spring Boot

Deliberately deferred until after the TypeScript proxy launch (M4), so the schema
stabilizes against real-world usage before it is ported. See
[docs/DESIGN.md §7](../docs/DESIGN.md).
