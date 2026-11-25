# Home as a one-glance portfolio, Project as depth (design sample)

Design only: no product code, no tests. Open [`sample.html`](./sample.html) (static, no script, no network, synthetic data only).
It holds 26 cell-exact frames at 40, 50 and 80 columns in 中文 and English, mocha colours, Nerd Font icons as the panel draws them
(`src/render/model-glyphs.ts`, `workboard-rows.ts` `stateMark`; the glyph outlines are embedded as SVG, so no font is needed):

- **Current Home / Project**: the shipped renderer (`renderMonitor` from `dist/`) over the synthetic portfolio below. Rows cut with `…` are tinted red,
  continuation lines hung deeper than 6 cells orange.
- **Proposed Home / Project**, composed from the panel's own helpers (`section`/`pair`/`fit`, `clampClean`, `cutWords`, `theme.board`, `progressSegments`'
  bar glyphs and inks, `ROLE_GLYPHS`), so every row is exactly the panel width (the generator throws otherwise; CJK counts 2).
- A short-panel frame pair: 17 registered projects at one row each.

The frames come from an uncommitted generator in `tmp/tasks/home-design/gen/` (fixture, real-renderer capture, proposed rows, HTML); ask if you want it committed.

Synthetic scenario (6 registrations, 5 live): `harbor-api` (active, priority high; Objectives `rate-limits` with two linked features at 4/8 tickets and **blocked** by
one open `(work waits)` request, `ci-speed` at 4/6; an `imp` and a `reviewer` job running; a result 4 h old), `tide-lab` (one ticketless study, a 6-day-old result), `quill`
(paused, low, a paused Objective at 2/3, 9 days quiet), `lantern-relay-service` (maintenance, nothing active, 41 days quiet, a name longer than the name column), `sketchbook`
(no `objectives.md`, STATE Now only), `old-mill` (root gone).

## 1. Diagnosis (file:line)

The owner's live captures (40×48, reference only, not copied here) show the same three faults the synthetic fixture reproduces
(frame `home-40-zh`, Current):

```
? harbor-api · 2026-11-23 r1 · Pick the
               default burst size: 20…
  目标 · 受阻： Per-key rate limits for
                the public API, with a…
  结果（2026-11-24） · rate-limits： Tok
                                     en…
```

| Symptom | Cause |
| --- | --- |
| A result line leaves 1-2 cells per row (`In` / `s…`) | `home-view.ts:15-16` `prose` wraps the body to `width - visualLength(prefix)` **and** hangs every continuation under that prefix. `:17-20` `detail` builds the prefix from the caller's label, with no cap. `:63-66` makes the label `结果（{date}） · {result.id}`: 32+ cells at 40 columns, so the sentence gets 5. The same helper drives the Objective rows (`:45-47`, label `目标 · 受阻` at `:54`) and STATE `Now`/`Next` (`:59-60`). |
| Requests start with a date and id and hang under `? name · ` | `:24` `prose('? name · ', item.value, 2)`; `item.value` is the collector's `date rN · sentence · Objective title (work waits)` wrapper (`state-ledger.ts:34-42` `requestFields().display`), cut after 2 rows. |
| Four of five projects read only `名 · 未知 ────` | `:33` shows `t(objectives?.stance ?? 'unknown')` for a project without `objectives.md`; `:35-43` moves priority and update time to a second row when they do not fit. Nothing says whether the project is alive, how far it is, or how stale. |
| No progress graphic, 30+ empty rows | `homeRows` never reads `snapshot.tickets`, `.active` or `.counts` (all already collected in `'home'` mode, `project-board.ts:518-540`). The only load is `:70`, scoped to the calling pane. |
| Staleness cannot be read | `updatedText` (`project-view.ts:54-59`) prints a clock time today and an ISO date otherwise: `更新于 2026-10-14` is a date to subtract, not an age. |
| Project cuts Objective titles mid-word (`HUD as the operational wo…`) | `project-view.ts:438` `pair('  id: title', status, width)`; `pair` (`monitor-text.ts:40-45`) gives the title `width - status - 1` cells and `fit` cuts by cell. The id repeats the start of the title. |
| Project repeats Home's Objective and result | `project-view.ts:440-444` prints `Result:`/`Next:` with the label inline (`clampClean(text, width - 4, 2)`); Home printed the same title and result a tab earlier. |
| `进度 不完整 · 64 个任务`, `工单 不完整 · 64 个功能` | `pageSummary` (`project-view.ts:75-96`): `taskCountText` (`:188`) counts acceptance tasks, `featureCountText` (`:189`) counts features, neither names a denominator or a state. `不完整` is `ticketTotals.partial` (`project-board.ts:257-268,610`: only the 64 newest features were read) shown as a bare word. |
| Requests show as one cut row on Project | `inbox-project.ts:26` `clampClean(…, width - 4, cursor ? Infinity : 1)`. |
| Linked-feature figures are checklist counts | `project-view.ts:445-449` prints `slug checked/total` of acceptance checkboxes and silently drops any that is wider than the row (`filter(visualLength <= width - 4)`). |

## 2. Home: one glance across projects

Frame `home-40-zh` (the owner's panel), Proposed, with Nerd glyphs replaced by their Unicode fallbacks:

```
等你处理 ───────────────────────────── 1
? harbor-api › rate-limits    在等你 1天
  Pick the default burst size: 20 or 60
  requests per second? Main cannot ship…
项目 ───────────────────────── 完成/工单
● harbor-api ────────────── ↑ ⚒1 ⚖1 20分
  ? rate-limits ███████████░░░░░░░   4/8
    ✓ Token-bucket core shipped;…    4时
  ● ci-speed    ███████████████░░░   4/6

○ tide-lab ──────────────────── 空闲 2时
  ● tokenizers  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌

○ quill · 已暂停 ───────────────── ↓ 9天
  ‖ docs-site   ████████████░░░░░░   2/3

○ lantern-relay… · 维护中 ────────── 5周

○ sketchbook ────────────────── 空闲 2天
  ¶ Prototype the capture overlay

✗ old-mill ────────────────────── 不可用
```

- **Requests first, only when there are any** (the section is absent otherwise; the `?N` tab badge already says 0). One header row (`? project › Objective`, the amber `在等你`/`work waits`
  flag when work waits, age since opened), then the sentence alone, 2 rows. The date, request id and Objective title the collector glues on are not shown.
- **A block per registered project, always visible.** Header row: liveness mark (● running jobs, ○ idle, ✗ root gone), name, stance word only when not active, a rule, then
  right-hand facts: owner priority arrow when not normal, `空闲` for an idle *active* project, running jobs per role (the statusline's icons) with a clock for queued, age.
- **Second row is the graphic**: one row per open Objective: state mark (● active, amber ? blocked, ‖ paused), id, a stacked ticket bar in the panel's own glyphs and inks
  (green done, lavender to try, blue working, amber blocked, grey to do), `done/total`. A ticketless Objective gets a dotted track and no number. Paused Objectives are grey. More than two:
  `另 N 个`. A result appears under *its* Objective, one cut line with its age, only if it is at most 3 days old and dated (an undated result is not known to be recent).
- **Unlinked row** (only with an `objectives.md`): features no Objective lists that have unfinished tickets or a live job share one row under the block's Objectives and
  their `N more`: `◌ Unlinked: workflow 1/7 · pi-worker 1/5 +3` (`未归入目标:`; nerd `\uF127`, text `-`). Mark, label, counts and `+N` are dim, slugs normal. Live-job features come first, then the
  newest; only whole facts, the rest counted. Slugs only, never a generated title. Enter or click opens the Project.
- **No `objectives.md`**: one dim line with STATE *Now* (¶), never a fabricated goal. **Unavailable root**: ✗ and the word, nothing else.
- **Use of the free rows**: width goes to the bars, not prose; a blank row separates blocks while the panel has room.
- **Why the bar is not on the header row.** The brief asked for the graphic first. A header row that carries the name, load and age leaves the bar rows aligned in one column
  (the eye scans down both), and a project with two Objectives needs two bars anyway. The one-row form below *is* the bar-first form, used when rows are short.
- **Density tiers** (`homeRows` needs the free row count, today it has none): full → drop blank separators → one Objective per project → **one row per project**
  (`● name  ████░░ 8/14  ⚒1 ⚖1 20分`, bar = the project's open Objectives' tickets). Membership never drops: 17 registrations take 22 rows at 40 columns
  where the full layout would need 59 (`#short`).
- **50 and 80 columns add words, not structure**: ≥ 50 the Objective row gets a state word (`受阻`/`blocked`, `已暂停`/`paused`); ≥ 56 every count carries its unit (`4/8 工单`);
  ≥ 80 the Objective title fills the row after the id.

Row budget at 40 columns zh: Current 29 rows (6 cut, 1 deep hang), Proposed 22 (17 without the separators). Other widths: see the frame captions.

## 3. Project: depth for one project

Frame `project-40-zh`. Order: identity (one dim row: stance, priority, age), **Needs you** (the whole sentence, up to 4 rows), **Objectives**, then **Details**.

- **Objective block**: head row (mark, id, `4/8 工单`, `受阻`), the **full title** wrapped (3 rows), **next step** (›, 3 rows), then one **bar row per linked feature** (`rate-limit-core ██████░░ 3/5`),
  with the **running job** under its feature (role icon, ticket number, ticket title, age), the **result** (✓, full text, age) and **evidence** links (↗, up to 3, then `另 N 个`).
  Blank row between Objectives. A done Objective is one row.
- **Home's summary is not repeated**: no Objective bar, no load line, no stance row beyond the identity row. The aggregate figure appears as one count in the head row; the bars are per feature.
- **Unlinked section** (`未归入目标`, with the count) follows the Objectives: one `slug ████░░ 1/7` row per feature in the Home row's order, linked live jobs beneath as above,
  5 rows then `N more`/`fewer`. Enter opens the feature's first unfinished ticket file (the latest when all are finished).
- **Details** replaces `进度 / 工单 / 工作区 / 文档`; each row names its count: `工单 8/14 已完成 · 3 个功能`, `进度 M2 · 2 进行中 · 4 待办`, `文档 spec M2 · 复审 2天前`; the `工作区` row
  (`main · 5 处改动`) stays when Git facts exist and is dropped when the only fact is the jobs list; a partial scan says what it covered (`最近 64 个功能中 …`), never `不完整`.
- Jobs no Objective claims get their own `任务` section; none in this scenario.
- Acceptance checkboxes (today's `slug 1/2`) stay as a muted second figure after the feature count at ≥ 56 columns, named `检查项`/`checks`, and are dropped below that. The fixture has none, so the sample does not draw them.

## 4. Text layout rules the build follows

| # | Rule | Today's counter-example |
| --- | --- | --- |
| 1 | A row is a grammar: mark, token, graphic or fact, right-hand facts. The left part is cut, the right part is whole or absent. Only sentence rows wrap. | `:40-43` metadata that moves to a row of its own |
| 2 | A token (project name, Objective id, feature slug) is cut by cell with `…`, in a fixed column: name 14 / 18 / 24 cells at 40 / 50 / 80 columns, Objective id 11 / 14 / 14, feature slug 16. Never wrapped. | `lantern-relay-service · 维护中 · 空闲 ──` |
| 3 | A sentence (request, title, next, result, STATE note) starts its own row. It never follows a label or a token of varying width. Limits: Home request 2, result 1, note 1; Project request 4, title 3, next 3, result 2; the last allowed row ends in `…`. | `:63-66` |
| 4 | Fixed hang: a continuation line starts where the first line's text started (2 cells after a mark). A label shares a row with a value only in the Details block's label column (9 cells below 56 columns, 10 above, `kvRows`), and the value is a short fact. | `:15-20` hang = label |
| 5 | Cut at a word, or between CJK characters (`cutWords`, `monitor-text.ts:215`); a Latin token longer than the row is cut by cell. English owner text in the zh panel is fine and flows by the same rule. | `project-view.ts:438` |
| 6 | Facts leave whole, never cut, in this order: priority arrow, idle word, age, load (requests: age first, the `work waits` flag last). The name gives way (down to 8 cells) before a fact does. | |
| 7 | Unknown is absent: no `未知`, no `Partial`; a bound that limits a count is named (`最近 64 个功能`). | `:33`, `project-view.ts:39-40` |
| 8 | A count names its unit once: in the section heading below 56 columns, on every row at 56 and above. Home's only denominator is tickets of the Objective's linked features (done / not dropped); a linked feature that was not read gives no bar, never 0/0. | `工单 64 个功能` |
| 9 | Time is an age (`20分 4时 9天 5周`, `20m 4h 9d 5w`), not a clock time or ISO date, except on a dated receipt. | `project-view.ts:54-59` |
| 10 | Under pressure drop in this order: blank separators, results, Unlinked rows, extra Objective rows (`另 N 个`), then one row per project. Requests and membership never drop. | |

## 5. Division table

| Fact | Home | Project | Why |
| --- | --- | --- | --- |
| Open requests | Yes, all projects: header + sentence (2 rows) | Yes, this project's: whole sentence (4 rows) | spec: same requests within their scopes; Home is the inbox, Project the place to read and act |
| Blocked | amber ? on the Objective, `受阻` at ≥ 50 | amber ? and word on the head row, next to the request that blocks it | derived from an open `(work waits)` request, never stored |
| Stance | word in the header when not active | identity row | glance vs identity |
| Owner priority | arrow when not normal | identity row, words | |
| Idle / unavailable | ○ + `空闲` / ✗ + `不可用` | not shown (it is this project) | Home must keep them identifiable |
| Running / queued jobs | per project, by role icon, in the header | the job under its feature, with ticket and age; jobs no Objective claims in `任务` | Home: how alive; Project: which job on which ticket |
| Last activity age | header | identity row | |
| Objective id, state | one bar row each (2, then `另 N 个`) | head row each, all | |
| Objective title | cut after the id at ≥ 80 columns only | full, 3 rows | identity vs meaning |
| Ticket progress | one stacked bar + `done/total` per Objective | count in the head row + one bar per feature | the same tickets, two depths |
| Next step | never | yes | an action detail, not a glance fact |
| Result | one cut line, only if ≤ 3 days old and dated | full text with age, always | Home: freshness signal; Project: the record |
| Evidence | never | links | |
| STATE Now | only for a project with no `objectives.md`, one dim line | full Now / Next (2 rows each) for such a project | handoff notes, not goals |
| Acceptance checkboxes | never | muted second figure at ≥ 56 columns | same tickets, finer grain |
| Tickets, milestone, docs | never | Details rows, each naming its count | diagnostic pages |
| Worktree (Git facts) | never | Details row `工作区` when Git facts exist | probe runs only on the page (reference.md) |
| Pane load line | removed, replaced by per-project load | | open question 1 |

## 6. What the build needs

Everything below is in the data the panel already collects, except the two items marked **new**.

- Home bars: `snapshot.tickets` (`TicketFeature[]`, states `done|dropped|try|working|blocked|ready|queued`) filtered by `Objective.features`; load and the idle word: `snapshot.active` and `snapshot.idle`; age:
  `max(updatedAt, objectivesAt)`; recent result: `HomeProject.result` (newest per project, dated via receipts), shown under `result.id`.
- **New** (small): the request sentence alone. The collector joins `date rN · sentence · Objective title (work waits)` into `ProjectItem.value`/`text` (`state-ledger.ts:34-42`); the sample strips it with a regex. Carry
  the bare sentence as a field.
- **New** (small): `homeRows` takes the free row count to choose the tier; rendering stays pure.
- Navigation ids are unchanged: header `home:project:`, Objective row `home:objective:`, result row `home:result:`, request `home:wait:` (its sentence rows share it), `home:more:`.
- Strings: about 25 EN/ZH entries (`完成/工单`, `在等你`, `空闲`, `另 {n} 个`, ages, Details rows). Unicode and text fallbacks through `mark(unicode, ascii, nerd)`: ● `*`, ○ `o`, ✗ `x`, ? `?`, ‖ `=`, ✓ `+`, › `>`, ↗ `@`, ¶ `.`, ↑ `^`, ↓ `v`.
- Size: `home-view.ts` rewritten (about 150 lines), `project-view.ts` `objectiveRows` and the hub rows (about 120), tests regenerated for the two views at 40/50/80.

## 7. Open questions for the owner

1. **Pane load line.** The proposal drops `This pane · 2 running · 0 queued` (`reference.md` Home, `home-view.ts:70`) because each project header now carries its own load. The pane count is the calling pane's, not a project or machine total.
   *Recommend: drop it.*
2. **How long is a result "recent" on Home?** The proposal shows it for 3 days, then only on Project. *Recommend: 3 days.* The alternative, always the newest result, brings the old wrapped result lines back.
3. **Paused Objectives on Home.** Today Home hides every Objective that is not active or blocked. The proposal shows a project's paused Objectives with a grey bar (at most 2 rows per project), so a paused project still tells how far it got.
   *Recommend: show them.*

## 8. Checks and decisions

- Every frame row, Current and Proposed, is asserted at generation time to be exactly its width by `visualLength` (CJK 2); the page has no script and no outside request; no real names, paths or text are in the files
  (grep for the user name and home path returns nothing).
- Decided without asking (reversible): the panel's own stacked-bar glyphs are reused instead of a new bar; the ticket denominator excludes dropped tickets; the age unit set is `m h d w` (`分 时 天 周`);
  the idle word shows only for an *active* project (a paused or maintenance project says so already).
- Limits of the sample: Proposed frames are composed from helpers, not the product renderer; Unicode and text icon sets are described, not drawn; light themes were not drawn; no mouse or cursor states.

**Settled by the owner 2026-11-24 (D-2026-11-24-01):** build this design; 1. drop the pane load line; 2. a result
stays on Home for 3 days; 3. paused Objectives show grey bars.
