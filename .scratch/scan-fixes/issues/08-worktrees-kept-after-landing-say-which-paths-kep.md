# 08: Worktrees kept after landing say which paths kept them, and setup offers disposable globs

**Status:** ready-for-agent
**Owner try:** yes
**Blocked by:** none

**What to build:** Scans: bilingual 20/20 imp worktrees kept ('dirty' from ignored files like scripts/__pycache__/ and tests/evidence/), MyHUD 44 kept; reap sweep removed=0 kept=36. By design ignored files are kept unless `.hud/project.json` worktree.disposable globs match (src/mcp/managed-worktree.ts:216-254). Record the first few blocking paths in worktree_kept_reason, and have `hud setup` (and Settings if cheap) propose disposable globs from the ignored paths seen in kept worktrees for the owner to accept. No silent deletion of ignored files. Also a real bug (2026-11-23, flow f9fb00124014d9e2d): `matchesGlob(rel, 'dir/**')` does not match dot-named paths, so a worktree whose only leftovers were `.tsbuild/native/cargo/.rustc_info.json`, `.../.fingerprint/...` (native Rust build) was kept although `.tsbuild/**` is disposable. A disposable `dir/**` glob must cover every path under `dir/`, dotfiles included (e.g. match with dot segments allowed, or treat a trailing `/**` as a prefix).

- [ ] worktree_kept_reason lists up to 5 blocking paths
- [ ] `hud setup` shows proposed disposable globs from kept worktrees and writes them only when accepted
- [ ] Live: a bilingual-like synthetic worktree with only __pycache__ is reaped after accepting the glob
- [ ] A worktree whose only ignored leftovers are dot-named files under a disposable `dir/**` glob is removed after landing (unit test with `.tsbuild/x/.lock`)

## Comments
