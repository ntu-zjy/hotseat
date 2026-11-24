// hotseat blame：查某条决定、约束等是哪个 Agent、什么时候写的（PRD F6，docs/interfaces.md §1.13）。
// 只读：不改任何文件，也不动已读位置。
import type { Lang, MemorySection } from "../contracts/common.ts";
import type { HotseatEvent } from "../contracts/events.ts";
import { PROVENANCE_RE, type Proposal } from "../contracts/storage.ts";
import { allItems, parseMemory, reasoned } from "./memory.ts";
import { STATUS_LABEL } from "./plan.ts";
import { normalizeText, shortTime } from "./util.ts";

export type BlameField =
  | "summary"
  | "decisions"
  | "rejected"
  | "constraints"
  | "state"
  | "next"
  | "files"
  | "subtask"
  | "task"
  | "memory_add"
  | "memory_remove"
  | "memory_replace";

export interface BlameLine {
  field: BlameField;
  /** 对应 memory.md 的哪一节（决定、约束、放弃的方案，以及 review 生效的修改） */
  section?: MemorySection;
  text: string;
  /** memory_replace 时被替换掉的原文 */
  old?: string;
}

export interface MemoryHit {
  section: MemorySection | null;
  heading: string;
  /** 去掉来源标记后的原文 */
  text: string;
  /** memory.md 里的来源标记 〔e_…〕 */
  source_id: string | null;
  source: HotseatEvent | null;
  /** 让它生效的那次 review（memory_applied 事件） */
  accepted: HotseatEvent | null;
  /** 那次 review 接受的提议：没有来源标记时，靠它知道是谁提的 */
  proposal: Proposal | null;
  /** 既没有来源标记、也不是 review 生效的：事件记录里最早写过同样内容的那条 */
  first_seen: HotseatEvent | null;
}

export interface EventHit {
  event: HotseatEvent;
  lines: BlameLine[];
}

export interface BlameResult {
  memory: MemoryHit[];
  /** 新的在前 */
  events: EventHit[];
}

/** 关键词按空白拆开，每个词都要出现；不区分大小写和全角半角。 */
export function blameMatcher(query: string): (text: string) => boolean {
  const fold = (s: string) => s.normalize("NFKC").toLowerCase();
  const terms = fold(query).split(/\s+/).filter(Boolean);
  return (text) => {
    if (terms.length === 0) return false;
    const t = fold(text);
    return terms.every((x) => t.includes(x));
  };
}

/** 一条事件里可以被查到的内容，逐项列出。 */
export function eventLines(ev: HotseatEvent, lang: Lang): BlameLine[] {
  switch (ev.kind) {
    case "progress":
      return [
        { field: "summary", text: ev.summary },
        ...(ev.decisions ?? []).map((d): BlameLine => ({ field: "decisions", section: "decisions", text: reasoned(d.what, d.why) })),
        ...(ev.rejected ?? []).map((d): BlameLine => ({ field: "rejected", section: "rejected", text: reasoned(d.what, d.why) })),
        ...(ev.constraints ?? []).map((c): BlameLine => ({ field: "constraints", section: "constraints", text: c })),
        ...(ev.state ? [{ field: "state", text: ev.state } as BlameLine] : []),
        ...(ev.next ?? []).map((n): BlameLine => ({ field: "next", text: n })),
        ...(ev.files ?? []).map((f): BlameLine => ({ field: "files", text: f })),
      ];
    case "subtask": {
      const L = STATUS_LABEL[lang];
      const move = ev.from ? `${L[ev.from]} → ${L[ev.to]}` : L[ev.to];
      return [{ field: "subtask", text: `${ev.subtask} ${move}${ev.note ? `${lang === "zh" ? "：" : ": "}${ev.note}` : ""}` }];
    }
    case "memory_applied":
      return ev.edits.map((e): BlameLine => {
        if (e.op === "add") return { field: "memory_add", section: e.section, text: e.text };
        if (e.op === "remove") return { field: "memory_remove", section: e.section, text: e.old };
        return { field: "memory_replace", section: e.section, text: e.text, old: e.old };
      });
    case "task_created":
      return [{ field: "task", text: ev.name }];
    default:
      return [];
  }
}

export function blame(input: { memoryText: string; events: readonly HotseatEvent[]; proposals: readonly Proposal[]; query: string; lang: Lang }): BlameResult {
  const match = blameMatcher(input.query);
  const byId = new Map(input.events.map((e) => [e.id, e] as const));
  const proposals = new Map(input.proposals.map((p) => [p.id, p] as const));
  const lines = new Map(input.events.map((e) => [e.id, eventLines(e, input.lang)] as const));
  const lastFirst = [...input.events].reverse();
  /** 已经在 memory 部分说明过的（事件, 内容），事件部分不再重复 */
  const explained = new Set<string>();
  const key = (id: string, text: string) => `${id}\u0000${normalizeText(text)}`;

  const memory: MemoryHit[] = [];
  for (const item of allItems(parseMemory(input.memoryText))) {
    const text = item.text.replace(PROVENANCE_RE, "");
    if (!match(text)) continue;
    const norm = normalizeText(text);
    const sourceId = PROVENANCE_RE.exec(item.text)?.[1] ?? null;
    const source = sourceId ? (byId.get(sourceId) ?? null) : null;
    const accepted =
      lastFirst.find(
        (e) => e.kind === "memory_applied" && e.edits.some((x) => x.op !== "remove" && x.section === item.key && normalizeText(x.text) === norm),
      ) ?? null;
    const proposal = accepted?.kind === "memory_applied" ? (proposals.get(accepted.proposal) ?? null) : null;
    const sameText = (e: HotseatEvent) => (lines.get(e.id) ?? []).some((l) => l.section === item.key && normalizeText(l.text) === norm);
    const firstSeen = source || accepted ? null : (input.events.find((e) => e.kind === "progress" && sameText(e)) ?? null);
    for (const e of [source, accepted, firstSeen]) if (e) explained.add(key(e.id, text));
    memory.push({ section: item.key, heading: item.heading, text, source_id: sourceId, source, accepted, proposal, first_seen: firstSeen });
  }

  const events: EventHit[] = [];
  for (const ev of lastFirst) {
    const hits = (lines.get(ev.id) ?? []).filter((l) => (match(l.text) || (l.old !== undefined && match(l.old))) && !explained.has(key(ev.id, l.text)));
    if (hits.length > 0) events.push({ event: ev, lines: hits });
  }
  return { memory, events };
}

// ---------- 输出 ----------

const T = {
  zh: {
    head: (q: string, slug: string) => `「${q}」在 ${slug} 里的出处：`,
    none: (q: string, slug: string) => `在 ${slug} 里没有找到「${q}」。`,
    eventsTitle: (n: number) => `事件记录（新的在上，${n} 条）`,
    more: (n: number) => `还有 ${n} 条更早的，加 --all 查看全部。`,
    written: "写入",
    accepted: "确认",
    proposed: "提议",
    firstSeen: "最早出现",
    noTag: "没有来源标记：可能是直接编辑 memory.md 写的",
    missing: (id: string) => `${id}（事件记录里找不到这一条）`,
    review: (p: string) => `hotseat review 接受 ${p}`,
    session: (s: string) => `会话 ${s}`,
    sep: "：",
    join: "",
    field: {
      summary: "进度",
      decisions: "决定",
      rejected: "放弃的方案",
      constraints: "约束",
      state: "半截",
      next: "下一步",
      files: "文件",
      subtask: "子任务",
      task: "新建任务",
      memory_add: "memory 新增",
      memory_remove: "memory 删除",
      memory_replace: "memory 替换",
    },
    section: { goal: "目标", decisions: "决定", constraints: "约束", rejected: "放弃的方案", notes: "备注" },
  },
  en: {
    head: (q: string, slug: string) => `Where "${q}" came from in ${slug}:`,
    none: (q: string, slug: string) => `Nothing found for "${q}" in ${slug}.`,
    eventsTitle: (n: number) => `Events (newest first, ${n})`,
    more: (n: number) => `${n} older match(es) hidden; add --all to see them.`,
    written: "written ",
    accepted: "accepted",
    proposed: "proposed",
    firstSeen: "first seen",
    noTag: "no source tag: probably typed into memory.md directly",
    missing: (id: string) => `${id} (not found in events.jsonl)`,
    review: (p: string) => `hotseat review accepted ${p}`,
    session: (s: string) => `session ${s}`,
    sep: ": ",
    join: " ",
    field: {
      summary: "progress",
      decisions: "decision",
      rejected: "rejected",
      constraints: "constraint",
      state: "half-done",
      next: "next",
      files: "file",
      subtask: "subtask",
      task: "task created",
      memory_add: "memory added",
      memory_remove: "memory removed",
      memory_replace: "memory replaced",
    },
    section: { goal: "goal", decisions: "decision", constraints: "constraint", rejected: "rejected", notes: "note" },
  },
} as const;

const shortSession = (s: string | null) => (s ? s.slice(0, 8) : null);

function who(ev: { agent: string; time: string; session: string | null }, t: (typeof T)[Lang], id?: string): string {
  const session = shortSession(ev.session);
  return [ev.agent, shortTime(ev.time), id, session ? t.session(session) : null].filter(Boolean).join(" · ");
}

export function renderBlame(r: BlameResult, opts: { query: string; slug: string; lang: Lang; limit: number | null }): string {
  const t = T[opts.lang];
  if (r.memory.length === 0 && r.events.length === 0) return t.none(opts.query, opts.slug);
  const out: string[] = [t.head(opts.query, opts.slug)];

  for (const m of r.memory) {
    out.push("", `memory.md · ${m.heading}`, `  ${m.text}`);
    const row = (label: string, value: string) => out.push(`    ${label}  ${value}`);
    if (m.source_id) row(t.written, m.source ? who(m.source, t, m.source_id) : t.missing(m.source_id));
    else if (m.proposal) row(t.proposed, who({ agent: m.proposal.agent, time: m.proposal.created, session: m.proposal.session }, t, m.proposal.id));
    if (m.accepted && m.accepted.kind === "memory_applied") row(t.accepted, `${who(m.accepted, t, m.accepted.id)} · ${t.review(m.accepted.proposal)}`);
    if (m.first_seen) row(t.firstSeen, who(m.first_seen, t, m.first_seen.id));
    if (!m.source_id && !m.accepted && !m.first_seen) row(t.written, t.noTag);
  }

  if (r.events.length > 0) {
    const shown = opts.limit === null ? r.events : r.events.slice(0, opts.limit);
    out.push("", t.eventsTitle(r.events.length));
    for (const { event, lines } of shown) {
      out.push(`  ${who(event, t, event.id)}`);
      for (const l of lines) {
        const label = l.section && l.field.startsWith("memory_") ? `${t.field[l.field]}${t.join}${t.section[l.section]}` : t.field[l.field];
        out.push(`    ${label}${t.sep}${l.old !== undefined ? `${l.old} → ${l.text}` : l.text}`);
      }
    }
    if (shown.length < r.events.length) out.push("", t.more(r.events.length - shown.length));
  }
  return out.join("\n");
}
