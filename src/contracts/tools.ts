// MCP 工具：名称、描述、输入、输出。见 docs/interfaces.md §4。
//
// 输入用「字段表」（z.object 的参数）导出，可以直接传给 MCP SDK 的 registerTool({ inputSchema })。
// 约定：输入里不用 union / nullable，避免生成 JSON Schema 的 anyOf / oneOf。
// 部分模型（例如 agy 用的 Gemini）对这类结构支持不好；按 op 区分的校验放在处理函数里做。
import { z } from "zod";
import {
  AgentId,
  EventId,
  IsoTime,
  MemorySection,
  ProposalId,
  Scene,
  SubtaskId,
  SubtaskStatus,
  TaskSlug,
  TaskStatus,
} from "./common.ts";
import { progressFields } from "./events.ts";
import { PACK_LIMITS, PackSection } from "./pack.ts";
import { PlanMode, PlanSubtask } from "./storage.ts";

export const MCP_SERVER_NAME = "hotseat";

export const TOOL_NAMES = [
  "get_context",
  "record_progress",
  "propose_memory_edit",
  "list_tasks",
  "switch_task",
  "create_task",
  "search",
  "read_task_file",
  "propose_plan",
  "update_subtask",
  "annotate_file",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

type Shape = Record<string, z.ZodType>;

// ---------- 共用参数 ----------

const common = {
  task: TaskSlug.optional().describe("Task slug. Omit to resolve from cwd. / 任务编号，不填则按目录自动判断"),
  cwd: z
    .string()
    .optional()
    .describe("Your current working directory or workspace root. / 你当前的工作目录或工作区根目录"),
} satisfies Shape;

// ---------- 输入 ----------

export const GetContextInput = {
  ...common,
  scene: Scene.optional().describe("code (default) | research | review | plan"),
  budget: z.number().int().min(PACK_LIMITS.minBudget).max(PACK_LIMITS.maxBudget).optional(),
} satisfies Shape;

export const RecordProgressInput = {
  ...common,
  ...progressFields,
  subtask_status: SubtaskStatus.optional().describe("Also update the subtask's status (requires subtask)"),
} satisfies Shape;

/** 扁平结构，按 op 的必填校验见 validateMemoryEditInput。 */
export const MemoryEditInput = z.object({
  op: z.enum(["add", "remove", "replace"]),
  section: MemorySection,
  text: z.string().trim().min(1).max(300).optional(),
  old: z.string().trim().min(1).max(300).optional(),
});
export type MemoryEditInput = z.infer<typeof MemoryEditInput>;

export const ProposeMemoryEditInput = {
  ...common,
  edits: z.array(MemoryEditInput).min(1).max(20),
  reason: z.string().trim().min(1).max(300),
} satisfies Shape;

export const ListTasksInput = {
  cwd: common.cwd,
  status: z.enum(["active", "paused", "done", "archived", "all"]).optional(),
} satisfies Shape;

export const SwitchTaskInput = {
  cwd: common.cwd,
  slug: TaskSlug,
  bind: z.boolean().optional(),
} satisfies Shape;

export const CreateTaskInput = {
  cwd: common.cwd,
  name: z.string().trim().min(1).max(80),
  goal: z.string().trim().min(1).max(500).optional(),
  slug: TaskSlug.optional(),
  path: z.string().optional(),
} satisfies Shape;

export const SearchInput = {
  ...common,
  query: z.string().trim().min(1).max(200),
  scope: z.enum(["all", "events", "memory", "plan", "files"]).optional(),
  all_tasks: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
} satisfies Shape;

export const ReadTaskFileInput = {
  ...common,
  path: z.string().min(1).max(500),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
} satisfies Shape;

export const ProposePlanInput = {
  ...common,
  subtasks: z.array(PlanSubtask).min(1).max(30),
  mode: PlanMode.optional(),
  reason: z.string().trim().min(1).max(300).optional(),
} satisfies Shape;

export const UpdateSubtaskInput = {
  ...common,
  id: SubtaskId,
  status: SubtaskStatus,
  note: z.string().trim().min(1).max(300).optional(),
} satisfies Shape;

export const AnnotateFileInput = {
  ...common,
  path: z.string().min(1).max(500),
  summary: z.string().trim().min(1).max(200),
} satisfies Shape;

export const TOOL_INPUTS = {
  get_context: GetContextInput,
  record_progress: RecordProgressInput,
  propose_memory_edit: ProposeMemoryEditInput,
  list_tasks: ListTasksInput,
  switch_task: SwitchTaskInput,
  create_task: CreateTaskInput,
  search: SearchInput,
  read_task_file: ReadTaskFileInput,
  propose_plan: ProposePlanInput,
  update_subtask: UpdateSubtaskInput,
  annotate_file: AnnotateFileInput,
} satisfies Record<ToolName, Shape>;

/** 返回第一个不满足要求的问题；全部合格返回 null。 */
export function validateMemoryEditInput(edit: MemoryEditInput): string | null {
  if (edit.op === "add" && !edit.text) return "add 需要 text";
  if (edit.op === "remove" && !edit.old) return "remove 需要 old";
  if (edit.op === "replace" && (!edit.old || !edit.text)) return "replace 需要 old 和 text";
  return null;
}

// ---------- 输出（structuredContent） ----------

const TaskRef = z.object({ slug: TaskSlug, name: z.string(), status: TaskStatus });

export const GetContextOutput = z.object({
  task: TaskRef.nullable(),
  agent: AgentId,
  scene: Scene,
  budget: z.number().int(),
  estimated_tokens: z.number().int(),
  truncated: z.array(PackSection),
  first_visit: z.boolean(),
  since: z.object({ events: z.number().int(), memory_changed: z.boolean(), plan_changed: z.boolean() }).nullable(),
  pending_proposals: z.number().int(),
  candidates: z.array(TaskSlug),
});

export const RecordProgressOutput = z.object({
  event_id: EventId,
  task: TaskSlug,
  proposal_id: ProposalId.nullable(),
  warnings: z.array(z.string()),
});

export const ProposeMemoryEditOutput = z.object({
  proposal_id: ProposalId.nullable(),
  stale_edits: z.array(z.number().int()),
});

export const TaskSummary = z.object({
  slug: TaskSlug,
  name: z.string(),
  status: TaskStatus,
  paths: z.array(z.string()),
  last_active: IsoTime.nullable(),
  last_agent: AgentId.nullable(),
  current_subtask: SubtaskId.nullable(),
  pending_proposals: z.number().int(),
});

export const ListTasksOutput = z.object({ resolved: TaskSlug.nullable(), tasks: z.array(TaskSummary) });
export const SwitchTaskOutput = z.object({ task: TaskSlug, path: z.string(), bound: z.boolean() });
export const CreateTaskOutput = z.object({ slug: TaskSlug, path: z.string().nullable() });

export const SearchResult = z.object({
  task: TaskSlug,
  kind: z.enum(["event", "memory", "plan", "file"]),
  ref: z.string(),
  snippet: z.string(),
  time: IsoTime.optional(),
  agent: AgentId.optional(),
});
export const SearchOutput = z.object({ results: z.array(SearchResult) });

export const ReadTaskFileOutput = z.object({
  path: z.string(),
  total_lines: z.number().int(),
  offset: z.number().int(),
  returned_lines: z.number().int(),
  truncated: z.boolean(),
});

export const ProposePlanOutput = z.object({ proposal_id: ProposalId });
export const UpdateSubtaskOutput = z.object({
  id: SubtaskId,
  from: SubtaskStatus.nullable(),
  to: SubtaskStatus,
  event_id: EventId,
});
export const AnnotateFileOutput = z.object({ path: z.string() });

export const TOOL_OUTPUTS = {
  get_context: GetContextOutput,
  record_progress: RecordProgressOutput,
  propose_memory_edit: ProposeMemoryEditOutput,
  list_tasks: ListTasksOutput,
  switch_task: SwitchTaskOutput,
  create_task: CreateTaskOutput,
  search: SearchOutput,
  read_task_file: ReadTaskFileOutput,
  propose_plan: ProposePlanOutput,
  update_subtask: UpdateSubtaskOutput,
  annotate_file: AnnotateFileOutput,
} satisfies Record<ToolName, z.ZodType>;

// ---------- 描述（中英双语，第一句写什么时候调用） ----------

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  get_context:
    "Call at the start of work, unless a 'Hotseat' handoff block is already in your context. Returns the shared task context: goal, constraints, current subtask, half-done state, next steps, and what other agents did since you last visited. If no task is bound, just work normally and do not ask the user about it.\n" +
    "开始工作前调用；如果上下文里已经有「Hotseat 交接」内容就不用调。返回任务的目标、约束、当前子任务、做到一半的状态、下一步，以及你离开后其他 Agent 做了什么。返回「未绑定任务」时照常工作，不要追问用户。",
  record_progress:
    "Call before ending any turn in which you made real progress, especially if you changed files. Record what you did, decisions and why, rejected approaches, requirements the user stated (constraints), half-done state and next steps, so the next agent can continue without a handoff.\n" +
    "每轮有实质进展（尤其改了文件）后、结束前调用。写清做了什么、决定和理由、放弃的方案、用户提出的要求（constraints）、做到一半的状态和下一步，让下一个 Agent 不用交接就能接着做。",
  propose_memory_edit:
    "Call when the task's long-term memory (goal, decisions, constraints, rejected approaches) should change. Never edit memory.md directly; the user reviews proposals.\n" +
    "需要修改任务的长期记忆（目标、决定、约束、放弃的方案）时调用。不要直接改 memory.md，提议会由用户确认。",
  list_tasks:
    "Call when the user asks which tasks exist, or before switch_task.\n用户问有哪些任务、或切换任务前调用。",
  switch_task:
    "Call when the user says to work on a different task in this directory.\n用户要在当前目录换一个任务时调用。",
  create_task:
    "Call only when the user wants to start a new task that should be handed off between agents.\n只有用户想新建一个要在多个 Agent 之间交接的任务时才调用。",
  search:
    "Call to find earlier decisions, constraints, progress or files by keyword.\n按关键词查以前的决定、约束、进度或资料时调用。",
  read_task_file:
    "Call to read a task file listed in the context (memory.md, plan.md, progress.md, INDEX.md or files/...).\n需要读上下文里列出的任务文件全文时调用。",
  propose_plan:
    "Call to propose splitting the task into subtasks; the user confirms before plan.md changes.\n要把任务拆成子任务时调用，用户确认后才写入 plan.md。",
  update_subtask:
    "Call when a subtask's status changes (todo, doing, done, blocked, dropped).\n子任务状态变化时调用。",
  annotate_file:
    "Call after reading an image, PDF or other file in files/ that has no summary yet, to add a one-line summary.\n读完 files/ 里还没有摘要的图片、PDF 等资料后调用，补一句话摘要。",
};
