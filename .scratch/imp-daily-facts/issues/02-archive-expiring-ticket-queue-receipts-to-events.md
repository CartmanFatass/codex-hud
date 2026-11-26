# 02: Archive expiring ticket-queue receipts to events JSONL and attribute repair tickets to slices

**Status:** done
**Owner try:** no
**Live try:** none
**Blocked by:** ticket-store/01

**What to build:** Design: oracle report j4a570e7da6899cf2. Today pruneLandFlows (src/runtime/work-retention.ts:95-116) unlinks terminal flows/q*.json after 1 day with no archive, erasing lead acceptance and milestone review history. Add optional repairs: string[] (canonical <feature>/<NN> refs fixed by a repair ticket, validated like blocked_by) to TicketRecord and hud_tickets add (src/tickets/store.ts, src/roles/tool-definitions.ts), and require repairs when choosing Decision: repair in src/mcp/workflow-lead.ts and packages/hud-mcp/instructions/lead.md. Stamp round and optional repairs onto TicketQueueItem, worker_job onto RunDecision, and resolved {base: q.start_head, head} fallback onto ReviewRecord in src/mcp/ticket-queue-state.ts and src/mcp/ticket-queue-step.ts. In pruneLandFlows, claim q<id>.json.archived with wx and append one prose-free {v:1, kind:'ticket_queue', flow, project, feature, state, created_at, updated_at, repair_rounds, tickets, decisions, reviews} line to $HUD_HOME/events/YYYY-MM.jsonl (0600) before unlinking an expired q*.json receipt; document in docs/reference.md.

- [x] hud_tickets add validates optional repairs refs, rejects unknown/malformed refs, and ticket-queue admission copies round and repairs onto q.tickets[]
- [x] pruneLandFlows appends exactly one prose-free kind:'ticket_queue' event to events/YYYY-MM.jsonl before unlinking an expired terminal q*.json (no reason, verdict, summary or todo prose; failed unlink never duplicates the event)
- [x] Milestone review records resolved {base, head} commit SHAs on q.reviews[] from q.start_head..HEAD when the reviewer omitted reviewed

## Comments

- Landed in this commit (replay base 126161761018d7b8f0c858346a43dab21076c3f1); gate 5/5 passed.
