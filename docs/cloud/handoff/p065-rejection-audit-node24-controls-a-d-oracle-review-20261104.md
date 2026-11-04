# P065 rejection-audit controls A–D: independent Oracle review

Date: 2026-11-04 UTC. Repository: CartmanFatass/codex-hud. Review is read-only with respect to the repository and executor workloads.

## Decision

**ACCEPT all four Node 24 behavioral controls, C-A through C-D, for candidate 3435589ef253159948c94eaae111606191bd4e3d.** Each isolated, exactly declared mutation compiled successfully, produced its required behavioral assertion failure, and completed with authoritative direct status, owned-process closure and matching postchecks. All additional failures are direct consequences of the same declared mutation. No source correction or repetition of these controls is required.

This accepts the negative-control evidence, not a green mutant suite, complete rejection-audit closure, P065 package acceptance, performance qualification, NEXT integration, or merge. The previously accepted six-stage Node 24 focused evidence remains accepted and need not be repeated merely for bookkeeping.

The initially missing raw evidence and final-candidate identity check have now been supplied and verified. They are not outstanding blockers.

## Scope and evidence identity

- Candidate commit: `3435589ef253159948c94eaae111606191bd4e3d`.
- Candidate tree: `27d8c69594fefe83332cec00c346cc8fcf664159`.
- Frozen candidate checkout: `/workspace/p065-audit-repair-verify`.
- Independent mutant checkouts: `/workspace/p065-control-a`, `-b`, `-c`, `-d`. These are intentionally dirty control trees based on the candidate, not new production commits or replacements for the frozen candidate.
- Executing cloud task: `01a1a3c0-8454-762a-a04c-d71a10b710c9`.
- Control execution turn: `01a1a4ba-bc9b-71a7-8743-4d2493ad95b6`.
- Evidence extraction turns: `01a1a4bf-5377-7616-8fda-b850b1fb42d4` and `01a1a4c1-f893-77d3-b585-a7362a4f00db`.
- Final identity check and complete archive delivery: `01a1a4c3-d4e3-7763-8103-9535f31b3350`.
- Runtime: the previously verified Node v24.22.1, pinned executable `/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node`, SHA-256 `61ab14cd750fc24d5db53490ec5fc40f756e4b6e136b78cf7004265471d9bd1d`.
- Python SHA-256: `fa67443527ed9647f760d807e2a38f26340757123e643c4639cf273ed15d5ea7`.
- Reviewed supervisor base: `c4f56dc06cf481df00ca5e23539f319a6fe362c4a1ee591d94590115742b6e5b`.

The complete raw bundle is `p065-controls-oracle-evidence.zip`, 3,286,008 bytes, SHA-256 **`8b98805f9aa3b9972b77fe4a10f9f7c08654dbbd2feb4ccc0c247c5b02cac570`**. It contains 137 evidence files plus `SHA256SUMS`, 138 unique archive entries in total. Its confirmed Library identity is `libfile_4cab7518796c81918293f2cc9f0d4776`, file identity `file_0000000014e481f5a921d6dc434f8077`.

This reviewer obtained the actual archive bytes through the supported file route, independently matched the ZIP identity and every one of the 137 file hashes, and read the full raw tests, launcher diffs, lifecycle events, external check logs, manifests and final-candidate records. No executor-local link or reported hash was treated as a substitute for its contents. The first extraction omitted A/D stacks and other evidence; the second exposed those contents only in unavailable tool output. Those delivery failures were resolved by the complete archive. The final check was newly performed after the controls; it must not be misrepresented as a record that existed earlier.

## Behavioral decisions

All four builds ran the pinned Node with:

`./node_modules/typescript/bin/tsc -p tsconfig.test.json`

All built successfully with empty stdout/stderr. A, C and D then ran:

`--test dist-test/tests/unit/p065-rejection-audit.test.js`

B ran:

`--test dist-test/tests/unit/ledger-processes.test.js dist-test/tests/unit/p065-rejection-audit.test.js`

Each test command ran once. No compiler/import failure, timeout, cancellation, skip, todo, or unexpected green result was substituted for the required behavioral failure.

| Control | Exact mutation and required observed failure | Complete result | Verdict |
|---|---|---|---|
| C-A | Replace the entire first swallowing completion try/catch with the original unguarded `if (!auditUnsafe) budget?.check('complete')`. At both 30 and 30.001 ms, the error-identity assertion receives `CallBudgetExpired: ledger_busy` instead of the actual callback's `idempotency_conflict`. | 8 tests; 5 pass, 3 fail; exit 1. | Satisfied |
| C-B | Remove only the optional rejection `insertRecord`; keep transaction, local guard and budget checks. The real multiprocess exact-one rejection assertion and both deterministic eligible-positive assertions fail with 0 versus 1. | 23 tests; 19 pass, 4 fail; exit 1. | Satisfied |
| C-C | Remove only the remaining-time eligibility operand, including its numeric-API alternative, while retaining unsafe/security exclusions and deeper checks. At both 30 and 30.001 ms, the number of transaction invocations is 2 instead of 1. | 8 tests; 5 pass, 3 fail; exit 1. | Satisfied |
| C-D | Rethrow `auditError` from the final optional-audit catch. Queued expiry and the actual SQLite insertion trigger each fail original-error identity. | 8 tests; 5 pass, 3 fail; exit 1. | Satisfied |

Every summary records suites, cancelled, skipped and todo as zero. Durations reported by the test runner are A 215.382591 ms, B 2608.604464 ms, C 193.170538 ms, D 191.293309 ms. These are execution details, not production-clock qualification.

### All additional failures are explained

- **A:** The observer-failure test also loses its original conflict. The raw stack shows `synthetic_clock_observation_failure` through `CallBudget.note`, `CallBudget.check` and the restored unguarded completion call. This is the same removed protection, not an unrelated failure.
- **B:** The real SQLite failure test expects the optional audit to roll back. With its only rejection insertion removed, the trigger never fires and that transaction instead commits. The trace differs exactly at the final COMMIT versus ROLLBACK. This fourth failure corroborates removal of the insertion and does not invalidate the three required zero-versus-one failures.
- **C:** The observer-failure test also records two transaction invocations instead of one. Removing the eligibility operand bypasses the failing observation that formerly prevented scheduling; the unchanged deeper transaction path still rejects. The required expiry failures distinguish scheduling from successful SQL acquisition. A negative test stops at its first assertion failure, so this review does not claim later assertions in that failing mutant case were executed.
- **D:** The observer-failure test also loses its conflict because an exception from `budget.remaining()` now escapes the same optional-audit catch. The two required failures are independently present: queued expiry produces `CallBudgetExpired: ledger_busy`; the real trigger produces `synthetic_rejection_audit_failure`, `ERR_SQLITE_ERROR`, SQLite code 1811, through the actual `LedgerTransaction.run` / `insertRecord` path.

All eight tests still execute in A/C/D, and B includes the full specified 15-test process file plus eight audit cases. B's other real process, SIGKILL-cut and reconcile cases pass.

### B's caller retry is permitted

B records one diagnostic: an initial concurrent intent exhausted its 20 ms busy budget and the test retried that same request once after the competitor committed. The governing ruling §5A expressly preserves this existing at-most-once caller retry. Source inspection confirms both ready children receive their first requests before either outcome is awaited, the retry applies only to an explicit first `ledger_busy`, and neither a conflict nor an audit is retried. The retried call owns its own original budget.

This is not a repeated test command, hidden flaky-suite retry, same-call budget reset, or scope breach. Preserve the diagnostic and do not claim that both first attempts reached their eventual business outcomes without retry.

## Exact mutation and source isolation verification

The four literal mutation diffs independently hash to the recorded identities. Applying each in memory to the complete pinned GitHub `intents.ts` reproduces its recorded SHA-256 and Git blob. No mutated source was executed by this reviewer.

| Control | Mutation diff SHA-256 | Mutated intents.ts SHA-256 |
|---|---|---|
| A | `2f240421eb50209dc89d45cf1b02252c284576b952b5e96cfcc97418de7f4105` | `69e0b349d541831053e92bff94d7854f068c84c21526a987f4cbfed298790d8b` |
| B | `17a7659ed635a1e002e6caf03a2d15a50191582630277c667cdb711403296dd3` | `85aa5fe8737c03f1c9e6b1c2199129e5f99e312b2cecd9bdc554b7e93ad7329f` |
| C | `2a8276ae93be310ad75e53836c90d1a54ffa1a3e3b815e55380eab27e9550e56` | `51ff29fdad75dd07084b9371c4cdd61761e5700890df76addf894e9afddf5fb3` |
| D | `22d5c8029849a55f48140fadbc46a4bd0acf242e2d62d48ae345aa2336a03b7e` | `c7be61a5497e6c1ede3af30b927519e3f78ad51c60113559c3df52826e9a5afe` |

Each control manifest has the same base commit/tree, 33 named source files and five unchanged build-configuration files. Its changed `intents.ts` size/hash matches the reconstructed mutation.

All sixteen external before/after logs were examined, not merely their PASS labels. Each contains exactly 1,315 unique tracked files, including 275 dependency files; status is exactly the one expected unstaged `src/ledger/intents.ts` change, with no ignored inputs. All non-mutated source/configuration/dependency hashes match the final clean candidate record. The checker also verifies executable modes and rejects symlink substitution and index conflicts. No assertion/test or other production file was altered in a control.

For each control, `dist-test` was absent before compilation. Its fresh inventory has 1,047 entries. Build-after, test-before, test-after and the supervisor inventory agree after normalizing only the inventory field name `size` versus `bytes`. Relative to the clean candidate's compiled test graph, the only differing output paths are `src/ledger/intents.js` and its source map. This is strong evidence against stale outputs, altered tests or collateral compiled changes.

The historical dependency installation provenance remains unverified; byte equality does not create a new provenance claim.

## Supervisor, process cleanup and timing

The complete historical supervisor text independently hashes to the accepted c4f56dc0 identity. All eight archive diffs apply to it exactly and reproduce their complete recorded launcher files and hashes. Direct comparison across launchers finds only the permitted label, checkout/source/tree/manifest/evidence pins, declared argv, test-output prerequisite and workload/closeout cap substitutions. Lifecycle, error, signal, pidfd, subreaper and reaping behavior is unchanged.

Build limits remain 180-second workload, 10-second TERM grace and 210-second closeout. Test limits remain 300/10/330 seconds. The archived outer wrapper expands each stage to:

`/usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 TZ=UTC /usr/bin/timeout --foreground --signal=TERM --kill-after=10s CAP /opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin/python3 -I -S -B /workspace/p065-controls-validation-01/CONTROL-PHASE-launcher.py`

Here CAP is 230s for builds or 350s for tests; CONTROL is the declared a–d and PHASE is build/test. Each uses /dev/null stdin and distinct raw stdout/stderr/status files. These envelopes do not extend the underlying workload deadlines. The wrapper correctly treats expected test status 1 separately from lifecycle/postcheck validity; it does not convert every nonzero exit into a valid control.

Every full event sequence records:
1. Exact declared argv, checkout, clean environment and launcher hash.
2. Subreaper readback 1, initial ECHILD, and 45 identity entries.
3. A gated direct child with pidfd available, then release.
4. Exec-pipe EOF with no reported error.
5. One authoritative direct wait status, followed by ECHILD.
6. Final EOF/release state, byte-identical pre/post identity map and 1,047-entry output inventory.
7. closure=true, lifecycle_valid=true, postcheck_ok=true; no interruption, unexpected adopted descendant, failure or postcheck error.

| Stage | Direct / outer exit | Direct PID | Direct wait monotonic ns | ECHILD monotonic ns | Outer duration seconds |
|---|---:|---:|---:|---:|---:|
| A build | 0 / 0 | 3837 | 16518502243126 | 16518553188107 | 11.345839966 |
| A test | 1 / 1 | 3876 | 16522330923313 | 16522381716476 | 0.691675873 |
| B build | 0 / 0 | 3928 | 16545670501061 | 16545721669947 | 11.846534078 |
| B test | 1 / 1 | 3967 | 16552304435325 | 16552355272957 | 2.995099755 |
| C build | 0 / 0 | 4316 | 16571938015746 | 16571989138676 | 10.734244298 |
| C test | 1 / 1 | 4355 | 16575698374561 | 16575749083290 | 0.590072960 |
| D build | 0 / 0 | 4406 | 16595432744585 | 16595483606938 | 10.909017378 |
| D test | 1 / 1 | 4445 | 16599505951947 | 16599556686541 | 0.598143668 |

All UTC/monotonic sequences and stage ordering agree. The first outer start is 04:06:32.673450 UTC; the last outer end is 04:08:05.022240 UTC. Every external precheck PASS precedes its outer start; every external postcheck begins after outer completion and finishes before the next workload. External checks take approximately 0.23–0.40 seconds, within their 60-second limit. ECHILD follows the observed direct wait by about 51 ms.

All four test-stage HOME, HUD_HOME and TMPDIR inventories are empty afterward. Build-stage HOME/HUD_HOME are empty; build TMPDIR contains only its recorded, stage-owned Node compile-cache directory and file. Those retained compiler caches are not unclosed processes or test-fixture residue. Do not claim every build temporary directory is empty.

The preserved result label is **exit_status_observed_exec_unverified**. These are observed direct statuses, normal owned-descendant closure and no reported exec error, not independent exec attestation or a global assertion about arbitrary escaped processes. They do not resolve historical unknown sessions or expand capability evidence.

## Final frozen-candidate identity

The original records lacked a post-controls frozen-candidate check. The dispatcher obtained the precise read-only check rather than rerunning any workload.

The new record begins at **2026-11-04 04:14:44.132273 UTC**, monotonic `16998815915425`, and ends PASS at **04:14:44.523049 UTC**, monotonic `16999206698024`. Raw record SHA-256:

`61985e1c179f6b3cab533e7de362d08e7247536008fa317d05cf2aeb457a0c4b`

The raw git identity is the exact candidate and tree above. Working status and ignored inputs are empty. Every one of 1,315 tracked records has actual Git blob equal to expected; 275 are dependencies. Original `intents.ts` is restored/preserved as blob `422870d6c487b43e23636b0bb1d40062f1ec434d`, SHA-256 `6446bdd488b5a7134ca444df4ffcfb36803489f222017ebcc2c523f2830e4842`. The original candidate manifest, Node, Python, env, timeout and prior stage-6 launcher identities match.

Existing production/test/MCP output inventories retain 1,101 / 1,047 / 264 entries and match the recorded clean candidate. Committed and pending diff-check records each have status 0 and empty stdout/stderr. These are identity/hygiene checks, not formatting.

Leaving the declared mutants preserved in separate evidence checkouts is acceptable. The final candidate is clean and unchanged; there is no reason to erase mutant evidence or mutate the frozen candidate in order to demonstrate restoration.

## Shortest remaining path

1. Archive this scoped acceptance alongside the raw bundle and retain the prior Node 24 positive results. Release the control execution lease. No implementation fix round and no repeat of A–D are warranted.
2. The next useful verification tranche is the two already-required affected regression groups below on the unchanged Node 24 candidate, using fresh identity checks and the existing clean compiled graphs. Obtain a named quiet-window and matching reviewed supervision admission that preserves their original 600-second requirements. This review does not implicitly stretch the previous 300-second test cap or assign a compute lease.
   - `NODE --test dist-test/tests/unit/ledger-write.test.js dist-test/tests/unit/b11-cli.test.js dist-test/tests/unit/b21-capacity.test.js dist-test/tests/unit/b6-wait-status.test.js`
   - `NODE --test packages/hud-mcp/dist/tests/hud-mcp/authorization.test.js packages/hud-mcp/dist/tests/hud-mcp/delegation.test.js packages/hud-mcp/dist/tests/hud-mcp/resume-expected-run.test.js packages/hud-mcp/dist/tests/hud-mcp/handshake.test.js packages/hud-mcp/dist/tests/hud-mcp/hook-source.test.js packages/hud-mcp/dist/tests/hud-mcp/b20-advice.test.js`
   Here NODE is the pinned absolute executable, not an unverified PATH selection. Existing ledger-write coverage need not be rerun merely to relabel it, but the prescribed group and its distinct obligations must be reported accurately.
3. Complete applicable focused positive and isolated-control coverage on supported Node 22 >=22.13 under a separately identified, authorized runtime window. Do not install or switch runtimes implicitly.
4. Resolve the separate exact-formatter setup requirement, then perform four-path check-only formatting and whole-package format:check. Neither whitespace checks nor these controls replace formatting.
5. Finish the remaining exact-final-tree README/P065 inventory and shared-writer security/lifecycle coverage. The already accepted stage-5 CLI-to-MCP original-proof/budget/one-launch replay case is run and passed; do not mark that named case unrun or mistake it for every wider obligation.
6. Preserve all original Node 22/24 real-clock populations, samples, overruns and three isolated series per family, unchanged preparation-inclusive 30 ms and cumulative wait 20 ms limits, busy_timeout=0, full-response/joint gates and separate local-only qualification. These deterministic controls do not satisfy them.

Known denied Unix-path listen and PTRACE_TRACEME paths remain blocked/unrun where unchanged aggregates would retry them. Do not rerun a denied operation, change transport/executor/permissions to evade it, skip assertions, or call focused results a full green aggregate. Existing local-testing withdrawal remains binding. No full acceptance, gate/profile/contract relaxation, WIP dependency shortcut into NEXT, main write, force-push, merge or deployment follows.

## Raw test output identities

- A: `85eff0e07d6b501d4514aa91485bc114e171023a35c111e8af4b3e29f5ec6803`
- B: `6442c30aa000ce7713a2627f651f91da007c12945901f9914eabc49f08c5af8b`
- C: `09eaa586c7abfaaea1854eb55a9d84237856561a9fabababf2008e87c21f73f6`
- D: `519b038873522dee21d0d619b9a2b81f5d78adfe92320864c671a38db42a7072`

Every build stdout, every workload stderr, every raw outer stdout/stderr and external-check stderr in the bundle has the empty-file identity. Full launcher, manifest, output, lifecycle and pre/post identities remain in the verified 137-entry SHA256SUMS rather than being duplicated here.

## Sources and method

- [Governing rejection-audit repair ruling](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/cloud/rulings/p065-rejection-audit-repair-20261104.md), also read from current universal-hud.
- [Pinned candidate](https://github.com/CartmanFatass/codex-hud/commit/3435589ef253159948c94eaae111606191bd4e3d).
- [Candidate catch implementation](https://github.com/CartmanFatass/codex-hud/blob/3435589ef253159948c94eaae111606191bd4e3d/src/ledger/intents.ts), [deterministic SQLite tests](https://github.com/CartmanFatass/codex-hud/blob/3435589ef253159948c94eaae111606191bd4e3d/tests/unit/p065-rejection-audit.test.ts), [real process tests](https://github.com/CartmanFatass/codex-hud/blob/3435589ef253159948c94eaae111606191bd4e3d/tests/unit/ledger-processes.test.ts), [child fixture](https://github.com/CartmanFatass/codex-hud/blob/3435589ef253159948c94eaae111606191bd4e3d/tests/ledger/process.mjs).
- [Current P065 checks and denied-operation scope](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/P065-BUDGET.md).
- The supplied preliminary review and previous Node 24 focused Oracle review, and the exact recorded cloud turns and complete raw archive identified above.

Method: read-only connector/source/task inspection; supported archive materialization; offline text, ZIP, JSON, hash, diff and inventory comparisons. The archived launchers/checker/wrapper were read as data and never executed. No tests, compiler, formatter, benchmark, dependency setup, process probe, source/repository mutation or new execution task was run by this reviewer. Local writes were limited to evidence-transfer support and this requested standalone review.

**Final disposition: C-A, C-B, C-C and C-D accepted for Node 24. No control-related blocker or source fix remains. Complete repair/P065 acceptance and all broader gates remain pending.**

