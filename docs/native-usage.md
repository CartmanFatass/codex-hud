# Native usage and Quiet overview

## 中文

在 HUD 前缀键后按 `w` 打开「Codex 用量」（默认前缀为 `Ctrl+\`）。
所有外观的菜单栏均提供「用量」入口，无需切换外观。主视图使用图标、圆角指标卡、
费用／Token／命中率概览、Token 组成、分组排行和竖向趋势，
直接适配本机 toktrack a6353d3 的布局、配色与图表；令牌数使用相同的 K／M／B。

详情不占菜单栏：前缀键后按 `4` 调出精确计数、来源与覆盖情况，Esc 返回概览。
代理详情同样通过前缀键后按 `4` 或选中代理后按前缀键、Enter 调出。

在 **设置 → 显示 → 外观 → 简洁总览** 选择后保存，可应用安静的青绿色
主题、文字导航、紧凑代理列表和较少的状态区装饰。已有配置不会自动迁移。
无色模式仍然优先。代理详情、改动和时间线继续使用原有入口。

用量页支持：

| 操作 | 按键 |
|---|---|
| 总览／任务／模型／推理强度／角色 | Tab、左右方向键或点击标签 |
| 今天／7 天／30 天／全部历史 | `f` 或点击时间范围 |
| 全部本地记录／当前任务树 | `s` 或点击范围 |
| 刷新本地索引 | `r` 或点击刷新 |
| 精确计数／来源详情 | HUD 前缀键后按 `4` |
| Token／费用 | `m` 或点击指标切换 |
| 模型／项目／推理强度／角色分组 | `v` 或点击分组切换 |
| 选中／钻取／返回分组 | 上下方向键／Enter／Esc；也可点击排行 |
| 滚动 | PgUp/PgDn、Home/End、滚轮 |
| 返回侧栏 | Esc、`q` 或返回按钮 |

时间范围包含今天，按本地日历划分；页面也提供时区、数据来源、更新时间和
覆盖信息。当前任务显示主会话自身、已确认的子代理及其后代，去重后汇总。
任务卡片使用 Codex 会话标题；启用 AI 增强的「Agent 名称」时，优先复用已生成的会话标题。
没有标题时使用项目名与日期，任务页不显示 thread ID。标题随本地索引刷新，浏览历史不会触发批量 AI 生成。
全部本地记录指当前 `CODEX_HOME` 的可发现日志，不等于订阅账户的完整账单。

缓存输入包含在输入中，推理输出包含在输出中，不能重复加到总 token。
没有证据的字段显示未知；有缺口的结果显示不完整。模型和推理强度取自当时
的记录，不使用当前设置补齐历史。数据不用于推断模型质量。费用按每次请求计价后汇总，读取 toktrack 的
`~/.toktrack/pricing.json`、`pricing.toml`（支持 `TOKTRACK_PRICING_FILE`），
缺少本地表时使用同源离线表；不在刷新时请求网络。模型匹配、逐请求阶梯价格、
Fast 倍率、自定义价格和缓存扣除规则均来自 toktrack 的 Codex 路径。
`*` 沿用参考实现的估算标记，代表 API 等价费用，不代表订阅账单；缺价请求不伪装成零。
单价、阶梯和价格覆盖情况放在前缀键 `4` 的详情中。

索引只在用量页打开时后台刷新，不调用 toktrack，也不新增模型或提供商请求。
首次索引可能需要时间，实时侧栏不等待扫描完成。索引是加速缓存：原始日志
被删除后，缓存不充当历史档案。无法可靠判断归属的 fork 复制记录会被排除并
计入歧义；第一条只有累计量、没有单次用量的记录只作为后续增量的基线。

## English

Press the HUD prefix, then `w`, to open **Codex usage** (default prefix:
`Ctrl+\`). **Settings → Display → Look → Quiet overview**, followed by Save,
applies the quiet teal presentation, labeled navigation and compact agent list.
Existing preferences are not migrated automatically; no-color still wins.
Every look has a Usage menu item. Rounded metric cards, icons, cache share and daily
bars use toktrack’s one-decimal K/M/B token notation. Inspector is a shortcut, not
a menu tab: press the HUD prefix, then `4`. In Usage this opens exact counters,
source and coverage; Esc returns to the dashboard.

Use Tab/arrow keys or labeled tabs for Overview, Tasks, Models, Effort and Roles.
`f` cycles Today/7 days/30 days/All time; `s` toggles All local history/Current task;
`r` refreshes. As in toktrack, `m` changes tokens/cost, `v` changes model/project/effort/role grouping, arrows select and Enter drills down; Esc restores the original group. Page keys and the wheel scroll; Esc/`q` returns.

Ranges include today and follow local calendar boundaries. Source, timezone,
as-of time and coverage are available in the page. Current task includes its
recorded descendants exactly once. All local history means discoverable records
under this Codex home, not an account-wide billing statement.
Task cards use native session titles, preferring stored AI titles when the existing
Agent names enhancement is enabled. Missing titles fall back to project and date;
thread IDs are not displayed. Browsing history does not schedule bulk title generation.

Cached input is part of input and reasoning output is part of output. Missing
fields remain unknown; coverage gaps make results partial. Model and effort come
from the usage event's context, never today's settings. Counts do not measure
model quality or actual charges.

Indexing runs in the background only while the page is used. It is independent
of toktrack and adds no model/provider requests. The persistent index accelerates
reads but does not preserve history after native sources are deleted. Ambiguous
copied-fork events are excluded and reported in coverage. A first cumulative-only
record establishes a baseline instead of assigning earlier lifetime usage to its
timestamp. Live HUD collection never waits for the history scan.

## Port provenance

Reference: local toktrack commit `a6353d3` (MIT).

- `services/pricing.rs` and `normalizer.rs` → `src/collectors/usage-pricing.ts`: model matching, per-request tiers, custom prices, Fast rates, Codex cache normalization.
- `tui/theme.rs` and `widgets/token_composition.rs` → `src/render/usage-theme.ts`: theme colours, token-part colours and largest-remainder allocation.
- `widgets/overview_card.rs`, `rank_table.rs`, `usage_trend.rs`, `layout.rs` → `src/render/usage-page.ts`: overview metrics, composition, shared ranking, period comparison and vertical eighth-block trends, adapted to the HUD viewport.
- `assets/toktrack/` retains the reference offline price table and MIT notice. HUD runtime does not require a toktrack executable. The conformance test invokes an installed executable only with synthetic local logs, a private home and a fresh fixture price table.

The HUD view remains scoped to native Codex logs and its task tree. Toktrack's independent SSH ingestion, cross-provider account management, backup and audit commands are not routes in this HUD.
