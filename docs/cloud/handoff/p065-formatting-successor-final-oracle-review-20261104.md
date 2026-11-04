# P065 formatting successor: final narrow Oracle review

Date: 2026-11-04 UTC. Repository: CartmanFatass/codex-hud. Review scope: the one-file formatting successor and its retained formatting/hygiene evidence only.

## Decision

**PASS, narrowly. FMT-1 is closed by the separately identified format-fix result at commit `306fa579c2b7fffabbc0fc1739ed0d25f22faac3`, tree `bf00473136dc42cb5a0d320447239e848592270e`.** The published file is exactly the retained formatter stdout, and the complete source delta consists of four mechanical newline/indentation adjustments in `tests/unit/p065-budget.test.ts`. No other tracked file or file mode changed.

The formatting prerequisite in the existing Node 22 validation plan is now satisfied. Bind that plan's `FINAL_SOURCE` and `FINAL_TREE` to the literal identities above, including every checkout, launcher, independent checker, manifest, evidence label and control base. Preparation and execution may proceed **only under that plan's existing named quiet-window and launcher admission requirements**. This review neither starts a workload nor supplies a compute lease.

The original V3 FAIL remains historical FAIL. No earlier behavioral execution is relabeled as having run at this successor. P065 remains **WIP / NOT ACCEPTED / NOT MERGEABLE / NOT PERFORMANCE-QUALIFIED**.

## 1. Evidence actually inspected

I read the governing formatting ruling and the Node 22 plan; the recorded cloud-task dispatches and completed turns; the immutable GitHub commit, parent, branch ref, complete comparisons and recursive trees; both complete versions of the changed file; the formatter configuration; and the retained raw archive described below.

Cloud task: `01a1a3c0-8454-762a-a04c-d71a10b710c9`.

- Original-input debug-check and stdout generation: turn `01a1a4e6-d3e9-7773-9a8b-64cf3a1c4d9b`.
- Successor validation: turn `01a1a4ec-6655-7277-8a6a-1a14717309ab`.
- Existing-record export only: turn `01a1a4f0-172e-74a7-ab0d-a7c55c86ab47`.
- Original failed V3: turn `01a1a4de-0c8c-759b-8dd5-69a52b059e9e`.
- Original official-tool preparation: turn `01a1a4db-d48c-70c4-917b-b2320b05e360`.

The exported archive is `p065-format-oracle-records.zip`, Library ID `libfile_653d1513f4008191ad9be52d8d21521d`, File ID `file_00000000e3d881f5bc1d6930ed9505c9`, 2,758,244 bytes. I materialized and read it, independently obtained SHA-256 **`b9ec60fb38ead22f490e5d7e3cace5313b4f9faf62455a708946a46c49d7e98c`**, and verified **all 67 listed members against SHA256SUMS**. The ZIP has 68 members including SHA256SUMS itself. There was no execution of any archived launcher or checker.

This is therefore not a conclusion based solely on the cloud assistant's summaries. Raw stdout/stderr, event records, before/after records, launchers, launcher diffs, the successor manifest and hygiene receipts were independently inspected. The original remote binaries and source directories were not accessed on their executor by this reviewer; binary/package custody is established by the inspected recorded checks, not a new live binary attestation.

## 2. Exact lineage and complete scope proof

The successor has the sole parent `9fbf258a704e8fdfb99febae2635261a63ade5f6`, whose tree is `2c1e698ffeae6ccccc0890431b2e06e36d8df388`. The comparison is one commit ahead and zero behind. During this review, remote `refs/heads/dots/p065-budget` read back as the successor.

Both complete recursive-tree responses are explicitly untruncated. Each contains 1,451 entries, including directories, and **1,320 tracked leaves including 275 node_modules entries**. Comparing the full leaf path/type/mode/blob/size records gives exactly one difference:

| Identity | Before | After |
|---|---|---|
| Path | tests/unit/p065-budget.test.ts | same |
| Mode/type | 100644 / blob | same |
| Bytes | 27,862 | 27,892 |
| Git blob | 7c0d9b190c684509002dd8646d751828f5ec8fb0 | 69918dcd6fc42e27ab4b615ea6d6a84cf06833f8 |
| SHA-256 | 190e03adeff542c36cd815bd5c464611d0066e16e87494a64f99178707eabb32 | 96d6a9c78ad049a407e7fe5a5385c22fc77e51ff8682b508a6290e3615b46d84 |

I independently calculated both SHA-256 values and Git blob identities from the complete connector-returned content. I also compared the actual archived generated stdout bytes directly with the complete published successor file: **byte-for-byte equal**, not merely reported-hash equal.

All remaining 1,319 tracked leaves are identical to the parent. In particular:

| Preserved path | Unchanged Git blob |
|---|---|
| tests/unit/p065-budget-fixture.ts | 4264874ef20ebbae2fabe80fe505785c8a89c191 |
| src/ledger/intents.ts | 422870d6c487b43e23636b0bb1d40062f1ec434d |
| tests/ledger/process.mjs | e7c0e0ea61452c7c34427ed660a2e4f70e3675be |
| tests/unit/ledger-processes.test.ts | 0c32f4964605f213c25c7883716c29548f9046b0 |
| tests/unit/p065-rejection-audit.test.ts | 6a1ffb4729b0788ea6d0e2683f0faca5477a137c |
| .prettierrc.json | 8c8ff890b8e9c45fc9a58a7ac588cabaa121f96f |
| .prettierignore | d4e852dbff0a9dd57a81ef935dd7ff63b1a70a14 |
| package.json | 53182affe4637beb767664c56c288ae9e7dd4585 |
| package-lock.json | 87327f35757f729247f1f2256e7ba87345956a01 |

The fixture SHA-256 remains `3c7c777e2b29e8712e9cb53d83084e5a0cc61cb205b617e113120ab0db99ec87`. No dependency, lockfile, production/audit source, test population, formatter configuration, executable mode or permissions delta is present in the committed tree.

I also independently reread the complete comparisons supporting the historical relationship:

- `3435589ef253159948c94eaae111606191bd4e3d` to `9fbf258a...`: four commits, five added documentation files only.
- `cd2dce1623a07f78a707f8bf0a998ebe8a5c0d66` to `9fbf258a...`: the already reviewed four audit paths and eight additive records; neither formatting target, any formatter configuration nor dependency input changes.

The archive correctly identifies debug/generation as read-only runs from frozen `/workspace/p065-repaired-verify` at `cd2dce16...`, tree `26c77dcd23b559e405173427bf8681c5b5181675`. They were not runs at 9fbf258a. Their original target bytes and formatting inputs are equal to the correction preimage, and their checks preserve the frozen source and prior compiled inventories. Final check-only validation is separately at the exact new successor in `/workspace/p065-format-successor-verify`.

## 3. Mechanical equivalence

The four entire diff hunks were read. They do only the following:

1. Put the existing `assert.deepEqual` call comparing sorted active run IDs with sorted baseline IDs on one line.
2. Put the existing `assert.rejects(f.ledger.transaction(() => 1), /ledger_closed/)` call across four lines.
3. Apply that same multiline layout to the corresponding `observed.ledger` call.
4. Apply that same multiline layout to the corresponding `ledger` call.

All changes occur inside the same parenthesized call expressions. Tokens, call receiver, arguments, callback body, await, regex, assertion, evaluation order and surrounding statement boundaries are preserved. No line-sensitive comment, directive, literal or automatic-semicolon-insertion boundary changes. Imports, registration/options, all fifteen construction cases, mocks, cleanup and the construction-only qualification comment are untouched.

As a completeness check, each exact old hunk occurs once in the full preimage. Applying only those four literal substitutions to that full preimage reproduces the entire published successor. This is corroboration of the inspected syntax, not a whitespace-stripping or regex-token substitute for semantic review.

The archived full unified diff has SHA-256 `4d5efc8fe556959ea473d2391babb531f080843b5bcc213012150beb68453d71`. Original-input debug-check provides separate formatter-level corroboration. **No semantic change or unexplained hunk was found.**

## 4. Tool, configuration and raw run evidence

Recorded runtime and formatter identities match the ruling:

- Node 24.22.1: `/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node`, SHA-256 `61ab14cd750fc24d5db53490ec5fc40f756e4b6e136b78cf7004265471d9bd1d`.
- Prettier 3.9.9 entry: `/workspace/p065-official-tools-01/prettier-3.9.9/bin/prettier.cjs`, SHA-256 `6e922134a3c76fd4de202959bb6aef50bde0c994148075003a15569b7197906e`.
- Retained official formatter tarball SHA-256: `c3b162d30c45126873cc6338a539383e92120a390d10de78f373f42c2045b338`.
- Tarball SRI: `sha512-Z/CJHIkdujO/OtN7nXUii0Rf3VT5SRuhjBA82Xvu2XhBUgX3nhP67T0LHceBdQLex7OOFGTox+Q5Yg8Jk2Qivg==`.

The inspected independent checker verifies package name/version, tarball SRI against the unchanged lockfile, safe archive member types/paths and equality of the entire extracted package to the tarball. All **56 formatter files** have identical inventories in all six pre/post records. This is more than entrypoint-only verification.

Configuration remains printWidth 120, tabWidth 2, spaces, semicolons, single quotes and trailingComma es5. The ignore file does not exclude either target. Neither command uses Prettier cache, write, unmatched-file, ignore-unknown, custom parser/plugin or changed configuration options.

All three exact inner argv use the Node and Prettier paths above:

| Stage | Remaining argv | Direct / outer exit | Terminal ECHILD monotonic ns |
|---|---|---|---|
| Original-input debug-check | --debug-check tests/unit/p065-budget.test.ts | 0 / 0 | 19330013828652 |
| Generate exact stdout | tests/unit/p065-budget.test.ts | 0 / 0 | 19352779368449 |
| Frozen successor check | --check tests/unit/p065-budget-fixture.ts tests/unit/p065-budget.test.ts | 0 / 0 | 19713109756597 |

Original debug stdout is exactly `tests/unit/p065-budget.test.ts\n`, SHA-256 `f43bda5707ec532838241d6c83bf7e9838a38ae8a410394260913d0c3d9464de`. Generated stdout is the exact 27,892-byte successor described above. Final stdout is exactly:

```text
Checking formatting...
All matched files use Prettier code style!
```

Final stdout SHA-256 is `17aa973d3f004560237d9a95171210b0671deff23d61628eecf7322ff5938f20`. All three stderr files are empty, with SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. No warning or error is present.

The recorded outer intervals, in UTC, are:

- Debug: 04:53:34.527887 to 04:53:35.521342.
- Generation: 04:53:57.556087 to 04:53:58.255913.
- Successor check: 04:59:57.717757 to 04:59:58.554438.

Each raw event stream records initial ECHILD, subreaper readback 1, owned child/pidfd creation, release, exec-error-pipe EOF without error, direct wait status 0, terminal ECHILD, final pipe EOF and successful identity postcheck. Each result has closure=true, lifecycle_valid=true, postcheck_ok=true, unexpected_descendant=false, failure=null, interrupted=null and post_error=null. No timeout or termination path fired.

Preserve the recorder's exact scope: it labels `compiler_result=exit_status_observed_exec_unverified` and `exec_state=no_error_reported`. Its reused field name does not mean a compiler ran, nor is EOF elevated to an independent exec-syscall attestation. The specific formatter stdout, direct status and retained launcher/identity evidence support this formatting result.

The actual launchers preserve the same 300-second workload, 10-second grace and 330-second closeout logic, owned-child handling, error channel and six-key cleared environment. Fresh HOME/HUD_HOME/TMPDIR roots are unique per stage. Small Node compile-cache files appear only under those newly created temporary roots and are inventoried; they are not a reused Prettier result cache or repository output.

Comparing the actual debug and successor launcher text shows the expected pin/path/argv/manifest changes plus the checkout-appropriate bootstrap predicate: the historical read-only checkout requires its preexisting dist-test; the new pristine successor checkout rejects dist-test. That does not weaken source identity or alter lifecycle behavior. The final independent checker also requires all three build-output directories absent.

## 5. Identity, hygiene and custody checks

For each stage, I compared the raw independent before/after records. Identity lists, formatter archive/inventory, tracked path/blob/SHA-256 records, dependency counts, clean status, ignored-input lists and repository-output inventories are equal.

The debug and generation records each cover all 1,311 tracked entries in their historical checkout, including 275 dependencies. Their prior dist/dist-test/MCP-dist inventories remain unchanged. The successor records cover all 1,320 tracked entries, including 275 dependencies. I additionally compared **every successor tracked path/blob in both recorded manifests against the independently fetched immutable GitHub tree**: all 1,320 match. The checker verifies index stage, file bytes, symlinks and executable modes, not just counts.

Successor status-before and status-after receipts are empty. Independent untracked status is empty; ignored source/test/package/dependency input lists are empty. Dist, dist-test and packages/hud-mcp/dist are absent before and after.

The existing-record export identifies the committed hygiene command as:

```text
git diff --check 9fbf258a704e8fdfb99febae2635261a63ade5f6 306fa579c2b7fffabbc0fc1739ed0d25f22faac3
```

Its archived status is 0 and both output files are empty. The command identity is supplied by the recorded executor response; the status/output bytes were independently read. It checks the full actual committed delta rather than an empty worktree or the obsolete V3 range. With the independently established one-file scope, the lack of a pathspec is not an expansion of a write or workload.

Useful raw custody hashes:

| Artifact | SHA-256 |
|---|---|
| Debug events | 7fbb7caf9222e9db480e934242973428f59f96f2475c382bd01793ac7fac2027 |
| Generation events | 6bd161f15c13190a4209f7fb0de578ab76338d33ae456a79a795ac6e5bcedcc4 |
| Successor events | 8c1f2faae6443bf3b694b200e711b62c54faf4c14719ce7c0fec86aff0542860 |
| Successor launcher | fb55b8caf75b3ef608b82e88a8a5c08342b2a8a271e66282850a6ba03d4edc1c |
| Successor source manifest | cf34937eb61b8afc3c2ba1394b826916d5ccd2a9c08aa450d74e92f8dfa0e93e |
| Successor before record | eeb877c89378c9ccecbbdbf94a73a4915f97cffa3857ac46f23ee169c467fac6 |
| Successor after record | 0ecb4a9d56c81d7dea58213de8ac6fb76d73113a06cae502d6b1f210c5d114dd |

The raw archive retains the remaining per-file hashes and the complete records.

## 6. Node 22 and remaining boundaries

The existing Node 22 plan can now replace its unresolved placeholders with:

- FINAL_SOURCE = `306fa579c2b7fffabbc0fc1739ed0d25f22faac3`.
- FINAL_TREE = `bf00473136dc42cb5a0d320447239e848592270e`.

Its already prepared Node 22.23.4 binary and checksum, fresh-checkout/dependency rules, six positive stages and later isolated A–D controls remain unchanged. Fresh builds must use the final source; old compiled graphs must not be transplanted. Any generated layout/source-map differences caused by formatting need normal identification, not an old-output equality assertion. Because intents.ts is unchanged, the accepted A–D literal mutation/source hashes remain applicable; every control's full baseline must nevertheless carry the final source/tree.

Do not rerun accepted Node 24 behavioral groups solely to attach a new SHA to old evidence. The exact source relationship established here preserves the prior C1–C4 and audit evidence at their true historical pins. This review is neither a new compile/test result nor Node 22 coverage.

Still outstanding or held:

- Four audit paths' required check-only formatting and complete final-source format:check are separate obligations. This two-file pass does not establish either.
- Node 22 focused positives, controls and its separately admitted affected regressions.
- Node 24 affected regression group 1 retains 57/57, original checker FAIL and corrected PASS. Group 2 retains 61/62, exit 1 and the B20 /proc/5200/environ EACCES with unobserved historical process role.
- No unchanged B20 aggregate replay, altered process topology/transport, procfs retry, C3 scope transfer, MCP-ANCESTOR import or failure suppression is permitted by this formatting verdict.
- Remaining README/P065 gates, real-clock populations/numeric samples, real-harness/platform and local-only qualification, final package Oracle acceptance and actual merged-tree checks.
- Assistant-run local testing remains withdrawn. No dependency consumption, main update, merge, deployment, fix-round reset or performance promotion follows.

Preserve the old V3 FAIL and all old logs as separate evidence. Archive this new narrow PASS under a new record, without overwriting historical outcomes. A future documentary descendant does not silently change the run pin; use the immutable reviewed successor unless separately reconciling a new full-tree baseline.

## Sources and method

- [Reviewed successor commit](https://github.com/CartmanFatass/codex-hud/commit/306fa579c2b7fffabbc0fc1739ed0d25f22faac3).
- [Exact parent-to-successor comparison](https://github.com/CartmanFatass/codex-hud/compare/9fbf258a704e8fdfb99febae2635261a63ade5f6...306fa579c2b7fffabbc0fc1739ed0d25f22faac3).
- [Published formatted test](https://github.com/CartmanFatass/codex-hud/blob/306fa579c2b7fffabbc0fc1739ed0d25f22faac3/tests/unit/p065-budget.test.ts).
- [Audit-to-parent documentary lineage](https://github.com/CartmanFatass/codex-hud/compare/3435589ef253159948c94eaae111606191bd4e3d...9fbf258a704e8fdfb99febae2635261a63ade5f6).
- [V3-to-parent lineage](https://github.com/CartmanFatass/codex-hud/compare/cd2dce1623a07f78a707f8bf0a998ebe8a5c0d66...9fbf258a704e8fdfb99febae2635261a63ade5f6).
- The governing formatting ruling, existing Node 22 plan and exact task/archive identities above.

Method: read-only connector inspection, archive-member reads, independent hashes/content comparisons and this requested report. No formatter, project compiler, test, benchmark, fixture, source writer, dependency operation, process probe or denied operation was run by this review. No repository, branch, prior evidence or access setting was changed.

**Final disposition: mechanical successor accepted; FMT-1 closed; Node 22 formatting prerequisite discharged with the exact new source pin; package HOLD unchanged.**

