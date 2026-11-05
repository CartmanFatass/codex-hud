# 通用 HUD 信息与视觉设计（v1.2，2026-11-02）

本稿是 FED1 的决定文档：HUD 在每种情境下显示什么、显示多少、怎样组织、用什么样子。它约束 B10（委派渲染）、D3（statusline 外观）、C5（Jev 行）和 B16 归并器要交付的投影字段。概念文档 §10 的 UX 笔记被本稿取代，差异列在 §0.2；外部设计意见（Gemini Argon）的逐条处理在 §9。所有示例数据都是合成的。

v1.1 是对 v1.0（2026-11-01）的增量：吸收 2026-11-02 的裁决（可见取消在 MVP 不可交付、完成后的可见代理由用户关 pane、运行槽上限 6 / 4、退役证据三分、唤醒状态、全 tick 预算）与 B9 / B16 已合入代码的实际投影形状，使 B10 可以不再提设计问题。改动清单在 §0.4；被改写的 v1.0 文字已就地替换，不留矛盾。

v1.2（同日）是对 v1.1 的增量：B10b 第 1 段（呈现核心、bar、statusline）实现后的 12 条设计问题裁决与样例修正，以及原生子代理的 `native {title, kind}`（§7 #33）。改动清单在 §0.5；被改写的 v1.1 文字同样就地替换。

读者先读概念 §2（G13、G14）、§6.5、§6.8，契约 03 的"HUD 可读投影"一段（含 H06 与 Pro 2026-11-02 的可见取消原句、NOTIFY A7），契约 04「Policy retirement」，`docs/design/notify-wake-lifecycle-cache.md` §3.8 / §4.4 / §4.9，`src/core/link/types.ts`（B9 投影）与 `src/core/status/merge.ts`（B16 语义类），以及 `docs/reference.md` 里今天的面板。

## 0. 立场与范围

### 0.1 四条设计原则

1. **一行一个标记，一眼读出"谁、替谁、在干什么、卡在哪"。** 五个状态维度在行上只投影成一个标记加一个颜色；细节在焦点行和 Inspector。
2. **不猜。** HUD 只画已提交的关系、运行、报告与 B16 投影。没有证据的位置留空，不画占位；候选关系只在 Inspector 里叫"疑似"，不画成树边；UI 上的 done 不等于运行结束。
3. **先丢字段，再截文字；先折叠，再滚动。** 宽度不够时按固定的丢弃顺序丢整块；数量多时按桶折叠；用户用现有键展开。
4. **延续 codex-hud 的词汇。** 状态标记、徽章、计量线、卡片骨架、控制条、调色板角色都沿用；只加 harness 标记、模式标记、`⚑`/`⚠` 两个新状态标记和四个 Inspector 小节。改动现有基线的地方逐条说明理由（§0.2、§5.1）。

### 0.2 对概念 §10 的取舍

| 概念 §10 | 本稿决定 | 理由 |
|---|---|---|
| bar 新模块 `delegated`，按后端计数 `⧉ ✳2 ⌬1 π1 ◎1` | 不加模块。`agents` 模块按标记计数视角根以外的所有树节点（含原生子代理、作业和已收进 `⊕N` 的历史），顺序固定 `▸ · ⚑ ? ⚠ ✗ ✓`，只写非零；汇总行同一写法、同一顺序；statusline 的 `⧉` 只计委派子会话与作业；仅在 full 密度且宽度 ≥ 160 时附带后端计数 `· ⌬2 π1 ◎1` | 用户先关心"几个在干活、几个要我"，不是后端分布；bar 一行寸土寸金，新模块会挤掉 context/notice |
| headless 行动作"日志"、结束行"打开"写在行上 | 行上不写动作词。动作只在控制条的 `⇢` 按钮（词随选中行变：Switch / Open / Log / Resume / Reconcile）和 Inspector 头部 | 现有规则：面板的每个控件都在控制条上，卡片不画控件 |
| 冲突行"⚠ 两条记录" | 保留，作为 8 个状态标记之一 | 记录不一致与"HUD 不知道"（`?`）是不同的求助 |
| 卡片显示 run 序号与退出码 | 只在 `run_seq > 1` 时显示 `run N`；只在有来源且非零 / 信号的原生退出结果时显示 `exit N` / `signal TERM`（可见运行通常没有，见 §3.3） | 第一轮的 `run 1`、正常的 `exit 0` 是噪音；shell status 不是退出码 |
| Inspector 新节"链接 / 运行 / 疑似 / 覆盖" | 保留，另加"报告"节；顺序：事实 → 链接 → 运行 → 报告 → 疑似 → 覆盖 → 原有长文本节 → More | 委派节点打开 Inspector 多半是为了看关系和运行 |
| 顶部"父：…"行 | 保留；只在视角根有 `links.asChild` 时出现，一行，格式见 §4.6 | |
| 汇总行计数写法 `✓1 ▸1` | 改成 bar 的写法 `1▸ 1✓`（数字在前，顺序 `▸ · ⚑ ? ⚠ ✗ ✓`） | 同一产品两种写法；bar 更显眼，以它为准。基线需更新 |

### 0.3 假设（详见 §9）

A1 B16 对每个节点给出完整五维投影和 `asOfSeq`；A2 归并器把"两条记录"作为独立标志而不是猜一个状态；A3 可见运行用修订后的方案甲（Oracle 裁决 `docs/reviews/2026-11-01-astra-contracts.md` §4）：运行结束可由已核验的进程组为空证实，但 harness 的原生退出结果通常未知（null），shell status 只是独立诊断，永不当退出码；取消已接受而先后未知的完整结束是 `ended` 加 `terminalNote = cancel_timing_unknown`（Oracle3 E02），不是 uncertain、不持槽；方案乙不是 MVP 受管后端，不在假设里；（v1.1）可见运行的程序化取消在 MVP 不可交付（契约 03 H06 + Pro 2026-11-02、契约 04「可见模式 MVP 能力」）：取消意图可被接受并持久（run 内部可为 `cancelling`），但不发 INT / TERM / KILL、不注入输入、不由宿主销毁 pane、不排升级计时器；对外必须显示"仍在运行——自动取消不可用，请在其终端 pane 内停止"（EN：Still running — automatic cancellation is unavailable. Stop this run in its terminal pane.），禁止无限 Cancelling… 提示；fresh / live 不因拒绝而 uncertain，之后按独立 scope 证据对账，无取消时序证明的结束仍是 `ended` + `cancel_timing_unknown` 并释放容量；A4 已裁决（Oracle2 D04）：MVP 的 Resume / Reconcile 只显示并复制契约 03 `ActionDescriptor.displayCommand`，不起控制进程，直接调用是将来的可选能力；A5 面板宽度 32–56（Codex ≥ 41），bar 80–200，statusline 80–200；A6 现有键位 `h`/`l`/`a`/`f`/`s`/`r`/`v` 可复用；A7 MVP 范围按 Oracle 裁决与契约 v0.3：同 owner 的 `predecessor` 转交留在 MVP；跨 owner 转交凭证、`closed` 链接重开、no-MCP `observe_only` 绑定、shared-daemon context 推到 v1.1，Jev 作业在阶段 C——本稿保留这些设计并就地标注，B10 不实现 v1.1 的部分；A8 普通会话（没有 ledger / MCP / run 也要能显示）按契约 05 以 `SessionBinding` 绑定、`SurfaceLocator` 定位，受管运行字段只在 `managed`（Oracle3 E06）；三种代次——宿主的 `occupantGeneration`、受管 run 的 `bindingGeneration`、reader 的 `sourceGeneration`——互不代用（Oracle3 E01 / E06）；A9（v1.1）可见代理的收尾与容量：MVP 不自动退役可见运行，完成后的可见 agent 由用户在 pane 内关闭，HUD 提示"已完成，请关闭此 pane"（契约 04「Policy retirement」Pro 2026-11-02；B3b-C 在 B15 之后恢复可见自动退役）；headless 由 hud-run 按接受时冻结的政策退役（implementer 报告后 10 分钟、reviewer 2 分钟、阻塞等待 60 分钟、最长 4 小时；空闲退役在 MVP 因静默不可观测而禁用，B22 Oracle），退役经 `retire.requested` + 现有阶梯，终态另存 `termination`；运行槽上限全局 6、每 owner 4（契约 02 A3，`delegate.json` `limits` 可配），`starting / running / cancelling / uncertain` 都占槽，报告完成不放槽，只有 R-02 证实终结才放；`concurrency_limit` 拒绝是暂时的、不留幂等行，账本里看不到拒绝本身，HUD 只能从快照计算占用；A10（v1.1）B9 的实际投影（`src/core/link/types.ts`）是 B10 的输入：`LinkTreeNode {identity, key, parentKey, edge, depth, crossHarnessDepth, loaded, coverage, observation | null, lastObservation, currentRun, execution, conflict, links[], host, parent}`、`relations[]`（含 `attribution ∈ confirmed | intent | history | conflict`、`host`、`parentOffline`）、`candidates[]`（≤ 200）、`selectionMap`、`continuation[]`、`truncation`、`counts {confirmedSessions, delegationIntents, jobs, knownUnloaded, omitted, unknownDescendants}`、`io`、`coverage`、`ledger {state, asOfSeq, reason}`；节点上**没有** `interaction`、`resumable`、`reconciliation`、`termination`、`wake`，它们要么由 §7 的新增项补齐，要么 B10 从同一快照的事件经 core 纯函数取，不自己解析 payload；读路径的 `interaction` 三项恒为 false（`readDelegationIn`），HUD 不以它判 Open（§3.7）；冲突关系在 B9 里不产生边，冲突节点只以 `relations[]` 出现（§3.6）；A11（v1.1）唤醒（B19）与退役（B22）在本稿定稿时尚未合入主干：`wake.state` 的纯投影、`retire.requested` / `termination` 的真实生产者、生产 pi 唤醒都可能缺席。缺席时相应的 Inspector 行不画（不是画 `none`），其它决定不受影响。

### 0.4 v1.1 的改动（2026-11-02）

1. 可见运行 + 已接受的取消意图：行 `⚑ · stop in pane`（alert），契约原句进卡片 / Inspector / 通知，行上不写 `cancelling`、没有 spinner、不进结束桶（§3.3 第 5a 条、§4.13）。
2. 已完成、等用户关 pane 的可见代理：行 `✓ · close pane`，活着桶、不收起、占槽；bar 只在槽满时亮 `⚑ slots 6/6`（§3.3 第 9b 条、§4.1、§4.13）。
3. 容量：汇总行 `slots N/N` 仅满时出现；根 Inspector 新增 `── Slots ──`（占用者、holder、uncertain 持槽即泄漏 + 对账命令只显示）；bar 不加模块（§4.1、§4.2、§4.11）。
4. 终态三分：outcome / requested cause / attribution 在 Inspector `── Run ──` 各一行，不合成一个图标；`retire_timing_unknown` 与 `cancel_timing_unknown` 同为安静说明；无报告的 `ended` 行可带原因词（§3.3 第 9 条、§4.10）。
5. 唤醒状态：仅 Inspector `── Link ──` 一行，`none` 不画（§4.11）。
6. B9 形状落地：`loaded=false` 与 omission 计数、`conflict {count, recordIds, since}` 的行词 `conflict` 与 `── Conflict ──` 节、冲突关系无边时的画法、宿主 occupant 不匹配、intent 行与绑定后的 `selectionMap`、`ledger.state = degraded`、额外的 intent 根（§3.1、§3.4、§3.6、§4.2、§4.11）。
7. Open 门禁改读 B9 `host` 投影（读路径的 `interaction` 恒 false）；MVP 的 `↻ Resume` 只给诊断（本地入口 `capability_unverified`），`↻ Reconcile` 照旧复制（§3.7）。
8. `■ cancelling`（headless）与 `✓ / ! · close pane` 归活着桶：排序按事实、计数按标记；`■ ended` 无报告统一 warning 60 s 后 muted，并进通知（§3.2、§3.3、§4.1、§5.2）。
9. 示例改为符合 6 / 4 槽上限：(d) 15 个工人里非终态 6 个（嵌套），(e) 五个工人分两个 owner，排序示例按 §3.2 的规则重排（§4.7、§4.8）。
10. 性能：全 tick p99 < 50 ms、max < 200 ms（契约 06「增量 tick 验收」）；B9 投影只在账本高水位 / 采集输入变化时重算，渲染有自己的份额表（§6）。
11. 关闭 §8 开放问题 3、10、13、14；新增 18–21。
12. 用词表新增（§5.5）；`⚑` 的两个新用法进图例。

### 0.5 v1.2 的改动（2026-11-02）

B10b 第 1 段（`src/render/delegation/*`，bar 与 statusline 钩子）实现后的裁决（设计问题 1–12，记录在 B10b 的任务目录）：

1. 计数：所有表面一个顺序 `▸ · ⚑ ? ⚠ ✗ ✓`，只写非零；bar 与汇总行计视角根以外的全部节点（含原生、作业、已收起的历史），statusline 的 `⧉` 只计委派；计数里失败写 `✗`，树行与 statusline 项写 `!`（§0.2、§3.3、§4.4、§4.5、§4.7、§4.8、§4.10、§4.13）。
2. bar 警示：恰好一条节点级警示用全形，多条用计数；有委派树时 attention 的两步缩短与 `agents` 模块优先级调整，80 列仍有计数；后端计数的 shrink 序 9；bar 自己的树失败警示不再单独亮；notice 不重复全形警示已点名的节点；`✗` 亮到行收起为止；通知是无状态的 60 秒窗口（§2、§3.2、§4.1）。
3. 行：时钟列固定 7 格，≤ 39 列状态词（含 `close pane`）让位；丢弃顺序 `⊟` → 状态词 → 名字，状态词丢掉后 `⊟` 可恢复；两词状态先丢第二个词；`? · not loaded` 在活着桶、不亮 bar；原生 idle 的 `✓` 视为完成（§3.3、§3.4、§4.5、§4.13）。
4. statusline：阶梯加"丢 trouble 项状态词"一步；trouble 计数顺序 `⚑ ? ⚠ ✗`；`+N` 余项按计数写法；冲突节点是一项（§4.12）。
5. 颜色：`⚑` 是 danger 色加粗，与 `!` 以字重和符号区分；"黄色只剩要我处理"的说法撤回（§5.2、§9 #5）。
6. 原生子代理：B9 节点新增 `native {title, kind}`，行名与 kind 图标由它来（§3.4、§7 #33）；用词表加 `idle / 空闲`（§5.5）。
7. 样例修正：§4.1 (d)、§4.5 32 列、§4.8 冲突行 `┊`、§4.13 32 列、§4.12 80 列；样例只约束委派字段，非委派字段由现有引擎决定（§4.1）。
8. 追加裁决（同日，实现后的四问）：focus 密度在有委派树时含 `agents`；通知去重扩到所有警示类别；槽满警示接在节点级警示之后不带自己的 `⚑`（最窄 `⚑1 6/6`）；计数形的最窄形只留优先级最高一类（§4.1、§4.7）。

## 1. 信息清单与层级

层级定义：

- **T0 常显**：任何宽度、任何布局都在行上（也进 bar 的计数）。
- **T1 行上**：宽度允许时在行的右侧簇；按 §4.2 的丢弃顺序让位。
- **T2 焦点**：选中行下面的那一行（compact）或卡片正文（rich）。
- **T3 Inspector**：打开 Inspector 才看；`▾ More` 后面是 ID、时间戳、路径。
- **T4 不显示**：永远不画。

| 事实 | 来源 | 层级 | 显示方式 |
|---|---|---|---|
| 一眼状态标记（五维投影，§3.3） | B16 `statusProjection` + run/job/report 终态 | T0 | 行首一格；颜色随标记 |
| 名称 / 标签 | `links.label` → `role` → 会话名 | T0 | 名字字段；根加粗 |
| harness | `node.harness` | T0（树跨 harness 时）/ T4（单 harness 树隐含） | 标记后一格：`✳ ⌬ π ◎` |
| 状态词（trouble 行、提示行） | 投影 + run/job 状态 | T0（`⚑ ! ■ ? ⚠ ·` 行，以及 `close pane` 的 `✓` 行） | 名字后 ` · uncertain` 等；trouble 行为腾空间丢徽章和计量线；`stop in pane` / `close pane` 是两个提示词，占状态词位 |
| 可见取消意图（v1.1） | `currentRun.mode = visible` 且 `currentRun.state = cancelling`（`cancelControl {intentAccepted, delivery: unavailable}` 存在时印证，不是必需；MVP 没有任何可见信号交付） | T0 行词 `stop in pane` / T2 短句 / T3 + bar 通知全句 | 契约原句"仍在运行——自动取消不可用，请在其终端 pane 内停止"只在卡片、Inspector、通知长形；行与微卡用短形（§3.4、§4.13）；没有 spinner、没有倒计时 |
| 关 pane 提示（v1.1） | `mode = visible`、`isRunTerminal = false`、本轮 `latestReportForRun.status ∈ {completed, failed}` | T0 行词 `close pane`（`✓` 行）/ T2 委派行 / T3 `slot held until the run ends` | 契约句"已完成，请关闭此 pane"；HUD 不猜用户是否还想在 pane 里继续，提示从报告到达起就在，不设宽限计时器（HUD 读不到冻结政策） |
| 容量（v1.1） | 快照 `runs` 里 `state ∈ {starting, running, cancelling, uncertain}` 的计数 + `limits`（`delegate.json`，默认 6 / 4）；holder = 该 run 的 link `parentRef` 等于视角根则 `self`，否则 `other`（`parentRef` 为 null 也记 `other`，HUD 不派生 proc owner） | T1 汇总行 `slots 6/6`（仅满时）/ T3 根 Inspector `── Slots ──` 永远 / bar 警示仅满时 | 满 = `self ≥ 4` 或全局 `≥ 6`；uncertain 占用者在 Slots 节标 `reconcile first`，命令只显示 |
| 终态证据 `termination`（v1.1） | 本轮 `run.terminal` 事件 payload 的 `{outcome, requestedCause, observed {exitCode, signal, escalatedTo, scopeEvidence}, attribution}`（§7 #26） | T3 `── Run ──` 三行（outcome / requested / termination）；`requestedCause` 的词在无报告 `ended` 行 T0 | 三件事分开写，不合成一个图标；`observed.exitCode / signal` 有来源时与 `exit N` 同规则显示 |
| 唤醒 `wake.state`（v1.1） | B19 纯投影 `registered | degraded | unconfirmed | none`（§7 #27），对象是该 link 的当前登记 | T3 `── Link ──` 一行 | `none` 或投影缺席不画；不进行、不进 bar |
| 树位置（父子） | `links`（唯一当前父边） | T0 | 缩进 + 竖线；未证实边用 `┊` |
| model · effort | `evidence.model` | T1 | 徽章，`fitModelEffortToken` 四形 |
| context % | `evidence.context` | T1（≥ 40 列）/ T3 精确数 | 行上 4 格细线；卡片脚线上百分比 |
| 右端时钟（含义随状态，§3.4） | transcript / heartbeat / 06 `stateSince` + `stateSinceBasis` | T1 | 右端 7 格：`▸` 轮时钟；`⚑ ! ⚠` 卡在该状态的驻留时长（basis `event` → `10s`，`observed` → `~10s`，`unknown` / null → 留空，不编年龄）；`?` `lastEvidenceAt` / 心跳年龄；`✓ ■ ·` 结束 / 进入该状态的年龄 |
| 模式 visible / headless | `runs.mode` | T1 | 名字后缀 `⊟`（仅 headless）；比截断名字先丢 |
| Jev provider（阶段 C） | `jobs.provider` | T1 | 占徽章位：`chatgpt / gemini / aistudio / flow` |
| 角色 role | `links` 意图 | T2 / T3 | 卡片第一行 `implementer · pane 4 · bound 12m` |
| 宿主 pane / tab | B9 `host {locator, state: valid \| stale \| unknown, occupantMatches: true \| false \| null, checkedAt, currentState}`（普通会话用 `SurfaceLocator`，受管 run 用 `HostLocator`，核验口径相同；`currentState` 只在 `valid` 且 `occupantMatches = true` 且无冲突时非 null） | T2 / T3 | `pane 4` 只从 `currentState.label` 取；`currentState = null` 时不写 pane（不猜，null 不等于 null），Inspector 写原因：`occupant mismatch (checked 12s)` / `locator stale` / `not verified` |
| run 序号 | `runs.run_seq` | T2（> 1 时）/ T3 | `run 2` |
| 花费（pi 的 cost，Flow 的 credits） | `evidence.spent.costUsd`，jobs | T2 / T3 | `$0.12`、`12cr` |
| 树级累计花费 | 06 树级合计：`spent.costUsd` 按完整 SessionRef 去重求和，带 `knownCount / missingCount / coverage / quality` | T1（汇总行）/ T3（根 Inspector 写 `3 of 5 nodes`） | 全部已知且 reported → `$3.40`；有缺失且已知部分全是 reported → `≥$0.12`（同口径下界）；混入 estimated → `~$0.12`（不是下界）；credits 另算，不换美元 |
| 工作目录 / 工作树 | 06 `WorkspaceContext {cwd, worktreeRoot, worktree?, repoId, projectOrigin, cwdSource, cwdAsOf, gitCapturedAt, gitMissingReason}` | T2（与父的 `worktreeRoot` 不同时）/ T3 | 委派行 `in fix-cjk`（`worktree` 显示名，否则 `worktreeRoot` 的 basename）；判等只看规范化 `worktreeRoot`，根未知时退到比较规范 cwd（只说目录不同），cwd 也未知写 `in ?`——未知不等于相同；`projectOrigin` 只是声明，Inspector 标 `declared` |
| 最近报告 | `latestReportForRun` | T2 一行 / T3 全部 | `✓ Docs synced; …`（摘要经 `monitorText`） |
| 待决原因文本 | transcript / Jev | T2 / T3 | `⚑ approval: run npm run test:visual?` |
| 运行结束 / 退出 | `runs.state = ended`（已核验进程组为空）；`exit.json` 的 `exit_code` / `signal` 可为 null（可见运行通常未知）、`reason`、`coverage`；shell status 是独立诊断；`terminalNote`（`cancel_timing_unknown` / `retire_timing_unknown` / null）是终态分类时的证据缺口说明 | 结束 T0（标记）；退出结果 T2（仅已知且非零 / 信号时）/ T3；shell status 仅 `▾ More`；`terminalNote` T3（微卡第 2 行 / Inspector 一句话） | `exit 1`、`signal TERM` 只在有来源时出现；未知时焦点行写 `exit unknown`，不写 0；`cancel timing unknown` / `retire timing unknown` 是安静的说明，不是 trouble，不换图标 |
| 心跳 | `runs.heartbeat_at` | T2（stale 时年龄）/ T3 | `heartbeat stale 2m14s` |
| 链接状态与握手 | `link.state`、`runHandshake`、`bound_by`、`capabilities`（MVP 只有 `mcp`；`observe_only` 自动绑定是 v1.1，MVP 只显示未确认身份） | T2（非 bound 时一个词）/ T3 | `handshake claimed`；Inspector 画状态机 |
| 父离线 | `parentOffline {since, seq, orphanPolicy}`（由 parent.offline 事件投影） | T0（顶部父行）/ T3 | `↑ parent ✳ main · offline 3m · continue` |
| 冲突 | B9 `conflict {count, recordIds[], since}`（节点与关系都带；`count` 可为 1 或更多；`truncation.conflictRecords` 是没列出的数） | T0 `⚠ · conflict` / T2 `⚠ conflict: 2 records · since ~6m` / T3 `── Conflict ──` 逐条列记录 | 不归属任一方；`two records` 不再用（count 未必是 2）；没列出的写 `+N not listed` |
| 候选（疑似） | `candidates[]`（≤ 200，`truncation.candidates` 是没列出的数） | T3 only | 不进树、不进计数、不进 bar |
| 当前动作 / 工具 | `evidence.action` | T2 | 卡片 `▸ npm test -- parser` |
| 原生子代理 | `native[]` | T2（卡片子行）/ T1（`◈N` 评审 chip） | 子行用 kind 图标 |
| 进度 todo | `evidence.progress` | T2 / bar `Tasks` | |
| 覆盖 / 未加载 | B9 `node.loaded`、`node.coverage.reason ∈ nodes \| depth \| bytes \| unloaded \| native_topology`、`continuation[]`、`counts {knownUnloaded, omitted, unknownDescendants}`、树级 `coverage`、`ledger {state, reason}` | T1 汇总行 `3 not loaded` / `tree partial` / `ledger busy`；T0 非终态未加载行词 `not loaded`；T2 卡片计数行 `· children unknown`；T3 根 Inspector `── Coverage ──` | 终态的未加载行照常画历史行（账本已知终态），只在 Inspector 标 `not loaded`；没有被 B9 返回的节点不画行，只进计数 |
| 日志路径 | `~/.hud/runs/<runId>/` | T3 + `Log` 动作 | 路径缩成 `~`，`▾ More` 显示完整 |
| brief 路径、task digest | links | T3 More | 只显示 basename 和 digest 前 8 位 |
| link_id / run_id / child_ref / 三种代次（宿主 `occupantGeneration`、受管 run 的 `bindingGeneration`、reader 的 `sourceGeneration`）/ supervisor pid / `asOfSeq` / `observationStamp` / `stateSinceBasis` / `cwdSource` | ledger、05 / 06 投影 | T3 More | ledger 戳与观测戳分开写，不互相比较；三种代次各自单列、不互相代用，缺的写 `—` 不写 0 |
| claim、票据、credential hash、request_key、params_digest、cdp_url、parent_owner_key、heartbeat_seq/mono、原始 transcript 文本、用户 home 的绝对路径 | | T4 | 永不显示；路径一律 `~` |

bar 的信息清单不新增模块：`attention` 新增 needs-human / uncertain / conflict / stale 四种警示，v1.1 再加两种——节点级 `⚑ … stop in pane`（与 approval 同级，取最新）和常驻的 `⚑ slots 6/6`（仅槽满时，排在所有节点级 `⚑` 之后、`✗` 之前）；`notice` 新增"收到报告 / 运行 uncertain / 待决原因变化"三种通知，v1.1 再加"可见取消意图已接受（`⚑ impl-parser still running · stop in its pane`）/ 可见代理报告后待关（`✓ docs-sync reported · close its pane`）/ 无报告结束（`■ bench ended · no report`）"三种；`agents` 计数覆盖整棵树。其它模块不变。

## 2. 分情境的显示复杂度

四个披露层：**bar**（计数 + 警示）→ **行**（标记 + 名 + 右侧簇）→ **焦点行 / 卡片**（角色、宿主、报告、动作、子行）→ **Inspector**（全部）。情境只改变默认折叠，不改变语法。

| 情境 | bar | 面板默认 | 折叠 / 展开 |
|---|---|---|---|
| (a) 单个代理 | 今天的 bar；`agents` 模块不出现（没有子节点时本来就不画） | 一张卡片或一行；无 harness 标记 | 无 |
| (b) 几个原生子代理 | `Agents 1▸ 1✓` | 今天的卡片：子代理是卡片内子行 | 完成子行 3 分钟后收进 `⊕N`，`a` 显示 |
| (c) 跨 harness 树 | `Agents 3▸ 1⚑ 2✓`；≥ 160 列附 `· ⌬2 π1 ◎1` | 出现 harness 标记；委派子会话各自成卡（缩进 2 格），Jev 作业一张 3 行小卡（阶段 C）；原生子代理仍是子行 | 深度上限 4；超过的子树折叠成 `+3 (1⚑ 2▸)`（带子孙计数），`l` 展开为平铺 `↳` 行 |
| (d) 10+ 并发 | 同 (c)；警示优先显示；只有一条节点级警示时用全形，多条时用计数（§4.1）；槽满时附 `⚑ slots 6/6` | 手风琴：卡片总行数超过视口（或兄弟 > 5）时，先把 `✓ ■` 卡、再把未选中的 `▸ ·` 卡折成一行（= compact 行），`⚑ ? ⚠ !` 卡和选中卡保持展开；按子树有效桶排序：⚑ ! ⚠ ? → ▸ ·（含 `■ cancelling`、`✓ close pane`）→ ✓ ■；完成桶折成一行 `✓ 9 done · …`；非终态受管运行全局 ≤ 6、每 owner ≤ 4（契约 02 A3），所以"10+ 并发"只能来自嵌套、原生子代理和已结束的历史，汇总行满时加 `slots 6/6` | `a` 展开完成桶；`n` / `N` 跳到下一个 / 上一个 trouble 节点；`f` 过滤 attention；活跃行超过 30 行时时钟改分钟粒度 |
| (e) trouble | `attention` 徽章：只有一条时 `⚑ review-tests approval`；多条时计数 `⚑1 ?1 ⚠1`（顺序 `⚑ ? ⚠ ✗`） | trouble 行丢徽章与计量线，换成状态词和驻留时长；排在最前，最新卡住的在最上（子树冒泡的也按子孙的时间） | 微卡给原因和缺失项；Inspector 给证据、对账命令、冲突记录 |
| (f) headless | 无差别 | 名后 `⊟`；无 pane 字段；控制条动作 `Log` | 结束后 `↻ Resume` 只在 `resumable = true` 且本地入口已验证时复制命令，MVP 里写诊断；Inspector 显示 `resumable` 与否；报告后由 hud-run 按冻结政策退役，HUD 不提示、不计时 |
| (g) 已完成 / 历史 | 完成 60 秒内进 notice：`✓ docs-sync reported`；无报告结束 `■ bench ended · no report` | 行变暗并带收尾事实（`reported 8m`、`ended`（无报告，`requestedCause` 为 runtime / idle / blocked / orphan 时带原因词）、`failed`、`cancelled`（仅取消先于结束已证明；先后未知是 `ended` 加安静说明）、阶段 C 的 `answered → file`）；3 分钟后收进 `⊕N` | `a` 显示；终态的 `not loaded` 行照常画，Inspector 标 `not loaded`；`closed` 与重开是 v1.1 |
| (h) 可见运行的收尾（v1.1） | 警示 `⚑ impl-parser stop in pane`（最新触发）；通知 `✓ docs-sync reported · close its pane`；槽满 `⚑ slots 6/6` | `⚑ · stop in pane` 行 + 契约原句卡片；`✓ · close pane` 行（`!` 行保留 `failed`，提示进委派行）；都在活着桶尾、不收起、占槽 | 不折叠、不设计时器；用户在 pane 内处理，HUD 不送输入、不关 pane；运行终结后转入 (g) |

折叠的触发只有三种：**宽度**（§4.2 的丢弃顺序）、**数量**（卡片总行数超过视口或兄弟 > 5 → 手风琴折叠，§3.5；终态项 3 分钟 → `⊕N`；兄弟 > 12 → 完成桶立刻折叠）、**深度**（> 4）。折叠永远带子孙计数，不吞掉深处的求救。展开用现有键加三个新键：`a`（收起的终态项）、`h`/`l`（折叠 / 展开子树）、`Enter`/`v`（Inspector）、`r`（状态卡层级）、`f`（过滤，新增 `attention` 档）；新键 `n` / `N`（下一个 / 上一个 trouble 节点，保留树形上下文；B10b-s3 裁决 2026-11-03：此处 trouble 指 §3.2 第一桶，排除视角根、未加载项和已结束的失败）、`L`（日志）、`R`（Resume / Reconcile，§3.7）。

## 3. 组织

### 3.1 一棵树，不分组

面板只有一棵树，根是 HUD 所附着的会话（"视角根"）。跨 harness 的子会话和 Jev 作业挂在它们的父节点下；原生子代理挂在各自的会话下。节点身份是 06 的 `DisplayNodeIdentity`：`{kind: session, ref}`、`{kind: delegationIntent, linkId}`（已登记但尚未绑定的委派，用稳定的 linkId 作显示键，挂 currentRun，不按 label / cwd 合并、不计入已确认会话数；首次绑定后由 B9 映射到真实 ref，行不跳）、`{kind: job, ref}`（阶段 C）。没有"按后端分组"的视图：分组的需求由排序（§3.2）和汇总行的计数满足。不在树里的会话（其它根、CLI 直接起的 Jev 作业）在现有 Sessions 标签页里列出，Jev 条目带 `◎`。

（v1.1）B9 可能返回多于一个顶层根：视角根之外，`parentRef` 尚未解析的委派意图（父 caller 还没绑定到 SessionRef）会作为额外的深度 0 节点出现（`relations` 里 `parentKey = null`、`attribution = intent`）。它们画在主树之后、同一列表里，深度 0、前缀 `┊`、标记按 §3.3 第 8 条，微卡第 1 行写 `parent unconfirmed`；不挂到视角根底下（那是猜父子），不单独分组。

从被委派方看（HUD 附着在子会话的 pane 里），树的根是子会话，父信息在顶部父行（§4.6）；不向上画父的兄弟。

### 3.2 排序：按桶，稳定

兄弟节点按**子树有效桶**排序：一个节点的桶 = 自身的桶与所有未收起子孙的桶中最靠前的那个（`⚑ ! ⚠ ?`（要人看）→ `▸ ·`（活着；v1.1 起含 headless 的 `■ cancelling` 与报告后仍活的可见代理 `✓ / ! · close pane`）→ `✓ ■`（结束：`isRunTerminal = true`，或无受管 run 的节点按原生退出））。于是 `✓` 的父节点底下还有 `⚑` 或 `▸` 的子孙时，整棵子树排在前面，也绝不会被收进 `⊕N`。trouble 桶内按进入该状态的时间倒序（最新卡住的在最上面）；桶由子孙冒泡而来时，排序时间也取那个子孙的，所以深处刚卡住的也会浮到最上面（§4.8 的 `impl-a` 就是这样）；其它桶按创建顺序（`s` 键切换为纯创建顺序，与今天一致）。活着桶内 `▸ ·` 在前、`■ cancelling` 与 `close pane` 行在后。（DOC2 裁决 2026-11-05）排序有关的事实、树结构或排序选项变化时重排；只有时间流逝不重排。重排与整秒重绘同步，选中跟着节点走而不是跟着行号走；刚换桶的节点前 3 秒状态词和时钟加粗，帮眼睛找到"谁刚动了"。换桶、驻留和加粗都以 06 的 `stateKey` / `stateSince`（语义状态的 episode）为准，不以图标为准：同一个 `⚑` 下新一轮 approval 是新的 episode，时间重新计。

历史资格不看图标：委派节点以共享谓词 `isRunTerminal`（run `ended / failed / cancelled`；completed 报告、`cancelling`、图标都不算结束；取消先后未知的完整结束是 `ended`，照样算）为准，普通会话（无受管 run 投影，`managed = null`，§7 #7）与原生子代理按其原生退出 / 完成事实，根会话不收起。符合条件的行（`✓ ! ■`）一视同仁：3 分钟后收进 `⊕N`，计数仍算，bar 的 `attention` 不再为它们亮——失败是历史事实，不是当前待办。当前待办只有 `⚑ ? ⚠`：它们一直排在前面直到条件消失；bar 只有一条节点级警示时用它的全形，多条时用计数，各类计数的顺序固定（§4.1）；通知（notice）取最新的一条。

（v1.1）两类"标记像结束、事实是活着"的行——headless 的 `■ cancelling`（阶梯在飞，≤ grace + 2 s + reap）和报告后仍活的可见代理 `✓ / ! · close pane`（槽仍占，等用户关 pane）——不是终态：排在活着桶尾，永不收进 `⊕N`；bar 的计数按标记记作 `■` / `✓` / `!`。排序按事实、计数按标记，不一致之处只有这两类，而且都是暂时的；v1.0 把 `■ cancelling` 排进结束桶是错的，已改。

### 3.3 五维状态 → 一个标记

归并器（B16）给出 `activity / pendingReason / lastTurnOutcome / liveness / freshness`，HUD 再加 run/job/report 的终态和冲突标志，按下表第一条命中投影。这是纯函数，按节点 stamp 缓存。

| 序 | 条件 | 标记 | 颜色 | 行上状态词 |
|---|---|---|---|---|
| 1 | 冲突标志 `conflict.count > 0`（同一 ref 多条记录、两个父边、环、已接受的 conflict 证据；B16 `conflict:contradictory_evidence`） | `⚠` | warning | `conflict`（v1.0 的 `two records` 不再用：count 未必是 2） |
| 2a | `run.state = uncertain` 且 `reconciliation.cause = supervisor_dead`（托管进程死亡已证实；甲下前台回到 shell、harness 被挂起） | `?` | warning | `supervisor lost`；Open / 输入 / Resume 一律不可用；（B10b-s3 裁决 2026-11-03）`⇢` 对可见运行是灰色 Open，对 headless 是 Log；Reconcile 在 `↻` |
| 2b | 其它 `run.state = uncertain`（scope 无法查询、resume 解析到别的 ref、时钟异常、取消已发但结束未证实……），或 `job.state = uncertain`（阶段 C）。结束已证实（完整 R / Q）而取消先后未知**不是** uncertain：那是第 9 条的 `ended` 加 `terminalNote` | `?` | warning | `uncertain` |
| 3 | `pendingReason ≠ none`，或报告 status = blocked | `⚑` | alert（加粗；面板上唯一的"现在要人"色） | `approval` / `question` / `needs human` / `blocked` |
| 4 | `lastTurnOutcome = failed`，或报告 status = failed，或有来源的原生退出结果为非零 / 信号（通常只有 headless argv 启动或 exec 直连路径才有；shell status 永不算），或 `run.state = failed`（02 的 non_execution，`stateKey = launch_failed`：从未执行，不是模型跑失败），或 `job.state = failed`（阶段 C） | `!` | danger | `failed`（焦点行在已知时加 `exit 1`）；launch_failed 写 `launch failed`，焦点行给采用的原因 |
| 5a | （v1.1）run `cancelling` 且 `mode = visible`：取消意图已接受，MVP 不可交付（没有信号、没有输入、没有计时器），运行仍活、槽仍占，只能由用户在 pane 内停止；`cancelControl` 存在时印证。B16 的 stateKey 仍是 `interrupted:cancelling`，这里只是它在可见运行上的映射 | `⚑` | alert（加粗） | `stop in pane`；焦点行 / 卡片 / Inspector 写契约原句（§3.4、§4.13）；活着桶、不计结束；没有 spinner |
| 5b | `lastTurnOutcome = interrupted`，或 run `cancelling` 且 `mode = headless`（阶梯在飞，≤ grace + 2 s + reap，结束未证实，槽仍占），或 run `cancelled`（只有已接受的取消**先于结束已证明**才是这个终态；取消意图、发过信号、`cancel_requested_at < ended_at` 都不算证明），或报告 status = interrupted | `■` | warning，60 s 后 muted | `interrupted` / `cancelling` / `cancelled`；`cancelling` 行在活着桶尾（§3.2） |
| 6 | `freshness.state = stale`（任一所需来源越过确定截止，心跳严格 > 30000 ms；supervisor 死亡未被证实、run 仍 running），或 `freshness.state = unknown`（所需来源缺失、身份不匹配或时钟不可判），或 `liveness = unknown` 且 `activity = unknown`；只比较 `freshness.state`，不看明细 | `?` | muted | `stale` / `unknown`；时钟列显示 `lastEvidenceAt` / 心跳年龄 |
| 7 | `activity = working`，或 `job.state ∈ {sent, waiting}` | `▸` | info | 无 |
| 8 | run `starting`，或 link `pending / claimed` 且无活动，或 `job.state = key_persisted`（阶段 C） | `·` | muted | `starting`；作业等租约时 `browser queue (held by ask-pro-1)` |
| 9a | `isRunTerminal = true`（run `ended`——已核验进程组为空，包括取消已接受但先后未知的结束（`terminalNote = cancel_timing_unknown`）和退役后先后未知的结束（`retire_timing_unknown`）——或 `cancelled`；`failed` 已被第 4 条接走）、`liveness = gone` 或 `activity = exited`：委派节点有 completed 报告 → `✓`；没有报告 → `■`，不看退出码，因为原生退出结果通常是 null；`terminalNote` 只在焦点行 / 微卡加一句 `cancel timing unknown` / `retire timing unknown`，不换图标、不进 trouble、不要求对账；`termination` 三项只在 Inspector（§4.10）；没有受管 run 投影的普通会话（`managed = null`）没有 `isRunTerminal`，和根会话、原生节点一样退出即 `■ exited`（warning） | `✓` / `■` | success / warning，都在 60 s 后 muted（§5.2 同一条规则；v1.0 把无报告的 `■` 立即 muted 是不一致的，已统一） | 历史行 `reported` / `ended`；无报告且 `requestedCause ∈ {runtime_limit, retire_idle, retire_blocked_wait, orphan_policy}` 时 `ended · runtime limit` / `idle limit` / `blocked limit` / `parent gone`；焦点行 `ended · no report · runtime limit · exit unknown`，有说明时再加 `cancel timing unknown` / `retire timing unknown` |
| 9b | （v1.1）`isRunTerminal = false`、本轮 `latestReportForRun.status ∈ {completed, failed}`（B16 `exited:reported` 或第 4 条的 `failed`）：**可见**运行 → 完成后等用户在 pane 内关闭，槽仍占；**headless** → 等 hud-run 按冻结政策退役（通常 ≤ 10 / 2 分钟），HUD 不提示 | `✓` / `!` | success / danger（`✓` 60 s 后 muted；`close pane` 词保持 text 色） | 可见：`✓` 行词 `close pane`，`!` 行保留 `failed`、提示进委派行 `writer · pane 5 · reported 8m · close pane`；headless：`reported`（照常）；两者都在活着桶尾、不收起（§3.2）。用户在 pane 里继续用一个已报告的可见代理时，B16 按 `activity = working` 给 `working`，行就是普通的 `▸`，提示只在它空闲下来（`exited:reported`）后出现；槽从头到尾都占着，根 Inspector 的 Slots 节照列 |
| 10 | `activity ∈ {idle, waiting_input}`，`pendingReason = none`：根会话或原生节点 → `✓`（今天的语义）；委派节点没有 completed 报告 → `·`（活着、空闲、没交差；绿色 `✓` 只给交了差的） | `✓` / `·` | success / muted | 无 / `idle`（微卡给报告摘要或最近动作）；原生节点的 `✓` 视为完成：3 分钟后收进 `⊕N`（§3.2） |
| 11 | 其它 | `?` | muted | `unknown` |

计数：working = `▸`；alive-not-working = `·`（starting / idle）；blocked = `⚑`（含 `stop in pane`）；trouble = `? ⚠ !`；done = `✓ ■`（含 `close pane` 的 `✓` 与 headless `cancelling` 的 `■`——计数按标记，排序按事实，§3.2）。`agentCounts` 和 bar 都用这些桶，汇总行只写非零的。顺序固定 `▸ · ⚑ ? ⚠ ✗ ✓`；计数（bar、汇总行、statusline 第一行与 `+N` 余项）里失败写 `✗`，树行与 statusline 第二行的项写 `!`（§5.1）；已收进 `⊕N` 的节点照计；`? · not loaded` 按标记计入 `?`，不亮 bar。冲突节点按去重后的 `childKey` 计 `⚠`，不按关系条数。

"父 idle、子 working"：根的父行是 `✓`，不加词；汇总行的 `N▸` 和父卡片的计数行（`2 working · 1 done`）说明子在干活，而排序按子树有效桶把它留在前面（§3.2）。

stale 的含义只有一个：来源失联（心跳超 30 s、注册表不可达、文件不可读），由 B16 判定。模型长时间思考不是 stale，是现有的 quiet（时钟 5 分钟后转 warning）。stale 行不画最后已知的 `▸`（那是猜），焦点行和 Inspector 写"最后已知 working，45 s 前"。

三种"不知道"分开画：`? stale`（muted）是健康运行上的心跳延迟或来源失联，等一等就好；`? uncertain`（warning）是运行状态需要对账；`? supervisor lost`（warning）是甲下托管进程已死、终端回到 shell、harness 挂起的本轮监督故障——槽仍被占，HUD 不聚焦、不送输入、不自动 resume，只给诊断和 Reconcile。对委派节点，`✓` 只来自 completed 报告；运行结束是事实，退出结果是另一回事，两者都不能代替报告。取消先后未知不是第四种"不知道"：结束已被完整 R / Q 证实时 run 是 `ended`，槽已释放，`terminalNote = cancel_timing_unknown` 只是一句安静的说明（契约 02 R-02-3、契约 03 terminalNote），不是 `reconciliation.cause`，不灰按钮、不给 Reconcile；迟到的时序证据也不会把 `ended` 翻成 `cancelled`，HUD 不等它。`retire_timing_unknown`（NOTIFY §4.4）同类：结束已证实，只是说不清退役信号是不是结束了它；`termination.attribution = unknown` 与它成对出现，都只是说明。

可见取消也不是"不知道"：`⚑ stop in pane` 是确定的事实（意图已接受、不可交付、运行仍活），要人做的事清楚，所以用要人色而不是 warning；它不占 `?` 的计数，也不给 Reconcile。

分类本身是 B16 的唯一函数（契约 06「唯一语义分类」，优先顺序与本表一致），输出 `stateKey`（语义加原因：approval / question / supervisor_dead / launch_failed…）；本表只是它到图标、颜色、词的映射，映射的输入是 `stateKey` 加账本的运行事实（`mode`、`state`、`isRunTerminal`、本轮报告、`termination`、`conflict`），不含观测明细；前端不另维护分类，也不把图标反推成状态。intent 节点和观测戳不匹配的节点没有持久投影时，B10 只用纯 `mergeStatus` 就账本事实即时归并（§7 #30），仍是同一函数。

### 3.4 行的解剖（compact）

```
col 1      选中 ›（否则空格）
col 2…     深度 d ≥ 1：(d-1) 个「│ 」+「├ 」/「└ 」；未证实的边用「┊ 」
+1         状态标记（§3.3）
+1         空格
+1         图标位：会话 / 作业 = harness 标记（跨 harness 树）；原生子代理 = kind 图标（⌕ ⚗ ⚒ ◈ ✎ ∑，来自 B9 `native.kind`，§7 #33；缺席时留空）；图标位在跨 harness 树或任一行有 kind 图标时存在，否则整列省略
+1         空格
名字字段    label；headless 后缀「 ⊟」；trouble 行再接「 · 状态词」；至少 8 格，用 … 截断
≥1         间隙
右侧簇      [◈N] [徽章 ≤13，右对齐] [计量线 4] [时钟 7，右对齐]
```

规则：

- 时钟列永远是最后 7 格，含义随标记变：`▸` 轮时钟 `◷12m04s`；`⚑ ! ⚠` 卡在该状态的驻留时长（`10s` 和 `15m` 一眼分开）；`?` 最近证据 / 心跳年龄；`✓ ■ ·` 结束或进入该状态的年龄。没有时钟的行留空而不是画 `—`。驻留时长来自 06 持久发布的 `stateSince`：`stateSinceBasis = event` 画 `10s`，`observed`（只知道首次看到这个状态的时间）画 `~10s`，`unknown` 或 null 留空——不用重绘时间编一个年龄；`?` 行的年龄永远取 `lastEvidenceAt` / 心跳，不用 `stateSince` 代替；时钟倒退（`clockAnomaly`）留空并在 Inspector 写明。32–39 列时字段放不下名字加状态词的，状态词让位（含 `close pane`），时钟列不缩。
- 徽章只在会话 / 作业行上；原生子代理行只有时钟（模型与父不同时才有徽章）。
- trouble 行（§3.3 第 1–6、8 条，`⚑` 行也在内）无条件丢徽章和计量线，保留状态词和时钟；这是"先丢字段"的具体应用。≤ 39 列：先丢 `⊟`，再丢状态词，最后才截名字；状态词丢掉后 `⊟` 放得下就恢复。40 列起：保留状态词，名字截到 ≥ 8 格；两词状态（`ended · runtime limit`）仍放不下时先丢第二个词，再截第一个。
- 终态行（`✓ ! ■`）用报告摘要代替徽章和计量线：`✓ ⌬ docs-sync · Synced two reference…`（muted，按格截断）；只有报告没有摘要写 `reported`，没有报告写 `ended`；摘要不足 12 格就不显示。
- 深度 > 4 的行画在深度 4 的位置，前缀 `↳`；折叠的子树写 `+3 (1⚑ 2▸)`，< 40 列写 `+3⚑`。
- 选中的行下面是一张两行微卡：第 1 行委派行（`reviewer · ⊟ headless · $0.12 · 2m`，与父的 `worktreeRoot` 不同时加 `in fix-cjk`，§1 的工作树行；可见代理报告后仍活时加 `· close pane`），第 2 行按优先级取一条——可见取消短句（`⚑ Still running — stop this run in its pane`；< 40 列用 `⚑ running · stop in pane`）> 待决 / 故障原因（含缺失项，如 `? uncertain: scope unknown · no receipt · slot held`）> 最近报告摘要（含 `exit 1` 这类有来源的退出事实；终态无报告时 `ended · no report · runtime limit · exit unknown`）> 当前动作 > 模型写的 brief。没有委派行的节点（根、原生子代理）只有第 2 行。这样看一眼就知道它在哪、卡在什么上，不必为此打开 Inspector。
- （v1.1）`✓ · close pane` 行：提示词占状态词位（`close pane` / `请关窗格`），报告摘要只在右侧仍有 ≥ 12 格时跟在后面，≤ 39 列放不下时与其它状态词同样让位（§4.13 32 列）；`!` 行保留 `failed`，提示只进委派行。`⚑ · stop in pane` 行是 trouble 行，按 trouble 规则丢徽章和计量线，时钟是取消意图接受以来的驻留（`stateSince`，basis `event`）。
- （v1.1）`loaded = false` 的节点：账本已知终态的（`execution.isRunTerminal = true`、有本轮报告）照常画历史行，只在 Inspector 写 `history not loaded (budget)`；非终态的画 `? · not loaded`（muted），时钟留空，排在活着桶、按创建顺序，不亮 bar，按标记计入 `?`；两者都不画 `lastObservation` 的旧标记——旧摘要只作历史，不冒充当前。B9 没有返回的节点（`continuation[]`、`counts.omitted`）没有行，只进汇总行的 `N not loaded` 与根 Inspector 的 Coverage 节。
- （v1.1）`⚠` 行的名字：各当前关系的 `link.label` 一致时用它，否则用会话短形（`codex:51aa`，同 §4.6 的 caller 短形）；不从任一条记录猜角色，徽章与计量线按 trouble 规则丢；时钟 `~6m` 是 `conflict.since` 的年龄，永远带 `~`（`since` 是多条记录里最早的，基准混合）。
- （v1.1）intent 行（`identity.kind = delegationIntent`、`edge = intent`）：`┊` 边、名字 = 该关系的 `link.label`、标记由纯 B16 只凭账本事实算（run `starting` → `·`，`uncertain` → `?`，`failed` → `! launch failed`），没有徽章、计量线和心跳；绑定后 B9 的 `selectionMap` 把旧 intent 键映射到真实 ref 键，B10 每 tick 把自己保留的映射回传 `LinkTreeInput.selectionMap`（B9 会把链式映射压平），选中、展开与微卡状态都经映射查找，行缓存键换了但排序键仍是 `link.createdAt`，所以行不跳。

### 3.5 卡片的解剖（rich）

```
┌ ▸ ⌬ impl-parser ───────────────── 6.1sol·xhigh   头：标记 图标 名 ─ 徽章；选中时 ┌ 变 ›
│ implementer · pane 4 · bound 12m                 委派行（仅委派节点）：role · 宿主或 ⊟ headless · 握手/时间 [· run N] [· $cost]
│ Repairing recovery path; CJK tests next.         brief（模型写的）
│ ⚑ approval: run npm run test:visual?             待决 / 报告 / 退出 行（有则显示一条）
│ ▸ npm test -- parser                             当前动作
│ ▸ ⌕ scout 中文 boundaries               ◷1m00s   原生子代理子行
└ ◷12m04s · ~42 tok/s ───────────56%──────────      脚：时钟 · 速率 · 计量线
```

（B10b-s2 裁决 2026-11-03）委派行按已知字段依次写 `role · host · time [· run N] [· heartbeat age] [· $cost] [· in dir] [· slot held] [· close pane]`，未知字段省略；不换行，空间不足时依次丢目录、花费、心跳、时间词、时间、run、host，最后截短 role；`slot held` 与 `close pane` 不丢。

委派子会话各自成卡，整卡按深度缩进 2 格；深度 2 缩进 4 格。Jev 作业卡只有头、作业行（`ask · sent 4m · key 1101-a7`）、答案行（仅 answered 后：`→ ~/jev/out/parser-plan.md`）和一条无计量线的脚。卡片里只有事实和模型写的文本，没有 HUD 的命令或劝告（对账命令在 Inspector 和控制条）——两处例外是 Pro 规定的对外文字：可见取消的原句（`⚑ Still running — automatic cancellation is unavailable. Stop this run in its terminal pane.`，占待决行，允许按词换行到最多三行：48 列三行、80 列两行，是卡片正文里唯一允许多行的 HUD 句子）和可见代理报告后委派行末尾的 `· close pane`（已完成，请关闭此 pane）。（v1.1）子行计数行（`2 working · 1 done`）在节点有 `native_topology` 续读项时加 ` · children unknown`，折叠子树的计数 `+3 (1⚑ 2▸)` 同理加 `?`：`+3? (1⚑ 2▸)`。

（B10b-s2 裁决 2026-11-03）rich 有视角根时始终画根卡；根的原生子节点各成卡，其余原生后代是最近卡片内的子行。每卡最多五个子行，其余收为 `+N (…)`；不另画子行计数行。数据尚不能提供的 brief、动作和速率行直接省略，不从旧视图补值。

**手风琴**：rich 布局里的卡片可以折成一行——折起的卡片就是该节点的 compact 行（§3.4），框架列用 `─` 代替 `┌`。卡片总行数超过视口（或兄弟 > 5）时自动按顺序折叠：先 `✓ ■`，再未选中的 `▸ ·`，最后根；`⚑ ? ⚠ !`（新鲜）卡和选中卡永不自动折叠。`h`/`l` 手动折叠 / 展开。于是列表在"全是卡片"和"全是行"之间连续过渡，没有 8→9 张卡的悬崖；compact 布局仍是用户可选的"全部折起"。

### 3.6 边：深度与跨 harness

缩进 + `│ ├ └` 画已证实的边（B9 `edge = delegated`，link `bound / reported`，无冲突；`native` 边同样实线）；`┊` 画未证实的边（`edge = intent`：link `pending / claimed`，此时名字是 brief 里的 label，节点标记按 §3.3 第 8 条）。（v1.1）冲突关系在 B9 里**不产生边**：被两条记录认领、成环或带已接受 conflict 证据的子节点不在 `nodes[]` 里（除非另有无冲突的路径到达它），只以 `relations[]`（`attribution = conflict`、`conflict ≠ null`）出现。B10 为每条 `parentKey` 已被渲染的冲突关系画一行 `⚠`，挂在那个父节点下、`┊` 边、深度 = 父 + 1；同一个子因此可能出现在两个父下面，每行都写 `conflict`——两条记录各自认领，HUD 两边都画但哪边都不确认，这正是"不归属任一方"；计数按去重的 `childKey` 算一个 `⚠`，`counts.confirmedSessions` 不含它。父不在树里的冲突关系不画行，只进根 Inspector 的 Coverage 节（`1 conflict outside the tree`）。`handed_over` 的旧边不画，只在后继节点 Inspector 的"Link"节写 `predecessor`：同 owner 的转交（改任务用新 link）在 MVP 里就会出现，旧 link `handed_over / current_owner=0`，新 link 是唯一当前父边；跨 owner 转交是 v1.1。跨 harness 的边与同 harness 的边画法相同——harness 标记本身已经说明边跨了 harness，再加样式反而多一个要学的符号。

### 3.7 动作在哪

只在两处：控制条和 Inspector 第一行右侧。只读动作和有副作用的动作分开——控制条的 `⇢` 按钮只做只读的 Switch / Open / Log（词随选中行变），`↻` 按钮只做 Resume / Reconcile，仅在适用时出现（像 `⊕N`）。键位同样分开：`o` / Enter 只做 Open / Switch / Inspector，`L` 看日志，`R` 专用于 Resume / Reconcile；整秒重绘时状态跳变不会让一次按键做出另一件事。

（v1.1）Open 的门禁改读 B9 的 `host` 投影，因为读路径返回的 `interaction` 三项恒为 false（`readDelegationIn`，能力核验不在读路径产生）：`host.currentState ≠ null`（B9 只在 locator `valid`、`occupantMatches = true`、无冲突时给它）且 `stateKey` 不以 `uncertain:` 开头 → Open 可用；否则灰，Inspector 写原因（`occupant mismatch (checked 12s)` / `locator stale` / `not verified` / `supervisor lost`）。HUD 仍不从心跳推断，也不借 `bindingGeneration` 当 `occupantGeneration`。`interaction` 若将来在读路径上有真值，优先级高于本规则（§7 #21）。

`R` 在 MVP 里只显示并复制命令（Oracle2 D04 已定，不再是开放问题）：按钮和 Inspector 消费同一个契约 03 的 `ActionDescriptor {operation, linkId, runId, reason, subject: local_user, delivery: copy_only, hudHome, displayCommand}`，resume 另带 `expectedRun / mode / requestKey`。（v1.1）生产的本地 resume 入口在 B14 发布能力约定前保持 `capability_unverified`（B11 Oracle），读路径的 `allowedActions` 为空，所以 MVP 的 `↻ Resume` **永远写诊断、不复制命令**：`resume not verified on this machine · ask the parent to delegate_resume`；`↻ Reconcile` 照旧复制 `hud run reconcile <runId>`（受信模板，§7 #10），对 `⚠` 节点复制第一条（最早 `since`）记录的 run，其余在 Inspector 逐行列出。复制的是 `displayCommand`——由受信模板安全生成，含明确的 HUD_HOME、linkId、`--request-key`、`--expected-run`、`--mode`；文档里的 `hud run resume <linkId>` 只是缩写；report / label / 日志里的任何字符串都不是命令来源。重复复制同一待处理意图保留同一 `requestKey`；状态变化不能把已选操作换成另一个 run。本地 resume 入口未实现或未验证时不给裸命令，微卡 / Inspector 改写诊断和"由原父调用 `delegate_resume`"的途径。控制条回显 `✓ Copied` 两秒。绘制、通知、重连、进入 uncertain 或定时器都不触发这些动作。

| 选中行 | 按钮 / 键 | 做什么 |
|---|---|---|
| 原生 Codex 子代理 | ⇢ Switch（`o`） | 今天的切换 |
| 可见委派，`host.currentState ≠ null` 且非 uncertain（occupant 已核验、宿主可控 Herdr / tmux） | ⇢ Open（`o`） | 聚焦那个 pane / tab；`⚑ stop in pane` 与 `✓ close pane` 行的自然动作就是它——去 pane 里停止 / 关闭 |
| `host.currentState = null`（occupant 不匹配、locator stale / unknown、冲突）或 run uncertain 含 `supervisor lost` | ⇢ Open（灰） | 不可用；Inspector 写原因；HUD 只读 B9 的宿主投影，不自己从心跳推断 |
| headless（活跃或已结束；B10b-s3 裁决 2026-11-03） | ⇢ Log（`L`） | 新 pane 里 `tail -f` 日志；无宿主时显示路径 |
| 已结束且已报告（`reported`），`resumable = true`（`subject = local_user`）且本地入口已验证（MVP 里不成立） | ↻ Resume（`R`） | 复制 `ActionDescriptor.displayCommand`（缩写 `hud run resume <linkId> --request-key … --expected-run … --mode …`，Inspector 同一行），回显 `✓ Copied`。MVP：按钮出现但写诊断，不复制。直接调用是将来的可选能力：显式按键 → 固定目标确认 → 可信 executable + argv，不执行 shell 字符串，写者重验。`closed` 链接重开是 v1.1 |
| `uncertain`（含 `supervisor lost`）/ `⚠` | ↻ Reconcile（`R`） | 同上，`operation: reconcile`（缩写 `hud run reconcile <runId>`，按 run + 证据指纹幂等导入）；`supervisor lost` 时这是唯一可用的动作；`⚠` 复制第一条记录的 run |
| （v1.1）可见运行、取消意图已接受（`⚑ stop in pane`） | ⇢ Open（`o`，门禁同上） | 聚焦 pane 让用户自己停；没有 `↻`——HUD 不发信号、不送输入、不关 pane、不重试取消 |
| （v1.1）可见代理报告后仍活（`✓ / ! · close pane`） | ⇢ Open（`o`，门禁同上） | 聚焦 pane 让用户关闭；没有 `↻`（运行未终结，resume 本来就被拒） |
| 根会话 | Switch（`⌂`） | 今天的行为 |
| 普通会话（`managed = null`，无受管 run） | ⇢ Open（`o`，仅当其 `SurfaceLocator` 的 `LocatorCheck` 为 `valid` 且 `occupantMatches = true`——B10 自己采集，不经 B9 的 `host`，那只给受管 run） | 经校验的宿主 focus 能力可用；永远没有 `↻`——`SessionBinding` 或一个 pane locator 不构成 resume / cancel / report 权限，HUD 也不为它伪造 runId |

HUD 不自己改账本，不把 Open 当作 resume，不把 UI done 当作 run ended，也不把 run ended 当作任务完成（那要看报告）。

## 4. 各表面

### 4.1 bar（一行，英文）

模块与优先级沿用 `MODULE_PRIORITY`；`agents` 计数覆盖整棵树；`attention` 新增四种警示（v1.1 六种）；`notice` 新增三种通知（v1.1 六种）。警示优先级：节点级 `⚑`（要人：approval / question / needs human / `stop in pane`）> 常驻 `⚑ slots 6/6`（仅槽满时；全形 `⚑ slots 6/6 · 2 to close · 1 to reconcile`，短形 `⚑ slots 6/6`，最窄 `⚑ 6/6`；"to close"是报告后仍活的可见代理数，"to reconcile"是 uncertain 占用者数）> `✗`（失败）> `⚠`（冲突）> `?`（uncertain）> stale；恰好一条节点级警示时用全形，多条时用计数（`⚑1 ?3 ⚠1`，顺序 `⚑ ? ⚠ ✗`），常驻槽满警示接在其后、不再带自己的 `⚑`：`⚑1 ?1 · slots 6/6 · 1 to reconcile`，短形 `⚑ 1 approval · slots 6/6`，最窄 `⚑1 6/6`；计数形的最窄形只留优先级最高一类的计数（`⚑1`；无 `⚑` 时依次 `✗` `⚠` `?`），其余由 `agents` 计数与面板承担（80 列以下在 A5 范围之外）。槽满不是节点，不进 `1⚑` 的计数。有委派树时 bar 自己的树失败警示（agent-error / subtask-error / review-error）不再单独亮——它们是树里的 `!` 节点；审批与工具错误仍是 bar 自己的。notice 区不重复全形警示已点名的节点，不分类别（approval / stop in pane / failed / uncertain）。

```
200 列（full）：
⚑ review-tests approval │ fable-5.1 high │ ━━━━╸───── 112.3K/272K │ parser-kit main*↑2 │ 7d 61% │ ▸ 3:10 │ 38 tok/s │ Agents 3▸ 1⚑ 2✓ · ⌬2 π1 ◎1 │ Tasks 2/5 │ Edit src/parser.ts │ MCP 2 skills 9

120 列（balanced）：
⚑ review-tests approval │ fable-5.1 │ ━━━━╸───── 112.3K/272K │ parser-kit main* │ ▸ 3:10 │ Agents 3▸ 1⚑ 2✓ │ Tasks 2/5

80 列（focus）：
⚑ 1 approval │ fable-5.1 │ ━━━╸── 41% │ parser-kit │ ▸ 3:10 │ 3▸ 1⚑ 2✓
```

样例里非委派字段（quota、速率、分支、计量线、右簇）的取舍由现有引擎决定，样例只约束委派字段（警示形、计数与顺序、后端计数、通知）；review-pass 已完成仍计，所以 (c) 是 `2✓`。丢弃顺序照旧 `SHRINK`：右簇 → effort → 计量线缩成百分比 → notice 内容 → `Agents` 标签 → 分支 → 时钟。新增三条：后端计数 `· ⌬2 π1 ◎1` 在右簇之前丢（引擎 shrink 序 9，右簇第一步是 10，`Agents` 标签仍在 56）；`attention` 从全形退到 `⚑ 1 approval` 再到 `⚑1`，永不丢——有委派树时这两步的序是 85 / 87：全形→短形在 quota（86）被隐藏之前，短形→最窄在其后、仍先于 `agents` 被隐藏；有委派树时 `agents` 模块优先级 87（高于 quota、速率、Tasks，低于 project），80 列仍有计数；focus 密度在有委派树时加入 `agents`（只有计数、无标签，计数为空时照常不画），80 列（focus）样例由此成立。无委派树时一切照旧。

（v1.1）情境 (h)（§4.13）的 bar——可见取消意图是节点级 `⚑`，槽满是常驻 `⚑`：

```
120 列：
⚑ impl-parser stop in pane │ fable-5.1 │ ━━━━╸───── 112.3K/272K │ parser-kit main* │ ▸ 9:12 │ Agents 2▸ 1⚑ 1✓ │ Tasks 2/5

80 列：
⚑ 1 stop in pane │ fable-5.1 │ ━━━╸── 41% │ parser-kit │ ▸ 9:12 │ 2▸ 1⚑ 1✓

120 列，情境 (d)：两条节点级警示（t-07 `⚑`、t-11 `?`）用计数，其后常驻槽满：
⚑1 ?1 · slots 6/6 · 1 to reconcile │ fable-5.1 │ ━━━━╸───── 98.1K/272K │ parser-kit main* │ ▸ 8:02 │ Agents 3▸ 1· 1⚑ 1? 9✓ │ Tasks 4/9

120 列，没有节点级警示但槽满（(d) 的变体：t-07 已批准、t-11 已对账，六个槽仍占）：
⚑ slots 6/6 │ fable-5.1 │ ━━━━╸───── 98.1K/272K │ parser-kit main* │ ▸ 8:02 │ Agents 5▸ 1· 9✓ │ Tasks 4/9
```

通知（60 秒）：`✓ docs-sync reported` · `! lint-fix failed` · `? impl-b uncertain` · `⚑ review-tests approval`；（v1.1）`⚑ impl-parser still running · stop in its pane`（取消意图被接受时一次，不重复）· `✓ docs-sync reported · close its pane`（可见代理报告到达时，代替普通的 `reported` 通知）· `■ bench ended · no report`（无报告的结束）。切 tab 不触发；槽满不是通知，是常驻警示。通知是对投影的 60 秒窗口、不记状态：重启后一分钟内会再说一次；没有已知时间的事件不通知；与警示同源的通知（`⚑ … approval`、`⚑ … still running`、`! … failed`、`? … uncertain`）只在 bar 警示处于计数形时出现（全形已点名的节点不重复）。`✗` 失败警示亮到该行收进 `⊕N` 为止（3 分钟）。

### 4.2 面板树：宽度预算

| 宽度 | 行上保留 | 丢弃 |
|---|---|---|
| 56 | 全部：`◈N` 徽章全形 计量线 时钟，名字很少截断 | |
| 48（默认） | 徽章 `6.1sol·xhigh`、计量线、时钟 | 名字 > 可用时先丢 `⊟`，再截断到 ≥ 8 格 |
| 40–47 | 徽章退到 `6.1sol` 或族图标、计量线、时钟 | 徽章全形 |
| 32–39 | 计量线、时钟 | 徽章；名字字段 < 8 格时再丢计量线 |
| rich 80 | 卡片委派行可带 `run N · heartbeat 3s`；子行带徽章 | |

卡片和行每行恰好 `width` 格（`visualLength`，CJK 2 格）。（B10b-s2 裁决 2026-11-03）汇总行依次为计数、满槽 chip、一个覆盖 chip、`workers, jobs`、`N put away`、树级花费；不画速率。空间不足时依次丢 `put away`、`workers, jobs`、花费，计数和 chip 保留。`slots` 在前；覆盖 chip 只写最严重的一个（ledger unavailable > ledger busy > tree partial > N not loaded）。`N not loaded` 为已知未加载、预算遗漏及遗漏冲突行之和；只有 N 为零且树覆盖不完整时才写 `tree partial`。

### 4.3 情境 (a)：单个代理，48 列 rich

```
| ⌂  ▦ Agents    ≣   ±   ◫   ⚙ Settings    ⇢ ǁ ? |
| ▦  1▸ · ~38 tok/s                              |
|› ▸ parser-kit ─────────────────── 5.1fable·high|
|│ Fixing the streaming parser; tests next.      |
|│ ▸ Edit src/parser.ts                          |
|└ ◷3m10s · ~38 tok/s ─────────41%───────────────|
```

没有 harness 标记（单 harness 树），没有 `agents` 模块，状态卡与今天相同（略）。

### 4.4 情境 (b)：几个原生子代理

（B10b-s2 裁决 2026-11-03）视角根及其原生子节点各成卡，卡内原生后代以 `!` 失败子行排前并显示 `◷` 轮时钟，不画原来的子行计数行。（B10b-s2 裁决 2026-11-03）委派视图的汇总行是 `2▸ 1✗ 1✓`：原生节点也计入，不使用 subtasks 数或速率；无数据的 brief、动作和速率行不画。

### 4.5 情境 (c)：跨 harness 树

场景：Claude Code 会话 `main` 通过 `hud-mcp` 起了 Codex implementer（可见，pane 4，有两个原生子代理）、pi reviewer（headless，等审批）、一个 ChatGPT 作业（等答案；Jev 是阶段 C，这里只为展示作业卡）和一个已报告、运行已结束的 Codex writer。

**48 列 rich：**

```
| ⌂  ▦ Agents    ≣   ±   ◫   ⚙ Settings    ⇢ ǁ ? |
| ▦  3▸ 1⚑ 2✓ · 3 workers, 1 job · ≥$0.12        |
|› ▸ ✳ main ─────────────────────── 5.1fable·high|
|│ Coordinating parser work; waiting on workers. |
|│ ▸ delegate_wait impl-parser                   |
|└ ◷3m10s · ~38 tok/s ─────────41%───────────────|
|  ┌ ▸ ⌬ impl-parser ─────────────── 6.1sol·xhigh|
|  │ implementer · pane 4 · bound 12m            |
|  │ Repairing recovery path; CJK tests next.    |
|  │ ▸ npm test -- parser                        |
|  │ ▸ ⌕ scout 中文 boundaries             ◷1m00s|
|  │ ✓ ◈ review-pass Verified boundary fix.    3m|
|  └ ◷12m04s · ~42 tok/s ───────────56%──────────|
|  ┌ ⚑ π review-tests ─────────────── 6.1sol·high|
|  │ reviewer · ⊟ headless · $0.12               |
|  │ ⚑ approval: run npm run test:visual?        |
|  └ 10s ──────────24%───────────────────────────|
|  ┌ ▸ ◎ ask-pro ──────────────────────── chatgpt|
|  │ ask · sent 4m · key 1101-a7                 |
|  └ 4m ─────────────────────────────────────────|
|  ┌ ✓ ⌬ docs-sync ────────────────── 6.1sol·high|
|  │ writer · reported 2m                        |
|  │ ✓ Synced two reference sections.            |
|  └ 2m ─────────────31%─────────────────────────|
```

`docs-sync` 整卡变暗（报告 2 分钟前到，仍在 3 分钟的停留期内）；之后收进 `⊕N`。`review-tests` 的 `⚑` 和它的待决行是 alert 色，脚线上的 `10s` 是卡在审批上的驻留时长；`ask-pro` 没有计量线（Jev 没有 token），脚线是素线。汇总行按 §4.2 的顺序丢掉了速率，留下树级花费 `≥$0.12`（只有 pi 报成本）。

**48 列 compact（同一场景，`review-tests` 被选中，下面是两行微卡）：**

```
| ▦  3▸ 1⚑ 2✓ · 3 workers, 1 job · ≥$0.12        |
|  ▸ ✳ main            5.1fable·high ━━╸─  ◷3m10s|
| ├ ▸ ⌬ impl-parser     6.1sol·xhigh ━━━╸ ◷12m04s|
| │ ├ ▸ ⌕ scout 中文 boundaries            ◷1m00s|
| │ └ ✓ ◈ review-pass                          3m|
|›├ ⚑ π review-tests ⊟ · approval             10s|
|│ │  reviewer · ⊟ headless · $0.12 · 2m         |
|│ │  ⚑ approval: run npm run test:visual?       |
| ├ ▸ ◎ ask-pro              chatgpt           4m|
| └ ✓ ⌬ docs-sync · Synced two reference…      2m|
```

`⚑` 行按 trouble 规则丢了徽章和计量线，写出 `· approval` 和驻留时长 `10s`；微卡第 1 行说它在哪（headless）、花了多少，第 2 行说它卡在什么上；`docs-sync` 用报告摘要代替徽章。

**32 列 compact：**

```
| ▦ 3▸ 1⚑ 2✓ · ≥$0.12            |
|› ▸ ✳ main           ━━╸─ ◷3m10s|
|│ Coordinating parser work; wa… |
| ├ ▸ ⌬ impl-parser  ━━━╸ ◷12m04s|
| │ ├ ▸ ⌕ scout 中文 bou…  ◷1m00s|
| │ └ ✓ ◈ review-pass          3m|
| ├ ⚑ π review-tests ⊟        10s|
| ├ ▸ ◎ ask-pro                4m|
| └ ✓ ⌬ docs-sync              2m|
```

32 列：徽章全丢；根被选中，它没有委派行，微卡只有一行 brief；`review-tests` 的状态词比截断名字先丢，丢掉后 `⊟` 放得下所以恢复，`⚑` 和驻留时长 `10s` 仍在；`scout 中文 boundaries` 截到 15 格；完成行的报告摘要没有 12 格余地就不显示。

**80 列 rich 的一张委派卡：**

```
|› ▸ ⌬ impl-parser ───────────────────────────────────────────────── 6.1sol·xhigh|
|│ implementer · pane 4 · bound 12m · run 1 · heartbeat 3s                       |
|│ Repairing recovery path; CJK tests next.                                      |
|│ ▸ npm test -- parser                                                          |
|│ ▸ ⌕ scout 中文 boundaries                                               ◷1m00s|
|│ ✓ ◈ review-pass Verified boundary fix.                                      3m|
|└ ◷12m04s · ~42 tok/s ──────────────────────────────56%─────────────────────────|
```

80 列时委派行可以带 `run 1 · heartbeat 3s`（48 列不带 `run 1`，§0.2）。

**cc 原生子代理**在 cc 会话卡里是子行，用 `agentType` 作 kind、`description` 作名：`│ ▸ ⌕ Explore: find parser call sites      ◷0m40s`。

### 4.6 顶部父行（被委派方视角）

只在视角根有 `links.asChild` 时出现，在汇总行之上，一行。

```
| ↑ parent ✳ main · pane 2 · working · bound 12m |
| ↑ parent ? unconfirmed · caller claude:a7f3    |
| ↑ parent ✳ main · offline 3m · continue        |
```

丢弃顺序：握手时间 → pane → 父状态词 → 名字截断。`offline` 来自 `parent.offline` 事件，后面的词是冻结的 `orphan_policy`（`continue` / `stop`）。未确认时只给 caller 的短形，不给猜测的名字。

（v1.1）视角根自己的受管运行是可见的且 `cancelling` 时（父调用了取消、MVP 不可交付），父行写出这件事，因为看这个 HUD 的人就坐在该停止它的 pane 里：

```
| ↑ parent ✳ main · asked to cancel 2m · stop here|
```

`asked to cancel` 的时间是 `cancel_requested_at` 的年龄；`stop here` 比 pane 先丢，比父状态词后丢。HUD 仍不送输入、不自动停止。

### 4.7 情境 (d)：15 个工人、槽满，48 列 compact

（v1.1）运行槽上限让"15 个并发"只能长这样：非终态受管运行全局 6 个——`main` 自己占满每 owner 的 4 个（t-07、t-11、t-01、t-09），t-01 又委派了 t-12、t-13——其余 9 个已结束；原生子代理不占槽，这里略去。v1.0 的版本有 10 个非终态运行挂在一个 owner 下，按契约 02 A3 不可能出现，已改。

```
| ▦  3▸ 1· 1⚑ 1? 9✓ · slots 6/6 · ≥$1.80         |
|› ▸ ✳ main            5.1fable·high ━━╸─  ◷8m02s|
| ├ ⚑ π t-07 ⊟ · approval                     10s|
| ├ ? ⌬ t-11 ⊟ · uncertain                    14m|
| ├ ▸ ⌬ t-01            6.1sol·xhigh ━━━╸  ◷9m02s|
| │ ├ ▸ ⌬ t-12          6.1sol·xhigh ━╸──  ◷2m51s|
| │ └ · π t-13 ⊟ · starting                   12s|
| ├ ▸ π t-09 ⊟           6.1sol·high ━╸──  ◷3m15s|
| └ ✓ 9 done · t-02 t-03 t-04 t-05 t-06 …      ⊕9|
```

规则：compact 布局下全部是行；rich 布局下按 §3.5 的手风琴折叠（下图）；trouble 桶内最新卡住的在上（t-07 卡了 10 s，排在卡了 14 分钟的 t-11 之上）；汇总行因槽满多了 `slots 6/6`，按 §4.2 的顺序挤掉了 `15 workers`；完成桶折成一行，`a` 展开；活跃行 > 30 时时钟改成 `◷9m` 粒度，整秒重绘停止；超过视口的行不渲染字符串，只保留投影；200 节点预算之外的节点不成行，只进汇总行的 `N not loaded` 和根 Inspector 的 Coverage 节（§3.4）。bar 此时的警示是 `⚑1 ?1 · slots 6/6 · 1 to reconcile`（两条节点级警示用计数，槽满接在其后不带 `⚑`，§4.1）：t-11 的 uncertain 占着一个槽，只有对账能放，这就是 NOTIFY §4.9 所说的"可见的泄漏"。

同一场景的 rich 手风琴（视口放不下这么多卡：`✓ ■` 和未选中的 `▸ ·` 卡折成行，`⚑ ?` 卡和选中卡展开；t-11 的委派行多了 `slot held`，Inspector 给对账命令）：

```
| ▦  3▸ 1· 1⚑ 1? 9✓ · slots 6/6 · ≥$1.80         |
|─ ▸ ✳ main            5.1fable·high ━━╸─  ◷8m02s|
|  › ⚑ π t-07 ─────────────────────── 6.1sol·high|
|  │ reviewer · ⊟ headless · $0.04 · 10s         |
|  │ ⚑ approval: delete tests/old-fixtures?      |
|  └ 10s ─────12%────────────────────────────────|
|  ┌ ? ⌬ t-11 ────────────────────── 6.1sol·xhigh|
|  │ implementer · ⊟ headless · 14m · slot held  |
|  │ ? uncertain: scope unknown · no receipt     |
|  └ 14m ────────────31%─────────────────────────|
|  ─ ▸ ⌬ t-01           6.1sol·xhigh ━━━╸  ◷9m02s|
|    ─ ▸ ⌬ t-12         6.1sol·xhigh ━╸──  ◷2m51s|
|    ─ · π t-13 ⊟ · starting                  12s|
|  ─ ▸ π t-09 ⊟          6.1sol·high ━╸──  ◷3m15s|
|  └ ✓ 9 done · t-02 t-03 t-04 t-05 t-06 …     ⊕9|
```

### 4.8 情境 (e)：trouble，48 列

compact 总览（根已退出；五个工人分两个 owner——`main` 占满自己的 4 个槽，`impl-a` 又委派了 `rev-a`——各有一种麻烦，一个正常；Jev 作业不占槽；全局 5/6，没满）：

```
| ▦  1▸ 1⚑ 3? 1⚠ · 5 workers, 1 job              |
|› ■ ✳ main · exited    5.1fable·high ━━╸─     3m|
| ├ ▸ ⌬ impl-a          6.1sol·xhigh ━━╸─  ◷2m10s|
| │ └ ? π rev-a ⊟ · stale                     48s|
| ┊ ⚠ ⌬ impl-c · conflict                     ~6m|
| ├ ? ⌬ impl-d · supervisor lost               7m|
| ├ ⚑ ◎ ask-pro · needs human                  9m|
| └ ? ⌬ impl-b ⊟ · uncertain                  14m|
```

- `■ main · exited`：父进程已退（3 分钟前，`■` 已从 warning 退成 muted），子按 `orphan_policy=continue` 继续；子行不再重复"父离线"，树形已经说明。被委派方视角用顶部父行说。父 MCP 断连与 supervisor 死亡是两件事：前者子照常可用，后者见下一条。右端时钟按 §3.4 的状态语义：`⚑ ⚠` 是驻留时长，`?` 是最近证据年龄，`■` 是退出年龄。
- `▸ impl-a` 排在最前不是因为它自己：它的子 `rev-a` 刚 stale（48 s），子树有效桶是 trouble、桶内排序时间取子孙的（§3.2）；父行本身仍是 `▸`，不冒充 trouble。v1.0 的这个例子没有按自己的排序规则排，已改。
- `? rev-a · stale`：muted 色；健康运行上的心跳延迟，supervisor 死亡未证实；时钟是最近心跳年龄 48 s。等待或查看，不需要对账。
- `⚠ impl-c · conflict`：两条记录都认领它（`main` 的 link，和另一个 Claude 会话 resume 时解析到的同一个 ref）。B9 不给它边也不给它 run（§3.6），HUD 在已渲染的父 `main` 下画 `┊` 行；时钟 `~6m` 是 `conflict.since` 的年龄；不归属任一方；Inspector 的 `── Conflict ──` 节逐条列记录（下）。两条记录的 run 都 uncertain、都占槽。
- `? impl-d · supervisor lost`：warning 色。甲下托管进程已死：终端前台回到 shell，harness 被挂起（`suspended (tty input)`），run 进入 uncertain 并继续占槽（根 Inspector 的 Slots 节标 `reconcile first`）。行上不写 pane 可用；（B10b-s3 裁决 2026-11-03）`⇢` 是灰色 Open，Reconcile 在 `↻`，不送输入、不自动 fg、不自动 resume；焦点行 `? supervisor lost · harness suspended in pane 4 · reconcile first`。
- `⚑ ask-pro · needs human`（阶段 C）：Jev `NEEDS_HUMAN`，浏览器租约仍被持有；焦点行 `⚑ needs human: login expired in shared browser`。
- `? impl-b · uncertain`：warning 色；其它对账原因（这里是 scope 无法查询）；时钟是最近证据年龄；委派行写 `slot held`。

uncertain 的 rich 卡（v1.1 委派行多了 `slot held`）：

```
|  ┌ ? ⌬ impl-b ──────────────────── 6.1sol·xhigh|
|  │ implementer · ⊟ headless · run 2 · slot held|
|  │ ? uncertain: scope unknown · no receipt     |
|  └ 14m ───────────────38%──────────────────────|
```

uncertain 的 Inspector（控制条略；`⇢` 的词是 Reconcile）：

```
| ? impl-b                              Reconcile|
| label impl-b · implementer                     |
| ~/work/parser-kit                              |
| gpt-6.1-sol · xhigh                            |
| ? uncertain · handshake claimed                |
| Ctx 38% (103.4K/272K) · last 14m               |
| Turn age: 16m                                  |
| Last activity: 14m                             |
| ── Link ──                                     |
| parent ✳ main (pane 2) · bound 25m             |
| run 2 handshake claimed · waiting for receipt  |
| ── Run ──                                      |
| run 2 · headless · uncertain 2m · slot held    |
| cause: scope unknown · heartbeat 2m14s         |
| missing: exit receipt (scope)                  |
| reconcile: hud run reconcile r_0b7c            |
| log ~/.hud/runs/r_0b7c/stdout.log              |
| ── Reports ──                                  |
| run 1 ✓ completed 25m · Parser repaired, te…   |
| ── Coverage ──                                 |
| partial · 2 records skipped                    |
| ▾ More                                         |
```

这里 link 是 `bound`（关系早已证实）而 run 2 的 `runHandshake` 是 `claimed`：两者分开写，正是契约 03 I-03-3 的区别。`reconcile:` 一行是缩写，`R` 复制的是 `ActionDescriptor.displayCommand` 全文（含 HUD_HOME）；本地入口未验证时这一行改写诊断，不写命令。`▾ More` 展开 link_id、run_id、child_ref、三种代次（宿主的 `occupantGeneration`、受管 run 的 `bindingGeneration`、reader 的 `sourceGeneration`，各自一行，缺的写 `—`，从不互相借值或比较）、每轮 run 的 `operation`（spawn / resume / handover，接受时固定）、evidence id 列表与完整路径。

`supervisor lost`（可见运行 `impl-d`）的 Inspector 头几行——与上面的区别是原因、交互不可用的明示和灰掉的 Open：

```
| ? impl-d                              Reconcile|
| ? supervisor lost · pane 4 · no focus          |
| ── Run ──                                      |
| run 1 · visible · supervisor died 7m           |
| harness suspended · input goes to the shell    |
| slot held · reconcile before any resume        |
| reconcile: hud run reconcile r_0d44            |
```

（v1.1）`⚠ impl-c` 的 Inspector 头几行与 `── Conflict ──` 节：两条记录都列、都不确认；`↻ Reconcile` 复制第一条（最早 `since`）记录的 run 的命令，其余只显示：

```
| ⚠ impl-c                              Reconcile|
| ⚠ conflict · 2 records · since ~6m             |
| ── Conflict ──                                 |
| link:l_7c2a · ✳ main · r_51aa uncertain        |
| link:l_9e10 · ✳ claude:b2c4 · r_6b03 uncertain |
| no run attributed · both runs hold a slot      |
| reconcile: hud run reconcile r_51aa            |
```

每条记录一行：`recordIds` 里的 id（`link:…` / `native:…` / evidence id）、该关系的父（harness 标记 + 名字或 caller 短形）、该关系的 run 与状态；最多 5 条，更多写 `+N more`，`truncation.conflictRecords > 0` 时再加 `+N not listed`。

bar 上的对应警示：这里有五条，所以是计数 `⚑1 ?3 ⚠1`（最窄 `⚑1`）；只有一条时才是全形 `⚑ ask-pro needs human`；`supervisor lost` 在 `?` 里计数，notice 用整句 `? impl-d supervisor lost`。

### 4.9 情境 (f)：headless

行：`⊟` 后缀；卡片委派行 `reviewer · ⊟ headless · $0.12`；控制条：

```
| ⌂  ▦ Agents    ≣   ±   ◫   ⚙ Settings ⇢ Log ǁ ?|
```

结束并已报告后，`↻` 按钮出现（只在适用时），`⇢ Log` 仍可看日志：

```
| ⌂  ▦ Agents  ≣  ±  ◫  ⚙  ⇢ Log ↻ Resume ǁ ?    |
```

`Log`（`L`）在宿主可控时开一个 pane 跟日志，否则 Inspector 里显示路径。`↻ Resume`（`R`）在 `resumable = true`（subject `local_user`）且本地入口已验证时可用（复制 `displayCommand` 并回显 `✓ Copied`，§3.7）；否则灰，Inspector 写 `reason`（如 `not resumable: revoked`）；本地入口未验证时写诊断而不是命令——（v1.1）MVP 里永远是这种情况（`capability_unverified`，§3.7、§7 #11），按钮出现但按下只在 Inspector 写 `resume not verified on this machine · ask the parent to delegate_resume`。报告后的 headless 由 hud-run 按冻结政策退役，HUD 不提示也不计时；退役结果见 §4.10。headless 运行的"可见"信息不存在，所以不写 pane。headless 是 hud-run 的直接子进程，原生退出结果通常可得，`failed · exit 1` 这样的行主要出现在这里；可见运行（方案甲）的原生退出结果通常是 null——结束只由已核验的进程组为空证实，`✓` 只来自 completed 报告，没有报告就是 `■ ended`，shell status 只在 `▾ More` 作诊断，永不当退出码。

### 4.10 情境 (g)：完成与历史，48 列 compact

默认（完成项已收起）：

```
| ▦  1▸ 1✗ 6✓ · 1 worker · 7 put away            |
|› ▸ ✳ main            5.1fable·high ━━╸─  ◷1m20s|
| └ ▸ ⌬ impl-parser     6.1sol·xhigh ━━━╸ ◷12m04s|
```

`a` 之后：

```
| ├ ✓ ⌬ docs-sync · Synced two reference…     14m|
| ├ ✓ ◎ ask-pro · → parser-plan.md            22m|
| ├ ! π lint-fix · Lint rule 12 unresolv…     31m|
| ├ ■ ⌬ bench · cancelled                      1h|
| ├ ■ ⌬ soak · ended · runtime limit           2h|
| ├ ✓ ⌬ t-07 · reported                        3h|
| └ ■ ⌬ t-old · ended                          2d|
```

历史行一律 muted；时钟是结束年龄；名字后面是最有信息量的收尾事实：有报告摘要就按格截断显示摘要（`✓` 和 `!` 都是，一排 `· reported` 什么都说不了），只有报告没有摘要写 `reported`，没有报告写 `ended`；（v1.1）无报告且 `termination.requestedCause` 是 `runtime_limit / retire_idle / retire_blocked_wait / orphan_policy` 时加原因词——`soak · ended · runtime limit` 说的是"到了 4 小时上限、任务没交差"，微卡第 2 行 `ended · no report · runtime limit · exit unknown`；`retire_after_report` 不加词（有报告时行本来就是 `✓`）。取消已接受但先后未知的结束仍是 `ended`，微卡第 2 行多一句 `cancel timing unknown`，退役先后未知的是 `retire timing unknown`（Inspector 同一句，来自 `terminalNote`）；`bench · cancelled` 这样的行只在取消先于结束已证明时出现；`docs-sync` 是报告后被 hud-run 退役的 headless writer，行上只有 `✓` 和摘要，退役原因只在 Inspector（下）；有来源的退出结果（`exit 1`）进微卡，不占行；`ask-pro` 行是阶段 C 的作业历史，显示产物名；`t-old` 超出 200 节点预算、观测没加载，但账本知道它已结束，所以照常画历史行，Enter 打开的 Inspector 写 `history not loaded (budget)`（v1.0 在行上写 `not loaded` 的做法只保留给非终态的未加载行，§3.4）。`closed` 与重开是 v1.1，MVP 的历史里不会出现；同 owner 转交留下的 `handed_over` 旧链接会出现，但只在后继节点的 Inspector 里作 `predecessor` 历史，不单独成行。

（v1.1）被退役的 `docs-sync` 的 Inspector：结果、请求原因、归因各一行，不合成一个图标；唤醒登记一行；`▾ More` 里才有 evidence id 与完整阶梯：

```
| ✓ docs-sync                                    |
| label docs-sync · writer                       |
| ~/work/parser-kit                              |
| gpt-6.1-sol · high                             |
| ✓ reported · ended 4m                          |
| ── Link ──                                     |
| parent ✳ main (pane 2) · reported 14m          |
| wake registered · claude                       |
| ── Run ──                                      |
| run 1 · headless · ended 4m · exit unknown     |
| outcome completed · report 14m                 |
| requested: retired after report · 4m           |
| termination: ended by that request · INT · R   |
| log ~/.hud/runs/r_3a9e/stdout.log              |
| ── Reports ──                                  |
| run 1 ✓ completed 14m · Synced two reference…  |
| ▾ More                                         |
```

三行的词表（`termination` 字段 → 词，EN / ZH 见 §5.5）：`outcome` completed / failed / blocked / unknown → `completed` / `failed` / `blocked`（报告是 interrupted 时写 `blocked (interrupted)`）/ `no report for this run`；`requestedCause` user_cancel / retire_after_report / retire_idle / retire_blocked_wait / runtime_limit / orphan_policy / null → `cancel requested` / `retired after report` / `retired idle` / `retired after blocked wait` / `runtime limit` / `parent gone, policy stop` / 这一行不画；`attribution` caused / not_caused / unknown → `ended by that request` / `ended on its own, before it` / `timing unknown`（这时 `terminalNote` 一定是 `retire_timing_unknown` 或 `cancel_timing_unknown`，微卡也有那句）；`observed.escalatedTo` → `INT` / `INT→TERM` / `INT→TERM→KILL`，`scopeEvidence` → `R` / `Q` / `N`。NOTIFY §4.4 的三个例句于是分别是：`outcome completed · requested: retired after report · termination: ended by that request`、`outcome failed · requested: retired after report · termination: ended by that request`、`outcome no report for this run · requested: runtime limit · termination: ended by that request`——"task incomplete"不另写，`no report` + `runtime limit` 已经说了。requested 一行不存在时（用户取消、自然退出）只有 outcome 与 termination 两行；`termination` 投影缺席（旧写者）时三行都不画。

### 4.11 Inspector（委派 Codex 子会话，健康）

```
| ⌬ impl-parser                             Open |
| label impl-parser · implementer                |
| ~/work/parser-kit                              |
| gpt-6.1-sol · xhigh                            |
| ▸ working · pane 4                             |
| Ctx 56% (152.3K/272K)                          |
| Out ~42 tok/s                                  |
| Turn age: 2m                                   |
| Last activity: 4s                              |
| ── Link ──                                     |
| parent ✳ main (pane 2)                         |
| bound 12m · mcp · receipt+transcript           |
| ── Run ──                                      |
| run 1 · visible · wrapper                      |
| heartbeat 3s · started 12m                     |
| log ~/.hud/runs/r_7f21/stdout.log              |
| ── Reports ──                                  |
| none yet                                       |
| ── What it was given ──                        |
| Repair the streaming parser; keep CJK bounda…  |
| ── Latest update ──                            |
| Recovery path fixed; running the CJK suite.    |
| ▾ More                                         |
```

节的出现条件："Candidates"只在有候选时；"Coverage"只在不完整时（根节点另加树级：`counts.knownUnloaded / omitted / unknownDescendants`、`truncation`、`ledger.reason`）；"Reports"永远（没有就写 `none yet`，这是现有的两个空句子例外之外新增的一个，理由：报告的缺席本身是信息；§8 #10 已关闭：保留）；（v1.1）"Conflict"只在 `conflict ≠ null` 时（§4.8）；"Slots"只在根节点、账本可读时；`── Link ──` 里的 `wake …` 行只在 B19 投影给出 `registered | degraded | unconfirmed` 时（`none` 或投影缺席不画）；`── Run ──` 里的 outcome / requested / termination 三行只在运行终态且 `termination` 投影存在时（§4.10）；`observation = null` 而 `lastObservation` 存在时（新 run、旧摘要），事实块写 `no current observation · summary is for run 1`，旧摘要的长文本节放在 `── Previous run ──` 之下。Jev 作业（阶段 C）的 Inspector 用 `── Job ──`：provider、account 显示名、key、state、租约（`shared browser · held`）、credits、答案路径。

（v1.1）根节点 Inspector 的 `── Slots ──`（情境 (d)）：第一行是 `held/limit` 与 `mine/limit`，`limits default` 表示 `delegate.json` 没有配 `limits`；然后是我的占用者，每行一个（桶序；uncertain 的写 `reconcile first`，报告后仍活的可见代理写 `close pane`）；别的 owner 按名字合计（在树里的用名字，不在树里的写 `held outside this tree`）。命令只在该占用者自己的 Inspector 里，这里不重复：

```
| ── Slots ──                                    |
| 6/6 held · mine 4/4 · limits default           |
| ⚑ t-07 approval 10s                            |
| ? t-11 uncertain 14m · reconcile first         |
| ▸ t-01 running 9m                              |
| ▸ t-09 running 3m                              |
| 2 held by t-01                                 |
```

根节点的 `── Coverage ──` 写 B9 的树级事实，原因词照 `coverage.reason` / `continuation.reason` 原样：

```
| ── Coverage ──                                 |
| partial · tree incomplete · 3 not loaded       |
| 1 omitted beyond 200 nodes · children unknown  |
```

`wake` 行的词：`wake registered · claude`（adapter 短名：claude / codex queue / pi）、`wake degraded · codex queue`、`wake unconfirmed · 2 attempts`；它说的是"这个 link 的父会不会被叫醒"，只是提示，账本才是事实，所以不进行、不进 bar。

### 4.12 statusline（Claude Code，窄）

短命进程，stdin 字段（session、model、context、cost）永远优先；失败标准 p95 渲染 > 150 ms。最多两行，高度只在 1 / 2 之间变：第一行是会话事实（claude-hud 0.8.0 的同等项），有委派时末尾常驻计数 `⧉ 2▸ 1⚑ 1✓`；第二行只在有活跃或 trouble 委派时出现，只展开 `⚑ ! ⚠ ?` 节点（带状态词和驻留时长）和前 2–3 个活跃节点，其余收成 `+N`。没有第三行——警示已经在第二行的最前面。设置 `statusline.delegationLine=false` 时只保留第一行末尾的计数。

```
80 列：
fable-5.1 ━━━━╸───── 41% │ parser-kit │ $1.24 │ ▸ Edit parser.ts │ ⧉ 2▸ 1⚑ 1✓
⧉ ⚑ π review-tests approval 10s · ▸ ⌬ impl-parser 12m · ▸ ◎ ask-pro 4m · +1✓

120 列：
fable-5.1 high ━━━━╸───── 112.3K/272K │ parser-kit main*↑2 │ $1.24 · 38 tok/s · 12m │ ▸ Edit src/parser.ts │ ⧉ 2▸ 1⚑ 1✓
⧉ ⚑ π review-tests approval 10s · ▸ ⌬ impl-parser pane 4 12m · ▸ ◎ ask-pro 4m · +1✓

200 列：第一行加 Tasks、usage window 与 MCP/skills 计数；第二行同 120 列并带每项的 pane / 模式，`+N` 展开到 5 项。
```

第二行的项按 §3.2 的桶排序（trouble 最新在前），每项 `标记 harness 名 [词] 年龄`，年龄语义同 §3.4；宽度不够时先丢 pane / 模式，再丢年龄，再把活跃项收成 `+N▸`，再丢 trouble 项的状态词（保留标记、harness、名字），trouble 项最后才缩成计数（顺序 `⚑ ? ⚠ ✗`）；`+N` 余项按第一行的计数写法（`+1✗ +5✓`，`■` 计入 `✓`）；冲突节点在第二行是一项 `⚠ ⌬ impl-c conflict ~6m`（按 childKey 去重），statusline 不画的是冲突记录（Inspector 的逐条列表）；`stop in pane` / `close pane` 项后不再重复 pane 标签；整行放不下就只留第一行的计数。数据来源见 §6.9。（v1.1）词表与行相同：`⚑ ⌬ impl-parser stop in pane 2m`、`✓ ⌬ docs-sync close pane 8m`（close pane 项按活着桶排在 `▸` 之后，不收进 `+N`）；槽满时第一行末尾的计数后附 `· 6/6`（`⧉ 2▸ 1⚑ 1✓ · 6/6`），不另起项；statusline 不画 termination、wake 和冲突记录。

### 4.13 情境 (h)：可见运行的收尾——取消意图与关 pane（v1.1）

场景：Claude Code 会话 `main` 有三个委派：Codex implementer `impl-parser`（可见，pane 4）——父 2 分钟前调用了 `delegate_cancel`，意图被接受但 MVP 不可交付，它还在跑测试；pi reviewer `review-tests`（headless）在工作；Codex writer `docs-sync`（可见，pane 5）8 分钟前报告 completed，pane 还开着，槽还占着。全局 3/6，没满。

**48 列 rich（`impl-parser` 被选中；取消原句占待决行、换成三行；B10b-s3 裁决 2026-11-03：控制条显示动作词）：**

```
| ⌂  ▦ Agents  ≣   ±   ◫   ⚙ Settings ⇢ Open ǁ ? |
| ▦  2▸ 1⚑ 1✓ · 3 workers · ≥$0.08               |
|┌ ▸ ✳ main ─────────────────────── 5.1fable·high|
|│ Coordinating parser work; waiting on workers. |
|│ ▸ delegate_wait review-tests                  |
|└ ◷9m12s · ~38 tok/s ─────────41%───────────────|
|  › ⚑ ⌬ impl-parser ─────────────── 6.1sol·xhigh|
|  │ implementer · pane 4 · bound 14m            |
|  │ ⚑ Still running — automatic cancellation is |
|  │   unavailable. Stop this run in its terminal|
|  │   pane.                                     |
|  │ ▸ npm test -- parser                        |
|  └ 2m ──────────────────────58%────────────────|
|  ┌ ▸ π review-tests ─────────────── 6.1sol·high|
|  │ reviewer · ⊟ headless · $0.08               |
|  │ Checking the visual suite; two diffs so far.|
|  └ ◷3m40s · ~35 tok/s ────24%──────────────────|
|  ┌ ✓ ⌬ docs-sync ────────────────── 6.1sol·high|
|  │ writer · pane 5 · reported 8m · close pane  |
|  │ ✓ Synced two reference sections.            |
|  └ 8m ─────────────31%─────────────────────────|
```

`impl-parser` 的头是 `⚑`（alert，加粗），脚线上的 `2m` 是取消意图接受以来的驻留；待决行是 Pro 规定的原句，按词换行，没有 spinner、没有倒计时、没有"Cancelling…"；当前动作行照常，因为它确实还在跑。`docs-sync` 的 `✓` 已过 60 s、退成 muted，但整卡不变暗——它不是历史，委派行末尾的 `close pane` 是 text 色；脚线 `8m` 是报告年龄。两张卡都在活着桶尾（§3.2）。控制条的 `⇢` 对两者都是 `Open`：去 pane 里停止 / 关闭，HUD 自己什么都不做。

**48 列 compact（同一场景，`impl-parser` 被选中）：**

```
| ▦  2▸ 1⚑ 1✓ · 3 workers · ≥$0.08               |
|  ▸ ✳ main            5.1fable·high ━━╸─  ◷9m12s|
|›├ ⚑ ⌬ impl-parser · stop in pane             2m|
|│ │  implementer · pane 4 · bound 14m           |
|│ │  ⚑ Still running — stop this run in its pane|
| ├ ▸ π review-tests ⊟   6.1sol·high ━╸──  ◷3m40s|
| └ ✓ ⌬ docs-sync · close pane                 8m|
```

`⚑` 行按 trouble 规则丢徽章和计量线，写 `· stop in pane`；微卡第 2 行是短句（原句太长，§3.4）。`docs-sync` 行的 `close pane` 占状态词位，报告摘要在 48 列已没有 12 格余地，不显示。

**32 列 compact：**

```
| ▦ 2▸ 1⚑ 1✓ · ≥$0.08            |
|  ▸ ✳ main           ━━╸─ ◷9m12s|
|›├ ⚑ ⌬ impl-parser            2m|
|│ │  implementer · pane 4 · 14m |
|│ │  ⚑ running · stop in pane   |
| ├ ▸ π review-tests  ━╸── ◷3m40s|
| └ ✓ ⌬ docs-sync              8m|
```

32 列：`stop in pane` 作为状态词比截断名字先丢（≤ 39 列的规则），`⚑` 与驻留 `2m` 仍在，微卡第 2 行换成最短形 `⚑ running · stop in pane`；时钟列固定 7 格，`close pane` 在 32 列放不下，按 ≤ 39 列规则让位，40 列起恢复；statusline 永远保留它。bar 与 statusline 见 §4.1、§4.12。

`docs-sync` 的 Inspector `── Run ──` 这时写 `run 1 · visible · running · reported 8m · slot held until the run ends`，下一行 `completed · close this pane`（已完成，请关闭此 pane）；用户在 pane 里退出 harness 后，hud-run 核验进程组为空，run 变 `ended`，行转入情境 (g)。如果用户销毁了 pane 而不是退出 harness，可能出现 `? supervisor lost`（§4.8）——HUD 不替用户选路线，B13 的技能文档写各 harness 已测试的手动停止路线。

## 5. 视觉风格

### 5.1 保持与改变

保持：调色板角色与五个调色板、状态标记 `· ▸ ✓ ! ■ ?`、模型族与 effort 图标、kind 图标、`◈N` chip、轮时钟面、计量线三色阈值（70 / 85）、卡片骨架、选中 = band + `›`、控制条、`t()` 双语、bar 英文。

改变（有理由）：

| 改变 | 理由 |
|---|---|
| 新标记 `⚑`（要人）、`⚠`（记录冲突） | 今天的 `?` 兼任 unknown 与 stale；跨 harness 后"要人"和"记录打架"是最需要一眼认出的两种求助，不能和"不知道"共用一个符号 |
| harness 标记 `✳ ⌬ π ◎` 占图标位 | 跨 harness 树的"谁"；单 harness 树不出现，老用户看不到变化 |
| 模式后缀 `⊟` | headless 没有 pane，是动作可用性的关键事实 |
| 汇总行数字在前 | 与 bar 一致 |
| 失败在行上仍是 `!`，bar 上仍是 `✗` | 现状如此；行上 `!` 一格贴着文字更清楚，bar 的 `✗` 已在基线里；不为统一而改 |

### 5.2 颜色角色

| 元素 | 角色 |
|---|---|
| `▸` | info |
| `✓` | success；结束 60 s 后 muted（`FRESH_FINISH_MS`） |
| `!` | danger（红只给失败和 ≥ 85% 的计量线） |
| `⚑` | alert = danger 色加粗（与 bar 警示徽章同一色源，徽章本身是反白）：红色家族只有两个意思——要人（`⚑` 加粗）与失败（`!` 常规）；黄色（warning）= 不确定 / 冲突 / 中断（`? ⚠ ■`） |
| `⚠`、uncertain / supervisor lost 的 `?` | warning |
| `■` | warning；发生 60 s 后 muted（与 `✓` 同一条 `FRESH_FINISH_MS` 规则；v1.1 起无报告的 `■ ended` 也一样，不再立即 muted） |
| `⚑ stop in pane`（v1.1）的标记、行词、卡头 | alert（加粗），与其它 `⚑` 同；待决行里的契约原句本身是 text 色，只有行首的 `⚑` 是 alert |
| `close pane`（v1.1）行词 / 委派行后缀 | text；不随 `✓` 的 60 s 规则变 muted，整行也不按历史行变暗（它不是历史） |
| `slots 6/6` chip（v1.1） | warning（只在满时出现，所以一出现就是 warning）；Inspector `── Slots ──` 的行按各自标记的颜色，合计行 text |
| `3 not loaded` / `tree partial` / `ledger busy` chip（v1.1） | muted；`ledger unavailable` warning |
| termination 三行、wake 行（v1.1） | text；`timing unknown`、`wake unconfirmed`、`wake degraded` muted——它们是"不知道"，不是故障 |
| 刚换桶的节点（3 s 内） | 状态词与时钟 bold |
| stale / unknown 的 `?`、`·` | muted |
| harness 标记 | muted；选中行 strong |
| 名字 | text；根 strong；历史 / stale / not loaded 行整行 muted |
| 状态词 | 与标记同色 |
| 徽章、Jev provider | model（max / ultra effort 仍 warning） |
| `⊟`、`$0.12`、`12cr`、`pane 4` | muted |
| 未证实边 `┊` | muted |
| 选中行 | selectedBand + `›`；行上的每个 span 都走 `onSelectedBand` 角色族（text、muted、accent、success、warning、danger、info、model）：对 band 的对比度 text ≥ 4.5:1，muted ≥ 3:1 且与 text 相差 ≥ 1.5:1，色相角色 ≥ 3:1 且只动明度（色相 ±6°、饱和度 ±6 以内）；达标的角色与原色相同，不达标的按明度校准（latte 的 warning `#9C6414`、success `#337F22`、info `#0378A6`）；band 上的 strong = text 加粗，alert = danger 加粗；徽章（含 max / ultra 的 warning）与计量线填充同样走该族（B10b 裁决 2026-11-02）；没有 band 的调色板（`none`、`terminal`）选中 = `›` + 名字加粗，不画底色 |
| bar 警示 | alert |

harness 不用颜色区分：颜色已经承担状态和 agent 方向色，再加一层会让 `▸` 失去唯一的"亮"。若用户反馈分不清，加设置 `harnessColors`（§9）。

### 5.3 图形与 ASCII 退化

`icons=text` 时下表整体切到 ASCII；其它图标集用 unicode 列（nerd 集暂不另配）。

| 含义 | unicode | ASCII |
|---|---|---|
| starting | `·` | `.` |
| working | `▸` | `>` |
| needs human / stop in pane（v1.1 复用，不加新符号）/ slots full（bar） | `⚑` | `@` |
| done / idle | `✓` | `+` |
| failed | `!` | `!` |
| interrupted / exited | `■` | `#` |
| uncertain / unknown / stale | `?` | `?` |
| conflict | `⚠` | `^` |
| Claude Code | `✳` | `C` |
| Codex | `⌬` | `X` |
| pi | `π` | `P` |
| Jev（阶段 C） | `◎` | `J` |
| headless | `⊟` | `-` |
| 边 | `│ ├ └ ┊ ↳` | `\| \| \` : >` |
| 计量线 | `━━╸─` | `===-` |
| 父行 | `↑` | `^` |
| 委派计数 | `⧉` | `#` |

宽度事实（`unicodedata.east_asian_width`）：新增标记里 `✳ ⌬ ⚑ ⚠ ⊟ ▸ ✓ ⧉ ↳ ↻` 都是 Neutral，只有 `π ◎` 是 Ambiguous；而今天的面板已经满屏 Ambiguous 字符——`· ■ ◈ │ ├ └ ─ ━ ⊕` 全是 A 类。所以"把 ambiguous 当宽字符的终端"今天就画不出这个面板，本稿不新增风险类别；HUD 一如今天按 1 格计，这类终端用 `icons=text`。两条硬规则：绝不在 `⚠` 等符号后面跟 U+FE0F 变体选择符（那会把它变成 2 格的 emoji）；`⌬`（U+232C）在部分编程字体缺字形，字体缺字时整套 harness 标记一起切到 ASCII 列，不单换一个。

### 5.4 字体效果、密度、动效、CJK、明暗

- **bold**：根名、选中行名、警示词；**dim / muted**：历史、stale、not loaded、辅助字段；**underline**：只用于 rich 卡头的名字（可切换会话的提示，与今天相同）；反白不用。`none` 调色板下仍发 bold / dim。
- **密度**：bar 三档不变；面板 rich / compact 不变；rich 下的手风琴折叠（§3.5）是唯一新增的自动变化，而且是逐张卡折，不是整棵树换布局。
- **动效**：只有选中卡关系行的 `⇄/⇆` 250 ms 标记（现有）；行上没有 spinner，"活着"由时钟和心跳年龄回答；其它变化最多每秒一次，reduced motion 时静止。
- **CJK**：所有截断走 `truncateAnsi`，按格计算；ZH 状态词限 ≤ 8 格（`未确定 需要人 记录冲突 已退出 已关闭 已取消 启动中 已回答 未加载 离线 等浏览器 过期`，v1.1 再加 `手动停止 请关窗格 超时限 空闲上限 阻塞上限 父已断 槽已满 树不完整 账本忙`；`两条记录` 不再用）。契约原句里的 `——` / `—` 是 Ambiguous 宽度，与面板上其它 A 类字符一样按 1 格计（§5.3）；`icons=text` 时写成 `-`。
- **明暗**：latte / mocha 都不靠颜色单独表达状态——每个状态有标记，每个 trouble 有词；muted 在 latte 上保持可读由调色板负责（现有）。选中行的 band 是另一块底色，§5.2 的 `onSelectedBand` 下限由单元测试守住；mocha / titanium 的原色全部达标，只有 latte 的三个状态色需要校准。

### 5.5 用词表（`t()`）

| EN | ZH |
|---|---|
| starting / idle / uncertain / stale / unknown | 启动中 / 空闲 / 未确定 / 过期 / 未知 |
| approval / question / needs human / blocked | 审批 / 提问 / 需要人 / 受阻 |
| failed / launch failed / interrupted / cancelling / cancelled / exited / ended / closed | 失败 / 启动失败 / 已中断 / 取消中 / 已取消 / 已退出 / 已结束 / 已关闭 |
| answered / sent / waiting / browser queue | 已回答 / 已发送 / 等待中 / 等浏览器 |
| conflict / not loaded / offline / unconfirmed | 记录冲突 / 未加载 / 离线 / 未确认 |
| supervisor lost / no report / exit unknown / cancel timing unknown / Copy command | 托管中断 / 无报告 / 退出未知 / 取消先后未知 / 复制命令 |
| handshake · claimed · bound · reported | 握手 · 已声明 · 已绑定 · 已报告 |
| parent / pane / headless / run / worker(s) / job(s) / put away | 父 / 窗格 / 无界面 / 轮 / 委派 / 作业 / 已收起 |
| Link / Run / Reports / Candidates / Coverage / Job / Conflict / Slots / Previous run（v1.1） | 链接 / 运行 / 报告 / 疑似 / 覆盖 / 作业 / 冲突 / 槽位 / 上一轮 |
| Open / Log / Resume / Reconcile / Switch | 打开 / 日志 / 恢复 / 对账 / 切换 |
| （v1.1）stop in pane / close pane / conflict / slots / slot held / to close / to reconcile / held by / held outside this tree / limits default | 手动停止 / 请关窗格 / 记录冲突 / 槽 / 占槽 / 待关闭 / 待对账 / 由…占用 / 树外占用 / 默认上限 |
| （v1.1）Still running — automatic cancellation is unavailable. Stop this run in its terminal pane. / Still running — stop this run in its pane / running · stop in pane | 仍在运行——自动取消不可用，请在其终端 pane 内停止 / 仍在运行——请在其 pane 内停止 / 运行中 · 手动停止 |
| （v1.1）completed · close this pane / slot held until the run ends / still running · stop in its pane（通知）/ reported · close its pane（通知）/ ended · no report（通知） | 已完成，请关闭此 pane / 运行终结前占槽 / 仍在运行 · 请在其 pane 内停止 / 已报告 · 请关闭其 pane / 已结束 · 无报告 |
| （v1.1）runtime limit / idle limit / blocked limit / parent gone（行词） | 超时限 / 空闲上限 / 阻塞上限 / 父已断 |
| （v1.1）outcome / requested / termination · cancel requested / retired after report / retired idle / retired after blocked wait / runtime limit / parent gone, policy stop | 结果 / 请求 / 终止 · 已请求取消 / 报告后退役 / 空闲退役 / 阻塞等待后退役 / 超时限 / 父断连，策略停止 |
| （v1.1）ended by that request / ended on its own, before it / timing unknown / no report for this run / blocked (interrupted) / retire timing unknown | 由该请求结束 / 自行结束，先于请求 / 先后未知 / 本轮无报告 / 受阻（已中断）/ 退役先后未知 |
| （v1.1）wake registered / wake degraded / wake unconfirmed / attempts | 唤醒已登记 / 唤醒已降级 / 唤醒未确认 / 次尝试 |
| （v1.1）not loaded / tree partial / children unknown / ledger busy / ledger unavailable / records / more / not listed / parent unconfirmed / no current observation / summary is for run N / history not loaded (budget) / conflict outside the tree | 未加载 / 树不完整 / 子代未知 / 账本忙 / 账本不可读 / 条记录 / 更多 / 未列出 / 父未确认 / 无当前观测 / 摘要属于第 N 轮 / 历史未加载（预算）/ 树外冲突 |
| （v1.1）resume not verified on this machine · ask the parent to delegate_resume / occupant mismatch / locator stale / not verified | 本机 resume 入口未验证 · 请原父调用 delegate_resume / 占用者不符 / 定位已过期 / 未核验 |

## 6. 性能规则（G13）

1. **每 tick 的 I/O**：账本只做索引查询（父 / 子 ref 两个索引），`LIMIT 200`，与文件证据共用 8 MiB 预算；先查 `PRAGMA data_version`，没变就不查表。tick 节奏沿用自适应：活跃 1 s，空闲 5 s；没有按秒轮询账本。
2. **三层缓存**：(a) 节点投影缓存，键 `(DisplayNodeIdentity, asOfSeq, observationStamp.commitSeq, evidenceStamp)` → 标记、词、桶、计数贡献（ledger 戳与观测戳各自参与，不比较）；(b) 行字符串缓存，键 `(nodeStamp, width, selected, lang, look, icons, clockBucket)`；(c) 卡片缓存（现有，500 张，`cardNow` 整秒）。Inspector 不缓存（一次只有一个）。
3. **每 tick 重算**的只有：汇总计数、警示列表（都是对 ≤ 200 个缓存投影的一次遍历）和焦点行；（DOC2 裁决 2026-11-05）排序事实、树结构或排序选项变化时重算顺序，仅时间流逝不触发重排。
4. **重绘**：frame-diff，整秒对齐；只有 stamp 变化的行重画；活跃行 > 30 时时钟改分钟粒度，于是只有状态变化才重画。
5. **可视窗口**：只对视口内的行生成字符串，视口外保留投影；折叠规则保证活跃行优先在视口内。
6. **预算（v1.1 改写）**：全 tick 的门禁是契约 06「增量 tick 验收」（Pro 2026-11-02）：每个声明人群经验 nearest-rank **p99 < 50 ms、最大值 < 200 ms**，从增量 collect 入口到一致发布与本次数据组装 / 渲染 / paint enqueue 结束，含 I/O 等待、SQLite 等待与 COMMIT、B9 投影、B16 归并、字符串与 frame-diff；≥ 10 000 样本、≥ 3 次全新启动、每 1 000 样本滚动窗口内 ≥ 50 ms 不超过 10 个。B14 端到端测量；下面是 B10 在其中的**设计份额**，不是替代门禁：

   | 阶段 | 触发 | 份额（p99 / max） | 备注 |
   |---|---|---|---|
   | B9 `projectLinkTree` | 仅当 #13 的 memo 键变化 | ≤ 30 ms / ≤ 40 ms（200 节点 × 20 000 证据实测 p99 28.6、max 38.8） | 不变化的 tick 为 0 ms，复用上次结果 |
   | B16 即时归并（intent、戳不匹配节点，#15） | 节点 stamp 变化 | ≤ 5 ms 合计 | 其余节点读持久投影（`readProjection`），不重分类 |
   | 节点投影缓存 + 子树桶后序遍历 + 计数 + 警示 | 每 tick | ≤ 2 ms | ≤ 200 节点一次遍历 |
   | 行 / 卡片字符串 + frame-diff + paint enqueue | 只有变化的行 | compact 200 × 56 ≤ 10 ms；rich ≤ 15 ms（500 张卡片缓存） | 视口外不生成字符串 |
   | 渲染合计（B10 自己的部分，不含 B9） | 变化 tick | ≤ 15 ms p99、≤ 40 ms max | 剩余给采集 I/O 与 B12 发布 |
   | 无变化 tick（#16） | 只有时钟桶变 | ≤ 2 ms | 只重画时钟文字变了的行 |

   超出 50 ms 的 tick 记进 `health`（现有机制），超出 200 ms 的是缺陷（B14 记 performance-unqualified），都不降级画面——唯一的自动降级仍是活跃行 > 30 时的分钟粒度时钟。
   （B10C 增补，2026-11-02）发布观测的 bar / panel 把整个采集操作（含 B9、B16、租约与 SQLite 发布）放进各自一个有界 worker 线程，主线程只画最近一个完整的已提交视图；上表的 B9 份额改记在 worker 阶段，测量包含 IPC。全 tick 门禁拆成三道（契约 06「增量 tick 验收」B10C 增补）：paint p99 < 50 ms / max < 200 ms；观测操作 p99 < 100 ms / max < 1 000 ms；本地 commit 到 paint p99 < 50 ms / max < 200 ms。无变化 tick 的 ≤ 2 ms 按 p99 计，最大值另报。
（DOC2 裁决 2026-11-05）真正的启动 / cold catch-up 与 warm 增量 tick 分开记录；建立首个一致视图前显示 initializing / partial，并报告从启动到首次一致 paint 的时间。这里不新增数值门槛，已有契约 06 的 warm 门禁保持不变。

7. **文本**：外部文本过 `monitorText` 一次，按文本哈希缓存；截断结果随行缓存。
8. **动效**：唯一的 250 ms 定时器只在面板聚焦且选中卡有关系行时存在。
9. **statusline**：优先读 HUD 的机读状态文件（`$CODEX_HOME/hud/state/<session>.json` 的通用版，≤ 5 s 新鲜）；没有则做一次索引查询（父 ref → ≤ 50 个直接子节点，不建树）；两者都没有就省略第二行。p95 < 150 ms。
10. **子树有效桶与子孙计数**：每 tick 一次后序遍历（≤ 200 节点）求每个节点的子树最差桶和 `(1⚑ 2▸)` 计数，结果进节点投影缓存；排序仍只在桶变化时做。
11. **微卡与手风琴**：只有选中节点生成两行微卡；折起的卡片复用行字符串缓存；展开 / 折叠不触发整帧重绘，frame-diff 只画变化的行。
12. **树级花费与驻留时长**：对 ≤ 200 个 `spent` 求和是每 tick 一次加法（按完整 SessionRef 去重，带 known / missing 计数）；驻留时长由 06 持久发布的 `stateSince` 与 `nowMs` 相减，HUD 不自己记"首次见到"的时间（重启、两个面板、statusline 才会得到同一驻留时长），不需要定时器，也不为此写 ledger。
13. **（v1.1）B9 只在输入变化时调用**：`openLinkLedgerReader` 在启动时、tick 之外打开并保留（第一次打开实测 292 ms，绝不能落在增量 tick 里）；`reader.read()` 每 tick 至多一次，且只在 #1 的变更信号（`PRAGMA data_version` / bump 文件）变了才读；`projectLinkTree` 只在 memo 键变化时调用——键 = `(ledger.asOfSeq 与 ledgerId（degraded 时 reason）, 每个采集信封的 evidenceStamp + sourceGeneration + topology.coverage, 每个 host 核验的 (runId, bindingGeneration, checkedAt), roots, budget, 调用者保留的 selectionMap 的指纹)`；`nowMs` 不进键（B9 只用它核验 `checkedAt ≤ nowMs` 和给原生边一个默认 `since`，新的 host 核验本身就是键的变化）。结果原样复用；`linkStatusInput(tree, key)` 按 `(key, asOfSeq)` 缓存；`planLinkRead` 每 tick 一个 grant，续读与 B16 的 reader 共用同一个 deadline（契约 06「公平续读」），不是各自 20 ms 相加。
14. **（v1.1）渲染份额**见 #6 的表；B10 的基准脚本按同样的阶段分别计时并随全 tick 一起报，不相加各阶段的分位数。
15. **（v1.1）即时归并有界**：只有 intent 节点和观测戳与当前 run 不相容的节点才在 HUD 里调用纯 `mergeStatus`（就账本事实），每 tick ≤ 20 个、合计 ≤ 5 ms，结果按 `(nodeKey, runId, asOfSeq)` 缓存；其余节点读 B12 发布的投影，HUD 永不重分类、永不重发通知。
16. **（v1.1）无变化 tick**：账本高水位、采集信封、host 核验、视口与选中都没变时，tick 只推进时钟桶：≤ 2 ms，只重画时钟文字变了的行；1 s 节奏只在至少有一行 `▸` 的时钟还在秒级时保持，否则退到 5 s；容量、覆盖 chip 与 Slots 节都来自上一次投影的缓存，不在这种 tick 里重算。

## 7. 数据层必须提供的（对照契约 03 / 06 与 B16）

| # | 需要 | 对照 |
|---|---|---|
| 1 | **已满足（契约 06 `ObservationView.statusProjection`；契约 03 status）**：`activity / pendingReason / lastTurnOutcome / liveness / freshness {state, …}` 加 `stateKey / stateSince / stateSinceBasis / isRunTerminal / asOfSeq / observationStamp / asOf / observedAt / lastEvidenceAt / lastKnownActivity?`。`asOfSeq` 只是 ledger events 高水位（无 ledger 为 null，已打开的空库才是 0）；`observationStamp {seqDomain, commitSeq, inputLedgerSeq, ref, runId?, bindingGeneration?, sourceGeneration}` 是观测存储自己的戳（intent 无观测 commit 时为 null）；两套戳不跨域比较，没有跨存储原子承诺——HUD 把两者分开放在 `▾ More`，不把 ledger 高水位贴到旧摘要上，旧轮摘要只作历史 | 契约 06 ObservationView / ObservationCommit；契约 03；Oracle2 D12 |
| 2 | 冲突标志：`conflict: {count, recordIds[], since}`，归并器不猜状态 | 契约 03 conflict / candidates（v0.3 已满足）；B16 |
| 3 | `link`：`state`、`label`、`role`、`backend`、`parent_ref`、`child_ref`、`current_owner`、`bound_by`、`capabilities`（MVP 只有 `mcp`）、`brief_path`（basename 用）、`task_digest`、`predecessor`（同 owner 转交，MVP 就有）；`closed_at` 在 MVP 恒空（不产 closed），`observe_only` 绑定是 v1.1，`capabilities` 为当前 MCP 能力或 `none` | 契约 03 link / runHandshake（v0.3 已满足）；Oracle C03 / C04 |
| 4 | `runHandshake`（pending / claimed / bound + reason），与 `link.state` 分开 | 契约 03 |
| 5 | `currentRun`（只有 `managed` 非 null 的节点才有，见 #7）：`runId`、`run_seq`、`operation`（spawn / resume / handover，接受时固定，不由当前关系反推）、`mode`、`supervision_strategy`（MVP：headless / wrapper 甲）、`state`、`launch_phase`、`locator`（受管 `HostLocator`：pane / tab / label 加真实 runId / bindingGeneration）、`started_at`、`ended_at`、`cancel_requested_at`、`heartbeat {at, quality}`（ageMs 由 HUD 用 nowMs 派生）、`exit {code\|null, signal\|null, source, reason, coverage}`、`terminalNote`（`cancel_timing_unknown` \| `retire_timing_unknown` \| null，读所返回 run 的 `run.terminal` 事件 payload；不是 `reconciliation.cause`、不阻断、不新增列）、（v1.1）`termination`（同一 payload，#26）、`cancelControl?`（可见取消 `{intentAccepted: true, delivery: unavailable, reason: visible_scope_control_unavailable}`，只作印证；HUD 以 `mode = visible ∧ state = cancelling` 为准，因为 MVP 根本没有可见信号交付）、日志路径、`isCurrent`。`state = ended` 只凭已核验的进程组为空成立，不依赖退出码，取消已接受而先后未知时仍是 `ended` 并附说明，`cancelled` 要求取消先于结束已证明；`exit.code` 只表示有来源的原生结果，shell 结果另给 `shell_status` / `shell_signal`（诊断，HUD 只放 `▾ More`） | 契约 03 currentRun / exit / logs / terminalNote（已满足）；契约 02 R-02-2 / R-02-3 / runs.operation；契约 04；Oracle C07 / C09；Oracle3 E02 / E05 |
| 6 | `latestReportForRun {status, summary, path, created_at, report_id}` 与 `reportHistory`（按 run 分页，count 与最近一条） | 契约 03 latestReportForRun / reportHistory（v0.3 已满足） |
| 7 | **已满足（契约 05「会话观测绑定与受管绑定」「宿主、定位与 timeout」）**：普通会话（没有 ledger / MCP / run 也要能显示）通过 `SessionBinding {harness, occupantGeneration, sessionRef（完整 SessionRef，非 null，否则 bind 返回 null）, managed: RunBinding \| null}` 绑定；supervisor、childBinding、runId、bindingGeneration 只从 `managed` 读，`managed = null` 表示本次没有可确认相符的受管运行投影（不证明从未受管）——这种节点只有观测五维和宿主定位，没有运行字段（#4–#6、#9–#11），HUD 不为它画 `ended` / `reported`、不给 `↻`；ledger 若另有指向它的 link / run 而本次无法确认相符，只在 Inspector 以既有诊断 / 冲突投影解释（#2、#8），不凭同 cwd、同 pane 或裸 sessionId 补关联。宿主定位：普通会话用 `SurfaceLocator`（Herdr server / workspace / tab / pane 或 tmux server / session / pane、ProcessStamp、独立的 `occupantGeneration: number \| null`，不含 runId / bindingGeneration），受管 run 用 `HostLocator` / `RunHandle`（真实 runId / bindingGeneration）；两种 locator 都只是待核验快照，`LocatorCheck` 给 `valid / stale / unknown`、`host.occupantMatches`（true / false / null）、`foregroundInteractive` 与核验时刻，null == null 不算匹配，不匹配或未知时不给宿主字段、不开放控制；（v1.1）B10 实际消费的是 B9 `LinkHostProjection {locator, state, occupantMatches, checkedAt, currentState}`（`projectLinkHost`：locator 必须带本 run 的 runId / bindingGeneration，恰好一次核验才算，矛盾或重复的探针一律 unknown），`currentState ≠ null` 是 Open 可用的条件之一（§3.7）；`LocatorCheck.foregroundInteractive` 没有透传，HUD 不需要它 | 契约 05 SessionBinding / SurfaceLocator / I-05-4；契约 03 host / parent（v0.3 已满足）；Oracle3 E06；B9 `host.ts` |
| 8 | `candidates[]`（证据种类、时间），只供 Inspector | 概念 §6.5 |
| 9 | 父离线：`parentOffline {since, seq, orphanPolicy}` 或 null，由 parent.offline 事件投影 | 契约 03 interaction / parentOffline（v0.3 已满足）；契约 04 orphan |
| 10 | uncertain 的 `reconciliation {cause, evidenceIds[], missing[], observedAt, 允许入口}`，允许入口是类型化 `ActionDescriptor`（`displayCommand` 由受信模板安全生成；report / label / 日志不是命令来源）。（v1.1）**契约满足、HUD 进程未满足**：B9 节点上没有它。要么 B9 把本轮最新 `run.state / run.reconciliation` 事件的 `{cause, evidenceIds, missing}` 附到 `LinkTreeNode.execution`，要么 core 导出与 `readDelegationIn` 同规则的纯函数 `reconciliationOf(events, runId)`；B10 不自己解析 payload。读路径的 `allowedActions` 为空，Reconcile 的 `displayCommand` 需要 core 的受信模板函数（#32） | 契约 03 reconciliation / ActionDescriptor（已满足）；契约 02 R-02；Oracle2 D04；`src/ledger/delegation-read.ts` |
| 11 | 统一门禁投影 `resumable: boolean` + `reason` + `subject`（mcp 当前父 owner 或 local_user）与 `allowedActions`，HUD 只投影 `local_user` 入口的可行性、不复制门禁；`closed` 为 false / deferred（重开是 v1.1）；本地 resume 入口未实现时 HUD 只给诊断；（v1.1）生产本地 resume 入口在 B14 发布能力约定前恒 `capability_unverified`（B11 Oracle），所以 MVP 的 `↻ Resume` 只写诊断、不复制；`resumable.reason` 来自 `resumeGate`，HUD 显示 reason、不显示 subject | 契约 03 status / ActionDescriptor；契约 01 本地管理授权；契约 04 写者入口；Oracle2 D04 / D05；B11 oracle-1 |
| 12 | Jev（阶段 C，不阻塞 cc→Codex）：`jobs.state`、`provider`、`account` 显示名、`external_key` 短形、`result_path`（answered 后）、租约 `{kind: 'browser', held, queued, holderLabel?}`——`holderLabel` 由 C4 的 lease owner / job 读取投影派生，不是账本字段、不参与互斥或释放，无可公开显示名则省略（行上只写 `browser queue`）、Flow credits（另一单位） | C4 定稿的浏览器租约契约（当前契约 02 只规定释放原则）；C5；Oracle2 D10 |
| 13 | **已满足（契约 06「Metric 与时间」）**：`spent = {tokens: Metric<TokenUsage>, costUsd: Metric<number>}`，`costUsd` 必有，无口径时 `{value: null, quality: unknown, source, asOf}`，有效零保留 `0 / reported`，不按 tokens 换算美元；树级合计按完整 SessionRef 去重，带 `knownCount / missingCount / coverage / quality`——只有同口径非负 reported 部分和才是下界（HUD 写 `≥`），混入 estimated 写 `~`，不声称下界 | 契约 06 Metric；概念 §6.4；Oracle2 D09 |
| 14 | **已满足（B9，v1.1）**：节点 `loaded`、`coverage {state, skipped, gaps, reason}`（未加载的 reason ∈ `nodes \| depth \| bytes \| unloaded \| native_topology`）、`continuation[] {key, identity, reason}`（≤ 200，`truncation.continuation` 是没列出的数）、`counts {knownUnloaded, omitted, unknownDescendants}`、`truncation {candidates, conflictRecords, continuation}`、树级 `coverage` 与 `io {bytesRead, recordsRead, remainingBytes, exceeded}`；`ledger {state: available \| degraded, ledgerId, asOfSeq, reason}`，degraded 的 reason 是 `ledger_busy` / `ledger_unavailable` / `ledger_runtime_unavailable` / `ledger_unsupported_schema` / `ledger_invalid_ledger` / `ledger_closed` 等（`link-ledger-read.ts`）。HUD 把 `ledger_busy` 当暂时（chip muted、沿用上一棵树），其它 reason 连续 30 s 后 chip 变 warning，Inspector 原样写 reason；从未有过快照时没有委派行可沿用，只有 chip | B9 `LinkTreeProjection`；概念 §6.5 |
| 15 | 通知事件带 `seq` 与 `created_at`：报告到达、进入 uncertain、冲突 / 解决、父离线（账本事件，ledger seq 域）；`pendingReason` 变化与 `lastTurnOutcome=failed` 的观测通知带 `seqDomain` 内的 seq（观测域），两域的 seq 不互相比较，首次建立基线不补发假的完成通知 | 契约 03 tree / notices；契约 06 NoticeEvent（已满足）；Oracle2 D12 |
| 16 | 变更信号：`PRAGMA data_version` 可用，或一个 bump 文件，HUD 不按秒查表 | 契约 06（预算） |
| 17 | statusline 的廉价入口：机读状态文件的通用版（含树计数与直接子节点的标记级字段），或 ≤ 20 ms 的索引查询 | D3；契约 06 |
| 18 | **已满足（契约 03 tree / notices；契约 06 DisplayNodeIdentity / B16）**：节点身份 `{kind: session, ref} \| {kind: delegationIntent, linkId} \| {kind: job, ref}`（job 留 C），未绑定意图用稳定 linkId 显示键并挂 currentRun；≤ 200 节点、无环 / 无重复 ref、depth 明确、`handed_over` 只作历史、超预算 `loaded=false`；`freshness.state ∈ fresh \| stale \| unknown`；`run.state = failed` 投影为 `launch_failed`（non_execution，带采用的原因）；终态只用共享 `isRunTerminal`（ended / failed / cancelled，含附 `terminalNote` 的 ended；`managed = null` 的普通会话为 null），报告 / 图标 / `cancelling` 不算终态、不折历史；（v1.1，B9 已满足）`selectionMap` 由调用者保留并每 tick 回传，B9 压平链式映射；冲突关系不产生边、冲突子只在 `relations[]`（§3.6）；`parentRef` 未解析的 intent 成为额外顶层根（§3.1）；`candidates` ≤ 200 并带 `truncation.candidates`；`counts.confirmedSessions / delegationIntents / jobs` 是 A9 定的三个计数名 | 契约 03；契约 06；Oracle2 D11；B9 `index.ts` |
| 19 | 时间一律毫秒 epoch，年龄由 HUD 用 `nowMs` 计算；`asOf`（采纳的事实边界）与 `observedAt`（观察时间）分开；ledger 的 `asOfSeq` 与观测的 `observationStamp` 分域，没有跨存储原子性或协调器 | 契约 03 / 06（已满足）；Oracle2 D12 |
| 20 | 被委派方视角：父的 harness、名、liveness、经验证的 pane label 或 null，未确认时 caller 短形只作诊断 | 契约 03 host / parent（v0.3 已满足）；契约 01 CallerId |
| 21 | **契约已满足，读路径未满足（v1.1）**：`reconciliation.cause` 枚举（至少区分 `supervisor_dead`、`scope_unknown`、`resume_ref_mismatch`、`clock_anomaly`，可再细分 `supervisor_stale` 等）和显式的 `interaction {focus, input, resume}`（未知为 false；uncertain / 未决冲突、尤其 `supervisor_dead` 三项均 false，resume 还须 `resumable=true`）；HUD 据此灰掉 Open、只留 Reconcile，不自行从心跳推断；（v1.1）`interaction` 在 `readDelegationIn` 里恒为 `{focus: false, input: false, resume: false}`（能力核验不在读路径产生），HUD 因此改读 B9 `host` 投影判 Open（§3.7）；将来读路径给出真值时，`interaction.focus = false` 优先于 host 规则灰掉 Open，HUD 不需要改词 | 契约 03 reconciliation / interaction；Oracle §4；`src/ledger/delegation-read.ts` |
| 22 | **已满足（契约 03 v0.3）**：`parentOffline` 与 `reconciliation.cause` 是独立字段；父 MCP 离线 continue 本身不禁用仍经核验可用的子交互，只有 `supervisor_dead` 这类 cause 才让 `interaction` 三项为 false；（v1.1）B9 把 `parentOffline` 放在 `relations[].parentOffline`（本轮最新 `parent.offline` 事件），节点上没有——B10 从该节点的当前关系取 | 契约 03 interaction / parentOffline；Oracle §4；B9 |
| 23 | **已满足（契约 06「B16 的五维输入与消费者字段」/ ObservationCommit）**：`stateKey: string`、`stateSince: number \| null`、`stateSinceBasis: event \| observed \| unknown`，随 `ObservationCommit` 持久发布，`StateContinuity` 是按 `nodeIdentity` 判别的联合——公共字段 `{ruleVersion, episodeAnchor, stateKey, stateSince, stateSinceBasis, bindingGeneration?}`，session 分支 `{nodeIdentity: {kind: session, ref}, sourceGeneration（真实 reader 代次，必填）, runId?}`，delegationIntent 分支 `{nodeIdentity: {kind: delegationIntent, linkId}, runId（必填，对应本快照 currentRun）}` 且**没有** ref / sourceGeneration（不填 0、null，也不借 bindingGeneration）——保证重启后连续；intent 首次绑定为 session 时只有 link → 真实 ref、同一 run、同一 episode 的证据齐备才沿用原 ledger 进入时间，否则按 observed / unknown 起新区间（时钟相应显示 `~` 或留空），绑定后的 session 记录带自己的真实 `sourceGeneration`；`stateKey` 是语义状态加原因（approval / question / supervisor_dead / launch_failed…），不含图标、颜色或排序桶；新 run、新 episode 或语义变化才重置，报告重读 / 心跳 / usage / 折叠 / 语言 / 父换桶不重置。HUD 用它算驻留、3 秒加粗、trouble 桶内倒序；证据年龄另取 `lastEvidenceAt` / heartbeat；`clockAnomaly` 显式，不靠刷新时间掩盖；basis unknown 时时钟留空 | 契约 06 B16 / StateContinuity 联合 / ObservationCommit；契约 03 status；Oracle2 D01；Oracle3 E01 |
| 24 | **已满足（契约 06「WorkspaceContext 与项目归属」）**：`cwd`、`worktreeRoot`、`worktree?`、`gitCommonDir`、`repoId`（`identityKind = git-common-dir-v1`，`scope = local`，本机分组键而非永久项目 UUID）、`projectOrigin {repoId, basis: declared, declaredAt}`、`cwdSource / cwdAsOf / gitCapturedAt / gitMissingReason`；与逐 run 冻结的 `runs.launch_cwd / workspace_snapshot / project_origin`（契约 02 启动上下文）分开。HUD 以规范化 `worktreeRoot` 判等，根未知时只比较规范 cwd、只说目录不同，未知不当相同、同名不当同目录；`projectOrigin` 只显示为声明，不当物理同仓库；Git 解析不进 paint / statusline 热路径 | 契约 06 WorkspaceContext；契约 02 launch context；Oracle2 D02 / D03 |
| 25 | **（v1.1，需新增）容量投影**：core 导出纯函数 `capacityProjection(snapshot.runs, snapshot.links, rootRef, limits)` → `{active, limit, mine, mineLimit, full, occupants[{runId, linkId, state, since, holder: self \| other, ownerKey?}]}`，与 B21 `readCapacity` 同规则但只读快照、不需要事务：计数 `state ∈ {starting, running, cancelling, uncertain}`，`self` = 该 run 的 link `parentRef` 等于视角根的 SessionRef，`parentRef = null` 记 `other`（HUD 不派生 proc owner，不读 `caller_contexts`）；`limits` 用 `delegate.json` v1 的 `limits {maxActiveRuns, maxActiveRunsPerOwner}`，加载器从 `packages/hud-mcp/src/config.ts` 下沉到 core 共用（或 core 提供只读等价物），缺文件 / 缺字段用默认 6 / 4 并标 `limits: default`。`retryAdvisable` 不投影给 HUD（那是给调用者的）；`retireEta` 恒 null，不画 | 契约 02 A3；NOTIFY §4.9；B21 `intents.ts readCapacity` |
| 26 | **（v1.1，需新增）终态证据到节点**：B9 在 `LinkTreeNode.execution` 上附 `terminal: {note: TerminalNote, termination: Termination \| null} \| null`，取本轮 `run.terminal` 事件的 payload，经 `src/ledger/run-facts.ts` 的 `terminalNote()` / `terminationProjection()`（这两个纯函数应从 `src/ledger` 导出到 core，HUD 不 import 写者包）；旧写者的事件没有 `termination` → null，三行不画；未知 note → null | NOTIFY A2 / §4.4；B21 `delegation-read.ts`；契约 03 terminalNote |
| 27 | **（v1.1，需新增，B19）唤醒状态**：纯函数 `wakeProjection(events, linkId)` → `registered \| degraded \| unconfirmed \| none` + `{adapter, attempts}`，就该 link 的 `wake.registered / wake.revoked / wake.delivered` 事件计算（与 hud-mcp `delegate_status` 的 `wake.state` 同一函数）；B19 未合入时 HUD 不画这一行。`advice`（B20 缓存建议）HUD 不显示 | 契约 03 NOTIFY A7；B19 amendments；B-integration-notes「Merge B19 × B20」 |
| 28 | **（v1.1，已满足）可见取消事实**：`currentRun.mode = visible ∧ currentRun.state = cancelling` 就是"意图已接受、不可交付、仍在运行"；`cancelControl` 存在时只作印证；`cancel_requested_at` 给驻留的事件时间（B16 `stateSince`，basis `event`） | 契约 03 H06 + Pro 2026-11-02；契约 04「可见模式 MVP 能力」；`src/core/run/control.ts` |
| 29 | **（v1.1，已满足）冲突记录**：节点与关系的 `conflict {count, recordIds[] ≤ 200, since}`，`recordIds` 是 `link:<linkId>` / `native:<parent>:<child>` / evidence id；`truncation.conflictRecords` 是没列出的数；冲突关系的 `currentRun` 仍在 `relations[]` 上（节点上为 null），Inspector 的 Conflict 节与 `↻ Reconcile` 用它 | B9 `conflicts.ts`；契约 03 conflict / candidates |
| 30 | **（v1.1，已满足）intent 的即时归并输入**：`linkStatusInput(tree, key)` 给 `{asOfSeq, link, conflict}`，B10 补 `target {nodeIdentity: {kind: delegationIntent, linkId}, runId}`、`ledgerFacts [{run: {runId, state, reason}}]`、`history.continuity` 后调用纯 `mergeStatus`；无 sourceGeneration、无 ref（Oracle3 E01）；结果不发布、不发通知 | B9 `linkStatusInput`；B16 `MergeInput`；契约 06 StateContinuity |
| 31 | **（v1.1，已满足）读路径的 `delegate.json` 与 B9 reader 的打开**：`openLinkLedgerReader(path, scope?)` 只在启动时打开，HUD 读整个账本（不传 `linkIds` scope），否则容量计数会少算；`read()` 每 tick 至多一次 | B9 report；§6 #13 |
| 32 | **（v1.1，需新增）Reconcile 的受信模板**：core 导出 `reconcileDescriptor(hudHome, linkId, runId): ActionDescriptor`（`operation: reconcile`、`displayCommand` 带安全引用的 HUD_HOME），与 B11 `hud run reconcile` 的实际 argv 一致；在它存在之前 `↻ Reconcile` 与 `↻ Resume` 一样只写诊断，Inspector 的 `reconcile:` 行写 `hud run reconcile <runId>`（缩写，标 `not copyable yet`） | 契约 03 ActionDescriptor；契约 04 F05；B11 |
| 33 | **（v1.2，需新增）原生子代理的名与类**：B9 `LinkTreeNode` 上附 `native: {title: string \| null, kind: AgentTaskKind \| null} \| null`（仅 `edge = native` 非 null）：`title` = Codex 的 `agentDisplayName`（agentPath 叶 → nickname → role → kind）/ cc 的 `description`；`kind` = 现有 `AgentTaskKind`（`research \| experiment \| fix \| review \| writing \| summary \| other`），cc 的 `agentType` 由采集器映射到同一枚举、未知为 `other`；由 B9 从观测的原生列表填入（采集器已算出 `AgentIdentity`，不新增 I/O），或 `ObservationView.native` 透传、B9 原样复制。没有它时原生行只剩会话短形（`codex:51aa`），不可用。B10 行名 = `native.title`，缺席退到会话短形；图标位 = `KIND_GLYPHS[kind]`（`other` 留空）；`◈N` chip = `kind = review` 的原生数 | `src/collectors/subagent-tree.ts` `AgentIdentity`；`src/render/agent-title.ts` `KIND_GLYPHS`；§3.4 图标位；§4.5 cc 原生子行；（编排 2026-11-02：本期 Claude 原生拓扑不可用，cc 的 title/kind 随 Claude 原生拓扑延后，见集成记录 B10C） |

## 8. 开放问题与假设

| # | 问题 / 假设 | 会改变什么 |
|---|---|---|
| 1 | 可见运行的原生退出结果通常为 null（方案甲，已裁决）。若受支持档案的 exec 直连路径在某些启动形态下提供有来源的原生结果 | 只影响 §3.3 第 4 条能否据它判 `!`；`✓` 永远只来自报告，`■ ended` 的判法不变 |
| 2 | **已关闭（Oracle2 D04 / D05）**：MVP 的 Resume / Reconcile 只显示并复制 `ActionDescriptor.displayCommand`（含 HUD_HOME、`--request-key`、`--expected-run`、`--mode`），不起控制进程；本地 resume 入口未验证时只给诊断 | 直接调用若将来加入，是另一项可选能力：显式按键、固定目标确认、可信 argv、写者重验；不改本稿的按钮与键位 |
| 3 | **已关闭（v1.1）**：B16 `classify` 的第一条就是 `conflict.count > 0 → conflict:contradictory_evidence`，B9 给 `{count, recordIds, since}`；冲突是独立标志，不是 unknown | `⚠` 保留；行词改 `conflict`，Inspector 加 `── Conflict ──`（§3.3、§4.8） |
| 4 | 手风琴的触发阈值（视口溢出 / 兄弟 > 5）与是否可关 | 用户反馈决定；设置项 `accordion` |
| 5 | 后端计数是否需要更显眼（概念的 `delegated` 模块） | 若需要，恢复为独立模块，优先级 72，放在 `agents` 之后 |
| 6 | harness 是否需要颜色 | 加 `harnessColors` 设置，默认关 |
| 7 | statusline 多行是否被 Claude Code 稳定支持 | 否则只有第一行，委派退成计数 `⧉ 2▸ 1⚑` |
| 8 | Ambiguous 宽度字符在用户终端的实际表现 | 若常见，harness 标记改用 Neutral 宽度的替代（Claude `✦`、Jev `◉`） |
| 9 | Jev credits 的单位与是否公开显示 | 影响 `12cr` 的写法 |
| 10 | **已关闭（v1.1）**：保留 `Reports: none yet`。"不画占位"禁止的是编造状态；一个活着的运行还没有报告，正是用户打开 Inspector 想确认的事实，这一行不编造任何东西。唤醒行则相反（`none` 不画），因为 B19 的 `none` 分不清"没登记"和"父不支持"（#21） | 无改动 |
| 11 | 深度 > 4 的 `↳` 平铺是否足够 | 若常见深树，加"子树聚焦"（把选中节点设为视角根） |
| 12 | 机读状态文件的通用版格式由谁定（D3 还是 B10） | 影响 §6.9 的实现顺序 |
| 13 | **已关闭（v1.1）**：`■ ended`（无报告）与 `✓` 同一条规则——warning 60 s 后 muted，并进 60 s 通知 `■ bench ended · no report`；超时限 / 空闲 / 阻塞 / 父断连退役的无报告结束在行上带原因词。理由：NOTIFY 之后，无报告的结束多半是 4 小时上限把没交差的任务杀了，用户要在它还新鲜时看到；60 s 后它是历史，和失败一样不再亮 | §3.3 第 9a 条、§4.1、§5.2 |
| 14 | **已关闭（v1.1）**：不给 `supervisor lost` 独立标记。它与 stale 的区别已由颜色（warning vs muted）、行词、通知整句和控制条（只剩 `↻ Reconcile`）承担，再加一个 `?` 的变体就是第三个要学的"不知道"符号；可见取消复用 `⚑`，v1.1 也没有新增 glyph | 若用户测试仍混淆，先改词（`supervisor lost` → `supervisor died`），再考虑 glyph |
| 15 | 【探索性，Argon】用 CSI 绝对列定位（`ESC [ <col> G`）锚定名字列和右侧簇起点，彻底免疫字体把某个符号画成 2 格 | 需要 frame-diff 与 `truncateAnsi` 认识定位序列；FE 评估成本可接受就做，否则维持按格计算 |
| 16 | 【探索性，Argon】两个子节点同一工作树时给一个 muted 提示（`×2 same worktree`），防止互相覆盖 | 按规范化 `worktreeRoot` 判等，未知不报；不是契约冲突，不用 `⚠` |
| 17 | 【探索性，Argon】一键重置展开状态并回到视角根 | 可能复用 `⌂` 或新键 |
| 18 | （v1.1）B3b-C 恢复可见自动退役后，`close pane` 提示应何时消失：按冻结政策的 after-report 宽限（HUD 读不到政策），还是等 `retire.requested` 事件出现 | 取后者则提示保留到 `retire.requested`，之后行变可见版本的 `■ cancelling`；§3.3 第 5a 条随可见取消可交付而退役 |
| 19 | （v1.1）`⚑ slots 6/6` 常驻警示在长会话里是否扰人（用户不打算再委派时也亮） | 若扰人，改成只在最近 60 s 内有意图被拒时亮——这需要契约 02 给 `concurrency_limit` 一条审计事件（目前不进账本）；或退到只有汇总行 chip |
| 20 | （v1.1）纯原生拓扑冲突（两个会话的 `topology.children` 都列同一个子，账本没有关系）在 B9 输出里没有可渲染的记录，只有 `unknownDescendants` | 若实际出现，请 B9 把它也放进 `relations[]`（`attribution = conflict`、无 link）或单独列出；HUD 现在只能在 Coverage 节写 `children unknown` |
| 21 | （v1.1）`wake.state = none` 的两种含义（没登记 / 父 harness 不支持）是否要分开显示 | B19 若区分 `unsupported`，Inspector 画 `wake unsupported · codex`（muted）；`none` 仍不画 |

## 9. 外部意见处理（Gemini Argon，2026-11-01）

意见原文：`tmp/tasks/FED-argon/opinion.md`，评的是 Oracle 对齐之前的快照。Oracle / 契约语义优先于呈现建议；需要数据层配合的点进了 §7。逐条裁决如下（【坚定建议】按原文编号顺序）。

| # | Argon 的建议 | 裁决 | 一句话理由 / 落点 |
|---|---|---|---|
| 1 | 已结案异常退出第一告警桶，不再霸占 bar 的 attention | 改编 | MVP 没有 `closed`；改为终态 `! ■` 与 `✓` 同规则 3 分钟后收进 `⊕N`、bar 不再为它们亮；`⚑ ? ⚠` 是待办，留在前面，桶内最新在上、bar 全形取最新（§3.2） |
| 2 | 折叠子树冒泡子孙计数 `+3 (1⚑ 2▸)` | 采纳 | §2、§3.4；< 40 列 `+3⚑` |
| 3 | compact 选中行升级为两行微卡 | 采纳 | §3.4；无委派行的节点仍一行 |
| 4 | 右端时钟按状态定义：驻留时长 / 证据年龄 / 结束年龄 | 采纳 | §1、§3.4；需要 `stateSince`（§7 #23） |
| 5 | `⚑` 独立颜色、`■` 60 s 后 muted | 采纳 | `⚑` 用 danger 色加粗，与 `!` 以字重和符号区分（§5.2） |
| 6 | Ambiguous 宽度：禁 VS16、窄字符默认集或 CSI 列定位 | 改编 | 禁 VS16 采纳；核实宽度表后发现面板本就靠 ambiguous=1 格（box drawing、`·` 都是 A 类），不换默认集；CSI 定位列入 §8 #15 探索项 |
| 7 | selectedBand 与状态色的对比度 | 采纳 | §5.2 选中行规则 |
| 8 | 区分交差 `✓` 与存活空闲，`exit 0` 也算交差 | 改编 | 委派节点空闲无报告用 `· idle`（§3.3 第 10 条）；`exit 0` 不采纳——Oracle：可见运行的原生退出结果通常未知，`✓` 只来自报告 |
| 9 | ASCII 表 `⚑→!` 与 `!→x` 撞车 | 采纳 | `⚑→@`，`!→!`（§5.3） |
| 10 | 子树最差状态冒泡排序，`⊕N` 不吞活子树 | 采纳 | §3.2；每 tick 一次后序遍历（§6 #10） |
| 11 | `⚑` 行无条件丢徽章写原因（修正 §4.5 / §4.7 自相矛盾） | 采纳 | §3.4、§4.5、§4.7 的示例已改 |
| 12 | 兄弟 > 8 的 rich→compact 悬崖改为手风琴 | 采纳 | 折起的卡片 = compact 行；`⚑ ? ⚠ !` 与选中卡不折（§3.5、§4.7） |
| 13 | 只读与副作用动作分离、固定键位、`✓ Copied` 回显 | 采纳 | `⇢` 与 `↻` 两个按钮；`o`/Enter、`L`、`R`（§3.7、§4.9） |
| 14 | statusline 砍第三行，第一行常驻计数，第二行异常聚焦 + `+N` | 采纳 | §4.12 |
| 15 | uncertain 的焦点行写缺失项与 `[R] reconcile` 提示 | 改编 | 缺失项进微卡 / 卡片（`? uncertain: scope unknown · no receipt`）；动作词只在控制条，现有规则不在正文写快捷键字母 |
| 16 | Jev `browser queue` 写明占用者 | 采纳（阶段 C） | §3.3 第 8 条；§7 #12 `holderLabel` |
| 17 | 完成行尾部显示报告摘要而非 `· closed` | 采纳 | §3.4、§4.5、§4.10；无摘要 `reported`，无报告 `ended` |
| 18 | 单键跳到下一个 / 上一个 trouble 节点 | 采纳 | `n` / `N`（§2） |
| 19 | 树级累计花费 | 采纳 | 汇总行 `· $3.40`，部分后端无成本口径写 `≥`（§1、§4.2；§7 #13） |
| 20 | 委派行显示与父不同的 worktree / 目录 | 采纳 | `in fix-cjk`（§1、§3.4、§4.7；§7 #24） |
| 21 | 不给 harness 上色 | 保持 | 与 §5.2 一致 |

【探索性想法】：trouble 桶内最新在上与 bar 取最新——采纳（§3.2）；换桶后 3 秒加粗——采纳（§3.2、§5.2）；子树临时视角根——已在 §8 #11；同目录碰撞提示、一键重置——§8 #16、#17。

## 10. 设计立场

一句话：**行上只放一个标记和一个名字，其余按需要逐层展开，而且永远不猜。** 跨 harness 之后，用户最需要的是一眼看出"谁替谁在干活、谁在等我、谁的记录不对"，所以状态标记和颜色只服务这三件事，harness 身份退到一个 muted 的小图标，模型、上下文、时钟留在右侧簇按固定顺序让位。所有的细节——角色、宿主、握手、心跳、退出回执、报告、候选、覆盖——都在焦点行和 Inspector 里，而且用契约里的词原样写出，不翻译成乐观的结论。这样 HUD 既保持 codex-hud 今天的干净，又在复杂情境下给够信息，还能在 200 节点、50 ms 的预算内站稳。
