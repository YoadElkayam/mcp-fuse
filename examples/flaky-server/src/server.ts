#!/usr/bin/env node
/**
 * flaky-user-service — a deterministic, deliberately unreliable stdio MCP server.
 *
 * Usage:  node dist/server.js [scenario]     (or FLAKY_SCENARIO=<name>)
 * Env:    FLAKY_DOWN_MS      hard-down window override (default 30000)
 *         FLAKY_TELEMETRY    path to append JSONL telemetry records
 *
 * Tools:
 *   get_user_data       readOnlyHint+idempotentHint → eligible for full silent retry
 *   send_welcome_email  non-idempotent → demonstrates the idempotency gate: it
 *                       counts every execution, so a double-send is *visible*.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { makeScenarios, SCENARIO_NAMES, type ScenarioOutcome } from "./scenarios.js";

const scenarioName = process.env.FLAKY_SCENARIO ?? process.argv[2] ?? "rate-limit-storm";
const scenarios = makeScenarios({
  hardDownWindowMs: process.env.FLAKY_DOWN_MS ? Number(process.env.FLAKY_DOWN_MS) : undefined,
});
const scenario = scenarios[scenarioName];
if (!scenario) {
  console.error(
    `[flaky] unknown scenario "${scenarioName}" — expected one of: ${SCENARIO_NAMES.join(", ")}`,
  );
  process.exit(2);
}

const startedAt = Date.now();
let getUserDataCalls = 0;
let emailsSent = 0;

function telemetry(record: Record<string, unknown>): void {
  const line = { t: Date.now() - startedAt, scenario: scenarioName, ...record };
  console.error(`[flaky] ${JSON.stringify(line)}`);
  if (process.env.FLAKY_TELEMETRY) {
    appendFileSync(process.env.FLAKY_TELEMETRY, JSON.stringify(line) + "\n");
  }
}

function userData(userId: string): Record<string, unknown> {
  return {
    id: userId,
    name: "Ada Lovelace",
    email: "ada@example.com",
    plan: "starter",
    createdAt: "2025-11-02T09:14:00Z",
    lastSeenAt: "2026-08-05T21:47:12Z",
    preferences: { locale: "en-GB", timezone: "Europe/London", marketingOptIn: false },
  };
}

const server = new McpServer({ name: "flaky-user-service", version: "0.0.1" });

server.registerTool(
  "get_user_data",
  {
    description:
      "Fetch a user profile by id from the user service. (Deliberately unreliable — behavior is driven by the active failure scenario.)",
    inputSchema: { userId: z.string().describe('User id, e.g. "42"') },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ userId }) => {
    getUserDataCalls += 1;
    const call = getUserDataCalls;
    const outcome: ScenarioOutcome = scenario(call, Date.now() - startedAt);
    if (outcome.delayMs > 0) await sleep(outcome.delayMs);
    telemetry({
      tool: "get_user_data",
      call,
      outcome: outcome.kind,
      delayMs: outcome.delayMs,
      errorBytes: outcome.errorText ? Buffer.byteLength(outcome.errorText) : 0,
    });
    if (outcome.kind === "error") {
      return { isError: true, content: [{ type: "text", text: outcome.errorText! }] };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(userData(userId), null, 2) }],
    };
  },
);

server.registerTool(
  "send_welcome_email",
  {
    description:
      "Send the welcome email to a user. NOT idempotent: every execution sends another email. Used to demonstrate why silent retries must be gated on tool annotations.",
    inputSchema: { userId: z.string() },
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  async ({ userId }) => {
    emailsSent += 1;
    telemetry({ tool: "send_welcome_email", userId, totalEmailsSent: emailsSent });
    return {
      content: [
        {
          type: "text",
          text: `Welcome email sent to user ${userId}. (Total emails sent this session: ${emailsSent} — if this is >1 for the same request, something double-executed.)`,
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
console.error(
  `[flaky] flaky-user-service up | scenario="${scenarioName}" | tools: get_user_data (idempotent), send_welcome_email (non-idempotent)`,
);
