# 通用 Agent HUD：概念方案与目标（v2.3，2026-11-01）

状态：v2.3，**阶段 A 的开工基线**。ChatGPT Pro 第三轮评审（[reviews/2026-11-01-chatgpt-pro-v22-plan.md](./reviews/2026-11-01-chatgpt-pro-v22-plan.md)）的结论：可以作为阶段 A 的开工基线，还不能作为阶段 B 的冻结实施基线；B 的实施基线在 A9（契约冻结）时由探针证据与不变量放行。v2.3 吸收了该轮全部修正：claim 绑定到运行、来源、启动实例与会话代次；撤销"恰好一次"的说法；幂等以持久所有者为范围；意图与运行槽同事务；对账写成"证据 → 允许迁移"表；wait 进入时固定 runId；可见模式采用 Oracle 裁决的修订方案甲，正常 scope 终结不要求原生退出结果；监督故障诚实中断；HUD 只读账本，身份回填归 reconciler；三类租约分别定义；`predecessor` 定为转交。

- v2 吸收 Astra Max 的评审（[reviews/2026-11-01-astra-universal-hud-concept.md](./reviews/2026-11-01-astra-universal-hud-concept.md)，十项全部采纳）和三项决定：委派走统一 MCP、Jev 浏览器自动化作为外包后端、Jev 任务路由列为后续 feature。
- v2.1 加三项决定：Herdr 集成做成独立层、委派同时支持可见与 headless 两种模式、支持 resume。
- v2.2 吸收 ChatGPT Pro 的评审（[reviews/2026-11-01-chatgpt-pro-universal-hud-v21.md](./reviews/2026-11-01-chatgpt-pro-universal-hud-v21.md)）：五个返工项与八个抉择点全部采纳。核心变化：绑定握手取代"linkId 共现即身份"；账本改为 SQLite 事务存储；关系、运行、报告分开建模；每次运行有独立的托管进程；Jev 按浏览器实例加锁；P0 契约进阶段 A。

本轮按 [Oracle consult 1](./reviews/2026-11-01-astra-contracts.md) C01–C14 收窄 MVP，并按 [consult 2](./reviews/2026-11-01-astra-consult2.md) D01–D13 补齐字段、动作与本地导出；A9 仍未放行，生产实现/能力验收在 B。调研底稿见 [universal-hud-plan.md](./universal-hud-plan.md)，决策日志 §15，当前证据与两级门禁 §16。

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
| G4 | **链接可解释且不猜**：账本是唯一的父子事实，父子身份经握手确认，工具调用校验所有者；transcript 只做约定范围内的核验；推断只产生候选；冲突显示而不归属 | 单测覆盖晚到、重复、冲突、fork 抢先兑换、循环、关闭后保留 |
| G5 | **Jev 作为外包后端**：jev-ask / jev-flow / jev-aistudio 的任务经 hud-mcp 启动，作为 job 节点显示状态与产物，按浏览器实例串行 | 真实场景：cc 经 MCP 问一次 ChatGPT Pro，节点从 sent 到 answered |
| G6 | **显式启动命令**：HUD 不猜可执行文件；两种契约（argv / shell 文本）各自明确 | `hud codex --shell "codex -m gpt-6-astra"` 跑通；无档案时报错不猜 |
| G7 | **cc statusline 替换 claude-hud**：功能对照以本机实际启用项为准 + 性能基准 + opt-in 观察期 + 可回滚切换 | §9.3 三道门 |
| G8 | **行为不回退**：Codex 现有功能、视觉基线、现有测试在 facade 之后保持全绿；旧 `codex-hud` 命令与旧 `--json` 有兼容 facade 或明确宣布破坏性版本 | CI |
| G9 | **隐私边界**：本地读取范围、模型材料范围、外发授权（目的 × 接收方）三者分开；新来源的正文默认不进模型；已有 Codex 授权不自动扩展 | 材料构建单入口 + 单测 |
| G10 | **Herdr 集成独立**：核心不 import Herdr；Herdr 只经注册表、宿主、运行控制三个接口进入，可整体关闭；无 Herdr 时核心功能全部可用 | 核心套件在无 Herdr、用假实现的环境下全绿；`HUD_HERDR=0` 集成测试 |
| G11 | **双模式与受约束的 resume**：每次委派可选可见或 headless；每次运行有托管进程、退出回执和取消；resume 只在该子会话没有活跃运行时允许；支持的组合以能力矩阵为准，不承诺"任意" | 真实场景：headless 起 Codex 子会话，结束后以可见模式 resume，同一节点两次运行；活跃时 resume 被拒绝 |
| G12 | **执行协议可恢复**：spawn / resume 在一个事务里提交意图并占运行槽，只有占到槽的执行者启动；结果不明标 `uncertain`，按"证据 → 允许迁移"表对账，禁止盲重试；幂等键以持久所有者为范围并带参数摘要，MCP 重启不绕开 | 并发重试、启动中断、MCP 重启后重试、旧 run 迟报四类测试 |
| G13 | **轻量与快**（Jacob，2026-11-01：与正确性同级的考量）：不引入常驻服务（hud-mcp 随 harness 起停，hud-run 每运行一个且只在运行期间存在）；热路径（bar / panel tick、statusline、非 wait 的 MCP 工具调用）有预算；托管与对账的开销按次计而不是按秒轮询；正确性机制若有代价，先选成本低的证据（进程组、回执文件）再选重的 | 契约 06 统一拥有热路径/冷启动、进程/RSS、逻辑写入/实际 I/O、CPU 与 accepted→started/bound 的口径/预算；B 阶段与 D4 基准核实，超预算即缺陷 |
| G14 | **清晰的子代理可视化与低摩擦协作**：用户一眼看清谁在为谁干活、处于什么状态、卡在哪；编排者委派一次 = 一次 `delegate_spawn` + `delegate_wait`，不再手写 herdr / pi-role / codex 配方 | B14 场景；B13 后 skill 只剩"调 MCP、验报告" |

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
| `CallerId` | 一个 hud-mcp 物理实例。MCP 可能被 harness 重启，所以它不是所有者。身份绑定在其下的 `caller_contexts` 上：MVP 经验证的专属 stdio 恰好一个当前 context；共享正向调度延期，原生子或来源缺失不得沿用根身份（契约 01） | `pid`、`ppid`、`procStart`、`harness`；每个 context：`sessionRef?`、`boundBy?`、`generation` |
| `OwnerKey` | 持久的逻辑所有者，幂等与所有权校验的范围：已绑定时 = 父 `SessionRef`；未绑定但逻辑来源可辨时 = harness 进程身份（含机器/boot/PID 域、pid、procStart 与 generation）。MCP 重启后不变 | 派生字段，不单独存 |
| `SessionBinding` | 已选择的完整SessionRef与可取得的进程/宿主占用观察；不要求ledger、hud-mcp、run或childBinding；不是持久身份、父子边或授权凭据 | `sessionRef`、`harness`、独立nullable `occupantGeneration`、`managed:RunBinding|null` |
| `RunBinding` | A4受管run读取投影，由ledger/已核验运行证据供应，不通过观察候选制造 | 真实`runId`、该run的`bindingGeneration`必有，`sessionRef/childBinding`未绑定可空；supervisor等运行事实只从SessionBinding.managed读取 |
| `DelegationLink` | 父子关系，有独立 id 和生命周期 | §6.6 |
| `Run` | 关系下的一次运行实例：模式、宿主位置、托管进程、退出回执 | `runId`、`linkId`、`mode`、`state`、`locator`、`supervisorPid`、`exit?` |
| `Report` | 子在某次运行里提交的结果 | `reportId`、`runId`、`status`、`summary`、`path` |
| 节点 | 树上一行的显示身份为 `session(ref) \| delegationIntent(linkId) \| job(ref)`（Job留C），即§6.5/契约06的DisplayNodeIdentity；不是新的授权身份 | 未绑定意图以稳定linkId关联currentRun，不伪造ref、不计已确认session；绑定后合并真实节点。`origin`是关系属性；同一会话可既是delegated child又有自己的L1/subtask/review |
| L1 / subtask / review | 沿用 codex-hud | |
| 宿主 | bar / panel 画在哪：tmux pane、herdr pane、cc statusline、pi footer | |

HUD 自己所在的 pane 与被观察的 pane 永远分开记录。一个 pane 先后承载不同会话时，相应宿主/server实例的 `occupantGeneration` 更新，旧关联先失效，不把旧关系套到新occupant；未知/无宿主可null，server重启/观察断续须重新核验，不从受管bindingGeneration或reader sourceGeneration借值。

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
- MCP 工具调用是同步的；三个 harness 已同时运行同一个 stdio MCP（codegraph），pi 经 pi-mcp-adapter。本机已验证 cc 的 MCP 服务器父进程是 `claude` 本身；[A3](./probes/codex-mcp-launch.md)已评审：CLI 0.166、daemon absent 时 TUI/exec 直接启动；[补测](./probes/codex-daemon.md)在 CLI 0.166 / daemon 0.163 在场的默认路径同样 direct-stdio，不证明共享连接。每 TUI 一个 MCP 不证明逻辑来源单一。
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
                       links · runs · reports · events · contexts · idempotency · slots
                            ▲
                            │ 退出回执 / 心跳
                     hud-run（每次运行一个托管进程：启动、日志、取消、退出结果（可未知））
                            │ 可见：在 herdr / tmux 的 pane 里运行；headless：无 TTY
                            ▼
 各 harness transcript ─────┼──► HUD 采集（harness/、link/、registry 接口）──► 统一摘要 ──► bar / panel / statusline
 Herdr（integrations/herdr/：注册表、宿主、运行控制贡献）────┘
```

HUD 不依赖 hud-mcp 运行：没有账本时它仍是单 harness HUD。hud-mcp 不依赖 HUD。两者都不直接依赖 Herdr：Herdr 的 CLI 与 socket 只在 `integrations/herdr/` 里被调用，经 §6.12 的三个接口接入核心。账本只由 hud-mcp、hud-run、reconciler 这一个写者家族写；HUD 只读账本并投影，身份回填与状态迁移归 reconciler；HUD 自己的采集状态（checkpoint、摘要、采集租约）放观测存储（§6.11），写者是 HUD 采集器。

### 6.3 `HarnessAdapter`

```ts
interface HarnessAdapter {
  id: 'codex' | 'claude' | 'pi';
  glyph: string;
  resolveSource(profile: LaunchProfile, env): SourceId;
  bind(ctx: BindContext): Promise<SessionBinding | null>;      // 明确 > 注册表 > 候选；歧义不绑
  open(ref: SessionRef, checkpoint?: ReaderCheckpoint): SessionReader;
  children(ref: SessionRef): Promise<SessionRef[]>;         // 原生子代理；拓扑权威只有这一处
  capabilities: Partial<{ navigate(ref): Promise<void>; quota; goals; plan; todos }>;
}
```

bind 只解析被观察的会话；非 null 结果必有完整、来源明确的 SessionRef。没有可靠唯一选择时返回 null，不返回一个 sessionRef=null 的“成功绑定”。已知 ref 但没有 PID/宿主证据仍可进行有预算的文件读取，harness/occupantGeneration 可为 null。显式目标、注册表和 PID/cmdline 的观察选择顺序不变，但这不是01的 caller/claim 授权 resolver，也不允许以 cwd/时间候选授予委派权限。来源时间、有效性与证据强度沿用既有 ObservationEvidence/RegistryEvidence，不因返回 SessionBinding 升级为授权事实。

`BindContext`：显式传入的 session（statusline stdin、`--session`）、注册表记录、pane 进程树、cwd、HUD 启动时间。**优先级：调用方明确给的 > 注册表（Herdr 或 harness 自带）> PID / cmdline > 候选（cwd / 时间 / 最新文件）**；候选有歧义就不绑定，恢复旧会话不要求文件创建于 HUD 启动之后。

`SessionReader` 契约：

- 每次调用有预算：字节（默认 4 MiB）、记录数（2000）、时间（软 20 ms）；一般追赶返回 catching_up 并保留游标，一记录恢复字节不足则按下条返回类型化 continuation/partial。有数据且三项预算为正时，即使 I/O 等待吃完软时间也允许一次受字节/记录 caps 约束的有界消费，零预算不消费、实际超时仍计量。（consult 4 增补，F10）
- 单记录 maxRecordBytes=1 MiB 按 LF 前全部字节计（含 CRLF 的 CR）；有 LF 的最大合法记录消费 1 MiB+1 字节，无 LF 固定 EOF 完整 JSON 至多 1 MiB，另计实际签名 I/O。所有重读、预取、签名和恢复读取计入 slice/全 tick；预算不足返回共享 ReaderResult 的 `continuation?:{kind:'record_needs_larger_slice',minimumBytes:number}` 与 partial coverage，minimumBytes 覆盖本实现实际所需字节，不隐增预算、不把时间不足误称字节不足。已知私有类型跳过，超大未知行记 gap。（consult 4 增补，F10）
- 记录分类用完整 JSON 解析后的 `type`，不用行首前缀（cc 常用记录首键是 `parentUuid`）。
- 未完成记录 raw tail 仅在单个 live reader 的至多 maxRecordBytes 有界易失缓冲存在，不进 checkpoint/summary/ObservationCommit/日志/临时 bundle/嵌套编码/parser state；pendingBytes 兼容字段恒 []。普通持久 offset/摘要/去重/工具配对/时钟留在最后完整记录边界，重启从 source 重读；超大行只存 discarding 与可推进游标，跨 slice/重启有界丢弃且只计一次 gap。EOF 不完整行仍 partial/incomplete_tail。（consult 4 增补，F09）
- 截断、inode/设备变化、已检测改写/边界签名失配、压缩/分支变化明确 reset/sourceGeneration，旧锚点/摘要/transient 不接新谱系。append-only-between-observed-resets 与有界首/末已消费记录签名只给有限检测，保留 append_only_assumed_bounded_signatures 诊断；不保证任意内部历史未变，complete 仅此模型下固定输入边界覆盖，不作调用授权。（consult 4 增补，F11）
- 返回可序列化 `ReaderCheckpoint`：`fileId{dev, inode}`、`offset`、`schemaVersion`、`readerVersion`、`sourceGeneration` 与完整记录边界的恢复元数据；offset/状态/摘要/连续性/notices 同一次提交。语义改变 bump readerVersion，旧 raw-tail 缓存按07持采集租约受控失效/重建、重置连续性并删除/替换旧缓存/未发布 bundle，不仅清字节沿旧offset；公共结构不兼容另升 checkpoint schema，不改 ledger v1。（consult 4 增补，F09）

（consult 5 增补，G09）reader 生产端提取显式版本化 compact recovery DTO，热路径 inline 实际编码≤256KiB，不先序列化整显示缓存/公开长参数再删除。必要精确增长集合（Codex/Claude 去重/配对/时钟）在同source观测SQLite增量索引按ref/sourceGeneration/恢复版本隔离，引用含内容身份/边界，本slice变更与观测同事务；按需键/有界页恢复，不截断必要ID/未闭合调用/pending或近似计数。异常oversize保前完整提交/gap，合法大记录须前进；旧V8按06有界兼容/07受控重建，旧public/--json v2字段口径保留。

（consult 5 增补，G11）recovery_catching_up 表示分批恢复索引/准备进度并带明确coverage；只有恢复字节确不足才用record_needs_larger_slice/minimumBytes。全tick逐样本<50ms包含提取、prepare/witness/编码/hash/索引/SQLite等待commit及paint enqueue；共享deadline/8MiB、公平完整记录边界续读，不把重复验证/恢复改称cold或无前进重做。

### 6.4 `SessionEvidence`（收窄后的共同观测摘要）

```ts
interface Metric<T> { value: T | null; source: string; asOf: number; quality: 'reported' | 'estimated' | 'unknown' }
interface SessionEvidence {
  ref: SessionRef; cwd: string | null;
  cwdSource: 'session_meta' | 'transcript' | 'unknown'; // （consult 4 增补，F02）
  cwdAsOf: number; startedAt; version;
  model: Metric<{ id; provider?; effort? }>;          // 实际观测到的，不是配置
  context: Metric<{ used; window; afterCompaction?: boolean }>;
  spent: { tokens: Metric<TokenUsage>; costUsd: Metric<number> }; // 两项独立，costUsd必有，未知value=null；仅本节点
  activity: ActivityState;                             // §6.8
  action?: AgentAction;                                // 当前打开的工具调用
  reports: Report[];                                   // 公开报告，白名单提取
  progress?: Metric<{ done; total; current? }>;        // Codex plan / cc todos 的投影
  native: SessionRef[];                                // = children(ref) 的结果引用
  linkEvidence: LinkEvidence[];                        // 限定本轮工具结果/消息核验；正常 env 不要求 prompt claim（§6.7）
  coverage: 'complete' | 'partial' | 'catching_up';
  caps: { codex?: CodexExtras; claude?: ClaudeExtras; pi?: PiExtras };   // 类型化，不是 Record<string, unknown>
}
```

（consult 4 增补，F01）linkEvidence 为 `ToolResultLinkEvidence | LaunchMessageLinkEvidence` 的共享判别联合，仅是未裁定公开锚点。tool_result 保留原生调用身份；launch_message 有 ref/nativeMessageId/linkId/原 claim 字节的 SHA-256 指纹/eventAt，可选 launchCallId/launchCorrelationId 仅填记录实际提供值，不伪造 runId/tool/callId，不存明文 claim/整条消息/prompt。eventAt 必须是原记录有效事件时间，缺失只作无授权候选，observed-time 不补签发窗；核验条件及写者职责见 §6.7/01。

（consult 4 增补，F02）cwdSource 是 reader 的位置来源类别：Claude 合格 transcript cwd 返回 transcript，未知仍 null/unknown，不伪称 Codex session_meta。事件时间或明确首次观测时间重复读不刷新；位置不授身份、不触发 Git、不覆盖冻结 launch_cwd。claude.transcript.cwd 仅内部诊断，不另立权威；07 只明确映射到已有 transcript 出口代码，未知映射 null、不扩词表。物理 callers.cwd 不补会话未知 cwd（01/02）。

Git、项目配置、宿主健康、布局留在公共逻辑与视图组装层，不是 reader 的职责，不新增常驻服务。reader只提供实际读到的cwd及来源/时间，未知为null，不填HUD目录。组装层的`WorkspaceContext`按契约06包含`cwd,worktreeRoot,worktree?,gitCommonDir,repoId,projectOrigin`和来源/捕获时间/缺失原因：worktree仅显示名，工作树判等用有效规范根，cwd差异独立比较；根未知只说明目录不同。repoId为`SHA256(UTF8(canonicalJSON(['git-common-dir-v1',realpath(gitCommonDir)])))`，identityKind=git-common-dir-v1、scope=local，不等于SourceId/跨clone或跨机器项目UUID；同remote的两个clone不同组，普通副本无声明仍unknown。`projectOrigin={repoId,basis:'declared',declaredAt}|null`另记声明主体，不替代物理repoId/证明同仓库。

Git只用缓存，冷缺失由已有启动/采集流程每新目录/失效代次最多2子进程、200ms软预算，超时终止并留原因；不入写事务/MCP accepted热路径/paint/statusline，不每tick重探或加watcher。跨节点合计以完整SessionRef去重，带knownCount/missingCount、coverage/quality；同口径非负已报告成本部分和才可作下界，混估计则estimated且非严格下界。costUsd未知给独立Metric的null/unknown和明确缺失来源，tokens已知不补美元，Flow credits单位分开；有效零保留0/reported，不宣称免费。旧v2兼容例外归07。

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
identity: DisplayNodeIdentity; // session(ref) | delegationIntent(linkId) | 未来 job(ref)
harness?: 'codex' | 'claude' | 'pi' | 'jev'; // 仅有真实ref时的身份；意图中的预期后端另列
links: { asChild?: DelegationLink; asParent: DelegationLink[] };
run?: { runId; mode; state; locator?; exit? };      // 当前或最后一次运行
host?: { paneId?; tabId?; label?; occupantMatches: boolean };
candidates?: LinkCandidate[];          // 未确认的推断，只在 Inspector 显示
```

`DisplayNodeIdentity`由06定义。未绑定的已登记委派以稳定linkId显示键关联currentRun，不伪造sessionId/source，不因label/cwd相同合并，不计入已确认session数；不是新增授权身份或账本运行种类。首次绑定由B9合并到真实ref，保持选择映射、单父边与去重；未绑定意图从ledger事件派生时间，不造collect租约。构树仍以visited防环，同一真实ref只出现一次，总预算200/8MiB，未装载历史保留限额内身份/最后状态。状态字段用B16的freshness.state/stateKey/stateSince/stateSinceBasis及共享isRunTerminal；`run.failed`为launch_failed/non_execution，failed报告但run.running及cancelling仍非终态，不能按图标折历史。计数口径由共享投影提供，视觉交前端。

（consult 4 增补，F10）B16/B10 续读共用总 deadline/8 MiB，不能相加每 reader 的20ms；同一 live reader 可保留 transient，本 tick 不足则下个公平轮次给足一条最大合法记录的恢复 slice 并扣共享预算，不每 tick 重建/始终给小碎片造成永久饥饿。时间不足正常让出，完整解析不可抢占、实际超时仍计软预算缺陷。

### 6.6 委派 MCP（`packages/hud-mcp`）与运行托管（`hud-run`）

**定位。** 跨 harness 委派的结构化前端 + 事务账本 + 运行托管。同 harness 的调用仍用原生机制（Codex spawn_agent、cc Agent 工具）。

#### 6.6.1 工具

| 工具 | 谁调 | MVP | 做什么 |
|---|---|---|---|
| `delegate_spawn` | 父 | ✔ | `{backend, role, brief, cwd, name?, model?, effort?, mode: visible\|headless, layout?: tab\|split, predecessor?: linkId, request_key}` → 同事务持久接受意图与运行槽后返回 `{linkId, runId, state:starting, locator?}`，异步单次启动；`request_key` 以 `OwnerKey` 为范围 |
| `delegate_resume` | 父 | ✔（Codex）/ C（cc、pi） | `{linkId, mode, prompt?, request_key}` → 校验调用者是该关系的所有者；该子会话的运行槽空闲时追加一次运行，否则拒绝并返回占槽运行的状态；旧 claim 撤销，新 claim 只对这次运行有效；（consult 5 增补，G03）另接受可选 expectedRun?:RunId，提供时入参数摘要并作新意图 currentRun CAS；先权限核验、再同参重放、最后新意图门禁；缺省兼容、本地仍必填 |
| `delegate_wait` | 父 | ✔ | `{linkId \| runId, afterSeq?, until?: [...], timeoutMs ≤ 120000（实际不超过客户端超时减正余量）}` → 有界长轮询；按 linkId 等待时**进入即解析并固定 runId**，不跟随后来的运行；返回游标之后的事件与当前状态；超时不改变任何状态 |
| `delegate_status` | 父 | ✔ | `{linkId \| runId}` → 关系、运行、最新报告、托管心跳、`uncertain` 的对账证据与允许的迁移 |
| `delegate_cancel` | 父 | ✔ | `{runId, grace?}` → 校验所有者、持久接受取消意图即返回；hud-run 异步封口启动者并取消整个 scope，完整R/Q且已证明取消before_exit才cancelled；结束已证明但时序未知为ended+terminalNote=cancel_timing_unknown并释放槽；未证结束仍cancelling/uncertain或cancel_unconfirmed，after_exit已证明才解释already_ended |
| `delegate_whoami` | 子 | ✔ | `{claim?}` → 用启动时注入的 claim（env 或本次运行启动消息里的）完成握手，返回自己的 link、run、brief、report 路径、父定位；同一绑定重复调用幂等成功 |
| `delegate_report` | 子 | ✔ | `{runId, status, summary, reportPath?}` → **只接受该 run 的已绑定子**提交；写 `reports`，发事件 |
| `delegate_list` / `delegate_close` | 父 | v1.1 | 列出本调用者的关系；关闭 = 取消活跃运行 + 关 surface + `closed` |
| `delegate_send` / `delegate_ask` | 父 / 子 | v1.1 | 输入通道。实现前保留 `herdr agent prompt` 作为明确的旧通道 |
| 资源 `hud://links`、`hud://tree` | 任何 | v1.1 | 让任何 agent 查看关系与树 |

（consult 5 增补，G03）MCP resume 的 expectedRun 仅在实际提供时入 params_digest，缺省保留 params_version=1 旧编码，不把后来查到的 currentRun 补摘要。当前权限/捕获来源前提 → OwnerKey×request_key 原结果重放 → 新意图 expectedRun/槽/能力门禁；同参重放即使新轮已出现仍返回原 run，同键改 expectedRun 冲突。仅无原结果时与事务 currentRun 比较，不符 expected_run_mismatch 且零新run/claim/slot/外部提交；缺省不钉住先前 status，preparation 的runSeq/ref/绑定代次/档案仍重验。复用 A4 resumeGate/prepareResume，不新增状态机。本地 --expected-run 继续必填；B13 模板基于 status/wait 决定续跑默认携所见 runId，mismatch 重读后重新决定，禁自动换key/expectedRun连续重试（02/03）。

#### 6.6.2 账本：`~/.hud/ledger.sqlite`

事务存储（WAL、短 busy 等待、user_version 管版本），唯一写者家族 hud-mcp/hud-run/reconciler，HUD 只读，JSON只导出。完整可执行 DDL 只在契约02：本版为 sources/sessions、caller scopes/contexts、links/runs/claims/bindings、reports/events/evidence、idempotency/owner_aliases/slots，不在概念文档复制另一份 schema。

- **幂等。** 当前 canonical OwnerKey×request_key。同参重放原结果，异参拒绝。bound证据后的 proc→session 归并同事务原子重键、保留 origin_owner_key/归并事件审计，digest/link/run/outcome不变；同键异参或异结果整体拒绝，不双写或扫描关闭alias。
- **意图与槽同事务。** link/run starting/claim/幂等/槽/accepted事件原子；首次明确新会话才用 provisional:<runId>，ref晚到原子换槽。真实槽冲突双方uncertain/保留占有，阻断该ref进一步操作，不假装撤回已发动作。resume/predecessor只用真实ref。
- **单次执行与对账。** 唯一supervisor消费票据、先submitting再一次提交；未知不重发/重领票据。终结只用02的唯一R-02表：正式scope回执R、可信未执行N、无旧writer receipt也可达的Q。原harness不再执行、完整scope无活workload、所有可能launcher（含中间shell）封口/死亡且无矛盾才终结；原生结果可NULL。report/UI done/心跳过期/关pane不放槽，手动reconcile仍须证据。
- **逐run启动上下文。** spawn/resume/handover意图冻结非空规范`runs.launch_cwd`及nullable`project_origin`；nullable`workspace_snapshot`只由有效缓存随意图记录或已有run写者一次有界启动采集NULL→首次捕获，并同事务记workspace.captured。声明与Git快照分列，超时/非Git可留原因；不重启harness。后续observed cwd不覆盖历史，幂等含launch cwd/显式originRepoId而不含Git结果、显示名或写者时间。库私有ledger_metadata初始化一次ledgerId，重启/同库恢复保留，独立库新生成。
- **本地导出。** B18在MVP按需提供独立`hud link export --json --schema-version 1`，逐run启动位置（cwdBasis=launch）、已确认委派边及可选declared来源，范围/版本/隐私归07；路径仅`--paths local`，默认元数据，完整ref join，不对外承诺内部SQL/view/JSONL。toktrack消费端独立，不阻A4/A9/B15，不承诺任意/tmp副本自动归主仓库；不新增后台同步/逐tick导出。
- **轻量。** 外部读/hash/宿主CLI/发现进程均在写事务外，事务内重验当前context/版本/槽；短锁等待与总响应预算归06。接受延迟与started/bound延迟分计；status只读，不新增常驻恢复/通知服务或按秒全量对账。

关系、运行、报告分开；已证实关系resume不回pending，每run的runHandshake由claim/binding推导。MVP同owner换任务用predecessor，旧边历史化、唯一当前父边；不承诺恰好一次或外部动作必达。

**Deferred：** 跨owner grant协议/实现/DDL、handover_grants、close surface事务/owner_epoch耦合、closed重开、无MCP的observe_only三证正向绑定全部v1.1；MVP跨owner/close/无MCP正向绑定拒绝，未确认委派仍可展示且run可独立终结。共享MCP正向调度、cgroup provider、sidecar managed、自有PTY/tee与透明重接管在后续立项；Jev jobs/browser leases存储/实现与正向测试在C前定稿，MVP拒绝其执行入口。三类租约不同释放原则保留（§6.11），最小采集一致性与外发来源边界不延期。


#### 6.6.3 绑定握手

linkId/claim共现不证明会话身份。支持范围按版本/档案/模式及证据快照声明，不写所有Codex：

1. **调用来源。** 物理CallerId与逻辑context分离。ProcessKey含机器/boot/PID域/真实harness pid/start/代次；每次授权前核验唯一当前逻辑来源。原生subagent可能复用MCP，根env/session文件或祖先关系不能把子授成根；cc须经验证根调用隔离或精确当前toolUseId关联，不足拒绝。切换会话先失效旧context/alias/claim/binding，MCP重启同一当前会话OwnerKey才连续。
2. **逐轮运输。** 新run新claim（随机256bit、只存hash、首次兑换TTL30分钟），绑定source、真实启动实例与目标代次。Codex主运输是每次启动的 `-c mcp_servers.<档案服务器名>.env.HUD_CLAIM=...`，同级注入HUD_RUN/HUD_LINK/HUD_HOME；只改HUD叶子，保留command/args、其他env/server，禁止清空MCP表/整体env覆盖。source从档案及核验过的实际harness home/存储根得出，不猜MCP缺失的CODEX_HOME。resume重新注入本轮新claim，不复用旧环境。正常env不复制明文claim进prompt。
3. **首次可识别会话。** initialize无session、tools/list不足；先登记/保存claim。CLI0.166直接stdio在首次合格tools/call，用真正 `params._meta.sessionId` 与 `params._meta["x-codex-turn-metadata"].session_id` 等一致字段，交叉核验启动实例/source与精确rollout header/既有child_ref，之后逐调用检当前性。arguments._meta、模型参数sessionId、prompt不可替代来源。A3的spoof已完成且有界，Oracle批准此组合，不批准metadata单独授权或未来版本无条件保证。
4. **claim与限定核验。** claim只先到claimed；bound还须唯一当前SessionRef/独立启动会话证据，fork抢先兑换不授权，原主体可凭证据接管未绑定声明。HUD自生成launch_correlation_id；原生message/call ID允许晚到后填，不能启动前凭空要求。限定transcript只核验既有link/run的本轮工具结果/消息、签发时间窗及source/harness/唯一性，不能创建关系或替代独立身份；正常env主路径不要求扫描正文。所有回填走reconciler，HUD只读。

| 路径 | 明确规则 |
|---|---|
| 主路径 | 经验证直接stdio，每轮配置env + 独立启动/source/逐调用会话证据；版本/档案/模式限定 |
| 运输fallback | 配置env无法使用但MCP确实存在时，本轮启动/续跑消息传claim，子显式whoami；身份门槛不变，不重启已提交任务 |
| 身份fallback | 精确且当前注册记录/启动回执或限定transcript交叉核验，将进程映射唯一SessionRef；cwd/最新文件/daemon时间配对只候选 |
| unsupported | 共享MCP逻辑来源不可辨、无法观察同进程切换、source/home不明、未经验证daemon代启、MVP无MCP正向绑定；prompt claim不能补足 |

所有者操作取本次有效OwnerKey；report只接受本run当前有效MCP子绑定，旧轮迟报不满足新轮。A3已评审的有限结果及[daemon补测](./probes/codex-daemon.md)不支持外推共享调度；daemon-present不为A9前置。无MCP仅未确认展示，不凭三证自动绑定，未来最低三证门槛保留在01的deferred说明。


（consult 5 增补，G08）Caller/ProcessKey、Run ProcessStamp、Claude registry 三用途共用轻量 process-domain 派生且保既有字节：Caller为包含boot的JSON域，Run为machine-id散列+namespace并比较独立boot_id，Claude registry保原生字符串仅作适配。域类型不跨比较，不用runPidDomain回退Caller；同组已核验机器/boot/namespace缺失或矛盾保持unknown/refusal，已持久stamp/键不以当前值回填/重键。完整编码及BID1职责见01/02/04。

#### 6.6.4 运行托管：`hud-run`

每run一个托管进程；headless直接起目标无TTY、stdin brief或关闭；可见采用Oracle修订方案甲：hud-run是pane shell正在等待的前台作业，shell档案用-ic保留函数/context，harness为经核验的终端前台消费者/PGID，supervisor不读TTY；不能用`sh -c '<hud-run> &'`后台形态替代。argv逐参数spawn；可选已验证包装链最后exec外部可执行文件不另立架构，exec codex函数不证明直接子进程。完整managed shell仅经验证单次前台启动，任意shell文本不自动支持。

- meta只保留稳定启动身份/范围，局部shell/leader退出事实入evidence，最终exit.json一次fsync/rename原子提交，再幂等导入ledger并按02终结。正常scope无活workload+原harness结束+所有launcher封口可ended/cancelled，原生结果未知为NULL；shell0/130/137单列，不填runs.exit_code。
- 每5s仅一次runs心跳CAS，不周期复制meta/events/evidence；空闲阻塞，用退出/取消/恢复事件检查范围，禁原型200ms扫组常驻生产。Z单列为已终止，S/T/D仍活；范围外普通工具只诊断，确证原harness/同SessionRef旧写者仍活须阻复用。
- 取消先持久接受意图，异步封口启动者并按SIGINT→宽限→TERM→KILL覆盖整个scope；每步核验实例/域，无安全整组控制返回cancel_unconfirmed，不降单PID。只有02证据终结才释放槽。
- 父MCP/launcher退出默认continue，须单独验证子仍有TTY前台、输入、最终收尾；parent.offline事件带seq/since/冻结策略，不推子退出。stop也按完整取消/对账。vendor daemon stop称stopped不证明全部vendor启动进程已退出，参见[补测](./probes/codex-daemon.md)。
- **supervisor死亡意味着本轮交互中断。** 甲已观察前台回shell、输入落shell与tty-input挂起；立刻/失联确认后uncertain、持槽、交互不可用，禁止自动input/focus/fg、恢复wrapper、透明接管或resume副本。可读诊断，旧scope确证结束并对账后才能新开。缺旧writer receipt仍可由恢复器记录Q，不能要求死人补文件。

乙sidecar不作MVP managed后端：缺完整结束/取消/启动封口能力；保留探针反证，不能甲提交未知后自动切乙。自有PTY/tee/透明重接管延期。A8首轮拒绝，A8-fixB2关键证据已于8fdf4cf接受，限所测版本及前台形态，后台形态保留负对照；A9最小机制证据与B生产验收分开（§16/04），A8-fixB2不是工程WP B2。RunHandle固定run/locator/代次，status只读，cancel鉴权；input/focus还须occupant/交互能力核验。


（consult 5 增补，G01）headless 必要helper优先轻量、随run存活且保持不能移组的真实session/group leader，本组leader核验后发整组信号；固定控制词表、无eval、受保护输入只消费一次且EOF不可重开，stdin/控制通道分离，argv/cwd/导出函数/dotted env/PWD保持。GroupExit来源区分verified_wait/native_unknown，精确harness stamp才投影native；shell137不推harness信号，无合法shell投影也为null，完整R/Q仍scope_ended并按02分类，既有精确来源保留。现Node helper保留到B3a-R1环境/封口/取消/组实例验收；可移动reader/decoy方案不采用，visible仍修订甲。B14按06 G02正式B45/真实B2、300s/两种H/R和同环境资源/启动/故障对照，不以sh原型数值放行。

#### 6.6.5 等待、resume 与双模式

- **wait。** 有界长轮询，按 `events.seq` 游标返回；按 linkId 等待时进入即解析当前 runId 并固定，之后的新运行不满足这次等待；实际取请求值/协议上限120s/客户端实测工具timeout减正余量的最小值（05），缺可信timeout只即时返回。通知是hint、游标是事实；按run合并heartbeat/WAL唤醒，漏通知在必要截止复读。超时/断线不取消/失败，返回同run/正确游标；父pane自动提示延期。
- **resume。** 允许条件：MVP关系处于 `bound` / `reported`（`closed`重开延期v1.1），调用者的 `OwnerKey` 是关系所有者，且该子 `SessionRef` 的运行槽空闲（`uncertain` 占槽，先对账）；同一任务（brief 不变或追加 prompt）才复用 linkId 并追加 runId，旧 claim 撤销。按后端档案的 resume 模板：Codex `codex resume <id>` / `codex exec resume <id>`，cc `claude --resume <id>` / `claude -p --resume <id>`，pi `pi --session <id>`（headless 加 `-p`）。
- **本地管理与HUD动作。** 01新增同OS用户/私有HUD_HOME的local_user resume窄入口，代表已确认parent_ref的现有owner且不转移归属；actor审计UID/invocation/representedOwner，不伪造父MCP。实际命令含安全引用HUD_HOME、`--request-key`、`--expected-run`、`--mode`；先鉴别再按02同键同参重放，新意图才重验expected-run和全部resume门禁。MVP HUD的R只显示/复制03 ActionDescriptor，不起控制CLI；重复复制保留同一意图key、目标固定，入口未验证只给诊断/原父途径。未来直接调用另立可选能力，固定操作/目标/模式显式确认、可信argv执行时重验，响应未知不换key自动重试；绘制/通知/重连/uncertain不触发动作，已有writer内部恢复照04。
- **同owner换任务 = 转交；跨owner延期。** MVP仅当前同OwnerKey、真实ref、空槽/无冲突时，`delegate_spawn{predecessor: linkId}` 对同一个子会话原子建立新关系；跨owner一律unsupported。新关系成为该子会话**当前唯一的所有者与树上唯一的父边**，旧关系变为历史（`state = handed_over`），Inspector 显示谱系。不支持把 predecessor 当作"新会话的谱系"：fork 出新会话在 v1 不建关系，只作候选。
- **双模式。** `visible` 在 Herdr 内是 tab 或 split，在 Herdr 外是 tmux pane；`headless` 由 hud-run 直接起进程。两种模式在 Herdr 内同时可用，同一父可混用。headless 运行**只在 HUD 呈现**，不在 Herdr 登记；活跃时树上的动作是"看日志"，结束后才是"以可见模式 resume"。
- **能力矩阵。** 阶段 B 验证并写入文档的组合：Codex × {Herdr tab 可见, tmux 可见, headless, 结束后 resume（可见 / headless）}；split 布局、cc / pi 的 resume、活跃中的模式切换在后续阶段补。矩阵之外的组合返回"不支持"，不猜。

#### 6.6.6 后端档案 `~/.hud/delegate.json`

（consult 4 增补，F03）delegate.json v1 顶层固定 `{version:1,profiles:LaunchProfile[]}`，profile.name 唯一；未知版本、未知键和不合格类型拒绝，文件≤256 KiB、profiles≤128 等字段有界校验沿05。每 profile 包含 MCP 服务器名、已验证客户端 tool timeout/响应余量、source、argv/shell 启动、headless/resume/resumeHeadless、宿主/布局、env、claimTransport、orphan_policy；可选 `roles:Record<string,{model:string,effort?:string}>` 仅数据，不是可执行模板/额外调度器。role/model/effort 解析后的实际值和非秘密档案指纹进入02参数摘要，缺角色映射只用明确配置/请求值，不猜模型。资源约束不在本期格式，不静默接收后忽略。DelegateConfig/角色映射的权威定义收敛到 src/core/types/capabilities.ts，B1/B4/B11/B13 共用；唯一附加可选键 callSource 及 Claude-only 限制按 consult4 F06（B1b）。配置本身（含 managedShellVerified:true 或选择 callSource）不授 verified 能力；两个 skill 的配方改用此配置，仍须独立能力证据。

（consult 5 增补，G04）与delegate.json分开的受信随代码发布 CapabilityManifestV1 在core共享类型唯一声明，≤256KiB/128cells，初始空manifest未验证；完整键/source/profile/executable/拓扑/versions及受检HUD构建标识匹配，构建/发布提供不可变hudRevision而非环境/用户输入或自包含SHA循环。启动预检有界取证复用，版本占位/动态shell实际目标不可证均unverified；product五项+accepted review+空incomplete+06/A9/B14门槛才晋级，Claude父/hook双预算不漏。B14受信test-only verifier仅收证，评审后制发布manifest，不开放生产绕过（05）。

#### 6.6.7 Jev 后端

阶段C能力，jobs/browser lease DDL、实现与正向测试在C前定稿，MVP不冻结/开放其执行入口。目标仍是provider/account/key的JobRef、结果文件与Flow点数（如有）；key只发送一次，结果未知仅status/reconcile。浏览器按真实实例共锁而非账号，needs_human/失联不释放，answered/failed并对账后才释放；外部CLI与MCP不得同一时段混用。具体协议不阻塞cc→Codex。


#### 6.6.8 后续：Jev 路由（阶段 F，非 MVP）

`delegate_route{brief_summary, candidates?}` 把 brief 摘要、仓库信号和后端表作为 `state`，向 typesafe Jev（`POST /v1/systemone`，JevDev 的 `JevClient.decide` 模式）提 Choice（后端 / 角色）与 Score（置信度）问题，返回建议并写入 `links.routing{suggested, confidence, accepted}`。模式 `off | suggest | auto`，默认 `suggest`，但远程建议在 §11 的外发授权（目的 = routing，接收方 = typesafe）批准前不可用；`auto` 另需后端白名单与预算上限。MVP 只预留字段。

### 6.7 链接解析（HUD 侧）

| 来源 | 作用 |
|---|---|
| 账本里 `bound` 及之后的关系 | **唯一成链依据** |
| transcript 的约定范围核验（§6.6.3 第 4 条） | 确认或否定账本身份；缺失的父 / 子引用由 reconciler 填补，HUD 只投影 |
| 注册表 `agent_session.value`、`HUD_LINK` env、pi `--orchestrator` | 加速与交叉核验 |
| 父 transcript 的 herdr / pi-role / jev-ask 命令、tab 标签、Jev state 目录里的 key、持相同 claim 的 fork | **只产生候选**，Inspector 单独一组"疑似"，默认不读候选正文 |

（consult 4 增补，F01）LinkEvidence 不是绑定许可。launch_message 核验必须唯一对应已有 link/run 的本轮 claim 指纹、launch_call_id、launch_correlation_id、精确原生消息及原事件时间窗，完整 SessionRef/source 与独立启动/会话证据齐备；不凭首条消息、同 claim 的历史复制或发现时间推本轮，不新增 transcript 建关系路径。B4 冻结 fallback 运输格式/correlation（正常 env 不重复明文），B8 只抽取，B9 限定核验/候选冲突投影；回填/撤权交 B2/B5 reconciler 事务，HUD/B9 读取不成为新写者。

两条互相矛盾的显式记录或两份都匹配的 transcript：显示冲突，停止归属，不按时间取近。pane 当前 occupant 与运行定位不符（`occupantMatches = false`）：关系保留为历史，不显示宿主状态，跳转前再校验。关闭 pane 后关系与最后状态保留。

### 6.8 状态模型

一个节点同时持有五个维度，再投影成一行：

| 维度 | 取值 | 主要来源 |
|---|---|---|
| `activity` | working / waiting_input / idle / exited / unknown | 注册表（仅当绑定实例匹配且新鲜）> transcript 最近事件 > 托管进程 |
| `pendingReason` | none / approval / question / needs_human | transcript 的审批 / 问题记录；Jev 的 NEEDS_HUMAN；注册表 `blocked` |
| `lastTurnOutcome` | none / completed / failed / interrupted | transcript 的 turn 结束事件；`reports`；`runs.exit_code` |
| `liveness` | alive / gone / unknown | 托管心跳 / 注册表 / 进程；进程存在只证明存在 |
| `freshness` | `{state:fresh\|stale\|unknown,...来源时间/截止/错误明细}`，消费者比较freshness.state；缺来源unknown | B16选择来源并定义总体state，事件时间与观测时间分开 |

合并规则：注册表回答"当前交互是否 busy / blocked"，不覆盖明确的 turn failure；Herdr `done` 被查看后变 `idle` 是正常现象，用 `completion_seq` 识别完成观测；`unknown` 回退到有效文件证据；旧 transcript 里永不闭合的工具调用不推断 running 超过一个阈值；父 idle 而子 working 显示"idle，1 child working"。notice 只由 `pendingReason` 从 none 变为其他、`lastTurnOutcome` 变为 failed、新 `reports` 行、运行进入 `uncertain` 触发，切 tab 不触发。归并器是独立模块（计划书 B16），完整真值表是它的单测，契约 03 / 06 只定义维度与来源优先级。

06拥有语义状态`stateKey/stateSince/stateSinceBasis`：B16按语义及必要原因/episode选择边沿，不含视觉桶；新run/新待决周期重置，重读/心跳/usage/语言/排序不重置。已证事件用event，首次看到用observed，无可靠时间/连续性为null/unknown；随B12同一ObservationCommit持久，重启可恢复可证连续性，丢历史不假装持续。状态驻留以nowMs派生，uncertain/stale的证据年龄另用lastEvidenceAt/心跳，零逐tick写。ledger asOfSeq仅本次快照高水位（无库null、空库0），独立observationStamp记录实际输入run/ref/代次/序号；旧run摘要不得补当前run，无跨库原子保证，status/wait不触发采集/Git/reconcile/摘要发布。

### 6.9 注册表接口

核心只认 `RegistryProvider`（§6.12）。Herdr 实现只在 `HERDR_ENV=1` 且 `HUD_HERDR≠0` 时装载，按 Herdr server 共享一个轮询器（默认 3 s），所有 HUD 进程与 hud-mcp 实例读同一份缓存。cc 的 `~/.claude/sessions` 是 harness 自带注册表，由 cc 适配器提供。没有实现时返回空列表，核心照常。事件订阅留到阶段 F。

### 6.10 宿主与运行控制

```ts
interface HostAdapter {                       // 画面与焦点
  openSurface(layout, opts: SurfaceOptions): Promise<SurfaceLocator>;    // tab / split / tmux pane；可注入 env
  runInSurface(locator, commandText): Promise<void>;  // 把 hud-run 命令敲进该 pane 的交互 shell
  locate(ref | runId): Promise<SurfaceLocator | null>;
  focus(locator): Promise<void>;              // 先校验 occupant
  sendKeys(locator, keys): Promise<void>;
  attachIdentity(harness): void;              // HERDR_AGENT=<harness>，不再硬编码 codex
}
interface RunControl {                        // 核心，基于 RunHandle 与账本
  status(runId); cancel(runId, grace?); reconcile(runId);
  sendInput?(runId, text);                    // 由宿主或 v1.1 工具提供
}
```

普通宿主/注册表定位统一使用05定义的 `SurfaceLocator`，保留宿主地址、实际可得ProcessStamp及独立nullable occupantGeneration，不含runId/bindingGeneration。`SurfaceOptions={cwd,env,managed:Pick<RunBinding,'runId'|'bindingGeneration'>|null}`：普通调用显式managed=null；已接受受管run提供真实上下文，不要求提前完成子握手。未知occupant/实例不因null==null匹配，stale/unknown拒控制但不阻已知session有预算读取。普通focus/navigation按已声明且校验能力；SessionBinding/locator不授report/resume/cancel权限。RunControl只接真实run，受管HostLocator/RunHandle必填字段不放宽。

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
ledger.sqlite                            关系 / 运行 / 报告 / 事件 / 调用者 / 幂等 / 运行槽（浏览器租约阶段C）（写者：hud-mcp、hud-run、reconciler；HUD 只读）
runs/<runId>/{meta.json,stdout.log,stderr.log,exit.json}
sources/<sourceId>/checkpoints/<session>.json   reader checkpoint（观测存储，写者：持采集租约的 HUD 采集器）
sources/<sourceId>/summaries/<session>.json     会话摘要（消费者读）
sources/<sourceId>/leases/<session>.json        采集租约：holder、generation、expires_at
sources/<sourceId>/{scan,agent-log,model-cache,recaps,model.json,outbound.json}   按 source 隔离；模型授权与外发授权不跨 source
instances/<hudInstance>.json             布局 / 点击状态
settings.json                            显示设置；不含模型连接
delegate.json                            后端档案
```

三类采集数据分开：checkpoint、摘要、实例状态。**三类租约分别定义，不共用"过期即放行"：**

| 租约 | 存放 | 释放规则 |
|---|---|---|
| 运行槽 `slots(session_ref)` | 账本 | 只在运行确认结束（回执或对账证明）后释放；`uncertain` 继续占槽；失联不等于结束 |
| 浏览器 `browser:<cdp_url>` | 阶段C的账本扩展 | 任务 answered / failed 并对账后释放；needs_human 期间持有；失联不释放 |
| 采集 `collect:<session>` | 观测存储 | 按代次接管：新持有者 generation +1 并写入；旧持有者的迟写（generation 落后）被拒绝；过期可接管 |

心跳与内容更新时间分开，不用mtime代表存活。五个版本域独立：public snapshot v3、checkpoint schema、ledger `user_version`、`SCAN_VERSION`、本地delegation export v1；内部编号相同不表示兼容，export不改旧--json。旧 `$CODEX_HOME/hud/` 在阶段A–D保持可读、不自动迁移。

（consult 5 增补，G05）B12/B16共用checkpoint.ts的ObservationBoundary/ObservationBoundaryWitness/ObservationCandidate及checkpointBoundary/witnessObservationBoundary，同ReaderResult捕获边界后唯一归并；witness只是可信一致性断言/防错摘要，不授真实性/写入/执行权，细则归06。

（consult 5 增补，G06）collect写权仅同一ObservationStore实例成功acquire(g+1)后取得，readLease/重开/同holder不继承；每次写与接管同事务验租约/来源/previousCommitSeq。默认15s TTL、≥5s续约及sampled high-water/last_now不变；倒退/不可判只读，不保证跳钟后真实15s接管，不逐tick持久写钟，正常release再close/崩溃重新竞争，不授运行槽权。

（consult 5 增补，G10）上列checkpoint/summary/lease路径是概念职责划分，本期物理发布选同source观测SQLite：不可变checkpoint/精确索引/current projection引用在同一fenced事务构成一个ObservationCommit。prepareCheckpoint生成可信opaque内容身份及边界，publishPrepared每次重验lease/CAS；readProjection只读已提交summary/continuity/notices/stamp及checkpoint身份边界，不解码recovery/跑reader；readRecovery仅采集恢复且同commit。summary-only/no-op复用已验证不可变内容，不重建/hash全历史/反复deserialize，不贴当前ledgerSeq到旧摘要；兼容readCurrent不进status/wait/paint热路径，回收沿受控发布/重建无后台GC。

（consult 5 增补，G11）reader语义bump readerVersion，结构不兼容升对应checkpoint/观测私有格式并拒旧writer；持lease受控替换旧缓存、重置不可证连续性且保sourceGeneration/gap，禁止删payload沿旧offset。ledger v1/export v1/public/旧--json版本独立；三路径no-op/summary-only/新checkpoint及大参数/长期ID/多消费者全链预算与定向崩溃/lease/通知证据归06/07及B14，不放宽tick。

（consult 5 增补，G07）B11本地export只消费既有core/export-query.ts的queryDelegationExport私有metadata-only入口，B2底层/B18受限投影共同维护schema回归；native readOnly/busy_timeout=0/单快照rows+high-water，尽早结束事务后在复制输入编码，完整JSON备妥再输出。无需搬模块/broad reader/公开SQL，不等B16/B6/B17；07的10000runs/16MiB/1000ms及隐私/历史端点边界保留。

### 6.12 Herdr 集成层（独立）

目的：继续适配 Herdr，但把它关在一个可整体关闭的目录里，核心功能不随 Herdr 的 CLI、schema 或可用性变化。三个职责：

| 职责 | 核心接口 | 核心默认实现 | `integrations/herdr/` 实现 |
|---|---|---|---|
| 注册表 | `RegistryProvider`：`list()`、`get(locator:SurfaceLocator)`、`sessionOf(locator:SurfaceLocator)`；记录使用SessionBinding及SurfaceLocator | 空；cc 自带注册表由适配器提供 | `herdr agent list / get` 轮询缓存 |
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
现有代码不搬目录，先用 facade 实现 `HarnessAdapter`：`SessionFinder` → `bind`，`RolloutParser` → `open`（补 checkpoint 导出与预算），`buildSubagentTree` 的扫描 → `children`，quota / goals / plan → `caps.codex`。`SCAN_VERSION` +1。`linkEvidence`：`response_item` 里 hud-mcp 工具的 function_call_output。resume：`codex resume <id>` 续写同一 rollout，daemon 绑定已经识别 resume；headless 用 `codex exec resume <id>`。A3已评审的直接stdio/配置env及metadata有界结果见§6.6.3；未验证共享/切换路径仍拒绝，观察resolver不等于授权resolver。

### 7.2 Claude Code
- 绑定：stdin 的 `session_id + transcript_path` > 注册表 `agent_session.value` > `~/.claude/sessions/<pid>.json`（校验 `procStart`，注意 PID 域）> 候选。
- 读取：完整 JSON 解析，只保留 `user`、`assistant`、`system`（compact_boundary）、`attachment.toolUseResult`、`ai-title`、`last-prompt`；`api-request-blob` 等按类型跳过。内容白名单：`text`、`tool_use`、`tool_result` 的公开字段；`thinking` 不提取。
- usage 按 `message.id` 去重；上下文窗口来自 stdin 的 `context_window` 或模型表。
- 原生子代理：`subagents/*.meta.json` 为节点，`toolUseId` 对上父的 `Agent` 调用；`.jsonl` 用同一 reader；`finished` 缺失不等于完成。后台 Bash 任务作为 action。
- `linkEvidence`：`mcp__hud__delegate_*` 的 `tool_result` 与首条用户消息。
- resume：`claude --resume <id>` 续写同一 transcript（headless：`claude -p --resume <id>`）；绑定不要求文件创建于 HUD 启动之后，普通观察不递增受管代次；真实受管resume的bindingGeneration按01/02分配，reader sourceGeneration按06读取谱系变化，宿主占用变化独立核验occupantGeneration，三者不得代用或共用计数器。

### 7.3 pi
- 绑定：pane 进程 cmdline（`--session-dir`、`--session`、`--role`）> 注册表记录 > 候选。
- 读取：`session`、`model_change`、`thinking_level_change`、`message`、`usage`、`compaction`、`custom`（`ask_orchestrator` 事件作 pendingReason）。图片块与大工具记录按上限跳过。
- 口径见 §6.4；无原生子代理。
- resume：`pi --session <path|id>`（headless 加 `-p`）；`--session-id` 可指定精确 id。[A3](./probes/pi-resume.md)已测1.4.0的--session续同文件/id、--fork新id；完整模式/包装链在C验收，新文件没有可信连续性不合并。
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
hud run resume <linkId> --request-key <key> --expected-run <runId> --mode <visible|headless> # 显式HUD_HOME；01本地管理入口
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
- **Agents 列表**：树行前缀harness图标；delegated行显示标签、运行模式与状态；headless活跃行看日志，满足门禁的结束行显示/复制可见resume命令（MVP copy-only）；Jev行显示provider/产物，冲突单列；可见行回车/点击按interaction/occupant门禁聚焦。Resume/Reconcile的类型化动作与固定目标归03，前端不维护另一套迁移规则。
- **卡片**：pi 多一行 cost；cc 显示 `agentType` 与 `description`；Jev 显示 key、provider、产物路径；delegated 卡片显示 run 序号与退出码；Codex 照旧。
- **Inspector**：新节"链接"（关系状态机、握手方式、核验结果、时间）、"运行"（runs、托管心跳、日志路径）、"疑似"；新节"覆盖"（reader coverage、跳过的记录）。
- **顶部**：被外包方视角显示"父：<harness> <name>（<pane>）"，父未确认时显示"父：未确认（caller …）"。
- 文案全部过 `t()`，中英两表；bar 仍英文。

## 11. 隐私与安全

- **本地读取范围**：当前绑定会话与原生子代理默认读；账本确认（`bound` 及之后）的 delegated 会话的公开内容默认读（可设为只读元数据）；候选默认只读元数据。
- **模型材料范围**：新来源（cc / pi / Jev / delegated）的正文进入任何模型功能默认关；已有 Codex 授权不自动扩展；所有模型功能与缓存经同一个材料构建入口做范围检查，不只 brief。
- **外发授权**：`sources/<id>/outbound.json` 按（目的 × 接收方）逐项授权，例如 brief → api 端点、routing → typesafe；摘要授权不自动覆盖路由；未授权时远程建议关闭；`auto` 执行权限与预算另算。
- 每个适配器先做正向的公开内容白名单再生成材料；`thinking`、reasoning、请求 blob、未知类型不提取、不保留、不展示、不外发。
- 统一的材料构建入口与"新来源默认不外发"是独立实现工作包（计划书 B17），带负向测试：旧 Codex 授权开启时，cc / pi / delegated / Jev 的正文仍不得出现在任何模型请求或缓存里。
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
| **B MVP 纵向切片：cc → Codex** | `packages/hud-mcp`：调用者登记、账本、七个 MVP 工具（spawn / resume / wait / status / cancel / whoami / report）；`hud-run` 托管进程；Codex 后端档案（launch / headless / resume 模板）；核心宿主（tmux 可见 + headless）；`integrations/herdr/` 三职责实现（tab 可见、注册表、输入 / 就绪）；cc 绑定与最低限度 reader（身份、模型、上下文、活动、`linkEvidence`）；最小采集租约（多消费者）；树显示 delegated Codex 节点及其原生孙辈，headless 行的"日志 / 打开"；Inspector 链接与运行节；`hud claude`（tmux 宿主）与 `--resume`；最小 `hud panel` 入口（验收场景需要）；`herdr-delegate-codex` 改调 MCP；子代理角色模板加 whoami / report；能力矩阵文档；B18版本化本地委派元数据导出（producer属MVP，consumer独立） | 真实场景一：cc 在 Herdr 里可见模式启 Codex implementer，握手到 `bound`，树正确、状态随运行变化、关 tab 后历史保留。真实场景二：headless 启 Codex 子会话，结束后可见模式 resume，同一节点两次运行；活跃时 resume 被拒。`HUD_HERDR=0` 下场景二照样通过。并发重试、启动中断、旧 run 迟报、fork 复制 claim 的单测；MCP 在 cc 与 Codex 两侧都能加载 |
| **C pi 与 Jev 后端** | pi adapter + `hud pi`；cc 与 pi 的 resume 模板与实测；`herdr-delegate` 改调 MCP；Jev 后端（浏览器实例锁、key / send / wait、`uncertain` 对账、needs_human）+ JobRef 节点；pi 的 MCP 加载 | 三 harness + Jev 节点同树；pi cost 与 compaction 口径单测；pi / cc resume 真实场景；Jev 节点 sent → answered 与 needs_human 两个真实场景 |
| **D cc 完整与 statusline** | cc 原生子代理、后台任务、todo 投影；reader checkpoint + 完整采集租约；`hud statusline`（stdin 优先）；性能基准（冷启动、增量、超大单行、无结尾换行、重写、宽树、多消费者）；功能对照清单；`--install` / `--restore` | §9.3 三道门：清单 + 基准 → opt-in 观察期 → 可回滚切换 |
| **E 整理** | `hud panel`（herdr 宿主）完整版；Codex 目录搬迁（可选）；改名、`HUD_*`、迁移工具；v1.1 工具（list / close / send / ask、资源）；文档、i18n、README | 迁移往返测试；旧命令退役公告 |
| **F 后续 feature** | Jev 路由 `delegate_route`（suggest 默认，外发授权后可用，auto 需白名单与预算）；pi footer；Herdr 事件订阅；delegated 节点模型摘要；其他 Herdr kind | 各自单独立项 |

**设计验收案例（每阶段回归）：** 同 cwd 多会话与双 home；cc 根与多个子代理共 sessionId；同 pane 换会话 / resume；握手晚到、claim 过期、fork 复制 claim、链接重复、冲突、循环、关闭后保留；并发重试、启动中断、`uncertain` 对账、旧 run 迟报；stale / unknown 注册表；重复 usage 与压缩；panel / watch / statusline 并发；迁移后新来源仍未获模型外发授权；Jev needs_human 与重复 key。

**顺序理由：** A 先把执行协议写定并用探针消除最大未知；B 先验证主要收益（G3）并用第二种 transcript 格式检验接口；D 才动用户每天看的 statusline；E 才改名搬目录。

## 14. 风险

- cc transcript 大且类型多：预算 reader + 类型跳过 + coverage 标记；基准分别测冷启动与增量，并说明追加量、硬件与分位数。
- Codex daemon 可能代启 MCP 服务器：A3 必须验证 MCP 与会话的基数关系和每次调用的可信来源；不能隔离就把该路径标为不支持，不用 prompt 里的 claim 冒充会话识别。
- 账本写者分叉：HUD 一旦写账本就会和 reconciler 争写；规则是 HUD 只读，所有回填走 reconciler，代码评审按此检查。
- 租约误放行：运行槽与浏览器租约失联不释放，只有确认结束才释放；采集租约按代次接管并拒绝旧持有者迟写。
- MCP 同步调用：`delegate_wait` 有界长轮询；长等待配合后台 `herdr agent wait` 或循环。
- 外部动作非恰好一次：意图记录 + 托管进程 + 对账；`uncertain` 不重试。
- Herdr 之外：外包状态来自托管进程与文件；跳转不可用；headless 档案要单独测试。
- 子代理没加载hud-mcp：MVP仅未确认展示、不建确定SessionRef父边、不准report/猜resume；三证正向绑定v1.1，run退出仍独立按02/04取证。
- Jev 浏览器串行与 NEEDS_HUMAN：按实例持锁；人工介入进 notice；CLI 与 hud-mcp 不同时段混用。
- 替换 claude-hud 的功能缺口：三道门，缺一不切；故障标准先写。
- 重构范围：A 只加 facade、契约与探针；搬目录放到 E。
- Herdr 层漂移：Herdr 升级只影响 `integrations/herdr/`；schema 校验不符就降级；降级只在启动未执行时。
- headless 运行的可见性：Herdr 里看不到；靠树、notice、托管日志；进程被杀时账本靠退出回执与对账收尾，不伪造完成。
- resume的身份连续性：实际当前SessionRef必须等于已有child_ref；pi A3已测续同文件、fork新id，完整C能力仍待验，新文件不凭路径猜连续性。
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
| 2026-11-01 | claim 绑定到 runId、来源、启动实例与会话代次；到 `bound` 另需启动回执或可信会话证据；同一绑定重复 whoami 幂等；工具校验所有者 | Pro 第三轮 §3① |
| 2026-11-01 | 撤销"恰好一次"的说法；幂等以 `OwnerKey` 为范围，MCP 重启不绕开；意图与运行槽同事务；对账为"证据 → 允许迁移"表；`failed` 只在证实未执行时成立；取消确认退出后才终结 | Pro 第三轮 §3② |
| 2026-11-01 | 可见模式的 hud-run（方案甲）以 A8 探针为准，备选 sidecar + 最小回执（方案乙）；缺回执保持 `uncertain` | Pro 第三轮 §3③ |
| 2026-11-01 | wait 按 linkId 时进入即固定 runId | Pro 第三轮 §2 |
| 2026-11-01 | HUD 只读账本；身份回填与状态迁移归 reconciler；采集状态放观测存储 | Pro 第三轮 §6-1 |
| 2026-11-01 | 三类租约分别定义：运行槽与浏览器只在确认结束后释放；采集租约按代次接管 | Pro 第三轮 §6-2 |
| 2026-11-01 | `predecessor` = 转交：新关系是子会话当前唯一所有者与唯一父边，旧关系为历史；fork 新会话不建关系 | Pro 第三轮 §6-3 |
| 2026-11-01 | daemon 代启 MCP 且无可信会话来源的路径标不支持 | Pro 第三轮 §3① |
| 2026-11-01 | 状态归并器（B16）与材料入口（B17）作为独立实现工作包 | Pro 第三轮 §4 |
| 2026-11-01 | v2.3 为阶段 A 开工基线；阶段 B 实施基线在 A9 按不变量、失败用例、探针证据放行 | Pro 第三轮 §1 |
| 2026-11-01 | 首次 spawn 尚无子 SessionRef 时，运行槽以 `provisional:<runId>` 占位，只允许全新会话；身份解析后同事务换成真实 ref，真实 ref 已被占则双方进 `uncertain`、都不启动 / 续跑；resume 与 predecessor 必须带实际 SessionRef | 编排者（A1 提问），A9 复核；Oracle 追认 |
| 2026-11-01 | 未绑定父的 OwnerKey（ppid + procStart）在绑定证实后经 `owner_aliases` 单向归并到 SessionRef 范围；一个 proc 范围每代次至多映射一个会话；代次 +1 时 alias 关闭；归并冲突一律拒绝、不启动 | 编排者（A1 提问），A9 复核；Oracle 修改：原子重键到 canonical session 范围 + 审计，不双写（C01） |
| 2026-11-01 | 无 hud-mcp 的子：pending → bound 只凭启动回执 + 可信会话证据 + 启动消息的 transcript 核验三项同时成立，由 reconciler 写；缺一项最多候选；§14 对应条目按 §6.6.3 收紧 | 编排者（A1 提问），A9 复核；Oracle 修改：三证正向绑定推迟到 v1.1；MVP 只展示未确认身份、拒绝授权（C03） |
| 2026-11-01 | `predecessor` 转交只在调用者 OwnerKey 等于旧关系所有者时允许；跨所有者转交需旧所有者签发、reconciler 核验的凭证（格式归契约 03），定义前返回 unsupported；知道 linkId 不构成授权 | 编排者（A1 提问），A9 复核；Oracle 追认 |
| 2026-11-01 | 调用者身份拆为物理 `CallerId` + `caller_contexts`：每个 context 各有 SessionRef 绑定与代次；专属 stdio 实例恰好一个 context；共享（daemon）实例的 context 只由可信逐调用来源建立，无此来源则能力标不支持，但模型与 schema v1 不变 | 编排者（A1 主审发现），A9 复核；Oracle 修改：保留物理 / 逻辑分离；MVP 只实现经验证的直接 stdio，共享正向调度推迟；原生子调用不得冒充根（C02） |
| 2026-11-01 | 受管范围默认 = 经核验的 harness 进程组（headless 由 hud-run 建组；可见方案甲里交互 shell 的作业控制会另建组，须发现并核验 harness pgid + pid + 启动时间，信号前重验；A8 评审）：该组空 + 票据围栏 + 回执即可终结，shell 退出状态本身不是回执；setsid / 重父化逃逸的后代不在受管范围，不阻止终结、不授予执行权，可检测时记诊断事件；回执记 `scope_kind`（pgid / cgroup），环境提供独占 cgroup 时覆盖逃逸后代；sidecar 只有 leader 级回执 | 编排者（A1 第二批提问），A9 复核；Oracle 修改：Q 不要求已死 supervisor 的回执；scope 无活 workload + 原 harness 结束 + 启动者封口即可终结，退出结果可为空（C07、C08） |
| 2026-11-01 | 跨所有者转交凭证：256-bit 不透明 nonce、账本只存 hash、旧所有者签发、绑定旧 link / 子会话 / 所有者代次 + 目标 OwnerKey + 过期、reconciler 在转交事务中单次消费；契约 03 只定内部接口，公开工具（grant / revoke、spawn 参数）推迟到 v1.1，此前跨所有者转交不支持 | 编排者（A1 第二批提问），A9 复核；Oracle 推翻分期：grant 协议、实现与 DDL 整体移到 v1.1，MVP 只拒绝跨所有者（C04） |
| 2026-11-01 | 关系状态只表达已证实的父子身份，resume 不回退 `pending`；每轮握手是 run 级投影（`runHandshake`）；resume / handover 的新一轮必须绑定到关系已记录的 child SessionRef，不同则该 run 进 `uncertain`、不改写 child_ref；`closed → bound` 重开须满足槽空闲与所有者校验，保留 close 历史 | 编排者（A1 第二批提问），待 Oracle 复核；Oracle 追认；`runHandshake` 由 binding / claim 推导、不另存；closed 重开语义留 v1.1 规格 |
| 2026-11-01 | 新增 G13 轻量与快、G14 清晰可视化与低摩擦协作；性能与正确性同级，契约 06 写定预算，基准超预算即缺陷 | Jacob |
| 2026-11-01 | 后端设计与架构交 Oracle（Codex `gpt-6-astra` effort max）裁决；Pro 只在关键节点（A9、B15 或 Oracle 上送）。此前编排者在 A1 中做的裁决（本表标"编排者"的各行）连同契约 01–04 与探针结论打包送 Oracle 追认或推翻 | Jacob |
| 2026-11-01 | Oracle 第 1 次裁决（[reviews/2026-11-01-astra-contracts.md](./reviews/2026-11-01-astra-contracts.md)）：Codex 身份主路径 = 每轮 `-c mcp_servers.hud.env.*` 注入 claim + 逐调用 `_meta` + 启动实例 / source 核验；daemon-present 不是 A9 前置；可见模式采用修订后的方案甲（原生退出结果可未知，supervisor 死亡即交互中断、`uncertain`、持槽），方案乙不作 MVP 受管后端，PTY 方案推迟；A9 改为两级门禁（A9 审规格 + 最小合成进程原型 + A3/A8 可行性证据，生产验收在 B）；契约必改 14 项 C01–C14 | Oracle（Codex gpt-6-astra max） |
| 2026-11-01 | 账本的委派边（调用方 / 子会话、各 run 的 cwd 与工作树根）将作为 toktrack 追踪调度关系与项目归属的可选权威来源；toktrack 继续以 transcript / git 推断兜底。对外读取接口（版本化只读导出，倾向 `hud link export --json`，不让外部直接读 `ledger.sqlite`）、字段与隐私范围待 Oracle 裁决，toktrack 侧适配在 B2 之后 | Jacob；Oracle 第 2 次修改：版本化只读 `hud link export --json` v1（一致快照、`ledgerId` 命名空间、路径须 `--paths local` 显式开启、仅元数据），生产导出器为 B18（MVP 内、独立于 toktrack 消费端）；不承诺自动认出任意临时副本（D06–D08） |
| 2026-11-01 | Oracle 第 2 次裁决（[reviews/2026-11-01-astra-consult2.md](./reviews/2026-11-01-astra-consult2.md)）：`stateSince` 由 06 定义、B16 计算、随观测提交持久（零逐 tick ledger 写）；工作位置分 `cwd` / `worktreeRoot` / 显示名 `worktree` / 本机 `repoId`（git common dir）/ 显式 `projectOrigin`，`runs.launch_cwd` 逐 run 冻结，Git 不进热路径；HUD 的 Resume / Reconcile 在 MVP 只显示并复制命令，另定窄的本地管理 resume 入口（`--request-key`、`--expected-run`）；`costUsd` 为必有 nullable Metric；`holderLabel` 留 C4；A4 补未确认委派显示键、`freshness.state`、`launch_failed`、跨存储快照戳；必改 13 项 D01–D13 | Oracle（Codex gpt-6-astra max） |
| 2026-11-01 | Oracle 第 3 次裁决（[reviews/2026-11-01-astra-consult3.md](./reviews/2026-11-01-astra-consult3.md)）：intent 无 sourceGeneration（判别联合）；R/Q 已证结束而取消先后未知 → `ended` 释放槽并记 `cancel_timing_unknown`，只有已证 before_exit 才 `cancelled`（推翻 A4 默认）；export v1 四个字段各有封闭代码表、未知→null；证据按事实时间约简（追认）；export 直接给出逐 run `operation`；普通会话用 `SessionBinding`（必有 SessionRef、`managed: RunBinding|null`）与无 runId/bindingGeneration 的 `SurfaceLocator`；必改 E01–E06 | Oracle（Codex gpt-6-astra max） |
| 2026-11-01 | A9 阶段门禁（[reviews/2026-11-01-chatgpt-pro-a9-gate.md](./reviews/2026-11-01-chatgpt-pro-a9-gate.md)）：**带条件放行**，三组阻断无 P0。冻结前三项 P1 已修（A9-fix）：N（未执行证明）与 R/Q 同为不可逆证明边界，其后的目标 workload 活跃反证归一为持久 X、后续 gone 不清除；supervisor 完整 ProcessStamp 在登记事务内写入既有事件载体，恢复以其为权威、缺证 unknown、禁止以当前域补写（schema v1 DDL 不变）；v3 快照只留一份权威类型（nullable rootRef，计数 `confirmedSessions` / `delegationIntents` / `jobs`）。七份契约与 schema v1 据此冻结，阶段 B 开工；B 内条件与开工顺序见工程计划 §4 | ChatGPT Pro（ARCH）；计数名由 ORCH 按契约 06 的 `delegationIntent` 节点名定 |
| 2026-11-01 | Oracle 第 4 次裁决（[reviews/2026-11-01-astra-consult4.md](./reviews/2026-11-01-astra-consult4.md)，冻结后增补，F01–F11）：共享观测类型补 launch_message LinkEvidence 与 cwdSource `transcript`；delegate.json v1 envelope `{version, profiles}`、可选 roles 与唯一附加键 `callSource`；callers.cwd 是物理 MCP 自身 cwd（不迁移 DDL）；本地 cancel/reconcile 用独立 `trusted_local` 管理主体，authorizeControl 的 local_user 仍只限 resume；**Claude 调用来源选同步 PreToolUse 精确记录档案**（显式档案、有界原子发布、scope 代次前提），现有 Node hook（p95 61 ms）不放行，须证明 hook 启动至 MCP 响应的联合 p95 < 50 ms，达不到由 ORCH 上送 Pro 决定 MVP 范围或预算；原生子只拒自身、/clear 与双 MCP 走共享账本换代；**任何持久 checkpoint 不存未完成记录原始字节**（A4/A6/RolloutParser 一并改，readerVersion 递增），重读一条记录的 slice 与共享 continuation；transcript 完整性只在 append-only 假设下有限保证 | Oracle（Codex gpt-6-astra max） |
| 2026-11-01 | F08 预算裁决（[reviews/2026-11-01-chatgpt-pro-f08-hook-budget.md](./reviews/2026-11-01-chatgpt-pro-f08-hook-budget.md)）：选 A，保留 Claude→Codex MVP。仅显式 `claude_pre_tool_use_v1` 档案的联合时间（必需 hook 最外层冷进程启动至同次调用响应 flush，含授权、DB 等待/commit）p95 < 150 ms；MCP 内部仍 p95 < 50 ms；B5 授权与事务总墙钟 ≤ 30 ms，单次 busy_timeout ≤ 10 ms，累计等锁/重试 ≤ 20 ms。G13 仍是硬门禁（只匹配七个 HUD 工具、按次启动、无常驻服务/轮询）；B14 另收 ≥ 200 次真实联合调用（跨 ≥ 10 次 harness 启动、每声明路径 ≥ 20 次）。取代 Oracle 第 4 次裁决 F08 的成本门槛，F06/F07 不变 | ChatGPT Pro（ARCH），经 Oracle F08 上送 |
| 2026-11-02 | Oracle 第 5 次裁决（[reviews/2026-11-02-astra-consult5.md](./reviews/2026-11-02-astra-consult5.md)，G01–G11）：headless 改用随 run 存活、不可移组的轻量 session-leading helper，native exit 缺可信来源时为 null（G01，B3a-R1；现 Node helper 保留到替代通过）；B14 资源口径（G02）；MCP `delegate_resume` 增可选 expectedRun，提供即入摘要并作 CAS 前提，省略保持事务内取当前 run，本地仍必填（G03，B45-R2）；能力格 `CapabilityManifestV1` 随代码发布、绑定受检构建、全 unverified 起步，仅经 review/B14 晋级（G04）；B12 boundary witness/候选提交为 B12/B16 共用接口、实例内 lease 写权、B18 私有元数据投影追认（G05–G07）；两种 pid_domain 编码保留，共用 `src/core/process-domain.ts` 派生，禁止跨表示比较与回退（G08，BID1）；checkpoint 改紧凑 recovery DTO（inline ≤256 KiB）、增长集合进同库增量索引、prepare/publishPrepared/readProjection/readRecovery 分离与不可变内容复用，tick 预算不放宽（G09–G11，B12R）。契约文字统一由 O5APPLY 落实。 | Oracle（Codex gpt-6-astra max） |
| 2026-11-02 | 进程生命周期必须有界：hud-mcp 随所服务的会话退出，hud-run 随运行收尾，委派出去的 agent / 会话（含可见 pane 中完成后空闲的 harness、评审者）在报告、取消或空闲期限后按明确规则回收，并有并发上限；不得随委派次数无限增加进程。B14 验收：N 次委派后进程数与内存回到基线。回收规则与可见模式自动收尾和"禁止自动输入"的边界交 Oracle 第 6 次（Q8） | Jacob |

## 16. 评审状态与下一次评审

v2.3仍为阶段A开工基线；[Oracle consult 1](./reviews/2026-11-01-astra-contracts.md) C01–C14及[consult 2](./reviews/2026-11-01-astra-consult2.md) D01–D13约束七契约，不是A9放行。A3五份探针已主审通过，Codex有界spoof已完成；[daemon补测](./probes/codex-daemon.md)是CLI0.166/daemon0.163在场direct-stdio有限证据（脚本exit=2、后续清理不改pass），非共享支持/A9前置。[A8](./probes/hud-run-visible.md)首轮拒绝，A8-fixB2关键证据已于8fdf4cf接受：同agent/session状态、实际context命令、父launcher退出后TTY输入/收尾；限所测版本和pane shell等待hud-run的前台形态，后台负对照仍失败。工程WP B2及生产取消/复用/性能/真实父MCP故障矩阵仍由B验收。

A4补类型/nullability/所有权/双域快照戳与合成fixture：stateKey/stateSince/basis连续性、WorkspaceContext及逐run冻结位置、local_user发起/重放与ActionDescriptor、export v1 golden、独立costUsd Metric、显示身份联合/freshness.state/launch_failed/共享终态谓词；反例清单见01–07各A9标签。同证据重启不重置、无DB变化越stale截止、历史缺口/新episode、两同名intent绑定、同仓库worktree/同remote clone/普通与声明副本、包装改cwd/路径消失、ledger run-b+观测run-a等都只作规格/fixture，不提前合入B产品代码。外部consumer字段清单不重阻A4/A9；B18 producer为MVP、toktrack接入独立。B6最终status依B16，B16连续性发布依B12，同一ObservationCommit供B10完整驻留读取；可先做纯归并/ledger子集，不当最终验收。

**两级门禁：** A9审支持范围、可执行事务/状态规格与fixture、最小真实SQLite/合成进程原型及关键A3/A8可行性证据；A阶段可做隔离原型，不提前合入B生产实现。B3/B4/B5/B14对生产实现重验关键反例和完整能力矩阵。各契约每条测试标A9（fixture/prototype）、B、C或v1.1；延期正向流程/DDL/测试移出MVP，不把全部B验收列为A9前置。

| A9阻断组 | 最小不可缺证据 |
|---|---|
| 身份 | cc→Codex唯一source/session；每轮配置claim运输；fork/旧claim不授权；同进程切换失效；MCP重启OwnerKey连续；共享/不可辨原生子明确拒绝。未支持daemon/无MCP只验拒绝，无共享正向集成前置 |
| 执行 | 真实临时SQLite+合成进程：并发同键一次提交、异参拒绝、意图/槽同事务、归并重键后重放原结果；意图commit后/提交前后/回写前崩溃均不重发，不只用内存对象模拟互斥 |
| 恢复 | 已选甲的A8接受证据；scope正常结束、活成员阻终结、取消未确认持槽；supervisor死后无旧receipt的Q可达或列明缺证；恢复只观察/收尾、无新执行权。原型可行性不替代B生产能力 |

三类租约释放差异、HUD只读/写者边界、逐轮权限、nullable原生结果、手动reconcile、最小采集一致性及外发材料来源边界仍是必须保持的不变量。下一次阶段边界评审仍为A9，送ChatGPT Pro审七契约和上述证据包；不以文档修订/结构检查PASS冒充门禁证据。
