# Brief RUNZ1: proveGroupGone with zombie-only groups (core, hud-run)

Tier M.

## Base

`universal-hud`.

## Defect

`proveGroupGone` (`src/core/run/process.ts` ~164–172) never proves a group gone while a zombie member remains:
- zombies count as members;
- it requires `kill(-pgid, 0)` to return ESRCH, which does not happen while a zombie still holds the pgid.

Contract 04 ScopeCheck (line ~73) and T-04-5 / T-04-11 / T-02-14 allow a zombie-only scope to end. The effect is that
the run stays `uncertain` and keeps its slot. Evidence and the failing test (`run-control`) are in
`docs/cloud/handoff/hyg1.md` and `hyg1-review-1.md`.

## Rejected fix

Do not reuse the one-scan patch from HYG1. Review 1 reproduced two races in which it says "gone" while a live
process is in the group:
1. a fork after the `/proc` readdir snapshot;
2. a same-session process joining a pgid that a zombie still holds.

## Required direction

A fix with corroboration:
- a second complete scan whose members are a subset of the first scan's zombie stamps;
- for headless scopes (their own session), no live process in session `scope.sid`;
- visible scopes share the terminal's session. Before implementing anything for them, ask the design Oracle whether
  to corroborate them another way or keep them `uncertain` until ESRCH. If the answer changes contract 04, that is an
  owner question.

## Acceptance

- Real-process tests on Linux:
  - the zombie-only group ends;
  - race 1 (fork after the snapshot) never ends the run;
  - race 2 (same-session join of a zombie-held pgid) never ends the run;
  - a visible scope behaves per the ruling.
- `run-control` is green.
- The README check set is green.
- The cost of the extra scan is reported (p50/p99, n ≥ 1000).

## Ownership

`src/core/run/process.ts` and its direct helpers, and the tests `tests/unit/run-control*`, `tests/unit/runz1-*` and
`tests/int/runz1-*`. Nothing else; ask first.
