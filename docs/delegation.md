# MyHUD 委派工作流（2026-11-01 建，2026-11-07 改为 pi 统一 harness 与三层角色）

当前产品范围以概念方案 §15「2026-11-07 Scope convergence: fixed roles, herdr execution, owned Jev」为准。实施队列是 `docs/handoff/STATE.md` 的 R0–R7。HUD 提供固定角色门面，herdr 执行 CLI，自有 Jev 运行时执行浏览器作业，主会话负责步骤衔接。通用 agent host、WF1 执行器与 `hud-run` 不在该队列。

本项目的任务路由。编排者（Claude Code）按这张表派活，不自己写代码、不自己做逐行评审。本文是路由的唯一出处。

## 角色（2026-11-07，Jacob 定）

分三层。

**宏观层**：项目的关键问题与新方向，不做代码评审。

| 角色 | 执行者 | 擅长 | 用在 |
|---|---|---|---|
| **Argon** | Gemini 4 Argon（AI Studio，skill `jev-ask` 的 `jev-aistudio`） | insight：发散、提案、换角度 | 新功能的头脑风暴与提案、前端信息展示与可视化方向、卡住时找新思路。prompt 必须自足；流程已验证，直接发送 |
| **ChatGPT Pro** | jev-ask | architect 模型的高级版本，需求与方案明确后最强 | 评审并优化 Argon 的方案、关键架构的评审与定稿、阶段边界评审。每个 key 只发一次；Pro 通过 GitHub 连接器读 `CartmanFatass/codex-hud`，先推送再引用仓库路径；答案归档 `docs/reviews/<date>-pro-<topic>.md` |

**设计与实现层**：都跑在 pi 上（pi-roles 包，skill `herdr-delegate`）。

| 角色 | 模型 | 对应 | 职责 |
|---|---|---|---|
| **architect** | `openai/gpt-6-astra`，thinking high | 架构师：做正确的事 | 设计顾问：工作包级的体系设计方案（整体结构、边界与契约、扩展性、稳定性、运行成本），以及实现中上报的分叉的选项与建议。只由编排者调用，结论是建议，编排者定稿。只读 |
| **implementer** | `openai/gpt-6.1-sol`，thinking high | 程序员：正确地做事 | 按 brief 与定稿设计实现代码、函数与局部性能，跑检查；只能调 sonic（简单子任务）与 reviewer（收尾），设计分叉用 `ask_orchestrator` 交编排者 |
| **reviewer** | `openai/gpt-6.1-sol`，thinking xhigh | 独立评审 | 只读评审最终 diff，首行 `Verdict: accept / changes-required`；每轮复核是新的 reviewer，最多 3 轮 |

**快速执行层**：

| 角色 | 模型 | 职责 |
|---|---|---|
| **sonic** | `mistral/deepseek-v4-1-flash-1017` 或 `mistral/zai-glm-5-3-flash`，effort 按任务类型 | 简单代码任务、按既定方法补测试、scout（侦察定位，跑 informer 只读角色）、杂务与机械任务。需要设计判断的不归 sonic |

旧 Oracle 角色按擅长点拆开：工作包级的设计方案交 architect，insight 交 Argon，收敛与优化交 Pro。改名为 architect 也避开了产品里的 oracle 角色 / 阶段（R1）。Claude 内只保留 `frontend-implementer` 子代理（sonnet，xhigh）；其他 Claude 子代理（Fable 设计、Opus 评审、Explore 等）不用于项目工作，Oracle 独立 tab 与 Grok 也已退出工作流。Codex 调度（skill `herdr-delegate-codex`）保留为 legacy 备份，只在 Jacob 明确要求时使用。

## 决策权（2026-11-07，Jacob 定）

- **编排者是唯一的决策者。** 设计定稿、分叉裁决、范围取舍都由编排者做；拿不准的问 Jacob。
- **architect、Argon、Pro 只出建议。** 三者都只由编排者调用。architect 模型有时会过度防御、过度设计：编排者批判地读它的方案，砍掉需求没要求的防御、层次、配置与扩展点（它的 `Optional hardening:` 清单是可选项），保留真正保护不变量的部分，把定稿写成 `design.md` 或直接写进 implementer 的 brief，并注明砍了什么、为什么。Argon 的提案与 Pro 的评审同样是输入，不自动采纳。
- **implementer 只能调 reviewer 与 sonic。** 不能调 architect（`pi-role-call architect` 在 pi 内部会被拒绝）；设计分叉一律 `ask_orchestrator` 交编排者，编排者需要时自己调 architect，再答复。
- **reviewer 的结论约束代码质量，不约束设计。** 需要改设计的评审发现，由 implementer 上报编排者决定。

## 调度流程

编排者（Claude Code 主会话）启动的每个 agent（implementer、sonic、architect、单独的 reviewer、对比的每一臂）都开独立 tab，一个任务一个 tab，便于观察；只有 implementer 的 tab 分左右，右侧窗格由 implementer 自己调 architect 与 reviewer。每接到一项工作，按下面的顺序判断：

1. **是不是宏观问题？** 新功能方向、范围变化、项目卡住的关键问题、跨多个工作包的取舍。是：需要新思路时先发 Argon 出提案，再把提案交 Pro 评审优化；需求与方案已经明确的直接交 Pro。编排者读完两者后定稿（拿不准问 Jacob），写进概念方案 §15 或 `docs/design/`，再拆成工作包。
2. **工作包需不需要先设计？** 引入新结构、新契约、拥有进程或生命周期、影响稳定性或运行成本的，编排者先调 architect 出方案（独立 tab，`pi-role-call architect`），再自己定稿，implementer 的 brief 指向定稿设计。小改动、设计已在规格里写死的跳过。
3. **谁来写？**
   - 需要判断、改动成片或涉及核心的代码 → **implementer**。它在左侧窗格实现；简单子任务可交 sonic（右侧窗格）；设计分叉上报编排者；检查通过后自己起 reviewer，修复到 `accept`（最多 3 轮）。
   - 目标、方法、验收都写死的简单任务 → **sonic**，按下表选 effort；会合入的代码与测试写 `review: yes`，杂务与机械任务由编排者自己的检查验收。
   - scout（找代码、摸清现状、汇总）→ sonic 模型跑 informer 只读角色，effort high。
   - 渲染与视觉 → `frontend-implementer` 子代理，按定稿设计；评审交 pi reviewer。
   - 需要人类互动的测试 → Hermes。
4. **sonic 用哪个模型？** 对比期间，sonic 任务可以两个模型同时跑（每个模型一个 tab，代码任务各自 worktree），一个 reviewer 盲评两份产出，择优采用，成本、用时与质量记入 `docs/sonic-ab.md`。积累够了再定默认模型或按任务类型分流。
5. **验收与提交。** 编排者读 report 与每轮 review，重跑检查，确认最后一轮是 `accept`；通过后提交、推送，把有用的 review 与 architect 答复归档到 `docs/reviews/`。不收敛时按升级规则处理。
6. **收尾。** 关 agent、关 tab、跑 `herdr agent list` 检查点。

两个 sonic 模型只支持 `low`、`high`、`max`（`medium` 会被 pi 映射成 `high`）：

| sonic 任务 | effort |
|---|---|
| 机械任务（改名、移动、重新生成、格式化、搬运文案）、简单杂务（文档、配置） | low |
| scout、脚本、fixture、简单代码、按既定方法补测试、按评审意见修复 | high |

需要 `max` 的任务不归 sonic，交 implementer。

## 路由表

| 任务类型 | 执行者 | 怎么调 |
|---|---|---|
| 新功能方向、关键问题需要新思路 | **Argon** → **Pro** | skill `jev-ask`（`jev-aistudio` / Pro） |
| 方案明确的关键架构评审、Argon 方案的优化 | **Pro** | skill `jev-ask` |
| 工作包设计方案、实现中上报的分叉 | **architect**（astra high），只由编排者调用；编排者定稿 | 编排者用 `pi-role-call architect`（独立 tab） |
| 需要判断的代码任务（核心、开放型、成片改动、进程与生命周期代码） | **implementer**（sol high）+ 自调 reviewer（sol xhigh） | skill `herdr-delegate`：一个 WP 一个 tab，implementer 左、helper pane 右 |
| 简单代码、补测试、按评审修复、杂务、机械任务 | **sonic**（DeepSeek V4.1 Flash / GLM-5.3 Flash，effort 见上） | skill `herdr-delegate` 的 sonic 流程；对比期可双模型并跑 |
| scout | sonic 模型上的 **informer** 只读角色 | `pi-role informer ... -- --model <sonic 模型> --thinking high` |
| Claude 写的变更的评审 | **reviewer**（sol xhigh），编排者单独起 | skill `herdr-delegate` 的 review-only 流程 |
| 前端实现：按已定设计写渲染、布局、文案、视觉基线 | **Claude Code 子代理 `frontend-implementer`**（sonnet，xhigh） | Agent 工具，`subagent_type: frontend-implementer`，传 brief 路径；设计以定稿设计文档（`docs/design/`）为准 |
| 需要人类互动的测试：对话框、真实输入、Windows Terminal 视觉验收 | **Hermes**（Windows computer use，grok-4.7，一次性运行） | 脚本先摆好状态，再给 Hermes 一个任务文件；证据以其 usage JSON 与截图为准。参照 ux / JevFocus 项目的做法 |
| Codex 相关测试（产品对 Codex 客户端的真实检查） | `codex2`（`CODEX_HOME=~/.codex`，免费账号），`gpt-6-luna` medium | `codex` 函数是主账号（`~/.codex-account2`），不用于测试 |
| 编排、验收、提交 | **Claude Code 编排者**（Herdr 内，opus） | 本文 + STATE.md |

## 升级规则

- sonic 报告需要设计判断、改动超出指定文件、或检查跑不绿且原因不在环境：这部分改交 implementer，brief 写明保留哪些成果。
- implementer 评审到第 3 轮仍是 `changes-required`、检查跑不绿、或报告与实际不符：先分清是**代码缺陷**还是**环境 / 基线问题**（依赖没装、基线本来就红、Herdr 不在跑），环境问题修环境。代码缺陷交一个新 implementer，短 fix brief 写明保留什么、重做什么、相关 review 文件；涉及设计的先回 architect；仍不收敛就上 Pro 或问 Jacob。
- 设计分叉：implementer 用 `ask_orchestrator` 上报并写下默认方案，继续不受影响的部分。编排者能从代码与规格判断的直接答复；需要设计意见的调 architect 再定；属于宏观层的（跨 WP、改范围、改契约所有权）按调度流程第 1 步走 Argon / Pro，拿不准问 Jacob。只暂停受影响的工作包。可逆的实现选择（内部结构、命名、先做哪个用例）由 implementer 自己定并在报告里写明理由。

## 分类规则

- 每个 WP 或里程碑一个新 implementer / sonic，做完即关；不在一个 pi 会话里串多个任务。
- 并行度（2026-11-08 所有者定）：用 implementer 数量控制并发，同时约 3 个（高并发对本机硬件压力大）。各 implementer 按需调 sonic / reviewer，通常同时只多一个 helper，所以整机约 5 个 pi agent，这只是参考值，不是硬上限。满 3 个时新 WP 排队，等一个 implementer 收尾（reap）后再开。
- 所有权不重叠的 WP 可同时开（各自一个 tab，最好各自一个 worktree），写明独占路径；共享文件的串行。
- 拥有进程、信号或生命周期的代码（起停子进程、组信号、清理、回收）→ implementer，编排者先调 architect 出方案并定稿，brief 把失败场景写进验收（对比评测 O1：名义上是普通任务，三臂都没过）。
- 拿不准是 sonic 还是 implementer 的，给 implementer。
- 一个决定只审一次（Jacob，2026-11-02）：同一份设计不叠加两级评审；Pro 评审过的不再送 architect，architect 出过方案的不再送 Pro，除非编排者判断它属于宏观层。同一份 diff 只有一个 reviewer 链。
- 核心 brief 写法（2026-11-02 起）：①把评审者常用的失败场景写进验收，要求真实进程测试（提交前后崩溃、竞态与交错、进程号/PGID 复用、中断后残留进程、重复/乱序事件、并发下的 p95）；②已知的设计分叉由编排者在 brief 里定好，不留给 implementer；③复杂包可拆里程碑推进，评审只在最终 diff 上做。

## 实施者对比评测结论（2026-11-02，Jacob 定）

同一 brief、同一基线、单代理、sol max 盲审、一轮修复后复审；Codex sol high / pi DeepSeek V4.1 Flash max / pi GLM-5.3 max 三臂，两个普通任务、两个复杂任务（记录在 `tmp/tasks/EVAL-IMPL/`）。

| 任务 | Codex sol | pi Flash | pi GLM-5.3 |
|---|---|---|---|
| O1 普通（B14 空闲成本 runner，进程回收） | 6，未过 | 6，未过 | 6，未过 |
| O2 普通（B11 `hud link export`） | 9，通过（合入） | 9，通过 | 6，未过 |
| X1 复杂（B16 五维归并） | 7，修复后通过（合入） | 5，未过 | 5，未过 |
| X2 复杂（B3b 可见终端模式） | 6 → 8，修复后通过（合入） | 3，未修复轮 | 4，未修复轮 |

- 普通任务 pi Flash 与 Codex 持平；复杂任务差距随复杂度拉大，pi 两臂在复审后仍有多条 P0。
- 各臂自写测试全部通过，P0 全部来自评审者的独立探针：主审不可省。
- GLM-5.3 质量不高于 Flash，耗时与费用最高（每任务 $3–13）：不再作为 implementer。
- 当时的路由：普通（明确型）→ pi Flash；核心 / 复杂 / 开放型 → Codex sol。2026-11-07 起 implementer 是 pi sol high，Flash 类模型转为 sonic，只接简单任务；GLM-5.3 Flash 与 DeepSeek Flash 的对比见 `docs/sonic-ab.md`。
- 撤掉评测或 WIP worktree 前先把成果提交到其分支（O2 落选臂的代码因未检查的空补丁丢失）。

## 约定

- 每个 WP 一个目录 `tmp/tasks/<WP>/`：`brief.md`（编排者写）、`SESSION.txt`（`pi-dispatch` 写），运行中产生 `STATUS.json`、`impl-notes.md`、`review-N.md`、`architect-N.md`、`report.md`、`qa/`、`sessions/`。`tmp/` 已被 git 忽略；合入时把最终 review 与 architect 答复归档到 `docs/reviews/`。
- 检查命令：`npm test`、`npm run format:check`、`npm run test:visual`，加上 WP 自己列的。实现者报告里必须贴实际输出。
- **主审规则：** 每个变更一条 reviewer 链：implementer 自己起的 pi reviewer 做首评，每轮修复后由新的 reviewer 带上一轮 review 复核，最多 3 轮；"通过"绑定最终 diff，diff 再动就要再审。Claude（含 `frontend-implementer`）写的变更由编排者单独起 pi reviewer。不叠加第二个评审者；编排者自己的验证是验收，不是第二次评审。
- **并行隔离：** 同时开的工作包各用自己的 git worktree，或在 brief 里划定互不重叠的文件所有权；先由编排者整合（合并 / 应用补丁、跑全量检查），再按整合后的状态验收，不对各自分支的结果单独算通过。
- 提交由编排者在最后一轮 `Verdict: accept` 并验收后做；实现者、reviewer、architect 都不做 git 写操作。
- **启动与收尾：** pi 角色一律用 `pi-dispatch <role> --task-dir tmp/tasks/<WP> --workdir <dir> --output tmp/tasks/<WP>/report.md`（implementer 加 `--split`）；完成时 DONE / FAILED 一行推到编排者窗格。报告验收后跑 `pi-role-reap tmp/tasks/<WP>` 关掉该任务的 agent 与 tab；每个检查点（提交前、阶段报告前）跑 `pi-role-reap --sweep tmp/tasks`。不手工 `/quit` 或关 tab。
- Jev：浏览器作业走自有 Jev 运行时（按需、仅 Jev）；同一时段不与直接 CLI 混用；共享浏览器串行，每个 key 只发一次。
- Argon / Pro 节奏：新功能与跨 WP 的分叉随时攒包，Argon 提案、Pro 收敛；R 队列的阶段边界送 Pro 一次；两者都不当代码评审用。
- 仓库公开：fixture、文档、评审归档只用合成数据，不贴真实会话正文。
