# MyHUD 委派工作流（2026-11-01）

本项目的任务路由。编排者（Claude Code）按这张表派活，不自己写核心代码。概念方案见 [universal-hud-concept.md](./universal-hud-concept.md)，工作包见[工程计划书](./universal-hud-engineering-plan.md)。

## 路由表

| 任务类型 | 执行者 | 怎么调 |
|---|---|---|
| 后端设计与架构：跨契约 / 不变量 / 范围的设计分叉、契约定稿前评审、实现中的架构问题 | **Oracle：Codex `gpt-6-astra`，effort max**（herdr tab，一次性咨询，只读，写一个答复文件） | 参照 `tmp/oracle-astra/` 的 role / brief 格式；答复归档 `docs/reviews/<date>-astra-<topic>.md` |
| 关键节点评审：阶段边界（A9、B15）、Oracle 判断为超出其范围或需要更高一级裁决的分叉 | **ChatGPT Pro**（经 jev-ask） | skill `jev-ask`：简短 prompt 文件 + 一个附件（相关文档合并成一个 .md）；答案归档到 `docs/reviews/<date>-pro-<topic>.md` |
| 评审（每个变更一个主审） | **Codex reviewer**，`gpt-6.1-sol`，effort **max** | skill `herdr-delegate-codex` 的 reviewer 流程；hud-mcp 可用后改调 `delegate_spawn{role: reviewer}`。Codex implementer 自带的 reviewer 子代理也用 sol max，并且就是该变更的主审 |
| 核心任务：契约、账本、hud-mcp、hud-run、各 harness 适配器、链接解析、状态模型、reader、Herdr 集成层、启动器 | **Codex implementer**，`gpt-6.1-sol`，effort high（契约类任务提到 max） | skill `herdr-delegate-codex`；brief 里写明 Subagent plan（tier S / M / L） |
| 普通任务（明确型）：目标、方法、产出与验收都已写明的任务，如按评审意见修复、按既定方法补测、fixture、测试基建、基准脚本、skill 与文档更新、改名、i18n 文案搬运 | **pi implementer**（DeepSeek V4.1 Flash，pi-roles），每段一个新 pi、短段 | skill `herdr-delegate`；评审仍由 Codex reviewer sol max 做 |
| 开放型任务：需要自己设计方法或从观察下结论的任务，如新探针、原型、调研 | **Codex implementer**，`gpt-6.1-sol` | skill `herdr-delegate-codex`；brief 要求结论只覆盖实测配置 |
| 前端设计决策：信息展示、可视化设计、bar / panel / Inspector / statusline 的布局与信息层级 | **Claude Code 子代理，Fable（`model: fable`，effort max）**，由它决定（Jacob，2026-11-01） | Agent 工具，`model: "fable"`、`effort: "max"`；输入：概念方案 §10 UX、相关契约的投影字段、现有渲染与视觉基线；产出设计文档（放 `docs/design/`），作为前端实现的输入 |
| 前端实现：按已定设计写渲染、布局、文案、视觉基线 | **Claude Code 子代理 `frontend-implementer`**（sonnet，xhigh） | Agent 工具，`subagent_type: frontend-implementer`，传 brief 路径；设计以 Fable 的设计文档为准 |
| 需要人类互动的测试：对话框、真实输入、Windows Terminal 视觉验收 | **Hermes**（Windows computer use，grok-4.7，一次性运行） | 脚本先摆好状态，再给 Hermes 一个任务文件；证据以其 usage JSON 与截图为准。参照 ux / JevFocus 项目的做法 |
| 编排、验证报告、提交 | **Claude Code 编排者**（Herdr 内，opus medium） | 本文 + 工程计划书 |

## 升级规则

- 普通任务交 pi implementer。若同一 WP 两轮评审后仍有 blocker、或检查命令跑不绿、或报告与实际不符，**升级到 Codex sol implementer**，并在工程计划书该 WP 旁记一笔。连续两个 WP 升级后，同类任务默认改走 sol。
- 升级前先分清是**代码缺陷**还是**环境 / 基线问题**（依赖没装、基线本来就红、Herdr 不在跑）：环境问题修环境，不算实现者的账。升级时接手方从现有有效成果（已通过的测试、已定稿的文件）继续，不默认全部重做；brief 里写明哪些保留、哪些重做。
- 核心任务从不降级到 pi。
- 设计分叉怎么走（Jacob，2026-11-01）：后端的设计与架构交 **Oracle（Codex Astra Max）**；编排者不自行裁决跨契约、不变量或范围的分叉：实现者写下默认方案并标"待 ARCH 裁决"，继续不受影响的部分；编排者把同一时段的分叉攒成一份问题包送 Oracle，只暂停受影响的工作包。**Pro 是更高一级**，只在关键节点（阶段边界 A9 / B15，或 Oracle 认为需要上送的分叉）使用。可逆的实现选择（内部结构、命名、先做哪个用例）由 CORE 自己定并在报告里写明理由，编排者验收时复核。

## 分类规则

- 给 pi 的任务切成短段（一个里程碑），每段一个新 pi，做完即关；不在一个 pi 会话里串多个任务（Jacob，2026-11-01）。
- 并行度按情况提高：所有权不重叠的段可同时开，各自写明独占路径；共享文件的段串行。

- 碰到契约、账本、身份、状态模型、reader、hud-run、Herdr 层、启动器中任何一个 → 核心任务。
- 信息展示与可视化的设计决策 → Fable max 子代理；按定稿设计改渲染、文案、视觉基线 → 前端实现。
- 其余（脚本、文档、fixture、配置）→ 普通任务。
- 拿不准按核心处理。

## 约定

- 每个 WP 一个目录 `tmp/tasks/<WP>/`：`brief.md`、`role.md`、`report.md`、`review.md`、`SESSION.txt`。`tmp/` 已被 git 忽略。
- 检查命令：`npm test`、`npm run format:check`、`npm run test:visual`，加上 WP 自己列的。实现者报告里必须贴实际输出。
- **主审规则：** 每个变更一个主审。主审做首评，修复后的复核也由同一主审做；"通过"绑定最终 diff，diff 再动就要主审再看。Codex implementer 写的变更，它自带的 reviewer 子代理就是主审；Claude（含 `frontend-implementer`）或 pi 写的变更，外部 Codex reviewer（sol max）是主审。不叠加第二个评审者；编排者自己的验证是验收，不是第二次评审。
- **并行隔离：** 同时开的工作包各用自己的 git worktree，或在 brief 里划定互不重叠的文件所有权；先由编排者整合（合并 / 应用补丁、跑全量检查），再按整合后的状态验收，不对各自分支的结果单独算通过。
- 提交由编排者在评审通过后做；实现者不做 git 写操作。
- **收尾顺序：** 先把报告存到 `tmp/tasks/<WP>/report.md`，再确认运行已结束（`herdr agent get` 为 idle / exited，或 hud-run 回执已到），最后才关表面（`/quit` + `herdr tab close`）。每个检查点跑 `herdr agent list` 清理。
- Jev：hud-mcp 可用后，同一时段的 Jev 调用都经它走，不与直接 CLI 混用；共享浏览器串行，每个 key 只发一次。
- Oracle / Pro 节奏：阶段内的设计分叉随时攒包送 Oracle（Astra Max）；阶段 A、B 结束各送 Pro 一次；两者都不当代码评审用。
- 仓库公开：fixture、文档、评审归档只用合成数据，不贴真实会话正文。
