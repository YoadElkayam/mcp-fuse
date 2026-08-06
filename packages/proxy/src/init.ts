/**
 * `mcp-fuse init` — one command to protect every MCP server a host has configured.
 *
 * Discovers the host's MCP config file(s), rewrites each stdio server entry to run
 * through `mcp-fuse wrap`, and writes a backup next to the original. `--unwrap`
 * reverses the transformation.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [k: string]: unknown;
}

export interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [k: string]: unknown;
}

/** How to invoke mcp-fuse from a host config. */
export interface Launcher {
  command: string;
  prefixArgs: string[]; // everything before "--", e.g. ["-y", "mcp-fuse", "wrap"]
}

/** npx form when running from an installed package; absolute node+cli.js path
 * when running from a repo checkout (works before npm publish). */
export function detectLauncher(): Launcher {
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  if (cliPath.includes(`${path.sep}node_modules${path.sep}`)) {
    return { command: "npx", prefixArgs: ["-y", "mcp-fuse", "wrap"] };
  }
  return { command: process.execPath, prefixArgs: [cliPath, "wrap"] };
}

export function isWrapped(entry: McpServerEntry): boolean {
  const args = entry.args ?? [];
  return args.includes("wrap") && args.some((a) => a.includes("mcp-fuse"));
}

export function wrapEntry(
  entry: McpServerEntry,
  launcher: Launcher,
  wrapArgs: string[] = [],
): McpServerEntry {
  return {
    ...entry,
    command: launcher.command,
    args: [...launcher.prefixArgs, ...wrapArgs, "--", entry.command!, ...(entry.args ?? [])],
  };
}

export function unwrapEntry(entry: McpServerEntry): McpServerEntry {
  const args = entry.args ?? [];
  const sep = args.indexOf("--");
  if (sep === -1 || sep === args.length - 1) return entry;
  return { ...entry, command: args[sep + 1], args: args.slice(sep + 2) };
}

export interface TransformReport {
  config: McpConfig;
  changed: string[];
  skipped: Array<{ name: string; reason: string }>;
}

export function transformConfig(
  config: McpConfig,
  launcher: Launcher,
  options: { unwrap?: boolean; wrapArgs?: string[] } = {},
): TransformReport {
  const changed: string[] = [];
  const skipped: TransformReport["skipped"] = [];
  const servers: Record<string, McpServerEntry> = {};

  for (const [name, entry] of Object.entries(config.mcpServers ?? {})) {
    if (options.unwrap) {
      if (isWrapped(entry)) {
        servers[name] = unwrapEntry(entry);
        changed.push(name);
      } else {
        servers[name] = entry;
        skipped.push({ name, reason: "not wrapped" });
      }
      continue;
    }
    if (!entry.command) {
      servers[name] = entry;
      skipped.push({ name, reason: "no command (HTTP/SSE server — M3)" });
    } else if (isWrapped(entry)) {
      servers[name] = entry;
      skipped.push({ name, reason: "already wrapped" });
    } else {
      servers[name] = wrapEntry(entry, launcher, options.wrapArgs);
      changed.push(name);
    }
  }
  return { config: { ...config, mcpServers: servers }, changed, skipped };
}

export interface ConfigLocation {
  host: string;
  file: string;
}

export function discoverConfigs(cwd = process.cwd(), home = homedir()): ConfigLocation[] {
  const candidates: ConfigLocation[] = [
    { host: "Claude Code (project)", file: path.join(cwd, ".mcp.json") },
    { host: "Cursor", file: path.join(home, ".cursor", "mcp.json") },
  ];
  if (process.platform === "darwin") {
    candidates.push({
      host: "Claude Desktop",
      file: path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    });
  } else if (process.platform === "win32" && process.env.APPDATA) {
    candidates.push({
      host: "Claude Desktop",
      file: path.join(process.env.APPDATA, "Claude", "claude_desktop_config.json"),
    });
  }
  return candidates.filter((c) => existsSync(c.file));
}

export interface InitFlags {
  file?: string;
  dryRun?: boolean;
  unwrap?: boolean;
  /** Path to a fuse.config.json to bake into every wrapped entry. */
  fuseConfig?: string;
  /** Process every discovered config, not just the nearest one. */
  all?: boolean;
}

/**
 * Least-surprise scoping: a project config in cwd wins; global host configs are
 * only touched with --all (or --file). Never silently modify a global config
 * while the user is thinking about their project.
 */
export function selectLocations(discovered: ConfigLocation[], all: boolean): {
  selected: ConfigLocation[];
  deferred: ConfigLocation[];
} {
  if (all || discovered.length <= 1) return { selected: discovered, deferred: [] };
  const project = discovered.filter((c) => c.host.includes("project"));
  if (project.length > 0) {
    return { selected: project, deferred: discovered.filter((c) => !c.host.includes("project")) };
  }
  return { selected: [discovered[0]], deferred: discovered.slice(1) };
}

export function runInit(flags: InitFlags): number {
  const { selected: locations, deferred } = flags.file
    ? { selected: [{ host: "custom", file: path.resolve(flags.file) }], deferred: [] }
    : selectLocations(discoverConfigs(), flags.all ?? false);

  if (locations.length === 0) {
    console.error(
      "mcp-fuse init: no MCP config found (looked for ./.mcp.json, Cursor, Claude Desktop).\n" +
        "Pass one explicitly: mcp-fuse init --file <path-to-config.json>",
    );
    return 1;
  }

  const launcher = detectLauncher();
  const wrapArgs = flags.fuseConfig ? ["--config", path.resolve(flags.fuseConfig)] : [];
  let failures = 0;

  for (const { host, file } of locations) {
    let config: McpConfig;
    try {
      config = JSON.parse(readFileSync(file, "utf8")) as McpConfig;
    } catch (e) {
      console.error(`✗ ${host} (${file}): cannot read/parse — ${String(e)}`);
      failures += 1;
      continue;
    }

    const report = transformConfig(config, launcher, { unwrap: flags.unwrap, wrapArgs });
    const verb = flags.unwrap ? "unwrapped" : "wrapped";
    console.error(`${host} — ${file}`);
    for (const name of report.changed) console.error(`  ✓ ${verb} "${name}"`);
    for (const { name, reason } of report.skipped) console.error(`  – skipped "${name}" (${reason})`);

    if (report.changed.length === 0) {
      console.error("  nothing to change");
      continue;
    }
    if (flags.dryRun) {
      console.error("  (dry run — no files written)");
      continue;
    }
    copyFileSync(file, `${file}.mcp-fuse-backup`);
    writeFileSync(file, JSON.stringify(report.config, null, 2) + "\n");
    console.error(`  backup: ${file}.mcp-fuse-backup`);
  }
  for (const { host, file } of deferred) {
    console.error(`– not touching ${host} (${file}) — run with --all or --file to include it`);
  }
  if (!flags.dryRun && !flags.unwrap) {
    console.error("\nRestart your MCP host (or reload its servers) to pick up the change.");
  }
  return failures > 0 ? 1 : 0;
}
