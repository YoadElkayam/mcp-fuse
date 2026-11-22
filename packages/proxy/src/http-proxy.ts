/**
 * HTTP shell around the FuseSession engine (DESIGN §4.1 mode 2): a Streamable
 * HTTP reverse proxy. Each incoming MCP session gets its own upstream Client
 * and mirrored Server; breakers, metrics, and annotation caches are shared
 * across sessions because they describe one upstream.
 *
 *   mcp-fuse proxy --target https://host/mcp --port 9090
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { type CircuitBreakerOptions } from "mcp-fuse-core";
import {
  FuseSession,
  PassthroughSchema,
  freshFuseState,
  type SharedFuseState,
  type ToolOverride,
} from "./engine.js";

export interface HttpProxyOptions {
  /** Upstream Streamable HTTP MCP endpoint, e.g. https://api.example.com/mcp */
  target: string;
  /** Listen port. 0 picks an ephemeral port. Default 9090. */
  port?: number;
  host?: string;
  /** Local path to serve. Default "/mcp". */
  path?: string;
  maxAbsorptionMs?: number;
  maxAbsorptionWithProgressMs?: number;
  circuit?: CircuitBreakerOptions;
  tools?: Record<string, ToolOverride>;
  verbose?: boolean;
  logFile?: string;
}

interface HttpSessionHandle {
  transport: StreamableHTTPServerTransport;
  server: Server;
  client: Client;
}

export class HttpProxy {
  private readonly state: SharedFuseState;
  private readonly sessions = new Map<string, HttpSessionHandle>();
  private httpServer: NodeHttpServer | undefined;
  private shuttingDown = false;

  constructor(private readonly options: HttpProxyOptions) {
    this.state = freshFuseState(options.circuit);
  }

  /** Resolves to the actual listen port. */
  async start(): Promise<number> {
    const path = this.options.path ?? "/mcp";
    this.httpServer = createServer((req, res) => {
      void this.handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    });
    const port = this.options.port ?? 9090;
    await new Promise<void>((resolve) => this.httpServer!.listen(port, this.options.host, resolve));
    const actual = (this.httpServer.address() as { port: number }).port;
    process.on("SIGINT", () => void this.shutdown());
    process.on("SIGTERM", () => void this.shutdown());
    console.error(
      `[mcp-fuse] http proxy on :${actual}${path} → ${this.options.target} | absorption budget ${this.options.maxAbsorptionMs ?? 5000}ms`,
    );
    return actual;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = this.options.path ?? "/mcp";
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (sid !== undefined) {
      const existing = this.sessions.get(sid);
      if (!existing) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unknown session" }, id: null }));
        return;
      }
      await existing.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    // New session: connect upstream first so we can mirror its identity.
    const handle = await this.createSession();
    await handle.transport.handleRequest(req, res);
  }

  private async createSession(): Promise<HttpSessionHandle> {
    const client = new Client({ name: "mcp-fuse", version: "0.4.0" });
    const session = new FuseSession(this.state, {
      absorbMs: this.options.maxAbsorptionMs ?? 5000,
      absorbProgressMs: this.options.maxAbsorptionWithProgressMs ?? 20_000,
      tools: this.options.tools,
      verbose: this.options.verbose,
      logFile: this.options.logFile,
    });

    let server: Server | undefined;
    client.fallbackNotificationHandler = async (notification) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (server as any)?.notification(notification);
      } catch {
        /* host gone */
      }
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async (notification) => {
      void session.refreshToolAnnotations();
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (server as any)?.notification(notification);
      } catch {
        /* drop */
      }
    });
    client.fallbackRequestHandler = (request) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server as any).request({ method: request.method, params: request.params }, PassthroughSchema);

    await client.connect(new StreamableHTTPClientTransport(new URL(this.options.target)));
    session.client = client;
    await session.refreshToolAnnotations();

    const info = client.getServerVersion() ?? { name: "mcp-fuse-wrapped", version: "0.0.0" };
    const capabilities = client.getServerCapabilities() ?? {};
    server = new Server(info, { capabilities, instructions: client.getInstructions() });
    server.fallbackRequestHandler = (request) =>
      session.clientRequest({ method: request.method, params: request.params });
    server.fallbackNotificationHandler = async (notification) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await client.notification(notification as any).catch(() => {});
    };
    server.setRequestHandler(ListToolsRequestSchema, async (req) => {
      const result = await session.clientRequest({ method: "tools/list", params: req.params });
      session.cacheToolAnnotations((result as { tools?: Tool[] }).tools);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return result as any;
    });
    server.setRequestHandler(CallToolRequestSchema, (req, extra) =>
      session.interceptToolCall(req.params, extra.sendNotification.bind(extra), extra.signal),
    );

    const handle: HttpSessionHandle = { transport: undefined as never, server, client };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSid) => {
        this.sessions.set(newSid, handle);
        session.log({ event: "http_session_opened", sid: newSid });
      },
    });
    handle.transport = transport;
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid !== undefined) this.sessions.delete(sid);
      void client.close().catch(() => {});
    };
    await server.connect(transport);
    return handle;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    console.error(this.state.metrics.summary());
    for (const handle of this.sessions.values()) {
      try {
        await handle.transport.close();
      } catch {
        /* gone */
      }
      try {
        await handle.client.close();
      } catch {
        /* gone */
      }
    }
    this.sessions.clear();
    // Idle keep-alive sockets would otherwise keep close() pending forever.
    this.httpServer?.closeAllConnections();
    await new Promise<void>((resolve) => this.httpServer?.close(() => resolve()) ?? resolve());
  }
}
