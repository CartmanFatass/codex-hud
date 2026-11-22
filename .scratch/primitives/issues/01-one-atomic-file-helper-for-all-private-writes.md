# 01: One atomic file helper for all private writes

**Status:** claimed
**Blocked by:** none

**What to build:** docs/neon-proposal/05-consolidate-primitives-and-model-catalog.md S1: src/utils/atomic-fs.ts replaces the hand-written atomic writes and read helpers in src/ (0600 files, 0700 dirs). Runs after build-dedup/01. mcp-split/01 then builds its job contracts on this helper instead of adding job-io's second atomic layer.

- [ ] The listed src writers use atomic-fs; modes are 0600/0700
- [ ] npm test passes

## Comments
