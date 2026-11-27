# 13: A run waiting for its lead's repair tickets resumes by itself once they are written

**Status:** done
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** 2026-11-26/27, five times (chores, exec-page twice, cold-archive, nav-redesign, workflow): the lead decides repair and adds repair tickets with hud_tickets add, but the edit comes back as a queued receipt, so the accept step finds no ready tickets and the run stops with 'lead requested repair with no ready tickets'. Main then waits for the receipt and starts a new run by hand (resume via hud_respond is refused: no pending hand-back). Make the accept step keep the run in a waiting state bound to the lead's receipt ids (they are in the lead's report/tool calls) and admit the repair round automatically when those receipts complete; if a receipt fails, hand back to main with the reason. A run whose lead added no tickets at all still hands back as today.

- [x] Synthetic run: lead decides repair, its ticket add returns a queued receipt; when the receipt completes, the run admits the new tickets in the same run (repair round counted once) without main.
- [x] A failed receipt hands back to main with the receipt reason.
- [x] Main gets no 'no ready tickets' pause notice in the automatic case; the panel shows the run as waiting for ticket edits.
- [x] A run started by `hud_tickets run` that supersedes an earlier run of the same feature carries its `repair_rounds`, so the two-round cap holds across manual restarts (today every restarted run reports "repair round 0 of 2"; cold-archive reached its fourth review this way).

## Comments

- Landed in this commit (replay base 23eaf5d0c7e924f39bf90b59e10963c0ee242305); gate 5/5 passed.
