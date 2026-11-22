# MCP-ANCESTOR R4: cold-start attribution and bounded next step

Date: 2026-11-03. Fresh read-only Oracle consultation after mcp-ancestor-review-1.

## Decision

**Retain R4 as a P2 acceptance blocker. Approve one diagnostic-only tranche, MCP-STARTUP-DIAG, subject to the resource admission below. Do not release a production optimization, repeat-to-pass campaign, gate change or merge.**

The existing evidence establishes that the unchanged cold-start comparator fails on both the pinned baseline and candidate. It does not establish the causal performance bottleneck or the candidate's incremental effect. Attribution is the missing prerequisite to choosing a safe remedy. A bounded tranche that adds raw samples, complete child-output capture and CPU/host evidence is justified; another uninstrumented batch alone is not.

The owner's explicit delegation permits Oracle to make this bounded queue/design decision without another ordinary approval question. It does not override withdrawn assistant-run local testing, security denials, ownership, independent acceptance or integration gates. This ruling is not an accept verdict and does not consume or reset a source-fix round.

## 1. Reviewed identities and valid comparison

The causal source comparison is:

- Baseline production: 26f6fba36948e6c96e2e109cb374c0d4dbb9ab22, tree 03bd36610d46fd220eb9c0e4fbf153a52bc3c3b9.
- Candidate implementation: bfe630c981efeb7914dfffb2764c2c715b791a46, tree 10ce62eb316fb8954a5b667da261d301e2dd69ea.
- GitHub comparison confirms exactly process.ts and the three owned test files changed. The later candidate-branch commits inspected add only the implementation report, publication addendum and review. They do not change startup code.
- Baseline execution used the identical three candidate test files with pinned baseline production. Recorded build/dependency manifests agree outside the production process.ts/process.js difference, as verified in review-1. Installed dependency-state changes were excluded.
- The unchanged benchmark blob is c36817dee4cf70c27a39a86b3965f4eb6701ceb0. Match within a runtime and enabled proxy profile, not across Node families or against a no-envproxy result, another package, an old build or another machine.

Recorded cold p95 values in milliseconds, in run order:

- Node 22 baseline: 404.379, 251.948, 218.628. Candidate: 235.458, 544.945, 210.635.
- Node 24 baseline: 407.240, 375.217, 237.383. Candidate: 285.203, 548.036, 275.888.

Every one of the twelve runs completed its 30 cold samples and 200 calls per method, then exited 1 at the unchanged performance-gate assertion. All tools/list and refused-whoami p95 values were below 2 ms, hence below their 50 ms gates. This is completed failing performance evidence, not twelve unavailable startup results.

The original run-series.py schedules all three baseline runs before all three candidate runs within each runtime. Same run numbers are therefore not temporally interleaved matched pairs. The source/runtime/dependency matching is useful, but time, filesystem caching and uncontrolled host activity remain confounders. Do not average or pool these p95s into a replacement gate, claim equivalence, or call the candidate faster/slower on this evidence. Baseline failure rebuts attribution of the entire red gate to the patch; it does not prove that the patch has zero performance effect.

## 2. Measurement boundary and contract distinction

The existing driver measures from just before child spawn until the initialize response is received. Shutdown is outside that cold sample. It creates a new process each time but reuses one synthetic HUD home across the thirty samples in a run. Thus first ledger creation and subsequent existing-ledger starts share the reported distribution; it is not thirty fresh-database or controlled cold-page-cache starts. There is no discarded cold warm-up. The driver reports nearest-rank p95, the 29th ordered observation for n=30, and cold max. It does not emit the individual cold observations, p50 or p99.

Keep two distinct requirements:

1. The current limited comparator requires cold p95 < 200 ms, tools/list p95 < 50 ms and refused-whoami p95 < 50 ms. All twelve cold gates fail.
2. Contract 06 P-06-6, its measurement protocol and T-06-15 require at least 100 new MCP processes per declared form, cold startup < 200 ms checked per sample, page-cache conditions, and separate first tools/list/call measurement. Node/module loading and necessary storage opening remain inside the cost. Delayed initialization cannot conceal it.

The brief explicitly retains the small comparator without relabeling it full P-06/B14 qualification. Even a future green 30-sample p95 report would not establish the stronger contract requirement. The observed maxima, including 837.768 ms, already contradict any claim that this recorded population satisfies the per-sample bound. This ruling changes neither requirement.

## 3. Evidence-supported cause and limits

**Established failure location:** excessive end-to-end new-process-to-initialize wall time in a startup path shared substantially by both trees. The cause of that excess is still undetermined.

Source inspection identifies legitimate candidates for attribution: Node startup including the retained envproxy configuration, eager implementation/module loading, required ledger initialization/open, mandatory physical registration and optional ancestry reads, and scheduling/I/O delay. main.ts imports the implementation graph and performs storage/registration before serveStdioProcess. That proves those stages are within the boundary, not that any one dominates.

The patch adds only a narrow errno boundary around optional reader.get in findHarness. The baseline also reaches initialize throughout its recorded runs. There is no measurement connecting this small boundary to the hundreds of milliseconds observed. Equally, inspection is not proof that its timing cost is exactly zero.

Host evidence records Linux 6.18.57, glibc 2.41, Xeon Platinum 8573C and nine visible logical CPUs. Conventional cgroup limit queries returned unavailable values; there is no quota guarantee. The recorded package commands are serialized, but that does not control other activity on the host. The archive has no contemporaneous per-sample scheduling/throttling data, CPU profiles or startup-stage timings. Falling baseline run values and candidate middle-run spikes are compatible with several explanations and prove none.

The raw benchmark logs preserve what the driver emitted. The driver buffers each child's stderr and exposes it on request failure; successful-child stderr is not emitted as a complete archival stream. The visible Node 22 UNDICI-EHPA warning therefore cannot be used as a complete account of every child's diagnostics or as evidence of its latency cost. Do not suppress it or disable the proxy to manufacture a pass.

LedgerCallerRegistry's lock-held process-content reads remain a separately known compliance issue. No trace here establishes them as this latency bottleneck. R4 does not authorize moving/removing those checks, extending P065's metadata exception, or absorbing that separate repair.

## 4. Exact diagnostic release

Assign the existing MCP-ANCESTOR implementer one nonshipping evidence task. No tracked source, test, benchmark, dependency, package, runtime configuration or contract file may be edited for this tranche. Permitted new local artifacts are confined to a distinct MCP startup diagnostic evidence directory: one standalone driver, its manifest, raw per-process records/streams, CPU profiles and a report. Diagnostic files must never become production inputs.

Before execution, freeze and hash the driver and this inventory, record its deviations from the unchanged comparator, and have a fresh read-only reviewer verify the measurement/capture logic. Use the pinned baseline and implementation above. If R1's bounded test-only correction has already been frozen, the dispatcher may name that exact candidate SHA/tree instead only after verifying the startup production and launcher blobs are unchanged; record this explicitly, rather than silently substituting a branch head. Any production difference requires a new scope decision. Verify source/build/runtime/dependency identities before and after the tranche. Reuse only hash-verified existing build artifacts; if rebuilding is required, schedule it as the package's existing build group before this diagnostic window.

Fixed inventory, performed once:

A. On Node 22.23.4, then Node 24.22.1, run thirty adjacent baseline/candidate new-process pairs. Alternate pair order baseline→candidate then candidate→baseline. Each arm has its own fresh synthetic HOME/HUD_HOME/TMPDIR for that runtime series; reuse its HUD home across its thirty processes, matching the comparator's existing-ledger behavior. Preserve NODE_USE_ENV_PROXY=1 and the required proxy variables, unset NODE_OPTIONS/NODE_COMPILE_CACHE, and remove the same inherited real harness/session/color selectors. Do not record proxy secrets.

For each of these 120 MCP processes, record monotonic spawn→initialize, the first tools/list response latency and first refused-whoami response latency, raw stdout/stderr, initialization result, tool count, refusal result, exit/signal and close completion. Validate protocol/framing, seven tools and identity_source_missing. Mark the first fresh-ledger observation separately but retain it in the full population. No warm-up is discarded. A startup failure, timeout or invalid response is a failed observation, never a fast zero or a missing success silently omitted. Drain stdout/stderr through close/EOF. This diagnostic driver is not the unchanged acceptance benchmark.

B. Bracket each runtime's paired series with ten fresh minimal Node startup controls before and ten after, forty controls total. Use the same enabled environment and runtime; the child only writes a fixed readiness marker and exits. Capture spawn→marker and exit/streams. This provides a runtime/environment reference without claiming to be MCP or subtracting its duration/percentile from MCP cost. No network request or proxy routing experiment is part of this control.

C. After all unprofiled measurements, collect exactly two built-in V8 CPU profiles for each arm/runtime: one fresh synthetic HUD home start and a second new process reusing that home, eight profiles total. Launch the unchanged production entry with --cpu-prof and an explicit --cpu-prof-dir outside the repository. Send initialize, tools/list and refused whoami, then close normally and retain the complete streams/profile. Profiling overhead and shutdown are separately labeled; these sampled profiles are attribution evidence, never gate timings or exact wall-time stage partitions. No debugger server, ptrace, perf privilege, preload monkey-patch or modified compiled implementation is released.

Use a 600-second outer limit for each complete runtime paired series, a 60-second limit for each ten-control bracket, and a 60-second limit for each profiled process. Keep the existing five-second request limit. A limit or denial ends the affected group with retained evidence; no automatic replacement group or retry burst is released. Cleanup is restricted to exact owned child processes and temporary artifacts. Cleanup uncertainty stops the tranche and returns the resource with the blocker.

This is one attribution tranche, not a commitment to keep running until green. If its evidence is inconclusive, return that result for a fresh bounded decision.

## 5. Host noise, analysis and delivery

Before/after each group, record the visible CPU/quota/memory limits, OS/runtime identity, mount/filesystem location for code and synthetic storage, load/pressure and readable cgroup CPU/throttle counters. Lightweight before/after-pair snapshots are permitted; no continuous competing profiler/load generator is added. Read only ordinary permitted metadata. Missing metrics remain unknown. Do not infer nine dedicated CPUs, force a cache flush, pin CPUs/change governors, alter cgroups or terminate unrelated work. State that OS page-cache coldness and outside-host activity are not controlled.

Counterbalancing reduces ordering bias; it does not certify a quiet host. Preserve all noisy, failed and contaminated observations. Separate observed contamination from an explanation proved by evidence. If controlled work unexpectedly overlaps, stop starting new pairs, retain completed/current results, clean owned resources and report the series incomplete. No samples are replaced or erased.

The report must contain per-sample records and method/first-use distinctions; each arm/runtime's n, failures, ordered timings, nearest-rank summaries, maxima and over-200 counts; the actual pairing/order; complete child-output accounting; source/build/driver/binary hashes; CPU-profile limits; host observations; and a conclusion distinguishing measured evidence from hypotheses. Do not subtract quantiles, pool Node families, combine instrumented with uninstrumented timings, or give statistical-equivalence/regression claims unsupported by the design.

Return either an evidence-supported narrow bottleneck with an exact proposed repair/file list and preserved security/first-call boundaries, or an explicit unresolved result. Preserve originals and publish only losslessly sanitized evidence through the dispatcher's already authorized durable destination, with checksums/read-back and any transformations documented. The dispatcher records the ruling and report under separately named MCP-ANCESTOR performance records, using the single documentation writer.

## 6. Ownership, queue and alternatives

NODE22-PROXY owns the current compute lease. Do not start this tranche during it. Preserve the recorded initial order that remains: NODE22-PROXY, RUNZ1-KILL, then P065-BUDGET, with explicit returns. This ruling admits MCP-STARTUP-DIAG only at MCP-ANCESTOR's next available verification-sweep position after those initial windows. If the already required R1 correction/check group occupies that MCP position, the diagnostic takes MCP's following sweep position, not a second back-to-back lease. The dispatcher must record exact executor, owner, frozen tree, commands and return point. Silence or disjoint files is not admission.

Return the lease at the fixed inventory's completion or the first blocking prerequisite, access/cleanup/ownership issue. Do not retain it while analyzing, awaiting Oracle review or waiting for owner evidence. A truly independent already authorized executor needs a separately recorded assignment; another tool process on this machine does not qualify. Assistant-run local testing remains prohibited. The owner may receive a concise exact-tree request through the existing local-verification workflow while cloud queue work continues.

Alternatives rejected now:

- Waive R4 because baseline is red, call cold startup a known flake, relax the threshold, average the runs or select favorable ones.
- Repeat the same opaque comparator indefinitely without a changed premise or new attribution evidence.
- Disable envproxy, add warning suppression, enable an undeclared compile cache, use a fake registry, skip mandatory evidence, force a convenient ancestor, or move required startup work into the first tool call.
- Speculatively refactor module imports/storage/registration, modify the benchmark, or combine unaccepted NODE22-PROXY/P065/HYG2 code. Those exceed this diagnosis and lack a supported causal target.

A demonstrably unsuitable/contended host may later justify a separately declared matched series on another already authorized host; it does not retrospectively turn these failures into passes or grant local/security access. A measured product bottleneck may justify a new exact production repair brief with ownership/review/negative controls. Neither remediation is preselected here.

## 7. Gates after diagnosis

R4 remains open until a fresh Oracle dispositions valid measurements on the final identified candidate under the unchanged required configuration and comparator. Any production repair needs its own released scope, meaningful tests and final-code checks. The original twelve failed runs remain part of the record. The stronger P-06-6/T-06-15 qualification remains distinct and cannot be credited from this diagnostic tranche.

R1's bounded stream-capture correction, R2's real naturally occurring unreadable-ancestor evidence, R3's complete capable-executor checks and R5's durable evidence delivery remain independently open as recorded. No result here accepts another package, resolves the separate startup-writer issue or Node 22 compatibility package, or authorizes unaccepted-branch integration. Fresh package acceptance and a complete green actual --no-ff merged-tree check set remain mandatory before integration/push.

**Final disposition: R4 HOLD; one scheduled diagnostic-only tranche released; no production remediation or gate/profile change released.**

## Sources and method

- [Final review](https://github.com/CartmanFatass/codex-hud/blob/dots/mcp-ancestor/docs/cloud/handoff/mcp-ancestor-review-1.md).
- [Binding brief](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/MCP-ANCESTOR.md) and [governing boundary ruling](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/rulings/mcp-ancestor-gate.md).
- [Implementation comparison](https://github.com/CartmanFatass/codex-hud/compare/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22...bfe630c981efeb7914dfffb2764c2c715b791a46), implementation/publication reports, and the twelve original benchmark logs/JSON records, run-series.py, run-check.py, manifests and performance-summary.json in the supplied raw evidence directory.
- [Unchanged benchmark](https://github.com/CartmanFatass/codex-hud/blob/bfe630c981efeb7914dfffb2764c2c715b791a46/tests/hud-mcp/benchmark.mjs), [startup composition](https://github.com/CartmanFatass/codex-hud/blob/bfe630c981efeb7914dfffb2764c2c715b791a46/packages/hud-mcp/src/main.ts) and [ledger registration](https://github.com/CartmanFatass/codex-hud/blob/bfe630c981efeb7914dfffb2764c2c715b791a46/packages/hud-mcp/src/ledger-registry.ts).
- [Contract 06](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/contracts/06-observation.md), particularly P-06-6, measurement protocol and T-06-15.
- [Resource-window disposition](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/rulings/wave1-resource-windows-20261103.md).
- [Node 22.23.4 CPU profiling and envproxy documentation](https://github.com/nodejs/node/blob/v22.23.4/doc/api/cli.md) and [child close semantics](https://github.com/nodejs/node/blob/v22.23.4/doc/api/child_process.md#event-close).

Method: read-only repository/source/report/raw-log inspection and primary documentation lookup. No build, test, benchmark, new profile, probe, code/repository write, source-fix delegation or local-machine action was performed by this consultation.