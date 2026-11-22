# MCP-ANCESTOR final Oracle review, 2026-11-03

**Verdict: fix required. MCP-ANCESTOR is not accepted and must not be merged.**

The production change implements the selected fail-closed boundary correctly on inspection. The meaningful baseline failures and candidate passes are substantiated. One new stdio-regression test needs a bounded capture fix. Independently, required real-topology evidence, complete candidate checks, cold-start performance gates and durable evidence publication remain open. No gate, supported profile or security predicate is waived.

## Scope and exact identity

This was a fresh read-only review of the brief/ruling, repository workflow, identity contract and relevant design, source, tests, owner evidence, HYG2 local review, implementation/publication reports and recorded raw checks. I ran no build, test, benchmark, process-topology probe or owner-local work, made no repository changes and started no subagents. NODE22-PROXY's compute lease was not used.

- Implementation commit: bfe630c981efeb7914dfffb2764c2c715b791a46.
- Implementation tree: 10ce62eb316fb8954a5b667da261d301e2dd69ea.
- Sole parent: 26f6fba36948e6c96e2e109cb374c0d4dbb9ab22; parent tree 03bd36610d46fd220eb9c0e4fbf153a52bc3c3b9.
- GitHub commit metadata and comparison independently confirm those identities and exactly four source/test changes: process.ts, ancestor-discovery.test.ts, int-ledger-registry.test.ts and skeleton.test.ts. No dependency state or other package implementation was imported.
- At read-back, dots/mcp-ancestor was 48b60f705860e9d662872fffa776193a132364c1, tree e2346cc9a72c5aa633c7aeff74be15b34212a09b. Its two commits after the implementation add only mcp-ancestor-implementation.md and mcp-ancestor-publication.md. They do not change tested source.
- The local worktree still has the pinned base HEAD plus the candidate changes. It is not falsely credited as a checkout of the later publication commit: all four working-file SHA-256/Git-blob values match candidate-source.json, and the frozen tree matches the published implementation tree. The unstaged node_modules/.package-lock.json change is excluded.

Sources: [implementation commit](https://github.com/CartmanFatass/codex-hud/commit/bfe630c981efeb7914dfffb2764c2c715b791a46), [exact implementation comparison](https://github.com/CartmanFatass/codex-hud/compare/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22...bfe630c981efeb7914dfffb2764c2c715b791a46), [documentation-only comparison](https://github.com/CartmanFatass/codex-hud/compare/bfe630c981efeb7914dfffb2764c2c715b791a46...48b60f705860e9d662872fffa776193a132364c1).

## Findings and required disposition

### R1. Drain stdio before claiming complete stdout verification

**tests/hud-mcp/int-ledger-registry.test.ts:245–249, 275–291 — stdout assertions run at process exit rather than stream completion — P2 — wait for close/stdio EOF and add a trailing-output negative control.**

The new real-process test resolves done on the child's exit event, then checks the accumulated stdout for exactly three JSON-RPC records. Exit does not guarantee the stdio streams have drained. If extra stdout is emitted after the third response and its last chunk is delivered after exit, these assertions can pass before seeing it. The data handler's malformed-line branch only rejects currently pending requests; after the third response that map is empty, so such a late malformed line need not fail the completed test. An extra valid JSON record can likewise arrive after the length assertion.

This is a test-completeness defect, not evidence that the current production implementation emits invalid stdout. Make completion wait for close or equivalent explicit stdout/stderr completion, retain the exact raw-stream/count/framing assertions, and demonstrate that a deterministic trailing non-JSON/extra-record case fails. Keep the fix and any trusted fixture local to the already owned test file; do not edit the unchanged benchmark or import HYG2 helper changes. Then rerun affected checks on the final tree under a newly assigned resource window.

The event ordering is documented for the exact Node 22.23.4 runtime: [ChildProcess close/exit semantics](https://github.com/nodejs/node/blob/v22.23.4/doc/api/child_process.md#event-close).

### R2. Required real unreadable-ancestor evidence is absent

**docs/cloud/MCP-ANCESTOR.md:79–87, 133; root-ancestor-evidence.md — simulated faults and a passing real reader do not establish the required naturally occurring unreadable topology — P2 acceptance blocker — obtain the bounded owner-run evidence or keep this gate pending.**

The owner archive's raw failure establishes EACCES through readBounded → LinuxProcessReader.get → findHarness → registerCaller. Its root-owned WSL Relay attribution remains the owner's explanation without an independent contemporaneous UID/ancestry snapshot. Neither the old failure nor this cloud candidate's passing real registration supplies the final-candidate evidence required by the brief.

The owner-controlled procedure must record the final tested SHA/tree, runtime, UID/eUID, bounded readable PID/PPID/start/UID ancestry, independently observed denial code, unchanged real integration command, raw output and exit. Root ownership alone is not denial evidence. No privilege changes, forced ancestry, convenient-parent substitution or assistant-run local session are authorized. If the topology no longer exists, report that limitation rather than manufacture it.

### R3. Complete final-candidate checks remain missing or failed

**docs/cloud/handoff/mcp-ancestor-implementation.md:42–43, 89; docs/cloud/MCP-ANCESTOR.md:102, 134 — required aggregate execution is incomplete — P2 acceptance blocker — supply the missing checks on an already permitted capable executor and retain all initial failures.**

Both final-candidate npm test records explicitly say blocked_not_run. Therefore neither runtime has a completed main unit stage or complete npm test result for this tree. The Node 24 supplemental test:mjs actually failed, 32 pass / 15 fail, with synthetic Unix-socket listen EPERM. Node 22 test:mjs was blocked rather than retried. Focused, core, visual and hud-mcp passes do not substitute for these stages.

The prior owner's successful socket/ptrace/process-children executions concerned other pinned package trees on another host. They do not establish that this cloud executor gained those capabilities or that MCP-ANCESTOR's exact candidate passes. Do not retry denied facilities here or weaken/skip their assertions. A full green candidate result and later actual merged-tree result remain required.

### R4. Every existing process benchmark fails its cold-start gate

**tests/hud-mcp/benchmark.mjs:65–101; docs/cloud/handoff/mcp-ancestor-implementation.md:65–90 — all twelve required runs exit 1 because cold p95 is at least 200 ms — P2 acceptance blocker — retain the failures and obtain a separately bounded remedy/disposition, followed by required valid measurements.**

The baseline is red as well as the candidate. That prevents attributing this performance failure to the patch, but does not turn it into a pass or an approved flake. The noisy series does not support an improvement or equivalence claim. No sample trimming, favorable-run selection, new threshold, changed driver, warning suppression or unaccepted-branch combination is authorized by this review.

### R5. Full evidence is verified locally, not confirmed durably archived

**docs/cloud/MCP-ANCESTOR.md:53–56, 115; docs/cloud/handoff/mcp-ancestor-implementation.md:94–96 — only narrative handoffs are present in the inspected candidate branch; the full checked bundle is still executor-local — P2 evidence-delivery blocker — publish the sanitized lossless bundle to a verified authorized durable destination and read it back.**

A local archive and its hash are not durable publication. Preserve the original raw files and failure chronology; publish only the reviewed sanitized material to a suitable authorized destination. Record its verified link, identity and checksum. Do not describe the sanitized tar as byte-identical to the private raw directory.

R1 is the only new implementation/test change requested from the implementer. R2–R5 are independent evidence or gate blockers, not permission to expand the production patch. The same implementer should receive R1 unchanged, with a fresh re-check after the bounded fix and at most the existing allowed fix rounds.

## Verified production and security behavior

- process.ts:63–76 catches only errors from the optional reader.get expression. Only object errors with code EACCES or EPERM return null; other thrown values propagate unchanged. inferHarness remains outside the catch. The denial stops traversal immediately and cannot select a farther readable harness.
- LinuxProcessReader.get remains strict and byte-identical outside the selected discovery change. Its stat recheck, namespace read, bounded cmdline/environ reads and environment allowlist are unchanged. ProcessReaderPort, inferHarness, actualSourceRoot and the eight-ancestor/PID-1/self-parent limits are unchanged.
- registry.ts:84–87 and 117–123 still require initial self/actual-parent/domain evidence and final physical stamp revalidation before registry writes. A denial on those mandatory reads remains a failure.
- Null discovery produces null harness/source/harness PID/start without manufacturing SessionRef, ProcessKey authority or a configured-root fallback. Source-less tools refuse before scope selection or dispatch.
- LedgerCallerRegistry's independent physical checks and the existing real-process/forged-start/forged-cwd tests are preserved. The simulated ledger cases check that only the caller row is stored; source/session/scope/context/alias/claim/binding/link/run/report/idempotency/slot counts remain zero through refused whoami.
- A previously valid Codex root loses current optional evidence and returns identity_unverified before scope selection/dispatch; restoration requires a fresh independently valid resolution. Existing metadata, native-child, PID reuse, source/header/version and shared/daemon guards are unchanged. Authorization and Claude hook suites execute in both recorded hud-mcp runs; no source-authority escape was found.
- The separate startup-writer problem remains: ledger-registry.ts:23–26, 49–50 still performs process/content reads while holding the writer transaction. This patch neither fixes nor approves that issue, and P065's metadata exception does not cover it.

## Verified evidence and command outcomes

I recomputed the tar SHA-256 as b1b01d2683500441c23f0544eb5ac3546b290a7c563145515c318cddd6bde395. All 127 RAW-SHA256SUMS entries match. All 115 publication SHA256SUMS entries match. All 87 declared home-prefix transformations match exactly, with no additional changes in those transformed files. All 116 tar members match the sanitized publication bundle. The archive is that sanitized bundle, not the raw directory. The later publication-status/addendum records are outside the frozen archive.

All 42 available executed-command JSON records, including the two preliminary runs, agree with their log headers and CHECK_END footers. The 40 final/baseline/benchmark command intervals do not overlap each other. This establishes serialization of the recorded package commands, not control of external host load. The preliminary 39-test result is not credited as the final candidate result.

The final Node 22 and Node 24 build/dependency manifests are byte-identical. Candidate and baseline manifests differ only in production process.ts and its compiled hud-mcp process.js; all three candidate test files are identical between arms. The benchmark blob is unchanged: c36817dee4cf70c27a39a86b3965f4eb6701ceb0.

Recorded host: cloud Linux 6.18.57 x86_64, glibc 2.41, Xeon Platinum 8573C, 9 visible logical CPUs. Conventional cgroup limit values were unavailable; no quota or quiet-host guarantee is inferred. Node 24.22.1 binary SHA-256 is 61ab14cd750fc24d5db53490ec5fc40f756e4b6e136b78cf7004265471d9bd1d; Node 22.23.4 is 94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90. Root package-lock SHA-256 is 98a7e2d3f5256810fe477812be64b35411aeede8b34f91e648d62e96c39e3294. Existing same-lock dependencies were reused; no install/update is credited.

Every recorded final command has fresh HOME/HUD_HOME/TMPDIR, NODE_USE_ENV_PROXY=1, NODE_OPTIONS unset and NODE_COMPILE_CACHE unset. Proxy-variable presence is recorded without exposing values. The wrapper removes inherited named harness/session/color selectors. Raw warnings remain visible.

| Final-candidate command | Node 24.22.1 | Node 22.23.4 |
|---|---|---|
| npm run build | exit 0 | exit 0 |
| npm run build:test | exit 0 | exit 0 |
| npm run build:hud-mcp | exit 0 | exit 0 |
| Three-file focused node --test | 40 pass, no failures/skips, exit 0 | 40 pass, no failures/skips, exit 0 |
| npm test | blocked, not run | blocked, not run |
| npm run test:mjs | 32 pass / 15 fail, exit 1 | blocked, not run |
| npm run test:core | 209 pass / 1 existing skip, exit 0 | 209 pass / 1 existing skip, exit 0 |
| npm run test:visual | 319 pass, exit 0 | 319 pass, exit 0 |
| npm run test:hud-mcp | 103 pass / 1 fail / 1 existing skip, exit 1 | 104 pass / 1 existing skip, exit 0 |
| Isolated b20-advice rerun | 9 pass, exit 0 | not required |
| npm run format:check | exit 0 | exit 0 |
| Explicit four-owned-file prettier --check | exit 0 | exit 0 |
| npm run check:fixtures | exit 0 | exit 0 |
| git diff --check | exit 0 | exit 0 |

The Node 24 hud-mcp failure is the documented ledger_busy family in b20-advice. Its single isolated nine-test rerun is permitted by the existing README rule; the original failing aggregate is retained, not rewritten as exit 0. This does not resolve the unrelated blocked/full-suite gates. The core HUD_LEDGER_BENCHMARK and hud-mcp HUD_B45_BENCH opt-in cases remain skips, not passed measurements.

The focused invocation is node --test followed by the three packages/hud-mcp/dist/tests/hud-mcp/{ancestor-discovery,skeleton,int-ledger-registry}.test.js files. Builds and checks retain the brief's command-specific timeouts. Full npm test was not attempted; its 1800-second allowance is not an executed measurement.

## Meaningful failing-before controls

Both baseline hud-mcp builds exit 0. The identical three-file focused suite on the pinned production baseline reports 32 pass / 8 fail / 0 skip, exit 1, on both runtimes:

- Four configured/unconfigured EACCES/EPERM registration cases fail from old optional-read error propagation.
- Two ledger registration cases fail at the same propagation before a physical caller is persisted.
- Two current-source-loss cases already refuse on the baseline, but return identity_source_missing rather than identity_unverified. These establish classification/current-evidence regression behavior, not an old authorization escape.

The remaining mandatory-read, zero-write, non-permission/exact-Refusal, malformed-evidence, traversal-bound and genuine-source controls pass on both trees. The new candidate's sixteen deterministic ancestor tests, two source-loss regressions and three additive ledger/stdio cases are real executed tests, not missing-export or compile-failure controls. R1 limits only the complete-output claim of the new stdio case.

## Process benchmark accounting

Unchanged node tests/hud-mcp/benchmark.mjs, three complete runs per arm/runtime, 600-second outer limit each. Every run completes 30 new-process initialize samples and 200 calls per method. Cold timing covers spawn through initialize response, not process shutdown; the driver reuses its per-run synthetic HUD home, so this is not a fresh-filesystem/DB benchmark. There is no discarded cold warm-up and no discarded method warm-up after the persistent client's initialization. p95 is nearest rank: ceil(n × .95). The driver does not report p50 or p99.

| Arm/runtime/run | Cold p95 ms | Cold max ms | List p95 ms | Refused whoami p95 ms | Exit |
|---|---:|---:|---:|---:|---:|
| baseline Node 22 / 1 | 404.379 | 666.424 | 0.719 | 0.642 | 1 |
| baseline Node 22 / 2 | 251.948 | 318.245 | 0.914 | 0.760 | 1 |
| baseline Node 22 / 3 | 218.628 | 223.929 | 0.755 | 0.848 | 1 |
| candidate Node 22 / 1 | 235.458 | 346.636 | 0.594 | 0.736 | 1 |
| candidate Node 22 / 2 | 544.945 | 677.421 | 1.014 | 0.892 | 1 |
| candidate Node 22 / 3 | 210.635 | 231.871 | 1.920 | 1.877 | 1 |
| baseline Node 24 / 1 | 407.240 | 481.066 | 0.950 | 0.670 | 1 |
| baseline Node 24 / 2 | 375.217 | 390.912 | 1.027 | 0.892 | 1 |
| baseline Node 24 / 3 | 237.383 | 277.251 | 1.350 | 1.006 | 1 |
| candidate Node 24 / 1 | 285.203 | 372.627 | 1.372 | 1.295 | 1 |
| candidate Node 24 / 2 | 548.036 | 837.768 | 1.130 | 1.056 | 1 |
| candidate Node 24 / 3 | 275.888 | 292.735 | 0.590 | 0.647 | 1 |

The unchanged strict gates are cold p95 < 200 ms and each method p95 < 50 ms. All method p95 values pass; all cold p95 values fail. No failed startup was replaced by a fast numeric result. These cloud observations are not formal WSL, B14, P-06 or real-harness qualification.

## Remaining cross-package and integration gates

The implementation report's statement that the Node 22 profile consultation is still open is now superseded in part by the recorded node22-proxy-profile ruling: the proxy-enabled configuration is retained, and a bounded capture/diagnostic-expectation remedy is selected. That is a design disposition, not verified implementation or a green matrix. The owner archive's enabled/no-envproxy runs remain distinct; this MCP-focused pass cannot close the output failures or the route witness. NODE22-PROXY remains separately owned and must supply its own required evidence and fresh acceptance. Do not merge its unaccepted code into MCP-ANCESTOR to manufacture green.

No actual --no-ff merged-tree checks have been run for this candidate. Only after the bounded test fix, all required evidence/gates and a fresh accept verdict may the sole merger prepare integration; it must then establish the complete green check set on that actual merged tree before pushing. Preserve the existing restrictions on main, force-push, history rewriting, dependency-state staging, unaccepted-feature combinations and assistant-run local testing. No other package or later queue wave is accepted by this review.

Sources: [binding brief](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/MCP-ANCESTOR.md), [governing ruling](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/rulings/mcp-ancestor-gate.md), [Node 22 profile disposition](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/rulings/node22-proxy-profile.md), [owner report](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/REPORT.md), [HYG2 local Oracle review](https://github.com/CartmanFatass/codex-hud/blob/ce5e6961a0e6de1304dcebb00fc1b8c805573ec6/docs/cloud/handoff/hyg2-local-review-20261103.md), [implementation report](https://github.com/CartmanFatass/codex-hud/blob/48b60f705860e9d662872fffa776193a132364c1/docs/cloud/handoff/mcp-ancestor-implementation.md), [publication addendum](https://github.com/CartmanFatass/codex-hud/blob/48b60f705860e9d662872fffa776193a132364c1/docs/cloud/handoff/mcp-ancestor-publication.md).

**Final disposition: fix required; acceptance and merge HOLD.**