# P065-BUDGET: independent compile failure and bounded repair disposition

Date: 2026-11-03, approximately 23:19 UTC. Fresh Oracle compile-triage review. Documentary branch observed at `33c0cf6ef6e57c187d8b4e352cd609768073c63b`; source under review is the distinct frozen P065 commit below.

## Decision

**FIX REQUIRED. The new independent compiler invocation failed, with exit status 1 and fifteen reported TypeScript diagnostics. All diagnostics are in `tests/unit/p065-budget-fixture.ts` and reduce to three fixture-local repair groups. Do not label the new compile UNKNOWN or passed, and do not transfer its known failure onto the older interrupted run.**

The bounded next source assignment is to repair the fixture's source identity access, fully populated supervisor-stamp handling, and assertion-function typing, with additive construction/invariant regressions in the already owned P065 unit test file. No production change, build/configuration change, dependency operation, driver expansion, qualification series, or aggregate rerun is justified by these diagnostics.

**Scheduling remains conditional.** The current cloud report establishes the direct compiler's terminal exit and the absence of its original process group. It explicitly does not establish the fate of any escaped descendants. Preserve that narrower new cleanup gap and reconcile it read-only before another controlled workload on that executor. The old shared executor's session 87162 remains a separate unresolved case, with both its outcome and authoritative descendant cleanup UNKNOWN. This ruling is not a compute lease, process-cleanup command, permission to evade a denial, or final P065 acceptance review.

P065 remains **WIP / NOT ACCEPTED / NOT MERGEABLE / NOT PERFORMANCE-QUALIFIED**.

## 1. Evidence accepted and its limits

The cloud task is `01a1a3a1-e613-751f-b551-32dd923650f9`, independent environment `ccarenv_b64_Y2NhcmVudl8wYmNlMDczN2Y0ZjQ4MTkxODFmNmZlNDQ1ZjZkNmE1OA`. Its compile turn was followed by a read-only evidence-return turn `01a1a3ae-bb15-72e6-afc2-7717e5e90640`, now completed. I waited for and read the full exact diagnostics rather than extrapolating from its earlier summary. The full response is message `msg_097067bbada41630016aea6a33e6a487d2bbd6e6ae60478c25`; the raw command metadata and stdout are reproduced unchanged in the appendix.

Reported invocation:

- Working directory: `/workspace/p065-validation`.
- Direct command: `/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node ./node_modules/typescript/bin/tsc -p tsconfig.test.json`.
- Node `v24.22.1`; TypeScript `5.9.3`.
- Start: `2026-11-03T23:10:37.751542+00:00`.
- End: `2026-11-03T23:10:46.294055+00:00`.
- Exit status `1`; timeout `false`. The declared cap was 180 seconds with a ten-second kill-after.
- Compiler PID/process group: `1134` / `1134`.
- Post-return process-group-present value: `false`.
- stderr was empty. Reported generated-file inventory was `[]`.
- stdout SHA-256: `7ab3c9968abcd0854dd28d2130c1b319687c1eefcfce767720231c7d4bcea0ba`.
- Evidence directory: `/workspace/p065-compile-evidence-20261103-01`, including `stdout.log`, `stderr.log`, `invocation.json`, `generated-inventory.json`, and `postcheck.json`.

Exact frozen source:

- Commit: `a2b595ce68a9f295d5147971173ebaa0d874e638`.
- Tree: `1bbf38aa42d0ffc2206da1c246ec1f7c9d62c221`.
- Thirty-file source aggregate: `174f7fa30e934574ebcd615cda4b475a4c7b82c77964e9b6e0ad9cd333d2ae84`.
- Source fingerprint: `fcda72ec24ea7a0345eb38cfda02862b61be41ab9ba113df071df9709b71c08f`.
- Fixture: 13,038 bytes, SHA-256 `0e8f076fb2fe0ed1f89a31a4ba837b18278f917808de99e5f2ee6db524b2022f`, Git blob `934de9fdef95c75a9071c0c65a84a6c87c100765`.

The cloud task reports all thirty source paths and five configuration files still match after compilation, with a clean checkout. I independently read the frozen GitHub source, relevant fixture dependencies/types, build scripts/configuration, and complete tree listing. I also hashed the exact stdout reproduced from the completed response: it matches the reported `7ab3c996...` SHA-256. The documentary file blobs listed below were checked against the complete tree at the pinned documentary commit. I did not independently open the cloud task's filesystem or rerun its checks. The reported empty output inventory is consistent with `noEmitOnError: true`; it is not evidence that every earlier artifact anywhere was absent or untouched.

This was the explicit compiler command, equivalent to the inspected `build:test` script. It was not an `npm test` run, MCP-specific build, fixture execution, supported-runtime matrix, or package acceptance.

### Dependency provenance

The complete frozen Git tree contains 275 `node_modules/` blobs, including TypeScript and `node_modules/.package-lock.json`. The child materialized them from the commit and did not install them during this task. Compiler package/entry/`_tsc.js` hashes matched the prior Oracle record; the lockfile declares the registry origin and integrity value. The original installation process remains unverified.

Retain that provenance limitation. Do not turn this finding into an implicit `npm ci`, a dependency deletion/restaging exercise, a lockfile change, or a claim that the preservation commit is a clean merge payload. This review does not attribute when those inherited tracked dependency blobs first entered history. The bounded repair must leave dependency/configuration bytes unchanged and stage only its expressly named source/test/report paths.

## 2. Verified findings and required fixes

All locations below refer to the frozen commit, not a moving branch.

### C1 — wrong object used as the source record — P1, must fix

`tests/unit/p065-budget-fixture.ts:94,181` accesses `f.source.sourceId`. In the returned value of `delegationBenchmarkFixture`, `source` is a function producing per-call source evidence, not the original source record. Its implementation ends with `return { ...f, service, launches, source, spawnArgs, resumeArgs, bindAndEnd }` at `tests/unit/b45-delegation-fixture.ts:160`, deliberately replacing the upstream fixture's `source` property. The compiler's two TS2339 diagnostics are therefore valid.

Failure scenario: the R=10/addRun task digest and resume reconciliation fact are constructed from a nonexistent property; suppressing the type error would feed an undefined identity into evidence intended to represent a registered source. This is not a request to weaken identity validation.

Required repair: obtain the stable source ID from the fixture's actual registered source/session identity, for example `f.parent.registration.source.sourceId` or the equivalent verified `f.parent.ref.sourceId`. Use that same established identity consistently in the digest and reconciliation fact. Check equality against the relevant input/run/meta and participant registration identities. Do not rename/change the broadly used benchmark fixture's `source()` API merely to make these two accesses compile, manufacture an unrelated ID, call a source resolver only to hide the mismatch, or cast away the error.

### C2 — spreading a nullable supervisor loses required stamp fields — P1, must fix

`tests/unit/p065-budget-fixture.ts:109` spreads `f.meta.supervisor`. `RunMeta.supervisor` is `ProcessStamp | null`; spreading that union permits the required `boot_id` and `pid_domain` to become optional. The resulting value fails at lines 120, 121, 122, 149, 151 and 159. These six diagnostics are consequences of the same seed/type defect, not six independent supervisor product bugs.

`ProcessStamp` requires all four fields: `pid`, `proc_start`, `boot_id`, and `pid_domain`. The upstream synthetic fixture constructs a complete stamp at `tests/unit/b45-handshake-fixture.ts:251–256`, but returns it through the nullable `RunMeta` type. `SupervisorRegistration.supervisor` correctly requires a full stamp; weakening that production type would be wrong and is outside P065 ownership.

Required repair: capture and validate the synthetic seed stamp once, narrow it with an actual runtime precondition, and construct explicitly typed complete `ProcessStamp` values for added runs. Keep the internal `runs`/target records non-null where fixture construction guarantees a registered supervisor. Retain the seed's boot and process-domain identity and override only the intended synthetic PID/start fields. Consistently carry the same stamp through registration, submission, scope evidence, reconciliation and heartbeat producer identity.

Do not use `any`, `as ProcessStamp`, blanket non-null assertions, empty-string fallbacks, permissive production types, direct DB row fabrication, or removed registration/heartbeat assertions as the repair. A malformed/missing seed must fail fixture construction before it can become population evidence.

### C3 — dynamically imported assertion target lacks explicit typing — P1, must fix

`tests/unit/p065-budget-fixture.ts:62` assigns the assertion module to an inferred local `assert`. The assertion-method call target therefore violates TypeScript's explicit-annotation requirement, producing seven TS2775 diagnostics at lines 174, 277, 278, 279, 281, 282 and 283.

Required repair: give that binding the correct explicit assertion-module type, or use the existing repository's statically imported `node:assert/strict` pattern. Preserve all handshake/population assertions and their narrowing semantics. This is not permission to delete assertions, weaken compiler flags, disable `noEmitOnError`, add `@ts-ignore`, or replace checks with untyped functions. If import placement changes, describe the small fixture-setup measurement boundary change; do not move any production per-request work or its clock.

### C4 — the existing test suite does not exercise the new workload fixture — P2, must fix for this repair's verification

`tests/unit/p065-budget.test.ts:7` imports only `budgetFixture` and `TestBudgetClock`; it does not invoke `p065WorkloadFixture`. A green compile and a rerun of that old semantic suite would not establish that the newly repaired workload setup can seed/register/bind/reconcile the prescribed populations.

Add focused, bounded tests in the same already owned test file, under a stable name prefix such as `P065 workload fixture`. Construct and dispose one fresh fixture for each required H/R profile, 1/1 and 2/10, and each non-wait tool: status, spawn, resume, cancel, whoami and report. Preserve serial execution and the real SQLite APIs. Test at least:

- Exact active baseline R, distinct occupied slots and appropriate claims, fully matching registered supervisor stamps, and heartbeat progress for every baseline run.
- H distinct valid participant registrations/source-context premises, with each returned source proof matching its actual participant. Shared logical parent ownership is allowed only as already ruled.
- For resume, terminal foreground targets with valid reconciled evidence, outside the R active baseline; the source ID must match the established source. No forced state/slot deletion.
- For child tools, each child's own valid claim/binding and the existing cross-child refusal, without weakened error expectations or borrowed parent authority.
- Cleanup on both successful and failed fixture construction, with temporary resources and service/ledger ownership correctly released.

These are construction/invariant regressions, not latency qualification or a claim of full framed MCP execution. They must fail on the relevant faulty condition, not only because a symbol/import is missing. The retained pre-fix compiler log establishes the failing-before type-check result; any new guard/invariant behavior also needs a meaningful semantic negative case through existing test seams or a narrowly reverted isolated control. Do not create a production bypass to facilitate a test.

If these focused cases reveal another fixture/runtime defect, preserve its exact result and return it for a further bounded disposition instead of expanding this compile repair into the unfinished benchmark project.

## 3. Exact bounded repair assignment

Assign the findings unchanged to the existing P065 implementer. Keep the established role/ownership split: a validation-only cloud task does not silently become an unrestricted implementation owner. The existing implementer can prepare a reviewable patch from the frozen bytes while lifecycle evidence is being reconciled, without mutating either held checkout. Applied source edits/materialization require a named, safe dispatcher assignment.

Permitted code writes for this repair:

1. `tests/unit/p065-budget-fixture.ts`: only C1–C3 and directly necessary fixture precondition/typing work.
2. `tests/unit/p065-budget.test.ts`: additive focused C4 regressions, retaining every existing test and assertion.

No production files, upstream B45 fixture API, package/lock/compiler configuration, historical source manifest/log/ruling, driver/holder, process/security helper or unrelated package path is included. If either fix genuinely requires an excluded file, stop that part and return the exact design/ownership question.

Keep the original shared worktree `/workspace/shared/p065-budget`, its old output/evidence, and the frozen failed candidate unchanged. Do not replay its append/format/build wrapper. Keep `a2b595...` available as the before image. A repair checkout must be a separately named workspace with an explicit owner and collision check, derived from this exact frozen source rather than today's `universal-hud`. Current rulings are binding even where the frozen branch's documentary copy is older; reading newer rulings does not authorize rebasing source.

Return a complete diff, a changed-file list, a new source manifest/aggregate and immutable identity, a statement that the other twenty-eight source files plus build/dependency inputs are unchanged, and the intended tests. Use a new manifest/report filename; do not overwrite `continuation-1-source-manifest.json` or its historical hashes. If publication is separately assigned under existing project authority, preserve descendants and publish only the specified source/report changes normally, without force-push, staging dependencies, touching main, or implying acceptance.

This is a limited compile/fixture repair disposition, not a new normal fix-round allowance. Preserve the package's actual consumed-round/submission record; no previous package counter is reset and no further submission is granted if its existing limit has been reached.

## 4. Cleanup/lifecycle disposition before compute

Keep the following states separate:

| Invocation | Terminal result | Cleanup evidence |
|---|---|---|
| Old shared-executor session 87162 | UNKNOWN. Its one authorized recovery poll returned Unknown process id. | Authoritative session/owned-descendant termination UNKNOWN. Existing hold remains. |
| New independent compiler PID/PGID 1134 | Known exit 1, without timeout, at the reported timestamp. | Direct process returned; original group absent. Fate of possible escaped descendants not established by the supplied evidence. |

Do not relabel the new known compile failure as UNKNOWN merely because cleanup coverage is incomplete. Conversely, exit 1, a completed conversation turn, an empty inventory or an absent original group do not establish complete descendant cleanup. There is no evidence here that an escaped descendant actually exists; the gap is proof of the claimed cleanup scope, not a discovered live runaway process.

Before reusing this cloud environment for another controlled workload, assign only read-only reconciliation of the existing invocation/launcher records and any supported authoritative process-ownership/session/cgroup lifecycle record. Establish exactly what was launched/owned, what terminal state was collected, and what completeness guarantees the mechanism provides. A documented retained ownership record that establishes no surviving owned descendants can close the new gap. Do not require unrelated global-process proof or physical-host exclusivity.

If such a facility/evidence is unavailable, report that exact limitation and leave dependent compute held. No repeated broad ps scans, old-session polls, speculative kills, permission changes, wrapper replay, or workload probes are authorized. Do not keep moving runs between hosts merely to avoid resolving a denied action or uncertain invocation. A genuinely separate executor route would need its own distinct authorized purpose, identity, preservation and explicit scheduling assessment; it is not an automatic retry supplied by this ruling.

The direct compiler's known terminal result remains useful diagnostic evidence while this prerequisite is resolved. The old session's outcome/cleanup are not a prerequisite to the already sanctioned independent route, and nothing here clears the old shared executor.

## 5. Ordered verification sequence, not an automatic execution grant

Each admitted group must name its exact immutable source, executor, owner, runtime/compiler identities, command(s), output and temporary directories, evidence destination, caps and return point. Run one controlled group at a time; on denial, unknown outcome/cleanup, unexpected source drift or a failed precondition, stop and report. Never turn a diagnostic suggestion into an unbounded retry loop.

### V0. Read-only preflight and revised source freeze

First close or explicitly retain the new lifecycle gap under section 4. Verify the existing owner's window has ended, then obtain a fresh dispatcher admission before repair materialization/compute. Preserve the failed run's files and the original thirty-file manifest. Verify both changed files and the twenty-eight unchanged files, the five build configurations, runtime binary and TypeScript identity. Record exact dependency provenance and the new complete source/tree identity. No dependency install is implicit.

### V1. One new compile-only command

After the source-only repair is frozen, run exactly one declared equivalent of:

```text
/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node ./node_modules/typescript/bin/tsc -p tsconfig.test.json
```

Use Node v24.22.1 / TypeScript 5.9.3 only if those exact identities are still verified. Use the unchanged standard `dist-test` location in the separately named repair validation checkout, not the old evidence/checkout. Cap at 180 seconds, TERM then ten-second kill-after, and capture complete stdout/stderr, UTC boundaries, exact terminal status, output hashes/inventory, owned-process closure and source/config postcheck. Choose a confirmed unused evidence directory, never reuse `...-01`.

A compile failure stops the group for review. Zero errors/exit zero closes only the compiler gate for that revised candidate. It does not establish C4 behavior, Node 22, the MCP-specific build, or acceptance. Do not test stale emitted files after a failed or uncertain compile.

### V2. Fresh-build and focused semantic group

Only after V1 succeeds and its owned-process cleanup is established may a separately declared bounded group run the needed fresh production and MCP builds (each 180 seconds):

```text
node ./node_modules/typescript/bin/tsc
node ./node_modules/typescript/bin/tsc -p packages/hud-mcp/tsconfig.json
```

Use the verified absolute Node selection in the actual assignment. These builds are required before claiming compiled CLI-to-MCP coverage; the prior `build:test` command is not a substitute.

Then, with fresh temporary HOME/HUD_HOME/TMPDIR, explicit executable resolution, synthetic data, and no inherited real harness/session/HERDR environment, run the new construction tests first (300 seconds):

```text
node --test --test-concurrency=1 --test-name-pattern='^P065 workload fixture' dist-test/tests/unit/p065-budget.test.js
```

This is an explicitly focused command, not a modified aggregate or full-suite pass. If successful, rerun the full existing P065-focused semantic commands on the same revised source (each 300 seconds):

```text
node --test dist-test/tests/unit/p065-budget.test.js dist-test/tests/unit/p065-local-gate.test.js
node --test packages/hud-mcp/dist/tests/hud-mcp/p065-budget.test.js
```

Inspect the dependency paths before admitting each stage; no Unix listener, ptrace, real TTY/Herdr or other known blocked facility is implicitly authorized. Preserve exact results and process/resource cleanup after every command. Failure or scope expansion returns the group immediately for review. Do not rerun the old 43-unit/28-MCP counts by assertion; obtain and report the new actual results.

Use separate isolated controls for any required behavioral failing-before demonstration. A rejected malformed identity/stamp is fixture-invariant evidence, not a performance sample. It must not be manufactured by disabling authority or altering production clocks. Preserve every negative-control output and its source identity.

### V3. Diff hygiene, independent re-check and remaining runtime coverage

Within a separately named permitted group, inspect `git diff --check` (60 seconds) and use the existing formatter in check-only mode on the two changed files (300 seconds). Do not run a whole-repository `--write`. A fresh re-check Oracle then verifies C1–C4 against the exact diff, positive/negative evidence, unchanged scope and lifecycle records. No second reviewer repeats this same compile-triage diff without a new repair/re-check basis.

Run the applicable Node 22 >=22.13 build/focused verification as its own declared runtime group once a supported exact runtime is available and dependencies/cleanup are verified. No install, runtime download or family waiver is implicit. Node 24 evidence cannot stand in for Node 22.

The broader brief's regression commands, full README gates and complete real-clock matrix remain outstanding and must be scheduled separately in the existing resource order. Known blocked `npm test`/`test:mjs` expansions remain blocked/unrun until materially relevant executor/operation evidence supports a separate disposition. Do not change scripts, skip assertions, move transport/trace methods or use another executor to evade that boundary.

## 6. What this repair cannot establish

The complete frozen tree contains neither `tests/int/p065-budget-benchmark.mjs` nor `tests/int/p065-ledger-holder.mjs`. The current workload fixture creates `DelegationService` objects and actor records; it does not itself instantiate the required two independently registered server/stream compositions and framed flush measurement. A later driver may compose those, but they are not proven now. Do not label a services-array count or a construction smoke test as the approved H=2 performance population.

Still required before full P065 acceptance: all mandated semantic/local-gate/uncertainty/shared-writer controls, actual compiled cold CLI behavior, complete operational and forced-overrun populations with distinct result flags, real heartbeat/contention and observation-store load, 50 warmups plus at least 1,000 measured calls per declared population, three isolated series on each supported Node family, all outcomes/failures retained, full-check disposition, final independent Oracle acceptance and green merged-tree checks. No numeric gate is changed. Real-Claude joint timing, capability/topology cells and formal supported-platform/B14 evidence remain separate. Assistant-run local testing remains withdrawn.

The next successful compile, if obtained, would be new evidence for the revised fixture only. It would not repair the historical log, validate the prior fixture run, clear either unrelated gate, accept a package, merge an unaccepted branch or turn an induced overrun into a latency pass.

## 7. Verified list and review method

Verified from the completed evidence response and immutable source:

- The new invocation's exact command/timestamps/exit status and the scope/limitations the child reports.
- Fifteen diagnostics, correctly grouped as two source-field, six stamp-type and seven assertion-target errors.
- The source() overwrite at the B45 fixture return and the valid registered-source alternatives.
- The nullable RunMeta supervisor versus mandatory four-field ProcessStamp/registration contract.
- The dynamic assertion binding and diagnostic call sites.
- The lack of workload-fixture invocation in the existing P065 unit suite.
- The precise two-file repair ownership, preserved production exclusions and ordinary role split.
- The standard build:test command, noEmitOnError configuration, output identity, and separation from the MCP/aggregate gates.
- The absence of the two P065 benchmark/holder files in the complete frozen tree and the tracked dependency blob count.
- The prior independent-route, interrupted-build, six-design and resource-window constraints.

I performed connector reads and modest read-only inspection only. I ran no compiler, test, fixture, benchmark, dependency setup, old-session poll, process probe or repository mutation. I spawned no subagents. The only output written by this review is this requested ruling file.

## Sources

- [Frozen source commit](https://github.com/CartmanFatass/codex-hud/commit/a2b595ce68a9f295d5147971173ebaa0d874e638).
- [Workload fixture](https://github.com/CartmanFatass/codex-hud/blob/a2b595ce68a9f295d5147971173ebaa0d874e638/tests/unit/p065-budget-fixture.ts), blob 934de9fdef95c75a9071c0c65a84a6c87c100765.
- [B45 delegation fixture](https://github.com/CartmanFatass/codex-hud/blob/a2b595ce68a9f295d5147971173ebaa0d874e638/tests/unit/b45-delegation-fixture.ts), blob a56cd8c9d09e0700a9146006abfe89ee520b9e67.
- [B45 handshake fixture](https://github.com/CartmanFatass/codex-hud/blob/a2b595ce68a9f295d5147971173ebaa0d874e638/tests/unit/b45-handshake-fixture.ts), blob bfae5672a1eb370d7611a202457d06cce9d71150.
- [Supervision types](https://github.com/CartmanFatass/codex-hud/blob/a2b595ce68a9f295d5147971173ebaa0d874e638/src/core/types/supervision.ts), blob 77a5a01c5482c89491dce901658cce1937757d8c.
- [P065 unit tests](https://github.com/CartmanFatass/codex-hud/blob/a2b595ce68a9f295d5147971173ebaa0d874e638/tests/unit/p065-budget.test.ts), blob 639b80f7bf563608ebb4b26f19b5c43c86076e5f.
- [P065 brief](https://github.com/CartmanFatass/codex-hud/blob/33c0cf6ef6e57c187d8b4e352cd609768073c63b/docs/cloud/P065-BUDGET.md), blob 684e5e5a202e8130658a253356235a952fb9035c.
- [dots workflow](https://github.com/CartmanFatass/codex-hud/blob/33c0cf6ef6e57c187d8b4e352cd609768073c63b/docs/cloud/dots.md), blob e586f2303819d3cc916a887ee24b0f9f41841add.
- [Interrupted-build ruling](https://github.com/CartmanFatass/codex-hud/blob/33c0cf6ef6e57c187d8b4e352cd609768073c63b/docs/cloud/rulings/p065-interrupted-build.md), blob e63f962f9fd44d2ca1342e6113a644d4d64f4621.
- [Independent cloud/source-freeze ruling](https://github.com/CartmanFatass/codex-hud/blob/33c0cf6ef6e57c187d8b4e352cd609768073c63b/docs/cloud/rulings/p065-independent-cloud-route-exact-source-freeze-20261103.md), blob 3542c4b2520c822b4c196eb2a6b9de53e57aade0.
- [Six-design dispositions](https://github.com/CartmanFatass/codex-hud/blob/33c0cf6ef6e57c187d8b4e352cd609768073c63b/docs/cloud/rulings/p065-six-design-dispositions.md), blob 5157021663070f5513c907b75f8082c3e04ce15a.
- [Scheduling/ownership release](https://github.com/CartmanFatass/codex-hud/blob/33c0cf6ef6e57c187d8b4e352cd609768073c63b/docs/cloud/rulings/p065-budget-release.md), blob d8f2cecaa3280ede589ba6ccd821cdf7274c112f.
- [Resource windows](https://github.com/CartmanFatass/codex-hud/blob/33c0cf6ef6e57c187d8b4e352cd609768073c63b/docs/cloud/rulings/wave1-resource-windows-20261103.md), blob 20bded878c6b77601634fde1c223dd0f378b6ba2.
- Completed cloud task evidence-return turn and message identified in section 1. Source/config postcheck and log hashes are attributed to that task, not claimed as an independent second execution.

## Appendix A. Exact returned invocation metadata

```json
{
  "command": [
    "/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node",
    "./node_modules/typescript/bin/tsc",
    "-p",
    "tsconfig.test.json"
  ],
  "cwd": "/workspace/p065-validation",
  "timeout_seconds": 180,
  "kill_after_seconds": 10,
  "utc_start": "2026-11-03T23:10:37.751542+00:00",
  "pid": 1134,
  "process_group": 1134,
  "exit_status": 1,
  "timeout": false,
  "utc_end": "2026-11-03T23:10:46.294055+00:00",
  "process_group_present": false
}
```

## Appendix B. Full exact returned compiler stdout

```text
tests/unit/p065-budget-fixture.ts(94,18): error TS2339: Property 'sourceId' does not exist on type '() => { ok: true; callId: string; sessionRef: SessionRef; processKey: string; evidenceDigest: string; scopePremise: ScopeSnapshot; }'.
tests/unit/p065-budget-fixture.ts(120,42): error TS2345: Argument of type '{ runId: string; ticketHash: string; launchDigest: string; supervisor: { pid: number; proc_start: string; boot_id?: string | undefined; pid_domain?: string | undefined; }; authority: { kind: "mcp"; contextId: string; generation: number; evidence: CurrentCallEvidence; scopePremise?: ScopeSnapshot; }; at: number; mono...' is not assignable to parameter of type 'SupervisorRegistration'.
  The types of 'supervisor.boot_id' are incompatible between these types.
    Type 'string | undefined' is not assignable to type 'string'.
      Type 'undefined' is not assignable to type 'string'.
tests/unit/p065-budget-fixture.ts(121,39): error TS2345: Argument of type '{ at: number; runId: string; ticketHash: string; launchDigest: string; supervisor: { pid: number; proc_start: string; boot_id?: string | undefined; pid_domain?: string | undefined; }; authority: { ...; }; monoMs: number; }' is not assignable to parameter of type 'SupervisorRegistration'.
  The types of 'supervisor.boot_id' are incompatible between these types.
    Type 'string | undefined' is not assignable to type 'string'.
      Type 'undefined' is not assignable to type 'string'.
tests/unit/p065-budget-fixture.ts(122,44): error TS2345: Argument of type '{ pid: number; proc_start: string; boot_id?: string | undefined; pid_domain?: string | undefined; }' is not assignable to parameter of type 'ProcessStamp'.
  Types of property 'boot_id' are incompatible.
    Type 'string | undefined' is not assignable to type 'string'.
      Type 'undefined' is not assignable to type 'string'.
tests/unit/p065-budget-fixture.ts(149,42): error TS2345: Argument of type '{ pid: number; proc_start: string; boot_id?: string | undefined; pid_domain?: string | undefined; }' is not assignable to parameter of type 'ProcessStamp'.
  Types of property 'boot_id' are incompatible.
    Type 'string | undefined' is not assignable to type 'string'.
      Type 'undefined' is not assignable to type 'string'.
tests/unit/p065-budget-fixture.ts(151,17): error TS2345: Argument of type '{ runId: string; claim: string; child: { authority: { kind: "mcp"; contextId: string; generation: number; evidence: CurrentCallEvidence; scopePremise?: ScopeSnapshot; }; registration: Registration; context: ContextBase & ... 1 more ... & { ...; }; ref: SessionRef; }; supervisor: { ...; }; }' is not assignable to parameter of type '{ runId: string; claim: string; child: { authority: { kind: "mcp"; contextId: string; generation: number; evidence: CurrentCallEvidence; scopePremise?: ScopeSnapshot | undefined; }; registration: Registration; context: ContextBase & ... 1 more ... & { ...; }; ref: SessionRef; }; supervisor: ProcessStamp | null; }'.
  The types of 'supervisor.boot_id' are incompatible between these types.
    Type 'string | undefined' is not assignable to type 'string'.
      Type 'undefined' is not assignable to type 'string'.
tests/unit/p065-budget-fixture.ts(159,53): error TS2345: Argument of type '{ runId: string; claim: string; child: { authority: { kind: "mcp"; contextId: string; generation: number; evidence: CurrentCallEvidence; scopePremise?: ScopeSnapshot; }; registration: Registration; context: ContextBase & ... 1 more ... & { ...; }; ref: SessionRef; }; supervisor: { ...; }; }' is not assignable to parameter of type '{ runId: string; claim: string; child: { authority: { kind: "mcp"; contextId: string; generation: number; evidence: CurrentCallEvidence; scopePremise?: ScopeSnapshot | undefined; }; registration: Registration; context: ContextBase & ... 1 more ... & { ...; }; ref: SessionRef; }; supervisor: ProcessStamp | null; }'.
  The types of 'supervisor.boot_id' are incompatible between these types.
    Type 'string | undefined' is not assignable to type 'string'.
      Type 'undefined' is not assignable to type 'string'.
tests/unit/p065-budget-fixture.ts(174,7): error TS2775: Assertions require every name in the call target to be declared with an explicit type annotation.
tests/unit/p065-budget-fixture.ts(181,30): error TS2339: Property 'sourceId' does not exist on type '() => { ok: true; callId: string; sessionRef: SessionRef; processKey: string; evidenceDigest: string; scopePremise: ScopeSnapshot; }'.
tests/unit/p065-budget-fixture.ts(277,5): error TS2775: Assertions require every name in the call target to be declared with an explicit type annotation.
tests/unit/p065-budget-fixture.ts(278,5): error TS2775: Assertions require every name in the call target to be declared with an explicit type annotation.
tests/unit/p065-budget-fixture.ts(279,5): error TS2775: Assertions require every name in the call target to be declared with an explicit type annotation.
tests/unit/p065-budget-fixture.ts(281,7): error TS2775: Assertions require every name in the call target to be declared with an explicit type annotation.
tests/unit/p065-budget-fixture.ts(282,7): error TS2775: Assertions require every name in the call target to be declared with an explicit type annotation.
tests/unit/p065-budget-fixture.ts(283,7): error TS2775: Assertions require every name in the call target to be declared with an explicit type annotation.
```

stderr: empty. Generated-file inventory: `[]`. The stdout digest and provenance limits are stated in section 1.

