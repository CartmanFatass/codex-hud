# 02: Project hub uses its room and keeps Now about work

**Status:** ready-for-agent
**Blocked by:** 01

**What to build:** The Project hub shows whole waiting items and a Now block that is about work in flight. Owner,
2026-11-17: the hub had ~19 blank rows while each waiting item was cut to one row, losing the action at its end
("Contr…", "reopen `/hud` i…"); Now held only three `! MyHUD-xxx 未记入清单` rows (worktrees not in the ledger); the
name row read `0.1.4 ▾ 1/4` with an unexplained `1/4`; the progress bar's ▓ (to try) and █ (accepted) were hard to tell
apart.

- [ ] A waiting item wraps to two rows when the hub has spare rows; on a short panel it falls back to one cut row
      before Latest or the page rows give way. The Waiting header says how many of the items are tries.
- [ ] Worktrees not in the ledger leave Now. The Working tree page row counts them (e.g. `3 个未登记工作树`) and its
      page lists them. An empty Now shows one muted row saying nothing is in progress.
- [ ] The name row's `1/4` says what it counts (e.g. `项目 1/4`), or is dropped if it adds nothing.
- [ ] The to-try and accepted inks on every progress bar differ clearly in every theme, not only by glyph.
- [ ] Main-path frame tests (synthetic STATE and worktrees) for wrapping, Now without unlisted worktrees, and the Working
      tree count.

## Comments
