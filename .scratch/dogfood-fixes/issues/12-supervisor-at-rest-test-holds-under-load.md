# 12: The supervisor at-rest test holds under load

**Status:** ready-for-human
**Blocked by:** none

**What to build:** Found 2026-11-22: "supervisor events: 60s at rest means zero spawns and zero STATUS writes; socket loss stays working" (tests/unit/thin-mcp-cli-process.test.mjs) failed in two hud_land gates in a row (DOGFOOD-FIXES-02 be73d2f8, EVENT-WAITS-01 e82c77ba), passing on the immediate rerun both times, after DOGFOOD-FIXES-07 had already touched it. Find what it races on under load (fake clock vs real timers, a spawn or STATUS write counted from setup, socket-loss timing) and make it deterministic; the contract (no spawns and no STATUS writes at rest; socket loss keeps the job working) stays asserted. No test deleted.

- [x] The test passes 20 runs in a row alone and 3 full test:mjs runs with every core busy
- [x] npm test and check:fixtures pass

## Comments
