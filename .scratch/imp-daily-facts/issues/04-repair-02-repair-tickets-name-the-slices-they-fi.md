# 04: Repair 02: repair tickets name the slices they fix, and decisions keep their known subject worker

**Status:** ready-for-agent
**Live try:** none
**Blocked by:** none

**What to build:** Repairs imp-daily-facts/02 (milestone review je6beab56fe18b3fe findings 1-2); its acceptance item 1 was deferred until ticket-store/06, which has now landed (7cff64d0). (1) Add optional repairs: string[] (canonical <feature>/<NN> refs, validated like blocked_by: reject malformed and unknown refs) to TicketRecord (src/tickets/store.ts) and to hud_tickets add/update (src/roles/tool-definitions.ts, src/mcp/ticket-store-ops.ts), on the landed JSON store and the Markdown path it still serves. Copy repairs onto q.tickets[] at admission (src/mcp/ticket-queue-step.ts, next to round) so the monthly ticket_queue event in src/runtime/work-retention.ts carries it. Require repairs when the lead chooses Decision: repair: src/mcp/workflow-lead.ts and packages/hud-mcp/instructions/lead.md say repair tickets must set repairs to the slice(s) they fix. Document the field in docs/reference.md. (2) Set worker_job on decisions whose subject worker is known: the main-resumed blocker in src/mcp/ticket-queue.ts (~:341, use item.job), the directly answered worker question (~:499, the jobId used to find the item), and the tickets-step handback (~:437) when cur.handback records a subject. Leave worker_job absent for genuinely run-wide acceptance.

- [ ] hud_tickets add with repairs ['<feature>/<NN>'] targeting an existing slice B (with sibling A) stores it, and admission copies it onto q.tickets[]; the archived ticket_queue event line carries repairs naming B, not A (test)
- [ ] hud_tickets add rejects an unknown or malformed repairs ref with a clear error (test)
- [ ] lead.md and workflow-lead.ts state that Decision: repair requires repair tickets with repairs set (test or doc check)
- [ ] main-resumed blocker, directly answered worker question and subject-bearing tickets handback decisions record worker_job; run-wide accept decisions do not (test)
- [ ] npm test, npm run test:mjs and check:fixtures pass

## Comments
