# 01: A worker's sonic child runs in the parent's cwd

**Status:** done
**Blocked by:** none

**What to build:** Found 2026-11-22 (FLOWS-01): a sonic started by an imp through hud_sonic used the HUD server's default cwd (the main checkout) instead of the parent job's cwd (its managed worktree), so it built and wrote logs in the owner's checkout. hud_sonic children default to the parent job's cwd; an explicit cwd must stay inside the parent's project.

- [x] A sonic started by a worker in a managed worktree runs in that worktree
- [x] npm test and check:fixtures pass

## Comments

- 2026-11-22: landed c9f375e1 via sonic gate (test:mjs 1039/1039 on run 2; run 1 one unrelated statusline-agy load flake, see 07).
