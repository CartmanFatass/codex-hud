# 06: Repair 04: directly answered question dedupe keys on the subject job

**Status:** done
**Repairs:** imp-daily-facts/04
**Live try:** none
**Blocked by:** none

**What to build:** Repairs imp-daily-facts/04: milestone review j39f809afec9bd794 Spec finding. In src/mcp/ticket-queue.ts resumeQueueAfterAnswer (~:577-591) the alreadyRecorded checks ignore worker_job. Question numbers are allocated per job (src/worker/qa.ts:66-68), so when a milestone reviewer and a later repair-round reviewer both ask q1, the first `review/q1` answer suppresses the second reviewer's answer decision and the monthly ticket_queue event loses a known decision. Include the subject job in the duplicate key on both branches (ticket item: worker_job === jobId as well as ticket+question; review: worker_job === jobId as well as step+question). Keep repeat delivery for the same job and request idempotent. Decisions recorded before this field existed (no worker_job) should still count as duplicates for the same ticket+question so old receipts do not double-record.

- [x] Two different reviewer jobs on one run that both ask q1 and are answered directly each get their own answer decision with their own worker_job (unit test).
- [x] A repeat answer for the same job and request records no second decision (unit test).
- [x] Existing workflow-ticket-queue and thin-mcp-ticket-queue tests still pass.

## Comments

- Landed in this commit (replay base 7bfec410e91a042b8820a8148ee13960da1826fc); gate 5/5 passed.
