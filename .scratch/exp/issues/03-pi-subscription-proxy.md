# 03: pi 订阅代理

**Status:** ready-for-agent
**Blocked by:** 01

**What to build:** EXP 里绑定一个 Codex profile 并启用后，pi 走 `openai` + OAuth 订阅时，footer 显示该 profile 的额度窗口近似值（`5h ≈72%`，有直报时直报 `5h 剩 72%` 优先）；`oapi` 和其它 provider 不借用。刷新：pi 会话绘制 footer 时若快照超过间隔，异步发起一次刷新——非阻塞单实例锁、指定 `CODEX_HOME` 调官方 app-server `account/rateLimits/read`、有总超时、原子替换 `$HUD_HOME/exp/proxy.json`；不加定时器、不读 token、不发推理请求。遵守 retry-after 与指数退避；未登录暂停并在 EXP 提示。换绑/解绑时在途旧结果不得写回；超过两次间隔未成功标旧；过了重置点没新值的窗口显示“待刷新”，不跳回 100%。见 `docs/design/exp-usage-plan.md` §0、§3。

- [ ] 可控时钟 + 假 RPC：首刷、退避、超时、过重置点、换绑竞态、关闭
- [ ] 多个 pi worker 同时绘制只产生一次请求
- [ ] 只在 openai OAuth 路线显示；换模型/换绑/解绑立即丢弃不适用读数
- [ ] EXP 关闭或未绑定：零请求，footer 与现状一致
