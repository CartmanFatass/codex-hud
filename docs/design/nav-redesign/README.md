# Panel navigation: Project and Execution, element to element (design sample)

Design only: no product code, no tests. Decision D-2026-11-26-04; `docs/spec.md` §1 display rule and §2.2. Open
[`sample.html`](./sample.html) (static, offline, no script, synthetic data). It holds 13 cell-exact frames (中文 at 62 and 40
columns, one English Project frame at 62) and single-row states of the strip and request area, in mocha with Nerd Font
outlines. Rows are composed from the panel's own helpers over a private build of `src/`; Execution cards, runs and the
delegation tree come from `executionRows` over synthetic jobs. The generator throws on any row that is not exactly the
panel width (CJK counts 2); it is not committed (`tmp/tasks/nav-redesign/gen/`).

Scenario: seven projects, three active (`orchard`, current, with live jobs; `tide-lab` with the one open request; `kiln`
with live work). `orchard` has the Objectives of the brief (live, just landed, finished and not landed, to try, quiet,
two done, one paused) and three unlinked features. A third live job (`sonic`, no Objective, waiting for main) shows the
waiting card, so the tab reads `执行·3`. The idle Execution frames are three hours later.

## 1. Complaint → frame

| # | Complaint | Answer | Frames (`sample.html#…`) |
| --- | --- | --- | --- |
| 1 | Switching projects is hard | Resident project strip with marks; `[ ]` and click | `strip`, every tabbed frame |
| 2 | 「需要你处理」 is empty but takes rows | Request area with no row when empty | `ov-req-62` vs `ov-quiet-62` |
| 3 | Done and parked Objectives on top | Activity order; done and paused fold into one row | `ov-req-62`, `ov-quiet-62` |
| 4 | 详情 at the bottom; Enter shows only evidence; feature bars open nothing | Enter drills Objective → feature → job; Details become header links | `drill`: `obj-62`, `feat-62`; `obj-40`, `feat-40` |
| 5 | A finished job vanishes | 刚结束, 24 h, with result and landing state | `busy-62`, `idle-62`, `feat-62` |
| 6 | Execution should be a tab | `首页 项目 执行·N 控制` | `busy-62`, `idle-62`, `busy-40`, `idle-40` |

## 2. Shared chrome

Top to bottom, all pinned (the page body scrolls beneath them, like today's filter row): tabs, project strip (项目 and 执行
only), request rows, then the page. `↑` from the first body row reaches the last request row.

**Tabs.** Today's ` Label ` cells, the open one on the title surface. `执行·N`: N is the current project's live jobs
(running, waiting, queued), omitted at 0. The `?N` request badges go: the request area is on every page. Home's
schedule-due badge stays (nothing is due in the scenario).

**Project strip.** One row, entry ` mark name `:

- Order is the panel's project list (the pane's own project first), never re-sorted by activity, so `[ ]` moves to the
  neighbour on screen.
- Marks: `?` open owner request, else `●` live work, else none (idle names are muted). Current project on the title
  surface. A rule fills the rest of the row.
- Too wide: idle projects leave from the end into `+N`; then names shorten to 8 cells; only then marked projects fold,
  and `+N` carries their strongest mark. The current project always stays, even if idle.
- Click a name to switch; click `+N` for today's grouped Projects list (`projectListRows`). It replaces the
  `▾ 项目 1/7` header. 控制 keeps `[ ]` as today and shows no strip.

**Request area.** Open owner requests of all projects, explicit requests only: never failures or completions.

- `? project › Objective  sentence…  在等你 age`, one row each. The sentence takes what is left and is dropped under 12
  cells; then the `在等你` flag leaves before a name is cut below 8. Age always stays.
- Order as spec §2.2: work waits first, owner priority, oldest open. Four rows, then `另 N 个请求` (Enter expands in place).
- Enter opens today's Waiting page (whole sentence; `o` opens the file); a try request opens its prepared scene.
- No request: no row, no heading, no placeholder.
- On 首页 it replaces Home's own `等你处理` section, so requests never print twice.

## 3. Project tab

| Row | Content |
| --- | --- |
| Header | `进行中 · 高优先级 · 3分前更新` and the links `工单 进度 工作区 文档`. Priority leaves first when narrow; below 50 columns `3分前`. |
| Section | `目标 ──── 完成/工单` names the unit once. |
| Objective | `id  bar  done/total  note`. Id / note columns: 13 / 22 cells (≥ 56), 11 / 13 below. The bar is `barText` over linked tickets; a ticketless Objective has a dotted track and no count. |
| Fold | `▸ 已完成/搁置 N`; Enter expands in place, newest first. |
| Unlinked | Home's one row: `◌ 未归入目标: slug done/total · … +N`. Enter opens a list of those features in the Objective page's row shape (not drawn). |

**Order.** An Objective takes the first tier it meets; its note states that fact.

| Tier | Meets it | Note | Order inside |
| --- | --- | --- | --- |
| 1 live | a live job on a linked ticket | `● 2 在跑` | latest activity |
| 2 recent | a job or run ended in the last 24 h | `✓ 刚落地 quota-core` (slug ≥ 56; after 1 h `✓ 5时前落地`), `◒ 40分前结束 · 未落地`, `✗ 40分前失败` | newest |
| 3 you | an open request, or a ticket to try | `? 在等你`, `◇ 等你试用` | request first |
| 4 quiet | the rest | `空闲 6天` | latest activity |
| folded | state `done` or `paused`, or every linked ticket done or dropped | `✓ 完成 9天`, `‖ 搁置 3周` | newest |

An Objective with a live job or an open request never folds. Without an `objectives.md`, today's Now / Next notes stand in
place of the list; the unreadable-Objectives line is unchanged. The cursor starts on the first request, else the first
Objective. Jobs no Objective claims are no longer listed here (today's `任务` section): they are on 执行.

## 4. Where today's 详情 entries live

| Today (`inbox-project.ts:42-57`) | Now | Key |
| --- | --- | --- |
| Execution | its own tab, `执行` | `← →` / Tab, click |
| Tickets (with Accept all) | header link `工单`; one feature's tickets are on its Feature page | `t` |
| Progress | header link `进度` | `p` |
| Worktree | header link `工作区`, only with Git facts | `b` |
| Docs | header link `文档` | `d` |

Each link opens today's page unchanged (crumb, Esc back); the hub's one-line summaries are no longer shown. The footer
drops hints from the end when narrow (40 columns shows `t` and `p`; English 62 drops `d`); the links stay clickable and
`?` lists every key. `p` and `d` are decoded today as `preset-list` and `answer-default` (`workbench-input.ts:110,117`),
used only on 控制 and in the Inspector, so the Project page can map them.

## 5. Objective and Feature pages

Both are sub-pages: the crumb replaces tabs and strip (`[ ]` is off), requests stay on top, Esc returns to the row that
opened the page with the same scroll.

**Objective** (Enter on an Objective row). Crumb `‹ orchard › ingest`, right `进行中 · 7/15 工单` (state includes `受阻`).
Title (≤ 3 rows), next step `›`, result `✓` with age (as today's Objective block, no labels). `功能`: one row per linked
feature (`slug bar done/total`, bar ≤ 24), its live and recently ended jobs nested below. `依据`: every evidence entry.
Enter: feature → Feature page; job → Inspector; evidence → file or commit.

**Feature** (Enter on a feature row). Crumb ends in the slug (the project name leaves below 56 columns). Stacked bar and a
legend with counts. `工单`: working, to try, blocked, ready, queued (by number), then done (newest first), each with its
state mark, word and blockers. `运行中` and `刚结束`: this feature's jobs. Enter: ticket → ticket file; job → Inspector.
`g P H` act on a live tab job, as on Execution.

A job belongs to a feature through its ticket. A job without a ticket appears only on 执行.

## 6. Execution tab

Current project only. Order:

1. Today's readout and 工作者 cards (running, waiting, queued). **Screen thumbnails are 3 rows, not 6.**
2. 运行: ticket-queue runs still open (working or paused), as today.
3. **刚结束**, last 24 h, newest first, one row per job or run: `mark icon title ··· result age`.
4. 派工关系: today's delegation tree, kept and moved to the end.

| Result | Mark | Observed fact |
| --- | --- | --- |
| 已落地 | green check | a land flow with a landed commit |
| 未落地 | hollow check | a worktree job ended and no land flow has a landed commit |
| 完成 | green check | ended, nothing to land (review, sonic, main-checkout work) |
| 失败 / 已停止 | cross / stop | the job's own state |

If the landing record cannot be read the row says no result word. A run is one row (`队列 label · N 张工单`): 失败 if any
ticket failed, else 已落地 if all landed, else 未落地. Its member jobs are not repeated, neither while it is open (they are
in its block) nor after (Enter opens the run detail). Enter on a job row opens the Inspector. With no live job and no open
run the page is only 刚结束: no readout, no empty sections; with nothing in 24 h either, today's
`没有运行中或等待中的任务`. The `不完整` coverage word stays.

## 7. Source helpers used

| Helper | File | Used for |
| --- | --- | --- |
| `pair`, `clampClean`, `sentenceRows`, `cutSentence`, `tokenColumn` | `render/monitor-text.ts` | every row, wrapped sentences, fixed columns |
| `section`, `subTopRow`, `footRow`, `boardCursor`, `mark`, `stateMark`, `compactAge` | `render/workboard-rows.ts` | headings, crumbs, footers, cursor, marks, ages |
| `barText` (`progressSegments`), `linkedTicketProgress`, `TICKET_BAR_ORDER` | `render/progress-bar.ts` | Objective and feature bars |
| `ROLE_GLYPHS` / `roleIcon`, `roleInk` | `render/model-glyphs.ts`, `render/work-job-row.ts` | job rows |
| `theme.board`, `visualLength`, `truncateAnsi` | `render/colors.ts` | inks and cell measure |
| `executionRows` | `render/execution-view.ts` | cards, runs, delegation (sample trims blank screen rows) |
| `t` | `render/i18n.ts` | panel words inside the real renderers |

Re-composed in the sample because they are not exported or not shaped for this: `unlinkedRow` and `requestRows`
(`home-view.ts:178,126`), the tab row (`work-view.ts:206-217`), `ticketGlyph` (`project-view.ts:232`).

## 8. What the build needs

**New row shapes:** tab with live count; project strip; one-row request; Project header with links; Objective row with
activity note; fold row; feature row with nested jobs; the one job row (live or ended, also used for runs); feature legend;
one-row ticket.

**Data and structure** (checked in code):

- Requests and strip marks on every tab. The portfolio is read only while Home shows (`panel/controller.ts:363`) and the
  per-project running / waiting overview only while the Projects list is open (`:357`). Read the light facts on every tab,
  at the overview's 5 s cadence.
- Ended jobs for 24 h. Execution lists only unsettled jobs and their families (`collectors/execution.ts:74`); ended runs
  stay 1 h (`ENDED_MS`, `collectors/execution-runs.ts:22`). Add a bounded 24 h list from job records, with landing from
  land flows, and keep ended runs 24 h.
- Feature → jobs including settled ones. Today a ticket carries one job and Project shows it only while live.
- Per-Objective tier and note: live jobs by linked ticket, newest ledger landing, newest ended job, tickets to try, open
  requests.
- `SCREEN_ROWS` 6 → 3 (`collectors/execution-screens.ts:9`).
- `MAIN_TABS` gains `execution`; `PROJECT_PAGES` loses it; `detailRows` and the `project:switch` header go; the Objective
  sub-page grows and a Feature sub-page is new.
- New EN/ZH strings (执行 tab count, 刚结束, 24 小时内, 已完成/搁置, 在跑, 刚落地, 未落地, 等你试用, 另 N 个请求, key hints) and
  `docs/reference.md`.

## 9. Choices the owner would see

Taken in the sample beyond the brief's words:

1. A request row adds a cut of its sentence when 12 cells are free (spec §2.2: attention says what).
2. `?N` tab badges removed; Home's two-row request section becomes the shared one-row area.
3. "Recent" (tier 2) covers any end in 24 h, not only landings, so the not-landed job sorts above the one to try.
4. Thumbnails cut to 3 rows; delegation tree kept at the end; Projects list kept behind `+N`.
5. Header keys `t p b d`.

Open questions (recommendation first):

1. **Home requests.** Accept the one-row area there (recommended), or keep Home's two-row sentences and show the area on the
   other tabs only?
2. **Projects list.** Keep it behind `+N` (recommended), or drop it now that the strip switches?
3. **Last landing completes an Objective.** It folds at once, as briefed, and stays traceable in 刚结束 (recommended); or it
   stays in the recent tier for 24 h.

## 10. Checks and limits

- Every row in the page is asserted at generation to be exactly its width; an overrun in ASCII or CJK throws (checked),
  short rows are padded. The page has no script and no outside reference. Rendered with headless Chrome and inspected.
- Not drawn: Home and Control, the Inspector, run detail, the Waiting, Unlinked and four linked diagnostic pages,
  scrolling (the busy Execution frame is 50 rows), unicode and text icon sets, light themes.
- New rows are prototypes, not the product renderer; their `en` words are drawn only on the Project tab.
