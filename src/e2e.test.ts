// 端到端：用打包后的 dist/hotseat.mjs，在临时的用户目录里跑 init → MCP → Hook → uninstall。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOL_NAMES, type ToolName } from "./contracts/tools.ts";

const BUNDLE = resolve(import.meta.dirname, "../dist/hotseat.mjs");

function sandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "hotseat-home-")));
  const project = join(home, "code", "webapp");
  mkdirSync(project, { recursive: true });
  const env = { ...process.env, HOME: home, HOTSEAT_HOME: join(home, "Hotseat"), LANG: "zh_CN.UTF-8" };
  // 这些变量会让适配器去改真实的配置目录，测试里一律去掉
  for (const k of ["CLAUDE_PROJECT_DIR", "HOTSEAT_TASK", "CODEX_HOME", "QODERCN_CONFIG_DIR", "CURSOR_PROJECT_DIR"]) delete (env as Record<string, string | undefined>)[k];
  return { home, project, env };
}

function cli(env: NodeJS.ProcessEnv, args: string[], opts: { cwd?: string; input?: string } = {}) {
  const r = spawnSync(process.execPath, ["--no-warnings", BUNDLE, ...args], { env, cwd: opts.cwd, input: opts.input ?? "", encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** 用 shell 执行配置文件里写的那条命令，和各工具的做法一样。 */
function sh(env: NodeJS.ProcessEnv, command: string, input: unknown, cwd: string) {
  return execFileSync("/bin/sh", ["-c", command], { env, cwd, input: JSON.stringify(input), encoding: "utf8" });
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

test("init → doctor → 再次 init 无改动 → uninstall 还原原有配置", () => {
  const { home, env } = sandbox();
  // 用户已有的配置：其他 MCP 服务、CC-Switch 写的 env、别的 Hook
  const claudeJson = { numStartups: 3, mcpServers: { other: { type: "stdio", command: "other-mcp" } }, projects: {} };
  const settings = { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15721" }, hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } };
  const agyMcp = { mcpServers: { "minimax-design": { url: "https://example.com/mcp" } } };
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify(claudeJson, null, 2));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings, null, 2));
  writeFileSync(join(home, ".gemini", "config", "mcp_config.json"), JSON.stringify(agyMcp, null, 2));

  const dry = cli(env, ["init", "--dry-run"]);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /\[claude\] ~\/\.claude\/settings\.json/);
  assert.match(dry.out, /\[agy\] ~\/\.gemini\/config\/hooks\.json/);
  assert.equal(existsSync(join(home, "Hotseat", ".hotseat", "bin", "hotseat")), false);

  assert.equal(cli(env, ["init"]).code, 1); // 非交互且没有 --yes：不写入
  const r = cli(env, ["init", "--yes"]);
  assert.equal(r.code, 0, r.out + r.err);
  const bin = join(home, "Hotseat", ".hotseat", "bin", "hotseat");
  assert.ok(existsSync(bin));

  const cj = readJson(join(home, ".claude.json"));
  assert.equal(cj.numStartups, 3);
  assert.deepEqual(cj.mcpServers.other, claudeJson.mcpServers.other);
  assert.deepEqual(cj.mcpServers.hotseat, { type: "stdio", command: bin, args: ["mcp"], env: { HOTSEAT_AGENT: "claude" } });
  const st = readJson(join(home, ".claude", "settings.json"));
  assert.deepEqual(st.env, settings.env);
  assert.equal(st.hooks.Stop.length, 2);
  assert.match(st.hooks.SessionStart[0].hooks[0].command, /hotseat hook claude session-start$/);
  assert.match(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8"), /<!-- hotseat:begin -->[\s\S]*Hotseat 共享上下文/);
  const agyHooks = readJson(join(home, ".gemini", "config", "hooks.json"));
  // agy 的 SessionStart / Stop 是扁平列表，不套 hooks
  assert.match(agyHooks.hotseat.SessionStart[0].command, /hotseat hook agy session-start$/);
  assert.match(agyHooks.hotseat.Stop[0].command, /hotseat hook agy stop$/);
  assert.equal(readJson(join(home, ".gemini", "config", "mcp_config.json")).mcpServers.hotseat.env.HOTSEAT_AGENT, "agy");
  assert.ok(existsSync(join(home, ".gemini", "config", "rules", "hotseat.md")));
  const configFile = join(home, "Hotseat", ".hotseat", "config.json");
  assert.deepEqual(Object.keys(readJson(configFile).agents).sort(), ["agy", "claude"]);
  assert.equal(readJson(configFile).pack, undefined); // 缺省值不写进文件，以后改缺省值老用户也能用上

  const doc = cli(env, ["doctor"]);
  assert.equal(doc.code, 0, doc.out);
  assert.doesNotMatch(doc.out, /✗/);

  writeFileSync(configFile, JSON.stringify({ ...readJson(configFile), pack: { defaultBudget: 3000 } }, null, 2));
  const again = cli(env, ["init", "--yes"]);
  assert.deepEqual(readJson(configFile).pack, { defaultBudget: 3000 }); // 用户自己设的值原样保留
  assert.match(again.out, /已经是最新的/);
  assert.match(again.out, /程序已更新到 .+，各工具的配置没有改动/); // 升级：不再打印首次安装的「下一步」
  assert.doesNotMatch(again.out, /下一步/);
  assert.equal(readJson(join(home, ".claude", "settings.json")).hooks.Stop.length, 2);

  // 模拟 CC-Switch 把 settings.json 整份覆盖：doctor 能发现
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings, null, 2));
  const broken = cli(env, ["doctor"]);
  assert.equal(broken.code, 1);
  assert.match(broken.out, /没有 SessionStart Hook（可能被 CC-Switch 等工具覆盖）/);
  cli(env, ["init", "--yes", "--only", "claude"]);

  const un = cli(env, ["uninstall", "--yes"]);
  assert.equal(un.code, 0, un.out + un.err);
  // 逐字节还原（原文件末尾没有换行，也要保持）
  assert.equal(readFileSync(join(home, ".claude.json"), "utf8"), JSON.stringify(claudeJson, null, 2));
  assert.equal(readFileSync(join(home, ".claude", "settings.json"), "utf8"), JSON.stringify(settings, null, 2));
  assert.equal(readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8"), JSON.stringify(agyMcp, null, 2));
  assert.equal(existsSync(join(home, ".claude", "CLAUDE.md")), false);
  assert.equal(existsSync(join(home, ".gemini", "config", "hooks.json")), false);
  assert.equal(existsSync(join(home, ".gemini", "config", "rules", "hotseat.md")), false);
  assert.ok(existsSync(join(home, "Hotseat", ".hotseat", "backups")));
});

test("Codex、Cursor、Qoder CN：init 写入、Hook 按各自格式输出、uninstall 逐字节还原", () => {
  const { home, project, env } = sandbox();
  const codexToml = 'model = "gpt-5"\n\n[mcp_servers.playwright]\ncommand = "npx"\nargs = ["@playwright/mcp"]\n';
  const cursorMcp = JSON.stringify({ mcpServers: { "server-sequential-thinking": { command: "npx", args: ["x"] } } }, null, 2);
  const qoderSettings = `${JSON.stringify({ enabledPlugins: { "qoder-context@qoderapp-bundler": true } }, null, 2)}\n`;
  for (const d of [".codex", ".cursor", ".qoder-cn"]) mkdirSync(join(home, d));
  writeFileSync(join(home, ".codex", "config.toml"), codexToml);
  writeFileSync(join(home, ".cursor", "mcp.json"), cursorMcp);
  writeFileSync(join(home, ".qoder-cn", "settings.json"), qoderSettings);

  const r = cli(env, ["init", "--yes"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Claude Code：没有检测到，跳过/);
  assert.match(r.out, /Codex：已检测到（实验性）/);
  assert.match(r.out, /重启Codex、Cursor、Qoder CN/);
  assert.match(r.out, /在 Codex 里输入 \/hooks/);
  const bin = join(home, "Hotseat", ".hotseat", "bin", "hotseat");

  // Codex：config.toml 末尾追加一张表，其他内容不动
  const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.ok(toml.startsWith(codexToml));
  assert.ok(toml.endsWith(`[mcp_servers.hotseat]\ncommand = "${bin}"\nargs = ["mcp"]\nenv = { HOTSEAT_AGENT = "codex" }\n`));
  const codexHooks = readJson(join(home, ".codex", "hooks.json")).hooks;
  assert.equal(codexHooks.SessionStart[0].hooks[0].additionalContextLimit, 10000);
  assert.match(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8"), /Hotseat 共享上下文/);
  // Cursor：hooks.json 带 version 1，stop 最多自动追问一次
  const cursorHooks = readJson(join(home, ".cursor", "hooks.json"));
  assert.equal(cursorHooks.version, 1);
  assert.equal(cursorHooks.hooks.stop[0].loop_limit, 1);
  assert.deepEqual(readJson(join(home, ".cursor", "mcp.json")).mcpServers.hotseat, { command: bin, args: ["mcp"], env: { HOTSEAT_AGENT: "cursor" } });
  // Qoder CN：MCP 和 Hook 都在 settings.json，原有设置保留
  const qoder = readJson(join(home, ".qoder-cn", "settings.json"));
  assert.equal(qoder.enabledPlugins["qoder-context@qoderapp-bundler"], true);
  assert.equal(qoder.mcpServers.hotseat.env.HOTSEAT_AGENT, "qoder-cn");
  assert.match(readFileSync(join(home, ".qoder-cn", "AGENTS.md"), "utf8"), /Hotseat 共享上下文/);

  const doc = cli(env, ["doctor"]);
  assert.equal(doc.code, 0, doc.out);
  assert.doesNotMatch(doc.out, /✗/);
  const rules = cli(env, ["rules"]);
  assert.match(rules.out, /^## Hotseat 共享上下文/);
  assert.doesNotMatch(rules.out, /hotseat:begin/);

  // 各工具的 Hook 输出
  execFileSync("git", ["init", "-q", project]);
  assert.equal(cli(env, ["new", "Login refresh", "--goal", "登录过期后自动刷新"], { cwd: project }).code, 0);
  const codexOut = sh(env, codexHooks.SessionStart[0].hooks[0].command, { session_id: "x1", cwd: project, hook_event_name: "SessionStart", source: "startup" }, project);
  assert.match(codexOut, /^# Hotseat 交接 · Login refresh（login-refresh）\n> 你是 codex。/); // Codex 用纯文本
  const qoderOut = JSON.parse(sh(env, qoder.hooks.SessionStart[0].hooks[0].command, { session_id: "q1", cwd: project, hook_event_name: "SessionStart", source: "startup" }, project));
  assert.match(qoderOut.hookSpecificOutput.additionalContext, /你是 qoder-cn。/);
  const cursorOut = JSON.parse(sh(env, cursorHooks.hooks.sessionStart[0].command, { session_id: "c1", conversation_id: "c1", workspace_roots: [project], hook_event_name: "sessionStart" }, project));
  assert.match(cursorOut.additional_context, /你是 cursor。/);
  writeFileSync(join(project, "login.tsx"), "export {}\n");
  const cursorStop = JSON.parse(sh(env, cursorHooks.hooks.stop[0].command, { conversation_id: "c1", generation_id: "g1", status: "completed", loop_count: 0, workspace_roots: [project], hook_event_name: "stop" }, project));
  assert.match(cursorStop.followup_message, /login\.tsx/);
  const again = JSON.parse(sh(env, cursorHooks.hooks.stop[0].command, { conversation_id: "c1", generation_id: "g1", status: "completed", loop_count: 1, workspace_roots: [project], hook_event_name: "stop" }, project));
  assert.deepEqual(again, {}); // 已经追问过一次：放行

  const un = cli(env, ["uninstall", "--yes"]);
  assert.equal(un.code, 0, un.out + un.err);
  assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf8"), codexToml);
  assert.equal(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"), cursorMcp);
  assert.equal(readFileSync(join(home, ".qoder-cn", "settings.json"), "utf8"), qoderSettings);
  for (const f of [".codex/hooks.json", ".codex/AGENTS.md", ".cursor/hooks.json", ".qoder-cn/AGENTS.md"]) assert.equal(existsSync(join(home, f)), false, f);
});

async function mcpClient(env: NodeJS.ProcessEnv, agent: string, cwd: string) {
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--no-warnings", BUNDLE, "mcp"], env: { ...(env as Record<string, string>), HOTSEAT_AGENT: agent }, cwd, stderr: "pipe" }));
  return client;
}

type CallResult = { content: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean };

/** 只返回文本：Claude Code 有 structuredContent 时只给模型看结构化内容（见 src/mcp/server.ts）。 */
async function call(client: Client, name: ToolName, args: Record<string, unknown>): Promise<CallResult> {
  const r = (await client.callTool({ name, arguments: args })) as CallResult;
  assert.equal(r.structuredContent, undefined, `${name} 不应返回 structuredContent`);
  return r;
}

test("MCP + Hook：Claude 干活 → 收工检查拦截 → 记录 → agy 新会话自动拿到上下文", async () => {
  const { home, project, env } = sandbox();
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  assert.equal(cli(env, ["init", "--yes"]).code, 0);
  execFileSync("git", ["init", "-q", project]);

  const claude = await mcpClient(env, "claude", project);
  const tools = await claude.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  for (const t of tools.tools) assert.doesNotMatch(JSON.stringify(t.inputSchema), /"(anyOf|oneOf)"/, t.name);

  // 没绑定任务：不报错
  const none = await call(claude, "get_context", { cwd: project });
  assert.equal(none.isError, undefined);
  assert.match(none.content[0]?.text ?? "", /没有绑定 Hotseat 任务，照常工作/);
  const noRecord = await call(claude, "record_progress", { summary: "x", cwd: project });
  assert.equal(noRecord.isError, true);
  assert.match(noRecord.content[0]?.text ?? "", /^NO_TASK/);

  await call(claude, "create_task", { name: "Login refresh", goal: "登录过期后自动刷新", cwd: project });
  const settings = readJson(join(home, ".claude", "settings.json"));
  const start = settings.hooks.SessionStart[0].hooks[0].command as string;
  const stop = settings.hooks.Stop[0].hooks[0].command as string;

  // Claude 新会话：Hook 注入上下文（这里用 shell 执行 settings.json 里的原样命令）
  const injected = JSON.parse(sh(env, start, { session_id: "c1", cwd: project, hook_event_name: "SessionStart", source: "startup" }, project));
  assert.match(injected.hookSpecificOutput.additionalContext, /# Hotseat 交接 · Login refresh/);

  // 改了文件但没记录：拦截
  await new Promise((r) => setTimeout(r, 30));
  writeFileSync(join(project, "interceptor.ts"), "export {}\n");
  const blocked = JSON.parse(sh(env, stop, { session_id: "c1", cwd: project, hook_event_name: "Stop", stop_hook_active: false }, project));
  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /interceptor\.ts/);

  // Claude 按提示记录后再结束：放行
  const rec = await call(claude, "record_progress", {
    cwd: project,
    summary: "实现了 token 刷新拦截器",
    constraints: ["不要改动 /api/v1 的返回格式"],
    state: "错误提示还没接",
    next: ["接错误提示"],
    files: ["interceptor.ts"],
  });
  assert.match(rec.content[0]?.text ?? "", /已记录 e_000002/);
  assert.equal(sh(env, stop, { session_id: "c1", cwd: project, hook_event_name: "Stop", stop_hook_active: true }, project), "");
  await claude.close();

  // 切到 agy：新会话开始时自动注入，不需要任何交接的话
  const agyHooks = readJson(join(home, ".gemini", "config", "hooks.json")).hotseat;
  const agyStart = agyHooks.SessionStart[0].command as string;
  const agyOut = JSON.parse(sh(env, agyStart, { conversationId: "a1", workspacePaths: [project], modelName: "gemini" }, project));
  const ctx = agyOut.injectSteps[0].systemMessage.systemMessage as string;
  assert.match(ctx, /你是 agy。上次记录：claude/);
  assert.match(ctx, /不要改动 \/api\/v1 的返回格式/);
  assert.match(ctx, /半截：错误提示还没接/);
  assert.match(ctx, /待确认提议 1 条/);

  // agy 用 MCP 记录，然后回到 Claude：看到增量
  const agy = await mcpClient(env, "agy", project);
  await call(agy, "record_progress", { cwd: project, summary: "接上了错误提示", files: ["login.tsx"] });
  const agyStop = agyHooks.Stop[0].command as string;
  assert.deepEqual(JSON.parse(sh(env, agyStop, { conversationId: "a1", workspacePaths: [project], executionNum: 1 }, project)), { decision: "stop" });
  await agy.close();

  const claude2 = await mcpClient(env, "claude", project);
  const back = await call(claude2, "get_context", { cwd: project });
  assert.match(back.content[0]?.text ?? "", /你离开后（1 条新记录）\n- 接上了错误提示；改了 login\.tsx 〔agy/);
  const found = await call(claude2, "search", { cwd: project, query: "错误提示" });
  assert.ok((found.content[0]?.text ?? "").split("\n").length >= 2);
  await claude2.close();

  // review 在非交互终端里只列出提议
  const rv = cli(env, ["review"], { cwd: project });
  assert.match(rv.out, /\+ \[约束\] 不要改动 \/api\/v1 的返回格式/);

  // blame：找到时退出码 0，找不到时 1
  const bl = cli(env, ["blame", "错误提示"], { cwd: project });
  assert.equal(bl.code, 0);
  assert.match(bl.out, /agy · \d\d-\d\d \d\d:\d\d · e_\d+/);
  assert.equal(cli(env, ["blame", "不存在的词"], { cwd: project }).code, 1);
});

test("Hook 出错时放行：坏输入、未知工具、数据目录不可写", () => {
  const { env, project } = sandbox();
  assert.equal(cli(env, ["hook", "claude", "stop"], { input: "{not json" }).out, "");
  assert.equal(cli(env, ["hook", "agy", "stop"], { input: "{not json" }).out, '{"decision":"stop"}');
  assert.equal(cli(env, ["hook", "nobody", "stop"]).code, 0);
  const ro = { ...env, HOTSEAT_HOME: "/dev/null/hotseat" };
  const r = cli(ro, ["hook", "cursor", "session-start"], { input: JSON.stringify({ workspace_roots: [project] }), cwd: project });
  assert.equal(r.code, 0);
  assert.equal(r.out, "{}");
});
