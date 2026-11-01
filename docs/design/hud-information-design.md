# 通用 HUD 信息与视觉设计（v1.0，2026-11-01）

本稿是 FED1 的决定文档：HUD 在每种情境下显示什么、显示多少、怎样组织、用什么样子。它约束 B10（委派渲染）、D3（statusline 外观）、C5（Jev 行）和 B16 归并器要交付的投影字段。概念文档 §10 的 UX 笔记被本稿取代，差异列在 §0.2；外部设计意见（Gemini Argon）的逐条处理在 §9。所有示例数据都是合成的。

读者先读概念 §2（G13、G14）、§6.5、§6.8，契约 03 的"HUD 可读投影"一段，以及 `docs/reference.md` 里今天的面板。

## 0. 立场与范围

### 0.1 四条设计原则

1. **一行一个标记，一眼读出"谁、替谁、在干什么、卡在哪"。** 五个状态维度在行上只投影成一个标记加一个颜色；细节在焦点行和 Inspector。
2. **不猜。** HUD 只画已提交的关系、运行、报告与 B16 投影。没有证据的位置留空，不画占位；候选关系只在 Inspector 里叫"疑似"，不画成树边；UI 上的 done 不等于运行结束。
3. **先丢字段，再截文字；先折叠，再滚动。** 宽度不够时按固定的丢弃顺序丢整块；数量多时按桶折叠；用户用现有键展开。
4. **延续 codex-hud 的词汇。** 状态标记、徽章、计量线、卡片骨架、控制条、调色板角色都沿用；只加 harness 标记、模式标记、`⚑`/`⚠` 两个新状态标记和四个 Inspector 小节。改动现有基线的地方逐条说明理由（§0.2、§5.1）。

### 0.2 对概念 §10 的取舍

| 概念 §10 | 本稿决定 | 理由 |
|---|---|---|
| bar 新模块 `delegated`，按后端计数 `⧉ ✳2 ⌬1 π1 ◎1` | 不加模块。`agents` 模块按状态计数所有树节点（不分 harness）；仅在 full 密度且宽度 ≥ 160 时附带后端计数 `· ⌬2 π1 ◎1` | 用户先关心"几个在干活、几个要我"，不是后端分布；bar 一行寸土寸金，新模块会挤掉 context/notice |
| headless 行动作"日志"、结束行"打开"写在行上 | 行上不写动作词。动作只在控制条的 `⇢` 按钮（词随选中行变：Switch / Open / Log / Resume / Reconcile）和 Inspector 头部 | 现有规则：面板的每个控件都在控制条上，卡片不画控件 |
| 冲突行"⚠ 两条记录" | 保留，作为 8 个状态标记之一 | 记录不一致与"HUD 不知道"（`?`）是不同的求助 |
| 卡片显示 run 序号与退出码 | 只在 `run_seq > 1` 时显示 `run N`；只在有来源且非零 / 信号的原生退出结果时显示 `exit N` / `signal TERM`（可见运行通常没有，见 §3.3） | 第一轮的 `run 1`、正常的 `exit 0` 是噪音；shell status 不是退出码 |
| Inspector 新节"链接 / 运行 / 疑似 / 覆盖" | 保留，另加"报告"节；顺序：事实 → 链接 → 运行 → 报告 → 疑似 → 覆盖 → 原有长文本节 → More | 委派节点打开 Inspector 多半是为了看关系和运行 |
| 顶部"父：…"行 | 保留；只在视角根有 `links.asChild` 时出现，一行，格式见 §4.6 | |
| 汇总行计数写法 `✓1 ▸1` | 改成 bar 的写法 `1▸ 1✓`（数字在前） | 同一产品两种写法；bar 更显眼，以它为准。基线需更新 |

### 0.3 假设（详见 §9）

A1 B16 对每个节点给出完整五维投影和 `asOfSeq`；A2 归并器把"两条记录"作为独立标志而不是猜一个状态；A3 可见运行用修订后的方案甲（Oracle 裁决 `docs/reviews/2026-11-01-astra-contracts.md` §4）：运行结束可由已核验的进程组为空证实，但 harness 的原生退出结果通常未知（null），shell status 只是独立诊断，永不当退出码；方案乙不是 MVP 受管后端，不在假设里；A4 已裁决（Oracle2 D04）：MVP 的 Resume / Reconcile 只显示并复制契约 03 `ActionDescriptor.displayCommand`，不起控制进程，直接调用是将来的可选能力；A5 面板宽度 32–56（Codex ≥ 41），bar 80–200，statusline 80–200；A6 现有键位 `h`/`l`/`a`/`f`/`s`/`r`/`v` 可复用；A7 MVP 范围按 Oracle 裁决与契约 v0.3：同 owner 的 `predecessor` 转交留在 MVP；跨 owner 转交凭证、`closed` 链接重开、no-MCP `observe_only` 绑定、shared-daemon context 推到 v1.1，Jev 作业在阶段 C——本稿保留这些设计并就地标注，B10 不实现 v1.1 的部分。

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
| 状态词（trouble 行） | 投影 + run/job 状态 | T0（仅 `⚑ ! ■ ? ⚠ ·` 行） | 名字后 ` · uncertain` 等；trouble 行为腾空间丢徽章和计量线 |
| 树位置（父子） | `links`（唯一当前父边） | T0 | 缩进 + 竖线；未证实边用 `┊` |
| model · effort | `evidence.model` | T1 | 徽章，`fitModelEffortToken` 四形 |
| context % | `evidence.context` | T1（≥ 40 列）/ T3 精确数 | 行上 4 格细线；卡片脚线上百分比 |
| 右端时钟（含义随状态，§3.4） | transcript / heartbeat / 06 `stateSince` + `stateSinceBasis` | T1 | 右端 7 格：`▸` 轮时钟；`⚑ ! ⚠` 卡在该状态的驻留时长（basis `event` → `10s`，`observed` → `~10s`，`unknown` / null → 留空，不编年龄）；`?` `lastEvidenceAt` / 心跳年龄；`✓ ■ ·` 结束 / 进入该状态的年龄 |
| 模式 visible / headless | `runs.mode` | T1 | 名字后缀 `⊟`（仅 headless）；比截断名字先丢 |
| Jev provider（阶段 C） | `jobs.provider` | T1 | 占徽章位：`chatgpt / gemini / aistudio / flow` |
| 角色 role | `links` 意图 | T2 / T3 | 卡片第一行 `implementer · pane 4 · bound 12m` |
| 宿主 pane / tab | `host.label`，`occupantMatches` | T2 / T3 | `pane 4`；occupant 不匹配时不写 pane（不猜） |
| run 序号 | `runs.run_seq` | T2（> 1 时）/ T3 | `run 2` |
| 花费（pi 的 cost，Flow 的 credits） | `evidence.spent.costUsd`，jobs | T2 / T3 | `$0.12`、`12cr` |
| 树级累计花费 | 06 树级合计：`spent.costUsd` 按完整 SessionRef 去重求和，带 `knownCount / missingCount / coverage / quality` | T1（汇总行）/ T3（根 Inspector 写 `3 of 5 nodes`） | 全部已知且 reported → `$3.40`；有缺失且已知部分全是 reported → `≥$0.12`（同口径下界）；混入 estimated → `~$0.12`（不是下界）；credits 另算，不换美元 |
| 工作目录 / 工作树 | 06 `WorkspaceContext {cwd, worktreeRoot, worktree?, repoId, projectOrigin, cwdSource, cwdAsOf, gitCapturedAt, gitMissingReason}` | T2（与父的 `worktreeRoot` 不同时）/ T3 | 委派行 `in fix-cjk`（`worktree` 显示名，否则 `worktreeRoot` 的 basename）；判等只看规范化 `worktreeRoot`，根未知时退到比较规范 cwd（只说目录不同），cwd 也未知写 `in ?`——未知不等于相同；`projectOrigin` 只是声明，Inspector 标 `declared` |
| 最近报告 | `latestReportForRun` | T2 一行 / T3 全部 | `✓ Docs synced; …`（摘要经 `monitorText`） |
| 待决原因文本 | transcript / Jev | T2 / T3 | `⚑ approval: run npm run test:visual?` |
| 运行结束 / 退出 | `runs.state = ended`（已核验进程组为空）；`exit.json` 的 `exit_code` / `signal` 可为 null（可见运行通常未知）、`reason`、`coverage`；shell status 是独立诊断 | 结束 T0（标记）；退出结果 T2（仅已知且非零 / 信号时）/ T3；shell status 仅 `▾ More` | `exit 1`、`signal TERM` 只在有来源时出现；未知时焦点行写 `exit unknown`，不写 0 |
| 心跳 | `runs.heartbeat_at` | T2（stale 时年龄）/ T3 | `heartbeat stale 2m14s` |
| 链接状态与握手 | `link.state`、`runHandshake`、`bound_by`、`capabilities`（MVP 只有 `mcp`；`observe_only` 自动绑定是 v1.1，MVP 只显示未确认身份） | T2（非 bound 时一个词）/ T3 | `handshake claimed`；Inspector 画状态机 |
| 父离线 | `parentOffline {since, seq, orphanPolicy}`（由 parent.offline 事件投影） | T0（顶部父行）/ T3 | `↑ parent ✳ main · offline 3m · continue` |
| 冲突 | 归并器冲突标志 + events | T0 `⚠ · two records` / T3 两条记录 | 不归属任一方 |
| 候选（疑似） | `candidates[]` | T3 only | 不进树、不进计数、不进 bar |
| 当前动作 / 工具 | `evidence.action` | T2 | 卡片 `▸ npm test -- parser` |
| 原生子代理 | `native[]` | T2（卡片子行）/ T1（`◈N` 评审 chip） | 子行用 kind 图标 |
| 进度 todo | `evidence.progress` | T2 / bar `Tasks` | |
| 覆盖 / 未加载 | `coverage`，树预算 | T2 词 `not loaded` / T3 | |
| 日志路径 | `~/.hud/runs/<runId>/` | T3 + `Log` 动作 | 路径缩成 `~`，`▾ More` 显示完整 |
| brief 路径、task digest | links | T3 More | 只显示 basename 和 digest 前 8 位 |
| link_id / run_id / child_ref / generation / supervisor pid / `asOfSeq` / `observationStamp` / `stateSinceBasis` / `cwdSource` | ledger、06 投影 | T3 More | ledger 戳与观测戳分开写，不互相比较 |
| claim、票据、credential hash、request_key、params_digest、cdp_url、parent_owner_key、heartbeat_seq/mono、原始 transcript 文本、用户 home 的绝对路径 | | T4 | 永不显示；路径一律 `~` |

bar 的信息清单不新增模块：`attention` 新增 needs-human / uncertain / conflict / stale 四种警示；`notice` 新增"收到报告 / 运行 uncertain / 待决原因变化"三种通知；`agents` 计数覆盖整棵树。其它模块不变。

## 2. 分情境的显示复杂度

四个披露层：**bar**（计数 + 警示）→ **行**（标记 + 名 + 右侧簇）→ **焦点行 / 卡片**（角色、宿主、报告、动作、子行）→ **Inspector**（全部）。情境只改变默认折叠，不改变语法。

| 情境 | bar | 面板默认 | 折叠 / 展开 |
|---|---|---|---|
| (a) 单个代理 | 今天的 bar；`agents` 模块不出现（没有子节点时本来就不画） | 一张卡片或一行；无 harness 标记 | 无 |
| (b) 几个原生子代理 | `Agents 1▸ 1✓` | 今天的卡片：子代理是卡片内子行 | 完成子行 3 分钟后收进 `⊕N`，`a` 显示 |
| (c) 跨 harness 树 | `Agents 3▸ 1⚑ 1✓`；≥ 160 列附 `· ⌬2 π1 ◎1` | 出现 harness 标记；委派子会话各自成卡（缩进 2 格），Jev 作业一张 3 行小卡（阶段 C）；原生子代理仍是子行 | 深度上限 4；超过的子树折叠成 `+3 (1⚑ 2▸)`（带子孙计数），`l` 展开为平铺 `↳` 行 |
| (d) 10+ 并发 | 同 (c)；警示优先显示，全形警示取最新触发的一条 | 手风琴：卡片总行数超过视口（或兄弟 > 5）时，先把 `✓ ■` 卡、再把未选中的 `▸ ·` 卡折成一行（= compact 行），`⚑ ? ⚠ !` 卡和选中卡保持展开；按子树有效桶排序：⚑ ! ⚠ ? → ▸ · → ✓ ■；完成桶折成一行 `✓ 5 done · …` | `a` 展开完成桶；`n` / `N` 跳到下一个 / 上一个 trouble 节点；`f` 过滤 attention；活跃行超过 30 行时时钟改分钟粒度 |
| (e) trouble | `attention` 徽章：`⚑ review-tests approval`（最新触发的一条）；多个时 `⚑1 ?1 ⚠1` | trouble 行丢徽章与计量线，换成状态词和驻留时长；排在最前，最新卡住的在最上 | 微卡给原因和缺失项；Inspector 给证据、对账命令 |
| (f) headless | 无差别 | 名后 `⊟`；无 pane 字段；控制条动作 `Log` | 结束后动作变 `Resume`（通过门禁时）；Inspector 显示 `resumable` 与否 |
| (g) 已完成 / 历史 | 完成 60 秒内进 notice：`✓ docs-sync reported` | 行变暗并带收尾事实（`reported 8m`、`ended`（无报告）、`failed`、`cancelled`、阶段 C 的 `answered → file`）；3 分钟后收进 `⊕N` | `a` 显示；`not loaded` 行只保留身份与最后状态；`closed` 与重开是 v1.1 |

折叠的触发只有三种：**宽度**（§4.2 的丢弃顺序）、**数量**（卡片总行数超过视口或兄弟 > 5 → 手风琴折叠，§3.5；终态项 3 分钟 → `⊕N`；兄弟 > 12 → 完成桶立刻折叠）、**深度**（> 4）。折叠永远带子孙计数，不吞掉深处的求救。展开用现有键加三个新键：`a`（收起的终态项）、`h`/`l`（折叠 / 展开子树）、`Enter`/`v`（Inspector）、`r`（状态卡层级）、`f`（过滤，新增 `attention` 档）；新键 `n` / `N`（下一个 / 上一个 trouble 节点，保留树形上下文）、`L`（日志）、`R`（Resume / Reconcile，§3.7）。

## 3. 组织

### 3.1 一棵树，不分组

面板只有一棵树，根是 HUD 所附着的会话（"视角根"）。跨 harness 的子会话和 Jev 作业挂在它们的父节点下；原生子代理挂在各自的会话下。节点身份是 06 的 `DisplayNodeIdentity`：`{kind: session, ref}`、`{kind: delegationIntent, linkId}`（已登记但尚未绑定的委派，用稳定的 linkId 作显示键，挂 currentRun，不按 label / cwd 合并、不计入已确认会话数；首次绑定后由 B9 映射到真实 ref，行不跳）、`{kind: job, ref}`（阶段 C）。没有"按后端分组"的视图：分组的需求由排序（§3.2）和汇总行的计数满足。不在树里的会话（其它根、CLI 直接起的 Jev 作业）在现有 Sessions 标签页里列出，Jev 条目带 `◎`。

从被委派方看（HUD 附着在子会话的 pane 里），树的根是子会话，父信息在顶部父行（§4.6）；不向上画父的兄弟。

### 3.2 排序：按桶，稳定

兄弟节点按**子树有效桶**排序：一个节点的桶 = 自身的桶与所有未收起子孙的桶中最靠前的那个（`⚑ ! ⚠ ?`（要人看）→ `▸ ·`（活着）→ `✓ ■`（结束））。于是 `✓` 的父节点底下还有 `⚑` 或 `▸` 的子孙时，整棵子树排在前面，也绝不会被收进 `⊕N`。trouble 桶内按进入该状态的时间倒序（最新卡住的在最上面），其它桶按创建顺序（`s` 键切换为纯创建顺序，与今天一致）。只有节点换桶时才重排，重排与整秒重绘同步，选中跟着节点走而不是跟着行号走；刚换桶的节点前 3 秒状态词和时钟加粗，帮眼睛找到"谁刚动了"。换桶、驻留和加粗都以 06 的 `stateKey` / `stateSince`（语义状态的 episode）为准，不以图标为准：同一个 `⚑` 下新一轮 approval 是新的 episode，时间重新计。

历史资格不看图标：委派节点以共享谓词 `isRunTerminal`（run `ended / failed / cancelled`；completed 报告、`cancelling`、图标都不算结束）为准，原生子代理按其原生完成事实，根会话不收起。符合条件的行（`✓ ! ■`）一视同仁：3 分钟后收进 `⊕N`，计数仍算，bar 的 `attention` 不再为它们亮——失败是历史事实，不是当前待办。当前待办只有 `⚑ ? ⚠`：它们一直排在前面直到条件消失，bar 的全形警示永远是其中最新触发的一条，旧警示盖不住新警示。

### 3.3 五维状态 → 一个标记

归并器（B16）给出 `activity / pendingReason / lastTurnOutcome / liveness / freshness`，HUD 再加 run/job/report 的终态和冲突标志，按下表第一条命中投影。这是纯函数，按节点 stamp 缓存。

| 序 | 条件 | 标记 | 颜色 | 行上状态词 |
|---|---|---|---|---|
| 1 | 冲突标志（同一 ref 两条记录） | `⚠` | warning | `two records` |
| 2a | `run.state = uncertain` 且 `reconciliation.cause = supervisor_dead`（托管进程死亡已证实；甲下前台回到 shell、harness 被挂起） | `?` | warning | `supervisor lost`；Open / 输入 / Resume 一律不可用，`⇢` 只有 Reconcile |
| 2b | 其它 `run.state = uncertain`（scope 无法查询、resume 解析到别的 ref、时钟异常……），或 `job.state = uncertain`（阶段 C） | `?` | warning | `uncertain` |
| 3 | `pendingReason ≠ none`，或报告 status = blocked | `⚑` | alert（加粗；面板上唯一的"现在要人"色） | `approval` / `question` / `needs human` / `blocked` |
| 4 | `lastTurnOutcome = failed`，或报告 status = failed，或有来源的原生退出结果为非零 / 信号（通常只有 headless argv 启动或 exec 直连路径才有；shell status 永不算），或 `run.state = failed`（02 的 non_execution，`stateKey = launch_failed`：从未执行，不是模型跑失败），或 `job.state = failed`（阶段 C） | `!` | danger | `failed`（焦点行在已知时加 `exit 1`）；launch_failed 写 `launch failed`，焦点行给采用的原因 |
| 5 | `lastTurnOutcome = interrupted`，或 run `cancelling` / `cancelled`，或报告 status = interrupted | `■` | warning，60 s 后 muted | `interrupted` / `cancelling` / `cancelled` |
| 6 | `freshness.state = stale`（任一所需来源越过确定截止，心跳严格 > 30000 ms；supervisor 死亡未被证实、run 仍 running），或 `freshness.state = unknown`（所需来源缺失、身份不匹配或时钟不可判），或 `liveness = unknown` 且 `activity = unknown`；只比较 `freshness.state`，不看明细 | `?` | muted | `stale` / `unknown`；时钟列显示 `lastEvidenceAt` / 心跳年龄 |
| 7 | `activity = working`，或 `job.state ∈ {sent, waiting}` | `▸` | info | 无 |
| 8 | run `starting`，或 link `pending / claimed` 且无活动，或 `job.state = key_persisted`（阶段 C） | `·` | muted | `starting`；作业等租约时 `browser queue (held by ask-pro-1)` |
| 9 | `isRunTerminal = true`（run `ended`——已核验进程组为空——或 `cancelled`；`failed` 已被第 4 条接走）、`liveness = gone` 或 `activity = exited`：委派节点有 completed 报告 → `✓`；没有报告 → `■`（muted），不看退出码，因为原生退出结果通常是 null；根会话或原生节点退出 → `■ exited`（warning） | `✓` / `■` | success / muted | 历史行 `reported` / `ended`；焦点行 `ended · no report · exit unknown` |
| 10 | `activity ∈ {idle, waiting_input}`，`pendingReason = none`：根会话或原生节点 → `✓`（今天的语义）；委派节点没有 completed 报告 → `·`（活着、空闲、没交差；绿色 `✓` 只给交了差的） | `✓` / `·` | success / muted | 无 / `idle`（微卡给报告摘要或最近动作） |
| 11 | 其它 | `?` | muted | `unknown` |

计数：working = `▸`；alive-not-working = `·`（starting / idle）；blocked = `⚑`；trouble = `? ⚠ !`；done = `✓ ■`。`agentCounts` 和 bar 都用这些桶，汇总行只写非零的。

"父 idle、子 working"：根的父行是 `✓`，不加词；汇总行的 `N▸` 和父卡片的计数行（`2 working · 1 done`）说明子在干活，而排序按子树有效桶把它留在前面（§3.2）。

stale 的含义只有一个：来源失联（心跳超 30 s、注册表不可达、文件不可读），由 B16 判定。模型长时间思考不是 stale，是现有的 quiet（时钟 5 分钟后转 warning）。stale 行不画最后已知的 `▸`（那是猜），焦点行和 Inspector 写"最后已知 working，45 s 前"。

三种"不知道"分开画：`? stale`（muted）是健康运行上的心跳延迟或来源失联，等一等就好；`? uncertain`（warning）是运行状态需要对账；`? supervisor lost`（warning）是甲下托管进程已死、终端回到 shell、harness 挂起的本轮监督故障——槽仍被占，HUD 不聚焦、不送输入、不自动 resume，只给诊断和 Reconcile。对委派节点，`✓` 只来自 completed 报告；运行结束是事实，退出结果是另一回事，两者都不能代替报告。

分类本身是 B16 的唯一函数（契约 06「唯一语义分类」，优先顺序与本表一致），输出 `stateKey`（语义加原因：approval / question / supervisor_dead / launch_failed…）；本表只是它到图标、颜色、词的映射，前端不另维护分类，也不把图标反推成状态。

### 3.4 行的解剖（compact）

```
col 1      选中 ›（否则空格）
col 2…     深度 d ≥ 1：(d-1) 个「│ 」+「├ 」/「└ 」；未证实的边用「┊ 」
+1         状态标记（§3.3）
+1         空格
+1         图标位：会话 / 作业 = harness 标记（跨 harness 树）；原生子代理 = kind 图标（⌕ ⚗ ⚒ ◈ ✎ ∑）；单 harness 树 = kind 图标或空
+1         空格
名字字段    label；headless 后缀「 ⊟」；trouble 行再接「 · 状态词」；至少 8 格，用 … 截断
≥1         间隙
右侧簇      [◈N] [徽章 ≤13，右对齐] [计量线 4] [时钟 7，右对齐]
```

规则：

- 时钟列永远是最后 7 格，含义随标记变：`▸` 轮时钟 `◷12m04s`；`⚑ ! ⚠` 卡在该状态的驻留时长（`10s` 和 `15m` 一眼分开）；`?` 最近证据 / 心跳年龄；`✓ ■ ·` 结束或进入该状态的年龄。没有时钟的行留空而不是画 `—`。驻留时长来自 06 持久发布的 `stateSince`：`stateSinceBasis = event` 画 `10s`，`observed`（只知道首次看到这个状态的时间）画 `~10s`，`unknown` 或 null 留空——不用重绘时间编一个年龄；`?` 行的年龄永远取 `lastEvidenceAt` / 心跳，不用 `stateSince` 代替；时钟倒退（`clockAnomaly`）留空并在 Inspector 写明。
- 徽章只在会话 / 作业行上；原生子代理行只有时钟（模型与父不同时才有徽章）。
- trouble 行（§3.3 第 1–6、8 条，`⚑` 行也在内）无条件丢徽章和计量线，保留状态词和时钟；这是"先丢字段"的具体应用。≤ 39 列时名字保底 8 格优先于状态词：先丢状态词，最后才截名字。
- 终态行（`✓ ! ■`）用报告摘要代替徽章和计量线：`✓ ⌬ docs-sync · Synced two reference…`（muted，按格截断）；只有报告没有摘要写 `reported`，没有报告写 `ended`；摘要不足 12 格就不显示。
- 深度 > 4 的行画在深度 4 的位置，前缀 `↳`；折叠的子树写 `+3 (1⚑ 2▸)`，< 40 列写 `+3⚑`。
- 选中的行下面是一张两行微卡：第 1 行委派行（`reviewer · ⊟ headless · $0.12 · 2m`，与父的 `worktreeRoot` 不同时加 `in fix-cjk`，§1 的工作树行），第 2 行按优先级取一条——待决 / 故障原因（含缺失项，如 `? uncertain: scope unknown · no receipt`）> 最近报告摘要（含 `exit 1` 这类有来源的退出事实）> 当前动作 > 模型写的 brief。没有委派行的节点（根、原生子代理）只有第 2 行。这样看一眼就知道它在哪、卡在什么上，不必为此打开 Inspector。

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

委派子会话各自成卡，整卡按深度缩进 2 格；深度 2 缩进 4 格。Jev 作业卡只有头、作业行（`ask · sent 4m · key 1101-a7`）、答案行（仅 answered 后：`→ ~/jev/out/parser-plan.md`）和一条无计量线的脚。卡片里只有事实和模型写的文本，没有 HUD 的命令或劝告（对账命令在 Inspector 和控制条）。

**手风琴**：rich 布局里的卡片可以折成一行——折起的卡片就是该节点的 compact 行（§3.4），框架列用 `─` 代替 `┌`。卡片总行数超过视口（或兄弟 > 5）时自动按顺序折叠：先 `✓ ■`，再未选中的 `▸ ·`，最后根；`⚑ ? ⚠ !`（新鲜）卡和选中卡永不自动折叠。`h`/`l` 手动折叠 / 展开。于是列表在"全是卡片"和"全是行"之间连续过渡，没有 8→9 张卡的悬崖；compact 布局仍是用户可选的"全部折起"。

### 3.6 边：深度与跨 harness

缩进 + `│ ├ └` 画已证实的边（link `bound / reported / closed`）；`┊` 画未证实的边（`pending / claimed`，此时名字是 brief 里的 label，节点标记按 §3.3 第 8 条）。`handed_over` 的旧边不画，只在后继节点 Inspector 的"Link"节写 `predecessor`：同 owner 的转交（改任务用新 link）在 MVP 里就会出现，旧 link `handed_over / current_owner=0`，新 link 是唯一当前父边；跨 owner 转交是 v1.1。跨 harness 的边与同 harness 的边画法相同——harness 标记本身已经说明边跨了 harness，再加样式反而多一个要学的符号。

### 3.7 动作在哪

只在两处：控制条和 Inspector 第一行右侧。只读动作和有副作用的动作分开——控制条的 `⇢` 按钮只做只读的 Switch / Open / Log（词随选中行变），`↻` 按钮只做 Resume / Reconcile，仅在适用时出现（像 `⊕N`）。键位同样分开：`o` / Enter 只做 Open / Switch / Inspector，`L` 看日志，`R` 专用于 Resume / Reconcile；整秒重绘时状态跳变不会让一次按键做出另一件事。

`R` 在 MVP 里只显示并复制命令（Oracle2 D04 已定，不再是开放问题）：按钮和 Inspector 消费同一个契约 03 的 `ActionDescriptor {operation, linkId, runId, reason, subject: local_user, delivery: copy_only, hudHome, displayCommand}`，resume 另带 `expectedRun / mode / requestKey`。复制的是 `displayCommand`——由受信模板安全生成，含明确的 HUD_HOME、linkId、`--request-key`、`--expected-run`、`--mode`；文档里的 `hud run resume <linkId>` 只是缩写；report / label / 日志里的任何字符串都不是命令来源。重复复制同一待处理意图保留同一 `requestKey`；状态变化不能把已选操作换成另一个 run。本地 resume 入口未实现或未验证时不给裸命令，微卡 / Inspector 改写诊断和"由原父调用 `delegate_resume`"的途径。控制条回显 `✓ Copied` 两秒。绘制、通知、重连、进入 uncertain 或定时器都不触发这些动作。

| 选中行 | 按钮 / 键 | 做什么 |
|---|---|---|
| 原生 Codex 子代理 | ⇢ Switch（`o`） | 今天的切换 |
| `interaction.focus = true`（可见委派、occupant 已核验、宿主可控 Herdr / tmux） | ⇢ Open（`o`） | 聚焦那个 pane / tab |
| `interaction.focus = false`（occupant 不匹配、宿主不可控、run uncertain 含 `supervisor lost`） | ⇢ Open（灰） | 不可用；Inspector 写原因；HUD 只读这个字段，不自己从心跳推断 |
| 活跃 headless | ⇢ Log（`L`） | 新 pane 里 `tail -f` 日志；无宿主时显示路径 |
| 已结束且已报告（`reported`），`resumable = true`（`subject = local_user`）且 `interaction.resume = true` | ↻ Resume（`R`） | 复制 `ActionDescriptor.displayCommand`（缩写 `hud run resume <linkId> --request-key … --expected-run … --mode …`，Inspector 同一行），回显 `✓ Copied`。直接调用是将来的可选能力：显式按键 → 固定目标确认 → 可信 executable + argv，不执行 shell 字符串，写者重验。`closed` 链接重开是 v1.1 |
| `uncertain`（含 `supervisor lost`）/ `⚠` | ↻ Reconcile（`R`） | 同上，`operation: reconcile`（缩写 `hud run reconcile <runId>`，按 run + 证据指纹幂等导入）；`supervisor lost` 时这是唯一可用的动作 |
| 根会话 | Switch（`⌂`） | 今天的行为 |

HUD 不自己改账本，不把 Open 当作 resume，不把 UI done 当作 run ended，也不把 run ended 当作任务完成（那要看报告）。

## 4. 各表面

### 4.1 bar（一行，英文）

模块与优先级沿用 `MODULE_PRIORITY`；`agents` 计数覆盖整棵树；`attention` 新增四种警示；`notice` 新增三种通知。警示优先级：`⚑`（要人）> `✗`（失败）> `⚠`（冲突）> `?`（uncertain）> stale；一个警示用全形，多个用短形。

```
200 列（full）：
⚑ review-tests approval │ fable-5.1 high │ ━━━━╸───── 112.3K/272K │ parser-kit main*↑2 │ 7d 61% │ ▸ 3:10 │ 38 tok/s │ Agents 3▸ 1⚑ 1✓ · ⌬2 π1 ◎1 │ Tasks 2/5 │ Edit src/parser.ts │ MCP 2 skills 9

120 列（balanced）：
⚑ review-tests approval │ fable-5.1 │ ━━━━╸───── 112.3K/272K │ parser-kit main* │ ▸ 3:10 │ Agents 3▸ 1⚑ 1✓ │ Tasks 2/5

80 列（focus）：
⚑ 1 approval │ fable-5.1 │ ━━━╸── 41% │ parser-kit │ ▸ 3:10 │ 3▸ 1⚑ 1✓
```

丢弃顺序照旧 `SHRINK`：右簇 → effort → 计量线缩成百分比 → notice 内容 → `Agents` 标签 → 分支 → 时钟。新增两条：后端计数 `· ⌬2 π1 ◎1` 在右簇之前丢；`attention` 从全形退到 `⚑ 1 approval` 再到 `⚑1`，永不丢。

通知（60 秒）：`✓ docs-sync reported` · `! lint-fix failed` · `? impl-b uncertain` · `⚑ review-tests approval`。切 tab 不触发。

### 4.2 面板树：宽度预算

| 宽度 | 行上保留 | 丢弃 |
|---|---|---|
| 56 | 全部：`◈N` 徽章全形 计量线 时钟，名字很少截断 | |
| 48（默认） | 徽章 `6.1sol·xhigh`、计量线、时钟 | 名字 > 可用时先丢 `⊟`，再截断到 ≥ 8 格 |
| 40–47 | 徽章退到 `6.1sol` 或族图标、计量线、时钟 | 徽章全形 |
| 32–39 | 计量线、时钟 | 徽章；名字字段 < 8 格时再丢计量线 |
| rich 80 | 卡片委派行可带 `run N · heartbeat 3s`；子行带徽章 | |

卡片和行每行恰好 `width` 格（`visualLength`，CJK 2 格）。汇总行的丢弃顺序：计数永远保留 → 先丢速率 `~80 tok/s` → 再丢 `3 workers, 1 job` → 最后丢树级花费 `≥$0.12`。

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

与今天的 `panel/en/tab/monitor/48x32` 基线相同：子代理是卡片内子行，`!` 失败子行排前，`◷` 轮时钟，计数行 `1 implementer · 1 scout`。唯一变化是汇总行写法 `1✓ 1▸ · 2 subtasks, 1 failed · ~42 tok/s`（数字在前）。

### 4.5 情境 (c)：跨 harness 树

场景：Claude Code 会话 `main` 通过 `hud-mcp` 起了 Codex implementer（可见，pane 4，有两个原生子代理）、pi reviewer（headless，等审批）、一个 ChatGPT 作业（等答案；Jev 是阶段 C，这里只为展示作业卡）和一个已报告、运行已结束的 Codex writer。

**48 列 rich：**

```
| ⌂  ▦ Agents    ≣   ±   ◫   ⚙ Settings    ⇢ ǁ ? |
| ▦  1⚑ 3▸ 1✓ · 3 workers, 1 job · ≥$0.12        |
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
| ▦  1⚑ 3▸ 1✓ · 3 workers, 1 job · ≥$0.12        |
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
| ▦ 1⚑ 3▸ 1✓ · ≥$0.12            |
|› ▸ ✳ main           ━━╸─ ◷3m10s|
|│ Coordinating parser work; wa… |
| ├ ▸ ⌬ impl-parser  ━━━╸ ◷12m04s|
| │ ├ ▸ ⌕ scout 中文 bou…  ◷1m00s|
| │ └ ✓ ◈ review-pass          3m|
| ├ ⚑ π review-tests          10s|
| ├ ▸ ◎ ask-pro                4m|
| └ ✓ ⌬ docs-sync              2m|
```

32 列：徽章全丢；根被选中，它没有委派行，微卡只有一行 brief；`review-tests` 的 `⊟` 和状态词比截断名字先丢，`⚑` 和驻留时长 `10s` 仍在；`scout 中文 boundaries` 截到 15 格；完成行的报告摘要没有 12 格余地就不显示。

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

### 4.7 情境 (d)：15 个并发工人，48 列 compact

```
| ▦  2⚑ 6▸ 1· 1? 5✓ · 15 workers · ≥$1.80        |
|› ▸ ✳ main            5.1fable·high ━━╸─  ◷8m02s|
| ├ ⚑ π t-07 ⊟ · approval                     10s|
| ├ ⚑ ⌬ t-03 · question                        4m|
| ├ ? ⌬ t-11 ⊟ · uncertain                    14m|
| ├ ▸ ⌬ t-01            6.1sol·xhigh ━━━╸  ◷9m02s|
| ├ ▸ ⌬ t-02            6.1sol·xhigh ━━╸─  ◷7m40s|
| ├ ▸ π t-09 ⊟           6.1sol·high ━╸──  ◷3m15s|
| ├ ▸ ⌬ t-12            6.1sol·xhigh ━╸──  ◷2m51s|
| ├ ▸ π t-14 ⊟           6.1sol·high ━╸──  ◷1m08s|
| ├ ▸ ⌬ t-15            6.1sol·xhigh ╸───  ◷0m47s|
| ├ · π t-13 ⊟ · starting                     12s|
| └ ✓ 5 done · t-04 t-05 t-06 t-08 t-10        ⊕5|
```

规则：compact 布局下全部是行；rich 布局下按 §3.5 的手风琴折叠（下图）；trouble 桶内最新卡住的在上（t-07 卡了 10 s，排在卡了 4 分钟的 t-03 之上）；完成桶折成一行，`a` 展开；活跃行 > 30 时时钟改成 `◷9m` 粒度，整秒重绘停止；超过视口的行不渲染字符串，只保留投影；200 节点预算之外的节点以 `not loaded` 行出现在完成桶里。

同一场景的 rich 手风琴（视口放不下 15 张卡：`✓ ■` 和未选中的 `▸ ·` 卡折成行，`⚑ ?` 卡和选中卡展开；`t-03` 的 `worktreeRoot` 与父不同，委派行多了 `in t03-wt`（`worktree` 显示名））：

```
| ▦  2⚑ 6▸ 1· 1? 5✓ · 15 workers · ≥$1.80        |
|─ ▸ ✳ main            5.1fable·high ━━╸─  ◷8m02s|
|  › ⚑ π t-07 ─────────────────────── 6.1sol·high|
|  │ reviewer · ⊟ headless · $0.04 · 10s         |
|  │ ⚑ approval: delete tests/old-fixtures?      |
|  └ 10s ─────12%────────────────────────────────|
|  ┌ ⚑ ⌬ t-03 ────────────────────── 6.1sol·xhigh|
|  │ implementer · pane 6 · in t03-wt · 4m       |
|  │ ⚑ question: keep the legacy parser?         |
|  └ 4m ────────────────38%──────────────────────|
|  ┌ ? ⌬ t-11 ────────────────────── 6.1sol·xhigh|
|  │ implementer · ⊟ headless · 14m              |
|  │ ? uncertain: scope unknown · no receipt     |
|  └ 14m ────────────31%─────────────────────────|
|  ─ ▸ ⌬ t-01           6.1sol·xhigh ━━━╸  ◷9m02s|
|  ─ ▸ ⌬ t-02           6.1sol·xhigh ━━╸─  ◷7m40s|
|  ─ ▸ π t-09 ⊟          6.1sol·high ━╸──  ◷3m15s|
|  ─ ▸ ⌬ t-12           6.1sol·xhigh ━╸──  ◷2m51s|
|  ─ ▸ π t-14 ⊟          6.1sol·high ━╸──  ◷1m08s|
|  ─ ▸ ⌬ t-15           6.1sol·xhigh ╸───  ◷0m47s|
|  ─ · π t-13 ⊟ · starting                    12s|
|  └ ✓ 5 done · t-04 t-05 t-06 t-08 t-10       ⊕5|
```

### 4.8 情境 (e)：trouble，48 列

compact 总览（根已退出，四个子节点各有一种麻烦，一个正常）：

```
| ▦  1⚑ 3? 1⚠ 1▸ · 5 workers, 1 job              |
|› ■ ✳ main · exited    5.1fable·high ━━╸─     3m|
| ├ ⚑ ◎ ask-pro · needs human                  9m|
| ├ ? ⌬ impl-d · supervisor lost               7m|
| ├ ? ⌬ impl-b ⊟ · uncertain                  14m|
| ├ ⚠ ⌬ impl-c · two records                   6m|
| ├ ? π rev-a ⊟ · stale                       48s|
| └ ▸ ⌬ impl-a          6.1sol·xhigh ━━╸─  ◷2m10s|
```

- `■ main · exited`：父进程已退（3 分钟前，`■` 已从 warning 退成 muted），子按 `orphan_policy=continue` 继续；子行不再重复"父离线"，树形已经说明。被委派方视角用顶部父行说。父 MCP 断连与 supervisor 死亡是两件事：前者子照常可用，后者见下一条。右端时钟按 §3.4 的状态语义：`⚑ ⚠` 是驻留时长，`?` 是最近证据年龄，`■` 是退出年龄。
- `? impl-d · supervisor lost`：warning 色。甲下托管进程已死：终端前台回到 shell，harness 被挂起（`suspended (tty input)`），run 进入 uncertain 并继续占槽。行上不写 pane 可用，`⇢` 只有 Reconcile，Open 灰，不送输入、不自动 fg、不自动 resume；焦点行 `? supervisor lost · harness suspended in pane 4 · reconcile first`。
- `⚑ ask-pro · needs human`（阶段 C）：Jev `NEEDS_HUMAN`，浏览器租约仍被持有；焦点行 `⚑ needs human: login expired in shared browser`。
- `? impl-b · uncertain`：warning 色；其它对账原因（这里是 scope 无法查询）；时钟是最近证据年龄。
- `⚠ impl-c · two records`：不归属任一方；Inspector 列两条。
- `? rev-a · stale`：muted 色；健康运行上的心跳延迟，supervisor 死亡未证实；时钟是最近心跳年龄 48 s。等待或查看，不需要对账。

uncertain 的 rich 卡：

```
|  ┌ ? ⌬ impl-b ──────────────────── 6.1sol·xhigh|
|  │ implementer · ⊟ headless · run 2            |
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
| run 2 · headless · uncertain 2m                |
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

这里 link 是 `bound`（关系早已证实）而 run 2 的 `runHandshake` 是 `claimed`：两者分开写，正是契约 03 I-03-3 的区别。`reconcile:` 一行是缩写，`R` 复制的是 `ActionDescriptor.displayCommand` 全文（含 HUD_HOME）；本地入口未验证时这一行改写诊断，不写命令。`▾ More` 展开 link_id、run_id、child_ref、generation、evidence id 列表与完整路径。

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

bar 上的对应警示：`⚑ ask-pro needs human`（一个时）、`⚑1 ?3 ⚠1`（多个时）、`⚑1`（最窄）；`supervisor lost` 在 `?` 里计数，notice 用整句 `? impl-d supervisor lost`。

### 4.9 情境 (f)：headless

行：`⊟` 后缀；卡片委派行 `reviewer · ⊟ headless · $0.12`；控制条：

```
| ⌂  ▦ Agents    ≣   ±   ◫   ⚙ Settings ⇢ Log ǁ ?|
```

结束并已报告后，`↻` 按钮出现（只在适用时），`⇢ Log` 仍可看日志：

```
| ⌂  ▦ Agents  ≣  ±  ◫  ⚙  ⇢ Log ↻ Resume ǁ ?    |
```

`Log`（`L`）在宿主可控时开一个 pane 跟日志，否则 Inspector 里显示路径。`↻ Resume`（`R`）在 `resumable = true`（subject `local_user`）时可用（复制 `displayCommand` 并回显 `✓ Copied`，§3.7）；否则灰，Inspector 写 `reason`（如 `not resumable: revoked`）；本地入口未验证时写诊断而不是命令。headless 运行的"可见"信息不存在，所以不写 pane。headless 是 hud-run 的直接子进程，原生退出结果通常可得，`failed · exit 1` 这样的行主要出现在这里；可见运行（方案甲）的原生退出结果通常是 null——结束只由已核验的进程组为空证实，`✓` 只来自 completed 报告，没有报告就是 `■ ended`，shell status 只在 `▾ More` 作诊断，永不当退出码。

### 4.10 情境 (g)：完成与历史，48 列 compact

默认（完成项已收起）：

```
| ▦  1▸ · 1 worker · 6 put away                  |
|› ▸ ✳ main            5.1fable·high ━━╸─  ◷1m20s|
| └ ▸ ⌬ impl-parser     6.1sol·xhigh ━━━╸ ◷12m04s|
```

`a` 之后：

```
| ├ ✓ ⌬ docs-sync · Synced two reference…     14m|
| ├ ✓ ◎ ask-pro · → parser-plan.md            22m|
| ├ ! π lint-fix · Lint rule 12 unresolv…     31m|
| ├ ■ ⌬ bench · cancelled                      1h|
| ├ ✓ ⌬ t-07 · reported                        3h|
| └ ■ ⌬ t-old · ended · not loaded             2d|
```

历史行一律 muted；时钟是结束年龄；名字后面是最有信息量的收尾事实：有报告摘要就按格截断显示摘要（`✓` 和 `!` 都是，一排 `· reported` 什么都说不了），只有报告没有摘要写 `reported`，没有报告写 `ended`（微卡第 2 行 `ended · no report · exit unknown`）；有来源的退出结果（`exit 1`）进微卡，不占行；`ask-pro` 行是阶段 C 的作业历史，显示产物名；`not loaded` 行只有身份和最后状态，Enter 打开的 Inspector 写 `history not loaded (budget)`。`closed` 与重开是 v1.1，MVP 的历史里不会出现；同 owner 转交留下的 `handed_over` 旧链接会出现，但只在后继节点的 Inspector 里作 `predecessor` 历史，不单独成行。

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

节的出现条件："Candidates"只在有候选时；"Coverage"只在不完整时；"Reports"永远（没有就写 `none yet`，这是现有的两个空句子例外之外新增的一个，理由：报告的缺席本身是信息）。Jev 作业（阶段 C）的 Inspector 用 `── Job ──`：provider、account 显示名、key、state、租约（`shared browser · held`）、credits、答案路径。

### 4.12 statusline（Claude Code，窄）

短命进程，stdin 字段（session、model、context、cost）永远优先；失败标准 p95 渲染 > 150 ms。最多两行，高度只在 1 / 2 之间变：第一行是会话事实（claude-hud 0.8.0 的同等项），有委派时末尾常驻计数 `⧉ 2▸ 1⚑ 1✓`；第二行只在有活跃或 trouble 委派时出现，只展开 `⚑ ! ⚠ ?` 节点（带状态词和驻留时长）和前 2–3 个活跃节点，其余收成 `+N`。没有第三行——警示已经在第二行的最前面。设置 `statusline.delegationLine=false` 时只保留第一行末尾的计数。

```
80 列：
fable-5.1 ━━━━╸───── 41% │ parser-kit │ $1.24 │ ▸ Edit parser.ts │ ⧉ 2▸ 1⚑ 1✓
⧉ ⚑ π review-tests approval 10s · ▸ ⌬ impl-parser 12m · ▸ ◎ ask-pro 4m

120 列：
fable-5.1 high ━━━━╸───── 112.3K/272K │ parser-kit main*↑2 │ $1.24 · 38 tok/s · 12m │ ▸ Edit src/parser.ts │ ⧉ 2▸ 1⚑ 1✓
⧉ ⚑ π review-tests approval 10s · ▸ ⌬ impl-parser pane 4 12m · ▸ ◎ ask-pro 4m · +1✓

200 列：第一行加 Tasks、usage window 与 MCP/skills 计数；第二行同 120 列并带每项的 pane / 模式，`+N` 展开到 5 项。
```

第二行的项按 §3.2 的桶排序（trouble 最新在前），每项 `标记 harness 名 [词] 年龄`，年龄语义同 §3.4；宽度不够时先丢 pane / 模式，再丢年龄，再把活跃项收成 `+N▸`，trouble 项最后才缩成计数；整行放不下就只留第一行的计数。数据来源见 §6.9。

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
| `⚑` | alert（加粗）：面板上唯一的"现在要人"色，与 bar 的警示徽章同源；黄色只剩下"要我处理"一个意思 |
| `⚠`、uncertain / supervisor lost 的 `?` | warning |
| `■` | warning；发生 60 s 后 muted（与 `✓` 同一条 `FRESH_FINISH_MS` 规则） |
| 刚换桶的节点（3 s 内） | 状态词与时钟 bold |
| stale / unknown 的 `?`、`·` | muted |
| harness 标记 | muted；选中行 strong |
| 名字 | text；根 strong；历史 / stale / not loaded 行整行 muted |
| 状态词 | 与标记同色 |
| 徽章、Jev provider | model（max / ultra effort 仍 warning） |
| `⊟`、`$0.12`、`12cr`、`pane 4` | muted |
| 未证实边 `┊` | muted |
| 选中行 | selectedBand + `›`；行上的文字和标记用调色板为 band 校准过的前景（`selected` 角色族），不能把 warning / muted 原样叠在 band 上；没有 band 的调色板（`none`、`terminal`）选中 = `›` + 名字加粗 |
| bar 警示 | alert |

harness 不用颜色区分：颜色已经承担状态和 agent 方向色，再加一层会让 `▸` 失去唯一的"亮"。若用户反馈分不清，加设置 `harnessColors`（§9）。

### 5.3 图形与 ASCII 退化

`icons=text` 时下表整体切到 ASCII；其它图标集用 unicode 列（nerd 集暂不另配）。

| 含义 | unicode | ASCII |
|---|---|---|
| starting | `·` | `.` |
| working | `▸` | `>` |
| needs human | `⚑` | `@` |
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
- **CJK**：所有截断走 `truncateAnsi`，按格计算；ZH 状态词限 ≤ 8 格（`未确定 需要人 两条记录 已退出 已关闭 已取消 启动中 已回答 未加载 离线 等浏览器 过期`）。
- **明暗**：latte / mocha 都不靠颜色单独表达状态——每个状态有标记，每个 trouble 有词；muted 在 latte 上保持可读由调色板负责（现有）。

### 5.5 用词表（`t()`）

| EN | ZH |
|---|---|
| starting / uncertain / stale / unknown | 启动中 / 未确定 / 过期 / 未知 |
| approval / question / needs human / blocked | 审批 / 提问 / 需要人 / 受阻 |
| failed / launch failed / interrupted / cancelling / cancelled / exited / ended / closed | 失败 / 启动失败 / 已中断 / 取消中 / 已取消 / 已退出 / 已结束 / 已关闭 |
| answered / sent / waiting / browser queue | 已回答 / 已发送 / 等待中 / 等浏览器 |
| two records / not loaded / offline / unconfirmed | 两条记录 / 未加载 / 离线 / 未确认 |
| supervisor lost / no report / exit unknown / Copy command | 托管中断 / 无报告 / 退出未知 / 复制命令 |
| handshake · claimed · bound · reported | 握手 · 已声明 · 已绑定 · 已报告 |
| parent / pane / headless / run / worker(s) / job(s) / put away | 父 / 窗格 / 无界面 / 轮 / 委派 / 作业 / 已收起 |
| Link / Run / Reports / Candidates / Coverage / Job | 链接 / 运行 / 报告 / 疑似 / 覆盖 / 作业 |
| Open / Log / Resume / Reconcile / Switch | 打开 / 日志 / 恢复 / 对账 / 切换 |

## 6. 性能规则（G13）

1. **每 tick 的 I/O**：账本只做索引查询（父 / 子 ref 两个索引），`LIMIT 200`，与文件证据共用 8 MiB 预算；先查 `PRAGMA data_version`，没变就不查表。tick 节奏沿用自适应：活跃 1 s，空闲 5 s；没有按秒轮询账本。
2. **三层缓存**：(a) 节点投影缓存，键 `(DisplayNodeIdentity, asOfSeq, observationStamp.commitSeq, evidenceStamp)` → 标记、词、桶、计数贡献（ledger 戳与观测戳各自参与，不比较）；(b) 行字符串缓存，键 `(nodeStamp, width, selected, lang, look, icons, clockBucket)`；(c) 卡片缓存（现有，500 张，`cardNow` 整秒）。Inspector 不缓存（一次只有一个）。
3. **每 tick 重算**的只有：汇总计数、警示列表（都是对 ≤ 200 个缓存投影的一次遍历）和焦点行；排序只在"有节点换桶"标志为真时重算。
4. **重绘**：frame-diff，整秒对齐；只有 stamp 变化的行重画；活跃行 > 30 时时钟改分钟粒度，于是只有状态变化才重画。
5. **可视窗口**：只对视口内的行生成字符串，视口外保留投影；折叠规则保证活跃行优先在视口内。
6. **预算**：200 节点 × 56 列的 compact 全树 < 20 ms；rich 布局按卡片缓存命中率计；超出 50 ms 的 tick 记进 `health`（现有机制），不降级画面。
7. **文本**：外部文本过 `monitorText` 一次，按文本哈希缓存；截断结果随行缓存。
8. **动效**：唯一的 250 ms 定时器只在面板聚焦且选中卡有关系行时存在。
9. **statusline**：优先读 HUD 的机读状态文件（`$CODEX_HOME/hud/state/<session>.json` 的通用版，≤ 5 s 新鲜）；没有则做一次索引查询（父 ref → ≤ 50 个直接子节点，不建树）；两者都没有就省略第二行。p95 < 150 ms。
10. **子树有效桶与子孙计数**：每 tick 一次后序遍历（≤ 200 节点）求每个节点的子树最差桶和 `(1⚑ 2▸)` 计数，结果进节点投影缓存；排序仍只在桶变化时做。
11. **微卡与手风琴**：只有选中节点生成两行微卡；折起的卡片复用行字符串缓存；展开 / 折叠不触发整帧重绘，frame-diff 只画变化的行。
12. **树级花费与驻留时长**：对 ≤ 200 个 `spent` 求和是每 tick 一次加法（按完整 SessionRef 去重，带 known / missing 计数）；驻留时长由 06 持久发布的 `stateSince` 与 `nowMs` 相减，HUD 不自己记"首次见到"的时间（重启、两个面板、statusline 才会得到同一驻留时长），不需要定时器，也不为此写 ledger。

## 7. 数据层必须提供的（对照契约 03 / 06 与 B16）

| # | 需要 | 对照 |
|---|---|---|
| 1 | **已满足（契约 06 `ObservationView.statusProjection`；契约 03 status）**：`activity / pendingReason / lastTurnOutcome / liveness / freshness {state, …}` 加 `stateKey / stateSince / stateSinceBasis / isRunTerminal / asOfSeq / observationStamp / asOf / observedAt / lastEvidenceAt / lastKnownActivity?`。`asOfSeq` 只是 ledger events 高水位（无 ledger 为 null，已打开的空库才是 0）；`observationStamp {seqDomain, commitSeq, inputLedgerSeq, ref, runId?, bindingGeneration?, sourceGeneration}` 是观测存储自己的戳（intent 无观测 commit 时为 null）；两套戳不跨域比较，没有跨存储原子承诺——HUD 把两者分开放在 `▾ More`，不把 ledger 高水位贴到旧摘要上，旧轮摘要只作历史 | 契约 06 ObservationView / ObservationCommit；契约 03；Oracle2 D12 |
| 2 | 冲突标志：`conflict: {count, recordIds[], since}`，归并器不猜状态 | 契约 03 conflict / candidates（v0.3 已满足）；B16 |
| 3 | `link`：`state`、`label`、`role`、`backend`、`parent_ref`、`child_ref`、`current_owner`、`bound_by`、`capabilities`（MVP 只有 `mcp`）、`brief_path`（basename 用）、`task_digest`、`predecessor`（同 owner 转交，MVP 就有）；`closed_at` 在 MVP 恒空（不产 closed），`observe_only` 绑定是 v1.1，`capabilities` 为当前 MCP 能力或 `none` | 契约 03 link / runHandshake（v0.3 已满足）；Oracle C03 / C04 |
| 4 | `runHandshake`（pending / claimed / bound + reason），与 `link.state` 分开 | 契约 03 |
| 5 | `currentRun`：`runId`、`run_seq`、`mode`、`supervision_strategy`（MVP：headless / wrapper 甲）、`state`、`launch_phase`、`locator`（pane / tab / label）、`started_at`、`ended_at`、`cancel_requested_at`、`heartbeat {at, quality}`（ageMs 由 HUD 用 nowMs 派生）、`exit {code\|null, signal\|null, source, reason, coverage}`、日志路径、`isCurrent`。`state = ended` 只凭已核验的进程组为空成立，不依赖退出码；`exit.code` 只表示有来源的原生结果，shell 结果另给 `shell_status` / `shell_signal`（诊断，HUD 只放 `▾ More`） | 契约 03 currentRun / exit / logs（v0.3 已满足）；契约 04；Oracle C07 / C09 |
| 6 | `latestReportForRun {status, summary, path, created_at, report_id}` 与 `reportHistory`（按 run 分页，count 与最近一条） | 契约 03 latestReportForRun / reportHistory（v0.3 已满足） |
| 7 | `host.occupantMatches`（true / false / null）、locator `valid / stale / unknown` 与核验时刻；不匹配时不给宿主字段 | 契约 03 host / parent（v0.3 已满足） |
| 8 | `candidates[]`（证据种类、时间），只供 Inspector | 概念 §6.5 |
| 9 | 父离线：`parentOffline {since, seq, orphanPolicy}` 或 null，由 parent.offline 事件投影 | 契约 03 interaction / parentOffline（v0.3 已满足）；契约 04 orphan |
| 10 | uncertain 的 `reconciliation {cause, evidenceIds[], missing[], observedAt, 允许入口}`，允许入口是类型化 `ActionDescriptor`（`displayCommand` 由受信模板安全生成；report / label / 日志不是命令来源） | 契约 03 reconciliation / ActionDescriptor（已满足）；契约 02 R-02；Oracle2 D04 |
| 11 | 统一门禁投影 `resumable: boolean` + `reason` + `subject`（mcp 当前父 owner 或 local_user）与 `allowedActions`，HUD 只投影 `local_user` 入口的可行性、不复制门禁；`closed` 为 false / deferred（重开是 v1.1）；本地 resume 入口未实现时 HUD 只给诊断 | 契约 03 status / ActionDescriptor；契约 01 本地管理授权；契约 04 写者入口；Oracle2 D04 / D05 |
| 12 | Jev（阶段 C，不阻塞 cc→Codex）：`jobs.state`、`provider`、`account` 显示名、`external_key` 短形、`result_path`（answered 后）、租约 `{kind: 'browser', held, queued, holderLabel?}`——`holderLabel` 由 C4 的 lease owner / job 读取投影派生，不是账本字段、不参与互斥或释放，无可公开显示名则省略（行上只写 `browser queue`）、Flow credits（另一单位） | C4 定稿的浏览器租约契约（当前契约 02 只规定释放原则）；C5；Oracle2 D10 |
| 13 | **已满足（契约 06「Metric 与时间」）**：`spent = {tokens: Metric<TokenUsage>, costUsd: Metric<number>}`，`costUsd` 必有，无口径时 `{value: null, quality: unknown, source, asOf}`，有效零保留 `0 / reported`，不按 tokens 换算美元；树级合计按完整 SessionRef 去重，带 `knownCount / missingCount / coverage / quality`——只有同口径非负 reported 部分和才是下界（HUD 写 `≥`），混入 estimated 写 `~`，不声称下界 | 契约 06 Metric；概念 §6.4；Oracle2 D09 |
| 14 | `coverage (complete / partial / catching_up)` + `skipped` 计数；树预算外节点的 `loaded=false` 与最后状态 | 概念 §6.5 |
| 15 | 通知事件带 `seq` 与 `created_at`：报告到达、进入 uncertain、冲突 / 解决、父离线（账本事件，ledger seq 域）；`pendingReason` 变化与 `lastTurnOutcome=failed` 的观测通知带 `seqDomain` 内的 seq（观测域），两域的 seq 不互相比较，首次建立基线不补发假的完成通知 | 契约 03 tree / notices；契约 06 NoticeEvent（已满足）；Oracle2 D12 |
| 16 | 变更信号：`PRAGMA data_version` 可用，或一个 bump 文件，HUD 不按秒查表 | 契约 06（预算） |
| 17 | statusline 的廉价入口：机读状态文件的通用版（含树计数与直接子节点的标记级字段），或 ≤ 20 ms 的索引查询 | D3；契约 06 |
| 18 | **已满足（契约 03 tree / notices；契约 06 DisplayNodeIdentity / B16）**：节点身份 `{kind: session, ref} \| {kind: delegationIntent, linkId} \| {kind: job, ref}`（job 留 C），未绑定意图用稳定 linkId 显示键并挂 currentRun；≤ 200 节点、无环 / 无重复 ref、depth 明确、`handed_over` 只作历史、超预算 `loaded=false`；`freshness.state ∈ fresh \| stale \| unknown`；`run.state = failed` 投影为 `launch_failed`（non_execution，带采用的原因）；终态只用共享 `isRunTerminal`（ended / failed / cancelled；无受管 run 时 null），报告 / 图标 / `cancelling` 不算终态、不折历史 | 契约 03；契约 06；Oracle2 D11 |
| 19 | 时间一律毫秒 epoch，年龄由 HUD 用 `nowMs` 计算；`asOf`（采纳的事实边界）与 `observedAt`（观察时间）分开；ledger 的 `asOfSeq` 与观测的 `observationStamp` 分域，没有跨存储原子性或协调器 | 契约 03 / 06（已满足）；Oracle2 D12 |
| 20 | 被委派方视角：父的 harness、名、liveness、经验证的 pane label 或 null，未确认时 caller 短形只作诊断 | 契约 03 host / parent（v0.3 已满足）；契约 01 CallerId |
| 21 | **已满足（契约 03 v0.3）**：`reconciliation.cause` 枚举（至少区分 `supervisor_dead`、`scope_unknown`、`resume_ref_mismatch`、`clock_anomaly`，可再细分 `supervisor_stale` 等）和显式的 `interaction {focus, input, resume}`（未知为 false；uncertain / 未决冲突、尤其 `supervisor_dead` 三项均 false，resume 还须 `resumable=true`）；HUD 据此灰掉 Open、只留 Reconcile，不自行从心跳推断 | 契约 03 reconciliation / interaction；Oracle §4 |
| 22 | **已满足（契约 03 v0.3）**：`parentOffline` 与 `reconciliation.cause` 是独立字段；父 MCP 离线 continue 本身不禁用仍经核验可用的子交互，只有 `supervisor_dead` 这类 cause 才让 `interaction` 三项为 false | 契约 03 interaction / parentOffline；Oracle §4 |
| 23 | **已满足（契约 06「B16 的五维输入与消费者字段」/ ObservationCommit）**：`stateKey: string`、`stateSince: number \| null`、`stateSinceBasis: event \| observed \| unknown`，随 `ObservationCommit` 持久发布，`StateContinuity {ruleVersion, nodeIdentity, runId?, bindingGeneration?, sourceGeneration, episodeAnchor, …}` 保证重启后连续；`stateKey` 是语义状态加原因（approval / question / supervisor_dead / launch_failed…），不含图标、颜色或排序桶；新 run、新 episode 或语义变化才重置，报告重读 / 心跳 / usage / 折叠 / 语言 / 父换桶不重置。HUD 用它算驻留、3 秒加粗、trouble 桶内倒序；证据年龄另取 `lastEvidenceAt` / heartbeat；`clockAnomaly` 显式，不靠刷新时间掩盖；basis unknown 时时钟留空 | 契约 06 B16 / ObservationCommit；契约 03 status；Oracle2 D01 |
| 24 | **已满足（契约 06「WorkspaceContext 与项目归属」）**：`cwd`、`worktreeRoot`、`worktree?`、`gitCommonDir`、`repoId`（`identityKind = git-common-dir-v1`，`scope = local`，本机分组键而非永久项目 UUID）、`projectOrigin {repoId, basis: declared, declaredAt}`、`cwdSource / cwdAsOf / gitCapturedAt / gitMissingReason`；与逐 run 冻结的 `runs.launch_cwd / workspace_snapshot / project_origin`（契约 02 启动上下文）分开。HUD 以规范化 `worktreeRoot` 判等，根未知时只比较规范 cwd、只说目录不同，未知不当相同、同名不当同目录；`projectOrigin` 只显示为声明，不当物理同仓库；Git 解析不进 paint / statusline 热路径 | 契约 06 WorkspaceContext；契约 02 launch context；Oracle2 D02 / D03 |

## 8. 开放问题与假设

| # | 问题 / 假设 | 会改变什么 |
|---|---|---|
| 1 | 可见运行的原生退出结果通常为 null（方案甲，已裁决）。若受支持档案的 exec 直连路径在某些启动形态下提供有来源的原生结果 | 只影响 §3.3 第 4 条能否据它判 `!`；`✓` 永远只来自报告，`■ ended` 的判法不变 |
| 2 | **已关闭（Oracle2 D04 / D05）**：MVP 的 Resume / Reconcile 只显示并复制 `ActionDescriptor.displayCommand`（含 HUD_HOME、`--request-key`、`--expected-run`、`--mode`），不起控制进程；本地 resume 入口未验证时只给诊断 | 直接调用若将来加入，是另一项可选能力：显式按键、固定目标确认、可信 argv、写者重验；不改本稿的按钮与键位 |
| 3 | A2：归并器对冲突给独立标志还是给 `unknown` | 后者则 `⚠` 退化为 `? · two records`，仍需 events 里的冲突计数 |
| 4 | 手风琴的触发阈值（视口溢出 / 兄弟 > 5）与是否可关 | 用户反馈决定；设置项 `accordion` |
| 5 | 后端计数是否需要更显眼（概念的 `delegated` 模块） | 若需要，恢复为独立模块，优先级 72，放在 `agents` 之后 |
| 6 | harness 是否需要颜色 | 加 `harnessColors` 设置，默认关 |
| 7 | statusline 多行是否被 Claude Code 稳定支持 | 否则只有第一行，委派退成计数 `⧉ 2▸ 1⚑` |
| 8 | Ambiguous 宽度字符在用户终端的实际表现 | 若常见，harness 标记改用 Neutral 宽度的替代（Claude `✦`、Jev `◉`） |
| 9 | Jev credits 的单位与是否公开显示 | 影响 `12cr` 的写法 |
| 10 | "Reports: none yet" 这条空句子是否违反"不画占位"的精神 | 若裁定违反，删掉该行，节只在有报告时出现 |
| 11 | 深度 > 4 的 `↳` 平铺是否足够 | 若常见深树，加"子树聚焦"（把选中节点设为视角根） |
| 12 | 机读状态文件的通用版格式由谁定（D3 还是 B10） | 影响 §6.9 的实现顺序 |
| 13 | `■ ended`（muted、无报告）在历史里是否足够醒目，还是应当 warning | 只影响 §3.3 第 9 条的颜色；词不变 |
| 14 | `supervisor lost` 是否需要独立标记而不是 `?` + 词 | 若用户把它和 stale 混淆，给它 `⚠` 的变体或独立图标 |
| 15 | 【探索性，Argon】用 CSI 绝对列定位（`ESC [ <col> G`）锚定名字列和右侧簇起点，彻底免疫字体把某个符号画成 2 格 | 需要 frame-diff 与 `truncateAnsi` 认识定位序列；FE 评估成本可接受就做，否则维持按格计算 |
| 16 | 【探索性，Argon】两个子节点同一工作树时给一个 muted 提示（`×2 same worktree`），防止互相覆盖 | 按规范化 `worktreeRoot` 判等，未知不报；不是契约冲突，不用 `⚠` |
| 17 | 【探索性，Argon】一键重置展开状态并回到视角根 | 可能复用 `⌂` 或新键 |

## 9. 外部意见处理（Gemini Argon，2026-11-01）

意见原文：`tmp/tasks/FED-argon/opinion.md`，评的是 Oracle 对齐之前的快照。Oracle / 契约语义优先于呈现建议；需要数据层配合的点进了 §7。逐条裁决如下（【坚定建议】按原文编号顺序）。

| # | Argon 的建议 | 裁决 | 一句话理由 / 落点 |
|---|---|---|---|
| 1 | 已结案异常退出第一告警桶，不再霸占 bar 的 attention | 改编 | MVP 没有 `closed`；改为终态 `! ■` 与 `✓` 同规则 3 分钟后收进 `⊕N`、bar 不再为它们亮；`⚑ ? ⚠` 是待办，留在前面，桶内最新在上、bar 全形取最新（§3.2） |
| 2 | 折叠子树冒泡子孙计数 `+3 (1⚑ 2▸)` | 采纳 | §2、§3.4；< 40 列 `+3⚑` |
| 3 | compact 选中行升级为两行微卡 | 采纳 | §3.4；无委派行的节点仍一行 |
| 4 | 右端时钟按状态定义：驻留时长 / 证据年龄 / 结束年龄 | 采纳 | §1、§3.4；需要 `stateSince`（§7 #23） |
| 5 | `⚑` 独立颜色、`■` 60 s 后 muted | 采纳 | `⚑` 用 alert 加粗，黄色只剩"要我处理"（§5.2） |
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
