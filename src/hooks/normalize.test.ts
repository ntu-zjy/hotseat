// 用各工具官方文档里的输入样例，校验 docs/interfaces.md §5.4 的映射。
import assert from "node:assert/strict";
import { test } from "node:test";
import { HookInput } from "../contracts/hooks.ts";
import { normalizeHookInput, renderHookOutput } from "./normalize.ts";

const block = { event: "stop", action: "block", message: "请先调用 record_progress" } as const;
const allow = { event: "stop", action: "allow" } as const;

test("Claude Code：会话开始", () => {
  const input = normalizeHookInput("claude", "session-start", {
    session_id: "abc123",
    prompt_id: "550e8400",
    transcript_path: "/home/u/.claude/projects/x/t.jsonl",
    cwd: "/home/u/proj",
    permission_mode: "default",
    hook_event_name: "SessionStart",
    source: "compact",
  });
  HookInput.parse(input);
  assert.equal(input.sessionId, "abc123");
  assert.equal(input.turnId, "550e8400");
  assert.deepEqual(input.roots, ["/home/u/proj"]);
  assert.equal(input.source, "compact");
  assert.equal(input.continued, null);

  const out = JSON.parse(renderHookOutput("claude", { event: "session-start", context: "# Hotseat 交接" }).stdout);
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "# Hotseat 交接" } });
  assert.equal(renderHookOutput("claude", { event: "session-start", context: null }).stdout, "");
});

test("Claude Code：每轮结束，带防循环标记；没有 cwd 时用 CLAUDE_PROJECT_DIR", () => {
  const input = normalizeHookInput(
    "claude",
    "stop",
    { session_id: "abc123", hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "完成了" },
    { CLAUDE_PROJECT_DIR: "/home/u/proj" },
  );
  assert.equal(input.continued, true);
  assert.equal(input.stopStatus, "completed");
  assert.equal(input.cwd, "/home/u/proj");
  assert.equal(input.lastAssistantMessage, "完成了");

  const out = JSON.parse(renderHookOutput("claude", block).stdout);
  assert.equal(out.decision, "block");
  assert.equal(out.reason, block.message);
  assert.equal(out.hookSpecificOutput.additionalContext, block.message);
  assert.equal(renderHookOutput("claude", allow).stdout, "");
});

test("Codex：会话开始输出纯文本；拦截时只有 decision 和 reason", () => {
  const input = normalizeHookInput("codex", "stop", {
    session_id: "s1",
    turn_id: "t9",
    cwd: "/w",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "done",
  });
  assert.equal(input.turnId, "t9");
  assert.equal(input.continued, false);
  assert.equal(renderHookOutput("codex", { event: "session-start", context: "ctx" }).stdout, "ctx");
  assert.deepEqual(JSON.parse(renderHookOutput("codex", block).stdout), { decision: "block", reason: block.message });
});

test("Claude 族的克隆工具不给 stop_hook_active 时，continued 为 null（改用本地计数）", () => {
  const input = normalizeHookInput("workbuddy", "stop", { session_id: "s", cwd: "/w" });
  assert.equal(input.continued, null);
});

test("Cursor：会话开始和每轮结束", () => {
  const start = normalizeHookInput("cursor", "session-start", {
    conversation_id: "c1",
    generation_id: "g1",
    hook_event_name: "sessionStart",
    workspace_roots: ["/w/a", "/w/b"],
    session_id: "s1",
    is_background_agent: false,
  });
  HookInput.parse(start);
  assert.equal(start.sessionId, "s1");
  assert.equal(start.cwd, "/w/a");
  assert.deepEqual(start.roots, ["/w/a", "/w/b"]);
  assert.deepEqual(JSON.parse(renderHookOutput("cursor", { event: "session-start", context: "ctx" }).stdout), {
    additional_context: "ctx",
  });

  const first = normalizeHookInput("cursor", "stop", { conversation_id: "c1", status: "completed", loop_count: 0 });
  assert.equal(first.sessionId, "c1");
  assert.equal(first.continued, false);
  const again = normalizeHookInput("cursor", "stop", { conversation_id: "c1", status: "aborted", loop_count: 1 });
  assert.equal(again.continued, true);
  assert.equal(again.stopStatus, "aborted");

  assert.deepEqual(JSON.parse(renderHookOutput("cursor", block).stdout), { followup_message: block.message });
  assert.equal(renderHookOutput("cursor", allow).stdout, "{}");
});

test("Cursor：没有 workspace_roots 时用 CURSOR_PROJECT_DIR", () => {
  const input = normalizeHookInput("cursor", "stop", { loop_count: 0 }, { CURSOR_PROJECT_DIR: "/w" });
  assert.equal(input.cwd, "/w");
});

test("agy：cwd、continuationActive、terminationReason 的映射；Stop 必须输出 JSON 决定", () => {
  const input = normalizeHookInput("agy", "stop", {
    conversationId: "uuid-1",
    workspacePaths: ["/w", "/w2"],
    cwd: "/w/sub",
    hookEventName: "Stop",
    transcriptPath: "/t",
    modelName: "auto",
    executionNum: 3,
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
    continuationActive: false,
  });
  HookInput.parse(input);
  assert.equal(input.sessionId, "uuid-1");
  assert.equal(input.turnId, "3");
  assert.equal(input.cwd, "/w/sub");
  assert.deepEqual(input.roots, ["/w/sub", "/w", "/w2"]);
  assert.equal(input.continued, false);
  assert.equal(input.stopStatus, "completed");
  assert.equal(normalizeHookInput("agy", "stop", { continuationActive: true }).continued, true);
  assert.equal(normalizeHookInput("agy", "stop", {}).continued, null); // 老版本没有这个字段：用本地计数
  assert.equal(normalizeHookInput("agy", "stop", { workspacePaths: ["/w"] }).cwd, "/w");
  const status = (raw: object) => normalizeHookInput("agy", "stop", raw).stopStatus;
  assert.equal(status({ error: "boom" }), "error");
  assert.equal(status({ terminationReason: "ERROR" }), "error");
  assert.equal(status({ terminationReason: "USER_CANCELED" }), "aborted");
  assert.equal(status({ terminationReason: "MAX_INVOCATIONS" }), "aborted");
  assert.equal(status({ terminationReason: "NO_TOOL_CALL", fullyIdle: false }), "aborted");
  assert.equal(status({ terminationReason: "TERMINAL_STEP_TYPE" }), "completed");

  assert.deepEqual(JSON.parse(renderHookOutput("agy", allow).stdout), { decision: "stop" });
  assert.deepEqual(JSON.parse(renderHookOutput("agy", block).stdout), { decision: "continue", reason: block.message });
  assert.deepEqual(JSON.parse(renderHookOutput("agy", { event: "session-start", context: "ctx" }).stdout), {
    injectSteps: [{ systemMessage: { systemMessage: "ctx" } }],
  });
});

test("输入不是对象或字段类型不对时不抛错，按没有处理", () => {
  for (const raw of [null, "oops", 42, [], { cwd: 7, session_id: ["x"], stop_hook_active: "yes" }]) {
    const input = normalizeHookInput("claude", "stop", raw);
    HookInput.parse(input);
    assert.equal(input.cwd, null);
    assert.equal(input.continued, null);
  }
});

test("不支持 Hook 的工具会报 INVALID_INPUT", () => {
  assert.throws(() => normalizeHookInput("kiro", "stop", {}), { code: "INVALID_INPUT" });
});
