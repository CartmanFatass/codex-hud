# P065 Node 22 controls A/B: independent Oracle review and C/D continuation

Date: 2026-11-04 UTC. Repository: CartmanFatass/codex-hud. Read-only review of the partial control tranche, its admission supplement and the recorded pause.

## Decision

**ACCEPT the Node 22 A and B negative-control evidence at candidate `306fa579c2b7fffabbc0fc1739ed0d25f22faac3`. Both exact isolated mutations compiled, produced all required named behavioral failures, and completed authoritative direct-status and owned-process closeout. B's single existing busy-only caller retry is permitted by the governing audit ruling; it is not a suite rerun, audit retry or same-call budget reset. No A/B repetition or source repair is indicated.**

**C and D remain NOT RUN. They may continue as four remaining stages, C build/test then D build/test, in a newly confirmed named bounded window, after the small independent-checker and receipt corrections in §6.** The recorded pause was a cautious response to ambiguous shorthand, not evidence that B's behavioral control failed. Clarify the continuation dispatch explicitly: no workload/suite reruns; the unchanged, expressly approved busy-only caller retry is not revoked.

The positive Node 22 tranche and historical Node 24 acceptances remain intact. This review is not a compute lease, full A–D completion, P065 package acceptance, performance qualification, NEXT dependency acceptance, integration or merge permission. **P065 remains WIP / NOT ACCEPTED / NOT MERGEABLE / NOT PERFORMANCE-QUALIFIED.**

## 1. Evidence and identity

- Candidate: `306fa579c2b7fffabbc0fc1739ed0d25f22faac3`.
- Tree: `bf00473136dc42cb5a0d320447239e848592270e`.
- Clean checkout: `/workspace/p065-node22-successor-verify`.
- Separate mutant checkouts: `/workspace/p065-node22-control-a`, `-b`, `-c`, `-d`.
- Evidence/launcher/checker root: `/workspace/p065-node22-controls-01`.
- Cloud task: `01a1a3c0-8454-762a-a04c-d71a10b710c9`.
- Recorded execution turn: `01a1a4ff-d959-763e-bc02-51fb01568fb5`, completed.
- Archive: `p065-node22-controls-partial-evidence.zip`, **2,032,055 bytes**.
- Library: `libfile_9754779318f48191b6bbad9e46a24a2c`; file: `file_0000000067d081f583b6d4e0750ac05b`.
- Independently calculated archive SHA-256: **`af7e75f07377b5ff714ef1dd895de8192fbb430fc8339bccb1a27f070e9837d2`**.

I obtained the actual archive through the supported Library transfer route and verified every one of **96 listed file hashes**, with **97 unique ZIP entries** including `SHA256SUMS`, no omitted or duplicate listed member. The contents include raw A/B stdout/stderr and lifecycle events, eight A/B independent pre/post records, admission and final clean-candidate records, all four mutations/manifests, all eight prepared launcher files/diffs, both checker files/diffs, outer runner, status/time receipts and Git-command descriptions.

There is no C/D build/test event stream, compiled baseline, raw workload output or completed pre/post execution record in the partial archive. The completed task report independently says C/D were not launched. Prepared C/D scripts and manifests are preparation evidence only.

The governing audit ruling, supplied Node 22 validation plan, Node 22 positive review and prior Node 24 controls review were read. I also read the exact recorded dispatcher instruction and execution report, the retained exact-source bytes, and the complete untruncated immutable GitHub tree response supplied by the earlier positive review. Every relevant source hash and full tracked map was recomputed/compared rather than accepted from a summary. This review does not claim a fresh live inspection of the other executor's worktrees or binaries.

Runtime remains **Node v22.23.4** at `/workspace/p065-official-tools-01/node-22.23.4/bin/node`, SHA-256 `94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90`. Python remains `/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin/python3`, SHA-256 `fa67443527ed9647f760d807e2a38f26340757123e643c4639cf273ed15d5ea7`. The four recorded stages and external checks pin these identities. TypeScript and all 275 dependency entries remain unchanged; their historical installation provenance remains unverified. Matching recorded binary hashes does not add a new distribution-signature attestation.

## 2. A/B behavioral findings

Both builds ran the pinned absolute Node executable with:

`./node_modules/typescript/bin/tsc -p tsconfig.test.json`

Both exited 0 with empty stdout/stderr and freshly produced their own test graph. Each test command appears once in the supplied execution sequence.

### A: completion enforcement replaces the established refusal

Exact mutation: replace the entire first swallowing completion-observation try/catch with the unguarded `if (!auditUnsafe) budget?.check('complete');`.

Command after the pinned Node:

`--test dist-test/tests/unit/p065-rejection-audit.test.js`

Observed: **8 tests, 5 pass, 3 fail, direct/outer exit 1/1**. Suites, cancellations, skips and todo are zero. TAP duration is 209.748386 ms, not performance-qualification evidence.

Required failures are present at **30 ms and 30.001 ms**. The error-identity assertion receives `CallBudgetExpired: ledger_busy` from `CallBudget.check` / the mutated `acceptIntent` completion call instead of the actual callback's `idempotency_conflict`. This is the intended control of primary-error priority, not an import/compiler failure or manufactured business conflict.

The third failure is the previously explained observation case: `synthetic_clock_observation_failure` propagates through `CallBudget.now`, `note`, `check` and the same restored unguarded completion call, replacing the real conflict. It is a direct consequence of the declared mutation. The other five audit cases pass.

### B: removing the rejection insertion removes the required audit

Exact mutation: remove only the rejection `insertRecord` invocation and its object argument. Keep the optional transaction, local guard and original budget checks.

Command after the pinned Node:

`--test dist-test/tests/unit/ledger-processes.test.js dist-test/tests/unit/p065-rejection-audit.test.js`

Observed: **23 tests, 19 pass, 4 fail, direct/outer exit 1/1**. Suites, cancellations, skips and todo are zero. TAP duration is 2620.129868 ms, not performance-qualification evidence.

All three required zero-versus-one failures occur:

1. The real concurrent same-key/different-parameters process case reaches the unchanged exact-one `intent.rejected` assertion and observes zero. Earlier assertions still establish one fulfilled result, one actual `idempotency_conflict`, complete accepted state/integrity and accepted-run association before this final failure.
2. The deterministic **29.999 ms** eligible-boundary case reaches `eligible rejection must commit exactly one audit event` and observes zero.
3. The eligible original-budget/actual-spent-lock-wait case reaches the same exact-one assertion and observes zero.

The fourth failure is the known real-SQLite trigger consequence. Removing the only rejection insertion prevents the trigger from firing, so the optional audit transaction ends in **COMMIT**, where the unchanged test expects **ROLLBACK**. The raw trace otherwise retains first transaction invocation, BEGIN, callback, ROLLBACK and second invocation/BEGIN/callback. This is an explained consequence of the mutation, not a new unrelated failure.

B executes the full 15-case process file plus eight audit cases. All nine SIGKILL-cut cases and the reconcile/contention cases pass. Real children, IPC, actual SQLite and the unchanged owned-child teardown remain present. A failing mutant test stops at its first failed assertion; this review does not claim that later assertions in that case also executed.

SQLite ExperimentalWarning text is retained in TAP stdout. Workload stderr is empty. The existing process fixture buffers its children's stderr for error reporting; this archive is not a new independent per-grandchild stderr capture.

## 3. B's busy-only retry and the dispatcher wording

The raw B output records exactly one diagnostic:

`Concurrent intent exhausted its 20 ms busy budget; retrying the same request once after the competitor committed.`

The governing audit-repair ruling **§5A expressly preserves this existing at-most-one caller retry**, only for an explicit initial `ledger_busy` after the competitor responds. The Node 22 plan §3 and the accepted Node 24 controls review make the same distinction. The positive Node 22 tranche also already retained this permitted diagnostic.

The exact-source `concurrentIntents` helper confirms the scope:

- Both ready children receive their first requests through the initial map before either outcome is awaited.
- The helper waits for both first outcomes and requires at least one fulfilled result.
- A fulfilled result is preserved. A rejection other than `ledger_busy` is returned unchanged.
- Only an explicit initial busy rejection invokes the same child request once more with the same fields. There is no loop or repeated test command.
- For this selected audit-positive case, the child creates a fresh trusted test budget for each actual request, before preparing/calling `acceptIntent`; that request passes the same budget through its transactions and optional audit. A separate request is not a reset of the first request's spent budget.

The recorded dispatcher instruction says to run the exact unchanged, previously accepted controls and also says, generally, “No retries, installs, formatting, performance or other workloads.” Read in that scope, **“No retries” bars repeated execution of a failed control/build/test command, not the already specified behavior inside the expressly selected unchanged test.** It does not specifically withdraw the governing busy-only exception or authorize editing the test to remove it. The surrounding process suite also contains deliberate recovery/replay requests as part of its assertions; its intended semantics cannot be read as banning every second request of any kind.

Thus B's evidence is usable. Do not describe both initial attempts as reaching their final business outcomes without a retry. Do not remove the diagnostic, call the suite unconditionally green, classify this as a permitted arbitrary flaky-suite rerun, retry a conflict/audit, poll for an event, or change assertions. The conservative pause is understandable; no penalty, source fix or repeated B workload follows from it. The continuation dispatch should state the distinction explicitly so the remaining work is not paused for the same ambiguity.

## 4. Source isolation, outputs and supervision

### Exact mutations and full-tree checks

All four literal mutation diffs have the accepted identities. Applying each solely in memory to the pinned original `intents.ts` reproduces the intended mutated SHA-256 and Git blob. None of these reconstructed files was executed.

| Control | Mutation diff SHA-256 | Mutated intents.ts SHA-256 |
|---|---|---|
| A | 2f240421eb50209dc89d45cf1b02252c284576b952b5e96cfcc97418de7f4105 | 69e0b349d541831053e92bff94d7854f068c84c21526a987f4cbfed298790d8b |
| B | 17a7659ed635a1e002e6caf03a2d15a50191582630277c667cdb711403296dd3 | 85aa5fe8737c03f1c9e6b1c2199129e5f99e312b2cecd9bdc554b7e93ad7329f |
| C | 2a8276ae93be310ad75e53836c90d1a54ffa1a3e3b815e55380eab27e9550e56 | 51ff29fdad75dd07084b9371c4cdd61761e5700890df76addf894e9afddf5fb3 |
| D | 22d5c8029849a55f48140fadbc46a4bd0acf242e2d62d48ae345aa2336a03b7e | c7be61a5497e6c1ede3af30b927519e3f78ad51c60113559c3df52826e9a5afe |

All four manifests identify the exact final source/tree, contain the same 33 selected source files and five build-configuration files as the clean manifest, and differ only at `intents.ts`. They correctly retain the final mechanically formatted budget test, not its earlier source hash. These selected manifests are not themselves the full tracked inventory.

Each of the eight A/B before/after records contains **1,320 unique tracked leaves**, including **275 dependency entries**, with its index expected blob equal to the immutable final tree. All 1,319 non-mutated paths have the clean candidate's exact actual blob and SHA-256. The sole working-tree status is ` M src/ledger/intents.ts`, with no unexplained ignored input. The checker checks index stage, rejects unexpected source symlinks and checks Git executable-bit agreement. Source mode values are not emitted in every tracked row; do not claim a richer historical source-mode record than this.

For A and B separately, `dist-test` is explicitly absent before compilation. Fresh output has **1,047 entries**. Build-after, test-before and test-after inventories are identical including the newly recorded modes; the supervisor's corresponding content inventory matches after normalizing only `size`/`bytes` and its older omission of modes. Against the clean Node 22 test graph, the **only** differing paths are `src/ledger/intents.js` and `src/ledger/intents.js.map`. No test or other generated executable was changed.

The task reports an offline preparation `KeyError` before any build/test was launched, followed by correction without reapplying A's mutation. The preparation program's full trace is not in this archive, so that account is not independently reconstructed. The complete final manifests, diffs, launcher checks and pre-run full-tree maps establish the actual inputs used. There is no evidence here of a repeated test/build workload or a source delta beyond the exact mutation.

### Launcher and lifecycle verification

All **eight** complete launcher/diff pairs, including the unexecuted C/D preparation, independently reconstruct the same accepted supervisor base:

`c4f56dc06cf481df00ca5e23539f319a6fe362c4a1ee591d94590115742b6e5b`.

The literal diffs contain only the permitted label, Node/checkouts/source/tree/manifest/evidence pins, exact test argv, fresh-output prerequisite and prescribed deadline substitutions. Lifecycle, gate, exec-error channel, subreaper, pidfd, signal and reaping logic is unchanged.

Build limits remain **180/10/210 seconds**, outer **230 seconds** plus TERM kill-after 10. Test limits remain **300/10/330**, outer **350 seconds** plus kill-after 10. The outer wrapper retains `env -i`, PATH `/usr/bin:/bin`, LANG `C.UTF-8`, TZ `UTC`, absolute pinned Python with `-I -S -B`, foreground timeout and `/dev/null` stdin. Every inner workload has exactly the six declared environment keys and unique HOME/HUD_HOME/TMPDIR. No added runtime flag, harness variable, NODE_OPTIONS or warning suppression appears.

Each of the four ten-event streams has verified subreaper readback 1, initial ECHILD, a gated direct child with pidfd, release, completed exec-error pipe with no error, exactly one authoritative direct wait status, terminal ECHILD, final EOF/release state, identical pre/post 45-entry identity map, and successful lifecycle/closure/postcheck flags. No timeout, unexpected adopted descendant, signal intervention, interrupted status or postcheck failure is present.

| Stage | Direct / outer exit | Direct PID | Direct wait monotonic ns | Terminal ECHILD monotonic ns | Outer UTC interval |
|---|---:|---:|---:|---:|---|
| A build | 0 / 0 | 7237 | 21193659620208 | 21193710534293 | 05:24:26.665980–05:24:39.237462 |
| A test | 1 / 1 | 7278 | 21197076019154 | 21197126878064 | 05:24:41.999763–05:24:42.603929 |
| B build | 0 / 0 | 7349 | 21231333473843 | 21231384475018 | 05:25:04.516514–05:25:16.857788 |
| B test | 1 / 1 | 7390 | 21236953237944 | 21237004261574 | 05:25:19.469511–05:25:22.489153 |

All UTC intervals are 2026-11-04. Event monotonic order and outer envelopes agree. Each independent precheck finishes before its workload, and its postcheck begins afterward and finishes before the next workload. All are within the prescribed 60-second independent-check limit.

The preserved result is **`exit_status_observed_exec_unverified`**, with `exec_state=no_error_reported`. This establishes observed direct status and normal owned-process closure, not independent exec-syscall attestation or a global assertion about arbitrary escaped processes. The historical `compiler_result` field also names the test-stage result; it is not another compiler run.

A/B test HOME, HUD_HOME and TMPDIR inventories are all empty. Build HOME/HUD_HOME are empty; each build TMPDIR contains only its recorded Node compile-cache directory, version directory and one cache file. Do not claim build TMPDIR is empty.

## 5. Admission supplement and final clean candidate

The strengthened admission checker exactly reconstructs from the retained positive-tranche checker plus its archived diff. It adds file-mode recording, explicit `os.walk` traversal-error propagation and required existence/type/hygiene checks for all six actual positive-stage temporary roots. The control checker likewise reconstructs exactly from the old control checker plus its declared diff.

The new admission observation runs **05:20:54.231649–05:20:54.548785 UTC**, monotonic **20968915294144–20969232432609**, PASS. It is a new supplement, not a retroactive addition to the earlier six positive-stage execution records, despite its reused `stage=6, phase=after` fields.

It verifies the exact clean source/tree, all 1,320 leaves and 275 dependencies, empty status/ignored-input lists, approved Node/Python/env/timeout/manifest identities, all three existing generated graphs and all eighteen positive-stage HOME/HUD_HOME/TMPDIR roots. Test roots and every HOME/HUD_HOME are empty; only the three previously identified build cache residues remain.

The original content baselines are preserved rather than reset. Current graph path/type/size/hash data match them completely. Newly recorded mode distributions are:

- Production: **1,101 entries**, 24 directories `0700`, 1,077 files `0600`.
- Test: **1,047 entries**, 40 directories `0700`, 1,007 files `0600`.
- MCP: **264 entries**, 23 directories `0700`, 241 files `0600`.

The post-A/B clean-candidate record runs **05:25:32.903152–05:25:33.217586 UTC**, monotonic **21247586797952–21247901233575**, PASS. Its raw SHA-256 is **`83bee0dc2e201e3e0b4ca376c27d9b464ae565256e198282e7dbf77c6b852d90`**. Its complete tracked map is equal to admission, with original `intents.ts` SHA-256 `6446bdd488b5a7134ca444df4ffcfb36803489f222017ebcc2c523f2830e4842`, Git blob `422870d6c487b43e23636b0bb1d40062f1ec434d`. All three complete generated graphs, **including current modes**, are equal between these two supplemental observations and retain the original Node 22 content baselines.

`git-commands.txt` names the exact required committed repair range, formatting-parent range, pending `git diff --check`, and full porcelain status. The three diff receipts each have status 0 and empty stdout/stderr; the status text is empty. This closes the missing pending-diff receipt itself. It is not a formatter result. The receipt set still lacks the requested **per-command UTC/monotonic boundaries and a command-bound execution record**; a separate text command list plus named result files is weaker than that record. Do not invent those timestamps. The independently verified source maps establish no pending tracked drift and support the observed outcomes despite this documentation limitation.

Current mode observations cannot prove modes at the six earlier historical positive-stage instants. That disclosed limitation remains. The admission checker strips modes when comparing against the old mode-less baseline; I separately compared the entire admission and final maps, including modes, and found them equal.

## 6. Exact C/D continuation and small remaining checker corrections

A/B need no repeat. The minimum remaining workload is **four stages**, not the whole positive or control tranche. Reconfirm the existing authorized executor, no competing workload/writer, and a named bounded C/D window; this review itself assigns none.

Before C build:

1. **Tighten only the independent control checker’s test TMPDIR predicate.** Its current code allows arbitrary entries below `node-compile-cache/` for both builds and tests. That is broader than the requirement that test roots be empty. The observed A/B test roots are actually empty, so no failed hygiene is concealed in this evidence. For future test postchecks require `TMPDIR == []`; retain the explicitly inventoried compile-cache exception only for builds. Keep HOME/HUD_HOME required empty, missing/unreadable roots failing, and all traversal-error and mode recording already added. Save a new version/diff/hash without overwriting the reviewed historical checker evidence. Do not alter the supervisor or project source.
2. During the fresh read-only clean-candidate admission check already needed after the pause, retain **command-bound argv, cwd, UTC/monotonic start/end, status and raw stdout/stderr** for the three exact `git diff --check` invocations and `git status --porcelain=v1 --untracked-files=all` listed in this archive. Date them as new observations. This is bounded hygiene work, not a test/formatter replay.
3. Recompare clean source/dependencies and all three generated content maps with their **original Node 22 baselines**, and compare current modes with the **05:20:54 admission supplement** now preserved here. Do not discard modes again merely because the older baseline lacks them. Preserve all prior evidence. Stop on drift, unreadability or unexplained residue rather than deleting/rebuilding to make the check pass.
4. Freshly verify the prepared C/D isolated checkouts: exact final HEAD/tree; all 1,320 tracked leaves; only the appropriate `intents.ts` mutation; exact manifests and launchers; no unexpected ignored inputs; `dist-test` absent and each actual C/D stage evidence root unused. Their precreated, never-built checkouts may be used if these checks pass. Do not reapply mutations, reset an unexplained checkout, reuse A/B outputs, or create another worktree merely for bookkeeping.

Then, separately for **C** and **D**, use the already prepared pinned Node launcher to compile once with:

`/workspace/p065-official-tools-01/node-22.23.4/bin/node ./node_modules/typescript/bin/tsc -p tsconfig.test.json`

After successful fresh compilation, run once:

`/workspace/p065-official-tools-01/node-22.23.4/bin/node --test dist-test/tests/unit/p065-rejection-audit.test.js`

Retain the existing 180/10/210 and 230-second outer build limits, 300/10/330 and 350-second outer test limits, separate roots, 60-second external checks, exact environment and full owned-lifecycle requirements. Only the test graph is needed. No production or MCP rebuild, installer, formatter, source repair or other workload is included.

**C** removes the entire remaining-time eligibility operand, including the numeric alternative and connector, retaining unsafe/security exclusions and deeper enforcement. Required failures at **30 and 30.001 ms** are transaction-invocation count **2 versus 1**, even though deeper enforcement prevents an audit commit. The previously explained additional observation-case failure is the same scheduling consequence.

**D** changes the final optional-audit catch to rethrow `auditError`. Required failures are original-error identity for **queued expiry** and the **actual SQLite rejection-insert trigger**, where optional-audit errors displace the real callback conflict. The previously explained observation-case identity failure is also expected.

The known 5-pass/3-fail-of-8 outcome shape is a guide, not automatic acceptance. Require the actual named failures, successful build, no cancellation/skip/todo, declared direct/outer outcomes, ECHILD and complete postchecks. Unexpected green, unrelated failure, timeout, denied action, input drift or uncertain cleanup stops dependent work. Do not rerun a failed command or alter a mutation/assertion to force the expected shape.

The reviewed prepared C/D launcher SHA-256 values are:

- C build: `2f8ef8caf95d7bf1aa3c28d6ed708ec1595346c27544ca39562bd15f6d7b3ae0`.
- C test: `1abee7751cf76da68a0a0615cebb93b9a4f5b90c53c38d7e4f5ed1799b4a89ff`.
- D build: `7a21c131cbaa7b49a03d4321d1ed43ec315833efd3b8a5f0cc3a38ea57bc8d4e`.
- D test: `74c974df3be96f412218d86c29736e100a1a6f7e8704575b35b420f751e8fa22`.

After C/D, retain a **newly dated final clean-candidate check** of full source/configuration/dependencies, empty status, original generated content baselines and supplemental mode baseline. The existing post-A/B record is not post-C/D evidence. Archive complete new raw files/checker diffs/hashes and return the lease after authoritative cleanup. Preserve this partial bundle unchanged; do not replace it with an apparently continuous history that hides the pause.

## 7. Acceptance boundaries and useful custody hashes

Accepted here: Node 22 A/B focused negative controls, observed source/output isolation, actual direct status/owned closure, and the substantive admission/final metadata observations with the receipt/checker limits above. No new P0–P2 source finding or implementation fix round is indicated.

Still outstanding or separately governed:

- C/D execution and review; then any scoped final P2 audit-repair disposition using both runtime families and their exact source relationship.
- Required audit-four-path check-only formatting and full final-source `format:check`; separate FMT-1 acceptance remains unchanged.
- Separately admitted Node 22 affected regressions with their 600/10/630 and outer 650-second limits. Existing Node 24 group 1 remains 57/57 with both wrong-target FAIL and corrected PASS records; group 2 remains 61/62, exit 1.
- The denied B20 startup `/proc/5200/environ` operation and its historical unobserved process role. No unchanged replay, reused-PID inference, parent/transport/executor workaround, startup suppression, ancestor-scope transfer or MCP-ANCESTOR import is released.
- Known denied Unix-path listener and PTRACE_TRACEME operations and their containing unchanged broad aggregates. Focused evidence is not full npm test/mjs/hud-mcp success.
- Remaining exact-final-tree README/P065 shared-writer, security, lifecycle, fixture and real-harness/platform gates.
- Original real-clock populations, required samples and at least three isolated measured series per Node family; preparation-inclusive 30 ms, cumulative wait 20 ms, `busy_timeout=0`, actual overruns and full-response/joint gates. Deterministic controls are semantic evidence only.
- Separate local-only qualification and the user's withdrawal of assistant-run local testing. No local restart is implied.
- Full package acceptance, NEXT consumption, one-merger integration, actual merged-tree green gates and merge. No main write, force-push, deployment, WIP dependency shortcut or fix-round reset follows.

Additional custody identities:

| Artifact | SHA-256 |
|---|---|
| A raw test stdout | bfbcb6461d2529874722876c78e6fa5dbe1f1302127c2fb21d8e0b2baee560cf |
| B raw test stdout | 4cea0650b808846c237a7473e49d6e82762049fa9c3f5161f2b3eaee3c3ee81b |
| Admission checker | f7eef2dbef84c23ccddd974dcc085acfcd8ad442923088906303b980224891d2 |
| Current control checker | 4328a887603c7bd51cd5977d7045a149afc6535ebb3ab133b1ae08664bab146c |
| Outer runner | d0e8becccde232ae2688c91c3cbc8fea32f55a9a3f0a641d599442cdd838b6f6 |
| Admission record | bdb14692e3bad0781325a34d5b94ad2b13f8e5f725f15c68a29033cd2d3bd5c9 |
| Post-A/B clean record | 83bee0dc2e201e3e0b4ca376c27d9b464ae565256e198282e7dbf77c6b852d90 |

All other per-file identities are in the verified `SHA256SUMS`. Build stdout, workload stderr, outer stdout/stderr and independent-check stderr are empty. Empty streams do not substitute for the nonempty result/event/check records reviewed above.

## Sources and method

- [Exact candidate](https://github.com/CartmanFatass/codex-hud/commit/306fa579c2b7fffabbc0fc1739ed0d25f22faac3) and its retained complete immutable tree response.
- [Governing audit-repair ruling](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/cloud/rulings/p065-rejection-audit-repair-20261104.md), especially §5A and the control/stopping provisions.
- [Exact process test](https://github.com/CartmanFatass/codex-hud/blob/306fa579c2b7fffabbc0fc1739ed0d25f22faac3/tests/unit/ledger-processes.test.ts), [child fixture](https://github.com/CartmanFatass/codex-hud/blob/306fa579c2b7fffabbc0fc1739ed0d25f22faac3/tests/ledger/process.mjs), [audit tests](https://github.com/CartmanFatass/codex-hud/blob/306fa579c2b7fffabbc0fc1739ed0d25f22faac3/tests/unit/p065-rejection-audit.test.ts), [audit implementation](https://github.com/CartmanFatass/codex-hud/blob/306fa579c2b7fffabbc0fc1739ed0d25f22faac3/src/ledger/intents.ts).
- Supplied Node 22 validation plan and positive review, accepted Node 24 controls review, and both retained earlier raw archives used for checker, source and output-baseline comparisons.
- Recorded dispatcher command and completed partial-tranche report in the cloud task/turn identified above; actual partial ZIP contents, not merely its reported digest.

Method: read-only connector/task/source-record inspection, supported archive download, offline hashing, complete JSON/map comparison, TAP/launcher/checker reading and exact in-memory diff/reverse-diff reconstruction. No archived supervisor/checker, project build, test, formatter, benchmark, fixture, process/capability probe or denied operation was run. No repository, source, branch, historic evidence or permissions were edited. Local writes contain only review inputs, an offline evidence-inspection helper/results and this requested ruling.

**Final disposition: A and B accepted; busy-only caller retry authorized and distinct from a suite retry; C and D may continue after the specified narrow preflight/checker corrections in a renewed bounded window; all wider package holds remain.**
