# 02：执行协议与 ledger schema v1

- 版本：`v0.1 draft`（2026-11-01）。
- 状态：A1 第一批草案；A9 通过不变量、失败案例、进程实证与探针后才可冻结，不能以“意见已采纳”代替验收。
- depends-on：[01 身份](./01-identity.md)；[概念方案 v2.3](../universal-hud-concept.md) §6.6、§6.11、§15–16；[工程计划 v1.1](../universal-hud-engineering-plan.md) §3–4、§6；[第三轮评审](../reviews/2026-11-01-chatgpt-pro-v22-plan.md) §3②、§6。03 拥有完整 link/run/report 生命周期，04 拥有 supervisor 实现和回执格式；它们必须遵守本协议的证据门槛。
- 开放项：**待 A3 探针**：Codex MCP 实例/会话隔离及 env / `_meta`、Herdr 三跳 env、cc MCP env、pi resume 文件连续性，分别采用 01 的成立/不成立分支。**待 A8 探针**：可见包装/sidecar；缺启动或退出证据时保留 pending/uncertain，不预先宣称支持。跨 OwnerKey predecessor 转交返回 unsupported，授权凭证格式与生命周期留给 03。

开放项补充：**A3 初步结论（探针已完成、尚未评审）**：[Codex 0.166](../probes/codex-mcp-launch.md) 观测为 TUI/exec 直接启动每会话一个 MCP，shell HUD_* / HERDR_* 不到 MCP，仅配置 env 表传入，逐调用 `_meta` 有 session/thread/turn 字段；[cc](../probes/cc-mcp-env.md) 直接子进程继承含 CLAUDE_CODE_SESSION_ID 的环境，pid/procStart 匹配，`_meta` 无 session id；[Herdr](../probes/herdr-env.md) env 到 shell/agent 及 pi MCP，不到 Codex MCP；[pi](../probes/pi-resume.md) --session 追加同文件、--fork 新文件；[双 home](../probes/codex-dual-home.md) 隔离，cwd-only 会混淆。当前只作为开放项证据索引；全部双分支、caller_contexts 模型、DDL、状态与证据门槛保持，仍待评审和 A9 实证，未把 `_meta` 字段存在等同于可信来源已证明。

本协议不承诺恰好一次，也不提供 exactly-once 保证或“外部动作必达”的保证。账本的目标是记录一致、意图可见、同一实际 SessionRef 的运行槽不重复占用；外部动作是否发生、是否结束只能凭回执和对账证据判定。以下规则是实现要求，不表示本批已经验证真实 harness 的行为。

## 数据模型

| 对象 | 必要语义 |
|---|---|
| `links` | 持久关系；保存创建者 caller/context/generation；parent_ref 缺失时由 dedicated context 定位 process_key/proc_generation；OwnerKey 按 01 派生。child_ref、current_owner 与 predecessor 区分当前父边和历史 |
| `caller_contexts` | 一个物理 CallerId 下的隔离身份/代次。dedicated 对应唯一 stdio context 及 proc scope；shared 仅由可信逐调用源选择唯一 SessionRef，各自 generation，直接使用 session OwnerKey，不用 proc alias |
| `runs` | 每次 spawn/resume/handover 一个 runId，link 内 run_seq 递增；保存目标、绑定代次、mode、locator、启动票据 hash、启动阶段、supervisor 实例、心跳、取消请求、终态证据 |
| `claims / child_bindings` | 01 的凭据及每 run 的当前授权绑定；observe_only 绑定的 caller 为空，不能提交 report |
| `idempotency` | 主键 `(owner_key, request_key)`；params_digest、link/run 引用、不可变原始 outcome。`owner_key` 是提交当时派生范围的快照，不是 caller_id |
| `owner_aliases` | 仅已证实的 proc scope→session ref 单向历史归并；同 proc/generation 仅一条目标，关闭行不删除 |
| `slots` | `slot_key` 主键，run_id 唯一。实际槽 key=session_ref；新会话首次 spawn 未知 ref 时 key=`provisional:<runId>`，session_ref=NULL。holder 为该 run 的执行权票据标识，无 expires_at |
| `evidence / events` | evidence 是待校验/已校验的证据元数据；events.seq 是提交后持久游标。证据 ID 存在不代表外部事实真实，必须经 reconciler 校验来源、实例、代次、内容范围 |
| `jobs / leases` | Jev 的 external_key 与浏览器实例锁；与 SessionRef 运行槽分开。leases 行保留 generation 历史下界，释放不删除行 |
| `reports` | run/link、提交者及 child_binding 固定；结果报告不证明进程退出，不能释放槽 |

时间为 UTC Unix 毫秒。process_start 是可比较的进程实例标识（实现可保存启动 tick/域的字符串），不使用 PID 数字替代。locator/evidence/outcome 是经过字段白名单的 JSON，ledger 不保存完整 prompt、命令正文、claim 明文或密钥；只存必要路径、hash 与协议元数据。brief/reportPath 必须是绝对路径。真实命令及本轮消息的生成和运输由 04/后端负责，ledger 只保留指纹和调用锚点。

### 幂等参数与查询顺序

`request_key` 是必填、区分大小写的 1–256 字符 opaque 字符串。对操作名和参数做版本化规范化：对象键递归排序，数组保留顺序，区分 null 与缺省，采用契约定义的默认值，拒绝未知字段和非有限数字；字符串不做 Unicode 归一化。`params_digest = SHA256(UTF8(canonical JSON))`。摘要覆盖 operation、backend/profile/source、role/model/effort、mode/layout、cwd 的绝对规范路径、brief/report 路径、brief 内容 hash、resume 的 linkId/prompt hash、predecessor、显式授权/资源参数和解析后的后端档案指纹；不含 request_key、caller_id、MCP PID、当前时间、随机 runId/claim。同样的文件路径但内容或档案已改变算不同参数，返回冲突，不偷偷重跑。规范化版本由 `params_version` 固定为 1。

每次调用在 `BEGIN IMMEDIATE` 内按以下顺序执行（I-02-1、2）：

1. 重新验证 01 的物理 caller 和本次选定 context/generation。bound context 派生 session OwnerKey；仅未绑定 dedicated 派生本代 proc OwnerKey。shared 缺可信逐调用源、context 关闭或代次失配时拒绝查询/新意图，不沿用该 MCP 的上次 context。
2. 查当前派生 key 的 `(owner_key, request_key)`。dedicated 若有本代开放 alias，连同相关历史 proc 范围一起查；绑定 dedicated session 还须检查已归并历史记录，包括关闭 alias，仅作同一已证实 session 的重放，新代未绑定 proc 不能借用它们。shared 只查 session 范围：归并事务已把历史 proc 的原结果同步复制到该 canonical 范围，不创建/选择/借用 proc alias。
3. 任何匹配记录 params_version/digest 不一致，或同键记录的 link/run/outcome 不一致，均返回 `idempotency_conflict`、不启动并记事件。多个同参记录只有指向同一个原始结果才可重放；不按创建时间选一个。不得在 session 范围查不到时直接新增，以绕过尚未核对的 proc 记录。
4. 同参返回原始 outcome 的相同 linkId/runId；当前动态状态另作为 `current` 投影读取，不用它篡改原始结果。结果未知/uncertain 也只返回原记录，不再提交外部动作。
5. 全部范围无记录才进入意图事务。dedicated 建 owner_aliases 时同事务扫描两范围全部 request_key；同键异参、异结果或双 session 映射整体拒绝，不启动、不回填 parent_ref，保留原记录并提交冲突事件。无冲突才为每条 proc 原结果建立相同 params_version/digest/link/run/outcome 的 session 记录（已有完全相同结果则复用）、建立 alias、回填 context/ref。原 proc 记录保留审计，复制不创建新 run/执行权。两个不同 run 的同参记录也不是可安全合并的结果。

拒绝事件在有效事务中提交；失败的意图事务先完整回滚，再单独记录拒绝，不留下半个 run/slot。幂等接受记录不覆盖、不自动过期。槽忙的请求可持久化 rejected outcome（无新 run）；同 key 以后仍返回该拒绝，要在槽空闲后提出新请求必须显式换 request_key。这属于新的意图，不是重放旧动作。

## 不变量

`DB` 仅表示下文 PK/UNIQUE/CHECK/FK/触发器直接约束的结构；`TX` 表示写者事务的校验；`E` 表示还依赖进程或外部回执。不能声称 SQL 自动证明授权或外部事实。

| 编号 | 可检查的断言 | 层 / 测试 |
|---|---|---|
| I-02-1 | 幂等范围为选定 context 的 OwnerKey×request_key；同参只重放原结果、异参拒绝；CallerId/MCP 重启不绕过；dedicated alias 归并同步原结果到 session，shared 不使用 proc alias；A/B context 不混用范围 | DB+TX+E；T-02-1–5、27 |
| I-02-2 | 已接受 session 操作的 link/run(starting)/claim/idempotency/slot 和 accepted 事件同事务；Jev 则同事务提交 job/external_key/browser lease 而无 session claim/slot；resume 复用 link 新增 run，失败不留部分意图 | TX；T-02-6、7、20 |
| I-02-3 | 每实际 SessionRef 一个槽、每 run 一个槽；仅持槽且成功消费本轮执行票据的执行者能提交命令；不能因 MCP 重启或超时重发票据 | DB+TX+E；T-02-7、8 |
| I-02-4 | provisional 只给全新会话首次 spawn；resume/predecessor 必须有真实 ref。身份解析后同事务换真实槽；冲突时两 run 都 uncertain、保留各自槽、停止进一步启动/续跑，等待对账 | DB+TX；T-02-9、10 |
| I-02-5 | starting/running/cancelling 出现提交结果不明、托管失联或证据冲突即 uncertain；正常 reserved 意图在未登记 supervisor 的有界窗口保持 starting，已确认 supervisor 死亡优先于残留 fresh 心跳；uncertain 保留槽；API/等待超时不改状态 | TX+E；T-02-8、11–13、19 |
| I-02-6 | failed 只表示已证明未执行；已执行且退出码非零是 ended 并保留失败结果，不伪装成可重试的未执行 | TX+E；T-02-12、14 |
| I-02-7 | cancel 接受后先 cancelling；只有确认该运行已退出才 cancelled，无法确认则 cancelling/uncertain；关闭 pane、发送信号成功、report 都不构成退出 | TX+E；T-02-15、16 |
| I-02-8 | 对账只按 R-02 表的证据迁移；回执、心跳、进程组、预检记录须匹配 run/源/实例/代次；缺证不补退出码、不释放槽、不盲重试 | TX+E；T-02-12–17 |
| I-02-9 | 只有 hud-mcp/hud-run/reconciler 写 ledger；初始意图外的身份回填与状态迁移经 reconciler，hud-run 追加证据/心跳，HUD 只读。state+槽释放+事件同事务 | TX；T-02-6、17、25 |
| I-02-10 | run slot 仅确认结束后释放，含 provisional；browser 租约仅 answered/failed 且对账后释放，needs_human/失联继续持有；collect 在观测存储按代次接管，绝不放进 ledger leases | DB+TX+E；T-02-10、20–23 |
| I-02-11 | predecessor=同 owner 对同一实际会话的原子转交；槽空闲才允许；旧 link handed_over，唯一当前 owner/父边；跨 owner unsupported | DB+TX；T-02-18 |
| I-02-12 | wait(linkId) 入场固定 runId；游标只读已提交事件；旧 run 迟报不满足新 wait；超时返回当前状态/原游标，不制造终态 | DB+TX；T-02-19 |
| I-02-13 | 父 MCP 断连不代表子结束；默认 orphan_policy=continue，stop 也经取消与退出证明；活跃 headless 只看日志，不启动可见副本 | TX+E；T-02-16、24 |
| I-02-14 | schema v1 可在 node:sqlite 空库执行；连接启用 foreign_keys、WAL、busy_timeout；更高 user_version 拒绝写，JSON 仅导出，不作为控制存储 | DB+TX；T-02-25、26 |

## 状态机

### 意图、执行权与外部提交

初始 link.pending/run.starting 是创建记录；其余关系/运行迁移均调用 reconciler 事务入口。hud-run 可在同一进程中调用该入口，但不得自己用另一套规则改 state。

1. **准备**：验证 owner、能力、source、路径和摘要；resume 要求 link 为 bound/reported/closed、仍为 current_owner、当前所有者相符、child_ref 明确、无槽且无未解决冲突；predecessor 还要求旧 link 仍为 current_owner 且其 owner 同 caller，不能从已 handed_over 的历史关系再次转交。可见能力未证实就返回 unsupported，不试着启动后猜。
2. **原子意图**：`BEGIN IMMEDIATE`；完成幂等查找，冻结 parent context/generation；首次 spawn 建 link，resume 复用 link，handover 把旧 link 变 handed_over 并令新 link 成唯一 current_owner；session 操作插入 run.starting、未 armed claim、幂等 accepted outcome、slot 和事件；commit 后才可能产生外部动作。Jev 不建 session claim，以 browser lease 替代 session slot，并先持久化 external_key。
3. **登记执行者**：意图持有者只向 hud-run 交付一份随机执行票据。supervisor 在事务里校验自己持有该槽/票据（Jev 则校验 browser holder+generation）、run 仍 starting、launch_phase=reserved 且无 supervisor，CAS 消费票据并登记 pid+procStart、心跳、启动回执锚点；session run 的 claim 此时 arm。第二个执行者 CAS 失败必须退出，不得调用 backend。票据或 claim 的明文不写 ledger。
4. **提交前围栏**：supervisor 在同一写事务重验槽、owner 授权快照未撤销、无冲突/取消、启动实例和 launch_phase；写 `submitting` 后才调用外部启动接口。从此即使没有响应也不能重发。成功证据写 `submitted`；崩溃窗口保持 uncertain。原始票据重传、MCP 重启不产生新的执行权。reserved/armed 阶段若要证明未执行，须先事务写 `never_submitted`，使迟到执行者的 CAS/提交检查失败，再提供可靠无子进程证据。
5. **绑定与槽迁移**：新会话尚未知时仅占 provisional；只能用明确“创建新会话”的 launch 模板，不得隐式 resume/attach 已有 session。01 身份证据解析 ref 后，以 BEGIN IMMEDIATE 检查真实槽并原子把 provisional 换为实际槽、写 child_binding/child_ref 与绑定事件。若目标已占槽，保留原 provisional 和原实际槽，两 run 都写 uncertain、冲突事件；任何执行者在之后的提交检查都失败。若旧进程已运行，此规则不声称能撤回已发生的动作；不得续跑/另起，先对账或经授权取消。该冲突在解决前同样阻断该 ref 的新操作。
6. **结束**：reconciler 校验证据后同事务写 ended/failed/cancelled、terminal_evidence_id/ended_at/可知的 exit_code、释放槽、撤销本轮 claim、发事件。没证据就继续占槽；初始 provisional 也无过期释放。观察型子绑定不影响槽规则。

本批 launch_phase 为 `reserved → armed → submitting → submitted`；`reserved/armed → never_submitted` 是带围栏的未提交证明。`submitting` 不是“已执行”，也不是“未执行”；不得仅因该字段判断结果。进程恢复/重新托管可以观察同一 run，不能重置票据或把阶段倒退到 reserved。

### 证据定义与完整对账表

适用状态集合 `A={starting,running,cancelling,uncertain}`，终态集合 `Z={ended,failed,cancelled}`。下表按编号从上到下命中第一行；`*` 表示任意值，最后一行覆盖所有未列组合，因而每个 state×evidence 都有结果。每次迁移附采用/拒绝的 evidence ID 和事件；外部旧实例/错 generation 的证据先丢到审计，不参与当前判断。

- `R`：经验证的本轮退出回执，覆盖全部受管进程的结束；如果回执只覆盖 leader，还必须有可信“受管子进程/进程组均已结束”的对账证明才构成 R。包括退出时刻、已知退出码或信号；不能用文件存在代替校验。
- `G=alive/gone/unknown`：在正确 PID 域、boot/启动实例、pgid/受管子进程范围上的检查。仅 `/proc/<pid>` 缺失、跨域不可见、EPERM 均不能推出 gone。gone 还需已围栏禁止迟到提交；没有退出回执时不得推测退出码。
- `H=fresh/stale/unknown`：匹配 supervisor 实例的心跳；每 5 s 记录，`now-heartbeat_at>30000` 为 stale，等于 30000 仍 fresh；没有心跳用创建时刻检测启动挂起。stale 是失联观测，不是结束证明。
- `N`：不可变预检/启动失败记录证明“命令从未提交”，启动阶段已围栏为 never_submitted，且没有启动/退出子进程的相反证据，G=gone。supervisor 自己的失败回执只有明确证明未启动 harness 且无子进程时才满足 N。
- `Q`：无 R，但有可信已执行/已启动记录、G=gone、迟到提交已围栏；这是“已结束、退出结果未知”的对账证明，不是“看不见 PID”。
- `C`：取消请求已鉴权且在实际退出前被接受；若 R 证明退出先于取消，请求返回 already_ended，不改成 cancelled。
- `X`：同实例证据矛盾，包括 R 但 G=alive、N 但有 submitted/child 记录、两个 SessionRef/启动实例争用，或 provisional 冲突未解决。只看实际矛盾，陈旧心跳本身不与 R 冲突。

| 行 | 当前状态 | 证据组合 / 前置条件 | 唯一允许的结果与槽动作 | 测试 |
|---|---|---|---|---|
| R-02-0 | Z | 匹配的重复回执，或旧实例/旧 run 证据 | 保持终态，不重开、不重发；错误实例仅审计。若出现新的同实例矛盾，记 conflict 并阻断该 ref 新操作，需人工对账，不能自动覆盖旧终态 | T-02-17 |
| R-02-1 | A | X=true，其他任意 | uncertain；持槽，禁止提交/续跑；人工 hud run reconcile | T-02-9、13、17 |
| R-02-2 | A | X=false，R 或 Q，且 C=true | cancelled；确认结束后同事务释放槽，未知退出码保留 NULL | T-02-15 |
| R-02-3 | A | X=false，R 或 Q，C=false / 退出早于取消 | ended；释放槽；非零 exit_code 仍为 ended，失败结果另记 | T-02-14、15 |
| R-02-4 | A | X=false，N=true，无已执行证据 | failed（non_execution）；释放槽；原请求重放仍返回原记录，重新执行必须是显式新意图 | T-02-12、14 |
| R-02-4a | starting | X=false，launch_phase=reserved，票据未消费且 supervisor/heartbeat 均为空，创建后≤30 s，意图与占有完整（session 槽或 browser 租约）且无取消；正常等待 supervisor 登记 | 保持 starting，不要求不存在的 supervisor/child 存活证明；只允许原票据一次登记。窗口后无证明走 R-02-9，不能重发票据 | T-02-8、11 |
| R-02-5 | A | 无结束/未执行证明，supervisor 未被确认死亡，H=fresh 且 G=alive，已核验本轮子进程启动；C=true/false | cancelling / running；均持槽。已确认死亡不匹配本行，必须走 R-02-6；不重启 harness | T-02-13、16 |
| R-02-6 | A | 无上述证明，supervisor 死亡或 H=stale（包括 G=alive） | uncertain；持槽；探查/记录组存活，不释放，不把 child 活着当成新 supervisor 的执行权 | T-02-13 |
| R-02-7 | starting | launch_phase=reserved/armed，持票据的执行者实例有效、启动观测≤30 s，尚未提交且无取消/矛盾 | 保持 starting；仅原执行者可继续一次提交。纯启动心跳不能推 running | T-02-8、11 |
| R-02-8 | cancelling | 无终结证明，取消通道/匹配 supervisor 仍有效，未触发失联或矛盾 | 保持 cancelling；可以继续同一次取消序列，不释放槽 | T-02-16 |
| R-02-9 | A | 其他所有组合：无回执，G=unknown；只有进程消失；预检无围栏；提交响应丢失；“什么也证明不了” | uncertain 并持槽，提示人工 `hud run reconcile <runId>`；人工命令仍须提供本表证据，不能按按钮强行认定结束 | T-02-11–14 |

API/host/wait 的超时只返回当时状态，不制造状态迁移；上述 stale 心跳是在 reconciler 接受“托管失联”的独立观测后进入 uncertain，不是把 wait 超时当失败。原始 evidence 只追加；reconciler 记录验证结果及采用证据，不能用模型自述或截图补回执。终态重复事件不重复释放/报完成；同实例新矛盾通过未解决 conflict 事件阻断新请求，其解决事件须引用 conflict 与被撤销/补充的证据。

### 取消、等待与禁止重试清单

取消先在事务中鉴权并记录 cancel_requested_at、cancelling 事件，再让 hud-run 对已核验本轮进程组执行 `SIGINT → grace(默认10 s) → SIGTERM → SIGKILL`。每一步重新确认实例，不能向复用 PID 发信号。发信号成功不是退出回执；取消通道失败/信号后未知存活进入 uncertain；最终只按 R-02-2 终结。默认 orphan_policy=continue；stop 与显式 cancel 使用同一状态机。取消与终态/提交相争时先取得写事务的一方确定围栏，迟到取消不能重写已结束结果。

wait 的 linkId 在进入时解析并固定当前 runId；afterSeq 只推进到本次实际返回的已提交事件。没有新事件而超时，返回同游标、当前状态，不写 ledger。最大 timeoutMs=120000；父 pane 提示只是非持久提示，不能代替查询事件。

以下情形**禁止再次提交外部启动/send**；允许同 key 重放查询、status/logs/wait/reconcile，不允许通过换 MCP、换账号、换宿主或新 key 自动绕过：

| 编号 | 禁止重试条件 | 允许的后续动作 / 测试 |
|---|---|---|
| D-02-1 | run 为 uncertain、提交/启动响应丢失、MCP 在外部启动后回写前死亡 | 原 run 对账，不能换 key 自动起副本；T-02-3、11–13 |
| D-02-2 | supervisor 失联/死亡但组仍活，或无可靠终结证据 | 观察、经授权取消、对账；槽继续持有；T-02-13、16 |
| D-02-3 | 槽非空、provisional 冲突、活跃 headless 被请求“打开” | 仅日志/聚焦已验证 occupant；不 resume/开可见副本；T-02-9、18、24 |
| D-02-4 | 相同 key 异参、alias 合并冲突、身份未证实、旧 generation、跨 owner 操作 | 返回错误和事件，先解决冲突/授权，不为错误自动换 key；T-02-2、4、5 |
| D-02-5 | Herdr 等宿主已收到命令后超时或断连 | 对账原 locator/run；只有可靠预检证明未提交且 N 成立，才允许用户提出明确新意图/选择核心宿主；T-02-11、14 |
| D-02-6 | Jev send 结果未知、sent/waiting/needs_human、已存在 external_key | 只 status/reconcile；同 key 永不第二次 send；回答/失败并对账前不释放 browser；T-02-20–22 |
| D-02-7 | cancelling 未确认退出、父断连、report 或 UI done/关 pane | 继续取消/对账，不能把呈现/报告当结束；T-02-15、16、24 |

### 三类租约

运行槽无 TTL；确认结束后才删除。browser key 是规范化实际 `browser:<cdp_url>`，相同实例的不同账号共锁；只有 jobs.state=answered/failed、结果与外部状态已对账且无未决 send 时，才能清空 holder，保留 lease 行与 generation。新获取在同一写事务 generation+1；一切续约、结果写入与释放必须 CAS `(resource, holder_run_id, generation)`，旧 holder 的迟写拒绝。expires_at 仅用于显示/触发对账，不赋予接管权。needs_human、进程失联、取消本地等待者都不释放 browser；hud-mcp 可用时直接 CLI 不同时段混用，不能宣称数据库能拦截绕过它的外部客户端。

`collect:<session>` 只引用契约 06：放观测存储，过期可按 generation 接管，旧代摘要/checkpoint 写入拒绝。ledger 的 leases CHECK 明确只接受 browser 前缀，不把 collect 当 browser 或把 run slot 当 TTL lease。

## 失败案例

| 编号 | 场景 / 预期 | 不变量 | 测试 |
|---|---|---|---|
| F-02-1 | 并发同键、同键异参、MCP 重启换 CallerId、alias 归并冲突 → 重放或拒绝，零重复提交 | I-02-1 | T-02-1–5 |
| F-02-2 | 在事务每个写点或 commit 后崩溃 → 全回滚或完整意图，不能半槽/无意图启动 | I-02-2、3 | T-02-6–8 |
| F-02-3 | 未知 ref 的首次 spawn 解析到已占槽 ref；provisional 失联 → 双 uncertain，两个槽不释放 | I-02-4、10 | T-02-9、10 |
| F-02-4 | host 已发命令但超时；预检日志不证明未提交；launch 后写回前崩溃 → uncertain，不 fallback 再启动 | I-02-5、6、8 | T-02-11、12、14 |
| F-02-5 | 心跳停>30 s、组仍活/未知/可靠 gone；退出回执与活组矛盾 → 按表迁移，不猜退出码 | I-02-5、8 | T-02-13、14、17 |
| F-02-6 | 取消已发送但未退出、PID 重用、取消与退出竞态 → cancelling/uncertain 或已结束；不提前释放 | I-02-7、8 | T-02-15、16 |
| F-02-7 | predecessor 并发、旧 owner 知道新 link、环或 busy 槽 → 唯一新父边或拒绝，历史保留 | I-02-11 | T-02-18；01 T-01-22 |
| F-02-8 | wait 中出现新 run、旧 run 迟报、长轮询超时 → 固定 run/游标，不变终态 | I-02-12 | T-02-19 |
| F-02-9 | 同浏览器不同账号、needs_human、未知发送、租约到期、旧 generation 迟写 → 保锁并拒绝重复 send/迟写 | I-02-10 | T-02-20–22 |
| F-02-10 | collect 过期、旧 holder 迟写或试图写 ledger lease → 仅观测存储新代可写 | I-02-10 | T-02-23 |
| F-02-11 | 父退出/关 pane、活跃 headless 打开可见、report 当完成 → 不释放、不启动副本 | I-02-9、13 | T-02-24 |
| F-02-12 | SQL 缺外键、双槽/双父/双alias、未知 schema、HUD 写 ledger → 结构拒绝或拒写，不降级到 JSON | I-02-9、14 | T-02-25、26 |
| F-02-13 | 同一物理 shared MCP 的 A/B 交错请求、A 换代或调用缺可信来源 → 只操作选定 context，缺来源拒绝；不挪用 B 的 owner/报告绑定 | I-02-1；01 I-01-12 | T-02-27；01 T-01-35、36 |

## 测试清单

下列为 A4/B2/B3a/B4/B5/B6/B14/C4 待执行断言，不表示本批已实现它们。`P` 必须用真实合成子进程、临时 HUD_HOME/source 与持久 SQLite；fixture 不能证明进程恢复。external command 用只向临时计数文件追加一次的合成命令，不调用模型。

| 编号 | 输入 → 预期断言 |
|---|---|
| T-02-1 (P) | 两 MCP 同 OwnerKey/key/params 并发 spawn → 一条幂等记录、一个 run/slot、两次回复同 link/run/outcome；合成提交计数=1 |
| T-02-2 | 同 owner/key 修改 operation、brief 内容、mode、prompt 或 profile 指纹 → idempotency_conflict；不同 OwnerKey 同 key 可有独立记录；规范化对象键序不改变 digest |
| T-02-3 (P) | 父 harness/session 保持存活，MCP-a accepted 后退出再启动 MCP-b，新 CallerId 验证同 session OwnerKey，重放相同 key/params → 同原 run/outcome，idempotency 行数不变，提交计数=1；另在外部提交后、返回前杀 MCP 重复一次 |
| T-02-4 | proc key 先 accepted，补 bound 证据归并 → 同事务复制相同原结果到 session key；session 重试/关闭 alias 后同 session 新 dedicated 或 shared context 重试均命中原结果，无新 run；shared 不建/查 proc alias，新代未绑定 proc 不查旧 alias |
| T-02-5 | proc/session 两范围同 key 异参，或同参但不同 run/outcome，或同代 alias 双 session → 拒绝整个归并/操作，有 conflict 事件，零新 run/提交，不按时间挑选 |
| T-02-6 | 每个 insert 及 commit 前注入崩溃 → 未提交时 link/run/claim/idempotency/slot/events 全无；提交后全部可见。再模拟 terminal 事务中断 → 不出现“state 已终结但事件/槽提交一半” |
| T-02-7 (P) | 不同 key 两进程同时 resume 同 child ref → 仅一 run 占槽并提交，另一 slot_busy；同 run 尝试两槽、同实际 ref 两 run → SQL UNIQUE 拒绝 |
| T-02-8 (P) | 意图 commit 后、supervisor 登记前先跑 reconciler（age=0/30000/30001 ms），再两 supervisor 同票据竞争；armed/submitting 各崩溃 → 前两组保持 starting 并可一次登记，超窗无证 uncertain；不得重置票据，never_submitted 围栏后迟到提交=0，纯心跳不升 running |
| T-02-9 | 两 provisional 分别解析到同实际 ref，或一个 provisional 碰已占实际槽 → 第一个迁移原子完成；冲突时两 run uncertain，各槽保留，无进一步启动/resume；即使既有进程仍活也不能宣称动作已撤回 |
| T-02-10 | provisional 无 child_ref 时 heartbeat stale；resume/predecessor 缺真实 ref → 前者 uncertain 且槽保留；后两者拒绝，不能新分 provisional；有可靠终结证明后 provisional 才释放 |
| T-02-11 | request/wait/host 超时分别发生在提交前/已提交后 → timeout 自身不改状态；收到提交不明证据后 reconciler uncertain，绝不 fallback；R-02-7 有效启动仍 starting |
| T-02-12 (P) | preflight 证明 never_submitted+提交围栏+G=gone，与仅日志报错/只有 supervisor 非零退出两组对比 → 前者 failed，后者 uncertain；命令执行后回写前崩溃=uncertain 且计数不再增加 |
| T-02-13 (P) | H 分别30000/30001 ms，G分别alive/gone/unknown，与R/N/Q、supervisor已确认死亡组合做表驱动测试 → 严格命中R-02首行；fresh+活子组但supervisor确认死亡=uncertain；仅未确认死亡且fresh+活组/已启动可running，fresh心跳单独不够 |
| T-02-14 | R+退出码0/7、N、Q无退出码、仅PID消失、预检无围栏 → 依次 ended/ended/failed/ended(NULL)/uncertain/uncertain；R 只涵盖leader且子仍活为冲突，不释放 |
| T-02-15 (P) | cancel 接受后组退出；信号后仍活；退出先于取消；cancel 后无退出回执但 Q 可证 → cancelled/保持 cancelling或uncertain/already_ended保持ended/cancelled(NULL)，槽只在确认后释放 |
| T-02-16 (P) | SIGINT→grace→TERM→KILL、组未死/取消通道断、PID被复用、orphan_policy=stop → 重验实例，不能向新PID发信号，不凭信号成功终结；stop也必须走同表 |
| T-02-17 | 错run/错source/旧实例回执，R+G=alive，N+submitted，重复终态证据，新同实例矛盾 → 旧证据仅审计、矛盾uncertain、终态重放不重复事件/释放；新矛盾留阻断conflict，需显式解决后才能新操作 |
| T-02-18 | 同owner两个predecessor并发，实际槽空闲/uncertain占槽/跨owner三组 → 仅一个新current_owner且旧handed_over / slot_busy / unsupported；新owner/旧关系不能凭linkId控制其他关系 |
| T-02-19 | wait(linkId,afterSeq) 入场run-a，期间追加run-b、a迟报、超时 → 只看固定a；wait(b)不由a报告满足；未返回事件不推进游标，超时不写ledger |
| T-02-20 | Jev send前持久external_key后崩溃，或send响应未知，再用同key/新request_key/不同账号尝试 → 只status/reconcile，send计数≤1，不绕过browser实例锁 |
| T-02-21 | 同cdp_url两账号并发，needs_human、sent/waiting、expires_at已过、本地runner取消/死亡 → 后者均不释放browser；只有answered/failed且已对账才能清holder，新获取generation+1 |
| T-02-22 | browser新holder/generation成立后旧代续约/写结果/释放 → 三项CAS均拒绝；相同external_key的重复jobs行SQL拒绝 |
| T-02-23 | 将collect:<synthetic>插入ledger leases；观测存储接管generation+1后旧代写checkpoint → SQL拒绝前者，06 fixture拒绝后者；run slot不出现expires_at逻辑 |
| T-02-24 (P) | 父MCP退出或关pane，默认continue，活跃headless请求可见打开，子只提交report → supervisor继续/失联对账，均不据此释放槽，不启动可见副本 |
| T-02-25 | node:sqlite空库执行DDL；foreign_keys=ON下造孤儿run/report、双current_owner、双slot、双alias、非法state/collect lease、无终态证据或活跃槽删除；HUD readOnly连接试写 → 逐项拒绝；合法历史可导出JSON |
| T-02-26 | user_version=0/1/2，WAL与busy_timeout初始化、锁竞争重试事务而不重发外部命令 → 0迁移、1正常、2拒写；DB忙时无部分意图、无JSON控制回退 |
| T-02-27 | 单一 shared CallerId 下 context-a/b 交错同 request_key、不同 params，A generation+1、缺可信来源、自报B三组 → 原A/B分别独立幂等结果；旧A/缺源拒绝且B不受影响；report外键同时锚定caller/context/generation |

A9 的 execution/recovery gate 必须包括 T-02-3 的跨 MCP 重启实证、T-02-6–17 的崩溃/恢复证据，及 01 对应探针；本批 DDL 执行检查不能替代它们。

## ledger schema v1

下列是空数据库初始化的单个可执行 SQL 块。每个写连接都须重新启用 foreign_keys/busy_timeout；HUD 用 readOnly 连接且不执行初始化。user_version>1 必须在执行迁移前由连接层拒绝。WAL 在文件数据库生效；内存检查库可返回 memory 模式。DB 约束负责结构和唯一性：SessionRef、alias目标、当前父边、当前child_binding、幂等键、槽和browser外部key；SQL 不负责验证 /proc、claim hash来源、授权、状态迁移表、alias范围冲突或跨多表事务完整性，这些必须执行上文 TX 校验和测试。FK默认限制删除，历史不级联清除。

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
BEGIN IMMEDIATE;

CREATE TABLE sources (
  source_id TEXT PRIMARY KEY NOT NULL CHECK (length(source_id) = 64 AND source_id NOT GLOB '*[^0-9a-f]*'),
  harness TEXT NOT NULL CHECK (harness IN ('claude', 'codex', 'pi')),
  root_path TEXT NOT NULL CHECK (substr(root_path, 1, 1) = '/'),
  label TEXT NOT NULL,
  UNIQUE (harness, root_path),
  UNIQUE (source_id, harness)
) STRICT;

CREATE TABLE sessions (
  session_ref TEXT PRIMARY KEY NOT NULL,
  harness TEXT NOT NULL,
  source_id TEXT NOT NULL,
  session_id TEXT NOT NULL CHECK (length(session_id) > 0),
  thread_id TEXT NOT NULL DEFAULT '',
  CHECK (session_ref = json_array(harness, source_id, session_id, nullif(thread_id, ''))),
  UNIQUE (harness, source_id, session_id, thread_id),
  UNIQUE (session_ref, source_id, harness),
  FOREIGN KEY (source_id, harness) REFERENCES sources(source_id, harness)
) STRICT;

CREATE TABLE caller_scopes (
  process_key TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  harness TEXT NOT NULL,
  source_id TEXT NOT NULL,
  pid_domain TEXT NOT NULL CHECK (length(pid_domain) > 0),
  harness_pid INTEGER NOT NULL CHECK (harness_pid > 0),
  harness_proc_start TEXT NOT NULL CHECK (length(harness_proc_start) > 0),
  session_ref TEXT,
  bound_by TEXT CHECK (bound_by IN ('receipt', 'trusted_session', 'transcript')),
  binding_evidence_id TEXT REFERENCES evidence(evidence_id),
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  PRIMARY KEY (process_key, generation),
  CHECK (process_key = json_array(harness, source_id, pid_domain, harness_pid, harness_proc_start)),
  CHECK ((session_ref IS NULL AND bound_by IS NULL AND binding_evidence_id IS NULL)
    OR (session_ref IS NOT NULL AND bound_by IS NOT NULL AND binding_evidence_id IS NOT NULL)),
  CHECK (closed_at IS NULL OR closed_at >= created_at),
  UNIQUE (process_key, generation, source_id, harness),
  UNIQUE (process_key, generation, session_ref),
  FOREIGN KEY (source_id, harness) REFERENCES sources(source_id, harness),
  FOREIGN KEY (session_ref, source_id, harness) REFERENCES sessions(session_ref, source_id, harness)
) STRICT;
CREATE UNIQUE INDEX caller_scopes_current ON caller_scopes(process_key) WHERE closed_at IS NULL;

CREATE TABLE callers (
  caller_id TEXT PRIMARY KEY NOT NULL,
  instance_kind TEXT NOT NULL DEFAULT 'dedicated' CHECK (instance_kind IN ('dedicated', 'shared')),
  harness TEXT CHECK (harness IN ('claude', 'codex', 'pi')),
  source_id TEXT,
  pid INTEGER NOT NULL CHECK (pid > 0),
  proc_start TEXT NOT NULL CHECK (length(proc_start) > 0),
  ppid INTEGER NOT NULL CHECK (ppid > 0),
  parent_proc_start TEXT NOT NULL CHECK (length(parent_proc_start) > 0),
  cwd TEXT NOT NULL CHECK (substr(cwd, 1, 1) = '/'),
  env_pane TEXT,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  retired_at INTEGER,
  UNIQUE (caller_id, instance_kind),
  FOREIGN KEY (source_id, harness) REFERENCES sources(source_id, harness)
) STRICT;

CREATE TABLE caller_contexts (
  context_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  caller_id TEXT NOT NULL,
  context_key TEXT NOT NULL CHECK (length(context_key) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('dedicated', 'shared')),
  source_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  process_key TEXT,
  proc_generation INTEGER,
  session_ref TEXT,
  selection_evidence_id TEXT REFERENCES evidence(evidence_id),
  bound_by TEXT CHECK (bound_by IN ('receipt', 'trusted_session', 'transcript')),
  binding_evidence_id TEXT REFERENCES evidence(evidence_id),
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  PRIMARY KEY (context_id, generation),
  UNIQUE (caller_id, context_key, generation),
  UNIQUE (context_id, generation, caller_id),
  CHECK ((kind = 'dedicated' AND context_key = 'stdio' AND process_key IS NOT NULL
      AND proc_generation IS NOT NULL AND proc_generation = generation)
    OR (kind = 'shared' AND process_key IS NULL AND proc_generation IS NULL
      AND session_ref IS NOT NULL AND selection_evidence_id IS NOT NULL)),
  CHECK ((session_ref IS NULL AND bound_by IS NULL AND binding_evidence_id IS NULL)
    OR (session_ref IS NOT NULL AND bound_by IS NOT NULL AND binding_evidence_id IS NOT NULL)),
  CHECK (closed_at IS NULL OR closed_at >= created_at),
  FOREIGN KEY (caller_id, kind) REFERENCES callers(caller_id, instance_kind),
  FOREIGN KEY (source_id, harness) REFERENCES sources(source_id, harness),
  FOREIGN KEY (session_ref, source_id, harness) REFERENCES sessions(session_ref, source_id, harness),
  FOREIGN KEY (process_key, proc_generation, source_id, harness)
    REFERENCES caller_scopes(process_key, generation, source_id, harness),
  FOREIGN KEY (process_key, proc_generation, session_ref)
    REFERENCES caller_scopes(process_key, generation, session_ref)
) STRICT;
CREATE UNIQUE INDEX caller_contexts_current_id ON caller_contexts(context_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX caller_contexts_current_key ON caller_contexts(caller_id, context_key) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX caller_contexts_single_stdio ON caller_contexts(caller_id) WHERE kind = 'dedicated' AND closed_at IS NULL;

CREATE TABLE owner_aliases (
  process_key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  session_ref TEXT NOT NULL REFERENCES sessions(session_ref),
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  PRIMARY KEY (process_key, generation),
  CHECK (closed_at IS NULL OR closed_at >= created_at),
  FOREIGN KEY (process_key, generation, session_ref)
    REFERENCES caller_scopes(process_key, generation, session_ref)
) STRICT;
CREATE INDEX owner_aliases_session ON owner_aliases(session_ref);

CREATE TABLE links (
  link_id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'bound', 'reported', 'closed', 'failed', 'revoked', 'handed_over')),
  parent_caller TEXT NOT NULL REFERENCES callers(caller_id),
  parent_context_id TEXT NOT NULL,
  parent_context_generation INTEGER NOT NULL,
  parent_ref TEXT REFERENCES sessions(session_ref),
  child_ref TEXT REFERENCES sessions(session_ref),
  current_owner INTEGER NOT NULL DEFAULT 0 CHECK (current_owner IN (0, 1)),
  backend TEXT NOT NULL,
  role TEXT NOT NULL,
  label TEXT,
  brief_path TEXT NOT NULL CHECK (substr(brief_path, 1, 1) = '/'),
  report_path TEXT CHECK (report_path IS NULL OR substr(report_path, 1, 1) = '/'),
  predecessor TEXT UNIQUE REFERENCES links(link_id),
  routing TEXT CHECK (routing IS NULL OR json_valid(routing)),
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  bound_at INTEGER,
  closed_at INTEGER,
  CHECK (parent_ref IS NULL OR child_ref IS NULL OR parent_ref <> child_ref),
  CHECK (predecessor IS NULL OR predecessor <> link_id),
  CHECK (current_owner = 0 OR (child_ref IS NOT NULL AND state NOT IN ('handed_over', 'failed', 'revoked'))),
  FOREIGN KEY (parent_context_id, parent_context_generation, parent_caller)
    REFERENCES caller_contexts(context_id, generation, caller_id)
) STRICT;
CREATE UNIQUE INDEX links_current_child ON links(child_ref) WHERE current_owner = 1;
CREATE INDEX links_parent ON links(parent_ref);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  link_id TEXT NOT NULL REFERENCES links(link_id),
  run_seq INTEGER NOT NULL CHECK (run_seq >= 1),
  operation TEXT NOT NULL CHECK (operation IN ('spawn', 'resume', 'handover', 'jev')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('session', 'job')),
  target_session_ref TEXT,
  source_id TEXT,
  harness TEXT,
  expected_generation INTEGER NOT NULL CHECK (expected_generation >= 1),
  mode TEXT NOT NULL CHECK (mode IN ('visible', 'headless')),
  state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'cancelling', 'uncertain', 'ended', 'failed', 'cancelled')),
  locator TEXT CHECK (locator IS NULL OR json_valid(locator)),
  launch_token_hash TEXT NOT NULL UNIQUE CHECK (length(launch_token_hash) = 64 AND launch_token_hash NOT GLOB '*[^0-9a-f]*'),
  launch_digest TEXT NOT NULL CHECK (length(launch_digest) = 64 AND launch_digest NOT GLOB '*[^0-9a-f]*'),
  launch_phase TEXT NOT NULL DEFAULT 'reserved' CHECK (launch_phase IN ('reserved', 'armed', 'submitting', 'submitted', 'never_submitted')),
  launch_call_id TEXT NOT NULL,
  launch_message_id TEXT NOT NULL,
  supervisor_pid INTEGER CHECK (supervisor_pid > 0),
  supervisor_proc_start TEXT,
  heartbeat_at INTEGER,
  cancel_requested_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  exit_code INTEGER,
  terminal_evidence_id TEXT REFERENCES evidence(evidence_id),
  orphan_policy TEXT NOT NULL DEFAULT 'continue' CHECK (orphan_policy IN ('continue', 'stop')),
  UNIQUE (link_id, run_seq),
  UNIQUE (run_id, link_id),
  UNIQUE (run_id, expected_generation),
  CHECK ((supervisor_pid IS NULL AND supervisor_proc_start IS NULL)
    OR (supervisor_pid IS NOT NULL AND supervisor_proc_start IS NOT NULL AND length(supervisor_proc_start) > 0)),
  CHECK ((target_kind = 'session' AND operation <> 'jev' AND source_id IS NOT NULL AND harness IS NOT NULL)
    OR (target_kind = 'job' AND operation = 'jev' AND target_session_ref IS NULL AND source_id IS NULL AND harness IS NULL)),
  CHECK (operation NOT IN ('resume', 'handover') OR target_session_ref IS NOT NULL),
  CHECK ((state IN ('ended', 'failed', 'cancelled') AND ended_at IS NOT NULL AND terminal_evidence_id IS NOT NULL)
    OR (state IN ('starting', 'running', 'cancelling', 'uncertain') AND ended_at IS NULL AND terminal_evidence_id IS NULL AND exit_code IS NULL)),
  CHECK (ended_at IS NULL OR ended_at >= created_at),
  FOREIGN KEY (source_id, harness) REFERENCES sources(source_id, harness),
  FOREIGN KEY (target_session_ref, source_id, harness) REFERENCES sessions(session_ref, source_id, harness)
) STRICT;
CREATE INDEX runs_link_latest ON runs(link_id, run_seq DESC);
CREATE INDEX runs_reconcile ON runs(state, heartbeat_at);
CREATE INDEX runs_target ON runs(target_session_ref);

CREATE TABLE claims (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(run_id),
  claim_hash TEXT NOT NULL UNIQUE CHECK (length(claim_hash) = 64 AND claim_hash NOT GLOB '*[^0-9a-f]*'),
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  expected_generation INTEGER NOT NULL,
  supervisor_pid INTEGER CHECK (supervisor_pid > 0),
  supervisor_proc_start TEXT,
  state TEXT NOT NULL CHECK (state IN ('issued', 'armed', 'redeemed', 'revoked', 'expired')),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_context_id TEXT,
  redeemed_generation INTEGER,
  redeemed_session_ref TEXT REFERENCES sessions(session_ref),
  redeemed_at INTEGER,
  CHECK (expires_at = issued_at + 1800000),
  CHECK ((supervisor_pid IS NULL AND supervisor_proc_start IS NULL)
    OR (supervisor_pid IS NOT NULL AND supervisor_proc_start IS NOT NULL)),
  CHECK (state NOT IN ('armed', 'redeemed') OR supervisor_pid IS NOT NULL),
  CHECK (state <> 'redeemed' OR (redeemed_at IS NOT NULL AND redeemed_context_id IS NOT NULL AND redeemed_generation IS NOT NULL)),
  FOREIGN KEY (run_id, expected_generation) REFERENCES runs(run_id, expected_generation),
  FOREIGN KEY (redeemed_context_id, redeemed_generation) REFERENCES caller_contexts(context_id, generation)
) STRICT;

CREATE TABLE child_bindings (
  binding_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  session_ref TEXT NOT NULL REFERENCES sessions(session_ref),
  binding_generation INTEGER NOT NULL,
  caller_id TEXT,
  caller_context_id TEXT,
  context_generation INTEGER,
  bound_by TEXT NOT NULL CHECK (bound_by IN ('receipt', 'trusted_session', 'transcript', 'receipt+transcript')),
  capabilities TEXT NOT NULL CHECK (capabilities IN ('mcp', 'observe_only')),
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK ((capabilities = 'mcp' AND caller_id IS NOT NULL AND caller_context_id IS NOT NULL AND context_generation IS NOT NULL)
    OR (capabilities = 'observe_only' AND caller_id IS NULL AND caller_context_id IS NULL AND context_generation IS NULL AND bound_by = 'receipt+transcript')),
  CHECK ((is_current = 1 AND revoked_at IS NULL) OR (is_current = 0 AND revoked_at IS NOT NULL)),
  UNIQUE (run_id, binding_id, caller_id, caller_context_id, context_generation),
  FOREIGN KEY (caller_context_id, context_generation, caller_id)
    REFERENCES caller_contexts(context_id, generation, caller_id),
  FOREIGN KEY (run_id, binding_generation) REFERENCES runs(run_id, expected_generation)
) STRICT;
CREATE UNIQUE INDEX child_bindings_current ON child_bindings(run_id) WHERE is_current = 1;

CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT REFERENCES runs(run_id),
  link_id TEXT REFERENCES links(link_id),
  kind TEXT NOT NULL CHECK (kind IN ('launch_receipt', 'trusted_session', 'transcript', 'exit_receipt', 'group_check', 'never_submitted', 'heartbeat', 'conflict', 'conflict_resolved', 'browser_status', 'browser_reconciled')),
  producer TEXT NOT NULL CHECK (producer IN ('hud-mcp', 'hud-run', 'reconciler')),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  observed_at INTEGER NOT NULL,
  validated_at INTEGER,
  validation TEXT NOT NULL DEFAULT 'pending' CHECK (validation IN ('pending', 'accepted', 'rejected')),
  CHECK ((validation = 'pending' AND validated_at IS NULL) OR (validation <> 'pending' AND validated_at IS NOT NULL))
) STRICT;
CREATE INDEX evidence_run ON evidence(run_id, observed_at);

CREATE TABLE reports (
  report_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  child_binding_id TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  caller_context_id TEXT NOT NULL,
  context_generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'blocked', 'interrupted')),
  summary TEXT NOT NULL,
  path TEXT CHECK (path IS NULL OR substr(path, 1, 1) = '/'),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (run_id, link_id) REFERENCES runs(run_id, link_id),
  FOREIGN KEY (run_id, child_binding_id, caller_id, caller_context_id, context_generation)
    REFERENCES child_bindings(run_id, binding_id, caller_id, caller_context_id, context_generation)
) STRICT;
CREATE INDEX reports_run ON reports(run_id, created_at);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id TEXT REFERENCES links(link_id),
  run_id TEXT REFERENCES runs(run_id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX events_run_cursor ON events(run_id, seq);
CREATE INDEX events_link_cursor ON events(link_id, seq);

CREATE TABLE idempotency (
  owner_key TEXT NOT NULL CHECK (json_valid(owner_key)),
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 256),
  params_version INTEGER NOT NULL DEFAULT 1 CHECK (params_version = 1),
  params_digest TEXT NOT NULL CHECK (length(params_digest) = 64 AND params_digest NOT GLOB '*[^0-9a-f]*'),
  link_id TEXT REFERENCES links(link_id),
  run_id TEXT,
  outcome TEXT NOT NULL CHECK (json_valid(outcome)),
  at INTEGER NOT NULL,
  PRIMARY KEY (owner_key, request_key),
  CHECK (run_id IS NULL OR link_id IS NOT NULL),
  FOREIGN KEY (run_id, link_id) REFERENCES runs(run_id, link_id)
) STRICT;

CREATE TABLE slots (
  slot_key TEXT PRIMARY KEY NOT NULL,
  session_ref TEXT REFERENCES sessions(session_ref),
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
  holder TEXT NOT NULL CHECK (length(holder) > 0),
  acquired_at INTEGER NOT NULL,
  CHECK ((session_ref IS NULL AND slot_key = 'provisional:' || run_id)
    OR (session_ref IS NOT NULL AND slot_key = session_ref))
) STRICT;
CREATE TRIGGER slots_confirmed_release BEFORE DELETE ON slots
WHEN NOT EXISTS (SELECT 1 FROM runs WHERE run_id = OLD.run_id
  AND state IN ('ended', 'failed', 'cancelled') AND terminal_evidence_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'slot requires confirmed terminal evidence');
END;
CREATE TRIGGER slots_keep_run BEFORE UPDATE OF run_id ON slots
WHEN OLD.run_id <> NEW.run_id
BEGIN
  SELECT RAISE(ABORT, 'slot run cannot be replaced');
END;

CREATE TABLE leases (
  resource TEXT PRIMARY KEY NOT NULL CHECK (substr(resource, 1, 8) = 'browser:' AND length(resource) > 8),
  holder_run_id TEXT REFERENCES runs(run_id),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER,
  released_at INTEGER,
  release_evidence_id TEXT REFERENCES evidence(evidence_id),
  CHECK ((holder_run_id IS NOT NULL AND released_at IS NULL AND release_evidence_id IS NULL)
    OR (holder_run_id IS NULL AND released_at IS NOT NULL AND release_evidence_id IS NOT NULL))
) STRICT;

CREATE TABLE jobs (
  job_ref TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
  provider TEXT NOT NULL CHECK (provider IN ('chatgpt', 'gemini', 'aistudio', 'flow')),
  account TEXT NOT NULL DEFAULT '',
  external_key TEXT NOT NULL CHECK (length(external_key) > 0),
  browser_resource TEXT NOT NULL REFERENCES leases(resource),
  browser_generation INTEGER NOT NULL CHECK (browser_generation >= 1),
  state TEXT NOT NULL CHECK (state IN ('key_persisted', 'sent', 'waiting', 'answered', 'needs_human', 'failed', 'uncertain')),
  reconciled_at INTEGER,
  result_path TEXT CHECK (result_path IS NULL OR substr(result_path, 1, 1) = '/'),
  UNIQUE (provider, account, external_key),
  CHECK (job_ref = json_array('jev', provider, account, external_key))
) STRICT;

PRAGMA user_version = 1;
COMMIT;
```
