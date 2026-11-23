# 07: Two gate-flaky process tests hold under load

**Status:** done
**Owner try:** no
**Blocked by:** 06

**What to build:** Land gate 2026-11-22 (native-statusline/03, 98867eaf): tests/unit/thin-mcp-headless.test.mjs 'hud_close and panel stop reap the live headless worker and its detached child' failed once and passed on the immediate rerun. Find whether the test races (fixed sleeps, process-exit timing) or the reap itself can miss the detached child; fix the real cause. Same for the second flake, land gate 2026-11-22 (auto-route/06, 7ec6a3e3): tests/unit/thin-mcp-cli-process.test.mjs 'supervisor preserves the watcher tab-close fact when its own push socket was lost'.

- [x] Cause named in the report for each test (test timing vs real gap)
- [x] Each test passes 20 consecutive runs under parallel load (node --test with the full mjs set or a CPU stressor)
- [x] If the reap can miss a child, the fix is in the reap path, not a longer timeout; same for the supervisor tab-close fact

## Comments

- Landed cfd0dbd56492a83afd7d33fe7b349234b90b8e39; gate 5/5 passed.
