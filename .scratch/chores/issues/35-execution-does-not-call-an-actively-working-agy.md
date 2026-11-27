# 35: Execution does not call an actively working AGY imp stalled

**Status:** done
**Owner try:** no
**Live try:** Run an AGY imp for 20 minutes and confirm Execution never shows it stalled while it works
**Blocked by:** none

**What to build:** 2026-11-27: Execution showed ticket-store/05's imp (AGY, Gemini Neon) as `◍ 停滞 18分` while its pane showed it editing files and running tests (3/5 steps). The stall label must come from evidence the AGY harness actually produces (pane activity or its native step log), not only from hud-progress heartbeats it rarely writes.

- [x] Test: an AGY job with recent native step-log or pane activity and no progress heartbeat is shown as working
- [x] Test: a job with neither for the stall window still shows stalled
- [x] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments

- Landed in this commit (replay base 368c493845e8ed86a61b7c9fec91cfc43a178db7); gate 5/5 passed.
