# 01: A worker closes at its report and can be resumed for 27 minutes

**Status:** ready-for-agent
**Blocked by:** none
**Owner try:** no

**What to build:** Owner 2026-11-22: many workers sit idle after finishing. Today (spec §2.1 line ~107, src/runtime/cli-supervisor.ts reportRead, src/mcp/pi-read-settlement.ts) a settled worker closes only when main reads its report with hud_read; otherwise it stays until its idle deadline (CLI 600 s, pi per cache lifetime). Main now mostly learns results from the MCP task notification (summary included) and lands with hud_land without a hud_read, so finished workers idle for the whole grace.

Owner's rule (2026-11-22, replaces the delivery idea): the worker closes when it declares its report (hud_report settles the turn), not when main reads it. Its process and tab/pane go at once, freeing the place. For `resume_s` (role field, default 1620 s = 27 min, under the 30-min cache lifetime) after that, a hud_send to the job resumes the same native session (pi session file, Claude/Codex resume id, agy conversation id) in a new pane with the same cwd/worktree, so context and the provider cache are reused; after resume_s, or if the session cannot be resumed, hud_send itself falls back to today's repair job (old brief + report). hud_land repairs use the same path. A worker with an open hud_ask question has not reported and keeps waiting as today. Idle grace for settled workers goes away (keep it only for a quiet worker with no report, the existing quiet rule). Draft the spec §2.1 sentence replacing "An unread report puts a continuable worker in idle grace. Close a settled worker as soon as main reads its report; else keep it until its idle deadline." for the main session to tell the owner.


Exit guards (owner asked whether hud_report is the only end and whether other exits leave holes): close at report only when all hold: a valid current-turn declaration (done receipt + fresh report signature, or pi native settlement plus changed report); the worker's turn has ended (pi settled / CLI agent idle), waiting at most 120 s after the declaration so a worker that reports early and keeps editing is not cut off; no open hud_ask question; no open or uncollected sonic child (the existing collect prompt runs first). Every other exit keeps today's rule and must be listed with a test in one exit matrix: process gone or tab closed before a report (failed), dispatch rejected (failed), quiet with no report (Decision API: wait, fixed write-the-report prompt, fail on a quoted quota line, or hand to main), report written by hand without hud_report (no declaration: quiet rule), turn ended in chat without a report (quiet rule), hud_close / panel stop (stopped), headless sonic exit without a report (failed), and a rewritten report or a new turn after declaration (invalidates; no close).

- [ ] A pi and a CLI (claude or agy) job close process and pane right after hud_report, read or not
- [ ] The MCP decides resume vs repair by the clock and session check alone; the caller only calls hud_send and the result says which happened
- [ ] hud_send within resume_s resumes the same session (same session id, cwd and worktree) and the reply comes back as a new turn of the same job; after resume_s it becomes a repair job
- [ ] hud_land's gate repair resumes the source session the same way
- [ ] The exit matrix above has one test per row, and the report lists any exit found in the code that the matrix misses
- [ ] npm test and check:fixtures pass

## Comments
