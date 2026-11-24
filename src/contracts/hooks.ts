// Hook：统一输入输出、各工具原始输入的形状、工具与协议族的对应。见 docs/interfaces.md §5。
import { z } from "zod";
import { AgentId, Version, type AgentId as AgentIdT } from "./common.ts";

export const HOOK_EVENTS = ["session-start", "stop"] as const;
export const HookEvent = z.enum(HOOK_EVENTS);
export type HookEvent = z.infer<typeof HookEvent>;

export const SessionSource = z.enum(["startup", "resume", "clear", "compact", "fork"]);
export type SessionSource = z.infer<typeof SessionSource>;

export const StopStatus = z.enum(["completed", "aborted", "error"]);
export type StopStatus = z.infer<typeof StopStatus>;

/** 统一输入（§5.2）。 */
export const HookInput = z.object({
  v: Version,
  agent: AgentId,
  event: HookEvent,
  sessionId: z.string().nullable(),
  turnId: z.string().nullable(),
  cwd: z.string().nullable(),
  roots: z.array(z.string()),
  source: SessionSource.nullable(),
  continued: z.boolean().nullable(),
  stopStatus: StopStatus.nullable(),
  lastAssistantMessage: z.string().nullable(),
  transcriptPath: z.string().nullable(),
});
export type HookInput = z.infer<typeof HookInput>;

/** 统一输出（§5.3）。 */
export type HookDecision =
  | { event: "session-start"; context: string | null }
  | { event: "stop"; action: "allow" }
  | { event: "stop"; action: "block"; message: string };

/** 退出码永远是 0（§5.1）。 */
export interface HookOutput {
  stdout: string;
  exitCode: 0;
}

// ---------- 协议族（§5.4） ----------

export const HOOK_FAMILIES = ["claude", "cursor", "agy"] as const;
export type HookFamily = (typeof HOOK_FAMILIES)[number];

export const AGENT_HOOK_FAMILY: Record<AgentIdT, HookFamily | null> = {
  claude: "claude",
  "claude-desktop": null,
  codex: "claude",
  cursor: "cursor",
  agy: "agy",
  trae: "claude",
  "trae-cn": "claude",
  workbuddy: "claude",
  codebuddy: "claude",
  qoder: "claude",
  "qoder-cn": "claude",
  lingma: "claude",
  copilot: "cursor",
  kiro: null,
  windsurf: null,
  human: null,
  unknown: null,
};

/** Claude 族的原始输入（Claude Code 官方文档 + Codex 官方文档）。只列 Hotseat 用到的字段。 */
export interface ClaudeFamilyRaw {
  session_id?: string;
  prompt_id?: string; // Claude
  turn_id?: string; // Codex
  cwd?: string;
  hook_event_name?: string;
  source?: string; // SessionStart
  stop_hook_active?: boolean; // Stop
  last_assistant_message?: string; // Stop
  transcript_path?: string;
}

/** Cursor 族的原始输入（cursor.com/docs/agent/hooks）。 */
export interface CursorFamilyRaw {
  conversation_id?: string;
  generation_id?: string;
  session_id?: string; // sessionStart
  hook_event_name?: string;
  workspace_roots?: string[];
  status?: "completed" | "aborted" | "error"; // stop
  loop_count?: number; // stop，从 0 开始
  transcript_path?: string | null;
}

/** agy 的原始输入（以 agy 程序内嵌的 Hooks 文档为准，2026-11-24 核对）。键名一律 camelCase。 */
export interface AgyFamilyRaw {
  conversationId?: string;
  workspacePaths?: string[];
  cwd?: string; // Agent 的工作目录（不是 Hook 进程的工作目录）
  hookEventName?: string;
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  modelName?: string;
  lastUserInput?: string;
  executionNum?: number; // Stop
  /** Stop：NO_TOOL_CALL 为正常结束；另有 USER_CANCELED、ERROR、MAX_INVOCATIONS、MAX_FORCED_INVOCATIONS、MAX_TOKEN_BUDGET_EXCEEDED、TERMINAL_STEP_TYPE、TERMINAL_CUSTOM_HOOK、INJECTED_RESPONSE */
  terminationReason?: string;
  error?: string; // Stop，出错时才有
  fullyIdle?: boolean; // Stop：后台任务是否都结束了
  continuationActive?: boolean; // Stop：本轮是否已被 Stop Hook 要求继续过（agy 自带的防循环标记）
}

// ---------- 限制和常量（§5.1、§5.6） ----------

export const HOOK_LIMITS = {
  maxStdinBytes: 1_048_576,
  internalBudgetMs: 1500,
  configTimeoutSec: 10,
  localLoopGuardMin: 10,
  fallbackWindowMin: 30,
  sessionAttributionHours: 12,
  noGitMaxFiles: 20_000,
  noGitMaxMs: 300,
  blockMessageMaxFiles: 3,
} as const;

export const NO_GIT_SKIP_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "target",
  ".venv",
  "__pycache__",
] as const;

/** 拦截提示（§5.6）。{count} 和 {files} 由调用方替换。 */
export const STOP_BLOCK_MESSAGE = {
  zh:
    "Hotseat：本轮改动了 {count} 个文件（{files}），但还没有记录进度。" +
    "请调用 hotseat 的 record_progress 工具，写清做了什么、决定和理由、放弃的方案、用户提出的要求、做到一半的状态和下一步，然后再结束。" +
    "如果这些改动和当前任务无关，在 summary 里用一句话说明即可。",
  en:
    "Hotseat: this turn changed {count} file(s) ({files}) but no progress was recorded. " +
    "Call the hotseat record_progress tool with what you did, decisions and why, rejected approaches, requirements the user stated, half-done state and next steps, then finish. " +
    "If the changes are unrelated to the current task, say so in one sentence in the summary.",
} as const;
