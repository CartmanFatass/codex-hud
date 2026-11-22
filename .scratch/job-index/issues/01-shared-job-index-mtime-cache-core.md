# 01: Shared job-index mtime cache core

**Status:** ready-for-human
**Blocked by:** none

**What to build:** docs/neon-proposal/08-shared-job-index-cache.md S1: new src/roles/job-index-cache.ts (JobIndexCache: stat-stamped entries, write-through invalidation, per-HUD_HOME isolation, LRU bound, dual-format stamp read) and tests/unit/job-index-cache.test.mjs. Write through the atomic-fs primitive from primitives/01 instead of a hand-rolled putJsonAtomic. Owner defaults: Q1 keep the display/thin-jobs.json factKeys whitelist, only upgrade the stamp with dual-format compatibility. No caller changes in this slice.

- [x] All consistency/invalidation/isolation/LRU/old-stamp cases in the proposal's S1 list pass in temp HUD_HOME with synthetic jobs
- [x] No caller wired yet; full build and test:mjs pass

## Comments

- Landed 0f3d19689957d458ad214e6555022b4e45bb366c; gate 6/6 passed.
