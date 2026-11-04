# P065-on-C3 owner-local preparation: independent Oracle ruling

Date: 2026-11-04 UTC. Repository: CartmanFatass/codex-hud.

Reviewed publication: commit `73dd53dc80bd48417fc9933d5547a03a597d3b97`, branch `local-verification/20261103`, directory `docs/cloud/handoff/local-verification/20261103/p065-c3-local-preparation-20261104T134138Z-2371624/`. File references below are relative to that directory unless stated otherwise. The publication commit is evidence, not the source candidate or a tested tree.

## Decision

**ACCEPT the publication as a consistent, append-only owner-local preparation record, and ACCEPT the published local port at source-only planning scope. NO BUILD, TEST, READINESS, PERFORMANCE RUN, MATERIALIZATION OR FACILITY PROBE IS ADMITTED by this review.**

The work completed is preparation, not testing. Both the commit message and `REPORT.md:3,24,28` explicitly say no build, project test, readiness case or benchmark ran. The reported preparation commands include source/data checks, version reads, new proposal generation, parse-only checks and official-archive comparison. Those are not P065 behavioral evidence. No build event log, compiler output graph, accepted baseline, readiness result or benchmark sample is supplied.

P065 therefore remains **UNTESTED ON THIS COMBINATION, UNACCEPTED AS A PACKAGE, NOT PERFORMANCE-QUALIFIED, and NOT ELIGIBLE FOR INTEGRATION**. This does not undo the separate earlier C3 acceptance or transfer C3 results to P065.

No production, test, fixture, dependency, driver, holder or supervisor-algorithm correction is required by the inspected local-port delta. The remaining work is exact executable/custody admission evidence. Do not spend another implementation-fix round changing the package to address a missing execution seal.

## 1. Independently verified publication integrity

Read-only GitHub readback found the branch at `73dd53dc80bd48417fc9933d5547a03a597d3b97`. The commit has publication tree `c6922392a0c43cc8f959d40bb2be19e6a42a06d5` and one parent, `5037c7979d3075c23e965910d973addac8483d67`. The parent-to-head comparison is exactly one commit ahead, zero behind, and adds exactly 24 files in the new preparation directory, with no other modification or deletion.

All 24 files were fetched as complete base64 blobs at that immutable commit. Their independently calculated Git blob hashes equal the connector identities. The untruncated directory tree contains precisely those 24 regular mode-100644 blobs, no symlink, gitlink or extra leaf. Canonical reconstruction produces subtree `bc78875cf7c813d4890a30e19c88f5f645d2b81a`; the traversed ancestor-tree object hashes also reconstruct exactly.

All 23 entries in `SHA256SUMS` match their actual bytes and cover every published file except the checksum file itself. Its independently calculated SHA-256 is `a8b121c9992f4b7ae53d13aa4ed451eb2d9ba802472c83349ce7bf1ea5076272`.

Important published identities:

- `REPORT.md`: `7fe36c05c4ce2cd9a35833081e60241fe2bcbe9845286907541565d5abc505da`.
- `leaf-inventory.json`: `72bee14a3f066537ccbcc9616ba42c27054e868bcbd764bf4dd29ef7afc0be65`.
- `runtime-tools.json`: `91e8941e0770393339305d7e6c8f96107c5938333fd37dfd845f147c381ff798`.
- `local-build-proposal-01/PROPOSAL.md`: `3474ce39d991191153f9076d732fe382dd3655311364c2378c7f29857ff8a73b`.
- Published launcher: `37897595cb779431a6905653a50d1cef109b11f3d5c1817fa3149ea11f7bfa2d`.
- Published checker: `00f1860f515240d729ee36bb88e85a296eb5072dbf5577dceff14299ee37d8d0`.
- Published wrapper: `40563ed09a68d1dd7d70f6b06ab0aeaeac119dda4c7907e50ef4da2ba2dd2e94`.
- Unchanged manifest: `e7a883d1abee980bb320c88a8c26eb2dba1268d31bd7d3763098a883b981c150`.

This establishes the publication's integrity and append-only scope. It does not independently establish every command reportedly performed on the owner's computer, current repository access settings, or the live condition of that computer.

## 2. Exact source candidate and local-checkout limits

The candidate remains commit `33dd1bd4ce82c39aa2dceea2d5ce686c02e0faf5`, tree `ef8dc07594d5605eeeb94f3e2bac3e81c80e8822`, with ordered parents `26096e825baeccbce1403c8cbffa964e243f83ff` then `585d14217b1d99192a5dd87b6efcc0f4c36c9323`. A fresh GitHub commit-object read confirms those identities.

The entire new 1,425-leaf inventory equals the prior accepted composition inventory at every `(path, mode, type, object SHA)`. Independent canonical Git-tree reconstruction gives exactly the recorded source tree. All leaves are blobs: 1,368 mode 100644 and 57 mode 100755. The 275 dependency leaves are not merely a same-sized subset: they exactly equal the complete accepted `node_modules/` subset.

The local owner reports a new detached worktree, no dirty/ignored/untracked entries, 1,425 actual worktree byte checks with no mismatch, and genuine absence of `dist`, `dist-test` and `packages/hud-mcp/dist`. `source-identity.json` and `tracked-byte-verification.json` agree. The published source-check program is compatible with that reporting intent and was read only, not rerun by this reviewer.

The distinction matters: the Git identities and inventory correspondence are independently verified here; actual local file reads, detached status, output-root absence and quietness are owner-reported historical observations. There is no live local filesystem observation in this review, and the published summaries are not full per-file command-output receipts. A current check is still needed in the separately admitted local dispatch. The absent output claims must not be turned into already accepted output baselines.

The original cloud proposal ZIP and ruling retained by the reviewer match the input hashes stated in the owner's prompt. The current candidate's AGENTS/dots guide identities were checked; its P065 brief, cloud README and STATE were separately fetched at the frozen commit and matched to the leaf inventory, rather than treating an older brief as current. The new source inventory does not change any composition owner or source blob. No reconstruction merge, new worktree, source update, fetch retry or branch movement is needed to review this packet.

## 3. Local tools and facilities

The record contains seven tool identities: Node 24.22.1, Python 3.12.3, Bash 5.2.21, Git 2.43.0, and GNU coreutils 9.4 `env`, `timeout`, and `tail`. All seven recorded SHA-256 values occur in the new checker. The Node and Python identities also match its launcher constants. The Bash `/bin` alias and Python symlink resolution are reported, not guessed from cloud paths.

The local Node binary is recorded as `e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb`. Its archive identity, `6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6`, agrees with the official Node 24.22.1 Linux x64 tar.xz checksum independently read from the [Node release page](https://nodejs.org/en/blog/release/v24.22.1/). The local binary/extracted-member equality is the owner's retained observation; this reviewer did not download or inspect those private binary bytes, or verify the upstream PGP signature.

**Accept these identities as the declared local inputs for planning.** They are deliberately different from the cloud binaries. Do not reject them merely because the same version has different historical cloud bytes, silently substitute a cloud pin, upgrade, install, or infer Node 22 readiness. Before dispatch, the actual invoked files must match the local pins.

The facilities document correctly preserves UNKNOWN for pidfd operation, this launcher's subreaper readback/initial ECHILD/gated fork, separate custody-check closeout, and current quietness. Python symbol/attribute presence is not successful kernel permission or lifecycle evidence. The earlier local C3 merged-tree report at `5037c79` exists and uses a different runner, tree and observation method; its `/proc` census and historical successes are not proof for this supervisor, authorization to replay that census, or permission to read process environments now. No new facility test is needed or admitted just to make UNKNOWN look known.

Local preparation is a separately authorized owner workflow. It does not resolve the blocked cloud delivery operation. Nothing in this ruling authorizes moving this package into the blocked cloud executor or using publication as an alternate transport around that hold.

## 4. Local-port comparison and preserved guarantees

All four submitted published-versus-reviewed unified diffs equal independently regenerated diffs, including the empty manifest diff. The manifest is byte-identical to the accepted cloud proposal and retains its 40 selected source/configuration identities; complete custody remains the separate 1,425-leaf requirement.

- Launcher differences are its description, local checkout/runtime/manifest/evidence paths and the local Node/Python hashes. Every byte from `SET_SUBREAPER, GET_SUBREAPER = 36, 37` through the end is unchanged.
- Checker differences are local path constants, a one-launcher hash list and local tool identities, including newly recorded Bash/Git/tail pins. Every byte from `def sha(p):` through the end is unchanged.
- Wrapper differences are the local base/Python/evidence paths and accepting only stage `1`. No second or third stage is enabled.
- The optional B diff is exactly the two advertised `--kill-after=10s` additions. It has not been applied. Option C has no submitted implementation.

The proposed workload remains one direct Node invocation of `./node_modules/typescript/bin/tsc`. It is the expansion of the logical build script, not a literal npm execution. Success could establish only a fresh `dist` graph for this Node/local source attempt, not the other output roots, tests, readiness, performance, the package or integration.

The retained compiler design has pre-release subreaper setup/readback, initial ECHILD, sole gated direct child, pidfd registration before release, authoritative child wait, final ECHILD and source/runtime before/after comparison. Only the unreaped direct child's pidfd is signalled. Unexpected adoption, interruption, evidence failure or unsuccessful lifecycle invalidate the result. No host scan or process-group cleanup has been added to the compiler supervisor.

Bounds remain 180 seconds workload, 10 seconds TERM grace, 210 seconds closeout, and 230 seconds outer timeout plus 10 seconds kill-after. These are different scopes, not a single 180-second wrapper deadline. Outer termination is not a closure proof. The honest `exec_state=no_error_reported` and `compiler_result=exit_status_observed_exec_unverified` labels remain; exec-pipe EOF is not positive exec-syscall attestation.

All three future output hashes remain null. The after-check still creates the `baseline-dist.json` file before its later residue checks and final PASS. That file is provisional until complete attempt/lifecycle/custody review accepts it. Failure preserves it and all residue; it is not reset, consumed or replaced to enable a fresh-looking run. Symlinks/unexpected output types require independent rejection before output acceptance, because an inventory entry by itself is not validation of that entry.

The complete original driver/holder source identity is preserved by the full leaf match. H1, the 126-cell population, 50 warmups, at least 1,000 measured calls per required cell and the distinct partial/failed/incomplete result categories remain untouched. No runnable readiness manifest exists in this submission.

## 5. Findings affecting execution admission

### F1. Unreviewed original executable bytes: P1 admission blocker

`local-build-proposal-01/ORIGINAL-AND-PUBLISHED-SEALS.json:2–13`; `files/check.py:3–5`; `REPORT.md:19`.

The published files are path-redacted renderings. The checker deliberately pins the private original launcher `78e282318d9cc0d6f4772229e55b013dbee20c9cf4a2bee4a6616c0a176c24d4`, not the published launcher `37897595…`. Original checker and wrapper hashes are `579694fcb3b194e8664d91b641fa04aa079a7ee9b90324fad6fac80858988d25` and `e9794b3d3f1082effb6883fe726bd7e9786c8a150e82e47c3fb771bf94593ca6`. Only the manifest is byte-identical in both forms.

This disclosure is correct and is not corruption. But original SHA strings alone are not review of original bytes or proof that only the disclosed path spans differ. Running the published rendering fails its own launcher seal; substituting its hash or filling placeholders in place creates a new, unreviewed executable.

Required admission evidence: review the retained original-form four files and original-versus-reviewed deltas through an authorized private/local review route, with independent recomputed hashes and an exact original-to-published transformation check. Keep private path mapping private; do not publish a username/home path merely to satisfy review. If the review route is unavailable, report that blocker rather than guessing paths, regenerating a hidden original, or dispatching the rendering. No machine, transfer route or access right is invented by this requirement.

### F2. Custody receipt description exceeds wrapper output: P2 evidence correction

`local-build-proposal-01/PROPOSAL.md:38–40`; `files/run-one.sh:10–12,25–27`.

The proposal says each custody exit status is kept as a receipt. The wrapper actually saves before/after stdout and stderr, assigns `$?` to a shell variable, and exits with it on failure/final return. It writes only the compiler outer status to a dedicated status file. There is no separate persisted before-check or after-check exit-code file in the sealed wrapper.

On a failure, a later reader must not invent a missing custody status or call a JSON PASS line a native process wait. The exact dispatcher must preserve the wrapper's authoritative wait/exit/signal outcome and complete raw outputs. A before-check zero can be identified as inferred from sealed control flow if later execution is demonstrated; final after-check exit is inherited by normal wrapper return. Label that evidence honestly. If separately observed custody statuses are required, prepare and review a narrowly resealed receipt change first. A documentary clarification and exact dispatcher receipt contract can address this gap without rewriting the compiler algorithm.

### F3. Separate custody ownership and invocation remain admission conditions

`files/check.py:11,33`; `files/run-one.sh:10,11,25,26`; `PROPOSAL.md:36–45,53–56`.

The before/after checks run under their own 60-second `timeout`, outside the compiler supervisor. Their synchronous Git calls do not inherit its ECHILD evidence. A timeout/signal/failure or uncertain return stops everything dependent and leaves custody closure unproved. Neither A's stop rule nor B's added kill-after proves that every Git descendant closed. C would be a new subprocess topology and is not implicitly approved.

The local pin map hashes `/usr/bin/git` and `/usr/bin/tail`, but the checker has an inherited-environment `git ls-files --stage -z` invocation and the wrapper uses unqualified `tail`. The constructed environment of the other Git helper does not apply to that separate call; the compiler's `env -i` applies only inside its outer invocation, not to the whole wrapper. Thus tool-file hashes alone do not establish which commands an arbitrary incoming environment invokes. Exact admission must bind the wrapper's PATH/environment and `/bin/bash` resolution so the recorded tools are the invoked tools, with no inherited Git/shell override changing the read-only path. This is not permission to read secrets or the whole environment, and not a reason to alter security settings.

**Disposition of options:** retain A as the minimal source-design baseline for a bounded, successful read-only custody path. Do not apply B just to claim closure, and do not demand an undrafted C solely because the source was ported. This is a planning choice, not execution admission. A future exact admission must state its owned/waited dispatcher topology, raw receipt handling and abnormal-closeout limits. If the applicable local admission requires a stronger all-descendant failure-path proof, A cannot supply it: a separately reviewed successor is then necessary. No self-test, timed-out-check rerun or cleanup experiment is released to decide that question.

Also treat the proposed standalone replay of `scripts/source_identity.py` as an actual subprocess-bearing operation, not passive text inspection: it launches many Git commands. Its current use must fit the admitted identity/custody procedure rather than being added as an unsupervised preliminary workload.

## 6. Exact next safe stage

**Next: one owner-local source-only executable/custody admission supplement for this same preparation, then stop for review. Do not run stage 1 yet.** Preserve the accepted source, the prepared original files, deployment absence and every prior artifact.

The supplement should do only the following:

1. Establish an authorized reviewer-visible route to the actual original-form four files. Recompute their published original hashes, verify their exact deltas and redaction relation, and bind the actual local checkout/deployment/evidence paths privately. A hash-only assertion or another redacted rendering is not the missing original-byte review.
2. Record the exact whole-wrapper tool/environment binding and original-seal check before any proposed invocation. Supply the A success-path custody/dispatcher receipt contract described above, including native wrapper wait, observed-versus-inferred nested statuses, how failures are preserved, and the fact that abnormal custody closure is not proved. Any executable change requires a separately sealed successor with a full delta; do not modify the already reviewed files in place.
3. Name the quiet owner-local dispatch window and the same single stage-1 attempt, without a host-wide scan. Define the bounded immediate source/tool/output-absence recheck and separate collision-preserving materialization procedure. The deployment and evidence roots are reported absent, not materialized by this review.
4. Submit the supplement for exact admission. UNKNOWN facility permission can remain UNKNOWN until the admitted supervisor's guarded in-stage setup establishes or refuses it; do not add a stand-alone probe. If the execution facility denies an operation, preserve the exact denial and stop that action. No generic Oracle wording lifts a denial.

After those conditions are reviewed and specifically admitted, the first prospective workload is still only the private-path equivalent of `/bin/bash <DEPLOY>/run-one.sh 1`. That is an identifier of the proposed stage, not a command seal or instruction to run it now. Materialization/rechecks/dispatch remain subject to their exact admission. The stage creates `dist` only, retains the other two roots absent, records the complete attempt and stops for review. No stage 2/3, Node 22, retry, alternate suffix, loop or favorable resampling follows automatically.

This recommendation does not request a new implementation round, a new full matrix, a new supervisor experiment or repetition of unchanged syntax checks. It closes the smallest identified evidence gap before executing the first real workload.

## 7. Boundaries unchanged

The prior P065/C3 source-only Oracle ruling remains governing. No cloud delivery retry or alternate transport is released. The PTRACE, AF_UNIX and physical B20 startup/process-environment paths remain held at their exact operations. There is no permission to use a test filter or fake-success replacement to make an aggregate green, and local historical C3 success does not grant P065 execution.

No readiness C/R/I, shared-writer tests, focused regressions, README aggregates or full performance qualification has run on this candidate in this packet. Missing Prettier is still not permission to install it. Full qualification still requires the original complete populations, exact supported runtimes, isolated series, real-clock boundaries, instrumentation disclosure and honest failed/partial outcomes.

No whole-package acceptance, `--no-ff` integration, source-remediation counter reset, capability promotion, source branch update or publication follows from this ruling. NEXT remains frozen until P065's actual acceptance and ordinary integration. NEXT's archive-custody issue and all other queue prerequisites remain distinct. Real harness, Herdr, tmux, Jev, live statusline, real-Claude same-call and formal WSL/B14 claims remain outside this preparation.

## 8. Method and artifacts

Independent data-only audit: `p065-c3-local-prep-review-20261104/independent-evidence-audit.json`, SHA-256 `b09597733a0102fd4398bb1604456bfd88ffc0d2ae0983253a814fde8400d5ca`. It records 1,623 passing data-consistency checks, including each source path's uniqueness; these are not project test passes. The evidence directory retains exact fetched blob data, review copies, GitHub metadata and a standalone independently written data-audit script.

No submitted Python/JavaScript/shell program was executed, imported or parsed as a program in this review. No project compiler, test, benchmark, readiness runner, supervisor, checker, source-identity replay, syntax check, probe, process-environment read, host scan, Git command, checkout mutation, install, original-binary download, denied transfer retry, repository write or publication was performed. Only standalone review artifacts and data-only copies were written outside repositories.

Two read errors did not affect the result: an encoded branch URL was rejected as invalid syntax, then the supported Git ref endpoint was used; one recursive root-tree call lost transport, so bounded directory-tree reads obtained the exact new subtree. Neither error was a policy/access denial or an uncertain state-changing action. A direct official checksum URL was unavailable through web retrieval; the official release page supplied the same archive checksum. All machine-local runtime and execution claims remain distinguished from independently observed remote/data facts.

Primary sources: [immutable publication](https://github.com/CartmanFatass/codex-hud/commit/73dd53dc80bd48417fc9933d5547a03a597d3b97), [preparation report](https://github.com/CartmanFatass/codex-hud/blob/73dd53dc80bd48417fc9933d5547a03a597d3b97/docs/cloud/handoff/local-verification/20261103/p065-c3-local-preparation-20261104T134138Z-2371624/REPORT.md), [local proposal](https://github.com/CartmanFatass/codex-hud/blob/73dd53dc80bd48417fc9933d5547a03a597d3b97/docs/cloud/handoff/local-verification/20261103/p065-c3-local-preparation-20261104T134138Z-2371624/local-build-proposal-01/PROPOSAL.md), [original/published seals](https://github.com/CartmanFatass/codex-hud/blob/73dd53dc80bd48417fc9933d5547a03a597d3b97/docs/cloud/handoff/local-verification/20261103/p065-c3-local-preparation-20261104T134138Z-2371624/local-build-proposal-01/ORIGINAL-AND-PUBLISHED-SEALS.json), [frozen source commit](https://github.com/CartmanFatass/codex-hud/commit/33dd1bd4ce82c39aa2dceea2d5ce686c02e0faf5), and the retained independent P065/C3 source-only ruling.
