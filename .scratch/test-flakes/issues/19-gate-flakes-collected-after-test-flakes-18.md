# 19: Gate flakes collected after test-flakes/18

**Status:** done
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Running list of gate flakes that passed on immediate rerun; dispatches when a named test repeats or the list reaches 4 cases. Fix each flaky test to wait on observable events instead of fixed timing without weakening assertions or product bounds (fix the product if it is a real bug).

### Cases

- `overlapping watcher startups publish only one ready PID` (tests/unit/hud-watch-async.test.mjs) — flow `fd0ba6e2c5ca1431e`, log `~/.hud/flows/fd0ba6e2c5ca1431e.json.gate-1.log`
- `overlapping watcher startups publish only one ready PID` (tests/unit/hud-watch-async.test.mjs) — flow `fa9dfb98448f60238`, log `~/.hud/flows/fa9dfb98448f60238.json.gate-1.log`

- [x] Each listed case passes 20 consecutive runs under parallel load
- [x] No assertion or product bound weakened

## Comments

- Landed in this commit (replay base 03c350d814030e3d4bd6ea3c96a4cd3a3b528aa7); gate 5/5 passed.
