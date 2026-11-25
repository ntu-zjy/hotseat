// 公共类型：Agent 身份、编号格式、枚举。见 docs/interfaces.md §0。
import { z } from "zod";

export const SCHEMA_VERSION = 1;
export const Version = z.literal(SCHEMA_VERSION);

/** HOTSEAT_AGENT 的取值（§0.1）。 */
export const AGENT_IDS = [
  "claude",
  "claude-desktop",
  "codex",
  "cursor",
  "agy",
  "trae",
  "trae-cn",
  "workbuddy",
  "codebuddy",
  "qoder",
  "qoder-cn",
  "lingma",
  "copilot",
  "kiro",
  "windsurf",
  "kimi",
  "gemini",
  "opencode",
  "qwen",
  "iflow",
  "cline",
  "kilo",
  "human",
  "unknown",
] as const;
export const AgentId = z.enum(AGENT_IDS);
export type AgentId = z.infer<typeof AgentId>;

export const TaskSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/, "slug 只能是小写字母、数字和短横线，2–48 个字符");
export const EventId = z.string().regex(/^e_\d{6,}$/);
export const ProposalId = z.string().regex(/^p_\d{4,}$/);
export const SubtaskId = z.string().regex(/^T\d+$/);
export const IsoTime = z.iso.datetime({ offset: true });

export const TaskStatus = z.enum(["active", "paused", "done", "archived"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const SubtaskStatus = z.enum(["todo", "doing", "done", "blocked", "dropped"]);
export type SubtaskStatus = z.infer<typeof SubtaskStatus>;

export const MemorySection = z.enum(["goal", "decisions", "constraints", "rejected", "notes"]);
export type MemorySection = z.infer<typeof MemorySection>;

export const Scene = z.enum(["code", "research", "review", "plan"]);
export type Scene = z.infer<typeof Scene>;

export const Lang = z.enum(["zh", "en"]);
export type Lang = z.infer<typeof Lang>;

export const InstallPart = z.enum(["mcp", "rules", "hooks"]);
export type InstallPart = z.infer<typeof InstallPart>;

export function formatEventId(seq: number): string {
  return `e_${String(seq).padStart(6, "0")}`;
}

export function formatProposalId(n: number): string {
  return `p_${String(n).padStart(4, "0")}`;
}
