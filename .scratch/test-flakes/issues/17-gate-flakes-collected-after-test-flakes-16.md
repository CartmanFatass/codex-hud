# 17: Gate flakes collected after test-flakes/16

**Status:** done
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Running list of gate flakes that passed on immediate rerun; dispatches when a named test repeats or the list reaches 4 cases. Fix each flaky test to wait on observable events instead of fixed timing without weakening assertions or product bounds (fix the product if it is a real bug).

### Cases

- `overlapping watcher startups publish only one ready PID` (tests/unit/hud-watch-async.test.mjs) — flow `f28764ba0cff47e21`, log `~/.hud/flows/f28764ba0cff47e21.json.gate-2.log`
- `overlapping watcher startups publish only one ready PID` (tests/unit/hud-watch-async.test.mjs) — flow `fd849ff4afdcc9fcd`, log `~/.hud/flows/fd849ff4afdcc9fcd.json.gate-2.log`

- [x] Each listed case passes 20 consecutive runs under parallel load
- [x] No assertion or product bound weakened

## Comments

- Landed in this commit (replay base 339c5e01d4db6301e9ce4aade77ce6d6e1f79ff8); gate 5/5 passed.
