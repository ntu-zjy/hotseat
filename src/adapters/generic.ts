// 通用适配器：大多数工具只是「MCP 写在哪个 JSON、规则写在哪个文件、Hook 写在哪个文件、用什么格式」不同，
// 用一份描述（AgentSpec）生成完整的适配器：安装、卸载（逐字节还原）、doctor、Hook 输入输出。
// 不能自动写入的部分（只能在界面里添加的 MCP、只能在设置里填的规则）生成 manual 改动，init 时展示要粘贴的内容。
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Adapter, AdapterContext, DoctorCheck, PlannedChange, Text, Tier } from "../contracts/adapter.ts";
import { OWNERSHIP, hookCommand, isHotseatHookCommand } from "../contracts/adapter.ts";
import type { AgentId, InstallPart } from "../contracts/common.ts";
import { HOOK_LIMITS, type HookEvent, type HookFamily } from "../contracts/hooks.ts";
import { homePath, readTextOrNull } from "../core/util.ts";
import { normalizeHookInput, renderHookOutput } from "../hooks/normalize.ts";
import { hasClaudeHook, isObj, jsonText, mergeClaudeHooks, readJsonFile, removeBlock, rulesText, say, setEntry, stripClaudeHooks, upsertBlock, type Json } from "./shared.ts";

type Ctx = AdapterContext;
type PathFn = (ctx: Ctx) => string;

export interface AgentSpec {
  id: AgentId;
  displayName: string;
  displayNameEn?: string;
  /** 在真实工具里测过接力的，init 不再标实验性 */
  tested?: boolean;
  tier: Tier;
  hookFamily: HookFamily | null;
  maxContextChars: number;
  /** 只看用户主目录下的文件或目录（不看 /Applications，测试用临时主目录时不受开发机影响） */
  detect: (ctx: Ctx) => string[];
  notes?: Text[];
  afterInstall?: Text[];
  mcp?:
    /** file 可以给多个候选（例如同一个扩展装在 VS Code、Cursor 里）：写入所有目录已存在的；都不存在就写第一个 */
    | { kind: "json"; file: (ctx: Ctx) => string | string[]; key: string; entry: (bin: string, agent: AgentId) => Json }
    | { kind: "manual"; where: Text };
  rules?:
    | { kind: "block"; file: PathFn }
    | { kind: "manual"; where: Text }
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

/**
 * 认出 Hotseat 写入的 [[hooks]] 表：看 command 是不是 Hotseat 的 Hook 命令，不靠注释标记。
 * Kimi Code 登录、切模型时会把 config.toml 整份重写，注释（包括 # hotseat:begin/end）会被删掉，Hook 本身还在。
 */
const TOML_HEADER_RE = /^\[\[?[A-Za-z0-9_."-]+\]\]?\s*(#.*)?$/;

function tomlString(line: string | undefined): string | null {
  const m = line && /^\s*("(?:[^"\\]|\\.)*"|'[^']*')/.exec(line);
  if (!m) return null;
  const v = m[1] as string;
  try {
    return v.startsWith("'") ? v.slice(1, -1) : (JSON.parse(v) as string);
  } catch {
    return null;
  }
}

/** 文件里 Hotseat 的 [[hooks]] 表：每张表的起止行号（含后面紧跟的空行）和事件名 */
function ourTomlHooks(text: string): { start: number; end: number; event: string | null }[] {
  const lines = text.split("\n");
  const out: { start: number; end: number; event: string | null }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] as string).trim() !== "[[hooks]]") continue;
    let j = i + 1;
    const fields: Record<string, string | null> = {};
    // 表的内容：直到空行、注释或下一个表头
    while (j < lines.length && (lines[j] as string).trim() !== "" && !(lines[j] as string).trimStart().startsWith("#") && !TOML_HEADER_RE.test(lines[j] as string)) {
      const m = /^\s*([A-Za-z_]+)\s*=(.*)$/.exec(lines[j] as string);
      if (m) fields[m[1] as string] = tomlString(m[2]);
      j++;
    }
    const command = fields.command;
    if (command && isHotseatHookCommand(command)) {
      let end = j;
      while (end < lines.length && (lines[end] as string).trim() === "") end++;
      out.push({ start: i, end, event: fields.event ?? null });
    }
    i = j - 1;
  }
  return out;
}

/** 去掉标记块，再去掉没有标记的 Hotseat [[hooks]] 表（被重写过的文件）。 */
export function removeTomlHooks(text: string | null): string | null {
  if (text === null) return null;
  let out = removeTomlBlock(text);
  if (out === null) return null;
  const ours = ourTomlHooks(out);
  if (ours.length === 0) return out;
  const lines = out.split("\n");
  const drop = new Set(ours.flatMap((h) => Array.from({ length: h.end - h.start }, (_, k) => h.start + k)));
  out = lines.filter((_, i) => !drop.has(i)).join("\n");
  out = out.replace(/\n{2,}$/, "\n");
  return out.trim() === "" ? null : out;
}

export function tomlHookEvents(text: string | null): string[] {
  return text ? ourTomlHooks(text).map((h) => h.event).filter((e): e is string => e !== null) : [];
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
function originalJson(ctx: Ctx, file: string): { text: string; data: Json } | null {
  try {
    const root = homePath(ctx.hotseatHome, "backups");
    for (const run of readdirSync(root).sort()) {
      const text = readTextOrNull(join(root, run, file.replace(/^\/+/, "")));
      if (text === null) continue;
      if (text.includes(`"${OWNERSHIP.mcpKey}"`) || text.includes(".hotseat/bin/hotseat")) return null;
      const data = tryReadJson(join(root, run, file.replace(/^\/+/, "")))?.data;
      return data ? { text, data } : null;
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
    displayNameEn: spec.displayNameEn,
    tier: spec.tier,
    experimental: !spec.tested,
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
      return { installed: found.length > 0, version: null, configPaths: [...new Set(paths)], notes: found.length > 0 ? (spec.notes ?? []).map((n) => n[ctx.lang]) : [] };
    },

    async planInstall(ctx, opts) {
      const t = say(ctx.lang);
      const out: PlannedChange[] = [];
      // 同一个 JSON 文件里有多处改动（例如 settings.json 里 MCP 和 Hook）：后一处接着前一处的结果算
      const state = new Map<string, { text: string | null; data: Json }>();
      const manual = (part: InstallPart, where: string, summary: string, preview: string, steps: string[]) =>
        out.push({ agent: id, part, file: where, kind: "manual", summary, before: null, after: null, preview, manualSteps: steps });
      const jsonStep = (part: InstallPart, file: string, summary: string, change: (d: Json) => Json, preview: string) => {
        const cur = state.get(file) ?? tryReadJson(file);
        // 文件不是标准 JSON（例如带注释的 jsonc）：不去改它，给出要手动粘贴的片段
        if (!cur) return manual(part, file, t.manualJsonc, preview, [t.manualJsoncStep(file)]);
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
            jsonStep("mcp", file, t.addMcpUnder(key), (d) => setEntry(d, key, OWNERSHIP.mcpKey, value), JSON.stringify({ [key]: { [OWNERSHIP.mcpKey]: value } }, null, 2));
          }
        } else {
          const value = { mcpServers: { [OWNERSHIP.mcpKey]: { command: ctx.bin, args: ["mcp"], env: { HOTSEAT_AGENT: id } } } };
          const where = spec.mcp.where[ctx.lang];
          manual("mcp", where, t.manualMcp, JSON.stringify(value, null, 2), [t.manualMcpStep(where)]);
        }
      }
      if (spec.rules && opts.parts.includes("rules")) {
        const block = rulesText(ctx.lang);
        if (spec.rules.kind === "block" || spec.rules.kind === "listed") {
          const file = spec.rules.file(ctx);
          const before = readTextOrNull(file);
          out.push({ agent: id, part: "rules", file, kind: "marked-block", summary: before === null ? t.newRules(basename(file)) : t.appendRules(basename(file)), before, after: upsertBlock(before, block), preview: block });
          if (spec.rules.kind === "listed") {
            const key = spec.rules.key;
            jsonStep("rules", spec.rules.config(ctx), t.listRules(key), (d) => addToList(d, key, file), JSON.stringify({ [key]: [file] }, null, 2));
          }
        } else {
          const where = spec.rules.where[ctx.lang];
          manual("rules", where, t.manualRules, rulesText(ctx.lang, false), [t.manualRulesStep(where)]);
        }
      }
      if (spec.hooks && opts.parts.includes("hooks")) {
        const cmds = commands(ctx, spec.hooks.events);
        const preview = Object.entries(cmds).map(([e, c]) => `${e}: ${c}`).join("\n");
        const summary = t.addHooks(Object.keys(cmds));
        if (spec.hooks.kind === "json") {
          const extra = spec.hooks.extra;
          jsonStep("hooks", spec.hooks.file(ctx), summary, (d) => mergeClaudeHooks(d, cmds, extra), preview);
        } else {
          const file = spec.hooks.file(ctx);
          const before = readTextOrNull(file);
          // 已经有同样几条 Hook（文件被重写、标记没了也算）就不再改，免得加出第二份
          const have = tomlHookEvents(before);
          const same = before !== null && have.length === Object.keys(cmds).length && Object.entries(cmds).every(([e, c]) => have.includes(e) && before.includes(JSON.stringify(c)));
          if (!same) out.push({ agent: id, part: "hooks", file, kind: "toml-merge", summary, before, after: upsertTomlBlock(removeTomlHooks(before), tomlHooksBlock(cmds)), preview });
        }
      }
      return out.filter((c) => c.kind === "manual" || c.before !== c.after);
    },

    async planUninstall(ctx) {
      const t = say(ctx.lang);
      const out: PlannedChange[] = [];
      const state = new Map<string, { text: string | null; data: Json }>();
      const jsonStep = (part: InstallPart, file: string, summary: string, change: (d: Json) => Json) => {
        const cur = state.get(file) ?? tryReadJson(file);
        if (!cur || cur.text === null) return;
        const orig = originalJson(ctx, file);
        const next = keepEmptyKeys(change(cur.data), orig?.data ?? null);
        if (JSON.stringify(next) === JSON.stringify(cur.data)) return;
        // Hotseat 新建的文件，去掉自己的内容后什么都不剩，就删掉；和改之前内容一样，就把原文逐字节写回（例如压成一行的 JSON）
        const after = Object.keys(next).length === 0 && !orig ? null : orig && JSON.stringify(next) === JSON.stringify(orig.data) ? orig.text : jsonText(next, cur.text);
        out.push({ agent: id, part, file, kind: "json-merge", summary, before: cur.text, after });
        state.set(file, { text: after, data: next });
      };
      if (spec.mcp?.kind === "json") {
        const key = spec.mcp.key;
        const all = spec.mcp.file(ctx);
        for (const file of Array.isArray(all) ? all : [all]) jsonStep("mcp", file, t.removeMcp, (d) => setEntry(d, key, OWNERSHIP.mcpKey, undefined));
      }
      if (spec.rules?.kind === "listed") {
        const { key } = spec.rules;
        const file = spec.rules.file(ctx);
        jsonStep("rules", spec.rules.config(ctx), t.unlistRules(key), (d) => removeFromList(d, key, file));
      }
      if (spec.hooks?.kind === "json") jsonStep("hooks", spec.hooks.file(ctx), t.removeHooks, stripClaudeHooks);
      if (spec.hooks?.kind === "toml") {
        const file = spec.hooks.file(ctx);
        const text = readTextOrNull(file);
        const after = removeTomlHooks(text);
        if (text !== null && after !== text) out.push({ agent: id, part: "hooks", file, kind: "toml-merge", summary: t.removeHooks, before: text, after });
      }
      if (spec.rules?.kind === "block" || spec.rules?.kind === "listed") {
        const file = spec.rules.file(ctx);
        const text = readTextOrNull(file);
        if (text?.includes(OWNERSHIP.rulesBegin)) out.push({ agent: id, part: "rules", file, kind: "marked-block", summary: t.removeRules(basename(file)), before: text, after: removeBlock(text) });
      }
      return out;
    },

    async doctor(ctx) {
      const t = say(ctx.lang);
      const fix = `hotseat init --only ${id}`;
      const checks: DoctorCheck[] = [];
      const ok = (part: DoctorCheck["part"], message: string): DoctorCheck => ({ agent: id, part, ok: true, message });
      const bad = (part: DoctorCheck["part"], message: string): DoctorCheck => ({ agent: id, part, ok: false, message, fix });
      const json = (file: string): Json | null => {
        try {
          return readJsonFile(file, ctx.lang).data;
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
          if (data) checks.push(!entry ? bad("mcp", t.mcpMissing(file)) : !JSON.stringify(entry).includes(JSON.stringify(ctx.bin)) ? bad("mcp", t.mcpNotBin(ctx.bin)) : ok("mcp", t.mcpOk));
        }
      } else if (spec.mcp) checks.push(ok("mcp", t.mcpManual(spec.mcp.where[ctx.lang])));
      if (spec.rules?.kind === "block" || spec.rules?.kind === "listed") {
        const file = spec.rules.file(ctx);
        checks.push(readTextOrNull(file)?.includes(OWNERSHIP.rulesBegin) ? ok("rules", t.rulesOk) : bad("rules", t.rulesMissing(file)));
        if (spec.rules.kind === "listed") {
          const data = json(spec.rules.config(ctx));
          const list = data?.[spec.rules.key];
          if (data) checks.push(Array.isArray(list) && list.includes(file) ? ok("rules", t.rulesListed(spec.rules.key)) : bad("rules", t.rulesNotListed(spec.rules.config(ctx), spec.rules.key, file)));
        }
      } else if (spec.rules) checks.push(ok("rules", t.rulesManual(spec.rules.where[ctx.lang])));
      if (spec.hooks?.kind === "json") {
        const file = spec.hooks.file(ctx);
        const data = json(file);
        for (const event of Object.keys(spec.hooks.events)) {
          if (data) checks.push(hasClaudeHook(data, event) ? ok("hooks", t.hookOk(event)) : bad("hooks", t.hookMissing(file, event)));
        }
      } else if (spec.hooks?.kind === "toml") {
        const file = spec.hooks.file(ctx);
        const have = tomlHookEvents(readTextOrNull(file));
        for (const event of Object.keys(spec.hooks.events)) {
          checks.push(have.includes(event) ? ok("hooks", t.hookOk(event)) : bad("hooks", t.hookMissing(file, event)));
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
