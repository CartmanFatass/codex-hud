# 01: Machine-wide running and queued counts in every statusline

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Spec §5 M2. The work-summary snapshot (`src/collectors/work-summary-snapshot.ts:22-35,71-84`) publishes machine-wide `running` and a new `queued` count across all projects. The statusline (`src/cli/statusline.ts:159,170`) reads `global`, not the pane's own counts, labelled as machine scope. `asking` counts workers waiting on main; it is not shown as owner load (owner requests come later). Claude, pi and Codex lines show the same numbers.

- [x] Test (M2 Try, counts): jobs running in two projects and one queued give the same running/queued in two panes' statuslines; starting the queued job changes both
- [x] Test: a pane with no own jobs still shows the machine counts
- [x] `npm test` passes; reference.md (EN/ZH) updated

## Comments

- Landed in this commit (replay base f5c16bb6300e3de13f371e2d077809f5fb595d62); gate 5/5 passed.
