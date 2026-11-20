# 01: EXP 顶层 tab 与设置页

**Status:** resolved
**Blocked by:** none

**What to build:** 设置 → 面板 新增“实验功能”开关（默认关）。打开后顶栏多一个标“实验”的 EXP 主 tab，与 Home、Project 并列（←→/Tab/点击切换，数字键不切 tab）。页面分三组：Codex 原生栏（各本机 profile 的别名、最近一次观察到 MyHUD 原生栏的时间——本单显示“未接入”）、pi 订阅代理（选择/解绑一个已知本机 Codex profile、启停、间隔 5–60 分钟，默认 15）、API 赠额（anthropic-api、openai-api 各一行：启用、每期赠额、续期日与时区、校准“此刻剩余”）。上下选择、Enter 编辑、保存显示结果、Esc 取消不落盘；保存校准前显示“旧估算 → 新基准”。设置写 `$HUD_HOME/exp/config.json`，校准写 `$HUD_HOME/exp/ledger-<账>.jsonl` 的一行校准事件。未接通的读数一律显示“未接入”。见 `.scratch/exp/spec.md` 与 `docs/design/exp-usage-plan.md` §0–§2。

- [x] 开关默认关；关时无 tab，打开后出现 EXP tab，重启面板后仍在
- [x] 三组设置可编辑、保存、Esc 取消；重启后保留；不同项目看到同一份
- [x] profile 选项只来自本机已知的 Codex profile，不接受任意命令
- [x] 校准写一行带时间的 JSONL 事件；文件权限 0600，目录 0700
- [x] 40 列 EN/ZH、Split/Classic 每行等宽，不在词中截断
- [x] 本单不发任何网络请求，不改任何 CLI 配置
