// 存储格式：目录、config.json、task.yaml、memory.md、plan.md、提议、index.db、密钥检测。
// 见 docs/interfaces.md §1。
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  AgentId,
  EventId,
  InstallPart,
  IsoTime,
  Lang,
  MemorySection,
  ProposalId,
  SubtaskId,
  TaskSlug,
  TaskStatus,
  Version,
  type SubtaskStatus,
} from "./common.ts";

// ---------- 目录（§1.1） ----------

export const HOTSEAT_HOME_ENV = "HOTSEAT_HOME";
export const DEFAULT_HOME_DIRNAME = "Hotseat";

/** 相对于数据根目录（默认 ~/Hotseat）。 */
export const HOME_PATHS = {
  internal: ".hotseat",
  bin: ".hotseat/bin/hotseat",
  lib: ".hotseat/lib",
  config: ".hotseat/config.json",
  db: ".hotseat/index.db",
  backups: ".hotseat/backups",
  hookLog: ".hotseat/logs/hook.log",
  tasks: "tasks",
} as const;

/** 相对于 tasks/<slug>/。 */
export const TASK_PATHS = {
  task: "task.yaml",
  memory: "memory.md",
  plan: "plan.md",
  events: "events.jsonl",
  progress: "progress.md",
  index: "INDEX.md",
  pending: ".pending",
  pendingArchive: ".pending/archive",
  lock: ".lock",
  files: "files",
} as const;

/** read_task_file 允许读的固定文件；另外允许 files/ 下的任意文件（§4.8）。 */
export const READABLE_TASK_FILES = ["memory.md", "plan.md", "progress.md", "INDEX.md"] as const;

// ---------- config.json（§1.2） ----------

export const AgentConfig = z.looseObject({
  enabled: z.boolean(),
  stopCheck: z.boolean().default(true),
  installedAt: IsoTime,
  parts: z.array(InstallPart),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export const Config = z.looseObject({
  v: Version,
  lang: Lang.default("zh"),
  pack: z
    .looseObject({
      defaultBudget: z.number().int().min(200).max(8000).default(5000),
      maxBudget: z.number().int().min(200).max(8000).default(8000),
    })
    .default({ defaultBudget: 5000, maxBudget: 8000 }),
  secretScan: z.boolean().default(true),
  updateCheck: z.boolean().default(true),
  // 键用 string 而不是 AgentId：新版加了工具后写进来的键，旧版（还开着的会话）也要能读，不能整份配置报错
  agents: z.record(z.string(), AgentConfig).default({}),
});
export type Config = z.infer<typeof Config>;

// ---------- task.yaml（§1.3） ----------

export const TaskFile = z.looseObject({
  v: Version,
  slug: TaskSlug,
  name: z.string().min(1).max(80),
  status: TaskStatus,
  created: IsoTime,
  paths: z.array(z.string().refine(isAbsolute, "必须是绝对路径")),
});
export type TaskFile = z.infer<typeof TaskFile>;

// ---------- memory.md（§1.4） ----------

export const MEMORY_HEADINGS: Record<MemorySection, readonly string[]> = {
  goal: ["目标", "Goal"],
  decisions: ["关键决定", "Decisions"],
  constraints: ["约束", "Constraints"],
  rejected: ["放弃过的方案", "Rejected"],
  notes: ["备注", "Notes"],
};
/** 条目末尾的来源标记，例如 「… 〔e_000192〕」。 */
export const PROVENANCE_RE = /\s*〔(e_\d{6,})〕\s*$/u;
/** 决定和放弃的方案写成「内容 —— 理由」。 */
export const REASON_SEPARATOR = " —— ";

// ---------- plan.md（§1.5） ----------

export const PLAN_STATUS_MARKS = {
  todo: " ",
  doing: "~",
  done: "x",
  blocked: "!",
  dropped: "-",
} as const satisfies Record<SubtaskStatus, string>;

/** - [<状态>] <编号> <标题>[ · <键>: <值>]* */
/** 解析时也接受人手写的 `*` 列表和大写 X。 */
export const PLAN_LINE_RE = /^[-*] \[([ ~xX!-])\] (T\d+)\s+(.+)$/u;
export const PLAN_FIELD_SEPARATOR = " · ";
export const PLAN_KEYS = {
  deps: ["deps"],
  files: ["files"],
  accept: ["验收", "accept"],
} as const;

// ---------- .pending/ 提议（§1.7） ----------

const Short = z.string().trim().min(1).max(300);

/** 存储用的严格结构：按 op 区分必填字段。 */
export const MemoryEdit = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), section: MemorySection, text: Short }),
  z.object({ op: z.literal("remove"), section: MemorySection, old: Short }),
  z.object({ op: z.literal("replace"), section: MemorySection, old: Short, text: Short }),
]);
export type MemoryEdit = z.infer<typeof MemoryEdit>;

export const ProposalStatus = z.enum(["pending", "accepted", "rejected", "stale"]);
export const PlanMode = z.enum(["replace", "append"]);

export const PlanSubtask = z.object({
  id: SubtaskId.optional(),
  title: z.string().trim().min(1).max(120),
  deps: z.array(SubtaskId).max(20).optional(),
  files: z.array(z.string().min(1).max(200)).max(20).optional(),
  accept: z.string().max(300).optional(),
});
export type PlanSubtask = z.infer<typeof PlanSubtask>;

const proposalBase = {
  v: Version,
  id: ProposalId,
  status: ProposalStatus,
  created: IsoTime,
  resolved: IsoTime.optional(),
  agent: AgentId,
  session: z.string().nullable(),
  reason: z.string().max(300),
};

export const MemoryProposal = z.looseObject({
  ...proposalBase,
  kind: z.literal("memory"),
  source_event: EventId.nullable(),
  base_memory_hash: z.string().regex(/^sha256:[0-9a-f]+$/),
  edits: z.array(MemoryEdit).min(1).max(20),
});

export const PlanProposal = z.looseObject({
  ...proposalBase,
  kind: z.literal("plan"),
  mode: PlanMode,
  subtasks: z.array(PlanSubtask).min(1).max(30),
});

export const Proposal = z.discriminatedUnion("kind", [MemoryProposal, PlanProposal]);
export type Proposal = z.infer<typeof Proposal>;

// ---------- index.db（§1.10） ----------

export const INDEX_DB_PRAGMAS = ["PRAGMA journal_mode = WAL", "PRAGMA busy_timeout = 2000"] as const;

export const INDEX_DB_SCHEMA = `
-- 状态表（丢了无法重建，只会降级）
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS watermarks (
  agent TEXT NOT NULL, task TEXT NOT NULL,
  seq INTEGER NOT NULL,
  memory_hash TEXT, memory_snapshot TEXT,
  plan_hash TEXT, plan_snapshot TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent, task)
);
CREATE TABLE IF NOT EXISTS sessions (
  agent TEXT NOT NULL, session_id TEXT NOT NULL,
  task TEXT, cwd TEXT,
  started_at TEXT NOT NULL,
  window_start TEXT NOT NULL,
  dirty_snapshot TEXT NOT NULL DEFAULT '{}',
  blocks INTEGER NOT NULL DEFAULT 0, last_block_at TEXT,
  PRIMARY KEY (agent, session_id)
);
CREATE INDEX IF NOT EXISTS sessions_by_task ON sessions (agent, task, started_at);
CREATE TABLE IF NOT EXISTS path_active (
  path TEXT PRIMARY KEY, task TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- 缓存表（hotseat reindex 可重建）
CREATE TABLE IF NOT EXISTS task_activity (
  task TEXT PRIMARY KEY, last_active TEXT, last_agent TEXT, last_seq INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
  task UNINDEXED, kind UNINDEXED, ref UNINDEXED, time UNINDEXED, agent UNINDEXED,
  text, tokenize = 'trigram'
);
`;

/** trigram 分词下，少于 3 个字的查询用 MATCH 搜不到，要改用 LIKE。 */
export const FTS_MIN_MATCH_CHARS = 3;

// ---------- 写锁（§1.12） ----------

export const LOCK_LIMITS = { retryMs: 50, waitMs: 2000, staleMs: 10_000 } as const;

// ---------- 密钥检测（§4.2） ----------

/** 顺序有意义：更具体的规则放前面（sk-ant- 要先于 sk-）。 */
export const SECRET_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: "assignment", re: /\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[^\s"']{8,}/gi },
];

/** 把命中的部分替换成 [REDACTED:<类型>]，返回替换后的文本和命中的类型。 */
export function redactSecrets(text: string): { text: string; hits: string[] } {
  const hits: string[] = [];
  let out = text;
  for (const { kind, re } of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      hits.push(kind);
      return `[REDACTED:${kind}]`;
    });
  }
  return { text: out, hits };
}
