## Modification History

| Date       | Summary of Changes |
|------------|--------------------|
| 2026-05-22 | 补充 Windows 用户当前 branch 下载、self-check、运行流程，并加入 WSL 截图。 |
| 2026-05-22 | 将 Windows 默认启动策略切换为 WSL-only，并标注 native PowerShell HUD 暂未支持。 |
| 2026-05-22 | 记录 Windows 显式启动模式参数与 Bash installer 依赖诊断提示。 |
| 2026-05-21 | 更新 Windows PowerShell、cmd 与 WSL 双入口行为说明。 |

<p align="center">
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
  <a href="./README.zh.md"><img src="https://img.shields.io/badge/lang-中文-red.svg" alt="中文"></a>
  <a href="./README.ja.md"><img src="https://img.shields.io/badge/lang-日本語-green.svg" alt="日本語"></a>
  <a href="./README.ko.md"><img src="https://img.shields.io/badge/lang-한국어-orange.svg" alt="한국어"></a>
</p>

# Codex HUD

[OpenAI Codex CLI](https://github.com/openai/codex) 的实时状态栏 HUD。轻量、零配置、在 tmux 中运行。

> 灵感来源于 Claude Code 的 [claude-hud](https://github.com/jarrodwatts/claude-hud)。

![Codex HUD — 单 Session 模式](./doc/fig/2a00eaf0-496a-4039-a0ce-87a9453df30d.png)

## 为什么需要 Codex HUD？

**Q: Codex CLI 本身就能用，为什么还需要 HUD？**

因为没有它你就是在盲飞。Codex HUD 在终端底部提供一个持久的仪表盘：

- **分支、模型、权限** —— 一目了然，不用猜
- **Token 用量（含 cache）** —— 精确知道烧了多少上下文
- **Context 窗口填充条** —— 快撞墙时提前知道
- **MCP 服务器状态 & 工具调用** —— 看 Codex 实际在干什么
- **Reasoning effort 级别** —— 当前思考深度一目了然

**Q: session 会派生子代理，我能看到它们在做什么吗？**

可以。按 `F12` 打开右侧的**子代理树**：当前 session 派生的每个代理、它的模型与推理强度、正在运行还是已结束或失败、以及是谁派生的它。再按一次 `F12` 关闭。整个过程状态栏一直在。

`Ctrl+T` 被刻意留空 —— 那是 Codex 自己的转写面板。

![Codex HUD — 子代理树](./doc/fig/6d0edbdd-19b5-4038-b9a3-ca5341fd39d1.png)

**Q: 需要手动配置 tmux 吗？**

不需要。Codex HUD 自动激活 tmux。只需输入 `codex`，HUD 就会出现。如果没装 tmux，安装程序也会搞定。

## 快速开始

```bash
git clone https://github.com/CartmanFatass/codex-hud.git
cd codex-hud
./bin/codex-hud-install

# 刷新 shell，然后直接输入：
codex
```

### Windows 当前 branch（默认 WSL）

当前 branch 在 Windows 上只把 WSL HUD 作为受支持的 HUD 运行时。PowerShell 和 cmd 只是启动 shell；HUD 本身会在 Ubuntu WSL 的 Bash + tmux 中运行。

1. 下载并切换到当前 branch：

```powershell
git clone https://github.com/CartmanFatass/codex-hud.git
cd codex-hud
git switch feature/windows-support-dual-entry
.\bin\codex-hud-install.ps1
```

2. 打开新的 PowerShell 或 cmd 窗口，然后检查 WSL runtime：

```powershell
codex --self-check
```

![Windows WSL self-check](./doc/fig/wsl-self-check.png)

3. 启动 Codex HUD：

```powershell
codex
```

![Windows WSL launch](./doc/fig/windows-wsl.png)

说明：

- `codex` 在 Windows 上默认启动 WSL HUD。
- `codex --wsl ...` 显式使用同一条 WSL HUD 路径，并在转发给 Codex CLI 前移除 wrapper 参数。
- native PowerShell HUD 暂未作为用户启动模式支持；legacy native-mode 请求会 fail fast 并提示使用 WSL HUD。
- `codex-hud-wsl` 是显式 WSL 完整 HUD 命令。
- `cmd.exe` 用户会获得托管 `.cmd` shim，并通过同一套 PowerShell entrypoint 启动。

### 管理命令

首次安装后，以下命令自动加入 shell：

| 命令 | 说明 |
|------|------|
| `codex-hud-sync` | 重新构建并刷新当前 checkout 的别名 |
| `codex-hud-upgrade` | 拉取最新代码后重新构建 |
| `codex-hud-uninstall` | 移除别名并停止 HUD 会话 |

## HUD 显示了什么？

终端底部常驻一行。相关的字段用两个空格相邻，组与组之间用淡化的 `│` 分隔；会话计时与按键提示靠右对齐：

```
▸ Edit: src/types.ts · 1m20s  ☀● Astra  codex-hud git:(main * ↑2) │ Agents 1 run · 1 ok  Ctx ████▎░░░░░ 42% (114.2K/272K)  ◷~00m │ 2/5  Q61%            30m  F12
```

有事需要你处理时，它会排到最前面：

```
! 1 tool failed · 1 agent failed │ ▸ Edit: src/types.ts · 1m20s  ☀  main* │ 1▸1✗  Ctx 42%  ◷~00m │ 2/5  Q61%    30m  F12
```

| 字段 | 含义 |
|------|------|
| `!` | HUD 实际观测到的异常：工具返回失败、代理以错误结束、额度窗口报告已满 |
| `▸ Edit: src/types.ts · 1m20s` | 本轮正在做的事：运行中的工具、它的目标、以及本轮已经进行的时间。窗口变窄时只保留标记和用时，再窄只剩标记 |
| `☀● Astra` | 模型家族与推理强度：`○` low、`◐` medium、`◕` high、`●` xhigh、`◆` max、`✦` ultra |
| `codex-hud git:(main * ↑2)` | 项目、分支、未提交改动、领先/落后 |
| `Agents 1 run · 1 ok · 1 fail` | 子代理按结果计数。成功与失败分开统计；没有观测到状态的代理记为 `?`，不会算作运行中 |
| `Ctx 42% (114.2K/272K)` | 上下文窗口占用，精度细到八分之一列；`↻2` 是压缩次数 |
| `◷~00m` | 距上一次模型用量的分钟数，用作提示缓存提醒；25 分钟时转为警告，封顶于 `30m+` |
| `2/5` | 当前计划已完成的步骤数 |
| `Q61%` | 账户额度窗口的消耗比例。这是额度，不是任务进度；`↺1h23m` 是距下次重置的时间 |
| `84K` | 本次会话消耗的 token |
| `F12` | 打开子代理树。会话进行十分钟后，若没有子代理可开，它会自行退场 |

只有拿到真实数据的字段才会出现。没有额度快照就不显示额度，而不是显示一条为 0 的进度条。

点击状态栏时，落在哪个字段上就是什么动作：告警、代理计数与 `F12` 提示会打开侧栏并把键盘交给它；
各类仪表只打开侧栏，光标留在 Codex；点在其他位置则与过去一样整条切换。

### 窗口变窄时

先缩短，再隐藏；隐藏从最不重要的开始；告警永远不会被丢掉。40 列、且有失败时：

```
!2 │ ▸  ☀  main* │ 1▸1✗  Ctx 42%  ◷~00m
```

### 密度预设

| 预设 | 显示内容 |
|------|----------|
| `focus` | 告警、模型、项目、代理、上下文 |
| `balanced`（默认） | 在 focus 基础上加计划进度、额度、输出速度、会话计时 |
| `full` | 全部，包括 token、审批/沙箱、Session ID |

```bash
CODEX_HUD_DENSITY=focus codex
```

## 开发面板

`F12` 在右侧打开面板，光标仍留在 Codex。`Shift+F12` 打开并把光标移进面板。

面板默认显示 Agents 和 Worktrees；Changes、Inspector 按需打开。焦点标题和选中行高亮，状态颜色集中在图标上：

| 区域 | 内容 |
|------|------|
| **1 Agents** | 子代理树、状态、模型/推理图形，长名字缩短时优先保留图形 |
| **2 Worktrees** | 各 worktree 的分支、目录和修改/冲突状态 |
| **3 Changes** | 所选 worktree 的文件列表、暂存/未暂存状态和冲突；窄屏也可选择文件 |
| **4 Inspector** | 代理状态与活动时间、worktree 详情，或带增删配色的文件 diff |

各区域纵向排列；Worktrees 按内容收缩，剩余空间优先给 Agents 或当前 Inspector。16–20 列减少边距，`z` 可放大当前区域。
每个区域保留自己的滚动位置。选中代理按 ID 保持，选中文件按路径保持。

| 按键 | 作用 |
|------|------|
| `Tab` / `Shift+Tab` | 切换区域 |
| `1` / `2` / `3` / `4` | 直接聚焦对应区域 |
| `j` / `k`、`↑` / `↓` | 移动选中项或滚动详情 |
| `PgUp` / `PgDn`、`g` / `G` | 翻页、跳到开头/末尾 |
| 鼠标点击 / 滚轮 | 选择或滚动；点击区域标题折叠/展开 |
| `,` 或 **Settings** | 打开设置；方向键或点击修改，`s` 或 Save 保存 |
| `h` / `l`、`←` / `→` | 在树中折叠、展开或移动到父/子节点 |
| `s` | 切换活跃优先 / 创建顺序 |
| `a` 或点击摘要行 | 显示 / 隐藏已被收起的已完成代理 |
| `f` 或 `/` | 筛选全部、运行中、失败、未知 |
| `Enter` / `v` | 打开 Inspector；在 Inspector 内展开/收起完整时间、ID 和路径 |
| 点击 agent / `o` | 将实际 Codex 对话切换到该 agent |
| **Main** / `m` | 将 Codex 对话切回主会话 |
| `x` / `-` | 关闭 / 折叠当前区域；`1`–`4` 可重新打开 |
| `z` | 放大/还原当前区域 |
| `?` | 可换行、滚动的快捷键帮助；支持方向键、滚轮、PgUp/PgDn、g/G |
| `Esc` | 关闭帮助、还原放大、返回列表；在 Agents 下关闭面板 |
| `q`、`Ctrl+C` | 关闭面板 |

会话切换通过 Codex 0.154 的 `/subagents` 选择器按完整 UUID 定位并核验。需要空输入框或已识别的选择器；有草稿、处于复制模式、无法识别界面或 ID 被截断时，会提示原因。键盘移动选中项只预览，按 `o` 才切换。目标已在选择器可见范围内时，合并移动操作，并在 Enter 前再次核对完整 ID。切换后不再重复打开选择器，避免二次弹窗和对话重绘；请求已发送不等于独立确认了最终显示的会话。

活跃排序只调整同级节点：有运行中子孙的分支优先，按最新一轮启动时间排序，普通 token 或日志更新不会改变顺序。
父子关系支持两种日志元数据格式。没有状态证据的代理显示为未知，不会凭最近写入时间判定为运行或完成。

代理以任务路径的最后一段命名，与 Codex `/subagents` 选择器显示的名字一致：`/root/essays_2020_2021` 显示为 `essays_2020_2021`。Codex 随机分配的昵称（Copernicus、Meitner 等）和角色移到 Inspector 中。Guardian 审查线程显示为 `guardian`。

已完成的代理在完成 3 分钟后从列表中收起。运行中和失败的代理不会被收起；子代理仍在显示的已完成父代理保留为淡化行。每个已完成的行都显示完成了多久；摘要行统计被收起的数量（`+12 older`），点击摘要行或按 `a` 即可全部显示。

Inspector 默认显示名字、模型/effort、状态、本轮经过时间和最近活动。按 `v` 展开完整时间与会话 ID。会话切换提示显示在底部；点击 Agents 摘要或空白行不会切换会话，只有具体条目会触发切换。

Changes 属于选中的 worktree，不推断某个文件由哪个 agent 修改。状态的第一列是暂存区，第二列是工作区；窄屏摘要中 `Δ` 是修改文件数，`S` 是暂存、`U` 是未暂存数量。
选中文件后按 Enter 打开暂存和未暂存 diff，自动放大 Inspector；Esc 还原。新增行绿色、删除行红色、hunk 标记青色，保留 `+` / `-` 符号；长行会折行，未跟踪文件提供有大小限制的内容预览。
这些操作只读取 Git 数据；禁用外部 diff、内容过滤器和部分克隆的自动下载，不提供暂存、提交或切换分支操作。

Settings 提供四档宽度：窄（16 列）、默认（沿用原来的 20–30 列策略）、宽（45 列）、更宽（70 列）。保存后立即调整，并为主对话区保留空间。没有保存过设置时，仍支持 `CODEX_HUD_TREE_WIDTH` 指定初始宽度。

独立设置页可调整密度、主题、模型标签、上下文口径、底栏开关、动画、排序、鼠标、各区域、刷新间隔和宽度。未保存字段带 `*`；底栏开关标注 Next launch。Save 写入 `$CODEX_HOME/hud-settings.json`（可用 `CODEX_HUD_SETTINGS_PATH` 改路径），紧凑 HUD 下次刷新时同步显示偏好。已保存设置优先于环境默认值，`NO_COLOR` 始终优先。Back 放弃未保存修改；Reset 或 `r` 恢复默认草稿，需 Save 才应用。窄屏保留完整 Back/Save 按钮，使用短标签。

### 输出速度

默认状态栏新增 `Out ~42.1 tok/s`，选中代理的详情也会展示其可用读数。
它用日志里的**累计输出 token 增量 / 日志时间差**估算最近约 30 秒的吞吐，展开详情后注明实际采样窗口。
这不是纯模型解码测速，窗口可能包含工具或服务等待时间；新一轮开始时排除跨轮空闲时间。
没有足够样本时不显示；10 秒没有新样本后显示 `last ~42.1 tok/s`，保留上次读数。
Ctx 仍保留当前占用与压缩次数，开发面板不绘制 Ctx 趋势。

## 使用方法

```bash
codex                        # 启动并自动显示 HUD
codex --model gpt-5          # 传递 Codex CLI 参数
codex --wsl --model gpt-5    # Windows 下显式使用 WSL HUD
codex "help me debug this"   # 带初始提示
codex-resume                 # 恢复上次会话
```

<details>
<summary>更多命令</summary>

```bash
codex-hud --kill             # 终止当前目录的会话
codex-hud --list             # 列出所有 HUD 会话
codex-hud --json             # 以 JSON 输出当前目录会话的 HUD 状态
codex-hud --attach           # 复用已有会话
codex-hud --new-session      # 强制新建会话
codex-hud --self-check       # 运行环境诊断
```

</details>

### 机器可读的状态

状态栏会按窗格宽度自我裁剪：能缩就缩，放不下就藏。这对读者是对的，对脚本是错的。
所以每一次采集也会把已知状态写到 `$CODEX_HOME/hud/state/<tmux 会话名>.json`，
`codex-hud --json` 则打印当前目录会话对应的那一份。

```bash
codex-hud --json | jq '.context.percent, .agents.active, .attention[].label'
```

其中包含会话、项目、活动、上下文、额度、token、代理与需要关注的事项，
另有 `bar.segments`：真正画出的那一行里，每个字段落在哪几列。
点击某一列能对应到某个字段，靠的就是它。

规则与显示一致：每个值都是观测到的事实，没有数据的字段整个缺席而不是写 0，
这样“没有额度快照”和“额度为 0%”不会长得一样。文件以 `0600` 权限原子写入，
只在时钟之外确有变化时才写，且每秒至多一次；HUD 退出时删除——
一个已经停止的 HUD 留下的状态文件，看起来会像还活着。

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CODEX_HUD_DENSITY` | `balanced` | 状态栏显示密度（`focus` / `balanced` / `full`） |
| `CODEX_HUD_THEME` | `terminal` | 配色（`terminal` / `mocha` / `latte` / `none`） |
| `CODEX_HUD_GLYPHS` | `both` | 模型标记样式（`glyph` / `text` / `both`） |
| `CODEX_HUD_STATUSLINE` | `1` | 默认开启底部状态栏，设为 `0` 关闭；覆盖 Settings 的 Bar next launch，下次新建会话生效 |
| `CODEX_HUD_CONTEXT` | `used` | 上下文百分比：`used` 已用 / `remaining` 剩余；也可在 Settings 保存 |
| `CODEX_HUD_POSITION` | `bottom` | HUD 面板位置（`top` / `bottom`） |
| `CODEX_HUD_HEIGHT` | `1` | HUD 高度（行数） |
| `CODEX_HUD_MOUSE` | `1` | 启用鼠标/触控板滚动 |

状态图形使用语义配色：青色 `▸` 工作中、绿色 `✓` 本轮结束、黄色 `■` 已中断、红色 `✗` 失败。读取暂时失败时显示黄色 `?`；`Ctx~` 表示当前仍是上一份上下文采样，等待新一轮或压缩后的 token 报告。安静的日志不会自行把工作中改成空闲。

缓存提醒也在同一行：`◷~08m` 表示距最近一次模型用量报告约 8 分钟，每满一分钟更新；25 分钟变黄，30 分钟后显示红色 `◷~30m+`，新用量报告到达时重新计时。采用 30 分钟提醒窗口，`~` 表示估算，不代表服务端确认缓存仍有效或已经过期。读取异常时改用 `?`；没有采样时不显示。提醒在所有密度中启用，25 分钟后优先保留在窄窗口中；纯文字模式显示 `Cache ~25m`。

上下文比例已对齐 [Codex 0.154 的计算](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/protocol.rs#L2258)：使用最近一次 token 报告，从已用量和窗口大小两侧扣除 12K 固定基线。`Ctx 20%` 对应原生的 `80% context left`；括号中显示扣除基线后的已用量/可用窗口。自定义窗口不超过 12K 时按原始窗口计算。总会话 token 不用于计算上下文占用。

```bash
CODEX_HUD_STATUSLINE=0 codex               # 关闭底部状态栏，仍可使用侧栏
CODEX_HUD_CONTEXT=remaining codex         # 与原生状态栏同方向显示剩余比例
CODEX_HUD_GLYPHS=glyph CODEX_HUD_THEME=mocha codex
```

已有保存的显示设置优先于环境默认值，可在侧栏 Settings 的 Context percent、Theme、Model labels 中修改。主区域滚轮在应用接收鼠标时转发给应用，否则保留 tmux 历史滚动；HUD 使用独立按键表，侧栏右键不再粘贴或夺走键盘焦点。

底部状态栏也可在 Settings 的 **Bar next launch** 中保存开关，下一次新建 HUD 会话生效；显式 `CODEX_HUD_STATUSLINE` 优先于保存值。

<details>
<summary>全部环境变量</summary>

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CODEX_HUD_NOTIFY` | `0` | 通过 tmux 提示失败与代理结束 |
| `CODEX_HUD_NOTIFY_COOLDOWN` | `300` | 同类提醒之间的冷却秒数 |
| `CODEX_HUD_NOTIFY_DESKTOP` | `0` | 额外发送桌面通知（需同时 `CODEX_HUD_NOTIFY=1`） |
| `CODEX_HUD_REDUCED_MOTION` | `0` | 关闭通信标记的动画 |
| `NO_COLOR` | （未设置） | 任意取值都强制使用 `none` 配色 |
| `CODEX_HUD_HEIGHT_AUTO` | `0` | 根据宽度自动调整高度 |
| `CODEX_HUD_HEIGHT_MIN` | `CODEX_HUD_HEIGHT` | 自动模式最小高度 |
| `CODEX_HUD_HEIGHT_MAX` | `12` | 自动模式最大高度 |
| `CODEX_HUD_AUTO_ATTACH` | `0` | 自动复用同目录最新会话 |
| `CODEX_HUD_ALTERNATE_SCREEN` | `0` | codex pane 的 tmux alternate-screen |
| `CODEX_HUD_CLEAR_SCROLLBACK` | `0` | 首次渲染时清理 scrollback |
| `CODEX_HUD_CWD` | （未设置） | 覆盖工作目录 |
| `CODEX_HOME` | `~/.codex` | Codex home 目录 |
| `CODEX_SESSIONS_PATH` | （未设置） | 覆盖 sessions 目录 |

</details>

### 提醒

默认关闭：Codex 自己有通知机制，同一件事弹两次比不弹更糟。用 `CODEX_HUD_NOTIFY=1` 开启。

```bash
CODEX_HUD_NOTIFY=1 codex
```

它只提醒观测到的失败、Codex 正在等待的审批，以及已结束的代理，每次发生只发一条，并带冷却时间，避免状态反复时刷屏。
它不会对会话做任何操作：不自动确认、不发送按键、不自动重试。

`CODEX_HUD_NOTIFY_DESKTOP=1` 会额外发出终端之外的桌面通知。这是第二道开关：走出终端比发一条 tmux 消息要冒昧得多。

```bash
CODEX_HUD_NOTIFY=1 CODEX_HUD_NOTIFY_DESKTOP=1 codex
```

两条通道都是尽力而为，不支持时静默：一条是终端自己可能响应的 OSC 9 与 OSC 777 序列（包在 tmux passthrough 里，由启动脚本负责开启），另一条是 Linux 的 `notify-send` 或 macOS 的 `osascript`。
通知文本来自 rollout，写出前会剥掉全部控制字符：消息无法提前结束序列、把剩下的内容当成终端命令执行。

### config.toml

HUD 从 `CODEX_HOME/config.toml` 读取配置：

```toml
model = "gpt-5.2-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp_servers.my-server]
command = ["node", "server.js"]
enabled = true
```

## 系统支持

| 平台 | 状态 |
|------|------|
| Linux | 已支持 |
| macOS (Apple Silicon) | 已支持 |
| macOS (Intel) | 待测试 |
| Windows PowerShell | 已支持为启动 shell；native PowerShell HUD 暂未支持 |
| Windows cmd | 已支持（托管 `.cmd` shim） |
| Windows WSL Ubuntu | 已支持（Windows 默认 HUD 路径与 `codex-hud-wsl` 完整 HUD 入口） |

## 开发

```bash
npm install && npm run build   # 构建
npm run dev                    # 监听模式
node dist/index.js             # 直接运行 HUD
```

在 Windows PowerShell 中，如果 `npm.ps1` 被 ExecutionPolicy 阻止，请使用 `npm.cmd run build`。

## 更新日志

| 日期 | 变更 |
|------|------|
| 2026-05-22 | 将 Windows 默认启动策略切换为仅使用 WSL HUD；显式 native PowerShell HUD 参数会 fail fast 并提示暂未支持 |
| 2026-05-22 | 新增 Windows 启动模式解析实验、native 到 WSL 的醒目 fallback 提示，以及 Bash installer 的精确依赖安装指导 |
| 2026-05-21 | 完善 Windows 双入口：WSL 临时 wrapper、sudo/root provisioning、cmd shim、首次启动 session 目录处理与 runtime state 优先级 |
| 2026-04-09 | 新增快速安装/同步/升级/卸载命令 |
| 2026-04-09 | HUD 按 tmux pane 绑定会话；显示 reasoning effort |
| 2026-02-09 | 修复 resize 后主 pane 焦点漂移；优化鼠标滚动默认行为 |
| 2026-02-09 | 更新会话复用默认策略与滚动配置 |

## 许可证

MIT

## 致谢

灵感来源于 Jarrod Watts 的 [claude-hud](https://github.com/jarrodwatts/claude-hud)。为 [OpenAI Codex CLI](https://github.com/openai/codex) 构建。

## Windows WSL 默认入口说明（2026-05-22）

Windows 当前默认只使用 WSL HUD 启动路径：

- `codex`：默认 Windows 入口；直接启动 WSL HUD，WSL HUD 不可用时才降级为普通 Windows `codex` CLI。
- `codex --wsl ...`：显式使用 WSL HUD，并在转发给 Codex CLI 前移除 wrapper 参数。
- legacy native-mode 请求：native PowerShell HUD 暂未支持，会 fail fast 并提示使用 WSL HUD。
- `codex-hud-wsl`：显式 WSL 完整 HUD 模式（Ubuntu + Bash + tmux）。
- `cmd.exe`：安装后会获得托管 `.cmd` shim，实际调用同一套 PowerShell entrypoint，并使用 `ExecutionPolicy Bypass`。

PowerShell 安装方式：

```powershell
git clone https://github.com/CartmanFatass/codex-hud.git
cd codex-hud
.\bin\codex-hud-install.ps1
```

说明：`codex-hud-install.ps1` 会写入 PowerShell profile 管理块，生成 cmd shim，并提供以下命令映射：

- `codex`
- `codex-resume`
- `codex-hud-wsl`
- `codex-hud-sync`
- `codex-hud-upgrade`
- `codex-hud-uninstall`

安装脚本会在 Windows 上准备 Node.js 与 Codex CLI；Windows 默认 HUD 路径只使用 WSL，因此默认不再安装 native tmux。在 WSL 中会通过 root 或 passwordless `sudo` 准备 `tmux`、Node.js LTS、`npm` 和 `@openai/codex`。如果 WSL 权限不足，会 fail fast 并输出可在 WSL 内手动执行的命令。

Linux/macOS/Git Bash 的 `install.sh` 也会对缺失依赖 fail fast，并输出精确检查项与安装指导。关键检查包括 `command -v node`、`node --version`、`command -v npm`、`npm --version`、`command -v tmux` 与 `tmux -V`。
