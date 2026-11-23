# 06: Tickets are the only slice ledger; STATE keeps notes

**Status:** done
**Owner try:** no
**Blocked by:** 02

**What to build:** Owner approved (D-2026-11-22-27). Panel progress (Project Progress bar/legend, to-do counts, Latest) reads tickets (and land records), not STATE `## Slices` rows; STATE.md keeps only `Milestone:`, `## Now`, `## Waiting for the owner`, `## Next` and short notes. Move the accepted slice rows of docs/handoff/STATE.md into docs/handoff/archive/ (one file), leave a one-line pointer. Update state-ledger/ticket-rollup collectors, spec §2.2.4 lines about STATE slices, docs/delegation.md and the hud-handoff skill if they tell the main session to maintain slice rows. Report the visible changes on Project.

- [x] Project progress and counts come from tickets; STATE slice rows are not read
- [x] STATE.md ≤ a few KB with the archive pointer
- [x] Waiting items and Milestone still read from STATE
- [x] Spec, delegation doc, skill text updated; tests pass

## Comments

- Landed in this commit (replay base 046f1d0d8c397e1b4ea4b5b535f1c5517e11d078); gate 5/5 passed.
