# Wave 1 compatibility composite: V0 composition review and qualification assignment

Date: 2026-11-04 UTC. Fresh Oracle, qualification-only source/history review.

## Decision

**V0 PASS: the exact frozen source candidate is a conforming composition of the three authorized lineages. Proceed only with the already prescribed qualification, on an admissible executor or through the owner's existing bounded workflow. No source repair is called for by this review.**

**This is not final acceptance. HYG2/NODE22-PROXY, MCP-ANCESTOR, and RUNZ1/RUNZ1-KILL remain a single WIP dependent set: NOT ACCEPTED and NOT MERGEABLE. Builds, tests and benchmarks were NOT RUN by this Oracle.** The report's check inventory is a future assignment, not evidence of a green command.

The governing [integration ruling](https://github.com/CartmanFatass/codex-hud/blob/87ef8d1f59177badeebf8c863a5ad29abdc20ba1/docs/cloud/rulings/wave1-compat-integration-20261103.md) and [connector addendum](https://github.com/CartmanFatass/codex-hud/blob/87ef8d1f59177badeebf8c863a5ad29abdc20ba1/docs/cloud/rulings/wave1-compat-integration-connector-addendum-20261104.md) remain unchanged. This review supplies no execution lease, new repair round, gate waiver, supported profile, source amendment, archive-upload resumption or universal-hud ref move.

## 1. Frozen identities and independently verified graph

Repository: CartmanFatass/codex-hud. Qualification branch: dots/wave1-compat-integration.

- Original documentary integration snapshot: 88633ef53490f213b6ec987fdafec4f3fd1aa0a5; tree b4f5c3a80c9b16f734234d24e90c622bbb9346fa.
- Selected integration base U: **f248f320d42528fd1eb97db9f1cd2ba97e6d3c86**; tree **2a6491f7c0ca5262587d4ab15a8ae53cbf6901ce**.
- P, HYG2 + NODE22-PROXY: b4047320262f72f401a513db07236ff1473db933; tree d9be29f28da496a880802c267a08e8bb4fcbee74.
- M, MCP-ANCESTOR R1: b2897a4f9769bca6305ff0e3ae3dc694a9320ffe; tree 0d195bd47ff2b29581e1c394c2973d9479f8d928.
- R, RUNZ1 + RUNZ1-KILL fix-1: 7ba567ee0c3cd12933d79a5029162d32770ee245; tree ad4c596860b264d76d4060be90d70337046b92c5.
- Frozen source candidate C3: **36d3fd584bd403ed7ada95d1d863a8f63e96588b**; tree **0c8c67ede1f13122987802d9a0346cd6e6ecf73b**.
- Documentary report head H: **87ef8d1f59177badeebf8c863a5ad29abdc20ba1**; tree **9aa8ee3afa2476f3588670f74c08814db737db15**; its sole parent is C3.

The returned Git commit objects, rather than submitted API parameters, establish these exact ordered parents:

| Commit | Tree | Ordered parents | Unique merge base | First-parent changed paths |
| --- | --- | --- | --- | ---: |
| C1 fd06676862b600518e399b2385b63f79685e6701 | 8b557e9a6d19347f3568908260c66bbd49362760 | [U, P] | f1e2a8408fbc6ddef181978e8a2d9fd5831242e9 | 30 |
| C2 80a4de01992379c1ae4bf019cf96ec2dc4180cd0 | 2f79b4407cd4677e800b933046a89fb00b8cf6e4 | [C1, M] | 26f6fba36948e6c96e2e109cb374c0d4dbb9ab22 | 7 |
| C3 36d3fd584bd403ed7ada95d1d863a8f63e96588b | 0c8c67ede1f13122987802d9a0346cd6e6ecf73b | [C2, R] | f1e2a8408fbc6ddef181978e8a2d9fd5831242e9 | 21 |

Each composition commit has exactly two parents. The sources are genuine ancestors, and the integration history is the first-parent chain U → C1 → C2 → C3. There is no octopus, squash, cherry-pick replacement or source-history rewrite in this composition.

Independent ancestry checks used the connector's merge-base metadata plus complete immutable commit lists from foundation f1e2a840 to U/P/M/R: respectively 83/20/51/16 commits, with every reported commit returned and every parent chain closed at that foundation. The graph yields exactly the three unique best common ancestors above. No source was already contained in its preceding accumulator, and no unexplained merge-base ambiguity exists.

## 2. Complete tree and scope audit

I retrieved complete recursive trees, all explicitly non-truncated, for the original integration snapshot, U, P/M/R, both applicable merge bases and C1/C2/C3. I independently applied the addendum's closed three-way entry rule to every leaf, comparing mode, object type and object SHA, with absence explicit. I separately checked leaf/path-prefix collisions.

Results:

- C1: 1,348 leaves; complete predicted inventory equals returned tree; 30-path delta equals manifest.
- C2: 1,352 leaves; complete predicted inventory equals returned tree; 7-path delta equals manifest.
- C3: 1,370 leaves; complete predicted inventory equals returned tree; 21-path delta equals manifest.
- All stages: zero divergent double-changes, prefix collisions, deletions, or mode/type changes.
- U differs from the original integration snapshot only by the two named integration ruling/addendum documents. No implementation, dependency or configuration drift is hidden in U.
- U → C3 is exactly **58 leaf changes: 26 authorized implementation/test/source-document entries plus 32 inherited documents**. The 26-path list was separately extracted from the governing ruling and equals the implementation manifest, rather than trusting the manifest as the whitelist.
- All 26 entries exactly match their named pinned source objects, modes and types. All 32 inherited documents are existing source objects and additions relative to U: 31 handoff records plus the expressly permitted docs/cloud/rulings/hyg2.md. No existing U document is overwritten.
- Every other U leaf is retained unchanged, including contracts, capability/build configuration, dependency and shared-helper paths.
- The published candidate-tree.tsv contains 1,370 distinct entries and matches the complete C3 leaf inventory exactly.
- C3 → H adds exactly candidate-tree.tsv, check-inventory.json, composition-manifest.json and implementation.md under docs/cloud/handoff/wave1-compat-integration/. H has no source/configuration/dependency change. H is a documentary successor, not a replacement source identity.

Dependency provenance also matches U: the node_modules tree is 77829c47b2f75720a918a0dfef03e8671222cde9 and its tracked .package-lock.json is 8c35e164d1c5752a7756ca390d91081afb494413. Root/package lockfiles, package manifests and compiler configuration are unchanged. C3 contains no generated dist, dist-test or packages/hud-mcp/dist output. Fresh build-output manifests are correctly pending; source-tree equality is not a build result.

Readback during this review found dots/wave1-compat-integration at H and universal-hud at U. Source branch documentary heads were dots/node22-proxy@394f5085933fab1d2a57d0c4012cf19efbc723b1, dots/mcp-ancestor@99a6761cfd79dc047a048dfffdc24018e9780a29, and dots/runz1-kill@00d3317303d40a357bf7b3219911e40372631c6d. None replaces P/M/R.

The report's historical branch-absence check, expected-SHA update and pre-restriction empty-repository fetch are attributed to its retained manifest/report; a present-day ref read cannot recreate that history. The actual final graph, inventories, immutable identities and current refs are independently confirmed. This V0 makes no claim to have re-audited historical executor activity or original evidence custody.

### Exact source-object audit

Every entry below is mode 100644, type blob, and identical in C3 and its named owner source.

| Owner | Path | Git blob |
| --- | --- | --- |
| P | src/cli/link-export.ts | c7a05e752c166a29564db41385cf022365d83f0b |
| P | src/ledger/runtime.ts | 3f61a6f4ebfc8607e59dbe464d93d63d8f211662 |
| P | tests/int/node-startup-diagnostics.ts | e1feac9598d0c3e3abfd19084b9274920a008699 |
| P | tests/int/process-client.ts | c161c158f85db34188e754ed06adcb842d93ae4a |
| P | tests/unit/b12d-wal.test.ts | 46bc5da8b45d2d8e2f73fe5e6f4229e5e0d1bcd1 |
| P | tests/unit/b12r-store.test.ts | 9e281e7883765d49d06c2beb3332b89e8e8bb093 |
| P | tests/unit/b16-writer.test.ts | 2017e31951a2b061585824fca9d7bd4d0d5ada86 |
| P | tests/unit/b45-launch.test.ts | 21bfa19b76a5eec48c58a4adf76f077193bf61e9 |
| P | tests/unit/hud-link-export.test.ts | 5c2d0b2f0e698791ebc249fdca6af2774aeec317 |
| P | tests/unit/node-proxy-profile.test.ts | 134a43985ab7fdbda12a6239517f9c7d3203de01 |
| P | tests/unit/process-client.test.ts | 3ab24c1d2ed1433ae25d5ca674a1d05bcceac6e3 |
| P | tests/unit/run-light-leader.test.ts | dcff130926e1e88ada11b7a73d5de5869345cea4 |
| P | tests/unit/run-process.test.ts | e95e606c912919f7770e053670ef5600147024f6 |
| M | packages/hud-mcp/src/process.ts | 72954abd0b5a483ff1bab1aaaeab59add4ffab5b |
| M | tests/hud-mcp/ancestor-discovery.test.ts | dae455671c9e7dc0b46f25516c2fc6d7b9c92649 |
| M | tests/hud-mcp/int-ledger-registry.test.ts | 234a3f2253f4bcf61f039732ae99c9c878853a1d |
| M | tests/hud-mcp/skeleton.test.ts | 025227b75736a43fb3fde6ec8ef8cdae25b98181 |
| R | src/core/run/README.md | 6b2c137b57ec3b45b44fd189e02a4481377859b7 |
| R | src/core/run/process-census.ts | 1243fef52711803e54fcafc4127316c8ae701ece |
| R | src/core/run/process.ts | f43cfe0bb18e1af5b940c42b8d5ee6d0e4d7eb3f |
| R | tests/int/runz1-perf.mjs | fbd6c34c6de54a9b11ec155a5a01f18c83d77969 |
| R | tests/unit/run-control-kill-evidence.test.ts | bd4d5ad7012a896443eaa09df9da0f066079a9f4 |
| R | tests/unit/run-control-kill-fixture.ts | 8d0c86138e888cefebd13b787e0c164053b2fa4b |
| R | tests/unit/run-control.test.ts | f12d545a26724d1239f2ce91140e1eb9e98dec82 |
| R | tests/unit/runz1-fixture.py | 4d0abb3c124a32704be9801ba9e8899cdb559ed9 |
| R | tests/unit/runz1-process.test.ts | f57755deeaeefb70ee9ed7c469fe6a4b39be4955 |

No composition defect requiring an implementation fix was found. This is deliberately not a second wholesale review of previously reviewed untouched implementations.

## 3. Concrete minimum qualification assignment

### 3.1 Admission and exact profiles

Assign **one shared composite qualification**, not one matrix per package. Its source is C3/tree 0c8c67ede1f13122987802d9a0346cd6e6ecf73b. Verify immutable checkout/source inventory before running; do not test a moving branch or import further WIP. Keep reports and evidence separate from source commits.

The three profiles are:

1. **node22-envproxy:** Node 22.23.4, NODE_USE_ENV_PROXY=1 before launch, the required declared HTTP(S)_PROXY/NO_PROXY policy.
2. **node22-noenvproxy-control:** the identical Node 22 binary and proxy settings, with only NODE_USE_ENV_PROXY activation omitted and no alternate enabling flag.
3. **node24-envproxy:** Node 24.22.1 with explicit NODE_USE_ENV_PROXY=1 and the corresponding required proxy policy.

Record the profile plan and expanded isolation wrapper before execution. Choose absolute Node/npm paths before replacing HOME; put that Node directory first on PATH. Use fresh synthetic HOME/HUD_HOME/TMPDIR per command. Retain declared proxy policy without exposing credentials. Remove real harness/session/HERDR selectors and color overrides under the existing isolation procedure. The binding diagnostic profiles require NODE_OPTIONS, NODE_NO_WARNINGS and NODE_REDIRECT_WARNINGS absent; an unexpected inherited setting is a profile discrepancy to report, not an excuse to hide it. Do not suppress startup diagnostics, normalize output, rewrite activation or change test deadlines.

Use fresh per-command NODE_PROXY_EVIDENCE_DIR and pre-created RUNZ1_KILL_EVIDENCE_DIR so the existing byte captures and KILL records survive. Capture outer command stdout and stderr separately, plus UTC start/end, exact command, exit/signal/timeout, source/runtime/dependency identities and generated-output manifests. Record failed and never-reached stages honestly.

This report **does not admit work on either held executor**. The original shared-executor lifecycle/cleanup hold and the separately held independent compiler executor remain in force. A new directory, shell, branch or tool is not an independent executor. A capable, genuinely independent, already authorized cloud route needs its own recorded bounded dispatcher assignment. Otherwise send the owner the exact C3 procedure through the existing owner-run workflow. No unauthorized Codex delegation or assistant-run owner-computer testing is introduced.

### 3.2 One shared full matrix, once per profile

Execute these commands separately under each of the three profiles:

| Command | Outer limit |
| --- | ---: |
| npm run build | 600 s |
| npm run build:test | 600 s |
| npm run build:hud-mcp | 600 s |
| npm test | 1,800 s |
| npm run test:core | 900 s |
| npm run test:visual | 600 s |
| npm run test:hud-mcp | 900 s |
| npm run format:check | 300 s |
| npm run check:fixtures | 300 s |
| git diff --check | 60 s |

If npm test's unit stage prevents its mjs stage, additionally run npm run test:mjs with 600 s and retain the failed aggregate; the supplement does not turn it green. Preserve the prescribed npm scripts even though some internally rebuild. The shared composite limits above are already set by the integration ruling; they do not retrospectively extend any older timed-out command or test's internal timeout.

Exact-tree format/fixture/whitespace results, including the explicit MCP format command below, may be reused between profiles only as allowed for unchanged source. Runtime execution may not be reused across profiles. The manifest's tracked dependency tree is not permission to stage dependency state. Only if dependencies are missing on an admitted executor, use the binding npm ci --ignore-scripts with unchanged lockfile and permitted network/proxy policy, bounded to 900 s; record it separately and never stage node_modules changes.

One complete result per profile serves every included package. Do not repeat the completed historical NODE22-PROXY matrix, run three package-labeled copies of this matrix, or treat an old isolated-tree pass as a C3 result.

### 3.3 Retain the required focused invocations

These are existing scheduled/topology/route checks in addition to the shared full matrix, not new test campaigns.

**All three profiles:**

- 300 s: node --test --test-concurrency=1 dist-test/tests/unit/node-proxy-profile.test.js
- 600 s: node --test --test-concurrency=1 dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/run-process.test.js dist-test/tests/unit/run-light-leader.test.js
- 600 s: node --test dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/run-process.test.js dist-test/tests/unit/run-light-leader.test.js
- 900 s: node --test dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/b45-launch.test.js dist-test/tests/unit/b12r-store.test.js dist-test/tests/unit/b12d-wal.test.js dist-test/tests/unit/b16-writer.test.js dist-test/tests/unit/process-client.test.js

**The two enabled profiles only:**

- 600 s: node --test --test-concurrency=1 dist-test/tests/unit/run-control-kill-evidence.test.js dist-test/tests/unit/run-control.test.js
- 600 s: node --test dist-test/tests/unit/runz1-process.test.js dist-test/tests/unit/run-control.test.js dist-test/tests/unit/run-process.test.js
- 300 s: node --test packages/hud-mcp/dist/tests/hud-mcp/ancestor-discovery.test.js packages/hud-mcp/dist/tests/hud-mcp/skeleton.test.js packages/hud-mcp/dist/tests/hud-mcp/int-ledger-registry.test.js
- 300 s, source-shareable: node node_modules/prettier/bin/prettier.cjs --check packages/hud-mcp/src/process.ts tests/hud-mcp/ancestor-discovery.test.ts tests/hud-mcp/skeleton.test.ts tests/hud-mcp/int-ledger-registry.test.ts

Do not add name filters, skips or relaxed expectations. Normal-concurrency commands remain required after serialized focused runs. Preserve route/NO_PROXY/precedence observations, strict stdout/stderr bytes, deterministic separation sentinels, complete run-control evidence/proof assertions and MCP security coverage already present in these unchanged tests.

Do not repeat the closed KILL diagnostic burst or the complete historical mutation archive. Existing failing-before/source-mutation evidence remains reusable for identical implementations/assertions once its required custody is resolved. A newly discovered failure or changed dependency needs a specific fresh disposition, not automatic code repair, retry-until-green or a reset of old fix/rerun counters. Only a genuinely listed README known flake receives the existing once-alone rerun, with both outcomes retained. EACCES/EPERM registration, envproxy, routing and output-separation failures are not newly declared flakes.

### 3.4 One real optional-ancestor exercise

Obtain **one** C3 real-host demonstration for the shared ancestor requirement, through the existing owner-run bounded workflow. Run the unchanged physical-registration integration with its normal ancestry, alongside the already required focused/security checks under both enabled runtimes. The single qualifying natural-topology observation need not be duplicated per package or per profile.

The evidence must show an optional ancestor actually traversed at **PID > 1** with an observed EACCES/EPERM read, followed by successful mandatory physical registration and no logical authority. Record source/tree, runtime, UID/eUID, bounded readable PID/PPID/start/UID ancestry facts, the denial, unchanged command, raw streams and exit. Mere root ownership, a denied PID 1, an entirely readable ancestry, or injected fault tests do not satisfy this gate.

If that topology is absent, record PENDING and continue independent work. Do not force reparenting, change proc/security/permissions, invoke a privileged helper, bypass denied reads or select another parent to conceal the condition. No assistant-run local test is authorized. The full focused command may provide the functional registration result when accompanied by the required natural-denial evidence; this is not a reason to invent a modified probe or another broad matrix.

### 3.5 Exactly twelve unchanged MCP benchmark processes

The benchmark baseline is U/f248f320d42528fd1eb97db9f1cd2ba97e6d3c86, source-equivalent to accepted integration source 26f6fba36948e6c96e2e109cb374c0d4dbb9ab22. I independently compared those complete inventories: their 30 differing leaves are all docs paths. The candidate arm is C3. The shared driver is tests/hud-mcp/benchmark.mjs, blob c36817dee4cf70c27a39a86b3965f4eb6701ceb0, unchanged across baseline/candidate.

For each enabled runtime, declare three matched baseline/candidate pairs in an alternating order before execution, with exact source/build/runtime/dependency identities. Run node tests/hud-mcp/benchmark.mjs, 600 s per process: **six processes per enabled runtime, twelve total**. The Node 22 no-opt-in control gets no extra benchmark series. Do not also rerun a twelve-process series on the superseded isolated MCP source.

Keep the unchanged 30 cold samples, 200 calls per method, reported cold p95/max and method p95, gates and exits. This measures the whole dependent tree, not MCP-only causal effect or formal WSL qualification. No new percentile, driver, threshold or RUNZ1 n=1,000 scan-cost campaign is added.

Establish the existing no-competing-workload condition for the entire declared measurement window without touching unrelated processes. A quiet snapshot, lifetime-average CPU percentage or command serialization alone is not isolation proof. If no admissible isolated window exists, keep the series pending. Do not run repeated windows until a favorable set appears.

## 4. Cloud versus owner-local boundary and lease return

- **Permitted now without compute admission:** read-only connector analysis, preparing the exact assignment, source/manifest comparison, lightweight serialized records, and already authorized custody work not covered by a stop.
- **Potentially cloud-runnable after distinct admission:** builds and the non-local shared/focused checks, but only with the exact binary/profile and required facilities. Respect known denied sockets/ptrace and missing kernel capabilities. Do not re-probe or replay known blocked commands unchanged merely because C3 exists. A differently patched binary is not exact-profile evidence and the closed diagnostic model must not be changed to credit it.
- **Owner-run/capable-host assignment:** exact-profile or process/loopback evidence unavailable on cloud; the naturally unreadable optional-ancestor case; and the benchmark window if cloud cannot genuinely satisfy isolation. Assistant-run owner-local testing remains withdrawn. Capability/owner evidence may fill its precise missing rows, without repeating already valid C3 rows.
- **Always excluded from assistant cloud testing:** real Herdr/tmux/logged-in Codex/Claude/pi, Jev/shared-browser workflows, real home stores, install/uninstall, real-tmux/probe scripts, B13_REAL and simulated claims of formal WSL qualification.

An execution lease must name the exact candidate/tree, executor, owner, runtime/profile, bounded command group, timeouts and return point. Return after the group's final process and verified owned-child/resource cleanup, including failure or an unavailable prerequisite; do not hold compute while waiting for the owner, archives or review. One controlled workload at a time on an admitted executor. Respect all existing lifecycle/cleanup holds.

## 5. Open requirements and final gate

1. The C3 shared three-profile matrix and prescribed focused checks are NOT RUN in this review.
2. The actual naturally unreadable optional PID > 1 ancestor demonstration remains pending.
3. The existing twelve-process matched benchmark series still needs an established isolation window.
4. Historical proxy mutation/MCP original-and-R1/RUNZ1 archive custody/readback remains pending as previously recorded. Composition's inherited documents do not deliver missing raw archives. Do not resume stopped 13-part/44-part uploads or switch transports/destinations to evade the stop. Preserve protected RUNZ1 originals under the existing conditional private-custody disposition; this review authorizes neither public disclosure nor a new recipient.
5. A **fresh final integration Oracle**, after complete evidence, must explicitly accept the complete dependent set and state each package's disposition. Existing R1/K1/K2 findings are not reopened or automatically closed by this V0. The historical missing 15:57 snapshot remains honestly unexplained and does not authorize another KILL burst.

Only that final accept verdict permits the sole merger to perform one history-preserving --no-ff integration into then-current universal-hud, after drift checks. The complete required three-profile README checks must then be green on the **actual merged tree** before push/status promotion. That merged-tree gate is distinct and mandatory, not three redundant per-package matrices. A failure returns to a fresh Oracle; no partial package push, main change, forced update, history rewrite, dependency-state staging, deployment or later-wave release is authorized.

## Sources and method

Primary records read at immutable H:

- [Implementation report](https://github.com/CartmanFatass/codex-hud/blob/87ef8d1f59177badeebf8c863a5ad29abdc20ba1/docs/cloud/handoff/wave1-compat-integration/implementation.md)
- [Composition manifest](https://github.com/CartmanFatass/codex-hud/blob/87ef8d1f59177badeebf8c863a5ad29abdc20ba1/docs/cloud/handoff/wave1-compat-integration/composition-manifest.json)
- [Complete candidate inventory](https://github.com/CartmanFatass/codex-hud/blob/87ef8d1f59177badeebf8c863a5ad29abdc20ba1/docs/cloud/handoff/wave1-compat-integration/candidate-tree.tsv)
- [Pending check inventory](https://github.com/CartmanFatass/codex-hud/blob/87ef8d1f59177badeebf8c863a5ad29abdc20ba1/docs/cloud/handoff/wave1-compat-integration/check-inventory.json)
- AGENTS.md, docs/cloud/dots.md, docs/cloud/README.md, current STATE, NODE22-PROXY/MCP-ANCESTOR/RUNZ1-KILL briefs and the wave1 resource-window ruling.
- Immutable Git commit objects, complete recursive trees and ancestry comparisons at the identities above; relevant unchanged capture/registration source and the benchmark driver.

Method: connected read-only GitHub retrieval and in-memory inventory/graph comparisons, plus lightweight local file discovery and this requested decision file. No source edits, checkout/materialization, local merge, dependency operation, build, test, benchmark, process/topology probe, permission change, owner-computer action, remote write or subagent was performed.

**Final disposition: V0 composition verified; no source repair required by V0; qualify C3 once under the bounded assignment above; execution admission and all actual evidence/acceptance/merged-tree requirements remain; the dependent set is NOT ACCEPTED and NOT MERGEABLE.**

