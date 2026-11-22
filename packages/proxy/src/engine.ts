/**
 * The transport-independent interception engine: breaker check → forward →
 * classify → idempotency gate → deadline-aware silent retries → reconciliation
 * → ONE semantic message. Owned by a transport shell (stdio child process, or
 * one HTTP session) that supplies the upstream Client and recovery hooks.
 *
 * Shared state (breakers, metrics, annotation caches) is injected so an HTTP
 * proxy can share it across sessions hitting the same upstream.
 */
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  McpError,
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

export const PassthroughSchema = z.object({}).passthrough();

export interface ToolOverride {
  /** Treat this tool as idempotent even without annotations (operator knows best). */
  assumeIdempotent?: boolean;
  /** Which read answers "did this land?" for this tool (SEP 4.3). Also readable
   * from the tool's own _meta["dev.mcp-fuse/reconcile"]. */
  reconcile?: ReconcileDeclaration;
}

/** State shared across sessions that face the same upstream server. */
export interface SharedFuseState {
  breakers: CircuitBreakerRegistry;
  metrics: FuseMetrics;
  toolIdempotency: Map<string, boolean>;
  toolReadOnly: Map<string, boolean>;
  toolMetaReconcile: Map<string, ReconcileDeclaration>;
}

export function freshFuseState(circuit?: CircuitBreakerOptions): SharedFuseState {
  return {
    breakers: new CircuitBreakerRegistry(circuit),
    metrics: new FuseMetrics(),
    toolIdempotency: new Map(),
    toolReadOnly: new Map(),
    toolMetaReconcile: new Map(),
  };
}

export interface FuseSessionOptions {
  absorbMs: number;
  absorbProgressMs: number;
  tools?: Record<string, ToolOverride>;
  verbose?: boolean;
  logFile?: string;
}

export interface TransportHooks {
  /** true while the upstream link is usable. */
  isAlive?: () => boolean;
  /** attempt to restore the upstream link (stdio child restart). */
  recover?: () => Promise<void>;
  isShuttingDown?: () => boolean;
}

interface Failure {
  policy: ErrorPolicy;
  rawText: string;
  thrownCode?: number;
  requestDelivered: boolean;
  ambiguous?: boolean;
}

export class FuseSession {
  /** Set by the owning shell; may be replaced on recovery. */
  client!: Client;

  constructor(
    readonly state: SharedFuseState,
    readonly opts: FuseSessionOptions,
    readonly hooks: TransportHooks = {},
  ) {}

  clientRequest(request: { method: string; params?: unknown }): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.client as any).request(request, PassthroughSchema);
  }

  async refreshToolAnnotations(): Promise<void> {
    try {
      let cursor: string | undefined;
      do {
        const res = await this.client.listTools({ cursor });
        this.cacheToolAnnotations(res.tools);
        cursor = res.nextCursor;
      } while (cursor);
    } catch {
      // upstream doesn't support tools/list — nothing to cache
    }
  }

  cacheToolAnnotations(tools: Tool[] | undefined): void {
    for (const tool of tools ?? []) {
      this.state.toolIdempotency.set(
        tool.name,
        tool.annotations?.readOnlyHint === true || tool.annotations?.idempotentHint === true,
      );
      this.state.toolReadOnly.set(tool.name, tool.annotations?.readOnlyHint === true);
      const meta = (tool as { _meta?: Record<string, unknown> })._meta?.["dev.mcp-fuse/reconcile"];
      if (meta && typeof meta === "object" && typeof (meta as ReconcileDeclaration).tool === "string") {
        this.state.toolMetaReconcile.set(tool.name, meta as ReconcileDeclaration);
      }
    }
  }

  private reconcileDeclFor(name: string): ReconcileDeclaration | undefined {
    return this.opts.tools?.[name]?.reconcile ?? this.state.toolMetaReconcile.get(name);
  }

  private isIdempotent(name: string): boolean {
    return this.opts.tools?.[name]?.assumeIdempotent ?? this.state.toolIdempotency.get(name) ?? false;
  }

  async interceptToolCall(
    params: { name: string; _meta?: { progressToken?: string | number }; [k: string]: unknown },
    sendNotification: (n: { method: string; params?: Record<string, unknown> }) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const name = params.name;
    const breaker = this.state.breakers.for(name);

    if (!breaker.allowRequest()) {
      return this.semanticResult(this.openCircuitPolicy(name, breaker.reopenInMs()));
    }

    const hostToken = params._meta?.progressToken;
    const budget = hostToken !== undefined ? this.opts.absorbProgressMs : this.opts.absorbMs;
    const deadline = Date.now() + budget;

    let attempt = 0;
    let lastAttemptMs = 200;
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
        if (this.hooks.isAlive?.() === false && this.hooks.isShuttingDown?.() !== true) {
          try {
            await this.hooks.recover?.();
          } catch {
            // upstream won't come back this attempt; classify below
          }
        }
        const code = e instanceof McpError ? e.code : undefined;
        const rawText = e instanceof Error ? e.message : String(e);
        // -32001 (timeout) and -32000 (connection closed) are the proxy's own
        // transport failures, not errors the upstream returned.
        const childProtocolError = code !== undefined && code !== -32001 && code !== -32000;
        // "Not connected" is thrown before the request is written: the only case
        // where we KNOW it never left.
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
        // Authoritative Retry-After beyond the budget becomes circuit cooldown.
        if (failure.policy.retry?.afterMs !== undefined) {
          breaker.forceCooldown(decision.delayMs);
          failure.policy = {
            ...failure.policy,
            circuit: { state: "open", reopenAfterMs: decision.delayMs },
          };
        }
        break;
      }

      this.state.metrics.recordAbsorbedRetry();
      if (this.opts.verbose) {
        console.error(
          `[mcp-fuse] ${name}: ${failure.policy.category} (attempt ${attempt}); retrying in ${decision.delayMs}ms`,
        );
      }
      this.log({ event: "absorbed_retry", tool: name, attempt, category: failure.policy.category, delayMs: decision.delayMs });
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

    // Ambiguous outcome with a declared reconciliation read (SEP 4.3).
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
      this.state.metrics.recordCircuitOpened();
      this.log({ event: "circuit_opened", tool: name });
    }
    this.state.metrics.recordSuppressedError(failure?.rawText ?? "");
    if (this.opts.verbose && failure) {
      console.error(
        `[mcp-fuse] ${name}: suppressed ${failure.policy.category} after ${attempt} attempt(s); raw error:\n${failure.rawText}`,
      );
    }
    this.log({ event: "suppressed_error", tool: name, attempts: attempt, category: failure?.policy.category, raw: failure?.rawText });

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

  private async runReconcile(
    params: { name: string; arguments?: Record<string, unknown>; [k: string]: unknown },
    decl: ReconcileDeclaration,
  ): Promise<{ verdict: ReconcileVerdict }> {
    if (this.state.toolReadOnly.get(decl.tool) !== true) {
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
      this.state.metrics.recordAbsorbedRetry();
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

  log(record: Record<string, unknown>): void {
    if (!this.opts.logFile) return;
    try {
      appendFileSync(this.opts.logFile, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n");
    } catch {
      // never let the audit log break the proxy
    }
  }
}

export function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "Tool call failed.";
  const parts = content
    .filter(
      (c): c is { type: "text"; text: string } =>
        typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
    )
    .map((c) => c.text);
  return parts.length > 0 ? parts.join("\n") : "Tool call failed.";
}
