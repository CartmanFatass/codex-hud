# 04: Land records done; no routine ticket acceptance prompt

**Status:** done
**Owner try:** no
**Blocked by:** 01

**What to build:** Spec §6 and removal items 19–21. `hud_land` records `done` by default (`src/mcp/local-tickets.ts:112`); `**Owner try:** yes` keeps `ready-for-human`. Remove the default Project/Claude band "N to try / Accept all" prompt (`src/cli/watch-band.ts:21-33`) and ticket-count percentages as project progress (`ticket-rollup.ts:57`; ticket detail keeps its denominators). Keep the explicit diagnostic Accept all, `/try`, `hud act try` and old records. Update `docs/agents/issue-tracker.md` and the `hud_tickets` guide where they describe the default.

- [x] Test: landing a ticket without an Owner try line records `done`; with `Owner try: yes` records `ready-for-human`
- [x] Test: the band shows no try/Accept-all prompt for pending tickets; `/try` and `hud act try` still work on old records
- [x] `npm test` passes

## Comments

- Landed in this commit (replay base 9972bfcc5c5d75b7f450f1f94ec0c428a19464dd); gate 5/5 passed.
