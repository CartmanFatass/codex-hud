# 03: Two more load-flaky files: mod stand-down and retention watch faults

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Recent land gates (flows fbbd51334f115571c, f9d8f30503e273059) needed reruns for `late Claude mod watch stands down new tasks, enables batch create, and stops main-pane typing` (tests/unit/thin-mcp-tasks-checks.test.mjs, 2 gates in a row) and two cases in tests/unit/job-retention-watch-faults.test.mjs ('watcher removes a 2-link loop in sessions and still scans expired jobs', 'transient startup failure: a working watch does not poll after recovery'; seen on earlier gates too). Same approach as test-flakes/01: find the fixed deadline or ordering assumption that breaks under parallel load, replace it with an event/condition wait, keep the assertion.

- [x] Each named case passes 20 consecutive runs under parallel `npm run test:mjs` load
- [x] No assertion weakened; report names each cause

## Comments
