# 05: Project scope and restart recovery

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Jobs belong to a project, not a pane: hud_read({}) and changes are scoped to the caller's project root; a session in the same project adopts jobs whose recorded pane is gone (questions then reach the new session); after a machine restart, a worker that herdr resumed in the job's tab is recognised and kept rather than recorded as failed (seen 2026-11-21: herdr resumed a pi imp and a Claude oracle, HUD had failed both and reaped nothing). Proposal B4 plus restart recovery.

- [ ] hud_read({}) lists only the caller project's jobs
- [ ] A new session in the same project receives questions and events of jobs whose pane is gone
- [ ] A job whose worker herdr resumed after a restart is shown as working and settles normally
- [ ] Main-path tests pass

## Comments
