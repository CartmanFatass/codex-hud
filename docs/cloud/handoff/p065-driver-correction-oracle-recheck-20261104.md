# P065 performance-driver correction: independent source re-check

Date: 2026-11-04 UTC

## Verdict

**Fix required: one new P2 interruption/evidence-recording regression, R1 below. F1–F5 are fixed at source level.**

The correction is not yet ready to be called a closed source-readiness result. A narrow driver-only R1 fix is needed. The separately authorized two-file formatter step remains appropriate, preferably after that correction so it formats the final source. This ruling grants no workload execution, compute lease, package acceptance, performance qualification or merge permission.

No original F1–F5 false-pass mechanism remains in the inspected normal completed-call paths. The new defect does not turn an interrupted series into a pass; it makes its incomplete-cell reporting throw and omit the affected cell from the summary. Interrupted and partial evidence is part of the driver's required deliverable, so this is a required correction rather than a formatting nit.

## Exact identity and scope

Independently confirmed with GitHub Git-object, ref, file and compare reads:

- Repository: CartmanFatass/codex-hud.
- Branch at inspection: dots/p065-budget, pointing to 888643531ca1f9f9dc53761de59ce5f9b03d48b1.
- Candidate commit: 888643531ca1f9f9dc53761de59ce5f9b03d48b1.
- Candidate tree: c812a831e14a8c8d39ef275850f48766b92fc45d.
- Sole parent: deb24af271f93914b48fe86d6835f1b3ce1d3e56.
- Parent-to-candidate comparison: one commit ahead, zero behind, exactly two changed paths:
  - tests/int/p065-budget-benchmark.mjs: modified, 387 additions and 49 deletions; blob be95114afe80959093607bbb15a85b51610fe70e; 1,255 source lines.
  - docs/cloud/handoff/p065-budget/performance-driver-correction-20261104.md: added, 100 lines; blob 94223acd7f90ff631c7fb34f302bdb2f10d89c48.
- tests/int/p065-ledger-holder.mjs is unchanged, independently read back as blob b75f9f3c2d477c34a6b44119414f3c77e7157724.
- Comparison from the prior reviewed candidate 8ba05de09e35abe3891ff6f6fb3b35f6065b3d65 contains only those two paths plus the intervening tests/unit/p065-rejection-audit.test.ts formatting change. This correction does not alter that formatting successor.
- No production, frozen fixture, package/build/lock, shared status, contract or ruling path changes in this correction. The original implementation report and historical failures are preserved.

## Method and limits

Read the complete prior source review and complete correction report, all of the corrected driver, the unchanged holder and frozen fixture, relevant original and current production budget/server/delegation/read-control/handshake/intent/reconciliation/heartbeat code, the schema and the independent delegation-read implementation. Consulted the repository workflow and binding P065 release, six-design and measurement requirements.

This was static source inspection and read-only connector/file access. I did not execute the driver, holder, embedded checker controls, syntax checker, compiler, formatter, tests, benchmark, npm command or checkout workload. I changed no repository source or external state. The only new local file is this expressly requested review artifact.

Statements below about controls mean the control source is present and its logic has been inspected, not that it ran or passed. Source-level counterexamples are reasoned from the control flow, not represented as observed runtime failures.

## Previous findings

### F1 — Fixed at source level: primary measured percentiles cannot be diluted

Relevant driver lines: 533–556, 880–940, 967–975, 113–132. Embedded controls: 1000–1027.

numericalGates constructs five distinct response scopes: all attempts, measured primaries, warmup primaries, measured recoveries and warmup recoveries. Every nonempty scope has its own nearest-rank p95 and actual-outcome p95 checks. The qualification result requires every scope to qualify, in addition to the per-call write, wait and SQLite-timeout flags.

summarize uses those results for both inclusive and correctly selected operational populations. operationalNumericalQualification consumes operationalNumerical, and acceptanceChecks consumes that qualification. Reported primary-measured distributions also now explicitly exclude recoveries.

The controls include:
- 51 slow calls among 1,000 measured status primaries plus 50 fast warmups. The 1,050-call inclusive p95 passes, while the measured-primary p95 is 60 ms and the combined gate fails.
- Slow measured primaries plus 1,000 fast recoveries, with the same independent primary failure.
- A slow actual-outcome split and a slow recovery population.

These controls exercise the checker behavior that failed in F1 rather than merely checking that a field or function exists. The per-call 30/20 ms gates are retained.

### F2 — Fixed at source level: successful-loss and recovery coverage is mandatory

Relevant driver lines: 44–49, 558–574, 734–744, 768–769, 804–849, 940–962. Embedded controls: 1028–1047.

Each response-loss cell predeclares, for every participant, at least one measured successful lost response, one verified independent durable inspection, and one checked recovery. Report explicitly requires zero resubmissions and still requires successful loss plus durable inspection.

Only primary measured rows with actual success, discarded delivery, verified canonical reply/durable inspection and passing semantics count. Checked recovery is separately counted. The returned summary records requirements, participant counts and call IDs, and its coverage result is part of cell completeness. An all-busy loss cell or a missing H participant cannot qualify.

A captured server success is now checked against independent durable truth before the response-loss-specific branch. Success without a durable target sets semantic failure and cannot count as successful-loss coverage. Status recovery must remain free of instrumented writer transactions. Busy/refused attempts are retained; no resampling or primary-population replacement was added.

The controls cover all-busy loss coverage, absent participant, absent inspection, absent checked recovery, and report's deliberate inspection-only exception. The generic canonical checker rejects success with absent durable truth; that rejection is connected to the live row's semantic and coverage flags.

The minimum-one coverage is semantic coverage, not a claim that every one of the 1,000 attempts succeeds or a replacement for the declared primary population.

### F3 — Fixed at source level: client-visible canonical results are actually compared

Relevant driver lines: 389–465, 734–744, 755–767, 834–849. Embedded controls: 1048–1078.

The independent readback and comparison now establish the requested canonical result:

- Spawn/resume: the saved idempotency outcome must be accepted and agree with its indexed run/link identities. Required client-visible fields must equal that outcome plus ok=true. Only the explicitly named optional top-level advice and wake presentation fields are ignored.
- Whoami: SQL restricts the binding to the expected fixture run and actual caller/context/generation, a current unrevoked binding, an open matching caller context, matching session, and run binding generation/target session. The reply must exactly state bound, with that run/link and null reason.
- Report: the stored report is selected by requested summary and run, and the returned report/run IDs must match it exactly.
- Cancel: accepted must be true and cancellation time must equal the original durable timestamp. An optional returned status is checked for target identity and stable read facts. Its captured event high-water may be earlier than the post-wave high-water, which is necessary for concurrent independent cancellations.
- Status: returned target run/link, their states, sequence/generation, cancellation time, currentness, terminalness, slot ownership and event high-water are compared with the independent readback.

The compared production response shapes match these predicates. In a status-only wave, the heartbeat updates run heartbeat columns but emits no events and does not change the checked lifecycle fields. Omitting volatile heartbeat fields from strict post-wave equality therefore avoids a false contradiction. Cancel's explicit earlier-high-water allowance likewise avoids treating the other H participant's later event as a wrong response.

Primary captured successes, including late successful COMMIT, use the checker. Recovery compares the actual returned result to the retained canonical snapshot, then requires unchanged independent durable readback and unchanged acceptance/run/slot/report/cancel/binding/launch counts. It no longer compares the database only to itself.

Controls cover wrong run/link/saved outcome, wrong cancel acceptance/timestamp, pending or wrong-target whoami, absent binding, wrong report identity, and wrong status target/read fact.

### F4 — Fixed at source level: zero-delay uncertainty is numerically operational

Relevant driver lines: 330–339, 523–532, 936–975, 1217–1218. Embedded control: 1079–1085.

Semantic fault-bank membership is no longer the exclusion predicate. overrunExempt is limited to a non-recovery forced callback-overrun or commit-overrun with the declared 40 ms injection, an observed injection interval of at least 40 ms, and authorization time exceeding 30 ms.

The zero-delay commit-uncertain scenario is not eligible. Its ordinary response, authorization, cumulative-wait and timeout results feed operational qualification. The control explicitly constructs a zero-delay uncertainty write with authorizationMs=31 and requires operational failure.

All attempts remain in inclusive reporting and all exemption IDs/counts are exposed. Primary malformed timing cannot be hidden by an exemption because completeness still requires valid timing. Real COMMIT, uncertainty/no-notAccepted handling, fresh-connection recovery and no redispatch remain intact. This remains the narrow forced-overrun exception, not a waiver for natural latency.

### F5 — Fixed at source level for returned/failed calls: malformed diagnostics fail closed

Relevant driver lines: 472–521, 554–556, 897–927, 114–118, 1198–1205. Embedded controls: 1086–1110.

Required timing fields now use an explicit finite nonnegative number predicate; null, strings, negative values, NaN, infinity and missing values cannot pass through coercion. Write applicability must match the tool. Write diagnostics also check bounded positive original deadline, authorization/elapsed and queue/wait relationships, attempt count, enclosing-deadline kind, ordered checkpoints and phase aggregate values/counts.

Status requires read-only applicability, explicit null writer-only fields, valid elapsed/upfront values, zero attempts and the read-only enclosing-deadline kind. The external full-response interval remains required. Cold CLI diagnostics use the same write validation plus valid begin/end timestamps.

Per-scope timing coverage reports expected and valid read/write/response counts and invalid attempts, rather than silently equating a smaller filtered timing distribution with the full population. The controls cover malformed required write fields and response duration, wrong applicability, cold timing, read-only N/A violations and invalid read upfront time.

R1 below is a separate newly introduced pre-dispatch path that can avoid creation of any numeric result and then crash the summarizer. Closing F5's completed-call coercion issue does not excuse that interruption path.

## New required finding

### R1 — P2: Pre-journaled, never-issued participants can crash incomplete-cell reporting

**Locations:** tests/int/p065-budget-benchmark.mjs:575–610, 710–722, 855–860, 897–927, 1224–1228. numericalGates at 554–555 also assumes numeric exists.

**Defect:** prepareCall now pushes and journals every participant before any frame is issued, but leaves numeric absent. call executes checkOuter before entering its try/finally. A prepared participant can therefore never enter the finalizer that assigns row.numeric.

**Concrete static failure schedule:**

1. In a forced H=2 wave, both intentions are registered in rows and written as started with dispatchState=pending.
2. The first participant begins just before the outer deadline and runs its required synchronous 40 ms callback/COMMIT stall. It finishes after that deadline. Equivalently, an interruption can be observed between participant calls.
3. The second sequential call reaches checkOuter and throws before its try/finally. Its pre-created row remains unfinished, not issued, and without numeric.
4. wave's catch marks only waveRows, which contains returned calls, not that pending participant. The pending row has only its initial started record.
5. The cell-level catch invokes summarize(cell, rows). The new coverage descriptions dereference row.numeric.completeTiming, for example validWrite/validRead/invalid at 901–904. This throws a TypeError before the incomplete cell is appended to distributions and before its intended snapshot is written. A pre-dispatch outer check can cause the same problem for a prepared first participant.

**Consequence:** The top-level catch still makes the series fail and can write an overall incomplete report, and the raw started record is not erased. However, the affected cell has no final distribution, per-attempt invalid-timing accounting or intended incomplete summary. A reporting exception obscures the original interruption path. This is a regression from moving row registration ahead of call's outer check, not a claim that an interrupted run passes qualification.

**Required correction, within the driver only:**

- Make every registered/pending row safe for summary from creation onward, or make all summary/gate readers explicitly handle absent numeric as invalid. Do not manufacture zero durations, mark a pending row finished, drop it or replace it with another primary.
- On interrupted/failed waves, finalize all registered rows for that wave, including never-issued participants, with an explicit pending/not-issued/incomplete disposition and the original interruption reason. Preserve the distinction between dispatch intention and an issued MCP call.
- Ensure the failed cell is summarized and snapshotted without a secondary exception; completeness and relevant numerical/semantic results must fail closed.
- Add a pure checker control for a mixed H=2 collection containing one finalized row and one pre-journaled pending row with no response/diagnostics/numeric. Require no summarization exception, retained population/invalid counts, incomplete qualification and no invented latency. Also cover interruption before the first dispatch if handled through a separate path.
- In later authorized lifecycle validation, retain the partial artifacts from an outer-timeout/interruption path and confirm they parse and account for every registered intention. Do not shorten, replace or qualify the 50/1,000 production benchmark population to manufacture that control.

No frozen-fixture, production, holder, package or build change is needed for R1.

## Other verified preservation and report assessment

The examined fixes preserve the 126 declared cells, six tools, H/R=1/1 and 2/10, 50 warmups and 1,000 measured primaries per cell, totaling 132,300 primary calls. Recovery calls remain additive. There is no reduced-population switch.

The exact delta leaves the actual service/framed SQLite path, production monotonic clock, owned helper, legitimate fixture authority, helper lock bounds, heartbeat CAS and accepted observation-store load unchanged. Fault controls still target the actual requested operation; uncertainty does not automatically redispatch or resubmit reports. Cleanup remains confined to owned helper objects and the owned temporary tree.

The H=2 normal completion logging correction is substantive: dispatch-intention writes occur before either frame, while flushed/incomplete result writes and queued-predecessor support writes occur after both primary response clocks finish. This removes the prior synchronous completion-log storage work from a sibling's timed interval. Other per-call instrumentation/host overhead remains unmeasured and must not be subtracted. R1 concerns the newly separated preparation/finalization lifecycle, not a reason to restore the old in-flight append.

The nine groups of embedded controls are fixed pure checker inputs, not benchmark samples. They run before workload startup in a later authorized invocation and cannot replace physical fault controls, exact-tree checks, or measured populations. None was run in this review.

The additive report accurately discloses source-only status, pending formatting, synthetic limitations and unverified runtime feasibility. Its completed-call descriptions of F1–F5 agree with the source. Its broad preservation of unfinished attempts needs the R1 qualification above and should be amended additively when corrected.

## Exact next steps and retained holds

1. Return R1 unchanged to the existing implementer for a source-only driver correction, with an additive correction record. Preserve this candidate and all historical reports/failures. Count the correction within the existing fix-round allowance; do not reset package remediation limits.
2. Perform a fresh exact-source re-check of that narrow correction. Verify the commit/tree/parent, exactly authorized changed paths, the pending-row control and retention of F1–F5. Do not infer a runtime pass from the source review.
3. In the already separately authorized formatter process, format only tests/int/p065-budget-benchmark.mjs and tests/int/p065-ledger-holder.mjs using the verified official Prettier 3.9.9 workflow. Preserve the earlier failed check. Prove formatter-only scope and preserve holder behavior. Do not turn this into a production, fixture, dependency or unrelated formatting sweep.
4. Admit any execution only through the dispatcher's explicit quiet compute slot. On the final exact formatted tree, retain syntax/readiness output for both driver files, the required build outputs and ordinary allowed check stages with exact Node/runtime/source identity. A syntax or formatting pass is not a benchmark or full-check pass. Hashes alone do not prove compiled-source provenance.
5. Before operational qualification, measure/disclose instrumentation overhead and establish exact-tree build/artifact custody. Execute the unchanged full matrix with distinct raw artifacts in three isolated complete series on each exact supported Node 22 and Node 24 runtime. No competing controlled build/test/benchmark workload. Preserve every failed, partial, interrupted or contaminated attempt; a 3,600-second timeout is incomplete, never a basis to shrink the population.
6. Inspect artifacts, not just exit status: checker-control outcomes, required primary and recovery scopes, per-outcome percentiles, every per-call numerical flag, participant loss coverage, fault semantics, actual heartbeat/storage/lock participation, and valid incomplete-cell accounting. The 99,225 main fixture waves plus two cold fixtures and feasibility within the existing bound remain unverified.
7. Preserve AF_UNIX-listen and PTRACE_TRACEME restrictions and the independent HYG2/RUNZ1/S3F full-check blockers. This review supplies no new permission/capability evidence, retry authorization or workaround. Blocked aggregates remain blocked/unrun; focused passes do not make them green.
8. Real-Claude same-call 150/50 timing, real harness/capability cells, Herdr/tmux, formal WSL and B14 qualification remain separate. Final independent Oracle acceptance and the full green actual merged-tree check set remain prerequisites to integration.

## Source links

- [Reviewed commit](https://github.com/CartmanFatass/codex-hud/commit/888643531ca1f9f9dc53761de59ce5f9b03d48b1)
- [Exact parent comparison](https://github.com/CartmanFatass/codex-hud/compare/deb24af271f93914b48fe86d6835f1b3ce1d3e56...888643531ca1f9f9dc53761de59ce5f9b03d48b1)
- [Corrected driver](https://github.com/CartmanFatass/codex-hud/blob/888643531ca1f9f9dc53761de59ce5f9b03d48b1/tests/int/p065-budget-benchmark.mjs)
- [Additive correction report](https://github.com/CartmanFatass/codex-hud/blob/888643531ca1f9f9dc53761de59ce5f9b03d48b1/docs/cloud/handoff/p065-budget/performance-driver-correction-20261104.md)
- [Unchanged holder](https://github.com/CartmanFatass/codex-hud/blob/888643531ca1f9f9dc53761de59ce5f9b03d48b1/tests/int/p065-ledger-holder.mjs)
- [Budget diagnostics](https://github.com/CartmanFatass/codex-hud/blob/888643531ca1f9f9dc53761de59ce5f9b03d48b1/src/ledger/call-budget.ts)
- [Read control](https://github.com/CartmanFatass/codex-hud/blob/888643531ca1f9f9dc53761de59ce5f9b03d48b1/packages/hud-mcp/src/read-control.ts)
- [Independent lifecycle read](https://github.com/CartmanFatass/codex-hud/blob/888643531ca1f9f9dc53761de59ce5f9b03d48b1/src/ledger/delegation-read.ts)
- [Handshake implementation](https://github.com/CartmanFatass/codex-hud/blob/888643531ca1f9f9dc53761de59ce5f9b03d48b1/src/ledger/handshake.ts)
- [Heartbeat writer](https://github.com/CartmanFatass/codex-hud/blob/888643531ca1f9f9dc53761de59ce5f9b03d48b1/src/ledger/supervisor.ts)
- [Six-design disposition](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/p065-six-design-dispositions.md)

