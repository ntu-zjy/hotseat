// 第二批适配器（2026-11-24）：先按官方文档、本机程序实现，实测前一律标为实验性。
// 依据见每个工具上方的注释；PRD §8.1 的调研表是起点，🟡 的地方以这里注释为准，实测后再改。
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, AdapterContext } from "../contracts/adapter.ts";
import { mcpServerEntry } from "../contracts/adapter.ts";
import type { AgentId } from "../contracts/common.ts";
import { HOOK_LIMITS } from "../contracts/hooks.ts";
import { editorUserDirs, homeJoin, makeAdapter, pickFiles } from "./generic.ts";

/** 不带 type 字段的 mcpServers 条目（有些工具的配置校验不认 type） */
const plainEntry = (bin: string, agent: AgentId) => ({ command: bin, args: ["mcp"], env: { HOTSEAT_AGENT: agent } });

// ---------- 国内：会话开始自动注入 + 收工检查 ----------

// WorkBuddy（腾讯，基于 CodeBuddy 引擎）：~/.workbuddy/mcp.json、settings.json 里 Claude Code 风格的 Hook、CODEBUDDY.md。
const workbuddy = makeAdapter({
  id: "workbuddy",
  displayName: "WorkBuddy",
  tier: "A",
  hookFamily: "claude",
  maxContextChars: 9500,
  detect: (c) => [join(c.home, ".workbuddy")],
  mcp: { kind: "json", file: homeJoin(".workbuddy", "mcp.json"), key: "mcpServers", entry: mcpServerEntry },
  rules: { kind: "block", file: homeJoin(".workbuddy", "CODEBUDDY.md") },
  hooks: { kind: "json", file: homeJoin(".workbuddy", "settings.json"), events: { SessionStart: "session-start", Stop: "stop" } },
});

// CodeBuddy Code（腾讯 CLI / IDE）：~/.codebuddy/.mcp.json、~/.codebuddy/settings.json（Claude Code 风格）、~/.codebuddy/CODEBUDDY.md。
const codebuddy = makeAdapter({
  id: "codebuddy",
  displayName: "CodeBuddy",
  tier: "A",
  hookFamily: "claude",
  maxContextChars: 9500,
  detect: (c) => [join(c.home, ".codebuddy")],
  mcp: { kind: "json", file: homeJoin(".codebuddy", ".mcp.json"), key: "mcpServers", entry: mcpServerEntry },
  rules: { kind: "block", file: homeJoin(".codebuddy", "CODEBUDDY.md") },
  hooks: { kind: "json", file: homeJoin(".codebuddy", "settings.json"), events: { SessionStart: "session-start", Stop: "stop" } },
});

// Qoder（海外版 CLI / 桌面 App）：和 Qoder CN 同一套运行时，目录是 ~/.qoder。
const qoderDir = (c: AdapterContext) => c.env.QODER_CONFIG_DIR ?? join(c.home, ".qoder");
const qoder = makeAdapter({
  id: "qoder",
  displayName: "Qoder",
  tier: "A",
  hookFamily: "claude",
  maxContextChars: 9500,
  detect: (c) => [qoderDir(c)],
  mcp: { kind: "json", file: (c) => join(qoderDir(c), "settings.json"), key: "mcpServers", entry: mcpServerEntry },
  rules: { kind: "block", file: (c) => join(qoderDir(c), "AGENTS.md") },
  hooks: { kind: "json", file: (c) => join(qoderDir(c), "settings.json"), events: { SessionStart: "session-start", Stop: "stop" } },
});

// Kimi Code CLI（月之暗面，本机 0.30 程序核对）：~/.kimi-code（可用 KIMI_CODE_HOME 改）。
// MCP 在 mcp.json 的 mcpServers；全局规则 AGENTS.md；Hook 写在 config.toml 的 [[hooks]]（字段只能有 event、matcher、command、timeout）。
// SessionStart 的输出会被丢掉，所以在第一条消息（UserPromptSubmit）时注入交接；Stop 拦截一次让它补记录。
const kimiDir = (c: AdapterContext) => c.env.KIMI_CODE_HOME ?? join(c.home, ".kimi-code");
const kimi = makeAdapter({
  id: "kimi",
  displayName: "Kimi Code",
  tier: "A",
  hookFamily: "kimi",
  maxContextChars: 9500,
  detect: (c) => [kimiDir(c)],
  afterInstall: ["Kimi Code 里输入 /reload 或重开会话，让新的 MCP 和 Hook 生效"],
  mcp: { kind: "json", file: (c) => join(kimiDir(c), "mcp.json"), key: "mcpServers", entry: plainEntry },
  rules: { kind: "block", file: (c) => join(kimiDir(c), "AGENTS.md") },
  hooks: { kind: "toml", file: (c) => join(kimiDir(c), "config.toml"), events: { UserPromptSubmit: "prompt", Stop: "stop" } },
});

// ---------- 国内 IDE ----------

// 通义灵码（插件）/ Qoder CN IDE：Hook 在 ~/.lingma/settings.json（Claude 风格，事件有 UserPromptSubmit、Stop，没有 SessionStart）；
// MCP 只能在界面里添加，用户级规则只能在设置里填。
const lingma = makeAdapter({
  id: "lingma",
  displayName: "通义灵码",
  tier: "B",
  hookFamily: "claude",
  maxContextChars: 9500,
  detect: (c) => [join(c.home, ".lingma")],
  mcp: { kind: "manual", where: "通义灵码 → 个人设置 → MCP 服务 → 手动添加" },
  rules: { kind: "manual", where: "通义灵码 → 个人设置 → 规则" },
  hooks: { kind: "json", file: homeJoin(".lingma", "settings.json"), events: { UserPromptSubmit: "prompt", Stop: "stop" } },
});

// Trae（海外版）/ Trae CN（字节跳动）：全局 MCP 只能在界面里添加，用户规则在设置里填；Hook 在设置界面配置，磁盘位置未公开，暂不写入。
const trae = (id: "trae" | "trae-cn", name: string, dir: string) =>
  makeAdapter({
    id,
    displayName: name,
    tier: "C",
    hookFamily: null,
    maxContextChars: 8000,
    detect: (c) => [join(c.home, dir)],
    mcp: { kind: "manual", where: `${name} → 设置 → MCP → 添加 → 手动配置` },
    rules: { kind: "manual", where: `${name} → 设置 → 规则 → 个人规则` },
  });

// ---------- 海外 ----------

// Gemini CLI（Google）：~/.gemini/settings.json 里的 mcpServers 和 hooks（结构同 Claude Code，timeout 单位是毫秒）；
// SessionStart 用 hookSpecificOutput.additionalContext 注入；每轮结束的事件叫 AfterAgent，decision 为 deny 时 reason 作为新提示。
// 全局上下文文件 ~/.gemini/GEMINI.md。~/.gemini 也是 Antigravity 的目录，只按 Gemini CLI 自己的文件判断是否安装。
const gemini = makeAdapter({
  id: "gemini",
  displayName: "Gemini CLI",
  tier: "A",
  hookFamily: "gemini",
  maxContextChars: 9500,
  detect: (c) => ["settings.json", "oauth_creds.json", "google_accounts.json", "tmp"].map((f) => join(c.home, ".gemini", f)),
  afterInstall: ["Gemini CLI 里输入 /hooks，确认 Hotseat 的 SessionStart、AfterAgent 两个 Hook 已启用"],
  mcp: { kind: "json", file: homeJoin(".gemini", "settings.json"), key: "mcpServers", entry: plainEntry },
  rules: { kind: "block", file: homeJoin(".gemini", "GEMINI.md") },
  hooks: {
    kind: "json",
    file: homeJoin(".gemini", "settings.json"),
    events: { SessionStart: "session-start", AfterAgent: "stop" },
    extra: { SessionStart: { timeout: HOOK_LIMITS.configTimeoutSec * 1000 }, AfterAgent: { timeout: HOOK_LIMITS.configTimeoutSec * 1000 } },
  },
});

// GitHub Copilot CLI / 桌面 App / VS Code：~/.copilot/mcp-config.json（type 为 local，tools 默认全开），
// 用户级指令 ~/.copilot/copilot-instructions.md。VS Code 的 Copilot 现在也读这两个位置（Copilot harness，
// 见 code.visualstudio.com/docs/agents/reference/custom-instructions-reference）。Hook 还在预览，暂不写入。
const copilot = makeAdapter({
  id: "copilot",
  displayName: "GitHub Copilot",
  tier: "C",
  hookFamily: null,
  maxContextChars: 8000,
  detect: (c) => [join(c.home, ".copilot")],
  notes: ["Copilot CLI、桌面 App 和 VS Code 里的 Copilot 共用这份配置"],
  mcp: { kind: "json", file: homeJoin(".copilot", "mcp-config.json"), key: "mcpServers", entry: (bin, agent) => ({ type: "local", command: bin, args: ["mcp"], env: { HOTSEAT_AGENT: agent }, tools: ["*"] }) },
  rules: { kind: "block", file: homeJoin(".copilot", "copilot-instructions.md") },
});

// Windsurf：~/.codeium/windsurf/mcp_config.json，全局规则 ~/.codeium/windsurf/memories/global_rules.md。
const windsurf = makeAdapter({
  id: "windsurf",
  displayName: "Windsurf",
  tier: "C",
  hookFamily: null,
  maxContextChars: 8000,
  detect: (c) => [join(c.home, ".codeium", "windsurf")],
  mcp: { kind: "json", file: homeJoin(".codeium", "windsurf", "mcp_config.json"), key: "mcpServers", entry: plainEntry },
  rules: { kind: "block", file: homeJoin(".codeium", "windsurf", "memories", "global_rules.md") },
});

// Kiro（AWS）：~/.kiro/settings/mcp.json，全局 steering 文件 ~/.kiro/steering/hotseat.md（Hotseat 自己的文件）。
const kiro = makeAdapter({
  id: "kiro",
  displayName: "Kiro",
  tier: "C",
  hookFamily: null,
  maxContextChars: 8000,
  detect: (c) => [join(c.home, ".kiro")],
  mcp: { kind: "json", file: homeJoin(".kiro", "settings", "mcp.json"), key: "mcpServers", entry: plainEntry },
  rules: { kind: "block", file: homeJoin(".kiro", "steering", "hotseat.md") },
});

// OpenCode：~/.config/opencode/opencode.json 的 mcp（type local，command 是数组，环境变量键名是 environment），
// 全局规则 ~/.config/opencode/AGENTS.md。
const opencode = makeAdapter({
  id: "opencode",
  displayName: "OpenCode",
  tier: "C",
  hookFamily: null,
  maxContextChars: 8000,
  detect: (c) => [join(c.home, ".config", "opencode")],
  mcp: { kind: "json", file: homeJoin(".config", "opencode", "opencode.json"), key: "mcp", entry: (bin, agent) => ({ type: "local", command: [bin, "mcp"], environment: { HOTSEAT_AGENT: agent }, enabled: true }) },
  rules: { kind: "block", file: homeJoin(".config", "opencode", "AGENTS.md") },
});

// ---------- 第三批（2026-11-25） ----------

// Qwen Code（阿里通义，基于 Gemini CLI）：~/.qwen/settings.json 的 mcpServers 和 hooks（Claude Code 格式：
// SessionStart 的 additionalContext 注入，Stop 用 decision: block + reason，有 stop_hook_active，timeout 单位秒）；
// 用户级 Hook 不需要信任确认。全局上下文文件 ~/.qwen/QWEN.md。依据 qwenlm.github.io/qwen-code-docs（hooks、settings）。
const qwen = makeAdapter({
  id: "qwen",
  displayName: "Qwen Code",
  tier: "A",
  hookFamily: "claude",
  maxContextChars: 9500,
  detect: (c) => [join(c.home, ".qwen")],
  mcp: { kind: "json", file: homeJoin(".qwen", "settings.json"), key: "mcpServers", entry: plainEntry },
  rules: { kind: "block", file: homeJoin(".qwen", "QWEN.md") },
  hooks: { kind: "json", file: homeJoin(".qwen", "settings.json"), events: { SessionStart: "session-start", Stop: "stop" } },
});

// iFlow CLI（心流）：~/.iflow/settings.json 的 mcpServers，全局上下文 ~/.iflow/IFLOW.md（platform.iflow.cn 文档）。
// 它的 Stop 只在整个会话结束时触发、文档没说会话开始 Hook 的输出会不会进上下文，所以暂不写 Hook，靠规则接手。
const iflow = makeAdapter({
  id: "iflow",
  displayName: "iFlow CLI",
  tier: "C",
  hookFamily: null,
  maxContextChars: 8000,
  detect: (c) => [join(c.home, ".iflow")],
  mcp: { kind: "json", file: homeJoin(".iflow", "settings.json"), key: "mcpServers", entry: plainEntry },
  rules: { kind: "block", file: homeJoin(".iflow", "IFLOW.md") },
});

// Cline（CLI 和 VS Code / Cursor / Windsurf 扩展）：MCP 在 cline_mcp_settings.json 的 mcpServers——
// CLI 是 ~/.cline/data/settings/（可用 CLINE_MCP_SETTINGS_PATH 改），扩展在编辑器的 globalStorage/saoudrizwan.claude-dev/settings/；
// 全局规则目录 ~/.cline/rules/（docs.cline.bot：customization/cline-rules、mcp/mcp-overview）。
// Cline 的 Hook 现在要写成 SDK 插件（JS），暂不做。
const clineMcpFiles = (c: AdapterContext) => [
  c.env.CLINE_MCP_SETTINGS_PATH ?? join(c.home, ".cline", "data", "settings", "cline_mcp_settings.json"),
  ...editorUserDirs(c).map((d) => join(d, "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")),
];
const cline = makeAdapter({
  id: "cline",
  displayName: "Cline",
  tier: "C",
  hookFamily: null,
  maxContextChars: 8000,
  detect: (c) => [join(c.home, ".cline"), ...editorUserDirs(c).map((d) => join(d, "globalStorage", "saoudrizwan.claude-dev"))],
  mcp: { kind: "json", file: clineMcpFiles, key: "mcpServers", entry: (bin, agent) => ({ ...plainEntry(bin, agent), disabled: false }) },
  rules: { kind: "block", file: homeJoin(".cline", "rules", "hotseat.md") },
});

// Kilo Code（v7.0.33 起，扩展和 CLI 共用 ~/.config/kilo/kilo.jsonc，格式同 OpenCode）：MCP 在 mcp 键下；
// 全局规则是 instructions 数组里列出的文件（kilo.ai/docs：automate/mcp、customize/custom-rules）。
// 带注释的 jsonc 不自动改，init 给出要粘贴的片段。
const kiloConfig = (c: AdapterContext) => pickFiles([join(c.home, ".config", "kilo", "kilo.jsonc"), join(c.home, ".config", "kilo", "kilo.json")]).find((p) => existsSync(p)) ?? join(c.home, ".config", "kilo", "kilo.jsonc");
const kilo = makeAdapter({
  id: "kilo",
  displayName: "Kilo Code",
  tier: "C",
  hookFamily: null,
  maxContextChars: 8000,
  detect: (c) => [join(c.home, ".config", "kilo"), join(c.home, ".kilocode")],
  mcp: { kind: "json", file: kiloConfig, key: "mcp", entry: (bin, agent) => ({ type: "local", command: [bin, "mcp"], environment: { HOTSEAT_AGENT: agent }, enabled: true }) },
  rules: { kind: "listed", file: homeJoin(".config", "kilo", "hotseat-rules.md"), config: kiloConfig, key: "instructions" },
});

export const MORE_ADAPTERS: readonly Adapter[] = [
  workbuddy,
  codebuddy,
  kimi,
  qoder,
  lingma,
  trae("trae-cn", "Trae CN", ".trae-cn"),
  trae("trae", "Trae", ".trae"),
  gemini,
  copilot,
  windsurf,
  kiro,
  opencode,
  qwen,
  iflow,
  cline,
  kilo,
];
