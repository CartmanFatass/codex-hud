# Tab roles: Home, Project, Execution (settled design)

Source: oracle job `j1d071a141ca7d3ba` (2026-11-26), settled by the owner the same day (D-2026-11-26-05). This page is
the build reference for nav-redesign 04–09; the earlier sample `docs/design/nav-redesign/` stays the reference for row
shapes, the strip and the Objective/Feature pages where this page does not override it. No `docs/spec.md` change.

## 1. One grain per tab

Every fact has one home; a single identity spine links the tabs:
`project → Objective id → feature slug → ticket feature/NN → job id / flow id → landed commit`.

| Tab | The owner's question | Shows | Never shows |
| --- | --- | --- | --- |
| 首页 Home | Across my projects, what waits on me, what moved today, what is due? | requests of all projects; projects active today, each ≤ 3 rows (header with role load, one-line current goal, result ≤ 3 days); `▸ N 个其他项目`; `今日 N 已落地 · M 失败`; 日程 | ticket bars, done/total, 未归入目标, Objective next/evidence, job or run rows, screens |
| 项目 Project | What is this project trying to achieve, what landed or awaits my try, what scope remains? | this project's requests only; header + links `工单 工作区 文档`; Objectives by activity tier with bar, count, note and one muted subtitle; fold; 未归入目标 row; drill Objective → Feature → ticket | other projects' requests, job rows, 运行中/刚结束 sections, screens, workflow cursors, routing |
| 执行·N Execution | Where is the workflow now, what are live workers doing, how did recent work end? | readout; **工作流** diagram; **工作者** cards; **刚结束** (24 h) | requests, Objective prose, backlog outside an open run, history older than 24 h, the same job twice |
| 控制 Control | (unchanged) | keeps `[ ]` without the strip; no request rows | — |

Requests: Home = all projects; Project and its sub-pages = the selected project only (no project name in the row);
Execution and Control = none. Empty = zero rows everywhere. `?N` tab badges stay: 首页 counts all, 项目 counts the
selected project. The strip's `?` mark shows which other project asks.

## 2. Following one unit of work

| Stage | 首页 | 项目 | 执行 |
| --- | --- | --- | --- |
| ready | in the fold unless active today | Feature page ticket `● 就绪` / `· 待前序 ← NN` | — |
| running | project `●`, role load `⚒1` | Objective tier 1 `● 1 在跑`; ticket row `◐ 工作中 14分` | tab count; 工作流 node `◉`; 工作者 card |
| explicit request | top of Home | top of Project, Objective note `? 在等你` | — (worker questions: card rises first) |
| settled / landing | — | tier 2 `● 1 门禁`, `◒ 40分前结束·未落地`, `✗ 失败` | 工作流 `门禁 k/N`, `↻ 修复 r/2`, `◷ 等锁`; else 刚结束 |
| landed (≤ 24 h) | 今日 count; result line 3 days | ticket `✓ 完成` (or `◇ 待试用`); Objective tier 2 `✓ 刚落地 slug`, folds at once on the last ticket | 刚结束 `已落地 age`, Enter → Inspector / Run Detail |
| > 24 h | result ages off | permanent: objectives.md Result/Evidence + ticket file Landed comment | gone (job dirs prune at 24 h; archive feeds toktrack) |

Enter paths: Home project header → Project; Home goal/result row → Objective page; Project ticket row with a live or
≤ 24 h job → that job's Inspector (`o` opens the ticket file; with no retained job Enter expands the checklist inline);
Execution node / card / 刚结束 row → Inspector, run header → Run Detail; Inspector's Objective row → Project Objective.

## 3. Workflow diagram (Execution only)

Above 工作者 when any flow of the project is open (working or paused); zero rows otherwise. Covers ticket-queue (`q…`),
batch (`b…`), council and scouting prewalk (`j…`), standalone land (`f…`) and `graph.json` flows, read through the
existing header-scan cache, off the paint path. Vertical waves, never 2D boxes:

1. settled prefix collapsed: `✓ 已落地 K: 01, 02`
2. current wave, one selectable row per node: `├─ ◉ 03 Title   ⚒ 工作中 14分` / `└─ ◉ 04 Title   门禁 2/3`
3. blocked waves: `▼ ○ 05(←03,04) ─▶ ○ 06(←05)`
4. spine: `▼ ○ ⚖ 评审 ─▶ ○ ★ 验收(lead)   待办 1 · 挂起 0`

Live: state and elapsed, node marks `○ ◉ ? ! ✓ ✗`, land gate index, lease wait, active lead `★`, batch counters,
todo/held/repair counts. Out: screens and progress (工作者), Assumed items, findings, lead reasons (Run Detail).
`X` batch control works on Execution.

```text
 首页 ?1  项目  执行·2  控制
 ● orchard  ? tide-lab  quill  ● kiln  lantern  +2 ───────────
  1 运行中   1 等待中   0 排队中           画面每 2 秒读取一次
工作流 ───────────────────────────────────────────────────── 1
▸ ◉ 队列 retry-queue  qf7a1c3d                     运行中 52分
    ✓ 已落地 2: 01, 02
    ├─ ◉ 03 Retry queue survives restarts        ⚒ 工作中 14分
    └─ ◉ 04 Dead-letter view                     门禁 2/3  3分
    ▼  ○ 05(←03,04) ─▶ ○ 06(←05)
    ▼  ○ ⚖ 评审 ─▶ ○ ★ 验收(lead)              待办 1 · 挂起 0
工作者 ───────────────────────────────────────────────────── 2
┌─ ◉ imp · sol · even ───────────────────────── 工作中 14分 ─┐
│ 03 Retry queue survives restarts                           │
│ › 14:18 构建通过，正在补重启用例                           │
│ ϟ 子任务: code 探路 ✓ · docs 探路 ✓                        │
├─ 画面 ─────────────────────────────────────────────────────┤
│ • Edited src/queue/retry.rs                                │
│ • Running cargo test retry                                 │
│   test restart_keeps_order ... ok                          │
└─ 来自 qf7a1c3d (Claude 3f2a91c4) ──────── 标签页 8c1e04aa ─┘
刚结束 ───────────────────────────────────────── 4 · 24 小时内
  ✓ 队列 quota-core · 3 张工单 · 通过               已落地 6分
  ◒ ⚒ 04 Service worker cache                      未落地 40分
  ✓ ⚖ 复审 配额限流边界                               完成 2时
  ✗ ⚒ 02 Reuse worker panes                          失败 20时
```

Fixed flows at 62 columns:

```text
工作流 ───────────────────────────────────────────────────── 3
  ‖ 落地 04 Service worker cache  f90b21c4          已暂停 9分
    ✓ 拣选 ─▶ ✗ 门禁 2/2 ─▶ ◉ ↻ 修复 1/2(⚒ 81a0) ─▶ ○ 合入
  ◉ 评议 跨机状态同步边界  j4a91e02                 运行中 6分
    ├─ ✓ ◈ fable · ◉ ◈ astra · ✓ ◈ carbon ─▶ ○ ★ 综合(main)
  ◉ 批次 sonic ×40  b91c04ef                    槽位 7/7 · 8分
    ✓ 探路 1/1 ─▶ ◉ 并发池 22✓ · 7◉ · 10○ · 1✗ ─▶ ○ 汇总
```

At 40 columns the same queue keeps one node per row, titles cut first, `▼` waves split one per row when needed.

## 4. Home and Project frames (62 columns)

```text
 首页 ?1 ◉1  项目  执行·2  控制
? tide-lab › offline-sync  合并冲突以服务端为准？   在等你 3时
今日活跃项目 ─────────────────────────────────────────────── 3
● orchard ──────────────────────────────────────── ↑ ⚒1 ϟ1 3分
  ▸ ingest (+4)  夜间批量导入全程无需人工重启
  ✓ 批量读取器已能按检查点续读，中断后不重跑整批           5时
? tide-lab ────────────────────────────────────────────── 20分
  ▸ offline-sync  离线编辑重连后的冲突裁决与回放
● kiln · 维护 ───────────────────────────────────────── ⚒1 1时
  ▸ release-04  修补打包脚本回归并重发二进制
▸ 4 个其他项目                                          a 展开
今日 12 已落地 · 1 失败
日程 ──────────────────────────────────────────────────── 2 项
```

```text
 首页 ?1 ◉1  项目  执行·2  控制
 ● orchard  ? tide-lab  quill  ● kiln  lantern  +2 ───────────
进行中 · 高优先级 · 3分前更新               工单  工作区  文档
目标 ─────────────────────────────────────────────── 完成/工单
▸ ingest        ███████▒▒██░░░░░   7/15  ● 1 在跑 · 1 门禁
    夜间批量导入全程无需人工重启
  quotas        ████████████░░░░   9/12  ✓ 刚落地 quota-core
    ✓ 配额核心已切到新账本，单测与门禁全绿
  offline-ui    ██████░░░░░░░░░░    3/8  ◒ 40分前结束·未落地
  theming       ███████████▒▒▒▒▒    5/7  ◇ 等你试用
  search        ███░░░░░░░░░░░░░    1/6  空闲 6天
  ▸ 已完成/搁置 3
  ◌ 未归入目标: pi-worker 1/5 · docs-site 0/2 · telemetry 3/4
```

Home order: unattended status line (only when on); requests (all projects); 今日活跃项目 (request open → active by
priority and recency → maintenance → paused → no record → unavailable); `▸ N 个其他项目`; 今日 one line (zero rows when
zero; no running count); 日程. The goal line shows at every width 40–100.

## 5. Owner settlement (2026-11-26)

1. Requests scoped per tab as in §1 (replaces "every tab" from D-2026-11-26-04); `?N` badges stay.
2. Home: per-Objective ticket bars and the 未归入目标 row go; one-line goal + result ≤ 3 days instead.
3. Execution: screen thumbnails 6 → 3 rows; the bottom 派工关系 tree goes, replaced by a one-line `ϟ 子任务` summary
   on the parent card (full list stays in Inspector).
4. Project's 进度 (Progress, `p`) page goes; the STATE.md link moves under 文档.
