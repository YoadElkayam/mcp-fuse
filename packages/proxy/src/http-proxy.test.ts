/**
 * In-process integration: SDK client → HttpProxy → upstream Streamable HTTP
 * server, all over real localhost sockets.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ERROR_POLICY_META_KEY, type ErrorPolicy } from "mcp-fuse-core";
import { HttpProxy } from "./http-proxy.js";

let flakyCalls = 0;
let chargeCalls = 0;

async function startUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const httpServer = createServer((req, res) => {
    void (async () => {
      const sid = req.headers["mcp-session-id"] as string | undefined;
      let transport = sid ? transports.get(sid) : undefined;
      if (!transport) {
        const server = new McpServer({ name: "upstream-fixture", version: "1.0.0" });
        server.registerTool(
          "flaky_read",
          { description: "Fails twice with 503, then succeeds.", annotations: { readOnlyHint: true } },
          async () => {
            flakyCalls += 1;
            if (flakyCalls <= 2) {
              return { isError: true, content: [{ type: "text", text: "HTTP 503 Service Unavailable\nupstream reset" }] };
            }
            return { content: [{ type: "text", text: `OK after ${flakyCalls} upstream calls` }] };
          },
        );
        server.registerTool(
          "charge",
          { description: "Non-idempotent; always fails ambiguously AFTER executing." },
          async () => {
            chargeCalls += 1;
            return { isError: true, content: [{ type: "text", text: `ETIMEDOUT: gateway timed out (execution #${chargeCalls})` }] };
          },
        );
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSid) => void transports.set(newSid, transport!),
        });
        await server.connect(transport);
      }
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as { port: number }).port;
  const close = async () => {
    for (const t of transports.values()) await t.close().catch(() => {});
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  return { port, close };
}

const text = (res: { content?: Array<{ type: string; text?: string }> }): string =>
  (res.content ?? []).map((c) => c.text ?? "").join("\n");

test("http proxy: mirrors identity, absorbs transient failures, gates side effects", async () => {
  const upstream = await startUpstream();
  const proxy = new HttpProxy({ target: `http://127.0.0.1:${upstream.port}/`, port: 0 });
  const port = await proxy.start();
  const client = new Client({ name: "http-test-host", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  try {
    assert.equal(client.getServerVersion()?.name, "upstream-fixture");
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["charge", "flaky_read"]);

    const ok = (await client.callTool({ name: "flaky_read", arguments: {} }, undefined, { timeout: 20_000 })) as never;
    assert.notEqual((ok as { isError?: boolean }).isError, true);
    assert.match(text(ok), /OK after 3 upstream calls/);

    const gated = (await client.callTool({ name: "charge", arguments: {} }, undefined, { timeout: 20_000 })) as {
      isError?: boolean;
      _meta?: Record<string, unknown>;
    };
    assert.equal(gated.isError, true);
    assert.match(text(gated as never), /NOT retried automatically/);
    const policy = gated._meta?.[ERROR_POLICY_META_KEY] as ErrorPolicy;
    assert.equal(policy?.category, "timeout");
    assert.equal(chargeCalls, 1, "side-effecting tool executed exactly once");
  } finally {
    await client.close();
    await proxy.shutdown();
    await upstream.close();
  }
});
