// 通用适配器：大多数工具只是「MCP 写在哪个 JSON、规则写在哪个文件、Hook 写在哪个文件、用什么格式」不同，
// 用一份描述（AgentSpec）生成完整的适配器：安装、卸载（逐字节还原）、doctor、Hook 输入输出。
// 不能自动写入的部分（只能在界面里添加的 MCP、只能在设置里填的规则）生成 manual 改动，init 时展示要粘贴的内容。
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Adapter, AdapterContext, DoctorCheck, PlannedChange, Tier } from "../contracts/adapter.ts";
import { OWNERSHIP, hookCommand, isHotseatHookCommand } from "../contracts/adapter.ts";
import type { AgentId, InstallPart } from "../contracts/common.ts";
import { HOOK_LIMITS, type HookEvent, type HookFamily } from "../contracts/hooks.ts";
import { homePath, readTextOrNull } from "../core/util.ts";
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
    /** file 可以给多个候选（例如同一个扩展装在 VS Code、Cursor 里）：写入所有目录已存在的；都不存在就写第一个 */
    | { kind: "json"; file: (ctx: Ctx) => string | string[]; key: string; entry: (bin: string, agent: AgentId) => Json }
    | { kind: "manual"; where: string };
  rules?:
    | { kind: "block"; file: PathFn }
    | { kind: "manual"; where: string }
    /** 规则写进 Hotseat 自己的文件，再把这个文件的路径加进配置里的数组（Kilo Code 的 instructions） */
    | { kind: "listed"; file: PathFn; config: PathFn; key: string };
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

/** 候选路径里目录已经存在的那些；一个都没有就用第一个 */
export function pickFiles(paths: string | string[]): string[] {
  const all = Array.isArray(paths) ? paths : [paths];
  const found = all.filter((p) => existsSync(dirname(p)));
  return found.length > 0 ? found : all.slice(0, 1);
}

/**
 * 这个文件在 Hotseat 第一次改它之前的内容（从最早的一份备份里找）。
 * 返回 null：没有备份（文件是 Hotseat 新建的），或者最早的备份里已经有 Hotseat 的条目（也说明是 Hotseat 建的）。
 */
function originalJson(ctx: Ctx, file: string): Json | null {
  try {
    const root = homePath(ctx.hotseatHome, "backups");
    for (const run of readdirSync(root).sort()) {
      const text = readTextOrNull(join(root, run, file.replace(/^\/+/, "")));
      if (text === null) continue;
      if (text.includes(`"${OWNERSHIP.mcpKey}"`) || text.includes(".hotseat/bin/hotseat")) return null;
      return tryReadJson(join(root, run, file.replace(/^\/+/, "")))?.data ?? null;
    }
  } catch {
    // 没有备份目录
  }
  return null;
}

/** 去掉 Hotseat 的条目后，原文件里本来就是空对象的键（例如 Cline 默认的 "mcpServers": {}）要留着 */
function keepEmptyKeys(next: Json, orig: Json | null): Json {
  if (!orig) return next;
  const out = { ...next };
  for (const [k, v] of Object.entries(orig)) if (isObj(v) && Object.keys(v).length === 0 && !(k in out)) out[k] = {};
  return out;
}

function tryReadJson(file: string): { text: string | null; data: Json } | null {
  try {
    return readJsonFile(file);
  } catch {
    return null;
  }
}

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
        ...(spec.mcp?.kind === "json" ? pickFiles(spec.mcp.file(ctx)) : []),
        spec.rules?.kind === "block" || spec.rules?.kind === "listed" ? spec.rules.file(ctx) : null,
        spec.rules?.kind === "listed" ? spec.rules.config(ctx) : null,
        spec.hooks ? spec.hooks.file(ctx) : null,
      ].filter((p): p is string => p !== null);
      return { installed: found.length > 0, version: null, configPaths: [...new Set(paths)], notes: found.length > 0 ? (spec.notes ?? []) : [] };
    },

    async planInstall(ctx, opts) {
      const out: PlannedChange[] = [];
      // 同一个 JSON 文件里有多处改动（例如 settings.json 里 MCP 和 Hook）：后一处接着前一处的结果算
      const state = new Map<string, { text: string | null; data: Json }>();
      const manual = (part: InstallPart, where: string, summary: string, preview: string, steps: string[]) =>
        out.push({ agent: id, part, file: where, kind: "manual", summary, before: null, after: null, preview, manualSteps: steps });
      const jsonStep = (part: InstallPart, file: string, summary: string, change: (d: Json) => Json, preview: string) => {
        const cur = state.get(file) ?? tryReadJson(file);
        // 文件不是标准 JSON（例如带注释的 jsonc）：不去改它，给出要手动粘贴的片段
        if (!cur) return manual(part, file, "这个文件带注释或不是标准 JSON，Hotseat 不改它，请手动加入下面的内容", preview, [`打开 ${file}，把上面的内容合并进去`]);
        const next = change(cur.data);
        const after = jsonText(next, cur.text);
        out.push({ agent: id, part, file, kind: "json-merge", summary, before: cur.text, after, preview });
        state.set(file, { text: after, data: next });
      };

      if (spec.mcp && opts.parts.includes("mcp")) {
        if (spec.mcp.kind === "json") {
          const { key, entry } = spec.mcp;
          const value = entry(ctx.bin, id);
          for (const file of pickFiles(spec.mcp.file(ctx))) {
            jsonStep("mcp", file, `添加 MCP 服务 hotseat（${key}）`, (d) => setEntry(d, key, OWNERSHIP.mcpKey, value), JSON.stringify({ [key]: { [OWNERSHIP.mcpKey]: value } }, null, 2));
          }
        } else {
          const value = { mcpServers: { [OWNERSHIP.mcpKey]: { command: ctx.bin, args: ["mcp"], env: { HOTSEAT_AGENT: id } } } };
          manual("mcp", spec.mcp.where, "需要手动添加 MCP 服务（这个工具只能在界面里添加）", JSON.stringify(value, null, 2), [`打开 ${spec.mcp.where}，粘贴上面的 JSON`]);
        }
      }
      if (spec.rules && opts.parts.includes("rules")) {
        const block = rulesText(ctx.lang);
        if (spec.rules.kind === "block" || spec.rules.kind === "listed") {
          const file = spec.rules.file(ctx);
          const before = readTextOrNull(file);
          out.push({ agent: id, part: "rules", file, kind: "marked-block", summary: before === null ? "新建规则文件，写入 Hotseat 规则片段" : "在规则文件末尾加入 Hotseat 规则片段", before, after: upsertBlock(before, block), preview: block });
          if (spec.rules.kind === "listed") {
            const key = spec.rules.key;
            jsonStep("rules", spec.rules.config(ctx), `把规则文件加进 ${key}`, (d) => addToList(d, key, file), JSON.stringify({ [key]: [file] }, null, 2));
          }
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
        const cur = state.get(file) ?? tryReadJson(file);
        if (!cur || cur.text === null) return;
        const orig = originalJson(ctx, file);
        const next = keepEmptyKeys(change(cur.data), orig);
        if (JSON.stringify(next) === JSON.stringify(cur.data)) return;
        // Hotseat 新建的文件，去掉自己的内容后什么都不剩，就删掉
        const after = Object.keys(next).length === 0 && !orig ? null : jsonText(next, cur.text);
        out.push({ agent: id, part, file, kind: "json-merge", summary, before: cur.text, after });
        state.set(file, { text: after, data: next });
      };
      if (spec.mcp?.kind === "json") {
        const key = spec.mcp.key;
        const all = spec.mcp.file(ctx);
        for (const file of Array.isArray(all) ? all : [all]) jsonStep("mcp", file, "移除 MCP 服务 hotseat", (d) => setEntry(d, key, OWNERSHIP.mcpKey, undefined));
      }
      if (spec.rules?.kind === "listed") {
        const { key } = spec.rules;
        const file = spec.rules.file(ctx);
        jsonStep("rules", spec.rules.config(ctx), `从 ${key} 里移除规则文件`, (d) => removeFromList(d, key, file));
      }
      if (spec.hooks?.kind === "json") jsonStep("hooks", spec.hooks.file(ctx), "移除 Hotseat 的 Hook", stripClaudeHooks);
      if (spec.hooks?.kind === "toml") {
        const file = spec.hooks.file(ctx);
        const text = readTextOrNull(file);
        if (text?.includes(TOML_BEGIN)) out.push({ agent: id, part: "hooks", file, kind: "toml-merge", summary: "移除 Hotseat 的 Hook", before: text, after: removeTomlBlock(text) });
      }
      if (spec.rules?.kind === "block" || spec.rules?.kind === "listed") {
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
        for (const file of pickFiles(spec.mcp.file(ctx))) {
          const data = json(file);
          const group = data && isObj(data[spec.mcp.key]) ? (data[spec.mcp.key] as Json) : null;
          const entry = group && isObj(group[OWNERSHIP.mcpKey]) ? (group[OWNERSHIP.mcpKey] as Json) : null;
          if (data) checks.push(!entry ? bad("mcp", `${file} 里没有 hotseat MCP 服务`) : !JSON.stringify(entry).includes(JSON.stringify(ctx.bin)) ? bad("mcp", `MCP 服务没有指向 ${ctx.bin}`) : ok("mcp", "MCP 服务已配置"));
        }
      } else if (spec.mcp) checks.push(ok("mcp", `MCP 服务需要在 ${spec.mcp.where} 手动添加，无法自动检查`));
      if (spec.rules?.kind === "block" || spec.rules?.kind === "listed") {
        const file = spec.rules.file(ctx);
        checks.push(readTextOrNull(file)?.includes(OWNERSHIP.rulesBegin) ? ok("rules", "规则片段已写入") : bad("rules", `${file} 里没有 Hotseat 规则片段`));
        if (spec.rules.kind === "listed") {
          const data = json(spec.rules.config(ctx));
          const list = data?.[spec.rules.key];
          if (data) checks.push(Array.isArray(list) && list.includes(file) ? ok("rules", `规则文件已加进 ${spec.rules.key}`) : bad("rules", `${spec.rules.config(ctx)} 的 ${spec.rules.key} 里没有 ${file}`));
        }
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

/** 数组里加一项（已有就不动） */
export function addToList(data: Json, key: string, item: string): Json {
  const list = Array.isArray(data[key]) ? (data[key] as unknown[]) : [];
  return list.includes(item) ? data : { ...data, [key]: [...list, item] };
}

/** 数组里删掉一项；删空后连 key 一起删掉 */
export function removeFromList(data: Json, key: string, item: string): Json {
  if (!Array.isArray(data[key])) return data;
  const list = (data[key] as unknown[]).filter((x) => x !== item);
  const out = { ...data };
  if (list.length === 0) delete out[key];
  else out[key] = list;
  return out;
}

/** VS Code 系编辑器的用户数据目录（扩展的 globalStorage 在这下面） */
export function editorUserDirs(ctx: Ctx, apps: readonly string[] = ["Code", "Code - Insiders", "Cursor", "Windsurf", "VSCodium"]): string[] {
  const base = ctx.platform === "darwin" ? join(ctx.home, "Library", "Application Support") : join(ctx.env.XDG_CONFIG_HOME ?? join(ctx.home, ".config"));
  return apps.map((a) => join(base, a, "User"));
}
