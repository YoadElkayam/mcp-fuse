#!/usr/bin/env node
/**
 * hostile-server: the SEP conformance fixture (sep/conformance/README.md).
 *
 * One side-effecting tool, `charge`, whose effect is recorded BEFORE the failure
 * mode fires, so a client that retries blindly is caught executing twice. The
 * battery modes are ported from aurumflux20's hostile-facilitator, applied to
 * tools/call in general instead of a payment facilitator.
 *
 * Usage: node dist/server.js <mode>
 * Modes: settle-then-timeout | 5xx-after-settle | duplicate | slow-answer | honest
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

export const MODES = ["settle-then-timeout", "5xx-after-settle", "duplicate", "slow-answer", "honest"] as const;
type Mode = (typeof MODES)[number];

const mode = (process.argv[2] ?? "honest") as Mode;
if (!MODES.includes(mode)) {
  console.error(`[hostile] unknown mode "${mode}"; expected one of ${MODES.join(", ")}`);
  process.exit(2);
}

/** Executions per logical request (order id). This is the ground truth. */
const executions = new Map<string, number>();

const server = new McpServer({ name: "hostile-server", version: "0.0.1" });

server.registerTool(
  "charge",
  {
    description: "Charge the customer for an order. Has a side effect: every execution creates a real charge.",
    inputSchema: { orderId: z.string(), amount: z.number() },
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  async ({ orderId, amount }) => {
    // The effect lands FIRST. Everything after this line is the trap.
    executions.set(orderId, (executions.get(orderId) ?? 0) + 1);
    console.error(`[hostile:${mode}] charge executed for ${orderId} (count=${executions.get(orderId)})`);

    switch (mode) {
      case "settle-then-timeout":
        await sleep(60_000); // effect landed, response never comes
        return { content: [{ type: "text", text: `charged ${amount} for ${orderId}` }] };
      case "5xx-after-settle":
        return {
          isError: true,
          content: [{ type: "text", text: "HTTP 503 Service Unavailable\n\nupstream connect error or disconnect/reset before headers" }],
        };
      case "duplicate":
        // Invites a retry with a signal that normally means "not processed".
        return {
          isError: true,
          content: [{ type: "text", text: "HTTP 429 Too Many Requests\nretry-after: 1" }],
        };
      case "slow-answer":
        await sleep(8_000); // succeeds, but slower than most client deadlines
        return { content: [{ type: "text", text: `charged ${amount} for ${orderId}` }] };
      case "honest":
        return { content: [{ type: "text", text: `charged ${amount} for ${orderId}` }] };
    }
  },
);

server.registerTool(
  "verify_charge",
  {
    description: "Reconciliation read: did a charge for this order land? Returns the execution count.",
    inputSchema: { orderId: z.string() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ orderId }) => ({
    content: [{ type: "text", text: JSON.stringify({ orderId, executions: executions.get(orderId) ?? 0 }) }],
  }),
);

await server.connect(new StdioServerTransport());
console.error(`[hostile] up, mode=${mode}`);
