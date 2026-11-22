# 21: A worktree report with uncommitted work is sent back

**Status:** ready-for-agent
**Blocked by:** none
**Owner try:** no

**What to build:** Twice on 2026-11-22 (perf-hygiene/05, auto-route/02) a worktree imp reported done with its changes uncommitted, and `hud_land` failed at prepare with "Source has no commits to land", costing a repair round. The brief already says to commit; the MCP should enforce it. When a job with `isolation: "worktree"` publishes its report (`hud_report` or the shell fallback) and its worktree has tracked or untracked changes outside git-ignored paths, the report is refused with one line: "Commit your changes on <branch> first (git -c user.name='HUD worker' -c user.email=worker@hud.invalid commit -- <paths>), then report." A report from a worktree with no commits beyond its base and no changes stays allowed (a no-op job). Main-checkout jobs are unchanged.

- [ ] Dirty worktree report is refused with the one-line hint; after a commit the same report goes through
- [ ] Clean worktree with commits, and clean with no commits, report as today
- [ ] Targeted worker-tools tests pass

## Comments
- 2026-11-22: root cause found: the shipped implementer, frontend-implementer and general instructions said "No git commit … leave the changes in the working tree", contradicting `.hud/brief.md` and `hud_land`. Fixed in 5ccd6754 (commit on the managed worktree branch before reporting). This ticket stays as the guard for workers that still miss it.
