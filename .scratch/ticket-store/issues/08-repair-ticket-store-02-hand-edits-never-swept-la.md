# 08: Repair ticket-store/02: hand edits never swept, landing records never silently skipped, acceptance and readiness failures surfaced

**Status:** done
**Live try:** In a scratch JSON-store project: (a) hand-edit ticket A in its feature JSON, then let a HUD write update ticket B in the same feature and run `hud tickets commit`; `git show HEAD` contains B's change and not the owner's edit to A. (b) Leave a hand edit (valid, then malformed) in the feature of a ticket that hud_land is landing; the land either refuses before main moves, naming the file, or finishes with the ticket recorded done; it never reports a completed land while the ticket stays ready-for-agent, and never leaves publish_pending with no retry. (c) Break one feature JSON; `hud_tickets ready` reports that slug as unreadable/partial instead of plain ok with no tickets.
**Blocked by:** 07
**Repairs:** ticket-store/02
**Objective:** ticket-store

**What to build:** Milestone review jdda9ed49fe952627 findings 2-5 plus the optional doc note (~/.hud/jobs/jdda9ed49fe952627/report.md). (2) The sweep hash only protects against hand edits made after the last HUD write: `src/mcp/local-tickets.ts:505-519,545-553` and `src/mcp/land-flakes.ts:515-518,578-585` read the owner's on-disk bytes, change another ticket, and `src/tickets/store.ts:198-208` records the hash of the combined document, so `src/tickets/commit.ts:94-123` then commits the owner's edit. Track whether the input bytes were sweep-eligible (on-disk hash matched `ticket-writes.json` or the file was clean in git) before writing; if not, write without marking the file sweepable. (3) `src/mcp/land-records.ts:51-60` silently skips the landing record when the landing feature has an uncommitted hand edit, yet `land-runner.ts:412-425` reports success, so the store keeps the ticket ready-for-agent and a queue could run it again; malformed hand-edited JSON throws after ff and leaves `publish_pending` (`land-state.ts:55`). Detect an unresolvable hand edit on the landing feature before moving main (refuse with a clear message naming the file), or make the records step durable and retryable; update `tests/unit/thin-mcp-ticket-commits.test.mjs:139-155`. (4) `src/mcp/ticket-queue-step.ts:1685-1693,1737-1744` swallows a failed acceptance write (e.g. a feature pushed over 64 KiB by the receipt) and records finish; keep "receipt persisted, commit deferred" as success, but a receipt that was not persisted must be retried or held with the ticket ID visible on the run. (5) `src/mcp/local-tickets.ts:353-365` turns a malformed canonical feature into `tickets: []` and `readyTickets` (:158-160) reports plain ok; keep healthy features available but return the unreadable slug(s) as a partial/diagnostic to readiness callers. Also remove the stale statements at `docs/reference.md:392,400` (priority queue for Markdown edits, separate main-checkout commit per flake). Optional if small: bind the post-ff amend in `src/tickets/commit.ts:131-155` to the expected tip.

- [x] Test: hand edit to ticket A, HUD write to ticket B, commit -> the owner's edit is absent from git and still on disk
- [x] Test: land with a valid and with a malformed hand edit in the landing feature -> no land is reported complete with the ticket unrecorded, and no publish_pending without a retry path
- [x] Test: acceptance receipt that cannot be persisted is retried or held with the ticket ID, not recorded as a clean finish
- [x] Test: hud_tickets ready with one malformed feature returns the healthy features plus that slug flagged unreadable
- [x] docs/reference.md no longer promises a Markdown priority queue or a per-flake main-checkout commit

## Comments

- Landed in this commit (replay base 2a517ffc5cc3b25bf58f08137340db7d9bfe94e5); gate 5/5 passed.
