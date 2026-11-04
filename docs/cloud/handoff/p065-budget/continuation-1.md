# P065-BUDGET continuation 1: semantic correction and exact execution blocker

Date: 2026-11-03. Status: frozen, uncommitted continuation WIP; NOT accepted, NOT mergeable, NOT performance-qualified.

## Authority and source
The dispatcher admitted this bounded continuation after RUNZ1-KILL returned its window at 21:06:54 UTC. Scope was frozen-source reconciliation, status/wait correction, semantic coverage and bounded driver readiness. Full qualification series was expressly excluded. The corrected six-design ruling and synchronized P065/contract 06/concept §15 amendments control this continuation.

Before edits, all 30 candidate-2 files independently matched source-manifest.json byte lengths/SHA-256 values. Published candidate 2 remains 346b3d6300a2e3f340f22e832c459371c19e2646, tree 613c6bb048dc6b8616617b2d061232807102e9cb, based on 26f6fba36948e6c96e2e109cb374c0d4dbb9ab22. GitHub comparison verified that remote head cd26df9bf32221b3b925d70b8a3dc50cf84d778d is two commits ahead with only docs/cloud/handoff/p065-budget/implementation.md and publication-result.json added. These documentary descendants must be preserved. Local HEAD still denotes the base, not this continuation. No source commit or publication was made in this window.

## Changes from candidate 2
1. packages/hud-mcp/src/server.ts: trusted dispatch selects enforcing CallBudget only for write-capable tools. Status/wait use separate non-enforcing ReadCallTiming, retain original receipt time and never pass a write budget into source/hook resolution. Actual framed-flush observation remains. Read diagnostics explicitly report writeBudgetApplicable=false and null authorization/deadline/overrun values rather than a fake 30 ms pass.
2. packages/hud-mcp/src/delegation.ts: status/wait bypass newly added write-budget enforcement at service entry and completion, without bypassing source/current-authority checks. Write tools retain original budget propagation. Wait receives the original timestamp and trusted observation clock/callback.
3. packages/hud-mcp/src/read-control.ts: optional trusted timing dependencies preserve elapsed-time deduction and record upfront completion after the first real read. Observation failures do not alter the read result. No new ledger write was introduced.
4. src/ledger/call-budget.ts: added non-enforcing ReadCallTiming; enforcing diagnostics now explicitly identify write-budget applicability. Production thresholds and write checks unchanged.
5. tests/unit/p065-budget.test.ts: added run/get/all counted-DML marker guards and a different-return-object guard.
6. tests/hud-mcp/p065-budget.test.ts: added paired slow source/read cases for status/wait; source-expiry refusal before any writer for spawn/resume/cancel/whoami/report; revoked read authority; original wait elapsed deduction; wait cancellation after slow source; durable handshake and cancel replay across expiry with incidental rollback; new-binding rollback on expiry; old expectedRun replay after currentRun advances and changed-digest conflict. Read-only timing assertions now use explicit N/A write accounting.
7. tests/unit/p065-budget-fixture.ts: appended a WORK-IN-PROGRESS H/R fixture. It intends to create valid runs through acceptIntent/registerSupervisor/submission/startup APIs, distinct child bindings, independently registered caller compositions, fixture-only 12/12 capacity, valid resume-terminal setup, heartbeat CAS and population assertions. It has NOT been compiled to a known successful terminal result or exercised. Its correctness/readiness is unverified. The full benchmark driver and lock-holder files have NOT yet been created.

No schema, public error mapper, production defaults, package/build scripts, hook producer, shared docs or other package source changed. node_modules/.package-lock.json remains the pre-existing excluded generated change and was not staged/published.

## Recorded checks
Runtime for this continuation: Node v24.22.1, /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node. Existing wrapper used fresh temporary HOME/HUD_HOME/TMPDIR, explicit timeouts, raw stdout/stderr, original source hashes and compiled-file inventories. Commands were serialized.

- continuation-build-test.log: npm run build:test, timeout 180 s, EXIT_STATUS=0, 16 s; ended 21:10:25 UTC.
- continuation-unit-24.log: node --test dist-test/tests/unit/p065-budget.test.js dist-test/tests/unit/p065-local-gate.test.js, timeout 300 s, EXIT_STATUS=0; 43 passed, zero failed/skipped; ended 21:10:35 UTC.
- continuation-build-mcp.log: npm run build:hud-mcp, timeout 180 s, EXIT_STATUS=0, 7 s; ended 21:10:42 UTC.
- continuation-mcp-24.log: node --test packages/hud-mcp/dist/tests/hud-mcp/p065-budget.test.js, timeout 300 s, EXIT_STATUS=0; 23 passed, zero failed/skipped; ended 21:10:43 UTC.
- continuation-build-mcp2.log: npm run build:hud-mcp after extra replay tests, timeout 180 s, EXIT_STATUS=0, 6 s; ended 21:12:19 UTC.
- continuation-mcp2-24.log: same focused MCP command, timeout 300 s, EXIT_STATUS=0; 28 passed, zero failed/skipped; ended 21:12:20 UTC.
- continuation-build-fixture.log: npm run build:test after the workload-fixture addition, timeout 180 s, started 21:14:05 UTC. Outcome UNCERTAIN: log ends after tsc invocation with no exit status/footer. A polling action was denied. Subsequent read-only process listing found no matching compiler/check-wrapper process. Do not count as passed or blindly retry.

The 43-unit/28-MCP results PRECEDE the unvalidated workload-fixture addition. They are not checks of the entire final frozen continuation. No Node 22 rerun, broad check set, new behavioral negative control, cold CLI extension, readiness run or qualification series was completed in this window.

## Exact blocker and lease return
At 21:14:38 UTC the tool rejected write_stdin polling of the fixture/build session with:
“Unified exec process failed: This action was rejected due to unacceptable risk.
Reason: The command appends and reformats repository test files despite the user’s explicit instruction not to modify the workspace; the npm registry access is only incidental to this unauthorized action.”

The earlier command had already emitted successful formatting of tests/unit/p065-budget-fixture.ts. Read-only inspection confirmed the new source bytes exist. The build's terminal outcome is not known. No retry, alternate edit route, permission change or denial bypass was attempted. The dispatcher reiterated that its 21:07 admission superseded the earlier read-only scheduling hold; this does not retrospectively prove the uncertain build outcome. Further action requires reconciliation/new permitted admission, with no replay of the already-executed append.

The implementation stopped at this exact blocker. The compute lease was explicitly returned at 21:15 UTC. No matching active build/test process was found. Source remains frozen in /workspace/shared/p065-budget. No publication was attempted after the blocker.

## Frozen continuation identity
Thirty source/test paths, same set as candidate-2 manifest. SHA-256 of UTF-8 concatenation, in that manifest's existing file order, of path + NUL + decimal byte length + NUL + lowercase file SHA-256 + LF:
174f7fa30e934574ebcd615cda4b475a4c7b82c77964e9b6e0ad9cd333d2ae84.
This is an explicitly specified continuation identity method, not a claimed Git tree/commit or interchangeable candidate-2 aggregate algorithm.

Changed files (bytes; SHA-256):
- packages/hud-mcp/src/delegation.ts: 23230; 7b7289f280b5807f5c733826f2346b0c86a0a670208d86aa2b81f9dbba1a3f12
- packages/hud-mcp/src/read-control.ts: 16337; 144d841c60f08c9981ce5155ed26bbcbeceb95d1ae162057380f56fbf2bde4b7
- packages/hud-mcp/src/server.ts: 13128; df9d8be233acd49b2908f02f754a5395d48f6771373f02ee66b573cd20730e50
- src/ledger/call-budget.ts: 6210; 900589c446cda07cbe92ae3fd524fc126aa7eb8ce11184fa8e9aabe8b6c256fa
- tests/hud-mcp/p065-budget.test.ts: 30400; 08a00ee9ae48b22901febee799478f9d8c6c0554d846e1f994d90d4edefad4c2
- tests/unit/p065-budget-fixture.ts: 13038; 0e8f076fb2fe0ed1f89a31a4ba837b18278f917808de99e5f2ee6db524b2022f
- tests/unit/p065-budget.test.ts: 13889; aa4c9506c9138bcbe4cdff737e3852eee680e5d4cec38f5911aee5ed72b59332
The other 23 files still match candidate 2.

## Raw evidence locations and log identities
All continuation logs are under /workspace/shared/p065-budget-evidence/. Completed check logs also have .compiled-sha256 companions produced by the wrapper.
- continuation-build-test.log: 9a29268d10b89dc57d02b4ffab23917b2ccd5da695462452e556ac03a0dfa11d
- continuation-unit-24.log: 8a0e48cd7595115a8d32c030180c0f6c2e77ef88e4c71793552a7e76de165992
- continuation-build-mcp.log: 35f9d7b09065713a16e78533710a15c3fce3a79f344b11debd14c6280ce0bc57
- continuation-mcp-24.log: 0a1ff83959a8fb459005508c8d3e23455a0f982260c642d514b45e241c2dd76f
- continuation-build-mcp2.log: 5b0e6c8ad1d6fb564a796210424d8934d13fe744e1efcbcdd825a7a7097c0d73
- continuation-mcp2-24.log: 555c7099d8168279f454686b9dfe977bba563ba11ec96b6901ff60d5f4e0cace
- continuation-build-fixture.log: f90d54c71f91afe47757d5cf9ee290689027f5f2db2c8973d117561443bc91e9
No new archive bundle was written after the denial. Initial frozen evidence archive and reports remain unchanged.

## Remaining work and preserved limits
Finish and validate fixture/driver readiness, add observation-store load and actual lock-holder helper, complete cold CLI and remaining precision controls, demonstrate meaningful negative controls, rerun exact final safe checks on both runtimes, then schedule complete isolated qualification separately. Full default driver must preserve the prescribed populations and distinguish operational numerical qualification, forced-control semantics, inclusive numerical status and completeness. No unqualified all-samples performance pass.

Historical natural overruns and incomplete comparators remain failures/incomplete evidence. npm test/test:mjs aggregate stages invoking the denied AF_UNIX listener and PTRACE_TRACEME remain blocked/unrun. No assistant local tests, capability promotion or invented hook clock correlation. Owner-run local evidence retains its original status and is not silently applied to this changed tree. Fresh Oracle acceptance and actual merged-tree green gates remain outstanding.