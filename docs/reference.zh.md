# HUD 参考文档

Claude Code、Codex 与 pi 的当前操作说明。[English](./reference.md) ·
[快速开始](../README.zh.md) · [架构](./ARCHITECTURE.md)

- [安装](#安装)
- [通用 CLI 与 MCP](#通用-cli-与-mcp)
- [项目工作者](#项目工作者)
- [首页](#首页)
- [项目](#项目)
- [面板](#面板)：[按键](#按键)、[详情](#详情)、[改动摘要](#改动摘要)、[设置](#设置)
- [模型文字](#模型文字)
- [底部状态行](#底部状态行)
- [机器可读状态](#机器可读状态)
- [配置](#配置)

早期激活、bootstrap 与自有工作者设计保存在 git 历史和[历次评审](https://github.com/CartmanFatass/codex-hud/tree/universal-hud/docs/reviews)中，不属于当前安装步骤。

## 安装

需要 **Node ≥24.0.0**（Node 24 为经过测试的支持版本线；见[运行时依据](./ARCHITECTURE.md#3-launch-and-installation)）。在检出目录运行：

```sh
./install --with claude,pi,codex,browser,herdr
```

可任选 **claude**、**pi**、**codex**、**browser**、**herdr**；核心始终安装。
安装器先检查 Node，再运行扩展检查、构建或修改文件，构建 HUD 与 MCP，将命令链接到 `~/.local/bin`。
`--skip-build` 使用已有构建。保留检出／解压目录：已安装命令和客户端绑定均指向它。不修改 shell rc。

外部工具只检查，不安装、不鉴权。工作者另需 herdr、pi-roles 和 pi。herdr 扩展报告 PATH 中的位置，
仅缺少 herdr 时失败。browser 扩展要求 `google-chrome` 与 `jev-ask`，另报告可选的 `jev-aistudio`、
`jev-flow`；不写浏览器配置、不启动任何工具。Chrome、登录与密钥由这些外部 CLI 自行配置。
面板和决策 API 不需要 browser 扩展。

直接启动 `claude` 即使用全局 HUD 状态行，已有非 HUD 自定义状态行则保留；直接启动 `pi` 加载 HUD 页脚。
Codex 的 tmux 状态行使用安装器打印的函数：

```sh
codexH() { hud codex "$@"; }
codexH
```

只有面板按需打开：Claude/pi 用 `/hud`，Codex 用 F12，启动时不展开。用 `hud uninstall` 或
`./install --uninstall` 卸载；`--with names` 限定扩展。保留 HUD 数据和无关设置。
Claude 设置跟随符号链接并保留一次性普通备份；Codex 在官方 MCP 命令前备份解析后的 `config.toml`，
丢失注释时警告。pi 注册委派与显示两个包，并排除旧 p10k-footer。
备份和多个 Codex home 的操作见[安装器扩展](../install.d/README.md)。

## 通用 CLI 与 MCP

```sh
hud --help
hud panel --help
hud panel                 # 在 herdr 中于调用者旁打开，否则在当前终端显示
hud panel --here          # 不分割窗格
hud panel --width 64      # 本次覆盖，直到保存修改后的宽度
hud statusline --help
hud import --help
hud trust <dir>           # 把该目录加入 grok、agy 和 claude 的信任列表
hud setup --detect        # 打印本项目的工作者配置 JSON
hud setup --apply PLAN    # 按计划写入 .hud/
hud setup --remove        # 去掉项目注册，留下 .hud/
hud codex --model gpt-5    # Codex 参数原样交给 tmux 启动器
```

`hud codex-hud` 是 `hud codex` 的别名。面板可用 `--root <namespace/session-id>` 或
`--harness claude|pi|codex --session ID --source ABS` 选择观测，不建立执行身份。
没有显式选择时，`HERDR_PANE_ID` 允许用一秒预算向 `herdr pane current` 查询调用者的 Claude 转写；
不猜聚焦窗格、不读取状态行写下的绑定。证据不可用时，仅保留未绑定原生会话的任务视图。

MCP 恰有六个工具：**hud_roster**、**hud_create**、**hud_read**、**hud_send**、**hud_respond**、**hud_close**。
先调用 `hud_roster` 获取生效的角色、模型／推理强度来源、可接受选项和约定。
`$HUD_HOME/roles/*.json` 按角色名覆盖内置 JSON，已注册项目的 `.hud/roles` 再覆盖。
已注册项目的 `.hud/`、cwd、HUD 主目录、包目录中第一个 `hud-convention.md` 整体替换默认约定。
见[项目工作者](#项目工作者)。

`hud_create` 接收 `role`、`request_key`、`task`，可选 `cwd` 和仅用于显示的 `package`。
重复键返回原任务，不再次启动。`model` 和 `thinking` 可覆盖本次 pi 或 CLI 角色。
仅 pi 可覆盖布尔项 `lens`、`mcp`、`tps`、`ui_ext`、`skills`、`split`，以及 `pi_args`
（最多 128 项，每项 4096 字符，原样传递，不经 shell）。省略的开关沿用 pi-role 默认值；
split 默认取角色文件。`ui_ext: false` 禁用 UI 扩展；`skills: true` 加载个人技能；
split 为 true 时预留右侧助手窗格。拒绝覆盖 `--orchestrator`／`--notify`。
浏览器角色拒绝这些 pi 选项。CLI 角色只接受 `model` 和 `thinking`。

CLI 角色文件设 `harness` 为 `cli`，`agent` 为 `grok`、`agy`、`claude` 或 `codex`，
并写 `can_continue`，可选 `model`／`thinking`（省略则用该 CLI 自己的默认）、可选 `idle_grace_s`
（默认 600）和可选 `args`（原样追加的 CLI 参数，不是 shell 字符串）。内置角色：`grok-imp`、
`agy-imp`、`claude-imp`、`codex-imp`。另写 `$HUD_HOME/roles/<name>.json` 注册自己的，
例如前端设计角色用 `"agent": "claude"` 和 Claude 模型别名。列模型：`grok models`、
`agy models`、`claude --help` 或 `codex -m`。HUD 只传模型标志、强度标志、该 CLI 的权限绕过标志
和 `args`。不传 home、会话或配置标志，也不设这些环境变量，分发时也不替 CLI 信任目录：
出现信任对话框则拒绝，失败原因写明 `hud trust <cwd>`。会话留在各 CLI 自己的存储里。
herdr 经交互 shell 启动 CLI，所以该 shell 的函数仍生效。

`hud trust <dir>` 把该目录加入 grok、agy 和 claude 的信任文件（先在 `$HUD_HOME` 下备份）。
文件不存在则不创建。codex 跳过。

`hud_read` 不带任务列最新 20 个；带任务读取 STATUS、报告（最多 64 KiB）与待答问题。
`wait_ms` 最多等 120000 毫秒，结算、问题或超时即返回。读取已结束报告记录 `read_at`，不代表验收。
`hud_send` 给工作中的 pi 或 CLI 任务排队消息，或在允许继续的角色的空闲宽限期内续写；`message_key` 去重。
CLI 工作者用同一条 `QUESTION` 和 `hud_respond` 流程提问（`hud-ask`，20 分钟后用默认）。
CLI 受阻时任务显示为需要你，并向编排窗格发一行通知，写明任务和窗格。
`hud_respond` 只写一次 `qN.answer.md`。`hud_close` 提前回收，正常清理由 watcher 负责。
主会话决定所有下一步，MCP 不知道工作流。工具参数见 [MCP README](../packages/hud-mcp/README.md)。

任务是 `$HUD_HOME/jobs/<job>/` 中的普通文件。pi 历史保存在
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/<cwd-dir>/`，任务的 `sessions/` 链接到主代理／助手文件。
CLI 任务由监督进程写 STATUS：工作、空闲宽限、宽限未用则 `/quit`，然后以 `settled` 关闭。
herdr 的 `idle` 或 `unknown` 只有代理已离开才算退出。按需 watcher 在创建时启动，经 `pi-role-reap` 回收已结束任务，
失败标签页保留两小时；没有未结束任务或待到期失败任务时退出。CLI 任务开着时还会检查监督进程是否还活着；
`HUD_WATCH_CLI_CHECK_MS`（默认 30000）是该间隔。监督进程已死则任务失败。已结算目录在**关闭一天后**的
后续扫描或下次创建时清理，不设专门到期定时器；包括报告及 `hud_read` 访问。删除旧 pi 任务前先将真实 JSONL
会话移至 pi 存储；CLI 和浏览器会话留在各自存储。cwd 无效、目标冲突或移动失败则保留任务。删除会话链接不删除目标。

## 项目工作者

```sh
hud setup --detect [--cwd DIR]
hud setup --apply PLAN.json [--cwd DIR]
hud setup --remove [--cwd DIR]
```

命令本身不提问。`hud-setup` 技能与 `hud-delegate` 一样，为 Claude、Codex 和 pi 安装；
它负责询问，这些命令只读或只写。

`--detect` 打印一份 JSON，不写任何文件。它给出 `--cwd` 的 git 顶层（否则就是 `--cwd`）、
该根是否已注册、参考角色（内置与 `$HUD_HOME/roles`）、项目角色、启用集合、无效角色文件、
技能，以及工作者技能链接。技能根目录来自 `$HUD_HOME/setup.json` 的 `skill_roots`，
默认 `~/.pi/agent/skills`、`~/.claude/skills` 和 `~/.agents/skills`。技能是含 `SKILL.md`
的目录，名字取 frontmatter 的 `name`。每项带 `model_invocable`：frontmatter 有
`disable-model-invocation: true` 时为 false。pi 仍加载该技能，但不放进模型的技能列表，
所以工作者不会自己选用它。

`--apply` 按计划写入项目的 `.hud/`（应提交）：

```
.hud/project.json          启用的角色，以及 apply 自己创建的链接、角色文件和提示
.hud/roles/<name>.json     仅当 pi 角色与参考角色不同
.hud/skills/<name>         指向技能目录的符号链接（仅工作者）
.hud/agents/<role>.md      可选的仅工作者提示
.hud/hud-convention.md     可选，内置约定的副本
```

计划为 version 1：`roles`（启用的名字）、`pi_roles`（只调 pi：`from`、`pi_role`、`model`、
`thinking`、`split`、`can_continue`、`skills`）、`skills`（名字到技能目录的绝对路径）、
`agents`（角色到 markdown）和 `convention`（`keep` 或 `copy-default`）。打印 `removed`、
`wrote`、`linked`、`skipped (exists)`、`registered`，或 `no changes`。同一计划再跑一次不会改任何东西。
不是本命令创建的文件或链接会留下，并报 `skipped (exists)`。

apply 把项目根记入 `$HUD_HOME/projects.json`。项目配置只有注册之后才加载。
`--remove` 去掉注册，留下 `.hud/`。克隆来的 `.hud/` 在该克隆里跑过 setup 之前不起作用。

只调 pi。其他 harness 的角色只能显示或隐藏，不改它们的文件。本命令不运行 `hud trust`。
若所选 CLI 角色的目录未被信任，请自行运行 `hud trust <dir>`。

## 首页

首页依次显示需要你回答的问题、包泳道中的任务卡片、原生会话泳道及「替你决定」。
只观测文件，不派发工作。运行中任务有待答问题才需要你；已结束任务遗留的问题不算。
报告不证明成功，显示标签不代表验收或合并。缺少证据保持未知。

卡片是标题加固定两行句子；未有文字用 `┃ …` 占位。Enter 原地展开完整句子和事实。
任务标题优先取 brief 标题，否则模型短名或任务首行按宽度显示。只有最新且仍属当前的已结束卡片
初始展开，到折叠时限为止；显式选择在本次面板生命周期内优先。泳道标题的 Enter 折叠泳道。

**面板生命周期。** 打开前已结束的任务不加载，包括决定和模型输入；`a` 不能显示它们。
活跃／未知任务不论年龄均可显示。构建重载保留最初打开时间。原生代理和项目 STATE 切片查询保持各自范围。

**卡片时限。** 已结束 HUD／原生卡片默认五分钟折为一行、十五分钟隐藏；失败／停止至少保留三十分钟。
设置 → 面板可调整。隐藏时限小于折叠时限则按折叠时限算。运行／提问卡片不隐藏。
`a` 在原位显示较早卡片／决定为暗色单行，Enter 展开。任务扫描考虑最新 200 个目录。

**决定。** 已答问答显示问题、回答、替代选项和原因；只有明确偏离写明的默认选项才显示 `≠`，
含糊自由文本不算。只有明确 `One-way: true` 才固定标出单向决定。普通决定三十分钟隐藏，偏离两小时。
评审结论需要记录的 accept／changes-required 行及已结算输出，助手退出本身不是结论。

**首页原生代理。** Claude/Codex 主会话各有泳道。子项缩进一级，更深写 `↳ parent`；
隐藏父项不隐藏活跃后代。pi 助手已是 HUD 任务。Claude 读取元数据并分批向前读取转写，记住公开 Agent/Task 嵌套。
重放保留已知完成时间，追平前不请求模型。完成后转写增长才重新运行；新 finished 元数据或已追平的公开
`end_turn` 且无未结束工具调用才再次结算。不完整读取不能证明空闲。`o` 打开转写，不切换客户端对话。

**模型推荐。** 默认保持事实顺序；推荐模式将最多 200 卡片的有限显示事实交给所选决策 API 打 0–4 分，
变化的看板最多两分钟一次。问题、失败和需要人工处理的卡片受保护，原生子树保持完整。
低分已结束卡片进入较早项，可用 `a` 显示。另一次聊天调用按总结间隔生成短简报。
无 key／失败沿用默认顺序；简报等待或失败保留上次好文字和有效排序。关闭模型同时隐藏两者。

**空余行。** 先给卡片和决定留空间，再显示 STATE Now 摘要、六状态进度条／图例、每功能最多六个未完工单。
变矮时依次减少工单、图例、条、摘要，最后整个块消失。Enter 打开对应项目节。

## 项目

项目显示等你处理、进度、本地工单、工作树、文档及初始折叠的控制面。
事实来自 `docs/handoff/STATE.md`（根 `STATE.md` 回退）、`docs/spec.md`、评审、角色／约定／指令及 Git 工作树。
不猜里程碑或完成。密钥只显示名称及是否存在；浏览器 ✓ 仅指 Chrome 和 `jev-ask` 在 PATH，非运行或登录证明。

进度统计 STATE `## Slices` 的 working、blocked、try（已落地待试）、todo、accepted、dropped。
里程碑来自 spec §5 与 STATE `Milestone:`；摘要取 Now 标题，切片块复用当前卡片文字。
漂移标记表示缺失／未列工作树或非活跃账目状态，不回写 STATE。Next 最多四个合并后的条目。

工单读取 `.scratch/<feature>/issues/<NN>-<slug>.md`，最多 16 功能 ×64 文件，每份 64 KiB。
必须有匹配编号的 `# NN: title`、`**Blocked by:**`、`**Status:**`。
状态 done/closed/complete，或至少一个复选框且全部勾选，即完成；否则未完／未解析依赖为受阻，无依赖为就绪。
编号／标题只在同功能内解析，未知状态原样暗显。包名和工单编号／文件名匹配的任务补充角色、状态与年龄，
不决定完成。最新 64 目录的任务查询与切片共享。

Enter／`o` 折叠标题或在 `$EDITOR`（默认 vim）的 herdr 标签页打开文件，编辑器退出即关闭；
工作区查询失败则退为旁侧分割。首页和项目保留各自光标／滚动。完整项目采集只在页面可见且无遮挡时运行；
首页只复用 STATE／工单缓存。Git 最多每五秒一次。不启动浏览器或 MCP。

## 面板

### 布局与重载

首页、项目是两个标签。详情、改动、设置和帮助共用标题带、精确列宽的行和完整页脚提示（窄时从右丢弃）。
没有 Agents 区、叠放／紧凑布局、时间线、活动中心、代理日志、Summary 或诊断页。各页保留选中／滚动。
图标为 `unicode` 或 `text`，旧 nerd/emoji 值按 unicode 加载。

安装目录入口变化稳定两秒后，限时子进程先验证导入，成功才在原窗格重启。
选中、滚动、折叠、显示全部、覆盖页、设置光标、打开时间与宽度覆盖保留。
未保存设置延迟重载；坏构建保留旧面板并暗显提示。状态行独立，新代码需重启。
明确空闲且不变的观测可放缓至五秒采集，输入／绘制独立。

### 按键

Codex 中先按前缀（默认 `Ctrl+\`）再按键；设置／帮助之外的普通输入交给 Codex。独立面板直接处理按键。

| 键 | 作用 |
|---|---|
| `1`、`2`、`3` | 首页、项目、改动摘要 |
| Tab/Shift-Tab、左右 | 首页 ⇄ 项目 |
| 上下（`j`/`k`）、PgUp/PgDn、Home/End（`g`/`G`） | 移动／翻页／首尾 |
| Enter | 展开／折叠卡片、问题、决定或泳道 |
| `o` | 打开问题与答案，否则报告，否则 brief；原生项打开转写 |
| `v`、Space、`4` | 详情 |
| `a` | 显示／隐藏较早任务和决定 |
| `n`/`N` | 下／上一个问题项 |
| `b` | 模型文字总开关，也可点击顶行模型文字 |
| `,`、`?` | 设置、帮助 |
| Esc | 返回；未保存设置询问保存／放弃／继续；独立主页面退出 |
| `q` | 关闭面板 |
| 连按前缀 | 向有光标的窗格发送前缀本身 |

Codex 移动连按半秒内无需前缀。设置可选 `Ctrl+\` 或 `Ctrl+]`；旧设置无显式前缀时保留 `Ctrl+]`。
F12 关闭／打开 Codex 面板，Shift-F12 打开并聚焦。鼠标单击选中，再击展开；滚轮不移动选中项。
点击空白边沟让键盘留在面板，直到 Esc。帮助列当前快捷键。

### 详情

卡片／问题／决定展开，下列角色／客户端、模型／强度、包、状态／阶段与观测到的本地时间。
文件区列 brief、问答、评审、报告，上下选中，Enter／`o` 打开。
原生卡片列转写和已有上下文百分比、估算 tokens/s、累计 tokens；缺失省略，不额外调用模型。
不保留阶段／日志历史或对话切换控件。

### 改动摘要

`3` 显示分支／HEAD、领先／落后（无上游证据则未知）、改动计数及每工作树路径／分支／脏状态一行。
没有文件列表、diff、预览、暂存、提交或 checkout。仅聚焦时采集，失败／过时状态保持未知，禁用仓库过滤器及惰性下载。
子模块工作树内的未提交改动不会让 Codex 状态行、pi 页脚或项目显示为脏；子模块提交指针移动则会。变更视图完全忽略子模块。

### 设置

| 组 | 行 |
|---|---|
| 显示 | 主题、状态行样式、图标、语言 |
| 面板 | 首页模式、宽度、停滞阈值、折叠时间、隐藏时间、提醒、刷新、鼠标 |
| 模型 | 模型文字、模型、决策 API、调用上限、决策上限、总结间隔、独立小时计数、测试 API |
| Codex | 前缀键、启动状态行 |

四组常开。上下选择，左右／Enter 修改，`s` 保存、`r` 只重置本组、`t` 启动／取消测试。
有修改离开时询问保存并离开／放弃修改／继续编辑（默认）；保存失败保留草稿。主题和图标在草稿中预览。
没有全部重置、手风琴或背景图。

宽度预设 40/48/56（默认）/64/80/100，存储 16–200 可读，0 表示默认。
保存宽度立即调整各客户端面板，尽量留 41 列给代理；窗口变化重新应用，拖边框或保存无关设置不干扰。
折叠默认五分钟、隐藏十五分钟（保存 1–1440）。停滞默认十分钟（1–120）；模型关闭时会话写入也算活动。

主题为 `terminal`（默认）、`titanium`、`mocha`、`arctic`、`ember`、`contrast`、`latte`、`paper`、`none`。
每个有首页／项目／详情配色，latte/paper 为浅色，none／`NO_COLOR` 无颜色。
设置私有保存到 `$HUD_HOME/hud-settings.json` 或 `HUD_SETTINGS_PATH`，保存的显示设置覆盖环境默认值。
旧卡片／布局／模型功能键忽略并在保存时丢弃，不迁移；已有缓存／资源文件不删除。

## 模型文字

一个总开关控制任务／原生名称与句子、决定标题／详情、决策标签、推荐首页排序／简报。
从不写工作流事实或指挥工作者。关闭则隐藏并不请求；无保存偏好时，存在 Mistral/OpenAI/Gemini key 默认开启。
聊天仍需匹配端点 key，决策另需 Gemini/OpenAI/TypeSafe key。

| 设置 | 键／默认值 |
|---|---|
| 模型文字 | `modelEnabled`，依 key |
| 模型 | `model`，`deepseek-v4-1-flash-1017` |
| LLM 上限 | `modelCallsPerHour`，60；30/60/120/240/无限 |
| 决策上限 | `decisionCallsPerHour`，0；600/2000/无限 |
| 总结间隔 | `summaryIntervalMinutes`，5；2/5/10/15/30 分钟（验证 1–120） |

两上限以 0 表示无限，仍计数 `n/∞`。同一 HUD 主目录的面板合计。
文字用 `display/model-cache/calls.json`，标签／排序用 `display/model-cache/decision-api/calls.json`，包括回退尝试。
各计数下一行按次数列功能。变化的运行文字按总结间隔请求；最终句子及排序保留两分钟下限。
同次结算成功后最终句子冻结，继续运行再结算才更新。

**外发材料**（仅公开频道，不含推理、密文或转写提及的文件）：

| 功能 | 输入 |
|---|---|
| 任务句子／名称 | brief 标题目标（1500 字节头）、STATUS、待答问题（2 KiB）、评审结论、结束报告四行、32 KiB 工作会话尾部四段公开文本／工具块 |
| 原生句子／名称／结果／原因 | 名称角色各 80 字符、任务／创建前原文 400、报告 600、动作 200、结果头尾 8000、错误 2000；已结束 Codex 可读安全 32 KiB 尾部，Claude 复用已读文本 |
| 决定标题／本地化详情 | 问题和答案各 4096 字节；最多八词标题及忠实的问题／答案／替代／原因 |
| 结果标签 | 最终状态及报告前 12 行（4096 字节头），每次结算一次 |
| 类型标签 | brief 前两段（1500 字节头），运行中或结束一天内每任务一次 |
| 反复失败标签 | 同一安全尾部最近 12 对工具／结果，各部分 600 字符；安静三分钟后最多五分钟一次，输入不变不重问 |
| 问题类别 | 4096 字节问题头，每观测任务最多 100 问 |
| 评审严重度 | 最新 32 KiB 评审头或已结束评审报告最多 24 列表项，各 400 字符 |
| 首页排序／简报 | 最多 200 卡片的 id、泳道、状态、角色 80、标题 160、年龄、句子原因 240、问题标记、结果；无正文 |
| 测试 API | 固定合成消息 |

结果／类型／反复失败／类别／严重度是仅显示的枚举，切语言本地翻译。失败不显示提供方 HTTP 文本。
私有修订缓存重开复用，句子／标题各最多 200 记录，输入不变不再调用。
句子最多三个待处理句柄，共用单飞聊天队列；决策标签独立单飞。标题强度 none、句子 low、首页简报 high，
没有模型分档／强度选项。明显错语言的回复拒绝。`«keyword»`、`«+approve»`、`«-reject»`、`«!opinion»`
及短中文 `「…」` 在卡片／决定／详情共用着色，文件路径保持标识符色。不生成旧回顾、会话标题或改动摘要。

聊天连接在设置文件配置，不在面板编辑：

```json
{
  "modelEnabled": true,
  "model": "deepseek-v4-1-flash-1017",
  "modelCallsPerHour": 60,
  "briefingApiBase": "https://api.mistral.ai/v1"
}
```

空 base 用 Mistral。`POST <base>/chat/completions` 只收到精确源匹配的 `MISTRAL_API_KEY` 或 `OPENAI_API_KEY`，
环境优先于 HUD 凭证。自定义／HTTP／仿冒／非默认端口均不发送这两个 key；拒绝用户信息 URL 和重定向。
无匹配 key 不请求。`CODEX_HUD_BRIEF_MODEL` 覆盖模型 id。测试 API 三次固定合成请求，共用模型和上限，
256 输出 token 加推理额度、十五秒超时；关闭总开关／无 key 不发请求，离开设置取消。

## 底部状态行

Claude 状态行、pi 页脚、Codex tmux 状态行共用事实渲染器：

```text
model effort │ context %/window │ repo branch(dirty) │ quota │ notices ··· MCP n  skills n
```

上下文十格，70% 前绿、70% 起黄、85% 起红，有数据时对齐客户端压缩窗口。
Claude/Codex 只显示各自最紧额度窗口，蓝、75% 起品红、90% 起红；pi 用会话费用，位于编辑器右上条带，不在底部重复。
缺失事实省略。代理／任务开始、完成、失败及 Claude 技能加载事件保留三分钟。
待批准／待答问题固定显示。没有时钟、速率、任务数、hooks 数、当前工具或空闲回退文字。

设置样式：`line`、`p10k`、`gauge`、`tide`、`micro`、`stacked`、`headline`、`triptych`。
Stacked 在 Claude/pi 为两行，Codex 回退 line；Tide 底色需 truecolor。文字图标／无色仍保留含义。
`barFields` 从 `model,context,project,quota,notice,loaded` 选择，不改变顺序。
变窄先丢加载详情、表条、重置时间、项目细节，再考虑模型；通知按词截断，模型永不丢弃。
pi 顶条跟随样式，其它扩展状态保留。状态行仅英文。

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

以下字段／分组修改保存到 `$HUD_HOME/config.json` → `piFooter`；保存失败时只在本会话生效并警告。
`/hud footer` 或 `/hud footer list` 按组列出已启用字段及配置路径。
`/hud footer reset` 将全部字段恢复为开启。`/hud footer band on|off` 切换顶条组，
`/hud footer footer on|off` 切换底部组。
`/hud footer on|off|toggle <segment...>` 修改指定字段，或用 `all` 代表全部
（例如 `/hud footer off lens viz`、`/hud footer on all`）。不带字段的
`/hud footer on|off` 是会话内整个框架的开关，不是持久化的分组修改。

底部组 id：`model thinking path git mcp skill lens viz statuses context`。
顶条组 id：`session cache tokens tps ttft cost time`。这些开关只控制字段可见性，不会产生缺失事实。
context 属于底部组，但存为 `piFooter.band.context`；其它 id 按分组存到
`piFooter.footer` 或 `piFooter.band`。

## 机器可读状态

活跃 Codex 状态行／面板在事实变化时每秒最多一次，私有原子写入
`$HUD_HOME/display/state/<tmux-session>.json`。`hud codex --json` 读取当前目录会话快照：

```sh
hud codex --json | jq '.context.percent, .agents.active, .attention[].label'
```

Version 2 含会话、项目、上下文、额度、tokens、代理、注意事项，可选健康／速率证据及状态行字段列位置
（面板 `bar.segments` 为空）。主会话代理、子任务、守护评审分别计数。无事实省略，不填零。
写入者按原子文件 device/inode 判断所有权，退出者不删除接替者快照。无 owner sidecar。

**输出速度。** 原生详情可显示 `~42 tok/s`，本轮输出增量除以时间减去完整已知工具等待并集，
含首字等待和停顿，不是精确解码速度。需两个计数样本，不变计数不刷新；旧值标上次，不冒充实时。

## 配置

`HUD_HOME` 默认 `~/.hud`，`HUD_SETTINGS_PATH` 覆盖设置路径。
`CODEX_HOME` 默认 `~/.codex`，只读转写和 Codex 配置，不存 HUD 状态。

| 环境变量 | 含义 |
|---|---|
| `HUD_BAR_STYLE`、`HUD_BAR_FIELDS` | 状态行默认值，也支持 `CODEX_HUD_BAR_STYLE`、`CODEX_HUD_BAR_FIELDS` |
| `CODEX_HUD_THEME`、`CODEX_HUD_ICONS` | 主题／图标默认值 |
| `NO_COLOR` | 任何非空值禁用颜色，优先于保存值 |
| `CODEX_HUD_STATUSLINE` | 默认 1，0 禁用新 HUD 会话的 Codex 状态行，优先于设置 |
| `CODEX_HUD_TREE_WIDTH` | 无保存值时 tmux 面板初始宽度 |
| `CODEX_HUD_CWD`、`CODEX_SESSIONS_PATH` | 显式工作区／会话目录 |
| `CODEX_HUD_MOUSE`、`CODEX_HUD_AUTO_ATTACH` | 鼠标策略、显式自动复用偏好 |
| `CODEX_HUD_NOTIFY`、`CODEX_HUD_NOTIFY_DESKTOP`、`CODEX_HUD_NOTIFY_COOLDOWN` | 提醒开关、冷却（默认三百秒） |
| `CODEX_HUD_PROFILE` | 1 将阶段计时写入 `display/profile.log` |
| `CODEX_HUD_FONT_DIR` | 可选 `bin/codex-hud-fonts` 字体安装／检查目录 |

提醒默认关闭，经 tmux、可选桌面 OSC/notify-send 报告观察到的失败、审批和完成，不自动批准或重试。

**凭证。** `$HUD_HOME/credentials.env` 必须是普通 0600 文件，不跟随 symlink/FIFO。
`NAME=VALUE` 可有引号／export，不插值。环境逐项优先，不隐式导入客户端／jev 密钥。
已知 key 包括 `MISTRAL_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`TYPESAFE_API_KEY`。

**决策 API。** `$HUD_HOME/config.json` 的 `decisions.primary` 默认 openai，`decisions.fallback` 可选，
值为 gemini/openai/typesafe。设置只存 primary，不存 key。自动回退按 Gemini → OpenAI → TypeSafe 选择另一个有 key 的提供方，
最多一次，处理缺密钥、额度、鉴权、5xx、超时，不处理格式无效或拒绝。Gemini 额度回复按服务端延迟或六十秒在进程内冷却。
浏览器 CLI 独立管理配置。

**显式导入。** `hud import preview`／`apply` 只读指定旧文件（及已有 HUD `jev.env`），不猜 Codex home。
已有值优先，apply 私有备份修改目标，输出只有名称没有值。`--pi-footer` 导入明确指定的 p10k-footer JSON。
来源只能是旧 `hud-settings.json` 与 `.env` 文件；旧 jev-ask TOML 会被拒绝（浏览器 CLI 自管配置）。

```sh
hud import preview --from /tmp/synthetic-old/hud-settings.json
hud import apply --from /tmp/synthetic-old/hud-settings.json
```

**Codex 配置。** 显示层读取模型／推理强度、压缩窗口、额度、MCP 和技能事实，不编辑 Codex 配置／转写。
客户端 MCP 注册是显式安装行为，不是只读显示循环的一部分。
