// plan.md 的解析、修改、比较。见 docs/interfaces.md §1.5。
import type { Lang, SubtaskStatus } from "../contracts/common.ts";
import { PLAN_FIELD_SEPARATOR, PLAN_LINE_RE, PLAN_STATUS_MARKS, type PlanSubtask } from "../contracts/storage.ts";

export interface Subtask {
  id: string;
  status: SubtaskStatus;
  title: string;
  deps: string[];
  files: string[];
  accept: string | null;
  extras: [string, string][];
  line: number;
  notes: string[];
}

export const STATUS_LABEL: Record<Lang, Record<SubtaskStatus, string>> = {
  zh: { todo: "未开始", doing: "进行中", done: "完成", blocked: "卡住", dropped: "不做了" },
  en: { todo: "todo", doing: "doing", done: "done", blocked: "blocked", dropped: "dropped" },
};

const MARK_TO_STATUS: Record<string, SubtaskStatus> = { " ": "todo", "~": "doing", x: "done", X: "done", "!": "blocked", "-": "dropped" };
const LIST_SPLIT = /\s*[,，]\s*/u;

export function parsePlan(text: string): Subtask[] {
  const out: Subtask[] = [];
  let cur: Subtask | null = null;
  text.replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
    const m = PLAN_LINE_RE.exec(line);
    if (m) {
      const [title = "", ...fields] = (m[3] ?? "").split(PLAN_FIELD_SEPARATOR);
      cur = {
        id: m[2] ?? "",
        status: MARK_TO_STATUS[m[1] ?? " "] ?? "todo",
        title: title.trim(),
        deps: [],
        files: [],
        accept: null,
        extras: [],
        line: i,
        notes: [],
      };
      for (const field of fields) {
        const idx = field.search(/[:：]/u);
        if (idx < 0) {
          cur.extras.push(["", field.trim()]);
          continue;
        }
        const key = field.slice(0, idx).trim();
        const value = field.slice(idx + 1).trim();
        if (key === "deps") cur.deps = value.split(LIST_SPLIT).filter(Boolean);
        else if (key === "files") cur.files = value.split(LIST_SPLIT).filter(Boolean);
        else if (key === "验收" || key.toLowerCase() === "accept") cur.accept = value;
        else cur.extras.push([key, value]);
      }
      out.push(cur);
      return;
    }
    const note = /^\s+[-*]\s+(.*)$/.exec(line);
    if (cur && note?.[1]) cur.notes.push(note[1]);
    else if (line.trim() !== "") cur = null;
  });
  return out;
}

export function formatSubtask(s: Pick<Subtask, "id" | "status" | "title"> & Partial<Subtask>, lang: Lang): string {
  const fields = [s.title];
  if (s.deps?.length) fields.push(`deps: ${s.deps.join(", ")}`);
  if (s.files?.length) fields.push(`files: ${s.files.join(", ")}`);
  if (s.accept) fields.push(`${lang === "zh" ? "验收" : "accept"}: ${s.accept}`);
  for (const [k, v] of s.extras ?? []) fields.push(k ? `${k}: ${v}` : v);
  return `- [${PLAN_STATUS_MARKS[s.status]}] ${s.id} ${fields.join(PLAN_FIELD_SEPARATOR)}`;
}

/** 第一个进行中的；没有的话，第一个依赖都完成了的未开始项。 */
export function currentSubtask(subtasks: readonly Subtask[]): Subtask | null {
  const doing = subtasks.find((s) => s.status === "doing");
  if (doing) return doing;
  const done = new Set(subtasks.filter((s) => s.status === "done" || s.status === "dropped").map((s) => s.id));
  return subtasks.find((s) => s.status === "todo" && s.deps.every((d) => done.has(d))) ?? null;
}

export function setSubtaskStatus(
  text: string,
  id: string,
  status: SubtaskStatus,
  note: string | null,
  meta: { date: string; agent: string },
): { text: string; from: SubtaskStatus } | null {
  const subtask = parsePlan(text).find((s) => s.id === id);
  if (!subtask) return null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const line = lines[subtask.line] ?? "";
  lines[subtask.line] = `${line.slice(0, 3)}${PLAN_STATUS_MARKS[status]}${line.slice(4)}`;
  if (note) {
    let at = subtask.line + 1;
    while (at < lines.length && /^\s+[-*]\s+/.test(lines[at] ?? "")) at++;
    lines.splice(at, 0, `  - ${meta.date} ${meta.agent}：${note}`);
  }
  return { text: lines.join("\n"), from: subtask.status };
}

export interface PlanDiff {
  added: Subtask[];
  removed: Subtask[];
  changed: { id: string; title: string; from: SubtaskStatus; to: SubtaskStatus }[];
}

export function diffPlan(before: string | null, after: string | null): PlanDiff {
  const a = new Map(parsePlan(before ?? "").map((s) => [s.id, s]));
  const b = new Map(parsePlan(after ?? "").map((s) => [s.id, s]));
  const diff: PlanDiff = { added: [], removed: [], changed: [] };
  for (const [id, s] of b) {
    const old = a.get(id);
    if (!old) diff.added.push(s);
    else if (old.status !== s.status) diff.changed.push({ id, title: s.title, from: old.status, to: s.status });
  }
  for (const [id, s] of a) if (!b.has(id)) diff.removed.push(s);
  return diff;
}

export function applyPlanProposal(
  text: string | null,
  subtasks: readonly PlanSubtask[],
  mode: "replace" | "append",
  taskName: string,
  lang: Lang,
): { text: string; count: number } {
  const existing = mode === "append" && text ? parsePlan(text) : [];
  let next = Math.max(0, ...existing.map((s) => Number(s.id.slice(1)))) + 1;
  const lines = subtasks.map((s) =>
    formatSubtask(
      { id: s.id ?? `T${next++}`, status: "todo", title: s.title, deps: s.deps ?? [], files: s.files ?? [], accept: s.accept ?? null },
      lang,
    ),
  );
  const header = `# ${lang === "zh" ? "计划" : "Plan"} · ${taskName}`;
  const body = mode === "append" && text ? `${text.replace(/\s+$/u, "")}\n${lines.join("\n")}\n` : `${header}\n\n${lines.join("\n")}\n`;
  return { text: body, count: lines.length };
}
