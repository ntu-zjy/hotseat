// Antigravity（agy）：IDE、App、CLI 共用 ~/.gemini/config。PRD §8.1：接入等级 A（会话开始注入、收工检查 2026-11-24 实测可用）。
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, AdapterContext, DoctorCheck, PlannedChange } from "../contracts/adapter.ts";
import { OWNERSHIP, hookCommand } from "../contracts/adapter.ts";
import { HOOK_LIMITS } from "../contracts/hooks.ts";
import { readTextOrNull } from "../core/util.ts";
import { normalizeHookInput, renderHookOutput } from "../hooks/normalize.ts";
import { isObj, jsonText, readJsonFile, removeBlock, rulesText, say, setEntry, type Json, upsertBlock } from "./shared.ts";

const files = (ctx: AdapterContext) => {
  const config = join(ctx.home, ".gemini", "config");
  return {
    config,
    mcp: join(config, "mcp_config.json"),
    hooks: join(config, "hooks.json"),
    rules: join(config, "rules", "hotseat.md"),
  };
};

/** agy 的 stdio MCP 条目没有 type 字段。 */
const mcpEntry = (bin: string) => ({ command: bin, args: ["mcp"], env: { HOTSEAT_AGENT: "agy" } });

/**
 * agy 内嵌文档：SessionStart、PreInvocation、PostInvocation、Stop 是扁平的处理程序列表；
 * 只有 PreToolUse、PostToolUse 要套 { matcher, hooks }。格式不对时 agy 会跳过整个 hooks.json。
 */
const hookGroup = (bin: string) => {
  const handler = (event: "session-start" | "stop") => ({
    type: "command",
    command: hookCommand(bin, "agy", event),
    timeout: HOOK_LIMITS.configTimeoutSec,
  });
  return { SessionStart: [handler("session-start")], Stop: [handler("stop")] };
};

// ---------- 格式和日志检查（doctor 用） ----------

const FLAT_EVENTS = ["SessionStart", "PreInvocation", "PostInvocation", "Stop"] as const;
const GROUPED_EVENTS = ["PreToolUse", "PostToolUse"] as const;
const handlerOk = (h: unknown): boolean => isObj(h) && typeof h.command === "string" && h.command !== "";

/** 按 agy 内嵌文档的规则检查整个 hooks.json，返回「组名.事件」形式的问题列表。任何一项不对，agy 都会跳过整个文件。 */
export function agyHooksProblems(data: Json): { group: string; event: string }[] {
  const out: { group: string; event: string }[] = [];
  for (const [group, spec] of Object.entries(data)) {
    if (!isObj(spec)) {
      out.push({ group, event: "*" });
      continue;
    }
    for (const event of FLAT_EVENTS) {
      const list = spec[event];
      if (list !== undefined && !(Array.isArray(list) && list.every(handlerOk))) out.push({ group, event });
    }
    for (const event of GROUPED_EVENTS) {
      const list = spec[event];
      const ok = Array.isArray(list) && list.every((g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.every(handlerOk));
      if (list !== undefined && !ok) out.push({ group, event });
    }
  }
  return out;
}

const LOG_TAIL_BYTES = 512 * 1024;
const PARSE_FAILURE = /[IWEF](\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})\.\d+\s+\d+ hooks\.go:\d+\] Failed to parse hooks file (\S+): ([^\n]+)/g;

export function agyLogPath(home: string): string {
  return join(home, "Library", "Logs", "Antigravity", "language_server.log");
}

/** agy 日志里，hooks.json 最后一次修改之后有没有解析失败。日志不存在时返回 null。 */
export function agyLogParseFailure(logPath: string, hooksFile: string, hooksMtimeMs: number, now: Date = new Date()): string | null {
  let text: string;
  try {
    const size = statSync(logPath).size;
    const fd = openSync(logPath, "r");
    try {
      const len = Math.min(size, LOG_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  let last: RegExpExecArray | null = null;
  for (const m of text.matchAll(PARSE_FAILURE)) if (m[6] === hooksFile) last = m;
  if (!last) return null;
  const [, mo, d, h, mi, sec] = last.map(Number) as number[];
  let at = new Date(now.getFullYear(), (mo ?? 1) - 1, d, h, mi, sec);
  if (at.getTime() > now.getTime() + 86_400_000) at = new Date(now.getFullYear() - 1, (mo ?? 1) - 1, d, h, mi, sec);
  return at.getTime() >= hooksMtimeMs - 2000 ? (last[7] ?? "").trim() : null;
}

export const agyAdapter: Adapter = {
  id: "agy",
  displayName: "Antigravity (agy)",
  tier: "A",
  experimental: false,
  hookFamily: "agy",
  maxContextChars: 8000,

  async detect(ctx) {
    const f = files(ctx);
    const installed = existsSync(f.config) || existsSync(join(ctx.home, ".gemini", "antigravity"));
    return {
      installed,
      version: null,
      configPaths: [f.mcp, f.hooks, f.rules],
      notes: installed ? [ctx.lang === "en" ? "The IDE, the app and the CLI share this config" : "IDE、App、CLI 共用这份配置"] : [],
    };
  },

  async planInstall(ctx, opts) {
    const f = files(ctx);
    const out: PlannedChange[] = [];
    if (opts.parts.includes("mcp")) {
      const { text, data } = readJsonFile(f.mcp, ctx.lang);
      const entry = mcpEntry(ctx.bin);
      out.push({
        agent: "agy",
        part: "mcp",
        file: f.mcp,
        kind: "json-merge",
        summary: say(ctx.lang).addMcp,
        before: text,
        after: jsonText(setEntry(data, "mcpServers", OWNERSHIP.mcpKey, entry), text),
        preview: JSON.stringify({ mcpServers: { [OWNERSHIP.mcpKey]: entry } }, null, 2),
      });
    }
    if (opts.parts.includes("rules")) {
      const before = readTextOrNull(f.rules);
      const block = rulesText(ctx.lang);
      out.push({ agent: "agy", part: "rules", file: f.rules, kind: "marked-block", summary: say(ctx.lang).newRules("rules/hotseat.md"), before, after: upsertBlock(before, block), preview: block });
    }
    if (opts.parts.includes("hooks")) {
      const { text, data } = readJsonFile(f.hooks, ctx.lang);
      const group = hookGroup(ctx.bin);
      out.push({
        agent: "agy",
        part: "hooks",
        file: f.hooks,
        kind: "json-merge",
        summary: ctx.lang === "en" ? "Add a hook group named hotseat: SessionStart (inject the handoff) and Stop (check before stopping)" : "添加名为 hotseat 的 Hook 组：SessionStart（自动注入交接）和 Stop（收工检查）",
        before: text,
        after: jsonText({ ...data, [OWNERSHIP.agyHookGroup]: group }, text),
        preview: JSON.stringify({ [OWNERSHIP.agyHookGroup]: group }, null, 2),
      });
    }
    return out.filter((c) => c.before !== c.after);
  },

  async planUninstall(ctx) {
    const f = files(ctx);
    const out: PlannedChange[] = [];
    const mcp = readJsonFile(f.mcp, ctx.lang);
    if (isObj(mcp.data.mcpServers) && OWNERSHIP.mcpKey in mcp.data.mcpServers) {
      out.push({ agent: "agy", part: "mcp", file: f.mcp, kind: "json-merge", summary: say(ctx.lang).removeMcp, before: mcp.text, after: jsonText(setEntry(mcp.data, "mcpServers", OWNERSHIP.mcpKey, undefined), mcp.text) });
    }
    const rules = readTextOrNull(f.rules);
    if (rules !== null) {
      out.push({ agent: "agy", part: "rules", file: f.rules, kind: "marked-block", summary: say(ctx.lang).removeRules("rules/hotseat.md"), before: rules, after: removeBlock(rules) });
    }
    const hooks = readJsonFile(f.hooks, ctx.lang);
    if (OWNERSHIP.agyHookGroup in hooks.data) {
      const { [OWNERSHIP.agyHookGroup]: _ours, ...rest } = hooks.data;
      out.push({
        agent: "agy",
        part: "hooks",
        file: f.hooks,
        kind: "json-merge",
        summary: ctx.lang === "en" ? "Remove the hotseat hook group" : "移除 hotseat Hook 组",
        before: hooks.text,
        after: Object.keys(rest).length === 0 && hooks.text !== null ? null : jsonText(rest, hooks.text),
      });
    }
    return out;
  },

  async doctor(ctx) {
    const f = files(ctx);
    const fix = "hotseat init --only agy";
    const checks: DoctorCheck[] = [];
    const get = (path: string) => {
      try {
        return readJsonFile(path, ctx.lang).data;
      } catch {
        return {};
      }
    };
    const servers = get(f.mcp).mcpServers;
    const entry = isObj(servers) && isObj(servers[OWNERSHIP.mcpKey]) ? (servers[OWNERSHIP.mcpKey] as Record<string, unknown>) : null;
    checks.push(
      entry?.command === ctx.bin
        ? { agent: "agy", part: "mcp", ok: true, message: say(ctx.lang).mcpOk }
        : { agent: "agy", part: "mcp", ok: false, message: entry ? say(ctx.lang).mcpElsewhere(String(entry.command), ctx.bin) : say(ctx.lang).mcpMissing(f.mcp), fix },
    );
    checks.push(
      readTextOrNull(f.rules)?.includes(OWNERSHIP.rulesBegin)
        ? { agent: "agy", part: "rules", ok: true, message: ctx.lang === "en" ? "Rules file written" : "规则文件已写入" }
        : { agent: "agy", part: "rules", ok: false, message: ctx.lang === "en" ? `Missing ${f.rules}` : `缺少 ${f.rules}`, fix },
    );
    const hooks = get(f.hooks);
    const group = hooks[OWNERSHIP.agyHookGroup];
    const problems = agyHooksProblems(hooks);
    const ours = problems.filter((p) => p.group === OWNERSHIP.agyHookGroup);
    const others = [...new Set(problems.filter((p) => p.group !== OWNERSHIP.agyHookGroup).map((p) => p.group))];
    if (!isObj(group) || !Array.isArray(group.SessionStart) || !Array.isArray(group.Stop) || group.enabled === false) {
      checks.push({ agent: "agy", part: "hooks", ok: false, message: ctx.lang === "en" ? `No enabled hotseat hook group in ${f.hooks}` : `${f.hooks} 里没有启用的 hotseat Hook 组`, fix });
    } else if (ours.length > 0) {
      checks.push({ agent: "agy", part: "hooks", ok: false, message: ctx.lang === "en" ? `The hotseat hook group is malformed (${ours.map((p) => p.event).join(", ")}); agy will skip the whole hooks.json` : `hotseat Hook 组的格式不对（${ours.map((p) => p.event).join("、")}），agy 会跳过整个 hooks.json`, fix });
    } else {
      checks.push({ agent: "agy", part: "hooks", ok: true, message: ctx.lang === "en" ? "hotseat hook group configured, format OK" : "hotseat Hook 组已配置，格式正确" });
    }
    if (others.length > 0) {
      checks.push({ agent: "agy", part: "hooks", ok: false, message: ctx.lang === "en" ? `${others.join(", ")} in hooks.json are malformed; agy will skip the whole file, including Hotseat's hooks` : `hooks.json 里 ${others.join("、")} 的格式不对，agy 会跳过整个文件，Hotseat 的 Hook 也不会生效`, fix: ctx.lang === "en" ? `Fix those hook groups in ${f.hooks} by hand` : `手动修正 ${f.hooks} 里的这些 Hook 组` });
    }
    let mtime = 0;
    try {
      mtime = statSync(f.hooks).mtimeMs;
    } catch {
      // 文件不存在，上面已经报过
    }
    const failure = mtime ? agyLogParseFailure(agyLogPath(ctx.home), f.hooks, mtime) : null;
    if (failure) checks.push({ agent: "agy", part: "hooks", ok: false, message: ctx.lang === "en" ? `agy's log says hooks.json failed to parse: ${failure}` : `agy 日志显示 hooks.json 解析失败：${failure}`, fix });
    return checks;
  },

  parseHookInput: (event, raw, env) => normalizeHookInput("agy", event, raw, env),
  renderHookOutput: (decision) => renderHookOutput("agy", decision),
};
