# 15: Gate flakes collected after test-flakes/14

**Status:** ready-for-agent
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Running list of gate flakes that passed on immediate rerun; dispatches when a named test repeats or the list reaches 4 cases. Fix each flaky test to wait on observable events instead of fixed timing without weakening assertions or product bounds (fix the product if it is a real bug).

### Cases

- `main-session sonic jobs queue at the cap and start headless in order` (tests/unit/concurrency-cap.test.mjs) — flow `fae34c72ae5df03fd`, log `~/.hud/flows/fae34c72ae5df03fd.json.gate-1.log`
- `watcher exits without expiry timers and deletes tabless and already-reaped jobs on next catch-up` (tests/unit/job-retention.test.mjs) — flow `f61bccbe5970196ac`, log `~/.hud/flows/f61bccbe5970196ac.json.gate-1.log`
- `watcher exits without expiry timers and deletes tabless and already-reaped jobs on next catch-up` (tests/unit/job-retention.test.mjs) — flow `f61bccbe5970196ac`, log `~/.hud/flows/f61bccbe5970196ac.json.gate-2.log`
- `degraded watching polls for new jobs while a failed tab deadline keeps it alive` (tests/unit/job-retention-watch-faults.test.mjs) — flow `f61bccbe5970196ac`, log `~/.hud/flows/f61bccbe5970196ac.json.gate-2.log`

- [ ] Each listed case passes 20 consecutive runs under parallel load
- [ ] No assertion or product bound weakened

## Comments
