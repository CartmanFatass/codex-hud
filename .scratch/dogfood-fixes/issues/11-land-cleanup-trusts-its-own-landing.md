# 11: Land cleanup trusts its own landing

**Status:** claimed
**Blocked by:** none

**What to build:** Found 2026-11-22: hud_land of DOGFOOD-FIXES-10 (flow fa4894b117bd7b9ff) fast-forwarded, pushed and recorded 49e57b75, then reported the whole flow as failed at step cleanup ("worktree has unmerged commits"): the cherry-picked commit's patch differed from the source (a ticket Status line had moved on main), so neither ancestry nor `git cherry` saw the source commit on the base. Land cleanup removes the source worktree and branch when the flow itself landed exactly the source's commits (its own record: source_sha, landed_sha) and the worktree is clean; if cleanup still cannot run after a push, the flow ends as landed with a cleanup note, never failed. The watcher's general rule stays as is.

- [ ] A landing whose picked patch differs from the source still removes the clean source worktree
- [ ] A cleanup error after push reports landed with a note, not failed
- [ ] npm test and check:fixtures pass

## Comments
