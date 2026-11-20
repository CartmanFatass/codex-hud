# EXP · 用量与赠额（实验性顶层 tab）

方案：`docs/design/exp-usage-plan.md`（§0 是 owner 2026-11-20 的决定，优先于正文）。规格：`docs/spec.md` §2 的 EXP 段。

共同约束（每张工单都适用）：
- EXP tab 只在 设置 → 面板 → 实验功能 打开时出现；关闭时不采集、不刷新、不发请求。
- 本机全局设置，所有项目同一份，存在 `$HUD_HOME/exp/`（仅当前用户可读写）。
- 不加定时器、不加常驻进程；不同步厂商账单、不抓余额、不拦截请求、不管理管理员密钥；估算为零不阻止任何 CLI。
- 不读取或复制 OAuth token；不改 `~/.codex*` 配置；`codexH` 的 tmux 栏保持原样。
- 40 列可用，Split/Classic，EN/ZH；只用合成数据测试，真实账号验证由 owner 试用时进行。
