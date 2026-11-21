# 05: Project scope and restart recovery

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Jobs belong to a project, not a pane: hud_read({}) and changes are scoped to the caller's project root; a session in the same project adopts jobs whose recorded pane is gone (questions then reach the new session); after a machine restart, a worker that herdr resumed in the job's tab is recognised and kept rather than recorded as failed (seen 2026-11-21: herdr resumed a pi imp and a Claude oracle, HUD had failed both and reaped nothing). Proposal B4 plus restart recovery.

- [x] hud_read({}) lists only the caller project's jobs
- [x] A new session in the same project receives questions and events of jobs whose pane is gone
- [ ] A job whose worker herdr resumed after a restart is shown as working and settles normally
- [x] Main-path tests pass

## Comments
- 2026-11-21 (MCPORCH-05, 86754046): items 1, 2 and 4 landed. Item 3 (restart recovery) stopped under its stop rule:
  after a reboot the watcher sees the dead supervisor and the old worker pid/start time and writes `failed: worker
  exited`, while herdr relaunched the session with a new pid. herdr 0.9.5 exposes tab/pane ids, agent name and an
  optional native session ref, but no proof that the process now in the pane is the job's worker with its settlement
  hooks; pane ids are server-scoped and receipts do not pin the server. A follow-up needs the HUD to record the herdr
  server and the native session id at launch and to reattach the lifecycle writer only on a matching session.
