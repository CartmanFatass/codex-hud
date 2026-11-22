# 04: Focused review: process killing in the async watcher

**Status:** ready-for-human
**Blocked by:** 01, 02, 03

**What to build:** One reviewer job on the merged async-watch slices for process-killing safety (spec: killing processes needs review).

- [x] Reviewer report with findings; must-fix findings repaired

## Comments

- 2026-11-22 review docs/reviews/2026-11-22-async-watch-review.md (101cbfe4): 5 blocking + 1 delete, fixed in 0bc03c05 (imp on 6.2-astra, jdf3e056ed80df9a3 → continuation j9fe69438c4ed89e7): watcher publishes its pid only when ready (startup guard under the dist lock); stop rechecked at the paid fetch boundary; agy mailbox flock async; group signals only after a live member with the per-spawn token is verified; read-close retry with tab gone. 7 new red/green tests. A loaded-run flake on main came from an assertion message reading a not-yet-written watch.log (b10b7237). Main: 1005/1005 twice, unit, check:fixtures.
