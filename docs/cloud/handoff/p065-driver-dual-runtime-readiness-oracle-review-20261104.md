# P065 driver: independent dual-runtime readiness review

Date: 2026-11-04 UTC. Repository: CartmanFatass/codex-hud. This review is limited to the supplied syntax/build readiness evidence and the next driver-validation boundary.

## Verdict

**ACCEPT the exact-tree Node 24 and Node 22 syntax/build readiness stages. No new required source correction, formatting rerun or build rerun is requested.**

Both driver files parsed on both pinned runtimes. All three required TypeScript build expansions completed in fresh, separate runtime checkouts, with source/dependency custody, authoritative direct status, terminal ECHILD and unchanged input/output postchecks. The generated graphs now have a supported exact-source build history.

**Do not yet run the full benchmark or describe the driver as runtime/interruption ready.** No driver/holder invocation, embedded checker-control execution, real framed workload, cold CLI probe, signal interruption or performance series is present in these archives. R1 and F1–F5 remain closed at source-review level, not at all runtime-evidence levels. Package acceptance, full-check acceptance and merge remain HOLD.

The next concrete assignment is source-only preparation of a small, explicitly nonqualifying readiness harness and its owned-process supervision plan, as specified in section 6. This avoids running the full benchmark merely to reach its embedded checks. It does not require changing production, the frozen fixture, the default benchmark, or its population constants.

## 1. Source and governing decisions

- Source commit: `8f67f7e2d8249295e5a84af0bb9b98817a30459c`.
- Source tree: `3e30a63f21d2c50389444dff65f2c47d1c3af3c4`.
- Sole parent: `4a484053473524b33184dc2cffc3dabd4bd63158`.
- A fresh branch-ref read still points `refs/heads/dots/p065-budget` to this source.
- The independently fetched recursive tree is complete, not truncated: 1,460 entries, with 1,329 tracked leaves, including 275 tracked dependency entries.
- Benchmark blob: `8ddcd04417d9c4cd62e13f8c59a3b5500a8532c0`, 90,091 bytes, SHA-256 `fb9559202caa4e4f20b01698392bb77afe7699251ecf5a2d3a51ad546aa227c8`.
- Holder blob: `2ca327ce7ff2bc892d2fcdb9aa8155c62a612c2d`, 13,331 bytes, SHA-256 `bb63d2f95546e607ee3e014604402ea10bd9e087393b2a482adbe340dc4dcef3`.

I independently recomputed the Git blob identities of the complete reviewed driver/holder bytes. I read the prior source rejection, F1–F5 correction/R1 finding, R1 re-check, final formatting ruling, the P065 brief, scheduling release and six-design disposition. The prior final formatting ruling remains the authority for the exact mechanical two-file delta. This review does not repeat or widen that change.

The candidate contains historical brief text; the later scheduling/design rulings were read at their recorded governing integration pins, not assumed to be new files in this candidate tree. Their original clock, forced-control composition, synthetic qualification limits and denied-operation boundaries remain binding. Neither this review nor the readiness runs silently import a documentary or source descendant.

## 2. Evidence custody

Cloud thread: `01a1a3c0-8454-762a-a04c-d71a10b710c9`.

| Runtime | Recorded cloud turn | Archive | Bytes | Library ID |
|---|---|---|---:|---|
| Node 24 | `01a1a58d-17f2-7560-9d2e-acbec096e2e9` | `p065-driver-node24-ready-01-evidence.zip` | 1,813,483 | `libfile_c6d7fde148c081919691fc906b9cec20` |
| Node 22 | `01a1a590-a91c-73e7-af87-332f397c1209` | `p065-driver-node22-ready-01-evidence.zip` | 1,812,665 | `libfile_cbfe20aed2848191b21a4b3edb27d1c9` |

Independently computed complete-archive SHA-256 values:

- Node 24: `bcdac3d53986c8a6ebacba3522f688248180b4a6ddf91dc4e83c4e6069258589`.
- Node 22: `c01ffc389c358af5ea22ab26901df69934683abb0e1ee093135a236a12b1e615`.

Every listed member matches SHA256SUMS. Node 24 has 77 listed members plus SHA256SUMS; Node 22 has 76 plus SHA256SUMS. There are no unlisted payload members. The one-member difference is Node 24's additional `stage-1-before.status` receipt, not missing Node 22 source/status evidence. All ten actual before/after record pairs and raw stage streams are present.

I read the cloud completion and dispatch records. Each window explicitly authorized only two syntax checks followed by three direct compiler expansions, with a new checkout and fresh outputs. Node 22 was separately admitted after Node 24; neither record authorizes driver execution by implication.

## 3. Recorded commands, identities and outcomes

The exact Node executables are:

- Node 24.22.1: `/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node`, SHA-256 `61ab14cd750fc24d5db53490ec5fc40f756e4b6e136b78cf7004265471d9bd1d`.
- Node 22.23.4: `/workspace/p065-official-tools-01/node-22.23.4/bin/node`, SHA-256 `94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90`.

These are the previously admitted runtime pins; every current stage verifies the matching executable hash before and after. Build-local compile-cache directory names corroborate the two recorded versions. This review did not execute another version probe or inspect the remote executable live.

The compiler is the unchanged tracked TypeScript 5.9.3. I independently fetched package.json, all three tsconfigs and the TypeScript package metadata, and matched their source bytes/identities against the tree and recorded inputs. The following direct compiler commands are exact expansions of the three unchanged package scripts. The npm wrappers themselves were not run.

| Stage | Arguments after the pinned Node executable | Node 24 outer duration | Node 22 outer duration | Direct / outer status |
|---|---|---:|---:|---|
| 1 | `--check tests/int/p065-budget-benchmark.mjs` | 0.392 s | 0.400 s | 0 / 0, both |
| 2 | `--check tests/int/p065-ledger-holder.mjs` | 0.390 s | 0.431 s | 0 / 0, both |
| 3 | `./node_modules/typescript/bin/tsc` | 6.639 s | 7.448 s | 0 / 0, both |
| 4 | `./node_modules/typescript/bin/tsc -p tsconfig.test.json` | 11.132 s | 13.184 s | 0 / 0, both |
| 5 | `./node_modules/typescript/bin/tsc -p packages/hud-mcp/tsconfig.json` | 3.556 s | 3.967 s | 0 / 0, both |

Node 24 actual outer workloads span 07:55:41.796852–07:56:24.468762 UTC. Its final independent postcheck ends 07:56:24.797253 UTC. Node 22 outer workloads span 07:58:53.813065–07:59:41.291373 UTC; its final independent postcheck ends 07:59:41.618956 UTC. Each window is sequential. These are build/readiness intervals, not response latency or whole-host quietness measurements.

All ten inner stdout and stderr streams are empty and match the recorded empty-stream SHA-256. All outer statuses are zero and outer stderr is empty. The declared inner environments contain only stage-private HOME, HUD_HOME, TMPDIR, PATH=/usr/bin:/bin, LANG=C.UTF-8 and TZ=UTC. No inherited harness, credential, NODE_OPTIONS, tracing or color setting is supplied to the workloads.

### Lifecycle

Every stage records initial ECHILD, successful subreaper readback 1, gated creation of the direct child, an available pidfd, release, exec-error-pipe EOF without a reported error, exactly one authoritative direct wait status 0, terminal ECHILD, final pipe EOF, matching identity postcheck and a successful result. All ten retain:

- closure=true, lifecycle_valid=true, postcheck_ok=true;
- unexpected_descendant=false;
- failure=null, interrupted=null, post_error=null;
- `compiler_result=exit_status_observed_exec_unverified`;
- `exec_state=no_error_reported`.

Preserve those last two labels. Pipe EOF is not independent exec-syscall attestation. The inherited field name compiler also does not turn the first two syntax stages into compiler execution.

I read the complete launchers and independently reproduced all ten archived launcher diffs against their actual declared baselines: Node 24 stages 1–3 derive from the previously accepted production-build launcher, stages 4/5 from the accepted test/MCP build launchers, and each Node 22 launcher from its corresponding Node 24 readiness launcher. Changes are the declared paths, runtime/source/manifest pins, argv and corresponding output roots. The accepted lifecycle machinery is retained. The earlier accepted launcher chain is documented in the Node 22 positive review; it is not inferred solely from a new filename.

Workload limits remain 180 seconds, TERM grace 10, closeout 210, outer 230 with kill-after 10. Independent before/after checks use their 60-second bound. No signal, timeout, failed cleanup or unexpected adopted descendant occurred in these ten executions.

## 4. Source and generated-output custody

All 20 independent input inventories contain exactly the same 1,329 tracked leaves. Every recorded actual and expected Git blob matches the fresh complete remote tree; all SHA-256 input inventories are equal across stages and across both runtime checkouts. All 275 dependency entries are included. Empty status and ignored-input lists are retained throughout. The independent checker verifies tracked file type/executable mode, not only the selected manifest's smaller file list.

All three generated roots are explicitly absent before syntax checks and before the first build. Each output appears only at its corresponding build stage. Every previously built graph remains equal to its original post-build baseline before and after later stages.

| Output | Total entries | Regular files | Directories | Baseline inventory SHA-256, identical on both runtimes |
|---|---:|---:|---:|---|
| dist | 1,101 | 1,077 | 24 | `3fa009419899f6435f1cc7835fb2e0e7802577a21cd7e37b1e358abfcc0f5673` |
| dist-test | 1,047 | 1,007 | 40 | `8c0951c3aeeda82a1cc8c3d00d752cda8018839c0a738cc3d2409e2ee281f6d4` |
| packages/hud-mcp/dist | 264 | 241 | 23 | `49f24031cda8135c354b0e9418e2fb97e9b7b7cb6fd3e0fd58b31ffc532980a6` |

The complete output inventories, including paths, types, modes, regular-file sizes and hashes, are byte-identical across the two runtime archives. There are no symlinks or unexpected file types in the recorded outputs. The independent checker explicitly rejects traversal errors, distinguishes absent roots from empty ones, and asserts the correct stage-local roots. This closes the earlier inventory-schema weakness for these new runs; it does not rewrite earlier records.

All stage HOME/HUD_HOME roots are present and empty. Syntax-stage TMPDIR roots are empty. Each build TMPDIR contains only its separately inventoried private Node compile-cache directory and one file. That is not fixture residue and is not described as an empty TMPDIR.

This is evidence of fresh compilation from the named source plus recorded output custody, not an argument from matching output hashes alone. The ZIPs contain inventories and logs, not complete copies of every emitted graph. Before consuming live cloud outputs in a new window, compare those outputs to these original baselines again. Do not reset a drifted baseline or transplant an older graph. Rebuild only if a verified change/loss makes that necessary under a new admission.

## 5. What is still unproved

1. Node `--check` parses without evaluating either module. It does not establish node:sqlite availability, transitive import execution, fixture construction, IPC readiness, framed responses or holder cleanup.
2. The benchmark entrypoint has no checker-only or smoke mode. It creates private state at lines 97–115, invokes all ten pure checker groups at 1964, then continues through identity gathering, compiled imports at 2057–2062, two cold fixtures at 2064–2122 and the full matrix at 2125 onward. Importing it is not a harmless import check. Deliberately hiding compiled outputs to make it fail after its controls is not a valid readiness strategy.
3. The existing build supervisor signals only its direct child. It can reap adopted descendants and flags them unexpected, but it has no general bounded mechanism for identifying and terminating an orphaned live helper after an abnormal driver exit. The driver's holder has normal/disconnect/signal cleanup, but its final self-timeout is 3,650 seconds. These positive compiler runs do not validate the nested process failure cases needed for a much shorter readiness window. Do not change parentage, use kill-by-name, add tracing, or assume outer timeout proves tree closure.
4. R1's pure source control covers the mixed issued/pending H=2 shape and the two-pending before-first-dispatch shape. It does not itself prove real raw JSONL writes, cell snapshots, a settling in-flight sibling, or real signal handling. The precise behaviors needing evidence remain prepareCall 895–930, call 931–974, finalizeWaveFailure 982–995, wave catch/finally 1344–1377 and incomplete-cell reporting in the entrypoint.
5. No instrumentation-overhead study, physical fault/recovery bank or complete performance series is supplied. The unchanged default remains 126 cells, 50 warmups and 1,000 measured primaries per cell: 132,300 primaries plus additive recoveries, with 99,225 main fixture waves plus two cold fixtures. Feasibility inside 3,600 seconds remains unproved.

## 6. Exact next minimal path

### Immediate next dispatch: prepare, do not execute

Assign the existing implementation worker one source-only artifact task in a new evidence directory, for example `/workspace/p065-driver-readiness-plan-01/`. Keep the two accepted checkouts, repository files and generated outputs unchanged. Deliver:

1. A deterministic generator and a standalone **pure-checker runner**, assembled from exact current-source declaration bytes. Include assert/isDeepStrictEqual and the required constants plus stats, canonicalReplyErrors, nonnegative, timingErrors, validColdTiming, numerical, overrunExempt, numericalGates, lossCoverage, verify, finalizeWaveFailure, summarize and runEvidenceCheckerControls. Verify the dependency closure explicitly. Do not include the driver's top-level sandbox/entrypoint, dynamic project imports, wave, holder launch or filesystem actions. The runner must return all ten named checker outcomes and fail on any assertion. Keep the original function bodies unchanged; retain the source SHA, byte-range/declaration map, extracted-byte hashes, generated-file hash and complete generator source. A manually reimplemented checker is not equivalent evidence.
2. A separately labeled **runtime/interruption diagnostic runner** that consumes the existing exact built graphs and original holder, with an explicit small case list rather than calling the benchmark entrypoint. Preserve the actual call/wave/failure/summarization/writer bodies; record every wrapper or test-only scheduling hook. Path bindings and entrypoint replacement must be visible. Never relabel this derivative runner as an execution of the unchanged default benchmark. Do not change WARMUPS, MEASURED, OUTER_MS, production clocks, the planned matrix or acceptance predicates to create a passing reduced series.
3. The complete launcher/controller source, diffs and ownership protocol for the diagnostic runner. Show how every child is registered before it can do work, what happens on direct-child loss, how held SQLite state is released, and how direct/helper waits and final ECHILD are established within the chosen closeout bound. If the available accepted facilities cannot establish that, stop with the exact missing primitive. Do not attempt a capability probe or an unsafe workaround.
4. A manifest naming both exact runtime executables, this commit/tree, all three existing output baselines, the exact proposed commands, per-stage limits, expected success/failure status, output paths and stop rules. No installs, source edits, tests, holder or driver execution during this preparation assignment.

Return those artifacts for a fresh narrow source/admission review. This is the immediately executable work instruction; it does not require a new owner decision or start a new source-remediation round. This review supplies design boundaries, not a quiet compute lease or permission to execute an as-yet-unseen harness.

### Then, only after reviewed harness and named quiet admission

Execute one stage at a time on Node 24, review its evidence, then separately admit Node 22. Revalidate the original source, tools and output baselines before each dependent use. A minimal case inventory is:

- **C, pure checker:** Execute the exact extracted ten groups once. Suggested bound: workload 60 seconds, TERM grace 10, closeout 90, outer 110 plus kill-after 10. Require the actual ten names, executed/passed=true, nonzero failure on any assertion, raw output and valid closeout. These fixed adversarial arrays are checker controls, never timing samples. A partial list or exception is failure.
- **R, runtime mechanisms:** Import the six actual compiled modules named at driver lines 2057–2062 and the holder's actual dependencies. Exercise one legitimate H=2/R=10 storage-load status wave and one legitimate H=2/R=10 short-lock spawn wave, using the existing fixture, actual framed service/server, real SQLite, production clock and the original owned holder. Retain helper ready/configure/start/hold/stop/close replies, actual heartbeat/observation/lock evidence, both participants, numerical truth, canonical results and resource closeout. Add only the H=1/R=1 fresh-process cold CLI first/second refusal probe needed to establish production-to-independent-MCP lazy-import readiness. It remains a refusal/readiness probe, not positive cold acceptance. Proposed bounded stage: 180/10/210 seconds, outer 230 plus 10. A missed desired overlap or unexpected outcome is reported, not repeatedly sampled until favorable.
- **I0, before first dispatch:** One H=2/R=10 diagnostic wave, with an explicit test-only schedule that sets the driver's stopped state after both original prepareCall journals and before either original call issues. Preserve both intentions, actual raw writer and real fixture cleanup. Require two pending/not-issued rows, two invalid timings, zero invented response/transaction samples, original interruption reason, wave_failed records and an incomplete cell/report without a secondary exception.
- **I1, sibling already issued:** One H=2/R=10 diagnostic wave with participant 0 genuinely issued and still awaiting its bounded response when participant 1 meets the original outer-stop check. Require both registered rows, observed issuance versus pending truth, settled sibling before failure logging, retained real timing, original wave error, incomplete cell/report and complete cleanup. The scheduling hook must be explicit and inspected; a fabricated row pair alone does not satisfy this case. Do not patch a production clock or wait an hour merely to hit the default series deadline.
- **I2, real termination:** A separately controlled SIGTERM to the one known owned diagnostic-driver PID while a real wave/helper is active, exercising the original signal-handler behavior and real cleanup. Preserve the actual signal receipt, partial artifacts and final child statuses. Test-only stopped-state controls I0/I1 cannot be mislabeled as operating-system signal evidence. This case need not repeat either deterministic R1 schedule, but its observed schedule must be stated honestly.

For each I case, propose 180/10/210 seconds and outer 230 plus 10, subject to the reviewed owned-descendant plan. Record the diagnostic's expected incomplete/nonzero outcome separately from whether the controller validated that expected behavior. The compiler supervisor's existing success-only lifecycle Boolean cannot simply be relabeled true for an interruption.

The runtime diagnostic may aggregate its small mechanism checks within one clearly declared stage, but I0, I1 and real-signal evidence need distinct retained case records. A checker-only pass does not release them automatically. Exact code, wrapper semantics and the final commands must be approved in the narrow harness review before execution; the illustrative directory name is not an invented existing artifact.

### Required artifact checks before leaving readiness

- Parse every JSON and every complete JSONL record. Match each registered call ID to its started record and final disposition. Preserve interrupted partial records rather than dropping them.
- Preserve the predeclared full planned population and mark the diagnostic incomplete/nonqualifying. No checker-control inputs or diagnostic calls may enter a qualification series.
- Confirm never-issued rows have no response duration, diagnostics or fabricated end timestamp; actual issued rows retain their real measurements. Require dispatch/population/timing denominators to agree.
- Require the affected incomplete cell snapshot, original failure reason and no masking TypeError. Preserve the difference between an expected injected stop and a real storage/cleanup failure.
- Require unchanged input/output graphs and final owned-resource closure. Keep all failed/partial attempts. A refusal, timeout, unexplained drift, denial or uncertain cleanup stops dependent stages; no automatic retry is released.

These stages establish a useful next boundary without pretending that a handful of waves is the 50/1,000 matrix. They do not establish the default driver's full-duration feasibility. Only after their reviewed results and instrumentation-overhead disclosure should a separate decision admit the unchanged 3,600-second full series.

## 7. Retained holds and exclusions

- No permission to retry AF_UNIX `listen` or `PTRACE_TRACEME`. Preserve the exact HYG2/RUNZ1 logs and separate S3F/full-check blockers. No wildcard aggregate that reaches those known operations, transport/tracing substitution, privilege change or alternate executor to evade a block.
- No MCP executable startup/physical registration probe, real harness, Herdr/tmux, user home, logged-in CLI, local desktop task or capability promotion. Import service modules only as reviewed; do not substitute side-effecting `main`/MCP binary startup.
- All fourteen semantic cases, eleven metadata precisions, existing regressions and behavioral controls remain separate requirements. These readiness results are not new evidence that those suites ran on this tree.
- Every operational over-budget sample still fails its applicable bound. Forced exceptions remain limited to evidenced declared 40 ms callback/COMMIT injections; zero-delay uncertainty remains operational. No loss of primary/per-outcome gates, canonical reply checks or successful-loss coverage.
- Three complete isolated series on each exact supported runtime, all raw attempts, real-Claude same-call timing, formal WSL/B14 and real capability requirements remain as originally scoped. No cloud surrogate converts an unrun local-only requirement into a pass.
- Final independent Oracle acceptance and the complete green check set on the actual merged tree remain required before integration. Do not merge, push a new source change, alter status to accepted, or reset remediation counters on the strength of this narrow verdict.

## Sources and method

- [Exact source commit](https://github.com/CartmanFatass/codex-hud/commit/8f67f7e2d8249295e5a84af0bb9b98817a30459c)
- [Benchmark source](https://github.com/CartmanFatass/codex-hud/blob/8f67f7e2d8249295e5a84af0bb9b98817a30459c/tests/int/p065-budget-benchmark.mjs)
- [Holder source](https://github.com/CartmanFatass/codex-hud/blob/8f67f7e2d8249295e5a84af0bb9b98817a30459c/tests/int/p065-ledger-holder.mjs)
- [Pinned candidate brief](https://github.com/CartmanFatass/codex-hud/blob/8f67f7e2d8249295e5a84af0bb9b98817a30459c/docs/cloud/P065-BUDGET.md)
- [Governing scheduling release](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/p065-budget-release.md)
- [Governing six-design ruling](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/p065-six-design-dispositions.md)

Method: read-only connector retrieval, prior ruling and source inspection, archive materialization, offline hash/manifest/diff/JSON verification. No project code, syntax command, compiler, formatter, test, benchmark, holder, capability probe or denied operation was executed by this review. No repository or external state was modified. New local files are the requested review and its fetched/derived inspection artifacts only. A machine-readable inspection summary is retained beside the downloaded archives in `p065-driver-readiness-inputs/independent-evidence-audit.json`.
