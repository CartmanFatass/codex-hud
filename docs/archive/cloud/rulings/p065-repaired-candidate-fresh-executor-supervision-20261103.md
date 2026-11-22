# P065: repaired-candidate validation on a freshly provisioned executor

Date: 2026-11-03, approximately 23:26 UTC. Fresh Oracle scheduling and lifecycle disposition. Read-only research plus this requested ruling file. Documentary head observed: `universal-hud@19ac6248f929c4e7deaae820b1069cc7dd370f33`.

## Decision

**Conditionally sanction one new, freshly provisioned Codex cloud container for compilation of the C1–C4 repaired, newly frozen candidate. Do not rerun the unchanged failed candidate, reuse either held executor, or start the compiler merely because the new container is fresh. Establish the new invocation's ownership and terminal/descendant evidence mechanism before launch.**

The immediate practical work is: the existing implementer prepares the two-file repair; the dispatcher names a fresh validation owner and destination; that owner verifies source and a narrowly scoped compiler supervisor; then the dispatcher admits one compile-only command. If the supervisor cannot establish the required evidence without prohibited capabilities or a denied action, stop before the compiler and report that concrete blocker. Do not create a chain of replacement containers.

This is the explicit scheduling assessment contemplated by §4 of the independent compile-failure ruling. It preserves its holds rather than silently waiving cleanup. A new candidate and a supervisor designed before execution materially differ from another unsupervised attempt with a new log name. The previous failed invocation is already terminal at the direct-compiler level; there is no reason to recover or replay it to diagnose its fifteen errors.

P065 remains **WIP / NOT ACCEPTED / NOT MERGEABLE / NOT PERFORMANCE-QUALIFIED**. This report is not itself a compute lease, implementation patch, process-termination instruction, or final acceptance review.

## 1. Historical facts remain separate

| Workload | Known outcome | Unresolved fact and disposition |
|---|---|---|
| Original shared-executor session `87162` | UNKNOWN. The single permitted recovery poll returned `Unknown process id`. | Authoritative session/owned-descendant termination remains UNKNOWN. The shared executor stays held; no further poll, wrapper replay, cleanup, or controlled workload there. |
| Independent compiler PID/PGID `1134`, cloud task `01a1a3a1-e613-751f-b551-32dd923650f9` | Known exit **1**, timeout false, at `2026-11-03T23:10:46.294055+00:00`; fifteen TypeScript diagnostics. Original process group reported absent. | Possible escaped descendants are not accounted for. That cloud executor stays held for new controlled workloads. No escaped process is demonstrated; missing proof must not be reported as a discovered runaway. |
| Proposed repaired-candidate compiler | **NOT RUN** | New source, environment, supervisor, admission and result must all be recorded. Nothing about either earlier run is repaired retroactively. |

The first independent environment was `ccarenv_b64_Y2NhcmVudl8wYmNlMDczN2Y0ZjQ4MTkxODFmNmZlNDQ1ZjZkNmE1OA`. Keep its checkout and `/workspace/p065-compile-evidence-20261103-01` intact. The known failing source is commit `a2b595ce68a9f295d5147971173ebaa0d874e638`, tree `1bbf38aa42d0ffc2206da1c246ec1f7c9d62c221`, with thirty-path aggregate `174f7fa30e934574ebcd615cda4b475a4c7b82c77964e9b6e0ad9cd333d2ae84`. Keep it as the immutable before image.

The dispatcher supplied the following completed runtime finding from cloud task `01a1a3a1-e613-751f-b551-32dd923650f9`, turn `01a1a3b6-ed69-7538-8a5c-28421c59a6e8`: `exec_command`/`write_stdin` provide direct output/exit and live sessions, but no retained descendant-ownership/cleanup proof; `cloud_environment.environment_status` reports environment/network/capabilities rather than that proof. The child reported no authoritative retrospective facility. I attribute that result to the dispatcher/child; I did not poll or independently inspect their process state.

Therefore the requested read-only reconciliation has reached a concrete limit. More broad process scans, elapsed-time arguments, a new shell, or another session lookup cannot turn this limitation into authoritative cleanup. Preserve the limitation and stop pursuing those routes. A supervisor added later cannot retrospectively adopt or account for processes from the previous invocation.

## 2. Why the new route is allowed, and what it does not override

The independent-route ruling already distinguishes a genuinely separate executor from a renamed command on a held executor. It accepts the platform contract that `cloud_threads.create` with a saved `environmentConfigId` provisions a fresh cloud container, subject to a recorded actual environment identity and no contradictory evidence of a shared live writable workspace or shared owned-process lifecycle. This Oracle read the current tool contract and it still describes that fresh-container behavior.

The dispatcher supplied this exact user authorization:

<transcript_evidence>
用户：“允许使用codex cloud会话 使用terra high完成独立环境的测试 dots似乎安全策略较为严格”
</transcript_evidence>

Use that independent-testing authority and the existing project dispatcher authority. No generic repeat owner approval is needed merely for this properly scoped route. The reference to strict safety policy is **not** permission to weaken policy, change security settings, retry an operation denied on unchanged evidence, or move a denied operation to another host.

The next purpose is specifically **validate the repaired frozen fixture under a declared compiler invocation with ownership established beforehand**. It is not completion of session 87162, recovery of PID 1134, replay of the append/format/build wrapper, a new benchmark, or an attempt to obtain denied Unix-socket/ptrace coverage.

Provision one fresh container from a currently verified saved configuration. Record exact create parameters/result, new task/environment IDs and provider. Honor the requested Terra/high settings where available and distinguish requested model settings from effective settings if the runtime cannot attest them. Do not select an existing computer, reuse the first independent executor under a new task name, or infer freshness from a new directory, PID, boot ID or uptime alone.

A different physical host, empty caches and absence of preloaded `dist`/`node_modules` are not requirements for this compile-only route. Conversely, container freshness is operational isolation evidence, not proof that its future compiler descendants will terminate and not a performance-isolation claim. If ordinary records contradict isolation, stop and resolve the contradiction without sentinel writes or probe workloads.

## 3. Source preparation and ownership

Pass C1–C4 from the compile-failure ruling unchanged to the existing P065 implementer. The only P065 source changes remain:

1. `tests/unit/p065-budget-fixture.ts`: the registered-source identity, complete validated supervisor stamps, and correctly typed assertion binding/preconditions.
2. `tests/unit/p065-budget.test.ts`: additive bounded construction/invariant regressions, retaining the existing tests and assertions.

No production, upstream B45 API, dependency, compiler configuration, performance driver/holder or repository process/security helper changes are included. Preserve the original package's consumed fix-round/submission history. This disposition creates no extra fix allowance.

The implementer may prepare a complete patch from the frozen bytes without running it on either held executor. Applied repair materialization belongs in a separately assigned safe workspace, with one writer and a collision check. A validation-only cloud owner may apply the exact supplied two-file patch as source transfer; it must not improvise additional fixes. Source preparation is a separate named step before compile admission, not an implicit restart of an old lease.

Freeze the repaired candidate as a new immutable source artifact/commit and a new manifest. Verify the two revised paths and all twenty-eight unchanged source paths against the before image; record every other full-tree difference. Verify the five previously named package/lock/compiler configuration files and the compiler/runtime/dependency bytes. Preserve the before manifest and failing log; never overwrite them or rebase source onto today's documentary `universal-hud`.

The preservation commit contains tracked dependency blobs, including `node_modules/.package-lock.json`; that inherited fact is not permission to stage, reinstall or clean dependency state. Retain the original-installation provenance limitation. Missing/inconsistent dependencies require their own disposition, not an implicit `npm ci`.

Use a newly named validation checkout and unique output/evidence directories. Materialize actual bytes on the receiving executor and verify their digests. Paths on another executor and textual hash lists alone are not transferred inputs. Record pre-existing generated output before the run; if output removal or a source-only checkout is needed, declare it in the preparation assignment rather than silently deleting inherited tracked content.

## 4. Establish ownership before launching the compiler

The missing retrospective API does not establish that a forward, process-local supervisor is unavailable. The new run must have one reviewed supervision mechanism selected **before** compiler admission. Do not rely only on `setsid`, a timeout wrapper, leader exit, `killpg(..., 0)`, a shell trap, conversation completion or a claimed lease return.

### Preferred existing facility, if actually available

A supported provider job/container lifecycle scope or already authorized private cgroup can supply stronger ownership. Require a unique scope covering the compiler and its descendants before execution, no unrelated processes, complete membership/escape guarantees, a supported bounded termination action, and a retained empty/closed result. For cgroup v2, `cgroup.events` exposes recursive live-process population and `cgroup.kill` targets a subtree, but scope membership/migration controls and authority still matter. A cgroup path or a single empty `cgroup.procs` list alone is insufficient. [Linux kernel cgroup v2 documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).

This ruling does not create such a facility or authorize remounting cgroups, changing system/security permissions, enabling capabilities, or killing a parent/container scope containing unrelated work. Do not claim provider teardown is available without a supported operation and completion result.

### Practical narrow alternative: compiler-local subreaper

For this direct compiler only, a small off-repository launcher may establish a Linux child-subreaper before launch. A subreaper adopts orphaned descendants, including ordinary double-fork/session-detaching cases; it is not a sandbox against arbitrary namespace, external-broker or parent-reassignment behavior. Its lifecycle scope is the launcher's ordinary process-descendant tree. [Linux child-subreaper interface](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html).

This is a **new validation-supervision assignment**, not an enlargement of the P065 two-file repair. Prepare and review the launcher as a separately named, hashed evidence artifact outside the repository; do not alter product process helpers or install a daemon/package. Use existing trusted runtime/standard-library facilities. Normal tool review remains binding.

Require these properties in the launcher and its admission record:

- One dedicated supervisor process, no unrelated child work, and one explicitly selected compiler child. Record supervisor/runtime identity and the complete launcher bytes/hash.
- Establish `PR_SET_CHILD_SUBREAPER` before spawning; check its return and read the setting back with `PR_GET_CHILD_SUBREAPER`. A denied/unsupported call stops before the compiler. A successful bootstrap is evidence of this caller's setting, not container-wide cleanup. [Setting readback](https://man7.org/linux/man-pages/man2/PR_GET_CHILD_SUBREAPER.2const.html).
- Keep normal waitable-child semantics: no ignored `SIGCHLD`, no `SA_NOCLDWAIT`, no competing undocumented reaper and no supervisor replacement/exit before closeout. Establish an empty owned-child set before launch. Keep one owner for consuming and recording wait statuses.
- Invoke the absolute Node executable directly with the fixed compiler argument vector, not `npm`, a shell string, project scripts, a watcher or a background launch. Use an explicit clean environment with fresh HOME/HUD_HOME/TMPDIR and no inherited Node/Python preload, loader, debugger, shell-startup or real harness credentials. Record the allowlist, without secrets.
- Read the frozen compiler entry/loading chain and configuration before admission. The allowed command must not invoke an external daemon, submit work to a broker, move processes into another parent/namespace, or execute project fixtures. Ordinary worker threads end with their process and are not a separate process population. If the actual launch path cannot support this bounded scope, use a verified job boundary or stop.
- Record the direct child's exact identity immediately, retain terminal status, and account for adopted child statuses until the owned tree closes. Do not convert an unexpected descendant into permission to run more work.
- Use stable owned-process handles for any termination where supported. A pidfd identifies a process and can be used to signal it; otherwise a still-owned, unreaped direct child can be addressed through the launcher's retained identity. Never kill a remembered numeric PID after reaping or a process selected by name/pattern. [Linux pidfd interface](https://man7.org/linux/man-pages/man2/pidfd_open.2.html).
- Preserve a finite deadline and fail-closed closeout. A direct child/group cap is not a promise that every possible detached process will be killable. Do not invent a descendant enumeration/kill capability. If an owned descendant cannot be specifically accounted for or safely controlled, report the gap and hold this new executor.

A nonblocking wait returning zero means a child exists but is not waitable; it is not cleanup. The required closeout is the recorded direct compiler status plus completion of owned-child reaping and a genuine all-children `ECHILD` result under the above signal/reaper assumptions. [Linux wait semantics](https://man7.org/linux/man-pages/man2/waitpid.2.html).

**Inference accepted for this narrow route:** if the verified ordinary-descendant launch scope is maintained, the supervisor survives, and the all-children closure is recorded, a surviving ordinary descendant would require a surviving child lineage or an adopted child. The closure therefore accounts for that scope, including session/group escape. This is a forward ownership proof for the new invocation, not a global process census and not proof about earlier invocations. It does not require `CONFIG_PROC_CHILDREN`, ptrace, a Unix listener, namespace creation or a broad `ps` scan.

If the supervisor is interrupted, its record is incomplete, its scope assumptions fail, or its closure cannot be obtained, keep cleanup UNKNOWN. Do not interpret lack of a child status, an empty output file or tool-session disappearance as `ECHILD`. Preserve the exact compiler exit if it was collected separately.

No compiler is admitted until the proposed supervisor has been inspected and its bootstrap prerequisites are part of the declared operation. The present review performs no launcher construction, bootstrap, child probe or supervision self-test. Any proposed executable self-test is additional work requiring its own bounded assignment; it is not hidden inside the compile-only allowance.

## 5. Exact next admission and stop conditions

After preparation and supervisor review, the dispatcher records one new bounded assignment containing:

- **Purpose and source:** repaired-candidate compile only; new immutable source/tree/artifact ID, complete manifest, two-file repair diff, unchanged-input checks, checkout path.
- **Executor and owner:** new saved-config provisioning result, task/environment ID, one owner, no concurrent controlled workload in this scope. Existing held executor identities remain separately listed.
- **Supervisor:** exact artifact/hash and selected ownership mechanism, bootstrap/closure evidence contract, signal behavior and return point.
- **Runtime/compiler:** resolved Node path/version/binary hash, TypeScript 5.9.3 package and entry/loading-chain hashes. Node v24.22.1 may be reused only if verified; a different supported version is explicitly declared evidence.
- **Command:** exactly one direct `node ./node_modules/typescript/bin/tsc -p tsconfig.test.json` under the declared absolute Node selection.
- **Writes:** declared standard relative `dist-test` output in the new checkout, unique raw logs/metadata and fresh temporary directories only. Source/configuration bytes remain fixed.
- **Bounds:** 180 seconds for compilation, TERM at the deadline and the declared ten-second kill-after for safely owned targets; allow a separately stated bounded reap/evidence-closeout interval and a larger outer supervisor cap. For example, 200 seconds for internal closeout and 210 seconds externally. These are control deadlines, not retrospective proof that termination happened. A supervisor timeout/interruption is a failed lifecycle closeout.
- **Return:** terminal compiler result and owned-process closure, or exact blocker. No tests, formatting writes, installs, aggregation, measurement or automatic retry follows.

Persist initial metadata before launch and append lifecycle/terminal events as they occur, so interruption does not erase which process was started. Preserve exact stdout/stderr bytes, UTC and monotonic boundaries, exit/signal/timeout details, wait/closure record, output inventory/hashes and source/configuration postcheck. Do not allow output capture to wait indefinitely on a pipe held by an escaped descendant.

Interpret results separately:

1. **Compiler exit 0; closure proved; identities unchanged:** V1 compiler gate passes for this candidate/runtime only. A separately admitted next group may proceed.
2. **Compiler exit nonzero; closure proved:** known compiler failure with completed owned-process cleanup. Preserve diagnostics and return for bounded triage; no automatic second compile.
3. **Compiler result known; closure unproved:** preserve the known result, mark lifecycle incomplete, and hold the new executor.
4. **Compiler result unavailable:** outcome UNKNOWN, lifecycle as evidenced, stop. No inference from emitted files or elapsed time.
5. **Preflight/bootstrap denied or unavailable:** compiler NOT RUN. Report the exact action, target and reason. Do not switch tools, shells, hosts or syscall routes to evade denial.
6. **Unexpected descendants or scope drift:** preserve all collected facts and stop for inspection, even if closure ultimately succeeds. Do not silently expand this narrow direct-compiler ruling to general fixture or daemon workloads.

A further replacement environment is not an automatic response to cases 3–6. It requires a materially new disposition addressing what failed; otherwise the same gap is merely reproduced.

## 6. Subsequent gates remain unchanged

After successful V1 and proved closure, follow the existing compile-failure ruling's separately scheduled V2/V3 sequence: fresh production/MCP builds; serial new workload-construction cases; the P065-focused semantic commands; meaningful behavioral negative controls; diff and check-only formatting hygiene; fresh independent re-check; and the separately declared supported Node 22 group. Reassess supervision for commands that actually create child processes. This compiler-local alternative does not automatically establish sufficient lifecycle coverage for that broader behavior.

No old 43-unit/28-MCP success is transferred to the repaired candidate. The missing performance driver/holder, real H=2 framed composition, real-clock populations and retained failure/overrun evidence, supported-runtime series, full README checks, formal/local evidence and final independent acceptance remain outstanding. No aggregate denial, AF_UNIX/ptrace restriction, local-test withdrawal, numeric gate, ownership boundary or review/fix limit changes.

This ruling changes the available **next scheduling route and prospective evidence method**, not a product contract, supported profile or acceptance threshold. It explicitly leaves retrospective uncertainty intact.

## Sources and review method

Repository files were read through the GitHub connector on `universal-hud`; these blobs were observed:

- [Independent compile failure / bounded repair](https://github.com/CartmanFatass/codex-hud/blob/19ac6248f929c4e7deaae820b1069cc7dd370f33/docs/cloud/rulings/p065-independent-compile-failure-bounded-repair-20261103.md), blob `7701eb99a4cd78c6db158541ab61a171a361192a`.
- [Independent cloud route / exact-source freeze](https://github.com/CartmanFatass/codex-hud/blob/19ac6248f929c4e7deaae820b1069cc7dd370f33/docs/cloud/rulings/p065-independent-cloud-route-exact-source-freeze-20261103.md), blob `3542c4b2520c822b4c196eb2a6b9de53e57aade0`.
- [STATE](https://github.com/CartmanFatass/codex-hud/blob/19ac6248f929c4e7deaae820b1069cc7dd370f33/docs/handoff/STATE.md), blob `23e88a175620bcf5071db2f219a1206610e3205e`.
- [Interrupted build](https://github.com/CartmanFatass/codex-hud/blob/19ac6248f929c4e7deaae820b1069cc7dd370f33/docs/cloud/rulings/p065-interrupted-build.md), blob `e63f962f9fd44d2ca1342e6113a644d4d64f4621`.
- [Resource windows](https://github.com/CartmanFatass/codex-hud/blob/19ac6248f929c4e7deaae820b1069cc7dd370f33/docs/cloud/rulings/wave1-resource-windows-20261103.md), blob `20bded878c6b77601634fde1c223dd0f378b6ba2`.
- [Remote guide](https://github.com/CartmanFatass/codex-hud/blob/19ac6248f929c4e7deaae820b1069cc7dd370f33/AGENTS.md), [dots workflow](https://github.com/CartmanFatass/codex-hud/blob/19ac6248f929c4e7deaae820b1069cc7dd370f33/docs/cloud/dots.md), and [cloud rules/check set](https://github.com/CartmanFatass/codex-hud/blob/19ac6248f929c4e7deaae820b1069cc7dd370f33/docs/cloud/README.md).

Additional evidence: current fresh-container create contract; the dispatcher's exact user quote and runtime-report attribution above; primary Linux kernel/man-pages documentation linked beside the prospective mechanism. No claim is made that subreaper, pidfd or a cgroup is already usable in a new container.

This review ran no compiler, test, fixture, benchmark, process probe, session/status poll, dependency operation, cleanup or repository mutation and spawned no subagents. It wrote only the requested ruling file.
