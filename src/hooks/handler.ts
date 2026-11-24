// Hook 处理程序：hotseat hook <agent> <event>。出任何错都放行（§5.1）。
import { statSync, renameSync } from "node:fs";
import { AgentId } from "../contracts/common.ts";
import { AGENT_HOOK_FAMILY, HOOK_LIMITS, HookEvent, type HookDecision, type HookOutput } from "../contracts/hooks.ts";
import { adapterFor } from "../adapters/registry.ts";
import { Hotseat } from "../core/service.ts";
import { appendLineSync, homePath, hotseatHome, type Env } from "../core/util.ts";
import { normalizeHookInput, renderHookOutput } from "./normalize.ts";

const DEFAULT_MAX_CHARS = 8000;

function log(env: Env, line: string): void {
  try {
    const path = homePath(hotseatHome(env), "hookLog");
    try {
      if (statSync(path).size > 1_000_000) renameSync(path, `${path}.1`);
    } catch {
      // 日志还不存在
    }
    appendLineSync(path, `${new Date().toISOString()} ${line}`);
  } catch {
    // 日志也写不了就算了，绝不影响 Agent
  }
}

export async function runHook(agentArg: string, eventArg: string, stdin: string, env: Env): Promise<HookOutput> {
  const agent = AgentId.safeParse(agentArg).data;
  const event = HookEvent.safeParse(eventArg).data;
  if (!agent || !event || !AGENT_HOOK_FAMILY[agent]) {
    log(env, `unsupported hook: ${agentArg} ${eventArg}`);
    return { stdout: "", exitCode: 0 };
  }
  const failOpen: HookDecision = event === "stop" ? { event, action: "allow" } : { event, context: null };

  const work = async (): Promise<HookDecision> => {
    const raw: unknown = stdin.trim() ? JSON.parse(stdin) : {};
    const input = normalizeHookInput(agent, event, raw, env);
    const svc = Hotseat.open({ home: hotseatHome(env), env });
    try {
      if (event === "session-start") {
        const context = await svc.sessionStart(input, adapterFor(agent)?.maxContextChars ?? DEFAULT_MAX_CHARS);
        return { event, context };
      }
      const r = await svc.stopCheck(input);
      return r.action === "block" ? { event, action: "block", message: r.message } : { event, action: "allow" };
    } finally {
      svc.close();
    }
  };

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((res) => {
    timer = setTimeout(() => res("timeout"), HOOK_LIMITS.internalBudgetMs);
    timer.unref();
  });
  try {
    const result = await Promise.race([work(), timeout]);
    if (result === "timeout") {
      log(env, `${agent} ${event}: timeout after ${HOOK_LIMITS.internalBudgetMs}ms`);
      return renderHookOutput(agent, failOpen);
    }
    return renderHookOutput(agent, result);
  } catch (e) {
    log(env, `${agent} ${event}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return renderHookOutput(agent, failOpen);
  } finally {
    clearTimeout(timer);
  }
}
