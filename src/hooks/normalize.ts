// 各工具 Hook 输入 → 统一输入；统一决定 → 各工具输出。实现 docs/interfaces.md §5.4 的映射表。
// 纯函数，不读写磁盘。字段一律防御式读取：类型不对就当作没有，不抛错（Hook 要放行而不是崩溃）。
import type { AgentId } from "../contracts/common.ts";
import { HotseatError } from "../contracts/errors.ts";
import {
  AGENT_HOOK_FAMILY,
  SessionSource,
  StopStatus,
  type StopStatus as StopStatusT,
  type HookDecision,
  type HookEvent,
  type HookFamily,
  type HookInput,
  type HookOutput,
} from "../contracts/hooks.ts";

type Env = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strArr = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return out.length > 0 ? out : null;
};

function familyOf(agent: AgentId): HookFamily {
  const family = AGENT_HOOK_FAMILY[agent];
  if (!family) throw new HotseatError("INVALID_INPUT", `${agent} 不支持 Hook`);
  return family;
}

function withRoots(cwd: string | null, roots: string[] | null): { cwd: string | null; roots: string[] } {
  const first = cwd ?? roots?.[0] ?? null;
  const all = [...(first ? [first] : []), ...(roots ?? [])];
  return { cwd: first, roots: [...new Set(all)] };
}

/** 只有正常结束才算 completed；用户取消、出错、步数用完、后台任务没结束，都不拦截。 */
const AGY_NORMAL_END = new Set(["NO_TOOL_CALL", "TERMINAL_STEP_TYPE"]);
function agyStopStatus(r: Raw): StopStatusT {
  const reason = str(r.terminationReason);
  if (str(r.error) || reason === "ERROR") return "error";
  if (reason === "USER_CANCELED") return "aborted";
  if (reason && !AGY_NORMAL_END.has(reason)) return "aborted";
  if (r.fullyIdle === false) return "aborted";
  return "completed";
}

export function normalizeHookInput(agent: AgentId, event: HookEvent, raw: unknown, env: Env = {}): HookInput {
  const family = familyOf(agent);
  const r: Raw = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Raw) : {};
  const isStart = event !== "stop";
  const base = { v: 1 as const, agent, event };

  switch (family) {
    // Gemini CLI 的字段和 Claude Code 一样（session_id、cwd、stop_hook_active、transcript_path）
    case "gemini":
    case "claude": {
      const dirs = withRoots(str(r.cwd) ?? str(env.CLAUDE_PROJECT_DIR) ?? str(env.GEMINI_PROJECT_DIR), null);
      const source = SessionSource.safeParse(r.source);
      return {
        ...base,
        sessionId: str(r.session_id),
        turnId: str(r.prompt_id) ?? str(r.turn_id),
        ...dirs,
        source: isStart && source.success ? source.data : null,
        continued: isStart ? null : bool(r.stop_hook_active),
        stopStatus: isStart ? null : "completed",
        lastAssistantMessage: str(r.last_assistant_message),
        transcriptPath: str(r.transcript_path),
      };
    }
    case "cursor": {
      const envDir = str(env.CURSOR_PROJECT_DIR);
      const dirs = withRoots(null, strArr(r.workspace_roots) ?? (envDir ? [envDir] : null));
      const loop = num(r.loop_count);
      const status = StopStatus.safeParse(r.status);
      return {
        ...base,
        sessionId: str(r.session_id) ?? str(r.conversation_id),
        turnId: str(r.generation_id),
        ...dirs,
        source: null,
        continued: isStart || loop === null ? null : loop > 0,
        stopStatus: isStart ? null : status.success ? status.data : "completed",
        lastAssistantMessage: null,
        transcriptPath: str(r.transcript_path),
      };
    }
    // Kimi Code：字段一律 snake_case；Stop 带 turn_id 和 stop_hook_active
    case "kimi": {
      const dirs = withRoots(str(r.cwd), null);
      return {
        ...base,
        sessionId: str(r.session_id),
        turnId: str(r.turn_id),
        ...dirs,
        source: null,
        continued: isStart ? null : bool(r.stop_hook_active),
        stopStatus: isStart ? null : "completed",
        lastAssistantMessage: null,
        transcriptPath: null,
      };
    }
    case "agy": {
      const dirs = withRoots(str(r.cwd), strArr(r.workspacePaths));
      const exec = num(r.executionNum);
      return {
        ...base,
        sessionId: str(r.conversationId),
        turnId: exec === null ? null : String(exec),
        ...dirs,
        source: null,
        continued: isStart ? null : bool(r.continuationActive),
        stopStatus: isStart ? null : agyStopStatus(r),
        lastAssistantMessage: null,
        transcriptPath: str(r.transcriptPath),
      };
    }
  }
}

const json = (v: unknown): HookOutput => ({ stdout: JSON.stringify(v), exitCode: 0 });
const empty: HookOutput = { stdout: "", exitCode: 0 };

export function renderHookOutput(agent: AgentId, decision: HookDecision): HookOutput {
  const family = familyOf(agent);

  switch (family) {
    case "claude": {
      if (decision.event !== "stop") {
        if (decision.context === null) return empty;
        // 通义灵码等没有会话开始事件的，在第一条消息（UserPromptSubmit）时注入
        if (decision.event === "prompt") return json({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: decision.context } });
        // Codex 官方写明纯文本会作为开发者上下文；其他 Claude 族用 Claude Code 的 JSON 格式。
        if (agent === "codex") return { stdout: decision.context, exitCode: 0 };
        return json({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: decision.context } });
      }
      if (decision.action === "allow") return empty;
      return json({
        decision: "block",
        reason: decision.message,
        // Claude Code 文档：reason 显示给用户，additionalContext 是 Claude 看到的提示。
        ...(agent === "claude"
          ? { hookSpecificOutput: { hookEventName: "Stop", additionalContext: decision.message } }
          : {}),
      });
    }
    // Gemini CLI：SessionStart 和 Claude 一样；每轮结束是 AfterAgent，decision 为 deny 时 reason 作为新提示让它接着做
    case "gemini": {
      if (decision.event !== "stop") {
        return decision.context === null ? empty : json({ hookSpecificOutput: { hookEventName: decision.event === "prompt" ? "BeforeAgent" : "SessionStart", additionalContext: decision.context } });
      }
      return decision.action === "allow" ? empty : json({ decision: "deny", reason: decision.message });
    }
    // Kimi Code（本机 0.30 程序核对）：SessionStart 的输出会被丢掉，所以在第一条消息（UserPromptSubmit）时用 message 注入；
    // Stop 用 hookSpecificOutput.permissionDecision = deny 拦截，permissionDecisionReason 作为用户消息让它接着做（每轮最多一次）
    case "kimi": {
      if (decision.event !== "stop") return decision.context === null ? empty : json({ message: decision.context });
      return decision.action === "allow" ? empty : json({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: decision.message } });
    }
    case "cursor": {
      if (decision.event !== "stop") {
        return json(decision.context === null ? {} : { additional_context: decision.context });
      }
      return json(decision.action === "allow" ? {} : { followup_message: decision.message });
    }
    case "agy": {
      if (decision.event !== "stop") {
        return json(
          decision.context === null ? {} : { injectSteps: [{ systemMessage: { systemMessage: decision.context } }] },
        );
      }
      // 官方要求 Stop 必须输出 JSON 决定：continue 继续，其他值放行。
      return json(
        decision.action === "allow" ? { decision: "stop" } : { decision: "continue", reason: decision.message },
      );
    }
  }
}
