# 01：调用者登记与绑定凭据

- 版本：`v0.4 draft`（2026-11-01；Oracle C01–C14、D01–D13 修订）。
- 状态：A1 第一批草案；不是阶段 B 的冻结基线。A9 需同时审查不变量、失败案例、测试结果与探针原始证据。
- depends-on：[概念方案 v2.3](../universal-hud-concept.md) §4、§6.6、§6.7、§15–16；[工程计划 v1.1](../universal-hud-engineering-plan.md) §3–4、§6；[第三轮评审](../reviews/2026-11-01-chatgpt-pro-v22-plan.md) §3①②；[02 执行协议](./02-execution.md) 的事务与 schema。
- 证据快照：A3 五份探针已评审；[Oracle 裁决](../reviews/2026-11-01-astra-contracts.md) §3 批准版本受限的组合身份路径，不把字段存在单独当作授权。A9 尚未放行。

[A3 Codex](../probes/codex-mcp-launch.md)：CLI 0.166.0、daemon absent 下 TUI/exec 各自直接启动 stdio MCP；配置 env 可达，普通 shell HUD_* 不继承。有界 spoof 已完成：伪造值只进 `params.arguments`，真正 `params._meta` 仍匹配 rollout；不外推未来版本/传输。[双 home](../probes/codex-dual-home.md)要求 source 隔离；[cc 2.1.305](../probes/cc-mcp-env.md)证实环境与 sessions pid/procStart 匹配、metadata 无 session；[Herdr 0.9.5](../probes/herdr-env.md)仅覆盖 Codex tab-root/pi split；[pi 1.4.0](../probes/pi-resume.md)的 --session 续文件、--fork 新 ID，不等于完整 resume 能力已验收。

[daemon 补测](../probes/codex-daemon.md)仅覆盖 CLI 0.166 / managed app-server 0.163 在场时的默认 direct-stdio 启动；未证明共享连接，脚本 exit=2、后续授权清理不能算整项 pass。daemon-present 正向不是 A9 前置。可见模式依 [04](./04-supervision.md) 选择修订甲：[A8](../probes/hud-run-visible.md)首轮被拒；A8-fixB2 的同 agent/session 状态、实际 context 命令及父 launcher 退出后的 TTY 输入/收尾关键证据已于 `8fdf4cf` 接受。接受范围仅为所测版本与 hud-run 为 pane 前台作业的形态；完整生产取消/复用/故障矩阵仍归 B。


本文中的“必须”是待实现、待验证的协议要求，不是已经通过的运行保证。只使用合成身份举例。账本唯一写者家族为 `hud-mcp`、`hud-run`、reconciler；初始登记、意图和证据可以由前两者写入，身份回填、generation 失效和关系状态迁移统一经 reconciler 的事务入口。HUD 只读账本并投影，不替它们执行绑定。

[Oracle consult 2](../reviews/2026-11-01-astra-consult2.md) D01–D13 补齐字段、控制主体与读取边界；本轮仍是 A4/A9 候选契约，不代表 A9 放行或 B 生产能力已验证。

冻结后生效版本：`A9 + consult4-2026-11-01`。下文标记的增补以 [Oracle consult 4](../reviews/2026-11-01-astra-consult4.md) 为准，保留此前 C/D/E 与 A9-fix 裁决；不改 ledger schema v1，也不追认未验收的生产能力。（consult 4 增补，F01）（consult 4 增补，F04）（consult 4 增补，F05）（consult 4 增补，F07）（consult 4 增补，F09）（consult 4 增补，F11）

（F08 Pro 裁决增补）依 [F08 Pro 裁决](../reviews/2026-11-01-chatgpt-pro-f08-hook-budget.md) §4 补齐下文 Oracle consult 4 Q4/F06 的 resolver 正文；F07 与 I-01-2/10/12 保持原义。该档案的成本门槛改依 06 P-06-4/5 与 05 能力证据，不由预算修订追认身份或生产能力已验证。

## 数据模型

### 身份、实例与定位

| 对象 | 字段与判等 | 不作为身份证明的字段 |
|---|---|---|
| `SourceId` | 固定顺序 JSON 数组 `[harness, realpath(配置/存储根)]` 的 UTF-8 SHA-256 小写十六进制；`sources` 同时保存 harness、绝对根路径和显示 label。根无法解析时拒绝建立授权身份 | cwd、账号显示名、相对路径 |
| `SessionRef` | `(harness, source_id, session_id, thread_id?)`；SQL 编码为 `json_array(harness, source_id, session_id, nullif(thread_id, ''))`。cc 根 `thread_id=''`，原生子为 `agentId`；Codex 每个线程使用自己的 `session_id` | transcript 路径、pane、PID、tmux session 名 |
| `ProcessKey` | 专属 stdio 的 harness `(harness, source_id, pid_domain, harness_pid, harness_proc_start)` 固定顺序 JSON 数组；pid_domain 必含机器 boot_id 与 PID namespace 身份，与 04 ProcessStamp 对齐；harness_pid 是经核验启动链上的真实 harness。不能取共享 daemon 冒充 TUI | 仅 PID、进程名字、继承的 pane env |
| `CallerId` | 每个物理 MCP 实例新生成的 opaque id；仅记录 MCP 的 pid/proc_start、实际父进程 ppid/parent_proc_start、harness/source 提示、登记瞬间物理 MCP 自己的真实绝对 cwd、env_pane、时间。cwd 无法取得时拒绝登记并返回 cwd_unavailable，不填 HUD_HOME、父进程目录或空字符串。共享实例仍只有一个 CallerId，实际父进程可以是 daemon（consult 4 增补，F04） | CallerId、物理父进程及提示字段本身不授予会话身份 |
| `caller_contexts` | 物理 CallerId 下的隔离调用上下文，`(context_id,generation)` 保留历史，含 context_key、kind、SessionRef、证据与关闭时刻。MVP dedicated 恰好一个当前 stdio context，连接到 ProcessKey/proc_generation；shared 仅保留类型/表的扩展位置，MVP 不建立可操作 shared context | claim、prompt、自报 session 参数不能选择或创建 shared context |
| `caller_scopes` | 专属 stdio 的 `(process_key, generation)`；同一 ProcessKey 只有一行未关闭。保存本代已证实 ref/证据；dedicated context 的 generation=proc_generation，MCP 重启复用尚未关闭的同一代。shared context 不使用此表或 proc alias | 新 MCP PID 不能触发专属会话换代 |
| `RunBinding` | 某次运行的会话、启动实例与宿主 occupant；在 schema 中由 `runs`、`child_bindings` 和 evidence 组合表示。Herdr locator 带 server/workspace/tab/pane，tmux locator 带 server 实例/session/pane | HUD 自己的 pane 不是被观察 pane |
| `OwnerKey` | 从本次调用选定的当前 context 派生：已证实会话为 `json_array('session', session_ref)`；仅未绑定 dedicated 可用 `json_array('proc', process_key, generation)`。shared 不取得 MVP 操作权限。已绑定 SessionRef 跨 MCP 重启和同会话 resume 保持逻辑所有者 | 不把 caller_id/context_id 放进幂等键，不另建可随意赋值的所有者身份 |

（consult 4 增补，F04）`callers.cwd` 仅是物理 MCP 的诊断提示，不是 harness/session 的工作目录、SourceId 或调用权限证据；A4 `Caller.cwd:string` 和 02 的 `callers.cwd TEXT NOT NULL` 保持不变。会话 SessionEvidence/WorkspaceContext 的 cwd 无证据时仍为 null，不得用 callers.cwd 自动补空。06 禁止填 HUD 自己 cwd 的约束针对会话 workspace。

工作位置按 [06「WorkspaceContext 与项目归属」](./06-observation.md#workspacecontext-与项目归属)定义：`cwd`、`worktreeRoot`、显示名 `worktree`、本机 `repoId` 与显式 `projectOrigin` 均不授予身份。repoId 不参与 SourceId/SessionRef/OwnerKey 判等；同仓库的两个 harness home 仍是不同 source。cwd 未知为 null，不能填 HUD 目录；同名、父子关系、相同 remote 或普通目录副本均不能证明同项目/同工作树。外部消费者必须按 harness + 规范存储根重建 SourceId，以完整 SessionRef join；Claude agentId 进入 threadId，缺 source 不能猜 home。

`caller_contexts.generation` 是调用上下文的代次；`RunBinding.binding_generation` 是目标会话本轮运行绑定的代次，分别校验。首次运行先以 provisional 目标分配 binding_generation；resume / predecessor 根据已有会话最后代次递增，与意图同事务。`child_bindings` 记录物理 caller、context/generation 和目标绑定代次的关联。MCP/模型传来的 generation 只是请求值，不能覆盖可信来源或当前账本值。

专属 context_key 固定 stdio。物理连接不等于唯一逻辑来源：原生 subagent、同进程换会话也可能复用 MCP。每次调用先验证当前逻辑来源，再选择 context；缺失、冲突、原生子来源不可辨时返回 identity_source_missing/identity_unverified，不沿用上次 root，不回退 proc OwnerKey，不查幂等或执行工具。cc 的根 env/sessions 文件单独不足以区分原生子；支持档案须提供经验证的根调用隔离，或把本次可信 toolUseId 精确关联到当前根公开调用记录；关联缺失/落入子 agentId 即拒绝根授权。此拒绝规则也覆盖持有根 claim 的子调用。

（consult 4 增补，F07）原生子调用只拒绝本调用，不建立或选择 root context，不兑换根 claim，不关闭根 scope/context/alias，不触发根 generation 变化；根后续调用仍须逐次验证。原生子与可信根来源变化必须能区分，否则拒绝授权。选定本调用来源所依据的 scope generation、证据版本、context 及目标 run/binding 前提，在查询幂等或写入时仍须匹配；过时前提返回 stale_context/identity_unverified，不能重贴新代次。

（consult 4 增补，F07）只有可信根来源变化才由同一 reconciler 事务关闭旧 scope/context/alias、撤销旧授权并 generation+1；PID/start/boot 改变则建新 ProcessKey。MCP 重启或同源同根两个 MCP 的 CallerId/context 可以不同，但逻辑 OwnerKey 与未关闭 process generation 相同，必须经 B2 共享事务连接/重建，不能各自建立“当前根”或重复兑换。并发首次建代 CAS 失败可拒绝并要求重新取证的新调用，不凭旧证据盲重试。B1 的 currentRef/invalidated 仅是实例内诊断，不是跨实例代次权威，也不能让合法 /clear 后的新根永久不可用。MCP 重启仍须证明同一真实 harness、当前 SessionRef 与未关闭代次；不能只靠进程 ancestry/env 声称调用来自根。

（consult 4 增补，F07）以下规则由 B2/B5 落实事务，B4 接受/票据流程沿用 02；外部取证在写事务外，锁内只重验已捕获前提，不搬入文件或 /proc I/O：

| 情形 | 必须行为（consult 4 增补，F07） |
|---|---|
| Claude 根/原生子共享一个 MCP | 按本次合格 hook 的原生 agent 来源区分；子携根 sessionId、transcript_path、env/claim 仍非根。无版本保证、字段矛盾或 agent_id 未读到均不能推定根，拒绝仅影响本调用。（consult 4 增补，F07） |
| Claude /clear 保持 PID/start/MCP | 新根的合格 hook 与当前 sessions 记录匹配后，以捕获的旧代次为 CAS 前提换代；已进入的旧 spawn/report 提交失败，过时 receipt 不得倒切旧会话。缺当前 registry 或矛盾即拒绝，不轮询等待。（consult 4 增补，F07） |
| 同源同根两个 MCP / MCP 重启 | 共享 B2 的 scope/current-context 事务，同 OwnerKey/未关闭 process generation；CallerId 不同不另建根，不重复兑换，CAS 失败要求新调用。（consult 4 增补，F07） |
| 新旧会话 MCP 同时绑定 | 新会话换代已提交后，旧实例所选上下文/旧记录不可复活；物理 MCP 较晚启动不构成换代。合法旧代已 durable accepted 的操作保留原意图，按原票据登记/提交重验，不抹掉接受事实或起副本。（consult 4 增补，F07） |
| Codex 原生子另起 MCP | 0.166.0 子调用 sessionId 仍为 root，而 threadId/turn.thread_id 指向 child，存在 parent_thread_id/subagent 来源时必须拒绝；单独 MCP 或相同 harness PID 不例外。不得用 rootThreadOf 视图投影授权，根后续调用仍可逐次核验。（consult 4 增补，F07） |

（consult 4 增补，F07）Codex 根正向路径继续要求 genuine metadata 各字段一致、root thread/source 条件、精确 rollout header、实际 source/进程实例及受支持版本；不外推任意版本、daemon/shared 或每线程正向调度。

### OwnerKey / 授权边界：本地管理 resume

控制发起类型为 `ControlInitiator = {kind:'mcp',callerId,contextId,contextGeneration} | {kind:'local_user',uid,invocationId,representedOwner:OwnerKey}`。MCP 沿用上述逐调用当前来源门禁。窄例外仅是同一 OS 用户对其私有 HUD_HOME/ledger 显式执行本地管理 resume：入口核验当前 UID、目录/账本所有权及私有路径，代表该 link 已登记的现有逻辑 owner，不转移关系所有权。representedOwner 只能从已证实的 `parent_ref` 派生，不能从参数自报 OwnerKey、历史父 context 或进程 ancestry 冒充当前父调用。

意图事务的 accepted 事件保存 `actor.kind=mcp|local_user`；local_user 记录 UID、本地 invocation ID 和被代表的 OwnerKey，供执行票据登记/提交时按该类型重验。CLI 的 `launch_call_id` 标为本地调用（如 `local:<invocationId>`），不存在父 MCP tool_result，不能走下表父 transcript 工具结果核验来伪造它；独立启动/子握手证据仍全部适用。父 ref 未确认、跨 owner predecessor、local report、未定义的 local spawn 不在例外内。MCP 参数 `admin` 不能进入 local_user 分支；UID/CLI 来源不是人类证明，同 UID 脚本不由此协议隔离。

CLI 必须带 `--request-key`、`--expected-run`、`--mode`，顺序/幂等归02，全部 resume 门禁归03，受信管理入口归04。读取能力注明主体：MCP status 按父 owner，本地 HUD 按 local_user；两者共用门禁函数，`resumable`/`allowedActions` 仅提示，不能当授权凭据（T-01-38、39）。


（consult 4 增补，F05）本地 cancel/reconcile 使用 [04「取消与父断连」「写者与RunHandle」](./04-supervision.md#取消与父断连) 的独立 LocalManager/authorizeManager 门禁；实际 UID、私有 HUD_HOME/ledger 及所有权由本地入口和真实 writer 校验。它针对固定 runId，未绑定 run 也可管理，不要求已确认 parent_ref，不代表 OwnerKey、不转移 parent/child/owner，不授 spawn/resume/report/predecessor 权限。authorizeControl 的 local_user 仍仅允许上述 resume；两入口可共用 OS/私有路径核验，不能把 cancel/reconcile 加进 resume 分支或让 MCP 参数选择管理主体。

### claim 与证据

`claims` 每个 run 一行：随机至少 256 bit 的 claim 经本轮启动配置/env 运输；仅运输 fallback 才在本轮消息中传入；账本只存 SHA-256 `claim_hash`。`issued_at` 起 TTL 为 30 分钟，`now >= expires_at` 拒绝首次兑换。它绑定 `run_id`、预期 source、`expected_generation`（目标绑定代次）、启动实例的完整 `ProcessStamp={pid,proc_start,boot_id,pid_domain}`（04），以及本轮 `launch_call_id / launch_correlation_id`；原生 `launch_message_id` 可为空并在精确证据到达后后填。启动实例尚未登记时为 `issued`，不能兑换；hud-run 取得 02 的执行权并登记实例后才变为 `armed`，再交给子进程。登记、arm claim、首心跳与不可变 `supervisor.registered` 事件同事务；完整 stamp 由该事件的白名单 payload 持久保存，runs/claims 的 pid/start 仅为一致性校验投影。恢复及 claim 核验以该事件为权威，缺失/不完整/矛盾保持 unknown，不能从当前 boot/PID 域或较晚 meta 补历史实例（04 T-04-42、43）。

兑换主体是 `(caller_context, context_generation, child SessionRef 如已知, run_id, binding_generation)`，不是 MCP PID；claims 保存声明时的 context 外键。重启后的新专属 context 必须证实同一 ProcessKey/代次、当前逻辑来源与 SessionRef，再由 reconciler 重建授权并保留旧声明事件，不能凭新 context_id 再兑一次。`redeemed` 只表示凭据已被一个主体声明；fork 声明不授予 report 或父权限。重复 whoami 先检查当前绑定：同一逻辑主体、同 run 同代且未撤销时幂等返回，即使后来 TTL 已过也不再次兑换；未绑定的过期声明不能继续升级。不同主体普通兑换返回 claim_conflict；仅独立证据接管事务可替换未绑定声明。

`evidence` 保存白名单元数据、原始证据指纹和观测时间，不保存 claim 明文、密钥、完整 prompt 或私有块。启动回执必须指向本轮 hud-run 启动的确切 harness 进程 pid + procStart，并证明其位于 caller 的经核验 ppid 链上；宽泛的共同祖先或仅进程名不够。可信会话证据还必须唯一指向本次调用/运行的 SessionRef，不能以共享进程的祖先关系区分其多个逻辑会话。

（consult 4 增补，F09）evidence 及任何可序列化/持久化的观测产物都不保存未完成记录的原始字节，包括嵌套 binary/base64、日志、临时 bundle、token/parser state。raw tail 只在单个 live reader 的有界易失缓冲中存在；持久 offset、摘要/去重/工具配对/时钟以最后完整记录边界为准，pendingBytes 兼容字段恒为 []，超大行仅存可推进的丢弃元数据。完整要求及旧缓存处置见 06 Reader/ObservationCommit 与 07 checkpoint 版本策略。

### SessionRef resolver 的证据边界

| harness / 来源 | 可接受的独立绑定证据 | 不足时的结果 |
|---|---|---|
| cc | 显式且经验证的 `claude_pre_tool_use_v1` 档案，按下节精确关联本次同步 hook 记录；sessions/<harness_pid>.json 的 pid/procStart/PID 域、当前根 ref 与真实实例/source 相符，原生 agent 来源可辨（F08 Pro 裁决增补） | Claude 2.1.305 默认 direct stdio/public-transcript 路径无操作授权；仅根 env/session 文件不够，不可见 PID 域 unknown，来源不可辨即拒绝（F08 Pro 裁决增补） |
| Codex | 下文版本受限的直接 stdio：per-launch config env + 真实启动实例/source + 本次 params._meta 与精确 rollout header 一致；注册表/精确回执为有条件 fallback，resume 必须仍是既有 child_ref | metadata 冲突/缺失、原生子不可辨、daemon 时间配对、cwd/最新文件均不得沿用 root 授权 |
| pi | 从已核验的 harness 进程 cmdline 解析精确 `--session` / `--session-id`，读取该 source 的 header 核对 id；目录参数只界定候选范围 | 只有 --session-dir、--role、--orchestrator 不产生唯一会话 |
| transcript | 只作下文限定核验；绑定必须已有独立启动/会话证据 | copied linkId、claim 或历史 prompt 不构成独立证据 |

### Claude 同步 PreToolUse 来源档案（F06）

（F08 Pro 裁决增补）唯一新增取证路径为显式 `callSource:{kind:'claude_pre_tool_use_v1'}`（仅 Claude 合法），不增加通用身份插件框架。Claude 2.1.305 默认 direct stdio/public-transcript 路径仍缺已验证的执行前根调用识别能力，保持无操作授权；显式选择仅选机制，须按 05 对具体 Claude 版本、helper 修订和完整档案指纹验收。受信同步 PreToolUse 输入须提供精确 `tool_use_id`、`session_id` 及可区分的原生 agent 来源；MCP 用本次真正的 `params._meta["claudecode/toolUseId"]`、精确配置服务器名/完整工具名、真实 ProcessKey/source 与当前 scope 前提交叉核验。缺失、歧义、冲突、旧代或不支持版本均先拒绝，不查询幂等结果、不消费 claim、不执行工具。

1. （F08 Pro 裁决增补）安装与范围：由启动档案/B11 `hud claude` 经本轮 CLI `--settings` 注入同步 command hook，仅匹配精确配置 MCP 服务器下的七个 HUD 工具：`delegate_spawn/resume/wait/status/cancel/whoami/report`。不全局安装，不覆盖用户其他 hooks/MCP 配置，不对 Shell/Read 等其他工具运行。CLI 注入、已有 hooks 共存及真正同步执行均须验收；关闭或加载失败即没有该能力。
2. （F08 Pro 裁决增补）最少记录：只保存格式/实现版本、ledgerId/档案指纹、经核验的 ProcessKey/source、toolUseId、完整工具名、sessionId、明确根/原生子分类及 agentId、当前 scope 读取前提、证据时间/指纹。不原样落盘 hook stdin，tool_input、claim、prompt、transcript 正文不入记录；transcript_path 至多限定核验，不能判根，因为子调用也可能给根路径。
3. （F08 Pro 裁决增补）来源与代次：helper 实际启动链必须匹配同一已核验 harness 实例；固定配置/继承 env 只定位本轮记录空间，不独立证明调用者。发布前由 B2 只读入口取得该 ProcessKey 的当前 scope generation/ref，或明确的“尚无当前 scope”比较前提并绑定进记录；MCP 不能给旧记录重贴新 generation。A→B→A 后相同 SessionRef 也不是同代调用。hook 只有索引读取权，不写运行意图、claim 或绑定；查询幂等/提交仍按 F07 锁内重验捕获前提。
4. （F08 Pro 裁决增补）有界原子发布：私有目录/0600 文件、精确键、不可覆盖的完整发布，每条≤8 KiB；键至少隔离 ledgerId、ProcessKey、配置服务器、toolUseId，字段再核对档案/工具。不存在、半写、重复发布冲突、错 source/实例均拒绝，不取 last-wins。MCP 仅精确有界读取；清理依托现有调用/退出路径的限额工作，无目录轮询器/常驻服务，未产生 tools/call 的孤儿记录不触发工作。
5. （F08 Pro 裁决增补）证明边界：合格记录只证明该 harness 在本次精确 HUD 工具执行前报告的逻辑根/原生子来源，结合真实启动/source 核验后才进入已有 context 选择。不证明 link 所有权、run 身份、claim 有效性、report 权限或运行结束；01–04 后续门禁全部保留，原生子仍按 F07 只拒自身。

（F08 Pro 裁决增补）记录缺失时 MCP 独立拒绝，不能假设 hook 非零退出必使 harness 阻止 tools/call。迟到记录不自动重放被拒工作；重试须新的、重新取证的工具调用，同一控制意图保留原 request_key。B1 的 resolver 使用既有 CurrentCallSourcePort，B2 提供 scope 只读快照/事务围栏，B4/B11 仅负责启动注入与档案选择，B5 接授权；不新增 ledger DDL。B1/B5/B14 在 T-01-33/35/36 的生产重验中覆盖上述缺失/迟到/半写/重复、错版本/source/boot/start/server/tool、ABA、/clear 与双 MCP 反例，不追认 A9 已执行新增断言。

现有实现依据：[daemon-binding.ts](../../src/collectors/daemon-binding.ts) 的 `findConnection` 用启动时间/排序配对，读失败可能保留旧 thread；[session-finder.ts](../../src/collectors/session-finder.ts) 的 `rootThreadOf` 是 HUD 根视图策略，不用于把实际 caller 子线程授权成根。shell snapshot 的 `TMUX_PANE` 可能来自 daemon；`findFallbackSession` 会选最新 cwd rollout，不执行授权所需的唯一性判断。[Herdr 观察桥](../../bin/codex-hud-herdr.mjs) 的 `readNativePane` 只返回状态，没有验证 `agent_session.value`；[环境修复说明](../herdr-context-fix.md) 证明命令环境的运输边界，不证明 MCP 的会话归属。B1 必须在复用这些观察结果时保留 provenance，并补独立证据；本契约不改旧观察代码。

## 不变量

表中 `DB` 指 02 的键/约束可直接检查；`TX` 指写者事务校验；`E` 指还需真实进程或探针证据。SQL 的字段存在不能证明外部事实。

| 编号 | 可检查的断言 | 层 / 对应测试 |
|---|---|---|
| I-01-1 | SessionRef 完整判等包含 source 和原生 thread；定位变化不改变逻辑身份。来源、harness、原生 agentId 不一致不得合并 | DB+TX；T-01-1、2、3 |
| I-01-2 | 每次先核验物理 caller、当前逻辑来源、context/generation 与 boot/PID 域；原生子/来源缺失不能冒充根或回退 proc。原生子只拒本调用，不消费根 claim/改变根代次；可信根切换同一事务失效旧 scope/context/alias/授权，MCP 重启/双 MCP 共用 B2 当前代次。查幂等或提交时重验捕获的 scope generation/证据版本/context/目标 run/binding，过时拒绝且不重贴代次（consult 4 增补，F07） | TX+E；T-01-4–7、35、36 |
| I-01-3 | claim 首次兑换必须未过期、未撤销且 run/source/启动实例/目标代次相符；claim 只升 claimed，同主体重复不重复消费 | DB+TX；T-01-8、9、10 |
| I-01-4 | 常规 bound 必须具备已登记 caller、有效 claim 声明、唯一实际 SessionRef、独立证据；相同祖先的多会话无法区分时不得 bound。fork 先兑换也无所有权 | TX+E；T-01-11、12、13 |
| I-01-5 | transcript 只能核验既有 ledger link/run；仅确认或否定，不能创建 link/run，不能单独提供独立身份。LinkEvidence 两种分支仅为未裁定锚点，launch_message 须用真实事件时间及精确本轮 claim 指纹/call/correlation/message 唯一匹配，缺 ref 的唯一合格匹配只由 reconciler 回填并记录 bound_by 与 evidence（consult 4 增补，F01） | TX；T-01-14、15、16 |
| I-01-6 | MCP parent 操作取本调用 OwnerKey，等于关系当前所有者才允许 resume/cancel；本地管理 resume 仅按上述 local_user 窄例外代表既有 owner，其他门禁不变。report 只能来自目标 run 当前且未失效的 MCP child binding。知识型 claim/linkId 不授予权限 | TX；T-01-17、18、19、38、39 |
| I-01-7 | 同一 child 只有一个当前 owner/父边；MVP predecessor 仅同 owner、真实 ref、空槽且无冲突；跨 owner 一律 unsupported。转交原子、旧 link 历史化，fork 只候选 | DB+TX；T-01-20–22；02 T-02-18；03 T-03-20 |
| I-01-8 | HUD 永不写 ledger；caller 注册不直接推导关系绑定；身份回填、冲突、失效/代次变更和关系迁移经 reconciler 提交并附事件 | TX；T-01-15、23 |
| I-01-9 | dedicated 仅在 bound 级证据后单向 proc→session；同代唯一。归并事务原子重键幂等记录、保留原范围审计与原 outcome；换代关闭 alias，冲突整体拒绝。正常只查当前 canonical key | DB+TX；T-01-24–26；02 T-02-4、5 |
| I-01-10 | MVP 共享/不可辨逻辑来源无可操作 context；父无操作权限，子至多无授权诊断声明，不消费 claim。prompt claim 不补足来源，daemon 在场不自动等于共享 MCP；可辨原生子只拒本调用，不建 root context、不兑根 claim、不关闭根 scope/alias 或递增根 generation，Codex 子另起 MCP 也不得投影 root（consult 4 增补，F07） | TX+E；T-01-27、28、35 |
| I-01-11 | MVP 无子 MCP 只展示已登记委派和未确认子身份；不写确定 SessionRef 父边、不准 report/resume。run 可凭独立 R/N/Q 结束，与绑定成功无关 | TX+E；T-01-29–31 |
| I-01-12 | 保留 CallerId/context 物理与逻辑分离；同 context_key 只能一代当前，专属仅一个当前 stdio context。MVP 拒绝共享调度及缺可信当前来源调用，不复用上次 context；跨 MCP 的当前 scope/context 以 B2 事务为权威，旧前提锁内重验失败不得查幂等/写入或复活旧授权，合法旧代已接受意图仍走原票据重验（consult 4 增补，F07） | DB+TX；T-01-35、36；02 T-02-27 |
| I-01-13 | resume/handover 的本轮 child 只能等于关系既有 child_ref；runHandshake 独立于 link.state。新文件/fork无连续性证据不得改旧ref，run uncertain、最多候选 | DB+TX；T-01-37；03 T-03-5、8、9 |

### owner_aliases 的建立与关闭

仅 dedicated：证据在事务外读取/核验，短事务内重验 ProcessKey/代次、唯一当前 SessionRef 与证据版本。扫描该 proc 与目标 session 的幂等键，任何同键异参或异 link/run/outcome 整体拒绝；相同原结果可合为一行。无冲突才将 proc 行的 owner_key 原子 UPDATE 到 canonical session key，origin_owner_key 与 params_version/digest/link/run/outcome/at 不变；写归并审计事件、alias、scope/context ref 与本代 link.parent_ref，一起提交。冲突回滚后独立记拒绝事件，零启动/半归并。

归并后只保留一份结果；正常调用仅查询当前 canonical key，不反查关闭 alias。alias 关闭保留历史及 origin_owner_key 审计；新代未绑定 proc 不能借用旧范围。读取/hash/外部 I/O 不占写事务，短等待/总响应预算依契约 [06](./06-observation.md)。


## 状态机

### 常规握手与失效

关系状态与 run 状态分离；下表的初次 pending/claimed/bound 不因 resume 重演为关系回退。每轮 runHandshake=pending/claimed/bound 由该 run 的 claim/binding 推导，不是 runs.state；完整关系生命周期归03，运行迁移归02。

| 起点 → 终点 | 前置条件 / 原子动作 | 对应不变量 / 测试 |
|---|---|---|
| 无 → pending | 02 已提交父 caller/context、link/run、claim 意图和槽；claim 未 armed 前不能兑换 | I-01-3；T-01-8 |
| pending → claimed | claim 全部静态字段、TTL 和已登记启动实例通过；保存首次声明主体，不凭声明写 child_ref 或父边 | I-01-3、4；T-01-9、11 |
| claimed → claimed | 当前相同声明的 whoami 重入；不同主体拒绝；有复制历史但没有独立证据的 fork 仍为候选 | I-01-3、4；T-01-10、11 |
| claimed → bound | 当前 caller/context/generation 未失效，实际会话唯一，独立证据通过；若使用 transcript 回填，还须满足下表；原子写绑定、真实槽迁移、child_ref 与当前父边。槽冲突按 02 隔离 | I-01-2、4、5、7；T-01-12、14；02 T-02-9 |
| fork claimed → 原启动主体 bound | 原启动主体持本轮 claim 且提交独立启动/会话证明；reconciler 核验 source、代次、精确启动实例，撤销旧未绑定声明，事件保留 fork 候选，再绑定原主体。不能接管一个已有有效独立证据的 bound；矛盾证据停止归属 | I-01-4；T-01-11、12、13 |
| bound → bound | MCP 重启的新 CallerId 先建立当前 context：dedicated 证实同 ProcessKey/代次与当前 SessionRef，再重建 child_binding；旧 binding 留历史，不重新消费 claim | I-01-2、3、6、12；T-01-4、10、18、35 |
| 当前授权 → 失效 | 发现会话/occupant 改变：关闭对应 context，撤销 binding/claim，context generation+1；dedicated 同步关闭旧 scope/alias、新 scope generation+1，进程实例改变则建新 ProcessKey。历史不重写 | I-01-2、9、12；T-01-5–7、26、36 |
| resume：同 link → bound；新 run starting/握手pending | 02 槽空闲/owner/同任务门禁全部满足；新 run/代次/correlation/claim，撤销旧 claim/binding；MVP 仅 bound/reported resume，新握手必须匹配既有 child_ref，handover 同样约束 | I-01-2、3、6、13；T-01-7、19、37 |

### transcript 核验的封闭范围

（consult 4 增补，F01）`LinkEvidence = ToolResultLinkEvidence | LaunchMessageLinkEvidence` 是公开记录抽取的未裁定锚点，不是绑定许可。tool_result 保持原生调用身份和原字段/语义；launch_message 保持原生消息身份，必有 `kind,ref,nativeMessageId,linkId,claimFingerprint,eventAt`，其中 kind=launch_message，指纹为原 claim 字节的 SHA-256/64 位小写十六进制，eventAt 是原记录有效事件时间。`launchCallId/launchCorrelationId` 仅在该记录确实提供时填写；不为旧接口伪造 runId、tool 或 callId，不保留 claim 明文、整条启动消息或完整 prompt。缺可核验事件时间不产生合格 launch_message，可留无授权候选/缺失原因，不能用 observed-time 补签发窗。

（consult 4 增补，F01）启动消息核验必须唯一对应已有 link/run 的本轮 claim 指纹、launch_call_id、launch_correlation_id 和精确原生消息，并满足下表原事件时间窗、完整 SessionRef/source 与独立启动/会话证据；首条消息、历史复制或发现时间都不能推定本轮。

| 项 | 必须同时满足的条件（I-01-5；T-01-14–16） |
|---|---|
| 父侧 | 本次 delegate_spawn/delegate_resume 的 tool_result 中的 linkId、runId；与账本记录的工具调用 ID 一致。父 transcript 的 harness/source 与 caller 相符 |
| 子侧 | delegate_whoami 的工具结果，或本轮启动消息的 linkId + claim 指纹；锚定本轮 launch_call_id、launch_correlation_id 与精确原生 message/call ID（允许晚到；核验此路径时须齐备），resume 不扫描会话“首条消息”替代本轮消息 |
| 时间 | 以账本 issued_at 为基准，记录事件时间在 `[issued_at-5000, issued_at+600000]` 毫秒闭区间；发现时间可以更晚，但不能拿 mtime/扫描时间替代事件时间。claim 首次兑换 TTL 另行校验 |
| 匹配 | harness/source 一致、SessionRef 唯一；多份复制 transcript 为 conflict，停止归属，不取最新。不加载候选正文来扩大核验范围 |
| 写入 | 已有 link/run、独立证据通过才可回填缺 ref 并标 bound_by=transcript；已有 ref 被否定则保留历史、撤销当前授权并标冲突，绝不静默改父 |

（consult 4 增补，F01）B4 定义并冻结本轮 fallback 消息运输格式与 correlation，正常 env 路径不重复传明文 claim；B8 只抽取共享 linkEvidence，B9 只做既有关系的限定核验及候选/冲突投影。身份回填或撤权由 B2/B5 的 reconciler 事务提交，HUD/B9 读取不成为新写者；readerVersion 变化按 07 失效旧锚点缓存，缺 eventAt 的旧锚点不能强转为合格分支。

（consult 4 增补，F11）06 的 append-only 假设与有界签名检查不证明任意历史未变；“未发现改写”不授予 MCP 调用权限，reset 后旧 reader 锚点/摘要不作新谱系当前证据，仍须本节精确本轮核验及独立身份条件。

启动实例或调用 ID 缺失、时间不可验证、非公开块、任意 shell/herdr/jev 命令、标签、HUD_LINK 或 pi orchestrator 的共现均不能扩展此表。当前来源失联只将证据标 stale/unknown；它不证明 session 已退出，不释放 02 的槽。

### Codex 主路径与 fallback（版本受限）

主路径限于 A3/Oracle 接受的 CLI 0.166.0 直接 stdio 档案与所测 TUI/exec 模式。服务器名取启动档案；每轮构造 argv/TOML 值，用 `-c mcp_servers.<name>.env.HUD_CLAIM=...` 及同级 HUD_RUN、HUD_LINK、HUD_HOME 叶子覆盖。保留用户 command/args、其他 env 和其他 MCP 服务器，禁止把探针的 `mcp_servers={}` 或整表覆盖搬入产品。HUD_HOME 明确到达 MCP；Codex source 从档案和经核验 harness 的实际配置/存储根确定，不从 MCP 缺失的 CODEX_HOME 猜。resume 重新注入本轮新 claim；叶子保留/引用与 resume 模板仍需相应 gate 证据。

启动时可登记/保存 claim；initialize 没有 session，tools/list 不足。首次合格 `tools/call` 的 `params._meta.sessionId` 与 `params._meta["x-codex-turn-metadata"].session_id` 等会话字段须一致，并与实际 source 中精确 rollout header、真实启动实例及已有 child_ref 交叉核验；后续逐调用检查当前性。原生子线程不得投影成 root 授权。`params.arguments._meta`、参数 sessionId、prompt、仅有 metadata 字段都不能替代这个组合。HUD 自生成 launch_correlation_id；原生 message ID 晚到可 NULL 后填。正常配置 env 路径不要求 prompt 明文 claim 或 transcript 正文扫描。

| 路径 | 明确规则 |
|---|---|
| 主路径 | 经验证直接 stdio；每轮配置 env 注入 + 独立启动/source/逐调用会话一致性。范围写版本、档案和模式，不写所有 Codex |
| 运输 fallback | 配置 env 无法使用但 hud-mcp 确实存在时，本轮启动/续跑消息传 claim，子显式 whoami；独立身份门槛不变，不重启已提交任务 |
| 身份 fallback | 精确且当前的会话注册记录/启动回执或限定 transcript 交叉核验，必须把进程映射到唯一 SessionRef；cwd、最新文件、daemon 时间配对只候选 |
| unsupported | 无法区分逻辑调用来源的共享 MCP；无法观察同进程切换；source/home 不明；未经验证的 daemon 代启；MVP 无 MCP 正向绑定。prompt claim 不能救活这些分支 |

### Deferred（v1.1 / 后续能力）

无 MCP 的 `observe_only` 三证正向绑定延期 v1.1；未来最低门槛仍是精确启动回执、唯一可信进程→SessionRef、限定本轮消息核验三者齐备。MVP 即使三证齐全也拒绝正向绑定/报告/猜测 resume，保持未确认展示；后来加载 MCP 必须正常握手。共享 MCP 正向多 context 调度在新能力立项时再定，MVP 拒绝，保留 context 类型而不实现其正向状态机。


### 四条身份路径及待验证分支

| 路径 / 探针问题 | 证据成立分支 | 不成立分支 / 明确不支持 | 测试 |
|---|---|---|---|
| fork：复制历史/claim 是否可抢先占位 | fork 只到 claimed；原启动主体凭独立证据接管。确证是新 SessionRef 仍不建 v1 link | fork 与原主体共享进程且缺可信逐调用 session，不能仅凭 ppid 链区分，保持未绑定 | T-01-11–13 |
| resume：本轮消息与新旧代次 | 新 run/claim、旧凭据撤销；通过当前来源把已有 SessionRef 绑定到新运行 | 活跃/uncertain 槽先拒绝；旧 prompt、旧 whoami、旧 run 报告不授权新 run | T-01-7、19 |
| 同 pane 换 session / 同进程 /clear | 发现变化先 generation+1 并关闭 alias，历史关系保留；显式可信当前 session 必须覆盖旧缓存 | 无法观察同进程切换且无逐调用证据的路径不用于授权，返回 identity_unverified | T-01-5、6、26 |
| Codex MCP 启动者及基数（A3 已评审） | 直接 stdio 按上述配置 env + 当前 params._meta/启动/source 组合核验；两独立 TUI 不证明单连接只有一个逻辑来源 | 共享正向延期；不可辨原生子/缺来源不授权，不把 daemon PID 当 TUI；daemon-present 不为 A9 必测 | T-01-27、28、35、36 |
| Herdr --env 三跳（A3 有界结论） | 所测组合分跳核验；Codex 用配置 env 注入，不依赖 shell 继承 | 任一跳缺失则用本轮消息的参数 claim；仍需独立证据，不能因 CLI 返回成功标支持 | T-01-32 |
| cc MCP env（A3 已评审） | HUD_CLAIM 到达则自动调用相同校验路径 | 不到达则显式 claim 参数；pid/procStart/PID 域证明不减免 | T-01-33 |
| pi --session（A3 已评审；完整能力 C） | 续文件保持 ref；新文件仅有可信 resume 因果映射时归同一 ref，路径更换不改逻辑身份 | 新 header 指向另一个无连续性证据的 id 时只作候选，pi resume 标未验证/unsupported | T-01-34 |

## 失败案例

| 编号 | 合成失败场景 / 必须观察到的结果 | 不变量 | 测试 |
|---|---|---|---|
| F-01-1 | 相同 cwd、session_id，但两个 source 或不同 cc agentId；不合并 | I-01-1 | T-01-1、2 |
| F-01-2 | PID 重用、pane 换 occupant、同进程换会话；旧授权先失效，历史不迁到新人 | I-01-2、9 | T-01-5、6、26 |
| F-01-3 | claim 晚到、过期、错 run/source/实例/代次；拒绝，不写 bound | I-01-3 | T-01-8、9 |
| F-01-4 | fork 先兑换或复制同一祖先链；无独立会话证据不得 bound；原主体可证据接管 | I-01-4 | T-01-11–13 |
| F-01-5 | transcript 多匹配、超窗、旧 resume prompt、单独 linkId 共现；不建关系，冲突不选最近 | I-01-5 | T-01-14–16、19 |
| F-01-6 | 非 owner 取消/resume、非子 report、旧 run 迟报；拒绝授权，报告不满足新运行 | I-01-6 | T-01-17–19 |
| F-01-7 | 转交槽非空、跨 owner、回环或双父；拒绝且历史保留 | I-01-7 | T-01-20–22；03 T-03-20 |
| F-01-8 | claim 建 alias、同代映射两 session、同键异参归并；拒绝归并并事件化，不启动 | I-01-8、9 | T-01-23–26 |
| F-01-9 | 共享 daemon、env 缺失、继承 stale pane 被当作 session；父无登记，子无授权 | I-01-10、2 | T-01-27、28、32、33 |
| F-01-10 | 无 MCP，即使有三证或 fork 复制消息仍未确认；独立 run 终结不产生父边 | I-01-11 | T-01-29–31 |
| F-01-11 | pi resume 新文件或fork没有可信连续性；不把新 id 猜成旧 ref，不改已知关系 | I-01-1、2、13 | T-01-34、37 |
| F-01-12 | 同一连接出现原生子、缺可信来源或 prompt 声称 root → 拒绝，不沿用连接上次身份 | I-01-2、10、12 | T-01-35、36 |

## 测试清单

每项标 A9 fixture（规格/合成输入）、A9 prototype（临时 source/SQLite + 最小合成进程）或 B（生产验收）、C（后续）。A9 原型不是 B 实现；B1/B2/B5/B14 在实现后重验关键反例。这里只列待验断言，不宣称已执行；合成数据，不读用户状态。consult 4 新增断言由对应 B 工作包定向生产重验，不追认原 A9 原型已经验证新增档案/事务。（consult 4 增补，F01）（consult 4 增补，F04）（consult 4 增补，F07）

| 编号 | 输入 → 预期状态断言 |
|---|---|
| T-01-1 (A9 fixture) | 同 cwd，两个 realpath source，session_id 都是 synthetic-s → 两个不同 SessionRef/OwnerKey；symlink 指同根则同 SourceId |
| T-01-2 (A9 fixture) | cc root 与 agent-a/agent-b 共 session_id → 三个 ref；三个 SQL 唯一键均可存在，精确重复被拒 |
| T-01-3 (B) | ref 不变，仅改 transcript 路径/Herdr workspace locator → ref 不变；旧 occupant 跳转校验失败时无宿主状态，不改父边 |
| T-01-4 (A9 prototype) | 专属 harness 存活、MCP 重启 → CallerId/context 改变，boot/ProcessKey/当前 SessionRef/代次及 OwnerKey 连续；02 T-02-3 命中原记录；B2/B5 补同源同根双 MCP 并发首绑/重绑，共用未关闭代次、无重复兑换，CAS 失败要求新调用而非凭旧证据盲重试（consult 4 增补，F07） |
| T-01-5 (A9 prototype) | 同 pane 同 PID 先 session-a 后 /clear 到 b，procStart 不变 → a 代关闭、generation+1、旧 report/resume 授权拒绝；a link 仍指 a；合格新根来源须匹配当前 sessions 并以捕获旧代次 CAS，同 PID/start/MCP 下旧 spawn/report 取证后等锁遇换代提交失败，过时 receipt 不倒切，合法新根仍可用（consult 4 增补，F07） |
| T-01-6 (A9 fixture) | pane 被替换或同数值 PID 不同 procStart；另给不可见 PID 域 → 新 ProcessKey/occupant，不复用旧授权；不可见域只标 unknown；另 MCP 真实绝对 cwd 登记成功，但会话 cwd 无证据仍 null；process.cwd() 不可取时 cwd_unavailable 拒登记，不填 HUD_HOME/父目录/空串（consult 4 增补，F04） |
| T-01-7 (A9 fixture) | 已确认结束的 run-a resume → 同 link、新 run-b 和 binding_generation，本轮 call/message id、新 claim；旧 claim revoked；run-a binding 不参与 run-b 授权 |
| T-01-8 (A9 fixture) | claim 尚 issued、或 now=expires_at、或 source/run/launch instance/目标代次逐项错配 → 首兑拒绝，关系不 bound，记录具体错误 |
| T-01-9 (A9 fixture) | 已 armed 且当前时刻在 TTL 内，字段全部匹配 → 一次兑换 claimed；now=expires_at-1 可兑换，now=expires_at 不可兑换 |
| T-01-10 (A9 fixture) | 同主体同 run 同代重复 whoami（含已 bound 后 TTL 过期、MCP 重启） → 同 link/run 身份、无二次消费；撤销/换代后重复调用拒绝 |
| T-01-11 (A9 fixture) | fork 持复制 claim 先兑、无原启动实例关联 → claimed、无 child_ref/父边/report 权限；fork 新 ref 仅候选 |
| T-01-12 (A9 fixture) | T-01-11 后原主体提交本轮 claim+独立回执+唯一 session → reconciler 事务接管、原主体 bound、fork 候选；普通第二主体无证据仍 claim_conflict |
| T-01-13 (A9 fixture) | 两个逻辑 session 共享祖先，或两个互相矛盾的可信证据 → 不按先后选父、不 bound；已有绑定则撤销当前权限、保留冲突和历史 |
| T-01-14 (A9 fixture) | 事件时间分别为 issued_at-5000、+600000、-5001、+600001，正确 source/harness/call/message → 前两者可核验，后两者拒绝；发现延迟不改变边界；本轮 resume 的 launch_message 必须带原事件时间/真实消息身份/原 claim 指纹，缺 eventAt 即不合格，不以 observed-time 补窗（consult 4 增补，F01） |
| T-01-15 (A9 fixture) | 既有 link/run 缺 ref，唯一匹配+独立证据 → reconciler 回填 bound_by=transcript；相同材料没有 link/run → 不创建；HUD 只读连接写入被拒；tool_result/launch_message 均只是锚点，缺独立证据/现存 run 时不绑定，B9 不成为写者（consult 4 增补，F01） |
| T-01-16 (A9 fixture) | 双 transcript 匹配、错 harness/source/call id、仅 shell 命令/标签/env/私有块 → conflict 或不合格，零新父边；两份复制 launch_message、旧 claim 或错 launch_correlation_id/nativeMessageId 不取最近，缺 runId/tool/callId 不伪造字段以升级锚点（consult 4 增补，F01） |
| T-01-17 (A9 fixture) | owner-b 知道 owner-a 的 link/runId，调用 resume/cancel/predecessor → 拒绝/unsupported 并记事件，零外部启动/信号 |
| T-01-18 (B) | 当前 bound 子提交本 run report、未绑定子/别的 child/stale generation 提交 → 仅首项入 reports；重启后的新 CallerId 必须先重建当前 binding |
| T-01-19 (A9 fixture) | run-a 迟报，run-b 已开始，旧启动消息匹配 run-a → 只可归 run-a 的审计历史，不能新授 run-b 权限或满足 run-b wait |
| T-01-20 (A9 fixture) | 同 owner、实际 child ref、槽空闲的 predecessor → 新 link 唯一 current_owner，旧 link handed_over；历史 Inspector 仍能读旧关系 |
| T-01-21 (A9 fixture) | predecessor uncertain 占槽或跨 owner（含自报凭证） → slot_busy / unsupported，旧父边不变、零启动 |
| T-01-22 (A9 fixture) | 新父=child 或为 child 后代；重复绑定同 child → 回环拒绝；唯一 current_owner 索引阻止双父，闭 pane 不删除历史 |
| T-01-23 (B) | HUD、hud-mcp 原始观察、hud-run 原始回执各触发身份回填 → 只有 reconciler 事务产生迁移事件；HUD 账本连接始终只读 |
| T-01-24 (A9 fixture) | 当前 proc scope 仅 claimed 后试建 alias，再补独立 bound 证据 → 首次拒绝，第二次单向 proc→session 成功，OwnerKey 派生为 session |
| T-01-25 (A9 fixture) | 同 proc/generation 再映射别的 session，或归并同键异参 → 拒绝、不启动、有冲突事件；旧 alias 和结果仍可审计 |
| T-01-26 (A9 fixture) | 同进程切换 generation+1 → 旧 alias 同事务关闭；新 proc key 不查旧代范围，新绑定只能建立新代 alias |
| T-01-27 (A9 prototype) | 所测直接 stdio TUI/exec：每轮配置叶子 env（保留既有配置）+ 首次合格 params._meta + 启动/source/header → 唯一 ref；initialize/list 不绑定，参数伪造不替代来源，双 home 无交叉；0.166.0 root→child→root 的真实拓扑中，child 即使另起 MCP/同 harness PID，root sessionId 与 child threadId/turn.thread_id、parent_thread_id/subagent 来源仍必须拒绝，零 rootThreadOf 授权，根后续仍可验证（consult 4 增补，F07） |
| T-01-28 (A9 fixture) | 未验证 daemon 代启/共享来源，模型仅传 prompt claim/arguments._meta/sessionId → 无授权 context，不消费 claim、不建 alias/report/owner；daemon 在场但仍 direct-stdio 不误分 shared |
| T-01-29 (A9 fixture) | 无 MCP 即使三证齐备 → pending/未确认展示，零确定 SessionRef 父边/child_binding，报告与 resume 拒绝 |
| T-01-30 (A9 fixture) | 无 MCP 缺任一证据或 fork 复制消息 → 未确认/候选；另有独立 scope R/N/Q 可按02结束 run，不能顺带绑定 |
| T-01-31 (A9 fixture) | 无 MCP 自报 whoami/report，或后来才加载 MCP → 前者拒绝，后者先正常登记与本轮身份/claim 校验，无观察权限继承 |
| T-01-32 (A9 fixture) | shell/agent/MCP 三跳分别缺失，Codex 配置 env 可用/不可用 → 按档案叶子注入，确有 MCP 才可本轮消息 fallback；不因换运输通道重发任务 |
| T-01-33 (A9 prototype) | cc 根 env/session 文件正确但本次 toolUseId 来源缺失/属于原生子；另可证根调用 → 前两组拒绝根权限，只有唯一当前根来源才可操作；env/参数 claim 不减免门槛；根→原生子→根共 MCP，子携根 sessionId/transcript_path/env/claim 不授权，不建 root context/消费 claim/关闭 scope/alias/换代；agent_id 缺失或字段矛盾不推定根（consult 4 增补，F07） |
| T-01-34 (C) | pi resume 续文件、新文件有可信连续性、新文件无映射三组 → 前两组同 ref/新 run，第三组候选且 resume 未验证，不自动合并 |
| T-01-35 (A9 fixture) | 一个 MCP 接到共享 A/B、可辨原生子或不可辨来源；即使带根 env/session/claim → MVP unsupported/identity_source_missing，零 owner/幂等查询/报告授权；子调用不授成根、不使根换代；核对根 context/scope/alias、claim 消费与 generation 均不因子拒绝变化，下一根调用仍可逐次核验（consult 4 增补，F07） |
| T-01-36 (A9 fixture) | 当前 session 切换/generation+1，旧代、缺来源或 prompt 声称旧 root → 旧授权先撤销，不复用缓存；没有可观测切换路径的档案拒绝；新旧 MCP 同时绑定、旧证据 A→B→A 重放及仅物理 MCP 较晚启动不复活旧代；查幂等/写入均重验 scope generation/证据版本/context/目标 run/binding，stale_context/identity_unverified 不重贴代次；合法旧代 durable accepted 意图保留并按原票据重验，不抹接受/起副本（consult 4 增补，F07） |
| T-01-37 (A9 fixture) | resume/handover 关系已child-a，新轮解析child-b，或合法同a的新消息 → 前者拒改links.child_ref/runs.target_ref、run uncertain/b仅候选；后者可本轮绑定，link不回pending |
| T-01-38 (A9 fixture) | 同用户/私有账本/已确认parent_ref的local resume，与错UID/非私有路径/父未确认/参数admin四组 → 仅首项可代表已登记owner；actor记录local_user/UID/invocation/owner，零伪造CallerId/父tool_result |
| T-01-39 (A9 fixture) | local report/spawn/跨owner predecessor、把另一主体allowedActions当凭据、旧父context失效 → 均不由例外放行；合法local resume按typed initiator重验，不依赖旧context仍活，原parent/link归属不变 |

A9 最小身份包：cc→Codex 唯一 source/session、claim 配置运输、fork/旧 claim 不授权、同进程切换失效、MCP 重启 OwnerKey 连续、共享/不可辨来源拒绝；尚不支持的 daemon/无 MCP 只验拒绝。T-01-4、5、27、33 用最小原型与 A3 关键证据补齐，其余 A9 项可用规格/fixture；生产集成与完整能力矩阵归 B，不要求全部 B 先于 A9。
