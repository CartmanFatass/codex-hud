# 17: Flake follow-up: resolve pending dispatch against the receipt's ticket, use normal dependency resolution, back off scan errors

**Status:** done
**Live try:** none
**Blocked by:** none

**What to build:** Follow-up of the chores run q795f54a98139d179 after milestone review j93556f4ef956c43a (findings 2 and 3, the deletion note and the non-blocking note; read its report for file:line). (1) Pending-dispatch retry and retention resolve the receipt's ticket by listing only the currently configured flakes.feature (src/mcp/land-flakes.ts ~298-302, ~492-501, ~604-633; src/runtime/work-retention.ts ~135-140). When the configured feature changes, a still-ready ticket under the old feature is marked done without a job. When config is removed, a wontfix ticket's family is never pruned. Separate the two questions. Resolution reads the specific ticket the receipt names, whatever the current config. Dispatch permission follows the current config: if collection is disabled, start no worker, but an independently resolved ticket still prunes. (2) inspectRunningListTicket (~311-313) treats any non-none Blocked by text as blocked, so a running list with a dependency that has already landed never dispatches. Use the normal dependency resolution that ticket readiness uses (src/collectors/ticket-rollup.ts ~90-97), keep the separate claim/terminal check for the receipt, and remove the second dependency rule. (3) findReadyRunningListTicket lists the feature once and then re-lists it for every ticket (~300, ~327-331). Pass the paths it already found instead. (4) If project registration disappears while a flake fallback is pending, scan throws before flakeRetryAt advances and the catch reschedules after 1 ms (src/unattended/service.ts ~140, ~276-279). Clear or back off the stale deadline on scan error.

- [x] Changing flakes.feature while a promoted ticket of the old feature waits neither marks it done without a job nor deletes its evidence; removing the config does not start a worker but lets an independently resolved (wontfix/done/claimed) ticket's family prune (tests)
- [x] A running list whose Blocked by names a ticket that has landed (reference left in place) dispatches exactly one imp when it reaches its threshold (test)
- [x] The collector no longer keeps its own dependency regex and does not list the feature directory again for each ticket
- [x] A scan error with a pending flake fallback backs off instead of rescheduling every 1 ms (test)

## Comments

- Landed in this commit (replay base dd9ecbad35470e5cb40762d5b1431c14d86505ce); gate 5/5 passed.
