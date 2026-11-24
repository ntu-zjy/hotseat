// Codex（CLI 和桌面 App 共用 ~/.codex）。PRD §8.1：接入等级 A。
// 依据：Codex 官方 Hooks 文档（learn.chatgpt.com/docs/hooks，2026-11-24 核对）和本机 Codex 0.167 程序里的字段名。
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, AdapterContext, DoctorCheck, PlannedChange } from "../contracts/adapter.ts";
import { OWNERSHIP, hookCommand } from "../contracts/adapter.ts";
import { readTextOrNull } from "../core/util.ts";
import { normalizeHookInput, renderHookOutput } from "../hooks/normalize.ts";
import {
  emptyToNull,
  hasClaudeHook,
  jsonText,
  mergeClaudeHooks,
  readJsonFile,
  removeBlock,
  removeTomlTable,
  rulesText,
  stripClaudeHooks,
  tomlString,
  tomlTableText,
  upsertBlock,
  upsertTomlTable,
} from "./shared.ts";

const MCP_TABLE = `mcp_servers.${OWNERSHIP.mcpKey}`;
const EVENTS = { SessionStart: "session-start", Stop: "stop" } as const;
/**
 * Codex 默认把每条 Hook 输出限制在约 2500 token，超出的存到文件、只给预览。
 * 上下文包默认预算是 5000（§3.3），这里放宽到 10000，让交接整段进上下文。
 */
const ADDITIONAL_CONTEXT_LIMIT = 10_000;

const files = (ctx: AdapterContext) => {
  const dir = ctx.env.CODEX_HOME ?? join(ctx.home, ".codex");
  return { dir, config: join(dir, "config.toml"), hooks: join(dir, "hooks.json"), rules: join(dir, "AGENTS.md") };
};

export function codexMcpBlock(bin: string): string {
  return [`[${MCP_TABLE}]`, `command = ${tomlString(bin)}`, `args = ["mcp"]`, `env = { HOTSEAT_AGENT = "codex" }`, ""].join("\n");
}

export const codexAdapter: Adapter = {
  id: "codex",
  displayName: "Codex",
  tier: "A",
  experimental: true,
  hookFamily: "claude",
  maxContextChars: 9500,
  afterInstall: ["在 Codex 里输入 /hooks，信任 Hotseat 的 SessionStart 和 Stop 两个 Hook；不信任的话 Codex 不会运行它们"],

  async detect(ctx) {
    const f = files(ctx);
    return {
      installed: existsSync(f.dir),
      version: null,
      configPaths: [f.config, f.hooks, f.rules],
      notes: existsSync(f.dir) ? ["CLI 和桌面 App 共用这份配置"] : [],
    };
  },

  async planInstall(ctx, opts) {
    const f = files(ctx);
    const out: PlannedChange[] = [];
    if (opts.parts.includes("mcp")) {
      const before = readTextOrNull(f.config);
      const block = codexMcpBlock(ctx.bin);
      out.push({ agent: "codex", part: "mcp", file: f.config, kind: "toml-merge", summary: "在 config.toml 末尾添加 MCP 服务 hotseat", before, after: upsertTomlTable(before, MCP_TABLE, block), preview: block.trimEnd() });
    }
    if (opts.parts.includes("rules")) {
      const before = readTextOrNull(f.rules);
      const block = rulesText(ctx.lang);
      out.push({ agent: "codex", part: "rules", file: f.rules, kind: "marked-block", summary: "在全局 AGENTS.md 末尾加入 Hotseat 规则片段", before, after: upsertBlock(before, block), preview: block });
    }
    if (opts.parts.includes("hooks")) {
      const { text, data } = readJsonFile(f.hooks);
      const commands = Object.fromEntries(Object.entries(EVENTS).map(([e, ev]) => [e, hookCommand(ctx.bin, "codex", ev)]));
      const merged = mergeClaudeHooks(data, commands, { SessionStart: { additionalContextLimit: ADDITIONAL_CONTEXT_LIMIT } });
      out.push({
        agent: "codex",
        part: "hooks",
        file: f.hooks,
        kind: "json-merge",
        summary: "添加 SessionStart（自动注入上下文）和 Stop（收工检查）两个 Hook",
        before: text,
        after: jsonText(merged, text),
        preview: Object.entries(commands).map(([e, c]) => `${e}: ${c}`).join("\n"),
      });
    }
    return out.filter((c) => c.before !== c.after);
  },

  async planUninstall(ctx) {
    const f = files(ctx);
    const out: PlannedChange[] = [];
    const config = readTextOrNull(f.config);
    if (tomlTableText(config, MCP_TABLE)) {
      out.push({ agent: "codex", part: "mcp", file: f.config, kind: "toml-merge", summary: "移除 MCP 服务 hotseat", before: config, after: removeTomlTable(config, MCP_TABLE) });
    }
    const rules = readTextOrNull(f.rules);
    if (rules?.includes(OWNERSHIP.rulesBegin)) {
      out.push({ agent: "codex", part: "rules", file: f.rules, kind: "marked-block", summary: "移除 AGENTS.md 里的 Hotseat 规则片段", before: rules, after: removeBlock(rules) });
    }
    const hooks = readJsonFile(f.hooks);
    const stripped = stripClaudeHooks(hooks.data);
    if (JSON.stringify(stripped) !== JSON.stringify(hooks.data)) {
      const kept = emptyToNull(stripped);
      out.push({ agent: "codex", part: "hooks", file: f.hooks, kind: "json-merge", summary: "移除 Hotseat 的 Hook", before: hooks.text, after: kept ? jsonText(kept, hooks.text) : null });
    }
    return out;
  },

  async doctor(ctx) {
    const f = files(ctx);
    const fix = "hotseat init --only codex";
    const checks: DoctorCheck[] = [];
    const table = tomlTableText(readTextOrNull(f.config), MCP_TABLE);
    checks.push(
      !table
        ? { agent: "codex", part: "mcp", ok: false, message: `${f.config} 里没有 hotseat MCP 服务`, fix }
        : !table.includes(`command = ${tomlString(ctx.bin)}`)
          ? { agent: "codex", part: "mcp", ok: false, message: `MCP 服务没有指向 ${ctx.bin}`, fix }
          : { agent: "codex", part: "mcp", ok: true, message: "MCP 服务已配置" },
    );
    const rules = readTextOrNull(f.rules);
    checks.push(
      rules?.includes(OWNERSHIP.rulesBegin)
        ? { agent: "codex", part: "rules", ok: true, message: "规则片段已写入" }
        : { agent: "codex", part: "rules", ok: false, message: `${f.rules} 里没有 Hotseat 规则片段`, fix },
    );
    let hooks: Record<string, unknown> = {};
    try {
      hooks = readJsonFile(f.hooks).data;
    } catch (e) {
      checks.push({ agent: "codex", part: "hooks", ok: false, message: (e as Error).message });
    }
    for (const event of Object.keys(EVENTS)) {
      checks.push(
        hasClaudeHook(hooks, event)
          ? { agent: "codex", part: "hooks", ok: true, message: `${event} Hook 已配置（新 Hook 要在 Codex 里用 /hooks 信任后才会运行）` }
          : { agent: "codex", part: "hooks", ok: false, message: `${f.hooks} 里没有 ${event} Hook`, fix },
      );
    }
    return checks;
  },

  parseHookInput: (event, raw, env) => normalizeHookInput("codex", event, raw, env),
  renderHookOutput: (decision) => renderHookOutput("codex", decision),
};
