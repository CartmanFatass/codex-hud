# 33: A restarted queue run supersedes the older run of the same feature

**Status:** ready-for-agent
**Owner try:** no
**Live try:** Restart a paused feature run with hud_tickets run and confirm Execution shows only the new run
**Blocked by:** none

**What to build:** 2026-11-27 live try: Execution showed "2 运行中 22 等待中". 20 of the 22 waiting runs were paused or failed runs whose feature already had a newer run started by `hud_tickets run` (restart after an escalation or report-gate pause). Main had to cancel each by hand. When `hud_tickets run` starts a run for a feature that already has a paused run, the older run must end as `superseded` (terminal, not counted as waiting, its todo/decisions carried into the new run as today). Failed runs whose feature has a newer run must not count as waiting either.

- [ ] Test: starting a run for a feature with a paused run marks the old one terminal `superseded`, and the Execution waiting count drops by one
- [ ] Test: a failed run older than a newer run of the same feature is not counted as waiting and does not render as a flow on Execution
- [ ] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments
