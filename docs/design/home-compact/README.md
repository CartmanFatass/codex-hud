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
