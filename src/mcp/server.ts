// MCP 服务：把 §4 的 11 个工具挂到官方 SDK 上。每次调用都重新打开数据，进程内不缓存。
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { AgentId } from "../contracts/common.ts";
import { HotseatError } from "../contracts/errors.ts";
import { MCP_SERVER_NAME, TOOL_DESCRIPTIONS, TOOL_INPUTS, type ToolName } from "../contracts/tools.ts";
import { rulesText } from "../adapters/shared.ts";
import { Hotseat, type ToolResult, type Where } from "../core/service.ts";
import { hotseatHome, type Env } from "../core/util.ts";
import { VERSION } from "../version.ts";

type Args<N extends ToolName> = z.infer<z.ZodObject<(typeof TOOL_INPUTS)[N]>>;

const READ_ONLY: ReadonlySet<ToolName> = new Set(["get_context", "list_tasks", "search", "read_task_file"]);

export interface McpContext {
  env: Env;
  /** 测试时注入；默认取 MCP 客户端提供的 roots */
  roots?: () => Promise<string[]>;
}

/** 按 §2 第 3 步的顺序列出候选工作目录。 */
export async function cwdCandidates(argCwd: string | undefined, ctx: McpContext): Promise<string[]> {
  const out: (string | undefined)[] = [argCwd, ctx.env.CLAUDE_PROJECT_DIR, ctx.env.CURSOR_PROJECT_DIR];
  try {
    out.push(...((await ctx.roots?.()) ?? []));
  } catch {
    // 客户端不支持 roots
  }
  const own = process.cwd();
  if (own !== "/" && own !== (ctx.env.HOME ?? homedir())) out.push(own);
  return out.filter((x): x is string => !!x);
}

/**
 * 只返回文本，不返回 structuredContent。实测（2026-11-24）Claude Code 在结果里有 structuredContent 时，
 * 只把结构化内容给模型看，交接正文会被丢掉。结构化数据只在进程内用（命令行、测试）。
 */
function asText(text: string, isError = false): CallToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }] };
}

/** 所有工具的处理函数，返回文本和结构化数据；MCP 只用文本，测试校验结构化数据。 */
export async function runTool(name: ToolName, args: Record<string, unknown>, ctx: McpContext): Promise<ToolResult<object>> {
  const agent = AgentId.safeParse(ctx.env.HOTSEAT_AGENT).data ?? "unknown";
  const svc = Hotseat.open({ home: hotseatHome(ctx.env), env: ctx.env });
  try {
    const where: Where = { cwds: await cwdCandidates(args.cwd as string | undefined, ctx), task: args.task as string | undefined };
    const handlers: { [N in ToolName]: (a: Args<N>) => ToolResult<object> | Promise<ToolResult<object>> } = {
      get_context: (a) => svc.getContext(agent, a, where),
      record_progress: (a) => svc.recordProgress(agent, a, where),
      propose_memory_edit: (a) => svc.proposeMemoryEdit(agent, a, where),
      list_tasks: (a) => svc.listTasks(a, where),
      switch_task: (a) => svc.switchTask(a, where),
      create_task: (a) => svc.createTask(agent, a, where),
      search: (a) => svc.search(a, where),
      read_task_file: (a) => svc.readTaskFile(a, where),
      propose_plan: (a) => svc.proposePlan(agent, a, where),
      update_subtask: (a) => svc.updateSubtask(agent, a, where),
      annotate_file: (a) => svc.annotateFile(a, where),
    };
    const handler = handlers[name] as (a: Record<string, unknown>) => ToolResult<object> | Promise<ToolResult<object>>;
    return await handler(args);
  } finally {
    svc.close();
  }
}

export async function callTool(name: ToolName, args: Record<string, unknown>, ctx: McpContext): Promise<CallToolResult> {
  try {
    return asText((await runTool(name, args, ctx)).text);
  } catch (e) {
    const err = e instanceof HotseatError ? e : new HotseatError("INTERNAL", e instanceof Error ? e.message : String(e));
    const hint = err.candidates?.length ? `（${err.candidates.join("、")}）` : "";
    return asText(`${err.code}: ${err.message}${hint}`, true);
  }
}

export function createServer(env: Env): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} }, instructions: rulesText("en", false) + "\n\n" + rulesText("zh", false) },
  );
  const ctx: McpContext = {
    env,
    roots: async () => {
      if (!server.server.getClientCapabilities()?.roots) return [];
      const { roots } = await server.server.listRoots(undefined, { timeout: 1000 });
      return roots.filter((r) => r.uri.startsWith("file://")).map((r) => fileURLToPath(r.uri));
    },
  };
  for (const name of Object.keys(TOOL_INPUTS) as ToolName[]) {
    server.registerTool(
      name,
      {
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: TOOL_INPUTS[name],
        annotations: { readOnlyHint: READ_ONLY.has(name), destructiveHint: false, openWorldHint: false },
      },
      (args: Record<string, unknown>) => callTool(name, args, ctx),
    );
  }
  return server;
}

export async function startMcpServer(env: Env): Promise<void> {
  await createServer(env).connect(new StdioServerTransport());
}
