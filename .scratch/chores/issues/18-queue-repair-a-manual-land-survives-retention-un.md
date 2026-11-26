# 18: Queue repair: a manual land survives retention until resume, and a missing ticket file does not release an ordinary hold

**Status:** ready-for-agent
**Live try:** none
**Blocked by:** none

**What to build:** Repair of chores/16 after milestone review j3a2a5f54c81b5ff9 (findings 1 and 2; read /home/fires/.hud/jobs/j3a2a5f54c81b5ff9/report.md for file:line). (1) Resume adopts a held item's manual land only from a live land receipt (src/mcp/ticket-queue.ts ~248-260 via completedLandForJob). Once that land completes, pinnedHeldJobs releases the job pin (src/unattended/state.ts ~145-152). Job retention is 1 day (src/runtime/work-retention.ts JOB_RETENTION_MS), so if the owner lands a held ticket and resumes more than a day later, the report and then the land receipt can be pruned (src/runtime/watch-runtime.ts ~1081-1088; work-retention.ts ~126-145). The closed ticket is then filtered out and a single-ticket run skips review and acceptance. Keep the evidence until the successor consumes it. Either record the matching job/land on the paused queue when it is observed, or retain the small land receipt and the source job report (not the whole checkout) while a current, unsuperseded, unstopped queue still holds that item. Release on resume consumption, stop or supersession. (2) pinnedHeldJobs uses itemClosed, which treats a missing ticket path as closed (state.ts ~57-64). Ordinary resume uses ticketClosed, which treats it as open (ticket-queue.ts ~91-98). If a branch switch temporarily hides the ticket, the pin can drop during a scan while resume still offers hud_land/correction on the job that was deleted. For ordinary holds, use the same positive closure evidence in retention and in resume: a missing or unreadable path is neither a stop nor a land. Leave unattended hold semantics unchanged unless they share the helper safely.

- [ ] Test: ordinary single-ticket queue paused on a hold, hud_land completes, a retention pass runs with the clock advanced past JOB_RETENTION_MS, then hud_tickets run resumes. The item is landed and review and accept run over it, and the report they cite still exists
- [ ] After the successor consumes the land (or the run is stopped/superseded), the retained receipt/report is released and normal retention applies
- [ ] Test: an ordinary held item whose ticket file is temporarily missing during a retention pass keeps its source job pinned. Retention and resume agree that the item is not closed
- [ ] Ordinary completed jobs without a hold keep today's retention, and unattended hold behaviour is unchanged
- [ ] npm test, npm run test:mjs and check:fixtures pass

## Comments
