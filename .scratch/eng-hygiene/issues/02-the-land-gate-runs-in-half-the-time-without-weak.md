# 02: The land gate runs in half the time without weakening any test

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** hud_land's gate (.hud/project.json land.gate) takes about 70 s, mostly the tests/unit/*.mjs node --test run. About 19 test files wait on fixed sleeps (setTimeout with a constant, sleep(), delay()). First measure: run the gate's mjs command with --test-reporter=spec under TZ=UTC and record total wall time and the 15 slowest files. Then replace fixed waits in the slowest files with event waits (the repo's fs-wait helper, polling a condition with a deadline) or injected/fake clocks, so tests finish as soon as the condition holds. Never lower a timeout that guards a real condition, never delete or skip a test or an assertion, never raise test concurrency above the gate's 8. If a slow file is slow for a reason other than sleeping (real process spawn, build), list it and leave it.

- [x] Report has before/after wall time for the gate's mjs command (three runs each, median) and the before/after 15 slowest files
- [x] Every changed test still fails when the behaviour it checks is broken (state how you checked at least three of them, e.g. by temporarily breaking the condition)
- [x] No test, assertion or file removed; no test.skip/todo added; concurrency unchanged
- [x] The full gate command list passes three times in a row in the worktree (no new flakes)
- [x] Target: median mjs wall time at most half of the before median; if not reached, the report says what remains and why

## Comments

- Landed in this commit (replay base 100aa96d2ce9d4bb74e090d91e4f5c0360c4e2f4); gate 5/5 passed.
