# B10B-S3F bounded performance evidence ruling — 2026-11-03

**Decision: keep B10B-S3F unaccepted; do not merge.** The new series adds three passing Node 22 executions and three failing Node 24 executions on the unchanged implementation. It improves the evidence record, but does not close R2, establish a fully isolated three-run series, or satisfy the independent full-check gate. No acceptance rule changes.

## Scope and evidence identity

This is a read-only consultation on newly recorded evidence, not another review of the implementation. I read the final re-check, the complete new 349-line raw log, the B10B-S3F and segment-3 briefs, the applicable workflow and STATE rules, and the benchmark’s measurement and assertion definitions. I did not write files, mutate git, run tests or benchmarks, or reopen accepted correctness findings.

The inspected branch head was `431d2889964909e7d2798ddd0f739c1a877a22b3`. The new log is `docs/cloud/handoff/b10b-s3f-isolated-perf-investigation-20261103.log`, blob `eb0c3a3507b028a334390cce8cfeffd7f234b0a0`. Its recorded tested implementation is `a754871612b8e56e8df12e907e8ae1654c24f999`. GitHub comparison confirms that all 14 commits from that implementation commit to the inspected evidence head change only files under `docs/cloud/handoff/`; the implementation and benchmark are unchanged.

The prior ruling remains `docs/cloud/handoff/b10b-s3f-recheck-2.md`, blob `b3c2a75849863ba4f7d476d8d28fe83f516f9103`.

## What the new series establishes

The log records host `d14215e6cbaa`, Linux 6.18.57 x86_64, Node v22.23.4 followed by Node v24.22.1, exact benchmark command lines, UTC timestamps, load-average snapshots, output and process exits. The series ran from 14:04:14 to 14:11:49 UTC. Every measured population prints `n=1000` and `strict=true`; the unchanged source specifies 200 warm-up iterations and nearest-rank percentiles.

All numbers below are the gated p99 in milliseconds, not the separately printed whole-render, visible-only changed, selection-miss or cold-tick measurements.

| Runtime and run | Compact no-change, ≤2 | Rich no-change, ≤2 | Compact changed, ≤10 | Rich changed, ≤15 | Exit |
|---|---:|---:|---:|---:|---:|
| Node 22 run 1 | 0.693 | 0.749 | 6.435 | 7.134 | 0 |
| Node 22 run 2 | 0.982 | 0.864 | 8.892 | 8.841 | 0 |
| Node 22 run 3 | 0.545 | 0.697 | 5.734 | 7.092 | 0 |
| Node 24 run 1 | 0.578 | 0.614 | **13.972** | **15.228** | **1** |
| Node 24 run 2 | 0.631 | 0.438 | **11.623** | 12.618 | **1** |
| Node 24 run 3 | 0.436 | 0.961 | **13.484** | 14.277 | **1** |

New-series ranges:

- Node 22: compact no-change **0.545–0.982**, rich no-change **0.697–0.864**, compact changed **5.734–8.892**, rich changed **7.092–8.841**. Three processes pass, with all four gated populations measured in each.
- Node 24: compact no-change **0.436–0.631**, rich no-change **0.438–0.961**, compact changed **11.623–13.972**, rich changed **12.618–15.228**. All three processes fail compact changed; the first also fails rich changed.

Thus all twelve newly measured no-change populations pass. The earlier Node 22 no-change failure did not recur in these three executions. Node 24 compact changed, however, exceeds the strict limit in every new execution, and its rich changed failure also recurs once. These are observed failures on the recorded remote host, not a green performance result.

## Isolation and causal limits

The filename and opening label do not establish isolation. The log initially says no other test process was visible before the start, but explicitly disclaims control over external host activity. Its final note records three RUNZ1 performance processes at approximately **14:04:24–14:04:56 UTC**, overlapping the first Node 22 execution. That run must remain in the results and must not be described as isolated.

For later runs, no further competing test processes were reported. That is narrower than proof of a continuously idle or dedicated host. Load-average snapshots do not supply per-process CPU contention, scheduling delay or continuous load attribution. The record therefore supports a sequential benchmark series with a documented overlap, not a verified fully isolated three-run Node 22 series.

The runtime-associated difference is useful diagnostic evidence, but Node 22 was run first and Node 24 afterward, without controlled external load. This is not a causal experiment proving that the runtime alone, GC alone, or host interference caused each failure. The new log contains no per-sample GC correlation. The earlier instrumented GC evidence remains a hypothesis-supporting observation for its own measured samples; it cannot be subtracted from these timings or promoted into a blanket excuse for failures.

The recorded command lines also do not show the inherited `HOME`/`HUD_HOME` values or the build invocation. This does not prove unsafe execution or invalidate the visible timings, but the archive alone does not independently document those execution details. Future evidence should record the complete safe wrapper and build provenance, using synthetic temporary paths.

## Earlier evidence remains in force

These new results supplement, rather than replace, the separate evidence sets identified by the final re-check:

- The implementer’s original Node 22 series remains three passes.
- The earlier dispatcher Node 22 series remains exits **1 / 0 / 0**. Its first compact no-change p99 **3.726 ms** and compact changed p99 **31.765 ms** remain failures. Rich no-change was **not measured** in that execution because the compact assertion ended the shared test; it is neither a pass nor a measured failure.
- The earlier Node 24 series remains exits **1 / 1 / 1**, with compact changed **11.257 / 11.076 / 14.706 ms** and rich changed **15.672 / 13.697 / 16.611 ms**.
- The separate instrumented Node 24 diagnostic remains a compact changed failure at **13.685 ms**. Its reported 86.95% GC overlap concerns its ten slowest gated compact samples, not all runs or a revised gate.

Do not pool the three series into one percentile, report only the best runs, erase the overlapping run, or replace a failed measurement with an unasserted one.

## Consequence under unchanged gates

R2 remains a **P2 acceptance blocker**. STATE’s narrow exception for a single compact changed over-limit result after a recorded rerun alone is not a general waiver: the new Node 24 series fails compact changed three times, includes a rich changed failure, and does not close the separately recorded no-change failure by invoking that exception. Node 22 is permitted and its passing runs are useful, but they do not silently remove Node 24 from the supported-runtime evidence or overrule the existing failed disposition.

The complete check set was not rerun in this investigation. The final re-check’s **12 unit failures**, unit-stage exit 1, and **test:mjs not run** remain unresolved for acceptance. This consultation does not attribute those failures to one cause or to another package’s eventual fix. An accept verdict and a complete green merged-tree check set are both still required. Remote timings are design evidence, not formal WSL qualification.

R1’s fixed disposition and R3’s non-blocking disposition are carried forward without re-review. The package-specific single fix round has already been consumed; a performance experiment does not reset that limit.

## Concrete next step

Record this ruling with the existing unaccepted handoff and raise an owner question for a **narrowly scoped follow-on performance remediation**, rather than launching another automatic B10B-S3F fix round or repeating benchmarks until a pass appears. My recommendation is to authorize diagnosis and reduction of the changed-tick allocation/GC cost within the existing rendering ownership, while preserving the benchmark, measured boundary, synthetic workload, sample count, nearest-rank calculation, strict thresholds and supported runtimes. Any change to those acceptance terms requires a separate explicit owner decision.

After an authorized remediation, its evidence should include a verified build of the exact implementation commit and at least three strict, serialized runs per evaluated supported runtime, with no other agent-controlled tests scheduled in that window. Record full commands, temporary `HOME`/`HUD_HOME`, runtime and host, start/end timestamps, observable competing processes/load and any remaining host-control limits. Keep every result. Assess diagnostic profiles separately from unmodified acceptance timings. A fresh Oracle can then consider the changed evidence and implementation; acceptance still depends independently on resolving the outstanding full-check failures in a permitted environment and obtaining the required green merged-tree check set.

Until that authorization and evidence exist, preserve the correct R1 fix and all logs, keep B10B-S3F unaccepted, and continue other eligible work. No gate, supported profile, contract, or another package’s ownership is changed by this ruling.

## Sources

- [New bounded performance log, immutable evidence head](https://github.com/CartmanFatass/codex-hud/blob/431d2889964909e7d2798ddd0f739c1a877a22b3/docs/cloud/handoff/b10b-s3f-isolated-perf-investigation-20261103.log), especially lines 1–12, 14–171, 172–346 and 349.
- [Final re-check](https://github.com/CartmanFatass/codex-hud/blob/431d2889964909e7d2798ddd0f739c1a877a22b3/docs/cloud/handoff/b10b-s3f-recheck-2.md).
- [B10B-S3F brief](https://github.com/CartmanFatass/codex-hud/blob/431d2889964909e7d2798ddd0f739c1a877a22b3/docs/cloud/B10B-S3F.md), Steps 1–4.
- [Segment-3 acceptance](https://github.com/CartmanFatass/codex-hud/blob/431d2889964909e7d2798ddd0f739c1a877a22b3/docs/cloud/B10B-s3.md), Acceptance #4.
- [STATE](https://github.com/CartmanFatass/codex-hud/blob/431d2889964909e7d2798ddd0f739c1a877a22b3/docs/handoff/STATE.md), Merging, lines 55–59, and Local only.
- [Unchanged benchmark](https://github.com/CartmanFatass/codex-hud/blob/431d2889964909e7d2798ddd0f739c1a877a22b3/tests/unit/b10b-s3-perf.test.ts), measurement definitions and strict assertions.
- [Evidence-only comparison](https://github.com/CartmanFatass/codex-hud/compare/a754871612b8e56e8df12e907e8ae1654c24f999...431d2889964909e7d2798ddd0f739c1a877a22b3).