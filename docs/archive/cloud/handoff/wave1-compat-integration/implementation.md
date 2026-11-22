# Wave 1 compatibility integration: implementer composition report

Date: 2026-11-04.

**WIP / NOT ACCEPTED / NOT MERGEABLE. Builds, tests and benchmarks NOT RUN.**

## Frozen source candidate

- Repository: CartmanFatass/codex-hud.
- Destination: dots/wave1-compat-integration, initially absent.
- Integration base U: f248f320d42528fd1eb97db9f1cd2ba97e6d3c86; tree 2a6491f7c0ca5262587d4ab15a8ae53cbf6901ce.
- Frozen source candidate C3: **36d3fd584bd403ed7ada95d1d863a8f63e96588b**; tree **0c8c67ede1f13122987802d9a0346cd6e6ecf73b**.
- Candidate: https://github.com/CartmanFatass/codex-hud/commit/36d3fd584bd403ed7ada95d1d863a8f63e96588b
- This report and its manifests are a separate documentation-only successor. C3 remains the immutable source qualification identity. The successor must be identified separately and shown source-equivalent; it does not supersede C3's identity or claim execution.

The pinned original integration base was 88633ef53490f213b6ec987fdafec4f3fd1aa0a5. Complete tree comparison to U found exactly two added ruling documents: wave1-compat-integration-20261103.md and wave1-compat-integration-connector-addendum-20261104.md. No implementation/configuration/dependency drift occurred. Current integration documents and contracts are preserved byte-for-byte.

## Binding dispositions and method

- [Integration ruling](../../rulings/wave1-compat-integration-20261103.md), source SHA-256 6b25da00c8f8c0236e5382d94158b40f6a5b173bdd627e35defe89772df73774.
- [Connector addendum](../../rulings/wave1-compat-integration-connector-addendum-20261104.md), source SHA-256 fcaaceb768f6f55bacfd01c547152d64301575732420dd1c85123286fa66d86e.

Construction used the connected GitHub tree, commit and ref APIs. Each complete non-truncated ancestor, accumulator and source tree was reduced to leaf entries (mode, type, object SHA, with absence explicit). For every path: equal sides were retained; otherwise the unchanged side relative to the common base selected the other side; any differing double-change would have stopped construction. There were zero conflicts, prefix collisions, unexpected deletions or mode/type changes. No text merge, rename heuristic, preferred-side repair, source reconstruction or new source blob was used.

Each sparse tree delta referenced existing source objects over the full accumulator tree. The entire returned tree was fetched and matched to the predicted leaf inventory before its two-parent commit was created. Every commit was then read back to verify the tree and ordered parents; both parents were proven ancestors and the complete first-parent delta matched its plan. All complete-tree responses were non-truncated. Source histories are preserved without squash, cherry-pick, rebase, octopus shortcut or rewrite.

Before the connector-only restriction arrived, one separate empty local repository was initialized and four refs fetched. No checkout, local merge, source edit, install, build, test, probe or publication occurred. Local preparation stopped on instruction. All actual composition and publication thereafter used the connector. This does not claim a new execution lease or removal of either held-executor restriction.

## Exact merge graph

- C1: fd06676862b600518e399b2385b63f79685e6701; tree 8b557e9a6d19347f3568908260c66bbd49362760; ordered parents [f248f320d42528fd1eb97db9f1cd2ba97e6d3c86, b4047320262f72f401a513db07236ff1473db933]; merge base f1e2a8408fbc6ddef181978e8a2d9fd5831242e9; first-parent delta 30 paths.
- C2: 80a4de01992379c1ae4bf019cf96ec2dc4180cd0; tree 2f79b4407cd4677e800b933046a89fb00b8cf6e4; ordered parents [fd06676862b600518e399b2385b63f79685e6701, b2897a4f9769bca6305ff0e3ae3dc694a9320ffe]; merge base 26f6fba36948e6c96e2e109cb374c0d4dbb9ab22; first-parent delta 7 paths.
- C3: 36d3fd584bd403ed7ada95d1d863a8f63e96588b; tree 0c8c67ede1f13122987802d9a0346cd6e6ecf73b; ordered parents [80a4de01992379c1ae4bf019cf96ec2dc4180cd0, 7ba567ee0c3cd12933d79a5029162d32770ee245]; merge base f1e2a8408fbc6ddef181978e8a2d9fd5831242e9; first-parent delta 21 paths.

Source lineages remain exactly:
- HYG2 + NODE22-PROXY: b4047320262f72f401a513db07236ff1473db933, tree d9be29f28da496a880802c267a08e8bb4fcbee74.
- MCP-ANCESTOR R1: b2897a4f9769bca6305ff0e3ae3dc694a9320ffe, tree 0d195bd47ff2b29581e1c394c2973d9479f8d928.
- RUNZ1 + RUNZ1-KILL fix-1: 7ba567ee0c3cd12933d79a5029162d32770ee245, tree ad4c596860b264d76d4060be90d70337046b92c5.

Later documentary source branch heads were inspected but not substituted for these immutable sources. Their comparisons were documentary-only; source reports and reviews remain at their original identities. No old failure or fix-round counter is reset.

## Complete scope verification

C3 differs from U in exactly **58 paths: the 26 authorized implementation/test/source-document paths and 32 inherited documentary paths**. All 26 entries match their named source commit's blob, mode and type. The documents comprise 31 handoff records plus the unchanged docs/cloud/rulings/hyg2.md expressly allowed by the addendum. No existing U document was overwritten. No other implementation, config, dependency, contract, helper or capability path differs.

See [composition-manifest.json](composition-manifest.json) for every source entry, inherited document, intermediate delta, ancestry result, input identity and publication expectation. [candidate-tree.tsv](candidate-tree.tsv) contains all 1370 C3 leaf entries, including their modes and object types, not only the changed subset.

The repository base already tracks node_modules. Its complete tree remains 77829c47b2f75720a918a0dfef03e8671222cde9; node_modules/.package-lock.json remains 8c35e164d1c5752a7756ca390d91081afb494413. It was not staged, changed or reinstalled. Package/lock/compiler configuration entries are separately inventoried and unchanged. No generated dist/dist-test/MCP dist output is present in the source tree. Fresh generated manifests remain pending the separately admitted build, not fabricated here.

## Publication and readback

The branch was checked absent, created at exact U, then read back. After C3's complete verification, update_ref used expected_sha=U and force=false. The successful update was read back as exact C3 36d3fd584bd403ed7ada95d1d863a8f63e96588b. Source refs, main and universal-hud were not modified by this preparation. A later documentation-only report commit is recorded separately; its full delta and source equivalence are checked before the branch is advanced.

## Checks and outstanding qualification

- Source/history/tree/scope/ref verification: completed as detailed above; this is not runtime verification.
- Builds, format execution, fixture execution, diff command, unit/core/visual/hud-mcp suites, focused commands, benchmarks, process probes and owner-local work: **NOT RUN**.
- The three-profile shared full matrix, prescribed focused scheduling/topology checks, one actual naturally unreadable optional PID > 1 ancestor demonstration, and twelve unchanged MCP matched benchmark processes remain pending their admissible execution windows.
- Required historical archive custody/readback remains open. No stopped upload was resumed; no protected original or new recipient destination was introduced.
- Real ancestor topology, no-competing-workload benchmark condition, historical evidence custody, independent combined-candidate acceptance, and eventual actual merged-tree gates remain unchanged.

No code repair, new acceptance threshold, profile change, acceptance verdict, merge into universal-hud, main change, force push, deployment or later-wave release occurred. Qualification construction is complete; acceptance and integration remain HOLD.
