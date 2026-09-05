import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { scoreMode, type ModeResult } from "./run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.resolve(here, "../dist/server.js");
const statePathEnv = "HOSTILE_SERVER_STATE_PATH";

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

interface KeyedCharge extends Record<string, unknown> {
  orderId: string;
  amount: number;
  idempotencyKey: string;
}

function statePath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "mcp-fuse-hostile-test-")), "ledger.json");
}

async function connect(mode: string, stateFile: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs, mode],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      [statePathEnv]: stateFile,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "retry-identity-test", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 }) as Promise<ToolResult>;
}

async function chargeWithKey(client: Client, args: KeyedCharge): Promise<ToolResult> {
  return call(client, "charge_with_key", args);
}

async function close(client: Client): Promise<void> {
  await client.close().catch(() => {});
}

async function executions(client: Client, orderId: string): Promise<number> {
  const result = await call(client, "ground_truth", { orderId });
  return Number(result.content?.[0]?.text ?? -1);
}

async function keyAttempts(client: Client, idempotencyKey: string): Promise<number> {
  const result = await call(client, "ground_truth_key", { idempotencyKey });
  const payload = JSON.parse(result.content?.[0]?.text ?? "{}") as { attempts?: number };
  return payload.attempts ?? -1;
}

function observed(overrides: Partial<ModeResult>): ModeResult {
  return {
    executions: 0,
    secondExecutions: 0,
    keyAttempts: 0,
    safeAttempts: 0,
    wallMs: 0,
    clientSaw: "",
    ...overrides,
  };
}

test("retry-original-key: replaying the same logical operation with the original key records one effect", async () => {
  const stateFile = statePath();
  const firstClient = await connect("retry-original-key", stateFile);
  try {
    const args = { orderId: "order-1", amount: 42, idempotencyKey: "retry-key-1" };

    await assert.rejects(chargeWithKey(firstClient, args), /connection closed/i);
  } finally {
    await close(firstClient);
  }

  const retryClient = await connect("retry-original-key", stateFile);
  try {
    const args = { orderId: "order-1", amount: 42, idempotencyKey: "retry-key-1" };
    const retry = await chargeWithKey(retryClient, args);

    assert.notEqual(retry.isError, true);
    const result = observed({
      executions: await executions(retryClient, "order-1"),
      keyAttempts: await keyAttempts(retryClient, "retry-key-1"),
    });
    assert.equal(result.executions, 1);
    assert.equal(result.keyAttempts, 2);
    assert.equal(scoreMode("retry-original-key", result), true);
  } finally {
    await close(retryClient);
  }
});

test("retry-original-key negative control: rotating the retry key duplicates the effect and must be rejected", async () => {
  const stateFile = statePath();
  const firstClient = await connect("retry-original-key", stateFile);
  try {
    await assert.rejects(
      chargeWithKey(firstClient, { orderId: "order-1", amount: 42, idempotencyKey: "retry-key-1" }),
      /connection closed/i,
    );
  } finally {
    await close(firstClient);
  }

  const rotatedClient = await connect("retry-original-key", stateFile);
  try {
    await assert.rejects(
      chargeWithKey(rotatedClient, { orderId: "order-1", amount: 42, idempotencyKey: "retry-key-2" }),
      /connection closed/i,
    );
  } finally {
    await close(rotatedClient);
  }

  const verifier = await connect("retry-original-key", stateFile);
  try {
    const result = observed({
      executions: await executions(verifier, "order-1"),
      keyAttempts: await keyAttempts(verifier, "retry-key-1"),
    });
    assert.equal(result.executions, 2);
    assert.equal(result.keyAttempts, 1);
    assert.equal(await keyAttempts(verifier, "retry-key-2"), 1);
    assert.equal(scoreMode("retry-original-key", result), false);
  } finally {
    await close(verifier);
  }
});

test("distinct-operation-key: distinct logical operations with distinct keys both execute", async () => {
  const client = await connect("distinct-operation-key", statePath());
  try {
    await chargeWithKey(client, { orderId: "order-1", amount: 42, idempotencyKey: "key-1" });
    await chargeWithKey(client, { orderId: "order-2", amount: 42, idempotencyKey: "key-2" });

    const result = observed({
      executions: await executions(client, "order-1"),
      secondExecutions: await executions(client, "order-2"),
    });
    assert.equal(result.executions, 1);
    assert.equal(result.secondExecutions, 1);
    assert.equal(scoreMode("distinct-operation-key", result), true);
  } finally {
    await close(client);
  }
});

test("distinct-operation-key negative control: a process-wide reused key suppresses the second effect and must be rejected", async () => {
  const client = await connect("distinct-operation-key", statePath());
  try {
    await chargeWithKey(client, { orderId: "order-1", amount: 42, idempotencyKey: "process-wide-key" });
    await chargeWithKey(client, { orderId: "order-2", amount: 42, idempotencyKey: "process-wide-key" });

    const result = observed({
      executions: await executions(client, "order-1"),
      secondExecutions: await executions(client, "order-2"),
      keyAttempts: await keyAttempts(client, "process-wide-key"),
    });
    assert.equal(result.executions, 1);
    assert.equal(result.secondExecutions, 0);
    assert.equal(await keyAttempts(client, "process-wide-key"), 2);
    assert.equal(scoreMode("distinct-operation-key", result), false);
  } finally {
    await close(client);
  }
});
