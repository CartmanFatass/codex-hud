# 02: Close a settled job's worker once its report is read

**Status:** ready-for-agent
**Blocked by:** 01

**What to build:** Owner, 2026-11-17 (option A): a finished worker no longer waits out its 10–30 minute idle window
after the main session has read the report. Reading it (`hud_read` marking `report_unread` false) closes the worker's
tab and process the way the idle deadline does today; a repair is a new job.

- [ ] A settled job (pi or CLI) whose report the main session has read is closed within one supervisor tick, with
      the same close path and STATUS outcome as an idle-deadline close (`exit_reason` says it was read).
- [ ] Unread reports keep today's idle deadline. A live child process (ticket 01) still blocks the close.
- [ ] `hud_send` to a job closed this way returns `not_continuable` as for any closed job.
- [ ] docs/reference.md, the MCP README and `integrations/skills/hud-delegate/SKILL.md` (Repairs, step 6) say reading
      the report closes the worker; continuation is only for unread or still-working jobs.
- [ ] Main-path tests (temp homes, fake CLI/pi): read → closed; unread → stays until deadline; read with a live
      child → stays.

## Comments
