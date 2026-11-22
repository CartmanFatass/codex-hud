> Implementation update, 2026-11-07: the owner approved this revision and parallel implementation, then selected direct development on `universal-hud`. The proposal-time pause statements below are historical. Implementation and verification status is tracked in `docs/cloud/hud-thin-implementation-flow.md`; approval is not evidence of completed validation.

# codex-hud 完整重置方案：本机官方会话、HUD 观察与 MCP 薄接口

**修订版 2 · 2026-11-07 · Oracle 审阅稿，尚未实施。**

本稿替换上一版中关于版本检查、恢复和主动唤醒的错误安排。已对照当前工作树逐文件审计，并纳入官方接口和参考项目的补充核验。**本轮只更新此方案文件，没有修改仓库、启用后端、启动真实任务或推送。**

代码基线：`hud-refactor-20261107`，分支 `dots/simplified-runtime-recovery-20261107`，HEAD `f9818714bf2afee9d7724b65aa6b00b0c4e62d89`，连同未提交的适配器修改及 `src/managed/manager.ts`、`store.ts` 草稿。以下行号对应这次审阅的工作树，不是未来稳定锚点。

## 1. 功能目标和职责，先于实现

**HUD 是本机各 harness 的统一观察界面，以及让模型调用官方会话和现有 Jev Ultra Fast 的 MCP 接口。它负责连接、传递、直接归属和展示，不成为第三个模型、审批者或调度器。**

| 层 | 应负责 | 不负责 |
|---|---|---|
| 调用方模型及其 harness | 发什么任务、如何答复子会话请求、是否继续、验收结果、是否中断 | 不需要理解 HUD 的 task/report/handover 状态机，因为不再有这套状态机 |
| 被调用的官方 harness | 原生会话、轮次、工具、权限、子代理、运行状态、历史和恢复 | 不由 HUD 重新实现 agent loop 或覆盖默认权限 |
| HUD MCP 与本机连接宿主 | 校验原生会话归属，调用公开接口，保持连接，传原生消息，通知原调用会话 | 不判断任务是否成功，不自主批准、不自动重试模型输入、不调度接力 |
| HUD 界面及现有总结 | 显示原生状态、日志、调用关系、已有指标和模型总结 | 不把展示推测变成控制权或另一套运行真相 |
| Jev MCP 包装 | 调用现成 Agent API，返回原始快照/产物 | 不重写浏览器 agent，不加入网站政策或任务引擎 |

这与 `docs/universal-hud-concept.md` 原来的统一显示、跨 harness 调用、Jev 包装和减少重复 skill 配方目标一致，也回到“不改 harness 行为、不做任务队列/调度器”的非目标。

### 已确定的范围，不再列为待决策

- **只做本机。** 使用本机安装的 harness、原生会话记录、进程及本地通信。没有 Windows 原生适配或跨机器控制工作项，也不为它们预建抽象。
- **用户的 harness 持续更新。不得要求固定版本、精确版本白名单或机器资格矩阵。** 不因版本号变化拒绝使用；只报告实际调用中缺失的公开能力、协议错误或启动错误。
- **逐原生会话隔离保留。** 共享目录、配置或 MCP 服务，不等于共享子会话控制权。
- **父退出默认继续。** 官方活连接从一开始就由独立宿主持有，不依附前台 MCP 的寿命。
- **原生 session ID 恢复和主动通知均在本次实现内，不后置。** 使用官方恢复接口；通知接回项目已有 Codex queue、Claude 后台通知、Pi extension。
- **保留现有模型总结。** 不新增“基础统计/增强摘要”产品分层，不重新开发总结服务。
- **没有 HUD 审批、任务语义裁决、自动停机/重试/接力。** 需要决定的内容传回调用方，按其模型和 harness 规则处理。
- **Jev 仅包装现成能力。** 不用旧 fake job ledger 代替真实后端。
- 此前暂停的 HUD 聊天 UI 不在这次自动恢复；现有 bar、panel、statusline 保留。

## 2. 当前代码为什么不能直接接上

当前默认入口仍是：

```text
packages/hud-mcp/src/main.ts
  ├─ createManagedNativeRuntime → 精确版本/指纹/资格匹配
  └─ DelegationService → ledger runs/reports/slots → supervisor/retirement/wake drainer
```

新写的 `NativeManagedTools` 目前是 opt-in，尚未接入默认入口；它又依赖另一套 `SessionManager` 和 `managed_sessions/managed_operations`。因此，“适配器用了官方接口”不等于整体已经薄：**入口前后仍各有一层自建控制系统。两套都不能继续作为新路径的基础。**

目标接线改为：

```text
本机原生会话 A
  → HUD MCP：取得可信原生来源，检查直接归属
  → A 的按需后台连接宿主：只持有连接、关联消息
      ├─ 用户安装的 Codex app-server
      ├─ 官方 Claude Agent SDK → 用户安装的 Claude 可执行文件
      ├─ 用户安装的 Pi --mode rpc
      └─ 现有 Jev Ultra Fast Agent 的薄桥

原生消息/交互请求
  → 正在等待的 MCP 调用；或既有 native wake 通道通知 A 来读取

HUD bar/panel/statusline
  → 原生读取来源 + 宿主收到的原生事件 + 直接调用关系
  → 现有 SmallModel/ProgressSummarizer/RecapStore 展示链
```

宿主不是新的 agent runtime。它只补足一个官方接口不能替 HUD 做的事情：**前台退出后，仍有人持有 SDK Query、app-server/RPC 管道及回调。** 复用 `hud-run` 的命令入口和独立进程形态，不复用它的 ticket、claim、kill ladder、retirement 或 task 状态机。

## 3. 官方连接、状态与恢复：逐项对应

### 3.1 Codex

- 创建：`thread/start`；续接已有 ID：`thread/resume({threadId})`，随后 `turn/start`。明确要 fork 时调用官方 fork，返回新官方 ID。
- 输入：普通新轮用 `turn/start`；调用方明确要求向进行中的轮次补充时用 `turn/steer`。不由 HUD 根据文本猜测该 steer 还是开新轮。
- 读取：`thread/read`、`thread/loaded/list`、`thread/status/changed`、`turn/completed`。官方 `notLoaded/idle/systemError/active` 等值直接保留，不转成 HUD 的 task 成败。
- 双向请求：app-server server request 的 ID、方法、payload 原样送回来源；响应走对应 request。官方撤回/已解决事件用于清除该回调，不另设批准人或默认批准结果。
- 停止：只把调用方的明确中断传给官方 turn interrupt；连接释放与后台工具是否全部终止不混为一谈。
- **采用用户当前安装的 Codex。** `app-server-transport.ts` 的 JSON-RPC framing、request ID 关联可保留。版本号只用于诊断，不能作为准入。

Paseo 的 `ensureThreadLoaded()` 就是先 `thread/loaded/list`，未加载则 `thread/resume`；这足以支撑会话恢复，不需要另建恢复数据库或资格框架。

### 3.2 Claude

- 用官方 Agent SDK `query({prompt: 输入流, options})` 持续收消息；`options.pathToClaudeCodeExecutable` 明确指向用户实际安装的 Claude，不能默默换成 SDK 附带的固定旧客户端。
- 原生 session ID 来自 SDK。恢复用 `resume: sessionId`，仍是该会话；只有明确 `forkSession` 才创建新 ID。
- 状态/输出来自 SDK 消息、公开结果、callback 和实际进程事件。HUD 不给 Claude 另造一套假装官方提供的统一状态枚举。
- `canUseTool`、elicitation/dialog 等公开 callback 是传输端点，不是 HUD 的审批入口。传公开字段并保留 SDK 的原生响应结构；SDK 自己构造 wire 信封的部分不声称由 HUD 原样复制。
- 中断/关闭走公开 Query API，不加进程树强杀，不覆盖用户 permission/settings/background 配置。只清除会导致子会话冒充父来源的 HUD 身份字段，不能笼统删除所有用户 `HUD_*` 设置。

Orca 的参考价值是直接 `query({prompt: inbox.messages, options: ...})` 和回调接线，不是其产品自己的权限 UI 或 descendants 清理政策。

### 3.3 Pi

- 主路径用用户安装的 `pi --mode rpc`，保持一条持久 JSONL RPC 连接。直接适配公开协议；官方 helper 足够时可复用，但不能让 helper 缺一个方法成为新增 runtime 或政策的理由。
- 当前 `rpc-adapter.ts:49` 默认从锁定依赖解析 `rpc-entry` 并启动包内 Pi，这会把用户客户端更新绕开。**删除这个默认运行时来源，改用配置/本机发现的真实 Pi 可执行文件。**
- 状态直接用 `get_state`：`sessionId/sessionFile/isStreaming/isCompacting/pendingMessageCount`。历史用 `get_entries`，以原生持久 entry ID 续读。
- 恢复用官方 `switch_session({sessionPath})`，由官方 session ID 与 sessionFile 定位；不把数据库中的 HUD 状态拿来恢复。普通输入用 `prompt`，`streamingBehavior` 的 `steer/followUp` 由明确调用参数表达。
- 观察自动工作结束要按官方 `agent_settled`，不能只见 `agent_end` 就判任务完成，更不能用无输出时间猜。
- `extension_ui_request/extension_ui_response` 是官方双向协议，按同一个 request ID 往返。当前 public RpcClient helper 没暴露回复方法，不等于 Pi 不支持；这次薄 RPC 接线应补全，不再返回伪造的永久“能力缺失”。Pi 自带的请求 timeout 仍由 Pi 管。
- Pi 原生扩展继续用于可靠的当前 session 来源和主动唤醒。它只做公开 API 适配，不做工具审批。终端专属 custom UI 在 RPC 中的限制仍按官方能力如实说明。

Cindy 的可借鉴部分是本机 spawn 与双向 RPC，以及区分管道断开和进程退出；不复制 SSH、强杀链或其他产品外围。

### 3.4 官方恢复与进程存活不是同一个概念

**会话恢复是基础能力，进程永生不是。** 父端退出时后台宿主仍活，子连接继续；宿主或机器真的退出后，使用上述官方 session ID/文件续接历史。续接不是恢复原 OS 进程、未完成 callback 或已经死掉的工具进程。

Herdr 的现有设计也区分这两件事：关闭 client 不结束 background server 中的 terminal；server/machine 重启后恢复布局并 resume 支持的会话，不宣称旧进程还活。HUD 只需沿用这个清楚的边界，不需要“高级恢复平台”。

## 4. 官方状态是唯一真相，HUD 只保存自己实际产生的事实

| 数据 | 从哪里得到 | 本次处理 |
|---|---|---|
| 会话 ID、状态、轮次、回答、usage、原生子代理 | 官方 API、事件、日志和历史 | 直接读取或转发；可以格式化显示，不能重新裁决 |
| 活连接是否断开、进程是否退出 | socket/stdio 事件、进程 exit 与原生 stderr | 分开展示这些事实，不推导“任务失败/全部工作已停” |
| 未回复的原生请求 | 活连接的 callback/request | 内存中关联原生 ID；原生撤回/超时生效，不写审批状态表 |
| HUD 发起的直接调用归属 | 收到 MCP 调用时已经知道的父原生身份与随后返回的子 ID | 记录这一条直接边；不需要多层 claim 或反推 |
| 展示摘要、缓存、读取游标 | 已有 HUD 展示功能 | 保留；缓存注明来源/新旧，不得控制后端 |

### 持久记录的上限

只需一类 HUD 自有关系记录：

```text
父原生 SessionRef + MCP callId → 子原生 SessionRef / Jev 实例与 owned target
```

记录本机来源位置、创建时间、原生 sessionFile 等定位信息即可。后台 endpoint 属于活连接定位，不是会话状态。因为官方 Codex 不会替 HUD 记录“哪条 Claude 会话经 HUD 创建了我”，这条跨产品关系确实不能从某一官方后端直接取得。

**不保存**任务状态、operation 状态、推断完成、占槽、批准结果、wake 重试/消费状态或恢复阶段。MCP request ID 与官方 turn/request ID 的关联保留在持有活连接的宿主内存中；原生历史能读取时直接读取。

现有 `src/ledger/schema.ts:143` 的 `links` 表有必填 `state/role/brief_path/task_digest`，并强依赖旧 caller context 链，不能直接塞一条关系就声称已简化。实施时让新的关系存取独立于这些旧语义：复用现有私有存储位置，但只提供上面的关系记录；不迁入 `runs/reports/claims/slots`。旧数据保留只读，不删除用户历史，不要求把它改写成新语义。

`src/managed/store.ts` 的 `managed_sessions/managed_operations` 两张草稿表**删除，不启用**。`manager.ts` 不能换名字继续保留它们。

不存在需要新建的持久“唤醒已读账本”。官方接受排队不等于模型已经处理。没收到某次调用回执时，返回已有原生 ID、可读历史和实际错误，供调用方检查；不自动重发，不加永久 uncertain 占槽，也不承诺跨进程 exactly-once。

## 5. 主动唤醒：本次接回已有路径，不另建通知系统

通知的内容只说明“这个原生会话有新结果/请求，来读取哪个会话或请求”。不说“任务已成功”，不带新的执行决策。触发源是收到的原生结果或请求事件，而不是后台语义扫描。

| 父端 | 项目已有接线 | 本次保留/修改 | 实际适用条件及验证边界 |
|---|---|---|---|
| Codex | `src/core/wake/adapters.ts` 已 spawn `codex queue --thread <id> --message <text>` | 提取这条直接调用，绑定原父 thread 与其本机 CODEX_HOME；保留 stdout/stderr/exit 原意，移除旧 run/ledger 通知内容 | 官方 queue 已 Stable；本执行器仅跑过 `--help`，未真实发送。若要唤起未加载 thread，官方 `--resume` 需要本机 daemon；不能把 exit 0 当作已经处理，resume 失败可 warning 但仍 exit 0 |
| Claude | `src/cli/run-wait.ts` + `integrations/skills/hud-delegate/SKILL.md` 已有原生后台命令结束产生 `<task-notification>` 的路径 | 保留“原生后台 waiter 结束→Claude 通知”形态；waiter 改订阅宿主的原生请求/结果，不读 `runs/reports`、不执行 old retirement。父端按现有原生 background task 用法建立 waiter | 曾有 P-N1 实测观察到通知；重复稳定性、忙时行为及实际 `run_in_background` 完整路径仍须本机验收。普通 MCP 工具返回不能冒充会自动唤醒 Claude |
| Pi | `integrations/pi/hud-wake.ts` 已监听本机 socket，核对当前 session 后 `pi.sendMessage(...,{triggerTurn:true,deliverAs:'followUp'})` | 保留现成扩展调用；payload 改为原生来源、目标和请求定位，移除 `linkId/runs/throughSeq/contextGeneration` 旧账本语义 | 扩展必须实际加载，session 仍是目标。官方 API 已核实；项目 idle/streaming/RPC 实测仍待完成。父端关闭后不可假称活扩展还在 |

`packages/hud-mcp/src/wake-registration.ts` 只保留根据可信父原生来源选择通道的作用。宿主收到事件即向该通道传递，**不接入 `wake-drainer.ts` 的 ledger scheduling/retry-slot/capacity，也不新增替代账本。** 等待中的 MCP 可以直接返回原生事件；主动通道用于没有阻塞等待的父端。去重只限同一连接内实际事件 ID，不能成为任务级调度。

Claude 另有官方 Channels：本机 MCP 声明能力并发 `notifications/claude/channel`。但它是需显式加载、组织允许的 research preview，当前仓库没有实现，不能冒称已接好。**本次主路径是已有 background waiter**；安装环境确已使用 Channels 时，可以把同一通知直接接过去，不因此开发第二个通知平台。官方 `asyncRewake` 也与普通 async hook 不同，不把两者混用。

父端已退出或通知路径实际不可用时，报告该通道的事实，**子会话继续**。同一父原生会话恢复后重新建立来源/通知连接、读取官方历史；不偷偷给另一个父会话转交权限，不后台重试到某个“成功状态”。三种通道都不能声称拥有“模型已阅读/已执行”的 ACK。

## 6. 一次调用和整个存活周期

1. **进入与隔离。** 每个 MCP 调用取得真实原生来源。保留现有可信来源适配的有效部分；模型传入的 owner、cwd 相同或版本字符串都不能证明身份。若确实取不到必要身份，只说明该调用无法安全绑定，不猜共享 owner，也不因此禁止其他只读显示。
2. **按需持有。** 为该原生来源找到或启动独立后台连接宿主。宿主只保存活句柄及消息关联，不启动 supervisor 政策链。前台只连接宿主，不能拥有子后端的最终寿命。
3. **创建/恢复。** 使用用户选择的 harness 和本机配置调用官方 new/resume/fork。官方 ID 一返回就记录直接关系。SDK 尚未给 ID 时如实返回“ID 尚未提供”，不制造一套 child claim 握手。
4. **发送/等待。** 输入通过官方接口发送一次；返回原生回执、turn/message ID 和后续消息。`wait` 的超时只结束这次等待；不触发 cancel、不把超时写成任务失败。
5. **双向请求。** 原生请求传回原父会话，必要时用上一节通道唤醒。调用方模型/harness 决定答复，HUD 按目标和 request ID 回传。请求在原生侧已撤回就返回该事实，不能自己编出 deny/allow。
6. **轮次返回。** 返回官方结果或原始输出。模型自行判断是否已经完成用户任务；HUD 不再要求 report/handover/验收标志才能继续下一轮。
7. **父退出或 MCP EOF。** 前台关闭自己的连接和 waiter，后台继续持有并读取官方管道。继续消耗输出避免管道背压；显示缓冲有界，完整历史从官方读取。不因父断开、面板关闭或静默时间结束子会话。
8. **同一父恢复。** 用相同原生身份连接活宿主；宿主已不在则使用官方 session ID/文件恢复。恢复是明确会话操作，不是数据库自动重放任务。新建的另一原生会话不会自动继承旧父的子连接。
9. **明确停止。** `interrupt` 只映射官方中断，`close` 只执行说明过的对应连接/会话关闭。不能自动扩成整组进程强杀。官方未保证外部后台工具全部结束，HUD 就不作此保证。
10. **实际故障。** 原生日志/错误和真实进程退出是依据。管道断开、进程退出、会话可恢复分别说明；不增加 reconciler、心跳判死、自动修复、故障状态库。记录失败时报告记录失败，不能顺手杀已启动的后端。

宿主没有活连接时可退出。对仍活的连接不新增 max-age、idle retire、blocked timeout 或默认并发额度。不是所有存活问题都由 HUD 自动“解决”。

## 7. Jev Ultra Fast：把现有方法暴露为 MCP

已核实上游 API：`Agent(url, goals, record_dir=None, screenshots=False)`，`run()`、`snapshot()`、`command()`、`close()`。按实际参数包装，不发明不存在的暂停/恢复能力。

- `packages/hud-mcp/src/server.ts` 已有 `AuthenticatedToolExtension` 接口，可增加一组 Jev tools；共享现有来源解析和归属检查，不经过 DelegationService。
- 现有项目是 TypeScript，Jev 是 Python。需要时只加一个本机 JSONL 薄桥调用上述 Agent，持续持有同一实例；这不是新 agent 引擎。
- 同一层 MCP 的 source + callId 创建了哪个 Agent/owned CDP target，直接记下来。targetId/sessionId 来自实际实例，不通过 tab 标题、时间或模型回答推断。
- run/snapshot/command 的原始结果与上游状态返回调用方；HUD 不重复判断目标达成或编制 job ledger。
- `Agent.close()` 会关闭 owned tab。blocked/CAPTCHA 时保留现有实例/页面，交给原调用方或用户；不能用 `finally`、context manager 退出或等待超时自动 close。
- `src/core/link/job-display.ts` 当前是明确的模拟 job 投影，不是 Jev backend。真实展示改读实际 snapshot；fake 只留在测试里。
- 上游自身未提供的恢复/执行能力如实返回。没有新浏览器池、全局串行调度、站点策略、Jev 替代模型或逐 harness skill 适配。

## 8. 逐文件实施清单

“删除/不接入”指停止新默认路径对该控制逻辑的依赖并清除失效入口；不是立即永久删除用户历史。旧文件若仍被历史只读功能引用，可先隔离，确认无生产调用后再删。不能用“兼容旧链”作为新路径继续受其控制的理由。

### 8.1 主入口与公共边界

| 代码位置 | 决定 | 具体处理 |
|---|---|---|
| `packages/hud-mcp/src/main.ts:88–126` | **改** | 移除新路径对 `createManagedNativeRuntime`、`verifiedClientTimeout/shippedManifest`、`DelegationService` 的依赖；接来源解析、薄工具、本机宿主客户端。EOF/finally 只关前台，不能关子后端 |
| `packages/hud-mcp/src/server.ts` | **保留/瘦身** | 保留 MCP 协议、每次来源解析、`AuthenticatedToolExtension`；不把旧 ledger service 设为工具必需条件 |
| `packages/hud-mcp/src/managed-tools.ts` | **改** | 保留会话操作接口和逐原生 principal；去掉 `ManagedScope/grant/operator` 通用策略层。参数定位官方 nativeRef/turn/request，不再要求持久 operation 状态 |
| `packages/hud-mcp/src/tools.ts` | **改** | 工具说明明确“官方会话操作/原生结果”；移除新路径要求 task/report/handover/claim 的参数和提示，不为模型虚构工作流 |
| `src/managed/types.ts` | **重写边界** | 保留 NativeRef、原生请求/响应、连接事件；删除统一 `TurnResult.status=succeeded/failed/handled_no_turn/uncertain` 业务裁决和 operation 生命周期。不同官方 payload 用 harness 区分，不强行统一其语义 |
| `src/managed/manager.ts`，`store.ts` 草稿 | **不接入/拆除** | 删除两表状态机、scope/grant、maxSessions/占槽、`#touch`、持久 operation、自动 failConnection→close；仅提取必要的活连接映射和请求路由 |
| `src/core/run/cli.ts`、`bin/hud-run` | **改入口** | 增加或整理一个纯连接宿主入口，独立于旧受管 runtime。复用 detached/unref 形态，不走旧 ticket supervisor |
| 新的小模块，例如 `src/managed/host.ts`、`relations.ts` | **必要新接线** | 前者持活连接/原生回调/本地 IPC；后者只存直接关系。不得以新文件承接被删的任务、审批、恢复或 wake 状态机 |
| `packages/hud-mcp/src/config.ts` | **简化** | 保留本机可执行文件、原生参数/cwd/用户明确设置；新路径删除 claimTransport、资格要求和 `RETIRE_DEFAULTS` 自动退休参数。不能隐式替换原生权限/工具发现 |

现有 `managed_*` 名称可少改，但语义必须改对：`managed_create` 支持官方 new/resume/fork；`managed_send` 只发输入；`managed_ask` 若保留只是 send+wait 便利组合；`managed_wait` 用 nativeRef 与原生轮次/游标读取；status/list 读原生事实；requests/respond 对原生回调；cancel 仅官方 interrupt；close 明确对应关闭行为。**工具数量不应反过来要求一套 operation 数据库。**

### 8.2 精确版本和资格门槛，必须完整去除

| 实际代码依据 | 本次动作 |
|---|---|
| `packages/hud-mcp/src/resolvers.ts:285/296` 比较 Codex `0.166.0`；`:197` 比较 Claude 固定版本 | 删除这些版本准入判断；保留真实来源、会话及 tool call 的关联检查 |
| `packages/hud-mcp/src/managed-runtime.ts:19/164/257/261` 的 `VERSION` 和 executable/observed 版本匹配 | 整条旧 runtime 不进入新调用链，不是把常量改成新版 |
| `src/harness/claude/managed-command.ts:4`、`managed-launch.ts:72/77` 固定 Claude `2.1.305` | 新 SDK 路径不使用该启动资格链；清除面向用户的固定客户端要求 |
| `packages/hud-mcp/src/hook/record.ts:20/154`、`hook/resolve.ts:61`、`hook/command.ts:44` 固定 Claude 版本 | 当前来源 hook 仍需要时，保留原生事件字段和调用归属，移除客户端精确版本校验/盖章 |
| `extensions/pi/hud-delegate.ts:15` 明确 `VERSION !== '1.4.0'` 就 throw | 删除这条断言和固定版本注释；扩展使用当前官方 API，真实缺方法时指出该方法 |
| `src/harness/pi/delegation-context.ts:36–37` 固定 Pi 版本/profile，且绑定 session header format 3；`delegation-channel.ts:72/85` 固定版本标记 | 使用原生 extension context 的 session ID/file 和实际私有通道来源；不依赖客户端版本、commit 或硬编码历史文件 header 来授予身份 |
| `packages/hud-mcp/src/pi-host.ts:21–29/71` 限定包版本、bundle 路径和 hello 版本 | 删除对消费者安装布局/版本的冻结；保留实际本机来源通道及进程/会话对应关系 |
| `src/harness/pi/managed-launch.ts:22/197/237` 固定 print-json profile/版本/commit | 不接入新 RPC 主路径，也不能作为 fallback 带回 |
| `src/core/launch/capability.ts`、`src/core/capability-manifest.ts`、`src/core/launch/fingerprint.ts`、`codex-cells.json`、`managed-cells.json` | 从普通运行准入中移除版本/内核/Node/机器指纹资格矩阵；已测环境可以是测试记录，不能是允许使用官方 API 的白名单 |
| `src/cli/launcher.ts:171–172` 的 `trusted.verify/capability_unverified`；`src/cli/claude-launch.ts` 的旧 SourceReceipt/fingerprint 管线 | 普通启动改为原生启动与必要来源接线，不允许 CLI 入口继续绕回来按旧资格拒绝 |
| `src/cli/capability.ts` | 保留可执行文件发现和诊断信息，去掉 manifest 准入作用 |
| `src/harness/pi/rpc-adapter.ts:49` 包内 `rpc-entry` 默认；Claude SDK executable 选择 | 实际调用用户安装的 Pi/Claude，不通过内部依赖偷偷固定其 harness |
| 根 `package.json` / lockfile | 开发依赖可锁定以复现构建；这不授权限制用户客户端版本。Pi CLI 不作为必须随 HUD 锁死的消费者 runtime；SDK 依赖按公开接口维护并测试更新 |

私有 HUD wire schema 版本、必要字段检查、软件依赖兼容声明不等于厂商客户端精确版本准入。可以维护自己的消息格式；**不能把厂商版本号不同当作字段/方法一定不兼容。** 对新增字段保持可透传；真正不兼容时返回实际 method/error 与日志，保留其他可用功能，不自动降级到另一后端。

### 8.3 三后端与旧控制层

| 代码位置 | 决定及动作 |
|---|---|
| `src/harness/codex/app-server-transport.ts` | **保留** JSON-RPC、流、请求关联与 respond；核验 legacy server request 的原生关联字段，不另建审批身份 |
| `src/harness/codex/managed-adapter.ts` | **改** 为 thread/turn 原生接口与原始事件；补官方 read/resume/steer；移除统一业务结果判定 |
| `src/harness/claude/sdk-adapter.ts` | **保留官方连接，改外围**：用户实际 executable，公开输入流/callback/resume；删除将 SDK 事件再次裁成 HUD task 状态的部分，不抑制官方后台工作 |
| `src/harness/pi/rpc-adapter.ts` | **改** 为当前本机 Pi 的持久官方 RPC，补 response/get_state/get_entries/switch_session；删默认 30 分钟 observation timer 断连接，以及 queued/handled/暂未取得最终文本就判断开并 stop 的链条 |
| `src/harness/pi/rpc-transport.ts`、`rpc-observation.ts` | **不整体复用**：旧实现有 `--no-session`、30 秒 deadline/kill、sourceCommit observer 等。最多提取 framing/request 关联，不作为第二套 Pi backend |
| `packages/hud-mcp/src/delegation.ts`、`handshake.ts`、`managed-runtime.ts` | **退出新主路径**：不再使用 task/report、claim 或冻结运行环境的委派框架 |
| `src/core/execution.ts`、`lifecycle.ts`、`supervision.ts`、`capacity.ts` | **不作为新控制权威**：旧状态机、槽位、生命周期裁决不能影响官方会话 |
| `src/core/run/control.ts`、`group-leader.ts`、`group-pipe.ts`、`process-census.ts`、`retirement-policy.ts`、`retirement.ts`、`retirement-evidence.ts`、`runtime.ts`、`ledger-port.ts` | **不接入新宿主**：移除默认自动退休、整组强杀、通过证据重建终结状态的路径 |
| `src/core/run/process.ts` 等混合模块 | 只提取真实进程观察/自有句柄处理，不能因为需要 exit 信息就引入整套 kill policy |
| 旧 Codex exec、Claude print、Pi print-json 实验链 | 不与新官方主路径并行控制同一会话，不作未授权自动 fallback |

### 8.4 通知、界面与现有总结

| 代码位置 | 决定及动作 |
|---|---|
| `src/core/wake/adapters.ts` | 提取现成 Codex queue 和 Pi socket 发送；去掉旧 WakeRegistration/账本语义依赖，不把通知辅助命令异常扩成后端停止 |
| `src/core/wake/message.ts`、`projection.ts` | 删除“ledger is the truth”、run terminal/retry/generation 状态投影；通知只指向原生会话/请求，waiter 命令改指向宿主 |
| `packages/hud-mcp/src/wake-registration.ts` | 保留可信 nativeRef→既有通知通道的直接选择，不持久化新的通知状态机 |
| `packages/hud-mcp/src/wake-drainer.ts`、`wake-state.ts`；`src/ledger/notify-events.ts` 的新路径写入 | **不接入** ledger 调度、重试槽、capacity、消费账本；旧历史如需读可保留 |
| `src/cli/run-wait.ts` | 保留 Claude 原生 background waiter 的用途，改读宿主原生事件；删新路径对 runs/reports、owner generation 和 lifecycle waitPage 的依赖 |
| `integrations/pi/hud-wake.ts` | 保留真实 session 校验与 `sendMessage(triggerTurn/followUp)`，替换旧 ledger 请求结构；不限定 Pi 厂商版本 |
| `integrations/skills/hud-delegate/SKILL.md` | 更新为现有通知用法与会话工具说明；删除旧资格/report/handover 配方。不增加每个 backend 的 Jev skill |
| `src/index.ts`、`src/tree-page.ts`、`src/cli/statusline.ts`；现有 harness reader/rollout collectors | **保留**成熟展示和原生读取，补新的直接关系和原生事件来源，不重写 UI |
| `src/core/link/view-model.ts` | 新会话节点不再通过 capacity/statusProjection/report/reconcile 控制；移除硬编码 `resumable:false, reason:'capability_unverified'`，恢复动作直接走官方 API |
| `src/core/link/*` 观察/发布模块 | 保留有用只读链；旧状态推断只能留作历史展示，不能作为新会话当前真相 |
| `src/core/link/job-display.ts` | fake job 仅测试；真实 Jev 节点来自 Agent snapshot |
| `src/tree-page.ts:426–436`、`src/collectors/small-model.ts`、`progress-summary.ts`、`recap.ts`、`briefer.ts`、`model-jobs.ts` | **原功能保留**。现有 SmallModel 统一 queue/cache/hourly cap 是展示模型调用设施，不是需要新建的任务调度器；不重写、不另加摘要层 |
| `src/cli/digest.ts`、`src/core/materials/delegated-digest.ts` | 若现有展示仍需要摘要输入，接原生回答/材料；不能为了旧 completed report gate 保住任务状态机，也不能误删整个现有总结体系 |

## 9. 真实不变量和验收，不以“用了官方 SDK”代替结果

| 必须验什么 | 对应实现/测试安排 | 通过标准 |
|---|---|---|
| 消费者可持续更新 | 改 `managed-native-isolation`、Pi source/hook 测试；扫描所有固定版本分支 | 相同公开接口、不同版本字符串仍可用；实际缺方法只报该能力错误；没有隐藏 manifest 准入 |
| 实际运行哪个客户端 | 三 adapter 的 spawn/query 断言 | 使用配置/发现的本机可执行文件；Pi 不再默认启动包内锁定 CLI，Claude 不默默换旧 binary |
| 原生隔离 | `tests/hud-mcp/managed-native-isolation.test.ts` 等 | A/B 同配置仍不串；回应只到正确原生请求。缺真实来源不伪造 owner |
| 创建、恢复、再输入 | `managed-codex-*`、`managed-claude-sdk`、`managed-pi-*` | 官方 ID 保持/变化符合 resume/fork；宿主重启后用官方历史恢复，无 HUD 恢复状态库 |
| 官方状态直通 | 同上，增加真实原生 payload fixtures | 不以时间、文本、数据库投影重判；Pi 按 agent_settled，不凭 agent_end 或静默判完 |
| 请求完整往返 | 三后端原生 request/callback 测试 | 原父端取得 payload、答复回同一请求；官方撤回/timeout 不被 HUD 改写；Pi UI response 真通 |
| 父退出继续 | 新宿主集成测试，临时 HOME，真实本机再验 | 父正常退出/被杀、MCP EOF、wait 超时、面板关闭都不结束子连接；超过旧 30 分钟阈值也不被 HUD stop |
| 三种主动通知 | 改 `b10a-wake.test.ts`、`b21-notify.test.ts` 及本机 notify probes | 接收到真实结果/请求后进入对应父端；分别测 idle/busy、断开/重连；不把 queue accepted 当模型已读；无 wake ledger 重试系统 |
| 停止和错误 | adapter/host 测试 | 只有明确请求执行对应中断/关闭；记录失败、读取超时、通知失败不暗中杀子后端；日志与实际 exit 可见 |
| Jev 真实包装 | fake Agent 单测 + 本机浏览器验收 | 直接调用现成 run/snapshot/command/close；blocked/CAPTCHA 页面不因 wrapper 生命周期被关闭 |
| 成熟显示不退化 | 保留 `progress-summary/recap/model-jobs/small-model` 回归及 panel 检查 | 原有模型总结/设置仍工作，原生来源和调用关系正确，没有新增统计摘要工程 |
| 新默认入口真的薄 | 入口依赖审查 | 新 main→工具→宿主→官方后端不导入旧 DelegationService、资格、slots、retirement、审批或两表 manager |

`tests/unit/managed-core.test.ts` 中证明新两表状态机/泛化授权正确的断言不能成为保留它的理由；应替换为上述宿主/归属/原生传递测试。旧 `managed-capability`、`claude-managed-launch`、`pi-managed-launch` 等资格测试只用于历史链，不再规定新产品准入。

**功能模拟、公开 API 核验、本机真实端到端分开报告。** 没有真实运行就不能写“恢复/唤醒/后台存活已完成”。也不能因为尚未实测就再造一套通用故障处理框架。

## 10. 实施顺序：先拆错误依赖，再并行薄接线

本方案交付后，按用户审阅决定继续。当前仓库代码仍暂停，不因本稿发布自动启用任何行为。

1. **修正文档与默认入口边界。** 更新 `docs/architecture/simplified-harness-architecture.md`、参考索引、冲突的 contracts 01–07 和 handoff。明确旧政策不再约束新路径；记录保留原生隔离、父退出继续、主动通知、原生恢复、现有总结及不锁客户端版本。
2. **做小的共同接线。** 将公共类型收缩为原生引用/消息/回调；建立独立连接宿主与最少关系存取，MCP 前台只转发。同时移除 main 的旧控制链依赖，不能等最后“集成”时才发现仍需要旧 ledger gate。
3. **同一轮并行实施，不串行等全部重写。** Codex app-server、Claude SDK、Pi RPC/原生插件、Jev 包装分别推进；来源隔离与去版本门槛、既有 wake 接线可独立推进。共享接口只表达传输，不先造大框架。恢复和通知是各适配器当轮验收的一部分，不放到后续增强阶段。
4. **接回现有 HUD。** 原生状态/日志/关系进入现有读模型，保留全部现成总结链。清掉新节点的旧 report/资格状态依赖；不扩聊天 UI 或新统计范围。
5. **入口级验收与清理。** 运行上述新闭环及已有有效回归，明确哪些旧失败由失效契约造成、哪些是实际缺陷；不以修改预期掩盖功能问题。检查完整依赖图没有偷偷带回旧政策。真实 provider、本机通知/恢复/父退出继续在可用环境验收后才称完成。

产出应是更少的控制代码，不是给当前约 1200 行 manager 再补各种例外。旧历史与无关文件保留；`node_modules/.package-lock.json` 的已有改动不纳入这次提交。

## 11. 已核实、未验证与具体剩余风险

**已核实：** 上述官方 session/status/resume API、项目现有三种通知接线位置、现有模型总结链、精确版本断言及资格入口、Pi 默认包内运行时、两表状态草稿和自动关闭组合问题，均有代码/文档依据。

一个已经确认的组合错误：`rpc-adapter.ts` 默认 30 分钟观察 timer 会发 disconnected；`manager.#failConnection` 调 `session.close()`；Pi close 最终 `client.stop()`。注释说“只是观察超时”不能改变其实际后果。持久化错误也可能进入同一 close 链。这些是要删除的现有行为，不是虚构的故障场景。

**尚未完成的验证：**

- 新宿主尚未实现，所以父退出独立存活、MCP 重连及官方 session 恢复尚未做整条真实验收。
- Codex queue 在本执行器仅核实帮助参数，未发真实任务；本机 daemon/`--resume` 适用状态与警告需验。旧 server request 类型的身份字段还需按实际协议核对。
- Claude 现有 `<task-notification>` 曾被观察到，不等于所有 idle/busy/退出时序已验证；Channels 未在仓库实现，也不是默认已可用。
- Pi RPC 完整 UI response、idle/streaming 下 extension wake、原生 session switch 还需真实安装环境验收。
- Jev 现有真实浏览器环境与 MCP 薄桥尚未接通，没有真实 provider/browser 完成声明。
- 当前恢复分支的已有测试结果只证明旧候选的局部行为：Codex 30、Claude 54、Pi 34、core 26、MCP 聚焦 45 曾通过；全 MCP 184 项中 180 通过、3 失败、1 跳过。**这些都不是本修订方案的通过证书。**

这些不足不阻止先做正确的薄实现；也不能用新的版本准入、审批人、任务状态机或异常调度器替代验证。

## 12. 核对来源

以下 commit 链接只用于重现“读过哪份代码”，**不是消费者客户端版本要求**。运行对接公开接口与用户持续更新的安装。

### 官方接口

- [Codex app-server：读取与恢复 thread](https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming)
- [Codex queue 官方命令](https://learn.chatgpt.com/docs/developer-commands#codex-queue)；[当前上游 queue 实现](https://github.com/openai/codex/blob/main/codex-rs/cli/src/queue_cmd.rs)
- [Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)；[持久输入流](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Claude Channels](https://code.claude.com/docs/en/channels)；[channel reference](https://code.claude.com/docs/en/channels-reference)；[hooks/asyncRewake 限制](https://code.claude.com/docs/en/hooks#limitations)
- [Pi RPC commands](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/rpc-commands.md)；[RPC extension UI](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/rpc-extension-ui.md)；[官方 triggerTurn 例子](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/examples/extensions/file-trigger.ts)
- [Jev Ultra Fast Agent](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/agent.py)

### 指定参考项目与原项目

- [Paseo ensureThreadLoaded](https://github.com/getpaseo/paseo/blob/9f68af0274ca06c5decd6269d870d442b8e04500/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L4133-L4179)
- [Orca 官方 SDK query](https://github.com/stablyai/orca/blob/2462e9cac4054af9a8b86de18e75b94f3bf129d6/src/main/claude/claude-stream-json-connection.ts#L121-L133)
- [Cindy Pi transport](https://github.com/makecindy/cindy/blob/5c1ddeeab20476e9fc8fd40a99ad19ac958b7006/packages/maker-core/src/agents/pi/transport.ts#L198-L270)
- [Herdr server/client 存活说明](https://github.com/herdrdev/herdr/blob/master/README.md#L31)；[session state](https://herdr.dev/docs/session-state/)
- [原 HUD 概念方案](https://github.com/CartmanFatass/codex-hud/blob/a1250f07995465b40e29a284a732978894c3e7ee/docs/universal-hud-concept.md)
- 当前本地 `docs/design/notify-wake-lifecycle-cache.md` §2 记录的 P-N1/P-N3/P-N5 验证边界；现有 `docs/architecture/simplified-harness-architecture.md` 与 contracts 01–07 用于追溯旧要求，不能覆盖用户最新纠正。
