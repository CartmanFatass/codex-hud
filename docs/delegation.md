# MyHUD 委派工作流（2026-11-01 建，2026-11-07 改为 pi 统一 harness）

当前产品范围以概念方案 §15「2026-11-07 Scope convergence: fixed roles, herdr execution, owned Jev」为准。实施队列是 `docs/handoff/STATE.md` 的 R0–R7。HUD 提供固定角色门面，herdr 执行 CLI，自有 Jev 运行时执行浏览器作业，主会话负责步骤衔接。通用 agent host、WF1 执行器与 `hud-run` 不在该队列。

本项目的任务路由。编排者（Claude Code）按这张表派活，不自己写代码、不自己做逐行评审。本文是路由的唯一出处。

## 角色（2026-11-07，Jacob 定）

分两层。**代码层**负责详细的代码任务，三个角色都跑在 pi 上（pi-roles 包，`pi-role` 启动器，skill `herdr-delegate`）：

| 角色 | 模型 | 职责 |
|---|---|---|
| **implementer** | `openai/gpt-6.1-sol`，thinking high | 按 brief 实现、跑检查；遇到设计分叉自己问 architect；检查通过后自己起 reviewer 收尾，按评审修复并复核 |
| **reviewer** | `openai/gpt-6.1-sol`，thinking xhigh | 只读独立评审最终 diff，首行给 `Verdict: accept / changes-required`；每轮复核是新的 reviewer |
| **architect** | `openai/gpt-6-astra`，thinking high | 只读，回答单个任务内的设计分叉（不变量、契约、数据形状、失败行为），裁决对该任务有约束力；超出任务范围的写明 `needs orchestrator` |

**决策层**负责关键节点的抉择，不做代码评审：

| 角色 | 执行者 | 职责 |
|---|---|---|
| **Argon** | Gemini 4 Argon（AI Studio，skill `jev-ask` 的 `jev-aistudio`） | 新功能的头脑风暴、提案与原型设计：开放、发散、创新的问题，前端信息展示与可视化设计。prompt 必须自足；流程已验证，直接发送，只在 UI 变化或失败后先 dry-run |
| **ChatGPT Pro** | jev-ask | 收敛：评审 Argon 提案并定稿、详细架构、阶段边界评审。每个 key 只发一次；Pro 通过 GitHub 连接器读 `CartmanFatass/codex-hud`，先推送再在 prompt 里引用仓库路径；答案归档 `docs/reviews/<date>-pro-<topic>.md` |

旧 Oracle 角色按擅长点拆开：任务内的代码级设计分叉交 architect，新功能提案交 Argon，收敛定稿交 Pro。改名为 architect 是为了不和产品里的 oracle 角色 / 阶段（R1）混淆。Fable 设计子代理、Oracle 独立 tab 咨询与 Opus 子代理临时评审都已停用。Codex 调度（skill `herdr-delegate-codex`，Codex implementer + Oracle 子代理）保留为 legacy 备份，不进入工作流，只在 Jacob 明确要求时使用。

## 路由表

| 任务类型 | 执行者 | 怎么调 |
|---|---|---|
| 代码任务（核心、开放型、普通、测试、按评审修复，不分大小） | **pi implementer**（sol high），右侧窗格自调 architect 与 reviewer | skill `herdr-delegate`：一个 WP 一个 herdr tab，implementer 在左、helper pane 在右；编排者写 brief 与 `SESSION.txt`，只启动 implementer、等它结束、验收 |
| Claude 写的变更的评审 | **pi reviewer**（sol xhigh），编排者单独起 | skill `herdr-delegate` 的 review-only 流程 |
| 任务外的代码级设计咨询（单个模块、单个契约内部） | **pi architect**（astra high），编排者单独起 | 同上，architect 角色 |
| 新功能提案、跨 WP 或改范围的设计 | **Argon** 出提案 → **Pro** 收敛 | 见上表 |
| 前端实现：按已定设计写渲染、布局、文案、视觉基线 | **Claude Code 子代理 `frontend-implementer`**（sonnet，xhigh） | Agent 工具，`subagent_type: frontend-implementer`，传 brief 路径；设计以 Argon → Pro 定稿的设计文档（`docs/design/`）为准；评审交 pi reviewer |
| 需要人类互动的测试：对话框、真实输入、Windows Terminal 视觉验收 | **Hermes**（Windows computer use，grok-4.7，一次性运行） | 脚本先摆好状态，再给 Hermes 一个任务文件；证据以其 usage JSON 与截图为准。参照 ux / JevFocus 项目的做法 |
| Codex 相关测试（产品对 Codex 客户端的真实检查） | `codex2`（`CODEX_HOME=~/.codex`，免费账号），`gpt-6-luna` medium | `codex` 函数是主账号（`~/.codex-account2`），不用于测试 |
| 编排、验证报告、提交 | **Claude Code 编排者**（Herdr 内，opus） | 本文 + STATE.md |

## 升级规则

- 同一 WP 评审到第 3 轮仍是 `changes-required`、检查命令跑不绿、或报告与实际不符：编排者先分清是**代码缺陷**还是**环境 / 基线问题**（依赖没装、基线本来就红、Herdr 不在跑），环境问题修环境。代码缺陷交一个新 implementer，短 fix brief 写明保留什么、重做什么、相关 review 文件；仍不收敛就问 Jacob。
- 设计分叉怎么走：任务内、可由代码与规格判断的 → implementer 问 architect（`pi-role-call architect`），先拿裁决再写受影响部分。architect 判为 `needs orchestrator`、或跨 WP、改范围、改契约所有权的 → implementer 用 `ask_orchestrator` 上报并写下默认方案，继续不受影响的部分；编排者攒包，开放型先交 Argon 出提案再交 Pro 收敛，定义清楚的直接交 Pro。只暂停受影响的工作包。可逆的实现选择（内部结构、命名、先做哪个用例）由 implementer 自己定并在报告里写明理由。

## 分类规则

- 每个 WP 或里程碑一个新 implementer，做完即关；不在一个 pi 会话里串多个任务。
- 并行度按情况提高：所有权不重叠的 WP 可同时开（各自一个 tab，最好各自一个 worktree），写明独占路径；共享文件的串行。
- 拥有进程、信号或生命周期的代码（起停子进程、组信号、清理、回收）：brief 必须把失败场景写进验收（对比评测 O1：名义上是普通任务，三臂都没过）。
- 一个决定只审一次（Jacob，2026-11-02）：Pro 定稿的内容不再送 architect 复核；architect 裁决过的不再送 Pro，除非 architect 判为超出范围（那时它不出裁决）。同一份设计不叠加两级评审；同一份 diff 只有一个 reviewer 链。
- 核心 brief 写法（2026-11-02 起）：①把评审者常用的失败场景写进验收，要求真实进程测试（提交前后崩溃、竞态与交错、进程号/PGID 复用、中断后残留进程、重复/乱序事件、并发下的 p95）；②已知的设计分叉在 brief 里写明，让 implementer 实现前先问 architect；③复杂包可拆里程碑推进，评审只在最终 diff 上做。

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
- 当时的路由：普通（明确型）→ pi Flash；核心 / 复杂 / 开放型 → Codex sol。2026-11-07 起 pi 直接用 sol，implementer 统一为 pi sol high，这一区分不再需要。
- 撤掉评测或 WIP worktree 前先把成果提交到其分支（O2 落选臂的代码因未检查的空补丁丢失）。

## 约定

- 每个 WP 一个目录 `tmp/tasks/<WP>/`：`brief.md`、`SESSION.txt`（编排者写），运行中产生 `impl-notes.md`、`review-N.md`、`architect-N.md`、`report.md`、`qa/`、`sessions/`。`tmp/` 已被 git 忽略；合入时把最终 review 与 architect 答复归档到 `docs/reviews/`。
- 检查命令：`npm test`、`npm run format:check`、`npm run test:visual`，加上 WP 自己列的。实现者报告里必须贴实际输出。
- **主审规则：** 每个变更一条 reviewer 链：implementer 自己起的 pi reviewer 做首评，每轮修复后由新的 reviewer 带上一轮 review 复核，最多 3 轮；"通过"绑定最终 diff，diff 再动就要再审。Claude（含 `frontend-implementer`）写的变更由编排者单独起 pi reviewer。不叠加第二个评审者；编排者自己的验证是验收，不是第二次评审。
- **并行隔离：** 同时开的工作包各用自己的 git worktree，或在 brief 里划定互不重叠的文件所有权；先由编排者整合（合并 / 应用补丁、跑全量检查），再按整合后的状态验收，不对各自分支的结果单独算通过。
- 提交由编排者在最后一轮 `Verdict: accept` 并验收后做；实现者、reviewer、architect 都不做 git 写操作。
- **收尾顺序：** 先把报告存到 `tmp/tasks/<WP>/report.md`，再确认运行已结束（`herdr agent get` 为 idle / exited，或 hud-run 回执已到），最后才关表面（`/quit` + `herdr tab close`）。每个检查点跑 `herdr agent list` 清理。
- Jev：浏览器作业走自有 Jev 运行时（按需、仅 Jev）；同一时段不与直接 CLI 混用；共享浏览器串行，每个 key 只发一次。
- Argon / Pro 节奏：新功能与跨 WP 的分叉随时攒包，Argon 提案、Pro 收敛；R 队列的阶段边界送 Pro 一次；两者都不当代码评审用。
- 仓库公开：fixture、文档、评审归档只用合成数据，不贴真实会话正文。
