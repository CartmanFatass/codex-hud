# 通用 Agent HUD：概念方案与目标（v2.1，2026-11-01）

状态：v2.1，待 ChatGPT Pro 二审。v2 吸收了 Astra Max 的评审（[reviews/2026-11-01-astra-universal-hud-concept.md](./reviews/2026-11-01-astra-universal-hud-concept.md)，十项全部采纳）和三项决定：委派走统一 MCP、Jev 浏览器自动化作为外包后端、Jev 任务路由列为后续 feature。v2.1 再加三项决定：Herdr 集成做成独立层（§6.12）、委派同时支持可见与 headless 两种模式、支持 resume 会话。调研底稿见 [universal-hud-plan.md](./universal-hud-plan.md)。决策汇总在 §15，交二审的抉择点在 §16。

## 0. 一句话

两个组件。**hud-mcp** 是 cc / Codex / pi 三个 harness 共用的委派入口：起子代理、等、问、报，并把每一次委派写成一条显式的关系记录。**HUD** 只读这些记录和各 harness 的磁盘证据，把本会话的原生子代理、外包出去的会话和 Jev 任务画成同一棵树，随任一 harness 启动。

## 1. 为什么

Jacob 的日常是多 harness 编排：cc 当编排者，后端交 Codex implementer，评审交 Codex reviewer，部分工作交 pi 角色，问答与出图出视频交 Jev（ChatGPT Pro / Gemini / AI Studio / Flow），关键节点问 Fable / Astra oracle。现在的问题：

- 每个 harness 只看得见自己的子代理；跨 harness 的调用没有任何一处记录父子关系。
- 调用方式是十几行 herdr CLI 配方，散在两个 skill 里，每个 harness 一套。
- 状态散在三处：Herdr 的 agent 列表、各自的 session 文件、编排者自己的记忆。
- codex-hud 已经把"子代理树 + 每代理上下文 / 速率 / 日志 + 时间线 + 证据诊断"做扎实了，但只对 Codex。

## 2. 目标与非目标

| # | 目标 | 验收 |
|---|---|---|
| G1 | **三 harness 启动**：`hud claude`、`hud codex`、`hud pi` 按显式启动档案起 bar 与 panel，显示模型、上下文占用、当前动作、用量 | 每 harness 一条 tmux 集成测试 + 合成 fixture 单测 |
| G2 | **原生子代理**：cc Agent 子代理、Codex spawn_agent 线程成树，带状态、上下文 %、最新报告 | 合成 fixture；真实会话抽查 |
| G3 | **跨 harness 外包**（主要收益，MVP 核心）：经 hud-mcp 启动的 Codex / pi 会话在父会话的树里作为 delegated 节点出现，带 harness、Herdr 状态、它自己的原生子代理 | 真实场景：cc 启 Codex implementer，树里两种 harness 都在，状态随 Herdr 变化；关 tab 后历史保留 |
| G4 | **链接可解释且不猜**：显式关系记录是唯一事实；推断只产生候选；冲突显示而不归属 | 单测覆盖晚到、重复、冲突、循环、关闭后保留 |
| G5 | **Jev 作为外包后端**：jev-ask / jev-flow / jev-aistudio 的任务经 hud-mcp 启动，作为 job 节点显示状态与产物 | 真实场景：cc 经 MCP 问一次 ChatGPT Pro，节点从 sent 到 answered |
| G6 | **显式启动命令**：HUD 不猜可执行文件；两种契约（argv / shell 文本）各自明确 | `hud codex --shell "codex -m gpt-6-astra"` 跑通；无档案时报错不猜 |
| G7 | **cc statusline 替换 claude-hud**：功能对照以本机实际启用项为准，达标后才切默认；保留 toktrack 记账 | §9.3 清单逐项打勾 + 性能基准 |
| G8 | **行为不回退**：Codex 现有功能、视觉基线、现有测试在 facade 之后保持全绿；旧 `codex-hud` 命令与旧 `--json` 有兼容 facade 或明确宣布破坏性版本 | CI |
| G9 | **隐私边界**：本地读取范围与模型材料范围分开；新来源的正文默认不进模型；已有 Codex 授权不自动扩展 | 材料构建单入口 + 单测 |
| G10 | **Herdr 集成独立**：核心（适配器、树、账本、渲染、hud-mcp 的账本与 headless 路径）不 import Herdr；Herdr 只经 §6.12 的三个接口进入，可整体关闭；无 Herdr 时核心功能全部可用，只少跳转与实时交互状态 | 核心测试套件在无 Herdr、用假实现的环境下全绿；`HUD_HERDR=0` 集成测试 |
| G11 | **双模式与 resume**：每次委派可选可见（Herdr tab / split，或 tmux pane）或 headless；两种模式在 Herdr 内同时可用；任何子会话都能按账本里的 session id 以任一模式 resume，HUD 把 resume 识别为同一会话的新一次运行 | 真实场景：headless 起 Codex 子会话，再以可见模式 resume 它，树上仍是同一节点、两次运行 |

**非目标（v1 不做）：** 不改任何 harness 的行为；不做调度器或任务队列（agent-coop 已有）；不替代 Herdr；不做 Windows 原生；不做跨机器；不预建"任意 harness 插件平台"或事件总线。

**后续 feature（非 MVP，见 §13 阶段 F）：** Jev 任务路由（判断任务类型、建议或自动分配后端）、pi footer、Herdr 事件订阅、delegated 节点的模型摘要、Herdr 支持的其他 harness kind。

## 3. 场景

1. **编排者视角。** cc 在 herdr tab 里跑，panel 在右侧。cc 调 `delegate_spawn` 起了 Codex implementer，又起了 pi reviewer，再经 Jev 问了 ChatGPT Pro 一个设计问题：
   ```
   ▸ main  claude  fable-5.1  ctx 41%
     ├ ⌬ implementer:auth   codex  gpt-6.1-sol  working  ctx 23%  3 subtasks
     │   ├ auth_review  codex  idle
     │   └ explorer     codex  done
     ├ π reviewer:auth      pi     deepseek-flash  blocked  $0.12
     └ ◎ ask:chatgpt        jev    pro            answered  → answer.md
   ```
   reviewer `blocked` 进 bar 的 notice zone；回车跳到那个 tab。
2. **被外包方视角。** 在 `implementer:auth` 的 Codex tab 里开 HUD，顶部标出"父：claude main（w3Q:p1）"，`delegate_whoami` 能告诉它自己是谁的孩子，树只显示自己的子线程。
3. **单 harness 日常。** `hud claude` 不外包任何东西，就是一个 cc 的 bar + panel。
4. **无 tmux 的 cc。** 只用 statusline 模式，bar 画在输入框下面；想看树时 `hud panel` 在 herdr 里 split 一个 pane。

## 4. 术语与身份模型

评审 2.1 的核心要求：会话、线程、进程、pane、关系是五种对象，不能共用一个 id。

| 对象 | 定义 | 字段 |
|---|---|---|
| `SourceId` | 已解析的存储根：`realpath(CODEX_HOME)`、`CLAUDE_CONFIG_DIR`、pi 的 session 目录。显示名来自启动档案（如 `codex@account2`） | hash + label |
| `SessionRef` | 逻辑会话。路径是定位信息，不是身份 | `harness`、`source`、`sessionId`、`threadId?`（cc 原生子代理 = `agentId`；Codex 线程各有自己的 sessionId） |
| `JobRef` | 一次 Jev 任务 | `kind: 'jev'`、`provider`、`account?`、`key` |
| `RunBinding` | 被观察的进程实例与它当前承载的会话 | `bindingId`、`ref`、`pid?`、`procStart?`、`herdr?{server, workspace, tab, pane, agentName}`、`tmux?{session, pane}`、`generation`、`evidence[]` |
| `DelegationLink` | 两个明确对象之间的父子关系，有独立 id 和生命周期 | 见 §6.6 |
| 节点 | 树上的一行 = 一个 `SessionRef` 或 `JobRef` | `origin` 是关系的属性：同一会话可以既是某关系的 delegated child，又有自己的 L1 / subtask / review |
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
| 钩子 / 扩展 | `hooks.json` | hooks + `statusLine`（stdin JSON，`refreshInterval 5`） | 扩展 API（`compact-footer`、`herdr-agent-state.ts`） | CLI |
| 私有通道 | reasoning | `thinking` 块、`api-request-blob` | `thinking` 块、图片块 | 无 |

### 5.2 跨 harness 调用今天怎么发生

全在 Herdr 里，由 cc 的两个 skill 驱动（`herdr tab create --label` → `herdr pane run "codex …"` / `herdr agent start … --kind pi -- $(pi-role --args …)`），加 Jev 的 `jev-ask key/send/wait` 三步。Herdr 维护 agent 记录（kind、`agent_session.value`、`agent_status`、pane / tab / 标题），但公开 schema 没有创建者或委派父字段（评审已核实）。`herdr agent start` 没有 env 参数；`tab create` / `pane split` 有。

### 5.3 约束

- cc 的 `statusLine` 命令除了 `tee` 给 toktrack，还处理 `COLUMNS` 缺失、`/dev/tty` 宽度与边距。
- `codex` 是 zsh 函数；本机有两个 Codex home，两个旧 `hud-settings.json` 都已开启模型 backend。
- Codex `[agents] max_depth = 2`；跨 harness 嵌套封顶显示深度 4。
- MCP 工具调用是同步的；三个 harness 已同时运行同一个 stdio MCP（codegraph），pi 经 pi-mcp-adapter。
- Jev 各通道共享浏览器，必须串行；每个 key 只发送一次。

## 6. 架构

### 6.1 原则

1. 只读 harness 写到磁盘的东西、Herdr 的只读 API、本用户进程的 `/proc`。
2. 采集做 I/O，渲染纯函数。
3. 每个结论带证据来源与强度；拿不准显示"未知"或"最后观测"，不伪造完成。
4. **显式关系记录是唯一的父子事实；推断只产生候选。**
5. **本地读取范围与模型外发范围是两个决定。**
6. harness 差异封在适配层与类型化能力里；树、卡片、bar、日志、brief 只认统一摘要。

### 6.2 组件

```
 编排者 harness ──MCP──► hud-mcp（stdio，每个 harness 进程一个实例，无 daemon）
                            │  起子代理：herdr tab/pane/agent CLI；Herdr 外 headless
                            │  Jev：jev-ask key/send/wait
                            ▼
                     ~/.hud/links/<linkId>.json   ◄── 子代理的 hud-mcp：whoami / ask / report
                            │
 各 harness transcript ─────┼──► HUD 采集（harness/、registry/、link/）──► 统一摘要 ──► bar / panel / statusline
 Herdr agent list ──────────┘
```

HUD 不依赖 hud-mcp 运行：没有账本时它仍是单 harness HUD。hud-mcp 不依赖 HUD：它本身就是更好的委派入口。两者都不直接依赖 Herdr：Herdr 的 CLI 与 socket 只在 `integrations/herdr/` 里被调用，经 §6.12 的三个接口（注册表、宿主、启动后端）接入核心。

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

`BindContext`：显式传入的 session（statusline stdin、`--session`）、Herdr agent 记录、pane 进程树、cwd、HUD 启动时间。**优先级：调用方明确给的 > Herdr 记录 > harness 注册表 + PID > 候选（cwd / 时间 / 最新文件）**；候选有歧义就不绑定，恢复旧会话不要求文件创建于 HUD 启动之后。

`SessionReader` 契约（评审 2.7）：

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
host?: { paneId?; tabId?; label?; occupantMatches: boolean };
candidates?: LinkCandidate[];          // 未确认的推断，只在 Inspector 显示
```

构树规则：visited 集合防自环与祖先回环；同一 ref 只出现一次；总节点预算 200，每 tick I/O 预算 8 MiB，活跃与可见节点优先；不可见历史节点保留身份与最后状态并标"未加载"。`agentCounts` 的 active / blocked / done 按 §6.8 的投影算，不再只看 running / starting。

### 6.6 委派 MCP（`packages/hud-mcp`）

**定位。** 跨 harness 委派的结构化前端 + 关系账本。同 harness 的调用仍用原生机制（Codex spawn_agent、cc Agent 工具）。

**工具。**

| 工具 | 谁调 | MVP | 做什么 |
|---|---|---|---|
| `delegate_spawn` | 父 | ✔ | `{backend, role, brief, cwd, name?, model?, effort?, mode?: visible\|headless, layout?: tab\|split, request_key?}` → 起子代理，返回 `{linkId, runId, name, pane?, tab?, childHint?}` |
| `delegate_resume` | 父 | ✔（Codex）/ C（cc、pi） | `{linkId, mode?: visible\|headless, prompt?}` → 按后端档案的 resume 模板用账本里的 session id 重开同一子会话，新增一次 run，返回 `{linkId, runId, pane?}` |
| `delegate_wait` | 父 | ✔ | `{linkId, until[], timeoutMs ≤ 120000}` → 当前状态；长等待由调用方循环或配合后台 `herdr agent wait` |
| `delegate_whoami` | 子 | ✔ | 返回自己的 link（父、brief、report 路径、问题通道） |
| `delegate_report` | 子 | ✔ | `{linkId, status, summary, reportPath?}` → 账本 `bound → reported` |
| `delegate_send` / `delegate_status` / `delegate_list` / `delegate_close` | 父 | v1.1 | 包装 `herdr agent prompt / get / list`、`/quit` + tab close |
| `delegate_ask` | 子 | v1.1 | 写账本并 `herdr agent prompt` 父 pane，替代 pi-role 的 `--orchestrator` |
| 资源 `hud://links`、`hud://tree` | 任何 | v1.1 | 让任何 agent 查看关系与树 |

**账本。** 每条关系一个私有原子 JSON（`~/.hud/links/<linkId>.json`，0600，temp + rename）：

```json
{ "schemaVersion": 1, "linkId": "lnk_7f3k…", "state": "pending|bound|reported|closed|failed|revoked",
  "parent": { "ref": {…} | null, "hint": { "pane": "w3Q:p1", "evidence": ["HERDR_PANE_ID", "ppid→claude sessions"] } },
  "child": { "ref": {…} | null, "locator": { "backend": "codex", "pane": "w3Q:p3", "tab": "w3Q:t3", "agentName": "auth-impl" } },
  "role": "implementer", "label": "implementer:auth", "brief": "/abs/brief.md", "report": "/abs/report.md",
  "runs": [ { "runId": "run_01", "mode": "headless", "pid": 4242, "startedAt": …, "endedAt": …, "exit": 0 },
            { "runId": "run_02", "mode": "visible", "pane": "w3Q:p3", "tab": "w3Q:t3", "startedAt": … } ],
  "requestKey": "…", "createdBy": "hud-mcp", "createdAt": …, "boundAt": …, "closedAt": …, "routing": null }
```

状态机：`pending`（已登记，子未就绪）→ `bound`（子会话身份确认）→ `reported` → `closed`；启动失败或超时停在 `failed`；可显式 `revoked`。同 `requestKey` 幂等返回同一 linkId。一条关系可以有多次运行（`runs[]`）：首次 spawn 一次，之后每次 resume 一次；关系与子会话身份不变，变的只是运行实例与宿主位置。

**双模式。** `mode: visible` 在 Herdr 内是 tab 或 split，在 Herdr 外是 tmux pane；`mode: headless` 是无 TTY 的后台进程（`codex exec`、`claude -p`、`pi -p` / `pi-role … --out`），stdout / stderr 与退出码写到 `~/.hud/runs/<runId>/`，transcript 照常由 harness 写盘，所以 HUD 对两种模式一视同仁。两种模式在 Herdr 内同时可用，同一父会话可以混用；headless 运行在 Herdr 里没有 pane，树上标 `headless`，跳转按钮换成"打开"（= 以可见模式 resume）。

**resume。** 每个后端档案带 `resume` 模板：Codex `codex resume <sessionId>`（headless：`codex exec resume <sessionId>`），cc `claude --resume <sessionId>`（headless：`claude -p --resume <sessionId>`），pi `pi --session <path|id>`（headless 加 `-p`）。`delegate_resume` 用账本里 `child.ref` 的 session id 填模板，在指定模式里重开，追加一次 run；首条 prompt 仍带 linkId，所以绑定规则不变。Codex resume 续写同一 rollout，cc 续写同一 transcript；pi 的续写行为阶段 C 实测后再写定。

**身份绑定（解决评审 2.1 / 2.2）。** linkId 由服务器生成、不可猜。它作为工具结果返回给父，因此**父的 transcript 里必然出现它**；hud-mcp 给子的第一条 prompt 也带上它（"你的 link 是 lnk_…，先调 `delegate_whoami`"），因此**子的 transcript 里也必然出现它**。HUD 的绑定规则对三个 harness一致：在哪份 transcript 的 hud-mcp 工具结果或首条用户消息里找到这个 linkId，哪份就是父 / 子。不依赖 ppid（Codex 的 MCP 可能由 daemon 启动）、不依赖环境继承、不解析 shell 命令。`HUD_LINK` 环境变量经 `herdr tab create --env` 注入只是加速手段；`herdr agent get` 的 `agent_session.value` 是另一条确认路径。v1 的 `HUD_PARENT` 取消。

**启动流程。** 写 `pending` → `herdr tab create --workspace --cwd --label role:task --env HUD_LINK=…`（或 `pane split`）→ 按后端档案 `herdr pane run`（shell 文本，zsh 函数可用）或 `herdr agent start --kind pi -- <argv>` → 等就绪 → `herdr agent rename` → 发首条 prompt（含 linkId、role、brief 路径）→ 从 Herdr 拿到 session 就写 `bound`。Herdr 不在：headless 档案（`codex exec`、`claude -p`、`pi-role … --out`），账本同样写，没有 pane。

**后端档案 `~/.hud/delegate.json`。** 每个后端：`source`、启动方式（`shell` 文本或 `argv`）、角色到模型 / effort 的映射（implementer = gpt-6.1-sol high，pi implementer = deepseek-flash …）、默认布局、headless 命令、串行约束。两个 skill 里硬编码的配方变成这里的配置，skill 缩成"调 `delegate_spawn`，验证报告"。

**Jev 后端。** `delegate_spawn{backend: 'jev', provider: chatgpt|gemini|aistudio|flow, account?, prompt_file, kind?, …}` → `jev-ask key` → `send`（Flow 视频先 dry-run，`confirm_credits` 必须由调用方显式传入）→ 后台 `wait` 写答案文件。节点是 `JobRef`，状态来自 `jev-ask status --key` 与 state json（sent / waiting / answered / needs_human / failed），答案或产物文件就是 report。hud-mcp 按账号持锁保证串行；同一 key 绝不重发。

**后续：Jev 路由（阶段 F，非 MVP）。** `delegate_route{brief_summary, candidates?}` 把 brief 摘要、仓库信号和后端表作为 `state`，向 typesafe Jev（`POST /v1/systemone`，JevDev 的 `JevClient.decide` 模式）提 Choice（后端 / 角色）与 Score（置信度）问题，返回建议并写入账本 `routing{suggested, confidence, accepted}`。模式 `off | suggest | auto`，默认 `suggest`；`auto` 需要后端白名单与预算上限；Inspector 显示路由依据。MVP 只预留账本字段。

### 6.7 链接解析

| 来源 | 作用 |
|---|---|
| 账本记录 + transcript 中的 linkId | **唯一成链依据** |
| Herdr `agent_session.value`、`HUD_LINK` env | 加速与交叉核验 |
| 父 transcript 的 herdr / pi-role / jev-ask 命令、pi `--orchestrator`、tab 标签、Jev state 目录里的 key | **只产生候选**，Inspector 单独一组"疑似"，默认不读候选正文 |

两条互相矛盾的显式记录：显示冲突，停止归属，不按时间取近。pane 当前 occupant 与记录不符（`occupantMatches = false`）：关系保留为历史，不显示 Herdr 状态，跳转前再校验。关闭 pane 后关系与最后状态保留。

### 6.8 状态模型（评审 2.5）

一个节点同时持有五个维度，再投影成一行：

| 维度 | 取值 | 主要来源 |
|---|---|---|
| `activity` | working / waiting_input / idle / exited / unknown | Herdr（仅当绑定实例匹配且新鲜）> transcript 最近事件 |
| `pendingReason` | none / approval / question / needs_human | transcript 的审批 / 问题记录；Jev 的 NEEDS_HUMAN；Herdr `blocked` |
| `lastTurnOutcome` | none / completed / failed / interrupted | transcript 的 turn 结束事件；`delegate_report` |
| `liveness` | alive / gone / unknown | 注册表 / 进程 / Herdr；进程存在只证明存在 |
| `freshness` | 证据事件时间与观测时间分开；来源失联标 `stale` | |

合并规则：Herdr 回答"当前交互是否 busy / blocked"，不覆盖明确的 turn failure；Herdr `done` 被查看后变 `idle` 是正常现象，用 `completion_seq` 识别完成观测；`unknown` 回退到有效文件证据；旧 transcript 里永不闭合的工具调用不推断 running 超过一个阈值；父 idle 而子 working 显示"idle，1 child working"。notice 只由 `pendingReason` 从 none 变为其他、`lastTurnOutcome` 变为 failed、`delegate_report` 到达触发，切 tab 不触发。实现前写出完整真值表并作为单测。

### 6.9 Herdr 注册表（`registry/`）

核心只认 `RegistryProvider` 接口（§6.12）；Herdr 的实现只在 `HERDR_ENV=1` 且 `HUD_HERDR≠0` 时装载，按 Herdr server 共享一个轮询器（默认 3 s），所有 HUD 进程与 hud-mcp 实例读同一份缓存。用途：绑定本会话、子会话身份、状态、跳转目标。没有实现时返回空列表，核心照常。事件订阅留到阶段 F。

### 6.10 宿主（`host/`）

```ts
interface HostAdapter {
  locate(ref): Promise<PaneLocator | null>;
  focus(locator): Promise<void>;          // 先校验 occupant
  sendKeys(locator, keys): Promise<void>;
  attachIdentity(harness): void;          // HERDR_AGENT=<harness>，不再硬编码 codex
}
```

| 宿主 | bar | panel |
|---|---|---|
| tmux（现有） | 独立 pane | 独立 pane |
| herdr | 由 statusline / footer 提供 | `hud panel` 在当前 tab split；panel 自己的 Herdr 身份不是被观察会话 |
| cc statusline | `hud statusline` | 无 |
| pi footer | 扩展读摘要 | 无 |

原生线程导航是 harness 的可选能力（Codex 经 `/subagents`）；cc / pi 的原生节点只开 Inspector，不发 Codex 指令。herdr 宿主的实现放在 `integrations/herdr/`，tmux 宿主留在核心。

### 6.12 Herdr 集成层（独立）

目的：继续适配 Herdr，但把它关在一个可整体关闭的目录里，核心功能不随 Herdr 的 CLI、schema 或可用性变化。

核心只定义三个接口，Herdr 只是它们的一种实现：

| 接口 | 核心默认实现 | `integrations/herdr/` 实现 |
|---|---|---|
| `RegistryProvider`：`list()`、`get(locator)`、`sessionOf(locator)` | 空（无注册表）；cc 可用 `~/.claude/sessions` 作为 harness 自带注册表 | `herdr agent list / get` 轮询缓存 |
| `HostAdapter`（§6.10） | tmux | `herdr tab / pane / agent focus`，`HERDR_AGENT=<harness>` 身份标记 |
| `SpawnBackend`：`spawnVisible(profile, env, firstPrompt)`、`spawnHeadless(…)`、`resume(…)`、`wait(locator, until)`、`close(locator)` | headless 进程（`~/.hud/runs/`）+ tmux 可见模式 | `herdr tab create --env` / `pane split` / `pane run` / `agent start` / `agent wait` / `agent prompt` |

规则：

- 核心代码（`harness/`、`link/`、`render/`、账本、hud-mcp 的账本与 headless 路径）不 import `integrations/herdr/`；依赖方向只有 Herdr → 核心接口。
- 装载条件：`HERDR_ENV=1` 且 `HUD_HERDR≠0`；装载失败（CLI 缺失、schema 不符、socket 不可达）降级为核心默认实现并在诊断页记一条，不影响树、账本和渲染。
- Herdr 的 CLI 与 schema 版本在集成层内固定并校验（`herdr api schema` 的版本字段），升级 Herdr 只改这个目录。
- 测试分两套：核心套件用假 `RegistryProvider` / `HostAdapter` / `SpawnBackend` 跑，不需要 Herdr；Herdr 套件单独跑，只测这个目录。
- Herdr 内两种模式都可用：可见模式走 tab / split；headless 模式仍由核心的进程后端启动，Herdr 层只负责在需要时把它"打开"（= 可见模式 resume）。
- 现有的 `bin/codex-hud-herdr.mjs` 观察桥与 `HERDR_AGENT=codex` 标记迁入这一层并按 harness 参数化。

### 6.11 存储（评审 2.6 / 2.9）

`$HUD_HOME`（默认 `~/.hud/`）：

```
links/<linkId>.json                      关系记录（hud-mcp 写，HUD 读）
sources/<sourceId>/checkpoints/<session>.json   reader checkpoint（单写入者）
sources/<sourceId>/summaries/<session>.json     会话摘要（消费者读）
sources/<sourceId>/{scan,agent-log,model-cache,recaps,model.json}   按 source 隔离，模型授权不跨 source
instances/<hudInstance>.json             布局 / 点击状态
settings.json                            显示设置；不含模型连接
delegate.json                            后端档案
```

三类数据分开：checkpoint、摘要、实例状态。每个 session / source 同时只有一个采集写入者（跨进程租约文件 + 过期接管）；其他进程只读已提交结果。心跳与内容更新时间分开，不用 mtime 代表存活。版本分别管理：public snapshot v3、checkpoint schema、link schema、`SCAN_VERSION`。旧 `$CODEX_HOME/hud/` 在阶段 A–D 保持可读，不自动迁移。

## 7. 各 harness 适配细节

### 7.1 Codex
现有代码不搬目录，先用 facade 实现 `HarnessAdapter`：`SessionFinder` → `bind`，`RolloutParser` → `open`（补 checkpoint 导出与预算），`buildSubagentTree` 的扫描 → `children`，quota / goals / plan → `caps.codex`。`SCAN_VERSION` +1。resume：`codex resume <id>` 续写同一 rollout，daemon 绑定已经识别 resume（现有）；headless 用 `codex exec resume <id>`。

### 7.2 Claude Code
- 绑定：stdin 的 `session_id + transcript_path` > Herdr `agent_session.value` > `~/.claude/sessions/<pid>.json`（校验 `procStart`，注意 PID 域）> 候选。
- 读取：完整 JSON 解析，只保留 `user`、`assistant`、`system`（compact_boundary）、`attachment.toolUseResult`、`ai-title`、`last-prompt`；`api-request-blob` 等按类型跳过。内容白名单：`text`、`tool_use`、`tool_result` 的公开字段；`thinking` 不提取。
- usage 按 `message.id` 去重；上下文窗口来自 stdin 的 `context_window` 或模型表。
- 原生子代理：`subagents/*.meta.json` 为节点，`toolUseId` 对上父的 `Agent` 调用；`.jsonl` 用同一 reader；`finished` 缺失不等于完成。后台 Bash 任务作为 action。
- linkId：hud-mcp 工具结果（`mcp__hud__delegate_*`）与首条用户消息。
- resume：`claude --resume <id>` 续写同一 transcript（headless：`claude -p --resume <id>`）；绑定不要求文件创建于 HUD 启动之后，`RunBinding.generation` 递增。

### 7.3 pi
- 绑定：pane 进程 cmdline（`--session-dir`、`--role`）> Herdr 记录 > 候选。
- 读取：`session`、`model_change`、`thinking_level_change`、`message`、`usage`、`compaction`、`custom`（`ask_orchestrator` 事件作 pendingReason）。图片块与大工具记录按上限跳过。
- 口径见 §6.4；无原生子代理。
- resume：`pi --session <path|id>`（headless 加 `-p`）；`--session-id` 可指定精确 id。续写还是新文件，阶段 C 实测后写定。
- 待验证：pi 分支导航下的落盘行为；未验证前显示"最后观测"。

### 7.4 Jev（job 适配器，不是 HarnessAdapter）
- 节点来源只有账本（hud-mcp 启动的 job）；state 目录里的其他 key 只作候选。
- 状态：`jev-ask status --key` / `jev-flow status --key` + state json；`needs_human` 进 pendingReason。
- 产物：`out/<key>*`、答案文件作为 report；Flow 点数作为 spent。
- 串行：hud-mcp 持锁；HUD 只读不触发任何 Jev 动作。

## 8. skill 对接

- `herdr-delegate-codex`、`herdr-delegate`：launch / wait / 清理三节改为 `delegate_spawn` / `delegate_wait` / `delegate_close`；角色 → 模型映射移到 `delegate.json`；brief / role 文件规则不变。
- `jev-ask` skill：保留直接 CLI 用法；加一节"经 hud-mcp 调用时"。
- 子代理角色模板加一句：开始时调 `delegate_whoami`，结束时调 `delegate_report`；问题经 `delegate_ask`。
- pi-role 的 `--orchestrator` 保留，作为候选证据与 v1.1 之前的问题通道。

## 9. 启动器、statusline 与设置

### 9.1 启动器与两种启动契约

```
hud <harness> [--profile NAME] [--attach|--new-session] [--tree]            # 用档案
hud <harness> -- <argv…>            # argv 模式：HUD 负责安全引用（%q），不经 shell 解释
hud <harness> --shell "<text>"      # shell 文本模式：原样敲进 pane 的交互 shell，别名 / 函数可用
hud <harness> --resume <id>         # 用档案的 resume 模板重开会话；HUD 绑定到该已有 transcript
hud statusline --harness claude     # cc statusLine 命令
hud panel [--harness X --session ID]
hud link list|show|revoke           # 账本
hud --json / --self-check / --kill
codex-hud …  ≡ hud codex …（兼容 facade，旧默认行为保留到阶段 E）
```

HUD 不在两种模式之间转换。启动档案 `{harness, source, launch: {shell | argv}, host, env?}` 同时定义有效的 transcript source：zsh 函数切了账号，HUD 就从该账号的 home 读。

### 9.2 设置
`~/.hud/settings.json` 只放显示设置；模型连接与授权按 source 存放（§6.11）；`delegate.json` 放后端档案。环境变量 `HUD_*`，`CODEX_HUD_*` 作为别名保留到阶段 E 之后一个版本。

### 9.3 cc statusline 模式（阶段 D 切默认）

```json
"statusLine": { "type": "command", "refreshInterval": 5,
  "command": "bash -c '<保留现有 COLUMNS / tty 宽度处理>; tee -p >(toktrack quota record-claude >/dev/null 2>&1) | hud statusline --harness claude'" }
```

- 短生命进程。**本次 stdin 的 session、模型、上下文、cost 字段永远优先**；摘要文件只补树、工具、Git 等 stdin 没有的信息，不论摘要多新都不覆盖 stdin。
- 无常驻采集者时，调同一个有预算、可恢复的 reader 做增量；竞争租约失败就用已有摘要 + stdin；首次冷追赶报告 `partial`，不阻塞输出。
- `hud watch` 是可选的持续采集宿主，不是前提；不维护第二套解析。
- 功能对照清单以本机 claude-hud 0.8.0 **实际启用项**为准（上下文条与百分比、模型与 effort、当前工具、运行中的子代理、todo 进度、git 分支与变更数、cost、速度、会话时长、用量窗口、中英文）；缺一项不切默认。

## 10. UX

- **Bar**：模块 `delegated`，按后端计数 `⧉ ✳2 ⌬1 π1 ◎1`；notice 触发规则见 §6.8。
- **Agents 列表**：树行前缀 harness 图标；delegated 行显示 tab 标签与 Herdr 状态；Jev 行显示 provider 与产物；冲突行显示"⚠ 两条记录"；回车 / 点击 = 校验后 `herdr agent focus`，Herdr 外灰显。
- **卡片**：pi 多一行 cost；cc 显示 `agentType` 与 `description`；Jev 显示 key、provider、产物路径；Codex 照旧。
- **Inspector**：新节"链接"（记录、状态机、证据、时间）与"疑似"；新节"覆盖"（reader coverage、跳过的记录）。
- **顶部**：被外包方视角显示"父：<harness> <name>（<pane>）"。
- 文案全部过 `t()`，中英两表；bar 仍英文。

## 11. 隐私与安全

- **本地读取范围**：当前绑定会话与原生子代理默认读；账本确认的 delegated 会话的公开内容默认读（可设为只读元数据）；候选默认只读元数据。
- **模型材料范围**：新来源（cc / pi / Jev / delegated）的正文进入任何模型功能默认关；已有 Codex 授权不自动扩展；所有模型功能与缓存经同一个材料构建入口做范围检查，不只 brief。
- 每个适配器先做正向的公开内容白名单再生成材料；`thinking`、reasoning、请求 blob、未知类型不提取、不保留、不展示、不外发。
- 账本、checkpoint、摘要用 `writePrivateFile`；`/proc/*/environ` 只在需要时取 `HUD_LINK` 一键；账本不含密钥与 prompt 正文。
- hud-mcp 校验 brief / report 路径为绝对路径；Jev 的 `confirm_credits` 必须显式传入。

## 12. 兼容与迁移

- 阶段 A–D：旧状态可读不迁；新旧进程不争写同一格式；旧 `codex-hud` 命令与 `--json` v2 经 facade 继续工作。
- 阶段 E：改名 `agent-hud`（bin `hud`）、`HUD_*`、目录迁移工具（扫描缓存重建；设置、模型授权、预算按 source 分别迁，不合并）、`--json` v3 并宣布 v2 退役时间。
- 任何破坏性变更单独发版并修订 G8。

## 13. 开发计划

**MVP = 阶段 A + B。** 之后每个阶段都可独立交付。

| 阶段 | 交付 | 验收 |
|---|---|---|
| **A 契约与 facade** | 六个契约写成 `docs/contracts/`（身份、账本 schema 含 `runs[]`、观测口径、状态模型真值表、reader 预算与 checkpoint、存储范围）+ TS 类型 + 契约 fixture；`RegistryProvider` / `HostAdapter` / `SpawnBackend` 三个接口与假实现；Codex 经 facade 实现 `HarnessAdapter`，不搬目录；snapshot v3 草案；旧命令与默认行为不变 | 现有测试与视觉基线全绿；核心套件在无 Herdr 环境下跑通；契约 fixture 单测通过：cc 根与子代理共 sessionId、cc 重复 usage、pi compaction / cache_warm、双 home、同 pane 换会话、同一关系两次运行 |
| **B MVP 纵向切片：cc → Codex** | `packages/hud-mcp` 五个工具（spawn / resume / wait / whoami / report）+ 账本 + Codex 后端档案（launch / headless / resume 模板）+ Jev 账本字段预留；核心 `SpawnBackend`（headless 进程 + tmux 可见）；`integrations/herdr/` 的三个实现（可见 tab / split、注册表、宿主）；cc 绑定与最低限度 reader（身份、模型、上下文、活动、工具结果中的 linkId）；树显示 delegated Codex 节点及其原生孙辈，headless 节点带"打开"；Inspector 链接节；`hud claude`（tmux 宿主）与 `--resume`；`herdr-delegate-codex` 改调 MCP；子代理角色模板加 whoami / report | 真实场景一：cc 在 Herdr 里可见模式启 Codex implementer，树正确、状态随 Herdr 变化、关 tab 后历史保留。真实场景二：headless 启 Codex 子会话，再可见模式 resume，同一节点两次运行。`HUD_HERDR=0` 下场景二照样通过。链接晚到 / 重复 / 冲突 / 循环单测；MCP 在 cc 与 Codex 两侧都能加载 |
| **C pi 与 Jev 后端** | pi adapter + `hud pi`；cc 与 pi 的 resume 模板与实测；`herdr-delegate` 改调 MCP；Jev 后端（spawn / wait / 状态 / 产物）+ JobRef 节点 + 串行锁；pi 的 MCP 加载 | 三 harness + Jev 节点同树；pi cost 与 compaction 口径单测；pi / cc resume 真实场景；Jev 节点 sent → answered 真实场景 |
| **D cc 完整与 statusline** | cc 原生子代理、后台任务、todo 投影；reader checkpoint + 单写入者租约；`hud statusline`（stdin 优先）；性能基准（冷启动、增量、超大单行、无结尾换行、重写、宽树、多消费者）；功能对照清单 | 清单全勾 + 基准达标后切换 `settings.json`；否则保留 claude-hud |
| **E 整理** | `hud panel`（herdr 宿主）；Codex 目录搬迁（可选）；改名、`HUD_*`、迁移工具；v1.1 工具（send / status / list / close / ask、资源）；文档、i18n、README | 迁移往返测试；旧命令退役公告 |
| **F 后续 feature** | Jev 路由 `delegate_route`（suggest 默认，auto 需白名单与预算）；pi footer；Herdr 事件订阅；delegated 节点模型摘要；其他 Herdr kind | 各自单独立项 |

**设计验收案例（每阶段回归）：** 同 cwd 多会话与双 home；cc 根与多个子代理共 sessionId；同 pane 换会话 / resume；链接晚到、重复、冲突、循环、关闭后保留；stale / unknown 注册表；重复 usage 与压缩；panel / watch / statusline 并发；迁移后新来源仍未获模型外发授权；Jev needs_human 与重复 key。

**顺序理由：** B 先验证主要收益（G3）并用第二种 transcript 格式检验接口；D 才动用户每天看的 statusline；E 才改名搬目录。

## 14. 风险

- cc transcript 大且类型多：预算 reader + 类型跳过 + coverage 标记；基准分别测冷启动与增量，并说明追加量、硬件与分位数。
- Codex daemon 可能代启 MCP 服务器：身份靠 transcript 中的 linkId，不靠 ppid。
- MCP 同步调用：`delegate_wait` 短超时；长等待配合后台 `herdr agent wait`。
- Herdr 之外：外包状态只来自文件，可能滞后；跳转不可用；headless 档案要单独测试。
- 子代理没加载 hud-mcp：仍能从首条 prompt 的 linkId 绑定，只是没有 whoami / report。
- Jev 浏览器串行与 NEEDS_HUMAN：hud-mcp 持锁；人工介入进 notice。
- 替换 claude-hud 的功能缺口：清单以实际启用项为准，缺一项不切。
- 重构范围：A 只加 facade 与契约；搬目录放到 E。
- Herdr 层漂移：Herdr 的 CLI / schema 升级只能影响 `integrations/herdr/`；集成层校验 schema 版本，不符就降级，不让核心跟着坏。
- headless 运行的可见性：Herdr 里看不到 headless 进程，只能靠树与 notice；进程被杀时账本靠 `~/.hud/runs/<runId>/` 的退出码与 transcript 收尾，不伪造完成。
- resume 的身份连续性：Codex 与 cc 续写同一文件，pi 待实测；若某 harness resume 生成新文件，适配器要把新旧文件归到同一 `SessionRef`，否则树上会出现两个节点。

## 15. 决策记录

| 日期 | 决定 | 来源 |
|---|---|---|
| 2026-11-01 | cc statusline 用 HUD 替换 claude-hud，保留 toktrack `tee`；切换推迟到阶段 D 达标后 | Jacob；Astra 2.6 / 2.10 |
| 2026-11-01 | 启动命令显式给出；argv 与 shell 文本两种契约分开 | Jacob；Astra 2.8 |
| 2026-11-01 | 跨 harness 委派统一走 hud-mcp；账本是唯一父子事实；`HUD_PARENT` 取消，身份靠 transcript 中的 linkId | Jacob；Astra 2.1 / 2.2 |
| 2026-11-01 | Jev 浏览器自动化作为外包后端（阶段 C）；Jev 任务路由为后续 feature（阶段 F） | Jacob |
| 2026-11-01 | 阶段 0 "纯重构 28k 行"取消，改为契约 + facade，再做纵向切片 | Astra 2.10 |
| 2026-11-01 | `SessionEvidence` 收窄为观测摘要 + 类型化能力；指标带 source / asOf / quality | Astra 2.4 |
| 2026-11-01 | 状态拆五维再投影；Herdr 只回答当前交互 | Astra 2.5 |
| 2026-11-01 | 本地读取范围与模型材料范围分开；新来源默认不进模型 | Astra 2.3 |
| 2026-11-01 | 存储按 source 隔离；checkpoint / 摘要 / 实例状态三类分开；单写入者租约 | Astra 2.6 / 2.9 |
| 2026-11-01 | 继续适配 Herdr，但做成独立层 `integrations/herdr/`，核心经三个接口接入，可整体关闭 | Jacob |
| 2026-11-01 | 委派同时支持可见（tab / split / tmux pane）与 headless 两种模式，Herdr 内两种都可用 | Jacob |
| 2026-11-01 | 支持 resume：`delegate_resume` 与 `hud <harness> --resume`；一条关系多次运行（`runs[]`），子会话身份不变 | Jacob |

## 16. 交二审的抉择点

每条给出当前倾向，请评审者给出建议与理由。

1. **`delegate_wait` 的等待方式。** 倾向：同步调用上限 120 s，长等待由父循环或配合后台 `herdr agent wait`；备选：子完成时 hud-mcp 主动 `herdr agent prompt` 父 pane 推一条完成通知（Herdr 外无此通道）。
2. **账本存储形态。** 倾向：每条关系一个原子 JSON 文件（简单、可读、无锁）；备选：单个 SQLite（查询、并发追加和历史更顺手，但多一个依赖和损坏恢复问题）。
3. **resume 的关系语义。** 倾向：resume 复用同一 linkId，追加一次 run；备选：每次 resume 新建 link 并指向前一条（历史更清楚，树上却要折叠）。
4. **headless 运行在 Herdr 里的呈现。** 倾向：不在 Herdr 登记，只在 HUD 树和 notice 里出现，"打开"即可见模式 resume；备选：headless 也开一个隐藏 / 不聚焦的 tab 以复用 Herdr 的状态检测。
5. **Codex 的 MCP 进程父子与 env。** 阶段 B 第一周实测 daemon 还是 TUI 启动 MCP 服务器；若是 daemon，`HUD_LINK` 环境注入对 Codex 失效，只剩 transcript 中的 linkId 一条路径。请评估这是否足够。
6. **Jev 路由（阶段 F）的输入边界。** brief 摘要要离开本机送 typesafe Jev；倾向：与 §11 的材料范围共用同一个开关与白名单，默认 `suggest` 仍需用户显式开启外发。
7. **阶段 D 的切换门槛。** 倾向：功能清单全勾 + 性能基准达标后才改 `settings.json`；备选：先以 opt-in 方式并行跑两周再切。
8. **Herdr 集成层的边界是否划对。** 三个接口（注册表、宿主、启动后端）能否覆盖现有 Herdr 用法而不让核心渗入 Herdr 概念；有没有更小或更稳的切法。
