# 06：观测口径、采集一致性与运行预算

- 版本：`v0.1 draft`（2026-11-01；A2）。预算是验收要求，本批没有运行性能测试或声明已经达标。
- depends-on：[01 身份](./01-identity.md) I-01-1、I-01-8；[02 执行](./02-execution.md) I-02-8–10 与唯一 R-02 对账表；[03 生命周期](./03-lifecycle.md)「报告与 status」「wait 游标与 runId 固定」；[04 托管](./04-supervision.md)「心跳、supervisor死亡与恢复」、I-04-15；[05 能力](./05-capabilities.md)「宿主、定位与 timeout」；[07 外发与兼容](./07-outbound-compat.md)；[概念 v2.3](../universal-hud-concept.md) G13/G14、§6.3–5、§6.8–12、§7、§9.3；[计划](../universal-hud-engineering-plan.md) B8/B12/B16/D2–D4。
- [Oracle](../reviews/2026-11-01-astra-contracts.md) §2、C07、C11–13 是成本与恢复边界的依据；不复写 02 对账真值表。[信息设计](../design/hud-information-design.md) §7 是数据消费者要求；本文不决定标记、布局、计数桶或交互。其原生退出结果假设以 Oracle 的 nullable 结果为准。

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

### Reader、coverage 与树

每次 reader 调用默认最多 4 MiB、2000 条、软时间 20 ms，先到者停止并保存可恢复游标。单条记录最多 1 MiB；时间预算包含解码/解析/归并，单次 JSON.parse 不可抢占，超时仍要记录实测，不声称硬实时。类型来自完整合法 JSON 的 type，不能依赖首键/行首正则。已知非公开类型（cc api-request-blob、thinking、reasoning、pi 图片等）不提取材料；超大记录安全跳过，不能识别其完整类型时记 oversize_unknown 与 gap，不猜作已知类型。未完成尾行最多保留 1 MiB，超限进入有界丢弃至换行状态，不无限扩 Buffer。

`ReaderCheckpoint` 至少含 `schemaVersion,readerVersion,ref,fileId{dev,inode},offset,sourceGeneration,parserState`。offset 是已消费字节边界，含 CRLF/UTF-8 的真实字节；未提交尾行/丢弃状态必须可恢复。截断、inode/文件变化、compaction、分支切换各有明确的重置/续读原因，不用 mtime 作为唯一身份。sourceGeneration 是读取谱系，collect lease generation 是写入权；二者不能混用。

`Coverage={state:complete|partial|catching_up, skipped, gaps[], remainingBytes?, loaded, reason?}`：complete 仅指本次已知输入边界内所有应解析的公开记录已覆盖，不表示会话全部历史或不存在原生子；catching_up 表示预算尚未追到固定输入边界；partial 表示跳过/不可读/缺历史/分支不明，追上 EOF 也不能清掉已有 gap。skipped 分类型/超大/未知原因计数，排除私有块不保留正文。允许同时 catching_up 且有 gaps，不能靠一个枚举丢失缺口。

树采集每 tick 共用 8 MiB 文件 I/O、≤200 个节点、跨 harness 展开深度预算默认 4；各 reader 还受自己的预算约束。visited 以完整 SessionRef/JobRef 去重、防自环/祖先环；只用 adapter.children 提供原生拓扑和账本当前关系。预算外节点只保留限额内的身份/最后状态并置 loaded=false，不递归偷读；已知但未装载的数量/continuation 单列，不声称整棵大树已收全。历史 handed_over 关系不是第二父边，候选不进入确定树或已验证计数；解析权限与候选范围引用 01。

### B16 的五维输入与消费者字段

输入证据统一携带 `{ref,runId?,bindingGeneration?,sourceGeneration,origin,eventAt,observedAt,lastSuccessfulReadAt,seq?,evidenceId?,validity,reason?}`。origin 为 registry/transcript/supervisor/report/job；validity 区分当前且匹配、stale、unknown、矛盾。失联不改原事件时间，进程存在只证明存在。registry 的 server、occupant、completion_seq 和来源时钟必须可见，不能把 shell idle 当 harness idle。

| 维度 | 输入值与所需证据（最终归并归 B16） |
|---|---|
| activity | working / waiting_input / idle / exited / unknown；匹配且新鲜的 registry 交互事实、transcript turn/tool 边界、受管进程事实；打开工具调用的开始/最后活动时刻，防历史未闭合调用无限推 running |
| pendingReason | none / approval / question / needs_human；公开审批/问题的打开与解决 ID/时间，registry blocked，Jev NEEDS_HUMAN；缺记录不能伪造 resolved |
| lastTurnOutcome | none / completed / failed / interrupted；明确 turn 结束事件、固定 run 的报告、04 有来源的退出结果；缺原生退出码保持 null，不从 shellStatus 推任务结果 |
| liveness | alive / gone / unknown；04 心跳/ScopeCheck、匹配进程实例或 registry 可见性；跨 PID 域、读失败/缺心跳分别保留原因，不自行释放运行槽 |
| freshness | 每来源的 lastEvidenceAt / observedAt / lastSuccessfulReadAt / error / deadline / clockAnomaly；匹配 04 心跳边界与 registry 缓存信息；陈旧来源保留 lastKnownActivity，成功重复读取不伪造新活动 |

B16 使用概念 §6.8 的来源职责：当前交互优先采用匹配且新鲜的 registry，明确失败不能被它覆盖；unknown 可回有效文件证据。冲突组合与最终 projection/notice 真值表只有本文件附录槽的 B16 一份，B6/B10 不另判。

消费者 `ObservationView` 提供 `statusProjection{activity,pendingReason,lastTurnOutcome,liveness,freshness,asOfSeq,asOf,observedAt,lastEvidenceAt,lastKnownActivity?}`、`conflict{count,recordIds[],since}|null`、各 Metric、Coverage、loaded、depth、evidenceStamp。asOf 为所采纳事实边界，observedAt 为观察时间；所有新时间为毫秒 epoch。conflict 显式来自已记录矛盾及其证据，不能以 unknown 代替；这是未决冲突摘要，不在 06 裁定谁赢。

关系相关字段由 [03「报告与 status」](./03-lifecycle.md#报告与-status)及[「status 与 HUD 可读投影」](./03-lifecycle.md#status-与-hud-可读投影)供应：link、runHandshake、currentRun/isCurrent、latestReportForRun/按轮历史、parent.offline 与 orphan_policy、uncertain 的 reconciliation{evidenceIds,missing,allowedActions}、resumable+reason；host/occupant 由 05/04 供应。06 在同一次观测摘要引用它们，保留 asOfSeq 与缺失原因，不因 link.state 推测本轮绑定、拿旧轮报告补新轮或自行实现 resume 门禁。候选只保存有界种类/时间/指纹，字段不足标 unavailable；候选正文不作为默认补齐来源。Jev 的 JobRef/租约投影留 C。

`NoticeEvent={seq,seqDomain,created_at,ref,runId?,kind,inputStamp,sourceEventSeq?}`：B16 根据 pendingReason 从 none 进入待决、明确 failed、新报告、进入 uncertain 生成边沿；按 inputStamp/report_id 去重，初次读取不是重复完成。ledger 事实保留 sourceEventSeq；派生通知随观测一致提交获得该观测域递增 seq（域含 source/视角），不伪造 ledger events.seq，不跨域比较游标。created_at 是事件时刻或注明的首次观测时刻；切 tab/重绘不生成通知。parent.offline 消费 04 的持久事件，不由一次 registry 超时编造。

### checkpoint 一致提交与 collect lease

`CollectLease={resource:collect:<SessionRef>,holder,generation,expires_at}` 存在 `$HUD_HOME/sources/<sourceId>/` 的观测存储，绝不放入 ledger leases。generation 持久单调，释放保留下界，不删除后从 1 重来。它只授权采集 checkpoint/summary/notice 写入，不授权启动/终结 run 或释放槽；三类资源的另外两类引用 I-02-10。

逻辑提交 `ObservationCommit={ref,sourceGeneration,leaseGeneration,commitSeq,checkpoint,summary,notices}`。checkpoint 的 offset/parserState 和由它导出的摘要/notice 必须同时可见。可采用独立观测 SQLite 的一个短事务，或不可变 bundle + 一个原子发布指针；不能把 checkpoints/*.json 与 summaries/*.json 两次 rename 冒充一次提交。保留概念路径时两者必须解析同一个 commitSeq/bundle，不准消费者各自取「最新文件」。布局/点击状态另在 instances/，不参与解析进度。

接管与发布必须共用同一原子 CAS/互斥边界：写入时同时重验 holder/generation/有效期、ref/sourceGeneration 与前一 commitSeq，再发布。文件方案的「查 lease → 放锁 → rename」不合格，旧持有者不得覆盖新指针；SQLite 方案也不能在事务外做一次 lease 检查后盲写。准备文件/解析在边界之外，提交内只校验与发布必要元数据；同一边界串行化接管。目录 0700/文件 0600，临时文件完整写/fsync 后再发布，必要目录 fsync；崩溃留下的未发布 bundle 不被读取。

## 不变量

| 编号 | 断言 | 测试 |
|---|---|---|
| I-06-1 | Metric 的 source/asOf/quality 可解释；未知不作零、重读不续活动时间，观测时间与事件时间分开 | T-06-1、2、21 |
| I-06-2 | reader 字节/记录/时间/单条上限和恢复状态有效；超预算/跳过不伪造完整 coverage | T-06-3、4 |
| I-06-3 | 树≤200节点、去重无环、I/O有界；未加载/候选/历史边不变成新的确定节点事实 | T-06-5 |
| I-06-4 | 五维输入、显式冲突、notice 原始边沿/seq 与时间可提供；只消费 B16 唯一归并，关系门禁引用 03 | T-06-6、7 |
| I-06-5 | checkpoint/parserState/summary/notices 同一 commit；消费者只读完整已发布版本，绝不新旧混配 | T-06-8 |
| I-06-6 | collect 可过期换代，接管与发布同一围栏，旧代迟写/续约/释放全部拒绝；它不写 ledger | T-06-9、10 |
| I-06-7 | 热路径、进程、逻辑写入、CPU 与冷启动逐预算测量；不把 accepted 延迟当启动延迟 | T-06-11–16 |
| I-06-8 | 通知是 hint、游标是事实；有界复读、心跳提示合并、不新增服务；status 只读 | T-06-17、18 |
| I-06-9 | HUD 用廉价变更信号与已提交摘要；statusline 数据入口≤20ms，stdin 优先、失败可退现有摘要/缺失 | T-06-19、20 |

## 状态机

### 采集与租约

`free/expired → held(g+1)` 在原子边界取得租约；`held(g) → held(g)` 只有当前 holder 可在有效期内续约。过期后的任何 writer 必须重新竞争，不按「我还活着」续写。接管后旧 writer 变 fenced，只能读新摘要；释放只能 CAS 自己的 holder/generation，保留下界。时钟倒退/域不明时返回 lease_time_unknown、先只读，不猜过期接管。

`read committed → read bounded delta → prepare → fenced publish → committed`：预算耗尽也可发布带 catching_up 的一致进度；publish 失败丢弃未发布结果，重读当前 commit 后再决定。崩溃在发布前只有旧 commit，发布后只有完整新 commit；不存在消费者可见的半新进度。失去租约、解析出错与旧文件代次都不能借更新 observedAt 让旧数据显得新鲜。采集租约的续约单独计量，可与内容提交合并；无内容改变不重写 checkpoint/summary，续约不得比每 5 s 更密。

### 变更信号、wait 与恢复唤醒

长寿命 HUD/账本只读连接先比较同一连接上的 PRAGMA data_version（或等价已提交 bump/commitSeq），不变就复用查询结果；值只可在同一连接跨次比较，不能拿新 statusline 进程的值与上一个进程比较。连接重开使本地缓存失效；自己的提交须直接使本地缓存失效。data_version 是粗粒度失效提示，不是事件游标；heartbeat 改 WAL 也会使它变化，必须进一步比较相关 events high-water/摘要 stamp，不能每次重建全树。年龄/stale 截止即使无数据变化仍由 nowMs 重算；不重查正文。

已有 hud-mcp 进程中的相关 commit 可按 runId 提示 waiter；跨进程文件/WAL 通知只作提示，不可靠也不增加通知 daemon。wait 先读、登记提示后再有界复读以关掉丢通知窗口；相关提交/心跳失联截止/返回 deadline 再读同一固定 run 的索引页，规则引用 03。漏提示最多延后到有效 wait 截止复读，nextSeq 不越过未返回事件。重复提示合并；粗粒度文件提示在每个现有进程按 HUD_HOME 合并，heartbeat-only 提示的 high-water 检查最多一次/5s，没有新相关事件时不逐 waiter 读取状态/扫进程；已知 run 的真实提交通知可直接唤醒。合并窗口不是另起周期轮询。

恢复由现有 hud-mcp 启动/重连、相关 run 事件、必要心跳截止、显式 reconcile 触发有预算的单次工作：先导入匹配遗留 receipt，无 receipt 时按 02 同一表取证。超预算保留 continuation/uncertain，下一相关触发续做，不后台按秒重扫全部 run。heartbeat 本身不是对账事件；status 不触发写入；没有活写者时 HUD 诚实保留 stale/uncertain。观察不能取得新执行票据。

### statusline 廉价数据入口

`readStatuslineSummary(ref,{budgetMs:20,maxChildren:50})` 首选同 source/ref 的已提交通用摘要（年龄≤5s），否则至多一次按 parent_ref 索引的 ≤50 个直接子项查询，不构建全树、不扫 transcript/进程/宿主 CLI、不调模型。返回树计数及直接子项已有的投影字段/seq/coverage；limit 截断显式 partial，不能把 50 条当完整总数。预算包含打开/校验/读取/解码/查询，数据入口墙钟≤20ms；同步底层偶发超时是预算缺陷，记录并降为 unavailable，不把“有deadline”当已能硬抢占的保证。冷进程启动/最终绘制另计，见预算表。

stdin 的 session/model/context/cost 永远优先，摘要不覆盖它。廉价摘要/索引均不可用时返回 unavailable；如 D3 在剩余总预算内需要本地 session 的增量补充，复用同一预算 reader/collect lease，竞争失败只读已有摘要，冷追赶 partial，不阻塞输出。不得为了委派数据启动第二套 parser 或常驻采集服务。

### 性能预算与测量协议（G13；Oracle §2）

| 编号 | 验收预算 | 测量边界 |
|---|---|---|
| P-06-1 | H 个实际加载 harness → H 个 MCP；R 个活跃 run → R 个 hud-run；shell 档案的必要启动 shell 另计；默认零独立 reconciler/sidecar/通知服务 | 记录进程树、每类数量/RSS；必要 scope helper 单列理由/数量/寿命/RSS，随 run 收尾退出。终态或只剩无控制能力的 uncertain 历史不养 observer |
| P-06-2 | 5s 心跳仅一次 runs CAS UPDATE；稳态协议心跳速率 R/5 logical UPDATE/s，R=10 时2次/s | 单列启动/终结事件写、collect lease/内容写、日志字节、SQLite WAL/实际磁盘 I/O。心跳不各写 event/evidence/meta/exit；正常 status/wait 零写，不更新 last_seen |
| P-06-3 | 空闲阻塞；正常存活期零 100/200ms /proc 全扫/扫组循环；仅启动期有截止采样、退出/取消/恢复事件做必要检查 | trace 记录检查次数与触发原因。空闲 hud-run+其 helper 的 user+sys CPU，默认验收解释「≈0」为每 run 平均<1%单核；采样300s（≥60心跳），不含 harness/模型工作，另报总系统增量；超标是缺陷 |
| P-06-4 | 非 wait MCP p95 <50ms（含 status/spawn/resume/cancel/whoami/report 的成功与拒绝） | 从完整 tools/call 到响应序列化/flush，含验证/摘要准备、DB 等待/commit；spawn/resume 返回 durable accepted+starting，cancel 返回 durable 取消意图，不等 TUI ready/绑定/12s序列。每工具分别测，不能只靠快拒绝达标 |
| P-06-5 | 实时同步 SQLite 等待短且受响应总预算限制；busy_timeout≤10ms，重试含退避累计墙钟≤20ms并扣剩余响应预算 | BEGIN IMMEDIATE 内无文件读取/摘要计算/宿主 CLI/进程发现/网络等外部 I/O；事务内重验 context/版本/槽。预算耗尽且未提交时 busy/未接受；已提交响应未知按 02 重放，不再提交外部动作。长锁压测单列 busy 数/尾延迟 |
| P-06-6 | MCP 冷启动<200ms | 从创建新 MCP 进程到可正确回答 initialize，包含 Node/模块加载/必要存储打开；不加载整个 HUD/reader/Herdr 模块图。tools/list/首次工具延迟另测，不能以延迟初始化隐藏成本 |
| P-06-7 | HUD 增量 tick<50ms；reader 软20ms，树≤200/8MiB | 从增量 collect 入口到一致摘要发布及本次数据组装/渲染/paint enqueue 结束，含 I/O 等待/调度；两入口分别测。冷追赶单列，不把等待下一 tick 的空闲算进去或把慢增量移成「冷」 |
| P-06-8 | statusline 廉价数据入口≤20ms；完整 statusline p95≤150ms | 前者按上节独立测（含摘要命中/索引 fallback/缺失）；后者包含冷进程、stdin、采集竞争及输出，D3/D4 验收，故障/空输出按概念 §9.3 门禁，本文不决定视觉 |
| P-06-9 | accepted→started/bound/ready 分开测，不以<50ms承诺完成启动 | 保存 accepted（意图commit）、dispatch、真实 harness started、bound、host-ready 时刻及超时/未达到数；按相同 run 对齐，nullable 时刻明确缺失，不能只统计成功者 |

最低可重跑基准：记录 CPU型号/vCPU与quota、内存、磁盘/文件系统（本地/跨挂载）、OS/kernel/WSL、Node/SQLite/harness/host版本、HUD revision/profile、样本/原始计时、并发与数据量。没有这些信息的数字不能作验收证据。

使用临时 HUD_HOME/source、固定合成100MiB历史；增量分0/1/2000条、含≤1MiB单条、200节点/深度4、多消费者 panel+statusline（D再加watch）。MCP 按 H/R=1/1、2/10 并发运行，含心跳交错/锁竞争；相同数据跑有/无Herdr。非wait每工具每组合预热50次后≥1000次，报告成功/拒绝/busy数及p50/p95/p99/max；空闲CPU/写入≥300s，排除起止事件后核对60个心跳边界，日志吞吐另外测。

冷启动每形态≥100个新进程，说明 OS页缓存冷热；增量每组合≥1000 tick，statusline 每入口≥1000次。冷启动/增量tick的<200/<50按所声明工作负载的逐样本上限检查，另报p50/p95/p99/max与超预算次数；不得只报平均或删异常值。started/bound/ready 用≥30个合成进程启动样本统计同样分位和缺失数，真实 harness 逐能力格样本量另报；未有样本标未测。B先做最小基准，D4扩展到超大行/无换行/重写/宽树/多消费者；任何 helper/包装链变化只重验受影响预算与TTY/context行。以上不是本批硬件实测结果。

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

以下为待执行规格；A9只验证规格/fixture与最低可行性，B测试最小生产切片，D2–D4仍属B类生产预算扩展，不要求A9先完成生产实现。C/v1.1的未来正向能力不阻MVP。

| 编号 | Gate | 输入 → 断言 |
|---|---|---|
| T-06-1 | A9 | 有效零、缺值、估计值、同记录重复读、无事件钟 → quality/source/asOf可解释，unknown=null，observedAt不替代活动事件 |
| T-06-2 | B | Codex累计不增/compact、cc重复message.id/compact_boundary → 去重/重置与checkpoint恢复一致；旧--json口径按07保留 |
| T-06-3 | B | 100MiB合成transcript，每tick4MiB/2000/20ms软预算，首键非type → 有界推进、coverage/skipped准确；真实耗时纳入预算 |
| T-06-4 | A9 | CRLF、多字节、无结尾换行、>1MiB行、重写/inode/分支切换与崩溃恢复 → byte offset/state一致，未知大行gap，不无限缓存 |
| T-06-5 | A9 | 201+节点、自环/祖先环/重复ref、深度>4、已转交旧边 → ≤200/8MiB、有continuation/loaded=false，无第二父边或候选计数 |
| T-06-6 | A9 | 五维输入各来源、明确失败与registry交互、Herdr done→idle、心跳停/nullable exit → B16输入带当前性/双时间/显式冲突；未做第二套迁移 |
| T-06-7 | B | B16每条真值表逐行fixture，report/uncertain/pending/failed边沿重放及重绘 → 唯一投影、notice seq域/时间稳定；03字段缺失有reason、旧轮不补当前轮 |
| T-06-8 | B | 每个checkpoint/summary准备、发布前后崩溃，消费者并发读 → 只旧commit或完整新commit，offset/state/summary/notice不混配 |
| T-06-9 | B | 两进程过期接管g→g+1，旧holder暂停于校验与发布之间后恢复 → 旧代写/续约/释放全拒，新摘要不回退；释放再获取不重置generation |
| T-06-10 | A9 | collect写ledger lease/改run槽、时钟倒退、lease竞争失败 → 禁写ledger/槽；时间未知只读，消费者可用已有已提交摘要 |
| T-06-11 | B | H/R=1/1、2/10的进程树/RSS及终态、无控制uncertain历史 → 数量按P-06-1、helper收尾退出，零常驻恢复/通知服务 |
| T-06-12 | B | 稳态300s/10run，SQL与文件写trace → 心跳2 logical UPDATE/s，零周期event/evidence/meta/exit复制；status/wait零写，观测/日志/磁盘写单列 |
| T-06-13 | B | 空闲300s与启动/退出/取消/恢复事件trace → CPU与检查频率达P-06-3，零稳态100/200ms扫组，采样有截止 |
| T-06-14 | B | 每非wait工具≥1000次，锁占用/并发/已提交响应丢失 → p95<50ms，busy短退、无外部I/O占写事务，accepted/started分开，无重复提交 |
| T-06-15 | B | ≥100个冷MCP + 首次tools/list/call + ≥30启动样本 → 冷启动<200ms，延迟/缺失分开记录，未测能力不报pass |
| T-06-16 | B | 最小B基准及D4的200节点、增量/冷追赶、宽树/多消费者 → P-06-7/8/9和完整测量元数据齐全，慢样本不隐藏 |
| T-06-17 | A9 | 提示重复/丢失/注册间隙、短wait截止、原run后新轮 → 有界复读、同run/游标，不依赖通知保证或新服务 |
| T-06-18 | B | 10run心跳风暴、多waiter、启动重连发现receipt/无receipt历史 → coalesced high-water检查，无逐waiter心跳重查/全量对账，status只读；按02幂等导入/取证 |
| T-06-19 | B | 同连接data_version不变/改变、重开连接、自身写、只有时钟变 → 查询缓存正确失效，心跳不全树重建，年龄仍更新；不轮询全表 |
| T-06-20 | B | D3摘要命中/≤50索引fallback/缺失/超时/lease忙+stdin冲突 → 数据入口≤20ms、完整p95≤150ms，partial/unavailable准确、stdin优先，无树/正文扫描或模型调用 |
| T-06-21 | C | pi compaction、cache_warm、assistant cost和Flow preview/确认值 → 交互usage不混compaction/cache_warm，单位/quality明确，无token假零 |

## 附录：B16 唯一真值表的填入位置

本槽由 B16 在 A9 后实现时填写，不是 A2 留下的另一张状态表。每行必须列输入证据/当前性/双时间/冲突、五维输出及 notice 边沿，并有对应 fixture；至少覆盖 registry/transcript 矛盾、done→idle completion_seq、未闭合工具的陈旧证据、心跳停而receipt未到、原生结果未知但scope已结束、父idle子working、旧轮迟报、关闭后历史保留。运行终结仍引用02，resume门禁仍引用03。
