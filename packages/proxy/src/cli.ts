#!/usr/bin/env node
/**
 * mcp-fuse CLI.
 *
 *   mcp-fuse init [--file <config>] [--dry-run] [--unwrap] [--fuse-config <file>]
 *   mcp-fuse wrap [--config fuse.config.json] [--verbose] [--log-file <file>] -- <server command...>
 *   mcp-fuse proxy --target <url> [--port <port>]     (M3, not yet implemented)
 */
import { readFileSync } from "node:fs";
import { DEFAULT_CIRCUIT_OPTIONS } from "mcp-fuse-core";
import { runInit } from "./init.js";
import { StdioProxy } from "./stdio-proxy.js";

interface FuseConfig {
  defaults?: { maxAbsorptionMs?: number; maxAbsorptionWithProgressMs?: number };
  circuit?: { failureThreshold?: number; reopenAfterMs?: number };
  tools?: Record<string, { assumeIdempotent?: boolean }>;
  log?: { file?: string; verbose?: boolean };
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  mcp-fuse init [--file <mcp-config>] [--dry-run] [--unwrap] [--fuse-config <file>]",
      "      Wrap every stdio server in your host's MCP config (Claude Code/Desktop, Cursor).",
      "  mcp-fuse wrap [--config <file>] [--verbose] [--log-file <file>] -- <server command...>",
      "      Run one MCP server behind the resilience proxy.",
      "  mcp-fuse proxy --target <url> [--port <port>]      (not yet implemented)",
    ].join("\n"),
  );
  process.exit(2);
}

function flagValue(flags: string[], name: string): string | undefined {
  const i = flags.indexOf(name);
  return i !== -1 ? flags[i + 1] : undefined;
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "init": {
    process.exit(
      runInit({
        file: flagValue(rest, "--file"),
        dryRun: rest.includes("--dry-run"),
        unwrap: rest.includes("--unwrap"),
        fuseConfig: flagValue(rest, "--fuse-config"),
      }),
    );
    break;
  }
  case "wrap": {
    const sep = rest.indexOf("--");
    if (sep === -1 || sep === rest.length - 1) usage();
    const flags = rest.slice(0, sep);
    const serverCommand = rest.slice(sep + 1);

    let config: FuseConfig = {};
    const configFile = flagValue(flags, "--config");
    if (configFile) config = JSON.parse(readFileSync(configFile, "utf8")) as FuseConfig;

    const proxy = new StdioProxy({
      command: serverCommand,
      maxAbsorptionMs: config.defaults?.maxAbsorptionMs,
      maxAbsorptionWithProgressMs: config.defaults?.maxAbsorptionWithProgressMs,
      circuit: config.circuit ? { ...DEFAULT_CIRCUIT_OPTIONS, ...config.circuit } : undefined,
      tools: config.tools,
      verbose: flags.includes("--verbose") || config.log?.verbose,
      logFile: flagValue(flags, "--log-file") ?? config.log?.file,
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
