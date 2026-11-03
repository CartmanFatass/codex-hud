# B10B-S3F-PERF implementation and validation report

Date: 2026-11-03. Status: measured candidate, not accepted or merged. The full planned candidate series has completed. It improves the observed compact-changed range, but one Node 24 compact-changed run remains over the unchanged gate. This report makes no exception or acceptance ruling. R1 is untouched and its tests pass; R2 remains for a fresh Oracle to assess; R3 remains the prior non-blocking documentation item. Full-check and merged-tree gates remain independently open.

## Source and publication identity

- Inspected base: bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60 on dots/b10b-s3f; tree f9bcdc5c069156d655ca7d3cd7a08590e74b8eec.
- Dedicated local branch: dots/b10b-s3f-perf.
- Exact measured candidate commit: 5f2134d0ccedeca4d4fe184699b3bdd2307a65f4; tree f3fff50d66c62effd9a169e8ccca73c6e21833cb.
- Commit title: Bound delegation whole-tree memo to the latest snapshot.
- Changed files only: src/render/delegation/projection.ts (11 insertions, 4 deletions) and new tests/unit/b10b-s3-perf-regression.test.ts (256 lines). No other implementation, benchmark, fixture, baseline, dependency, contract or script change is committed.
- Source SHA256: projection.ts eb44fbfb91983c8afb18a1e8ab970c81a9c039b55ae4db87d8ddbd5f97d0363d; regression test 651ad99457c744bc4d3b6e998a7ab7997fa07cef8a31f8c1aa446e9e3b540de5.
- The only remaining tracked worktree modification is npm-ci-generated node_modules/.package-lock.json. It was not staged or committed.
- The local commit is not yet published. The first Git push was denied for missing explicit publication authorization. After the dispatcher supplied the owner's exact repository/branch authorization, remote inspection showed no dots/b10b-s3f-perf branch. The one permitted retry failed before publication because the shell has no GitHub HTTPS credential. No credential workaround or further retry was attempted. The dispatcher will use the user-requested GitHub connector and record any different publication identity before independent verification. The measured local commit and full candidate.patch are preserved.

## Change and semantic boundaries

Only projectDelegation and its private Memo storage change. The whole-tree WeakMap becomes one last (tree, details, capacity, result) record. A consecutive call with the same three references still returns the stored whole projection when the VM envelope is the same. A different envelope sharing those references still receives the existing shallow wrapper with its exact incoming vm, without mutating the stored result. A different tree/details/capacity reference rebuilds and replaces the record. A custom ProjectionCache bypasses the shared whole-tree memo and neither consumes nor evicts it.

The change removes whole-tree memo entries for previous tuples from this cache's ownership. It does not reuse or retarget PNodes, topology, plans, destinations, descriptors or old frames across distinct snapshots. It does not alter complete fact comparison, per-node ProjectionCache hits/misses or disappeared-node sweep. Exported signatures and output semantics are unchanged. No runtime-specific branch, benchmark detection, I/O, worker, timer, heap tuning or relocation of measured work was added.

The source establishes a one-record ownership bound, not a global byte bound. The strong last record retains its latest VM/projection while idle. Callers may independently retain older snapshots; their number is not bounded by this memo. The existing four-plan-per-projection, eight-row-string-per-node-projection and 500-card bounds/evictions remain unchanged. No leak claim is made: a WeakMap value referring to its key does not itself prove permanent retention.

A fresh read-only design Oracle conditionally authorized this one-entry policy and specified its snapshot/identity boundaries, alternating-VM disclosure and regression coverage. A subsequent clarification explicitly authorized the unchanged prototype's six-run validation after reviewing the mixed profile. That clarification did not establish causality, justify automatic retention of the patch, waive gates or grant another fix round. No structural plan reuse or second memo slot was implemented.

## Regression evidence

The new file contains nine focused tests:

1. perf equivalence: rebuilt-equal views, one fact changed, and return to its previous value.
2. perf equivalence: an older compact or rich frame retains its text, destinations and exact descriptor.
3. perf equivalence: removed and reinserted nodes and a different root cannot contaminate a live snapshot.
4. perf equivalence: old views survive conflict, topology and bucket changes plus option and clock boundaries.
5. perf memo identity: consecutive hits, envelope-only wrappers, and all three tuple references.
6. perf memo policy: one live tuple is retained, A to B to A evicts without retargeting snapshots.
7. perf memo isolation: a custom projection cache neither hits nor replaces the shared tuple.
8. perf snapshots: unread lazy rows and equal render facts with a newer descriptor keep their own views.
9. perf cache churn: repeated keys under distinct roots sweep disappeared entries and preserve old trees.

The corrected baseline run passes 8/9 and fails only test 6's explicit new bounded-eviction policy assertion. The candidate passes 9/9. This is not a pre-existing output-bug claim or a speed proof. The other eight are equivalence/snapshot guards. An earlier draft used raw R rather than the fixture's normalized resume-reconcile key and caused two additional failures; that test-author error was corrected before candidate measurement, and both earlier and corrected logs remain preserved.

All 381 existing/additive B10B tests pass together. In particular, untouched b10b-cache.test.ts retains the complete facts/factsEqual/row-key tables, including translator input. b10b-s3-facts.test.ts retains the digit/underscore/dollar comparator guard. b10b-s3-selection.test.ts retains selectionMap, parent-aware put-away, collapsed-ancestor, stale-frame and fifth-sub-row tests. b10b-s3-rich.test.ts retains both “l enters a native sub-row's history/card child by parent identity, not screen adjacency” cases in compact and rich, and “rich: l on the fifth sub-row whose children are past the fifth does nothing”. The full suites also cover existing plan options, shown/history-hidden behavior, clocks, conflicts/overflow, width/style/translator changes and unchanged rendering. No assertion or visual baseline was weakened or updated.

## Evidence identities and reproducibility

The raw evidence archive contains every attempted strict run, all stdout/stderr, build logs, metadata, profile data and reproduction scripts, corrected and incorrect draft regression logs, and the complete candidate patch. SHA256SUMS inside it authenticates its members. series-summary.json is the all-population appendix: for every one of the 18 strict series runs it records every printed population's n, p50, p95, p99, max and exit. Raw logs retain original wording and order, including diagnostics and failures. The gate tables below summarize p99 only; they do not replace that appendix or pool samples.

Archive: b10b-s3f-perf-evidence-20261103.tar.gz; SHA256 f37c78a253d73a905329fedf97ec23a7e04b2977712906d9a433991681f4503a. Separate post-series host record: b10b-s3f-perf-host-extra.log. The dispatcher must confirm publication of these artifacts; their local preservation alone is not a claim that a repository download exists.

Host d14215e6cbaa, Linux 6.18.57 x86_64. CPU observed after the series through /proc/cpuinfo: AMD EPYC 9V74 80-Core Processor; getconf reported 9 online processors. lscpu in the original series metadata failed because the sandbox CPU sysfs path is unavailable; that failure is preserved rather than replaced. Node binaries were /workspace/scratch/6daef0397a95/hyg2-node22/node_modules/node/bin/node (v22.23.4) and /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node (v24.22.1). npm was 11.9.0 through the primary-runtime npm-cli.js.

Every series declared Node 22 runs 1,2,3 followed by Node 24 runs 1,2,3 before execution. Each family was rebuilt with its actual runtime, then each strict measurement was a fresh process with fresh temporary HOME and HUD_HOME. The command is the unchanged B10B_PERF=1 selected-node --test dist-test/tests/unit/b10b-s3-perf.test.js, wrapped with env -u NO_COLOR -u FORCE_COLOR -u NODE_USE_ENV_PROXY -u NODE_OPTIONS. Absolute binaries, actual temporary directories, UTC timestamps, load snapshots, source/tree/status and all outputs appear in run-series.sh and the individual logs. There were no heap/GC flags or instrumentation in strict runs.

Frozen benchmark source blob: 371b8f784229636f66e88434c422484dd85251eb. Compiled benchmark SHA256 throughout: 24a2437918e49b34339f5eb15c3c325e50bb9d1cf9b0faefada2139d74425022. Fixture blob manifests are recorded. The aggregate generated dist-test hash is 3385b1e7d1ee7b465c1eecfe47eb2b73eb216cf1015b7e800f9ebfc0b75e09cb for the installed baseline and 91f562344feb9be84fec8cce5b19f7ddc5c19b08e483a10c361231a6dc3e2bc7 for the final candidate, the same across both runtime builds for each source. All those builds passed.

The initial installation lacked prettier. After the initial baseline/profile attempts, npm ci --ignore-scripts completed as the repository requires; no package/lock version was edited. The whole baseline series was then repeated on the final dependency installation rather than silently comparing across installations. The matched comparison is baseline-installed against candidate-final. The dependency-file aggregate excluding generated node_modules/.package-lock.json is 3425410732bfb12b750feb3a86cb9ebe2bf03855caf7e1657cc723e3586d8beb; package-lock.json SHA256 is 98a7e2d3f5256810fe477812be64b35411aeede8b34f91e648d62e96c39e3294. Earlier evidence remains separately named baseline.

The dispatcher reserved the executor against other agent-controlled builds/tests/benchmarks. No such other workload was reported during the declared final series. Each exec command nevertheless has its own PID namespace, so its ps snapshot cannot observe other tool sessions. External host activity and scheduling were not controlled or continuously observed. Quiet snapshots are not proof of host-wide isolation. These limitations require Oracle assessment; no failure is attributed to contention without evidence. Measurement ended about 15:19:49 UTC; archive preparation ended afterward, and the reserved window was explicitly released at 15:21 UTC. These remote results are design evidence, not formal WSL qualification.

## Strict gate results

Each printed population uses n=1000 after 200 warm-ups with the frozen nearest-rank calculation, 200-node tree and width 56. Gates remain compact/rich no-change <=2 ms, compact changed <=10 ms, rich changed <=15 ms. In the following rows, values are CN / RN / CC / RC p99 milliseconds, followed by process exit.

Matched installed baseline, base bd7e77a:

- Node 22 run 1: 0.727 / 0.816 / 8.372 / 10.303; exit 0.
- Node 22 run 2: 0.736 / 0.579 / 8.160 / 7.363; exit 0.
- Node 22 run 3: 0.868 / 0.570 / 10.339 / 7.857; exit 1.
- Node 24 run 1: 0.559 / 0.740 / 12.125 / 13.331; exit 1.
- Node 24 run 2: 0.453 / 0.400 / 11.886 / 13.535; exit 1.
- Node 24 run 3: 0.397 / 0.384 / 13.273 / 12.416; exit 1.

Final candidate, exact commit 5f2134d:

- Node 22 run 1: 1.048 / 0.553 / 4.915 / 6.336; exit 0.
- Node 22 run 2: 0.995 / 0.794 / 9.717 / 6.464; exit 0.
- Node 22 run 3: 1.213 / 0.904 / 5.457 / 5.557; exit 0.
- Node 24 run 1: 0.493 / 0.443 / 10.579 / 12.540; exit 1.
- Node 24 run 2: 0.482 / 0.623 / 9.488 / 12.379; exit 0.
- Node 24 run 3: 0.683 / 0.375 / 9.900 / 12.893; exit 0.

Matched ranges, baseline to candidate:

- Node 22 CN: 0.727–0.868 to 0.995–1.213; RN: 0.570–0.816 to 0.553–0.904; CC: 8.160–10.339 to 4.915–9.717; RC: 7.363–10.303 to 5.557–6.464.
- Node 24 CN: 0.397–0.559 to 0.482–0.683; RN: 0.384–0.740 to 0.375–0.623; CC: 11.886–13.273 to 9.488–10.579; RC: 12.416–13.535 to 12.379–12.893.

No candidate run was discarded or replaced. Node 24 runs 2 and 3 were already predeclared, not retrospectively selected favorable reruns. The implementer does not decide whether the one over-limit result and following runs meet the existing narrow exception. The fresh Oracle must assess that and the mixed diagnosis; this is not a six-of-six pass claim.

Earlier pre-install baseline, retained separately:

- Node 22 run 1: 0.685 / 0.659 / 5.682 / 6.308; exit 0.
- Node 22 run 2: 1.082 / 0.782 / 7.026 / 6.844; exit 0.
- Node 22 run 3: 2.202 / unmeasured / 8.530 / 10.064; exit 1. The compact no-change assertion prevented the rich no-change population from being measured in that test; it is not a pass.
- Node 24 run 1: 0.485 / 0.439 / 12.343 / 12.120; exit 1.
- Node 24 run 2: 0.520 / 0.404 / 13.431 / 13.456; exit 1.
- Node 24 run 3: 0.484 / 1.259 / 13.012 / 12.155; exit 1.

A separately declared exploratory Node 24 prototype run passed at 0.732 / 0.582 / 9.561 / 12.699, exit 0. It is not counted in the final three. A short Python profile-summary operation overlapped its later unasserted/cold portion after the four gated outputs had already printed; this possible interference is disclosed, and the exploratory run is not substituted for the final series. Prior B10B-S3F reports and failures on the base branch remain intact.

## Profile and retention evidence

Profiling was separate from strict acceptance. run-profile-v2.sh uses a diagnostic copy of the compiled benchmark, inspector CPU and sampled-allocation profiling, PerformanceObserver GC entries, sample timestamps and periodic heap-space/memory readings outside timed sample bodies. The original benchmark source and compiled strict file remain unchanged. All-workload profiles include clone preparation, cold and unasserted paths; their allocation totals are not gated-population-only totals. Instrumentation changes allocation/scheduling. No forced GC or heap flags were used. The initial profile failed to drain GC callbacks and produced an empty GC list; it is preserved as a failed GC diagnostic, not evidence of no GC. The corrected v2 preload waits 100 ms before exporting callbacks.

The matched installed baseline and candidate prototype show substantial projection/facts/plan allocation. Estimated sampled allocation attributed to buildProjection_ including descendants is 3.913 GB baseline and 3.904 GB candidate; nodeFacts is 2.166 GB and 2.176 GB; planRows is 0.586 GB and 0.587 GB. These are sampled cumulative workload estimates, not retained bytes. The one-entry change does not eliminate fresh projection or plan construction, and these data do not show a material total-allocation reduction.

The paired instrumented changed populations are:

- Compact baseline p50/p95/p99/max: 1.616 / 2.699 / 13.130 / 16.808 ms; candidate: 1.779 / 3.181 / 11.574 / 15.833 ms.
- Rich baseline: 1.848 / 3.292 / 14.332 / 70.869 ms; candidate: 2.313 / 4.712 / 14.934 / 24.929 ms.
- Compact slowest-ten sample/GC overlap: 126.166 of 148.241 ms (85.11%, 10/10 overlapping samples) baseline; 100.161 of 127.791 ms (78.38%, 10/10) candidate.
- Rich slowest-ten overlap: 118.076 of 213.577 ms (55.28%, 9/10) baseline; 155.944 of 188.971 ms (82.52%, 10/10) candidate.
- Whole diagnostic GC entries/total duration: 1232 / 7329.217 ms baseline; 1200 / 6919.485 ms candidate.

Natural sampled old-space peaks during compact changed were 108,023,328 bytes baseline and 137,705,344 candidate; rich peaks were 130,963,000 and 132,893,552. These samples do not show lower retained bytes. Inputs intentionally kept live and caller-held results legitimately retain graphs; transient fresh-clone graphs may await collection; the candidate itself strongly owns its latest tuple. No heap-root proof of an ephemeron-specific delay, permanent leak, universal GC-tail improvement or byte-retention reduction is claimed. The observed compact-tail signal justified the approved experiment, but the mixed profile and causal limits remain for review.

## Alternating-live-VM tradeoff

The frozen S2 labels “compact no-change + one cached row (two memoised view models alternated; not asserted)” and “rich no-change + one cached card (two memoised view models alternated; not asserted)” are unchanged. Under the candidate, distinct alternating tuples miss the one-entry memo and reproject. They are not two whole-tree hits or the actual genuine unchanged-VM acceptance gate.

Same standalone unmodified S2 command, Node 24, n=1000, p50/p95/p99/max milliseconds:

- Compact baseline 0.389 / 0.715 / 2.163 / 4.789; candidate 1.078 / 2.043 / 3.267 / 10.370.
- Rich baseline 0.337 / 0.641 / 1.285 / 5.559; candidate 1.137 / 2.031 / 5.674 / 9.009.

Both standalone suites exited 0. The earlier candidate all-B10B execution also printed compact 1.088 / 2.225 / 4.469 / 7.816 and rich 1.123 / 2.131 / 6.140 / 23.487, preserved in candidate-b10b.log. These slowdowns are disclosed rather than hidden or compensated with a second slot. No real-caller alternating-tree regression was established by this synthetic diagnostic; if such evidence requires a different cache policy, the design ruling requires another consultation rather than silent scope expansion.

## Check results and remaining gates

The following ran serially on the final source bytes before the freeze commit, with temporary HOME/HUD_HOME and raw logs. Committing did not change those bytes. The final strict series subsequently rebuilt the exact commit for each runtime.

- npm run build: exit 0.
- npm run build:test: exit 0.
- npm run build:hud-mcp: exit 0.
- node --test --test-concurrency=1 dist-test/tests/unit/b10b*.test.js: 381 tests, 381 pass, 0 fail/cancel/skip; exit 0.
- npm run test:core: 210 tests, 209 pass, 0 fail, 1 existing skip; exit 0.
- npm run test:visual: 331 tests, 331 pass, 0 fail/skip; exit 0; baselines unchanged.
- npm run test:hud-mcp: 84 tests, 83 pass, 0 fail, 1 existing skip; exit 0.
- npm run format:check: all matched files use Prettier code style; exit 0.
- npm run check:fixtures: OK; exit 0.
- git diff --check: exit 0.
- npm test and the separate test:mjs diagnostic stage were not run in this remediation worktree. The cloud executor's already-established socket/ptrace/process-topology access restrictions were not retried or bypassed. This is not a green full check set. The owner-authorized capable-executor workstream must supply actual results on the published candidate; if npm test short-circuits, test:mjs still needs its separate recorded run.

No local-only real-harness, real tmux, Herdr, install/uninstall or real user configuration work was performed. No existing evidence was overwritten or removed. No unrelated source fix was attempted.

Remaining actions belong to the dispatcher/fresh Oracle: publish with exact identity recorded; independently verify the report, run the full capable-executor check set and serialized candidate series; assess the single remaining over-limit result, memo tradeoff and diagnosis; carry forward R1/R2/R3 explicitly; and apply the unchanged final review and merged-tree gates. No additional remedy, gate change or automatic fix round is started by this report.