# MCP-ANCESTOR: optional ancestor access and wave-1 gate ruling

Date: 2026-11-03.

## Decision and disposition

The persistent optional-ancestor EACCES is a pre-existing P2 registration-availability defect. It is not an intended requirement to prove the environment of every unrelated ancestor before recording a physical CallerId. The correct fail-closed boundary is: retain strict mandatory physical evidence, but stop optional harness discovery at the first access-denied ancestor and retain no usable harness/source evidence from that search. Never skip the denied process to find a more convenient ancestor.

Approve the bounded MCP-ANCESTOR brief as a wave-1 shared verification-prerequisite repair. This does not expand HYG2 or RUNZ1, reopen accepted code, reset another package's fix rounds, or release a later wave.

**Design/scope: released. Execution: HOLD pending resource admission.** NEXT retains its current explicit executor lease. After NEXT returns it, the dispatcher assigns bounded, non-overlapping mutation/compute and measurement windows to separately released P065 and MCP-ANCESTOR work, with explicit release or rescheduling between windows. P065 reserves its source/branch ownership, not an uninterrupted executor monopoly until acceptance. MCP-ANCESTOR need not wait for P065 acceptance, and neither package may import the other's unaccepted code. Do not infer a free lease from silence, a tool timeout, or disjoint files. No overlapping builds, tests, benchmarks or diagnostic loads. A genuinely independent authorized executor may be used only under an explicitly recorded schedule. Read-only review and documentary recording can proceed now.

**Acceptance and merge: HOLD.** This ruling is not an accept verdict. No package check, supported profile, security predicate or merged-tree gate is waived.

## Inspected evidence and identities

The integration snapshot inspected is universal-hud at 26f6fba36948e6c96e2e109cb374c0d4dbb9ab22. Read AGENTS.md, STATE, dots.md, the cloud README, the engineering-plan complete-brief requirements, architecture §8, contract 01 physical/logical identity and current-source rules, the P065 metadata exception and ownership brief, the NEXT brief, the registration/resolver implementation and its tests.

Owner evidence is local-verification/20261103 at 9be7246c25b5355845e639116c57150ff79d3117. REPORT.md states that all three package README check sets are not green. It records the same physical-registration failure on all nine branch/environment combinations. The HYG2 no-envproxy raw log directly establishes EACCES on /proc/29952/environ through readBounded → LinuxProcessReader.get → findHarness → registerCaller. The local HYG2 Oracle independently identified the same failure and kept the gate open.

The report attributes that PID to a root-owned WSL Relay ancestor after detached drivers were reparented. The reviewed failure log contains no contemporaneous UID/ancestry snapshot proving that attribution. Preserve it as the owner's recorded explanation, not independently reconstructed machine state. The code path and red gate are established without that extra attribution.

Independently fetched universal-hud and f1e2a84 blobs are identical for:

- packages/hud-mcp/src/process.ts: d5407bbb9f819cc4f943f538b511d9f4a273f483.
- packages/hud-mcp/src/registry.ts: d0d92ecc5c5efefb19edf2759d8f4eb7a106e8a9.
- packages/hud-mcp/src/ledger-registry.ts: 6b77a03fb63ea67614858d9d2b3cc0ec01cf04a7.
- packages/hud-mcp/src/resolvers.ts: bee07f0ca1cb1fe8b0d704b7bcd2571b909282c1.
- tests/hud-mcp/int-ledger-registry.test.ts: 0d2300630a1a9cfaa65525302ef9913c792e4501.

This is not a regression introduced by HYG2, RUNZ1 or the rendering optimization.

## Contract classification

Contract 01's CallerId row separates physical registration from logical authority: the physical MCP PID/start, actual parent PID/start, physical cwd and timestamps are required evidence; harness/source are hints. The contract permits the actual parent to be a daemon and does not turn CallerId, ancestry, cwd or environment hints into a SessionRef or permission. Unknown source cannot authorize a context, proc OwnerKey fallback, claim, alias, report or operation. T-01-6 and I-01-2/10/12 retain their existing meaning.

Today LinuxProcessReader.get reads stat, cmdline, environ and PID namespace before returning. findHarness calls it for up to eight ancestors and propagates its access error. Consequently a denied optional observation aborts otherwise verified physical registration, including the integration test with profile:null. Linux process-file access controls are real security boundaries; the program should respect the denial rather than require broader access. [Linux proc documentation](https://origin.kernel.org/doc/html/latest/filesystems/proc.html).

Mandatory self/actual-parent/domain/cwd evidence remains strict. This narrow release deliberately does not split ProcessReaderPort.get into physical and optional interfaces. A denied mandatory get still refuses registration with no write. That preserves the current defensive boundary and avoids silently changing every identity consumer. If a future direct-parent case needs a different minimal physical-read contract, it needs a separately bounded design, not an extension hidden in this patch.

## Selected mechanism and rejected alternatives

Change only findHarness's optional reader.get step: recognize OS errno EACCES or EPERM, return null immediately, and read no higher ancestor. Here null means no usable discovery evidence, including unavailable evidence; it is not proof that no harness exists. All other errors, identity-change Refusals and malformed evidence retain their existing behavior. Do not match English error text.

Keep LinuxProcessReader.get, ProcessReaderPort, inferHarness, actualSourceRoot, byte limits, eight-ancestor limit, strict registration rechecks and resolver API unchanged. No empty environment or substituted HOME is fabricated. A readable genuine harness still uses the existing positive path. If a genuine harness becomes inaccessible, registration has no source proof or a subsequent call refuses; no remembered identity rescues it.

Rejected for this repair:

- Catching every error around registerCaller or making get globally best-effort.
- Continuing past an unreadable ancestor, selecting a farther harness, or inferring identity from the test runner, configured root, MCP environment or executable name alone.
- Skipping discovery only when profile is null as a test-specific workaround.
- Reparenting tests, increasing ancestry depth to hide the host layout, skipping the failure, or adding EACCES to known flakes.
- sudo, capabilities, ptrace, procfs/security-setting changes, chmod/chown of process files, or another route around denied access.
- A metadata/environment reader redesign in this package. It could avoid unnecessary environment reads, but is not needed for this correction and would expand the interface, consumer and proof surface.

## Ownership and separate issues

MCP-ANCESTOR reserves only process.ts's bounded findHarness change; new tests/hud-mcp/ancestor-discovery.test.ts; additive cases in skeleton.test.ts and int-ledger-registry.test.ts; and its own brief/evidence. The scheduling Oracle confirmed these four source/test paths are disjoint from P065's 20 production plus 23 test/fixture reservations and NEXT's four paths. P065 owns resolvers.ts; this repair must not edit it. HYG2 owns its SQLite warning and process-helper work; RUNZ1 owns run/process and its named tests. STATE and plan remain one serialized dispatcher writer.

LedgerCallerRegistry.verify still performs process-content reads inside the writer transaction. The P065 metadata exception expressly excludes those reads. This separate startup-writer compliance issue remains unresolved. Do not move or delete those checks, edit ledger-registry.ts, or claim global lock-I/O compliance because the ancestor test turns green.

## Node 22 envproxy remains separate and open

The preserved Node 22.23.4 NODE_USE_ENV_PROXY=1 matrix shows UNDICI-EHPA warnings on child stderr and exact-output assertion failures. The HYG2 focused log records 65 pass / 11 fail; the no-envproxy run records 76/76. These are different configurations, not a failed run followed by the same test passing unchanged. The warning is not the SQLite initialization warning targeted by HYG2.

Node documents NODE_USE_ENV_PROXY as an opt-in startup proxy behavior. That supports treating the environment setting explicitly; it does not by itself decide this project's quiet-output promise or its required network policy. [Node CLI documentation](https://nodejs.org/api/cli.html#node_use_env_proxy1).

Do not broaden HYG2 suppression, use global no-warnings flags, strip raw stderr, loosen byte assertions, silently remove the variable, change the user's proxy settings, or declare the failing matrix passed. The owner-selected no-envproxy run is valid additional evidence and must remain labeled. No supported-profile change is made here.

Release a separate read-only compatibility consultation on the exact question: which proxy-enabled Node 22 launch configuration the project promises to support, and what bounded remedy preserves required proxy routing and unrelated warnings while satisfying the output contract. It must return a recorded profile/implementation disposition before these failures can be closed. It may run while the executor is leased because it performs no code or test work. No ordinary approval question needs to be returned to the owner merely to commission that consultation under the existing Oracle decision delegation.

## Gates and queue

The new brief requires meaningful failing-before tests, unchanged genuine-harness negative controls, the existing real registration integration, and a root-owned/unreadable-ancestor reproduction on an already permitted capable host. Synthetic errno tests prove the boundary but do not prove a real root-owned topology was exercised. The owner controls local testing; this ruling does not restart assistant-run local sessions.

All README checks must be green on the exact candidate under the recorded intended configuration. Missing or denied stages remain incomplete. The persistent registration failure and envproxy output incompatibility are not known flakes. RUNZ1's separate Node 24 cancellation-ladder failure stays with its assigned review; this package does not classify or waive it. Previously measured performance failures remain recorded.

A fresh Oracle must verify and accept the completed MCP-ANCESTOR package. Only then can the sole merger perform the prescribed --no-ff integration and establish a complete green check set on the actual merged tree before pushing. If another unresolved baseline issue prevents a standalone green package or integrated result, keep the result blocked and obtain a separate integration disposition; do not merge unaccepted branches merely to manufacture a passing dependency tree.

HYG2, RUNZ1 and B10B acceptance remain open until their own reviewers verify the relevant final code/evidence. DOC2 and TPD1 still wait for B10B-S3F's actual accepted merge; later Inspector/data/B10D work keeps its queue order. Cloud work continues through the already released NEXT/P065 work, read-only compatibility review, and this queued bounded prerequisite repair.

## Sources

- [Owner report](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/REPORT.md).
- [Raw registration failure](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/logs/hyg2/node22-noenvproxy/07-test-hud-mcp.log#L365-L382).
- [Raw Node 22 envproxy failures](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/logs/hyg2/node22/11-focused-hyg2.log).
- [Physical and logical identity](https://github.com/CartmanFatass/codex-hud/blob/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22/docs/contracts/01-identity.md#L29-L78).
- [Ancestor discovery](https://github.com/CartmanFatass/codex-hud/blob/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22/packages/hud-mcp/src/process.ts#L20-L81).
- [Current registration boundary](https://github.com/CartmanFatass/codex-hud/blob/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22/packages/hud-mcp/src/registry.ts#L68-L124).
- [P065 ownership and separate registry issue](https://github.com/CartmanFatass/codex-hud/blob/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22/docs/cloud/P065-BUDGET.md).
- [Queue](https://github.com/CartmanFatass/codex-hud/blob/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22/docs/handoff/STATE.md).

Method: read-only repository/source/log inspection and primary documentation lookup. No repository mutations, builds, tests, probes, privilege changes, or subagents.