# 06: HUD-run checks bound to the report

**Status:** ready-for-human
**Blocked by:** 01

**What to build:** hud_create({checks: [commands]}): after the worker declared the turn finished, a short-lived helper started by the on-demand watcher runs each command in the job's directory with a timeout and writes checks.json (exit code, duration, output tail, report signature). A new turn or rewritten report makes it stale. hud_read and the event line carry the result; the Inspector and job card show a check chip. Commands come only from the main session. Checks never settle, accept or fail a job. Proposal B3.

- [x] A job with checks gets checks.json bound to its final report signature
- [x] A repair turn marks earlier check results stale
- [x] hud_read and hud watch show pass or fail per check
- [x] No resident process beyond the watcher and its short-lived helper
- [x] Main-path tests pass

## Comments
