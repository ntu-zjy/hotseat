// 用 docs/interfaces.md 里的示例校验契约，保证文档和代码一致。
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { z } from "zod";
import {
  Config,
  INDEX_DB_SCHEMA,
  PLAN_LINE_RE,
  PROVENANCE_RE,
  Proposal,
  SCENE_ORDER,
  TOOL_DESCRIPTIONS,
  TOOL_INPUTS,
  TOOL_NAMES,
  TOOL_OUTPUTS,
  TaskFile,
  clipLine,
  estimateTokens,
  formatEventId,
  formatProposalId,
  parseEventLine,
  redactSecrets,
  validateMemoryEditInput,
} from "./index.ts";

const DOC_EVENT =
  '{"v":1,"id":"e_000192","seq":192,"time":"2026-11-23T14:02:11+08:00","agent":"codex","session":"019a6f3e-7f3a","kind":"progress","subtask":"T3","summary":"实现了 token 刷新，单测通过","decisions":[{"what":"刷新放在拦截器里","why":"避免每个请求各自处理","lasting":true}],"rejected":[{"what":"定时器提前刷新","why":"多标签页会重复刷新","lasting":true}],"constraints":["不要改动 /api/v1 的返回格式"],"state":"登录页的错误提示还没接上","next":["接错误提示","补集成测试"],"files":["src/auth/interceptor.ts"]}';

test("文档里的 progress 事件示例能通过校验", () => {
  const ev = parseEventLine(DOC_EVENT);
  assert.ok(ev && ev !== "unknown");
  assert.equal(ev.kind, "progress");
  assert.equal(ev.id, formatEventId(ev.seq));
});

test("事件行：写到一半的行返回 null，新版本的 kind 返回 unknown", () => {
  assert.equal(parseEventLine(DOC_EVENT.slice(0, 40)), null);
  assert.equal(parseEventLine('{"v":1,"kind":"claimed","id":"e_000001"}'), "unknown");
  assert.equal(parseEventLine('{"v":1,"kind":"progress","id":"e_000001"}'), null); // 缺必填字段
});

test("事件里有不认识的字段时照常解析（只加字段、不删字段）", () => {
  const ev = parseEventLine(DOC_EVENT.replace('"v":1,', '"v":1,"future_field":42,'));
  assert.ok(ev && ev !== "unknown");
  assert.equal(ev.id, "e_000192");
});

test("文档里的提议示例能通过校验；按 op 校验必填字段", () => {
  const p = Proposal.parse({
    v: 1,
    id: "p_0012",
    kind: "memory",
    status: "pending",
    created: "2026-11-23T14:02:11+08:00",
    agent: "codex",
    session: null,
    source_event: "e_000192",
    reason: "来自 e_000192 的约束和长期决定",
    base_memory_hash: "sha256:9f2c",
    edits: [
      { op: "add", section: "constraints", text: "不要改动 /api/v1 的返回格式" },
      { op: "replace", section: "decisions", old: "刷新放在页面里", text: "刷新放在拦截器里 —— 避免每个请求各自处理" },
    ],
  });
  assert.equal(p.id, formatProposalId(12));
  assert.throws(() =>
    Proposal.parse({ ...p, edits: [{ op: "add", section: "constraints" }] }),
  );
  assert.equal(validateMemoryEditInput({ op: "replace", section: "goal", text: "x" }), "replace 需要 old 和 text");
  assert.equal(validateMemoryEditInput({ op: "add", section: "goal", text: "x" }), null);
});

test("config.json 和 task.yaml 的示例能通过校验，缺省值生效", () => {
  const c = Config.parse({
    v: 1,
    agents: {
      claude: { enabled: true, installedAt: "2026-11-24T10:00:00+08:00", parts: ["mcp", "rules", "hooks"] },
    },
  });
  assert.equal(c.lang, "zh");
  assert.equal(c.pack.defaultBudget, 5000);
  assert.equal(c.agents.claude?.stopCheck, true);
  assert.throws(() => Config.parse({ v: 1, agents: { claude: {} } }));
  // 新版写进来的工具，旧版也要能读（升级时还开着的会话用的是旧版 MCP 服务）
  const future = Config.parse({ v: 1, agents: { "future-tool": { enabled: true, installedAt: "2026-11-24T10:00:00+08:00", parts: ["mcp"] } } });
  assert.equal(future.agents["future-tool"]?.enabled, true);

  TaskFile.parse({
    v: 1,
    slug: "auth-refresh",
    name: "登录态刷新",
    status: "active",
    created: "2026-11-23T10:00:00+08:00",
    paths: ["/Users/me/code/webapp"],
  });
  assert.throws(() =>
    TaskFile.parse({ v: 1, slug: "Auth", name: "x", status: "active", created: "2026-11-23T10:00:00+08:00", paths: [] }),
  );
  assert.throws(() =>
    TaskFile.parse({ v: 1, slug: "ab", name: "x", status: "active", created: "2026-11-23T10:00:00+08:00", paths: ["rel/dir"] }),
  );
});

test("plan.md 行语法能解析文档示例", () => {
  const m = PLAN_LINE_RE.exec("- [~] T3 实现 token 刷新 · deps: T2 · files: src/auth/** · 验收: 过期后自动刷新且单测通过");
  assert.ok(m);
  assert.equal(m[1], "~");
  assert.equal(m[2], "T3");
  assert.ok(m[3]?.startsWith("实现 token 刷新"));
  assert.equal(PLAN_LINE_RE.exec("- [?] T3 x"), null);
  assert.equal(PROVENANCE_RE.exec("- 不要改动 /api/v1 的返回格式 〔e_000192〕")?.[1], "e_000192");
});

test("index.db 的建表语句能执行；trigram 中文检索：3 字以上用 MATCH，1–2 字要用 LIKE", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(INDEX_DB_SCHEMA);
  const ins = db.prepare("INSERT INTO docs (task, kind, ref, time, agent, text) VALUES (?, ?, ?, ?, ?, ?)");
  ins.run("auth-refresh", "event", "e_000192", "2026-11-23T14:02:11+08:00", "codex", "登录页的错误提示还没接上");
  const match = db.prepare("SELECT ref FROM docs WHERE docs MATCH ?");
  assert.equal(match.all("错误提示").length, 1);
  assert.equal(match.all("登录").length, 0);
  assert.equal(db.prepare("SELECT ref FROM docs WHERE text LIKE ?").all("%登录%").length, 1);
  db.close();
});

test("密钥检测：常见密钥被替换，正常的中文进度不受影响", () => {
  const { text, hits } = redactSecrets(
    "配置了 sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 和 AKIAABCDEFGHIJKLMNOP，password=hunter2hunter2",
  );
  assert.deepEqual(hits, ["anthropic-key", "aws-access-key", "assignment"]);
  assert.ok(!text.includes("sk-ant-api03"));
  assert.ok(text.includes("[REDACTED:aws-access-key]"));
  assert.deepEqual(redactSecrets("实现了 token 刷新，单测通过").hits, []);
});

test("token 估算：中文每字约 1，英文每 4 个字符约 1", () => {
  assert.equal(estimateTokens("登录态刷新"), 5);
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens("改 api"), 2);
});

test("截短一行：超出才截，加「…」，末尾的出处标记保留", () => {
  assert.equal(clipLine("- 短句 〔claude · 11-24 09:42〕", 50), "- 短句 〔claude · 11-24 09:42〕");
  const long = `- ${"很长的进度说明".repeat(20)} 〔agy · 11-24 12:23〕`;
  const clipped = clipLine(long, 20);
  assert.match(clipped, /^- 很长的进度说明.*… 〔agy · 11-24 12:23〕$/);
  assert.ok(estimateTokens(clipped.replace(/ 〔.*〕$/, "")) <= 21);
  assert.equal(clipLine("x".repeat(400), 10), `${"x".repeat(40)}…`);
});

test("每个场景的排序都不重复，且不包含固定部分", () => {
  for (const [scene, order] of Object.entries(SCENE_ORDER)) {
    assert.equal(new Set(order).size, order.length, scene);
    assert.ok(!order.includes("goal") && !order.includes("constraints"), scene);
  }
});

test("每个工具都有输入、输出和双语描述", () => {
  for (const name of TOOL_NAMES) {
    assert.ok(TOOL_INPUTS[name], name);
    assert.ok(TOOL_OUTPUTS[name], name);
    assert.match(TOOL_DESCRIPTIONS[name], /[一-鿿]/, `${name} 缺中文描述`);
    assert.match(TOOL_DESCRIPTIONS[name], /^[A-Z]/, `${name} 应以英文开头`);
  }
});

test("工具输入的 JSON Schema 里没有 anyOf / oneOf（兼容 Gemini 等模型）", () => {
  for (const name of TOOL_NAMES) {
    const schema = JSON.stringify(z.toJSONSchema(z.object(TOOL_INPUTS[name])));
    assert.ok(!/"(anyOf|oneOf)"/.test(schema), `${name} 的输入里出现了 anyOf/oneOf`);
  }
});

test("文档里的工具调用示例能通过输入校验", () => {
  z.object(TOOL_INPUTS.record_progress).parse({
    summary: "实现了 token 刷新，单测通过",
    decisions: [{ what: "刷新放在拦截器里", why: "避免每个请求各自处理", lasting: true }],
    constraints: ["不要改动 /api/v1 的返回格式"],
    subtask: "T3",
    subtask_status: "done",
  });
  z.object(TOOL_INPUTS.get_context).parse({ scene: "research", budget: 3000, cwd: "/Users/me/code/webapp" });
  assert.throws(() => z.object(TOOL_INPUTS.get_context).parse({ budget: 100 }));
  assert.throws(() => z.object(TOOL_INPUTS.record_progress).parse({ summary: "" }));
});
