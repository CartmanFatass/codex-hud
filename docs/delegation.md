# MyHUD 委派工作流（2026-11-01）

本项目的任务路由。编排者（Claude Code）按这张表派活，不自己写核心代码。概念方案见 [universal-hud-concept.md](./universal-hud-concept.md)，工作包见[工程计划书](./universal-hud-engineering-plan.md)。

## 路由表

| 任务类型 | 执行者 | 怎么调 |
|---|---|---|
| 架构难题、设计分叉、契约定稿前评审、阶段边界评审 | **ChatGPT Pro**（经 jev-ask） | skill `jev-ask`：简短 prompt 文件 + 一个附件（相关文档合并成一个 .md）；答案归档到 `docs/reviews/<date>-pro-<topic>.md`。Astra Max（Codex `gpt-6-astra`，effort max，herdr tab）只在 Pro 不可用或需要第二意见时用 |
| 评审（每个变更恰好一次） | **Codex reviewer**，`gpt-6.1-sol`，effort **max** | skill `herdr-delegate-codex` 的 reviewer 流程；hud-mcp 可用后改调 `delegate_spawn{role: reviewer}`。Codex implementer 自带的 reviewer 子代理也用 sol max |
| 核心任务：契约、账本、hud-mcp、hud-run、各 harness 适配器、链接解析、状态模型、reader、Herdr 集成层、启动器 | **Codex implementer**，`gpt-6.1-sol`，effort high（契约类任务提到 max） | skill `herdr-delegate-codex`；brief 里写明 Subagent plan（tier S / M / L） |
| 普通任务：探针脚本、测试基建、fixture、基准脚本、skill 与文档更新、改名、i18n 文案搬运 | **pi implementer**（DeepSeek V4.1 Flash，pi-roles） | skill `herdr-delegate`；评审仍由 Codex reviewer sol max 做 |
| 前端设计与实现：bar / panel / Inspector / statusline 的渲染、布局、文案、视觉基线 | **Claude Code 子代理 `frontend-implementer`**（sonnet，xhigh） | Agent 工具，`subagent_type: frontend-implementer`，传 brief 路径 |
| 需要人类互动的测试：对话框、真实输入、Windows Terminal 视觉验收 | **Hermes**（Windows computer use，grok-4.7，一次性运行） | 脚本先摆好状态，再给 Hermes 一个任务文件；证据以其 usage JSON 与截图为准。参照 ux / JevFocus 项目的做法 |
| 编排、验证报告、提交 | **Claude Code 编排者**（Herdr 内，opus medium） | 本文 + 工程计划书 |

## 升级规则

- 普通任务交 pi implementer。若同一 WP 两轮评审后仍有 blocker、或检查命令跑不绿、或报告与实际不符，**升级到 Codex sol implementer** 重做，并在工程计划书该 WP 旁记一笔。连续两个 WP 升级后，同类任务默认改走 sol。
- 核心任务从不降级到 pi。
- 架构问题不交 implementer 决定：实现者遇到设计分叉就停下报告，由编排者送 Pro。

## 分类规则

- 碰到契约、账本、身份、状态模型、reader、hud-run、Herdr 层、启动器中任何一个 → 核心任务。
- 只改渲染、文案、视觉基线 → 前端。
- 其余（脚本、文档、fixture、配置）→ 普通任务。
- 拿不准按核心处理。

## 约定

- 每个 WP 一个目录 `tmp/tasks/<WP>/`：`brief.md`、`role.md`、`report.md`、`review.md`、`SESSION.txt`。`tmp/` 已被 git 忽略。
- 检查命令：`npm test`、`npm run format:check`、`npm run test:visual`，加上 WP 自己列的。实现者报告里必须贴实际输出。
- 一个变更恰好一次评审；编排者自己的验证是验收，不是第二次评审。
- 提交由编排者在评审通过后做；实现者不做 git 写操作。
- 代理用完即关（`/quit` + `herdr tab close`）；每个检查点跑 `herdr agent list` 清理。
- Jev：hud-mcp 可用后，同一时段的 Jev 调用都经它走，不与直接 CLI 混用；共享浏览器串行，每个 key 只发一次。
- Oracle 节奏：阶段 A、B 结束各送 Pro 一次；阶段内设计分叉随时送；不拿 Pro 当代码评审。
- 仓库公开：fixture、文档、评审归档只用合成数据，不贴真实会话正文。
