# Home Compact Redesign (design sample)

Owner (2026-11-22): sonic is secondary information and must not take the visual space it takes now; show it only on its worker as an icon plus a number; Home shows the important information prominently and packs the unimportant through combinations of icons, numbers, abbreviations and colour.

Open `sample.html` in any browser (static HTML, zero JavaScript, zero network requests, synthetic `harbor-api` data only). It renders **48 cell-exact frames**: Current Home beside the Redesign in Classic and Split layouts, Busy and Quiet scenarios, 中文 and English, at **120, 80, and 50 columns**. Every frame row is verified at generation time to be `visualLength === width`.

## Row audit: Home today vs Redesign (Busy, 80 × 34)

Running the current panel against a synthetic `HUD_HOME` with 6 main workers (1 asking, 1 failed, 1 unread report with active land flow, 2 routine running, 1 settled read), 5 sonic children (4 running, 1 done), 1 STATE waiting item, 2 to-try slices and milestone `0.4.0` progress:

| Section | Current Classic | Redesign Classic | Notes |
| --- | --- | --- | --- |
| Top status & worker roster | 2 rows (`? 2 waiting · 7 running`, inflates with sonic) | 2 rows (`? 2 waiting · ✗1` + Variant A roster `▲ neon◕ 1 ✗  ◎ sol-fast◕ 3 ?  ✻ sonnet● 1 ✓●  ⚡4`) | True counts + bar-aligned worker summary |
| Open question (`CACHE-V2`) | 4-row slab + **4 duplicate lane/card/sonic rows** | 4-row slab (`◎ sol-fast◕ ⚡1` on header), **0 duplicates** | Saves 4 rows; Enter / `1-4` / `d` stay on slab |
| Failed job (`EXPORT-CSV`) | 3 rows (folded at 9m, **hides error reason**) | 3 rows (lane + red card + `┃ HTTP 429…` unfolded) | Unhandled failure keeps its reason until observed/superseded |
| Unread report + land flow | 4 rows (`✓` indistinguishable from read) | 4 rows (`✓●` unread mark, `✻ sonnet● land 2m`, flow + summary) | Unread report and active land flow stand out |
| Routine running workers (2×) | **6 rows** (2 titles + **4 empty `┃ …`/`┃` pipes**) | **2 rows** (1 dense row each: `◉ imp … ◎ sol-fast◕ ⚡2 14m`) | Saves 4 rows; Enter expands sentence, milestone and activity |
| Sonic children (5×) | **5 branch rows** + **4 hijacked headers** + Split `sonic 3m` takeover | **0 rows** (`⚡1` / `⚡2` on parent worker, `⚡4` in top roster) | Zero sonic rows or cards anywhere on Home |
| Read / settled worker | 2 rows | 1 compact row (`✓ general … ▲ neon◕ 8m`) | Recedes cleanly |
| Blank separators | 6 blank rows | 1 blank row | No blank row between every lane |
| **Waiting / Latest / Progress** | **0 rows visible** (pushed off-screen) | **15 rows visible on screen** | Owner sees Waiting, To-try, milestone bar and Tickets immediately |

## Important vs Secondary

- **Important (prominent surfaces & detail rows):** open questions (amber Ask Slab, no duplicate below), unhandled failures (red reason row, never auto-folded at 5m), unread reports (`✓●` + concise summary), active land/scout flows (`◉ gate ▸ merge`), stalled jobs, STATE Waiting, To-try slices and milestone Progress.
- **Secondary (packed inline with icons, numbers, abbreviations & colour):** sonic children (`⚡N` on parent only, ASCII `*N`), routine running workers (single dense row until Enter expands; no empty `┃ …` or `┃` placeholders), timings (`14m`/`14分`), model/effort detail (`◎ sol-fast◕` → `◎◕` → `◎`), read settled workers.

## Shared marks & Variant A alignment

- **Worker summary:** matches `docs/design/statusline-workers/sample.html` Variant A (`provider mark`, short model name from catalog, `EFFORT_GLYPHS`, bold count, state marks `?` / `✗` / `✓●` / `✓`) plus `⚡N` for active sonic, narrowing in the same order (drop model name → drop effort glyph → compact `◉N ⚡M`).
- **Marks:** provider glyphs from `src/render/providers.ts`, effort glyphs from `EFFORT_GLYPHS` (`src/render/model-glyphs.ts`), unread `✓●`, sonic `⚡N`, and board theme roles (`theme.board`) with zero raw ANSI escapes in `none` mode.

## v2: one line per job (ticket `home-compact/02`)

`sample.html` also has a `#v2` section: the shipped compact Home beside **v2** for one synthetic busy run (14 jobs: 1 asking, 1 failed, 3 landing, 4 running, 3 queued, 2 finished) at 120, 80 and 50 columns in 中文 and English (12 more frames, every row checked to be exactly the panel width). "Current" is `homeRows()` from `dist/` over the same fixture; v2 is composed from helpers the renderer already exports. The dashed red line marks the bottom of a 34-row terminal.

| 80 columns | Current | v2 |
| --- | --- | --- |
| Job area (`homeRows`: summary row, blank, Ask Slab, lanes) | 38 rows | 21 rows |
| Lane rows only (no summary, blank or Ask Slab) | 32 rows | 15 rows |
| Whole frame (tab row, job area, Waiting / Latest / Progress / footer) | 51 rows | 34 rows |

- One row per job: state glyph (fixed two-cell column), ticket id, ticket title, then role icon (`ROLE_GLYPHS`), model mark, `⚡N` and age on the right. A lane header only when a lane holds more than one job.
- Landing: one sub-row (`land · gate[3] test:mjs · 1m`); the report sentence leaves Home. Failed keeps its card; asking keeps the Ask Slab. Queued jobs fold into one `◷ queued N · ids` row, read finished jobs into one `✓ done N · ids` row; Enter opens a fold.
- The build needs a short ticket title on `OwnerWorker` (ticket file heading, else `briefTitle`), the report sentence in the Inspector, and two Chinese words (`排队 {n}`, `完成 {n}`).
- **Built (ticket `home-compact/02`).** Classic Home renders v2 (`src/render/work-jobs.ts`; the job rows of all six Classic frames match this sample cell for cell, checked against the fixture in `tests/fixtures/home-jobs.mjs`). Split's list row gets the role icon and the same two folds; the sample has no Split frames. The Inspector already shows the report sentence (its card opens in full), so nothing was added there. Model outcome labels (`[partial]`), `⚠ looping` and the checks chip stay on the job row's right, before the age.

## Route marks and a headless job's output (ticket `auto-route/04`)

A job's route is secondary information, so it follows the same grammar as the model and sonic marks: one icon each, in the muted ink, on the right of the job row between the model mark and `⚡N`.

| Mark | Meaning | ASCII |
| --- | --- | --- |
| `▂` `▄` `▆` | Tier light, standard, hard: a bar that grows with the tier (only a routed job has one) | `-` `=` `#` |
| `∅` | Headless: the job has no herdr tab | `h` |

Examples: `⚒ ◎ sol-fast◕ ▂∅ ⚡2 6m` (light, headless), `◈ ✻ opus● ∅ 21m` (headless, not routed), `⚒ ◎ sol-fast◕ ▆ 14m` (hard, tab). A tab job has no mode mark: its absence is the tab. The two marks are 1 cell each, never narrow with the model mark, and only the title is cut when the row is short (checked at 120, 80 and 50 columns, EN and ZH). They appear on Classic job rows, on Split list rows (the lane's top job) and on the Inspector's card header. The reason is the Inspector's `Route: light · headless — <reason>` row (the chosen tier's and mode's `use` texts); the Home row carries no words.

A headless job has no tab, so `g` on its card opens the Inspector (footer `g output`, `g 输出`), whose `Output` section follows the job's `stdout.jsonl`: one row per tool call (`▸ read src/a.ts`), assistant text line or error (`✗ bash failed`), the newest 12, labelled `live` while the job runs and `No output yet` before it writes. The section sits under the card and above the facts, so it is on screen when the Inspector opens. `X` stops the job as for any other.
