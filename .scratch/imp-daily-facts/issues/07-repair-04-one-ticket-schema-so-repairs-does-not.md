# 07: Repair /04: one ticket schema so repairs does not hide JSON features

**Status:** done
**Live try:** none
**Blocked by:** none

**What to build:** Repairs imp-daily-facts/04: milestone review j4c5b4f646fa5086b Simplicity finding. src/tickets/format.ts keeps its own TicketRecord schema/validateTicketFeature (record object ~:75-86) that lacks `repairs`, while src/tickets/store.ts:93-95 (the writer) accepts it. The object() checker rejects unknown keys, so once any JSON ticket in .hud/tickets/<feature>.json carries a valid `repairs`, src/collectors/ticket-store.ts:80-85 skips the whole feature document (board shows it partial/missing) and src/cli/tickets.ts:37-38 `hud tickets show` reports the feature not found or unreadable, even for unaffected sibling tickets. Remove the duplicate schema instead of adding `repairs` to a second whitelist: the collector, CLI and writer must share one TicketRecord type, one validateTicketFeature, and one brief renderer (renderTicketBrief) that preserves and shows `repairs`. Keep format.ts free of heavy imports if the collector needs that (move the single definition to whichever module both can import cheaply). Add a unit test: a synthetic two-ticket JSON feature where the second ticket has repairs: ['sample/01'] is read by scanTicketStore (all tickets present, not partial) and by `hud tickets show` for both tickets. No store format change.

- [x] Exactly one ticket-feature schema/validator exists; src/tickets/format.ts and src/tickets/store.ts no longer each define a record whitelist.
- [x] A JSON feature with a valid `repairs` on one ticket is read in full by scanTicketStore and by `hud tickets show` (test covers sibling ticket too).
- [x] The rendered ticket brief shows the repairs refs when present.

## Comments

- Landed in this commit (replay base 9c65a4b842036bc8efa5494170a01ee721be3d25); gate 5/5 passed.
