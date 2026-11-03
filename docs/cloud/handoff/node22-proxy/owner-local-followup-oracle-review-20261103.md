# NODE22-PROXY: owner-local follow-up Oracle review

Date: 2026-11-03. Read-only evidence review; no build, test, capability probe, route server, source edit, Git mutation, or subagent was started by this reviewer.

## Decision

**Verdict for the exact dependent NODE22-PROXY/HYG2 candidate: fix required; acceptance and merge remain HOLD.**

**The new owner-local evidence completes the previously missing NODE22-PROXY compatibility matrix. The proxy-warning/capture correction is supported, not still failing.** The remaining blockers are the inherited unreadable-ancestor registration behavior and incomplete durable handoff of the earlier negative-control evidence. Neither is evidence that the proxy warning corrupts production JSON, argv, stdin, or routing.

No new implementation defect is identified in the six-path NODE22-PROXY amendment. No repeat of this completed local full matrix is requested. This is an evidence re-check of unchanged code, not another implementation/fix round.

## Exact inputs and independent inspection

- Candidate: `b4047320262f72f401a513db07236ff1473db933`; tree `d9be29f28da496a880802c267a08e8bb4fcbee74`; parent `ce5e6961a0e6de1304dcebb00fc1b8c805573ec6`.
- Implementation-branch documentation head: `65b26a914bc0f54d2a4318ebf461a52140238872`. GitHub comparison confirms that candidate-to-head adds only the four NODE22-PROXY handoff documents. There is no new implementation to substitute into the review.
- New local evidence is pinned to `local-verification/20261103` commit `1db757ec1f5c51a79f47eaabfe6483d0cb2db19d`, directory `docs/cloud/handoff/local-verification/20261103/followup-20261103T224919Z/`.
- Binding documentary snapshot: `48abc4fc5e4b71ef36af720a69cad344ad71ea34`; README blob `3029d6928c42534eee1c2fa86e1c33a2381f59cc`; NODE22-PROXY brief blob `9e1032e832c71097de2508fb0cd5b421934fbe74`; STATE blob `23e88a175620bcf5071db2f219a1206610e3205e`.
- Read AGENTS.md, docs/cloud/dots.md, README, the NODE22-PROXY brief and profile ruling, previous review-1, its implementation-report correction, the recorded enabled-Node22 cloud verification and superseding flake-closeout ruling, relevant inherited HYG2 findings, candidate code, and the new report, scripts, manifests, streams and captures. Previously verified untouched implementation areas are not reopened.

The source diff remains exactly six reserved paths: export-help wording, the two process fixtures, export tests, the new diagnostic helper, and the new profile/routing suite. Production routing, process launch, warning filtering, serialization, ledger runtime, and MCP registration code are unchanged by the amendment.

Primary links:
- [New report](https://github.com/CartmanFatass/codex-hud/blob/1db757ec1f5c51a79f47eaabfe6483d0cb2db19d/docs/cloud/handoff/local-verification/20261103/followup-20261103T224919Z/REPORT.md)
- [Previous review](https://github.com/CartmanFatass/codex-hud/blob/65b26a914bc0f54d2a4318ebf461a52140238872/docs/cloud/handoff/node22-proxy/review-1.md)
- [Binding brief](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/NODE22-PROXY.md)
- [Proxy-profile ruling](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/rulings/node22-proxy-profile.md)

## What was tested and what it establishes

The three required profiles are the exact Node 22.23.4 enabled-proxy profile, the same Node 22 binary/proxy policy with only activation omitted, and explicitly enabled Node 24.22.1. The wrapper retains the owner's proxy variables, uses fresh HOME/HUD_HOME/TMPDIR and separate raw streams, and does not suppress or normalize warnings. NODE_OPTIONS was reported absent in the invoking shell. These are the pinned diagnostic profiles, not proof about every Node version or network API.

| Area | Actual check | Recorded result in all three profiles | Scope of conclusion |
|---|---|---|---|
| Runtime diagnostic boundary | `node-proxy-profile`, concurrency 1 | 5/5, exit 0, no skip/cancel | Minimal no-HUD startup bytes, closed warning matcher, wrong/missing/extra diagnostics and changed stdout/reason/status controls, forbidden diagnostic settings, and routing witness reach their assertions. |
| Export and process fixtures | Complete three files, concurrency 1 | 76/76, exit 0, no skip/cancel | Exact export/application output and separated stdout/stderr; original argv/stdin/EOF, helper exit, scope and cleanup assertions are reached. |
| Normal scheduling | Same complete three files, normal runner | 76/76, exit 0, no skip/cancel | The serialized result is not being substituted for normal-runner coverage. |
| Inherited HYG2 regressions | Original six-suite command | 76/76, exit 0, no skip/cancel | SQLite-warning suppression remains narrow; unrelated warnings, warning-function restoration and the inherited helper regressions remain covered. This is a different 76-test set. |
| Full README matrix | Three fresh builds, npm test, core, visual, hud-mcp, format, fixtures, diff | Complete as detailed below | Current-host final-candidate coverage, with the named-flake rule applied exactly. It does not exercise every historical topology. |

No `--test-name-pattern` appears in the required commands. The old 15-selected-test evidence is not used as a replacement for these new unfiltered checks.

### Full README results

- **Node 22 envproxy:** all three builds and every other required command exit 0. `npm test`: unit 2,346 pass / 0 fail / 16 skip out of 2,362, then mjs 47/47. Core 209 pass + 1 skip; visual 319/319; hud-mcp 83 pass + 1 skip.
- **Node 24 envproxy:** the same passing totals, all required commands exit 0. The raw Node 24 reporter uses `ℹ` summary lines rather than the Node 22 TAP `#` summaries; both were inspected, including the mjs stage.
- **Node 22 no-envproxy control:** all three builds, core, visual, hud-mcp, format, fixtures, diff and four focused commands exit 0. Original `npm test` remains **exit 1: 2,344 pass / 2 fail / 16 skip**. It did not reach mjs; the separately labeled mjs supplement passes 47/47.

The control's two failures are precise and preserved:

1. `logs/n22/node22-noenvproxy-control/04-npm-test.stdout:2410`: B11 local resume preserves parameters/rejects stale or active/replays through B4. The assertion expected `slot_busy`, but received `Ledger busy: no operation was accepted within the write-lock budget`; the top-level assertion code is `ERR_ASSERTION`.
2. Same file at line 3956: B21 real-SQLite MCP refusal is stable and never dispatches a launch; error code `ledger_busy`, same write-lock-budget message.

These are the README's existing named ledger_busy family, not new warning/routing exceptions. Each entire affected suite received exactly one isolated rerun under the same control profile and candidate: b11-cli **20/20**, then b21-capacity **5/5**, both exit 0, at 23:08:27–23:08:31 UTC. Both original and rerun outputs are retained. This satisfies the prescribed local known-flake disposition. It does **not** make the original aggregate an exit-0 run, prove host-load causation, or authorize retry-until-green.

### Why the original proxy failures were not evidence of broken core transport

The prior ruling distinguished two defects in the tests/documented boundary:

- Export success/refusal tests incorrectly required total-process stderr to be empty or begin with the HUD reason. Enabled Node 22 legitimately adds its startup diagnostic on stderr. The correction requires the **exact expected diagnostic plus the exact application line**, while keeping stdout/status/no-write assertions. It does not accept arbitrary warnings or hide the SQLite notice.
- The two process fixtures connected stdout and stderr to the same descriptor. Their JSON/echo comparisons therefore read Node warning bytes mixed into their own capture file. That showed a capture-fixture defect, not demonstrated production argv/stdin corruption. The fix gives the streams distinct descriptors and tests a deterministic stderr sentinel, so separation is verified even when no warning is emitted.

The new owner-local enabled-Node22 runs actually pass those corrected assertions. I independently inspected the synthetic captures: pure expected JSON/brief on stdout; two distinct Node-warning contributions plus one sentinel for the native helper/workload pair; one contribution plus sentinel for the shell-leader workload; sentinel-only stderr in the control and Node 24 profiles. No actual stream was normalized for this review.

The routing suite records 14 observations per profile, 42 total: direct and production launchGroup paths, uppercase proxy use/bypass/disabled, lowercase precedence/bypass/disabled, and lost-environment controls. Hit counts and target observations match the declared cases. Raw workload streams preserve synthetic argv/stdin/environment values. This establishes the specified loopback HTTP/default-fetch behavior, **not** HTTPS/TLS, external services, real harness capability, all network APIs, or a native exit-status guarantee for the shell route.

## Previous findings: disposition

### F1. Missing exact-candidate verification — completed for the new local group

The missing full/unfiltered three-profile matrix and owner-profile attribution have now been supplied. Counts, metadata and raw streams agree. The two listed control-profile flakes have the permitted once-alone complete-suite reruns. This closes the local verification-coverage deficiency of F1; it does not close F2 or turn all historical red matrices green.

The earlier cloud enabled-Node22 hud-mcp aggregate remains **81 pass / 2 fail / 1 skip**, with B45 accepted-spawn and G03 old-request-key `ledger_busy` failures. Its deferred isolated-closeout counters are not consumed, reset, or fulfilled by this separate owner-local group. Preserve that separate record; do not reopen the returned cloud lease or rerun unrelated matrices merely to rewrite history.

### F2. Inherited unreadable-ancestor physical registration — not fixed, P2 blocker

`packages/hud-mcp/src/process.ts:29,62–65`; `packages/hud-mcp/src/registry.ts:84–88`; `tests/hud-mcp/int-ledger-registry.test.ts:47` — optional ancestor discovery still invokes a reader that treats an unreadable ancestor environment as fatal. On the earlier exercised topology it aborted physical caller registration before the real procStart/cwd assertions. This code is untouched in NODE22-PROXY.

The new hud-mcp suite and physical-registration test pass on the new readable traversal. The recorded command ancestry is the owner's UID-1000 shell/Claude/Herdr chain. Before/after probes on both runtimes find the sole root-owned EACCES at PID 1, which `findHarness` does not visit (`pid > 1` loop). The earlier relevant root-owned Relay topology was not naturally reproduced. The report states this correctly. An unreadable PID 1 somewhere above the process is not the missing test case.

This is a **topology-dependent functional registration issue and an unfulfilled required failure-mode gate**, not a proxy-warning issue and not evidence that registration always fails. A passing physical-registration test in a different topology cannot erase the exercised failure. Resolve through the separately scoped MCP-ANCESTOR work and an explicit integration disposition. Keep mandatory self/parent/domain/stamp/cwd identity requirements and the prohibition on deriving logical authority unchanged. No import of an unaccepted MCP fix into this candidate is authorized.

### F3. Durable historical negative-control evidence — partly fixed, P2 handoff blocker

`docs/cloud/handoff/node22-proxy/review-1.md`, F3; NODE22-PROXY §§9–11; new `REPORT.md` §6 — the new local positive evidence is remotely readable and its inspected bytes match the published manifest. That is meaningful progress. It is not the earlier implementation archive/courier containing the mutation/failing-before evidence.

The new owner run intentionally made no negative-control source/build mutations. Prior review-1 had verified those controls locally, but could not establish their durable remote copy. The dispatcher confirms the earlier 13-part publication was stopped by the owner and no verified remote retrieval record exists. Therefore F3 is **not fully closed**. This is an evidence-custody requirement, not a new finding of defective product behavior.

Preserve the old local archive and its prior hashes. Do not restart a user-stopped publication automatically, call a selected courier the complete archive, or rerun all tests to solve an archival issue. Completing a properly authorized, privacy-checked archival/readback step would close this part without a new implementation round. If publication is intentionally not resumed, a change to the evidence gate requires an explicit disposition rather than an implicit waiver.

## Independent integrity and provenance results

- Retrieved all 46 NODE22 command metadata/stdout/stderr triplets, including installation, every full/focused command, mjs supplement, and both reruns, directly through GitHub at the pinned evidence commit. All 46 metadata files embed the expected candidate/tree and runtime/profile.
- Independently read back and SHA-256 checked **580 published evidence files** relevant to this review, including common manifests, all NODE22 command triplets, **408 synthetic capture files**, and five ancestry records. **580 matched; zero mismatched.** This is a bounded audit, not a claim to have fetched every one of the directory's 4,059 manifest entries.
- Published `SHA256SUMS` SHA-256: `55ed05db89882c5f9e419c27ff0c70206135ce80857eece202c061e5be0f12b9`.
- `RAW-SHA256SUMS` SHA-256: `67f158c23283b5411214a66d2936d5146a5232390d8eadcfb8e009ffb87fb9b7`.
- Both manifests list equal raw/published hashes for **all 3,369 NODE22 capture paths**. The 408 fetched captures match the published hashes. This supports the claimed no-redaction boundary for these synthetic streams; the raw private originals were not accessed and the entire archive was not authenticated independently.
- Inspected 78 export records from the three serialized capture sets: status/signal and exact startup-plus-application stderr agree with the source-defined cases, including successful silence after the permitted startup prefix, refusal reasons and output-failure results. Inspected nine minimal startup records and six original process-target stdout/stderr pairs. All checks of these recorded bytes agree.
- Inspected all 42 direct/launchGroup routing capture triplets and the corresponding recorded hit/target observations; exact workload payloads and diagnostic bytes agree with the declared cases.
- The 1,302-file pre-install source manifest matches the clean local checkout at the exact candidate; the three new generated manifests are identical, and all **2,311 generated-file hashes** also match the existing frozen local candidate artifacts. No build was run by this reviewer. The manifest digest is `1b968283048af80e3aec55e484efb5f7200498df419538663d778276ab745ccc`.
- HEAD/tree are unchanged in the before/after records. `npm ci --ignore-scripts --prefer-offline` changes only tracked `node_modules/.package-lock.json` in status, explicitly disclosed and unstaged. The tracked-byte digest remains `fd7a39d7db49d7b9892c46c20870f7ca5076bab9cb28e0ad0cd7e6608a04087f` after install, after checks and at final inspection. This is not mislabeled as an entirely clean post-install worktree.
- These checks establish remote availability and internal consistency of the reviewed artifacts. They do not independently authenticate the historical process execution, prove every cleanup claim from a snapshot, or promote current-host behavior to formal supported-WSL qualification.

The implementation-report wording correction remains applicable: the helper rejects forbidden child flags when flags are supplied; positive `validateStartup` calls use the default empty flag list and fixed inspected launch sites. It is not a general argv monitor.

## Bounded next step

1. Record the newly completed compatibility verification and the precise known-flake disposition. Retain original failures unchanged. **Do not ask for another blanket NODE22 full-suite run.**
2. Keep the dependent candidate unaccepted until the separately assigned MCP-ANCESTOR real-unreadable-ancestor/integration disposition resolves F2. If the natural relevant topology is absent, keep that fact unproven; do not force a convenient topology, bypass EACCES, or substitute synthetic evidence for the required real-host case.
3. Keep the earlier mutation archive intact. Resolve its interrupted publication/readback under current explicit authority, without new tests, new code or automatic resumption of the stopped publication.
4. After the open dependent gates are resolved, obtain the appropriate fresh exact-tree acceptance review. Only then may the normal `--no-ff` integration and required merged-tree check set occur under the dispatcher rules. No merge, deployment, later-wave release, performance waiver, or change of supported profile is granted here.

**Summary for the owner:** the proxy-enabled output/launch/routing checks now work on the required local profiles. The two local remaining red records are known ledger_busy failures with prescribed successful reruns. The package is still held for a different, inherited ancestor-registration case and old evidence archival, not because a normal proxy warning is itself considered a core functional failure.
