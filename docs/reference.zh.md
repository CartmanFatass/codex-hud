# HUD 参考文档

Claude Code、Codex 与 pi 的当前操作说明。
[English](./reference.md) · [快速开始](../README.zh.md) · [架构](./ARCHITECTURE.md)

- [安装](#安装)
- [通用 CLI 与 MCP](#通用-cli-与-mcp)
- [Claude Code mod](#claude-code-mod)
- [项目工作者](#项目工作者)
- [首页](#首页)
- [项目](#项目)
- [面板](#面板)：[按键](#按键)、[详情](#详情)、[设置](#设置)
- [执行决策](#执行决策)
- [底部状态行](#底部状态行)
- [机器可读状态](#机器可读状态)
- [配置](#配置)

早期激活、bootstrap 与自有工作者设计保存在 git 历史和[历次评审](https://github.com/CartmanFatass/codex-hud/tree/universal-hud/docs/reviews)中，不属于当前安装步骤。

## 安装

需要 **Node ≥24.0.0**（Node 24 为经过测试的支持版本线；
见[运行时依据](./ARCHITECTURE.md#3-launch-and-installation)）。
在检出目录运行：

```sh
./install --with claude,pi,codex,browser,herdr
```

可任选 **claude**、**claude-mod**、**pi**、**codex**、**agy**、**browser**、**herdr**；
核心始终安装。
安装器先检查 Node，再运行扩展检查、构建或修改文件，构建 HUD 与 MCP，将命令链接到 `~/.local/bin`。
直接运行 `./install` 会按当前客户端目录设置更新已记录的扩展。
旧版安装器安装的扩展需先用 `--with` 指定一次。
没有匹配的锁文件哈希时会重新安装依赖；
`--skip-build` 跳过依赖安装和构建。
保留检出／解压目录：已安装命令和客户端绑定均指向它。
不修改 shell rc。

外部工具只检查，不安装、不鉴权。
工作者另需 herdr、pi-roles 和 pi。
herdr 扩展报告 PATH 中的位置， 仅缺少 herdr 时失败。
browser 扩展要求 `google-chrome` 与 `jev-ask`，另报告可选的 `jev-aistudio`、 `jev-flow`；
不写浏览器配置、不启动任何工具。
Chrome、登录与密钥由这些外部 CLI 自行配置。
面板和决策 API 不需要 browser 扩展。

直接启动 `claude` 即使用全局 HUD 状态行，已有非 HUD 自定义状态行则保留；
直接启动 `pi` 加载 HUD 页脚。
Codex 的 tmux 状态行使用安装器打印的函数：

```sh
codexH() { hud codex "$@"; }
codexH
```

只有面板按需打开：Claude、Codex 和 pi 都用 `/hud`，启动时不展开。
用 `hud uninstall` 或 `./install --uninstall` 卸载；
`--with names` 只卸载指定扩展，保留核心命令。
保留 HUD 数据和无关设置。
Claude 设置跟随符号链接并保留一次性普通备份；
Codex 在官方 MCP 命令前备份解析后的 `config.toml`， 丢失注释时警告。
pi 注册委派与显示两个包，并排除旧 p10k-footer。

安装 Antigravity 集成前，确保 `PATH` 上有 `agy`，再运行 `./install --with agy`。
安装器注册 HUD MCP、权限规则和钩子，保留已有的非 HUD 状态行。
主会话的 MCP 指引写入 `~/.gemini/antigravity-cli/mcp/hud/instructions.md`，不会覆盖用户自己的指引。
用 `./install --uninstall --with agy` 移除该集成。

备份和多个 Codex home 的操作见[安装器扩展](../install.d/README.md)。

## 通用 CLI 与 MCP

```sh
hud --help
hud --version             # 打印版本、构建提交和构建时间
hud panel --help
hud panel                 # 在 herdr 中于调用者旁打开，否则在当前终端显示
hud panel --here          # 不分割窗格
hud panel --width 64      # 本次覆盖，直到保存修改后的宽度
hud statusline --help
hud import --help
hud trust <dir>           # 把该目录加入 grok、agy 和 claude 的信任列表
hud watch                 # 本窗格 HUD 任务每次状态变化一行（--all：所有任务）
hud act answer <job> <qN> <answer...>  # 面板里的负责人操作改用命令：只写一次回答，并恢复无头任务
hud act try [--cwd DIR]   # 全部验收（工单诊断页），记入 tries.jsonl；hud act retry|stop <job>
hud doctor                # 对本地安装执行只读预检
hud doctor <jobId>        # 只读查看单个任务的本地记录
hud stats [--days N] [--by role|model|route|feature]  # 任务用量和结果统计
hud day [--project]        # 今日合入、任务结果和不稳定的门禁测试
hud setup --detect        # 打印本项目的工作者配置 JSON
hud setup --apply PLAN    # 按计划写入 .hud/
hud setup --remove        # 去掉项目注册，留下 .hud/
hud tickets sync [--cwd DIR]  # 单向将 GitHub 父子议题镜像到 .scratch/
hud board [--cwd DIR] [--out FILE] [--open]  # 写出项目的 HTML 审阅看板，打印其路径
hud codex --model gpt-5    # Codex 参数原样交给 tmux 启动器
```

`hud codex-hud` 是 `hud codex` 的别名。
面板可用 `--root <namespace/session-id>` 或 `--harness claude|pi|codex --session ID --source ABS` 选择观测，不建立执行身份。
没有显式选择时，`HERDR_PANE_ID` 允许用一秒预算向 `herdr pane current` 查询调用者的 Claude 转写或 Codex 会话（herdr 窗格内回退读取 `CODEX_THREAD_ID`）；
不猜聚焦窗格、不读取状态行写下的绑定。
证据不可用时，仅保留未绑定原生会话的任务视图。

`hud doctor` 检查 Node、本地 herdr 的连通性、PATH 上的 pi 命令、已安装依赖的版本、客户端的 HUD 绑定 （解析到的检出目录和 Node）、已注册项目的 CLI 信任、dist 构建标记与正在运行的 MCP／观察进程所载入的构建、 租约，以及没有对应任务记录的受管工作树。
`credentials.env` 若存在，仅检查权限是否为 0600，绝不打开文件。
每项失败会给出一条修复提示；
任一项失败都会以非零状态退出。
按需启动的服务不必正在运行， 但旧版进程若未报告载入的构建则无法验证。
命令不会执行任何修复。

`hud doctor <jobId>` 读取 `$HUD_HOME/jobs` 下的单个任务目录。
它显示任务身份、共享读取器给出的状态、原始 `STATUS.json`、未答问题、检查结果、最新进度，以及适用的停止／关闭标记和记录中的进程是否存活。
对 CLI 工作者，它会比较当前轮次、完成回执和当前报告签名，但不打印报告正文。
缺失或无法读取的记录会标明。
该命令不修改任何文件，也不连接 herdr 或网络。

`hud stats` 是只读统计，默认统计最近七个本地自然日（含今天）创建的任务；
`--days` 可指定 1–90 天。
默认按角色、位置和模式分组；
`--by` 可按角色、模型、路由档位／模式或工单所属功能分组。
它显示从派发到结算的耗时中位数、提问数、sonic 子任务数、合入修复情况，以及宿主报告的词元和美元费用。
`hud day` 显示今日合入和工人声明的单行摘要、失败与停止、立即重跑后通过的门禁测试，以及按角色汇总的今日任务耗时和费用。
`--project` 仅显示当前工作目录所属项目，关联工作树也可以使用。
两条命令合并保留任务、月度归档和合入记录，同一任务不重复计数，并标明覆盖范围和扫描上限。
缺少费用记录表示未知，并不表示免费；
总和仅包含有报告总量的任务，宿主报告的美元费用不一定是账单金额。

MCP 提供 **hud_roster**、**hud_create**、**hud_read**、**hud_wait**、**hud_peek**、**hud_send**、**hud_respond**、**hud_close**、**hud_land**、**hud_lease** 与 **hud_tickets**。

所有客户端的主会话工具结果均使用精简的 `key: value` 文本。
嵌套记录仍为 JSON，状态事件放在末尾的 `changes:` 列表中。
格式化时省略空值、默认值或重复字段，`changed_files` 只列出最多五个路径及总数；
完整读取仍保留工作者报告的 `report_meta.files` 及分页字段。
错误仍为 JSON。
测试中可在 MCP 服务器环境设置 `HUD_MCP_JSON=1`，以 JSON 返回结果字段。
JSON-RPC 封装、任务协议以及工作者工具保持不变。
首次分派或项目上下文失效时，调用 `hud_roster` 获取角色可用性、能否继续、生效的 `runs_on` 和约定；
上下文仍有效时直接调用 `hud_create`。
同一 MCP 会话再次调用时，若约定未变则省略正文，角色信息仍会刷新。
`hud_roster` 和该会话的首个 `hud_create` 结果会按调用者的运行环境给出通知提示；
无法识别时给出通用提示。
传入 `detail: true` 可查看预设、后备位置、来源及可用选项。
`$HUD_HOME/roles/*.json` 按角色名覆盖内置 JSON，已注册项目的 `.hud/roles` 再覆盖。
已注册项目的 `.hud/`、cwd、HUD 主目录、包目录中第一个 `hud-convention.md` 整体替换默认约定。
见[项目工作者](#项目工作者)。

`hud_create` 接收 `role`、`task`（或 `brief_file`：位于 `cwd` 内的可读 UTF-8 文本路径，上限 256 KiB，与 `task` 互斥），可选 `cwd` 和仅用于显示的 `package`；
还可用 `ticket`（`feature/NN`）关联进度；
`slice` 是旧版目标标签。
可选的 `experiment` 和 `arm` 标签（各最多 64 个字符）写入任务记录和归档，由重试和修复任务继承，不在面板中显示。
不支持 MCP tasks 的会话可传入 `jobs: [...]`，在一次调用中批量派发多个任务：每项接受与单次创建相同的字段，按输入顺序返回逐项结果，单项失败不阻塞其余项，每个创建成功的任务仍保留自己的通知。
省略 `request_key` 时，根据调用窗格、角色、cwd 和任务正文生成去重键。
默认在角色的首个可用位置（`runs_on`）启动。
`hud_create({retry_of: job})` 使用失败或停止任务的简报和选项开启新任务，显式传入的字段优先，但仍须遵守新建任务的规则。
未提供新的运行位置选项时，重试沿用原任务的相关选项，从角色或预设的执行链选择可用位置，而不锁定原执行环境。
各角色在哪里运行由角色文件和「控制」决定。
只有 `general` 接受 `preset`、`on`、`model` 或 `thinking`，且只在用户要求时对单次任务生效。
对 `general`，`preset` 选取指定预设中首个可用且未耗尽的位置，不保存设置；
也可用 `on` 覆盖执行环境或浏览器服务商 （默认值见内置 `harnesses.json` 与 `$HUD_HOME/harnesses.json`）。
`preset` 和 `on` 互斥。
`model` 和 `thinking` 覆盖所选 `pi` 或 `cli` 位置的模型和推理强度。
其他角色在启动前拒绝这四个字段，批量派发和重试也一样。
带 `detail: true` 的任务读取或查看会显示所选 `preset`。
只有 `general` 还可以用 `instructions: "imp"`（也可指定 `hud_roster` 中可见的其他角色）。
所选 pi 或 CLI 工作者收到借用角色的指令，而非 general 的指令。
pi 使用借用角色当前运行链中第一个 pi 位置的 pi 角色；
若没有 pi 位置，则使用其指令名称。
任务仍沿用 general 的运行位置和并发名额。
`hud_read` 显示 `instructions_from`；
以 general 重试或恢复原生会话时仍沿用借用角色。
重复使用显式键会返回原任务；
派生键仅复用最近 10 分钟内创建的任务。
`kind` 为 `flow` 选择 `image`（默认）或 `video`。
仅 `pi` 可覆盖布尔项 `lens`、`mcp`、`tps`、`ui_ext`、`skills`、`split`，以及 `pi_args` （最多 128 项，每项 4096 字符，原样传递，不经 shell）。
省略的开关沿用 pi-role 默认值；
split 默认取位置设置。
`ui_ext: false` 禁用 UI 扩展；
`skills: true` 加载个人技能；
split 为 true 时预留右侧助手窗格。
拒绝覆盖 `--orchestrator`／`--notify`。
调用方只有在使用 `general` 时才能传入模型、提供方和推理强度参数。
重试时若更换角色，不沿用原先的位置覆盖项。
浏览器（`bro`）位置拒绝这些 pi 选项。

传入 `scout: "<问题>"` 时，HUD 先按 sonic 角色的常规设置，在目标任务的工作目录（包括托管工作树）中用相同的 `context_files` 运行 sonic。
`hud_create` 立即返回目标任务 ID，支持 MCP tasks 的客户端则获得一个覆盖两阶段的任务；
收集结束后，HUD 自动启动目标任务，并把资料报告加入 `from_jobs`（16 个名额中须预留一个）。
不会单独发送 sonic 通知。
若 sonic 失败或需要人工处理，HUD 仍会启动目标任务，在简报中注明原因，并关闭仍在运行的 sonic。
`role: "sonic"` 不接受 `scout`。
问题就是 sonic 的任务正文；
若启用了 Sonic 自动选档，也会将它用于选档。
浏览器目标接收的资料报告仍受通常的上下文字节限制。

可传入 `checks`，指定原本要亲自复跑的检查命令，最多五条。
Pi 或 CLI 工作者声明本轮完成后，HUD 在任务的 `cwd` 中 用 `bash -lc` 依次运行命令，每条限时十分钟。
重试和关闭后新建的修复任务会继承这些命令。
`hud_read({job})` 显示 每项是否通过；
`mode: "full"` 同时显示失败输出的末尾；
开始新一轮或重写报告会让旧结果过期。
`hud watch` 在结算行或检查完成后的通知中附上 `checks 2/3`。
任务详情也显示通过数／总数（`✓` 通过、`✗` 失败、`↻` 运行中、`~` 过期）。
检查不会结算任务，也不决定是否验收。

可用 `context_files`（最多 32 个路径，以任务的 `cwd` 为基准解析）和 `from_jobs`（最多 16 个任务 ID， 各自指向 `$HUD_HOME/jobs` 中该任务的 `report.md`）传递上下文。
文件须为可读的 UTF-8 文本，解析后的路径须分别位于 `cwd` 或 `$HUD_HOME/jobs` 内；
无效引用会在启动前返回 `invalid_arguments`。
Pi 和 CLI 工作者按简报中任务之后列出的路径读取文件；
浏览器（`bro`）会把标明来源的文件内容随简报发给浏览器服务（单个文件最多 64 KiB，合计最多 256 KiB，超限返回 `context_too_large`）。
通过 `from_jobs` 附带的 `sonic` 报告（包括 scout 资料报告）前会加上一行与简报语言一致的提示，说明 sonic 事实只是带 `file:line` 的未核实起点，据此做决定的代码须亲自阅读。
只有已注册的项目才会自动纳入根目录下可选的 `.hud/brief.md`：本地任务在正文后附上引用，浏览器任务按同样的大小限制内联其内容。
请确保该文件内容可发送给所选浏览器服务。
引用上游报告不会将其标为已读，也不会关闭其工作者。

`isolation: "worktree"` 让任务在仓库旁自己的 Git 链接检出中运行（`<repo>-wt/<slug>-<id6>`，分支 `wt/<slug>-<id6>` 取自 HEAD， 链接 `node_modules`，并复制该 CLI 对主检出的信任）。
浏览器角色和非 Git 目录会被拒绝。
在完整模式下，`hud_read` 会附带 `worktree`（含检出路径）及 `git_summary`。
其中 `overlaps` 列出同一检出下也改动了这些文件的其他托管任务及重叠文件，排除其他工作树中已提交且文件版本与主检出 HEAD 一致的改动。
空列表表示未发现重叠，`null` 表示当前任务的 Git 摘要读取失败，`overlaps_incomplete` 表示结果不完整。
任务关闭后，只有工作树干净且分支未改动、已合并或每个切片提交在基分支上都有等价补丁时，watcher 才会移除检出和分支。
若工作树不干净，或仍有未摘取的补丁（包括集成时被修改的补丁），则保留并在 `job.json` 记录 `worktree_kept_reason`；
脏工作树最多列出五条阻止清理的路径。
基分支 HEAD 变化后，后续扫描可重新检查因补丁未摘取而保留的分支；
常规扫描不会重试脏工作树。
Project 把这些检出视为任务自己的，不算未登记的 worktree。

已注册项目可在主检出的 `.hud/project.json` 中设置 `worktree.disposable`（例如 `["dist/**"]`，默认为 `[]`）。
清理时豁免匹配的已忽略文件，`dir/**` 也匹配其中的隐藏文件和目录；
当 `node_modules/` 下存在已跟踪文件时，建树会链接主检出中其余未跟踪项，清理也会把 `node_modules/` 下的已忽略项视为可移除的依赖状态。
其他忽略文件、未跟踪文件及已跟踪的改动仍会保留。

`hud_land({job})` 可集成任一已注册项目中成功结算（`idle_grace`、`done` 或 `closed`）的托管工作树。
HUD 使用任务所属项目的主检出，而不是调用者的检出。该主检出的 `.hud/project.json` 配置示例：

```json
{"land":{"base":"main","gate":["npm test"],"after":["npm run build"],"push":true,"wrapper":"tools/env.sh","timeout_s":900}}
```

HUD 排队取得 `main-checkout` 租约，在新的分离工作树中运行 `gate` 命令。
如果任务分支已经基于当前基分支顶端，直接测试任务的原始提交；
否则只摘取从基分支不可达的提交。
可选 `wrapper` 是相对主检出的可执行文件，在目标工作树中接收 `sh -c <命令>`。
每条 `gate` 和 `after` 命令（包括立即重跑）都有独立的 `timeout_s` 时限，默认 900 秒。
达到时限后，HUD 终止该命令的进程组，记录 `timeout` 和最多 40 行失败输出，释放租约，不派发修复。
某条 gate 命令失败（包括 Node.js 报告单项测试超时）时，HUD 立即在同一工作树重跑一次。
如果输出包含 Node.js 的 `test at <文件>:…` 失败位置，HUD 通过同一个 wrapper 用 `node --test` 只重跑这些文件；
否则重跑整条命令。
重跑通过则继续，并在通知中列出能识别的偶发失败测试名称。
若仍失败，或摘取提交时发生冲突，HUD 把失败步骤和最多 40 行（8 KiB）失败输出发给源任务，要求它变基到当前基分支、修复并提交。
修复与 `hud_send` 使用相同的原生会话恢复窗口；
若无法继续源任务，则在源工作树创建同角色的本地任务，并记录 `retry_of`。
修复期间释放主检出租约；
收到新的结算结果后，重新创建集成工作树并从头运行 gate。
最多修复两次；
工人一旦提问，问题照常送达主会话，本流程停止。

每次门禁运行失败（首次运行或立即重跑）都会在流程记录旁保存最多 8 KiB 的私有输出摘录：去除空行和 HUD 面板画面，优先保留每个失败文件中第一个可识别的 Node.js 测试断言或错误，而不是堆栈或其他输出。
未识别到断言段时，保留输出末尾的非空行。
修复提示使用失败命令的同一份证据。
`hud_read` 在 `reruns` 中显示摘录路径，终结通知也给出这些路径。
通过的运行不会写入摘录；
流程记录移除后，摘录也会被清理。

通过后，若任务的 `ticket`（`feature/NN`）对应本地工单，HUD 在集成工作树中将工单更新并入最后一个已测试的提交。
若工单写明 `**Owner try:** yes`，则标为 `ready-for-human`；
若为 `no` 或省略此字段，则标为 `done`。
HUD 勾选验收项，并在评论中写入 `Landed in this commit`、重放基点和通过命令数/总数。
在基分支上运行 `git blame -- <工单路径>` 可查到加入该行的提交；
对流程调用 `hud_read` 也会返回 `landed_sha`。
此操作不更新 `STATE.md`，也不使用主检出的暂存区。
仅当涉及路径干净且主检出仍位于原基分支顶端，或基分支新增提交均未触及本次集成的路径时才快进；
后一种情况下，HUD 会在新的分离工作树中把已测试的提交摘取到新的基分支顶端，并重新应用工单更新（若存在路径重叠或任何冲突则拒绝），并在通知中说明此次重放。
仅当待落地的文件树与已通过门禁的文件树相同，或差异只涉及普通工单文件或 `STATE.md` 元数据（含 `docs/handoff/STATE.md`）时，HUD 才沿用门禁结果；
否则在快进前对待落地的确切提交重新运行门禁。
如果基分支在门禁期间再次前进，HUD 会重放并重新检查新的候选提交；每次落地尝试最多吸收两次基分支移动。次数非零时，`hud_read` 的 `base_moves` 字段和终结通知都会报告该次数。
若重放后的门禁仍然失败，落地停止，不派发修复。
随后 HUD 在主检出运行 `after`（若某条 `after` 主构建命令与集成工作树已测试的构建输入、编译器及配置完全一致，HUD 通过 `scripts/build.mjs` 的分段发布器发布已测试的 `dist`，跳过重复编译）。
若启用推送，即使本地基分支已继续前进，HUD 也只把获准落地的 SHA 推送到 `origin` 的基分支。
主检出的基分支必须仍包含已落地的提交，且落地所涉及的路径必须干净。
最后移除集成工作树；
若任务工作树干净且仍位于本次流程实际集成的源提交（即使摘取后的补丁与源提交不同），也一并移除任务工作树和任务分支。
集成完成后若清理失败，流程仍以完成结束并附带 `cleanup_note`，不会标为失败。
快进之后失败仍会报告已落地的 SHA。

主检出的 `after` 构建在发布 `dist/native/` 前校验原生状态栏的源码及二进制哈希。
优先使用通过校验的已测试产物，否则保留匹配的本地产物或用 Cargo 构建。
在受支持的平台上，如果没有匹配的产物且 Cargo 不可用，构建仍会成功，落地结果会通过 `after_note` 提示一次仍使用 TypeScript 状态栏。

调用返回流程 ID（MCP-task 客户端获得一个覆盖全程的任务），无需等待门禁。
执行进程在开始任何步骤前加载同一版本的构建产物；
若加载失败，流程会失败并显示 `HUD was rebuilt; retry the land`（HUD 已重新构建，请重试落地）。
再次调用 `hud_land` 时，若流程仍在进行或基分支已快进，则返回原流程；
若在快进前失败或取消，则启动新流程，保留原 ID 下的记录，并在取得租约后清理旧的集成工作树。
`hud_read({job: "<流程 ID>"})` 可查询任一次尝试的状态、当前步骤以及各步骤墙钟耗时 `timings`（含重跑与跳过的 `after` 重建）。
流程记录保存 `tested_tree`（最近一次通过门禁的文件树）和 `published_tree`（待发布的文件树，即使最终没有快进或推送）。
若另一个落地流程持有租约，`hud_read` 与任务详情会显示该流程；
若它正在运行门禁，还会显示步骤编号和已耗用的分钟数。
每次尝试结束时只发一条通知，给出 SHA 或失败步骤、最多三个已知的失败测试名称和最多 40 行失败输出，并逐行列出每次修复。
流程记录在 `$HUD_HOME/flows/`，watcher 重启不会重复集成，执行进程意外退出时报告中断。

角色文件定义 `role`、`instructions`、`can_continue`、可选 `idle_grace_s`（CLI 静默任务宽限，默认 600 秒）、可选 `resume_s`（默认 1620 秒，`0` 禁用原生恢复）及有序的 `run` 位置列表，支持 `pi`、`cli`（`grok`、`agy`、`claude` 或 `codex`）与 `bro`（`jev-ask`、`jev-aistudio`、`jev-flow`）；
旧版单位置文件自动加载为 `run[0]`，`"harness": "jev"` 自动加载为 `"bro"`。
内置角色：`imp`（`pi` implementer）、`reviewer`（`pi` reviewer → `agy` Hydrogen high）、`sonic`、`oracle`（`cli` `claude` `fable` high → `pi` `architect`；
没有角色文件定义 `architect` 时，`hud_create` 也接受 `architect` 作为它的别名）、以及可选角色 `pro`（依次为 `chatgpt`、`gemini`、`argon`）和 `flow`（`jev-flow`）。
可选角色默认停用：`hud_roster` 不列出，`hud_create` 拒绝派发并提示如何启用。
`$HUD_HOME/roles` 中定义同名角色的有效文件会启用该角色，除非显式开关另有设置。
在 `cli` 位置启动需要 `instructions/<instructions>.md`（内置 `implementer.md` 与只读 `reviewer.md`、`oracle.md`），缺失时返回 `unsupported_harness`。
遇到配额或限流失败会把该位置在 `$HUD_HOME/exhausted.json` 标记耗尽 1 小时并在失败原因写明下次将使用的位置，但不自动重试。
另写 `$HUD_HOME/roles/<name>.json` 注册自定义角色， 例如前端设计角色用 `"agent": "claude"` 和 Claude 模型别名。
列模型：`grok models`、 `agy models`、`claude --help` 或 `codex -m`。
HUD 传入模型标志、强度标志、该 CLI 的权限绕过标志、 `args` 和 HUD 工作者绑定。
恢复时传入原生会话标识，仍使用已配置的 CLI 主目录。
分发时不替 CLI 信任目录： 出现信任对话框则拒绝，失败原因写明 `hud trust <cwd>`。
会话留在各 CLI 自己的存储里。
herdr 经交互 shell 启动 CLI，所以该 shell 的函数仍生效。

对于 pi、Claude Code 或 Antigravity（`agy`）上可继续的角色，`hud_create({role, task, mode: "headless"})` 不打开标签页，仍可在面板查看进度或停止任务。
每轮都启动新进程并沿用同一原生会话，输出追加到 `stdout.jsonl` 和 `stderr.log`。
pi 的会话保存在任务的 `sessions/` 下；
Claude Code 和 Antigravity 使用各自的原生会话存储。
无界面 CLI 与标签页模式使用相同的提示词和工作者 MCP 配置：Claude Code 接收任务的 `--mcp-config`，Antigravity 使用已安装的 `hud` 服务并继承任务环境。
它没有标签页可切换：在其任务卡上按 `g` 会打开详情，其中「输出」块显示 `stdout.jsonl` 的最新几行（工具调用、助手文字和错误，最多 12 行；
任务运行时标注「运行中」），并按面板的采集节奏跟随日志；
停止（`X`）与其他任务一样可用。
提问即结束本轮；
通过 `hud_respond` 或面板作答后，用答案恢复同一会话。
有效声明报告后，工作者在回合结束时关闭，即使报告尚未读取。
无界面任务运行期间收到的后续消息按发送顺序排入下一轮；
若本轮以提问结束，则与答案一起送达。
关闭后，后续消息和落地修复在 `resume_s` 内恢复同一会话，超时则创建修复任务。

Sonic 以非交互方式运行一次 pi 查询，不打开工作标签页或窗格。
主会话通过 `hud_create` 发起，工作任务通过 `hud_sonic` 发起并收取结果。
两者都保留普通任务目录：`stdout.jsonl` 和 `stderr.log` 记录 pi 的输出，`report.md` 通常是已声明的报告。
若运行器退出却未留下退出回执，`STATUS.json` 会记录可确认的退出码或信号、标准错误日志的末尾，以及是否观察到父会话重启。
若尚无报告且会话末尾有助手文本，HUD 会将该文本写入 `report.md` 并标记为部分报告；
任务状态仍为失败。
Sonic 可以发布进度和获取租约，但不能提问或接收后续消息，也没有空闲宽限期。
sonic 角色文件可设置 `check_s`（默认 600）、`stall_s`（180）和 `max_s`（1800），均为正整数秒；
`hud_roster({detail:true})` 显示生效值。
HUD 在每个检查点停止陷入循环的查询（`looping`），否则发布一条进度并让同一个 pi 进程继续运行。
若 `stall_s` 内标准输出未增长且没有工作任务进度，则以 `stalled` 停止；
达到硬上限则以 `timeout` 停止。
这些失败会保留已有的标准输出和最新进度。
用 `hud_create({role:"sonic", retry_of:job})` 重试已停止的查询。
新任务以一条说明停止原因的简短消息，从原任务 `sonic-session.jsonl` 的私有副本继续。
如果会话不可用或 pi 在接收输入前拒绝打开它，pi 将收到原简报，以及未完成报告末尾最多 8 KiB 的内容（没有报告时取标准输出）。

Sonic 子任务就绪时，Pi 会通知工作者；
如果同一会话的 `hud_sonic` 等待调用已收取报告，则不再发送通知。

Sonic 默认使用角色的思考级别（内置为 `high`），`hud_sonic` 不接受思考级别参数。
设置中的 **Sonic 自动选档**（`sonicAutoThinking`，默认关闭）将任务文本的前 4000 字符作为数据连同角色职责与 `thinking_choices` 中的用途发送给决策 API，由其在 `none`、`low`、`high`、`max` 中选择；
不读取引用的上下文、项目常驻简报或报告。
按原样执行给定命令并报告输出、逐字复制或列出文件用 `none`；
在指定文件中查找具体事实用 `low`。
Pi 将 `none` 称为 `off`。
缺少密钥、达到调用上限、约五秒后超时或结果无效时，仍用角色默认级别。
用 `hud_create` 派发 sonic 或用 `hud_sonic` 启动子任务时，都不能覆盖思考级别。
分发记录并返回映射到模型支持范围后的级别和来源 `thinking_source`。

**Imp 运行位置**（`impPlacement`，设置 → 模型）默认为 `fixed`（固定），使用当前预设。
选择 `even`（均衡）时，可在「均衡预设池」（`impEvenPool`）一行用 ←/→ 选择预设，按 Enter 加入或移出。
HUD 选择过去 24 小时启动 imp 任务最少的可用预设；
次数相同时按角色文件顺序选择。
HUD 会报告跳过的预设；
池为空或无可用预设时，使用当前预设。
创建结果和任务回执包含 `route.placement: "even"` 和 `route.preset`；
任务卡显示均衡模式和所用预设。
固定和均衡模式下，排队、溢出、重试和落地修复都沿用创建时选中的预设。
旧设置 `impRouting: true` 读作 `auto`，`false` 读作 `fixed`。

`auto`（自动）在派发时使用一次决策 API 判断。
生效的 `imp` 角色文件必须定义 `routing`，不会从低优先级角色文件继承该块。
例如：

```json
"routing": {
  "light": { "preset": "hydrogen", "use": "按现有模式进行小改动" },
  "standard": { "use": "普通的端到端切片" },
  "hard": { "preset": "astra", "use": "跨模块或进程生命周期工作" },
  "modes": { "headless": "预计一次完成", "tab": "预计会提问、耗时较长或主人想观察" }
}
```

只提供文件中声明的档位。
`light` 和 `hard` 的角色预设由自动分流选择；
详细名册列出这些预设仅供参考，不能作为 `imp` 的 `hud_create` 参数。
`standard` 不带 `preset`，沿用「控制」中当前选择的预设。
分流会发送任务简报的前 4000 字符、指定本地工单（`feature/NN`，最多 4 KiB/4000 字符）、最多 32 个 `context_files` 的相对文件名（每个最多 512 字符）和字节数，以及档位和运行方式的用途说明。
不发送上下文正文、常驻简报、既有报告、预设或模型 ID。
所选的用途说明组成一行理由。

所选档位无可用位置时回退到 `standard`；
决策失败或超时时，使用当前预设并打开标签页。
自动选择标准档的无界面任务若在输入提交前启动失败，会尝试用标签页运行当前预设。
显式指定 `mode: "tab"` 或 `mode: "headless"` 优先，此时只选择档位。
自动无标签页运行仅用于支持该模式的可继续位置（pi、Claude Code 或 Antigravity），否则打开标签页。
溢出到 `general` 时保留 `imp` 的运行链。
`retry_of` 保留档位，不再请求决策；
轻量任务的落地修复改用标准档。
任务回执、创建结果和单任务 `hud_read` 返回 `route`，包括 `tier`、`mode`、`reason`、`source` 以及适用时的 `fallback` 或 `mode_reason`；
详情标题有档位和无界面标记，另有一行 `分流：轻量 · 无界面 — <原因>`。

按角色的软并发上限（`roleCaps`，默认 `imp: 3`、`general: 3`，其他角色不限；
`0` 表示无上限）在整机范围内统计处于工作状态的任务（不计 `queued`、`idle_grace`、`done`、`closed`、`failed`、`stopped`、sonic 子任务和无界面 sonic）。
开启 **imp→general 溢出**（`impOverflow`，默认开启）时，若 `imp` 达到上限而 `general` 尚有空位，则计入 `general` 的名额，但保留 `imp` 的执行链（沿用选定的运行位置），并返回 `overflowed: true`、`overflow_from: "imp"`。
无空位时，`hud_create`（以及批量创建中超出上限的条目）将任务创建为 `queued` 状态并保留完整简报与选项，在结果、通知与面板中显示排队位置 `queue_position`。
有空位释放或在设置中调高上限时，watcher 立即按启动时的首个可用位置启动最早排队的任务；
对排队任务执行 `hud_close`（或面板 `X`）会将其移除。

`hud trust <dir>` 把该目录加入 grok、agy 和 claude 的信任文件（先在 `$HUD_HOME` 下备份）。
文件不存在则不创建。
codex 跳过。

`hud_read({})`（或 `view: "compact"`）按从新到旧列出当前项目的活动任务和本会话报告未读的已结算任务。
每行包含 `job`、`role`、`state`，并在适用时带上 `report_unread: true`、`blocked: true`、待答问题编号 `question_ids`、受阻、等待或失败的原因 `reason`。
为让列表保持在约 2 KiB，较早的未读报告合并为 `older_unread_reports` 计数，活动任务仍全部显示。
工作者发起的子任务在父任务上以 `child_count` 显示。
`view: "recent"` 返回最新 20 个任务的完整行，包括子任务和已处理的历史任务。
两种列表都可显示已结算任务的有效 `summary`（最多 120 字符，不列文件），且都不会标记已读；
未出现在列表中的任务仍可通过 `changes` 报告变化。
`view` 不能与 `job` 或 `jobs` 同用。

`hud_wait({ jobs?, mode?, wait_ms? })` 一次监听多个任务。
省略 `jobs` 时，监听调用开始时本会话尚未结算的任务。
`mode: "any"`（默认）在任一任务结算或需要关注时返回；
`"all"` 等到所有任务结算，但遇到提问、受阻、等待主会话或失败时会提前返回。
`wait_ms` 为 0–120000 毫秒的整数（默认 60000；
`0` 只检查一次）。
返回 `ready`、`timed_out`、触发返回的任务编号 `triggered` 和精简任务列表 `jobs`。
没有目标任务时立即返回 `ready: true` 和空列表。
等待不会读取报告或问题正文、标记已读或已查看，也不会关闭工作者；
请用带任务编号的 `hud_read` 收取报告。

`hud_peek({ job })` 返回精简的 `status` 和里程碑，不读取窗格。
显式传入 `lines`（1–120）才会读取窗格末尾的 `pane_lines`；
窗格不可用时返回 `null` 和 `pane_reason`。
`detail: true` 会附带启动诊断。
该工具不读取报告、不标记已读或已查看，也不关闭工作者。
pi 和 CLI 工作者可用简报里的可选命令 `hud-progress.mjs` 记录里程碑（每条一行，最多 240 字符，保留最新 50 条）。
`hud_read` 的完整模式与 `hud_peek` 的 `progress` 返回最新 10 条；
默认读取只返回最后一条 `latest_progress`；
普通读取省略空进度；
列表和等待结果不含这些字段。
里程碑不会触发 `changes` 或 `hud watch` 事件。

`hud_read({ job })` 返回任务状态和未读报告的 `digest`。
`result` 优先采用已结算任务与报告签名匹配的工作者摘要，否则与任务通知一样，跳过标题和空行，取报告前 2 KiB 中的首行正文；
若没有正文则显示 `Report ready`。
摘要给出 `hud_read` 调用提示、报告字节数、托管工作树的改动文件数；
仅当报告前 64 KiB 明确写出 `Verdict:`、`Blockers:` 时才附上相应内容。
默认响应保留待答问题、已完成检查的单行结果及最新里程碑。
工作树列出最多 20 个改动路径，有余项时显示 `+N more`，并提示重叠改动。
已读报告不再打开正文，而是返回 `report_unchanged: true`。
`mode: "full"`（或 `full: true`）即使已读也会返回报告正文和 `report_path`，同时保留原有的元数据、进度、检查和工作树诊断。
报告正文每页经 JSON 转义后最多 24 KiB。
还有后续内容时，响应含 `report_bytes`（文件总字节数）、`report_truncated: true` 和 `next_offset`。
将该字节偏移量传给 `hud_read({ job, mode: "full", offset: next_offset })`，依次拼接每页的 `report`，直到不再返回 `next_offset`。
用 `jobs: [id, …]` 代替 `job` 可按输入顺序收取 `jobs` 结果数组，所有任务使用同一模式；
找不到编号只影响对应条目。
后续页需按任务分别读取。
`detail: true` 可在读取时附带启动诊断；
`launch_agent_args` 记录最近几次 CLI 标签页启动所用的参数（长度有限，不含提交的提示）。
Herdr 报告工作窗格忙时，HUD 会关闭该标签页，稍候在新标签页中重试一次。
启动失败时，`exit_reason` 保存简短错误码，`stderr_tail` 保留命令输出。
只想检查时用 `hud_peek`。
`wait_ms` 最多等 120000 毫秒，结算、问题或超时即返回。
返回报告摘要或正文时都会记录 `read_at`，不代表验收。
当前回合有效声明报告且回合结束后，即使报告未读也关闭工作进程和窗格。
CLI 声明后 120 秒仍未结束时，交由主会话处理，不强制中断。
未回答的问题、未结束或未收取结果的 Sonic 子任务会阻止关闭。
此变更前已启动的任务仍使用原有宽限期。
读取失败或受阻状态会单独标记为已查看。
工作者调用 `hud_report` 时可附带单行 `summary`（最多 160 个 Unicode 码点）和 `files`（最多 50 个相对路径），不在对话中重复报告正文。
托管工作树若有未提交的改动，`hud_report` 和备用命令 `hud-progress --done` 都会拒绝声明报告。
Git 忽略的文件不会阻止报告；
干净的工作树即使没有新提交，也可以报告没有改动。
对于有新提交的分支，报告工具会尝试预演与当前基线的合并。
如果检测到冲突，每项任务只拒绝一次，列出冲突路径，并要求工作者变基到指定提交后重跑测试。
之后的报告不受此预检阻拦；
`hud_land` 仍会执行自己的重放与修复流程。

已注册项目可在主检出的 `.hud/project.json` 中添加 `worker_checks`，例如 `"worker_checks": { "imp": ["npm run build", "npm run build:test"] }`。
指定的代码角色提交报告前，HUD 在托管工作树中依次运行命令，若已配置 `land.wrapper` 则使用该包装程序。
只读角色或没有新提交的工作树跳过检查。
所有命令共用 60 秒时限。
首次失败或超时会拒绝本次报告，将失败的命令及最多 2 KiB 的末尾输出返回给同一工作者。
工作者可修复后重试；
若受阻，可用非空的 `skip_checks_reason` 跳过检查（备用命令为 `hud-progress --done --skip-checks-reason`），原因会显示在 `hud_read` 摘要中。
这些检查与 `hud_create` 的检查和 `hud_land` 的合入门禁分开运行。

`hud_send` 给工作中的 pi 或 CLI 任务排队消息。
任务报告后关闭时，HUD 按时间与原生会话可用性自动选择：在 `resume_s` 内可在同一检出中新开窗格，恢复同一 pi、Claude、Codex 或 Antigravity 会话，开启同一任务的新回合（`continuation: "resumed"`）。
超时或无法恢复时，启动引用原简报和报告的修正任务（`continuation: "repair"`、`continued_as` 为新任务 ID）。
修正托管工作树任务，或用 `retry_of` 重试失败的修正任务（且未覆盖 `cwd` 或 `isolation`）时，若源工作树仍存在且工作区干净，HUD 会复用该工作树；
否则新建工作树。
用 `jobs` 代替 `job` 时，只把同一段文字发给工作中的任务，返回 `sent` 任务 ID 和 `skipped` 条目及其原因，不恢复已关闭任务。
用 `messages: [{job, text, message_key?}]` 可在一次调用中给多个任务发送各自的消息（包括原生恢复和关闭后修复），按输入顺序返回 `messages` 且错误逐项隔离。
显式 `message_key` 始终用于去重；
省略时，只有 10 分钟内发给同一任务的相同消息才视为重试。
CLI 工作者用同一条 `QUESTION` 和 `hud_respond` 流程提问（`hud-ask`，20 分钟后用默认）。
CLI 受阻时任务显示为需要你；
会话经 `changes` 或 `hud watch` 得知。
`hud_respond` 只写一次 `qN.answer.md`（也可传入 `answers: [{job, request_id, answer}]` 一次回答多条，按输入顺序返回 `answers` 且错误逐项隔离）。
`hud_close` 提前回收：即使 Pi 工作者在启动期间退出、未写入最终状态，也会记为 `stopped`。
正常清理由 watcher 负责；
如果任务已收到停止请求且记录的 Pi 进程已经退出，watcher 会在下次扫描时将任务记为 `stopped`。
主人也可在面板里回答未答的问题 （`r`，再按数字或 `d`）；
主会话通过一行 `changes` / `hud watch` 得知：`[role@job] ANSWERED qN from panel: <答案>`， 取自 `$HUD_HOME/panel-actions.jsonl`（读取方运行期间作出的回答；
更早回答的问题只是不再出现）。
主会话决定所有下一步，MCP 不知道工作流。
工具参数见 [MCP README](../packages/hud-mcp/README.md)。

未启用 [mod 事件唤醒](#claude-code-mod) 且协商了 MCP tasks 扩展的 Claude Code 会话中，新派发的 `hud_create`、单任务的 `hud_send`（包括修复）和恢复工作的 `hud_respond` 会在 `/tasks` 中显示为后台任务。
工作者的回合结算、提问、失败或停止时，Claude Code 无需 Monitor 就会收到通知。
报告通知包含任务 ID、角色、状态、`hud_read` 调用方式和一行摘要（优先使用工作者摘要，否则摘取报告正文）。
有 HUD 检查时，通知等检查结束后再发送，并附通过数与总数。
提问不等检查，通知会给出问题编号和正文。
MCP 每个任务返回一条结果；
是否合并成一次唤醒由客户端决定。
通知不标记报告已读，仍需用 `hud_read({job})` 收取报告；
启动详情可用 `hud_read({job, detail:true})` 查看。
MCP 重启后，同一调用方仍可在任务有效期内查询已有的工作者任务和落地任务。
在原连接上取消当前回合的任务与 `hud_close` 一样会停止工作者；
重复取消、取消旧任务或从新连接取消都不会产生影响。
启用 MCP tasks 的会话要派发多个任务时，应并行发起多个 `hud_create` 调用，每次创建一个任务。
`hud_create({jobs})` 会报错，不创建任何任务。
派发失败、重复调用和群发会立即返回。
批量 `hud_send({messages})` 和 `hud_respond({answers})` 仍按输入顺序返回逐项结果。
对这些批量调用开启的新回合，当前 MCP 连接会向调用窗格逐条推送一次同样的精简通知（报告等待检查，提问、失败或停止即时送达）。
推送失败则转入 `changes`，连接提前结束时回退到常规的 `hud-notify`／`changes` 通道。
没有后台任务或后台任务已过期的工作，仍可用 `hud_read` 查询。
这类会话不提供 `hud_wait`、`changes`（面板意图和未送达的批量通知除外）、 `watcher_alive` 或 `hud watch` 提示。

`hud_tickets` 在各客户端提供本地工单方法与操作（仅主会话可写，拒绝改写 GitHub 镜像）：默认 `guide` 返回方法模板；
`ready` 返回无阻塞且无活动任务的 `ready-for-agent` 工单，格式为 `tickets: [{ticket, path, title, what}]`。
将 `ticket`（`feature/NN`）及 `path`（作为 `brief_file`）传给 `hud_create`；
活动任务在项目诊断中即算认领，无需提交认领记录。`hud_land` 将工单更新并入落地提交（`**Owner try:** yes` 记为 `ready-for-human`，`no` 或省略记为 `done`），不再追加 `STATE.md`。
`run` 按 `feature` 派发就绪工单并自动落地符合条件的任务；可用 `cwd` 指定其他项目。新队列的 `max_parallel` 默认使用 imp 的并发上限；`**Role:** frontend-imp` 选择该角色，`**Main review:** yes` 则停止自动落地。worker 提问会让批次停下；用 `hud_respond` 回答该问题后批次自动恢复（`queue_resumed`）。
处理失败原因后，以同一项目和 `feature` 再次调用 `run`。新一轮队列保留已有任务和已完成的落地，并重试符合条件、在快进前失败的落地，不再重新派发这些工单；除非显式覆盖，沿用原 `max_parallel`。
以同一 `feature` 和 `cancel: true` 调用 `run` 会停止后续派发与落地，不干预已有任务和正在进行的落地。
`add` 按 `feature` 和 `tickets` 批量建单（可选 `owner_try` 布尔值，在状态行下写入 `**Owner try:** yes` 或 `no`）；
`update` 可单条更新（`feature`、`ticket` 及 `status`／`owner_try`／`tick`／`blocked_by`），也可传 `updates: [{feature?, ticket, status?, owner_try?, tick?, blocked_by?}]` 按输入顺序批量更新并返回逐项结果（每项可覆盖 `feature`，单项错误不阻塞其余项）；
`sync` 执行 `hud tickets sync`。
验收项编号无效时会提示有效范围，整条工单更新都不会写入，即使同一次更新中的其他编号有效。

其他客户端的 MCP 工具响应还带 `changes`：自上次响应以来本窗格派出的任务每次状态变化一行（没有则省略）。
面板、状态栏、pi 页脚、MCP 与 `hud watch` 用同一个 `jobRow` 推导任务状态，所以结论一致。
`hud watch` 默认只打印需要关注的事件，如提问、结算、受阻或新的静置原因；
`--verbose` 才打印所有变化。
`hud watch` 和 `changes` 都附上有效的工作者摘要（最多 140 字符）。
未读报告通知给出 `hud_read job=<id>`（用 `mode: "full"` 读取全文），而不是文件路径。
范围是调用者窗格（`HERDR_PANE_ID`），`--all` 为所有任务；
空闲时只每 30 秒重扫一次。
监听会把三秒内到达的结算合并成一条通知；
提问仍立即送达。
未协商 MCP tasks 且未启用 mod 唤醒的 Claude Code 可用 Monitor 运行它。
Codex 通过 `codex queue` 自动静默接收；
pi 的 HUD 扩展用原生消息唤醒空闲的主会话，或在当前批工具调用完成后、下次模型请求前送达通知，不改编辑器草稿，也不需要打开面板或 Monitor。
Antigravity 也会自动启动后台监听：主会话工作时通过 `PreInvocation` 钩子接收任务事件，空闲时则将事件输入提示框。
pi 工作者不会启动此监听。
调用者有窗格时，`hud_roster` 和 `hud_create` 返回 `watcher_alive`；
监听有效时不会直接向其他客户端的窗格输入，也不会显示 Monitor 提示。
未启用监听时，问题仍可通过 Codex 队列发送；
若无法排队或没有队列，则回退为直接输入。

任务是 `$HUD_HOME/jobs/<job>/` 中的普通文件。
标签页中的 pi 历史保存在 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/<cwd-dir>/`，任务的 `sessions/` 链接到主代理／助手文件。无界面 pi 的原生会话文件保存在任务目录中。
`job.json` 用 `sessions: [{harness, id, path?}]` 记录已知的原生会话，包括修正时的续接；重新打开同一会话不会重复记录。
CLI 任务的监督进程只观察；
只有事实能结束任务：记录的进程号消失（或被替换）、标签页关闭、输入前派发被拒（`failed`；
磁盘上有新报告则 `closed`）。
CLI 每次派发和 `hud_send` 都开始一个回合（`turn.json`）。
`hud_report` 或备用的 `hud-progress --done` 将报告签名绑定到当前回合。
未声明的报告按静默规则处理，本回合仍存活的子进程会推迟该规则。
续写会使旧回执失效；
改写已声明的报告必须提交新回执，否则安静达到角色宽限期后转为 `waiting_orchestrator`，不结算也不调用决策 API。
终端输出不会影响回执。
回执匹配且 CLI 回合已结束（或 pi 已原生结算并写出新报告）后，残留进程不阻止关闭；
未回答的问题和未收取的 Sonic 结果仍会阻止关闭。
herdr 状态本身不会让仍在运行的任务判为失败。
回合安静超过空闲宽限且无报告时，做一次决策 API 选择，只在固定动作中选（继续等、一次固定的写报告提示、屏幕上有配额行才 `failed`、 交给主会话）；
置信度低于 0.8 或出错则交给主会话。
不确定的一律 `waiting_orchestrator` 并写明原因。
监督进程由 herdr 推送、 文件变化和自身截止时间唤醒，另有每 30 秒一次重读状态；
STATUS 只在行变化时写。
`hud_create`、`hud_read`、`hud_send`、`hud_respond` 或 `hud_land` 会按需启动 watcher，后者经 `pi-role-reap` 回收已结束任务， 失败标签页保留两小时；
没有未结束任务或待到期失败任务时退出。
watcher 通过套接字关闭事件发现 HUD 启动的运行进程退出，无需定期扫描。
原生 pi-roles 工作者没有这样的套接字，等待停止或已读关闭时仍可按 `HUD_WATCH_CLI_CHECK_MS`（默认 30000 毫秒）复查。
监督进程已死而工作者仍在时任务为 `waiting_orchestrator`（“supervisor exited; worker still running”），watcher 按指数退避复查该工作者，对它 `hud_send` 会启动新的监督进程。
已结算目录（包括报告及 `hud_read` 访问）通常在**关闭一天后**的后续扫描时清理，不设专门到期定时器。
原生会话文件只存于任务目录的无界面 pi 任务，在**结算后至少保留七天**。
删除旧 pi 任务前先将真实 JSONL 会话移至 pi 存储；
CLI 和浏览器会话留在各自存储。
cwd 无效、目标冲突或移动失败则保留任务。
删除会话链接不删除目标。
任务正常结算（`done` 或已有报告且已关闭）后，watcher 在 `resume_s` 到期后的扫描中删除 `stdout.jsonl` 和 `stderr.log`。
Sonic 和未设置 `resume_s` 的旧任务使用默认的 1620 秒。
失败或已停止任务的原始日志保留到任务目录被删除为止。
任务结算时，watcher 在原始日志清理前尽力读取有大小上限的宿主用量，并保存到任务目录。
它读取 pi 会话记录、CLI 结果流或原生转写中的用量记录；
不会给缺失费用的词元估价，也不会把截断的逐请求转写当成总量。
删除任务目录前，watcher 向 `$HUD_HOME/archive/YYYY-MM.jsonl` 追加一行任务事实，包括工单、路由、提问数、合入结果、已知用量和去除主目录路径后的有限长度声明摘要。
归档行在有记录时包含 `sessions`、`retry_of`、`dispatcher: {harness, id}` 和状态标记 `output_written`。
会话路径按原样记录，文件之后可能移动或删除。
`questions: [{id, asked_at, answered_at?}]` 记录提问和回答文件的修改时间，不含正文。
`land` 保留尝试、修正和重跑次数。`created_at` 取自成功发布的尝试；若未发布则取自最近一次尝试。
`land.attempt_details` 记录每次尝试的编号、状态、已知时间、发布的 SHA（若有）以及修正和重跑次数。
`repair_details: [{attempt, step_kind, step, outcome}]` 将 cherry-pick 步骤标为 `conflict`，其余步骤标为 `gate`。
`rerun_details: [{attempt, step, passed_unchanged, tests?}]` 记录已知的重跑结果；若未做改动即重跑通过，则保留回执中的不稳定命令或测试名称。
旧归档行可能没有这些新字段。
归档不含任务说明或报告正文；
写入失败不影响删除，HUD 不会清理归档。
同一轮清理中，任务目录删除后，watcher 会清理 `$HUD_HOME/flows/` 中一天未改动的已结束合入回执及附属文件。

## Claude Code mod

`integrations/claude-mod/` 是 Claude Code 的 function-hooks 插件（`hud-mod`），让主会话的上下文保持精简。
运行 `./install --with claude,claude-mod` 可与 Claude 集成一起安装。
`claude-mod` 扩展会将当前检出注册为 `myhud-local` 插件市场，并在 Claude 的用户级范围内安装 `hud-mod@myhud-local`。
仅选择 `claude` 不会安装此插件。
如需试用，运行 `claude --plugin-dir integrations/claude-mod`。
面板仍是 herdr 面板。

- **事件唤醒。**
  在 herdr 的交互式主会话中，进入 HUD 项目或首次调用 HUD 工具时，mod 启动 `hud watch --mod`。
  它只发送监听器的状态行：任务与报告通知、提问、sonic 进度、落地与面板决定。
  三秒内的结算合并，提问不等窗口结束。
  空闲时每批提交一次提示，不修改输入草稿；
  工作中则追加一条合并的备注。
  中断回合时，待送事件留到下次提示，不再唤醒。
  接管时，待答问题、尚未查看的失败，以及调用者最近两小时内（若有记录，则自上次 mod 监听器送达通知以来）结算的任务的未读报告会逐项通知；
  较早的未读报告只提示总数。
  mod 接管期间，工具结果不附带 `changes`，不新建 MCP 后台任务，也不向主窗格输入面板消息；
  可用 `hud_create({jobs})` 批量派发。
  连续十分钟无待办时子进程退出，下次调用 HUD 工具或休眠的 HUD 项目出现新面板决定时重启。
  监听中止时仍可用 `changes` 和 `hud_wait`；
  未使用 mod 的会话保留原有 MCP tasks 或 Monitor 通知方式。

- **合并通知。**
  同一回合内，已经由 Monitor 行、唤醒通道或 MCP 精简结果中的 `changes` 送达的 HUD 行不再重复。
  同一任务的后续 Monitor 行只保留新增的行，并去掉 task id 与摘要（没有新增时写 `(HUD events already shown this turn)`）。
  mod 只从工具结果中移除已经显示的 `changes` 行，不重新格式化其他字段。
  不含 HUD 行的通知行不受影响。
- **负责人横条。**
  输入框上方只显示一行明确的负责人请求，没有则不显示；按横条宽度截断，语言跟随面板。
  `? N 项等你处理 · <第一项> [打开]` 统计与项目概览相同的 STATE 待处理请求；「打开」在本窗格旁打开面板。
  横条不显示运行中的任务、失败或工作者提问；主会话仍会收到任务事件。
  监听器在 `ready` 之后发送一条 `band` 记录，之后仅在内容变化时再发；
  横条只读取会话状态绘制，不做 I/O，问卷占用横条时保持为空。
  出现新的负责人请求时弹出一次提示（`需要你: …`），每条记录最多一次，监听器启动时已有的内容不提示。
  监听器运行期间横条会刷新；
  十分钟空闲退出后，要到下次重启（调用 HUD 或出现面板决定）才更新。
- **负责人命令。**
  在负责人的会话中（工作者会话没有），mod 声明若干立即执行的斜杠命令（回合进行中也可用），输出只给负责人看： 显示出来，但不进入任何模型请求，也不增加 MCP schema。
  `/hud` 打开面板（在 herdr 窗格中；
  其他情况由 skill 回答）。
  `/jobs` 列出运行中的任务和未读报告，`/jobs <id>` 查看单个任务，不会把报告标为已读。
  `/answer <job> <qN> <answer>`、`/try`（全部验收）、`/retry <job>` 和 `/stop <job>` 调用 `hud act`，效果与面板相同：回答只写一次 `qa/qN.answer.md`、恢复无头任务并通知主会话（`ANSWERED qN from panel`）；
  重试只记录请求，由主会话决定；
  `/stop` 对未结束的任务先确认。
  `/land <job>` 通过会话的 HUD 连接直接调用 `hud_land` 开始合并，任务报告未读时先确认。
  没有逐条切片的试用操作。
- **派发惯例。**
  mod 只精简 `hud_roster` 返回的内置惯例，项目与负责人自定义的惯例原样保留。
  在主会话中，新建 `imp` 或 `frontend-imp` 任务时须明确指定 `isolation`（重试除外），只读角色不使用工作树， 新建工单须明确指定 `owner_try`。
  模型通过 `hud_close` 关闭尚未结束的任务前，mod 会先请负责人确认。
  mod 监听器运行时，等它送达事件，不另开 `hud watch`，也不用 `hud_wait` 或带正数 `wait_ms` 的 `hud_read`。
- **报告读取。**
  对 `…/jobs/<id>/report.md` 使用 `Read`、`Grep` 或 `cat`/`head`/`tail`/`less`/`sed`/`awk`/`grep`/`rg` 命令，会被拒绝并提示 `Read HUD job reports with hud_read job=<id> (mode: "full" for the whole report), not from the file.` 其他读取照常。
  工作者会话 （设置了 `HUD_JOB_DIR`）没有 `hud_read`，可直接读取该文件，`from_jobs` 就是把报告作为文件交给工作者的。

## 项目工作者

已注册的项目可在 `.hud/project.json` 中启用临时文件清理，例如 `"scratch": {"paths": ["tmp/tasks"], "keep_days": 7}`。
请仅指定存放可丢弃数据的目录。
watcher 在按需扫描中最多每小时清理一次：若指定目录下某个顶层条目中最新的文件也早于 `keep_days`（默认 7 天），则删除该条目。
不接受含 `..` 的路径段、项目根目录本身或根目录之外的路径；
不跟随符号链接， 并在 `$HUD_HOME/watch.log` 中记录删除的条目数。

```sh
hud setup --detect [--cwd DIR]
hud setup --apply PLAN.json [--cwd DIR]
hud setup --remove [--cwd DIR]
```

命令本身不提问。
`hud-setup` 技能与 `hud-delegate` 一样，为 Claude、Codex 和 pi 安装；
它负责询问，这些命令只读或只写。

`--detect` 打印一份 JSON，不写任何文件。
它给出 `--cwd` 的 git 顶层（否则就是 `--cwd`）、 该根是否已注册、参考角色（内置与 `$HUD_HOME/roles`）、项目角色及其有序的 `run` 链、启用集合、无效角色文件、 技能，以及工作者技能链接。
清单中的可选角色带有 `enabled` 标记；
是否启用由控制标签中的全局开关决定，不属于项目设置。
对于已注册的主检出，`proposed_disposable` 根据保留的工作树中仍存在的已忽略文件提出 glob 建议。
技能根目录来自 `$HUD_HOME/setup.json` 的 `skill_roots` （默认 `~/.pi/agent/skills`、`~/.claude/skills` 和 `~/.agents/skills`），其后总是包含本仓库自带的 `integrations/skills`。
技能是含 `SKILL.md` 的目录，名字取 frontmatter 的 `name`。
每项带 `model_invocable`：frontmatter 有 `disable-model-invocation: true` 时为 false。
pi 仍加载该技能，但不放进模型的技能列表， 所以工作者不会自己选用它。

`--apply` 按计划写入项目的 `.hud/`（应提交）：

```
.hud/project.json          启用的角色，以及 apply 自己创建的链接、角色文件和提示
.hud/roles/<name>.json     项目指定的运行链，或与参考角色不同的 pi 角色
.hud/skills/<name>         指向技能目录的符号链接（仅工作者）
.hud/agents/<role>.md      可选的仅工作者提示
.hud/hud-convention.md     可选，内置约定的副本
.hud/brief.md              可选，手动添加的常设简报（setup 不管理）
```

计划为 version 1：`roles`（启用的名字）、`pi_roles`（只调 pi：`from`、`pi_role`、`model`、 `thinking`、`split`、`can_continue`、`skills`）、可选的 `runs`（角色名到非空的有序运行位置列表）、 `skills`（名字到技能目录的绝对路径）、`agents`（角色到 markdown）、`convention`（`keep` 或 `copy-default`），以及可选的 `disposable`（只列出所有者同意的 glob）。
apply 会将这些 glob 加入 `worktree.disposable`，不会移除原有 glob，也不会运行清理。
`runs` 可指定参考角色或 `pi_roles` 中复制的角色。
若两处都指定同一角色，`runs` 决定顺序，`pi_roles` 为其中每个 pi 位置补充默认设置。
打印 `removed`、 `wrote`、`linked`、`skipped (exists)`、`registered`，或 `no changes`。
同一计划再跑一次不会改任何东西。
不是本命令创建的文件或链接会留下，并报 `skipped (exists)`。

apply 把项目根记入 `$HUD_HOME/projects.json`。
项目配置只有注册之后才加载。
`--remove` 去掉注册，留下 `.hud/`。
常设简报不依赖注册，仍会使用。

已注册项目的角色文件可在 `run` 和 `presets[].run` 中列出 pi 与 CLI 位置。
CLI 位置只接受 `harness: "cli"`、`agent`、`model` 和 `thinking`，不接受额外参数；
不允许浏览器（`bro`）位置。
设置、技能和提示等工作者定制仍只适用于 pi。
setup 不修改任何 CLI 自己的文件，也不运行 `hud trust`。
若 CLI 位置需要信任该项目目录，请自行运行 `hud trust <dir>`。

## 首页

首页显示当前项目的交接信息。**等待**列出 `docs/handoff/STATE.md`（或仓库根目录下的 `STATE.md`）中 `## Waiting for the owner` 的明确请求。只有确实需要负责人决定或行动时，主会话才写一条，说明需要做什么、为何现在要做、到哪里查看。请在负责的主会话中答复，由它移除已解决的条目。

条目可用 ISO 日期（例如 `2026-11-23`）开头。只有 `(work waits)` 提高排序优先级，表示工作正在等负责人答复。`(waits on feature/NN, …)` 只标明依赖，不提高排序优先级；所有指定工单完成或放弃后，该条目会清除。其次按项目优先级（当前项目内相同），再按日期从旧到新排序。同一排序等级中，无日期的请求排在有日期的后面，保留文件顺序。首页、项目、横条和导出看板读取同一项目范围内的请求。在等待条目上按回车或点击，即可在项目中查看全文。

普通的提问、失败、阻塞和完成事件由主会话处理，不作为 HUD 提醒发给负责人。工作者的原始提问仍可在任务列表 → 详情中找到；`hud_respond` 仍会送达答复并继续工作者任务。

**现在**和**下一步**是 STATE 的交接笔记，不是 HUD 推断的目标。负载行仅在调用窗格的任务数已知时显示，统计该窗格运行中和排队的 HUD 任务。已启动、等待主会话的任务仍计为运行中；原生线程不计入。这不是项目或本机总数。

按 `v` 或点击**任务列表**。调用窗格中记录仍保留的每个 HUD 任务占一行，包括排队、已结束及 Sonic 子任务。回车或点击进入[详情](#详情)，查看报告或操作任务。

## 项目

项目 → **工作区**保留原独立「改动摘要」中的 Git 诊断：分支和 HEAD、领先／落后、已暂存／未暂存／未跟踪计数，以及各工作树的路径、分支和观测到的脏状态。只在打开该页时探测工作树。未知、过时或不完整的读数不视为干净；探测不会抓取或运行仓库过滤器。

项目标签打开概览。**需要你处理**只列出所选项目的明确负责人请求，其后是**进度**、**工单**（如有）、**工作区**和**文档**的入口。任务与工单的活动属于诊断信息，不是负责人请求。已耗尽的角色仍可在控制标签查看。

Enter 或单击打开子页；Esc 或单击面包屑 `‹ 项目 › 页名` 回到对应行。每页独立保留光标和滚动位置，面板重载后也保留。
在「还有 N 项」上按 Enter 展开其余请求。在待处理条目上按 Enter 打开含续行的全文；Esc 或单击面包屑返回，`o` 打开 STATE.md。旧验收记录仍可结清旧切片编号。

事实来自 `docs/handoff/STATE.md`（根 `STATE.md` 回退）、`docs/spec.md`、评审、角色／约定／指令及 Git 工作树。
不猜里程碑或完成。
密钥只显示名称及是否存在；
浏览器 ✓ 仅指 Chrome 和 `jev-ask` 在 PATH，非运行或登录证明。

**进度页。**
每个工单功能一行，显示最需关注的状态标记及各状态的工单数。
按 Enter 查看成员工单；
`o` 打开工单文件。
下一步和 Now 摘要仍来自 STATE，但 STATE 不再是切片台账。
项目任务行可打开报告，没有报告则打开 brief。
工作区页列出既未关联工单、又没有托管任务的工作树。
普通 `/` 筛选命中任一成员时显示整个组。
旧的「粒度」（`acceptance`）设置会被忽略。

工单读取 `.scratch/<feature>/issues/<NN>-<slug>.md`。
列表显示已扫描且还有未完成工单的功能，再按最近变动用已完成的功能补足到 16 个。
扫描会枚举功能名，最多检查其中 256 个是否有 `issues` 目录，再按近期变动读取最多 64 个此类目录；
每个功能最多 64 份工单，共 512 份，每份最多 64 KiB。
因触及上限或读取失败而无法完整统计时，总计标为「不完整」。
必须有匹配编号的 `# NN: title`、`**Blocked by:**`、`**Status:**`。
`hud tickets sync [--cwd DIR]` 通过 `gh` 将 GitHub 议题单向镜像到 `.scratch/` （包含有子议题的开放父议题，以及已存在镜像目录的父议题以更新关闭后的最终状态），写入 `.gitignore`（`*`）、`spec.md` 与带生成标记的工单文件；
若 `.scratch/` 中存在非生成的本地工单文件则拒绝写入。
验收记录或 done/closed/complete/resolved 状态表示已完成；
若不需要试用，非空且全勾的清单也表示已完成。
工单页将已放弃的工单计入已解决数。
最近 64 个提交标题中的工单编号可作为落地依据，后续工单可以开始；只有明确标记 `**Owner try:** yes` 时才显示为待试用。旧的待试用记录仍可读取。
依赖可写本功能编号／标题或 `feature/NN`；
仅等普通前序标为待前序，未知或受阻前序才标为受阻。
工作中的任务和托管工作树在读取时关联，不改写工单。
与进度页共享的查询选取最新的 64 个顶层任务，另取其中最多 64 个子任务。
**工单页**：每个 `.scratch` 功能一行，显示已解决数／总数（含已放弃的工单）和最早未结工单的状态。
有待试用工单时，该页显示 **全部验收**。选中后按 Enter（或再次点击该行），将当前项目已读取的待试用工单合写为 `$HUD_HOME/tries.jsonl` 的一条验收记录，不改写项目文件。读取不完整时仅纳入已读取的工单。`hud watch` 和 MCP `changes` 各收到一行。
打开功能后，按状态列出其工单， 每张一行（`◐ hp 06 Projects list  imp 12分  1/3`：状态标记、功能短码、编号和标题；
右侧是该栏关心的信息，最后是已勾选／总数）。
**等你处理**在最前：在等人回答的工单（`needs-triage`、`needs-info`、`ready-for-human`），行下附最新评论，不论还有什么拦着它；
**工作中**是刚认领或有活动任务的工单；明确等待负责人试用的工单进入**待试用**栏；
**就绪**可立即开工；
**待前序**仅等普通前序，初始折叠；
**受阻**才是真正卡住。
依赖项以 `← 03 ●` 显示，标记是前序的状态；
**已完成**初始折叠（Enter 展开）。
在工单上 Enter 就地显示检查项（✓／○）和最新评论（`## Comments` 下最后一条），再按一次折回；
`o` 打开工单文件。

**控制标签。**
控制是项目之后的主标签，顶部显示当前项目。
`[`／`]` 与项目标签共用同一个项目选择，不改变首页所属项目。
打开控制时只采集当前项目的角色等控制信息，不采集 Git 状态、工作树或工单。
角色视图从上到下是：

- **需要处理**：有已启用的位置耗尽、无可用位置或找不到所选预设的角色，以及无效角色文件。
  角色行如 `imp [daily] → agy`；
  需要处理的原因显示在下方。
  在无效文件行上按 Enter 或 `o` 打开文件。
- **正常**：默认折叠为角色名。
  Enter 展开后每个角色一行，显示下次运行的位置；
  项目自己的角色行末标有 `项目`。
  只有 `default` 以外的命名预设才显示标签，未选择预设的文件链也不显示标签。
- **用量**和**文件**：默认折叠。
  任务用量区块采用 `hud day` 的同一份保留任务、归档与合入数据，显示今日费用覆盖率，以及按角色和按角色／位置／模式分组的汇总。
  用量展开后显示额度窗口、pi 花费和今日按角色的派发情况（每个角色一行且不换行：每个角色的行都放得下时计数写成文字，否则写成 `✓ ✗`，仍然太宽的行先去掉 `平均`，再去掉 `转交`；
  位置名从末尾截断并加 `…`；
  角色今日用过 2 个以上位置，或有启动失败、配额标记时，在角色行下按运行位置拆分子行，仅展示记录的完成／失败、启动失败、转交主会话与配额标记，不影响路由）；
  文件展开后显示约定、指令、pi 角色定义、忽略的配置、原生代理，以及密钥、浏览器和宿主的存在情况。

角色行在宽度足够时显示下次使用的完整模型名，否则只显示宿主（pi 的提供方已知时一并显示）。
已知的继承模型以灰字显示。

Enter 进入位置，Esc 返回列表。
按 Enter 在该角色下方展开编号的备选链及其来源。
在角色或位置上按 `o` 打开来源文件。
链中 `◉` 表示下次使用、`○` 备选、`⊘` 已停用、`✗` 已耗尽、`−` 未安装。
`x` 只清除真实的额度耗尽标记，已停用的位置也可清除，但不会因此启用。

**宿主**（从角色页按 `h`，或点击「宿主」标题）列出 pi 运行器、内置 CLI 适配器、浏览器工具和 pi 提供方，适用于**本机的所有项目**。
空格或 Enter 开关当前项；
Del 移除已启用项，即停用，不会卸载。
在「已停用」组上按 Enter 展开或折叠。
`i` 打开「添加回」：输入开关 ID 的一部分进行筛选，↑↓ 选择，Enter 恢复，Esc 取消。
开关与安装状态分开：已安装表示找到了可执行文件，提供方已列出不代表已登录或有额度。
关闭 pi 运行器后，各提供方保留自己的开关，并显示「pi 已停用」。
`jev-ask` 同时控制 ChatGPT 和 Gemini；
`jev-aistudio` 控制 Argon。
`r` 刷新本地模型列表。

只有显式操作开关才会写入 `$HUD_HOME/harnesses.json` 的 `disabled` 属性（原子写入，0600），保留其他键，所有角色文件内容不变。
ID 为 `pi`、`pi:<提供方>`、`cli:<代理>` 和 `bro:<工具>`；
不在列表中就启用，新发现或未列出的项也一样。
`cli:grok` 与 `pi:xai` 独立。
开关配置无效或无法读取时会报错，不会按全部启用处理。

角色视图、`hud_roster` 与 `hud_create` 共用同一套选择规则：按顺序跳过停用、额度未恢复或缺少可执行文件的位置。
例如停用 `pi:xai` 后，`imp [daily]` 可转到 `agy`，预设和原来的 pi 位置都不变。
恢复 xai 后，它按原顺序参与选择，但真实的额度标记仍须清除或过期。
pi 提供方来自显式模型或 pi 角色中的完整模型 ID；
若只有模型名，则在未经筛选的缓存中精确匹配唯一提供方；
未设置模型才看 pi 的设置。
无法确定时显示「提供方未知」，不阻止派发，也不解析 `pi_args` 来判断提供方。
`general` 的单次 `preset`、`on` 和 `model` 覆盖值也遵循这套规则；
显式指定的停用目标会被拒绝，而不是改派。
没有可用位置时，`hud_create` 在创建任务之前返回 `no_available_place`。

角色文件可为 Claude 和 Codex CLI 工作者指定额外的 MCP 服务器，例如 `"mcp_servers": ["chrome-devtools"]`。
省略此字段或设为 `[]` 时，只加载 HUD 工作者 MCP。
Claude 从用户 `.claude.json`（设置了 `CLAUDE_CONFIG_DIR` 时为 `$CLAUDE_CONFIG_DIR/.claude.json`）的 `mcpServers` 中按名称读取条目，以该任务的私有配置严格启动。
若 Claude 配置中没有所指定的名称，本次启动尝试会失败。
Codex 仅在本次启动时禁用未列出的服务器；
列出的服务器保持其配置状态。
如果 HUD 无法读取某层 Codex 配置，就保留原有 MCP 设置，并在启动诊断中记录 `mcp scope not applied`。
HUD 不会为限制 MCP 而修改宿主配置。

Claude 将角色指令文件追加到系统提示，Codex 使用开发者指令。
角色文本不含控制字符时，Grok 将其追加为规则；
否则在首条消息前附上指令，无法内联时则指向角色文件。
Claude 的角色文件路径含控制字符时也使用这一回退方式。
Herdr 无法在 CLI 启动参数中编码控制字符（包括换行和制表符）；
其他启动参数含控制字符时，HUD 会跳过该运行位置，而不是修改参数。
Agy 的交互模式没有对应的系统提示参数，也不能按次严格选择 MCP 服务器，因此沿用原有 MCP 配置，并在首条消息前附上角色指令以及已注册项目的 `.hud/brief.md`。
首条消息只内联小于 16 KiB 且不含 NUL 的文本，否则指向对应文件；
四种 CLI 的组装简报 `brief.md` 也遵循这条规则。

角色文件可带 `presets`：`[{ "name": "short-token", "run": [...] }]`，每项是完整有序位置列表，按 `run` 的规则校验。
名称在同一文件内唯一，1–32 个 `[A-Za-z0-9._-]` 字符。
预设按内置 → 用户 → 已登记项目合并，每一层先用 `hidden_presets` 隐藏继承的名称，再以本层定义替换同名项或追加新名称。
由生效角色文件的 `active_preset` 选择名称，`null` 选择文件自身的 `run`。
没有此字段时仍运行文件链，以首个规范化后完全匹配的名称作为预设名。
指定的名称不存在时使用文件链，控制标签和名册会显示缺失的名称。
`hud_roster` 的详情返回生效的 `run`、`preset` 和合并后的 `presets`。
只有 `general` 能用 `hud_create(preset: …)` 为单次任务选取预设，不保存。

在**控制 → 角色**中，停用的可选角色列在**可选角色**下。
选中 `pro` 或 `flow` 后按空格（或点击页脚的 **Space 开关**），即可为所有项目切换该角色。
此操作原子写入 `$HUD_HOME/role-switches.json`（权限 0600），不改动角色文件。
手动设置可使用 `{ "pro": true, "flow": false }` 这样的 JSON 对象；
移除某个键后，是否启用取决于是否有用户角色文件定义该角色。
项目角色白名单仍然生效，不能启用已全局停用的角色。

在**角色行**上按 `c`/`C` 立即循环切换下一个／上一个命名预设（从文件链开始时选择首个／末个）。
`p` 打开列表，文件链和名为 `default` 的预设都可选择。
输入筛选，↑↓ 选择，Enter 应用，Esc 或 Ctrl+C 取消。
列表显示每条链的下次位置；
全部停用的预设仍可选，下次位置显示「无」。
`N` 从当前链复制草稿，`I` 从空白新建草稿。
输入唯一的名称并按 Enter 打开草稿。
`R` 重命名当前命名预设，Enter 提交。
`D` 预览删除当前命名预设以及之后使用的文件链，Enter 确认，Esc 取消。
选择、复制、重命名和删除操作不会启动任务，也不会覆盖 `run`。
耗尽标记仍按位置保留。

只有显式编辑才会写入全局用户角色文件（`$HUD_HOME/roles`，原子写入，0600），即使当前查看已登记项目。
重命名或删除继承的预设时，在用户层隐藏旧名称，不更改内置文件。
项目锁定角色显示来源和锁定提示；
`o` 可打开文件，但面板不提供预设或位置编辑。
内置 imp：`default`、`hydrogen`、`astra`；
reviewer：`default`、`pi`；
oracle：`fable`、`architect`（原 architect 角色的 pi 配置），不再有独立的 architect HUD 角色。

在角色行按 Enter 展开备选链。
改动前只读。
`i` 在末尾添加位置；
在位置行按 Enter 编辑。
在同一表单内切换目标、模型或 Flow 类型、适用的思考档位（或浏览器强度），最后选「完成」。
按 Enter 打开字段列表， 输入筛选，用 ↑↓ 或 PgUp/PgDn 选择，Enter 填入；
Esc 取消字段选择或关闭表单。
已停用目标不可选，缺少可执行文件会标明。
链里已有的停用位置仍保留。
若更换目标会丢失启动选项（`skills`、`pi_args`、`args`、`split: true` 或其它字段）， 面板会拒绝更换；
按 `o` 打开来源文件。

`K`/`J` 前移／后移，`Del` 删除位置。
「未保存」草稿的下次位置与已保存链分开显示。
`s` 原子保存完整非空链并选中；
校验或写入失败、或角色文件已被改动时，保留草稿。
离开未保存的草稿前会询问「放弃修改？」；
Enter 放弃，Esc 继续编辑。
面板等草稿关闭后才重载。
没有草稿时，`x` 清除所选位置的额度标记，`o` 打开角色文件；
`r` 刷新模型列表。

在角色行按 `m` 更换 `◉` 位置的模型（没有可用位置时更换第 1 位）。
在位置上按 `m` 或点击模型字段（`[模型 ▾]`）可直接更换。
pi、CLI 和 AI Studio 使用同一个选择器。
Enter 立即保存到当前命名预设或文件链，光标留在原处。
已有草稿时，Enter 只改草稿，仍按 `s` 保存。
Flow 没有模型，项目锁定的位置显示纯文本，不可编辑。

未设置模型时，若知道生效的模型，就以灰字显示；
否则只显示 `[▾]`。
未设置的思考档位也以灰字显示已知的生效值，未知时留空。
若按 Enter 打开位置表单，模型字段仍只填入表单：选择「完成」把位置放入草稿，再按 `s` 保存。

查询为空时，先列出当前模型、本角色其他预设中的兼容模型（标注 `default` 以外的预设名）、本位置上次快速保存前的模型（标记「原」，只在本次面板会话内保留）及可用的清除行。
选择器占满标签行下方的空间。
CLI 和 AI Studio 在任何宽度下都只显示一列目录和已发现的模型 ID，不按提供方分组，也没有模型信息条。
pi 的置顶模型也仍在所属分组中。
角色或预设位置使用的 pi 提供方分组默认展开（包括未设置位置的已解析默认模型）；
当前提供方优先，其余按使用次数排序。
选中 `▸` 行按 Enter 或点击该行，可一起展开或折叠其他提供方。
分组标题不可选中。
没有提供方在用时，直接展开全部分组。
宽度至少为 100 列时，pi 选择器的左侧列表显示上下文、最大输出、思考、图片能力和 HUD 状态。
右侧只读详情可换行显示完整 ID，并注明这些信息、是否为当前模型、使用它的角色和预设、列表已有多久以及 Enter 的作用。
不足 100 列时，底部条带只显示一行所选模型的信息；
如果列表中的 ID 被缩短，则在上方换行显示完整 ID。
缺失的 pi 模型信息显示 `?`。

输入可筛选完整的模型 ID（pi 为 `提供方/模型`）；
以空格分开的每个词都必须匹配，不分大小写（例如 `gpt mini`）。
匹配项排成一个不分组的列表：pi 优先列出使用中的提供方，各列表再按词匹配在名称开头、分隔符后或词内排序，最后按字母顺序排列。
单击模型即可设定。
滚轮每次滚动三行列表，并保持选中项可见。
↑↓ 移动光标，不会将列表重新居中；
PgUp／PgDn 每次翻动一屏减一行。
Enter 设置。
Esc 先清空已输入的筛选，再按一次关闭且不设置；
点击 `esc 取消` 或按 Ctrl+C 直接关闭。
`◉` 表示当前模型，`›` 表示光标；
列表中的长模型 ID 从中间省略。
pi 模型行上的 `✗` 及倒计时表示额度耗尽，`⊘` 表示已停用，`?` 表示提供方未知。
已停用的提供方集中显示在一条灰色提示上，其模型不供选择。
只读的当前模型仍可查看；
若提供方已停用，宽版详情会说明这个位置为何被跳过。
在宽版的只读当前行按 Enter 会关闭但不写入，窄版则无操作。
清除行（可用时）会移除显式模型设置；
已知结果时显示生效的模型及来源，例如「角色自带模型（gpt-6.2-sol）」，未知时显示「清除」。
pi 没有匹配项时不会写入；
仍可手动在角色文件中填写模型 ID，或在单个任务中覆盖。
旧的 `catalog.pi.include` 不再筛选选择器， 已有配置不会被改写。
选择器打开时，`q`、`r` 等可打印键只输入文字，退格编辑查询。

仅在打开控制标签且 pi 列表缺失或过期（缓存一天），或在选择器外按 `r`、在选择器内按 Ctrl+R（`^R`）时，才运行有时间和输出限制的列表命令 （`pi --list-models`、`agy models`、`grok models`）。
面板合并同时发起的刷新；
输入、绘制和定时更新均不运行命令。
`$HUD_HOME/display` 下的同一份缓存保留上次成功的列表及 pi 模型信息，旧缓存仍可打开。
pi 的宽版选择器显示列表已有多久；
有状态数据时，选择器会提示刷新失败或列表已过期。
没有成功的 pi 列表时则注明是有限的离线目录。
pi 命令成功返回空列表时明确显示没有发现模型。
其他宿主保留各自的目录和选择方式，按发现的模型（如支持）、内置目录、 用户目录、用户角色文件的顺序合并。
保存仅更新对应的用户角色文件，保留无关字段和预设；
`x` 只写入 `$HUD_HOME/exhausted.json`，不改角色。
下一次 `hud_roster` 和 `hud_create` 读取同一份文件。

**切换项目。**
有多个项目时，总览的项目名行写作 `名称 ▾ 项目 i/n`，`[`、`]` 依次切换面板自己的项目和 `$HUD_HOME/projects.json` 里仍存在的根（去重，最多 16 个）。
在项目名行按 Enter 或单击，打开**项目列表** （`‹ 项目列表` 取代标签行；
Esc 或单击面包屑回到总览）。
在某一页内 `[`／`]` 同样有效，面包屑改显项目名，该页的光标、滚动、折叠重新开始。
选择归面板所有，重载后保留，不在设置里。
首页的进度块始终显示面板自己的项目，打开该进度块也会回到该项目。
面板为每个访问过的项目保留一个采集器（最多四个，面板自己的不丢， 其余丢最旧的），只采集正在显示的那个。
只有一个项目时没有 `▾ 项目 i/n`，也没有列表。

**项目列表。**
分为需要你处理（有明确的 STATE 请求）、运行中和安静。
条目显示相关数量和已知的最近改动时间 （STATE.md 或工单文件，取较新者）。
安静的项目各占一行，显示已知的里程碑或 `无 STATE.md`。
每组先排面板自己的项目， 然后是有等待项的、有正在运行任务的，其余按最近改动排序。
Enter 或单击进入该项目的总览，再按 Esc 返回列表；
在项目标签的根总览上，Esc 不执行任何操作。
列表只在可见时读取： 对每个列出的项目按文件签名读 STATE 和工单（与首页相同），并遍历最新的 64 个顶层任务及其最多 64 个子任务，统计各根下未结束的任务。
不读 Git、角色，也不做完整采集；
列表打开期间至多每五秒读一次（重新打开则立即读），当前项目自己的完整采集暂停。
距上次改动的时间写作 `12分`、`3小时`、`4天`。
没有 STATE.md 的项目在进度页显示 `无 STATE.md`，其他页照常。

在页内 Enter 折叠标题、显示工单详情或打开行的文件，`o` 在 `$EDITOR`（默认 vim）的 herdr 标签页打开文件，编辑器退出即关闭；
工作区查询失败则退为旁侧分割。
首页、项目和控制保留各自的光标与滚动位置。
完整项目采集只在总览或某一页可见且无遮挡时运行；
首页只复用 STATE／工单缓存。
Git 最多每五秒一次。
不启动浏览器或 MCP。

## 审阅看板

`hud board [--html] [--cwd DIR] [--out FILE] [--open]` 写出项目的审阅看板：一个静态 HTML 文件，用浏览器打开；
页面没有脚本、 字体、图片、链接，也不发任何网络请求（Content-Security-Policy 只允许内联样式），所有项目文字都经过转义。
内容：页头（项目、 分支及改动／领先／落后、里程碑、写出时间，以及进行中／受阻／待试用／已验收／待办的堆叠进度条）；
**需要你处理**（仅显示明确的 STATE 请求，顺序与面板一致；没有则不显示）；
**待试用**（按功能分组的只读工单卡：功能、时间、提交、工单内容和清单，以及逐文件 `--numstat` 条）；
**进行中**（进行中与受阻的工单，运行中的任务及角色、模型、用时；不导出工作者提问）；
**工单**（各功能的进度条、未完成工单及其清单）；
以及**最新里程碑评审**。
没有内容的部分不显示。
页面跟随系统的浅色／深色，也可用页首的 自动／深色／浅色开关（纯 CSS）切换，从手机宽度到宽屏都能阅读。

它只采集一次，方式与项目页相同：不启动 HTTP 服务，不调用模型。
本窗格的任务只在 herdr 内（`HERDR_PANE_ID`）出现。
文件默认为 `$HUD_HOME/display/board-<项目>.html`，`--out` 可指定；
以 0600 先写临时文件再重命名， 目标处已有的链接会被替换而不会被跟随。
命令打印该路径。
`--open` 随后分离地运行 `wslview`，否则 `xdg-open`；
两者都不在 `PATH` 时只在 stderr 提示（退出码 0）。

在面板中，`w`（首页或项目页；
选择器和设置中无效）对当前显示的项目做同样的事并打开，顶部显示 `已导出看板: <文件>`，直到下一次按键。

## 面板

### 控制中的资源设置

打开**控制 → 资源**，可设置 Codex 原生状态行记录、pi 订阅代理和 API 赠额。在控制标签中按 `h` 可依次切换「角色 → 宿主 → 资源」，也可点击视图标题。
各功能默认关闭，可在资源中分别启用。已有的功能设置和账本保持不变；旧的 `experiments` 偏好不再生效。
用 ↑/↓ 选择，Enter 编辑或打开赠额账；
Enter 保存，Esc 取消。
校准时先按 Enter 预览，再按 Enter 保存新基准。
设置保存在 `$HUD_HOME/exp/`，应用于本机所有项目。
Codex 配置只能从本机已知项中选择；资源设置不会改动 CLI 配置。
在 **pi 订阅代理**中选择 Codex 配置并开启自动刷新。
pi 绘制 HUD 底栏时，若读数到期，HUD 用该配置的现有登录查询 Codex 额度，不发送提示词；
不用 pi 时不刷新。
`openai` OAuth 路线的底栏显示已用百分比。
用量最高的窗口在前，显示用量条和重置倒计时（`7d ████░░░░░░ ≈43% (2d4h)`）；
空间足够时才显示另一个窗口。
当前请求的直报优先，且不带 `≈`（`5h 11%`）。
过时估值用暗色显示，末尾加 `?`；
超过重置点的窗口显示 `↻`。
`oapi` 等其他路线不展示订阅额度。
打开**代理读数**可查看两个窗口及其重置时间、来源、最近成功和错误、下次尝试。
若提示需登录，请登录绑定的 Codex 配置，然后关闭再开启自动刷新。
关闭自动刷新即停止代理刷新。

**API 赠额**并列显示两本账。
pi 的底栏只显示当前 API 路线已启用的账本，以用量条表示已花比例，并显示估算剩余美元和距续期天数（例如 `API ████████░░ ≈$12.34 (12d)`）；
不显示订阅额度。
`openai-api` 计入 `oapi` 请求；
`anthropic-api` 只计入已安装的 pi HUD 能确认使用 API 密钥直连 Anthropic 的请求。
Claude OAuth、第三方网关和无法归属的请求不计入。
Claude Code 状态栏不变。
关闭某个 API 赠额后，该账户停止采集，账本保留。

### 布局与重载

首页、项目和控制是主标签。
底栏提示整条显示：先列当前行的动作，再列 Enter 的具体动作、适用时的 `Esc 返回`，最后是页面动作。
空间不足时从右侧丢弃提示，但 `? 帮助` 固定在最后。
移动、切换标签和打开设置的快捷键仍然可用，不占底栏空间。
编辑器或选择器接管按键时使用自己的提示，不显示 `? 帮助`；
帮助页本身只显示 `Esc 返回`。
例如，运行中的 HUD 任务有 `g 任务页`（有标签页时）和 `X 停止`，全部验收行有 `⏎ 全部验收`， 控制的角色行显示 `⏎ 备选链`。
`o 文件` 打开当前行的文件。
没有独立的 Agents 区、布局选择器、时间线、活动中心或代理日志。
各页保留选中／滚动。
图标（设置 → 显示 → 高级 → 图标，`icons`）为 `nerd`（默认）、`unicode` 或 `text`；
旧的或未知的已保存值按默认加载。
`nerd` 使用基本多文种平面内的 Font Awesome 字形，需要 Nerd Font（如 MesloLGS NF）；
码点：角色 imp U+F0AD（wrench）、frontend-imp U+F1FC（paint brush）、general U+F013（cog）、oracle U+F0EB（light bulb）、reviewer U+F002（search）、sonic U+F0E7（bolt）；
状态 提问中 U+F059（question circle，琥珀色）、失败 U+F057（times circle，红色）、报告未读 U+F0E0（envelope，绿色）、完成 U+F058（check circle）、排队 U+F252（hourglass half）、停滞 U+F186（moon）、已停止 U+F04D（stop）。
`unicode` 是此前的图标集（`⚒ ✎ ✦ ◈ ⚖ ⚡`，`? ✗ ✓● ✓ ○ ◷ −`），`text` 为 ASCII 字母和文字。
面板的角色和任务状态图标跟随已保存的设置。

安装目录入口变化稳定两秒后，限时子进程先验证导入，成功才在原窗格重启。
选中、滚动、诊断页折叠、覆盖页、设置光标、打开时间与宽度覆盖保留。
旧版保存的技能标签在重载时回到首页；
原「项目／控制面」位置会在控制标签打开。
未保存设置延迟重载；
坏构建保留旧面板并暗显提示。
状态行独立，新代码需重启。
明确空闲且不变的观测可放缓至五秒采集，输入／绘制独立。

### 按键

独立面板直接消费自己的按键和 SGR 鼠标事件。

| 键 | 作用 |
|---|---|
| Tab/Shift-Tab、左右、单击标签 | 在首页、项目和控制之间切换；数字键不切换标签 |
| `[`、`]` | 项目或控制：上一个／下一个项目（项目列表上无效） |
| Enter、`i` `Del` `K` `J`、`s`、`x`、`r` | 控制：进入备选链／编辑位置；添加／删除／上移／下移；保存草稿；清除已保存位置的额度标记；刷新模型列表 |
| `h` | 控制：依次切换「角色 → 宿主 → 资源」（也可点击视图标题） |
| 空格／Enter、Del、`i` | 宿主：开关、移除（即停用）、添加回（输入筛选、Enter 恢复、Esc 取消）；在「已停用」组按 Enter 折叠或展开 |
| `c` / `C`、`p` | 控制角色行：下一个／上一个命名预设，或筛选预设并选择名称或「自定义」 |
| `N`、`I`、`R`、`D` | 控制角色行：复制当前链或新建空白草稿、重命名所选预设，或预览并确认删除 |
| `m` | 控制角色或位置：直接选择模型（也可点击模型字段）。输入筛选，↑↓ 选择，Enter 保存（已有草稿则填入草稿）。选择器中单击即可设为，Esc 先清空再关闭，Ctrl+R 刷新列表 |
| 上下（`j`/`k`）、PgUp/PgDn、Home/End（`G` 表示 End） | 移动／翻页／首尾 |
| `g` | 详情：聚焦任务的 herdr 标签页；无界面任务直接显示输出 |
| `1`–`4` / `d` | 任务详情中的未答问题（`qN.md`，有选项或默认答案）后，`1`–`4` 选编号选项，`d` 用工作者的默认答案。只写一次 `qN.answer.md`（同 `hud_respond`；已有答案则保留） |
| `X` | 在未结束的 HUD 任务上：页面顶部一行确认 `停止 <role> <id>？  y 确认 · Esc 取消`。`y` 或 Enter 与 `hud_close` 一样停止它（处于空闲宽限期的 CLI 任务先用 `STATUS.json.close-requested` 请它退出，再运行 `pi-role-reap <dir>`，面板随后重新读取）；其他键取消 |
| Enter | 在首页等待条目上打开项目中的请求详情；在任务行打开详情；在项目中打开子页、折叠、显示工单、打开文件或执行选中的全部验收动作 |
| `o` | 详情或项目诊断：打开所选文件 |
| `v` | 首页：打开任务列表 |
| `n` | 任务列表或详情：查看当前会话的原生子代理 |
| `w` | 首页、项目：写出当前项目的[审阅看板](#审阅看板)（HTML）并打开 |
| `/` | 按不区分大小写的子串筛选项目进度与工单。Backspace 编辑，回车确认，Esc 停止编辑后再按一次清除。离开该页时清除，重载保留已确认的筛选 |
| `,`、`?` | 设置、帮助。从设置打开帮助后，返回时保留原有草稿和选中项 |
| Esc | 有 `/` 筛选时先结束输入，再清除筛选；之后返回（项目的页回到总览，项目列表回到总览，从列表打开的总览回到列表）；未保存设置询问保存／放弃／继续。首页、项目和控制的主页面上，Esc 不执行任何操作 |
| `q` | 关闭面板 |

鼠标单击选中行／按钮，再次点击已选中项执行 Enter 动作（首页等待条目、项目总览链接、任务行与详情文件链接单击直达），单击顶部面包屑返回，单击标签切换页面，滚轮滚动但不移动选中项。
模型选择器例外：单击设定模型，滚动时保持选中项可见。

### 帮助

按 `?` 查看按使用位置分组的快捷键。
从项目或控制页打开时直接定位到对应小节；
从首页或设置打开时从「通用」开始。
图例按分流（档位 `▂ ▄ ▆` 与无界面 `∅`，文本图标 `- = #` 和 `h`）、切片、答复和位置分组；
`g` 去任务的 herdr 标签页，无界面任务则在详情页看输出；
达到 80 列时，图例排在快捷键右侧。
用 ↑↓、PgUp/PgDn 或滚轮滚动；
按 Esc、`?` 或 Enter 返回原页面。

随 HUD 提供但不安装的技能见[可选技能（英文）](optional-skills.md)。
需要时可请主会话读取其中一项。

### 详情

任务详情显示待答问题原文、报告原文（最多 4 KiB；其余内容可打开报告文件查看）、经签名验证的工作者自报摘要、角色／客户端、模型／强度、包、状态、检查、流程、本地时间和记录的进度。**文件**列出 brief、问答、评审和报告。Tab 选文件或 Sonic 子任务，回车打开。未选中文件时，`o` 优先打开报告，否则打开另一个已采集的任务文件。没有 Git diff 时，**报告文件**仅显示最多 12 个工作者声明的路径，不代表已确认的改动。无界面任务的**输出**跟随 `stdout.jsonl` 的最新可显示行。

在任务列表或任务详情中按 `n` 或点击**子代理**，可查看调用会话的原生 Claude 或 Codex 子代理树。仅在打开该页时扫描，并注明不完整的读数。树中显示已观测到的角色、开始时间、活动时间和结束时间。Tab 选中转写，按回车或 `o` 打开。Esc 回到任务列表或任务详情。

### 设置

| 组 | 行 |
|---|---|
| 显示 | 主题、语言；**高级**中：底栏样式、图标 |
| 面板 | 宽度、通知；**高级**中：刷新、鼠标 |
| 模型 | 决策 API、静默任务、Sonic 自动选档、Imp 运行位置（均衡模式下另有均衡预设池）；**高级**中：决策调用上限（附小时计数） |
| 工作者 | 全部在**高级**中：imp 上限（`roleCaps.imp`，默认 3）、general 上限（`roleCaps.general`，默认 3）、imp→general 溢出（`impOverflow`，默认开） |
| Codex | 启动时显示状态栏 |

常用行常开；
上述 8 个低频行收在底部一个 **高级** 行之下（每次打开默认收起；
按 Enter、左右键或点击展开／收起，收起时若包含未保存修改或非默认值，高级行同样显示 `*` 与高亮）。
展开后每行带来源组前缀，`r` 仍重置该行所属分组（在高级行上按 `r` 仅提示）。
上下选择，左右／Enter 修改，`s` 保存、`r` 只重置本组。
有修改离开时询问保存并离开／放弃修改／继续编辑（默认）；
保存失败保留草稿。
主题和图标在草稿中预览。
没有全部重置或背景图。

宽度预设 40/48/56（默认）/64/80/100，存储 16–200 可读，0 表示默认。
保存宽度立即调整各客户端面板，尽量留 41 列给代理；
窗口变化重新应用，拖边框或保存无关设置不干扰。

主题为 `terminal`（默认）、`titanium`、`mocha`、`arctic`、`ember`、`contrast`、`latte`、`paper`、`none`。
每个有首页／项目／详情配色，latte/paper 为浅色，none／`NO_COLOR` 无颜色。
设置私有保存到 `$HUD_HOME/hud-settings.json` 或 `HUD_SETTINGS_PATH`，保存的显示设置覆盖环境默认值。
旧键 `panelLayout`（含 `split`）、`tasks`、`cardStallMinutes`、`cardFoldMinutes`、`cardHideMinutes` 和旧显示模型键（`modelEnabled`、`model`、`modelCallsPerHour`、`summaryIntervalMinutes`、`briefingApiBase`）在读取时忽略、保存时省略；已有任务记录、缓存和资源文件不删除。

## 执行决策

显示界面不调用文本模型或决策 API。界面标签按所选语言显示；工作者的问题、报告、自报摘要，以及工单标题、路由原因、已落地条目和待办事项均保留原文。控制页的模型选择器仍会查找可用模型 ID。

**静默任务**（`quietJobDecision`，默认开启）控制 CLI 监督进程是否在空闲宽限期后将静默任务的窗格末尾内容发送给决策 API；关闭时直接交回主会话，不发送内容。此开关独立于 Sonic 自动选档（`sonicAutoThinking`，默认关闭）及 Imp 的 `auto` 运行位置。设置 → 模型可选择主决策 API 提供方。**决策调用上限**（`decisionCallsPerHour`）可选 600、2000 或无限（0，默认）。

小时计数读取 `display/model-cache/decision-api/calls.json`，汇总同一 HUD 主目录下各进程的调用。回退请求单独计数；无限仍计数（`n/∞`）。历史调用在超出计数时段前仍计入总数。

**外发材料**（不含私有推理、密文或引用文件的正文）：

| 决策 | 输入 |
|---|---|
| 静默任务选择 | CLI 工作者窗格最后 60 行（≤12000 字符）、任务状态、角色、代理、静默分钟数、后台子进程标记及是否已发写报告提示；每个无报告的空闲宽限期最多一次，每个监督进程最多 3 次 |
| Sonic 自动选档 | 任务的前 4000 字符作为数据，以及 Sonic 的角色职责与各强度用途。不加载常设简报、引用上下文或报告 |
| Imp 自动路由 | 派发简报的前 4000 字符、指定本地工单的前 4 KiB／4000 字符，以及最多 32 个上下文文件的相对路径（各最多 512 字符）与字节数，并附上已配置的档位与模式用途。不含上下文文件正文、常设简报、历史报告或预设／模型 ID |

## 底部状态行

Claude 与 Antigravity 状态行、pi 页脚、Codex tmux 状态行使用相同的事实和布局：

```text
model effort │ context %/window │ repo branch(dirty) │ quota │ ~N t/s │ notices ··· MCP n  skills n
```

上下文十格，70% 前绿、70% 起黄、85% 起红，有数据时对齐客户端压缩窗口。
Claude/Codex 只显示各自最紧额度窗口，蓝、75% 起品红、90% 起红；
pi 用会话费用，位于编辑器右上条带，不在底部重复。
缺失事实省略。
通知区依次是：客户端原生审批、本机 HUD 任务数、本机 CPU／内存、近期客户端事件（Claude 或 Codex 子代理的开始／完成／失败，以及 Claude 技能加载，各保留三分钟）。

`HUD (OS): 2 running, 1 queued` 表示同一个 `$HUD_HOME` 下所有项目共有 2 个任务运行中、1 个任务排队中。
即使某个窗格没有自己的任务，它也会显示相同的本机计数；模型、上下文、项目和额度仍按当前会话显示。
等待主会话答复的工作者仍计入运行中，但不算需要所有者处理的请求，也不会显示告警徽标。
排队中的任务尚未启动；已结束的任务和客户端原生子代理不计入。
本机统计缺失、过期或不完整时，省略这一段，不改用窗格计数，也不假定为零。

`Linux: CPU 27% RAM 5.3/16.0 GiB` 显示本机系统负载，不是当前会话的用量。在 WSL 中标为 `WSL:`，只测量 Linux 客体，不探测 Windows 宿主。
CPU 利用率取 `/proc/stat` 中总计数与上次采样的差值。唯一的采样文件为 `$HUD_HOME/display/cpu-sample.v1.json`，仅本人可读写。
首次采样、间隔超过 30 秒或计数不可用时，省略 CPU，不等待第二次采样。
已用内存按 `/proc/meminfo` 的 `MemTotal − MemAvailable` 计算。仅在可用内存低于 10% 且已使用交换空间时，显示交换空间用量和总量。

待批准的审批固定在最前，点名第一项，其余写 `+2`，放不下时写 `! 3 needs`；
没有待处理就不固定。
没有时钟、任务数、hooks 数、当前工具或空闲回退文字。

- Claude 状态行：`~N t/s` 根据转录中的输出词元数和从提示或工具结果到回复的耗时估算最新回复的速率。
  在 Linux x64/WSL 上，安装后的 `hud-statusline` 启动器可用原生程序渲染紧凑的 `line` 和 `p10k` 样式，每次都读取标准输入的新数据。
  工作摘要或缓存缺失、过期，原生程序不可用，有实时转录通知，或使用转发、管理命令、`--details`、`--source` 时，回退到 TypeScript；不可用的本机计数同样省略。
  Claude 额度数据仍发布到本地；
  标准输入不落盘。
  源码安装可用 Cargo 构建原生程序；
  用 Cargo 打包的 Linux x64 发布归档已包含它，安装机器不需要 Cargo。
- Codex 状态行：`~N t/s` 显示从会话日志得出的现有输出速率估值。
- Antigravity 状态行：同一个 `hud-statusline` 命令显示模型、上下文、可识别的额度（如 `5h 80% left`，按当前模型选 Gemini 或第三方模型那组）以及同样的本机 HUD 任务数，不读取其转录，也不转发其输入。
  `--details --lang en|zh` 另显示输入／输出词元总数。
  有 Linux x64 原生二进制时，启动器对同一 agy 进程和工作目录复用上一次结果，重绘时约每秒刷新一次，变化可能在下次刷新时才出现。
  没有该二进制时，每次都由 TypeScript 渲染。

设置中的底栏样式只有 `line`（默认）和 `p10k`。
两种样式均为单行；
保存的旧样式载入为 `line`。
关闭颜色时，底栏使用 `line`。
`barFields` 从 `model,context,project,quota,tps,notice,loaded` 选择，不改变顺序。
如果指定了字段列表，请加入 `tps` 来显示速率。
窄栏（184 列终端打开面板后主窗格为 144 列）按代价由小到大省略： 已加载计数；
两个仪表格子（一起）；
额度重置时间和分支的 `↑n`；
子代理标题（先留几个词，再全部去掉）；
速率；
交换空间，随后是本机 CPU／内存；
两条子代理通知中较旧的一条；
推理强度；
上下文窗口（`41%`）；
分支；
额度；
项目；
上下文。
模型永不丢弃。
两项本机计数始终一起显示；若标签和两个数字仍放不下，则整段省略。
两种样式下 pi 编辑器的顶条相同，其它扩展状态保留。
状态行仅英文（子代理自己的描述除外）。

### Codex 原生状态行

使用已注册 `hud` MCP 服务的普通 Codex。
在 `/experimental` 启用 **Custom status line**， 重启 Codex，再打开 `/statusline` → **Choose a status line provider** → **MyHUD**。
要恢复默认状态行，在同一选择器中选 **Default status line**。
**控制 → 资源**中的**记录原生状态栏**开关只记录各本地配置最近一次观察到 MyHUD 的时间，不改变 Codex 的显示。

紧凑状态行依次显示模型和推理强度、上下文、额度。
有最新的本机统计时，显示相同的 HUD 任务数，随后显示可用的 Linux／WSL 系统负载。
页脚较窄时，Codex 会用 `…` 截断右端；
`codexH` 的 tmux 栏仍按宽度调整布局。

### pi 控制

以下控制只影响当前 pi 会话，不保存为面板偏好：

| 命令 | 作用 |
|---|---|
| `/hud`、`/hud toggle` | 切换面板（不会自动打开） |
| `/hud on`、`/hud off` | 打开／关闭面板，与页脚独立 |
| `/hud status` | 报告面板状态 |
| `/hud reconnect` | 取消会话切换后重新绑定，保留本会话的页脚开关选择 |
| `/hud help` | 显示面板／页脚命令帮助 |
| `/hud footer on`、`/hud footer off` | 恢复／隐藏整个 HUD 页脚及编辑器顶条，仅本会话有效 |

以下字段／分组修改保存到 `$HUD_HOME/config.json` → `piFooter`；
保存失败时只在本会话生效并警告。
`/hud footer` 或 `/hud footer list` 按组列出已启用字段及配置路径。
`/hud footer reset` 将全部字段恢复为开启。
`/hud footer band on|off` 切换顶条组， `/hud footer footer on|off` 切换底部组。
`/hud footer on|off|toggle <segment...>` 修改指定字段，或用 `all` 代表全部 （例如 `/hud footer off lens viz`、`/hud footer on all`）。
不带字段的 `/hud footer on|off` 是会话内整个框架的开关，不是持久化的分组修改。

底部组 id：`model thinking path git mcp skill lens viz statuses context`。
顶条组 id：`session cache tokens tps ttft cost time`。
这些开关只控制字段可见性，不会产生缺失事实。
context 属于底部组，但存为 `piFooter.band.context`；
其它 id 按分组存到 `piFooter.footer` 或 `piFooter.band`。

## 机器可读状态

活跃 Codex 状态行／面板在事实变化时每秒最多一次，私有原子写入 `$HUD_HOME/display/state/<tmux-session>.json`。
`hud codex --json` 读取当前目录会话快照：

```sh
hud codex --json | jq '.context.percent, .agents.active, .attention[].label'
```

Version 2 含会话、项目、上下文、额度、tokens、代理、注意事项，可选健康／速率证据及状态行字段列位置 （面板 `bar.segments` 为空）。
主会话代理、子任务、守护评审分别计数。
无事实省略，不填零。
写入者按原子文件 device/inode 判断所有权，退出者不删除接替者快照。
无 owner sidecar。

**输出速度。**
原生详情可显示 `~42 tok/s`，本轮输出增量除以时间减去完整已知工具等待并集， 含首字等待和停顿，不是精确解码速度。
需两个计数样本，不变计数不刷新；
旧值标上次，不冒充实时。

## 配置

`HUD_HOME` 默认 `~/.hud`，`HUD_SETTINGS_PATH` 覆盖设置路径。
`CODEX_HOME` 默认 `~/.codex`，只读转写和 Codex 配置，不存 HUD 状态。

| 环境变量 | 含义 |
|---|---|
| `HUD_BAR_STYLE`、`HUD_BAR_FIELDS` | 状态行默认值，也支持 `CODEX_HUD_BAR_STYLE`、`CODEX_HUD_BAR_FIELDS` |
| `CODEX_HUD_THEME`、`CODEX_HUD_ICONS` | 主题／图标默认值 |
| `NO_COLOR` | 任何非空值禁用颜色，优先于保存值 |
| `CODEX_HUD_STATUSLINE` | 默认 1，0 禁用新 HUD 会话的 Codex 状态行，优先于设置 |
| `CODEX_HUD_TREE_WIDTH` | 无保存值时面板初始宽度 |
| `CODEX_HUD_CWD`、`CODEX_SESSIONS_PATH` | 显式工作区／会话目录 |
| `CODEX_HUD_MOUSE`、`CODEX_HUD_AUTO_ATTACH` | 鼠标策略、显式自动复用偏好 |
| `CODEX_HUD_NOTIFY`、`CODEX_HUD_NOTIFY_DESKTOP`、`CODEX_HUD_NOTIFY_COOLDOWN` | 提醒开关、冷却（默认三百秒） |
| `CODEX_HUD_PROFILE` | 1 将阶段计时写入 `display/profile.log` |
| `CODEX_HUD_FONT_DIR` | 可选 `bin/codex-hud-fonts` 字体安装／检查目录 |
| `HUD_HEAP_CAPS` | 面板（`128/4`）与 `hud-watch`／`hud-mcp`（`96/2`）的 V8 堆上限；`off`／`default`／`0` 恢复 Node 默认，或设 `<old>[/<semi>]` MB |

提醒默认关闭，经 tmux（可选桌面 OSC/notify-send）报告原生会话的失败和审批。常规完成和 HUD 工作者提问不触发提醒，也不会自动批准或重试。发送给主会话的通知不变。

**凭证。**
`$HUD_HOME/credentials.env` 必须是普通 0600 文件，不跟随 symlink/FIFO。
`NAME=VALUE` 可有引号／export，不插值。
环境逐项优先，不隐式导入客户端／jev 密钥。
已知 key 包括 `MISTRAL_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`TYPESAFE_API_KEY`。

**决策 API。**
`$HUD_HOME/config.json` 的 `decisions.primary` 默认 openai，`decisions.fallback` 可选， 值为 gemini/openai/typesafe。
设置只存 primary，不存 key。
自动回退按 Gemini → OpenAI → TypeSafe 选择另一个有 key 的提供方， 最多一次，处理缺密钥、额度、鉴权、5xx、超时，不处理格式无效或拒绝。
Gemini 额度回复按服务端延迟或六十秒在进程内冷却。
浏览器 CLI 独立管理配置。

**显式导入。**
`hud import preview`／`apply` 只读指定旧文件（及已有 HUD `jev.env`），不猜 Codex home。
已有值优先，apply 私有备份修改目标，输出只有名称没有值。
`--pi-footer` 导入明确指定的 p10k-footer JSON。
来源只能是旧 `hud-settings.json` 与 `.env` 文件；
旧 jev-ask TOML 会被拒绝（浏览器 CLI 自管配置）。

```sh
hud import preview --from /tmp/synthetic-old/hud-settings.json
hud import apply --from /tmp/synthetic-old/hud-settings.json
```

**Codex 配置。**
显示层读取模型／推理强度、压缩窗口、额度、MCP 和技能事实，不编辑 Codex 配置／转写。
客户端 MCP 注册是显式安装行为，不是只读显示循环的一部分。
