# 05: Ticket edits never starve behind back-to-back lands

**Status:** done
**Owner try:** no
**Live try:** none
**Blocked by:** none
**Objective:** unattended

**What to build:** 2026-11-26, observed live: ticket-edit receipts te…0c, 0d, 0e, 0f, 10 and 11 (adds for imp-daily-facts, cold-archive, workflow, unattended, chores and a select-send status update) stayed `queued` for over an hour while a chain of lands (f76537…, f50dc…, f0420…, fc0f02…) held the main-checkout lease back to back ("waiting for <flow> (gate step 3)"). An earlier receipt (0b) applied, so the drain works, but it never gets a turn: each land hands the lease to the next waiting land. Queue runs and main then act on stale ticket state (a run started before a status update dispatched a ticket against the intended dependency, a duplicate repair ticket landed, a ready ticket waited). Give queued ticket edits priority at every lease handoff: when a land releases or hands over the main-checkout lease and edits are pending, drain them (bounded: the pending batch at that moment, each a small commit) before the next land takes the lease. A land that is mid-gate is not interrupted. JSON-store features (ticket-store) are lease-free and unaffected; this covers Markdown features until their migration.

- [x] With two lands chained back to back and an edit queued during the first gate, the edit commits between the two lands (test)
- [x] Draining is bounded to the edits pending at the handoff; a steady stream of edits cannot starve lands (test)
- [x] A land waiting for the lease after the drain proceeds without a gate rerun caused by the edit commits beyond the usual base-move replay
- [x] docs/reference.md states the order: running land, then pending edits, then the next land

## Comments

- Landed in this commit (replay base 1fe82d15bc9961ec8c40f90da17e2922b6f93ed3); gate 5/5 passed.
