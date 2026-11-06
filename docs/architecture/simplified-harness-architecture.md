# Universal HUD 简化受管会话架构

日期：2026-11-06。状态：**待实施的架构方案，不是产品能力或测试通过声明**。

本文选择一条可落地的主路径，替换受管会话控制中的重复实现。保留已有原生会话观察、历史记录和有价值的界面成果，不在旧启动链上再加一层总控。官方资料、固定源码、版本边界和现有接线位置见[官方接口索引](official-harness-reference-index.md)。

文档基线为 `70665c3a0ed07a324fec476da6c6eb0b1c2354c3`，tree `145a71a1fb52632da0139dd7d71812b1069a9181`；产品分析基线为 `a1250f07995465b40e29a284a732978894c3e7ee`，tree `708eb6a30002ca749ba27d00aadb7d10dcd2265d`。两者用途不同。本文件所在文档分支不包含下述新运行时，也不把多个独立候选分支相加当作一个已集成产品。

## 1. 决策摘要

1. **不新增 daemon，每个会话一个现有宿主。** 由发起委派的既有 `hud-mcp` 进程在内部持有 SessionManager，唯一拥有它创建的 HUD-managed 连接；Codex 用 app-server，Claude 用 Agent SDK，Pi 1.4.0 用官方导出的 `RpcClient`。不再并行建设 exec、print、RPC、ticket 四种受管主路径。
2. **先完成 Codex 一个竖向切片。** 从真实产品 MCP/CLI 入口执行 create → send/ask → 官方形状事件 → 现有 TUI；用可替换的假 app-server 跑完，再用同一套会话服务接 Claude、Pi。
3. **MCP 是入口，manager 是它内部的共享代码。** 每个 harness 启动自己的 `hud-mcp`；TUI 按 managed 会话记录的 host 实例连到原 MCP 进程，不创建 SDK/RPC 对象、不用数据库抢控制。多个 host 可以各管自己的会话，单一所有权不要求新增全局服务。
4. **授权与显示归因分开。** 用户为原生 harness 明确配置 owner/workspace scope 后，它可以委派新的 HUD-owned 子会话；不知道原生 parent 的 session ID，不应阻止已经授权的 create，也不能据此捏造父子会话关系。
5. **只控制自己持有的连接与进程。** 官方返回的 session/thread ID 是绑定信息，不是凭证。任意原生会话默认只读；显式 resume/fork 启动新的受管实例，不等于接管原窗口。
6. **一份持久状态，不再叠加 journal。** 复用现有私有 SQLite，新增两张简表承载 managed session 与 operation；原 ledger 的 native 观察与历史继续可读。没有新的 claim/receipt/心跳资格体系。
7. **结果语义准确而有限。** send 接收不等于任务成功；ask 等待它自己发送的那一轮；wait 超时不取消任务；cancel 与 close 不混用；未知提交不自动重发。
8. **保留必要边界，删除不必要前置。** 保留真实数据外发授权、审批回传、资源范围与私有存储；移除精确 kernel/Node/工具哈希的整机资格矩阵作为新路径的运行前置。官方支持检查与实际验证结果单独展示。
9. **模拟开发继续，真实验证后置。** 官方接口形状的 fake 可以完成实现、测试与授权测试分支交付；真实账号、安装、provider 调用不是这些工作的前置。模拟 PASS 不变成真实 PASS。

### 1.1 本方案明确改变了哪些旧选择

原[概念目标 G4、G11–G13](https://github.com/CartmanFatass/codex-hud/blob/a1250f07995465b40e29a284a732978894c3e7ee/docs/universal-hud-concept.md#L28-L45)包含握手证明父子身份、可见/headless 切换、运行槽与回执、无常驻服务。这里明确哪些保留、哪些提出修订，不声称已经修改旧契约：

- G4：持有官方连接的 managed 会话直接绑定；没有可信原生 parent ID 时允许授权委派，但只显示“来自此 MCP scope”，不画已证实的 native 父子边。
- G11：第一版提供 headless managed 会话和 HUD 面板交互。原生 TUI 的可见 resume 与整个 OS 工作范围终止仍是独立功能，不由 SDK interrupt 冒充。
- G12：保留持久请求去重、单会话互斥和未知结果不重发；移除新路径对 intent/link/run/claim/ticket 全链的依赖。不承诺 exactly-once。
- G13：**保留无新常驻服务**。原文要求 hud-mcp 随 harness 起停、hud-run 只在运行期间存在；同文档 2026-11-01 F08 决定再次写明无常驻服务/轮询。本方案把 manager 放进已存在的 hud-mcp，TUI 只路由到会话原 host。代价是默认不保证子任务跨 native root/MCP host 退出继续运行。新增 `hud serve` 只在第 12 节列为改变 G13 的待决定替代项。

接受本方案后，实施提交应同步修订相关契约与命令说明。当前四文件文档变更不静默废除旧运行时的安全契约，也不重新设置修复次数限制。

## 2. 当前产品实际走哪里

在 a125 产品基线上：

- `packages/hud-mcp/src/main.ts` 创建 `SessionRefResolver`、`DelegationService`、`ManagedNativeRuntime`。spawn/resume 先记录 intent/link/run/claim，再启动 `hud-run`。
- TUI 不是通过前后端 MCP RPC 驱动。它读取同一 ledger、各 source 的观察及 native 文件，再构建 ViewModel。MCP 的控制结果最终通过这些记录变成可见状态。
- `src/harness/codex/app-server-transport.ts`、`exec-transport.ts`、Claude `print-transport.ts`、Pi `rpc-transport.ts` 是独立协议实验，没有接成 managed 产品的持续对话后端。
- `managed-cells.json`、`codex-cells.json` 为空；不能据现有类型、启动器或合成 fixture 宣称三 harness 默认已可用。工具表没有 send/ask。

精确入口见[a125 main.ts](https://github.com/CartmanFatass/codex-hud/blob/a1250f07995465b40e29a284a732978894c3e7ee/packages/hud-mcp/src/main.ts)、[工具表](https://github.com/CartmanFatass/codex-hud/blob/a1250f07995465b40e29a284a732978894c3e7ee/packages/hud-mcp/src/tools.ts)、[managed-runtime](https://github.com/CartmanFatass/codex-hud/blob/a1250f07995465b40e29a284a732978894c3e7ee/packages/hud-mcp/src/managed-runtime.ts)。新方案解决的是这条产品路径没有贯通的问题，不是再展示一个独立 demo。

## 3. 真实进程拓扑与数据流

### 3.1 默认：每个既有 MCP 进程持有自己创建的会话

```text
原生 root A（Claude/Codex/Pi；自身默认只读观察）
  └─ 既有 hud-mcp A
       ├─ MCP stdio 入口 + 进程内 SessionManager A + 私有本地 IPC
       ├─ Codex adapter → A 创建的 codex app-server（stdio）
       ├─ Claude adapter → 官方 query()/Query → SDK 管理的子进程
       └─ Pi adapter → 官方 RpcClient → 其创建的 Pi 子进程

原生 root B
  └─ 既有 hud-mcp B + SessionManager B → 只拥有 B 创建的连接

HUD TUI / hud CLI
  ├─ 只读同一 ledger + native 观察 → 既有 ViewModel/bar/panel
  └─ 控制某 managed 会话 → 按 hostInstanceId 路由到 A 或 B 的私有 IPC

各 host 的官方事件 → 同一 ledger 的 managed 快照/有界 events
```

不新增 `hud serve`，不安装系统服务，不设置全局 leader。SessionManager 是放进现有 `hud-mcp` 的代码模块，不是第三个进程。现有 MCP 请求处理完后进程通常仍为 harness 服务，故连接可以继续收事件、服务下一轮 send/ask。不同原生 root 可以各有一个 host，但**每个 managed 会话只由创建它的一个 host 持有活句柄**。

TUI 不启动会话后端、不抢数据库中的 owner。它先读取会话的 hostInstanceId，再连接该 host 的私有 socket；server 必须回证当前实例 ID 并重新校验调用者 scope。记录仅是路由提示，不是控制凭证。endpoint 不在、代次不同或握手失败时返回 `owner_unavailable`，不把调用转发给另一 host 重做。

用户从 TUI/CLI 新建时，显式选择一个已有且获授权的 host；也可以由该前台客户端按普通 MCP client 方式启动同一个 hud-mcp 入口，寿命跟随此客户端。不能把短命 CLI 的退出伪装成持久后台运行；没有可用 host 就明确拒绝创建并说明需要保留前台宿主。这个入口复用原进程形态，不自启动 daemon。

第一版每个 managed 会话使用一个官方连接；Codex 先每会话一个 app-server 子进程，不做跨会话连接池。其成本是可测的进程数，收益是取消、关闭、审批和身份边界直接。将来多 thread 复用如确有收益，再在同一 adapter 内实现，不能提前建池或调度器。

### 3.2 root、MCP host 与独立子任务的寿命

- “独立 subagent”指独立上下文、harness 和工作实例。root 空闲、一次 MCP 工具返回、TUI 关闭都不结束已接收的子任务；host 继续持有连接并记录状态。
- root 正常结束导致 MCP stdin EOF 时，host 停止接收、对自有活动操作发取消、在有限期限内释放 Query/RpcClient/app-server，再退出。不新建脱离 root 的 guardian 来保活。
- root/host 崩溃时，官方子进程可能随 pipe 关闭结束，也可能留有工作或外部工具副作用；不能保证。其它客户端将未确认操作显示为 disconnected/uncertain，不重放、不对旧 PID 发信号。
- 新 root 的 MCP host 可以读取同 scope 历史；要继续则显式 resume/fork 创建**新的** managed 实例，不能凭 ledger 恢复旧活句柄。旧原生会话仍可能活跃时优先 fork，不声称独占接管。
- 因此默认不承诺跨所有 native root 退出的 durable background task。若这个功能成为必须项，须明确选择第 12 节的独立 host 方案并改变 G13，不能偷偷留下常驻进程。

### 3.3 每个组件只做一件事

| 组件 | 负责 | 不负责 |
|---|---|---|
| hud-mcp 的协议层 | MCP 协商、参数/大小校验、连接 scope、调用/资源封装、传输级取消 | 推断任意原生 PID/session，自动重试任务 |
| 进程内 SessionManager | 当前 host 所拥有会话的 scope 检查、operation 状态、每会话一个活动输入、审批挂起/答复、有限持久记录 | 重写 agent loop、重新实现工具执行器、维护另一套资格引擎 |
| 三薄适配器 | 官方 API 映射、事件订阅、保存活句柄、结果关联、释放自己创建的资源 | 自建工作流、公共 owner 数据库、从 transcript 猜发送目标 |
| TUI/CLI | 展示同一状态，按会话 host 路由命令和用户审批答复 | 直接写 provider stdin、自己开 SDK、将 pane 关闭当 session 关闭 |
| native readers | 在已授权来源里只读观察原生会话及历史，标注 freshness/provenance | 给观察对象授予控制权，或覆盖 managed operation 的终态 |
| ledger | 持久会话/host 路由、请求去重、有限终态/展示记录；用事务协调多个既有 writer | 让另一个 host 抢占活会话，重放待执行任务，保存 provider 登录信息 |

### 3.4 最小 IPC 与本地授权

每个现有 hud-mcp 只为其生命周期建立一个私有 Unix-domain socket。socket 在用户私有 HUD 目录内，以随机 hostInstanceId 命名，不根据模型提供的路径连接；目录仅本用户可进入，拒绝不安全路径和非本用户连接。Windows named pipe 与跨机器连接不作为本切片前置。IPC 只有有界请求/响应和可断开的状态订阅，不引入 HTTP 服务、消息代理、事件总线或订阅数据库。

TUI 可从 ledger 读完整列表；只为需要交互/实时状态的 host 建有限连接，其余走已有只读快照。多 host 只是同一 service 代码的多个实例，没有全局 provider backend。没有任何 host 时，原生观察与历史 TUI 照常工作，控制返回 owner_unavailable。

连接建立时绑定 principalId、grantId、可用动作和 workspace/source 范围；每个调用从连接上下文取这些值。每次有副作用的 dispatch 和审批放行前重新核对当前 scope 配置/撤销状态，不把握手时的缓存当永久授权；范围被收紧时未发出的工作不继续，已发生的副作用不能靠撤销回滚。模型传来的 owner、sessionId、cwd、_meta 和 request_key 均不能提升权限。对本 host 不拥有的 managedId，要么返回其有限路由信息供授权客户端连接原 host，要么返回 owner_unavailable，不能在本 host 偷偷执行。

- 原生 harness 使用用户已配置的命名 scope。配置复用 delegate.json 的下一版本，不复制一份 caller 数据库。操作者 TUI/CLI 使用明确的 operator 通路，agent 不因此取得审批权限。
- 配置说明允许该 harness 创建/控制哪些 HUD-owned 会话、读取哪些来源、向哪个后端发送哪些材料。配置或扩大持久访问仍走正常授权流程，不以“接入 MCP”为由隐式取得整个用户目录。
- 本地 channel 凭证保存在用户私有配置/受控启动通路，不放工具参数、prompt、argv、事件或报告里。短期连接凭证不落 ledger；持久凭证如确需使用，仅在既有配置保护范围处理。
- hostInstanceId 和 socket 路径不是凭证。owner 字段持久化保证重连后的权限范围与去重，不授权接管旧进程。
- 同 UID 的恶意进程通常可以访问同用户文件/环境；本方案不声称 token/socket 能隔离拥有等价 OS 权限的攻击者。需要隔离不受信任代码时使用实际 OS sandbox，不能用更多 hash 替代。

MCP 的连接/session 只说明 MCP transport 会话，**不自动证明调用者是哪条 Claude/Codex/Pi conversation**。[MCP transport 规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)没有给 tools/call 附赠可信的 native parent session ID。普通原生调用可以绑定已配置 owner/workspace scope 并创建新的 HUD-owned 子会话；原生归因留空或标 unverified_label。一个 scope 被配置给多条原生会话时，权限就是该 scope 的集合，不冒称每条原生会话彼此隔离；需要隔离时配置不同 scope。

### 3.5 两个方向的工具调用，不混为一谈

**入站控制**：用户/原生 agent → hud-mcp → 其进程内 manager。这里的 create/send/ask 是默认能力。原生 parent 无须先被 HUD 接管。TUI 操作则经该 host 的 IPC 调完全相同的方法，不维护另一控制后端。

**受管 harness 内部工具**：模型 → harness 官方机制 → HUD 核心。第一切片不自动把所有管理工具递归注入子会话。启用时只给有限工具，禁止子会话自批审批或扩大自己的 scope：

- Claude 用 tool() + createSdkMcpServer()，为每个 Query 创建独立 handler closure，绑定其 managedId，直接调用拥有该 Query 的同一 manager；canUseTool/hooks 另走官方 callback，不绕成 stdio resolver。
- Codex 普通 MCP 配置不保证逐调用带可信 thread ID。专用连接上可配置范围固定的 HUD bridge，但不能把共享/原生子线程全当 root。带 threadId/turnId/callId 的 item/tool/call 属于 **experimental dynamicTools**，不是默认必需；以后启用时校验映射后直接调同一 service。
- Pi 控制使用 RpcClient；工具级回调用官方 extension tool_call/registerTool。一个明确加载的薄 extension 通过原 host 的私有 IPC 调同一审批/工具 service，不成为第二个 lifecycle client。RpcClient 1.4.0 没有公开 extension-UI-response 方法，不能调用 private send/process 假装具备该 UI 桥。

## 4. 三条官方主路径

### 4.1 Codex：app-server，作为第一条实现

接口研究固定在 `openai/codex@d786ff91fad8e7ddab8653ee07bc6313a6fcb03d` 的 generated protocol，滚动文档读取于 2026-11-06。这里没有凭源码包的 `version = 0.0.0` 伪造发布版本；实施时记录实际 `codex --version` 与它生成的 schema，只用匹配字段。[官方 app-server](https://learn.chatgpt.com/docs/app-server)与[固定 ClientRequest](https://github.com/openai/codex/blob/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/codex-rs/app-server-protocol/schema/typescript/ClientRequest.ts)共同确定合同，冲突时不把滚动新字段倒灌给旧 pin。

- manager 直接 spawn 已明确配置的 `codex app-server`，持有 stdio 和 child handle；每连接 `initialize` 后 `initialized`。
- 新建用 `thread/start`，记录响应的 `thread.id`；恢复用精确 `thread/resume`，分支用 `thread/fork` 并记录新的 thread ID。`thread.sessionId` 与 `thread.id` 不一定相同，分别保存，不能相互推导。
- send 用 `turn/start`，保存返回的 `turn.id`。`item/*` 用于活动/工具/文本投影，目标 `turn/completed` 的 status 才结束这轮。`error.willRetry=true` 不是终态。
- `turn/steer` 是向活动 turn 追加输入，不是新 turn；第一版不开放隐式 busy 时自动 steer。`turn/interrupt` 是取消请求，等待匹配 turn 的终结或明确不确定。
- 审批来自 server-initiated JSON-RPC requests，包括 command/file/permissions approval、user input 与 MCP elicitation。保存实际 request ID、threadId、turnId 和可用决策，用户答复回到原连接同一 request；未知类型不自动接受，不用一个通用 `true` 回所有请求。[固定 ServerRequest](https://github.com/openai/codex/blob/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/codex-rs/app-server-protocol/schema/typescript/ServerRequest.ts)是测试 fake 的来源。
- `thread/unsubscribe` 只是退订，`thread/archive` 是历史归档，都不是 cancel。close 先处理活动 turn，再结束自己的连接/进程；不调用 archive/delete 作为“关闭”的替代。

Codex TypeScript SDK/exec 适合一次性脚本，但当前目标包含持续输入、实时审批和 turn 控制，因此不同时引入它作为第二套主后端。原 `codex mcp-server` 不选用；当前官方 SDK 页面已说明该路线移除，给 Codex 配置外部 MCP 是另一回事。

### 4.2 Claude：Agent SDK 的持久 streaming Query

方案的依赖候选固定为 `@anthropic-ai/claude-agent-sdk@0.3.319`；官方仓库快照 `49dd8ef10dd5cb012dc9fe10703376489850c36c` 的 changelog 对应 Claude Code 2.1.319。当前没有安装/编译该 npm 包，不能称 package conformance 已通过；实施阶段需对锁定包的公开类型运行 adapter 合同测试，不能以现有 CLI 2.1.305 实验替代。[SDK 入口](https://code.claude.com/docs/en/agent-sdk/overview)、[TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)、[streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)是选路依据。

- 每个 managed 会话一个 `query({prompt: AsyncIterable<SDKUserMessage>, options})` 和一个 Query。manager 拥有输入队列和输出迭代器，第一版每次只允许一个用户消息进行中。
- 每个输入设置独立 `uuid`，绑定 operation。`session_id` 从官方 init/消息读回；没有返回前保持 `nativeRef=null`，不得发送一条“探测 prompt”冒充无副作用 create。
- create 可先返回 `prepared` 的 HUD ID；官方初始化完成才是 `ready`。若某版本的 Query 要等第一条输入才公布 session ID，在第一次 send 中完成绑定并持久化。这是明确的两阶段可见状态，不伪造 provider 会话已经创建。
- ask 只消费对应 UUID 的顶层 `SDKResultMessage`；选中版本可用 `user_message_uuid/user_message_uuids` 关联。不能用第一段 assistant 文本、任意 `result` 或 subagent 消息结束 ask。SDK 可合并消息，故第一版串行输入；不相关结果记为会话活动，不给当前 operation 乱配。终结还要区分 success、error、interrupted、deferred 等实际字段/语义。
- 用 `resume` 精确指定旧 session；fork 使用官方 `forkSession()` 后 resume 新 ID，或版本明确支持的 `resume + forkSession` 选项。禁止用 `continue:true` 猜“最近一条”来恢复用户指定对象。[sessions 文档](https://code.claude.com/docs/en/agent-sdk/sessions)定义的是历史延续，不是接管原进程，也不是文件系统回滚。
- `Query.interrupt()` 请求中断，`Query.close()` 释放 Query/子进程资源。interrupt 回执可能提到仍排队的消息，并不保证它们全被取消；第一版不在活动 Query 中堆多条输入，也不打开 SDK 自动后台任务作为验收前置。close 返回不自动等于所有工具子进程和外部副作用已结束。
- `canUseTool` 只处理官方权限流程中落到提示的请求，还承载 `AskUserQuestion`。自动批准的工具不经过它。需要每次校验的本地/外发约束放在适当 `PreToolUse` hook 及 HUD 自己的工具执行边界，不能只设一个 callback 就声称所有工具被拦截。选中版本未支持的严格约束应拒绝该 profile，而非偷偷设 `bypassPermissions`。

SDK 使用受 [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms)约束，不是通用 MIT 许可。官方 overview 对第三方产品提供 claude.ai 登录/订阅使用有额外限制；本方案不承诺公开 HUD 无缝复用用户订阅，也不因这个问题阻塞 fake 开发。实际分发、认证方式和使用范围在本地实测/发布前单独确认。

### 4.3 Pi：1.4.0 官方 RpcClient，加有限适配

固定 `@earendil-works/pi-coding-agent@1.4.0`，源码 `4a080252f06caf63a525d7873c5d94d3c23887e0`，包要求 Node `>=22.19.0`。官方 [RPC 指南](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/rpc.md)明确建议 TypeScript 子进程集成使用导出的 RpcClient，故不继续扩展旧 v0.73.1 自建 RPC client。

- 用公开 `start/onEvent/prompt/getState/abort/switchSession/fork/clone/getTree/stop` 等方法。记录 `getState()` 返回的实际 sessionId/sessionFile；resume 指向明确 session file，switch/fork 返回 `cancelled` 时不能更新成成功的新绑定。
- 先订阅，再 `prompt`。响应 disposition=`started` 才进入本次独占运行等待；`handled` 表示被命令/输入处理器处理，没有本轮模型结果，应立即返回 `handled_no_turn`，不能等待不存在的 settled；第一版不支持 busy 时排队，意外 `queued` 列为待核对，不能当完成。
- session events 通常没有请求 ID，因此不能捏造 provider turn ID。manager 使用该连接的 session/generation、本地 operation 和“一个在途 prompt”的约束关联。失去这些条件时标 `uncertain_correlation`，不从最近一条文本猜答案。
- `agent_end` 只是底层运行结束，重试/compaction/follow-up 仍可能继续；`agent_settled` 才可判定该受控运行不再自动继续，并且仍要检查消息错误/abort 状态，settled 本身不等于任务成功。
- 此 pin 的 `promptAndWait()` 未处理 `handled` 分支；薄适配器用公开 onEvent + prompt 做有界等待和 listener 清理，不照搬该 helper，也不重写 framing/request correlator。[RpcClient 源码](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/rpc/rpc-client.ts)是此差异的依据。
- 此 client 的 `start()` 用 `spawn("node", [cliPath, ...])` 并合并继承环境；Options 没有公开 interpreter/spawn 注入。必须显式解析官方包 CLI 入口，不能依赖默认相对 `dist/cli.js`；受信 PATH/Node 是运行前提，不能声称已有 5B 精确 Node receipt 可直接传入，也不能声称彻底净化了继承环境。要求严格 interpreter/环境隔离但接口做不到时返回 unsupported，不改 private 成员、不偷偷改全局 `process.env`。
- onEvent 没有公开 child-exit 回调保证；已接收 prompt 后进程退出但无 settled 时，薄层须在等待期限内结束为 unknown，可用公开 getState 做一次有限核对，不能读 private process 或无限等待。
- `stop()` 是此 client 自己的 TERM/超时 KILL，不能称为 rpc.md 的 stdin-EOF 有序关闭，更不保证 whole-process-tree 清理。HUD 记录请求与观测分别成立，失败/未知保持可见。

**Pi 的权限差异必须保留。** 它没有与 Codex sandbox 同级的通用内置审批承诺。第一版 profile 必须明确加载范围：可选完全无工具的受控模式，或明确批准的工具集合。`--no-tools` 本身不等于关闭 MCP/扩展；受控无工具 profile 还要显式关闭未批准的扩展、MCP、技能/模板及上下文文件自动发现（如 --no-extensions、--no-mcp、--no-skills、--no-prompt-templates、--no-context-files），并把这种配置差异展示给用户，不悄悄改变原生默认环境。[固定 CLI 文档](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/cli.md)说明这些开关各管什么。

需要逐工具确认的 profile，增加**一个**显式加载的薄 permission extension：用官方 `tool_call` hook 将 toolName、input、toolCallId 和连接绑定交给 manager 的同一审批入口；等待/断线/超时默认 block，用户答复后才返回 allow。它不依赖 RpcClient 未公开的 UI reply API，不复制官方示例的几个危险命令正则当安全策略。未实现并通过模拟前，该 profile 标 `approval_bridge_unsupported`。扩展与工具本身拥有进程 OS 权限，这种 hook 不是 OS sandbox。[官方 extension 合同](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/extensions.md)明确了这一边界。

## 5. 身份、授权与生命周期

### 5.1 四个名字足够，不互相替代

| 名字 | 来源与含义 | 能否授权 |
|---|---|---|
| owner/scope | 用户配置并由本地 IPC 握手绑定 | 决定可操作集合；不是模型参数 |
| `managedId` | manager 创建的 HUD ID | 只是查找键；仍须校验 owner/scope |
| `nativeRef` | 官方返回的 thread/session ID、必要的存储定位 | 绑定/恢复用，不是控制凭证 |
| `operationId` | manager 对一次 create/send/cancel/close 的记录 | 用于结果关联、等待、去重；不是新的权限票据 |

活对象另带 manager 实例代次与 session generation。callback/通知到达时必须匹配当前连接和 generation；旧连接的晚到消息不能覆盖新实例。这个代次在连接上校验即可，不需要每个 token、hook、PID、文件再生成一套 claim。

### 5.2 必须留在内存的东西

Query/RpcClient/ChildProcess、stdio、事件 listener、待应答官方 request 的 resolver、AbortController、单会话活动 operation、connection-scoped grant、订阅者都是内存句柄。它们不能序列化进 ledger，也不能在重启后由一个 PID/sessionId“重建成原来的控制权”。

原 MCP host 活着时，TUI 或额外 IPC 客户端断开仅关闭其订阅；已经接收的 operation 仍运行，其他授权客户端可以重连观察。原 host 的 stdio EOF 则按第 3.2 节收尾，不属于普通视图断线。取消 MCP 的长轮询只结束该等待，不隐式取消 provider 任务。

持有该会话的 MCP host 退出/崩溃则不同：原活句柄消失，所有未确认终态在读取时显示 `disconnected/uncertain`；崩溃本身不可能写回 DB，读模型保留最后持久状态并叠加 owner 不可达事实，不让另一个 host 伪造旧操作终态；不对记录中的 PID 发信号，不接管遗留进程，不自动重发 prompt。先读回官方历史/状态；需要继续时，用户显式发起新的 resume/fork 受管实例。官方会话历史可恢复不等于任意中断中的操作可无损恢复。

### 5.3 三层授权不能合成一个布尔值

1. **本地读取授权**：哪个 workspace、native source、报告可供 HUD 读取。
2. **材料外发授权**：把哪些文本/文件发送到哪个 harness/provider、为了什么。展示某条原生记录，不自动允许把它拼进新的 prompt。
3. **工具执行权限**：官方 backend 的权限模式、sandbox、运行中审批，以及 HUD 自己工具的约束。

继续复用已有材料/隐私入口，不建立新的策略 DSL。Claude 的 `permissionMode/canUseTool`、Pi extension 和 Codex sandbox 不是等价隔离保证；UI 分别显示 `toolApproval`、`filesystemIsolation`、`networkIsolation` 的实际值/unknown。强约束无法满足时只拒绝该选择，不改成更宽权限，不用一份整机矩阵阻止其他合法会话。

审批请求保存在内存，向 TUI 展示脱敏后的动作、目标、数据/权限范围及后端原始决策选项。只允许有审批权限的操作者答复，普通 agent scope 不能批准自己的请求。答复绑定当前 generation、官方 request ID 和展示内容；一次性决策不升级为永久规则。连接丢失/审批过期时原 callback 拒绝或失效，重启后不得重放旧的“允许”。审计结果可写入已有 events，但不持久保存可复活的 callback。

### 5.4 生命周期与资源上限

保留配置化的并发上限、空闲回收和最大活动时间，所有 host 使用同一 manager 代码；全 owner 容量在同库接收事务中计数，不再建 slots/claims。每个 host 只计时并操作自己拥有的会话，不为每会话启动心跳 worker。active、waiting_approval、uncertain 尚未确认结束的会话都计入其适用上限。旧 host 不可达而占位未解时，显示具体未确认项，交由用户本地核对后按明确处置释放；不能为了腾容量把它自动标成已终止。这是资源/恢复风险，不是重新设置项目修复次数额度。延迟计时用事件与必要的到期 timer，不让 bar tick 驱动控制操作。

报告到达、文本结束、面板退出都不自动等于 session close。到期策略若配置为关闭，调用同一个 close 方法，展示原因和结果；无法确认执行结束的会话不伪装为已干净回收。原 MCP host 退出时先停止新请求，再在有限期限内处理自有连接；超时报告未确认项。第一版不承诺原 MCP host 退出后任务继续，也不承诺所有外部工具进程都消失。

## 6. 用户/agent 控制合同

以下是**拟实现 API**，不是 a125 已有工具。CLI、TUI、MCP 共用相同 service 方法。MCP 新增 `delegate_create/send/ask`，保留 `delegate_wait/cancel/close/list/status` 的兼容入口；带旧 `linkId/runId` 的请求只路由旧路径，不偷偷变成新语义。资源读取用同一 `readResource`，有需要再暴露标准 MCP `resources/read`。

### 6.1 返回对象与基本状态

所有写操作带 `request_key`，owner/scope 来自连接。返回 `managedId`、`operationId`、接收时间、dispatch 状态和当前结果；native ID 未知时允许 null。状态至少区分：

- session：`prepared / ready / running / waiting_approval / disconnected / closing / closed`。
- operation：`accepted / dispatching / running / waiting_approval / succeeded / failed / cancelled / handled_no_turn / uncertain`。
- 传输断开、超时、正在关闭不应被压成“任务失败”；任务成功不应被压成“进程已退出”。

本地 `accepted` 的含义是记录和授权已成立；官方接收、实际开始、最终结果分别保存。UI 使用中文说明这些差异，不要求用户读协议字段。

| 操作 | 精确定义 | 官方映射与边界 |
|---|---|---|
| `create(profile, workspace, mode, request_key, source?)` | 建立一个 HUD-owned 会话配置/实例，默认不带任务 prompt；source 可显式为 resume 或 fork。返回 prepared/ready，不意味着模型调用成功。 | Codex thread/start/resume/fork；Claude Query 准备及显式 resume/fork；Pi start/getState 或指定 session/switch/fork。官方失败或 cancelled 不生成假绑定。 |
| `send(managedId, input, request_key)` | 接收一条输入并返回可等待的 operation；运行中拒绝 busy，第一版不持久排队、不自动 steer。 | Codex turn/start；Claude streaming SDKUserMessage；Pi prompt。接收本地请求不等于官方 ACK；ACK 不等于 turn 成功。 |
| `ask(managedId, input, request_key, waitMs)` | 同一次 send 加对其 operation 的有界 wait，不是发送两次，也不是问正在运行的 agent 取“最近答案”。 | Codex 对应 turn/completed；Claude 对应 UUID 的 result；Pi 对应独占运行 settled + 结果分类。timeout 返回 pending/operationId。 |
| `wait(operationId, afterSeq, waitMs)` | 读该 operation 的有界事件/快照与终态，分页 cursor 可断线续读本地已保存部分。 | 不启动任何 provider 调用；不把无事件/idle 当成功。达到保存边界返回 history_gap 和快照，不假装完整重放。 |
| `cancel(operationId, request_key)` | 请求停止该活动 operation，保留会话和历史，可供后续 send。 | Codex turn/interrupt；Claude interrupt；Pi abort。ACK 只记 cancel_requested，等待对应终结；超时 unconfirmed/uncertain，不归为取消成功。 |
| `close(managedId, request_key)` | 禁止新的 send，必要时 cancel，然后释放该 managed 实例的官方连接/自有进程。保留历史。 | 不是 archive/delete、不是关闭原生 pane。释放确认与任务结果分开；无可靠退出确认时 close_unconfirmed，不伪造“所有工作已停”。 |
| `resources/list/read` | 在 owner/source 范围内读取有界元数据、状态、报告或明确授权材料；展示来源与 freshness。 | 复用同一读 service。provider tool resource、native 文件和 HUD link resource 不是同一权限。URI/文件路径不是授权，不跟任意路径读取。 |

另有操作者专用 `respondApproval(approvalId, decision)`，用来答复第 5 节的真实官方 callback；它不是 agent 可用的普通 send。功能 schema、参数上限和错误码在第一实施提交冻结，不能保留一套 MCP 定义再让 TUI 用另一套隐式 API。

### 6.2 请求去重和副作用不确定

每个 owner 下，`request_key` 唯一定位一次 operation，`canonicalInputDigest` 用来检测异参。同键同参数返回原 operation；同键不同参数拒绝。ask 的提交部分规范化为 send，waitMs/afterSeq 等只读等待参数不进入提交摘要，所以 ask 超时后可用同 key 继续等待而不再发一条消息。active operation 的检查与接收记录在同一 SQLite 事务完成，接收事务同时记录原 hostInstanceId；只有该 host 能 dispatch。另一个 host 对同 key 读回同 operation/原 host 路由，不从 DB 抢控制；原 host 不在时返回 owner_unavailable。

调用官方 API 前写入 `dispatching`；收到可关联的 ACK/事件后更新官方 ID 和状态。若在“写 dispatching → 发送 → 写 ACK”之间崩溃，只能标 uncertain。这个窗口无法靠增加 receipt 消除：本地数据库事务和 provider 执行不是同一事务。

- 从未接收/明确未发出的请求可以在新的请求中重试；是否未发出必须有确定的本地事实。
- 已发送或发送与否未知时，不自动换新 key，不自动 resume 后重发，不因 HTTP/RPC timeout 当作未执行。
- 用户重复同 key 可以安全读回本地 operation；这不是 provider exactly-once 保证。工具、网络请求、文件修改可能已经发生。
- 关闭客户端等待或收到 MCP cancellation 不回滚已提交的 operation；需要停止任务必须显式 cancel。
- SDK/provider 内部 retry 是其自身语义，HUD 不再包一层自动重试可能有副作用的 send。
- cancel 与自然完成竞态时，以官方实际终结为准；请求过 cancel 但结果正常完成，仍记 succeeded + cancel_requested，不凭意图改成 cancelled。

### 6.3 断线、重启、晚到与恢复

| 情况 | 处理 |
|---|---|
| TUI/额外 IPC 客户端断线，原 host 尚活 | 重连原 host 和同 scope，读 operation 状态；不重新发送输入。等待订阅可重新建立。原 MCP stdio EOF 另按有界收尾。 |
| 官方连接在 send 前确定失败 | operation failed/not_sent，可明确提示重新发起；不能假称 provider 错误完成。 |
| 官方连接在发送后或结果回写前丢失 | uncertain，保留已知 native/turn/UUID，进行只读核对，不自行补发。 |
| 原 MCP host 重启/换 root | 活句柄不恢复；旧 host 不可达的未终态 operation 显示 uncertain。新 host 只读已存快照，显式 resume/fork 产生新 managed 实例并链接 predecessor，不自动认领旧行。 |
| 官方历史找到精确已知 turn/UUID 终态 | 在标明恢复来源后补充结果；无法对应则继续 uncertain，不取“最新消息”。 |
| Pi 没有稳定可重查 turn ID | 保留本地关联和历史，通常不能证明旧 ask 已对应完成；展示恢复限制，不猜测。 |
| 旧 generation 晚到通知/审批答复 | 不修改新会话/新 operation，可记有限诊断；旧允许不能用于新调用。 |
| read/history 失败 | 展示 unavailable/stale，不抹掉已有历史，也不降级为读取任意源目录。 |

## 7. 最小持久状态与现有 ledger 的复用

选择**同一个 `ledger.sqlite`**，复用现有 SQLite 打开、私有路径校验、事务、迁移和只读查询基础设施。当前 [schema](https://github.com/CartmanFatass/codex-hud/blob/a1250f07995465b40e29a284a732978894c3e7ee/src/ledger/schema.ts) 的 links/runs 有旧 caller/claim/终结证据约束，不能为满足它们伪造 caller、票据或退出证明。

因此新增两张小表，并明确新路径**不再写旧执行表**；这比硬塞进旧 runs 后保留整条启动链更简单：

| 表/字段组 | 来源 | 写入时机 | 重启规则 |
|---|---|---|---|
| `managed_sessions.managed_id, owner_id, grant_id, harness, profile_id, workspace` | 本地已认证 scope + 已批准 profile | create 接收事务；位置/owner 不可被模型改写 | 只恢复描述与读权限，不恢复活句柄 |
| `native_ref`：threadId/sessionId/sessionFile/storeKey，可空 | 官方 init/start/getState/resume 响应 | 首次绑定或显式新实例确认时 | 用于只读核对/显式恢复，不能凭它发信号 |
| `origin_kind, predecessor_id, observed_parent_ref?` | new/resume/fork 的明确请求；可信父会话可选 | create 时；未知 parent 留空 | 历史关系保留，不自动追认原生 parent |
| `host_instance_id, state, generation, created_at, updated_at, closed_at, last_error` | 接收 create 的 MCP host 与官方事件 | create/状态改变时 | host ID 仅作私有 socket 路由提示；原 host 不可达则显示 disconnected，不能用该值接管。更新时间不是存活证明 |
| `managed_operations.operation_id, managed_id, owner_id, request_key, input_digest, kind, target_operation_id?` | 已授权请求 | dispatch 前同一事务 | 唯一键防本地重复；不自动重放 |
| `dispatch_state, native_turn_id?, user_message_uuid?, started_at, ended_at, status` | manager dispatch + 官方响应/事件 | 发出前和每个关键边界 | 未确认终态变 uncertain；仅精确匹配证据能补完 |
| `result_summary/result_ref, error_code, cancel_requested_at, close_requested_at` | 已关联结果和用户请求 | 结果/请求发生时 | 保留有限结果及实际取消/关闭情况，不伪造成功 |

输入正文不为恢复自动执行而持久化；默认只保存摘要/摘要 hash 和 provider 本来保存的历史。确需保存报告/材料时使用既有私有 artifact 存储和授权/保留期，不在数据库、JSON journal 和日志各复制一份。

现有 `sources/sessions` 继续承载 native 来源与只读身份。manager 的 nativeRef 可以在真实绑定后关联它们，但 managedId 独立，resume 新实例不覆盖原观察节点。现有 `events` 可增加可空 managed/operation 关联及索引，保留有界状态/审批决策/终态供 TUI cursor；不要求每个 token 落盘，token delta 仅实时转发，最终文本按限制保存。它是展示/审计记录，不是另一套执行 journal。

旧 `idempotency/intents/claims/slots/child_bindings` 留给旧路径与历史读取，新路径去重只在 managed_operations 做一次。旧写路径渐退后再做有备份的显式 schema 清理；本方案不删除用户表/记录。scope 配置和撤销复用现有配置管理，审批 pending、process PID、临时 transport ID、listener、token 均不作为恢复授权持久化。

不得新增独立 routing journal、每步 intent 文件、另一个 WAL、成功 receipt 目录或为了“证明恢复”复制原生 transcript。SQLite 自己的 WAL 是存储机制，不是应用再实现一套日志协议。

## 8. 已有原生会话如何处理

| 用户意图 | 产品行为 | 明确不做 |
|---|---|---|
| 看已有 Codex/Claude/Pi 会话 | 在已授权 source 内继续只读观察、展示状态/用量/树/历史 | 日志更新不授予 send 权限 |
| 从原生 harness 通过 MCP 委派 | 已配置 scope 可 create HUD-owned 子会话；无可信 native parent ID 时显示来源 scope/未绑定归因 | 不强迫先证明原生 parent 的全部进程与日志身份 |
| 继续一条旧会话 | 用户显式选择源和官方 resume；新建 managed 实例/连接，保留 native history ID | 不宣称复用原终端 stdin 或夺走原进程 |
| 保留原会话另试一个方向 | 官方 fork/clone，确认返回的新 ID，记录来源 | 不把相同 ID 强行标为 fork；不把它说成文件快照 |
| 原会话可能仍运行 | 优先 fork；显式 resume 前说明可能并发写历史，利用官方忙状态/本地已知活动检查；不能确定时不声称独占 | 不用关 pane/杀 PID“确保”接管；不绕过官方拒绝 |
| 从 headless 转回原生 TUI | 第一版给经过版本检查的显式恢复说明，用户另开；后续可见模式单独实现 | 不把 HUD 面板内聊天冒称原生 TUI，无缝接管不是本阶段承诺 |
| 关闭 HUD pane | 关闭该视图；如用户选择关闭 managed 会话才调用 close | 不能反推原生会话已结束或相关 provider 副作用已撤销 |

同一个 native ID 可以有历史上的多个 managed 实例，但同一 HUD_HOME 的接收事务不允许同时为同一明确 nativeRef 建两个可写实例。尚不能确认旧 host/实例结束时不得靠抢行绕过该限制，可选择新 fork；实际所有权仍仅在原 host 的内存句柄中。这个互斥限制只覆盖 HUD 自己，不能证明外部进程不存在。没有官方接管 API 时，不增加反向证明系统来伪造“完全接管”。

## 9. 逐组件处置

以下是实施时的处置表。当前文档提交不删除这些文件；“删除”指新路径稳定、旧使用点退役后删除**代码**，不是删除用户数据。路径依据 a125；独立候选必须核对自身基线再移植。

| 文件/组件 | 处置 | 具体落点 |
|---|---|---|
| `packages/hud-mcp/src/server.ts`, `tools.ts`, `io.ts`, `errors.ts` | 保留并瘦身 | 保留有界 framing、参数/错误/取消处理；工具 body 直接调本进程 manager，TUI IPC 用相同 service/schema。 |
| `packages/hud-mcp/src/main.ts` | 替换启动接线 | 在既有进程内创建 SessionManager、绑定配置 scope，并开本 host 的私有 IPC；不新建 daemon。保留该 host 生命周期内必要的 ledger 连接。 |
| `packages/hud-mcp/src/resolvers.ts`, `registry.ts`, `ledger-registry.ts`, `process.ts`, `hook/*`, `pi-channel.ts`, `pi-host.ts` | 隔离旧兼容；不用于新 owned 控制 | 有价值的原生观察/来源证明可保留，但新 create 不依赖完美 parent session 反推；删去 owned 会话重复 whoami/claim 链。 |
| `packages/hud-mcp/src/delegation.ts` | 逐步替换，不再扩张 | 旧 link/run 请求留旧 handler；新的 managed 请求直达 SessionManager。迁移后拆除新请求不需的旧执行逻辑。 |
| `packages/hud-mcp/src/managed-runtime.ts` | 退出新路径，最终删除旧控制接线 | 不把新三个官方 adapter 再塞进 ManagedNativeRuntime 的 qualification/launch 调度。 |
| 新 `src/managed/manager.ts`, `store.ts`, `server.ts`, `client.ts`, `types.ts` | 限定新增 | 进程内 manager、两张表、一个 IPC 合同；server/client 是原 MCP host 的本地入口和 TUI 路由库，不是新的服务进程。 |
| `src/harness/codex/app-server-transport.ts` | 收敛为 Codex 薄适配主路 | 复用可用 framing/correlation，换到固定官方类型，补 turn/approval/close 和实际产品入口，不另复制 transport。 |
| `src/harness/codex/exec-transport.ts` 与相关 demo | 冻结为 batch 实验，移出默认包/入口 | 如以后保留 batch 命令，单独说明；不与 app-server 自动 fallback，避免一次任务执行两次。 |
| 新 `src/harness/claude/sdk-adapter.ts` | 唯一 Claude 受管适配 | 直接用 SDK Query；旧 print parser 不负责新 control。 |
| `src/harness/claude/print-transport.ts`, `managed-launch.ts`, `managed-command.ts`, `managed-configuration.ts`, `managed-role.ts` | 分拆复用事实，退役旧控制 | 保留配置发现/参数验证中确需部分，停止自己重写 SDK 启动与持续生命周期。print 实验只作为历史/离线 fixture。 |
| `src/harness/pi/rpc-transport.ts`, `managed-launch.ts` | 用薄 `rpc-adapter.ts` 替代 | 旧 0.73 client 留历史 fixture，不再扩功能；官方 1.4 RpcClient 承担进程/协议，薄层处理有限结果关联。 |
| 拟新增 `src/harness/pi/permission-extension.ts` | 只在 Pi 审批阶段新增 | 官方 tool_call → 同一 manager 审批；无自建 JSONL/RPC lifecycle，无私有 client API。 |
| `src/core/launch/{capability,fingerprint,supervisor,index}.ts`, `managed-cells.json`, `codex-cells.json` | 从新路径删除；旧路径隔离 | 不再用 Node/kernel/env/mkfifo/sh/source-build 摘要全矩阵决定普通官方会话可否启动。必要版本/接口检查由 adapter 就地做。 |
| `src/core/capability-manifest.ts`, `src/cli/capability.ts`, `src/core/runtime-build.ts` | 保留诊断/历史，替换展示语义 | 将“此版本实现哪些操作”和“哪些测试实际运行”分开；构建 hash 用于可复现证据，不做活会话授权。 |
| `bin/hud-run`, `src/core/run/*` 的 ticket/group-leader/FIFO/heartbeat/receipt | 不在新 headless 官方主路使用 | 旧 visible/whole-scope 产品仍依赖时保持隔离，不放宽其旧保证；不能让所有 SDK 会话绕行 hud-run。待用户选定这些功能后单独决定维护/退役。 |
| `src/ledger/{ledger,schema,transaction,local-manager}.ts` | 复用 | 同一私有 DB、事务、路径保护，加两张表及兼容查询；不重建存储。 |
| `src/ledger/{intents,reconcile,run-facts,supervisor}.ts` 与 claims/slots | 冻结旧执行；逐步退役 | 新操作不用旧恢复证明链；旧历史只读不丢失，旧活动 run 不能同时被新 manager 操作。 |
| `src/core/link/*` | 保留读模型/历史；隔离旧写证明 | 复用 view-model、冲突/freshness、native topology 中独立部分；新事件不回流触发旧 claim/reconcile 执行。 |
| `src/collectors/delegation.ts`, `src/tree-page.ts`, `src/index.ts`, native readers/topology | 保留 | 接同一 managed 快照；区分 observed/managed、操作状态/进程状态；不要做第二套 renderer。 |
| `src/core/materials/*`、已有 digest/隐私入口 | 保留 | 材料授权与来源/目的地检查仍为唯一外发入口；日志可见不等于可进模型。 |
| 7A authenticated links resource | 保留并接统一读 service | 既有过滤、分页、有界返回可复用；不能算 send/ask 或原生 resources/read 已完成。 |
| 5A Codex config observation | 保留事实与测试 | 接到 app-server 的实际配置读回；配置观察不能授予会话或 OS 权限。 |
| Pi 5B Node discovery | 保留调查/配置诊断，暂停 receipt 扩张 | 官方 client 的公开 Options 没有独立 Node selector，不把不相容的证明对象硬接入。 |
| 5C 多 harness runtime 候选 | 保存候选并暂停集成 | 它延长旧 managed launch 链，不是新主路径；只移植独立且必要的验证/fixture，不能整体叠上。 |
| Jev routing 与自建 durable journal | 保留 schema/fake，暂停执行接线，撤掉第二份 journal 方向 | routing suggestion 不是 browser job。未来若 HTTP 副作用需要去重，复用 operation 记录；公开设计不依赖私有实现。 |
| notes/lifetime 组合、E3、saved panel、D3 committed details | 保留成果与测试，暂停并行改 collector/生命周期 | 先接受同一 managed 状态来源，再逐个接回纯展示/保存能力；不得把旧派生状态覆盖新 operation 终态。 |

### 9.1 在途成果不是共同集成点

截至本次方案的协调状态：5A `6126075` 与 7A `886b2ed` 已发布且普通构建/固定选集 CI 成功；这不等于 dedicated 行为或真实 provider 验证。notes/lifetime 组合候选 tree `d36ea5f` 已通过源码审查但未发布；D3 `d1291b6`、Pi 5B `8299435`、5C `2114083` 未完成独立接受/发布；Jev `a7cc202` 有四项源码审查问题、未发布。这里的短值有的是 commit、有的是 candidate tree，不互换。实施时必须重新解析对应完整对象和实际分支，不能把候选编号当可 checkout 的共同版本。

## 10. 有序实施与 rollback

### 阶段 0：接受选路，不写运行时

交付本方案、官方索引、四文件文档 patch 与完整逻辑文件清单。确认第 1.1 节对旧选择的显式改变。保留所有历史失败、候选和用户数据。现有模拟开发/测试分支发布规则及取消修复额度规则继续有效。

### 阶段 1：一条 Codex 竖向切片

只改必要范围：`src/managed/*`、现有 MCP bridge、Codex app-server adapter、ledger 两表迁移、collector/TUI 的 managed 节点读取、相关合同测试/综合入口测试。无 Claude/Pi/Jev 实现、无安装器改造、无 visible native takeover、无 connection pool。

必须交付：

1. 原生样式 client 启动现有 hud-mcp；该进程内 manager 经配置 scope 创建一个 managed Codex 会话，无新 daemon。
2. 同一会话两次 send/ask，真实工具入口返回 operation ID；TUI 显示 running、waiting approval、最终文本/错误。
3. TUI/同 scope 的另一 MCP host 按原 hostInstanceId 读取/路由同一 operation；不重复创建 backend，不认领旧活句柄。
4. 错 owner、伪造 parent/sessionId、重复请求、approval 超时、cancel 与断线未知处理均通过有限模拟。
5. 原 root 空闲时子任务继续；root EOF 时有界收尾，host crash 未确认结果可见。一份可 checkout 的授权测试分支、一套执行命令和明确 NOT_RUN 项，不把旧大 qualification matrix 作为发布前置。

旧 handler 暂时只接旧 ID，新 handler 只接 managed ID；每个会话只能由一种后端控制。默认切换在竖切验收后显式进行，禁止异常时自动 fallback 旧 exec 启动。

### 阶段 2：接 Claude，同一 service/屏幕/测试合同

增加锁定 SDK 依赖和 sdk-adapter；实现 UUID 对应结果、canUseTool/用户问题/必要 hook、精确 resume/fork。依赖按 backend 懒加载，观察-only 用户不必启动全部 SDK。复用阶段 1 的产品入口测试，不再建 Claude 专用控制服务。公开分发的认证/条款风险列为独立说明，真实账户不阻塞 fake 交付。

### 阶段 3：接 Pi 1.4.0，同一 service/屏幕/测试合同

使用公开 RpcClient；补 handled/settled/abort/cancelled-switch、严格单在途关联、Node/PATH 与环境限制说明。先无工具或明确授权 profile，再按官方 extension 实现单一审批桥。缺 UI response API 不通过 private hack 补齐；强沙箱不支持就如实标注。

### 阶段 4：恢复展示成果，退役旧控制链

按顺序接 7A 资源、5A 配置、D3 细节、notes/lifetime/E3/panel，逐项核对新读模型，不做“所有候选大合并”。原生观察始终保留。只有新入口和回滚测试通过后，才停止旧 managed 新建，并将旧控制代码移出默认打包；历史兼容读取保留。

可见原生 TUI/Herdr、跨平台、Jev browser job、外部 Paseo 后端是后续独立选择，不阻塞前三阶段，也不在前三阶段悄悄做半套。

### Rollback

- 每阶段只在授权测试分支推进，不改 main/integration，不删用户历史。schema 采用向后兼容新增表/列；迁移前用 SQLite 支持的备份方式保存一致副本，不在活库上简单复制 WAL 文件。
- 新 MCP host 与旧 runtime 不同时控制同一 managed/nativeRef。回滚先停止新接收，显式关闭或标记未确认的新实例，再退出这些新 host，切回旧发布。旧版本忽略新表，不接管它不认识的 managed 会话。
- 保留新 managed 记录只读可导出；不能通过“回滚”自动重放 accepted/uncertain operation，也不能为了恢复旧软件删除新记录。
- 数据迁移不兼容时停止切换并报告，不强行降级 schema。新实现未获本地验证时可保留观察-only，不因此撤销已完成的文档/模拟成果。

## 11. 有限模拟验收与本地统一验证

### 11.1 Fake 必须放在官方边界

- Codex：假子进程按固定 generated JSON-RPC 类型实现 initialize/thread/turn/approval/interrupt；使用实际 app-server adapter 的 framing 和 dispatch，不直接把 manager 状态塞成成功。
- Claude：注入 `query` 工厂，返回符合锁定 SDK 公开类型的 fake Query/AsyncGenerator，接收同形 SDKUserMessage；模拟 callback 的真实参数和异步返回。锁定包的类型编译与 fake 行为测试分开记录。
- Pi：注入公开 RpcClient 接口工厂，模拟 prompt disposition、getState、onEvent、abort/stop 的真实限制；另留官方形状 JSONL fixtures 校核边界。不能只用旧 0.73 fixture 证明 1.4。
- DB 使用真实临时 SQLite；IPC/bridge/TUI 走产品入口；HOME/HUD_HOME、输入、路径、账号字段均为合成数据。没有真实 provider call，也不碰用户原生 homes。

### 11.2 第一轮有限合同套件

以下 24 组是固定的起始验收范围，不以所有 OS/Node/kernel/软件 hash 的笛卡尔积替代：

1. 既有 MCP 进程 → 进程内 manager → fake Codex create → send → terminal → TUI 的完整正常路径。
2. 同 managed 会话第二轮复用，答案不串到第一轮。
3. ask 与 send/wait 同 key 只提交一次，重复等待不再执行。
4. 同 key 异参拒绝；两个 bridge 并发同 key 仅一个本地 operation。
5. 非授权 owner、source、workspace 和资源读取拒绝；模型 `_meta/sessionId` 不提权。
6. 原生 parent ID 未知，但明确 scope 可以创建子会话；显示未绑定归因。
7. 两个 MCP host/TUI 重连按原 host 路由，同一个 managed 会话只有一个官方连接所有者。
8. 同会话 busy 拒绝新 send；两个独立会话不混消息。
9. 监听先注册，极速终结不会丢事件。
10. 事件分片、未知事件、过大记录、stdout/stderr 分离与有界缓冲。
11. Codex turn/start ACK 不等于完成，tool item completed 不等于 turn completed。
12. Codex retry 通知继续 running；最终 failed/interrupted 分别映射。
13. 真实形状 approval/user input 展示，答复回同一官方 request；普通 agent 不可自批。
14. 审批超时/断线/重复/旧 generation 答复不批准新调用。
15. wait/ask 超时仍可继续查；MCP cancellation 只取消等待。
16. cancel ACK 后无 terminal 为 unconfirmed；terminal 到达后才更新结果。
17. close 与 cancel、archive、pane close 分离，历史保留。
18. dispatch 前、发出后、ACK 回写前各断线，未执行与未知区别准确，未知不补发。
19. root idle 不终止子任务；原 MCP EOF 有界收尾，host 重启/崩溃只读历史，显式 resume 新实例，旧 operation 不自动运行。
20. native observed 会话拒绝 send；显式 fork 返回新绑定，resume 忙时不覆盖旧实例。
21. Claude UUID/result 关联，合并/无关联/subagent/error/deferred/interrupt 结果不串线。
22. Pi started/handled/queued，agent_end 后重试与最终 settled，switch cancelled、过期 listener 清理。
23. 资源越权、路径穿越、历史截断/过期、无活 host 的只读界面与 freshness。
24. 多次 create/close 后 listener/自有连接/计时器有界；资源释放不伪称所有外部工具进程结束。

每组给输入、预期、实际命令、实现 commit、spec pin、模式和 PASS/FAIL/NOT_RUN。阶段 1 只对已实现的 Codex/common 项负责，Claude/Pi 项明确 NOT_RUN；阶段 2/3 增补对应结果。普通 build、固定 CI 选集、dedicated 模拟合同、官方本机无模型检查、真实 provider 检查各自一列，不能互相顶替。

**本次文档交付**：接口与源码阅读是文档证据；上述 24 组产品行为测试全部 NOT_RUN，因为本次没有实现新运行时。不能写成“设计已通过模拟”。

### 11.3 用户后续本地一次验证

交付同一个实际集成 commit 后，用户可统一执行：

- 记录实际 SDK/CLI/package 版本、Node、路径和 profile；确认认证/条款允许该用途，确认是否进行真实付费调用。
- 先只检查官方进程启动/初始化/schema 与关闭，不发模型 prompt；失败分类为路径、版本、权限、认证或接口问题。
- 每后端各建一个 HUD-owned 会话，连续两轮，TUI 和 operation 结果一致。
- 各验证一个审批/用户问题、拒绝、cancel、close、超时后查询及重连。
- 精确 resume/fork，检查新 managed 实例与旧 native history 的差异；原生窗口只读观察不被误控。
- 确认材料只发到批准的后端，真实权限/沙箱能力与 UI 声明一致。
- 验证进程/连接与内存不会随委派次数无界增长；官方子进程和外部工具清理分开观察。

本地报告补齐真实 PASS/FAIL/NOT_RUN，才决定哪些组合可称已验证。没有真实验证不阻止测试分支交付，也不意味着可默认宣称发布级完整支持。

## 12. 不纳入默认方案的替代路线

**新增会话宿主，只作为待用户决定的 G13 变更**：如果用户要求所有 native root 退出后任务仍持续、任意客户端之后都能接回原活连接，现有 MCP host 生命周期不能提供这个保证。可以另选显式 hud serve 或外部 Paseo daemon 作为唯一连接宿主，但这会新增长生命周期进程，必须先明确改变 G13。当前默认不实施、不安装、不自动启动；不能把“轻量”当作不算 daemon 的理由。

**Paseo 可选后端**：如果用户明确希望复用整套会话服务，可以使用已核实的 `@getpaseo/client@0.15.3`，而不是复制 Paseo 巨大的 provider 文件。此时 Paseo 是该会话的唯一 provider owner，HUD 的进程内 manager 只作为薄 client/授权入口，不再同时持有该会话的 SDK 或 hud-run，不镜像第二套 provider 生命周期。这个选择带来外部 daemon、存储、配置和许可/升级依赖，不是默认安装项，必须按同一合同验证。

**Codex SDK/exec、Claude print、Pi in-process SDK**：都是有用途的官方替代接口，但同一会话只选一条主路。若以后为批处理或嵌入式场景换路，新增明确 profile 和迁移说明，不能失败时静默跨路重试同一任务。

Orca、Paseo、Cindy 本次按功能和源码选出最相关候选；用户未提供 URL，名称映射仍属假设。借鉴它们直接持有官方会话、标准化事件与明确取消的模式，不能把某项目技术上支持订阅登录当成 HUD 也有同样商业授权。具体 pins 与许可见[参考索引](official-harness-reference-index.md#开源实现参考不是默认依赖)。

## 13. 剩余风险与不承诺项

- 官方滚动网页会变，Claude npm 包类型、Codex 生成 schema、Pi 公开方法必须与实际安装版本对齐。接口缺失只影响相应功能，不能生成新的全环境资格体系。
- Claude SDK 第三方分发/认证限制未由本方案解决；本方案没有登录、安装、付费调用或接受条款。
- Pi 1.4 RpcClient 的 handled helper、继承环境、Node selector、extension UI reply 和 shutdown 限制是真实接口边界，不应通过 private hack 隐藏。
- MCP 原生 parent 身份并非协议自动提供。scope 授权可以足够委派，精确父子显示需要另有可信绑定。
- 官方 cancel/close、连接退出或 OS 进程退出均不能保证已发生的 provider/tool 副作用未发生；没有 exactly-once、无损 crash recovery、原生进程接管或普遍 whole-scope 清理保证。
- 三 backend 的权限与沙箱保证不同。需要强隔离而当前 backend 无法满足时，显示 unsupported 或让用户作明确范围选择，不能自动放宽。
- UI、数据读取、恢复说明和产品入口的集成仍须真正实施；本文的完整设计不是实现完成声明。

验收目标很具体：用户从原生 harness 调用一次已授权的 HUD MCP，得到一个可继续 send/ask 的受管子会话，并在同一个 HUD 中看到可信状态。实现这条路径后再扩展，而不是先证明整个机器和所有可能会话。
