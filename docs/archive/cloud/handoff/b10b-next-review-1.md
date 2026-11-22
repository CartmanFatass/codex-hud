# B10B-S3F-NEXT final Oracle review

Date: 2026-11-03. Fresh independent final review. Suggested record: docs/cloud/handoff/b10b-s3f-next-review-1.md.

**Verdict: fix required.** The selected scratch-record mechanism is within scope, preserves complete fact extraction and snapshot ownership, and has supporting matched allocation evidence. It does not close R2. The implementer's Node 24 strict series fails all three processes; the separately recorded dispatcher series also fails on Node 24 and on corrected Node 22. V1 remains open because the full exact-candidate check set is blocked/red. The new dispatcher verification has its own provenance omissions, distinct from historical V2. Complete evidence is locally intact but has no verified durable retrieval. No new must-fix production correctness defect was found in this four-file submission.

This review grants no acceptance, merge, gate waiver, dependent-wave release, alternative optimization or automatic further fix round.

## Reviewed identities and method

- Frozen base: e5ccee38165b30809bd537e7f31cfed7f227f152, tree 6783e8a04969886d02223966413299fede6a6f09.
- Measured local candidate: 3f2af837b681419cb3461006390c71d2fa9a856f, tree 4b66dca450ad717455321e2b103dc9b5d190716c.
- Connector-published code commit: 0cca9caa6ddf3249291c8ed85a41da1eed800ee4. I independently fetched its Git commit object: its complete tree is exactly 4b66dca450ad717455321e2b103dc9b5d190716c. This is full-tree equivalence, not merely four matching blobs. GitHub comparison establishes e5ccee3 as its ancestor/merge base and exactly the four owned changed files.
- Reviewed remote evidence head: 9a899b867e93de98c00bffae6a137ce6f3dbc708, tree 10f06898ae2666c474e6624d2c96484c5114ac46. The three commits after 0cca9ca add only b10b-s3f-next-implementation.md, b10b-next-dispatcher-initial.log and b10b-next-dispatcher-node22-corrected.log under docs/cloud/handoff/. Its implementation is unchanged; its evidence-bearing full tree is not the earlier measured full tree.
- The local worktree's only pre-existing unstaged tracked change is node_modules/.package-lock.json. It was left untouched and is not part of the candidate.

Read AGENTS.md, dots/README workflow, current STATE, NEXT brief, next-route and diagnostic-v3 rulings, relevant architecture/design/contract sections, prior PERF review and applicable memo/validation rulings, exact source/test diff, implementation report, both dispatcher logs, owner prior-PERF report and retained raw evidence. This review used read-only source/metadata inspection, hashing and independent arithmetic over existing records. It ran no build, test, benchmark or profile, made no repository/file mutation, started no subagent and did not use the owner's computer. The executor reservation for NODE22-PROXY was respected.

## Findings requiring resolution

### R2 — not fixed; P2 acceptance blocker

`tests/unit/b10b-s3-perf.test.ts:194,206,217`; `docs/cloud/handoff/b10b-s3f-next-implementation.md:59–74,112`; dispatcher logs — **the unchanged four strict gates are not met**. Failure scenario: the prescribed fresh-clone, moving-clock, real-selection changed workload repeatedly exceeds compact 10 ms and rich 15 ms p99; the corrected dispatcher Node 22 series also exceeds rich no-change 2 ms. The implementer Node 24 compact values are 16.600/14.726/30.930 ms, with rich failures 20.701/15.546 ms. Corrected dispatcher Node 22 compact failures are 48.571/118.364 ms and rich no-change is 2.778 ms. Dispatcher Node 24 compact fails 16.866/12.154/16.069 ms and rich fails 16.699/20.010 ms. **Severity P2.** Required resolution: preserve every result and obtain a new bounded Oracle disposition for the unresolved strict requirement. Any further authorized experiment must retain exact-target provenance and the existing rules; do not rerun until a favorable subset appears or infer a new implementation allowance from this verdict.

The existing single compact-overrun/isolated-rerun exception cannot cover repeated compact failures, rich failures and a no-change failure. Node 22 implementer passes, reduced allocation, owner passes on a different source, or a favorable diagnostic cannot erase these failures. No supplied evidence establishes host contention, stale output, GC or the proxy setting as their cause.

### V1 — not fixed; P2 complete-check blocker

`docs/cloud/handoff/b10b-s3f-next-implementation.md:114–125`; retained checks logs — **the exact NEXT candidate has no complete green README check set**. npm test was explicitly blocked and not invoked. Separate mjs is 32/47, core is 208 pass/1 fail/1 skip, and hud-mcp is 77 pass/6 fail/1 skip; two hud-mcp files still fail their single permitted isolated rerun. Failure scenario: accepting focused rendering passes would leave required integration/process behavior unverified or failing. **Severity P2.** Required resolution: actual complete exact-target execution on an already-authorized capable executor, with all failures retained and scoped diagnosis under the owning workstreams. A blocked stage is not a pass. Do not bypass socket/ptrace restrictions or restart assistant-run local sessions. The owner's earlier PERF report cannot supply NEXT verification.

The core failure is `tests/unit/ledger-processes.test.ts:184`: expected one intent.rejected audit event, observed zero after the preceding acceptance/idempotency assertions passed. This source is outside NEXT ownership; its baseline behavior and cause were not newly established. It is not an authorized additional flake category. The six initial hud-mcp failures involve ledger_busy, including the assertion that received Ledger busy instead of idempotency_conflict. The allowed one-file reruns do not turn persistent failures green.

### NEXT-E1 — independent verification is incomplete; P2 evidence gap

`docs/cloud/handoff/b10b-next-dispatcher-initial.log:9–15,197–220`; `docs/cloud/handoff/b10b-next-dispatcher-node22-corrected.log:1–28` — **the current dispatcher evidence does not satisfy NEXT §§8–9's independent rebuild/artifact/isolation record**. Initial Node 22 build and build:test both exit 127 because npm is not found; the subsequent strict processes therefore are not an independently rebuilt Node 22 series. Corrected Node 22 separately records both builds passing; initial Node 24 also records both passing. However, neither published series includes the generated production-output/dependency manifest, build:hud-mcp or its result, expanded fresh per-process HOME/HUD_HOME wrappers, actual temporary paths or the prescribed outer timeout. Hashing only the unchanged benchmark JS does not identify the production JS imported by that benchmark. **Severity P2 when offered as complete independent acceptance evidence.**

The dispatcher supplied its actual original command text during this review. Initial verification used `PATH="$dir:/usr/local/bin:/usr/bin:/bin"`, a temporary HOME from `/workspace/shared/hud-home.XXXXXX`, TMPDIR=/workspace/shared, and unset HUD_HOME, NO_COLOR, FORCE_COLOR, NODE_USE_ENV_PROXY and NODE_OPTIONS. It then ran npm build, npm build:test, benchmark SHA256 and three strict processes per runtime. Corrected Node 22 put the explicit Node 22 directory and the Node 24/npm directory first on PATH, again used one outer temporary HOME/TMPDIR and the same unsets, then both builds, benchmark SHA256 and three strict processes. The dispatcher confirmed no fresh HOME per strict run, no explicit fresh HUD_HOME pair, no build:hud-mcp, no source/dependency manifests and no outer timeout were recorded. Expanded temporary paths were not supplied. This clarification should accompany the logs; it must not be rewritten as contemporaneous compliant evidence.

Required resolution: keep the failed-build Node 22 attempt and corrected series separate, archive this factual limitation, and make any subsequently authorized independent verification follow the already-required exact rebuild/digest/fresh-process protocol. The corrected series is a distinct verification attempt, not retroactive repair of the initial one. No further benchmark retry is released here. Even granting intended-candidate attribution to every dispatcher process would leave R2 failed.

Historical V2, from PERF's earlier missing independent rebuild/digest/wrapper, remains an historical limitation. NEXT-E1 is an additional current evidence issue, not a reclassification or erasure of V2.

### NEXT-E2 — durable preservation remains incomplete; P2 evidence gap

`docs/cloud/handoff/b10b-s3f-next-implementation.md:137–141`; retained evidence-manifest.json durableCopy field — **the complete NEXT evidence has not been verified at a durable authorized destination**. Failure scenario: another executor replacement would lose the raw profiles and reproducibility material, while the reviewed branch currently contains only the implementation report and two dispatcher logs. The local publication parts and full archive are not remote archival proof. **Severity P2 for completion of the required evidence deliverable.**

I verified all 125 entries of SHA256SUMS and compared all 126 regular-file members of the complete tar archive against their locally retained bytes; all match. The complete archive SHA256 is 941c11f5d11a76c4c01f2c2c1e2b6500aab67b29294f287751a8cd4783379cd4. This establishes local integrity only. Required resolution: publish the required lossless logs/manifest and preserve the complete raw archive at a verified authorized durable destination, retrieve it and verify the digest. Keep the original archive/digest; publish later dispatcher records and this provenance clarification as identified companions or a separately identified new archive version. Do not silently replace the original archive or call its transient path a durable link. Public-repository hygiene and destination authorization still apply.

## Verified source semantics and regression evidence

The e5ccee3→3f2af837 diff touches only facts.ts, the local fact-materialization block in projection.ts, and additive tests in b10b-s3-facts.test.ts and b10b-s3-perf-regression.test.ts. No existing assertion was removed; benchmark, fixtures, package/lock, rows/plans/cards/selection/monitor, core/ledger/collectors, contracts and visual baselines are unchanged.

I independently compared the frozen original constructor expressions against the new assignments. All 66 expressions match after whitespace/shorthand normalization. Original constructor keys, typed initializer keys and unconditional fill keys have the same 66-key order. NodeFacts schema, shortRefOf, metric, factsEqual, comparatorFor and FACT_NAME are byte-identical. The private newNodeFacts initializer is the fixed-shape form explicitly allowed by the diagnostic-v3 ruling, not a second optimization. Default calls still return independent ordinary complete objects. The sole API addition is the optional final, exclusively owned NodeFacts buffer.

At `projection.ts:392–430`, scratch is invocation-local and begins undefined. Reference hits do no new extraction. Full-comparison hits retain the old entry.facts and NodeProjection and keep only the unretained comparison record as scratch. Misses build/store that complete record, then clear scratch before another node can reuse it. Retained facts are never borrowed as a buffer. A fully compared equal pass requires at most one disposable full record; M misses require M retained records plus at most one additional temporary record. This is a source ownership bound, not a sampled-byte calculation. All-cold/all-miss work still allocates retained records and incurs initializer plus fill writes.

The inherited one-entry whole-tree memo is unchanged. Tuple invalidation, custom caches, counters, sweep, PNode/topology ownership, old projection/plan/frame/lazy-row references, destination order and exact action descriptors retain their existing semantics. There is no global pool, cross-pass spare, additional memo slot, topology/plan retargeting, cache expansion, timer, I/O, benchmark-aware branch or shifted measured boundary. The one strongly retained latest tuple may remain while idle; caller-held older snapshots legitimately retain their own graphs. Neither this bound nor sampled RSS proves a global retained-byte limit or leak absence.

The new guards are meaningful:

- Default calls produce independent 66-key ordinary records.
- Opt-in refill returns the supplied record. Proxy-observed assignments and poisoning of every old field catch skipped absent/null/false writes; complete-field comparison is supplemented by unchanged independent field-value tables and the baseline-expression audit.
- Frozen retained facts survive equal/miss/equal passes, later changes/reverts, and distinct-entry alias checks with exact counter expectations.
- All-cold/all-miss records stay distinct through removal/reinsertion; older facts and snapshots remain intact.

Corrected baseline execution compiles the additive guards against the original five-argument API: 15/16 pass, with only the explicit opt-in record-identity policy guard failing. Candidate focused execution is 16/16. This is a new reuse-policy negative, not evidence of a prior output defect. The earlier bad conflict.since=null compile and the overlapping baseline attempt that ran only the old 12 tests are preserved and correctly excluded as negative-guard proof. Equivalence/snapshot guards may pass both implementations and are not speed evidence.

The 385/385 B10B log includes complete fact/comparator/row-key coverage, identifier digit/underscore/dollar guards, memo/envelope/custom-cache/A→B→A tests, unread lazy rows, older exact descriptors, changed roots/conflicts/topology/options/clocks, and R1's history-child/card-child plus fifth-sub-row cases. R1's a7548716 commit remains an ancestor and its implementation files are untouched by NEXT. R1 remains fixed. R3 remains the unchanged non-blocking P3 reference-document Open/double-click wording issue outside this whitelist; no dispatcher effect is added.

## Strict evidence, kept separate

All tuples below are CN/RN/CC/RC p99 milliseconds, with limits 2/2/10/15. Every printed population has n=1000 after 200 warm-ups and unchanged nearest-rank calculation. The frozen benchmark blob is 371b8f784229636f66e88434c422484dd85251eb; fixture is a711705346161d155324c86564ab819e546d3fae. Compiled benchmark SHA256 is 24a2437918e49b34339f5eb15c3c325e50bb9d1cf9b0faefada2139d74425022.

Implementer matched baseline e5ccee3:

- Node 22 #1: 3.578 / unmeasured / 19.329 / 11.178; exit 1.
- Node 22 #2: 1.641 / 0.620 / 8.468 / 13.125; exit 0.
- Node 22 #3: 4.468 / unmeasured / 7.891 / 9.702; exit 1.
- Node 24 #1: 1.121 / 2.024 / 13.356 / 29.737; exit 1.
- Node 24 #2: 2.097 / unmeasured / 17.426 / 15.673; exit 1.
- Node 24 #3: 0.816 / 1.397 / 16.333 / 19.084; exit 1.

Implementer frozen NEXT candidate:

- Node 22 #1: 0.817 / 1.180 / 8.895 / 13.151; exit 0.
- Node 22 #2: 1.630 / 1.923 / 9.776 / 10.407; exit 0.
- Node 22 #3: 0.927 / 1.153 / 9.375 / 14.119; exit 0.
- Node 24 #1: 1.167 / 1.306 / 16.600 / 14.899; exit 1.
- Node 24 #2: 1.641 / 1.467 / 14.726 / 20.701; exit 1.
- Node 24 #3: 1.138 / 1.413 / 30.930 / 15.546; exit 1.

Unmeasured baseline RN follows the existing compact assertion failure. Those three baseline processes print 13 populations; the other baseline processes and every candidate process print all 16. Missing populations are not passes. Per-run p50/p95/p99/max and chronology agree with the raw logs and summaries. Candidate p99 ranges are Node 22 CN 0.817–1.630, RN 1.153–1.923, CC 8.895–9.776, RC 10.407–14.119; Node 24 CN 1.138–1.641, RN 1.306–1.467, CC 14.726–30.930, RC 14.899–20.701. These are ranges of individual p99 values, not pooled percentiles.

The implementer recorded fresh per-command temporary HOME/HUD_HOME, expanded 180/300-second wrappers clearing the specified variables, exact Node paths and npm CLI, successful build/build:test/build:hud-mcp per phase, and generated/dependency manifests. Node v22.23.4/v24.22.1 and npm 11.9.0 were matched. Host was 097d2cc36dae, Linux 6.18.57 x86_64, Intel Xeon Platinum 8573C. Dependency aggregate is 3425410732bfb12b750feb3a86cb9ebe2bf03855caf7e1657cc723e3586d8beb. Each strict manifest contains 1,027 dist-test file hashes; the two runtime manifests agree within each source arm. The benchmark and fixture identities are unchanged. Logged observations and reserved serial work do not prove continuous external-host isolation.

Dispatcher initial Node 22, after both builds failed with npm-not-found:

- #1: 1.747 / 1.365 / 11.490 / 11.250; exit 1.
- #2: 0.997 / 0.846 / 7.843 / 9.933; exit 0.
- #3: 1.126 / 1.015 / 8.832 / 9.298; exit 0.

Dispatcher Node 24, after build/build:test succeeded:

- #1: 0.784 / 0.690 / 16.866 / 16.699; exit 1.
- #2: 1.054 / 0.769 / 12.154 / 12.724; exit 1.
- #3: 1.071 / 1.020 / 16.069 / 20.010; exit 1.

Separately recorded corrected dispatcher Node 22, after build/build:test succeeded:

- #1: 1.451 / 1.164 / 7.600 / 8.220; exit 0.
- #2: 0.930 / 0.816 / 48.571 / 12.724; exit 1.
- #3: 1.269 / 2.778 / 118.364 / 8.496; exit 1.

The initial Node 22 1/0/0 results are not substituted for the corrected 0/1/1 results. All outcomes remain observations with NEXT-E1's limitations; none is a waiver. Historical pre-install/installed PERF baselines, prototype pass, old candidate/dispatcher failures, earlier B10B-S3F failures and the failed empty-GC collection remain preserved in their prior records. This review does not claim to have recovered lost historical raw profiles.

## Diagnostic-v3 verification and limits

**Archived v2 method unavailable. Authorized v3 substitute collected and analyzed successfully on the available local records; durable preservation remains open under NEXT-E2.** This is not execution or reconstruction of the original v2 method and not method/hash equivalence.

I inspected the transform, preload, wrapper, analyzer, pre/post manifests and raw channels, and independently recomputed allocation attribution, scoped CPU intervals, sample statistics, GC overlap and sampled memory. The source and recorded values agree. The original pre-execution method archive exists separately, dated before either arm, with SHA256 0ab02107796776dc4aefcfba66f0fd1472c7b475b12724ddf2162a908ae32493; its later copy inside the final evidence bundle is the same bytes. Both diagnostic copies are identical, SHA256 3698c230e252756a5729a794477dac3ba0c5489a83523e7c073edfce3e6277a3. Strict compiled output remains unchanged before/after.

Both freshly rebuilt Node 24 arms preserve the measured/prepare boundary and workload. Protocol records show successful in-process allocation sampling at 32,768 bytes with both major/minor-collected-object flags true, CPU sampling at 1,000 microseconds, and successful stops without channel errors. Each arm contains all 16 stable populations, exactly indices 0–999, consistent sample durations, 200-warm-up boundaries and memory observations after every 50 measured samples. GC has 1,201/1,188 entries and recorded delayed drains of 157.119/172.591 ms. Both diagnostic processes exit 1 on retained benchmark assertions, not timeout or missing instrumentation; complete diagnostics can still be analyzed, but are not strict passes.

Matched sampled allocation bytes, baseline→candidate:

- Whole-workload inclusive projection: 7,123,657,344→6,243,227,624; facts: 2,177,039,864→1,321,970,456; planRows: 582,394,224→580,169,840.
- Compact changed rows-only combined scope: inclusive facts 540,763,000→263,978,992; direct nodeFacts 341,531,592→65,904,064, with direct newNodeFacts 0→65,888.
- Rich changed rows-only combined scope: inclusive facts 539,736,200→268,570,680; direct nodeFacts 343,958,704→68,887,984. No separate helper frame sampled here does not mean zero helper allocation.

The stack mapping requires changedTicks, the rowsPanel callback and the compact/rich callback in the diagnostic file. It separates clone preparation and whole-monitor stacks where represented, but combines warm-ups, asserted every-row and unasserted 60-row work. Inclusive categories overlap and cannot be added. nodeFacts includes value-producing work such as shortRefOf; these are not exact full-record bytes, retained bytes or per-gated-sample allocation counts. Inlining/sampling/unassigned stacks remain limitations. No old-v2 total is used as a comparison arm or denominator.

Changed rows-only combined scoped CPU interval estimates agree: compact 5,658,841→4,743,142 microseconds, inclusive facts 908,644→736,143; rich 8,127,788→5,046,357, facts 1,175,219→695,783. Inspector clock brackets intersect, but 11,855/12,957-microsecond uncertainty is too large for exact fast-sample attribution. These are stack-scoped sampled observations, not exact CPU costs or a universal improvement claim.

Slowest-ten changed-every-row GC overlap, merging overlapping GC intervals before summing:

- Compact: 142.904/221.356 ms = 64.56%, 8/10 samples; candidate 123.326/211.919 = 58.19%, 8/10.
- Rich: 99.551/576.371 = 17.27%, 5/10; candidate 173.992/208.552 = 83.43%, 10/10.

GC conversion uncertainty is 0.146/0.199 ms. These are temporal correlations, not causal decomposition; nothing is subtracted from strict time. Instrumented compact p99 worsens 14.536→15.143 ms while rich improves 21.866→17.231 ms. Sampled old-space maxima are compact 151,476,888→155,993,424 bytes and rich 150,742,152→118,508,544; sampled RSS is compact 409,083,904→404,172,800 and rich 460,066,816→463,810,560. Mixed memory/GC/timing observations do not prove a leak, retained-byte reduction or reliable tail compliance.

Together, source ownership, complete-field/snapshot guards and this matched pair support the selected claim of reduced disposable-record materialization pressure. That claim is narrower than acceptance and does not close R2 or V1.

## Exact-candidate checks and owner evidence

Verified raw outcomes:

- build, build:test, build:hud-mcp: pass in implementer phases/final checks.
- Focused facts/perf-regression: 16/16.
- All B10B normal-mode suites: 385/385, not a strict-series replacement.
- npm test: blocked, not run.
- Separate mjs: 47 total, 32 pass, 15 fail; synthetic herdr-bridge Unix-socket failures show listen EPERM. No unsupported pass is inferred.
- Core: 210 total, 208 pass, 1 fail, 1 skip; the audit-event failure remains.
- Visual: 331/331, unchanged baselines.
- Hud-mcp: 84 total, 77 pass, 6 fail, 1 skip. One authorized isolated rerun per affected file: b20-advice 9/9; delegation 7/8; resume-expected-run 6/7. The latter two remain ledger_busy failures. No further rerun was made.
- Format, fixtures and diff checks: exit 0.

The owner report was freshly read from local-verification/20261103; its blob remains 26c5dee833483d623766f7d751a46b2d670971e6. It tests old PERF 9496910, not NEXT. Its summary's series-A 12/12 claim conflicts with detailed sections 7.1/7.3: Node 22 baseline run 2 is exit 1 with compact p99 14.319 ms, making A 11/12 overall. All six old candidate processes in A pass, as do all six in B; B is 12/12 overall. The report also preserves imperfect isolation, Node 22 proxy-related failures, RUNZ1 failure and full-gate red from root-owned WSL Relay /proc environ EACCES. Those useful old-target observations neither verify NEXT nor invalidate the cloud failures, and are not formal P-06-7 supported-profile qualification.

## Carry-forward disposition

- R1: fixed and preserved; relevant guards pass.
- R2: not fixed, P2 acceptance blocker.
- R3: unchanged P3, non-blocking and outside scope.
- V1: open, now with actual failing separate mjs/core/hud-mcp evidence in addition to blocked npm test.
- V2: historical provenance limitation remains disclosed; it cannot be repaired retrospectively.
- NEXT-E1: current independent verification does not satisfy the prescribed provenance/isolation record.
- NEXT-E2: local evidence integrity verified; authorized durable retrieval/publication not verified.
- Snapshot/scratch lifetime: no new must-fix semantic defect found; accepted bounds are ownership bounds, not universal memory guarantees.
- Integration: no accepted or green merged tree exists. DOC2/TPD1 and other dependencies remain held by the existing queue rules.

The narrowly released NEXT submission has now received its fresh final review. Do not assign an automatic production fix, substitute another optimizer, run another diagnostic pair or continue strict retries on this allowance. Return the precise remaining performance/verification/publication findings for a new bounded disposition under the owner's delegated Oracle process, while preserving all candidates and results. Any later acceptance still requires complete applicable evidence, and any integration requires its own complete green merged-tree checks before publication. Do not lower thresholds, change workload/statistics, drop a runtime, bypass access denials, broaden ownership or infer acceptance from another workstream.

## Sources

- [Published code commit and full-tree identity](https://github.com/CartmanFatass/codex-hud/commit/0cca9caa6ddf3249291c8ed85a41da1eed800ee4).
- [Reviewed evidence head](https://github.com/CartmanFatass/codex-hud/commit/9a899b867e93de98c00bffae6a137ce6f3dbc708).
- [Exact four-file code comparison](https://github.com/CartmanFatass/codex-hud/compare/e5ccee38165b30809bd537e7f31cfed7f227f152...0cca9caa6ddf3249291c8ed85a41da1eed800ee4).
- [Handoff-only descendant comparison](https://github.com/CartmanFatass/codex-hud/compare/0cca9caa6ddf3249291c8ed85a41da1eed800ee4...9a899b867e93de98c00bffae6a137ce6f3dbc708).
- [Implementation report](https://github.com/CartmanFatass/codex-hud/blob/9a899b867e93de98c00bffae6a137ce6f3dbc708/docs/cloud/handoff/b10b-s3f-next-implementation.md), [initial dispatcher log](https://github.com/CartmanFatass/codex-hud/blob/9a899b867e93de98c00bffae6a137ce6f3dbc708/docs/cloud/handoff/b10b-next-dispatcher-initial.log), [corrected Node 22 log](https://github.com/CartmanFatass/codex-hud/blob/9a899b867e93de98c00bffae6a137ce6f3dbc708/docs/cloud/handoff/b10b-next-dispatcher-node22-corrected.log).
- [NEXT brief](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/B10B-S3F-NEXT.md), [next-route ruling](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/rulings/b10b-next-route-20261103.md), [diagnostic-v3 ruling](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/rulings/b10b-diagnostic-v3.md).
- [Prior PERF final review](https://github.com/CartmanFatass/codex-hud/blob/e5ccee38165b30809bd537e7f31cfed7f227f152/docs/cloud/handoff/b10b-s3f-perf-review-1.md), [owner old-target verification report](https://github.com/CartmanFatass/codex-hud/blob/local-verification/20261103/docs/cloud/handoff/local-verification/20261103/REPORT.md).

The complete raw NEXT evidence used here is currently in /workspace/shared/b10b-s3f-next-evidence and its separately hashed tar archive. These are transient executor locations, not verified remote archive links.