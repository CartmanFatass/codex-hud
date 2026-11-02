# 04：hud-run 托管、回执与恢复证据

- 版本：`v0.4 draft`（2026-11-01；Oracle C01–C14、D01–D13 修订）。
- 状态：A1 第二批草案；数据格式与证据生产要求待主审/A9，未宣称已实现进程协议。
- depends-on：[01 身份](./01-identity.md)、[02 执行协议/唯一对账表](./02-execution.md)、[03 生命周期](./03-lifecycle.md)；[概念方案](../universal-hud-concept.md) §6.6.4–6、§6.10–11、§15–16；[工程计划](../universal-hud-engineering-plan.md) B3a/B3b/B4/B6。
- 证据快照：[Oracle §4–5](../reviews/2026-11-01-astra-contracts.md)选择修订方案甲。[A8](../probes/hud-run-visible.md)首轮拒绝；A8-fixB2 的同 agent/session 状态、实际 context 命令及父 launcher 退出后 TTY 前台输入/收尾关键证据已于 `8fdf4cf` 接受。仅覆盖所测版本与 pane 前台 hud-run 形态，后台形态为负对照；不等于 B 的生产取消/复用/性能/真实父 MCP 故障矩阵通过。A3 五份探针已评审，Codex 0.166 主身份路径及有界 spoof 见01。[daemon 补测](../probes/codex-daemon.md)覆盖 CLI 0.166 / managed app-server 0.163 在场的默认 direct-stdio；不证明共享调度，不是 A9 前置。

本契约不承诺恰好一次或所有后代/外部动作均停止。保留唯一 supervisor、单次执行票据、真实实例核验与证据驱动终结；HUD 只读。G13/G14要求空闲阻塞等待、不新增常驻 reconciler/sidecar/通知服务；所有性能、进程数/RSS、逻辑写入/实际 I/O 与 accepted→started/bound 的计量预算统一归 [06](./06-observation.md)。这里只规定生命周期和证据，不决定呈现。


[Oracle consult 2](../reviews/2026-11-01-astra-consult2.md) D01–D13 补齐字段、控制主体与读取边界；本轮仍是 A4/A9 候选契约，不代表 A9 放行或 B 生产能力已验证。

[Oracle consult 3](../reviews/2026-11-01-astra-consult3.md) E01–E06 同步观测绑定、取消分类、事实时序与 export v1；仍是 A9 候选，不代表阶段 B 生产验收。

冻结后生效版本：`A9 + consult4-2026-11-01`。本地管理增补依据 [Oracle consult 4 F05](../reviews/2026-11-01-astra-consult4.md#f05明确本地管理主体及-writer-接线)，此前 C/D/E、A9-fix 和 schema v1 保留；允许 helper 形态不等于生产故障矩阵已验收。（consult 4 增补，F05）

## 数据模型

### 运行、启动输入和范围

每个活跃 run 一个独立 supervisor；hud-mcp 随实际加载它的 harness 起停。shell 档案另计必要启动 shell；若维持范围实例确需 helper，须单列进程/RSS、寿命随 run、不获得第二份执行权；不强制 gate/helper/RUN 消息拓扑。终态收尾后退出；仅剩无法控制/取证的 uncertain 历史时保存末次事实后退出，不为历史槽永远心跳。恢复观察器按需取证后退出，不变 launcher（T-04-38、39）。

启动输入 `{runId, mode, launch:argv|shell, cwd, source_id, profile_digest, stdin, orphan_policy}` 加私有票据/claim；MVP strategy 为 headless 或 visible wrapper，scope_kind 仅 pgid。argv 逐参数直接 spawn，不能让 hud-run 自己 exec 掉却承诺保存回执；shell 用已解析绝对 $SHELL -ic <text>，不把 argv 拼 shell/猜 executable。完整 managed shell 档案必须是已验证的单次前台 harness 启动，任意延迟/循环/后台脚本不自动支持；中间 shell 也是可能继续提交的 launcher（T-04-1、2、19、21）。

启动 cwd 必须等于02意图事务已冻结的 `runs.launch_cwd`；spawn/resume/handover 逐 run 保存，不按执行时 CLI/callers.cwd 重算。meta 只可携带 `launch_cwd` 及随意图固定的 `project_origin` 等稳定启动信息；Git 位置快照由已有 run 写者依06预算在事务外采集、NULL→首次 workspace_snapshot 与 workspace.captured 事件同事务提交，不把实时 workspace/Git 状态复制进 meta。包装链实际改变 cwd 时只在06 observed workspace留有来源的新观察，不能覆盖启动历史（T-04-40）。

Codex 每轮使用档案服务器名，构造 argv/TOML 叶子覆盖 `-c mcp_servers.<name>.env.HUD_CLAIM=...`，同样注入 HUD_RUN/HUD_LINK/HUD_HOME；保留用户 command/args、其他 env/server。不得使用 mcp_servers={} 或整表覆盖。resume 新 claim 同样重新注入；source 从档案与核验过的实际 harness home/存储根确定，不从 MCP 缺失的 CODEX_HOME 猜。初始化仅登记/保存材料；首次合格 tools/call 的 params._meta 与启动/source/精确 header 一致才绑定，参数 `_meta` 不授身份。正常 env 不强制 prompt 明文 claim/transcript 扫描；运输/身份 fallback 与 unsupported 列表只引用01（T-04-2、32）。

`ProcessStamp={pid,proc_start,boot_id,pid_domain}`；pid 正整数、proc_start 为内核启动 tick 字符串，pid_domain 包含本机身份/PID namespace，ProcessKey 另把 boot 身份编码其中，与01一致。`command_leader` 为实际直接命令（可能中间 shell），`harness` 为独立核验的真实实例；只有证明同 pid/start/boot/域才可相同。启动回执向01投影 harnessPid/harnessPidStart，不能拿 shell 冒充；无法唯一发现为 null/unknown，进程名/第一个匹配不够（T-04-3、4）。

scope 是固定的真实 harness workload PGID，连同 sid、boot/PID 域、组实例/leader stamp 固定。visible 用目标前台 job 的组，不能预填后台 supervisor/shell 组。strategy/kind 在意图固定；scope_ref 唯一核验后 NULL→真实范围一次写入，不得事后缩范围。发现有截止，可按事件补证；未知时禁 scope 信号/R/Q，不重发启动，依02持槽取证。短命启动来不及固定范围是 unknown，生产能力需 B 验证（T-04-5–7、37）。

完整 scope 无活 workload 不等于所有 PID 都消失：Z 是已终止未回收，可单列；S/T/D 等仍可能执行，必须持槽。原 harness 不再执行以及所有可能 launcher/控制通道封口或死亡也是结束必要条件，不能凭当前 PGID 空忽略 `sleep; harness` 的 shell。普通 setsid/换组工具后代不扩大默认范围；若确证原 harness 或同 SessionRef 旧写入实例仍在范围外活着，则02冲突阻断终结/复用，不能归为无害诊断。跨 boot 仅同机/全部旧启动通道死亡或封口证实后可证明旧实例终止，不能查询/控制新 boot 的同数字 PGID。


### 文件、字段与原子提交

完整 supervisor 实例的原子权威是02登记事务内的唯一 `supervisor.registered` 事件：`run_id/link_id` 与 payload `{sourceId,bindingGeneration,supervisor:{pid,proc_start,boot_id,pid_domain}}`。CAS 消费票据、runs 的 armed/首心跳、claims 的 armed/pid/start 与该事件一起提交或一起回滚；stamp 四字段不可变，runs/claims 的 pid/start 仅校验投影。meta 的后写或丢失不影响这一权威。恢复及兑换 claim 先读取此提交记录、核对 run/source/代次及 pid/start；缺失、不完整或矛盾保持 unknown，不从当前 boot_id/pid_domain、/proc 现值或 meta 补历史实例。已保存的跨域 stamp 原样保留，域不可见时不据相同数字 pid/start 判活/死或控制；同机跨 boot 的额外终止证明仍遵循既有规则。不新增表/列，events 已能承载完整白名单元数据（T-04-42、43）。

事实时间统一依02「证据归一与事实时序」：scope 的 asOf=checked_at，R=最终终结证明 ended_at，Q/N=复合证明边界，H=producer heartbeat_at；recorded_at/validated_at/导入events.seq不能补先后。run.ended_at可能是较晚对账观测时间，增量读取须带 terminal_evidence_id 指向的已核验终结边界/结果和未解决冲突，不能借commit时刻抹掉反证。

路径固定为 `$HUD_HOME/runs/<runId>/{meta.json,stdout.log,stderr.log,exit.json}`。runId 仅 `[A-Za-z0-9_-]{1,128}`，HUD_HOME/运行目录是已解析绝对路径；拒绝路径穿越、符号链接替换和不属于当前用户的目录。目录 0700，文件 0600；已有目录只在 ledger/run/实例均相符时读恢复，不截断、不复用旧 run 的日志。只有成功取得票据的本轮 writer 写 meta/log/exit，失败竞争者不碰它们（T-04-8、9）。

文件 schema_version=1，未知版本拒作授权/终态证据；时刻毫秒 epoch、时长同 boot 单调钟，未知 null 而非0/空串。仅票据赢家单写，哈希均 SHA-256 小写64hex。

| 文件 / 内容 | 必要字段与更新规则 |
|---|---|
| meta.json | schema_version、run_id/link_id/source_id/binding_generation、mode/supervision_strategy、supervisor/command_leader/harness 的 ProcessStamp或null、scope、launch_digest/profile_digest、launch_call_id、HUD自生成launch_correlation_id、created_at、stdin_mode/capture。只保存稳定启动身份/范围；初始尚未知的实例/scope核验后一次补齐，身份不覆盖。原生 launch_message_id 可晚到，存在ledger/evidence，不强制meta更新；不复制实时state/H、局部退出或取消进度 |
| scope | `{scope_id,scope_kind:'pgid',pid_domain,boot_id,pgid,sid,group_leader}`；scope_id绑定run/boot/组实例，不是可重用数字PGID。scope未知为null，已知后冻结 |
| 部分 evidence | shell/leader退出、supervisor HUP、启动/封口、范围成员与Z、取消步骤等白名单事实及时追加到ledger evidence；含subject/process/source、asOf/observed_at。部分退出不写临时版本 exit.json |
| exit.json（最终一次） | schema_version、receipt_id、run_id/link_id/source_id/binding_generation、mode/strategy、supervisor/command_leader/harness、scope（N可null）、coverage:scope或not_submitted、created_at/started_at/ended_at/recorded_at/duration_ms、native_exit、shell_exit、reason、scope_check、submission_fence、cancel_request_seq、logs。身份/范围匹配ledger权威及存在时的meta；缺meta不阻独立Q/N取证；无revision/渐进升级协议 |

`ExitObservation={process,subject:command_leader|harness,observed_at,exit_code,signal,status_source,evidence_id}`。native_exit 只允许 subject=harness、来源 wait_status/trusted_harness_result，code/signal恰一非null；无法直接 wait/无可信原生结果时 native_exit=null。shell_exit 单列真实 shell code/signal与来源，不把0/130/137推harness结果；supervisor HUP也只是其自身 evidence。原 harness 已结束的证明可以没有任何已保存的退出结果，部分观察不复制成原生结果（T-04-10、12、13）。

`ScopeCheck={scope_id,checked_at,result:alive|gone|unknown,visibility:complete|partial,member_evidence_ids,zombie_evidence_ids,launcher_seal_evidence_ids,harness_termination_evidence_ids}`。gone须正确boot/域/固定实例完整无活 workload、原harness不执行、全部launcher/通道封口或确证死亡；无需leader receipt。可以是可信完整成员枚举且只剩Z，不能只要求kill(-pgid,0)=ESRCH；仅单PID不见/EPERM/可见性不全/复用不可辨都unknown。跨boot按上文同机证据单独判断，不能把新boot成员当旧scope。所有本轮控制helper也必须已封口且无workload能力，不能靠排除可工作的成员凑空组（T-04-11、24）。

submission_fence引用持久event_seq/at与封口proof_ids；DB时间戳本身不能证明活着/暂停的launcher不再能启动。reason为 scope_ended（原生结果未知）、normal_exit/nonzero_exit/signal_exit（需native来源）、cancel_confirmed（已接受取消+可信结束时序）、preflight_failure（仅N）。ended_at是确认无活workload/未执行的观测时刻，不伪称内核实际退出瞬间；N的duration=0，不能求同boot时长则null。

meta/final exit用同目录O_EXCL/O_NOFOLLOW临时文件，写完整UTF-8 JSON→fsync(file)→atomic rename→fsync(dir)。最终exit一次不可变提交；同run/receipt重复同hash幂等导入，异hash冲突，半文件忽略。不要求死supervisor曾写leader/exit receipt；恢复由reconciler记Q，不续写其meta/exit。先落最终receipt再幂等导入evidence，最后按02同事务写终态/槽/claim/events；文件落盘而DB未提交不导致重执行（T-04-9、14）。

stdout/stderr为单writer追加原始字节，offset/bytes按字节，不因resume/恢复截断。headless捕获file，brief读一次EOF或stdin关闭；visible TTY直通、不读取输入，capture=tty_passthrough/unavailable，空日志不证明无输出。日志可能含正文，只在本地私有文件，不默认进ledger/模型；公开fixture合成字节。PTY采集未在MVP提供（T-04-15）。


## 不变量

| 编号 | 可检查断言 | 层 / 测试 |
|---|---|---|
| I-04-1 | argv/shell契约互斥、source/home与档案一致；启动cwd用逐run冻结值，meta只稳定上下文；shell leader与实际harness独立记录，只有确证同实例才等同 | TX+E；T-04-1–4、40 |
| I-04-2 | strategy/kind意图固定，唯一核验真实harness/PGID后scope_ref一次写入冻结；不缩范围。普通范围外工具仅诊断，原harness/同SessionRef旧写者仍活则阻复用 | DB+TX+E；T-04-5–7、23、30、37 |
| I-04-3 | 文件身份/版本/权限固定；只有票据赢家单写meta/log/exit；receipt先原子落盘再幂等导入，恢复不重启、不截断 | TX+E；T-04-8、9、14、15 |
| I-04-4 | scope结束与原生结果分离，exit_code仅有来源harness结果；shell status分列，shell137/HUP不冒充native。最终exit只提交一次，局部事实留evidence | TX+E；T-04-3、9、10、12、13 |
| I-04-5 | 02是唯一对账真值表；R/Q结束需正确boot/域/范围无活workload、原harness不执行、所有launcher封口，无leader receipt也可Q；缺证unknown/uncertain | TX+E；T-04-11–14、24、25、37 |
| I-04-6 | 每5s写本实例心跳；>30000ms stale、=30000仍fresh；心跳只证明托管活性，不证明child启动或结束；确认死亡优先于残留fresh | TX+E；T-04-16、17 |
| I-04-7 | 一次CAS消费票据，完整不可变stamp事件/armed claim/首H同事务，恢复只认事件、缺证unknown且不补当前域；唯一supervisor先submitting再一次spawn/提交；恢复/MCP重启不重置票据/阶段，不强制gate/helper拓扑 | DB+TX+E；T-04-18–20、42、43 |
| I-04-8 | 永久围栏禁止未来提交；N须真正未提交与全部启动者封口/死亡，submitting未知不得当N。中间shell/暂停launcher也需封口证据 | TX+E；T-04-19–21、24 |
| I-04-9 | 取消须覆盖整个scope且每步核验实例；INT→10s→TERM→2s→KILL，信号成功不终结。无安全整组控制就cancel_unconfirmed，不降成单PID，不杀复用组；固定 runId 的 trusted_local cancel 须经独立实际 UID/私有 ledger 门禁，未绑定 run 也可管理，重复不重置宽限，helper 形态仍验完整故障矩阵（consult 4 增补，F05） | TX+E；T-04-22、23、26 |
| I-04-10 | 默认continue独立托管；stop只在确证父上下文/物理实例失联后使用接受时策略取消；不把父离线/unknown当子结束 | TX+E；T-04-27、28 |
| I-04-11 | hud-run写字段白名单；身份回填/状态/槽迁移统一reconciler，HUD只读。恢复观察器不给新执行权；真实 writer 校验 LocalManager 与私有路径/账本所有权，trusted_local 审计不伪造 owner/父 MCP，reconcile 仅固定 run/证据指纹幂等及版本重验，无强制放槽（consult 4 增补，F05） | TX；T-04-14、25、29 |
| I-04-12 | MVP可见采用修订甲；父MCP断连continue单独验收。supervisor死即交互中断/uncertain/持槽，禁自动input/focus/fg/wrapper恢复/resume；正常scope结束不因native未知变uncertain | TX+E；T-04-30–33、36 |
| I-04-13 | RunHandle固定run/locator/绑定代次；status只读，cancel经鉴权意图，input/focus可选且重验occupant；HUD管理动作copy-only，本地resume按typed initiator/幂等/expected-run门禁，不通过控制动作resume副本；LocalManager cancel/reconcile 与 local_user resume 为独立入口，不要求已确认 parent_ref，不扩大 resume 或关系权限（consult 4 增补，F05） | TX；T-04-29、34、41 |
| I-04-14 | 运行心跳不作TTL放槽；browser还需answered/failed+对账，needs_human继续持有；collect只属06观测存储 | TX；T-04-35 |
| I-04-15 | 无新常驻服务；空闲阻塞、5s心跳一次runs CAS，不周期复制event/evidence/meta。发现有截止，生产禁100/200ms扫组；恢复按启动/重连/事件/wait必要截止/显式请求触发，预算归06 | TX+E；T-04-38、39 |

## 状态机

### 单次提交与围栏

1. 完整意图/槽提交后，hud-run经继承私有pipe/受保护输入取得票据/launch材料，不放可读日志/meta。短事务重验ticket hash、launch_digest、slot、类型化发起权限（MCP当前context/代次或01本地管理主体）、取消/冲突/围栏，CAS reserved+无supervisor→armed+本实例/H。输家不碰赢家文件，零backend调用。
2. 唯一supervisor先提交submitting再调用一次spawn/宿主动作；不要求独立gate/RUN或额外观察器。命令成功的精确回执才submitted，未知不重发。真正harness/PGID核验后一次固定scope；短命/发现崩溃scope未知则持槽取证，不把shell组填入，不授恢复者执行权。
3. 提交前取消/拒绝以持久fence及确证未提交/无workload形成N；已许可/响应未知只能取证，不因DB改字段倒推从未执行。终结前，所有可能再提交者（含中间shell）须封口或死亡。直接单次spawn可由原supervisor状态/死亡与内核等待取证；确需helper/私有通道的实现也须证明同样结果，不增加第二份执行权。

before-supervisor的reserved正常窗口仍用02 R-02-4a；超窗只uncertain/对账，不能自动取回票据。04只规定证据生产，不另列state×evidence真值表，所有迁移/优先级唯一引用02。

### R / G / H / N / Q 的证据生产

证据按02「证据归一与事实时序」核验实例/代次及时间来源，先约简可变scope/H；不可逆R/Q/N、死亡/启动事实和未解决冲突不统一取最新。旧alive晚导入不否定后来终结；R/Q/N事实边界及之后的目标workload/未封口launcher反证归一为持久X，不能由unknown/gone静默清除，同刻缺证不伪造X。

- R：原hud-run最终scope receipt，校验run/source/代次/boot/域与ScopeCheck/全部封口证据；native_exit允许null。只有leader/shell/supervisor事实不产R；scope宣称结束却仍有活成员/原harness/未封口launcher则X。
- G：本机可信完整范围检查，区分活成员与Z；固定scope/原harness/全部launcher封口满足02才gone。组未知、错域/复用或部分可见则unknown，不用单PID缺失代替。
- H：下文一次runs CAS的真实producer元组；只证明监督活性。按事件取采用快照，不周期追加evidence，不由恢复者续死人心跳。
- N：可信未执行事实+永久围栏+全部可能启动者不可再提交+无workload；未知提交响应/只有失败日志不够。reserved无消费者可在事务围栏后证明，不能把armed暂停者当封口。
- Q：supervisor被SIGKILL且没有leader/exit receipt也可达；恢复器用持久可信启动/固定scope、原harness已终止、完整无活workload、所有launcher封口/死亡及无矛盾，写scope_reconciled复合evidence，未知native结果终结。不重写死writer文件/补码；仅PID/pane消失或人工按钮不够。已确证同机跨boot按旧实例证明，不能去控制新boot同数字组。


### 心跳、supervisor死亡与恢复

登记执行者的短事务同时保存上述完整stamp事件、armed claim及首个heartbeat_at/seq/mono；文件I/O在事务外写启动meta，登记提交后/meta前崩溃仍以事件恢复。之后每5000ms仅一次`UPDATE runs SET heartbeat_at=?,heartbeat_seq=heartbeat_seq+1,heartbeat_mono_ms=? WHERE run_id=? AND supervisor_pid=? AND supervisor_proc_start=? AND heartbeat_seq=? AND state IN ('starting','running','cancelling','uncertain') RETURNING cancel_requested_at`；CAS不匹配即停止冒充写者。定时器不追加heartbeat evidence/events、不重写/fsync meta；取消可由私有通道唤醒，返回的已接受取消字段也无需额外轮询读。退出/冲突/对账等实际事件才固化需要的心跳快照，meta不作为运行状态副本，只有稳定启动身份/范围首次补齐时更新。观察器不续写旧supervisor。UTC负差/与同boot单调钟显著矛盾时一次记录clock_anomaly并unknown/uncertain，不通过给旧事件盖新时间续命（T-04-16、38）。

supervisor通过wait/SIGCHLD、已验证的稳定进程句柄/控制通道退出事件获知结束，不用/proc扫描循环。范围检查仅在有截止的启动发现、退出事件、取消阶段或有预算恢复时做必要检查；组仍活时等待可得的成员/控制事件，不能靠高频扫组求完成。缺事件能力只能保留unknown/按需对账，不能虚报R（T-04-11、38）。

status只读快照，不触发写。现有hud-mcp启动/重连、相关运行事件、wait必要截止、显式hud run reconcile触发有预算恢复：遗留完整receipt按指纹幂等导入，无receipt旧run按02同表采集Q/N或缺证。文件/提交提示只作hint，按run过滤与合并heartbeat/WAL噪声，不让每心跳唤醒所有waiter全量复查；漏通知在必要截止复读，预算归06。

stale截止先只读最新H；仍fresh延后，确stale或内核退出证实supervisor死/替换、且无更高R/N/Q，才由reconciler记uncertain/持槽。确认死亡优先残留fresh，活child不授新票据。无活写者时HUD可给stale/uncertain投影，不能声称后台已自动终结；无常驻恢复服务/按秒全量扫组（T-04-17、25、29、39）。


### 取消与父断连

（consult 4 增补，F05）RunHandle.cancel 先由 reconciler 检查当前 owner/context、独立 LocalManager 或已接受 orphan_policy；短事务写固定原 run 的 cancel_requested_at/cancelling/accepted 事件并返回，完整取消时延另计。受信本地 cancel/reconcile 的主体是同一 OS 用户对其私有 HUD_HOME/ledger 的管理权限，以 `LocalManager={kind:'trusted_local',uid,invocationId}` 表示；只有核验实际 UID、目录/账本所有权及私有路径的本地入口可构造，真实 writer 必须通过同一管理门禁再次校验，MCP/模型参数不能选择此分支。未完成 parent/child 绑定的 run 也可管理，不要求已确认 parent_ref；它不代表 OwnerKey、不转移 parent/child/owner，仅对固定 runId 的 cancel/reconcile 有效，不授 spawn/resume/report/predecessor 权限。01 authorizeControl 的 local_user 仍仅允许 resume，不能让管理操作继承或放松 resume 的 parentRef/representedOwner 前提。

hud-run读取取消意图后，先封口启动，执行SIGINT→grace（默认10000ms，允许0–60000）→SIGTERM→termGrace（固定2000ms）→SIGKILL；宽限从实际发出/确认步骤时开始，不从网络请求超时算。每阶段先检查是否已有R/Q/N，已终态不再发信号（T-04-22）。

（consult 4 增补，F05）必要的一个 in-group helper 可作为稳定整组控制机制，随 run 收尾，不另起恢复服务；进程数、寿命、CPU、RSS 与启动成本计入 P-06-1/3/9。仍须验证 leader 先退、helper 死亡、PID/PGID 复用、启动未封口和整组信号，有 helper 本身不能替代这些证据。

ScopeControl必须安全覆盖本轮整个PGID及仍可能再启动的launcher，逐步重验正确boot/域/范围实例。直接leader已退仍需等强稳定控制证据防PGID复用，不能盲发数字；共享supervisor组不能悄悄退为单harness PID。实现可隔离workload组或提供经验证的完整控制机制，不强制某anchor/helper拓扑。失去安全整组控制只返回cancel_unconfirmed/uncertain并持槽；helper若需要，寿命/RSS计入06，改变exec链/TTY路径只补验受影响的context/输入行（T-04-23）。


信号已发、shell退出、TTY Ctrl-C、supervisor收到HUP不是取消完成。取消接受与chronology分开：完整R/Q且无X，仅before_exit正向证明才按R-02-2 cancelled；after_exit已证明才解释already_ended；缺失/unknown按R-02-3 ended、释放槽并存terminalNote=cancel_timing_unknown，不声称confirmed/already_ended。before/after两个有效互斥证明为X；unknown本身不是冲突。未证R/Q/N仍cancelling/uncertain持槽，历史通道失败不否定后来完整证明；N仍按R-02-4 failed。terminalNote只保存在既有终态事件并按03投影，不为说明重写一次不可变exit.json的reason；R-02-0保留原结束决定与说明，迟到时序只审计。重复cancel不重置grace时钟、不重发已确认步骤；步骤以eventseq与ack记录，崩溃后无ack只对账，不盲发旧scope（T-04-26）。

orphan_policy随意图冻结。continue默认：父MCP物理实例确实退出/可信父context关闭时写parent.offline事件，含runId、父context/代次、since（毫秒epoch）、冻结策略，seq/created_at随事件投影；这只是父调用通道离线，不证明父session/子scope退出。继续保有TTY的子前台/输入/最终收尾须独立验收；非TTY后台sleep不足。stop在确证断连后以预授权策略产生取消意图，走同一完整范围序列；caller stale/Herdr unknown不触发误杀。新MCP同OwnerKey重放旧run，不撤回已接受取消/起副本（T-04-27、28）。

[daemon 补测](../probes/codex-daemon.md)的vendor stop返回stopped后updater仍活，故vendor停止响应不是所有vendor启动进程已退出的证明。仍按已记录实例/声明范围核验；普通范围外vendor进程不自动扩大本轮范围/信号权限，已证实同会话旧写者继续阻复用。


### 写者与RunHandle

hud-run允许：CAS消费/登记票据和启动阶段、scope/leader原始证据、自己的心跳、取消步骤ack、私有文件；reconciler负责证据校验、context/身份回填、关系与run状态迁移、槽释放和事件的原子提交。hud-run可调用同一reconciler入口，不能私有UPDATE state绕过R-02；HUD绝不补写丢失回执/槽，collect不属于hud-run。

（consult 4 增补，F05）本地管理接线保留具名的 LocalManager/authorizeManager/acceptCancel 入口（如 src/core/run/port.ts），与 authorizeControl 的 local_user resume 分开；可共用实际 OS/私有路径核验实现。B2 必须在真实 RunFactPort 闭合 ledger/private-path 所有权验证，不能把收到 trusted_local、uid 数字或调用某函数名当已验证；B3a CLI 对 HUD_HOME 的检查不能替代此 adapter/writer 职责。管理审计使用既有 event 的白名单 payload，记录 `actor.kind=trusted_local`、实际 UID、invocationId、固定 runId/目标 bindingGeneration，不伪造 representedOwner、父 CallerId/context 或 MCP tool_result。cancel 短事务接受原 run 意图，信号仍逐步核验完整范围/实例，重复取消不重置宽限时钟；reconcile 按 run/证据指纹幂等、提交前重验版本，仅按既有 R/N/Q 等规则迁移/释放，不增加 force-release/admin override。

（consult 4 增补，F05）MVP HUD 的 Resume/Reconcile 仅消费03 `ActionDescriptor` 显示/复制，不启动控制 CLI；Open/focus 不携带此执行权。本地 resume 继续仅按01 local_user 窄例外、02幂等顺序与03全部门禁，原 actor 形状不变。CLI 形态 `hud run resume <linkId> --request-key <key> --expected-run <runId> --mode <visible|headless>`；实际复制命令还含安全引用的显式 HUD_HOME。记录 actor.kind=local_user、UID/invocation/representedOwner 和本地 launch_call_id，不造父 CallerId/context/tool_result；票据登记及单次提交按原意图的 typed initiator 重验。未来直接调用条件/重试边界只引用03（T-04-41）。

`RunHandle={runId, locator, bindingGeneration, status(), cancel(grace?), sendInput?(text), focus?()}`。status只读已提交状态、心跳、scope/leader/harness/receipt覆盖及证据，并提供03的reconciliation.cause和interaction三项能力，不做隐式reconcile写。cause区分supervisor_dead、scope_unknown、resume_ref_mismatch、clock_anomaly等已有原因；监督故障三项均false，与父调用通道离线的parentOffline分开。cancel经上述鉴权意图。sendInput由宿主队列或v1.1入口实现，headless未定义就unsupported；focus由HostAdapter实现，先检查server/locator与occupant代次。supervisor死亡/失联或可见交互不可用时input/focus禁用；输入/聚焦不等于取消、不能隐式resume；历史locator不匹配只返回stale_locator（T-04-29、34）。

### 可见模式：修订方案甲

MVP选择wrapper甲：hud-run被输入pane交互shell，必须是 pane shell 正在等待的前台作业；shell档案用-ic保留函数/context，supervisor不读TTY，harness须为经核验的终端前台消费者，scope发现并核验真实harness PGID。不能以 `sh -c '<hud-run> &'` 后台形态替代，TTY stand-in负对照已显示输入落shell/SIGTTIN。HostAdapter管理surface/就绪/输入/焦点，supervisor供进程证据；命令已发未知不fallback再起。正常结束按scope证据产R，shell状态与native结果分离，native未知不使正常结束一律uncertain。直接argv/最后一步exec绝对可执行文件仅作经验证包装链的可选简化；exec codex函数不证明成为直接子进程，也不强迫改用户函数。

父MCP/launcher断连默认continue与supervisor死亡是不同事件。supervisor死后甲的交互中断：已记录前台回到shell、输入落shell与suspended (tty input)；不虚构采样已看到T。立刻/失联确认后uncertain、持槽、interaction unavailable；停止自动input/focus，禁自动fg、重建wrapper、透明接管、resume副本。用户可读诊断；旧scope结束并按02对账后才可新一轮（T-04-36）。

A9仅需选定机制的关键可行性与失败分支：A8-fixB2 已于 `8fdf4cf` 接受，补齐同agent/session状态、Codex实际执行合成context命令、父launcher退出后TTY前台/输入/最终收尾；A8-fixB1的scope观测与监督死亡故障语义继续保留。这里的A8-fixB2不是工程WP B2，也不证明真实父MCP全部故障矩阵通过。无需强求Herdr没有的字面idle状态、daemon-present命令执行或完整B能力矩阵。生产安全整组取消、leader先死/组仍活、PID/PGID复用、短命启动/重启、tmux/resume、真实父MCP断连与性能仍由B3a/B3b/B14验证，不把原型200ms扫组/1s心跳搬入产品。

### Deferred（后续能力）

乙sidecar保留探针材料，不提供MVP managed执行/正向dispatch；它尚无完整范围结束、取消及启动封口通道，MVP请求unsupported，不能在甲未知时自动改走乙。cgroup provider、跨机器/PID域主动控制、所有后代永不逃逸、自有PTY/tee、透明重接管推迟；本版只声明本机已验证PGID范围，其他域unknown。正向流程/DDL/用例不在本版冻结。


## 失败案例

| 编号 | 场景 / 预期 | 不变量 | 测试 |
|---|---|---|---|
| F-04-1 | argv拼shell、函数切home、shell PID冒充harness → 拒绝/身份unknown，不建错绑定 | I-04-1 | T-04-1–4 |
| F-04-2 | leader退/组内子活、普通范围外工具、范围外原harness或同会话旧写者活 → 持槽/仅诊断/冲突阻复用，其他PID域unknown | I-04-2、5 | T-04-5–7、11 |
| F-04-3 | 文件半写/旧run覆盖/赢家输家并发/receipt落盘后ledger崩溃 → 忽略半证据，幂等导入，零重执行 | I-04-3 | T-04-8、9、14 |
| F-04-4 | shell137、supervisor HUP、只有leader回执 → 保留subject/nullsignal，不升级scope R | I-04-4 | T-04-10、12、13 |
| F-04-5 | fresh残留心跳但supervisor已死、时钟异常、假续心跳 → uncertain，child活也不授新票据 | I-04-6、11 | T-04-16、17、25 |
| F-04-6 | 同票据二supervisor、提交未知、发现窗口崩溃、暂停shell仍可未来启动 → 输家零动作或uncertain，缺scope不信号/终结，不重发 | I-04-2、5、7、8 | T-04-18–21、37 |
| F-04-7 | 信号成功组仍活、PGID复用、整组控制丢失 → cancelling/uncertain或已有终态，禁止单PID回退/杀错组 | I-04-9 | T-04-22、23、26 |
| F-04-8 | 父MCP断连/重启、仅caller stale、vendor stop仍留updater → 按快照策略/完整scope证据，不把父或vendor状态当结束 | I-04-5、10 | T-04-27、28 |
| F-04-9 | 请求乙managed或未验证transport，甲监督故障仍自动输入/恢复 → unsupported或uncertain持槽/禁交互，不伪称支持 | I-04-12 | T-04-30–33、36 |
| F-04-10 | 旧locator输入、HUD补回执、浏览器needs_human或collect混用 → 拒绝控制/只读/继续对应租约规则 | I-04-11、13、14 | T-04-29、34、35 |
| F-04-11 | 每秒扫proc/组、每tick追加证据/改meta、终态后留常驻observer → 违反G13；只留必要事件证据/一次心跳写，结束后退出，槽仍按02 | I-04-15 | T-04-38、39 |
| F-04-12 | 登记commit后/meta前崩溃、stamp事件缺失/不全、同pid/start但另一boot/PID域 → 事件完整则保留原stamp；其余unknown/持槽，不用当前域补历史或授恢复执行权 | I-04-7 | T-04-42、43 |

## 测试清单

每项标A9 fixture（规格/表驱动输入）、A9 prototype（最小合成进程与已选A8关键证据）或B（B3a/B3b/B14生产验收）。只02拥有对账真值表，04验证证据来源。原型机制证明不等于生产实现通过，截图/模型自述不替代进程证据；本批不运行付费harness。consult 4 新增的本地管理门禁/接线断言由 B2/B3a 定向生产验收，不追认原 A9 fixture 已证明真实 writer 授权。（consult 4 增补，F05）

| 编号 | 输入 → 预期状态断言 |
|---|---|
| T-04-1 (B) | 含空格/引号/元字符的argv与显式shell函数两组 → argv不经shell解释；shell仅按明确文本 -ic，拒绝双模式/空argv，相同launch_digest可复核 |
| T-04-2 (A9 fixture) | profile source-a但函数实际home-b，stdin brief/closed/tty三组 → 来源错配不授权绑定；stdin模式明确、brief后EOF，双home不合并 |
| T-04-3 (A9 prototype) | shell→harness两个不同stamp，与已验证直接argv/exec同实例 → 独立保存；只有真实native来源才可给runs.exit_code，不强求shell路径native结果 |
| T-04-4 (A9 fixture) | 多候选harness、进程名字相同、短命harness漏观察 → harnessPid/start=null/unknown，不猜第一个或shell；正常候选唯一+启动证据才可供01绑定 |
| T-04-5 (A9 prototype) | leader已退但组内S/T/D子活、只剩Z、普通setsid工具、原harness/同会话写者逃组仍活 → 阻终结/封口等证据齐可结束/仅诊断/冲突阻复用 |
| T-04-6 (A9 fixture) | 请求延期cgroup/跨域控制 → 提交前unsupported/unknown，零外部动作；不得运行中缩成较小scope取空组 |
| T-04-7 (A9 fixture) | 运行中改scope或同cwd孤儿猜归属 → 拒变/不伪造；仅已证实普通范围外工具可诊断，确证旧harness/会话写者须冲突阻断 |
| T-04-8 (A9 fixture) | runId穿越/符号链接/外部用户目录、同目录不同run或票据输家 → 拒绝写入/覆盖；合法目录0700文件0600 |
| T-04-9 (A9 fixture) | 临时/半文件、最终同receipt异hash、rename前后崩溃 → 只完整一次最终exit可导入，异hash冲突；局部事实只evidence，无revision升级，日志不截断 |
| T-04-10 (B) | shell状态0/130/137且native不可得，与直接wait真实harness信号 → 前者native null/shell分列，scope证据齐仍ended；后者可记录native signal/source |
| T-04-11 (B) | 固定scope完整检查有S/T/D、仅Z或空且原harness终止/所有launcher封口、仅PID缺失/EPERM/不可见域 → G alive/gone/unknown，vendor stopped不能替代 |
| T-04-12 (A9 fixture) | 仅supervisor HUP或shell退出、child仍活 → 只evidence、不产最终exit/R；另完整scope证据齐才最终receipt |
| T-04-13 (A9 fixture) | 部分leader观察、scope宣称结束却活成员/未封口shell、错boot/代次证据 → 不终结/X uncertain/仅审计；同机跨boot证明旧scope结束不查询新boot数字PGID |
| T-04-14 (A9 fixture) | 最终exit落盘DB前崩溃/重复导入、无exit却可Q → 同指纹一次采用、零重执行；Q原生结果NULL，不续写原writer文件 |
| T-04-15 (A9 fixture) | 合成UTF-8/二进制追加、visible直通空日志 → 字节offset精确/捕获覆盖如实，零PTY采集承诺；日志私有不默认送模型 |
| T-04-16 (A9 fixture) | heartbeat每5000ms，30000/30001边界、clock负差/错seq/旧producer → fresh/stale精确，异常unknown；恢复器不能更新死supervisor心跳 |
| T-04-17 (B) | supervisor死亡但残留fresh心跳、harness仍活；未登记reserved在0/30000/30001ms → 前者uncertain持槽，正常窗口starting，超窗uncertain不重发 |
| T-04-18 (B) | 两supervisor同ticket CAS；错hash/launch_digest/slot holder → 单赢家登记/写文件/启动，输家零backend调用且不改赢家文件 |
| T-04-19 (A9 prototype) | armed后死、submitting commit后spawn前死、spawn后回写前死；中间shell暂停且可能稍后启动 → 证据齐才N/R/Q，否则uncertain；不强制gate/不重发，活launcher阻终结 |
| T-04-20 (A9 fixture) | 同票据重复提交、MCP重启重传、恢复改phase到reserved → 拒绝/动作上界1；直接单次spawn无需额外分发服务，不能断言目标必执行 |
| T-04-21 (A9 prototype) | reserved/armed永久fence+确证launcher封口/死亡+无workload，再迟到登记；另submitting未知 → 前者N/零迟到提交，后者非N；DB围栏不把已获许可暂停shell变封口 |
| T-04-22 (B) | cancel接受、INT/10s/TERM/2s/KILL，步骤间已R/Q终结 → 按实际时间阶梯，终态后无信号；只发信号不改cancelled |
| T-04-23 (B) | leader先退、PGID复用、整组控制通道丢失、与supervisor共享组 → 有效稳定控制才整scope取消，否则cancel_unconfirmed/持槽；零单PID降级/错组信号；必要 in-group helper 死亡或启动未封口同样保守拒绝，leader 先退/完整组信号的证据及 helper 进程数、寿命、CPU/RSS/启动成本归 P-06-1/3/9（consult 4 增补，F05） |
| T-04-24 (A9 prototype) | 无旧leader/exit receipt，启动记录固定scope、正确boot/域完整无活workload、原harness不执行、全launcher封口/死亡且无X→Q；无取消ended、已证before_exit cancelled(NULL)、取消时序未知ended+cancel_timing_unknown并释放；逐项缺任一条件仍uncertain/持槽，恢复不补死writer文件 |
| T-04-25 (A9 prototype) | supervisor SIGKILL后scope活/未知/证实空，或同机跨boot；恢复尝试续H/领票据/写exit → 按02取证/列缺项，恢复无新执行权且不冒充旧writer |
| T-04-26 (B) | 取消与退出/导入竞态、重复cancel、无ack崩溃：仅before_exit+完整R/Q为cancelled，after_exit为already_ended解释；完整R/Q但unknown→ended+说明/释放，无confirmed/already_ended；before/after互斥为X，缺结束证据持槽；重复不重置grace，迟到证明不重写终态/exit.json或重发完成 |
| T-04-27 (B) | 父MCP真实退出，continue/stop两配置，再模拟仅caller stale → continue继续；stop生成预授权取消并待确认；stale不触发误杀或放槽 |
| T-04-28 (B) | 新MCP同OwnerKey重放、父仅stale、vendor stop称stopped但记录updater活 → 原run无重发/stale不误杀/不据vendor响应放槽；不扩大信号权限 |
| T-04-29 (B) | hud-run原始UPDATE state、HUD试补回执/放槽、status触发写、恢复观察器写meta → 白名单/只读拒绝；正确reconciler迁移state+槽+event原子 |
| T-04-30 (A9 prototype) | A8已选甲的scope/监督故障及已于8fdf4cf接受的A8-fixB2 TTY父launcher退出、实际context命令、同agent/session状态 → 核对已保存证据及版本/前台形态边界；不把原型当生产R/真实父MCP完整故障矩阵 |
| T-04-31 (A9 fixture) | MVP请求乙sidecar managed/甲提交未知自动回退乙 → unsupported/禁止回退，零第二dispatch、零伪造scope终结；只保留探针材料 |
| T-04-32 (A9 fixture) | Codex每轮叶子env注入/保留用户配置/HUD_HOME与source、首合格tools/call才有session、参数伪造/来源冲突、resume新claim → 运输与身份各自核验，fallback只01范围，无重启动作 |
| T-04-33 (A9 fixture) | A8原型200ms扫组/1s心跳/旧reason、exec codex函数、native未知 → 不能照搬生产/推直接子或native信号；正式5s/30s，正常scope结束仍可ended |
| T-04-34 (B) | 历史locator/新occupant、headless无input能力、合法focus/input请求 → 分别stale_locator/unsupported/交HostAdapter，零隐式resume，不绕输入队列 |
| T-04-35 (A9 fixture) | run heartbeat stale、Jev needs_human/本地runner退出、collect过期 → run槽不因TTL释放，browser继续持有待结果对账，collect仅06按代次接管 |
| T-04-36 (A9 prototype) | 甲supervisor SIGKILL，前台回shell/输入落shell/无receipt且PID仍活 → 交互中断/uncertain持槽，cause=supervisor_dead、interaction={focus:false,input:false,resume:false}；禁自动fg/wrapper恢复。独立父MCP退出continue仅投影parentOffline，不伪造supervisor_dead，另验TTY可用及交互能力 |
| T-04-37 (B) | shell另建harness组，提交后发现前/写scope前崩溃与随后同实例核验成功 → 未知scope禁信号/R/Q，不重发；成功仅NULL→真实scope一次，SQL拒后改 |
| T-04-38 (B) | 合成空闲run多个心跳与退出/取消事件 → 每间隔一次runs UPDATE，零周期event/evidence/meta/组扫描；阻塞CPU与真实I/O计量归06，启动有截止采样不变常驻200ms扫描 |
| T-04-39 (B) | hud-mcp启动/重连发现遗留receipt或无receipt旧run、wait必要截止、相关事件/显式reconcile、无写者历史 → 有预算幂等导入/按02采Q或列缺证，无新执行权；status只读/通知合并，历史不养常驻observer |
| T-04-40 (A9 fixture) | shell包装改变实际cwd、resume时CLI所在目录变化、路径事后消失 → 启动输入/meta仍取该run冻结launch_cwd/origin；新观察有来源且不改ledger历史，不在事务/热路径跑Git |
| T-04-41 (A9 fixture) | HUD R/重复复制/不可信report字符串、本地resume缺request-key/expected-run/mode、旧父context离线 → 仅安全固定目标复制；缺参拒绝，合法local_user经原writer typed重验，零伪造父工具结果/自动恢复动作；未绑定 parent/child 的固定 run 仍可经真实 UID/私有 ledger 所有权核验 cancel/reconcile；伪造 MCP admin/actor、错误 UID/ledger 拒绝；固定旧 run 不影响新 run，重复 cancel 不重置宽限、重复 reconcile 不产生执行权或 force-release。trusted_local 审计含实际 UID/invocationId/runId/目标绑定代次，不伪造 representedOwner/父 CallerId/context/tool_result，原 local_user resume actor 不变（consult 4 增补，F05） |
| T-04-42 (A9 prototype) | armed/claim/首H/完整stamp事件登记commit后、meta前SIGKILL → 无meta仍按事件恢复确切实例，未重领票据/启动；缺stamp的历史行、同pid/start而boot/PID域不同 → unknown/持槽，不回填当前域、不判断旧实例已死 |
| T-04-43 (A9 fixture) | 既有supervisor.registered事件承载完整ProcessStamp，无meta恢复；缺事件/四字段缺任一/源或代次错/冲突记录 → unknown；跨域同pid/start不能续H/授控制，返回stamp副本不改历史 |
