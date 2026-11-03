# HYG1 fix round 1 report

Saved by the orchestrator from the implementer's text. This round responds to `hyg1-review-1.md`.

Finding 1 was in the report, not the code. It is handled by the orchestrator's correction in `hyg1-implementer-report.md`: the `proveGroupGone` patch is withdrawn. No `src` fix was applied.

## F2: `tests/unit/b45-launch.test.ts` (test 9)

**Change.** The keep-alive timer is gone. Test 9 now awaits `Promise.race([result.completion, timedOut])`. `timedOut` rejects after 10 s with `Error('supervisor did not exit within 10 s')`, and its timer is cleared in `finally`.

**Evidence.** Mutations ran on compiled copies outside the worktree, with temporary HOMEs.

| Case | Node 22.23.4 | Node 24.22.1 |
|---|---|---|
| Unchanged code | 15/15, 0 cancelled | 15/15, 0 cancelled |
| `completion` never settles | 14 pass, 1 fail: only test 9, at 10018 ms, "supervisor did not exit within 10 s" | 14 pass, 1 fail: only test 9, at 10022 ms, same error |
| Five runs alone | 15/15 every run | 15/15 every run |

## F3: `tests/unit/hud-link-export.test.ts` (around lines 48–58)

**Change.** The filter now runs only where Node prints the warning:
- `NODE_PRINTS_SQLITE_WARNING = Number(process.versions.node.split('.')[0]) === 22`.
- `hudStderr()` returns stderr unchanged on any other runtime.
- A comment says why.

**Evidence.**

| Case | Node 22 | Node 24 |
|---|---|---|
| Unchanged code | 10 pass, 1 skipped | 10 pass, 1 skipped |
| m3: `bin/hud` emits one copy of the exact text itself | 6 fail (the processes that also load sqlite print two copies; only one is removed) | 8 fail (every test that checks a launched process's stderr exactly) |
| Five runs alone | green every run | green every run |

Test 1 still passes under m3 on Node 24. Its assertion was already a prefix match (`/^invalid_command: Usage:/`), and it was left unchanged.

## Check set (Node 22.23.4, temporary HOME, HUD_HOME unset)

| Check | Result |
|---|---|
| build, build:test, build:hud-mcp | rc=0 |
| `npm test` | `# tests 2243 # pass 2224 # fail 2 # cancelled 0 # skipped 17` (see below) |
| test:mjs (run alone) | 47/47 |
| test:core | 210: 209 pass, 1 skipped |
| test:visual | 292/292 |
| test:hud-mcp | 84: 83 pass, 1 skipped |
| format / fixtures / diff-check | clean / OK / clean |

The two `npm test` failures:
- `not ok 1502`: the known run-control product defect.
- `not ok 329` in `b11-cli`: `ledger_busy` from `DelegationService.accept` during the full parallel run. The suite is not touched by HYG1. Run alone, it passes 20/20.

**Orchestrator verification.** After rebuilding, each file was run alone with a temporary HOME:
- hud-link-export: 11 tests, 10 pass, 0 fail, 0 cancelled.
- b45-launch: 15/15.
- b11-cli: 20/20.

`format:check` is clean. `git status` shows only the three test files and `docs/cloud/handoff/`.
