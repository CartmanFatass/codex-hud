# 04: Land records done; no routine ticket acceptance prompt

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 01

**What to build:** Spec §6 and removal items 19–21. `hud_land` records `done` by default (`src/mcp/local-tickets.ts:112`); `**Owner try:** yes` keeps `ready-for-human`. Remove the default Project/Claude band "N to try / Accept all" prompt (`src/cli/watch-band.ts:21-33`) and ticket-count percentages as project progress (`ticket-rollup.ts:57`; ticket detail keeps its denominators). Keep the explicit diagnostic Accept all, `/try`, `hud act try` and old records. Update `docs/agents/issue-tracker.md` and the `hud_tickets` guide where they describe the default.

- [ ] Test: landing a ticket without an Owner try line records `done`; with `Owner try: yes` records `ready-for-human`
- [ ] Test: the band shows no try/Accept-all prompt for pending tickets; `/try` and `hud act try` still work on old records
- [ ] `npm test` passes

## Comments
