# 20: Queue repair: pin only held manual-land evidence, not every landed job of an open queue

**Status:** done
**Live try:** none
**Blocked by:** none

**What to build:** Repair of chores/18 after milestone review j5e7baca99c4a7686 (major finding, deletion note and the optional test note; read /home/fires/.hud/jobs/j5e7baca99c4a7686/report.md for file:line). (1) pinnedQueueJobs (src/unattended/state.ts ~164-170) adds every item.landed job of a working or paused ordinary queue to `evidence`. A milestone with handback_to main that lands its tickets normally and waits on an unanswered acceptance question is a paused queue with no hold (src/mcp/ticket-queue-step.ts ~1474-1483). Its job directories and land families, including gate logs, then skip normal retention for as long as the queue stays open (src/runtime/watch-runtime.ts ~1082-1088; src/runtime/work-retention.ts ~126-132). This breaks the chores/16 and /18 constraint that ordinary completed jobs keep today's retention. Narrow the evidence pin to a held item's matching manual land. Where review and acceptance need it, also pin the successor item that adopted that manual land, and nothing else. Release on consumption, stop or supersession as before. (2) Deletion: pinnedHeldJobs (state.ts ~184-186) is now only a test projection. Remove it and have tests assert on pinnedQueueJobs(home).held. (3) The satisfied-dependency test in tests/unit/thin-mcp-land-flakes.test.mjs (~1395, ~1433) uses job IDs containing `g`, which JobIndexCache.listJobIds filters out (src/roles/job-index-cache.ts JOB_ID_RE). Use valid hex IDs so the test exercises real claim visibility, and add a second retry before closing the first job so the exactly-once assertion is meaningful.

- [x] Test: an ordinary open queue (working, or paused on a main hand-back with no hold) with a normally landed, never-held item. A retention pass with the clock past JOB_RETENTION_MS archives that job directory and prunes its land family as today
- [x] The existing manual land → retention past JOB_RETENTION_MS → resume test still passes. Review and accept cite a report that still exists, and the evidence is released after consumption, stop or supersession
- [x] pinnedHeldJobs is removed and its tests use pinnedQueueJobs(home).held
- [x] The satisfied-dependency flake test uses valid hex job IDs and asserts that exactly one dispatch happens across two retries before the first job closes
- [x] npm test, npm run test:mjs and check:fixtures pass

## Comments

- Landed in this commit (replay base 1587073ab383f5a8e1233f27fddfa83019a82a66); gate 5/5 passed.
