# P065-BUDGET: local private-store gate architecture ruling

Date: 2026-11-03.

**Decision: HOLD. No nontrivial implementation using the presently supported interfaces can satisfy all of section 8's requirements unchanged.** Preserve the current local-gate behavior. Do not replace it with a pre-lock snapshot, ledgerId comparison, watcher, or a callback that merely checks cached evidence. The preparation-inclusive 30 ms decision remains approved and unchanged; this ruling neither relaxes that deadline nor releases P065 implementation.

This is a bounded impossibility finding about the current interface and trust model, not a claim that operating systems can never provide stronger file capabilities. A different runtime/VFS, an enforced namespace protocol, a narrower supported feature, or an explicit metadata-I/O exception would change the premises and needs its own recorded decision.

## 1. Inspected evidence and scope

The complete repaired brief was read at universal-hud commit `cd555891637b0e14288fa7a769532284c2899a0e`. Source inspection was pinned to `5a99fac7bb66123e7522b0e4a1824f83ed69c386`; GitHub's comparison to `cd555891637b0e14288fa7a769532284c2899a0e` contains only the repaired P065 brief, so the source findings apply to the repaired snapshot. The damaged intermediate brief is not a specification.

Binding inputs reviewed include the complete conditional brief, the approved P-06-5 question and historical ruling, F08, contracts 01–07's relevant identity/execution/management/budget/privacy clauses, the plan's ownership map, STATE, the queue-progress ruling, the workflow, and the active-package ownership restrictions. Source and tests below were read through the repository connector. Official Node and SQLite API documentation was consulted for the proposed identity substitutes.

No source, tests, branches, repository files, local files, security settings, capabilities or runtime dependencies were changed. No builds, tests, probes, local access or real-harness operations were performed. This is design/source evidence, not a reproduced failure or performance qualification.

Sources: [repaired brief](https://github.com/CartmanFatass/codex-hud/blob/cd555891637b0e14288fa7a769532284c2899a0e/docs/cloud/P065-BUDGET.md), [approved scope](https://github.com/CartmanFatass/codex-hud/blob/cd555891637b0e14288fa7a769532284c2899a0e/docs/handoff/questions/P-06-5.md), [contract 02](https://github.com/CartmanFatass/codex-hud/blob/cd555891637b0e14288fa7a769532284c2899a0e/docs/contracts/02-execution.md#L68-L86), [contract 06](https://github.com/CartmanFatass/codex-hud/blob/cd555891637b0e14288fa7a769532284c2899a0e/docs/contracts/06-observation.md#L243-L253).

## 2. What must be preserved, and what the existing gate actually proves

`PrivateLedgerGate` pins the observed device/inode identities of HUD_HOME and ledger.sqlite. Its current check also validates canonical absolute paths, object types, ownership, private mode, no symlinks, a single hard link for files, real/effective UID agreement, and existing WAL/SHM safety. Missing WAL/SHM files are intentionally allowed. The sidecars' identities are not pinned for their entire lifetime; normal SQLite sidecar creation/removal must not accidentally become a new refusal policy.

`acceptIntent` invokes this check after acquisition and before local authorization/replay. Thus a persistent replacement or privacy change that occurred during queueing/acquisition can be refused before the requested operation is accepted. Checking only before acquisition removes a real observation point.

The current gate is not a namespace lock or proof of immunity to every same-UID race. It cannot detect every transient replace-and-restore sequence between observations, an in-place content restore retaining an inode, or every change occurring after its last check. Contract 01 explicitly does not isolate malicious same-UID scripts. This limitation does not license deleting the existing after-acquisition observation, nor does it justify advertising an atomic filesystem-to-COMMIT guarantee that the implementation never had.

A same-ledgerId replacement at a different inode must remain a negative case. Contract 02 deliberately preserves ledgerId across backup/restore. A legitimate restoration followed by a fresh invocation is distinct from silently accepting a replacement during an already pinned invocation.

Sources: [gate implementation](https://github.com/CartmanFatass/codex-hud/blob/cd555891637b0e14288fa7a769532284c2899a0e/src/ledger/local-manager.ts#L11-L56), [acceptance ordering](https://github.com/CartmanFatass/codex-hud/blob/cd555891637b0e14288fa7a769532284c2899a0e/src/ledger/intents.ts#L188-L237), [local authority boundary](https://github.com/CartmanFatass/codex-hud/blob/cd555891637b0e14288fa7a769532284c2899a0e/docs/contracts/01-identity.md#L76-L85).

## 3. Why no supported in-scope substitute is sufficient

Consider an otherwise admissible local resume and its last permitted filesystem observation before the successful write-lock acquisition.

1. In execution A, the private store remains unchanged. The implementation must be able to accept this ordinary supported operation.
2. In execution B, after that observation but before the callback, another process changes HUD_HOME or the ledger to a nonprivate mode. All SQL rows, ledgerId, expectedRun, capabilities, slot state, in-memory proof fields and clock readings can be identical to A. An already opened database connection does not itself establish current directory/file privacy.
3. A second B example replaces the pinned pathname with a different private inode containing the same ledgerId and relevant SQL contents. An existing connection can remain attached to the old filesystem object while the pathname names the replacement. SQLite's public contract does not guarantee that every such operation becomes a detectable SQL failure.
4. Under the proposed constraints, the implementation has neither an authoritative post-acquisition filesystem observation nor an OS mechanism preventing these changes. Its permitted authority observations are indistinguishable between A and B.
5. Therefore a decision that accepts A can also accept B. Refusing every possible A would be fail-closed but would remove positive local resume support; that is a feature/supported-scope change, not a solution meeting the brief.

The permission-change example does not rely on undefined behavior from renaming an open database. It alone disproves replacement of the entire private-store gate with SQL state. The same-ID inode example separately establishes why ledgerId cannot meet the required replacement assertion.

This is not fixed by setting busy_timeout to zero. SQLite lock acquisition and the filesystem namespace are different synchronization domains. Removing an await removes one JavaScript scheduling opportunity, not another process's opportunity to change the path. The current `await acquireWriteLock(...)` also leaves an explicit handoff after successful acquisition and before the callback; a deterministic test must cover it.

The supported Node baseline matters. The documented Node 22.13 DatabaseSync API exposes synchronous SQL, connections and sessions, but no supported database-file descriptor/inode or general sqlite3_file_control binding. Node 24.0's `location()` supplies a pathname, not an inode/ownership attestation. A solution relying on a newer or native-only API is not a solution for the unchanged runtime range. [Node 22.13 SQLite API](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html), [Node 24.0 SQLite API](https://nodejs.org/download/release/v24.0.0/docs/api/sqlite.html).

SQLite documents a C/VFS `SQLITE_FCNTL_HAS_MOVED` operation, but the current Node interface does not expose it. Even that operation is not a complete HUD_HOME/UID/mode/hardlink/sidecar gate. SQLite also documents that renaming/unlinking an open database is unsafe and can separate connections sharing a pathname; this is not a supported replacement-detection protocol. [SQLite file-control opcodes](https://www.sqlite.org/c3ref/c_fcntl_begin_atomic_write.html), [SQLite open-file rename/unlink warning](https://www.sqlite.org/howtocorrupt.html#_unlinking_or_renaming_a_database_file_while_in_use).

## 4. Rejected shortcuts

- **Precheck before queue, before each retry, or immediately before BEGIN:** useful early refusals, but none preserves the observation after the actual successful acquisition. The final gap remains.
- **SQL ledgerId, generation, application/schema version, digest or random witness:** copied state can retain these values, and a live connection can still address the original object. A SQL revision witnesses participating database writes, not an independent pathname or permission change. `PRAGMA data_version` reports other-connection commits, not this complete OS predicate. [SQLite data_version](https://www.sqlite.org/pragma.html#pragma_data_version).
- **Pinned separate file descriptor:** preserving an open object does not prove that the current pathname still names it or is private. The supported Node API also does not bind a separately opened descriptor to DatabaseSync's actual main/WAL/SHM handles. Ad hoc `/proc/self/fd`, hard-link, URI or second-SQLite-library routes are not an approved replacement protocol.
- **Watcher/cache/short TTL:** notifications can be delayed, coalesced or absent. Lack of an invalidation is not a proof. A helper acknowledgment after acquisition would introduce a new mechanism and work while holding the lock; it is not a free in-memory check.
- **Release/check/reacquire, deferred read transaction followed by upgrade, or two-phase intent acceptance:** the next acquisition has the same gap. Committing before the final check violates zero-new-acceptance on failed proof, and a later refusal cannot undo durable truth.
- **Put filesystem work in a SQL function, acquisition helper, or renamed pre-commit hook:** this still performs external I/O while the SQLite writer lock is held. A change of function name or accounting label does not satisfy contract 02/P-06-5.
- **Promise.race, a timeout response, or discard of a slow operation:** these cannot prevent a still-running synchronous acquisition/commit from later succeeding and must not produce a false not-accepted response.

The approved absolute deadline limits admission and measures overruns. It does not make stale identity evidence authoritative.

## 5. Additional source findings relevant to any eventual route

### Preserve the opening authority instead of repinning

`src/cli/runtime.ts:87–121` returns `{ ledger, gate }`, with the gate checked around the open sequence. `src/cli/run.ts:84` discards that gate. `resumeLocal` constructs a new gate at `delegation.ts:492`. A replacement between those stages can be pinned as the new normal rather than compared with the original invocation's store.

Passing the original trusted gate through the CLI/service boundary is necessary. It is not sufficient to solve the acquisition race, and a new branded object does not by itself create an atomic SQLite-handle binding. The eventual specification must say exactly which observed opening relationship it relies on, and must not claim stronger ABA resistance without a mechanism.

### Refused store proof must not cause an unguarded rejection audit

`src/ledger/intents.ts:445–466` currently attempts a separate `intent.rejected` transaction for most thrown errors. `unsafe_ledger_path`, `ledger_path_replaced` and `unauthorized_local_manager` are not excluded. A local gate refusal can therefore be followed by a write on the same unverified connection.

Any eventual local-gate repair must distinguish these failures internally and suppress that audit. Do not retry the requested mutation, recapture a replacement, or perform cleanup/rejection writes that assume the failed store proof. Complete mandatory transaction cleanup, retain the primary refusal, and prevent later queued local admissions from using a known-invalid binding. This is not permission to add a public error taxonomy or erase an earlier durable result.

### The shared gate has other lock-held callers

The conflict is not limited to `acceptIntent`:

- `src/ledger/supervisor.ts:33–52`, called by `registerSupervisor` at 120–123 and `beginSubmission` at 232–234.
- `src/core/run/ledger-port.ts:287–288` in compared writer work; 330–331 in `authorizeManager`; 422–425 in cancel; 609–615 in reconciliation.

These paths enforce execution-ticket, original-writer, trusted_local management and orphan-policy semantics. A global weakening of `PrivateLedgerGate.check()` would affect them even if their source files were not edited. The P065 whitelist explicitly excludes both production files. Preserve their behavior unless a separate exact migration is authorized. Post-acceptance work is not silently pulled into the caller's 30 ms simply because it uses the same gate.

Sources: [CLI open gate](https://github.com/CartmanFatass/codex-hud/blob/cd555891637b0e14288fa7a769532284c2899a0e/src/cli/runtime.ts#L87-L121), [CLI handoff](https://github.com/CartmanFatass/codex-hud/blob/cd555891637b0e14288fa7a769532284c2899a0e/src/cli/run.ts#L81-L128), [resume entry](https://github.com/CartmanFatass/codex-hud/blob/cd555891637b0e14288fa7a769532284c2899a0e/packages/hud-mcp/src/delegation.ts#L490-L503), [rejection audit](https://github.com/CartmanFatass/codex-hud/blob/cd555891637b0e14288fa7a769532284c2899a0e/src/ledger/intents.ts#L445-L466), [supervisor gate](https://github.com/CartmanFatass/codex-hud/blob/cd555891637b0e14288fa7a769532284c2899a0e/src/ledger/supervisor.ts#L33-L73), [real writer port](https://github.com/CartmanFatass/codex-hud/blob/cd555891637b0e14288fa7a769532284c2899a0e/src/core/run/ledger-port.ts).

## 6. Exact decision needed if implementation is to proceed

The smallest candidate change is an **explicit narrow exception permitting the existing private-store metadata revalidation after actual writer acquisition and before local authorization/replay/mutation**, while preserving the original opening gate and every numeric budget. This is my preferred direction for a separately scoped decision, rather than introducing a native service or weakening store identity.

It is a real change to the no-external-I/O rule, not an interpretation that already complies. It is not approved by this ruling and is not a released design. Its scope would need to name the fixed home/main/WAL/SHM metadata checks, prohibit file-content reads, hashes, CLI/process discovery, network work and arbitrary callbacks, and specify how the original connection/opening authority is carried. It must state the existing observation-based guarantee honestly, rather than promise atomic immunity to malicious namespace races. A fixed number of metadata calls is bounded work, not a hard wall-clock guarantee; a stalled syscall can still exceed 30 ms and remains a qualification defect.

The other substantive directions are materially larger: introduce and qualify an enforceable native/OS/database binding mechanism, or narrow positive local-management support. Neither is authorized here. SQLITE_FCNTL_HAS_MOVED alone would not complete the gate. A documented promise that users will not replace the store while open would change the supported-use guarantee and cannot silently substitute for today's detection.

Accordingly, record one reserved question: **may the narrowly specified metadata safety check be an explicit exception to the lock-held external-I/O prohibition, with the 30/20/0 ms accounting and existing local authority/replacement behavior retained, or must a different supported mechanism be separately designed?** Under the owner's delegated workflow this can be routed for an explicit recorded disposition without repeatedly asking permission for the read-only research itself. Until that disposition, no implementer should improvise a compromise.

## 7. Required tests for the eventual approved mechanism

Keep all fourteen deterministic cases and all real-clock populations in the conditional brief. Add the following precision to its local-gate case; these are required future assertions, not tests run by this consultation.

1. Force a change after the last precheck while queued, during real lock contention/backoff, and after the successful acquisition but before the mutation callback. Use a trusted internal phase seam/barrier, not a race based only on sleeps. Assert the guard's refusal stage, zero requested-operation callback/admission, and zero new run/claim/slot/idempotency/accepted event/launch.
2. Cover both HUD_HOME and ledger pathname replacement, including a different inode with the same ledgerId and equivalent relevant SQL rows. Build copies safely in synthetic fixtures; do not make incidental SQLite corruption or DBMOVED errors the sole passing signal for the gate assertion.
3. Include a post-acquisition chmod/privacy mutation with unchanged SQL data. This is a direct negative control for pre-lock-only/SQL-only solutions and avoids depending on live-rename behavior.
4. Replace the store after `existingLedger` opens it but before `resumeLocal` runs. Verify the original gate is carried and the replacement is refused, not newly pinned. A fresh later invocation on an otherwise valid restored store is a separate case.
5. Preserve UID/eUID, malformed/forged actor, wrong-owner, symlink, hardlink, nonregular and nonprivate home/main/sidecar refusals. Preserve valid sidecar absence and ordinary WAL/SHM lifecycle behavior. Do not require sidecar lifetime inode stability that the old gate did not require.
6. Verify local proof failure does not trigger `intent.rejected`, a second acceptance attempt, or mutation on an invalidated old connection. Verify rollback and subsequent queued work's disposition. Preserve earlier independent durable facts without calling them acceptance of this operation.
7. Instrument the actual writer-lock interval, not merely the user callback. Under today's unchanged rule the permitted external-probe count is zero; any future metadata exception must be separately enumerated and tested, not hidden outside the measurement interval.
8. Preserve an unchanged private-store success and canonical same-key replay with one launch; current authority precedes replay, new expectedRun/slot/capability admission follows replay, and no MCP argument can select local authority. An always-refuse implementation does not pass.
9. Include slow gate/preparation/opening, queued expiry, late acquisition, pre-COMMIT expiry and successful-late COMMIT with the one original clock. All pre-call-prefix work assigned by the brief remains charged. A late committed result stays accepted/recoverable and cannot launch twice.

Retain the existing real-writer checks in `tests/unit/int-ledger-run.test.ts:90–132` (F05 authority/audit/privacy), 220–246 (store/symlink/privacy), 248–333 (stored local_user executor), 432 onward (revoked local resume claim), and 650–682 (one-connection overlap), as relevant regression evidence. The P065 brief does not currently authorize edits to that file. Existing B11 unsafe-home and local resume/replay tests remain required. These tests do not presently constitute complete acquisition-window replacement coverage.

## 8. Ownership and release disposition

**Implementation remains HOLD. Section 8 is resolved as a demonstrated in-scope conflict, not as a usable implementation design. Section 12's release requirements are not met.**

The existing conditional whitelist is not enlarged by this report. Passing the original gate and deadline through `src/cli/hud.ts`, `src/cli/run.ts`, `src/cli/runtime.ts`, `packages/hud-mcp/src/delegation.ts`, and the allowed ledger files fits the candidate boundary, but cannot begin while the design remains incompatible. The audit requirement is in the already named `src/ledger/intents.ts` scope once a route is released.

A metadata exception would require an explicit amendment to contract 02's transaction rule as well as contract 06 and the conditional brief; contract 02 is not in the brief's current documentation whitelist. Add matching relevant cross-references, the decision log and the precise test rule through serialized documentation ownership. Do not rewrite historical F08 or the prior recommendation. If the chosen solution changes shared writer-gate semantics, explicitly add `src/ledger/supervisor.ts`, `src/core/run/ledger-port.ts` and their regression test ownership, or split that migration into a separately ordered package. Merely changing `check()` globally is not an additive P065-local fix.

A native/profile route needs a new bounded brief naming its runtime/API/build/distribution/platform support, capability evidence and failure policy. It cannot be introduced through an unnamed new file or a dependency update within P065. HYG2's runtime ownership and RUNZ1's process ownership must be rechecked, not assumed disjoint.

Only after a compliant mechanism or explicit changed premise is recorded should a fresh scheduling/ownership ruling reserve an implementation slot against current STATE/heads and a pinned accepted universal-hud base. Do not import unaccepted HYG2/RUNZ1/S3F/B10D work. Read-only preparation and existing authorized wave-1 work may continue; this ruling does not release DOC2, TPD1, later data/Inspector work, or B10D ahead of their prerequisites.

All remaining gates are unchanged: one preparation-inclusive absolute 30 ms; busy_timeout remains zero in this implementation and no more than 10 ms in the contract; all lock/retry/backoff expenditure at most 20 ms within the same call; truthful late/uncertain commit handling; separate 50/150 ms measurements and wait rules; no capability promotion; complete population evidence on Node 22 and 24; fresh Oracle acceptance; full green merged-tree checks with recorded permitted flake handling; local-only qualification remains unrun until applicable authorized evidence is supplied.

**Final disposition: exact blocker and bounded decision options delivered. No code release, no accepted implementation, no gate waiver, and no further local access or testing authorized by this consultation.**