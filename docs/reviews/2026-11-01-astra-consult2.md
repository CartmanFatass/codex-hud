# ORACLE2：字段所有权、HUD 动作边界与外部读取接口

评审基线：HEAD `8fdf4cf`；契约 01–04 v0.3、05–07 v0.1；信息设计 v1.0；概念 v2.3、工程计划 v1.1。本次是设计裁决，不是实现验收。A8 已接受按本轮 brief 与当前探针报告处理，不能沿用契约头部尚待接受的旧说明，也不能据此宣称 B 的生产能力已通过。

**需要修改 13 项契约决定（D01–D13；一项跨文件同步只计一次）。不另行上送 Pro，纳入既定 A9 评审。A4 可在本次类型与边界修订落地后开始，不等 toktrack 的完整字段清单、生产导出器或 B16 全部实现。**

## 1. stateSince

**修改——由 06 定义并在观测摘要中保存，由 B16 计算状态边沿；03 只引用该投影。HUD 重启应能恢复已知的持续时间，不每次读全量 events，也不新增 ledger 的逐 tick 写入。**

理由：03 的 events 记录运行、关系和报告事实，但并不记录所有 transcript、registry 与时间截止共同造成的显示状态变化。`events.at` 的最大值、最后一次心跳、`observedAt` 都不能直接充当进入当前状态的时刻。反过来，只在渲染进程内记一个首次见到时间，会使重启、两个面板或 statusline 得到不同的驻留时间。

**D01 — 修改 `docs/contracts/06-observation.md`「B16 的五维输入与消费者字段」「checkpoint 一致提交与 collect lease」及 B16 附录；同步 03「status 与 HUD 可读投影」、07 的 v3 槽、设计 §7 #23。** 写定：

- 统一输出 `stateKey: string`、`stateSince: number | null`、`stateSinceBasis: event | observed | unknown`。内部连续性记录还带投影规则版本、节点身份、当前 run/观测代次，以及由待决 ID/turn ID/被采用事件等确定的 episode 锚点。`stateKey` 是所选语义状态及必要原因，例如 approval、question、supervisor_dead；不包含图标、颜色、翻译、宽度或子树排序桶。B16 的唯一分类函数采用与设计 §3.3 对齐的优先关系，前端负责视觉映射，不再各自维护状态进入时间。
- `stateSince` 表示本节点当前语义状态这一段连续区间的起点。新 run、已证实的新状态周期或选中语义状态变化才开启新区间；报告重读、心跳续写、用量增长、折叠、换语言、父节点因子孙而换排序桶均不重置。新一轮 approval/失败即使恰好使用同一图标，也不能沿用上一轮的时间。
- 有可定位的进入事件且连续性可证时，用该事件时间；只有首次看到这个状态的证据时，用首次观测时间并标 `observed`；时间或连续性不可知则为 null/unknown。时间截止产生的 stale 使用相应来源的确定截止边界，遵守 04 的严格大于 30000 ms 规则；不能把重新绘制的时间当起点。
- 这几个字段随现有 `ObservationCommit` 的 summary/checkpoint/notice 原子发布，写者仍是持 collect lease 的采集器。只因状态边沿或原有内容提交而写；年龄由 `nowMs` 计算，重绘与 status/wait 不写观测存储或 ledger。首次建立基线不补发一次虚假的完成通知。
- 重启读取已提交的连续性记录；能有界续读的源从 checkpoint 接续。若停采期间可能漏掉 registry 的瞬时变化，或发生 sourceGeneration/规则版本变化、历史缺口，不能假装状态一直连续：用可证明的事件重建，否则给新的 observed 起点或 unknown。恢复已知时间不等于承诺恢复从未观测到的事件。
- 未确认委派行尚无 SessionRef 时，pending/claimed/运行状态的起点从相应 link/run 事件直接派生，不为它伪造 `collect:<SessionRef>` 租约。首次绑定时若可证明是同一状态区间，可沿用该事件起点。
- `? uncertain/stale` 的时钟仍取被采用证据或心跳的年龄，即 `lastEvidenceAt`/heartbeat 的时间；`stateSince` 用于状态驻留、排序与变化强调，两者不能合并成一个时间字段。时间倒退要给 clockAnomaly，不能靠刷新时间掩盖。

A4 增加合成断言：同证据重读与重启不重置；新 run/新的待决周期重置；没有 DB 变化但跨过 stale 截止仍改变投影；丢失历史不伪造连续驻留；两个消费者读取同一 commit 得到同一结果。B12 实现持久发布，B16 实现唯一边沿逻辑。

## 2. cwd、worktree 与项目归属

**修改——保留工作树显示名，同时增加工作树根和本地仓库分组 ID；启动位置与后来观测的位置分开。普通临时副本的来源必须显式声明或保持未知，不能用父子关系、目录名或相同 remote 自动认定。**

理由：名字不能判等，branch 也不是工作树身份。linked worktree 的 checkout 根不同，但其 Git common directory 可用于本机仓库分组。两个独立 clone 即使 remote 一样也不是同一个本地仓库。普通复制目录没有足够信息证明从哪个仓库复制；复制了 `.git` 的目录同样不能凭 remote 或相似内容取得来源证明。一条委派边也不证明父子正在做同一个项目。

当前文件与 brief 的一处差异需要说清：06/07 实际尚未写出完整的 cwd/worktree 字段契约；概念 §6.4 有 cwd，A2 crosswalk #24 约定了工作树显示名。不能把 crosswalk 的文字当成已经存在于 schema 的字段。

**D02 — 在 `06-observation.md` 新增「WorkspaceContext 与项目归属」，同步概念 §6.4、01「身份、实例与定位」和 07 的新投影类型。** 字段定为：

| 字段 | 语义 |
|---|---|
| `cwd: string | null` | 已定位会话的工作目录，已知时为绝对路径；未知为 null，不能填 HUD 自己的 cwd 或候选目录。附来源与时间。这里不是所有 shell 工具命令各自的临时 `cd`。 |
| `worktreeRoot: string | null` | 该 cwd 对应的 checkout 顶层目录，规范化绝对路径；无工作树、不可读或未取得证据时 null。 |
| `worktree?: string` | 可选显示名。来自明确 label 或工作树根的显示短名；不承诺 Git 有一个独立、永久的公开工作树名称，也不把 branch 名当身份。 |
| `gitCommonDir: string | null` | 解析后的 Git common directory 的 realpath，属于私有本地证据。相对结果按 Git 返回值的语义正确解析，不能简单拼 `.git`，也不能用 dirname 反推主工作树。 |
| `repoId: string | null` | `SHA256(UTF8(canonicalJSON(['git-common-dir-v1', realpath(gitCommonDir)])))`。标明 `identityKind=git-common-dir-v1`、`scope=local`。这是本机仓库位置分组键，不是跨机器、跨 clone、跨搬迁的永久项目 UUID。 |
| `projectOrigin: {repoId, basis: declared, declaredAt} | null` | 对临时副本等场景的显式项目来源声明。接受时记录声明主体；它不替换物理 `repoId`，也不升级成经 Git 证明的同仓库关系。 |
| 来源与时间 | 保存 cwd 来源、Git 捕获时刻和缺失原因；不能把旧 header 的 cwd 写成刚核验的当前进程 cwd。 |

Git/项目解析属于共享的 workspace 元数据服务，reader 只提供其确实读到的 cwd 与来源，保持概念 §6.4 的职责划分。工作树判等比较有效的规范根路径，cwd 差异独立比较规范 cwd；缺少根信息时只能说明目录不同，不能声称已确认属于不同工作树。同名不代表同目录，未知不代表相同。

`repoId` 与 `SourceId` 完全独立：两个 harness home 可以工作在同一仓库，不能因此合并 SessionRef、OwnerKey、授权或采集存储。remote URL 及其 hash 不进入 MVP 的仓库身份；将来最多作为另一个显式项目关联信号。无 Git 的临时副本在未声明来源时仍为 unknown，toktrack 可继续保留自己的推断及其置信来源，HUD 不为它出具确定归属。

**D03 — 修改 `02-execution.md`「数据模型」「幂等参数与查询顺序」和 schema v1 的 runs；同步 04 启动输入/meta、05 档案准备、06 预算。**

1. 每次 spawn/resume/handover 的意图事务保存不可变 `runs.launch_cwd`，非空规范绝对路径；这是本轮实际交给启动器的 cwd，不是 `callers.cwd`。resume 明确采用的启动目录也必须逐 run 保存，不能以后按 CLI 所在目录重算。
2. 增加 nullable、白名单化的 `runs.workspace_snapshot`，保存上述 Git 定位及来源/捕获时刻；另以 nullable `runs.project_origin` 保存显式来源声明，随意图固定。Git 数据可用有效缓存同事务记录，或由该 run 的已有写者在一次有界启动采集后 NULL→首次快照补齐，并提交 `workspace.captured` 事件。两个字段分开，避免来源声明已经落盘就无法再补 Git 快照。缺失、超时、非 Git 都允许明确记录；不能为元数据补齐重启 harness。一次捕获不是其后所有时间的目录事实。
3. `launch_cwd` 永不被后续观察覆盖。实际 harness/session 证据显示另一个 cwd 时，写入 06 的 observed workspace 并保留来源，UI 可显示该新观察；外部 v1 导出只承诺 ledger 中的启动上下文快照，必须带 `cwdBasis=launch` 与捕获时间。导出时不临时跑 Git、读 transcript 或以今天的目录内容改写历史。
4. 幂等摘要包括规范 launch cwd 和请求中显式的 originRepoId；不包括写者追加的 declaredAt、易变的 Git 探测结果、显示名或采集时间。这样一次缓存未命中不会使相同控制请求变成异参。04 meta 只可携带这类稳定启动信息，不复制实时 workspace 状态。
5. Git 解析不进入写事务、MCP accepted 热路径、HUD paint 或 statusline。热路径只读缓存；冷缺失由已有启动/采集流程按预算补齐。每个新工作目录或失效代次最多一次发现工作，最多两次 Git 子进程、总软预算 200 ms，超时终止子进程并记 unavailable；这是待 B 验收的预算，不是实测值。相同上下文的重复 tick 不再调用 Git；失效由明确 cwd/工作树元数据变化或显式刷新触发，复用已有变更提示，不新增 watcher daemon。未知结果不阻塞正常委派。

A4 fixture 覆盖同仓库两个 worktree、同 remote 两个 clone、无 Git 临时副本、显式 copy 来源、shell 包装改变实际 cwd、路径消失后仍可导出历史启动位置。`launch_cwd` 是本次必须进入候选 ledger schema v1 的事实字段；仅靠当前 `callers.cwd` 或 params_digest 无法恢复它。

## 3. HUD 动作边界

**追认 MVP 的显示并复制命令；修改只读的解释：将来显式调用受信 CLI 并不违反账本单写者边界，但本轮不实现 HUD 内直接 Resume/Reconcile。复制命令本身也必须有可执行的权限与重试契约。**

理由：账本只读约束禁止 HUD 自己更改运行事实或拥有第二套迁移实现，并不禁止用户通过界面请求已有写者工作。不过，直接执行还需要处理目标在确认前变化、重复按键、进程响应丢失和重试。本次保留已定交互默认，救援动作的这一段便利性不足以扩大 MVP。

**D04 — 修改 `03-lifecycle.md`「status 与 HUD 可读投影」、04「写者与 RunHandle」、05 的控制边界，关闭设计 §3.7/§8 #2 的开放项。**

- MVP 的 `R` 只显示并复制命令；不会 spawn 控制 CLI。Open/focus 仍按已有 interaction/occupant 门禁执行，不能因 Open 的实现能起进程而暗中加入 resume/reconcile。
- 允许入口用类型化 `ActionDescriptor` 表达操作、固定 linkId/runId、原因与安全生成的显示命令。任意 report、label、日志或未经验证的字符串不是可执行命令来源。按钮与 Inspector 消费同一描述；状态变化不能把已选操作换成另一操作。
- 若以后增加直接调用，必须另列可选功能：显式按键后，确认界面固定展示操作、目标和模式，再由用户确认；使用可信可执行文件与 argv，不执行投影中的 shell 字符串。调用仍进入相同 writer/reconciler，执行时重新核验当前目标、owner/本地权限、槽、能力、冲突与任务摘要。确认后状态不符就拒绝，不替用户选择新 run。
- resume 同一意图使用同一 request_key；未确定响应时只查或重放该键，不能生成新键自动重试。reconcile 按 run 与证据指纹幂等导入；不因重复按键产生新执行权。禁止由绘制、通知、连接恢复、状态进入 uncertain 或定时器自动触发这些 HUD 动作。这不取消 04 已批准的写者内部恢复触发。

**D05 — 在 01「OwnerKey/授权边界」、02「幂等参数与查询顺序」、03「resume 与 handover 事务」、04「写者与 RunHandle」定义窄的本地管理 resume 入口；计划归 B4/B11。**

现有 04 已明确本地管理 cancel/reconcile，但 `hud run resume <linkId>` 没有对应身份语义。把命令放进剪贴板不会让 shell 调用自动成为原父 MCP，不能伪造 CallerId/context 或接受参数自报 OwnerKey 来补这个缺口。

本轮明确增加以下有限例外：同一 OS 用户对其私有 HUD_HOME 的显式本地管理命令，可 **代表已登记关系的现有逻辑所有者** 请求 resume；不转移关系所有权。这是新增的本地管理权限，不是把历史父 context 当成仍在调用。

- 入口核验本地用户及 HUD_HOME/ledger 的所有权和私有路径。审计事件区分 `actor.kind=mcp` 与 `actor.kind=local_user`；后者记录 UID、本地 invocation ID 与被代表的 OwnerKey，后者只能从该 link 已证实的 `parent_ref` 派生。父 ref 未确认、跨 owner predecessor、local report 或未定义的 local spawn 都不由这个例外放行。
- MCP 请求不能用一个 `admin` 参数选择 local_user 分支。本地 CLI 也不能把 UID 或进程来源声称为人类证明；HUD 的按键/确认是交互要求，同 UID 下脚本执行能力不由本协议隔离。
- `resumable`/allowedActions 的读取投影注明适用主体：MCP status 沿用父 owner 门禁，本地 HUD 只投影这个 local_user 入口的可行性。两者复用门禁函数，不把另一个主体的按钮能力当授权凭据；最终仍由写入口重验。
- 只放宽发起者必须是当前父 MCP 这一项。03 的 current_owner、bound/reported、同任务、真实 child、空槽、无冲突、支持档案与本轮新 claim/代次等条件全部保留。经过同一事务入口，原 parent/link 归属不变；执行票据登记/提交时按该意图的类型化发起权限重验，不能再拿已经失效的旧父 context 冒充当前调用。CLI 发起的 launch_call_id 必须标明本地调用来源，不能冒充不存在的 MCP tool_result；01 的父 transcript 核验路径不适用于这种不存在的工具结果，正常独立启动/子握手证据仍适用。
- CLI 必须接受显式 `--request-key`、`--expected-run` 和 `--mode`，expected-run/mode 纳入参数摘要。先鉴别管理主体并派生 canonical owner，再按 02 查询幂等记录；同键同参先重放原结果。只有新意图才检查 expected-run 仍等于当前 run，其余门禁也重新检查。这样旧复制命令即使被另换键，也不能跨过一次已发生的 resume 再起一轮。
- HUD 复制的实际命令须包含以上参数以及明确的 HUD_HOME 定位（安全引用）；文档中的短命令只作缩写。一次复制形成一份意图，重复复制同一待处理意图保留 request_key。Reconcile 仍是已有受信本地取证入口，不新增强制结束或清槽开关。

A4 只需上述 initiator 联合类型与合成鉴权/重放 fixture，生产 CLI 留 B4/B11。若这条本地入口尚未实现或能力未验证，UI 不得提供一条号称能用的裸 resume 命令；只给诊断及由原父调用 delegate_resume 的现有途径。

## 4. toktrack 等工具的外部读取接口

**修改——采用独立版本的只读 `hud link export --json`，以单次一致快照为 v1；不将内部 SQLite 表、SQL view 或事件 JSONL 暴露成受支持协议。最小生产导出器作为 B2 之后的独立 B18 纳入 MVP，toktrack 消费端可随后接入。**

理由：SQLite view 仍要求消费者理解库路径、迁移和读取生命周期；JSONL 事件文件又引入第二份持久日志、轮转/保留/重放规则及写放大。一个按需 CLI 可以复用 B2 的只读访问层，把存储版本和消费版本隔离。toktrack 需要的是可合并的委派事实，不需要复制运行状态机。

**D06 — 在 `07-outbound-compat.md` 新增「本地委派元数据导出 v1」并将版本表改为五个独立版本域；02 schema 增加初始化一次的 ledger 标识。**

基本出口：`hud link export --json --schema-version 1 [--paths local]`。默认不输出路径。最小逻辑形状如下；可选补充字段等 toktrack 清单，以下身份、空值、范围与时间含义现在冻结：

| 层 | 必需含义 |
|---|---|
| envelope | `format=hud-delegation-export`、`schemaVersion=1`、`ledgerId`、`asOfSeq`、`exportedAt`、明确的查询 scope/coverage、paths 模式、`records[]`。asOfSeq 是该次 ledger 读快照的事件高水位，不是增量同步游标。 |
| 每条 record | 每个 run 一条：`linkId, runId, runSeq, linkState, runState, isCurrentRun, currentOwner, predecessor`，以及未决冲突标志。只有同一 link 的多 run，不重复创造多条逻辑父边。 |
| 端点 | `parentRef`、`childRef` 是完整 SessionRef 对象或 null；ref 为 `{harness,sourceId,sessionId,threadId}`，threadId 无值统一 null。尚未绑定时，预期 harness/source 可另列，但不能把它们包装成一个伪 SessionRef。 |
| 绑定信息 | 关系的确认程度、当前 runHandshake 与缺失原因分别给出；resume 时关系仍可已确认而本轮握手 pending。历史、冲突和未确认意图必须可区分。 |
| 工作位置 | 本轮 `launchCwd`/workspace 快照，`repoId`、可选 declared projectOrigin、捕获时间/来源/缺失原因；路径是否可见受 paths 模式控制。不是导出时重查所得的当前 Git 状态。 |
| 时间 | `createdAt`、nullable `startedAt`、nullable `endedAt`，全部 ms epoch。endedAt 沿用 04 的已确认终结观测时刻，不许解释成精确内核退出时间；failed 的 startedAt 可以 null。 |

实现规则：

- 02 增加一条私有 ledger 元数据记录，保存创建库时生成的 opaque `ledgerId`。重启和同一账本的备份恢复保留它，独立新建账本生成新值。外部关系/运行键是 `(ledgerId, linkId)`、`(ledgerId, runId)`；不以 HUD_HOME 的绝对路径当可移植命名空间。
- 一次 read-only 连接/读事务取得 rows 与 high-water，按 linkId/runSeq 稳定排序，只读已提交记录；不继承 HUD 的 200 节点显示截断。无库、未知存储版本、权限失败必须给明确 unavailable/错误，不能初始化、迁移、运行 reconciler，或输出成功的空关系全集。
- v1 是完整的所选范围快照，消费者按稳定键 upsert。先不做 `--afterSeq` 增量接口；当前 link/run 行会被回填和迁移，单凭 events 高水位并不能提供一个已定义的行变更协议。也不承诺把分次分页结果拼成同一个历史快照。
- 缺必需字段或未知主版本拒绝解码；同版本只加可选字段，不改既有单位、空值或身份含义。消费者忽略未知可选字段；未知状态必须保守处理，不能当 bound/ended。破坏性变化升导出主版本；发布的 v1 不能因 ledger user_version 或 public snapshot 升级而悄悄改变。
- 该出口与旧 `codex-hud --json` v2、通用 snapshot v3 完全独立，不改旧命令/文件格式。

**D07 — 同一 07 新节写定隐私白名单与消费者合并规则；引用 01 的 SessionRef 判等。**

1. 默认只输出协议元数据：ID、枚举、时间、仓库分组键及声明来源。没有 brief/report 正文或摘要，没有 prompt、原始事件/evidence payload、日志、claim、环境、凭据、transcript 路径；不直接 `SELECT *` 序列化。默认也不输出会暴露项目/任务文本的自由 label。
2. cwd/worktreeRoot 等绝对路径只在显式 `--paths local` 时输出；这个开关面向本用户的 toktrack 等本地消费者。source root、Git common dir、brief/report/log 路径不属于 v1 的必要对外字段。输出在 stdout，不自动落一份永久文件；需要保存时由明确的导出选项创建 0600 私有文件。repoId/sourceId 的 hash 是关联键，不是匿名化保证。
3. 本地元数据导出不需要借用 B17 的模型许可，也不授予任何远端或模型外发权限。拿导出结果进入模型、遥测或同步时，仍须相应来源/目的/接收方规则；不能把 CLI 输出当成已经脱敏可公开的数据。公共 fixture 仅合成路径/ID。
4. toktrack 以完整 SessionRef 合并自己的 transcript 数据；其 source 必须按 01 的 harness + 规范存储根规则匹配，Claude 的 agentId 要进入 threadId。只有 harness+sessionId、相同 cwd、mtime 或 pane 不足以消除双 home/原生子歧义。SourceId 缺失时不能猜一个 home 来完成 join。
5. 经确认且无未决冲突的当前父边，可优先于 toktrack 的同一关系推断；null 端点、pending/claimed、冲突不能升级成确定父边。handed_over/revoked 等保留历史，不成为第二条当前父边。旧 run 的 endpoint/cwd/时间不能自动套到新 run；账本边也不覆盖 transcript 中实际用量口径。
6. `coverage` 只说明当前查询范围内的 HUD 委派记录是否完整。无记录不证明没有原生子代理、手工启动、前 HUD 历史或其他委派。toktrack 继续按自己的范围推断；对于争议记录保留冲突，不能以一个貌似较新的推断静默抹掉它。projectOrigin 的 declared 强度始终保留。

**D08 — 修改工程计划 §3/§4，新增 B18「版本化本地委派导出」（CORE，S，依赖 A9+B2），同步概念 §15 最后一行与 toktrack 交接说明。**

- B2 负责内部只读访问层、存储字段与 ledgerId；从 B2 的笼统 list/show/export 中拆出公开 export 的版本/白名单验收，避免两处定义。B18 不依赖 B16、B17 或 HUD 正在运行，CLI 分派由 B11 集成。
- A4 提供导出类型与合成 golden fixture；B18 实现按需查询/序列化，B14 加入 producer 的快照、双 source、晚绑定、两轮 resume、handover、空值和隐私回归。toktrack 消费端实现及其未到的字段清单不作为 A9 或 B15 的前置；可在兼容规则内补可选字段。
- 导出不跟随每个 heartbeat/paint 自动运行，不新增 JSONL writer、守护进程或后台全库同步。v1 默认上限 10000 条 run 记录、16 MiB 编码结果、1000 ms 软读取/组装预算；任一超限显式失败，不能给一个成功但漏掉历史的全集。可用明确 link 范围缩小请求；大规模一致分页在确有需求时另定。完整 JSON 准备好才输出，消费者只在成功且 coverage 完整时替换对应范围缓存。B18 记录真实行数/字节/墙钟及读事务寿命，不能把软预算称为硬实时保证。
- 交接说明改为：将提供的是带来源的逐 run 启动位置、已确认委派边和可选显式项目来源；任意 `/tmp` 副本自动归主仓库不是 HUD 已承诺或已实现的事实。

## 5. costUsd 与 browser holderLabel

**修改——costUsd 的缺失是 06 的必需数值语义，进入 A4 新观测类型；holderLabel 是 C4 的浏览器租约读取投影，C5 消费，不进入当前 ledger schema v1。**

理由：一个对象里 tokens 已知而美元未知，不能用整体 spent 的 reported 来掩盖成本缺失。显示名则没有资源所有权含义，不值得为未来 C 能力增加一份必须同步的租约事实。

**D09 — 修改 06「Metric 与时间」、概念 §6.4 的 spent 类型、07 v3 槽与设计 §7 #13。**

新观测类型按指标分别包装，至少为 `spent.tokens: Metric<TokenUsage>` 与必有的 `spent.costUsd: Metric<number>`。无成本口径时为 `{value:null, quality:unknown, source:<明确来源及缺失原因>, asOf:<确认缺失时刻>}`；设计中的 costUsd:null 是该 value 的含义，不是再维护一个裸字段副本。有效零保留 0/reported；未知价格不由 token 数自动换算美元，Flow credits 保持另一单位。

树级合计携带已知/缺失节点数、coverage 与 quality，完整 SessionRef 去重。只有同口径的非负已报告成本部分和才可当该口径的下界；混入估计值必须标 estimated，不能再宣称严格下界。原 v2 的缺省/零兼容行为按 07 保留。本项属于观测 schema 候选 v1/public v3，不给 ledger 新增 cost 列。

**D10 — 修改 02「三类租约/Deferred」、06 的 C 阶段 Job 读取投影说明、计划 C4/C5 与设计 §7 #12。**

`holderLabel?: string` 由 C4 的 lease owner/job 身份在同一读取投影中取得，供 C5 显示；没有可公开的匹配显示名就省略。资源判等、generation 与释放仍使用真实 browser resource/holder 身份，label 不参与互斥，也不改变 needs_human/未知结果继续持有的规则。名字变化只更新投影，不保存另一份 holder 所有权。

A4 可保留未来 Job capability 的类型位置，但不为此建立 browser 表、制造 MVP 正向样例或冻结 C 的 DDL。设计 #12 对「02 jobs/leases」的引用应改成「C4 定稿的浏览器租约契约；当前 02 仅规定释放原则」。

## 6. A4 还缺什么

**修改——除上述字段和本地入口外，A4 前须消除节点身份/投影形状、跨存储快照和工作包依赖的三个歧义。无需重开架构或等待全部生产能力。**

**D11 — 在 03「status 与 HUD 可读投影」、06「Reader、coverage 与树/B16 输入与输出」、07 v3 槽及概念 §6.5 明确 A4 的投影类型；同步设计引用。**

- 当前概念把每个节点限定为 SessionRef/JobRef，设计却要求显示尚无 child_ref 的 pending/claimed 委派。A4 增加显示专用联合类型：`session(ref)`、`delegationIntent(linkId)`、未来 `job(ref)`。未确认意图使用稳定 linkId 显示键并关联 currentRun，不伪造 session_id/source，不因相同 label/cwd 合并，不进入已确认 session 的计数。绑定后由 B9 以真实 ref 合并，保持选择映射、单父边和去重；这不是新的授权身份或第三类账本运行。
- 06 的 freshness 当前是来源时间/错误明细，设计 §3.3 却直接把它与 stale 比较。统一为 `freshness: {state: fresh | stale | unknown, ...来源时间/截止/错误明细}`，设计与消费者使用 `freshness.state`；缺来源是 unknown。B16 定义所选来源如何产生总体 state，不能让 A4、B6、B10 分别猜。
- 明确 `run.state=failed` 是 non_execution，不能靠设置 lastTurnOutcome=failed 假装曾经有一轮模型执行。D01 的语义分类要包含 launch_failed 及其原因。运行终态只能由 02 的 ended/failed/cancelled 判定；报告 completed/failed、一个失败图标或 cancelling 都不能单独构成运行终态。供历史折叠/时钟使用的终态谓词由共享投影提供，前端不能只按 `!`/`■` 的字符把仍占槽的运行收进已结束历史。

对应 A4 fixture：两个同名未绑定委派各有独立显示键；绑定后不出现双节点/双父；无报告且 N 成立的 failed 显示明确未启动失败；failed 报告但 run 仍 running、以及 cancelling 都保留非终态执行事实。视觉样式仍交 FED。

**D12 — 修改 03「status 与 HUD 可读投影」、06「ObservationView/ObservationCommit」及 07 v3 时间/版本边界，明确复合读取的快照戳。**

03 的「同一读快照」只保证 ledger 的 link/run/report/events/权限投影内部一致；06 的摘要在另一个观测存储中，不能声称二者天然原子。统一约定：

- `asOfSeq` 专指本次 ledger 快照 high-water；HUD 没有 ledger 时为 null，已打开但无事件的空 ledger 才可为 0。另带 `observationStamp={seqDomain,commitSeq,inputLedgerSeq,ref,runId?,bindingGeneration?,sourceGeneration}`，纯原生观测的 inputLedgerSeq 可为 null。使用摘要生成时实际采用的输入，不能贴上当前 ledger 高水位冒充新摘要。
- 组合前核对 ref、当前 run、绑定/来源代次。摘要属于旧 run 或不相容代次时，当前观测部分 unavailable/stale 并说明原因，旧摘要仍可作历史；不能拿上一轮 failed/completed、stateSince 或 cwd 补当前轮。全局 ledgerSeq 仅因无关 run 增长不必使所有摘要失效，应比较相关实体的身份/版本。
- read-only status/wait 不为取得一个所谓原子快照而触发采集、Git 或 reconcile。需要即时结合 ledger 事实和缓存观测时，用同一个纯 B16 函数，并保留两套输入戳；没有可靠连续性就按 D01 输出 unknown，不在读路径偷偷发布新 summary。
- ledger events.seq、观测 commitSeq、NoticeEvent.seqDomain 内的 seq 不互相比较或当成同一个 wait 游标。06 已有 NoticeEvent 的正确分域规则，应延伸到整个 statusProjection；不新增跨库事务协调器。

A4 的基本反例是：ledger 已有 run-b，观察摘要仍为 run-a。结果必须是 run-b 的真实账本事实和有原因的缺失观测，而不是 run-b 加上 run-a 的成功报告/驻留时长。

**D13 — 同步工程计划 §3/§4/§5、概念 §16、01–05 证据头部与 05 E-05-6/T-05-11。**

- A4 增加本次类型、nullability、所有权、快照戳与合成 fixture；仍只做 A9 最小 SQLite/合成进程原型，不提前合入 B 产品代码。外部工具的后续需求不重新阻塞这一切片。
- B6 的最终 status 验收依赖 B16，不能仅写 B2+B3a；B16 的连续性持久发布依赖 B12，B10 的完整驻留时间消费也随之受约束。可先实现纯归并和 ledger status 子集，不能把部分实现标成最终验收。B12 与 B16 复用同一 ObservationCommit，不各造存储。
- B2 行删除含糊的通用「租约表」：MVP 运行槽按 02；collect 租约只在 06/B12 观测存储；browser 表留 C4。加入 D03 的逐 run 启动位置与 D06 的 ledgerId；公开导出归 B18。
- B17 仍只拥有模型材料/外发，不接管本地 export、repoId 或状态持续时间；B18 的本地白名单与 B17 的外发白名单不能混成一份全局授权。
- A8 文案更新到本轮已接受的关键证据，保留版本/形态边界。04 明确可见甲的 hud-run 是 pane shell 正在等待的前台作业，harness 是经核验的终端前台消费者；不能用 `sh -c '<hud-run> &'` 的后台形态替代。当前报告已补同 agent/session 状态、实际 context 命令、父 launcher 退出后 TTY 输入/收尾，旧「fixB2 尚待接受」及「不声称 B2 已过」须改。A8 的 fixB2 与工程 WP B2 区分命名，生产取消/复用/性能/真实父 MCP 故障矩阵仍由 B 验收。

这些是 A4 的契约收口，不构成 A9 放行。现有身份、幂等、恢复三组原型门禁继续执行；本次未发现需要为这六个问题另增常驻服务或上送 Pro 的分叉。

## 必须改的契约条目

以下是完整的 **13 项** 清单；实现验收例属于相应 ID，不另加隐含要求。

| ID | 契约 / 章节或计划位置 | 必须修改 |
|---|---|---|
| D01 | 06 B16/ObservationCommit；03 status；07 v3；设计 #23 | stateKey/stateSince/basis 的单一语义与持久连续性；时钟年龄另算；零逐 tick ledger 写。 |
| D02 | 06 新 WorkspaceContext；01 身份边界；概念 §6.4；07 类型 | 显示名、工作树根、本地 common-dir repoId 与显式副本来源分离；cwd 可未知，位置不授身份。 |
| D03 | 02 runs/幂等；04 启动/meta；05 准备；06 预算 | launch_cwd 按 run 持久冻结，workspace 单次有来源捕获；观测 cwd 不覆盖历史；Git 不入热路径。 |
| D04 | 03/04/05 控制边界；设计 §3.7/§8 | MVP copy-only；结构化动作描述；未来直接调用的固定目标、显式确认、重验及重试边界。 |
| D05 | 01 授权；02 幂等；03 resume；04 管理入口；B4/B11 | 明确定义本地管理 resume 的窄授权例外、审计主体与 expected-run/request-key；不伪造父 MCP。 |
| D06 | 07 新导出节/版本表；02 ledger 元数据 | 独立 export v1、一致快照、ledgerId 命名空间、逐 run 记录与空值；不公开内部表/view/事件日志。 |
| D07 | 07 导出隐私与合并；01 SessionRef | 路径显式 opt-in、元数据白名单、完整 ref join、confirmed/未确认/历史/冲突的范围与强度。 |
| D08 | 计划 B2/B11/B14/新 B18；概念 §15；toktrack 说明 | Producer 纳入 MVP 的独立有界工作包；消费端不阻 A4/A9/B15；不承诺自动认出任意临时副本。 |
| D09 | 06 Metric；07 v3；概念 spent；设计 #13 | costUsd 成为必有的独立 Metric，未知 value=null，单位/quality/部分合计可解释；不改 v2。 |
| D10 | 02 Deferred；06 Job 槽；C4/C5；设计 #12 | holderLabel 由未来 lease/job 读取派生；不参与所有权，不提前加 browser schema v1。 |
| D11 | 03/06/07 投影；概念 §6.5；设计状态引用 | 未确认委派显示键、freshness.state、launch_failed 与真实运行终态谓词，补 A4 类型缺口。 |
| D12 | 03 status；06 ObservationView/Commit；07 v3 | ledger 与观测快照分域加戳，旧 run 摘要不得混入当前轮；不虚称跨存储原子。 |
| D13 | 计划依赖/范围；概念 §16；01–05 证据定位 | B6→B16→B12 验收依赖、清理 B2 通用租约歧义；更新 A8 已接受范围和前台启动约束。 |

## 可删或推迟

| 项目 | 处理与 G13 理由 |
|---|---|
| 每次读取重放全部 events 来找 stateSince；每秒持久化年龄 | 删除。保存观测连续性并用 nowMs 派生，只有状态/内容变化才提交。 |
| 在 ledger 另存显示桶、图标、颜色和 holderLabel | 不做。都是可由已有事实/摘要得到的投影，会增加双份状态与写放大。 |
| remote URL 身份、跨 clone/机器永久项目 UUID、自动识别任意目录复制 | 后置。MVP 用本地 common-dir 分组和显式 declared 来源；不为了推测项目谱系建立全盘扫描/内容哈希系统。 |
| Git 每 tick 调用、每节点独立 watcher 或 repo 发现服务 | 删除。缓存、有限采集、按变化失效；未知元数据允许缺失。 |
| HUD 内直接 Resume/Reconcile 与自动救援 | 直接调用后置；自动救援不纳入该功能。保留可用的复制命令和受信 CLI，避免新增 UI 运行队列/后台执行生命周期。 |
| SQLite 公共 view、直接读表兼容保证、JSONL 双写日志、增量订阅/跨命令一致分页 | 后置或删除。先交付按需 v1 快照；asOfSeq 不冒充尚未定义的 CDC 接口。 |
| 将 toktrack 修复/其字段清单作为 A4 或 A9 前置 | 删除此依赖。现在冻结身份、来源与接口形态，consumer 独立接入，可选字段按版本规则增加。 |
| browser 租约表、holderLabel 正向生产实现、Jev export | C4/C5 前再定。A4 不为未开放能力扩张 schema v1。 |
| 新的跨库原子协调服务、控制 API 服务 | 不做。分别一致的快照加版本戳，控制复用既有 writer 入口。 |

既定的持久幂等、真实 SessionRef、运行槽、R/N/Q 终结、最小采集一致性及外发来源边界继续作为基础；本次的元数据字段不能削弱这些规则。

## 你核实过的事实

| 文件 / 只读命令 | 本次结果及证据边界 |
|---|---|
| `tmp/tasks/ORACLE2/role.md`、`brief.md` | 核实只读咨询、六个问题、只能写 answer.md、不派生 agent/跑探针/调用其他模型的范围。 |
| `pwd`、目录存在性检查、`git log -6 --oneline` | 工作目录为 MyHUD，HEAD 为 `8fdf4cf`，后续五条提交与 brief 的契约/设计演进相符。`.codegraph/` 目录实际存在；本次只读指定文档，没有定位或读取实现代码，因此未调用 CodeGraph，也未检查/创建索引。 |
| `cat`/分段 `sed` 读取 `docs/contracts/01-identity.md` 至 `07-outbound-compat.md`；`wc -l` | 核实当前版本、身份/控制/观测写者边界与 schema。02 只有 callers.cwd，没有逐 run launch cwd；七契约没有 stateSince 的完整定义。06 的观测存储与 ledger 分离；07 当前列四个版本域，没有对外委派导出协议。行数分别为 205、564、174、195、140、165、155。 |
| `git grep -n -E 'stateSince|worktree|gitCommon|repoId|costUsd|holderLabel|hud run resume|asOfSeq|租约表' -- docs/contracts docs/universal-hud-engineering-plan.md` | 核实新增字段/入口尚未落契约；cost 存在口径但缺必有独立 nullable 类型；03/06 共用 asOfSeq 的表述存在快照歧义；计划 B2 仍写通用租约表。 |
| 信息设计 §3.1–3.7、§6–10；概念 §2、§4、§6、§15–16；工程计划全文 | 核实 stateSince/worktree 要求、copy-only 默认、G13/G14、toktrack 决定、A4/A9 边界与 B6/B12/B16/B17 依赖。freshness 形状和 pending 行身份并未由现有类型说清。 |
| `tmp/tasks/A2/evidence/design-crosswalk.md` | #21/#23 的开放状态属于较早交接快照。当前 03/04 已有 reconciliation.cause/interaction/parentOffline，不能把 #21/#22 再报成缺字段；#23 仍需本次裁决。#24 的说明不是 06/07 已有 schema。 |
| `tmp/tasks/TOKTRACK1/note-hud-ledger.md` | 这是未来数据源的上下文说明，明确现在不要依赖 ledger；未包含 toktrack 最终字段需求。副本误归属及其需求来自本轮 brief/交接，不是我对 toktrack 代码或真实数据的复现结论。未读取 toktrack 私有会话数据。 |
| `docs/reviews/2026-11-01-astra-contracts.md` | 读取前次裁决，保留甲、nullable 原生退出结果、两级门禁、G13 成本边界与已延期功能；没有重新裁定或重跑其探针。 |
| `git grep -n -E '接受|通过|fixB2|review|结论' -- docs/probes/hud-run-visible.md` | 当前报告的结论及第 1、2、11 行已包含补齐事实，第 11 行限定前台 hud-run 启动形态，并保留后台启动负对照；第 12 行是监督死亡的故障语义。接受状态依据本轮 brief；本次只核对已保存报告，不将其当成生产验收或原始进程证据重验。 |
| `wc -l`、`rg -n` 与分段 `sed` 读取本答复 | 核对六个问题节、三个指定附节，以及正文/总表一致的 D01–D13；修正了 workspace 捕获与显式来源冻结、无 ledger 时游标空值的表述。仅检查文档，不冒称实现测试。 |

本次未运行构建、测试套件、探针、harness、Git 发现实验、Herdr 控制或其他模型，没有发送消息或修改输入文档/配置。只写本答复文件。文中的性能数字、CLI、DDL 增项和 fixture 均是待实施/验收的裁决，不是已实现或已测结果。
