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
  say,
  stripClaudeHooks,
  text,
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
  experimental: false,
  hookFamily: "claude",
  maxContextChars: 9500,
  afterInstall: [text("在 Codex 里输入 /hooks，信任 Hotseat 的 SessionStart 和 Stop 两个 Hook；不信任的话 Codex 不会运行它们", "In Codex, type /hooks and trust Hotseat's SessionStart and Stop hooks; Codex won't run untrusted hooks")],

  async detect(ctx) {
    const f = files(ctx);
    return {
      installed: existsSync(f.dir),
      version: null,
      configPaths: [f.config, f.hooks, f.rules],
      notes: existsSync(f.dir) ? [ctx.lang === "en" ? "The CLI and the desktop app share this config" : "CLI 和桌面 App 共用这份配置"] : [],
    };
  },

  async planInstall(ctx, opts) {
    const f = files(ctx);
    const out: PlannedChange[] = [];
    if (opts.parts.includes("mcp")) {
      const before = readTextOrNull(f.config);
      const block = codexMcpBlock(ctx.bin);
      out.push({ agent: "codex", part: "mcp", file: f.config, kind: "toml-merge", summary: ctx.lang === "en" ? "Append the hotseat MCP server to config.toml" : "在 config.toml 末尾添加 MCP 服务 hotseat", before, after: upsertTomlTable(before, MCP_TABLE, block), preview: block.trimEnd() });
    }
    if (opts.parts.includes("rules")) {
      const before = readTextOrNull(f.rules);
      const block = rulesText(ctx.lang);
      out.push({ agent: "codex", part: "rules", file: f.rules, kind: "marked-block", summary: say(ctx.lang).appendRules(ctx.lang === "en" ? "the global AGENTS.md" : "全局 AGENTS.md"), before, after: upsertBlock(before, block), preview: block });
    }
    if (opts.parts.includes("hooks")) {
      const { text: original, data } = readJsonFile(f.hooks, ctx.lang);
      const commands = Object.fromEntries(Object.entries(EVENTS).map(([e, ev]) => [e, hookCommand(ctx.bin, "codex", ev)]));
      const merged = mergeClaudeHooks(data, commands, { SessionStart: { additionalContextLimit: ADDITIONAL_CONTEXT_LIMIT } });
      out.push({
        agent: "codex",
        part: "hooks",
        file: f.hooks,
        kind: "json-merge",
        summary: say(ctx.lang).addHooks(Object.keys(EVENTS)),
        before: original,
        after: jsonText(merged, original),
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
      out.push({ agent: "codex", part: "mcp", file: f.config, kind: "toml-merge", summary: say(ctx.lang).removeMcp, before: config, after: removeTomlTable(config, MCP_TABLE) });
    }
    const rules = readTextOrNull(f.rules);
    if (rules?.includes(OWNERSHIP.rulesBegin)) {
      out.push({ agent: "codex", part: "rules", file: f.rules, kind: "marked-block", summary: say(ctx.lang).removeRules("AGENTS.md"), before: rules, after: removeBlock(rules) });
    }
    const hooks = readJsonFile(f.hooks, ctx.lang);
    const stripped = stripClaudeHooks(hooks.data);
    if (JSON.stringify(stripped) !== JSON.stringify(hooks.data)) {
      const kept = emptyToNull(stripped);
      out.push({ agent: "codex", part: "hooks", file: f.hooks, kind: "json-merge", summary: say(ctx.lang).removeHooks, before: hooks.text, after: kept ? jsonText(kept, hooks.text) : null });
    }
    return out;
  },

  async doctor(ctx) {
    const f = files(ctx);
    const fix = "hotseat init --only codex";
    const t = say(ctx.lang);
    const checks: DoctorCheck[] = [];
    const table = tomlTableText(readTextOrNull(f.config), MCP_TABLE);
    checks.push(
      !table
        ? { agent: "codex", part: "mcp", ok: false, message: t.mcpMissing(f.config), fix }
        : !table.includes(`command = ${tomlString(ctx.bin)}`)
          ? { agent: "codex", part: "mcp", ok: false, message: t.mcpNotBin(ctx.bin), fix }
          : { agent: "codex", part: "mcp", ok: true, message: t.mcpOk },
    );
    const rules = readTextOrNull(f.rules);
    checks.push(
      rules?.includes(OWNERSHIP.rulesBegin)
        ? { agent: "codex", part: "rules", ok: true, message: t.rulesOk }
        : { agent: "codex", part: "rules", ok: false, message: t.rulesMissing(f.rules), fix },
    );
    let hooks: Record<string, unknown> = {};
    try {
      hooks = readJsonFile(f.hooks, ctx.lang).data;
    } catch (e) {
      checks.push({ agent: "codex", part: "hooks", ok: false, message: (e as Error).message });
    }
    for (const event of Object.keys(EVENTS)) {
      checks.push(
        hasClaudeHook(hooks, event)
          ? { agent: "codex", part: "hooks", ok: true, message: `${t.hookOk(event)}${ctx.lang === "en" ? " (new hooks only run after you trust them with /hooks in Codex)" : "（新 Hook 要在 Codex 里用 /hooks 信任后才会运行）"}` }
          : { agent: "codex", part: "hooks", ok: false, message: t.hookMissing(f.hooks, event), fix },
      );
    }
    return checks;
  },

  parseHookInput: (event, raw, env) => normalizeHookInput("codex", event, raw, env),
  renderHookOutput: (decision) => renderHookOutput("codex", decision),
};
