// 核心服务：MCP 工具、Hook、命令行共用的业务逻辑。每次调用都重新读文件，不在进程内缓存任务数据。
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentId, Lang, MemorySection, Scene, SubtaskStatus } from "../contracts/common.ts";
import { HotseatError } from "../contracts/errors.ts";
import type { HotseatEvent, ReasonedItem } from "../contracts/events.ts";
import { HOOK_LIMITS, STOP_BLOCK_MESSAGE, type HookInput } from "../contracts/hooks.ts";
import { PACK_LIMITS, type PackSection } from "../contracts/pack.ts";
import {
  Config,
  MemoryEdit,
  Proposal,
  READABLE_TASK_FILES,
  redactSecrets,
  type PlanSubtask,
} from "../contracts/storage.ts";
import { validateMemoryEditInput, type MemoryEditInput } from "../contracts/tools.ts";
import { blame, renderBlame } from "./blame.ts";
import { changedSince, dirtyState, walkChanged, type Snapshot } from "./changes.ts";
import * as dbx from "./db.ts";
import { applyMemoryEdits, hasItem, memoryItems, memoryTemplate, parseMemory, reasoned } from "./memory.ts";
import { buildPack } from "./pack.ts";
import { applyPlanProposal, currentSubtask, parsePlan, setSubtaskStatus } from "./plan.ts";
import {
  appendEventUnlocked,
  listTasks,
  loadTask,
  nextProposalId,
  readEvents,
  readProposals,
  refreshIndex,
  saveTaskFile,
  setFileSummary,
  slugify,
  writeProgress,
  writeProposal,
  type EventDraft,
  type Task,
} from "./store.ts";
import {
  atomicWrite,
  ensureDir,
  homePath,
  isoLocal,
  looksBinary,
  normalizeText,
  readTextOrNull,
  sha256,
  taskDir,
  taskLock,
  taskPath,
  type Env,
} from "./util.ts";

export interface ToolResult<T> {
  text: string;
  data: T;
}

export interface Resolution {
  task: Task | null;
  /** 匹配到的绑定目录 */
  root: string | null;
  candidates: string[];
}

export interface Where {
  task?: string | undefined;
  /** 按优先级排列的候选工作目录 */
  cwds: readonly (string | null | undefined)[];
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** hotseat blame 默认最多列出的事件数，加 --all 看全部 */
const BLAME_EVENT_LIMIT = 20;

const contains = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

export class Hotseat {
  readonly home: string;
  readonly env: Env;
  readonly db: dbx.Db;
  readonly config: Config;
  private readonly clock: () => Date;

  private constructor(home: string, env: Env, db: dbx.Db, config: Config, clock: () => Date) {
    this.home = home;
    this.env = env;
    this.db = db;
    this.config = config;
    this.clock = clock;
  }

  static open(opts: { home: string; env?: Env; now?: () => Date }): Hotseat {
    ensureDir(opts.home);
    const raw = readTextOrNull(homePath(opts.home, "config"));
    const json: unknown = raw ? JSON.parse(raw) : { v: 1 };
    if (typeof json === "object" && json && typeof (json as { v?: unknown }).v === "number" && (json as { v: number }).v > 1) {
      throw new HotseatError("SCHEMA_TOO_NEW", "数据是更高版本的 Hotseat 写的，请运行 hotseat update");
    }
    return new Hotseat(opts.home, opts.env ?? process.env, dbx.openDb(opts.home), Config.parse(json), opts.now ?? (() => new Date()));
  }

  close(): void {
    this.db.close();
  }

  get lang(): Lang {
    return this.config.lang;
  }

  private nowLocal(): string {
    return isoLocal(this.clock());
  }

  private nowUtc(): string {
    return this.clock().toISOString();
  }

  // ---------- 找任务（§2） ----------

  resolve(where: Where): Resolution {
    const tasks = listTasks(this.home);
    const recent = (): string[] =>
      tasks
        .filter((t) => t.status === "active" || t.status === "paused")
        .map((t) => ({ t, at: dbx.getActivity(this.db, t.slug)?.last_active ?? t.created }))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, 5)
        .map((x) => x.t.slug);
    const cwds = where.cwds.filter((c): c is string => !!c && isAbsolute(c)).map(realpathOr);
    const explicit = where.task ?? this.env.HOTSEAT_TASK;
    if (explicit) {
      const task = tasks.find((t) => t.slug === explicit);
      if (!task) throw new HotseatError("TASK_NOT_FOUND", `任务 ${explicit} 不存在`, recent());
      const root = task.paths.filter((p) => cwds.some((c) => contains(p, c))).sort((a, b) => b.length - a.length)[0] ?? null;
      return { task, root, candidates: [] };
    }
    for (const cwd of cwds) {
      const matches = tasks
        .filter((t) => t.status === "active" || t.status === "paused")
        .flatMap((t) => t.paths.filter((p) => contains(p, cwd)).map((p) => ({ t, p })));
      if (matches.length === 0) continue;
      const longest = Math.max(...matches.map((m) => m.p.length));
      const best = matches.filter((m) => m.p.length === longest);
      const root = best[0]?.p as string;
      const active = dbx.getPathActive(this.db, root);
      const pick =
        best.find((m) => m.t.slug === active) ??
        best
          .map((m) => ({ m, at: dbx.getActivity(this.db, m.t.slug)?.last_active ?? m.t.created }))
          .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]?.m;
      if (pick) return { task: pick.t, root, candidates: [] };
    }
    return { task: null, root: null, candidates: recent() };
  }

  private requireTask(where: Where): { task: Task; root: string | null } {
    const r = this.resolve(where);
    if (!r.task) {
      throw new HotseatError(
        "NO_TASK",
        this.lang === "zh"
          ? "当前目录没有绑定 Hotseat 任务，不需要记录，照常结束即可。"
          : "No Hotseat task is bound to this directory; nothing to record, just finish normally.",
        r.candidates,
      );
    }
    return { task: r.task, root: r.root };
  }

  // ---------- 上下文包（§3、§4.1） ----------

  private rejectedTexts(task: Task): Set<string> {
    const out = new Set<string>();
    for (const p of readProposals(task.dir, true)) {
      if (p.kind !== "memory" || p.status !== "rejected") continue;
      for (const e of p.edits) if (e.op !== "remove") out.add(`${e.section}:${normalizeText(e.text)}`);
    }
    return out;
  }

  contextFor(
    task: Task,
    agent: AgentId,
    opts: { scene: Scene; budget: number; maxChars: number; origin: "hook" | "tool"; sinceOnly: boolean },
  ) {
    const result = buildPack({
      task,
      agent,
      scene: opts.scene,
      budget: opts.budget,
      maxChars: opts.maxChars,
      lang: this.lang,
      origin: opts.origin,
      sinceOnly: opts.sinceOnly,
      memoryText: readTextOrNull(taskPath(task.dir, "memory")) ?? "",
      planText: readTextOrNull(taskPath(task.dir, "plan")),
      events: readEvents(task.dir),
      files: refreshIndex(task, this.lang),
      watermark: dbx.getWatermark(this.db, agent, task.slug),
      pendingProposals: readProposals(task.dir).length,
      rejected: this.rejectedTexts(task),
      now: this.nowUtc(),
    });
    dbx.setWatermark(this.db, agent, task.slug, result.watermark);
    return result;
  }

  getContext(agent: AgentId, args: { task?: string; scene?: Scene; budget?: number }, where: Where, maxChars = 9500) {
    const scene = args.scene ?? "code";
    const budget = Math.min(args.budget ?? this.config.pack.defaultBudget, this.config.pack.maxBudget, PACK_LIMITS.maxBudget);
    const r = this.resolve({ ...where, task: args.task ?? where.task });
    if (!r.task) {
      const text =
        this.lang === "zh"
          ? `当前目录没有绑定 Hotseat 任务，照常工作即可，不要追问用户；只有用户想在多个 Agent 之间交接这项工作时，才建议用 create_task 新建。${r.candidates.length ? `最近的任务：${r.candidates.join("、")}。` : ""}`
          : `No Hotseat task is bound to this directory. Work normally and do not ask the user about it; suggest create_task only if the user wants to hand this work off between agents.${r.candidates.length ? ` Recent tasks: ${r.candidates.join(", ")}.` : ""}`;
      return {
        text,
        data: {
          task: null,
          agent,
          scene,
          budget,
          estimated_tokens: 0,
          truncated: [] as PackSection[],
          first_visit: false,
          since: null,
          pending_proposals: 0,
          candidates: r.candidates,
        },
      };
    }
    const { text, meta } = this.contextFor(r.task, agent, { scene, budget, maxChars, origin: "tool", sinceOnly: false });
    return {
      text: text ?? "",
      data: { task: { slug: r.task.slug, name: r.task.name, status: r.task.status }, agent, scene, budget, ...meta, candidates: [] },
    };
  }

  // ---------- 进度（§4.2） ----------

  private sessionFor(agent: AgentId, task: string): string | null {
    const since = new Date(this.clock().getTime() - HOOK_LIMITS.sessionAttributionHours * 3600_000).toISOString();
    return dbx.latestSessionId(this.db, agent, task, since);
  }

  private normalizeFile(task: Task, f: string): string {
    if (!isAbsolute(f)) return f;
    const real = realpathOr(f);
    const root = task.paths.filter((p) => contains(p, real)).sort((a, b) => b.length - a.length)[0];
    return root ? relative(root, real) || "." : real;
  }

  /** 调用方已持有任务写锁。auto=true 时，被人拒绝过的内容不再提议。 */
  private proposeMemoryUnlocked(
    task: Task,
    p: { agent: AgentId; session: string | null; reason: string; sourceEvent: string | null; edits: MemoryEdit[]; auto: boolean },
  ): { proposal: Proposal | null; stale: number[]; duplicate: number[] } {
    const memoryText = readTextOrNull(taskPath(task.dir, "memory")) ?? "";
    const doc = parseMemory(memoryText);
    const pendingAdds = new Set(
      readProposals(task.dir).flatMap((x) =>
        x.kind === "memory" ? x.edits.filter((e) => e.op === "add").map((e) => `${e.section}:${normalizeText(e.text)}`) : [],
      ),
    );
    const rejected = p.auto ? this.rejectedTexts(task) : new Set<string>();
    const live: MemoryEdit[] = [];
    const stale: number[] = [];
    const duplicate: number[] = [];
    p.edits.forEach((e, i) => {
      if (e.op === "add") {
        const key = `${e.section}:${normalizeText(e.text)}`;
        if (hasItem(doc, e.section, e.text) || pendingAdds.has(key) || rejected.has(key)) {
          duplicate.push(i);
          return;
        }
        pendingAdds.add(key);
      } else if (!hasItem(doc, e.section, e.old)) {
        stale.push(i);
        return;
      }
      live.push(e);
    });
    if (live.length === 0) return { proposal: null, stale, duplicate };
    const proposal = Proposal.parse({
      v: 1,
      id: nextProposalId(task.dir),
      kind: "memory",
      status: "pending",
      created: this.nowLocal(),
      agent: p.agent,
      session: p.session,
      source_event: p.sourceEvent,
      reason: p.reason.slice(0, 300),
      base_memory_hash: sha256(memoryText),
      edits: live,
    });
    writeProposal(task.dir, proposal);
    return { proposal, stale, duplicate };
  }

  async recordProgress(
    agent: AgentId,
    args: {
      task?: string;
      summary: string;
      decisions?: ReasonedItem[];
      rejected?: ReasonedItem[];
      constraints?: string[];
      state?: string;
      next?: string[];
      files?: string[];
      subtask?: string;
      subtask_status?: SubtaskStatus;
    },
    where: Where,
  ) {
    const { task } = this.requireTask({ ...where, task: args.task ?? where.task });
    const zh = this.lang === "zh";
    const warnings: string[] = [];
    const hits: string[] = [];
    const clean = (s: string): string => {
      if (!this.config.secretScan) return s;
      const r = redactSecrets(s);
      hits.push(...r.hits);
      return r.text;
    };
    const cleanItems = (xs?: ReasonedItem[]) =>
      xs?.map((x) => ({ ...x, what: clean(x.what), ...(x.why ? { why: clean(x.why) } : {}) }));
    const fields = {
      summary: clean(args.summary),
      decisions: cleanItems(args.decisions),
      rejected: cleanItems(args.rejected),
      constraints: args.constraints?.map(clean),
      state: args.state ? clean(args.state) : undefined,
      next: args.next?.map(clean),
      files: args.files?.map((f) => this.normalizeFile(task, f)),
    };
    if (hits.length > 0) {
      const kinds = [...new Set(hits)].join(zh ? "、" : ", ");
      warnings.push(zh ? `检测到疑似密钥（${kinds}），已替换成 [REDACTED]，没有写进记录。` : `Possible secrets (${kinds}) were replaced with [REDACTED] before saving.`);
    }
    const session = this.sessionFor(agent, task.slug);
    const time = this.nowLocal();

    return taskLock(task.dir, () => {
      const planText = readTextOrNull(taskPath(task.dir, "plan"));
      let subtask = args.subtask;
      if (subtask && !(planText && parsePlan(planText).some((s) => s.id === subtask))) {
        warnings.push(zh ? `子任务 ${subtask} 不存在，已忽略。` : `Subtask ${subtask} does not exist; ignored.`);
        subtask = undefined;
      }
      if (args.subtask_status && !subtask) {
        if (!args.subtask) warnings.push(zh ? "subtask_status 需要同时给 subtask，已忽略。" : "subtask_status needs subtask; ignored.");
      }
      const event = appendEventUnlocked(task.dir, { kind: "progress", agent, session, ...(subtask ? { subtask } : {}), ...fields } as EventDraft, time);
      if (subtask && args.subtask_status && planText) {
        const r = setSubtaskStatus(planText, subtask, args.subtask_status, null, { date: time.slice(0, 10), agent });
        if (r && r.from !== args.subtask_status) {
          atomicWrite(taskPath(task.dir, "plan"), r.text);
          appendEventUnlocked(task.dir, { kind: "subtask", agent, session, subtask, from: r.from, to: args.subtask_status }, time);
        }
      }
      const edits: MemoryEdit[] = [
        ...(fields.constraints ?? []).map((text) => ({ op: "add" as const, section: "constraints" as const, text })),
        ...(fields.decisions ?? []).filter((d) => d.lasting).map((d) => ({ op: "add" as const, section: "decisions" as const, text: reasoned(d.what, d.why) })),
        ...(fields.rejected ?? []).filter((d) => d.lasting).map((d) => ({ op: "add" as const, section: "rejected" as const, text: reasoned(d.what, d.why) })),
      ];
      const proposal =
        edits.length > 0
          ? this.proposeMemoryUnlocked(task, {
              agent,
              session,
              reason: zh ? `来自 ${event.id} 的约束和长期决定` : `Constraints and lasting decisions from ${event.id}`,
              sourceEvent: event.id,
              edits,
              auto: true,
            }).proposal
          : null;
      writeProgress(task, this.lang);
      dbx.touchActivity(this.db, task.slug, time, agent, event.seq);
      const n = proposal?.kind === "memory" ? proposal.edits.length : 0;
      const text = zh
        ? `已记录 ${event.id}（任务 ${task.slug}）。${proposal ? `${n} 条内容已提交，等用户确认（${proposal.id}）。` : ""}${warnings.join("")}`
        : `Recorded ${event.id} (task ${task.slug}).${proposal ? ` ${n} item(s) submitted for the user's review (${proposal.id}).` : ""}${warnings.length ? ` ${warnings.join(" ")}` : ""}`;
      return { text, data: { event_id: event.id, task: task.slug, proposal_id: proposal?.id ?? null, warnings } };
    });
  }

  // ---------- memory 提议（§4.3） ----------

  async proposeMemoryEdit(agent: AgentId, args: { task?: string; edits: MemoryEditInput[]; reason: string }, where: Where) {
    const { task } = this.requireTask({ ...where, task: args.task ?? where.task });
    const edits = args.edits.map((e, i) => {
      const problem = validateMemoryEditInput(e);
      if (problem) throw new HotseatError("INVALID_INPUT", `edits[${i}]：${problem}`);
      return MemoryEdit.parse(e);
    });
    return taskLock(task.dir, () => {
      const r = this.proposeMemoryUnlocked(task, { agent, session: this.sessionFor(agent, task.slug), reason: args.reason, sourceEvent: null, edits, auto: false });
      const zh = this.lang === "zh";
      const parts: string[] = [];
      if (r.proposal) parts.push(zh ? `已提交 ${r.proposal.id}，等用户运行 hotseat review 确认。` : `Submitted ${r.proposal.id}; the user will review it with hotseat review.`);
      if (r.stale.length) parts.push(zh ? `第 ${r.stale.join("、")} 项要改的原文在 memory.md 里找不到，已丢弃。` : `Edits ${r.stale.join(", ")} refer to text not in memory.md and were dropped.`);
      if (r.duplicate.length) parts.push(zh ? `第 ${r.duplicate.join("、")} 项已经存在或已有相同提议，已跳过。` : `Edits ${r.duplicate.join(", ")} already exist or are already proposed; skipped.`);
      return { text: parts.join(zh ? "" : " "), data: { proposal_id: r.proposal?.id ?? null, stale_edits: r.stale } };
    });
  }

  // ---------- 任务管理（§4.4–4.6） ----------

  private summary(task: Task) {
    const events = readEvents(task.dir);
    const last = events[events.length - 1];
    const act = dbx.getActivity(this.db, task.slug);
    const planText = readTextOrNull(taskPath(task.dir, "plan"));
    return {
      slug: task.slug,
      name: task.name,
      status: task.status,
      paths: task.paths,
      last_active: act?.last_active ?? last?.time ?? null,
      last_agent: (act?.last_agent ?? last?.agent ?? null) as AgentId | null,
      current_subtask: planText ? (currentSubtask(parsePlan(planText))?.id ?? null) : null,
      pending_proposals: readProposals(task.dir).length,
    };
  }

  listTasks(args: { status?: "active" | "paused" | "done" | "archived" | "all" }, where: Where) {
    const want = args.status ?? null;
    const tasks = listTasks(this.home)
      .filter((t) => (want === "all" ? true : want ? t.status === want : t.status === "active" || t.status === "paused"))
      .map((t) => this.summary(t))
      .sort((a, b) => Date.parse(b.last_active ?? "1970-01-01T00:00:00Z") - Date.parse(a.last_active ?? "1970-01-01T00:00:00Z"));
    const resolved = this.resolve(where).task?.slug ?? null;
    const zh = this.lang === "zh";
    const text =
      tasks.length === 0
        ? zh
          ? "还没有任务。"
          : "No tasks yet."
        : tasks
            .map((t) => `- ${t.slug}${t.slug === resolved ? (zh ? "（当前）" : " (current)") : ""} · ${t.name} · ${t.status}${t.current_subtask ? ` · ${t.current_subtask}` : ""}${t.pending_proposals ? (zh ? ` · 待确认 ${t.pending_proposals}` : ` · ${t.pending_proposals} pending`) : ""}`)
            .join("\n");
    return { text, data: { resolved, tasks } };
  }

  switchTask(args: { slug: string; bind?: boolean }, where: Where) {
    const task = loadTask(this.home, args.slug);
    const cwd = where.cwds.find((c): c is string => !!c && isAbsolute(c));
    if (!cwd) throw new HotseatError("INVALID_INPUT", "需要 cwd 才能切换任务");
    const real = realpathOr(cwd);
    let root = task.paths.filter((p) => contains(p, real)).sort((a, b) => b.length - a.length)[0];
    let bound = false;
    if (!root) {
      if (!args.bind) throw new HotseatError("NOT_BOUND", `任务 ${task.slug} 没有绑定 ${real}。要顺便绑定，传 bind: true；或者先问用户。`);
      task.paths = [...task.paths, real];
      saveTaskFile(task);
      root = real;
      bound = true;
    }
    dbx.setPathActive(this.db, root, task.slug, this.nowUtc());
    const text = this.lang === "zh" ? `已切换到 ${task.slug}（${root}）。` : `Switched to ${task.slug} (${root}).`;
    return { text, data: { task: task.slug, path: root, bound } };
  }

  async createTask(agent: AgentId, args: { name: string; goal?: string; slug?: string; path?: string }, where: Where) {
    const taken = new Set(listTasks(this.home).map((t) => t.slug));
    const slug = slugify(args.slug ?? args.name, taken, this.clock());
    const rawPath = args.path ?? where.cwds.find((c): c is string => !!c && isAbsolute(c));
    let path: string | null = null;
    if (rawPath) {
      const abs = resolve(rawPath);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new HotseatError("INVALID_INPUT", `${abs} 不是一个目录`);
      path = realpathOr(abs);
    }
    const dir = taskDir(this.home, slug);
    const time = this.nowLocal();
    const task: Task = { v: 1, slug, name: args.name, status: "active", created: time, paths: path ? [path] : [], dir };
    ensureDir(taskPath(dir, "files"));
    saveTaskFile(task);
    atomicWrite(taskPath(dir, "memory"), memoryTemplate(args.name, args.goal ?? null, this.lang));
    const event = await taskLock(dir, () =>
      appendEventUnlocked(dir, { kind: "task_created", agent, session: null, name: args.name, paths: task.paths }, time),
    );
    refreshIndex(task, this.lang);
    writeProgress(task, this.lang);
    dbx.touchActivity(this.db, slug, time, agent, event.seq);
    if (path) dbx.setPathActive(this.db, path, slug, this.nowUtc());
    const text = this.lang === "zh" ? `已创建任务 ${slug}${path ? `，绑定 ${path}` : ""}。` : `Created task ${slug}${path ? ` bound to ${path}` : ""}.`;
    return { text, data: { slug, path } };
  }

  /** 命令行 hotseat link：把目录绑定到任务。 */
  link(slug: string, path: string) {
    return this.switchTask({ slug, bind: true }, { cwds: [resolve(path)] });
  }

  // ---------- 检索（§4.7） ----------

  private reindexTask(task: Task): void {
    dbx.deleteDocs(this.db, task.slug);
    const put = (d: Omit<dbx.DocRow, "task">) => dbx.putDoc(this.db, { task: task.slug, ...d });
    for (const ev of readEvents(task.dir)) {
      const text = eventText(ev);
      if (text) put({ kind: "event", ref: ev.id, time: ev.time, agent: ev.agent, text });
    }
    const memory = parseMemory(readTextOrNull(taskPath(task.dir, "memory")) ?? "");
    for (const section of ["goal", "decisions", "constraints", "rejected", "notes"] as const satisfies readonly MemorySection[]) {
      const items = memoryItems(memory, section);
      if (items.length) put({ kind: "memory", ref: `memory.md#${section}`, time: null, agent: null, text: items.join("\n") });
    }
    for (const s of parsePlan(readTextOrNull(taskPath(task.dir, "plan")) ?? "")) {
      put({ kind: "plan", ref: `plan.md#${s.id}`, time: null, agent: null, text: [s.title, s.accept, ...s.notes].filter(Boolean).join("\n") });
    }
    for (const f of refreshIndex(task, this.lang)) {
      let text = `${f.path}\n${f.summary ?? ""}`;
      try {
        const buf = readFileSync(join(task.dir, f.path)).subarray(0, 65536);
        if (!looksBinary(buf)) text += `\n${buf.toString("utf8")}`;
      } catch {
        // 读不了就只索引文件名和摘要
      }
      put({ kind: "file", ref: f.path, time: null, agent: null, text });
    }
  }

  search(args: { task?: string; query: string; scope?: "all" | "events" | "memory" | "plan" | "files"; all_tasks?: boolean; limit?: number }, where: Where) {
    const resolved = args.all_tasks ? null : this.resolve({ ...where, task: args.task ?? where.task }).task;
    const targets = resolved ? [resolved] : listTasks(this.home);
    for (const t of targets) this.reindexTask(t);
    const kinds: dbx.DocRow["kind"][] | null =
      !args.scope || args.scope === "all" ? null : [({ events: "event", memory: "memory", plan: "plan", files: "file" } as const)[args.scope]];
    const hits = dbx.searchDocs(this.db, { query: args.query, tasks: targets.map((t) => t.slug), kinds, limit: args.limit ?? 10 });
    const results = hits.map((h) => ({
      task: h.task,
      kind: h.kind,
      ref: h.ref,
      snippet: h.snippet,
      ...(h.time ? { time: h.time } : {}),
      ...(h.agent ? { agent: h.agent as AgentId } : {}),
    }));
    const text =
      results.length === 0
        ? this.lang === "zh"
          ? `没有找到「${args.query}」。`
          : `Nothing found for "${args.query}".`
        : results.map((r) => `- [${r.task} · ${r.ref}] ${r.snippet}`).join("\n");
    return { text, data: { results } };
  }

  // ---------- 出处（PRD F6，§1.13） ----------

  blame(args: { task?: string; query: string; all?: boolean }, where: Where) {
    const { task } = this.requireTask({ ...where, task: args.task ?? where.task });
    const result = blame({
      memoryText: readTextOrNull(taskPath(task.dir, "memory")) ?? "",
      events: readEvents(task.dir),
      proposals: [...readProposals(task.dir), ...readProposals(task.dir, true)],
      query: args.query,
      lang: this.lang,
    });
    const text = renderBlame(result, { query: args.query.trim(), slug: task.slug, lang: this.lang, limit: args.all ? null : BLAME_EVENT_LIMIT });
    return { text, data: result };
  }

  // ---------- 读资料（§4.8、§4.11） ----------

  private taskFile(task: Task, path: string): string {
    const clean = path.replace(/^\.\//, "");
    const allowed = (READABLE_TASK_FILES as readonly string[]).includes(clean) || clean.startsWith("files/");
    if (!allowed) throw new HotseatError("PATH_OUTSIDE_TASK", `只能读 ${READABLE_TASK_FILES.join("、")} 或 files/ 下的文件`);
    const baseDir = clean.startsWith("files/") ? taskPath(task.dir, "files") : task.dir;
    const full = resolve(task.dir, clean);
    // 先按字面路径挡住 ../，再用 realpath 挡住软链接
    const outside = new HotseatError("PATH_OUTSIDE_TASK", `${clean} 不在任务目录里`);
    if (!contains(baseDir, full) || full === baseDir) throw outside;
    let real: string;
    try {
      real = realpathSync(full);
    } catch {
      throw new HotseatError("FILE_NOT_FOUND", `${clean} 不存在`);
    }
    const base = realpathSync(baseDir);
    if (!contains(base, real) || real === base) throw outside;
    return real;
  }

  readTaskFile(args: { task?: string; path: string; offset?: number; limit?: number }, where: Where) {
    const { task } = this.requireTask({ ...where, task: args.task ?? where.task });
    const real = this.taskFile(task, args.path);
    const buf = readFileSync(real);
    if (looksBinary(buf)) throw new HotseatError("BINARY_FILE", `${args.path} 是二进制文件（${buf.length} 字节），请用你自己的工具打开：${real}`);
    const lines = buf.toString("utf8").split("\n");
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 400;
    const slice = lines.slice(offset, offset + limit);
    return {
      text: slice.join("\n"),
      data: { path: args.path, total_lines: lines.length, offset, returned_lines: slice.length, truncated: offset + slice.length < lines.length },
    };
  }

  annotateFile(args: { task?: string; path: string; summary: string }, where: Where) {
    const { task } = this.requireTask({ ...where, task: args.task ?? where.task });
    if (!args.path.startsWith("files/")) throw new HotseatError("PATH_OUTSIDE_TASK", "只能给 files/ 下的文件写摘要");
    this.taskFile(task, args.path);
    setFileSummary(task, args.path, args.summary, this.lang);
    return { text: this.lang === "zh" ? `已更新 ${args.path} 的摘要。` : `Summary updated for ${args.path}.`, data: { path: args.path } };
  }

  // ---------- 计划（§4.9、§4.10） ----------

  async proposePlan(agent: AgentId, args: { task?: string; subtasks: PlanSubtask[]; mode?: "replace" | "append"; reason?: string }, where: Where) {
    const { task } = this.requireTask({ ...where, task: args.task ?? where.task });
    return taskLock(task.dir, () => {
      const mode = args.mode ?? (existsSync(taskPath(task.dir, "plan")) ? "append" : "replace");
      const proposal = Proposal.parse({
        v: 1,
        id: nextProposalId(task.dir),
        kind: "plan",
        status: "pending",
        created: this.nowLocal(),
        agent,
        session: this.sessionFor(agent, task.slug),
        reason: args.reason ?? "",
        mode,
        subtasks: args.subtasks,
      });
      writeProposal(task.dir, proposal);
      const text = this.lang === "zh" ? `已提交计划 ${proposal.id}（${args.subtasks.length} 个子任务），等用户运行 hotseat review 确认。` : `Plan ${proposal.id} (${args.subtasks.length} subtasks) submitted for review.`;
      return { text, data: { proposal_id: proposal.id } };
    });
  }

  async updateSubtask(agent: AgentId, args: { task?: string; id: string; status: SubtaskStatus; note?: string }, where: Where) {
    const { task } = this.requireTask({ ...where, task: args.task ?? where.task });
    return taskLock(task.dir, () => {
      const planText = readTextOrNull(taskPath(task.dir, "plan"));
      if (!planText) throw new HotseatError("NO_PLAN", "这个任务还没有 plan.md，请先用 propose_plan 提交计划");
      const time = this.nowLocal();
      const r = setSubtaskStatus(planText, args.id, args.status, args.note ?? null, { date: time.slice(0, 10), agent });
      if (!r) throw new HotseatError("SUBTASK_NOT_FOUND", `子任务 ${args.id} 不存在`, parsePlan(planText).map((s) => s.id));
      atomicWrite(taskPath(task.dir, "plan"), r.text);
      const event = appendEventUnlocked(
        task.dir,
        { kind: "subtask", agent, session: this.sessionFor(agent, task.slug), subtask: args.id, from: r.from, to: args.status, ...(args.note ? { note: args.note } : {}) },
        time,
      );
      writeProgress(task, this.lang);
      dbx.touchActivity(this.db, task.slug, time, agent, event.seq);
      return { text: `${args.id}: ${r.from} → ${args.status}（${event.id}）`, data: { id: args.id, from: r.from, to: args.status, event_id: event.id } };
    });
  }

  // ---------- 人工确认（hotseat review） ----------

  pending(task: Task): Proposal[] {
    return readProposals(task.dir);
  }

  async resolveProposal(task: Task, id: string, accept: boolean): Promise<{ status: Proposal["status"]; applied: number }> {
    return taskLock(task.dir, () => {
      const p = readProposals(task.dir).find((x) => x.id === id);
      if (!p) throw new HotseatError("FILE_NOT_FOUND", `提议 ${id} 不存在`);
      const time = this.nowLocal();
      if (!accept) {
        writeProposal(task.dir, { ...p, status: "rejected", resolved: time });
        return { status: "rejected" as const, applied: 0 };
      }
      if (p.kind === "memory") {
        const before = readTextOrNull(taskPath(task.dir, "memory")) ?? memoryTemplate(task.name, null, this.lang);
        const r = applyMemoryEdits(before, p.edits, this.lang, p.source_event);
        if (r.applied.length === 0) {
          writeProposal(task.dir, { ...p, status: "stale", resolved: time });
          return { status: "stale" as const, applied: 0 };
        }
        atomicWrite(taskPath(task.dir, "memory"), r.text);
        appendEventUnlocked(task.dir, { kind: "memory_applied", agent: "human", session: null, proposal: p.id, edits: r.applied }, time);
        writeProposal(task.dir, { ...p, status: "accepted", resolved: time });
        writeProgress(task, this.lang);
        return { status: "accepted" as const, applied: r.applied.length };
      }
      const planText = readTextOrNull(taskPath(task.dir, "plan"));
      const r = applyPlanProposal(planText, p.subtasks, planText ? p.mode : "replace", task.name, this.lang);
      atomicWrite(taskPath(task.dir, "plan"), r.text);
      appendEventUnlocked(task.dir, { kind: "plan_applied", agent: "human", session: null, proposal: p.id, mode: p.mode, count: r.count }, time);
      writeProposal(task.dir, { ...p, status: "accepted", resolved: time });
      writeProgress(task, this.lang);
      return { status: "accepted" as const, applied: r.count };
    });
  }

  // ---------- Hook（§5.5、§5.6） ----------

  private async snapshot(task: Task): Promise<{ snap: Snapshot; noGit: string[] }> {
    const state = await dirtyState(task.paths, [this.home]);
    return { snap: state.snapshot, noGit: state.noGit };
  }

  async sessionStart(input: HookInput, maxChars: number): Promise<string | null> {
    const r = this.resolve({ cwds: [input.cwd, ...input.roots] });
    if (!r.task) return null;
    const { snap } = await this.snapshot(r.task);
    const now = this.nowUtc();
    dbx.upsertSession(this.db, {
      agent: input.agent,
      session_id: input.sessionId ?? "unknown",
      task: r.task.slug,
      cwd: input.cwd,
      started_at: now,
      window_start: now,
      dirty_snapshot: JSON.stringify(snap),
      blocks: 0,
      last_block_at: null,
    });
    const { text } = this.contextFor(r.task, input.agent, {
      scene: "code",
      budget: this.config.pack.defaultBudget,
      maxChars,
      origin: "hook",
      // 恢复会话时只补「你离开后」；但这个工具从没进过这个任务时，要给完整的包
      sinceOnly: input.source === "resume" && dbx.getWatermark(this.db, input.agent, r.task.slug) !== null,
    });
    return text;
  }

  async stopCheck(input: HookInput): Promise<{ action: "allow" } | { action: "block"; message: string }> {
    const allow = { action: "allow" } as const;
    const r = this.resolve({ cwds: [input.cwd, ...input.roots] });
    if (!r.task) return allow;
    const task = r.task;
    const sid = input.sessionId ?? "unknown";
    const now = this.clock();
    const row = dbx.getSession(this.db, input.agent, sid);
    const { snap, noGit } = await this.snapshot(task);
    const roll = (blocks = 0, lastBlockAt: string | null = null, keepWindow = false) =>
      dbx.upsertSession(this.db, {
        agent: input.agent,
        session_id: sid,
        task: task.slug,
        cwd: input.cwd,
        started_at: row?.started_at ?? now.toISOString(),
        window_start: keepWindow && row ? row.window_start : now.toISOString(),
        dirty_snapshot: keepWindow && row ? row.dirty_snapshot : JSON.stringify(snap),
        blocks,
        last_block_at: lastBlockAt,
      });

    if (input.stopStatus && input.stopStatus !== "completed") return allow; // 中断或出错：不拦截，也不开始新的一轮
    if (this.config.agents[input.agent]?.stopCheck === false) {
      roll();
      return allow;
    }
    const recentBlock = row?.last_block_at ? now.getTime() - Date.parse(row.last_block_at) < HOOK_LIMITS.localLoopGuardMin * 60_000 : false;
    if (input.continued === true || (input.continued === null && (row?.blocks ?? 0) >= 1 && recentBlock)) {
      roll();
      return allow;
    }

    const events = readEvents(task.dir);
    const own = events.filter((e) => e.agent === input.agent);
    const fallback = Math.max(
      own.length ? Date.parse((own[own.length - 1] as HotseatEvent).time) : 0,
      now.getTime() - HOOK_LIMITS.fallbackWindowMin * 60_000,
    );
    const windowStart = row ? Date.parse(row.window_start) : fallback;
    const prev = row ? (JSON.parse(row.dirty_snapshot) as Snapshot) : null;
    const changed = [...changedSince(prev, snap, windowStart), ...walkChanged(noGit, windowStart, [this.home])];
    const recorded = own.some((e) => e.kind === "progress" && Date.parse(e.time) >= windowStart - 1000);

    if (changed.length === 0 || recorded) {
      roll();
      return allow;
    }
    const shown = changed.slice(0, HOOK_LIMITS.blockMessageMaxFiles).map((p) => {
      const root = task.paths.filter((x) => contains(x, p)).sort((a, b) => b.length - a.length)[0];
      return root ? relative(root, p) : p;
    });
    const more = changed.length > shown.length ? (this.lang === "zh" ? " 等" : ", …") : "";
    const message = STOP_BLOCK_MESSAGE[this.lang]
      .replace("{count}", String(changed.length))
      .replace("{files}", `${shown.join(this.lang === "zh" ? "、" : ", ")}${more}`);
    roll((row?.blocks ?? 0) + 1, now.toISOString(), true);
    return { action: "block", message };
  }
}

function eventText(ev: HotseatEvent): string {
  switch (ev.kind) {
    case "progress":
      return [
        ev.summary,
        ...(ev.decisions ?? []).map((d) => reasoned(d.what, d.why)),
        ...(ev.rejected ?? []).map((d) => reasoned(d.what, d.why)),
        ...(ev.constraints ?? []),
        ev.state ?? "",
        ...(ev.next ?? []),
        ...(ev.files ?? []),
      ]
        .filter(Boolean)
        .join("\n");
    case "subtask":
      return [ev.subtask, ev.to, ev.note ?? ""].filter(Boolean).join(" ");
    default:
      return "";
  }
}
