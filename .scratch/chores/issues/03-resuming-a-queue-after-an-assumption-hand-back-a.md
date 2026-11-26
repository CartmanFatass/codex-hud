# 03: Resuming a queue after an assumption hand-back accepts that report

**Status:** done
**Owner try:** no
**Live try:** main's next handback_to main queue that pauses on an assumption resumes into a land with one hud_tickets run call
**Blocked by:** none
**Objective:** unattended

**What to build:** Seen 2026-11-26 on the first handback_to main queue (chores/02, runs q2876112b098b4035 then qb3c4a7a7396486b7): a scope-tagged Assumed: line paused the queue with kind assumption; main read the report, judged the assumptions fine and resumed with hud_tickets run; the resumed run re-judged the same settled report and paused again, so the only way through was a manual hud_land. Main's resume after an assumption hand-back is main's acceptance of exactly that report: record it on the item (the existing approved_assumptions_head / approved_assumptions_sig fields unattended/03 added) when the resumed queue is started from a paused run whose handback kind is assumption, and have the non-unattended settlement judge skip the assumption breaker for an item whose current report signature (and source head) match. A new worker turn (different report signature or head) is judged again. Blocker pauses stay as they are (a Blockers: line still needs a worker turn). Also check that hud_tickets run cancel works on a paused ordinary feature queue (it returned queue_not_running on the pre-unattended/03 MCP); if unattended/03 already covers it, add a test only.

- [x] A feature queue paused on a scope assumption, resumed once with hud_tickets run, lands that item without a second pause; the todo keeps the assumed lines
- [x] A new worker turn after the resume is judged again by the assumption breaker
- [x] Blocker pauses behave as before
- [x] hud_tickets run cancel on a paused ordinary feature queue cancels it (test)

## Comments

- Landed in this commit (replay base b184f0012516328a0d26bf1007635cdb372ec0a4); gate 5/5 passed.
