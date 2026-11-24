// 生成上下文包。纯函数：输入任务数据，输出文本、结构化信息和新的已读位置。见 docs/interfaces.md §3。
import type { AgentId, Lang, MemorySection, Scene } from "../contracts/common.ts";
import type { HotseatEvent, ProgressEvent } from "../contracts/events.ts";
import { PACK_LIMITS, PACK_TITLES, SCENE_ORDER, clipLine, estimateTokens, type PackSection } from "../contracts/pack.ts";
import { PROVENANCE_RE } from "../contracts/storage.ts";
import type { Watermark } from "./db.ts";
import { SECTION_ORDER, diffMemory, memoryItems, otherItems, parseMemory, reasoned } from "./memory.ts";
import { STATUS_LABEL, currentSubtask, diffPlan, formatSubtask, parsePlan } from "./plan.ts";
import type { FileEntry, Task } from "./store.ts";
import { normalizeText, provenance, sha256, shortTime } from "./util.ts";

export interface PackInput {
  task: Pick<Task, "slug" | "name" | "status">;
  agent: AgentId;
  scene: Scene;
  budget: number;
  maxChars: number;
  lang: Lang;
  origin: "hook" | "tool";
  /** 会话恢复时只要「你离开后」部分 */
  sinceOnly: boolean;
  memoryText: string;
  planText: string | null;
  events: readonly HotseatEvent[];
  files: readonly FileEntry[];
  watermark: Watermark | null;
  pendingProposals: number;
  /** 被人拒绝过的提议内容（`<节>:<规范化文本>`），不再出现在包里 */
  rejected: ReadonlySet<string>;
  now: string;
}

export interface PackMeta {
  estimated_tokens: number;
  truncated: PackSection[];
  first_visit: boolean;
  since: { events: number; memory_changed: boolean; plan_changed: boolean } | null;
  pending_proposals: number;
}

export interface PackResult {
  text: string | null;
  meta: PackMeta;
  watermark: Watermark;
}

interface Built {
  id: PackSection;
  title: string;
  full: string[];
  condensed: string[];
  /** 压缩后还放不下时，只留前 k 条（k 最多 max）；没有的节只能整节去掉 */
  take?: { max: number; lines: (k: number) => string[] };
}

type Mode = "full" | "condensed" | "dropped" | number;

const T = {
  zh: {
    title: "Hotseat 交接",
    you: (a: string) => `你是 ${a}。`,
    last: (a: string, t: string) => `上次记录：${a} · ${t}。`,
    none: "还没有进度记录。",
    hook: "这份内容已经自动注入，不需要再调用 get_context；本轮结束前调用 record_progress。",
    tool: "本轮结束前调用 record_progress。",
    sinceTitle: (n: number) => `你离开后（${n} 条新记录）`,
    changed: "改了 ",
    more: (n: number, what: string) => `另有 ${n} ${what}`,
    moreEvents: "条，见 progress.md",
    moreFiles: "个文件",
    moreItems: "条，需要时用 search 查",
    memAdd: (s: string, t: string) => `memory.md：新增${s}「${t}」`,
    memDel: (s: string, t: string) => `memory.md：删除${s}「${t}」`,
    memAddCount: (parts: string[]) => `memory.md：新增${parts.join("、")}`,
    memCount: (s: string, n: number) => `${s} ${n} 条`,
    memDelMore: (n: number) => `memory.md：另删除 ${n} 条`,
    planAdd: (id: string, t: string) => `plan.md：新增 ${id} ${t}`,
    planDel: (id: string, t: string) => `plan.md：删除 ${id} ${t}`,
    planAddCount: (ids: string[]) => `plan.md：新增 ${ids.length} 个子任务（${ids.join("、")}）`,
    planDelCount: (ids: string[]) => `plan.md：删除 ${ids.length} 个子任务（${ids.join("、")}）`,
    planChg: (id: string, a: string, b: string) => `plan.md：${id} ${a} → ${b}`,
    planChgMore: (n: number) => `plan.md：另有 ${n} 个子任务改了状态`,
    moreChanges: (n: number) => `另有 ${n} 处 memory.md / plan.md 变化`,
    half: "半截：",
    next: "下一步：",
    files: "文件：",
    pending: (n: number) => `待确认提议 ${n} 条，请用户运行 hotseat review。`,
    tooLong: "memory.md 过长，建议精简。",
    placeholder: "（待补摘要）",
    sep: "；",
    list: "、",
  },
  en: {
    title: "Hotseat handoff",
    you: (a: string) => `You are ${a}. `,
    last: (a: string, t: string) => `Last record: ${a} · ${t}. `,
    none: "No progress recorded yet. ",
    hook: "This was injected automatically; no need to call get_context. Call record_progress before ending this turn.",
    tool: "Call record_progress before ending this turn.",
    sinceTitle: (n: number) => `Since you left (${n} new record${n === 1 ? "" : "s"})`,
    changed: "files: ",
    more: (n: number, what: string) => `${n} more ${what}`,
    moreEvents: "in progress.md",
    moreFiles: "file(s)",
    moreItems: "(use search when needed)",
    memAdd: (s: string, t: string) => `memory.md: added ${s} "${t}"`,
    memDel: (s: string, t: string) => `memory.md: removed ${s} "${t}"`,
    memAddCount: (parts: string[]) => `memory.md: added ${parts.join(", ")}`,
    memCount: (s: string, n: number) => `${n} ${s}${n === 1 ? "" : "s"}`,
    memDelMore: (n: number) => `memory.md: ${n} more removed`,
    planAdd: (id: string, t: string) => `plan.md: added ${id} ${t}`,
    planDel: (id: string, t: string) => `plan.md: removed ${id} ${t}`,
    planAddCount: (ids: string[]) => `plan.md: added ${ids.length} subtasks (${ids.join(", ")})`,
    planDelCount: (ids: string[]) => `plan.md: removed ${ids.length} subtasks (${ids.join(", ")})`,
    planChg: (id: string, a: string, b: string) => `plan.md: ${id} ${a} → ${b}`,
    planChgMore: (n: number) => `plan.md: ${n} more subtask status change(s)`,
    moreChanges: (n: number) => `${n} more change(s) to memory.md / plan.md`,
    half: "Half-done: ",
    next: "Next: ",
    files: "files: ",
    pending: (n: number) => `${n} proposal(s) awaiting review; ask the user to run hotseat review.`,
    tooLong: "memory.md is long; consider trimming it.",
    placeholder: "(summary pending)",
    sep: "; ",
    list: ", ",
  },
} as const;

const SECTION_NAME: Record<Lang, Record<MemorySection, string>> = {
  zh: { goal: "目标", decisions: "决定", constraints: "约束", rejected: "放弃的方案", notes: "备注" },
  en: { goal: "goal", decisions: "decision", constraints: "constraint", rejected: "rejected approach", notes: "note" },
};

const tagOf = (ev: HotseatEvent): string => provenance(ev.agent, ev.time);
const bullet = (s: string): string => `- ${s}`;
const clip = (line: string): string => clipLine(line, PACK_LIMITS.condensedLineTokens);

export function buildPack(input: PackInput): PackResult {
  const { lang, scene } = input;
  const t = T[lang];
  const titles = PACK_TITLES[lang];
  const memory = parseMemory(input.memoryText);
  const subtasks = input.planText ? parsePlan(input.planText) : [];
  const progress = input.events.filter((e): e is ProgressEvent => e.kind === "progress");
  const recentProgress = progress.slice(-10);
  const maxSeq = input.events.reduce((m, e) => Math.max(m, e.seq), input.watermark?.seq ?? 0);
  const memoryHash = sha256(input.memoryText);
  const planHash = input.planText === null ? null : sha256(input.planText);
  const watermark: Watermark = {
    seq: maxSeq,
    memory_hash: memoryHash,
    memory_snapshot: input.memoryText,
    plan_hash: planHash,
    plan_snapshot: input.planText,
    updated_at: input.now,
  };
  const firstVisit = input.watermark === null;
  const sections = new Map<PackSection, Built>();
  const add = (id: PackSection, full: string[], condensed: string[] = full, title: string = titles[id], take?: Built["take"]) => {
    if (full.length > 0) sections.set(id, { id, title, full, condensed, take });
  };
  // 按条目压缩：留前 n 条（每条截短），多出的写「另有 N 条」；还放不下时可以只留更少几条
  const addList = (id: PackSection, lines: string[], n: number, more?: (rest: number) => string) => {
    const pick = (k: number) => [...lines.slice(0, k).map(clip), ...(more && lines.length > k ? [more(lines.length - k)] : [])];
    const keep = Math.min(n, lines.length);
    add(id, lines, pick(keep), titles[id], { max: keep - 1, lines: pick });
  };

  // ----- 你离开后 -----
  let since: PackMeta["since"] = null;
  if (input.watermark) {
    const wm = input.watermark;
    const fresh = progress.filter((e) => e.seq > wm.seq && e.agent !== input.agent).reverse();
    const memDiff = wm.memory_hash === memoryHash ? { added: [], removed: [] } : diffMemory(wm.memory_snapshot, input.memoryText);
    const planDiff = wm.plan_hash === planHash ? { added: [], removed: [], changed: [] } : diffPlan(wm.plan_snapshot, input.planText);
    const evLines = fresh.slice(0, PACK_LIMITS.sinceMaxEvents).map((e) =>
      bullet(`${e.summary}${e.files?.length ? `${t.sep}${t.changed}${e.files.slice(0, 3).join(t.list)}` : ""} ${tagOf(e)}`),
    );
    if (fresh.length > PACK_LIMITS.sinceMaxEvents) evLines.push(bullet(t.more(fresh.length - PACK_LIMITS.sinceMaxEvents, t.moreEvents)));
    const S = SECTION_NAME[lang];
    const L = STATUS_LABEL[lang];
    // 新增的内容在下面各节里都看得到，一次确认很多条时只给计数，免得这一节把预算吃光；
    // 删除和状态变化在别处看不到，逐条列出，太多时只列前几条。
    const few = PACK_LIMITS.condensedListItems;
    const memAdded =
      memDiff.added.length <= few
        ? memDiff.added.map((d) => t.memAdd(S[d.section], normalizeText(d.text)))
        : [
            t.memAddCount(
              SECTION_ORDER.map((sec) => [sec, memDiff.added.filter((d) => d.section === sec).length] as const)
                .filter(([, n]) => n > 0)
                .map(([sec, n]) => t.memCount(S[sec], n)),
            ),
          ];
    const memRemoved = [
      ...memDiff.removed.slice(0, few).map((d) => t.memDel(S[d.section], normalizeText(d.text))),
      ...(memDiff.removed.length > few ? [t.memDelMore(memDiff.removed.length - few)] : []),
    ];
    const planAdded = planDiff.added.length <= few ? planDiff.added.map((s) => t.planAdd(s.id, s.title)) : [t.planAddCount(planDiff.added.map((s) => s.id))];
    const planRemoved = planDiff.removed.length <= few ? planDiff.removed.map((s) => t.planDel(s.id, s.title)) : [t.planDelCount(planDiff.removed.map((s) => s.id))];
    const planChanged = [
      ...planDiff.changed.slice(0, few).map((c) => t.planChg(c.id, L[c.from], L[c.to])),
      ...(planDiff.changed.length > few ? [t.planChgMore(planDiff.changed.length - few)] : []),
    ];
    const diffLines = [...memAdded, ...memRemoved, ...planAdded, ...planRemoved, ...planChanged].map(bullet);
    since = {
      events: fresh.length,
      memory_changed: memDiff.added.length + memDiff.removed.length > 0,
      plan_changed: planDiff.added.length + planDiff.removed.length + planDiff.changed.length > 0,
    };
    const condensedSince = [
      ...evLines.slice(0, few).map(clip),
      ...(fresh.length > few ? [bullet(t.more(fresh.length - few, t.moreEvents))] : []),
      ...diffLines.slice(0, few).map(clip),
      ...(diffLines.length > few ? [bullet(t.moreChanges(diffLines.length - few))] : []),
    ];
    add("since", [...evLines, ...diffLines], condensedSince, t.sinceTitle(fresh.length));
  }

  // ----- 记忆 + 事件里还没进 memory 的内容 -----
  // memory.md 里存的是来源编号 〔e_000002〕，给 Agent 看时换成和事件一样的 〔claude · 11-24 09:42〕
  const byId = new Map(input.events.map((e) => [e.id, e] as const));
  const readable = (m: string) => m.replace(PROVENANCE_RE, (tag, id: string) => {
    const ev = byId.get(id);
    return ev ? ` ${tagOf(ev)}` : tag;
  });
  const inMemory = (section: MemorySection, text: string) =>
    memoryItems(memory, section).some((m) => normalizeText(m) === normalizeText(text)) ||
    input.rejected.has(`${section}:${normalizeText(text)}`);
  const merged = (section: MemorySection, fromEvents: { text: string; ev: HotseatEvent }[]) => {
    const seen = new Set<string>();
    const lines = memoryItems(memory, section).map((m) => {
      seen.add(normalizeText(m));
      return bullet(readable(m));
    });
    for (const { text, ev } of fromEvents) {
      const key = normalizeText(text);
      if (seen.has(key) || inMemory(section, text)) continue;
      seen.add(key);
      lines.push(bullet(`${text} ${tagOf(ev)}`));
    }
    return lines;
  };

  add("goal", memoryItems(memory, "goal").map((m) => bullet(readable(m))));
  add("constraints", merged("constraints", progress.flatMap((ev) => (ev.constraints ?? []).map((text) => ({ text, ev })))));
  // 压缩时条目尽量都留着（每条截短），让 Agent 至少知道有这条决定，需要全文时再查
  const moreItems = (rest: number) => bullet(t.more(rest, t.moreItems));
  const decisions = merged("decisions", recentProgress.flatMap((ev) => (ev.decisions ?? []).map((d) => ({ text: reasoned(d.what, d.why), ev }))));
  addList("decisions", decisions, PACK_LIMITS.condensedMemoryItems, moreItems);
  const rejectedLines = merged("rejected", recentProgress.flatMap((ev) => (ev.rejected ?? []).map((d) => ({ text: reasoned(d.what, d.why), ev }))));
  addList("rejected", rejectedLines, PACK_LIMITS.condensedMemoryItems, moreItems);

  // ----- 计划 -----
  const cur = currentSubtask(subtasks);
  if (cur) add("current_subtask", [formatSubtask(cur, lang).replace(/^- \[.\] /, "- ")]);
  add("plan_all", subtasks.map((s) => formatSubtask(s, lang)));

  // ----- 做到一半 / 下一步 -----
  const withState = [...progress].reverse().find((e) => e.state || e.next?.length);
  if (withState) {
    const lines: string[] = [];
    if (withState.state) lines.push(bullet(`${t.half}${withState.state} ${tagOf(withState)}`));
    if (withState.next?.length) lines.push(bullet(`${t.next}${withState.next.join(t.sep)}${withState.state ? "" : ` ${tagOf(withState)}`}`));
    add("state_next", lines, lines.map((l) => clipLine(l, PACK_LIMITS.condensedLineTokens * 2)));
  }

  // ----- 最近进度 -----
  const recent = [...progress]
    .reverse()
    .slice(0, PACK_LIMITS.recentEvents)
    .map((e) => bullet(`${e.summary}${scene === "review" && e.files?.length ? `${t.sep}${t.files}${e.files.join(t.list)}` : ""} ${tagOf(e)}`));
  addList("recent", recent, PACK_LIMITS.condensedListItems);

  // ----- 资料 / 其他 -----
  const fileLines = input.files.map((f) => bullet(`${f.path} — ${f.summary ?? t.placeholder}`));
  const n = PACK_LIMITS.condensedListItems;
  add("files", fileLines, fileLines.length > n ? [...fileLines.slice(0, n), bullet(t.more(fileLines.length - n, t.moreFiles))] : fileLines);
  add("other", otherItems(memory).map((o) => bullet(`${o.heading}：${readable(o.text)}`)));

  // ----- 组装 -----
  const last = progress[progress.length - 1];
  const header = [
    `# ${t.title} · ${input.task.name}（${input.task.slug}）`,
    `> ${t.you(input.agent)}${last ? t.last(last.agent, shortTime(last.time)) : t.none}${input.origin === "hook" ? t.hook : t.tool}`,
  ].join("\n");
  const footer = input.pendingProposals > 0 ? `> ${t.pending(input.pendingProposals)}` : "";

  const meta: PackMeta = {
    estimated_tokens: 0,
    truncated: [],
    first_visit: firstVisit,
    since,
    pending_proposals: input.pendingProposals,
  };

  if (input.sinceOnly) {
    const s = sections.get("since");
    if (!s) return { text: null, meta, watermark };
    const text = [header, `## ${s.title}\n${s.full.join("\n")}`, footer].filter(Boolean).join("\n\n");
    meta.estimated_tokens = estimateTokens(text);
    return { text, meta, watermark };
  }

  const pinned = (["goal", "constraints"] as const).map((id) => sections.get(id)).filter((s): s is Built => !!s);
  const ordered = SCENE_ORDER[scene].map((id) => sections.get(id)).filter((s): s is Built => !!s);
  const mode = new Map<PackSection, Mode>(ordered.map((s) => [s.id, "full"]));
  const render = (warning = ""): string => {
    const body = (s: Built) => {
      const m = mode.get(s.id) ?? "full";
      if (m === "dropped") return null;
      const lines = typeof m === "number" ? (s.take?.lines(m) ?? s.condensed) : m === "condensed" ? s.condensed : s.full;
      return `## ${s.title}\n${lines.join("\n")}`;
    };
    const sinceBlock = ordered.find((s) => s.id === "since");
    const rest = ordered.filter((s) => s.id !== "since");
    return [header, sinceBlock ? body(sinceBlock) : null, ...pinned.map(body), ...rest.map(body), footer, warning]
      .filter((x): x is string => !!x)
      .join("\n\n");
  };
  const over = (text: string) => estimateTokens(text) > input.budget || text.length > input.maxChars;

  let text = render();
  const set = (s: Built, m: Mode) => {
    mode.set(s.id, m);
    if (!meta.truncated.includes(s.id)) meta.truncated.push(s.id);
    text = render();
  };
  // 第一遍从末尾逐节压缩（包括「你离开后」），这样「你离开后」再长也只会被压缩，不会把关键决定挤掉。
  // 压缩后不比原来短（行数一样、每行也没截）的节跳过。
  for (let i = ordered.length - 1; i >= 0 && over(text); i--) {
    const s = ordered[i] as Built;
    if (estimateTokens(s.condensed.join("\n")) < estimateTokens(s.full.join("\n"))) set(s, "condensed");
  }
  // 还超就第二遍从末尾逐节减条数：先只留前几条（从多到少试），一条都放不下才整节去掉。
  for (let i = ordered.length - 1; i >= 0 && over(text); i--) {
    const s = ordered[i] as Built;
    for (let k = s.take?.max ?? 0; k >= 1 && over(text); k--) set(s, k);
    if (over(text)) set(s, "dropped");
  }
  if (over(text)) {
    text = render(`> ${t.tooLong}`);
    if (text.length > input.maxChars) text = `${text.slice(0, input.maxChars - 1)}…`;
  }
  meta.estimated_tokens = estimateTokens(text);
  return { text, meta, watermark };
}

