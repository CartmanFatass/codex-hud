# 09: Repair /04: one Markdown repair-ref parser keeps none-prefixed feature refs

**Status:** done
**Live try:** none
**Blocked by:** none
**Repairs:** imp-daily-facts/04

**What to build:** Repairs imp-daily-facts/04: milestone review jc672ee56962100ba Spec finding 1. The two Markdown readers of `**Repairs:**` (src/tickets/store.ts ~:314-319 and src/mcp/local-tickets.ts ~:335-340) each drop an item when `/^none\b/` matches, and `\b` matches before the hyphen, so a valid canonical ref such as `none-theme/01` (or `none/01`) passes add-time validation, is written to the header, and is then discarded on read: `get` loses it and queue admission archives the repair as unattributed. Replace both copies with one shared Markdown repair-ref parser (in a module both can import cheaply) that skips only the standalone sentinel `none` (optionally followed by a parenthetical note), keeps any canonical `<feature>/<NN>` ref including features named `none-...`, and resolves bare `NN`/`#NN` against the current feature as today. Add a unit test with a synthetic feature where a ticket's `**Repairs:**` is `none-theme/01` (with an existing `none-theme/01` ticket): it survives add -> read (both readers) -> queue admission onto q.tickets[].repairs; and a header of `none` still yields no repairs. No store format change.

- [x] One shared Markdown repair-ref parser is used by src/tickets/store.ts and src/mcp/local-tickets.ts; the duplicate copies are gone
- [x] A canonical `none-theme/01` repair ref survives add -> read in both readers -> admission onto q.tickets[].repairs (unit test)
- [x] A `**Repairs:** none` header still yields no repairs (unit test)

## Comments

- Landed in this commit (replay base d0995cafb79fb18a31cb14aedbbb8c879a02d804); gate 5/5 passed.
