# Native usage and Quiet overview

## 中文

在 HUD 前缀键后按 `w` 打开「Codex 用量」（默认前缀为 `Ctrl+\`）。
新「简洁总览」外观还提供有文字的「用量」入口；其他外观的帮助页列出快捷键。

在 **设置 → 显示 → 外观 → 简洁总览** 选择后保存，可应用安静的青绿色
主题、文字导航、紧凑代理列表和较少的状态区装饰。已有配置不会自动迁移。
无色模式仍然优先。代理详情、改动和时间线继续使用原有入口。

用量页支持：

| 操作 | 按键 |
|---|---|
| 总览／任务／模型／推理强度／角色 | Tab、左右方向键或点击标签 |
| 今天／7 天／30 天 | `f` 或点击时间范围 |
| 全部本地记录／当前任务树 | `s` 或点击范围 |
| 刷新本地索引 | `r` 或点击刷新 |
| 滚动 | 上下方向键、PgUp/PgDn、Home/End、滚轮 |
| 返回侧栏 | Esc、`q` 或返回按钮 |

时间范围包含今天，按本地日历划分；页面也提供时区、数据来源、更新时间和
覆盖信息。当前任务显示主会话自身、已确认的子代理及其后代，去重后汇总。
全部本地记录指当前 `CODEX_HOME` 的可发现日志，不等于订阅账户的完整账单。

缓存输入包含在输入中，推理输出包含在输出中，不能重复加到总 token。
没有证据的字段显示未知；有缺口的结果显示不完整。模型和推理强度取自当时
的记录，不使用当前设置补齐历史。数据不用于推断模型质量或实际收费。

索引只在用量页打开时后台刷新，不调用 toktrack，也不新增模型或提供商请求。
首次索引可能需要时间，实时侧栏不等待扫描完成。索引是加速缓存：原始日志
被删除后，缓存不充当历史档案。无法可靠判断归属的 fork 复制记录会被排除并
计入歧义；第一条只有累计量、没有单次用量的记录只作为后续增量的基线。

## English

Press the HUD prefix, then `w`, to open **Codex usage** (default prefix:
`Ctrl+\`). **Settings → Display → Look → Quiet overview**, followed by Save,
applies the quiet teal presentation, labeled navigation and compact agent list.
Existing preferences are not migrated automatically; no-color still wins.
Quiet overview has a visible Usage action; other looks list the command in Help.

Use Tab/arrow keys or labeled tabs for Overview, Tasks, Models, Effort and Roles.
`f` cycles Today/7 days/30 days; `s` toggles All local history/Current task;
`r` refreshes. Scroll with arrows, page keys or the wheel; Esc/`q` returns.

Ranges include today and follow local calendar boundaries. Source, timezone,
as-of time and coverage are available in the page. Current task includes its
recorded descendants exactly once. All local history means discoverable records
under this Codex home, not an account-wide billing statement.

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
