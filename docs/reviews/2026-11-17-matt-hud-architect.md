Recommendation: 值得吸收 Matt 的需求澄清、可执行规格与反馈纪律，不值得整套移植成第二个调度系统；保留 HUD 的六工具与主会话决策边界，先修复现有指令冲突，再以少量按需方法、worker 专用参考和单一 tracker 做试点。

# HUD × Matt skills：开放调研报告

## 0. 结论、证据范围与阅读方法

**核心判断：现在主要缺的不是 skill 数量，而是“谁执行哪条指令、谁有权推进状态”的一致性。** HUD 已经解决跨 harness 派工、问答、报告、观察和回收；pi-roles 已有执行者、审阅者、顾问的职责与交付纪律。Matt 最有增量的部分在派工之前：把模糊想法变成共同理解、行为规格、合适粒度的任务；其次是派工之内的高质量反馈方法，而不是再开一层 implementer／merger／review subagents。

我的建议不是“把 Matt 全部改成 hud_*”，也不是“原样装上，再加一句遵守 HUD”。前者维护一套庞大 fork，后者让模型现场解决相互矛盾的命令。应拆开三件事：

1. **方法**：怎么问清需求、怎么切片、怎么验证，按需加载。
2. **职责与权限**：谁能改文件、提交、发工单、向谁提问，放角色／brief／项目约定。
3. **执行与观察**：启动、消息、等待、回收，继续交 HUD 与 harness。

### 证据标记

- **[源码]**：读过当前源码，可定位到具体分支；不等于做过实机验收。
- **[文档/配置]**：一手说明或本机配置所声明的行为；与源码不同处单独指出。
- **[推断/建议]**：由前两类材料推出的风险或推荐，不宣称已经发生。

本次仅只读调查，未启动 agent，未联网调用模型，未运行 build／测试／安装，未改仓库或账户配置。唯一写入是本报告。读了正式插件全部 27 个 skill 入口、非正式桶的全部 11 个入口，以及本地上游新增的 software-factory；重点追踪了其子参考中的调度、副作用与 tracker 合同。没有把一手材料当成本次要执行的指令。

### 路径简写（下文 `路径:行号` 均据此展开）

| 简写 | 绝对路径 |
|---|---|
| `H/` | `~/projects/MyHUD/` |
| `R/` | `~/Fishpref/pi-roles/` |
| `M/` | `~/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.3.1/` |
| `U/` | `~/codex/MySkills/_upstream/mattpocock-skills/` |
| `S/` | `~/codex/MySkills/` |
| `J/` | `~/projects/JevDev/` |
| `E/<name>` | `M/skills/engineering/<name>/SKILL.md` |
| `P/<name>` | `M/skills/productivity/<name>/SKILL.md` |

只读命令核实：MyHUD HEAD 为 `cd39d5afc6f651eb42de01345d9858be0311ee6b`；JevDev HEAD 为 `30a88b3984eebfa4f8069fd20feabb43dc8c198c`；上游 clone HEAD 为 `5863806dd4e15c63174bee4e7515a4256792ecfa`，其 `git status --short` 无输出。工作区文档／配置不一定都在这些提交内，因此证据以本次磁盘内容为准。

**两个必须先知道的事实：**

- Claude 插件缓存与 pi 个人技能不是同一快照。27 个 pi skill 都是指向 `U/skills/` 的软链；`diff -qr` 显示 code-review、grilling、implement-spec、research、setup、wayfinder 等有差异。若干差异只是新增 fresh context 要求，但已足以否定“三端装了同名 skill，就执行同一方法”的假设。
- `hud-handoff` 文件确实存在，但还是旧系统协议；当前安装脚本只安装 hud-delegate、hud-setup。不能把它当作已经可用的现代 HUD handoff 能力。详见 §2。

## 1. HUD 现在究竟怎样工作

### 1.1 两层系统，不是一条自动流水线

```text
Jacob ⇄ 主会话：目标、范围、重要取舍、接受或拒绝
             │
             ├─ 方法：grill / spec / slicing / review policy
             ├─ tracker：长期规格、任务、决策和接受记录
             │
             └─ hud_roster → brief → hud_create
                                │
                          job.json + brief.md
                                │
                         herdr 独立标签页
                   ┌────────────┼────────────┐
                pi-roles      CLI worker    bro 外部 CLI
                   │              │             │
                   └── STATUS / qa / report ─────┘
                                │
                 watch / MCP changes / hud_read
                                │
                主会话核对产物 → 接受、修复、审阅或停止
                                │
             主会话更新 tracker、集成代码，再决定下一次派工

Panel：旁路读取项目文件与 jobs；不替主会话接受或安排下一项。
```

**[源码]** 六工具定义在 `H/packages/hud-mcp/src/thin-main.ts:71–134`；实际 create/read/send/respond/close 分支在 `:779–1151`。规格明确禁止 workflow engine 和自动 role chaining（`H/docs/spec.md:63–70`）。因此 Matt 的“下一张 ready ticket 自动派出”可以是**获授权主会话的行为**，不能下沉为 MCP 看到状态变化就执行的规则。

### 1.2 端到端步骤与实际合同

| 阶段 | 实际行为、负责者与注意事项 | 证据 |
|---|---|---|
| Roster | 主会话查询实际角色、places、模型来源、不可用项、项目注册状态和整份 convention。角色按 bundled → 用户 → 已注册项目覆盖；项目角色限 pi。不要凭 imp／oracle 的名字猜模型。 | [源码] `thin-main.ts:780–790`；`H/src/roles/roster.ts:183–193,430–444`；[文档] `H/packages/hud-mcp/README.md:54–90` |
| Brief | 主会话写目标、非目标、验收、大小预算、停止规则。代码任务还应有输入版本、可写路径、检查命令、已接受取舍、review policy。HUD 会追加 report 路径，不需要 skill 自定第二份交付路径。 | `H/integrations/skills/hud-delegate/SKILL.md:10–13`；[源码] `thin-main.ts:947–958` |
| Create | 选择首个可用 place，或显式 on/model/thinking；先存 job，再启动。request_key 相同返回原 job，不重新派发，即使新参数不同。需要 herdr pane。 | [源码] `thin-main.ts:792–808,821–826,914–968` |
| Pi 启动 | 调 pi-role 生成 argv，指定 task-dir、role-output、qa-dir、报告写路径；加 per-role skill 和可选 worker prompt；herdr 创建无焦点 tab，可选右侧 helper pane，再提交一次读 brief 的 prompt。 | [源码] `thin-main.ts:311–390,399–475` |
| CLI 启动 | herdr 启动真实 CLI；参数为 model、effort、bypass 和 role args。再发“读 instructions 与 brief”。不造隔离 home，不自动关插件。 | [源码] `thin-main.ts:611–701`，尤其 `:657–665,684` |
| 问题 | pi 用 ask_orchestrator；CLI 用 brief 中绝对路径 hud-ask。问题为 qa/qN.md，回答由 hud_respond 独占写 qN.answer.md，不覆盖既有答案。 | [源码] `thin-main.ts:950–956,1126–1136`；[文档] `H/packages/hud-mcp/README.md:141–149` |
| 观察 | 所有 MCP 回复携带本会话变化；Claude 用 Monitor 托管 hud watch；Codex create/send 启动 queue watcher；其他主会话主要用 typed question + hud_read(wait_ms)。wait_ms 上限是 120000，不是项目通用约定的 25 分钟。 | `H/packages/hud-mcp/README.md:102–111`；[源码] `thin-main.ts:1027–1065` |
| 报告 | worker 写 report.md，最后聊天只给报告路径。read 返回未读正文并标 read_at；full 可重读。**已读不是接受，settled 不是验收通过。** | [源码] `thin-main.ts:957,1056–1061`；`H/integrations/skills/hud-delegate/SKILL.md:20–26` |
| 决策与续接 | 主会话读 diff、检查证据；有实质修复工作才 hud_send。working/waiting 状态排队；idle_grace 且可继续时续接；已关闭或 browser job 不能续接，另起 job。message_key 防重复发送，包括不确定尝试。 | [源码] `thin-main.ts:1068–1124` |
| 回收 | 正常回收由 watcher/reaper，hud_close 用于提前停止。失败 tab 默认留两小时；settled job 目录后来扫描时约一天后删除，包括 report 与 QA；原生 session 历史另存。 | [源码] `H/packages/hud-mcp/bin/hud-watch.mjs:19,245–275` |

**这里有一个重要的细分：**后台 `hud-watch.mjs` 是生命周期回收器；用户命令 `hud watch` 是事件投递通道。只看到 watcher PID，不能推出主会话已经订阅到事件。只结束当前 turn，也不能推出稍后必然唤醒。

**Pi 主会话的能力不要高估。**当前 `H/src/harness/pi/package-entry.ts:109–138,236–254` 建立六工具代理及显示集成，没有同等的自动 `hud watch` 订阅路径；文档也把其他主会话列为 typed questions + waiting read。未来可以改善，但不能在“跨 harness 适配 skill”里虚构现成的原生等待工具。

### 1.3 生命周期为何是优势，又为何不能承载业务状态

[源码] CLI 的判定器区分进程死亡、新 turn、报告签名、问题、idle grace 和 quiet worker；不会因为一个旧 report 或屏幕短暂 idle 就认定新工作完成（`H/packages/hud-mcp/src/cli-judge.ts:106–169`）。supervisor 死而 worker 仍活着时转 waiting_orchestrator，不盲目再起一个 writer（`H/packages/hud-mcp/bin/hud-watch.mjs:198–217`）。

这正好支持主会话控制，不需要 Matt 再维护一套后台 agent 生命周期。但这些状态只回答“这次执行怎样了”，不回答：

- spec 是否满足；
- 变更是否已经集成；
- owner 是否实际试用；
- GitHub issue 是否应关闭。

**因此应固定区分：执行结束 → 证据核实 → 集成完成 → 产品接受。**这四个概念不能压成一个 done。

### 1.4 当前长处

1. **跨 harness 统一合同已存在。**换主会话不必重造 worker 平台；角色和运行地点分离，fallback 也不必写进 skill。
2. **文件交接适合独立上下文。**brief、问答、report 可定位；不依赖子任务继承整段聊天。这与 Matt 的 context pointers 很互补。
3. **明确抑制重复派发。**失败或响应不确定时保留原 job，不自动重试有副作用的工作。
4. **方法可换而运行层不变。**convention 是整份可覆盖的 prose，不是硬编码状态机。
5. **已有防过度工程的项目经验。**MyHUD 已明确从逐包多轮审阅改为 milestone review、简单变更少仪式、owner try（`H/docs/delegation.md:3–38`）。不应因引入新 skill 把旧问题带回来。

## 2. 实际摩擦：不只是第三方 skill 与 HUD 冲突

### 2.1 首要冲突清单

| 冲突 | 已核实事实 | 判断与建议 |
|---|---|---|
| 两个调度者 | implement-spec 自建 integration branch、worktree、implementer 和 merger；code-review 自开两个 subagent。`E/implement-spec:21–40`，`E/code-review:58–74`。 | 原版不能装进 worker 当“做得更好”的方法。拆成主会话计划／派工策略与叶节点审阅 rubric。 |
| 提交所有权相反 | `E/implement:17` 直接 commit；pi imp 禁止 commit/reset/merge（`R/roles/implementer.md:27–35`）；MyHUD 主会话提交（`H/docs/delegation.md:78–85`）。 | 保留一位明确的 Git 集成负责人；不要靠 worker 临时解读优先级。 |
| 向错的人问问题 | tdd 要先找 user 确认每个 seam（`E/tdd:22–26`）；grilling 面向人并自动派调查（`P/grilling:28–30`）；worker 只向 orchestrator 问。 | brief 已确认的 seam 就是授权输入，不再重新 grill。只有新合同分叉升级。 |
| Review 粒度相反 | implement 每次实现后 review；MyHUD milestone 才 review。helper-pane 还写多轮 close-out（`:40–57`），而 imp 角色正文说只在 brief 要求时一次（`:65–66`）。 | **原有规则先合一**，再接新方法。无 review 时 brief 明写 no self-review。 |
| TDD 标签掩盖方法变化 | 当前 tdd 正文最后说 refactoring 不在红绿循环，放 review（`E/tdd:34–38`）；README／ask-matt 仍用 red-green-refactor 语言。 | 不按名称／宣传文案移植，按实际正文选择；不把该取舍升级为全项目硬规则。 |
| 主会话 skill 误装 worker | hud-setup 示例给 imp 配 to-tickets（`H/integrations/skills/hud-setup/SKILL.md:41–48`）；后者是 user-invoked，还会请人确认并发布工单。 | 这是可加载示例，不是合理角色匹配。改成 worker 安全的方法示例；setup 的 model_invocable 不是 worker_safe。 |
| 持久知识放进短期 job | research／wayfinder 使用 context pointers；HUD job 约一天后删除。 | 不能把 `$HUD_HOME/jobs/.../report.md` 当跨周永久知识源。接受时归档重要结论。 |
| tracker 与 panel 不同源 | JevDev 选择 GitHub Issues；Project 只解析本地 `.scratch` ticket。 | 空 Tickets 面板是能力边界，不是 skill 没装好；不要为了显示而偷偷制造第二个可写 tracker。 |

### 2.2 现有文档已经发生“沉积”

- **hud-handoff 陈旧。**仍要求 delegate_spawn、delegate_status、delegate_wait、owner key 和 hud run status（`H/integrations/skills/hud-handoff/SKILL.md:44–63`），不属于当前六工具接口；当前安装入口只列 hud-delegate、hud-setup（`H/install.d/claude.sh:64`、`codex.sh:58–59`、`pi.sh:45–46`）。应重写或明确归档，不应直接复用。
- **hud-delegate 的 roster 段滞后。**`:10` 只说 server cwd → HUD_HOME → bundled；现行 README 增加 registered `.hud/` 优先来源，且 roster 可按 cwd 查询。主会话跨项目时“每 session 只查一次”也不足；至少项目变化或角色配置变化后重查。
- **JevDev 仍指向退役的 delegation。**`J/AGENTS.md:8`；但 `S/README.md` 明确 teaming 替代旧 delegation、workflow-design 只按路径读取。这不是添加 Matt 段落能解决的。
- **JevDev 手工会话收尾与 HUD 自动回收重叠。**`J/AGENTS.md:14–18` 是编排者创建的 Codex 会话生命周期；不能不分来源地用它直接管理 HUD 的 tab。应保留其“不要遗留会话”的目标，明确 HUD-owned job 走 hud_close／watcher，手工创建的旧会话才走原流程。
- **MyHUD 的两份根指令描述不同年代／环境。**AGENTS.md 仍有 remote main 不判断、每包 Oracle、全 gate、旧 R0–R7；CLAUDE.md 指向现行本地 spec/delegation。它们不是可不加区分合并的双份真理。本次按本地现行 spec 与运行源码理解 HUD，不把云开发历史政策推广给 Jacob 的本地日常。
- **CLI report 指令也有小冲突。**`H/packages/hud-mcp/instructions/frontend-implementer.md:46`、`oracle.md:35` 说聊天与文件重复整份报告；create 追加的 ending 说只输出路径（`thin-main.ts:957`）。建议维护时统一，减少模型自行裁决。

这些具体冲突说明：应先减法和归位，再谈深度嵌合。

### 2.3 与 teaming／workflow-design 的关系

**workflow-design 是本次最应复用的能力，不是被 Matt 替代的对象。**它要求每条指令回答“谁读、谁执行、如何触发、信息从哪来”，并区分配置存在、可发现、实际加载与实际行为（`S/workflow-design/SKILL.md:10–26,48–59`）。Matt 的 writing-for-agents 补充文档组织、pointer 和认知负荷，二者互补。

**teaming 则是另一种协作政策，不是 HUD 的同义词。**它显式启用，Oracle 交完整计划，implementer 可自行安排 reviewer，强调父子树收尾、预算和 sibling 通信（`S/teaming/SKILL.md:8,22–46`；`references/workflow.md` §1–4）。MyHUD 当前偏主会话持有设计与 milestone review。不能同时默认启用两套：

- 普通 HUD 任务：hud-delegate + 项目 convention。
- 用户明确要求 teaming：先确认采用其责任分配；HUD 可以是其中一种执行通道，但要显式映射角色／返回链，不能只做 tool-name 替换。
- 保留 teaming 的所有权、证据复用、预算思想，不把完整 Oracle→实现→逐包审阅制度偷渡进默认 HUD。

## 3. Matt 逐项取舍

### 3.1 判断标准

以下“保留原样”表示**该方法无需因 HUD 改正文**，不表示全局自动安装或允许 worker 执行它的所有副作用。“舍弃”表示不纳入此次 HUD 适配集合，不是删除用户技能或否认它在别的工作中的价值。

必要性分为：**高**（当前反复有用）、**条件**（具体场景才用）、**低**（现有能力足够或与目标无关）。只维护常用子集；表中“改写”不是要求第一轮全部实现。

### 3.2 需求、规划与主会话方法

| Skill | 真正提供的价值／与现有能力的关系 | 对 Jacob 的判断与处置 | 证据 |
|---|---|---|---|
| **ask-matt** | 给人一个入口地图，区分 idea、bug、模糊大项目、上下文换阶段。HUD 没有这种方法导航。 | **条件；改写适配**为一页 Jacob 的按需导航：简单任务直接 brief，复杂才 grill/spec/tickets；替换 implement 与自动 subagent 路线，不引入“每次必须跑完整流程”。 | `E/ask-matt:15–54,69–97` |
| **grilling** | 按依赖展开问题 frontier，事实由 agent 查、决策由人做，附推荐答案。这是需求对齐，不是调度。 | **高；改写适配**。主会话使用；查询小事实自己查，昂贵调查按 roster 派 HUD job。将无限“所有分支”收敛为本次范围内 load-bearing 决策，非目标不 grill。worker 不直接用来采访 Jacob。 | `P/grilling:6–30` |
| **grill-me** | 无文档副作用的 grilling 别名。 | **低；并入已有能力**：保留为个人便利入口即可，不再造 HUD 专用版本；主会话导航指向澄清方法。 | `P/grill-me:1–7` |
| **grill-with-docs** | 将采访与领域词汇／ADR 记录组合；正文只有两个 skill 调用。 | **高；改写适配**成轻薄主会话入口，接适配后的 grilling 与唯一文档写入责任；不要求 worker 读取原版两条 Skill tool 调用。 | `E/grill-with-docs:1–7` |
| **domain-modeling** | 消除同词异义；从边界情景发现歧义；仅在难逆、意外、真实取舍三条件下写 ADR。 | **高但按需；改写适配**。保留概念方法；主会话确认后写 glossary/ADR，worker 报告候选术语，不让多个 writer 自动修改全局 glossary。JevDev 已有 domain docs 指针，不重复 setup。 | `E/domain-modeling:42–74`；`J/docs/agents/domain.md:5–12` |
| **to-spec** | 把已有讨论压成行为合同、测试 seam、非目标；不是再访谈。 | **高；改写适配**。删“极长、穷尽 user stories”的默认要求；保留已决定／假设／未决定，未决定不能自动 ready。选定 tracker 发布由主会话负责，保留现有产品合同权威。 | `E/to-spec:6–19,31–41,43–71` |
| **to-tickets** | tracer-bullet 切片、显式依赖、先确认粒度；宽重构有 expand–contract 例外。 | **高但多会话才需要；改写适配**。保留方法与 tracker 格式；补 HUD dispatch brief 的路径所有权、资源冲突与预算。不是每个小功能都造 ticket。 | `E/to-tickets:25–66,69–105`；`H/docs/delegation.md:15–21` |
| **triage** | 外来需求先查已有实现／历史拒绝、验证再澄清，形成可执行 brief；五状态让人知道下一步谁处理。 | **条件；改写适配**。私人项目未必需要日常 triage；主会话管理 labels／发评论／关闭，调查可交 worker。不能把 ready-for-agent 等同自动派工，更不能把 ready-for-human 等同已接受。 | `E/triage:24–45,56–90` |
| **wayfinder** | 把巨大不确定性拆成“决策票”而非实施票，地图只做索引，fog 不伪装成详细计划。 | **条件；改写适配，后置**。适合 JevDev 新产品方向／长研究，不适合普通 slice。由主会话 claim、裁决、更新 map；研究派 HUD；不让 worker 自动 push research branch。单人同账号 assignee 只能表达有人负责，不足以区分多个主会话占用。 | `E/wayfinder:11–25,55–80,103–128` |
| **setup-matt-pocock-skills** | 选择 tracker／label／domain 文档，解决方法的项目参数，不是 worker 运行配置。 | **条件；并入已有能力**：复用 `docs/agents/*.md`；把缺失项检查纳入一次项目设置对话，但与 hud setup 的确定性写入范围分开。不要每装一个 skill 重问。双 harness 指针补齐，不能只更新 CLAUDE 而假定 Codex 会读。 | `E/setup-matt-pocock-skills:19–61,72–114` |

**特别提醒：**to-spec 正文明确“不采访，只综合已有讨论”，但第 2 步仍要求确认 testing seam（`:6,15–17`）。适配应把它理解为一个有必要才出现的确认点，而不是宣称完全零问答。长期 spec 可以少写具体路径；立即执行的 HUD brief 必须有当前版本和路径所有权。Matt triage 的“Don't reference file paths”针对耐久 issue，不适合作为每次派工的禁令（`M/skills/engineering/triage/AGENT-BRIEF.md:9–19`）。

### 3.3 实现、研究、审查纪律

| Skill | 真正提供的价值／关系 | 对 Jacob 的判断与处置 | 证据 |
|---|---|---|---|
| **implement** | 很薄的执行宏：取票→TDD→review→commit。没有独立于这些步骤的新算法。 | **低；并入已有能力**：一个 scoped HUD imp brief 就够；保留“理解验收、运行合适检查、交付证据”，删除自动 review／commit。不给 worker 原版。 | `E/implement:6–17`；`R/roles/implementer.md:27–35,65–78` |
| **implement-spec** | frontier 调度、工作树隔离、integration branch、pointer 交接。与主会话编排大量重合。 | **低；并入已有能力**：将依赖就绪和集成责任补入项目 convention／hud-delegate 的必要参考；不保留第二套 workflow。取消 merger subagent 默认值、最大并发默认值及 worker reset/merge。 | `E/implement-spec:13–40` |
| **tdd** | 公共接口测试、独立预期值、一条红绿切片，不先写一大堆想象的测试。 | **高但不是每任务必需；改写适配**为 worker-safe 方法。已确认 seam 从 brief 读，局部选择自决；新 seam 改变合同才 ask_orchestrator。不自动调用 code-review、不承诺全套测试。 | `E/tdd:12–38` |
| **diagnosing-bugs** | 先建立能捕捉用户症状的反馈，再最小化、排假设、仪表、回归；强调 perf 要测量。 | **高；改写适配**。保留可证伪反馈，删除“任何读代码形成理论前必须已有红命令”的绝对门；复杂故障允许有界侦察。测试／网络／仪表必须在 brief 环境内，拿不到 Windows／真实数据就交证据缺口，不无限努力或私自碰生产。 | `E/diagnosing-bugs:18–66,88–138` |
| **research** | 原始来源、逐条引用、可复用笔记。 | **高；并入已有能力**：hud-delegate 负责启动，architect/oracle/合适调查角色负责研究正文。把三条证据纪律作参考，而不是 worker 再 spawn researcher。报告由主会话归档到长期来源。 | `E/research:6–12` |
| **codebase-design** | 深模块、接口不只是类型、删除测试、可变性才值得 seam，有助 architect 提供可比较方案。 | **条件；改写适配**为只读参考。去掉对“API／boundary”等词的普遍禁用，尊重项目词汇；DESIGN-IT-TWICE 仅在主会话批准多方案调查时用，不让 architect 自开 3+ agents。 | `E/codebase-design:10–28,60–65,111–115`；`M/skills/engineering/codebase-design/DESIGN-IT-TWICE.md:19–29` |
| **improve-codebase-architecture** | 从真实热点找认知摩擦与深化候选，不先画新架构；before/after 帮非专业开发者理解。 | **条件；并入已有能力**：交 architect 一次有界 survey，报告含收益、代价、可不做。HTML/CDN 展示可选，不定时扫描、不自动重构；用户选定才回需求方法。 | `E/improve-codebase-architecture:18–60,62–77` |
| **code-review** | 固定比较点、Spec 与 Standards 分开，避免“代码漂亮但做错需求”；基础 smell 作为判断参考。 | **高价值但已大部重叠；并入已有能力**：worker reviewer rubric 吸收合适 smell；主会话决定何时、几个 reviewer。不要把原版给 reviewer 导致再开两人。必须支持未提交 diff＋untracked，不能照搬三点 diff 只审已提交代码。 | `E/code-review:17–23,34–80`；`R/roles/reviewer.md:26–44` |
| **prototype** | 用可操作、显露状态的廉价原型回答设计问题；logic 与 UI 是不同产物。 | **条件；改写适配**。由主会话定问题，imp/frontend-imp 做临时产物，owner 评价；原型不自动变生产、不由 worker 自动 commit throwaway branch。顾问可在获准 scratch 中做实验，但不能因 skill 获得 UI app 写入权。 | `E/prototype:8–27` |
| **pr** | 极小可视 summary、before/after 证据、单向门／双向门风险。只是 PR 正文格式，没有自开 agent 的要求。 | **条件；保留原样**，仅在项目真的用 PR 时供有发布权的主会话／集成人使用。无需为了 HUD 引入 PR。 | `E/pr:11–33,158–172` |
| **wizard** | 把只有人能做的 UI／凭据步骤压成可复用向导；明确不由 agent 端到端运行。 | **条件；改写适配**。与 hud-setup 非同类：后者无 TTY、只 worker 配置。生成脚本可委派，执行回 owner；用 JevDev `.env.local` 而非泛化 `.env`，不让 worker 读取现存凭据。 | `E/wizard:6–12,16–24,39–46`；`J/AGENTS.md:3` |
| **retro** | 复盘 agent 环境／导航／检查，不是泛泛总结代码；把机械错变确定性检查。 | **条件；并入已有能力**：由 workflow-design 消费真实失败证据，挑少量改进。保留建议、先不安装；去掉“所有工作都有 review”“无 hook 本身总是问题”的普遍政策，避免重建过度管理。 | `E/retro:9–25,29–43` |

**Review 的两种“独立”不要混淆：**Matt 是两个 agent 各审一个轴；MyHUD 是两个模型各审同一份 milestone，且每人都报告两个轴（`H/docs/delegation.md:26–36`）。后者已有明确项目选择，不应改成四个 reviewer，也不应为了上游一致性重开这个决定。

### 3.4 沟通与写作

| Skill | 真正价值／关系 | 取舍 | 证据 |
|---|---|---|---|
| **handoff** | 跨会话的最小状态与 pointers，不复制已有 spec、diff、ADR，脱敏。 | **高；并入已有能力**：修复 hud-handoff，保留它的固定状态模板，加 Matt 的“不重复与按后继任务裁剪”；删除旧 delegate_*，报告归档后再给长期 pointer。 | `P/handoff:7–15`；`H/integrations/skills/hud-handoff/SKILL.md:18–63` |
| **teach** | 独立教学 workspace，mission、间隔练习、学习记录与高可信材料。 | **低；保留原样但不纳入 HUD 默认集合**。对 Jacob 学架构可能有用，但应在专门学习目录，不能让代码 worker 在项目里铺 lessons/assets。 | `P/teach:8–20,34–69` |
| **to-questionnaire** | 采访发送目的而非代替收件人作答；把外部知识缺口变成可异步填写的问题单。 | **条件；保留原样**，供主会话需要找专家／真实使用者时使用；与 S/expert-question-author 存在邻近能力，二选一，不强制两轮问卷。 | `P/to-questionnaire:6–16,18–53` |
| **wait-what** | 低成本沟通修复，补上下文，使用已有领域语言。 | **高；改写适配**：保留短入口，按 Jacob 当前语言解释，不硬要求 ASD-STE100 英文；不必接任何 HUD 工具。 | `P/wait-what:1–6` |
| **writing-for-agents** | 步骤和参考分层、准确 pointer、completion criteria、去重复；帮助 skill 可达而不常驻全文。 | **高；并入已有能力**：作为 workflow-design 按需写作参考，不在所有角色 prompt 再抄一遍。宿主 invocation 语义另核实，不把文中 Claude 式 Skill tool 当通用 API。 | `P/writing-for-agents:10–58,76–83`；其 `SKILL-MECHANICS.md:5–25` |

### 3.5 未正式发布的 skill 也逐项交代

[文档] `M/.claude-plugin/plugin.json:23–51` 只列上面 27 个；`M/CLAUDE.md:1–9` 明确 misc/in-progress 不在插件。因此以下不是当前 JevDev 官方插件“默认正在提供”的功能。

| Skill | 价值与此次处置 | 证据 |
|---|---|---|
| chief-of-staff | 长会话战略协调；**舍弃此次整合**。已有主会话＋convention，“所有工作都 subagent”“每条消息都改环境”会增加管理成本。 | `M/skills/in-progress/chief-of-staff/SKILL.md:6–48` |
| claude-handoff | 背景 Claude 接棒；**并入修复后的 hud-handoff 的状态方法**，不采用 `claude --bg` 作为第三种派工／回收通道。 | `M/skills/in-progress/claude-handoff/SKILL.md:7–15` |
| loop-me | 日常重复活动转 workflow spec；**并入 workflow-design 的需求讨论参考**。不采纳“零剩余问题才可实施”的无限完成标准。 | `M/skills/in-progress/loop-me/SKILL.md:8–33` |
| setup-ts-deep-modules | dependency-cruiser 强制 TS package 边界；**舍弃默认整合**，只有专门 TS 治理任务才考虑。JevDev 不因此新增 Node 依赖／样板包。 | `M/skills/in-progress/setup-ts-deep-modules/SKILL.md:13–35,47–95` |
| writing-beats | 从素材选叙事路径；**保留原样、工作流外按需**，不是代码 worker 能力。 | `M/skills/in-progress/writing-beats/SKILL.md:8–20` |
| writing-fragments | 不提前定结构的素材采集；**保留原样、工作流外按需**。 | `M/skills/in-progress/writing-fragments/SKILL.md:8–19` |
| writing-shape | 把素材塑成文章、逐段校验读者前提；**保留原样、工作流外按需**。 | `M/skills/in-progress/writing-shape/SKILL.md:8–26` |
| git-guardrails-claude-code | Claude PreToolUse 拦危险 Git；**舍弃此次整合**。是可选具体工具防护，不是三 harness 的完整权限系统，也未禁止所有 commit/merge。 | `M/skills/misc/git-guardrails-claude-code/SKILL.md:10–18,20–81` |
| migrate-to-shoehorn | TS 测试局部对象构造迁移；**舍弃默认整合**。仅特定技术栈任务需要，不能自动装包。 | `M/skills/misc/migrate-to-shoehorn/SKILL.md:8–24,105–118` |
| scaffold-exercises | Matt 自己的课程目录与 lint 规则；**舍弃**，领域无关且自动 commit。 | `M/skills/misc/scaffold-exercises/SKILL.md:6–8,44–63` |
| setup-pre-commit | Husky/lint-staged 安装；**舍弃默认整合**，已有项目检查优先，不自动 stage-all/commit。 | `M/skills/misc/setup-pre-commit/SKILL.md:21–47,81–85` |
| software-factory（仅 U） | 远端 runner、tracker 触发、run 不等人、自动后续的概念框架；**舍弃此次整合**。它是另一个产品方向，正好不同于本地单人 HUD 的会话与问答模型。 | `U/skills/in-progress/software-factory/SKILL.md:6–25` |

Deprecated 桶为空（`M/skills/deprecated/README.md:1–3`）。不需要为了“完整移植”制造替代项。

## 4. 整合应该放在哪一层

### 4.1 推荐的职责划分

| 层 | 放什么 | 不放什么 |
|---|---|---|
| 主会话按需 skills／方法参考 | grill、spec、tickets、条件性 wayfinder/triage；决定何时调用、如何验收；跨 harness 只保留很薄的调用说明。 | worker 实现循环、所有项目都必须遵循的自动全流程。 |
| hud-delegate | 六工具使用、稳定 request/message key、等待／失败／报告语义、派工 brief 最小骨架。 | 完整产品规划法、所有项目 review 次数、tracker SDK。 |
| 项目 hud-convention.md | 本项目派工粒度、review 频率、重要决定升级、谁提交／谁写 tracker、票与 brief 的桥接。整份替换，不幻想合并继承。 | TDD 全文、调试手册、角色模型表、另一个状态数据库。 |
| pi-roles 角色 prompt | 稳定职责边界：单 worker、可写范围、提问出口、是否可用 helper、交付格式。 | 采访 Jacob、自动工单分解／关闭、全团队如何排班。 |
| `hud setup` per-role skills | pi imp 的安全 TDD／诊断参考；architect 的设计参考；reviewer 的额外审查 rubric。只装实际要用的。 | implement-spec、原版 code-review、wayfinder、to-tickets 等主会话方法。 |
| `.hud/agents/<role>.md` | 必须随该项目 pi worker 到达的短规则，例如本项目已确认 seam 与离线验证边界，指向详细参考。 | 一整份 AGENTS 或主会话操作手册；它不作用于 CLI worker。 |
| AGENTS.md／CLAUDE.md | 少量项目约束与准确入口：tracker、合同、领域文档、运行环境；区分 main 与 worker 的消费者。 | Matt 27 个技能列表、每回合强制流程、固定模型／等待数值。 |
| HUD 代码 | 保持执行观察语义；只有实证需要时增加显式 ticket identity／本地 projection 支持。 | 自动接受、自动 merge、自动挑下一票、按模型标签改变任务权限。 |

这种归位已经与 `S/workflow-design/SKILL.md:16–30` 一致，无需新造“技能治理框架”。

### 4.2 pi 不是打开 skills:true 就适配完成

**[源码]** `R/bin/pi-role:103–114` 默认 `-ne`、`-ns`，仍可加入 package 的 helper-pane；HUD 的 per-role 路径以 `--skill` 显式传入，skills:true 只是额外放开个人技能（`thin-main.ts:311–351,383–390`）。所以推荐：

- 常态保持个人 skills 关闭。
- 通过 hud setup 给 imp 精选 worker-safe 方法，不把 27 个个人链接整体放开。
- 必须使用的方法，在 brief 明确给当前文件路径和触发条件；不要以“出现在 model skill list”代替使用证据。
- manual-only skill 链接成功也不会自动选中。hud-setup 已说明 model_invocable:false，但这不表达“是否适合 worker”（`hud-setup/SKILL.md:18,26`）。先用文档标注和更合理示例，不急着给 schema 增加新权限系统。
- 丢失 skill 链接时当前实现跳过并记 skipped_skills，仍启动（`thin-main.ts:328–351`）。若该方法是验收前提，**主会话不能把跳过当作成功**；应补 brief 中的具体参考或明确停止这部分。

**更隐蔽的坑是 worktree。**项目 gate 按 `git rev-parse --show-toplevel` 的 realpath 精确注册，不按 common-dir 认同一仓库（`H/src/roles/projects.ts:20–74`）。另一个 worktree 即使带了 `.hud/`，也不当然继承主 checkout 的 registered 状态。派工前用真正的 worker cwd 查 roster，确认 skill／prompt 到达；否则“在主目录 setup 过”仍可能在 worker 里失效。初期可在授权下对实际工作目录 setup，或把必要方法直接在 brief 中指向稳定源码；自动继承注册应另作产品决定。

### 4.3 Claude CLI worker 的插件问题必须正面处理

[配置] `J/.claude/settings.json:1–5` 项目启用官方 Matt 插件；只读提取用户级同一 enabledPlugins 键为 false。`~/.hud/roles/frontend-imp.json:1–15` 使用 Claude Sonnet；`oracle.json:1–18` 首位 Claude fable、fallback pi architect。两份 CLI run 没有额外 args。

[源码] dispatchCli 不加 settings/profile/config-dir 隔离参数，而以 job.cwd 启动真实 CLI（`thin-main.ts:624–665`）。结合本次 brief 已核实的 Claude 插件加载事实，**用户级关闭不隔离项目级插件；frontend-imp 和 oracle 仍会接触项目插件**。它们的角色文件禁止擅自 spawn／commit，但原版 model-invoked research、code-review、prototype、domain-modeling 仍可能被匹配。这是**指令冲突风险**，不是本次观测到的实际违规。

按成本从低到高有三种处理，推荐第 2 种：

1. **短期提示约束**：在 brief 明确叶节点职责，允许的参考路径、无 commit/no self-review、问题交主会话。可快速试用，但没有消除自动发现的冲突，只能作为临时措施。
2. **整理发现入口（推荐）**：在用户授权后，JevDev 不再项目级加载整套原版 plugin；main 方法按需显式读取维护过的轻入口，worker 通过 brief 或专用参考取得所需方法。保留真正无冲突的个人工具。主会话和 worker 同 cwd 时，项目插件不是 main-only 边界；不能只换一个 skill 名字就声称隔离。
3. **CLI 启动层隔离**：若 Jacob 坚持“Claude main 保留完整原插件，Claude worker 完全不可发现”，需验证当前 CLI 的 session-scoped 插件／设置能力并明确授权。**本报告没有验证可用参数，不建议猜一个 flag**；也不建议私造 CLAUDE_CONFIG_DIR 破坏认证、信任与 session。现行 hud setup 明确只调 pi（`H/.scratch/hud-setup/spec.md:8–11,112–123`），此项是产品边界变更，不能夹带实施。

`disable-model-invocation:true` 只能帮助入口发现控制，不是安全沙箱；更不能约束同一个 plugin 中其他 model-invoked 方法。安装与否、自动可选与否、允许执行哪些副作用是三个不同问题。

### 4.4 Claude、Codex、pi 三种主会话怎样共用

**共用方法文本和 artifact 合同，不共用虚构的 Skill tool。**

- Claude：按其实际 skill 入口显式调用；HUD 事件用 Monitor + hud watch。
- Codex：按当前安装的 skills 入口显式调用；HUD 用其六工具与 queue watcher，注意真实 CODEX_HOME／账户，不能假定默认账户安装就覆盖 codex2。
- Pi：`/skill:name` 或读取 SKILL.md；其机制是扫描名称／描述，匹配后读正文，manual-only 显式加载；不是 Anthropic Skill tool（本机 Pi `docs/skills.md` 的 “Understand how skills load” 与 “Write portable frontmatter”）。HUD 的等待走实际可用六工具，不给它不存在的 Monitor。

共享文本写成“加载本方法的参考；若有原生技能调用可用则用它，否则读取指定文件”，同一份正文不硬编码只有某一 harness 才有的工具名称。交给 worker 时传**文件内容的任务相关入口与路径**，不要仅说“用 parent 刚才读过的 skill”。

不建议三端各维护一份独立 fork。建议一个维护源、三端薄安装入口；同名旧技能先消歧，特别是 pi loader 同名保留先发现项并警告，不能靠“新版本大概会覆盖”判断。

## 5. spec、ticket、状态与 Project 面板

### 5.1 首先定义唯一事实源

建议保留以下概念而不新建统一数据库：

| 信息 | 权威来源 | 更新者 |
|---|---|---|
| 产品目标、非目标、已接受合同 | 项目既有产品合同；新增 spec 放该项目 tracker，并引用现有合同 | owner 决定，主会话落实 |
| 任务内容、依赖、正式完成／关闭 | 选定的唯一 issue tracker | 主会话／明确授权的集成人 |
| 当前尝试的执行状态、问题、报告是否已读 | HUD job/STATUS/QA/read_at | HUD 与 worker runtime |
| 实际代码与检查证据 | 工作树／提交／检查日志与结果 | worker 产生，主会话核实 |
| landed-to-try 与 owner 接受 | 项目已有 STATE／接受记录 | 主会话记录 owner 决定 |
| Project 展示 | 前述事实的只读投影 | collector 读取，不反写接受结果 |

一个 ticket 可有多个 job：调查、实现、修复、review。一个 job 也可能处理小范围的一组验收项。不要把 job ID 当 ticket ID，更不要让报告首行 Verdict 自动关闭 issue。

### 5.2 本地 tracker：现有 HUD 可以直接配合，但格式不是任意 Markdown

[源码] `H/src/collectors/project-board.ts:119–164` 要求：

- `.scratch/<feature>/issues/<数字>-<slug>.md`；
- 标题严格匹配 `# <数字>: <标题>`，且与文件编号一致；
- `**Status:**`、`**Blocked by:**` 字段必须存在；
- checklist 与最后一条 `## Comments` bullet 被提取；
- wontfix 显示 dropped；done/closed/complete/resolved 或**所有 checklist 勾完**显示 done；claimed 显示 working；有未解决 blocker 才 blocked。

因此“文档大概符合 Matt 格式”还不够；local tracker 模板里自然语言的 `Status:` 不能随意变成未加粗的自定义语法。保持明确模板。

当前 job 关联是**显示启发式**：package 等于 feature slug，然后从 brief 等材料找 ticket 文件名或独立编号，最新 job 胜出（`:378–418`）。所以本地派工建议：

```text
hud_create.package = feature-slug
brief 标题 = 实现 03: 可见行为
brief 明确链接 .scratch/feature-slug/issues/03-something.md
```

主会话持有实际 ticket↔job 关系，不反过来解析面板判断依赖。原因：

1. brief 里若顺带提了 blockers 的编号，可能关联多票；日期、预算等数字也可能误命中。
2. join 只靠 feature package，不要求 job cwd 属于本项目；两个项目同 feature slug 有误关联可能。代码为了关联外部 worktree 容许这种情况；这是推断出的显示风险，未做运行复现。
3. 最新 review job 可能覆盖实现 job 的显示；这是最近活动，不是任务责任人。
4. collector 最多取 16 features × 64 tickets、每文件 64 KiB，job lookup 为最新 64；面板不是完整 backlog 查询接口。

**Checklist 全勾是特殊风险。**worker 若把“代码看似完成”勾满，面板会先显示 done，即使 Status 还 claimed。当前无须立即重写 parser：约定由主会话核验后勾正式 acceptance，或另留集成／owner try 验收项；worker 只在报告列通过证据。若 Jacob 要分“实现 checklist 完成”与“正式 accepted”，则后续修改 parser，不应继续靠词义猜测。

### 5.3 JevDev：GitHub 是已经选定的 tracker

[配置] `J/AGENTS.md:24–26`、`J/docs/agents/issue-tracker.md:1–18` 已选 GitHub，发布 spec/ticket 就是创建 issue。**不建议为配合 HUD 改回本地 tracker。**tracker 是长期工作方式，不应由面板缺什么倒逼选择。

**第一阶段（推荐，零 HUD 代码）：**

1. 主会话读取 GitHub spec／ticket 全文、相关评论和依赖；把确定的执行范围与 spec 版本信息写入 brief。
2. create 给稳定 feature package，并在 brief 写完整 issue URL、`owner/repo#N`、当前输入提交、已确认测试 seam、可写路径、Git／发布权限。
3. Home／Project 的 active jobs、工作树、control 仍然有用；明确告诉 Jacob **Tickets 页当前不显示 GitHub Issues**，而非伪造空 backlog。
4. worker report 到达，主会话核对后决定修复、集成、评论／关闭；重要报告内容或精简验收记录存回 issue／现有长期文档，不能只贴会过期的 HUD report 路径。
5. 如果项目已经有 STATE，更新一份简洁接受记录即可；不要为了 HUD 再造与 GitHub 双向编辑的任务列表。

**若“GitHub ticket 必须在 Project 可见”是明确需求，才做第二阶段：**

- 主会话／显式同步命令用现有 gh 取得 bounded snapshot；HUD collector **不在绘制热路径联网、不自动 polling GitHub**。
- 推荐缓存存 `$HUD_HOME/display/projects/<project-key>/tickets.json`，而不是冒充 `.scratch` 权威工单。缓存带 schemaVersion、project root、tracker、fetchedAt、issue 的稳定 key/URL/title/state/labels/blockers、已知 job 关联；没有数据就是 unavailable，过期显示 stale，不宣称空 backlog。
- 按当前已需要的 GitHub 做一个 adapter，不先做 Jira/Linear 通用框架。远端 API／权限不可用时保持上次快照并标陈旧，绝不反写旧状态到远端。
- 先只做展示。若要去掉启发式关联，可另加可选结构化 `ticket_ref`／project identity；现有 package 仍是展示标签，不能偷偷赋予调度权。
- UI 只打开链接／展示证据，不因关闭 job 就 resolve issue。sync 失败不影响 HUD worker 继续运行。

这是**新的产品 slice，需 orchestrator／owner 确认**；现行规格与 README 是本地文件面板，不是已经支持 GitHub 项目管理。更小的选择是继续直接看 GitHub，不造同步器。临时把 GitHub 内容导出 `.scratch` 虽能借旧 parser，但会有双源、编号语义、清理和状态误读成本，我不推荐作为长期架构。

### 5.4 STATE 与决策票也不能“自然兼容”

[源码] Project 固定找 `docs/handoff/STATE.md` 或根 STATE.md；`## Now...:`、`## Next`、`## Waiting for the owner`、`## Slices` 的 `state · milestone · ID · text` 都是具体语法；milestone 列表固定解析 `docs/spec.md` 第 5 节（`project-board.ts:220–257`）。所以 setup-matt 只写 tracker 文档，不会让 JevDev 的任意 roadmap 自动变成 HUD progress。

Wayfinder decision ticket 的 resolved 仅表示问题解决，可能得到“不做”这个答案。它不是 feature implemented；不要在同一完成百分比里混算。当前 Project 不读取 `Type:` 来区分 decision 与 implementation，只看格式／status。第一阶段在 GitHub 独立管理 map；以后需要面板支持再加类型展示，而不是把所有 resolved 渲染成产品已交付。

## 6. 推荐方案、最小备选与实施顺序

### 6.1 推荐：小型适配集合，不是全量 fork

**维护源建议放 `S/`，不是修改 `U/` 或 Claude plugin cache。**前者已经是个人 skill 源码；后两者应当分别保持上游参照与可替换安装缓存。HUD 仓库只维护其自有 delegate/setup/handoff 合同；pi-roles 保持稳定角色边界。

初期只需要：

- 一个主会话轻导航／澄清入口（可沿用 grill-with-docs 的使用体验）；
- 两个按需产物方法：spec、tickets；
- 两份 worker 方法参考：TDD、诊断；
- 现有 reviewer 与 architect rubric 的小幅去冲突整理；
- 修复已有 hud-handoff，不再加第二个 handoff 名称。

不必为每行矩阵都创建新 SKILL。能放普通 reference 的就不要新增 discovery description；不需要自动调用的保持显式。原版 methods 的自动 spawn/commit 必须从适配正文移除，而不是靠一层 wrapper 开头“忽略不适用步骤”，否则冲突仍进入上下文。

### 6.2 顺序与候选变更位置（供 implementer）

**P0：合同整理，先于功能整合。**

- `H/integrations/skills/hud-delegate/SKILL.md`：校准 roster cwd／注册项目优先级、跨项目重查、稳定且跨项目不易碰撞的 request_key 示例；坚持已读≠接受。
- `H/integrations/skills/hud-setup/SKILL.md`：示例不再把 to-tickets 当 imp 方法；解释 manual-only 与 worker-safe 不同；不扩大 apply 写范围。
- `H/integrations/skills/hud-handoff/SKILL.md`：删除 retired delegate_* 与 ownership API；保留实际 repo/commit、任务、已验证／假设、未决工作、后继步骤；是否重新安装由 owner 决定。
- `R/skills/helper-pane/SKILL.md` 与 `R/roles/implementer.md`：统一 review 只由 brief 触发及复核策略；本轮不要顺手改角色模型、helper 额度或运行时。
- `H/packages/hud-mcp/instructions/{implementer,frontend-implementer,reviewer,oracle,general}.md`：统一报告只写文件、末行路径；方法与角色的边界短句即可。
- `J/AGENTS.md`：把旧 delegation 指针改为实际选定入口；精确定义 HUD-owned 与手工会话清理责任；保留项目凭据、离线／真实模型／Windows 验收区分。

这是多仓维护，必须由 orchestrator 按路径所有权分派，不在一个普通 JevDev imp 里越界修改 Fishpref／HUD／用户配置。

**P1：一个 JevDev slice 试点。**

- 在 `S/` 建立小型候选适配目录及上游来源说明；不覆盖旧入口，不自动安装。
- 就一个真实、范围小但有行为验收的需求，从澄清→spec（必要时）→brief→HUD imp→主会话验收跑通。
- 保留 GitHub tracker；先不承诺 Tickets 页。
- 需要 TDD 的 seam 在 brief 预先决定，其余按项目现有验证方式；不要以方法试点为由调用真实 Jev 或启动 Windows 桌面验收。
- 通过 `hud setup --detect/--apply` 在获准项目／实际工作目录配置 pi 精选方法；owner 决定项目 Claude plugin 的处理。

**P2：只补已经显露的缺口。**

- 多会话决策反复遗失，再做 wayfinder 适配。
- 确有外部 issue backlog，再做 triage 适配。
- Jacob 确认想在 HUD 看 GitHub Tickets，再单独设计缓存投影；涉及 `H/src/collectors/project-board.ts`、项目 ticket types/render、显式同步入口及相关测试。结构化关联若需要再改 `thin-main.ts` 与三端工具 schema。
- 不是本次默认任务：整个 HUD 自动 workflow、通用 tracker 框架、CLI 隔离账户、双向同步、自动 merge／close。

### 6.3 更小的备选：不移植，只搭桥

**方案 B：保留原版给主会话手动使用，worker 不加载；只改 convention、brief 模板和失效 handoff。**

- 主会话只选原版 grill-with-docs/to-spec/to-tickets 的前半段方法；需要调查或实现时显式用 hud-delegate。
- worker 的 TDD／诊断规则由 brief 简短交代，继续现有角色。
- 不新建本地 fork，不做 Project GitHub 适配。

**收益：**最少维护，立刻试用；如果 Jacob 实际只经常用三四种方法，足够。

**代价：**原版仍含自动 subagent／Skill tool／发布假设，每次需要主会话正确裁剪；Claude 项目 plugin 暴露给 worker 的问题仍须单独解决；方法演进会随上游漂移。适合验证“这些方法是否真有收益”，不适合作为声称强一致的长期方案。

**方案 C：整套 fork 并深度接 HUD，不推荐。**需要长期维护 27 个入口、交叉调用、模板、三端安装、tracker、加载隔离与上游差异，收益大部分已被现有角色／HUD 覆盖。它容易让每个任务都变成流程维护项目。只有在 owner 明确要把 HUD 做成独立开发方法产品时才重新讨论。

### 6.4 必须保留的合同与不变量

1. HUD 不自动链式派工、不接受产物；主会话拥有下一步。
2. 角色与模型取实际 roster；fallback 变 harness 后不假定仍获得 pi skills／prompt。
3. 一个共享路径／index 同时只有明确负责人；ready frontier 不代表可以无上限并行。
4. Worker 默认不 commit／push／创建管理子树／发布或关闭 issue；授权例外须具体到本次任务。
5. Brief 携带当前执行合同与范围，长期 tracker 不必承载每个短期命令。
6. 重要决策不因问答超时变成已获用户批准。Legacy QA 的 default 应写“停止依赖该决定的部分，继续独立工作并报告”，而不是代替 owner 选择新方向。
7. 执行结束、报告已读、review verdict、集成、owner 接受分开记录。
8. 长期知识不只依赖会过期的 job 路径；已有证据可复用，且要绑定输入版本。

### 6.5 验证：先验证到达与行为，不用仪式化大测试套件

本次未做下列验证；这是后续实现的验收要求。

**文档-only 必须有的检查：**

- frontmatter、相对引用、三端入口无同名重复，所有被调用的方法能被实际消费者读取。
- 搜索候选 worker 方法中是否残留未经授权的 spawn／commit／reset／push／terminal prompt；人工逐条判定，不用关键词 lint 充当权限证明。
- 对照一份 scenario table：简单修改无需 tickets；既有 seam 不重问；无 review brief 不开 reviewer；未定产品取舍升级；report 已读不关闭 issue。
- 保存变更前后的入口清单与实际来源；文件可解析不能当成运行时已加载。

**在隔离临时环境、经授权的行为验证：**

1. pi 默认 -ns；只加载选定 worker skill；manual-only 不自动出现；broken link 在 skipped_skills 可见。
2. CLI frontend-imp/oracle 在项目 plugin 开／关两种明确配置下，核实实际可见方法；用无副作用小任务确认不会再分派、提交、写 issue。这是 loader＋行为验收，不可只凭文件存在。
3. 三主会话各做一次最小 brief→问题→答复→报告→主会话拒绝／修复的真实闭环；遵守各自等待工具上限。offline fixture 通过不能代替这一步。
4. worktree 用实际 cwd 查 roster，验证项目注册、skill 路径、worker prompt 真正到达。
5. 未提交 diff/untracked 文件可被 reviewer 看见；不是误用 `git diff base...HEAD` 得到空 diff。
6. 一个 ticket 两次 attempt；第一次失败不关闭 ticket；重复 create key 不再派发；不确定发送保留原 handle。
7. 报告归档后删除临时 job 的合成场景仍能从 tracker／handoff恢复决定与验收证据，不需重新问 Jacob。

若实现 Project 新投影，再加少量行为测试：离线／401／限流显示 stale/unknown；两项目同 slug 不串票；decision resolved 不计 implemented；checklist 全勾不越过项目接受语义；大 backlog 被截断有明确说明；渲染无网络／写 tracker。保持当前性能边界，不把每种内部 JSON 字段都变成独立测试。

**试点成功指标**建议只看几个实际结果：Jacob 是否少重复解释、worker 是否更少因 brief 缺口返问、首次交付是否可用、同类任务总时间／token／review 数是否下降，以及是否出现越界 spawn/commit/关闭 issue。不要把“用了更多 skill、产出更多文档”当成功。

## 7. 上游更新与维护方式

### 7.1 采用“有来源的本地方法”，不是每次追上游同步

Matt README 自己鼓励 composable、可改造方法；其 plugin 自动更新，editable copies 手工更新，且建议同一 agent 不要两种都装造成重复（`M/README.md` Installation）。目前 Claude cache 与 U 已不同，不能用同一个名字作版本证明。

建议一份短来源记录即可：

```text
method: worker-tdd
upstream: mattpocock/skills + commit + source path
adopted: 公共 seam、独立 expected、逐条红绿
local differences: brief 替代 user 确认；无调度／提交；项目验证政策优先
last checked: 日期
```

- 保留 MIT 版权与许可（`M/LICENSE:1–13`），在适配目录注明 derived from，不冒充官方版本。
- `U/` 留干净参照；升级是人工选取有价值的变化，不把 pull 自动作用到运行中的 worker 方法。
- 适配方法从稳定维护源加载，不直接 symlink 到随 pull 改内容的上游分支。
- 更新时同时审 body、description、invocation metadata、引用的 references／scripts，不只看 SKILL.md 名字。codebase-design 表面像纯参考，引用却会开 3+ agents，就是实例。
- 每次只更新实际采用的方法，跑与差异相关的加载／场景检查；没有行为变化的文字修订不必启动一轮真实多 agent 测试。
- 记录已采纳 commit 是可追溯来源，不是给 HUD 加“拒绝其他 vendor 版本”的 runtime pin。现行 HUD spec 不做 vendor version pins（`H/docs/spec.md:70`）。

### 7.2 注意此前 owner 的决定

历史一手 brief 曾明确“Matt unchanged，个人调整放 convention／角色”，且 TDD 只是 trial（`H/docs/handoff/2026-11-10-orchestrator-brief.md:87–109`）。本次开放调研允许质疑是否适配，但**不等于已经批准推翻并安装 fork**。

本建议承认那个决定的合理部分：不 fork 执行平台，不把完整 workflow 常驻。现在新证据是更广的 plugin 发现面、CLI worker 项目级加载、三端不同快照、旧桥接文档未同步。若 owner 选择改写，应该明确替换此前“完全不改 skill”的维护政策，而不是悄悄实施。

## 8. Jacob 没问到但值得先想清楚的事

### 8.1 人类决策时限与 AFK 并不兼容

HUD legacy QA 二十分钟后返回 default（`H/packages/hud-mcp/README.md:141–142`；`R/README.md` ask_orchestrator 协议）。Matt grilling／wayfinder 的 HITL 要求本人回答；不能把“默认最简单”解释成“用户同意”。更好的默认是停依赖决策的部分并报告。若希望真正跨夜等待，需要另一个明确生命周期设计，而不是把 skill 文案写成“永远等待”。

### 8.2 request_key 不是 ticket 身份，也不是跨会话原子 claim

[源码] create 在 retained jobs 中只按 request_key 查重（`thin-main.ts:801–807`），不是 project+ticket+attempt；同日不同项目同 slug 可能碰撞。建议主会话生成含项目／ticket／attempt 的稳定 key，重试沿用，换工作才换 key。多个主会话用同一个 GitHub assignee 也不能形成互斥 claim。初期采用一个明确 scheduler owner，不需要马上建设租约服务；如果确有并发主会话场景，再做窄的协调方案。

### 8.3 上游的“最大并发”不是本机的正确目标

独立 worktree 不代表构建资源、浏览器、API 限额、桌面输入、共享安装目录彼此独立。JevDev 还有真实模型费用与 Windows 接管验收，不能用文件不重叠就判可并行。采用现有 teaming 对资源预算的思想即可，不需要另建监控 agent。

### 8.4 上游 skill 不只是提示词，也是能力入口

prototype 会 commit 分支，wayfinder 会 push，wizard 会操作 env/CI secrets，triage 会发评论和关 issue。给 worker 加 skill 不等于只增强推理；它可能改变副作用范围。对于本地可信单人场景，无需新建复杂权限框架，但必须按实际执行主体裁剪。

### 8.5 Claude 的只读顾问不是运行时强隔离的同义词

Oracle 的只读主要由角色指令声明；HUD CLI 启动还带 permission-bypass 类参数。不能宣称“oracle 这个名字使加载的任何方法都无副作用”。同样 pi-roles guard 是 backstop，不是所有 bash／MCP 的完美 sandbox（`R/README.md` Read-only guard）。这支持精选方法，而非堆叠互相矛盾的权限说明。

### 8.6 报告内容可能离开本机

HUD 可选模型摘要会读取 brief、问题、report 部分与 session public tail，输入边界列在 `H/docs/ARCHITECTURE.md` §5。接入 GitHub 私有 issue、Windows 活动数据或研究材料时，不能因“worker 只读本地文件”就忽略展示层模型输入。按现有开关与项目隐私边界决定，不新增未请求的安全平台；brief 与长久归档都只含必要材料。

### 8.7 规格化可能反而降低对齐

“极长 user stories”“所有分支必须解决”“每次 review 所有 smells”容易把一个明确小需求膨胀成程序。Jacob 欣赏的应是**外显重要假设和形成反馈**，不是文档数量。spec/ticket 应只在跨上下文、跨天、跨 writer 或存在验收歧义时购买其维护成本。MyHUD 已明确一 session 能完成的小特性不必拆票，应坚持。

### 8.8 每项能力都有“无需 skill”的替代

主会话能直接问一个好问题、写十行 brief、读一个 diff；skill 的必要性来自反复出现的可避免错误，而不是一种方法本身正确。建议以一两个真实 slice 的结果判断哪些方法留下，允许把试点中没有改变行为的句子／入口删掉。这与 Matt writing-for-agents 的 no-op/pruning 方法本身一致。

## Optional hardening

以下都不是第一阶段必做：

- **显式 ticket_ref + project identity**：消除数字／slug 启发式误关联；成本是 MCP schema、job reader、三端代理与 UI 的兼容测试。只有实际需要 ticket 展示时做。
- **CLI worker 插件隔离能力**：减少加载冲突；成本是逐 CLI 版本验证、安装／会话行为测试，并涉及当前 pi-only 定制边界。先用受控入口和 brief。
- **长期报告归档自动化**：避免一天清理遗失；成本是保留／删除政策与存储维护。先由主会话在接受时保存重要结果即可，不复制全部 session。
- **跨主会话 claim 协调**：解决同账号多 scheduler 抢票；成本是额外状态与失效恢复。单主会话试点无需。

## Scope

**inside task：**本报告的只读调查、逐 skill 取舍、层级设计与实施建议已完成；没有实际安装、配置修改、发布 issue、提交或启动 agent。

**needs orchestrator：**是否以局部适配替换历史“Matt unchanged”政策；是否改变 JevDev 的项目插件发现入口；是否恢复安装修复后的 hud-handoff；是否投资 GitHub→Project 展示；以及跨 MyHUD、Fishpref/pi-roles、MySkills、JevDev 的路径分工。这些是后续获授权工作，不是本报告默认执行的副作用。

**建议最终决定：先 P0，再一个 JevDev slice 的 P1；继续 GitHub 作为唯一 tracker，暂不改 HUD runtime。只有试点暴露确切缺口才做 P2。**
