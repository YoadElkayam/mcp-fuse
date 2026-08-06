import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isWrapped,
  selectLocations,
  transformConfig,
  unwrapEntry,
  wrapEntry,
  type Launcher,
  type McpConfig,
} from "./init.js";

const npx: Launcher = { command: "npx", prefixArgs: ["-y", "mcp-fuse", "wrap"] };

test("wrapEntry rewrites command/args and preserves env and unknown fields", () => {
  const wrapped = wrapEntry(
    {
      command: "node",
      args: ["./server.js", "--port", "3000"],
      env: { API_KEY: "secret" },
      timeout: 60,
    },
    npx,
  );
  assert.equal(wrapped.command, "npx");
  assert.deepEqual(wrapped.args, ["-y", "mcp-fuse", "wrap", "--", "node", "./server.js", "--port", "3000"]);
  assert.deepEqual(wrapped.env, { API_KEY: "secret" });
  assert.equal(wrapped.timeout, 60);
  assert.ok(isWrapped(wrapped));
});

test("unwrapEntry inverts wrapEntry exactly", () => {
  const original = { command: "uvx", args: ["some-mcp-server", "--flag"] };
  const roundTripped = unwrapEntry(wrapEntry(original, npx));
  assert.equal(roundTripped.command, original.command);
  assert.deepEqual(roundTripped.args, original.args);
});

test("wrapEntry can bake in a fuse config", () => {
  const wrapped = wrapEntry({ command: "node", args: ["s.js"] }, npx, ["--config", "/etc/fuse.json"]);
  assert.deepEqual(wrapped.args, ["-y", "mcp-fuse", "wrap", "--config", "/etc/fuse.json", "--", "node", "s.js"]);
});

test("transformConfig wraps stdio entries, skips HTTP and already-wrapped ones", () => {
  const config: McpConfig = {
    mcpServers: {
      files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
      remote: { url: "https://api.example.com/mcp" },
      protected: { command: "npx", args: ["-y", "mcp-fuse", "wrap", "--", "node", "s.js"] },
    },
    otherTopLevelKey: true,
  };
  const report = transformConfig(config, npx);
  assert.deepEqual(report.changed, ["files"]);
  assert.deepEqual(
    report.skipped.map((s) => s.name).sort(),
    ["protected", "remote"],
  );
  assert.equal(report.config.otherTopLevelKey, true);
  assert.ok(isWrapped(report.config.mcpServers!.files));
  assert.deepEqual(report.config.mcpServers!.remote, config.mcpServers!.remote);
});

test("selectLocations: project config wins; globals need --all", () => {
  const project = { host: "Claude Code (project)", file: "/repo/.mcp.json" };
  const cursor = { host: "Cursor", file: "/home/.cursor/mcp.json" };
  const desktop = { host: "Claude Desktop", file: "/home/claude_desktop_config.json" };

  const scoped = selectLocations([project, cursor, desktop], false);
  assert.deepEqual(scoped.selected, [project]);
  assert.deepEqual(scoped.deferred, [cursor, desktop]);

  const all = selectLocations([project, cursor, desktop], true);
  assert.equal(all.selected.length, 3);
  assert.equal(all.deferred.length, 0);

  const single = selectLocations([desktop], false);
  assert.deepEqual(single.selected, [desktop]);
});

test("transformConfig --unwrap restores wrapped entries and leaves others alone", () => {
  const config: McpConfig = {
    mcpServers: {
      files: wrapEntry({ command: "node", args: ["fs.js"] }, npx),
      plain: { command: "node", args: ["plain.js"] },
    },
  };
  const report = transformConfig(config, npx, { unwrap: true });
  assert.deepEqual(report.changed, ["files"]);
  assert.equal(report.config.mcpServers!.files.command, "node");
  assert.deepEqual(report.config.mcpServers!.files.args, ["fs.js"]);
  assert.deepEqual(report.config.mcpServers!.plain, config.mcpServers!.plain);
});
