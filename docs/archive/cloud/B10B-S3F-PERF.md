# Brief B10B-S3F-PERF: owner-approved rendering performance remediation

Date: 2026-11-03. Tier S, bounded performance remediation. Implementer: Astra high. Design consultations and the final re-check: fresh Astra max Oracles. The dispatcher records evidence and runs checks; it does not decide acceptance.

## Decision and authority

Proceed with one additional, narrowly scoped rendering-performance remediation under the owner's approval recorded in `docs/handoff/questions/B10B-S3F-verification.md`. This is an explicit exception to the consumed B10B-S3F one-fix-round allowance, not a reset of that allowance or permission for an open-ended optimization project.

B10B-S3F remains **unaccepted and unmerged**. R1 remains fixed; R2 remains a P2 acceptance blocker until a fresh Oracle closes it from the new implementation and evidence. R3 remains a non-blocking documentation item. An improvement in performance does not itself resolve the independent full-check gate.

This brief changes no contract, threshold, sampling rule, measured boundary, supported runtime, visual requirement, or merge condition. It authorizes implementation only inside the ownership and purpose below. The separate owner-approved verification-executor workstream supplies an appropriate environment; this brief does not authorize security-setting changes or local-only real-harness work.

## Base and binding inputs

The inspected `dots/b10b-s3f` head is `bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60`. Its last implementation change is `a754871612b8e56e8df12e907e8ae1654c24f999`. GitHub comparison shows that the intervening 15 commits change only handoffs and the performance ruling. Preserve that implementation, including the correct direct-child navigation fix, and every existing evidence file.

Use a dedicated worktree and branch `dots/b10b-s3f-perf` based on that inspected head, or a descendant containing only this brief and other recorded evidence. Record the exact base SHA. Do not rebase, rewrite, force-push, drop prior failures, or mix other packages' implementation into the remediation diff. Any later integration change creates a new tested tree and must be recorded separately.

Binding inputs:

- `AGENTS.md`, `docs/cloud/dots.md`, `docs/cloud/README.md`, `docs/handoff/STATE.md`, and `docs/ARCHITECTURE.md` §8.
- `docs/cloud/B10B-S3F.md`, `docs/cloud/B10B-s3.md`, and their binding contracts, design sections, rulings and prior accepted findings.
- `docs/cloud/rulings/b10b-s2.md`, `docs/cloud/rulings/b10b-s3.md`, and `docs/design/hud-information-design.md` §6.
- `docs/cloud/handoff/b10b-s3f-recheck-2.md` and `docs/cloud/rulings/b10b-s3f-performance.md` on the B10B-S3F branch.
- `docs/handoff/questions/B10B-S3F-verification.md` on `universal-hud`, including the recorded owner approval. The repository-root `questions/B10B-S3F-verification.md` is not the file's actual location.
- The current `src/CLAUDE.md` and `src/render/CLAUDE.md` directory notes.

## Goal

Diagnose and reduce avoidable changed-tick allocation and computation inside delegation rendering so the unchanged strict compact and rich gates are reproducibly met on the supported Node 22 and Node 24 runtime families, without regressing no-change ticks, correctness or bounded memory.

The current code's fresh-view path rebuilds projection containers and plans and compares facts for cloned nodes. That makes allocation/repeated work a reasonable investigation target, not a proved root cause. The prior GC overlap concerns its own instrumented samples only. Do not claim that GC, runtime choice or host contention explains every recorded failure without corresponding evidence.

First establish a matched baseline and identify the relevant hot path. Then retain the smallest production change supported by that diagnosis. No unrelated cleanup, feature work or architecture migration belongs in this package. If the baseline does not reproduce on the chosen permitted executor, report that fact and the environmental difference; do not invent a fix or treat a changed host as proof that the old failures were invalid.

## Ownership

The following production files may change, only to remove redundant work or allocation on the existing delegation-rendering path:

- `src/render/delegation/facts.ts`
- `src/render/delegation/projection.ts`
- `src/render/delegation/rows.ts`
- `src/render/delegation/cards.ts`
- `src/render/delegation/lines.ts`
- `src/render/delegation/panel.ts`
- `src/render/delegation/selection.ts`
- `src/render/monitor.ts`, limited to delegation-view construction/reuse and delegation selection reconciliation. Its legacy rendering and other-pane behavior must not change.

This is a whitelist, not a requirement to modify every file. List each changed function and its diagnosed reason in the report. Keep exported call signatures and observable behavior compatible. Put narrowly necessary internal helpers in the owned files; do not create a new subsystem.

Test ownership is additive regression coverage in:

- A new `tests/unit/b10b-s3-perf-regression.test.ts`.
- `tests/unit/b10b-s3-facts.test.ts`, `tests/unit/b10b-s3-selection.test.ts`, `tests/unit/b10b-s3-rich.test.ts`, and `tests/unit/b10b-s3-collapse.test.ts`, only when a focused addition belongs there.

Do not weaken, delete or rewrite existing assertions to make the optimization pass. New synthetic cases belong in the owned tests; shared fixtures remain unchanged.

The dispatcher owns recording this brief, the implementer report, raw logs, review and subsequent status. Use distinct new `docs/cloud/handoff/b10b-s3f-perf-*` evidence files and `docs/cloud/rulings/b10b-s3f-perf-*` consultations as needed. Preserve the prior reports verbatim.

### Explicitly outside this remediation

- `src/render/monitor-input.ts`: preserve R1's `parentKey` direct-child lookup and its existing regression tests. No input/key behavior change is needed for an allocation remediation.
- `src/render/frame-diff.ts`, other render modules not listed above, `src/tree-page.ts`, `src/core/**`, `src/collectors/**`, `packages/**`, `src/utils/**`, and `bin/**`.
- `tests/unit/b10b-s3-perf.test.ts` and all other benchmark sources; benchmark fixtures, visual fixtures/baselines, package/lock files, build/test scripts, runtime declarations, contracts and design documents.
- Dispatcher effects, Open/Log/Copy integration, the Inspector, R3's reference-document edits, RUNZ1/HYG2 fixes, B10D work, dependency updates and global cache/framework refactors.

If the measured remedy needs an excluded file, different semantics or a changed gate, stop the dependent work and return the precise question and recommendation. This brief does not grant a silent ownership expansion.

## Semantic and memory boundaries

1. Preserve every fact used for invalidation. Do not replace complete fact comparison with a weaker stamp, object identity or partial key that misses updates. Fresh but equivalent structured-cloned view models must remain correct; a single changed fact must invalidate everything that depends on it. Keep the digit-bearing comparator-name fix and its guard.
2. Never mutate input view models or previously returned projections, plans, rows or frames in a way that changes what an older frame represents. Keys and actions still resolve against the frame the user saw. Reuse must not make an old frame point at a newer node, descriptor or topology.
3. Preserve stable ordering, parent relations, conflict handling and omitted-conflict counts, subtree aggregation, `selectionMap`, positional/parent-aware `put:` behavior, collapse/history/sort behavior, clock and put-away boundaries, and rich destinations in actual screen order. The fifth-sub-row cutoff and R1's intervening-sibling cases remain unchanged.
4. Preserve all text, ANSI/column widths, selected bands, EN/ZH output, glyph and palette behavior, summary/coverage behavior, and null-delegation legacy output. There is no intentional visual change, so do not update baselines.
5. Keep caches bounded and invalidated correctly. Do not obtain a pass by increasing existing cache capacities, retaining old snapshots indefinitely, weakening eviction or skipping disappeared-node cleanup. The 500-card limit remains unchanged. Distinct view models, roots, options, translators and styles must not contaminate one another.
6. No I/O, worker offload, new timer, background precomputation, external side effect, render-quality reduction or movement of measured work outside the established timing boundary. No runtime-specific shortcut or `B10B_PERF` detection in production code. Do not tune heap/GC flags to manufacture an acceptance pass.

## Unchanged acceptance benchmark

Freeze `tests/unit/b10b-s3-perf.test.ts`, blob `371b8f784229636f66e88434c422484dd85251eb`, and its fixtures. The standard strict invocation remains `B10B_PERF=1 node --test dist-test/tests/unit/b10b-s3-perf.test.js`, with the selected runtime's actual binary and the safe test wrapper recorded.

Preserve exactly:

- 1,000 measured samples after 200 warm-up iterations, nearest-rank percentiles, and all existing preconditioning and test order.
- The 200-node synthetic tree at 56 columns, moving clocks, alternating real up/down selection, and fresh structured-cloned changed views with exactly one differing node.
- The existing measured reconciliation/key/row-render/frame-diff scope. The changed gate reads every required row; the no-change gate reads the 60 rows in view. Keep the existing rich viewport behavior.
- Compact and rich no-change p99 ≤ 2 ms; compact changed p99 ≤ 10 ms; rich changed p99 ≤ 15 ms.
- Separately printed whole-`renderMonitor`, visible-only changed, selection-miss and cold measurements. They are diagnostics, not substitutes for any gated population.
- Node 22 ≥ 22.13 and Node 24 support. Test both families; a Node 22 pass does not close the Node 24 failures.

Do not edit sample count, warm-up, percentile calculation, workload, assertions, strict-mode behavior, ordering or the prepare/measured boundary. Do not subtract GC pauses, trim outliers, pool runs into a new percentile, report only best runs or relabel an unmeasured population as passing. An instrumented diagnostic is not an unmodified strict acceptance run.

## Evidence plan

1. Reserve a serialized measurement window with the dispatcher: no other agent-controlled builds, tests or benchmarks on that executor during the performance series. The separate verification workstream must coordinate rather than overlap it. Do not terminate unrelated processes.
2. Build and record the exact baseline and final candidate commits. Use the same host, runtime patch versions, dependency installation and unmodified benchmark for the paired comparison. Prefer the already observed Node v22.23.4 and v24.22.1 when available; another allowed patch version must be identified and used for both sides. Never silently change runtimes between baseline and candidate.
3. Record at least three strict fresh-process runs per runtime for the baseline and final candidate. Keep every attempted run in chronological order, including failures and interrupted runs. Declare the run order before execution; do not rerun until a favorable subset appears. If an execution is contaminated, retain it, identify the interference, and record any replacement separately rather than erasing it.
4. For every build and run, retain the exact source SHA/tree and clean-or-dirty status; benchmark/fixture identity; complete executable command and relevant environment; fresh temporary `HOME` and `HUD_HOME`; Node/npm versions and binary path; OS/kernel/architecture/CPU and host identifier; UTC start/end times; observable competing processes and load; all stdout/stderr and exit status. Record the build output and the provenance of the generated `dist-test` files so a stale build cannot masquerade as the candidate.
5. Explicitly state host-control limits. A quiet process snapshot or load-average reading is not proof of continuous isolation. Record monitoring sufficient to detect agent-controlled overlap, without dumping unrelated private process arguments. If isolation cannot be established, disclose the exact limitation and ask the Oracle to assess it; do not call the run isolated by filename alone.
6. Report p50/p95/p99/max and n for each printed population, the four gated p99 values for each run, and the range across runs. Give each evidence set its own identity: implementer baseline/candidate, dispatcher verification, diagnostic profiles, earlier Node 22 series and earlier Node 24 series must not be conflated.
7. Diagnose allocation/GC separately with reproducible commands and a clear baseline/candidate comparison. If claiming GC-tail improvement, record correlated sample/GC evidence and the allocation sites or retained-memory mechanism addressed, with profiling overhead disclosed. No GC subtraction or instrumented value replaces the unmodified benchmark.
8. Retain all prior failures, including the earlier Node 22 no-change failure and the repeatedly failing Node 24 changed runs. STATE's exception is still only a single compact-changed over-limit result followed by a recorded rerun alone. It is not a waiver for repeated changed failures, rich failures, no-change failures or undocumented interference.

These are evidence/provenance requirements for the same gates, not new timing thresholds or a new sampling scheme. Remote results remain design evidence, not formal WSL P-06-7 qualification.

## Regression requirements

Run all existing `b10b` unit suites, not only the newly added tests, because the owned projection/facts/string paths also feed segment 1 and segment 2. Run the existing visual suite without changing any baseline.

Add targeted regression coverage proportionate to the actual optimization. At minimum, where the changed mechanism applies, cover:

- Rebuilt-equal view models, a one-fact change, and return to the previous value, with warm versus fresh-cache output equivalence.
- More than one live view/frame: render A, render changed B, then inspect/use A again. Its rendered text, selection destinations and any original descriptor must still represent A.
- Removed/reinserted nodes, parent/topology or bucket changes, conflict rows, collapse/history/sort changes, and selection/put-away transitions.
- Clock buckets and the put-away boundary on either side, plus width/style/selected-row and rendering-context changes relevant to the cache touched.
- Bounded eviction/churn and absence of stale entries or cross-tree contamination. Use deterministic cache tests where possible; do not make GC timing a flaky correctness assertion.

Preserve and rerun R1's two direct-child tests in compact and rich and the fifth-sub-row overflow test. Preserve the existing complete fact-key and row-key coverage in `b10b-cache.test.ts`; do not remove facts or key inputs to improve numbers. Existing correctness tests may already cover a case; cite the exact test instead of adding redundant coverage.

Every newly introduced behavior or correctness fix needs a meaningful fails-before/passes-after test. For a performance-only change with unchanged output, distinguish equivalence guards from proof of speed: the unchanged strict benchmark and matched baseline/candidate measurements supply the performance evidence. Do not claim a correctness test fails on the baseline when it does not.

## Complete checks and independent blockers

On the exact candidate, run and retain the complete README check set with temporary `HOME` and `HUD_HOME`: build, build:test, build:hud-mcp, npm test, test:core, test:visual, test:hud-mcp, format:check, check:fixtures and git diff --check. Record each command's outcome, including stages never run. If `npm test` short-circuits before `test:mjs`, run that stage separately for diagnostic coverage and still report `npm test` as failed.

The last reviewed B10B full run had 12 unit failures and did not reach `test:mjs`. Later environment diagnosis does not make those tests pass. Obtain actual results in the owner-authorized capable executor; do not mark socket, ptrace or process-topology tests green because their earlier failure was attributed to the environment. Do not bypass a permission denial or modify checks to avoid it. Failures outside this whitelist go to the relevant package/verification Oracle, not into this performance patch.

The final accepted integration tree needs its own complete green check set. Package-local checks, a passing focused suite, passing performance or another package's results cannot substitute for that merged-tree gate. Known flakes are handled only by the existing named rules, with both the original and isolated rerun retained.

## Deliverable and next review loop

1. The dispatcher saves this brief and the approval reference, pins the branch base, and starts one implementer within this scope. Diagnose and implement only the smallest justified performance change. Batch unresolved design questions for a fresh read-only Oracle before taking the affected path.
2. The implementer returns the exact base/head, changed-file/function list, mechanism and invariant explanation, exported-API impact, regression-test names and before/after evidence, cache/retention evidence, every benchmark result with provenance, full check results and open blockers. Commit/push only the authorized package branch under the repository workflow; never stage `node_modules/.package-lock.json`.
3. The dispatcher independently runs the required checks and the serialized strict candidate series on the submitted commit, records raw output, and supplies the report, branch diff, this brief, previous findings and all evidence to a fresh Oracle. Do not share the implementer's private reasoning transcript.
4. The Oracle verifies the report against the branch and logs, assesses the optimization and every touched semantic boundary, carries forward untouched accepted findings, and explicitly rules on R1, R2, R3 and the independent full-check status. Return `accept` or `fix required`, with any findings in the repository's file:line/severity format.
5. This grant permits one additional remediation submission and that fresh review. Pre-submission diagnosis and validation are part of it; it does not open a new automatic two-fix-round budget. If the final verdict is still `fix required`, or a remedy needs broader ownership or altered acceptance, preserve the work and send the precise remaining question and Oracle recommendation to the owner. Do not automatically start another implementation round.
6. Only after an applicable Oracle `accept`, verified report and complete green merged-tree checks may the dispatcher perform the authorized `--no-ff` integration into `universal-hud`, push and update STATE and the plan status. The follow-on alone does not bypass B10B-S3F's acceptance. Do not release dependent wave-2 work on the strength of a benchmark improvement alone.

## Read-only consultation record and sources

This brief was prepared by reading repository files and GitHub metadata. No implementation, benchmark, test, repository write or git mutation was performed in this consultation.

- [Inspected B10B-S3F head](https://github.com/CartmanFatass/codex-hud/commit/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60).
- [Evidence-only comparison since R1](https://github.com/CartmanFatass/codex-hud/compare/a754871612b8e56e8df12e907e8ae1654c24f999...bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60).
- [Final re-check](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/docs/cloud/handoff/b10b-s3f-recheck-2.md).
- [Performance evidence ruling](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/docs/cloud/rulings/b10b-s3f-performance.md).
- [Frozen strict benchmark](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/tests/unit/b10b-s3-perf.test.ts).
- [Owner-approved question](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/handoff/questions/B10B-S3F-verification.md).
- [Current workflow and merge rule](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/handoff/STATE.md).