# P065 rejection-audit cloud tranche: fresh Oracle review

Date: 2026-11-04 UTC. Repository: CartmanFatass/codex-hud. **Final review of the bounded six-stage Node 24 evidence tranche.**

## Decision

**Accept the six-stage Node 24 tranche as valid focused evidence for candidate 3435589ef253159948c94eaae111606191bd4e3d. No new blocking source defect or requested source fix. Do not yet accept the scoped repair, P065 package, NEXT dependency consumption, performance qualification or merge.**

All three builds exited 0. Full raw test output contains exactly **40/40, 58/58 and 28/28 passes**, with no failures, cancellations, skips or todo. The recorded input/output checks and owned-process closure corroborate the reported execution. The launcher differences stay within the admitted mechanical changes. The disclosed single built-in caller retry is expressly allowed by the ruling, not a rerun of a workload.

The next minimal compute step is the four already-required isolated behavioral controls, after a new bounded dispatcher window and exact control preparation. Remaining named regressions, Node 22 evidence, formatting, full-package gates and real-clock qualification are still outstanding. This verdict closes the initial evidence review only; it does not waive those requirements.

## Identities and source scope independently checked

- Preimage: 0008ff0415fd50b0e7636f8947bfc3fbbf6cdb8f.
- Candidate: **3435589ef253159948c94eaae111606191bd4e3d**, recorded tree 27d8c69594fefe83332cec00c346cc8fcf664159.
- Report descendant: 8436697db4ce2d2fe7305c6956d0e4ecda578c3e. The preliminary review identifies its only addition as the implementation report; this is not the tested source pin.
- GitHub comparison independently confirms candidate is one commit ahead of its preimage, which is also the merge base; exactly four paths differ, with 367 additions / 18 deletions:
  - src/ledger/intents.ts: +21 / -15; blob 422870d6c487b43e23636b0bb1d40062f1ec434d.
  - tests/ledger/process.mjs: +5 / -1; blob e7c0e0ea61452c7c34427ed660a2e4f70e3675be.
  - tests/unit/ledger-processes.test.ts: +2 / -2; blob 0c32f4964605f213c25c7883716c29548f9046b0.
  - tests/unit/p065-rejection-audit.test.ts: +339 / -0; blob 6a1ffb4729b0788ea6d0e2683f0faca5477a137c.
- Owning cloud thread: 01a1a3c0-8454-762a-a04c-d71a10b710c9. Execution turn: 01a1a4a9-6fa9-70d5-ac4b-d5a6499170e0.
- Reported checkout: /workspace/p065-audit-repair-verify, in the existing authorized cloud environment. No claim that a new container was provisioned.
- Runtime reported: /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node, v24.22.1; binary SHA-256 61ab14cd750fc24d5db53490ec5fc40f756e4b6e136b78cf7004265471d9bd1d. TypeScript 5.9.3. Matching installed bytes do not independently establish historical installation provenance.
- Preliminary review /workspace/shared/audit-repair-precheck.md independently hashed to 8fedfda00edf1be0fd857804ea172aced7f8999315fb36e938ac5b9253bc21a4.

The ruling is at the immutable integration/documentation ref d17a8affb89bcf16a78cb9b2beee3300b975266a, not the candidate source commit. Its absence at the source commit is not source drift.

## Static findings and test meaning

No new P0-P2 source finding or requested source fix.

1. intents.ts:456-494 preserves the established refusal. The completion observation is non-enforcing and failure-safe; optional eligibility and transaction errors are swallowed without replacing the original error. CapacityRefusal retains its business result. Unsafe cleanup, uncertain COMMIT, store-proof failure, busy and authorization exclusions remain. The original budget object reaches the optional audit.
2. This does not disable budget enforcement. acceptIntent still checks before/after normalization, and the unchanged ledger/transaction path checks queued time, acquisition, cumulative wait, callback and pre-COMMIT. The new pre-admission test specifically requires CallBudgetExpired and no transaction/callback.
3. ledger-processes.test.ts:123-184 still sends both first requests to ready real OS children before awaiting results, requires one acceptance and one idempotency_conflict, retains complete committed-state/integrity and accepted-run association, and retains the exact-one intent.rejected assertion. The private child field selects the existing trusted TestBudgetClock only for this case. Each actual child invocation creates its own original budget before preparation; no audit budget reset or production clock escape hatch is introduced.
4. The new eight tests execute real SQLite conflicts, rollback and audit SQL. Observers call through and distinguish invocation, successful BEGIN, callback errors and transaction errors. The 29.999/30/30.001 ms advances occur after actual rollback. A 1+2+4 ms actual SQLite contention/backoff case verifies spent wait and object identity. The queued audit expires before BEGIN; the insertion-only trigger produces a known audit rollback with the original conflict preserved.
5. Tests assert error object identity, exact rejection payload/time/null attribution, complete winning rows and accepted event preservation, audit admission counts/order, and integrity. Hooks/clock/trigger and temporary environments restore in finally. Fixture cleanup uses the real ledger close path. Source inspection is not a substitute for missing runtime/control evidence.

## Verified first tranche and process lifecycle

All six initial lifecycle records identify the pinned checkout and the following direct commands with the absolute Node above:

1. ./node_modules/typescript/bin/tsc
2. ./node_modules/typescript/bin/tsc -p tsconfig.test.json
3. ./node_modules/typescript/bin/tsc -p packages/hud-mcp/tsconfig.json
4. --test dist-test/tests/unit/ledger-processes.test.js dist-test/tests/unit/ledger-write.test.js dist-test/tests/unit/p065-rejection-audit.test.js
5. --test dist-test/tests/unit/p065-budget.test.js dist-test/tests/unit/p065-local-gate.test.js
6. --test packages/hud-mcp/dist/tests/hud-mcp/p065-budget.test.js

These match the admitted first tranche and the direct build-script expansions. They are not the whole README/P065 gate.

| Stage | Verified focused result | Direct PID | Observed direct wait monotonic ns | Observed ECHILD monotonic ns |
|---|---|---:|---:|---:|
| 1 | build exit 0 | 2955 | 15342967533932 | 15343018461072 |
| 2 | build exit 0 | 3000 | 15379585815300 | 15379636983036 |
| 3 | build exit 0 | 3038 | 15386816359127 | 15386867463976 |
| 4 | 40 tests, 40 pass | 3075 | 15395052879134 | 15395103646075 |
| 5 | 58 tests, 58 pass | 3433 | 15405544125894 | 15405595027020 |
| 6 | 28 tests, 28 pass | 3488 | 15410495800315 | 15410546773743 |

Each visible wait record says direct=true, status=0, exitcode=0. The ECHILD record follows each direct status by about 51 ms. These observations concern the current supervisor's owned normal descendant tree; they do not retrospectively resolve old unknown processes or attest arbitrary escaped processes.

Reported outer UTC intervals on 2026-11-04, followed by calculated monotonic durations:

- 1: 03:47:01.403355 to 03:47:08.498358, 7.095002336 s.
- 2: 03:47:34.497879 to 03:47:45.199758, 10.701877385 s.
- 3: 03:47:48.688418 to 03:47:52.320162, 3.631735225 s.
- 4: 03:47:57.075039 to 03:48:00.610235, 3.535196905 s.
- 5: 03:48:08.930992 to 03:48:11.078930, 2.147939937 s.
- 6: 03:48:14.799061 to 03:48:16.040583, 1.241520124 s.

The returned literal initial/child_created/launch_released/exec_pipe_eof/wait_status/wait_echild/exec_final/result records establish matching argv, isolated per-stage environments, pidfd availability, direct status 0, closure=true, lifecycle_valid=true, postcheck_ok=true, no interruption, no unexpected adopted descendant, no failure and no postcheck error. Existing scalar-record extraction supplies initial ECHILD, subreaper readback 1, 45 identity entries and unchanged pre/post identities for every stage. All outer statuses are 0. The correct result classification remains **exit_status_observed_exec_unverified**: observed wait status plus no reported exec error is not independent exec attestation.

The complete returned stdout contains exactly 40, 58 and 28 passing test lines, respectively. Reported test durations are 3079.543998, 1694.19451 and 786.274643 ms. All three summaries have suites/fail/cancelled/skipped/todo 0. Stage 4 includes the real concurrent different-parameter case, all nine real SIGKILL cut points, reconcile contention, ledger-write regressions and all eight new audit cases. Stage 5 includes expiry/late-commit/uncertainty/rollback isolation, fixture construction, local proof and actual compiled CLI-to-independent-MCP original-proof/budget/one-launch replay. Stage 6 includes external error mapping, unsafe-audit suppression and post-acquisition store change, durable replay, late outcomes and read-only wait/status.

### The disclosed internal retry is within the approved test

The executor later highlighted one diagnostic: “Concurrent intent exhausted its 20 ms busy budget; retrying the same request once after the competitor committed.”

This is the unchanged, expressly retained caller retry in ruling §5A and the preliminary review, not another execution of the test command, a conflict retry, an optional-audit retry, or a failed-suite rerun. Source restricts it to an explicit first ledger_busy and only once, after both competing first responses have settled. The final result must still satisfy the exact conflict and one-rejection-event assertions. Accordingly it is **not a scope violation and not a new permitted flake**. Preserve this fact in the evidence report. Do not claim the winning/losing first attempts both reached their business outcomes without retry.

## Evidence validation and limitations

The initial executor-local links were not usable by this reviewer. That delivery gap was resolved by nine literal-text batches in turn 01a1a4b0-da03-726a-a5ee-3c9d896292f5 and a scalar-record response in turn 01a1a4b7-5ff6-74d4-9b67-163d8a4756d8. Small paginated reads recovered all batches without truncation. The final review does not treat a link or a hash alone as the supplied contents.

Independent offline text hashing established:
- The recovered complete reviewed supervisor text hashes to **c4f56dc06cf481df00ca5e23539f319a6fe362c4a1ee591d94590115742b6e5b**.
- All six literal diff blocks hash exactly to the previously recorded .diff identities.
- Applying each diff to the base **in memory only**, with exact context matching, reproduces all six recorded launcher hashes. No launcher was written or executed by this review.
- All three literal test stdout blocks hash exactly to their recorded raw-file SHA-256 values. Stage 4 required the executor's two expressly supplied transcription corrections: insert:runs is **199.527226 ms**, preserves terminate is **237.491145 ms**. With those corrections the entire stdout hash matches. They affect neither assertion results nor the aggregate duration. Preserve both the disclosure and corrected raw identity.
- No inconsistent argv, cap, launcher identity, stage ordering, test count or lifecycle result was found.

Diff inspection finds only documentation label, checkout/source/tree/manifest pins, expected manifest hash, exact argv, stage evidence path, output prerequisite/inventory and the approved test-cap substitutions. Node/Python/compiler-loading hashes and lifecycle/signal/reaping/error logic are unchanged. The 180/10/210 build and 300/10/330 test limits, and outer 230/350-second TERM plus 10-second kill-after envelopes, match admission. Outer commands retain clean env, foreground timeout, absolute Python, -I -S -B and /dev/null stdin. The initial environment contains only HOME/HUD_HOME/TMPDIR, PATH, LANG and TZ; no unsolicited color or runtime settings appear.

Per-stage pre/post external checks all record PASS, status="", ignored_input_files=[], 1,315 tracked files and 275 dependency files. Their durations are approximately 0.23-0.33 s, below the 60-second cap. Every external precheck PASS precedes that stage's outer start; every external postcheck follows the outer result and precedes the next stage. Supervisor preflight always precedes child creation; its postcheck follows ECHILD and precedes its result.

| Stage | External precheck UTC start → PASS | External postcheck UTC start → PASS | Supervisor output entries |
|---|---|---|---:|
| 1 | 03:46:52.461205 → 03:46:52.686822 | 03:47:15.467169 → 03:47:15.713094 | 1101 |
| 2 | 03:47:34.220458 → 03:47:34.484031 | 03:47:45.238963 → 03:47:45.550059 | 1047 |
| 3 | 03:47:48.358301 → 03:47:48.666439 | 03:47:52.359206 → 03:47:52.654392 | 264 |
| 4 | 03:47:56.754236 → 03:47:57.059770 | 03:48:00.659871 → 03:48:00.950489 | 1047 |
| 5 | 03:48:08.591675 → 03:48:08.916582 | 03:48:11.127915 → 03:48:11.437218 | 1047 |
| 6 | 03:48:14.472327 → 03:48:14.780825 | 03:48:16.089942 → 03:48:16.403348 | 1047 |

All times are 2026-11-04 UTC. Existing output inventories establish:
- Before stage 1, dist, dist-test and packages/hud-mcp/dist were absent.
- After stage 1: dist 1101 entries; the other two absent.
- After stage 2: dist 1101, dist-test 1047; MCP dist absent.
- After stage 3 and throughout tests: dist 1101, dist-test 1047, MCP dist 264, with prior output manifests checked.
- Stage 6's supervisor inventories dist-test, not MCP dist; the external pre/post checks independently include the already-built MCP output manifest. The supervisor's 1047 count must not be mislabeled as the MCP 264-entry inventory.
- Each test stage's dedicated HOME, HUD_HOME and TMPDIR was empty at postcheck.

Committed four-file diff-check and pending diff-check each have saved status 0 and empty stdout/stderr; pending git status is empty. These are hygiene passes, not formatting passes. Source/config/dependency and output maps were supplied as existing-record scalar extractions and counts rather than full arrays. The original full maps remain in the recorded pre/post logs; their whole-file hashes are retained below. No separate aggregate output-manifest hash was originally recorded, and none is invented. Full events.jsonl hashes and those pre/post log hashes are recorded identities, not claims that this reviewer independently reconstructed the omitted arrays. The independent byte-for-byte reconstruction described above covers the base launcher, six diffs, six resulting launchers and three test stdout files.

## Controls and remaining gates: NOT RUN / pending

Before scoped repair closure, preserve the four original behavioral controls in isolated, separately identified checkouts of this candidate, never by mutating the frozen candidate or integration tree:

- **C-A:** Replace the entire failure-safe completion try/catch with the old unguarded if (!auditUnsafe) budget?.check('complete'). Merely changing note to check inside a swallowing catch is vacuous. Fresh test build; run the audit test file. The 30 and 30.001 ms cases must fail original-error identity because busy displaced the real conflict.
- **C-B:** Remove only the optional rejection insertRecord call, retain transaction and guards. Fresh test build; run ledger-processes plus the audit test file. The retained real multiprocess exact-one event assertion and new eligible positives must fail zero versus one.
- **C-C:** Remove only the remaining-time eligibility operand, retain unsafe/security exclusions and deeper budget enforcement. Fresh test build; run the audit test file. At/after 30 ms the no-second-transaction-invocation assertion must fail even if SQL does not begin.
- **C-D:** Let the optional-audit exception escape its final catch. Fresh test build; run the audit test file. The queued-expiry and real SQLite trigger cases must fail original-error identity.

Each must compile successfully before the test, have an exact declared mutation and expected assertion, actual nonzero test output, no import/compiler failure in lieu of behavior, valid process cleanup and unchanged final candidate identity. Unexpectedly green controls, unrelated failure, skip, timeout, denial or uncertain cleanup are blockers, not useful negative evidence. The controls themselves are not production fixes or performance qualification.

The minimal next compute tranche is these already-required controls, one at a time in a newly assigned quiet window, using only the reviewed supervisor's permitted mechanical pins/argv/path/output/cap changes. Retain the existing 180/10/210 build and 300/10/330 test envelopes with 230/350-second outer TERM and 10-second kill-after. Explicitly distinguish expected assertion failures from unexpected workload failure. No install, process-topology redesign, blocked-capability retry or full-suite expansion is bundled here.

Also still pending:
- The original 600-second CLI/capacity/wait regression group and 600-second MCP authorization/delegation/resume/handshake/hook/advice group. They need their named later admission, not an implicit extension of this 300-second test tranche. Exact commands are retained in the preliminary review §6 and P065 brief §10. Existing ledger-write results need not be rerun only for relabeling.
- Applicable focused and control evidence on supported Node 22 >=22.13 in an authorized runtime window.
- Exact approved formatter availability, four-path check-only formatting and whole-package format:check. git diff --check is not formatting.
- The remaining full exact-final-tree README/P065 inventory: all npm test stages including mjs, core, visual, full hud-mcp, fixtures, formatting and remaining shared-writer security/lifecycle obligations. Stage 5 already supplies the named compiled CLI-to-MCP original-proof/budget/one-launch replay test; do not label that focused case unrun, or mistake it for every broader CLI/security obligation.
- Complete original P065 real-clock qualification, populations/samples and three isolated series per runtime family; original preparation-inclusive 30 ms and cumulative 20 ms, busy_timeout=0, actual outcomes/overruns and separate local-only qualification. Deterministic clock passes do not establish timing qualification.
- Known denied socket/ptrace and local-only stages remain accurately blocked/unrun where applicable; do not repeat denied operations or claim a focused pass clears them.

No package fix-round counter is reset. No owner contract/gate/profile change, NEXT dependency shortcut, main write, force push, merge or deployment follows from this review. Return the execution lease while awaiting evidence/review or formatter input.

## Sources and method

- [Immutable rejection-audit ruling](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/cloud/rulings/p065-rejection-audit-repair-20261104.md).
- [Candidate comparison](https://github.com/CartmanFatass/codex-hud/compare/0008ff0415fd50b0e7636f8947bfc3fbbf6cdb8f...3435589ef253159948c94eaae111606191bd4e3d).
- [Candidate catch](https://github.com/CartmanFatass/codex-hud/blob/3435589ef253159948c94eaae111606191bd4e3d/src/ledger/intents.ts#L456-L494), [new tests](https://github.com/CartmanFatass/codex-hud/blob/3435589ef253159948c94eaae111606191bd4e3d/tests/unit/p065-rejection-audit.test.ts), [real process test](https://github.com/CartmanFatass/codex-hud/blob/3435589ef253159948c94eaae111606191bd4e3d/tests/unit/ledger-processes.test.ts#L123-L184).
- [Execution contract](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/contracts/02-execution.md#L95-L99), candidate AGENTS / dots / README / P065 brief / source and configuration.
- Cloud execution and read-only evidence turns named above; earlier c4f56dc0 supervisor body and V1/V2 supervision records were read as historical route context, not relabeled as new-source results. Complete literal supervisor source and current diffs were used only for offline in-memory byte identity verification.

Method: read-only GitHub/source/recorded-cloud-message inspection and local text/hash reads. Only this requested standalone review file was written. No tests, compilers, formatter, benchmark, dependency setup, process probe, source change, repository mutation, new cloud task or subagent.

## Recorded bundle identities

Candidate manifest SHA-256: 872fb68930385baa6548c70b8c51eb4fe58b6ecc62219cb2d57fb066697947ee. Empty-file identity (all six stderr and build stdout): e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.

Each line below is: stage; launcher; mechanical diff; full events.jsonl; stdout; external precheck log; external postcheck log. Launcher/diff/stdout identities have the independent reconstruction validation described above. Event/pre-post identities label retained executor originals, including their omitted arrays.

```text
1 94cf31ee13d0665e202f40090ebf2e3121a85298acf23bde07ce74e921369b99 864c000854d19fb9d3b6769dc9503e98cd08e8701d0be60687d320a940852ce7 68178d968caa048ac6ca6566f653b3523bfb33a106c32f82a3c9f03164fe654a e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 917088890ab42cf77a5b486f67efcc0543c1ee413b95c5b4f3c76dd474c0f322 3589e64cb029abd3c13b77a4215b76f231c8adc5062629bb4bf2ea4d2514f844
2 5693f18553deb63a1ff0e04ddfce2b123dac5d1690f384c0bab2d1447f089db3 3fe752da13f4aa16188914877f1adb320a173001b879a872aee6e98655a0f219 bd713f13ff98e24b92b1a167b6da349d8ec320e1cd82560157c908b1a620e1ff e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 f669d23e0ac476172d9deb3229c798d11b5cdabb3f671333dcc921a8a588c603 e0b9aa09a055846d8affe2bd63ab7ad3a67e317bb9ecfe083f7a78354f982b28
3 6a18bcf87e3fda4e97eb14bce1a2feef02f58e47014c56836bd2807116c6b213 d8f9b991f5c3da8cc0ad49f6321ecdbca96240c72f95952e5e2015177b84ac4c 132ececc867c7692783e78ec4d0690b3e6e6a3d1b19820773224b19468867b68 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 99cf14d2128a490d9419c19e305f23527684a1265b2694f197715ac4bd991de2 c4877b4597c12c48c68916f12ed9650ad118a7332dd198a904ec892d5d12f082
4 45cd4c9ddc00a0b5bceaf8087827aede3785015d8ce7ee1e15947c9d7637bb0e 4f4b03e9c96c1893192dddcf449c63216877e8610b2701c40327ff07514ba769 c2c9ac95fadc39dcf9788e67b42033ad06c07f57c2e7081bce3222e8b64ba304 550d58acf386f401c0713d27a4f5e0b094e0140dcff0a86cbdde8ad3e14c8042 9facc1c060c674f9955d81805d85a75fa630b4e09e88f77c389d10f282a49673 50c71af7ceaae4073dba1b51ef94114dcfcad9a5be61b5fb621da7787625e4df
5 0848313e1fe304978633014e364119ae92758b12660380b053f39d1c3d99fe42 fe5ba968a16e5d5fc9fdd464f5b9e40c63719e0ba1ca55d99c5f88103d828475 099a0c6c610a2c25a74904e671c270f435d19ccfe1d244c8ab186a694a7c5cfb ca6db798c03d8b60837c31a48ad3224276aa233a7b4eebcdb13ff784bc3d0f45 b0f3ce9422889ab7672f77a9020511153f33719d4d820d46f4d1253f6ee0b88d 1a46def6f45d79222f456154c1acec5bf17d439c726f83c529055b314e329617
6 e4a1db8709902d44514745c5e9a5ae46828c066d82ac2ed145b297dc1091ac10 1efe1e3946abc0da90f5696676198bde59d193925ac2e6ab50dbb527053ff4c1 84d011ed23f3fc5bbb00c9ae80ba0bb0c82542ed49432739ca06a0cccb435f65 e157476cc58c43bb6cf7914ad6024a546bd23358adc2f44cbe76d70411712967 825e7d82908f3d697df277d212ca42b4f85d05d8fc2b8b018b32abfb1af80a00 6964220b3e5f410ff575486179837f3d34f2e1c9bafbaf8ec9eb3967c7184170
```

Final disposition: **Node 24 six-stage focused evidence accepted. No source fix required from this review. Rejection-audit scoped closure, P065 acceptance, qualification, NEXT integration and merge remain pending.**

