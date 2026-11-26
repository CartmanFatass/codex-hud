# 10: Composed workflow repairs from the workflow/06 milestone review

**Status:** ready-for-agent
**Live try:** Via the real stdio MCP in a temp home (tmp/env.sh): plan a cheap build -> check -> hand-back -> land graph whose check fails once, confirm the check reruns only after the source worker's repair report; plan a 3-item batch with breaker first and a failing item, confirm the tail is not admitted (hud_workflow status).
**Blocked by:** none

**What to build:** Fix the blocking findings of `docs/reviews/2026-11-26-workflow-06-milestone.md` (findings 2, 3, 6, 7, 8) in the main-composed workflow code landed by workflow/06 (783f9222, 2ea6a7e5). (a) Finding 6: a check-step repair sent in place to the source worker must wait for a fresh repair turn (new report signature / settlement after the send), not accept the worker's previous settled report; reuse the keyed-turn and report-signature checks in `src/mcp/land-repair.ts` instead of `observeJob` in `src/mcp/composed-step.ts`. (b) Finding 3: composed `batch` steps apply the run's circuit breaker per item before admitting the next item (as `src/mcp/batch-step.ts` does), with grouped failure evidence; reuse that settlement policy instead of the divergent loop in `composed-step.ts`. (c) Finding 2: a run classified cheap must not dispatch more than 2 MiB of Sonic input in total: re-measure at admission and refuse/pause the step with the cost reason when the current aggregate crosses the limit (no new grant path). (d) Finding 7: a composed notice (hand-back wake, end notice) whose delivery failed stays eligible for retry without waiting for unrelated flow activity (`src/workflows/events.ts` stamp cache vs. the claim removed in `panel-delivery.ts`). (e) Finding 8: decide step success with the shared settled-job predicate (`stopped` with a written report counts as done, as in `src/collectors/thin-jobs.ts` and `batch-step.ts`); delete the raw-state override. Keep the run/hash grant recheck, the queued cheap fence and the retiring-driver handoff. Out of scope: the owner-grant issuance boundary (finding 1), the shell basename denylist (4) and refused-dispatch grant refund (5).

- [ ] A failed check repaired in place re-runs only after the source worker's fresh repair report; a test where the worker's prior report exists proves the check does not rerun early.
- [ ] A composed batch with `breaker: first` (and `max_parallel: 1`) admits no further items after the first post-pilot failure; failures are grouped by reason in the run record.
- [ ] A cheap-classified run whose Sonic inputs grow past 2 MiB after planning is refused or paused at admission with the cost reason; nothing over the limit is dispatched.
- [ ] A hand-back wake whose first delivery fails is delivered on a later tick with no other flow activity; no duplicate wake when the first delivery succeeds.
- [ ] A step whose job ends `stopped` with a written report counts as done.
- [ ] Existing workflow-composed, workflow-engine, batch and ticket-queue tests still pass; land gate passes.

## Comments
