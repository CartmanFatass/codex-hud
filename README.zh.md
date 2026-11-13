<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh.md">中文</a> ·
  <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a>
</p>

# HUD

在 Linux/WSL、herdr 内，为 **Claude Code、Codex 与 pi** 提供同一套底部状态行、
按需打开的首页／项目面板，以及六个本地角色委派 MCP 工具。
轻量观测与薄执行适配，不是工作流引擎；主会话决定所有下一步。

灵感来自 [claude-hud](https://github.com/jarrodwatts/claude-hud)。

## 快速开始

需要 **Node ≥24.0.0**（Node 24 为经过测试的支持版本线）、npm 及所选客户端。
Codex 状态行还需 tmux。任务另需 PATH 中的 herdr、pi 与单独安装的 **pi-roles**；
浏览器角色需已配置的外部 **jev-*** CLI。安装器不安装这些工具、不代为鉴权。
见 [Node 下限依据](./docs/ARCHITECTURE.md#3-launch-and-installation)。

从项目的[发布页](https://github.com/CartmanFatass/codex-hud/releases)下载
`hud-<version>.tar.gz`，然后解压（以下以 0.1.0 为例）：

```sh
tar -xzf hud-0.1.0.tar.gz
cd hud-0.1.0
./install                         # 只安装核心
./install --with claude,pi,codex   # 核心及所选扩展

# 将打印的 Codex 函数加入 shell，再启动：
codexH() { hud codex "$@"; }
codexH
```

可任选 `claude,pi,codex,browser,herdr`，核心始终安装。browser/herdr 只检查外部工具，不安装。
默认构建 HUD 和 MCP；源码包包含 TypeScript 等构建依赖，可离线安装。
只有缺少依赖的检出才运行 `npm ci`；`--skip-build` 使用已有输出。
`~/.local/bin` 中的命令和客户端绑定指向检出／解压目录，**请在安装位置保留该目录**。不修改 shell rc。

从检出安装迁移时，先在旧检出中运行 `./install --uninstall`（额外的 `CODEX_HOME`
见扩展说明），`$HUD_HOME` 数据保留；再在解压目录中运行上述安装命令。不要删除无关的冲突命令。

直接启动 `claude` 用 HUD 状态行，已有非 HUD 自定义状态行保留；直接启动 `pi` 加载 HUD 页脚。
`codexH` 启动带 tmux 状态行的 Codex。只有侧面板按需打开：Claude/pi 用 `/hud`，Codex 用 F12，启动时不打开。
注册改变后重启客户端。

```sh
hud uninstall
# 或在保留的检出目录中：
./install --uninstall
```

卸载只移除自有命令／注册，不删除 HUD 数据或无关设置。
备份、可选检查及多个 Codex home 见[安装器扩展](./install.d/README.md)。

### 字体

[MesloLGS NF](https://github.com/romkatv/powerlevel10k-media) 使可选 powerline 字形列宽一致，
没有也可运行。不会隐式安装：

```sh
bin/codex-hud-fonts --check
bin/codex-hud-fonts
```

Linux 上脚本安装用户字体；WSL 只报告 Windows 字体状态与操作说明，不写文件。
在实际绘制 WSL 的终端选择 MesloLGS NF。下载使用固定哈希。

## HUD 显示什么？

三个客户端共用一组字段，只显示已有事实：

```text
model effort │ context %/window │ repo branch(dirty) │ quota │ notices ··· MCP n  skills n
```

上下文有数据时对齐客户端压缩窗口；额度只属于当前客户端，pi 使用编辑器顶条中的会话费用。
代理／任务开始、完成、失败和 Claude 技能加载事件显示三分钟，待答问题／审批固定显示。
变窄会缩短或丢弃可选字段，缺数据不填零。不再显示轮次时钟、输出速率、任务数或正在执行的工具。

设置可选 line、p10k、Gauge Plates、Tide、Micro Glyphs、Stacked、Headline、Triptych。
Stacked 在 Claude/pi 为两行，Codex 一行窗格回退 line。pi 右上条带跟随样式，并保留其它扩展状态。

## 开发面板

面板有**首页**与**项目**两个标签：

- **首页：** 需要你回答的问题、包泳道中的紧凑任务卡片、Claude/Codex 原生子代理泳道和决定。
  Enter 原地展开，`o` 打开文件，`v` 查看详情，`a` 显示较早项目。
  已结束卡片默认五分钟折叠、十五分钟隐藏；新开面板排除已结束的 HUD 任务。模型文字可选、仅用于显示。
- **项目：** STATE/spec 进度、本地 to-tickets 工单、工作树、文档、生效角色／约定／密钥可用性。
  读项目文件，不调用项目管理服务，不改变其状态。
- **设置、帮助、详情、改动：** 设置修改草稿，详情打开工作流文件／转写，改动仅 Git／工作树摘要。
  没有时间线、代理日志页、布局选项、背景图或底部状态卡。

Codex 用 F12 切换面板，Shift-F12 聚焦，前缀 `Ctrl+\` 后接命令键：
`1` 首页、`2` 项目、`3` 改动、`,` 设置、`?` 帮助。非模态页普通输入交给 Codex。
Claude/pi 用 `/hud`，`hud panel --here` 在当前终端显示。有效新构建后面板保留位置自动重载，等待未保存设置处理。

## 委派

MCP 提供 **hud_roster**、**hud_create**、**hud_read**、**hud_send**、**hud_respond**、**hud_close**。
先看 roster，取得角色、模型、可用启动选项和约定。pi 角色使用外部 pi-roles 与 herdr；
浏览器任务使用 `jev-ask`、`jev-aistudio` 或 `jev-flow`，没有自动串联角色。
见 [hud-mcp](./packages/hud-mcp/README.md)。

任务／报告在 `$HUD_HOME/jobs`。按需 watcher 回收结束任务，在关闭一天后的后续扫描清理已结算目录。
pi 会话历史留在 pi 自身存储，任务目录仅有链接；删除前先保存旧任务中的真实会话。

## 使用方法

```sh
codexH                       # 带 HUD tmux 状态行的 Codex
codexH --model gpt-5          # 传递 Codex 参数
codexH resume                # Codex 恢复选择器
hud panel --help
hud statusline --help
```

检出目录中的 `bin/codex-hud --list`、`--attach`、`--kill`、`--self-check`、`--json` 可用。
`--kill` 关闭当前目录的 HUD 会话，`--json` 打印活跃 Codex 快照。

## 配置

设置存到 `$HUD_HOME/hud-settings.json`，HUD_HOME 默认 `~/.hud`，可用 `HUD_SETTINGS_PATH` 覆盖。
当前可调主题、状态行样式、语言、宽度、卡片时限、模型总开关、模型／调用上限及决策 API。
保存的显示设置优先于环境，`NO_COLOR` 始终优先。`s` 保存，离开脏草稿询问保存／放弃／继续。
`r` 只重置当前组，没有全部重置。

可选模型文字只读公开任务／原生材料，写显示覆盖，不给工作者指令。密钥来自环境或私有
`$HUD_HOME/credentials.env`；聊天端点只收到对应提供方密钥。独立决策 API 默认 OpenAI。
关闭模型不发请求。

当前按键、输入范围、设置、状态行样式、快照和环境变量见**[参考文档](./docs/reference.zh.md)**；
采集、渲染及修改规则见**[架构](./docs/ARCHITECTURE.md)**。

## 系统支持

当前产品面向 herdr 内的 Linux 和 Windows WSL。不支持原生 Windows；macOS 未列为已验证的当前产品配置。

## 开发

开发命令需要 git 仓库；发布包不含测试。

```sh
npm ci
npm run build
npm run build:hud-mcp
npm run dev
npm test
npm run check:fixtures
# 只在有意更新终端帧时运行，并检查差异：
npm run snapshots:update
```

测试使用合成数据和临时 home，帧测试比较终端单元格而非字体像素。
常规测试只校验，不改快照。`CODEX_HUD_PROFILE=1` 将阶段计时写到 `$HUD_HOME/display/profile.log`。

维护者在干净且已提交的工作树运行 `npm run release` 生成 `hud-<version>.tar.gz`；
`npm run test:release` 排练离线构建、隔离注册、MCP 和卸载。测试和历史文档不随包发布。
早期设计与截图保存在 git 历史和[历次评审](https://github.com/CartmanFatass/codex-hud/tree/universal-hud/docs/reviews)。

## 许可证与致谢

MIT。灵感来自 Jarrod Watts 的 [claude-hud](https://github.com/jarrodwatts/claude-hud)。
移植部分在此维护，见[第三方声明](./THIRD_PARTY_NOTICES.md)。
