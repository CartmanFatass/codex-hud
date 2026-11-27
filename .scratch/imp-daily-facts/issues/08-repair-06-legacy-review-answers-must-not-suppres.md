# 08: Repair /06: legacy review answers must not suppress a later reviewer's answer

**Status:** done
**Live try:** none
**Blocked by:** none

**What to build:** Repairs imp-daily-facts/06: milestone review j4c5b4f646fa5086b Spec finding. In src/mcp/ticket-queue.ts resumeQueueAfterAnswer, the review branch's alreadyRecorded check (~:587-591) treats any `review/q<N>` answer decision without worker_job as a duplicate. Sequence: a round-0 reviewer's q1 answer recorded before worker_job existed, then after upgrade the round-1 reviewer (different review_job) asks q1 and main answers it: no decision is recorded, so the monthly ticket_queue event loses it. Keep the ticket-item branch's legacy ticket+question rule unchanged (it is scoped by ticket). On the review branch, a decision without worker_job may count as a duplicate only when it cannot predate the current reviewer, e.g. its `at` is at or after the current review job's creation time (read from the job record), or an equivalent rule tied to the current review round; otherwise record the new decision with worker_job. Repeat delivery for the same job and request stays idempotent, and two modern reviewers both asking q1 still each record one decision. Add a test of the mixed-version sequence (legacy round-0 review/q1 decision without worker_job, then a different round-1 reviewer's q1 answer -> recorded once) plus legacy repeat delivery for the current reviewer (-> not double-recorded).

- [x] A legacy review answer decision without worker_job that predates the current reviewer job does not suppress that reviewer's answer decision.
- [x] Repeat delivery for the same reviewer job and question records one decision, including when the earlier record lacks worker_job and belongs to the current reviewer.
- [x] The ticket-item branch's legacy ticket+question rule is unchanged; unit test covers the mixed-version sequence.

## Comments

- Landed in this commit (replay base 810a146a55ff0c0b6d76e6d880590a787eb55730); gate 5/5 passed.
