# 12: Ticket activity: batch members keep their own settle time; a land repair asking for help is the row's status and Enter target

**Status:** done
**Live try:** 项目 → interaction → nav-redesign: tickets from one batch run show their own settle ages, not the batch end; a ticket whose land repair is waiting for an answer shows that repair and Enter opens its Inspector
**Blocked by:** 10
**Objective:** interaction

**What to build:** Repair of milestone review ja67e5bad2d6abc9c findings 1, 2 and its second optional item (nav-redesign/10). (1) src/collectors/execution.ts ~281–291 emits an `ended` ticket activity at `run.endedAt` for every ticket-linked member of a finished non-queue run, on top of the worker's own observation (~293–306). A member that settled four hours ago reads as finished 5 minutes ago when the last member finished then, and old outcomes re-enter the ≤ 24 h window. Delete that per-member loop (keep the run end on the run itself); do not add another timestamp precedence rule. (2) src/collectors/execution.ts ~241–252 picks a standalone land's first `running` node, else its first node with progress. In src/collectors/execution-runs.ts ~893–912 an active repair waiting for an answer is `asking` while an earlier gate/repair still carries progress, so the ticket row shows the old gate/repair and Enter (and g/P/H) target the source job or previous attempt instead of the worker asking. Use the land receipt's current step and repair attempt for both the shown status and the execJob target. Optional (include): src/collectors/execution-runs.ts ~404–407 returns early for a legacy `{landed: true, land: …}` queue item without item timestamps, skipping the directly referenced land header read below; if that header is available use its `landed_at` before falling back to undated (no archive scan).

- [x] Two ticket-linked members of one non-queue run settling at different times each show their own age; a member settled > 24 h ago does not re-enter the window because the run ended recently (test)
- [x] A standalone land whose second repair (distinct job ID) is asking for an answer while an earlier gate/repair carries progress shows the asking repair's status, and its row's execJob is that repair worker (test)
- [x] A legacy landed queue item with a readable land header uses the header's landed_at; without it the item stays done and undated (test)
- [x] npm test, test:mjs and check:fixtures pass

## Comments

- Landed in this commit (replay base b132dbdcfe564684ed0009c22aa7fef54b366082); gate 5/5 passed.
