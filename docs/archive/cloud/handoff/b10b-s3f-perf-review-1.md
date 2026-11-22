# B10B-S3F-PERF final Oracle review

Date: 2026-11-03. Verdict: **fix required**. **Do not merge B10B-S3F or B10B-S3F-PERF.**

The one-entry memo implements the consulted identity and snapshot policy correctly; I found no new must-fix semantic defect in its production diff. The submission nevertheless does not close R2: the final implementer series has a Node 24 compact-changed failure, and the independent dispatcher series has repeated compact-changed failures plus a rich-changed failure. The complete check set also remains unrun on this candidate, independently blocking acceptance. The additional remediation submission is now reviewed; this verdict grants no automatic further implementation round.

## Review scope and verified identity

This was a fresh, read-only review of the brief, the memo and validation rulings, the branch, implementation report, eight evidence parts, dispatcher log and full supplied evidence archive. I also inspected the applicable workflow, STATE, architecture rules, segment-2/3 design and rulings, prior B10B-S3F findings, benchmark and affected cache consumers. I ran no build, test, benchmark, local-machine action, or git mutation. File reads, checksum verification and read-only analysis of recorded measurements are not new test executions.

- Base: `bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60`, tree `f9bcdc5c069156d655ca7d3cd7a08590e74b8eec`.
- Measured local candidate: `5f2134d0ccedeca4d4fe184699b3bdd2307a65f4`, tree `f3fff50d66c62effd9a169e8ccca73c6e21833cb`.
- Connector-published code commit: `d9225d2ad149bf20cf2d03ab0b9414403ae66376`. GitHub's Git commit object confirms its tree is also `f3fff50d66c62effd9a169e8ccca73c6e21833cb`. This is an exact whole-tree match, not merely an assertion that two files match. Publication used two commits from the base rather than the measured local commit's identity.
- Inspected evidence head: `94969100ec85a41f93eb2a0d677aefc886290691`. The ten commits after `d9225d2` add only the implementation handoff, eight evidence parts and dispatcher log. They do not change source, tests, benchmarks, fixtures, dependencies or baselines.
- The complete implementation diff is `projection.ts` (+11/-4) and the new 256-line regression suite. Their Git blobs are respectively `0dfa98ea2d4eee52e838780141181345cb4b6397` and `c7507ed4a3ccf0920c842d4b351e80788bff595e`.
- The benchmark remains blob `371b8f784229636f66e88434c422484dd85251eb`. No benchmark or fixture change is hidden in the diff. The only tracked local worktree modification is the generated `node_modules/.package-lock.json`; it is absent from the committed diff.
- The eight published evidence parts concatenate to 284,308 characters and exactly reproduce the 55 archive logs with their section delimiters plus `SHA256SUMS`. The archive SHA256 is `f37c78a253d73a905329fedf97ec23a7e04b2977712906d9a433991681f4503a`; all 95 checksummed members match. These are integrity checks, not independent proof of how an experiment was executed.
- I independently parsed all 18 implementer strict-series logs. Every one of the 285 recorded population rows, including n, p50/p95/p99/max, strict flag and process exit, matches `series-summary.json`. The earlier pre-install failure with an absent rich no-change population is preserved, not converted to a pass.

## Findings and required resolution

### R2 — not fixed; P2 acceptance blocker

`tests/unit/b10b-s3-perf.test.ts:198–217`; `docs/cloud/handoff/b10b-s3f-perf-dispatcher-20261103.log:215,267,270`; `docs/cloud/handoff/b10b-s3f-perf-implementation.md:60–98` — **The required strict changed-tick evidence is still not reproducibly within the unchanged gates.** On Node 24 the final implementer candidate has compact changed p99 10.579 ms. The later dispatcher record has compact changed 10.233 and 12.314 ms and rich changed 15.716 ms, with two failing processes. A later favorable run, Node 22 success, unasserted diagnostic, or GC hypothesis cannot replace these results. **Severity P2.** Required resolution: preserve the experiment as unaccepted; complete properly identified capable-executor evidence already authorized by the owner, and refer any additional rendering remedy or changed acceptance terms to the owner under the brief's stopping rule. Do not keep rerunning until a favorable subset appears.

The existing exception is for a single compact-changed over-limit result followed by a recorded run alone. It cannot cover this whole record: compact failures repeat and a separate rich gate fails. Even if the implementer's first Node 24 failure were considered eligible in isolation, the later independent record prevents closing R2 through that exception. The shortcoming is an acceptance result, not proof of a newly introduced output bug.

### V1 — complete-check gate remains open; P2

`docs/cloud/handoff/b10b-s3f-perf-implementation.md:127–145`; `docs/cloud/B10B-S3F-PERF.md`, “Complete checks and independent blockers” — **`npm test` and the separate `test:mjs` stage were not run in this remediation worktree; there is no complete green candidate check set or merged-tree check set.** Focused B10B, core, visual and hud-mcp passes do not cover the missing unit population or mjs stage. The previous reviewed full run remains 2,455 tests, 2,427 pass, 12 fail, 16 skipped, exit 1, with mjs not reached. No result in this submission turns those failures into passes. **Severity P2.** Required resolution: run and retain the full required commands on the exact published candidate in the already-authorized capable executor; if `npm test` short-circuits, record `test:mjs` separately and still mark `npm test` failed. Diagnose any remaining failures under their owning workstream. The final integration tree needs its own complete green checks before a merge can be published.

The earlier failures comprise four socket cases, three helper-death cases, three ptrace cases and two waiter/forwarder cases. Environmental diagnosis is useful but is not execution evidence that the affected behavior passes. This review does not infer that HYG2, RUNZ1 or a future integration has already resolved them.

### V2 — independent-run provenance is incomplete; P2 evidence gap

`docs/cloud/handoff/b10b-s3f-perf-dispatcher-20261103.log:1–13,173–176` — **The dispatcher series was not independently rebuilt and did not record a compiled-output digest; its archived command header omits the actual isolation wrapper.** The dispatcher confirmed during review that it reused the implementer's preceding compiled output and did not independently build or hash it. Its exact outer wrapper was `export TMPDIR=/workspace/scratch/6daef0397a95/hud-tmp; export HOME=$(mktemp -d); unset HUD_HOME NO_COLOR FORCE_COLOR NODE_USE_ENV_PROXY;`, followed by three strict processes for each runtime in the candidate worktree. This provides a temporary HOME and leaves HUD_HOME unset, but it is one outer HOME rather than a fresh HOME/HUD_HOME pair for each run; the confirmation does not document clearing NODE_OPTIONS. **Severity P2 for using this series as complete independent acceptance evidence.** Required resolution: preserve this limitation with the log, rather than retroactively claiming an independent exact build. The next authorized verification must rebuild and identify the tested artifact, record the relevant environment and fresh temporary paths, and retain all outcomes.

The exact source-tree match and the implementer's preceding successful builds are strong corroboration, but they do not recreate the missing historical dispatcher artifact check. This gap is not evidence that stale output or environment flags actually caused the failures, and it is not a reason to discard those failures. Granting the intended candidate attribution would still leave R2 failed.

No further implementation fix is assigned automatically. R2 needs an owner-governed disposition after this single additional submission; V1/V2 concern verification and evidence. No new must-fix source correctness defect was found.

## Strict results, kept as separate experiments

Each tuple below is compact no-change / rich no-change / compact changed / rich changed p99 in milliseconds, followed by process exit. Limits are 2 / 2 / 10 / 15. All listed populations have n=1000 after 200 warm-ups; percentile calculation remains nearest-rank. The source still measures reconciliation, alternating actual key movement, row rendering and frame-diff on the 200-node, 56-column fixture. Changed views are fresh structured clones with one differing node. No-change reads the 60 rows in view; compact changed reads every required row, and rich retains the frozen viewport behavior. Whole-render, visible-only changed, miss-selection and cold populations remain separate diagnostics.

Matched installed baseline (`bd7e77a`):

| Runtime/run | CN / RN / CC / RC | Exit |
|---|---|---|
| Node 22 #1 | 0.727 / 0.816 / 8.372 / 10.303 | 0 |
| Node 22 #2 | 0.736 / 0.579 / 8.160 / 7.363 | 0 |
| Node 22 #3 | 0.868 / 0.570 / **10.339** / 7.857 | 1 |
| Node 24 #1 | 0.559 / 0.740 / **12.125** / 13.331 | 1 |
| Node 24 #2 | 0.453 / 0.400 / **11.886** / 13.535 | 1 |
| Node 24 #3 | 0.397 / 0.384 / **13.273** / 12.416 | 1 |

Frozen implementer candidate (`5f2134d`, identical code tree to `d9225d2`):

| Runtime/run | CN / RN / CC / RC | Exit |
|---|---|---|
| Node 22 #1 | 1.048 / 0.553 / 4.915 / 6.336 | 0 |
| Node 22 #2 | 0.995 / 0.794 / 9.717 / 6.464 | 0 |
| Node 22 #3 | 1.213 / 0.904 / 5.457 / 5.557 | 0 |
| Node 24 #1 | 0.493 / 0.443 / **10.579** / 12.540 | 1 |
| Node 24 #2 | 0.482 / 0.623 / 9.488 / 12.379 | 0 |
| Node 24 #3 | 0.683 / 0.375 / 9.900 / 12.893 | 0 |

Dispatcher verification, 15:29:31–15:37:08 UTC, with the V2 limitations:

| Runtime/run | CN / RN / CC / RC | Exit |
|---|---|---|
| Node 22 #1 | 1.106 / 0.672 / 9.134 / 6.532 | 0 |
| Node 22 #2 | 0.709 / 0.754 / 5.543 / 6.476 | 0 |
| Node 22 #3 | 1.553 / 0.776 / 5.530 / 6.948 | 0 |
| Node 24 #1 | 0.752 / 0.427 / 9.716 / 12.016 | 0 |
| Node 24 #2 | 0.492 / 0.525 / **10.233** / 13.254 | 1 |
| Node 24 #3 | 0.961 / 0.438 / **12.314** / **15.716** | 1 |

The matched implementer comparison shows a useful compact-changed signal: Node 22 8.160–10.339 → 4.915–9.717 ms and Node 24 11.886–13.273 → 9.488–10.579 ms. Node 22 compact no-change moves upward, 0.727–0.868 → 0.995–1.213 ms, while still passing. Dispatcher compact-changed ranges are separately 5.530–9.134 ms on Node 22 and 9.716–12.314 ms on Node 24; rich changed is 6.476–6.948 and 12.016–15.716 ms. These are ranges of per-run p99 values, not a pooled percentile.

The pre-install baseline remains a distinct experiment, including compact no-change 2.202 ms and rich no-change unmeasured in Node 22 run 3, and three Node 24 compact-changed failures. The exploratory Node 24 prototype pass is not one of the declared final three and does not replace any failure. Prior B10B-S3F failures also remain in force as historical evidence. The report correctly retains them.

The implementer recorded matched runtime patches v22.23.4/v24.22.1, dependency installation, source identities, build outputs, benchmark and fixture identities, fresh process wrappers, timestamps and process/load observations. The final builds identify compiled benchmark SHA256 `24a2437918e49b34339f5eb15c3c325e50bb9d1cf9b0faefada2139d74425022` and candidate generated-file aggregate `91f562344feb9be84fec8cce5b19f7ddc5c19b08e483a10c361231a6dc3e2bc7`. These are implementer provenance, not a substitute for the missing dispatcher check.

Host is `d14215e6cbaa`, Linux 6.18.57 x86_64, observed AMD EPYC 9V74. The implementer disclosed separate tool PID namespaces and lack of control or continuous visibility over external host scheduling. Scheduling agent workloads serially is useful; quiet snapshots are not proof of host-wide isolation. No supplied measurement attributes the new failures to contention. Remote numbers remain design evidence, not formal WSL P-06-7 qualification.

## Semantic review and regression assessment

`projection.ts:323–351` changes only private storage and lookup in `projectDelegation`:

- Shared-cache immediate reuse still requires identical tree, details and capacity references.
- A distinct VM envelope sharing that tuple returns the prior shallow-wrapper behavior with its exact incoming `vm`, without rewriting the stored result.
- A changed tuple rebuilds through the unchanged projection function and replaces the sole record. Custom caches neither consume nor replace the shared memo.
- A→B→A can rebuild A, as the design ruling explicitly allows. The new PNodes, topology, relation references and `proj.vm` belong to that input; the patch does not retarget older frames, plans, destinations or descriptors.
- Complete facts comparison, the digit-name comparator, per-node sweep, stable ordering, conflicts/overflow aggregation and selection logic are untouched. The source still has the four-plan, eight-row-string and 500-card limits. There is no side history, new retention map, capacity expansion, timer, I/O, runtime special case, benchmark detection or movement of work out of the timing boundary.
- The last tuple is strongly retained while idle. This is the disclosed, allowed one-record bound, not zero idle retention or a global memory bound independent of caller-held frames.

The nine new tests are proportionate to this mechanism. I inspected immediate identity and all tuple invalidations, envelope correctness, custom-cache isolation, deterministic eviction, equal rebuild/change/revert equivalence, removed/reinserted nodes and roots, old frames and unread lazy rows, original descriptor identity, clock/option boundaries and 40-root churn. Their assertions do not claim GC timing or speed. The corrected baseline is 8/9, failing only `perf memo policy: one live tuple is retained, A to B to A evicts without retargeting snapshots`; candidate is 9/9. The earlier two extra failures arose from the draft's raw key rather than the fixture's normalized action key, and the preserved corrected run resolves them. This is a fails-before policy guard, not proof of a prior visible correctness bug.

Existing guards remain unchanged and are present in the passing 381-test B10B run: exhaustive fact/comparator/row-key coverage in `b10b-cache.test.ts`; digit/underscore/dollar identifiers in `b10b-s3-facts.test.ts`; intent `selectionMap`, parent-aware put-away and stale-frame behavior in `b10b-s3-selection.test.ts`; both direct-child history/card cases at `b10b-s3-rich.test.ts:266–304`, each exercising compact and rich; and the fifth-sub-row cutoff at lines 245–264. Existing row, card and panel tests cover conflict overflow, plan/clock boundaries, collapsed/history/sort behavior, selected bands, translator/language, width and glyph changes. No existing assertion or visual baseline was weakened.

No real production caller regression from alternating distinct trees was established in the supplied evidence. The unasserted S2 alternating-two-VM diagnostic does become slower, exactly as the one-entry policy predicts. Its standalone p99 goes compact 2.163 → 3.267 ms and rich 1.285 → 5.674 ms; p50 goes 0.389 → 1.078 and 0.337 → 1.137 ms. Those frozen labels no longer describe two whole-tree hits. The report discloses this correctly. It is not a hidden gate failure, but also not evidence of a universal performance improvement. A different cache capacity would require the consultation specified in the ruling.

## Profile and memory limits

I checked the diagnostic instrumentation and independently recalculated the reported changed-population slowest-ten GC overlap and sampled old-space peaks from the raw records. The report's figures agree:

- Compact instrumented p99: 13.130 → 11.574 ms; slowest-ten overlap 85.11% → 78.38%.
- Rich instrumented p99: 14.332 → 14.934 ms; overlap 55.28% → 82.52%.
- GC entries/duration: 1,232 / 7,329.217 ms → 1,200 / 6,919.485 ms across the whole diagnostic.
- Sampled compact old-space peak: 108,023,328 → 137,705,344 bytes; rich: 130,963,000 → 132,893,552 bytes.

The sampled allocation attribution is essentially unchanged for projection construction (3.913 → 3.904 GB), facts (2.166 → 2.176 GB) and plans (0.586 → 0.587 GB). The summarizer attributes samples to the nearest delegation ancestor; these are workload-wide sampled allocation estimates, not retained heap bytes or a gated-population-only allocation total.

CPU/allocation sampling, sample recording, memory snapshots and asynchronous GC observation alter the workload. The initial empty-GC diagnostic is correctly preserved as a collection failure, not evidence of no GC. There is no heap-root proof of a WeakMap leak or ephemeron-specific cause, no demonstrated retained-byte reduction, and no reliable general GC-tail improvement. A value referring back to a weak key does not itself prove permanent retention. The profile justified the bounded experiment under the validation ruling, but it does not override the failed strict result or establish this policy as the accepted remedy. No GC subtraction is permissible.

## Checks and carry-forward dispositions

Recorded successful checks: build, build:test and build:hud-mcp; B10B 381/381; core 209 pass plus one existing skip; visual 331/331 with unchanged baselines; hud-mcp 83 pass plus one existing skip; format, fixtures and diff check. These checks were recorded on pre-freeze candidate source; the final strict series subsequently rebuilt the frozen commit for both runtimes. The tracked source-diff digest matches the final production change. The missing full `npm test` and mjs results remain explicitly missing, not green.

- **R1: fixed, carried forward.** Its parentKey direct-child fix is untouched, and both history/card regressions plus the fifth-sub-row test remain green in the B10B log.
- **R2: not fixed; P2 acceptance blocker.** Measured improvement is insufficient under the unchanged supported-runtime gates and evidence requirements.
- **R3: unchanged, P3 non-blocking.** The reference-document pending-Open-dispatch and double-click wording remains outside this performance whitelist. Do not introduce dispatcher effects here.
- **Full-check and integration gates: open.** No result permits treating another package, a diagnostic, or the pending local verification as an already-green candidate or merged tree.

## Disposition

Preserve the candidate and every earlier result. Keep B10B-S3F and this remediation unaccepted and unmerged; do not release dependent wave-2 work. Record the remaining question for the owner: the approved one-entry experiment improves some observed tails but does not close the unchanged Node 24 gates, while complete capable-executor verification is still outstanding. My recommendation is to complete the separately authorized local/capable-executor verification with exact source and artifact provenance, keep its platform-specific results distinct, and request a new bounded remediation decision before any further implementation if the gate remains open. Do not lower thresholds, change sampling or timing scope, drop Node 24, add a second slot, or silently reopen the fix budget.

A future applicable Oracle acceptance and a complete green final integration-tree check set are both still required. This review authorizes neither a merge nor a new automatic fix round.

## Sources

- [Inspected candidate/evidence head](https://github.com/CartmanFatass/codex-hud/commit/94969100ec85a41f93eb2a0d677aefc886290691).
- [Published code commit](https://github.com/CartmanFatass/codex-hud/commit/d9225d2ad149bf20cf2d03ab0b9414403ae66376).
- [Complete package comparison](https://github.com/CartmanFatass/codex-hud/compare/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60...94969100ec85a41f93eb2a0d677aefc886290691).
- [Implementation handoff](https://github.com/CartmanFatass/codex-hud/blob/94969100ec85a41f93eb2a0d677aefc886290691/docs/cloud/handoff/b10b-s3f-perf-implementation.md).
- [Dispatcher evidence](https://github.com/CartmanFatass/codex-hud/blob/94969100ec85a41f93eb2a0d677aefc886290691/docs/cloud/handoff/b10b-s3f-perf-dispatcher-20261103.log).
- [Approved brief](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/B10B-S3F-PERF.md), [memo ruling](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/rulings/b10b-s3f-perf-memo.md), [validation clarification](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/rulings/b10b-s3f-perf-validation.md).
