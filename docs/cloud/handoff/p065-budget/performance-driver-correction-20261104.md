# P065 evidence-driver correction report

Date: 2026-11-04 UTC

## Status and exact source basis

This is an additive source-only correction to the independent source review of candidate 8ba05de09e35abe3891ff6f6fb3b35f6065b3d65. It does not supersede or erase the historical implementation report or failed checks.

- Repository: CartmanFatass/codex-hud.
- Authorized work branch: dots/p065-budget.
- Exact parent: deb24af271f93914b48fe86d6835f1b3ce1d3e56.
- Parent tree: 2e62457c664060bbe7f3769b4c6519bc6e357c42.
- The parent includes the separate rejection-audit formatting correction. That source is preserved unchanged.
- Behavioral delta: tests/int/p065-budget-benchmark.mjs only.
- tests/int/p065-ledger-holder.mjs is behaviorally unchanged; its original blob is b75f9f3c2d477c34a6b44119414f3c77e7157724.
- This report is the sole new documentation file. The frozen fixture, production, audit tests, package/build/lock files and shared status/rulings are untouched.

Publication uses the GitHub connector, the exact parent tree, one normal child commit, and a non-force expected-head update. Exact source/report readback and changed-path comparison are required after publication; commit/tree identities are supplied by the dispatcher's publication receipt rather than embedding a self-referential commit ID here.

## F1: Primary measured response gates

The driver now gates five explicitly separated response populations:
1. All retained attempts.
2. Primary measured calls.
3. Primary warmups.
4. Measured recoveries.
5. Warmup recoveries.

Every nonempty population has its own nearest-rank p95 and actual-outcome splits. All applicable per-call write authorization and cumulative-wait bounds still apply to every retained attempt. Primary measured failure propagates to operationalNumericalQualification and acceptanceChecks. Fast warmups or recoveries cannot repair a failed measured-primary distribution.

Report schema version 2 retains the distributions and exposes the actual gate objects under numericalScopes. The reported primary-measured scopes no longer mix recoveries with primaries.

Fixed checker controls are included for the 949-fast/51-slow status distribution plus 50 fast warmups, slow primary plus fast recovery, an isolated slow outcome split, and slow recovery. These are source controls for later authorized execution, not executed evidence in this report.

## F2: Required successful-loss coverage

Every response-loss cell predeclares, for each H participant:
- At least one measured successful lost result.
- At least one independently verified durable inspection.
- At least one checked canonical recovery, except report, whose declared recovery count is zero.

These are minimum semantic coverage requirements in addition to the unchanged 50 warmups and 1,000 measured primary attempts. There is no resampling, replacement, reduced population, or extra retry to hide busy results. If the declared attempts do not reach the requirements, lossCoverage.complete and cell completeness are false.

The captured server success must match independent durable truth even when the client discards its bytes. Unsuccessful lost responses remain retained but cannot count as successful-loss/recovery evidence. The summary records required counts, observed counts and participating call IDs. An all-busy cell, missing H participant, missing durable inspection or missing required recovery fails coverage.

Successful lost reports require the actual stored report/run identity and remain inspection-only, with no automatic resubmission. Status loss requires successful reread coverage and verifies that both primary and recovery have no instrumented writer transaction.

## F3: Canonical client-visible results

All successful primary server results, including captured lost responses and late-COMMIT success, are checked against independent durable readback. Recoveries are checked against that retained canonical result as well as fresh readback.

- Spawn/resume compare the saved idempotency outcome and indexed run/link identities. Only the explicitly named optional top-level advice and wake presentation fields are excluded from equality. These are the fields produced by cache/wake composition; required acceptance fields are not ignored.
- Cancel requires accepted=true and exact original durable cancellation time. Any optional returned status is checked for the target and stable read facts; its captured event high-water may precede the final wave high-water.
- Whoami requires the expected fixture run, current binding for the actual caller/context/generation/session, matching run binding generation/target session, and an exact bound reply with the correct run/link.
- Report requires exact stored report/run identities.
- Status checks run/link IDs and states, run sequence, expected generation, cancellation timestamp, currentness, terminalness, slot ownership and event high-water.

Existing wave conservation and recovery no-duplicate accepted/run/slot/report/cancel/binding/launch assertions remain. Checker controls describe wrong run/link/outcome, cancel accepted/timestamp, pending whoami, missing binding, report identity and status target/read-fact failures with unchanged canonical objects.

## F4: Semantic fault bank is not a numeric exemption

The zero-delay commit-uncertain control remains in the semantic fault bank but is now included in operational numerical gates. Natural latency cannot be exempted merely because acknowledgement loss was predeclared.

An operational numerical exclusion is limited to a non-recovery forced callback-overrun or commit-overrun row with a declared 40 ms injection, recorded actual injection duration at least 40 ms, and authorization duration beyond 30 ms. Every row remains in inclusive numerical reporting. Exemption call IDs and counts are explicit.

The zero-delay uncertainty control preserves real COMMIT, uncertainty/no-notAccepted semantics, independent readback and fresh-connection canonical recovery without redispatch. A checker control requires a naturally 31 ms zero-delay uncertainty write to fail the operational bound.

## F5: Fail-closed timing validation

A write must provide trusted write-budget applicability and actual finite nonnegative numeric elapsed, authorization, deadline, overrun, wait and queue values. The original deadline, interval relationships, lock-attempt count, enclosing-deadline kind, checkpoint sequence, phase totals and phase counts are validated.

Status must provide read-only applicability, explicit null writer-only fields, valid elapsed/upfront intervals, no lock attempts and the read-only enclosing-deadline kind. The full response timing remains required. Missing diagnostics and null/string/negative/NaN/infinite values cannot qualify through JavaScript coercion.

Cold CLI diagnostics receive the same write validation and begin/end validation. Invalid attempts remain in raw evidence and invalidate completeness/numerical qualification. Per-population timing coverage explicitly reports expected response/write/read counts, valid counts and invalid attempt counts; a smaller filtered timing distribution cannot silently qualify the larger population.

Fixed checker controls cover malformed required fields, missing values, wrong applicability and read-only N/A violations. They run only when the driver is later authorized to execute, are labeled pure evidence-checker controls, and never enter benchmark samples, timing populations or measured call counts.

## H=2 journaling correction

Both H=2 dispatch intentions are appended before either frame is issued. Finished/incomplete response records and queued-predecessor support records are appended only after every primary response clock in the wave has ended. Final semantic records follow durable validation. Started records still preserve an interrupted call's existence.

This removes the identified synchronous completion-log write from the sibling's measured in-flight interval. It does not subtract time, discard samples, or claim that instrumentation overhead has been measured. SQL/callback/backoff instrumentation and host interference still require measurement.

## Preserved scope and remaining gates

- All six tools, H/R 1/1 and 2/10, 126 cells, 50 warmups and 1,000 measured primaries per cell remain unchanged: 132,300 primary calls. Recovery calls are additive.
- Real framed service/SQLite paths, production monotonic clock, independent holder, heartbeat contention, accepted observation-store storage load, bounded locks, owned cleanup and legitimate fixture authority remain.
- First-use/cold labels remain narrow. Main waves use fresh compositions; four additive capability-refusing CLI probes are not a positive cold acceptance population.
- The 99,225 main-fixture waves, two cold fixtures, 3,600-second outer bound and runtime feasibility remain unverified. Timeout must remain incomplete, never grounds to shrink the matrix.
- Existing AF_UNIX-listen/PTRACE_TRACEME restrictions and HYG2/RUNZ1/S3F full-check blockers remain independent and are not retried or bypassed here.
- Build provenance, raw checks and exact compiled-tree custody remain external prerequisites. Recording hashes alone does not prove the build source.
- Three isolated complete series on each exact supported Node 22 and Node 24 family remain required, with no competing controlled workloads.
- Real-Claude same-call timing, real harness/capability, Herdr/tmux, formal WSL and B14 qualification remain unverified.
- Fresh exact-source Oracle review, all ordinary checks and full green merged-tree checks remain required. No acceptance, performance qualification, compute admission or merge is claimed.

## Formatting and execution disclosure

No compiler, syntax checker, formatter, test, holder, driver, benchmark, negative control, npm command or local checkout workload was run for this correction. Source editing and inspection used connector reads and string preparation only.

The supplied Prettier 3.9.9 failure for the two driver paths is preserved. Official formatting is deliberately pending the dispatcher's separately authorized cloud process and must be limited to tests/int/p065-budget-benchmark.mjs and tests/int/p065-ledger-holder.mjs. This raw source correction does not claim that formatting is green. No further source file is requested for F1–F5.
