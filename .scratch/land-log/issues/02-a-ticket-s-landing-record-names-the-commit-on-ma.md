# 02: A ticket's landing record names the commit on main

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Acceptance pass 2026-11-22: the landing sha written into the ticket file (c055516e for hud-doctor/01, 70929c35 for land-log/01) is the worker's pre-replay tip, not an ancestor of main (merge-base --is-ancestor fails), so it does not resolve on main. The ticket record is folded into the landed commit itself, so it cannot contain its own sha: record the replay base + 'this commit' wording, or write a stable reference that resolves (e.g. the flow id plus the landed subject), and make hud_read/panel resolve it to the real landed sha from the flow record.

- [x] After a synthetic land, the ticket's landing line resolves to a commit on main (or to the flow whose landed_sha is on main), test asserts it
- [x] Existing landed tickets need no migration; the panel's Latest list still shows them
- [x] npm test passes

## Comments

- Landed 14d9dd1b763336d965943cd7253288951fe2d478; gate 5/5 passed.
