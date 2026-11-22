# Brief HYG1: a clean cloud test baseline

Tier S, tests. Core implementer: Opus high. Oracle: Opus max. Branch `cloud/hyg1`, created from `universal-hud`.

## Why

In the Claude Code cloud container (Node 22.23.4, SQLite 3.53.4), `npm test` fails on the unmodified `universal-hud` 6fcf08a with `# tests 46 # pass 31 # fail 7 # cancelled 7` across three files. Every cloud review has had to prove again that these failures pre-date its package. A clean baseline makes "green" mean green.

The failing files:

| File | Symptom |
|---|---|
| `tests/unit/hud-link-export.test.ts` | 6 failures. Each expects an empty stderr but receives Node's `ExperimentalWarning: SQLite is an experimental feature`. |
| `tests/unit/b45-launch.test.ts` | 7 cancelled with "Promise resolution is still pending but the event loop has already resolved". |
| `tests/unit/run-control.test.ts` | 1 failure, "supervisor death receiptless Q …": the run reads `uncertain` where `ended` is expected. |

Also seen in run 1: `b12-store`'s process tests pass in a tree that has no `dist/` built, so they may not detect a missing build.

## Goal

1. **Diagnose each failure.** For every failing test, find the root cause and classify it:
   - **environment** — the container's Node, SQLite, filesystem, timing or process limits;
   - **test defect** — a wrong assumption or race in the test itself;
   - **product defect** — the code under test is wrong.

   Support each verdict with evidence: the command run, and the output or trace.
2. **Fix environment and test-defect causes within the tests only.**
   - Example: tolerate or suppress Node's experimental warnings for spawned processes via `NODE_NO_WARNINGS=1`, or a filter scoped to that exact warning. Assertions that stderr is otherwise empty must stay.
   - Example: await or close the handle the cancelled tests leave pending.
   - Never weaken an assertion about behaviour, skip a test or raise a timeout without a measured reason.
3. **Product defects: stop.** Do not fix them. Report each one with a minimal reproduction, the suspected file:line and a proposed fix. The orchestrator hands it to the owner. `run-control`'s `uncertain` vs `ended` may be one of these; it touches hud-run's supervisor-death path.
4. **`b12-store`.** If the process tests can pass without a build, make them fail clearly when the compiled entry is missing, or report why they don't need it.

## Ownership

**Yours:** `tests/**` and test helpers; the `scripts` entries in `package.json` only if a test command needs an environment variable. List every such change.

**Not yours:** `src/**`, `packages/**/src/**`, `bin/**`, contracts and docs (apart from the report). If a fix needs one of them, stop and return the question.

## Acceptance

| # | Check | Expected |
|---|---|---|
| 1 | `env -u NO_COLOR -u FORCE_COLOR -u HUD_HOME HOME=$(mktemp -d) npm test` in the cloud container | 0 failures and 0 cancelled, apart from product defects that are reported and left failing |
| 2 | each fixed file run alone, 5 times in a row | green every time; quote the summary lines |
| 3 | the README check set | green, with known flakes named |
| 4 | the fixes are meaningful | For each fix, show that the test still fails when the behaviour it checks is broken: mutate a compiled copy outside the worktree. |

## Report

Return as text:
- for each failure: its classification, the evidence, and the fix or the product-defect report;
- the changed files;
- the check output;
- open items.
