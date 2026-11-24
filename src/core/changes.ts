// 收工检查用：找出本轮改过的文件。见 docs/interfaces.md §5.6 第 6 步。
import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { HOOK_LIMITS, NO_GIT_SKIP_DIRS } from "../contracts/hooks.ts";

const run = promisify(execFile);

/** 绝对路径 → 修改时间（毫秒）；已删除为 -1。 */
export type Snapshot = Record<string, number>;

export interface DirtyState {
  snapshot: Snapshot;
  /** 不是 Git 仓库的目录，改用修改时间判断 */
  noGit: string[];
}

const under = (path: string, dirs: readonly string[]): boolean => dirs.some((d) => path === d || path.startsWith(d + sep));

async function git(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", args, { timeout: 800, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
    return stdout;
  } catch {
    return null;
  }
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

/** 各目录当前未提交的文件（含未跟踪文件）及其修改时间。 */
export async function dirtyState(paths: readonly string[], exclude: readonly string[]): Promise<DirtyState> {
  const state: DirtyState = { snapshot: {}, noGit: [] };
  for (const dir of paths) {
    const top = (await git(["-C", dir, "rev-parse", "--show-toplevel"]))?.trim();
    const out = top ? await git(["-C", dir, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]) : null;
    if (!top || out === null) {
      state.noGit.push(dir);
      continue;
    }
    const parts = out.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i] ?? "";
      if (entry.length < 4) continue;
      const xy = entry.slice(0, 2);
      if (xy[0] === "R" || xy[0] === "C") i++; // 重命名后面跟着原路径
      const abs = join(top, entry.slice(3));
      if (under(abs, exclude)) continue;
      state.snapshot[abs] = mtime(abs);
    }
  }
  return state;
}

/**
 * 和本轮开始时的快照比，新出现的、修改时间变了的、本轮被提交或还原的，都算改过。
 * 没有快照时，退回到「修改时间晚于本轮开始」。
 */
export function changedSince(prev: Snapshot | null, cur: Snapshot, sinceMs: number): string[] {
  if (!prev) return Object.entries(cur).filter(([, m]) => m > sinceMs).map(([p]) => p);
  const out = Object.entries(cur).filter(([p, m]) => prev[p] !== m).map(([p]) => p);
  for (const p of Object.keys(prev)) if (!(p in cur)) out.push(p);
  return out;
}

/** 没有 Git 的目录：遍历找修改时间晚于 sinceMs 的文件。超出上限就当作没有改动。 */
export function walkChanged(paths: readonly string[], sinceMs: number, exclude: readonly string[]): string[] {
  const deadline = Date.now() + HOOK_LIMITS.noGitMaxMs;
  const skip = new Set<string>(NO_GIT_SKIP_DIRS);
  const out: string[] = [];
  let seen = 0;
  const stack = [...paths];
  while (stack.length > 0) {
    if (seen > HOOK_LIMITS.noGitMaxFiles || Date.now() > deadline) return [];
    const dir = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (skip.has(name)) continue;
      const full = join(dir, name);
      if (under(full, exclude)) continue;
      seen++;
      try {
        const st = statSync(full);
        if (st.isDirectory()) stack.push(full);
        else if (st.mtimeMs > sinceMs) out.push(full);
      } catch {
        // 文件刚被删掉
      }
    }
  }
  return out;
}
