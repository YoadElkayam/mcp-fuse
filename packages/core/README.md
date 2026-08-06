# mcp-fuse-core

The engine behind [mcp-fuse](https://github.com/YoadElkayam/mcp-fuse): MCP Error
Policy (MEP) types, the error classifier, the deadline-aware retry engine, the
circuit breaker, and the idempotency gate. Zero runtime dependencies.

Use this package directly if you're building MEP support into your own MCP server,
client, or middleware:

```ts
import {
  classify,            // raw failure → structured ErrorPolicy
  nextRetry,           // (retry directive, attempt) → { retry, delayMs }
  silentRetryAllowed,  // the idempotency gate
  CircuitBreaker,
  ERROR_POLICY_META_KEY,
} from "mcp-fuse-core";

const policy = classify({ httpStatus: 429, retryAfterMs: 12_000 });
// { version: "1", category: "rate_limit", retryable: true,
//   retry: { strategy: "fixed", afterMs: 12000, ... },
//   agentGuidance: "This tool is rate limited. ..." }
```

The normative MEP JSON Schema and spec live in the
[main repository](https://github.com/YoadElkayam/mcp-fuse/tree/main/spec).

MIT
