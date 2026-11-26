# State of the universal-hud effort (2026-11-26)

Milestone: pivot M1–M3 accepted (M3: manage outcomes across projects); 0.2.0 is the baseline; the spec implies no M4

[Archived slice rows](archive/STATE-slices-2026-11-22.md); current progress lives in the tickets and land records.

Older handoffs: [2026-11-03 to 11-14](archive/STATE-2026-11-03-to-11-14.md), [2026-11-18](archive/STATE-2026-11-18-now.md). Other history: [documentation archive](../archive/).

## Now

- 2026-11-26 (main session handing off): ticket batches run through `hud_tickets run` with lead acceptance
  (`handback_to: "lead"`); unattended trial 3 was clean and unattended/01 is done. Queues `chores` and `home-tidy`
  run on their own and leave one end notice on the run record (`hud_read({job: <flow>})`). imp: even over
  `neon` + `sol`, cap 6.
- herdr fork (`~/projects/herdr-hud`, branch `hud` @00caf385 = 16+17+20+21) INSTALLED 2026-11-26 on the owner's word
  ("现在安装"): `~/.local/bin/herdr` = 0.9.5-hud.00caf385, live handoff needs `--import-exe ~/.local/bin/herdr` (the
  running server's own path is deleted after the swap); rollback binary `~/.local/bin/herdr-0.9.5-hud.a26432a7`. Two
  test failures are known on WSL2 and upstream (HUD-FORK.md). Next: herdr-fork/22 (HUD deletes its agy turn-child scan;
  its live try also closes 21's), owner tries 16 (select-send `Ctrl+b a`) and 20 (sidebar role icons). herdr-fork/23
  (dock layer) is building in `~/projects/herdr-hud-wt/23` (job j285cf00554bb5a5c); HUD 24 after 23
  (D-2026-11-26-03). Fork tickets are dispatched with `hud_create` into a fork worktree, never through the MyHUD queue.
- Panel navigation redesign (D-2026-11-26-04): sample `docs/design/nav-redesign/` settled by main (README §11);
  tickets nav-redesign/01–07 run as a queue with lead hand-back. Kept for the owner's word: `?N` badges, 6-row thumbnails.
- Owner tries pending: exec-page/02 (Execution Runs section), select-send after the fork install.

- The product pivot is in `docs/spec.md` (D-2026-11-23-03): HUD is the operational workbench (execution, load,
  Objectives, owner requests), toktrack does history and insights. The owner approved all 23 removals in its
  "Removed by this spec" checklist; drafts and reviews are in `tmp/tasks/spec-pivot/`.
- Imp defaults to the `sol` preset with routing off; the owner configures placement and uses `even` to balance
  subscriptions (D-2026-11-22-30). Reviewer runs on `astra`.
- toktrack (separate repo) is landing the hud-insight pages and the 27-slice overhaul through ticket queues.

- 2026-11-25: the workflow engine is narrowed to batch, prewalk, council and land templates; complex workflows
  (ticket queue on the engine, main-composed graphs, lead acceptance) are deferred (D-2026-11-25-08). Progress and
  holds are in [PENDING.md](PENDING.md#in-progress-2026-11-25).

## Waiting for the owner

See [PENDING.md](PENDING.md): advisor injection scope, gate concurrency, `docs/neon-proposal/`.

## Next

- M1 and M2 are accepted: both landed, the milestone review's blocking findings were fixed in 47d29bbc, and the
  live check passed (same machine-wide counts and WSL load in every bar; explicit STATE requests ordered on the
  board). Optional left: duplicate Classic/Split frames in `tests/fixtures/project-page.mjs`.
- M3 is accepted: tickets pivot-m3/01–05 landed, the milestone review's blocking findings were fixed in 9342cacd
  (plus 876197b0, 2a49c2d9), and the M3 Try passed on a synthetic two-project home (paused project and ticketless
  result found on Home, evidence opened, request resolved through `hud_objective` and cleared everywhere).
- The load display is compact per-role icons and C/M/S readings (D-2026-11-23-05, cfab9054).
- MyHUD and toktrack keep `.hud/objectives.md` through `hud_objective`; the owner's other registered projects get one
  only when their own sessions create it.
