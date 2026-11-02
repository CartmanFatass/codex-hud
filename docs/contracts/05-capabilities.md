# 05：能力矩阵、宿主与启动档案

- 版本：`v0.2 draft`（2026-11-01；A2 + Oracle D01–D13）。以下是待实现的契约，不是能力验收报告。
- depends-on：[01 身份](./01-identity.md)「SessionRef resolver 的证据边界」、I-01-1、I-01-4；[02 执行](./02-execution.md)「意图、执行权与外部提交」、I-02-1–3；[03 生命周期](./03-lifecycle.md)「resume 与 handover 事务」「wait 游标与 runId 固定」；[04 托管](./04-supervision.md)「运行、启动输入和范围」「取消与父断连」；[06 观测](./06-observation.md)；[概念 v2.3](../universal-hud-concept.md) §6.3、§6.9–12、§7、§9.1；[计划 v1.1](../universal-hud-engineering-plan.md) A2/B4/B7/B11/B14。
- 裁决优先：[Oracle consult 1](../reviews/2026-11-01-astra-contracts.md) C05、C06、C10–14 及 consult 2 D01–D13；01–04 已同步候选契约。A8 关键证据于 `8fdf4cf` 接受，仍不等于产品能力格 verified；身份、执行权、槽与终结规则由01–04拥有，本文不另设状态表。

本契约不承诺恰好一次（exactly-once）；提交结果与恢复判定只引用02。

[Oracle consult 2](../reviews/2026-11-01-astra-consult2.md) D01–D13 补齐字段、控制主体与读取边界；本轮仍是 A4/A9 候选契约，不代表 A9 放行或 B 生产能力已验证。

[Oracle consult 3](../reviews/2026-11-01-astra-consult3.md) E01–E06 同步观测绑定、取消分类、事实时序与 export v1；仍是 A9 候选，不代表阶段 B 生产验收。

冻结后生效版本：`A9 + consult4-2026-11-01`。配置形状增补依据 [Oracle consult 4 F03](../reviews/2026-11-01-astra-consult4.md#f03冻结最小配置-envelope)；此前裁决与能力格的独立验收要求保留，不改 ledger schema v1。（consult 4 增补，F03）

## 数据模型

### 会话观测绑定与受管绑定

普通已知session不要求ledger/MCP/run；受管RunBinding必须有真实runId/bindingGeneration，字段不放宽。

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

SessionBinding 顶层只保存观察字段；supervisor、childBinding、runId、bindingGeneration 只从 managed 读取，避免嵌套/顶层两份运行事实。managed=null 表示本次未附有可确认相符的受管运行投影，不证明该会话从未受管。managed 非 null 必须来自实际 ledger/run 证据，sessionRef 与外层完整判等，实例/占用证据和所选 run 的当前性相容；正常 resume 必须选择对应的新 run，不把旧绑定当当前轮。无法确认这种关联时保留普通 session 观察、managed=null，并在既有诊断/冲突投影解释，不凭相同 cwd、pane 或裸 sessionId 补关联。RunBinding.sessionRef 尚空的受管意图继续由既有 intent/run 投影表示，不能塞进这个已解析 session 结果。

occupantGeneration 是相应宿主/server 实例下的占用观察代次；确认换 occupant 才失效旧关联并更新代次。未知为 null，无宿主时也可为 null；不填默认 0/1，不从 ledger bindingGeneration、reader sourceGeneration 或 collect lease generation 借值。server 重启或观察连续性丢失须重新核验，不能让相同数字续接旧 occupant。它是现有宿主/注册表观察的元数据，不要求新建全局代次分配器或常驻服务。

SurfaceOptions.managed 是可选语义、显式 nullable 的受管启动上下文：无受管 run 时传 null；有已接受的 run 时一并提供其真实 runId/bindingGeneration。它不是执行票据，也不要求在打开 surface 前已经完成子握手。占用代次由宿主观察产生，不能要求普通调用者制造一个受管 bindingGeneration 来打开 pane。

### 能力格与证据快照

`CapabilityCell` 的键为 `(harness, profileDigest, hostKind, layout, mode, operation, resumeFrom?)`。operation 为首次 launch/spawn 或 resume；resumeFrom 为上一轮 visible/headless。一次验收只覆盖一个完整键。`support = verified | unverified | unsupported`；只有 verified 可向调用者宣称「支持」。unverified 是未验证，运行前返回 capability_unverified；unsupported 是明确超出当前范围，返回 unsupported。不得把计划排期或 CLI 返回成功当 verified。

每格保存 `versions{hudRevision,harness,host,shell,node,platform,kernel,mcpClient}`、实际启动拓扑/source、档案指纹、`evidence{script,report,reportSha256,artifactDigest,observedAt,reviewStatus}`、逐项结果及未完成项。observedAt 为毫秒 epoch；原始产物不入公开仓库。缺版本、脚本/日志、身份/输入/范围/回执核验或主审接受记录时，不升级为 verified。升级 harness、host、包装链、服务器配置或 resume 模板后，受影响格回到 unverified；其他格不自动失效或升级。

本批读取的证据如下，SHA-256 以前 12 位定位报告快照；它们是局部事实，不是托管产品格的 pass：

| 编号 | 报告 / 快照 | 有界结论与缺口 |
|---|---|---|
| E-05-1 | [A3 P1](../probes/codex-mcp-launch.md)，`758127c09e0f` | CLI 0.166.0、Node 24.22.1、WSL2/kernel 6.18.33.2，测时该 home daemon absent；TUI/exec 直接各起 stdio MCP，配置 env 可达，shell 的 HUD/HERDR/CODEX_HOME 键不继承；真正 params._meta 与 rollout 匹配，参数 spoof 未覆盖它。A3 已评审的有限结论，不是跨版本 stamping 证明或完整握手验收 |
| E-05-2 | [A3 P2](../probes/codex-dual-home.md)，`4beec7a6e34f` | 同版本双 home、同 cwd 的 rollout/MCP 分离；不证明日志活跃/空闲写入规则；MCP 自身没有 CODEX_HOME |
| E-05-3 | [A3 P3](../probes/herdr-env.md)，`0a318ac81fcf` | Herdr 0.9.5：Codex tab-root、pi 1.4.0 split 的 shell/agent env 可达；pi MCP 可达，Codex MCP 须配置注入。交叉布局未测 |
| E-05-4 | [A3 P5](../probes/cc-mcp-env.md)，`e225f76bae7f` | Claude Code 2.1.305 的 -p 直接起 MCP、env 继承、sessions 文件 pid/procStart 匹配；逐调用 metadata 无 session id。未证明原生子调用可与根隔离 |
| E-05-5 | [A3 P4](../probes/pi-resume.md)，`e30a4932377e` | pi 1.4.0 -p 的 --session id/path 追加原文件/原 id，--fork 新文件/新 id；不等于 hud-mcp resume 能力已验收 |
| E-05-6 | [A8 / A8-fixB2](../probes/hud-run-visible.md)，`8ecb4751d6d0` | CLI 0.166.0、Herdr 0.9.5、zsh/WSL2：首轮不通过；修订甲的关键证据已于8fdf4cf接受，同agent/session状态、实际context命令、父launcher退出后TTY输入/收尾已补齐。只限hud-run为pane shell等待的前台作业，后台形态失败；正常scope原生结果仍可未知，supervisor死亡为交互中断故障语义。不是工程WP B2或产品取消/复用/真实父MCP完整矩阵的pass |
| E-05-7 | [daemon 补测](../probes/codex-daemon.md)，`15031757f199` | CLI 0.166.0 + managed app-server 0.163.0 在场的默认路径仍各起直接 MCP；dotted env 多键保留，HUD_CLAIM 键可见、精确字节未测。脚本 exit=2、事后获授权清理；最终安全分支仅 bash -n，未重跑。补测尚不在 Oracle 已接受快照内；强制 daemon/shared/resume/fork 未测 |

E-05-1 的新版报告含补测链接，不把链接新增内容追认为原 A3 主审结论。E-05-7 不能改写为「所有 daemon-present 已支持」；daemon 存活本身也不证明 MCP 共享。A9 审查所声明窄路径的可行性与拒绝分支，不要求启动用户 daemon；生产矩阵归 B14。

### 目标矩阵（本批全部产品格仍未验证）

| 格 | harness / host / layout | mode / operation | 本批支持状态 | 可复用证据；放行 gate |
|---|---|---|---|---|
| M-05-1 | Codex / Herdr / tab | visible / spawn | unverified | E-05-1、E-05-3、E-05-6；B3b/B4/B5/B7/B14 |
| M-05-2 | Codex / tmux / pane | visible / spawn | unverified | 无对应完整实测；B3b/B4/B14，含 HUD_HERDR=0 |
| M-05-3 | Codex / none / none | headless / spawn | unverified | E-05-1、E-05-2 仅原生 exec；B3a/B4/B5/B14 |
| M-05-4 | Codex / Herdr / tab | visible / resume | unverified（resumeFrom=visible、headless 各一格） | B4/B5/B7/B14，旧 ref 与 fresh claim |
| M-05-5 | Codex / tmux / pane | visible / resume | unverified（两个 resumeFrom 各一格） | B4/B5/B14，含 HUD_HERDR=0 |
| M-05-6 | Codex / none / none | headless / resume | unverified（两个 resumeFrom 各一格） | B3a/B4/B5/B14 |
| M-05-7 | Claude / tmux / pane | visible / standalone launch | unverified | E-05-4 仅 -p/MCP；B8/B11，非 delegated resume |
| M-05-8 | Claude / Herdr tab、tmux pane、none | visible/headless / delegated spawn、resume | unverified，逐 host/mode/operation 分格 | C 的逐格验证；E-05-4 不覆盖全部组合 |
| M-05-9 | pi / Herdr tab、split、tmux pane、none | 合法 visible/headless / spawn、resume | unverified，逐组合分格 | E-05-3、E-05-5；C1/C3 的产品验证 |
| M-05-10 | Codex / Herdr / split | visible / spawn、resume | unverified，后续布局 | E-05-3 未测此交叉格；不能借 tab 的结论 |

host=none 只与 headless 配对。表中的组合项必须展开后独立留证；同一行不共享 pass。未列但在计划内的组合默认为 unverified。明确 unsupported：活跃/uncertain 运行的模式切换；MVP 的乙 managed 后端、无 MCP 正向身份绑定、不能隔离逻辑来源的 shared MCP；原生 Windows、跨机主动控制。shared 正向与 no-MCP 正向按 Oracle 延期；未知拓扑不冒充根上下文。Jev 是 C 阶段 JobRef 后端，不把它填成 harness/resume 格。

### LaunchProfile 与两种启动契约

档案最少包含 `name,harness,source{root,label},launch,headless,resume,resumeHeadless,host,env,mcpServerName,claimTransport,clientToolTimeoutMs,responseMarginMs,orphan_policy`；命令模板各自是 `{argv: string[]}` 或 `{shell: string, shellPath: absolute}`，只能选一种。缺所需模板或有效 source 就拒绝，不猜 executable/home。档案、已解析命令形态及非秘密配置指纹进入 02 的参数摘要；明文 claim 不进入指纹输入日志或公开导出。

（consult 4 增补，F03）delegate.json v1 顶层固定为 `{version:1,profiles:LaunchProfile[]}`，profile.name 唯一；未知版本、未知键及不合格类型拒绝。文件上限 256 KiB、最多 128 个 profile，其他字段也按共享校验器有界验证。每 profile 可选 `roles:Record<string,{model:string,effort?:string}>`；role/model/effort 解析后的实际值和非秘密档案指纹进入 02 参数摘要。角色映射仅为数据，不是可执行模板或额外调度器；缺映射只允许既有明确配置或本次请求给出的值，不按角色名称猜模型。资源约束不在本期格式，不静默接收后忽略。

（consult 4 增补，F03）`DelegateConfig`、LaunchProfile 与角色映射的唯一权威类型位于 `src/core/types/capabilities.ts`，B1 的有界严格校验器及 B4/B11/B13 引用它。`callSource:{kind:'claude_pre_tool_use_v1'}` 是本轮批准的唯一附加可选键，仅对 Claude 合法，机制/能力门禁按 consult 4 F06（B1b）；未设置的既有配置仍可解析，配置本身不授 Claude 授权或任何 verified 能力。即使配置含 managedShellVerified:true，也只是提示，B4 仍核验版本、完整档案与已接受证据。

准备阶段解析本轮实际启动的规范绝对 cwd 与请求显式 originRepoId，随02意图逐run冻结为 launch_cwd/project_origin；resume不按后来CLI目录重算。Git元数据只读有效缓存，冷缺失由已有启动/采集流程依06每代≤2子进程/200ms软预算取得，不入写事务/MCP accepted热路径/paint；未知不挡正常委派。后端包装改变实际cwd时提供06带来源的observed workspace，不覆盖历史启动快照（T-05-17）。

控制边界引用03/04：MVP HUD仅显示/复制类型化ActionDescriptor，Open/focus只按interaction/occupant能力。复制resume须有已实现/已验证的01 local_user入口、明确HUD_HOME及request-key/expected-run/mode，按02重放/03全门禁；未来直接调用需单独能力与显式确认/固定目标/执行时重验，不由宿主能spawn推定支持（T-05-18）。

| 档案规则 | launch / headless / resume 模板要求 |
|---|---|
| argv | 逐元素替换已声明占位符，直接 spawn，不经 shell 解释。若宿主只能收文本，只在最后一跳把同一 argv 安全引用；空格、引号、换行、$、分号仍是参数字节，不改变执行形态 |
| shell | 用户明确选择的文本交已解析 shell 的 -ic；函数/别名和 context wrapper 可保留。受管档案须验证为单次前台 harness 启动；任意循环、后台分支或延迟启动文本不自动获得完整托管能力。动态值按占位符边界单独引用，禁止把 brief/prompt 拼成代码 |
| Codex | 四个模板分别定义 TUI、exec、resume id、exec resume id；每轮按下节配置 env 注入。source 由档案和真实 harness 环境/根核验，不能从 MCP 缺失的 CODEX_HOME 猜 |
| Claude | 继承 env 的直接 stdio 是 E-05-4 局部运输证据；resume 的 --resume 与 -p --resume 留 C 验收，仍走 01 当前来源门禁 |
| pi | --session id/path 是续跑形态，--fork 不能填 resume 模板。指定 --session-id 可固定新 id，但不代替握手；产品 MCP 加载及 resume 留 C |

### Codex 每轮配置 env 注入（Oracle C05）

`mcpServerName` 来自已校验档案，必须精确定位用户配置中的 hud-mcp stdio 服务；不是固定字符串 hud，也不从工具前缀猜。按 TOML 键语法编码服务器名（含点/引号的名称必须安全编码或在预检明确拒绝），值用 TOML 字符串编码，再作为独立 argv 参数传递。以下只是合成 argv 的 JSON 表示：

```json
["codex", "-c", "mcp_servers.hud_demo.env.HUD_CLAIM=\"synthetic-claim-r2\"",
 "-c", "mcp_servers.hud_demo.env.HUD_RUN=\"synthetic-r2\"",
 "-c", "mcp_servers.hud_demo.env.HUD_LINK=\"synthetic-l1\"",
 "-c", "mcp_servers.hud_demo.env.HUD_HOME=\"/tmp/synthetic-hud\""]
```

只覆盖 HUD 自有叶子键；保留原服务 command/args、用户其他 env、tool timeout、安全配置和其他服务器。禁止 mcp_servers={}、整张 env 表替换、写用户配置文件或用 strict 配置清掉用户服务器。HUD_HOME 必须到达 MCP；source/home 另从档案与已核验 harness/存储根解析，不把 HUD_HOME 当 SourceId。resume 同样生成新 run 的 claim 并重新注入四个键，不读回旧 claim；正常 env 路径不要求 prompt 再复制明文凭据。

配置 env 预检不可用、但已知 hud-mcp 存在时，档案可显式选本轮启动/续跑消息传 claim，再调 whoami；它只改运输，身份判据引用 01「claim 与证据」及 Oracle C06。已提交后不得为换运输重启；无身份来源时参数 claim 也不能放行。E-05-1 的整表 probe 与 E-05-7 的 dotted sentinel 未证明所有既有配置合并、精确 claim 字节、HUD_HOME 或 resume 集成，见 T-05-4、5。

### 宿主、定位与 timeout

RegistryProvider、HostAdapter、RunControl 按概念 §6.9–12 接入。核心只依赖接口；Herdr 实现仅在 HERDR_ENV=1 且 HUD_HERDR≠0 时装载，schema/CLI/socket 版本在集成层预检、缓存并限预算。无 Herdr 用空注册表、tmux 或 headless；headless 不在 Herdr 登记假 agent。共享 Herdr 缓存按 server 隔离、默认 3 s，不为每个消费者另起轮询进程。

普通 surface 使用 SurfaceLocator，保留 Herdr 的 server/workspace/tab/pane 或 tmux 的 server/session/pane、实际可得的 ProcessStamp 及独立 occupantGeneration，不含受管 run 身份。受管路径仍使用原 HostLocator/RunHandle 的真实 runId/bindingGeneration；从 surface 组合受管 locator 时须另取实际 run 的上下文并重验关联，不能把 occupantGeneration 改名或复制成 bindingGeneration。两类 locator 都是定位与待核验快照，不是控制许可。LocatorCheck 保持 valid/stale/unknown、occupantMatches 和 foregroundInteractive；未知代次/实例不因 null==null 被判匹配，操作前必须取得足够的当前占用证据，不能确认则拒绝该控制。普通 session 的读取不因此被禁止。

普通 session 可以使用经校验的宿主 focus/navigation 等已声明能力，但不能因 SessionBinding 或一个 pane locator 获得 delegate_report/resume/cancel 权限，也不能为调用 RunControl 伪造 runId。受管动作仍按01–04鉴权、校验槽与固定目标；观察 resolver 不建立 claim、childBinding、确定委派父边或新执行权。

`delegate_wait` 的协议上限是 120000 ms，实际每次使用：

`effectiveWaitMs = min(requestedMs, 120000, max(0, clientToolTimeoutMs - responseMarginMs))`。

clientToolTimeoutMs 取本版本/档案实测或明确配置并验证的客户端 MCP 工具 deadline（另有 transport deadline 时取更小值）；Codex 对应目标服务器的 tool_timeout_sec。responseMarginMs 必须为正，覆盖序列化、调度与运输余量，基准记录实际配置及返回尾延迟；不能照抄文档默认 60 s 当所有客户端事实。无可信 timeout 或余量已耗尽时只返回立即读取的一页/同一 runId 与游标，并标 timeout_configuration_unverified，不悬挂长等。示例配置 60000/2000 时最多等 58000 ms；这不是本批测得的客户端值。分页/匹配/游标规则只引用 03；短等结束或客户端断开都不等于 cancel/failed。后续继续固定原 runId/nextSeq，不重新按 link 解析下一轮。

## 不变量

| 编号 | 断言 | 测试 |
|---|---|---|
| I-05-1 | 支持声明绑定完整能力键、版本、档案和已接受证据；未测格始终 unverified，未声明能力不猜；delegate.json 解析成功、callSource 选择或 managedShellVerified:true 都不自证能力，仍按完整版本/档案/已接受证据验收（consult 4 增补，F03） | T-05-1、2 |
| I-05-2 | argv/shell 互斥，source 显式且核验；逐run启动位置冻结，Git不进热路径；shell 单次前台启动形态经验证，不能把任意文本升级为受管能力；v1 envelope/严格键/类型/唯一名称/文件及 profile 上限必须校验，可选 roles 仅数据，实际 model/effort 入 02 digest，缺映射不猜，资源约束键拒绝（consult 4 增补，F03） | T-05-3、6、17 |
| I-05-3 | Codex 按服务器名仅注入四个 HUD 叶子键，保留其余配置；HUD_HOME 到 MCP、resume 新 claim，运输不等于身份 | T-05-4、5 |
| I-05-4 | 观测SessionBinding非null必有完整ref，无可靠唯一选择返回null；普通SurfaceLocator用独立nullable occupantGeneration，无假run/受管代次；managed仅真实相符当前run，ref/实例不符不升级关联；控制前校验实例/occupant，未知拒绝但可有预算读取，管理copy-only与权限仍依01–04 | T-05-7、8、18 |
| I-05-5 | 只有预检证明命令从未提交才可选 fallback；任何 dispatch 已发/结果未知都交 02 对账，不再启动 | T-05-9、10 |
| I-05-6 | 可见托管采用修订后的甲，原生结果可未知；父断连 continue 与 supervisor 死亡分开验收，乙无 MVP managed 能力 | T-05-11、12 |
| I-05-7 | 有效 wait 含客户端余量且≤120 s；短等/断线保持原 run/游标，无取消或终结副作用 | T-05-13、14 |
| I-05-8 | Herdr 可整体关闭，核心无 Herdr import；env 三跳与布局逐格验证，不外推 | T-05-8、15、16 |

## 状态机

能力证据流为 `unverified → verified`（同键验收完整且评审接受），受影响配置变化后 `verified → unverified`；明确超出范围为 unsupported，未来开放也须先回 unverified 再留证。此流不改变 link/run 状态。

宿主启动只经过 `preflight → selected → dispatch → observed`。preflight 失败且有未提交证明，可在同一意图提交前选择已验证核心宿主并冻结最终档案；若该选择改变 02 参数摘要，重新按最终参数处理，不能重放已接受意图却换命令。dispatch 一旦可能发出，进入 02 的原 run 对账入口，不能跳回 selected。其 failed/uncertain 判定及重试禁令以 02 为准。

可见模式按 Oracle C10 选择甲的组终止路线；生产 ScopeControl/封口/终结由 04 定义。supervisor 死亡时停止自动 input/focus、标交互不可用并按 02 持槽对账；不自动 fg、重建 wrapper 或 resume。父 MCP 断连的 continue 则须保留子前台、输入与最终收尾，不能拿无 TTY sleep 的实验替代。乙只保留探针/未来观察模式材料；不得在甲提交失败后转乙再发。

## 失败案例

| 编号 | 场景 / 预期 | 不变量 | 测试 |
|---|---|---|---|
| F-05-1 | 用 tab-root env 结果宣称 Codex split/resume 已支持 → 格仍未验证 | I-05-1、I-05-8 | T-05-1、2、15 |
| F-05-2 | shell 函数切 home、argv 元字符被执行、循环档案多次起 harness → 预检拒绝或身份未知，不猜绑定 | I-05-2 | T-05-3、6 |
| F-05-3 | 整表注入覆盖用户服务、HUD_HOME 缺失、resume 复用旧 claim → 验收拒绝且不二次启动 | I-05-3 | T-05-4、5 |
| F-05-4 | pane 换 occupant、server 重启、supervisor 死而旧 TUI 画面仍在 → 不向 shell/新人输入 | I-05-4、I-05-6 | T-05-7、11 |
| F-05-5 | Herdr dispatch 超时后 tmux 重发，或 fallback 改已接受参数 → 禁止，查原 run | I-05-5 | T-05-9、10 |
| F-05-6 | 客户端 60 s、服务等 120 s，断线自动取消 → 截短并按同 run/cursor 续等 | I-05-7 | T-05-13、14 |

## 测试清单

每行是规格，未在 A2 执行。A9 是 fixture/窄原型与 A3/A8 可行性门；B 是 B3–B14 生产验收；C 与 v1.1 不阻塞 MVP。所有数据合成；真实客户端试验需独立 brief 授权。

| 编号 | Gate | 输入 → 断言 |
|---|---|---|
| T-05-1 | A9 | 只有 CLI 成功/单跳 env/计划排期，缺版本或日志/接受记录 → 无 verified 格；矩阵默认 unverified；合法 v1 envelope/roles 或 managedShellVerified:true 仍不授 verified；未知版本/键、错类型、重复 name、文件>256 KiB 或 profiles>128 均拒绝（consult 4 增补，F03） |
| T-05-2 | B | 每个 Codex 产品格逐一验身份、输入落点、退出/槽与不重复提交；改 harness/profile/host 版本仅使受影响格未验证；保留原证据快照 |
| T-05-3 | A9 | 空格、引号、换行、$()、分号参数与显式 shell 两组 → argv 字节不成为代码；双形态/空模板拒绝；shell 延迟/循环不授完整托管能力；roles 只接收 model:string/effort?:string 的有界数据，未知资源约束/模板键和不合格类型拒绝，不静默忽略、不执行角色映射（consult 4 增补，F03） |
| T-05-4 | A9 | 合成既有 command/args、多 env、其他服务器、安全/timeout 配置，含带点服务器名 → 只改四个 HUD 叶子；参数/TOML 正确；精确 claim/HUD_HOME 字节到探针 MCP，日志无明文 claim |
| T-05-5 | B | TUI/exec 的 launch 与两个 resume 模板分别启 MCP → 每轮新 claim/同 HUD_HOME/同 source，其他配置保留；验证 01 握手，不把旧凭据带到新 run |
| T-05-6 | B | 两 home 同 cwd、函数实际 home 与档案错配、完整 exec 包装链 → source 错配拒绝；仅实测同实例才认 harness 是直接子进程 |
| T-05-7 | B | pane 数值复用/server 更换/未知 occupant/前台回 shell → 控制均拒绝，关系历史不变；新 occupant 不收到按键/焦点 |
| T-05-8 | A9 | 假Host/Registry/RunControl、Herdr不可用/禁用仍核心可用，未提交才fallback；无ledger/MCP/PID/宿主的完整已知ref可bind/open，普通surface无runId/bindingGeneration/supervisor、SurfaceOptions.managed=null；null ref结果拒类型、歧义返回null，binding/occupant/source代次取不同合成值；managed与外层完整ref/实例/当前轮不符不升级关联，stale/unknown occupant无控制（含null不作匹配）；scripted fake不是A6/B真实核验证据 |
| T-05-9 | B | dispatch 前预检失败与已发后超时/断连两组 → 前者可明确选择最终核心档案，后者仅原 run 对账；合成提交计数不增加 |
| T-05-10 | A9 | fallback 改参数摘要、同 key 原 accepted 重放 → 遵守 I-02-1，不能以宿主切换修改原结果或再提交；按 02 T-02-2 核对解析后的实际 role/model/effort 及非秘密档案指纹进入摘要，缺角色映射不猜模型，等价键序不改变实际值（consult 4 增补，F03） |
| T-05-11 | A9 | 复用已于8fdf4cf接受的A8-fixB2关键证据与supervisor-death反例 → 同agent/session、实际context命令、父launcher退出后TTY输入/收尾及前台形态边界明确；后台负对照/原生结果未知/监督中断保留，乙managed拒绝；不据此声称工程WP B2或B生产能力已过 |
| T-05-12 | B | 真 TTY 下父 MCP/launcher 退出且 continue → 子同一实例仍前台可输入、正常结束可收尾；另 supervisor 死亡按 04 故障分支处理 |
| T-05-13 | A9 | 请求120000、客户端60000、余量2000；再缺 timeout/预算不足 → 最多58000或立即返回，同 run/正确 nextSeq，无 ledger 写；计时含响应余量 |
| T-05-14 | B | 各受支持客户端实测 timeout/尾延迟；短 wait 多次、断开重连且 link 新轮出现 → 始终原 run/游标，零 cancel/failed 副作用 |
| T-05-15 | C | pi/cc 与各布局/模式/resume 的版本匹配验证；pi --fork 反例 → 逐格留证，不继承 Codex 或 tab 的 pass；fork 不作 resume |
| T-05-16 | v1.1 | 新增 shared 正向/no-MCP 正向/后续布局前 → 先补 01 的独立来源/拒绝反例和逐格证据，未实现阶段仍拒绝 |
| T-05-17 | A9 | shell包装改cwd、CLI换目录后resume、Git冷缓存/超时 → 每run冻结实际启动输入与显式origin，观察位置另存；Git不在热路径/写事务，缺失有原因且不重启 |
| T-05-18 | A9 | 宿主可起进程但HUD R仅复制、local入口未验证、目标换run、恶意label → 无控制CLI启动或虚构可用resume命令；能力/固定目标按03/04，已验证入口命令参数完整 |
