# 01: A worker resumed without HUD_JOB_DIR does not get main-session tools

**Status:** done
**Blocked by:** none

**What to build:** From docs/neon-proposal/19-hud-restart-recovery.md §1 finding 2 only (owner 2026-11-22: restart recovery stays manual, add this guard). After a restart herdr resumes a worker without HUD_JOB_DIR; src/mcp/thin-main.ts:46-48 then sets isWorker=false and the resumed worker sees hud_create/hud_close/hud_send etc.; pi's hud.mjs installs the delegate surface. Guard: when hud-mcp (and the pi extension) start without HUD_JOB_DIR but the calling session matches a known worker job (agent_session_id / session file recorded in $HUD_HOME/jobs/*/STATUS.json, or the herdr pane recorded for a job whose state is not settled), refuse the main-session tools with a clear message naming the job and saying recovery is manual. No relaunch, no kill, no new resident work; one bounded lookup at server start.

- [x] Synthetic test: a session id recorded for a worker job gets no main-session tools and a clear refusal; a normal main session is unaffected
- [x] No extra cost for main sessions beyond one bounded read at start; npm test passes

## Comments

- 2026-11-22 main: landed 66401d79. Integration fix: the guard is silent on a clean miss or a missing jobs directory (it had printed on every main-session start, breaking 183 stderr-empty tests when run from Claude Code); the test harness drops the caller's CLAUDE_CODE_SESSION_ID.
