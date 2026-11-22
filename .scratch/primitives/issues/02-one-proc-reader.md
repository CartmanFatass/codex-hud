# 02: One /proc reader

**Status:** ready-for-human
**Blocked by:** none

**What to build:** 05 S3: src/utils/proc.ts replaces the 7 hand-written /proc readers (worker-tree, cli-judge, daemon-binding, model-runtime-store, hud-notify, thin-main).

- [x] All /proc reads go through proc.ts
- [x] npm test passes

## Comments

- Landed a865f39eee3717cf9d8c0f135027046e3bb17f25; gate 6/6 passed.
