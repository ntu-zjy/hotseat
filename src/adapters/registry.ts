// 已实现的适配器（PRD §8.4）。Claude、agy 已实测；Codex、Cursor、Qoder CN 按官方文档和本机程序实现，实测前标为实验性。
import type { Adapter } from "../contracts/adapter.ts";
import type { AgentId } from "../contracts/common.ts";
import { agyAdapter } from "./agy.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { cursorAdapter } from "./cursor.ts";
import { qoderCnAdapter } from "./qoder-cn.ts";

export const ADAPTERS: readonly Adapter[] = [claudeAdapter, agyAdapter, codexAdapter, cursorAdapter, qoderCnAdapter];

export function adapterFor(id: AgentId): Adapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
