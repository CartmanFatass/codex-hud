# B10B-S3F-NEXT implementation report

Date: 2026-11-03. One bounded submission of the selected scratch-record mechanism. This report does not grant acceptance or merge. No alternative optimization or further remediation round was attempted.

## Identity and ownership

Base: e5ccee38165b30809bd537e7f31cfed7f227f152, tree 6783e8a04969886d02223966413299fede6a6f09. Frozen local candidate: 3f2af837b681419cb3461006390c71d2fa9a856f, tree 4b66dca450ad717455321e2b103dc9b5d190716c, branch dots/b10b-s3f-next. Worktree: /workspace/shared/b10b-s3f-next. This exact source/test commit received the candidate strict series; the only unstaged tracked difference is generated node_modules/.package-lock.json from unchanged-lock installation, never staged. Publication may change the commit ID and must establish exact source-tree equivalence before calling it the tested candidate.

Changes are confined to four owned files:

- src/render/delegation/facts.ts: private typed newNodeFacts initializer; nodeFacts gets an optional final buffer argument and one authoritative complete assignment path.
- src/render/delegation/projection.ts: buildProjection_ local scratch lifecycle, seven-line diff. No public cache/API change.
- tests/unit/b10b-s3-facts.test.ts: two additive materialization guards, with a baseline-compatible callable type.
- tests/unit/b10b-s3-perf-regression.test.ts: two additive lifetime/cache guards.

No old assertions were removed or weakened. No benchmark, fixture, package/lock, row/plan/card/selection/monitor, core, ledger, collector, contract or design-document change. The one-entry whole-tree memo is untouched. Four-file patch and exact file blobs are supplied in candidate.patch and candidate-source-identity.txt.

The complete NEXT brief was restored and read back before implementation. Its verified blob is 14137fc8ab1c2c527748f592c401c44c04e7eb2c. The fresh diagnostic-v3 / typed initializer ruling was recorded before execution at docs/cloud/rulings/b10b-diagnostic-v3.md, blob 3bab2782e39bb2e63db050a28704c926e11e30d5. The initial malformed NEXT publication, missing archived v2 instrumentation and initializer ambiguity were raised to the dispatcher; implementation waited for the repaired brief and scoped design ruling.

## Mechanism and lifetime proof

newNodeFacts returns an ordinary fresh typed literal with exactly the original 66 own enumerable keys, in their original order, using inert primitive defaults. It is private and is called only when nodeFacts has no opt-in buffer. Every successful extraction assigns every field unconditionally before return. There is no full temporary literal or Object.assign source on refill, shared template, class, global pool, additional cache, or borrowed retained facts.

The sole API change is nodeFacts(..., conflictName, buffer?: NodeFacts). Existing default callers still receive independent complete records. The caller must exclusively own an opt-in buffer. The unchanged extraction locals and all 66 value expressions remain authoritative; initializer key names are schema repetition, not duplicate extraction logic. The static audit matches all original expressions after whitespace/shorthand normalization and verifies NodeFacts schema, shortRefOf, metric, factsEqual, comparatorFor and FACT_NAME byte-identical.

Within one buildProjection_ pass, scratch begins undefined. A reference shortcut adds no extraction or allocation. A full comparison uses scratch or allocates a complete record. An equal hit retains the old entry.facts and NodeProjection untouched and keeps the unretained comparison record as scratch. A miss builds the new NodeProjection, stores that record in its new entry, and immediately clears scratch. No subsequent refill can mutate a retained entry. The local reference expires at return. Thus a fully compared equal pass needs at most one disposable full record; with M misses there are M transferred retained records plus at most one temporary record. These are algorithmic ownership bounds, not sampled-byte counts.

All topology PNodes, relations, children, plans, frames, lazy rows, selection descriptors and old snapshots retain their previous ownership. Cache counters, disappeared-node sweep, custom-cache behavior and one-entry memo tuple remain unchanged. Cold/all-miss work still allocates each retained record and now performs inert-default writes before extraction; no cold-cost benefit is assumed. No V8 dictionary-storage or literal-speed claim is made.

## Correctness and failed attempts

The corrected meaningful baseline run compiled the additive tests against the original five-argument implementation and ran all 16 focused tests: 15 passed and only the opt-in record-identity policy guard failed. It is a newly selected reuse policy, not a pre-existing output defect or a compiler/missing-symbol negative. Candidate focused run: 16/16 passed.

New coverage:

1. Default calls return independent complete ordinary records.
2. Opt-in refill returns the intended buffer and writes every field once in constructor order. A Proxy tracks all writes; every field is poisoned before incompatible-shape transitions, so skipped null/false writes cannot hide behind fresh-vs-refill equality. Explicit absent/false assertions complement the existing independent b10b-cache field/value table and baseline-expression audit.
3. Frozen cache facts survive equal/miss/equal passes, later changes and reverts. Distinct entries do not alias scratch; expected counters and warm-vs-fresh outputs hold.
4. All-cold/all-miss records remain distinct through removal/reinsertion; old facts and snapshots are unchanged.

Existing retained guards cover rebuilt-equal output, compact/rich old-frame text/destinations/exact descriptors, removed/reinserted keys under different roots, conflict/topology/bucket/option/clock transitions, tuple/envelope/custom-cache/A-to-B-to-A memo behavior, unread lazy rows and newer descriptor snapshots. Unchanged B10B coverage also exercises every fact/comparator/row-key table, digit/underscore/dollar identifiers, R1 direct-child compact/rich cases and the fifth-sub-row cutoff.

Preserved preparation errors: a draft test assigned null to numeric conflict.since and failed compilation, corrected to 0 before freeze; the first baseline guard process accidentally overlapped final compile seconds and ran only the previous 12 tests, so its pass is invalid for new-guard evidence; the properly serialized corrected run above supplies the negative. No strict process overlapped another build/test/benchmark. An initial static-audit regex missed a Prettier line wrap; the corrected audit checks all 66 expressions without source change. All original logs and explanations remain in validation-attempt-note.txt.

## Strict experiment

Host 097d2cc36dae, Linux 6.18.57 x86_64, Intel Xeon Platinum 8573C. Node v22.23.4 at /workspace/shared/b10b-next-runtime22/package/bin/node; Node v24.22.1 at /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node. npm 11.9.0 CLI is pinned in the wrapper. Node 22 was restored from the official npm node-linux-x64 package with installation log retained. Missing Prettier prompted npm ci --ignore-scripts against unchanged package-lock; both trees use identical installed dependency bytes, aggregate 3425410732bfb12b750feb3a86cb9ebe2bf03855caf7e1657cc723e3586d8beb (excluding generated .package-lock.json). That generated file is itself identical in both trees and remains unstaged.

Baseline declared 16:56:23 UTC, completed 17:09:29. Candidate declared 17:13:47, completed 17:26:03. Each phase freshly built all three targets per runtime, then Node 22 runs 1/2/3 followed by Node 24 runs 1/2/3. Each process used fresh explicit HOME/HUD_HOME and the logged expanded timeout wrapper clearing NO_COLOR, FORCE_COLOR, NODE_USE_ENV_PROXY and NODE_OPTIONS, with exact runtime first on PATH. No retries, trimming, pooling, best-run substitution, forced GC or heap tuning. Logs retain load/process-name observations every ten seconds. Agent-controlled work was serialized by reservation; external scheduling and separate PID namespaces prevent a continuous host-isolation claim or an attribution of failures to contention.

Frozen benchmark source blob 371b8f784229636f66e88434c422484dd85251eb, fixture a711705346161d155324c86564ab819e546d3fae, compiled strict benchmark SHA256 24a2437918e49b34339f5eb15c3c325e50bb9d1cf9b0faefada2139d74425022 are unchanged in every series manifest. All 1,000 measured samples after 200 warm-ups, extra preconditioning, nearest-rank statistics, 200 nodes/56 columns, clocks, alternating selection, fresh-clone preparation, row reads and viewport rules remain unchanged.

Per-process p99 ms in CN/RN/CC/RC order, unchanged limits 2/2/10/15:

- Baseline Node 22 run1: 3.578 / unmeasured / 19.329 / 11.178, exit1.
- Baseline Node 22 run2: 1.641 / 0.620 / 8.468 / 13.125, exit0.
- Baseline Node 22 run3: 4.468 / unmeasured / 7.891 / 9.702, exit1.
- Baseline Node 24 run1: 1.121 / 2.024 / 13.356 / 29.737, exit1.
- Baseline Node 24 run2: 2.097 / unmeasured / 17.426 / 15.673, exit1.
- Baseline Node 24 run3: 0.816 / 1.397 / 16.333 / 19.084, exit1.
- Candidate Node 22 run1: 0.817 / 1.180 / 8.895 / 13.151, exit0.
- Candidate Node 22 run2: 1.630 / 1.923 / 9.776 / 10.407, exit0.
- Candidate Node 22 run3: 0.927 / 1.153 / 9.375 / 14.119, exit0.
- Candidate Node 24 run1: 1.167 / 1.306 / 16.600 / 14.899, exit1.
- Candidate Node 24 run2: 1.641 / 1.467 / 14.726 / 20.701, exit1.
- Candidate Node 24 run3: 1.138 / 1.413 / 30.930 / 15.546, exit1.

An unmeasured RN follows the existing CN assertion failure and is not a pass. All candidate populations were reached. strict-series-summary.json retains every printed population's n/p50/p95/p99/max and per-gate status; raw logs retain chronology and assertions. Candidate Node 22 passes do not close R2: repeated Node 24 compact and rich failures remain. No permitted isolated single-overrun rule resolves this repeated pattern.

## Historical and owner evidence boundaries

All prior B10B-S3F/PERF failures, pre-install failures, exploratory run, mixed profiles and empty-GC collection failure remain unchanged in the inherited branch and governing brief. The original PERF archive and exact profile-v2.mjs/instrument.py/run-profile-v2.sh bytes were lost with executor replacement and confirmed irrecoverable by the dispatcher/courier; hashes and published text survive. Archived v2 method unavailable. New scripts do not claim those identities or recreate their bytes. Historical V2 (missing independent dispatcher rebuild/digest/wrapper) cannot be repaired retrospectively by NEXT.

Owner local REPORT blob 26c5dee833483d623766f7d751a46b2d670971e6 tests prior PERF 9496910, not NEXT. Its summary says series A 12/12, but detailed sections 7.1/7.3 preserve a Node 22 baseline compact-changed 14.319 failure: A 11/12 overall, all six candidate processes pass. B 12/12; all prior-PERF candidate processes across both series pass. The report separately retains proxy-related Node 22 failures, RUNZ1 failure and full-gate red from hud-mcp root-owned WSL Relay /proc environ EACCES. It reports imperfect isolation. These are useful independent old-target observations, not new-NEXT checks, formal supported-profile qualification, proof cloud failures are invalid, or acceptance. No assistant local testing was performed.


## Diagnostic-v3 pair

Authorized v3 substitute completed as a matched collection and analysis pair. Archived v2 method unavailable. This is the scoped substitution authorized by the fresh ruling, not original-method execution or hash/method equivalence. The full raw evidence is locally retained; durable archive verification is a separate publication obligation, not yet satisfied by a local path.

Before either arm, complete instrument-v3.py, profile-v3.mjs, run-profile-v3.sh, analyze-v3.py and the shared expanded wrapper were archived locally with the recorded ruling. The method archive SHA256 is 0ab02107796776dc4aefcfba66f0fd1472c7b475b12724ddf2162a908ae32493. Four method code hashes remain unchanged before/after both arms, as recorded in v3-instrumentation-frozen-sha256.txt. A fresh build of the exact e5ccee3 baseline preceded the first process (17:26:37–17:28:51 UTC); a fresh build of exact 3f2af837 preceded the second (17:29:53–17:31:38 UTC; exact log headers govern). Same host, Node v24.22.1/npm 11.9.0, installed dependencies and settings. Each had a fresh HOME/HUD_HOME and 300-second timeout. Both processes exited1 on actual benchmark assertions; neither timed out, omitted a population, changed settings, or was retried.

Both compiled strict benchmarks retain SHA256 24a2437918e49b34339f5eb15c3c325e50bb9d1cf9b0faefada2139d74425022 before and after. Both separately transformed diagnostic copies are byte-identical, SHA256 3698c230e252756a5729a794477dac3ba0c5489a83523e7c073edfce3e6277a3. No path-only content difference is needed; import resolution selects the respective freshly compiled production modules in each worktree. Full transform differences and target/build/dependency manifests are preserved.

The in-process inspector, without remote listener, accepted allocation sampling interval 32768 with both collected-by-major/minor flags true, CPU interval 1000µs, enable/start/stop calls. No protocol errors. GC observation started before workload; one-shot delayed drain completed at 157.119ms baseline and 172.591ms candidate with remaining takeRecords consumed before disconnect. There were 1201/1188 GC entries. No forced GC, snapshots, allocation storms, new inter-sample yields, retention of VMs/nodes/plans/callbacks, or instrumentation of production source. Diagnostic metadata stores primitive labels, sample timestamps and boundary memory observations; heap profiles are inspector sampling results, not heap snapshots.

All 16 stable populations in each arm contain exactly indices 0–999 and n 1000. Warm-up boundaries, unsorted start/end/duration, memory at boundaries and every 50 measured samples, setup/finalization records, stdout/stderr and exits are preserved. The original prepare/measured boundary and assertions remain intact. Every population has n/p50/p95/p99/max in the two machine-readable summaries.

Source attribution: baseline facts.ts nodeFacts begins line 135 and constructs the full literal at 150. Candidate private newNodeFacts begins 132, returns its typed literal at 133, and nodeFacts begins 209, conditionally allocates at 225, then fills all fields through the authoritative assignments. Compiled profile locations are separately listed in allocationFrameLocations. The analyzer sums each heap node selfSize once per scope; inclusive nodeFacts/buildProjection_/planRows totals overlap and must not be added. newNodeFacts is reported explicitly and remains inside nodeFacts inclusive totals. Function-level samples cannot cleanly isolate only full-record bytes: short-reference and other value-producing allocations remain, and inlining/sampling/unassigned stacks limit attribution.

Matched v3 allocation observations (sampled bytes, baseline→candidate):

- Whole workload inclusive buildProjection_:7,123,657,344→6,243,227,624; inclusive nodeFacts:2,177,039,864→1,321,970,456; inclusive planRows:582,394,224→580,169,840. These include cold/miss/whole-monitor and unasserted work.
- Compact changed rows-only combined scope: inclusive facts 540,763,000 →263,978,992; direct nodeFacts 341,531,592→65,904,064, plus direct helper 0 →65,888; projection 1,526,678,808→1,245,516,592; plans 145,531,584→146,330,088.
- Rich changed rows-only combined scope: inclusive facts 539,736,200 →268,570,680; direct nodeFacts 343,958,704→68,887,984; no separate newNodeFacts frame was sampled here, not proof of zero helper allocation; projection 1,512,509,440 →1,244,684,392; plans 141,351,512→146,460,032.

Changed rows-only scope requires the compact/rich test callback, changedTicks and rowsPanel callback source location in the diagnostic filename. This separates clone preparation and whole-renderMonitor stacks where represented. It combines warm-ups, asserted every-row and unasserted 60-row calls; allocation sample ordinals are not timestamps, so no per-timed-sample or gated-only bytes are claimed. No historical v2 totals enter these denominators or comparisons.

CPU sampled interval observations in that same combined stack scope: compact 5,658,841→4,743,142µs, with inclusive facts 908,644→736,143µs; rich 8,127,788→5,046,357µs, facts 1,175,219→695,783µs. They are scoped sampled observations, not exact CPU cost or universal improvement. Inspector start/stop clock brackets have a nonempty intersection in both arms, but offset uncertainty is 11,855/12,957µs, large relative to individual fast samples. The summary retains approximate point-to-population assignments for audit; this report does not use them for exact per-population CPU conclusions. Stack scope is the basis for the reported CPU observations.

GC performance-entry times are converted to hrtime using bracket observations; worst observed conversion uncertainty 0.146/0.199ms is disclosed. Overlapping GC intervals are merged before overlap summation. For the slowest ten measured samples of each changed every-row population, sorted by duration with original-order ties:

- Compact baseline: 142.904ms overlap /221.356ms total sample duration=64.56%,8/10 samples overlap. Candidate 123.326/211.919=58.19%,8/10.
- Rich baseline: 99.551/576.371=17.27%,5/10. Candidate 173.992/208.552=83.43%,10/10.

These are temporal correlations, not causal decomposition or CPU time, and are never subtracted from strict durations. Instrumented changed p99 compact 14.536→15.143ms and rich 21.866→17.231ms are mixed diagnostic observations, not gate results.

Boundary/every 50-sample memory levels also remain mixed. Compact asserted population sampled old-space maximum 151,476,888→155,993,424 bytes and RSS 409,083,904→404,172,800; rich 150,742,152→118,508,544 and RSS 460,066,816→463,810,560. These are sampled maxima, not exact peaks, retained-byte bounds, heap reachability or leak evidence. Workload-end and drain/export periods are distinct in metadata.

The source/lifetime proof, complete-field/snapshot guards and matched observations support reduced disposable-record materialization pressure. They do not prove exact allocation counts, reliable strict-tail compliance, a general CPU/GC improvement or a leak. R2 remains open because the uninstrumented Node 24 series repeatedly fails.

Strict per-run p99 ranges (not pooled): baseline Node 22 CN 1.641–4.468, RN 0.620 with two missing populations, CC 7.891–19.329, RC 9.702–13.125; baseline Node 24 CN 0.816–2.097, RN 1.397–2.024 with one missing population, CC 13.356–17.426, RC 15.673–29.737. Candidate Node 22 CN 0.817–1.630, RN 1.153–1.923, CC 8.895–9.776, RC 10.407–14.119. Candidate Node 24 CN 1.138–1.641, RN 1.306–1.467, CC 14.726–30.930, RC 14.899–20.701.

## Exact-candidate complete check record

All commands used the logged expanded fresh HOME/HUD_HOME wrapper, Node v24.22.1/npm 11.9.0, with individual exits retained and no failed-command short circuit. Source/test identity remained frozen. Builds (build, build:test, build:hud-mcp) passed in every declared phase and final check run.

- Focused facts/perf-regression: 16 pass, 0 fail.
- All B10B, normal invocation with test-concurrency=1: 385 pass, 0 fail, 0 skip, exit 0. This includes the unchanged normal-mode performance diagnostics and complete R1/cache/selection/snapshot coverage; it is not a replacement for strict series.
- npm test: explicitly BLOCKED, not invoked, because previously denied socket/ptrace operations and unavailable process discovery would recur under insufficient authority. No bypass or retry. V1 is not green.
- Separate npm run test:mjs: 47 tests, 32 pass, 15 fail, 0 skip, exit 1. The failing herdr-bridge fake Unix-socket cases receive explicit listen EPERM. Their logs are now present rather than the historical missing mjs stage. No denial rerun or permission change.
- npm run test:core: 210 tests, 208 pass, 1 fail, 1 skip, exit 1. The failure is ledger-processes.test.ts, 'concurrent same key with different parameters rejects the losing request': the final expected intent.rejected audit-event count is 0 instead of 1 (compiled line 154). Acceptance/idempotency checks before it passed. This is outside NEXT ownership; its baseline behavior was not newly established, no cause is asserted, no fix or speculative known-flake retry was made.
- npm run test:visual: 331/331 pass, exit 0, no baseline edits.
- npm run test:hud-mcp: 84 tests, 77 pass, 6 fail, 1 skip, exit 1. Six failures explicitly involve ledger_busy: two b20-advice cases, B45 accepted-spawn atomic replay, and three G03 expected-run cases. Existing known ledger_busy-family allowance was applied once per affected file, serially, with fresh HOME/HUD_HOME and both logs retained: b20-advice 9/9 pass; delegation 7/8 pass with accepted-spawn ledger_busy still failing; resume-expected-run 6/7 pass with old-request-key replay ledger_busy still failing. No further rerun. hud-mcp remains red.
- npm run format:check, npm run check:fixtures and git diff --check: exit 0.

No assistant-local machine access, install/uninstall, real harness, Herdr integration, tmux, or live owner home/configuration probing was performed. The mjs tests used only their authorized synthetic fake fixtures and remained denied where the executor prohibited sockets.

## Disposition and remaining gates

Return this one submission and all evidence for fresh final Oracle review; do not accept, merge or advance dependents. R1's implementation is untouched and its relevant B10B guards pass. R2 remains open with repeated uninstrumented Node 24 changed-path failures despite Node 22 passes and supported allocation-mechanism evidence. V1 remains open: npm test is blocked and actual mjs/core/hud-mcp checks are red. Historical V2 remains the old dispatcher's missing independent rebuild/digest/wrapper limitation. R3 is unchanged and outside ownership. Old/new snapshots and scratch lifetime are covered as described; sampled profiles do not prove a leak or retained-byte limit.

The dispatcher still owes an independent exact submitted-tree rebuild, generated-artifact digests and separately declared three strict processes per runtime; this implementation report cannot supply that independent evidence. Owner old-PERF WSL results do not fill new-source checks. Any new local need should target the exact published NEXT identity, with npm test including mjs and the README full checks, while preserving failures. No assistant-local execution is authorized here. Formal supported-WSL qualification and final merged-tree full green checks remain separate.

No further production correction, alternate mechanism, new diagnostic pair, result-shopping strict retry, gate waiver, runtime removal, queue change or merge is released. A fresh Oracle must decide the remaining findings under the bounded-release rules.

## Artifact and publication boundary

Complete source files, candidate.patch, exact identity, preparation-error logs, original baseline/candidate strict logs and manifests, complete check logs, all v3 raw CPU/heap/GC/sample/memory/metadata files, full frozen instrumentation/transform/analysis code, summaries, governing rulings and owner-evidence context are retained in the distinct NEXT evidence directory. SHA256SUMS and an evidence manifest enumerate them. A separate b10b-s3f-next-evidence-20261103.tar.gz and external digest are supplied to the dispatcher. This report does not call a transient executor path durable.

Repository metadata checked through the GitHub connector on 2026-11-03 confirms CartmanFatass/codex-hud is public. No GitHub write was performed by this implementer. Public text publication must remain limited to authorized project artifacts and synthetic cloud evidence after privacy review; the complete archive must be placed at a verified durable authorized destination and retrieved with matching digests before it is described as archived. The owner report copied here was already public and does not expose private owner paths. Parent dispatcher owns publication, unchanged-tree accounting, durable retrieval verification and the final review handoff. No main push, force push or node_modules staging occurred.
