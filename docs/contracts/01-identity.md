# 01：调用者登记与绑定凭据

- 版本：`v0.2 draft`（2026-11-01；A1 第二批一致性修订）。
- 状态：A1 第一批草案；不是阶段 B 的冻结基线。A9 需同时审查不变量、失败案例、测试结果与探针原始证据。
- depends-on：[概念方案 v2.3](../universal-hud-concept.md) §4、§6.6、§6.7、§15–16；[工程计划 v1.1](../universal-hud-engineering-plan.md) §3–4、§6；[第三轮评审](../reviews/2026-11-01-chatgpt-pro-v22-plan.md) §3①②；[02 执行协议](./02-execution.md) 的事务与 schema。
- 开放项：A3 初步证据仍待可信性/覆盖复核；甲暂定，**待 A8 第二轮**，中间shell退出不是R，保留乙缺回执分支。跨所有者凭证内部格式见 [03](./03-lifecycle.md)，公开入口推迟v1.1；MVP跨所有者仍unsupported。新轮握手不改既有child_ref。

开放项补充：**A3 初步结论（2026-11-01，探针已完成、尚未评审）**。下列仅归档初步观测，仍待 A3 评审及可信来源边界复核；保留下文所有成立/不成立分支，不据此宣布 A9 或能力验证通过。

- [Codex MCP 探针](../probes/codex-mcp-launch.md)：codex-cli 0.166 的 MCP 为 TUI / exec 直接子进程、每会话一个实例；测量时共享 daemon absent，daemon-present 未测，条件门不撤销。shell HUD_* / HERDR_* 不到 MCP，只有配置 env 表额外传入。观测 `_meta.sessionId`、`_meta["x-codex-turn-metadata"].session_id` 匹配 rollout，但来源 **trust unverified**，无证据排除模型提供/覆盖，因此目前不作授权来源；其他字段也不因存在而可信。
- [cc MCP 探针](../probes/cc-mcp-env.md)：MCP 是 claude 直接子进程，继承完整环境（包括 CLAUDE_CODE_SESSION_ID），sessions/<ppid>.json 的 pid/procStart 匹配；该版本 `_meta` 没有 session id。
- [Herdr env 探针](../probes/herdr-env.md)：只测 Codex tab-root 与 pi split；该范围内 env 到 shell/agent，pi MCP 可达、Codex MCP 不可达。不外推其他布局/harness，保留未成立分支。
- [pi resume 探针](../probes/pi-resume.md)：pi 1.4.0 的 --session <id|path> 追加同一文件，--fork 新建文件；[双 home 探针](../probes/codex-dual-home.md) 初步确认两个 Codex home 隔离，仅 cwd 的键会混淆。文件连续性及隔离的初步结果不撤销未成立分支的拒绝规则。

本文中的“必须”是待实现、待验证的协议要求，不是已经通过的运行保证。只使用合成身份举例。账本唯一写者家族为 `hud-mcp`、`hud-run`、reconciler；初始登记、意图和证据可以由前两者写入，身份回填、generation 失效和关系状态迁移统一经 reconciler 的事务入口。HUD 只读账本并投影，不替它们执行绑定。

## 数据模型

### 身份、实例与定位

| 对象 | 字段与判等 | 不作为身份证明的字段 |
|---|---|---|
| `SourceId` | 固定顺序 JSON 数组 `[harness, realpath(配置/存储根)]` 的 UTF-8 SHA-256 小写十六进制；`sources` 同时保存 harness、绝对根路径和显示 label。根无法解析时拒绝建立授权身份 | cwd、账号显示名、相对路径 |
| `SessionRef` | `(harness, source_id, session_id, thread_id?)`；SQL 编码为 `json_array(harness, source_id, session_id, nullif(thread_id, ''))`。cc 根 `thread_id=''`，原生子为 `agentId`；Codex 每个线程使用自己的 `session_id` | transcript 路径、pane、PID、tmux session 名 |
| `ProcessKey` | 专属 stdio 的 harness `(harness, source_id, pid_domain, harness_pid, harness_proc_start)` 固定顺序 JSON 数组；harness_pid 是经祖先链核验的 ppid。共享 context 不派生进程范围，不能取共享 daemon 冒充 TUI | 仅 PID、进程名字、继承的 pane env |
| `CallerId` | 每个物理 MCP 实例新生成的 opaque id；仅记录 MCP 的 pid/proc_start、实际父进程 ppid/parent_proc_start、harness/source 提示、cwd、env_pane、时间。共享实例仍只有一个 CallerId，实际父进程可以是 daemon | CallerId、物理父进程及提示字段本身不授予会话身份 |
| `caller_contexts` | 物理 CallerId 下的隔离调用上下文，`(context_id,generation)` 保留历史，含 context_key、kind、SessionRef、证据与关闭时刻。dedicated 恰好一个当前 stdio context，连接到 ProcessKey/proc_generation；shared 可同时有多个 context，只能由可信逐调用来源建立/选择且必须已有唯一 SessionRef | claim、prompt、自报 session 参数不能选择或创建 shared context |
| `caller_scopes` | 专属 stdio 的 `(process_key, generation)`；同一 ProcessKey 只有一行未关闭。保存本代已证实 ref/证据；dedicated context 的 generation=proc_generation，MCP 重启复用尚未关闭的同一代。shared context 不使用此表或 proc alias | 新 MCP PID 不能触发专属会话换代 |
| `RunBinding` | 某次运行的会话、启动实例与宿主 occupant；在 schema 中由 `runs`、`child_bindings` 和 evidence 组合表示。Herdr locator 带 server/workspace/tab/pane，tmux locator 带 server 实例/session/pane | HUD 自己的 pane 不是被观察 pane |
| `OwnerKey` | 从本次调用选定的当前 context 派生：已证实会话为 `json_array('session', session_ref)`；仅未绑定 dedicated 可用 `json_array('proc', process_key, generation)`。shared 始终直接取 session 范围，不用 proc alias。已绑定 SessionRef 跨 MCP 重启和同会话 resume 保持逻辑所有者 | 不把 caller_id/context_id 放进幂等键，不另建可随意赋值的所有者身份 |

`caller_contexts.generation` 是调用上下文的代次；`RunBinding.binding_generation` 是目标会话本轮运行绑定的代次，分别校验。首次运行先以 provisional 目标分配 binding_generation；resume / predecessor 根据已有会话最后代次递增，与意图同事务。`child_bindings` 记录物理 caller、context/generation 和目标绑定代次的关联。MCP/模型传来的 generation 只是请求值，不能覆盖可信来源或当前账本值。

专属 context_key 固定 stdio。shared 的 context_key 来自可信传输层的稳定会话通道标识（含 provider/来源域，非模型参数）；每次调用都验证它唯一对应的 SessionRef 与来源 generation，再选择 context。A/B 交错调用分别校验 A/B，不修改对方代次。可信来源确认同 context 已切换会话/occupant 时，reconciler 关闭旧 generation、撤销该 context 的 binding，创建 generation+1；缺可信逐调用来源时该次调用没有有效 context，返回 identity_source_missing，不沿用上次 context、不凭 claim 补选，也不替其他合法 context 换代。物理 MCP 重启产生新 CallerId/context 行；专属从未关闭 proc scope 恢复代次，shared 必须重新从可信来源建立 context，OwnerKey 仍由 SessionRef 派生。

### claim 与证据

`claims` 每个 run 一行：随机至少 256 bit 的 claim 仅在启动环境和本轮启动消息中运输；账本只存 SHA-256 `claim_hash`。`issued_at` 起 TTL 为 30 分钟，`now >= expires_at` 拒绝首次兑换。它绑定 `run_id`、预期 source、`expected_generation`（目标绑定代次）、启动实例 `(supervisor_pid, supervisor_proc_start)`，以及本轮 `launch_call_id / launch_message_id`。启动实例尚未登记时为 `issued`，不能兑换；hud-run 取得 02 的执行权并登记实例后才变为 `armed`，再交给子进程。

兑换主体是 `(caller_context, context_generation, child SessionRef 如已知, run_id, binding_generation)`，不是 MCP PID；claims 保存声明时的 context 外键。重启后的新专属 context 必须证实同一 ProcessKey/代次，shared 必须证实同一 SessionRef/来源代次，再由 reconciler 重建授权并保留旧声明事件，不能凭新 context_id 再兑一次。`redeemed` 只表示凭据已被一个主体声明；fork 声明不授予 report 或父权限。重复 whoami 先检查当前绑定：同一逻辑主体、同 run 同代且未撤销时幂等返回，即使后来 TTL 已过也不再次兑换；未绑定的过期声明不能继续升级。不同主体普通兑换返回 claim_conflict；仅独立证据接管事务可替换未绑定声明。

`evidence` 保存白名单元数据、原始证据指纹和观测时间，不保存 claim 明文、密钥、完整 prompt 或私有块。启动回执必须指向本轮 hud-run 启动的确切 harness 进程 pid + procStart，并证明其位于 caller 的经核验 ppid 链上；宽泛的共同祖先或仅进程名不够。可信会话证据还必须唯一指向本次调用/运行的 SessionRef，不能以共享进程的祖先关系区分其多个逻辑会话。

### SessionRef resolver 的证据边界

| harness / 来源 | 可接受的独立绑定证据 | 不足时的结果 |
|---|---|---|
| cc | 当前明确 stdin 的 session_id/transcript_path 可作观测入口；MCP 授权另需 sessions/<harness_pid>.json 的 pid、procStart、pidDomain 与 caller 一致，或经过验证的逐调用会话来源；cc 子代理必须含 agentId | 别的 PID 域在本机不可见是 unknown；根与多个 agentId 不合并 |
| Codex | 在确切 source 下定位实际 thread；经验证的逐调用来源，或注册表 `agent_session.value` 对应本轮 locator 内的 pane，且 occupant/进程实例匹配；启动回执证明该 caller 属于该次启动 | 现有 daemon 时间配对、cwd/最新文件只能给候选，单独不足以授权 |
| pi | 从已核验的 harness 进程 cmdline 解析精确 `--session` / `--session-id`，读取该 source 的 header 核对 id；目录参数只界定候选范围 | 只有 --session-dir、--role、--orchestrator 不产生唯一会话 |
| transcript | 只作下文限定核验；绑定必须已有独立启动/会话证据 | copied linkId、claim 或历史 prompt 不构成独立证据 |

现有实现依据：[daemon-binding.ts](../../src/collectors/daemon-binding.ts) 的 `findConnection` 用启动时间/排序配对，读失败可能保留旧 thread；[session-finder.ts](../../src/collectors/session-finder.ts) 的 `rootThreadOf` 是 HUD 根视图策略，不用于把实际 caller 子线程授权成根。shell snapshot 的 `TMUX_PANE` 可能来自 daemon；`findFallbackSession` 会选最新 cwd rollout，不执行授权所需的唯一性判断。[Herdr 观察桥](../../bin/codex-hud-herdr.mjs) 的 `readNativePane` 只返回状态，没有验证 `agent_session.value`；[环境修复说明](../herdr-context-fix.md) 证明命令环境的运输边界，不证明 MCP 的会话归属。B1 必须在复用这些观察结果时保留 provenance，并补独立证据；本契约不改旧观察代码。

## 不变量

表中 `DB` 指 02 的键/约束可直接检查；`TX` 指写者事务校验；`E` 指还需真实进程或探针证据。SQL 的字段存在不能证明外部事实。

| 编号 | 可检查的断言 | 层 / 对应测试 |
|---|---|---|
| I-01-1 | SessionRef 完整判等包含 source 和原生 thread；定位变化不改变逻辑身份。来源、harness、原生 agentId 不一致不得合并 | DB+TX；T-01-1、2、3 |
| I-01-2 | 所有工具调用校验物理 caller 及选定 context/generation；dedicated 另校验 ProcessKey/proc_generation，shared 每次校验可信来源。MCP 重启不更改逻辑所有者；切换、/clear、resume、occupant 或 PID 实例变化先失效对应 context 的旧授权 | TX+E；T-01-4–7、35、36 |
| I-01-3 | claim 首次兑换必须未过期、未撤销且 run/source/启动实例/目标代次相符；claim 只升 claimed，同主体重复不重复消费 | DB+TX；T-01-8、9、10 |
| I-01-4 | 常规 bound 必须具备已登记 caller、有效 claim 声明、唯一实际 SessionRef、独立证据；相同祖先的多会话无法区分时不得 bound。fork 先兑换也无所有权 | TX+E；T-01-11、12、13 |
| I-01-5 | transcript 只能核验既有 ledger link/run；仅确认或否定，不能创建 link/run，不能单独提供独立身份。缺 ref 的唯一合格匹配只由 reconciler 回填并记录 bound_by 与 evidence | TX；T-01-14、15、16 |
| I-01-6 | parent 操作取本调用 OwnerKey，等于关系当前所有者才允许 resume/cancel；report 只能来自目标 run 当前且未失效的 MCP child binding。知识型 claim/linkId 不授予权限 | TX；T-01-17、18、19 |
| I-01-7 | 同一child只有一个当前owner/父边；MVP predecessor只同owner/空槽。v1.1跨owner须03的显式凭证校验与单次消费；无能力/未验证仍unsupported。转交原子、旧link历史，fork只候选 | DB+TX；T-01-20–22；02 T-02-18；03 T-03-20–25 |
| I-01-8 | HUD 永不写 ledger；caller 注册不直接推导关系绑定；身份回填、冲突、失效/代次变更和关系迁移经 reconciler 提交并附事件 | TX；T-01-15、23 |
| I-01-9 | owner_aliases 只给 dedicated 单向归并 proc→session；先有 bound 级证据，每 proc/generation 最多一个目标；归并同时建立 session 范围的原结果副本。换代关闭 alias，历史保留；冲突拒绝、不启动、记事件。shared 不建立或使用 proc alias | DB+TX；T-01-24–26、35；02 T-02-4、5 |
| I-01-10 | 共享 daemon 无可信逐调用来源时：父不登记为可操作 caller，子仅可记录无授权 claimed；prompt claim 不能替代逐调用身份 | TX+E；T-01-27、28 |
| I-01-11 | 无子 MCP 的观察路径仅在启动回执 + 可信唯一进程→SessionRef + 限定启动消息三证齐全时 pending→bound；claim 保持未兑换，bound_by=receipt+transcript，能力 observe_only；无 whoami/report 权限 | TX+E；T-01-29、30、31 |
| I-01-12 | 一个物理 CallerId 可有多个 shared context，但相同 context_key 只能一代当前；专属只有一个当前 context。shared context 必须有可信唯一 SessionRef，禁止 proc scope；跨 context 报告/权限不混用，缺可信来源的调用无授权 | DB+TX+E；T-01-35、36；02 T-02-27 |
| I-01-13 | resume/handover 的本轮 child 只能等于关系既有 child_ref；runHandshake 独立于 link.state。新文件/fork无连续性证据不得改旧ref，run uncertain、最多候选 | DB+TX；T-01-37；03 T-03-5、8、9 |

### owner_aliases 的建立与关闭

仅 dedicated：同一事务证明 ProcessKey/generation 当前未关闭且唯一 SessionRef，写 caller_scope 与 context 的 ref/证据；检查 proc 与 session 的全部幂等记录（02 的冲突规则），再把每个旧结果以相同 digest/link/run/outcome 建立 session 范围记录（已有相同结果则复用）、建立 alias、回填该代 link.parent_ref 并发事件。任何冲突整体拒绝。claim/cwd 匹配不能满足前置条件；关闭 alias 不删除原记录、不让新代 proc 查询旧范围。shared 已由可信逐调用来源直接确定 session，不走此归并；它可直接重放已归并到 session 范围的原结果。

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
| bound → bound | MCP 重启的新 CallerId 先建立当前 context：dedicated 证实同 ProcessKey/代次，shared 重新证实 SessionRef/可信来源代次，再重建 child_binding；旧 binding 留历史，不重新消费 claim | I-01-2、3、6、12；T-01-4、10、18、35 |
| 当前授权 → 失效 | 发现会话/occupant 改变：关闭对应 context，撤销 binding/claim，context generation+1；dedicated 同步关闭旧 scope/alias、新 scope generation+1，进程实例改变则建新 ProcessKey。shared 不影响其他 context；历史不重写 | I-01-2、9、12；T-01-5–7、26、36 |
| resume：同 link → bound；新 run starting/握手pending | 02 槽空闲/owner/同任务门禁全部满足；新 run/代次/消息/claim，撤销旧 claim/binding。closed→bound 清当前 closed_at但保留close事件；新握手必须匹配既有child_ref，handover同样约束 | I-01-2、3、6、13；T-01-7、19、37 |

### transcript 核验的封闭范围

| 项 | 必须同时满足的条件（I-01-5；T-01-14–16） |
|---|---|
| 父侧 | 本次 delegate_spawn/delegate_resume 的 tool_result 中的 linkId、runId；与账本记录的工具调用 ID 一致。父 transcript 的 harness/source 与 caller 相符 |
| 子侧 | delegate_whoami 的工具结果，或本轮启动消息的 linkId + claim 指纹；都锚定本轮 launch_call_id 和 launch_message_id，resume 不扫描会话“首条消息”替代本轮消息 |
| 时间 | 以账本 issued_at 为基准，记录事件时间在 `[issued_at-5000, issued_at+600000]` 毫秒闭区间；发现时间可以更晚，但不能拿 mtime/扫描时间替代事件时间。claim 首次兑换 TTL 另行校验 |
| 匹配 | harness/source 一致、SessionRef 唯一；多份复制 transcript 为 conflict，停止归属，不取最新。不加载候选正文来扩大核验范围 |
| 写入 | 已有 link/run、独立证据通过才可回填缺 ref 并标 bound_by=transcript；已有 ref 被否定则保留历史、撤销当前授权并标冲突，绝不静默改父 |

启动实例或调用 ID 缺失、时间不可验证、非公开块、任意 shell/herdr/jev 命令、标签、HUD_LINK 或 pi orchestrator 的共现均不能扩展此表。当前来源失联只将证据标 stale/unknown；它不证明 session 已退出，不释放 02 的槽。

### 无子 MCP 的独立观察路径

这是编排者确认的受限例外（I-01-11），不伪造 CallerId：只有 (a) hud-run 启动回执给出精确被托管 pid+procStart，(b) cc sessions 的 pid/procStart、Codex 本轮 locator 的注册表 agent_session 或 pi 精确 --session 把该进程映射到唯一 SessionRef，(c) 该 ref 的 transcript 本轮启动消息含 linkId+claim 指纹，符合上述时间窗、调用锚点、harness/source 和唯一性，三项全部满足，reconciler 才能 `pending → bound`，记录 `bound_by=receipt+transcript`、`capabilities=observe_only`。claim 保持 armed/未兑换并按 TTL 到期；后续报送不存在授权主体，必须拒绝。fork 复制消息不能取得 (a) 的精确启动进程关联。可见方案乙不能给出 (a) 时保持 pending，**待 A8 探针**；将来加载 MCP 需重新走正常登记和授权，观察绑定不自动变成 report 权限。

### 四条身份路径及待验证分支

| 路径 / 探针问题 | 证据成立分支 | 不成立分支 / 明确不支持 | 测试 |
|---|---|---|---|
| fork：复制历史/claim 是否可抢先占位 | fork 只到 claimed；原启动主体凭独立证据接管。确证是新 SessionRef 仍不建 v1 link | fork 与原主体共享进程且缺可信逐调用 session，不能仅凭 ppid 链区分，保持未绑定 | T-01-11–13 |
| resume：本轮消息与新旧代次 | 新 run/claim、旧凭据撤销；通过当前来源把已有 SessionRef 绑定到新运行 | 活跃/uncertain 槽先拒绝；旧 prompt、旧 whoami、旧 run 报告不授权新 run | T-01-7、19 |
| 同 pane 换 session / 同进程 /clear | 发现变化先 generation+1 并关闭 alias，历史关系保留；显式可信当前 session 必须覆盖旧缓存 | 无法观察同进程切换且无逐调用证据的路径不用于授权，返回 identity_unverified | T-01-5、6、26 |
| Codex MCP 启动者及基数，env / _meta 能否到达（待 A3 探针） | TUI 专属 MCP：验证祖先链/session，使用单 dedicated context；共享 daemon：每次调用有不可由模型伪造的可信来源时，在同一物理 CallerId 下建立/选择独立 shared context，各自 ref/generation，OwnerKey 直接 session | 无可信源的 shared 调用不建立/选择 context：父不登记为可操作 caller，子至多诊断性 claimed（事件，不把 claims 标 redeemed），无授权。env/参数 claim 不补足，daemon PID 不作 TUI | T-01-27、28、35、36 |
| Herdr --env 是否到 shell、agent、MCP（待 A3 探针） | 三跳分别有证据才 env 自动 whoami | 任一跳缺失则用本轮消息的参数 claim；仍需独立证据，不能因 CLI 返回成功标支持 | T-01-32 |
| cc MCP env 内容（待 A3 探针） | HUD_CLAIM 到达则自动调用相同校验路径 | 不到达则显式 claim 参数；pid/procStart/PID 域证明不减免 | T-01-33 |
| pi --session resume 续文件还是新文件（待 A3 探针） | 续文件保持 ref；新文件仅有可信 resume 因果映射时归同一 ref，路径更换不改逻辑身份 | 新 header 指向另一个无连续性证据的 id 时只作候选，pi resume 标未验证/unsupported | T-01-34 |

## 失败案例

| 编号 | 合成失败场景 / 必须观察到的结果 | 不变量 | 测试 |
|---|---|---|---|
| F-01-1 | 相同 cwd、session_id，但两个 source 或不同 cc agentId；不合并 | I-01-1 | T-01-1、2 |
| F-01-2 | PID 重用、pane 换 occupant、同进程换会话；旧授权先失效，历史不迁到新人 | I-01-2、9 | T-01-5、6、26 |
| F-01-3 | claim 晚到、过期、错 run/source/实例/代次；拒绝，不写 bound | I-01-3 | T-01-8、9 |
| F-01-4 | fork 先兑换或复制同一祖先链；无独立会话证据不得 bound；原主体可证据接管 | I-01-4 | T-01-11–13 |
| F-01-5 | transcript 多匹配、超窗、旧 resume prompt、单独 linkId 共现；不建关系，冲突不选最近 | I-01-5 | T-01-14–16、19 |
| F-01-6 | 非 owner 取消/resume、非子 report、旧 run 迟报；拒绝授权，报告不满足新运行 | I-01-6 | T-01-17–19 |
| F-01-7 | 转交槽非空、MVP跨owner/凭证未验证、回环或双父；拒绝且旧历史保留 | I-01-7 | T-01-20–22；03 T-03-20–25 |
| F-01-8 | claim 建 alias、同代映射两 session、同键异参归并；拒绝归并并事件化，不启动 | I-01-8、9 | T-01-23–26 |
| F-01-9 | 共享 daemon、env 缺失、继承 stale pane 被当作 session；父无登记，子无授权 | I-01-10、2 | T-01-27、28、32、33 |
| F-01-10 | 无 MCP，缺启动回执/可信映射/本轮唯一消息任一项，或持复制消息的 fork | I-01-11 | T-01-29–31 |
| F-01-11 | pi resume 新文件或fork没有可信连续性；不把新 id 猜成旧 ref，不改已知关系 | I-01-1、2、13 | T-01-34、37 |
| F-01-12 | shared A/B 交错、A 换代、一次调用缺可信来源或用 prompt 指向 B → 各自隔离；缺来源拒绝、不沿用上次 context | I-01-2、9、12 | T-01-35、36 |

## 测试清单

以下是 A4 fixture / B1、B2、B5 进程测试的输入和状态断言，不表示本批已执行。`P` 必须有真实合成进程/临时 source 与 ledger，不能只靠 fixture；所有输入不得读用户状态。时间均由测试钟驱动。

| 编号 | 输入 → 预期状态断言 |
|---|---|
| T-01-1 | 同 cwd，两个 realpath source，session_id 都是 synthetic-s → 两个不同 SessionRef/OwnerKey；symlink 指同根则同 SourceId |
| T-01-2 | cc root 与 agent-a/agent-b 共 session_id → 三个 ref；三个 SQL 唯一键均可存在，精确重复被拒 |
| T-01-3 | ref 不变，仅改 transcript 路径/Herdr workspace locator → ref 不变；旧 occupant 跳转校验失败时无宿主状态，不改父边 |
| T-01-4 (P) | 专属 harness 保持存活，杀掉并重启 MCP → CallerId/context_id 改变，ProcessKey/代次/已绑定 OwnerKey 不变；shared 重启须重新建立可信 context，仍同 SessionRef OwnerKey；02 T-02-3 命中旧记录 |
| T-01-5 (P) | 同 pane 同 PID 先 session-a 后 /clear 到 b，procStart 不变 → a 代关闭、generation+1、旧 report/resume 授权拒绝；a link 仍指 a |
| T-01-6 (P) | pane 被替换或同数值 PID 不同 procStart；另给不可见 PID 域 → 新 ProcessKey/occupant，不复用旧授权；不可见域只标 unknown |
| T-01-7 | 已确认结束的 run-a resume → 同 link、新 run-b 和 binding_generation，本轮 call/message id、新 claim；旧 claim revoked；run-a binding 不参与 run-b 授权 |
| T-01-8 | claim 尚 issued、或 now=expires_at、或 source/run/launch instance/目标代次逐项错配 → 首兑拒绝，关系不 bound，记录具体错误 |
| T-01-9 | 已 armed 且当前时刻在 TTL 内，字段全部匹配 → 一次兑换 claimed；now=expires_at-1 可兑换，now=expires_at 不可兑换 |
| T-01-10 | 同主体同 run 同代重复 whoami（含已 bound 后 TTL 过期、MCP 重启） → 同 link/run 身份、无二次消费；撤销/换代后重复调用拒绝 |
| T-01-11 | fork 持复制 claim 先兑、无原启动实例关联 → claimed、无 child_ref/父边/report 权限；fork 新 ref 仅候选 |
| T-01-12 | T-01-11 后原主体提交本轮 claim+独立回执+唯一 session → reconciler 事务接管、原主体 bound、fork 候选；普通第二主体无证据仍 claim_conflict |
| T-01-13 | 两个逻辑 session 共享祖先，或两个互相矛盾的可信证据 → 不按先后选父、不 bound；已有绑定则撤销当前权限、保留冲突和历史 |
| T-01-14 | 事件时间分别为 issued_at-5000、+600000、-5001、+600001，正确 source/harness/call/message → 前两者可核验，后两者拒绝；发现延迟不改变边界 |
| T-01-15 | 既有 link/run 缺 ref，唯一匹配+独立证据 → reconciler 回填 bound_by=transcript；相同材料没有 link/run → 不创建；HUD 只读连接写入被拒 |
| T-01-16 | 双 transcript 匹配、错 harness/source/call id、仅 shell 命令/标签/env/私有块 → conflict 或不合格，零新父边 |
| T-01-17 | owner-b 知道 owner-a 的 link/runId，调用 resume/cancel/predecessor → 拒绝/unsupported 并记事件，零外部启动/信号 |
| T-01-18 | 当前 bound 子提交本 run report、未绑定子/别的 child/stale generation 提交 → 仅首项入 reports；重启后的新 CallerId 必须先重建当前 binding |
| T-01-19 | run-a 迟报，run-b 已开始，旧启动消息匹配 run-a → 只可归 run-a 的审计历史，不能新授 run-b 权限或满足 run-b wait |
| T-01-20 | 同 owner、实际 child ref、槽空闲的 predecessor → 新 link 唯一 current_owner，旧 link handed_over；历史 Inspector 仍能读旧关系 |
| T-01-21 | predecessor uncertain占槽，或MVP调用者换owner/未来凭证未验证 → slot_busy / unsupported，旧父边不变，零启动；v1.1内部合法凭证另见03测试 |
| T-01-22 | 新父=child 或为 child 后代；重复绑定同 child → 回环拒绝；唯一 current_owner 索引阻止双父，闭 pane 不删除历史 |
| T-01-23 | HUD、hud-mcp 原始观察、hud-run 原始回执各触发身份回填 → 只有 reconciler 事务产生迁移事件；HUD 账本连接始终只读 |
| T-01-24 | 当前 proc scope 仅 claimed 后试建 alias，再补独立 bound 证据 → 首次拒绝，第二次单向 proc→session 成功，OwnerKey 派生为 session |
| T-01-25 | 同 proc/generation 再映射别的 session，或归并同键异参 → 拒绝、不启动、有冲突事件；旧 alias 和结果仍可审计 |
| T-01-26 | 同进程切换 generation+1 → 旧 alias 同事务关闭；新 proc key 不查旧代范围，新绑定只能建立新代 alias |
| T-01-27 (P/A3) | MCP 由 TUI 启动且祖先/逐调用来源可靠；再测共享 daemon 有可信逐调用 session → 分别专属绑定/按 session 隔离，两个 source 同 cwd 无交叉 |
| T-01-28 (P/A3) | shared 无可信 _meta；模型只传 prompt claim 或伪造 session 参数 → 无有效 context，父不登记为可操作 caller，子至多 claimed 诊断事件，claim 未 redeemed，无 alias/report/owner 权限 |
| T-01-29 | 无 MCP，合成启动回执+唯一可信 pid→session+范围内本轮启动消息 → pending 直接 bound、observe_only、bound_by=receipt+transcript、claim 未兑换 |
| T-01-30 | T-01-29 三项各缺一、或 fork 只有复制消息 → 始终 pending/候选；可见方案乙无回执同样不绑定，待 A8 |
| T-01-31 | observe_only 关系提交 whoami/report → 无 caller 时拒绝；后来加载 MCP 也须重新正常握手，不能沿用观察权限 |
| T-01-32 (P/A3) | --env 在 shell/agent/MCP 三跳逐一缺失 → 分别记录可达性，env 全通走自动 claim；缺失走本轮消息参数但独立证据要求一致 |
| T-01-33 (P/A3) | cc MCP 分别可见/不可见 HUD_CLAIM → env/参数两分支同样校验 sessions pid/procStart/PID 域；env 不自动构成身份 |
| T-01-34 (P/A3) | pi resume 续文件、新文件有可信连续性、新文件无映射三组 → 前两组同 ref/新 run，第三组候选且 resume 未验证，不自动合并 |
| T-01-35 (P/A3) | 同一物理 MCP 同时服务可信通道 A/B，交错 whoami/report/spawn/同 request_key → 两个当前 context，OwnerKey 分别 session-a/b，无 proc alias；无互相失效/跨 report，SQL 外键可表示两者 |
| T-01-36 | A context 的可信来源确认切换/generation+1；A 旧代调用、缺可信来源调用、prompt 声称 B 三组 → A 旧权限拒绝、无来源不选 context、prompt 不改变选择；B 代次/授权不变 |
| T-01-37 | resume/handover 关系已child-a，新轮解析child-b，或合法同a的新消息 → 前者拒改links.child_ref/runs.target_ref、run uncertain/b仅候选；后者可本轮绑定，link不回pending |

A9 的 identity gate 至少需要 T-01-4–6、27–28、32–34 的实际证据，并复核 no-MCP/A8 分支；fixture 通过只说明合成输入下的规则一致。
