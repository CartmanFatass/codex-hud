# 07: First-class managed worktree isolation in hud_create and hud-watch

**Status:** ready-for-agent
**Blocked by:** 06

**What to build:** `docs/spec.md` §2.1 & `.scratch/mcp-next/spec.md` §7. Automate clean per-job git worktree creation, `node_modules` linking, `git_summary` reporting and safe post-closure cleanup.

- [ ] Add `isolation?: 'none' | 'worktree'` (default `'none'`) to `hud_create` in `thin-main.ts` and `PI_ROLE_TOOLS`. Refuse `'worktree'` on `bro` places or non-git `cwd`s with `invalid_arguments`.
- [ ] When `isolation === 'worktree'`, verify `cwd`'s git root, create branch `wt/<slug>-<job.slice(-6)>` and worktree at `<parent>/<repo>-wt/<slug>-<job.slice(-6)>` from `HEAD`, symlink `<main_root>/node_modules` when present and absent in the worktree, propagate CLI trust from `main_root` if `place.harness === 'cli'` and `main_root` is already trusted, dispatch the worker inside the worktree root, and record `worktree: { main_root, root, branch, base_head }` in `job.json`.
- [ ] Enrich `hud_read(job)` with `git_summary: { branch, base_head, head, ahead_commits, changed_files, dirty }` (computed via `src/utils/git-safety.ts`) whenever `job.worktree` exists. Teach Project's worktree collector (`src/collectors/project-board.ts`) to recognize active/known HUD job worktrees so they are not flagged as unlisted drift.
- [ ] In `packages/hud-mcp/bin/hud-watch.mjs`, when a job with `job.worktree` is closed/reaped, check the worktree with safe git commands: remove the worktree and temporary branch (`git worktree remove` + `git branch -d`) ONLY when the worktree has zero uncommitted/untracked changes AND `HEAD` equals `base_head` or is already merged into `main_root`'s `HEAD`; otherwise keep the worktree intact and record `worktree_kept_reason` in `job.json`.
- [ ] Add unit tests with a temporary git repo verifying creation, `node_modules` symlink, `git_summary`, clean worktree auto-removal, and dirty/unmerged preservation.

## Comments
