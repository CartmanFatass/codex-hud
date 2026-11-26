# State of the universal-hud effort (2026-11-26)

Milestone: pivot M1–M3 accepted (M3: manage outcomes across projects); 0.2.0 is the baseline; the spec implies no M4

[Archived slice rows](archive/STATE-slices-2026-11-22.md); current progress lives in the tickets and land records.

Older handoffs: [2026-11-03 to 11-14](archive/STATE-2026-11-03-to-11-14.md), [2026-11-18](archive/STATE-2026-11-18-now.md). Other history: [documentation archive](../archive/).

## Now

- 2026-11-26 (main session handing off): ticket batches run through `hud_tickets run` with lead acceptance
  (`handback_to: "lead"`); unattended trial 3 was clean and unattended/01 is done. Queues `chores` and `home-tidy`
  run on their own and leave one end notice on the run record (`hud_read({job: <flow>})`). imp: even over
  `neon` + `sol`, cap 6.
- herdr fork (`~/projects/herdr-hud`, branch `hud`): installed 0.9.5-hud.f6236449 on the owner's word 2026-11-26
  (adds 23 dock, 25 collapsed-sidebar icons, 26 sidebar tree groups, 28 select-send via OSC 52, 29 cursor on
  reverse-video cells); live handoff needs `--import-exe ~/.local/bin/herdr --expected-version <v>`; rollback
  `~/.local/bin/herdr-0.9.5-hud.6e0d5d7e`. Owner confirmed 28 and 29 live; 16-29 done except 24 (HUD uses the dock,
  next). HUD 27 landed (1f60edeb): new workers report `hud_group`/`hud_subgroup`, main sessions `hud_group` on start.
  Judge fork regressions single-threaded (parallel env-lock race, HUD-FORK.md known failures).
- Ticket store (D-2026-11-26-06, `docs/design/ticket-store/README.md`): tickets move to per-feature
  `.hud/tickets/<feature>.json`; run q4d41eea7199f2815 covers ticket-store/01-05 (03 waits on nav-redesign/07, 09;
  05 waits on toktrack hud-ticket-json/01, owner-approved deletion of `.scratch/*/issues/*.md`). mcp-latency/03
  wontfix (superseded).
- Runs: nav-redesign qb33acad6613a3dd4 (01-03; 04-09 need a new run when it ends), chores follow-ups 16-17
  q4cb6b4851e0cf926, ticket-store above. mcp-latency run q7370ba79c6022f53 in review.
- Owner tries pending: exec-page/02 (Execution Runs section); sidebar tree groups once new workers start.

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
