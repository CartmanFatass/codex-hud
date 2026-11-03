# 02：执行协议与 ledger schema v1

- 版本：`v0.4 draft`（2026-11-01；Oracle C01–C14、D01–D13 修订）。
- 状态：A1 第一批草案；A9 通过不变量、失败案例、进程实证与探针后才可冻结，不能以“意见已采纳”代替验收。
- depends-on：[01 身份](./01-identity.md)；[概念方案 v2.3](../universal-hud-concept.md) §6.6、§6.11、§15–16；[工程计划 v1.1](../universal-hud-engineering-plan.md) §3–4、§6；[第三轮评审](../reviews/2026-11-01-chatgpt-pro-v22-plan.md) §3②、§6。03 拥有完整 link/run/report 生命周期，04 拥有 supervisor 实现和回执格式；它们必须遵守本协议的证据门槛。
- 证据快照：依 [Oracle](../reviews/2026-11-01-astra-contracts.md) 收窄 MVP；A3 五份探针已评审，组合身份/有界 spoof 与 fallback 详见 [01](./01-identity.md)。[daemon 补测](../probes/codex-daemon.md)是 CLI 0.166 / daemon 0.163 在场默认路径的 direct-stdio 证据，不是共享调度验收，亦非 A9 必测前置。[A8](../probes/hud-run-visible.md)首轮拒绝；A8-fixB2 关键证据已于 `8fdf4cf` 接受（同 agent/session、实际 context、父 launcher 退出后的 TTY 输入/收尾，限前台 hud-run 形态）。04 采用修订甲；该原型不是 B 生产协议 pass。


本协议不承诺恰好一次，也不提供 exactly-once 保证或“外部动作必达”的保证。账本的目标是记录一致、意图可见、同一实际 SessionRef 的运行槽不重复占用；外部动作是否发生、是否结束只能凭回执和对账证据判定。以下规则是实现要求，不表示本批已经验证真实 harness 的行为。

[Oracle consult 2](../reviews/2026-11-01-astra-consult2.md) D01–D13 补齐字段、控制主体与读取边界；本轮仍是 A4/A9 候选契约，不代表 A9 放行或 B 生产能力已验证。

[Oracle consult 3](../reviews/2026-11-01-astra-consult3.md) E01–E06 同步观测绑定、取消分类、事实时序与 export v1；仍是 A9 候选，不代表阶段 B 生产验收。

冻结后生效版本：`A9 + consult4-2026-11-01`。以下增补保留 C/D/E 与 A9-fix，ledger schema v1/DDL 不变；F07 仅冻结事务规则，生产接线归 B2/B5。（consult 4 增补，F03）（consult 4 增补，F04）（consult 4 增补，F07）

冻结后增补版本：`A9 + consult4 + F08-Pro + consult5-2026-11-02`。本轮依 [Oracle consult 5](../reviews/2026-11-02-astra-consult5.md) 增补，保留此前 C/D/E、consult 4 F01–F11、F08 Pro 与 A9-fix；ledger schema v1 不变，不授予尚未验收的生产能力。（consult 5 增补，G03）（consult 5 增补，G08）

## 数据模型

| 对象 | 必要语义 |
|---|---|
| `links` | 持久关系；保存创建者 caller/context/generation；parent_ref 缺失时由 dedicated context 定位 process_key/proc_generation；OwnerKey 按 01 派生。child_ref、current_owner 与 predecessor 区分当前父边和历史 |
| `caller_contexts` | 物理 CallerId 与逻辑当前来源分离；MVP 仅开放经验证 dedicated stdio。shared 类型/表形状保留扩展位置，来源不可辨/原生子不能冒充根 |
| `runs` | 每次 spawn/resume/handover 一个 runId，接受时固定 operation（07逐 run 原样导出，不由当前关系反推），link 内 run_seq 递增；保存目标、绑定代次、mode、locator、不可变非空 `launch_cwd`、nullable `workspace_snapshot`/`project_origin`、启动票据 hash、启动阶段、supervisor 实例、心跳、取消请求、终态证据 |
| `ledger_metadata` | 创建库时初始化一行私有 opaque `ledger_id`（对外 `ledgerId`）；重启/同库备份恢复保留，独立新库新生成。不是 HUD_HOME 路径，也不公开内部表兼容接口 |
| `claims / child_bindings` | 01 的逐 run 凭据及当前 MCP 授权绑定；无 MCP 不创建正向 child_binding |
| `idempotency` | 主键 `(owner_key, request_key)`；params_digest、link/run 引用、不可变原始 outcome。owner_key 为当前 canonical 范围；origin_owner_key 保留接受时的原始范围，不是 caller_id |
| `owner_aliases` | 仅已证实的 proc scope→session ref 单向历史归并；同 proc/generation 仅一条目标，关闭行不删除 |
| `slots` | `slot_key` 主键，run_id 唯一。实际槽 key=session_ref；新会话首次 spawn 未知 ref 时 key=`provisional:<runId>`，session_ref=NULL。holder 为该 run 的执行权票据标识，无 expires_at |
| `evidence / events` | evidence 是待校验/已校验的证据元数据；events.seq 是提交后持久游标。证据 ID 存在不代表外部事实真实，必须经 reconciler 校验来源、实例、代次、内容范围 |
| `reports` | run/link、提交者及 child_binding 固定；结果报告不证明进程退出，不能释放槽 |
| 生命周期/托管补充 | task_digest 持久保存同任务判据；strategy/kind 在意图固定，scope_ref 经唯一 harness 核验后 NULL→真实范围一次写入；submission_fenced_at 永久封口。实时 H 仅 runs 一次 CAS UPDATE；退出结果含有来源的 harness exit_code/exit_signal/exit_source，shell_status/shell_signal 单列 |

时间为 UTC Unix 毫秒。process_start 为内核启动 tick 字符串，pid_domain 含机器/boot/PID namespace 身份，与04 ProcessStamp一致，不使用 PID 数字替代。locator/evidence/outcome 是经过字段白名单的 JSON，ledger 不保存完整 prompt、命令正文、claim 明文或密钥；只存必要路径、hash 与协议元数据。brief/reportPath 必须是绝对路径。真实命令及本轮消息的生成和运输由 04/后端负责，ledger 只保留指纹和调用锚点。

（consult 5 增补，G08）上文 pid_domain 与 04 的一致性指完整实例事实，编码/比较边界按 01「身份、实例与定位」的三用途表：Caller/ProcessKey 的 JSON 域、Run 的 hash+namespace 域加独立 boot_id、Claude registry 的原生域各自比较。BID1 共用派生函数；既有 scopes、OwnerKey、幂等历史及完整 stamp 不重键、不回填当前域，不以跨表示 fallback 判断同一实例。

`launch_cwd` 是本轮实际交给启动器的规范绝对路径，spawn/resume/handover 意图事务逐 run 固定；不是 callers.cwd，resume 也不能按后来 CLI 的 cwd 重算。`project_origin` 是06的 `{repoId,basis:'declared',declaredAt}` 或 NULL，请求显式 originRepoId 接受时补声明主体审计/declaredAt，随意图冻结，与物理 repoId 分离。`workspace_snapshot` 是06定义的白名单启动 Git/来源快照或 NULL：有效缓存可随意图写入，冷缺失由该 run 的已有写者在一次有界启动采集后 NULL→首次快照补齐，同事务写 `workspace.captured`（runId、来源/捕获时间/缺失原因）。若意图已有缓存快照，也在该事务记录此事件；声明来源与快照分列，不相互阻断捕获。超时/非 Git/路径不可读可作为有原因的首次快照；不重启 harness、不覆盖历史。后续实际 cwd 不同只写06 observed workspace。导出只读 ledger 启动快照（`cwdBasis=launch`），不现场跑 Git/读 transcript 或用今天目录改历史。JSON CHECK 只校验形状，白名单/规范化/事件同事务由 TX 保证（T-02-30–33）。

（consult 6 增补，H08）runs.locator 承载 01/05 的现有受管 HostLocator，只记录 HostAdapter 核验的固定 runId/bindingGeneration 的首次有效定位；同值重放幂等，未知字段保持未知，冲突不静默覆盖、不改变执行目标。若需 `recordRunLocator` 窄入口，沿用该 run 的受信写者/意图权限和事务前提，不向模型开放任意 locator 写入。未验证环境 ID 仅作进程内提示；缺 server 实例或 occupant 证据仅供诊断，操作前重验，不能借用 bindingGeneration 当 occupantGeneration。

### 增量事件白名单

（consult 6 增补，H07）既有 events 白名单新增 `supervisor.signal`，payload 严格为 `SupervisorSignalFact={signal:'SIGHUP'|'SIGINT'|'SIGTERM',observedAt:number}`；observedAt 是 handler 实际观察的合法毫秒 epoch，非 DB 提交时间。subject 固定为该 run 已登记 supervisor；写入口须匹配 supervisor.registered 的完整 ProcessStamp，并由账本关联 run_id/link_id、校验字段/枚举/时间。只证明 supervisor 收到信号，不证明 sender、harness 收到/退出、scope 终结或取消因果；不用 command.exited/cancel.step 冒充，不改稳定 meta/渐进 exit，不增 signals.jsonl；写入失败保留缺口。具体来源与定向验收归 04，B3b-Facts/B2 实现。

（NOTIFY 增补，A1）既有白名单加法版本为 `events.v1.1`（独立于 ledger user_version=1）；新增以下 kind/白名单 payload，未列自由正文/环境/秘密不接收。wake-worthy 的 report.received（四种 status）、运行终态事件及 run.uncertain 都带所属 link_id；审批/问题注意请求使用 blocked report，不把原生 agent_completed 或进程退出当 report。

| kind / 层 | 白名单 payload / 约束（NOTIFY 增补，A1） |
|---|---|
| wake.registered / link | adapter=`claude_background_wait_v1\|codex_queue_v1\|pi_extension_v1\|none`、adapterVersion=1、ownerKey、contextGeneration、parentRef、parentStamp（ProcessStamp 或 null）、target（codexHome/threadId 或 socketPath 或空对象）、none 的 reason；只绑定已验证父目标，不授所有权（NOTIFY 增补，A1） |
| wake.revoked / link | registrationSeq、reason=`generation_changed\|session_replaced\|parent_offline\|link_closed\|adapter_rejected`（NOTIFY 增补，A1） |
| wake.delivered / link | registrationSeq、throughSeq、result=`accepted\|rejected\|unknown\|wait_return`；adapter 交付记录含 attempt（1 或 2），rejected 含 reason，第二次 unknown 含 exhausted:true；wait_return 为本进程在途 wait 返回了该页、无需 adapter。记录不证明父端已处理或新 turn 已开始；unknown 仅在 recoveryMs 后且父端尚无新调用时准第二次，rejected 撤销登记，零第三次（NOTIFY 增补，A1） |
| retire.requested / run+link | cause、rule、actor={kind:'policy'}、deadlineAt、eligibility={reportSeq?,newerWorkChecked:true,quiescence:'observed\|not_required\|unobservable',pendingInput:'none\|unobservable\|policy_override'}、graceMs；原因/语义见 04，不是终结证明（NOTIFY 增补，A1） |
| surface.created / run+link | locator、occupantGeneration（宿主占用代次）；证明 surface 为本 run 创建，不以地址/绑定代次代替占用证明（NOTIFY 增补，A1） |
| handoff.recorded / link | sha256、bytes、retained:true、fromLinkId?、fromRunId?；在后继意图事务记录实际投递且保留的 brief 字节，不创建 parent/predecessor/权限；handoffPath 只按 07 的 local 路径规则投影（NOTIFY 增补，A1） |

（NOTIFY 增补，A1）D15 兼容规则：未知 events.kind 对状态推导 opaque，读者不得因未知 kind 失败或改变 run/link 状态；不得以 DDL 未变声称行为兼容。新 terminalNote 在旧读者中映射 null，07 的封闭出口表须同次扩展；B14 验旧 reader 读新增 kind/note 的账本。此白名单是写者规则，不给现有开放 LedgerEvent.kind:string 增加封闭解码假设。

（B19 增补，2026-11-02，修订 A1 的 wake.delivered 语义；原文为批准文本）

A native delivery attempt is charged by committing `wake.delivered{registrationSeq,throughSeq,result:'unknown',attempt:1}` **before** invoking transport. A second slot is charged by committing `unknown,attempt:2,exhausted:true` before its transport. These reservations are irrevocable: a crash before actual invocation can consume a slot without sending; zero invocations after two pre-send crashes is accepted. Only the process that commits a previously uncharged slot may invoke it, once. Accepted/rejected outcomes refine that same charged attempt in a subsequent short transaction, after transport; repeated records for the same slot do not charge additional attempts. Rejected outcome and `wake.revoked{adapter_rejected}` commit together. At most two actual native invocations cover any event, including competing workers and restarts. No external I/O occurs in these transactions.

Fresh work and an unresolved retry batch are derived separately. A batch is the fixed registration and contiguous inspected event interval ending at its `throughSeq`; later events cannot enlarge it. Durable scheduling coverage is monotone across reservations and late refinements and is distinct from transport confirmation and the parent's read cursor. Initially there is at most one retry-eligible unresolved batch per registration. Unknown attempt 1 permits attempt 2 only after transport has finished plus `recoveryMs`, and only under continuous observation proving no new parent call since before attempt 1. Any call during transport or afterward permanently suppresses that batch's retry. An inherited unknown after restart/observation gap remains unconfirmed and is not automatically retried. A suppressed/inherited/exhausted unknown is no longer retry-eligible; fresh later work may proceed without relabeling or resending that earlier interval. Accepted/wait_return confirmation applies only to its own interval; a later batch does not claim earlier unknown work was consumed. A reserved but uncompleted attempt is conservatively bounded by the adapter's full 2 s lifetime before any retry eligibility. The helper remains one per hud-mcp, at most 2 s; reservations additionally serialize competing workers.

`wait_return` is recorded by the delivery worker only for actual events returned by a successfully completed in-process fixed-run delegate_wait page. Starting cursor/run alone does not prove a later page was returned; cancelled/failed waits and generic status calls cannot produce wait_return. The wait reader itself stays read-only.

### 幂等参数与查询顺序

`request_key` 是必填、区分大小写的 1–256 字符 opaque 字符串。对操作名和参数做版本化规范化：对象键递归排序，数组保留顺序，区分 null 与缺省，采用契约定义的默认值，拒绝未知字段和非有限数字；字符串不做 Unicode 归一化。`params_digest = SHA256(UTF8(canonical JSON))`。摘要覆盖 operation、backend/profile/source、role/model/effort、mode/layout、规范 `launch_cwd`（请求 cwd 经解析后的固定值）、请求显式 `originRepoId`、brief/report 路径、brief 内容 hash、resume 的 linkId/prompt hash（本地入口另含 expectedRun）、predecessor、显式授权/资源参数和解析后的后端档案指纹；不含 request_key、caller_id、MCP PID、当前时间、随机 runId/claim、写者追加的 declaredAt、易变 Git 探测结果、显示名或采集时间。缓存命中/缺失不改变同一控制请求的摘要。同样的文件路径但内容或档案已改变算不同参数，返回冲突，不偷偷重跑。规范化版本由 `params_version` 固定为 1。

（consult 5 增补，G03）`delegate_resume` 新增 `expectedRun?:RunId`，必须验证其 RunId 形状。上文“本地入口另含 expectedRun”现扩展为：MCP/local 仅在调用者实际提供时把 expectedRun 纳入 params_digest；MCP 缺省保留原 params_version=1 的参数规范化字节，不从准备快照或后来查询到的 currentRun 补值。“缺省”与“明确提供”是不同参数，本地 `--expected-run` 仍必填。

（consult 4 增补，F03）参数摘要中的 role/model/effort 是按 05 的 delegate.json v1 envelope/可选 roles 映射和本次明确请求解析后的实际值，连同非秘密档案指纹纳入 params_version=1 的规范化输入；角色名称不代替实际 model/effort，缺映射不能猜模型。配置解析成功不授予已验证能力；资源约束不在本期格式，不可先静默忽略再生成同参摘要（05 I-05-1/2；T-02-2）。

路径读取、摘要/hash、宿主 CLI、配置/进程/会话证据采集均在事务外完成；带着版本/指纹进入短 `BEGIN IMMEDIATE`，事务内重验 context 当前逻辑来源/代次、证据版本、owner/槽/冲突。外部 I/O 不占 SQLite 写事务，锁等待与重试受契约 [06](./06-observation.md) 的总响应预算约束；预算耗尽返回 busy/未接受，不提交动作。

（P065 私有存储元数据例外，2026-11-03）外部准备仍须在 SQLite 写事务外完成。唯一新增例外是受信入口既有私有存储门禁的固定同步元数据复验：实际取得 BEGIN IMMEDIATE 写锁后，在本次受保护的本地授权、canonical 重放、新意图准入或既有受保护写入之前，只可对原门禁的 HUD_HOME、ledger.sqlite、ledger.sqlite-wal、ledger.sqlite-shm 执行一次 lstat/realpath 元数据复验；每路径每种 API 至多一次，提前拒绝或 sidecar 确实不存在时可更少。保持 UID/eUID、规范绝对路径、对象类型、所有权、私有权限、无符号链接、文件单硬链接及原 home/main dev+ino 比较；存在的 sidecar 校验安全属性，不固定其全生命周期 inode，悬空链接不是不存在。原打开门禁必须随同一 Ledger 实例传递，不得在等待后重新钉住路径、以 ledgerId/缓存/监听器代替复验，或由 MCP/CLI 参数选择此权限。该例外不包含内容读取、hash、配置/来源/进程取证、/proc、目录扫描、宿主 CLI、网络、IPC、异步等待、重试或文件修改。门禁失败时不接受目标操作，不以该连接另写拒绝审计，不重新钉住或自动重试；完成必要回滚/清理，并拒绝继续使用已失效本地绑定的准入。其保证是打开前后与取得锁后的元数据观察一致性，不是文件系统命名空间与 SQLite 的原子绑定，也不新增对恶意同 UID 进程的隔离保证。

（consult 4 增补，F07）本调用的可信来源选择必须携带已捕获的 scope generation、证据版本、context 与目标 run/binding 前提；取得写锁后、查幂等或写入前仍须全部匹配。过时即 stale_context/identity_unverified，不临时重贴新 generation、不凭旧证据盲重试。原生子只拒本调用，不建立 root context、不兑换根 claim、不关闭根 scope/context/alias、不触发根换代；可信根来源变化才由同一 reconciler 事务失效旧范围/授权。跨 MCP 的当前 scope/context 以共享 B2 事务为权威，实例内 currentRef/invalidated 仅诊断；同根 MCP 重启/并发建代保持同 OwnerKey/未关闭代次，CAS 失败可要求新调用。新会话换代后旧实例不能复活旧授权，MCP 物理启动较晚不构成换代。合法旧代已 durable accepted 的意图保留原事实，仍按原票据在登记/提交重验，不抹掉接受或起副本；01 的 Claude /clear、双 MCP 和 Codex 原生子矩阵全部适用。外部取证仍在事务外，不能为修竞态把文件或 /proc I/O 搬入写事务。

上述 P065 例外仅复验既有 HUD_HOME/ledger 私有存储安全，不适用于当前调用来源、scope generation、会话记录或 /proc 证据；F07 的事务外取证与锁内前提比较不变。

1. 从本次已核验的当前 context 派生 canonical OwnerKey：已绑定 session；仅逻辑来源可辨且尚未绑定的 dedicated 用本代 proc。共享/缺来源/旧代先拒绝，不沿用连接上次身份。
2. 仅用 `(canonical owner_key, request_key)` 索引查询；params_version/digest 不符即 idempotency_conflict。同参只返回原 linkId/runId/outcome，动态状态另作 current 投影；uncertain 也不重新提交。
3. 无记录才校验并建立完整新意图。proc→session 归并是01的单独原子事务：核对两范围全部键；同键异参或异 link/run/outcome 整体回滚拒绝；完全相同结果合为一行。将旧行 UPDATE 重键到 session，origin_owner_key/原参数/结果/at 不变，写归并事件与 alias/context/parent_ref 后一起提交。

（consult 5 增补，G03）顺序固定为当前权限/捕获来源前提核验 → canonical OwnerKey×request_key 重放 → 新意图 CAS 与槽/能力门禁。同参旧结果在新轮已出现后仍先重放原 run/outcome；同键改 expectedRun 是 idempotency_conflict。仅无原结果时，所给 expectedRun 须等于事务内 currentRun，否则 expected_run_mismatch，零新 run/claim/slot/外部提交。省略只表示沿用事务选当前 run 的旧语义，不表示钉住先前 status 的轮次；仍重验 preparation→transaction 的 runSeq、目标 ref、绑定代次及档案前提，不能把旧准备材料贴到任意新 run。复用 A4 resumeGate/prepareResume，不新增 resume 状态机。

本地管理 resume 先按01鉴别 local_user 并从已确认 parent_ref 派生 canonical OwnerKey，再按相同索引查幂等；`--request-key`、`--expected-run`、`--mode` 必填，expectedRun/mode 进入摘要。同键同参先重放原结果；只有无记录的新意图才要求 expectedRun 仍是 currentRun，并重验03全部门禁。旧复制命令即使另换 key 也不能越过已发生的新一轮。accepted 事件保存类型化 actor；登记/提交执行票据核对该意图的 MCP 当前权限或 local_user 管理权限，不能强求已失效的旧父 context 来冒充本地发起者（T-02-34）。

归并后不双写、不反查关闭 alias；正常重试只查 canonical key。归并与并发接受在 SQLite 写事务串行；同参不同 run 不能合并。该重键例外只改变索引范围，不能覆写原结果。


拒绝事件在有效事务中提交；失败的意图事务先完整回滚，再单独记录拒绝，不留下半个 run/slot。幂等接受记录不覆盖、不自动过期。槽忙的请求可持久化 rejected outcome（无新 run）；同 key 以后仍返回该拒绝，要在槽空闲后提出新请求必须显式换 request_key。这属于新的意图，不是重放旧动作。

拒绝审计不是无条件补写：P065 原预算耗尽、存储证明失败或提交结果未明时，不启动新的拒绝审计事务。保留主要拒绝及已存在的持久事实；本地业务拒绝的可选审计仍须在同一剩余预算内重新验证原存储绑定。

（NOTIFY 增补，A3）容量校验在 acceptIntent 的同一 BEGIN IMMEDIATE 内，沿用既有当前授权/捕获来源前提 → canonical OwnerKey×request_key/digest → 同参原结果重放的顺序；已满也先重放。只有新意图才按本 ledger/HUD_HOME 全局及当前 owner 计数 starting/running/cancelling/uncertain，默认 limits.maxActiveRuns=6、maxActiveRunsPerOwner=4，并同事务预留 starting。超限完整回滚，返回 `{ok:false,code:'concurrency_limit',active,limit,occupants:[{runId,linkId,state,since,holder:'self'|'other',retireEta:number|null}],retryAdvisable}`，不存幂等行；这是暂时拒绝，不沿用上文 slot_busy 可持久拒绝规则。所有未终态（包括报告完成但仍活、宽限中的可见子、uncertain）继续占容量及原槽，只有 R-02 证实终结才释放。全为调用者自己的未终态子（嵌套耗尽）或存在 uncertain 需对账时 retryAdvisable=false；等待/取消/内联或对账，不循环重试。此 cap 不限制原生 subagent、shell 子进程、waiter/helper，其预算另计。

## 不变量

`DB` 仅表示下文 PK/UNIQUE/CHECK/FK/触发器直接约束的结构；`TX` 表示写者事务的校验；`E` 表示还依赖进程或外部回执。不能声称 SQL 自动证明授权或外部事实。

| 编号 | 可检查的断言 | 层 / 测试 |
|---|---|---|
| I-02-1 | canonical OwnerKey×request_key 持久幂等，同参重放、异参拒绝；MCP 重启不绕过。归并原子重键且原 outcome 不变，原范围可审计；不复制结果或扫描关闭 alias；查幂等前先锁内重验本调用捕获的 scope generation/证据版本/context/目标 run/binding，过时拒绝且不重贴代次（consult 4 增补，F07）；（consult 5 增补，G03）当前授权及来源前提仍先于幂等；同参重放先于新意图 expectedRun/槽/能力门禁，旧 run 已非 current 也返回原结果 | DB+TX+E；T-02-1–5、27 |
| I-02-2 | 已接受操作的 link/run(starting)/claim/idempotency/slot 与 typed actor 的 accepted 事件同事务；resume 复用 link 新增 run，失败不留部分意图；逐 run launch_cwd/project_origin 冻结，workspace只首次捕获；事务外才启动/Git采集 | DB+TX；T-02-6、7、30、31、32、34 |
| I-02-3 | 每实际 SessionRef 一个槽、每 run 一个槽；仅持槽且成功消费本轮执行票据的执行者能提交命令；不能因 MCP 重启或超时重发票据 | DB+TX+E；T-02-7、8 |
| I-02-4 | provisional 只给全新会话首次 spawn；resume/predecessor 必须有真实 ref。身份解析后同事务换真实槽；冲突时两 run 都 uncertain、保留各自槽、停止进一步启动/续跑，等待对账 | DB+TX；T-02-9、10 |
| I-02-5 | starting/running/cancelling 出现提交结果不明、托管失联或证据冲突即 uncertain；正常 reserved 意图在未登记 supervisor 的有界窗口保持 starting，已确认 supervisor 死亡优先于残留 fresh 心跳；uncertain 保留槽；API/等待超时不改状态 | TX+E；T-02-8、11–13、19 |
| I-02-6 | failed 只表示已证明未执行；已执行且退出码非零是 ended 并保留失败结果，不伪装成可重试的未执行 | TX+E；T-02-12、14 |
| I-02-7 | cancel 接受与退出 chronology 分离；R/Q 且无 X 时 before_exit 才 cancelled，未知为 ended+cancel_timing_unknown、释放槽；after_exit 才解释 already_ended；未证结束仍持槽 | TX+E；T-02-13、15、16 |
| I-02-8 | 对账先按下文证据归一与事实时序再命中 R-02；实例/代次/事实时间须可验证，保留不可逆证明、未解决冲突及增量 terminal basis，不以导入/commit 时间消除反证；缺证不补码/盲重试 | TX+E；T-02-12–17、35 |
| I-02-9 | 只有 hud-mcp/hud-run/reconciler 写 ledger；初始意图外的身份回填与状态迁移经 reconciler，hud-run按事件追加证据、周期只用一次runs CAS写H元组，HUD只读。state+槽释放+事件同事务；原生子拒绝不改根 scope/context/alias/claim/代次，只有可信根变化才经共享 reconciler 事务失效旧范围及授权（consult 4 增补，F07） | DB+TX；T-02-6、17、25、29 |
| I-02-10 | 运行槽无 TTL，只凭确认终结释放；browser 等结果且对账才释放，collect 只在06观测存储换代接管，三者不得混用；后两类的阶段边界见下文 | TX+E；T-02-10、20、23 |
| I-02-11 | predecessor 原子转交同一实际 child，同 owner、空槽/无冲突、唯一当前父边，旧 link 历史化；MVP 跨 owner 一律 unsupported | DB+TX；T-02-18；03 T-03-20 |
| I-02-12 | wait 入场固定 runId/已提交游标；旧 run 不满足新 wait。有效上限适配客户端实测工具超时并留余量；超时/断线不制造终态或取消 | DB+TX；T-02-19 |
| I-02-13 | 父 MCP 断连不代表子结束；默认 orphan_policy=continue，stop 也经取消与退出证明；活跃 headless 只看日志，不启动可见副本 | TX+E；T-02-16、24 |
| I-02-14 | schema v1 可在 node:sqlite 空库执行；连接启用 foreign_keys、WAL 与短 busy 等待，总重试预算归06；更高 user_version 拒写，JSON 只导出 | DB+TX；T-02-25、26 |
| I-02-15 | 新轮不得覆盖已知 child/target 或缩范围；结束与原生结果分离。普通范围外工具仅诊断，已证实原 harness/同 SessionRef 旧写者仍活则是阻断冲突；不得复用 | DB+TX+E；T-02-14、28；03 T-03-8、9；04 T-04-5–7 |
| I-02-16 | ledgerId 单行初始化/不可变，独立新库不同；params_digest 含launch_cwd/显式originRepoId/本地expectedRun，不含Git结果/declaredAt/显示名/捕获时间；公开导出归07/B18；（consult 5 增补，G03）expectedRun 在 MCP/local 实际提供时才入摘要；缺省编码及 params_version=1 不变，本地仍必填；新意图 CAS 不符零新 run/claim/slot/提交 | DB+TX；T-02-30–34 |

## 状态机

### 意图、执行权与外部提交

初始 link.pending/run.starting 是创建记录；其余关系/运行迁移均调用 reconciler 事务入口。hud-run 可在同一进程中调用该入口，但不得自己用另一套规则改 state。

1. **准备**：事务外核验档案/source、路径/摘要与能力；MVP resume 仅 bound/reported、current_owner、同 owner/同任务、真实 child、空槽/无冲突；predecessor 仅旧 link 当前且同 owner。事务内重验快照，不从历史 handed_over 重新转交。
2. **原子意图**：幂等查找后新建 pending link 或保留 resume 的既有关系；同 owner handover 把旧 link 历史化、新 link 对同 child bound。新 run starting/握手 pending、claim、幂等、槽、accepted 事件同事务。返回持久 accepted/starting，不等 ready/模型/完整绑定；accepted→started/bound 延迟另依06计量。
3. **登记执行者**：仅交付一份随机票据；唯一 supervisor 校验 slot/ticket、starting/reserved、类型化发起权限（MCP 当前 context 或01的 local_user）、无取消/冲突/围栏，CAS 消费票据、登记 ProcessStamp/H 并 arm claim，同事务追加唯一且不可变的 `supervisor.registered` 事件。事件以 run_id/link_id 锚定，payload 为 `{sourceId,bindingGeneration,supervisor:{pid,proc_start,boot_id,pid_domain}}`；与 runs/claims 的 pid/start 及目标代次一致，包含的四字段来自登记时已核验实例。恢复以此提交记录为权威；meta 在事务外写且仅作副本，事件缺失/不完整/矛盾时保持 unknown，禁止用当前 boot/域补齐。复用既有 events，不增表/列或周期事件（04 T-04-42、43）。竞争失败者零 backend 调用；恢复不重领票据，不取得执行权。
4. **单次提交与封口**：原 supervisor 重验意图/授权/范围能力，先持久 submitting 再调用一次 spawn/宿主提交；成功证据才 submitted，未知不重发。协议只规定单次执行与可证封口，不强制独立 gate、RUN 消息或 helper 拓扑。持久 submission_fenced_at 禁止未来提交；判断结束/未执行还须证实所有可能再产生工作的 launcher/控制通道已封口或死亡。中间 shell 的延迟/循环/后台分支同样是 launcher；任意 shell 文本不自动获得 managed 能力，支持档案仅经验证的单次前台启动。
5. **绑定与槽迁移**：首次全新会话才占 provisional，不隐式 attach/resume。01 证实 ref 后原子换真实槽/写 binding/父边；若真实 ref 已占槽，两 run uncertain、各自槽保留，并以该 ref 阻断新操作。已发生的启动不能撤回；后续提交检查失败，先对账/授权取消。
6. **结束**：reconciler 按唯一 R-02 表同事务写终态/terminal_evidence/ended_at、撤销 claim、释放槽并发事件。exit_code/exit_signal 只来自带 subject=harness 与明确来源的原生结果；未知均 NULL，shell_status/shell_signal 单列。无 MCP 身份绑定不阻独立运行终结。

launch_phase 为 reserved→armed→submitting→submitted；确证未执行且封口后才可 never_submitted。submitting 不证明执行或未执行，不能因 DB 围栏就把已获许可且暂停的 launcher 算已封口。进程恢复只观察/收尾，不重置票据/阶段。生产实现、锁等待、accepted/started 两种时延分别验收，预算归06。


### 证据定义与完整对账表

#### 证据归一与事实时序

先核验 evidence 的 run/source/绑定代次、supervisor、boot/PID 域及固定 scope；错实例、错代次、未接受证据仅审计。再形成带 `asOf:number|null` 的归一事实。scope 的 asOf 来自 ScopeCheck.checked_at；R 来自最终回执的终结证明时间 ended_at；Q/N 来自复合证明所确立的事实边界；H 来自该 producer 的 heartbeat_at，seq/单调钟用于核验当前性。observedAt/recorded_at/validated_at/events.seq 不能替代事实时间，也不能因发现晚而取得事实优先级。asOf 及其来源可存既有 evidence.payload，不要求新增 SQL 列。

只有经核验可比较的时间才可用于先后关系；缺失、无效、未来时间或时钟异常不能用导入时间补序。必要时保留 unknown/clock_anomaly 并拒绝据此释放槽。相同时间不是任意选一条的许可：alive 与已证明 gone 等互斥实质事实为 X；unknown 与一个已知观察同刻但无法再定序时，当前 G 取 unknown，不凭缺证制造 X。独立完整 R/Q/N 仍可按下述不可逆证明规则采用。

同一事实主体的 scope/H 观察先按有效 asOf 约简，再进入唯一 R-02 首条命中表。新的 scope unknown 替代更早的当前活性判断，不能退回旧 alive 以满足 R-02-5；H 同样不能因旧心跳晚导入而恢复 fresh。严格早于有效 R/Q/N 证明的普通 alive 观察是历史，不再否定后来结束，原 evidence 保留在审计中。

R/Q/N 的不可逆证明、已证实 supervisor 死亡、已提交/已启动事实和未解决冲突不是可以统一“取最新一条”的快照。完整 R/Q/N 成立后，目标 workload 或同实例的未封口 launcher 在该证明事实时刻或之后仍 alive/可提交的反证必须归一为持久 X；N 不因其 non_execution 分类而例外。随后一个 unknown、gone 或另一份回执不能静默删除这个冲突。按既有 conflict_resolved 规则显式解决。未知原生退出结果不与有来源的已知结果矛盾；两个互斥的已知原生结果仍是冲突，不按到达顺序取一份。

一次后来的不可读/unknown 不单独否定已成立且封口的 R/Q/N；但不能忽略已存在的同实例反证或无法排除的时序冲突。既有终态按 R-02-0 不重开，新的矛盾继续阻断该 ref 新操作。增量调用也必须带入已存终态的证明边界/结果及未解决冲突，不能只拿新 evidence 判断“没有冲突”；terminal_evidence_id 指向的证据是该基准。需要多个证明时保留其必要边界及引用，不能用较晚导入/对账时刻覆盖较早已采用的终结证明。runs.ended_at 只有确实保存相同证明边界时才可充当这一快捷输入。

最小反例：

| 已接受事实 | 结果 |
|---|---|
| alive@10，完整 R/Q@20；alive 到 90 才导入 | alive 留审计，R/Q 可终结；导入顺序无关 |
| R/Q/N@20，alive@30，随后 unknown@40 或 gone@50 | X 继续存在；未终态 uncertain/持槽，已终态不重开但阻断新操作 |
| N@20，gone@20，alive@30，gone@40（包括乱序导入） | 持久 X；活跃 run uncertain/持槽/禁新操作。已 failed 后增量收到反证时不重开、不重新占槽/发完成，但持续阻断新操作，后续 gone 不解除 X |
| alive@10，unknown@20，无 R/Q/N | G=unknown，不能借旧 alive 回 running |
| 已成立 R/Q/N@20，随后只有读取 unknown@30，无反证 | 保留不可逆证明；R/Q 的取消分类按 E02，N 仍须满足 R-02-4 |
| alive 与结束证明同刻，或关键活性证据无法与证明定序 | 不以 ID、数组位置或 observedAt 选赢家；冲突/缺证按表阻断 |

适用状态集合 `A={starting,running,cancelling,uncertain}`，终态集合 `Z={ended,failed,cancelled}`。下表按编号从上到下命中第一行；`*` 表示任意值，最后一行覆盖所有未列组合，因而每个 state×evidence 都有结果。每次迁移附采用/拒绝的 evidence ID 和事件；外部旧实例/错 generation 的证据先丢到审计，不参与当前判断。

- `R`：04 的最终 scope 退出回执，绑定本 run/启动实例/boot/PID 域与固定的真实 harness PGID。可信启动记录、所有可能 launcher 封口/死亡、原 harness 不再执行、完整 scope 无活 workload 且无 X 才可终结；原生退出结果可未知。shell-only 退出不是 R，shell 的 0/130/137 不填 runs.exit_code，也不推原生信号。
- `G=alive/gone/unknown`：核验声明 scope 的正确 boot/PID 域与实例。alive 是尚有可执行 workload（含 S/T/D）；Z 为已终止未回收、单列而不算活成员。gone 须完整无活 workload + 原 harness 不执行 + 全部 launcher 封口/死亡，不强求原 leader receipt。仅 PID 消失、pane 消失、EPERM、跨域不可见或实例可复用均 unknown。同机已确证跨 boot 时旧实例终止，不把旧 PGID 对到新 boot；需核验全部启动通道仅属旧 boot 或已封口。普通范围外工具不扩大 scope；确证原 harness 或同 SessionRef 的旧写入实例仍在范围外执行则 X/未决冲突阻断复用。
- `H=fresh/stale/unknown`：仅匹配 supervisor 实例的心跳；5 s 一次逻辑 UPDATE，now-heartbeat_at>30000 为 stale，等于边界仍 fresh；时钟异常 unknown。无 H 用创建时刻检查启动挂起，不能凭 stale 判结束。
- `N`：可信记录证明未提交目标工作，永久围栏已提交、全部可能 launcher 不再能提交且无相反启动证据，G=gone。预检日志、暂停的 supervisor 或一个失败 shell status 单独不足。
- `Q`：无正式 R（包括 supervisor SIGKILL、从未留下 leader/exit receipt），但持久可信启动记录固定 scope，全部 launcher/通道封口或确证死亡、原 harness 实例不执行、正确 boot/PID 域完整无活 workload、无 X。reconciler 写复合证据，以未知原生退出结果终结，不补写死人 exit.json；部分有来源观察保留 evidence。
- `C`：取消已鉴权接受，与 chronology=before_exit/after_exit/unknown 分开；unknown 不等于 false。before_exit 须有可信正向证明；cancel_requested_at < ended_at、发过信号或晚到回执均不足。互斥已知证明同时有效且未解决构成 X。
- `X`：同实例的结束声明与活 workload/未封口 launcher 冲突、N 与已提交/启动或其事实时刻及之后的目标 workload/未封口 launcher 冲突（后续 gone/unknown 不清除）、SessionRef/实例争用、provisional 冲突，或确证范围外原 harness/同会话旧写者仍活；旧实例证据仅审计，陈旧 H 本身不否定完整 R/Q。


| 行 | 当前状态 | 证据组合 / 前置条件 | 唯一允许的结果与槽动作 | 测试 |
|---|---|---|---|---|
| R-02-0 | Z | 匹配的重复回执，或旧实例/旧 run 证据 | 保持终态，不重开、不重发；错误实例仅审计。若出现新的同实例矛盾（含 failed 的 N 反证），记持久 conflict 并阻断该 ref 新操作，需人工对账，不能自动覆盖旧终态 | T-02-17 |
| R-02-1 | A | X=true（含 R/Q/N 的持久反证），其他任意 | uncertain；持槽，禁止提交/续跑；人工 hud run reconcile | T-02-9、13、17 |
| R-02-2 | A | X=false，完整 R 或 Q，取消已接受且 before_exit 已证明 | cancelled；终态事务释放槽，原生结果仍可 NULL | T-02-15 |
| R-02-3 | A | X=false，完整 R 或 Q，未满足 R-02-2 | ended；终态事务释放槽。取消已接受而时序未知附 cancel_timing_unknown；仅已证明 after_exit 才附 already_ended 取消解释；非零退出仍 ended | T-02-13、14、15 |
| R-02-4 | A | X=false，N=true，无已执行证据，且无该 N 事实时刻及之后的目标 workload/未封口 launcher 反证 | failed（non_execution）；释放槽；原请求重放仍返回原记录，重新执行必须是显式新意图 | T-02-12、14 |
| R-02-4a | starting | X=false，launch_phase=reserved，票据未消费且 supervisor/heartbeat 均为空，创建后≤30 s，意图与运行槽占有完整且无取消；正常等待 supervisor 登记 | 保持 starting，不要求不存在的 supervisor/child 存活证明；只允许原票据一次登记。窗口后无证明走 R-02-9，不能重发票据 | T-02-8、11 |
| R-02-5 | A | 无结束/未执行证明，supervisor 未被确认死亡，H=fresh 且 G=alive（已核验本轮范围），已核验本轮子进程启动；取消已接受/未接受 | cancelling / running；均持槽。已确认死亡不匹配本行，必须走 R-02-6；不重启 harness | T-02-13、16 |
| R-02-6 | A | 无上述证明，supervisor 死亡或 H=stale（包括 G=alive） | uncertain；持槽；探查/记录组存活，不释放，不把 child 活着当成新 supervisor 的执行权 | T-02-13 |
| R-02-7 | starting | launch_phase=reserved/armed，持票据的执行者实例有效、启动观测≤30 s，尚未提交且无取消/矛盾 | 保持 starting；仅原执行者可继续一次提交。纯启动心跳不能推 running | T-02-8、11 |
| R-02-8 | cancelling | 无终结证明，取消通道/匹配 supervisor 仍有效，未触发失联或矛盾 | 保持 cancelling；可以继续同一次取消序列，不释放槽 | T-02-16 |
| R-02-9 | A | 其他所有组合：无回执，G=unknown；只有进程消失；预检无围栏；提交响应丢失；“什么也证明不了” | uncertain 并持槽，提示人工 `hud run reconcile <runId>`；人工命令仍须提供本表证据，不能按按钮强行认定结束 | T-02-11–14 |

API/host/wait 的超时只返回当时状态，不制造状态迁移；上述 stale 心跳是在 reconciler 接受“托管失联”的独立观测后进入 uncertain，不是把 wait 超时当失败。原始 evidence 只追加；reconciler 记录验证结果及采用证据，不能用模型自述或截图补回执。终态重复事件不重复释放/报完成；同实例新矛盾通过未解决 conflict 事件阻断新请求，其解决事件须引用 conflict 与被撤销/补充的证据。

取消请求是否已鉴权接受与取消相对结束的 chronology 分开。chronology 为 before_exit / after_exit / unknown；unknown 不等于 false。X 的优先级不变。无 X 且完整 R 或 Q 成立时，只有已接受取消且 chronology=before_exit 才命中 R-02-2/cancelled；其他情况命中 R-02-3/ended，均在终态事务释放槽。已接受取消但 chronology 缺失或 unknown 时，同时记录 terminalNote=cancel_timing_unknown；不得声称 cancelled 或 already_ended。after_exit 已证实时才可把该取消请求解释为 already_ended。

未成立 R/Q/N 时，取消仍为 cancelling/uncertain 并持槽；scope 不明、未封口或 X 不受本例外放行。历史取消通道失败本身不否定后来完整的 R/Q。N 仍按 R-02-4 产生 failed(non_execution)。terminalNote 只说明终态分类时的证据缺口，不表示阻断冲突，不改变共享终态谓词或其他 resume 门禁。若 before_exit 与 after_exit 两个互斥的已知证明同时有效且未解决，则按同实例证据冲突 X 处理；只有 unknown 不构成这种冲突。

`terminalNote:'cancel_timing_unknown'|null` 随既有终态事件的白名单 payload 保存，status 对返回的那个 run 投影此说明。它不是 Reconciliation.cause，不生成待人工解除的阻断，不新增 runs 列。R-02-0 保留既有终态与原结束决定；迟到时序证据只追加说明/审计，不自动 ended→cancelled，不重新占槽或再次发完成事件。未知时序说明描述的是当时分类依据，不能被解释为已证明取消先后。

（NOTIFY 增补，A2）R-02-2 的 cancelled / before_exit 分类仅适用于用户发起的已接受取消和既有 orphan_policy=stop；policy retirement/runtime limit 不命中该行，完整 R/Q 且无 X 时按 R-02-3 ended。R/Q/N 和 X 的证据门槛、N→failed(non_execution)、R-02-0 不变。终态事件白名单新增 `termination`，独立保留任务结果、请求原因、实际结束与归因：

```ts
type Termination = {
  outcome: 'completed'|'failed'|'blocked'|'unknown'; // 最新可归属于本 run 的已接受报告；映射见下文
  requestedCause: 'user_cancel'|'retire_after_report'|'retire_idle'|'retire_blocked_wait'|'runtime_limit'|'orphan_policy'|null;
  observed: {exitCode:number|null; signal:string|null; escalatedTo:'INT'|'TERM'|'KILL'|null; scopeEvidence:'R'|'Q'|'N'};
  attribution: 'caused'|'not_caused'|'unknown';
};
```

（NOTIFY 增补，A2）termination.outcome 明确按最新可归属于本 run 的已接受报告映射：completed→completed、failed→failed、blocked 或 interrupted→blocked；无报告或报告不可归属于本 run→unknown。Report 自身的 status 保留 interrupted，03 四值枚举不变；只在 termination 归一，运行时映射由 B3/B19 实现。

（NOTIFY 增补，A2）retire.requested 只存意图。scope 在首次信号时仍活且后续结束的合格证明才 attribution=caused；已先自然结束为 not_caused（保留意图审计）；其余 unknown，并附 terminalNote=retire_timing_unknown。terminalNote 的完整内部词表现为 `'cancel_timing_unknown'|'retire_timing_unknown'|null`，只存既有终态事件，不加 runs 列、不回写不可变 exit.json、不将任务 completed/failed/blocked 混为运行终态；旧读者未知 note→null，出口见 07。

（consult 6 增补，H06）当前 visible 合法取消意图可接受而交付不可用；记录 cancel.unconfirmed / visible_scope_control_unavailable，零 INT/TERM/KILL/单 PID 降级/升级计时器。fresh/live 可仍 cancelling，只有命中对应 R-02 条件才 uncertain；后来完整 R/Q 仍按已接受用户取消 chronology 分类，无时序证明的正常结束为 ended+cancel_timing_unknown 并释放，不能因拒信号永久持槽。安全目标对所有模式一致，具体规则见 04。

### 取消、等待与禁止重试清单

取消只在短事务保存已鉴权意图/accepted 与 cancelling 事件，响应不等待信号阶梯；hud-run 异步封口全部启动者，再对已核验本轮整个 scope 执行 `SIGINT → grace(默认10 s) → SIGTERM → SIGKILL`。每一步重新确认实例与完整范围，不能向复用 PID/PGID 发信号；不能安全控制整组就 cancel_unconfirmed，禁止悄悄缩成单 harness PID。发信号成功不是退出回执；取消通道失败/信号后未知存活且无完整 R/Q/N 时进入 uncertain；历史通道失败不否定后来完整 R/Q，最终按 R-02-2/3/4 分类。默认 orphan_policy=continue；stop 与显式 cancel 使用同一状态机。取消与终态/提交相争时先取得写事务的一方确定围栏，迟到取消不能重写已结束结果。

wait 的 linkId 在进入时解析并固定当前 runId；afterSeq 只推进到本次实际返回的已提交事件。没有新事件而超时，返回同游标、当前状态，不写 ledger。有效上限为 min(协议上限120000ms, 客户端实测 tool timeout−安全余量)，配置/协商与预算归05/06；不满足则短 wait，保持同 run/游标续等。通知合并与恢复触发见03/04；父 pane 自动提示延期。

以下情形**禁止再次提交外部启动/send**；允许同 key 重放查询、status/logs/wait/reconcile，不允许通过换 MCP、换账号、换宿主或新 key 自动绕过：

| 编号 | 禁止重试条件 | 允许的后续动作 / 测试 |
|---|---|---|
| D-02-1 | run 为 uncertain、提交/启动响应丢失、MCP 在外部启动后回写前死亡 | 原 run 对账，不能换 key 自动起副本；T-02-3、11–13 |
| D-02-2 | supervisor 失联/死亡但组仍活，或无可靠终结证据 | 观察、经授权取消、对账；槽继续持有；T-02-13、16 |
| D-02-3 | 槽非空、provisional 冲突、活跃 headless 被请求打开 | 只读日志；监督故障禁 input/focus/fg/自动恢复/resume；T-02-9、18、24 |
| D-02-4 | 同键异参、alias 冲突、身份未证实、旧代、跨 owner | 拒绝/审计，先解决冲突，不能自动换 key；T-02-2、4、5；03 T-03-20 |
| D-02-5 | Herdr 等宿主已收到命令后超时或断连 | 对账原 locator/run；只有可靠预检证明未提交且 N 成立，才允许用户提出明确新意图/选择核心宿主；T-02-11、14 |
| D-02-6 | 阶段 C 前调用 Jev send/浏览器控制 | unsupported；未来同 external key 不重发，未知结果先对账，租约语义如下；T-02-20 |
| D-02-7 | cancelling 未确认退出、父断连、report 或 UI done/关 pane | 继续取消/对账，不能把呈现/报告当结束；T-02-15、16、24 |

### 三类租约

运行槽无 TTL，R/N/Q 确认结束才释放。浏览器按实际 browser:<cdp_url> 实例而非账号共锁，needs_human、结果未知、TTL 过期或本地 runner 死亡不能释放；须 answered/failed 且外部结果已对账，无未决 send。collect:<session> 只在06观测存储，过期可 generation+1 接管，旧代 checkpoint/摘要迟写拒绝。三类资源不可共用过期即放行逻辑；browser 的具体存储/控制在 C 前定稿，MVP 不创建其表/正向执行入口。

C4 的未来 `holderLabel?: string` 由实际 lease owner/job 身份在同一读取投影派生，C5 消费；无可公开的匹配显示名则省略。label 不参与 browser resource/holder 判等、generation 或释放；改名只改投影，不另存所有权。当前 schema v1 不加 browser 表或 holderLabel 列，不做 MVP 正向样例；浏览器租约契约在 C4 定稿，02 当前只规定释放原则。

### Deferred（v1.1 / C 前 / 后续）

跨 owner grant 协议及 handover_grants、close surface 事务及 owner_epoch 耦合整体推迟 v1.1；MVP 无内部签发/消费/关闭入口，跨 owner 与 close 一律 unsupported。closed 仅历史/未来语义见03。无 MCP 的 observe_only 正向绑定推迟 v1.1，MVP 无 caller binding 不授权。共享正向多 context 调度、cgroup provider、sidecar managed、自有 PTY 推迟后续；不在本版 DDL/正向验收中冻结。Jev jobs/browser leases 的 DDL、实现及正向测试移 C 前，当前只保留三类租约语义和拒绝规则。父 pane 自动提示、完整 fork 谱系、通用 ask/send 与更多布局沿用既定延期。


## 失败案例

| 编号 | 场景 / 预期 | 不变量 | 测试 |
|---|---|---|---|
| F-02-1 | 并发同键、同键异参、MCP 重启换 CallerId、alias 归并冲突 → 重放或拒绝，零重复提交 | I-02-1 | T-02-1–5 |
| F-02-2 | 在事务每个写点或 commit 后崩溃 → 全回滚或完整意图，不能半槽/无意图启动 | I-02-2、3 | T-02-6–8 |
| F-02-3 | 首次spawn解析到占槽ref/provisional失联，或后续轮解析不同child → 冲突uncertain，保留占有，不改既有ref | I-02-4、10、15 | T-02-9、10、28 |
| F-02-4 | host 已发命令但超时；预检日志不证明未提交；launch 后写回前崩溃 → uncertain，不 fallback 再启动 | I-02-5、6、8 | T-02-11、12、14 |
| F-02-5 | 心跳停>30 s、组仍活/未知/可靠 gone；退出回执与活组矛盾 → 按表迁移，不猜退出码 | I-02-5、8 | T-02-13、14、17 |
| F-02-6 | 取消已发送但未退出、PID 重用、取消与退出竞态 → cancelling/uncertain 或已结束；不提前释放 | I-02-7、8 | T-02-15、16 |
| F-02-7 | predecessor 并发、旧 owner 知道新 link、环或 busy 槽 → 唯一新父边或拒绝，历史保留 | I-02-11 | T-02-18；01 T-01-22 |
| F-02-8 | wait 中出现新 run、旧 run 迟报、长轮询超时 → 固定 run/游标，不变终态 | I-02-12 | T-02-19 |
| F-02-9 | 阶段 C 前调用 Jev；把 browser 失联/TTL 当释放 → 前者 unsupported，后者违反保留语义 | I-02-10 | T-02-20 |
| F-02-10 | collect 接管/旧代迟写或试图混入运行槽 → 仅06观测存储新代可写，MVP 无共用租约表 | I-02-10 | T-02-23 |
| F-02-11 | 父退出/关 pane、活跃 headless 打开可见、report 当完成 → 不释放、不启动副本 | I-02-9、13 | T-02-24 |
| F-02-12 | SQL 缺外键、双槽/双父/双alias、未知 schema、HUD 写 ledger → 结构拒绝或拒写，不降级到 JSON | I-02-9、14 | T-02-25、26 |
| F-02-13 | 共享/原生子/缺来源调用试图沿用上次 root owner → 拒绝，无幂等查询/报告权限 | I-02-1；01 I-01-12 | T-02-27；01 T-01-35、36 |

## 测试清单

每项标 A9 fixture（规格/表驱动输入）、A9 prototype（真实临时 SQLite + 合成进程）或 B（生产验收）；不表示本批已实现/实跑。B2/B3/B4/B5/B6/B14 重验关键反例与完整能力矩阵。原型使用临时 HUD_HOME/source 和只追加一次计数的合成命令，不调模型；不能只在内存对象模拟互斥。consult 4 增补的并发断言由 B2/B5 定向生产重验，不重开或追认原 A9 门禁。（consult 4 增补，F07）

| 编号 | 输入 → 预期断言 |
|---|---|
| T-02-1 (A9 prototype) | 两 MCP 同 OwnerKey/key/params 并发 spawn → 一条幂等记录、一个 run/slot、两次回复同 link/run/outcome；合成提交计数=1；同源同根双 MCP 并发首次建 scope/context 时共享 B2 CAS，输家可要求新调用，不能各自造“当前根”或重复兑换（consult 4 增补，F07） |
| T-02-2 (A9 fixture) | 同 owner/key 修改 operation、brief 内容、mode、prompt 或 profile 指纹 → idempotency_conflict；不同 OwnerKey 同 key 可有独立记录；规范化对象键序不改变 digest；05 roles 解析后实际 role/model/effort 与非秘密档案指纹改变即异参，配置键序/等价解析结果仍同参；缺映射不按角色名称猜模型，资源约束未知键拒绝而非忽略（consult 4 增补，F03） |
| T-02-3 (A9 prototype) | 父 harness/session 保持存活，MCP-a accepted 后退出再启动 MCP-b，新 CallerId 验证同 session OwnerKey，重放相同 key/params → 同原 run/outcome，idempotency 行数不变，提交计数=1；另在外部提交后、返回前杀 MCP 重复一次；并发首绑/重绑共享未关闭代次，换代后旧 MCP 不复活授权；合法旧代已 durable accepted 意图仍保留原 run/票据且登记/提交重验，不伪称未接受/重发（consult 4 增补，F07） |
| T-02-4 (A9 prototype) | proc 先 accepted，独立 bound 证据归并 → UPDATE 原子重键，结果/at不变、origin_owner_key 留原范围，只一行；MCP 重启/关闭 alias 后同 session 重放同原结果，新代 proc 不借旧范围 |
| T-02-5 (A9 prototype) | proc/session 两范围同 key 异参，或同参但不同 run/outcome，或同代 alias 双 session → 拒绝整个归并/操作，有 conflict 事件，零新 run/提交，不按时间挑选 |
| T-02-6 (A9 prototype) | 每个 insert 及 commit 前注入崩溃 → 未提交时 link/run/claim/idempotency/slot/events 全无；提交后全部可见。再模拟 terminal 事务中断 → 不出现“state 已终结但事件/槽提交一半” |
| T-02-7 (B) | 不同 key 两进程同时 resume 同 child ref → 仅一 run 占槽并提交，另一 slot_busy；同 run 尝试两槽、同实际 ref 两 run → SQL UNIQUE 拒绝；（NOTIFY 增补，A3）并发竞争最后容量仅一新意图；已满同参重放成功，超限无幂等行，嵌套/uncertain 占用完整投影并禁止循环重试 |
| T-02-8 (A9 prototype) | 意图 commit 后、supervisor 登记前先跑 reconciler（age=0/30000/30001 ms），再两 supervisor 同票据竞争；armed/submitting 各崩溃 → 前两组保持 starting 并可一次登记，超窗无证 uncertain；不得重置票据，never_submitted 围栏后迟到提交=0，纯心跳不升 running |
| T-02-9 (A9 fixture) | 两 provisional 分别解析到同实际 ref，或一个 provisional 碰已占实际槽 → 第一个迁移原子完成；冲突时两 run uncertain，各槽保留，无进一步启动/resume；即使既有进程仍活也不能宣称动作已撤回 |
| T-02-10 (A9 fixture) | provisional 无 child_ref 时 heartbeat stale；resume/predecessor 缺真实 ref → 前者 uncertain 且槽保留；后两者拒绝，不能新分 provisional；有可靠终结证明后 provisional 才释放 |
| T-02-11 (A9 fixture) | request/wait/host 超时分别发生在提交前/已提交后 → timeout 自身不改状态；收到提交不明证据后 reconciler uncertain，绝不 fallback；R-02-7 有效启动仍 starting |
| T-02-12 (A9 prototype) | preflight 证明 never_submitted+提交围栏+G=gone，与仅日志报错/只有 supervisor 非零退出两组对比 → 前者 failed，后者 uncertain；命令执行后回写前崩溃=uncertain 且计数不再增加 |
| T-02-13 (A9 fixture) | H=30000/30001、G=alive/gone/unknown、R/N/Q与supervisor死亡逐行命中；事实时间归一、同刻known+unknown取G=unknown不伪造X，alive+完整gone才X；取消缺失/unknown+R/Q为ended+说明并释放，unknown可由有效已知证明补足且不依数组顺序，before/after互斥为X；无结束证明仍持槽 |
| T-02-14 (A9 prototype) | R 有来源 native code0/7、R 无 native 但 shell0/137、N、Q 无任何旧 writer receipt → ended/ended/ended(NULL)/failed/ended(NULL)；S/T/D 成员阻终结、Z-only可终结；跨 boot 不查旧PGID，范围外原harness/旧写者仍活则阻复用 |
| T-02-15 (A9 prototype) | 取消接受后确证仍活再结束→cancelled；信号后仍活→cancelling/uncertain持槽；已证明exit早于cancel→ended/already_ended；完整R/Q但时序未知（含实际SQLite写锁使退出先于接受、无可用时序证明）→ended+cancel_timing_unknown、释放，绝不伪造confirmed/already_ended；缺任一结束条件仍持槽；（NOTIFY 增补，A2）用户/orphan stop 取消保原语义；自然退出与 retirement 竞态分别 not_caused/caused/unknown，policy 完整 R/Q 仅 ended，unknown 附 retire_timing_unknown；N 保 failed |
| T-02-16 (B) | SIGINT→grace→TERM→KILL、组未死/取消通道断、PID被复用、orphan_policy=stop → 重验实例，不能向新PID发信号，不凭信号成功终结；stop也必须走同表 |
| T-02-17 (A9 fixture) | 错run/source/实例仅审计；倒序导入/旧alive/晚alive后unknown或gone/缺失无效事实时间/native已知冲突按归一规则；已存R/Q/N proof@20于90导入后仅收到alive@30仍X，不能用ended_at=90遮蔽；N@20+gone@20+alive@30+gone@40、同刻反证、未封口launcher、乱序/已failed后增量与持久X后新gone均阻断，早于N的普通活性仅审计；既有终态不重开/重发/重占槽，保留原terminalNote，未解决冲突须显式解决 |
| T-02-18 (A9 fixture) | 同 owner 并发 predecessor、busy/uncertain槽、跨 owner → 唯一新父边 / slot_busy / unsupported；旧 linkId 不授新控制权 |
| T-02-19 (A9 fixture) | wait 入场run-a，期间run-b/旧报告/通知丢失/客户端超时较短 → 只看a与实际返回游标，按有效上限留余量续等；超时/断线不写终态或取消 |
| T-02-20 (A9 fixture) | C 前调用 Jev/browser 正向操作 → unsupported、零 send/运行意图；规格核对 browser 的失联/needs_human/TTL不释放语义，正向存储/用例不属 A9 |
| T-02-23 (A9 fixture) | 运行槽 schema 无 TTL、ledger 无通用 leases；collect 换代后旧 checkpoint 写入拒绝的规格归06，不把观测租约塞进运行槽 |
| T-02-24 (B) | 父MCP退出或关pane，默认continue，活跃headless请求可见打开，子只提交report → supervisor继续/失联对账，均不据此释放槽，不启动可见副本 |
| T-02-25 (A9 fixture) | node:sqlite 执行DDL；外键、双当前父/槽/alias、非法状态、终态缺证/活槽删除、native code缺来源、HUD只读写入逐项拒绝；延期表/控制分支不存在；callers.cwd 非空绝对路径约束仅承载物理 MCP 登记值，取不到真实 cwd 的入口须 cwd_unavailable 拒登记，会话未知 cwd 不用此列补空，不为此改 DDL（consult 4 增补，F04）；（NOTIFY 增补，A1）旧 reader 读 events.v1.1 未知 kind 不失败/不改推导，未知 note→null；DDL/user_version=1 原字节保留 |
| T-02-26 (B) | user_version=0/1/2、WAL、短 busy等待；真实锁争用达06预算 → busy/未接受、无部分意图/外部动作；重试事务不重发动作。accepted 与 started/bound 时延分列；来源取证后等锁期间另一 MCP /clear 换代、撤权或目标 run/binding 变化时，旧前提在查幂等/写入前失败，不能重贴新代或覆盖事实，锁内零文件/proc I/O（consult 4 增补，F07） |
| T-02-27 (A9 fixture) | 单 MCP 收到共享 A/B、原生子或缺可信来源；自报 B/root 与上次 context 均无效 → MVP 拒绝，零意图/报告/幂等范围复用；context 类型仍可表达物理/逻辑分离；根→子→根中子拒绝不改变根 scope/context/alias/claim/generation，Codex 子另起 MCP 仍不投影 root；新旧会话双 MCP 同时绑定、A→B→A 旧来源及旧 spawn/report 等锁后提交均重验捕获前提，旧 receipt 不倒切（consult 4 增补，F07） |
| T-02-28 (A9 fixture) | 已child-a/target-a的resume或handover本轮解析b、SQL覆盖已知ref、发现前改strategy/kind或发现后缩scope四组 → 拒改既有ref/策略/范围，run uncertain/b仅候选；合法同ref握手不回退关系pending；scope_ref可从NULL单次写入核验结果 |
| T-02-29 (B) | 未登记supervisor却写heartbeat、缺seq/mono、合法单次UPDATE、错producer/已终态CAS → 前两者CHECK拒绝，合法元组一次更新可返回取消字段，错producer或已终态零修改；结构检查不代替04/06运行成本基准 |
| T-02-30 (A9 fixture) | launch_cwd缺失/相对路径/后续覆盖，resume采用明确新目录 → SQL拒前三组；新run各自保存规范绝对启动目录，旧run不变，不从callers.cwd反推 |
| T-02-31 (A9 fixture) | NULL workspace首次捕获/已捕获再改或清空/已有project_origin再补快照 → 仅首次补齐成功，workspace.captured同事务；origin不变，超时/非Git原因可保留，不重启harness |
| T-02-32 (A9 fixture) | ledger初始化、第二行/替换/删除、重启/同库备份恢复、独立新库 → 单行ledgerId不变，独立新库不同；对外键以ledgerId命名空间隔离 |
| T-02-33 (A9 fixture) | 相同请求缓存命中/未命中、Git结果/显示名/采集时间/declaredAt改变 → 同digest/重放；修改launch cwd或显式originRepoId → 异参拒绝；路径消失不改已存启动历史 |
| T-02-34 (A9 fixture) | 合法local resume同key同参重放但currentRun已变化、旧expectedRun换新key、mode/expectedRun异参 → 首项返回原结果，后两组拒绝；新意图全部门禁及typed actor重验，零旧父MCP伪装；（consult 5 增补，G03）B45-R2 补 MCP 可选参数：新轮出现后旧键仍重放原 run；同键改变 expectedRun 冲突；两调用者先读同 run、不同 key 竞争最多一个新意图；另一轮已启动并结束后旧 expectedRun 新 key 仍 expected_run_mismatch 且零 run/claim/slot/外部提交；缺省旧编码兼容、本地必填及 preparation 前提重验保留 |
| T-02-35 (A9 prototype) | 真实临时SQLite保存N@20+gone@20+alive@30+gone@40及倒序导入 → uncertain/持槽/持久X；已failed后导入合成目标的真实活性，再gone → 原终态/完成事件/已释放槽不重写，持久冲突继续阻断新操作 |

A9 最小执行包：真实临时 SQLite + 合成进程验证同键并发单次提交、异参拒绝、意图/槽原子、归并重放、意图 commit 后/提交前后/回写前崩溃均不重发（T-02-1、3–6、8、12）。恢复包包括已选可见机制 A8 接受证据、正常 scope 结束、活成员阻终结、取消未确认持槽、supervisor 死后无旧 receipt 的 Q 可达或列明缺证、恢复无新执行权（T-02-14、15；04 T-04-24、25、30）。其他 A9 fixture 审规格，不要求全部 B 先完成；生产实现与完整矩阵在 B3/B4/B5/B14 验收。


## ledger schema v1

下列是空数据库初始化的单个可执行 SQL 块。每个写连接都须重新启用 foreign_keys/busy_timeout；HUD 用 readOnly 连接且不执行初始化。user_version>1 必须在执行迁移前由连接层拒绝。WAL 在文件数据库生效；内存检查库可返回 memory 模式。DB 约束负责结构和唯一性：SessionRef、alias目标、当前父边、当前child_binding、canonical幂等键及原范围审计、运行槽；SQL 不负责验证 /proc、claim hash来源、授权、状态迁移表、alias范围冲突或跨多表事务完整性，这些必须执行上文 TX 校验和测试。FK默认限制删除，历史不级联清除。

（consult 4 增补，F04）下列 `callers.cwd TEXT NOT NULL` 指登记瞬间物理 MCP 自己的真实绝对工作目录（01 CallerId），不是 harness/session 的 WorkspaceContext.cwd、SourceId 或调用授权。process.cwd() 无法取得时入口返回 cwd_unavailable 并拒绝登记，不填 HUD_HOME、父进程目录或空字符串；会话无位置证据仍 null，不能自动用 callers.cwd 补空。A4 Caller.cwd:string 与此 DDL 均保持不变，无 schema v1 迁移。

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
-- 初始化/实时连接默认立即返回 busy；有限重试与总预算归06。
PRAGMA busy_timeout = 0;
BEGIN IMMEDIATE;

CREATE TABLE ledger_metadata (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  ledger_id TEXT NOT NULL CHECK (length(ledger_id) > 0)
) STRICT;
INSERT INTO ledger_metadata(singleton, ledger_id) VALUES (1, lower(hex(randomblob(16))));
CREATE TRIGGER ledger_metadata_keep_update BEFORE UPDATE ON ledger_metadata
BEGIN
  SELECT RAISE(ABORT, 'ledger metadata is immutable');
END;
CREATE TRIGGER ledger_metadata_keep_delete BEFORE DELETE ON ledger_metadata
BEGIN
  SELECT RAISE(ABORT, 'ledger metadata is immutable');
END;
CREATE TRIGGER ledger_metadata_keep_insert BEFORE INSERT ON ledger_metadata
WHEN EXISTS (SELECT 1 FROM ledger_metadata)
BEGIN
  SELECT RAISE(ABORT, 'ledger metadata already initialized');
END;

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
  task_digest TEXT NOT NULL CHECK (length(task_digest) = 64 AND task_digest NOT GLOB '*[^0-9a-f]*'),
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
  CHECK (state <> 'closed' OR closed_at IS NOT NULL),
  FOREIGN KEY (parent_context_id, parent_context_generation, parent_caller)
    REFERENCES caller_contexts(context_id, generation, caller_id)
) STRICT;
CREATE UNIQUE INDEX links_current_child ON links(child_ref) WHERE current_owner = 1;
CREATE INDEX links_parent ON links(parent_ref);
CREATE TRIGGER links_keep_child BEFORE UPDATE OF child_ref ON links
WHEN OLD.child_ref IS NOT NULL AND NEW.child_ref IS NOT OLD.child_ref
BEGIN
  SELECT RAISE(ABORT, 'known child ref cannot be replaced');
END;

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  link_id TEXT NOT NULL REFERENCES links(link_id),
  run_seq INTEGER NOT NULL CHECK (run_seq >= 1),
  operation TEXT NOT NULL CHECK (operation IN ('spawn', 'resume', 'handover')),
  target_session_ref TEXT,
  source_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  expected_generation INTEGER NOT NULL CHECK (expected_generation >= 1),
  mode TEXT NOT NULL CHECK (mode IN ('visible', 'headless')),
  launch_cwd TEXT NOT NULL CHECK (substr(launch_cwd, 1, 1) = '/'),
  workspace_snapshot TEXT CHECK (workspace_snapshot IS NULL OR (json_valid(workspace_snapshot) AND json_type(workspace_snapshot) = 'object')),
  project_origin TEXT CHECK (project_origin IS NULL OR (json_valid(project_origin) AND json_type(project_origin) = 'object')),
  supervision_strategy TEXT NOT NULL DEFAULT 'headless' CHECK (supervision_strategy IN ('headless', 'wrapper')),
  scope_kind TEXT NOT NULL DEFAULT 'pgid' CHECK (scope_kind = 'pgid'),
  scope_ref TEXT CHECK (scope_ref IS NULL OR (json_valid(scope_ref) AND json_type(scope_ref) = 'object'
    AND json_extract(scope_ref, '$.scope_kind') IS scope_kind)),
  state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'cancelling', 'uncertain', 'ended', 'failed', 'cancelled')),
  locator TEXT CHECK (locator IS NULL OR json_valid(locator)),
  launch_token_hash TEXT NOT NULL UNIQUE CHECK (length(launch_token_hash) = 64 AND launch_token_hash NOT GLOB '*[^0-9a-f]*'),
  launch_digest TEXT NOT NULL CHECK (length(launch_digest) = 64 AND launch_digest NOT GLOB '*[^0-9a-f]*'),
  launch_phase TEXT NOT NULL DEFAULT 'reserved' CHECK (launch_phase IN ('reserved', 'armed', 'submitting', 'submitted', 'never_submitted')),
  launch_call_id TEXT NOT NULL,
  launch_correlation_id TEXT NOT NULL,
  launch_message_id TEXT,
  supervisor_pid INTEGER CHECK (supervisor_pid > 0),
  supervisor_proc_start TEXT,
  heartbeat_at INTEGER,
  heartbeat_seq INTEGER NOT NULL DEFAULT 0 CHECK (heartbeat_seq >= 0),
  heartbeat_mono_ms INTEGER CHECK (heartbeat_mono_ms >= 0),
  cancel_requested_at INTEGER,
  submission_fenced_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  exit_code INTEGER,
  exit_signal TEXT,
  exit_source TEXT CHECK (exit_source IN ('wait_status', 'trusted_harness_result')),
  shell_status INTEGER,
  shell_signal TEXT,
  terminal_evidence_id TEXT REFERENCES evidence(evidence_id),
  orphan_policy TEXT NOT NULL DEFAULT 'continue' CHECK (orphan_policy IN ('continue', 'stop')),
  UNIQUE (link_id, run_seq),
  UNIQUE (run_id, link_id),
  UNIQUE (run_id, expected_generation),
  CHECK ((supervisor_pid IS NULL AND supervisor_proc_start IS NULL)
    OR (supervisor_pid IS NOT NULL AND supervisor_proc_start IS NOT NULL AND length(supervisor_proc_start) > 0)),
  CHECK ((heartbeat_at IS NULL AND heartbeat_seq = 0 AND heartbeat_mono_ms IS NULL)
    OR (supervisor_pid IS NOT NULL AND heartbeat_at IS NOT NULL AND heartbeat_seq >= 1 AND heartbeat_mono_ms IS NOT NULL)),
  CHECK (operation NOT IN ('resume', 'handover') OR target_session_ref IS NOT NULL),
  CHECK ((mode = 'headless' AND supervision_strategy = 'headless')
    OR (mode = 'visible' AND supervision_strategy = 'wrapper')),
  CHECK ((state IN ('ended', 'failed', 'cancelled') AND ended_at IS NOT NULL
      AND terminal_evidence_id IS NOT NULL AND submission_fenced_at IS NOT NULL)
    OR (state IN ('starting', 'running', 'cancelling', 'uncertain') AND ended_at IS NULL AND terminal_evidence_id IS NULL AND exit_code IS NULL AND exit_signal IS NULL
      AND exit_source IS NULL AND shell_status IS NULL AND shell_signal IS NULL)),
  CHECK ((exit_source IS NULL AND exit_code IS NULL AND exit_signal IS NULL)
    OR (exit_source IS NOT NULL AND ((exit_code IS NOT NULL AND exit_signal IS NULL)
      OR (exit_code IS NULL AND exit_signal IS NOT NULL)))),
  CHECK (state <> 'failed' OR exit_source IS NULL),
  CHECK (shell_status IS NULL OR shell_signal IS NULL),
  CHECK (ended_at IS NULL OR ended_at >= created_at),
  FOREIGN KEY (source_id, harness) REFERENCES sources(source_id, harness),
  FOREIGN KEY (target_session_ref, source_id, harness) REFERENCES sessions(session_ref, source_id, harness)
) STRICT;
CREATE INDEX runs_link_latest ON runs(link_id, run_seq DESC);
CREATE INDEX runs_reconcile ON runs(state, heartbeat_at);
CREATE INDEX runs_target ON runs(target_session_ref);
CREATE TRIGGER runs_keep_launch_context BEFORE UPDATE OF launch_cwd, project_origin ON runs
WHEN NEW.launch_cwd IS NOT OLD.launch_cwd OR NEW.project_origin IS NOT OLD.project_origin
BEGIN
  SELECT RAISE(ABORT, 'launch context is immutable');
END;
CREATE TRIGGER runs_capture_workspace_once BEFORE UPDATE OF workspace_snapshot ON runs
WHEN OLD.workspace_snapshot IS NOT NULL AND NEW.workspace_snapshot IS NOT OLD.workspace_snapshot
BEGIN
  SELECT RAISE(ABORT, 'workspace snapshot is first capture only');
END;
CREATE TRIGGER runs_keep_target BEFORE UPDATE OF target_session_ref ON runs
WHEN OLD.target_session_ref IS NOT NULL AND NEW.target_session_ref IS NOT OLD.target_session_ref
BEGIN
  SELECT RAISE(ABORT, 'known target ref cannot be replaced');
END;
CREATE TRIGGER runs_keep_scope BEFORE UPDATE OF scope_ref, scope_kind, supervision_strategy ON runs
WHEN NEW.scope_kind IS NOT OLD.scope_kind OR NEW.supervision_strategy IS NOT OLD.supervision_strategy
  OR (OLD.scope_ref IS NOT NULL AND NEW.scope_ref IS NOT OLD.scope_ref)
BEGIN
  SELECT RAISE(ABORT, 'established supervision scope cannot change');
END;
CREATE TRIGGER runs_keep_fence BEFORE UPDATE OF submission_fenced_at ON runs
WHEN OLD.submission_fenced_at IS NOT NULL AND NEW.submission_fenced_at IS NOT OLD.submission_fenced_at
BEGIN
  SELECT RAISE(ABORT, 'submission fence is permanent');
END;

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
  caller_id TEXT NOT NULL,
  caller_context_id TEXT NOT NULL,
  context_generation INTEGER NOT NULL,
  bound_by TEXT NOT NULL CHECK (bound_by IN ('receipt', 'trusted_session', 'transcript')),
  capabilities TEXT NOT NULL CHECK (capabilities = 'mcp'),
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
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
  kind TEXT NOT NULL CHECK (kind IN ('launch_receipt', 'trusted_session', 'transcript', 'exit_receipt', 'group_check', 'never_submitted', 'heartbeat', 'conflict', 'conflict_resolved', 'scope_reconciled')),
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
  origin_owner_key TEXT NOT NULL CHECK (json_valid(origin_owner_key)),
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

PRAGMA user_version = 1;
COMMIT;
```
