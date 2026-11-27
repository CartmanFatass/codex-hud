# 10: Execution collector projects review answers, composed pools, fast-forward picks and hand-back prompts truthfully

**Status:** done
**Live try:** none
**Blocked by:** none
**Objective:** interaction

**What to build:** Repair from milestone review jbfcf47999101544f (findings 4, 5, 6, 7 and the optional role note). Producer side only (src/collectors/execution-runs.ts and, where a transition time is missing, the src/mcp writers); renderer fixes are exec-page/11. (4) Active composed main hand-back: src/mcp/composed-step.ts:325–331 writes `{step, ask, choices}`, but execution-runs.ts:992,1137–1140 drops `handback`. Project the recorded hand-back on the run and normalize its prompt to `question` (src/render/execution-run-detail.ts:338–342 reads `question`), so Station Detail on the matching step shows the question and choices; it stays off unrelated stations as /09 intended. (5) Review question answered: the queue runner tells a delivered answer from an open question for the reviewer (src/mcp/ticket-queue-step.ts:1414–1417,1452–1455), but execution-runs.ts:280–298,1193–1201 treats the reviewer's `waiting_orchestrator` as asking. Share the same delivery check used for ticket workers (exec-page/08) for review stations: with an answer file and the lead's recorded `review` answer the station leaves `?` and changedAt is the answer time; a later open question still wins. (6) Composed batch pools: a composed pilot stall leaves item.state=running and records item.stall plus the current pause (composed-step.ts:163–180); execution-runs.ts:1090–1126 counts it as working. Use current stall evidence as the fixed batch path does (a historical stall after resume is not current). Pool changedAt must follow member transitions (start, settle, stall), not only cursor.changed_at; record a member transition time in the composed writer if none exists. (7) Standalone fast-forward land: land-runner.ts:298–313 skips `cherry-pick` for a fast-forward, and execution-runs.ts:911–918 then shows Pick as waiting while the gate runs. Treat a skipped/completed preparation as done (or skipped) once the land is past prepare; Pick is waiting only when preparation has not started. (Optional) execution-runs.ts:348–354 hard-codes repair role `imp`; use the retained repair job's role or the source job's role, absent evidence stays absent. Old records still parse. Collector-level tests per case, each built from records the real writers produce.

- [x] A paused composed `choose` main hand-back with ask "Ship now?" and choices ship/defer projects as a hand-back with question and choices on the matching step; Station Detail on that station shows them; other stations do not.
- [x] A reviewer in waiting_orchestrator with an answer file and the lead's recorded review answer projects review as not asking, changedAt = answer time; a newer open question still projects as asking.
- [x] A composed batch pilot stall projects as stalled/waiting, not working; after resume it is not stalled; pool changedAt advances when a member starts or settles while the step stays running.
- [x] A standalone fast-forward land in its gate step projects Pick as done/skipped, not waiting.
- [x] A frontend-imp land repair projects the frontend-imp role, not imp.
- [x] Old records without new fields still parse; npm test passes.

## Comments

- Landed in this commit (replay base 8e582d79d0d3c57485689a753a6021557a52a5aa); gate 5/5 passed.
