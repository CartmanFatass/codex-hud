# 19: Flake repair: an unavailable checkout keeps a pending receipt, and the changed-feature branch drops its duplicate rollup

**Status:** ready-for-agent
**Live try:** none
**Blocked by:** none

**What to build:** Repair of chores/17 after milestone review j3a2a5f54c81b5ff9 (finding 3 and the deletion note; read /home/fires/.hud/jobs/j3a2a5f54c81b5ff9/report.md for file:line). (1) inspectRunningListTicket maps a missing issues directory or ticket file to 'resolved' (src/mcp/land-flakes.ts ~202-210 listFeatureTickets returns [] for an absent dir; ~343-348; the ENOENT catch in inspectRunningListEntry). hasPendingFlakeCollection (~678-685) then returns false, so housekeeping deletes the pending receipt and gate log when the project checkout is only temporarily unavailable, with no job claim and no terminal status read. Distinguish unavailable evidence from observed resolution. Resolution needs a readable ticket with terminal/claimed/landed evidence or a job claim. An unreadable or missing checkout, issues dir or ticket keeps the family (and does not dispatch). (2) Deletion note: the changed-feature branch (~523-539) runs a full dependency rollup and duplicates the blocked/ready branches even though neither may dispatch. A claim/terminal check alone decides resolved vs 'waiting for configured flakes feature'; remove the rollup there. On the permitted-dispatch path, a missing rollup entry falls back to raw 'Blocked by' text (~324-326). Treat missing readiness evidence as non-dispatchable and remove that second rule.

- [ ] Test: a pending dispatch receipt whose project checkout or ticket file is unavailable keeps its receipt and gate log through a retention pass past the cutoff
- [ ] Test: with flakes config removed, a readable wontfix ticket still releases (prunes) the family
- [ ] The changed-feature branch no longer computes a dependency rollup. It returns resolved or waiting from the claim/terminal check alone (existing changed-feature tests still pass)
- [ ] On the dispatch path a ticket missing from the rollup is not dispatched, and the raw Blocked-by fallback is gone
- [ ] npm test, npm run test:mjs and check:fixtures pass

## Comments
