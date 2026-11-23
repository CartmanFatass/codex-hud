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

- Slice and dispatch M1 and M2. M1 first decouples Inspector, project-view and inbox from work-card/work-lanes, moves
  the Control strings out of `split-i18n.ts` and has `hud_land` default to `done`. M2 adds a queued count to the
  work summary, reads the global count in the statusline and keeps a prior `/proc/stat` sample for CPU%. Facts with
  file:line: `tmp/tasks/spec-pivot/review-carbon.md` §2/§4 and `review-astra.md`.
- Grill the Objective file syntax before M3.
- The archive row lacks fields toktrack expects (flow `created_at`, flaky names, `dispatcher`; review-carbon §2
  item 5); not ticketed yet.
- Older follow-ups (`panel-polish/01–04`, `native-statusline/04`, `land-log/02`) are re-checked against the new spec
  before they run.
