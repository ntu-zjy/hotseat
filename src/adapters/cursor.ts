// Cursor。PRD §8.1：接入等级 A。
// 依据：Cursor 官方 Hooks 文档（cursor.com/docs/agent/hooks，2026-11-24 核对）。
// 用户级规则只能在 Cursor 设置里填，没有文件可写；会话开始 Hook 注入的交接里已经带了「结束前调用 record_progress」，
// 所以规则这一项改成可选的手动步骤（hotseat rules 打印规则原文）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, AdapterContext, DoctorCheck, PlannedChange } from "../contracts/adapter.ts";
import { OWNERSHIP, hookCommand } from "../contracts/adapter.ts";
import { HOOK_LIMITS } from "../contracts/hooks.ts";
import { normalizeHookInput, renderHookOutput } from "../hooks/normalize.ts";
import { emptyToNull, hasFlatHook, isObj, jsonText, mergeFlatHooks, readJsonFile, setEntry, stripFlatHooks } from "./shared.ts";

const EVENTS = { sessionStart: "session-start", stop: "stop" } as const;

const files = (ctx: AdapterContext) => ({
  dir: join(ctx.home, ".cursor"),
  mcp: join(ctx.home, ".cursor", "mcp.json"),
  hooks: join(ctx.home, ".cursor", "hooks.json"),
});

/** Cursor 的 mcp.json 条目和本机已有的一致，不写 type。 */
const mcpEntry = (bin: string) => ({ command: bin, args: ["mcp"], env: { HOTSEAT_AGENT: "cursor" } });

export const cursorAdapter: Adapter = {
  id: "cursor",
  displayName: "Cursor",
  tier: "A",
  experimental: true,
  hookFamily: "cursor",
  maxContextChars: 9500,
  afterInstall: ["（可选）运行 hotseat rules，把输出粘贴到 Cursor 设置 → Rules → User Rules；Cursor 的用户级规则只能在设置里填"],

  async detect(ctx) {
    const f = files(ctx);
    return { installed: existsSync(f.dir), version: null, configPaths: [f.mcp, f.hooks], notes: [] };
  },

  async planInstall(ctx, opts) {
    const f = files(ctx);
    const out: PlannedChange[] = [];
    if (opts.parts.includes("mcp")) {
      const { text, data } = readJsonFile(f.mcp);
      const entry = mcpEntry(ctx.bin);
      out.push({
        agent: "cursor",
        part: "mcp",
        file: f.mcp,
        kind: "json-merge",
        summary: "添加用户级 MCP 服务 hotseat",
        before: text,
        after: jsonText(setEntry(data, "mcpServers", OWNERSHIP.mcpKey, entry), text),
        preview: JSON.stringify({ mcpServers: { [OWNERSHIP.mcpKey]: entry } }, null, 2),
      });
    }
    if (opts.parts.includes("hooks")) {
      const { text, data } = readJsonFile(f.hooks);
      const timeout = HOOK_LIMITS.configTimeoutSec;
      const commands = Object.fromEntries(Object.entries(EVENTS).map(([e, ev]) => [e, hookCommand(ctx.bin, "cursor", ev)]));
      // loop_limit 1：Cursor 自带的防循环，同一轮最多自动追问一次
      const merged = mergeFlatHooks(data, {
        sessionStart: { command: commands.sessionStart, timeout },
        stop: { command: commands.stop, timeout, loop_limit: 1 },
      });
      out.push({
        agent: "cursor",
        part: "hooks",
        file: f.hooks,
        kind: "json-merge",
        summary: "添加 sessionStart（自动注入上下文）和 stop（收工检查）两个 Hook",
        before: text,
        after: jsonText(merged, text),
        preview: Object.entries(commands).map(([e, c]) => `${e}: ${c}`).join("\n"),
      });
    }
    return out.filter((c) => c.before !== c.after);
  },

  async planUninstall(ctx) {
    const f = files(ctx);
    const out: PlannedChange[] = [];
    const mcp = readJsonFile(f.mcp);
    if (isObj(mcp.data.mcpServers) && OWNERSHIP.mcpKey in mcp.data.mcpServers) {
      out.push({ agent: "cursor", part: "mcp", file: f.mcp, kind: "json-merge", summary: "移除 MCP 服务 hotseat", before: mcp.text, after: jsonText(setEntry(mcp.data, "mcpServers", OWNERSHIP.mcpKey, undefined), mcp.text) });
    }
    const hooks = readJsonFile(f.hooks);
    const stripped = stripFlatHooks(hooks.data);
    if (JSON.stringify(stripped) !== JSON.stringify(hooks.data)) {
      const kept = emptyToNull(stripped, ["version"]);
      out.push({ agent: "cursor", part: "hooks", file: f.hooks, kind: "json-merge", summary: "移除 Hotseat 的 Hook", before: hooks.text, after: kept ? jsonText(kept, hooks.text) : null });
    }
    return out;
  },

  async doctor(ctx) {
    const f = files(ctx);
    const fix = "hotseat init --only cursor";
    const checks: DoctorCheck[] = [];
    const entry = (() => {
      try {
        const servers = readJsonFile(f.mcp).data.mcpServers;
        return isObj(servers) && isObj(servers[OWNERSHIP.mcpKey]) ? (servers[OWNERSHIP.mcpKey] as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    })();
    checks.push(
      !entry
        ? { agent: "cursor", part: "mcp", ok: false, message: `${f.mcp} 里没有 hotseat MCP 服务`, fix }
        : entry.command !== ctx.bin
          ? { agent: "cursor", part: "mcp", ok: false, message: `MCP 服务指向 ${String(entry.command)}，不是 ${ctx.bin}`, fix }
          : { agent: "cursor", part: "mcp", ok: true, message: "MCP 服务已配置" },
    );
    let hooks: Record<string, unknown> = {};
    try {
      hooks = readJsonFile(f.hooks).data;
    } catch (e) {
      checks.push({ agent: "cursor", part: "hooks", ok: false, message: (e as Error).message });
    }
    if (Object.keys(hooks).length > 0 && hooks.version !== 1) {
      checks.push({ agent: "cursor", part: "hooks", ok: false, message: `${f.hooks} 缺少 "version": 1，Cursor 可能不认`, fix });
    }
    for (const event of Object.keys(EVENTS)) {
      checks.push(
        hasFlatHook(hooks, event)
          ? { agent: "cursor", part: "hooks", ok: true, message: `${event} Hook 已配置` }
          : { agent: "cursor", part: "hooks", ok: false, message: `${f.hooks} 里没有 ${event} Hook`, fix },
      );
    }
    return checks;
  },

  parseHookInput: (event, raw, env) => normalizeHookInput("cursor", event, raw, env),
  renderHookOutput: (decision) => renderHookOutput("cursor", decision),
};
