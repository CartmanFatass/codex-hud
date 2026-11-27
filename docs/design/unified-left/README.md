# Unified left sidebar: variant C

Chosen by the owner 2026-11-27 (D-2026-11-27-05) from oracle jafbaad7f019a595d's three variants. Frames C1–C5 in
`tui/preview.mjs` are the reference (`node docs/design/unified-left/tui/preview.mjs`, keys `3` then `←→`).
`plan.md` is the rejected earlier plan.

## Shape

- herdr keeps drawing the sidebar with every function it has today: spaces (branch, git ahead/behind, worktree
  folds, drag-reorder, `new`, `menu`), agents (grouped/priority sort, group folds), machines, toggles and drags,
  per-client preferences, all keys.
- HUD adds to it, through one bounded projection HUD pushes on change (`sidebar.set_hud`, generation-tagged,
  leased so a dead watcher shows `·` stale instead of a frozen state):
  - **Crown** (0 rows when calm): `?N project · waits age` and the first request as a sentence; then the launcher
    `◆ Home Proj Exec·N Ctrl`.
  - **Spaces header:** `+N prj` folds the registered projects that have no workspace.
  - **Agents:** a worker group of a run renders as `run <name>  age` with the run's miniature graph below it
    (`╭────┬────╮ / ✓01 ×02⚒ ?03⚒ / ○ review ╌ ○ accept`). A step with a live terminal carries its role glyph and
    focuses (or peeks) the terminal on click; a headless or settled step opens Execution at that step. `▾/▸` folds it.
  - **Marks:** state shape glued before the role glyph (`◐⚒`); folded groups show their strongest state shape.
    One vocabulary: `?` owner asked, `×` failed/blocked, `◐` running, `✓` done, `○` queued/idle, `·` unknown.
- **Widths never change with runs:** expanded (the dragged width, default 28), folded to the 13-column rail (C3:
  workspace number and short name, miniature graphs) or to the 4-column minimal rail (C5: today's icons and rules;
  HUD adds only `?N` on top and the state shape on folded runs). Settings choose the folded form; rail by default.
- **◆ HUD tab:** `/hud`, `prefix+d` or a launcher item opens the HUD pages as one center tab `[◆ HUD · <page>]`
  over the pane surface (C2). Focusing any workspace or agent hides it; hiding keeps the panel running; `q` hides,
  never quits. It focuses, copies and zooms like a pane. On terminals of at least 112 columns `P` pins it as a push
  split beside the panes. Settings can still dock the pages to an edge instead (push default, overlay a setting).
- **Pages:** Execution uses the sidebar's marks. While Project or Execution is open, focusing a workspace selects
  its project.
- **Narrow** (herdr's mobile threshold): no side column; header row 2 shows the state counts, `?N` and one-line run
  strips (C4); the ◆ HUD tab fills the width, and `switch` returns to navigation.

## Data flow

No timers while hidden. HUD watches `jobs-revision.json`, `flows/`, unattended records and the registered
projects' `.hud/` and `STATE.md` (editing `STATE.md` does not bump `jobs-revision.json`), and sends the projection on
change; herdr's `dock.updated` and focus events replace the 250 ms `dock.status` poll.
