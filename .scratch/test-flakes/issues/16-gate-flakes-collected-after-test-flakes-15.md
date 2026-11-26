# 16: Gate flakes collected after test-flakes/15

**Status:** done
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Running list of gate flakes that passed on immediate rerun; dispatches when a named test repeats or the list reaches 4 cases. Fix each flaky test to wait on observable events instead of fixed timing without weakening assertions or product bounds (fix the product if it is a real bug).

### Cases

- `watcher exits without expiry timers and deletes tabless and already-reaped jobs on next catch-up` (tests/unit/job-retention.test.mjs) — flow `f4c2bcb6cbdd1661c`, log `~/.hud/flows/f4c2bcb6cbdd1661c.json.gate-1.log`
- `degraded watching polls for new jobs while a failed tab deadline keeps it alive` (tests/unit/job-retention-watch-faults.test.mjs) — flow `f4c2bcb6cbdd1661c`, log `~/.hud/flows/f4c2bcb6cbdd1661c.json.gate-1.log`
- `watcher exits without expiry timers and deletes tabless and already-reaped jobs on next catch-up` (tests/unit/job-retention.test.mjs) — flow `f4c2bcb6cbdd1661c`, log `~/.hud/flows/f4c2bcb6cbdd1661c.json.gate-2.log`
- `degraded watching polls for new jobs while a failed tab deadline keeps it alive` (tests/unit/job-retention-watch-faults.test.mjs) — flow `f4c2bcb6cbdd1661c`, log `~/.hud/flows/f4c2bcb6cbdd1661c.json.gate-2.log`
- `watcher exits without expiry timers and deletes tabless and already-reaped jobs on next catch-up` (tests/unit/job-retention.test.mjs) — flow `f4c2bcb6cbdd1661c`, log `~/.hud/flows/f4c2bcb6cbdd1661c.json.gate-3.log`
- `degraded watching polls for new jobs while a failed tab deadline keeps it alive` (tests/unit/job-retention-watch-faults.test.mjs) — flow `f4c2bcb6cbdd1661c`, log `~/.hud/flows/f4c2bcb6cbdd1661c.json.gate-3.log`

- [x] Each listed case passes 20 consecutive runs under parallel load
- [x] No assertion or product bound weakened

## Comments

- Landed in this commit (replay base 035839016ecb60a02ca66b6a0e3d7707a1e163fa); gate 5/5 passed.
