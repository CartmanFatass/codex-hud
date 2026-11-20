# 05: API 赠额账本 · Anthropic

**Status:** ready-for-agent
**Blocked by:** 04

**What to build:** 用 04 的同一套账务接入 `anthropic-api`：只在确认 pi 走 Anthropic API key 路线时记账（Claude 订阅、第三方网关、无法归属的调用不扣），写 `$HUD_HOME/exp/ledger-anthropic-api.jsonl`。pi footer 在 Anthropic API 路线显示该账估算剩余；Claude Code 的订阅窗口显示不变。EXP 页两本账并列。见 `docs/design/exp-usage-plan.md` §4。

- [ ] 合成请求验证路线判定：API key 记账，订阅/网关/未知不记
- [ ] 两本账互不影响（同时有 oapi 与 anthropic 请求）
- [ ] Claude Code statusline 行为不变
