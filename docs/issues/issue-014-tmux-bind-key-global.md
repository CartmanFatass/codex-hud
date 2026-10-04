# [中] HUD 切换快捷键以全局方式绑定

## 概要
`tmux bind-key -T prefix H` 未指定目标 session，导致绑定为全局，可能覆盖用户已有的 `Prefix+H` 绑定，并在 codex-hud 退出后仍然生效。

## 影响
- 影响用户全局 tmux 快捷键行为。
- 难以定位来源，需手动解绑或重启 tmux server。

## 位置
- `bin/codex-hud:468`

## 复现步骤
1. 在 tmux 中配置自定义 `Prefix+H`。
2. 运行 `codex-hud`。
3. 观察全局绑定被覆盖。

## 预期结果
绑定仅对当前 session 生效，退出后不影响其它会话。

## 实际结果
全局绑定被覆盖。

## 修复建议
- 使用 `tmux bind-key -T prefix -t "$SESSION_NAME"` 进行 session 级绑定。
- 或在退出时恢复旧绑定。

## 修复记录
- 状态：已修复
- 后续修复：2026-09-22（69d2f4c）起 `bin/codex-hud` 的 `install_session_input_policy` 不再绑定 `prefix`/`root` 表，而是把 root 绑定复制到独立的 `codex-hud` 键表，再以 `set-option -t "$session_name" key-table codex-hud` 仅让 HUD session 使用该表；F12 等 HUD 按键只绑定在 `codex-hud` 表中。`tests/integration/test-input-events-real-tmux.py` 断言用户自定义的 root F12 不被覆盖。
- 以下为最初记录：
- 修复人：codex
- 修复时间：2026-01-30
- 变更说明：尝试改为 session 级绑定 `bind-key -t "$SESSION_NAME"`，但 tmux 3.5a 不支持 `-t`，已回退为全局绑定，问题仍存在。
- 验证方式：已执行（tmux 3.5a 独立 server；先绑定 `Prefix+H` 为自定义，再执行全局 `bind-key -T prefix H`，观察绑定被覆盖，确认仍为全局副作用）。
