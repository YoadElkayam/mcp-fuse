/**
 * Integration tests: real host (SDK Client) → real proxy process (dist/cli.js
 * wrap) → real fixture MCP server. Requires `pnpm build` first (the test script
 * runs it).
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ERROR_POLICY_META_KEY, type ErrorPolicy } from "@mcp-fuse/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliJs = path.resolve(here, "../dist/cli.js");
const fixtureJs = path.resolve(here, "fixtures/fixture-server.js");

async function connectThroughProxy(extraArgs: string[] = []): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliJs, "wrap", ...extraArgs, "--", process.execPath, fixtureJs],
    stderr: "inherit",
  });
  const client = new Client({ name: "proxy-test-host", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  _meta?: Record<string, unknown>;
}

const text = (res: ToolResult): string =>
  (res.content ?? []).map((c) => c.text ?? "").join("\n");
const mep = (res: ToolResult): ErrorPolicy | undefined =>
  res._meta?.[ERROR_POLICY_META_KEY] as ErrorPolicy | undefined;

const call = (client: Client, name: string): Promise<ToolResult> =>
  client.callTool({ name, arguments: {} }, undefined, { timeout: 30_000 }) as Promise<ToolResult>;

test("mirrors the child's identity and tool list", async () => {
  const client = await connectThroughProxy();
  try {
    assert.equal(client.getServerVersion()?.name, "fixture-server");
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["always_503", "charge_attempts", "charge_card", "flaky_503"]);
  } finally {
    await client.close();
  }
});

test("absorbs transient failures on idempotent tools; host sees only success", async () => {
  const client = await connectThroughProxy();
  try {
    const res = await call(client, "flaky_503");
    assert.notEqual(res.isError, true);
    assert.match(text(res), /OK after 3 upstream calls/); // 2 retries absorbed silently
  } finally {
    await client.close();
  }
});

test("idempotency gate: ambiguous failure on a non-idempotent tool is NOT replayed", async () => {
  const client = await connectThroughProxy();
  try {
    const res = await call(client, "charge_card");
    assert.equal(res.isError, true);
    assert.match(text(res), /NOT retried automatically/);
    assert.ok(!text(res).includes("ETIMEDOUT"), "raw error must be suppressed");
    const policy = mep(res);
    assert.equal(policy?.category, "timeout");
    assert.equal(policy?.retryable, false);

    const count = await call(client, "charge_attempts");
    assert.equal(text(count), "1", "the charge must have executed exactly once");
  } finally {
    await client.close();
  }
});

test("suppresses raw errors, attaches MEP, and opens the circuit after repeated failures", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-fuse-test-"));
  const configPath = path.join(dir, "fuse.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaults: { maxAbsorptionMs: 2500 },
      circuit: { failureThreshold: 2, reopenAfterMs: 60_000 },
    }),
  );
  const client = await connectThroughProxy(["--config", configPath]);
  try {
    for (let i = 0; i < 2; i++) {
      const res = await call(client, "always_503");
      assert.equal(res.isError, true);
      assert.ok(!text(res).includes("HTTP 503"), "raw 503 payload must be suppressed");
      assert.ok(text(res).length < 500);
      assert.ok(mep(res), "MEP payload must be attached under _meta");
    }
    const t0 = Date.now();
    const fast = await call(client, "always_503");
    assert.ok(Date.now() - t0 < 500, "open circuit must fail fast");
    assert.match(text(fast), /circuit open/);
    assert.equal(mep(fast)?.circuit?.state, "open");
  } finally {
    await client.close();
  }
});
