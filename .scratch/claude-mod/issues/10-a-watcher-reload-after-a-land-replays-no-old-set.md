# 10: A watcher reload after a land replays no old settled jobs

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Found live 2026-11-25 ~11:53Z: right after hud_land of je7ef7190b801a766 finished (land `after` runs npm run build; ~/.hud/watch.log shows `reloaded pid=18640` at 11:48:33Z and 11:52:00Z), the Claude mod woke the main session with 18 one-line notices for jobs settled 1-3 days earlier, from other callers, unread but long handled (e.g. j9f55feffc7f77ed5 sonic failed 2026-11-22 19:31, j0817bad77928dded, j7544c49d0cc6a227, j57ca5048f4077813, j39fa0344b03dc64f). claude-mod/07 and 09 promise a first wake of at most one summary line for old unread reports and no replay of history. Find which path emitted them and fix it. Hypothesis to check, not assume: after a build reload the session watch restarts its scan state (empty prev map, lastScanAt -Infinity) but runs with catchup false, so src/cli/watch.ts actionable() treats every row in the bounded window as newly visible (the `notice_mtime < lastScanAt` retention guard never fires) and emits each. Note the earlier 11:48 reload did not produce a burst; explain why.

- [x] Root cause named in the report with the code path, and why the 11:48 reload did not replay
- [x] A test: with 20 old settled unread jobs from other callers, a watcher/runtime reload (the same path a land's after-build triggers) emits no line per old job; at most the existing one summary line
- [x] A job that genuinely settles during or right after the reload is still delivered once
- [x] claude-mod/07 and 09 tests still pass; claude plugin test passes if the mod changes

## Comments

- Landed in this commit (replay base f4a58e13ec09f437087c355542e15ce15625f4a7); gate 5/5 passed.
