# Brief B10B-S3F-NEXT: bounded facts materialization remediation

Date: 2026-11-03. Tier S. Implementer: Astra high. Design consultations and final review: fresh Astra max Oracles. The dispatcher records, schedules and verifies; it does not decide design or acceptance.

## 1. Decision and authority

**Release one narrowly specified additional remediation submission, followed by one fresh final Oracle review: reduce disposable NodeFacts record allocation on the changed-view path, with complete fact extraction and comparison unchanged.** Production ownership is only facts.ts and the facts-materialization portion of buildProjection_ in projection.ts. Preserve the reviewed one-entry whole-tree memo. Do not implement any alternative optimization under this release.

This is a new explicit bounded allowance under the owner's latest delegation and docs/cloud/rulings/b10b-next-route-20261103.md. It is not a renewal of the consumed B10B-S3F-PERF allowance, a reset of earlier fix counters, or an automatic two-fix-round budget. The supplied owner instruction is:

> 后续你有本地测试需求可以发给我 然后继续工作即可 我有空会完成测试 队列任务你直接完成即可 无需我批准 有需要抉择的地方请让oracle直接决定

B10B-S3F and B10B-S3F-PERF remain fix required, unaccepted and unmerged. R1 remains fixed; R2, V1 and the integration gate remain open; V2 remains an historical provenance limitation; R3 remains non-blocking and outside this work. No result below is acceptance of the previous candidate.

The selected remedy addresses measured allocation in a required call path. It is not a claim that this allocation explains every tail, that GC has a single cause, or that this change will meet the gates. Its speed and correctness must be established by the prescribed experiment and review.

## 2. Pinned inputs and lineage

Governing universal-hud snapshot: 42aadb85e3381e2d4af22e2b028e5c6a37e8f670, tree 21bc368c42b0605e59885e1ccb0d0e0a81082c4d. Its only change from the preceding governing head f26124235480d6d6d9f588c3bd62b47388467302 is docs/cloud/rulings/b10b-next-route-20261103.md. That ruling's blob is d1cace6e3cbc25ed0b322b79150c94a6b008b15b.

The follow-on source base is the frozen PERF review head e5ccee38165b30809bd537e7f31cfed7f227f152 on dots/b10b-s3f-perf. Create a separate worktree and branch dots/b10b-s3f-next from this exact commit after the dispatcher records this brief and its release. A descendant containing only this brief and new evidence is permissible if its precise ancestry and unchanged implementation are recorded. Do not advance, rewrite or replace the old PERF branch being offered for owner-run verification.

Identity chain:

- Original PERF base: bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60, tree f9bcdc5c069156d655ca7d3cd7a08590e74b8eec. Preserve its R1 implementation a754871612b8e56e8df12e907e8ae1654c24f999.
- Measured local one-entry candidate: 5f2134d0ccedeca4d4fe184699b3bdd2307a65f4, tree f3fff50d66c62effd9a169e8ccca73c6e21833cb.
- Published code commit: d9225d2ad149bf20cf2d03ab0b9414403ae66376. The prior final review verified that its complete tree equals the measured local candidate's tree.
- Reviewed evidence head: 94969100ec85a41f93eb2a0d677aefc886290691. The ten intervening commits after the published code commit add evidence only.
- Current PERF head e5ccee3 adds only docs/cloud/handoff/b10b-s3f-perf-review-1.md after 9496910. This consultation independently checked that comparison. Its production facts.ts and projection.ts blobs match the inspected local candidate: a9b61a5981587d4eee63f8fffd7534394a4c1be5 and 0dfa98ea2d4eee52e838780141181345cb4b6397 respectively. This is not a claim that the later evidence-bearing full tree equals the earlier full tree.

This is a continuation of unresolved wave-1 B10B work. It is not an accepted universal-hud base for DOC2, TPD1 or any other package.

Binding inputs remain AGENTS.md; docs/cloud/dots.md and README.md; STATE.md; engineering-plan §3 complete-brief requirements; architecture §8; contracts 01–07 as applicable, particularly contract 06 P-06-7 and its B10C amendment; information-design §6 and the segment-3 selection/action sections; B10B-S3F, B10B-S3F-PERF and B10B-s3 briefs; segment-2/3 rulings; the performance, memo, validation, queue-progress and next-route rulings; B10B-S3F recheck-2; the complete PERF implementation report, final review, raw evidence and dispatcher log. Read src/CLAUDE.md and src/render/CLAUDE.md. Later applicable owner instructions take precedence over older authorization text.

## 3. Existing evidence, kept separate

The historical installed baseline is bd7e77a; the historical candidate is 5f2134d, with the published-tree equivalence stated above. Matched runtime patches were Node v22.23.4 and v24.22.1, npm 11.9.0. Host: d14215e6cbaa, Linux 6.18.57 x86_64, observed AMD EPYC 9V74. Separate tool PID namespaces and uncontrolled external scheduling limited host visibility; no failure has been attributed to contention by evidence.

The following are ranges of per-run p99 in milliseconds, not pooled percentiles. CN/RN/CC/RC mean compact no-change, rich no-change, compact changed and rich changed. Limits remain 2/2/10/15.

- Installed baseline Node 22, three runs: CN 0.727–0.868, RN 0.570–0.816, CC 8.160–10.339, RC 7.363–10.303; exits 0/0/1.
- Installed baseline Node 24: CN 0.397–0.559, RN 0.384–0.740, CC 11.886–13.273, RC 12.416–13.535; exits 1/1/1.
- Frozen implementer candidate Node 22: CN 0.995–1.213, RN 0.553–0.904, CC 4.915–9.717, RC 5.557–6.464; exits 0/0/0.
- Frozen implementer candidate Node 24: CN 0.482–0.683, RN 0.375–0.623, CC 9.488–10.579, RC 12.379–12.893; exits 1/0/0. The failing compact result is 10.579.
- Later dispatcher Node 22: CN 0.709–1.553, RN 0.672–0.776, CC 5.530–9.134, RC 6.476–6.948; exits 0/0/0.
- Later dispatcher Node 24: CN 0.492–0.961, RN 0.427–0.525, CC 9.716/10.233/12.314, RC 12.016/13.254/15.716; exits 0/1/1.

The pre-install baseline is a different experiment. Preserve its Node 22 compact no-change 2.202 failure and the resulting unmeasured rich no-change population, plus its three Node 24 compact failures 12.343/13.431/13.012. Preserve the exploratory prototype pass separately, not as one of the final three. Preserve all earlier B10B-S3F results, including the older Node 22 no-change failure and older Node 24 compact/rich failures. The existing single compact-overrun/isolated-rerun exception does not close the repeated failures in the reviewed record.

All population n, p50/p95/p99/max, exits and chronology remain in series-summary.json and raw logs of the archived PERF experiment. The archive SHA256 is f37c78a253d73a905329fedf97ec23a7e04b2977712906d9a433991681f4503a. Available original bytes are in /workspace/shared/b10b-s3f-perf-evidence, with the archive beside it. Published evidence parts preserve the logs; local paths alone are not public download links.

The old final builds record compiled benchmark SHA256 24a2437918e49b34339f5eb15c3c325e50bb9d1cf9b0faefada2139d74425022 and candidate generated-file aggregate 91f562344feb9be84fec8cce5b19f7ddc5c19b08e483a10c361231a6dc3e2bc7. The installed baseline aggregate is 3385b1e7d1ee7b465c1eecfe47eb2b73eb216cf1015b7e800f9ebfc0b75e09cb. The dispatcher did not independently rebuild or digest its old artifact, and its archived header omitted its actual outer wrapper. Later evidence cannot retrospectively repair V2 or establish that this gap caused a failure.

The prior candidate lacks npm test and separate mjs results. The earlier full execution remains 2,455 tests, 2,427 pass, 12 fail, 16 skipped, exit 1, with mjs not reached. Socket, ptrace and process-discovery explanations do not convert those failures into passes. Successful B10B 381/381, core 209 plus one skip, visual 331/331 and hud-mcp 83 plus one skip remain focused results only.

## 4. Call-path diagnosis and bounded inference

In frozen tests/unit/b10b-s3-perf.test.ts:163–172, structuredClone prepares a new VM before each measured changed sample. Inside the measurement, rowsPanel at lines 129–159 calls delegationView, handles a real alternating up/down key, reconciles selection, constructs delegation rows, reads required text, then frameDiff. Clone preparation is outside the timed sample, though it contributes to the process's allocation and later GC.

The first delegationView call reaches projectDelegation. A fresh tree/details/capacity tuple misses the one-entry memo and enters buildProjection_. Within that function:

- Relations and topology lookup containers are rebuilt. Each projected PNode, child list and subtree record belongs to the incoming VM. These are necessary snapshot containers unless a separately reviewed design proves safe reuse.
- At projection.ts:413, cloned nodes fail the reference shortcut and nodeFacts constructs a fresh 66-field primitive record. factsEqual compares every field with the cached record. On the equal path at lines 414–421 the new record is not retained: NodeProjection is reused, while the cache entry's node/detail/relation references and seen generation update. On a miss, the new record becomes that cache entry's facts.
- buildProjection_ then constructs the current topology, aggregates counts/conflicts/spend and sweeps disappeared entries. This work remains necessary and unchanged by the selected remedy.
- planRows at rows.ts:154 is keyed by the new DelegationProjection. It therefore builds new plan rows/maps for a changed snapshot. destinationsOf is keyed by that plan, and rich draws blocks/destinations in actual screen order. Plans hold PNodes; they are not safe to retarget to another VM merely because rendered facts compare equal.
- Subsequent delegationView and delegationAgentsRows calls for the same tuple reuse the whole projection and the applicable plan. renderMonitor similarly calls reconciliation/view construction and delegationPutAway for the same VM. The older button may require the history-hidden option beside the shown plan, not a second VM slot. Bar/statusline call projectDelegation independently in their own rendering paths. No inspected production caller establishes alternating distinct-tree thrashing that justifies changing the one-entry policy.
- Row strings are keyed on NodeProjection plus the complete context. Compact PlanRowText and rich lazy rows hold snapshot/context references. A caller retaining A while B renders is legitimate ownership, not by itself a leak.

The recorded paired instrumented profiles attribute about 3.913/3.904 GB to projection construction, 2.166/2.176 GB to facts and 0.586/0.587 GB to plans. Those are workload-wide sampled allocations attributed by nearest delegation ancestor. They include cold and unasserted work; they are neither retained bytes nor gated-only totals.

This consultation also read the raw heap call trees without executing the program. Restricting stacks to the compact or rich changed test callback, changedTicks, and the rowsPanel closure separates the two rows-only changed populations from clone preparation and whole-renderMonitor work. The selfSize attributed directly to nodeFacts is:

- Installed baseline: compact 345,374,640 bytes; rich 354,759,344 bytes.
- One-entry candidate: compact 353,210,088 bytes; rich 346,958,136 bytes.

Reproduction of this read-only attribution: recursively sum selfSize where the current frame functionName is nodeFacts and the ancestor chain has b10b-s3-perf-diagnostic.js changedTicks, its anonymous rowsPanel closure at one-based line 117, and the compact/rich test callback at one-based line 169/176 respectively. These are the line locations of the archived instrument.py diagnostic transform. The sums combine the gated every-row and unasserted 60-row populations, including their warm-ups; they cannot separate the two closure instances or prove a per-gated-sample byte count. JIT inlining and sampling also prevent treating selfSize as an exact allocation count or guaranteed savings.

Input heap SHA256s are fd063d46a0083089721ab23cfa6bc3e9f02520de7ef382ee9427db7453565f02 for baseline-installed-profile-heap.json and 369ecc0c6da760ebe59009d2320cc57673348dfd443f27288d116eeb6ca24d5b for candidate-prototype-profile-heap.json.

The source establishes that the disposable record construction occurs inside the frozen measurement, and the scoped sampled stacks show it is substantial in both changed styles. This is sufficient to choose a small materialization experiment; it does not establish a guaranteed tail reduction. Match/slice/join in shortRefOf, topology containers, row layout and shared width helpers are separate costs. In particular the large whole-workload codePointWidth sample total must not be presented as gated delegation-only work.

The old profiles remain mixed: compact instrumented p99 13.130→11.574, rich 14.332→14.934; compact slowest-ten GC overlap 85.11%→78.38%, rich 55.28%→82.52%; sampled old-space peaks rise from 108,023,328→137,705,344 and 130,963,000→132,893,552 bytes. The empty-GC first diagnostic remains a collection failure. There is no proven leak, general GC improvement or host-contention cause.

## 5. The one selected production mechanism

Use at most one private, fully populated temporary NodeFacts record at a time within a single buildProjection_ invocation's node loop. Refill it for a node whose reference shortcut missed, then perform the existing complete factsEqual comparison.

- On a facts-equal hit, preserve the stored entry.facts object and NodeProjection. The unretained comparison record may be refilled for the next node.
- On a miss, build the new NodeProjection and transfer that complete record to the new cache entry. It is no longer scratch and must never be overwritten by this mechanism. Clear the local scratch reference; allocate the next temporary record only when needed.
- Do not borrow entry.facts as the buffer. Do not copy new facts into an existing cached record. Do not hold a spare record in a global, ProjectionCache, side map or cross-tick pool.
- Keep one authoritative extraction path for all 66 existing primitive fields. Every refill must write every field, including null/false/default transitions. Do not allocate another full object merely to Object.assign it into the buffer, which would retain the allocation this mechanism is meant to remove.
- Existing nodeFacts calls without an opt-in buffer must still return independent complete objects with the same values and key coverage. A backwards-compatible optional final NodeFacts buffer argument is permitted for the owned caller. If a small helper is necessary, keep it in facts.ts, with the same single extraction path; disclose its export/API impact. This is not permission for a new generic pool or code-generation subsystem.
- Keep factsEqual, comparatorFor and the identifier guard unchanged. Do not weaken fields, stamp checks, constructor/key coverage or the immutable-input assumption. Preserve shortRefOf and metric semantics; this release does not include a separate short-reference optimization.

Falsifiable expectation: for a fully rebuilt equal tree, full fact extraction/comparison still occurs for every node, but disposable full-record allocation falls from one record per compared node to at most one reusable record for that pass. With M fact misses, records retained by those misses remain necessary and at most one extra temporary record is needed. The unchanged-VM reference/memo fast path needs no new work. This is an allocation-lifetime hypothesis, not a new numerical acceptance gate. If the implementation still materializes a full object per equal node, or the paired evidence does not support a benefit, report that result and stop this remedy rather than substituting a different optimization.

Rejected for this release: another memo slot or WeakMap rollback; structural plan reuse; pooling/retargeting PNodes, topology or descriptors; relation-sort/container refactors; row-key/width/card changes; changes to shared colors.ts; clone/workload changes; GC tuning. Some are plausible future investigation subjects, but this brief grants none of them.

## 6. Complete ownership and outputs

Production files, and only these portions:

1. src/render/delegation/facts.ts: nodeFacts materialization and a narrowly necessary in-file fill helper. The NodeFacts schema, fact values, shortRefOf, metric behavior, factsEqual, comparatorFor and FACT_NAME behavior do not change.
2. src/render/delegation/projection.ts: local temporary-record lifecycle in buildProjection_'s per-node fact extraction/equality/miss block. The public ProjectionCache shape/API, counters, sweep, projectDelegation memo, graph construction, relation selection, aggregates and synthetic-conflict behavior do not change.

Additive tests only:

- tests/unit/b10b-s3-facts.test.ts.
- tests/unit/b10b-s3-perf-regression.test.ts.

Do not remove, weaken or rewrite existing assertions. No shared fixture or visual baseline changes. All other old PERF production-whitelist files are now outside this smaller release, including rows.ts, cards.ts, lines.ts, panel.ts, selection.ts and monitor.ts. monitor-input.ts and frame-diff.ts are unchanged. No tree-page, core, ledger, collector, packages, utils, bin, package/lock files, runtime declarations, benchmark sources, contracts or design-document edits.

Dispatcher-owned repository records:

- docs/cloud/B10B-S3F-NEXT.md, this complete brief.
- docs/cloud/handoff/b10b-s3f-next-implementation.md.
- docs/cloud/handoff/b10b-s3f-next-baseline-20261103.log and b10b-s3f-next-candidate-20261103.log, with lossless numbered .partNN.txt files if required by publication limits.
- docs/cloud/handoff/b10b-s3f-next-checks-20261103.log.
- docs/cloud/handoff/b10b-s3f-next-dispatcher-20261103.log.
- docs/cloud/handoff/b10b-s3f-next-evidence-manifest.json.
- docs/cloud/handoff/b10b-s3f-next-review-1.md.
- docs/cloud/rulings/b10b-s3f-next-<specific-topic>.md only for a necessary scoped consultation.
- docs/handoff/STATE.md and engineering-plan status, factual dispatcher updates only, serialized with other work. No acceptance or merge status before its gates hold.

Raw non-repository scratch deliverables: /workspace/shared/b10b-s3f-next-evidence/ containing new command wrappers, source/build/dependency manifests, chronological stdout/stderr and exit records, all population summaries, diagnostic transforms/preloads/analysis, raw profiles and SHA256SUMS; a distinct b10b-s3f-next-evidence-20261103.tar.gz. Do not modify or overwrite the previous PERF archive or evidence directory. Build products and temporary HOME/HUD_HOME belong only to the new worktree/session and must not be staged.

Ownership comparison: HYG2 owns src/ledger/runtime.ts's warning, b45-launch and process helpers; RUNZ1 owns src/core/run/process.ts/direct helpers and run-control/runz1 tests. Neither intersects the two production files or two test files here. P065-BUDGET preparation and its shared-ledger work do not grant edits here. B10D collector/tree-page ownership, later data work, Inspector, DOC2 and TPD1 remain excluded. Shared status/handoff publication is dispatcher-serialized. Disjoint source ownership does not allow concurrent performance loads or a queue jump.

## 7. Required correctness and lifetime evidence

Add focused coverage proportionate to the selected mechanism:

1. Opt-in refill returns the intended temporary record; the default nodeFacts call still returns a fresh independent record. Refill a previously populated record across incompatible node/detail/relation shapes, including fields becoming absent/null/false, and compare every key/value against fresh extraction. Preserve the exact complete-field coverage tests.
2. Warm an explicit ProjectionCache, retain and freeze its entry.facts objects, then project rebuilt-equal and one-fact-changed VMs with equal/miss/equal nodes in the same pass. Assert stored old facts remain unchanged, distinct entries never alias one mutable scratch record, counters remain correct, and warm output equals a fresh cache. Include a later node that changes after an earlier hit and a later hit after a miss.
3. Change and revert facts; remove and reinsert nodes; reuse keys under other roots; exercise different parent/bucket/conflict data and optional fields. Cache size and disappeared-node cleanup must retain their existing semantics. All-cold/all-miss input must remain correct without pretending its retained facts can be reused.
4. Preserve old compact/rich projections, plans, frames and unread lazy rows while changed B renders, then inspect/read/navigate A. Assert its original VM/node/relation references, text, destination order and exact original action descriptor. Existing PERF tests supply most of this coverage; cite and rerun them.
5. Preserve all memo tuple/envelope/custom-cache/A→B→A tests; shown/history-hidden plans; clock and put-away boundaries; collapse/history/sort; width/style/translator/language/glyph contexts; selectionMap and parent-aware put: behavior.
6. Rerun unchanged b10b-cache complete fact/comparator/row-key tables, comparator digit/underscore/dollar tests, R1's two direct-child compact/rich cases and the fifth-sub-row cutoff.

A temporary-record reuse assertion can be a fails-before/passes-after policy guard. Label it as such, not proof of a pre-existing output defect. Make baseline execution meaningful rather than claiming a missing symbol/compiler failure is the desired negative. Equivalence and snapshot guards may pass both trees and are not speed proof. Actual output bugs found during this work require baseline classification; do not silently expand the scope to repair an unrelated pre-existing bug.

## 8. Commands, timeouts and expected state

These are execution instructions after release, not commands run by this consultation. Record each actual expanded command, selected runtime binary, start/end UTC and exit. Select an available authorized cloud executor; do not restart assistant-run local sessions.

For every build/test/strict/profile invocation create fresh temporary HOME and HUD_HOME under a dedicated session TMPDIR. Use the actual selected Node binary and put its directory first on PATH so npm child scripts use the same family. Clear and record NO_COLOR, FORCE_COLOR, NODE_USE_ENV_PROXY and NODE_OPTIONS; strict runs have no heap/GC tuning. A wrapper has the form:

h=$(mktemp -d "$TMPDIR/home.XXXXXX"); u=$(mktemp -d "$TMPDIR/hud.XXXXXX")
env -u NO_COLOR -u FORCE_COLOR -u NODE_USE_ENV_PROXY -u NODE_OPTIONS HOME="$h" HUD_HOME="$u" PATH="$(dirname "$NODE"):$PATH" timeout <seconds>s <command>

Record actual temporary paths and the complete wrapper rather than merely saying isolated. Log only relevant environment, not secrets. Capture failures without shell chaining that silently prevents later required commands from being recorded. A timeout is an incomplete failed attempt, not a pass; clean up only owned PIDs and retain the log.

Commands and timeouts:

- git rev-parse HEAD HEAD^{tree}; git status --short; git diff --name-status; git hash-object for benchmark/fixtures; source/dependency/build SHA256 manifests: 60 seconds each. Expected: pinned ancestry, only owned changes, unchanged frozen benchmark/fixtures/dependencies, and explicit dirty-state accounting. Never stage node_modules/.package-lock.json.
- If required tools are missing, the already-established npm ci --ignore-scripts installation against the unchanged lockfile: 600 seconds. Record it and use the identical installation for the paired trees; no dependency update. A denied operation is not retried by changing routes.
- npm run build: 180 seconds; npm run build:test: 180 seconds; npm run build:hud-mcp: 180 seconds. Expected exit 0 and newly identified generated outputs from the pinned source. Record each separately.
- node --test --test-concurrency=1 dist-test/tests/unit/b10b-s3-facts.test.js dist-test/tests/unit/b10b-s3-perf-regression.test.js: 180 seconds. Expected all focused guards pass on the candidate; record meaningful baseline policy results separately.
- node --test --test-concurrency=1 dist-test/tests/unit/b10b*.test.js: 600 seconds. Expected all B10B correctness and existing diagnostics pass under their normal invocation; this is not the strict series.
- B10B_PERF=1 <selected-node> --test dist-test/tests/unit/b10b-s3-perf.test.js: 300 seconds per process, with B10B_PERF set in the actual env wrapper. Expected the four unchanged gates and complete population output; every outcome is retained.
- One paired allocation/CPU/GC diagnostic per tree on Node 24, using the archived profile-v2 method adapted only for exact paths/provenance and a separate copy of compiled benchmark output: 300 seconds per process. Expected complete raw profiles/sample labels/GC drain and unchanged workload; timing is diagnostic only. Missing or failed instrumentation is reported, not a no-GC conclusion.
- npm test: 1,200 seconds. Expected exit 0, unit and mjs stages actually reached. Where the executor's previously denied socket/ptrace actions would recur, do not bypass or retry them on the same insufficient authority: record this command as blocked here and obtain actual exact-tree execution from the permitted capable executor/owner evidence. Do not mark it green.
- npm run test:mjs: 300 seconds, separately if npm test does not reach it. Expected exit 0; npm test nevertheless remains failed/blocked as applicable.
- npm run test:core: 600 seconds; npm run test:visual: 600 seconds; npm run test:hud-mcp: 600 seconds. Expected exit 0, only existing explicitly reported skips, and visual baselines unchanged.
- npm run format:check: 180 seconds; npm run check:fixtures: 180 seconds; git diff --check: 60 seconds. Expected exit 0; no unrelated formatting/baseline change.

The complete README check set remains required on the exact candidate and again on the final merged tree. This brief does not add a new full-suite runtime matrix. Both runtime families remain mandatory for strict performance. Record commands that did not run and their exact blockers. Known flakes receive only their existing permitted isolated rerun with both logs retained; this adds no new flake category.

## 9. Declared experiment and provenance

Before editing, reserve the new worktree and source ownership with the dispatcher, check whether relevant owner-run evidence has arrived, and reserve serialized measurement windows. Do not overlap agent-controlled builds/tests/benchmarks. Non-performance read-only preparation elsewhere may continue. No unrelated processes are terminated.

The new matched baseline is e5ccee3's one-entry source, not the pre-PERF bd7e77a code. Historical measurements above remain useful context but do not replace the new exact-build paired experiment. On the same host, same dependency installation and same runtime patches, run:

1. Freshly build the pinned baseline and record Node 22 strict runs 1/2/3, then freshly build it for Node 24 and record runs 1/2/3.
2. Implement only the selected mechanism and complete focused correctness work. Freeze the candidate source, tests and commit identity. There is no second policy or alternate optimizer in this allowance.
3. Freshly build that frozen candidate and record Node 22 strict runs 1/2/3, then Node 24 runs 1/2/3. Do not alter source, flags or workload between runs. Do not keep rerunning until a favorable subset appears.
4. Run the single separately labeled paired Node 24 diagnostic on the same baseline/candidate using identical instrumentation. Compare facts-materialization allocation, changed-path CPU and sample-correlated GC without subtracting it from strict timing. Include old-space/RSS observations with their sampling limits. Do not claim all sampled nodeFacts bytes disappear or infer a leak from graph shape.
5. The dispatcher independently rebuilds the submitted pinned candidate, digests the generated artifacts and runs its declared three fresh strict processes per runtime, with fresh HOME/HUD_HOME per process. Its evidence is separately named, not pooled with implementer results.

Use the already available v22.23.4/v24.22.1 when possible. Any other supported patch is identified and used consistently on both sides. Record Node/npm paths and versions, source SHA/tree and exact diff, fixture and benchmark blobs, package-lock and dependency identity, clean/dirty status, OS/kernel/CPU/host, UTC timestamps, observable load/process names without private arguments, and external-host control limits. Rebuild rather than reusing preceding compiled output. Digest dist-test source/test outputs and the strict benchmark; preserve diagnostic copies separately so they cannot be mistaken for acceptance artifacts.

For every strict process retain n, p50/p95/p99/max for every printed population, all four gate outcomes, exit and full output. Report per-run ranges without pooling. Retain contaminated/interrupted attempts and explain them; a replacement requires a recorded reason, not deletion of the original. Quiet snapshots are not continuous isolation proof. Any source correction after the final measured freeze creates a new candidate and requires a separately recorded disposition, not reuse of the earlier pass.

The benchmark remains source blob 371b8f784229636f66e88434c422484dd85251eb; fixture b10b-big.ts remains a711705346161d155324c86564ab819e546d3fae. Keep 1,000 samples after 200 warm-ups, nearest-rank, 200 nodes/56 columns, moving clocks, real alternating selection, fresh clones with one differing node, exact prepare/measured boundary, compact every-row changed work, rich viewport behavior and 60-row no-change work. Whole-monitor, visible-only, cold and selection-miss populations remain diagnostics. No trimming, best-run selection, GC subtraction, pooled replacement percentile, runtime removal or benchmark-aware production branch.

## 10. Submission and review

The implementer returns the full artifact/report, not a private reasoning transcript: exact base/head/tree, complete changed-file/function list, the optional API change, record-ownership proof, all field/snapshot invariants, regression names and negative/positive results, baseline and candidate manifests, every strict result, diagnostic limitations, complete check outcomes and explicit open blockers. The dispatcher archives reports verbatim and raw logs losslessly. Publication uses the authorized project workflow; if connector publication changes commit identity, record and verify exact tree equivalence before calling it the tested candidate. No credential workaround or uncertain-send retry is implied.

A fresh final Oracle verifies the report against the complete branch and evidence, including inherited PERF code and applicable prior findings, without reopening untouched accepted areas unnecessarily. It must explicitly rule on R1, R2, R3, V1, V2's historical limitation, snapshot/memory boundaries and full-check status. Return accept or fix required with file:line/severity findings. Reduced allocation alone cannot close R2, and performance cannot close V1.

The dispatcher may integrate only after an applicable accept verdict and verified report. Integration is --no-ff into universal-hud, never main; run the complete check set on the final merged tree, with only permitted known-flake handling, and push only when that gate is green. A failed merged-tree check stops publication and returns to the prescribed Oracle disposition. No force-push, history rewrite or node_modules staging. This brief itself grants no merge.

## 11. Prerequisites, holds and stopping conditions

Implementation may start once this brief/release is recorded, the exact e5ccee3 lineage and two-file ownership are reserved, and the new worktree is separate from the owner's frozen test target. These are factual checks, not another generic owner-approval round. Pending owner-local results are not a blanket prerequisite. The dispatcher reports that no such results had arrived at this consultation; use relevant results if they arrive before the next decision.

Do not restart assistant-run local tests. The owner withdrew that work and will run local Claude when available. Exact-target results on local-verification/20261103 may be read when published, without asking Claude to message or reconfirm. Later tests of the old candidate do not automatically verify the new source. Request a concise new exact-target test need from the owner only when useful, and continue authorized independent cloud work.

Stop the dependent action and return a precise factual/design question if full extraction requires weakening the schema/comparator, scratch can alias any retained cache facts or snapshot, ownership needs an excluded file, a real caller requires a different memo policy, profiles do not support the chosen mechanism, or strict evidence remains insufficient. Preserve the attempt; do not substitute the short-reference scan, graph pooling, plan reuse or a larger cache. Correctness work before submission belongs to this one mechanism, not an unlimited performance search.

Security denials, unavailable kernel features and missing credentials remain blockers, not opportunities to change settings or evade controls. Local-only Herdr/tmux/real harness/probes, install/uninstall and live home/configuration paths remain out of scope. Formal supported-WSL P-06-7 qualification remains distinct from cloud design evidence.

DOC2 and TPD1 wait for the actual B10B-S3F merge. Inspector/data/B10D/LEG1/RCP1 keep their existing queue and separate-brief requirements. This wave-1 continuation does not advance a dependent wave, accept another package or change the scheduling ruling. Shared records remain serialized.

## 12. Distinct release disposition

**RELEASE: exactly one additional remediation submission of the temporary NodeFacts materialization mechanism in §5, within the two production and two additive test files in §6, plus its declared verification and one fresh final Oracle review. No alternative remedy and no automatic further fix round is released.**

This explicit exception is made under the owner's delegated choices and the next-route ruling after source, call-path, recorded allocation evidence, ownership and validation have been established. No contract, supported runtime, benchmark boundary, threshold, sampling rule, snapshot meaning, cache capacity or merge requirement changes.

**HOLD: acceptance, merge, wave-2 implementation and any further remediation after this submission.** R2 requires valid passing evidence on both supported runtime families under the existing rules; V1 requires actual complete candidate checks; integration requires its own complete green merged-tree checks. If this submission is fix required, return its precise remaining findings for a new bounded Oracle disposition under the owner's delegation. Do not infer another allowance from this package name or from elapsed time.

## Sources and consultation method

- Governing source: https://github.com/CartmanFatass/codex-hud/tree/42aadb85e3381e2d4af22e2b028e5c6a37e8f670
- Next-route ruling: https://github.com/CartmanFatass/codex-hud/blob/42aadb85e3381e2d4af22e2b028e5c6a37e8f670/docs/cloud/rulings/b10b-next-route-20261103.md
- PERF final review: https://github.com/CartmanFatass/codex-hud/blob/e5ccee38165b30809bd537e7f31cfed7f227f152/docs/cloud/handoff/b10b-s3f-perf-review-1.md
- Facts extraction: https://github.com/CartmanFatass/codex-hud/blob/e5ccee38165b30809bd537e7f31cfed7f227f152/src/render/delegation/facts.ts
- Projection path: https://github.com/CartmanFatass/codex-hud/blob/e5ccee38165b30809bd537e7f31cfed7f227f152/src/render/delegation/projection.ts#L337-L454
- Frozen benchmark: https://github.com/CartmanFatass/codex-hud/blob/e5ccee38165b30809bd537e7f31cfed7f227f152/tests/unit/b10b-s3-perf.test.ts
- Memo ruling: https://github.com/CartmanFatass/codex-hud/blob/42aadb85e3381e2d4af22e2b028e5c6a37e8f670/docs/cloud/rulings/b10b-s3f-perf-memo.md
- Queue ruling: https://github.com/CartmanFatass/codex-hud/blob/42aadb85e3381e2d4af22e2b028e5c6a37e8f670/docs/cloud/rulings/queue-progress-20261103.md

Method: read-only repository, source, report and raw-record inspection, plus arithmetic over existing sampled profiles. No source/test edit, branch/worktree creation, repository mutation, build, test, benchmark, new profile/instrumentation, local-machine action or subagent was performed by this consultation. The local worktree's pre-existing node_modules/.package-lock.json modification was left untouched. This is a design/release brief, not a second final review of the already reviewed PERF diff.