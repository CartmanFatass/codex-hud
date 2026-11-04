# P065 driver formatting successor: narrow Oracle review

Date: 2026-11-04 UTC. Repository: CartmanFatass/codex-hud. Scope: the exact two-file formatter successor, original-input formatter evidence, final check-only formatting evidence, and the next readiness boundary.

## Decision

**ACCEPT the mechanical formatting successor and its narrow formatting evidence. No new required source finding. R1 remains closed at source-review level, and F1–F5 remain fixed at source level.**

The original-input debug-checks, exact generated-byte custody, final two-file check and final full `src tests` check are supported by the inspected records. This closes the driver formatting prerequisite at source `8f67f7e2d8249295e5a84af0bb9b98817a30459c`, tree `3e30a63f21d2c50389444dff65f2c47d1c3af3c4`. No additional formatting source change or formatting rerun is required by this review.

This is **not** acceptance of the P065 package, the complete project check set, driver runtime readiness, executed evidence-checker controls, interruption behavior, performance qualification, a compute admission, or a merge. The next minimal stage is separately admitted syntax/readiness work on this immutable source, followed by source-custodied builds. Do not launch the full driver merely to check syntax or imports.

## Exact lineage and source scope

Independently fetched the commit object, branch ref, parent comparison, both complete recursive Git trees, and all four complete parent/final source files.

- Final commit: `8f67f7e2d8249295e5a84af0bb9b98817a30459c`.
- Final tree: `3e30a63f21d2c50389444dff65f2c47d1c3af3c4`.
- Sole parent: `4a484053473524b33184dc2cffc3dabd4bd63158`, tree `c47535fbdfebf009449aa20859424d8b1bef0369`.
- `refs/heads/dots/p065-budget` pointed to the final commit at inspection.
- Comparison: one commit ahead, zero behind. Exactly two changed paths.
- Both recursive-tree responses are untruncated: 1,460 entries, including 1,329 tracked leaves and 275 tracked dependency entries. The complete path/type/mode/blob/size comparison has only the two differences below. Both modes remain `100644`.

| Path | Parent blob / bytes | Final blob / bytes |
|---|---|---|
| tests/int/p065-budget-benchmark.mjs | `0487fcd1d55aa66192fa4ffa143c49d69ca04cbd` / 84,482 | `8ddcd04417d9c4cd62e13f8c59a3b5500a8532c0` / 90,091 |
| tests/int/p065-ledger-holder.mjs | `b75f9f3c2d477c34a6b44119414f3c77e7157724` / 12,577 | `2ca327ce7ff2bc892d2fcdb9aa8155c62a612c2d` / 13,331 |

Independently calculated both Git blob IDs and these SHA-256 values from the complete returned bytes:

- Parent benchmark: `bdb112a1dc35125df3a6cd9385fff9505da29444d4bdb48e994a613c0b50c99d`.
- Final benchmark: `fb9559202caa4e4f20b01698392bb77afe7699251ecf5a2d3a51ad546aa227c8`.
- Parent holder: `c1f58ab2430b92f6cfa00a7f0f29b1843e05526aee376c53c09f835daf10c45b`.
- Final holder: `bb63d2f95546e607ee3e014604402ea10bd9e087393b2a482adbe340dc4dcef3`.

All other 1,327 tracked leaves are identical, including production code, frozen fixtures, prior audit formatting, package/lock/build configuration, dependency files, contracts, status, rulings and historical reports. There is no permission/mode expansion, additional destination, new fixture data or unrelated formatting sweep.

## Complete diff and semantic equivalence

Read the complete 54-hunk benchmark diff and 9-hunk holder diff. Independently recreating the unified diffs from the complete fetched parent/final bytes reproduces each archived diff exactly, including all context and changed lines. The final files are also byte-for-byte equal to both the retained formatted files and their formatter runs' raw stdout. This is not a conclusion from a truncated GitHub patch: GitHub's commit response omitted the large benchmark patch, so the complete archived diff and independent exact-file reconstruction were used instead.

- Benchmark complete diff SHA-256: `bbd3b0e62752957694e985fd350a4a9f29b606afcaa0b097f07afcaa412708d8`.
- Holder complete diff SHA-256: `4b2a4a343a0bdb653dca6c4de230ae5e91ece8d8430be02fabf82801bc678644`.

The changes expand compact declarations, imports, literals, call arguments, callbacks, chained calls, conditionals and try/catch/finally bodies into the configured layout. Added trailing commas are ordinary object/array trailing commas; added expression parentheses preserve grouping. `.5`, `.95` and `.99` become the same numeric values written with leading zeroes. Function receivers, arguments, property and iteration order, await/return/throw behavior, statement boundaries, conditions and short-circuit order remain the same. No changed literal value, line-sensitive directive/comment, automatic-semicolon-insertion hazard, new call, deleted assertion, changed timer or altered recovery branch was found.

The accepted R1 mechanics remain intact at these final-file locations:

- `prepareCall`, lines 895–930: invalid numerical evidence is assigned at line 925 before the intention is registered/journaled. Pending calls still have no invented response duration or diagnostics.
- `numericalGates`, lines 820–861: missing numeric evidence still falls back safely, while incomplete timing still fails qualification.
- `finalizeWaveFailure`, lines 982–996, and the wave catch at 1344–1353: every row registered in the failed wave is finalized, including a never-issued participant; already-issued sibling jobs settle before synchronous failure logging. Original error and actual timing/disposition truth are retained.
- `summarize`, lines 1380–1565: normalization does not mutate the original raw row; unfinished intentions remain semantically failed, missing measurements do not become zero-duration samples, and dispatch/timing/population counts remain visible.
- The tenth checker group at 1847–1947 still covers the mixed H=2 pending shape and the before-first-dispatch shape. All ten groups remain in the source, but no project checker group was executed by these formatter runs or this review.

F1's independent primary/outcome percentiles, F2's successful-loss coverage per participant, F3's canonical durable reply checks, F4's nonexemption of zero-delay COMMIT uncertainty and F5's strict timing validation are unchanged. The 126-cell matrix, 50 warmups and 1,000 measured primaries per cell, 132,300 primary attempts plus additive recoveries, response/helper deadlines and 3,600-second series bound are unchanged. Holder heartbeat, observation-store, physical locking, cold CLI refusal and owned shutdown semantics are unchanged. Formatting is not new runtime evidence for any of them.

## Evidence custody and actual recorded results

Read the full prior R1 source ruling and the relevant cloud completion/dispatch records. Cloud thread `01a1a3c0-8454-762a-a04c-d71a10b710c9` records original debug/render turn `01a1a57a-498f-7623-84b5-73269cd7b500` and completed final check turn `01a1a580-ddf1-7244-a2e4-92547d28e817`.

Materialized and inspected both archives, independently verified their complete SHA-256 values, and checked every listed member against their SHA256SUMS:

1. `p065-r1-format-validation-01-evidence.zip`, Library ID `libfile_ae54790489188191a38fc4970b5f67b0`, 975,401 bytes. SHA-256 `f4667f4bd443b401842ab3f0e9b7f6b3bd7e5d8a93c8f49e89d3e45a260cef9d`. All 71 listed members match; 72 ZIP members including SHA256SUMS.
2. `p065-driver-format-final-validation-01-evidence.zip`, Library ID `libfile_34e1d524ed988191b13654dbbfab122c`, 448,511 bytes. SHA-256 `916b4b273021357ca057ce120cc113cba1c5ec3d9a968f4f6464c5a7a868ac19`. All 38 listed members match; 39 ZIP members including SHA256SUMS.

The original debug/render runs target the exact R1 parent in a dedicated clean checkout. Final check-only runs target the exact committed formatting successor in another dedicated clean checkout. They are not mislabeled runs at a later documentary head.

All six inner argv use the pinned Node executable `/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node` and official formatter entry `/workspace/p065-official-tools-01/prettier-3.9.9/bin/prettier.cjs`:

| Stage | Formatter argv after the entry | Direct / outer exit | Recorded outer duration |
|---|---|---|---|
| Original benchmark debug | --debug-check tests/int/p065-budget-benchmark.mjs | 0 / 0 | 0.987 s |
| Original holder debug | --debug-check tests/int/p065-ledger-holder.mjs | 0 / 0 | 0.634 s |
| Benchmark stdout generation | tests/int/p065-budget-benchmark.mjs | 0 / 0 | 0.718 s |
| Holder stdout generation | tests/int/p065-ledger-holder.mjs | 0 / 0 | 0.555 s |
| Final two-file check | --check tests/int/p065-budget-benchmark.mjs tests/int/p065-ledger-holder.mjs | 0 / 0 | 0.707 s |
| Final full format scope | --check src tests | 0 / 0 | 12.223 s |

The final two-file outer interval is 07:42:02.402919–07:42:03.109727 UTC; full-format interval is 07:42:11.233519–07:42:23.456938 UTC. Debug stdout identifies the corresponding source filename. Generated stdout equals the committed successor bytes. Each final check stdout is exactly `Checking formatting...` followed by `All matched files use Prettier code style!`, with its terminal newlines. All six stderr streams are empty. Raw stream hashes agree with their event receipts.

Every stream records initial ECHILD, subreaper readback 1, owned child/pidfd creation, release, error-pipe EOF with no reported error, direct wait status 0, terminal ECHILD, final pipe EOF and successful identity postcheck. All six results retain closure=true, lifecycle_valid=true, postcheck_ok=true, unexpected_descendant=false, failure=null, interrupted=null and post_error=null. No timeout, signal or cleanup failure appears. The inspected launcher keeps the 300-second workload bound, 10-second grace, 330-second closeout and 350-second outer timeout; it does not introduce a denied-operation retry.

Preserve the exact recorder label `compiler_result=exit_status_observed_exec_unverified` and `exec_state=no_error_reported`. The reused word compiler does not establish a compiler run, and pipe EOF is not an independent exec-syscall attestation. Specific formatter output, exact source/output custody and retained launcher/identity records support the narrow formatting result. This review did not inspect the remote binary live or upgrade this label.

## Tool, source and hygiene checks

The recorded Node SHA-256 is `61ab14cd750fc24d5db53490ec5fc40f756e4b6e136b78cf7004265471d9bd1d`, the previously recorded Node 24.22.1 executable; stage-local cache paths corroborate that runtime version. The formatter entry hash is `6e922134a3c76fd4de202959bb6aef50bde0c994148075003a15569b7197906e`. Its archive hash is `c3b162d30c45126873cc6338a539383e92120a390d10de78f373f42c2045b338`.

The independent checker verifies the official formatter package name/version, tarball SRI against the unchanged lockfile, safe archive contents, and complete extracted-package equality. All 56 formatter-file inventories agree across all twelve before/after records. The lockfile's Prettier 3.9.9 integrity value was independently reread and matches the records. Configuration remains printWidth 120, tabWidth 2, spaces, semicolons, single quotes and trailingComma es5. The unchanged ignore file excludes neither driver. No write, formatter-result cache, custom parser/plugin or relaxed-ignore flag appears.

All twelve before/after records independently cover all 1,329 tracked leaves, including 275 dependency entries, with clean status and no ignored source/test/package/dependency inputs. Every recorded path/blob matches its respective immutable remote tree, and each stage's full tracked/hash inventory is unchanged. Recorded launcher and source-manifest hashes agree with the archived bytes. Both clean formatting checkouts have no dist, dist-test or packages/hud-mcp/dist before or after. HOME and HUD_HOME remain empty; only inventoried Node compile-cache files occur under each new private TMPDIR. Those are neither repository build outputs nor a reused Prettier check cache.

Historical hygiene receipt limitation: the final archive retains `diff-check.status` containing 0 with empty stdout/stderr, and the cloud completion summary says git diff --check passed. Neither the supplied archive nor visible completion record preserves that command's exact argv/range. I therefore do not attribute the historical receipt to an invented parent-to-successor command or claim its range was independently verified.

This metadata omission does not conceal a source hygiene defect. Independently checked both exact fetched parent/final pairs using read-only `git diff --no-index --check` with blank-at-eol, blank-at-eof and space-before-tab checking, no global/system Git configuration and no repository mutation. Both return the no-index difference status 1 with empty stdout/stderr; this is not relabeled as an exit-0 historical run. Exact final-byte inspection also finds no trailing whitespace, carriage returns or conflict markers, and both files have a terminal LF. Together with the complete two-path tree comparison, this covers the full actual committed delta's whitespace hygiene. Preserve the historical receipt's narrower attribution; an additive export of the original command, if available, may improve custody without rerunning formatting or changing source.

The full-format result covers the configured `src tests` scope of format:check using the approved official formatter directly. It is not a claim that the npm wrapper itself ran, that package sources outside that scope were all checked, or that the full build/test/regression check set passed.

## Minimal readiness path and retained holds

1. Record this narrow acceptance and retain the preceding failed formatting result, F1–F5/R1 rejections/corrections and existing remediation count. Bind future work to the literal final commit/tree above. An additive report descendant must not silently relabel these runs or change the execution baseline. No source remedy is requested here.
2. Obtain the dispatcher's named quiet compute admission and retain the already required bounded supervisor/tool admission before project execution. First run separate `node --check tests/int/p065-budget-benchmark.mjs` and `node --check tests/int/p065-ledger-holder.mjs` on the exact clean final tree, using the exact supported Node binary being admitted. Record executable path, version/hash, source/tree/config/dependency identities, raw stdout/stderr, direct/outer status, timing and cleanup. Preserve separate coverage for Node 22 >=22.13 and Node 24 as each runtime is admitted; a Node 24 formatter parse is not Node 22 readiness. These syntax commands do not execute the files. Do not substitute importing either module or running the driver: its entrypoint creates evidence and proceeds toward the entire matrix.
3. Establish fresh compiled-output custody for the exact final tree before a driver or holder run. The three required builds remain `npm run build`, `npm run build:test` and `npm run build:hud-mcp`, separately recorded with their existing 180-second bounds and accepted supervision. Preserve failure and never-run statuses separately. Verify clean input/source/tool identities and generated-output inventories/hashes before consuming dist, dist-test or MCP dist. Do not transplant historical compiled graphs or infer source provenance from output hashes alone. This formatting review produces no compiled outputs.
4. Stop the readiness-only stage at verified syntax/build custody. The unchanged source still needs its separately authorized runtime/control and R1 lifecycle evidence before performance conclusions. Retain all ten checker-control outcomes and actual partial/interrupted JSON/JSONL evidence, including every pre-journaled never-issued intention, original wave error, truthful missing timing, incomplete cell snapshot and owned-resource cleanup. Cover the already-issued sibling and before-first-dispatch cases where feasible under the authorized lifecycle plan. No hidden switch, reduced qualification population, automatic resampling or rewritten historical outcome is authorized.
5. Continue outstanding deterministic/shared-writer/full-check obligations only within existing scope and restrictions. Do not replay unchanged accepted behavioral suites merely to attach this new SHA, and do not relabel their historical pins as final-source executions. Where the exact final runtime/lifecycle or qualification gate requires a new execution, retain it separately. The full `src tests` formatting pass does not turn a failed or blocked aggregate into green.
6. Keep full performance qualification separate: unchanged complete populations, three isolated series on each exact supported Node 22 and Node 24 runtime, distinct artifacts, the existing 3,600-second per-series bound, instrumentation-overhead and host-interference disclosure, and all failed/partial/interrupted/contaminated series retained. Inspect populations, actual outcomes, numerical flags, per-participant loss coverage, canonical/fault semantics and cleanup, not exit status alone. Runtime feasibility and performance are still unproved here.
7. AF_UNIX-listen and PTRACE_TRACEME restrictions and independent HYG2/RUNZ1/S3F full-check blockers remain in force. No permission retry, transport/topology workaround, local assistant testing, capability promotion, B10D dependency consumption, real-Claude same-call 150/50 timing, Herdr/tmux, formal WSL or B14 qualification follows from this result. Final fresh Oracle package acceptance and a complete green check set on the actual merged tree remain integration prerequisites.

## Sources and method

- [Exact reviewed successor](https://github.com/CartmanFatass/codex-hud/commit/8f67f7e2d8249295e5a84af0bb9b98817a30459c).
- [Complete parent comparison](https://github.com/CartmanFatass/codex-hud/compare/4a484053473524b33184dc2cffc3dabd4bd63158...8f67f7e2d8249295e5a84af0bb9b98817a30459c).
- [Final benchmark driver](https://github.com/CartmanFatass/codex-hud/blob/8f67f7e2d8249295e5a84af0bb9b98817a30459c/tests/int/p065-budget-benchmark.mjs).
- [Final holder](https://github.com/CartmanFatass/codex-hud/blob/8f67f7e2d8249295e5a84af0bb9b98817a30459c/tests/int/p065-ledger-holder.mjs).
- [Retained R1 correction report](https://github.com/CartmanFatass/codex-hud/blob/8f67f7e2d8249295e5a84af0bb9b98817a30459c/docs/cloud/handoff/p065-budget/performance-driver-interruption-correction-20261104.md).
- [Binding P065 brief](https://github.com/CartmanFatass/codex-hud/blob/8f67f7e2d8249295e5a84af0bb9b98817a30459c/docs/cloud/P065-BUDGET.md).
- The preceding exact R1 source acceptance, recorded cloud thread/turns and both hash-pinned evidence archives identified above.

Method: read-only connector inspection, archive-member reads, independent hashes/full-file/full-tree/diff comparisons and static whitespace hygiene checks. No archived script was executed. No formatter, Node syntax checker, project compiler, tests, evidence-checker controls, driver, holder, benchmark, dependency install, process probe or denied operation was run by this review. Only review inputs and this requested report were written locally; no repository, branch, source, existing evidence, access setting or external state was changed.

**Final disposition: two-file mechanical successor accepted; driver formatting prerequisite closed at the exact pin; syntax/build readiness, runtime/lifecycle evidence and P065 package acceptance remain separate.**
