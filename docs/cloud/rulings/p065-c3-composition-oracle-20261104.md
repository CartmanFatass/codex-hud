# P065-on-C3: independent narrow composition ruling

Date: 2026-11-04 UTC. Repository: CartmanFatass/codex-hud.

Scope: fresh, read-only review of the source-only preparation candidate and its complete inventories. This is not another implementation review, an execution review, P065 package acceptance, or an integration admission.

## Decision

**ACCEPT the exact conservative source composition at `33dd1bd4ce82c39aa2dceea2d5ce686c02e0faf5`, tree `ef8dc07594d5605eeeb94f3e2bac3e81c80e8822`, as the frozen P065-on-C3 preparation candidate. No composition correction is required.**

**P065 remains UNTESTED ON THIS COMBINATION, UNACCEPTED, NOT PERFORMANCE-QUALIFIED, and NOT ELIGIBLE FOR INTEGRATION.** Acceptance here applies only to the source-composition subtask. It does not satisfy the package accept verdict in the repository merge rule.

The next useful task is a new, source-only exact-candidate build/readiness proposal, with fresh evidence identities and separate execution admission. Do not start a workload from this ruling. Do not substitute this source into the old `8f67f7e2` sealed launchers or reuse their output baselines as this candidate's outputs.

## 1. Exact identity and independent proof

- Branch: `dots/p065-c3-prep`.
- Commit: `33dd1bd4ce82c39aa2dceea2d5ce686c02e0faf5`.
- Tree: `ef8dc07594d5605eeeb94f3e2bac3e81c80e8822`.
- Ordered parent 1: `26096e825baeccbce1403c8cbffa964e243f83ff`, tree `a29a8d6d76fb6f2fa70406aba05bd746b88d4844`.
- Ordered parent 2: `585d14217b1d99192a5dd87b6efcc0f4c36c9323`, tree `8fa52cb8946be31c3b96a597ff1f4459ae6e86da`.
- Independently verified merge base: `26f6fba36948e6c96e2e109cb374c0d4dbb9ab22`, tree `03bd36610d46fd220eb9c0e4fbf153a52bc3c3b9`.

Fresh connector reads confirmed the branch commit, commit tree and exactly two parents in that order. A fresh comparison of the two parents identifies the declared common base. Both histories are retained without treating a textual conflict resolution or a squash as this preparation.

I retrieved complete, untruncated recursive trees for the common base, both parents, the candidate, the accepted C3 integration, and the historical P065 implementation source. Comparisons use the complete `(path, mode, type, object SHA)` identity, not a diff-stat or patch excerpt.

The independently reconstructed conservative rule is: where target and P065 agree, retain that entry; where one equals the base, take the other; otherwise stop. Absence is included in the comparison. I also checked file/directory prefix collisions.

Verified counts:

- Base: 1,302 leaves.
- Target: 1,391 leaves, with 110 changes from base: 84 `docs/` and 26 non-`docs/` paths.
- P065: 1,336 leaves, with 61 changes from base: 26 `docs/` and 35 non-`docs/` paths.
- Overlapping changed paths: zero. Conflicts: zero. File/directory collisions: zero.
- Candidate: exactly 1,425 leaves, comprising 1,254 unchanged-base leaves, 110 target-owned leaves, and 61 P065-owned leaves.
- Target-to-candidate difference: exactly the 61 P065 changes, no additional path or identity.
- P065-to-candidate difference: exactly the 110 target changes, no additional path or identity.

The actual remote candidate equals that reconstruction at every leaf. The provided predicted inventory and all 1,425 unique source-owner rows also match, including each row's base/target/P065 identity and its recorded owner. Both supplied parent-to-candidate comparison lists equal the independently computed complete differences.

I separately reconstructed canonical Git tree bytes from the supplied leaf inventories and hashed them. The base, target, P065, and candidate root hashes all equal their independently retrieved GitHub tree identities. This verifies the complete inventories, rather than trusting the report's claimed root alone. Every entry in the preparation packet's 14-file SHA256SUMS inventory matches; its preserved disposition is byte-identical to the supplied governing ruling, SHA-256 `dbdde1180e5934c1cead3d7728d62a4d5da88e99360ffc5bc6b633022954eb42`.

Fresh reads also found the protected input refs unchanged:

- `universal-hud`: `26096e825baeccbce1403c8cbffa964e243f83ff`.
- `dots/p065-budget`: `585d14217b1d99192a5dd87b6efcc0f4c36c9323`.
- `dots/b10b-s3f-next`: `60b5959d02516e73d30cd5a55913eb6988a94ea9`.

These are point-in-time observations, not a branch lock. Before future use, verify the exact frozen commit rather than silently following a moving branch. The report's account of branch absence and the earlier denied-then-authorized publication is historical preparation evidence; this read-only review did not replay those writes or independently recreate their authorization events.

## 2. Ownership and source scope

All target-owned entries are retained exactly, including current STATE/plan and C3 records. All P065-owned source and review entries are retained exactly. There is no new source blob, hand-edited resolution, generated-output entry, dependency-state change, or additional implementation path in this composition.

The source inputs contain no NEXT or B10D import beyond the already approved target's documentary references. The composition introduces no renderer/collector implementation. It does not enlarge P065's edit ownership to C3's files: `src/ledger/runtime.ts`, the run/process paths, MCP process discovery, and the other 26 non-document C3 entries remain inherited accepted-baseline material. Previous P065 path dispositions and accepted implementation reviews remain at their original scope; this ruling does not reapprove or reopen their unchanged implementations.

The new source-only preparation disposition specifically permits this accepted C3 baseline. It is not a general waiver of earlier restrictions against importing unaccepted packages, and does not release an implementation fix round.

Independent historical comparisons confirm:

- P065 implementation `8f67f7e2d8249295e5a84af0bb9b98817a30459c`, tree `3e30a63f21d2c50389444dff65f2c47d1c3af3c4`, to P065 documentary head: exactly seven added review documents and no non-document difference.
- Accepted C3 integration `5d2c0709c8e9674254214add15f2a04cfd606443`, tree `48f59142862f643a98286e3d196d23ff13059a23`, to the selected target: exactly four document paths and no non-document difference.

The complete path lists are retained in the accompanying independent evidence JSON and the verified preparation packet. No preservation claim relies on sampling a few important files.

Freshly retrieved candidate bytes independently yield:

- Driver `tests/int/p065-budget-benchmark.mjs`: 90,091 bytes; Git blob `8ddcd04417d9c4cd62e13f8c59a3b5500a8532c0`; SHA-256 `fb9559202caa4e4f20b01698392bb77afe7699251ecf5a2d3a51ad546aa227c8`.
- Holder `tests/int/p065-ledger-holder.mjs`: 13,331 bytes; Git blob `2ca327ce7ff2bc892d2fcdb9aa8155c62a612c2d`; SHA-256 `bb63d2f95546e607ee3e014604402ea10bd9e087393b2a482adbe340dc4dcef3`.

Both are exactly the reviewed original bytes. That preserves source-review credit, not execution credit on a new transitive graph. For a concrete changed dependency, P065's `src/ledger/ledger.ts:5` imports C3-owned `src/ledger/runtime.ts`. P065's delegation module also imports C3-owned `src/core/run/process.ts`. The unchanged driver loads six compiled modules, and the holder additionally consumes compiled ledger/supervisor/observation paths and the independently built CLI. Disjoint paths therefore do not prove behavioral independence or make old generated outputs valid for this tree.

## 3. Preserve the original evidence pins

Historical P065 source correction, formatting, positive groups, behavioral controls, and dual-runtime syntax/build-readiness results remain credited only at their recorded inputs. C3's accepted compatibility and merged-tree evidence likewise remains at its recorded C3 source. Neither packet is relabeled as a build, test, runtime, interruption, or performance result on `33dd1bd4`.

The retained old readiness package still has:

- Source commit/tree: `8f67f7e2d8249295e5a84af0bb9b98817a30459c` / `3e30a63f21d2c50389444dff65f2c47d1c3af3c4`.
- ZIP: 402,298 bytes, SHA-256 `56984184ddc5fbf286cec0d07e0a014ff3780b3d4fca36079b474b4efc3e28df`.
- `plan-manifest.json`: SHA-256 `64cff67cd7e51a26e1bd8721b2f9cc7845250865f8136de2764b4b76e3533f3b`.
- `pure-checker.mjs`: SHA-256 `51f0010d2495f414140140d928c9406d58a3504055e4b9c4dfadb605bf193921`.
- Original output inventory hashes: `dist` = `3fa009419899f6435f1cc7835fb2e0e7802577a21cd7e37b1e358abfcc0f5673`; `dist-test` = `8c0951c3aeeda82a1cc8c3d00d752cda8018839c0a738cc3d2409e2ee281f6d4`; `packages/hud-mcp/dist` = `49f24031cda8135c354b0e9418e2fb97e9b7b7cb6fd3e0fd58b31ffc532980a6`.
- Accepted H1 review-overlay manifest: SHA-256 `1d4d7c8cf1b3186d7105de7f896f010b228a792b08eaf402aac4340056c137ac`.

I rechecked all 32 original checksum entries and all 15 H1 checksum entries, plus the ZIP and manifest identities; they match. This is artifact-custody verification, not reexecution or a reopening of H1's source review.

Do not edit these seals, reset their baselines, transplant old generated graphs into the new checkout, or replace their source pin. The old C command remains an identifier of an old, separately governed admission; it is not this candidate's command. H1's manifest remains a non-executable overlay, not a runnable plan-manifest hash. Its accepted missing-signal correction should be preserved in any later diagnostic successor, with explicit provenance and differences.

There is still no demonstrated C-stage execution in the supplied record. An unchanged pure checker may retain its extraction/source acceptance; it does not acquire a run result by composition. No new syntax run is needed merely to re-prove the unchanged driver/holder bytes, but the existing invocations must stay labeled historical and the runtime pins must remain explicit.

## 4. Exact next source-only dispatch

**Task: Prepare P065 C3 validation.** Use the existing P065 implementation worker, with a new artifact directory and no repository/source mutation. This preparation is the next useful bounded path under the existing queue workflow; it is not permission to execute any proposed command.

Prepare one reviewable proposal for the frozen commit/tree above. It must provide:

1. **Input and output custody.** The complete 1,425-leaf input inventory, commit/tree/parent pins, exact dependency/tool/runtime identities and the isolated prospective checkout/output locations. Use new evidence identities. The proposed three generated roots must start absent and acquire baselines only from this candidate's actual later builds. Existing installed dependencies may be consumed only under independently verified provenance and the new admission. No install is released here.
2. **Minimal fresh-build plan.** Propose `npm run build`, `npm run build:test`, and `npm run build:hud-mcp`, each with the brief's 180-second workload bound and separately recorded lifecycle/closeout/outer bounds. Preserve the accepted bounded supervision/custody approach and show every successor launcher/manifest delta. Node 24 should be the first separately admitted build stage; later commands and Node 22 require their own dispatch and current prerequisites. Name both exact supported runtimes for the eventual two-runtime validation. Do not invent a new full-suite-by-runtime matrix or repeat old syntax checks simply because the commit changed.
3. **Combined-tree verification inventory.** Map the existing P065 focused semantic/audit/local-gate/compiled-CLI and shared-writer obligations, C3 interaction points, and README command set to proposed exact commands and evidence locations. Preserve failure and not-run states. Determine the actual dependency path before proposing an aggregate that can reach a denied operation. This is planning, not permission for an aggregate, probe, or code fix.
4. **Readiness successor design.** Preserve the accepted pure-checker extraction and original driver/holder bytes. Carry forward H1's exact fail-closed diagnostic behavior. Show only necessary source/output/path/manifest adaptations to the new candidate and retain their full maps/diffs. A proposal may refer to future build baselines, but must not claim that unknown output hashes already exist or seal a runnable runtime plan against invented baselines. Complete and review a runnable successor only after the corresponding fresh outputs exist and their custody is established.
5. **Admission and stop inventory.** For each prospective step, state the target executor, permitted operation, required evidence, bounds, raw output/exit receipts, ownership/cleanup proof, and stop condition. Keep download/materialization access and execution/lifecycle prerequisites separate. Do not perform either while preparing the proposal.

Stop at the new source-only proposal and return it for a narrow review. Keep `dots/p065-c3-prep` at `33dd1bd4`, both original branches/worktrees and old readiness artifacts unchanged. Do not hand-edit production, tests, configs, dependencies, contracts, benchmark or holder; do not regenerate the old package in place. Any later necessary production correction requires its own bounded finding/disposition, not an inferred license from this plan.

Dispatcher-owned additive archival may record this ruling and proposal under the already released handoff area, without amending historical artifacts or advancing the frozen candidate. Publication must use the project's applicable existing authority, not a transport workaround for a denied executable-artifact transfer.

## 5. Validation sequence after separate admission

The following is the required path, not a workload release:

1. Resolve the exact execution prerequisites and review the new source/build proposal. The recorded blocked Library download must not be rerouted or retried merely because the source composition is accepted. Require materially new relevant authorization/effective-policy evidence for the exact failed operation before reconsidering it. Do not use a different transport/executor as an evasion. C3 owner-run results do not admit either held executor. Preserve the B20 `/proc/5200/environ` denial independently; no process role or safe retry is established here.
2. Assign a named quiet window and run only the separately admitted exact-source build/verification stage. Record source/runtime/tool identities, before/after inventories, raw output, exit/outer status and owned-resource closure. On drift, denial, unexpected descendants, timeout, failure or uncertain closeout, stop dependent work and retain the attempt. Do not reset output baselines or rerun until favorable.
3. Finalize and review the new readiness seals against those actual outputs. Then admit C, R, I0, I1 and I2 separately, retaining their distinct claims. C supplies the ten pure-checker outcomes; R supplies actual runtime/holder/traffic evidence; I0 and I1 supply their different pending/issued interruption shapes; I2 supplies actual controlled signal evidence. H1 source acceptance is not I2 execution. Node 22 remains separately admitted after the preceding reviewed results. Reduced readiness calls are always incomplete and nonqualifying.
4. Preserve instrumentation-overhead disclosure and then separately decide on full qualification. Keep the default 126-cell driver, 50 warmups and at least 1,000 measured calls per required cell, complete H/R populations and outcomes, three isolated series on each supported Node family, real production clocks/SQLite and all original limits. Retain every failed/partial/uncompleted attempt. Operational numerical qualification, forced-control semantic completion, inclusive all-samples numerical status, and population completeness remain distinct. An expected fault-control success does not turn its overrun into a successful latency sample.
5. Complete the existing P065 and README gate, preserving named-flake handling: one isolated rerun of an applicable named flake with both results retained. Do not convert an environmental or semantic failure, unrun stage, or operational over-budget sample into a pass. README commands remain build/build:test/build:hud-mcp, `npm test`, core, visual, hud-mcp, format, fixtures and diff checks, with P065's additional checks/timeouts and any not-reached chained stage recorded. This ruling imposes no new full-suite runtime matrix.
6. Obtain fresh whole-package Oracle acceptance. Only then consider normal `--no-ff` integration and actual merged-tree checks under the repository rule. The final integration target must be reidentified at that time; a future different merged tree is not covered merely by this candidate's acceptance or checks.

Real-Claude same-call timing, real harness/capability cells, formal WSL/B14 and other local-only work retain their existing scope. No synthetic or cloud result upgrades them. The startup registry process-I/O issue and unrelated package conditions remain separate.

## 6. Findings and retained queue disposition

**Composition findings requiring a fix: none.** The complete declared composition and its source-owner evidence are correct. No new P0–P3 composition defect was found.

Outstanding validation is not misclassified as an implementation defect or another fix round. No build, test, runtime readiness, full performance qualification or merged-tree result exists for this exact combination in the submitted preparation.

NEXT remains frozen. P065 must obtain whole-package acceptance and normal integration before NEXT consumes the audit repair; no cherry-pick, clock extraction or combined NEXT/P065 shortcut is admitted. NEXT R2 remains a separate performance-acceptance question. The six favorable owner series are not grounds for another favorable-series search. NEXT-E2 remains a distinct custody gap for archive SHA-256 `941c11f5d11a76c4c01f2c2c1e2b6500aab67b29294f287751a8cd4783379cd4`; the C3 exception for four named archives does not cover it. Do not resume the abandoned/uncertain multipart transport.

DOC2/TPD1, Inspector/data and B10D/LEG1/RCP1 retain their ordered prerequisites and existing conditional briefs. This composition creates no later-wave implementation release, source-remediation-counter reset, capability promotion, gate change or supported-profile change.

## 7. Sources and method

- [Exact candidate](https://github.com/CartmanFatass/codex-hud/commit/33dd1bd4ce82c39aa2dceea2d5ce686c02e0faf5).
- [Candidate README check set](https://github.com/CartmanFatass/codex-hud/blob/33dd1bd4ce82c39aa2dceea2d5ce686c02e0faf5/docs/cloud/README.md).
- [P065 brief, sections 9–12](https://github.com/CartmanFatass/codex-hud/blob/33dd1bd4ce82c39aa2dceea2d5ce686c02e0faf5/docs/cloud/P065-BUDGET.md).
- [Retained dual-runtime readiness review](https://github.com/CartmanFatass/codex-hud/blob/585d14217b1d99192a5dd87b6efcc0f4c36c9323/docs/cloud/handoff/p065-driver-dual-runtime-readiness-oracle-review-20261104.md).
- [Retained readiness harness ruling](https://github.com/CartmanFatass/codex-hud/blob/585d14217b1d99192a5dd87b6efcc0f4c36c9323/docs/cloud/handoff/p065-driver-readiness-harness-oracle-ruling-20261104.md).
- [Retained H1 source acceptance](https://github.com/CartmanFatass/codex-hud/blob/585d14217b1d99192a5dd87b6efcc0f4c36c9323/docs/cloud/handoff/p065-readiness-h1-oracle-review-20261104.md).
- Supplied source-only disposition, preparation REPORT, complete tree/source-owner inventories and SHA256SUMS; independent evidence companion `p065-c3-composition-oracle-evidence-20261104.json`.

Method: read-only GitHub connector retrieval; complete local/remote JSON inventory comparison; independent data-only canonical Git tree, blob and SHA-256 hashing; checksum inspection; and narrow import/source/document inspection. No supplied program was evaluated or imported. No repository checkout/merge/mutation, source edit, install, generator, formatter, compiler, syntax check, project test, checker bank, driver, holder, signal exercise, process/capability probe, download retry or external publication was performed. Only the requested standalone ruling and independent evidence companion were written. A mistaken root-level `dots.md` lookup returned 404; the correct `docs/cloud/dots.md` was then read. No access denial was retried.
