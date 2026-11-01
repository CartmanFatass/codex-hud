# 通用 HUD 计划（2026-11-01）

> 2026-11-01：本文是调研底稿，计划部分已被 [universal-hud-concept.md](./universal-hud-concept.md)（v2）取代；评审见 [reviews/2026-11-01-astra-universal-hud-concept.md](./reviews/2026-11-01-astra-universal-hud-concept.md)。

目标：把 codex-hud 做成 Claude Code（cc）、pi、Codex 三个 harness 通用的 HUD。
HUD 随任一 harness 启动；本 harness 的原生子代理，和它外包给其他 harness 的
会话，都以同一棵"子代理树"显示，并标明 harness。

本文是准备与设计建议，不是实现记录。实现时按阶段更新本文的"执行记录"。

---

## 1. 现状盘点

### 1.1 codex-hud 现在的形态

- tmux 包裹 Codex；bar（1 行）与 panel（右侧列）二选一运行；只读 `$CODEX_HOME`。
- 数据链：`SessionFinder` → `RolloutParser` → `HudStatus` → `HudData`；
  `buildSubagentTree` 用 rollout 首行的 `parent_thread_id` /
  `source.subagent.thread_spawn` 建树。
- 已有的"雏形"可直接复用：子代理树与状态（`collectors/subagent-tree.ts`、
  `agent-stages.ts`）、每代理上下文/速率（`agent-context.ts`）、代理日志、
  时间线、Inspector、证据来源与诊断（`diagnostics/provenance.ts`）、
  Herdr 只读观察桥（`bin/codex-hud-herdr.mjs`）。
- 耦合点：类型（`RolloutState`、`HudData` 以 Codex 字段命名）、路径
  （`utils/codex-path.ts`、`logs_2.sqlite`、`config.toml`）、环境变量前缀
  `CODEX_HUD_*`、状态目录 `$CODEX_HOME/hud/`、`bin/codex-hud` 启动器。

### 1.2 三个 harness 在磁盘上留下什么

| | Codex 0.166 | Claude Code 2.1.305 | pi 1.4.0 |
|---|---|---|---|
| 会话文件 | `$CODEX_HOME/sessions/Y/M/D/rollout-*.jsonl` | `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` | `~/.pi/agent/sessions/<cwd-slug>/<ts>_<id>.jsonl`，或 `--session-dir` |
| 首行元数据 | `session_meta`：`id`、`cwd`、`model_provider`、`parent_thread_id`、`agent_path`、`agent_role`、`agent_nickname`、`source` | 每行都带 `sessionId`、`cwd`、`gitBranch`、`version`、`slug` | `type: session`：`id`、`cwd`、`version`；随后 `model_change`、`thinking_level_change` |
| 用量 | `event_msg.token_count`（含 `rate_limits`） | `assistant.message.usage`（input / output / cache） | `message.usage`（input / output / cacheRead / cacheWrite / **cost**）与 `usage` 记录 |
| 工具调用 | `response_item`（function_call / output） | `assistant` 的 `tool_use`，`user` 的 `tool_result`，`toolUseResult` | `message.role = assistant` 的 toolCall，`toolResult` |
| 原生子代理 | 独立 rollout，首行 `parent_thread_id`；0.162 起任务文本 Fernet 加密 | `<session>/subagents/agent-<id>.jsonl` + `agent-<id>.meta.json`（`agentType`、`description`、`toolUseId`、`spawnDepth`、`finished`）；记录带 `isSidechain`、`agentId` | pi-roles 只做单层 L1，无原生嵌套 |
| 实时注册表 | `logs_2.sqlite`（daemon 连接 → 线程） | `~/.claude/sessions/<pid>.json`：`pid`、`sessionId`、`cwd`、`status`、`name` | 无；靠进程 cmdline（`--session-dir`）与 cwd slug |
| 可挂的钩子 | `hooks.json`（herdr 只装了 SessionStart） | `settings.json` hooks：SessionStart、SubagentStart/Stop、Stop、Notification…；`statusLine`（stdin JSON） | 扩展 API（`~/.pi/agent/extensions/*.ts`，已有 `compact-footer`、`herdr-agent-state.ts`） |

### 1.3 跨 harness 调用现在怎么发生

- 全在 Herdr 里：`herdr tab create --label "implementer:<task>"` →
  `herdr pane run "$PANE" "codex …"`（Codex，走 zsh 函数 + herdr-context 包装）
  或 `herdr agent start <name> --kind pi --pane $PANE -- $(pi-role --args … --orchestrator $HERDR_PANE_ID)`（pi）。
- Herdr 为每个 pane 维护 agent 记录：`herdr agent list` 给出 `agent`（kind）、
  `agent_session.value`（cc 的 sessionId）、`agent_status`
  （working / idle / blocked / done）、`pane_id`、`tab_id`、`terminal_title`。
- 父子关系没有任何一处记录。能用的间接证据：
  1. 父会话 transcript 里的 Bash 工具调用（`herdr agent start <name>` /
     `herdr tab create --label …` 的命令原文）；
  2. pi 子进程 cmdline 里的 `--orchestrator <父 pane>`；
  3. Herdr tab 标签约定 `implementer:<task>` / `reviewer:<task>`；
  4. 编排者 skill 写的 brief / report 文件路径。

### 1.4 全局配置里要注意的

- Claude Code 的 `statusLine` 现在被 `claude-hud` 插件占用，并通过 `tee` 同时喂给
  `toktrack quota record-claude`。我们若提供 cc statusline 模式，要么替换它，
  要么保留 claude-hud、我们只做面板。
- `codex` 在 zsh 里是函数：`CODEX_HOME=~/.codex-account2` + `codex-with-herdr-context`。
  `bin/codex-hud` 用 `command -v codex` 解析，bash 里看不到这个函数，会启动
  默认 `~/.codex`。启动器要显式接受"harness 启动命令"而不是自己猜。
- Codex `[agents] max_depth = 2`、`max_concurrent_threads_per_session = 40`；
  跨 harness 嵌套没有上限，显示深度要封顶。
- cc 与 Codex 都装了 herdr 的 SessionStart 钩子（`herdr-agent-state.sh`），
  pi 装了 `herdr-agent-state.ts`；这是 Herdr 注册表的来源，HUD 不要重复实现。

---

## 2. 设计

### 2.1 原则（沿用 codex-hud）

1. 只读 harness 写到磁盘的东西，加上 Herdr 的只读 API；不往 harness 里注入
   任何改变其行为的东西。
2. 采集做 I/O，渲染纯函数；同一份数据、同一 `nowMs`、同一设置，画出同一帧。
3. 每个结论都带证据来源与强度（provenance），拿不准就显示"未知"而不是猜。
4. 模型功能默认关；凡发出去的文本都列在隐私表里。

### 2.2 分层

```
 harness 适配层            统一模型                视图
 ──────────────            ────────                ────
 harness/codex  (现有)  ─┐
 harness/claude (新)    ─┼─► SessionEvidence ─► AgentTree ─► bar / panel
 harness/pi     (新)    ─┘        ▲                 ▲
                                  │                 │
 link/  (新：跨 harness 父子证据)  ┘   host/ (tmux | herdr | cc-statusline | pi-footer)
```

**`HarnessAdapter`**（每个 harness 一份）：

| 方法 | 作用 |
|---|---|
| `id`, `glyph`, `home()` | `codex` / `claude` / `pi`，图标，数据根目录 |
| `bind(ctx)` | 由 pane pid / cwd / 启动时间 / Herdr 记录定位"这就是本会话"的文件；返回 `SessionRef` 与证据 |
| `read(ref, state)` | 增量读取（字节偏移、截断与 inode 变化重读、单飞队列），产出 `SessionEvidence` |
| `children(ref)` | 本 harness 的原生子代理 `SessionRef[]`（Codex：parent_thread_id；cc：subagents 目录；pi：空） |
| `status(ev)` | 把各自的证据映射为 `running / waiting-approval / idle / completed / failed / unknown` |

**`SessionEvidence`**（harness 无关）：会话元信息（harness、model、effort、cwd、
开始时间）、turns、打开/关闭的工具调用、用量与上下文占用（含可选 cost）、
最近公开消息（报告）、原生子代理列表。现有 `RolloutState` 的字段尽量映射进来，
Codex 独有的（rate_limits、goals、approvals）留在 `codex` 命名空间下。

**`AgentTree`**：现有 `SubagentTreeNode` 加两个字段：`harness` 与 `origin`
（`native` | `delegated`），`delegated` 节点再带 `host: {paneId, tabId, label}`
与 `link: {kind, strength, evidence}`。节点下可继续挂该 harness 自己的原生子代理
（一个 Codex 子会话的 spawn_agent 子线程出现在孙辈），用同一套适配器递归读。

### 2.3 跨 harness 链接（`link/`）

按强度分层，取最强的一条，Inspector 里显示全部证据：

| 强度 | 来源 | 实现 |
|---|---|---|
| 强 | 启动时环境标记 `HUD_PARENT=<harness>:<sessionId>:<paneId>` | pane pid → 进程树 → `/proc/<pid>/environ`。cc / pi 的进程就在 pane 里；Codex 的 TUI 客户端在 pane 里（rollout 由 daemon 写，但客户端进程有 env），再接现有 daemon 绑定 |
| 强 | 链接账本 `~/.hud/links/<parent>.jsonl` | 由编排者在启动子代理时写一行（委派 skill 加一条命令即可；也给 `hud link` 子命令） |
| 中 | 父 transcript 里的 Bash 命令 | 解析 `herdr agent start <name>` / `herdr tab create --label` / `herdr pane run … codex …` / `pi-role …`；用 `<name>` 与 pane id 对上 `herdr agent list` |
| 中 | pi 子进程 cmdline 的 `--orchestrator <pane>` | 父 pane → 父会话 |
| 弱 | Herdr tab 标签 `implementer:<task>` / `reviewer:<task>`、相近启动时间、同 cwd | 只作候选，不单独成链 |

子代理的状态优先用 Herdr 的 `agent_status`（它已经做了各 harness 的 TUI 检测），
再用子会话自己的 transcript 细化（当前工具、上下文 %、tok/s、cost、最新报告）。

Herdr 之外（纯 tmux）只剩环境标记、账本与 cmdline 三条路径，功能自动降级。

### 2.4 宿主（`host/`）

| 宿主 | bar | panel | 适用 |
|---|---|---|---|
| tmux（现有） | 独立 pane | 独立 pane | 三个 harness 都行；现有输入策略、前缀键、toggle 照用 |
| herdr | 无（或 cc statusline / pi footer） | `herdr pane split` 开出的 pane | 不再嵌套 tmux；点击"跳转"用 `herdr agent focus` |
| cc statusline | `hud statusline` 读 stdin JSON（`session_id`、`transcript_path`）+ 快照，输出一行 | 无 | 可与 toktrack 的 `tee` 共存；要替换 claude-hud 或与之并列 |
| pi footer 扩展 | 读快照文件画 footer | 无 | 参考 `compact-footer` |

第一阶段只做 tmux 宿主，把 host 接口抽出来；herdr 宿主第二阶段。

### 2.5 启动器

`hud <harness> [args…]`（`hud codex`、`hud claude`、`hud pi`）；保留 `codex-hud`
作为 `hud codex` 的别名。启动命令可用 `HUD_LAUNCH_CMD` 覆盖（解决 zsh 函数问题）。
tmux 会话前缀改为 `hud-<harness>-<hash>`；环境变量改为 `HUD_*`，`CODEX_HUD_*`
保留一个版本作为别名；状态目录 `$HUD_HOME`（默认 `~/.hud/`），
下面按 harness 分子目录；快照 JSON 加 `harness` 与 `tree[].harness` 字段。

### 2.6 视图改动

- Bar：新增模块"外包"，按 harness 计数，例如 `⧉ cc 2 · cx 1 · pi 1`，
  有子代理阻塞时进入 notice zone。
- Agents 列表：树行前加 harness 图标；`delegated` 节点显示 tab 标签与
  Herdr 状态；回车/点击 = `herdr agent focus`。
- 卡片：pi 节点多一行 cost；cc 节点显示 `agentType` 与 `description`；
  Codex 节点照旧。
- Inspector：链接证据一节（来源、强度、时间）。
- 词汇：L1 / subtask / review 照旧，新增 "delegated"（外包）；中文表同步。

### 2.7 隐私

子会话 transcript 现在会被读取并可能进入 brief。§5.4 表格要加：被链接的
cc / pi / Codex 子会话的公开消息（同样的字节上限）、Herdr 标签与状态。
`/proc/*/environ` 只取 `HUD_PARENT` 一个键。

---

## 3. 阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0 仓库准备 | 命名空间（`HUD_*`、`~/.hud`）、抽出 `HarnessAdapter` / `host` 接口，Codex 代码原样搬进 `harness/codex`；快照加 `harness` | 现有测试全绿，视觉基线不变 |
| 1 cc 适配器 | 绑定（sessions 注册表 + pid / Herdr）、transcript 增量读取、原生子代理（subagents + meta.toolUseId）、`hud claude` 启动 | bar + panel 在 tmux 里对 cc 可用；合成 fixture 的单测 |
| 2 pi 适配器 | 绑定、读取（message / usage / custom）、cost、`hud pi` | 同上 |
| 3 跨 harness 链接 | `link/` 四类证据、统一树、Herdr 状态、跳转 | 真实场景：cc 启 codex implementer + pi reviewer，树里三种 harness 都在 |
| 4 skill 对接 | herdr-delegate / herdr-delegate-codex 各加一行 `HUD_PARENT` 或 `hud link` | 强链接命中 |
| 5 宿主扩展 | cc statusline 模式、herdr 宿主、pi footer | 不开 tmux 也能看 bar |
| 6 收尾 | README / reference 改名，i18n，`SCAN_VERSION` 升级 | |

### 风险

- cc transcript 体积大、记录类型多（`api-request-blob`、`attachment` 等），
  必须沿用字节偏移增量与有界内存；只解析用得上的类型。
- Codex daemon 共享：不同 tab 的 Codex 共用 daemon，绑定仍按 pane 做（现有逻辑）。
- 没有 Herdr 时外包状态只能来自子会话文件，可能滞后。
- 链接误判：弱证据永远不单独成链；每条链接可在 Inspector 里看到依据。

---

## 4. 执行记录

- 2026-11-01：从 `~/codex/codex-hud` 克隆到 `~/projects/MyHUD`，分支 `universal-hud`，
  `npm install && npm run build` 通过。本文写成。
