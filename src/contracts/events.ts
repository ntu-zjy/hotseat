// events.jsonl 的事件格式。见 docs/interfaces.md §1.6。
// 事件只追加、从不改写，所以读取时丢掉不认识的字段没有影响（文件里仍然保留）。
import { z } from "zod";
import { AgentId, EventId, IsoTime, ProposalId, SubtaskId, SubtaskStatus, Version } from "./common.ts";
import { MemoryEdit, PlanMode } from "./storage.ts";

export const EVENT_LIMITS = {
  summary: 500,
  short: 300,
  state: 500,
  listItems: 10,
  decisionItems: 20,
  files: 50,
} as const;

const Short = z.string().trim().min(1).max(EVENT_LIMITS.short);

/** 决定或放弃的方案。lasting=true 表示长期有效，会自动提议写入 memory.md。 */
export const ReasonedItem = z.object({
  what: Short,
  why: Short.optional(),
  lasting: z.boolean().optional(),
});
export type ReasonedItem = z.infer<typeof ReasonedItem>;

/** record_progress 的内容字段，事件和工具参数共用。 */
export const progressFields = {
  subtask: SubtaskId.optional(),
  summary: z.string().trim().min(1).max(EVENT_LIMITS.summary),
  decisions: z.array(ReasonedItem).max(EVENT_LIMITS.decisionItems).optional(),
  rejected: z.array(ReasonedItem).max(EVENT_LIMITS.decisionItems).optional(),
  constraints: z.array(Short).max(EVENT_LIMITS.listItems).optional(),
  state: z.string().trim().min(1).max(EVENT_LIMITS.state).optional(),
  next: z.array(Short).max(EVENT_LIMITS.listItems).optional(),
  files: z.array(z.string().min(1).max(500)).max(EVENT_LIMITS.files).optional(),
};

const eventBase = {
  v: Version,
  id: EventId,
  seq: z.number().int().positive(),
  time: IsoTime,
  agent: AgentId,
  session: z.string().nullable(),
};

export const ProgressEvent = z.object({ ...eventBase, kind: z.literal("progress"), ...progressFields });
export const SubtaskEvent = z.object({
  ...eventBase,
  kind: z.literal("subtask"),
  subtask: SubtaskId,
  from: SubtaskStatus.nullable(),
  to: SubtaskStatus,
  note: Short.optional(),
});
export const MemoryAppliedEvent = z.object({
  ...eventBase,
  kind: z.literal("memory_applied"),
  proposal: ProposalId,
  edits: z.array(MemoryEdit),
});
export const PlanAppliedEvent = z.object({
  ...eventBase,
  kind: z.literal("plan_applied"),
  proposal: ProposalId,
  mode: PlanMode,
  count: z.number().int().nonnegative(),
});
export const TaskCreatedEvent = z.object({
  ...eventBase,
  kind: z.literal("task_created"),
  name: z.string().min(1).max(80),
  paths: z.array(z.string()),
});

export const EVENT_KINDS = ["progress", "subtask", "memory_applied", "plan_applied", "task_created"] as const;

export const HotseatEvent = z.discriminatedUnion("kind", [
  ProgressEvent,
  SubtaskEvent,
  MemoryAppliedEvent,
  PlanAppliedEvent,
  TaskCreatedEvent,
]);
export type HotseatEvent = z.infer<typeof HotseatEvent>;
export type ProgressEvent = z.infer<typeof ProgressEvent>;

/**
 * 解析 events.jsonl 的一行。
 * - 不完整或无法解析的 JSON（例如写到一半的最后一行）返回 null；
 * - 新版本才有的 kind 返回 "unknown"，调用方跳过即可（§8 只加字段、不删字段）。
 */
export function parseEventLine(line: string): HotseatEvent | "unknown" | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const kind = (raw as { kind?: unknown } | null)?.kind;
  if (typeof kind === "string" && !(EVENT_KINDS as readonly string[]).includes(kind)) return "unknown";
  const parsed = HotseatEvent.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
