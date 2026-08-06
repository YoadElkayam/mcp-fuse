#!/usr/bin/env node
/**
 * mcp-fuse CLI.
 *
 *   mcp-fuse wrap [--config fuse.config.json] -- <server command...>
 *   mcp-fuse proxy --target <url> [--port <port>]     (M3, not yet implemented)
 */
import { readFileSync } from "node:fs";
import { DEFAULT_CIRCUIT_OPTIONS } from "@mcp-fuse/core";
import { StdioProxy } from "./stdio-proxy.js";

interface FuseConfig {
  defaults?: { maxAbsorptionMs?: number; maxAbsorptionWithProgressMs?: number };
  circuit?: { failureThreshold?: number; reopenAfterMs?: number };
  tools?: Record<string, { assumeIdempotent?: boolean }>;
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  mcp-fuse wrap [--config <file>] -- <server command...>",
      "  mcp-fuse proxy --target <url> [--port <port>]",
    ].join("\n"),
  );
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "wrap": {
    const sep = rest.indexOf("--");
    if (sep === -1 || sep === rest.length - 1) usage();
    const flags = rest.slice(0, sep);
    const serverCommand = rest.slice(sep + 1);

    let config: FuseConfig = {};
    const configIdx = flags.indexOf("--config");
    if (configIdx !== -1) {
      const file = flags[configIdx + 1];
      if (!file) usage();
      config = JSON.parse(readFileSync(file, "utf8")) as FuseConfig;
    }

    const proxy = new StdioProxy({
      command: serverCommand,
      maxAbsorptionMs: config.defaults?.maxAbsorptionMs,
      maxAbsorptionWithProgressMs: config.defaults?.maxAbsorptionWithProgressMs,
      circuit: config.circuit ? { ...DEFAULT_CIRCUIT_OPTIONS, ...config.circuit } : undefined,
      tools: config.tools,
    });
    proxy.start().catch((err) => {
      console.error("mcp-fuse: fatal:", err);
      process.exit(1);
    });
    break;
  }
  case "proxy": {
    console.error("mcp-fuse: HTTP proxy mode is not implemented yet (see docs/DESIGN.md M3)");
    process.exit(1);
    break;
  }
  default:
    usage();
}
