# 03: Child sonic results reach imp as a push; no zero-timeout polling

**Status:** claimed
**Blocked by:** none

**What to build:** Rank 5. When a sonic started by a worker via hud_sonic settles, deliver a ready notice into the parent pi session (same mechanism as the orchestrator answer message) and drop the `0 checks once` hint from hud_sonic's schema so workers wait or keep working instead of polling with timeout_s 0. Tell imp in its instructions to give sonic non-overlapping reads.

- [ ] A worker that starts sonic and keeps editing receives the result without calling hud_sonic with timeout_s 0
- [ ] npm test and check:fixtures pass

## Comments
