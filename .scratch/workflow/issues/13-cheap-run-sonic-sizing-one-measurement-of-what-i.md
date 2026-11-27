# 13: Cheap-run Sonic sizing: one measurement of what is delivered, conservative on branches, no stuck runs

**Status:** done
**Owner try:** no
**Live try:** A cheap run whose task names `../data/<3 MiB synthetic file>` from a subdirectory cwd shows the cost pause. A required one-item batch fails during an independent `to: main` hand-back; after the answer the run pauses on the batch failure instead of staying `working`.
**Blocked by:** none

**What to build:** Main decision 2026-11-27 on escalation j3966b9f41d17cc62 (workflow/12 milestone review j20ff6d7d96604ca1, 5 majors). Final round on this ledger: simplify rather than add precision. (1) Measure what is actually delivered: size the populated worktree checkout (or the main checkout) after it exists and before input is delivered, and delete the Git blob / symlink / node_modules reconstruction in src/mcp/batch.ts (~54-197, `inputBytesAtHead`). (2) One resolver: dispatch and sizing (`measureSonicInput`, plan-time sizing in src/mcp/composed-workflow.ts) use one resolved reference list from the dispatch context assembly, so plan, admission and launch agree. (3) Relative names resolve from the launch cwd; every resolved path inside the project root counts (finding 2: today a named file outside cwd but inside the project is charged 0). (4) Conservative on branches: a Sonic cursor on a branch not yet ruled out counts; a branch ruled out by a recorded answer stops counting. Over-pausing is accepted; under-counting is not. (5) Liveness (finding 4, regression from workflow/12): when another decision owns the pause, a drained batch's failure stays outstanding and the run pauses on it after that answer; a run never sits at `working` with nothing that can move it. Prefer deleting code to adding cases. Lead acceptance after the next review: accept unless it finds a blocker or a normal-path defect; ledger edge cases become follow-up tickets, not another repair round.

- [x] Test: subdirectory cwd naming `../data/<3 MiB>` inside the project pauses for cost at plan and at admission with the same byte count
- [x] Test: worktree Sonic step sized from the populated checkout (crlf / smudged file counted at checked-out size); the blob-reconstruction code is gone
- [x] Test: plan, admission and dispatch use one reference list (a reference added at dispatch is never uncounted)
- [x] Test: a branch ruled out by a recorded answer is not charged; an undecided branch is
- [x] Test: a required batch failing during an unrelated main hand-back pauses the run on the failure after the answer
- [x] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments

- Landed in this commit (replay base 83d73fd5177494577dcd3e8adfc2d4ee22fe6c4c); gate 5/5 passed.
