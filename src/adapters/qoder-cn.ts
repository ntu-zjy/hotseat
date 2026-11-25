// Qoder CN（桌面 App 和 CLI 共用 ~/.qoder-cn）。PRD §8.1：接入等级 A。
// 依据：本机 Qoder CN 0.2.5 自带的 Agent 运行时（2026-11-24 核对）——
// 全局配置目录是 ~/.qoder-cn（可用 QODERCN_CONFIG_DIR 改），用户级 MCP 服务和 Hook 都在 settings.json，
// Hook 格式、输入输出和 Claude Code 一致（hookSpecificOutput.additionalContext、stop_hook_active），
// 会话开始输出超过 1 万字符会存成文件；全局规则文件是 AGENTS.md。
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, AdapterContext, DoctorCheck, PlannedChange } from "../contracts/adapter.ts";
import { OWNERSHIP, hookCommand, mcpServerEntry } from "../contracts/adapter.ts";
import { readTextOrNull } from "../core/util.ts";
import { normalizeHookInput, renderHookOutput } from "../hooks/normalize.ts";
import { hasClaudeHook, isObj, jsonText, mergeClaudeHooks, readJsonFile, removeBlock, rulesText, say, setEntry, stripClaudeHooks, type Json, upsertBlock } from "./shared.ts";

const EVENTS = { SessionStart: "session-start", Stop: "stop" } as const;

const files = (ctx: AdapterContext) => {
  const dir = ctx.env.QODERCN_CONFIG_DIR ?? join(ctx.home, ".qoder-cn");
  return { dir, settings: join(dir, "settings.json"), rules: join(dir, "AGENTS.md") };
};

export const qoderCnAdapter: Adapter = {
  id: "qoder-cn",
  displayName: "Qoder CN",
  tier: "A",
  experimental: true,
  hookFamily: "claude",
  maxContextChars: 9500,

  async detect(ctx) {
    const f = files(ctx);
    const installed = existsSync(f.dir);
    return { installed, version: null, configPaths: [f.settings, f.rules], notes: installed ? [ctx.lang === "en" ? "The desktop app and the CLI share this config" : "桌面 App 和 CLI 共用这份配置"] : [] };
  },

  async planInstall(ctx, opts) {
    const f = files(ctx);
    const out: PlannedChange[] = [];
    // MCP 和 Hook 在同一个 settings.json 里：第二处改动接着第一处的结果算，写入时按顺序检查
    let { text, data } = readJsonFile(f.settings, ctx.lang);
    const step = (part: "mcp" | "hooks", summary: string, next: Json, preview: string) => {
      const after = jsonText(next, text);
      out.push({ agent: "qoder-cn", part, file: f.settings, kind: "json-merge", summary, before: text, after, preview });
      text = after;
      data = next;
    };
    if (opts.parts.includes("mcp")) {
      const entry = mcpServerEntry(ctx.bin, "qoder-cn");
      step("mcp", say(ctx.lang).addUserMcp, setEntry(data, "mcpServers", OWNERSHIP.mcpKey, entry), JSON.stringify({ mcpServers: { [OWNERSHIP.mcpKey]: entry } }, null, 2));
    }
    if (opts.parts.includes("rules")) {
      const before = readTextOrNull(f.rules);
      const block = rulesText(ctx.lang);
      out.push({ agent: "qoder-cn", part: "rules", file: f.rules, kind: "marked-block", summary: say(ctx.lang).appendRules(ctx.lang === "en" ? "the global AGENTS.md" : "全局 AGENTS.md"), before, after: upsertBlock(before, block), preview: block });
    }
    if (opts.parts.includes("hooks")) {
      const commands = Object.fromEntries(Object.entries(EVENTS).map(([e, ev]) => [e, hookCommand(ctx.bin, "qoder-cn", ev)]));
      step("hooks", say(ctx.lang).addHooks(Object.keys(EVENTS)), mergeClaudeHooks(data, commands), Object.entries(commands).map(([e, c]) => `${e}: ${c}`).join("\n"));
    }
    return out.filter((c) => c.before !== c.after);
  },

  async planUninstall(ctx) {
    const f = files(ctx);
    const out: PlannedChange[] = [];
    let { text, data } = readJsonFile(f.settings, ctx.lang);
    if (isObj(data.mcpServers) && OWNERSHIP.mcpKey in data.mcpServers) {
      const next = setEntry(data, "mcpServers", OWNERSHIP.mcpKey, undefined);
      const after = jsonText(next, text);
      out.push({ agent: "qoder-cn", part: "mcp", file: f.settings, kind: "json-merge", summary: say(ctx.lang).removeMcp, before: text, after });
      text = after;
      data = next;
    }
    const stripped = stripClaudeHooks(data);
    if (JSON.stringify(stripped) !== JSON.stringify(data)) {
      out.push({ agent: "qoder-cn", part: "hooks", file: f.settings, kind: "json-merge", summary: say(ctx.lang).removeHooks, before: text, after: jsonText(stripped, text) });
    }
    const rules = readTextOrNull(f.rules);
    if (rules?.includes(OWNERSHIP.rulesBegin)) {
      out.push({ agent: "qoder-cn", part: "rules", file: f.rules, kind: "marked-block", summary: say(ctx.lang).removeRules("AGENTS.md"), before: rules, after: removeBlock(rules) });
    }
    return out;
  },

  async doctor(ctx) {
    const f = files(ctx);
    const fix = "hotseat init --only qoder-cn";
    const checks: DoctorCheck[] = [];
    let settings: Json = {};
    try {
      settings = readJsonFile(f.settings, ctx.lang).data;
    } catch (e) {
      checks.push({ agent: "qoder-cn", part: "mcp", ok: false, message: (e as Error).message });
    }
    const servers = settings.mcpServers;
    const entry = isObj(servers) && isObj(servers[OWNERSHIP.mcpKey]) ? (servers[OWNERSHIP.mcpKey] as Json) : null;
    checks.push(
      !entry
        ? { agent: "qoder-cn", part: "mcp", ok: false, message: say(ctx.lang).mcpMissing(f.settings), fix }
        : entry.command !== ctx.bin
          ? { agent: "qoder-cn", part: "mcp", ok: false, message: say(ctx.lang).mcpElsewhere(String(entry.command), ctx.bin), fix }
          : { agent: "qoder-cn", part: "mcp", ok: true, message: say(ctx.lang).mcpOk },
    );
    const rules = readTextOrNull(f.rules);
    checks.push(
      rules?.includes(OWNERSHIP.rulesBegin)
        ? { agent: "qoder-cn", part: "rules", ok: true, message: say(ctx.lang).rulesOk }
        : { agent: "qoder-cn", part: "rules", ok: false, message: say(ctx.lang).rulesMissing(f.rules), fix },
    );
    for (const event of Object.keys(EVENTS)) {
      checks.push(
        hasClaudeHook(settings, event)
          ? { agent: "qoder-cn", part: "hooks", ok: true, message: say(ctx.lang).hookOk(event) }
          : { agent: "qoder-cn", part: "hooks", ok: false, message: say(ctx.lang).hookMissing(f.settings, event), fix },
      );
    }
    return checks;
  },

  parseHookInput: (event, raw, env) => normalizeHookInput("qoder-cn", event, raw, env),
  renderHookOutput: (decision) => renderHookOutput("qoder-cn", decision),
};
