// index.db：状态表和检索缓存。见 docs/interfaces.md §1.10。
import { DatabaseSync } from "node:sqlite";
import { FTS_MIN_MATCH_CHARS, INDEX_DB_PRAGMAS, INDEX_DB_SCHEMA } from "../contracts/storage.ts";
import { ensureDir, homePath } from "./util.ts";
import { dirname } from "node:path";

export type Db = DatabaseSync;

export function openDb(home: string): Db {
  const path = homePath(home, "db");
  ensureDir(dirname(path));
  const db = new DatabaseSync(path);
  for (const p of INDEX_DB_PRAGMAS) db.exec(p);
  db.exec(INDEX_DB_SCHEMA);
  return db;
}

type Row = Record<string, unknown>;
const one = <T>(db: Db, sql: string, ...params: (string | number | null)[]): T | null =>
  (db.prepare(sql).get(...params) as T | undefined) ?? null;

// ---------- 已读位置 ----------

export interface Watermark {
  seq: number;
  memory_hash: string | null;
  memory_snapshot: string | null;
  plan_hash: string | null;
  plan_snapshot: string | null;
  updated_at: string;
}

export function getWatermark(db: Db, agent: string, task: string): Watermark | null {
  return one<Watermark>(db, "SELECT seq, memory_hash, memory_snapshot, plan_hash, plan_snapshot, updated_at FROM watermarks WHERE agent = ? AND task = ?", agent, task);
}

export function setWatermark(db: Db, agent: string, task: string, w: Watermark): void {
  db.prepare(
    `INSERT INTO watermarks (agent, task, seq, memory_hash, memory_snapshot, plan_hash, plan_snapshot, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (agent, task) DO UPDATE SET seq = excluded.seq, memory_hash = excluded.memory_hash,
       memory_snapshot = excluded.memory_snapshot, plan_hash = excluded.plan_hash,
       plan_snapshot = excluded.plan_snapshot, updated_at = excluded.updated_at`,
  ).run(agent, task, w.seq, w.memory_hash, w.memory_snapshot, w.plan_hash, w.plan_snapshot, w.updated_at);
}

// ---------- 会话（Hook 登记） ----------

export interface SessionRow {
  agent: string;
  session_id: string;
  task: string | null;
  cwd: string | null;
  started_at: string;
  window_start: string;
  dirty_snapshot: string;
  blocks: number;
  last_block_at: string | null;
}

export function getSession(db: Db, agent: string, sessionId: string): SessionRow | null {
  return one<SessionRow>(db, "SELECT * FROM sessions WHERE agent = ? AND session_id = ?", agent, sessionId);
}

export function upsertSession(db: Db, s: SessionRow): void {
  db.prepare(
    `INSERT INTO sessions (agent, session_id, task, cwd, started_at, window_start, dirty_snapshot, blocks, last_block_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (agent, session_id) DO UPDATE SET task = excluded.task, cwd = excluded.cwd,
       started_at = excluded.started_at, window_start = excluded.window_start,
       dirty_snapshot = excluded.dirty_snapshot, blocks = excluded.blocks, last_block_at = excluded.last_block_at`,
  ).run(s.agent, s.session_id, s.task, s.cwd, s.started_at, s.window_start, s.dirty_snapshot, s.blocks, s.last_block_at);
}

/** 同一工具、同一任务、since 之后最近开始的会话（用于填事件的 session 字段）。 */
export function latestSessionId(db: Db, agent: string, task: string, since: string): string | null {
  const row = one<{ session_id: string }>(
    db,
    "SELECT session_id FROM sessions WHERE agent = ? AND task = ? AND started_at >= ? ORDER BY started_at DESC LIMIT 1",
    agent,
    task,
    since,
  );
  return row?.session_id ?? null;
}

// ---------- 当前任务 ----------

export function getPathActive(db: Db, path: string): string | null {
  return one<{ task: string }>(db, "SELECT task FROM path_active WHERE path = ?", path)?.task ?? null;
}

export function setPathActive(db: Db, path: string, task: string, now: string): void {
  db.prepare(
    "INSERT INTO path_active (path, task, updated_at) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET task = excluded.task, updated_at = excluded.updated_at",
  ).run(path, task, now);
}

export interface Activity {
  last_active: string | null;
  last_agent: string | null;
  last_seq: number | null;
}

export function getActivity(db: Db, task: string): Activity | null {
  return one<Activity>(db, "SELECT last_active, last_agent, last_seq FROM task_activity WHERE task = ?", task);
}

export function touchActivity(db: Db, task: string, time: string, agent: string, seq: number): void {
  db.prepare(
    `INSERT INTO task_activity (task, last_active, last_agent, last_seq) VALUES (?, ?, ?, ?)
     ON CONFLICT (task) DO UPDATE SET last_active = excluded.last_active, last_agent = excluded.last_agent, last_seq = excluded.last_seq`,
  ).run(task, time, agent, seq);
}

// ---------- 检索 ----------

export interface DocRow {
  task: string;
  kind: "event" | "memory" | "plan" | "file";
  ref: string;
  time: string | null;
  agent: string | null;
  text: string;
}

export function putDoc(db: Db, d: DocRow): void {
  db.prepare("DELETE FROM docs WHERE task = ? AND ref = ?").run(d.task, d.ref);
  db.prepare("INSERT INTO docs (task, kind, ref, time, agent, text) VALUES (?, ?, ?, ?, ?, ?)").run(d.task, d.kind, d.ref, d.time, d.agent, d.text);
}

export function deleteDocs(db: Db, task: string, kind?: DocRow["kind"]): void {
  if (kind) db.prepare("DELETE FROM docs WHERE task = ? AND kind = ?").run(task, kind);
  else db.prepare("DELETE FROM docs WHERE task = ?").run(task);
}

export interface SearchHit extends DocRow {
  snippet: string;
}

function likeSnippet(text: string, terms: string[]): string {
  const t = terms[0] ?? "";
  const i = t ? text.indexOf(t) : -1;
  if (i < 0) return text.slice(0, 60);
  const start = Math.max(0, i - 20);
  return `${start > 0 ? "…" : ""}${text.slice(start, i)}【${t}】${text.slice(i + t.length, i + t.length + 30)}${i + t.length + 30 < text.length ? "…" : ""}`;
}

/** 3 个字以上的词用 MATCH，1–2 个字的词用 LIKE（trigram 的限制，见 §1.10）。 */
export function searchDocs(db: Db, q: { query: string; tasks: string[] | null; kinds: DocRow["kind"][] | null; limit: number }): SearchHit[] {
  const terms = q.query.split(/\s+/).filter(Boolean);
  const long = terms.filter((t) => [...t].length >= FTS_MIN_MATCH_CHARS);
  const short = terms.filter((t) => [...t].length < FTS_MIN_MATCH_CHARS);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (long.length > 0) {
    where.push("docs MATCH ?");
    params.push(long.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND "));
  }
  for (const t of short) {
    where.push("text LIKE ? ESCAPE '\\'");
    params.push(`%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (q.tasks) {
    where.push(`task IN (${q.tasks.map(() => "?").join(", ") || "NULL"})`);
    params.push(...q.tasks);
  }
  if (q.kinds) {
    where.push(`kind IN (${q.kinds.map(() => "?").join(", ") || "NULL"})`);
    params.push(...q.kinds);
  }
  const snippet = long.length > 0 ? "snippet(docs, 5, '【', '】', '…', 16)" : "''";
  const sql = `SELECT task, kind, ref, time, agent, text, ${snippet} AS snippet FROM docs WHERE ${where.join(" AND ") || "1"} ORDER BY time DESC LIMIT ?`;
  params.push(q.limit);
  return (db.prepare(sql).all(...params) as Row[]).map((r) => {
    const row = r as unknown as SearchHit;
    return { ...row, snippet: row.snippet || likeSnippet(row.text, short) };
  });
}
