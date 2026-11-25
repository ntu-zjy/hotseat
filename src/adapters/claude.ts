// Claude Code（含 Claude 桌面 App 的 Code 标签页）。PRD §8.1：接入等级 A。
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, AdapterContext, DoctorCheck, PlannedChange } from "../contracts/adapter.ts";
import { OWNERSHIP, hookCommand, mcpServerEntry } from "../contracts/adapter.ts";
import { readTextOrNull } from "../core/util.ts";
import { normalizeHookInput, renderHookOutput } from "../hooks/normalize.ts";
import { hasClaudeHook, isObj, jsonText, mergeClaudeHooks, readJsonFile, removeBlock, rulesText, say, setEntry, stripClaudeHooks, upsertBlock } from "./shared.ts";

const files = (ctx: AdapterContext) => ({
  mcp: join(ctx.home, ".claude.json"),
  settings: join(ctx.home, ".claude", "settings.json"),
  rules: join(ctx.home, ".claude", "CLAUDE.md"),
});

const EVENTS = { SessionStart: "session-start", Stop: "stop" } as const;

export const claudeAdapter: Adapter = {
  id: "claude",
  displayName: "Claude Code",
  tier: "A",
  experimental: false,
  hookFamily: "claude",
  maxContextChars: 9500,

  async detect(ctx) {
    const f = files(ctx);
    const installed = existsSync(join(ctx.home, ".claude")) || existsSync(f.mcp);
    return {
      installed,
      version: null,
      configPaths: [f.mcp, f.settings, f.rules],
      notes: installed ? [ctx.lang === "en" ? "Also used by the Code tab of the Claude desktop app" : "同时用于 Claude 桌面 App 的 Code 标签页"] : [],
    };
  },

  async planInstall(ctx, opts) {
    const f = files(ctx);
    const out: PlannedChange[] = [];
    if (opts.parts.includes("mcp")) {
      const { text, data } = readJsonFile(f.mcp, ctx.lang);
      const entry = mcpServerEntry(ctx.bin, "claude");
      out.push({
        agent: "claude",
        part: "mcp",
        file: f.mcp,
        kind: "json-merge",
        summary: say(ctx.lang).addUserMcp,
        before: text,
        after: jsonText(setEntry(data, "mcpServers", OWNERSHIP.mcpKey, entry), text),
        preview: JSON.stringify({ mcpServers: { [OWNERSHIP.mcpKey]: entry } }, null, 2),
      });
    }
    if (opts.parts.includes("rules")) {
      const before = readTextOrNull(f.rules);
      const block = rulesText(ctx.lang);
      out.push({ agent: "claude", part: "rules", file: f.rules, kind: "marked-block", summary: say(ctx.lang).appendRules(ctx.lang === "en" ? "the global CLAUDE.md" : "全局 CLAUDE.md"), before, after: upsertBlock(before, block), preview: block });
    }
    if (opts.parts.includes("hooks")) {
      const { text, data } = readJsonFile(f.settings, ctx.lang);
      const commands = Object.fromEntries(Object.entries(EVENTS).map(([e, ev]) => [e, hookCommand(ctx.bin, "claude", ev)]));
      out.push({
        agent: "claude",
        part: "hooks",
        file: f.settings,
        kind: "json-merge",
        summary: say(ctx.lang).addHooks(Object.keys(EVENTS)),
        before: text,
        after: jsonText(mergeClaudeHooks(data, commands), text),
        preview: Object.entries(commands).map(([e, c]) => `${e}: ${c}`).join("\n"),
      });
    }
    return out.filter((c) => c.before !== c.after);
  },

  async planUninstall(ctx) {
    const f = files(ctx);
    const out: PlannedChange[] = [];
    const mcp = readJsonFile(f.mcp, ctx.lang);
    if (isObj(mcp.data.mcpServers) && OWNERSHIP.mcpKey in mcp.data.mcpServers) {
      out.push({ agent: "claude", part: "mcp", file: f.mcp, kind: "json-merge", summary: say(ctx.lang).removeMcp, before: mcp.text, after: jsonText(setEntry(mcp.data, "mcpServers", OWNERSHIP.mcpKey, undefined), mcp.text) });
    }
    const rules = readTextOrNull(f.rules);
    if (rules?.includes(OWNERSHIP.rulesBegin)) {
      out.push({ agent: "claude", part: "rules", file: f.rules, kind: "marked-block", summary: say(ctx.lang).removeRules("CLAUDE.md"), before: rules, after: removeBlock(rules) });
    }
    const settings = readJsonFile(f.settings, ctx.lang);
    const stripped = stripClaudeHooks(settings.data);
    if (JSON.stringify(stripped) !== JSON.stringify(settings.data)) {
      out.push({ agent: "claude", part: "hooks", file: f.settings, kind: "json-merge", summary: say(ctx.lang).removeHooks, before: settings.text, after: jsonText(stripped, settings.text) });
    }
    return out;
  },

  async doctor(ctx) {
    const f = files(ctx);
    const checks: DoctorCheck[] = [];
    const fix = "hotseat init --only claude";
    const entry = (() => {
      try {
        const servers = readJsonFile(f.mcp, ctx.lang).data.mcpServers;
        return isObj(servers) && isObj(servers[OWNERSHIP.mcpKey]) ? (servers[OWNERSHIP.mcpKey] as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    })();
    checks.push(
      !entry
        ? { agent: "claude", part: "mcp", ok: false, message: say(ctx.lang).mcpMissing(f.mcp), fix }
        : entry.command !== ctx.bin
          ? { agent: "claude", part: "mcp", ok: false, message: say(ctx.lang).mcpElsewhere(String(entry.command), ctx.bin), fix }
          : { agent: "claude", part: "mcp", ok: true, message: say(ctx.lang).mcpOk },
    );
    const rules = readTextOrNull(f.rules);
    checks.push(
      rules?.includes(OWNERSHIP.rulesBegin)
        ? { agent: "claude", part: "rules", ok: true, message: say(ctx.lang).rulesOk }
        : { agent: "claude", part: "rules", ok: false, message: say(ctx.lang).rulesMissing(f.rules), fix },
    );
    let settings: Record<string, unknown> = {};
    try {
      settings = readJsonFile(f.settings, ctx.lang).data;
    } catch (e) {
      checks.push({ agent: "claude", part: "hooks", ok: false, message: (e as Error).message });
    }
    for (const event of Object.keys(EVENTS)) {
      checks.push(
        hasClaudeHook(settings, event)
          ? { agent: "claude", part: "hooks", ok: true, message: say(ctx.lang).hookOk(event) }
          : { agent: "claude", part: "hooks", ok: false, message: `${say(ctx.lang).hookMissing(f.settings, event)}${ctx.lang === "en" ? " (a tool like CC-Switch may have overwritten it)" : "（可能被 CC-Switch 等工具覆盖）"}`, fix },
      );
    }
    return checks;
  },

  parseHookInput: (event, raw, env) => normalizeHookInput("claude", event, raw, env),
  renderHookOutput: (decision) => renderHookOutput("claude", decision),
};
