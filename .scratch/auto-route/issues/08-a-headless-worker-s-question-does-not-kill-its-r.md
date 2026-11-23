# 08: A headless worker's question does not kill its running sonic children

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Found live 2026-11-22: land-log/01's headless imp (jfac82c255bad0b73) started sonic j9f55feffc7f77ed5, then called hud_ask; its turn ended at 19:31:12 and the sonic runner died in the same second with no exit receipt (state failed, 'sonic runner exited without an exit receipt', no stderr). Two sonics of a headless imp that never asked survived. So ending a headless turn (ask, or plain turn end) reaps the worker's process tree including detached sonic children. A sonic child is its own job: it must keep running across the parent's turn end, and its result must reach the parent on its next turn (hud_sonic wait / the ready message, as for a pi tab worker; IMP-LEAN-03).

- [ ] Synthetic test: a headless pi worker starts a sonic child, then asks; the child keeps running and settles with its report
- [ ] On the parent's resume (hud_respond), hud_sonic wait returns the child's report; a child that settled while the parent was idle is delivered as a ready message on the next turn
- [ ] Stop (hud_close / panel stop) of the parent still kills the children; a parent that reports and closes leaves no orphan runner
- [ ] The same holds for a headless CLI (claude or agy) worker if they can start sonic children

## Comments
