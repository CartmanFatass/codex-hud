# 02: hud_read digest by default

**Status:** ready-for-human
**Blocked by:** none

**What to build:** Rank 4: hud_read returns a digest by default (state, one-line result, changed files, verdict/blockers when the report gives them) with mode full for the whole report; batch reads with jobs[]. Spec sentence as told to the owner.

- [x] A long report reads as a digest under 1 KB; mode full returns it whole
- [x] npm test and check:fixtures pass

## Comments

- 2026-11-22: landed 406fa959 via sonic gate (test:mjs 1021/1021 ×2, unit 92/92, fixtures OK).
