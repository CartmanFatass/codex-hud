# 04：hud-run 托管、回执与恢复证据

- 版本：`v0.1 draft`（2026-11-01）。
- 状态：A1 第二批草案；数据格式与证据生产要求待主审/A9，未宣称已实现进程协议。
- depends-on：[01 身份](./01-identity.md)、[02 执行协议/唯一对账表](./02-execution.md)、[03 生命周期](./03-lifecycle.md)；[概念方案](../universal-hud-concept.md) §6.6.4–6、§6.10–11、§15–16；[工程计划](../universal-hud-engineering-plan.md) B3a/B3b/B4/B6。
- 开放项：甲仅暂定，**待 A8 第二轮**；[A8初步报告](../probes/hud-run-visible.md)的12/12推荐已被评审要求收窄，shell退出不证明harness组结束。保留甲乙接口，乙不据pane消失终结。A3仍初步：Codex metadata trust unverified、daemon-present未测、Herdr env仅Codex tab-root/pi split；cgroup只作可选强能力，不假定WSL2可用。

本契约不承诺恰好一次，也不承诺所有后代或外部动作都会停止。执行票据只允许单次执行权消费，目标是否启动/结束由证据证明。默认受管范围是本轮进程组；主动逃逸的后代可能继续，见下文范围边界。HUD 只读 ledger，hud-run 不承担全局调度器或新常驻服务。

范围/凭证等为**编排者裁决**，追溯至概念§15「受管范围默认」「跨所有者转交凭证」及03裁决表；待Oracle ARCH复核，可推翻，Pro仅关键里程碑/A9。甲仍待A8第二轮，不因性能目标放宽组空或实例围栏。G13/G14要求成本按事件计：优先现成wait/SIGCHLD/稳定句柄和回执；有足够证据就不再全量扫描。06拥有性能预算，初始目标为非wait MCP p95<50ms、冷启动<200ms、hud-run空闲CPU≈0/每心跳间隔一次账本写、HUD增量tick<50ms；本批只定义验证项，不宣称达标。HUD接口仅给只读字段/状态与能力门，展示方案归后续Fable设计agent。

## 数据模型

### 运行、启动输入和范围

每个活跃 run 一个独立 supervisor，以 runId 固定目录、票据、locator、scope、日志、心跳和取消。hud-mcp由harness持有/回收，不另建常驻reconciler服务。优先用supervisor本身的状态/私有fd与内核等待能力；只有维持实例围栏确有需要时才用本轮launch gate/group-control helper，生命周期随run，不能为每种证据再建观察进程。helper不获得第二份执行权。终态回执/证据提交后supervisor退出；若只剩无法证实的历史uncertain且无活跃受管控制，记录末次部分事实后退出，不为槽或历史行永远心跳。父MCP断连不销毁仍活跃的supervisor；恢复观察器按需调用后退出，只追加证据，不变成新launcher（T-04-38、39）。

启动输入为 `{runId, mode, launch: argv|shell, cwd, source_id, profile_digest, stdin, orphan_policy, visible_strategy, scope_kind}` 加私有通道运输的执行票据/claim。argv 是非空字符串数组、逐参数直接执行；shell 是一个明确文本，用已解析的绝对 `$SHELL -ic <text>`，不把 argv 拼回 shell，也不从 shell 文本猜 executable。stdin=headless brief（读一次后 EOF）或 closed；visible 为当前 TTY。有效 home/source 必须与账本档案一致；shell 函数实际切到别的 home 时不能继续用旧 source 授权/绑定（T-04-1、2）。

`ProcessStamp={pid:positive integer, proc_start:decimal string, boot_id:string, pid_domain:string}`；proc_start 是本 PID 域的内核启动 tick，不用 PID 数字、mtime 或 ISO 时间替代。`command_leader` 是实际被等待的直接命令（shell 模式可能是中间 shell），`harness` 是目标 harness 的独立 stamp。只有确证同一 pid+start 才可令两者相同。shell receipt 必须同时给出 `harnessPid/harnessPidStart`（无法唯一发现时明确 null/unknown，不能编造）；binding 不接受拿 shell PID 冒充 harness。唯一发现需已知启动祖先链、档案和 session/locator 交叉证据；进程名或第一个匹配进程不足（T-04-3、4）。

| scope_kind | scope 的精确定义及结束证明 | 不覆盖的情况 |
|---|---|---|
| pgid（默认） | 本轮启动建立并记录的实际 workload PGID，必要的 session id、boot/PID 域、组实例及 leader stamp 同时固定；visible 取目标前台 job 的 PGID，不能拿后台 supervisor/中间 shell 的 PGID代替。可信组空检查+提交围栏+leader 回执可给 R/G=gone/Q | leader 的主动逃逸后代（setsid/daemonize/进入别的组）不在此范围，可继续存在、不受取消信号覆盖、不阻止本运行终结，且不获得执行权 |
| cgroup（可选） | 环境提供独占 run cgroup、稳定 id/代次、完整成员可读且 workload 禁止迁出；后代继承此范围，setsid/换组仍覆盖。provider 输出不可迁出/独占能力与空组证据 | 不能验证独占/禁止迁出、读取失败或能力丢失时为 unknown；不能靠“路径存在”或 cgroup 名字声称更强覆盖 |

supervision_strategy与scope_kind在意图中固定；实际scope_ref在唯一核验harness PID/start/boot/PID域及PGID后才从NULL写入并冻结，不能预填shell/gate组再替换。提交后尚未发现时G=unknown、禁scope信号/R/Q，按02为uncertain持槽；同一实例后来H+G齐可恢复，不重提命令。范围冻结后不可改为较小范围来取得空组结论；capability 缺失只可在明确未提交的预检阶段拒绝/按调用者明确新意图选默认，不能超时后重启降级。逃逸诊断如 `run.out_of_scope_descendant` 只记录可验证 stamp/source/ref 关联；不能凭相同 cwd/名字给别的进程贴归属。此类范围外事实不是 02 的 X，不重开已终态/阻断 resume；元数据/回执必须显示 scope_kind 和覆盖边界（T-04-5–7、37）。

### 文件、字段与原子提交

路径固定为 `$HUD_HOME/runs/<runId>/{meta.json,stdout.log,stderr.log,exit.json}`。runId 仅 `[A-Za-z0-9_-]{1,128}`，HUD_HOME/运行目录是已解析绝对路径；拒绝路径穿越、符号链接替换和不属于当前用户的目录。目录 0700，文件 0600；已有目录只在 ledger/run/实例均相符时读恢复，不截断、不复用旧 run 的日志。只有成功取得票据的本轮 writer 写 meta/log/exit，失败竞争者不碰它们（T-04-8、9）。

下列是完整字段约定，JSON 键 snake_case；`harnessPid/harnessPidStart` 特为 01 的启动回执保留 camelCase 键。未知量是 null，不能用 0、空串或猜测值。时刻为 UTC Unix 毫秒，非 ISO 字符串；时长由同 boot 的单调钟相减。所有 hash 为 SHA-256 小写 64 hex。未知 schema_version 拒绝作授权/终态证据。

`meta.json` 必填字段：

| 字段 | 类型/允许值 |
|---|---|
| schema_version, revision | 分别恒 1、从 1 严格递增整数 |
| run_id, link_id, source_id, target_session_ref, binding_generation | 对应 ledger；source/ref 可按 job/未绑定状态为 null，代次≥1 |
| mode, visible_strategy, scope_kind | visible/headless；headless 时 null，可见 wrapper/sidecar；pgid/cgroup |
| supervisor, command_leader, harnessPid, harnessPidStart | supervisor 为 ProcessStamp；leader 为 stamp或null；harness 两字段同时有值或同时null，其 boot/PID域同受核验启动链 |
| scope | null（尚未建立/sidecar无法拥有）或下述 ScopeDescriptor；不能把候选前台组当已拥有scope |
| launch_digest, profile_digest, launch_call_id, launch_message_id, launch_phase | 对应指纹/本轮锚点/02阶段；无命令/prompt/claim/票据明文 |
| stdin_mode, capture | brief/closed/tty；capture={stdout: file/tty_passthrough/pty_merged/unavailable, stderr: file/tty_passthrough/merged_into_stdout/unavailable} |
| parent_owner_key, parent_context_id, parent_context_generation, orphan_policy | 接受意图时的授权/策略快照；continue默认或stop；不是让子自报替换父身份 |
| created_at, updated_at, heartbeat_at, heartbeat_seq, heartbeat_mono_ms | 毫秒时刻；首次心跳前后三项可null/0/null，之后seq递增、mono属于supervisor同boot；meta仅在启动/协议事件刷新时保存快照，实时心跳以runs同名字段为准，不每5s重写meta |
| leader_receipt, submission_fence | 下述 LeaderReceipt或null；围栏为null或{event_seq, at, ack}，ack为never_armed/gate_sealed/control_peer_dead |

`ScopeDescriptor={scope_id:string, scope_kind:pgid|cgroup, pid_domain:string, boot_id:string, pgid:integer|null, sid:integer|null, group_leader:ProcessStamp|null, cgroup:null|{id:string,generation:integer,path:absolute,exclusive:true,migration_blocked:true}}`。pgid 模式 pgid/sid/group_leader 必填、cgroup=null；cgroup 模式其 cgroup 必填。scope_id 绑定 run、范围实例与 boot/域，不能只编码可重用的数字 PGID/路径。

`LeaderReceipt={process:ProcessStamp, subject:command_leader|harness, exited_at:ms, exit_code:integer|null, signal:string|null, status_source:wait_status|trusted_exit_confirmation, status_quality:known|unknown}`。leader字段subject=command_leader，harness_exit字段subject=harness；known时code/signal恰一非null，signal须真实wait/受信内核状态；unknown时两者null但须确证退出。shell137不换算SIGKILL，harness信号只凭其自身可靠来源（T-04-10）。

`ScopeCheck={scope_id, checked_at:ms, result:alive|gone|unknown, source:owned_pgid_probe|exclusive_cgroup, visibility:complete|partial, fence_event_seq:integer|null, evidence_id:string}`。G=gone 需 complete：pgid 为已记录正确 PID 域的本轮组，已收到 leader 退出、启动/控制 gate 封口，并得到组级空的内核检查（例如对该受控组的存在探测明确 ESRCH）；不是单 PID 消失或任意 kill 错误。EPERM/跨域/无法区分复用/可见性不完整均 unknown。正常组内 helper 也须退出或有明确无 workload、封口退出确认，再验证组空；只见 leader 退出而组还有子进程是 alive（T-04-11）。

`exit.json` 必填字段：

| 字段 | 类型/约束 |
|---|---|
| schema_version, receipt_id, revision, run_id, link_id, mode, visible_strategy | 1、唯一opaque ID、递增revision及对应meta身份 |
| scope_kind, scope_id, coverage | pgid/cgroup、已知scope id或null；scope/leader/supervisor/not_submitted |
| supervisor, command_leader, harnessPid, harnessPidStart | meta里的实例快照；不能把shell和harness合并；即使已退出也保留原stamp |
| created_at, started_at, ended_at, recorded_at, duration_ms | created_at=meta.created_at；started_at为首个可信命令启动观测或null；scope级ended_at为确证组空的观测时刻，部分receipt为其明确subject的退出观测时刻，非精确的内核实际退出瞬间；recorded_at是本revision写入时刻。duration_ms为同boot从可信启动到结束观测的单调差，不能求时为null，N无执行为0 |
| leader_exit, harness_exit, supervisor_signal | leader为LeaderReceipt或null；harness为同格式且subject=harness的受信结果或null；supervisor_signal仅 supervisor实际收到的信号或null |
| reason | normal_exit/nonzero_exit/signal_exit/cancel_confirmed/supervisor_hup/preflight_failure/unknown |
| scope_check, submission_fence, cancel_request_seq, logs | ScopeCheck或null、围栏或null、已接受取消事件seq或null；logs={stdout:{bytes:integer,capture:string},stderr:{bytes:integer,capture:string}} |

reason是事实分类：normal/nonzero/signal分别需相应subject状态，cancel_confirmed须取消意图+scope结束；supervisor_hup只说明supervisor收到HUP，不冒充harness信号，preflight_failure只指N。coverage=scope且匹配全范围/围栏/leader且无X才R；其他coverage、未知scope、单独HUP/137或文件存在不升级R。receipt_id在该run稳定，revision递增；evidence_id按run/receipt/revision/hash区分，同revision异hash冲突，旧证据保留（T-04-9、10、12–14）。

meta/exit 使用同目录唯一 O_EXCL/O_NOFOLLOW 临时文件，写完整 UTF-8 JSON→fsync(file)→atomic rename→fsync(dir)。exit 的 leader级版本可在后来补齐scope证据后由原writer升revision；既有事实不得改写，旧指纹/证据保留。崩溃后的临时/半文件忽略，不补零退出码。先落盘正式 receipt，再追加/校验 ledger evidence，最后 reconciler 用 02 的终结事务写 state/退出字段/槽/claim/events；文件与SQLite不是一个事务，文件已落而ledger未提交时可按指纹幂等导入，不能因此再执行（T-04-9、14）。

stdout/stderr 是单writer追加的原始字节文件，不是JSONL，offset/bytes按字节；不因下一次run或恢复而截断。headless捕获file；visible默认TTY直通，日志可为空且 capture=tty_passthrough/unavailable，空文件不表示“无输出”。只有通过测试的PTY tee才可采集；流已合并必须标pty_merged/merged_into_stdout，不伪称分离stderr。日志是本地私有输出，可能含正文，不进ledger/模型默认材料；公开fixture只用合成字节（T-04-15）。

## 不变量

| 编号 | 可检查断言 | 层 / 测试 |
|---|---|---|
| I-04-1 | argv/shell契约互斥、source/home与档案一致；shell leader与实际harness独立记录，只有确证同实例才等同 | TX+E；T-04-1–4 |
| I-04-2 | strategy/kind在意图固定，scope_ref仅在唯一核验harness后由NULL写入并冻结；默认是harness PGID，绝不是supervisor/中间shell组，每步信号重验scope；逃逸后代只诊断，cgroup需独占/禁迁出证明，禁止事后缩范围 | DB+TX+E；T-04-5–7、23、30、37 |
| I-04-3 | 文件身份/版本/权限固定；只有票据赢家单写meta/log/exit；receipt先原子落盘再幂等导入，恢复不重启、不截断 | TX+E；T-04-8、9、14、15 |
| I-04-4 | 退出码/信号有明确subject与来源，shell137不是harness SIGKILL，supervisor HUP不是child退出；leader级不冒充scope级R | TX+E；T-04-3、10、12、13 |
| I-04-5 | R/G/N/Q只按下面生产表；组级gone含正确域、范围实例、leader与围栏，不等同单PID缺失；未发现scope不得发scope信号/产R/Q，不能生产时保持unknown/uncertain | TX+E；T-04-11–14、23–25、37 |
| I-04-6 | 每5s写本实例心跳；>30000ms stale、=30000仍fresh；心跳只证明托管活性，不证明child启动或结束；确认死亡优先于残留fresh | TX+E；T-04-16、17 |
| I-04-7 | 票据hash只可由一次CAS消费；不管MCP重启/第二supervisor/恢复，都不重置阶段。先提交submitting再一次RUN许可，许可丢失不重发 | DB+TX+E；T-04-18–20 |
| I-04-8 | N先持久围栏再证明未提交/无workload；submitting后的响应不明不叫N；R/Q结束还需封口迟到提交 | TX+E；T-04-20、21、24 |
| I-04-9 | 取消每步鉴权和实例围栏，INT→默认10s→TERM→2s→KILL，信号成功不终结；只R/Q后cancelled，失联/复用不冒险给别的组发信号 | TX+E；T-04-22、23、26 |
| I-04-10 | 默认continue独立托管；stop只在确证父上下文/物理实例失联后使用接受时策略取消；不把父离线/unknown当子结束 | TX+E；T-04-27、28 |
| I-04-11 | hud-run写字段白名单；身份回填/状态/槽迁移统一reconciler，HUD只读。恢复观察器不给新执行权 | TX；T-04-14、25、29 |
| I-04-12 | 甲暂定待A8第二轮，shell-only回执不是R、supervisor死后不假定仍有前台/input；乙不能生产scope R/Ggone/Q，已发任务不能靠乙自动终结 | TX+E；T-04-30–33、36 |
| I-04-13 | RunHandle固定run/locator/绑定代次；status只读，cancel经鉴权意图，input/focus可选且重验occupant，不通过控制动作resume副本 | TX；T-04-29、34 |
| I-04-14 | 运行心跳不作TTL放槽；browser还需answered/failed+对账，needs_human继续持有；collect只属06观测存储 | TX；T-04-35 |
| I-04-15 | 不新增常驻服务，hud-run/helper仅本轮活跃执行/收尾；空闲阻塞等待，5s心跳仅一次runs CAS UPDATE，不另写证据/事件/meta；退出/组空/对账按事件或请求，禁每秒/proc扫描循环 | TX+E；T-04-38、39 |

## 状态机

### 票据、launch gate与围栏

1. 02 已提交完整意图和占有，run=starting/phase=reserved。hud-run 经继承的私有pipe/受保护临时输入取得随机票据及launch材料；不把票据放argv、可读日志或meta。BEGIN IMMEDIATE 校验hash、launch_digest、run/slot holder（Jev browser代次）、无提交围栏/取消/冲突，CAS `reserved + supervisor=NULL → armed + pid/start/heartbeat`。只赢家可开文件、创建launch gate/组；输家退出并留非敏感拒绝事件，零backend调用（T-04-18）。
2. 对headless/wrapper，在armed建立受控gate，记录其控制通道/实例证据；helper在私有通道等待RUN，断管默认不启动。scope_ref保持NULL：gate/shell的预启动组不是实际harness组，不要求尚不存在的harness PID。此完整托管适配器必须具有启动后唯一发现/核验的路径；已知不支持时在未提交阶段拒绝，不猜scope。乙使用下述一次dispatch gate，不要求拥有harness组。
3. 发RUN前同一事务重验票据消费实例、占有、授权快照/代次、无fence/取消/冲突，写submitting后再发一次许可。gate只接受一份许可且不接受重放。headless/wrapper记录command启动回执后写submitted，再唯一核验实际harness/PGID；reconciler在scope_ref仍NULL且实例匹配时写入完整scope与事件，原hud-run随后同步meta。这不是替换已有scope，也不发第二RUN。此headless/wrapper路径scope未核验时Gunknown，禁止scope信号/R/Q及身份绑定。短命进程或发现窗口崩溃只能保留已有局部证据、uncertain持槽。commit到RUN、RUN到回执之间任一断点均可能未执行或已执行；未知不重发许可或重建gate（T-04-19、20、37）。
4. `submission_fenced_at` 单调设置，只阻止未来提交，不声称已发出的许可没有执行。reserved/armed可CAS变never_submitted，sealed gate/无票据消费证明+组空才N。已submitting/submitted时只能sealed/dead-control-peer确认后阻止后续许可；缺child结束证据仍uncertain。控制通道已死而组仍活不产生新launcher（T-04-21）。

乙保留相同票据CAS、submitting-before-RUN与永久围栏，gate只允许HostAdapter一次dispatch既定harness命令，不在harness组内创建helper。可靠dispatch ack可记submitted，未知仍submitting；二者都不证明子进程启动/退出，不重发。乙的scope_ref保持NULL，可记录有来源的leader身份/存活诊断与可得的部分回执，不能填成owned scope或产R/Ggone/Q；leader-alive不是R-02-5要求的已核验范围G。提交后正式G=unknown，自己的Hfresh加leader-alive也按R-02-9保持uncertain，R-02-5不可达。身份仍须独立满足01全部条件，leader诊断/dispatch ack不替代启动回执或会话证据；拿不到01启动证据时关系保持pending/claimed，不能凭claim补成bound。只有dispatch前确证从未提交且gate围栏生效才可N；取消记录意图，不能向候选组发scope信号或假称完成（T-04-31）。

before-supervisor的正常reserved窗口仍用R-02-4a：意图完整、无取消/冲突且age≤30s保持starting；不得让普通reconciler tick抢先拒绝合法登记。超窗仅uncertain/对账，不自动取回票据。消费次数=1可以测试，不等于目标一定被启动。

### R / G / H / N / Q 的生产与可达行

| 类 | 正向生产证据与验证 | 失败/不能生产时 | 可达02行 / 测试 |
|---|---|---|---|
| R | 原hud-run的正式scope receipt：本run/boot/域/代次、实际leader回执、组级gone/cgroup空、提交围栏；scope已结束且无X。shell code与harness signal分别留来源 | 只有leader或supervisor receipt、scope未知、组仍活、半文件均不是R；宣称scope complete却G alive为X | R-02-2/3；T-04-10–14 |
| G | alive为本scope内匹配实例；gone为已拥有scope的组级空证明+围栏（已启动时另有leader回执），或N的未建立workload证明；cgroup用已验证独占禁迁出的空成员事实 | EPERM、错域/复用、只有PID缺失、视图不全、sidecar候选scope→unknown。范围外逃逸只诊断，不算X | R-02-5/6/9；T-04-5–7、11 |
| H | runs上固定supervisor匹配pid/start的一次5s UPDATE保存heartbeat_at/seq/mono；seq/mono与UTC校验，事件对账时才按需固化所采用快照/producer，不每tick追加证据 | 未来/回退时钟异常或错实例心跳为unknown；恢复者不能替死人续，stale不是结束 | R-02-4a/5/6/7；T-04-16、17、38 |
| N | reserved无消费者，或armed的gate确证未放RUN：先CAS写never_submitted/fence，记录拒绝后续提交的eventseq、gate ack/未创建事实与Ggone。trusted helper运行不算目标harness已执行 | 无日志≠未执行；已发host命令/submitting后结果不明、scope未知或RUN在途不能N | R-02-4；T-04-20、21 |
| Q | 原正式scope receipt未完成/丢失，但已持久启动证据、独立原leader退出receipt和恢复器的正确scope空/封口证明齐全；恢复器不补写原writer的exit.json，提交复合对账证据，run退出结果记NULL，原leader细节仅留有来源的观察 | 只见supervisor/leader PID消失、无leader退出receipt、sidecar观测均不够；不得据NULL推测0或137 | R-02-2/3；T-04-14、24、25 |

这里的scope只覆盖编排者已决定的边界；Ggone不是“机器上没有任何可能继续动作的后代”。Q可以由恢复观察器生产，但不能单独把残留的leader状态升级为harness信号/全范围原始回执。N/R/Q齐备按R-02优先顺序迁移；冲突X走R-02-1；其余“什么也证明不了”走R-02-9，人工reconcile也不能强行释放槽。

### 心跳、supervisor死亡与恢复

登记执行者的同一事务写首个heartbeat_at/seq/mono及启动meta。之后每5000ms仅一次`UPDATE runs SET heartbeat_at=?,heartbeat_seq=heartbeat_seq+1,heartbeat_mono_ms=? WHERE run_id=? AND supervisor_pid=? AND supervisor_proc_start=? AND heartbeat_seq=? AND state IN ('starting','running','cancelling','uncertain') RETURNING cancel_requested_at`；CAS不匹配即停止冒充写者。定时器不追加heartbeat evidence/events、不重写/fsync meta；取消可由私有通道唤醒，返回的已接受取消字段也无需额外轮询读。退出/冲突/对账等实际事件才固化需要的心跳快照，meta在相应协议事件刷新。观察器不续写旧supervisor。UTC负差/与同boot单调钟显著矛盾时一次记录clock_anomaly并unknown/uncertain，不通过给旧事件盖新时间续命（T-04-16、38）。

supervisor通过wait/SIGCHLD、已验证的稳定进程句柄/控制通道退出事件获知结束，不用/proc扫描循环。组空检查只在退出事件、取消阶段或对账时做一次必要检查；组仍活时等待可得的成员/控制事件，不能靠高频扫组求完成。缺事件能力只能保留unknown/按需对账，不能虚报R（T-04-11、38）。

status只读已提交证据，不触发对账写入。实际运行事件、显式reconcile请求或已核实的stale-heartbeat事件在现有写者内调用reconciler，不设每秒/固定周期对账器。必要stale截止只读复核最新H；H仍fresh就延后，确已>30000ms或进程退出事件证实supervisor死亡/替换，且无更高优先R/N/Q，才uncertain。fresh残留心跳不覆盖已确认死亡。对照scope查G，child活着继续占槽；同一原实例恢复H+G才可R-02-5。新观察器不能领票据/重写supervisor实例；无写者时HUD可显示stale投影，不能自己补迁移。scope无法查询保持unknown，返回证据与可执行对账入口，不让正常调用者手工驱动每个阶段（T-04-17、25、29、39）。

### 取消与父断连

RunHandle.cancel 先由reconciler检查当前owner/context或受信本地管理权限/已接受的orphan_policy，写cancel_requested_at/cancelling/事件；这里的本地管理入口限定同用户私有HUD_HOME与写者实现，不接受模型自报“admin”。hud-run读取取消意图后，先封口启动，执行SIGINT→grace（默认10000ms，允许0–60000）→SIGTERM→termGrace（固定2000ms）→SIGKILL；宽限从实际发出/确认步骤时开始，不从网络请求超时算。每阶段先检查是否已有R/Q/N，已终态不再发信号（T-04-22）。

组信号必须经绑定本轮实例的ScopeControl，每步重验harnessPid/start、当前PGID/域及scope实例；若leader已退，须有仍保持该组实例的等强控制句柄，不能借复用PID定位。可行接口实现是已安排在目标组内的可信anchor经继承私有通道响应、向自己的组发信号；anchor不提前退出/离组/接第二RUN。SIGKILL杀anchor后只观察，不补发到相同数字；通道丢失且无等强句柄返回cancel_unconfirmed/uncertain，无数字PGID回退。visible建立此能力仍需测试，不能向后台shell/supervisor或新occupant发信号（T-04-23）。

信号已发、shell退出、TTY Ctrl-C、supervisor收到HUP不是取消完成；只按R-02-2的R/Q才cancelled；N证明目标从未提交则按R-02-4 failed。先退出后到达的cancel返回already_ended；已接受取消但无法结束继续cancelling/uncertain。重复cancel不重置grace时钟、不重发已确认步骤；步骤以eventseq与ack记录，崩溃后无ack只对账，不盲发旧scope（T-04-26）。

cgroup模式的ScopeControl必须覆盖该独占范围全部成员及其后代，不能仅给一个PGID发信号：provider须提供具有实例围栏的INT/TERM/KILL能力（或明确返回不能确认），KILL后仍验证空范围。无此能力不退回较小PGID假称取消成功；保持cancelling/uncertain，不减小已选scope。PGID内anchor只是默认模式的可行实现，不作为cgroup能力证明（T-04-6、23）。

orphan_policy随意图冻结。continue为默认：父MCP退出、关父pane、换context只记录parent.offline/失效，supervisor继续；stop只在确证其父物理实例退出/可信上下文关闭后用预授权策略创建取消意图，走同一序列。caller轮询过期/Herdr unknown不是确证断连；shared A关闭不影响B的委派。新MCP同OwnerKey重放请求仍命中旧run，不能用“父复活”撤回已接受取消或起新副本（T-04-27、28）。

### 写者与RunHandle

hud-run允许：CAS消费/登记票据和启动阶段、scope/leader原始证据、自己的心跳、取消步骤ack、私有文件；reconciler负责证据校验、context/身份回填、关系与run状态迁移、槽释放和事件的原子提交。hud-run可调用同一reconciler入口，不能私有UPDATE state绕过R-02；HUD绝不补写丢失回执/槽，collect不属于hud-run。

`RunHandle={runId, locator, bindingGeneration, status(), cancel(grace?), sendInput?(text), focus?()}`。status只读已提交状态、心跳、scope/leader/harness/receipt覆盖及证据，不做隐式reconcile写；cancel经上述鉴权意图。sendInput由宿主队列或v1.1入口实现，headless未定义就unsupported；focus由HostAdapter实现，先检查server/locator与occupant代次。输入/聚焦不等于取消、不能隐式resume；历史locator不匹配只返回stale_locator（T-04-29、34）。

### 可见模式接口：甲暂定，待 A8 第二轮

本节是可独立修订的接口槽，选择状态**wrapper仅暂定，待 A8 第二轮**，不采纳原12/12无条件通过结论。两候选共有 `startVisible(runIntent,ticket,launchSpec)→RunHandle`、`observe(runId)→{H,G,receipts,coverage}`；HostAdapter负责表面/就绪/输入/焦点，supervisor负责进程证据。命令已发超时不回退再起。

| 候选 | 启动、TTY与数据接口 | 证据能力 / 不可达行 |
|---|---|---|
| 甲 wrapper | hud-run命令被输入目标pane交互shell；supervisor不读TTY输入，保持正确前后台job control，目标harness在前台。shell模式用 -ic 保留函数/herdr-context；记录实际harnessPid/start与前台PGID，不能用child shell PID/后台supervisor组替代。TTY直通日志如实标覆盖；如增加PTY/anchor桥，必须重验输入/resize/检测 | 实现拥有正确scope/control时可产H/G/R/N/Q，覆盖R-02全部相应行；leader只涵盖shell、scope/控制句柄缺失时不能终结，退unknown/uncertain。原型未验证的完整scope仍是B3b验收项 |
| 乙 sidecar | 相同票据只允许HostAdapter沿当前路径dispatch一次，旁路仅观察确切locator；scope_ref=NULL，无父子wait权限/受控scope，不注入假退出码，不读错pane。若目标未发命令，可在受信提交前围栏证明N；已发后只观察 | 可产自身H与leader级alive/unknown诊断，不能把leader-alive当正式范围G；提交后G=unknown，R-02-5不可达。当前不能产scope R/Ggone/Q，故R-02-2/3也不可达；只有可靠预提交N才可R-02-4。已发任务R-02-9 uncertain并持槽；不能把leader观测/人工按钮当R/Q |

[A8初步报告](../probes/hud-run-visible.md)经首轮复核的边界：甲正常harness在不同于supervisor的前台组；函数/正常输入/resize有局部证据，但shell退出、137、HUP均未证明harness组空。wrapper配置出现不证明daemon执行命令收到正确context；父退出仅非TTY后台命令证据，agent-list完整idle/working和supervisor死后前台/input归属仍待第二轮。乙在Herdr0.9.5无exit code/signal，已发任务不能靠乙终结。不能外推tmux/完整exec TUI或最终anchor/PTY桥已测。

必须保留：shell child与harness两stamp、shell status与native signal分离，exec --version不代表完整TUI；pane close的supervisor HUP仅部分回执，harness组空才R。supervisor SIGKILL后无回执/心跳停，即使PID仍活也可能已由外层shell抢回前台，不能宣称TUI可继续交互/发送输入；先核验终端foreground owner，未证实则禁input/focus、uncertain持槽，不自动恢复前台或resume副本。正式实现用5s/30s及本文reason，不照搬原型1s与旧枚举（T-04-30–33、36）。

A3约束同样留双分支：[Codex MCP](../probes/codex-mcp-launch.md)初步显示仅配置env表进入MCP，默认使用本轮消息参数claim；若未来实证env可达再用env路径。配置env注入如启用必须安全合并既有条目并避免记录claim明文，不作为唯一办法。`_meta.sessionId`、`_meta["x-codex-turn-metadata"].session_id`只观测存在/匹配rollout，来源不可覆盖性未验证，不作授权来源；daemon absent测量不支持外推daemon-present，01的条件门保留。[cc](../probes/cc-mcp-env.md)初步full env/pid匹配仍逐实例核验；[Herdr](../probes/herdr-env.md)只覆盖Codex tab-root与pi split的env，第三跳按harness分别判断，不宣称所有布局可达（T-04-32）。

## 失败案例

| 编号 | 场景 / 预期 | 不变量 | 测试 |
|---|---|---|---|
| F-04-1 | argv拼shell、函数切home、shell PID冒充harness → 拒绝/身份unknown，不建错绑定 | I-04-1 | T-04-1–4 |
| F-04-2 | leader已退但组内子活、范围外后代逃逸、cgroup能力假设 → 分别持槽/诊断不阻终结/unknown，不混scope | I-04-2、5 | T-04-5–7、11 |
| F-04-3 | 文件半写/旧run覆盖/赢家输家并发/receipt落盘后ledger崩溃 → 忽略半证据，幂等导入，零重执行 | I-04-3 | T-04-8、9、14 |
| F-04-4 | shell137、supervisor HUP、只有leader回执 → 保留subject/nullsignal，不升级scope R | I-04-4 | T-04-10、12、13 |
| F-04-5 | fresh残留心跳但supervisor已死、时钟异常、假续心跳 → uncertain，child活也不授新票据 | I-04-6、11 | T-04-16、17、25 |
| F-04-6 | 同票据二supervisor、RUN响应丢失、发现窗口崩溃、preflight无围栏 → 输家退出/uncertain，scope未证实不信号/终结，绝不重放启动 | I-04-2、5、7、8 | T-04-18–21、37 |
| F-04-7 | 信号成功组仍活、PGID复用、control anchor死亡、取消竞态 → cancelling/uncertain或已终态，不杀错组 | I-04-9 | T-04-22、23、26 |
| F-04-8 | 父断连/重启、shared单context关闭、caller仅stale → 只按快照策略，不把它当子结束 | I-04-10 | T-04-27、28 |
| F-04-9 | 乙 pane消失/有码假设，甲额外PTY未验证，metadata来源未证实 → 标能力缺失/待评审，不盲支持 | I-04-12 | T-04-30–33 |
| F-04-10 | 旧locator输入、HUD补回执、浏览器needs_human或collect混用 → 拒绝控制/只读/继续对应租约规则 | I-04-11、13、14 | T-04-29、34、35 |
| F-04-11 | 每秒扫proc/组、每tick追加证据/改meta、终态后留常驻observer → 违反G13；只留必要事件证据/一次心跳写，结束后退出，槽仍按02 | I-04-15 | T-04-38、39 |

## 测试清单

P为B3a/B3b/B14合成真实进程测试；格式/真值表由A4 fixture覆盖。本批不把规格或A8原型截图当最终进程恢复实证，不运行付费harness测试。

| 编号 | 输入 → 预期状态断言 |
|---|---|
| T-04-1 (P) | 含空格/引号/元字符的argv与显式shell函数两组 → argv不经shell解释；shell仅按明确文本 -ic，拒绝双模式/空argv，相同launch_digest可复核 |
| T-04-2 | profile source-a但函数实际home-b，stdin brief/closed/tty三组 → 来源错配不授权绑定；stdin模式明确、brief后EOF，双home不合并 |
| T-04-3 (P) | shell→harness两个不同pid/start，与直接argv/已验证exec同pid组 → receipt分别保存两个身份；只有确证同实例才复制leader结果给harness |
| T-04-4 | 多候选harness、进程名字相同、短命harness漏观察 → harnessPid/start=null/unknown，不猜第一个或shell；正常候选唯一+启动证据才可供01绑定 |
| T-04-5 (P) | PGID内子进程继续与setsid/换组的leader后代继续两组 → 前者leader退出仍无R/持槽；后者组空/leader/fence齐可终结并仅记录可证逃逸诊断，无新执行权 |
| T-04-6 | 请求cgroup但无独占/禁迁出能力；另完整能力且后代setsid → 前者提交前unsupported不盲降级，后者仍覆盖后代，scope未空不终结 |
| T-04-7 | 运行中尝试改scope_kind/小scope或同cwd孤儿猜归属 → 拒绝变更、不伪造逃逸；有效范围外诊断不作X/不阻resume |
| T-04-8 | runId穿越/符号链接/外部用户目录、同目录不同run或票据输家 → 拒绝写入/覆盖；合法目录0700文件0600 |
| T-04-9 | JSON临时/半写/同revision异hash、完整rename前后注入崩溃 → 只读取完整匹配版本，冲突拒绝；旧日志不截断 |
| T-04-10 (P) | shell正常exit137、harness实际SIGKILL但shell返回137、直接wait到harness SIGKILL → 前两组code137/signalnull且不伪称harness signal；最后native signal可记录SIGKILL/codeNULL |
| T-04-11 (P) | leader退/组尚活、完整正确组ESRCH+leader+fence、单PID缺失/EPERM/跨域三组 → G alive/gone/unknown；只有第二组可完整scope终结 |
| T-04-12 | 只收到supervisor SIGHUP、child仍活，与scope结束回执两组 → 前者coverage supervisor/不是R，后者才可R；HUP不复制为harness signal |
| T-04-13 | leader-only receipt、scope完整receipt但同scope G alive、错boot/代次 → 分别不终结/X uncertain/仅审计；文件存在不等于R |
| T-04-14 | exit.json完整落盘但ledger提交前崩溃、重复导入、只有leader evidence但可补Q三组 → 同指纹一次采用、零再执行；Q按02终结并run exit_codeNULL |
| T-04-15 | 合成UTF-8/二进制块追加、visible直通空日志、PTY合流 → byte offset精确；空文件capture如实，merged不伪造stderr来源 |
| T-04-16 | heartbeat每5000ms，30000/30001边界、clock负差/错seq/旧producer → fresh/stale精确，异常unknown；恢复器不能更新死supervisor心跳 |
| T-04-17 (P) | supervisor死亡但残留fresh心跳、harness仍活；未登记reserved在0/30000/30001ms → 前者uncertain持槽，正常窗口starting，超窗uncertain不重发 |
| T-04-18 (P) | 两supervisor同ticket CAS；错hash/launch_digest/slot holder → 单赢家登记/写文件/启动，输家零backend调用且不改赢家文件 |
| T-04-19 (P) | armed建gate后死、submitting commit后RUN前死、RUN后回执前死 → 只在真实证据齐时N/R/Q，否则uncertain；不重建gate/重发RUN |
| T-04-20 | gate重复RUN、MCP重启重传票据、恢复进程改phase回reserved → 拒绝重复，单个许可调用上界1；不能据此断言目标必执行 |
| T-04-21 | reserved/armed先CAS never_submitted并封口，再迟到执行者；另已submitting响应不明 → 前者N且零晚启动，后者不得N/failed，维持uncertain |
| T-04-22 (P) | cancel接受、INT/10s/TERM/2s/KILL，步骤间已R/Q终结 → 按实际时间阶梯，终态后无信号；只发信号不改cancelled |
| T-04-23 (P) | 每步前后模拟anchor/PGID复用、control pipe关闭/错误scope → 无破坏信号给新组；不能安全绑定则cancel_unconfirmed/uncertain，无数字PID回退 |
| T-04-24 | 无正式R但保留原leader退出receipt+启动证据+正确scope空/封口，与仅PID消失两组 → Q ended/cancelled(NULL) / uncertain，恢复者不补退出码 |
| T-04-25 (P) | supervisor SIGKILL、scope活/未知/可证空+leader receipt各组，恢复观察器尝试续心跳/领票据 → 仅合法证据迁移；观察器写证据但无新launcher身份 |
| T-04-26 | 重复cancel重试、取消先于退出/退出先于取消、ack丢失 → grace不重置，R/Q后才cancelled或already_ended，旧信号不盲重发 |
| T-04-27 (P) | 父MCP真实退出，continue/stop两配置，再模拟仅caller stale → continue继续；stop生成预授权取消并待确认；stale不触发误杀或放槽 |
| T-04-28 | shared父A context关闭、B仍有效；新MCP同owner重放 → 仅A委派按策略处理，B无变化；重放原run，不撤销已接受取消/重复启动 |
| T-04-29 | hud-run原始UPDATE state、HUD试补回执/放槽、status触发写、恢复观察器写meta → 白名单/只读拒绝；正确reconciler迁移state+槽+event原子 |
| T-04-30 (P/A8) | 甲新实现跑检测/context/函数/前台PGID/input/Ctrl-C/resize/quit/kill/pane-close/parent-exit/supervisor-death全矩阵 → 实例/输入落点/回执/心跳逐项脚本对账，prototype通过不替代新实现 |
| T-04-31 | 乙同票据竞争dispatch、Hfresh+leader alive、正常退出/pane关闭/parent退出/sidecar死 → 原票据只允许一次dispatch，scope_ref仍NULL；leader诊断不当范围G，正式Gunknown且已发任务uncertain持槽，R-02-2/3/5不可达，无scope信号或伪造R/Q；未发时完整围栏N仍可达 |
| T-04-32 | Codex shell env缺失、配置env/本轮参数claim、_meta只存在但trust unverified、daemon-present未测、Herdr未测布局 → 不拿metadata或三跳外推授权；保留unsupported/待验证分支 |
| T-04-33 | A8原型1s心跳/旧reason、shell137/真实harness signal未知、exec仅--version → 正式格式用5s/30s及本文枚举；不把原型exit.json直接当最终R，完整exec TUI仍未验证 |
| T-04-34 | 历史locator/新occupant、headless无input能力、合法focus/input请求 → 分别stale_locator/unsupported/交HostAdapter，零隐式resume，不绕输入队列 |
| T-04-35 | run heartbeat stale、Jev needs_human/本地runner退出、collect过期 → run槽不因TTL释放，browser继续持有待结果对账，collect仅06按代次接管 |
| T-04-36 (P/A8) | supervisor SIGKILL后外层shell返回、harness PID仍活但前台归属未知/改变；另向supervisor发INT/TERM/HUP → 前者input/focus拒绝且uncertain持槽，不把PID活等同可交互；后者仅对核验harness组发信号，shell-only退出不终结，待第二轮证据 |
| T-04-37 (P) | armed→一次RUN→shell另建harness组，分别在发现前/核验后写scope前崩溃；另同实例后来发现成功 → kind/strategy始终固定，未核验scope_ref=NULL、Gunknown/uncertain持槽且零scope信号/R/Q；恢复不重发RUN、不把shell组填入；成功后仅一次NULL→真实scope、H+Galive按02恢复running，SQL拒绝后续改范围 |
| T-04-38 (P) | 合成空闲run跨10个心跳间隔，再注入退出/取消事件并记录SQL/唤醒/系统调用 → 定时路径每间隔恰一runs UPDATE、零evidence/event/meta写、零proc/组扫描循环，空闲CPU≈0由06基准；退出事件才做必要组空检查并落回执 |
| T-04-39 (P) | 正常spawn+wait、harness退出、run终结或只剩无活跃控制的uncertain历史、stale截止H仍fresh/确stale四组 → 生命周期自动推进无需调用者手工登记；hud-mcp随harness退出、hud-run/helper收尾后退出，历史/槽保留；只真stale/请求/运行事件对账，无全局常驻timer服务 |
