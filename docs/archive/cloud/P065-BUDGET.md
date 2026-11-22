# Brief P065-BUDGET: preparation-inclusive authorization budget

Date: 2026-11-03. Tier M, shared control-plane correctness and measurement. Intended path: `docs/cloud/P065-BUDGET.md`.

**Status: scope and ownership remain released on base `26f6fba36948e6c96e2e109cb374c0d4dbb9ab22`; candidate 2 is frozen WIP pending documentary recording and explicit dispatcher admission under the wave-1 resource-window ruling.** The owner approved the preparation-inclusive budget interpretation. Under the owner's delegated decision authority, the [metadata-exception ruling](rulings/p065-metadata-exception.md) approves the precise fixed private-store metadata exception and closes section 8's architecture fork. This document synchronizes that approved decision; it does not establish implementation acceptance or change the queue. Section 12 records the scheduling release and current frozen-candidate disposition from the corrected [six-design ruling](rulings/p065-six-design-dispositions.md). Its six questions are resolved, but no compute window, implementation acceptance, qualification or merge is granted.

The original brief was a read-only consultation. This 2026-11-03 synchronization records only the approved documentation amendments. This documentary synchronization claims no source/test execution, capability promotion or local-only qualification; candidate 2 remains unaccepted WIP.

## 1. Authority, inspected base and binding inputs

Inspected `universal-hud` at `2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e`.

The recorded owner approval in `docs/handoff/questions/P-06-5.md` controls the decision status. The historical text in `docs/cloud/rulings/p-06-5.md` remains a verbatim recommendation written before approval; do not erase that history or treat its old pending-approval sentence as revoking the later approval. The approved decision includes preparation in the existing 30 ms, without a new preparation allowance or a lock-acquisition clock reset.

Read these binding inputs before any later implementation:

- `AGENTS.md`, `docs/cloud/dots.md`, `docs/cloud/README.md`, `docs/handoff/STATE.md` and the recorded queue-progress ruling of 2026-11-03. For this consultation the last was supplied as the dispatcher transcript `queue-progress-20261103.txt`; archive it under the ordinary rulings location before relying on it as a repository record.
- `docs/universal-hud-engineering-plan.md` §3's complete-brief requirements, §4's B1/B2/B4/B5/B6/B11/B14 responsibilities, and `docs/ARCHITECTURE.md` §8. Read `src/CLAUDE.md` and any applicable directory notes on the eventual base.
- `docs/handoff/questions/P-06-5.md`, `docs/cloud/rulings/p-06-5.md`, and `docs/reviews/2026-11-01-chatgpt-pro-f08-hook-budget.md`.
- Contract 01's current-source/generation and narrow local-user authority rules; contract 02's authorization → canonical replay → new-intent admission order, external-preparation rule, immutable ledger identity and execution-ticket semantics; contract 03's resume/cancel/wait rules; contract 04's typed writer/manager boundaries; contract 05's capability evidence and trusted startup preflight rules; contract 06 P-06-4/5/6, T-06-14 and measurement protocol; contract 07's public evidence/privacy boundaries.
- `docs/universal-hud-concept.md` §15. Preserve all unrelated decisions.
- The corrected [six-design ruling](rulings/p065-six-design-dispositions.md), [replay/expiry/clock ruling](rulings/p065-replay-expiry-clock.md), and [wave-1 resource windows](rulings/wave1-resource-windows-20261103.md). The six-design ruling supplies the approved qualification-composition amendment and status/wait applicability clarification below; it grants no compute lease.
- The source and tests enumerated below, plus the active HYG2, RUNZ1, B10B-S3F and B10B-S3F-PERF briefs and the B10D route ruling.

Current implementation facts verified at the pinned base:

1. `packages/hud-mcp/src/server.ts:78–102` starts before tool argument validation and source resolution, then carries a number into `invoke`.
2. `packages/hud-mcp/src/delegation.ts:202–231` constructs the 30 ms deadline but gives `authorizeRootCall` a relative lock allowance. Its later paths do not all receive one shared cumulative account.
3. `delegation.ts:417–445` checks before `acceptIntent`, but passes another relative allowance. `src/ledger/intents.ts:197–207` performs additional normalization, creates a new relative write deadline and checks the local gate inside the write callback.
4. `src/ledger/ledger.ts:24–53` controls queue/acquisition time, then awaits `acquireWriteLock`, invokes the callback and commits without an original call deadline. A zero numeric allowance deliberately allows a nonblocking low-level attempt; it must not become an expired-call escape hatch.
5. `src/ledger/handshake.ts:23–40` already checks before and after its callback, but still relies on a relative lock allowance and does not observe a late synchronous COMMIT as a separate stage.
6. `packages/hud-mcp/src/read-control.ts:299–389` preserves durable cancellation truth and stops after reconciliation consumes its present allowance. The shared budget must preserve that protection, not replace it with a fresh allowance.
7. `delegation.ts:490–503` currently performs local-gate construction/checking before starting its 30 ms clock. The CLI also performs configuration, store opening, target lookup and executable preparation before calling that service; those costs must be identified honestly, not hidden by timing only the final service function.
8. `src/ledger/local-manager.ts:14–54` checks current UID/eUID, canonical private paths, home/ledger dev+ino, ownership, mode, regular-file/no-symlink/nlink conditions and WAL/SHM safety. A timestamp or `ledgerId` alone does not replace those checks.

## 2. Goal and non-goals

Use one trusted per-call monotonic budget through per-call source/preparation work, queued ledger work and every applicable authorization/acceptance/handshake/report/cancel transaction. Prevent additional uncommitted acceptance after expiry, share lock-wait expenditure across transactions, and report actual overruns without falsifying committed outcomes.

Separate deterministic semantic tests from production-clock qualification. Reduce test dependence on unrelated scheduling without weakening the real gate.

This is not a performance-threshold relaxation, a new capability, a schema migration, a new authority source, a change to supported runtimes, a general ledger rewrite, a collector/worker project, or permission to fix unrelated full-suite failures. It does not implement queued B9/B16 fields, Inspector actions, B10D fairness/recapture, LEG1 or RCP1. It does not make status/wait into writers or make the 30 ms cover asynchronous execution through started/bound/ready or the cancellation ladder.

## 3. Conditional ownership whitelist

The following is the maximum bounded file set for the budget work, not permission to change every file and not a dispatch release. The [metadata-exception ruling](rulings/p065-metadata-exception.md) §6 retains the exact production whitelist and bounds the optional fixture additions below; section 12 now records the separate scheduling/ownership release and the outstanding resource-admission condition. New files below are explicitly named.

Production files:

- New `src/ledger/call-budget.ts`: small internal budget/clock/accounting types and helpers, with no scheduler, database schema, daemon or public configuration.
- `src/ledger/transaction.ts` and `src/ledger/ledger.ts`: original-deadline-aware queue/acquisition/callback/commit handling and accounting, while preserving the existing low-level nonblocking and unrelated-writer behavior.
- `src/ledger/call-context.ts`: carry the same budget through root authorization without changing scope/generation rules.
- `src/ledger/intents.ts`: preserve authorization/replay/admission order; use the original budget for intent acceptance and optional rejection auditing; support truthful replay/committed-result handling.
- `src/ledger/handshake.ts`: same-budget handshake/report commits and unchanged binding/claim/report authorization.
- `src/ledger/reconcile.ts`: optional shared budget through the MCP cancel's reconciliation and cancel-intent transactions; unrelated reconciliation semantics unchanged.
- `src/ledger/local-manager.ts`: only the additive original-store binding and fixed local acceptance revalidation approved in the [metadata-exception ruling](rulings/p065-metadata-exception.md) §§3–4 and 6. **Candidate 2 mutating/compute work remains held until section 12's current recording and explicit dispatcher-admission conditions are met.** Preserve existing `check(actor?)` behavior for excluded shared callers; no global weakening, repinning, caching, poisoning or sidecar-policy migration.
- `packages/hud-mcp/src/server.ts`: establish/carry the budget at the existing or earlier request boundary; retain the full-response measurement boundary and external result shapes.
- `packages/hud-mcp/src/resolvers.ts` and `packages/hud-mcp/src/hook/resolve.ts`: internal budget checks/accounting around existing per-call bounded evidence work, with no change to identity eligibility, hook producer behavior or source selection.
- `packages/hud-mcp/src/delegation.ts`, `packages/hud-mcp/src/handshake.ts`, `packages/hud-mcp/src/read-control.ts`: carry the same budget and maintain post-commit protections.
- `src/harness/codex/profile.ts`, `src/core/launch/brief.ts`, `src/core/launch/fingerprint.ts`: bounded preparation checkpoints/accounting and trusted dependency seams only; no new cache, changed fingerprint, weaker file validation, new subprocess or capability promotion.
- `src/cli/hud.ts`, `src/cli/run.ts`, `src/cli/runtime.ts`: local-resume timing propagation and passing the existing pinned store authority rather than silently repinning a possibly replaced path. Do not change other CLI commands or their authority models.

New test/evidence-driver files:

- `tests/unit/p065-budget.test.ts`
- `tests/unit/p065-local-gate.test.ts`
- `tests/unit/p065-budget-fixture.ts`
- `tests/hud-mcp/p065-budget.test.ts`
- `tests/int/p065-budget-benchmark.mjs`
- `tests/int/p065-ledger-holder.mjs`

Existing test files allowed only for additive cases or passing the trusted timing/proof dependency while preserving their business assertions:

- `tests/unit/ledger-write.test.ts`
- `tests/unit/b6-cancel.test.ts`
- `tests/unit/b6-wait-status.test.ts`
- `tests/unit/b11-cli.test.ts`
- `tests/unit/b21-capacity.test.ts`
- `tests/unit/b45-delegation-fixture.ts`
- `tests/unit/b45-handshake-fixture.ts`
- `tests/hud-mcp/authorization.test.ts`
- `tests/hud-mcp/delegation.test.ts`
- `tests/hud-mcp/resume-expected-run.test.ts`
- `tests/hud-mcp/handshake.test.ts`
- `tests/hud-mcp/hook-source.test.ts`
- `tests/hud-mcp/b20-advice.test.ts`
- `tests/hud-mcp/handshake-benchmark.test.ts`

The existing `tests/int/b45-delegation-benchmark.mjs` and `tests/int/b45-mcp-stdio-benchmark.mjs` are read-only comparators for this package. Preserve their original evidence. The new driver supplies complete P065 populations rather than retroactively relabeling their 200-sample partial measurements as full qualification.

The [metadata-exception ruling](rulings/p065-metadata-exception.md) §6 permits a release brief to reserve only these additional existing test/fixture paths if required for the internal binding API: `tests/unit/int-ledger-run.test.ts`, `tests/unit/b45-parent-offline.test.ts` and `tests/int/fixture.mjs`. The [scheduling release](rulings/p065-budget-release.md) §5 explicitly reserves these three paths within those limits; editing still waits for its resource admission. Changes are limited to additive regression cases or trusted fixture proof plumbing, preserving lifecycle/business assertions; they do not authorize real-process repairs or weakened assertions. Keep new cases in the already named p065 files where practical.

Documentation amendments, serialized by the dispatcher from the Oracle-approved text:

- `docs/contracts/01-identity.md`, `docs/contracts/02-execution.md`, `docs/contracts/03-lifecycle.md` and `docs/contracts/04-supervision.md`: only the exact transaction, F07, rejection-audit and narrow cross-reference amendments in the [metadata-exception ruling](rulings/p065-metadata-exception.md) §5.
- `docs/contracts/06-observation.md`: P-06-5, T-06-14 and measurement-protocol clarification only.
- `docs/contracts/05-capabilities.md`: matching P065 cross-reference; no capability promotion or matrix change.
- `docs/universal-hud-concept.md`: append the approved scope decision to §15.
- `docs/cloud/P065-BUDGET.md`, a separately recorded P065 release/local-gate ruling, and package-specific reports/reviews/raw evidence under `docs/cloud/handoff/p065-budget/` and `docs/cloud/rulings/`.
- `docs/handoff/STATE.md`, `docs/handoff/questions/P-06-5.md`, and the engineering-plan §1 status line are dispatcher-owned factual records, not implementer-owned files. Record the HOLD and later actual disposition; do not mark implemented/accepted early.

All other paths are excluded. In particular, do not edit `src/ledger/runtime.ts`, `src/core/run/process.ts`, `src/core/run/process-census.ts`, `src/core/run/ledger-port.ts`, `src/ledger/supervisor.ts`, `packages/hud-mcp/src/ledger-registry.ts`, renderer/collector/link/status/observation-store code, `src/tree-page.ts`, capability manifests/cells, hook producer/command files, shared process helpers, `b45-launch.test.ts`, visual baselines, package/lock files, build/test scripts, or historical reports/rulings. If a safe solution needs an excluded file, stop that portion and obtain a recorded ownership/design revision; do not silently expand the diff.

## 4. Budget and timing semantics

### One original clock

For MCP write/authorization tools, create one trusted monotonic budget no later than the existing `tools/call` timestamp, before per-call validation and source resolution. Its authorization deadline is original start + 30 ms, also bounded by any genuinely known, trusted enclosing response/hook remaining deadline. Never derive authority or a timing extension from model arguments, environment values, configuration, hook claims without verified clock correlation, or a later layer's fresh `now()`.

Include per-call argument/normalization/hash work; process/source evidence; files, stats and config/brief snapshots; capability preparation; connection queueing; every root/intent/handshake/report/cancel/reconciliation transaction attributable to the call; lock acquisition/retries/backoff; callback execution; COMMIT/ROLLBACK; and any optional rejection audit attempted before the final decision. End authorization timing at the final relevant commit/rollback/refusal decision. Report later response/advice/hint/serialization/flush time under full MCP time, without rewriting earlier committed truth.

Do not reset, pause or replace the budget across an await, a queue, a retry, root authorization, preparation, another transaction or an audit. Date.now remains for persisted wall-clock facts; it is not the deadline clock.

The local-resume path must likewise start before its per-call authorization preparation. At a minimum, `resumeLocal` cannot start after `PrivateLedgerGate` construction/checks. The production CLI must propagate a timestamp captured before the resume-specific private-home/config/store/target preparation, rather than claim that service-only timing includes that prefix. Module/process startup outside request handling is reported separately. Any genuinely reusable trusted startup preflight remains explicitly identified, and its cold/first-use cost is reported; no per-invocation preparation is relabeled startup to escape the approved scope. If the measured local path cannot meet the unchanged deadline, report that result and stop qualification rather than silently moving the start.

### Nested lock limits

Keep SQLite `busy_timeout=0` on the present implementation; zero satisfies the at-most-10-ms requirement. This brief grants no reason to increase it. Any future nonzero setting still requires single timeout <=10 ms and the same original total budget.

All actual waiting/retries/backoff share at most 20 ms across the call, within 30 ms. Queue delay is always in the 30 ms; it may be conservatively charged against the shared 20 ms as well. Clearly distinguish such conservative charge from measured SQLite-lock time. Do not report preparation or callback CPU as proven lock contention. Preserve conservative charging until stage accounting is trustworthy; do not use a more optimistic estimate merely to make acceptance pass.

Before a further wait/retry, check both the authorization remainder and the cumulative remaining wait allowance. Account actual elapsed waits, including oversleep, rather than only requested delay durations. A synchronous acquisition that returns late must be checked before running the mutation callback. Callback and COMMIT duration remain in the same 30 ms even if no lock wait occurred.

An expired call must never be converted to the numeric `0` low-level convention and thereby acquire unlimited queue time or another acceptance attempt. Existing unrelated callers that intentionally request one nonblocking transaction remain supported. Distinguish these cases explicitly in the API and tests.

### Separate enclosing measurements

- Non-wait MCP internal response remains p95 <50 ms, from complete tools/call receipt through serialization/flush, including source work and response queue/backpressure.
- The explicit Claude hook profile retains same-call joint p95 <150 ms, from the required hook's outer cold start through that response flush. Do not start the 30 ms before the external hook or add hook time twice. Do not add independently computed p95s.
- Wait retains its existing wait/client deadline and separately reported upfront cost. Status and wait remain read-only. Do not force a 30 ms write transaction into either path.
- Durable accepted → started/bound/ready, executor ticket checks, cancellation execution and post-acceptance recovery keep their existing independent lifecycle semantics. A late accepted response does not create a second execution authorization.

### Cold CLI disposition (six-design ruling §3)

**The current imports remain charged.** hud.ts captures the resume budget before privateHome; run.ts then parses the request, loads config, opens the bound store, dynamically imports the independently built delegation module and performs target/executable preparation. Those operations occur inside this request's original clock. A cold import that crosses the deadline must stop further uncommitted acceptance at the next required checkpoint, complete mandatory cleanup, and retain its failed numerical sample. If COMMIT already succeeded, preserve its truth instead of manufacturing refusal.

Genuine reusable process/module initialization may precede request handling and be measured separately. It must actually be initialization, independent of this request's target, home/config contents, current source/authority and admission work. Moving a resume-selected lazy import or await above a newly sampled timestamp does not qualify. Benchmark-only prewarming, priming module caches without reporting first use, or timing only resumeLocal is prohibited.

A real startup restructuring within owned paths can be considered as implementation, but must preserve the original request boundary and report cold process launch, module initialization, first command/tool and warm calls separately. It cannot conceal a slow first request or load the whole HUD graph into MCP against P-06-6. Request-specific config/store/gate/target/executable work remains charged even if a helper is named startup. Any excluded entry/build-file change needs a separate ownership disposition.

Tests must cover the actual compiled CLI-to-MCP module graphs in a fresh process, a warmed comparison, slow module/preparation completion, unchanged original budget/binding propagation and zero new acceptance after expiry. A warm semantic seam is not evidence that the cold production path meets 30 ms.

### Status/wait applicability (six-design ruling §6)

**Choose preservation of existing read behavior, not a new 30 ms refusal.** Base delegation.ts returns status and enters wait before constructing the B5 write deadline. P065 §4 specifically defines the write/authorization budget and separately preserves wait/client timing and read-only behavior. The original source/security predicates are still mandatory, but this package does not turn every read into a newly deadline-failing B5 operation.

The candidate's unconditional server.ts:118–120 source budget checks, the budget passed into source/hook resolver checks for these tools, delegation.ts:177 entry check and :185 status-completion check therefore need narrowing. Fix every layer, not only the final status check. For status/wait, preserve the original receipt timestamp and use non-enforcing timing observation; do not supply an expiring P065 write budget to their source or read-authority path. No public argument/config knob selects enforcement. Tool classification is trusted internal dispatch. Write-capable spawn/resume/cancel/whoami/report retain the same original 30 ms clock before source resolution, even when that particular call ultimately refuses or replays.

Status still has the complete receipt-to-serialization/flush p95<50 ms gate. A valid 35 ms status is not newly rejected as P065 busy merely for exceeding 30 ms. A slow status still counts against its applicable response distribution and cannot be hidden by fast refusals. Wait retains its original client/request deadline, response margin, cancellation/EOF/shutdown behavior and upfront-cost reporting; source/read work consumes that original elapsed time, not a later reset. Neither tool adds root registration, last_seen, audit, metadata guard or other ledger writes. Keep existing independent bounded source-search/freshness limits and all current identity/captured-generation checks.

Record P-06-5 as not applicable to status/wait's read-only path, rather than manufacturing a successful write-budget sample or treating a legitimate long poll as a 30 ms failure. This is an applicability clarification preserving existing behavior, not an exemption for write tools or a relaxation of P-06-4.

Add deterministic paired tests: valid slow source/read authorization above 30 ms does not create the new refusal for status or wait; invalid/stale/native-child source still refuses; the same preparation delay for each write-capable dispatch prevents further new authorization/admission; status/wait make zero ledger writes; wait retains its original elapsed/client deadline and cancellation responsiveness. Measure real status flush latency and separately reported wait upfront cost. Revert the candidate's new read-only checks as a behavioral control where useful, without weakening any source predicate.

## 5. Transaction admission and committed truth

Carry the original budget object through the final transaction. A wrapper checking only before calling `acceptIntent` is insufficient.

Required checkpoints: before starting another preparation step, after asynchronous preparation/queue waits, before each acquisition attempt/backoff, after actual lock acquisition before the approved metadata pass, after that pass before protected authorization/replay/admission, and immediately before COMMIT. The callback remains synchronous. Only contract 02's fixed private-store metadata operation, as specified by the [metadata-exception ruling](rulings/p065-metadata-exception.md) §§3–4, is excepted from the lock-held external-I/O prohibition. All other file/content/process/source/CLI/network/IPC work remains outside the actual BEGIN-success through COMMIT/ROLLBACK-completion interval. No await or arbitrary external callback occurs between the guard and protected synchronous work. Fixed API counts are not a hard syscall-latency guarantee.

If expiry is detected before the requested mutation commits, roll back that transaction and do not launch, signal, consume a claim, insert a report or issue a new acceptance afterward. Earlier valid root-authority or death-reconciliation commits may remain; tests must not incorrectly assert that an entire multi-transaction call performed zero bookkeeping.

Keep current authorization and captured source/context/version predicates before canonical replay, and replay before fresh expected-run/slot/capability admission. Never refresh a captured generation or recapture a newer scope to rescue an expired/stale call. Preserve request digest bytes, expectedRun omission semantics, actor/owner checks, capacity ordering, slot uniqueness and one ticket/launch.

The deadline cannot forcibly interrupt synchronous SQLite. If COMMIT returns successfully after the deadline, preserve the committed result, record its actual overrun, and never turn it into busy/not-accepted. Likewise preserve an already-authorized canonical replay of a durable earlier outcome; a late response or optional projection failure is not a new failed acceptance and must not dispatch again. The implementation must distinguish requested-operation truth from unrelated root/reconciliation/audit commits: a committed root authorization does not mean a later spawn or cancel was accepted.

A COMMIT error with uncertain outcome must not be coerced into a clean budget refusal or blindly retried. Use the existing authoritative result/identity when recoverable; otherwise retain uncertainty and do not emit another external action. Test successful-late commit and uncertain-outcome handling separately.

Optional rejection audit shares the original remaining budget. Do not start another audit transaction after budget exhaustion, local-store-proof failure or uncertain COMMIT. Proof failure invalidates the local binding for later local admissions, suppresses a separate rejection audit and permits only necessary rollback/connection cleanup, not repinning or automatic retry. An otherwise eligible local business-refusal audit uses the same bound store and a fresh post-acquisition metadata pass in its separate transaction; proof failure there also suppresses the audit without replacing the primary refusal. Do not close an actively used shared connection inside its callback. Expiry alone does not invalidate a safe store. Post-commit optional advice/status/hint/diagnostic failure must not falsify an already durable requested outcome. The exact failure classification and cleanup boundaries are binding in the [metadata-exception ruling](rulings/p065-metadata-exception.md) §4.

Do not use Promise.race to return busy while an abandoned write can later commit. In-flight uninterruptible work and mandatory cleanup may overrun; retain and report that evidence rather than hiding it behind an early response.

### Durable-result marker disposition (six-design ruling §1)

The following records the approved decision for the inspected frozen candidate 2, not proof that its implementation or tests pass:

**Adopt the inspected approach for these exact paths:**

- acceptIntent: current source/context/owner authorization and, where applicable, the original bound-store guard precede canonical owner/key/version/digest lookup. The returned outcome and link/run IDs are from the prior durable record. Fresh expectedRun/capacity/capability admission remains after lookup.
- commitHandshake: the currently authorized, unrevoked binding is already persisted for the same caller/context/generation and current run. The existing claim, independent launch/session, captured-version and ownership checks still run. Slot repair, binding creation or remapping is new transactional work and cannot use this exception.
- requestCancel: after current authorization and snapshot comparison, a nonterminal run already has a persisted cancelRequestedAt. Return that original fact without a second cancellation intent. The terminal/no-new-acceptance path is not silently promoted into this marker.

The commitCompared wrapper's re-marking of the exact wrapper result is acceptable: it preserves the same independently durable inner fact and rechecks that no preceding transaction mutation occurred. It is not an additional generic recovery path. report has no canonical request key and gains no marker-based deduplication or automatic resubmission.

Candidate transaction.ts:65–79 records total_changes at transaction-object creation and rejects marking after counted DML, including writes through get/all RETURNING. This is a useful conservative guard. It does not establish that a read came from an earlier committed operation, cover arbitrary schema/connection-state changes, or prove that authority is independent of rolled-back writes. The trusted, audited call sites establish those facts. Do not advertise this as a general SQL mutation detector or allow arbitrary future callbacks to declare ok:true durable. No schema/PRAGMA changes or new marker call sites are authorized by this decision.

Candidate ledger.ts:94–145 recognizes the marker only after synchronousResult successfully returns the exact marked result, then rolls the current transaction back. That matches the earlier ruling. A callback exception, including undefined/null/false/0/empty-string throws, a thenable, or a different returned object must not be rescued. Incidental writes after a genuinely eligible marker may be rolled back, but cannot create the returned authority or alter the historical result. Mandatory cleanup must finish or the unusable connection must be isolated before returning it; queued work must never reuse a dirty transaction. No replay dispatch, new ticket, rejection audit or hint for rolled-back work follows.

Required verification remains behavioral and uses real SQLite: all three positive call sites across expiry; canonical old-key replay after currentRun advances; stale/revoked source and failed store proof before replay; slot repair/remap as fresh work; counted writes through run/get/all before marking; marker followed by falsy throw, thenable or a different return; incidental rollback and cleanup failure with isolation; zero duplicate acceptance/report/cancel/launch/hint. Keep the existing independent late-COMMIT and uncertain-COMMIT controls. These requirements are not a claim that candidate 2 already supplies every case.

## 6. Internal timing seam and diagnostics

Use a narrowly scoped trusted clock/dependency object supplied by test composition, with production defaulting to a monotonic clock. Pass it through the complete call, including the server boundary and transaction guard. No tool argument, CLI flag, config key, environment knob, global clock patch or future-dated request start may extend production time.

The semantic suites may use deterministic time so they test their intended business result. They must still execute real normalization, authorization and SQLite transactions where that behavior is at issue. A fake capability or process proof remains visibly test-only. Keep separate real-clock tests and benchmarks.

Collect bounded per-call phase/counter data: source/preparation, connection queue, acquisition/lock/backoff, callback body, commit/rollback, final decision and response flush. Retain actual outcome, transaction/retry counts, budget-expiry phase and overrun flags. Do not log prompts, briefs, raw source records, claim/ticket secrets, real paths or real identities. Diagnostics are not new authority and must not add ledger writes or an unbounded hot-path log. Measure instrumentation overhead and ensure optional observer failure cannot override committed truth.

## 7. Failure-mode tests

Each new behavior needs a meaningful failing-before test. Record the old-tree failure or a narrowly reverted negative control in an isolated test tree; do not modify the integration branch for a negative control. A test failing merely because a new symbol is absent is not evidence of the behavioral defect.

Required deterministic cases:

1. Source resolution alone exhausts the original 30 ms: no root authorization or requested-operation acceptance follows. A source refusal remains fail-closed.
2. Slow brief/config/realpath/stat/executable-identity preparation on an uncontended ledger exhausts the budget: no new run/claim/slot/idempotency acceptance/launch. Preserve any legitimate earlier authorization bookkeeping.
3. Partial preparation leaves exactly its true remainder; another layer cannot restart 30 or receive a fresh 20. Exercise expiry on both sides of the boundary, not only a very large delay.
4. Root authorization, a later intent/handshake/report/cancel transaction and optional audit share cumulative waiting. Include backoff oversleep and a stale-snapshot retry. Assert attempt counts and no further transaction after exhaustion.
5. A call expires while queued behind the same connection: callback never executes. Test explicit low-level nonblocking zero separately, including contention.
6. Expiry after preparation but before callback admission prevents mutation; expiry during the callback before COMMIT rolls back all requested-operation rows/events atomically.
7. Death reconciliation commits, then the remaining cancel budget expires: preserve uncertain/slot facts and zero cancel.accepted/cancelRequestedAt. Retain the existing B6 regression at `tests/unit/b6-cancel.test.ts:156–190` and add a cloud-safe deterministic counterpart that does not depend on unavailable real topology facilities.
8. A successful COMMIT completes late: the real rows exist, the result remains accepted, overrun evidence is present, and retry of the same canonical key returns the same run/outcome with one launch. Cover cancel, handshake/report durable outcomes and an already durable replay as well as spawn.
9. A commit outcome is uncertain: no clean not-accepted claim based solely on elapsed time, no duplicate external dispatch, and canonical recovery remains possible.
10. Generation/session/owner/expectedRun/capability/slot changes while preparation or lock waiting proceeds: reject according to existing predicates, without adopting newer authority. Preserve native-child, /clear, ABA, dual-MCP and old-key replay coverage.
11. Local resume charges gate and per-call prefix time, preserves typed local actor/owner and replay/CAS ordering, and does not impersonate an old parent MCP.
12. Local gate tests under the resolved section 8: replace the home or ledger during queueing, actual lock contention/backoff and after BEGIN before the guard; include an equivalent-SQL same-ledgerId/different-inode copy and unchanged-SQL chmod control. Cover original-opening binding propagation, wrong/missing binding, symlink/hardlink/nonprivate/wrong-owner objects, dangling sidecars, non-ENOENT errors and UID/eUID mismatch. Require zero requested-operation body/admission/new accepted operation/launch and no unsafe audit on failed proof. A safe unchanged private store still resumes and canonically replays. Instrument actual writer-lock ownership, not only the callback, to count only the exact approved metadata operations and prove zero other application external I/O.
13. Status and wait retain zero writes, wait timeout behavior and cancellation responsiveness; no shared budget integration turns reads into root-registration mutations.
14. Server serialization/output backpressure and optional post-commit advice errors do not turn committed acceptance into refusal. Full response measurement includes the delay.

Retain business assertions in B45 atomic acceptance, G03 old-key replay, B21 capacity, B11 local resume and B20 advice. Do not accept busy as an alternate success everywhere, skip assertions, increase production limits, or hide failures by a clock starting in the future.

### Additional mandatory precision from the metadata-exception ruling §7

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


### Forced-overrun safety controls (six-design ruling §4)

Predeclare operational performance populations and test-only forced-overrun safety controls before execution. Every measured interval and every failed numerical bound remains in the raw evidence, including deliberately induced callback/COMMIT stalls. A forced-overrun control may pass only its declared safety, rollback, committed-truth and no-duplicate-action assertions; it does not pass the 30 ms bound and does not contribute a successful latency sample. P065's operational numerical qualification is evaluated over the complete predeclared operational populations. Acceptance additionally requires all prescribed forced-overrun controls to complete with their expected semantics. The inclusive all-samples numerical result remains false whenever any applicable sample exceeds its bound. Never report an unqualified all-samples performance pass.

The complete permitted injection boundary, output flags and operational exclusions are in section 9 and the corrected ruling §4. All fourteen cases and eleven metadata precisions above remain required; status/wait paired controls follow section 4's applicability clarification.

## 8. Resolved local-gate contract fork

**Resolved by the [metadata-exception ruling](rulings/p065-metadata-exception.md).** The earlier no-external-I/O rule conflicted with the existing post-acquisition private-store check. The approved decision deliberately amends that rule for exactly one fixed synchronous metadata pass, not for arbitrary filesystem work and not by claiming the existing implementation already complies. Historical F08, p-06-5.md and p065-budget-local-gate.md remain unchanged.

The ruling's §§3–4 are binding implementation requirements:

- Carry the original trusted opening gate together with the exact Ledger instance through the CLI runtime, LocalResumeService/ResumeServiceOptions, DelegationService and local intent guard. Use an internal non-serializable binding; reject wrong Ledger/home, missing production binding and invalidated binding. Do not repin after opening/queueing, serialize/reconstruct the binding, rely on unverified cross-build instanceof identity, or expose this authority through request data, CLI flags, environment or configuration.
- After actual BEGIN IMMEDIATE acquisition, check the original deadline, perform one synchronous lstatSync/realpathSync pass over only the original HUD_HOME, ledger.sqlite, ledger.sqlite-wal and ledger.sqlite-shm (each API at most once per target, at most eight JavaScript API calls), then check the same deadline before protected work and again before COMMIT. Early refusal/actually absent sidecars may use fewer calls. No arbitrary callback or await is allowed between guard and protected work.
- Preserve current UID/eUID, absolute/canonical path, directory/regular-file type, owner/private-mode, no-symlink, file nlink and original home/main dev+ino checks. Existing sidecars retain safety checks without lifetime inode pinning; dangling symlinks are not absence, and non-ENOENT errors refuse. Preserve legitimate sidecar lifecycle.
- The guarantee is consistency between original opening and post-acquisition metadata observations. It is not an atomic filesystem/SQLite binding, OS handle attestation, complete ABA/content-restore detection or isolation from malicious same-UID scripts. A same-ledgerId replacement with a different inode still refuses.
- The same original budget includes opening/config/source/executable/gate/queue/acquisition/body/commit/rollback work. Gate time is separately reported as lock-held metadata, never a separate allowance, excluded preparation or presumed lock contention. If acquisition/gate finishes late, do not enter the requested-operation body; uncommitted expiry rolls back. Successful-late COMMIT remains accepted and over-budget; uncertain COMMIT neither means clean refusal nor permits redispatch.
- Preserve current authority/source predicates before canonical replay, then new expectedRun/capability/slot admission. Store safety precedes local replay. Proof failure suppresses audit, invalidates only that local binding for subsequent local admissions and does not authorize retries/repinning/repair; mandatory cleanup completes. A fresh valid invocation after restore remains possible. Section 5 records the exact optional business-refusal audit boundary.

No file contents/hash/config/source/process/proc/directory scans, host CLI, network, IPC, waits, retries or file modifications are excepted. No native helper, VFS, new daemon/binding, supported-profile change or positive-local-resume removal is approved.

The ruling's §6 covers only the existing metadata operation for shared callers in src/ledger/supervisor.ts, src/core/run/ledger-port.ts and packages/hud-mcp/src/ledger-registry.ts. Those production paths remain read-only impact/regression targets, not P065 ownership. Preserve their existing check(actor?) policy and authority/lifecycle semantics; no new periodic heartbeat/status/wait/generic-transaction probes and no old caller 30 ms propagated into accepted supervisor execution.

The registry's lock-held reader.get()/process-content reads remain a separate unresolved startup-writer compliance issue. They are not covered merely because they share a closure with gate.check(); do not silently move/delete their authority checks or claim global lock-I/O compliance. A shared-helper/callsite policy change requires its own recorded ownership revision or separate migration.

The architecture fork is closed and section 12's scheduling/ownership release is recorded. Candidate 2 mutation and compute remain held pending documentary recording and explicit dispatcher admission under wave1-resource-windows; read-only preparation does not wait for owner-run local tests.

## 9. Real-clock evidence and acceptance

The old direct-service/framed-stdio drivers retain useful all-attempt and uncontended-busy evidence. They are not full qualification: they use 200 outcomes, and the handshake benchmark checks p95 against a per-call 30 ms upper bound. Preserve them as labeled comparators and add the complete driver.

The P065 driver must use the production monotonic clock and real SQLite, actual authorization/transaction paths and framed response/flush measurement. Synthetic source/process/harness/capability facts are clearly labeled. No real credentials, logged-in harness or user home is needed or permitted in cloud runs.

For each declared non-wait tool/combination, retain 50 warmups and at least 1,000 measured calls, with H/R=1/1 and 2/10 workload profiles, real ledger heartbeat interleaving and actual writer-lock contention. Cover status, spawn, resume, cancel, whoami and report. Split actual success/refusal/busy outcomes and identify non-applicable outcome cells honestly, especially read-only status; do not introduce writes to manufacture a busy population. An intended-success call that becomes uncontended busy stays an actual busy attempt and cannot disappear from evidence.

Include cold/cache-first-use, long lock, queued expiry, callback/commit overrun, response loss/replay and concurrent observation-storage load on the same measured storage. Use only already accepted observation interfaces; do not enable B10D or borrow its unaccepted branch. Preserve all failed/continued/uncompleted attempts. A test-only fixture's H/R counts are workload labels, not proof of real harness topology or capability.

Report raw per-call intervals plus empirical nearest-rank n/p50/p95/p99/max, over-30 count and maximum, wait/backoff totals, timeout settings, actual outcomes and attempts, response p95 and every stage's scope. P-06-5 remains a per-call upper bound; p95 <=30 is insufficient. A successful late commit is a correct truth-preserving result and still a performance defect. Do not remove a slow sample because the operation was refused or the host was noisy.

Run at least three isolated measured series on each supported Node family, Node 22 >=22.13 and Node 24, with exact versions. Do not run builds, another benchmark or another package's tests concurrently. Record CPU/vCPU/quota, memory, OS/kernel, Node/SQLite, filesystem/mount/storage, source SHA, compiled-output hashes, command, relevant environment, fixture population, sample order, warmup/cold treatment and known host interference. Keep each run and its range, not just the best run. A runtime-specific failure remains open.

These remote measurements are host-labeled design/implementation evidence, not formal WSL or real-Claude qualification. Real Claude same-call 150/50 evidence, real-harness/capability cells, Herdr/tmux and the full B14 supported-platform requirements stay local-only and unverified until the owner supplies applicable evidence. No synthetic pass upgrades a capability cell.

### Synthetic H/R fixture disposition (six-design ruling §2)

**Approve existing configured limits, for example maxActiveRuns=12 and maxActiveRunsPerOwner=12, in the synthetic fixture only.** The accepted configuration already supports these fields. This does not increase the production defaults of 6/4, bypass capacity checks, or turn the old comparator's concurrency_limit abort into success. Record the exact chosen limits for every population and preserve separate default-limit/capacity-refusal regressions.

For this cloud driver, define the labels explicitly:

- H is the number of independently registered, concurrently exercised synthetic MCP caller/server compositions. H=2 needs two real server/stream instances in the test composition, two valid registrations and current source/context premises, with both participating in the declared concurrent schedule. Merely issuing two IDs through one caller is insufficient. If both compositions live in one OS process, say so. Do not claim two actual harness processes.
- R is the baseline active ledger-run load supplied to that experiment: 1 or 10 valid accepted, nonterminal runs, with matching slots, issued/armed claims, registered synthetic supervisor identities and real heartbeat CAS traffic. It is not ten fabricated rows or ten reported-but-unowned tasks.
- Contract 06's formal H=actual loaded harnesses and R=actual active supervisor topology remains unchanged. The above is the brief's explicitly synthetic cloud workload surrogate, not P-06-1/B14 topology qualification.

The proposed ten-run baseline is legal. Seed it through real acceptIntent and registerSupervisor APIs and exercise createHeartbeatWriter with each correct registered producer and monotonically valid facts. Existing visibly synthetic identity/process/capability fixture seams are allowed; they are not production evidence. Do not fabricate child_bindings, force-update state/slots, or use an unauthorized caller to make a benchmark cell succeed.

Parent-operation compositions may share a verified logical owner/session if their separate current process/context evidence supports it. Sharing an owner does not create extra capacity or a second owner. Child whoami/report success populations require each participating child composition's own valid claim, run and current binding, established through the existing handshake path. A second child cannot reuse the first child's identity or binding. Parent identity does not authorize a child report.

Foreground spawn/resume can add runs to the baseline: with two in-flight creations, R_baseline=10 can temporarily become 11 or 12. Record baseline, before/after/peak active counts and the foreground target IDs separately; never label every instant as exactly ten active runs. A previously terminal resume target is not part of the ten-active baseline. For status/cancel/whoami/report, use appropriately authorized targets within the declared population where possible. Restore the baseline between declared trials through valid terminal-evidence/reconciliation APIs or a separately disclosed fresh fixture, never by force-releasing slots or deleting live authority. Prevent unreported accumulation of accepted runs, historical rows or setup work from changing the workload.

Fixture assertions must verify active counts, distinct slots/claims, matching registrations/heartbeat sequences, both H participants, current owner/source premises, and cross-child refusal. Record fixture/setup time separately without excluding per-request source or preparation. Heartbeat and actual writer-lock contention must use the same ledger SQLite file. Concurrent observation-store load must use its own already accepted observation store on the same measured filesystem/storage; it must not write observations into the ledger. Maintain production clocks, actual framed flush measurement, all attempts/outcomes, prescribed warmups/sample counts and three isolated series per Node family. A fixture precondition failure is incomplete evidence, not a busy/success sample or permission to weaken authority.

### Operational qualification and forced-overrun controls (six-design ruling §4)

Predeclare operational performance populations and test-only forced-overrun safety controls before execution. Every measured interval and every failed numerical bound remains in the raw evidence, including deliberately induced callback/COMMIT stalls. A forced-overrun control may pass only its declared safety, rollback, committed-truth and no-duplicate-action assertions; it does not pass the 30 ms bound and does not contribute a successful latency sample. P065's operational numerical qualification is evaluated over the complete predeclared operational populations. Acceptance additionally requires all prescribed forced-overrun controls to complete with their expected semantics. The inclusive all-samples numerical result remains false whenever any applicable sample exceeds its bound. Never report an unqualified all-samples performance pass.

This deliberately supersedes only the reading that one inclusive Boolean must make correct forced-overrun negative controls indistinguishable from ordinary performance failure. It is an acceptance-composition amendment under the owner's delegated authority. Historical rulings, samples and failed reports are not rewritten.

The exception is confined to test-only, predeclared synchronous delay/fault injection that deliberately forces the callback or COMMIT completion beyond its deadline, with the injection point, duration, affected call identities and expected outcome recorded before execution. Keep the real monotonic clock and real SQLite transaction/cleanup. Separate these controls from operational distributions and from each other when their semantics differ. Test-induced time is never subtracted from the recorded duration.

It does not exempt naturally slow callbacks/COMMIT, cold or first-use imports, real source/config/metadata work, ordinary queued expiry, actual lock contention, heartbeat/observation-storage load, scheduler interference, refusal, busy, successful-late COMMIT or failed/uncompleted attempts in an operational population. Those remain operational numerical failures. A long lock is not automatically semantic-only: the ordinary contention path is still expected to stop attempting acceptance within the unchanged limits. No post-hoc relabeling of a slow call as injected is allowed. Isolate forced controls so they cannot silently contaminate another operational series.

Emit at least three separately scoped results: operational numerical qualification, forced-control semantic completion, and inclusive all-samples numerical status. Also emit population completeness and every per-call numerical flag. If a legacy single overall-qualified Boolean is retained, it must remain false when the inclusive numerical status is false; it cannot conceal the distinction. A separately named acceptance-check result may combine complete operational qualification with successful prescribed fault semantics, with its scope explicit. A driver may exit successfully for that correctly implemented expected-fault test bank, but must fail for any operational gate failure, incomplete required population, unexpected fault semantics, undeclared injection or misclassified sample. Exit zero alone is never qualification evidence.

All existing per-call 30 ms, cumulative 20 ms, busy_timeout=0, full-response p95<50 ms and applicable joint p95<150 ms gates remain unchanged. No required warmup, sample count, tool, workload, runtime or series is removed. Correct handling of forced uncertainty still never authorizes a retry or duplicate dispatch.

## 10. Checks, timeouts and evidence locations

The commands below are for implementation after resource admission, not commands executed by this consultation. The [scheduling release](rulings/p065-budget-release.md) reserves `/workspace/shared/p065-budget` and branch `dots/p065-budget` from accepted integration base `26f6fba36948e6c96e2e109cb374c0d4dbb9ab22`; the current frozen candidate may resume only after documentary recording and explicit dispatcher admission under [wave1-resource-windows](rulings/wave1-resource-windows-20261103.md). Do not mix active unaccepted package code into it. Preserve all evidence on failure.

Every command runs with temporary HOME, HUD_HOME, TMPDIR and synthetic source directories, never the user's real stores. Unset inherited harness/session/HERDR variables and NO_COLOR/FORCE_COLOR where the README requires. Keep runtime selection explicit and executable resolution correct before changing HOME. Own and clean child PIDs individually; never kill by name/pattern. Use separate temporary directories per command and retain raw stdout, stderr, exit code, source/runtime identity and duration. Timeout is a failed/incomplete stage, not a pass. Clean only the temporary resources this command created.

Exact command set and per-command outer timeouts:

- If dependencies are absent, `npm ci`: 300 s. Do not stage node_modules or dependency lock changes.
- `npm run build`: 180 s.
- `npm run build:test`: 180 s.
- `npm run build:hud-mcp`: 180 s.
- `node --test dist-test/tests/unit/p065-budget.test.js dist-test/tests/unit/p065-local-gate.test.js`: 300 s.
- `node --test packages/hud-mcp/dist/tests/hud-mcp/p065-budget.test.js`: 300 s.
- `node --test dist-test/tests/unit/ledger-write.test.js dist-test/tests/unit/b11-cli.test.js dist-test/tests/unit/b21-capacity.test.js dist-test/tests/unit/b6-wait-status.test.js`: 600 s.
- `node --test packages/hud-mcp/dist/tests/hud-mcp/authorization.test.js packages/hud-mcp/dist/tests/hud-mcp/delegation.test.js packages/hud-mcp/dist/tests/hud-mcp/resume-expected-run.test.js packages/hud-mcp/dist/tests/hud-mcp/handshake.test.js packages/hud-mcp/dist/tests/hud-mcp/hook-source.test.js packages/hud-mcp/dist/tests/hud-mcp/b20-advice.test.js`: 600 s.
- `npm test`: 1,800 s, with the README's temporary HOME and NO_COLOR/FORCE_COLOR/HUD_HOME handling. Its internal chained stages must all execute successfully.
- `npm run test:mjs`: 600 s, also run separately if npm test stopped before reaching it; a separately completed stage does not turn the original failed command green.
- `npm run test:core`: 600 s.
- `npm run test:visual`: 300 s.
- `npm run test:hud-mcp`: 600 s.
- `npm run format:check`: 300 s.
- `npm run check:fixtures`: 120 s.
- `git diff --check`: 60 s.
- `node tests/int/b45-delegation-benchmark.mjs "$EVIDENCE/b45-service.json"`: 900 s.
- `node tests/int/b45-mcp-stdio-benchmark.mjs "$EVIDENCE/b45-stdio.json"`: 900 s.
- `HUD_B45_BENCH=1 node --test packages/hud-mcp/dist/tests/hud-mcp/handshake-benchmark.test.js`: 900 s, alone.
- `node tests/int/p065-budget-benchmark.mjs "$EVIDENCE/p065-budget.json"`: 3,600 s per run. The new driver must implement the full declared matrix and raw-sample output as its default, not require a hidden qualification flag. Run three isolated series per Node family with distinct EVIDENCE directories.

The [metadata-exception ruling](rulings/p065-metadata-exception.md) §7 additionally requires compiled CLI-to-MCP handoff coverage, actual-lock-interval gate counters, preserved shared-writer security/lifecycle regressions and independent behavioral negative controls for original-gate propagation, post-acquisition observation, post-gate expiry and unsafe-audit suppression. The [scheduling release](rulings/p065-budget-release.md) §5 verifies that the required `npm test` aggregate includes `tests/unit/int-ledger-run.test.ts` and `tests/unit/b45-parent-offline.test.ts`, and reserves the three bounded fixture paths in section 3. If a stage is not reached by the aggregate, its exact standalone invocation is `node --test dist-test/tests/unit/int-ledger-run.test.js dist-test/tests/unit/b45-parent-offline.test.js`, outer timeout 600 s, with the same isolation, runtime and owned-PID cleanup requirements; this does not make a failed aggregate green or waive unavailable real-process coverage. All original commands, timeouts and complete Node 22/24 real-clock populations remain; metadata overruns are not excluded samples.

A later read-only Oracle verifies each test's failing-before behavior and semantic assertions. The deterministic suite must prove all section 7 state assertions; the real-clock driver must emit complete samples and fail its qualification summary if any applicable gate is unmet. Do not use a benchmark's exit zero alone as a substitute for inspecting its per-call flags and population completeness.

Existing real-process B6 regressions may be run only on an authorized executor supporting their facilities. Do not run a wildcard that includes real-TTY/tmux/Herdr cases in cloud. The new deterministic counterpart is additional coverage, not a claim that an unrun real-process matrix passed. Synthetic socket, ptrace or process-topology denials must be reported; do not bypass them or relabel pre-behavior failure as successful lifecycle validation.

Known-flake handling remains the README's single isolated rerun with both outputs retained. It does not erase a P065 over-budget sample, waive a repeated failure, change qualification semantics or excuse an unrun stage. Preserve the current HYG2/RUNZ1/S3F full-check blockers by name when they reproduce; no skip/expectation changes are authorized here.

Dispatcher evidence paths:

- `docs/cloud/handoff/p065-budget/implementation.md`
- `docs/cloud/handoff/p065-budget/checks-<runtime>-<run>.log`
- `docs/cloud/handoff/p065-budget/samples-<runtime>-<run>.jsonl`
- `docs/cloud/handoff/p065-budget/summary-<runtime>-<run>.json`
- `docs/cloud/handoff/p065-budget/negative-controls.md`
- `docs/cloud/handoff/p065-budget/review-1.md` and subsequent distinct fix/re-check records.
- `docs/cloud/rulings/p065-budget-local-gate.md` remains the historical fork report; `docs/cloud/rulings/p065-metadata-exception.md` is the approved resolution. `docs/cloud/rulings/p065-budget-release.md` is the archived scheduling/ownership release, with current resource admission governed by [wave1-resource-windows](rulings/wave1-resource-windows-20261103.md) and the corrected [six-design ruling](rulings/p065-six-design-dispositions.md).

Sanitize before publication. Keep synthetic source identities, full commands and byte/row counts, but exclude secrets, raw private filesystem paths and real user data. Preserve prior evidence rather than replacing an earlier failed report with a later successful one.

### Evidence result composition (six-design ruling §4)

Predeclare operational performance populations and test-only forced-overrun safety controls before execution. Every measured interval and every failed numerical bound remains in the raw evidence, including deliberately induced callback/COMMIT stalls. A forced-overrun control may pass only its declared safety, rollback, committed-truth and no-duplicate-action assertions; it does not pass the 30 ms bound and does not contribute a successful latency sample. P065's operational numerical qualification is evaluated over the complete predeclared operational populations. Acceptance additionally requires all prescribed forced-overrun controls to complete with their expected semantics. The inclusive all-samples numerical result remains false whenever any applicable sample exceeds its bound. Never report an unqualified all-samples performance pass.

Use the population declarations, required result flags and narrow injection scope in section 9. Required commands and timeouts remain acceptance requirements, but are not authorization to re-attempt a known blocked operation.

### Exact denied-operation scope (six-design ruling §5)

The inspected logs establish specific earlier runtime failures:

- HYG2 supplemental npm run test:mjs, source dced9114e9d15977fef07fa52c1a329a58dfa505: tests/unit/herdr-bridge.mjs fakeHerdr calls Node net.Server.listen on a fresh temporary hud-herdr-*/api.sock pathname. The operation returned EPERM, syscall listen, before the fake endpoint could serve the intended protocol assertions. The first detailed failure is lines 83–99 of docs/cloud/handoff/hyg2-fix-mjs-dispatcher-20261103.log on dots/hyg2.
- RUNZ1 npm test, source 2eb08fbd091a44b77bbaa3761c68ae8b11688778: run-light-leader's exec-audit tests invoke tests/int/b3ar1-env-audit.py. Its freshly forked owned child calls libc.ptrace(PTRACE_TRACEME, 0, ...) and receives errno 1/Operation not permitted before the exec-stop audit. See part05 lines 657–671 and part06 lines 35–48 and 70–83. The later standalone test:mjs also records the Unix-path listen failure in part07 lines 66–82.

These are actual OS-operation failures, not evidence that a reviewer denied the names npm test or herdr-bridge, and not proof that all spawning, pipes, SQLite, /proc reads, Unix-socket client operations or independent tests are forbidden. Missing CONFIG_PROC_CHILDREN and unrelated product/registration failures are separate blockers; do not collapse them into ptrace permission.

At the current base, package.json expands npm test through test:unit, whose wildcard includes run-light-leader.test.js and its ptrace helper, then test:mjs, whose wildcard includes the listener tests. Therefore an unchanged aggregate would deliberately re-attempt known blocked operations. The dispatcher identifies prior executor contexts and has supplied no verified permission change. Historical failure does not prove a fresh measurement of current capability, but the absence of new evidence is not authority to probe again. Keep these aggregate stages blocked/unrun for P065, with the underlying operation and prior evidence named.

Continue independently allowed exact focused stages after inspecting their dependency paths, under a later assigned lease. Do not alter aggregate scripts, skip assertions, substitute synthetic success or call those focused passes a full gate. Do not change socket paths, transport, tracing method, permissions, seccomp, sysctls, privileges or executor merely to evade a block. A genuinely separate sanctioned executor must have its own authorized scope and relevant capability evidence; the owner's successful WSL run is not assistant permission to use that machine or a P065 exact-tree result.

Any reconsideration must first record materially new, relevant evidence for the exact operation/target and applicable executor. If an authorization denial is known not to have executed and that evidence addresses it, only the specifically permitted single retry may be considered; uncertain outcomes are checked first. Nothing in this ruling schedules or automatically performs such a retry. Owner-run exact-tree evidence may be requested through the existing workflow while permitted cloud work continues.

## 11. Ownership comparison, workflow and stop conditions

The inspected active branch changes were:

- HYG2 at `2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31`: `src/ledger/runtime.ts`; `tests/int/process-client.ts`; `tests/unit/b12d-wal.test.ts`, `b12r-store.test.ts`, `b16-writer.test.ts`, `b45-launch.test.ts`, `hud-link-export.test.ts`, `process-client.test.ts`; package-specific records. None is in the conditional P065 whitelist.
- RUNZ1 at `86ca8887fcfb331750ec6dc5518d69134cb795e4`: `src/core/run/process.ts`, `process-census.ts`, `README.md`; `tests/int/runz1-perf.mjs`; `tests/unit/runz1-fixture.py`, `runz1-process.test.ts`; records. P065 reads but does not change the process API or these files. Do not treat RUNZ1's still-open real-process evidence as validated by a budget test.
- S3F-PERF at `94969100ec85a41f93eb2a0d677aefc886290691` includes the inherited S3 rendering/input/reference/fixture changes and its scoped performance changes. Neither its production/test ownership nor the inherited changed files overlaps the P065 source/test whitelist. This is a file comparison, not a verdict on S3F/PERF.
- Frozen B10D at `4f2c4aced878e5750e66292ed7c552ffb421165d` changes collectors, `src/core/link/*`, entries and B10D tests, not the P065 conditional implementation files. It remains unaccepted and is not a permissible base/dependency.

This proves present file disjointness for the bounded candidate only. It does not prove future B9/B16/B10D/LEG1/RCP1 briefs disjoint before they name their files. Shared contract 06/concept/status amendments, including the fairness amendment, require dispatcher serialization. Do not grant two writers the same documentation file on the assumption that they will edit different paragraphs.

After an explicit release, use the dots hierarchy: dispatcher schedules/records/runs raw checks; one Astra-high implementer owns this brief; a fresh Astra-max Oracle handles each design fork and the final review; fixes return unchanged to the same implementer; fresh re-checks review fixes. No subdelegation of judgment to the dispatcher. At most two normal P065 fix rounds, then record unresolved findings. This new package does not reset any old package's consumed rounds or authorize another S3F-PERF remedy.

Stop implementation on an unresolved deviation from section 8's approved design, missing resource admission or the pinned accepted base, changed/overlapping file ownership, missing complete qualification data, an outside-whitelist remedy, or a proposed gate/profile/contract change beyond the approved scope. Preserve the branch/evidence and return the exact question. Full-suite environmental failures remain failures, not a reason to skip the gate.

Final acceptance requires a fresh Oracle's accept verdict verifying the report, source, failure-mode tests and measured populations. Merge only per STATE: one active merger, --no-ff into universal-hud, full green check set on the merged tree with permitted flake handling and both outputs retained, then push and factual STATE/plan updates. Never touch main, force-push, rewrite history, stage node_modules/.package-lock.json or integrate an unaccepted branch as a shortcut.

## 12. Separate release disposition

**Disposition now: scope and branch/worktree ownership remain RELEASED; candidate 2 remains frozen WIP until documentary recording and explicit dispatcher admission under [wave1-resource-windows](rulings/wave1-resource-windows-20261103.md).** The [scheduling/ownership ruling](rulings/p065-budget-release.md) supplies the separate release required by queue-progress and this brief. It does not claim implementation, acceptance, merge or green checks.

The release records completed contract/brief/status synchronization and reserves P065 as one bounded independent follow-on to the owner-approved wave-1 P-06-5 consultation:

- Exact accepted integration base: `26f6fba36948e6c96e2e109cb374c0d4dbb9ab22`; tree `03bd36610d46fd220eb9c0e4fbf153a52bc3c3b9`.
- Reserved branch `dots/p065-budget` and dedicated cloud worktree `/workspace/shared/p065-budget`. The corrected six-design ruling inspected uncommitted candidate 2 on that branch, with thirty-file aggregate SHA-256 `ffbeda20c512181de5f7e49ecb6edc1adfd1440ffff4fcc2e54636161febd602`; the base commit is not a commit of this WIP candidate.
- Exact production/test ownership is in ruling §§4–5, including the three bounded fixture additions; shared documentation remains serialized and dispatcher-owned per §6. No broader ownership is implied.
- The original scheduling release required explicit NEXT lease return; subsequent admissions follow [wave1-resource-windows](rulings/wave1-resource-windows-20261103.md). The six-design decision itself grants no compute window. Candidate 2 remains frozen until documentary recording and a new explicit dispatcher admission; no automatic benchmark, aggregate, denied-publication or local-test restart follows. Preserve the separate publication blocker and check inventory. Read-only preparation may continue; elapsed time or a quiet snapshot is not admission.
- Use the exact pin; do not import unaccepted HYG2/RUNZ1/S3F/PERF/NEXT/B10D code. Later documentation-only descendants do not silently replace the declared base; any intervening source/test change requires base/ownership/brief revalidation.

Owner-run local testing or review is not a prerequisite to this independent scope release. One isolated measurement workload at a time remains mandatory. All numeric budgets, security and committed-truth requirements, failure tests, real-clock populations, full checks and independent final-Oracle/merge gates remain unchanged.

This release does **not** release DOC2 or TPD1 before B10B-S3F merges, Inspector/data before the ordered wave-2 work, or B10D/LEG1/RCP1 ahead of the route's sequence. It does not renew any package's consumed fix rounds or authorize assistant-run local testing. Acceptance, merge and local-only qualification remain held until their distinct gates are met.

## 13. Approved normative text to record

The following preserves the already approved preparation-inclusive clarification from the prior Oracle ruling. Its transaction-preparation statement is now qualified only by contract 02's fixed metadata exception, recorded in the [metadata-exception ruling](rulings/p065-metadata-exception.md) §5 and section 8 above; numeric limits and all other boundaries remain unchanged:

> P-06-5 的 30 ms 是单次调用的授权与事务总墙钟，不是持锁时长。MCP 从完整 tools/call 进入逐调用验证、来源解析与授权准备之前开始计时，包含本次文件读取/stat、进程与来源取证、参数与摘要准备、连接队列等待，以及全部相关授权/提交事务的等锁、重试、退避和 commit；在最后相关事务提交、回滚或拒绝决定完成时结束。准备必须在写事务之外，但仍在同一预算之内；不得在取得写锁、完成准备或开始下一事务时重置时钟，也不另加准备预算。单次 busy_timeout≤10 ms、累计等锁/重试/退避≤20 ms，均包含在30 ms内。耗尽且目标操作尚未提交时不得再接受该操作；已提交结果不改报未接受，同步commit超时单列预算缺陷。MCP完整响应和显式Claude hook联合计时仍分别按P-06-4；wait的等待预算不变。

Record the corresponding T-06-14/measurement wording and contract-01/03/04/05 cross-references consistently with the [metadata-exception ruling](rulings/p065-metadata-exception.md) §5. Preserve F08 and predecessor rulings as history; scope and ownership remain released under section 12, while candidate 2 is frozen pending recording and explicit dispatcher admission under wave1-resource-windows; independent acceptance and merged-tree checks remain required.

## Sources

- [Pinned state](https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/docs/handoff/STATE.md)
- [Approved P-06-5 question](https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/docs/handoff/questions/P-06-5.md)
- [Verbatim P-06-5 recommendation](https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/docs/cloud/rulings/p-06-5.md)
- [Contract 02 transaction boundary](https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/docs/contracts/02-execution.md#L68-L86)
- [Contract 06 budgets](https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/docs/contracts/06-observation.md#L243-L253)
- [Ledger transaction implementation](https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/src/ledger/ledger.ts#L24-L53)
- [Intent acceptance and local check](https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/src/ledger/intents.ts#L188-L237)
- [Private-store gate](https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/src/ledger/local-manager.ts)
- [Local resume entry](https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/packages/hud-mcp/src/delegation.ts#L490-L503)
- [CLI preparation and discarded pinned gate](https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/src/cli/run.ts#L81-L128)
- [Existing store open/check sequence](https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/src/cli/runtime.ts#L87-L121)

Current disposition: precise metadata exception recorded and local-gate contract fork resolved; scope and branch/worktree ownership released on the pinned accepted base, with candidate 2 still frozen pending recording and explicit dispatcher admission under wave1-resource-windows. All six design questions are resolved; no implementation acceptance, merge, performance pass or capability promotion is claimed.