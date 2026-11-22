# 07: Reap removes worktrees whose node_modules was checked out

**Status:** done
**Blocked by:** none
**Owner try:** no

**What to build:** Plan `docs/llm/perf-rust-plan-2026-11-22.md`, row 07. Tracked files under `node_modules` make `populateWorktree` (`src/mcp/managed-worktree.ts`) check out a real `node_modules` dir, so no symlink is made and `dependencyLink()` makes reap refuse forever (about 16 dirs, ~750 MB under ../MyHUD-wt). Make reap treat a tracked-plus-ignored `node_modules` as removable dependency state (never untracked user files elsewhere), and make populate link the untracked rest when the tracked part exists. Include a one-time sweep of already-stale managed worktrees whose jobs are closed. Measure before and after on a synthetic fixture under `tmp/env.sh` and put both numbers in the report.

- [x] A worktree with checked-out node_modules is reaped after its job closes; user files block reap as before
- [x] Stale managed worktrees of closed jobs are removed on the next sweep
- [x] Targeted worktree tests pass

## Comments

- Landed a6ee4d24cfb53dd189bce42ee9facaea5b129704; gate 5/5 passed.
