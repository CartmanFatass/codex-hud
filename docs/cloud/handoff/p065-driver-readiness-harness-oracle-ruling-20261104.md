# P065 driver readiness harness: independent source and admission ruling

Date: 2026-11-04 UTC. Repository: CartmanFatass/codex-hud.
Scope: the source-only readiness proposal, not an execution review or package acceptance.

## Decision

**Accept the exact extraction and the nonqualification boundary. The smallest next execution eligible for a named quiet admission is Node 24 stage C only, using the sealed command in section 6. No production, fixture, driver or holder correction is required by this ruling.**

The new controller's bounded direct-child path and its strictly owned helper-gate design are source-reviewable. The required read-only self/owned-process identity checks may be used as fail-before-launch prerequisites of that specifically admitted stage on the current independent cloud environment. This is not permission for a separate capability probe, a retry of a denied operation, a different executor, or an assumption that these checks will succeed.

**Keep R, I0, I1, I2 and Node 22 execution held pending the preceding stage's evidence and separate dispatch. Before I2, correct the missing-signal timeout branch described in H1 below.** That correction is confined to the diagnostic artifacts; it does not reopen R1, F1–F5 or the accepted two-file formatting successor. The unchanged C artifact need not be regenerated or rerun merely because a later I2 wrapper is corrected.

The historical CONFIG_PROC_CHILDREN limitation must not be assigned to the new cloud environment without evidence. Conversely, successful source review or compiler runs do not establish that the new ownership primitives have executed. An unavailable prerequisite means stop before the runner, retain the failure, and report the exact missing facility.

## 1. Exact reviewed identity and custody

Source commit: 8f67f7e2d8249295e5a84af0bb9b98817a30459c.
Source tree: 3e30a63f21d2c50389444dff65f2c47d1c3af3c4.
Accepted source parent: 4a484053473524b33184dc2cffc3dabd4bd63158.

Proposal ZIP:
- Filename: p065-driver-readiness-plan-01.zip.
- Size: 402,298 bytes.
- SHA-256: 56984184ddc5fbf286cec0d07e0a014ff3780b3d4fca36079b474b4efc3e28df.

Sealed plan-manifest.json SHA-256:
64cff67cd7e51a26e1bd8721b2f9cc7845250865f8136de2764b4b76e3533f3b.

Key artifact SHA-256 values:
- pure-checker.mjs: 51f0010d2495f414140140d928c9406d58a3504055e4b9c4dfadb605bf193921.
- runtime-diagnostic.mjs: ed044f487a4466cabcb83fff5ba11919ceccd2990d6af06d8d35160b537c6afa.
- controller.py: 8c73661da39f9a4ad49f0e359702331c0e81ca8847cf62766d97536253878f5c.
- custody.py: b8e97ba3d5df9aa86cb4e8233559f8310a282ac0e39a07ee05b8a1516234c034.
- holder-gate.mjs: bd502c2092d88b4318d2865043eceb74027dbe7334e25edeecf811b8d57687d0.
- run-case.sh: f9602a2a4487eb944e53742f63b5aca2a1f3d4497ddb56b208b7f829caba4948.

I independently checked:
- All 32 SHA256SUMS-listed files; the ZIP has 33 regular-file members including SHA256SUMS, no duplicate names, and exact equality with the supplied proposal directory.
- All 24 manifest artifact hashes.
- All 28 extraction-map byte ranges, lengths and hashes against the complete pinned source.
- Both generated-file lengths/hashes: 35,691 bytes for C and 97,494 bytes for the runtime derivative.
- Exact reconstruction of the runtime derivative from pinned source ranges, the four declared initial substitutions, six import-URL substitutions, the narrowed diagnostic cold loop and the two supplied templates. This was independent text assembly in memory, not execution of generate.py.
- The pure runner's entire declaration prefix against the original ranges, followed only by the inspected 550-byte new entrypoint.
- All four complete source/derivative or launcher/gate diffs against their actual inputs.
- The copied ruling against the supplied dual-runtime readiness ruling.
- The copied accepted launcher, three output baselines and complete source tree against the already-reviewed readiness archive inputs.

The driver and holder were freshly retrieved through the read-only GitHub connector at the exact source commit. Independently computed local Git blob identities equal the connector identities:
- Driver: blob 8ddcd04417d9c4cd62e13f8c59a3b5500a8532c0; 90,091 bytes; SHA-256 fb9559202caa4e4f20b01698392bb77afe7699251ecf5a2d3a51ad546aa227c8.
- Holder: blob 2ca327ce7ff2bc892d2fcdb9aa8155c62a612c2d; 13,331 bytes; SHA-256 bb63d2f95546e607ee3e014604402ea10bd9e087393b2a482adbe340dc4dcef3.

The complete retained source tree has 1,460 entries, 1,329 tracked leaves and 275 dependency leaves. The three original output inventory hashes remain:
- dist: 3fa009419899f6435f1cc7835fb2e0e7802577a21cd7e37b1e358abfcc0f5673, 1,101 entries.
- dist-test: 8c0951c3aeeda82a1cc8c3d00d752cda8018839c0a738cc3d2409e2ee281f6d4, 1,047 entries.
- packages/hud-mcp/dist: 49f24031cda8135c354b0e9418e2fb97e9b7b7cb6fd3e0fd58b31ffc532980a6, 264 entries.

Draft assembly 01 is retained historical preparation, not a command target. Neither its existence nor matching graph hashes substitutes for the previously accepted exact-source build history.

## 2. C: true pure-checker isolation

The extraction includes the original assert/isDeepStrictEqual imports, budget constants and these unchanged declarations: stats, canonicalReplyErrors, nonnegative, timingErrors, validColdTiming, numerical, overrunExempt, numericalGates, lossCoverage, verify, finalizeWaveFailure, summarize and runEvidenceCheckerControls.

Their inspected dependency closure is within those declarations, constants, the two Node builtin imports and ordinary ECMAScript builtins. Math is also used by stats; the README's illustrative builtin list should not be read as exhaustive. No additional project dependency is missing.

There is no fs import/action, original sandbox initialization, fixture, wave, holder, dynamic project import or default benchmark entrypoint in C. Its only new runtime effects are stdout/stderr and failure exit status. It cannot fall through from the controls into the 126-cell experiment.

The ten exact retained outcomes cover primary percentile dilution, recovery dilution, outcome/recovery gates, per-participant loss coverage, canonical replies, zero-delay uncertainty, malformed write/cold timing, read-only timing and both pending-intention shapes. Assertion failure stops the runner nonzero. custody.py additionally requires the exact ordered ten names, executed=true, passed=true, qualification=false and the source pin.

This accepts the extraction, not a claim that any group has run or passed. These fixed arrays are checker controls, never performance samples.

## 3. R, I0, I1 and I2: meaning and limits

### Common derivative boundary

The default benchmark source is unchanged. The derivative retains the original call, prepareCall, wave, failure finalizer, summary, numerical/canonical/coverage predicates and raw/support writer bodies. Original WARMUPS=50, MEASURED=1000, OUTER_MS=3,600,000 and the full 126-cell plan remain visible.

The wrapper replaces the entrypoint and path bindings, explicitly rebinds ownedHelper/prepareCall/call/finalizeWaveFailure, and imports the six actual compiled modules from the pinned existing checkout. It omits the full driver's one-hour timer in favor of the separate bounded controller; checkOuter's original clock/stopped predicate remains. This is an explicit diagnostic scheduling change, not execution of the unchanged default driver or evidence of its full-duration feasibility.

All snapshots use complete=false. Full planned populations remain; populationComplete and every qualification result remain false. Runtime stages do not execute the pure checker bank a second time or mix checker inputs into samples.

### R

R declares exactly:
- One H=1/R=1 fresh-holder first/second cold CLI refusal probe using the original compiled CLI-to-independent-MCP path.
- One H=2/R=10 delegate_status/storage-load wave.
- One H=2/R=10 delegate_spawn/short-lock wave.

It retains actual framed server/stream compositions, the frozen legitimate synthetic fixture, production monotonic clocks, SQLite, original holder dependencies and accepted observation-store APIs. The fresh cold helper and main helper are separate owned instances. There is no benchmark matrix loop, real harness launch or capability success claim.

The wrapper requires real timing validity, the applicable numerical gates, successful/canonical status, a successful spawn participant, observed heartbeat/storage/contending activity and no unexpected failures. Desired overlap can still be missed in one attempt. That is a retained failed diagnostic, not authority to resample until favorable.

At R result review, inspect the actual helper replies and traffic records, lock_acquired/lock_released times and relevant call/SQL intervals. summary.contentionSeen is a useful original aggregate, but its Boolean alone does not attribute a failed BEGIN to the declared five-millisecond holder interval rather than another concurrent writer. Preserve cold refusal and all over-budget facts; this is not positive cold acceptance.

### I0

The wrapper invokes the original prepareCall twice, so both real started records exist, then sets stopped before either original call. Original checkOuter rejects both; original wave failure handling and writers retain both registered intentions.

The intended result is two pending/not-issued rows, invalid timing, no fabricated response/diagnostics/end data, original p065_outer_timeout_incomplete, two wave_failed records, an incomplete cell/report, normal owned cleanup and direct exit 1. It is a test-only stopped-state schedule, not OS signal evidence.

### I1

Participant 0 enters the original async call and genuinely marks/issues its frame before participant 1 is invoked. Its response uses the real bounded framed path. Before changing stopped, the wrapper requires the sibling to be issued and unfinished.

The original wave catch awaits all issuedJobs before failure finalization. Deferred call_settled and failure_finalized records allow this ordering to be checked without synchronous logging in the sibling's timed interval. The expected result retains one real completed issued measurement and one pending intention, the original wave reason and an incomplete report. Hook overhead is diagnostic overhead and is not subtracted.

At result review, match hook IDs to actual started/final rows and verify the timing/dispatch denominators and one real response. A fabricated mixed pair would not satisfy I1.

### I2

The intended positive diagnostic schedule is a real SIGTERM to the already registered direct driver PID while the real fixture and started holder are active, with both primary intentions journaled and both call wrappers waiting before MCP primary dispatch.

The controller sends through the driver's pidfd only after i2_ready, a prior helper_started event and a live registered helper. The original signal listener runs; the additional listener records receipt and releases the diagnostic barrier. Require both controller signal evidence and the original raw interrupted/SIGTERM record.

This can establish only that stated active-helper/before-dispatch schedule. It is not I1 repeated with a real signal, mid-COMMIT termination, arbitrary asynchronous interruption coverage or a force-kill recovery test.

### H1: I2's missing-signal path must fail closed before I2 execution

runtime-entry.template.mjs:36–42 currently sets exitCode=1 on the 15-second missing-signal timeout and then calls releaseSignal(). runtime-hooks.template.mjs:106–112 consequently allows both original calls to run without a real SIGTERM.

Later assertions prevent a false passing I2 result. Nevertheless, the failure branch releases work whose declared prerequisite is actual signal receipt; it continues primary dispatch after the missing-signal failure instead of aborting that barrier.

Minimal correction: give the barrier a rejection/abort path and use it on this timeout, so original wave catch/finally retain pending rows and perform cleanup without issuing either primary. Preserve diagnostic_signal_not_received as the unexpected failure. Do not synthesize SIGTERM, set stopped to manufacture the expected reason, or shorten/change a production clock. Only the real signal listener may release the success path.

Retain this candidate, produce a new separately sealed diagnostic artifact/map/diff/manifest for the correction, and inspect that small delta before I2. No production/repository edit, broad redesign, repeated checker execution, formatter/build rerun or reset of previous accepted baselines is required.

## 4. Ownership, gate and closeout assessment

### What the source establishes

- Preflight verifies all sealed artifacts, pinned Node/Python identities, source leaves, exact commit/tree, status/ignored inputs and original build inventories. The checks do not reset drifted baselines.
- The controller uses subreaper set/readback and initial ECHILD. Its workload direct child waits on an anonymous launch pipe until a pidfd and stable kernel parent/start identity have been recorded.
- Helper slots are predeclared: zero for C, two for R and one per I case. A driver intention precedes nativeFork. The fork wrapper preserves driver-to-helper parentage.
- holder-gate.mjs imports only Node builtins before registration. It sends its ticket/PID through the inherited private pipe and waits for the controller-to-driver-to-IPC release before importing the exact original holder. Paths and argv are restored so the holder's own import.meta.url and dependencies remain original.
- A helper whose parent is lost before release cannot legitimately proceed into project imports. The gate's ten-second timeout is separate from the original holder's 3,650-second timeout.
- Normal helper status comes from the exact parent's ChildProcess exit event, paired with registered pidfd termination. On driver loss the controller reaps adopted children itself. These two status sources must retain their separate labels.
- The controller may enumerate only its own immediate children after initial ECHILD and the sole workload fork. Unknown adopted descendants are failures, not additional allowed helpers. Stable parent/start identity and pidfd acquisition precede controller signalling.
- Failure signalling targets registered pidfds only. There is no numeric-PID signal fallback, kill-by-name, process-group kill, host process scan, tracing, live reparenting or alternate transport/executor.
- An abnormal helper status, unexpected/adopted child, surviving helper after driver exit, forced assistance, timeout, failed ownership primitive or uncertain closure cannot produce a successful controller validation.
- Final passing evidence requires the direct authoritative wait, every expected helper registration/status, terminated pidfds, terminal ECHILD, unchanged custody and validated incomplete/nonqualifying artifacts.

The original driver's ChildProcess close path still sends SIGTERM to its own child and escalates after its original two seconds. The controller's new failure escalation is distinct. Its KILL threshold is measured from the first controller failure, not individually from each late-discovered child's TERM time (controller.py:252); do not describe it as a guaranteed fresh ten-second grace for every later adoption.

### What remains unproved

This is new source, not demonstrated nested shutdown. A declaration/gate handshake alone does not prove orphan discovery, IPC behavior, SQLite release, successful waits or kernel primitive availability. C has no helpers, so C success supplies no nested-process or lock-cleanup pass.

A denial, unobservable descendant, unkillable process or abrupt supervisor loss can leave closure unproved. Outer timeout is only an outer failure bound, never tree-closure evidence. Preserve the survivor/last-known identity and stop; do not perform broad cleanup or an automatic retry.

The read-only custody checker also invokes bounded Git subprocesses before workload launch and after workload closure. They are not helper slots and are outside the gated Node workload interval. Retain outer status and the final postcheck ECHILD. If the outer guard terminates during custody, do not claim that the last successful workload ECHILD proves closure of the later postcheck activity.

The controller does not independently attest exec. Preserve exec_state=no_error_reported and workload_result=exit_status_observed_exec_unverified; pipe EOF is not syscall tracing evidence.

## 5. Historical versus current executor restrictions

A fresh read of exact-source docs/handoff/STATE.md:111 confirms the historical wave-1 executor's missing CONFIG_PROC_CHILDREN, alongside the separately recorded AF_UNIX listen and PTRACE_TRACEME failures. The governing six-design ruling explicitly separates these failures.

The dispatcher identifies this readiness work as running in a new independent cloud environment created from a saved configuration, not the old shared executor. The supplied archive does not bind the old missing-kernel-feature observation to this current environment. **This review therefore does not assert that CONFIG_PROC_CHILDREN is missing here.** Nor does it assert that it is present without an actual result.

For the next C stage, the exact controller-own children read and owned direct-child stat/pidfd steps are admitted only as necessary in-stage preconditions on that current environment. If the initial self-children read is unavailable, preflight returns failure before os.fork and before the checker executes. Preserve not_started and outer receipts. Do not add a separate discovery experiment, retry a denied operation, change the kernel/permissions, scan the host, use tracing or move the workload to another executor.

The historical AF_UNIX-listen/PTRACE_TRACEME prohibitions are not relaxed by this distinction. The candidate does not invoke those operations. Unchanged aggregates that reach them remain held under their governing rulings.

## 6. Exact minimal next admission

After the dispatcher assigns a named quiet window on the same independent cloud environment, deploy/use the unchanged sealed proposal at its declared /workspace/p065-driver-readiness-plan-01 location. Do not regenerate it in either checkout. Admit exactly this one command:

/bin/bash /workspace/p065-driver-readiness-plan-01/run-case.sh node24 C 64cff67cd7e51a26e1bd8721b2f9cc7845250865f8136de2764b4b76e3533f3b

No batch, fallback runtime, R/I stage, syntax command, build, formatter or project test is included.

Pins and bounds:
- Node 24.22.1: /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node.
- Node SHA-256: 61ab14cd750fc24d5db53490ec5fc40f756e4b6e136b78cf7004265471d9bd1d.
- Python: /opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin/python3.
- Python SHA-256: fa67443527ed9647f760d807e2a38f26340757123e643c4639cf273ed15d5ea7.
- Source checkout: /workspace/p065-driver-node24-ready-verify, with the exact source and three original output baselines above.
- Workload 60 seconds, failure grace 10, controller closeout 90, outer timeout 110 plus kill-after 10.
- Expected direct/controller/outer statuses: 0/0/0 only with the required evidence.
- New case evidence: /workspace/p065-driver-readiness-executions-01/node24-C/.
- New outer receipts: /workspace/p065-driver-readiness-outer-01/node24-C/.

Before reporting C passed, review the actual ten names, raw stdout/stderr, command/environment/runtime/source pins, lifecycle events, direct/outer status, final ECHILD, unchanged before/after custody and private-directory inventory. Require no helper or unexpected descendant. Parse the retained JSON/complete JSONL, including the controller stream, and check the result against the artifacts rather than relying on a summary Boolean.

If preflight fails, say C was not run. If C fails or closeout is uncertain, stop dependent stages and retain the exact directory; do not choose a suffix and retry.

After a clean C review, the next eligible stage is separately dispatched Node 24 R, then separately I0 and I1, with I2 only after H1 is corrected and its small delta reviewed. No automatic progression is granted here. Node 22 remains separately admitted after Node 24 evidence review; its exact existing binary pin is unchanged.

## 7. Retained holds

- Source R1 and F1–F5 acceptance, final formatting acceptance and both syntax/build readiness acceptances remain intact at their recorded pins. This ruling neither reruns nor relabels them.
- Runtime mechanism, interruption, instrumentation-overhead and complete performance evidence remain outstanding.
- Keep the full default 126-cell, 50/1,000 populations, three isolated series on each exact supported runtime, all raw/partial/failed attempts and original timing gates. No qualification samples come from C or these diagnostics.
- No full benchmark, dependency install, production/source change, output transplant/baseline reset, real harness, MCP executable/physical registration probe, Herdr/tmux, logged-in CLI, user home, assistant-run local task, B10D dependency or capability promotion is admitted.
- Real-Claude same-call timing, formal WSL/B14, all semantic/metadata/shared-writer/full-check requirements and HYG2/RUNZ1/S3F blockers remain separate.
- P065 package acceptance, complete green checks on the actual merged tree and integration remain HOLD. No merge, source publication or remediation-counter reset follows.

## Sources and method

- [Exact source](https://github.com/CartmanFatass/codex-hud/commit/8f67f7e2d8249295e5a84af0bb9b98817a30459c)
- [Driver](https://github.com/CartmanFatass/codex-hud/blob/8f67f7e2d8249295e5a84af0bb9b98817a30459c/tests/int/p065-budget-benchmark.mjs)
- [Holder](https://github.com/CartmanFatass/codex-hud/blob/8f67f7e2d8249295e5a84af0bb9b98817a30459c/tests/int/p065-ledger-holder.mjs)
- [Pinned status and historical executor limitation](https://github.com/CartmanFatass/codex-hud/blob/8f67f7e2d8249295e5a84af0bb9b98817a30459c/docs/handoff/STATE.md#L104-L119)
- [Governing scheduling release](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/p065-budget-release.md)
- [Governing six-design ruling](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/p065-six-design-dispositions.md)
- Exact proposal and preceding source/R1/format/readiness rulings identified above.

Method: read-only connector retrieval and source inspection; independent offline byte/hash/map/diff/archive comparisons and in-memory text reconstruction. No supplied Python or JavaScript program was executed or imported. No Node syntax check, compiler, formatter, checker bank, project test, driver, holder, signal exercise, process/capability probe or denied operation was run. No repository, existing artifact, access setting or external state was changed. The new local deliverable is this requested ruling.

