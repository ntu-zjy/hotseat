// memory.md 的解析、修改、比较。见 docs/interfaces.md §1.4。
import type { Lang, MemorySection } from "../contracts/common.ts";
import { MEMORY_HEADINGS, REASON_SEPARATOR, type MemoryEdit } from "../contracts/storage.ts";
import { normalizeText } from "./util.ts";

export const SECTION_ORDER: readonly MemorySection[] = ["goal", "decisions", "constraints", "rejected", "notes"];

export interface MemoryBlock {
  heading: string;
  key: MemorySection | null;
  lines: string[];
}

export interface MemoryDoc {
  head: string[];
  sections: MemoryBlock[];
}

interface Item {
  text: string;
  start: number;
  end: number;
}

function headingKey(heading: string): MemorySection | null {
  const h = heading.trim().toLowerCase();
  for (const key of SECTION_ORDER) {
    if (MEMORY_HEADINGS[key].some((n) => n.toLowerCase() === h)) return key;
  }
  return null;
}

export function parseMemory(text: string): MemoryDoc {
  const doc: MemoryDoc = { head: [], sections: [] };
  let cur: MemoryBlock | null = null;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m?.[1]) {
      cur = { heading: m[1], key: headingKey(m[1]), lines: [] };
      doc.sections.push(cur);
    } else {
      (cur ? cur.lines : doc.head).push(line);
    }
  }
  return doc;
}

const trimEnd = (lines: string[]): string[] => {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1]?.trim() === "") out.pop();
  return out;
};

export function serializeMemory(doc: MemoryDoc): string {
  const parts: string[] = [];
  const head = trimEnd(doc.head);
  if (head.length > 0) parts.push(head.join("\n"));
  for (const s of doc.sections) {
    const body = trimEnd(s.lines);
    while (body.length > 0 && body[0]?.trim() === "") body.shift();
    parts.push([`## ${s.heading}`, ...body].join("\n"));
  }
  return `${parts.join("\n\n")}\n`;
}

/** 顶层 `- ` 列表项；缩进的续行属于同一条；空的 `- ` 占位不算。 */
function items(lines: string[]): Item[] {
  const out: Item[] = [];
  let cur: Item | null = null;
  lines.forEach((line, i) => {
    const m = /^[-*]\s+(.*)$/.exec(line) ?? (/^[-*]$/.test(line) ? ["", ""] : null);
    if (m) {
      cur = { text: m[1] ?? "", start: i, end: i + 1 };
      out.push(cur);
    } else if (cur && /^\s+\S/.test(line)) {
      cur.text += ` ${line.trim()}`;
      cur.end = i + 1;
    } else {
      cur = null;
    }
  });
  return out;
}

export function memoryItems(doc: MemoryDoc, key: MemorySection): string[] {
  return doc.sections
    .filter((s) => s.key === key)
    .flatMap((s) => items(s.lines).map((it) => it.text.trim()))
    .filter((t) => t !== "");
}

/** 所有条目（包括不认识的标题下的），按文件里的顺序。 */
export function allItems(doc: MemoryDoc): { key: MemorySection | null; heading: string; text: string }[] {
  return doc.sections
    .flatMap((s) => items(s.lines).map((it) => ({ key: s.key, heading: s.heading, text: it.text.trim() })))
    .filter((x) => x.text !== "");
}

/** 不认识的标题下的条目，上下文包里归到「其他」。 */
export function otherItems(doc: MemoryDoc): { heading: string; text: string }[] {
  return doc.sections
    .filter((s) => s.key === null)
    .flatMap((s) => items(s.lines).map((it) => ({ heading: s.heading, text: it.text.trim() })))
    .filter((x) => x.text !== "");
}

export function memoryTemplate(name: string, goal: string | null, lang: Lang): string {
  const idx = lang === "zh" ? 0 : 1;
  const doc: MemoryDoc = {
    head: [`# ${name}`],
    sections: SECTION_ORDER.map((key) => ({
      heading: MEMORY_HEADINGS[key][idx] ?? key,
      key,
      lines: key === "goal" && goal ? [`- ${goal}`] : [],
    })),
  };
  return serializeMemory(doc);
}

export function reasoned(what: string, why?: string): string {
  return why ? `${what}${REASON_SEPARATOR}${why}` : what;
}

function findSection(doc: MemoryDoc, key: MemorySection, lang: Lang, create: boolean): MemoryBlock | null {
  const found = doc.sections.find((s) => s.key === key);
  if (found || !create) return found ?? null;
  const block: MemoryBlock = { heading: MEMORY_HEADINGS[key][lang === "zh" ? 0 : 1] ?? key, key, lines: [] };
  const order = SECTION_ORDER.indexOf(key);
  const before = doc.sections.findIndex((s) => s.key !== null && SECTION_ORDER.indexOf(s.key) > order);
  if (before === -1) doc.sections.push(block);
  else doc.sections.splice(before, 0, block);
  return block;
}

function findItem(doc: MemoryDoc, key: MemorySection, text: string): { block: MemoryBlock; item: Item } | null {
  const target = normalizeText(text);
  for (const block of doc.sections.filter((s) => s.key === key)) {
    const item = items(block.lines).find((it) => normalizeText(it.text) === target);
    if (item) return { block, item };
  }
  return null;
}

export function hasItem(doc: MemoryDoc, key: MemorySection, text: string): boolean {
  return findItem(doc, key, text) !== null;
}

export interface ApplyResult {
  text: string;
  applied: MemoryEdit[];
  /** remove / replace 的原文已经找不到 */
  stale: number[];
  /** add 的内容已经存在 */
  skipped: number[];
}

/** 按 §1.7 的规则应用修改。sourceEvent 会作为来源标记加在新条目末尾。 */
export function applyMemoryEdits(text: string, edits: readonly MemoryEdit[], lang: Lang, sourceEvent?: string | null): ApplyResult {
  const doc = parseMemory(text);
  const result: ApplyResult = { text, applied: [], stale: [], skipped: [] };
  const tag = sourceEvent ? ` 〔${sourceEvent}〕` : "";
  edits.forEach((edit, i) => {
    if (edit.op === "add") {
      if (hasItem(doc, edit.section, edit.text)) {
        result.skipped.push(i);
        return;
      }
      const block = findSection(doc, edit.section, lang, true);
      if (!block) return;
      const existing = items(block.lines);
      const placeholder = existing.find((it) => it.text.trim() === "");
      const line = `- ${edit.text}${tag}`;
      if (placeholder) block.lines.splice(placeholder.start, placeholder.end - placeholder.start, line);
      else {
        const last = existing[existing.length - 1];
        block.lines.splice(last ? last.end : 0, 0, line);
      }
      result.applied.push(edit);
      return;
    }
    const hit = findItem(doc, edit.section, edit.old);
    if (!hit) {
      result.stale.push(i);
      return;
    }
    const { block, item } = hit;
    const replacement = edit.op === "replace" ? [`- ${edit.text}${tag}`] : [];
    block.lines.splice(item.start, item.end - item.start, ...replacement);
    result.applied.push(edit);
  });
  result.text = result.applied.length > 0 ? serializeMemory(doc) : text;
  return result;
}

export interface MemoryDiff {
  added: { section: MemorySection; text: string }[];
  removed: { section: MemorySection; text: string }[];
}

export function diffMemory(before: string | null, after: string): MemoryDiff {
  const a = parseMemory(before ?? "");
  const b = parseMemory(after);
  const diff: MemoryDiff = { added: [], removed: [] };
  for (const section of SECTION_ORDER) {
    const old = new Map(memoryItems(a, section).map((t) => [normalizeText(t), t]));
    const cur = new Map(memoryItems(b, section).map((t) => [normalizeText(t), t]));
    for (const [k, t] of cur) if (!old.has(k)) diff.added.push({ section, text: t });
    for (const [k, t] of old) if (!cur.has(k)) diff.removed.push({ section, text: t });
  }
  return diff;
}
