# 01: A dead worker tree stops the reap retry loop

**Status:** ready-for-agent
**Blocked by:** none
**Owner try:** no

**What to build:** Verified 2026-11-22 20:18Z: ~/.hud/watch.log has 1,528 lines, 1,160 of them the same two jobs (j835a9f75107f99a7 failed, j288fb04c6c951215 stopped, 28 h old) logging "worker-tree snapshot unresolved: recorded root exited before any matching ancestry snapshot could be recovered" every 30 s; hud-watch pid 228205 never goes idle. Cause per an outside review: reapWorkerTree returns complete=false when the root PID is gone and no worker-tree.json snapshot exists (src/roles/worker-tree.ts:145-155); reapJob then retries in 30 s without setting reaped_at (src/runtime/watch-runtime.ts:256-290), and the 24 h retention needs `!tab || job.reaped_at` (:500-522), so such a job never ages out and the watcher rescans jobs, walks /proc and spawns pi-role-reap forever. Fix: when the root is gone and no snapshot can ever be recovered, there is nothing left to kill: record reaped_at with an `unresolved` note once (one log line), stop retrying, and let retention archive it. Keep retrying only while a live process could still belong to the job. Bound any remaining retry (e.g. 10 tries with backoff) and log each job at most once per state change.

- [ ] A job whose root exited without a snapshot gets reaped_at after one attempt, logs once, and is archived by retention
- [ ] hud-watch goes idle with only such jobs left
- [ ] npm test and check:fixtures pass

## Comments
