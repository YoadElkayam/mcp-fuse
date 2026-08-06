/**
 * Test fixture: a tiny stdio MCP server with deterministic failure behavior.
 * Compiled into dist-test/ and spawned (behind the proxy) by proxy.test.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

let flakyCalls = 0;
let chargeAttempts = 0;
let always503Calls = 0;

const fail503 = (n: number): string =>
  [
    "HTTP 503 Service Unavailable",
    "",
    "upstream connect error or disconnect/reset before headers. reset reason: connection failure",
    "    at UserRepository.findById (/srv/user-service/dist/repository.js:214:19)",
    "    at async UserService.getProfile (/srv/user-service/dist/service.js:88:22)",
    `(upstream call #${n})`,
  ].join("\n");

const server = new McpServer({ name: "fixture-server", version: "0.0.1" });

server.registerTool(
  "flaky_503",
  { description: "Fails twice with 503, then succeeds.", annotations: { readOnlyHint: true } },
  async () => {
    flakyCalls += 1;
    if (flakyCalls <= 2) {
      return { isError: true, content: [{ type: "text", text: fail503(flakyCalls) }] };
    }
    return { content: [{ type: "text", text: `OK after ${flakyCalls} upstream calls` }] };
  },
);

server.registerTool(
  "charge_card",
  { description: "Non-idempotent; always fails with an ambiguous timeout." },
  async () => {
    chargeAttempts += 1;
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `ETIMEDOUT: upstream payment gateway timed out after 30000ms (execution #${chargeAttempts})`,
        },
      ],
    };
  },
);

server.registerTool(
  "charge_attempts",
  { description: "How many times charge_card actually executed.", annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: "text", text: String(chargeAttempts) }] }),
);

server.registerTool(
  "always_503",
  { description: "Always fails with 503.", annotations: { readOnlyHint: true } },
  async () => {
    always503Calls += 1;
    return { isError: true, content: [{ type: "text", text: fail503(always503Calls) }] };
  },
);

await server.connect(new StdioServerTransport());
