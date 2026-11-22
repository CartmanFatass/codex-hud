# 03: Sonic stops on a stall, not on a fixed 10 minutes

**Status:** ready-for-agent
**Blocked by:** 01
**Owner try:** no

**What to build:** Owner 2026-11-22 asked whether the 10-minute headless cap fits and what happens to a long query cut off. Facts: of 25 recent sonic jobs with timings, p50 259 s, p90 497 s, 2 over 600 s (677 s and 1,490 s), both finished with outcome done; a fixed 10-minute kill would have failed them and thrown the work away. Change sonic-process: a query is stopped when it has shown no activity (stdout growth or hud_progress) for `stall_s` (default 180), or when it passes the safety cap `max_s` (default 1800); both are optional fields of the sonic role file and shown in `hud_roster(detail:true)`. A stopped query settles failed with reason `stalled` or `timeout`, keeps its partial stdout, and its hud_read digest carries the last progress line and the facts pi printed before the stop. `hud_create({role:"sonic", retry_of})` on such a job starts a new query whose brief carries the original brief plus that partial result, telling it to continue rather than start over.

- [ ] A query that keeps printing runs past 10 minutes; one silent for stall_s is stopped as `stalled`
- [ ] max_s stops a query that never goes quiet, as `timeout`
- [ ] retry_of on a stopped sonic carries the partial result into the new brief
- [ ] role-file values change both limits; npm test and check:fixtures pass

## Comments
