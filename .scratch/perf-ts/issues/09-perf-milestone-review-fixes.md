# 09: Milestone review fixes for performance stage 1 and the native statusline

**Status:** ready-for-agent
**Blocked by:** none
**Owner try:** no

**What to build:** Fix every blocking finding in `docs/reviews/2026-11-22-perf-milestone.md` in one pass (plan 1-4, simplicity 1-2, plus its "What can be deleted" list). The design intent it was judged against is in `tmp/tasks/review-perf/brief.md`. In short:
- A real MyHUD land reuses its tested TypeScript build: compare the declaration inputs from `scripts/` and `packages/hud-mcp/bin/` (`dist-lock.d.mts`, `agy-events.d.mts`) between the two checkouts instead of rejecting them; the land fixture uses the real program shape.
- A Claude statusline with no herdr pane shows no worker zone (TS and Rust); global counts stay for explicit global consumers.
- `hud_respond` with several answers publishes the work summary once per call, not once per answer; dispatch admission keeps its fresh check.
- Rust matches TS for the `zai` (GLM) mark colour, or declines that case to TS; add it to the differential fixtures.
- pi's passive `Work:` status keeps `stalled`, `failed` and `report ready` on the fresh-snapshot path.
- The pi footer's EXP-off cache watches the resolved settings target (symlinked dotfiles), or does not cache when the watch cannot cover the file it read.
- Deletions: per-answer census rebuilds; `seenFacts` in `src/collectors/thin-jobs.ts` (use the `seenStamps` keys).
Also take the review's third optional item (split the ARM64-portable TS-bypass assertion from the x64 replay assertion in `tests/unit/native-statusline.test.mjs`); leave the other optional items.

- [ ] Each blocking finding has one main-path test that fails before and passes after
- [ ] Targeted tests pass, including the Rust/TS differential tests

## Comments
