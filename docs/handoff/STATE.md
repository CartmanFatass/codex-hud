# State of the universal-hud effort (2026-11-23)

Milestone: pivot M1 (take workers off the owner's desk) and M2 (see load without the panel); 0.2.0 is the baseline

[Archived slice rows](archive/STATE-slices-2026-11-22.md); current progress lives in the tickets and land records.

Older handoffs: [2026-11-03 to 11-14](archive/STATE-2026-11-03-to-11-14.md), [2026-11-18](archive/STATE-2026-11-18-now.md). Other history: [documentation archive](../archive/).

## Now

- The product pivot is in `docs/spec.md` (D-2026-11-23-03): HUD is the operational workbench (execution, load,
  Objectives, owner requests), toktrack does history and insights. The owner approved all 23 removals in its
  "Removed by this spec" checklist; drafts and reviews are in `tmp/tasks/spec-pivot/`.
- Imp defaults to the `sol` preset with routing off; the owner configures placement and uses `even` to balance
  subscriptions (D-2026-11-22-30). Reviewer runs on `astra`.
- toktrack (separate repo) is landing the hud-insight pages and the 27-slice overhaul through ticket queues.

## Waiting for the owner

(none)

## Next

- M1 (six slices) and M2 (two slices) have landed. The milestone review (reviewer, astra) is running; one implementer
  fixes its blocking findings, then the orchestrator accepts M1/M2 (live check so far: both bars show the same
  machine-wide counts and WSL load; explicit STATE requests reach the board ordered work-waits first).
- `toktrack-facts/03` (archive keeps flow and question facts) still has to land; its gate failed on machine load.
- Grill the Objective file syntax before M3.
- Older follow-ups (`panel-polish/01–04`, `native-statusline/04`, `land-log/02`) are re-checked against the new spec
  before they run.
