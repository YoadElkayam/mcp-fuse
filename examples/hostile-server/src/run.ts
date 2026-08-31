#!/usr/bin/env node
/**
 * Conformance runner: drives a client-under-test through every battery mode and
 * reports how many times the side effect actually executed for ONE logical request.
 *
 * Client-under-test here: mcp-fuse (the reference implementation), wrapping the
 * hostile server. Pass = exactly one execution.
 *
 *   node dist/run.js
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "server.js");
const require = createRequire(import.meta.url);
const fuseCli = path.join(path.dirname(require.resolve("mcp-fuse")), "cli.js");

interface Case {
  mode: string;
  expectation: string;
  /** Per-mode pass condition — the two closing modes invert it (see scoring note). */
  pass: (r: { executions: number; safeAttempts: number }) => boolean;
  verdictLabel: string;
}
const atMostOnce = (r: { executions: number }) => r.executions === 1;
const BATTERY: Case[] = [
  { mode: "settle-then-timeout", expectation: "ambiguous timeout: must NOT replay (effect class unknown)", pass: atMostOnce, verdictLabel: "effect==1" },
  { mode: "5xx-after-settle", expectation: "5xx after the effect landed: must NOT replay a side-effecting tool", pass: atMostOnce, verdictLabel: "effect==1" },
  { mode: "duplicate", expectation: "429 after the effect landed: a server response is not proof of non-execution; must NOT replay", pass: atMostOnce, verdictLabel: "effect==1" },
  { mode: "slow-answer", expectation: "late success: must NOT replay after a deadline", pass: atMostOnce, verdictLabel: "effect==1" },
  { mode: "verify-unavailable", expectation: "reconciliation read down: could-not-determine is terminal; hold, never replay", pass: atMostOnce, verdictLabel: "effect==1" },
  { mode: "declared-safe", expectation: "tool declares safe-to-replay: replay IS expected (attempts >= 2, effect == 1)", pass: (r) => r.safeAttempts >= 2 && r.executions === 1, verdictLabel: "attempts>=2 & effect==1" },
  { mode: "honest", expectation: "control: one call, one execution", pass: atMostOnce, verdictLabel: "effect==1" },
];

async function runMode(mode: string): Promise<{ executions: number; safeAttempts: number; wallMs: number; clientSaw: string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fuseCli, "wrap", "--", process.execPath, serverJs, mode],
    env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
    stderr: "ignore",
  });
  const client = new Client({ name: "conformance-runner", version: "0.0.1" });
  await client.connect(transport);
  const t0 = Date.now();
  const toolName = mode === "declared-safe" ? "charge_safe" : "charge";
  let clientSaw: string;
  try {
    const res = (await client.callTool(
      { name: toolName, arguments: { orderId: "order-1", amount: 42 } },
      undefined,
      { timeout: 20_000 },
    )) as { isError?: boolean; content?: Array<{ text?: string }> };
    clientSaw = (res.isError ? "error: " : "ok: ") + (res.content?.[0]?.text ?? "").split("\n")[0].slice(0, 70);
  } catch (e) {
    clientSaw = "threw: " + String((e as Error).message).slice(0, 70);
  }
  const wallMs = Date.now() - t0;
  // ground_truth bypasses mode behavior (verify_charge is down in verify-unavailable).
  const truth = (await client.callTool({ name: "ground_truth", arguments: { orderId: "order-1" } })) as {
    content?: Array<{ text?: string }>;
  };
  const executions = Number(truth.content?.[0]?.text ?? -1);
  const attempts = (await client.callTool({ name: "charge_attempts_safe", arguments: {} })) as {
    content?: Array<{ text?: string }>;
  };
  const safeAttempts = Number(attempts.content?.[0]?.text ?? 0);
  await client.close();
  return { executions, safeAttempts, wallMs, clientSaw };
}

console.log("\nSEP conformance battery — client under test: mcp-fuse (reference implementation)\n");
console.log(" mode                | executions | verdict | wall ms | client saw");
console.log("---------------------|------------|---------|---------|-----------------------------------------");
let failures = 0;
for (const c of BATTERY) {
  const r = await runMode(c.mode);
  const pass = c.pass(r);
  if (!pass) failures += 1;
  console.log(
    ` ${c.mode.padEnd(19)} | ${String(r.executions).padStart(10)} | ${(pass ? "PASS" : "FAIL").padEnd(7)} | ${String(r.wallMs).padStart(7)} | ${r.clientSaw}`,
  );
}
console.log("\nExpectations:");
for (const c of BATTERY) console.log(` - ${c.mode}: ${c.expectation}`);
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} mode(s) double-executed`}`);
process.exit(failures === 0 ? 0 : 1);
