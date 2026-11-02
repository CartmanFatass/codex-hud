# 06：观测口径、采集一致性与运行预算

- 版本：`v0.2 draft`（2026-11-01；A2 + Oracle D01–D13）。预算是验收要求，本批没有运行性能测试或声明已经达标。
- depends-on：[01 身份](./01-identity.md) I-01-1、I-01-8；[02 执行](./02-execution.md) I-02-8–10 与唯一 R-02 对账表；[03 生命周期](./03-lifecycle.md)「报告与 status」「wait 游标与 runId 固定」；[04 托管](./04-supervision.md)「心跳、supervisor死亡与恢复」、I-04-15；[05 能力](./05-capabilities.md)「宿主、定位与 timeout」；[07 外发与兼容](./07-outbound-compat.md)；[概念 v2.3](../universal-hud-concept.md) G13/G14、§6.3–5、§6.8–12、§7、§9.3；[计划](../universal-hud-engineering-plan.md) B8/B12/B16/D2–D4。
- [Oracle](../reviews/2026-11-01-astra-contracts.md) §2、C07、C11–13 是成本与恢复边界的依据；不复写 02 对账真值表。[信息设计](../design/hud-information-design.md) §7 是数据消费者要求；本文不决定标记、布局、计数桶或交互。其原生退出结果假设以 Oracle 的 nullable 结果为准。

[Oracle consult 2](../reviews/2026-11-01-astra-consult2.md) D01–D13 补齐字段、控制主体与读取边界；本轮仍是 A4/A9 候选契约，不代表 A9 放行或 B 生产能力已验证。

[Oracle consult 3](../reviews/2026-11-01-astra-consult3.md) E01–E06 同步观测绑定、取消分类、事实时序与 export v1；仍是 A9 候选，不代表阶段 B 生产验收。

冻结后生效版本：`A9 + consult4-2026-11-01`。[Oracle consult 4](../reviews/2026-11-01-astra-consult4.md) 的下列增补保留此前裁决、schema v1 与 B 生产验收边界；checkpoint 隐私与恢复修补不得推迟到 D2。（consult 4 增补，F01）（consult 4 增补，F02）（consult 4 增补，F09）（consult 4 增补，F10）（consult 4 增补，F11）

（F08 Pro 裁决增补）[F08 Pro 裁决](../reviews/2026-11-01-chatgpt-pro-f08-hook-budget.md) 仅替代 consult 4 F08 对显式 `claude_pre_tool_use_v1` 档案的联合成本门槛；下文落入 P-06-4/5、T-06-14/16 与测量协议。MCP 内部及其他预算不放宽，G13仍为硬门禁，预算批准不等于生产实现达标。

冻结后增补版本：`A9 + consult4 + F08-Pro + consult5-2026-11-02`。本轮依 [Oracle consult 5](../reviews/2026-11-02-astra-consult5.md) 增补，保留此前 C/D/E、consult 4 F01–F11、F08 Pro 与 A9-fix；ledger schema v1 不变，不授予尚未验收的生产能力。（consult 5 增补，G02）（consult 5 增补，G05）（consult 5 增补，G06）（consult 5 增补，G09）（consult 5 增补，G10）（consult 5 增补，G11）

## 数据模型

### Metric 与时间

`Metric<T>={value:T|null, source:string, asOf:number, quality:reported|estimated|unknown}`。source 是可定位的适配器/字段与口径版本，不是模型名字猜测；reported 仅表示来源确实报告此值，不保证计费或任务质量。estimated 必须说明公式/窗口；unknown 的 value=null，不能填 0。asOf 为来源支持该值的事件时刻；来源没有事件钟时可用首次取得该条证据的观测时刻，但 source 必须标 observed-time。unknown 无值时 asOf 是本次确认缺失的时刻，不得当最后有效证据时间。重复读同一记录不能刷新有效值的 asOf。

证据外层另带 `observedAt`（本次成功获取该证据的时刻）、`lastEvidenceAt`（最后有效事件/首次观测证据的时刻）、`lastSuccessfulReadAt`、`lastError?`。毫秒 epoch 用于新内部摘要/投影及 notice；时长用单调钟，时钟异常保留 reason。旧 --json v2 的 ISO 时间格式保留，转换边界归 07。mtime、snapshot.updatedAt 和 heartbeat_at 各有自己的含义，不互相冒充。

| 指标 | source / 计算口径 | asOf / quality 与边界 |
|---|---|---|
| model / effort | 当前会话实际 model/turn 配置事件；cc statusline stdin 的明确值优先于摘要；不是全局配置默认值 | 该事件；观测值 reported，缺失 unknown |
| Codex context | 最近 token_count 的上下文计数和窗口；保留现有 baseline-adjusted 展示口径，原始值与派生值分开 | 最近有效 usage/compact；原始 reported，基线比例 estimated；不能用累计会话 tokens 当上下文 |
| cc context | 最新 assistant 的 input_tokens + cache_read_input_tokens + cache_creation_input_tokens；window 取本次 stdin 或有版本的模型表 | 对应 message；usage/stdin reported，模型表 window estimated；compact_boundary 使旧上下文失效 |
| pi context | 最新 assistant 的 input + cacheRead + cacheWrite，不用含 output 的 totalTokens | 对应 message；reported；compaction 后重建基线，旧值不冒充压缩后读数 |
| spent.tokens | Codex 累计计数直接取；cc 按唯一 message.id 求和；pi 逐 assistant usage 求和 | 最后纳入的 usage；同 id 不重复，累计不增不刷新；重放不双算 |
| spent.costUsd / credits | pi usage.cost.total；Flow cost_preview 与已确认 credits 分列。未知价格不推美元；显式零值仍不是「免费」保证 | 来源事件；确认值 reported、preview estimated；Jev 无 token 时 unknown |
| output rate | Codex 沿用 turn wallclock proxy：输出增量 /（测量墙钟区间减已闭合工具等待并集），保留样本时长/结束/方法 | 最后增长样本，estimated；无有效基线不生成速率，不用旧样本刷新时间；跨 harness 口径不同不混加 |
| progress / quota / goals | adapter 的类型化能力，Codex plan、cc todo、原生 quota 等分别标 source | 来源事件；原生事实 reported、预测 estimated；无能力 unknown，不填零 |

spent 只含本节点；合计须单位、口径、coverage 相容且无重复 ref，否则标部分合计/未知。usage 去重集合、压缩标记、工具等待配对与速率基线都是 checkpoint 的恢复状态，不能只持久化 offset。

新观测类型按指标分别包装：`spent={tokens:Metric<TokenUsage>,costUsd:Metric<number>}`，其中 TokenUsage 包含 input/output 与可选 cacheRead/cacheWrite/reasoning；`costUsd` 必有，缺价格/成本口径时为 `{value:null,quality:'unknown',source:<明确来源及缺失原因>,asOf:<确认缺失时刻>}`。tokens已知不使costUsd变reported，设计中的costUsd:null指其value，不另存裸字段。有效零保留0/reported；未知价格不按tokens换算美元，Flow credits保持另一单位，不给ledger加cost列。树级合计按完整SessionRef去重，携带 knownCount/missingCount、coverage与quality；只有同口径非负已报告成本部分和才可作该口径下界，混入估计必须estimated且不声称严格下界。旧v2缺省/零例外留07（T-06-22）。

### SessionEvidence 的链接观测

（consult 4 增补，F01）SessionEvidence.linkEvidence 使用共享判别联合 `ToolResultLinkEvidence | LaunchMessageLinkEvidence`：tool_result 保留原生调用身份与原字段，launch_message 保留 `ref/nativeMessageId/linkId/claimFingerprint/eventAt`，可选 launchCallId/launchCorrelationId 仅来自确实提供这些字段的原记录。指纹取原 claim 字节的 SHA-256/64 位小写十六进制，不保存明文 claim、整条消息或完整 prompt；不为启动消息伪造 runId/tool/callId。eventAt 必须是原记录有效事件时间，缺失则仅无授权候选/缺失原因，observed-time 不补 01 签发窗。它们都是未裁定锚点，不是绑定许可；启动消息还须唯一匹配既有 link/run 的本轮 claim 指纹/call/correlation/精确消息、原事件时间窗、完整 SessionRef/source 和独立启动/会话证据，不能取首条/历史复制/发现时间代替。B4 冻结 fallback 运输格式与 correlation（正常 env 不重复传明文），B8 只抽取，B9 只限定核验及候选/冲突投影；回填/撤权由 B2/B5 reconciler 事务提交，HUD/B9 读取不成为写者（01 I-01-5、T-01-14–16）。

### WorkspaceContext 与项目归属

| 字段 | 语义 |
|---|---|
| `cwd: string \| null` | 已定位会话的工作目录，已知时为绝对路径；未知为null，不能填HUD自己的cwd或候选目录。附来源与时间，不是每条shell工具命令各自临时cd。 |
| `worktreeRoot: string \| null` | 该cwd对应的checkout顶层目录，规范化绝对路径；无工作树、不可读或未取得证据时null。 |
| `worktree?: string` | 可选显示名，来自明确label或工作树根显示短名；不承诺Git有独立永久公开名称，不把branch当身份。 |
| `gitCommonDir: string \| null` | 解析后的Git common directory的realpath，私有本地证据；相对结果按Git返回语义解析，不拼.git或用dirname反推主工作树。 |
| `repoId: string \| null` | `SHA256(UTF8(canonicalJSON(['git-common-dir-v1', realpath(gitCommonDir)])))`；标明`identityKind=git-common-dir-v1`、`scope=local`。仅本机仓库位置分组键，不是跨机器/clone/搬迁永久项目UUID。 |
| `projectOrigin: {repoId, basis: declared, declaredAt} \| null` | 临时副本等场景的显式来源声明；接受时另记声明主体，不替换物理repoId，不升级为经Git证明同仓库。 |
| 来源与时间 | 保存cwd来源、Git捕获时刻与缺失原因，不把旧header cwd写成刚核验的当前进程cwd。 |

07「v1 来源与原因代码」另定 export v1 的 nullable CwdSourceCode/GitMissingReasonCode，内部 WorkspaceProvenance.cwdSource 仍为 string，不为导出收窄内部诊断。

来源/时间的类型位置为 `cwdSource:string,cwdAsOf:number,gitCapturedAt:number|null,gitMissingReason:string|null`；无cwd时cwdSource解释缺失，cwdAsOf是确认缺失时刻。Git捕获完成（含非Git/超时）记录gitCapturedAt及原因，尚未采集时为null。`identityKind:'git-common-dir-v1',scope:'local'`描述repoId算法/范围。`RunWorkspaceSnapshot`白名单仅含上述Git字段（worktreeRoot/worktree/gitCommonDir/repoId/identityKind/scope）及来源/时间；launch_cwd和project_origin分别按02保存，快照不混入正文、remote或其他自由字段。observed WorkspaceContext是后续带来源的位置，不能覆盖逐run启动历史。

（consult 4 增补，F02）reader 的 `SessionEvidence.cwdSource` 为 `session_meta | transcript | unknown`；合格 Claude transcript cwd 返回 transcript，未知 cwd 仍 null/unknown，不伪称 Codex session_meta。cwdSource 仅是位置来源类别，不授身份、不触发 Git、不覆盖冻结的 launch_cwd；事件时间或明确首次观测语义沿用本契约，重复读取不刷新。`claude.transcript.cwd` 可保留为内部诊断细节，不另立权威 cwdSource；WorkspaceProvenance 的诊断 string 与 07 的 export v1 词表仍各有边界，新增 transcript 明确映射到既有 transcript 代码，不扩出口词表、不猜字符串。01/02 的 callers.cwd 是另一个物理 MCP 诊断字段，不用于补会话未知 cwd。

Git/项目解析属于共享workspace元数据逻辑，reader只供确实读到的cwd及来源；不新增常驻服务。工作树判等用有效规范根路径，cwd差异独立比较规范cwd；根未知时只能说目录不同，不声称不同工作树，未知不代表相同、同名不代表同目录。repoId与SourceId完全独立，同仓库的双home不合并ref/owner/授权/采集存储。同remote的两个clone仍为不同本地仓库；remote URL/hash、父子关系、目录名/内容相似不证明项目来源。无Git临时副本没有显式声明则unknown，toktrack可保留自己的推断与置信来源，HUD不作确定背书。

Git不入写事务、MCP accepted热路径、HUD paint或statusline，热路径只读缓存；冷缺失由已有启动/采集流程补齐。每个新工作目录或失效代次最多一次发现工作，最多2次Git子进程、总软预算200ms，超时终止子进程并记unavailable；未知不挡委派、不重启harness。重复tick不再调用Git；明确cwd/工作树元数据变化或显式刷新使缓存失效，复用已有提示，不新增每节点watcher、repo发现daemon/全盘扫描或内容hash。预算待B实测，不是硬实时保证（T-06-23、24）。

### Reader、coverage 与树

（consult 4 增补，F10）每次 reader 调用默认最多 4 MiB、2000 条、软时间 20 ms；所有重读、读后未处理的预取、签名及恢复读取都计入本 slice 和全 tick 的 I/O/时间预算。maxRecordBytes=1 MiB 按 LF 前全部字节计，包含 CRLF 的 CR；有 LF 的最大合法记录消费 1 MiB+1 字节，无 LF 的固定 EOF 完整 JSON 至多 1 MiB，还须预留本轮实际需要的签名检查等 I/O。时间包含 I/O 等待/调度、解码/解析/归并；完整记录 JSON.parse 不可抢占，超时记录实测，不承诺硬实时。有可用数据且字节/记录/时间预算均为正时，open/stat/read 等待已吃完软时间仍允许至少一次受字节/记录上限约束的有界消费步骤，保证前进；零预算不消费，实际超时如实计入软预算缺陷。

类型来自完整合法 JSON 的 type，不能依赖首键/行首正则。已知非公开类型（cc api-request-blob、thinking、reasoning、pi 图片等）不提取材料；超大记录安全跳过，不能识别其完整类型时记 oversize_unknown 与 gap，不猜作已知类型。

（consult 4 增补，F09）`ReaderCheckpoint` 至少含 `schemaVersion,readerVersion,ref,fileId{dev,inode},offset,sourceGeneration,parserState`。它是可序列化恢复元数据；未完成记录的原始字节只在单个 live reader 中至多 maxRecordBytes 的有界易失 transient buffer 存在，不能进入 checkpoint、ObservationCommit、summary、日志、临时 bundle、嵌套 binary/base64 payload 或持久 token/parser state，也不能改名放进 adapter extension。保留 checkpoint schemaVersion=1 的 pendingBytes 兼容字段时恒为 []，transient buffer 单独且不可序列化。普通未完成记录的持久 offset 留在最后完整记录边界（真实 UTF-8/CRLF 字节），恢复从原 source 重读；摘要、usage 去重、工具配对、事件钟/速率基线同样只反映该已完成边界。超大记录仅存 discarding 标志和可推进的丢弃游标，跨 slice/重启继续丢弃至换行、只计一次 oversize_unknown/gap，不保存正文、不每 tick 从行首重扫。EOF 不完整行仍 partial/incomplete_tail，不能因 pendingBytes=[] 误报 complete。

（consult 4 增补，F10）重启或易失缓冲丢失后，必须有机会在一个 slice 从最后提交边界重读一条最大合法记录。实际剩余字节不足时，共享 `ReaderResult.continuation?:{kind:'record_needs_larger_slice',minimumBytes:number}` 并返回 partial coverage；minimumBytes 覆盖本实现恢复实际需要的记录、界符及签名 I/O，不固定填 1 MiB，也不将软时间耗尽误报为字节不足。不静默增加预算、不提交半行、不忙循环；同一 live reader 可留易失缓冲，足量 slice 到来后继续推进。A4 helper、A6 facade/底层 RolloutParser、B8 共用此类型/语义；各层 offset（含导出 rollout.offset）、摘要/时钟必须是同一提交边界。

（consult 5 增补，G09）durable checkpoint 只保留正确解释下一段输入所需的显式、版本化 recovery DTO，不持久化整个显示/材料缓存或任意 RolloutParser/V8 对象图。单个热路径 inline recovery 按实际编码字节≤256 KiB，此资源上限不证明 tick<50ms。Codex 在 reader 生产端提取必要事实，禁止先 clone/serialize 全 cachedResult 再删 arguments；保留累计 usage、去重/配对、未结束 tool 的 ID/状态/时钟、pending、rate baseline、compaction/reset、链接核验元数据和完整记录边界。完整公开工具参数/代码/长输出不复制进 hot recovery，有界显示摘录截断必须保留截断/缺失语义；public snapshot/旧 --json v2 字段与口径不因优化删除，详情仍从原来源按既有有界读取/材料授权取，缺证不造空文本或零值。

（consult 5 增补，G09）必须精确保留且随历史增长的集合（包括 Claude usageMessageIds/factClockPages）放同 source 观测 SQLite 的增量恢复索引，按 ref/sourceGeneration/恢复版本隔离；本 slice 的必要 ID/时钟/配对元数据变更与发布边界同事务提交，不存 raw tail/全文。按 slice 所需键/有界页读取，恢复不先载入全历史；重启后的重复 message.id、晚到结果、重复事实保持原去重/时间语义。禁止丢旧 ID、截掉未闭合调用、近似集合改变 token 计数或把遗忘 pending 当 resolved。索引内容身份/边界进入 checkpoint 引用，不用可覆盖“最新 map”跨 commitSeq；本期不新增通用对象仓库、第二写者/后台 compactor。

（consult 5 增补，G09）默认新 recovery 是可验证的结构化元数据；仍支持的旧 V8 只走下文 G05 有界兼容/07 受控重建，不为任意未来对象图另堆镜像 validator。单条合法大记录必须完成必要提取并前进，增长精确集合由索引承接，不能无限“下次再试”。异常/不支持状态超限返回 checkpoint_state_oversize，保留前一完整提交并显式 gap，不得 offset 前进而丢语义；标准100MiB/合法大记录持续命中此错仍未满足本项，partial 不构成性能通过。

截断、inode/文件变化、compaction、分支切换各有明确的重置/续读原因，不用 mtime 作为唯一身份。sourceGeneration 是读取谱系，collect lease generation 是写入权；二者不能混用。

（consult 4 增补，F11）增量 reader 假定两个已观测 reset 之间 source 追加写入。inode/设备变化、缩短、已检测的非增长改写或已消费边界签名失配触发明确 reset/sourceGeneration 变化。有界首/末已消费记录签名只发现覆盖区域变化及部分常见替换，不证明任意历史内部未变；保持这些样本不变的内部改写没有检测保证。诊断保留 append_only_assumed_bounded_signatures 及其限制，coverage.complete 仅表示在此读取模型下覆盖本次固定输入边界，不因此永远 partial。reset 后旧 reader 锚点/摘要/易失缓冲不作新谱系当前证据，也不拼接新文件；01 的精确本轮绑定和独立身份条件仍成立，“未发现改写”不能授权 MCP。来源不再满足此模型时回到 unverified/明确缺口，不引入逐 tick 全前缀重哈希、Merkle 索引或后台校验器。

`Coverage={state:complete|partial|catching_up, skipped, gaps[], remainingBytes?, loaded, reason?}`：complete 仅指本次已知输入边界内所有应解析的公开记录已覆盖，不表示会话全部历史或不存在原生子；catching_up 表示预算尚未追到固定输入边界；partial 表示跳过/不可读/缺历史/分支不明，追上 EOF 也不能清掉已有 gap。skipped 分类型/超大/未知原因计数，排除私有块不保留正文。允许同时 catching_up 且有 gaps，不能靠一个枚举丢失缺口。

树采集每 tick 共用 8 MiB 文件 I/O、≤200 个节点、跨 harness 展开深度预算默认 4；各 reader 还受自己的预算约束。visited 以完整 SessionRef/JobRef 去重、防自环/祖先环；只用 adapter.children 提供原生拓扑和账本当前关系。预算外节点只保留限额内的身份/最后状态并置 loaded=false，不递归偷读；已知但未装载的数量/continuation 单列，不声称整棵大树已收全。历史 handed_over 关系不是第二父边，候选不进入确定树或已验证计数；解析权限与候选范围引用 01。

（consult 4 增补，F10）B16/B10 调度使用共享总 deadline 和 8 MiB I/O，不把各 reader 20 ms 逐节点相加。可在同一 live reader 保留 transient；本 tick 剩余不足时在下一公平轮次安排足够的一条记录 slice，并从共享预算扣除，不能每 tick 重建 reader 或一直给小碎片使合法大记录永久饥饿。剩余时间不足正常让出/续读，完整解析的不可抢占超时仍计量为软预算缺陷，不承诺硬实时。

（consult 5 增补，G11）continuation 区分真实恢复字节不足的 record_needs_larger_slice/minimumBytes 与分批恢复索引/prepare 进度的 recovery_catching_up；后者提供明确 coverage，不冒用 minimumBytes。需要让出时停在可恢复完整记录边界，checkpoint/summary/continuity/notices 同进退；共享总 deadline/8MiB、公平续读保留，不能每次重新处理同一巨大对象而永久无前进。

显示节点身份为 `DisplayNodeIdentity = {kind:'session',ref:SessionRef} | {kind:'delegationIntent',linkId:string} | {kind:'job',ref:JobRef}`（job留C）。未绑定的已登记委派用稳定linkId显示键并关联currentRun，不伪造sessionId/source，不按label/cwd合并，不计入已确认session数；这不是新的授权身份或第三类账本运行。首次绑定由B9以真实ref合并，保留原选择键到新ref的映射、单父边与去重。intent仅从ledger link/run事件派生，不为其伪造collect:<SessionRef>租约（T-06-25）。

### B16 的五维输入与消费者字段

MVP 的 ObservationEvidence 区分具有 ref 的 session 证据与 `origin:'ledger'`、具有 nodeIdentity 的 delegationIntent 证据；StateContinuity 按 nodeIdentity 判别。session 使用完整 SessionRef 和真实 sourceGeneration；无受管 run 时 runId/bindingGeneration 可缺省。delegationIntent 使用 `{kind:'delegationIntent',linkId}` 和当前运行标识（ObservationEvidence.currentRunId、StateContinuity.runId）；不得包含 ref/sourceGeneration，不建立 collect 租约或伪 ObservationCommit。这两个运行字段必须对应本次 ledger 快照的 currentRun，绑定代次如携带则取该 run 的真实值。

origin为registry/transcript/supervisor/report/job，intent为ledger；validity区分current/stale/unknown/conflict。保留eventAt/observedAt/lastSuccessfulReadAt及seq/evidenceId/reason；registry仍提供server/occupant/completion_seq/来源时钟，进程存在只证明存在。

| 维度 | 输入值与所需证据（最终归并归 B16） |
|---|---|
| activity | working / waiting_input / idle / exited / unknown；匹配且新鲜的 registry 交互事实、transcript turn/tool 边界、受管进程事实；打开工具调用的开始/最后活动时刻，防历史未闭合调用无限推 running |
| pendingReason | none / approval / question / needs_human；公开审批/问题的打开与解决 ID/时间，registry blocked，Jev NEEDS_HUMAN；缺记录不能伪造 resolved |
| lastTurnOutcome | none / completed / failed / interrupted；明确 turn 结束事件、固定 run 的报告、04 有来源的退出结果；缺原生退出码保持 null，不从 shellStatus 推任务结果 |
| liveness | alive / gone / unknown；04 心跳/ScopeCheck、匹配进程实例或 registry 可见性；跨 PID 域、读失败/缺心跳分别保留原因，不自行释放运行槽 |
| freshness | `{state:fresh\|stale\|unknown,...来源明细}`；每来源lastEvidenceAt/observedAt/lastSuccessfulReadAt/error/deadline/clockAnomaly，匹配04心跳边界与registry缓存；陈旧来源保留lastKnownActivity，重复读取不伪造新活动 |

B16 使用概念 §6.8 的来源职责：当前交互优先采用匹配且新鲜的 registry，明确失败不能被它覆盖；unknown 可回有效文件证据。冲突组合与最终 projection/notice 真值表只有本文件附录槽的 B16 一份，B6/B10 不另判。

B16明确列出每维所选来源及总体freshness所需的来源集合；被有效fallback替代的旧来源不冒充当前来源。所需来源缺失/身份不匹配/时钟不可判时总体state=unknown；否则任一所需来源越过其有效截止为stale，均有效为fresh。缺来源不是fresh；消费者只比较`freshness.state`，不拿明细对象与stale比较。截止由nowMs参与纯投影计算，即使无DB变化也可变化，不触发读路径写入。

唯一语义分类与设计§3.3的优先关系对齐：冲突 > uncertain（区分supervisor_dead等原因）> 待决/blocked > 失败（含launch_failed）> interrupted/cancelling/cancelled > stale/缺证 > working > starting/未确认意图 > 退出/报告 > idle > unknown。这是B16语义与原因选择，视觉映射归前端；不另在A4/B6/B10维护分类。`run.state=failed`依据02是non_execution，输出`launch_failed`及采用的原因，不借lastTurnOutcome=failed伪造一轮模型执行。共享谓词`isRunTerminal(run) = run.state ∈ {ended,failed,cancelled}`只表示运行终态；投影字段`isRunTerminal:boolean|null`在无受管run时为null，不猜原生会话终态；completed/failed报告、图标或cancelling不构成运行终态。原生session与未来job的历史资格各按相应事实，不能套用图标判定（T-06-26）。

消费者 `ObservationView` 提供DisplayNodeIdentity、`statusProjection{activity,pendingReason,lastTurnOutcome,liveness,freshness,stateKey,stateSince,stateSinceBasis,isRunTerminal,asOfSeq,observationStamp,asOf,observedAt,lastEvidenceAt,lastKnownActivity?}`、`conflict{count,recordIds[],since}|null`、各Metric、WorkspaceContext、Coverage、loaded、depth、evidenceStamp。asOf为所采纳事实边界，observedAt为观察时间；所有新时间为毫秒epoch。conflict显式来自已记录矛盾及证据，不能以unknown代替；06不裁定谁赢。

`asOfSeq:number|null`仅为本次ledger快照events高水位，无ledger为null、已打开空ledger才为0。`observationStamp={seqDomain,commitSeq,inputLedgerSeq,ref,runId?,bindingGeneration?,sourceGeneration}`为实际采用的观测输入/发布戳（纯原生inputLedgerSeq可null；intent无观测commit时stamp=null）。不把当前ledger高水位贴到旧摘要。组合前核对ref/当前run/绑定及来源代次，旧轮/不相容代次的当前观测unavailable/stale并给原因，旧摘要只作历史；不能挪用旧报告/stateSince/cwd。只因无关run增长ledgerSeq不失效全部摘要。ledger与观测各自一致，没有跨库原子承诺/协调器；即时组合也只用同一纯B16，保留两套输入戳，连续性不足给unknown且不在status/wait中采集/Git/reconcile或发布摘要。ledger events.seq、观测commitSeq、NoticeEvent.seqDomain内seq不跨域比较（T-06-29）。

状态持续时间唯一类型为 `stateKey:string,stateSince:number|null,stateSinceBasis:'event'|'observed'|'unknown'`。stateKey包含所选语义及必要原因（approval/question/supervisor_dead/launch_failed等），不含图标/颜色/翻译/宽度/排序桶。stateSince为当前语义状态连续区间起点：新run、已证实的新episode或所选语义改变才重置；报告重读/心跳/usage增长/折叠/语言变化/父因子孙改变排序桶均不重置。同图标的新approval/失败episode不沿用旧时间。

StateContinuity 是按 nodeIdentity 判别的联合：

```ts
type StateContinuity = {
  ruleVersion: string; episodeAnchor: string | null; stateKey: string;
  stateSince: number | null; stateSinceBasis: 'event' | 'observed' | 'unknown';
  bindingGeneration?: number;
} & (
  | { nodeIdentity: {kind:'session'; ref:SessionRef}; sourceGeneration:number; runId?:string }
  | { nodeIdentity: {kind:'delegationIntent'; linkId:string}; runId:string; ref?:never; sourceGeneration?:never }
);
```

StateContinuity 的公共字段仍为 ruleVersion、episodeAnchor、stateKey、stateSince、stateSinceBasis；sourceGeneration 仅在 session 分支必填。intent 用 linkId、runId、规则版本和 ledger 事件锚点判断连续区间。ledger 的 asOfSeq 用于快照一致性，不冒充 sourceGeneration，也不因无关事件增长而重置区间。

intent 首次绑定为 session 时，选择键合并本身不证明连续性。只有 link→真实 ref、同一 run 和同一 episode 的证据齐备，才可采用原 ledger 进入事件的时间；session 记录随后携带自己的真实 sourceGeneration。不能复制一个虚构代次或仅因 stateKey 相同延续时间。证据不足按既有 observed/unknown 规则处理。Job 连续性留 C 阶段，不由本条推定其拥有 SessionRef 采集租约。

可定位进入事件且连续性可证用事件时间/event；只有首次看到状态的证据用首次观测时间/observed；时间或连续性不可知为null/unknown。时间截止stale用来源的确定截止边界（04心跳严格>30000ms，等于仍fresh），不取paint时刻。uncertain/stale时钟的证据年龄仍用lastEvidenceAt/heartbeat，不能用stateSince代替；时钟倒退标clockAnomaly，不刷新时间掩盖。

重启读取已提交连续性记录，能有界续读的源从checkpoint接续。同证据/同commit的两个消费者得到同结果；停采可能漏registry瞬变、sourceGeneration/规则版本变化或历史缺口时，先以可证明事件重建，否则新observed起点或unknown，不假装一直连续。未绑定intent的pending/claimed/run状态直接用相应link/run事件起点，首次绑定若能证明同区间可沿用。恢复已知时间不承诺恢复从未观测到的事件；首次基线不补虚假完成通知（T-06-27、28）。

关系相关字段由 [03「报告与 status」](./03-lifecycle.md#报告与-status)及[「status 与 HUD 可读投影」](./03-lifecycle.md#status-与-hud-可读投影)供应：link、runHandshake、currentRun/isCurrent、latestReportForRun/按轮历史、parent.offline/orphan_policy、reconciliation与ActionDescriptor、带主体的resumable+reason；host/occupant由05/04供应。06引用它们时保留实际inputLedgerSeq/实体代次与缺失原因，不因link.state猜本轮绑定或自实现resume门禁。候选只保存有界种类/时间/指纹，字段不足unavailable，不读候选正文补齐。未来C阶段Job租约的`holderLabel?:string`由C4从真实lease owner/job在同一读取投影派生，C5消费；无可公开匹配显示名则省略。它不参与身份/互斥/generation/释放，改名只更新投影，不提前造browser表/正向MVP样例（T-06-30）。

`NoticeEvent={seq,seqDomain,created_at,ref,runId?,kind,inputStamp,sourceEventSeq?}`：B16 根据 pendingReason 从 none 进入待决、明确 failed、新报告、进入 uncertain 生成边沿；按 inputStamp/report_id 去重，初次读取不是重复完成。ledger 事实保留 sourceEventSeq；派生通知随观测一致提交获得该观测域递增 seq（域含 source/视角），不伪造 ledger events.seq，不跨域比较游标。created_at 是事件时刻或注明的首次观测时刻；切 tab/重绘不生成通知。parent.offline 消费 04 的持久事件，不由一次 registry 超时编造。

### checkpoint 一致提交与 collect lease

`CollectLease={resource:collect:<SessionRef>,holder,generation,expires_at}` 存在 `$HUD_HOME/sources/<sourceId>/` 的观测存储，绝不放入 ledger leases。generation 持久单调，释放保留下界，不删除后从 1 重来。它只授权采集 checkpoint/summary/notice 写入，不授权启动/终结 run 或释放槽；三类资源的另外两类引用 I-02-10。

ObservationCommit与collect lease只针对真实session及真实sourceGeneration；intent从本次ledger currentRun及事件投影，不建立伪commit/租约。Job连续性留C，不据此推定SessionRef采集租约。

逻辑提交 `ObservationCommit={ref,sourceGeneration,leaseGeneration,seqDomain,commitSeq,observationStamp,checkpoint,summary,continuity,notices}`；stamp中的ref/sourceGeneration/commitSeq必须与本commit一致，inputLedgerSeq/runId/bindingGeneration为实际使用的输入。checkpoint offset/parserState、summary（含stateKey/stateSince/stateSinceBasis）、StateContinuity及notice同时可见。B12负责持久发布、B16负责唯一边沿逻辑，共用本提交，不各造存储。可采用独立观测SQLite短事务，或不可变bundle+一个原子发布指针；两次rename不能冒充原子。保留概念路径时checkpoint/summary解析同一commitSeq/bundle，不各取最新。布局/点击状态另在instances/。

（consult 5 增补，G05）B12/B16 共用 `src/core/checkpoint.ts` 的 ObservationBoundary、ObservationBoundaryWitness、ObservationCandidate、checkpointBoundary/witnessObservationBoundary，不在 B16 复制接口或另建 merger。B16 在同一个 ReaderResult 捕获完整记录边界，再运行唯一归并并绑定输出；witness 是受信采集器关于来源一致性的断言/防错摘要，不是来源真实性签名，也不授发布/执行权限。核对 ref、readerVersion、sourceGeneration、fileId、offset、checkpoint/summary 摘要、commitSeq、continuity、notices 和实际 observationStamp；禁止给旧 summary 事后贴新 checkpoint offset，intent 无伪 SessionRef/collect commit。发布处理脱离调用者可变输入的快照，不能验证后再序列化被修改的对象。

（consult 5 增补，G05）对仍支持的 Codex V8 格式保留版本/runtime/结构白名单、空 raw tail、边界一致、exact EOF、解码值校验，仅重序列化已验证值；重编码字节不必等于输入。重复 Map key 隐藏旧字节、尾随数据/未知结构不能作为合法持久状态保留；未来格式不能只因可 deserialize 即通过。每个新内容进入存储前完整验证；同一已验证不可变内容可复用，缓存键含可信内容身份、reader/runtime/格式与边界，不只 offset/mtime。

（consult 5 增补，G10）本期选定同 source 观测 SQLite：不可变 checkpoint 内容、同库增量恢复索引和 current projection 引用构成一个逻辑 ObservationCommit，由同一 fenced 事务原子发布；上文 bundle 仅为早期方案说明，不另做第二存储后端。checkpoint 不变的 summary 边沿只换小投影，新内容写盘/校验仍记本 tick；旧 blob 仅按现有受控发布/重建路径与事务快照回收，不加后台 GC，不删除仍被当前提交引用的内容。内部共享职责分开如下：

| 入口 | 保证 |
|---|---|
| prepareCheckpoint | 完整校验新 compact checkpoint/恢复引用的边界、结构、内容；产生不可由外部随意构造的 PreparedCheckpoint，绑定 ref、readerVersion/格式、sourceGeneration、fileId、offset、内容身份（consult 5 增补，G10） |
| publishPrepared | 接同 ReaderResult 边界的 prepared checkpoint 和 B16 summary/continuity/notices；每次发布仍重验实际 lease 与 previousCommitSeq，已验证内容不缓存写权限（consult 5 增补，G10） |
| readProjection | 同一已提交快照返回 summary、continuity、notices、observationStamp、commitSeq 及 checkpoint 内容身份/边界；不读/解码 recovery 正文、不运行 reader（consult 5 增补，G10） |
| readRecovery | 仅采集器恢复时取同一提交对应的 checkpoint/恢复引用并有界恢复；可保留完整兼容 readCurrent，但 status/wait/paint 常规读取不使用它（consult 5 增补，G10） |

（consult 5 增补，G10）内容身份由可信 prepare 对已验证值产生，不信调用者自报 hash、相同 offset、可变对象地址/mtime。no-op 不重建大 checkpoint、不 hash 全历史/重复 deserialize 同 blob；freshness deadline、源谱系、规则版本/真实状态边沿不能被误判 no-op。projection 保留原 observationStamp，不能贴新 ledger high-water；G05 witness 使用已验证 checkpoint 内容身份和 captured boundary，不为每次摘要变更扫描相同 payload。未知/损坏/版本失配仍拒绝恢复，投影读取不授不安全 checkpoint 恢复能力。B12R 交接口/DTO，B16/B6/B10 消费，不把 raw recovery 暴露给 HUD/export。

（consult 4 增补，F09）B12 发布入口拒绝含 raw tail 或提交边界不一致的 checkpoint；不能只在序列化前清 pendingBytes 而保留已跨尾行的 offset。checkpoint/summary/continuity/notices 保持同一完整记录边界，预取/易失状态不进入 bundle/V8 payload。修改 durable 语义必须递增 readerVersion，旧 raw-tail 缓存不能直接续用或只删字节仍保留旧 offset；由 collect lease 围栏按 07 受控 source 缓存失效/重建、重置连续性，并删除/替换含 raw tail 的旧缓存及未发布 bundle，不留永久原件，不改 ledger schema/user_version。

仅状态边沿或原有内容变化才提交，持collect lease的采集器仍是唯一观测写者；年龄以nowMs计算，重绘/status/wait零观测或ledger写入。不能每次读全量events找stateSince或每tick写年龄；读路径跨截止可纯重投影，需持久的新边沿由已有采集器在相同ObservationCommit发布。

接管与发布必须共用同一原子 CAS/互斥边界：写入时同时重验 holder/generation/有效期、ref/sourceGeneration 与前一 commitSeq，再发布。文件方案的「查 lease → 放锁 → rename」不合格，旧持有者不得覆盖新指针；SQLite 方案也不能在事务外做一次 lease 检查后盲写。准备文件/解析在边界之外，提交内只校验与发布必要元数据；同一边界串行化接管。目录 0700/文件 0600，临时文件完整写/fsync 后再发布，必要目录 fsync；崩溃留下的未发布 bundle 不被读取。

（consult 5 增补，G06）CollectLease 可序列化字段仅描述已提交租约，不是可转交写权。只有成功 acquire(g+1) 的同一 ObservationStore 实例具有该代 renew/release/publish 权限；readLease、重开 store、相同 holder 或恢复进程不继承。每次写入仍在接管同一事务核对持久 holder/generation/有效期、来源谱系与 previousCommitSeq。默认 TTL=15s，renew 不密于5s，generation 下界、实例 sampled high-water 与持久 last_now 保留；无内容变化不为时钟逐tick写盘。

## 不变量

| 编号 | 断言 | 测试 |
|---|---|---|
| I-06-1 | Metric 的 source/asOf/quality 可解释；未知不作零、重读不续活动时间，观测时间与事件时间分开 | T-06-1、2、21 |
| I-06-2 | reader 字节/记录/时间/单条上限和恢复状态有效；持久 raw tail 禁止、offset/摘要/时钟同完整记录边界，易失缓冲有界，丢弃游标跨重启前进（consult 4 增补，F09）；最大合法记录重读含 LF/CR/签名实际成本，不足给类型化 continuation/partial、公平续读且不隐增预算（consult 4 增补，F10）；append-only-between-observed-resets 与有限签名保证公开，reset 失效旧谱系，不声称全历史未改，超预算/跳过不伪造完整 coverage（consult 4 增补，F11）；（consult 5 增补，G09）显式 compact recovery DTO、inline编码≤256KiB；增长精确集合进同库隔离索引，不截断必要状态，异常oversize保前完整提交/gap且合法大记录仍须前进；（consult 5 增补，G11）recovery_catching_up 明确coverage并区别真实字节不足 continuation，完整记录边界同进退、公平总deadline/8MiB无永久重做 | T-06-3、4 |
| I-06-3 | 树≤200节点、去重无环、I/O有界；未加载/候选/历史边不变成新的确定节点事实 | T-06-5 |
| I-06-4 | 五维输入、显式冲突、notice 原始边沿/seq 与时间可提供；只消费 B16 唯一归并，关系门禁引用 03 | T-06-6、7 |
| I-06-5 | checkpoint/parserState/summary/continuity/notices 同一 commit 与完整记录边界；B12 拒 raw tail（含隐藏编码/payload）及边界错配，旧缓存按 07 受控重建/清除原始尾字节；消费者只读完整已发布版本，绝不新旧混配（consult 4 增补，F09）；（consult 5 增补，G05）共用 checkpoint.ts boundary/witness/candidate，可信一致性断言不授权；脱离可变输入快照、版本/runtime/结构/exact EOF及解码值验证，已验证不可变内容可复用；（consult 5 增补，G09）必要恢复元数据/增长集合引用与本slice索引变更同边界事务，不复制显示缓存/全文参数；旧V8有界兼容或受控重建；（consult 5 增补，G10）prepareCheckpoint/publishPrepared/readProjection/readRecovery 分责；同库不可变内容/current投影原子引用，一个逻辑提交，非两次独立发布 | T-06-8 |
| I-06-6 | collect 可过期换代，接管与发布同一围栏，旧代迟写/续约/释放全部拒绝；它不写 ledger；（consult 5 增补，G06）写权仅同store实例成功acquire(g+1)；重开/readLease/同holder不继承，每写重验持久租约/谱系/previousCommitSeq；采样时钟限制及只读失效明确，不逐tick写钟 | T-06-9、10 |
| I-06-7 | 热路径、进程、逻辑写入、CPU 与冷启动逐预算测量；不把 accepted 延迟当启动延迟 | T-06-11–16 |
| I-06-8 | 通知是 hint、游标是事实；有界复读、心跳提示合并、不新增服务；status 只读 | T-06-17、18 |
| I-06-9 | HUD 用廉价变更信号与已提交摘要；statusline 数据入口≤20ms，stdin 优先、失败可退现有摘要/缺失；（consult 5 增补，G10）status/wait/paint/statusline常规读readProjection不解码recovery，readRecovery仅采集恢复，兼容readCurrent不进热路径；（consult 5 增补，G11）≤20ms是实际statusline完整廉价入口含打开/校验/读取成本，重复验证/恢复不改称cold | T-06-19、20 |
| I-06-10 | spent.tokens/costUsd各自Metric，成本未知null、有效零保留；完整ref去重合计带缺失/coverage/quality，估计不作严格下界 | T-06-22 |
| I-06-11 | WorkspaceContext位置/显示名/本地repoId/declared来源分离，Git≤2子进程/200ms软预算且不入热路径/事务，逐run启动历史不改写；SessionEvidence.cwdSource 仅 session_meta/transcript/unknown，合格 Claude transcript 不伪称 session_meta，诊断细节不另成权威，位置来源不授身份/触发 Git，不能以 callers.cwd 补未知会话 cwd（consult 4 增补，F02） | T-06-23、24 |
| I-06-12 | session使用完整ref与真实sourceGeneration；ledger intent必有nodeIdentity/currentRunId，StateContinuity.runId必有且对应本快照currentRun，禁止ref/sourceGeneration/collect租约或伪ObservationCommit；绑定不凭选择键制造连续性；其余freshness/终态语义统一 | T-06-25、26 |
| I-06-13 | stateSince是语义episode连续起点；session按真实读取谱系，intent按linkId/current run/规则/ledger事件锚点，asOfSeq增长不冒代次；同link换run重置，绑定须有link→ref/同run/同episode证据，缺证observed/unknown；session连续性随ObservationCommit发布，零逐tick写 | T-06-27、28 |
| I-06-14 | ledger与观测分域加戳，组合重验实体/代次；旧run摘要不混当前，无跨库原子或读路径写入；（consult 5 增补，G10）projection保原stamp且与recovery指同commit，summary-only只换小投影；内容身份不授写权，publish每次重验lease/CAS | T-06-29 |
| I-06-15 | C4 holderLabel只派生读取，不参与所有权/释放，不扩MVP schema/正向能力 | T-06-30 |

## 状态机

### 采集与租约

`free/expired → held(g+1)` 在原子边界取得租约；`held(g) → held(g)` 只有当前 holder 可在有效期内续约。过期后的任何 writer 必须重新竞争，不按「我还活着」续写。接管后旧 writer 变 fenced，只能读新摘要；释放只能 CAS 自己的 holder/generation，保留下界。时钟倒退/域不明时返回 lease_time_unknown、先只读，不猜过期接管。

`read committed → read bounded delta → prepare → fenced publish → committed`：预算耗尽也可发布带 catching_up 的一致进度；publish 失败丢弃未发布结果，重读当前 commit 后再决定。崩溃在发布前只有旧 commit，发布后只有完整新 commit；不存在消费者可见的半新进度。失去租约、解析出错与旧文件代次都不能借更新 observedAt 让旧数据显得新鲜。采集租约的续约单独计量，可与内容提交合并；无内容改变不重写 checkpoint/summary，续约不得比每 5 s 更密。

（consult 5 增补，G06）B16 一个 writer 生命周期持有同一 store/lease，正常先 release 再 close；崩溃重开重新竞争，不按同 holder 续旧代。读者不隐式 acquire；observation_busy 留旧完整摘要或下一正常采集机会再试。当前 sampled high-water/last_now 只防旧代覆盖及已观测时钟倒退，不承诺跳钟后真实15s内接管或跨重启单调时间。倒退/不可判先只读，可能延长停采，UTC 回到可判范围或正常释放/过期后才 acquire；不新增持久 monotonic/boot-domain fence、时钟服务或逐tick高水位写盘，不据此释放运行槽。

### 变更信号、wait 与恢复唤醒

长寿命 HUD/账本只读连接先比较同一连接上的 PRAGMA data_version（或等价已提交 bump/commitSeq），不变就复用查询结果；值只可在同一连接跨次比较，不能拿新 statusline 进程的值与上一个进程比较。连接重开使本地缓存失效；自己的提交须直接使本地缓存失效。data_version 是粗粒度失效提示，不是事件游标；heartbeat 改 WAL 也会使它变化，必须进一步比较相关 events high-water/摘要 stamp，不能每次重建全树。年龄/stale 截止即使无数据变化仍由 nowMs 重算；不重查正文。

已有 hud-mcp 进程中的相关 commit 可按 runId 提示 waiter；跨进程文件/WAL 通知只作提示，不可靠也不增加通知 daemon。wait 先读、登记提示后再有界复读以关掉丢通知窗口；相关提交/心跳失联截止/返回 deadline 再读同一固定 run 的索引页，规则引用 03。漏提示最多延后到有效 wait 截止复读，nextSeq 不越过未返回事件。重复提示合并；粗粒度文件提示在每个现有进程按 HUD_HOME 合并，heartbeat-only 提示的 high-water 检查最多一次/5s，没有新相关事件时不逐 waiter 读取状态/扫进程；已知 run 的真实提交通知可直接唤醒。合并窗口不是另起周期轮询。

恢复由现有 hud-mcp 启动/重连、相关 run 事件、必要心跳截止、显式 reconcile 触发有预算的单次工作：先导入匹配遗留 receipt，无 receipt 时按 02 同一表取证。超预算保留 continuation/uncertain，下一相关触发续做，不后台按秒重扫全部 run。heartbeat 本身不是对账事件；status 不触发写入；没有活写者时 HUD 诚实保留 stale/uncertain。观察不能取得新执行票据。

### statusline 廉价数据入口

`readStatuslineSummary(ref,{budgetMs:20,maxChildren:50})` 首选同 source/ref 的已提交通用摘要（年龄≤5s），否则至多一次按 parent_ref 索引的 ≤50 个直接子项查询，不构建全树、不扫 transcript/进程/宿主 CLI、不调模型。返回树计数及直接子项已有的投影字段/seq/coverage；limit 截断显式 partial，不能把 50 条当完整总数。预算包含打开/校验/读取/解码/查询，数据入口墙钟≤20ms；同步底层偶发超时是预算缺陷，记录并降为 unavailable，不把“有deadline”当已能硬抢占的保证。冷进程启动/最终绘制另计，见预算表。

（consult 5 增补，G10）已提交摘要命中走 readProjection 的廉价入口，checkpoint 身份/边界可读而 recovery 正文不读/解码；常规 status/wait/paint 同样只取此投影。readRecovery 只在采集恢复使用，与 projection 对齐同一提交；reader/恢复工作不能藏在普通读路径。

stdin 的 session/model/context/cost 永远优先，摘要不覆盖它。廉价摘要/索引均不可用时返回 unavailable；如 D3 在剩余总预算内需要本地 session 的增量补充，复用同一预算 reader/collect lease，竞争失败只读已有摘要，冷追赶 partial，不阻塞输出。不得为了委派数据启动第二套 parser 或常驻采集服务。

### 性能预算与测量协议（G13；Oracle §2）

| 编号 | 验收预算 | 测量边界 |
|---|---|---|
| P-06-1 | H 个实际加载 harness → H 个 MCP；R 个活跃 run → R 个 hud-run；shell 档案的必要启动 shell 另计；默认零独立 reconciler/sidecar/通知服务 | 记录进程树、每类数量/RSS；必要 scope helper 单列理由/数量/寿命/RSS，随 run 收尾退出。终态或只剩无控制能力的 uncertain 历史不养 observer；（consult 5 增补，G02）正式 B45 启动链+真实 B2 分测 H/R=1/1、2/10；supervisor/helper/必要shell/MCP分列数量、稳态/峰值RSS、寿命/回收，可得PSS/私有驻留并报；逐进程RSS之和不称唯一物理内存，无新RSS硬阈值 |
| P-06-2 | 5s 心跳仅一次 runs CAS UPDATE；稳态协议心跳速率 R/5 logical UPDATE/s，R=10 时2次/s | 单列启动/终结事件写、collect lease/内容写、日志字节、SQLite WAL/实际磁盘 I/O。心跳不各写 event/evidence/meta/exit；正常 status/wait 零写，不更新 last_seen；（consult 5 增补，G02）空闲完整300s且≥60心跳边界，核对真实B2 WAL/磁盘写入、逻辑心跳/额外事件，不以60s/file-fake代验 |
| P-06-3 | 空闲阻塞；正常存活期零 100/200ms /proc 全扫/扫组循环；仅启动期有截止采样、退出/取消/恢复事件做必要检查 | trace 记录检查次数与触发原因。空闲 hud-run+其 helper 的 user+sys CPU，默认验收解释「≈0」为每 run 平均<1%单核；采样300s（≥60心跳），不含 harness/模型工作，另报总系统增量；超标是缺陷；（consult 5 增补，G02）同测每run与R=10总user+sys CPU、真实I/O及额外事件；替换前后同环境对照，原型sh约2MiB不当生产实测 |
| P-06-4 | 非 wait MCP 内部 p95 <50ms不变；仅显式 `claude_pre_tool_use_v1` 档案另验同次调用联合 p95 <150ms。status/spawn/resume/cancel/whoami/report逐工具、成功/拒绝/busy分别验收（F08 Pro 裁决增补） | MCP内部从完整 tools/call 到响应序列化/flush，含验证/摘要准备、DB等待/commit；联合从必需hook最外层冷进程启动至同次响应flush，含缓存首用、取证发布、harness调度间隙、完整授权、DB等待/commit及序列化，不能把前置工作移出成本。spawn/resume返回durable accepted+starting，cancel返回durable取消意图，不等TUI ready/绑定/12s序列。计时误差取保守上界，不相加独立分位数或仅靠快拒绝达标；wait沿用原等待预算、前置成本单列（F08 Pro 裁决增补） |
| P-06-5 | B5授权与事务总墙钟≤30ms（含DB等待及commit）；单次busy_timeout≤10ms，所有等锁/重试/退避累计≤20ms，20ms包含在30ms内，并受MCP内部与联合预算剩余时间约束（F08 Pro 裁决增补） | BEGIN IMMEDIATE内无文件读取/摘要计算/宿主CLI/进程发现/网络等外部I/O，事务内重验捕获的context/版本/槽前提。预算耗尽且未提交才返回busy/未接受；已提交不得报未接受，响应未知按02原幂等结果恢复、不再提交外部动作。同步commit超时记预算缺陷，不声称可硬抢占；长锁压测单列busy数/尾延迟（F08 Pro 裁决增补） |
| P-06-6 | MCP 冷启动<200ms | 从创建新 MCP 进程到可正确回答 initialize，包含 Node/模块加载/必要存储打开；不加载整个 HUD/reader/Herdr 模块图。tools/list/首次工具延迟另测，不能以延迟初始化隐藏成本 |
| P-06-7 | HUD 增量 tick<50ms；reader 软20ms，树≤200/8MiB | 从增量 collect 入口到一致摘要发布及本次数据组装/渲染/paint enqueue 结束，含 I/O 等待/调度；两入口分别测。所有重读/预取/签名/恢复 I/O 都扣本 slice/全 tick；最大合法 1 MiB 记录含 LF 为 1 MiB+1 字节（含 CR），另计实际签名成本，不足返回 record_needs_larger_slice/minimumBytes/partial。B16/B10 共用总 deadline、公平安排足量恢复 slice，不相加各 reader 20ms。冷追赶单列，不把等待下一 tick 的空闲算进去或把慢增量移成「冷」（consult 4 增补，F10）；（consult 5 增补，G11）仍为声明样本逐个<50ms上限，非p95；含reader提取、checkpoint prepare/witness、序列化/hash、索引读写、SQLite等待/commit、调度及paint enqueue，cold/warm分报，同步不可抢占超时照记缺陷；仅真实恢复字节不足用minimumBytes，分批恢复/prepare用recovery_catching_up及coverage |
| P-06-8 | statusline 廉价数据入口≤20ms；完整 statusline p95≤150ms | 前者按上节独立测（含摘要命中/索引 fallback/缺失）；后者包含冷进程、stdin、采集竞争及输出，D3/D4 验收，故障/空输出按概念 §9.3 门禁，本文不决定视觉；（consult 5 增补，G11）readProjection在实际statusline入口测完整≤20ms，非仅SQL；B6非wait观测响应仍按P-06-4完整口径 |
| P-06-9 | accepted→started/bound/ready 分开测，不以<50ms承诺完成启动 | 保存 accepted（意图commit）、dispatch、真实 harness started、bound、host-ready 时刻及超时/未达到数；按相同 run 对齐，nullable 时刻明确缺失，不能只统计成功者；（consult 5 增补，G02）正式链启动分布含helper启动/IPC，不剔除未达到数，accepted/dispatch/真实started/bound/ready逐run对齐并做替换前后同环境对照 |

最低可重跑基准：记录 CPU型号/vCPU与quota、内存、磁盘/文件系统（本地/跨挂载）、OS/kernel/WSL、Node/SQLite/harness/host版本、HUD revision/profile、样本/原始计时、并发与数据量。没有这些信息的数字不能作验收证据。

（F08 Pro 裁决增补）显式Claude hook档案的原始证据须绑定具体Claude版本、helper实现修订、完整非秘密profile指纹及同次调用关联键。联合与MCP内部计时来自同一次调用，不用hook p95+MCP p95推联合p95。用单调钟并记录计时误差/跨进程时钟关联；无法直接覆盖最外层冷启动或响应flush的采样须用可解释的保守上界，不能用写记录至handler的领先量、hook热启动、not_implemented或skeleton快拒绝代替完整授权/真事务。缓存首用纳入，不借预热删除该成本；delegate_wait保留03/05的等待预算，前置成本与实际等待/响应分别报告，不套用非wait的150/50ms门槛。

使用临时 HUD_HOME/source、固定合成100MiB历史；增量分0/1/2000条、含≤1MiB单条、200节点/深度4、多消费者 panel+statusline（D再加watch）。MCP 按 H/R=1/1、2/10 并发运行，含心跳交错/锁竞争；相同数据跑有/无Herdr。非wait每工具每组合预热50次后≥1000次，成功/拒绝/busy分别报n及p50/p95/p99/max并逐项验收P-06-4/5，显式Claude hook档案联合与MCP内部同测、不能混合结果掩盖慢成功；空闲CPU/写入≥300s，排除起止事件后核对60个心跳边界，日志吞吐另外测。（F08 Pro 裁决增补）

（F08 Pro 裁决增补）B14最终档案另收≥200次真实联合调用，跨≥10次harness启动、每个声明路径≥20次，逐工具/成功/拒绝/busy分报n及p50/p95/p99/max；合成数据不混入真实样本，缺格不授verified。B4真实Claude发起spawn/resume须durable accepted、保留既有hooks/配置、精确claim/HUD_HOME、零重复提交并同验150/50ms；B5按01保留F06/F07全部反例与30/10/20ms分项计时，子调用零根授权、旧来源零新提交、claim零重复消费、合法新根仍可用。仅七个HUD工具匹配、按次冷启动、有界读写、无新增常驻服务/轮询的G13要求保留；hook进程数/写入量单列，不改P-06-1/3/9。

冷启动每形态≥100个新进程，说明 OS页缓存冷热；增量每组合≥1000 tick，statusline 每入口≥1000次。冷启动/增量tick的<200/<50按所声明工作负载的逐样本上限检查，另报p50/p95/p99/max与超预算次数；不得只报平均或删异常值。started/bound/ready 用≥30个合成进程启动样本统计同样分位和缺失数，真实 harness 逐能力格样本量另报；未有样本标未测。B先做最小基准，D4扩展到超大行/无换行/重写/宽树/多消费者；任何 helper/包装链变化只重验受影响预算与TTY/context行。以上不是本批硬件实测结果。

（consult 5 增补，G02）B14 资源/启动验收必须走正式 B45 和真实 B2，H/R=1/1、2/10 的300s/≥60心跳数据与替换前后同环境对照；分列进程数量/寿命/回收、稳态/峰值 RSS、可得 PSS/私有驻留、每run及R=10总CPU、真实WAL/磁盘I/O与逻辑心跳/额外事件，不把RSS相加称唯一物理内存，不虚构RSS硬上限。定向重验 exit137/SIGKILL、leader退/成员活、helper死亡/EOF、INT/TERM/KILL、fork/退组/复用、提交后scope固定前崩溃、父MCP与supervisor死亡；可见另验真实TTY/context/环境，不重跑无关身份/导出矩阵。

（consult 5 增补，G11）B14 对0/1/2000增量、100MiB历史、≤1MiB合法记录、十个大公开参数、长期重复ID/大量精确时钟、多消费者、200节点、真实心跳/锁竞争分别留原始样本；每组合≥1000tick，报p50/p95/p99/max、超预算次数、字节/分配/RSS/写入。no-op、summary-only边沿、新checkpoint三路径分测；cold rebuild/warm incremental分报，反复full validation/恢复不能改名cold。布局更改只补前/后提交崩溃、旧writer迟写、同内容复用但lease失效、projection/recovery同提交、丢通知/重复读不重发notice等受影响证据；复用未受影响A9/B12证据，不从头重跑全矩阵。若有界方案仍超预算，带实测上送Pro决定预算/范围，事务外/无写盘/换后台进程均不免成本。

## 失败案例

| 编号 | 场景 / 预期 | 不变量 | 测试 |
|---|---|---|---|
| F-06-1 | usage重复、compact后旧上下文、重复读刷新速率/活动 → 不重复计数，时间/quality保留口径 | I-06-1 | T-06-1、2 |
| F-06-2 | 100MiB冷追赶/巨大未知行/半个UTF-8尾行 → 有界续读、gap或catching_up，不假complete | I-06-2 | T-06-3、4 |
| F-06-3 | 循环、重复ref、>200节点、预算外历史正文 → 截止并loaded=false，零猜边 | I-06-3 | T-06-5 |
| F-06-4 | registry done→idle、明确failed冲突、supervisor失联、旧轮报告 → 提供各维输入/冲突，不复制第二真值表 | I-06-4 | T-06-6、7 |
| F-06-5 | offset先落、摘要后崩溃；旧代查完lease后被接管再rename → 禁半提交/旧代覆盖 | I-06-5、I-06-6 | T-06-8、9、10 |
| F-06-6 | 10run每5s复制四种文件、200ms扫组、SQLite锁5s → 成本超预算，busy不重复外部动作 | I-06-7 | T-06-11–16 |
| F-06-7 | 漏通知/heartbeat WAL风暴/无写者却声称自动收尾 → 截止复读、合并提示、保持stale/uncertain | I-06-8 | T-06-17、18 |
| F-06-8 | 新连接比较旧data_version、statusline扫全树或覆盖stdin → 缓存失效/廉价入口退缺失，stdin仍优先 | I-06-9 | T-06-19、20 |

## 测试清单

以下为待执行规格；A9只验证规格/fixture与最低可行性，B测试最小生产切片，D2–D4仍属B类生产预算扩展，不要求A9先完成生产实现。C/v1.1的未来正向能力不阻MVP。consult 4 的新增恢复/发布断言在 B 的修补包与 B12/B16/B10 定向验证，不追认原 A9 已执行或重开其门禁。（consult 4 增补，F09）（consult 4 增补，F10）（consult 4 增补，F11）

| 编号 | Gate | 输入 → 断言 |
|---|---|---|
| T-06-1 | A9 | 有效零、缺值、估计值、同记录重复读、无事件钟 → quality/source/asOf可解释，unknown=null，observedAt不替代活动事件 |
| T-06-2 | B | Codex累计不增/compact、cc重复message.id/compact_boundary → 去重/重置与checkpoint恢复一致；旧--json口径按07保留 |
| T-06-3 | B | 100MiB合成transcript，每tick4MiB/2000/20ms软预算，首键非type → 有界推进、coverage/skipped准确；真实耗时纳入预算；重启从提交边界在一 slice 恢复最大合法记录，含 CRLF/LF 与实际签名 I/O；不足给 record_needs_larger_slice/minimumBytes+partial，下一足量 slice 前进且全部 I/O 扣预算。生产默认 reader 延迟 I/O 超20ms、正预算仍至少一次受 caps 约束的消费/offset 前进，零预算不消费；受控 clock 测软时间，耗尽时间不伪称字节不足（consult 4 增补，F10）；（consult 5 增补，G09）十个大公开参数、长期重复ID/大量精确时钟与100MiB历史同验：reader生产端提取，inline≤256KiB，索引精确去重/配对/时钟跨重启，合法大记录推进；oversize异常保前commit/gap，标准样本持续错不计通过；（consult 5 增补，G11）分批恢复/prepare用recovery_catching_up和明确coverage，无伪minimumBytes；总deadline/8MiB、公平让出且不永久重做巨大对象，全成本计tick |
| T-06-4 | A9 | CRLF、多字节、无结尾换行、>1MiB行、重写/inode/分支切换与崩溃恢复 → byte offset/state一致，未知大行gap，不无限缓存；UTF-8 多字节/CRLF 中间、私有 api-request-blob 中间、fallback claim 中间崩溃，重读提取/usage 去重与完整读相同且所有序列化产物无敏感哨兵，checkpoint pendingBytes=[]，摘要/配对/时钟不越完整边界（consult 4 增补，F09）；最大合法记录计界符/签名，预算不足 continuation→下一足量 slice 前进，超大无换行跨多次重启有界丢弃且只计一次 gap，reset/compaction 不接旧 transient，复读不刷新事件钟（consult 4 增补，F10）；首/末签名失配等触发 reset/sourceGeneration，保持有限样本的内部改写不宣称可检出，诊断公开 append_only_assumed_bounded_signatures，complete 仅本模型固定边界覆盖，旧锚点/摘要失效（consult 4 增补，F11）；（consult 5 增补，G09）不截旧ID/未闭合调用/必要pending，不用近似集合改usage；索引按ref/sourceGeneration/恢复版本隔离并绑定内容身份/边界，不越commitSeq读latest map，恢复按需键/有界页不全载；（consult 5 增补，G11）语义变更新readerVersion，结构不兼容升checkpoint/内部观测格式并拒旧writer；持lease受控替换旧缓存、重置不可证连续性并保正确谱系/gap，禁止删payload沿旧offset，ledger/export/public版本不联动 |
| T-06-5 | A9 | 201+节点、自环/祖先环/重复ref、深度>4、已转交旧边 → ≤200/8MiB、有continuation/loaded=false，无第二父边或候选计数；B16/B10 共总 deadline/8MiB，多个小 slice 不使合法大记录永久饥饿，下一公平轮次提供足量一记录恢复 slice；不逐 tick 重建 reader/相加20ms，无时间正常续读（consult 4 增补，F10） |
| T-06-6 | A9 | 五维输入各来源、明确失败与registry交互、Herdr done→idle、心跳停/nullable exit → B16输入带当前性/双时间/显式冲突；未做第二套迁移 |
| T-06-7 | B | B16每条真值表逐行fixture，report/uncertain/pending/failed边沿重放及重绘 → 唯一投影、notice seq域/时间稳定；03字段缺失有reason、旧轮不补当前轮 |
| T-06-8 | B | 每个checkpoint/summary准备、发布前后崩溃，消费者并发读 → 只旧commit或完整新commit，offset/state/summary/notice不混配；B12 拒含 raw tail/边界错配产物（含 binary/base64/V8 嵌套），持久 pendingBytes=[]，offset/去重/工具配对/时钟与摘要同完整记录边界；按07受控重建并删除/替换含 raw tail 旧缓存/未发布 bundle，原子重置 continuity（consult 4 增补，F09）；（consult 5 增补，G05）同ReaderResult捕获boundary后唯一B16归并；逐项错ref/版本/谱系/fileId/offset/摘要/commitSeq/continuity/notices/stamp拒发布，可变输入不穿透验证；旧V8重复Map的不可见旧字节不入持久状态，尾随数据/未知结构拒绝，仅重编码已验证值，witness不授权限；（consult 5 增补，G10）新compact内容仅可信prepare完整验证后成opaque PreparedCheckpoint；no-op/summary-only复用已验证不可变内容且不重建/全历史hash/解码；checkpoint/索引引用/current投影同库同事务，前后崩溃只旧或全新，projection/recovery同commit，未知坏内容仍拒恢复；（consult 5 增补，G11）补新布局提交前/后、旧writer迟写与丢通知/重复读notice不重发；复用未变A9/B12证据 |
| T-06-9 | B | 两进程过期接管g→g+1，旧holder暂停于校验与发布之间后恢复 → 旧代写/续约/释放全拒，新摘要不回退；释放再获取不重置generation；（consult 5 增补，G06）同holder重开/readLease/恢复进程均无旧代写权，必须重新acquire(g+1)；原实例全写入口核对持久租约/谱系/previousCommitSeq，正常release→close，15s/≥5s规则与generation下界保留；（consult 5 增补，G10）同内容prepared复用但lease失效仍拒publish，不缓存写权限；summary-only与checkpoint/index变更同围栏 |
| T-06-10 | A9 | collect写ledger lease/改run槽、时钟倒退、lease竞争失败 → 禁写ledger/槽；时间未知只读，消费者可用已有已提交摘要；（consult 5 增补，G06）sampled high-water/持久last_now检测已见倒退，不承诺跳钟后真实15s接管/跨重启单调钟；不可判只读可延停采，UTC可判或正常释放/过期再竞争，零逐tick时钟写/新增clock fence；observation_busy留旧摘要下一正常机会再试 |
| T-06-11 | B | H/R=1/1、2/10的进程树/RSS及终态、无控制uncertain历史 → 数量按P-06-1、helper收尾退出，零常驻恢复/通知服务；（consult 5 增补，G02）正式B45+真实B2，supervisor/helper/必要shell/MCP逐类稳态/峰值RSS、可得PSS/私有驻留及寿命/回收；RSS和不称唯一物理占用 |
| T-06-12 | B | 稳态300s/10run，SQL与文件写trace → 心跳2 logical UPDATE/s，零周期event/evidence/meta/exit复制；status/wait零写，观测/日志/磁盘写单列；（consult 5 增补，G02）两种H/R组合均完整300s/≥60心跳，真实WAL/磁盘写、逻辑心跳与额外事件对照，60s/file-fake不代验 |
| T-06-13 | B | 空闲300s与启动/退出/取消/恢复事件trace → CPU与检查频率达P-06-3，零稳态100/200ms扫组，采样有截止；（consult 5 增补，G02）每run与R=10总user+sys/总系统增量及真实I/O全报，替换前后同环境，禁止以sh原型RSS作生产数 |
| T-06-14 | B | H/R=1/1、2/10每非wait工具/组合预热50次后≥1000次，含锁占用/并发/缓存首用/已提交响应丢失 → 每工具成功/拒绝/busy各自n及p50/p95/p99/max，MCP内部p95<50ms；显式Claude hook档案同次联合p95<150ms，覆盖最外层冷启动至flush全部成本、保守上界且不相加独立分位数。B5授权与事务≤30ms含commit，单次busy_timeout≤10ms，所有等锁/重试/退避累计≤20ms且包含在30ms及剩余双预算内；耗尽且未提交才busy，已提交超时仍恢复原结果、不报未接受、同步commit超时记预算缺陷而非可硬抢占。无外部I/O占写事务，accepted/started分开，零重复提交（F08 Pro 裁决增补）；（consult 5 增补，G02）保持F08全部预算/样本门，正式链包含helper启动/IPC/真实DB等待成本，不以快accepted掩盖慢启动或只报成功者 |
| T-06-15 | B | ≥100个冷MCP + 首次tools/list/call + ≥30启动样本 → 冷启动<200ms，延迟/缺失分开记录，未测能力不报pass；（consult 5 增补，G02）accepted/dispatch/真实harness started/bound/ready按run对齐分布及未达到数，helper/IPC不剔除，替换前后同环境对照 |
| T-06-16 | B | 最小B基准及D4的200节点、增量/冷追赶、宽树/多消费者 → P-06-7/8/9和完整测量元数据齐全，慢样本不隐藏；B14最终显式Claude hook档案另有≥200次真实联合调用、跨≥10次harness启动、每声明路径≥20次，逐工具/结果n及p50/p95/p99/max和Claude版本/helper修订/profile指纹齐全，同次验150/50ms，合成不混入、缺格不授verified；wait沿用原等待预算且前置成本单列，300s资源与accepted→started/bound/ready分计保留，G13零新增常驻服务/轮询（F08 Pro 裁决增补）；（consult 5 增补，G02）正式链300s资源及定向137/SIGKILL/leader退/成员活/helper死/EOF/整组取消/fork退组复用/scope固定前崩溃/父与supervisor死亡；可见另TTY/context/环境，复用无关矩阵；（consult 5 增补，G11）声明组合每个≥1000tick涵盖十个大公开参数、长期ID/精确时钟/100MiB/≤1MiB记录/多消费者/200节点/真实锁与心跳；三路径no-op/summary-only/新checkpoint分报分位/max/超额/字节分配RSS写入，全tick逐样本<50ms，重复验证/恢复非cold |
| T-06-17 | A9 | 提示重复/丢失/注册间隙、短wait截止、原run后新轮 → 有界复读、同run/游标，不依赖通知保证或新服务 |
| T-06-18 | B | 10run心跳风暴、多waiter、启动重连发现receipt/无receipt历史 → coalesced high-water检查，无逐waiter心跳重查/全量对账，status只读；按02幂等导入/取证 |
| T-06-19 | B | 同连接data_version不变/改变、重开连接、自身写、只有时钟变 → 查询缓存正确失效，心跳不全树重建，年龄仍更新；不轮询全表；（consult 5 增补，G10）readProjection不读/解码recovery或运行reader；同offset/mtime不替代内容身份，deadline/谱系/规则/状态边沿不误no-op，保原stamp不贴新ledger high-water；（consult 5 增补，G11）no-op不重复大对象验证/准备，warm/cold独立且索引/hash/commit全计tick，不藏到后台 |
| T-06-20 | B | D3摘要命中/≤50索引fallback/缺失/超时/lease忙+stdin冲突 → 数据入口≤20ms、完整p95≤150ms，partial/unavailable准确、stdin优先，无树/正文扫描或模型调用；（consult 5 增补，G10）status/wait/paint常规路径用投影，完整readCurrent不进热路径；readRecovery仅采集恢复且对齐所读projection同一commit；（consult 5 增补，G11）实际statusline廉价完整入口含打开/校验/读投影≤20ms，B6非wait按P-06-4完整响应测，非只测SQL |
| T-06-21 | C | pi compaction、cache_warm、assistant cost和Flow preview/确认值 → 交互usage不混compaction/cache_warm，单位/quality明确，无token假零 |
| T-06-22 | A9 | tokens已知但cost未知、有效零成本、部分已报告/混estimated合计、重复完整ref → costUsd必有独立Metric且unknown.value=null；零为0/reported，合计带knownCount/missingCount/coverage/quality，估计不冒充下界，credits不换美元 |
| T-06-23 | A9 | 同仓库两个worktree、同remote两个clone、无Git临时副本、显式copy来源、同名不同路径 → 前者同repoId不同规范根；clone不同repoId；副本unknown/declared不升级物理身份；根缺失只说明cwd不同 |
| T-06-24 | A9 | Git缓存命中/冷缺失/超时/明确失效，旧header cwd/包装链改变实际cwd/历史路径消失 → 来源/捕获时间/原因准确、launch不被覆盖且历史可导出；每代≤2子进程/200ms软预算规格、无重复tick/Git热路径/新增watcher；真实成本在B验；合格 Claude 文件 cwd 的 SessionEvidence.cwdSource=transcript，缺证=null/unknown，不伪称 session_meta、不用 callers.cwd 补空；事件/首次观测时间复读不刷新，不授身份或覆盖 launch_cwd，07 仅明确映射既有 transcript 代码（consult 4 增补，F02） |
| T-06-25 | A9 | 两个同名intent各关联本快照currentRun，ledger证据无ref/sourceGeneration，StateContinuity intent缺runId或伪sourceGeneration拒类型；不计已确认session、不造collect租约/ObservationCommit；B9绑定合并保选择映射，无双节点/双父 |
| T-06-26 | A9 | 缺来源/过截止freshness、无报告N成立的failed、failed报告但run.running、run.cancelling → freshness.state为unknown/stale，launch_failed/non_execution带原因且终态，后两者不按图标终结/折历史 |
| T-06-27 | A9 | 重读/重启/两个消费者同commit/心跳usage语言排序变化不重置；同link换run/新待决或失败episode必重置；intent绑定session有同run/episode映射证明才可取原ledger起点，session有自己的真实sourceGeneration；选择键合并或stateKey相同不足，无证据取observed/unknown，无假完成通知 |
| T-06-28 | A9 | 无DB变化跨30000/30001心跳截止纯投影fresh→stale；停采瞬变/源或规则换代/历史缺口/时钟倒退按observed/unknown，不沿用假连续；intent同link新run重置，绑定缺同episode证明不继承时间；不借asOfSeq/bindingGeneration制造sourceGeneration，证据年龄另算，零逐tick/status写 |
| T-06-29 | A9 | ledger已run-b/观测仍run-a、绑定或来源代次错配、无关run seq增长、无库/空库 → b账本事实+有原因缺观测，旧report/stateSince/cwd不混入；实际inputLedgerSeq与独立seqDomain保留，无关增长不全失效，asOfSeq=null/0，不混wait游标 |
| T-06-30 | C | C4同一lease/job读取取得可公开显示名、无名/改名/needs_human/结果未知 → holderLabel可选派生/省略，真实holder/generation/释放不变，名字变化不新增所有权副本 |

## 附录：B16 唯一真值表的填入位置

本槽由B16在A9后实现时填写，遵守上文唯一语义优先关系，不另建状态分类。每行列输入证据/当前性/双时间/冲突、五维输出（freshness.state及所选来源）、stateKey/stateSince/basis/episode锚点、isRunTerminal与notice边沿，并有fixture；至少覆盖registry/transcript矛盾、done→idle completion_seq、旧未闭合工具、心跳截止但receipt未到、native未知的scope结束、父idle子working、旧轮迟报/摘要、launch_failed、failed报告仍running、cancelling、两同名intent绑定、重启/缺历史/规则换代连续性。B16可先做纯归并，但连续性最终发布依B12同一ObservationCommit；B6最终status与B10完整驻留消费均等该验收。运行终结仍引用02，resume门禁仍引用03。
