Verdict: accept

## Findings

No actionable findings. Reviewed under the brief's **safety** tier. The actual change is fixture/test-only: three modified tracked files and the new `tests/unit/r5-fixture-clock.test.ts`; no production aging, expiry, execution or authorization code changes.

## Verified

### Cause and fix

- **The leak is physical fixture timestamps, not an ignored injected clock.** `r5Fixture.put` uses `src/roles/job-store.ts:writePrivate`, whose real atomic writes acquire kernel wall-clock mtimes. `r5Fixture.association` separately uses `writeAssociation`, which calls the same writer. Previously neither fixture path pinned those dates.
- Traced the failing QA path through `TaskObservationCollector.read` (mtime becomes `at`/`writtenAt`), `qaRecords`, `answerRecord`, and `workboard.ts:callTime`/`homeCalls`/`isLocalDay`. The two tests inject November 9 into observation/composition/rendering, but previously wrote November 10 QA evidence. Home consequently excluded the decisions; `homeRows` could not insert the selected decision's activation hint, and `laneRow` omitted the call counts. `checks/diagnose-fresh.log` records `today: 0` becoming `today: 1` after changing only QA mtimes and using a fresh collector. The source also confirms why an already accepted content revision retains its original evidence date.
- The Jev `Ended needing a human` row is **expected**, not evidence of erroneous expiry. `JobObservationCollector.observe` derives it from the completed `needs_human` result; `buildWorkboard` and `homeRows` preserve it. Its explicit 11:50 producer timestamp correctly renders as 10 minutes old at the fixture's noon clock.
- Checked clock fallbacks on these paths: job collection/snapshot use the supplied `now`; tree composition and monitor rendering/reconciliation/input receive explicit fixture times. Task/pipeline budgets use monotonic time, and ctime/inode signatures are change-detection evidence, not business ages. Herdr live collection is disabled in the two target tests.
- `tests/fixtures/r5-jobs.ts` now stamps both producer-writing paths with the current fixture time, including replacements after `advance()`. The new physical-stat test covers associations, receipts, primary/helper STATUS, reports, QA and Jev files before and after advancing. Real writers and filesystem reads remain in use.
- The observation-test adjustments make answer recovery and distinct evidence dates explicit without weakening assertions. The additional `AgentLog(..., f.now)` correction injects the existing clock into its retention calculation; the negative control exposes the previous restoration failure at +400 days. No production-symbol test is required because no production symbol changed.
- Verified the fixture import-closure enumeration against direct imports and the recorded commands: all 20 affected unit files were included in final ordinary and shifted runs. The separate performance benchmark was identified as non-gating and not rerun. No baseline regeneration, assertion removal, horizon widening or threshold change appears in the diff.

### Checks run independently

Using Node **v24.22.1**, fresh temporary HOME/CODEX_HOME, and the required HUD/settings/color overrides unset:

```text
node --test --test-reporter=tap \
  dist-test/tests/unit/r5-fixture-clock.test.js \
  dist-test/tests/unit/r5-job-observation.test.js \
  dist-test/tests/unit/r5-production-summary.test.js \
  dist-test/tests/unit/workboard-fix4.test.js \
  dist-test/tests/unit/workboard-visual-facts.test.js
```

Actual result: **23 tests, 23 pass, 0 fail, 0 cancelled, 0 skipped; exit=0**, duration **16527.335979 ms**. This executed both permanent child-process regressions at fixture +2 and +400 days. They preload fake Date before modules load, leave filesystem timestamps/timers/monotonic budgets real, and assert execution of the named target and restoration tests rather than accepting an empty successful runner.

Also ran:

- `git diff a854f597e311fc58ff5eb5ccf5e011eedc9be095`, `git status --short`, and `git diff --check`: full tracked/untracked scope inspected; whitespace check **exit=0**.
- `node <repo-parent>/MyHUD/tmp/tasks/FIX-CLOCK-LEAK/r5-tests.mjs`: enumerated the 20 unit files used in the recorded broad checks; **exit=0**.
- An in-memory TypeScript ESM-transpilation comparison against `git show a854f597e311fc58ff5eb5ccf5e011eedc9be095:<source>`: all three saved unfixed JavaScript inputs used by `negative-control.sh` match the reviewed base (ignoring source-map footer); **exit=0**.

### Recorded check evidence validated

Newest changed source: **2026-11-10 01:49:15.790 -0800**. The final logs below are newer, contain the stated command and completion summaries, and end in `exit=0`. The compiled focused tests are also newer than their sources. Full suites were **not rerun** in this review.

| Logs under `checks/` | Verified result |
| --- | --- |
| `pre-review-build.log`, `pre-review-build-test.log`, `pre-review-build-mcp.log` | All three required builds pass |
| `pre-review-named-{1,2,3}.log` | Both original files pass three independent runs: 3/3 each |
| `pre-review-all-r5.log` | 180 tests, 180 pass, 0 fail, 0 skipped |
| `final-all-shift-2.log`, `final-all-shift-400.log` | All 20 unit files: 180/180 pass at each offset, no skips; coherent inherited Date preload inspected |
| `final-unit.log` | `timeout 1200 npm run test:unit`: 4454 tests, 4428 pass, 0 fail, 26 skipped; 321358.619781 ms |
| `pre-review-format.log`, `pre-review-diff.log` | Formatting and whitespace checks pass |

Negative evidence was preserved and inspected separately: `base-named.log` records **1 pass / 2 fail**, at the original `y >= 0` and `/1 call\b/` assertions. `regression-negative-exact-base.log` records the exact new regression against the unfixed fixture/test setup: **0 pass / 3 fail, exit=1**. Its child output shows both original target failures at both offsets and the additional missing restored digest at +400 days. These are expected negative controls, not passing gate evidence.

<repo-parent>/MyHUD/tmp/tasks/FIX-CLOCK-LEAK/review-1.md — 0 findings
