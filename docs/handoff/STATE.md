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

- Nothing open.

## Next

- M1 and M2 are accepted: both landed, the milestone review's blocking findings were fixed in 47d29bbc, and the
  live check passed (same machine-wide counts and WSL load in every bar; explicit STATE requests ordered on the
  board). Optional left: duplicate Classic/Split frames in `tests/fixtures/project-page.mjs`.
- M3: the Objective syntax is settled (D-2026-11-23-04); slice M3 into tickets and run them.
