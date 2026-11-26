# 06: Lead-handback queues route assumption pauses to the temporary lead

**Status:** ready-for-agent
**Owner try:** no
**Live try:** the next lead-handback queue whose worker reports a scope assumption lands without a main wake
**Blocked by:** none
**Objective:** unattended

**What to build:** Seen 2026-11-26: with handback_to lead, ordinary (non-unattended) queues still pause on every scope-tagged or more-than-three Assumed: report and wake main (home-tidy runs q51db309e76ba5885, q71df56305cab4911: two pauses for reasonable assumptions; main resumed each by hand). unattended/03 already routes these to a temporary one-decision lead, but only when q.unattended (src/mcp/ticket-queue-step.ts deferAssumptions ~960). Make the routing depend on the hand-back target instead: any queue whose effective hand-back is lead (default, or handback_to lead) sends assumption triggers to the same temporary lead (continue lands; hold for a visible deletion or spec change becomes an owner request; otherwise repair), and only handback_to main keeps the main breaker. Keep one code path with unattended. Update docs/reference.md (the sentence saying assumptions pause the run without waking main).

- [ ] A non-unattended queue with lead hand-back sends a scope assumption to a temporary lead and lands on continue, with no main notice (test)
- [ ] handback_to main keeps the existing pause (test)
- [ ] Unattended behaviour unchanged (existing tests pass)

## Comments
