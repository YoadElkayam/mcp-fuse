/**
 * Stdio shell around the FuseSession engine (DESIGN §4.1/§4.2): spawns the real
 * server as a child, mirrors its identity to the host over stdio, and routes
 * tools/call through the interception engine. Child crash → reconnect on next
 * call. Everything not explicitly modeled passes through untouched.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ToolListChangedNotificationSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { type CircuitBreakerOptions } from "mcp-fuse-core";
import {
  FuseSession,
  PassthroughSchema,
  freshFuseState,
  type ToolOverride,
} from "./engine.js";

export type { ToolOverride } from "./engine.js";

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

export class StdioProxy {
  private server!: Server;
  private childAlive = false;
  private shuttingDown = false;
  private restartPromise: Promise<void> | undefined;
  private readonly session: FuseSession;

  constructor(private readonly options: StdioProxyOptions) {
    this.session = new FuseSession(
      freshFuseState(options.circuit),
      {
        absorbMs: options.maxAbsorptionMs ?? 5000,
        absorbProgressMs: options.maxAbsorptionWithProgressMs ?? 20_000,
        tools: options.tools,
        verbose: options.verbose,
        logFile: options.logFile,
      },
      {
        isAlive: () => this.childAlive,
        isShuttingDown: () => this.shuttingDown,
        recover: () => this.restartChild(),
      },
    );
  }

  async start(): Promise<void> {
    await this.connectChild();

    const client = this.session.client;
    const info = client.getServerVersion() ?? { name: "mcp-fuse-wrapped", version: "0.0.0" };
    const capabilities = client.getServerCapabilities() ?? {};
    this.server = new Server(info, { capabilities, instructions: client.getInstructions() });

    // Generic passthrough for everything we don't model, in both directions.
    this.server.fallbackRequestHandler = (request) =>
      this.session.clientRequest({ method: request.method, params: request.params });
    this.server.fallbackNotificationHandler = async (notification) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.session.client.notification(notification as any).catch(() => {});
    };

    this.server.setRequestHandler(ListToolsRequestSchema, async (req) => {
      const result = await this.session.clientRequest({ method: "tools/list", params: req.params });
      this.session.cacheToolAnnotations((result as { tools?: Tool[] }).tools);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return result as any;
    });

    this.server.setRequestHandler(CallToolRequestSchema, (req, extra) =>
      this.session.interceptToolCall(req.params, extra.sendNotification.bind(extra), extra.signal),
    );

    this.server.onclose = () => void this.shutdown(0);
    process.on("SIGINT", () => void this.shutdown(0));
    process.on("SIGTERM", () => void this.shutdown(0));

    await this.server.connect(new StdioServerTransport());
    console.error(
      `[mcp-fuse] wrapping "${this.options.command.join(" ")}" (${info.name} ${info.version}) | absorption budget ${this.session.opts.absorbMs}ms (${this.session.opts.absorbProgressMs}ms with progressToken)`,
    );
  }

  private async connectChild(): Promise<void> {
    const [cmd, ...args] = this.options.command;
    // Full env inheritance: the host set API keys etc. on OUR process intending
    // them for the real server.
    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    );
    const transport = new StdioClientTransport({ command: cmd, args, env, stderr: "inherit" });
    const client = new Client({ name: "mcp-fuse", version: "0.4.0" });

    client.fallbackNotificationHandler = async (notification) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (this.server as any)?.notification(notification);
      } catch {
        /* server not connected yet, or host gone */
      }
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async (notification) => {
      void this.session.refreshToolAnnotations();
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (this.server as any)?.notification(notification);
      } catch {
        /* drop */
      }
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
        this.session.log({ event: "child_closed" });
      }
    };
    this.session.client = client;
    this.childAlive = true;
    await this.session.refreshToolAnnotations();
  }

  private restartChild(): Promise<void> {
    this.restartPromise ??= this.connectChild().finally(() => {
      this.restartPromise = undefined;
    });
    return this.restartPromise;
  }

  private async shutdown(code: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    console.error(this.session.state.metrics.summary());
    try {
      await this.session.client?.close();
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
