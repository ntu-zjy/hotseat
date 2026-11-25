# Hotseat V1 接口文档

> **状态**：已定稿（2026-11-24），第 2–5 天开发中按实现细化过，改动处与代码一致。对应 PRD 的 §5（数据）、§7（MCP 工具）、§8（各工具接入）和 §9（架构）。
> **唯一来源**：代码里的 `src/contracts/` 是接口的唯一来源。本文和代码不一致时，以代码为准，并同步改本文。
> **可信度标注**沿用 PRD：🟢 本机核对 · 🔵 官方文档 · 🟡 第三方资料或推断，需实测。

本文定三样东西：**事件和存储格式**（§1–§3）、**MCP 工具的输入输出**（§4）、**Hook 的统一输入输出和各工具的映射**（§5）。§6 是适配器接口，§7–§9 是错误码、版本规则和待实测项。

---

## 0. 通用约定

| 项目 | 约定 |
|---|---|
| 编码 | UTF-8，换行用 LF |
| 时间 | ISO 8601，带本地时区偏移，例如 `2026-11-23T14:02:11+08:00` |
| 结构版本 | 每个 JSON 对象和每条事件都带 `"v": 1`。读到更高版本时只读不写，并提示用户升级 |
| 路径 | `task.yaml` 中的项目路径存绝对路径（先做 `realpath`）。事件中的 `files` 存相对于项目根目录的路径，不在任何项目目录下的才存绝对路径。`~` 只用于展示 |
| 任务编号（slug） | `[a-z0-9][a-z0-9-]{1,47}`。名称能转成英文短横线格式且长度 ≥ 3 就用它，否则用 `task-<yymmdd>-<n>` |
| 事件编号 | `e_000001` 起，每个任务内部递增。至少 6 位数字，超出后自动变长 |
| 提议编号 | `p_0001` 起，每个任务内部递增 |
| 子任务编号 | `T1`、`T2` …… |
| 数据根目录 | 默认 `~/Hotseat/`。设置环境变量 `HOTSEAT_HOME` 可以改（用于测试） |

### 0.1 Agent 身份（`HOTSEAT_AGENT` 的取值）

| 取值 | 对应工具 |
|---|---|
| `claude` | Claude Code CLI，以及 Claude 桌面 App 的 Code 标签页（共用 `~/.claude`） |
| `claude-desktop` | Claude 桌面 App 的普通聊天和 Cowork |
| `codex` | Codex CLI / App |
| `cursor` | Cursor |
| `agy` | Antigravity（IDE、App、CLI 共用配置） |
| `trae` / `trae-cn` | Trae 海外版 / 国内版 |
| `workbuddy` / `codebuddy` | WorkBuddy / CodeBuddy Code |
| `qoder` / `qoder-cn` | Qoder 海外版 / Qoder CN |
| `lingma` | 通义灵码插件、Qoder CN IDE |
| `copilot` / `kiro` / `windsurf` | P2，先只接 MCP |
| `human` | 人通过 `hotseat` 命令行操作（如 `review`） |
| `unknown` | 没有设置 `HOTSEAT_AGENT` 时使用 |

---

## 1. 存储格式

### 1.1 目录

```text
~/Hotseat/
├── .hotseat/
│   ├── bin/hotseat          # 固定安装的启动脚本（见 §1.11）
│   ├── lib/                 # 程序本体
│   ├── config.json          # 全局设置和已接入的工具（§1.2）
│   ├── index.db             # SQLite：状态表 + 检索缓存（§1.10）
│   ├── backups/<时间>/       # init / uninstall 修改配置前的备份，保持原路径结构
│   └── logs/hook.log        # Hook 出错时写这里（Hook 一律放行，见 §5.1）
└── tasks/<slug>/
    ├── task.yaml            # §1.3
    ├── memory.md            # §1.4，人做主
    ├── plan.md              # §1.5
    ├── events.jsonl         # §1.6，只追加
    ├── progress.md          # §1.8，自动生成
    ├── INDEX.md             # §1.9
    ├── .pending/            # §1.7，等人确认的提议
    │   └── archive/         # 已处理的提议
    ├── .lock                # 写锁（§1.12）
    └── files/               # 任务资料
```

### 1.2 `config.json`

```json
{
  "v": 1,
  "lang": "zh",
  "secretScan": true,
  "updateCheck": true,
  "agents": {
    "claude": { "enabled": true, "stopCheck": true, "installedAt": "2026-11-24T10:00:00+08:00", "parts": ["mcp", "rules", "hooks"] },
    "agy":    { "enabled": true, "stopCheck": true, "installedAt": "2026-11-24T10:00:00+08:00", "parts": ["mcp", "rules", "hooks"] }
  }
}
```

- `lang`：`zh` 或 `en`，决定规则片段、上下文包标题、收工检查提示用哪种语言。`init` 时按环境变量 `LC_ALL` / `LC_MESSAGES` / `LANG` 取默认值，可以用 `--lang zh` 指定。
- `agents.<id>.stopCheck`：按工具关闭收工检查（PRD F4）。
- `agents.<id>.parts`：这个工具实际接入了哪几部分，`doctor` 和 `uninstall` 按它检查。
- `pack`（可选）：`{ "defaultBudget": 5000, "maxBudget": 8000 }`，上下文包的默认预算和上限（§3.3），只在想改的时候才写，可以只写其中一项。
- `init` / `uninstall` 只改 `lang` 和 `agents`，其他字段原样写回；缺省值不写进文件，这样以后改缺省值，已经装过的人也能用上。

### 1.3 `task.yaml`

```yaml
v: 1
slug: auth-refresh
name: 登录态刷新
status: active          # active | paused | done | archived
created: 2026-11-23T10:00:00+08:00
paths:
  - /Users/me/code/webapp
```

- 只有 `active` 和 `paused` 的任务参与「按目录找任务」（§2）。
- 人可以直接改这个文件，程序每次都重新读取，不缓存。

### 1.4 `memory.md`（人做主）

固定五个二级标题，中英文都能识别：

| 节 | 中文标题 | 英文标题 | 程序内名称 |
|---|---|---|---|
| 目标 | `## 目标` | `## Goal` | `goal` |
| 关键决定 | `## 关键决定` | `## Decisions` | `decisions` |
| 约束 | `## 约束` | `## Constraints` | `constraints` |
| 放弃过的方案 | `## 放弃过的方案` | `## Rejected` | `rejected` |
| 备注 | `## 备注` | `## Notes` | `notes` |

```markdown
# 登录态刷新

## 目标
- 登录过期后自动刷新，用户无感知

## 关键决定
- 刷新放在拦截器里 —— 避免每个请求各自处理 〔e_000192〕

## 约束
- 不要改动 /api/v1 的返回格式 〔e_000192〕

## 放弃过的方案
- 定时器提前刷新 —— 多标签页会重复刷新 〔e_000192〕

## 备注
```

- 每个条目是一个顶层 `- ` 列表项；缩进的续行属于同一条目。
- 决定和放弃的方案写成 `内容 —— 理由`。
- 由提议转正的条目，末尾带来源事件编号 `〔e_000192〕`（PRD F6）。
- 出现其他二级标题时原样保留，在上下文包里归到「其他」，优先级最低。
- Agent 不能直接写这个文件，只能提议（§4.3）。

### 1.5 `plan.md`

一行一个子任务，人能直接改，程序也能解析：

```markdown
# 计划 · 登录态刷新

- [x] T1 梳理现有登录流程 · files: src/auth/** · 验收: 画出时序图
- [x] T2 加刷新接口封装 · deps: T1 · files: src/api/auth.ts
- [~] T3 实现 token 刷新 · deps: T2 · files: src/auth/** · 验收: 过期后自动刷新且单测通过
  - 2026-11-23 codex：拦截器已完成，差错误提示
- [ ] T4 登录页错误提示 · deps: T3 · files: src/pages/login/**
```

**语法**：`- [<状态>] <编号> <标题>[ · <键>: <值>]*`

| 状态符号 | 含义 | 程序内名称 |
|---|---|---|
| `[ ]` | 未开始 | `todo` |
| `[~]` | 进行中 | `doing` |
| `[x]` | 完成 | `done` |
| `[!]` | 卡住 | `blocked` |
| `[-]` | 不做了 | `dropped` |

- 解析时也接受人手写的 `* ` 列表和大写 `[X]`；程序写回时统一用 `- ` 和小写 `x`。
- 键：`deps`（逗号分隔的编号）、`files`（逗号分隔的路径或 glob）、`验收` / `accept`。不认识的键原样保留。
- 子任务下方缩进的列表项是备注，由 `update_subtask` 追加，格式为 `<日期> <agent>：<内容>`。
- 「当前子任务」的判定：第一个 `doing`；没有 `doing` 时，取第一个依赖全部完成的 `todo`。

### 1.6 `events.jsonl`（只追加）

每行一条事件，所有事件都有以下公共字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `v` | `1` | 结构版本 |
| `id` | string | `e_000193` |
| `seq` | int | 和编号里的数字一致，用于「已读位置」比较 |
| `time` | string | 写入时间 |
| `agent` | AgentId | 来自 MCP 进程的 `HOTSEAT_AGENT`，人操作时为 `human` |
| `session` | string \| null | 会话编号，尽量填（见下） |
| `kind` | string | 事件类型，见下表 |

| `kind` | 由谁写 | 额外字段 |
|---|---|---|
| `progress` | `record_progress` | `summary`（必填）、`subtask?`、`decisions?`、`rejected?`、`constraints?`、`state?`、`next?`、`files?` |
| `subtask` | `update_subtask`，或 `record_progress` 带了 `subtask_status` | `subtask`、`from`、`to`、`note?` |
| `memory_applied` | `hotseat review` 接受提议 | `proposal`、`edits`（实际生效的修改） |
| `plan_applied` | `hotseat review` 接受计划 | `proposal`、`mode`（`replace` / `append`）、`count` |
| `task_created` | `create_task` / `hotseat new` | `name`、`paths` |

`progress` 示例（对 PRD §5.2 的补充：加了 `v`、`seq`、`kind`，`decisions` 和 `rejected` 可带 `lasting`）：

```json
{"v":1,"id":"e_000192","seq":192,"time":"2026-11-23T14:02:11+08:00","agent":"codex","session":"019a6f3e-7f3a","kind":"progress","subtask":"T3","summary":"实现了 token 刷新，单测通过","decisions":[{"what":"刷新放在拦截器里","why":"避免每个请求各自处理","lasting":true}],"rejected":[{"what":"定时器提前刷新","why":"多标签页会重复刷新","lasting":true}],"constraints":["不要改动 /api/v1 的返回格式"],"state":"登录页的错误提示还没接上","next":["接错误提示","补集成测试"],"files":["src/auth/interceptor.ts"]}
```

**`session` 怎么填**：MCP 协议不提供会话编号，Claude Code 也不会把会话编号传给 MCP 服务（🔵）。所以由会话开始 Hook 在 `sessions` 表（§1.10）登记「哪个工具、哪个任务、哪个会话」，`record_progress` 取同一工具、同一任务、12 小时内最近开始的会话编号；取不到就写 `null`。V1 不做并发，这个近似足够。

**长度上限**（超出返回 `INVALID_INPUT`）：`summary` ≤ 500 字符；`what` / `why` ≤ 300；`state` ≤ 500；`constraints`、`next` 各 ≤ 10 条、每条 ≤ 300；`files` ≤ 50 条。

### 1.7 `.pending/` 提议

一个提议一个文件：`.pending/p_0012.json`。处理后改 `status` 并移到 `.pending/archive/`。

```json
{
  "v": 1,
  "id": "p_0012",
  "kind": "memory",
  "status": "pending",
  "created": "2026-11-23T14:02:11+08:00",
  "agent": "codex",
  "session": null,
  "source_event": "e_000192",
  "reason": "来自 e_000192 的约束和长期决定",
  "base_memory_hash": "sha256:9f2c…",
  "edits": [
    { "op": "add", "section": "constraints", "text": "不要改动 /api/v1 的返回格式" },
    { "op": "replace", "section": "decisions", "old": "刷新放在页面里", "text": "刷新放在拦截器里 —— 避免每个请求各自处理" }
  ]
}
```

- `kind`：`memory`（修改 memory.md）或 `plan`（计划，见 §4.9）。
- `status`：`pending` → `accepted` / `rejected` / `stale`。
- `edits[].op`：`add`（追加一条）、`remove`（删掉 `old`）、`replace`（把 `old` 换成 `text`）。
- **作废规则**（细化 PRD F7「人类编辑优先」）：人直接改过 memory.md 后，`remove` / `replace` 的 `old` 如果已经找不到，这一项作废；`add` 的内容如果已经存在，这一项跳过。一个提议里所有项都作废时，整个提议标为 `stale`。`base_memory_hash` 只用来提示「这条提议基于旧版本」，不直接作废。
- **自动提议**（PRD §5.2）：`record_progress` 里的 `constraints` 一律提议写入「约束」；`decisions` / `rejected` 只有 `lasting: true` 的才提议。memory.md 或其他待确认提议里已有的相同文本跳过（比较前去掉首尾空白和来源标记）。一次 `record_progress` 最多生成一个提议。

### 1.8 `progress.md`（自动生成）

每次写事件、改计划后整份重新生成（写临时文件再改名）。人改了也会被覆盖，文件开头有说明。

```markdown
<!-- 由 Hotseat 根据 events.jsonl 和 plan.md 自动生成，请勿手动修改 -->
# 进度 · 登录态刷新

## 子任务
- [x] T1 梳理现有登录流程
- [~] T3 实现 token 刷新
- [ ] T4 登录页错误提示

## 时间线（新的在上）
- 实现了 token 刷新，单测通过 · T3 〔codex · 11-23 14:02 · e_000192〕
  - 决定：刷新放在拦截器里（避免每个请求各自处理）
  - 放弃：定时器提前刷新（多标签页会重复刷新）
  - 约束：不要改动 /api/v1 的返回格式
  - 半截：登录页的错误提示还没接上
  - 下一步：接错误提示；补集成测试
  - 文件：src/auth/interceptor.ts
```

### 1.9 `INDEX.md`

```markdown
# 资料索引 · 登录态刷新
- files/api-spec.md — 后端给的刷新接口说明
- files/screenshot-01.png — （待补摘要）
```

- 每行 `- files/<相对路径> — <一句话摘要>`。纯文本和 Markdown 取第一个非空段落的前 80 个字符。
- 图片和 PDF 写「（待补摘要）」，由 Agent 读完后调用 `annotate_file` 补写（§4.11）。

### 1.10 `index.db`（SQLite）

用 Node 内置的 `node:sqlite`，开 WAL 模式，`busy_timeout = 2000`。表分两类：

- **状态表**：丢了没法从文件重建，但丢了也只是降级（Agent 被当成第一次进入，拿完整上下文包）。
- **缓存表**：可以用 `hotseat reindex` 从文件重建。

```sql
-- 状态表
CREATE TABLE watermarks (           -- 已读位置：每个「工具 × 任务」一行（PRD §5.3）
  agent TEXT NOT NULL, task TEXT NOT NULL,
  seq INTEGER NOT NULL,             -- 已读到的最后一条事件
  memory_hash TEXT, memory_snapshot TEXT,   -- 用来算「你离开后 memory.md 改了什么」
  plan_hash TEXT, plan_snapshot TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent, task)
);
CREATE TABLE sessions (             -- Hook 登记的会话，用于收工检查和填 session 字段
  agent TEXT NOT NULL, session_id TEXT NOT NULL,
  task TEXT, cwd TEXT,
  started_at TEXT NOT NULL,
  window_start TEXT NOT NULL,       -- 本轮开始时间
  dirty_snapshot TEXT NOT NULL DEFAULT '{}',  -- 本轮开始时未提交的文件 {路径: 修改时间毫秒，已删除为 -1}
  blocks INTEGER NOT NULL DEFAULT 0, last_block_at TEXT,
  PRIMARY KEY (agent, session_id)
);
CREATE TABLE path_active (          -- 一个目录绑了多个任务时，当前用哪个（switch_task 设置）
  path TEXT PRIMARY KEY, task TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- 缓存表
CREATE TABLE task_activity (task TEXT PRIMARY KEY, last_active TEXT, last_agent TEXT, last_seq INTEGER);
CREATE VIRTUAL TABLE docs USING fts5(
  task UNINDEXED, kind UNINDEXED, ref UNINDEXED, time UNINDEXED, agent UNINDEXED,
  text, tokenize = 'trigram'
);
```

**中文检索**（2026-11-24 在 Node 24.16 / SQLite 3.53.1 上实测 🟢）：trigram 分词下，3 个字及以上的词用 `MATCH` 能搜到；**1–2 个字的词（如「登录」）用 `MATCH` 搜不到**，必须改用 `text LIKE '%登录%'`。数据量很小，全表扫描没有问题。

### 1.11 固定安装的启动脚本

`~/Hotseat/.hotseat/bin/hotseat` 是一个 shell 脚本，安装时把当前 Node 的绝对路径写死进去，避免用户切换 nvm 版本后失效：

```sh
#!/bin/sh
exec "/Users/me/.nvm/versions/node/v24.16.0/bin/node" --no-warnings "$HOME/Hotseat/.hotseat/lib/cli.js" "$@"
```

`--no-warnings` 避免 Node 的实验性警告混进 Hook 的输出。Windows 版（`hotseat.cmd`）V1 暂不做。

### 1.12 写入规则

- **加锁**：写 `events.jsonl`、`.pending/`、`plan.md` 前，先用独占方式创建 `tasks/<slug>/.lock`，内容是进程号和时间。拿不到时每 50ms 重试一次，最多等 2 秒，超时返回 `LOCK_TIMEOUT`。锁文件超过 10 秒还在，视为残留，直接清除。
- **追加事件**：拿锁 → 读最后一行得到 `seq` → 追加一行并 `fsync` → 放锁 → 重新生成 `progress.md` → 更新缓存表。
- **改 Markdown**：写临时文件再改名。改之前比对内容哈希，不一致说明人刚改过，重新读一遍再改。
- **读**：不加锁。读 `events.jsonl` 时，丢弃最后一行不完整的 JSON。

### 1.13 出处与 `hotseat blame`（PRD F6）

```text
hotseat blame <关键词…> [--task <slug>] [--all]
```

- **只读**：不改任何文件，也不更新已读位置。任务按当前目录判断，或用 `--task` 指定。
- **匹配**：关键词按空白拆开，每个词都要出现；不区分大小写和全角半角。
- **查两处**：
  1. **memory.md 的条目**（所有标题下的，匹配时去掉来源标记）。每条列出：
     - **写入**：来源标记 `〔e_…〕` 指向的事件，给出 Agent、时间、编号、会话前 8 位；
     - **提议**：没有来源标记、但由 review 生效的条目（来自 `propose_memory_edit`），从 `.pending/archive/` 里的提议找到是谁提的；
     - **确认**：让它生效的那条 `memory_applied` 事件和提议编号；
     - **最早出现**：既没有来源标记、也不是 review 生效的条目，在事件记录里找最早写过同样内容的 `progress` 事件；还找不到就标「没有来源标记：可能是直接编辑 memory.md 写的」。
  2. **事件记录**：`progress` 的各字段、子任务状态变化、`memory_applied` 里的增删改、新建任务。按事件分组，新的在前，默认最多 20 条，`--all` 看全部。上面 memory 部分已经说明过的（同一事件、同一内容）不再重复。
- **退出码**：找到返回 0，找不到返回 1。

```text
「并发」在 hotseat-v1 里的出处：

memory.md · 约束
  V1 只做串行交接，并发放到 V1.5
    写入  claude · 11-24 09:42 · e_000002
    确认  human · 11-24 12:43 · e_000006 · hotseat review 接受 p_0001
```

---

## 2. 按目录找任务

MCP 工具和 Hook 共用同一套规则：

1. 参数里明确给了 `task`（slug）→ 用它。
2. 环境变量 `HOTSEAT_TASK` → 用它。
3. 确定工作目录：
   - MCP：参数 `cwd` → 环境变量 `CLAUDE_PROJECT_DIR`（Claude Code 会传给 MCP 服务 🔵）、`CURSOR_PROJECT_DIR`（🟡）→ MCP 客户端提供的 roots → MCP 进程自己的 `cwd`（是用户主目录或 `/` 时不用）。
   - Hook：统一输入里的 `cwd` 和 `roots`（§5.2）。
4. 在 `active` / `paused` 的任务里，找 `paths` 中等于工作目录、或者是工作目录上级的路径，**最长的匹配优先**。
5. 同一个路径绑了多个任务时：先看 `path_active`，再看 `task_activity.last_active`，取最近的。
6. 都找不到 → 返回「未绑定任务」，附最近活跃的 5 个任务作为候选。

---

## 3. 上下文包

### 3.1 什么时候生成

| 触发 | 内容 |
|---|---|
| 会话开始 Hook，`source` 为 `startup` / `clear` / `fork` / 未知 | 完整包 |
| 会话开始 Hook，`source` 为 `compact` | 完整包（压缩后上下文丢了，要补回来） |
| 会话开始 Hook，`source` 为 `resume` | 只有「你离开后」部分，没有新变化就什么都不注入。这个工具从没进过这个任务（没有已读位置）时，给完整包（2026-11-24 实测发现：恢复的会话原先什么都拿不到） |
| `get_context` | 完整包 |
| 目录没有绑定任务 | 会话开始 Hook 什么都不注入，不打扰无关项目 |

每次生成完整包后，都更新这个「工具 × 任务」的已读位置（`watermarks`）。

### 3.2 包的结构

Markdown 文本，标题固定，方便 Agent 和人阅读：

```markdown
# Hotseat 交接 · 登录态刷新（auth-refresh）
> 你是 agy。上次记录：codex · 11-23 14:02。这份内容已经自动注入，不需要再调用 get_context；本轮结束前调用 record_progress。

## 你离开后（3 条新记录）
- 实现了 token 刷新，单测通过；改了 src/auth/interceptor.ts 〔codex · 11-23 14:02〕
- memory.md：新增约束「不要改动 /api/v1 的返回格式」
- plan.md：T3 进行中 → 完成

## 目标
- 登录过期后自动刷新，用户无感知

## 约束（必须遵守）
- 不要改动 /api/v1 的返回格式 〔codex · 11-23 14:02〕

## 当前子任务
- T4 登录页错误提示 · files: src/pages/login/**

## 做到一半 / 下一步
- 半截：登录页的错误提示还没接上 〔codex · 11-23 14:02〕
- 下一步：接错误提示；补集成测试

## 关键决定
- 刷新放在拦截器里 —— 避免每个请求各自处理

## 放弃过的方案
- 定时器提前刷新 —— 多标签页会重复刷新

## 最近进度
- 实现了 token 刷新，单测通过 〔codex · 11-23 14:02〕
- 梳理了现有登录流程 〔claude · 11-23 10:15〕

## 资料（需要时用 read_task_file 读全文）
- files/api-spec.md — 后端给的刷新接口说明

> 待确认提议 2 条，请用户运行 hotseat review。
```

- **「你离开后」**：这个工具第一次进入这个任务时没有这一节。之后列出已读位置之后**其他工具**写的事件，最多 10 条（新的在前，其余写「另有 N 条，见 progress.md」）；再加上 memory.md 按条目比较的增删，以及 plan.md 子任务的增删和状态变化。
  - 新增超过 3 条时只给计数，例如「memory.md：新增决定 6 条、约束 5 条」「plan.md：新增 8 个子任务（T1、T2…）」：新增的内容在下面各节里都看得到，逐条列出只会把预算吃光（2026-11-24 实测：一次 review 接受 13 条 memory 和 8 个子任务后，逐条列出把关键决定整节挤掉了）。
  - 删除和状态变化在别处看不到，逐条列出；超过 3 条时列前 3 条，再写「另删除 N 条」「另有 N 个子任务改了状态」。
- **来源标记**：memory.md 里存的是来源编号 `〔e_000192〕`，放进包里时换成那条事件的 `〔Agent · 时间〕`，和事件里来的条目写法一致；事件记录里找不到这个编号时原样保留。
- **「做到一半 / 下一步」**：取最新一条 `progress` 事件的 `state` 和 `next`。最新一条没写的话，取最近写过的那条，并带上出处，让 Agent 自己判断是否过时。
- 调用 `get_context` 时，开头那句提示改成「本轮结束前调用 record_progress」，不说「已经自动注入」。

### 3.3 按场景排序和截断（PRD F8）

输出顺序是：标题 →「你离开后」→ 目标 → 约束 → 其余各节。「目标」和「约束」永远不截断；如果光这几部分就超过预算，照样输出，并加一句「memory.md 过长，建议精简」。「你离开后」和其余各节按场景排序，超预算时分两遍处理：

1. **压缩**：从末尾开始逐节压缩，每压缩一节就重新估算，够了就停。压缩后不比原来短的节跳过。各节的压缩方式：
   - 「你离开后」：留前 3 条记录和前 3 处变化，其余写「另有 N 条」；
   - 关键决定、放弃过的方案：条目都留着（最多 15 条），让 Agent 至少知道有这条决定；
   - 最近进度：留前 3 条；
   - 以上每行截到约 50 token，加「…」，末尾的出处标记保留；「做到一半 / 下一步」截到约 100 token。2026-11-24 实测：只少列几条、不截短的话，3 条长进度就能把关键决定整节挤掉。
2. **减条数**：还超预算，再从末尾开始逐节减：关键决定、放弃过的方案、最近进度先试只留前几条（从多到少，留下的条目照样截短；关键决定和放弃过的方案末尾写「另有 N 条，需要时用 search 查」），一条都放不下才整节去掉；其他节直接整节去掉。2026-11-24 实测：「你离开后」有 7 条长记录时，压缩后的 15 条关键决定放不进 1500，旧做法会把这一节整节删掉，只用了一半预算。

所以「你离开后」再长也只会先被压缩，不会把关键决定、放弃过的方案挤掉；它排在最前面，最后才会被去掉。

| 场景 | 顺序（目标、约束之后） |
|---|---|
| `code`（默认） | 你离开后 → 当前子任务 → 做到一半/下一步 → 关键决定 → 放弃过的方案 → 最近进度 → 资料 → 其他 |
| `research` | 你离开后 → 资料 → 放弃过的方案 → 关键决定 → 做到一半/下一步 → 最近进度 → 当前子任务 → 其他 |
| `review` | 你离开后 → 关键决定 → 最近进度（带文件）→ 当前子任务（带验收）→ 放弃过的方案 → 做到一半/下一步 → 资料 → 其他 |
| `plan` | 你离开后 → 全部子任务 → 放弃过的方案 → 关键决定 → 最近进度 → 做到一半/下一步 → 资料 → 其他 |

- **预算**：`budget` 默认 5000 token，最大 8000。预算只是上限，交接本身多长就给多长；2026-11-24 用真实任务实测，完整交接约 2300–3300 token，5000 以内不会压缩，任务变大后由下面的字符上限先起作用。最早定的 1500 会让回来的 Agent 看不到关键决定或放弃过的方案，和「交接不丢信息」冲突。
- **估算**：中日韩文字每个字按 1 token，其他字符每 4 个按 1 token，向上取整。不追求精确，只用来控制长度。
- **硬上限**：不管预算多少，包的字符数都不超过所接工具的上限（适配器的 `maxContextChars`，§6）。例如 Claude Code 的会话开始注入上限是 10,000 字符 🔵：超过时 Claude Code 把全文存成文件，只给 Agent 看前 2000 字符的预览，所以 Claude 适配器取 9500。中文约 1.7 个字符算 1 token，9500 字符约 5500 token，预算设得再大也到不了。

---

## 4. MCP 服务

- **服务名**：`hotseat`。
- **启动命令**：`~/Hotseat/.hotseat/bin/hotseat mcp`，通过 stdio 通信，环境变量带 `HOTSEAT_AGENT`。
- **无状态**：每次调用都重新读文件，不在进程内缓存任务数据。原因是有的工具会让多个对话共用一个 MCP 进程，而且人随时可能改文件。
- **返回格式：只返回文本** `content: [{ type: "text", text }]`，**不返回 `structuredContent`**。2026-11-24 实测 🟢：Claude Code 在结果里有 `structuredContent` 时，只把结构化内容给模型看，交接正文被丢掉了。下文各工具的「返回」结构是进程内的数据（命令行和测试用），由 `src/mcp/server.ts` 的 `runTool` 返回，测试按 `TOOL_OUTPUTS` 校验。
- **不声明 `outputSchema`**：工具列表会进每个会话的上下文，少声明一份结构就少占一些 token；既然不返回结构化内容，也就不需要声明。
- **服务说明（instructions）**：MCP 服务的 `instructions` 字段带上中英文规则片段，给没有规则文件的工具兜底。
- **出错**：`isError: true`，文本以错误码开头，写清原因和下一步该怎么做，例如 `SUBTASK_NOT_FOUND: 子任务 T9 不存在（T1、T2）`。错误码见 §7。
- **工具描述**：中英双语，第一句写「什么时候调用」。所有工具的描述原文写在 `src/contracts/tools.ts` 的 `TOOL_DESCRIPTIONS` 里。
- **参数结构不用 `anyOf` / `oneOf`**：不用联合类型，也不用可为 null 的参数。部分模型（如 agy 用的 Gemini）对这类 JSON Schema 支持不好 🟡。需要按情况区分的校验（例如 `propose_memory_edit` 里不同 `op` 的必填字段）放在处理函数里做。有测试专门检查这一条。

各工具共有的两个可选参数：`task`（slug，指定任务）和 `cwd`（Agent 当前的工作目录，用于找任务）。下文不再重复列出。

### 4.1 `get_context` — 只读（并更新已读位置）

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `scene` | `code` \| `research` \| `review` \| `plan` | `code` | §3.3 |
| `budget` | int，200–8000 | 5000 | token 预算 |

**返回**：文本是 §3.2 的上下文包。结构化内容：

```json
{
  "task": { "slug": "auth-refresh", "name": "登录态刷新", "status": "active" },
  "agent": "agy",
  "scene": "code",
  "budget": 5000,
  "estimated_tokens": 1180,
  "truncated": ["files"],
  "first_visit": false,
  "since": { "events": 3, "memory_changed": true, "plan_changed": true },
  "pending_proposals": 2,
  "candidates": []
}
```

**没有绑定任务时不算出错**：`task` 为 `null`，`candidates` 列出最近的任务。文本写：「当前目录没有绑定 Hotseat 任务，照常工作即可，不要追问用户；只有用户想在多个 Agent 之间交接这项工作时，才建议用 create_task 新建。」这样规则片段要求「开始前先调用 get_context」，也不会在无关项目里反复打扰用户。

### 4.2 `record_progress` — 追加写

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `summary` | string ≤ 500 | ✅ | 这一轮做了什么 |
| `decisions` | `{what, why?, lasting?}[]` | | 做了什么决定、为什么。`lasting: true` 表示长期有效，会提议写入 memory |
| `rejected` | `{what, why?, lasting?}[]` | | 放弃的方案和原因 |
| `constraints` | string[] | | 用户提出的要求、不能做的事。一律提议写入 memory |
| `state` | string ≤ 500 | | 做到一半的状态 |
| `next` | string[] | | 下一步 |
| `files` | string[] | | 改过的文件 |
| `subtask` | `T<n>` | | 关联的子任务 |
| `subtask_status` | `todo` \| `doing` \| `done` \| `blocked` \| `dropped` | | 顺便更新子任务状态，省一次 `update_subtask` 调用。需要同时给 `subtask` |

**服务端补的字段**：`v`、`id`、`seq`、`time`、`agent`、`session`、`kind: "progress"`。`files` 按 §0 的规则统一成相对路径。

**副作用**（按顺序）：
1. 密钥检测：所有文本字段匹配常见密钥格式（规则列在 `src/contracts/storage.ts` 的 `SECRET_PATTERNS`），命中的部分替换成 `[REDACTED:<类型>]`，并在返回里给出提醒。**先脱敏再写入**，不会把密钥落盘。
2. 追加事件，重新生成 `progress.md`。
3. 给了 `subtask_status` 时，更新 `plan.md` 并追加一条 `kind: "subtask"` 事件。
4. 按 §1.7 的规则生成自动提议。
5. 更新检索缓存和 `task_activity`。

**返回**：

```json
{ "event_id": "e_000193", "task": "auth-refresh", "proposal_id": "p_0012", "warnings": [] }
```

文本示例：「已记录 e_000193（任务 auth-refresh）。1 条约束已提交，等用户确认（p_0012）。」

**错误**：没有绑定任务 → `NO_TASK`（文本提示：不需要记录，照常结束即可）。子任务不存在、或给了 `subtask_status` 却没给 `subtask` 时**不报错**：照常记录，只在 `warnings` 里提示。记录本身最重要，不能因为次要字段出错就丢掉这一轮的进度。

### 4.3 `propose_memory_edit` — 提议写

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `edits` | `{op, section, text?, old?}[]`，1–20 项 | ✅ | `op`：`add` / `remove` / `replace`；`section`：`goal` / `decisions` / `constraints` / `rejected` / `notes` |
| `reason` | string ≤ 300 | ✅ | 为什么要改 |

- 校验：`add` 必须有 `text`；`remove` 必须有 `old`；`replace` 两者都要有。
- **改动说明**：PRD §7 原来写的是 `patch`（文本补丁）。Agent 很难写出能正确应用的补丁，所以改成按条目的结构化修改。

**返回**：`{ "proposal_id": "p_0013", "stale_edits": [] }`。`stale_edits` 列出提交时 `old` 就已经找不到的项的序号，这些项会被丢弃。

### 4.4 `list_tasks` — 只读

| 参数 | 类型 | 默认 |
|---|---|---|
| `status` | `active` \| `paused` \| `done` \| `archived` \| `all` | 只列 `active` 和 `paused` |

**返回**：

```json
{
  "resolved": "auth-refresh",
  "tasks": [
    { "slug": "auth-refresh", "name": "登录态刷新", "status": "active", "paths": ["/Users/me/code/webapp"],
      "last_active": "2026-11-23T14:02:11+08:00", "last_agent": "codex", "current_subtask": "T4", "pending_proposals": 2 }
  ]
}
```

`resolved` 是按当前目录找到的任务，没找到为 `null`。

### 4.5 `switch_task` — 状态写

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `slug` | string | ✅ | 要切换到的任务 |
| `bind` | boolean | | 任务还没绑定当前目录时，是否顺便绑定，默认 `false` |

- 把当前目录匹配到的绑定路径的 `path_active` 设为这个任务。这个设置对所有工具都生效，例如在 Claude 里切换后，之后打开 agy 也会进入同一个任务。
- 任务没绑定当前目录、并且 `bind` 为 `false` → `NOT_BOUND`。
- **返回**：`{ "task": "auth-refresh", "path": "/Users/me/code/webapp", "bound": false }`。

### 4.6 `create_task` — 状态写

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string ≤ 80 | ✅ | 任务名称 |
| `goal` | string ≤ 500 | | 写入 memory.md 的「目标」。这是唯一一处允许 Agent 直接写 memory.md 的情况，因为文件刚创建 |
| `slug` | string | | 不给就按 §0 的规则生成；已存在时自动加 `-2`、`-3` |
| `path` | string | | 要绑定的项目目录，默认用当前工作目录 |

- 创建任务目录、`task.yaml`、`memory.md`（套用模板）、空的 `events.jsonl`；设置 `path_active`；追加一条 `task_created` 事件。
- **返回**：`{ "slug": "auth-refresh", "path": "/Users/me/code/webapp" }`。

### 4.7 `search` — 只读

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string，1–200 | 必填 | 搜索词，1–2 个字时自动改用 LIKE（§1.10） |
| `scope` | `all` \| `events` \| `memory` \| `plan` \| `files` | `all` | 搜索范围 |
| `all_tasks` | boolean | `false` | 是否跨所有任务搜索 |
| `limit` | int，1–50 | 10 | 最多返回几条 |

**返回**：

```json
{ "results": [
  { "task": "auth-refresh", "kind": "event", "ref": "e_000192", "snippet": "…实现了 token 【刷新】，单测通过…", "time": "2026-11-23T14:02:11+08:00", "agent": "codex" },
  { "task": "auth-refresh", "kind": "memory", "ref": "memory.md#constraints", "snippet": "不要改动 /api/v1 的返回格式" }
] }
```

`ref` 的格式：事件为编号；memory 为 `memory.md#<节>`；计划为 `plan.md#T3`；资料为 `files/<路径>`。资料的 `ref` 可以直接传给 `read_task_file`。

### 4.8 `read_task_file` — 只读

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `path` | string | 必填 | 相对于任务目录的路径，只能是 `memory.md`、`plan.md`、`progress.md`、`INDEX.md` 或 `files/**` |
| `offset` | int ≥ 0 | 0 | 从第几行开始读 |
| `limit` | int，1–2000 | 400 | 读多少行 |

- 路径会先做 `realpath`，跑出任务目录的一律拒绝（`PATH_OUTSIDE_TASK`），防止 `../` 和软链接逃逸。
- 二进制文件不返回内容，只返回文件名、大小和类型（`BINARY_FILE`），让 Agent 用自己的工具打开。
- **返回**：`{ "path": "files/api-spec.md", "total_lines": 120, "offset": 0, "returned_lines": 120, "truncated": false }`，正文放在文本里。

### 4.9 `propose_plan` — 提议写（P1）

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `subtasks` | `{id?, title, deps?, files?, accept?}[]`，1–30 项 | ✅ | 不给 `id` 时按顺序编号 |
| `mode` | `replace` \| `append` | | 默认：没有 plan.md 时为 `replace`，有的话为 `append` |
| `reason` | string ≤ 300 | | 拆分思路 |

写入 `.pending/p_<n>.json`（`kind: "plan"`），人在 `hotseat review` 里确认后才生成或修改 `plan.md`。**返回**：`{ "proposal_id": "p_0014" }`。

### 4.10 `update_subtask` — 状态写（P1）

| 参数 | 类型 | 必填 |
|---|---|---|
| `id` | `T<n>` | ✅ |
| `status` | `todo` \| `doing` \| `done` \| `blocked` \| `dropped` | ✅ |
| `note` | string ≤ 300 | |

只改这一行的状态符号，并在下方追加备注；同时追加一条 `kind: "subtask"` 事件。**返回**：`{ "id": "T3", "from": "doing", "to": "done", "event_id": "e_000194" }`。

### 4.11 `annotate_file` — 写（P1）

| 参数 | 类型 | 必填 |
|---|---|---|
| `path` | `files/` 下的相对路径 | ✅ |
| `summary` | string ≤ 200 | ✅ |

更新 `INDEX.md` 中对应的那一行。**返回**：`{ "path": "files/screenshot-01.png" }`。

---

## 5. Hook

### 5.1 命令行约定

```text
~/Hotseat/.hotseat/bin/hotseat hook <agent> <event>
```

- `<agent>`：§0.1 中的取值。
- `<event>`：`session-start`（会话开始）、`prompt`（每条用户消息提交时）或 `stop`（每轮结束）。`prompt` 给会话开始的 Hook 不能注入上下文的工具用（Kimi Code、通义灵码），见 §5.5。
- **事件名放在命令行参数里**，不依赖各工具在输入里写的事件名。各家字段名不统一（agy 是 `hookEventName` 🟢，Claude 是 `hook_event_name`），有的工具可能不给。
- 标准输入：工具传来的原始 JSON，最多读 1MB。
- 标准输出和退出码：按工具的格式输出（§5.4），**退出码永远是 0**。
- **出错一律放行（fail-open）**：解析失败、任务找不到、数据库被锁住、超过 1.5 秒的内部时间预算，一律不注入、不拦截，错误写进 `logs/hook.log`。Hotseat 出问题，绝不能让用户的 Agent 卡住。
- 各工具配置里的超时统一写 10 秒，作为兜底。

### 5.2 统一输入 `HookInput`

各工具的原始输入先转换成这个格式，后面的逻辑只认它：

| 字段 | 类型 | 说明 |
|---|---|---|
| `v` | `1` | |
| `agent` | AgentId | 来自命令行参数 |
| `event` | `session-start` \| `stop` | 来自命令行参数 |
| `sessionId` | string \| null | 会话编号 |
| `turnId` | string \| null | 本轮编号（Claude 的 `prompt_id`，Codex 的 `turn_id`，Cursor 的 `generation_id`） |
| `cwd` | string \| null | 主工作目录 |
| `roots` | string[] | 所有工作区目录，`cwd` 排第一 |
| `source` | `startup` \| `resume` \| `clear` \| `compact` \| `fork` \| null | 仅会话开始时有，工具没提供则为 `null` |
| `continued` | boolean \| null | 仅每轮结束时有：本轮是不是已经被拦截过、继续过了。工具没提供则为 `null`，此时用本地计数 |
| `stopStatus` | `completed` \| `aborted` \| `error` \| null | 仅每轮结束时有：本轮是正常结束、被用户中断还是出错 |
| `lastAssistantMessage` | string \| null | 只记录，V1 不使用 |
| `transcriptPath` | string \| null | 只记录，V1 不解析对话记录（PRD 决定只做通用接入） |

### 5.3 统一输出 `HookDecision`

```ts
type HookDecision =
  | { event: "session-start"; context: string | null }   // null 表示不注入
  | { event: "stop"; action: "allow" }
  | { event: "stop"; action: "block"; message: string };
```

适配器再把它转成具体工具要求的输出：`renderHookOutput(decision) → { stdout, exitCode: 0 }`。

### 5.4 各工具的映射

工具按 Hook 协议分成三族：

| 族 | 工具 |
|---|---|
| **Claude 族** | `claude`、`codex`、`codebuddy`、`workbuddy`、`qoder`、`qoder-cn`、`trae`、`trae-cn`、`lingma` |
| **Cursor 族** | `cursor`、`copilot`（🟡 Copilot 的 Hook 还在预览，字段待核对） |
| **agy 族** | `agy` |

**输入映射**

| 统一字段 | Claude 族 | Cursor 族 | agy 族 |
|---|---|---|---|
| `sessionId` | `session_id` 🔵 | `session_id`（会话开始时有），否则用 `conversation_id` 🔵 | `conversationId` 🔵 |
| `turnId` | `prompt_id`（Claude）/ `turn_id`（Codex）🔵 | `generation_id` 🔵 | `executionNum`（转成字符串）🟢 |
| `cwd` | `cwd` 🔵；没有时用环境变量 `CLAUDE_PROJECT_DIR` | `workspace_roots[0]`，或环境变量 `CURSOR_PROJECT_DIR` 🔵 | `cwd` 🟢；没有时用 `workspacePaths[0]` |
| `roots` | `[cwd]` | `workspace_roots` | `[cwd, ...workspacePaths]` |
| `source` | `source` 🔵 | `null`（Cursor 不提供） | `null` |
| `continued` | `stop_hook_active` 🔵 | `loop_count > 0` 🔵 | `continuationActive` 🟢；老版本没有这个字段时为 `null`，用本地计数 |
| `stopStatus` | `completed`（这一族只在正常结束时触发 Stop） | `status` 🔵 | 🟢 `terminationReason` 为 `NO_TOOL_CALL` / `TERMINAL_STEP_TYPE` 时为 `completed`；有 `error` 或为 `ERROR` 时为 `error`；`USER_CANCELED`、步数或预算用完等其他取值，以及 `fullyIdle` 为 `false`（后台任务没结束），都为 `aborted`，不拦截 |
| `lastAssistantMessage` | `last_assistant_message` 🔵 | 无 | 无 |
| `transcriptPath` | `transcript_path` | `transcript_path` | `transcriptPath` |

**输出映射**

| 决定 | Claude 族 | Cursor 族 | agy 族 |
|---|---|---|---|
| 会话开始，注入 `context` | `claude` 等：`{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}` 🔵；**`codex` 直接输出纯文本**（官方写明会作为开发者上下文）🔵 | `{"additional_context":"…"}` 🔵 | `{"injectSteps":[{"systemMessage":{"systemMessage":"…"}}]}` 🔵 |
| 会话开始，不注入 | 不输出 | `{}` | `{}` |
| 每轮结束，放行 | 不输出 | `{}` | `{"decision":"stop"}`（官方要求必须输出 JSON 决定）🔵 |
| 每轮结束，拦截 | `{"decision":"block","reason":"…"}` 🔵；`claude` 额外带 `hookSpecificOutput.additionalContext`，内容相同（官方文档说 `reason` 显示给用户，`additionalContext` 是给 Claude 看的）🔵 | `{"followup_message":"…"}`：作为下一条用户消息自动发出 🔵 | `{"decision":"continue","reason":"…"}` 🔵 |

### 5.5 会话开始的处理

1. 转成统一输入，按 §2 找任务。找不到 → 不注入。
2. 在 `sessions` 表登记或更新这个会话：`task`、`cwd`、`started_at`、`window_start = 现在`、`dirty_snapshot = 当前未提交文件的快照`（§5.6）、`blocks = 0`。
3. 按 §3.1 的规则生成上下文包，更新已读位置。
4. 按工具格式输出。

**`prompt` 事件（第一条消息注入）**：有的工具不采用会话开始 Hook 的输出（Kimi Code 0.30 本机程序核对：SessionStart 的结果直接丢弃），或者根本没有会话开始事件（通义灵码）。这时在 UserPromptSubmit 上挂 `hotseat hook <agent> prompt`：`sessions` 表里还没有这个会话 → 按上面 1–4 步注入；已经有了 → 放行、什么都不输出。所以同一个会话只在第一条消息时注入一次。

### 5.6 收工检查的处理（PRD F4）

1. 转成统一输入，按 §2 找任务。找不到 → 放行。
2. `config.agents.<agent>.stopCheck` 为 `false` → 放行。
3. `stopStatus` 不是 `completed`（用户中断或出错）→ 放行，但**不开始新的一轮**，这些改动算进下一轮检查。
4. **防死循环**：`continued` 为 `true` → 放行。`continued` 为 `null` 时用本地计数：这个会话的 `blocks ≥ 1`，并且上次拦截在 10 分钟以内 → 放行。
5. **确定本轮的开始时间**：取 `sessions` 表里这个会话的 `window_start`。表里没有这个会话（例如工具不支持会话开始 Hook，或者会话在安装前就开了）→ 取「这个工具在这个任务里最后一条事件的时间」和「30 分钟前」中较晚的那个。
6. **本轮改过哪些文件**：对任务的每个绑定目录：
   - **有 Git**：运行 `git status --porcelain=v1 -z --untracked-files=all`，得到当前未提交的文件及其修改时间。和本轮开始时的快照比，新出现的、修改时间变了的、本轮被删掉的，都算本轮改过。
   - **没有 Git**：遍历目录，修改时间晚于本轮开始时间的文件算改过。跳过 `node_modules`、`.git`、`dist`、`build`、`.next`、`target`、`.venv`、`__pycache__` 和 `~/Hotseat` 本身。最多看 20,000 个文件或 300 毫秒，超出就当作没有改动（宁可漏拦，也不卡住）。
7. **本轮有没有记录**：这个工具在这个任务里，有没有时间不早于本轮开始时间的 `progress` 事件。事件时间只精确到秒，比较时允许 1 秒误差。
8. **改过文件但没记录 → 拦截**，`blocks + 1`，记下 `last_block_at`。否则放行。
9. **放行时开始新的一轮**：`window_start = 现在`，`dirty_snapshot` 换成当前快照，`blocks = 0`。

**拦截时的提示**（中文版；英文版内容相同）：

> Hotseat：本轮改动了 3 个文件（src/auth/interceptor.ts、src/pages/login/index.tsx 等），但还没有记录进度。请调用 hotseat 的 record_progress 工具，写清做了什么、决定和理由、放弃的方案、用户提出的要求、做到一半的状态和下一步，然后再结束。如果这些改动和当前任务无关，在 summary 里用一句话说明即可。

**已知局限**：人在两轮之间自己改的文件，也会被算进下一轮。V1 接受这个误差：最坏的情况是多拦截一次，而且每轮最多拦截一次。

### 5.7 写入各工具的 Hook 配置

`<bin>` 指 `~/Hotseat/.hotseat/bin/hotseat` 展开后的绝对路径；路径里有空格等特殊字符时加单引号。

**Claude Code**：`~/.claude/settings.json`，合并写入，不动其他内容 🔵

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "<bin> hook claude session-start", "timeout": 10 }] }],
    "Stop":         [{ "hooks": [{ "type": "command", "command": "<bin> hook claude stop", "timeout": 10 }] }]
  }
}
```

**Codex**：`~/.codex/hooks.json`（设了 `CODEX_HOME` 时在那个目录下），结构和 Claude 相同，CLI 和桌面 App 共用 🔵。
- 会话开始那一条另外带 `"additionalContextLimit": 10000`：Codex 默认把每条 Hook 输出限制在约 2500 token，超出的存成文件、只给预览；上下文包默认预算是 5000（§3.3）。JSON 里的字段名就是 `additionalContextLimit` 🔵（官方 hooks.json 示例，本机 Codex 0.167 程序里也有这个字段名 🟢）。
- 会话开始直接输出纯文本，Codex 把它当作开发者上下文；收工检查拦截时 `reason` 会作为下一条用户消息发给 Codex 🔵。
- **新 Hook 要用户信任后才会运行**：在 Codex 里输入 `/hooks` 确认。信任记录按 Hook 定义的哈希存在 `config.toml` 的 `[hooks.state."…"]` 里，Hook 一改就要重新信任 🔵。Hotseat 不替用户写信任记录。`init` 结束时在「下一步」里提示；`doctor` 暂时只能检查 Hook 写进去了，看不出有没有被信任（🟡 信任记录的键名要实测后才能检查）。
- MCP 写进 `config.toml`：在文件末尾追加一张 `[mcp_servers.hotseat]` 表（§6），不解析、不重排用户的其他内容。

**Cursor**：`~/.cursor/hooks.json` 🔵

**Cursor**：`~/.cursor/hooks.json` 🔵

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "<bin> hook cursor session-start", "timeout": 10 }],
    "stop":         [{ "command": "<bin> hook cursor stop", "timeout": 10, "loop_limit": 1 }]
  }
}
```

`loop_limit: 1` 是 Cursor 自带的防循环设置：最多自动追问一次（默认是 5）。Cursor 会自动重读 hooks.json，不用重启 🔵。

- MCP 条目写进 `~/.cursor/mcp.json`，不带 `type` 字段（和本机已有条目的格式一致 🟢）。
- Cursor 的用户级规则只能在设置里填，没有文件可写 🔵。规则这一项改成可选的手动步骤：`hotseat rules` 打印规则原文，粘贴到「Cursor 设置 → Rules → User Rules」。不粘贴也能用：会话开始 Hook 注入的交接里已经写了「本轮结束前调用 record_progress」，收工检查也会提醒。

**Qoder CN**：`~/.qoder-cn/settings.json`（设了 `QODERCN_CONFIG_DIR` 时在那个目录下），桌面 App 和 CLI 共用这个目录 🟢。依据是本机 Qoder CN 0.2.5 自带的 Agent 运行时（2026-11-24 核对）：
- 用户级 MCP 服务写在同一个 settings.json 的 `mcpServers` 里，Hook 写在 `hooks` 里，格式和 Claude Code 相同（`SessionStart` / `Stop` 下套 `{ "hooks": [...] }`）🟢；
- 输入输出也和 Claude Code 一致：会话开始读 `hookSpecificOutput.additionalContext`，Stop 输入带 `stop_hook_active`，Hook 命令能拿到 `QODER_PROJECT_DIR` 和 `CLAUDE_PROJECT_DIR` 🟢；
- 会话开始的输出超过 10,000 字符会存成文件（和 Claude Code 一样），所以适配器取 9500 🟢；
- 全局规则文件是 `~/.qoder-cn/AGENTS.md` 🟢🔵。
- MCP 和 Hook 在同一个文件里，`planInstall` 给出两处改动，第二处接着第一处的结果算；写入时按顺序检查，备份只留第一次的原文。

**agy**：`~/.gemini/config/hooks.json`，用一个名为 `hotseat` 的 Hook 组，卸载时整组删除 🔵

```json
{
  "hotseat": {
    "SessionStart": [{ "type": "command", "command": "<bin> hook agy session-start", "timeout": 10 }],
    "Stop":         [{ "type": "command", "command": "<bin> hook agy stop", "timeout": 10 }]
  }
}
```

🟢 **SessionStart、PreInvocation、PostInvocation、Stop 是扁平的处理程序列表**，只有 PreToolUse、PostToolUse 要套 `{ "matcher", "hooks" }`。依据是 agy 程序内嵌的 Hooks 文档（`/Applications/Antigravity.app/Contents/Resources/bin/language_server` 里的「Lifecycle Hooks」一节）。2026-11-24 第一次接入时写成了嵌套格式，agy 日志 `~/Library/Logs/Antigravity/language_server.log` 报 `command hook must specify 'command'`，并且**跳过了整个 hooks.json**。所以 `doctor` 会按这个规则检查文件里的所有 Hook 组，并查看 agy 日志里有没有解析失败。agy 每发一条消息都会重读 hooks.json，改完不用重启。

agy 的规则片段单独写成 `~/.gemini/config/rules/hotseat.md`，MCP 条目不带 `type` 字段（和本机已有条目的格式一致 🟢）。

**第二批工具**（2026-11-24，`src/adapters/more.ts`，由 `src/adapters/generic.ts` 按描述生成，全部标为实验性）：

| 工具 | MCP | 规则 | Hook | 输出格式 |
|---|---|---|---|---|
| WorkBuddy | `~/.workbuddy/mcp.json` | `~/.workbuddy/CODEBUDDY.md` | `~/.workbuddy/settings.json`：SessionStart、Stop | Claude |
| CodeBuddy Code | `~/.codebuddy/.mcp.json` | `~/.codebuddy/CODEBUDDY.md` | `~/.codebuddy/settings.json`：SessionStart、Stop | Claude |
| Qoder（海外版） | `~/.qoder/settings.json`（`QODER_CONFIG_DIR`） | `~/.qoder/AGENTS.md` | 同 settings.json：SessionStart、Stop | Claude |
| Kimi Code | `~/.kimi-code/mcp.json`（`KIMI_CODE_HOME`），条目不带 `type` | `~/.kimi-code/AGENTS.md` | `config.toml` 末尾的 `# hotseat:begin … # hotseat:end` 标记块，里面是 `[[hooks]]`：UserPromptSubmit → `prompt`、Stop | 注入 `{"message": …}`；拦截 `{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": …}}`，每轮最多一次 |
| Gemini CLI | `~/.gemini/settings.json`，条目不带 `type` | `~/.gemini/GEMINI.md` | 同 settings.json：SessionStart、AfterAgent，`timeout` 单位毫秒 | 注入同 Claude；拦截 `{"decision": "deny", "reason": …}` |
| 通义灵码 | 只能在界面添加（`init` 打印要粘贴的 JSON） | 只能在设置里填（`hotseat rules`） | `~/.lingma/settings.json`：UserPromptSubmit → `prompt`、Stop | Claude（UserPromptSubmit 的 `additionalContext`） |
| Trae / Trae CN | 只能在界面添加 | 只能在设置里填 | 暂不写（只能在设置界面配置） | — |
| GitHub Copilot（CLI、App） | `~/.copilot/mcp-config.json`（`type: "local"`、`tools: ["*"]`） | `~/.copilot/copilot-instructions.md` | 暂不写（预览版） | — |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `~/.codeium/windsurf/memories/global_rules.md` | — | — |
| Kiro | `~/.kiro/settings/mcp.json` | `~/.kiro/steering/hotseat.md` | — | — |
| OpenCode | `~/.config/opencode/opencode.json` 的 `mcp`（`type: "local"`、`command` 是数组、`environment`） | `~/.config/opencode/AGENTS.md` | — | — |
| Qwen Code（第三批） | `~/.qwen/settings.json`，条目不带 `type` | `~/.qwen/QWEN.md` | 同 settings.json：SessionStart、Stop（timeout 单位秒，用户级不需要信任确认） | Claude |
| iFlow CLI | `~/.iflow/settings.json` | `~/.iflow/IFLOW.md` | 暂不写（Stop 只在整个会话结束时触发） | — |
| Cline | CLI：`~/.cline/data/settings/cline_mcp_settings.json`（`CLINE_MCP_SETTINGS_PATH`）；扩展：各编辑器 `User/globalStorage/saoudrizwan.claude-dev/settings/` 下的同名文件，目录存在的都写 | `~/.cline/rules/hotseat.md` | 暂不写（要写成 SDK 插件） | — |
| Kilo Code | `~/.config/kilo/kilo.jsonc`（或 `kilo.json`）的 `mcp`，格式同 OpenCode；带注释时改为手动 | `~/.config/kilo/hotseat-rules.md`，并把路径加进 `instructions` 数组 | — | — |

GitHub Copilot 的 `~/.copilot` 现在也是 VS Code 里 Copilot 的配置位置（Copilot harness），所以 VS Code 不单独做适配器。Roo Code 已于 2026-05-15 停止服务，不做。

**卸载时的空对象**：原文件里本来就是空对象的键（例如 Cline 默认的 `"mcpServers": {}`），去掉 Hotseat 的条目后保留；判断依据是 Hotseat 第一次修改这个文件前留下的最早一份备份。

检测只看用户主目录下各工具自己的目录。`~/.gemini` 也是 Antigravity 的目录，所以 Gemini CLI 只按 `settings.json`、`oauth_creds.json`、`google_accounts.json`、`tmp/` 判断。卸载时，Hotseat 新建的文件去掉自己的内容后为空就删除，原有文件逐字节还原。

Codex、Cursor、Qoder CN 在真实工具里实测前，适配器的 `experimental` 也是 `true`，`init` 时显示「实验性」。

---

## 6. 适配器接口

每个工具一个适配器，定义在 `src/contracts/adapter.ts`。新增一个工具，只需要实现这个接口：

```ts
interface Adapter {
  id: AgentId;
  displayName: string;
  tier: "A" | "B" | "C";              // PRD §8.1 的接入等级
  experimental: boolean;              // 未实测的标为 true，init 时提示
  hookFamily: "claude" | "cursor" | "agy" | null;
  maxContextChars: number;            // 会话开始注入的字符上限
  afterInstall?: string[];            // 写入后还要用户自己做的事（如 Codex 的 /hooks 信任），列在 init 的「下一步」里

  detect(ctx): Promise<Detection>;                     // 是否安装、配置文件在哪
  planInstall(ctx, opts): Promise<PlannedChange[]>;    // 只算出改动，不写盘
  planUninstall(ctx): Promise<PlannedChange[]>;
  doctor(ctx): Promise<DoctorCheck[]>;
  parseHookInput(event, raw, env): HookInput;          // §5.4 输入映射
  renderHookOutput(decision): HookOutput;              // §5.4 输出映射
}
```

- **先算后写**：`planInstall` 返回每个文件改动前后的全文和一句话说明。`init` 把这些改动展示给用户，确认后由公共代码统一备份、写入（PRD F1）。适配器自己不写盘，这样展示、备份、还原的逻辑只有一份。
- **改动方式**：`json-merge`（合并 JSON）、`toml-merge`（TOML，用于 Codex：只按行识别表头，把 `[mcp_servers.hotseat]` 整张表追加到文件末尾、和原内容之间空一行；已有这张表（含子表）就整段替换；卸载时整段删掉，连同追加时加的空行，保证逐字节还原）、`marked-block`（规则文件里的标记片段）、`manual`（只能在界面里设置的，给出操作步骤）。
- **怎么认出 Hotseat 写入的内容**，用于幂等写入和卸载：
  - MCP：各配置里键名为 `hotseat` 的条目；
  - 规则：`<!-- hotseat:begin -->` 和 `<!-- hotseat:end -->` 之间的内容；
  - Hook：命令里含 `.hotseat/bin/hotseat hook ` 的条目（不管装在哪个目录都能认出）；agy 是名为 `hotseat` 的 Hook 组。
- **改 JSON 时保持原样**：沿用原文件的缩进和末尾换行，卸载后逐字节还原（有测试覆盖）。`PlannedChange.preview` 只展示 Hotseat 写入的片段，`init` 时不把整个文件打出来。
- **MCP 配置条目**：

  ```json
  "hotseat": { "type": "stdio", "command": "<bin>", "args": ["mcp"], "env": { "HOTSEAT_AGENT": "cursor" } }
  ```

  Codex 用 TOML：

  ```toml
  [mcp_servers.hotseat]
  command = "<bin>"
  args = ["mcp"]
  env = { HOTSEAT_AGENT = "codex" }
  ```

  VS Code 用 `servers` 键，其余同上。

---

## 7. 错误码

| 代码 | 什么时候出现 | 给 Agent 的提示 |
|---|---|---|
| `NO_TASK` | 需要任务的写操作（如 `record_progress`），但当前目录没有绑定任务 | 不需要记录，照常结束 |
| `TASK_NOT_FOUND` | 指定的 slug 不存在 | 附候选任务 |
| `NOT_BOUND` | `switch_task` 的任务没有绑定当前目录 | 改用 `bind: true`，或先问用户 |
| `SUBTASK_NOT_FOUND` | 子任务编号不存在 | 附现有子任务列表 |
| `NO_PLAN` | 任务还没有 plan.md，却调用了 `update_subtask` | 先用 `propose_plan` |
| `INVALID_INPUT` | 参数不符合格式或超出长度 | 写明哪个字段、什么问题 |
| `PATH_OUTSIDE_TASK` | `read_task_file` / `annotate_file` 的路径跑出了任务目录 | |
| `FILE_NOT_FOUND` | 文件不存在 | |
| `BINARY_FILE` | 读取的是二进制文件 | 用自己的工具打开 |
| `LOCK_TIMEOUT` | 2 秒内没拿到写锁 | 稍后重试一次 |
| `SCHEMA_TOO_NEW` | 数据是更高版本的 Hotseat 写的 | 请用户运行 `hotseat update` |
| `INTERNAL` | 其他内部错误 | 写进日志 |

---

## 8. 版本与兼容

- 所有结构都带 `v`。V1 期间只做**加字段**的改动，不改名、不删字段，旧数据不需要迁移。
- 读到不认识的字段：不报错。会改写的文件（`config.json`、`task.yaml`、提议）原样保留这些字段；事件只追加、从不改写，读取时忽略即可，文件里仍然保留。Markdown 中不认识的键和标题同样保留。
- 必须做不兼容改动时，`v` 加 1，并提供 `hotseat migrate`。
- **Node 版本要求改为 22.13 及以上**（PRD §4 原写 20 及以上，已同步修改）。原因：`node:sqlite` 从 22.13 起不再需要加启动参数；而且 Node 20 已在 2026 年 4 月停止维护。这样就不需要 better-sqlite3 这类需要编译的原生依赖。Node 22 自带的 SQLite 是否支持 trigram，要在 CI 里确认；本机实测的是 Node 24.16。

---

## 9. 待实测项（影响接口的部分）

开发第 2–5 天自用时顺带确认。结果写回本文，并把对应的 🟡 改成 🟢：

- [x] Claude 桌面 App 的 Code 标签页：会话开始 Hook 的 `additionalContext` 能注入 🟢（2026-11-24，压缩上下文后会话开头自动拿到交接；全新会话走同一段代码）。Stop Hook 会触发 🟢。MCP 只返回文本后，模型看到的是正文 🟢。
- [x] agy：扁平格式下，会话开始的 `injectSteps` 能注入 🟢；Stop 返回 `continue` 时 `reason` 能被 Agent 看到 🟢（2026-11-24，agy 复述了 `reason` 里列出的文件并补记了进度，之后正常放行）。Hook 组的格式、输入字段（含 `cwd`、`continuationActive`）、`terminationReason` 的取值也已确认 🟢。
- [x] agy：MCP 和规则兜底可用 🟢（2026-11-24，只说「继续」，agy 就自己调用了 `get_context`）。
- [x] Codex：`hooks.json` 里能写 `additionalContextLimit` 🔵（官方示例就是 JSON；本机 Codex 0.167 程序里有这个字段名 🟢）。
- [ ] Codex：在真实的 Codex 里信任 Hook 后，会话开始能注入、收工检查能拦截；信任记录在 `config.toml` 里的键名（用来让 `doctor` 检查有没有信任）。
- [ ] Cursor：会话开始的 `additional_context` 能注入、`followup_message` 能让 Agent 补记录。
- [ ] Qoder CN：桌面 App 里会话开始能注入、收工检查能拦截。
- [ ] Cursor：MCP 服务进程能不能拿到 `CURSOR_PROJECT_DIR`。
- [ ] 各工具启动 MCP 服务时的工作目录是什么（决定 §2 第 3 步的兜底是否可靠）。
