# 25. Antigravity（agy）全面适配：orchestrator、worker、statusline 与 Claude/Codex/pi 对齐

> **优先级**：P1（owner 2026-11-22 开始深度使用 agy） ｜ **类别**：安装 / MCP / 投递 / statusline ｜ **预估规模**：M（4 个垂直切片） ｜ **前置依赖**：无硬前置；02、03 改 `src/mcp/thin-main.ts` 与 `packages/hud-mcp/bin/hud-notify.mjs`，排在 TEST-SPLIT-04 之后，先于 WORKTREE-OVERLAP-01 与 MCP-SPLIT ｜ **`docs/spec.md` 边界影响**：扩展边界，owner 2026-11-22 已同意方向（"可以改 A+B"）：§1 加 Antigravity；§2.1.3 agy worker 挂 worker MCP；§2.1.6 agy 的事件投递；§2.2.1 agy statusline；§2.4 安装组件 `agy`。由切片 01 落地 spec 句子。

---

## 1. 背景与实测证据（agy 1.5.14，2026-11-22，临时工作区 + `--settings` 会话设置，未改全局配置）

| 能力 | 实测结果 |
|---|---|
| MCP 注册 | 全局 `~/.gemini/config/mcp_config.json`（官方命令 `agy mcp add [--env K=V] <name> <cmd> [args]`），或插件内 `mcp_config.json` |
| MCP 进程 | 每个 agy 会话各起一个 stdio 子进程（父进程就是该 agy），**继承会话环境**：`HUD_JOB_DIR`、`HERDR_*` 都在 |
| 握手 | 先发 `server/discover`（协议 2026-07-28），再 `initialize`（2025-11-25）；客户端能力 `elicitation`、`roots`，**无 MCP tasks** |
| tools/call `_meta` | `antigravity.google/conversation_id`、`antigravity.google/root_conversation_id`、`antigravity.google/artifacts_dir`、`progressToken` |
| 工具命名与权限 | 插件 server 名为 `<plugin>_<server>`；首次调用弹权限确认，规则格式 `mcp(server/tool)`，可通配 `mcp(hud/*)` |
| 懒启动 | 插件 MCP 在第一轮才连上，**第一轮模型看不到工具**，第二轮正常；`mcp_config.json` 有 `eager` 标记（changelog 提及），是否解决待验证 |
| Hooks | `SessionStart`、`PreInvocation`、`PreToolUse`、`PostToolUse`、`PostInvocation`、`Stop`；输入含 `conversationId`、`transcriptPath`、`cwd`、`modelName`、`hookEventName`、`invocationNum`；`SessionStart`/`PreInvocation` 可 `injectSteps`；`Stop` 可 `decision: "continue"` |
| Statusline | `settings.json` 的 `statusLine: {type:"command", command}`（与 Claude 同形）；屏幕变化时约每 300 ms 调一次；连续失败若干次会自动停用 |
| Statusline JSON | 与 Claude 兼容：`cwd`、`workspace`、`model.{id,display_name}`、`transcript_path`、`context_window.{total_input_tokens,total_output_tokens,context_window_size,used_percentage,…}`、`session_id`；agy 独有：`conversation_id`、`quota`（分桶）、`plan_tier`、`agent_state`（idle/working/tool_use/authenticating）、`tool_confirmation_pending`、`cycle_mode`、`cost`（目前 null）、`product: "antigravity"`、`email`（**不得显示或记录**） |
| herdr | herdr 已有 agy 集成（`~/.gemini/config/hooks.json` 的 PreInvocation hook 上报 `agent_session_id`），屏幕状态检测已支持 agy |

HUD 现状：agy 只作为无 MCP 的 CLI worker（`src/roles/cli-kinds.ts`，`cliWorkerTools` 只认 claude/codex，收尾靠 shell `hud-progress.mjs --done`）；不能作主会话；没有 statusline；没有安装组件。

## 2. 设计

### 2.1 安装组件 `agy`（`install.d/agy.sh`，仿 `install.d/claude.sh`）

- MCP：`agy mcp remove hud; agy mcp add --env HUD_MCP_SURFACE=roles hud "$BIN_DIR/hud-mcp"`（官方命令，与 Claude 同一入口；同一条注册靠 `HUD_JOB_DIR` 区分 worker 与主会话）。若实现时确认 `eager` 有效，同时为 `hud` 标 eager。
- 权限：`~/.gemini/antigravity-cli/settings.json` 的 `permissions.allow` 加 `mcp(hud/*)`。
- Statusline：同一 `settings.json` 写 `statusLine: {type:"command", command:"$BIN_DIR/hud-statusline"}`；保留 owner 自己的非 HUD statusline（与 claude.sh 相同规则）。
- Hook（投递 B）：HUD 自己的 hook 定义放在 `$HUD_HOME` 下，以 agy 官方机制注册（插件经 `~/.gemini/config/plugins.json` 链接到 `$HUD_HOME/integrations/agy`，或全局 `hooks.json` 加一个具名 hook `hud`）；不改 herdr 自己的 hook。
- 卸载：逐项原样撤回（备份 + 只删 HUD 自己写入的项），与 claude.sh 一致。

### 2.2 Worker（agy 挂 worker MCP）

- `cliWorkerTools('agy') === true`：brief 收尾改为 `hud_report`（含 turn token），可用 `hud_ask`、`hud_sonic`、`hud_progress`、`hud_lease`。
- **保留 shell 兜底**：完成提示同时给出 `hud-progress.mjs --done …`（可加 `--summary`/`--file`），用于第一轮工具未就绪或 MCP 失败。
- 会话身份：`agent_session_id` 仍由 herdr 记录；MCP 侧从 `_meta["antigravity.google/conversation_id"]` 取。
- 行为变化（软约束，已向 owner 说明）：agy worker 从跑 shell 命令改为调 `hud_report`；代价低，收益是能中途提问、自带一句话摘要、可开 sonic。

### 2.3 Orchestrator（agy 主会话）

- 主会话工具：同一注册；`HERDR_PANE_ID` 继承，调用方 pane 可识别；按"非 MCP-tasks 客户端"走（`hud_wait`、`changes`、`watcher_alive`）。
- Resume 保护：`checkResume('agy', _meta conversation_id)`，匹配 STATUS.json `agent_session_id`。
- **投递 A+B（owner 2026-11-22）**：
  - **B（工作中）**：HUD 的 PreInvocation hook 读取该会话（按 `HERDR_PANE_ID`/conversationId 找到调用方）未送达的任务事件，用 `injectSteps` 注入一段简短文本，并标记已送达；没有事件时输出 `{}`，开销是一次小进程启动。
  - **A（空闲时）**：与 Codex 不同，agy 没有 queue 命令；空闲会话由现有 herdr 打字路径送达（agy 的排队消息机制），只在 `agent_state` 为空闲时打字。
  - 同一事件只送一次（B 与 A 共用送达记录）。
- spec 句子：Antigravity 工作中的会话经其 PreInvocation hook 收到事件，空闲会话的事件打进它的输入框。

### 2.4 Statusline

- `hud-statusline` 识别 `product: "antigravity"`：模型、上下文百分比、token、`quota` 分桶接到额度水位段（与 Codex 的 "5h 80% left" 同形）、`agent_state` 可选；不读 agy transcript（格式不同，后续再说）；从不输出 `email`。
- 刷新开销：agy 约 3 Hz 调用；用现有 forward 机制或基于输入签名的结果缓存，使单次调用 p50 ≤ 30 ms；失败时输出简短降级行而不是非零退出（避免 agy 自动停用）。

## 3. 切片

| 切片 | 内容 | 依赖 |
|---|---|---|
| AGY-ADAPTER-01 安装 | `install.d/agy.sh`（MCP、权限、statusLine、hook 注册、卸载）+ spec 句子 + reference 文档 | 无 |
| AGY-ADAPTER-02 worker | `cliWorkerTools` 加 agy、完成提示双路径、`eager` 验证、会话身份 | TEST-SPLIT-04 |
| AGY-ADAPTER-03 orchestrator | resume 保护、投递 B（PreInvocation hook 脚本 + 送达记录）+ A（空闲打字） | 02 |
| AGY-ADAPTER-04 statusline | payload 解析、额度分桶、刷新开销 | 无（安装由 01 指向它） |

## 4. 风险

- agy 版本变化快（1.5.x 周更）：payload 字段与 hook 契约用宽松解析，未知字段忽略；测试用合成 payload。
- 第一轮工具不可用：shell 兜底必须一直在。
- 3 Hz statusline：必须测量开销。
- 隐私：statusline payload 含 `email`，测试夹具只用合成值，代码永不显示或写盘。

## 5. 验收（owner 试用）

- 在 agy 主会话里 `hud_create` 一个 imp，报告完成时：agy 工作中则下一次模型调用即看到事件，空闲则输入框出现事件文本。
- agy imp 用 `hud_report` 收尾，结果行是 worker 自己的一句话。
- agy 底部 statusline 显示模型、上下文、额度水位。
- `./install --with agy` 与 `./install --uninstall --with agy` 往返后 agy 配置与安装前一致（除 owner 期间自己的改动）。

## 6. 已定事项

| # | 问题 | 决定 |
|---|---|---|
| 1 | 安装能否改 agy 自己的配置（`settings.json`、`mcp_config.json`、hooks/plugins） | 可以（owner 2026-11-22），可撤回 |
| 2 | 主会话事件投递 | A+B（owner 2026-11-22） |
| 3 | Stop hook 让 agent 持续等待事件 | 不做（占用回合、耗额度） |
| 4 | agy transcript 解析 | 本轮不做 |
