# 官方 harness 接口索引与选路记录

读取日期：2026-11-06。配套[简化架构](simplified-harness-architecture.md)。本索引区分**官方事实、方案选择、现有接线、尚未验证**，不是三后端已经可用的声明。

产品分析固定在 `CartmanFatass/codex-hud@a1250f07995465b40e29a284a732978894c3e7ee`。文档修改基线为 `70665c3a0ed07a324fec476da6c6eb0b1c2354c3`。当前真实路径是 hud-mcp → resolver/delegation/managed-runtime → hud-run；TUI 从 ledger 和 native 观察构建视图。独立 transport 实验不等于产品已采用对应 SDK。

默认新设计把 SessionManager 放在**既有 hud-mcp 进程内**，由创建会话的 host 独占连接；没有新增全局 daemon。原生 root 可通过明确配置的 owner/workspace scope 委派新的 HUD-owned 子会话，不要求先得到完美的原生 parent session ID。

## 版本记录规则

- 固定源码链接使用完整 commit；滚动文档记读取日期。新文档字段不能倒推旧二进制支持。
- 选定开发版本、实际安装版本、schema/公开类型编译、fake 行为通过、真实 provider 验证分别记录。
- 下面的版本是研究/设计输入，不表示本次安装或运行过官方软件。
- 本表是后续主索引。旧 m2 文档和 probes 保留原 pin 与历史结果，不改写成新版本验证。

## Codex

**主路径：app-server。** 本项目要持久 thread、连续输入、turn 事件和审批；因此选择官方 app-server，不同时维护 exec/SDK 的第二套长会话后端。

| 官方资料 | 用途与已核实接口 | 版本/选路 | 当前产品位置与待接线 |
|---|---|---|---|
| [App Server 正式入口](https://learn.chatgpt.com/docs/app-server) | 初始化、thread/start/resume/fork、turn/start/steer/interrupt、item/turn notifications、server requests | 2026-11-06 滚动文档；生产实现必须与下面固定 schema 对齐 | `src/harness/codex/app-server-transport.ts` 是独立实验；需接进 hud-mcp 内 manager、turn 结果、审批和既有 TUI |
| [ClientRequest generated types](https://github.com/openai/codex/blob/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/codex-rs/app-server-protocol/schema/typescript/ClientRequest.ts) | 客户端可以发的实际 method/params | `openai/codex@d786ff91fad8e7ddab8653ee07bc6313a6fcb03d` | 新 adapter/fake 共用该版本类型；未完成实际 CLI/schema conformance |
| [ServerRequest generated types](https://github.com/openai/codex/blob/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/codex-rs/app-server-protocol/schema/typescript/ServerRequest.ts) | command/file/permissions approval、requestUserInput、MCP elicitation、dynamic tool call 等不同请求 | 同一 pin；不能把不同响应简化成一个 boolean | 需要回到原连接原 request ID；HUD UI 回调不是普通 send |
| [DynamicToolCallParams](https://github.com/openai/codex/blob/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/codex-rs/app-server-protocol/schema/typescript/v2/DynamicToolCallParams.ts) | 官方显式给 threadId、turnId、callId 的客户端工具通路 | dynamicTools 为 experimental，默认不必启用 | 未来若启用可直调同一核心；不能声称普通 MCP 每次调用也携带这些可信字段 |
| [CommandExecutionRequestApprovalParams](https://github.com/openai/codex/blob/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/codex-rs/app-server-protocol/schema/typescript/v2/CommandExecutionRequestApprovalParams.ts) | 绑定 thread/turn/item 与具体动作/网络审批范围 | 同一 pin；字段以类型和实际请求为准 | 保留 request ID/approvalId 差异；不要把网络授权渲染成猜测的 shell 命令 |
| [TurnCompletedNotification](https://github.com/openai/codex/blob/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/codex-rs/app-server-protocol/schema/typescript/v2/TurnCompletedNotification.ts) | 对应 turn 的终结，不是 item 文本结束 | 同一 pin | ask 绑定官方 turn ID；`willRetry` 不能直接变失败 |
| [Codex SDK 正式入口](https://learn.chatgpt.com/docs/codex-sdk)、[固定 TS SDK README](https://github.com/openai/codex/blob/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/sdk/typescript/README.md)、[非交互 exec](https://learn.chatgpt.com/docs/non-interactive-mode) | TS SDK 封装 CLI JSONL，适合 run/runStreamed 等脚本任务 | 合法 batch 替代，不是本方案第二主路；当前 SDK 页说明旧 codex mcp-server 路线已移除 | `src/harness/codex/exec-transport.ts` 冻结为独立实验；失败不能自动 fallback 并重发 |
| [Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp) | 让 Codex 调用外部工具；stdio/HTTP 配置与权限 | 2026-11-06 正式入口；不要用猜测的 `/docs/mcp` 或 `/docs/mcp-servers` | 原生 root 调 hud-mcp 的入口，不是 Codex 会话控制 API |
| [Codex hooks](https://learn.chatgpt.com/docs/hooks)、[高级配置](https://learn.chatgpt.com/docs/config-file/config-advanced) | 原生观察、配置和有效能力事实 | 读取日期如上；未文档化 rollout 字段仍为版本敏感观察 | 5A config/read 是独立观察成果；不能把配置值当 owner 或 sandbox 授权 |

本方案只选已需要的 app-server 子集。`thread/unsubscribe` 不是停止任务，archive/delete 不是 close；恢复用精确 thread.id，不能由 sessionId 猜。源码 workspace 的版本占位不代表一个已安装发布号；后续实际 CLI 版本和生成 schema 必须记录。

## Claude

**主路径：Claude Agent SDK 的 TypeScript streaming Query。** 持久输入、工具审批、用户问题和 session controls 由官方包承担，不再维护并行 print 控制层。

开发依赖候选：`@anthropic-ai/claude-agent-sdk@0.3.319`。官方仓库快照 `49dd8ef10dd5cb012dc9fe10703376489850c36c` 的 [CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/49dd8ef10dd5cb012dc9fe10703376489850c36c/CHANGELOG.md)记录该版本与 Claude Code 2.1.319 对齐。滚动 API 文档读取于 2026-11-06，不能全部归到旧 CLI 2.1.305。该 npm 包未在本次安装/编译，具体公开类型的 conformance 仍 NOT_RUN。

| 官方资料 | 用途与已核实接口 | 选中接口/边界 | 当前代码与待接线 |
|---|---|---|---|
| [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)、[官方仓库 README](https://github.com/anthropics/claude-agent-sdk-typescript/blob/49dd8ef10dd5cb012dc9fe10703376489850c36c/README.md) | SDK 入口、安装/认证范围、许可说明 | 官方包，不是普通 HTTP Messages API 代写 agent loop | 当前 package.json 无此 SDK；拟新增 `src/harness/claude/sdk-adapter.ts` |
| [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript) | query、Query、SDKUserMessage/SDKResultMessage、interrupt/close、session API | 选 query + AsyncIterable 输入；每消息 uuid，按返回关联字段结束 ask | 需包类型校核、事件映射和 Query 生命周期接线；当前 print parser 不等价 |
| [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) | 多轮持续输入、实时反馈、interrupt 和完整工具能力 | 每会话一个 Query；第一版单在途输入，不依赖隐式合并队列 | 拟同一 MCP/CLI send/ask；没有一轮一个 shell wrapper |
| [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions) | continue/resume/fork 的不同含义，历史保存而非文件回滚 | 精确 resume；fork 后新 ID；不以“最近 session”满足指定恢复 | 官方 ID 读回后绑定，未读回前 nativeRef 可空；不接管原生终端 |
| [User input 与审批](https://code.claude.com/docs/en/agent-sdk/user-input) | canUseTool 与 AskUserQuestion；用户答复原 callback | 只有操作者可答复；挂起 callback 不跨 host 重启复活 | 同一 manager 审批入口，不另造 permission journal |
| [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)、[SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks) | permissionMode/allow/deny/ask 与 PreToolUse | canUseTool 不拦自动批准；强制本地约束使用合适 hook/工具边界，不自动 bypass | 所选 profile 要展示实际权限；不冒称与 Codex OS sandbox 等级相同 |
| [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)、[SDK MCP](https://code.claude.com/docs/en/agent-sdk/mcp) | tool/createSdkMcpServer/mcpServers | 每 Query 的 in-process handler closure 可绑定 HUD managedId；不靠模型传 owner | 可选有限内部工具直接复用核心，不默认递归开放管理权 |
| [Headless CLI](https://code.claude.com/docs/en/headless) | print/stream JSON，适合一次性或非 SDK host | 合理替代但不是同时维护的第二主路 | `src/harness/claude/print-transport.ts` 是独立实验；managed print 启动须退役/隔离 |
| [Claude statusline](https://code.claude.com/docs/en/statusline)、[native hooks](https://code.claude.com/docs/en/hooks)、[native MCP](https://code.claude.com/docs/en/mcp) | 原生会话观察及原生 root 工具入口 | 保留只读 source；快照不授予输入控制权 | `src/harness/claude/reader.ts`、既有 hook/resolver 等不因 SDK 接入全部删除 |

术语分开：SDK 技术能力、SDK/依赖许可证、账号的认证使用权限是三件事。[Commercial Terms](https://www.anthropic.com/legal/commercial-terms)约束 SDK 使用；overview 明确第三方产品提供 claude.ai 登录/订阅使用有额外限制。未经适当批准不能承诺公开 HUD 支持这种认证方式，也不能由 Orca/Paseo 的实现推导许可。该风险不使真实账号成为模拟开发前置。

## Pi

**主路径：官方导出的 RpcClient，版本 1.4.0。** Pi 官方明确推荐 TypeScript 子进程集成用它；in-process SDK 是另一条合法但不同时采用的路线。

| 官方固定资料 | 用途与已核实接口 | 版本/限制 | 当前代码与待接线 |
|---|---|---|---|
| [package.json](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/package.json)、[公开 exports](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/index.ts#L417-L430) | 包名、1.4.0、Node >=22.19.0、RpcClient 导出 | `4a080252f06caf63a525d7873c5d94d3c23887e0`；不代表已安装此包 | 拟 `src/harness/pi/rpc-adapter.ts`；不用 deep/private API |
| [RPC mode](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/rpc.md) | 官方推荐 client、JSONL、prompt 接收与运行终结区分 | started/queued/handled；agent_end 与 agent_settled 不同 | 不继续自建 0.73 全生命周期；接同一 manager/TUI |
| [RPC commands](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/rpc-commands.md) | prompt/steer/follow_up/abort、get_state、switch_session/fork/clone/get_tree | session 操作可 cancelled；普通事件通常无 request ID | 单在途运行关联；官方响应不提供的稳定 turn ID 不伪造 |
| [RpcClient 源码](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/rpc/rpc-client.ts) | 公开 typed client 方法及实际实现 | promptAndWait 未处理 handled；stop 用 TERM/KILL；spawn node 且合并继承环境；无公开 extension UI reply | 薄层处理 disposition/超时/listener；不访问 private send/process，不宣称环境已净化 |
| [CLI](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/cli.md) | session/bin、tools、扩展/MCP/资源发现开关 | no-tools 不等于 no-mcp；no-extensions 仍允许显式 -e | 受控 profile 必须明确，不能静默改原生发现行为；5B Node receipt 不等于 RpcClient Options |
| [Extensions](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/extensions.md)、[permission-gate 示例](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/examples/extensions/permission-gate.ts) | tool_call 可拦截/阻止工具；扩展与进程同 OS 权限 | 示例的危险命令正则不是完整安全策略，extension 不是 sandbox | 若要逐工具审批，单个明确加载的薄 extension 连接原 host；未实现前相关 profile unsupported |
| [RPC Extension UI](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/rpc-extension-ui.md) | 原始协议的 extension_ui_request/response | 协议具备不等于 RpcClient 提供公开 reply API | 不把它承诺为默认通用审批桥；不再复制完整 RPC client 只为该能力 |
| [In-process SDK](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/sdk.md) | createAgentSession 等进程内嵌入接口 | 官方备选；本轮选择隔离子进程 RpcClient | 如以后换路要显式决定，不同时维护两套 Pi owner |
| [v0.73.1 历史 RPC](https://github.com/earendil-works/pi/blob/v0.73.1/packages/coding-agent/docs/rpc.md) | 理解旧 fixture/transport 的原始假设 | 历史兼容来源，不再是新主路版本；不能按 1.4 settled 语义重判旧记录 | `src/harness/pi/rpc-transport.ts` 和 m2 文档保留历史标签，停止继续扩旧 client |

漂移修正：旧 cloud handbook 将 Pi RPC v0.73.1 与“项目未选版本”放在当前主索引，但 a125 的 managed-targets/pi-delegation-bridge 已选 1.4.0。现在明确分成“历史实验 0.73.1”和“新主路开发目标 1.4.0”，两者都不是用户实际安装版本的检测结果。

## MCP 与控制身份

- [MCP transports 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)：stdio 由 client 启动 server；HTTP session ID 管 transport 生命周期，不证明一条 native conversation 的 owner。
- HUD 外部 MCP 入口使用用户明确配置的本地 owner/workspace scope。sessionId、parentId、工具 `_meta` 和 request_key 不得自行授予权限。
- 官方 callback 若来自 HUD 自己持有的连接，可直接复用其绑定。例如 Claude 每 Query closure，Codex 带 thread/turn ID 的 server request，Pi 原 host 的明确 extension channel；这些不是自动附着到所有 MCP 调用的字段。
- 数据读权限、材料外发、backend 工具权限分别检查；不能用一张“capability verified”表替代真实授权。

## 开源实现参考，不是默认依赖

用户仅给出 orca、paseo、cindy 名称，没有 URL。下面是按功能和源码核实的最相关候选，不断言就是用户指代的唯一项目，也不声称项目此前已经参考它们。

| 候选与 pin | 实际参考点 | 复用决定与许可 |
|---|---|---|
| [stablyai/orca@2462e9cac4054af9a8b86de18e75b94f3bf129d6](https://github.com/stablyai/orca/tree/2462e9cac4054af9a8b86de18e75b94f3bf129d6) | [Claude SDK connection](https://github.com/stablyai/orca/blob/2462e9cac4054af9a8b86de18e75b94f3bf129d6/src/main/claude/claude-stream-json-connection.ts)、[Codex app-server session](https://github.com/stablyai/orca/blob/2462e9cac4054af9a8b86de18e75b94f3bf129d6/src/main/codex/app-server/codex-app-server-session.ts)、[Pi RPC turns](https://github.com/stablyai/orca/blob/2462e9cac4054af9a8b86de18e75b94f3bf129d6/src/main/pi/rpc-turns.ts) | 借鉴连接持有/事件/取消与可注入 fake，不复制 Electron/远程工作区。仓库 [MIT](https://github.com/stablyai/orca/blob/2462e9cac4054af9a8b86de18e75b94f3bf129d6/LICENSE)；拷贝代码仍保留版权/许可，其他依赖另算 |
| [getpaseo/paseo@9f68af0274ca06c5decd6269d870d442b8e04500](https://github.com/getpaseo/paseo/tree/9f68af0274ca06c5decd6269d870d442b8e04500) | [Claude query](https://github.com/getpaseo/paseo/blob/9f68af0274ca06c5decd6269d870d442b8e04500/packages/server/src/server/agent/providers/claude/query.ts)、[Codex adapter](https://github.com/getpaseo/paseo/blob/9f68af0274ca06c5decd6269d870d442b8e04500/packages/server/src/server/agent/providers/codex-app-server-agent.ts)、[Pi runtime](https://github.com/getpaseo/paseo/blob/9f68af0274ca06c5decd6269d870d442b8e04500/packages/server/src/server/agent/providers/pi/runtime.ts)、[公开 client API](https://github.com/getpaseo/paseo/blob/9f68af0274ca06c5decd6269d870d442b8e04500/public-docs/sdk/agents.md) | 可选调用 @getpaseo/client 0.15.3；选择它意味着外部 daemon 成为唯一 provider owner，并需明确改变 G13。默认不引入。[仓库 LICENSE](https://github.com/getpaseo/paseo/blob/9f68af0274ca06c5decd6269d870d442b8e04500/LICENSE) 和 [client LICENSE](https://github.com/getpaseo/paseo/blob/9f68af0274ca06c5decd6269d870d442b8e04500/packages/client/LICENSE) 为 Apache-2.0，[client package.json](https://github.com/getpaseo/paseo/blob/9f68af0274ca06c5decd6269d870d442b8e04500/packages/client/package.json) 为 0.15.3；保留 LICENSE/NOTICE 及第三方许可 |
| [makecindy/cindy@5c1ddeeab20476e9fc8fd40a99ad19ac958b7006](https://github.com/makecindy/cindy/tree/5c1ddeeab20476e9fc8fd40a99ad19ac958b7006) | [Claude agent](https://github.com/makecindy/cindy/blob/5c1ddeeab20476e9fc8fd40a99ad19ac958b7006/packages/maker-core/src/agents/claude-code/index.ts)、[Codex stdio transport](https://github.com/makecindy/cindy/blob/5c1ddeeab20476e9fc8fd40a99ad19ac958b7006/packages/maker-core/src/agents/codex/app-server/stdioTransport.ts)、[Pi transport](https://github.com/makecindy/cindy/blob/5c1ddeeab20476e9fc8fd40a99ad19ac958b7006/packages/maker-core/src/agents/pi/transport.ts) | 借鉴官方后端与 UI 事件的分离，不搬整个 maker-core。仓库 [Apache-2.0](https://github.com/makecindy/cindy/blob/5c1ddeeab20476e9fc8fd40a99ad19ac958b7006/LICENSE)，依赖许可分别保留 |

它们证明“先直接持有官方连接”是可行的实现方向，不证明 HUD 可以零适配接入，也不替代账号、数据共享或商用许可。当前方案优先官方包/协议，未把以上项目作为新 runtime 依赖。

## 当前代码对应与验收状态

| 路线 | a125 事实 | 本方案之后应有的产品入口 | 本次实际验证 |
|---|---|---|---|
| 旧 managed launch | resolver → delegation → managed-runtime → hud-run；空 capability cells | 保留旧 ID/历史兼容，退出新 owned 主路 | 源码阅读；非运行验证 |
| Codex app-server | 独立 transport，没有完整 send/ask 产品闭环 | 既有 hud-mcp 内 SessionManager → app-server → 同一 TUI | 设计/源码对照；产品模拟 NOT_RUN |
| Claude SDK | 没有依赖/接线；独立 print transport | 同一 SessionManager → SDK Query → 同一 TUI | 官方文档/发布记录；包类型和产品模拟 NOT_RUN |
| Pi RpcClient 1.4 | 旧 0.73 RPC 实验与 1.4 managed print 分开 | 同一 SessionManager → 官方 RpcClient → 同一 TUI | 官方源码/导出对照；产品模拟 NOT_RUN |
| 原生观察 | 已有 readers、hooks、topology、ledger 投影 | 保留只读；精确来源与 freshness 不授予输入权 | 本次未运行现有行为套件 |

后续每次实现只补一份结果表：精确集成 commit、官方 pin/锁定依赖、实际命令与模式、PASS/FAIL/NOT_RUN、未支持的接口和用户本地待验证项。不要再创建平行的完整索引或把每个机器版本组合变成另一套资格工程。
