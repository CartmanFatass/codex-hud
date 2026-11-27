# 26: Land ticks only acceptance items the worker did not report unfinished

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** hud_land ticked imp-daily-facts/02 acceptance item 1 although the worker's report said that item was unfinished (only `round` done; `repairs` waited on ticket-store/06), and the lead had asked not to tick it. The land record ticks items mechanically. Fix: items the report's `Not done` section or a lead todo names by acceptance text or id stay unticked; the land notice lists them; a ticket with unticked items lands as `ready-for-agent` with a comment, not `done`, unless the remaining item is an owner try.

- [ ] Test: report `Not done` naming item 1 → land leaves item 1 unticked and the ticket not done; notice lists it
- [ ] Test: report with an empty Not done → all items ticked as today
- [ ] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments
