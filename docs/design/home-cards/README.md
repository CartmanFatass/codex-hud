# Home cards: Today and Schedule (design sample)

Design only: no product code, no tests. Open [`sample.html`](./sample.html) (static, no script, no network, synthetic data only). It holds 21 cell-exact
frames and 10 excerpts at 40, 50 and 80 columns in 中文 and English, mocha colours, Nerd Font icons as the panel draws them (the glyph outlines are
embedded as SVG, so no font is needed). The Home above the cards is the settled [portfolio design](../home-portfolio/README.md) (D-2026-11-24-01): its
Proposed rows, composed from the panel's own helpers; the tab row and footer are the shipped renderer's. Every row is asserted at generation time to be exactly its
width by `visualLength` (CJK counts 2).

`gen/` holds the prototype modules (not product code): `fixture.mjs` extends the portfolio fixture with a day of synthetic job and land records and a synthetic
`schedule.json`; `cards.mjs` composes the card rows, the fold ladder and the tab badge. Today's numbers are what the **shipped** `collectJobStats` returns over those records;
the Schedule reader is the proposed one. Run after `npm run build` with `TZ=UTC`. The HTML page builder stayed out of the repo (it reads a local font file); ask if you want it committed.

## 1. What the cards are, and what they are not

The owner (2026-11-24): "home 底部我需要一个卡片区域来显示一些信息" and "多项目管理感觉时间管理是必须的 … 后续多了能够帮我管理好时间". Two cards, last on Home:

- **Today (今天)**: what workers finished today across all registered projects. Facts, no verdict.
- **Schedule (日程)**: dated items the owner told main to remember, merged with reminders, plus projects gone quiet.

How they sit with the spec:

- **Today is a card, not the removed footer.** `docs/spec.md` "Removed by this spec" (line 237) removes the "done today" footer and "latest accepted slices". The owner has now asked for
  Today back. The card shows landed tickets (a land record, not an acceptance) and counts; ticket acceptance rows stay removed. `docs/spec.md` is the owner's to change:
  the build brief should log the decision and amend that line. I did not edit it.
- **Schedule is not an owner request.** Spec §2.2: attention means *someone has asked this owner to do something*. A schedule item says *when*, a request says *someone waits*.
  The item never appears in Waiting, STATE, the `?N` badge or the bar's owner count (section 4 shows how a due item becomes visible without that).
- **Spec §3**: no inferred attention score, no human-activity surveillance, no ROI ranking. Today counts what workers finished from records that already exist, today only, no history
  (anything over time is toktrack's: HUD ↔ toktrack split). Schedule holds only what the owner asked main to record. No model call anywhere.
- **Display rule (§1)**: requests and the project list come first; the cards use only the rows the full project list leaves and fold first (section 6).

## 2. Layout

Frame `busy 40 zh` (the owner's panel), cards only, Nerd glyphs replaced by their Unicode fallbacks:

```
 首页 ?1 ◉2  项目 ?1  控制
                                          (blank separator)
今天 ────────────────────────── 7 个落地
✓ harbor-api retry-after hint       40分
✓ tide-lab   sample set loader       2时
✓ harbor-api header writer           3时
  另 4 个
  完成 ⚒7 ◈1 ⚖3 ⚡4
  失败 ⚒1
  闸门 一次过 5 · 重试 2

日程 ────────────────────────────── 6 项
! 11-22 续订开发机 SSH 证书     逾期 2天
◉ 11-24 与团队过限流方案            今天
  harbor-api › rate-limits
◷ 11-27 发布 SDK 说明              3天后
◷ 12-01 删除 tokenizer 旧缓存…     7天后
  另 2 项
○ 静默 sketchbook 3周
```

The cards use the panel's section header (`label ──── one fact`), not boxes: the panel draws no boxes, and a box would cost 4 cells and 2 rows per card at 40 columns.

| Row | Grammar | 50 / 80 columns |
| --- | --- | --- |
| Today header | `今天 ──── 7 个落地` (`none landed` when only jobs finished; `暂无` when nothing at all, a read zero) | same |
| Landing (newest 3) | `✓` · project (10 cells, cut with `…`) · ticket title (cut at a word) · age (4 cells, right) | project 14 / 18; **80** adds the ticket id (18, dim) before the age |
| `另 4 个` | 2 cells in, dim; the only row that names the rest | same |
| Fact rows | label column (`完成` `失败` `闸门`, longest + 1) · role icons with counts / `一次过 5 · 重试 2`; a zero is absent; failed in red | same |
| Schedule header | `日程 ──── 6 项` | same |
| Item | stage mark · date (5, `MM-DD` or `MM-??`) · text (cut) · countdown (right, whole; column = widest shown) | **80** adds the project name (14, dim) before the countdown |
| Context row | `  harbor-api › rate-limits`, dim, only under a **due** item that has a project, below 80 columns | not drawn at 80 (the project is a column) |
| `另 2 项` | 2 cells in, dim; items beyond the 4th (3rd when compact) that are not due | same |
| Quiet line | `○ 静默 sketchbook 3周`, one dim row, whole facts only, then `另 N 个` | same |

The ten layout rules of the portfolio design, as the cards apply them:

| # | Rule | In the cards |
| --- | --- | --- |
| 1 | row = mark, token, fact, right-hand facts; left cut, right whole | every row; countdown and age are whole and right |
| 2 | tokens in fixed columns, cut by cell | project 10 / 14 / 18 cells (narrower than Home's 14 / 18 / 24: a title shares the row), date 5, ticket id 18 at 80 |
| 3 | a sentence starts its own row, rows are limited | a schedule text is an item label: **one row, cut, never wrapped**; the context row is a fact, not a continuation |
| 4 | fixed hang; label and value share a row only in a fixed label column | no wrapped lines, so no hang; fact rows use the Details label column (4+1 cells zh, 6+1 en) |
| 5 | cut at a word or between CJK characters | `cutWords` for titles and texts; English text in the zh panel flows the same way |
| 6 | facts leave whole, never cut | age, countdown, `一次过 5 · 重试 2`; the project column is a fact that only exists from 80 columns |
| 7 | unknown is absent; a bound is named | an unreadable record file means no card (not `暂无`); `暂无` is a **read** zero; `12-??` is a known month with no day, not an unknown |
| 8 | a count names its unit once | the header (`7 个落地`, `6 项`); counts beside a word or a role icon, never bare |
| 9 | ages, not dates, except on dated items | landings show ages; schedule items are dated items and show `MM-DD` **and** a countdown |
| 10 | under pressure drop in this order | the cards fold **before** blank separators, results and project rows (section 6) |

Marks (Unicode and text fallbacks via `mark(unicode, ascii, nerd)`): landed `✓` `+` (the done mark); schedule far or soon `◷` `~` (the queued clock), today `◉` `@`, overdue `!` `!`;
quiet `○` `o` (the idle mark); the tab badge uses the today mark. Role icons and inks are the statusline's (`ROLE_GLYPHS`, `roleInk`).

## 3. Today (今天)

Contents, in order: **landed** tickets (newest 3 with project, ticket title, age, then `另 N 个`), **finished** jobs by role icon, **failed** jobs by role icon (row absent at zero),
**gates** (`一次过 N`: passed first time; `重试 N`: passed after a rerun or a repair).

| Fact | Source (already collected) | file:line |
| --- | --- | --- |
| Landed ticket, time | `$HUD_HOME/flows/<flow>.json`: `landed_sha`, `landed_at`, `wt.main_root` (the project), written by `hud_land` | `src/mcp/land-state.ts:16-30` (`LandFlow`), `:34` (`landFile`); read-only projection `src/roles/job-land.ts:20-54` (`readJobFlow`), `:87-90` (`landedIn`) |
| Window "today" | local midnight to now | `src/collectors/job-stats.ts:16-22` (`localDayStart`); the Control tab already asks `collectJobStats` the same window with a 30 s cache, `:178-185` |
| Landed list | `collectJobStats(home, since, now).landed`: a landed job per land receipt or archived job | `job-stats.ts:114-117` |
| Ticket title | the job's `ticket` (`feature/NN`) joined to the project snapshot's `tickets[].title`, the snapshots Home already holds; fallback the worker-declared `summary`, else the ticket id; never an invented title | `src/mcp/job-contracts.ts:48` (`Job.ticket`), `src/roles/job-archive.ts:29-35` (`JobFacts`), `src/collectors/project-board.ts:55-62` (`ProjectTicket`), `src/collectors/home-portfolio.ts:8` (`HomeProject.snapshot`) |
| Finished / failed by role | `cohort` jobs: `role` and `state` | `job-stats.ts:109`, `src/mcp/job-contracts.ts:106` (`JobStatus.state`), `job-archive.ts:29-35` |
| Gates | `JobLand.reruns` and `.repairs` per landed job; first time = both 0 | `job-land.ts:56-69` (`jobLand`), `src/mcp/land-state.ts:27-28` |
| Role icons, inks | `ROLE_GLYPHS`, `roleInk` | `src/render/model-glyphs.ts:23-31`, `src/render/work-job-row.ts:55` |

Definitions the build needs to keep:

- **Finished** = `closed`, `done` or `idle_grace`; **failed** = `failed` or a non-zero dispatch exit. `stopped` is *not* a failure (spec §2.1: an intentional stop stays a stop), unlike
  `collectJobStats().failures` (`job-stats.ts:118`), which includes it. The cohort is keyed by when a job entered the window; the build may prefer `settled_at`/`ended_at`.
- **Gates** count landed tickets only: 5 first-time and 2 retried = 7 landed. A land that failed its gate and was repaired counts once, as retried.
- A landing with no ticket (a general job's land) shows the worker's declared `summary`; a read that fails (`coverage.skipped`, an unreadable `flows/`) leaves the card **absent**,
  and a bound that limits the count (`coverage.limited`) is named in the header. Today is pure counting over bounded reads (2000 jobs, 4096 flows, the current and previous
  month's archive); it runs on the collection tick, cached like Control's, never in paint.
- Not on the card, on purpose: tokens and cost, durations, per-model figures, trends, "yesterday". Those are toktrack's. Objective results stay on their project's block (3 days, per the portfolio design).

## 4. Schedule (日程)

### Items and stages

An item is a date, a one-line text written in the panel language (shown as recorded: no display-side translation, spec §2.2), optionally a project and an Objective.
The date is `YYYY-MM-DD` or a month `YYYY-MM` (**due on its last day**, shown `12-??`): "next month" is the owner's real case, and a day can be added later.

| Stage | Rule | Mark / ink | Countdown (zh / en) |
| --- | --- | --- | --- |
| far | more than 7 days; a month item before its month | `◷` muted, whole row muted | `8天后` `3周后` `下月` `2月后` / `in 8d` `in 3w` `next mo` |
| soon | 1 to 7 days; a month item during its month | `◷` normal | `3天后` `明天` `本月` / `in 3d` `tomorrow` `this mo` |
| today | the due date | `◉` blue (the panel's *active*) | `今天` / `today` |
| overdue | past the due date, or after the end of a month item's month | `!` amber (the only amber) | `逾期 2天` `逾期 2周` / `2d late` `2w late` |

- **Sorted** by due date, so overdue items come first (oldest first). Four rows at most, three when compact; due items are never counted against the cap, and at least one later item stays visible.
- **Date arithmetic is calendar days in local time** (`今天` at local midnight), so the card is stable across paint and pure in `nowMs`.
- **Quiet projects**: a registered, available project with no running job whose Home age (`homeActivityAt`, `src/collectors/home-portfolio.ts:17-21`, the same value Home draws and sorts by)
  is over 14 days and whose stance is `active` or not recorded. Paused and maintenance projects are skipped: the owner already said they are quiet (question 2). Home's header
  shows the same age; the dim line gathers the projects so a forgotten one is noticed without scanning the list. `lantern-relay-service` (maintenance, 5 weeks) and `quill` (paused) are not listed.

### How a due item becomes visible without becoming a request

Excerpts in the sample (`#life`): one item at 8 days before, 3 days before, the day, 2 days late and after `done`. The item only changes **its own** presentation:

1. **Its row**: far is muted, soon is normal, today is blue, overdue is amber and sorts first.
2. **A context row** under a due item with a project (`harbor-api › rate-limits`), where to look; below 80 columns only.
3. **A fold floor**: a due item is the last thing the cards fold away: down to one `日程 ──── 逾期 1 · 今天 1` row (section 6). A request is not involved.
4. **A tab badge**: `首页 ?1 ◉2`. `?N` is owner requests (unchanged); the calendar mark and its number count items due today or overdue (amber when any is overdue, else blue). It is a
   different mark, not summed into `?N` or the bar's owner count, so a held request and a due date cannot be mistaken for each other (question 1).
5. **Main can read it**: `hud_schedule list` returns open items with `due` flags, so a session can tell the owner. If the decision is the owner's, **main records a request** with
   `hud_objective request`: only then does it exist in Waiting. The item stays until someone says `done`.

Time alone never clears, moves or converts an item. Nothing is written when a date passes.

| | Request (unchanged) | Schedule item |
| --- | --- | --- |
| Says | someone waits for the owner | something happens on a date |
| Written by | main, `hud_objective request`, into the project's STATE | main, `hud_schedule add`, into the owner's HUD home |
| Shown | top of Home and Project, `?N` badge, bar owner count | bottom card of Home, calendar tab badge |
| Cleared by | `resolve` | `done` |

## 5. Storage and writing (proposal, not built)

**Where**: `$HUD_HOME/schedule.json`, private (`writeJsonPrivate`: temp file, `0600`, rename; `src/utils/atomic-fs.ts:44`), one file, one writer.

```json
{ "version": 1, "seq": 9, "items": [
  { "id": "s7", "date": "2026-12", "text": "sonic 模型到期 → 换 openai gpt-6-luna (pi)", "created_at": "2026-11-24T14:03:00Z" },
  { "id": "s8", "date": "2026-12-01", "text": "删除 tokenizer 旧缓存备份", "project": "/work/tide-lab", "created_at": "2026-11-24T14:05:00Z" },
  { "id": "s9", "date": "2026-11-24", "text": "与团队过限流方案", "project": "/work/harbor-api", "objective": "rate-limits",
    "created_at": "2026-11-20T09:00:00Z", "done_at": "2026-11-24T13:10:00Z" } ] }
```

| Field | Meaning |
| --- | --- |
| `id` | `s` + `seq`, never reused |
| `date` | `YYYY-MM-DD` or `YYYY-MM` (the owner's local calendar); required: an item with no date is a ticket or a request, not a schedule item |
| `text` | one line, at most 160 characters, in the panel language |
| `project` | optional registered root, as receipts store it (`events/*.jsonl` `project`); an item whose project is later unregistered keeps its text and shows without the project |
| `objective` | optional, an existing Objective id of that project, checked at write time only |
| `created_at`, `done_at` | `done_at` set by `done`; the card shows only items with no `done_at` |

**Bounds** (required for new HUD-home state): at most 200 open items (`add` fails with a message past that); done items are dropped 30 days after `done_at`; reads are capped at 64 KiB.
**Why not per-project `.hud/`?** The repository is public and `.hud/objectives.md` is the project's committed record: an owner's private dates ("delete that backup", "renew my machine's certificate") do not belong in git history.
A machine-level item (the sonic model expiry) has no project at all. Unregistering or deleting a project must not delete the owner's calendar, and one file is one reader and one writer. A deadline
the *project* needs on the record ("ship by 12-15") is an Objective fact and would be a `Due` field on the Objective; that is a second reader and out of scope until the owner asks.
A schedule item may **link** to an Objective; the Objective record never gets a date, so each fact is recorded once.

**MCP op**: a small sibling, `hud_schedule`, not a fifth op on `hud_objective`. `hud_objective` is scoped to one registered project (`src/mcp/local-objectives.ts:228-232`,
`src/roles/tool-definitions.ts:169-187`) and its schema is already wide; schedule items are machine-level and mostly projectless. The MCP owns the protocol, so the tool description carries the rules:

| `op` | Fields | Effect |
| --- | --- | --- |
| `add` | `date`, `text`, optional `project` (a registered project dir), `objective` | appends an item, returns it with its `id` and the countdown |
| `done` | `id`, optional `note` | sets `done_at`; the card drops the item at the next collection |
| `move` | `id`, `date` | reschedules (an overdue item moved into the future is a normal move) |
| `list` | optional `due: true` | open items sorted, each with `stage` (far, soon, today, overdue), so main can answer "what is on my schedule" and notice due items |

The owner says it to any main session ("12-01 提醒我删 tokenizer 旧缓存", "下个月 sonic 过期，换 openai gpt-6-luna 用 pi"), main calls `add` (`2026-12-01`; `2026-12`), and resolving it ("删好了") is `done`.
Writes take an abstract lock (`withAbstractLock('schedule', home, …)`, as `local-objectives.ts:231`) and run in the MCP process, so the panel never writes: **the panel is read-only for the schedule**
(no Enter-to-done), consistent with "the owner answers in the responsible main session". No receipts: it is the owner's calendar, not project evidence for toktrack. Whether `hud_roster` echoes a due
count so a fresh session notices is a one-line build decision, not part of this sample.

## 6. Fold order

The cards use only the spare rows: `H − 2 − (rows of the full-tier project list)`. They fold before blank separators, results, extra Objective rows or any project block shrink (the
portfolio's pressure order starts after they are gone). Measured rows at 40 columns zh, the sample's Home of 22 rows (80 columns: 17 / 10 / 3 / 1):

| Level | Today | Schedule | Rows (busy day / quiet day) | Smallest panel (busy / quiet) |
| --- | --- | --- | --- | --- |
| 0 full | header, 3 landings, `另 N 个`, finished, failed, gates | header, up to 4 items, context rows under due items, `另 N 项`, quiet line | 18 / 9 | 42 / 33 |
| 1 compact | header and fact rows | header and 3 items | 10 / 8 | 34 / 32 |
| 2 one row each | `今天 ── 7 个落地 · 完成 15 · 失败 1` | `日程 ── 逾期 1 · 今天 1` (due), else `3 项 · 下一项 7天后` | 3 / 3 | 27 / 27 |
| 3 due only | gone | the one row above, only if something is due, no separator | 1 / 0 | 25 / none |
| 4 gone | | | 0 | 24: the tab badge still carries a due item |

What goes at each step, in order: the landing rows and `另 N 个`; the context rows, `另 N 项` and the quiet line (the quiet line repeats ages Home already shows); the fact rows and the later items
(each card becomes its header with a summary); Today; Schedule when nothing is due. Within a level the failures and the due items are the last to fold: a `Today` row drops its landing count
before its failure count, and a due item is never counted against the item cap. Below the smallest height the portfolio design's own tiers apply unchanged.

## 7. What the build needs

- `todayFacts` (cached `collectJobStats` over today, joined to the Home snapshots) and `readSchedule` (stat-cached `schedule.json`) on the collection tick; `homeRows` takes the free row count it already
  needs for the portfolio tiers and picks the card level. Rendering stays pure: `nowMs` only.
- Navigation ids: `home:card:today` (a landing row opens that project), `home:card:schedule:<id>` (a linked item opens its project; an unlinked one only selects). Mouse and keyboard as other Home rows.
- Strings: about 20 EN/ZH entries (`今天`, `日程`, `{n} 个落地`, `一次过`, `重试`, `静默`, the countdowns, `另 {n} 项`). Fallback marks above.
- `hud_schedule` in `src/roles/tool-definitions.ts` and `operations.ts`, a store module of about 120 lines, the reference entry (`docs/reference.md`, then `reference.zh.md` at the milestone pass).
  No new outbound model input, so ARCHITECTURE §5 is unchanged. Size: about 200 lines of card rendering and 120 of store, plus tests for both.

## 8. Questions for the owner (recommendation first)

1. **Tab badge for due items.** `首页 ?1 ◉2`: a calendar mark with the count of items due today or overdue, not summed into `?N` or the bar's owner count; the Schedule row alone would be hidden on
   a short panel or another tab. *Recommend: yes.* Alternative: no badge; the due row is then the only signal (and gone below 25 rows).
2. **Does the quiet line skip paused and maintenance projects?** *Recommend: skip them* (stance is the owner's own "I know"; a standing line about parked projects is noise). Alternative: list every
   project over 14 days quiet with its stance word.
3. **Does the gate line (`一次过 5 · 重试 2`) stay in Today?** It is the one fact that leans toward analytics. *Recommend: keep*, today only, no history or rate; a trend of retries belongs in toktrack.
   Alternative: drop the row; a retried land stays visible as the repair it caused.

## 9. Decided without asking, and limits

- Reversible choices taken: section-header cards, not boxes; the date shows as `MM-DD` / `MM-??`; four item rows, three landings; `stopped` is not a failure; `done` removes an item (done items kept 30 days);
  items cut to one row, never wrapped; the panel does not edit the schedule; schedule text is shown as recorded.
- The Proposed Home frames are composed from helpers, not the product renderer; the Unicode and text icon sets are described, not drawn; light themes were not drawn; no cursor, mouse or selection states.
- The frames are synthetic: Today's numbers come from the shipped `collectJobStats` over made-up records; the schedule is a made-up `schedule.json`; no real project, path or text appears in any file here.
