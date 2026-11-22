# P065-BUDGET: narrowly bounded metadata safety exception

Date: 2026-11-03.

## Decision

**ADOPT WITH REFINEMENT. Approve an explicit, narrowly enumerated exception for synchronous private-store metadata revalidation while the SQLite writer lock is held. Keep the preparation-inclusive 30 ms limit, cumulative 20 ms lock-wait/retry/backoff limit, current busy_timeout=0, all authority/replay/admission rules and truthful committed outcomes unchanged.**

This is a deliberate amendment to the no-external-I/O rule, not a finding that the existing code already complied. It resolves the contract fork identified in p065-budget-local-gate.md. It does not accept the existing implementation, claim hard real-time syscall control, or authorize arbitrary lock-held filesystem/process work.

**Design disposition: approved. Implementation disposition: HOLD pending the exact serialized contract/brief amendments and a separate current scheduling/ownership release.** That remaining hold is not a request for another owner decision. The owner has explicitly delegated project choices to Oracle. The dispatcher may record this decision and commission the remaining read-only scheduling/release disposition immediately, without waiting for local testing. No code, tests, new environment permissions or assistant-run local work are authorized by this consultation itself.

Owner authority supplied for this decision:

> 后续你有本地测试需求可以发给我 然后继续工作即可 我有空会完成测试 队列任务你直接完成即可 无需我批准 有需要抉择的地方请让oracle直接决定

## 1. Evidence and boundaries

I read the full repaired P065-BUDGET brief, the full local-gate ruling, the earlier P-06-5 recommendation and approved owner question, F08, the relevant clauses of contracts 01–07, the engineering-plan ownership/brief rules, architecture §8, current STATE, queue-progress ruling, workflow and current active-package ownership. Source and relevant test assertions were inspected read-only at universal-hud commit `1561eafec65dcd8e9f9c738dcf7c8e8efc5db6c3`.

During this review universal-hud advanced to `4004dbbb3e4387a4d170ba14ea972258a27cf948`. The verified comparison adds only docs/cloud/rulings/b10b-diagnostic-v3.md. It changes none of this ruling's source, tests, contracts, brief or STATE. The comparison from the previous local-gate ruling's repaired brief base cd555891 to 1561eafe is also documentation-only. The complete local-gate report read locally was verified to have the same Git blob hash as the pinned repository file: `7347edc0347d6375afed5df0d3749f7f021f4cf0`.

No code, test, branch, repository file, local file, dependency, capability or security setting was changed. No build, test, benchmark, probe or real-harness operation was run. The findings below are source/design findings, not reproduced failures or performance results.

Primary project evidence:

- [Conditional brief](https://github.com/CartmanFatass/codex-hud/blob/1561eafec65dcd8e9f9c738dcf7c8e8efc5db6c3/docs/cloud/P065-BUDGET.md)
- [Prior local-gate ruling](https://github.com/CartmanFatass/codex-hud/blob/1561eafec65dcd8e9f9c738dcf7c8e8efc5db6c3/docs/cloud/rulings/p065-budget-local-gate.md)
- [Approved preparation-inclusive scope](https://github.com/CartmanFatass/codex-hud/blob/1561eafec65dcd8e9f9c738dcf7c8e8efc5db6c3/docs/handoff/questions/P-06-5.md)
- [Execution contract](https://github.com/CartmanFatass/codex-hud/blob/1561eafec65dcd8e9f9c738dcf7c8e8efc5db6c3/docs/contracts/02-execution.md#L68-L93)
- [Budget contract](https://github.com/CartmanFatass/codex-hud/blob/1561eafec65dcd8e9f9c738dcf7c8e8efc5db6c3/docs/contracts/06-observation.md#L240-L252)

## 2. Why this route, and what is rejected

The existing post-acquisition observation has a useful, limited purpose. A gate created around the opening sequence pins HUD_HOME and ledger.sqlite device/inode identities. Rechecking after actual acquisition can refuse replacement or unsafe metadata observed after queueing and lock waits. A pre-lock-only observation cannot establish the same facts. In particular, chmod can change privacy without changing any SQL row, and a different inode can contain the same ledgerId. Contract 02 deliberately preserves ledgerId across same-store restore.

The chosen exception preserves that useful observation while limiting its cost and authority. It is smaller and more directly testable than a native service/VFS/profile change, and does not remove positive local resume support.

Rejected for this package:

1. Precheck-only, cached boolean, watcher/TTL, or SQL ledgerId/generation/hash as a replacement for post-acquisition filesystem observation. None proves current pathname privacy and object identity.
2. Release/check/reacquire or a second acceptance phase. A later acquisition recreates the gap, and a committed operation cannot be undone by a later refusal.
3. General lock-held filesystem/process verification, including wrapping it in a SQL function, acquisition helper, callback or renamed phase. The exception belongs to the enumerated metadata operation, not to a function's name.
4. Raising 30 ms, giving metadata a separate allowance, restarting time after opening/acquisition, or changing the per-call limit to a percentile. These would change a different approved decision.
5. Returning busy via Promise.race while uninterruptible work can later commit; reporting a successful late commit as not accepted; blindly retrying uncertain commit.
6. Native helpers, a second SQLite binding, a new VFS/daemon, descriptor tricks or a supported-runtime/profile change. These need separately designed and qualified packages, not this exception.
7. Disabling local resume, silently excluding it from P065, or making every local request refuse. That would change supported functionality rather than satisfy this design.

The supported API constraint remains relevant: Node 22.13's documented DatabaseSync API does not expose a general file-control/inode attestation interface; Node 24.0's location() returns a pathname. SQLite's C file-control facilities are not a complete home/UID/privacy/sidecar check, and live database rename/unlink is not a supported identity protocol. These are reasons not to infer a free substitute, not claims about every possible future native mechanism. [Node 22.13](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html), [Node 24.0](https://nodejs.org/download/release/v24.0.0/docs/api/sqlite.html#databaselocationdbname), [SQLite file control](https://www.sqlite.org/c3ref/c_fcntl_begin_atomic_write.html), [SQLite rename/unlink warning](https://www.sqlite.org/howtocorrupt.html#_unlinking_or_renaming_a_database_file_while_in_use).

## 3. Exact exception and security guarantee

### Allowed operation

One fixed synchronous metadata-revalidation pass may execute after a successful BEGIN IMMEDIATE and before the protected local authorization/canonical replay/admission or the already-existing protected writer mutation.

Its only filesystem targets are the original trusted gate's canonical HUD_HOME, that home's ledger.sqlite, and exactly ledger.sqlite-wal and ledger.sqlite-shm. Its only filesystem operations are lstatSync and realpathSync, at most one of each per target per pass: at most eight Node filesystem API calls, with early exit and absent sidecars using fewer calls. This counts JavaScript API invocations, not underlying kernel calls, and is not a wall-clock guarantee. The pass also uses current UID/eUID and bounded in-memory checks/comparisons. It must not construct a new gate or pin new identities while holding the lock.

The pass retains absolute/canonical path checks, required directory/regular-file types, ownership by the current UID, private mode, no symlinks, single hard-link count for files, real/effective UID agreement, and the original HUD_HOME/main-file device/inode comparisons. Existing WAL/SHM files receive the safety checks. Their lifetime inode identities are not pinned: legitimate absence, creation and removal remain supported.

Absence is not an error wildcard. A stable dangling sidecar symlink must not be mistaken for an absent sidecar. The local revalidation path must distinguish an actually absent directory entry from realpath failure, for example by lstat before realpath. Preserve normal sidecar removal races as observation-limited checks, not a new requirement for permanent sidecar presence. Current check() does realpath first and swallows sidecar ENOENT; source inspection therefore identifies a possible dangling-symlink-as-absence hole. Require the negative case in the new local guard. This ruling does not silently change all legacy shared callers through a global check() rewrite; see §6.

No file contents, config/brief/transcript reads, directory enumeration, content hashes, source-root discovery, /proc reads, executable discovery, subprocesses, host CLI, network, IPC, filesystem writes, permission repair, retries, polling, watcher waits or arbitrary observer callbacks are covered. SQLite's own required transaction I/O and mandatory cleanup are not reclassified as application preparation. Existing pure synchronous transactional bookkeeping is not a permission for external work.

The inventory of existing gate consumers in §6 is closed for this ruling. The exception does not automatically apply to a future caller because it imports PrivateLedgerGate or labels work “security”.

### Guarantee, stated honestly

This remains an observation-based safety gate. It compares the original opening observations with fresh post-acquisition observations and refuses mismatches or unsafe facts it observes. It does not atomically lock the filesystem namespace together with SQLite, attest every internal SQLite file handle, detect every replace-and-restore/ABA sequence, detect an in-place content restore preserving identity, or prevent a change after the relevant metadata observation. Contract 01's lack of isolation from malicious same-UID scripts remains unchanged.

Do not strengthen that claim in documentation or tests without a stronger mechanism. Conversely, that limitation does not justify deleting the post-acquisition observation or accepting a same-ledgerId replacement at a different inode.

## 4. Concrete local-acceptance design requirements

### Carry the original opening relationship

src/cli/runtime.ts already returns the gate associated with existingLedger's opening sequence; src/cli/run.ts currently discards it, and DelegationService.resumeLocal constructs a new gate. Remove that repinning path.

Use an internal, non-serializable local-store binding that carries the original PrivateLedgerGate and the exact Ledger object returned by the trusted opening sequence. A suggested internal name is LocalStoreBinding. Its check must reject use with a different Ledger instance, home or invalidated binding. The binding is created by trusted opening composition, not by LocalResumeRequest, MCP arguments, CLI flags, environment or JSON configuration. Do not describe object-reference binding as an OS handle attestation.

Carry this binding through ResumeServiceOptions/LocalResumeService and DelegationService into the local intent guard. Carry the same CallBudget separately from request data. The production CLI captures the budget before resume-specific privateHome/config/open/target/executable preparation. Direct trusted service entry must likewise receive or establish the budget before its own per-call preparation, never manufacture a fresh 30 ms after opening/gate work.

The production local path must fail closed without the opening binding; no fallback to new PrivateLedgerGate(home). Use a specific bound-store operation, not a generic caller-selected “safe I/O” callback. The implementation may preserve low-level synthetic SQL fixture composition as a visibly test-only boundary, but no production local resume may reach an ungated acceptance route. The final review must inspect this call graph rather than accept a type name as proof.

CLI and hud-mcp have independently built module trees. Preserve the original object across their in-process handoff; do not serialize/reconstruct it or rely on an unverified cross-build instanceof identity. Add a compiled CLI-to-MCP composition regression. No new public tool/schema/actor/error taxonomy is required.

### Ordering and deadline

After actual lock acquisition, check the original deadline before starting the metadata pass. Run the pass synchronously, then check the same deadline again before protected authorization/replay/admission. Recheck immediately before COMMIT. No await or arbitrary external callback occurs between the guard and the protected synchronous transaction work.

The order remains current authority and captured source predicates, then canonical replay, then new-intent expectedRun/capability/slot admission. Local store safety precedes local canonical replay as it does today. An already durable result may be returned only through the existing authorized replay/recovery rules; a failed current store proof is not permission to read or authorize a result from a replacement. It also does not erase the historical acceptance.

All opening/gate/preparation/queue/acquisition/body/commit/rollback work attributable to the call remains on its original clock. Gate duration is reported separately as lock-held metadata, not disguised as lock contention or excluded preparation. Shared writers outside the originating MCP/local-resume call keep their own existing lifecycle budgets; this does not retroactively attach the old caller's 30 ms to supervisor execution.

If the metadata pass or acquisition returns after expiry, do not enter the requested-operation body. Mandatory rollback/cleanup may overrun and is retained in evidence. If expiry is detected before commit, roll back the uncommitted requested operation. A successful late COMMIT remains accepted, is reported as an over-budget sample, and permits at most the original one dispatch. An uncertain COMMIT is neither clean refusal nor permission to redispatch. No extra metadata allowance is created.

### Failure and audit discipline

Distinguish local-store-proof failure internally from ordinary business refusal. Include missing/mismatched binding, replaced/unsafe paths, UID/actor failures and unexpected metadata errors, not only three string messages. A proof failure invalidates that local binding for further local admissions in the invocation/service, rolls back the transaction, and suppresses the separate intent.rejected audit. Do not retry, repin, chmod, recreate a proof or perform cleanup/audit mutations relying on the rejected authority. Mandatory rollback/connection cleanup still completes; do not close an actively used shared connection from inside its callback.

Later queued local work using the same invalid binding refuses before mutation. A new invocation may open and validate a legitimate restored private store afresh. Expiry alone does not assert that a safe store has become unsafe.

An optional rejection audit for an otherwise eligible business refusal still shares the original remaining budget. If it is retained for a local request, it uses the same bound store and a fresh post-acquisition metadata pass in that separate audit transaction. If that proof fails, no audit row is written, the binding is invalidated, and the original refusal remains primary. An audit may never turn an earlier durable requested outcome into refusal or be mistaken for acceptance of that operation.

Sources: [opening sequence](https://github.com/CartmanFatass/codex-hud/blob/1561eafec65dcd8e9f9c738dcf7c8e8efc5db6c3/src/cli/runtime.ts#L87-L121), [discarded gate](https://github.com/CartmanFatass/codex-hud/blob/1561eafec65dcd8e9f9c738dcf7c8e8efc5db6c3/src/cli/run.ts#L81-L128), [resume repinning](https://github.com/CartmanFatass/codex-hud/blob/1561eafec65dcd8e9f9c738dcf7c8e8efc5db6c3/packages/hud-mcp/src/delegation.ts#L490-L503), [acceptance and audit](https://github.com/CartmanFatass/codex-hud/blob/1561eafec65dcd8e9f9c738dcf7c8e8efc5db6c3/src/ledger/intents.ts#L188-L237), [audit catch](https://github.com/CartmanFatass/codex-hud/blob/1561eafec65dcd8e9f9c738dcf7c8e8efc5db6c3/src/ledger/intents.ts#L445-L466), [metadata predicates](https://github.com/CartmanFatass/codex-hud/blob/1561eafec65dcd8e9f9c738dcf7c8e8efc5db6c3/src/ledger/local-manager.ts).

## 5. Normative text for serialized recording

The following is the approved substantive amendment. Record it in contract 02 beside the transaction rule and reference it from contract 06. Do not rewrite historical F08, p-06-5.md or p065-budget-local-gate.md as though they originally allowed it.

### Contract 02 addition

> （P065 私有存储元数据例外，2026-11-03）外部准备仍须在 SQLite 写事务外完成。唯一新增例外是受信入口既有私有存储门禁的固定同步元数据复验：实际取得 BEGIN IMMEDIATE 写锁后，在本次受保护的本地授权、canonical 重放、新意图准入或既有受保护写入之前，只可对原门禁的 HUD_HOME、ledger.sqlite、ledger.sqlite-wal、ledger.sqlite-shm 执行一次 lstat/realpath 元数据复验；每路径每种 API 至多一次，提前拒绝或 sidecar 确实不存在时可更少。保持 UID/eUID、规范绝对路径、对象类型、所有权、私有权限、无符号链接、文件单硬链接及原 home/main dev+ino 比较；存在的 sidecar 校验安全属性，不固定其全生命周期 inode，悬空链接不是不存在。原打开门禁必须随同一 Ledger 实例传递，不得在等待后重新钉住路径、以 ledgerId/缓存/监听器代替复验，或由 MCP/CLI 参数选择此权限。该例外不包含内容读取、hash、配置/来源/进程取证、/proc、目录扫描、宿主 CLI、网络、IPC、异步等待、重试或文件修改。门禁失败时不接受目标操作，不以该连接另写拒绝审计，不重新钉住或自动重试；完成必要回滚/清理，并拒绝继续使用已失效本地绑定的准入。其保证是打开前后与取得锁后的元数据观察一致性，不是文件系统命名空间与 SQLite 的原子绑定，也不新增对恶意同 UID 进程的隔离保证。

At contract 02's existing F07 paragraph, append this exact boundary clarification:

> 上述 P065 例外仅复验既有 HUD_HOME/ledger 私有存储安全，不适用于当前调用来源、scope generation、会话记录或 /proc 证据；F07 的事务外取证与锁内前提比较不变。

At the rejection-event paragraph, append:

> 拒绝审计不是无条件补写：P065 原预算耗尽、存储证明失败或提交结果未明时，不启动新的拒绝审计事务。保留主要拒绝及已存在的持久事实；本地业务拒绝的可选审计仍须在同一剩余预算内重新验证原存储绑定。

### Contract 06 P-06-5 and measurement addition

> P-06-5 的 30 ms 是单次调用准备、授权与相关事务的总墙钟，起点、结束点及累计 20 ms 等锁/重试/退避口径沿已批准的 preparation-inclusive 决定；本实现 busy_timeout=0，契约单次上限仍≤10 ms。02 明列的私有存储元数据复验是唯一新增持锁外部 I/O 例外，全部计入原 30 ms，且分别记录实际持锁区间、门禁次数与墙钟。不得另加预算、暂停或重启时钟，不能把固定 API 调用数称为可硬抢占的延迟保证。取得锁后与门禁完成后检查原截止时间，目标操作提交前再次检查；未提交且耗尽则回滚/拒绝，不再接受。成功但迟到的 COMMIT 保留 accepted/原结果并记预算缺陷；结果未明不得报确定未接受或重发外部动作。其余准备仍在事务外；MCP 完整响应、显式 Claude hook 联合计时、wait 与 accepted→started/bound/ready 边界不变。

For T-06-14 and its measurement protocol, replace the unconditional “无外部 I/O 占写事务” assertion with:

> 除 02 明列且逐次计数的私有存储元数据复验外，实际持有 SQLite 写锁期间零应用层外部 I/O；按真实 BEGIN 成功至 COMMIT/ROLLBACK 完成区间观测，不仅包围业务 callback。门禁时间不扣除，保留全部超 30 ms 与失败/未完成样本，逐调用上限不改为 p95。

Append narrowly scoped cross-references in contract 01's local-management boundary/F07 text, contract 03's transaction-preparation sentence, contract 04's shared private-store gate paragraph, and contract 05's P065 budget reference. The cross-references must say that only the contract-02 fixed private-store metadata operation is excepted; no actor, source-proof, writer, capability or supported-profile rule changes. No changes to schema v1, digest bytes, public error/code vocabularies or capability matrix are approved.

Append a decision-log entry to concept §15: Oracle, under the owner's delegated decision authority, approved this precise metadata exception with all numeric budgets and existing authority/commit truth retained; implementation remains subject to the separate release/acceptance gates.

Update P065-BUDGET §§3, 5, 7, 8, 10 and 12 to reference this decision and its exact test/ownership requirements. Section 8 becomes a resolved contract fork, not an unresolved impossibility or a zero-filesystem-I/O implementation promise. Section 12 must still show the actual scheduling disposition, not “implemented” or “accepted”.

## 6. Shared writers and deliberately limited ownership

The shared gate is used under the lock in more places than local resume:

- src/ledger/supervisor.ts, revalidateExecutor, invoked by registerSupervisor and beginSubmission. Ticket, original-executor, typed local_user/MCP initiator and claim checks remain unchanged.
- src/core/run/ledger-port.ts, requestRetirement, authorizeManager, acceptCancel for trusted_local/orphan_policy, and reconciliation. Fixed-run management, policy, scope, slot and no-force-release semantics remain unchanged.
- packages/hud-mcp/src/ledger-registry.ts, LedgerCallerRegistry.register's verify(). This additional caller was not listed in the previous local-gate ruling.

The exception covers only those existing callers' PrivateLedgerGate metadata operation, not their entire callback. No new metadata check is added to periodic heartbeats, status, wait or every generic Ledger transaction. No 30 ms caller budget is propagated into already accepted supervisor execution by this decision.

**New source finding, separate from the selected local guard:** ledger-registry.ts:23–26 and 49–50 call verify() in the transaction, and verify also calls reader.get() twice. LinuxProcessReader.get reads /proc stat/cmdline/environ and namespace data. Those process/content reads remain prohibited by the narrow exception. They are not approved merely because they share a closure with gate.check(), nor because physical registration is startup work. Preserve this as an unresolved startup-writer compliance issue for a separate bounded Oracle disposition; do not silently move or delete its authority checks in P065. It does not block recording this decision, but prevents claiming that the entire existing repository has become globally lock-I/O compliant. [Registry](https://github.com/CartmanFatass/codex-hud/blob/1561eafec65dcd8e9f9c738dcf7c8e8efc5db6c3/packages/hud-mcp/src/ledger-registry.ts#L20-L60), [production process reader](https://github.com/CartmanFatass/codex-hud/blob/1561eafec65dcd8e9f9c738dcf7c8e8efc5db6c3/packages/hud-mcp/src/process.ts#L20-L36).

For the eventual P065 implementation, retain the brief's exact production whitelist. Its local-store work is additive in src/ledger/local-manager.ts, plus the already-owned intents/transaction/budget/CLI/service plumbing. Preserve existing check(actor?) behavior for the excluded shared callers; implement the local bound revalidation explicitly rather than globally weakening, repinning, caching, poisoning or changing that method's policy. If shared helper/callsite semantics must change, stop that portion for a recorded ownership revision or a separate migration. This includes any global fix of the sidecar ENOENT distinction; the new local guard must be correct without quietly claiming that all legacy callers have been migrated.

No production edits to supervisor.ts, core/run/ledger-port.ts, ledger-registry.ts, ledger/runtime.ts, core/run/process.ts or process-census.ts are released here. They remain read-only impact/regression targets. A required change there is not an unnamed “helper” within P065.

The documentation whitelist is explicitly extended for only the amendments in §5 to contracts 01–04, in addition to the brief's existing contract 05/06, concept, P065 and status records. One dispatcher-owned serialized documentation writer must apply them.

Keep new semantic and shared-gate counter tests in the already named p065 test files where practical. A release brief may add only these explicitly bounded test/fixture paths if required for the internal binding API: tests/unit/int-ledger-run.test.ts, tests/unit/b45-parent-offline.test.ts and tests/int/fixture.mjs. Changes there must be additive regression cases or trusted fixture proof plumbing, with existing lifecycle/assertion coverage preserved; they do not authorize real-process code repairs or weakened assertions. Reserve their ownership explicitly in the scheduling release before editing. Existing synthetic low-level fixtures are not evidence of production gate enforcement.

## 7. Required verification

Keep all fourteen deterministic cases and the complete real-clock matrix in P065-BUDGET. The following precision is mandatory, not a substitute for that matrix:

1. Deterministically mutate home/main privacy or identity after the last precheck while queued, during actual contention/backoff, and after BEGIN succeeds but before the local guard. Assert the named refusal stage, no requested-operation body/admission, and no new run/claim/slot/idempotency/accepted event/launch. Do not rely only on sleep races.
2. Test a same-ledgerId, equivalent-SQL, different-inode replacement of home/main. Use valid synthetic prepared copies. Incidental DBMOVED/corruption failure is not the sole evidence that the guard worked. Add post-acquisition chmod with unchanged SQL as the independent negative control.
3. Replace after existingLedger opens but before resumeLocal. Verify original binding is carried and refused, not repinned. Test wrong Ledger/home binding and missing production binding. Verify a fresh valid invocation after restore remains possible.
4. Cover wrong UID/eUID, owner, mode, malformed/forged actor, nonregular objects, symlink and hardlink for relevant objects. Include stable dangling WAL/SHM symlinks and non-ENOENT errors. Preserve safe absent sidecars and normal SQLite sidecar lifecycle without lifetime inode pinning.
5. Cause proof failure with enough budget still remaining. Verify no rejection audit, no second acceptance attempt, no invalid-binding queued local admission, and completed rollback. Separately change the store before an otherwise permitted local rejection-audit transaction and verify that audit also refuses without replacing the primary error.
6. Instrument actual writer-lock ownership, including the await handoff after successful acquisition through final COMMIT/ROLLBACK. Match every allowed filesystem call to the fixed gate/target/phase/count. All other application file/content/process/CLI/network/IPC work remains zero for the measured P065 transaction. Test instrumentation must distinguish the fixture's deliberately injected adversary from system-under-test calls; it must not hide production I/O outside a callback-only interval.
7. Show a valid unchanged-store local resume and canonical same-key replay with one launch, including replay after currentRun has advanced. Store/current authority still precedes replay; new expectedRun/capability/slot admission follows it. Reject model admin/actor attempts and keep local_user separate from trusted_local management. An always-refuse design fails.
8. Inject slow opening, configuration, source/executable preparation and gate work under the one original clock. Test exact boundary sides, queued expiry, late acquisition, expiry after gate and before COMMIT, cumulative waits and oversleep, successful-late COMMIT and uncertain COMMIT. No accepted operation is falsified; no duplicate dispatch occurs. A gate overrun is still a failed performance sample even when refusal is correct.
9. Exercise the real compiled CLI runtime-to-MCP service handoff in addition to source-level fixtures. Check that proof and budget survive separate build output module graphs without repinning or a later start timestamp.
10. Preserve shared-writer tests for F05 manager audit/forged actors, unsafe home/store, typed stored local_user executor, revoked claims, original-writer/orphan-policy boundaries and one-connection overlap. Source locations include int-ledger-run.test.ts:90–132, 220–333, 432 onward and 650–682, plus b45-parent-offline.test.ts. Verify unchanged shared gate behavior and no newly added periodic probes. Registry tests do not turn its separate process-I/O defect into a pass.
11. For each new behavior provide an old-tree failure or narrowly reverted behavioral negative control. Deleting a new symbol and observing an import failure is insufficient. At minimum revert original-gate propagation, post-acquisition observation, post-gate expiry, and unsafe-audit suppression independently.

All original commands, timeouts, isolated HOME/HUD_HOME/TMPDIR, cleanup-by-owned-PID, raw logs, sample/summary paths, runtime identities and sanitized evidence rules remain. If the extra shared suites are not already covered by the required aggregate command, the release brief must add their exact compiled invocation and timeout before implementation. Do not run a wildcard that brings forbidden real-TTY/tmux/Herdr work into cloud.

Real-clock qualification remains production-clock/real-SQLite, at least 50 warmups and 1,000 measured calls per declared non-wait tool/combination with H/R=1/1 and 2/10, heartbeat and actual lock contention, success/refusal/busy split, cold/first-use and concurrent accepted observation-storage load, all attempts retained, three isolated series on each supported Node family. Report n/p50/p95/p99/max, every over-30 sample, stage/gate counts and durations, wait/backoff, outcome and source/build/host identity. The exception has no “metadata slow sample” exclusion and no p95 replacement of the 30 ms upper bound.

No cloud result promotes a capability cell or substitutes for real Claude joint 150/50 timing, real-harness closure, Herdr/tmux or formal supported-platform/B14 evidence. Owner-run local results remain independently supplied and reviewed. This review ran none of these checks.

## 8. Queue, release and merge gates

The current compared active heads remain HYG2 `2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31`, RUNZ1 `86ca8887fcfb331750ec6dc5518d69134cb795e4`, S3F `bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60`, and PERF `e5ccee38165b30809bd537e7f31cfed7f227f152`. Their inspected production/test diffs do not overlap the conditional P065 whitelist or the three bounded fixture additions above. B10B-S3F-NEXT's released facts/projection ownership is also separate. This is ownership evidence, not a scheduling release or acceptance of any of those branches. Benchmarks still require one isolated measurement workload at a time.

**P065 may not start implementation on this report alone.** First:

1. Archive this decision without overwriting its predecessors, record the exact contract/brief/status amendments through one documentation owner, and remove the now-resolved architecture ambiguity without claiming implementation acceptance.
2. Obtain the separately recorded fresh scheduling/ownership ruling required by P065 §12 and queue-progress. It must reserve the exact source/test/docs set, inspect then-current heads and uncommitted active ownership, name the accepted universal-hud base, and identify this as an independent follow-on to the approved wave-1 P-06-5 consultation. The decision may be made under the owner's existing delegation; no additional owner permission is needed.
3. Start only from that pinned accepted integration image. Do not import unaccepted HYG2/RUNZ1/S3F/PERF/NEXT/B10D code to make tests pass. Revalidate any intervening source changes. The startup-registry issue remains explicitly separate unless its own bounded disposition changes ownership.

This design does not require waiting for the owner's local tests merely to prepare the amendments and release ruling. It also does not release DOC2/TPD1 before B10B-S3F merges, later Inspector/data work, or B10D/LEG1/RCP1 out of their recorded order. Do not renew any other package's consumed fix rounds.

Implementation acceptance and merge are distinct later gates:

- The complete released brief is satisfied, including meaningful failing-before tests, preserved shared security behavior, full declared measurement populations on Node 22 and 24, and retained failures/unrun stages.
- A fresh independent Oracle verifies the exact final diff, report, raw checks, negative controls, ownership and measured populations and returns accept. Design approval here is not that verdict.
- The full README check set is green on the actual merged tree, with only the permitted single isolated known-flake rerun and both logs retained. A recurring failure, missing stage, denied prerequisite or P065 over-budget sample is not waived.
- One merger, --no-ff into universal-hud, no main changes, force-push, history rewrite, node_modules staging or unaccepted dependency integration. Push only after the required gate, then factual STATE and engineering-plan status updates.
- Local-only qualification stays unverified until applicable authorized evidence is supplied and reviewed; production claims remain limited accordingly.

**Final disposition: the narrow metadata exception is approved and the local-gate contract fork is closed. The implementation remains held for documentary synchronization and its separately recorded scheduling release. Numeric budgets, security predicates, positive local support, committed truth, queue order and final acceptance/merge gates are unchanged.**