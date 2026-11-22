# HYG2 local-evidence Oracle re-check (2026-11-03)

**Verdict: fix required. HYG2 is not accepted; do not merge.**

The original buffered-message P2 remains fixed. The new local evidence now demonstrates passing execution of the previously blocked unit and mjs tests on this WSL host. The present full-check blocker is different: physical caller registration fails with an ancestor `/proc/.../environ` EACCES in all three HYG2 runs. Node 22 with `NODE_USE_ENV_PROXY=1` additionally has thirteen unit failures and eleven overlapping focused failures caused by visible proxy-warning output. Neither failure category is waived. No new defect introduced by the HYG2 changes was identified.

## Scope and pinned identity

Reviewed the published owner-run evidence at `local-verification/20261103`, pinned to commit `9be7246c25b5355845e639116c57150ff79d3117`, including REPORT.md, SUMMARY.json, SUMMARY.steps.json, SHA256SUMS, every HYG2 command log and before/after status file, relevant manifests, driver/probe scripts and dependency-install logs. Also read HYG2, its ownership ruling, both previous reviews, the topology diagnosis, workflow/merge rules, current STATE, and relevant source and tests.

- Tested HYG2 commit: `2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31`.
- GitHub confirms its tree: `50438e87a1915d5e739a4a4d926cc9b1e7e85724`.
- The observed `dots/hyg2` branch still points to that commit.
- The thirteen commits after the accepted P2 fix `4e120f5e82e81124619d9dbb9bf5875ceb581405` change only documentation/evidence. They do not alter production or test code.
- The ProcessClient and regression-test blobs remain `c161c158f85db34188e754ed06adcb842d93ae4a` and `3ab24c1d2ed1433ae25d5ca674a1d05bcceac6e3`, matching the prior re-check.
- The package remains based on `f1e2a8408fbc6ddef181978e8a2d9fd5831242e9`. These are package-branch tests, not tests of a merged `universal-hud` tree.

Sources: [pinned HYG2 commit](https://github.com/CartmanFatass/codex-hud/commit/2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31), [fix-to-tested comparison](https://github.com/CartmanFatass/codex-hud/compare/4e120f5e82e81124619d9dbb9bf5875ceb581405...2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31), [local report](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/REPORT.md), [previous review](https://github.com/CartmanFatass/codex-hud/blob/2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31/docs/cloud/handoff/hyg2-review-2.md).

## Independent archive verification

I recomputed SHA-256 over the downloaded published UTF-8 contents and checked their byte lengths against the pinned Git tree. All **63 inspected archive files** match their SHA256SUMS entries and Git-tree sizes. This includes all **40 HYG2 files: 34 command logs and six before/after status files**, plus the report, both summaries, relevant common manifests/scripts and setup logs. This is a HYG2-scoped verification, not a claim to have hashed every other package's evidence.

All 34 HYG2 command-log headers/footers agree with `manifest/results.tsv` on pinned commit, command, start/end timestamps and exit status. SUMMARY.json has no HYG2 outcome/path discrepancy. All six status files contain only the recorded unstaged `node_modules/.package-lock.json` change. The source package-lock SHA-256 independently matches the environment manifest: `98a7e2d3f5256810fe477812be64b35411aeede8b34f91e648d62e96c39e3294`.

Selected verified hashes:
- REPORT.md: `959e66f4fd51254cd919de7604be065b119fc5fd650d10f0df185f1b35ad818f`
- SUMMARY.json: `d65c905df9081a44da4be89d8fcef80b1d962db3ef85c53f00edb8f547b59373`
- HYG2 Node 24 npm-test log: `1952fc9c98ed9c823aa1ffa874f7bc376f32421e41cc01ce0dedfa6e3afb9a01`
- HYG2 Node 22 no-envproxy npm-test log: `7945543cfb6eaffbee3b8b00149a07209b0024f40dc5d0e748572c36956dc492`
- HYG2 Node 22 no-envproxy hud-mcp log: `61804d9688238949154e60e688303beb593c33edc45a9212905e02a8700ddbfb`

These checks establish consistency and completeness of the inspected published, sanitized files. They do not independently authenticate the owner's machine or compare against the unredacted originals retained there. No HYG2 built-output fingerprint is supplied; build logs, pinned headers, unchanged tracked-source status and the remote tree provide the source/build provenance available here.

Two non-blocking metadata caveats should be retained when consuming the archive:
- `run_id`/`run` in the summaries and the report title are `.`; `manifest/environment.txt` supplies the actual run ID `20261103T154219Z`.
- SUMMARY.json's Node 24 npm-test counts include a nested B21 child runner's `3 tests / 2 pass / 1 skip` block before the actual `2357`-test unit and `47`-test mjs summaries. Do not add that child block to the main totals. The report's main outcome counts are correct.

Sources: [checksums](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/SHA256SUMS), [results manifest](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/manifest/results.tsv), [machine summary](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/SUMMARY.json).

## Verified outcomes

The recorded host is Ubuntu 24.04.4 on WSL2, kernel `6.18.33.2-microsoft-standard-WSL2`, with Node 24.22.1 and Node 22.23.4. The wrapper uses `env -i`, a fresh temporary HOME, HUD_HOME unset so its effective default is beneath that temporary HOME, and no NODE_OPTIONS. Later proxy variables are explicitly passed through; the Node 22 second matrix omits only NODE_USE_ENV_PROXY. For HYG2 specifically, every Node 24 step finished before the 16:00Z proxy-policy change, so this HYG2 matrix is **not** a Node 24-with-envproxy test.

- **Node 24:** build, build:test, build:hud-mcp, format, fixtures and whitespace checks exit 0. `npm test` exits 0: unit **2341 pass, 0 fail, 16 skipped of 2357**; mjs **47/47**, no skips. Core **209 pass, 0 fail, 1 skipped of 210**. Visual **319/319**. HYG2 focused **76/76**, no skips. Hud-mcp **82 pass, 1 fail, 1 skipped of 84**, exit 1.
- **Node 22 with NODE_USE_ENV_PROXY=1:** the same build/core/visual/format/fixture/whitespace results. Unit **2328 pass, 13 fail, 16 skipped of 2357**, causing npm test to exit 1 before mjs. The separately recorded mjs supplement at 16:37:39Z passes **47/47**, exit 0. Focused **65 pass, 11 fail of 76**, no skips. Hud-mcp **82 pass, 1 fail, 1 skipped of 84**, exit 1.
- **Node 22 without NODE_USE_ENV_PROXY:** the same successful counts as Node 24, including both npm-test stages and **76/76** focused tests. Hud-mcp remains **82 pass, 1 fail, 1 skipped of 84**, exit 1.

No HYG2 run contains cancellations. No HYG2 known-flake rerun converted the persistent registration failure into a pass. The earlier setup `npm ci` ECONNRESET attempt is retained, followed by a successful install; it is not misreported as a test failure.

The suite-defined main-unit skips are B12_BENCHMARK ×1, HUD_EXPORT_BENCHMARK ×2, B22_PROCESS ×1, B6_PROCESS ×10, B6_PERF ×1 and HUD_LEDGER_BENCHMARK ×1. Core skips HUD_LEDGER_BENCHMARK; hud-mcp skips HUD_B45_BENCH. The nested B21 child runner also skips its B21_PERF case, separately from the main-unit count. Focused HYG2 and mjs skip nothing. These opt-in checks were not executed and are not credited as passes. Herdr, real tmux, probes, B13_REAL, real logged-in harnesses, install/uninstall, Hermes and formal P-06-7 qualification were not established by this evidence.

Sources: [Node 24 npm test](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/logs/hyg2/node24/04-npm-test.log), [Node 22 no-envproxy npm test](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/logs/hyg2/node22-noenvproxy/04-npm-test.log), [Node 22 supplemental mjs](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/logs/hyg2/node22/04b-test-mjs-separate.log), [wrapper](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/manifest/scripts/lib.sh).

## Previous findings

**Buffered messages bypass terminal failure — fixed, not reopened.** The current utility checks failure before consuming buffered messages, clears its buffer on failure and ignores subsequent messages. All three actual-child regressions for fatal/close/disconnect pass in the local focused runs, including the envproxy run. The previously reviewed negative-control result is unchanged; this review did not rerun it.

**Earlier twelve unit failures and fifteen mjs failures — locally satisfied on the pinned package, not erased from history.** The new zero-failure unit and mjs executions actually exercise the formerly blocked tests. The logs include passing B19 socket cases, all three H05 fault-boundary cases, the three exec/ptrace audit cases, and both waiter/forwarder death cases. The capability-probe outputs independently recorded in the archive report working AF_UNIX, ptrace TRACEME/ATTACH and proc-children under both runtimes. Thus the missing execution evidence from the previous review is now supplied for this host. This does not mean the original cloud executor gained those capabilities or that its failures were invalid.

**Full-green acceptance requirement — not fixed.** The remaining registration failure prevents the required green check set in every HYG2 matrix.

## Open failure 1: ancestor EACCES

**`packages/hud-mcp/src/process.ts:29,62–65`; `registry.ts:84–88`; `tests/hud-mcp/int-ledger-registry.test.ts:47` — ancestor environment read aborts physical caller registration — P2 cross-package blocker.**

The exact failing test in all three HYG2 runs is `int hud-mcp physical caller registration persists real procStart/cwd without logical authority`. Its raw stack is `readBounded → LinuxProcessReader.get → findHarness → registerCaller`, with `EACCES: permission denied, open '/proc/29952/environ'`.

The code reads environ for each ancestor before checking whether its command line identifies a harness; findHarness lets that exception escape. The integration test has `profile: null` and fails before it can verify the persisted physical caller fields. This is an exercised registration failure, not a passed test or a harmless diagnostic. The passing adjacent composition test does not negate it: it creates an additional child and therefore has different ancestry/depth.

These production and integration-test blobs are byte-identical to the `f1e2a84` base, so the failure is not introduced by HYG2. Contract 01 distinguishes physical registration from logical authorization and treats harness/source as hints. A correction must preserve verified self/parent stamps, PID-domain checks and all logical authority gates. Do not turn an unreadable ancestor into fabricated harness/source identity, relax proc permissions, or hide the failing test.

REPORT.md attributes PID 29952 to a root-owned WSL Relay ancestor after detached drivers were reparented. The inspected archive contains the raw EACCES and stack, but no separate contemporaneous raw UID/ancestry snapshot. That specific Relay/UID attribution remains the owner's recorded explanation, rather than independently corroborated machine-state evidence. It is plausible and consistent with the code path; it is not needed to establish the red gate.

Disposition: keep the blocker open and route a narrowly scoped registration/topology diagnosis and correction separately from HYG2 ownership. Establish which ancestor evidence is required versus optional, add coverage for unreadable unrelated ancestors without granting logical authority, and obtain the complete passing gate. Moving the runner under a convenient parent, skipping this test, or classifying EACCES as an approved flake is not a resolution demonstrated here.

Sources: [failing raw log](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/logs/hyg2/node22-noenvproxy/07-test-hud-mcp.log#L365-L382), [ancestor reader](https://github.com/CartmanFatass/codex-hud/blob/2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31/packages/hud-mcp/src/process.ts#L22-L68), [registration](https://github.com/CartmanFatass/codex-hud/blob/2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31/packages/hud-mcp/src/registry.ts#L84-L116), [physical identity contract](https://github.com/CartmanFatass/codex-hud/blob/2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31/docs/contracts/01-identity.md#L29-L36).

## Open failure 2: Node 22 envproxy output

The thirteen failed unit tests are:
1. `hud help and strict argument refusals never access or create a ledger`
2. `hud rejects missing, relative, public, symlink, file and foreign-owned HUD_HOME without writes`
3. `hud missing and unreadable ledgers fail with no stdout or initialization`
4. `hud rejects symlink HUD_HOME with trailing slashes and dot components in real processes`
5. `hud unsearchable HUD_HOME returns home exit 3 while an unreadable ledger returns exit 4`
6. `hud reports asynchronous stdout failures for export and help without Node stack traces`
7. `hud real launcher matches the query JSON and leaves database/WAL bytes and mtime unchanged`
8. `hud refuses unknown ledger versions without migrating or emitting JSON`
9. `hud producer validation refusal writes no partial JSON`
10. `hud defaults to ~/.hud only inside an isolated synthetic HOME`
11. `hud export leaves fresh-process raw stderr free of SQLite initialization warnings`
12. `light leader preserves exact brief bytes and EOF on workload fd0`
13. `one-shot group launch preserves argv and stdin EOF, waits for helper exit`

The focused failures are the first eleven. The raw assertions show `[UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental...`, not the SQLite initialization warning. All thirteen pass in the owner-selected Node 22 rerun without NODE_USE_ENV_PROXY, with the other proxy variables retained. This is strong evidence of an environment-triggered output incompatibility on the tested runtime, not evidence that HYG2's SQLite suppression failed.

The last two tests deliberately direct stdout and stderr to the same output file (`run-process.test.ts:73–74` and `run-light-leader.test.ts:102–103`). Their prefixed bytes/invalid JSON therefore do not demonstrate corruption of the workload's stdin. They demonstrate that the combined captured output contains a runtime warning. Failed assertions may also prevent later assertions from running, so the failing matrix cannot be credited with all the behavior verified by the passing matrix.

The HYG2 ruling explicitly requires preserving unrelated warnings. Do not broaden SQLite suppression, add a global no-warnings switch, normalize raw stderr, or loosen byte assertions to obtain a green result. Preserve this failing matrix as a separate compatibility observation. The owner-chosen no-envproxy matrix is valid additional evidence, not a retroactive pass for the envproxy matrix. Any decision to change the required supported environment/profile belongs to the owner; no such change is made by this review.

Sources: [envproxy unit failures](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/logs/hyg2/node22/04-npm-test.log), [proxy-policy record](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/manifest/proxy-policy-change.txt), [HYG2 warning ruling](https://github.com/CartmanFatass/codex-hud/blob/2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31/docs/cloud/rulings/hyg2.md#L35-L39).

## Remaining acceptance and integration gates

1. Resolve the registration/topology blocker through appropriately scoped work, preserving fail-closed identity behavior. The report's environment attribution alone does not close it.
2. Retain both Node 22 proxy-policy matrices and explicitly resolve any intended-profile question rather than silently excluding a failing configuration or suppressing unrelated warnings.
3. Obtain the required full green README check set, including mjs and hud-mcp, on the intended package code tree. Record exact commit/tree, commands, runtime/environment, raw output and exit codes; preserve initial and isolated outputs for any genuine listed flakes. Focused 76/76 is not a substitute.
4. A subsequent Oracle must issue an accept verdict after those gates are met. Only then may the dispatcher prepare the `--no-ff` integration; the full check set must also be green on the actual merged tree before it is pushed. Nothing in this archive tests or authorizes that merged-tree state.

No HYG2 implementation changes are requested for the already-fixed P2 or already-reviewed SQLite/B45/helper work. No test, gate, supported profile, ownership boundary or security setting is waived or changed. This review performed read-only source/evidence inspection and in-memory integrity checks only.

Sources: [HYG2 acceptance](https://github.com/CartmanFatass/codex-hud/blob/2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31/docs/cloud/HYG2.md), [merge rules and current checkpoint](https://github.com/CartmanFatass/codex-hud/blob/a8cbaf547dd0e9c7b0239fa4498a84baf8224889/docs/handoff/STATE.md#L24-L35).