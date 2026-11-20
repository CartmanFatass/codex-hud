# 02: Codex 原生 statusline

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** 在现有 `hud-mcp` 增加 Codex 可发现的自定义 statusline 入口：`tools/list` 声明 `_meta["openai/ui"].entrypoints`，`resources/read` 从请求 `_meta["com.openai/codex-statusline-state"]` 读当前线程快照，返回 `application/json` UI tree。复用 MyHUD 的字段选择和宽度优先级（模型、上下文、配额优先来自该请求；工作提醒读本地缓存；无可靠数据的字段省略，不编造 TPS）。资源读取不启动 CLI、不扫描全部会话、不等网络，低于 Codex 的 1 秒超时。原有 MCP 工具协议和 `codexH` tmux 栏不变。EXP 页的“最近观察到”在 EXP 开启时由此入口记录时间（EXP 关时不记）。协议依据见 `docs/design/exp-usage-plan.md` §3 与核对依据链接（Codex 0.171.0）。

- [ ] 合成 `tools/list` / `resources/read` 请求验约；缺字段、窄宽度、两个 profile、切线程不串
- [ ] 资源响应不发 RPC、不等网络，耗时远低于 1 秒
- [ ] 原有 hud 工具与 `codexH` 栏行为不变
- [ ] 写明 owner 在 Codex 里 `/experimental`、`/statusline` 选择 MyHUD 的步骤（EXP 页显示同样步骤）
