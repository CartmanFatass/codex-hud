# 07: Repair ticket-store/03: one ticket schema and brief renderer for writer, collector, CLI and worker

**Status:** done
**Live try:** Write a feature through hud_tickets with one repair ticket (`repairs` set) and one flake-list ticket with `cases`, in a scratch project with `.hud/tickets/`. `hud tickets show <feature>` prints both tickets (Repairs line and cases included), `hud board` and the panel's Feature/Execution pages list every ticket in that feature, and `hud tickets show <feature>/<NN>` matches the brief hud_create gives the worker byte for byte.
**Blocked by:** none
**Repairs:** ticket-store/03
**Objective:** ticket-store

**What to build:** Milestone review jdda9ed49fe952627 finding 1 (~/.hud/jobs/jdda9ed49fe952627/report.md). `src/tickets/format.ts` is a second copy of the v1 schema and `renderTicketBrief()`; it does not declare `repairs` (written by `src/mcp/ticket-store-ops.ts:147-151`, accepted by `src/tickets/store.ts:95`) and its renderer omits flake-list `cases` that `store.ts:318-335` renders. Because the object validator rejects unknown fields, `src/collectors/ticket-store.ts:81-83` drops a whole feature as unreadable as soon as one ticket has `repairs`: the board loses sibling tickets, Execution loses store facts, and `hud tickets show` says the feature is not found. Fix: delete the duplicate. Keep exactly one schema/validator/serializer/`renderTicketBrief()` (in `store.ts` or `format.ts`, whichever keeps the collector free of MCP imports) and have the MCP writers, `src/collectors/ticket-store.ts`, `ticket-evidence.ts`, `src/cli/tickets.ts` and the hud_create brief path import it. No adapter layer.

- [x] Only one TicketFeatureDoc schema/validator and one renderTicketBrief() exist under src/; every reader and writer imports it
- [x] A feature written via the hud_tickets add path with a `repairs` ticket and a flake-list ticket with `cases` is collected in full (no partial/unreadable marker) and shown by `hud tickets show`
- [x] Test: `hud tickets show <feature>/<NN>` output equals the brief text hud_create sends for the same ticket, including Repairs and cases

## Comments

- Landed in this commit (replay base f732205141c3252e1830424af0d7bcb7e9f9df90); gate 5/5 passed.
