// 在进程内调用 11 个工具：结构化数据符合 TOOL_OUTPUTS；给 MCP 的结果只有文本。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TOOL_NAMES, TOOL_OUTPUTS, type ToolName } from "../contracts/tools.ts";
import { callTool, runTool, type McpContext } from "./server.ts";

test("每个工具的结构化数据都符合 TOOL_OUTPUTS；MCP 结果只有文本", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hotseat-mcp-")));
  const project = join(root, "proj");
  mkdirSync(project);
  const ctx: McpContext = { env: { HOME: root, HOTSEAT_HOME: join(root, "Hotseat"), HOTSEAT_AGENT: "codex" } };
  const cwd = project;
  const calls: [ToolName, Record<string, unknown>][] = [
    ["create_task", { cwd, name: "MCP test", goal: "目标" }],
    ["get_context", { cwd, scene: "review" }],
    ["record_progress", { cwd, summary: "做了一点", constraints: ["别动接口"] }],
    ["propose_memory_edit", { cwd, edits: [{ op: "add", section: "notes", text: "备注一条" }], reason: "测试" }],
    ["propose_plan", { cwd, subtasks: [{ title: "第一步" }] }],
    ["list_tasks", { cwd }],
    ["switch_task", { cwd, slug: "mcp-test" }],
    ["search", { cwd, query: "做了一点" }],
    ["read_task_file", { cwd, path: "memory.md" }],
  ];
  const seen = new Set<ToolName>();
  for (const [name, args] of calls) {
    const r = await runTool(name, args, ctx);
    TOOL_OUTPUTS[name].parse(r.data);
    seen.add(name);
  }
  // 有了 plan 和 files 之后再测剩下两个
  writeFileSync(join(root, "Hotseat", "tasks", "mcp-test", "plan.md"), "# 计划\n\n- [ ] T1 第一步\n");
  TOOL_OUTPUTS.update_subtask.parse((await runTool("update_subtask", { cwd, id: "T1", status: "doing" }, ctx)).data);
  seen.add("update_subtask");
  writeFileSync(join(root, "Hotseat", "tasks", "mcp-test", "files", "a.png"), Buffer.from([0, 1, 2]));
  TOOL_OUTPUTS.annotate_file.parse((await runTool("annotate_file", { cwd, path: "files/a.png", summary: "截图" }, ctx)).data);
  seen.add("annotate_file");
  assert.deepEqual([...seen].sort(), [...TOOL_NAMES].sort());

  const ok = await callTool("get_context", { cwd }, ctx);
  assert.equal(ok.structuredContent, undefined);
  assert.match((ok.content[0] as { text: string }).text, /# Hotseat 交接 · MCP test/);
  const bad = await callTool("update_subtask", { cwd, id: "T9", status: "done" }, ctx);
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent, undefined);
  assert.match((bad.content[0] as { text: string }).text, /^SUBTASK_NOT_FOUND: .*（T1）$/);
});
