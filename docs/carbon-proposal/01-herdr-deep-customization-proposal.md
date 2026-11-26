# Carbon Proposal：深度定制 `herdr-hud` 演进蓝图与可行性分析

> **定位**：架构演进与新能力提案（Carbon 视角） ｜ **涉及仓库**：`MyHUD`（TypeScript 控制面与渲染器）+ `<herdr-hud>`（Rust 终端合成器、PTY 宿主与 Socket 服务端） ｜ **前置基础**：已完成独立分支建立、自更新锁死、`direct-exec agent.start`、`launch_id` 与 `live-handoff` 身份保留（见 `<herdr-hud>/HUD-FORK.md`）

---

## 1. 核心判断与第一架构原则：薄腰合成器（Thin-Waist Compositor）

彻底自主维护 `<herdr-hud>` 意味着项目从**「寄居在外部终端分屏里的 TUI 插件」**升级为**「原生面向多智能体协同的终端合成器与 PTY 运行时（AI-Native Terminal Compositor & Runtime）」**。

但在把大量功能塞进 Rust 之前，可行性分析必须正视两个仓库在**部署与热更新物理特性上的根本不对称**：

| 维度 | `MyHUD`（TypeScript） | `<herdr-hud>`（Rust + Zig `libghostty-vt`） |
|---|---|---|
| **代码生效成本** | `npm run build` 后 MCP、Watcher、Panel 在数秒内自动原子热重载（`docs/ARCHITECTURE.md` §3, §6），不中断任何终端 | 编译需 Rust + Zig 工具链；替换 `~/.local/bin/herdr` 并执行 `herdr server live-handoff` 属于**仅限主会话、需 Owner 显式确认**的高权操作（`HUD-FORK.md`） |
| **进程父子关系** | 无状态或短周期可重建辅助进程 | 持有所有活跃会话的 PTY Master FD；Unix `live-handoff` 仅传递 FD，新 Server 不再是旧子进程的 POSIX 父进程（无法直接 `waitpid` 拿退出码） |
| **擅长职责** | 角色编排策略、账本/Ticket 解析、中英双语文案（`t()`）、主题对比度校验、Decision API 路由 | 帧合成（`ratatui`）、虚拟终端状态机（`ghostty-vt`）、PTY 字节流读写、键盘/鼠标原始输入分发、进程组信号与跨机 SSH 隧道 |

### 核心设计铁律：「机制下沉 Rust，策略留在 TS」

1. **`<herdr-hud>` 只提供稳定、无业务策略的原语（Mechanisms）**：例如「为指定 Pane 预留 1 行装饰槽并渲染传入的 ANSI/Span」、「隐藏/显形后台 Tab」、「全双工多路复用 Socket」、「空闲且输入框干净时安全注入文本」、「PTY 输出环形录制」。
2. **`MyHUD` 继续掌控所有快速迭代的业务语义（Policies & Presentation）**：`BarFacts` 字段拼装与宽度裁剪阶梯（`src/render/layout/bar-fields.ts`）、面板状态机、Job/QA 契约、多语言词表和模型决策全部留在 TS 层。
3. **收益**：`<herdr-hud>` 只需低频升级底层原语（每月/每里程碑一次 `live-handoff`），而日常 95% 的 UI 调整、字段增删和编排演进依然享受 `npm run build` 秒级无感生效。

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                         <herdr-hud> (Rust Server & UI)                  │
│  ┌──────────────────────┐  ┌─────────────────────┐  ┌────────────────┐  │
│  │ Compositor & Chrome  │  │ Workspace & PTY Pool│  │ Stream & Input │  │
│  │ - Per-Pane HUD Strip │  │ - Visible Tabs      │  │ - Input Fence  │  │
│  │ - Overlay HUD Drawer │  │ - Hidden Shadow Tabs│  │ - Auth OSC Tap │  │
│  │ - Top Action Banner  │  │ - pidfd Exit/Freeze │  │ - VT Recorder  │  │
│  │ - Mini-PiP Viewport  │  └──────────▲──────────┘  └───────▲────────┘  │
│  └──────────▲───────────┘             │                     │           │
└─────────────┼─────────────────────────┴─────────────────────┼───────────┘
              │         单一全双工多路复用 Unix Socket          │
              ▼                         ▼                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          MyHUD (TypeScript Brain)                       │
│  BarFacts / RenderMonitor / ThinJobs / Control / HUD MCP / Decision API │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 全景方案与可行性评估矩阵

评估口径说明：
- **可行性**：**极高**（现有数据结构已具备 80% 基础，改动局部且边界清晰）；**高**（路径明确，需少量协议与状态机扩展）；**中高**（技术完全可行，但存在明确的边界条件需专门护栏）；**中 / 探索**（跨模块或跨机器状态面较大，建议后置）。
- **规模估算**：S（<300 LOC）、M（300–800 LOC）、L（800–1,800 LOC）、XL（>1,800 LOC）。

| 编号 | 提案名称 | 核心收益 | 规模 (Rust / TS) | 可行性 | Handoff 兼容性 | 建议阶段 |
|---|---|---|---|---|---|---|
| **C-01** | **原生 Per-Pane HUD 装饰槽**（终结嵌套 tmux） | 砍掉 `codexH` 的嵌套 tmux，四端统一零侵入上下状态栏，支持无重启刷新 | M / S | **极高** | 完全兼容（触发标准 `SIGWINCH`） | Phase 1 |
| **C-02** | **原生停靠抽屉与画中画（Overlay Drawer & PiP）** | 消灭分屏面板的 `split_reply_lost` 与孤儿对账；开关 `/hud` 不挤压主终端列宽；支持小窗偷瞄后台 Worker | M / M | **高** | 抽屉可按需重建，无需跨 Handoff 保活 | Phase 2 |
| **C-03** | **跨客户端统一通知横幅与侧边栏语义徽章** | 无需 `claude-mod` 即可在任意 CLI 顶部快捷键秒回 Worker 提问；原生侧边栏直显 Context/Quota/Ticket | M / S | **高** | 纯展示态，重连即恢复 | Phase 2 |
| **C-04** | **Kitty Graphics 视觉内嵌预览** | Inspector 内直接查看浏览器 Worker 截图、前端 UI Diff 与平滑趋势图 | S / M | **中高** | 遵循宿主终端能力协商 | Phase 3 |
| **C-05** | **Shadow Tabs（可 0ms 显形接管的隐身终端）** | 兼具 Headless 的清爽与 Tab 的可接管性；并发 20 个 Worker 不撑爆标签栏，卡住时按 `g` 瞬间变身交互式 Tab | M / S | **极高** | **天然继承**现有 Tab Handoff 与持久化 | Phase 1 |
| **C-06** | **全双工多路复用 Socket RPC** | 单连接同时承载订阅推送与并发请求；彻底告别每查一次开一次连接或高频 `spawn('herdr')` | M / M | **高** | 保留旧单次连接模式向后兼容 | Phase 1 |
| **C-07** | **服务端 `pidfd` 进程监督与负载冻结（Freeze）** | 补齐 `live-handoff` 后子进程退出码空白；N 个 CLI Job 共用单监督流；高负载下支持 `SIGSTOP` 冻结低优批次 | M / M | **中高** | 依赖 Linux `pidfd` 跨父进程保真 | Phase 2 |
| **C-08** | **防误触通用 Event Wake（空闲安全唤醒器）** | 让 Codex / pi / agy / Claude 全部拥有免打补丁的主会话事件自动唤醒，且绝不误提交人类半截草稿 | M / S | **中高** | 内存态栅栏，重连后默认保守 | Phase 2 |
| **C-09** | **带令牌鉴权的 PTY 私有 OSC 信道与屏幕护栏** | 微秒级零文件轮询上报结构化进度；PTY 层精准拦截目录信任弹窗与解析限流重置时刻 | M / S | **中高** | 位于 Rust PTY 读取层，不改 Zig FFI | Phase 3 |
| **C-10** | **并行 Worktree 实时脏路径冲突雷达** | 在两个并行 Worker 同时修改同一文件时提前预警，而非等到 `hud_land` cherry-pick 撞车 | S / M | **高** | 无状态只读观测 | Phase 2 |
| **C-11** | **VT 环形行车记录仪（Flight Recorder）** | 为失败或异常 Job 保存最近数分钟终端真实画面录像，在 Inspector 内像拉进度条一样复盘 | M / M | **中高** | Handoff 时可切分新段，不阻塞主循环 | Phase 3 |
| **C-12** | **基于 `remote` 的跨机器分布式算力池** | 将重编译/重测试 Worker 透明派发至远端 SSH 机器上的 `<herdr-hud>`，本地统一面板管控 | L / XL | **中（远期）** | 需额外设计跨机产物/Git 束同步 | Phase 3+ |

---

## 3. 分赛道深度设计与可行性拆解

### 赛道 A：原生合成器与零分屏交互层（Compositor & Chrome）

#### C-01：原生 Per-Pane HUD 装饰槽（终结 `codexH` 嵌套 tmux）

- **现状痛点与代码证据**：
  - `bin/codex-hud` 为了给 Codex 提供 1 行底部 HUD，被迫在 Herdr Pane 内部再启动一层 `tmux` 会话，带来双层 PTY 转发、鼠标滚轮/划词复制割裂、`src/collectors/bridge-health.ts` 额外健康探针，且 `docs/ARCHITECTURE.md` §11 指出底栏更新代码后必须重启会话。
  - 反观 `<herdr-hud>/src/ui/panes.rs`：`apply_pane_chrome` 与 `terminal_inner_rect_for`（`:35-50`）已经在向子 PTY 暴露尺寸前扣除了边框和 1 列滚动条槽位（`pane_inner.width.saturating_sub(1)`），底层基础设施完全现成。
- **方案设计**：
  1. 在 `<herdr-hud>` 的 `PaneState` 上增加可选的 `chrome_bottom: Option<PaneChromeStrip>`（含预解析的 `ratatui::text::Line`、版本号、写入者租约 TTL）。
  2. 在 `panes.rs` 计算 `terminal_inner_rect` 时，若该 Pane 启用了底部装饰槽且高度 `>= 4`，将子 PTY 高度减 1（`pane_inner.height.saturating_sub(1)`），底行留给 `render_pane_chrome_strip` 直接绘制。
  3. 新增 Socket 方法 `pane.set_chrome { pane_id, position: "bottom" | "top", ansi_line, ttl_ms }`。`MyHUD` 的状态收集器直接复用现有 `renderBar` 算好精确列宽的单行字符串推送给 Herdr；若收集器退出或超时未续租，槽位自动收起或清空。
- **可行性分析（评级：极高）**：
  - **渲染锁安全**：`<herdr-hud>/src/ui/panes.rs:34` 明确要求核心锁内不能有重计算与分配。由 `MyHUD` 在外部算好 ANSI，Herdr 在 Socket 接收线程一次性解析为 `ratatui::text::Line` 存入 `PaneState`，绘制帧时仅做纯内存 Cell 拷贝，渲染耗时 `< 5µs`。
  - **动态尺寸同步**：`MyHUD` 根据 Herdr 推送的 `pane.resized` 事件拿到精确 `cols`，重新 `renderBar` 后推送，彻底满足 `docs/ARCHITECTURE.md` §8 的精确列宽不变量。
  - **演进路径**：不仅 `codexH` 可以直接退化为轻量 `direct-exec` 启动器（淘汰整个嵌套 tmux 链路），Claude Code、pi、Antigravity 也都可以可选切换为统一的 Herdr 原生底栏，消除各家客户端内置 statusline 的截断差异。

#### C-02：原生停靠抽屉与画中画（Overlay Drawer & Mini-PiP）

- **现状痛点与代码证据**：
  - `src/integrations/panel/README.md` 记录了当前侧边栏极高的工程复杂度：因为 `/hud` 必须调用 `herdr pane split` 切分真实布局树，不得不编写Slot哈希、预写意图恢复、`split_reply_lost` 孤儿不确定态防重入、1s/3s 归属轮询；同时每次打开面板都会把左侧主 CLI 挤压窄 40~50 列，导致代码 Diff 折行错乱。
  - 而在 `<herdr-hud>/src/ui.rs:101` 与 `src/popup_size.rs:50` 中，**已经实现了浮动 Popup Pane 机制**（`resolve_popup_geometry` + `resize_popup_pane`），支持在 `TabSurfaceView` 之上叠加独立的虚拟终端图层并拦截鼠标/键盘事件。
- **方案设计**：
  1. **停靠抽屉（HUD Drawer）**：扩展 `<herdr-hud>/src/popup_size.rs` 的几何锚点，新增 `RightDock { width: PopupSize }` 与 `BottomDock { height: PopupSize }`，并在 Workspace 级提供幂等原语 `hud.drawer_toggle { command_argv, width }`。Herdr 自身保证单实例幂等：已存在则切换显隐与焦点，不存在则直接以 `new_argv_command` 拉起 `bin/hud panel`，主 Pane 的 `cols` 全程保持不变（也可在设置中切换 `Overlay` 悬浮模式或 `Push` 推挤模式）。
  2. **只读画中画（Mini-PiP）**：无需新建任何进程或 PTY，直接在 `src/ui/tab_surface.rs` 末尾提供一个右上角/右下角 `36x10` 的只读视口挂件，直接投射指定后台 Worker `TerminalRuntime` 的最后 10 行屏幕快照，点击或按快捷键瞬间跳转到该 Worker。
- **可行性分析（评级：高）**：
  - **大幅削减复杂度**：由于抽屉槽位由 Herdr Server 内存单点仲裁，`MyHUD` 侧 `A3/A7` 中针对 `split_reply_lost` 和跨进程锁竞争的数百行防御代码可简化为一次幂等的 `hud.drawer_toggle` RPC。
  - **风险点与消解**：悬浮抽屉遮挡主终端右侧文字时，需支持「焦点回到主终端自动半收起/隐藏（Auto-dismiss on blur）」或一键切回停靠推挤（Docked Push）模式，兼顾窄屏笔记本与宽屏显示器。

#### C-03：跨客户端统一通知横幅与侧边栏语义融合

- **现状痛点与代码证据**：
  - `<herdr-hud>/src/ui/sidebar.rs:19-28` 的 `AgentPanelEntry` 已内置 `tokens: HashMap<String, String>` 与 `sidebar/tokens.rs` 模板引擎；`src/api/subscriptions.rs:72` 的 `PaneInfo` 也已有 `state_labels: HashMap<String, String>`。但目前 `MyHUD` 的丰富观测数据（角色名、Ticket 标题、Context 占比、待答问题 `[?q1]`）与 Herdr 原生侧边栏是割裂的。
- **方案设计**：
  1. `MyHUD` 将活跃主会话与关联 Worker 的核心标签通过 `pane.set_state_labels` 同步进 Herdr，让 Herdr 原生侧边栏和 Tab 标题直接渲染 `[imp · feat/04 · 62% · ?q1]`。
  2. 在主会话 Pane 顶部提供可选的 1~2 行 **Action Banner**（由 Herdr 绘制、不进 PTY）：当有 Worker 处于 `waiting_human` 提问或批次待确认时，直接展示问题摘要与 `[Alt+1..4 作答] [Alt+G 查看]`，用户按键由 `src/raw_input.rs` 拦截后回传给 `MyHUD` 走既有 `answerJobQuestion` 落盘（写入 `qa/qN.answer.md` 与 `panel-actions.jsonl`）。
- **可行性分析（评级：高）**：
  - 完全遵守 `docs/ARCHITECTURE.md` §6 的单一写入路径原则（所有回答依然经过 `answerJobQuestion` 的 `wx` 原子写入与日志留痕），只是把触发入口从「必须先打开面板切到 Inspector」提速到了「任意 CLI 内一键直达」。

#### C-04：基于 Kitty Graphics 的面板像素级视觉内嵌

- **代码证据**：`<herdr-hud>/src/kitty_graphics.rs`（1,019 行）与 `crates/ghostty-vt/src/pane_graphics_files.rs` 已实现完整的宿主单元格像素尺寸探测（`HostCellSize`）与 PNG 图像转发协议。
- **方案设计**：当浏览器角色（如 `jev-flow`）或前端测试任务在报告目录产出本地图片产物时，若 Herdr 报告当前客户端连接具备 `kitty_graphics: true` 能力，Inspector 页可在文本下方直接内嵌渲染缩略图；否则回退为现有的纯文本路径链接。
- **可行性分析（评级：中高）**：
  - **主要约束**：Linux 原生 Ghostty / Kitty / WezTerm 支持极佳，但 WSL 下若宿主为 Windows Terminal（非 WezTerm/Ghostty Windows 端），Kitty 图形协议支持不完整。因此必须严格依赖 Herdr 现有的宿主终端能力探测开关做优雅降级，并确保快照单测（`npm test`）固定关闭图形输出以保持字符网格纯洁性。

---

### 赛道 B：全双工 IPC、隐身终端与 PTY 监督下沉（Runtime & Shadow PTYs）

#### C-05：Shadow Tabs —— 可 0ms「显形」接管的隐身虚拟终端（最高性价比特性）

- **现状痛点与代码证据**：
  - 目前角色位置（Worker Places）必须在 **Headless 模式**（无 Tab、输出写 `stdout.jsonl`、要求 CLI 支持流式无头参数、遇到异常卡死无法人工敲键盘救火）与 **Herdr Tab 模式**（每派一个单就在顶栏多一个 Tab，并发十几个 Sonic/Imp 时标签栏严重拥挤）之间二选一。
  - 查看 `<herdr-hud>/src/workspace/tab.rs:53-68` 与 `src/ui.rs:110-131` 可以发现：Herdr 已经在后台为所有非激活 Tab 维护着完整的 `TerminalRuntime`（含 PTY Master 与 `libghostty-vt` 屏幕缓冲区），并通过 `resize_background_tab_panes` 保持固定几何尺寸！
- **方案设计**：
  1. **关键数据结构技巧**：**不要**在 `Workspace` 之外另建孤立的后台 Pane 池，而是直接在 `src/workspace/tab.rs` 的 `Tab` 结构体上新增 `pub hidden: bool`（或 `visibility: TabVisibility::{Normal, Shadow}`），并在 `agent.start` / `tab.create` 参数中支持 `hidden: true`。
  2. **UI 行为**：`hidden == true` 的 Tab 不出现在常规 Tab 栏列表中，也不参与 `next_tab` / `prev_tab` 快捷键轮转；Tab 栏右侧仅汇总显示一枚紧凑胶囊（例如 `⚙ 5 shadow`）。其底层虚拟终端按预设标准尺寸（如 `120x36`）正常运行。
  3. **一键显形与收纳（Materialize / Dematerialize）**：提供 `tab.set_hidden { tab_id, hidden: false, focus: true }`。当用户在 `MyHUD` Inspector 中按 `g`（`focus-job-tab`）或 Worker 触发异常需要人工查看时，Herdr 只需翻转 `hidden = false` 并切过去——**耗时 0ms，完整的彩色 TUI 界面、历史滚屏和实时交互光标原封不动呈现在眼前**；处理完毕后可随时再次收纳回 `Shadow` 状态。
- **可行性分析（评级：极高）**：
  - **为什么放在 `Workspace.tabs` 内是神来之笔**：`<herdr-hud>` 现有的 `persist/` 会话快照、`handoff_runtime.rs` 的热移交、`launch_id` 分配、`close_on_zero` 退出策略、以及 `pane.exited` / `tab.closed` 事件广播全部是遍历 `workspace.tabs` 工作的。用 `Tab.hidden` 实现意味着**几乎零成本自动继承全部生命周期与容灾保障**，连不支持 `--output-format stream-json` 的纯交互式 TUI 工具（如 Codex TUI、Grok）也能享受「静默后台运行 + 随时人工接管」的双重优势！

#### C-06：全双工多路复用 Socket RPC（Multiplexed Duplex IPC）

- **现状痛点与代码证据**：
  - `<herdr-hud>/src/api/server.rs:124-150` 当前采用每连接一线程模型，且连接一旦进入 `events.subscribe` 就变成单向推送流，导致 `MyHUD`（`src/runtime/herdr-socket.ts:92`）不得不每次查询新建 Socket 连接，甚至在大量路径上通过 `runHerdr`（`src/roles/herdr-run.ts`）反复 `spawn('herdr', ...)` 子进程。
- **方案设计**：
  1. 保留现有单次请求/响应与单向订阅协议不变（保证命令行 `herdr ...` 100% 兼容）。
  2. 新增 `session.duplex` 握手方法：连接升级后，客户端可在同一条 Unix Socket 上并发发送带唯一 `req_id` 的请求帧（如 `pane.get`、`agent.start`、`pane.set_chrome`），服务端交错写回带对应 `req_id` 的响应帧与带 `sub_id` 的事件推送帧。
  3. 支持批量组合请求 `batch.call`（一次系统调用原子读取多个 Pane 状态或批量更新装饰槽）。
- **可行性分析（评级：高）**：
  - Unix Domain Stream Socket 天然全双工：服务端只需将连接拆为 Reader 线程/异步任务（解析请求送入 `api_tx`）与 Writer 通道（统一序列化响应帧与 `EventHub` 唤醒帧，带有界队列防慢消费者阻塞）。改造范围收敛在 `src/api/server.rs` 与 `MyHUD` 的 `src/runtime/herdr-socket.ts`，可彻底消灭高频短连接与 CLI 子进程开销。

#### C-07：服务端 `pidfd` 进程组监督与系统负载冻结（Freeze / Resume）

- **现状痛点与代码证据**：
  - 目前每启动一个 CLI Worker 就要常驻一个独立的 Node 监督进程 `hud-cli.mjs`（`src/runtime/cli-supervisor.ts`），各自建连、监听目录、跑定时器；且 `<herdr-hud>/HUD-FORK.md:34` 揭示了一个底层硬伤：执行过 `herdr server live-handoff` 后，新 Server 不是旧子进程的父进程，丢失了 `exit_code` 和 `signal`（降级为 `ChildExitReason::Handoff`）。
- **方案设计**：
  1. **用 Linux `pidfd` 彻底攻克 Handoff 退出感知**：本项目的目标平台明确限定为 Linux 与 WSL2（内核均 ≥ 5.15，远高于 `pidfd_open` 所需的 Linux 5.3）。在 `<herdr-hud>` 中：
     - 正常启动时在 `SCM_RIGHTS` 热移交清单中同步传递子进程的 `pidfd`（或移交后用 `pidfd_open(child_pid, 0)` 配合 `/proc/<pid>/stat` 的 `child_start_time` 校验打开）。
     - 通过 `epoll`/`tokio` 监听 `pidfd` 可读事件，即使跨越多轮 `live-handoff` 也能精确感知进程退出瞬间，并通过 `pidfd_send_signal` 实现零 PID 复用竞态的安全信号投递！
  2. **原生静默计时与进程组冻结**：Herdr 原生支持订阅 `pane.quiet_exceeded { pane_id, quiet_ms }`，并提供 `pane.freeze { pane_id, frozen: boolean }`（对受控进程组发送 `SIGSTOP` / `SIGCONT`）。
  3. **监督器合一**：`MyHUD` 不再为每个任务孵化独立的 `hud-cli.mjs`，而是由单一常驻按需进程 `hud-watch` 通过一条全双工 Socket 统一托管所有活跃 CLI 任务的纯函数裁判（`judge()` in `src/mcp/cli-judge.ts`）。
- **可行性分析（评级：中高）**：
  - **技术细节考量**：非父进程对 `pidfd` 调用 `waitid(P_PIDFD)` 在标准内核无 `CAP_SYS_PTRACE` 时仍拿不到数字 `exit_code`（除非直接通过 Unix `SCM_RIGHTS` 在旧 Server 退出前保持或由轻量 shim 汇报），但 `direct-exec` 可以在 Herdr 内部使用 50 行极薄的 Rust `exec-shim`（子进程先写 4 字节退出码到私有匿名管道再退出，该管道 FD 随 `live-handoff` 的 `SCM_RIGHTS` 一并移交新 Server！）。**用匿名状态管道 + `SCM_RIGHTS` 移交即可 100% 拿到跨 Handoff 的真实 `exit_code` 与 `signal`**，彻底填平 `HUD-FORK.md:34` 的唯一遗憾！

---

### 赛道 C：VT 字节流与输入流控制（Stream Tap, Safe Wake & Guardrails）

#### C-08：防误触通用 Event Wake（空闲安全唤醒器 —— 免魔改替代 `claude-mod`）

- **现状痛点与代码证据**：
  - 目前仅 `claude-mod` 支持将 `hud watch` 的可行动通知自动唤醒主会话（`docs/ARCHITECTURE.md` §5）；Codex、pi、Antigravity 主会话无法原生享受同等体验。但如果粗暴调用 `herdr agent prompt` 往主会话 PTY 塞文本，一旦用户正敲了一半问题在思考，注入的回车会直接把用户的半截草稿一起发出去！
- **方案设计**：
  1. 在 `<herdr-hud>/src/raw_input.rs` 与 `src/terminal/state.rs` 中为每个 Pane 维护 **输入安全栅栏（Input Safety Fence）**：
     - `last_human_input_at: Instant`（任何键盘/粘贴/鼠标点击都刷新）；
     - `dirty_idle_buffer: bool`：当 `AgentState == Idle` 时若收到人类可打印字符或粘贴则置 `true`；仅在状态重新经历 `Working -> Idle` 完整回合，或 `detect/manifests` 确认当前提示符行完全为空白初始态时才清零；
     - `scrolled_back: bool`（复用 `panes.rs:19` `pane_is_scrolled_back`）。
  2. 新增原子 API `agent.wake_if_clean { target, payload, min_human_quiet_ms: 5000 }`：
     - 若满足 `AgentState == Idle && interactive_ready && !dirty_idle_buffer && !scrolled_back && human_quiet >= 5s`，原子写入唤醒文本并提交；
     - 只要任一条件不满足，**立即拒绝写入并返回 `{ delivered: false, reason: "human_active" | "dirty_draft" | "agent_busy" }`**，由 `MyHUD` 自动降级挂到 C-03 的顶部横幅（队列攒批，等主会话干净或用户按一键放行时再投递）。
- **可行性分析（评级：中高）**：
  - **边界风险与防护**：用户在输入框敲了字又全部按 Backspace 删光时，单靠按键计数会误判为 `dirty_idle_buffer = true`（属于**安全假阳性**——最多降级为顶部横幅提示按快捷键投递，绝不会造成误发草稿的恶性事故）。若再结合 `ghostty-vt` 读取当前光标所在提示符行的纯文本比对空提示符模板，准确率可进一步提升至 99% 以上。这意味着**无需逆向魔改任何第三方 CLI 二进制，四大客户端全部获得安全的事件驱动唤醒能力**。

#### C-09：带令牌鉴权的 PTY 私有 OSC 信道与屏幕护栏

- **方案设计**：
  1. **不碰 Zig FFI 的私有 OSC 解析器**：在 `<herdr-hud>` 的 Rust PTY 读取循环中（喂给 `crates/ghostty-vt` 之前），串联一个零拷贝流式状态机，识别 `\x1b]7777;hud;<token>;<json>\x07`（及 `\x1b\\` ST 结尾），匹配后从字节流中剥离（终端屏幕完全不可见）并向订阅者发出 `pane.hud_osc` 事件。
  2. **安全关键设计 —— 防不可信文本注入（Capability Token）**：如果 Worker 在终端里执行 `cat untrusted_repo_file.txt`，恶意文件若包含伪造的 `\x1b]7777;hud;...` 转义序列，无鉴权的解析器就会被欺骗！因此，`direct-exec` 启动 Pane 时由 Herdr 生成随机 128-bit `HUD_OSC_TOKEN` 通过私有环境变量注入受控工具链；**只有携带正确 Token 的 OSC 帧才会被采信，Token 不匹配的序列一律丢弃或原样放行按普通未知 OSC 忽略**。
  3. **屏幕弹窗与限流解析扩展**：扩展 `<herdr-hud>/src/detect/manifests/*.toml`，支持声明式匹配目录信任弹窗与配额耗尽提示文案，通过结构化事件上报给 `MyHUD`，替代外部轮询抓屏。
- **可行性分析（评级：中高）**：
  - 避开修改 `vendor/libghostty-vt` 的 Zig 源码是保持长期可维护性的关键决策：纯 Rust 流式扫描器仅需 ~120 行代码（需妥善处理跨 `read()` 缓冲块的边界半截序列，设 4 KiB 长度上限超时刷出即可），既安全又极易编写模糊测试（Property/Fuzz Tests）。

---

### 赛道 D：冲突雷达、时光机回放与跨机算力（Workspace, Replay & Remote）

#### C-10：并行 Worktree 实时脏路径冲突雷达（Live Overlap Radar）

- **现状与设计**：多个并行 Job 在各自 Worktree 施工时，若同时触碰同一核心文件（如 `src/settings.ts`），目前要等到 `hud_land` 阶段才会触发冲突与返工（Land Repair）。利用 `MyHUD` 已知的活跃 Job Worktree 列表（或 `<herdr-hud>/src/worktree.rs`），每 10~15 秒对活跃施工中的 Worktree 执行受限、无副作用的 `git --no-optional-locks status --porcelain=v1 -z`（严格遵守 `docs/ARCHITECTURE.md` §8：绝不触发仓库自定义 Git filter/hook 或 fetch），计算修改文件集合交集，一旦重叠立即在底栏 Notices 区和面板 Jobs 页亮起冲突预警。
- **可行性分析（评级：高）**：甚至无需等待深改 Herdr，纯 TS 层配合全双工通知即可先行落地，开销极低（活跃并发通常 ≤ 16 个 Worktree）。

#### C-11：VT 环形行车记录仪（VT Flight Recorder）

- **现状与代码证据**：`<herdr-hud>/crates/ghostty-vt/src/lib.rs:43` 已经封装了 `FormatterFormat::Vt`（导出可重建当前终端完整样式与屏幕状态的 VT 序列）！
- **方案设计**：为受管 Worker Pane 在内存中开启一个有界环形缓冲区（例如上限 1 MiB 压缩块：每 30 秒拍一张 `FormatterFormat::Vt` 关键帧 + 期间带毫秒偏移的原始输出增量）。若 Job 正常成功结算且关闭，内存随 Pane 直接释放（零磁盘写入）；若 Job 失败、超时或被标记异常，在销毁前原子导出为 `$HUD_HOME/jobs/<job>/replay.cast`（权限 `0600`），供 Inspector 内嵌回放。
- **可行性分析（评级：中高）**：
  - 内存上限可控（20 个并发 Worker 封顶 ≤ 20 MiB 内存），成功路径零磁盘 I/O 损耗；需要遵守隐私规则（随 Job 目录 24 小时过期自动清理，不进长期归档 `archive/YYYY-MM.jsonl`）。

#### C-12：基于 `src/remote` 的跨机器分布式算力池（Remote Swarm Places）

- **现状与代码证据**：`<herdr-hud>/src/remote.rs` 已经具备完整的 SSH 远端 Server 托管、断线重连与多机统一视图能力。
- **方案设计**：将 `places` 语法从本地 `codex` / `claude` 扩展为支持 `<machine>:codex`。派单时通过 Herdr 远端通道在目标机器的镜像仓库上检出对应基础 Commit 的临时 Worktree、投递装配好的 Brief；运行期间状态与 QA 经 SSH 隧道实时回传本地面板；结算时拉回报告与 Git Patch 交由本地 `hud_land` 统一跑门禁合入。
- **可行性分析（评级：中 / 远期探索）**：
  - **主要难点不在 Herdr 而在文件系统假设**：当前 `MyHUD` 的 `readThinJobs`、`qa/` 原子应答和 `context_files` 校验均建立在本地共享 `$HUD_HOME` POSIX 文件系统之上。若跨机器执行，必须引入一层显式的「远端 Job 代理适配器（Remote Job Proxy）」，负责把远端 Socket 事件映射到本地影子 `$HUD_HOME/jobs/<job>/` 目录，并在派单/结算两端同步 Git Commit 与文件补丁。建议在本地合成器与运行时彻底成熟后作为里程碑级大特性推进。

---

## 4. 关键工程风险与守护清单

在推进上述二次开发时，需将以下五条红线写入 `<herdr-hud>` 与 `MyHUD` 的联合验收标准：

1. **核心渲染锁零阻塞（Zero-I/O Paint）**：`<herdr-hud>` 的 `ratatui` 帧构建与 `MyHUD` 的 `renderMonitor` 一样，严禁在绘制路径上读取磁盘、调用子进程或等待锁；一切跨进程状态通过异步消息更新内存快照。
2. **协议能力位渐进协商（Capability Gating）**：所有新增特性必须在 `<herdr-hud>/src/api/server.rs` 的 `ServerCapabilities`（`:72`）中暴露明确布尔位（如 `duplex_rpc`、`pane_chrome`、`shadow_tabs`、`hud_drawer`、`safe_wake`）。`MyHUD` 根据握手返回的能力位按特性开启，确保旧二进制或回滚期间优雅降级，绝不硬崩。
3. **`live-handoff` 双向向前兼容**：所有写入 `HandoffRuntimeState`（`src/handoff_runtime.rs`）的新字段（如 `hidden`、匿名退出码管道句柄、`chrome` 快照）必须标注 `#[serde(default)]`，保证从当前 `0.9.5-hud` 平滑热移交至新版本且支持随时无损回滚。
4. **防转义序列投毒与私密权限**：任何终端内带外信道（如 C-09 的 `OSC 7777`）必须校验随机每会话 Capability Token；任何新增落盘文件（如 C-11 的录像）必须使用 `0600` 原子写入并纳入 24 小时清理周期；文档、快照与测试严禁出现真实个人路径或真实账号数据。
5. **保持上游高价值修复的可摘取性（Cherry-pick Hygiene）**：尽量将 HUD 专属扩展收敛在独立模块（如 `src/hud/`、`src/ui/hud_chrome.rs`、`src/api/duplex.rs`），在 `panes.rs`、`tab.rs`、`server.rs` 等上游热点文件中只留薄钩子（10~30 行调用点），降低未来从上游选择性 `git cherry-pick` 终端渲染或平台修复时的冲突成本。

---

## 5. 推荐落地路线图（Phased Roadmap）

### Phase 1：运行时与显示基座重构（最高 ROI 切入点）
- **目标**：彻底清偿历史外挂包袱，建立高速通信与隐身终端原语。
- **交付项**：
  1. **C-06** 全双工多路复用 Socket RPC + `ServerCapabilities` 能力集扩展。
  2. **C-05** `Tab.hidden` 隐身虚拟终端（Shadow Tabs）+ Inspector `g` 键 0ms 显形/收纳。
  3. **C-01** 原生 Per-Pane HUD Chrome 底栏槽位，让 `codexH` 卸掉嵌套 `tmux`。
  4. **C-07（上半场）** 匿名退出管道 + `pidfd` 跨 `live-handoff` 真实退出码保真。

### Phase 2：合成器交互跃迁与零侵入协同
- **目标**：打通跨四大客户端的一致操控感，收敛多进程监督。
- **交付项**：
  1. **C-02** 原生停靠/悬浮 HUD Drawer（大幅简化 `A3/A7` 分屏对账）+ 右下角只读 Mini-PiP。
  2. **C-08 + C-03** 带输入草稿栅栏的通用 Event Wake + 主窗口顶部快捷键 QA 横幅 + 原生侧边栏 Token 融合（让所有客户端免打补丁获得超越 `claude-mod` 的体验）。
  3. **C-07（下半场）** 单连接集中式 CLI 监督（退役每任务一个 `hud-cli.mjs` 进程）+ 批次 `SIGSTOP` 冻结。
  4. **C-10** 并行 Worktree 实时脏路径冲突雷达。

### Phase 3：深水区黑科技与分布式扩展
- **目标**：构建市面上独一无二的多智能体可观测性与多机扩展能力。
- **交付项**：
  1. **C-09** 带 Token 鉴权的 PTY 旁路 `OSC 7777` 微秒级内联信道 + 声明式屏幕弹窗护栏。
  2. **C-11** 基于 `ghostty-vt` `FormatterFormat::Vt` 的失败任务环形行车记录仪与回放器。
  3. **C-04** Kitty Graphics 终端内视觉预览（按宿主终端能力自动启停）。
  4. **C-12** 打通 `<herdr-hud>/src/remote` 的跨 SSH 机器分布式 Worker Places。
