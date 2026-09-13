/**
 * Stdio man-in-the-middle (DESIGN §4.1/§4.2, Phase 2).
 *
 * Built as an SDK pair: an SDK `Client` connected to the real (child) server, and
 * an SDK `Server` facing the host on stdin/stdout, mirroring the child's identity
 * and capabilities. The SDK owns framing, backpressure, and the initialize
 * handshake; this class owns the interception pipeline:
 *
 *   breaker check → forward → classify failure → idempotency gate →
 *   deadline-aware silent retries within the absorption budget →
 *   ONE semantic error (agentGuidance + MEP payload) when policy is exhausted.
 *
 * Everything not explicitly modeled (resources, prompts, sampling, elicitation,
 * future methods) flows through generic fallback handlers in both directions.
 *
 * Known MVP limitation: the child is initialized with mcp-fuse's own client info
 * and no client capabilities, because the child must be connected before the
 * host's initialize arrives (we mirror child→host, not host→child).
 */
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  McpError,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  CircuitBreakerRegistry,
  ERROR_POLICY_META_KEY,
  FuseMetrics,
  NON_IDEMPOTENT_GUIDANCE,
  classify,
  interpretEffectCount,
  nextRetry,
  silentRetryAllowed,
  type CircuitBreakerOptions,
  type ErrorPolicy,
  type ReconcileDeclaration,
  type ReconcileVerdict,
} from "mcp-fuse-core";

const PassthroughSchema = z.object({}).passthrough();

export interface ToolOverride {
  /** Treat this tool as idempotent even without annotations (operator knows best). */
  assumeIdempotent?: boolean;
  /** Which read answers "did this land?" for this tool (SEP 4.3). Also readable
   * from the tool's own _meta["dev.mcp-fuse/reconcile"]. */
  reconcile?: ReconcileDeclaration;
}

export interface StdioProxyOptions {
  /** The real server command, e.g. ["node", "./my-mcp-server.js"]. */
  command: string[];
  /** Silent-retry budget per call without a progressToken. Default 5000. */
  maxAbsorptionMs?: number;
  /** Budget when the host sent a progressToken (keepalive extends it). Default 20000. */
  maxAbsorptionWithProgressMs?: number;
  circuit?: CircuitBreakerOptions;
  tools?: Record<string, ToolOverride>;
  /** Print suppressed raw errors and retry activity to stderr. */
  verbose?: boolean;
  /** Append a JSONL record for every suppressed error / absorbed retry / circuit
   * event. Nothing the fuse hides is ever unrecoverable — this is the audit log. */
  logFile?: string;
}

interface Failure {
  policy: ErrorPolicy;
  rawText: string;
  /** Set when the failure was a thrown JSON-RPC error rather than an isError result. */
  thrownCode?: number;
  /** false only when the request provably never reached the child (pre-send). */
  requestDelivered: boolean;
  /** The effect may have happened: a retryable-class failure on a delivered
   * request against a tool the gate refuses to replay. Reconciliation territory. */
  ambiguous?: boolean;
}

export class StdioProxy {
  private client!: Client;
  private server!: Server;
  private childAlive = false;
  private shuttingDown = false;
  private restartPromise: Promise<void> | undefined;
  private readonly toolIdempotency = new Map<string, boolean>();
  private readonly toolReadOnly = new Map<string, boolean>();
  private readonly toolMetaReconcile = new Map<string, ReconcileDeclaration>();
  private readonly breakers: CircuitBreakerRegistry;
  private readonly metrics = new FuseMetrics();
  private readonly absorbMs: number;
  private readonly absorbProgressMs: number;

  constructor(private readonly options: StdioProxyOptions) {
    this.absorbMs = options.maxAbsorptionMs ?? 5000;
    this.absorbProgressMs = options.maxAbsorptionWithProgressMs ?? 20_000;
    this.breakers = new CircuitBreakerRegistry(options.circuit);
  }

  async start(): Promise<void> {
    await this.connectChild();

    const info = this.client.getServerVersion() ?? { name: "mcp-fuse-wrapped", version: "0.0.0" };
    const capabilities = this.client.getServerCapabilities() ?? {};
    this.server = new Server(info, {
      capabilities,
      instructions: this.client.getInstructions(),
    });

    // Generic passthrough for everything we don't model, in both directions.
    this.server.fallbackRequestHandler = (request) =>
      this.clientRequest({ method: request.method, params: request.params });
    this.server.fallbackNotificationHandler = async (notification) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.client.notification(notification as any).catch(() => {});
    };

    this.server.setRequestHandler(ListToolsRequestSchema, async (req) => {
      const result = await this.clientRequest({ method: "tools/list", params: req.params });
      this.cacheToolAnnotations((result as { tools?: Tool[] }).tools);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return result as any;
    });

    this.server.setRequestHandler(CallToolRequestSchema, (req, extra) =>
      this.interceptToolCall(req.params, extra.sendNotification.bind(extra), extra.signal),
    );

    this.server.onclose = () => void this.shutdown(0);
    process.on("SIGINT", () => void this.shutdown(0));
    process.on("SIGTERM", () => void this.shutdown(0));

    await this.server.connect(new StdioServerTransport());
    console.error(
      `[mcp-fuse] wrapping "${this.options.command.join(" ")}" (${info.name} ${info.version}) | absorption budget ${this.absorbMs}ms (${this.absorbProgressMs}ms with progressToken)`,
    );
  }

  // ---------------------------------------------------------------- child link

  private async connectChild(): Promise<void> {
    const [cmd, ...args] = this.options.command;
    // Full env inheritance: the host set API keys etc. on OUR process intending
    // them for the real server — the SDK's default minimal child env would strip
    // them and break wrapped servers in confusing ways.
    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    );
    const transport = new StdioClientTransport({ command: cmd, args, env, stderr: "inherit" });
    const client = new Client({ name: "mcp-fuse", version: "0.1.0" });

    client.fallbackNotificationHandler = async (notification) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.serverNotification(notification as any);
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async (notification) => {
      void this.refreshToolAnnotations();
      await this.serverNotification(notification);
    });
    // Server→client requests (sampling, elicitation, roots) forward to the host.
    client.fallbackRequestHandler = (request) => {
      if (!this.server) throw new McpError(-32601, `Method not available: ${request.method}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (this.server as any).request({ method: request.method, params: request.params }, PassthroughSchema);
    };

    await client.connect(transport);
    client.onclose = () => {
      this.childAlive = false;
      if (!this.shuttingDown) {
        console.error("[mcp-fuse] child server connection closed; will attempt restart on next tool call");
        this.log({ event: "child_closed" });
      }
    };
    this.client = client;
    this.childAlive = true;
    await this.refreshToolAnnotations();
  }

  private restartChild(): Promise<void> {
    this.restartPromise ??= this.connectChild().finally(() => {
      this.restartPromise = undefined;
    });
    return this.restartPromise;
  }

  private clientRequest(request: { method: string; params?: unknown }): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.client as any).request(request, PassthroughSchema);
  }

  private async serverNotification(notification: { method: string; params?: unknown }): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.server as any)?.notification(notification);
    } catch {
      // server not connected yet, or host went away — drop
    }
  }

  // ------------------------------------------------------------- annotations

  private async refreshToolAnnotations(): Promise<void> {
    try {
      let cursor: string | undefined;
      do {
        const res = await this.client.listTools({ cursor });
        this.cacheToolAnnotations(res.tools);
        cursor = res.nextCursor;
      } while (cursor);
    } catch {
      // child doesn't support tools/list — nothing to cache
    }
  }

  private cacheToolAnnotations(tools: Tool[] | undefined): void {
    for (const tool of tools ?? []) {
      this.toolIdempotency.set(
        tool.name,
        tool.annotations?.readOnlyHint === true || tool.annotations?.idempotentHint === true,
      );
      this.toolReadOnly.set(tool.name, tool.annotations?.readOnlyHint === true);
      const meta = (tool as { _meta?: Record<string, unknown> })._meta?.["dev.mcp-fuse/reconcile"];
      if (meta && typeof meta === "object" && typeof (meta as ReconcileDeclaration).tool === "string") {
        this.toolMetaReconcile.set(tool.name, meta as ReconcileDeclaration);
      }
    }
  }

  private reconcileDeclFor(name: string): ReconcileDeclaration | undefined {
    return this.options.tools?.[name]?.reconcile ?? this.toolMetaReconcile.get(name);
  }

  private isIdempotent(name: string): boolean {
    return this.options.tools?.[name]?.assumeIdempotent ?? this.toolIdempotency.get(name) ?? false;
  }

  // ------------------------------------------------------------ interception

  private async interceptToolCall(
    params: { name: string; _meta?: { progressToken?: string | number }; [k: string]: unknown },
    sendNotification: (n: { method: string; params?: Record<string, unknown> }) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const name = params.name;
    const breaker = this.breakers.for(name);

    if (!breaker.allowRequest()) {
      return this.semanticResult(this.openCircuitPolicy(name, breaker.reopenInMs()));
    }

    const hostToken = params._meta?.progressToken;
    const budget = hostToken !== undefined ? this.absorbProgressMs : this.absorbMs;
    const deadline = Date.now() + budget;

    let attempt = 0;
    let lastAttemptMs = 200; // estimate for deadline math, refined per attempt
    let failure: Failure | undefined;

    for (;;) {
      attempt += 1;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal?.aborted) break;
      const t0 = Date.now();
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (this.client as any).request(
          { method: "tools/call", params },
          CallToolResultSchema,
          {
            timeout: Math.max(remaining, 1),
            resetTimeoutOnProgress: true,
            signal,
            onprogress:
              hostToken !== undefined
                ? (p: Record<string, unknown>) =>
                    void sendNotification({
                      method: "notifications/progress",
                      params: { ...p, progressToken: hostToken },
                    }).catch(() => {})
                : undefined,
          },
        );
        lastAttemptMs = Date.now() - t0;
        if (result.isError !== true) {
          breaker.recordSuccess();
          return result;
        }
        const rawText = extractText(result.content);
        failure = { policy: classify({ message: rawText, isToolResult: true }), rawText, requestDelivered: true };
      } catch (e) {
        lastAttemptMs = Date.now() - t0;
        if (!this.childAlive && !this.shuttingDown) {
          try {
            await this.restartChild();
          } catch {
            // child won't come back this attempt; classify below
          }
        }
        const code = e instanceof McpError ? e.code : undefined;
        const rawText = e instanceof Error ? e.message : String(e);
        // -32001 (timeout) and -32000 (connection closed) are the proxy's own
        // transport failures, not errors the child returned; surface those as a
        // semantic tool result rather than re-throwing a protocol error.
        const childProtocolError = code !== undefined && code !== -32001 && code !== -32000;
        // The SDK throws "Not connected" synchronously when the transport is down
        // before the request is written: the only case where we KNOW it never left.
        const requestDelivered = !/not connected/i.test(rawText);
        failure = {
          policy: classify({ jsonrpcCode: code, message: rawText }),
          rawText,
          thrownCode: childProtocolError ? code : undefined,
          requestDelivered,
        };
      }

      const idempotent = this.isIdempotent(name);
      if (!silentRetryAllowed(failure.policy, idempotent, { requestDelivered: failure.requestDelivered })) {
        if (failure.policy.retryable && !idempotent) {
          failure.ambiguous = true;
          failure.policy = {
            ...failure.policy,
            retryable: false,
            agentGuidance: NON_IDEMPOTENT_GUIDANCE,
          };
        }
        break;
      }

      const decision = nextRetry(failure.policy.retry, attempt);
      if (!decision.retry) break;

      if (Date.now() + decision.delayMs + lastAttemptMs > deadline) {
        // Authoritative Retry-After beyond the budget: convert the wait into
        // circuit cooldown so repeat calls fail fast instead of hanging.
        if (failure.policy.retry?.afterMs !== undefined) {
          breaker.forceCooldown(decision.delayMs);
          failure.policy = {
            ...failure.policy,
            circuit: { state: "open", reopenAfterMs: decision.delayMs },
          };
        }
        break;
      }

      this.metrics.recordAbsorbedRetry();
      if (this.options.verbose) {
        console.error(
          `[mcp-fuse] ${name}: ${failure.policy.category} (attempt ${attempt}); retrying in ${decision.delayMs}ms`,
        );
      }
      this.log({
        event: "absorbed_retry",
        tool: name,
        attempt,
        category: failure.policy.category,
        delayMs: decision.delayMs,
      });
      if (hostToken !== undefined) {
        void sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: hostToken,
            progress: attempt,
            message: `mcp-fuse: upstream ${failure.policy.category}; retrying (attempt ${attempt + 1})`,
          },
        }).catch(() => {});
      }
      await sleep(decision.delayMs);
    }

    // Ambiguous outcome on a tool with a declared reconciliation read (SEP 4.3):
    // ask whether the effect happened before deciding anything.
    if (failure?.ambiguous) {
      const decl = this.reconcileDeclFor(name);
      if (decl) {
        const outcome = await this.runReconcile(params, decl);
        failure.policy = { ...failure.policy, reconcile: { tool: decl.tool, verdict: outcome.verdict } };
        this.log({ event: "reconcile", tool: name, via: decl.tool, verdict: outcome.verdict });
        if (outcome.verdict === "found_once") {
          breaker.recordSuccess();
          return {
            content: [
              {
                type: "text",
                text:
                  `Verified: the operation already completed exactly once (checked via ${decl.tool} after the response was lost). ` +
                  `Do not re-invoke it. The original output was lost; use a read tool if you need the resulting state.`,
              },
            ],
            _meta: { [ERROR_POLICY_META_KEY]: failure.policy },
          };
        }
        if (outcome.verdict === "authoritatively_absent") {
          const replay = await this.replayOnce(params);
          if (replay) {
            breaker.recordSuccess();
            return replay;
          }
          failure.policy = {
            ...failure.policy,
            agentGuidance:
              `The operation verifiably did not take effect (checked via ${decl.tool}), but the replay also failed ambiguously. ` +
              `Do not re-invoke; verify with ${decl.tool} before any further attempt.`,
          };
        } else if (outcome.verdict === "found_multiple") {
          failure.policy = {
            ...failure.policy,
            agentGuidance:
              `The operation appears to have executed MORE THAN ONCE (checked via ${decl.tool}). ` +
              `Do not retry. Surface this to the user for manual review.`,
          };
        } else {
          failure.policy = {
            ...failure.policy,
            agentGuidance:
              `${NON_IDEMPOTENT_GUIDANCE} An automatic verification attempt via ${decl.tool} could not determine the outcome; treat it as unknown, never as "did not happen".`,
          };
        }
      }
    }

    // Terminal failure: one semantic message, raw payload suppressed.
    const stateBefore = breaker.state();
    const stateAfter = breaker.recordFailure();
    if (stateAfter === "open" && stateBefore !== "open") {
      this.metrics.recordCircuitOpened();
      this.log({ event: "circuit_opened", tool: name });
    }
    this.metrics.recordSuppressedError(failure?.rawText ?? "");
    if (this.options.verbose && failure) {
      console.error(
        `[mcp-fuse] ${name}: suppressed ${failure.policy.category} after ${attempt} attempt(s); raw error:\n${failure.rawText}`,
      );
    }
    this.log({
      event: "suppressed_error",
      tool: name,
      attempts: attempt,
      category: failure?.policy.category,
      raw: failure?.rawText,
    });

    const policy = failure?.policy ?? {
      version: "1" as const,
      category: "unknown" as const,
      retryable: false,
      agentGuidance: "This tool call failed. Do not retry; use an alternative approach or inform the user.",
    };
    if (failure?.thrownCode !== undefined) {
      throw new McpError(failure.thrownCode, policy.agentGuidance ?? "Tool call failed.", {
        [ERROR_POLICY_META_KEY]: policy,
      });
    }
    return this.semanticResult(policy);
  }

  /** Run the declared reconciliation read. Anything unclean is could_not_determine:
   * a failed read is never evidence of absence. */
  private async runReconcile(
    params: { name: string; arguments?: Record<string, unknown>; [k: string]: unknown },
    decl: ReconcileDeclaration,
  ): Promise<{ verdict: ReconcileVerdict }> {
    if (this.toolReadOnly.get(decl.tool) !== true) {
      // SEP security rule: only reads declared read-only may be run automatically.
      return { verdict: "could_not_determine" };
    }
    const args: Record<string, unknown> = {};
    for (const [targetArg, sourceArg] of Object.entries(decl.args ?? {})) {
      args[targetArg] = params.arguments?.[sourceArg];
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = (await (this.client as any).request(
        { method: "tools/call", params: { name: decl.tool, arguments: args } },
        CallToolResultSchema,
        { timeout: 4000 },
      )) as CallToolResult;
      if (res.isError === true) return { verdict: "could_not_determine" };
      const parsed: unknown = JSON.parse(extractText(res.content));
      return { verdict: interpretEffectCount((parsed as Record<string, unknown>)?.[decl.countField]) };
    } catch {
      return { verdict: "could_not_determine" };
    }
  }

  /** One replay after an authoritatively-absent verdict. Success returns the
   * capped result; any failure returns undefined (the caller holds). */
  private async replayOnce(params: {
    name: string;
    arguments?: Record<string, unknown>;
    [k: string]: unknown;
  }): Promise<CallToolResult | undefined> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await (this.client as any).request(
        { method: "tools/call", params },
        CallToolResultSchema,
        { timeout: 5000 },
      )) as CallToolResult;
      if (result.isError === true) return undefined;
      this.metrics.recordAbsorbedRetry();
      return result;
    } catch {
      return undefined;
    }
  }

  private openCircuitPolicy(name: string, reopenInMs: number): ErrorPolicy {
    const seconds = Math.max(1, Math.ceil(reopenInMs / 1000));
    return {
      version: "1",
      category: "transient",
      retryable: false,
      circuit: { state: "open", reopenAfterMs: reopenInMs },
      agentGuidance: `Tool "${name}" is unavailable (circuit open for ~${seconds}s after repeated failures). Do not retry; use an alternative approach or inform the user.`,
    };
  }

  private semanticResult(policy: ErrorPolicy): CallToolResult {
    return {
      content: [{ type: "text", text: policy.agentGuidance ?? "Tool call failed." }],
      isError: true,
      _meta: { [ERROR_POLICY_META_KEY]: policy },
    };
  }

  // ----------------------------------------------------------------- logging

  private log(record: Record<string, unknown>): void {
    if (!this.options.logFile) return;
    try {
      appendFileSync(
        this.options.logFile,
        JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n",
      );
    } catch {
      // never let the audit log break the proxy
    }
  }

  // ---------------------------------------------------------------- shutdown

  private async shutdown(code: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    console.error(this.metrics.summary());
    try {
      await this.client?.close();
    } catch {
      /* already gone */
    }
    try {
      await this.server?.close();
    } catch {
      /* already gone */
    }
    process.exit(code);
  }
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "Tool call failed.";
  const parts = content
    .filter(
      (c): c is { type: "text"; text: string } =>
        typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
    )
    .map((c) => c.text);
  return parts.length > 0 ? parts.join("\n") : "Tool call failed.";
}
