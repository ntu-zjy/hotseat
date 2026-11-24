// 适配器公共部分：规则片段、标记块、JSON 合并、Claude 风格的 Hook 合并。
import type { Lang } from "../contracts/common.ts";
import { HotseatError } from "../contracts/errors.ts";
import { HOOK_LIMITS } from "../contracts/hooks.ts";
import { OWNERSHIP, isHotseatHookCommand } from "../contracts/adapter.ts";
import { readTextOrNull } from "../core/util.ts";

// ---------- 规则片段（PRD §8.3） ----------

const RULES: Record<Lang, string[]> = {
  zh: [
    "## Hotseat 共享上下文",
    "- 开始工作前：如果上下文里还没有「Hotseat 交接」内容，调用 `hotseat.get_context`，按返回的目标、约束和下一步继续，不要重新读整个文件夹。返回「未绑定任务」时照常工作，不要追问用户。",
    "- 每轮有实质进展后、结束前：调用 `hotseat.record_progress`，写清做了什么、决定及理由、放弃的方案、用户提出的要求、做到一半的状态和下一步。当前目录没有绑定任务时不用记录。",
    "- 不要直接修改 memory.md；需要修改时调用 `hotseat.propose_memory_edit`。",
  ],
  en: [
    "## Hotseat shared context",
    "- Before starting work: if your context has no \"Hotseat handoff\" block yet, call `hotseat.get_context` and continue from the goal, constraints and next steps it returns instead of re-reading the whole folder. If it says no task is bound, work normally and don't ask the user about it.",
    "- After real progress and before ending each turn: call `hotseat.record_progress` with what you did, decisions and why, rejected approaches, requirements the user stated, half-done state and next steps. Skip it when no task is bound.",
    "- Never edit memory.md directly; call `hotseat.propose_memory_edit` instead.",
  ],
};

export function rulesText(lang: Lang, markers = true): string {
  const body = RULES[lang].join("\n");
  return markers ? `${OWNERSHIP.rulesBegin}\n${body}\n${OWNERSHIP.rulesEnd}` : body;
}

const BLOCK_RE = /\n?<!-- hotseat:begin -->[\s\S]*?<!-- hotseat:end -->\n?/;

/** 有标记块就替换，没有就追加到末尾（和原内容之间空一行）。 */
export function upsertBlock(text: string | null, block: string): string {
  const cur = text ?? "";
  if (BLOCK_RE.test(cur)) return cur.replace(BLOCK_RE, (m) => `${m.startsWith("\n") ? "\n" : ""}${block}\n`);
  const sep = cur === "" ? "" : cur.endsWith("\n") ? "\n" : "\n\n";
  return `${cur}${sep}${block}\n`;
}

/** 去掉标记块；剩下的内容为空时返回 null，表示可以删除文件。 */
export function removeBlock(text: string | null): string | null {
  if (text === null) return null;
  const m = BLOCK_RE.exec(text);
  if (!m) return text.trim() === "" ? null : text;
  let out = text.slice(0, m.index) + text.slice(m.index + m[0].length);
  if (m.index === 0) out = out.replace(/^\n+/, "");
  return out.trim() === "" ? null : out;
}

// ---------- JSON ----------

export type Json = Record<string, unknown>;

export function readJsonFile(path: string): { text: string | null; data: Json } {
  const text = readTextOrNull(path);
  if (text === null || text.trim() === "") return { text, data: {} };
  try {
    const data: unknown = JSON.parse(text);
    if (data && typeof data === "object" && !Array.isArray(data)) return { text, data: data as Json };
  } catch {
    // 落到下面统一报错
  }
  throw new HotseatError("INVALID_INPUT", `${path} 不是合法的 JSON 对象，Hotseat 不会修改它。请先修好这个文件。`);
}

/** 沿用原文件的缩进（两个空格、四个空格或 Tab）和末尾换行。 */
export function jsonText(data: Json, original: string | null): string {
  const m = original ? /\n([ \t]+)"/.exec(original) : null;
  const indent = m?.[1]?.startsWith("\t") ? "\t" : (m?.[1]?.length ?? 2);
  const body = JSON.stringify(data, null, indent);
  // 沿用原文件末尾有没有换行，保证卸载后逐字节还原
  return original !== null && original !== "" && !original.endsWith("\n") ? body : `${body}\n`;
}

export const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** 设置或删除 obj[key] 下的一个条目；删空后连 key 一起删掉。 */
export function setEntry(obj: Json, key: string, name: string, value: unknown | undefined): Json {
  const group = isObj(obj[key]) ? { ...(obj[key] as Json) } : {};
  if (value === undefined) delete group[name];
  else group[name] = value;
  const out = { ...obj };
  if (Object.keys(group).length === 0) delete out[key];
  else out[key] = group;
  return out;
}

// ---------- Claude 风格的 Hook（Claude、Codex、CodeBuddy、Qoder…） ----------

interface HookHandler {
  type?: string;
  command?: string;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookHandler[];
  [k: string]: unknown;
}

function withoutOurs(groups: unknown): HookGroup[] {
  if (!Array.isArray(groups)) return [];
  return groups
    .filter(isObj)
    .map((g) => {
      const group = g as HookGroup;
      return { ...group, hooks: (group.hooks ?? []).filter((h) => !(isObj(h) && typeof h.command === "string" && isHotseatHookCommand(h.command))) };
    })
    .filter((g) => (g.hooks?.length ?? 0) > 0);
}

/** events：事件名 → 命令。先去掉旧的 Hotseat 条目再追加，保证幂等。 */
export function mergeClaudeHooks(settings: Json, events: Record<string, string>, extra: Record<string, Json> = {}): Json {
  const hooks = isObj(settings.hooks) ? { ...(settings.hooks as Json) } : {};
  for (const [event, command] of Object.entries(events)) {
    hooks[event] = [
      ...withoutOurs(hooks[event]),
      { hooks: [{ type: "command", command, timeout: HOOK_LIMITS.configTimeoutSec, ...(extra[event] ?? {}) }] },
    ];
  }
  return { ...settings, hooks };
}

export function stripClaudeHooks(settings: Json): Json {
  if (!isObj(settings.hooks)) return settings;
  const hooks: Json = {};
  for (const [event, groups] of Object.entries(settings.hooks as Json)) {
    const kept = Array.isArray(groups) ? withoutOurs(groups) : groups;
    if (!Array.isArray(kept) || kept.length > 0) hooks[event] = kept;
  }
  const out = { ...settings };
  if (Object.keys(hooks).length === 0) delete out.hooks;
  else out.hooks = hooks;
  return out;
}

export function hasClaudeHook(settings: Json, event: string): boolean {
  const groups = isObj(settings.hooks) ? (settings.hooks as Json)[event] : undefined;
  return (
    Array.isArray(groups) &&
    groups.some((g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isObj(h) && typeof h.command === "string" && isHotseatHookCommand(h.command)))
  );
}

/** 去掉 Hotseat 的 Hook 后什么都不剩（Hotseat 新建的文件）时返回 null，表示可以删除文件。 */
export function emptyToNull(data: Json, ignoreKeys: readonly string[] = []): Json | null {
  return Object.keys(data).every((k) => ignoreKeys.includes(k)) ? null : data;
}

// ---------- Cursor 风格的 Hook（"version": 1，事件下是扁平的处理程序列表） ----------

const isOurs = (h: unknown) => isObj(h) && typeof h.command === "string" && isHotseatHookCommand(h.command);

/** handlers：事件名 → 处理程序。先去掉旧的 Hotseat 条目再追加，保证幂等。 */
export function mergeFlatHooks(data: Json, handlers: Record<string, Json>): Json {
  const hooks = isObj(data.hooks) ? { ...(data.hooks as Json) } : {};
  for (const [event, handler] of Object.entries(handlers)) {
    const kept = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]).filter((h) => !isOurs(h)) : [];
    hooks[event] = [...kept, handler];
  }
  return { version: 1, ...data, hooks };
}

export function stripFlatHooks(data: Json): Json {
  if (!isObj(data.hooks)) return data;
  const hooks: Json = {};
  for (const [event, list] of Object.entries(data.hooks as Json)) {
    const kept = Array.isArray(list) ? list.filter((h) => !isOurs(h)) : list;
    if (!Array.isArray(kept) || kept.length > 0) hooks[event] = kept;
  }
  const out = { ...data };
  if (Object.keys(hooks).length === 0) delete out.hooks;
  else out.hooks = hooks;
  return out;
}

export function hasFlatHook(data: Json, event: string): boolean {
  const list = isObj(data.hooks) ? (data.hooks as Json)[event] : undefined;
  return Array.isArray(list) && list.some(isOurs);
}

// ---------- TOML（Codex 的 config.toml） ----------
// 只按行处理表头，不解析整个文件，也不重排用户的内容：Hotseat 的表整段追加到末尾，卸载时整段删掉。

const TOML_HEADER = /^[ \t]*\[\[?[ \t]*([^\]\n]+?)[ \t]*\]\]?[ \t]*(?:#.*)?$/;

/** 'mcp_servers . "hotseat".env' → 'mcp_servers.hotseat.env' */
function tomlPath(raw: string): string {
  return raw.replace(/[ \t]*\.[ \t]*/g, ".").replace(/"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'/g, (_, a, b) => a ?? b);
}

/** 表 name 及其子表（name.xxx）连续的一段在原文里的位置；末尾的空行也算在内。 */
export function tomlTableRange(text: string, name: string): { start: number; end: number } | null {
  let offset = 0;
  let start = -1;
  for (const line of text.split("\n")) {
    const m = TOML_HEADER.exec(line);
    if (m) {
      const path = tomlPath(m[1] ?? "");
      const mine = path === name || path.startsWith(`${name}.`);
      if (start < 0 && mine) start = offset;
      else if (start >= 0 && !mine) return { start, end: offset };
    }
    offset += line.length + 1;
  }
  return start < 0 ? null : { start, end: text.length };
}

export function tomlTableText(text: string | null, name: string): string | null {
  const r = text ? tomlTableRange(text, name) : null;
  return text && r ? text.slice(r.start, r.end) : null;
}

/** 有这张表就整段替换，没有就追加到末尾（和原内容之间空一行）。block 以换行结尾。 */
export function upsertTomlTable(text: string | null, name: string, block: string): string {
  const cur = text ?? "";
  const r = tomlTableRange(cur, name);
  if (r) return `${cur.slice(0, r.start)}${block}${r.end < cur.length ? "\n" : ""}${cur.slice(r.end)}`;
  const sep = cur === "" ? "" : cur.endsWith("\n") ? "\n" : "\n\n";
  return `${cur}${sep}${block}`;
}

/** 删掉这张表；在末尾时连同追加时加的那个空行一起删，保证卸载后和原文件一致。剩下为空时返回 null。 */
export function removeTomlTable(text: string | null, name: string): string | null {
  if (text === null) return null;
  const r = tomlTableRange(text, name);
  if (!r) return text;
  let head = text.slice(0, r.start);
  const tail = text.slice(r.end);
  if (tail === "" && head.endsWith("\n\n")) head = head.slice(0, -1);
  const out = head + tail;
  return out.trim() === "" ? null : out;
}

/** TOML 的基本字符串和 JSON 字符串的转义规则在这里够用（路径、Agent 名）。 */
export const tomlString = (s: string): string => JSON.stringify(s);
