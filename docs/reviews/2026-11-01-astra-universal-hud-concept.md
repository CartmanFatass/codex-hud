# 通用 Agent HUD 架构评审

评审对象：`docs/universal-hud-concept.md` v1（2026-11-01），并对照调研稿、现有实现及本机只读证据。下文是设计判断，不是实现验收；没有启动新 agent、修改配置或运行会产生文件的测试。真实会话正文、命令内容、身份标识及凭据均不收入本文。

## 1. 总体判断

**方向成立，但不建议按当前阶段 0 开工。** 三种 harness 共用树、Inspector、布局与公共指标是合理的，`SessionEvidence` 也值得保留。当前方案尚未定义清楚的是：一个节点究竟代表会话、线程还是一次进程运行；委派关系何时成立、失效；不同来源的状态和用量怎样比较；多个 HUD 进程怎样共同使用解析状态。这些契约会影响持久化、树、模型输入和全部宿主，先搬动 28k 行代码不能消除风险。

建议先批准一个窄的纵向实现：保留现有 Codex 路径，在稳定身份与统一摘要接口外包一层；接入 Claude 的明确会话绑定；让一个 Claude 根通过显式链接记录看到一个 Codex 子会话及其原生子线程。链接 CLI 与委派 skill 同批交付。短命 statusline 继续保留，常驻采集器可选；完整 claude-hud 替换、全目录迁移和品牌改名后置。以下前六项的契约应先写进概念稿，再固化公共类型和磁盘格式。

## 2. 会导致返工的问题

### 2.1 [阻断] `SessionRef` 缺少身份范围，且把会话、线程、进程和 pane 混为一体

**问题：** §4 把 session 定义成“一个进程及其 transcript”，§6 又用 `harness + sessionId` 作为节点、快照和父子关系的基础，尚不足以唯一定位实际对象。

**为什么：** 抽查的三个 Claude 子代理文件，其记录的 `sessionId` 都等于父会话，另用 `agentId` 区分。只加 `harness` 会把父子合并。Codex 共享 daemon，TUI 可以 resume；同一个 Herdr pane 也可以先后承载不同会话。Herdr 明确说明 pane 移动会改变 workspace-qualified ID，ID 又只在一个 server 内有效。现场同时存在两个 Codex home，而现有启动器已按 cwd 与有效 home 隔离会话。新的 `home(env)` 与全局状态目录不能丢掉这种隔离。

**建议改法：** 至少区分三个对象，不必为此建立大型框架：

- `SessionRef`：`harness + sourceId + sessionId + nativeThreadId?`。`sourceId` 标识已解析的存储根/配置 profile；Claude 的原生子代理必须包含 `agentId`。路径是定位信息，不替代逻辑身份。
- `RunBinding`：被观察的进程实例、PID/start time、Herdr server 范围、pane/terminal 定位、当前 session ref 和绑定 generation。HUD 自己所在的 pane 与被观察 pane 分开。
- `DelegationLink`：连接两个明确对象的关系，拥有独立 ID 与有效期。持久关系与当下 pane 位置分开，关闭 pane 后保留历史关系，禁止把旧关系套到新 occupant。

在 statusline 模式，调用方明确提供的 `session_id + transcript_path` 应优先，Herdr/PID 记录用于交叉核验。§7.2 当前把 stdin 放在第三位，会让旧 registry 覆盖当前会话。cwd、启动时间和“最新文件”只能产生候选，存在歧义就不绑定；恢复旧会话也不能要求文件创建于 HUD 启动之后。

**影响章节：** §4、§5.1、§6.3–6.8、§7、§9.1、§12。

### 2.2 [阻断] 链接协议把发现线索当成关系事实，冲突处理还会静默改父节点

**问题：** “最强证据胜，同级取最近”不能保证正确父子关系；三个并列机制没有统一的关系生命周期。

**为什么：** 父 transcript 中出现启动命令，不证明命令成功，也不证明其中的变量、名字对应现在这个子会话。同名 agent 可重新启动，标签可改；pi 的 `--orchestrator` 是问题通知目标，并非天然的创建者证明。继承的 `HUD_PARENT` 可能使 A→B→C 被误画成 A 的两个孩子；进程退出后该证据又消失。当前公开 Herdr schema、agent 输出和 snapshot 中未发现创建者或委派父字段，不能以它替代协议。

§8 的 pi 配方还有具体缺口：`pi-role --args` 只输出参数；本机 `AgentStartParams` 只有 kind/name/pane/args/timeout，没有 env 字段。仅给调用方的 `herdr agent start` CLI 加环境变量，不能作为目标 pane 已收到它的证据。`tab.create` / `pane.split` 的 schema 倒是提供显式 env，但那也只是运输途径。

**建议改法：** v1 采用**一种持久、显式的链接记录作为事实来源**，由 `hud link` 写入，两个 skill 在创建/绑定阶段调用它。最小记录包含 `schemaVersion`、`linkId`、完整 parent ref、child ref 或尚未完成绑定的目标定位、创建时间与状态；启动前后可经历 `pending → bound`，启动失败/超时保持未绑定，后续可显式撤销或替换。重复调用按 linkId 幂等。优先使用每条关系一个私有原子 JSON；若用 JSONL，必须明确并发追加、半行恢复和版本规则，禁止 skill 自行 `printf >>`。

`HUD_PARENT` 可删掉，或只运输一个 linkId，最终仍归并到同一记录。`hud env --parent` 必须得到“当前会话自己”的身份，不能把继承到的父身份继续传下去。父 transcript、标签和通知 pane 在 v1 只生成候选；没有确认关系时不自动读取候选的正文。两个互相矛盾的显式关系应显示冲突并停止归属，不能以时间最近自动选父。

关系在存储中独立于树；UI 仍可投影成树。v1 可以约束一个运行实例只有一个委派所有者，但须检测自环、祖先回环和重复节点。`origin` 是这次父子关系的属性；`delegated` 与 L1/subtask/review 不是互斥分类。

**影响章节：** §2 G3/G4、§5.2、§6.5–6.7、§8、§11、§13。

### 2.3 [阻断] “模型默认关”不足以保护已经启用模型功能的迁移用户

**问题：** §11 将外包 transcript 与原生节点同等送入 brief，§12 又自动迁移旧设置，实际扩大了既有外发授权的范围。

**为什么：** 本机两个旧 HUD 设置文件均已有启用且未暂停的模型 backend；只改变新安装默认值无效。现有 label、progress、digest、failure cause 等功能也并非都由 `briefAgents` 统一控制。若沿用旧设置，新发现的 Claude/pi 消息可能立即进入已有模型任务。读取一段本地公开消息与允许把它交给另一个模型，是两个不同决定。

**建议改法：** 明确分开本地读取范围与模型材料范围。本地默认读取当前明确绑定会话、原生子代理，以及显式登记且无冲突的外包会话；提供关闭外包正文读取的设置，关闭后仍可显示登记元数据与 Herdr 状态。推断候选默认只显示元数据。新增来源的正文进入模型功能默认关闭，旧 Codex 授权不能自动扩展到它；开启时用统一的材料构建入口执行范围检查，覆盖所有模型功能和缓存，不只 brief。

每个适配器先做正向的公开内容白名单，再生成报告/摘要材料。实测 Claude 和 pi 的 assistant content 都混有 `thinking`，Claude 还有完整请求 blob；不能把原始 content、attachment 或 `extra` 整包序列化。磁盘解码不可避免地经过记录字节，隐私承诺应准确写成“不提取、保留、展示或外发私有块”，未知类型同样不进入材料。

**影响章节：** §2 G8、§6.4、§7、§11、§12；现有架构文档 §5.4。

### 2.4 [高] `SessionEvidence` 的方向正确，但字段同名尚未形成共同语义

**问题：** 把 `RolloutParseResult` 与 `HudData` 的字段搬进一个对象，再留一个 `Record<string, unknown>`，不足以成为稳定接口。`context`、`usage`、`turns` 的含义没有写定，也没有可靠表达不支持、未知、过期、估计值。

**为什么：** `HudStatus` 还采集 Git、项目配置、bridge health，不能全部成为 transcript reader 的职责。Codex 的 input 已包含 cached input，而 Claude/pi 的缓存字段需要按各自口径归一。实测 Claude 有 30 个 assistant message ID 出现多条记录、usage 完全相同；逐行累计必然重复。pi 同时存在 assistant usage、`usage(kind=cache_warm)` 和带 usage 的 `compaction`；这些费用不都代表当前交互上下文。其 `totalTokens` 包含 output，不能与 Claude 的输入口径无说明地对齐。模型/窗口切换、压缩、历史分支也不能用“最新一条任意 usage”处理。

**建议改法：** 保留“小的共同观测摘要 + 类型化能力”的接口：身份、实际观测模型、活动/等待、当前上下文观测、累计花费、公开报告摘要、拓扑引用。Git、宿主健康和布局留在公共服务/视图组装层。计划与 todo 可投影为共同 progress；quota、goal 等真正专有功能用类型化可选能力或扩展模块，不用无类型袋子，也不让全部 bar/card 各自重写一遍 harness 分支。

在适配器内部定义并测试：请求级 ID 去重/更新规则；累计 counter 与逐请求 delta 的区别；cache 是否包含于 input；上下文的测量口径、窗口来源、压缩后的有效性；费用是否仅本节点或已含后代；速率的采样区间和估计方法。未知费用/窗口不能默认成 0，记录的零成本也不能自动宣称免费。指标附 `source`、`observedAt/asOf` 和 `reported/estimated/unknown` 等必要信息；跨节点合计仅在口径与覆盖范围已知时进行。

`children(ref)` 与 `evidence.native` 还应选定一个拓扑权威来源，另一个只引用其结果，避免两次扫描、两套父子判断。统一的是供展示消费的语义，不必统一三种 harness 的全部原始事件。

**影响章节：** §6.1、§6.3–6.5、§7.2–7.3、§9.3、§10。

### 2.5 [高] Herdr > transcript > 进程的固定优先级混淆了活动、完成和新鲜度

**问题：** Herdr `done`、一次模型 turn 完成、agent 生命周期结束以及任务验收通过不是同一个状态；不能压成一个有全序优先级的枚举。

**为什么：** `herdr --skill` 明确说明 `done/idle` 与是否被查看有关，focus 会标记已看；`unknown` 不证明完成，保留的 agent 身份也不保证仍在前台。现场 `agent explain` 的 Claude 状态来自 prompt-box 规则，Codex 来自 OSC title 规则。这是有价值的实时 UI 证据，不是持久任务结果。schema 已提供 `completion_seq`，其注释明确把完成观测与是否被查看分开。旧 transcript 的开放工具也可能因中断而永不闭合，不能让它永久推断 running。

现有 `SubagentStatus` 没有 idle/waiting，`agentCounts` 仅把 running/starting 视为 active。因此“计数照旧”无法接纳新状态，blocked 可能落入 unknown。

**建议改法：** 最少分离 `activity`、`pendingReason`、`lastTurnOutcome`、`liveness`、`freshness`，再投影为一行状态。只有绑定到同一运行实例、且当前有效的 Herdr 状态才参与合并；它优先回答当前交互是否 busy/blocked，不覆盖明确的 turn failure。`unknown` 允许回退到有效文件证据；进程存在只证明存在。来源失联时保留最后值并标 stale，不伪造完成。使用事件时间/序列与观测时间两个概念；不能每次轮询给旧事件盖新时间。

为 waiting、idle、历史 completed 与下级仍在工作的聚合写出真值表，明确 notice 由哪类变化触发，避免仅切 tab 就再次“完成”。

**影响章节：** §6.3、§6.5–6.7、§7、§10、§13。

### 2.6 [高] statusline 快照不能同时充当解析 checkpoint 和多宿主共享状态

**问题：** “快照新鲜就直接渲染，否则自己增量解析并回写”没有写入者协调，也把展示快照误当成可恢复的 parser 状态。

**为什么：** 现有 `SnapshotWriter` 特意不为时钟和成功读取时间单独重写；安静但健康的 panel 超过 10 秒即可被新规则误判过期。现有输出只含展示摘要，且包含某一视图的 `bar.segments`。`RolloutParser` 的 pending calls、去重与累计状态、rate tracker、文件 identity 都在内存中；一个 offset 无法跨短进程延续这些状态。`createParseQueue` 只是一个进程内闭包，不协调 panel、watch 与多个 statusline 进程。原子 rename 防半文件，不能防两个写入者丢失更新。旧实现还在退出时清理自己拥有的快照，与短命进程留下可恢复缓存的目标不同。

**建议改法：** 分开三类数据：版本化 reader checkpoint、供消费者读取的会话摘要、按 HUD 实例保存的布局/点击状态。checkpoint 与 offset 同一次提交，包含 file identity、reader schema、source generation 和恢复所需状态。每个 session/source 同时只允许一个采集写入者，使用跨进程锁/租约及失效接管；其他消费者读已提交结果。心跳或采集有效期与内容更新时间分开，不能用 JSON mtime 代替存活。

保留短命 statusline 入口。它每次先采用本次 stdin 的会话、模型、上下文等明确字段，再按字段补充兼容缓存；“快照不到 10 秒”不能允许它覆盖更新的 stdin。无常驻采集器时，调用同一个有预算、可恢复的增量 reader；竞争锁失败就快速使用已有结果/基本 stdin 字段。`hud watch` 是可选的持续采集宿主，不必成为系统级服务，也不要维护第二套解析实现。首次追赶大文件应报告部分覆盖，而非阻塞整条 statusline。

当前 statusLine wrapper 还处理了 `COLUMNS` 缺失、`/dev/tty` 宽度和边距，不能只保留 tee 就声称替换等价；必须保留 toktrack 分流及有效宽度获取。

**影响章节：** §6.3、§6.8、§9.3–9.4、§12–14。

### 2.7 [高] “现有 reader 已满足有界读取”不成立，深度上限也不限制整棵树的成本

**问题：** 现有实现的有限文件快照不等于每次调用有字节/时间上限；§14 的性能目标缺少可执行的 reader 与调度契约。

**为什么：** `rollout.ts:849` 的循环从当前 offset 一直读到采样的 fileSize；64 KiB 是分块大小，不是本次总预算。未遇换行时 `pending` 持续增长，随后单次 `JSON.parse` 仍同步执行。Claude 样本中的 assistant/user/attachment 首键是 `parentUuid`，并非 `type`；不能把行首 type 匹配当成完整记录分类器。pi 样本也包含图片块和很大的工具记录。与此同时，深度 4 的树仍可能拥有很多节点，每个 reader 再做全目录发现或每个 panel 各拉一次 registry，会把同一工作重复多次。

**建议改法：** 定义每次读取的字节/记录/时间预算、单记录上限、未完成尾行处理、追赶游标和 coverage 状态；超大行按类型安全跳过或流式处理，不能无限扩展 Buffer。可以对确认的已知 blob 前缀做跳过优化，但其余记录不能因为 type 不在前面就丢弃。压缩/恢复/分支变化与文件截断分别处理，未知格式显示能力不足。

按 source/session 复用发现与解析结果；树遍历有 visited 集合和总节点/总 I/O 预算，活跃与当前可见节点优先。不可见历史保留身份和最后状态，明示尚未加载/截断的范围。性能验收分别测冷启动、普通增量、超大单行、无结尾换行、重写、宽树和多个消费者；“100 MB 一次 tick <50 ms”要说明追加量、硬件、是否含冷追赶及观测分位数。

**影响章节：** §6.3–6.5、§7、§9.3、§13–14。

### 2.8 [高] host 不能只抽绘制位置，启动与导航还带有 harness 特有行为

**问题：** §6.8 的 host 设计没有覆盖身份传递、输入转发和导航；§9.1 又同时承诺 argv 形式与“命令原样敲入 shell”。

**为什么：** 现有 launcher 给外层 attach 固定标记 `HERDR_AGENT=codex`，桥的进程/title 检测也只认 Codex。直接换启动命令并不能让 Claude/pi 获得正确 Herdr 身份。`tree-page.ts` 的跳转调用 Codex `/subagents` 导航；`herdr agent focus` 只能定位宿主 pane，不能自动选择里面的原生线程。`hud panel` 新开的 pane 也不能把自己的 Herdr identity 当作被观察会话。另一方面，shell 已经消费了命令行引号；把 `--` 后 argv 简单拼成字符串会改变空格、引号与 shell 元字符的语义。

**建议改法：** 把宿主定位、聚焦与按键运输放在 HostAdapter；原生线程导航是 harness 的可选能力。不支持导航的 Claude/pi 原生节点仍可打开 Inspector，不能向它发送 Codex 指令；delegated 节点先校验当前 occupant，再聚焦。宿主 attach 的身份标记/桥也要按实际 harness 选择，并保持现有原生 session hook 的所有权。

明确两种启动契约：argv 模式负责安全引用参数，shell-text 模式接受一整段明确的命令文本以支持别名/函数；不要承诺能从 argv 恢复原始 shell 文本。launch profile 同时定义或确认有效 transcript source，不能只让 zsh 函数切换账号却仍从 HUD 原环境的 home 读取。跨 pane 的环境通过目标 pane 明确传递或绑定登记，不依赖调用方 CLI 的环境继承。

**影响章节：** §2 G1/G6/G7、§3、§6.3、§6.8、§8、§9.1、§10、§13。

### 2.9 [高] 全局目录迁移与“旧字段不删”不足以保住兼容性

**问题：** 一次性迁移 scan、日志、模型缓存、设置与快照，缺少多 profile、并存进程、格式版本和旧命令的处理规则。

**为什么：** 两个 Codex home 可以有不同模型连接与权限。全局 `~/.hud/settings.json` 的“首次拷贝”由谁先启动决定，可能错误合并账户边界。实际公开快照为 version 2，节点位于 `agents.nodes`，按 tmux session 命名，并没有方案里写的 `tree[]`；路径、状态枚举、计数含义变更都影响消费者。`SCAN_VERSION` 只管树扫描缓存，不能为快照、链接和 parser checkpoint 一并升级。旧 `codex-hud` 没有 launch 设置仍可启动，而新别名按 G6 会报错，这也不是纯重构。

**建议改法：** 先引入带 profile/source 范围的新存储访问层，旧状态保持可读，新旧进程不争写同一格式。可丢弃的扫描缓存按版本重建；设置、模型授权、预算与连接不能盲目合并。分别版本化 public snapshot、reader checkpoint、link record，定义旧 `--json` 与旧 launcher 的兼容 facade 或明确宣布破坏性版本并修订 G7。已有授权只作用于原范围。改名、环境变量退役与自动迁移分开发布；一版别名不是完整迁移方案。

**影响章节：** §2 G7/G8、§6.8、§9、§12–13。

### 2.10 [高] 阶段 0 同时改变最多契约，却在阶段 3/4 才验证核心价值

**问题：** 阶段 0 把目录搬迁、公共模型、host、启动语义和持久化改在一起，还称作“只重构”；完整 statusline 替换早于强链接与 Herdr 原生 panel。

**为什么：** Codex 测试全绿，只能证明已有 Codex 行为，不能验证新接口能承载 Claude 的共享 sessionId、重复 usage 或 pi 的 compaction。先把公共类型固定为 Codex 的投影，接入第二种 harness 时仍会重抽。G3 才是该项目相对已有两个 HUD 的主要收益，却依赖最后才修改的 skill。G5 的完整替换还会让大量无关的显示功能阻塞跨 harness 的验证。

**建议改法：** 阶段 0 只增加身份/接口草案、旧 Codex facade 与必要契约样例，保留文件位置、现有目录和命令默认行为。随后以真实纵向场景定型接口：Claude 明确绑定 → 显式登记 Codex 子会话 → 显示其 native 后代 → 加最小 pi adapter；同阶段提供必要的 Herdr panel 入口与 skill 接线。再完善 Claude native、独立 statusline、性能和功能对照，达标后切换默认；最后才做可选改名/迁移。

验收增加会改变设计的案例：同 cwd 多会话和双 home；Claude 根与多个子代理共 sessionId；同 pane 换会话/resume；链接晚到、重复、冲突、循环、关闭后保留历史；stale/unknown registry；重复 usage 与压缩；panel/watch/statusline 并发；迁移后新来源仍未获模型外发授权。旧测试与视觉基线继续保留，但不拿测试数量代替这些契约。

**影响章节：** §2、§7–9、§12–14。

## 3. 对 §15 七个问题的逐条回答

### 3.1 `SessionEvidence` 是否合适，还是只统一树？

**统一到一个收窄后的 `SessionEvidence`，不只统一 `AgentTree`。** 身份、上下文、活动、用量与公开报告确有共同展示需求；只统一树会把这些语义在 bar、卡片、statusline 各复制三份。但不要把 parser 原始状态、Git、宿主健康和任意 `extra` 混成一个总对象。采用共同观测摘要、可选类型化能力与公共视图组装器。Codex quota/goal 等专用模块保留，按能力出现，不要求“harness 差异只能有一个目录里的一处 if”。先用 Codex 与 Claude 两个具体实现验证这个边界，再决定目录结构。

### 3.2 是否有更简单的单一链接机制？

**有：显式、持久的链接记录；当前 Herdr 公开 API 不能替代它。** 本次 agent list/get、snapshot 和 bundled schema 未显示委派父或创建者字段；`caller_pane_id` 出现在 current-pane 定位请求里，不是持久 lineage。即使将来有 tab 创建者，它也未必等于当前 agent 的任务父级。

两个 skill 已经记录 tab/pane/session 信息，追加一次结构化 `hud link` 登记成本低。环境变量最多携带登记 ID，解析 shell 命令仅保留为候选发现。优先完善确认 child identity、幂等与冲突规则，取消三种来源各自直接决定父节点的设计。

### 3.3 statusline 应否改成常驻 `hud watch`？

**不做必需的全局 daemon；保留短命 statusline，允许 panel/watch 充当持续采集器。** standalone 是明确目标，依赖 daemon 会增加安装、重启、版本共存和故障恢复成本；已有 stdin 足够立即画出一部分核心指标。

但“短进程”不等于“只保存 offset”。独立模式需要跨进程安全、可恢复的 reader checkpoint；watch 与短命路径共用 reader，只改变谁持有采集租约。statusline 优先本次 stdin，快照补充树/工具/Git 等信息，昂贵冷追赶受预算限制。若第一版还没完成这一契约，就保留旧 claude-hud 默认，不把后台 watcher 暗中变成 G5 的前提。

### 3.4 阶段 0 一次性抽接口，还是先加 cc？

**先用薄接口包住 Codex，再立即做最小 cc 纵向实现；不先搬 28k 行，也不复制一个完整 cc HUD 后再抽。** 推荐顺序如下：

| 步骤 | 交付与通过条件 |
|---|---|
| A：小契约 | 明确 SessionRef/RunBinding、观测口径、reader 与 link 格式；现有 Codex 经 facade 仍运行，旧状态不迁移 |
| B：跨 harness 主路径 | Claude 绑定与最低限度读取、显式 link、Herdr 定位、Codex native 孙辈；两种来源在同一树和 Inspector 可解释 |
| C：第三适配器 | 最小 pi reader 与确定绑定；三 harness 场景通过，声明缺失能力，避免猜值 |
| D：完整替换 | Claude native、statusline 独立恢复、现有已启用功能对照、并发与性能达标；然后替换 claude-hud |
| E：整理 | 目录搬迁、名称、旧命令退役及可恢复迁移分别处理 |

这保留了重构纪律，也让第二种格式在接口尚可改变时提供反馈。

### 3.5 Herdr > transcript > 进程是否有反例？

**有，而且是正常使用场景。** Herdr 的 done 被看过后变 idle；unknown 不应压过明确 transcript failure；已经换了会话的 pane 不应给旧 transcript 提供状态；保留身份的后台进程不等于前台工作；父进程 idle 时 native 子代理仍可能运行。

采用按字段、实例与新鲜度合并。Herdr 擅长当前交互状态，transcript 擅长记录过的 turn 结果和用量，进程只补存活。保留冲突来源；completion_seq 可帮助识别与查看无关的完成观测，但不证明任务已验收。

### 3.6 读取其他 harness transcript 要不要开关，默认怎样？

**需要范围开关，但本地读取与模型外发分开。** 当前会话与 native 默认读；通过显式链接确认的 delegated 公共内容默认本地读，以实现 G3，并可设置为只读元数据。弱/中推断候选默认不读正文。新增外包来源进入模型材料默认关，已有 backend 开启不自动授予它权限。该范围检查覆盖所有模型功能和历史缓存，不依赖卡片是否可见。

### 3.7 三个月内最可能返工的遗漏是什么？

**首先是身份、事件语义和多消费者协议，而非第四种 harness。** 特别要写清：恢复/分支/模型切换与启动时间的关系；Claude 子代理的复合身份；schema 演进与去重；委派关系历史和 pane 当前 occupant 的分离；单写入者与多视图状态；同用户多 home 的设置/授权范围；单行和整树预算；宿主导航能力。

不要承诺 transcript 能恢复所有实时信息：无新写入时，某些活动视图或分支切换可能无法仅由文件确认。v1 明示未知/最后观测；真有精确性需求时，再采用明确支持的本地状态钩子/快照扩展，并单独说明可观测边界。本次没有验证 pi 在所有分支导航操作下的落盘行为，不能把这个边界当作已解决。

## 4. 建议删掉或推迟的东西

- **删除 v1 的自动 Bash 命令成链和“同级取最近”。** 保留候选诊断即可；skill 与显式链接同批上线。
- **推迟整体 `harness/codex/` 搬迁、包名/所有环境变量改名和全量旧目录导入。** 先用 facade 验证接口；扫描缓存通常重建更简单。
- **推迟 pi footer、全局 daemon 与事件订阅优化。** Herdr schema 已有订阅能力，但 v1 有范围的轮询足够；订阅仍需要启动快照、重连后重新核对与旧 server 回退。
- **推迟完整 claude-hud 替换和 delegated 模型摘要。** 先让确定身份、树、活动与 Inspector 链接证据工作。§9.3 对照应以本机实际启用功能为准；当前插件还有用量窗口等代码路径，列出的几项不能代表全部兼容范围。
- **不要预建任意未来 harness 的插件平台或通用事件总线。** 三个内置 adapter、小的类型化能力和独立关系记录已足够；也无需把图结构直接暴露成复杂图形 UI。

## 5. 核实过的事实与证据边界

### 5.1 仓库和已读实现

| 文件/只读操作 | 实际核实的内容 |
|---|---|
| `tmp/oracle-astra/role.md`、`brief.md`；父级 `AGENTS.md` | 评审范围、只写本文件、不派生 agent、CodeGraph 优先规则 |
| `docs/universal-hud-concept.md`、`docs/universal-hud-plan.md` | 概念方案全部章节及七个问题、现有调研与阶段假设 |
| `docs/ARCHITECTURE.md`，重点 §1/3/4/5.4/7/8/11；`docs/reference.md` 的布局、状态、导航、活动、日志、Inspector、吞吐量、机器输出与 LLM 部分 | bar/panel 当前互相替换，已存在状态/隐私/计数契约；模型功能不全由 brief 范围控制 |
| `src/types.ts`；`src/collectors/rollout.ts` 的结果类型、公共 transcript、读取循环和 parser 状态 | 当前 reader 返回类型是 `RolloutParseResult`；数据含待完成调用等内存状态；读取至采样 fileSize；pending 行没有在该循环中设硬大小上限 |
| `src/collectors/session-finder.ts` 的 `SessionFinder`；`src/collectors/subagent-tree.ts` 的状态、构树和计数路径 | Codex daemon/root 绑定、fallback 的时间/cwd 逻辑；以 ID 建 parent map；resolveStatus 比较事件时间；active 只含 running/starting |
| `src/collectors/hud-status.ts`；`src/collectors/context-usage.ts` | HudData 同时组装 Codex 配置、上下文、Git、quota、health；Codex context 同时保留 raw window 与 baseline-adjusted 数值 |
| `src/render/layout/bar-modules.ts` 的入口、identity/context/activity/agents/tasks 模块 | bar 已可复用布局，但输入仍带 Codex config/计数/状态语义 |
| `src/index.ts`、`src/tree-page.ts` 的采集、快照、绑定切换、子代理 context 与导航路径 | 两个入口各持有采集状态；panel 直接调用 Codex 专用 reader、goal 与 navigation，不能只改一个入口完成抽象 |
| `src/snapshot.ts`、`src/utils/parse-queue.ts` | snapshot version 2 / `agents.nodes` / tmux-session 文件名；未变内容不重写；按文件 inode 判断退出清理所有权；parse queue 是进程内闭包 |
| `bin/codex-hud` 的 home/身份、命令引用、launch/attach/bridge 部分；`bin/codex-hud-herdr.mjs` 的配置、分类、API 与 observer 部分 | 现有 cwd+home 隔离、参数 `%q` 引用、`HERDR_AGENT=codex`、Codex 专用桥；native observer 与旧 report 路径有明确区分 |
| `test -d .codegraph`；`codegraph explore …`；MCP `codegraph_explore` | 目录检查为存在，但 CLI 报无可用 index，MCP 也报未索引；之后按返回指示退回只读源码检索，没有创建或更新索引 |
| `cat`、`sed -n`、`nl -ba`、`wc -l`、`rg -n` | 用于上述指定文件及相关符号的读取和定位；没有构建、测试或 Git 写操作 |

引用代码是为确认抽象边界和现有兼容承诺，不代表完成代码审查。

### 5.2 本机格式与 Herdr

以下 JSONL 探针仅在内存中解析并输出字段名、类型、计数或数值结构；不提取会话正文到评审，也未复制真实记录做 fixture。

| 路径/命令 | 核实结果与限制 |
|---|---|
| `~/.claude/projects/<当前项目>/<session>.jsonl`，一次完整的小于采样上限的根会话样本 | 含 user/assistant/attachment/system、api-request/blob 等类型；assistant content 有 thinking/text/tool_use，user 有 tool_result；30 个重复 assistant message ID 对应相同 usage，最多三条；常用消息首键为 parentUuid |
| `~/.claude/projects/<slug>/<session>/subagents/agent-*.meta.json` 与三个对应 JSONL | meta 实际含 agentType/description/toolUseId/spawnDepth/finished 等；三个子文件的 sessionId 均为所属根 sessionId，各有独立 agentId/isSidechain。另检查最近 50 个 meta：47 个有 finished=true，3 个没有该字段；不能把字段缺失解释为完成 |
| `~/.claude/sessions/*.json` | 27 个记录，含 procStart/pidDomain/updatedAt/statusUpdatedAt；出现 idle/busy/shell。PID 域有两种，只有少量数字 PID 在当前 `/proc` 可见，故不能把目录中每份记录当作当前活进程，也不能仅凭本地 PID 不存在断言别的 namespace 已退出 |
| `~/.claude/settings.json` 的 statusLine 字段 | refreshInterval 为 5；保留 toktrack 的 tee 分流；现有 wrapper 另做 COLUMNS 校验、TTY 宽度回退和边距处理，只读取相关配置字段，未改配置 |
| 本机 `claude-hud/0.8.0/dist/transcript.js` 的 usage/compact 处理；`dist/stdin.js` 的输入/上下文处理及 `dist/index.js` 的相关入口 | 现有插件已经按 message ID 合并 usage，并识别 system compact_boundary；stdin 使用 context_window.current_usage，也有 native percentage/usage-window 处理；这些是实现对照，不是对未来 Claude 协议稳定性的保证 |
| `~/.codex/sessions/.../rollout-*.jsonl` 与当前 `$CODEX_HOME` 的首行 | 抽到 Codex 0.166.0 根/子线程 session_meta；子线程有 parent_thread_id、agent_path、agent_role 等；当前进程的 home 是另一个 profile。未读取或展示 base_instructions 内容 |
| `~/.pi/agent/sessions/<slug>/*.jsonl` | 读取最近五个文件的有界样本，header version=3，常见记录有 id/parentId；assistant usage 有 input/output/cacheRead/cacheWrite/totalTokens/cost，content 有 thinking/toolCall/图片等。另对最近 90 个候选中不超过 8 MiB 的 85 个文件做类型探针，跳过 5 个大文件，找到 11 个 compaction、22 个 usage 和 51 个 session_info；部分 usage.kind 为 cache_warm，compaction 也自带 usage。未验证完整分支选择协议；大文件没有全量扫描 |
| `~/.claude/skills/herdr-delegate-codex/SKILL.md`、`~/.claude/skills/herdr-delegate/SKILL.md`、`~/.local/bin/pi-role` | Codex 通过 pane run 调 shell 函数，pi 通过 agent start 加 shell-quoted args；已有任务 SESSION 信息记录；pi 的 orchestrator 是通知目标，args 模式只打印 argv。仅作为方案证据读取，没有执行其中的委派/清理步骤 |
| 两个旧 profile 的 `hud-settings.json` | 只输出字段名及 backend 启用/暂停状态，确认都已有启用且未暂停的模型配置；没有输出 key、endpoint 或连接细节，没有改动设置 |
| `HERDR_ENV` / 当前 pane 的只读检查 | 环境为 Herdr 内，随后才执行 live inspection |
| `herdr --skill`、`herdr agent --help`、`herdr api --help`、schema/snapshot 的 help | 官方安装文档说明 done/idle 的查看语义、pane 移动、server 范围和进程保留身份；确认可用只读接口 |
| `herdr agent list`；`herdr agent get w3Q:p1` / `w3Q:p2` | 当时可见两个 Claude 和一个 Codex；Claude 与 Codex 都有原生 agent_session，Codex ref kind 为 id；有 revision/state_change_seq/completion_seq。无父/创建者字段。没有 live pi 可用于验证当前 pane 绑定 |
| `herdr agent explain w3Q:p1` / `w3Q:p2` | Claude 由 prompt-box 规则判 idle，Codex 由 OSC title 规则判 working；评审不复制标题或终端正文 |
| `herdr api schema --json`；`herdr api snapshot` | 公开 schema 与 snapshot 未暴露持久委派父/创建者字段；AgentSessionRefKind 为 id/path；agent start 参数无 env，tab create/pane split 有 env；schema 广告 events.subscribe、pane 状态/创建/关闭/移动事件。没有订阅或制造事件，故未把 bundled schema 当作运行 server 已验证的订阅保证 |

**未验证的事项：** 没有执行三 harness 启动集成、环境变量跨 pane 传递实验、链接恢复实验、并发/性能基准或现有测试套件；未核实调研给出的测试数量。没有证明 Herdr 内部实现从未保存任何创建者信息，只能确认本次可用的公开输出未提供可依赖的 lineage。以上缺口应进入实施验收，不应以本评审代替运行验证。
