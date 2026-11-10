Verdict: accept

## Findings

No actionable findings. The round-1 major finding is fixed; no new blocking defect was found in the cleanup repair.

## Previous finding

### Raw-group cleanup loses ownership when its leader exits first — fixed

- `tests/unit/run-light-leader.test.ts:151–162,242–263`: raw fixtures now retain independently stamped session members from STARTED/WAITER replies. Session enumeration requires a still-current stamped anchor; protocol PIDs must match the owned SID and private cwd before admission.
- The ownership listener is registered before caller reply listeners. At WAIT it snapshots surviving descendants **before** `spawnRawLeader` closes fd3 and permits the remaining leader/forwarder anchors to disappear. Cleanup continues to recheck process stamp, cwd and exact argv before signalling; an unanchored numeric SID does not grant authority.
- Real regressions at `:779–849` reap the raw leader before deliberately failing or timing out the nested test, then verify the workload and grandchild are dead. The regression at `:852–905` verifies that an orphan grandchild is alive after normal raw completion and is killed by actual fixture cleanup. Independent fallback hooks run after the cleanup assertions, so they cannot make broken cleanup pass.
- Recorded negative control `checks/r1-cleanup-negative.log`: **3 tests, 0 pass, 3 fail, exit=1** against the pre-fix ownership code, with two `alive !== dead` failures and one bounded death-observation failure. Recorded fixed control `checks/r1-cleanup-positive.log`: **6/6 pass, exit=0**. All six cleanup cases also passed in my independent current-file run.

## Verified

### Scope and code

- Read both briefs, the previous review, implementation notes, relevant repository/directory guidance, architecture rules and q4/q5/q6 decisions. Read the complete diff against `2c6dcf67090064b66f17bc79905f7aac7f528921` and both changed files. `git status --short` shows only `src/core/run/group-leader.ts` and `tests/unit/run-light-leader.test.ts`, with no untracked files.
- The repair for this re-check is confined to test ownership and regressions. The production script retains the previously reviewed reader ignores and post-workload-fork waiter ignore with one real wait. Protocol validation, cancellation authority, native-unknown projection and production deadlines remain unchanged.
- Original assertions remain. Every test uses the bounded registration wrapper, except the deliberately shorter nested timeout probe; fixture cleanup runs on abort and after-hooks, with bounded reap waits. The new tests exercise real shell/workload/grandchild processes, not a replacement cleanup implementation.

### Fresh recorded checks

The current test source was last changed at **2026-11-10 02:14:30 -0800**. These logs are newer, complete and end with `exit=0`:

| Log | Actual result |
| --- | --- |
| `checks/r1-build.log` | `npm run build`: pass |
| `checks/r1-build-test.log` | `npm run build:test`: pass |
| `checks/r1-cleanup-positive.log` | 6 tests, 6 pass, 0 fail/cancelled/skipped |
| `checks/r1-full-file.log` | 92 tests, 92 pass, 0 fail/cancelled/skipped; 37,783 ms |
| `checks/r1-format.log` | `npm run format:check`: all matched files use Prettier style |
| `checks/r1-diff.log` | `git diff --check`: no output |

### Independent commands

- Ran `node --test --test-reporter=tap dist-test/tests/unit/run-light-leader.test.js` using fresh temporary HOME/HUD_HOME/CODEX_HOME and clearing the specified inherited color/settings overrides. Result: **92 tests, 92 pass, 0 fail, 0 cancelled, 0 skipped; 37,649.985 ms; signal=null, exit=0**. This includes the three new regressions, the three earlier cleanup cases and the remaining focused tests in the changed file.
- `git diff --check`: **exit=0**, no output.
- Read-only status/diff and log-freshness audits: completed. No full suite was rerun and no repository files were modified.

### Stale full-validation evidence and gate context

The `checks/q4-final-pre-*` validation predates this cleanup fix and covers the **89-test** candidate, not the current 92-test file. As required for round 2, this is noted as stale evidence, **not a finding**:

- File alone ×3: each 89/89 pass, `exit=0`.
- Twenty loaded whole-file runs: each 89/89 pass, `exit=0`; durations 57,547–64,397 ms. The driver and individual logs are complete.
- Uninstrumented topology loop: `{ limit: 500, hangs: 0, failures: 0 }`, `exit=0`.
- Full unit: **4402 tests, 4373 pass, 3 fail, 26 skip, 0 cancelled; exit=1 — not green.** The failures are the two reserved workboard cases and PIROLE PR3 cold fake launch. Its recorded isolated rerun passes 1/1, `exit=0`. q5/q6 explicitly classify these as out-of-diff gate context, not in-scope review findings.

Acceptance still requires the orchestrator's final validation on the 92-test tree; this verdict does not relabel the stale evidence as current or the full-unit gate as green.

<repo-parent>/MyHUD/tmp/tasks/FIX-RLL-HANG/review-2.md — 0 findings.
