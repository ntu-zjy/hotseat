// init / uninstall / doctor 的公共部分：固定安装程序、备份、写入、更新 config.json。PRD F1。
import { chmodSync, copyFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Adapter, AdapterContext, DoctorCheck, PlannedChange } from "../contracts/adapter.ts";
import type { AgentId, InstallPart, Lang } from "../contracts/common.ts";
import { Config } from "../contracts/storage.ts";
import { ADAPTERS } from "../adapters/registry.ts";
import { atomicWrite, ensureDir, homePath, isoLocal, readTextOrNull, userHome, hotseatHome, type Env } from "../core/util.ts";

export function adapterContext(env: Env, lang: Lang): AdapterContext {
  const home = userHome(env);
  const hs = hotseatHome(env);
  return { home, hotseatHome: hs, bin: homePath(hs, "bin"), lang, platform: process.platform, env };
}

function readRawConfig(hs: string): Record<string, unknown> {
  const raw = readTextOrNull(homePath(hs, "config"));
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : { v: 1 };
}

export function loadConfig(hs: string): Config {
  return Config.parse(readRawConfig(hs));
}

/**
 * 只改 lang、agents 两项，其他字段原样写回。缺省值（预算等）不写进文件，
 * 留在代码里，以后改缺省值，已经装过的人也能用上。
 */
function updateConfig(hs: string, change: (config: Config) => void): void {
  const raw = readRawConfig(hs);
  const config = Config.parse(raw);
  change(config);
  atomicWrite(homePath(hs, "config"), `${JSON.stringify({ ...raw, lang: config.lang, agents: config.agents }, null, 2)}\n`);
}

export function defaultLang(env: Env): Lang {
  const loc = env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? Intl.DateTimeFormat().resolvedOptions().locale;
  return /^zh/i.test(loc ?? "") ? "zh" : "en";
}

export function pickAdapters(only: string[] | null, lang: Lang = "zh"): Adapter[] {
  if (!only) return [...ADAPTERS];
  const unknown = only.filter((id) => !ADAPTERS.some((a) => a.id === id));
  const ids = ADAPTERS.map((a) => a.id).join(", ");
  if (unknown.length) throw new Error(lang === "en" ? `Unknown tool: ${unknown.join(", ")}. Supported: ${ids}` : `不认识的工具：${unknown.join(", ")}。目前支持：${ids}`);
  return ADAPTERS.filter((a) => only.includes(a.id));
}

// ---------- 固定安装（PRD §9） ----------

/**
 * Homebrew 的 process.execPath 是带版本号的 Cellar 目录，升级后会消失；
 * 换成 Homebrew 的固定路径（…/opt/<formula>/…），升级后依然有效。
 */
export function stableNodePath(execPath: string): string {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.+)$/.exec(execPath);
  if (!m) return execPath;
  const stable = `${m[1]}/opt/${m[2]}/${m[3]}`;
  return existsSync(stable) ? stable : execPath;
}

export function installProgram(ctx: AdapterContext, bundle: string): void {
  const lib = join(homePath(ctx.hotseatHome, "lib"), "hotseat.mjs");
  ensureDir(dirname(lib));
  if (bundle !== lib) copyFileSync(bundle, lib);
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const shim = `#!/bin/sh\n# 由 hotseat init 生成。Node 路径写死，切换 nvm 版本也不影响。\nexec ${q(stableNodePath(process.execPath))} --no-warnings ${q(lib)} "$@"\n`;
  atomicWrite(ctx.bin, shim);
  chmodSync(ctx.bin, 0o755);
}

// ---------- 备份和写入 ----------

export function backupDir(ctx: AdapterContext, now = new Date()): string {
  return join(homePath(ctx.hotseatHome, "backups"), isoLocal(now).replace(/[:+]/g, "").replace("T", "-"));
}

/**
 * 先备份，再写入。写之前再读一次文件：如果和计划时不一样（例如 Claude 刚好改了 ~/.claude.json），
 * 跳过这个文件，让用户重新运行，避免覆盖别人的改动。
 */
export function applyChanges(changes: readonly PlannedChange[], backup: string): { written: PlannedChange[]; skipped: PlannedChange[] } {
  const written: PlannedChange[] = [];
  const skipped: PlannedChange[] = [];
  for (const c of changes) {
    if (c.kind === "manual") continue;
    const current = readTextOrNull(c.file);
    if (current !== c.before) {
      skipped.push(c);
      continue;
    }
    const target = join(backup, c.file.replace(/^\/+/, ""));
    // 同一个文件有两处改动（例如 Qoder 的 settings.json 里 MCP 和 Hook）时，备份只留第一次的原文
    if (current !== null && !existsSync(target)) {
      ensureDir(dirname(target));
      copyFileSync(c.file, target);
    }
    if (c.after === null) {
      if (existsSync(c.file)) unlinkSync(c.file);
    } else {
      atomicWrite(c.file, c.after);
    }
    written.push(c);
  }
  return { written, skipped };
}

export function recordInstall(hs: string, lang: Lang, installed: { agent: AgentId; parts: InstallPart[] }[]): void {
  updateConfig(hs, (config) => {
    config.lang = lang;
    for (const { agent, parts } of installed) {
      const prev = config.agents[agent];
      config.agents[agent] = { enabled: true, stopCheck: prev?.stopCheck ?? true, installedAt: isoLocal(), parts: [...new Set([...(prev?.parts ?? []), ...parts])] };
    }
  });
}

export function recordUninstall(hs: string, agents: AgentId[]): void {
  updateConfig(hs, (config) => {
    for (const a of agents) delete config.agents[a];
  });
}

export async function runtimeChecks(ctx: AdapterContext): Promise<DoctorCheck[]> {
  const shim = readTextOrNull(ctx.bin);
  const en = ctx.lang === "en";
  if (!shim) return [{ agent: "human", part: "runtime", ok: false, message: en ? `${ctx.bin} doesn't exist` : `${ctx.bin} 不存在`, fix: "npx hotseat init" }];
  const node = /exec '([^']+)'/.exec(shim)?.[1];
  const lib = join(homePath(ctx.hotseatHome, "lib"), "hotseat.mjs");
  return [
    node && existsSync(node)
      ? { agent: "human", part: "runtime", ok: true, message: en ? `Node: ${node}` : `Node：${node}` }
      : { agent: "human", part: "runtime", ok: false, message: en ? `The Node in the launcher (${node ?? "?"}) is gone` : `启动脚本里的 Node（${node ?? "?"}）不存在了`, fix: "npx hotseat init" },
    existsSync(lib)
      ? { agent: "human", part: "runtime", ok: true, message: en ? `Program: ${lib}` : `程序：${lib}` }
      : { agent: "human", part: "runtime", ok: false, message: en ? `${lib} doesn't exist` : `${lib} 不存在`, fix: "npx hotseat init" },
  ];
}
