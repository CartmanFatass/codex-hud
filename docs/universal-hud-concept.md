# 通用 Agent HUD：概念方案与目标（v2.2，2026-11-01）

状态：v2.2，与[工程计划书](./universal-hud-engineering-plan.md)一起送 ChatGPT Pro 第三轮评审。

- v2 吸收 Astra Max 的评审（[reviews/2026-11-01-astra-universal-hud-concept.md](./reviews/2026-11-01-astra-universal-hud-concept.md)，十项全部采纳）和三项决定：委派走统一 MCP、Jev 浏览器自动化作为外包后端、Jev 任务路由列为后续 feature。
- v2.1 加三项决定：Herdr 集成做成独立层、委派同时支持可见与 headless 两种模式、支持 resume。
- v2.2 吸收 ChatGPT Pro 的评审（[reviews/2026-11-01-chatgpt-pro-universal-hud-v21.md](./reviews/2026-11-01-chatgpt-pro-universal-hud-v21.md)）：五个返工项与八个抉择点全部采纳。核心变化：绑定握手取代"linkId 共现即身份"；账本改为 SQLite 事务存储；关系、运行、报告分开建模；每次运行有独立的托管进程；Jev 按浏览器实例加锁；P0 契约进阶段 A。

调研底稿见 [universal-hud-plan.md](./universal-hud-plan.md)。决策汇总在 §15，第三轮评审关注点在 §16。

## 0. 一句话

两个组件。**hud-mcp** 是 cc / Codex / pi 三个 harness 共用的委派入口：起子代理、等、问、报，并把每一次委派写成一条显式关系、每一次运行交给一个托管进程、全部状态记进一份事务账本。**HUD** 只读这份账本和各 harness 的磁盘证据，把本会话的原生子代理、外包出去的会话和 Jev 任务画成同一棵树，随任一 harness 启动。

## 1. 为什么

Jacob 的日常是多 harness 编排：cc 当编排者，后端交 Codex implementer，评审交 Codex reviewer，部分工作交 pi 角色，问答与出图出视频交 Jev（ChatGPT Pro / Gemini / AI Studio / Flow），关键节点问 Fable / Astra / Pro oracle。现在的问题：

- 每个 harness 只看得见自己的子代理；跨 harness 的调用没有任何一处记录父子关系。
- 调用方式是十几行 herdr CLI 配方，散在两个 skill 里，每个 harness 一套。
- 状态散在三处：Herdr 的 agent 列表、各自的 session 文件、编排者自己的记忆。
- codex-hud 已经把"子代理树 + 每代理上下文 / 速率 / 日志 + 时间线 + 证据诊断"做扎实了，但只对 Codex。

## 2. 目标与非目标

| # | 目标 | 验收 |
|---|---|---|
| G1 | **三 harness 启动**：`hud claude`、`hud codex`、`hud pi` 按显式启动档案起 bar 与 panel，显示模型、上下文占用、当前动作、用量 | 每 harness 一条 tmux 集成测试 + 合成 fixture 单测 |
| G2 | **原生子代理**：cc Agent 子代理、Codex spawn_agent 线程成树，带状态、上下文 %、最新报告 | 合成 fixture；真实会话抽查 |
| G3 | **跨 harness 外包**（主要收益，MVP 核心）：经 hud-mcp 启动的 Codex / pi 会话在父会话的树里作为 delegated 节点出现，带 harness、运行状态、它自己的原生子代理 | 真实场景：cc 启 Codex implementer，树里两种 harness 都在，状态随运行变化；关 tab 后历史保留 |
| G4 | **链接可解释且不猜**：账本是唯一的父子事实，父子身份经握手确认；transcript 只做约定范围内的核验；推断只产生候选；冲突显示而不归属 | 单测覆盖晚到、重复、冲突、fork 复制、循环、关闭后保留 |
| G5 | **Jev 作为外包后端**：jev-ask / jev-flow / jev-aistudio 的任务经 hud-mcp 启动，作为 job 节点显示状态与产物，按浏览器实例串行 | 真实场景：cc 经 MCP 问一次 ChatGPT Pro，节点从 sent 到 answered |
| G6 | **显式启动命令**：HUD 不猜可执行文件；两种契约（argv / shell 文本）各自明确 | `hud codex --shell "codex -m gpt-6-astra"` 跑通；无档案时报错不猜 |
| G7 | **cc statusline 替换 claude-hud**：功能对照以本机实际启用项为准 + 性能基准 + opt-in 观察期 + 可回滚切换 | §9.3 三道门 |
| G8 | **行为不回退**：Codex 现有功能、视觉基线、现有测试在 facade 之后保持全绿；旧 `codex-hud` 命令与旧 `--json` 有兼容 facade 或明确宣布破坏性版本 | CI |
| G9 | **隐私边界**：本地读取范围、模型材料范围、外发授权（目的 × 接收方）三者分开；新来源的正文默认不进模型；已有 Codex 授权不自动扩展 | 材料构建单入口 + 单测 |
| G10 | **Herdr 集成独立**：核心不 import Herdr；Herdr 只经注册表、宿主、运行控制三个接口进入，可整体关闭；无 Herdr 时核心功能全部可用 | 核心套件在无 Herdr、用假实现的环境下全绿；`HUD_HERDR=0` 集成测试 |
| G11 | **双模式与受约束的 resume**：每次委派可选可见或 headless；每次运行有托管进程、退出回执和取消；resume 只在该子会话没有活跃运行时允许；支持的组合以能力矩阵为准，不承诺"任意" | 真实场景：headless 起 Codex 子会话，结束后以可见模式 resume，同一节点两次运行；活跃时 resume 被拒绝 |
| G12 | **执行协议可恢复**：spawn / resume 先提交意图再执行再对账；结果不明标 `uncertain`，禁止盲重试；幂等键带调用者范围与参数摘要 | 并发重试、启动中断、旧 run 迟报三类测试 |

**非目标（v1 不做）：** 不改任何 harness 的行为；不做调度器或任务队列（agent-coop 已有）；不替代 Herdr；不做 Windows 原生；不做跨机器；不预建"任意 harness 插件平台"或事件总线；不保证"所有会话都能以任意模式 resume"。

**后续 feature（非 MVP，见 §13 阶段 F）：** Jev 任务路由、pi footer、Herdr 事件订阅、delegated 节点的模型摘要、通用 `delegate_ask` / `delegate_send`、Herdr 支持的其他 harness kind。

## 3. 场景

1. **编排者视角。** cc 在 herdr tab 里跑，panel 在右侧。cc 调 `delegate_spawn` 起了 Codex implementer，又起了 pi reviewer，再经 Jev 问了 ChatGPT Pro 一个设计问题：
   ```
   ▸ main  claude  fable-5.1  ctx 41%
     ├ ⌬ implementer:auth   codex  gpt-6.1-sol  working  ctx 23%  3 subtasks   run 2
     │   ├ auth_review  codex  idle
     │   └ explorer     codex  done
     ├ π reviewer:auth      pi     deepseek-flash  blocked  $0.12
     └ ◎ ask:chatgpt        jev    pro            answered  → answer.md
   ```
   reviewer `blocked` 进 bar 的 notice zone；回车跳到那个 tab。
2. **被外包方视角。** 在 `implementer:auth` 的 Codex tab 里开 HUD，顶部标出"父：claude main（w3Q:p1）"；`delegate_whoami` 能告诉它自己是谁的孩子、brief 和 report 在哪。
3. **单 harness 日常。** `hud claude` 不外包任何东西，就是一个 cc 的 bar + panel。
4. **无 tmux 的 cc。** 只用 statusline 模式，bar 画在输入框下面；想看树时 `hud panel` 在 herdr 里 split 一个 pane。
5. **headless 与 resume。** cc 以 headless 起一个 Codex 子会话做长任务，树上显示它的运行与日志；结束后发现要补一轮，`delegate_resume` 以可见模式重开同一会话，树上还是同一个节点、第二次运行。

## 4. 术语与身份模型

会话、线程、进程、pane、关系、运行是六种对象，各自有 id。

| 对象 | 定义 | 字段 |
|---|---|---|
| `SourceId` | 已解析的存储根：`realpath(CODEX_HOME)`、`CLAUDE_CONFIG_DIR`、pi 的 session 目录。显示名来自启动档案（如 `codex@account2`） | hash + label |
| `SessionRef` | 逻辑会话。路径是定位信息，不是身份 | `harness`、`source`、`sessionId`、`threadId?`（cc 原生子代理 = `agentId`；Codex 线程各有自己的 sessionId） |
| `JobRef` | 一次 Jev 任务 | `kind: 'jev'`、`provider`、`account?`、`key` |
| `CallerId` | 一个 hud-mcp 实例，等于加载它的那个 harness 进程 | `pid`、`ppid`、`procStart`、`harness`、`sessionRef?`、`boundBy?` |
| `RunBinding` | HUD 观察到的进程实例与它当前承载的会话 | `bindingId`、`ref`、`pid?`、`procStart?`、`herdr?{server, workspace, tab, pane, agentName}`、`tmux?{session, pane}`、`generation`、`evidence[]` |
| `DelegationLink` | 父子关系，有独立 id 和生命周期 | §6.6 |
| `Run` | 关系下的一次运行实例：模式、宿主位置、托管进程、退出回执 | `runId`、`linkId`、`mode`、`state`、`locator`、`supervisorPid`、`exit?` |
| `Report` | 子在某次运行里提交的结果 | `reportId`、`runId`、`status`、`summary`、`path` |
| 节点 | 树上的一行 = 一个 `SessionRef` 或 `JobRef` | `origin` 是关系的属性；同一会话可以既是某关系的 delegated child，又有自己的 L1 / subtask / review |
| L1 / subtask / review | 沿用 codex-hud | |
| 宿主 | bar / panel 画在哪：tmux pane、herdr pane、cc statusline、pi footer | |

HUD 自己所在的 pane 与被观察的 pane 永远分开记录。一个 pane 先后承载不同会话时，`RunBinding.generation` 递增，旧关系不套到新 occupant。

## 5. 证据盘点

### 5.1 四种来源在磁盘上写了什么

| | Codex 0.166 | Claude Code 2.1.305 | pi 1.4.0 | Jev（jev-ask 包） |
|---|---|---|---|---|
| 文件 | `$CODEX_HOME/sessions/Y/M/D/rollout-*.jsonl` | `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` | `~/.pi/agent/sessions/<cwd-slug>/<ts>_<id>.jsonl` 或 `--session-dir` | `~/.local/state/jev-{ask-recovery,flow,aistudio}[-<account>]/*_state.json`、`out/<key>*`、`*.lock` |
| 身份 | 首行 `session_meta`：`id`、`cwd`、`parent_thread_id`、`agent_path`、`agent_role`、`source` | 每行带 `sessionId`、`cwd`、`slug`；子代理文件的 `sessionId` **等于父会话**，靠 `agentId` 区分 | `type: session`（`id`、`cwd`、`version`） | `key`（每个 key 只点击一次）、`provider`、`account` |
| 用量 | `event_msg.token_count`：累计计数器，input 含 cached；`rate_limits` | `assistant.message.usage` 逐请求；同一 `message.id` 可出现多条相同 usage | `message.usage` 逐请求含 `cost`；另有 `usage(kind=cache_warm)` 与 `compaction` 自带 usage | 无 token；Flow 视频有点数 |
| 工具 | `response_item` function_call / output | `tool_use` / `tool_result`，`toolUseResult` | toolCall / `toolResult` | 无 |
| 原生子代理 | 独立 rollout + `parent_thread_id`；0.162 起任务 Fernet 加密 | `<session>/subagents/agent-<id>.jsonl` + `.meta.json`（`agentType`、`description`、`toolUseId`、`spawnDepth`、`finished`；少数 meta 无 `finished` 字段，缺失不等于完成） | 无 | 无 |
| 实时注册表 | `logs_2.sqlite` | `~/.claude/sessions/<pid>.json`（含 `procStart`、`pidDomain`；多个 PID 域，本地看不见不等于已退出） | 无；进程 cmdline | `status --key` |
| resume | `codex resume <id>`（headless `codex exec resume <id>`），续写同一 rollout | `claude --resume <id>`（headless `claude -p --resume <id>`），续写同一 transcript | `pi --session <path\|id>`、`--session-id`、`--fork`；续写行为待实测 | 不适用；同 key 只观测不重发 |
| 钩子 / 扩展 | `hooks.json` | hooks + `statusLine`（stdin JSON，`refreshInterval 5`） | 扩展 API（`compact-footer`、`herdr-agent-state.ts`） | CLI |
| 私有通道 | reasoning | `thinking` 块、`api-request-blob` | `thinking` 块、图片块 | 无 |

### 5.2 跨 harness 调用今天怎么发生

全在 Herdr 里，由 cc 的两个 skill 驱动（`herdr tab create --label` → `herdr pane run "codex …"` / `herdr agent start … --kind pi -- $(pi-role --args …)`），加 Jev 的 `jev-ask key/send/wait` 三步。Herdr 维护 agent 记录（kind、`agent_session.value`、`agent_status`、pane / tab / 标题），但公开 schema 没有创建者或委派父字段。`herdr agent start` 没有 env 参数；`tab create` / `pane split` 有。

### 5.3 约束

- cc 的 `statusLine` 命令除了 `tee` 给 toktrack，还处理 `COLUMNS` 缺失、`/dev/tty` 宽度与边距。
- `codex` 是 zsh 函数；本机有两个 Codex home，两个旧 `hud-settings.json` 都已开启模型 backend。
- Codex `[agents] max_depth = 2`；跨 harness 嵌套封顶显示深度 4。
- MCP 工具调用是同步的；三个 harness 已同时运行同一个 stdio MCP（codegraph），pi 经 pi-mcp-adapter。本机已验证 cc 的 MCP 服务器父进程是 `claude` 本身；Codex 的是 TUI 还是 daemon 未验证（阶段 A 探针）。
- Jev 各通道共享同一个浏览器实例，必须按实例串行；每个 key 只发送一次。
- Node 24 自带 `node:sqlite`，codex-hud 已用它只读 `logs_2.sqlite`；账本不引入新依赖。

## 6. 架构

### 6.1 原则

1. 只读 harness 写到磁盘的东西、Herdr 的只读 API、本用户进程的 `/proc`。
2. 采集做 I/O，渲染纯函数。
3. 每个结论带证据来源与强度；拿不准显示"未知"或"最后观测"，不伪造完成。
4. **账本里的显式关系是唯一的父子事实；身份经握手确认；transcript 只做约定范围内的核验；推断只产生候选。**
5. **本地读取范围、模型材料范围、外发授权是三个决定。**
6. harness 差异封在适配层与类型化能力里；树、卡片、bar、日志、brief 只认统一摘要。
7. **外部动作先记意图再执行再对账；结果不明就标明，不重试。**

### 6.2 组件

```
 编排者 harness ──MCP──► hud-mcp（stdio，每个 harness 进程一个实例；启动时登记 CallerId）
                            │ 事务写
                            ▼
                     ~/.hud/ledger.sqlite  ◄── 子代理的 hud-mcp：whoami（claim）/ report
                       links · runs · reports · events · callers · idempotency · leases
                            ▲
                            │ 退出回执 / 心跳
                     hud-run（每次运行一个托管进程：启动、日志、取消、退出码）
                            │ 可见：在 herdr / tmux 的 pane 里运行；headless：无 TTY
                            ▼
 各 harness transcript ─────┼──► HUD 采集（harness/、link/、registry 接口）──► 统一摘要 ──► bar / panel / statusline
 Herdr（integrations/herdr/：注册表、宿主、运行控制贡献）────┘
```

HUD 不依赖 hud-mcp 运行：没有账本时它仍是单 harness HUD。hud-mcp 不依赖 HUD。两者都不直接依赖 Herdr：Herdr 的 CLI 与 socket 只在 `integrations/herdr/` 里被调用，经 §6.12 的三个接口接入核心。账本由 hud-mcp 与 hud-run 写，HUD 只读。

### 6.3 `HarnessAdapter`

```ts
interface HarnessAdapter {
  id: 'codex' | 'claude' | 'pi';
  glyph: string;
  resolveSource(profile: LaunchProfile, env): SourceId;
  bind(ctx: BindContext): Promise<RunBinding | null>;      // 明确 > 注册表 > 候选；歧义不绑
  open(ref: SessionRef, checkpoint?: ReaderCheckpoint): SessionReader;
  children(ref: SessionRef): Promise<SessionRef[]>;         // 原生子代理；拓扑权威只有这一处
  capabilities: Partial<{ navigate(ref): Promise<void>; quota; goals; plan; todos }>;
}
```

`BindContext`：显式传入的 session（statusline stdin、`--session`）、注册表记录、pane 进程树、cwd、HUD 启动时间。**优先级：调用方明确给的 > 注册表（Herdr 或 harness 自带）> PID / cmdline > 候选（cwd / 时间 / 最新文件）**；候选有歧义就不绑定，恢复旧会话不要求文件创建于 HUD 启动之后。

`SessionReader` 契约：

- 每次调用有预算：字节（默认 4 MiB）、记录数（2000）、时间（软 20 ms）；超预算返回 `coverage: catching_up` 并保留游标。
- 单记录上限 1 MiB；已知的大记录类型（cc `api-request-blob`）按类型安全跳过；未知的超大记录跳过并记 coverage gap，不无限扩 Buffer。
- 记录分类用完整 JSON 解析后的 `type`，不用行首前缀（cc 常用记录首键是 `parentUuid`）。
- 未完成尾行保留到上限；截断、inode 变化、压缩边界、分支切换分别处理。
- 返回 `ReaderCheckpoint`：`fileId{dev, inode}`、`offset`、`schemaVersion`、`sourceGeneration`、恢复所需状态（未闭合工具调用、已见 usage id、压缩标记、速率基线）。offset 与状态同一次提交。

### 6.4 `SessionEvidence`（收窄后的共同观测摘要）

```ts
interface Metric<T> { value: T | null; source: string; asOf: number; quality: 'reported' | 'estimated' | 'unknown' }
interface SessionEvidence {
  ref: SessionRef; cwd; startedAt; version;
  model: Metric<{ id; provider?; effort? }>;          // 实际观测到的，不是配置
  context: Metric<{ used; window; afterCompaction?: boolean }>;
  spent: Metric<{ input; output; cacheRead?; cacheWrite?; reasoning?; costUsd? }>;  // 仅本节点
  activity: ActivityState;                             // §6.8
  action?: AgentAction;                                // 当前打开的工具调用
  reports: Report[];                                   // 公开报告，白名单提取
  progress?: Metric<{ done; total; current? }>;        // Codex plan / cc todos 的投影
  native: SessionRef[];                                // = children(ref) 的结果引用
  linkEvidence: LinkEvidence[];                        // 约定范围内提取的 hud-mcp 工具结果与首条 prompt 里的 linkId / claim（§6.7）
  coverage: 'complete' | 'partial' | 'catching_up';
  caps: { codex?: CodexExtras; claude?: ClaudeExtras; pi?: PiExtras };   // 类型化，不是 Record<string, unknown>
}
```

Git、项目配置、宿主健康、布局留在公共服务与视图组装层，不是 reader 的职责。跨节点合计只在口径与覆盖已知时进行；未知不当 0，记录的零成本不宣称免费。

**用量口径（每个适配器内定义并测试）：**

| | 上下文"已用" | 累计花费 | 去重 / 重置 |
|---|---|---|---|
| Codex | 最近一次 `token_count` 的 total 减 baseline（现有） | 累计计数器直接取 | 计数器不增不刷新；`context_compacted` 重置 |
| cc | 最新 assistant 的 `input + cache_read + cache_creation` | 按唯一 `message.id` 求和 | 同一 `message.id` 多条只算一次；`compact_boundary` 重置上下文 |
| pi | 最新 assistant 的 `input + cacheRead + cacheWrite`（`totalTokens` 含 output，不用） | assistant 的 `usage.cost.total` 求和；`cache_warm` 单列 | `compaction` 记录重置上下文，其 usage 不计入交互 |
| Jev | 无 | Flow 点数（`cost_preview` / 确认值） | 每 key 一次 |

### 6.5 `AgentTree`

关系在存储中独立于树，树是投影。节点字段在 `SubagentTreeNode` 上加：

```ts
ref: SessionRef | JobRef;
harness: 'codex' | 'claude' | 'pi' | 'jev';
links: { asChild?: DelegationLink; asParent: DelegationLink[] };
run?: { runId; mode; state; locator?; exit? };      // 当前或最后一次运行
host?: { paneId?; tabId?; label?; occupantMatches: boolean };
candidates?: LinkCandidate[];          // 未确认的推断，只在 Inspector 显示
```

构树规则：visited 集合防自环与祖先回环；同一 ref 只出现一次；总节点预算 200，每 tick I/O 预算 8 MiB，活跃与可见节点优先；不可见历史节点保留身份与最后状态并标"未加载"。`agentCounts` 的 active / blocked / done 按 §6.8 的投影算。

### 6.6 委派 MCP（`packages/hud-mcp`）与运行托管（`hud-run`）

**定位。** 跨 harness 委派的结构化前端 + 事务账本 + 运行托管。同 harness 的调用仍用原生机制（Codex spawn_agent、cc Agent 工具）。

#### 6.6.1 工具

| 工具 | 谁调 | MVP | 做什么 |
|---|---|---|---|
| `delegate_spawn` | 父 | ✔ | `{backend, role, brief, cwd, name?, model?, effort?, mode: visible\|headless, layout?: tab\|split, predecessor?: linkId, request_key}` → 提交意图并启动，返回 `{linkId, runId, state, locator?}` |
| `delegate_resume` | 父 | ✔（Codex）/ C（cc、pi） | `{linkId, mode, prompt?, request_key}` → 同一关系、同一所有者下追加一次运行；该子会话有活跃运行时拒绝并返回其状态 |
| `delegate_wait` | 父 | ✔ | `{linkId \| runId, afterSeq?, until?: [...], timeoutMs ≤ 120000}` → 有界长轮询：返回游标之后的事件与当前状态；超时不改变任何状态 |
| `delegate_status` | 父 | ✔ | `{linkId \| runId}` → 关系、运行、最新报告、托管心跳、`uncertain` 对账结果 |
| `delegate_cancel` | 父 | ✔ | `{runId, grace?}` → 经 hud-run 取消：SIGINT → 宽限 → SIGTERM → SIGKILL；记录为 `cancelled` |
| `delegate_whoami` | 子 | ✔ | `{claim?}` → 用启动时注入的 claim（env 或首条 prompt 里的）完成握手，返回自己的 link、run、brief、report 路径、父定位 |
| `delegate_report` | 子 | ✔ | `{runId, status, summary, reportPath?}` → 写 `reports`，发事件；报告绑定 runId |
| `delegate_list` / `delegate_close` | 父 | v1.1 | 列出本调用者的关系；关闭 = 取消活跃运行 + 关 surface + `closed` |
| `delegate_send` / `delegate_ask` | 父 / 子 | v1.1 | 输入通道。实现前保留 `herdr agent prompt` 作为明确的旧通道 |
| 资源 `hud://links`、`hud://tree` | 任何 | v1.1 | 让任何 agent 查看关系与树 |

#### 6.6.2 账本：`~/.hud/ledger.sqlite`

事务存储（WAL、`busy_timeout`、`user_version` 管 schema 版本），hud-mcp 与 hud-run 写，HUD 只读，`hud link export` 导出 JSON。

```sql
callers     (caller_id PK, harness, pid, ppid, proc_start, cwd, env_pane, session_ref NULL, bound_by NULL, started_at, last_seen_at)
links       (link_id PK, state, parent_caller, parent_ref NULL, child_ref NULL, backend, role, label, brief, report,
             predecessor NULL, created_at, claimed_at, bound_at, closed_at, routing NULL)
runs        (run_id PK, link_id, mode, state, locator JSON, claim_hash, claim_expires_at, supervisor_pid,
             heartbeat_at, started_at, ended_at, exit_code NULL, orphan_policy)
reports     (report_id PK, run_id, link_id, status, summary, path, created_at)
events      (seq PK AUTOINCREMENT, link_id, run_id NULL, kind, payload JSON, at)      -- wait 的游标
idempotency (scope, request_key, params_digest, link_id, run_id, outcome, at, PRIMARY KEY(scope, request_key))
leases      (resource PK, holder, expires_at)      -- browser:<cdp_url> | session:<SessionRef> | collect:<session>
```

- **幂等。** `scope = caller_id`，`request_key` 必填；同键同参数返回原结果，同键不同参数报错。
- **意图先行。** spawn / resume 在一个事务里写 `links` / `runs(state=starting)` / `idempotency`，再执行启动；成功 → `running`；失败且确定未执行 → `failed`；超时或结果不明 → `uncertain`，由 `delegate_status` 或 `hud run reconcile` 对账（托管心跳、pane / 进程存活、注册表记录），禁止盲重试。
- **SQLite 不保证外部动作恰好一次。** 恰好一次靠"意图记录 + 托管进程 + 对账"三件事，账本只保证记录本身一致。

**关系状态机：** `pending`（已登记）→ `claimed`（子用 claim 完成握手）→ `bound`（子会话身份已解析）→ `reported` → `closed`；`failed`、`revoked` 为终态分支。**运行状态机：** `starting` → `running` → `ended | failed | cancelled`，`uncertain` 可从 `starting` / `running` 进入并经对账退出。

#### 6.6.3 绑定握手

linkId 共现不再是身份依据。身份靠三样东西：

1. **调用者登记。** hud-mcp 启动时把自己登记为 `CallerId`（pid、ppid、procStart、harness 推断、`HERDR_PANE_ID`、cwd）。父子双方的 SessionRef 都从各自 caller 的绑定解析：cc 用 `~/.claude/sessions/<ppid>.json`（校验 procStart）；Codex 用 pane → 现有 daemon 绑定，或注册表 `agent_session.value`；pi 用 ppid 的 cmdline（`--session` / `--session-dir`）。解析不到就留空，关系停在 `pending` / `claimed`。
2. **启动回执与 claim。** spawn / resume 为每次运行生成一次性 `claim`（随机，存 hash，TTL 30 分钟）。hud-run 把 `HUD_LINK`、`HUD_RUN`、`HUD_CLAIM` 注入子进程环境，首条 prompt 也带上 linkId 与 claim 并要求子先调 `delegate_whoami`。子的 hud-mcp 实例用 env 里的 claim 自动握手；env 不可达（Codex 由 daemon 启动 MCP 时）则模型把 prompt 里的 claim 作为参数传入。claim 单次有效：fork 出来的会话再拿同一个 claim 握手会被拒绝，只能成为候选。
3. **transcript 的约定范围核验。** HUD 只在这个范围内把 transcript 当证据：`delegate_spawn` / `delegate_resume` 的 `tool_result` 里的 linkId（父侧），以及 `delegate_whoami` 的工具结果或首条用户消息里的 linkId + claim 指纹（子侧）；记录时间必须落在账本签发时间窗内（前 5 s，后 10 min）；transcript 的 harness 必须与 caller 一致；匹配到多份时报冲突。核验结果只能**确认或否定**账本里的身份，不能**创建**身份；账本缺父 / 子引用时，核验通过的唯一匹配可把它填上并标 `bound_by = transcript`。

`HUD_LINK` 环境注入、注册表的 `agent_session.value`、pi `--orchestrator` 都只是加速与交叉核验。v1 的 `HUD_PARENT` 取消。

#### 6.6.4 运行托管：`hud-run`

每次运行一个托管进程，解决"MCP 退出后谁保存退出码、谁执行取消"：

- `hud-run --run <runId> --mode visible|headless (--shell "<text>" | -- <argv…>)`：建新进程组；shell 文本模式用 `$SHELL -ic "<text>"` 执行（zsh 函数、别名可用），argv 模式直接 exec。
- 可见模式：hud-run 本身被敲进 pane 的交互 shell（Herdr `pane run` / tmux `send-keys`），TTY 直通，harness 照常在 pane 里画；Herdr 的 agent 检测不受影响。headless 模式：无 TTY，stdin 为 brief 或关闭。
- 写 `~/.hud/runs/<runId>/{meta.json, stdout.log, stderr.log, exit.json}`；每 5 s 更新 `runs.heartbeat_at`；子退出时写 `exit.json` 并把 `runs.state` / `exit_code` / `ended_at` 提交到账本。
- 取消：`hud run cancel <runId>`（`delegate_cancel` 调它）→ SIGINT → 宽限（默认 10 s）→ SIGTERM → SIGKILL，记 `cancelled`。
- 父断连策略 `orphan_policy: continue | stop`（后端档案可配，默认 `continue`）：父 hud-mcp 退出不影响运行；HUD 显示"父已离线"。
- 托管进程自身死亡：心跳超过 30 s 未更新 → `uncertain` → 对账检查进程组存活。

`RunHandle` 是运行控制的统一句柄：`{runId, locator{pane?, pid?, pgid?}, status(), cancel(), sendInput?(text), focus?()}`。核心实现 status / cancel；宿主实现 focus；输入通道由宿主或 v1.1 的 `delegate_send` 提供。

#### 6.6.5 等待、resume 与双模式

- **wait。** 有界长轮询，按 `events.seq` 游标返回；上限 120 s 按客户端实测调整；超时只返回当前状态与同一游标，不改变任务状态。可选 `notifyParent: hint`：终态事件发生时向父 pane 推一行提示（Herdr 内 `herdr agent prompt`），只是提示，不是协议。
- **resume。** 允许条件：关系处于 `bound` / `reported` / `closed`，且该子 `SessionRef` 没有 `starting` / `running` / `uncertain` 的运行（`uncertain` 先对账）；同一任务（brief 不变或追加 prompt）且同一所有者（caller 的 SessionRef 等于 `parent_ref`）才复用 linkId 并追加 runId；换任务或换所有者用 `delegate_spawn{predecessor}` 新建关系指向前一条。按后端档案的 resume 模板：Codex `codex resume <id>` / `codex exec resume <id>`，cc `claude --resume <id>` / `claude -p --resume <id>`，pi `pi --session <id>`（headless 加 `-p`）。每个 `SessionRef` 同时只允许一个受管运行（`leases: session:<ref>`）。
- **双模式。** `visible` 在 Herdr 内是 tab 或 split，在 Herdr 外是 tmux pane；`headless` 由 hud-run 直接起进程。两种模式在 Herdr 内同时可用，同一父可混用。headless 运行**只在 HUD 呈现**，不在 Herdr 登记；活跃时树上的动作是"看日志"，结束后才是"以可见模式 resume"。
- **能力矩阵。** 阶段 B 验证并写入文档的组合：Codex × {Herdr tab 可见, tmux 可见, headless, 结束后 resume（可见 / headless）}；split 布局、cc / pi 的 resume、活跃中的模式切换在后续阶段补。矩阵之外的组合返回"不支持"，不猜。

#### 6.6.6 后端档案 `~/.hud/delegate.json`

每个后端：`source`、启动方式（`shell` 文本或 `argv`）、`headless` 命令、`resume` 与 `resumeHeadless` 模板、角色到模型 / effort 的映射、默认布局、`orphan_policy`、资源约束。两个 skill 里硬编码的配方变成这里的配置，skill 缩成"调 `delegate_spawn`，验证报告"。

#### 6.6.7 Jev 后端

`delegate_spawn{backend: 'jev', provider: chatgpt|gemini|aistudio|flow, account?, prompt_file, kind?, confirm_credits?, request_key}`：

- 先取 `leases: browser:<cdp_url>`（按实际浏览器实例，不按账号；账号表里 `cdp_url` 相同的账号共用一把锁），再查无其他 `jev-*` 进程在用同一实例，然后 `jev-ask key` → `send`（Flow 视频先 dry-run，`confirm_credits` 必须由调用方显式传入）→ 后台 `wait` 写答案文件。
- key 在发送前持久化（jev-ask 已如此）；发送结果不明 → 运行标 `uncertain`，只用 `jev-ask status` / `reconcile` 对账，绝不重发；`NEEDS_HUMAN` → `pendingReason = needs_human`，锁持有到人工处理完并对账后才释放。
- 节点是 `JobRef`，状态来自 `jev-ask status --key` 与 state json（sent / waiting / answered / needs_human / failed），答案或产物文件就是 report。
- 混用规则：hud-mcp 可用时，同一时段的 Jev 调用都经它走；直接 CLI 与 hud-mcp 不在同一时段混用（见 `docs/delegation.md`）。

#### 6.6.8 后续：Jev 路由（阶段 F，非 MVP）

`delegate_route{brief_summary, candidates?}` 把 brief 摘要、仓库信号和后端表作为 `state`，向 typesafe Jev（`POST /v1/systemone`，JevDev 的 `JevClient.decide` 模式）提 Choice（后端 / 角色）与 Score（置信度）问题，返回建议并写入 `links.routing{suggested, confidence, accepted}`。模式 `off | suggest | auto`，默认 `suggest`，但远程建议在 §11 的外发授权（目的 = routing，接收方 = typesafe）批准前不可用；`auto` 另需后端白名单与预算上限。MVP 只预留字段。

### 6.7 链接解析（HUD 侧）

| 来源 | 作用 |
|---|---|
| 账本里 `bound` 及之后的关系 | **唯一成链依据** |
| transcript 的约定范围核验（§6.6.3 第 3 条） | 确认或否定账本身份；填补账本缺失的父 / 子引用 |
| 注册表 `agent_session.value`、`HUD_LINK` env、pi `--orchestrator` | 加速与交叉核验 |
| 父 transcript 的 herdr / pi-role / jev-ask 命令、tab 标签、Jev state 目录里的 key、持相同 claim 的 fork | **只产生候选**，Inspector 单独一组"疑似"，默认不读候选正文 |

两条互相矛盾的显式记录或两份都匹配的 transcript：显示冲突，停止归属，不按时间取近。pane 当前 occupant 与运行定位不符（`occupantMatches = false`）：关系保留为历史，不显示宿主状态，跳转前再校验。关闭 pane 后关系与最后状态保留。

### 6.8 状态模型

一个节点同时持有五个维度，再投影成一行：

| 维度 | 取值 | 主要来源 |
|---|---|---|
| `activity` | working / waiting_input / idle / exited / unknown | 注册表（仅当绑定实例匹配且新鲜）> transcript 最近事件 > 托管进程 |
| `pendingReason` | none / approval / question / needs_human | transcript 的审批 / 问题记录；Jev 的 NEEDS_HUMAN；注册表 `blocked` |
| `lastTurnOutcome` | none / completed / failed / interrupted | transcript 的 turn 结束事件；`reports`；`runs.exit_code` |
| `liveness` | alive / gone / unknown | 托管心跳 / 注册表 / 进程；进程存在只证明存在 |
| `freshness` | 证据事件时间与观测时间分开；来源失联标 `stale` | |

合并规则：注册表回答"当前交互是否 busy / blocked"，不覆盖明确的 turn failure；Herdr `done` 被查看后变 `idle` 是正常现象，用 `completion_seq` 识别完成观测；`unknown` 回退到有效文件证据；旧 transcript 里永不闭合的工具调用不推断 running 超过一个阈值；父 idle 而子 working 显示"idle，1 child working"。notice 只由 `pendingReason` 从 none 变为其他、`lastTurnOutcome` 变为 failed、新 `reports` 行、运行进入 `uncertain` 触发，切 tab 不触发。实现前写出完整真值表并作为单测。

### 6.9 注册表接口

核心只认 `RegistryProvider`（§6.12）。Herdr 实现只在 `HERDR_ENV=1` 且 `HUD_HERDR≠0` 时装载，按 Herdr server 共享一个轮询器（默认 3 s），所有 HUD 进程与 hud-mcp 实例读同一份缓存。cc 的 `~/.claude/sessions` 是 harness 自带注册表，由 cc 适配器提供。没有实现时返回空列表，核心照常。事件订阅留到阶段 F。

### 6.10 宿主与运行控制

```ts
interface HostAdapter {                       // 画面与焦点
  openSurface(layout, opts): Promise<PaneLocator>;    // tab / split / tmux pane；可注入 env
  runInSurface(locator, commandText): Promise<void>;  // 把 hud-run 命令敲进该 pane 的交互 shell
  locate(ref | runId): Promise<PaneLocator | null>;
  focus(locator): Promise<void>;              // 先校验 occupant
  sendKeys(locator, keys): Promise<void>;
  attachIdentity(harness): void;              // HERDR_AGENT=<harness>，不再硬编码 codex
}
interface RunControl {                        // 核心，基于 RunHandle 与账本
  status(runId); cancel(runId, grace?); reconcile(runId);
  sendInput?(runId, text);                    // 由宿主或 v1.1 工具提供
}
```

| 宿主 | bar | panel |
|---|---|---|
| tmux（核心） | 独立 pane | 独立 pane |
| herdr（集成层） | 由 statusline / footer 提供 | `hud panel` 在当前 tab split；panel 自己的 Herdr 身份不是被观察会话 |
| cc statusline | `hud statusline` | 无 |
| pi footer | 扩展读摘要 | 无 |

原生线程导航是 harness 的可选能力（Codex 经 `/subagents`）；cc / pi 的原生节点只开 Inspector，不发 Codex 指令。

### 6.11 存储

`$HUD_HOME`（默认 `~/.hud/`）：

```
ledger.sqlite                            关系 / 运行 / 报告 / 事件 / 调用者 / 幂等 / 租约（hud-mcp、hud-run 写；HUD 只读）
runs/<runId>/{meta.json,stdout.log,stderr.log,exit.json}
sources/<sourceId>/checkpoints/<session>.json   reader checkpoint（单写入者）
sources/<sourceId>/summaries/<session>.json     会话摘要（消费者读）
sources/<sourceId>/{scan,agent-log,model-cache,recaps,model.json,outbound.json}   按 source 隔离；模型授权与外发授权不跨 source
instances/<hudInstance>.json             布局 / 点击状态
settings.json                            显示设置；不含模型连接
delegate.json                            后端档案
```

三类采集数据分开：checkpoint、摘要、实例状态。每个 session / source 同时只有一个采集写入者（`leases: collect:<session>` 或租约文件 + 过期接管）；其他进程只读已提交结果。心跳与内容更新时间分开，不用 mtime 代表存活。版本分别管理：public snapshot v3、checkpoint schema、ledger `user_version`、`SCAN_VERSION`。旧 `$CODEX_HOME/hud/` 在阶段 A–D 保持可读，不自动迁移。

### 6.12 Herdr 集成层（独立）

目的：继续适配 Herdr，但把它关在一个可整体关闭的目录里，核心功能不随 Herdr 的 CLI、schema 或可用性变化。三个职责：

| 职责 | 核心接口 | 核心默认实现 | `integrations/herdr/` 实现 |
|---|---|---|---|
| 注册表 | `RegistryProvider`：`list()`、`get(locator)`、`sessionOf(locator)` | 空；cc 自带注册表由适配器提供 | `herdr agent list / get` 轮询缓存 |
| 宿主 | `HostAdapter`（§6.10） | tmux | `herdr tab create --env` / `pane split` / `pane run` / `agent focus`；`HERDR_AGENT=<harness>` |
| 运行控制贡献 | `RunControl.sendInput`、就绪探测 | 无输入通道；就绪靠托管心跳与 transcript | `herdr agent prompt`、`agent wait --until` 作为就绪与输入的实现 |

规则：

- 核心代码（`harness/`、`link/`、`render/`、账本、hud-run、hud-mcp 的账本与 headless 路径）不 import `integrations/herdr/`；依赖方向只有 Herdr → 核心接口。
- 装载条件：`HERDR_ENV=1` 且 `HUD_HERDR≠0`；装载失败（CLI 缺失、schema 不符、socket 不可达）降级为核心默认实现并在诊断页记一条。
- **降级边界：** 只有确定启动尚未执行（预检失败）时才回退到核心实现；启动已发出而超时，先对账，不重复启动。
- Herdr 的 CLI 与 schema 版本在集成层内固定并校验（`herdr api schema`），升级 Herdr 只改这个目录。
- 测试分两套：核心套件用假 `RegistryProvider` / `HostAdapter` / `RunControl` 跑，不需要 Herdr；Herdr 套件单独跑，只测这个目录。
- 现有的 `bin/codex-hud-herdr.mjs` 观察桥与 `HERDR_AGENT=codex` 标记迁入这一层并按 harness 参数化。

## 7. 各 harness 适配细节

### 7.1 Codex
现有代码不搬目录，先用 facade 实现 `HarnessAdapter`：`SessionFinder` → `bind`，`RolloutParser` → `open`（补 checkpoint 导出与预算），`buildSubagentTree` 的扫描 → `children`，quota / goals / plan → `caps.codex`。`SCAN_VERSION` +1。`linkEvidence`：`response_item` 里 hud-mcp 工具的 function_call_output。resume：`codex resume <id>` 续写同一 rollout，daemon 绑定已经识别 resume；headless 用 `codex exec resume <id>`。阶段 A 探针：Codex 的 MCP 服务器由 TUI 还是 daemon 启动、env 是否可达、`_meta` 是否带会话信息。

### 7.2 Claude Code
- 绑定：stdin 的 `session_id + transcript_path` > 注册表 `agent_session.value` > `~/.claude/sessions/<pid>.json`（校验 `procStart`，注意 PID 域）> 候选。
- 读取：完整 JSON 解析，只保留 `user`、`assistant`、`system`（compact_boundary）、`attachment.toolUseResult`、`ai-title`、`last-prompt`；`api-request-blob` 等按类型跳过。内容白名单：`text`、`tool_use`、`tool_result` 的公开字段；`thinking` 不提取。
- usage 按 `message.id` 去重；上下文窗口来自 stdin 的 `context_window` 或模型表。
- 原生子代理：`subagents/*.meta.json` 为节点，`toolUseId` 对上父的 `Agent` 调用；`.jsonl` 用同一 reader；`finished` 缺失不等于完成。后台 Bash 任务作为 action。
- `linkEvidence`：`mcp__hud__delegate_*` 的 `tool_result` 与首条用户消息。
- resume：`claude --resume <id>` 续写同一 transcript（headless：`claude -p --resume <id>`）；绑定不要求文件创建于 HUD 启动之后，`RunBinding.generation` 递增。

### 7.3 pi
- 绑定：pane 进程 cmdline（`--session-dir`、`--session`、`--role`）> 注册表记录 > 候选。
- 读取：`session`、`model_change`、`thinking_level_change`、`message`、`usage`、`compaction`、`custom`（`ask_orchestrator` 事件作 pendingReason）。图片块与大工具记录按上限跳过。
- 口径见 §6.4；无原生子代理。
- resume：`pi --session <path|id>`（headless 加 `-p`）；`--session-id` 可指定精确 id。续写还是新文件，阶段 C 实测后写定；若是新文件，适配器把新旧文件归到同一 `SessionRef`。
- 待验证：pi 分支导航下的落盘行为；未验证前显示"最后观测"。

### 7.4 Jev（job 适配器，不是 HarnessAdapter）
- 节点来源只有账本（hud-mcp 启动的 job）；state 目录里的其他 key 只作候选。
- 状态：`jev-ask status --key` / `jev-flow status --key` + state json；`needs_human` 进 pendingReason。
- 产物：`out/<key>*`、答案文件作为 report；Flow 点数作为 spent。
- 串行：hud-mcp 按浏览器实例持锁；HUD 只读不触发任何 Jev 动作。

## 8. skill 对接

- `herdr-delegate-codex`、`herdr-delegate`：launch / wait / 清理三节改为 `delegate_spawn` / `delegate_wait` / `delegate_status` / `delegate_cancel`；角色 → 模型映射移到 `delegate.json`；brief / role 文件规则不变。
- `jev-ask` skill：保留直接 CLI 用法；加一节"经 hud-mcp 调用时"与混用规则。
- 子代理角色模板加：开始时调 `delegate_whoami`（claim 来自 env 或首条 prompt），结束时调 `delegate_report`；问题在 `delegate_ask` 实现前仍走 `herdr agent prompt <父 pane>` 这条明确的旧通道。
- pi-role 的 `--orchestrator` 保留，作为候选证据与旧问题通道。

## 9. 启动器、statusline 与设置

### 9.1 启动器与两种启动契约

```
hud <harness> [--profile NAME] [--attach|--new-session] [--tree]            # 用档案
hud <harness> -- <argv…>            # argv 模式：HUD 负责安全引用（%q），不经 shell 解释
hud <harness> --shell "<text>"      # shell 文本模式：原样敲进 pane 的交互 shell，别名 / 函数可用
hud <harness> --resume <id>         # 用档案的 resume 模板重开会话；HUD 绑定到该已有 transcript
hud statusline --harness claude     # cc statusLine 命令
hud panel [--harness X --session ID]
hud link list|show|export|revoke    # 账本
hud run status|logs|cancel|reconcile <runId>
hud --json / --self-check / --kill
codex-hud …  ≡ hud codex …（兼容 facade，旧默认行为保留到阶段 E）
```

HUD 不在两种模式之间转换。启动档案 `{harness, source, launch: {shell | argv}, headless, resume, host, env?}` 同时定义有效的 transcript source：zsh 函数切了账号，HUD 就从该账号的 home 读。

### 9.2 设置
`~/.hud/settings.json` 只放显示设置；模型连接、模型授权与外发授权按 source 存放（§6.11）；`delegate.json` 放后端档案。环境变量 `HUD_*`，`CODEX_HUD_*` 作为别名保留到阶段 E 之后一个版本。

### 9.3 cc statusline 模式（阶段 D，三道门后切默认）

```json
"statusLine": { "type": "command", "refreshInterval": 5,
  "command": "bash -c '<保留现有 COLUMNS / tty 宽度处理>; tee -p >(toktrack quota record-claude >/dev/null 2>&1) | hud statusline --harness claude'" }
```

- 短生命进程。**本次 stdin 的 session、模型、上下文、cost 字段永远优先**；摘要文件只补树、工具、Git 等 stdin 没有的信息，不论摘要多新都不覆盖 stdin。
- 无常驻采集者时，调同一个有预算、可恢复的 reader 做增量；竞争租约失败就用已有摘要 + stdin；首次冷追赶报告 `partial`，不阻塞输出。
- `hud watch` 是可选的持续采集宿主，不是前提；不维护第二套解析。
- **三道门：** ① 功能对照清单（以本机 claude-hud 0.8.0 实际启用项为准：上下文条与百分比、模型与 effort、当前工具、运行中的子代理、todo 进度、git 分支与变更数、cost、速度、会话时长、用量窗口、中英文）全勾 + 性能基准达标；② opt-in：用户手动把 statusLine 指向 `hud statusline`，观察期至少两周，记录渲染耗时分位数与错误；③ `hud statusline --install` 备份并改写 `settings.json`，`--restore` 一键回滚。故障标准写在前面：p95 渲染超过 150 ms、任何崩溃或空输出即回滚。

## 10. UX

- **Bar**：模块 `delegated`，按后端计数 `⧉ ✳2 ⌬1 π1 ◎1`；notice 触发规则见 §6.8。
- **Agents 列表**：树行前缀 harness 图标；delegated 行显示标签、运行模式与状态；headless 活跃行的动作是"日志"，结束行是"打开"（可见模式 resume）；Jev 行显示 provider 与产物；冲突行显示"⚠ 两条记录"；可见行回车 / 点击 = 校验 occupant 后聚焦，Herdr 外灰显。
- **卡片**：pi 多一行 cost；cc 显示 `agentType` 与 `description`；Jev 显示 key、provider、产物路径；delegated 卡片显示 run 序号与退出码；Codex 照旧。
- **Inspector**：新节"链接"（关系状态机、握手方式、核验结果、时间）、"运行"（runs、托管心跳、日志路径）、"疑似"；新节"覆盖"（reader coverage、跳过的记录）。
- **顶部**：被外包方视角显示"父：<harness> <name>（<pane>）"，父未确认时显示"父：未确认（caller …）"。
- 文案全部过 `t()`，中英两表；bar 仍英文。

## 11. 隐私与安全

- **本地读取范围**：当前绑定会话与原生子代理默认读；账本确认（`bound` 及之后）的 delegated 会话的公开内容默认读（可设为只读元数据）；候选默认只读元数据。
- **模型材料范围**：新来源（cc / pi / Jev / delegated）的正文进入任何模型功能默认关；已有 Codex 授权不自动扩展；所有模型功能与缓存经同一个材料构建入口做范围检查，不只 brief。
- **外发授权**：`sources/<id>/outbound.json` 按（目的 × 接收方）逐项授权，例如 brief → api 端点、routing → typesafe；摘要授权不自动覆盖路由；未授权时远程建议关闭；`auto` 执行权限与预算另算。
- 每个适配器先做正向的公开内容白名单再生成材料；`thinking`、reasoning、请求 blob、未知类型不提取、不保留、不展示、不外发。
- 账本、checkpoint、摘要、运行日志用 `writePrivateFile` 或同等权限（0700 / 0600）；`/proc/*/environ` 只在需要时取 `HUD_LINK` 一键；账本存 claim 的 hash，不存明文；不含密钥与 prompt 正文。
- hud-mcp 校验 brief / report 路径为绝对路径；Jev 的 `confirm_credits` 必须显式传入。

## 12. 兼容与迁移

- 阶段 A–D：旧状态可读不迁；新旧进程不争写同一格式；旧 `codex-hud` 命令与 `--json` v2 经 facade 继续工作。
- 阶段 E：改名 `agent-hud`（bin `hud`）、`HUD_*`、目录迁移工具（扫描缓存重建；设置、模型授权、外发授权、预算按 source 分别迁，不合并）、`--json` v3 并宣布 v2 退役时间。
- 任何破坏性变更单独发版并修订 G8。

## 13. 开发计划

细节见[工程计划书](./universal-hud-engineering-plan.md)。**MVP = 阶段 A + B。**

| 阶段 | 交付 | 验收 |
|---|---|---|
| **A 契约、探针与 facade** | P0 契约写成 `docs/contracts/`：调用者登记与绑定凭据、spawn / resume 的幂等与事务与 `uncertain` 对账、link / run / report 生命周期与运行互斥与 wait 游标、进程托管 / 取消 / 退出记录 / 父断连；P1 契约：后端能力矩阵与宿主校验与降级边界、观测口径与 reader 预算与采集租约与 checkpoint 提交、外发授权与 schema 版本与旧格式兼容。探针报告 `docs/probes/`：Codex MCP 进程父子与 env、多会话隔离、Herdr env 传递、pi resume 落盘。TS 类型 + 契约 fixture；三个接口与假实现；Codex 经 facade 实现 `HarnessAdapter`，不搬目录；ledger schema v1；snapshot v3 草案；旧命令与默认行为不变 | 现有测试与视觉基线全绿；核心套件在无 Herdr 环境下跑通；契约 fixture 单测：cc 根与子代理共 sessionId、cc 重复 usage、pi compaction / cache_warm、双 home、同 pane 换会话、同一关系两次运行、并发重试、启动中断、旧 run 迟报 |
| **B MVP 纵向切片：cc → Codex** | `packages/hud-mcp`：调用者登记、账本、七个 MVP 工具（spawn / resume / wait / status / cancel / whoami / report）；`hud-run` 托管进程；Codex 后端档案（launch / headless / resume 模板）；核心宿主（tmux 可见 + headless）；`integrations/herdr/` 三职责实现（tab 可见、注册表、输入 / 就绪）；cc 绑定与最低限度 reader（身份、模型、上下文、活动、`linkEvidence`）；最小采集租约（多消费者）；树显示 delegated Codex 节点及其原生孙辈，headless 行的"日志 / 打开"；Inspector 链接与运行节；`hud claude`（tmux 宿主）与 `--resume`；最小 `hud panel` 入口（验收场景需要）；`herdr-delegate-codex` 改调 MCP；子代理角色模板加 whoami / report；能力矩阵文档 | 真实场景一：cc 在 Herdr 里可见模式启 Codex implementer，握手到 `bound`，树正确、状态随运行变化、关 tab 后历史保留。真实场景二：headless 启 Codex 子会话，结束后可见模式 resume，同一节点两次运行；活跃时 resume 被拒。`HUD_HERDR=0` 下场景二照样通过。并发重试、启动中断、旧 run 迟报、fork 复制 claim 的单测；MCP 在 cc 与 Codex 两侧都能加载 |
| **C pi 与 Jev 后端** | pi adapter + `hud pi`；cc 与 pi 的 resume 模板与实测；`herdr-delegate` 改调 MCP；Jev 后端（浏览器实例锁、key / send / wait、`uncertain` 对账、needs_human）+ JobRef 节点；pi 的 MCP 加载 | 三 harness + Jev 节点同树；pi cost 与 compaction 口径单测；pi / cc resume 真实场景；Jev 节点 sent → answered 与 needs_human 两个真实场景 |
| **D cc 完整与 statusline** | cc 原生子代理、后台任务、todo 投影；reader checkpoint + 完整采集租约；`hud statusline`（stdin 优先）；性能基准（冷启动、增量、超大单行、无结尾换行、重写、宽树、多消费者）；功能对照清单；`--install` / `--restore` | §9.3 三道门：清单 + 基准 → opt-in 观察期 → 可回滚切换 |
| **E 整理** | `hud panel`（herdr 宿主）完整版；Codex 目录搬迁（可选）；改名、`HUD_*`、迁移工具；v1.1 工具（list / close / send / ask、资源）；文档、i18n、README | 迁移往返测试；旧命令退役公告 |
| **F 后续 feature** | Jev 路由 `delegate_route`（suggest 默认，外发授权后可用，auto 需白名单与预算）；pi footer；Herdr 事件订阅；delegated 节点模型摘要；其他 Herdr kind | 各自单独立项 |

**设计验收案例（每阶段回归）：** 同 cwd 多会话与双 home；cc 根与多个子代理共 sessionId；同 pane 换会话 / resume；握手晚到、claim 过期、fork 复制 claim、链接重复、冲突、循环、关闭后保留；并发重试、启动中断、`uncertain` 对账、旧 run 迟报；stale / unknown 注册表；重复 usage 与压缩；panel / watch / statusline 并发；迁移后新来源仍未获模型外发授权；Jev needs_human 与重复 key。

**顺序理由：** A 先把执行协议写定并用探针消除最大未知；B 先验证主要收益（G3）并用第二种 transcript 格式检验接口；D 才动用户每天看的 statusline；E 才改名搬目录。

## 14. 风险

- cc transcript 大且类型多：预算 reader + 类型跳过 + coverage 标记；基准分别测冷启动与增量，并说明追加量、硬件与分位数。
- Codex daemon 可能代启 MCP 服务器：阶段 A 探针定型；若 env 不可达，握手只剩 prompt 里的 claim 一条路径，仍是显式握手而不是推断。
- MCP 同步调用：`delegate_wait` 有界长轮询；长等待配合后台 `herdr agent wait` 或循环。
- 外部动作非恰好一次：意图记录 + 托管进程 + 对账；`uncertain` 不重试。
- Herdr 之外：外包状态来自托管进程与文件；跳转不可用；headless 档案要单独测试。
- 子代理没加载 hud-mcp：关系停在 `pending`，transcript 核验可把它推进到 `bound`，但没有 whoami / report。
- Jev 浏览器串行与 NEEDS_HUMAN：按实例持锁；人工介入进 notice；CLI 与 hud-mcp 不同时段混用。
- 替换 claude-hud 的功能缺口：三道门，缺一不切；故障标准先写。
- 重构范围：A 只加 facade、契约与探针；搬目录放到 E。
- Herdr 层漂移：Herdr 升级只影响 `integrations/herdr/`；schema 校验不符就降级；降级只在启动未执行时。
- headless 运行的可见性：Herdr 里看不到；靠树、notice、托管日志；进程被杀时账本靠退出回执与对账收尾，不伪造完成。
- resume 的身份连续性：Codex 与 cc 续写同一文件，pi 待实测；新文件要归到同一 `SessionRef`。
- 运行互斥误伤：`uncertain` 的运行会挡住 resume，对账必须可手动触发（`hud run reconcile`）。

## 15. 决策记录

| 日期 | 决定 | 来源 |
|---|---|---|
| 2026-11-01 | cc statusline 用 HUD 替换 claude-hud，保留 toktrack `tee`；三道门后切默认，可回滚 | Jacob；Astra 2.6 / 2.10；Pro 抉择 7 |
| 2026-11-01 | 启动命令显式给出；argv 与 shell 文本两种契约分开 | Jacob；Astra 2.8 |
| 2026-11-01 | 跨 harness 委派统一走 hud-mcp；账本是唯一父子事实 | Jacob；Astra 2.1 / 2.2 |
| 2026-11-01 | Jev 浏览器自动化作为外包后端（阶段 C）；Jev 任务路由为后续 feature（阶段 F） | Jacob |
| 2026-11-01 | 阶段 0 "纯重构 28k 行"取消，改为契约 + facade，再做纵向切片 | Astra 2.10 |
| 2026-11-01 | `SessionEvidence` 收窄为观测摘要 + 类型化能力；指标带 source / asOf / quality | Astra 2.4 |
| 2026-11-01 | 状态拆五维再投影；注册表只回答当前交互 | Astra 2.5 |
| 2026-11-01 | 本地读取范围与模型材料范围分开；新来源默认不进模型 | Astra 2.3 |
| 2026-11-01 | 存储按 source 隔离；checkpoint / 摘要 / 实例状态三类分开；单写入者租约 | Astra 2.6 / 2.9 |
| 2026-11-01 | 继续适配 Herdr，但做成独立层，核心经注册表 / 宿主 / 运行控制三接口接入，可整体关闭 | Jacob；Pro 抉择 8 |
| 2026-11-01 | 委派同时支持可见与 headless；headless 只在 HUD 呈现，不在 Herdr 登记 | Jacob；Pro 抉择 4 |
| 2026-11-01 | 支持 resume；同任务同所有者复用 linkId 追加 runId，否则新建关系；活跃运行时拒绝 | Jacob；Pro 抉择 3 |
| 2026-11-01 | 身份靠调用者登记 + 一次性 claim 握手；transcript 只做约定范围核验，不再以 linkId 共现为身份 | Pro 返工 1、抉择 5 |
| 2026-11-01 | 账本改为 SQLite 事务存储（`node:sqlite`，无新依赖）；JSON 只做导出；幂等键带调用者范围与参数摘要；意图先行、`uncertain` 不重试 | Pro 返工 2、抉择 2 |
| 2026-11-01 | 关系、运行、报告分开建模；每 SessionRef 一个受管运行 | Pro 返工 3 |
| 2026-11-01 | 每次运行一个托管进程 `hud-run`：日志、退出回执、取消、父断连策略；status / cancel 进 MVP | Pro 返工 4 |
| 2026-11-01 | Jev 按浏览器实例加锁，所有入口共用；CLI 与 hud-mcp 不同时段混用 | Pro 返工 5 |
| 2026-11-01 | `delegate_wait` 有界长轮询 + 事件游标；父 pane 推送只是提示 | Pro 抉择 1 |
| 2026-11-01 | 外发授权按目的 × 接收方单独记录；路由建议在授权前关闭 | Pro 抉择 6 |
| 2026-11-01 | P0 契约与探针进阶段 A；最小 status / cancel、退出回执、采集租约、`hud panel` 入口进阶段 B；通用 ask / send 推迟 | Pro §4 / §6 |

## 16. 第三轮评审关注点

1. §6.6.3 的握手是否闭环：调用者登记 + 一次性 claim + 约定范围核验，三者合起来有没有仍能伪造或混淆身份的路径（fork、resume、同 pane 换会话、daemon 代启 MCP）。
2. §6.6.2 的事务与幂等设计能否兑现"意图先行、`uncertain` 不重试"；对账规则是否足够具体。
3. §6.6.4 的 hud-run 在可见模式里包住 harness 进程，会不会破坏 Herdr 的 agent 检测或 Codex 的 herdr-context 包装；有没有更轻的做法。
4. 工程计划书的工作包切分、顺序与角色分配是否合理；哪些工作包应该合并、拆分或提前。
5. 还有哪些会在三个月内返工的点。
