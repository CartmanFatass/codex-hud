# 16: Queue follow-up: a manual land before resume keeps its item, and an ordinary owner hold pins its source job

**Status:** done
**Live try:** none
**Blocked by:** none

**What to build:** Follow-up of the chores run q795f54a98139d179 after milestone review j93556f4ef956c43a (findings 1 and 4; read its report for file:line). (1) Following the hold notice on an ordinary queue (hud_land the held job, wait for success, then hud_tickets run) drops the item: the land moves the ticket to done/ready-for-human, the item is not marked landed, and the successor filters it out via ticketClosed (src/mcp/ticket-queue.ts ~91-98, ~247-255). The resumed run then skips review and accept, and the milestone reports no landed ticket. Keep a held item whose own job has a matching completed land receipt and mark it landed so review/accept cover it. Do not infer a land from ticket status alone. (2) pinnedHeldJobs (src/unattended/state.ts ~112-140) iterates only unattended runs, so an ordinary queue's current, unresolved owner hold does not pin its source job. Retention can archive the job (src/runtime/watch-runtime.ts ~1039-1088), and then hud_land and the worker correction the notice offers are no longer possible. Pin the source job, report and worktree of a current, unresolved ordinary owner hold. Release the pin on resolution or stop, and do not pin superseded predecessors forever. Leave retention unchanged for ordinary completed jobs.

- [x] A single-ticket ordinary queue paused on a hold, then hud_land on the held job completed BEFORE hud_tickets run resume, resumes with the item landed and runs review and accept over it (test covers this order)
- [x] An item is treated as landed only from a completed land receipt for that item's job, never from ticket status alone
- [x] An ordinary paused queue's unresolved owner hold pins its source job past normal retention, and the pin is released when the hold resolves or the run stops or is superseded (test)
- [x] Ordinary completed jobs without a hold keep today's retention

## Comments

- Landed in this commit (replay base dd9ecbad35470e5cb40762d5b1431c14d86505ce); gate 5/5 passed.
