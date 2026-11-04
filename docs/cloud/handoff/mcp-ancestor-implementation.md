# MCP-ANCESTOR implementation report

Status: bounded implementation complete; **not accepted, not mergeable**. No full README green result, real root-owned ancestor reproduction, proxy-profile disposition or Oracle accept verdict is claimed.

## Identity and ownership

- Base: `26f6fba36948e6c96e2e109cb374c0d4dbb9ab22`, tree `03bd36610d46fd220eb9c0e4fbf153a52bc3c3b9`.
- Frozen candidate source tree: `10ce62eb316fb8954a5b667da261d301e2dd69ea`.
- Local branch: `dots/mcp-ancestor`, checkout `/workspace/shared/mcp-ancestor`. Baseline production checkout: `/workspace/shared/mcp-ancestor-baseline`.
- No source commit or remote publication has occurred at report creation. Dispatcher publication/review is pending.
- Exactly four source/test paths differ in the candidate tree. Installed `node_modules/.package-lock.json` differs locally because dependencies were copied from the existing matching-lock installation. It is excluded from the candidate tree and has never been staged.
- The authorized GitHub connector supplied the exact pinned tree and 16 locally missing blobs. The other 1,286 blobs were reused only by exact Git object identity. The full reconstructed tree and unsigned commit bytes hash to the exact pinned identities. This did not import NEXT/P065/HYG2/RUNZ1 production code. Earlier parent history was not materialized; no remote history was rewritten.
- Binding brief was read on universal-hud. Its obsolete dated ruling link was not edited; the verified governing ruling is `docs/cloud/rulings/mcp-ancestor-gate.md`.

## Changes

1. `packages/hud-mcp/src/process.ts`: only the optional `reader.get` expression in `findHarness` gets a narrow object/code boundary. EACCES/EPERM immediately returns null. Other errors are rethrown unchanged. Harness inference remains outside the catch, and no higher ancestor is read after denial.
2. `tests/hud-mcp/ancestor-discovery.test.ts`: 16 deterministic tests for both denied errnos, configured/unconfigured roots, a readable farther harness that must not be read, exact physical stamps/cwd and null source/harness fields, zero dispatch/scope selection, initial/final mandatory-read denial with no registry writes, exact non-permission/Refusal propagation, malformed evidence, eight-read/nearest/PID-1/self-parent bounds, and physical stamp/namespace/domain/cwd guards.
3. `tests/hud-mcp/skeleton.test.ts`: two additive genuine-source regressions. A previously resolving Codex root loses optional ancestor access; the next call returns identity_unverified before scope selection or body invocation. Restoring independently valid current evidence permits a subsequent root call. Existing native-child/forged metadata/source/PID/version guards remain unchanged.
4. `tests/hud-mcp/int-ledger-registry.test.ts`: two explicitly simulated ledger regressions assert only physical registration persists and all source/session/context/scope/alias/claim/binding/run/report/idempotency/slot counts remain zero before and after refused whoami. A third additive real unconfigured stdio test sequentially exercises initialize, tools/list and refused whoami with exactly three JSON-RPC stdout records. The existing real-process test and forged-start/cwd checks are preserved, with the production LinuxProcessReader unchanged.

No exported API, schema, capability, profile, numeric budget, source resolver, mandatory registration check, byte cap, discovery depth, benchmark or warning policy was changed. `registry.ts`, `ledger-registry.ts`, `resolvers.ts`, `inferHarness` and `actualSourceRoot` retain their pinned behavior. The startup writer's separate lock-held process-content issue remains unresolved.

## Environment and isolation

Cloud Linux 6.18.57 x86_64, glibc 2.41, Intel Xeon Platinum 8573C, 9 visible logical CPUs. CPU/memory cgroup limits were unavailable at the conventional queried paths; no quota claim is made. External host load is not controlled. This is not formal WSL/B14 qualification.

- Node 24.22.1 and Node 22.23.4, exact binaries/hashes recorded per command. Both used the existing npm 11.9.0 installation via PATH-selected Node.
- Identical package-lock SHA-256 `98a7e2d3f5256810fe477812be64b35411aeede8b34f91e648d62e96c39e3294`; dependencies copied from the existing same-lock installation, no dependency install/update.
- Final checks use fresh temporary HOME, HUD_HOME and TMPDIR per command, remove inherited real harness/session selectors and color selectors, and preserve proxy routing variables plus NODE_USE_ENV_PROXY=1. NODE_OPTIONS was unset; no no-warnings flag or stderr normalization was added. NODE_COMPILE_CACHE was unset for matched runs. Exact argv, wrappers, start/end UTC, timeout and exits are in raw logs and JSON records.
- The first preliminary 39-test focused pass predates the final extra malformed-evidence test and wrapper narrowing. It is retained, clearly named without the final prefix, and is not the final candidate claim. Final source stayed frozen throughout the final Node 24/22 checks and matched series.
- Final compiled/dependency manifests from both runtimes compare byte-identically. All frozen source hashes were checked again after execution.

## Checks on the final candidate

| Check | Node 24.22.1 | Node 22.23.4 |
|---|---|---|
| npm run build | exit 0 | exit 0 |
| npm run build:test | exit 0 | exit 0 |
| npm run build:hud-mcp | exit 0 | exit 0 |
| Declared three-file focused suite | 40 pass, 0 fail, exit 0 | 40 pass, 0 fail, exit 0 |
| npm test | BLOCKED, not run: established denied socket/ptrace capabilities and missing process-children facility | BLOCKED, not run, same restrictions |
| npm run test:mjs supplement | 32 pass, 15 fail, exit 1; synthetic Unix-socket listen EPERM in herdr-bridge.mjs | BLOCKED, not run, to avoid retrying the same denied socket operations |
| npm run test:core | 209 pass, 1 existing skip, exit 0 | 209 pass, 1 existing skip, exit 0 |
| npm run test:visual | 319 pass, exit 0 | 319 pass, exit 0 |
| npm run test:hud-mcp | 103 pass, 1 fail, 1 existing skip, exit 1; b20-advice ledger_busy | 104 pass, 1 existing skip, exit 0 |
| Existing permitted isolated b20-advice rerun | 9 pass, exit 0; both original failure and rerun preserved | not needed |
| npm run format:check | exit 0 | exit 0 |
| Explicit four-owned-file prettier check | exit 0 | exit 0 |
| npm run check:fixtures | exit 0 | exit 0 |
| git diff --check | exit 0 | exit 0 |

The test:mjs socket dependencies were discovered in the supplemental run. Its failure is retained, not reclassified as a flake, and Node 22 was blocked rather than retried. No denied capability, privileged helper or alternative endpoint was used. The one ledger_busy rerun is the README's existing isolated-rerun rule, not a new exception.

## Meaningful failing-before evidence

The baseline uses the exact pinned production tree plus the identical three candidate test files. It compiles successfully on each runtime. The same declared three-file suite returns **32 pass, 8 fail, exit 1** on both runtimes:

- Four simulated optional-denial registration cases fail at the old EACCES/EPERM propagation, rather than at compilation/missing symbols.
- Two simulated ledger registration cases fail at the old propagation before a physical caller can be stored.
- Two later-source-loss cases still refuse on baseline, but produce identity_source_missing rather than the new existing null-discovery path's identity_unverified. These are classification/current-evidence regression controls, not newly fixed authorization escapes.

All other guards pass both trees. No security guard is presented as a pre-existing authorization bug. Raw failures and unchanged-production hashes are retained in negative-controls.log and the baseline manifests.

## Existing process benchmark

Unchanged driver blob `c36817dee4cf70c27a39a86b3965f4eb6701ceb0`. Three sequential isolated matched runs per arm/runtime, each completes 30 cold samples and 200 calls per method. No failed startup is substituted with a fast result. Every run reports all driver fields and exits **1** because cold-start p95 exceeds the unchanged 200 ms gate. Tools/list and refused-whoami p95 remain below the existing 50 ms gates. No new percentile or B14/P-06 qualification is invented.

| Runtime/arm/run | Cold p95 ms | Cold max ms | List p95 ms | Refused whoami p95 ms | Exit |
|---|---:|---:|---:|---:|---:|
| baseline-node22-benchmark-1 | 404.379 | 666.424 | 0.719 | 0.642 | 1 |
| baseline-node22-benchmark-2 | 251.948 | 318.245 | 0.914 | 0.760 | 1 |
| baseline-node22-benchmark-3 | 218.628 | 223.929 | 0.755 | 0.848 | 1 |
| baseline-node24-benchmark-1 | 407.240 | 481.066 | 0.950 | 0.670 | 1 |
| baseline-node24-benchmark-2 | 375.217 | 390.912 | 1.027 | 0.892 | 1 |
| baseline-node24-benchmark-3 | 237.383 | 277.251 | 1.350 | 1.006 | 1 |
| candidate-node22-benchmark-1 | 235.458 | 346.636 | 0.594 | 0.736 | 1 |
| candidate-node22-benchmark-2 | 544.945 | 677.421 | 1.014 | 0.892 | 1 |
| candidate-node22-benchmark-3 | 210.635 | 231.871 | 1.920 | 1.877 | 1 |
| candidate-node24-benchmark-1 | 285.203 | 372.627 | 1.372 | 1.295 | 1 |
| candidate-node24-benchmark-2 | 548.036 | 837.768 | 1.130 | 1.056 | 1 |
| candidate-node24-benchmark-3 | 275.888 | 292.735 | 0.590 | 0.647 | 1 |

All twelve failures are retained; the baseline itself is red. The noisy ranges do not support a performance improvement or equivalence claim. No rerun-to-pass, sample trimming, pooling, warning suppression or driver edit occurred. The declared six runs per runtime were completed once.

## Open gates and next step

1. Real unreadable/root-owned ancestor evidence is pending in the owner's workflow. Passing real registration here and synthetic errno faults do not prove the required topology. See root-ancestor-evidence.md.
2. Full npm test and Node 22 test:mjs need an already permitted capable executor; current cloud denials remain blockers. No owner-local test was restarted.
3. All twelve unchanged process benchmarks fail cold startup on both trees. No acceptance/performance gate is waived; any further remedy or integration disposition belongs to a fresh Oracle and a separately bounded scope.
4. Node 22 envproxy compatibility is a separate open consultation. These specific proxy-enabled passes do not close the wider output-contract failures.
5. Fresh Oracle must verify the source diff, exact tree, raw logs, negative controls, ownership, remaining evidence and verdict. Acceptance remains held. Any later integration still requires accept plus complete green checks on the actual --no-ff merged tree; no main/force-push/history rewrite or unaccepted-feature combination.

## Artifacts

Private working evidence directory: `/workspace/shared/mcp-ancestor-evidence/`. Dispatcher-ready public copies replace only the cloud-account home-path prefix with `<CLOUD_HOME>`; failure text, test results, ordering, timestamps and exits are preserved. The sanitization manifest lists every transformed file. SHA256SUMS covers the publication bundle. Source hashes are in candidate-source.json; per-runtime build/dependency hashes are in the final manifests. No secrets or process environment contents were captured.
