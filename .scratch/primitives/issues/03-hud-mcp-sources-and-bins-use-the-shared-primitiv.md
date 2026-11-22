# 03: hud-mcp sources and bins use the shared primitives

**Status:** ready-for-human
**Blocked by:** 01, 02

**What to build:** 05 S2: thin-main, cli-judge, codex-statusline and the bins use atomic-fs and proc.ts; question files get mode 0600. Runs after async-watch.

- [x] No hand-written atomic write left in hud-mcp
- [x] npm test passes

## Comments

- Landed e0747c7a697c3ad1d4e1db0d17bffe855fd66c0a; gate 6/6 passed.
