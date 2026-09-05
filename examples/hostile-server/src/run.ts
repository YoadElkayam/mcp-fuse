#!/usr/bin/env node
/**
 * Conformance runner: drives a client-under-test through every battery mode and
 * reports how many times the side effect actually executed for each battery mode.
 *
 * Client-under-test here: mcp-fuse (the reference implementation), wrapping the
 * hostile server. Pass is mode-specific: most modes require one effect, while
 * the distinct-operation mode requires two effects.
 *
 *   node dist/run.js
 */
import path from "node:path";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "server.js");
const require = createRequire(import.meta.url);
const fuseCli = path.join(path.dirname(require.resolve("mcp-fuse")), "cli.js");
const statePathEnv = "HOSTILE_SERVER_STATE_PATH";

export interface Case {
  mode: string;
  expectation: string;
  /** Per-mode pass condition — several modes invert a naive global "effects <= 1" rule. */
  pass: (r: ModeResult) => boolean;
  verdictLabel: string;
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ text?: string }>;
}

interface LedgerState {
  executions?: Record<string, number>;
  keyedAttempts?: Record<string, number>;
  safeAttempts?: number;
}

export interface ModeResult {
  executions: number;
  secondExecutions: number;
  keyAttempts: number;
  safeAttempts: number;
  wallMs: number;
  clientSaw: string;
}

const atMostOnce = (r: ModeResult) => r.executions === 1;
export const BATTERY: Case[] = [
  { mode: "settle-then-timeout", expectation: "ambiguous timeout: must NOT replay (effect class unknown)", pass: atMostOnce, verdictLabel: "effect==1" },
  { mode: "5xx-after-settle", expectation: "5xx after the effect landed: must NOT replay a side-effecting tool", pass: atMostOnce, verdictLabel: "effect==1" },
  { mode: "duplicate", expectation: "429 after the effect landed: a server response is not proof of non-execution; must NOT replay", pass: atMostOnce, verdictLabel: "effect==1" },
  { mode: "slow-answer", expectation: "late success: must NOT replay after a deadline", pass: atMostOnce, verdictLabel: "effect==1" },
  { mode: "verify-unavailable", expectation: "reconciliation read down: could-not-determine is terminal; hold, never replay", pass: atMostOnce, verdictLabel: "effect==1" },
  { mode: "retry-original-key", expectation: "effect landed then the child closed without a tool result: automatic replay must keep the original idempotency key", pass: (r) => r.executions === 1 && r.keyAttempts === 2, verdictLabel: "effect==1 & key attempts==2" },
  { mode: "distinct-operation-key", expectation: "distinct logical operations must use distinct idempotency keys, producing two effects", pass: (r) => r.executions === 1 && r.secondExecutions === 1, verdictLabel: "order1==1 & order2==1" },
  { mode: "declared-safe", expectation: "tool declares safe-to-replay: replay IS expected (attempts >= 2, effect == 1)", pass: (r) => r.safeAttempts >= 2 && r.executions === 1, verdictLabel: "attempts>=2 & effect==1" },
  { mode: "honest", expectation: "control: one call, one execution", pass: atMostOnce, verdictLabel: "effect==1" },
];

export function scoreMode(mode: string, result: ModeResult): boolean {
  const batteryCase = BATTERY.find((c) => c.mode === mode);
  if (batteryCase === undefined) {
    throw new Error(`Unknown battery mode: ${mode}`);
  }
  return batteryCase.pass(result);
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const res = (await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: 20_000 },
    )) as ToolResult;
    return (res.isError ? "error: " : "ok: ") + (res.content?.[0]?.text ?? "").split("\n")[0].slice(0, 70);
  } catch (e) {
    return "threw: " + String((e as Error).message).slice(0, 70);
  }
}

function freshStatePath(mode: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), `mcp-fuse-hostile-${mode}-`)), "ledger.json");
}

function readLedger(stateFile: string): LedgerState {
  if (!existsSync(stateFile)) return {};
  return JSON.parse(readFileSync(stateFile, "utf8")) as LedgerState;
}

async function runMode(mode: string): Promise<ModeResult> {
  const stateFile = freshStatePath(mode);
  const childEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
    [statePathEnv]: stateFile,
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fuseCli, "wrap", "--", process.execPath, serverJs, mode],
    env: childEnv,
    stderr: "ignore",
  });
  const client = new Client({ name: "conformance-runner", version: "0.0.1" });
  await client.connect(transport);
  const t0 = Date.now();
  let clientSaw: string;
  let keyedAttemptName: string | undefined;
  if (mode === "retry-original-key") {
    const idempotencyKey = "retry-key-1";
    keyedAttemptName = idempotencyKey;
    clientSaw = await callTool(client, "charge_with_key", {
      orderId: "order-1",
      amount: 42,
      idempotencyKey,
    });
  } else if (mode === "distinct-operation-key") {
    const first = await callTool(client, "charge_with_key", {
      orderId: "order-1",
      amount: 42,
      idempotencyKey: "operation-key-1",
    });
    const second = await callTool(client, "charge_with_key", {
      orderId: "order-2",
      amount: 43,
      idempotencyKey: "operation-key-2",
    });
    clientSaw = `${first}; ${second}`.slice(0, 78);
  } else {
    const toolName = mode === "declared-safe" ? "charge_safe" : "charge";
    clientSaw = await callTool(client, toolName, { orderId: "order-1", amount: 42 });
  }
  const wallMs = Date.now() - t0;
  await client.close().catch(() => {});

  // The persisted fixture ledger is the ground truth even if the child closed
  // before the proxy could serve the backdoor tools.
  const ledger = readLedger(stateFile);
  const executions = ledger.executions?.["order-1"] ?? 0;
  const secondExecutions = ledger.executions?.["order-2"] ?? 0;
  const keyAttempts = keyedAttemptName === undefined ? 0 : (ledger.keyedAttempts?.[keyedAttemptName] ?? 0);
  const safeAttempts = ledger.safeAttempts ?? 0;
  return { executions, secondExecutions, keyAttempts, safeAttempts, wallMs, clientSaw };
}

export async function main(): Promise<number> {
  console.log("\nSEP conformance battery — client under test: mcp-fuse (reference implementation)\n");
  console.log(" mode                   | effects | verdict | wall ms | client saw");
  console.log("------------------------|---------|---------|---------|-----------------------------------------");
  let failures = 0;
  for (const c of BATTERY) {
    const r = await runMode(c.mode);
    const pass = scoreMode(c.mode, r);
    if (!pass) failures += 1;
    const effects = r.executions + r.secondExecutions;
    console.log(
      ` ${c.mode.padEnd(22)} | ${String(effects).padStart(7)} | ${(pass ? "PASS" : "FAIL").padEnd(7)} | ${String(r.wallMs).padStart(7)} | ${r.clientSaw}`,
    );
  }
  console.log("\nExpectations:");
  for (const c of BATTERY) console.log(` - ${c.mode}: ${c.expectation}`);
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} mode(s) failed pass conditions`}`);
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
