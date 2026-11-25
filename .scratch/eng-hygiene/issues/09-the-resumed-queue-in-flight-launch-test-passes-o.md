# 09: The resumed-queue in-flight launch test passes on CI runners

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** `tests/unit/thin-mcp-ticket-queue.test.mjs` test 'a resumed queue waits for a launch still in flight instead of failing it' failed on GitHub CI in 4 of the last 6 runs on universal-hud (runs 45652069659, 45651352954, 45651312871, 45648562443) and passes locally 3/3. It always fails at line 245: after the first ticket is settled, `f.jobs(flow, 2)` never sees the second job within its 15 s bound ('condition did not settle'). The test removes STATUS.json and sets dispatch_exit_code null on the first job to simulate a takeover mid-launch. Find why the queue does not start the second ticket on a slower runner (product bug in the queue's in-flight/settle detection, or a test that depends on timing) and fix the cause, not the bound. Reproduce under load locally (e.g. run the file with CPU stress or many parallel copies) before and after.

- [ ] Root cause stated with evidence (log, trace or reproduction under load).
- [ ] Fix addresses the cause; no larger timeout as the fix.
- [ ] The test passes 20/20 locally under CPU load that made it fail before (or a stated reproduction showing equivalent stress).
- [ ] Land gate passes.

## Comments
