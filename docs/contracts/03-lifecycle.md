# 03：关系、运行、报告与转交生命周期

- 版本：`v0.4 draft`（2026-11-01；Oracle C01–C14、D01–D13 修订）。
- 状态：A1 第二批草案，待主审与四契约一致性确认；A9 前不作为阶段 B 的冻结基线。
- depends-on：[01 身份](./01-identity.md)、[02 执行协议](./02-execution.md)、[04 托管](./04-supervision.md)；[概念方案](../universal-hud-concept.md) §6.6、§6.10–11、§15–16；[工程计划](../universal-hud-engineering-plan.md) A1/B3a/B3b/B4/B6。
- 证据快照：[Oracle](../reviews/2026-11-01-astra-contracts.md)已裁决修订甲，终结可无原生退出结果；[A8](../probes/hud-run-visible.md)首轮拒绝；A8-fixB2 关键证据已于 `8fdf4cf` 接受（同 agent/session、实际 context、父 launcher 退出后的 TTY 输入/收尾；限前台 hud-run 形态），不等于 B 生产矩阵通过。A3 五份探针已评审，版本/模式与有界 spoof 边界见01；[daemon 补测](../probes/codex-daemon.md)仅证明 CLI 0.166 / daemon 0.163 在场时默认 direct-stdio，不是共享支持，也非 A9 前置。A9 审规格/最小原型，生产矩阵在 B。


本文只规定可验证的记录与权限，不保证外部任务一定执行或完成。账本写者仅 hud-mcp、hud-run、reconciler；所有身份/关系/运行迁移走 reconciler 事务入口。HUD 读已提交账本，消费 B16 的五维状态结果，不自判完成，不写账本。

正确性与轻量同级（概念§2 G13/G14）：正常调用者一次 spawn + 有界 wait，登记、握手运输、托管与对账由现有写者推进，不要求手工续租/放槽。spawn/resume 只等持久 accepted，cancel 只等取消意图接受，不等 ready/结束；accepted→started/bound 单独计量。短 SQLite 等待和全部性能/唤醒预算归 [06](./06-observation.md)，外部读取/hash/宿主命令不占写事务。HUD 只读字段与能力门供给依据 [信息设计§7](../design/hud-information-design.md)；本文不决定呈现。

（P065 元数据例外，2026-11-03）仅 [02 执行协议](./02-execution.md) 明列的固定私有存储元数据复验可例外占用写锁区间；其余外部准备与来源取证仍在事务外。此例外不改变 actor、来源证明、writer、capability 或受支持档案规则，详见 [Oracle 裁决](../cloud/rulings/p065-metadata-exception.md)。

Oracle 已追认 provisional、同 owner predecessor、逐轮 runHandshake 等核心不变量；修改项以其 C01–C14 为准，不再把旧编排者方案当待实现协议。§15 决策日志保留，跨契约/范围新分叉仍交编排者/Oracle。


[Oracle consult 2](../reviews/2026-11-01-astra-consult2.md) D01–D13 补齐字段、控制主体与读取边界；本轮仍是 A4/A9 候选契约，不代表 A9 放行或 B 生产能力已验证。

[Oracle consult 3](../reviews/2026-11-01-astra-consult3.md) E01–E06 同步观测绑定、取消分类、事实时序与 export v1；仍是 A9 候选，不代表阶段 B 生产验收。

冻结后增补版本：`A9 + consult4 + F08-Pro + consult5-2026-11-02`。本轮依 [Oracle consult 5](../reviews/2026-11-02-astra-consult5.md) 增补，保留此前 C/D/E、consult 4 F01–F11、F08 Pro 与 A9-fix；ledger schema v1 不变，不授予尚未验收的生产能力。（consult 5 增补，G03）

## 数据模型

| 对象 | 字段、身份及本契约的含义 |
|---|---|
| Link | link_id、state、parent_caller/context/generation、parent_ref、child_ref、current_owner、brief_path/task_digest、predecessor。OwnerKey按01派生；缺ref仅合法dedicated proc scope，不凭linkId自授权限 |
| Run | run_id、link_id、run_seq、target_session_ref、expected_generation、mode、state、claim、locator、scope。一个 link 可有多轮；currentRun 是最大已提交 run_seq，不能用最新 mtime/报告时间选择 |
| runHandshake | 由该 run 的 claim/child_bindings 推导的 pending / claimed / bound；不是 runs.state 的值，也不另造关系。pending=尚无合格声明/绑定，claimed=有有效声明但尚未独立证实，bound=本轮当前有效 MCP 绑定。已撤销/过期另带 reason，不授予权限 |
| Report | report_id、固定 run_id/link_id、child_binding_id、caller/context/generation、status、summary、绝对 path、created_at。status 仅 completed/failed/blocked/interrupted，是子自报结果，不是退出回执 |

首次意图持久写 `links.task_digest=SHA256(canonicalJSON([brief_path, brief_content_hash, backend, source_id, role]))`，canonicalJSON沿用02规则，不试图从params_digest反解。resume重读brief并计算同一tuple比较task_digest；补充仅本轮prompt，mode/model/effort不在任务判据中但仍进每轮params_digest。改任务用predecessor新link；同路径不同内容返回task_mismatch，不用模型猜同任务（T-03-7）。

OwnerKey 是稳定逻辑身份，不是 MCP/context_id；每次工具调用仍先核验逻辑来源当前性/代次。共享或不可辨原生子来源不开放 MVP 操作。run 的 scope 结束事实与任务报告、原生退出结果分别保存；没有原生结果不等于 uncertain。


## 不变量

`DB` 为 02 键/约束的结构保证；`TX` 为写者事务；`E` 为真实进程/探针证据。

| 编号 | 可检查断言 | 层 / 测试 |
|---|---|---|
| I-03-1 | Link、run、report 三种身份分开；每个接受的运行有唯一 run_seq，报告/事件不能重指到下一轮。关系终态不替代运行终态 | DB+TX；T-03-1、2、10 |
| I-03-2 | 运行迁移仅用 02 的 R-02 表；report、关 pane、父退出、心跳过期都不能自行释放槽；uncertain 仍占实际或 provisional 槽 | TX+E；T-03-3、4、13 |
| I-03-3 | 已证实关系的 resume 不回退 pending：MVP bound/reported→bound，同 link 新 run starting/握手 pending；旧报告/运行历史保留，closed 重开延期 | TX；T-03-5、6 |
| I-03-4 | resume/handover 新握手只能绑定既有 child_ref；解析成别的 ref 不改 links.child_ref/runs.target_session_ref，run uncertain、最多候选；同 SessionRef 的可信文件连续性不能由路径猜测 | DB+TX；T-03-8、9；01 T-01-37 |
| I-03-5 | resume 须 current_owner、bound/reported、同任务/正确 owner、真实 child、空槽/无未决冲突；旧 claim/binding 撤销，新 run/claim/代次/correlation 独立，原生消息 ID 可晚到；（consult 5 增补，G03）新意图 supplied expectedRun 与事务 currentRun 作 CAS；重放次序归 02，MCP 可省略、本地必填，旧准备前提仍重验 | TX；T-03-5–9 |
| I-03-6 | report 只接受本 run 当前有效 MCP binding/context/generation；无 MCP、旧撤销绑定不授权。旧轮报告/拒绝事件不改变新 run/握手，不满足新 wait | DB+TX；T-03-10–12 |
| I-03-7 | wait 入场原子解析并固定 runId，按该 run 的已提交 seq 读取；游标只到实际返回的最后事件；超时不写状态，不因新 run/其他 link 事件返回成功 | DB+TX；T-03-14–17 |
| I-03-8 | predecessor 是同一个实际 child 的转交：旧 link handed_over/current_owner=0、新 link bound/current_owner=1、新 run starting 在一个意图事务；唯一当前父边，旧 link 只保留历史，无环 | DB+TX；T-03-18、19 |
| I-03-9 | MVP 跨 owner 转交一律 unsupported；linkId、claim、自报凭证或历史曾为 owner 均不授新控制权 | TX；T-03-20 |
| I-03-10 | 同 owner predecessor 的旧新 link/run/claim/槽/幂等/事件同事务；接受后启动未知不回滚关系或重发，历史前驱不能再次使用 | DB+TX；T-03-18、19 |
| I-03-11 | 仅 authenticated-parent MCP 可 close 当前 owned 的 bound/reported headless 关系；先持久意图，按02/04证明终结才 closed；visible/local-user close 仍 unsupported，历史保留 | TX；T-03-26 |
| I-03-12 | closed 由已批准 E4 headless close 产生并保留历史；禁止重开；failed/revoked/handed_over 不 resume。旧 locator 不匹配新 occupant 时不供当前宿主状态/控制 | TX；T-03-6、19、30 |
| I-03-13 | HUD 仅投影已提交关系/运行/报告与 B16 状态，历史边不当第二父边；MVP Resume/Reconcile仅复制类型化固定目标命令，活跃 headless 只看日志，运行终态由共享谓词判定；ledger/观测各自加戳 | TX；T-03-30、31、34–37 |
| I-03-14 | 正常 spawn+wait，无手工协议；相关事件/必要截止唤醒，按客户端 timeout 留余量短等；status 索引快照只读，短锁等待/accepted及started分计，预算归06 | TX+E；T-03-17、32、33 |

## 状态机

### Link 与本轮握手

所有迁移附 link_id、触发 run_id（如有）、采用证据/报告/操作 ID 的事件，含持久 seq 与 created_at（投影自 events.at，毫秒 epoch）。未列状态迁移拒绝并记录原因；不是状态枚举里任意两值都可互转。

| 起点 → 终点 | 前置条件与动作 | 测试 |
|---|---|---|
| 无→pending | 02 新会话首次 spawn 意图事务；身份尚未证实，不能画确定 child 父边 | T-03-1 |
| pending→claimed→bound | 01 claim + 独立启动/source/当前逻辑会话证据；无 MCP 始终未确认，不建确定父边 | T-03-1 |
| bound→reported；reported→reported | 当前 run 的有效子报告被接受；report 与 link.reported 事件同事务。任何 status 都只表示“收到报告”，运行仍可 active/uncertain | T-03-2、10 |
| bound/reported→bound | 满足 I-03-5，同 link 新 run starting/握手 pending；既有关系不授予本轮报告权限 | T-03-5、8 |
| pending/claimed→failed | 首轮由02证明未执行且从未绑定/无当前父边；撤销 claim。已绑定关系某轮 run.failed 不使 link.failed | T-03-3 |
| pending/claimed/bound/reported→revoked | reconciler 证实身份/授权冲突或当前 owner 显式撤销，清当前边/旧授权、保留 ref/历史；run 仍独立对账，不借此放槽 | T-03-4、30 |
| bound/reported→handed_over | 旧 link 当前、同 owner、实际槽空/无冲突/环；旧历史化，新 link 对已知 child bound、新 run starting/握手 pending，同事务 | T-03-18–20 |
| failed/revoked/handed_over→原状态 | 只读历史；不能恢复控制/再次当 predecessor。旧 owner 只能读该历史 link/run，不因此获新 link 控制权 | T-03-19、30 |

revoked 运行的安全收尾仍可由接受时的 orphan_policy/已鉴权取消意图或受信本地 `hud run cancel` 管理入口执行；这只控制旧 RunHandle，不授予父子身份或新执行权。普通 MCP parent 操作若无当前 owner 授权必须拒绝，不能把“历史曾是 owner”当任意取消权限。

### Run 状态与合法组合

Run 只有 starting/running/cancelling/uncertain/ended/failed/cancelled；迁移完全引用 I-02-5–9 和 R-02-0–9，不另设一套完成规则。normal starting→running 需要已启动证据、H 与 G；starting/running/cancelling 可进入 uncertain；uncertain 只有 R/Q/N/恢复同一实例的 H+G 等对应行才能退出。取消接受先 cancelling；无 X 且完整 R/Q 时，已接受取消且 before_exit 已证明才 cancelled，时序未知为 ended+cancel_timing_unknown 并释放槽，after_exit 才解释 already_ended；非零退出仍 ended，任务失败投影另记（T-03-3、13）。

| Link 状态 | 可以并存的 run / 握手事实 | HUD可读关系字段/状态 |
|---|---|---|
| pending/claimed | run 可 starting/running/uncertain/cancelling，甚至已结束但身份仍缺；不能以 run alive 自动 bound | “父/子未确认”，候选分开 |
| bound/reported | run 可 active/终态；resume 后握手 pending；reported 不证明该 run 退出 | 确定当前父边；当前轮报告与历史分开 |
| closed | E4 headless close 经独立终态证据完成；不得重开 | 保留历史，resumable=false/reason=deferred |
| failed | 首次未执行且未绑定；无活跃槽 | 失败意图历史，不显示臆测 child |
| revoked | 可能仍有 active/uncertain run 与槽，必须独立对账 | 身份/权限失效，历史保留，不借机重新归属 |
| handed_over | 转交前旧会话槽须空，旧 link 不再追加 run；新 link 有自己的当前 run | 历史predecessor/current_owner=0，不能当第二父边 |

### 报告与 status

delegate_report 的 runId 先定位原 link，不能从 caller 的“当前 link”或最大 run_seq 改写它。事务内重验物理 caller、context 当前代次、本 run 当前 mcp child_binding、SessionRef/expected_generation，无当前绑定或绑定撤销返回 unauthorized/stale_binding。每个接受的调用生成独立 report_id 与 report.received 事件；本契约不宣称 report 重试去重，消费者按 report_id/seq 去重展示。同一当前轮收到多份报告取其最大已提交 seq，状态 completed/failed/blocked/interrupted 不覆盖进程退出事实（T-03-10–12）。

旧轮报告若在其绑定尚有效时先于 resume 事务提交，只写旧 run；resume 后当前摘要按新 run 查询。已撤销旧绑定的迟报拒绝，只记 report.rejected 审计事件，run_id 仍是旧轮，不伪造成合法历史提交。即使报告在旧轮获准，link.reported 的更新也须确认它仍是 currentRun；closed/revoked/handed_over 绝不由迟报重开。

（consult 6 增补，H12）当前 run 按已提交 report.received seq 选出的最新已接受 blocked 报告，是独立待决来源：pendingReason=needs_human、stateKey=pending:blocked，保留 source、reportId、进入时间及 seq。它只表示需要外部处理，不证明具体 approval/question 或必须真人执行的动作，不新增授权协议。明确 failed 等 outcome 仍在自身维度保留；解决另一请求不能顺带清除最新 blocked（06 C56），新当前轮报告按上述 seq 语义取代旧报告。run.state/isRunTerminal/槽/resume 门禁均不变；B6/B10/B13 共用唯一 B16 规则。

（consult 6 增补，H07）03 事件消费白名单新增 supervisor.signal，严格引用 02/04 的 SupervisorSignalFact 和登记 supervisor 完整 stamp 门禁；不把它当 report、command exit、cancel step 或 run_terminal 来满足 wait。

（NOTIFY 增补，A1）事件白名单及 events.v1.1 的 wake.registered/revoked/delivered、retire.requested、surface.created、handoff.recorded 的字段/作用域统一引用 02「增量事件白名单」。D15 要求未知 kind opaque、读取不失败/不变更状态，未知 note→null，07 同次扩展封闭表；新 kind 不自动满足原 fixed-run wait 的 until。wake 是 hint，父端仍用自己的 fixed runId/afterSeq 读页至 hasMore=false；delivery 游标不是父端消费游标，不用 seq−1 回退或声称 exactly-once。

### status 与 HUD 可读投影

`terminalNote:'cancel_timing_unknown'|null` 随既有终态事件的白名单 payload 保存，status 对返回的那个 run 投影此说明。它不是 Reconciliation.cause，不生成待人工解除的阻断，不新增 runs 列。R-02-0 保留既有终态与原结束决定；迟到时序证据只追加说明/审计，不自动 ended→cancelled，不重新占槽或再次发完成事件。未知时序说明描述的是当时分类依据，不能被解释为已证明取消先后。

delegate_status(linkId) 在同一 ledger 读快照返回 link、最大已提交 run_seq 的 currentRun、runHandshake、latestReportForRun、terminalNote、reconciliation、interaction、带适用主体的 resumable+reason/allowedActions、asOfSeq；runId 形式固定历史 run 并给 isCurrent。statusProjection 的缓存观测来自06独立存储，附 observationStamp，不能声称与 ledger 跨库原子。asOfSeq 只指 ledger events 高水位；HUD 无 ledger 为 null，已打开且无事件的空库才为0。只读已提交事实，不触发采集、Git、恢复/reconcile 写；HUD 消费同一纯 B16 投影，不复制授权或归并算法。所有新时刻为毫秒 epoch，未知为 null/unknown，年龄以消费者 nowMs 计算。

`observationStamp={seqDomain,commitSeq,inputLedgerSeq,ref,runId?,bindingGeneration?,sourceGeneration}` 记录摘要生成时实际输入（纯原生 inputLedgerSeq 可 null），不能贴当前高水位冒充新摘要。组合先核对 ref、当前 run、绑定/来源代次；旧 run/不相容代次的当前观测 unavailable/stale 并给 reason，旧摘要只作历史，不能借旧 completed/failed、stateSince 或 cwd 补当前轮。无关 run 导致全局 seq 增长不使所有摘要失效，应比较相关实体身份/版本。即时结合 ledger 与缓存也只调用纯 B16、保留两套戳，连续性不足按06给 null/unknown；读路径不发布 summary。events.seq、commitSeq、NoticeEvent 各域 seq 不互比或混作 wait 游标（T-03-36）。

| 字段组（对应设计§7） | 数据层保证 / 来源 |
|---|---|
| link / runHandshake | link 的 state/label/role/backend/parent_ref/child_ref/current_owner/predecessor/closed_at/brief_path/task_digest；bound_by 来自已验证关系证据，capabilities 为当前 MCP 能力或 none。runHandshake 独立给 state+reason，由本 run binding/claim 推导，不另存 |
| currentRun / exit / logs | runId/run_seq/mode/supervision_strategy/state/launch_phase/locator/started_at/ended_at/cancel_requested_at/isCurrent；heartbeat={at,quality}，ageMs 可派生。exit={code,signal,source,reason,coverage} 仅原生 harness 结果，未知 null；shell_status/shell_signal 单列来源，正常 scope ended 不要求 code。日志路径/捕获覆盖由04 |
| terminalNote | `cancel_timing_unknown` 或 null，读取所返回 run 的既有终态事件白名单 payload；说明当时取消分类依据的缺口，不是 reconciliation.cause，不阻断新操作、不新增 runs 列。R-02-0 保留原分类/说明，迟到时序仅审计，不自动改 cancelled、不重占槽或再次报完成 |
| latestReportForRun / reportHistory | {status,summary,path,created_at,report_id} 只取指定 run；历史按 run 分页给 count 与最近一条，不拿旧轮 completed 补新轮。索引/读取预算归06 |
| statusProjection | 06/B16 唯一提供 activity/pendingReason/lastTurnOutcome/liveness、`freshness.state` 与来源明细、stateKey/stateSince/stateSinceBasis、共享运行终态谓词 `isRunTerminal`；带 ledger-only asOfSeq、独立 observationStamp、asOf/observedAt/lastEvidenceAt、stale时lastKnownActivity。状态驻留与证据年龄分开，连续性随ObservationCommit发布；03只引用，不从events最大时间重建 |
| conflict / candidates | 明确 conflict={count,recordIds[],since}，由未解决冲突及证据投影，不能只吞成 unknown；候选含证据种类、asOf/observedAt，独立于确定父边，不读候选正文。普通未知不是 conflict |
| host / parent | host.occupantMatches=true/false/null、locator valid/stale/unknown 与核验时刻；不匹配不供当前宿主状态/控制。父 harness/名称/liveness、经验证 pane label 或 null，未确认时 caller 短形只诊断。parent.offline 的 since/seq 与冻结 orphan_policy 来自04，不推子结束 |
| reconciliation / resumable | uncertain 给 cause、evidenceIds[]、missing[]、observedAt、类型化允许入口 ActionDescriptor；cause 从02采用的证据/原因派生，至少区分 supervisor_dead、scope_unknown、resume_ref_mismatch、clock_anomaly，也可为 supervisor_stale/submission_unknown/cancel_unconfirmed/identity_conflict/scope_conflict/provisional_conflict/launch_timeout/unknown；缺证不伪造终态。统一门禁投影 resumable:boolean+reason+subject（mcp 当前父owner或local_user）；未知身份/owner、busy/uncertain、冲突、能力未验、任务不符均false；closed为false/deferred。执行控制时仍重新鉴权/重验槽 |
| interaction / parentOffline | interaction={focus:boolean,input:boolean,resume:boolean}，按已知能力/occupant/前台可交互性和统一门禁派生，未知为false。uncertain/未决冲突，尤其 supervisor_dead，三项均false；resume还须resumable=true。parentOffline={since,seq,orphanPolicy}或null由parent.offline事件投影，和reconciliation.cause为独立字段；父MCP离线continue本身不禁用仍经核验可用的子交互。不新增持久状态，HUD不从心跳重建这些判断 |
| tree / notices | 显示身份按06的 session(ref) / delegationIntent(linkId) / 未来job(ref)联合类型；未绑定意图以linkId稳定键关联currentRun，不伪造ref、不计已确认session；绑定后B9合并并保留选择映射。≤200 节点、无环/重复 ref，depth 明确，handed_over 只历史不成第二父边；超预算 loaded=false，coverage/Metric归06。report.received、run.uncertain、conflict/解决、parent.offline等账本事件给seq/created_at/runId；观测通知由06/B16分域发布，HUD不为通知写ledger |

（consult 6 增补，H06）status/cancel 可加法提供 `cancelControl?:{intentAccepted:true,delivery:'unavailable',reason:'visible_scope_control_unavailable'}`，分开表示已接受意图、未交付信号和仍活的 run；缺此投影不推断已交付。当前 visible 禁 INT/TERM/KILL、单 PID/sendKeys 取消和无 ack 升级计时器；fresh/live 内部仍可 cancelling，（Pro 2026-11-02 增补）对外必须显示“仍在运行——自动取消不可用，请在其终端 pane 内停止”（Still running — automatic cancellation is unavailable. Stop this run in its terminal pane.），禁无限“Cancelling…”旋转提示，不暗示有活动取消/升级计时器。程序化visible取消MVP unsupported，启动前及能力检查披露；合法意图的控制结果cancel.unconfirmed/visible_scope_control_unavailable明确signal delivery not attempted，拒绝不使fresh/live变uncertain。不可用路径禁信号、单PID、终端输入/sendKeys、宿主销毁pane、升级timer/重试；重复幂等。之后按02独立scope证据对账，不把accepted画成已结束；结束无取消时序证明为ended+cancel_timing_unknown并释放容量。取消/父断连/截止/supervisor失效均无visible自动终止保证，需强制取消者不准入；监督丢失不自动输入/resume/relaunch/重获控制，controller资源仍有界。

（NOTIFY 增补，A2）上表 terminalNote 增加 retire_timing_unknown；`termination:Termination|null` 从返回 run 的终态事件白名单读取（02），不是报告 status/运行 state 的替代，也不改 R-02-0。

（NOTIFY 增补，A7）delegate_status 的加法投影：`advice` 为启动时已加载配置/来源快照的纯 lookup（harness/auth/model、configured/documented/planning TTL、provenance、warming:'off'|'native'、wake adapter/state/armCommand?；缺输入为 null，MVP lastQualifyingRequestStartAt/remainingWarmWindowMs 均 null，不猜缓存存活）；`wake.state='registered'|'degraded'|'unconfirmed'|'none'` 来自当前有效登记及交付结果；`capacity={active,limit,occupants}` 沿 02 容量计数；`termination` 沿 02；`continuesFrom` 从 handoff.recorded 投影为 candidate-grade provenance，绝不是 parent/predecessor 或所有权转移。只读且保留原 ledger/观测双戳/授权门禁；HUD warming 默认 off，pi 原生 warming 唯一，缺失配置不伪装实测。

03可提供上表关系/运行/报告字段；Metric quality、coverage/skipped、廉价变更信号与 statusline 入口预算归06。MVP 无 MCP 的正向能力、closed 重开和 Jev job 投影是 Oracle 明确延期的设计数据缺口，不能用占位 pass 填充。只读展示字段不授予控制/模型外发权限。

MVP 的 `R` 只显示并复制命令，不 spawn 控制 CLI。按钮/Inspector 共用下面的 `ActionDescriptor`；命令只从经验证的结构化目标和受信 CLI 模板安全引用生成，report/label/日志/任意字符串不是命令来源。Open/focus 仍按 interaction/occupant 门禁，不借其进程能力执行 resume/reconcile（T-03-34）：

```ts
type ActionDescriptor = {
  linkId: string; runId: string; reason: string;
  subject: 'local_user'; delivery: 'copy_only'; hudHome: string;
  displayCommand: string;
} & (
  | {operation:'resume'; expectedRun:string; mode:'visible'|'headless'; requestKey:string}
  | {operation:'reconcile'}
);
```

runId/expectedRun 固定为选定目标，状态改变不能替换操作/选另一 run。一次复制形成一份意图，同一待处理意图重复复制保留 requestKey；实际 resume 命令含安全引用的明确 HUD_HOME、linkId、`--request-key`、`--expected-run`、`--mode`。短命令只是缩写。本地入口未实现/未验证时不提供号称可用的裸命令，只给诊断及原父 delegate_resume 途径。reconcile 按 run+证据指纹幂等导入，不增加强制结束/清槽开关。

未来 HUD 直接调用另立可选能力：用户显式按键后确认界面固定显示操作/目标/模式，再确认；用可信 executable+argv，不执行 displayCommand shell 字符串。执行仍走原 writer/reconciler，重新鉴权并重验 owner/本地权限、当前目标、槽、能力、冲突与任务摘要；状态不符拒绝，不另选 run。resume 响应未知只查/重放同 key，不生成新 key 自动重试。绘制、通知、重连、进入 uncertain 或定时器都不得触发这些 HUD 动作；04 已批准的写者内部恢复触发保持。

运行终态只由02的 ended/failed/cancelled 经06共享 `isRunTerminal` 判定；run.failed 为 non_execution，B16 分类 `launch_failed` 带原因，不能伪造 lastTurnOutcome=failed。completed/failed 报告、失败图标、cancelling 都不单独构成运行终态；历史折叠/时钟不能按图标判结束（T-03-35）。


### wait 游标与 runId 固定

输入 `{linkId | runId, afterSeq=0, until=['report','run_terminal','uncertain'], timeoutMs≤120000}` 恰有一个定位键；afterSeq 为非负安全整数，until 为上述枚举子集，非法输入拒绝。实际 effectiveWaitMs 依05取请求值/协议上限/已验证客户端工具超时减正余量的最小值；无可信 timeout 或余量耗尽只返回即时一页与 timeout_configuration_unverified，不挂起。进入时同一只读事务完成读取授权、link→最大已提交 run_seq 的解析和固定 runId；没有 run 返回 no_run，不悬挂等下一轮。历史 link 的原 owner 可以读自己那条历史，不因 handover 获新关系读取/控制权限（T-03-14）。

每轮读取在单一快照取 highWaterSeq、`events WHERE run_id=fixedRunId AND seq>afterSeq AND seq≤highWaterSeq ORDER BY seq`（最多 200 条）以及该 run 的状态/报告；其他 run、仅 link_id 相同而 run_id=NULL 的事件不满足 until。返回 `{runId, events, nextSeq, matched, timedOut, current, hasMore, asOfSeq}`。nextSeq 是实际返回的最后 seq，无事件即原 afterSeq。matched独立于hasMore计算：请求的run_terminal/uncertain按固定run的快照状态匹配，report仅按本页实际返回的有效report.received事件匹配，拒绝报告不算。已有匹配即matched=true，包括hasMore=true的页面；本页无匹配才可用matched=false提前返回分页。报告尚在下一页时保留hasMore与正确nextSeq，不能越过或消费匹配却报false；已终态/uncertain可立即匹配（T-03-15、16）。

无匹配时有界等待（长轮询是接口语义，不是每秒查库/扫进程）：在现有进程内用相关提交通知/文件事件唤醒并合并重复提示；入口、相关事件、必要的 stale/超时截止与返回前读快照，漏提示最多延后到截止复读，不丢持久事件。通知仅提示、持久游标是事实；heartbeat/WAL 变化须合并与按相关 run 过滤，不能每次心跳唤醒所有 waiter 全量重查。漏提示在有界截止复读。不新增通知服务或后台扫描器。已有hud-mcp可在本run的stale截止复核最新心跳，真失联才触发独立reconciler入口；wait超时本身不触发迁移。无新事件超时返回相同游标、当时状态、timedOut=true，wait零写入。等待期间新 run、旧轮迟报或父 pane hint 都不改固定 runId。断开后用返回 runId/nextSeq 续等，不能再次用 linkId 无意跳到新轮；hint 只提示，漏提示/重复提示不影响持久事件（T-03-17、33）。

### resume 与 handover 事务

每 run 的 operation 接受时固定：首次全新会话 spawn、同 link 新轮 resume、predecessor 新任务 link 的首轮 handover；该 handover link 后续仍是 resume。07 原样导出 operation，当前关系与原始启动历史、transcript 用量归属分别判断，不按当前 owner 搬迁旧用量。

resume 在 02 的 OwnerKey×request_key 幂等查找之后，事务先拒绝 pending close，再校验全部 I-03-5；验证首轮 task identity、该 backend/source 的受支持 resume 模板与模式。通过才为同一 link 分配新 run_seq/runId/expected_generation、撤销旧 claim/current child_binding、写本轮 call/correlation 锚点（原生消息ID可晚到）并占实际槽。MVP closed 重开 unsupported；活跃 headless 不能通过“打开”隐式启动可见副本。

（consult 5 增补，G03）MCP `delegate_resume` 接受可选 expectedRun?:RunId，实际提供才纳入 02 params_digest；缺省保持旧 params_version=1 编码并由事务取 currentRun。先校验本次当前权限及已捕获来源前提，再查 OwnerKey×request_key；同参重放先于新意图 expectedRun、槽与能力门禁，不能因后来 currentRun 改变拒绝原结果。仅无记录时比较 supplied expectedRun 与事务内 currentRun，不符 expected_run_mismatch，零新 run/claim/slot/外部提交；本地仍必填。缺省不授权重用过时 preparation：runSeq、目标 ref、绑定代次、档案前提仍须重验，沿用 A4 resumeGate/prepareResume，不另建状态机。B13 基于 status/wait 决定续跑时默认携带所见 runId；mismatch 必须重读并重新决定，禁止自动换 key/expectedRun 连续重试。

本地管理 resume 仅按01的 ControlInitiator/local_user 例外代表已登记 parent_ref 的逻辑 owner，不换 parent/link 归属。先鉴别管理主体、派生 canonical owner、查02幂等，同键同参先重放；新意图才校验 `--expected-run` 仍等于 currentRun，及 current_owner、bound/reported、同任务、真实 child、空槽、无冲突、受支持档案/模式等全部条件。逐 run 固定 launch_cwd/project_origin，新 claim/代次与相同意图事务不变；accepted审计记录actor.kind=local_user/UID/invocation/representedOwner。票据登记/提交按该类型重验，不使用已离线父 context 冒充 MCP；launch_call_id标本地来源（T-03-37）。

同 owner handover 复用的是 child SessionRef，新建任务 link/run；旧 link 当前、槽空/无冲突、无自环/祖先环，图预算耗尽即拒绝。事务外读取材料、事务内重验，旧 link handed_over/current_owner=0、撤销旧 claim/binding，新 link bound/current_owner=1、新 run/claim/真实槽/幂等/事件同事务；失败整体回滚。接受后外部启动失败不撤销历史转交，新 run 按02取证，不重发（T-03-18、19）。

### Deferred（v1.1 / C 前）与历史兼容

跨 owner grant（含 handover_grants）、owner_epoch 与 close surface 可恢复事务整体 v1.1；跨 owner 仍无签发/消费入口；E4 仅例外支持已确认 current-owned headless 关系的 authenticated-parent MCP close。visible/local-manager close 与重开仍 unsupported；不把关 pane 当 close 完成。无 MCP 的 observe_only 三证正向绑定同样延期 v1.1，MVP 未确认、不 report/猜 resume，run 仍可独立终结。Jev job/浏览器租约实现与正向测试在 C 前定，三类资源释放语义只引用02；不在此冻结额外协议。

HUD只读关系/运行/报告与上述投影；uncertain提供缺证及对账入口，不把 UI done 当 ended，不按按钮补退出结果。活跃 headless 只提供日志能力，监督故障的可见运行禁 input/focus/fg/自动恢复/resume。控制交受信入口重验，模型材料与外发仍经07的来源授权。


## 失败案例

| 编号 | 合成场景 / 预期 | 不变量 | 测试 |
|---|---|---|---|
| F-03-1 | report completed 或 UI done 但组仍活 → reported 可成立，run 仍 active/槽持有 | I-03-1、2 | T-03-2、3 |
| F-03-2 | resume 错 owner、busy/uncertain、任务/source错或请求重开closed → 拒绝，无新run，历史保留 | I-03-3、5、12 | T-03-5–7 |
| F-03-3 | resume/handover 的本轮解析到 fork/new id → 不改 child_ref，run uncertain、候选 | I-03-4 | T-03-8、9 |
| F-03-4 | 旧撤销绑定迟报、无MCP或来源不可辨 → 拒绝/旧轮审计，不影响新轮 | I-03-6 | T-03-10–12 |
| F-03-5 | wait 中追加新 run、分页或超时 → 固定 run，游标不跳未返回事件，零状态写 | I-03-7 | T-03-14–17 |
| F-03-6 | 并发 predecessor、历史前驱、环、忙槽 → 单一原子转交或拒绝，旧历史不成第二父 | I-03-8、10 | T-03-18、19 |
| F-03-7 | 非owner知道linkId/claim、自报跨owner凭证 → unsupported，无新权限/意图 | I-03-9 | T-03-20 |
| F-03-9 | 非 E4 合格 close 请求或把关pane当closed/放槽 → unsupported/拒绝迁移；E4 只按02独立证据完成，历史保留 | I-03-11、12 | T-03-26、30 |
| F-03-10 | revoked run 仍活、活跃 headless 打开、历史关系复活 → 不放槽、不起可见副本、不写 ledger | I-03-2、12、13 | T-03-4、30、31 |
| F-03-11 | 要求调用者手写登记/续租/宿主命令、wait按秒查全库/扫proc → 违反低摩擦/预算；由现有写者按事件自动推进 | I-03-14 | T-03-32、33 |

## 测试清单

每项标 A9 fixture（规格/合成输入）、A9 prototype（最小真实 SQLite/合成进程）或 B（生产实现验收），均为待验断言。B4/B5/B6/B14 在实现后重复关键反例；A9 不要求先完成这些生产实现。延期正向用例已移出。

| 编号 | 输入 → 预期状态断言 |
|---|---|
| T-03-1 (A9 fixture) | 新 spawn/claim/独立证据 → link pending/claimed/bound；无 MCP 即使三证齐仍未确认，无绑定父边；run 无pending枚举 |
| T-03-2 (A9 fixture) | 当前 run 提交四种 report status，组仍活 → link reported，报告只写该 run；零槽释放/伪造终态；（consult 6 增补，H12）blocked→needs_human/pending:blocked，独立失败 outcome 保留，零 run 终态/槽/权限变化 |
| T-03-3 (A9 fixture) | fresh 未绑定首轮 N，已绑定后续轮 N，非零 R 三组 → link.failed/run.failed；link仍bound/run.failed；link保持/run.ended(code非零)，均不把任务结果当执行事实 |
| T-03-4 (A9 fixture) | 身份冲突使 link revoked，但组 alive → 历史保留/当前边撤销，run uncertain或按02继续对账，槽不释放，无新授权 |
| T-03-5 (A9 fixture) | bound/reported 同任务合法 resume → 同link、新run_seq/run/claim/correlation，link bound、run starting/握手pending，旧claim/binding撤销 |
| T-03-6 (A9 fixture) | closed 请求 resume → unsupported/resumable=false,deferred；合格父 close 新键为 already_closed、原键原样重放，零新run/surface操作，保留历史 |
| T-03-7 (A9 fixture) | brief path相同但内容hash变、换任务/role/source、仅追加prompt四组 → 前三组task_mismatch或要求新link，追加prompt可合法resume |
| T-03-8 (A9 fixture) | resume已记录child-a，新握手解析child-b（含pi新文件无连续性/fork） → child_ref/target_ref仍a、run uncertain，b仅候选；SQL拒绝覆盖已知ref |
| T-03-9 (A9 fixture) | handover已知child-a，新轮解析b；另pi可信同ref续文件 → 前者冲突不改ref，后者正常本轮绑定，不能用文件名猜连续性 |
| T-03-10 (A9 fixture) | 当前MCP子/错子/错context或代次/无MCP报送 → 仅当前有效子接受；固定run/binding外键和seq |
| T-03-11 (A9 fixture) | 旧run报告先提交再resume，与resume先撤销旧binding再迟报两组 → 前者只在旧轮，后者report.rejected审计；新轮report空、握手pending不变 |
| T-03-12 (A9 fixture) | 旧轮重复report、历史closed/handed_over的迟报 → 不标新轮reported，不重开历史，不满足新run wait；按report_id/seq展示去重 |
| T-03-13 (B) | run active/uncertain、取消信号已发/心跳停/关pane/自报completed → 严格按R-02表，只有R/Q/N终结后释放槽 |
| T-03-14 (A9 fixture) | wait(linkId)读快照时currentRun=a，之后b出现；输入双定位键/无run/无读取权限 → 分别固定a/invalid/no_run/unauthorized |
| T-03-15 (A9 fixture) | 只有别的run或link-only事件、a旧报告、新run报告交错 → 仅fixedRun事件可返回/满足until，nextSeq只到实际返回项 |
| T-03-16 (A9 fixture) | 201条fixedRun事件，唯一report分别在第100/201条且until=report；另空页/已终态快照 → 第一组首页200且hasMore/matched均true；第二组首页matched=false、次页true；nextSeq只到实际返回项，空页同游标，终态不因hasMore变false |
| T-03-17 (A9 fixture) | 请求120000/120001，客户端timeout较短/缺失，断线续等、提示丢失/重复 → 非法协议参数拒绝；有效短等留余量或即时返回同run/游标；零ledger写/取消 |
| T-03-18 (B) | 同owner两key并发predecessor → 一个新bound/current_owner link及run/槽/幂等；旧handed_over，零双父；各写点失败全部回滚 |
| T-03-19 (A9 fixture) | busy/uncertain、历史前驱、环、图预算尽 → 全拒绝、不改owner；旧历史可读 |
| T-03-20 (A9 fixture) | 跨owner有/无自报凭证、非owner知道linkId/claim → unsupported，无签发/消费/新运行/控制权限 |
| T-03-26 (A9 fixture) | 非 E4 合格入口的 close 仍 unsupported；E4 当前父/已确认/headless/expectedRun 完整门禁接受，重放零写，独立证据后 closed；不关闭 surface，运行终结仍只按02 |
| T-03-30 (B) | 历史closed/revoked/handed_over和新occupant → 唯一当前父边，历史不复活；host未知、resumable=false+reason、候选/冲突显式，时间毫秒epoch |
| T-03-31 (B) | status同ledger读快照给link/runHandshake/currentRun/本轮报告及权限，缓存观测带独立stamp；B16时间/conflict、候选、parentOffline、uncertain cause/缺证/ActionDescriptor、resumable+reason+subject/interaction完整；supervisor_dead三项交互均false，父离线continue不独自禁用正常子交互；HUD只读，≤200节点/无环/历史边不成双父；（NOTIFY 增补，A7）当前登记/交付结果、容量 occupants、独立 termination/continuesFrom/advice 只读投影，候选谱系零授权；（Pro 2026-11-02 增补）visible cancel接受意图但delivery unavailable/not attempted，status/wait/HUD一致显示still running/stop in pane、无无限cancelling；fresh/live非uncertain，之后充分R/Q释放、缺时序ended+cancel_timing_unknown |
| T-03-32 (B) | 正常仅spawn+wait → 自动运输/登记/托管/报告同run；spawn/resume/cancel快速返回持久accepted，started/bound另计；短锁等待/事务外I/O依06基准，不要求用户补协议 |
| T-03-33 (B) | 无事件、重复/漏通知、每心跳WAL、真正stale、短wait截止 → 合并/按run过滤、零全体waiter重查或按秒扫proc；现有写者仅真失联取证；通知seq/created_at与返回游标正确 |
| T-03-34 (A9 fixture) | 复制resume/reconcile、重复按键、选中后currentRun变化、恶意label/report命令文本 → 仅安全模板复制，固定目标/操作及同一requestKey，无HUD控制进程/自动重试；入口未验证只诊断/原父途径 |
| T-03-35 (A9 fixture) | 无报告且N成立的run.failed、failed报告但run.running、run.cancelling → launch_failed/non_execution且终态、任务失败但运行非终态、取消中仍非终态；不按图标折历史 |
| T-03-36 (A9 fixture) | ledger currentRun=b、观测commit仍a；另无关run提高high-water、无库/空库 → b事实+有原因的缺失观测，不混a报告/stateSince/cwd；无关seq不全失效，asOfSeq分别null/0，游标分域且零读路径写 |
| T-03-37 (A9 fixture) | local resume同键重放、旧expectedRun新key、MCP admin参数/父ref未确认、旧父context离线 → 按01/02先鉴别再重放；新意图拒旧目标/非例外；合法管理主体按typed权限重验，全部I-03-5不放宽；（consult 5 增补，G03）B45-R2 补 MCP 指定/缺省两支；旧键在新轮出现后重放，同键改 expectedRun 冲突；同旧 run 不同 key 竞争最多一轮，竞争轮已结束也拒旧 expectedRun，缺省兼容/local 必填；B13 mismatch 重读后重新决定，零自动换 key/目标重试 |

## 2026-11-05 owner-selected one-level creation boundary

HUD MCP creates only one level of new independent harness sessions. A managed
child's fresh new-session `delegate_spawn` is refused with
`nested_delegation_not_supported`; native harness subagents are not constrained.
This is a creation-depth restriction, not a new concurrency limit. Authorization
and immutable idempotency replay precede this guard. Existing-session
resume/handover, whoami/report and owner-scoped historical deep reads retain
their existing contracts and gates.

The server-captured presence of managed launch markers can only restrict;
it never grants caller identity. Once bound, a full SessionRef match in durable
run history remains restrictive across terminal/revoked state and restart.
Pre-bind protection assumes the supported launch's marker plumbing, not an
adversarial sandbox. See [implementation boundary and regression scope](../cloud/single-level-delegation.md).

### E4 close transitions and tests

`bound|reported → closed` requires the frozen current run/sequence/generation/full
SessionRef and owner to remain unchanged, validated terminal evidence, submission
fence, no actual-target/run slot, and no unresolved conflict. Durable close.requested
is the pending fence, not a new link/run state. Handover checks the predecessor fence
after immutable replay. Status/list/wait report pending/closed/incompatible progress
and never reconcile. Closed links never reopen through binding, observation or
late reports; restrictive child history still forbids nested creation.

T-03-E4 covers active acceptance, terminal R/Q/N, cancellation chronology, immutable
replay before/after closed, stale authority, exact target/generation, visible and
unconfirmed refusal, resume/handover transaction races, unknown cleanup, revoked
relation, rollback/recovery, late reports, budget semantics and strict MCP fields.
The finite matrix and closed event schemas are specified in
[E4-HEADLESS-CLOSE](../cloud/E4-HEADLESS-CLOSE.md) and contract02.
