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
}
const BATTERY: Case[] = [
  { mode: "settle-then-timeout", expectation: "ambiguous timeout: must NOT replay (effect class unknown)" },
  { mode: "5xx-after-settle", expectation: "5xx after the effect landed: must NOT replay a side-effecting tool" },
  { mode: "duplicate", expectation: "429 after the effect landed: a server response is not proof of non-execution; must NOT replay" },
  { mode: "slow-answer", expectation: "late success: must NOT replay after a deadline" },
  { mode: "honest", expectation: "control: one call, one execution" },
];

async function runMode(mode: string): Promise<{ executions: number; wallMs: number; clientSaw: string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fuseCli, "wrap", "--", process.execPath, serverJs, mode],
    env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
    stderr: "ignore",
  });
  const client = new Client({ name: "conformance-runner", version: "0.0.1" });
  await client.connect(transport);
  const t0 = Date.now();
  let clientSaw: string;
  try {
    const res = (await client.callTool(
      { name: "charge", arguments: { orderId: "order-1", amount: 42 } },
      undefined,
      { timeout: 20_000 },
    )) as { isError?: boolean; content?: Array<{ text?: string }> };
    clientSaw = (res.isError ? "error: " : "ok: ") + (res.content?.[0]?.text ?? "").split("\n")[0].slice(0, 70);
  } catch (e) {
    clientSaw = "threw: " + String((e as Error).message).slice(0, 70);
  }
  const wallMs = Date.now() - t0;
  const verify = (await client.callTool({ name: "verify_charge", arguments: { orderId: "order-1" } })) as {
    content?: Array<{ text?: string }>;
  };
  const executions = JSON.parse(verify.content?.[0]?.text ?? "{}").executions ?? -1;
  await client.close();
  return { executions, wallMs, clientSaw };
}

console.log("\nSEP conformance battery — client under test: mcp-fuse (reference implementation)\n");
console.log(" mode                | executions | verdict | wall ms | client saw");
console.log("---------------------|------------|---------|---------|-----------------------------------------");
let failures = 0;
for (const c of BATTERY) {
  const r = await runMode(c.mode);
  const pass = r.executions === 1;
  if (!pass) failures += 1;
  console.log(
    ` ${c.mode.padEnd(19)} | ${String(r.executions).padStart(10)} | ${(pass ? "PASS" : "FAIL").padEnd(7)} | ${String(r.wallMs).padStart(7)} | ${r.clientSaw}`,
  );
}
console.log("\nExpectations:");
for (const c of BATTERY) console.log(` - ${c.mode}: ${c.expectation}`);
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} mode(s) double-executed`}`);
process.exit(failures === 0 ? 0 : 1);
