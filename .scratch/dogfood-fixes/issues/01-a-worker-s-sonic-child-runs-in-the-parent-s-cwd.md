# 01: A worker's sonic child runs in the parent's cwd

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Found 2026-11-22 (FLOWS-01): a sonic started by an imp through hud_sonic used the HUD server's default cwd (the main checkout) instead of the parent job's cwd (its managed worktree), so it built and wrote logs in the owner's checkout. hud_sonic children default to the parent job's cwd; an explicit cwd must stay inside the parent's project.

- [ ] A sonic started by a worker in a managed worktree runs in that worktree
- [ ] npm test and check:fixtures pass

## Comments
