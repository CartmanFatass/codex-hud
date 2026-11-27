# HUD 调度工作流 × Matt Pocock skills：适配、必要性与整合

oracle 报告，2026-11-17。只读调研，未改任何文件，未启动其他 agent，未向 orchestrator 提问。

标记约定：**【核实】** 读源码或文档确认；**【推断】** 由已核实事实推出、未实测；**【未验证】** 需要探针才能下结论。

路径缩写：`HUD` = `~/projects/MyHUD`，`MATT` = `~/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.3.1`，`UP` = `~/codex/MySkills/_upstream/mattpocock-skills`，`PI` = `~/Fishpref/pi-roles`，`MS` = `~/codex/MySkills`，`JD` = `~/projects/JevDev`。

---

## 0. 结论

1. **不兼容是真的，但很窄。** Matt 27 个已发布 skill 里，与 HUD 分工模型冲突的只有 4 个：`implement`、`implement-spec`、`code-review`、`research`。它们的共同点是"自己执行或自己派生 agent"。其余 23 个是主会话里的对话、文档类 skill，HUD 对这一段没有任何主张，原样可用。
2. **不建议"把这套 skill 移植过来深度嵌合"。** 建议只移植一个：把 `implement-spec` 改写成 HUD 原生的主会话配方（约 60 行）。其余要么原样留在主会话，要么把其中两三条思想并进已有的 `hud-convention.md` 和 brief 写法。
3. **真正缺的不是 Matt 的文本，而是 HUD 自己的方法没有可移植化。** MyHUD 的 `docs/delegation.md` 已经把"grill → slice → build → integrate → review once → owner tries"写出来了，并且已经引用 `to-tickets`（`HUD/docs/delegation.md:13-38`）。但它是 MyHUD 的项目文档；随 HUD 发布的 `hud-convention.md` 只有 20 行派发机制。所以换到 JevDev，主会话在"想法 → brief"这一段没有任何指引。
4. **JevDev 试点目前的配置恰好是与 HUD 嵌合最差的组合**：tracker 选了 GitHub Issues，而 Project 面板只读 `.scratch/`；项目未注册，`.hud/` 能力不可用；没有 `STATE.md`，进度页为空；`AGENTS.md` 里还有一套与 HUD 生命周期相反的"编排者规范"。好消息是 `.claude/` 和 `docs/agents/` 都还没提交，改回来零成本。
5. **Claude CLI worker 加载项目插件已在本次任务里亲眼确认**：本 oracle 会话的可用 skill 列表里有 11 个 `mattpocock-skills:*`。需要在 harness 层设闸门，而不是靠提示词。
6. **先做的事**：一个 5 分钟探针（Claude worker 插件闸门）→ JevDev 改本地 tracker 加一份项目 convention → 跑一个真实 feature → 再把跑通的文本上收到 MyHUD。

---

## 1. HUD 的实际调度流程

### 1.1 端到端（均为【核实】）

| 阶段 | 实际发生的事 | 证据 |
|---|---|---|
| roster | `hud_roster` 返回角色（含当前 place、fallback、exhausted）、无效角色文件、**生效的 convention 全文及来源路径**、项目是否已注册 | `HUD/packages/hud-mcp/src/thin-main.ts:780-791` |
| convention 解析 | 四个位置第一个存在的**整文件胜出**：已注册项目的 `.hud/hud-convention.md` → `<cwd>/hud-convention.md` → `$HUD_HOME/hud-convention.md` → 随包默认；截断到 20,000 字符 | `HUD/src/roles/roster.ts:495-508` |
| brief | 主会话自己写 `task` 字符串。HUD 只在末尾追加报告路径、`hud-ask` 命令行和"只输出 `report written:`"的结尾句。没有模板，没有校验 | `thin-main.ts:950-958` |
| create | `request_key` 幂等（重试返回原 job，不重发）；必须有 `HERDR_PANE_ID`；选 place；先落盘 `job.json`/`brief.md` 再派发 | `thin-main.ts:801-808, 947-968` |
| pi 派发 | `pi-role` 默认 `-ns`（个人 skill 不进 worker）；`skills: true` 才放开；每角色 skill 走 `--skill <.hud/skills/name>`，`.hud/agents/<role>.md` 走 `--append-system-prompt`，两者都要求项目已注册 | `PI/bin/pi-role:104`；`thin-main.ts:311-353, 387` |
| cli 派发 | `herdr agent start` 只带 model、effort、权限绕过旗标和角色文件里的 `args`；然后输入一句 "Read `<instructions>` and then `<brief>`…"。instructions **只从随包目录读** | `thin-main.ts:657-665, 684, 884`；`HUD/src/roles/cli-kinds.ts:19-51` |
| watch | Claude Code：Monitor 下跑 `hud watch`。Codex：自动排队。其他主会话（含 pi）：打字提问 + `hud_read wait_ms` 轮询 | `HUD/packages/hud-mcp/hud-convention.md:12-17`；`HUD/packages/hud-mcp/README.md:102-111` |
| question | worker 调 `hud-ask` 写 `qa/qN.md`，阻塞到有答案或 20 分钟后取默认值；`hud_respond` 只写一次 | `README.md:141-149` |
| report | worker 写 `report.md`；`hud_read` 只返回未读报告；"Settled means finished, not accepted" | `HUD/integrations/skills/hud-delegate/SKILL.md:22-25` |
| 决策 | 主会话读报告、核对 diff 和检查，决定 accept / repair / review / stop。HUD 不串联下一步 | `hud-delegate/SKILL.md:27`；`HUD/docs/spec.md:12-18, 66` |
| 续接 | `hud_send`：工作中排队，idle grace 内续接；结束后 `not_continuable` | `hud-delegate/SKILL.md:55-57` |
| 留存 | job 目录在关闭**一天后**被删除，报告随之消失 | `README.md:157-159`；`HUD/packages/hud-mcp/bin/hud-watch.mjs:246` |
| Project 面板 | 读 `docs/handoff/STATE.md` 或 `STATE.md` 的 `Milestone:`、`## Now`、`## Waiting for the owner`、`## Next`、`## Slices`；读 `docs/spec.md` §5 里程碑；读 `.scratch/<slug>/issues/NN-*.md` | `HUD/src/collectors/project-board.ts:119-165, 220-256` |
| ticket ↔ job | `job.package === <feature slug>` 且 brief 文本含 ticket 文件名或编号时，把 job 挂到 ticket 上 | `project-board.ts:383, 408-418` |
| ticket 泳道 | `For you` = Status 为 `needs-triage`/`needs-info`/`ready-for-human`；`Working` = Status 为 `claimed` **或有未结束的关联 job**；`Ready`/`Blocked`/`Done` | `HUD/src/render/project-view.ts:81-82, 292-296, 355-359` |

### 1.2 长处

- **MCP 不懂任何角色和工作流**（`spec.md:12-18, 66`）。这是整合问题的关键前提：方法论是纯提示层的事，绝大部分整合不需要动 HUD 代码。
- **角色与运行位置分离**，有 fallback 和 exhausted 标记；同一个 `imp` 可以落在 pi、Claude、Codex、agy、grok。
- **worker 中立且边界一致**：所有角色提示都写了不 commit、不自启其他角色、只写报告（`HUD/packages/hud-mcp/instructions/implementer.md:14-18`；`PI/roles/implementer.md:29-35`）。
- **面板已经会说 Matt 的词汇**：本地 ticket 格式、五个 triage 标签、`claimed`/`resolved` 都已被解析和分道（见上表）。
- **`hud-convention` 经由 `hud_roster` 下发**，天然是"只到主会话、三种 harness 通用"的通道，worker 不调 roster 所以读不到。

### 1.3 缺口与摩擦

**G1. 方法只存在于 MyHUD 的项目文档里。**【核实】随包 `hud-convention.md` 共 20 行，内容是 brief 五要素、一条"一个 imp 一个端到端 slice"、评审时机和三种主会话的等待方式。从想法到 spec、切片、ticket、brief 的做法只在 `HUD/docs/delegation.md`。`hud-delegate` 的 SKILL.md 也只讲机制。新项目的主会话拿不到上游阶段的任何指引。

**G2. brief 无模板，质量全靠主会话。**【核实】`thin-main.ts:951-958` 只做字符串拼接。convention 要求的五要素（scope、out of scope、完成标准、size budget、stop rule）没有任何结构支撑。

**G3. 持久状态与 job 寿命不匹配。**【核实】报告一天后删除。MyHUD 的做法是 orchestrator 手工把 job id 和 commit 写进 ticket 的 `## Comments`（样例：`HUD/.scratch/role-bind/issues/02-place-catalog-and-writes.md`）。这条"谁写、写什么"的规则只在 MyHUD 的 `docs/agents/issue-tracker.md` 的"In this repo"段里，不是通用约定。

**G4. Project 面板只认本地文件。**【核实】`project-board.ts:1` 写明"read-only Project facts. No MCP startup, models, browser IPC or writes"，ticket 只扫 `.scratch/`。JevDev 选了 GitHub Issues（`JD/docs/agents/issue-tracker.md:1-3`），ticket 页必然为空。

**G5. 随包资产里有过期和项目特化内容。**【核实】
- `hud-handoff/SKILL.md:44-47, 56-57` 引用 `delegate_spawn`、`delegate_status`、`delegate_wait`、`hud run status`，这些属于 M2 已删除的执行栈（`spec.md:92`）；第 15 行引用的"`hud-delegate` §8"不存在。安装器也不安装它（`HUD/install.d/claude.sh:64` 只链接 `hud-delegate` 和 `hud-setup`）。
- `hud-delegate/roles/implementer.md` 和 `reviewer.md` 引用 `delegate_whoami`、`delegate_report`，同样过期。
- 随包 `instructions/reviewer.md:9, 26, 28` 写死了 `docs/spec.md` 和"`docs/delegation.md` step 5"。这是 MyHUD 的路径，JevDev 没有这两个文件。

**G6. 每角色定制只对 pi 生效。**【核实】cli 和 bro place 写 `skills` 即判无效（`roster.ts:147-148`）；CLI instructions 只读随包目录（`thin-main.ts:884`）。所以 Claude CLI 角色（`frontend-imp`、`oracle`）没有项目级 worker 提示，也没有 skill 选择。它们能读到的只有 brief、仓库的 `AGENTS.md`/`CLAUDE.md`，以及 CLI 自己加载的东西，包括插件。这就是"Claude worker 加载项目插件"问题的结构性来源。

**G7. convention 是整文件替换。**【核实】`roster.ts:503-506`。项目一旦写自己的 convention，就同时接管了随 HUD 版本变化的机制描述（例如 0.1.4 改过的 watch 行为）。项目方法与 HUD 机制耦合在一个文件里。

**G8. JevDev 里并存三套编排约定。**【核实】
- `JD/AGENTS.md:8` 指向 `delegation` skill，而 `MS/README.md:60` 写明"`teaming` 已替代旧 `delegation`，旧入口已撤下"。指针过期。
- `JD/AGENTS.md:16-19` 要求编排者自己 `/quit`、关 Herdr 标签页、核对 `herdr agent list`。HUD 的规定正相反："The main session never manages workers"（`spec.md:17-18`）。
- 所有 worker 都被要求遵循仓库的 `AGENTS.md`（`HUD/packages/hud-mcp/instructions/implementer.md:9`），所以这些"编排者规范"每个 worker 都会读到。

**G9. 实际使用情况与设计预期有距离。**【核实，样本为 `~/.hud/jobs` 现存 69 个 job】
- `package` 基本不填；填的时候是自由文本（"guzheng visual QA r5 final"、"matt-hud"），不是 feature slug。
- 没有任何 job 带 `role_skills`；两个已注册项目（bilingual、rush）的 `links`/`role_files`/`agents` 均为空。0.1.2 的每角色 skill 机制尚未被实际使用过。
- `~/.claude/skills` 和 `~/.codex/skills` 里只有 `hud-delegate`，没有 `hud-setup`，尽管安装器声明会链接两者。
- 一个会话在约一小时内派了十多个 reviewer（r2…r5 final）。这是另一个项目的视觉 QA，可能是有意为之；仅作为"评审在实践中是迭代的"这一观察记录，不做结论。

**G10. ticket 编号匹配偏宽。**【推断，由正则推出】`project-board.ts:412` 用 `(^|[^\w])NN(?![\w])` 在 brief 里找编号。brief 里出现 `11-02` 这样的日期会命中 02 号 ticket。影响限于同一 package 内挂错 job 标记，不严重；brief 写 ticket 文件名即可避开。

---

## 2. Matt 的每个 skill

### 2.1 三条结构性差异

逐个判断之前，先说为什么冲突集中在少数几个 skill 上。

**差异一：谁执行。** Matt 的模型是一个人加一个 agent 会话，这个会话自己走完一个阶段，自己实现、自己评审、自己 commit，AFK 的活交给**原生 subagent**（`MATT/skills/engineering/ask-matt/PHASE-BOUNDARIES.md:36` 的第 4 问）。HUD 的模型是主会话只决策，执行者在独立标签页里，跨 harness、跨模型，不 commit、不自启角色。HUD 的 job 正好是 Matt 五个 phase-boundary 选项里"Subagent"那一项的跨 harness 推广。

**差异二：人在哪。** Matt 的许多 skill 在运行它的会话里有人工检查点：`grilling` 整体如此；`tdd` 要求"confirm them with the user. No test is written at an unconfirmed seam"（`tdd/SKILL.md:22`）；`to-tickets` 要 quiz 用户（`to-tickets/SKILL.md:42-56`）。HUD worker"never talk to an end user"。所以含人工检查点的 skill 只能在主会话跑，或者要把"用户"重定向为 brief 和 `hud-ask`。

**差异三：谁能触发。** Matt 把 skill 分成 user-invoked 和 model-invoked，并规定前者不能被任何其他 skill 或模型调用（`MATT/.agents/invocation.md`）。对 worker 而言没有"用户"，所以 user-invoked skill 在结构上就是主会话专属。会泄漏到 worker 的只有 model-invoked 那一组。

Matt 自己的立场也指向同一个方向：
- `MATT/SCOPE.md:10`：配置项、harness 特化分支、"a tweak to suit one person's workflow"不进上游，"belong in your own `CLAUDE.md` / `AGENTS.md`, or in a fork"。
- `MATT/.out-of-scope/subagent-recursion.md:7`："The harness should be responsible for stopping infinite subagent loops, not skills."

也就是说，上游明确期待 harness（这里是 HUD）来划定 subagent 能碰什么。

### 2.2 逐个判断

"判断"列四选一：**原样** / **改写** / **并入** / **舍弃**。"必要性"是对 Jacob 当前工作方式而言。

| skill | 真正提供的价值 | 与已有能力的关系 | 判断 | 必要性与理由 |
|---|---|---|---|---|
| `grilling`、`grill-me`、`grill-with-docs` | 动手前与人对齐；按"frontier"成轮提问，每问附推荐答案 | 互补。`delegation.md:13` 的"Grill"只有名字没有方法；teaming 的 Oracle 澄清是 agent 先调查再把待决问题上交（`MS/teaming/references/workflow.md` 的"澄清与计划调整"），方向不同 | **原样**，仅主会话 | 高。全套里价值最大、HUD 完全没有对应物的一块。`grilling/SKILL.md:28` 让它派 sub-agent 查事实：主会话里用原生只读 subagent 或派 `sonic` 都可以，无害 |
| `domain-modeling` | 就地维护 `GLOSSARY.md` 和 ADR | 互补。HUD 无对应 | **原样**，仅主会话 | 中。它会写文件，所以不能出现在只读 worker 里（见 3.4） |
| `to-spec` | 把对话综合成 spec；先和用户确认测试 seam（`to-spec/SKILL.md:15-17`） | 与 MyHUD 的 `docs/spec.md` + `.scratch/<feature>/spec.md` 分层一致（`HUD/docs/agents/issue-tracker.md` "In this repo"段） | **原样**，仅主会话 | 中高。模板要求"extremely extensive"的用户故事列表（`to-spec/SKILL.md:33-41`），与 Jacob 的 size budget 文化有品味冲突；用项目文档的一句话压住即可，不必改 skill |
| `to-tickets` | tracer-bullet 纵切片；每个 ticket 声明 blocking edges | **已被 HUD 采用**：`delegation.md:18-19` 指名使用；面板解析的正是它的本地模板（`to-tickets/SKILL.md:69-82` 对 `project-board.ts:127-131`） | **原样**，仅主会话 | 有条件。`delegation.md:17-21` 已规定：只有需要多个 implementer 会话时才拆 ticket |
| `implement` | 5 条指令：取 ticket、在约定 seam 上 tdd、最后跑全量、调 code-review、commit | **冲突**，逐条都撞：commit（`implement/SKILL.md:17`）对 worker 的禁 commit；调 `code-review`（第 15 行）会派生 2 个 subagent；全量测试对 `hud-convention.md:8` 的"no full suites unless requested"。在主会话跑则让 orchestrator 变成实现者 | **舍弃** | 不需要。它的位置由 `hud-delegate` + `imp` + 一份指向 ticket 的 brief 取代。可保留的两点（取 ticket 并复述标题、seam 预先约定）写进 brief 模板 |
| `implement-spec` | 编排配方：把 ticket 当任务图，沿 frontier 并发派实现者，每人一个 worktree，落到一条 integration branch，最后一次 code-review，一个实现者一次修完 | **高度同构**于 `delegation.md:22-37`（每 slice 一个新 imp、每个 imp 一个 worktree、orchestrator 集成、里程碑评审一次、一个新 imp 一次修完）。冲突在执行器：原生 subagent、实现者自己 merge、merger subagent | **改写**为 HUD 原生主会话 skill | 高。这是唯一值得移植的：它本身就是编排配方，而它假设的执行器正是 HUD 要替换的东西。它的"context pointers"纪律（`implement-spec/SKILL.md:15`）恰好是好 brief 的写法 |
| `code-review` | 两轴分离（Standards / Spec）；先钉住 fixed point 并确认 diff 非空；按顺序找 spec 来源 | **重叠且哲学不同**。HUD reviewer 已要求两轴，但第二轴是"simplicity and quality：能删什么"（`instructions/reviewer.md:26-31`）；Matt 的 Standards 轴带 12 条 Fowler 异味基线，产出的是判断性建议。机制上它派 2 个原生 subagent，绕过了 HUD"两个不同模型家族的 reviewer"（`delegation.md:26-27`） | **并入** reviewer brief 的写法；skill 本身在 HUD 项目里不用 | 低。取三点：dispatch 前钉 fixed point 并确认 diff 非空；spec 来源的查找顺序；异味基线最多作为**不影响结论的可选清单**。不要把它变成阻塞项，否则与 2026-11-10 的决定相悖（`delegation.md:3-6`：旧规则"kept adding guards and tests"） |
| `research` | 一手来源、逐条引用、结果落成仓库里的一个 md | 重叠：就是派一个 `general`/`sonic`/`oracle`/`pro` job。它的指令是"Spin up a background agent"（`research/SKILL.md:6`） | **并入** `hud-delegate` 的一条说明 | 低。三条规则写进 brief 即可。注意：本次任务就是 research 形状的，而本会话的 skill 列表里有它（见 3.4） |
| `tdd` | 好测试的定义、seam、反模式清单、red→green 规则 | 互补且与 Jacob 的立场一致："You can't test everything"、只在约定 seam 测（`tdd/SKILL.md:22`）对应 `delegation.md:49-51` 的"只测 owner 会注意到的行为" | **原样**，作为 `imp` 的每角色 skill；另加一句 worker 提示把"用户"重定向 | 可选。seam 在主会话的 `to-spec` 阶段已和人确认，写进 ticket 或 brief；`PI/roles/implementer.md` 已有同构规定（实现 orchestrator 给的测试计划，偏离则 `ask_orchestrator`）。先在一个项目上试，看 diff 再定 |
| `diagnosing-bugs` | 先造一个能对这个 bug 变红的紧反馈回路，再谈假设 | 互补。人工检查点是软的："Don't block on it; proceed with your ranking if the user is AFK"（`diagnosing-bugs/SKILL.md:98`） | **原样**，主会话可用，也适合作 `imp` 的每角色 skill | 中。全套里最适合 AFK worker 的一个。注意 sonic 不做诊断（`PI/roles/sonic.md`），所以只给 `imp` |
| `prototype` | 用一次性代码回答一个设计问题；逻辑类和 UI 类两种产物 | 互补。与 `frontend-imp` 契合 | **原样**。主会话调用；构建可交给 `frontend-imp`，brief 里引用 `LOGIC.md`/`UI.md` 的路径 | 中。它要求把原型 commit 到一次性分支，这一步由 orchestrator 做 |
| `wayfinder` | 给"一个会话装不下"的大而模糊的事画决策地图；ticket 分 research(AFK) / prototype / grilling(HITL) / task | 互补。research 类 ticket 正好是 HUD job | **原样**，仅主会话；项目 tracker 文档里补一句格式约定 | 低频。【推断】本地 tracker 下，wayfinder ticket 按 `issue-tracker-local.md:21-30` 用的是不加粗的 `Status:`/`Blocked by:` 和 `## Question` 正文，而面板要求 `# NN: 标题` 加粗体字段（`project-board.ts:127-131`），所以决策 ticket 在面板上不可见 |
| `triage` | 给**不是自己建的** issue 走状态机；附带 AGENT-BRIEF 写法 | 面板已识别这套标签（`project-view.ts:292`） | **原样**（休眠）；`AGENT-BRIEF.md` 的原则**并入** brief 模板 | 低。`ask-matt/SKILL.md:48`："Triage is only for issues you didn't create"。单人项目基本用不上 |
| `retro` | 会话后改进 agent 的**环境**而非代码；"评审者负责执行编码标准，实现者不负责"（`retro/SKILL.md:29-35`） | 互补，且与 HUD 的实现/评审分工同向 | **原样**，仅主会话 | 中高。Jacob 的"环境"就是 convention、角色提示和 skill，retro 的产出正好喂给它们。注意要在 job 目录被删前跑 |
| `handoff` | 把对话压成给下一个会话的文档，存到系统临时目录，列出建议 skill | 与 `hud-handoff` 重叠，后者已过期（G5） | Matt 的**原样**；`hud-handoff` **舍弃或重写** | 中。若重写，只需在 Matt 的基础上加一段"未结束的 HUD job：id、状态、报告路径"，并注明一天留存 |
| `ask-matt` | 路由：哪种情况用哪个 skill | **冲突**：第 3 步把构建路由到 `implement`/`implement-spec`（`ask-matt/SKILL.md:24-28`） | 路由**并入** HUD convention；`PHASE-BOUNDARIES.md` 作参考保留 | 低。HUD 项目里它会给出错误的构建建议 |
| `setup-matt-pocock-skills` | 每仓库一次：tracker、标签、领域文档布局 | 与 `hud-setup` 平行（都是每项目问答式配置），不冲突 | **原样** | 已在 JevDev 跑过。HUD 项目应选本地 tracker（见 3.2） |
| `codebase-design`、`improve-codebase-architecture` | 深模块词汇；定期体检 | 与 `architect` 角色互补（一个是词汇，一个是执行者） | **原样** | 可选。`codebase-design` 可作为 `architect`/`imp` 的每角色 skill；`tdd` 会引用它 |
| `pr`、`wizard`、`to-questionnaire`、`wait-what`、`teach`、`writing-for-agents` | 各自独立的小工具 | 正交 | **原样** | `writing-for-agents` 值得在做这次适配时用：它的"context pointer"和"两种负载"正是写 brief、convention、角色提示要用的判断标准 |

未随插件发布、但相关的上游 skill：

| skill | 观察 | 判断 |
|---|---|---|
| `chief-of-staff`（in-progress） | "All work should be done in subagents. Protect your context window."（`MATT/skills/in-progress/chief-of-staff/SKILL.md`）。这就是 HUD 主会话的姿态 | 不采用，留意 |
| `software-factory`（in-progress，仅 `UP` 1.3.2 有） | 一套"软件工厂"词汇：Task / Run / Runner / Orchestrator / Ticket tracker，Run"never waits for a human"，Runner 在远端。按这套词汇，HUD = 本地的 Orchestrator + Runner + Observability，HUD 的 job = 它的 Run | 不采用。它说明上游正在长出自己的编排模型，方向是远程、事件触发（见第 5 节第 9 条） |
| `claude-handoff`（in-progress） | `claude --bg` 起后台 agent | HUD 的等价物是 `hud_create general` |
| `misc/git-guardrails-claude-code` | 用 hook 拦危险 git 命令 | 仅作想法：HUD worker 的"不 commit"目前纯靠提示词，而 Claude worker 带 `--dangerously-skip-permissions` 启动（`cli-kinds.ts:38`） |

### 2.3 与 teaming / workflow-design 的关系

- **teaming**（`MS/teaming/SKILL.md`）是 Codex **原生 subagent** 的编排（`agent_type` 选角色），Oracle 先出"完整实施计划"再分工作包。它与 HUD 是两套执行底座，与 Matt 的 `to-spec` + `to-tickets` 在功能上重叠：Oracle 的计划 ≈ spec + tickets，区别在于 teaming 由 agent 调研后上交待决问题，Matt 由 agent 逐轮盘问人。对 Codex 主会话来说，现在有两套委派栈并存，JevDev 没有说明默认用哪套。
- **workflow-design**（`MS/workflow-design/SKILL.md`）给的判据正好可以直接用于本问题："每条拟写指令都应能回答：谁会读到它，谁执行其中的动作"。它的文件边界表里没有 HUD 的三个位置（convention、`instructions/`、`.hud/agents`），这是它自己的一个缺口。第 3 节按它的判据来放置。

---

## 3. 如果整合，落在哪一层

### 3.1 分层

原则取自 workflow-design：指令放在执行者实际读得到的地方；属于同一工作流不构成放在同一文件的理由。

| 层 | 谁读 | 放什么 | 不放什么 |
|---|---|---|---|
| Matt 插件 / 上游 skill | 主会话（Claude 插件、Codex 插件、pi 软链） | 上游阶段：grilling、domain-modeling、to-spec、to-tickets、wayfinder、retro 等，**原样** | 任何 HUD 特化改动 |
| HUD 主会话 skill（`HUD/integrations/skills/`，安装器已链接到三种客户端） | 主会话 | 新增一个配方 skill（暂称 `hud-build`）：把一组 ticket 通过 HUD 角色跑完；附 brief 模板 | 上游阶段的方法；worker 的执行方式 |
| `hud-convention.md`（随包默认 + 项目副本） | 主会话，经 `hud_roster` 下发，三种 harness 通用 | 流程路由（何时 grill、何时拆 ticket、构建走哪个角色、何时评审）；ticket ↔ job 的链接规则；ticket 的唯一写入者；"此处 `implement`/`implement-spec`/`code-review`/`research` 由 HUD 角色取代" | worker 规则；长篇方法 |
| 项目 `AGENTS.md` | **所有人，包括每个 worker** | 指针和每个读者都需要的规则：tracker 位置、领域文档、验证命令。`## Agent skills` 段属于这一类，保留 | 编排者专属规范（`JD/AGENTS.md:5-20` 的"委派与等待"和"会话生命周期"应移到 convention） |
| worker 角色提示（`PI/roles/*.md`、`HUD/packages/hud-mcp/instructions/*.md`） | 该角色 | 保持方法论中立。只做两处修补：CLI instructions 补上 pi 已有的那句"为其他 harness 写的 slash 命令和工作流不适用于你"（`PI/roles/implementer.md:20`）；`reviewer.md` 去掉写死的 MyHUD 路径 | Matt 特化内容 |
| `hud setup` 每角色 skill（仅 pi） | 该 pi 角色 | `tdd`、`diagnosing-bugs`、`codebase-design` 给 `imp`；`.hud/agents/imp.md` 里三行：skill 里的"用户"指 brief；seam 以 brief 为准，brief 没定的才 `ask_orchestrator`；不派生 agent | 含人工检查点或会派生 agent 的 skill（grilling、research、code-review） |
| HUD 代码 | — | 推荐方案里**不需要**。可选的小改见 4.1 | ticket 生命周期、tracker 适配、角色串联（`spec.md:66` 明确排除） |

关于新 skill 是并进 `hud-delegate` 还是独立：建议独立。`hud-delegate` 的 description 是常驻上下文，应保持只讲派发机制；"跑完一组 ticket"有自己明确的触发词，符合 `writing-for-agents/SKILL-MECHANICS.md` 的拆分条件。

### 3.2 ticket / spec / 状态在 HUD 中的流转

**tracker 选型：HUD 项目用本地 markdown。** 理由：
1. 面板只读 `.scratch/`（G4）。
2. worker 在 worktree 里直接读文件，不需要 `gh`、网络和凭据；角色提示本来就禁止"network collection"。
3. blocking edges 是文本，主会话算 frontier 不需要 API。

GitHub Issues 只在有外部报告者时才有必要。不建议做"GitHub ↔ 本地"镜像；二选一。

**流转（主会话是 ticket 和 STATE 的唯一写入者）：**

```
grill（主会话，Matt 原样）
  → to-spec        → .scratch/<slug>/spec.md
  → to-tickets     → .scratch/<slug>/issues/NN-*.md   Status: ready-for-agent
                                                      面板：Ready / Blocked
主会话取 frontier（blocker 全部 done 的 ticket）
  → hud_create(role=imp, package=<slug>, cwd=<worktree>,
               task = 指向 ticket 文件的 brief + budget + stop rule + 检查命令)
                                                      面板：Working（有活 job 即进入，
                                                      不必先改 Status）
  → report → 主会话核对 diff 与验收项
      通过   → 勾选 checkbox，Status: resolved，
               ## Comments 追加一行（job id、commit）    面板：Done
      要人   → Status: needs-info 或 ready-for-human，
               ## Comments 写原因                        面板：For you
全部 ticket 完成
  → 两个不同模型家族的 reviewer，对整个里程碑 diff
  → 一个新 imp 一次修完 → owner 试用
```

几条需要写进 convention 的规则：
- **`package` 必须等于 feature slug，brief 必须写 ticket 文件名。** 这是面板挂接的唯一依据（`project-board.ts:383, 412`）。现状是 package 多为自由文本（G9）。
- **worker 不改 ticket。** worker 在 worktree 里改 ticket 文件会和主 checkout 的版本分叉。worker 对照验收项写报告，主会话勾选。
- **ticket 是持久的，brief 是一次性的。** Matt 的 AGENT-BRIEF 要求"Don't reference file paths"（`triage/AGENT-BRIEF.md:14-17`），而 HUD 的 brief 习惯点名文件。两者不矛盾：ticket 不写路径；brief 是派发时的包装，指向 ticket，再补路径、budget、stop rule 和检查命令。
- **报告不是记录。** job 目录一天后删除，所以要留的结论必须进 ticket 的 `## Comments` 或 `docs/reviews/`。
- **`ready-for-human` 可以承接 JevDev 的 Windows 桌面验收。** `JD/AGENTS.md:3` 区分了 API 契约验证、真实模型调用和 Windows 桌面运行验收；需要人在 Windows 上做的验收项标成 `ready-for-human`，自然落进 For you 泳道。

**STATE.md**：面板的进度页需要 `STATE.md` 或 `docs/handoff/STATE.md`，带 `Milestone:`、`## Now`、`## Slices` 等（`project-board.ts:220-250`）。JevDev 没有。`hud setup` 只写 `.hud/`，不生成这个文件。要么在 convention 里约定维护它，要么接受进度页为空；这是 owner 的选择。

### 3.3 同时服务 Claude、Codex、pi 三种主会话

| 事项 | 现状 | 建议 |
|---|---|---|
| HUD 方法的单一来源 | `integrations/skills/` 由安装器链接到三种客户端（`HUD/install.d/claude.sh:64`、`codex.sh:58-59`、`pi.sh:45-46`）；convention 经 `hud_roster` 下发 | 新配方 skill 放 `integrations/skills/`；路由放 convention。两条通道都已是三端通用 |
| Matt skill 的启用范围 | **三端不一致**【核实】：Claude 是全局关、JevDev 项目开（`~/.claude/settings.json:54`；`JD/.claude/settings.json`）；Codex 是**全局开**（`~/.codex/config.toml:779-780`）；pi 是 `~/.pi/agent/skills` 下 27 个全局软链 | Codex 改为全局关、项目开，写法同 `MS/README.md` 里 research-tools 的做法。pi 是否有项目级开关【未验证】 |
| Matt skill 的版本 | **三端不一致**【核实】：Claude 插件缓存 1.3.1；Codex marketplace 和 pi 软链指向的 clone 是 1.3.2（`UP` HEAD `5863806`，2026-11-12） | 见 4.4 |
| skill 互调写法 | Matt 用"Call the Skill tool with …"。pi 是否有同名工具【未验证】 | 新配方 skill 用中性写法："读 `<skill>` 并按其执行" |
| 提问方式 | `grilling` 用纯文本成轮提问，上游明确拒绝绑定原生提问工具（`MATT/SCOPE.md` 列出的 `native-question-tool.md`） | 无需处理，三端都能用 |
| 等待方式 | Claude 用 Monitor，Codex 自动排队，pi 轮询 | 已在 convention 里；pi 主会话是最弱的一端，属 HUD 自身议题 |

### 3.4 Claude CLI worker 会加载项目级插件

**事实【核实，本会话即证据】**：本 oracle 以 `cli:claude` 运行，cwd 是 JevDev。可用 skill 列表里有 11 个 `mattpocock-skills:*`：`diagnosing-bugs`、`tdd`、`prototype`、`research`、`domain-modeling`、`codebase-design`、`code-review`、`pr`、`wizard`、`grilling`、`writing-for-agents`。这正好是全部 model-invoked 的那一组；user-invoked 的（`implement`、`to-tickets` 等）不在模型可见列表里。同时可见的还有 `hud-delegate`、Agent 工具和 Workflow 工具，也就是说"不自启其他角色"在 Claude worker 上目前纯靠提示词。

**风险排序：**
1. `code-review`：派生 2 个 subagent；"review"一类措辞即可触发。
2. `research`：派生后台 agent。本次 brief 就是调研形状。
3. `grilling`：向不存在的用户提问，worker 会停住直到 quiet 判定。
4. `domain-modeling`：写 `GLOSSARY.md` 和 ADR，破坏 oracle/reviewer 的只读边界。
5. `tdd`、`diagnosing-bugs`、`prototype`、`codebase-design`：无害，对 `frontend-imp` 甚至有用。

**同样的问题在主会话里也存在**：`hud-delegate` 的 description 以"review 一下"、"起个 reviewer"为触发词（`hud-delegate/SKILL.md:3`），Matt 的 `code-review` 以"wants to review a branch, a PR, work-in-progress changes"为触发词。两者同时加载时，由哪个接住"review 一下"取决于模型的临场选择。

**处理选项：**

| 选项 | 做法 | 评价 |
|---|---|---|
| A. 提示词 | CLI instructions 加一句：不调用会派生 agent 或面向用户的 skill | 最便宜，但只是请求。上游自己的立场是这类限制应由 harness 做 |
| B. 角色 `args` 关插件 | 在 `~/.hud/roles/oracle.json`、`frontend-imp.json` 的 claude place 上加 `"args": ["--settings", "{\"enabledPlugins\":{\"mattpocock-skills@claude-plugins-official\":false}}"]` | harness 层、按角色、零 HUD 代码；`args` 是原样追加的（`thin-main.ts:664`）。**【未验证】`--settings` 是否压过项目 `.claude/settings.json` 的 `enabledPlugins`** |
| C. `--disable-slash-commands` | 同样放进 `args`；`claude --help` 的说明是"Disable all skills and commands" | 彻底。适合 oracle。对 `frontend-imp` 会连 `frontend-design` 一起关掉，可能不是想要的 |
| D. 项目级 deny | 在 `JD/.claude/settings.json` 的 `permissions.deny` 里拒绝 `code-review` 和 `research` 两个 skill | 一处同时解决主会话的触发冲突和 worker 的泄漏。**【未验证】Skill 的 deny 规则写法，以及它在 `--dangerously-skip-permissions` 下是否仍生效** |

**建议**：B 加 A。先做一个 5 分钟探针：带上述 `args` 起一个 Claude，在 JevDev 里看 skill 列表。若 D 的写法验证可行，D 更干净，因为它顺手解决主会话的冲突。

需要注意的一点：`README.md:79-81` 说 HUD"never passes a … settings flag"。这句话描述的是 HUD 自己追加的参数；`args` 是 owner 在角色文件里写的。按字面不冲突，但它确实触到了"HUD 不改 CLI 自身行为"的精神，由 owner 定。

**Codex worker 的同类问题**：Matt 插件在 Codex 侧是全局开启的，所以任何 `cli:codex` place 的 worker 都会带上那组可隐式调用的 skill。目前 Jacob 的角色默认不落在 codex 上，属潜在问题。把 Codex 改成项目级启用后，问题形态就和 Claude 一样了；用 `args` 传 `-c` 覆盖是否可行【未验证】。

**pi worker** 默认安全：`-ns` 排除了个人 skill（`PI/bin/pi-role:104`）。风险在于有人顺手传 `skills: true`，那会把 27 个全放进去，包括 grilling 和 research。每角色 skill 应只走 `hud setup` 的具名链接。

---

## 4. 是否值得做，先做什么

### 4.1 推荐方案：薄适配（先项目，后上收）

**判断：值得做，但目标是"让 HUD 自己的方法可移植"，Matt 的 skill 只是其中上游阶段的现成零件。**

**第 0 步：探针和清障（不产生新功能）**
1. 探针：Claude worker 插件闸门（3.4 的 B 或 D）。
2. JevDev 决定 tracker。建议本地。`JD/.claude/` 和 `JD/docs/agents/` 当前都是未跟踪文件，`AGENTS.md` 的改动也未提交，现在改没有历史包袱。
3. `JD/AGENTS.md:5-20` 的 delegation 块：指针已过期且与 HUD 生命周期相反。保留、改写还是移走，由 owner 定。

**第 1 步：在 JevDev 用纯项目文档跑通一次**
1. 项目根放一份 `hud-convention.md`（未注册项目也会被读到，`roster.ts:499`），内容为随包默认全文加 8 到 10 行路由和 3.2 的几条规则。
2. Matt 插件只在主会话用于 grill、to-spec、to-tickets。
3. 选一个真实 feature 从头走到 owner 试用。记录三件事：worker 提问次数、修复轮数、ticket 页是否始终与实际一致。

**第 2 步：把跑通的文本上收到 MyHUD（一个 imp slice，几乎全是文档和提示）**
1. 随包 `hud-convention.md` 增加流程路由段。
2. 新增 `integrations/skills/hud-build/SKILL.md`：`implement-spec` 的 HUD 版，含 brief 模板（合并 AGENT-BRIEF 的四条原则与 convention 的五要素）。头部一行注明出处"改写自 implement-spec @1.3.1"。
3. `instructions/*.md` 补一句；`reviewer.md` 把写死的路径改成"brief 指明的 spec"。
4. 删除或重写 `hud-handoff`；删除 `hud-delegate/roles/` 下两个过期文件。

**第 3 步：按第 1 步的数据决定**是否给 `imp` 配 `tdd`/`diagnosing-bugs` 每角色 skill。

**可选的小代码改动，均非必需：**
- ticket 编号匹配收紧为只认文件名（G10）。
- convention 分层：`hud_roster` 同时返回随包机制和项目附加段，解决 G7。这改变了 `spec.md:14` "replaces it whole"的规定，需 owner 决定。

### 4.2 更小的备选：只做第 0、1 步

不动 MyHUD。JevDev 靠一份项目 convention 和主会话里的 Matt 插件运转。

**能得到什么**：主会话的上游阶段有方法；ticket 进面板；worker 不被插件干扰。因为 convention 经 `hud_roster` 下发，这个方案对 Claude、Codex、pi 三种主会话已经同时有效。

**代价**：
- 方法只在 JevDev，下个项目要再抄一遍。
- ticket 图的循环（取 frontier、派发、集成、更新状态）没有成文配方，主会话每次从几行散文里推导，结果会有波动。
- 项目 convention 整文件替换了随包默认（G7），HUD 升级后机制描述会漂移，需要手工同步。
- 过期的 `hud-handoff` 和写死路径的 `reviewer.md` 继续存在。

这个备选是推荐方案的前半段，不是另一条路。如果第 1 步跑下来主会话并不需要成文配方，就停在这里。

### 4.3 更大的方案：为什么不取

即"把整套 fork 进 MySkills 做 `hud-*` 变体，并在 HUD 代码里做 ticket 生命周期（`hud_create` 带 ticket 参数、自动改状态、GitHub 读取器）"。

- 与 spec 直接相悖：`spec.md:12-18` "The MCP knows no particular role and no workflow"，`spec.md:66` "No workflow engine and no automatic role chaining"。
- 被 fork 的大多数 skill 本来就不冲突，fork 只带来合并负担。
- 上游变动快（4.4），而且正朝自己的编排模型走。
- 三种 harness 各要验证一遍。

### 4.4 上游更新时的维护方式

**先看上游变动的实际节奏【核实】**：1.3.0 一次新增 3 个 skill、删除 1 个、并把 `CONTEXT.md` 约定在 11 个 skill 里改名为 `GLOSSARY.md`（`MATT/CHANGELOG.md` 1.3.0 段）。1.3.2 又改了 `implement-spec`、`code-review`、`research`、`wayfinder`、setup 模板等十余个文件（`diff -rq` 结果）。本机现在就有版本偏差：Claude 1.3.1，Codex 和 pi 1.3.2。

**按三类区别对待：**

1. **原样使用的 skill**：不 fork，不跟踪内容，走上游渠道。只需把更新变成有意的动作：
   - Codex 插件"updates itself at startup"（`MATT/README.md:50`），而且是全局开启、可隐式调用。这意味着第三方提示内容会自动进入每个 Codex 会话，包括带 `--dangerously-bypass-approvals-and-sandbox` 的 worker。相对 `spec.md:77-78` 的威胁模型，这值得钉住版本或改为项目级启用。
   - pi 软链指向 clone，`git pull` 即更新，本身就是有意的动作。

2. **HUD 依赖的契约面**：真正的耦合只有三处，都很小：
   - 本地 ticket 模板的字段：`# NN: 标题`、`**Blocked by:**`、`**Status:**`、checkbox（`to-tickets/SKILL.md:69-82`）。
   - 标签字符串：五个 triage 标签加 `claimed`、`resolved`（`project-view.ts:292, 330`）。
   - 路径约定：`.scratch/<slug>/issues/NN-*.md`（`issue-tracker-local.md`）。

   维护办法：每次 `git pull` 后只看这三处有没有变。可以在 MyHUD 加一条测试，拿上游 `<local-ticket-template>` 的形状喂给 `project-board` 的解析器。这是唯一建议的"上游金丝雀"。

3. **改写的那一个（`hud-build`）**：归自己所有，不跟踪上游。这与既有决定一致："No tracking of upstream for ported parts … they are ours and change only for our needs (owner, 2026-11-10)"（`spec.md:71-72`）。只留一行出处，方便将来想看时找得到。

4. **每角色 skill 的链接**：`hud setup` 把 `.hud/skills/<name>` 链到 skill 的真实路径（`HUD/src/cli/setup.ts` 的 `realDir`）。对 pi 软链来说就是 `UP` 下的绝对路径。所以 `git pull` 会静默改变 worker 行为。`.hud/` 按设计是要提交的，提交的是指向本机绝对路径的软链；单机使用符合 `spec.md:8`，但应知情。

---

## 5. 没问到但应该考虑的问题

1. **"用户"对 worker 意味着什么。** 这是整套适配的那条总翻译规则。建议定死一句：含人工检查点的 skill 不进 worker；worker 手里的 skill 里凡是说"用户"，一律指 brief，brief 没说的才走 `hud-ask`。

2. **评审哲学冲突比机制冲突更重要。** Matt 的 Standards 轴加异味基线会稳定产出"可以更好"的判断性发现。Jacob 在 2026-11-10 刚从"每包评审、最多三轮"退回到"里程碑评审一次、只有真实用户会碰到才阻塞"，原因就是前者不断加 guard 和测试（`delegation.md:3-6, 36-37`）。原样引入 `code-review` 等于把刚拆掉的东西装回来。

3. **这套流程对 Jacob 的实际工作量是否过重。** 现存 69 个 job 绝大多数是临时杂务、基准跑分和单点评审，没有 package。`delegation.md:17-21` 自己也规定小事不拆 ticket。所以整合应当是"按需启用的重流程"，默认仍是一句话加五要素的 brief。把它做成默认路径会增加日常摩擦。

4. **如何判断整合有没有用。** 动手前先定观察指标：每个 slice 的修复轮数、worker 提问数、owner 试用时发现的问题数。`PI/bin/` 下已有 `pi-runs-report`、`pi-run-rate` 等统计工具，可能可以直接用。没有指标，就无法区分"流程更好了"和"流程更多了"。

5. **JevDev 到底用哪套编排。** `AGENTS.md` 的 delegation 块（手工管理 Herdr 里的 Codex 会话）、HUD、teaming（Codex 原生 subagent）和 Matt（原生 subagent）四者并存。需要一句话的决定：这个项目的 worker 由谁启动、由谁关闭。

6. **Oracle 计划与 ticket 是同一种东西的两种写法。** teaming 的 Oracle 产出"工作包 + 依赖 + 并行上限"，Matt 的 `to-tickets` 产出"切片 + blocking edges"。如果希望面板看得见，就规定：不管谁来拆，产物都落成 `.scratch/<slug>/issues/` 的 ticket 格式。

7. **worktree 下的单一写入者。** ticket 和 STATE 在主 checkout，worker 在 worktree。不规定"只有主会话写 ticket"，并行 imp 就会制造无意义的合并冲突。

8. **什么该从一天后消失的报告里抢救出来。** 现在靠 orchestrator 自觉往 ticket 的 Comments 里抄。retro 也依赖这些材料。值得有一条明确规则。

9. **上游的方向与 HUD 的方向。** `software-factory` 描述的是远程 runner、事件触发、以 ticket tracker 为人机界面、run 从不等人。HUD 是本地、交互式、主会话决策。如果 Jacob 将来想要 AFK 工厂，GitHub Issues 作 tracker 就有道理，面板需要一个 GitHub 读取器；如果要保持本地交互，本地 tracker 是对的，并且与上游的距离会越来越大。这是一个现在就影响 tracker 选型的战略分叉。

10. **`hud-setup` 在本机似乎没装上。** 它是每角色 skill 的唯一入口，但 `~/.claude/skills` 和 `~/.codex/skills` 里都没有它（G9）。第 3 步之前需要先确认。

11. **`AGENTS.md` 的读者是所有 worker。** 以后往里写任何"主会话应该如何"的内容之前，先想一下 sonic 读到这句会怎么做。

---

## 6. 未验证项与假设

**需要探针才能下结论的：**
- `claude --settings '{"enabledPlugins":{…:false}}'` 能否压过项目 `.claude/settings.json`。影响 3.4 的选项 B。
- Claude Code `permissions.deny` 对 skill 的规则写法，及其在 `--dangerously-skip-permissions` 下是否生效。影响选项 D。
- Codex 能否用 `-c` 在单次启动时关掉某个插件。
- pi 主会话是否支持项目级 skill 开关；pi 里"Call the Skill tool"这种措辞是否有对应工具。
- wayfinder 本地 ticket 在面板上不可见（2.2）是从正则推出的，未实际造文件验证。
- Claude worker 的 cwd 是 worktree 时是否加载插件：`.claude/settings.json` 提交后会出现在 worktree 里，未提交则不会。当前未提交。

**工作假设：**
- 以 `docs/spec.md` 为边界：MCP 不解释角色和工作流，不做自动串联。所有建议都在这条线内；两处触线的地方（convention 分层、角色 `args` 传 `--settings`）已分别标出，交 owner 决定。
- 把 `HUD/docs/delegation.md`（2026-11-10 重写版）当作 Jacob 当前认可的工作方式。
- 没有评估 Matt skill 在 GPT、DeepSeek 等非 Claude 模型上的实际效果；"可选、先试"的判断都基于此。
- job 统计只覆盖 `~/.hud/jobs` 现存的 69 个，即最近约一天多；更早的已按留存规则删除，样本偏向近期活动。

**未向 orchestrator 提问**：没有遇到阻塞性的歧义。有三处需要 owner 决定，已在正文标出：JevDev 的 tracker 选型、`AGENTS.md` delegation 块的去留、是否允许 convention 分层。

---

## 7. 读过的文件与运行的命令

**HUD（`~/projects/MyHUD`）**
- 全文：`packages/hud-mcp/README.md`、`packages/hud-mcp/hud-convention.md`、`docs/delegation.md`、`docs/spec.md`、`AGENTS.md`、`CLAUDE.md`、`ISSUES.md`、`integrations/skills/hud-delegate/SKILL.md`、`integrations/skills/hud-handoff/SKILL.md`、`integrations/skills/hud-setup/SKILL.md`、`integrations/skills/hud-delegate/roles/implementer.md`、`packages/hud-mcp/roles/*.json`、`packages/hud-mcp/harnesses.json`、`packages/hud-mcp/instructions/{oracle,implementer,reviewer,frontend-implementer,general}.md`、`src/collectors/project-board.ts`、`src/roles/cli-kinds.ts`、`docs/agents/{domain,issue-tracker,triage-labels}.md`
- 分段：`packages/hud-mcp/src/thin-main.ts`（1-135、290-490、605-705、779-1008）、`src/roles/roster.ts`（340-510）、`src/cli/setup.ts`（100-260）、`src/render/project-view.ts`（79-83、286-300、324-360）、`docs/handoff/STATE.md`（前 60 行）、`docs/design/hud-workflows.md`（标题与状态头）、`.scratch/role-bind/issues/02-*.md`、`.scratch/role-bind/spec.md`（前 30 行）
- grep：`install.d/*`、`packages/hud-mcp/bin/hud-watch.mjs`、`integrations/pi/package/README.md`、`README.md`

**本机配置**
- `~/.hud/roles/*.json`、`~/.hud/harnesses.json`、`~/.hud/projects.json`、`~/.hud/config.json`（非凭据部分）、`~/.hud/jobs/*/job.json` 与 `STATUS.json`（仅汇总 role、place、model、cwd、package、state）
- `~/.claude/settings.json`（`enabledPlugins` 段）、`~/.claude/skills/`、`~/.codex/skills/`、`~/.agents/skills/`、`~/.codex/config.toml`（772-792 行）、`~/.pi/agent/skills/`（目录列表）
- `~/projects/bilingual/.hud/project.json`

**pi-roles（`~/Fishpref/pi-roles`）**
- `roles/{implementer,reviewer,architect,sonic,general}.md` 全文，`bin/pi-role`（80-135 行），目录列表

**Matt skills（插件缓存 1.3.1）**
- 全文：`README.md`、`CLAUDE.md`、`GLOSSARY.md`、`SCOPE.md`、`.out-of-scope/subagent-recursion.md`、`.claude-plugin/plugin.json`、`.agents/invocation.md`、各 bucket 的 `README.md`
- skill 全文：`ask-matt`（含 `PHASE-BOUNDARIES.md`）、`implement`、`implement-spec`、`code-review`、`to-spec`、`to-tickets`、`grill-with-docs`、`grilling`、`grill-me`、`handoff`、`wait-what`、`research`、`tdd`、`triage`（含 `AGENT-BRIEF.md`）、`wayfinder`、`retro`、`setup-matt-pocock-skills`（含 `issue-tracker-github.md`、`issue-tracker-local.md`）、`domain-modeling`、`diagnosing-bugs`、`prototype`、`writing-for-agents`（含 `SKILL-MECHANICS.md`）、`in-progress/{chief-of-staff,claude-handoff,loop-me}`
- 部分：`wizard`、`to-questionnaire`、`codebase-design`、`improve-codebase-architecture`、`pr`、`teach`（开头部分）；`CHANGELOG.md`（1.3.1、1.3.0 及部分 1.2.x）
- 上游 clone（1.3.2）：`git log -1`、与 1.3.1 的 `diff -rq`、`implement-spec`/`code-review`/`research` 的逐行 diff、`CHANGELOG.md` 1.3.2 段、`skills/in-progress/software-factory/SKILL.md`（前 90 行）

**MySkills（`~/codex/MySkills`）**
- `README.md`、`AGENTS.md`、`teaming/SKILL.md`、`teaming/references/workflow.md`、`teaming/agents/openai.yaml`、`workflow-design/SKILL.md`、`agents/README.md`

**JevDev（`~/projects/JevDev`）**
- `AGENTS.md`（含未提交 diff）、`.claude/settings.json`、`docs/agents/{domain,issue-tracker,triage-labels}.md`、目录列表

**只读命令**
- `ls`、`wc -l`、`cat`、`sed -n`、`grep`、`find`、`diff`、`diff -rq`
- `git status --short`、`git log --oneline`、`git log -1`、`git branch --show-current`、`git diff AGENTS.md`、`git remote -v`、`git ls-files`、`git worktree list`
- `claude --help`、`claude --version`
- `node -e` 一次，仅用于读取并汇总 `~/.hud/jobs` 下的 JSON
