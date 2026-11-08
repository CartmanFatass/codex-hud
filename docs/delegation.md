# MyHUD 委派工作流（2026-11-01 建，2026-11-07 统一）

当前产品范围以概念方案 §15「2026-11-07 Scope convergence: fixed roles, herdr execution, owned Jev」为准。实施队列是 `docs/handoff/STATE.md` 的 R0–R7。HUD 提供固定角色门面，herdr 执行 CLI，自有 Jev 运行时执行浏览器作业，主会话负责步骤衔接。通用 agent host、WF1 执行器与 `hud-run` 不在该队列。

本项目的任务路由。编排者（Claude Code）按这张表派活，不自己写代码、不自己做逐行评审。本文是路由的唯一出处；STATE.md 只记当前额度状态。

## 当前阶段（2026-11-07 起，本地）

- **编排：** Opus 主会话，派活、验收、合入、推送，并与 Jacob 沟通。
- **额度状态：** Grok 周额度已用完（2026-11-07），Codex 主账号 7 天额度也已用完。R4、R5 等 Codex 额度恢复后交 Codex 做（Jacob 定），期间不改派 pi 或 Grok。Grok 恢复以 Jacob 告知为准；Grok 提示 upgrade 或 buy credits 时一律不选。
- **评审（临时）：** Codex 额度不足期间，所有评审交 **Opus 子代理（Agent 工具，`model: opus`，`effort: high`）**：编排者写评审 brief（diff 与基线、规格、要重跑的检查），转述结论并分派修复。额度恢复后回到下表的 Codex 路线，切回时间问 Jacob。
- **Codex 相关测试：** 用 `codex2`（`CODEX_HOME=~/.codex`，免费账号），模型 `gpt-6-luna`，effort medium。`codex` 函数是主账号（`~/.codex-account2`，sol），不用于测试。

## 路由表

| 任务类型 | 执行者 | 怎么调 |
|---|---|---|
| 设计提案：开放、发散或创新的问题，架构原型，前端信息展示与可视化设计 | **Argon**（Gemini 4 Argon，AI Studio） | skill `jev-ask` 的 `jev-aistudio`；prompt 必须自足；流程已验证，直接发送，只在 UI 变化或失败后先 dry-run |
| 设计收敛与详细架构：定义清楚、需要严谨论证的问题；Argon 提案的评审与定稿；阶段边界评审 | **ChatGPT Pro**（经 jev-ask） | skill `jev-ask`，每个 key 只发一次；Pro 通过 GitHub 连接器读 `CartmanFatass/codex-hud`，所以先推送，prompt 里引用仓库路径；答案归档 `docs/reviews/<date>-pro-<topic>.md` |
| WP 内的设计分叉（Codex implementer 实现中遇到） | **Oracle 子代理**（Codex `gpt-6-astra`，effort max），由 implementer 自己起 | 见分类规则「Codex implementer 自调 Oracle」；跨 WP 或改范围的分叉走 Argon → Pro |
| 核心任务（当前队列 R0–R7）：角色与绑定、herdr 门面、自有 Jev 运行时、树与摘要、安装与退役 | **Codex implementer**，`gpt-6.1-sol`，effort high | skill `herdr-delegate-codex`；brief 里写明 Subagent plan（tier S / M / L）；主审与验收是 Oracle 子代理（`gpt-6-astra` max），不再另起 sol reviewer 子代理 |
| 开放型任务：需要自己设计方法或从观察下结论的任务，如新探针、原型、调研 | **Codex implementer**，`gpt-6.1-sol`，effort high | 同上；brief 要求结论只覆盖实测配置 |
| 普通实现任务（Grok 有额度时） | **Grok Build**，`grok -m grok-4.7 --reasoning-effort high` | headless `-p` / `--prompt-file`，或开 herdr tab；Grok 没额度时改交 pi implementer |
| 普通任务（明确型）与测试任务：目标、方法、产出与验收都已写明，如按评审意见修复、按既定方法补测、fixture、测试基建、基准脚本、skill 与文档更新、改名 | **pi implementer**（DeepSeek V4.1 Flash，pi-roles），每段一个新 pi、短段 | skill `herdr-delegate` |
| 评审（每个变更一个主审）：pi、Grok、Claude 写的变更 | **Codex reviewer**，`gpt-6.1-sol`，effort **max**（临时：Opus 子代理，见上） | 跑在 pair tab 的右侧窗格，用 `codex -m gpt-6.1-sol -c model_reasoning_effort=max ...` 启动：pi-role 的 reviewer 没有 OpenAI 凭据。复核用新的 Codex 会话。Codex implementer 的变更由其 Oracle 子代理主审 |
| 前端实现：按已定设计写渲染、布局、文案、视觉基线 | **Claude Code 子代理 `frontend-implementer`**（sonnet，xhigh） | Agent 工具，`subagent_type: frontend-implementer`，传 brief 路径；设计以 Argon → Pro 定稿的设计文档（`docs/design/`）为准 |
| 需要人类互动的测试：对话框、真实输入、Windows Terminal 视觉验收 | **Hermes**（Windows computer use，grok-4.7，一次性运行） | 脚本先摆好状态，再给 Hermes 一个任务文件；证据以其 usage JSON 与截图为准。参照 ux / JevFocus 项目的做法 |
| 编排、验证报告、提交 | **Claude Code 编排者**（Herdr 内，opus） | 本文 + STATE.md |

Fable 设计子代理（2026-11-01）与 Oracle 独立 tab 咨询（`tmp/oracle-astra/`）已停用（2026-11-07），由 Argon → Pro 取代。

## 升级规则

- 普通任务交 pi implementer。若同一 WP 两轮评审后仍有 blocker、或检查命令跑不绿、或报告与实际不符，**升级到 Codex sol implementer**，并在工程计划书该 WP 旁记一笔。连续两个 WP 升级后，同类任务默认改走 sol。
- 升级前先分清是**代码缺陷**还是**环境 / 基线问题**（依赖没装、基线本来就红、Herdr 不在跑）：环境问题修环境，不算实现者的账。升级时接手方从现有有效成果（已通过的测试、已定稿的文件）继续，不默认全部重做；brief 里写明哪些保留、哪些重做。
- 核心任务从不降级到 pi。
- 设计分叉怎么走（2026-11-07 起）：编排者不自行裁决跨契约、不变量或范围的分叉：实现者写下默认方案并标"待 ARCH 裁决"，继续不受影响的部分；编排者把同一时段的分叉攒成一份问题包，开放型先交 **Argon** 出提案，再交 **Pro** 收敛定稿；问题本身已定义清楚的直接交 Pro。只暂停受影响的工作包。可逆的实现选择（内部结构、命名、先做哪个用例）由 CORE 自己定并在报告里写明理由，编排者验收时复核。

## 分类规则

- 给 pi 的任务切成短段（一个里程碑），每段一个新 pi，做完即关；不在一个 pi 会话里串多个任务（Jacob，2026-11-01）。
- 并行度按情况提高：所有权不重叠的段可同时开，各自写明独占路径；共享文件的段串行。

- 碰到契约、账本、身份、状态模型、reader、hud-run、Herdr 层、启动器中任何一个 → 核心任务。
- 拥有进程、信号或生命周期的代码（起停子进程、组信号、清理、回收）→ 核心任务，不论规模（对比评测 O1：名义上是普通任务，三臂都没过）。
- 信息展示与可视化的设计决策 → Argon 提案、Pro 定稿；按定稿设计改渲染、文案、视觉基线 → 前端实现。
- 其余（脚本、文档、fixture、配置）→ 普通任务。
- 拿不准按核心处理。
- 一个决定只审一次（Jacob，2026-11-02）：Pro 定稿的内容不再送 Oracle 复核；WP 内 Oracle 裁决过的不再送 Pro，除非 Oracle 自己判断超出范围而上送（那时 Oracle 不出裁决）。同一份设计不叠加两级评审。
- Codex implementer 自调 Oracle（Jacob，2026-11-02）：本 WP 实现中遇到的设计分叉，implementer 直接用子代理问 Oracle，不经编排者另开 tab：`spawn_agent {"task_name": "<WP>_oracle", "fork_turns": "none", "model": "gpt-6-astra", "reasoning_effort": "max", "message": <自足的问题包：分叉、选项、相关契约章节与代码路径、只读、不得再派子代理、答复写入 tmp/tasks/<WP>/oracle-<n>.md>}`。裁决对本 WP 有约束力，记入报告；先拿裁决再写受影响部分，不受影响的部分照常推进。裁决要改所有权以外的契约 / 共享类型时，implementer 停下问编排者；编排者合入时把答复归档到 `docs/reviews/<date>-astra-<WP>.md`，并按需写进 §15。跨 WP 或改范围的分叉仍由编排者攒包走 Argon → Pro。
- 核心 brief 写法（2026-11-02 起）：①把评审者常用的失败场景写进验收，要求真实进程测试（提交前后崩溃、竞态与交错、进程号/PGID 复用、中断后残留进程、重复/乱序事件、并发下的 p95）；②设计分叉在实现前送 Oracle 子代理，只暂停受影响部分；③复杂包可拆里程碑推进，审核验收只在最终 diff 上做一次（修复后由同一 Oracle 复核）。

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
- 路由不变：普通（明确型）→ pi Flash；核心 / 复杂 / 开放型 → Codex sol。
- 撤掉评测或 WIP worktree 前先把成果提交到其分支（O2 落选臂的代码因未检查的空补丁丢失）。

## 约定

- 每个 WP 一个目录 `tmp/tasks/<WP>/`：`brief.md`、`role.md`、`report.md`、`review.md`、`SESSION.txt`。`tmp/` 已被 git 忽略。
- 检查命令：`npm test`、`npm run format:check`、`npm run test:visual`，加上 WP 自己列的。实现者报告里必须贴实际输出。
- **主审规则：** 每个变更一个主审。主审做首评，修复后的复核也由同一主审做；"通过"绑定最终 diff，diff 再动就要主审再看。Codex implementer 写的变更，主审是它自己起的 Oracle 子代理（`spawn_agent {"task_name": "<WP>_oracle_review", "fork_turns": "none", "model": "gpt-6-astra", "reasoning_effort": "max"}`），对最终 diff 审核并给出验收结论，修复后的复核也由它做（可在同一子代理里续问）；Claude（含 `frontend-implementer`）、Grok 或 pi 写的变更，外部 Codex reviewer（sol max）是主审（Codex 额度不足期间临时改为 Opus 子代理）。不叠加第二个评审者；编排者自己的验证是验收，不是第二次评审。
- **并行隔离：** 同时开的工作包各用自己的 git worktree，或在 brief 里划定互不重叠的文件所有权；先由编排者整合（合并 / 应用补丁、跑全量检查），再按整合后的状态验收，不对各自分支的结果单独算通过。
- 提交由编排者在评审通过后做；实现者不做 git 写操作。
- **收尾顺序：** 先把报告存到 `tmp/tasks/<WP>/report.md`，再确认运行已结束（`herdr agent get` 为 idle / exited，或 hud-run 回执已到），最后才关表面（`/quit` + `herdr tab close`）。每个检查点跑 `herdr agent list` 清理。
- Jev：浏览器作业走自有 Jev 运行时（按需、仅 Jev）；同一时段不与直接 CLI 混用；共享浏览器串行，每个 key 只发一次。
- Argon / Pro 节奏：设计分叉随时攒包，Argon 提案、Pro 收敛；R 队列的阶段边界送 Pro 一次；两者都不当代码评审用。
- 仓库公开：fixture、文档、评审归档只用合成数据，不贴真实会话正文。
