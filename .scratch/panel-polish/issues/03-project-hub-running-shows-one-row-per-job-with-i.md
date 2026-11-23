# 03: Project hub Running shows one row per job with its own role

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Acceptance pass 2026-11-22 (frames 05, 44): the Project hub 'Running' block showed 7 rows for 3 jobs (worktree rows like `hud-doctor-01-44dd83 sonic 3分`, slice rows and job rows), and later `◐ auto-route-08-778c8c sonic 7m` named the imp's worktree with the sonic role while the imp job itself was missing. Running should list one row per running job (role, ticket title, age) with sonic children folded into the parent's ⚡N like Home.

- [ ] A fixture with an imp in a worktree running two sonic children shows one Running row: imp role, ticket title, ⚡2
- [ ] No worktree-name or slice duplicate rows; a sonic never labels a worktree
- [ ] zh and en frames; npm test and check:fixtures pass

## Comments
