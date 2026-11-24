// 上下文包：分节、场景排序、预算估算。见 docs/interfaces.md §3。
import { z } from "zod";
import type { Scene } from "./common.ts";

export const PACK_SECTIONS = [
  "since", // 你离开后
  "goal",
  "constraints",
  "current_subtask",
  "plan_all", // plan 场景：全部子任务
  "state_next", // 做到一半 / 下一步
  "decisions",
  "rejected",
  "recent", // 最近进度
  "files", // 资料索引
  "other", // memory.md 里不认识的标题
] as const;
export const PackSection = z.enum(PACK_SECTIONS);
export type PackSection = z.infer<typeof PackSection>;

/** 固定在最前面、永远不截断的部分。 */
export const PINNED_SECTIONS = ["goal", "constraints"] as const satisfies readonly PackSection[];

/** 固定部分之后的顺序；超预算时从末尾开始压缩、再去掉。 */
export const SCENE_ORDER: Record<Scene, readonly PackSection[]> = {
  code: ["since", "current_subtask", "state_next", "decisions", "rejected", "recent", "files", "other"],
  research: ["since", "files", "rejected", "decisions", "state_next", "recent", "current_subtask", "other"],
  review: ["since", "decisions", "recent", "current_subtask", "rejected", "state_next", "files", "other"],
  plan: ["since", "plan_all", "rejected", "decisions", "recent", "state_next", "files", "other"],
};

export const PACK_LIMITS = {
  defaultBudget: 5000,
  minBudget: 200,
  maxBudget: 8000,
  sinceMaxEvents: 10,
  condensedListItems: 3,
  recentEvents: 5,
  /** 压缩时每行最多约多少 token（超出的截短，加「…」，出处标记保留） */
  condensedLineTokens: 50,
  /** 压缩时关键决定、放弃过的方案最多保留几条 */
  condensedMemoryItems: 15,
} as const;

/** 和 docs/interfaces.md §3.2 的标题保持一致。 */
export const PACK_TITLES: Record<"zh" | "en", Record<PackSection, string>> = {
  zh: {
    since: "你离开后",
    goal: "目标",
    constraints: "约束（必须遵守）",
    current_subtask: "当前子任务",
    plan_all: "全部子任务",
    state_next: "做到一半 / 下一步",
    decisions: "关键决定",
    rejected: "放弃过的方案",
    recent: "最近进度",
    files: "资料（需要时用 read_task_file 读全文）",
    other: "其他",
  },
  en: {
    since: "Since you left",
    goal: "Goal",
    constraints: "Constraints (must follow)",
    current_subtask: "Current subtask",
    plan_all: "All subtasks",
    state_next: "Half-done state / next steps",
    decisions: "Key decisions",
    rejected: "Rejected approaches",
    recent: "Recent progress",
    files: "Files (read in full with read_task_file when needed)",
    other: "Other",
  },
};

// 中日韩文字、假名、韩文、全角符号和中文标点
const WIDE_CHAR = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/u;

/** 粗略估算 token 数：宽字符每个算 1，其他字符每 4 个算 1。只用来控制长度。 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let other = 0;
  for (const ch of text) {
    if (WIDE_CHAR.test(ch)) wide++;
    else other++;
  }
  return Math.ceil(wide + other / 4);
}

/** 把一行截到大约 maxTokens 以内，加「…」；末尾的出处标记 〔…〕 保留。 */
export function clipLine(line: string, maxTokens: number): string {
  if (estimateTokens(line) <= maxTokens) return line;
  const m = /\s*〔[^〕]*〕$/u.exec(line);
  const tag = m ? m[0] : "";
  const body = m ? line.slice(0, m.index) : line;
  let used = 0;
  let out = "";
  for (const ch of body) {
    used += WIDE_CHAR.test(ch) ? 1 : 0.25;
    if (used > maxTokens) break;
    out += ch;
  }
  return `${out.trimEnd()}…${tag}`;
}
