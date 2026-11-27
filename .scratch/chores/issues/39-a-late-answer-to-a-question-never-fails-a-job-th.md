# 39: A late answer to a question never fails a job that already reported

**Status:** ready-for-agent
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** 2026-11-27: imp jf33687c6d908554c (pi tab, herdr-fork/32) asked q2 at 22:33, kept working, committed and published a valid report (q2 moot). Main's answer landed at 22:43:07; it was delivered as a new turn, the turn ended without a new report, and at 22:43:14 `src/harness/pi/worker/tab-lifecycle.ts` settled the job `failed: output missing, empty or unchanged`. hud_land then refused the job (state failed) and main had to land by hand. An answer that arrives after the worker published a report for the turn that asked must not turn a reported job into failed: either deliver it without starting a turn that needs a new report, or settle that turn as `settled` when the earlier declared report stands (answer recorded as moot).

- [ ] Test: question asked, report published, answer arrives afterwards -> job stays done/idle_grace with the report, and hud_land accepts it
- [ ] Test: a question answered before the report still resumes the turn as today
- [ ] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments
