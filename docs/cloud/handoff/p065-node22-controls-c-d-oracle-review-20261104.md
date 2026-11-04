# P065 Node 22 controls C/D: independent Oracle review

Date: 2026-11-04 UTC. Repository: CartmanFatass/codex-hud. Fresh read-only review of the remaining four control stages.

## Decision

**ACCEPT the Node 22 C and D behavioral negative-control evidence for `306fa579c2b7fffabbc0fc1739ed0d25f22faac3`. Both exact isolated mutations compiled successfully, produced every required named failure, and completed authoritative direct-status and owned-process closeout. The newly dated post-C/D clean-candidate observation verifies unchanged source, dependencies and generated content, including equality to the supplemental output-mode baseline. No C/D rerun or source repair is indicated.**

Together with the separately accepted A/B evidence, the four Node 22 audit controls are now behaviorally complete. The preceding six-stage positive Node 22 tranche and historical Node 24 acceptances remain intact, with their original source identities and disclosed limits.

**The initially missing command-bound Git hygiene receipts are now supplied and accepted.** The C/D archive itself reused the old A/B receipts; a distinct, newly dated read-only supplement from turn `01a1a515-730b-74a0-bc44-e4c49fe747ba` supplies actual per-command argv/cwd/times/status/raw outputs and another complete candidate check. Its exact bytes and all 26 listed hashes verify. Preserve the distinction between the original C/D execution and this later supplement; no project workload was replayed to close the gap. Details are in §6.

This is focused control-evidence acceptance, not final P2 repair disposition, P065 package acceptance, performance qualification, NEXT dependency acceptance, integration or merge permission. **P065 remains WIP / NOT ACCEPTED / NOT MERGEABLE / NOT PERFORMANCE-QUALIFIED.** This review assigns no compute lease and authorizes no project workload.

## 1. Evidence and fixed identities

- Candidate: `306fa579c2b7fffabbc0fc1739ed0d25f22faac3`.
- Tree: `bf00473136dc42cb5a0d320447239e848592270e`.
- Sole parent: `9fbf258a704e8fdfb99febae2635261a63ade5f6`.
- Clean checkout: `/workspace/p065-node22-successor-verify`.
- Separate mutants: `/workspace/p065-node22-control-c` and `/workspace/p065-node22-control-d`.
- Launcher/checker/evidence-record root: `/workspace/p065-node22-controls-01`.
- Cloud task: `01a1a3c0-8454-762a-a04c-d71a10b710c9`.
- Execution turn: `01a1a50d-16e7-706b-8f79-c9cd9130cd74`, recorded completed.
- Archive: `p065-node22-controls-cd-evidence.zip`, **3,764,866 bytes**.
- Library: `libfile_aea8d1047a4481918b464b2fcf5c18f4`; file: `file_00000000096c81f5a96fd44e42ca76ad`.
- Independently calculated archive SHA-256: **`99b8c68c9c79043823c2df6c2cff5a3d384f6a0659dde03f7647660666d19de5`**.

Actual bytes were obtained through the supported Library route. All **143 listed file hashes** verify; the ZIP has **144 unique entries**, including `SHA256SUMS`, with no unlisted evidence member or duplicate. Its 84 overlapping evidence files are byte-identical to the accepted A/B bundle. The 12 A/B raw output/event files are not repackaged here and remain in that earlier immutable archive. This is a continuation bundle, not a replacement for the complete A/B evidence or an apparently uninterrupted run.

Read the governing audit ruling, supplied Node 22 validation plan, A/B review, positive review, historical Node 24 controls review, exact dispatcher continuation, completion report, retained exact-source files, and complete immutable GitHub commit/tree responses. The dispatcher explicitly limited the renewed continuation to C build/test and D build/test, prohibited A/B reruns, preserved the authorized busy-only caller retry, and required strict temporary-directory checks and final clean-candidate evidence.

Runtime remains **Node v22.23.4**, absolute executable `/workspace/p065-official-tools-01/node-22.23.4/bin/node`, SHA-256 `94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90`. Python remains `/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin/python3`, SHA-256 `fa67443527ed9647f760d807e2a38f26340757123e643c4639cf273ed15d5ea7`. All four stage identities retain these pins. No fresh live inspection of the other executor's binaries/worktrees, new distribution-signature attestation, or historical dependency-installation provenance is claimed.

## 2. Exact mutations and behavioral results

Both controls build once with the absolute pinned Node executable followed by:

`./node_modules/typescript/bin/tsc -p tsconfig.test.json`

Both builds exit **0**, with empty stdout/stderr. Each then runs once with the same Node followed by:

`--test dist-test/tests/unit/p065-rejection-audit.test.js`

Each test exits **1**, with **8 tests, 5 pass, 3 fail**, zero suites, cancellations, skips and todos. These are expected negative-control failures, not green suites. There is no import/compiler error, unexpected green result, unrelated failure or timeout in either run.

### C: removing audit eligibility schedules a forbidden second transaction

The literal mutation removes the entire remaining-time eligibility operand, including the numeric alternative and the preceding connecting `&&`. It leaves unsafe/security exclusions, the audit transaction body and deeper transaction enforcement unchanged.

- Mutation diff SHA-256: `2a8276ae93be310ad75e53836c90d1a54ffa1a3e3b815e55380eab27e9550e56`.
- Mutated `intents.ts` SHA-256: `51ff29fdad75dd07084b9371c4cdd61761e5700890df76addf894e9afddf5fb3`.
- Mutated Git blob: `a989f3ecc698881a4ef57381dc9191ed733f42fc`.

The required named failures are present:

1. `P065 rejection audit: conflict rollback at 30 ms preserves the original refusal`.
2. `P065 rejection audit: conflict rollback at 30.001 ms preserves the original refusal`.

Both fail `only the eligible audit may schedule another transaction`, with **actual 2, expected 1**, at `assertBudgetCalls`. The original-error identity assertion precedes this count assertion and passes. Thus C detects scheduling a second transaction, rather than merely detecting whether the deeper guard permits a committed audit.

The third failure is the expected related case, `failed completion or eligibility observation cannot replace a real conflict`, also actual 2 versus expected 1 at the transaction-call count. Removing eligibility observation allows that extra invocation. The 29.999 ms positive, actual lock-wait budget-identity, pre-admission expiry, queued-expiry and SQLite-trigger cases pass.

A failing test stops at its first failed count assertion. Do not claim that its later trace, zero-row or complete-winner/integrity assertions executed in this mutant run. The unchanged source construction and separately accepted positive evidence remain available; the control's decisive observation is the forbidden second invocation.

Raw test stdout SHA-256: `0ce8d5a614287750c86d0a399925ad2ff94c6d7bc2605b932381e3b57f29a1e0`. TAP duration: 230.213422 ms, not numerical performance qualification.

### D: optional-audit errors replace the real conflict

The literal mutation changes only the final optional-audit catch to `catch (auditError) { throw auditError; }`.

- Mutation diff SHA-256: `22d5c8029849a55f48140fadbc46a4bd0acf242e2d62d48ae345aa2336a03b7e`.
- Mutated `intents.ts` SHA-256: `c7be61a5497e6c1ede3af30b927519e3f78ad51c60113559c3df52826e9a5afe`.
- Mutated Git blob: `45ebdefee5b3e3c03727d42cc80f5b13aa58b0a3`.

The required named failures are present:

1. `P065 rejection audit: eligible queued audit expires before BEGIN without resetting the budget`: `the original callback error must remain primary` fails because actual `CallBudgetExpired: ledger_busy`, from `CallBudget.check` / the real ledger queue, replaces the callback's `idempotency_conflict`.
2. `P065 rejection audit: real SQLite audit failure rolls back and preserves the original conflict`: the same identity assertion fails because actual `synthetic_rejection_audit_failure` replaces `idempotency_conflict`. The stack traverses actual `LedgerTransaction.run`, `insertRecord` and the optional audit callback; the error carries `ERR_SQLITE_ERROR`, errcode **1811**, `constraint failed`. The exact unchanged test installs the real SQLite `BEFORE INSERT` rejection trigger, not a fake rejected acceptance call.

The third failure is the expected observation case: `synthetic_clock_observation_failure` from `CallBudget.remaining` and the eligibility expression escapes through the changed catch. All three boundary cases, actual lock-wait budget identity and expired-before-admission pass.

The test first verifies that a real conflict callback threw, then fails on identity. Later transaction/row/integrity assertions in those failing cases do not execute and are not newly credited here.

Raw test stdout SHA-256: `a085e183f00847daf24b4338cdea978531c3438a264a9d4e9b825e571923da51`. TAP duration: 259.799266 ms, not numerical performance qualification.

Both TAP streams retain SQLite ExperimentalWarning text. Workload stderr is empty; warnings were not suppressed or misclassified as failures.

## 3. Source and generated-output isolation

Applying each mutation solely in memory to the retained original `intents.ts` reproduces its exact SHA-256 and Git blob. Original source SHA-256 is `6446bdd488b5a7134ca444df4ffcfb36803489f222017ebcc2c523f2830e4842`, Git blob `422870d6c487b43e23636b0bb1d40062f1ec434d`. These reconstructed sources were not executed.

The complete immutable tree has **1,320 leaves**, including **275 dependency entries**. Every one of the eight C/D independent pre/post maps has the same path set, index expected blobs and non-mutated actual blobs/SHA-256 values as that candidate. Only `src/ledger/intents.ts` differs, with the exact prescribed mutation for that checkout. All eight status records contain exactly ` M src/ledger/intents.ts`; all ignored-input lists are empty. The checker also enforces index stage, absence of unexpected source symlinks and Git executable-bit agreement. Per-row source mode values are not emitted, so this is not a complete historical source-permission record.

The two manifests retain the same **33 selected source files and five build-configuration files** as the clean positive manifest, with only the selected `intents.ts` entry changed. Their source/tree pins are the exact final candidate, including the mechanically formatted `tests/unit/p065-budget.test.ts`, not the earlier pre-format file. Full tracked-map verification, rather than those selected manifests alone, supplies complete-source/dependency coverage.

Each control has `dist-test` absent before compilation and an unused actual build/test evidence root as enforced by its independent precheck. Each fresh graph has **1,047 entries**. Build-after, test-before and test-after maps agree completely, including modes, and match the saved control baseline. Supervisor output maps agree after normalizing only `bytes`/`size` and their older omission of modes.

Against the clean positive graph, the **only differing paths** for each mutant are `src/ledger/intents.js` and `src/ledger/intents.js.map`. No audit test, fixture or other generated executable changed. The existing prepared C/D launcher and mutation bytes are unchanged from the A/B bundle. No A/B repetition is represented in this continuation.

## 4. Checker, launcher and owned lifecycle

The new `control-check-cd.py` is exactly reconstructed from the retained `control-check.py` plus its saved diff:

- New checker SHA-256: `bf788b2e6ce1df0f503945d55c9ab6a82ba79a9f67deb2c453a6310b953a09b3`.
- Diff SHA-256: `8637b6f4245c1a138ff5eb7ee19cda7c6a0e7d007076a2ccf9e27000746f362e`.

Its only functional change is the requested phase-specific TMPDIR hygiene: test TMPDIR must be empty; build TMPDIR accepts only the `node-compile-cache` directory, the explicit `v22.23.4-x64-9ac5647c-1000` version directory, and regular files with eight-lowercase-hex basenames directly inside it. Missing/invalid roots fail, traversal errors propagate, entry modes are recorded, and HOME/HUD_HOME remain required empty. This closes the previous overly broad test-cache allowance.

Observed C/D test HOME, HUD_HOME and TMPDIR are all empty. Build HOME/HUD_HOME are empty. Each build TMPDIR contains exactly the two named cache directories and one hashed cache file, not fixture residue:

- C: `ae017a96`, 1,322,036 bytes, SHA-256 `1a0a4bd503d3db56911432900053fe1ca4b84118ee3acf3593982a6d28cd60ba`.
- D: `9a331349`, 1,322,012 bytes, SHA-256 `5d080d23233b0b45357b099e33b869dfb87c143c157ef58d0f1bb17725717b59`.

The new outer runner differs from its accepted predecessor only by the two checker filename substitutions. Its SHA-256 is `7152fefc93b3fc1d593a14080a9bdce170aa04ef70a39a300e07135b5332df87`. All four complete launcher/diff pairs independently reconstruct approved supervisor base SHA-256 **`c4f56dc06cf481df00ca5e23539f319a6fe362c4a1ee591d94590115742b6e5b`**. Lifecycle, gate, exec-error pipe, subreaper, pidfd, signal and reaping logic is unchanged.

Launcher hashes:

| Stage | SHA-256 |
|---|---|
| C build | `2f8ef8caf95d7bf1aa3c28d6ed708ec1595346c27544ca39562bd15f6d7b3ae0` |
| C test | `1abee7751cf76da68a0a0615cebb93b9a4f5b90c53c38d7e4f5ed1799b4a89ff` |
| D build | `7a21c131cbaa7b49a03d4321d1ed43ec315833efd3b8a5f0cc3a38ea57bc8d4e` |
| D test | `74c974df3be96f412218d86c29736e100a1a6f7e8704575b35b420f751e8fa22` |

Build limits remain **180/10/210 seconds**, outer **230 seconds** plus TERM kill-after 10. Tests retain **300/10/330**, outer **350 seconds** plus kill-after 10. The wrapper retains `env -i`, absolute Python with `-I -S -B`, foreground timeout and `/dev/null` stdin. Each direct command has exactly HOME, HUD_HOME, TMPDIR, PATH `/usr/bin:/bin`, LANG `C.UTF-8` and TZ `UTC`, with unique stage-local roots. No new runtime flag, harness environment variable, NODE_OPTIONS or warning suppression is present.

Each ten-event stream records verified subreaper readback 1, initial ECHILD, one gated direct child with a pidfd, release, error-pipe EOF with no error, exactly one authoritative direct wait status, terminal ECHILD, final EOF/release state and matching 45-entry before/after identity maps. Direct/outer statuses agree. Lifecycle, closure and postchecks succeed; no unexpected adopted descendant, timeout, signal intervention, interruption or cleanup failure is present.

| Stage | Direct / outer exit | Direct PID | Direct wait monotonic ns | Terminal ECHILD monotonic ns | Outer UTC interval |
|---|---|---:|---:|---:|---|
| C build | 0 / 0 | 7900 | 21833925683750 | 21833976894879 | 05:35:05.896872–05:35:19.468997 |
| C test | 1 / 1 | 7941 | 21837301640579 | 21837352376402 | 05:35:22.166659–05:35:22.819733 |
| D build | 0 / 0 | 7995 | 21866692832815 | 21866744160789 | 05:35:38.586889–05:35:52.244462 |
| D test | 1 / 1 | 8036 | 21870205385278 | 21870256205356 | 05:35:55.070696–05:35:55.727437 |

All times are 2026-11-04. Monotonic and UTC ordering agree. Every independent precheck ends before its outer workload; every postcheck starts afterward and completes before the next workload. All eight checks finish within their 60-second bounds. Outer stdout/stderr and independent-check stderr are empty; raw stream digests agree with the supervisor postchecks.

Preserve **`exit_status_observed_exec_unverified`**, with `exec_state=no_error_reported`. These records establish observed direct status and normal owned-process closure, not independent exec-syscall attestation or a host-wide assertion about arbitrary escaped/unrelated processes. The historical `compiler_result` field also labels test stages; it is not evidence of an extra compiler invocation.

## 5. Newly dated clean-candidate observations

Both new observations use the retained admission checker, SHA-256 `f7eef2dbef84c23ccddd974dcc085acfcd8ad442923088906303b980224891d2`. They retain the exact source/tree pins, all 1,320 leaves, all 275 dependencies, Node/Python/env/timeout/manifest identities, empty status and ignored-input lists, all three generated graphs, and the eighteen actual positive-stage temporary roots. Both result records are PASS with separate status 0 and empty stderr.

| Observation | UTC interval | Monotonic ns interval | Raw SHA-256 |
|---|---|---|---|
| Before C/D | 05:34:48.924714–05:34:49.301553 | 21803608359267–21803985201612 | `8108a71c793bd6f2a29b29ec7379e711056c494092b333425e81b7ab303269e8` |
| After C/D | 05:36:04.844060–05:36:05.159916 | 21879527706864–21879843563831 | `3377b62a883ab624243fe831863e9e5bbfe8a6c3e6854472f19fc3ab00d300d3` |

The latter occurs after D's independent postcheck, so it is actual post-C/D evidence, not the older `final-candidate.jsonl` from A/B. Their reused `stage=6, phase=after` fields do not make them new executions of positive stage 6.

I independently compared every source entry and every generated-output entry against both the original Node 22 content baselines and the **05:20:54 admission supplement including modes**. No source, dependency, content, path/type/size or mode difference exists. Production has 1,101 entries (24 directories `0700`, 1,077 files `0600`), test has 1,047 (40 directories `0700`, 1,007 files `0600`), and MCP has 264 (23 directories `0700`, 241 files `0600`). The positive-stage temporary inventories also equal admission: all test roots and HOME/HUD_HOME roots are empty; only the same three explicitly recorded build-cache residues remain.

The admission checker's automated baseline comparison still strips mode fields because the original positive baselines omit modes. Its raw new records do contain the modes, and this review compares them fully with the preserved supplement. Do not claim the checker itself enforced that supplemental mode equality. If reused for later admission, compare with the separate supplemental mode baseline explicitly, without overwriting the original content baselines. Current observations still cannot supply missing modes at the six earlier historical positive-run instants.

## 6. Fresh command-bound hygiene supplement accepted

The C/D archive's `git-commands.txt`, three diff receipt sets and `status.txt` are byte-identical to the A/B archive. They were insufficient as new command-bound receipts. During this review, the dispatcher explicitly requested a fresh bounded read-only observation, not a test rerun. Completed turn `01a1a515-730b-74a0-bc44-e4c49fe747ba` supplied:

- Archive: `p065-node22-fresh-hygiene-20261104-01.zip`, **235,936 bytes**.
- Library: `libfile_97942aacf9948191a285416859c521de`; file: `file_00000000d50c81f5ba4c22d8ece59f21`.
- Independently calculated SHA-256: **`9ab5e2d87d3403f2aea8b160b5bf83e13d2ab9827a58512117ed7a4f9f511601`**.
- **26 verified listed files**, 27 unique ZIP entries including `SHA256SUMS`, no omitted or duplicate member.
- Whole observation: **05:44:02.767582–05:44:03.168174 UTC**, monotonic **22357451228796–22357851824585**, 2026-11-04.

Each command has its actual argv, cwd `/workspace/p065-node22-successor-verify`, UTC and monotonic start/end, return code, error field and retained raw stdout/stderr with matching hashes. Separate `rev-parse HEAD` and `rev-parse HEAD^{tree}` receipts return the exact candidate and tree. The newly requested hygiene commands are:

1. `git status --porcelain=v1`, 05:44:02.772241–05:44:02.776991.
2. `git diff --check`, 05:44:02.777161–05:44:02.779917.
3. `git diff --check 0008ff0415fd50b0e7636f8947bfc3fbbf6cdb8f 306fa579c2b7fffabbc0fc1739ed0d25f22faac3 -- src/ledger/intents.ts tests/unit/ledger-processes.test.ts tests/ledger/process.mjs tests/unit/p065-rejection-audit.test.ts tests/unit/p065-budget.test.ts`, 05:44:02.780100–05:44:02.787024.
4. `git diff --check 9fbf258a704e8fdfb99febae2635261a63ade5f6 306fa579c2b7fffabbc0fc1739ed0d25f22faac3 -- tests/unit/p065-budget.test.ts`, 05:44:02.787267–05:44:02.790304.

All four return **0**, no error, empty stdout and empty stderr. The last command is explicitly path-scoped, as the latest dispatch requested, rather than a newly observed unscoped range command. The already accepted one-file formatting relationship establishes that this is the entire changed path in that range. The standalone status receipt lacks `--untracked-files=all`; the immediately following full admission checker invokes that exact full-status form and records empty status, alongside the complete tracked and ignored-input checks. Do not rewrite either argv in the report.

The wrapper gives each Git command an 8-second timeout and the admission check 40 seconds. All complete normally in order, far below their bounds. The outer result is status 0/PASS with empty stderr. This is ordinary read-only receipt work, not another project lifecycle or exec-attestation claim.

The separately command-bound identity check runs 05:44:02.790500–05:44:03.168174. Its internal observation is 05:44:02.817167–05:44:03.161187, monotonic 22357500811772–22357844837937. Raw identity stdout SHA-256 is `2f7224bc69096b9818c343ad41bfe257bacb3b68a5dc279065842ba69922f4ba`. Every non-time record equals the reviewed post-C/D observation: all 1,320 source/configuration/dependency leaves, 275 dependency entries, runtime/tool identities, full output inventories **including modes**, empty status/ignored inputs and exact prior temporary-root inventories. Thus it also remains equal to the original content and supplemental mode baselines.

**This closes the narrow receipt gap.** The prior omission remains part of the history, not a reason to rerun C/D or backdate these records as pre-C/D evidence. It is Git whitespace/status hygiene, not an audit-four-path Prettier result or full `format:check`.

## 7. Remaining gates and acceptance boundary

Accepted here: exact C/D mutations, successful fresh control builds, all required named negative failures, unchanged test/source/dependency inputs, valid direct status and owned closure, strict actual test-root hygiene, new final clean-candidate observations, and the later command-bound Git hygiene supplement. **A–D focused Node 22 control evidence is now complete. No new P0–P2 source finding or implementation fix round is indicated.**

Still outstanding or separately governed:

- Any separately scoped final P2 audit-repair disposition. This control review does not itself close that broader repair disposition; the command-bound Git receipt gap is no longer outstanding.
- Required audit-four-path check-only formatting and full exact-final-source `format:check`. The accepted one-file mechanical formatting/FMT-1 lineage remains separate and does not substitute for those gates.
- Separately admitted Node 22 affected regressions, with 600/10/630 and outer 650-second bounds. Node 24 group 1 remains 57/57, with wrong-target FAIL and corrected PASS retained; group 2 remains 61/62, exit 1.
- The denied B20 startup `/proc/5200/environ` operation and unobserved historical process role. No unchanged replay, reused-PID inference, parent/launcher/transport workaround, startup suppression, null-profile substitution, ancestor-scope transfer or MCP-ANCESTOR import is released.
- The denied Unix-path listener and PTRACE_TRACEME operations and containing unchanged broad aggregates. Focused controls are not full npm test/mjs/hud-mcp success.
- Remaining exact-final-tree README/P065 shared-writer, security, lifecycle, fixture and real-harness/platform gates.
- Original Node 22/24 real-clock populations, prescribed samples and at least three isolated measured series per family; preparation-inclusive 30 ms, cumulative wait 20 ms, `busy_timeout=0`, actual outcomes/overruns and full-response/joint gates. These deterministic controls prove semantics, not numerical qualification.
- Separate local-only qualification and the user's withdrawal of assistant-run local testing. No local restart is implied.
- Full P065 package acceptance, NEXT consumption, one-merger integration, actual merged-tree green gates and merge. No main write, force-push, deployment, WIP dependency shortcut or fix-round reset follows.

Keep the positive, A/B and C/D bundles with their distinct timestamps and pins. No accepted Node 22 or Node 24 workload should be repeated merely to tidy the records.

## Sources and method

- [Exact candidate](https://github.com/CartmanFatass/codex-hud/commit/306fa579c2b7fffabbc0fc1739ed0d25f22faac3), retained complete immutable commit/tree responses, and exact source bytes.
- [Governing audit-repair ruling](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/cloud/rulings/p065-rejection-audit-repair-20261104.md), especially §§5–7.
- [Audit implementation](https://github.com/CartmanFatass/codex-hud/blob/306fa579c2b7fffabbc0fc1739ed0d25f22faac3/src/ledger/intents.ts) and [exact deterministic audit tests](https://github.com/CartmanFatass/codex-hud/blob/306fa579c2b7fffabbc0fc1739ed0d25f22faac3/tests/unit/p065-rejection-audit.test.ts).
- Supplied Node 22 validation plan, positive review, A/B review and historical Node 24 controls review; retained positive/A/B archives used for exact baseline and continuity comparisons.
- Recorded dispatcher continuation and completed report in the task/turn identified in §1, plus the distinct hygiene-supplement dispatch/turn in §6; actual contents of both new archives rather than their summaries alone.

Method: read-only task/source-record inspection, supported file materialization, offline hashing and complete JSON/map comparison, TAP/launcher/checker reading, and exact in-memory patch/reverse-patch reconstruction. No archived supervisor/checker, project compiler, test, formatter, benchmark, fixture, process/capability probe or denied operation was run. No source, repository, branch, historical evidence or permissions were edited. Local writes contain only review inputs, an offline evidence-inspection helper/results and this requested ruling.

**Final disposition: C and D accepted; all four Node 22 focused audit controls are behaviorally complete; the new command-bound Git hygiene supplement is accepted and closes that receipt gap; all wider package holds remain.**
