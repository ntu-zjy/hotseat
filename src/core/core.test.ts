import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HookInput } from "../contracts/hooks.ts";
import { ProgressEvent } from "../contracts/events.ts";
import { applyMemoryEdits, diffMemory, memoryItems, memoryTemplate, parseMemory } from "./memory.ts";
import { applyPlanProposal, currentSubtask, parsePlan, setSubtaskStatus } from "./plan.ts";
import { Hotseat } from "./service.ts";
import { readEvents } from "./store.ts";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

function setup() {
  const root = tmp("hotseat-");
  const home = join(root, "Hotseat");
  const project = join(root, "webapp");
  mkdirSync(project);
  return { root, home, project };
}

function hook(agent: HookInput["agent"], event: HookInput["event"], cwd: string, extra: Partial<HookInput> = {}): HookInput {
  return {
    v: 1,
    agent,
    event,
    sessionId: `${agent}-s1`,
    turnId: null,
    cwd,
    roots: [cwd],
    source: event === "session-start" ? "startup" : null,
    continued: event === "stop" ? false : null,
    stopStatus: event === "stop" ? "completed" : null,
    lastAssistantMessage: null,
    transcriptPath: null,
    ...extra,
  };
}

// ---------- memory.md ----------

test("memory：增删改按条目进行，保留来源标记，旧原文找不到就作废", () => {
  let text = memoryTemplate("登录态刷新", "过期自动刷新", "zh");
  let r = applyMemoryEdits(text, [{ op: "add", section: "constraints", text: "不要改 /api/v1" }], "zh", "e_000003");
  assert.deepEqual(r.applied.length, 1);
  text = r.text;
  assert.match(text, /## 约束\n- 不要改 \/api\/v1 〔e_000003〕/);
  r = applyMemoryEdits(text, [{ op: "add", section: "constraints", text: "不要改 /api/v1" }], "zh");
  assert.deepEqual(r.skipped, [0]);
  r = applyMemoryEdits(text, [
    { op: "replace", section: "constraints", old: "不要改 /api/v1", text: "不要改 /api/v1 和 /api/v2" },
    { op: "remove", section: "goal", old: "不存在的目标" },
  ], "zh");
  assert.deepEqual(r.stale, [1]);
  assert.deepEqual(memoryItems(parseMemory(r.text), "constraints"), ["不要改 /api/v1 和 /api/v2"]);
  const d = diffMemory(text, r.text);
  assert.equal(d.added[0]?.text, "不要改 /api/v1 和 /api/v2");
  assert.equal(d.removed[0]?.text, "不要改 /api/v1 〔e_000003〕");
});

test("memory：人手写的英文标题和未知标题都能识别", () => {
  const doc = parseMemory("# X\n\n## Goal\n- ship it\n  continued line\n\n## 随手记\n- 杂项\n");
  assert.deepEqual(memoryItems(doc, "goal"), ["ship it continued line"]);
  assert.equal(doc.sections[1]?.key, null);
});

// ---------- plan.md ----------

test("plan：解析、当前子任务、改状态并追加备注、追加计划", () => {
  const text = [
    "# 计划 · X",
    "",
    "- [x] T1 梳理流程 · files: src/auth/**",
    "- [ ] T2 刷新接口 · deps: T1 · 验收: 单测通过",
    "- [ ] T3 错误提示 · deps: T2",
  ].join("\n");
  const subs = parsePlan(text);
  assert.equal(subs.length, 3);
  assert.deepEqual(subs[1]?.deps, ["T1"]);
  assert.equal(subs[1]?.accept, "单测通过");
  assert.equal(currentSubtask(subs)?.id, "T2");
  const r = setSubtaskStatus(text, "T2", "doing", "拦截器写完了", { date: "2026-11-24", agent: "codex" });
  assert.ok(r);
  assert.equal(r.from, "todo");
  assert.match(r.text, /- \[~\] T2 刷新接口/);
  assert.match(r.text, /\n {2}- 2026-11-24 codex：拦截器写完了\n- \[ \] T3/);
  const appended = applyPlanProposal(r.text, [{ title: "补集成测试", deps: ["T3"] }], "append", "X", "zh");
  assert.equal(parsePlan(appended.text).at(-1)?.id, "T4");
});

// ---------- 完整交接流程 ----------

test("交接：Claude 记录 → agy 自动拿到上下文 → 回到 Claude 看到增量", async () => {
  const { home, project } = setup();
  let clock = new Date("2026-11-24T10:00:00+08:00");
  const svc = Hotseat.open({ home, env: {}, now: () => clock });
  const where = { cwds: [project] };

  const created = await svc.createTask("claude", { name: "Auth refresh", goal: "登录过期后自动刷新" }, where);
  assert.equal(created.data.slug, "auth-refresh");

  // 没绑定的目录：不报错，提示照常工作
  const other = svc.getContext("claude", {}, { cwds: [tmp("other-")] });
  assert.equal(other.data.task, null);
  assert.match(other.text, /照常工作/);

  // Claude 第一次进入：完整包，没有「你离开后」
  const first = svc.getContext("claude", {}, where);
  assert.equal(first.data.first_visit, true);
  assert.match(first.text, /## 目标\n- 登录过期后自动刷新/);
  assert.doesNotMatch(first.text, /你离开后/);

  clock = new Date("2026-11-24T10:30:00+08:00");
  const rec = await svc.recordProgress(
    "claude",
    {
      summary: "实现了 token 刷新，单测通过",
      decisions: [{ what: "刷新放在拦截器里", why: "避免每个请求各自处理", lasting: true }],
      rejected: [{ what: "定时器提前刷新", why: "多标签页会重复刷新" }],
      constraints: ["不要改动 /api/v1 的返回格式"],
      state: "登录页的错误提示还没接上",
      next: ["接错误提示", "补集成测试"],
      files: [join(project, "src/auth/interceptor.ts")],
      subtask: "T9",
    },
    where,
  );
  assert.equal(rec.data.event_id, "e_000002");
  assert.ok(rec.data.proposal_id);
  assert.match(rec.data.warnings.join(), /T9 不存在/);
  const ev = readEvents(join(home, "tasks", "auth-refresh")).at(-1);
  assert.equal(ProgressEvent.parse(ev).files?.[0], "src/auth/interceptor.ts");

  // agy 会话开始：自动注入，约束在提议确认前就能看到
  clock = new Date("2026-11-24T11:00:00+08:00");
  const injected = await svc.sessionStart(hook("agy", "session-start", project), 8000);
  assert.ok(injected);
  assert.match(injected, /# Hotseat 交接 · Auth refresh（auth-refresh）/);
  assert.match(injected, /你是 agy。上次记录：claude · 11-24 10:30/);
  assert.match(injected, /不需要再调用 get_context/);
  assert.match(injected, /## 约束（必须遵守）\n- 不要改动 \/api\/v1 的返回格式 〔claude · 11-24 10:30〕/);
  assert.match(injected, /半截：登录页的错误提示还没接上/);
  assert.match(injected, /下一步：接错误提示；补集成测试/);
  assert.match(injected, /刷新放在拦截器里 —— 避免每个请求各自处理/);
  assert.match(injected, /定时器提前刷新 —— 多标签页会重复刷新/);
  assert.match(injected, /待确认提议 1 条/);

  // 人确认提议后，memory.md 里带来源编号
  const task = svc.resolve(where).task;
  assert.ok(task);
  const pid = rec.data.proposal_id as string;
  assert.deepEqual(await svc.resolveProposal(task, pid, true), { status: "accepted", applied: 2 });
  const memory = readFileSync(join(task.dir, "memory.md"), "utf8");
  assert.match(memory, /- 不要改动 \/api\/v1 的返回格式 〔e_000002〕/);

  // agy 记录一轮
  clock = new Date("2026-11-24T11:20:00+08:00");
  await svc.recordProgress("agy", { summary: "接上了登录页错误提示", files: ["src/pages/login/index.tsx"], next: ["补集成测试"] }, where);

  // 回到 Claude：看到 agy 做了什么、memory 改了什么
  clock = new Date("2026-11-24T12:00:00+08:00");
  const back = svc.getContext("claude", {}, where);
  assert.equal(back.data.first_visit, false);
  assert.deepEqual(back.data.since, { events: 1, memory_changed: true, plan_changed: false });
  assert.match(back.text, /## 你离开后（1 条新记录）\n- 接上了登录页错误提示；改了 src\/pages\/login\/index.tsx 〔agy · 11-24 11:20〕/);
  assert.match(back.text, /memory.md：新增约束「不要改动 \/api\/v1 的返回格式」/);
  assert.match(back.text, /下一步：补集成测试 〔agy · 11-24 11:20〕/);
  // memory.md 里存的是来源编号，给 Agent 看时换成 Agent 和时间
  assert.match(back.text, /## 约束（必须遵守）\n- 不要改动 \/api\/v1 的返回格式 〔claude · 11-24 10:30〕/);
  assert.doesNotMatch(back.text, /〔e_\d+〕/);

  // 同一个 Agent 再次进入，没有新变化
  const again = svc.getContext("claude", {}, where);
  assert.doesNotMatch(again.text, /你离开后/);

  // 会话恢复且没有新变化：什么都不注入
  assert.equal(await svc.sessionStart(hook("claude", "session-start", project, { source: "resume" }), 9500), null);
  // 但从没进过这个任务的工具，恢复会话时也给完整的包
  const resumedNew = await svc.sessionStart(hook("codex", "session-start", project, { source: "resume" }), 9500);
  assert.match(resumedNew ?? "", /## 目标\n- 登录过期后自动刷新/);
  svc.close();
});

test("出处：blame 查得到写入者、确认人、提议人；手写的条目和只在事件里的内容也查得到", async () => {
  const { home, project } = setup();
  let clock = new Date("2026-11-24T10:00:00+08:00");
  const svc = Hotseat.open({ home, env: {}, now: () => clock });
  const where = { cwds: [project] };
  await svc.createTask("claude", { name: "Auth refresh" }, where);
  const task = svc.resolve(where).task;
  assert.ok(task);

  // Claude 记录的约束 → 自动提议 → 人确认
  clock = new Date("2026-11-24T10:30:00+08:00");
  const rec = await svc.recordProgress(
    "claude",
    { summary: "实现了 token 刷新", constraints: ["不要改动 /API/v1 的返回格式"], state: "登录页的错误提示还没接上" },
    where,
  );
  clock = new Date("2026-11-24T11:00:00+08:00");
  await svc.resolveProposal(task, rec.data.proposal_id as string, true);

  // agy 直接提议（没有来源事件）→ 人确认
  clock = new Date("2026-11-24T11:10:00+08:00");
  const prop = await svc.proposeMemoryEdit("agy", { edits: [{ op: "add", section: "notes", text: "刷新失败时跳转登录页" }], reason: "补充" }, where);
  clock = new Date("2026-11-24T11:20:00+08:00");
  await svc.resolveProposal(task, prop.data.proposal_id as string, true);

  // 人直接改 memory.md
  const memPath = join(task.dir, "memory.md");
  writeFileSync(memPath, readFileSync(memPath, "utf8").replace("## 约束\n", "## 约束\n- 只支持现代浏览器\n"));

  // 多个词都要出现，不分大小写；事件部分不重复 memory 已经说明过的内容
  const a = svc.blame({ query: "api/v1  返回" }, where);
  assert.equal(a.data.memory.length, 1);
  assert.equal(a.data.memory[0]?.source?.agent, "claude");
  assert.equal(a.data.memory[0]?.accepted?.agent, "human");
  assert.match(a.text, /memory\.md · 约束\n {2}不要改动 \/API\/v1 的返回格式\n/);
  assert.match(a.text, /写入 {2}claude · 11-24 10:30 · e_000002/);
  assert.match(a.text, /确认 {2}human · 11-24 11:00 · e_000003 · hotseat review 接受 p_0001/);
  assert.equal(a.data.events.length, 0);

  const b = svc.blame({ query: "跳转登录页" }, where);
  assert.equal(b.data.memory[0]?.source_id, null);
  assert.match(b.text, /提议 {2}agy · 11-24 11:10 · p_0002/);
  assert.match(b.text, /确认 {2}human · 11-24 11:20/);

  assert.match(svc.blame({ query: "现代浏览器" }, where).text, /没有来源标记/);

  const c = svc.blame({ query: "错误提示 还没" }, where);
  assert.equal(c.data.memory.length, 0);
  assert.equal(c.data.events[0]?.event.id, "e_000002");
  assert.match(c.text, /半截：登录页的错误提示还没接上/);

  const none = svc.blame({ query: "不存在的词" }, where);
  assert.equal(none.data.memory.length + none.data.events.length, 0);
  assert.match(none.text, /没有找到「不存在的词」/);
});

test("上下文包：超预算时从末尾压缩，目标和约束不截断", async () => {
  const { home, project } = setup();
  const svc = Hotseat.open({ home, env: {} });
  const where = { cwds: [project] };
  await svc.createTask("claude", { name: "Big", goal: "目标一句话" }, where);
  for (let i = 0; i < 8; i++) {
    await svc.recordProgress("codex", { summary: `第 ${i} 轮：${"很长的进度说明".repeat(20)}`, constraints: [`约束 ${i}`] }, where);
  }
  const small = svc.getContext("claude", { budget: 400 }, where);
  assert.ok(small.data.truncated.includes("recent"));
  assert.match(small.text, /目标一句话/);
  assert.match(small.text, /约束 7/);
  const research = svc.getContext("cursor", { scene: "research", budget: 8000 }, where);
  assert.deepEqual(research.data.truncated, []);
  svc.close();
});

test("上下文包：一次确认很多条 memory 和计划后，「你离开后」只给计数，关键决定不会被挤掉", async () => {
  const { home, project } = setup();
  let clock = new Date("2026-11-24T09:00:00+08:00");
  const svc = Hotseat.open({ home, env: {}, now: () => clock });
  const where = { cwds: [project] };
  await svc.createTask("claude", { name: "Big review", goal: "目标一句话" }, where);
  const task = svc.resolve(where).task;
  assert.ok(task);
  svc.getContext("claude", {}, where); // Claude 先来过一次，有已读位置

  clock = new Date("2026-11-24T09:30:00+08:00");
  const rec = await svc.recordProgress(
    "claude",
    {
      summary: "定下了一批约束和决定",
      constraints: Array.from({ length: 5 }, (_, i) => `约束 ${i}：${"要遵守的规则".repeat(6)}`),
      decisions: Array.from({ length: 6 }, (_, i) => ({ what: `决定 ${i}：${"选这个方案".repeat(6)}`, why: "理由".repeat(10), lasting: true })),
    },
    where,
  );
  const plan = await svc.proposePlan("claude", { subtasks: Array.from({ length: 8 }, (_, i) => ({ title: `子任务 ${i}：${"要做的事".repeat(5)}` })), mode: "replace" }, where);
  clock = new Date("2026-11-24T10:00:00+08:00");
  await svc.resolveProposal(task, rec.data.proposal_id as string, true);
  await svc.resolveProposal(task, plan.data.proposal_id, true);
  clock = new Date("2026-11-24T10:30:00+08:00");
  await svc.recordProgress("agy", { summary: "agy 接着做了一轮", next: ["继续"] }, where);

  const back = svc.getContext("claude", { budget: 1500 }, where);
  assert.match(back.text, /- memory\.md：新增决定 6 条、约束 5 条\n/);
  assert.match(back.text, /- plan\.md：新增 8 个子任务（T1、T2、T3、T4、T5、T6、T7、T8）/);
  assert.match(back.text, /agy 接着做了一轮 〔agy · 11-24 10:30〕/);
  assert.match(back.text, /## 关键决定\n- 决定 0：/);
  assert.ok(!back.data.truncated.includes("decisions"), `被截掉的：${back.data.truncated.join()}`);
  svc.close();
});

test("上下文包：「你离开后」的进度很长时先截短，关键决定整节保留", async () => {
  const { home, project } = setup();
  let clock = new Date("2026-11-24T09:00:00+08:00");
  const svc = Hotseat.open({ home, env: {}, now: () => clock });
  const where = { cwds: [project] };
  await svc.createTask("claude", { name: "Long notes", goal: "目标一句话" }, where);
  svc.getContext("agy", {}, where); // agy 先来过一次
  for (let i = 0; i < 6; i++) {
    clock = new Date(`2026-11-24T1${i}:00:00+08:00`);
    await svc.recordProgress(
      "claude",
      {
        summary: `第 ${i} 轮：${"很长的进度说明，写了很多细节".repeat(15)}`,
        decisions: [{ what: `决定 ${i}：${"选这个方案".repeat(8)}`, why: "理由".repeat(15) }],
        state: "做到一半的状态",
      },
      where,
    );
  }
  const back = svc.getContext("agy", { budget: 1500 }, where);
  assert.ok(back.data.estimated_tokens <= 1500, `估算 ${back.data.estimated_tokens}`);
  assert.match(back.text, /## 你离开后（6 条新记录）\n- 第 5 轮：很长的进度说明.*… 〔claude · 11-24 15:00〕/);
  assert.match(back.text, /另有 3 条，见 progress\.md/);
  assert.match(back.text, /## 关键决定\n(- 决定 \d：.*\n){5}- 决定 \d：/);
  assert.match(back.text, /半截：做到一半的状态/);
  svc.close();
});

test("上下文包：压缩后还放不下时，关键决定只留前几条并写明另有几条，不整节去掉", async () => {
  const { home, project } = setup();
  let clock = new Date("2026-11-24T09:00:00+08:00");
  const svc = Hotseat.open({ home, env: {}, now: () => clock });
  const where = { cwds: [project] };
  await svc.createTask("claude", { name: "Many decisions", goal: "目标一句话" }, where);
  // 15 条很长的决定，加上「你离开后」的 7 条长记录，压缩后也放不进 1000
  clock = new Date("2026-11-24T09:10:00+08:00");
  await svc.recordProgress(
    "claude",
    { summary: "定下很多决定", decisions: Array.from({ length: 15 }, (_, i) => ({ what: `决定 ${i}：${"选这个方案".repeat(12)}`, why: "理由".repeat(10) })) },
    where,
  );
  svc.getContext("agy", {}, where); // agy 先来过一次
  for (let i = 0; i < 7; i++) {
    clock = new Date(`2026-11-24T1${i}:00:00+08:00`);
    await svc.recordProgress("claude", { summary: `第 ${i} 轮：${"很长的进度说明，写了很多细节".repeat(15)}`, state: "做到一半的状态" }, where);
  }
  const back = svc.getContext("agy", { budget: 1000 }, where);
  assert.ok(back.data.estimated_tokens <= 1000, `估算 ${back.data.estimated_tokens}`);
  assert.ok(back.data.estimated_tokens > 850, `预算没用满：${back.data.estimated_tokens}`);
  const kept = /## 关键决定\n((?:- 决定 \d+：.*\n)+)- 另有 (\d+) 条，需要时用 search 查/.exec(back.text);
  assert.ok(kept, back.text);
  const shown = (kept[1] ?? "").trim().split("\n").length;
  assert.equal(shown + Number(kept[2]), 15);
  assert.ok(shown >= 3, `只留了 ${shown} 条`);
  // 默认预算（5000）下全部放得下
  svc.getContext("claude", {}, where);
  svc.close();
});

test("密钥在写入前就被替换", async () => {
  const { home, project } = setup();
  const svc = Hotseat.open({ home, env: {} });
  await svc.createTask("claude", { name: "Keys" }, { cwds: [project] });
  const r = await svc.recordProgress("claude", { summary: "配置了 sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123" }, { cwds: [project] });
  assert.match(r.data.warnings[0] ?? "", /anthropic-key/);
  const raw = readFileSync(join(home, "tasks", "keys", "events.jsonl"), "utf8");
  assert.doesNotMatch(raw, /sk-ant-api03/);
  svc.close();
});

test("找任务：最长路径优先；同一路径绑多个任务时看 switch_task", async () => {
  const { home, project } = setup();
  const svc = Hotseat.open({ home, env: {} });
  const sub = join(project, "packages", "api");
  mkdirSync(sub, { recursive: true });
  await svc.createTask("human", { name: "Whole repo", path: project }, { cwds: [] });
  await svc.createTask("human", { name: "API only", path: sub }, { cwds: [] });
  assert.equal(svc.resolve({ cwds: [join(sub)] }).task?.slug, "api-only");
  assert.equal(svc.resolve({ cwds: [project] }).task?.slug, "whole-repo");
  await svc.createTask("human", { name: "Second", path: project }, { cwds: [] });
  assert.equal(svc.resolve({ cwds: [project] }).task?.slug, "second");
  svc.switchTask({ slug: "whole-repo" }, { cwds: [project] });
  assert.equal(svc.resolve({ cwds: [project] }).task?.slug, "whole-repo");
  assert.throws(() => svc.switchTask({ slug: "api-only" }, { cwds: [project] }), { code: "NOT_BOUND" });
  svc.close();
});

test("检索：中文 3 字以上和 1–2 字都能搜到", async () => {
  const { home, project } = setup();
  const svc = Hotseat.open({ home, env: {} });
  await svc.createTask("claude", { name: "Search" }, { cwds: [project] });
  await svc.recordProgress("claude", { summary: "登录页的错误提示还没接上", constraints: ["不要改动返回格式"] }, { cwds: [project] });
  assert.equal(svc.search({ query: "错误提示" }, { cwds: [project] }).data.results[0]?.ref, "e_000002");
  assert.equal(svc.search({ query: "登录" }, { cwds: [project] }).data.results[0]?.ref, "e_000002");
  assert.equal(svc.search({ query: "返回格式", scope: "events" }, { cwds: [project] }).data.results.length, 1);
  svc.close();
});

test("读资料：不能读出任务目录", async () => {
  const { home, project, root } = setup();
  const svc = Hotseat.open({ home, env: {} });
  await svc.createTask("claude", { name: "Files" }, { cwds: [project] });
  const dir = join(home, "tasks", "files");
  writeFileSync(join(dir, "files", "spec.md"), "# 刷新接口说明\n\n正文");
  writeFileSync(join(root, "secret.txt"), "top secret");
  assert.match(svc.readTaskFile({ path: "files/spec.md" }, { cwds: [project] }).text, /刷新接口说明/);
  assert.throws(() => svc.readTaskFile({ path: "files/../../../secret.txt" }, { cwds: [project] }), { code: "PATH_OUTSIDE_TASK" });
  assert.throws(() => svc.readTaskFile({ path: "task.yaml" }, { cwds: [project] }), { code: "PATH_OUTSIDE_TASK" });
  const ctx = svc.getContext("claude", {}, { cwds: [project] });
  assert.match(ctx.text, /files\/spec.md — 刷新接口说明/);
  svc.close();
});

// ---------- 收工检查 ----------

function gitRepo(dir: string) {
  const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "hi\n");
  g("add", ".");
  g("commit", "-qm", "init");
}

test("收工检查：改了文件没记录就拦截一次，记录后或已继续过就放行", async () => {
  const { home, project } = setup();
  gitRepo(project);
  writeFileSync(join(project, "dirty-before.txt"), "已经存在的未提交改动\n");
  const svc = Hotseat.open({ home, env: {} });
  await svc.createTask("claude", { name: "Stop" }, { cwds: [project] });

  await svc.sessionStart(hook("claude", "session-start", project), 9500);
  // 没改文件：放行
  assert.deepEqual(await svc.stopCheck(hook("claude", "stop", project)), { action: "allow" });

  // 改了文件、没记录：拦截，提示里列出文件
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(project, "src.ts"), "export {}\n");
  const blocked = await svc.stopCheck(hook("claude", "stop", project));
  assert.equal(blocked.action, "block");
  assert.match(blocked.action === "block" ? blocked.message : "", /本轮改动了 1 个文件（src.ts）/);

  // Claude 已经继续过一次（stop_hook_active）：放行
  assert.deepEqual(await svc.stopCheck(hook("claude", "stop", project, { continued: true })), { action: "allow" });

  // 下一轮：改文件并记录 → 放行
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(project, "src.ts"), "export const a = 1\n");
  await svc.recordProgress("claude", { summary: "改了 src.ts" }, { cwds: [project] });
  assert.deepEqual(await svc.stopCheck(hook("claude", "stop", project)), { action: "allow" });

  // agy 不告诉我们是否继续过：用本地计数，拦截一次后第二次放行
  await svc.sessionStart(hook("agy", "session-start", project), 8000);
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(project, "agy.ts"), "x\n");
  const agy = hook("agy", "stop", project, { continued: null });
  assert.equal((await svc.stopCheck(agy)).action, "block");
  assert.equal((await svc.stopCheck(agy)).action, "allow");

  // 用户中断：不拦截
  writeFileSync(join(project, "agy2.ts"), "y\n");
  assert.deepEqual(await svc.stopCheck(hook("agy", "stop", project, { stopStatus: "aborted" })), { action: "allow" });
  svc.close();
});

test("收工检查：没有 Git 的目录按修改时间判断；可以按工具关闭", async () => {
  const { home, project } = setup();
  mkdirSync(join(home, ".hotseat"), { recursive: true });
  writeFileSync(join(home, ".hotseat", "config.json"), JSON.stringify({ v: 1, agents: { cursor: { enabled: true, stopCheck: false, installedAt: "2026-11-24T10:00:00+08:00", parts: ["hooks"] } } }));
  const svc = Hotseat.open({ home, env: {} });
  await svc.createTask("claude", { name: "NoGit" }, { cwds: [project] });
  await svc.sessionStart(hook("codex", "session-start", project), 9500);
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(project, "a.txt"), "a\n");
  assert.equal((await svc.stopCheck(hook("codex", "stop", project))).action, "block");
  await svc.sessionStart(hook("cursor", "session-start", project), 9500);
  writeFileSync(join(project, "b.txt"), "b\n");
  assert.equal((await svc.stopCheck(hook("cursor", "stop", project))).action, "allow");
  svc.close();
});
