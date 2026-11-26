# Execution workflow as a metro map (design sample)

Design only: no product code, no tests. Decision D-2026-11-26-09, `docs/design/tab-roles/README.md` §3a. Open
[`sample.html`](./sample.html) (self-contained, offline, synthetic data; an inline script lays out every frame, so the
same rules produce each variant, width, language and mode). `?only=s2,s7` shows chosen sections (`s1`–`s7`,
`nocolour`, `ascii`, `english`). Three variants sit side by side from about 1660 px; narrower windows wrap.

| Section | Scenario |
| --- | --- |
| `s1` | queue, three tickets in parallel: working, asking, lease wait |
| `s2` | failed gate with its repair round, another gate running |
| `s3` | a station held for the owner |
| `s4` | batch pool |
| `s5` | council |
| `s6` | 16 stations, folded |
| `s7` | two flows under 工作流, with the legend |
| `nocolour`, `ascii` | variant A in theme `none` and in icon set `text` |
| `english` | EN, no cursor, five council members, the full legend |

## Recommendation: A · Trunk

```text
  ◉  队列  retry-queue                          运行中 1时12分
            ┏━━━━━◉─────╮
  ●━━━━━━━●━╋━━━━━?─────┼─○───────◇───────☆
            ┗━━━━━◷─────╯
  ? 04 退避参数放哪里                             ⚒ 提问中 6分
```

- Progress reads from shape before colour: the travelled part is heavy and square, the part ahead thin, dim and
  rounded. The same holds with colour off.
- A solid bold line in the flow's own colour is the clearest "transit map" look a cell grid gives, and ties the header
  pill to its map when two flows are stacked.
- Ordinary box drawing only: present in all four fonts checked, drawn edge to edge by terminals with built-in glyphs.
- Only what needs the owner is filled (`?` `!` on the ask colour); a failure is red ink; the rest is line and mark.

Cost: junctions are 90°, not 45°. Heavy weight differs a little between terminals.

**B · Braille 45°** is the closest to schematic-map routing (real 45° branches, round-looking merges) and worth a look in
the owner's terminal. Not recommended: the line is a row of dots rather than a flat bar, the part ahead is very faint,
DejaVu Sans Mono and Consolas have no braille, and it needs a second renderer (a dot canvas) plus A's for ASCII.

**C · Hairline** is the calmest, but it is the rejected draft's weight again: flows look alike when stacked, and the
solid/dashed difference is weak at 1 px.

**Half-block ribbons** (`▀▄` plus quadrants) were left out, by geometry rather than a render: a half block sits in the
upper or lower half of its cell while a station mark sits in the middle, so with one row per lane the two cannot line
up, and full-height station tiles would fuse vertically across parallel lanes.

## Variants: how each maps to cells

| | A · Trunk | B · Braille 45° | C · Hairline |
| --- | --- | --- | --- |
| Travelled | heavy box `━┃┏┓┗┛┳┻╋`, flow colour | braille, 2 dots thick on dot rows 2–3, flow colour | light `─│╭╮╰╯`, `muted` |
| Ahead | light `─│┬┴┼`, corners `╭╮╰╯`, `frame` | 1 dot in 2, `frame` | `╌╎`, light corners, `frame` |
| Split / merge | one junction cell per lane; arm weight picks the glyph | ramp of 4 dots across per lane step (2 cells); gap ≥ 4 | as A, one weight |
| Colour | one per flow | one per flow | one neutral; colour only for state |
| Done station, passed gate step | flow colour | flow colour | `text` |
| Header | pill: kind word on the flow colour | swatch `⠶⠶` and kind word in the flow colour | kind word, `muted` |
| Repair line | `stalled` | `stalled` | `stalled` |
| No colour | heavy against light | thick against sparse | solid against dashed |

A and C: each cell records which of its four arms are used and by which lines; the weights index the 80 light/heavy
glyphs of U+2500–U+257F (all combinations exist), with the arcs for all-light corners. B: lines are set on a 2×4 dot
grid per cell and each non-empty cell is one code point U+2800 + bits; stations overwrite their cells.

An arm (A, C) or dot (B) is **travelled** only when every line over it leaves a finished station. So a split lights as
soon as its source is done, and the shared stretch of a merge lights only when all its sources are.

## Glyphs (all variants)

| Meaning | Unicode | Code (East Asian width) | ASCII | Ink (`theme.board`) |
| --- | --- | --- | --- | --- |
| Worker: not started / working / done | `○ ◉ ●` | 25CB A · 25C9 N · 25CF A | `o @ +` | `muted` / `active` / line |
| Review: not started / working / done | `◇ ◈ ◆` | 25C7, 25C8, 25C6 A | `r R +` | as above |
| Acceptance, synthesis | `☆ ✪ ★` | 2606 A · 272A N · 2605 A | `a A +` | as above |
| Waiting for an answer | `?` | ASCII | `?` | `askTitle` (filled) |
| Held for the owner | `!` | ASCII | `!` | `askTitle` (filled) |
| Failed | `✗` | 2717 N | `x` | `danger` |
| Lease wait | `◷` | 25F7 N | `~` | `text` |
| Stalled | `◍` | 25CD N | `z` | `stalled` |
| Stopped, skipped | `⊘` | 2298 N | `/` | `muted` |
| Unknown | `◌` | 25CC N | `u` | `muted` |
| Land gate, step k of n | `‹▮◉▯›` | ‹› 2039/203A N · ▮▯ 25AE/25AF N | `{#@.}` | passed line, running `opinion`, failed `danger`, pending `muted` |
| Repair round | own line; `↻` before the station without colour | 21BB N | `%` | `stalled` |
| Batch pool | `▐●×22 ◉×7 ✗×1 ○×10▌` | ▐ 2590 N · ▌ 258C A · × A | `(+22 @7 x1 o10)` | `title` surface, marks in their ink; no colour `(…)` |
| Folded stations | `●×7` `○×4` | | `+7` `o4` | line / `muted` |
| Cursor | surface behind station and both neighbours (pool: the pill) | | `>@<` | `selected`; no colour `▸◉◂` (25B8/25C2 N) |

Width safety:

- No non-ASCII map glyph is East Asian Wide or has the Unicode `Emoji` property (checked with Unicode data), so none can
  turn into a two-cell emoji. That is why review is `◇` and not `⚖` (§3a names `⚖`; it has an emoji form).
- The class A glyphs (`○ ● ◇ ◆ ◈ ☆ ★ ×`, box drawing, `▌`) count one cell in `visualWidth`, and the panel's frames
  already rest on that for box drawing, `○ ★ ◇` and `×`; a terminal set to ambiguous-wide would break them today.
- Fonts (`fc-query`): MesloLGS Nerd Font Mono and DejaVu Sans Mono hold every box-style mark above. Cascadia Mono lacks
  `✗ ↻ ☆ ★ ✪ ⊘` (the terminal substitutes a fallback font, as it must for today's `✗ ↻ ★`). Braille is in Meslo and
  Cascadia only.
- Icon sets `unicode`, `emoji` and `nerd` all draw these map marks; the role icon on the detail line follows the setting.
- `◇` also means 待试用 on the Project tab; the two never share a page.

## Colour tokens

| Token | Default theme value | Use |
| --- | --- | --- |
| `board.lines[0..3]` **(new)** | `#a993f0` `#35c9b9` `#ec83c6` `#9ccfe8` | A and B line colour; a flow takes its creation-order index mod 4 |
| `board.frame` | `#3b4556` | line ahead |
| `board.muted` | `#9aa5b8` | not started, pending gate step, unlit gate bracket, ages, legend words |
| `board.active` | `#6fa8ff` | working |
| `board.opinion` | `#52c7f0` | running gate step |
| `board.askTitle` | `#ffc13a` under `#19150d` | `?` and `!` |
| `board.attention` | `#efc15a` | asking/held words on the detail line, paused run glyph |
| `board.danger` | `#f4727e` | `✗`, failed detail words |
| `board.stalled` | `#f29958` | stalled, repair line |
| `board.selected` / `board.title` | `#303a4b` / `#1e2531` | cursor / pool pill |

The four line inks stay apart from `attention`, `danger`, `active`, `stalled` and `success`; done is the line colour, so
green does not appear on the map. Only the default theme's inks are chosen and rendered; the other themes need their own
four under the same rule (mocha, for example: mauve, teal, pink, sky). Theme `none` is identity for all of them and the
header pill becomes the bare word.

## Row budget

| Part | Rows |
| --- | --- |
| 工作流 header | 1, once |
| Flow header | 1 |
| Map | 1–3: the widest wave, plus a repair line while it fits in 3 |
| Detail line | 1 |
| Legend | 0–2, once, under the last flow |

So a flow is 2–4 rows plus its detail line: batch 3 rows in all, a two-branch queue 4, three branches 5. The `s7`
frame (two flows and the legend) is 12.

## Layout rules (shared)

1. **Columns** are dependency depth; **lanes** at most 3. The trunk is the middle lane (the top one of two). A station
   keeps its only parent's lane, merges go to the trunk, and a station with a repair round sits lowest.
2. **More than three side by side:** the two most urgent keep a lane; the others share one counted station.
3. **Fit**, first that works: gap 7 → 4; then fold the settled prefix into `●×K`; then keep one not-started wave and
   fold the rest into `○×M`; then fold them all; then drop the gate brackets and go to gap 3 (B stays at 4). Working,
   asking, held, failed, gate, review and acceptance stations never fold for width (only rule 2 counts them). The map
   starts at column 3 and is not stretched to the right edge.
4. **Gate:** while a ticket lands, its station is the gate, one cell per gate command (over 5: scaled to 5). Waiting for
   the lease, before the gate, is the single `◷`.
5. **Repair:** the line leaves before the failed gate and returns after it, on a free neighbouring lane (below, else
   above). With none free it follows the gate on the same lane, still in the repair colour (`↻` without colour). A
   second round is a second station on that line (not drawn in the sample).
6. **Header:** run glyph, kind, name, state word and elapsed. No flow id. When the name does not fit, the state word
   leaves first (the glyph says it; a pause keeps its word and drops elapsed), then the name is cut.
7. **Detail line:** mark, number and title; role icon, state word, elapsed (`←03,04` on a blocked station). The role
   icon, then the blockers, leave before the title is cut; elapsed leaves only when the title would fall under 12 cells.
   With no cursor on the map it shows the station that changed last. The panel has one cursor, so in a stack the other
   flows show their last change.
8. **Legend:** only the marks on screen that do not explain themselves, most urgent first, at most 2 rows, dropping from
   the end. `○ ◉ ●` are listed only in the `?` help, except in ASCII.

## ASCII mode (icon set `text`)

| | Unicode (A) | ASCII |
| --- | --- | --- |
| Travelled / ahead, horizontal | `━` / `─` | `=` / `-` |
| Travelled / ahead, vertical | `┃` / `│` | `\|` / `:` |
| Corner or tee turning down / up | box glyphs | `.` / `'`; through junction `\|` |
| Marks, gate, pool, folds, cursor, repair | table above | table above |
| Section rule, blockers | `─`, `←` | `-`, `<-` |

`×` disappears from pool and fold counts, because `x` means failed. ZH words are unchanged. Variants B and C fall back to
the same ASCII.

## No colour (theme `none`)

No escapes at all: heavy against light carries travelled/ahead; `▸ ◂` replace the cursor surface; `↻` marks a repair
line; the pool and filled marks lose their surfaces and keep their glyphs.

## How the sample was checked

All 67 frames render, and every row measures exactly 62 or 40 columns with the panel's own `visualLength`. A sweep of
each scenario flow (and a no-free-lane repair) at 40–80 columns × 3 variants × colour / none / ASCII × ZH / EN, 6642
renders, kept every row exact and every single flow within 5 rows. Looked at in headless Chrome with MesloLGS. Not
tried in the owner's terminal. The check scripts are not committed.

## What the build needs (open points)

1. **Edges for started tickets.** `TicketQueueItem` records no blockers (`src/mcp/ticket-queue-state.ts`); only the
   run's `queued` and `blocked` entries do. The collector needs every ticket's dependencies (from the ticket store, or
   kept on the run record), or branches that already started cannot be drawn.
2. **Keys.** §3a gives `←/→` to stations, but on the main view they switch tabs (`src/render/workboard-input.ts`).
   Suggested: they move stations while the cursor is on a map; Tab and Shift-Tab always switch tabs. `↑/↓` moves across
   lanes, then leaves the map.
3. **Several targets per row.** Rows carry one item today; the map needs a per-station cursor and per-cell mouse hits.
4. **"Changed last"** needs a change time per station. A ticket's `since` is its worker's start or its gate step's
   start (`projectTicketItem`); it does not say when the ticket landed, failed or was held.
5. **Gate steps:** `LandProgress` gives index and total; passed steps are those before the index.
6. **Graphs the lanes cannot hold.** The sample draws chains, fan-out and fan-in (every scenario here). A dependency that
   skips a column, or two that cross, cannot be drawn exactly in three lanes. Suggested: merge them at a shared junction
   (the order stays right) and let the detail line name the blockers. `graph.json` runs and large queues need this
   settled and tested; so do scouting prewalk flows, which have no sample frame (they map like a council).
7. **§3a** should be updated when a variant is picked: gate and review glyphs, folding of not-started waves, the legend.
