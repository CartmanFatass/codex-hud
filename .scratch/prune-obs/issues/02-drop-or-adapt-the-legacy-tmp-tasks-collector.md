# 02: Drop or adapt the legacy tmp/tasks collector

**Status:** ready-for-agent
**Blocked by:** 01

**What to build:** Slice 2 (PRUNE-OBS-02, :433-451): task-observations.ts and pi-dispatch-status.ts go. Owner decision 1 (:534-545): plan A drops legacy tmp/tasks tasks from Home; plan B keeps a <=130-line readLegacyTasks adapter.

- [ ] The owner's choice of plan A or B is implemented
- [ ] npm test and check:fixtures pass from a clean build

## Comments
- 2026-11-21 owner decision 1: plan A. Legacy tmp/tasks tasks started by old scripts leave Home; no adapter.
