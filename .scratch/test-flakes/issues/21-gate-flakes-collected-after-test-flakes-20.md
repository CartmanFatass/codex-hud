# 21: Gate flakes collected after test-flakes/20

**Status:** needs-triage
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Running list of gate flakes that passed on immediate rerun; dispatches when a named test repeats or the list reaches 4 cases. Fix each flaky test to wait on observable events instead of fixed timing without weakening assertions or product bounds (fix the product if it is a real bug).

### Cases

- `overlapping watcher startups publish only one ready PID` (tests/unit/hud-watch-async.test.mjs) — flow `fecf56de5d9a3a52d`, log `~/.hud/flows/fecf56de5d9a3a52d.json.gate-1.log`

- [ ] Each listed case passes 20 consecutive runs under parallel load
- [ ] No assertion or product bound weakened

## Comments
