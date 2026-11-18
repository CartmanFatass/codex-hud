# Panel v8: Home and Project options (design notes)

Owner, 2026-11-17: "Home carries too much information and feels bloated; the Project page's UX is poor." This round is design only: three rendered options in `options.html`; the owner picks one and a later job builds it. Nothing under `src/`, `bin/`, `packages/` or `tests/` changed, and every frame is synthetic (one invented project, `harbor-api`).

Open `options.html` first: a `Today` reference, then one section per option with Home (busy, idle, busy at 40 × 24) and Project (hub, Progress, one more page), each frame with two or three lines on what it answers first and why. Dark (the default `terminal` board) and light (`latte`) follow the system, or the switch at the top; the switch is plain CSS, the page has no script, font or network use. Every row is asserted to be exactly 40 cells when the page is built: `node docs/design/panel-v8/gen/gen.mjs`.

## What is wrong today

Measured on the same invented data, in `Today (reference)` (redrawn from `work-card.ts`, `work-lanes.ts`, `home-view.ts`, `project-view.ts`; not a screenshot of the real panel):

- **Home busy fills 46 of 47 rows.** Seven cards (three rows each, a title and two sentence rows with `┃ …` holding space; one is folded to a row) and a pointer card are 20 rows; four lane headers and the blanks around them are 8 more, and the headers repeat what the card titles say; the asking job appears twice (the slab, five rows, and the pointer card). The progress block is left a four-row sliver, and **Waiting, Latest and tickets never reach the screen**: while the panel is busy the owner sees only a count of what they owe.
- **Project asks for the same thing four times.** Waiting, Now, Latest and the page rows share one look; the to-try slices are in Waiting, again in Latest, again in Progress → History, and `y` / `n` work only inside the `Only to try` filter (`t`). Every page is Enter, read, Esc, and Progress is five headed blocks.

## The three options

| | 1 · Inbox | 2 · Split | 3 · Timeline |
|---|---|---|---|
| Axis | need: one list ranked by how much each thing needs you | cursor: a list above, a preview of the cursor row below | time: what is live, then everything that happened in order |
| Home busy (today 46 / 47 rows) | 35 | 25 | 32 |
| Home idle | 25 | 16 | 22 |
| Project hub (today 24) | 25 | 28 | 34 |
| Home keeps | lanes: no (job rows, package in the title) | lanes: yes, as list rows | lanes: no (Now + feed) |
| Project keeps | hub and pages (drill-in) | hub and pages, each a list over a preview | one page with folds |
| Spec text it changes | lanes, top line, cards-win rule, Home tickets | Home as one scrolling page, hub's Now / Latest, healthy roles folded | lanes, pages as separate pages, stacked bar |
| Build size (my estimate) | smallest | largest | middle |

Common to all three, and unchanged: the tab row, `Project` badge, `models on`, the footer's `✓ n done today`, the question slab's look (amber header, the slab body), `y` / `n` meaning, `[ ]` project switching, Esc and the mouse rules (click selects, second click is Enter, wheel scrolls) unless an option says otherwise. Not drawn in any option: the Recommended mode's brief paragraph (it sits where the progress summary sits in 1 and 3, and is the preview of the Progress row in 2), Chinese strings, the Inspector, Settings and Help.

## Option 1 · Inbox

**Idea.** One list, ranked by need: question, failure, a stalled job, a report ready, then running. A job is one row, plus one sentence row only while it runs or when it went wrong. The package is the first word of the job's own title, so lanes are not a structure any more. Project opens on what the owner owes, acts on it in place, then shows what moves.

**Moves**
- Package lane → the title prefix; jobs are ranked across packages (`orderedLanes`' rank becomes the list order).
- STATE's waiting items: from the spare rows → one row above Jobs (busy: a count, Enter lists them; idle: all of them, as today's idle Home).
- Counts: from the top line → the section headers (`Waiting for you  3 · 2 to try`, `Jobs  3 running · 1 failed`).
- Project hub: the to-try slices move from Latest and from Progress's `Only to try` filter into `Waiting for you`, where `y` accepts and `n` flags (STATE's `Try …` items and the ledger's to-try slices are shown once). Latest then lists accepted slices only.
- Progress page: `To try` moves above `Now`. Page rows on the hub lead with a mark, amber where the page needs the owner; the Progress bar moves from under its row into it.

**Folded or merged**
- The asking job's pointer card merges into the slab.
- A card is its title row plus at most one sentence row (was a fixed three rows).
- Ordinary decisions fold into `▸ N as proposed`; a departure (`◆ worth a look`) keeps its row.
- The progress block is a header, one summary row, the bar and one counts row.
- Hub `Now` is renamed `In flight`; same content.

**Removed (user-visible), with the §2.2 sentence it touches**
1. The top line `? N waiting for you · M running` / `✓ Nothing needs you`: "Home's top line counts STATE's waiting items with the job questions" (2026-11-17). The counts stay, in the two headers; Enter on the waiting row opens the Project hub's Waiting block as the top line does.
2. The lane header row (package, phase, the job-glyph strip): "the package lanes with their job cards", "the panel groups jobs by it into lanes". The phase (`review r1 · fixing`) is still in the Inspector (`v`).
3. Open tickets in Home's spare rows: "Home shows a compact copy of the progress board and the open tickets in its spare rows". Tickets stay one row on the Project hub.
4. A busy Home's waiting list and Latest in its spare rows: "cards always win the space" and the 2026-11-17 idle sentence. Busy shows the count; idle shows both, so idle Home is unchanged.
5. The slab's path row (`qa/q3.md  ⏎ expand  o open`) and the `2 options · default: …` summary: not in §2.2. The options themselves are listed (default marked) and the hints move to the footer while the slab is selected.
6. Placeholder body rows (`┃ …`): `docs/reference.md` only.
7. Progress's `Only to try` filter and its key `t`: "on the Progress page's to-try view `y` accepts and `n` flags the selected row" (2026-11-17). The to-try rows are a permanent section, so the filter has nothing left to filter; `y` / `n` now also work on the hub's Waiting rows.

**Spec change needed beyond moving or folding**: yes. Home stops being "package lanes with their job cards" (item 2); "cards always win the space" becomes "the question, a failure, then running jobs, with the waiting count above them". Both are the owner's call.

**Keys and mouse**: `y` / `n` on hub Waiting rows; `t` goes; footers change. Everything else as today.

**At 40 × 24 gives way, in order**: section headers and blank rows, sentences (one kept), the failure's second line, Latest, legend and summary, the native header. Never: the question, the waiting count, the failure, every running job.

**Risks**: a job title that does not start with its package loses its grouping; the fallback is a dim `PKG ›` prefix, costing about 13 of 40 columns. Rank-over-package also means two jobs of one package can be apart. If the owner wants lanes kept, the smaller version of this option keeps a one-row lane header (no blank row between lanes) and everything else here: it costs about four rows in the busy frame.

## Option 2 · Split

**Idea.** A list on top, one preview below it that follows the cursor. Home's list is one row per package and per block (waiting, decided, progress), always the same height; the cards, unchanged, show for the row under the cursor only. Nothing jumps while a job writes a sentence, and what needs the owner is always a row (a question or a failure keeps a reason row in the list; the cursor starts on the first needy row, so the slab is on screen when the panel opens). Project is the same machine: a page list with the cursor page previewed.

**Moves**
- Lane header → a list row (package, phase, the state of the most important job); the job-glyph strip is replaced by that state.
- Question slab, cards, decisions, waiting items, Latest → the preview of the row they belong to.
- Hub `Now` and `Latest` → the Progress row's preview. `Waiting for you` → a list row whose preview lists the items.
- Progress page: Now, To try and the ledger → one ledger list (working, blocked, to try, todo; accepted folded) with the cursor slice explained underneath; History → one folded row that opens the dated feed.
- Control plane: the role list on top, the cursor role's places underneath (where `p m e + - K J x` act).

**Folded or merged**: the pointer card, the top line (the list rows carry the counts), `Now` + `To try` + the ledger (three blocks about the same slices).

**Removed (user-visible), with the §2.2 sentence**
1. The top line: "Home's top line counts STATE's waiting items with the job questions". The `? Waiting for you` row and the tab badges say it.
2. The job-glyph strip on a lane: "the package lanes with their job cards". Lanes stay, as rows.
3. Cards of lanes the cursor is not on: "Home is one page: what needs the owner, then the package lanes with their job cards, then the decisions". Home becomes a list with a preview. Cards that need the owner are never hidden: each has a row with its reason.
4. Hub `Now` and `Latest` above the page rows: "the hub also shows Now … and Latest … above the page rows" (2026-11-14); they show in the Progress preview.
5. Open tickets and the waiting / Latest rows in spare rows: they are rows whose preview shows them.
6. `Only to try` filter and `t`: the to-try slices are list rows under working; `y` / `n` work on any of them.
7. The Control plane's folded `Healthy` row: "healthy roles folded". With five roles one row each is shorter than the fold plus its contents; with many roles it would need the fold back.
8. Progress's `History` block: one folded row that opens the dated feed (a level deeper than today's page: "Progress is a dated feed of the last 7 days"); `Next` stays.

**Spec change needed beyond moving or folding**: yes, a larger one: Home is no longer one page that scrolls. It is a list and a preview (item 3); the 2026-11-14 hub layout loses Now and Latest above the pages (item 4).

**Keys and mouse**: the list takes ↑↓; the preview scrolls with the wheel over it or PgUp / PgDn (new); Enter on a list row moves into its preview, where Enter expands a card as today and Esc returns (a build choice: it could instead open the card's file). Click selects a row, second click is Enter, as today.

**At 40 × 24 gives way**: the preview, from the bottom (it shows the question and the first card and scrolls for the rest). Never: the list; every package, the question and the failure keep their rows.

**Risks**: the largest build (the panel's frame model is one scrolling pane today). A running job's sentence is visible only for the cursor row, so a glance no longer says what each job is doing; the list row's state word is all that is left.

## Option 3 · Timeline

**Idea.** Live things above, history below, history in time order. Home: the question, one row counting what STATE has waiting, what runs now (one row each), then one feed for everything that finished, was decided for you or landed, newest first, an age rail on the left. A sentence appears only where something went wrong. Project is one page that scrolls: the milestones as a map (a row each, a cell per slice, so the shape of the whole history is four rows), Now, Next, the last seven days; the four small pages are folds that open in place.

**Moves**
- Settled cards, `Decided for you` and `Latest` → one feed (the idle Latest list and the decisions block are feed rows; a departure is an amber `◆`).
- Hub's stacked bar, legend and `Latest` → the milestone map and the seven-day feed. Hub `Waiting for you` + `Now` → one `Now` block (owed rows first, then what runs, then blocked).
- Tickets, Working tree, Docs, Control plane: from pages to folds at the foot of the one page; Enter opens a fold in place (the mechanism the Control plane's `Healthy` and `Files` folds use today).
- Progress page: the dated feed behind Enter on `Last 7 days`, with older milestones as folds.

**Folded or merged**: the pointer card, three Home blocks into one feed, two hub blocks into `Now`, five pages into one.

**Removed (user-visible), with the §2.2 sentence**
1. The top line: as in Option 1, item 1 (the waiting count row and the section headers carry it).
2. Lane headers and the native lane's header: "the package lanes", "On Home each main session gets one lane beside the package lanes". Native agents are rows in `Now` (children indented), `this session` appears in a row's tag only.
3. The sentence row of a running card: "the third line of a thin-job card (one sentence on what it is doing now)" (M3b). It shows on Enter; a failure keeps its reason rows.
4. The newest settled card opening by itself: reference.md "Only the newest current settled card initially expands". It is a feed row.
5. `Decided for you` as a block: "then the decisions". They are feed rows (headline only; asked / instead of / why on Enter), keeping the hide rules.
6. Hub: the stacked six-state bar with its legend and "the hub's bar is the current milestone's" are replaced by the map; the state counts (`2 working  1 blocked`) are the cells. "Project is a hub with one summary row per page … and each of those is its own page" becomes one page with folds. The Progress page's `Now` and `Next` blocks are on the hub; "a block per slice in flight with what its job is doing now" shows no sentence.
7. `Only to try` filter and `t`.
8. Open tickets in Home's spare rows, and a busy Home's waiting list: as Option 1, items 3 and 4.

**Spec change needed beyond moving or folding**: yes: lanes (item 2), pages as pages (item 6), the stacked bar (item 6), and the M3b card sentence (item 3).

**Keys and mouse**: `y` / `n` on hub and feed to-try rows; Enter on a fold opens it; `t` goes; no Esc-back on the hub (pages are folds). Everything else as today.

**At 40 × 24 gives way**: the feed from its bottom (`+N older`, `a` shows them), then headers, the failure's reason, the progress sentence and legend. Never: the question, the waiting count, every running job.

**Risks**: a single long page needs the cursor to scroll to what matters (the cursor starts on the first owed row); the map's glyphs are dense and need the legend of marks the panel already has in Help. Three kinds of event in one feed means one grammar must serve a job, a decision and a landing; the frames show it holds at 40 columns.

## Recommendation: Option 1 · Inbox

- It answers the complaint most directly at the smallest cost: the same facts at 11 fewer rows in the busy frame, and the saved rows are left empty on purpose (Home busy is 35 of 47 rows; today's is 46). No new data source and no new layout model: the card, the section and the hub keep their grammar, and the work is flattening lanes, one fold for decisions, the hub's Waiting block taking to-try slices, and a reordered Progress page.
- It keeps the most the owner has already decided: a Home that is one scrolling page, a hub with drill-in pages, each running job still saying what it is doing, the amber question slab first. What it changes is ordering and duplication.
- It is the only option where Project's fix is "stop asking for the same thing four times and let the owner act where they read": acceptance moves to where the to-try rows are listed.
- Its weak spot is real (lanes go, item 2, and the package must be recognisable in a title), and the smaller version above keeps the lane header if the owner prefers.

If the owner wants more change on Project than ordering, take **Option 2's hub and pages** (a list over a preview) as a transplant: it needs nothing from Option 1's Home, which stays a scrolling page.

## Questions for the owner

1. Rank across packages (Option 1) or keep a one-row lane header? This is the one change that touches the owner's own lane decision.
2. May a running job's sentence show only for the cursor row (Option 2) or only on Enter (Option 3)? Option 1 keeps one sentence row per running job.
3. On a busy Home, is a count row enough for STATE's waiting items (Options 1 and 3), or should the first two be listed?
4. Should `y` / `n` work on the hub's rows, not only on the Progress page?
5. The hub is 24 rows today and 25 / 28 / 34 here. If the panel is usually shorter, which block goes first?

## Assumptions

- The frames are 40 columns wide; every option reads at 40 and nothing needs more. At 24 rows the Project frames are not drawn (the brief asks for Home only); each keeps its Waiting (or Needs you) rows and page rows first.
- Real job titles often start with the package (`WORKER-UNIFY 02: …`); Option 1 relies on it, with the prefix fallback above.
- Age columns, `report` / `failed` words and the `◇ ◆ ✓ ◐ ○` slice marks are the panel's own; `y` and `n` are the existing keys.
- Rough sizes (not measured, read from `work-view.ts` and `project-view.ts`): Option 1 about 400–500 changed lines plus regenerated frames; Option 2 about 800–1000 (a second pane in the frame model, per-row previews); Option 3 about 500–650 (a feed builder over three sources, the map row, one page with folds).
