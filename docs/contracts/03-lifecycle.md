# 03：关系、运行、报告与转交生命周期

- 版本：`v0.1 draft`（2026-11-01）。
- 状态：A1 第二批草案，待主审与四契约一致性确认；A9 前不作为阶段 B 的冻结基线。
- depends-on：[01 身份](./01-identity.md)、[02 执行协议](./02-execution.md)、[04 托管](./04-supervision.md)；[概念方案](../universal-hud-concept.md) §6.6、§6.10–11、§15–16；[工程计划](../universal-hud-engineering-plan.md) A1/B3a/B3b/B4/B6。
- 开放项：甲暂定，**待 A8 第二轮**，shell receipt不能终结harness组；[A3](../probes/codex-mcp-launch.md)、[cc](../probes/cc-mcp-env.md)、[Herdr](../probes/herdr-env.md)、[pi](../probes/pi-resume.md)、[双home](../probes/codex-dual-home.md)仍作初步证据：Codex metadata trust unverified、daemon-present未测，Herdr仅Codex tab-root/pi split。跨所有者凭证内部协议定型，公开grant/revoke、spawn参数与delegate_close留v1.1，MVP跨owner unsupported。

本文只规定可验证的记录与权限，不保证外部任务一定执行或完成。账本写者仅 hud-mcp、hud-run、reconciler；所有身份/关系/运行迁移走 reconciler 事务入口。HUD 读已提交账本，消费 B16 的五维状态结果，不自判完成，不写账本。

正确性与轻量同级（概念§2 G13/G14）：正常调用者只需一次delegate_spawn与delegate_wait；登记、握手材料运输、托管、事件对账由实现完成，不要求手写宿主配方、轮询status、续租或手动释放槽。uncertain明确返回缺失证据，不能用更多手工启动步骤绕过。hud-mcp随harness起停，共享分支仍受01能力门约束，不为它新建全局服务；hud-run只覆盖本轮活跃执行/收尾，历史行不要求存活进程。性能预算由06拥有，初始目标为非wait MCP p95<50ms、hud-mcp冷启动<200ms、hud-run空闲CPU≈0且每心跳间隔一次账本写、HUD增量tick<50ms；本批未测得这些数值（T-03-32、33；04 T-04-38、39）。HUD契约只提供只读字段、状态与能力门；信息展示和视觉方案归后续Fable设计agent。

裁决追溯：下列均标为**编排者裁决**，不是冻结的架构前提；按概念§15对应行送Oracle（Codex gpt-6-astra、effort max，一次性ARCH咨询）复核，Pro仅关键里程碑/A9。后续若出现跨契约/不变量/范围分叉，保留默认与选项、标“待 ARCH 裁决”并发一行QUESTION，不等待人工设计答复。

| 编排者裁决 | 概念§15对应行（以行首文字定位） | 本文依赖 |
|---|---|---|
| provisional仅首次新会话、解析冲突双方uncertain | 「首次 spawn 尚无子 SessionRef 时」 | 01/02槽门禁、I-03-2、5 |
| bound证据后单向proc→session alias，同代唯一/换代关闭 | 「未绑定父的 OwnerKey」 | 01身份与02幂等、close的意图parent鉴权 |
| 无MCP三证齐才observe_only bound | 「无 hud-mcp 的子」 | I-03-6，observe_only无report能力 |
| 同owner predecessor；跨owner凭证前unsupported | 「`predecessor` 转交只在调用者 OwnerKey」 | I-03-8–10 |
| CallerId下统一caller_contexts，shared仅可信逐调用源 | 「调用者身份拆为物理 `CallerId`」 | I-03-5、6，MCP重启/失效隔离 |
| 默认核验harness PGID、可选cgroup、shell退出不够 | 「受管范围默认」 | I-03-2、11；04范围与回执 |
| 跨owner opaque/hash-only/单次凭证，公开入口v1.1 | 「跨所有者转交凭证」 | 内部接口/DDL、I-03-9、10 |
| 关系不因resume回pending，runHandshake独立、child_ref不变、closed重开有门禁 | 「关系状态只表达已证实的父子身份」独立行，来源标待Oracle复核 | I-03-3、4、12；保留已确认编排者裁决，等待ARCH复核 |

## 数据模型

| 对象 | 字段、身份及本契约的含义 |
|---|---|
| Link | link_id、state、parent_caller/context/generation、parent_ref、child_ref、current_owner、owner_epoch、brief_path/task_digest、predecessor。OwnerKey按01派生；缺ref仅合法dedicated proc scope，不凭linkId自授权限 |
| Run | run_id、link_id、run_seq、target_session_ref、expected_generation、mode、state、claim、locator、scope。一个 link 可有多轮；currentRun 是最大已提交 run_seq，不能用最新 mtime/报告时间选择 |
| runHandshake | 由该 run 的 claim/child_bindings 推导的 pending / claimed / bound；不是 runs.state 的值，也不另造关系。pending=尚无合格声明/绑定，claimed=有有效声明但尚未独立证实，bound=本轮当前有效 mcp/observe_only 绑定。已撤销/过期另带 reason，不授予权限 |
| Report | report_id、固定 run_id/link_id、child_binding_id、caller/context/generation、status、summary、绝对 path、created_at。status 仅 completed/failed/blocked/interrupted，是子自报结果，不是退出回执 |
| CloseIntent | links.close_request_id/close_requested_at/close_run_id 固定本次关闭及目标 run；进度和 surface 结果记 events。closed_at 只表示本次关闭已完成；重开清当前字段，历史由事件保留 |
| HandoverGrant | 内部凭证：随机 256-bit nonce，只存 credential_hash；绑定旧 link/child_ref、issuer OwnerKey、owner_epoch、target session OwnerKey、签发 context、issued_at/expires_at；issued/consumed/revoked，消费固定 successor link/run。字段见 02 的 handover_grants |

首次意图持久写 `links.task_digest=SHA256(canonicalJSON([brief_path, brief_content_hash, backend, source_id, role]))`，canonicalJSON沿用02规则，不试图从params_digest反解。resume重读brief并计算同一tuple比较task_digest；补充仅本轮prompt，mode/model/effort不在任务判据中但仍进每轮params_digest。改任务用predecessor新link；同路径不同内容返回task_mismatch，不用模型猜同任务（T-03-7）。

OwnerKey 是稳定逻辑身份，不是物理 MCP 或 context_id。context 的当前性/代次校验仍逐调用执行；shared 缺可信来源无权选 context。owner_epoch 是 link 的授权版本，初始 1；handover、撤销关系及接受 close 时递增，使旧凭证失效。普通同任务 resume 不变更所有者，保留该 epoch；MCP 重启本身不换 owner。字段历史与已签发凭证不级联删除。

## 不变量

`DB` 为 02 键/约束的结构保证；`TX` 为写者事务；`E` 为真实进程/探针证据。

| 编号 | 可检查断言 | 层 / 测试 |
|---|---|---|
| I-03-1 | Link、run、report 三种身份分开；每个接受的运行有唯一 run_seq，报告/事件不能重指到下一轮。关系终态不替代运行终态 | DB+TX；T-03-1、2、10 |
| I-03-2 | 运行迁移仅用 02 的 R-02 表；report、关 pane、父退出、心跳过期都不能自行释放槽；uncertain 仍占实际或 provisional 槽 | TX+E；T-03-3、4、13 |
| I-03-3 | 关系已证实后 resume 不回退 pending：bound/reported/closed→bound，新 run starting 且 runHandshake=pending；旧 close/报告历史保留 | TX；T-03-5、6 |
| I-03-4 | resume/handover 新握手只能绑定既有 child_ref；解析成别的 ref 不改 links.child_ref/runs.target_session_ref，run uncertain、最多候选；同 SessionRef 的可信文件连续性不能由路径猜测 | DB+TX；T-03-8、9；01 T-01-37 |
| I-03-5 | resume 必须 current_owner、合法 link state、同任务、正确 owner、真实 child_ref、槽空闲、无未决冲突/关闭；旧 claim/binding 撤销，新 run/claim/绑定代次与本轮消息独立 | TX；T-03-5–9 |
| I-03-6 | delegate_report 只接受该 run 当前有效 mcp binding/context/generation；observe_only、旧撤销绑定不授权；旧轮报告/拒绝事件永不改变新 run、满足新 wait 或将新一轮标 reported | DB+TX；T-03-10–12 |
| I-03-7 | wait 入场原子解析并固定 runId，按该 run 的已提交 seq 读取；游标只到实际返回的最后事件；超时不写状态，不因新 run/其他 link 事件返回成功 | DB+TX；T-03-14–17 |
| I-03-8 | predecessor 是同一个实际 child 的转交：旧 link handed_over/current_owner=0、新 link bound/current_owner=1、新 run starting 在一个意图事务；唯一当前父边，旧 link 只保留历史，无环 | DB+TX；T-03-18、19、25 |
| I-03-9 | MVP 跨 owner unsupported；v1.1 内部凭证仅由当前已绑定旧 owner 显式签发，绑定 link/child/owner_epoch/target OwnerKey/expiry；知道 linkId、claim 或自报字段不能签发/伪造 | DB+TX；T-03-20、21 |
| I-03-10 | 凭证校验、单次消费、owner 转交、run/slot/幂等记录/事件同事务；并发仅一消费；同 request_key 重放原结果，换 key 重放已消费凭证拒绝；撤销/过期/epoch 变化均拒绝 | DB+TX；T-03-22–25 |
| I-03-11 | close 经当前边owner或未绑定意图的parent OwnerKey鉴权，固定目标 run，先保存报告/日志结果、确认运行结束，再校验 occupant 并关 surface，最后 closed；未确认退出/关闭失败只保留 close intent 与 cancelling/uncertain，不假关闭、不放槽 | TX+E；T-03-26–29 |
| I-03-12 | closed 仍保留当前逻辑父边与历史，可经完整 resume 门禁重开；failed/revoked/handed_over 不 resume；旧 locator 与新 occupant 不匹配时不展示/操作当前宿主 | TX；T-03-6、19、29、30 |
| I-03-13 | HUD 仅投影已提交关系/运行/报告与 B16 状态，历史边不当第二父边；活跃 headless 只看日志，结束后才可请求有权限的 resume | TX；T-03-30、31 |
| I-03-14 | 正常路径spawn+wait完成委派；有界wait按事件/必要截止唤醒，status读索引快照，不全量扫描/按秒轮询/要求调用者手工驱动协议；预算归06 | TX+E；T-03-32、33 |

## 状态机

### Link 与本轮握手

所有迁移附 link_id、触发 run_id（如有）、owner_epoch、采用证据/报告/操作 ID 的事件。未列状态迁移拒绝并记录原因；不是状态枚举里任意两值都可互转。

| 起点 → 终点 | 前置条件与动作 | 测试 |
|---|---|---|
| 无→pending | 02 新会话首次 spawn 意图事务；身份尚未证实，不能画确定 child 父边 | T-03-1 |
| pending→claimed→bound | 01 的 claim 与独立证据门禁；无 MCP 仅 01 三证 observe_only 例外可 pending→bound | T-03-1、11 |
| bound→reported；reported→reported | 当前 run 的有效子报告被接受；report 与 link.reported 事件同事务。任何 status 都只表示“收到报告”，运行仍可 active/uncertain | T-03-2、10 |
| bound/reported/closed→bound | 同任务 resume 满足 I-03-5；新 run starting、握手 pending；清当前 closed_at/close intent 字段，事件保存 previous_closed_at。不会凭关系 bound 授予新 run report 权限 | T-03-5–8 |
| pending/claimed→failed | 首轮run由02证明未执行、从未有child_ref/当前父边且无待完成close intent；撤销claim。若close在途则关系保持待关闭直到closed，run仍failed。已绑定关系某轮run.failed不使link.failed | T-03-3、26 |
| pending/claimed/bound/reported/closed→revoked | reconciler证实身份/授权冲突或旧owner显式撤销；清当前边、递增epoch、撤销权限/grant，保留ref/历史。close在途则记close.aborted并清intent，不把revoked改closed；已接受的取消仍可收尾，run不因此终结/放槽 | T-03-4、28、30 |
| pending/claimed/bound/reported→closed | I-03-11 的 close intent 完成：固定 run 已确认终结、surface 已确证关闭/原对象不存在；没有 child_ref 也可关闭，但不伪造绑定 | T-03-26、27 |
| closed→closed | 重复相同关闭请求只返回原结果；不再关已经换 occupant 的 pane | T-03-28、29 |
| bound/reported/closed→handed_over | 旧 link 为 current_owner、实际槽空闲、无 close/冲突；同 owner 或 v1.1 已验证 grant。旧 epoch+1；新 link 对已知 child 直接 bound、独立 run starting、握手 pending；旧 closed_at 如有移入事件历史 | T-03-18–25 |
| failed/revoked/handed_over→原状态 | 只读历史；不能恢复控制/再次当 predecessor。旧 owner 只能读该历史 link/run，不因此获新 link 控制权 | T-03-19、30 |

revoked 运行的安全收尾仍可由接受时的 orphan_policy/已鉴权取消意图或受信本地 `hud run cancel` 管理入口执行；这只控制旧 RunHandle，不授予父子身份或新执行权。普通 MCP parent 操作若无当前 owner 授权必须拒绝，不能把“历史曾是 owner”当任意取消权限。

### Run 状态与合法组合

Run 只有 starting/running/cancelling/uncertain/ended/failed/cancelled；迁移完全引用 I-02-5–9 和 R-02-0–9，不另设一套完成规则。normal starting→running 需要已启动证据、H 与 G；starting/running/cancelling 可进入 uncertain；uncertain 只有 R/Q/N/恢复同一实例的 H+G 等对应行才能退出。取消接受先 cancelling，只有 R/Q 才 cancelled；非零退出仍 ended，任务失败投影另记（T-03-3、13）。

| Link 状态 | 可以并存的 run / 握手事实 | HUD可读关系字段/状态 |
|---|---|---|
| pending/claimed | run 可 starting/running/uncertain/cancelling，甚至已结束但身份仍缺；不能以 run alive 自动 bound | “父/子未确认”，候选分开 |
| bound/reported | run 可 active/终态；resume 后握手 pending；reported 不证明该 run 退出 | 确定当前父边；当前轮报告与历史分开 |
| closed | close_run 必须终态、无该 run 槽；保留 ref/current_owner。重开前不得有新 active run | 历史节点保留，可请求完整鉴权 resume |
| failed | 首次未执行且未绑定；无活跃槽 | 失败意图历史，不显示臆测 child |
| revoked | 可能仍有 active/uncertain run 与槽，必须独立对账 | 身份/权限失效，历史保留，不借机重新归属 |
| handed_over | 转交前旧会话槽须空，旧 link 不再追加 run；新 link 有自己的当前 run | 历史predecessor/current_owner=0，不能当第二父边 |

### 报告与 status

delegate_report 的 runId 先定位原 link，不能从 caller 的“当前 link”或最大 run_seq 改写它。事务内重验物理 caller、context 当前代次、本 run 当前 mcp child_binding、SessionRef/expected_generation，绑定撤销或 observe_only 返回 unauthorized/stale_binding。每个接受的调用生成独立 report_id 与 report.received 事件；本契约不宣称 report 重试去重，消费者按 report_id/seq 去重展示。同一当前轮收到多份报告取其最大已提交 seq，状态 completed/failed/blocked/interrupted 不覆盖进程退出事实（T-03-10–12）。

旧轮报告若在其绑定尚有效时先于 resume 事务提交，只写旧 run；resume 后当前摘要按新 run 查询。已撤销旧绑定的迟报拒绝，只记 report.rejected 审计事件，run_id 仍是旧轮，不伪造成合法历史提交。即使报告在旧轮获准，link.reported 的更新也须确认它仍是 currentRun；closed/revoked/handed_over 绝不由迟报重开。

delegate_status(linkId) 返回同一读快照里的 `{link, currentRun, runHandshake, latestReportForRun, heartbeat, reconciliation, statusProjection, asOfSeq}`；runId 形式返回被固定的历史 run，另标 isCurrent。latestReportForRun 只取该 run，不拿旧轮 completed 填新轮空白。statusProjection 是 B16 的 activity/pendingReason/lastTurnOutcome/liveness/freshness；取不到用 unknown/null，不在 B6 或 HUD 复制归并算法。

### wait 游标与 runId 固定

输入 `{linkId | runId, afterSeq=0, until=['report','run_terminal','uncertain'], timeoutMs≤120000}` 恰有一个定位键；afterSeq 为非负安全整数，until 为上述枚举子集，非法输入拒绝。进入时同一只读事务完成读取授权、link→最大已提交 run_seq 的解析和固定 runId；没有 run 返回 no_run，不悬挂等下一轮。历史 link 的原 owner 可以读自己那条历史，不因 handover 获新关系读取/控制权限（T-03-14）。

每轮读取在单一快照取 highWaterSeq、`events WHERE run_id=fixedRunId AND seq>afterSeq AND seq≤highWaterSeq ORDER BY seq`（最多 200 条）以及该 run 的状态/报告；其他 run、仅 link_id 相同而 run_id=NULL 的事件不满足 until。返回 `{runId, events, nextSeq, matched, timedOut, current, hasMore, asOfSeq}`。nextSeq 是实际返回的最后 seq，无事件即原 afterSeq。matched独立于hasMore计算：请求的run_terminal/uncertain按固定run的快照状态匹配，report仅按本页实际返回的有效report.received事件匹配，拒绝报告不算。已有匹配即matched=true，包括hasMore=true的页面；本页无匹配才可用matched=false提前返回分页。报告尚在下一页时保留hasMore与正确nextSeq，不能越过或消费匹配却报false；已终态/uncertain可立即匹配（T-03-15、16）。

无匹配时有界等待（长轮询是接口语义，不是每秒查库/扫进程）：在现有进程内用相关提交通知/文件事件唤醒并合并重复提示；入口、相关事件、必要的stale截止与返回前读快照，漏提示最多延后到截止复读，不丢持久事件。不新增通知服务或后台扫描器。已有hud-mcp可在本run的stale截止复核最新心跳，真失联才触发独立reconciler入口；wait超时本身不触发迁移。无新事件超时返回相同游标、当时状态、timedOut=true，wait零写入。等待期间新 run、旧轮迟报或父 pane hint 都不改固定 runId。断开后用返回 runId/nextSeq 续等，不能再次用 linkId 无意跳到新轮；hint 只提示，漏提示/重复提示不影响持久事件（T-03-17、33）。

### resume 与 handover 事务

resume 在 02 的 OwnerKey×request_key 幂等查找之后，事务校验全部 I-03-5；验证首轮 task identity、该 backend/source 的受支持 resume 模板与模式。通过才为同一 link 分配新 run_seq/runId/expected_generation、撤销旧 claim/current child_binding、写本轮消息/call 锚点并占实际槽。closed→bound 同样不能跳过 owner 或槽门禁；活跃 headless 不能通过“打开”隐式启动可见副本。

同 owner handover 复用的是 child SessionRef，新建的是任务 link/run；旧 link 必须当前、没有槽/close/冲突且图检查无自环/祖先环，预算用完拒绝而不猜。在同一 BEGIN IMMEDIATE 中旧 link 设 handed_over/current_owner=0/epoch+1，撤销旧凭证/绑定，新 link bound/current_owner=1/owner_epoch=1，新 run starting、独立 claim、占真实槽、幂等结果与事件全部提交；失败全部回滚，不能旧 owner 消失而新意图不存在。启动失败也不回滚已提交转交，新关系仍 bound，其 run 按 02 对账（T-03-18、19）。

### 跨所有者凭证：内部接口，公开入口留 v1.1

以下接口不是新增 MVP MCP 工具；MVP 遇到跨 owner，哪怕有自报凭证也返回 unsupported、零消费、零启动。v1.1 能力开关与公开入口未实现/未验证前同样如此。nonce 在受信同用户文件权限与写者边界内防止 API 参数伪造/复制重放，不宣称能抵御修改 ledger 的本地同权限恶意进程。

| 内部操作 | 前置条件与持久结果 | 测试 |
|---|---|---|
| issueHandoverGrant | 旧 owner 当前 context 已绑定为 session OwnerKey，与 link 的当前 owner 相同；link 为 bound/reported/closed、有实际 child、无 close/冲突。目标也必须是完整 session OwnerKey，不能是 caller_id/proc scope/通配符或自身。旧 owner 显式给出 expires_at，满足 now<expiry≤now+30分钟；nonce 用 CSPRNG 32 bytes，base64url 无 padding 运输，只存 SHA-256。记录签发 context、owner_epoch、link/child/target/时间与事件 | T-03-20、21 |
| revokeHandoverGrant | 当前已鉴权 issuer OwnerKey 与 grant issuer 相符，且 grant 尚 issued；原子写 revoked/revoked_at 和事件。已消费只能 already_consumed，不能撤回新 owner；过期不删除历史 | T-03-23 |
| verifyAndConsumeHandoverGrant | 只在 v1.1 handover 意图事务中调用：内部解码 nonce→hash 查已签发记录，不采信请求中的 issuer/epoch/child 字段；目标 caller 当前 OwnerKey=target，旧 link owner/epoch/child 仍匹配、now<expiry、状态 issued、无槽/close/冲突/环。CAS issued→consumed 与旧新关系/run/slot/幂等/事件同事务，固定 consumed_link_id/run_id | T-03-22–25 |

nonce只在首次签发响应运输；协议事件/meta/命令记录/导出/诊断不记明文，04的私有原始harness输出不宣称脱敏，不自动公开/送模型。响应丢失时同请求只返回grant_id/签发结果，不能恢复nonce或自动另签；旧owner可显式撤销后用新请求再签，拒绝不反射nonce。

签发后 MCP 重启/断连不自动撤销逻辑 owner 的显式 grant；签发时 context 有效性是持久证据，消费仍检查当前 owner_epoch/expiry/撤销。接受 close、关系 revoke、成功 handover 都使 epoch 递增并撤销所有 issued grant；同任务 resume 保持 epoch，忙槽仍阻止消费。错误 target、错 child、owner 变更、过期或重放均不自动换 key/签发或启动。

v1.1 参数摘要只纳入 grant_id/credential hash，绝不存 nonce；先执行 02 幂等查找：同 target OwnerKey/request_key/params 重放已提交的原结果，不能二次消费；不同 key 使用同凭证返回 credential_consumed。消费前的任何失败/崩溃回滚 grant 状态；commit 后启动响应未知保留该 grant 的 consumed 与新 run uncertain，不能重新交给另一运行。

### close 与只读投影

close 是 v1.1 的可恢复操作，不把 run 增加 closing 状态。先按02验证caller/context和OwnerKey×request_key并重放原结果；新意图再校验关系授权。有child_ref的关系要求current_owner=1且调用者OwnerKey等于记录的owner；child_ref=NULL的pending/claimed关系通过记录的意图parent OwnerKey鉴权（按01/02解析已证实alias），不要求尚不存在的当前父边。仅知linkId、旧context或非parent调用均拒绝，其余终态不接受新close。事务固定 close_request_id、当时 currentRun、owner_epoch+1 并使未用 grant 失效；有未完成 close 的 link 不接受 resume/handover/第二个不同目标 close。已有同 close 的重试返回原进度。

有活跃/uncertain run 时先通过 04 发鉴权取消；未确认结束继续 cancelling/uncertain 并保留 close intent/槽。确认退出后记录已提交报告/日志路径与覆盖状态（没报告明确 none，不编造 report），然后 HostAdapter 以保存的 server/locator、run/binding generation 重验 occupant。仅原 surface 存在且 occupant 匹配才关；原对象确证已不存在算完成，传输超时/同 pane 新 occupant 不算。headless 无 surface 标 not_applicable。关 surface 是外部动作：先记 surface_close_intent，未知结果只读对账，不盲重关。最后一个事务才写 link.closed/closed_at 与 close.completed 事件；历史和 current_owner 保留，槽释放只能来自先前 02 终结事务（T-03-26–29）。

Jev 的关闭还须遵守 browser 租约：本地 runner 退出不替代 answered/failed+对账；needs_human 或发送结果未知不能完成为“资源已释放”。collect lease 属 06 观测存储，与 close/运行心跳无关。

HUD可读投影包括：pending/claimed的未确认身份字段；bound/reported的唯一当前父边、各自run/报告；closed的历史与是否满足resume门禁；failed/revoked的失败/失效事实；handed_over的predecessor历史而非第二父边。uncertain提供证据ID/缺失项与允许的对账能力；历史locator occupant不匹配时当前宿主字段未知且无可用跳转。focus能力只适用同一已验证occupant，resume/cancel/close交受信控制入口鉴权；HUD只读，不把UI done当run ended。此处不决定布局、视觉编码或信息编排（T-03-30、31）。

## 失败案例

| 编号 | 合成场景 / 预期 | 不变量 | 测试 |
|---|---|---|---|
| F-03-1 | report completed 或 UI done 但组仍活 → reported 可成立，run 仍 active/槽持有 | I-03-1、2 | T-03-2、3 |
| F-03-2 | closed resume 非 owner、busy/uncertain、brief 改写、错误 source → 拒绝，不清历史/新建 run | I-03-3、5 | T-03-5–7 |
| F-03-3 | resume/handover 的本轮解析到 fork/new id → 不改 child_ref，run uncertain、候选 | I-03-4 | T-03-8、9 |
| F-03-4 | 旧撤销绑定迟报、observe_only、shared 错 context → 拒绝/旧轮审计，不影响新轮 | I-03-6 | T-03-10–12 |
| F-03-5 | wait 中追加新 run、分页或超时 → 固定 run，游标不跳未返回事件，零状态写 | I-03-7 | T-03-14–17 |
| F-03-6 | 并发 predecessor、历史前驱、环、忙槽 → 单一转交或拒绝；旧历史不成第二父 | I-03-8 | T-03-18、19、25 |
| F-03-7 | 猜 linkId/nonce、自报issuer、错 target/child、无公开能力 → unsupported/invalid，不消费 | I-03-9 | T-03-20、21 |
| F-03-8 | 过期/撤销/旧epoch/凭证重放、消费后响应丢失 → 拒绝或原结果重放，零新执行 | I-03-10 | T-03-22–25 |
| F-03-9 | close 取消未退出、surface 超时或换 occupant、重试 → 保留 intent，不假 closed/关错pane | I-03-11、12 | T-03-26–29 |
| F-03-10 | revoked run 仍活、活跃 headless 打开、历史关系复活 → 不放槽、不起可见副本、不写 ledger | I-03-2、12、13 | T-03-4、30、31 |
| F-03-11 | 要求调用者手写登记/续租/宿主命令、wait按秒查全库/扫proc → 违反低摩擦/预算；由现有写者按事件自动推进 | I-03-14 | T-03-32、33 |

## 测试清单

以下是 A4/B2/B4/B5/B6/B14 及 v1.1 的可执行规格，不表示本批已实施进程协议。P 用合成真实进程/临时 HUD_HOME；凭证测试在内部能力 fixture 开启，MVP 对照组始终 unsupported。

| 编号 | 输入 → 预期状态断言 |
|---|---|
| T-03-1 | 新 spawn、claim、独立证据三步；另无 MCP 三证 → link pending/claimed/bound 与 observe_only 例外精确对应，run 无 pending 枚举 |
| T-03-2 | 当前 run 提交四种 report status，组仍活 → link reported，报告只写该 run；零槽释放/伪造终态 |
| T-03-3 | fresh 未绑定首轮 N，已绑定后续轮 N，非零 R 三组 → link.failed/run.failed；link仍bound/run.failed；link保持/run.ended(code非零)，均不把任务结果当执行事实 |
| T-03-4 | 身份冲突使 link revoked，但组 alive → 历史保留/当前边撤销，run uncertain或按02继续对账，槽不释放，无新授权 |
| T-03-5 | bound/reported/closed 分别同任务合法 resume → 相同 link、新 run_seq/run/claim/锚点、link bound、run starting/握手pending，旧 claim/binding撤销 |
| T-03-6 | closed 且槽 uncertain 或错 owner，再以正确owner/空槽 → 前两组保持closed；最后closed→bound并清当前关闭字段，历史close事件仍可查 |
| T-03-7 | brief path相同但内容hash变、换任务/role/source、仅追加prompt四组 → 前三组task_mismatch或要求新link，追加prompt可合法resume |
| T-03-8 | resume已记录child-a，新握手解析child-b（含pi新文件无连续性/fork） → child_ref/target_ref仍a、run uncertain，b仅候选；SQL拒绝覆盖已知ref |
| T-03-9 | handover已知child-a，新轮解析b；另pi可信同ref续文件 → 前者冲突不改ref，后者正常本轮绑定，不能用文件名猜连续性 |
| T-03-10 | 当前 mcp 子/错子/错context或代次/observe_only报送 → 仅首项接受；每个接受report有固定run/binding外键和seq |
| T-03-11 | 旧run报告先提交再resume，与resume先撤销旧binding再迟报两组 → 前者只在旧轮，后者report.rejected审计；新轮report空、握手pending不变 |
| T-03-12 | 旧轮重复report、历史closed/handed_over的迟报 → 不标新轮reported，不重开历史，不满足新run wait；按report_id/seq展示去重 |
| T-03-13 (P) | run active/uncertain、取消信号已发/心跳停/关pane/自报completed → 严格按R-02表，只有R/Q/N终结后释放槽 |
| T-03-14 | wait(linkId)读快照时currentRun=a，之后b出现；输入双定位键/无run/无读取权限 → 分别固定a/invalid/no_run/unauthorized |
| T-03-15 | 只有别的run或link-only事件、a旧报告、新run报告交错 → 仅fixedRun事件可返回/满足until，nextSeq只到实际返回项 |
| T-03-16 | 201条fixedRun事件，唯一report分别在第100/201条且until=report；另空页/已终态快照 → 第一组首页200且hasMore/matched均true；第二组首页matched=false、次页true；nextSeq只到实际返回项，空页同游标，终态不因hasMore变false |
| T-03-17 | timeout=120000与120001、断线后固定run/游标续等、hint丢失/重复 → 有界超时零写入，越界拒绝，续等不随link换run |
| T-03-18 (P) | 同owner两个key并发predecessor → 仅一个新link bound/current_owner=1和run/槽/意图；旧link handed_over/epoch+1，零双父 |
| T-03-19 | busy/uncertain槽、旧handed_over前驱、闭合/祖先环、图预算耗尽 → 全部拒绝且不消费grant/改owner；旧历史仍可读 |
| T-03-20 | MVP跨owner有/无nonce；内部fixture合法旧session owner签发给指定target → MVP均unsupported且零消费，内部只存hash/完整绑定字段 |
| T-03-21 | 非owner/未绑定proc/旧context签发、猜nonce、自报issuer/child、target通配符/proc/等于issuer、expiry越界 → 拒绝无grant或无消费，不反射明文 |
| T-03-22 | 合法target+未过期grant+空槽+无环 → 单事务consume+旧新link/run/claim/槽/幂等/事件；相同key重试同原结果，不二次consume |
| T-03-23 | now=expiry-1/expiry、revoked、旧owner_epoch、已consumed再revoke → 分别可消费/拒绝/拒绝/拒绝/already_consumed；原owner不借revoke撤回新关系 |
| T-03-24 (P) | 两进程同nonce不同key竞争；消费事务写点注入崩溃、commit后启动响应丢失 → 仅一消费，回滚保持issued，commit后consumed+新run uncertain不再启动 |
| T-03-25 | target错、child错、旧owner变化、close pending、槽忙、环，再以新key重放已消费nonce → 拒绝且零新意图；同key原结果仍可重放 |
| T-03-26 (P) | close active/uncertain后尚无退出证据；再补R/Q/N → 先保留close intent/cancelling或uncertain/槽，确认后才关原surface并closed |
| T-03-27 | close未绑定pending/claimed子分别由记录parent/非parent调用，另headless无surface、Jev needs_human → parent在current_owner=0时仍可授权、确认结束后closed不伪造ref；非parent拒绝；headless not_applicable；Jev不假释browser锁 |
| T-03-28 | 同close重试、close与resume/handover并发 → 返回固定close_id/run；先提交的门禁胜出，不关闭后续新run的surface |
| T-03-29 | surface关闭响应丢失/原对象确证消失/同pane新occupant → 对账不重关/可完成/保持surface_pending，零关错对象 |
| T-03-30 | closed、revoked、handed_over历史与新occupant混合树 → 单一当前父边，旧edge仅谱系，旧宿主状态/焦点不套给历史；failed/revoked/handed_over resume拒绝 |
| T-03-31 | HUD打开活跃headless、读取reported或unknown状态、请求控制 → 只看日志/消费B16，控制交鉴权入口；只读ledger连接写入拒绝，无可见副本 |
| T-03-32 | 合成正常委派仅调用spawn+wait，不手写herdr/claim/续租/放槽 → 自动登记/托管/报告事件返回同一run；缺能力明确unsupported/uncertain，不要求调用者补协议；非wait热路径预算交06基准 |
| T-03-33 | 无事件等待、重复/丢通知、heartbeat实际stale、120s超时 → 无按秒查库/扫proc，按相关事件/必要截止复读；真stale仅现有写者触发一次对账，wait超时零写；游标/固定run仍正确 |
