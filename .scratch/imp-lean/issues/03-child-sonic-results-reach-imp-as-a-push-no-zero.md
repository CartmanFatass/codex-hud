# 03: Child sonic results reach imp as a push; no zero-timeout polling

**Status:** ready-for-human
**Blocked by:** none

**What to build:** Rank 5. When a sonic started by a worker via hud_sonic settles, deliver a ready notice into the parent pi session (same mechanism as the orchestrator answer message) and drop the `0 checks once` hint from hud_sonic's schema so workers wait or keep working instead of polling with timeout_s 0. Tell imp in its instructions to give sonic non-overlapping reads.

- [x] A worker that starts sonic and keeps editing receives the result without calling hud_sonic with timeout_s 0
- [x] npm test and check:fixtures pass

## Comments

- 2026-11-22: landed 3048f0d9 via sonic gate (test:mjs 1024/1024 ×2, unit 92/92, fixtures OK).
