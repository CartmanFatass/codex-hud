# 13: Flake repair 4: one eligibility authority for running-list admission and a bounded fallback retry

**Status:** ready-for-agent
**Live try:** none
**Blocked by:** none

**What to build:** Repair of chores/01, 04 and 09 after milestone review je1cb09e15e4334b8 (findings 2 and 3, the deletion note and the non-blocking test note; read its report for file:line). (1) With the flake feature under a selected active Objective, the unattended Objective queue (src/unattended/service.ts groupBySelectedObjective ~198-225, ticketReadiness in src/mcp/local-tickets.ts ~323-354) can admit a promoted running-list ticket that the flake collector deliberately left waiting behind an active flake imp (src/mcp/land-flakes.ts ~583-599), so two flake imps run at once. Give both automated admission paths one authority for running-list eligibility (a running-list ticket of the configured flake feature is not admissible while another flake job of that project is active), shared by the collector and Objective/queue readiness. (2) A dispatch refusal that clears without a filesystem change (all imp places quota-exhausted with `no_available_place`, cleared by hand in exhausted.json or expiring by time, src/roles/exhausted.ts ~147-177) never retries because the service gates retries on computeFlakeInputStamp. Add a bounded fallback retry for pending flake collections (e.g. at most one retry per pending receipt per fixed interval on service wakes), whose own writes do not trigger immediate retries (keep the no-write-on-unchanged-result check). With that fallback in place, remove the stamp parts that only existed to approximate refusal clearance (git-ref and all-job stats) where the fallback covers them, keeping the stamp metadata-only and cheap. (3) tests/unit/thin-mcp-land-flakes.test.mjs ~770 exceeded its 60 s deadline on the land gate (test-flakes/13): seed the waiting state for the recovery branches instead of running eight serial lands under one deadline.

- [ ] Test: flake feature selected under an active Objective, imp cap above one, flake imp 01 working, list 02 promoted: 02 has no job until 01 stops, then exactly one job
- [ ] Collector and Objective/queue readiness use the same running-list eligibility function
- [ ] Test: dispatch refused with no_available_place, exhaustion cleared or expired with no new land, job or ticket edit: the pending collection is admitted within the bounded fallback interval
- [ ] A refused retry with an unchanged result writes nothing and does not trigger another immediate retry
- [ ] computeFlakeInputStamp no longer stats every job and git ref when the fallback makes that redundant
- [ ] The flake recovery test no longer runs eight serial lands under one 60 s deadline

## Comments
