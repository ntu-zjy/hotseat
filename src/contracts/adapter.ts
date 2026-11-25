// 适配器接口：每个工具实现一份。见 docs/interfaces.md §6。
import type { AgentId, InstallPart, Lang } from "./common.ts";
import type { HookDecision, HookEvent, HookFamily, HookInput, HookOutput } from "./hooks.ts";

export type Tier = "A" | "B" | "C";

/** 中英两份给用户看的文字，按 AdapterContext.lang 取。 */
export type Text = Readonly<Record<Lang, string>>;

export interface AdapterContext {
  /** 用户主目录 */
  home: string;
  /** 数据根目录，默认 ~/Hotseat */
  hotseatHome: string;
  /** 固定安装的启动脚本的绝对路径 */
  bin: string;
  lang: Lang;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
}

export interface Detection {
  installed: boolean;
  version: string | null;
  /** 找到的、会被修改的配置文件 */
  configPaths: string[];
  /** 给用户看的说明，例如「需要先在设置里打开 Enable Project MCP」 */
  notes: string[];
}

export interface InstallOptions {
  parts: InstallPart[];
  /** 额外写入项目级 AGENTS.md 的目录；null 表示只写全局（PRD §8.3） */
  projectRulesDir: string | null;
}

export type ChangeKind = "json-merge" | "toml-merge" | "marked-block" | "manual";

export interface PlannedChange {
  agent: AgentId;
  part: InstallPart;
  file: string;
  kind: ChangeKind;
  /** 一句话说明，init 时展示给用户 */
  summary: string;
  /** 改之前的全文；文件不存在为 null */
  before: string | null;
  /** 改之后的全文；删除文件为 null；kind 为 manual 时为 null */
  after: string | null;
  /** kind 为 manual 时给用户的操作步骤 */
  manualSteps?: string[];
  /** init 时展示的片段：只显示 Hotseat 写入的部分，不显示整个文件 */
  preview?: string;
}

export interface DoctorCheck {
  agent: AgentId;
  part: InstallPart | "trust" | "runtime";
  ok: boolean;
  message: string;
  /** 修复命令或操作 */
  fix?: string;
}

export interface Adapter {
  id: AgentId;
  displayName: string;
  /** 英文界面用的名字；不填就用 displayName */
  displayNameEn?: string;
  tier: Tier;
  /** 未实测的标为 true，init 时提示「实验性」 */
  experimental: boolean;
  hookFamily: HookFamily | null;
  /** 会话开始注入的字符上限 */
  maxContextChars: number;
  /** 写入配置后还要用户自己做的事，init 结束时列在「下一步」里 */
  afterInstall?: Text[];

  detect(ctx: AdapterContext): Promise<Detection>;
  /** 只算出改动，不写盘；备份和写入由公共代码统一做 */
  planInstall(ctx: AdapterContext, opts: InstallOptions): Promise<PlannedChange[]>;
  planUninstall(ctx: AdapterContext): Promise<PlannedChange[]>;
  doctor(ctx: AdapterContext): Promise<DoctorCheck[]>;
  parseHookInput(event: HookEvent, raw: unknown, env: Readonly<Record<string, string | undefined>>): HookInput;
  renderHookOutput(decision: HookDecision): HookOutput;
}

// ---------- 怎么认出 Hotseat 写入的内容 ----------

export const OWNERSHIP = {
  mcpKey: "hotseat",
  rulesBegin: "<!-- hotseat:begin -->",
  rulesEnd: "<!-- hotseat:end -->",
  agyHookGroup: "hotseat",
} as const;

/** 路径里有空格等特殊字符时加单引号。 */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\/.:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

export function hookCommand(bin: string, agent: AgentId, event: HookEvent): string {
  return `${shellQuote(bin)} hook ${agent} ${event}`;
}

/** 认出任何位置安装的 Hotseat Hook 命令（数据目录可能被 HOTSEAT_HOME 改过）。 */
export function isHotseatHookCommand(command: string): boolean {
  return /\.hotseat\/bin\/hotseat'? hook /.test(command);
}

/** mcpServers 风格的配置条目（Claude、Cursor、agy、Qoder 等）。 */
export function mcpServerEntry(bin: string, agent: AgentId) {
  return { type: "stdio", command: bin, args: ["mcp"], env: { HOTSEAT_AGENT: agent } } as const;
}
