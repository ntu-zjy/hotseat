import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AdapterContext, PlannedChange } from "../contracts/adapter.ts";
import { codexMcpBlock } from "./codex.ts";
import { qoderCnAdapter } from "./qoder-cn.ts";
import { emptyToNull, hasFlatHook, mergeFlatHooks, removeTomlTable, stripFlatHooks, tomlTableRange, tomlTableText, upsertTomlTable } from "./shared.ts";

const BIN = "/Users/me/Hotseat/.hotseat/bin/hotseat";
const CODEX_TOML = [
  'model = "gpt-5"',
  "",
  "[mcp_servers.node_repl]",
  'command = "node"',
  "",
  "[mcp_servers.node_repl.env]",
  'CODEX_HOME = "/x"',
  "",
  '[plugins."github@openai-curated"]',
  "enabled = true",
  "",
].join("\n");

test("Codex config.toml：追加 hotseat 表，幂等；卸载后逐字节还原；不碰其他表", () => {
  const block = codexMcpBlock(BIN);
  const once = upsertTomlTable(CODEX_TOML, "mcp_servers.hotseat", block);
  assert.equal(once, `${CODEX_TOML}\n${block}`);
  assert.equal(upsertTomlTable(once, "mcp_servers.hotseat", block), once);
  assert.match(tomlTableText(once, "mcp_servers.hotseat") ?? "", /command = "\/Users\/me\/Hotseat\/\.hotseat\/bin\/hotseat"\nargs = \["mcp"\]\nenv = \{ HOTSEAT_AGENT = "codex" \}/);
  assert.equal(removeTomlTable(once, "mcp_servers.hotseat"), CODEX_TOML);
  // 别的表名里带 hotseat 前缀的不算
  assert.equal(tomlTableRange("[mcp_servers.hotseat2]\na = 1\n", "mcp_servers.hotseat"), null);
});

test("Codex config.toml：用户手写的 hotseat 表（带子表、在中间）整段替换", () => {
  const text = ['[mcp_servers."hotseat"]', 'command = "old"', "", "[mcp_servers.hotseat.env]", 'A = "1"', "", "[features]", "hooks = true", ""].join("\n");
  const block = codexMcpBlock(BIN);
  const out = upsertTomlTable(text, "mcp_servers.hotseat", block);
  assert.equal(out, `${block}\n[features]\nhooks = true\n`);
  assert.equal(removeTomlTable(out, "mcp_servers.hotseat"), "[features]\nhooks = true\n");
  assert.equal(removeTomlTable(block, "mcp_servers.hotseat"), null);
});

test("Cursor hooks.json：加 version 1，保留用户的 Hook，幂等，卸载后还原", () => {
  const user = { version: 1, hooks: { afterFileEdit: [{ command: "./format.sh" }], stop: [{ command: "say done" }] } };
  const ours = { sessionStart: { command: `${BIN} hook cursor session-start`, timeout: 10 }, stop: { command: `${BIN} hook cursor stop`, timeout: 10, loop_limit: 1 } };
  const merged = mergeFlatHooks(user, ours);
  assert.deepEqual((merged.hooks as Record<string, unknown[]>).stop, [{ command: "say done" }, ours.stop]);
  assert.ok(hasFlatHook(merged, "sessionStart") && hasFlatHook(merged, "stop"));
  assert.deepEqual(mergeFlatHooks(merged, ours), merged);
  assert.deepEqual(stripFlatHooks(merged), user);
  // 原来没有文件：卸载后只剩 version，可以删掉文件
  const fresh = mergeFlatHooks({}, ours);
  assert.equal(fresh.version, 1);
  assert.equal(emptyToNull(stripFlatHooks(fresh), ["version"]), null);
});

test("Qoder CN：MCP 和 Hook 写进同一个 settings.json，两处改动按顺序接起来", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "qoder-")));
  mkdirSync(join(home, ".qoder-cn"));
  const original = JSON.stringify({ enabledPlugins: { "qoder-context@qoderapp-bundler": true } }, null, 2);
  writeFileSync(join(home, ".qoder-cn", "settings.json"), original);
  const ctx: AdapterContext = { home, hotseatHome: join(home, "Hotseat"), bin: BIN, lang: "zh", platform: "darwin", env: {} };
  const changes = await qoderCnAdapter.planInstall(ctx, { parts: ["mcp", "rules", "hooks"], projectRulesDir: null });
  const onSettings = changes.filter((c) => c.file.endsWith("settings.json"));
  assert.deepEqual(onSettings.map((c) => c.part), ["mcp", "hooks"]);
  const [mcp, hooks] = onSettings as [PlannedChange, PlannedChange];
  assert.equal(mcp.before, original);
  assert.equal(hooks.before, mcp.after);
  const final = JSON.parse(hooks.after ?? "");
  assert.equal(final.enabledPlugins["qoder-context@qoderapp-bundler"], true);
  assert.deepEqual(final.mcpServers.hotseat, { type: "stdio", command: BIN, args: ["mcp"], env: { HOTSEAT_AGENT: "qoder-cn" } });
  assert.match(final.hooks.SessionStart[0].hooks[0].command, /hook qoder-cn session-start$/);
  assert.match(final.hooks.Stop[0].hooks[0].command, /hook qoder-cn stop$/);
});
