# Oracle consult 4: phase B batch 1 forks

> **Superseded in part (2026-11-01):** the cost gate of F08 for the explicit `claude_pre_tool_use_v1` profile was decided by ChatGPT Pro, see [2026-11-01-chatgpt-pro-f08-hook-budget.md](./2026-11-01-chatgpt-pro-f08-hook-budget.md) (joint p95 < 150 ms; MCP-internal < 50 ms; authorization + DB ≤ 30 ms). The rest of this ruling stands.

Codex gpt-6-astra, effort max, read-only, 2026-11-01, baseline `24c50fb`. Brief: Claude call source (B1 probes), four type/authority gaps (B1, B3a, B8), raw tails at rest (B8). Verbatim answer below; F01–F11 are the required changes.

---

# ORACLE4：阶段 B 第一批分叉裁决

评审基线：主 checkout 的 HEAD `24c50fb`，已合入 B8 `964899a`、B1 `ce1849f`；B3a 仅查阅仍在工作的 `<worktree>/B3a/src/core/run/`。这是设计裁决，不是生产实现验收。沿用 A9 的带条件放行和已冻结的 ledger schema v1；本轮不要求增加账本表或列。

**结论：Q1 修改共享观测类型；Q2 追认配置 envelope 和物理 Caller.cwd 的解释；Q3 追认独立的本地管理权限；Q4 选择版本受限的同步 PreToolUse 精确调用证据路径，但现有 Claude direct 档案继续拒绝授权，现有 Node hook 不获性能放行；Q5 统一禁止持久化未完成记录的原始字节。共 11 项必改，编号 F01–F11。**

本次没有把 Claude 从 MVP 删除。工程计划阶段 B 的目标是 **cc → Codex**：05 的 M-05-8 将“Claude 作为受委派后端”放在 C，并不意味着“Claude 作为发起委派的父调用者”也可移出 B。后者若因取证成本仍不能达标而要删除、推迟或放宽 50 ms 门槛，必须由 ORCH 上送 ChatGPT Pro；不得用 Codex → Codex 演示替代并宣称原 MVP 已完成。

## Q1：Claude SessionEvidence 的两个类型缺口

**裁决：修改。B8 暂留 adapter-local、未升级授权的默认正确；共享类型应补齐已有契约允许的观测，不永久保留两套接口。**

### F01：LinkEvidence 增加 launch_message 判别分支

修改 `src/core/interfaces/session-evidence.ts`，保留现有 `tool_result` 字段与语义，提取为 `ToolResultLinkEvidence`；增加以下观测分支，并令 `LinkEvidence` 为两者的判别联合：

```ts
interface LaunchMessageLinkEvidence {
  kind: 'launch_message';
  ref: SessionRef;
  nativeMessageId: string;
  linkId: string;
  claimFingerprint: string; // SHA-256，64 位小写十六进制
  eventAt: number;          // 原记录的有效事件时间，不是扫描时间
  launchCallId?: string;    // 只在该记录确实提供时填入
  launchCorrelationId?: string;
}

type LinkEvidence = ToolResultLinkEvidence | LaunchMessageLinkEvidence;
```

启动消息通常尚未提供 runId，也不是工具结果，**不得为满足旧接口伪造 runId、tool 或 callId**。指纹使用原 claim 字节，不保留明文、整条启动消息或完整 prompt。没有可核验事件时间的消息不能成为此合格分支；可留无授权候选/缺失原因，不能使用 observed-time 补足 01 的签发时间窗。

在 `docs/contracts/01-identity.md`「transcript 核验的封闭范围」与 06 的 SessionEvidence 引用处补入：

> LinkEvidence 是从公开记录抽取的未裁定锚点，不是绑定许可。tool_result 和 launch_message 分别保持原生调用或消息身份。启动消息核验必须唯一对应已有 link/run 的本轮 claim 指纹、launch_call_id、launch_correlation_id 和精确原生消息，并满足原事件时间窗、完整 SessionRef/source 和独立启动/会话证据；不能从首条消息、同一 claim 的历史复制或发现时间推定本轮。

职责划分：B4 定义并冻结本轮 fallback 消息的运输格式及 correlation，正常 env 路径仍不重复传明文 claim；B8 只抽取；B9 做既有关系的限定核验、候选/冲突投影。需要回填身份或撤销授权时，由 B2/B5 的 reconciler 事务入口提交，HUD/B9 的读取过程不成为新写者。

代码同步：`src/harness/claude/reader.ts` 的 `LaunchMessageAnchor` 现在只有消息 ID、linkId、指纹，必须从外层记录补入有效 eventAt，不能直接将旧缓存锚点强转为新类型；合格锚点进入共享 `linkEvidence`，移除其重复的权威出口。`src/harness/codex/link-evidence.ts` 和 Claude 的 tool-result 缓存使用 `Omit<ToolResultLinkEvidence, 'ref'>`，或明确的分布式联合映射；不能继续用会丢失联合专有字段的普通 `Omit<LinkEvidence, 'ref'>`。受影响 readerVersion 按 07 失效旧缓存。

**落实：**B8 修补共享类型和提取，A6 facade 配合编译调整；B4/B9 接线。**阻塞：**B9 的启动消息正向核验及 B4/B5 的 fallback 集成，不阻塞正常 env 运输和 Codex 主路径开发。定向覆盖本轮 resume 消息、缺事件时间、两份复制锚点、旧 claim、无独立证据和无现存 run；不新增 transcript 建关系路径。

### F02：cwdSource 增加 transcript

将 `SessionEvidence.cwdSource` 改为 `'session_meta' | 'transcript' | 'unknown'`。B8 有合格 transcript cwd 时返回 `transcript`，未知 cwd 仍为 null/unknown；不能把 Claude 记录伪称为 Codex 的 session_meta。来源时间沿用 06 的事件时间或明确的首次观测语义，重复读取不刷新。

在 06「WorkspaceContext 与项目归属」及概念 §6.4 明确：这是 reader 的位置来源类别，不授予身份、不触发 Git、不覆盖已经冻结的 launch_cwd。`claude.transcript.cwd` 可作为内部诊断细节，不再另立一份权威 cwdSource。07 已有 export v1 的 `transcript` 代码，无须扩展出口词表；内部来源到出口只做明确映射，不做字符串猜测。

**落实：**B8 与共享类型维护者；B9/B10 的 workspace 组装消费。**阻塞：**Claude workspace 来源正确投影，不阻塞 caller 识别。

## Q2：delegate.json envelope 与 callers.cwd

**裁决：追认。配置形状足够小，cwd 是两个不同对象的字段；补明确文字，不迁移 schema v1。**

### F03：冻结最小配置 envelope

在 `docs/contracts/05-capabilities.md`「LaunchProfile 与两种启动契约」和概念 §6.6.6 加入：

> delegate.json v1 的顶层为 `{version:1, profiles: LaunchProfile[]}`。profile.name 唯一；未知版本、未知键和不合格类型拒绝。每 profile 可选 `roles: Record<string,{model:string,effort?:string}>`。role/model/effort 解析后的实际值及非秘密档案指纹进入 02 的参数摘要；配置本身不授予已验证能力。资源约束不在本期格式内，不静默接收后忽略。

追认 B1 的文件 256 KiB、最多 128 个 profile 等有界校验；角色映射是数据，不是可执行模板或额外调度器。把 `DelegateConfig`、role 映射的权威定义收敛到 `src/core/types/capabilities.ts`，B1/B4/B11/B13 引用同一类型。Q4 的 `callSource` 是本轮明确批准的唯一附加可选键，见 F06；无此键的既有配置仍可解析，但不会自动获得 Claude 授权。

`managedShellVerified` 即使留在配置中，也只是配置提示，不能凭用户填写 true 将能力格变成 verified；B4 仍须检查 05 的版本/档案/已接受证据。缺角色映射时只允许已有明确配置或请求给出的值，不能根据角色名称猜模型。

**落实：**B1 修补，B4/B11/B13 消费；ORCH 修契约。**阻塞：**共同配置入口定稿和正式样例，不阻塞 B2/B3a。

### F04：区分物理 Caller.cwd 与会话 WorkspaceContext.cwd

在 01「身份、实例与定位」的 CallerId 行及紧随其后的 workspace 段补入：

> callers.cwd 是登记瞬间物理 MCP 进程自己的工作目录，成功登记时必须取得真实绝对路径。它是诊断提示，不是 harness/session 的工作目录、SourceId 或调用权限证据。无法取得时拒绝登记并返回 cwd_unavailable，不填 HUD_HOME、父进程目录或空字符串。会话 SessionEvidence/WorkspaceContext 的 cwd 无证据时为 null；不得拿 callers.cwd 自动补空。

追认 `packages/hud-mcp/src/registry.ts` 的 process.cwd() 路径；A4 `Caller.cwd:string` 与 02 `callers.cwd TEXT NOT NULL` 保持不变。06 的“不能填 HUD 自己的 cwd”约束的是会话 workspace，不禁止记录 MCP 自身的物理位置。

**落实：**ORCH 改 01 文字，B1/B2 保持边界并保留 cwd_unavailable 反例。**阻塞：**无新的实现阻塞；明确禁止 B2 为此改 DDL。

## Q3：trusted-local cancel/reconcile 与 authorizeControl

**裁决：追认独立管理边界；不扩张 authorizeControl 的 local_user resume 例外。一个随 run 存活的整组控制 helper 也在既有 04/06 允许范围内，不据此认定生产故障矩阵已经通过。**

### F05：明确本地管理主体及 writer 接线

在 04「取消与父断连」「写者与 RunHandle」，并在 01 的本地 resume 段交叉引用，写入：

> 受信本地 cancel/reconcile 的主体是同一 OS 用户对其私有 HUD_HOME/ledger 的管理权限，使用独立的 LocalManager（例如 `{kind:'trusted_local',uid,invocationId}`）。该类型只能由核验实际 UID、目录/账本所有权及私有路径的本地入口构造，并由 writer 的同一管理门禁校验；MCP/模型参数不能选择此分支。它只对固定 runId 的 cancel/reconcile 有效，不代表关系 OwnerKey，不转移 parent/child/owner，不授予 spawn/resume/report/predecessor 权限。

未完成 child/parent 绑定的 run 也可能需要取消或取证，因此管理权限**不要求已确认 parent_ref**。将这些操作直接加入目前 `authorizeControl` 的 local_user 分支，反而会错误继承 resume 的 parentRef/representedOwner 前置条件；若放松这些条件，又会扩大 resume。保持两个有名称的入口，共用实际 OS/私有路径校验实现即可。

`src/core/run/port.ts` 的 LocalManager/authorizeManager/acceptCancel 是合适的接线位置；`src/core/lifecycle.ts:authorizeControl` 的 local_user 仍仅允许 resume。B2 必须在真实 `RunFactPort` 中落实授权，不能把收到 `{kind:'trusted_local'}`、uid 数字或调用了某个函数名当作验证已经发生。B3a 当前 CLI 只检查 HUD_HOME，ledger/private-path 验证留给 adapter；此职责必须在 B2 接线时闭合。

管理审计使用既有 event 的白名单 payload，明确 `actor.kind=trusted_local`、实际 UID、invocationId、固定 runId/目标绑定代次；不伪造 representedOwner、父 CallerId/context 或 MCP tool_result。原有 local_user resume 的 actor 形状不变。cancel 在短事务接受原 run 的取消意图，后续信号仍检查完整范围和实例；重复取消不重置宽限时钟。reconcile 按 run/证据指纹幂等，提交前重验版本，只有 R/N/Q 等既有规则满足才迁移/释放，不能增加 force-release/admin override。

必要的一个 in-group helper 可作为稳定组控制机制，随 run 结束，不另起恢复服务；其进程数、寿命、CPU、RSS 和启动成本计入 P-06-1/3/9。仍需验证 leader 先退、helper 死亡、PID/PGID 复用、启动未封口和整组信号；本裁决不以“有 helper”替代这些证据。

**落实：**B3a + B2；B4 的 resume 不改权限。**阻塞：**真实本地 cancel/reconcile 接线验收，不阻塞 B3a 使用 fake port 的机制开发。定向增加未绑定 run 可管理、伪造 MCP admin/actor 拒绝、错误 UID/ledger 拒绝、固定旧 run 不影响新 run、重复 reconcile 不产生执行权的反例。

## Q4：Claude 调用来源与 Codex 原生子拒绝

**裁决：修改取证路径。选择“受版本/档案约束的同步 PreToolUse 精确记录 + 原有独立进程/source/当前性检查”，不选择等待 transcript，不把 env 或每会话 MCP 标签升为调用证明。追认目前 Claude direct 拒绝和 Codex 原生子拒绝。**

这是准许实现的架构路径，**不是宣布已有 hook 档案 verified**。现有探针只证明三个 hook 记录先于三个 tools/call；没有证明 hook 档案下的 /clear、跨实例事务、故障行为和可接受总成本。现有 B1 的拒绝在这些门禁通过前继续保留。

### F06：Claude 的唯一新增取证档案

01「身份、实例与定位」「SessionRef resolver 的证据边界」增加：

> Claude 2.1.305 的默认 direct stdio/public-transcript 路径不具备已验证的执行前根调用识别能力，保持无操作授权。新增的 claude_pre_tool_use_v1 路径必须从受信同步 PreToolUse 输入取得精确 tool_use_id、session_id 和可区分的原生 agent 来源，形成有界原子记录；MCP 使用本次真正的 params._meta["claudecode/toolUseId"]、精确配置服务器名/工具名、真实 ProcessKey/source 和当前 scope 前提交叉核验。任何缺失、歧义、冲突、旧代或不受支持的版本均先拒绝，不查询幂等结果、不消费 claim、不执行工具。

05 的 LaunchProfile 与 B1 严格校验器增加可选 `callSource: {kind:'claude_pre_tool_use_v1'}`，只对 Claude 合法。未设置的 Claude 仍是旧拒绝档案；显式设置只是选择机制，能力仍须按版本、hook 实现修订和完整档案指纹验收。此次不增加通用插件化身份框架。

机制边界如下：

1. **安装与范围。** 由启动档案/B11 `hud claude` 通过本轮 CLI `--settings` 注入同步 command hook，仅匹配精确配置服务器下的七个 HUD 工具。不全局安装、不覆盖用户其他 hooks/MCP 配置、不对所有 Shell/Read 等工具运行。CLI 注入、已有 hooks 共存与 hook 真正同步执行是该档案的验收条件；关闭或加载失败就没有这个能力。
2. **最少记录。** 仅保存格式/实现版本、ledgerId/档案指纹、经核验的 ProcessKey/source、toolUseId、完整工具名、sessionId、明确的根/原生子分类及 agentId、当前 scope 的读取前提和证据时间/指纹。不要原样落盘 hook stdin；tool_input、claim、prompt、transcript 正文均不进记录。transcript_path 至多用于限定核验，不能用来判断根，因为实测子调用也给根路径。
3. **来源与当前代次。** helper 的实际启动链必须匹配同一已核验 harness 实例；固定配置和继承 env 只能定位本轮记录空间，不能独立证明调用者。hook 在发布前通过 B2 只读入口取得该 ProcessKey 的当前 scope generation/ref，或明确的“尚无当前 scope”比较前提，将其绑定进记录。MCP 不得在读取旧记录后临时换上更新的 generation。这样旧 A 的记录不能在 A→B→A 后冒充第三代的新 A；原生 SessionRef 相同不等于调用代次相同。此处只有索引读取，不给 hook 运行意图、claim 或绑定写权限。
4. **有界原子发布。** 使用私有目录/0600 文件、精确键、不可覆盖的完整发布，记录上限 8 KiB；键至少隔离 ledgerId、ProcessKey、配置服务器及 toolUseId，字段再次核对档案/工具。不存在、半写、重复发布冲突、错误 source/实例均拒绝，不能 last-wins。MCP 只做精确有界读取；清理依托现有调用/退出路径的限额工作，不加目录轮询器或常驻服务。未产生 tools/call 的孤儿记录不触发工作。
5. **它证明什么。** 合格记录证明该 harness 在本次精确 HUD 工具调用的执行前，报告了哪个逻辑根/原生子来源；与实际启动/source 核验合用，才可进入现有 context 选择。它不证明 link 所有权、run 身份、claim 有效性、报告权限或运行结束；01–04 的后续门禁全部保留。

缺记录时 MCP 必须独立拒绝，不能假设 hook 非零退出一定使 harness 阻止调用。若拒绝发生，迟到记录不会自动重放这次工作；调用者只能用新的、重新取证的工具调用重试，同一控制意图保持原 request_key。

代码落点：B1 的 `packages/hud-mcp/src/resolvers.ts` 增加该窄来源实现，使用现有 `CurrentCallSourcePort`；配置和记录发布 helper 仍属于 B1 补充包。共享 `LaunchProfile`/B1 validator 同步 F03。B4/B11 只负责启动注入与档案选择，B2 提供 scope 只读快照和原有事务围栏，B5 负责授权接线。无需新 ledger DDL。

### F07：原生子、会话切换与两个 MCP 的事务规则

将以下文字纳入 01 的 I-01-2/10/12、T-01-4/5/27/33/35/36，以及 02 的事务前提/相应并发测试：

> 原生子调用只拒绝本调用，不建立 root context，不兑换根 claim，不关闭根 scope/alias，不触发根 generation 变化。可信根来源变化才由同一 reconciler 事务关闭旧 scope/context/alias 并撤销旧授权。选定本调用来源所依据的 scope generation、证据版本、context 及目标 run/binding 前提，在查幂等或写入时仍须匹配；过时前提返回 stale_context/identity_unverified，不能重贴新代次。

具体处理：

| 情形 | 必须行为 |
|---|---|
| Claude 根/原生子共享一个 MCP | 以本次 hook 的 agent 来源区分；子携带根 sessionId、根 transcript_path、env/claim 都不能变成根。缺少版本保证或字段矛盾时拒绝；不能笼统把“agent_id 未读到”解释为已证明根。 |
| Claude /clear 保持 PID/start/MCP | 新根的合格 hook 与当前 sessions 记录匹配后，以捕获的旧代次为 CAS 前提换代。已进入的旧 spawn/report 在提交时失败；过时 receipt 不得倒切回旧会话。缺当前 registry 或矛盾时拒绝，不轮询等它追上。 |
| 同源同根两个 MCP / MCP 重启 | CallerId 不同，逻辑 OwnerKey 与未关闭 process generation 相同；通过共享 B2 事务连接/重建 context，不能各自创建“当前根”或重复兑换。并发首次建代中 CAS 失败的一方可拒绝并要求新调用，不凭旧证据盲重试。 |
| 新旧会话的 MCP 同时绑定 | 新会话一旦已提交换代，任何旧实例的已选上下文/旧记录均不可复活；仅物理 MCP 启动较晚不构成换代。旧操作若已在合法旧代 durable accepted，保留原意图并依既有票据登记/提交重验，不能伪称从未接受或另起副本。 |
| Codex 原生子另起一个 MCP | 0.166.0 子调用的 sessionId 仍是 root，而 threadId/turn.thread_id 指向 child；有 parent_thread_id/subagent 来源，必须拒绝。单独 MCP 和相同 harness PID 都不例外；不调用 HUD 的 rootThreadOf 视图投影来授权。根后续调用仍可逐次验证，不受子拒绝污染。 |

Codex 的根正向路径继续要求 genuine metadata 各字段一致、root thread/source 条件、精确 rollout header、实际 source/进程实例及受支持版本。不能把这次结论推广到任意版本、daemon/shared 或每线程正向调度。

B1 目前 `currentRef/invalidated` 只是诊断实例内状态，不能成为 B5 的跨实例代次权威，也不能让一次合法 /clear 后的新根在同一 MCP 内永久不可用；接线后由 B2 的 scope/current-context 事务作权威。本调用携带前提，外部取证在事务外，锁内重验，不能为了修 race 把文件或 /proc 读取搬进写事务。

### F08：hook 成本与放行条件

修改 06 P-06-4 的测量说明并在 05 记录该档案的额外门禁：

> 原有 tools/call 完整到达至响应 flush 的非 wait p95 <50 ms 门槛不变。若 HUD 为授权增加同步前置 hook，必须另以同一次调用从该必需 hook 启动到 MCP 响应 flush 的联合样本证明 p95 <50 ms，计入 helper 冷进程、scope 读取、发布、harness 调度间隙、MCP 核验及 DB 等待；不能移到 tools/call 前就从成本中消失。逐工具区分成功、拒绝和 busy，不能相加两个独立 p95 或只测快速拒绝来宣称通过。delegate_wait 仍按其既有等待预算处理，前置成本单列。

现有事实的解释：

| 路径 | 已有成本/证据 | 本裁决 |
|---|---|---|
| transcript 即时或有界等待 | handler 入口缺记录；两次在标称 10 ms 采样可见，一次到标称 45 ms 仍缺，标称 100 ms 才见。实际采样还包含读取/调度开销。 | 不选。45 ms 等待没有可靠可用性且耗尽预算，100 ms 直接超限；不扫描全文、不加后台追赶授权。 |
| 当前 Node command hook | 200 次合成离线启动，p95 61.433 ms，max 63.578 ms，尚未加 harness 调度和正式工具处理。 | 不放行这个实现。3 个 hook 的 10/10/11 ms 是“写记录到 handler 的领先量”，不是 hook 总成本。 |
| 选定的轻量同步 hook 档案 | 正确性机制有窄探针依据，生产 helper 总成本尚未测得。 | 只准有界实现/验收。必须降低实际启动成本；不预断换语言、换可执行文件即可达标，不引入常驻 hook 服务来掩盖成本。通过前仍 unverified。 |
| 当前无档案 skeleton | 最终 whoami 快拒绝 p95 0.353 ms；30 次冷启动 p95 72.138 ms。 | 仅证明 skeleton 成本，不证明 hook、成功授权或 B4/B5 已通过 50 ms。 |

**B4 必测：**parent Claude 在显式 hook 档案下 delegate_spawn/resume 的 durable accepted；已有配置/hooks 保留；确切 claim/HUD_HOME 注入仍正确；成功/拒绝均不重复提交；旧来源取证后等锁，另一调用 /clear 换代，旧意图不能新提交；已接受后的源变化仍走原票据/对账规则。禁止把 config/env/message claim 当 hook 缺失的替代来源。

**B5 必测：**根→原生子→根的 whoami/report；根 claim 被原生子持有；缺失/晚到/半写/重复/不匹配记录；错误版本/source/boot/start/server/tool；/clear 时旧 spawn/report 在途；A→B→A 旧记录重放；两个 MCP 同根并发首绑/重绑与新旧会话同时绑定。验证根代次不被子拒绝污染、旧授权撤销、claim 不重复消费、既有 run/child_ref 不被改写。将 Codex root/child/root 的真实拓扑和原生子拒绝纳入同一测试矩阵。

**B14 必测：**对选择的具体 Claude 版本、hook 实现及启动档案重做 A9 四种来源场景，配合 B2/B5 真事务；“两个服务器连接成功”不等于“两边授权正确”。按 06 已定样本/并发/环境要求逐非 wait 工具测正式成功与拒绝路径，补上述联合时间；报告 hook 进程/写入量，空闲时无额外轮询/服务；分别统计 accepted→started/bound/ready 的未达到数和延迟。真实 harness 的样本数单列，不能把合成 1000 次伪称 1000 次真实 harness 试验。

**落实与阻塞：**F06/F08 由 B1 补充包承担来源/helper/预基准，B2 提供现有 scope 接口；F07 由 B2/B5 落事务，B4/B11 接启动，B14 收证。它们阻塞 **Claude 发起的 B4/B5 正向闭环与原 cc → Codex 的 B15 放行**，不阻塞 B2/B3a、Codex 单独闭环和 B8/B9 的只读观测工作。若轻量 helper 仍不达标，ORCH 带具体结果向 Pro 申请调整 MVP 或性能标准；本轮不作该产品范围决定，也不继续平行试建多套身份机制。

## Q5：未完成尾行、持久 checkpoint 与恢复预算

**裁决：追认 B8 不落 raw tail 的方向，并要求 A4 helper、A6 facade 及其底层 RolloutParser 一并修改。只在 B12 序列化前清空数组会丢数据，不合格。**

### F09：所有持久 checkpoint 都只保存可恢复元数据

替换 06「Reader、coverage 与树」中容易被理解为允许持久化尾字节的文字，并在 01 的 evidence 隐私边界、06 ObservationCommit/I-06-2/5、07 checkpoint 版本策略交叉引用：

> 未完成记录的原始字节只可存在于单个 live reader 的有界易失缓冲，至多 maxRecordBytes；不得进入 ReaderCheckpoint、ObservationCommit、summary、日志、临时 bundle、嵌套 binary/base64 payload 或持久 token/parser state。普通未完成记录的持久 offset 留在最后一个已完成记录边界，恢复时从原 source 重读；摘要、去重、工具配对和时钟也只反映该已完成边界。超大记录保存 discarding 标志及可继续推进的丢弃游标，记 oversize_unknown/gap，不保存正文、不每 tick 从超大行开头重扫。

保留 schema v1 的 `pendingBytes` 兼容字段时，它必须恒为 `[]`；明确区分可序列化 checkpoint 与不可序列化的 transient buffer。不要把 raw bytes 改名、编码或放入另一个 adapter extension。discarding 状态必须知道下一次从哪一字节继续；只有一个 start offset 而无法前进的实现不满足有界恢复。已到 EOF 的不完整行保持 partial/incomplete_tail，不能因 pendingBytes 为空而误报 complete。

修改文件与必要关系：

- `src/core/types/observation.ts`、`src/core/observation.ts:readJsonlBytes`：持久态不接收/产出 raw tail；正常 offset 与已处理完整记录对齐，活 reader 可有独立 transient 参数/状态；超大行丢弃能跨 slice 和重启推进。
- `src/collectors/rollout.ts` 的预算读取路径与 `src/harness/codex/index.ts`：必须一起改。实际 A6 并非直接调用 A4 的 readJsonlBytes；它从 RolloutParser 的 readStats.state 取到 pendingBytes，再作为外层 checkpoint 返回。底层 offset、导出的 rollout.offset、facade offset、摘要/时钟须指向同一提交边界；不能只清外层数组而保留已经跨过尾行的 offset。V8 payload 也不得暗藏尾字节。
- `src/harness/claude/reader.ts`：追认现有 durable offset、空 pendingBytes、易失 transient、discardOffset 方向；统一契约/返回类型并移除待裁决标记，不要求重写整套 reader。
- B12 发布入口拒绝不满足此约定的 checkpoint，原子提交仍携带一致 summary/continuity/notices。修改语义的 readerVersion 必须递增；旧 raw-tail checkpoint 不直接继续、不只删字节后保留旧 offset。最小处理是按 07 受控失效/重建该 source 缓存并显式重置连续性，由 collect lease 围栏提交；若已经存在含 raw tail 的旧缓存及其未发布 bundle，在该受控缓存更新中删除/替换，不能只标无效后永久保留原件。不改 ledger schema/user_version，不启动全库迁移服务。若实际改变公共 checkpoint 的不兼容结构，则另升 checkpoint schema，不能借 ledger schema v1 掩盖版本差异。

**落实：**ORCH 安排一个拥有 A4/A6/RolloutParser 路径的窄修补包，与 B8 协调；B12 加发布门禁。**阻塞：**B12 接入 Codex checkpoint 持久化，以及 B16 的可靠恢复验收。不能拖到 D2 才修隐私语义；D2 的完整迁移框架仍可延期。

### F10：重读一条记录的预算与共享 continuation

在 06「Reader、coverage 与树」、P-06-7、T-06-3/4 及 B16/B10 的公平续读条件中写入：

> 重启或易失缓冲丢失后，reader 必须有机会在一个 slice 内从最后提交边界重读一条最大合法记录。maxRecordBytes=1 MiB 按 LF 前的全部字节计，包含 CRLF 的 CR；因此有 LF 的最大合法记录消费 1 MiB+1 字节，无 LF 的固定 EOF 完整 JSON 至多 1 MiB，均还须预留本轮实际需要的签名检查等 I/O。所有重读、读后未处理的预取、签名及恢复读取均计入本 slice 和全 tick 预算。预算不足时返回类型化 record_needs_larger_slice/minimumBytes 和 partial coverage，不悄悄增加预算、不提交半行、不忙循环。

将 B8 的 `continuation?: {kind:'record_needs_larger_slice',minimumBytes:number}` 提升到 `src/core/interfaces/harness-adapter.ts:ReaderResult`，A4/A6/B8 共用。minimumBytes 必须覆盖该实现恢复所需的实际字节数，不能总写 1 MiB 而漏掉 newline/签名，也不能将软时间预算耗尽误说成单纯字节不足。

B16/B10 可在同一 live reader 中保留 transient buffer；若本 tick 剩余预算不足，下个公平轮次给它足够的一条记录 slice，并从共享 8 MiB/总 deadline 中扣除。不要把每个 reader 的 20 ms 相加；也不要每 tick 都重建 reader、始终给小碎片而让合法大记录永久饥饿。没有足够剩余时间时正常让出并续读；完整记录解析是不可抢占步骤，实测超时仍计入软预算缺陷，不承诺硬实时。

B8 的既有 10 次合成 1 MiB + newline 重启读取，每次一 slice、约 4.228–15.025 ms，证明默认预算下此办法有可行性；不证明缩小到任意 slice 也能恢复，更不代替 A6 修改后的测量或 200 节点共享 tick 验收。

定向验证：在 UTF-8 多字节/CRLF 中间、私有 api-request-blob 中间、fallback claim 中间崩溃；重读后提取和 usage 去重与完整读取一致且序列化产物无敏感哨兵；最大合法记录含界符/签名成本；超大无换行跨多次重启仍有界丢弃且只计一次 gap；预算不足给 continuation，下一次足量 slice 前进；file reset/compaction 时不把旧 transient 接到新谱系；复读不刷新事件钟。B12 同时验证 checkpoint/summary 原子一致，复用既有相关用例，不重跑无关全矩阵。

**落实：**F09 修补包 + B8 + B12/B16/B10。**阻塞：**恢复与共享调度的最终集成验收，不阻塞 reader 之外的执行闭环。

## Info：B8 transcript 完整性边界

**裁决：追认 append-only-between-observed-resets 的有限假设；修改契约表述，禁止将有限签名称为全历史完整性证明。**

### F11：记录有限检查的保证范围

在 06「Reader、coverage 与树」/I-06-2 补入：

> 增量 reader 假定两个已观测 reset 之间 source 追加写入。inode/设备变化、缩短、已检测的非增长改写或已消费边界签名失配触发明确 reset/sourceGeneration 变化。有界首/末已消费记录签名只能发现其覆盖区域的变更及部分常见替换，不证明任意历史内部未变；对保持这些样本不变的内部改写没有检测保证。coverage.complete 仍仅表示在该读取模型下覆盖本次固定输入边界，完整性假设及其限制须在诊断中可见。

保留 B8 的 `append_only_assumed_bounded_signatures` 说明；不为这个已声明限制要求永远 partial，也不引入逐 tick 全前缀重哈希、Merkle 索引或新后台校验器。检测到 reset 后，旧 reader 锚点/摘要不能被当成新谱系当前证据；01 的精确本轮绑定核验和独立身份条件仍成立，“没有发现改写”不能用来授权 MCP 调用。原生 source 未来不满足该读取模型时应回到 unverified/明确缺口，而不是扩大现有保证。

**落实：**ORCH 改 06，B8 保留诊断，B9/B12/B16 正确处理谱系失效。**阻塞：**无新的机制阻塞；这是可接受的、必须公开的观测限制。

## 必须改的契约条目

下表的 11 个 F 编号是本轮必改计数；每项包含文字、相应类型/接线及受影响的定向验收，不按文件数重复计数。已冻结契约须由 ORCH 记录本次增补和生效版本，不把本裁决混称原冻结内容。

| ID | 契约、章节或既有 ID | 必改内容 | 落实 WP / 阻塞范围 |
|---|---|---|---|
| F01 | 01 transcript 封闭范围、I-01-5、T-01-14–16；06 SessionEvidence；概念 §6.4/6.7 | launch_message 观测联合、真实事件时间、消息/correlation/run 唯一核验；B9 不写账本 | B8/A6 类型修补、B4/B9、B2/B5；阻 fallback 正向核验 |
| F02 | 06 workspace、I-06-11；概念 §6.4；07 既有来源表引用 | SessionEvidence.cwdSource 增 transcript；位置来源与身份/历史启动分开 | B8、B9/B10；阻 Claude 来源正确投影 |
| F03 | 05 LaunchProfile、I-05-1/2；02 参数摘要引用；概念 §6.6.6 | version/profiles envelope、可选 roles、严格键/唯一名称、共享权威类型、配置不自证能力 | B1/B4/B11/B13；阻正式配置接线 |
| F04 | 01 CallerId 表/workspace 段；02 callers DDL 解释 | Caller.cwd 是真实物理 MCP cwd，取不到拒登记；会话未知 cwd 仍 null | B1/B2；文字澄清，无 DDL 变更 |
| F05 | 04 本地取消/写者、T-04-41；01 local_user 交叉引用 | trusted_local cancel/reconcile 独立门禁与审计，不继承 resume 的 parentRef 条件 | B3a/B2；阻真实本地管理接线 |
| F06 | 01 Claude resolver/I-01-2/10；05 档案/能力证据 | 显式同步 hook 档案、精确记录、scope 前提与私有有界发布；未验证继续拒绝 | B1 补充、B2/B4/B5/B11；阻 Claude 正向操作 |
| F07 | 01 I-01-2/10/12、T-01-4/5/27/33/35/36；02 短事务前提 | 原生子只拒自身；共享账本换代/重启连续/锁内重验；Codex 子不投影 root | B2/B5/B4；阻跨实例身份与原 MVP 放行 |
| F08 | 06 P-06-4/1/9；05 档案验收；B14 条件 | 前置 hook 的联合 <50 ms 门槛、真实四场景；当前 61.433 ms Node 实现不放行 | B1/B4/B5/B14；阻 hook 能力升 verified；失败需 Pro 决定范围/预算 |
| F09 | 01 evidence 隐私；06 reader/ObservationCommit、I-06-2/5；07 checkpoint 版本 | raw tail 仅易失；持久 offset/摘要一致；A4/A6/RolloutParser 修复与版本失效 | 窄修补包、B8/B12；阻 Codex 持久发布 |
| F10 | 06 reader/P-06-7/T-06-3/4；B16/B10 公平续读 | 一记录恢复 slice、真实 I/O 计费、共享 continuation、公平预算，杜绝永久饥饿 | 修补包、B8/B12/B16/B10；阻恢复/共享 tick 验收 |
| F11 | 06 reader/I-06-2；01 精确核验交叉引用 | append-only 假设、有限签名保证及 reset 失效，不声称任意历史不可变 | ORCH/B8/B9/B12/B16；文档与消费者语义收口 |

## 可删或推迟

| 项目 | 处理与 G13/G14 理由 |
|---|---|
| Claude 逐调用 transcript 延迟采样、全文查找、后台 flush 等待器 | 删除生产正向方案。已有证据不保证 50 ms 内可用，新增轮询只增加延迟和复杂度。精确 transcript 核验仍供 B8/B9 的事后观测使用。 |
| env claim、per-session 标签或新 MCP PID 作为根来源替代证据 | 删除授权分支；均不能区分本次原生子或 /clear。运输与物理登记继续保留。 |
| 常驻 hook daemon、独立来源索引服务、每调用大型 Node/完整 HUD 模块图 | 不加入本轮。先验收一个短命且有界的 helper；若成本不成立，上送产品决策，不为躲预算扩充进程体系。 |
| Claude/Codex 原生子正向委派、通用 shared 多 context 调度 | 继续后续能力。MVP 只需精确拒绝子调用并保留根的后续可用性。 |
| 资源约束 DSL、通用身份插件框架、另一套 local admin 所有权 | 不加入 v1；现有 profile/作用域/固定 run 管理入口足够。 |
| 可持久化 token parser、尾字节编码/加密缓存、逐 tick 全前缀校验 | 不实施。单记录重读与易失缓冲满足恢复；有限签名的保证应诚实限定。 |
| 所有 reader 统一重写、完整 checkpoint 迁移框架 | 只修受影响的 durable 语义与版本失效；完整策略仍在 D2。不能借延期保留 raw tail 漏洞。 |
| 为本轮重开 A9、重跑全部已通过原型/全部 harness 矩阵 | 不要求。补本轮来源、权限、缓存及性能相关证据，B14 按已经改变的能力格汇总。原有 supervisor/scope 的生产必测项并不因此取消。 |

## 你核实过的事实

本次只查阅文件和已有证据，没有运行测试、启动 harness、执行新探针、调用其他模型或派生 agent，没有 Git 写操作。唯一写入文件是本答复。报告中的历史测试通过数和性能结果只作为其原记录的结果，不声称由本次重新执行。

| 查阅文件/只读命令 | 本次实际核实到的结论与限制 |
|---|---|
| `cat tmp/tasks/ORACLE4/{role,brief,queue}.md`；`git log -8 --oneline` | 任务范围、五问及追加 hook/tail 信息明确；主 HEAD 为 24c50fb，B1/B8 已合入。B3a 工作树观察不代表其最终提交。 |
| 分段 `sed`/`rg` 查阅 `docs/contracts/01-identity.md` 至 `07-outbound-compat.md`；概念 §6/§15；工程计划阶段 B/B14 条件 | 01 已允许本轮 launch-message 核验；Caller.cwd 的非空 DDL 与 06 nullable session cwd 是不同语义；04 已明确本地 cancel/reconcile；05 的 Claude 受委派后端 C 排期不取消 B 的 cc 父调用者；06 的原 P-06-4 起点确为 tools/call，前置 hook 成本需单独补门。 |
| `docs/reviews/2026-11-01-astra-contracts.md` §1–3；`astra-consult2.md` §3/D04/D05；`astra-consult3.md` §3/E03 与裁决索引；`2026-11-01-chatgpt-pro-a9-gate.md` | 不扩展 shared 正向、本地 resume 例外/显示复制边界、07 来源词表及 A9 四种真实来源条件，均须延续。 |
| `tmp/tasks/B1/report.md`、`docs/probes/b1-call-source.md`；B1 `config.ts/registry.ts/resolvers.ts/process.ts/server.ts` | 配置严格 version 1；登记实际 cwd；Claude 正向始终拒绝；Codex 检查 thread/source/header；真正工具尚为 stub，currentRef 是实例内诊断缓存。没有把 source ok 或 not_implemented 当授权成功。 |
| 对 `tmp/tasks/B1/evidence/cc-hook-root-child/{hooks,mcp}.jsonl` 用 `jq -s` 按 tool_use_id 与真正 metadata join，只输出时间差/分类布尔值 | 三个领先量确为 10/10/11 ms；中间为 native child；三者 session_id 与 transcript_path 相同。因此根路径/根 session_id 不能替代 agent 来源判别。 |
| 对 `evidence/wait-cc-root-child/mcp.jsonl` 用 `jq -s` 按 callId 汇总 phase/匹配数和相对时间 | 入口三次均无匹配；两次标称 10 ms 采样已有匹配，一次标称 45 ms 仍没有、100 ms 才有。实际相对时刻约为 12–13/51–52/108–109 ms，不能把采样标签当精确等待耗时。后续宽匹配还会含工具结果，不能据匹配数 2 宣称自然发生了重复 assistant 调用。 |
| 对 `evidence/codex-root-child-v2/mcp.jsonl` 用 `jq -s` 仅投影 root/thread 是否相同、thread_source、parent 字段和 MCP PID | root/child/root 分别是相同根 MCP、另一个子 MCP、原根 MCP；子 thread 不等于根 sessionId，有 subagent/parent 字段，版本为 0.166.0。只证明该版本/拓扑。 |
| `jq` 查 `evidence/hook-performance.json`、`performance-final.json` | Node hook p95 61.433326 ms / max 63.577572 ms；skeleton 30 冷样本 p95 72.13835 ms、200 调用/方法，whoami 拒绝 p95 0.352876 ms；该 benchmark 自述 default unconfigured，不能作正式来源/工具基准。 |
| `src/core/interfaces/session-evidence.ts`、`src/harness/claude/reader.ts`、`src/harness/codex/link-evidence.ts` | LinkEvidence 仅 tool_result，cwdSource 仅 session_meta/unknown；B8 launch anchor 缺 eventAt，且只在本地出口保留；旧 Omit 类型需随判别联合调整。 |
| `src/core/lifecycle.ts`；B3a 工作树 `src/core/run/{port,control,cli}.ts` | authorizeControl 的 local_user 仅 resume；B3a 独立 trusted_local port 符合旧 04 方向，CLI 显式将 ledger 路径授权委托给 adapter，不能提前视为 B2 接线已验证。未以读取草稿代码代替 helper 的生产试验。 |
| `src/core/{types/observation,observation}.ts`、`src/harness/codex/index.ts`、`src/collectors/rollout.ts` | A4 helper 持久 pendingBytes；A6 从 RolloutParser.readStats.state 接收 raw tail 并随外层 checkpoint 导出；底层序列化 payload 虽已清该数组，不能消除外层泄漏。故只改 A4 或发布时清空均不足。 |
| B8 report、reader 的恢复/签名/返回分支；`tmp/tasks/B8/evidence/accepted-final-9.log` | B8 持久 pendingBytes 强制为空，已有易失缓冲、discardOffset、有限签名和 record_needs_larger_slice；已有最大行重启日志保存 1,048,576 记录字节、1,048,577 文件字节、offset 0、持久尾长 0。其可行性结果可复用，A6 与共享调度仍需定向验收。 |

没有需要阻塞本次裁决的事实问题；上述未验证能力均以明确门禁留给相应 WP，不发送问题或等待编排者补充。
