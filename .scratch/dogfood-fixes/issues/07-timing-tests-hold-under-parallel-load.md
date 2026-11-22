# 07: Timing tests hold under parallel load

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Found 2026-11-22: with several workers testing at once (load average 13–18), these failed once and passed on rerun: hud-watch-async.test.mjs:111 (checks within 500 ms, saw 501), statusline-agy.test.mjs:192 ('HUD unavailable' instead of the frame), thin-mcp-roster-presets.test.mjs:1086 (2 s lookup budget), thin-mcp-quiet-decision.test.mjs:112 (10 s test timeout), hud-cli-async.test.mjs:206 (watcher preempt race), thin-mcp-cli-turns.test.mjs:67, role-places, thin-mcp-watcher-reap.test.mjs:441. Make each deterministic or load-tolerant: wait on the event instead of wall-clock budgets where the budget is not the product contract; where it is (e.g. a latency promise), measure relative to a calibration or widen with a comment. No test deleted.

- [ ] Two full npm test runs in parallel with a CPU hog (e.g. `stress`-like busy loops on all cores) pass
- [ ] npm test and check:fixtures pass

## Comments
