# ORACLE3：A4/A5 后六处分叉裁决

评审基线：首轮开始核对时 HEAD `c4c0950`；A4a 核心类型与纯函数、`f8008e5` 的隔离 A9 原型；契约 01–04 v0.4、05–07 v0.2。期间另一写入者提交 A5 `a7aa3a6`，未改首轮五问涉及的文件。本次按 `queue-next.md` 追加该提交中 SessionBinding/SurfaceLocator 的窄设计裁决为第 6 节，不作完整 A5 实现验收；E01–E05 的裁决不变。沿用前两次裁决的身份、单次执行权、运行槽、独立观测存储及 G13 边界。本次是设计裁决，不是代码全面审查或 A9 放行。

**必须修改 6 项契约（E01–E06，一项跨文件同步只计一次）。追认 session/intent 判别联合与按事实时间约简；将“结束已证实、取消先后未知”改为 ended 加说明；冻结按字段区分的导出代码表；逐 run 导出已有的 operation；新增观测绑定边界，分开 occupantGeneration 与受管 bindingGeneration。无需新表、常驻进程、模型调用或新的外部控制服务。**

## 1. StateContinuity 与 intent 的 sourceGeneration

**追认。session 分支携带真实 sourceGeneration；delegationIntent 分支禁止该字段，不能填 0、null 或借用 bindingGeneration。**

sourceGeneration 是 reader 的读取谱系，不是所有记录都应拥有的通用版本。未绑定意图由 ledger 的 link/run/events 支持，已有稳定身份和时间依据。为满足一个扁平类型而捏造采集代次，会把显示连续性、采集写权和绑定代次混在一起，违反 D01、D11、D12。

**E01 — 修改 `docs/contracts/06-observation.md`「B16 的五维输入与消费者字段」的输入证据及 StateContinuity 定义；同步「checkpoint 一致提交与 collect lease」、I-06-12/13 与 T-06-25/27/28。建议直接写入：**

> MVP 的 ObservationEvidence 区分具有 ref 的 session 证据与 `origin:'ledger'`、具有 nodeIdentity 的 delegationIntent 证据；StateContinuity 按 nodeIdentity 判别。session 使用完整 SessionRef 和真实 sourceGeneration；无受管 run 时 runId/bindingGeneration 可缺省。delegationIntent 使用 `{kind:'delegationIntent',linkId}` 和当前运行标识（ObservationEvidence.currentRunId、StateContinuity.runId）；不得包含 ref/sourceGeneration，不建立 collect 租约或伪 ObservationCommit。这两个运行字段必须对应本次 ledger 快照的 currentRun，绑定代次如携带则取该 run 的真实值。
>
> StateContinuity 的公共字段仍为 ruleVersion、episodeAnchor、stateKey、stateSince、stateSinceBasis；sourceGeneration 仅在 session 分支必填。intent 用 linkId、runId、规则版本和 ledger 事件锚点判断连续区间。ledger 的 asOfSeq 用于快照一致性，不冒充 sourceGeneration，也不因无关事件增长而重置区间。
>
> intent 首次绑定为 session 时，选择键合并本身不证明连续性。只有 link→真实 ref、同一 run 和同一 episode 的证据齐备，才可采用原 ledger 进入事件的时间；session 记录随后携带自己的真实 sourceGeneration。不能复制一个虚构代次或仅因 stateKey 相同延续时间。证据不足按既有 observed/unknown 规则处理。Job 连续性留 C 阶段，不由本条推定其拥有 SessionRef 采集租约。

**代码影响：**保留 `src/core/types/observation.ts` 的判别联合、`ObservationEvidence` 的 `origin:'ledger'` 分支和 `sourceGeneration?:never`；将 intent 的 `StateContinuity.runId` 收紧为必填，session 分支仍可选。`resolveStateContinuity` 现有身份/代次/episode 比较无需换算法；移除待裁决注释。现有 job 类型只作未来占位，不增加正向实例或存储。

**A9：**这是类型和文字对齐项，不增加进程原型门。复用 T-06-25 的“intent 无 sourceGeneration”断言；在 T-06-27/28 补同 link 换 run 必重置，以及绑定时有/无同 episode 证据两组即可。B12/B16 的生产持久发布仍留原阶段。

## 2. R/Q 已证明结束，取消先后未知

**修改。推翻“仅因取消时序未知而继续 uncertain/持槽”的默认；应为 ended，释放槽，保留 `cancel_timing_unknown` 说明。unknown 不改写为 C=false。**

槽保护的是“旧工作可能仍执行或再次提交”。完整 R/Q 已证明固定 scope 无活 workload、原 harness 不执行且所有启动者封口；取消是否早于实际结束只影响结束分类。继续持槽既不能提高隔离安全，也未必能取得已经丢失的历史时序。它与前次裁决“结束已知、原生退出结果未知仍可终结”的原则相同。

ended 表示已结束，不承诺自然退出、成功或“取消没有起效”。cancelled 才要求已接受取消先于结束的正向证明。取消意图存在、发过信号、回执较晚到达、`cancel_requested_at < ended_at` 均不单独构成该证明；04 的 ended_at 是终结观测时间，不是精确实际退出时间。

**E02 — 修改 `docs/contracts/02-execution.md`「证据定义与完整对账表」的 C 定义、R-02-2/3、I-02-7 及「取消、等待与禁止重试清单」；同步 03「Run 状态与合法组合」「status 与 HUD 可读投影」、04「取消与父断连」和 T-02-13/15、T-04-24/26。精确规则如下：**

> 取消请求是否已鉴权接受与取消相对结束的 chronology 分开。chronology 为 before_exit / after_exit / unknown；unknown 不等于 false。X 的优先级不变。无 X 且完整 R 或 Q 成立时，只有已接受取消且 chronology=before_exit 才命中 R-02-2/cancelled；其他情况命中 R-02-3/ended，均在终态事务释放槽。已接受取消但 chronology 缺失或 unknown 时，同时记录 terminalNote=cancel_timing_unknown；不得声称 cancelled 或 already_ended。after_exit 已证实时才可把该取消请求解释为 already_ended。
>
> 未成立 R/Q/N 时，取消仍为 cancelling/uncertain 并持槽；scope 不明、未封口或 X 不受本例外放行。历史取消通道失败本身不否定后来完整的 R/Q。N 仍按 R-02-4 产生 failed(non_execution)。terminalNote 只说明终态分类时的证据缺口，不表示阻断冲突，不改变共享终态谓词或其他 resume 门禁。若 before_exit 与 after_exit 两个互斥的已知证明同时有效且未解决，则按同实例证据冲突 X 处理；只有 unknown 不构成这种冲突。

替换后的两行可直接采用：

| 行 | 条件（仍按原表首条命中） | 结果 |
|---|---|---|
| R-02-2 | A，X=false，R/Q 成立，取消已接受且 before_exit 已证明 | cancelled；终态事务释放槽；原生结果仍可 null |
| R-02-3 | A，X=false，R/Q 成立，未满足 R-02-2 | ended；终态事务释放槽。取消已接受而时序未知时附 cancel_timing_unknown；只有已证明 after_exit 才附 already_ended 的取消解释 |

在 02/03 补一条存储/投影约束：

> `terminalNote:'cancel_timing_unknown'|null` 随既有终态事件的白名单 payload 保存，status 对返回的那个 run 投影此说明。它不是 Reconciliation.cause，不生成待人工解除的阻断，不新增 runs 列。R-02-0 保留既有终态与原结束决定；迟到时序证据只追加说明/审计，不自动 ended→cancelled，不重新占槽或再次发完成事件。未知时序说明描述的是当时分类依据，不能被解释为已证明取消先后。

**代码影响：**`src/core/execution.ts:241` 附近改为上述 R-02-3 分支；`ReconcileDecision` 增加 nullable terminalNote，普通分支为 null；03 的状态类型/后续读取投影按同名字段传递，不能复用 `cancel_unconfirmed` 把已结束 run 标回 uncertain。取消时序也不能用 append-only 数组的第一个 `cancel` fact 决定：unknown 不是不可升级的结论，有效已知证明可补足它；互斥的已知证明按上述 X 处理，不能按输入顺序挑选。04 最终 receipt 原 reason 继续描述已有 scope/native 事实，不为补注释重写 exit.json。

**A9：阻断当前原样冻结。**A4a 的 T-02-13 与 A4b 的 T-02-15 都实质选择了旧默认，不能只改文档并沿用旧 PASS。需更新 `tests/prototypes/a9/common.mjs` 的判断及 `execution.mjs` 中 `cancel-order-unknown`、`cancel-write-lock-exit` 的断言：当 R/Q 完整时为 ended/释放/说明未知，绝不伪造 confirmed 或 already_ended。保留“取消后确证仍活，随后结束→cancelled”和缺任一 R/Q 条件仍持槽的反例；对共享恢复 helper 覆盖 T-04-24。只重验受影响的合成用例并更新报告，不重跑无关真实 harness/A8 矩阵。

## 3. export v1 的原因与 cwdSource 词表

**修改。追认未知字符串收敛为 null 和禁止自由诊断透出；将当前“凡契约某处提过的代码都可用”的集合改成按字段封闭的 v1 词表。cwdSource 在导出边界明确 nullable。**

现有共享 `EXPORT_REASON_CODES` 混入 supervisor、采集租约、超大行等不同语义，却漏掉 `deriveRunHandshake` 实际产生的 claim_missing/revoked/expired，以及已用于启动快照 fixture 的 timeout。隐私默认是对的，但“当前恰好在文档中出现”不适合作为版本协议。代码出自协议也不等于适合放进任何 reason 字段。

**E03 — 在 `docs/contracts/07-outbound-compat.md`「本地委派元数据导出 v1」字段表之后新增「v1 来源与原因代码」；同步 I-07-10、T-07-22/26；06「WorkspaceContext 与项目归属」仅交叉引用出口类型差异。冻结为：**

| 类型 / 字段 | v1 的全部非 null 值 |
|---|---|
| BindingReasonCode；`bindingReason` | `identity_source_missing`, `identity_unverified`, `identity_conflict`, `resume_ref_mismatch`, `unsupported`, `unavailable`, `unknown` |
| HandshakeReasonCode；`runHandshake.reason` | 上述 BindingReasonCode 的全部值，加 `claim_missing`, `claim_revoked`, `claim_expired`, `claim_conflict`, `stale_binding` |
| GitMissingReasonCode；`workspaceSnapshot.gitMissingReason` | `not_git`, `timeout`, `unavailable`, `unknown` |
| CwdSourceCode；`workspaceSnapshot.cwdSource` | `launch`, `registry`, `transcript`, `supervisor` |

各值含义也须写定：

- identity_source_missing 指缺可信当前来源；identity_unverified 指独立身份尚未证实；identity_conflict 指身份证据矛盾；resume_ref_mismatch 指新轮解析结果不符既有目标。unsupported 指该绑定路径未开放；unavailable 指所需读取/能力当前不可得；unknown 指生产者明确知道原因未确定。claim_* 与 stale_binding 分别对应命名的凭据/本轮绑定事实，不把报告或运行失败塞进绑定原因。
- Git 的 not_git 必须是明确确认不属于 Git 工作树，不能由读取错误推断；timeout 是捕获预算耗尽；其他无法取得 Git 元数据的失败归 unavailable，明确原因未知可用 unknown。成功取得所需元数据时 gitMissingReason=null；尚未捕获继续用既有 workspaceSnapshot/gitCapturedAt 的空值表达，不新增 not_checked 状态。
- launch 指冻结启动输入的规范目录；registry/transcript/supervisor 指启动快照实际采用的对应可信位置来源，仍保留原 cwdAsOf。命中缓存保留其原来源，不把 cache 当新来源。它们不允许在导出时取当前位置覆盖历史。`observed-time` 是时间口径标记，不能单独当位置来源；report/job 不进入本次启动快照来源表。

新增如下规范文字：

> 上述字段为对应 Code 类型或 null，键均必需；workspaceSnapshot=null 时不要求其内部键。内部 WorkspaceProvenance.cwdSource 保留现有 string 类型，本条只规定 export v1 的 nullable 边界。白名单值逐字、区分大小写匹配，不从自由文本截取、猜测或拼接协议代码；不认识的字符串输出 null，绝不复制原文，不能因它看起来像路径或含某个代码而放行。null 统一表示“此出口没有可提供的已知协议代码”，既可能无适用原因，也可能内部原因不可公开/无法映射；它不证明成功、已绑定或来源可信。明确的 unknown 代码与 null 不强行互换。
>
> serializer 和 decoder 使用同一组按字段词表。decoder 对必需键缺失或非 string/null 拒绝；未知字符串正规化为 null，保留其他独立状态/冲突事实。paths 模式只控制指定路径字段，不改变上述 null 语义。v1 词表和既有值的含义冻结；不要借新增内部诊断代码悄悄扩展出口。若将来另版扩词，旧 decoder 的 null 退化必须仍然安全。

**代码影响：**在 `src/core/types/export.ts` 定义四个 Code 联合类型，输出字段引用它们；`src/core/export.ts` 的 encoder/decoder 分别使用四张固定集合。输入读取投影仍可接收内部 string/null，不能因收窄输出类型就把不可信字符串强制断言成 Code。保留逐字段 whitelist 和现有隐私哨兵。E02 的 terminalNote、04 receipt.reason、02 reconciliation.cause 不混入这四张表，本次也不新增它们的 export 字段。

**A9：词表及 fixture 是冻结前收口项。**T-07-22/26 覆盖各允许值、跨字段误用、未知/free-text→null、null 与缺键，以及 paths 两模式；验证 claim_*、timeout/not_git 不再无意丢失。无须等待 B18 生产导出器、Git 探测实现或 toktrack 接入。

## 4. append-only evidence 的事实时间约简

**追认事实时间约简；不采用另一套强制 current-snapshot 接口。补齐“可覆盖的观察”和“不可悄悄覆盖的证明/冲突”的边界。**

append-only 是审计保留方式，不表示每条旧 alive 都对现在成立。相反，最后导入的回执也不能抹掉事实时间晚于该回执的活成员。将 observedAt 与 asOf 分开，先归一再命中 R-02，是当前最小且可重放的规则；只说“调用方给当前快照”会把最困难的时序决定藏到调用方。

**E04 — 在 `docs/contracts/02-execution.md`「证据定义与完整对账表」的符号定义前新增「证据归一与事实时序」，更新 I-02-8、T-02-13/17；04「文件、字段与原子提交」「R / G / H / N / Q 的证据生产」引用同一规则。建议直接写入：**

> 先核验 evidence 的 run/source/绑定代次、supervisor、boot/PID 域及固定 scope；错实例、错代次、未接受证据仅审计。再形成带 `asOf:number|null` 的归一事实。scope 的 asOf 来自 ScopeCheck.checked_at；R 来自最终回执的终结证明时间 ended_at；Q/N 来自复合证明所确立的事实边界；H 来自该 producer 的 heartbeat_at，seq/单调钟用于核验当前性。observedAt/recorded_at/validated_at/events.seq 不能替代事实时间，也不能因发现晚而取得事实优先级。asOf 及其来源可存既有 evidence.payload，不要求新增 SQL 列。
>
> 只有经核验可比较的时间才可用于先后关系；缺失、无效、未来时间或时钟异常不能用导入时间补序。必要时保留 unknown/clock_anomaly 并拒绝据此释放槽。相同时间不是任意选一条的许可：alive 与已证明 gone 等互斥实质事实为 X；unknown 与一个已知观察同刻但无法再定序时，当前 G 取 unknown，不凭缺证制造 X。独立完整 R/Q 仍可按下述不可逆证明规则采用。
>
> 同一事实主体的 scope/H 观察先按有效 asOf 约简，再进入唯一 R-02 首条命中表。新的 scope unknown 替代更早的当前活性判断，不能退回旧 alive 以满足 R-02-5；H 同样不能因旧心跳晚导入而恢复 fresh。严格早于有效终结证明的普通 alive 观察是历史，不再否定后来结束，原 evidence 保留在审计中。
>
> R/Q/N 的不可逆证明、已证实 supervisor 死亡、已提交/已启动事实和未解决冲突不是可以统一“取最新一条”的快照。完整 R/Q 成立后，同实例在该证明时刻或之后仍 alive/可提交的证据构成 X；随后一个 unknown、gone 或另一份回执不能静默删除这个冲突。按既有 conflict_resolved 规则显式解决。未知原生退出结果不与有来源的已知结果矛盾；两个互斥的已知原生结果仍是冲突，不按到达顺序取一份。
>
> 一次后来的不可读/unknown 不单独否定已成立且封口的 R/Q；但不能忽略已存在的同实例反证或无法排除的时序冲突。既有终态按 R-02-0 不重开，新的矛盾继续阻断该 ref 新操作。增量调用也必须带入已存终态的证明边界/结果及未解决冲突，不能只拿新 evidence 判断“没有冲突”；terminal_evidence_id 指向的证据是该基准。需要多个证明时保留其必要边界及引用，不能用较晚导入/对账时刻覆盖较早已采用的终结证明。runs.ended_at 只有确实保存相同证明边界时才可充当这一快捷输入。

最小反例表（时间均为同一可信事实时间域）：

| 已接受事实 | 结果 |
|---|---|
| alive@10，完整 R/Q@20；alive 到 90 才导入 | alive 留审计，R/Q 可终结；导入顺序无关 |
| R/Q@20，alive@30，随后 unknown@40 或 gone@50 | X 继续存在；未终态 uncertain/持槽，已终态不重开但阻断新操作 |
| alive@10，unknown@20，无 R/Q/N | G=unknown，不能借旧 alive 回 running |
| 已成立 R/Q@20，随后只有读取 unknown@30，无反证 | 保留 R/Q 的结束事实；取消分类按 E02 |
| alive 与结束证明同刻，或关键活性证据无法与证明定序 | 不以 ID、数组位置或 observedAt 选赢家；冲突/缺证按表阻断 |

**代码影响：**保留 `src/core/types/execution.ts` 的 `ReconcileEvidence.asOf` 与 `src/core/execution.ts` 已有 scope/H 约简、历史审计、结束后 alive 冲突和持久终态反证逻辑；移除待裁决注释。归一层须验证上述时间含义，不能把 `asOf` 当 caller 可随意填写的排序数。A4 的 `persistedTerminalBoundary` 当前取 run.endedAt：调用边界必须保证它与真实终结证明边界相同，否则改为显式传入已验证 terminal basis，不能把 commit/import 时间冒充它。对同刻事实要区分实质矛盾与单纯缺证；不是所有 JSON 字段差异都自动构成 X。

**A9：必须把这项排序规则写入候选契约后才能冻结；不要求重做已通过的约简反例。**复用 T-02-13/17 中倒序导入、旧 alive、晚 alive、最新 unknown、时间缺失/无效、持久终态与 native 结果的现有用例；补齐“已存证明时间早于导入时间后，仅收到新的 alive”及同刻缺证不伪造冲突这两个边界。B2/B5 可在索引读取中预约简，但结果须等价；不新增持久 current-snapshot 表，不每 heartbeat 重放全库历史，完整生产读取成本仍按 06 验收。

## 5. toktrack 的 session-mode 与原始启动归属

**修改。逐 run 导出已有 `operation:'spawn'|'resume'|'handover'`，并明确原始启动与当前关系的区别；不再增加 sessionMode、originalOwner 或成本归属账本。**

`predecessor` 和 `currentOwner` 都是 link 层事实。同一 link 的首次 spawn 与后续 resume 可以同时是 predecessor=null、currentOwner=true；handover 新 link 后的下一轮 resume 也继续带同一个 predecessor。消费者虽可在严格的完整 MVP 历史下再结合 runSeq 推导，但没有必要把内部状态机推理变成公共接口约定。02 的 runs.operation 已经保存准确答案，导出一个枚举没有新查询服务或写放大。

**E05 — 修改 `docs/contracts/07-outbound-compat.md`「本地委派元数据导出 v1」的“每 run 一条 record”与 consumer 合并段、I-07-11、T-07-20/24/26；引用 02 的 operation 和 03 的 resume/handover 定义。增加以下文字：**

> 每条 record 必有 `operation:'spawn'|'resume'|'handover'`，直接投影该 run 接受时固定的 runs.operation，不由当前 linkState/predecessor/owner 反推。spawn 表示创建全新会话的意图，不能隐式 attach/resume；resume 表示同任务 link 对既有 child 的新一轮；handover 表示通过 predecessor 对既有 child 建立新任务 link 的首轮。handover link 的后续续跑仍为 operation=resume。此字段与 visible/headless 的呈现 mode 无关。
>
> operation 描述接受的意图，不单独证明外部动作已执行或身份已绑定。原始启动关系只能由 spawn 记录自身可证的 childRef、已独立确认的关系及无身份冲突的启动证据支持；pending/null/failed(non_execution) 不能因 operation=spawn 升级为确认起源。spawn 的 childRef 不得从后来另一轮的预期目标补造。历史 claim/binding 因正常 resume 被撤销不抹掉此前已确认的启动事实；不能要求旧轮现在仍有报告权限才承认其历史。
>
> currentOwner 表示本次快照中该 link 是否仍拥有当前关系，不表示它创建了整个原生会话，也不表示所有历史用量属于当前任务。predecessor 只表示任务关系的转交；部分 link 范围未包含前驱时保留引用，不猜其祖先。当前确定父边仍按 relationshipConfirmed、端点、状态和冲突判定，与新轮 runHandshake=pending 分开；原始 spawn 转为历史后，不再形成第二条当前父边。
>
> resume/handover 不迁移既有会话在本轮之前的历史用量；createdAt/startedAt/endedAt 不是逐条 token/cost 的归属区间，不能把整日聚合按这些时刻虚拆。即使确认最初 spawn，ledger 也只提供启动/关系来源，不替代 transcript 的实际用量及 consumer 的明确统计规则。身份、物理 workspace、declared 项目来源仍按 D02/D07 分开。MVP 仍只支持同 owner handover，本条不开放跨 owner 转交。

**代码影响：**`ExportInputRecord`、`DelegationExportRecord`、逐字段 serializer/decoder 与 golden 增加 operation；B18 直接读取已有 runs.operation，无 DDL 增项。候选 v1 尚未发布，现在将其列为必需字段；缺字段或不在三值内的 operation 拒绝解码，不能默认 spawn。冻结后不能用同版可选字段规则倒改其含义。既有 isDefiniteCurrentParent 仍判断当前关系，不把它改造成整会话历史成本归属判据。

**A9：只需完成这项字段/文字/合成 fixture 收口，toktrack consumer 不阻 A9。**T-07-20/24 覆盖首轮 spawn、同 link 两次 resume、handover 新 link、该新 link 再 resume、只导出后继 link、失败未绑定 spawn；同时验证当前边与原始启动历史分离。修改本轮尚未发布的 golden，不要求现在实现 B18 或 toktrack 读取，更不建立用量时间线服务。

## 6. 普通会话的 SessionBinding 与 SurfaceLocator

**修改。追认新增 SessionBinding/SurfaceLocator，以及保持 A4 受管类型不变的方向；不追认当前仅 Omit 掉 runId/childBinding 的具体形状。普通会话还不能被迫提供受管 bindingGeneration。**

概念 §6.2 明确没有 ledger/hud-mcp 也能运行单 harness HUD，§6.3 的 bind 因而是“选择被观察会话”，不是取得受管运行或 MCP 授权。A4 的 RunBinding 已专指实际 run 的读取投影，两者应有不同类型。现有 A5 修正消除了假 runId，但 `SessionBinding` 仍继承必填 bindingGeneration、nullable sessionRef 和顶层 supervisor；`SurfaceLocator` 仍继承必填 bindingGeneration。01 已把该 generation 定义为逐 run 的绑定代次，它不是 pane occupant 的代次。A5 报告所说“保留 occupant generation”与这个实际字段不相同；无账本 fixture 填入 1 也不能替代其来源。

**E06 — 修改 `docs/universal-hud-concept.md` §4、§6.3、§6.10 的类型文字，并同步 §6.12/§7.2 中的定位/代次引用；在 `docs/contracts/05-capabilities.md`「数据模型」新增「会话观测绑定与受管绑定」，修改「宿主、定位与 timeout」、I-05-4 与 T-05-8。精确约定如下。**

概念 §4 将当前兼作观察身份的 RunBinding 行拆成两行：

| 对象 | 替换后的定义 |
|---|---|
| SessionBinding | 已选择的完整 SessionRef 与可取得的进程/宿主占用观察；不要求 ledger、hud-mcp、run 或 childBinding。不是持久身份、父子边或授权凭据。 |
| RunBinding | A4 的受管 run 读取投影，必须有真实 runId 与该 run 的 bindingGeneration；未绑定时 sessionRef/childBinding 可空。由 ledger/已核验运行证据供应，不通过观察候选制造。 |

概念 §6.3 将签名改为 `bind(ctx: BindContext): Promise<SessionBinding | null>`，紧接签名写入：

> bind 只解析被观察的会话；非 null 结果必有完整、来源明确的 SessionRef。没有可靠唯一选择时返回 null，不返回一个 sessionRef=null 的“成功绑定”。已知 ref 但没有 PID/宿主证据仍可进行有预算的文件读取，harness/occupantGeneration 可为 null。显式目标、注册表和 PID/cmdline 的观察选择顺序不变，但这不是01的 caller/claim 授权 resolver，也不允许以 cwd/时间候选授予委派权限。来源时间、有效性与证据强度沿用既有 ObservationEvidence/RegistryEvidence，不因返回 SessionBinding 升级为授权事实。

05 新节冻结以下 MVP 形状（类型引用沿用 A4；无须复制 SessionRef、ProcessStamp 或宿主地址枚举）：

```ts
type SessionBinding = Pick<RunBinding, 'harness' | 'occupantGeneration'> & {
  sessionRef: SessionRef;
  managed: RunBinding | null;
};

type ToSurfaceLocator<T> = T extends HostLocator
  ? Omit<T, 'runId' | 'bindingGeneration'> & {
      occupantGeneration: number | null;
    }
  : never;
type SurfaceLocator = ToSurfaceLocator<HostLocator>;

type SurfaceOptions = {
  cwd: string;
  env: Readonly<Record<string, string>>;
  managed: Pick<RunBinding, 'runId' | 'bindingGeneration'> | null;
};
```

在同节补充约束：

> SessionBinding 顶层只保存观察字段；supervisor、childBinding、runId、bindingGeneration 只从 managed 读取，避免嵌套/顶层两份运行事实。managed=null 表示本次未附有可确认相符的受管运行投影，不证明该会话从未受管。managed 非 null 必须来自实际 ledger/run 证据，sessionRef 与外层完整判等，实例/占用证据和所选 run 的当前性相容；正常 resume 必须选择对应的新 run，不把旧绑定当当前轮。无法确认这种关联时保留普通 session 观察、managed=null，并在既有诊断/冲突投影解释，不凭相同 cwd、pane 或裸 sessionId 补关联。RunBinding.sessionRef 尚空的受管意图继续由既有 intent/run 投影表示，不能塞进这个已解析 session 结果。
>
> occupantGeneration 是相应宿主/server 实例下的占用观察代次；确认换 occupant 才失效旧关联并更新代次。未知为 null，无宿主时也可为 null；不填默认 0/1，不从 ledger bindingGeneration、reader sourceGeneration 或 collect lease generation 借值。server 重启或观察连续性丢失须重新核验，不能让相同数字续接旧 occupant。它是现有宿主/注册表观察的元数据，不要求新建全局代次分配器或常驻服务。
>
> SurfaceOptions.managed 是可选语义、显式 nullable 的受管启动上下文：无受管 run 时传 null；有已接受的 run 时一并提供其真实 runId/bindingGeneration。它不是执行票据，也不要求在打开 surface 前已经完成子握手。占用代次由宿主观察产生，不能要求普通调用者制造一个受管 bindingGeneration 来打开 pane。

05「宿主、定位与 timeout」原有“均关联 run/binding generation”改为：

> 普通 surface 使用 SurfaceLocator，保留 Herdr 的 server/workspace/tab/pane 或 tmux 的 server/session/pane、实际可得的 ProcessStamp 及独立 occupantGeneration，不含受管 run 身份。受管路径仍使用原 HostLocator/RunHandle 的真实 runId/bindingGeneration；从 surface 组合受管 locator 时须另取实际 run 的上下文并重验关联，不能把 occupantGeneration 改名或复制成 bindingGeneration。两类 locator 都是定位与待核验快照，不是控制许可。LocatorCheck 保持 valid/stale/unknown、occupantMatches 和 foregroundInteractive；未知代次/实例不因 null==null 被判匹配，操作前必须取得足够的当前占用证据，不能确认则拒绝该控制。普通 session 的读取不因此被禁止。
>
> 普通 session 可以使用经校验的宿主 focus/navigation 等已声明能力，但不能因 SessionBinding 或一个 pane locator 获得 delegate_report/resume/cancel 权限，也不能为调用 RunControl 伪造 runId。受管动作仍按01–04鉴权、校验槽与固定目标；观察 resolver 不建立 claim、childBinding、确定委派父边或新执行权。

概念 §6.10/§6.12 的普通宿主/注册表接口统一引用 SurfaceLocator（旧 PaneLocator 名称不要再另指一套未定义形状）；RunControl 继续只接真实 run。§4 中“pane 换会话使 RunBinding.generation 递增”改为对应宿主 occupantGeneration；§7.2 的普通 Claude resume 不再声称递增受管代次：真实受管 resume 的 bindingGeneration 按01/02分配，reader sourceGeneration 按06读取谱系变化，宿主占用变化另行核验。这些代次不能相互代用或共用计数器。

**代码影响：**只需调整 A5 的 `src/core/interfaces/session-binding.ts` 与 `host-adapter.ts`：按上面形状移除观察层的受管字段、收紧 sessionRef、修改 SurfaceOptions；HarnessAdapter.bind/RegistryRecord 继续引用这些观测类型，移除待裁决注释。相应 fakes/fixture 改用真实语义的独立占用代次，managed 路径从嵌套对象读取 supervisor/bindingGeneration。不要把 A4 RunBinding.runId、HostLocator.runId 或其 bindingGeneration 改成 optional/null；不要仅给保留下来的 bindingGeneration 换注释。受管投影与普通观察的组合校验可复用完整 ref/实例比较，不另建身份系统；实际适配器核验仍由对应 A6/B 工作包实现，scripted fake 不能充当该实现的通过证据。

**A9：E06 的类型/文字须在冻结前收口，且应在 A6 依赖这个接口前调整。**扩展 T-05-8 对应的 A5 合成用例：无 ledger/MCP、无 PID/宿主的普通已知 session 可 bind/open；有 surface 的普通会话无 runId/bindingGeneration/supervisor；已解析结果不允许 null sessionRef；managed.bindingGeneration、occupantGeneration、sourceGeneration 使用彼此不同的合成值，防止当前 binding/occupant 都为 1 的主要 fixture 掩盖混用。另列 managed 与外层 ref/实例不符不得升级关联的规格、stale/unknown occupant 不控制的反例。A5 做类型检查与已有相关 fake 用例回归；不为本条运行真实 harness、增加 SQLite 原型或把生产适配器提前到 A9。

## 必须改的契约条目

以下为完整的 **6 项**；对应代码/fixture/原型调整已包含在各项内，没有额外隐含门禁。

| ID | 契约 / 章节或 ID | 必须修改 | A9 处理 |
|---|---|---|---|
| E01 | 06 输入证据/StateContinuity/ObservationCommit；I-06-12/13、T-06-25/27/28 | session 的真实 sourceGeneration 与 intent 的无该字段分支；intent 当前 run 必填；绑定时连续性须有证据 | 类型、文字和窄 fixture 收口；不加真实进程门 |
| E02 | 02 C、R-02-2/3、I-02-7；03 run/status；04 取消；T-02-13/15、T-04-24/26 | 完整 R/Q 且无 X 时，未知取消先后为 ended+cancel_timing_unknown，释放槽；不得假称 cancelled/already_ended | 当前旧默认及其原型断言必须修正、定向重验；原样不能冻结 |
| E03 | 07 export v1/I-07-10/T-07-22/26；06 workspace 出口引用 | 四个字段各有封闭代码表；nullable/必需键/未知字符串→null；内外类型分开 | 词表、类型、隐私/解码 fixture 收口 |
| E04 | 02 证据归一/R-02/I-02-8/T-02-13/17；04 事实时间来源 | 用 asOf 约简可变观察，保留不可逆证明/冲突与增量所需基准；不以发现顺序消除事实 | 追认现有主要实现，补两个边界及契约文字；不重复无关证据 |
| E05 | 07 每 run record/consumer/I-07-11/T-07-20/24/26；02/03 操作语义引用 | 直接导出已有 operation；区分原始启动、当前关系、逐 run 历史及用量归属 | 候选 v1/golden 收口；consumer/B18 实现不是前置 |
| E06 | 概念 §4/§6.3/§6.10/§6.12/§7.2；05 新观测绑定节、宿主定位/I-05-4/T-05-8 | bind 返回 SessionBinding；普通 surface 独立 occupantGeneration，不继承受管 bindingGeneration；真实运行字段只在 managed，A4 受管类型不放宽 | A5 类型/fake 与文字修正后冻结；不增加真实 harness/SQLite 门 |

**A9 总结论：目前不能把 `c4c0950` 的默认行为、旧原型报告及 A5 的当前 Omit 形状原样冻结。E02 是实际行为变更；E04 的增量证明边界必须说清并验证，E01/E03/E05/E06 完成类型与协议一致性及所列窄验证。六项落实后，这次咨询不留下新的架构分叉；A9 仍由既定评审检查身份、执行、恢复证据包，不因本文自动放行。**

## 可删或推迟

| 项目 | 处理与 G13 理由 |
|---|---|
| intent 的虚构 sourceGeneration、ref、collect lease/单独观测提交 | 删除需求。ledger 已有 link/run/事件锚点，无需第二份采集身份或写入流程。 |
| 为补取消先后而永久持槽、循环取证或新增追因服务 | 删除。R/Q 已证明安全结束时只保留有来源说明；新的正常执行仍需原有全部授权/槽门禁。 |
| 通用 reason/source 注册中心、自由诊断清洗器、把所有内部错误码暴露成 export API | 不做。四张静态词表足够；内部诊断保留本地，未知对外 null。 |
| 另建 current-snapshot 持久表、所有 evidence 一律取最新、每次 status 全量重放证据 | 不做。复用现有 run/terminal evidence/conflict 与按 run 的读取；约简是纯规则，生产优化不得改判定。 |
| sessionMode + originalOwner + historyOwner 多个重复字段、成本区间/自动整段历史重归属协议 | 不做。先导出已有 operation；成本仍归 transcript/consumer，完整谱系或区间需求另立项。 |
| 普通观察的假 run/claim/bindingGeneration、放宽 A4 受管必填字段、全局 occupant 代次服务 | 不做。SessionBinding/SurfaceLocator 承载现有观察，managed 复用真实运行投影；占用不明可 null，不为单 harness HUD 增加 ledger 或控制生命周期。 |
| toktrack consumer、B18 producer、Job 连续性/浏览器表、全套真实 harness 回归 | 按原 B/C 排期。A9 只补本轮受影响的类型/合成反例及取消原型，已有无关证据继续复用。 |

## 你核实过的事实

| 文件 / 只读命令 | 本次核实结果与边界 |
|---|---|
| `tmp/tasks/ORACLE3/role.md`、`brief.md`、后续 `queue-next.md` | 首轮五个窄问题，追加 A5 的一个绑定/定位类型问题；只允许写本答复；不运行探针、不派生 agent、不调用其他模型。没有需向编排者提问的阻断。 |
| 适用 AGENTS 文件读取；`.codegraph` 目录检查；`git log -3 --format='%h %s'` | 初始 HEAD 为 c4c0950，前两项为 f8008e5、b50e2dd，符合 brief 的实现/原型/契约同步顺序。目录实际存在，与 role 的简写不一致。 |
| 首轮收尾 `git log -1`、`git log c4c0950..HEAD --format='%h %s' --name-only`；追加咨询 `git log -3` | 首轮期间 HEAD 前进到 A5 的 a7aa3a6，提交仅列 src/core/interfaces、tests/fakes 及 core-fakes.test.ts 共 11 个文件；追加咨询开始仍为该提交。首轮仅核对清单，本次追加仅裁决指定类型边界，不把该提交当作本答复产生的修改。 |
| `codegraph explore "src/core/types/observation.ts StateContinuity; src/core/execution.ts reconcileRun; src/core/export.ts serializeDelegationExport reason cwdSource"` | 退出 1，明确报无可用 index 并允许普通读取；没有创建索引。随后才用 rg/sed/cat 定位实现。 |
| `docs/contracts/01-identity.md` 至 `07-outbound-compat.md` 的数据模型、状态/证据、导出与相关测试/DDL；`wc -l` | 核实 source/绑定/读取代次分离，02 的取消时序缺一条明确结果，06 的通用 StateContinuity 与 intent 描述不一致，07 缺字段专属词表及 operation。02 runs 已有 operation，不需要新增存储列。 |
| `docs/reviews/2026-11-01-astra-contracts.md`、`2026-11-01-astra-consult2.md` | 保留 C07 的“结束事实与退出结果分离”、D01/D11/D12 的显示身份/连续性/分域快照、D06/D07/D08 的本地逐 run 导出与 consumer 独立排期。未把历史评论中的旧 A8 缺口重新列为本轮阻断。 |
| `src/core/types/observation.ts`；`src/core/observation.ts` 的连续性、节点合并与 commit 校验 | 已有 intent 无 sourceGeneration 的联合分支；纯连续性比较包含 node/run/代次/规则/episode；ObservationCommit 校验仍只接受真实 session。intent 的 StateContinuity.runId 目前沿用可选公共字段。 |
| `src/core/types/execution.ts`；`src/core/execution.ts` 的 reconcileRun | 已有独立 asOf/observedAt、scope/H 约简、晚 alive 冲突及持久终态反证；取消时序未知明确返回 R-02-9/uncertain；当前 cancel fact 用 find 选择，persistedTerminalBoundary 取 run.endedAt。以上直接影响本次契约裁决。 |
| `src/core/types/export.ts`、`src/core/export.ts`；`src/core/lifecycle.ts` 的 deriveRunHandshake | 出口已有显式白名单、未知字符串→null 与 nullable cwdSource；原因集合跨领域共用，未包含 claim_missing/revoked/expired；当前 export 无 operation。当前父边判断已与新轮握手分离。 |
| `tests/unit/contracts.test.ts`；`tests/fixtures/contracts/identity-execution.ts`、`observation-export.ts` 的相关用例；A4a 报告尤其 §6 | 读取了已注册规格及对应断言，确认旧取消默认、事实时间反例、intent 无代次与隐私哨兵。A4a 报告记载 122 个契约用例通过；这是已有报告结果，本次没有重新运行，不能当作修订后 E02/E03/E05 已通过。 |
| `docs/probes/a9-prototype.md`；`tests/prototypes/a9/common.mjs`、`execution.mjs`、`scenarios.mjs` 的取消/恢复相关段落 | 报告记载两次 21/21；代码确有 scope 已结束但取消顺序未知仍持槽，以及 SQLite 写锁使退出先于取消接受的合成场景。原型是独立实现，修改核心纯函数不会自动改其判断；本次没有重跑或验证新的预期。 |
| `tmp/tasks/TOKTRACK1/report.md`「HUD ledger adaptation」 | 确认 toktrack 尚未读取 HUD ledger，采用拟议 export v1；唯一新增澄清是 session-mode/原始启动归属，明确反对 resume 搬走旧会话全部历史与按日聚合虚拆区间。没有读取 toktrack 真实会话或执行其代码。 |
| 追加的 `codegraph explore "src/core/interfaces/session-binding.ts SessionBinding resolution evidence"`；随后 cat/sed/rg 读取概念 §4/§6.2–3/§6.9–12/§7.2、01 代次定义、05 宿主定位 | CodeGraph 仍退出 1、无可用 index；没有索引。概念把普通观察叫 RunBinding 并用笼统 generation，01 则明确逐 run bindingGeneration；这是真实的语义差异，不只缺一个可选 runId。 |
| A5 的 session-binding/harness-adapter/host-adapter/registry-provider/run-control 接口；A4 RunBinding/HostLocator 定义；相关 fake 与 core-fakes.test.ts；A5 报告 | 核实 Omit 后仍必填 bindingGeneration、顶层 supervisor 与 nullable sessionRef；SurfaceOptions 无 runId 仍要 bindingGeneration。普通 fixture 填 1，managed fixture 也用 1；现有缓存 registry 另有 sourceGeneration=7。A5 报告记载 8 个用例及整套检查通过，本次只读，未重跑，不能视为 E06 修改后的通过证据。 |
| 本答复的分段读取、`rg -c` 与章节检查 | 核对六个问题节、三个指定附节及 E01–E06 共 6 个变更 ID，正文与总表一致。仅检查文档。 |

本次仅做指定文档/代码的静态设计核对，使用了 cat、sed、rg、wc、目录存在性检查、只读 git log 及失败的 CodeGraph 查询。未运行构建、测试、探针、harness、Herdr 控制、其他模型或 subagent；未修改输入契约、实现、原型、配置、Git/index。唯一写入是 `tmp/tasks/ORACLE3/answer.md`。本文的改动和复验要求交实施者落实，不能记为本次已完成实现或 A9 验收。
