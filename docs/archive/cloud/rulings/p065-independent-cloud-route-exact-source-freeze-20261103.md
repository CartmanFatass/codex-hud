# P065: independent cloud route and exact-source freeze

Date: 2026-11-03, approximately 23:04 UTC. Fresh Oracle, read-only assessment plus this requested report. No build, test, fixture, benchmark, old-session poll, process probe, repository mutation, archive, dependency operation or publication was performed.

## Disposition

**The independently authorized fresh Codex cloud route is established by the available platform evidence. It is not necessary to prove that the old executor is dead, to obtain a different physical host, or to show that the fresh container has no preloaded artifacts. The remaining actionable prerequisites are a separately scheduled preservation/source-materialization step, a verified immutable final source snapshot in that container, and an explicit new bounded compile-only assignment. Do not compile before those prerequisites are met.**

Keep old session 87162, its compiler result and authoritative owned-descendant termination **UNKNOWN**. The route does not clear the old shared executor for controlled workloads, restore its old lease, cure an access restriction or authorize another recovery poll. P065 stays **WIP / NOT ACCEPTED / NOT MERGEABLE / NOT PERFORMANCE-QUALIFIED**.

## 1. Evidence and the independence question

The interrupted-build ruling §4.1 expressly offers two alternatives: authoritative old-session/workload termination, **or** a separately sanctioned genuinely independent executor explicitly authorized for distinct validation, without evading an access/security restriction. STATE repeats that alternative. Requiring proof of old termination in addition to a genuinely independent executor would remove an option the ruling explicitly preserves.

The dispatcher supplied the following successful provisioning record:

- `cloud_threads.create` used `environmentConfigId=57fcdbcf-8b1a-4c7a-82ab-dcabde6338c4~asenvcfg_17be0ed28b6081919c4be4c9b4bb3619`.
- `computerRef` and `cwd` were omitted. This was not a new task on a selected existing computer.
- Returned `threadId=01a1a3a1-e613-751f-b551-32dd923650f9`, `turnId=01a1a3a1-f4ac-75a7-beb5-3e74f5ef1bfa`, `admissionOutcome=started`.
- Model `gpt-6.1-terra`, thinking `high` were requested. This establishes the request; the child reports that its environment status interface cannot independently verify the effective model or reasoning setting.

The current tool contract explicitly says that this selector provisions a **fresh cloud container using the saved configuration's repositories and setup**. That is platform/control-plane evidence about the execution environment, not an inference from a shell process name or working directory.

I independently read the completed child turn and its initial task message. The child reports provider `cloud`, status `running`, and environment ID `ccarenv_b64_Y2NhcmVudl8wYmNlMDczN2Y0ZjQ4MTkxODFmNmZlNDQ1ZjZkNmE1OA`. Its boot ID was `8c50be47-9d44-4041-a470-726145dea915`, with uptime approximately 54 seconds. The dispatcher identifies this environment as distinct from the old shared executor. The old `/workspace/shared/p065-budget` and evidence directories were absent in the child.

The successful fresh-container provisioning contract and the child's cloud environment identity are sufficient **operational isolation evidence for this bounded compile-only route**, absent contradictory evidence of a live shared writable workspace, shared owned-process lifecycle or an explicit tool/provider warning that the existing executor was reused. No such contradiction is supplied. Preserve the creation result and environment identity with the new run's record; the fact that the creation record was supplied by the dispatcher rather than independently fetched by this Oracle is explicit here.

The child's initial caution was appropriate because its prompt made execution conditional on verified source and independence. However:

- Existing `dist`, `dist-test` and `node_modules` can be provisioned repository/setup content. Their presence does not establish that an old compiler is running in this container, or that the directories are a live shared writable mount from the old executor.
- An old checkout HEAD establishes source freshness trouble, not executor identity trouble.
- Uptime and a boot ID alone would be insufficient. Here they are only corroboration, not the primary premise.
- The ruling does not require different physical hardware. This conclusion is not a claim of performance isolation, dedicated CPUs, kernel independence or fresh caches. No performance experiment is admitted.
- If a supported environment record or ordinary filesystem metadata later affirmatively indicates a shared live writable target, stop and resolve that specific conflict read-only. Do not use probe workloads, sentinel writes, process kills, security changes or repeated old-session polls to manufacture proof.

The child was explicitly authorized for Codex cloud by the owner. Its initial task includes the following exact supplied conversation evidence:

<transcript_evidence>
用户：“允许使用codex cloud会话 使用terra high完成独立环境的测试 dots似乎安全策略较为严格”
用户：“已经published”
</transcript_evidence>

This authorization admits a genuinely independent testing route subject to the existing ruling, not a bypass of any action-time restriction. The old denial concerned the combined append/format/build operation and its recovery poll. A newly scheduled compiler-only invocation on a separately frozen source, with declared output writes and normal tool review, is the distinct operation contemplated by §4. It must not replay that source-writing wrapper or exercise the denied AF_UNIX/ptrace facilities.

## 2. The correct source is available, but not yet immutable in the child

The child reports:

- Mounted checkout HEAD `910848271df1807a2c72da6387e8003bed6b0639`, tree `23859661d590e910a198beb3a92bfdde3573d6c1`.
- Fetched `universal-hud` head `ca92725daef91ca6412c1dd48c51b1374987f106`, tree `2ee2f9f3f8e089172d5d5d3b5592520f897c5619`.
- Published `dots/p065-budget` head `1be8d3e5d8656e19c94d1b1083404f9b48660b1e`, tree `3f5d25d8b9db8755696c4d99f69224db1d577ba5`.
- The published P065 source remains candidate 2, originally `346b3d6300a2e3f340f22e832c459371c19e2646`, tree `613c6bb048dc6b8616617b2d061232807102e9cb`. The later branch commits add three handoff documents rather than the final continuation source.

That published candidate is not a permissible substitute for final-fixture validation. Its fixture SHA-256 is `20bd07f097e7d8965b4f0c597672d0975f5dabf2d05b14e94f874803e6073439`.

I independently read and hashed the surviving final files at `/workspace/shared/p065-budget`. The worktree HEAD is base `26f6fba36948e6c96e2e109cb374c0d4dbb9ab22`, base tree `03bd36610d46fd220eb9c0e4fbf153a52bc3c3b9`; that HEAD is not a commit of its uncommitted source. The exact current modified/untracked source set is the same thirty paths as the initial manifest, totaling 395,575 bytes. Seven files differ from candidate 2 and the other twenty-three still match. A second read produced the same source fingerprint.

Verified identities:

- Tracked diff SHA-256: `84263cb583f243553dfb8062c7001415b309cefc2b9eb18790183026049b4dd2`.
- Wrapper-method changed/untracked source fingerprint: `fcda72ec24ea7a0345eb38cfda02862b61be41ab9ba113df071df9709b71c08f`. Method: sorted `git ls-files -m -o --exclude-standard -- src packages tests`, SHA-256 each file using the ordinary `sha256sum` line representation, then SHA-256 that list.
- Published continuation report's explicit thirty-path aggregate: `174f7fa30e934574ebcd615cda4b475a4c7b82c77964e9b6e0ad9cd333d2ae84`. The dispatcher reports a separate inspector verified this aggregate. Method: initial manifest order, concatenate `path + NUL + decimal byte length + NUL + lowercase SHA-256 + LF` as UTF-8. Do not confuse it with the wrapper fingerprint or a Git tree ID.
- Final fixture: 13,038 bytes, SHA-256 `0e8f076fb2fe0ed1f89a31a4ba837b18278f917808de99e5f2ee6db524b2022f`.

Final changed files, with SHA-256 and byte count:

| Path | Bytes | SHA-256 |
|---|---:|---|
| packages/hud-mcp/src/delegation.ts | 23230 | 7b7289f280b5807f5c733826f2346b0c86a0a670208d86aa2b81f9dbba1a3f12 |
| packages/hud-mcp/src/read-control.ts | 16337 | 144d841c60f08c9981ce5155ed26bbcbeceb95d1ae162057380f56fbf2bde4b7 |
| packages/hud-mcp/src/server.ts | 13128 | df9d8be233acd49b2908f02f754a5395d48f6771373f02ee66b573cd20730e50 |
| src/ledger/call-budget.ts | 6210 | 900589c446cda07cbe92ae3fd524fc126aa7eb8ce11184fa8e9aabe8b6c256fa |
| tests/hud-mcp/p065-budget.test.ts | 30400 | 08a00ee9ae48b22901febee799478f9d8c6c0554d846e1f994d90d4edefad4c2 |
| tests/unit/p065-budget-fixture.ts | 13038 | 0e8f076fb2fe0ed1f89a31a4ba837b18278f917808de99e5f2ee6db524b2022f |
| tests/unit/p065-budget.test.ts | 13889 | aa4c9506c9138bcbe4cdff737e3852eee680e5d4cec38f5911aee5ed72b59332 |

The exact original incomplete log remains present, 590 bytes, SHA-256 `f90d54c71f91afe47757d5cf9ee290689027f5f2db2c8973d117561443bc91e9`. Its compiled-hash sidecar remains absent. Existing emitted fixture JS is 1,753 bytes, SHA-256 `d3f37ef487bf8a90c5cd275b7fd8e0b9ee92874e14f7609a4341346e99f645c4`, matching the previously documented older output. These matches do not prove no other output changed or that the old process terminated.

## 3. Safe preservation and source-freeze path

**Schedule preservation/materialization explicitly before compute.** This read-only ruling and the earlier compute return do not themselves authorize worktree creation, archival or publication. The dispatcher can assign a bounded preservation/source-transfer step under the existing project authority, naming its owner, exact inputs, fresh destinations, expected writes and return point. Keep it separate from the compile assignment, and perform substantive staging/archive processing in the new independent cloud environment. Do not perform a substantial archive/build/install operation on the held shared executor merely by calling it preparation.

Recommended method:

1. Keep the old worktree, old outputs, incomplete log, original wrapper, denial/recovery records and existing archives untouched. Do not append the fixture again, format files, reset/clean the old worktree, delete generated output, reinstall there, or use the old wrapper. The full old source files and relevant evidence can be obtained by authorized read-only byte retrieval. No old-session operation is needed.
2. Transfer the exact final source bytes as a new immutable artifact through an already authorized path. Prefer a full thirty-file overlay plus its manifest over manually reconstructing the seven edits. An initial candidate-2 commit plus the seven exact final files is also sufficient if the receiver verifies all thirty paths afterward. The incomplete original log, wrapper and denial/recovery record should be preserved as historical evidence with their hashes; preserve old generated artifacts in place and capture copies without overwriting them. Do not claim a captured partial-output snapshot is an atomic 21:14 image if that cannot be established.
3. Materialize a fresh dedicated validation checkout in the independent cloud container from the pinned base or the pinned published candidate-2 descendant. Preserve the descendant's handoff documents if using it. Apply only the exact frozen source overlay and record every resulting path/hash/mode plus unchanged build/config inputs. Never pull in other unaccepted package code or silently rebase onto today's `universal-hud`.
4. Verify the source after transfer against the thirty-file manifest and both explicit fingerprint methods. Compare source fingerprints before and after retrieval/materialization; stop on any mismatch or unexpected changed/untracked source. This catches transfer/mutation issues; it is not a process-liveness test. Capture a deterministic archive digest or a newly recorded immutable Git commit/tree. Report both the source manifest and full-tree identity when handoff documents differ from the original base.
5. Preserve `package.json`, root `package-lock.json`, `tsconfig.json`, `tsconfig.test.json`, relevant included configuration, runtime/compiler identities and dependency provenance. Do not stage or transfer the dirt in `node_modules/.package-lock.json` as source. Do not include secrets, real home directories, unrelated environment files, `.git` credentials or unrelated user data in the artifact.
6. Keep historical generated outputs/evidence separate from new compiler output. A new clean dedicated checkout can use the unchanged standard relative `dist-test` output location without overwriting the old executor's artifacts. If using a different `--outDir`, declare the exact change in the assignment and report it as distinct compile evidence, not silently as the required standard-build gate.
7. The receiving cloud executor must verify that transferred bytes actually exist locally and match the supplied digest; a path on the old executor or a published textual report is not materialization. Do not tell it that an old executor path is usable there.
8. Source publication, if chosen, must stay within already authorized repository/branch scope and preserve branch descendants using a normal non-force update. Repository STATE says `CartmanFatass/codex-hud` is public; a rule authorizing uploads to private research destinations is not blanket permission to publish unrelated/private artifacts here. Use only synthetic project evidence and the applicable project publication authority. This assessment performs no publication and grants none beyond that existing authority.

The entire thirty-file source overlay is under 400 KiB. There is no need to run the compiler, execute a fixture, restore a terminal session, compress the whole dependency tree or repair the old checkout to obtain it. Keep a full manifest, not just `git diff`: five relevant source/test files are untracked in the base worktree and a tracked diff alone omits them.

## 4. Exact new compile-only admission conditions

After preservation and receiver-side verification, the dispatcher must record a **new** bounded assignment. Its record should include:

- Purpose: compile the final frozen P065 continuation as a new candidate validation, not finish/recover/retry the old mixed source-edit operation.
- Executor: cloud thread `01a1a3a1-e613-751f-b551-32dd923650f9` and the exact cloud environment ID above, with the saved-config provisioning record.
- Owner: that named cloud task; one controlled command at a time there.
- Source: the newly verified immutable commit/tree or archive digest and the thirty-file continuation aggregate, plus the exact dedicated checkout path.
- Runtime/profile: actual resolved Node binary and exact version, and TypeScript compiler package version/hash. The old record used Node `v24.22.1` and TypeScript `5.9.3`; do not assume the new container matches. A different supported runtime is separate evidence and must be declared before execution. No dependency install is implicit in a compile-only window.
- Command: exactly one bounded compiler invocation equivalent to the inspected `build:test` script, `node ./node_modules/typescript/bin/tsc -p tsconfig.test.json`, from the named checkout, with a declared runtime. The dispatcher can choose `npm run build:test` after checking current scripts/lifecycle hooks, or use the explicit compiler command and label it accurately. No `node --test`, fixture/driver execution, `build:hud-mcp`, aggregate, performance population, readiness probe, source append or formatter is included.
- Writes: the new checkout's declared generated output (`dist-test` with current config), new unique raw log/metadata files, and declared temporary directories only. Source/config must remain byte-identical. No old-output overwrite or old-log reuse.
- Timeout: a declared 180-second compiler cap with TERM and a 10-second kill-after, or another explicitly justified bounded cap chosen by the dispatcher before starting. A declared timeout is a control, not proof it actually fired.
- Evidence: unique run identity, command, source and dependency/config identities, UTC start/end, raw stdout/stderr, terminal exit status, generated-file inventory and final source recheck.
- Return point: terminal result and owned-process cleanup, or exact blocker. If session outcome or cleanup becomes uncertain, retain UNKNOWN and stop; do not infer cleanup from time passing or repeat on another route. A failure is recorded, not an automatic fix/retry allowance.

Inspect dependency/compiler metadata read-only before admission. Existing installed dependencies are usable only with recorded provenance/version sufficient for this build. If missing or inconsistent, stop for a separately scoped dependency-preparation decision; do not hide `npm ci` inside this compile-only command. The old wrapper must not be reused because it targets the old evidence directory and carries the interrupted operation's context.

Relevant currently read configuration identities:

| Input | SHA-256 |
|---|---|
| package.json | e829a2a4c0ad639d37f9e94ed93a67e87eb6c8b8f758cfbb8a4f27f0fe66ec9b |
| package-lock.json | 98a7e2d3f5256810fe477812be64b35411aeede8b34f91e648d62e96c39e3294 |
| tsconfig.json | 25bb17e17ea109ef835738bc5481a8e79b3169dd003dd3c73c3f860724e653e8 |
| tsconfig.test.json | 46f2efa76899b906759eae43e154b7a6d987330f9ba939bb629456910e17bde6 |
| packages/hud-mcp/tsconfig.json | 776f5464e306374c24d658416402fa3990d78ac5dfbf392042d6cc711714b485 |
| node_modules/typescript/package.json | 822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6 |
| node_modules/typescript/bin/tsc | 8d5fa5bd883fec0979fc2004f1fe1d99aef40570155d550eadc0b03b55513bf0 |
| node_modules/typescript/lib/_tsc.js | e8f349eabd48486bdb2bf9dc1a00c89d58297270c54b745838879e2859194419 |

`tsconfig.test.json` includes `src/**/*`, `tests/unit/**/*`, `tests/fixtures/**/*`, sets `rootDir` to `.`, `outDir` to `./dist-test`, source maps inherited, declaration/declarationMap disabled, and `noEmitOnError=true`. It does not establish MCP compilation or test execution. Root lockfile declares TypeScript 5.9.3 with its registry integrity value. Those facts were read, not executed.

Normal tool review remains binding. If the new exact operation is denied, stop that operation and report the exact missing action/target approval; do not switch shells, tools, hosts, paths or labels to evade it. Do not smuggle authorization evidence into executable arguments. The existing broad queue authority and the explicit Codex cloud request make another generic owner approval unnecessary merely to schedule this properly scoped distinct run. They cannot waive action-time safety requirements or supply a missing historical fact.

## 5. Interpretation after the new result

A new successful compile establishes only that the named source compiled under that declared command/runtime/configuration. It does not establish that the fixture behaves correctly, fill the missing driver/lock-holder work, validate Node 22 unless that was the chosen profile, satisfy full checks, exercise blocked facilities, count as qualification, permit a merge, or make session 87162 green.

The final-fixture source must not inherit the earlier 43-unit/28-MCP successes. Keep the historical failed, blocked, unrun, interrupted and superseded stages in the evidence inventory. Keep assistant-run local testing withdrawn, the AF_UNIX/PTRACE restrictions unchanged, file ownership intact and consumed review/fix limits unchanged.

## Sources and method

Repository sources read through the authorized GitHub connector:

- [Interrupted build ruling](https://github.com/CartmanFatass/codex-hud/blob/ca92725daef91ca6412c1dd48c51b1374987f106/docs/cloud/rulings/p065-interrupted-build.md), fetched on `universal-hud`, blob `e63f962f9fd44d2ca1342e6113a644d4d64f4621`.
- [STATE](https://github.com/CartmanFatass/codex-hud/blob/ca92725daef91ca6412c1dd48c51b1374987f106/docs/handoff/STATE.md), blob `23e88a175620bcf5071db2f219a1206610e3205e`.
- [Bounded resource-window ruling](https://github.com/CartmanFatass/codex-hud/blob/ca92725daef91ca6412c1dd48c51b1374987f106/docs/cloud/rulings/wave1-resource-windows-20261103.md), blob `20bded878c6b77601634fde1c223dd0f378b6ba2`.
- [Continuation-1 report](https://github.com/CartmanFatass/codex-hud/blob/1be8d3e5d8656e19c94d1b1083404f9b48660b1e/docs/cloud/handoff/p065-budget/continuation-1.md), blob `2ce07a2a02d927d782e64cf41922cd12a4777cb2`.

Additional evidence: the current fresh-container provisioning tool contract; exact create parameters/result supplied by the dispatcher; cloud child recorded initial prompt and completed report; read-only local `AGENTS.md`, initial source manifest/publication result, continuation session addendum, incomplete log, wrapper, source/config/compiler bytes and Git identities. Two modest source hashing passes agreed. The parent separately supplied its source inspector's matching continuation aggregate. No old session status was polled. Only this explicitly requested report was written.
