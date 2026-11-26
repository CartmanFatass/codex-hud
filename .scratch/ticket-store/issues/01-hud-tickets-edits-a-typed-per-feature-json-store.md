# 01: hud_tickets edits a typed per-feature JSON store without the land lease

**Status:** ready-for-agent
**Owner try:** no
**Live try:** During a running hud_land, call hud_tickets add on a scratch feature and see it return the new ticket number in under a second.
**Blocked by:** chores/13, chores/14, chores/15
**Objective:** ticket-store

**What to build:** Design: docs/design/ticket-store/README.md §1, §2, §5 (D-2026-11-26-06). Build `src/tickets/store.ts`: schema validation for `TicketFeatureDoc`/`TicketRecord`, deterministic 2-space serializer, atomic write under `withAbstractLock('tickets', mainRoot)`, the `ticket-writes.json` hash record under `$HUD_HOME/projects/<hash>/`, and a per-feature read that falls back to `.scratch/<feature>/issues/*.md` when the JSON does not exist. Wire `hud_tickets` `ready`, `add`, `update` (status, blockers, ticks, owner_try, objective, plus new `comment` and spec-field edits) and a new `get` (one ticket or a feature) to the store; new features are created as JSON. These ops no longer take the `main-checkout` lease or run git. `hud_create({ticket})` renders the worker brief from the store with a pure `renderTicketBrief()` (no `brief_file` needed; an old `.scratch` `brief_file` from a queued item is ignored when the store has the ticket). Ticket-queue recovery matches items by `ticket`, not `path` (`src/mcp/ticket-queue-step.ts` ~1144, ~1199). Leave landing records, flakes and commits to ticket-store/02; leave collectors to /03.

- [ ] `hud_tickets` add/update/get on a JSON feature finish without taking the main-checkout lease (test holds the lease and asserts the call returns with the new number)
- [ ] `hud_tickets` ready lists ready tickets from JSON and from not-yet-migrated `.scratch` features
- [ ] `hud_create({ticket})` without brief_file gives the worker the rendered ticket; the rendered text matches a fixture
- [ ] A queue item recorded with an old `.scratch` path still resumes by ticket id
- [ ] Typed edits reject unknown statuses, bad blocker refs and non-existent acceptance ids with a clear error

## Comments
