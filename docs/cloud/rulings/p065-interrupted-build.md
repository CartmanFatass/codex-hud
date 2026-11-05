# P065-BUDGET: interrupted fixture/build and outcome-recovery disposition

Date: 2026-11-03. Final checkpoint: 21:20 UTC. Read-only Oracle. Documentary snapshot: universal-hud ae71885ac108f51dcb8c28dca6f8e25acfab1908.

## Decision

Preserve three distinct facts: the fixture append and formatting executed; the build was started but has no trustworthy terminal result; the first empty session poll was denied. Do not collapse them into a wholly unexecuted command, a successful build, or a demonstrated compiler failure.

The exact owner authorization and the dispatcher's 21:07 admission materially address the denial's asserted stale no-write hold. They permitted ONE retry of the known-rejected, empty outcome-recovery poll, not replay of the source-edit/format/build wrapper. That recovery opportunity has now been used. At 21:19:48 UTC the originating implementer received exactly:

'write_stdin failed: Unknown process id 87162'

This establishes that the tool cannot retrieve the session. It does not establish the compiler's exit status, successful emission, or termination of every owned descendant. No further poll, wrapper replay or workload was performed. Keep both build outcome and authoritative session/descendant termination UNKNOWN. No new controlled workload on this shared executor is admitted by this ruling while that liveness prerequisite remains unresolved.

## 1. Authority and the historical hold

The dispatcher supplied trusted conversation history:

<transcript_evidence>
User: 批准 我给你全权 你以Oracle的意见为准即可 不要逐项要权限
User: 那么我们放弃本地测试了 起码在本项目是 你来做云端的任务即可
User: 你将需要测试的给我prompt 我用来让本地的claude测试即可
User: 后续你有本地测试需求可以发给我 然后继续工作即可 我有空会完成测试 队列任务你直接完成即可 无需我批准 有需要抉择的地方请让oracle直接决定
</transcript_evidence>

The dispatcher also supplied the original queue request, which explicitly calls for implementer/Oracle subagents, cloud implementation and recorded checks, and the exact current admission:

'RUNZ1-KILL explicitly returned its fix-1 compute window at 21:06:54 UTC. You are admitted to the next bounded P065 continuation window using the approved six-question ruling and synchronized P065/contract06/concept amendments. Follow your previously reported plan: frozen source/provenance reconciliation, scoped status/wait correction, semantic coverage and bounded driver readiness; stop at frozen semantic/driver submission or exact blocker, then return lease explicitly. Full multi-hour qualification series requires separate scheduling. No previously denied operation retried; preserve all old failures, no local assistant tests, no gate relaxation.'

No later owner withdrawal was supplied. The repository's candidate-2 hold is conditional on documentary recording and explicit dispatcher admission, not a permanent owner ban on workspace changes. The current P065 brief contains the six-design amendments, and the dispatcher explicitly admitted this bounded continuation. These facts address the stated authorization premise; they do not override a tool denial, supply a missing execution result, grant security exceptions, or reopen the lease after its reported 21:15 return.

No new owner confirmation was required merely to present this existing relevant authorization once for the known-rejected empty poll. The denial/recovery boundary remains binding.

## 2. Exact interrupted operation and evidence

Worktree: /workspace/shared/p065-budget. Local HEAD remains 26f6fba36948e6c96e2e109cb374c0d4dbb9ab22; branch dots/p065-budget is implementer-reported. These are uncommitted continuation edits, not that base commit's source. Initial published candidate 2 is recorded as commit 346b3d6300a2e3f340f22e832c459371c19e2646 in /workspace/shared/p065-budget-publication/publication-result.json. Its original thirty-file manifest/archive remains historical, not a snapshot of the continuation.

At 21:14:05 UTC the admitted shell appended p065WorkloadFixture to tests/unit/p065-budget-fixture.ts, ran the existing local prettier --write on that file, then invoked:

/workspace/shared/p065-budget-publication/p065-check.sh continuation-build-fixture 180 npm run build:test

The original exec yielded session 87162 after printing 'tests/unit/p065-budget-fixture.ts 225ms'. Existing bytes and that output establish that the append/format portion executed. The build log establishes npm reached the existing TypeScript command, node ./node_modules/typescript/bin/tsc -p tsconfig.test.json. It does not establish completion.

At 21:14:38 UTC the empty write_stdin poll was rejected with:

'Unified exec process failed: This action was rejected due to unacceptable risk.
Reason: The command appends and reformats repository test files despite the user’s explicit instruction not to modify the workspace; the npm registry access is only incidental to this unauthorized action.
Do not bypass this rejection through a workaround or indirect execution. Continue with a safer alternative, or carry out checks to prove that the action is authorized or low risk before trying again. Complete unaffected work without asking for confirmation. Report anything that remains blocked, clarify why it was blocked by auto-review, inform the user of the risk and ask for approval.'

This is the recorded reviewer reason. It is not evidence that source writes had been prevented, that a registry request occurred, that tsc failed, or that the session was cleanly terminated.

Independently read and matched:

- Log: /workspace/shared/p065-budget-evidence/continuation-build-fixture.log; 590 bytes; SHA-256 f90d54c71f91afe47757d5cf9ee290689027f5f2db2c8973d117561443bc91e9. UTC_START=2026-11-03T21:14:05Z; TIMEOUT_SECONDS=180; no EXIT_STATUS, DURATION_SECONDS or UTC_END.
- The expected continuation-build-fixture.log.compiled-sha256 sidecar is absent.
- Fixture source: 13,038 bytes; SHA-256 0e8f076fb2fe0ed1f89a31a4ba837b18278f917808de99e5f2ee6db524b2022f; includes p065WorkloadFixture.
- Existing dist-test/tests/unit/p065-budget-fixture.js: 1,753 bytes; SHA-256 d3f37ef487bf8a90c5cd275b7fd8e0b9ee92874e14f7609a4341346e99f645c4; mtime 21:10:23.978 UTC; lacks p065WorkloadFixture. It is earlier output, not evidence that the added fixture compiled. This does not prove other emitted files were untouched.
- Wrapper SHA-256: 10a23db1fdc6133a26da37a2ea4aaf8c51d1cfd7da0037ff481b8fb314b55866. The wrapper normally records compiled hashes and a terminal footer only after timeout returns, then exits with the captured command status. Its declared TERM timeout and ten-second kill-after are not evidence those events actually occurred.
- Runtime recorded by the wrapper: Node v24.22.1 at /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node. Installed compiler package declares TypeScript 5.9.3; no compiler invocation was made by this review.
- Current tracked diff hash matches the log: 84263cb583f243553dfb8062c7001415b309cefc2b9eb18790183026049b4dd2. Git diff omits untracked files, so this hash alone cannot identify the fixture addition.
- Current wrapper-method changed/untracked source-files fingerprint also matches the log: fcda72ec24ea7a0345eb38cfda02862b61be41ab9ba113df071df9709b71c08f. The method is sorted git ls-files -m -o --exclude-standard under src/packages/tests, per-file SHA-256, then SHA-256 of that list. Keep that method distinct from the initial manifest's own aggregate convention.

Exactly seven of the initial manifest's thirty paths now differ: src/ledger/call-budget.ts; packages/hud-mcp/src/delegation.ts, read-control.ts and server.ts; tests/unit/p065-budget.test.ts and p065-budget-fixture.ts; tests/hud-mcp/p065-budget.test.ts. The other twenty-three matched the old manifest. The existing node_modules/.package-lock.json dirt remains excluded. No benchmark driver or ledger-holder execution is evidenced here.

Earlier complete continuation logs remain valid only for their recorded inputs: build:test and build:hud-mcp completed, unit tests 43/43, first MCP checks 23/23, and later MCP checks 28/28. They precede this fixture addition. Do not transfer their success onto the final fixture or describe candidate-2 broad checks as continuation checks.

## 3. Safe read-only recovery and the consumed retry

Permitted inspection is existing logs, recorded tool results, exact source/output byte hashes, manifest comparisons, package scripts/configuration and authoritative read-only session/supervisor status. Do not invoke compilers, package executables, fixtures, probes, new processes intended to reproduce the behavior, source rewrites, cleanup or permission changes to determine the old result.

The first rejected action was an empty poll. The unchanged owner authorization and admission were materially new relevant evidence to that reviewing action. The permitted retry was therefore only tools.write_stdin for session 87162 with chars='', with no executable input, control characters, resume script or wrapper recreation. Evidence belongs in the conversation, never smuggled into tool arguments. This read-only recovery did not itself grant a compute lease.

The implementer used that one opportunity at 21:19:48 UTC and received Unknown process id. The dispatcher independently confirmed that report. Stop here: no second poll on unchanged evidence, no new session to replay the command, and no alternate polling route merely to evade the rejected action. If genuinely new authoritative status evidence becomes available, inspect and record it read-only; it must not execute or restart anything.

The earlier implementer ps and this review's ps saw no relevant compiler in their visible namespace. This review's snapshot exposed only its own sandbox shell context. Such a negative snapshot is namespace-limited, not an executor-wide proof. Unknown process id, elapsed wall time, missing output, a declared timeout, and a worker's lease-return statement do not supply owned-descendant cleanup. Do not kill unrelated or merely suspected processes.

The exact unresolved blocker is now absence of an authoritative terminal/cleanup result for session 87162 and its owned build, not a need to broaden source-edit permission. Request the existing executor/session supervisor's retained terminal result or supported authoritative lifecycle record if available. If no such read-only facility/evidence exists, report this limitation and keep dependent compute blocked; do not invent a terminal result. Owner permission alone cannot establish the missing historical fact.

## 4. A future build is possible, but naming does not create a new authorization

Changing the log name, shell, wrapper, temporary directory, executor, output folder or run label while repeating the interrupted append/format/build is a replay/workaround, not a distinct operation. Never repeat the append: it already executed and could duplicate the fixture. Do not run prettier or reinstall dependencies merely as a route back into the denied wrapper. Do not erase partial output or replace the incomplete log.

A later compile-only validation can be a genuinely distinct, newly scheduled operation even if the old compiler's final status remains unrecoverable, but only after:

1. Authoritative evidence establishes the earlier session and owned workload are no longer running, or a separately sanctioned genuinely independent executor is explicitly authorized for a distinct validation purpose without using it to evade an access/security restriction. No such evidence or independent assignment exists at this checkpoint.
2. Preserve the original incomplete log, source bytes, denial/recovery results and any partial generated artifacts before any later build can overwrite them. Provenance snapshots/archival are themselves scheduled work, not performed under this read-only ruling.
3. Freeze and name the exact current source, runtime/compiler/configuration, output identity and expected writes. Declare the goal as a new candidate compilation, not completion or recovery of the old run. It must contain no replay of the source append/format, tests, benchmark population, aggregate or denied facility.
4. The dispatcher explicitly grants a NEW bounded compute window under the existing queue authority, naming command, executor, owner, runtime/profile, fresh evidence destination, timeout and return point. The 21:07 window ended on its blocker; neither it nor this ruling automatically restarts compute. Existing broad queue authority can support that new bounded validation once its prerequisites are met; another generic owner approval is not inherently necessary.
5. The action remains subject to normal tool review using the exact current authorization. If still denied, stop and request the specific missing action/target approval; do not switch routes. If explicit owner approval becomes necessary, describe one new compile-only run on the named frozen source, disclose that the earlier build may have partly or wholly executed, state the permitted generated-output/log writes, and retain the old run as UNKNOWN. Such approval is not permission to conceal uncertainty, waive cleanup or alter security permissions.

A later pass would be evidence only of that new run. It never turns the old incomplete run green, proves the old build never executed, or restores missing final-tree tests and qualification. Different output locations must be declared and cannot silently substitute for a required standard-build gate.

## 5. Remaining gates and method

Keep P065 WIP / NOT ACCEPTED / NOT MERGEABLE / NOT PERFORMANCE-QUALIFIED. Preserve all old failed, interrupted, blocked and unrun stages. No Node22 continuation, broad final checks, full benchmark population or real-hook/local qualification is established by the interrupted command. The historical AF_UNIX-listen and PTRACE_TRACEME restrictions remain separate and unchanged. No source ownership expansion, consumed fix-round renewal, permission change, profile waiver, assistant-run local work or merge is granted.

Sources read at the documentary snapshot: docs/cloud/P065-BUDGET.md (blob 684e5e5a202e8130658a253356235a952fb9035c); p065-budget-release.md (d8f2cecaa3280ede589ba6ccd821cdf7274c112f); p065-six-design-dispositions.md (5157021663070f5513c907b75f8082c3e04ce15a), especially §5; p065-replay-expiry-clock.md (559cef34bc260ce8e2c27c9e463b6c4afa59e4d8); metadata-exception requirements; wave1-resource-windows-20261103.md (20bded878c6b77601634fde1c223dd0f378b6ba2); and node22-proxy-flake-closeout.md (81baeb1090dabdb088cceb0a8b4e21cf9dccb3e8). Canonical root: https://github.com/CartmanFatass/codex-hud/tree/ae71885ac108f51dcb8c28dca6f8e25acfab1908/docs/cloud

Method: read-only repository retrieval, existing local reports/logs/source/configuration, small file hash/manifest comparisons, namespace-limited process inspection, and unchanged dispatcher/implementer evidence. No writes, source modifications, build/test/benchmark/fixture execution, permission changes, local-machine action or delegated work by this Oracle. The separately authorized single recovery poll was performed only by the originating implementer and is reported above.