// 路径、时间、文件读写、哈希、写锁。
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { HotseatError } from "../contracts/errors.ts";
import { DEFAULT_HOME_DIRNAME, HOME_PATHS, HOTSEAT_HOME_ENV, LOCK_LIMITS, TASK_PATHS } from "../contracts/storage.ts";

export type Env = Readonly<Record<string, string | undefined>>;

// ---------- 路径 ----------

export function userHome(env: Env = process.env): string {
  return env.HOME ?? homedir();
}

export function hotseatHome(env: Env = process.env): string {
  const custom = env[HOTSEAT_HOME_ENV];
  return custom ? resolve(custom) : join(userHome(env), DEFAULT_HOME_DIRNAME);
}

export const homePath = (home: string, key: keyof typeof HOME_PATHS): string => join(home, HOME_PATHS[key]);
export const tasksRoot = (home: string): string => join(home, HOME_PATHS.tasks);
export const taskDir = (home: string, slug: string): string => join(tasksRoot(home), slug);
export const taskPath = (dir: string, key: keyof typeof TASK_PATHS): string => join(dir, TASK_PATHS[key]);

// ---------- 时间 ----------

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** 本地时间，带时区偏移，精确到秒：2026-11-23T14:02:11+08:00 */
export function isoLocal(d: Date = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** 「11-23 14:02」：直接取写入方的本地时间，不做时区换算。 */
export function shortTime(iso: string): string {
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

export function provenance(agent: string, iso: string, id?: string): string {
  return `〔${agent} · ${shortTime(iso)}${id ? ` · ${id}` : ""}〕`;
}

// ---------- 文件 ----------

export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** 先写临时文件再改名，避免写到一半被读到。 */
export function atomicWrite(path: string, content: string, mode?: number): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function appendLineSync(path: string, line: string): void {
  ensureDir(dirname(path));
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${line}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** 前 8KB 里有 NUL 字节就当作二进制。 */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

// ---------- 写锁（§1.12） ----------

export async function withLock<T>(lockPath: string, fn: () => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_LIMITS.waitMs;
  ensureDir(dirname(lockPath));
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_LIMITS.staleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // 锁刚被释放
      }
      if (Date.now() > deadline) throw new HotseatError("LOCK_TIMEOUT", "2 秒内没有拿到写锁，请稍后重试一次");
      await sleep(LOCK_LIMITS.retryMs);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // 已被当作残留清掉
    }
  }
}

export const taskLock = <T>(dir: string, fn: () => T | Promise<T>): Promise<T> => withLock(taskPath(dir, "lock"), fn);

/** 去掉首尾空白、来源标记，合并空白，用于比较两条内容是否相同。 */
export function normalizeText(text: string): string {
  return text
    .replace(/\s*〔[^〕]*〕\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}
