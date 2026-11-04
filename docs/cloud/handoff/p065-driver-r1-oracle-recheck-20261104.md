# P065 driver R1: independent exact-source re-check

Date: 2026-11-04 UTC

## Verdict

**Accept the narrow R1 source correction. R1 is closed at source-review level; F1–F5 remain fixed at source level. No new required source finding.**

The candidate may proceed to the already separately authorized two-file formatter/readiness sequence. This is not a P065 package acceptance, executed checker pass, performance qualification, compute admission, permission to retry restricted operations, or merge approval. Lifecycle interruption evidence and the full runtime/acceptance gates remain outstanding.

The earlier rejection of parent 888643531ca1f9f9dc53761de59ce5f9b03d48b1 remains a valid historical result. This successor fixes its identified pending-intention reporting defect; it does not erase that failure or reset the existing remediation allowance.

## Exact identity and changed scope

Independently verified through read-only GitHub Git-object, ref, compare, commit-diff and exact-file reads:

- Repository: CartmanFatass/codex-hud.
- Branch at inspection: dots/p065-budget, pointing to 4a484053473524b33184dc2cffc3dabd4bd63158.
- Candidate commit: 4a484053473524b33184dc2cffc3dabd4bd63158.
- Candidate tree: c47535fbdfebf009449aa20859424d8b1bef0369.
- Sole parent: 888643531ca1f9f9dc53761de59ce5f9b03d48b1.
- Parent-to-candidate comparison: one commit ahead, zero behind, exactly two changed paths:
  - tests/int/p065-budget-benchmark.mjs: modified, 113 additions and 15 deletions; blob 0487fcd1d55aa66192fa4ffa143c49d69ca04cbd; 1,353 source lines plus the terminal newline.
  - docs/cloud/handoff/p065-budget/performance-driver-interruption-correction-20261104.md: added, 71 lines; blob 7e1b20b1e040a21071d103fac67ec0a62d4399ef.
- The exact parent driver was independently fetched as blob be95114afe80959093607bbb15a85b51610fe70e.
- The unchanged holder was independently read at the candidate as blob b75f9f3c2d477c34a6b44119414f3c77e7157724.
- The frozen fixture was independently read at the candidate as blob 4264874ef20ebbae2fabe80fe505785c8a89c191.

The correction does not change production code, the holder, frozen fixtures, the existing audit formatting successor, packages/build/lock files, contracts, shared status or rulings. Both historical driver reports and prior candidates remain untouched. The new report is additive. The verified parent relationship and complete two-path comparison corroborate that scope; report assertions alone were not used as proof.

## Method and limits

Read the complete prior R1 ruling, the complete new correction report, the complete candidate driver, its exact parent source and full diff. Revisited repository workflow and binding P065 population, isolation, timing, evidence and release requirements. Compared the unchanged source regions directly, including the original nine checker groups, physical workload/fault/recovery logic and report/entrypoint tail.

This was static source review and read-only connector/file access. I did not execute the driver, holder, embedded checker controls, a syntax checker, compiler, formatter, tests, benchmarks, npm commands or checkout workloads. No repository or external state was modified. The only new local file is this requested review artifact.

The control conclusions below mean that the required inputs and discriminating assertions are present and the control flow was inspected. They are not claims that any control ran or passed. Runtime timing, filesystem durability and end-to-end interruption cleanup remain unverified by this review.

## R1 closure

### 1. A registered intention is summary-safe immediately

Relevant driver lines: 472–521, 554–559, 578–597, 903–931.

prepareCall now assigns row.numeric = numerical(row) before incrementing the call count, registering the row or writing its started record. An intention has neither diagnostics nor response duration, so the existing strict numerical checker records incomplete timing. It does not fabricate a zero duration or dereference absent diagnostics: the completeTiming conjunction short-circuits the write-bound expressions.

There are also two independent defensive readers:

- numericalGates derives numerical(row) when numeric is absent.
- summarize creates shallow row copies with a derived numeric result when needed, leaving the original input row untouched. It also requires finished === true and semantic === true before treating a row as semantically successful.

Thus both the new live pending shape and the historical/raw shape that triggered R1 can be counted without the absent-numeric TypeError. A pending primary remains in measured/warmup populations and timing expectations, and it makes the applicable per-call and response gates fail.

call still performs checkOuter before dispatch. This is now safe for a pre-created row because the registration state already has invalid numerical evidence and the surrounding wave catches the rejected call. The patch does not turn a failed outer check into an issued frame.

### 2. Every registered row in a failed wave gets a final disposition

Relevant driver lines: 629–651, 728–740, 853–868, 874–883.

The wave captures rows.length before its try body. On failure, it finalizes rows.slice(registeredStart), rather than only waveRows, the subset whose primary calls returned. This includes the never-issued second H participant and any already registered recovery in that wave. It does not touch earlier waves.

finalizeWaveFailure records the original wave error in interruptionReason and a semantic error, preserves any earlier per-call error, and assigns one of three explicit dispositions:

- not_issued_incomplete for a pending intention;
- issued_incomplete for an issued but unfinished call;
- issued_completed_wave_failed for a completed call whose containing wave failed.

The finalizer does not change finished or dispatchState, does not add a response/diagnostics/end timestamp, does not append a replacement attempt, and preserves any already recorded actual timing. Each registered row is serialized as wave_failed. The same wave error is then rethrown.

The job list includes every attempted primary call, even a job that rejects before issuing a frame. The actual dispatchState remains the authority for issued versus pending accounting. In the operational H=2 race where one participant rejects before dispatch while its sibling is already awaiting a response, Promise.allSettled waits for the sibling's bounded response path before failure records are written. The existing response timeout remains 5,000 ms. This avoids restoring synchronous completion-log writes inside the sibling's timed interval.

Recoveries are awaited sequentially and registered into the same rows collection. There is no new overlapping recovery path that bypasses the failure finalizer. No recovery, redispatch or resampling is introduced by the correction.

### 3. Incomplete summaries retain population and timing truth

Relevant driver lines: 903–1012, 1312–1345.

The corrected summary explicitly reports registered, issued, pendingNotIssued, uncompleted and interrupted counts. Missing actual outcomes count under observedOutcomes.uncompleted. The detailed timing populations retain their expected response/read/write counts and invalid-timing counts.

Transaction, callback, COMMIT, rollback and backoff distributions now include only actual finite, nonnegative measurements. A pending row no longer contributes manufactured zero-duration samples. Real zero values that a completed call actually recorded are still retained. Missing measurements do not disappear from population or completeness accounting merely because they are absent from the duration distribution.

For the R1 schedule, the mixed H=2 collection remains two registered primaries, with one invalid/uncompleted/pending row and only one actual response measurement. Both numerical qualification and semantics fail closed. For interruption before either dispatch after pre-journaling, both intentions remain pending, both are invalid, and response/transaction distributions have n=0.

The existing cell-level catch now receives summary-safe rows, appends the incomplete distribution, snapshots the incomplete report, and rethrows. The top-level catch retains failure status. The patch therefore removes the identified secondary reporting exception rather than merely relying on a nonzero final exit.

This conclusion is scoped to the registered-intention interruption path. It is not a guarantee that arbitrary storage failure, uncatchable process termination, or an external hard kill can finish writing an artifact. Those cases must never be represented as completed evidence.

### 4. The new pure checker is appropriate, but not runtime evidence

Relevant driver lines: 1146–1208; integration at 1213–1222.

The tenth checker group constructs the required mixed H=2 shape: one finalized issued row and one pre-journaled pending row with no response, diagnostics or numeric object. It calls both summarize and numericalGates directly before finalizing the pending row. Assertions cover:

- two total/measured intentions retained;
- incomplete population, numerical and semantic results;
- one invalid timing, two expected responses/writes, and one valid write;
- exactly one actual response and transaction measurement;
- the raw pending object not being mutated by summary normalization;
- pending/not-issued disposition, unchanged unfinished state and original interruption reason;
- no fabricated response or end field;
- final summary surviving a JSON stringify/parse round trip with both registered attempts retained.

The same group separately constructs two pending rows before any dispatch and checks zero issued calls, two pending/invalid rows, incomplete qualification and semantics, zero measured response/transaction durations, unchanged unfinished state, retained original reason, and absent response/diagnostics/end fields.

The assertions would encounter the original dereference failure on the parent's unnormalized pending input. They are substantive checker inputs, not merely function-name checks. They do not create benchmark samples or relax the WARMUPS/MEASURED constants. All nine prior checker groups are preserved verbatim, apart from the adjacent added group. These controls remain unexecuted.

The pure control does not exercise an actual signal, outer deadline, sibling response timer, raw JSONL writer, helper cleanup or cell snapshot on disk. Later authorized lifecycle validation must supply that evidence. A synthetic JSON round trip alone does not establish end-to-end partial-artifact custody.

## F1–F5 preservation

### F1: independent measured-primary percentiles remain mandatory

Relevant driver lines: 533–559, 903–1010, 113–132; controls 1034–1061.

The five response gate scopes and per-actual-outcome p95 calculations are unchanged. The only numericalGates change is safe fallback for absent numeric; valid completed rows retain the same predicate. Warmups and recoveries cannot dilute measured-primary qualification. Inclusive and correctly selected operational gates still feed the top-level population/acceptance conjunction. Per-call 30 ms authorization, 20 ms cumulative wait and zero SQLite busy timeout checks remain.

### F2: successful response-loss coverage remains per participant

Relevant driver lines: 44–49, 561–576, 753–763, 823–868, 967–989; control 1062–1081.

The per-participant successful-lost, independent-durable-inspection and checked-recovery requirements are unchanged. Reports retain the explicit inspection-only, no-resubmission exception. The new summary normalization only strengthens failure behavior for unfinished rows; a pending or busy loss attempt cannot become successful-loss coverage. Actual busy/refusal outcomes and additive recovery populations remain retained.

### F3: client-visible replies remain checked against canonical durable truth

Relevant driver lines: 389–465, 753–790, 853–868; controls 1082–1112.

The independent durable reads and canonical comparisons are unchanged. Spawn/resume saved outcomes, report identity, bound whoami subject, cancel acceptance/original timestamp and status read facts still constrain captured primary successes and recovery responses. Recovery still compares returned data with retained canonical truth and independently requires stable durable identity/conservation. No database-only self-comparison or optional-field expansion was introduced.

### F4: zero-delay COMMIT uncertainty remains numerically operational

Relevant driver lines: 330–339, 523–531, 963–1008; control 1113–1119.

The exemption predicate is unchanged. Only evidenced declared 40 ms callback/COMMIT overruns can be exempted; mere forced-bank membership and zero-delay commit-uncertain are insufficient. Pending rows lack actual injection/timing evidence and are not exempt. Real COMMIT truth, no false notAccepted claim, fresh-connection canonical recovery and no automatic report resubmission remain unchanged.

### F5: malformed timing remains invalid, with pending rows now covered

Relevant driver lines: 472–521, 554–559, 903–955; controls 1120–1144 and 1146–1208.

Strict finite nonnegative numeric validation, explicit write/read applicability, original deadline/interval consistency, checkpoint/phase validation and read-only N/A rules are unchanged. The parent’s malformed-value and cold/read-only controls remain intact. New pending rows now enter that same invalid-timing machinery at registration, and missing historical numeric objects are normalized safely rather than coerced into passing zero-duration values. The actual timing denominators and invalid counts are still exposed.

## Scope and report assessment

Direct source comparison confirms unchanged settings, framed client, production-clock selection, canonical truth/timing/exemption helpers, loss-coverage function, call execution/finalization, fixture setup, physical scenario assertions/recovery, report snapshots and entrypoint tail. The substantive delta is confined to pending evidence state, wave failure handling, missing-measurement summary treatment, dispatch accounting and its pure checker.

The full matrix remains 126 cells, six tools, H/R=1/1 and 2/10, 50 warmups and 1,000 measured primaries per cell: 132,300 primary calls plus additive recoveries. The 3,600-second outer bound is unchanged. No reduced population, replacement sampling, extra exception or hidden qualification switch was added.

The helper, legitimate synthetic fixture authority, actual framed SQLite path, heartbeat CAS, accepted observation-store load, physical lock and fault controls, bounded owned cleanup and no-B10D boundary remain unchanged. The pre-journaling versus response-logging separation is preserved. Instrumentation overhead still needs measurement/disclosure and cannot be subtracted to make a result qualify.

The additive report accurately describes this correction and labels its controls as source-only and unexecuted. Its statement that incomplete summaries can be written is supported for the identified absent-numeric path, with the ordinary storage/hard-termination limitations above. It appropriately retains separate lifecycle/runtime/qualification gates and does not claim package acceptance.

## Exact next steps and retained holds

1. Preserve and record this narrow source-review acceptance, the prior rejected candidate, every correction report and the existing remediation count. No further R1 source change is required by this review.
2. Continue the already separately authorized official Prettier 3.9.9 process for only tests/int/p065-budget-benchmark.mjs and tests/int/p065-ledger-holder.mjs. Preserve the earlier failed formatting check. Pin the successor’s commit/tree/parent and prove formatter-only source scope and unchanged holder behavior. Do not sweep production, fixture, dependencies or unrelated formatting paths. Review any non-formatting delta separately.
3. Obtain the dispatcher's explicit quiet compute admission before project execution. On the exact final formatted tree, retain syntax/readiness output for both driver files, exact Node executable/version and source identity, required build logs, exit statuses and durations. Required builds remain npm run build, npm run build:test and npm run build:hud-mcp, each with the existing 180-second bound. Syntax/format passes are not test or benchmark passes.
4. Establish compiled-artifact custody for that exact tree before using dist, dist-test or packages/hud-mcp/dist. Recorded output hashes alone do not prove they came from the recorded source. Run the binding P065 deterministic, behavioral-control and shared-writer regression/check stages only within existing authorization and restrictions, retaining every failed and never-run stage separately. Do not claim an aggregate green when one chained stage failed or was blocked.
5. In an explicitly authorized lifecycle validation, retain actual partial/interrupted artifacts for the R1 path. Account for every registered intention, including a pre-journaled participant never dispatched; verify the original wave error, dispatch disposition, missing timing, incomplete cell snapshot, parseable JSON/JSONL and owned-resource cleanup. Exercise the already-issued sibling case as well as before-first-dispatch where feasible. Do not shorten or replace the 50/1,000 qualification populations to manufacture this control. The exact final source must receive the lifecycle evidence.
6. Measure/disclose instrumentation overhead and host interference before operational qualification. Run the unchanged complete matrix in three isolated series on each exact supported Node 22 >=22.13 and Node 24 runtime, with distinct artifacts. Use the existing 3,600-second bound per series. No competing controlled build, test or benchmark workload. Preserve every failed, partial, interrupted or contaminated series; a timeout remains incomplete, not permission to shrink samples. The 99,225 main fixture waves plus two cold fixtures per series and feasibility within the bound remain unverified.
7. Inspect artifacts rather than exit status alone: all ten checker-control outcomes; primary/warmup/recovery and actual-outcome populations; every numerical flag; successful-loss coverage for each participant; canonical reply and fault semantics; heartbeat/storage/lock participation; timing validity; and pending/intention accounting in partial reports. Busy/refused/slow outcomes and recoveries remain visible. Preserve run ranges, not just the best run.
8. Keep AF_UNIX-listen and PTRACE_TRACEME restrictions, and the independent HYG2/RUNZ1/S3F full-check blockers, intact. This source ruling gives no new capability evidence, bypass permission or denied-operation retry authority. Blocked aggregates remain blocked/unrun. Focused passes do not upgrade them.
9. Keep real-Claude same-call 150/50 timing, real harness/capability cells, Herdr/tmux, formal WSL and B14 qualification separate. Final independent Oracle package acceptance and a full green check set on the actual merged tree remain prerequisites to integration. Neither this source review nor the formatter successor alone satisfies those gates.

## Source links

- [Reviewed commit](https://github.com/CartmanFatass/codex-hud/commit/4a484053473524b33184dc2cffc3dabd4bd63158)
- [Exact parent comparison](https://github.com/CartmanFatass/codex-hud/compare/888643531ca1f9f9dc53761de59ce5f9b03d48b1...4a484053473524b33184dc2cffc3dabd4bd63158)
- [Corrected driver](https://github.com/CartmanFatass/codex-hud/blob/4a484053473524b33184dc2cffc3dabd4bd63158/tests/int/p065-budget-benchmark.mjs)
- [Additive R1 correction report](https://github.com/CartmanFatass/codex-hud/blob/4a484053473524b33184dc2cffc3dabd4bd63158/docs/cloud/handoff/p065-budget/performance-driver-interruption-correction-20261104.md)
- [Exact parent driver](https://github.com/CartmanFatass/codex-hud/blob/888643531ca1f9f9dc53761de59ce5f9b03d48b1/tests/int/p065-budget-benchmark.mjs)
- [Prior F1–F5 correction report](https://github.com/CartmanFatass/codex-hud/blob/4a484053473524b33184dc2cffc3dabd4bd63158/docs/cloud/handoff/p065-budget/performance-driver-correction-20261104.md)
- [Unchanged holder](https://github.com/CartmanFatass/codex-hud/blob/4a484053473524b33184dc2cffc3dabd4bd63158/tests/int/p065-ledger-holder.mjs)
- [Frozen fixture](https://github.com/CartmanFatass/codex-hud/blob/4a484053473524b33184dc2cffc3dabd4bd63158/tests/unit/p065-budget-fixture.ts)
- [Binding measurement/check requirements](https://github.com/CartmanFatass/codex-hud/blob/4a484053473524b33184dc2cffc3dabd4bd63158/docs/cloud/P065-BUDGET.md)
- [Release ruling](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/p065-budget-release.md)
- [Six-design disposition](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/p065-six-design-dispositions.md)
