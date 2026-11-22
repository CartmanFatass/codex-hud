# 01: One atomic file helper for all private writes

**Status:** ready-for-human
**Blocked by:** none

**What to build:** docs/neon-proposal/05-consolidate-primitives-and-model-catalog.md S1: src/utils/atomic-fs.ts replaces the hand-written atomic writes and read helpers in src/ (0600 files, 0700 dirs). Runs after build-dedup/01. mcp-split/01 then builds its job contracts on this helper instead of adding job-io's second atomic layer.

- [x] The listed src writers use atomic-fs; modes are 0600/0700
- [x] npm test passes

## Comments

- Landed 8549d02ffb5211347f4e7a7a8d9c9a9dfb869549; gate 6/6 passed.
