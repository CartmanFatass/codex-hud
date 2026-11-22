# 02: hud_read digest by default

**Status:** claimed
**Blocked by:** none

**What to build:** Rank 4: hud_read returns a digest by default (state, one-line result, changed files, verdict/blockers when the report gives them) with mode full for the whole report; batch reads with jobs[]. Spec sentence as told to the owner.

- [ ] A long report reads as a digest under 1 KB; mode full returns it whole
- [ ] npm test and check:fixtures pass

## Comments
