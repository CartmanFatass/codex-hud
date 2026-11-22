# 01: hud_read names files another worktree job also changed

**Status:** done
**Blocked by:** test-split/04 (MCP lane; land before mcp-split/01)

**What to build:** Proposal docs/neon-proposal/15-worktree-overlap-in-git-summary.md with its §6 defaults (owner, 2026-11-22): `git_summary` always carries `overlaps` ([] when none, null when its own summary failed); compare against other managed worktrees of the same checkout, including kept closed ones, with already-integrated changes filtered out; the main checkout's own uncommitted changes are not counted; no hint in hud_create or notices. Spec §isolation sentence gains, as approved: "including files also changed in other managed worktrees of the same checkout".

- [x] Two synthetic worktree jobs editing the same file each list the other in hud_read; an integrated change is not listed
- [x] npm test and check:fixtures pass

## Comments

- 2026-11-22 landed d8443bbf (imp j59bce9185884f04c): `git_summary.overlaps` [{job, files, more?}], [] none, null own summary failed, `overlaps_incomplete` on partial coverage; integrated changes filtered by comparing sibling HEAD paths with main HEAD; bounded to 8 siblings, 200 candidates, 32 extra git calls (1 s each); ~+14 ms with 2 siblings. Main: 973/973, unit, check:fixtures green.
