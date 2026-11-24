// 命令行入口：hotseat <命令>。
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { PlannedChange } from "../contracts/adapter.ts";
import type { InstallPart } from "../contracts/common.ts";
import { HotseatError } from "../contracts/errors.ts";
import { Scene } from "../contracts/common.ts";
import { applyMemoryEdits } from "../core/memory.ts";
import { Hotseat } from "../core/service.ts";
import type { Task } from "../core/store.ts";
import { ensureDir, hotseatHome, readTextOrNull, shortTime, taskPath, tasksRoot, type Env } from "../core/util.ts";
import { runHook } from "../hooks/handler.ts";
import { adapterFor } from "../adapters/registry.ts";
import { rulesText } from "../adapters/shared.ts";
import { startMcpServer } from "../mcp/server.ts";
import { VERSION } from "../version.ts";
import {
  adapterContext,
  applyChanges,
  backupDir,
  defaultLang,
  installProgram,
  loadConfig,
  pickAdapters,
  recordInstall,
  recordUninstall,
  runtimeChecks,
} from "./install.ts";

const HELP = `Hotseat ${VERSION} — 多个 AI Agent 轮流接手同一个任务，上下文不丢。

用法：hotseat <命令> [参数]

接入
  init [--only claude,agy] [--dry-run] [--yes] [--no-hooks] [--lang zh|en]
                         检测本机的 AI 工具，写入 MCP、规则和 Hook（会先展示改动并备份）
                         支持：claude、agy、codex、cursor、qoder-cn、qoder、workbuddy、codebuddy、kimi、
                         lingma、trae、trae-cn、gemini、copilot、windsurf、kiro、opencode
  doctor                 检查各工具的接入是否还在
  uninstall [--yes]      按标记移除 Hotseat 写入的所有配置（任务数据保留）
  rules                  打印规则片段，给只能在设置里填规则的工具（Cursor、Trae、通义灵码）手动粘贴

任务
  new <名称> [--path <目录>] [--goal <目标>]   新建任务，默认绑定当前目录
  link <目录> [--task <slug>]                 把目录绑定到任务
  list [--all]                                列出任务
  context [--scene code|research|review|plan] 查看当前目录的上下文包
  review [--task <slug>]                      逐条确认 Agent 提交的 memory 和计划修改
  blame <关键词> [--task <slug>] [--all]       查某条决定、约束是哪个 Agent、什么时候写的

设置
  按工具关闭收工检查：把 ~/Hotseat/.hotseat/config.json 里 agents.<工具>.stopCheck 改成 false

内部（由各工具调用）
  mcp                    启动 MCP 服务（stdio）
  hook <agent> <event>   处理 Hook：event 为 session-start、prompt 或 stop
`;

interface Parsed {
  _: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      const next = argv[i + 1];
      if (v !== undefined) out.flags[k] = v;
      else if (next !== undefined && !next.startsWith("--") && !["yes", "dry-run", "all", "no-hooks", "help", "version"].includes(k)) {
        out.flags[k] = next;
        i++;
      } else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const tty = process.stdout.isTTY;
const color = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = color(32);
const red = color(31);
const dim = color(2);
const bold = color(1);
const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

async function confirm(flags: Parsed["flags"], question: string): Promise<boolean> {
  if (flags.yes) return true;
  if (!process.stdin.isTTY) {
    console.error("当前不是交互式终端。确认无误后加 --yes 再运行。");
    return false;
  }
  return ["y", "yes", "是"].includes(await ask(`${question} (y/N) `));
}

function readStdin(limit: number, timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = () => {
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.pause();
      done(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", onData);
    process.stdin.once("end", finish);
    process.stdin.once("error", finish);
  });
}

/** 打包后的单文件；直接跑源码时用 dist/ 下的打包结果。 */
function bundlePath(): string {
  const self = fileURLToPath(import.meta.url);
  if (self.endsWith(".mjs")) return self;
  const dist = resolve(dirname(self), "../../dist/hotseat.mjs");
  if (!existsSync(dist)) throw new Error("没有找到 dist/hotseat.mjs，请先运行 npm run build");
  return dist;
}

function printChanges(changes: readonly PlannedChange[]): void {
  for (const c of changes) {
    console.log(`\n${bold(`[${c.agent}]`)} ${tilde(c.file)} ${dim(`— ${c.summary}`)}`);
    if (c.preview) for (const line of c.preview.split("\n")) console.log(green(`  + ${line}`));
    if (c.after === null) console.log(red("  （删除这个文件）"));
  }
}

function cwdOrNull(): string | null {
  const cwd = process.cwd();
  return cwd === "/" || cwd === homedir() ? null : cwd;
}

// ---------- 命令 ----------

const INIT_TEXT = {
  zh: {
    installAt: (bin: string) => `程序将固定安装到 ${bin}，各工具的配置都指向这个路径。\n`,
    notDetected: (name: string) => `- ${name}：没有检测到，跳过`,
    detected: (name: string, exp: boolean) => `- ${name}：已检测到${exp ? "（实验性）" : ""}`,
    notes: (n: string[]) => `，${n.join("；")}`,
    noneDetected: (names: string[]) => `\n没有检测到支持的工具。目前支持：${names.join("、")}。`,
    upToDate: "\n各工具的配置已经是最新的，不需要修改。",
    filesToChange: "\n将要修改的文件（只显示 Hotseat 写入的部分，其他内容保持不变）：",
    dryRun: "\n--dry-run：只展示，不写入。",
    confirm: "\n确认写入？修改前会自动备份。",
    cancelled: "已取消，没有改动任何文件。",
    skipped: (f: string) => `✗ ${f} 在确认期间被其他程序改动，已跳过。请重新运行 hotseat init。`,
    updated: (v: string) => `\n✓ 程序已更新到 ${v}，各工具的配置没有改动。`,
    updatedNote: "新开的 Agent 会话会用上新版；正在运行的会话要重开后才会用上新的 MCP 服务。",
    wrote: (n: number, b: string) => `\n✓ 已写入 ${n} 个文件${n ? `，备份在 ${b}` : ""}`,
    restart: (names: string[]) => `重启${names.join("、")}，让新配置生效。`,
    newTaskCmd: 'hotseat new "任务名"',
    newTask: (cmd: string) => `在项目目录运行 ${cmd}，或者直接让 Agent 帮你建任务。`,
    review: (cmd: string) => `之后在这个目录里开新会话，Agent 会自动拿到上下文；Agent 提交的 memory 修改用 ${cmd} 确认。`,
    nextSteps: "\n下一步：\n",
  },
  en: {
    installAt: (bin: string) => `The program is installed at ${bin}; every tool's config points there.\n`,
    notDetected: (name: string) => `- ${name}: not detected, skipped`,
    detected: (name: string, exp: boolean) => `- ${name}: detected${exp ? " (experimental)" : ""}`,
    notes: (n: string[]) => `, ${n.join("; ")}`,
    noneDetected: (names: string[]) => `\nNo supported tools detected. Supported: ${names.join(", ")}.`,
    upToDate: "\nEvery tool is already up to date.",
    filesToChange: "\nFiles to change (only Hotseat's parts are shown; everything else stays as is):",
    dryRun: "\n--dry-run: nothing written.",
    confirm: "\nWrite these changes? Backups are made first.",
    cancelled: "Cancelled. No files were changed.",
    skipped: (f: string) => `✗ ${f} changed while you were confirming, so it was skipped. Run hotseat init again.`,
    updated: (v: string) => `\n✓ Updated to ${v}; no tool configs changed.`,
    updatedNote: "New agent sessions use the new version; restart running sessions to pick up the new MCP server.",
    wrote: (n: number, b: string) => `\n✓ Wrote ${n} files${n ? `, backups in ${b}` : ""}`,
    restart: (names: string[]) => `Restart ${names.join(", ")} so the new config takes effect.`,
    newTaskCmd: 'hotseat new "task name"',
    newTask: (cmd: string) => `In your project folder run ${cmd}, or just ask the agent to create a task.`,
    review: (cmd: string) => `New sessions in that folder then get the context automatically; confirm memory edits from agents with ${cmd}.`,
    nextSteps: "\nNext steps:\n",
  },
} as const;

async function init(p: Parsed, env: Env): Promise<number> {
  const hs = hotseatHome(env);
  const configExists = existsSync(join(hs, ".hotseat", "config.json"));
  const lang = str(p.flags.lang) === "en" ? "en" : str(p.flags.lang) === "zh" ? "zh" : configExists ? loadConfig(hs).lang : defaultLang(env);
  const ctx = adapterContext(env, lang);
  const only = str(p.flags.only)?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
  const parts: InstallPart[] = p.flags["no-hooks"] ? ["mcp", "rules"] : ["mcp", "rules", "hooks"];

  // init 的提示语按语言输出（--lang、config.json 里的 lang，或系统语言）
  const M = INIT_TEXT[lang];
  console.log(bold(`Hotseat ${VERSION}`));
  console.log(M.installAt(tilde(ctx.bin)));
  const changes: PlannedChange[] = [];
  const targets: { agent: PlannedChange["agent"]; parts: InstallPart[] }[] = [];
  for (const adapter of pickAdapters(only)) {
    const d = await adapter.detect(ctx);
    if (!d.installed) {
      console.log(dim(M.notDetected(adapter.displayName)));
      continue;
    }
    console.log(`${M.detected(adapter.displayName, adapter.experimental)}${d.notes.length ? dim(M.notes(d.notes)) : ""}`);
    changes.push(...(await adapter.planInstall(ctx, { parts, projectRulesDir: null })));
    targets.push({ agent: adapter.id, parts });
  }
  if (targets.length === 0) {
    console.log(M.noneDetected(pickAdapters(null).map((a) => a.displayName)));
    return 1;
  }
  if (changes.length === 0) console.log(green(M.upToDate));
  else {
    console.log(bold(M.filesToChange));
    printChanges(changes);
  }
  if (p.flags["dry-run"]) {
    console.log(dim(M.dryRun));
    return 0;
  }
  if (changes.length > 0 && !(await confirm(p.flags, M.confirm))) {
    console.log(M.cancelled);
    return 1;
  }
  installProgram(ctx, bundlePath());
  ensureDir(tasksRoot(hs));
  const backup = backupDir(ctx);
  const { written, skipped } = applyChanges(changes, backup);
  recordInstall(hs, lang, targets);
  for (const s of skipped) console.log(red(M.skipped(tilde(s.file))));
  if (configExists && written.length === 0 && skipped.length === 0) {
    // 已经装过、配置也没变：这次只是更新程序
    console.log(green(M.updated(VERSION)));
    console.log(M.updatedNote);
    return 0;
  }
  console.log(green(M.wrote(written.length, tilde(backup))));
  const steps = [
    M.restart(targets.map((t) => adapterFor(t.agent)?.displayName ?? t.agent)),
    ...targets.flatMap((t) => adapterFor(t.agent)?.afterInstall ?? []),
    M.newTask(bold(M.newTaskCmd)),
    M.review(bold("hotseat review")),
  ];
  console.log(`${M.nextSteps}${steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`);
  return skipped.length > 0 ? 1 : 0;
}

async function uninstall(p: Parsed, env: Env): Promise<number> {
  const hs = hotseatHome(env);
  const ctx = adapterContext(env, existsSync(join(hs, ".hotseat", "config.json")) ? loadConfig(hs).lang : defaultLang(env));
  const adapters = pickAdapters(null);
  const changes = (await Promise.all(adapters.map((a) => a.planUninstall(ctx)))).flat();
  if (changes.length === 0) {
    console.log("没有找到 Hotseat 写入的配置。");
    return 0;
  }
  console.log(bold("将要移除 Hotseat 写入的内容："));
  for (const c of changes) console.log(`- [${c.agent}] ${tilde(c.file)} ${dim(`— ${c.summary}`)}`);
  console.log(dim(`\n任务数据（${tilde(hs)}/tasks）会保留。`));
  if (!(await confirm(p.flags, "\n确认移除？修改前会自动备份。"))) return 1;
  const backup = backupDir(ctx);
  const { written, skipped } = applyChanges(changes, backup);
  recordUninstall(hs, adapters.map((a) => a.id));
  console.log(green(`✓ 已修改 ${written.length} 个文件，备份在 ${tilde(backup)}`));
  for (const s of skipped) console.log(red(`✗ ${tilde(s.file)} 在确认期间被改动，已跳过，请重新运行。`));
  return skipped.length > 0 ? 1 : 0;
}

async function doctor(env: Env): Promise<number> {
  const hs = hotseatHome(env);
  const config = loadConfig(hs);
  const ctx = adapterContext(env, config.lang);
  const checks = await runtimeChecks(ctx);
  for (const a of pickAdapters(null)) {
    if (config.agents[a.id] || (await a.detect(ctx)).installed) checks.push(...(await a.doctor(ctx)));
  }
  for (const c of checks) {
    console.log(`${c.ok ? green("✓") : red("✗")} ${c.agent === "human" ? "" : `[${c.agent}] `}${c.message}${!c.ok && c.fix ? dim(`  → 修复：${c.fix}`) : ""}`);
  }
  return checks.every((c) => c.ok) ? 0 : 1;
}

function withService<T>(env: Env, fn: (svc: Hotseat) => T | Promise<T>): Promise<T> {
  const svc = Hotseat.open({ home: hotseatHome(env), env });
  return Promise.resolve(fn(svc)).finally(() => svc.close());
}

function currentTask(svc: Hotseat, slug: string | undefined): Task {
  const r = svc.resolve({ task: slug, cwds: [process.cwd()] });
  if (!r.task) throw new HotseatError("NO_TASK", `当前目录没有绑定任务。用 --task 指定，或先运行 hotseat new / hotseat link。${r.candidates.length ? `最近的任务：${r.candidates.join("、")}` : ""}`);
  return r.task;
}

async function review(p: Parsed, env: Env): Promise<number> {
  return withService(env, async (svc) => {
    const task = currentTask(svc, str(p.flags.task));
    const pending = svc.pending(task);
    if (pending.length === 0) {
      console.log(`任务 ${task.slug} 没有待确认的提议。`);
      return 0;
    }
    const memory = readTextOrNull(taskPath(task.dir, "memory")) ?? "";
    const label = { goal: "目标", decisions: "决定", constraints: "约束", rejected: "放弃的方案", notes: "备注" } as const;
    for (const prop of pending) {
      console.log(`\n${bold(prop.id)} · ${prop.kind === "memory" ? "memory.md" : "plan.md"} · ${prop.agent} · ${shortTime(prop.created)}${prop.reason ? dim(` · ${prop.reason}`) : ""}`);
      if (prop.kind === "memory") {
        const probe = applyMemoryEdits(memory, prop.edits, svc.lang);
        prop.edits.forEach((e, i) => {
          const note = probe.stale.includes(i) ? dim("（原文已被改掉，会作废）") : probe.skipped.includes(i) ? dim("（已经存在，会跳过）") : "";
          if (e.op !== "add") console.log(red(`  - [${label[e.section]}] ${e.old}`) + note);
          if (e.op !== "remove") console.log(green(`  + [${label[e.section]}] ${e.text}`) + (e.op === "add" ? note : ""));
        });
      } else {
        console.log(dim(`  方式：${prop.mode === "replace" ? "替换整个计划" : "追加到现有计划"}`));
        for (const s of prop.subtasks) {
          const extra = [s.deps?.length ? `deps: ${s.deps.join(", ")}` : "", s.files?.length ? `files: ${s.files.join(", ")}` : "", s.accept ? `验收: ${s.accept}` : ""];
          console.log(green(`  + ${s.id ?? "T?"} ${s.title}${extra.filter(Boolean).map((x) => ` · ${x}`).join("")}`));
        }
      }
      if (!process.stdin.isTTY) continue;
      const answer = await ask("接受 (a) / 拒绝 (r) / 跳过 (s) / 退出 (q)？ ");
      if (answer === "q") break;
      if (answer === "a" || answer === "r") {
        const r = await svc.resolveProposal(task, prop.id, answer === "a");
        console.log(r.status === "accepted" ? green(`✓ 已接受，生效 ${r.applied} 条`) : r.status === "stale" ? dim("全部作废（原文已被改掉）") : dim("已拒绝"));
      }
    }
    if (!process.stdin.isTTY) console.log(dim("\n在终端里运行 hotseat review 可以逐条确认。"));
    return 0;
  });
}

async function hook(p: Parsed, env: Env): Promise<number> {
  const [agent = "", event = ""] = p._.slice(1);
  const stdin = await readStdin(1_048_576, 1000);
  const out = await runHook(agent, event, stdin, env);
  await new Promise<void>((done) => process.stdout.write(out.stdout, () => done()));
  return 0;
}

export async function main(argv: string[], env: Env = process.env): Promise<number> {
  const p = parseArgs(argv);
  const cmd = p._[0];
  if (p.flags.version) {
    console.log(VERSION);
    return 0;
  }
  if (!cmd || p.flags.help || cmd === "help") {
    console.log(HELP);
    return 0;
  }
  switch (cmd) {
    case "hook":
      return hook(p, env);
    case "mcp":
      await startMcpServer(env);
      return -1; // 保持运行，直到客户端断开
    case "init":
      return init(p, env);
    case "uninstall":
      return uninstall(p, env);
    case "doctor":
      return doctor(env);
    case "rules": {
      const hs = hotseatHome(env);
      console.log(rulesText(existsSync(join(hs, ".hotseat", "config.json")) ? loadConfig(hs).lang : defaultLang(env), false));
      return 0;
    }
    case "new":
      return withService(env, async (svc) => {
        const name = p._.slice(1).join(" ").trim();
        if (!name) throw new Error('用法：hotseat new "任务名" [--path 目录] [--goal 目标]');
        const path = str(p.flags.path) ?? cwdOrNull() ?? undefined;
        const goal = str(p.flags.goal);
        const r = await svc.createTask("human", { name, ...(goal ? { goal } : {}), ...(path ? { path } : {}) }, { cwds: [] });
        console.log(green(`✓ ${r.text}`));
        console.log(dim(`  记忆文件：${tilde(join(hotseatHome(env), "tasks", r.data.slug, "memory.md"))}（可以直接编辑）`));
        return 0;
      });
    case "link":
      return withService(env, (svc) => {
        const dir = p._[1];
        if (!dir) throw new Error("用法：hotseat link <目录> [--task <slug>]");
        let slug = str(p.flags.task);
        if (!slug) {
          const tasks = svc.listTasks({}, { cwds: [] }).data.tasks;
          if (tasks.length !== 1) throw new Error(`请用 --task 指定任务：${tasks.map((t) => t.slug).join("、") || "（还没有任务）"}`);
          slug = tasks[0]?.slug as string;
        }
        console.log(green(`✓ ${svc.link(slug, dir).text}`));
        return 0;
      });
    case "list":
      return withService(env, (svc) => {
        console.log(svc.listTasks({ status: p.flags.all ? "all" : undefined }, { cwds: [process.cwd()] }).text);
        return 0;
      });
    case "context":
      return withService(env, (svc) => {
        const scene = Scene.safeParse(str(p.flags.scene)).data;
        console.log(svc.getContext("human", { ...(scene ? { scene } : {}), ...(str(p.flags.task) ? { task: str(p.flags.task) } : {}) }, { cwds: [process.cwd()] }).text);
        return 0;
      });
    case "review":
      return review(p, env);
    case "blame":
      return withService(env, (svc) => {
        const query = p._.slice(1).join(" ").trim();
        if (!query) throw new Error("用法：hotseat blame <关键词> [--task <slug>] [--all]");
        const task = currentTask(svc, str(p.flags.task));
        const r = svc.blame({ task: task.slug, query, all: Boolean(p.flags.all) }, { cwds: [] });
        console.log(r.text);
        return r.data.memory.length + r.data.events.length > 0 ? 0 : 1;
      });
    default:
      console.error(`不认识的命令：${cmd}\n`);
      console.log(HELP);
      return 1;
  }
}

// npx 会通过 node_modules/.bin 里的软链接启动，所以要比较 realpath。
const isEntry = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntry) {
  const argv = process.argv.slice(2);
  main(argv).then(
    (code) => {
      if (code >= 0) process.exit(code);
    },
    (e: unknown) => {
      if (argv[0] === "hook") process.exit(0); // Hook 永远放行
      console.error(red(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    },
  );
}
