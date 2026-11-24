// 通用适配器：大多数工具只是「MCP 写在哪个 JSON、规则写在哪个文件、Hook 写在哪个文件、用什么格式」不同，
// 用一份描述（AgentSpec）生成完整的适配器：安装、卸载（逐字节还原）、doctor、Hook 输入输出。
// 不能自动写入的部分（只能在界面里添加的 MCP、只能在设置里填的规则）生成 manual 改动，init 时展示要粘贴的内容。
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, AdapterContext, DoctorCheck, PlannedChange, Tier } from "../contracts/adapter.ts";
import { OWNERSHIP, hookCommand, isHotseatHookCommand } from "../contracts/adapter.ts";
import type { AgentId, InstallPart } from "../contracts/common.ts";
import { HOOK_LIMITS, type HookEvent, type HookFamily } from "../contracts/hooks.ts";
import { readTextOrNull } from "../core/util.ts";
import { normalizeHookInput, renderHookOutput } from "../hooks/normalize.ts";
import { hasClaudeHook, isObj, jsonText, mergeClaudeHooks, readJsonFile, removeBlock, rulesText, setEntry, stripClaudeHooks, upsertBlock, type Json } from "./shared.ts";

type Ctx = AdapterContext;
type PathFn = (ctx: Ctx) => string;

export interface AgentSpec {
  id: AgentId;
  displayName: string;
  tier: Tier;
  hookFamily: HookFamily | null;
  maxContextChars: number;
  /** 只看用户主目录下的文件或目录（不看 /Applications，测试用临时主目录时不受开发机影响） */
  detect: (ctx: Ctx) => string[];
  notes?: string[];
  afterInstall?: string[];
  mcp?:
    | { kind: "json"; file: PathFn; key: string; entry: (bin: string, agent: AgentId) => Json }
    | { kind: "manual"; where: string };
  rules?: { kind: "block"; file: PathFn } | { kind: "manual"; where: string };
  hooks?:
    | { kind: "json"; file: PathFn; events: Record<string, HookEvent>; extra?: Record<string, Json> }
    | { kind: "toml"; file: PathFn; events: Record<string, HookEvent> };
}

// ---------- TOML 里的 [[hooks]] 标记块（Kimi Code） ----------

const TOML_BEGIN = "# hotseat:begin";
const TOML_END = "# hotseat:end";
const TOML_BLOCK_RE = /\n?# hotseat:begin\n[\s\S]*?# hotseat:end\n?/;

export function tomlHooksBlock(events: Record<string, string>): string {
  const body = Object.entries(events)
    .map(([event, command]) => `[[hooks]]\nevent = ${JSON.stringify(event)}\ncommand = ${JSON.stringify(command)}\ntimeout = ${HOOK_LIMITS.configTimeoutSec}`)
    .join("\n\n");
  return `${TOML_BEGIN}\n${body}\n${TOML_END}`;
}

export function upsertTomlBlock(text: string | null, block: string): string {
  const cur = text ?? "";
  if (TOML_BLOCK_RE.test(cur)) return cur.replace(TOML_BLOCK_RE, (m) => `${m.startsWith("\n") ? "\n" : ""}${block}\n`);
  const sep = cur === "" ? "" : cur.endsWith("\n") ? "\n" : "\n\n";
  return `${cur}${sep}${block}\n`;
}

export function removeTomlBlock(text: string | null): string | null {
  if (text === null) return null;
  const m = TOML_BLOCK_RE.exec(text);
  if (!m) return text;
  let out = text.slice(0, m.index) + text.slice(m.index + m[0].length);
  if (m.index === 0) out = out.replace(/^\n+/, "");
  // 安装时在原文末尾补的空行一并去掉，逐字节还原
  else if (m.index === out.length && out.endsWith("\n\n")) out = out.slice(0, -1);
  return out.trim() === "" ? null : out;
}

// ---------- 生成适配器 ----------

export function makeAdapter(spec: AgentSpec): Adapter {
  const id = spec.id;
  const commands = (ctx: Ctx, events: Record<string, HookEvent>) =>
    Object.fromEntries(Object.entries(events).map(([name, ev]) => [name, hookCommand(ctx.bin, id, ev)]));

  return {
    id,
    displayName: spec.displayName,
    tier: spec.tier,
    experimental: true,
    hookFamily: spec.hookFamily,
    maxContextChars: spec.maxContextChars,
    afterInstall: spec.afterInstall,

    async detect(ctx) {
      const found = spec.detect(ctx).filter((p) => existsSync(p));
      const paths = [
        spec.mcp?.kind === "json" ? spec.mcp.file(ctx) : null,
        spec.rules?.kind === "block" ? spec.rules.file(ctx) : null,
        spec.hooks ? spec.hooks.file(ctx) : null,
      ].filter((p): p is string => p !== null);
      return { installed: found.length > 0, version: null, configPaths: [...new Set(paths)], notes: found.length > 0 ? (spec.notes ?? []) : [] };
    },

    async planInstall(ctx, opts) {
      const out: PlannedChange[] = [];
      // 同一个 JSON 文件里有多处改动（例如 settings.json 里 MCP 和 Hook）：后一处接着前一处的结果算
      const state = new Map<string, { text: string | null; data: Json }>();
      const jsonStep = (part: InstallPart, file: string, summary: string, change: (d: Json) => Json, preview: string) => {
        const cur = state.get(file) ?? readJsonFile(file);
        const next = change(cur.data);
        const after = jsonText(next, cur.text);
        out.push({ agent: id, part, file, kind: "json-merge", summary, before: cur.text, after, preview });
        state.set(file, { text: after, data: next });
      };
      const manual = (part: InstallPart, where: string, summary: string, preview: string, steps: string[]) =>
        out.push({ agent: id, part, file: where, kind: "manual", summary, before: null, after: null, preview, manualSteps: steps });

      if (spec.mcp && opts.parts.includes("mcp")) {
        if (spec.mcp.kind === "json") {
          const { key, entry } = spec.mcp;
          const value = entry(ctx.bin, id);
          jsonStep("mcp", spec.mcp.file(ctx), `添加 MCP 服务 hotseat（${key}）`, (d) => setEntry(d, key, OWNERSHIP.mcpKey, value), JSON.stringify({ [key]: { [OWNERSHIP.mcpKey]: value } }, null, 2));
        } else {
          const value = { mcpServers: { [OWNERSHIP.mcpKey]: { command: ctx.bin, args: ["mcp"], env: { HOTSEAT_AGENT: id } } } };
          manual("mcp", spec.mcp.where, "需要手动添加 MCP 服务（这个工具只能在界面里添加）", JSON.stringify(value, null, 2), [`打开 ${spec.mcp.where}，粘贴上面的 JSON`]);
        }
      }
      if (spec.rules && opts.parts.includes("rules")) {
        const block = rulesText(ctx.lang);
        if (spec.rules.kind === "block") {
          const file = spec.rules.file(ctx);
          const before = readTextOrNull(file);
          out.push({ agent: id, part: "rules", file, kind: "marked-block", summary: before === null ? "新建规则文件，写入 Hotseat 规则片段" : "在规则文件末尾加入 Hotseat 规则片段", before, after: upsertBlock(before, block), preview: block });
        } else {
          manual("rules", spec.rules.where, "需要手动粘贴规则（这个工具的用户级规则只能在设置里填）", rulesText(ctx.lang, false), [`打开 ${spec.rules.where}，粘贴上面的规则；也可以运行 hotseat rules 打印`]);
        }
      }
      if (spec.hooks && opts.parts.includes("hooks")) {
        const cmds = commands(ctx, spec.hooks.events);
        const preview = Object.entries(cmds).map(([e, c]) => `${e}: ${c}`).join("\n");
        const summary = `添加 ${Object.keys(cmds).join("、")} Hook（自动注入交接、收工检查）`;
        if (spec.hooks.kind === "json") {
          const extra = spec.hooks.extra;
          jsonStep("hooks", spec.hooks.file(ctx), summary, (d) => mergeClaudeHooks(d, cmds, extra), preview);
        } else {
          const file = spec.hooks.file(ctx);
          const before = readTextOrNull(file);
          out.push({ agent: id, part: "hooks", file, kind: "toml-merge", summary, before, after: upsertTomlBlock(before, tomlHooksBlock(cmds)), preview });
        }
      }
      return out.filter((c) => c.kind === "manual" || c.before !== c.after);
    },

    async planUninstall(ctx) {
      const out: PlannedChange[] = [];
      const state = new Map<string, { text: string | null; data: Json }>();
      const jsonStep = (part: InstallPart, file: string, summary: string, change: (d: Json) => Json) => {
        const cur = state.get(file) ?? readJsonFile(file);
        if (cur.text === null) return;
        const next = change(cur.data);
        if (JSON.stringify(next) === JSON.stringify(cur.data)) return;
        // Hotseat 新建的文件，去掉自己的内容后什么都不剩，就删掉
        const after = Object.keys(next).length === 0 ? null : jsonText(next, cur.text);
        out.push({ agent: id, part, file, kind: "json-merge", summary, before: cur.text, after });
        state.set(file, { text: after, data: next });
      };
      if (spec.mcp?.kind === "json") {
        const key = spec.mcp.key;
        jsonStep("mcp", spec.mcp.file(ctx), "移除 MCP 服务 hotseat", (d) => setEntry(d, key, OWNERSHIP.mcpKey, undefined));
      }
      if (spec.hooks?.kind === "json") jsonStep("hooks", spec.hooks.file(ctx), "移除 Hotseat 的 Hook", stripClaudeHooks);
      if (spec.hooks?.kind === "toml") {
        const file = spec.hooks.file(ctx);
        const text = readTextOrNull(file);
        if (text?.includes(TOML_BEGIN)) out.push({ agent: id, part: "hooks", file, kind: "toml-merge", summary: "移除 Hotseat 的 Hook", before: text, after: removeTomlBlock(text) });
      }
      if (spec.rules?.kind === "block") {
        const file = spec.rules.file(ctx);
        const text = readTextOrNull(file);
        if (text?.includes(OWNERSHIP.rulesBegin)) out.push({ agent: id, part: "rules", file, kind: "marked-block", summary: "移除 Hotseat 规则片段", before: text, after: removeBlock(text) });
      }
      return out;
    },

    async doctor(ctx) {
      const fix = `hotseat init --only ${id}`;
      const checks: DoctorCheck[] = [];
      const ok = (part: DoctorCheck["part"], message: string): DoctorCheck => ({ agent: id, part, ok: true, message });
      const bad = (part: DoctorCheck["part"], message: string): DoctorCheck => ({ agent: id, part, ok: false, message, fix });
      const json = (file: string): Json | null => {
        try {
          return readJsonFile(file).data;
        } catch (e) {
          checks.push(bad("mcp", (e as Error).message));
          return null;
        }
      };
      if (spec.mcp?.kind === "json") {
        const file = spec.mcp.file(ctx);
        const data = json(file);
        const group = data && isObj(data[spec.mcp.key]) ? (data[spec.mcp.key] as Json) : null;
        const entry = group && isObj(group[OWNERSHIP.mcpKey]) ? (group[OWNERSHIP.mcpKey] as Json) : null;
        if (data) checks.push(!entry ? bad("mcp", `${file} 里没有 hotseat MCP 服务`) : !JSON.stringify(entry).includes(JSON.stringify(ctx.bin)) ? bad("mcp", `MCP 服务没有指向 ${ctx.bin}`) : ok("mcp", "MCP 服务已配置"));
      } else if (spec.mcp) checks.push(ok("mcp", `MCP 服务需要在 ${spec.mcp.where} 手动添加，无法自动检查`));
      if (spec.rules?.kind === "block") {
        const file = spec.rules.file(ctx);
        checks.push(readTextOrNull(file)?.includes(OWNERSHIP.rulesBegin) ? ok("rules", "规则片段已写入") : bad("rules", `${file} 里没有 Hotseat 规则片段`));
      } else if (spec.rules) checks.push(ok("rules", `规则需要在 ${spec.rules.where} 手动粘贴，无法自动检查`));
      if (spec.hooks?.kind === "json") {
        const file = spec.hooks.file(ctx);
        const data = json(file);
        for (const event of Object.keys(spec.hooks.events)) {
          if (data) checks.push(hasClaudeHook(data, event) ? ok("hooks", `${event} Hook 已配置`) : bad("hooks", `${file} 里没有 ${event} Hook`));
        }
      } else if (spec.hooks?.kind === "toml") {
        const file = spec.hooks.file(ctx);
        const text = readTextOrNull(file) ?? "";
        const block = TOML_BLOCK_RE.exec(text)?.[0] ?? "";
        for (const event of Object.keys(spec.hooks.events)) {
          const has = block.includes(`event = ${JSON.stringify(event)}`) && block.split("\n").some((l) => l.startsWith("command = ") && isHotseatHookCommand(JSON.parse(l.slice(10))));
          checks.push(has ? ok("hooks", `${event} Hook 已配置`) : bad("hooks", `${file} 里没有 ${event} Hook`));
        }
      }
      return checks;
    },

    parseHookInput: (event, raw, env) => normalizeHookInput(id, event, raw, env),
    renderHookOutput: (decision) => renderHookOutput(id, decision),
  };
}

export const homeJoin = (...parts: string[]) => (ctx: Ctx) => join(ctx.home, ...parts);
