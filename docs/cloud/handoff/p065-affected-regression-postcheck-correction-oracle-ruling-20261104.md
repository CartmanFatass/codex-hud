# P065 affected regression group 1: postcheck-target correction ruling

Date: 2026-11-04 UTC. Fresh read-only Oracle consultation. Repository: CartmanFatass/codex-hud.

## Decision

**The shortest defensible remedy is a single corrected, read-only independent postcheck, not a repeat of group 1 and not a source repair. Group 2 may then continue under its existing bounded authorization, provided the corrected check passes, the original workload/lifecycle evidence is consistent, and the dispatcher has an admitted quiet window.**

Preserve the original independent postcheck **FAIL** permanently. Its wrong-directory error is not evidence that the actual group-1 fixture directories contained residue. Conversely, 57 passing tests, the supervisor's own `postcheck_ok=true`, and a later directory listing do not turn that failed independent check into a historical PASS.

This is a narrow procedural disposition and conditional continuation rule. It does not assert that a corrected check has already run, independently certify unprovided group-1 raw bytes, accept P065 as a package, or grant a new capability, source change, broader test tranche, runtime installation, merge, or executor switch.

## 1. Evidence reviewed and its limits

Read the recorded outcome and exact dispatch for cloud task `01a1a3c0-8454-762a-a04c-d71a10b710c9`, turn `01a1a4ca-4f00-7343-a654-83466bf194f5`. The task is recorded completed, with no platform error. Its final report states:

- Group 1 ran once and passed 57/57 tests; direct and outer statuses were both 0.
- Its supervisor recorded `ECHILD`, with no unexpected adopted descendant, and `postcheck_ok=true`.
- Independent `group-1-before.jsonl` was PASS.
- Independent `group-1-after.jsonl` was FAIL because the adapted checker targeted nonexistent `/workspace/p065-regression-group-5-evidence-01`, not actual `/workspace/p065-regression-group-1-evidence-01`.
- A subsequent read-only inspection found actual HOME, HUD_HOME, and TMPDIR present and empty.
- Group 2 was not started. The executor reports no test retry, source change, dependency installation, or replacement of the original failed result.

The executor initially described the error as actual residue, then explicitly corrected that statement. Preserve both the initial report and correction; the corrected classification is the supported one.

Reported artifact identities, not independently rehashed in this consultation:

| Artifact | Reported SHA-256 / record |
| --- | --- |
| Group-1 `stdout.raw` | `da1af68a161f9ad35f3ca38d74d31da613006135500ee8756b0ab77da6950d7e` |
| Group-1 `events.jsonl` | `213fe47a25306c824370f83c6f6b433370b9a178b6c9f50b52f29eb41e72d74b` |
| Original `group-1-after.jsonl` | `717a11dde0e050e22b7de0c1143e63a5cef986debcdfe597a5bf277722323a49` |
| Recorded group-1 ECHILD monotonic ns | `17447372796428` |

The raw group-1 checker, diff, events and manifests were not returned by the thread read, and their executor paths are not present in this reviewer's environment. Therefore the single-target-error diagnosis is supported by the executor's corrected report, not independently reconstructed from its script in this consultation. The continuation conditions below explicitly require that reconstruction against the preserved originals. An unprovided raw hash or executor-local path is not a substitute for its contents.

Prior rulings read:

- `p065-audit-controls-review.md`: C-A through C-D accepted on Node 24 for the candidate; no repeat required; the two remaining affected regression groups require 600-second workload caps and matching admitted supervision.
- `audit-cloud-oracle-review.md`: six-stage Node 24 focused evidence accepted, observed direct statuses and owned-subtree ECHILD only; independent source/dependency/output/temp checks and remaining broader gates.
- `audit-test-fix-ruling.md`: bounded four-file audit repair; preserve failed evidence; only README-known flakes can receive their prescribed one isolated retry; execution windows and all broader gates remain separate.
- The preserved repository guide and README check/rerun rules.

## 2. Correct classification now

Keep these three result dimensions distinct:

1. **Behavioral workload:** reported PASS, 57/57, direct exit 0, outer exit 0. Retain and expose complete TAP counts, including fail, cancelled, skipped, todo and suites, rather than inferring every field from 57/57.
2. **Owned-process closure:** reported PASS from the original supervisor's direct wait, ECHILD and result records. Verify the full original event sequence; no new process probe is needed. The accepted label remains `exit_status_observed_exec_unverified`, not independently attested exec success or a global assertion that arbitrary escaped processes do not exist.
3. **Independent postcheck:** original FAIL due to wrong target; corrected check NOT YET RUN. Cleanup is corroborated by the supervisor and later read-only empty-directory observation, but the independent continuation gate remains open until the correctly targeted check succeeds.

This is an evidence/checker-target defect, not a demonstrated production, assertion, or fixture-cleanup defect. It does not consume or justify a source-fix round. The original stop was proper: group 2 was not entitled to run while the required independent cleanup check was invalid.

## 3. Exact immediate correction

The dispatcher can issue the following bounded continuation to the same executor. Do not launch another workload merely to investigate this checker error.

1. **Freeze the originals.** Keep the original checker, launcher, launcher diff, argv, raw stdout/stderr, events, before/after logs, outer command/status/timing files and their hashes. In particular, do not edit or overwrite `group-1-after.jsonl`, its FAIL, or its SHA-256. Do not delete/recreate or clean the group-1 HOME/HUD_HOME/TMPDIR to obtain a green check. Preserve the later read-only listing if already captured.
2. **Confirm the exact defect from files.** Read the original failed checker and failed log. Derive actual group-1 evidence root and HOME/HUD_HOME/TMPDIR paths from the recorded original launcher/environment events. Show the wrong `group-5` target and correct `group-1` target literally. Check whether this mismatch is the sole failed predicate. If the original log exposes another failed or unexecuted predicate, do not silently declare it satisfied; the corrected check must execute the complete original after-check predicate set.
3. **Make a fresh corrected checker, outside the candidate.** Copy the independent checker to a new, unused evidence filename, for example under `/workspace/p065-affected-regressions-01/`. Change only the mistaken group-1 target binding and the new check's evidence output/record labels as necessary. Preserve all identity, cleanliness, inventory, missing-path, symlink/mode and fixture-residue checks already present. Record complete original and corrected checker hashes and a literal diff. No blanket numeric replacement, guessed alternate directory, weakened assertion, baseline regeneration, or lifecycle/supervisor redesign.
4. **Reconcile original lifecycle without rerunning it.** Read the original complete events and statuses: pinned argv/checkout/runtime, direct exit 0, outer exit 0, direct wait before ECHILD, normal exec-pipe closure, `closure=true`, `lifecycle_valid=true`, `postcheck_ok=true`, no timeout/interruption, unexpected adoption, failure or postcheck error. Retain exact timing and hashes. If any material contradiction or missing required lifecycle record appears, stop; a filesystem snapshot cannot substitute for owned-process closure.
5. **Run exactly one newly timestamped read-only after-check.** Use the existing independent-check mechanism and its accepted bounded 60-second check limit, with the original group-1 pre-run manifest/baseline. Write its stdout, stderr, exit status, UTC/monotonic start/end and complete results to new files such as `group-1-after-corrected-01.*`. This is a new observation after the failed check, never a reconstructed timestamp or replacement for the historical result.
6. **Require the full check, not only empty directories.** Match candidate HEAD `3435589ef253159948c94eaae111606191bd4e3d`, tree `27d8c69594fefe83332cec00c346cc8fcf664159`, original source/configuration/1,315 tracked-file and 275-dependency identities, clean status/ignored-input state, pinned Node and checker dependencies, and all original input/output inventories. Existing production `dist`, `dist-test`, and MCP `dist` inventories are 1,101 / 1,047 / 264 entries; compare full path/type/mode/hash inventories, not counts alone. Check the actual recorded group-1 HOME/HUD_HOME/TMPDIR paths exist with their intended types and are empty. A nonexistent or unreadable path is failure, not empty. Do not substitute the unexecuted group-2 paths.
7. **Record continuity honestly.** State whether any workload, writer, cleanup, deletion/recreation, source/generated/dependency change, or original evidence change occurred since group-1 completion. The report so far says none except read-only inspection. A later matching snapshot proves the current state, not uninterrupted historical emptiness; the original supervisor's postcheck and ECHILD remain the evidence of closure at execution time.

This permitted correction is a rerun of the invalid **read-only checker** against the right target. It is not a group-1 test rerun and does not invoke, enlarge, or consume the README known-flake allowance.

## 4. Gate for continuing the already-authorized group 2

**Yes, continuation is safe and within the already assigned scope once all of the following hold:**

- The exact checker diff confirms the targeting error, with no weakened predicates or unexplained edits.
- The complete original group-1 tests/status/lifecycle evidence is consistent with the reported pass and owned-process closure.
- The new corrected independent postcheck is PASS, its full inventory matches the retained original baseline, and the actual group-1 temporary directories are present and empty.
- There is no unresolved writer/identity/cleanup collision, denied action, timeout, or uncertain process outcome.
- A named quiet window is still valid or is re-admitted by the dispatcher. Review waiting does not itself retain the resource lease. This ruling does not allocate one.
- Group 2 receives its own fresh independent precheck and exact original source/runtime/output pins before launch. Its paths and environment are mechanically checked against its own launcher so the same target-copy error is not repeated.

No new group-1 test, rebuild, A-D repetition, dependency install, source fix, or additional Oracle loop is required solely because of this one wrong-target check. The same admitted continuation can proceed from a successful corrected check to group 2; it need not stop for an unnecessary second permission round if all predicates are satisfied. If the originals reveal a broader checker defect or any substantive discrepancy, this narrow disposition no longer suffices: stop and return the precise discrepancy.

Group 2 remains exactly:

```
/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node --test packages/hud-mcp/dist/tests/hud-mcp/authorization.test.js packages/hud-mcp/dist/tests/hud-mcp/delegation.test.js packages/hud-mcp/dist/tests/hud-mcp/resume-expected-run.test.js packages/hud-mcp/dist/tests/hud-mcp/handshake.test.js packages/hud-mcp/dist/tests/hud-mcp/hook-source.test.js packages/hud-mcp/dist/tests/hud-mcp/b20-advice.test.js
```

Run on unchanged `/workspace/p065-audit-repair-verify`, candidate `3435589ef253159948c94eaae111606191bd4e3d`. Node is v24.22.1 with recorded SHA-256 `61ab14cd750fc24d5db53490ec5fc40f756e4b6e136b78cf7004265471d9bd1d`.

Use accepted supervisor base `c4f56dc06cf481df00ca5e23539f319a6fe362c4a1ee591d94590115742b6e5b` with only already permitted command/path/output/deadline substitutions. Preserve lifecycle behavior: 600-second workload cap, 10-second TERM grace, 630-second closeout, outer foreground TERM at 650 seconds plus 10-second kill-after. Keep clean environment, unique group-2 evidence/home/temp, exact argv/launcher hashes/diff, complete raw output/events, independent original-baseline pre/post manifests, direct status and ECHILD. Retain both the original group-1 failed check and corrected result in the final evidence set.

Stop on the first new test/check failure, denial, timeout, identity mismatch, missing result or unproved cleanup. Do not rerun a denied operation or use a different executor, transport, or permission to evade it. Only the existing specifically documented README-flake rule may authorize its named isolated retry, with both results retained; the checker typo is not a new test flake.

## 5. Required report and acceptance boundary

The minimal final report must say, in substance:

> Group 1: 57/57 tests passed once; direct/outer exits 0; original owned-process closure recorded. Original independent postcheck failed because it addressed group 5 instead of group 1 and is retained unchanged. At [new actual time], corrected check [hash] targeted the original group-1 paths and passed the complete identity/output/temp predicate set. This is new cleanup/identity evidence, not a rewrite of the original FAIL. Group 2 [actual status/counts and evidence].

Attach or expose the actual raw checker/diff, failed and corrected logs, original group-1 TAP/events/statuses and manifests, and group-2 evidence through an accessible supported archive or file route when the reviewing Oracle needs byte-level acceptance. Include full file SHA-256 identities and a manifest. Do not substitute only reported hashes, inaccessible executor-local links, or a label of PASS for the contents.

Both groups, if successful, close only their named Node 24 affected-regression obligations. Node 22 evidence, exact formatter/setup and whole-package formatting, remaining README/P065 gates, security/lifecycle obligations, original real-clock populations and local-only qualification remain governed by prior rulings. No P065 full acceptance, NEXT consumption, integration, gate relaxation, merge or deployment follows.

## Method

Read-only cloud-thread outcome/dispatch inspection and local ruling/repository-guide reads. No test, build, independent postcheck, process probe, source change, repository write, dependency operation, remote execution, or subagent delegation was performed. The only deliverable write was this requested standalone ruling.

**Final disposition: one immutable-evidence-preserving, target-corrected read-only postcheck is the minimal remedy. Conditional group-2 continuation is approved at the review level under the existing action authorization and a valid execution window. Group 1 is not to be rerun for this checker error; the original independent FAIL remains in the record.**
