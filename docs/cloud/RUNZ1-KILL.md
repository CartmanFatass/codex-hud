# RUNZ1-KILL: evidence-sensitive cancellation diagnosis and test-only release

Date: 2026-11-03. Fresh read-only design and scheduling consultation.

## Decision

**Release exactly one bounded RUNZ1-KILL test-only diagnostic/correction submission and one fresh final Oracle review. Preserve production unchanged. Replace the inference “no receipt implies slot held” only with proof-sensitive assertions that independently cover both incomplete proof and legitimate complete receiptless Q.**

**Execution remains HOLD pending explicit resource admission.** NEXT retains its active cloud compute/measurement lease, including its outstanding reserved dispatcher measurements unless explicitly rescheduled. No RUNZ1-KILL branch/worktree materialization, edits, builds, test processes or diagnostic load starts merely because its files are disjoint. The dispatcher can record the ruling and reserve the named files now, and read-only preparation can proceed. When the current lease is explicitly returned, the dispatcher allocates bounded, non-overlapping windows among NEXT verification, P065, MCP-ANCESTOR and this package. P065 owns its reserved files, not an uninterrupted executor monopoly until acceptance. This package does not need P065 or MCP-ANCESTOR acceptance to perform independent testing and must not import their unaccepted code.

**RUNZ1 remains FIX REQUIRED / WIP / NOT ACCEPTED / NOT MERGEABLE.** The historical Node 24 failure remains an actual failure whose precise cause is unproved. This release is neither a known-flake exception nor an accept verdict. It does not waive the ancestor EACCES failure, Node 22 envproxy failures, complete candidate checks or the separate merged-tree gate.

## 1. Inspected identities and evidence

- Owner evidence: local-verification/20261103 commit **9be7246c25b5355845e639116c57150ff79d3117**, under docs/cloud/handoff/local-verification/20261103/.
- Tested RUNZ1 source: **86ca8887fcfb331750ec6dc5518d69134cb795e4**, tree **da3e386e3512736f3078d0fd9c7b85a868f83f6d**.
- Current RUNZ1 head independently retrieved during this consultation: **37cf7bef3075ffa312c36b8f78102f6c4bd4de67**, tree **5599ac1595a069215850750609f7f64371d1b6f9**. The complete comparison against 86ca888 contains one commit adding only docs/cloud/handoff/runz1-local-review-20261103.md. Production, tests and benchmark are unchanged.
- Current governing universal-hud snapshot inspected: **33781271a648f271a5913517449b2a4ee6418abc**, including the newly archived P065 scheduling release and MCP ancestor ruling. This governing documentary snapshot is not the RUNZ1 source base.

Read the complete local-evidence Oracle report, the owner REPORT, relevant raw RUNZ1 focused/full logs, the previous RUNZ1 review and scope/ESRCH/WIP rulings, RUNZ1 brief, workflow/check policy, STATE and queue, NEXT and P065 ownership/resource dispositions, contracts 02/03/04, and the affected control, process, reconciliation, fake-port and real-process test code. In particular, inspected the actual native-group and group-helper fixture implementations, not merely their test names.

The Node 24 focused command ran 15:57:06–15:57:26 UTC on Node 24.22.1 and failed the assertion at compiled run-control.test.js:360, source tests/unit/run-control.test.ts:374. It had 53 passes and one failure. The preceding signal-order and native-null assertions were reached without failure. The raw record contains neither the final snapshot/facts nor the reconciliation decision. It predates the owner's 16:00 proxy-variable change.

The same KILL case passed in the other five retained full/focused RUNZ1 runs. I inspected those specific passing log entries. Preserve all six outcomes. Neither five passes nor a new passing rerun identifies the missing historical facts. The local review's 66-file hash audit is that review's finding; this consultation did not independently repeat that complete audit.

## 2. What is established, and what is not

The assertion at run-control.test.ts:374 is too broad as a statement of the contract:

`if (!p.receipt) assert.equal(p.slotHeld, true)`

Contract 02 defines Q without a formal receipt and permits terminal release under R-02-2/3 when the complete, correctly bound proof is valid and no conflict exists. Contract 04 ScopeCheck, I-04-5 and T-04-24 require the fixed scope, correct identity/domain, original-harness termination, complete absence of live workload, and sealed/dead launchers; none requires an exit.json. Unknown native status is independent of terminality. A cancellation is classified cancelled only with accepted before_exit chronology; otherwise complete proof may yield ended, with cancel_timing_unknown when appropriate.

The inspected code has a concrete route to a legitimate no-receipt release:

1. control.ts:735–740 records command.exited.
2. The final-receipt path at 743–832 attempts proveGroupGone. If that attempt refuses, no final receipt is written.
3. Line 833 nevertheless invokes reconcile.
4. observe at 196–224 makes a fresh proof attempt. If that later attempt succeeds, it supplies complete scope and scope_reconciled evidence with nativeExit:null.
5. execution.ts:50–72 and 265–281 bind and classify the evidence; MemoryRunFactPort.reconcile at 246–285 applies the decision, releases the slot and records run.reconciled.

A conservative refusal at the first attempt and a later complete proof are compatible. This is a source-supported explanation to investigate, not a reconstruction of the 15:57 run. The actual first refusal might concern a still-live subject, visibility/read ambiguity, census churn, or another prerequisite. The old log cannot distinguish these. Do not select one cause from plausibility or elapsed duration.

The fixture also matters: tests/run/group-helper.ts:99–110 signals its own verified group. SIGKILL can kill the helper before its acknowledgement/native-wait message is delivered. tests/run/native-group.ts:63–68 then returns native_unknown after helper exit and IPC closure. Keeping native result null is therefore required; inferring 137 or SIGKILL as the harness's native result is not a correction.

No unsafe production release is established by the old log alone. Conversely, source plausibility and Q's mere existence do not establish that the failed release was safe. A final slotHeld=false must be justified by the actual accepted complete terminal evidence at the releasing transition, not by a later probe or a nominal Q label.

## 3. Selected diagnostic mechanism

Use test-owned observation at the existing RunFactPort and groupLauncher composition seams. No production seam or instrumentation is needed for the first investigation.

In the new test fixture, wrap/decorate the MemoryRunFactPort used by the exact KILL test and, where useful, the existing launchNodeGroup result. Pass through the original arguments and return values, invoke each original operation exactly once, and never add an observation to the real evidence stream merely for diagnostics. Preserve all signal delivery and wait semantics. Capture bounded immutable diagnostic records for:

- register, startup and launch phases, with the synthetic run/source/generation and full original supervisor/harness/helper/command/scope identity relationships;
- group exit source, subject, code/signal and time; signal requests and actual acknowledgements;
- command.exited, cancel.accepted, cancel.step, cancel.unconfirmed and submission.fenced events;
- each reconcile call's input revision, actual observation objects and fact times, existing relevant facts, returned decision or null CAS result, and before/after state and slot ownership;
- decision row, releaseSlot, evidenceIds/auditEvidenceIds, cause and terminalNote; run exitCode/exitSignal/exitSource, endedAt, terminalEvidenceId, claim state and the terminal transition count;
- whether receipt() was called, the resulting receipt and the presence/content of exit.json, plus the final snapshot captured before cleanup.

Capture the exact transition that first releases the slot, not just the final state. Retain startup metadata and binding checks needed to decide whether its Q belonged to this run. Do not regard every scope_reconciled object as authoritative: wrong run/source/generation/supervisor, rejected validation, invalid fact time, incomplete prerequisites or unresolved counter-evidence must not justify release.

The port input from observe exposes the later proof's scope.complete/Q result. The earlier final-receipt result can be inferred only when the captured command.exited → subsequent reconcile control path, known non-null meta scope/harness, absence of receipt call/artifact and successful continuation actually establish that branch. Label this as a control-path inference, not a directly logged boolean or a low-level rejection reason. If exact internal rejection diagnostics become necessary, return the evidence and a new narrowly specified proposal to an Oracle; this release does not authorize editing control.ts or process.ts.

Do not run additional /proc scans, delays, retries or reconciliation calls between the original critical steps merely to obtain a favorable branch. Buffer bounded records and serialize them after the observation/assertion boundary, before cleanup. A wrapper can still perturb scheduling; disclose that instrumented runs are new evidence, not a timing-equivalent replay of the old run. A later process snapshot is supplementary and cannot authenticate an earlier release.

Use an explicit safe projection for published diagnostics. Do not dump the whole seed, credentials, tickets, launch environments, real-home paths, unrelated process arguments or contents. Preserve all necessary identity equality and chronology in synthetic/redacted records, and retain the original-to-published redaction method and hashes. Diagnostic recording failures fail or mark the evidence incomplete; they must not disappear inside a broad catch.

## 4. Permitted test correction

Keep the existing real KILL scenario and its exact INT → TERM → KILL ordering assertion. Keep the native-null assertion and strengthen it to cover the resulting run's exit fields. Do not shorten the fixed TERM grace, alter launch/control topology, add a skip, increase timing allowances to hide the failure, or treat a false KILL acknowledgement as positive wait evidence.

Replace only the no-receipt slot inference with an explicit evidence-sensitive check over the captured transition and final snapshot:

1. **No complete R/Q:** the run remains nonterminal, the slot remains held, no terminal run.reconciled transition or fabricated exit receipt appears, and no accepted complete Q is invented from partial scope facts. A live original harness/member/launcher or unknown proof is not termination.
2. **Complete receiptless Q:** require actual accepted, correctly bound and validly timed complete scope_reconciled evidence, all termination/sealing prerequisites, no unresolved conflicting evidence, and a corresponding R-02-2 or R-02-3 releasing decision. Require no receipt/file, native exitCode/exitSignal/exitSource all null, coherent terminal state/claim/slot, and the correct cancellation chronology classification. Do not simply accept either slot value or check only that one Q-shaped object exists.
3. **Final receipt path:** retain receipt validation, native-result provenance and the corresponding evidence/slot-state assertions. The target lost-wait scenario must not gain an invented exact native result merely because a receipt exists.

The test oracle must state these predicates explicitly rather than using the same reconcileRun call as the sole source of its expected answer. Recording terminalEvidenceId is required, but the MemoryRunFactPort's generic first-evidence assignment must not be mistaken for proof that that identifier alone names the Q. Inspect the actual supporting evidence and decision references. An independently discovered fake-port/production adapter defect is reported rather than silently repaired outside this whitelist.

A correction supported by newly demonstrated legitimate Q can establish that the old assertion was unsound. It cannot retroactively declare that the historical failing snapshot had Q. Retain that distinction in the implementation and final review reports.

## 5. Required regression and negative-control evidence

The bounded submission must supply all of the following:

- The unchanged real KILL ladder, observed at the port boundary, preserving unknown native result and checking the appropriate evidence branch.
- A controlled real-process incomplete-proof case through unmodified HeadlessRunControl: a positively identified live original subject/member or otherwise deliberately unavailable complete proof must produce no R/Q terminal release and must retain the slot.
- A controlled real-process receiptless-Q positive through unmodified HeadlessRunControl.reconcile: preserve the same fixed identities and submission sealing, establish actual termination/complete proof, obtain no receipt, and verify terminal release with null native result. Pair it with the preceding negative phase when practical. Existing RUNZ1 real fixtures and APIs may be reused read-only; do not manufacture success by returning true from a mocked proof or by injecting a trusted Q into the real integration.
- Deterministic table-level guards in the new test file for no-completion evidence; complete Q with before_exit; complete Q with absent/unknown chronology; incomplete harness/sealing/coverage; wrong run/source/generation/supervisor; invalid fact time; and conflicting live/cancellation evidence. These may construct clearly labeled synthetic facts and exercise the existing reconciliation code. They supplement, not replace, the real-process proof cases.
- Idempotence: an explicitly requested subsequent reconciliation after established Q does not launch another workload, write a dead writer's receipt, release twice or rewrite the terminal classification.
- A meaningful legacy-assertion negative control: apply the old no-receipt/slot-held predicate to an actual captured legitimate Q result and show its assertion failure. This proves the test-policy defect without pretending that a missing import/compiler error is a behavioral failure.
- Safety-oracle negative controls: independently remove the supporting Q, mark a prerequisite false, or mismatch its binding in cloned test data while retaining an alleged released result. The new assertion must reject those forged/incomplete descriptions. Label these as tests of the assertion, not execution of a production release defect.

Use event/fixture barriers for controlled process transitions, with explicit finite deadlines. Do not replace correctness with an arbitrary sleep followed by optimistic inference. Failure to establish the positive or negative premise is a failed/incomplete test, not a skip or a pass. No new production polling or retry loop is authorized. Existing RUNZ1 race/thread/visibility/ESRCH guards remain unchanged and must continue to pass where executable.

If a genuine trace shows release with insufficient/incorrectly bound proof, stop the test-only correction at that finding and return it immediately. Do not normalize unsafe behavior by expanding the allowed assertion branches. A production repair would need a separate Oracle design/ownership disposition.

## 6. Exact ownership and lineage

New branch reservation: **dots/runz1-kill**. New dedicated cloud worktree reservation: **/workspace/shared/runz1-kill**. Materialize only after resource admission and verifying the names are unoccupied or deliberately assigned. Base exactly **37cf7bef3075ffa312c36b8f78102f6c4bd4de67**. This is a reviewable continuation of RUNZ1 WIP, not an accepted integration base for independent packages. Preserve dots/runz1 and the owner's tested 86ca888 target unchanged.

Only these source-controlled test paths are released:

- **tests/unit/run-control.test.ts**: the target KILL test's diagnostic plumbing and narrowly specified assertion correction, plus necessary imports. Other tests/assertions remain unchanged.
- **tests/unit/run-control-kill-evidence.test.ts**: new deterministic evidence guards and controlled real-process receiptless-Q/incomplete-proof coverage.
- **tests/unit/run-control-kill-fixture.ts**: new test-only capture/assertion/controlled-fixture helpers, only if needed. It must have no top-level process side effects merely from being imported.

No src/** production edits, including fake-port.ts, control.ts, process.ts, process-census.ts or execution.ts. No existing tests/run helpers, shared fixtures, other RUNZ1 tests/benchmarks, package/lock/build/test-script, contract, supported-profile or known-flake-list edits. The existing tsconfig.test.json and test:unit glob already cover these named test paths; no script expansion is needed. If these three files cannot express a sound bounded test, return the exact additional requirement rather than assuming helper ownership.

These three paths are disjoint from NEXT's two production/two test paths, P065's explicitly reserved 20 production and 23 test/fixture paths, and MCP-ANCESTOR's four paths. The dispatcher confirmed at this consultation that NEXT still holds the lease and no other source/test reservations are known; the proxy compatibility Oracle is read-only. The run-control path is inside the original RUNZ1 ownership but is assigned exclusively to this follow-on while it is active. Do not start a simultaneous RUNZ1 implementer on it.

Dispatcher-owned records, through one serialized writer:

- docs/cloud/rulings/runz1-kill-diagnosis.md, this ruling;
- docs/cloud/RUNZ1-KILL.md if a separate brief entry is required;
- docs/cloud/handoff/runz1-kill/implementation.md;
- docs/cloud/handoff/runz1-kill/diagnostic-plan.json;
- docs/cloud/handoff/runz1-kill/diagnostic-<runtime>-<attempt>.json and .log;
- docs/cloud/handoff/runz1-kill/checks-<runtime>.log;
- docs/cloud/handoff/runz1-kill/negative-controls.md;
- docs/cloud/handoff/runz1-kill/manifest.json and SHA256SUMS;
- docs/cloud/handoff/runz1-kill/review-1.md;
- factual STATE and engineering-plan status updates only.

Use distinct numbered parts if necessary to preserve complete raw logs. Never replace the historical failing records or previous reviews. Scratch evidence belongs under /workspace/shared/runz1-kill-evidence/ and a distinct archive; do not modify another package's evidence directory.

## 7. Bounded execution and commands

After admission, use one implementer under the project workflow and a fresh independent final Oracle. The dispatcher verifies identities, records raw commands/results and owns scheduling. This is one new narrowly bounded submission, not a reset of old fix counters or an automatic allowance for further production/test remedies.

Record a diagnostic plan before running it. Start with instrumentation only, keeping the old target assertion intact. On Node 24.22.1 when available, run three fresh isolated target processes and one invocation of the original three-file focused command, retaining every outcome and the full captures. This fixed burst gathers branches; it is not retry-until-green or application of the known-flake policy. Stop the burst on unsafe release evidence or cleanup failure and mark remaining planned attempts unrun. If no ambiguous/receiptless outcome occurs, report “not reproduced,” not “flaky” or “safe historical release.” Do not add another burst without a recorded Oracle disposition.

Exact commands after fresh compilation, with an outer timeout:

- git rev-parse HEAD HEAD^{tree}; git status --short; git diff --name-status; source/dependency/generated-output manifests: **60 seconds each**.
- If dependencies are missing, the project's established npm ci --ignore-scripts against the unchanged lockfile: **600 seconds**, separately recorded. Honor the existing network/proxy policy; no dependency update.
- npm run build; npm run build:test; npm run build:hud-mcp: **180 seconds each**, separately logged.
- node --test --test-name-pattern='^cancel escalates INT then TERM then KILL' dist-test/tests/unit/run-control.test.js: **120 seconds per process**, three predeclared Node 24 instrumentation-only attempts.
- node --test dist-test/tests/unit/runz1-process.test.js dist-test/tests/unit/run-control.test.js dist-test/tests/unit/run-process.test.js: **600 seconds**, once for the instrumentation-only Node 24 diagnostic, preserving the original invocation's file set and concurrency behavior.
- After the bounded assertion/test correction is frozen, node --test --test-concurrency=1 dist-test/tests/unit/run-control-kill-evidence.test.js dist-test/tests/unit/run-control.test.js: **600 seconds**, once per supported runtime family used for this submission. Expected all new branch/evidence guards and the full run-control suite pass.
- The original three-file focused command above: **600 seconds**, once on each final candidate runtime. The serialized targeted run does not substitute for the original combined invocation.
- npm test: **1,200 seconds**; npm run test:mjs: **300 seconds** separately if npm test never reaches it; npm run test:core, npm run test:visual and npm run test:hud-mcp: **600 seconds each**; npm run format:check and npm run check:fixtures: **180 seconds each**; git diff --check: **60 seconds**.

The complete README check set remains required on the final candidate and eventual merged tree. The extra focused checks here cover Node 22 and Node 24; this does not invent a new full-suite runtime matrix. Use the established supported patches v22.23.4/v24.22.1 when available and identify any variation. A changed patch is not an exact reproduction of the old Node 24 environment.

Every invocation uses fresh temporary HOME and HUD_HOME within a dedicated TMPDIR, the selected Node directory first on PATH, and recorded color/NODE_OPTIONS settings consistent with the project isolation wrapper. Record proxy-variable presence/policy without printing secrets. The historical Node 24 no-proxy configuration and owner-selected Node 22 no-envproxy configuration are distinct evidence. Do not silently strip inherited proxy routing, suppress unrelated warnings or change the supported profile in order to turn a check green; use the separately recorded compatibility disposition when available. Dependency-network setup is separate from the offline synthetic KILL fixture.

Capture the actual expanded wrapper, runtime/npm paths and versions, source commit/tree, production/test file hashes, lock/dependency identity, fresh generated test/control hashes, UTC boundaries, exit codes, clean/dirty state and observable host-load limits. Do not chain checks so that later unexecuted commands disappear from the record. A timeout, missing capability, failed setup or missing diagnostic premise is not a pass. Clean up only owned synthetic processes by verified PID/identity; never kill by name/pattern or terminate unrelated host workloads.

Do not retry previously denied socket/ptrace operations on unchanged authority or bypass missing kernel facilities. Mark affected complete-check stages blocked and request exact-tree capable-host evidence instead. No sudo, procfs permission change, security setting change, new control fallback or assistant-run local session is authorized. This package makes no performance implementation change, so it does not require a new RUNZ1 n=1,000 scan-cost experiment; preserve the already reviewed performance evidence and its limitations. Any later production change would require a new disposition.

## 8. Owner-local request and final disposition

Once a frozen reviewable test candidate and exact commands exist, send the owner one concise request for the missing capable-host runs. Provide the new branch plus exact commit/tree, command list, expected state/evidence outputs, wrapper/proxy policy and evidence destination. Ask for raw stdout/stderr, per-run diagnostic captures, build/source hashes and every outcome, not just a success summary. The owner decides when to run them; continue independent authorized cloud work. Do not restart assistant-run local testing or contact the owner's local Claude as an agent.

Scope-limited commits/pushes to the new branch may publish this work as **WIP / NOT ACCEPTED / NOT MERGEABLE**, following the existing RUNZ1 WIP ruling and dots workflow. Verify the remote identity. No main/universal-hud production commit, force-push, history rewrite, node_modules staging or unaccepted dependency integration is released.

The fresh final Oracle must verify the exact diff and report, distinguish instrumented diagnostic runs from final checks, inspect both negative/positive proof branches and meaningful legacy/assertion negative controls, and explicitly dispose of local-review F2. If the historical facts remain unavailable, the report must say so even if the corrected test is proven sound and passes. It must also retain F1's complete-check/ancestor blocker and F3's separate envproxy result. MCP-ANCESTOR's eventual remedy or a different parent topology alone is not a retroactive pass for the old RUNZ1 matrix.

A complete green test-only subset is insufficient for RUNZ1 acceptance. If the unchanged ancestor/envproxy baseline prevents a green complete candidate, keep the package blocked and obtain the separately reviewed integration disposition; do not merge unaccepted branches to manufacture a passing dependency tree. Only an applicable fresh accept verdict plus the prescribed full green merged-tree checks permits the normal --no-ff integration and push. DOC2/TPD1 and later waves retain their existing prerequisites.

Stop and return the exact evidence if the observed release lacks complete proof; a test cannot establish its premise; diagnostics cannot be retained; a correction needs an excluded file or production behavior; ownership changes; or the new submission remains fix required. No second remedy/extra diagnostic burst is automatically released. This ruling changes no contract, gate, runtime support, signaling authority, scope proof, queue ordering or security boundary.

## Sources and method

- Local RUNZ1 Oracle: https://github.com/CartmanFatass/codex-hud/blob/37cf7bef3075ffa312c36b8f78102f6c4bd4de67/docs/cloud/handoff/runz1-local-review-20261103.md
- Owner report: https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/REPORT.md
- Failing raw log: https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/logs/runz1/node24/11-focused-runz1.log
- Target assertion: https://github.com/CartmanFatass/codex-hud/blob/86ca8887fcfb331750ec6dc5518d69134cb795e4/tests/unit/run-control.test.ts#L350-L379
- Receipt/Q control paths: https://github.com/CartmanFatass/codex-hud/blob/86ca8887fcfb331750ec6dc5518d69134cb795e4/src/core/run/control.ts#L142-L263 and #L735-L833
- Terminal policy: https://github.com/CartmanFatass/codex-hud/blob/86ca8887fcfb331750ec6dc5518d69134cb795e4/src/core/execution.ts#L34-L281
- Contract Q/cancellation rules: https://github.com/CartmanFatass/codex-hud/blob/86ca8887fcfb331750ec6dc5518d69134cb795e4/docs/contracts/02-execution.md#L138-L190 and docs/contracts/04-supervision.md#L65-L77, #L112-L145
- Native fixture: https://github.com/CartmanFatass/codex-hud/blob/86ca8887fcfb331750ec6dc5518d69134cb795e4/tests/run/native-group.ts and tests/run/group-helper.ts
- P065 reservations/lease: https://github.com/CartmanFatass/codex-hud/blob/33781271a648f271a5913517449b2a4ee6418abc/docs/cloud/rulings/p065-budget-release.md
- MCP-ANCESTOR reservation: https://github.com/CartmanFatass/codex-hud/blob/33781271a648f271a5913517449b2a4ee6418abc/docs/cloud/rulings/mcp-ancestor-gate.md

Method: read-only GitHub files, refs and comparisons, existing evidence and current dispatcher reservation confirmation. No repository/source/test/file writes, branch/worktree creation, test/build/benchmark/probe execution, local-machine action, permission change or subagent was performed. This is a scoped diagnostic/release ruling, not a new final implementation review or proof that the proposed tests have already passed.