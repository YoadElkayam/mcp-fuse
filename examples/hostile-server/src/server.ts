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
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

export const MODES = [
  "settle-then-timeout",
  "5xx-after-settle",
  "duplicate",
  "slow-answer",
  "verify-unavailable",
  "retry-original-key",
  "distinct-operation-key",
  "declared-safe",
  "honest",
] as const;
type Mode = (typeof MODES)[number];

const mode = (process.argv[2] ?? "honest") as Mode;
if (!MODES.includes(mode)) {
  console.error(`[hostile] unknown mode "${mode}"; expected one of ${MODES.join(", ")}`);
  process.exit(2);
}

interface LedgerState {
  executions: Record<string, number>;
  keyedOrderIds: Record<string, string>;
  keyedAttempts: Record<string, number>;
  safeAttempts: number;
}

const statePathEnv = "HOSTILE_SERVER_STATE_PATH";
const stateFile = process.env[statePathEnv];

function emptyState(): LedgerState {
  return {
    executions: {},
    keyedOrderIds: {},
    keyedAttempts: {},
    safeAttempts: 0,
  };
}

function loadState(): LedgerState {
  if (stateFile === undefined || !existsSync(stateFile)) return emptyState();

  const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as Partial<LedgerState>;
  return {
    executions: parsed.executions ?? {},
    keyedOrderIds: parsed.keyedOrderIds ?? {},
    keyedAttempts: parsed.keyedAttempts ?? {},
    safeAttempts: parsed.safeAttempts ?? 0,
  };
}

const initialState = loadState();

/** Executions per logical request (order id). This is the ground truth. */
const executions = new Map<string, number>(Object.entries(initialState.executions));
const keyedOrderIds = new Map<string, string>(Object.entries(initialState.keyedOrderIds));
const keyedAttempts = new Map<string, number>(Object.entries(initialState.keyedAttempts));

function persistState(): void {
  if (stateFile === undefined) return;

  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    `${JSON.stringify({
      executions: Object.fromEntries(executions),
      keyedOrderIds: Object.fromEntries(keyedOrderIds),
      keyedAttempts: Object.fromEntries(keyedAttempts),
      safeAttempts,
    } satisfies LedgerState)}\n`,
  );
}

const server = new McpServer({ name: "hostile-server", version: "0.0.1" });

function recordKeyedCharge(orderId: string, idempotencyKey: string): {
  attempts: number;
  effectApplied: boolean;
  originalOrderId: string;
} {
  const attempts = (keyedAttempts.get(idempotencyKey) ?? 0) + 1;
  keyedAttempts.set(idempotencyKey, attempts);

  const originalOrderId = keyedOrderIds.get(idempotencyKey);
  if (originalOrderId !== undefined) {
    persistState();
    return { attempts, effectApplied: false, originalOrderId };
  }

  keyedOrderIds.set(idempotencyKey, orderId);
  executions.set(orderId, (executions.get(orderId) ?? 0) + 1);
  persistState();
  return { attempts, effectApplied: true, originalOrderId: orderId };
}

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
    persistState();
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
      case "verify-unavailable":
        // Effect landed, response ambiguous, AND the reconciliation read will fail too.
        return {
          isError: true,
          content: [{ type: "text", text: "ETIMEDOUT: upstream timed out after 30000ms; state unknown" }],
        };
      case "slow-answer":
        await sleep(8_000); // succeeds, but slower than most client deadlines
        return { content: [{ type: "text", text: `charged ${amount} for ${orderId}` }] };
      case "retry-original-key":
      case "distinct-operation-key":
      case "declared-safe":
      case "honest":
        return { content: [{ type: "text", text: `charged ${amount} for ${orderId}` }] };
    }
  },
);

let safeAttempts = initialState.safeAttempts;
server.registerTool(
  "charge_safe",
  {
    description: "Charge with server-side dedup by orderId. Declared safe to replay; replays are expected.",
    inputSchema: { orderId: z.string(), amount: z.number() },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  async ({ orderId, amount }) => {
    safeAttempts += 1;
    if (!executions.has(orderId)) executions.set(orderId, 1); // dedup: effect at most once
    persistState();
    console.error(`[hostile:${mode}] charge_safe attempt ${safeAttempts} for ${orderId}`);
    if (safeAttempts === 1) {
      // First attempt fails transiently; a correct client replays because the tool declares safety.
      return { isError: true, content: [{ type: "text", text: "HTTP 503 Service Unavailable" }] };
    }
    return { content: [{ type: "text", text: `charged ${amount} for ${orderId} (attempt ${safeAttempts})` }] };
  },
);

server.registerTool(
  "charge_attempts_safe",
  {
    description: "How many times charge_safe was invoked (attempts, not effects).",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async () => ({ content: [{ type: "text", text: String(safeAttempts) }] }),
);

server.registerTool(
  "charge_with_key",
  {
    description: "Charge with a caller-supplied idempotency key. Replays with the same key dedupe; distinct operations need distinct keys.",
    inputSchema: { orderId: z.string(), amount: z.number(), idempotencyKey: z.string() },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  async ({ orderId, amount, idempotencyKey }) => {
    const keyed = recordKeyedCharge(orderId, idempotencyKey);
    console.error(
      `[hostile:${mode}] charge_with_key attempt ${keyed.attempts} for ${orderId} key=${idempotencyKey} (effect=${keyed.effectApplied ? "yes" : "dedup"})`,
    );

    if (mode === "retry-original-key" && keyed.attempts === 1) {
      // The side effect has landed and the ledger has been persisted; close the
      // child before any tool result is sent so the client observes response loss.
      process.exit(0);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            orderId,
            amount,
            idempotencyKey,
            attempts: keyed.attempts,
            effectApplied: keyed.effectApplied,
            executions: executions.get(orderId) ?? 0,
            originalOrderId: keyed.originalOrderId,
          }),
        },
      ],
    };
  },
);

server.registerTool(
  "verify_charge",
  {
    description: "Reconciliation read: did a charge for this order land? Returns the execution count.",
    inputSchema: { orderId: z.string() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ orderId }) => {
    if (mode === "verify-unavailable") {
      // The recursive case: the read that answers "did this land?" is itself down.
      return { isError: true, content: [{ type: "text", text: "HTTP 503 Service Unavailable: ledger shard offline" }] };
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ orderId, executions: executions.get(orderId) ?? 0 }) }],
    };
  },
);

server.registerTool(
  "ground_truth_key",
  {
    description: "Test-harness backdoor: true keyed-attempt state for one idempotency key.",
    inputSchema: { idempotencyKey: z.string() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ idempotencyKey }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          idempotencyKey,
          attempts: keyedAttempts.get(idempotencyKey) ?? 0,
          orderId: keyedOrderIds.get(idempotencyKey) ?? null,
        }),
      },
    ],
  }),
);

server.registerTool(
  "ground_truth",
  {
    description: "Test-harness backdoor: true execution count regardless of mode.",
    inputSchema: { orderId: z.string() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ orderId }) => ({
    content: [{ type: "text", text: String(executions.get(orderId) ?? 0) }],
  }),
);

await server.connect(new StdioServerTransport());
console.error(`[hostile] up, mode=${mode}`);
