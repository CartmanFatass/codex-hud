# 24: Resuming a closed CLI tab job does not flash 'supervisor exited' and end the caller's task

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Live 2026-11-22: hud_send to frontend-imp j8a8ba270041f7d3d (claude tab, closed after its report) resumed it as turn 2 at 05:09:59Z with a new supervisor (pid 1890832, alive) and worker (1890597, alive). The caller's MCP task nevertheless completed at once with 'waiting_orchestrator — supervisor exited; worker liveness unknown', then the job went back to working, so the main session will not be woken at turn 2's report. Cause (src/runtime/watch-runtime.ts ~575-605): the watcher read STATUS with the previous turn's supervisor pid, saw it dead, and wrote waiting_orchestrator before the new supervisor published its pid. The resume path must make the watcher ignore the old supervisor (e.g. publish the new supervisor pid / a resume marker before or atomically with the turn, or have the watcher skip a status older than the current turn's sent_at), and the caller's task must stay current until the new turn's report.

- [ ] Synthetic test: closed CLI job + hud_send resume; the watcher never writes 'supervisor exited' for the old pid; status goes straight to working
- [ ] The send's MCP task completes only at the new turn's report
- [ ] A genuinely dead supervisor during a turn still yields the existing waiting_orchestrator reason

## Comments
