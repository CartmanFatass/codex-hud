# P065-BUDGET: durable replay, expiry, commit uncertainty and hook clocks

Date: 2026-11-03. Fresh read-only design consultation.

## Decision

**ADOPT the internal durable-replay result marker, with the eligibility and cleanup requirements below. Reject the alternative that treats an already-authorized durable canonical replay as a new uncommitted operation and replaces it with busy solely because the current transaction reaches its pre-COMMIT deadline.** Roll back the current transaction's uncommitted work, preserve the earlier durable outcome, and dispatch nothing for the replay.

**An unresolved COMMIT error needs an internal uncertainty classification, not LedgerBusyError. It may map to the existing external internal_error code without adding public taxonomy.** Known successful COMMIT and independently known prior durable replay remain authoritative. Recovery uses the operation's existing authorized identity rules; not every tool has a canonical request key.

**For the hook question, preserve the original MCP-receipt 30 ms and existing source verification. Do not manufacture a trusted enclosing deadline from same-boot numeric fields alone.** A genuinely established enclosing deadline must tighten the same budget. The present source does not establish a portable producer-to-consumer clock-domain correlation merely by checking bootId and timestamp plausibility. Record this limitation; it does not waive the existing joint 150 ms or internal 50 ms qualification gates.

This resolves implementation interpretation within the existing whitelist. It grants no new public API, schema, error code, authority, profile, performance allowance, compute lease, acceptance or merge permission.

## 1. Inspected basis

The source basis is the release's pinned universal-hud image 26f6fba36948e6c96e2e109cb374c0d4dbb9ab22. I read the P065 brief, metadata-exception decision, scheduling release, execution and timing contract clauses, workflow, ledger transaction/intent/root/handshake/cancel implementation, MCP dispatch/error boundaries, canonical replay tests and hook producer/consumer timing code. Relevant existing local source copies were checked against the GitHub blobs at that pin before use.

The controlling text is P065-BUDGET §§4–7: preserve current authorization before canonical replay, rollback uncommitted expiry, preserve successful-late COMMIT and already-authorized durable replay, and do not turn uncertain COMMIT into clean nonacceptance. Metadata-exception §4 additionally requires store proof before local replay and forbids unsafe/expired/uncertain rejection auditing. The scheduling release preserves these requirements and its resource/ownership restrictions.

Existing code demonstrates the distinctions: acceptIntent checks currentAuthority/authorizeControl before lookupIdempotency and checks capacity, capability and fresh resume CAS afterward; DelegationService dispatches only when result.replayed is false. G03 tests require old-key replay after currentRun advances. Root authorization is a separate transaction. requestCancel can return an already-persisted cancelRequestedAt. commitChildReport generates a new reportId and has no canonical request key.

## 2. Marker eligibility and authorization order

The marker is internal transaction control data, not request data, a public outcome field or a new authority source. Its exact implementation name is not prescribed.

It may identify only a result whose requested-operation fact was already durable independently of the current transaction, and which the current invocation is authorized to obtain through the existing replay/recovery path. For keyed intents, that means the matched canonical owner/request key, version and digest, returning the immutable stored outcome and its original linkId/runId. A durable refused outcome, where the existing contract permits one, is also returned as that original refusal rather than changed into an acceptance.

Required order remains:

1. Original budget admission and current per-call source/captured-premise validation.
2. Actual writer acquisition, original-deadline check, required bound-store metadata guard for local work, and post-guard deadline check.
3. Current transaction authority/context/generation/owner and applicable captured predicates.
4. Canonical lookup and digest/version match.
5. Only on no canonical record, fresh expectedRun, capacity, capability, slot and other admission predicates.

No marker permits entering the protected body after an earlier expiry checkpoint refused entry. A previous read snapshot, cached result, old successful call or old local gate is not enough. Store-proof failure, revoked/changed source, native-child source, stale generation and owner failure still prevent replay. Do not recapture a newer generation or repin a store to rescue the call. Explicit expectedRun remains in the digest; omission remains omitted. A new expectedRun gate must not be moved ahead of a valid replay.

The marker must not preserve authorization created only by writes that are then rolled back, a newly inserted idempotency row, a speculative callback success, or a new root/reconciliation/report result. Preserve independently committed root/reconciliation facts without mislabeling the later requested operation as accepted.

Honor the marker only as the successful synchronous callback's result. Do not set a flag and later return it despite a subsequent callback exception, failed predicate or thenable rejection. Audit the actual call sites; a branded type alone does not prove prior durability.

## 3. Completion semantics

- **Expiry before protected callback admission:** do not execute the body or a special replay lookup. Finish any already-required rollback. The prior historical operation, if any, is not erased, but this call has not completed authorized replay.
- **New requested outcome, expiry before COMMIT starts:** roll back the entire current transaction. No new run/claim/slot/report/accepted event, claim consumption, launch, signal or post-result hint may survive or follow. Optional rejection audit must not start. Earlier valid separate commits remain. A clean budget refusal requires completed cleanup; unresolved cleanup is not evidence for a clean nonacceptance response.
- **Eligible durable replay, expiry at the pre-COMMIT checkpoint:** do not COMMIT incidental bookkeeping. Roll it back, then unwrap and return the earlier canonical result with replay semantics intact. Do not dispatch, request a new execution ticket, append another acceptance/rejection, or publish a hint for rolled-back work. Record the actual overrun and rollback duration.
- **COMMIT returns successfully:** set the transaction's known-committed state before optional clock/observer/projection work. Return the committed result even if the call is now late. Do not attempt rollback because an observer subsequently throws. Only a newly committed accepted intent follows its existing single-dispatch path; replay never does. The late sample still fails the applicable performance bound.
- **COMMIT throws and the requested outcome is unresolved:** classify internally as commit-uncertain, retain the original cause, complete necessary cleanup, suppress rejection audit and all dispatch, and return the existing generic external error. Elapsed time and error-message resemblance to SQLITE_BUSY do not establish nonacceptance. Never blindly rerun the callback or COMMIT.
- **COMMIT/cleanup trouble while returning an independently known eligible durable replay:** the current transaction's incidental uncertainty does not undo the historical result. Preserve that known result once mandatory cleanup has been completed or the unusable connection has been isolated. Do not claim incidental bookkeeping committed. An implementation may avoid an unnecessary replay COMMIT by closing that transaction with rollback, provided it preserves the existing semantics. If continued authority to return the result actually depended on this transaction's new writes, it was not an eligible durable replay.

No Promise.race may return a refusal while abandoned write work can later commit. The caller waits for the synchronous operation and mandatory cleanup, even when they overrun.

## 4. Cleanup, error and side-effect discipline

Track transaction ownership from actual BEGIN success, including the await handoff from acquisition, through final cleanup. A post-acquisition deadline failure must not leave a transaction open because an outer begun flag was set too late. Always retire the transaction object and release the connection's active bookkeeping.

A secondary ROLLBACK/observer error must not replace the primary commit-uncertain classification with busy or cause a rejection audit. If rollback cannot establish a reusable connection, refuse later work on that connection until it is safely closed/recovered outside an active callback; do not let queued unrelated work accidentally commit the leftover transaction. A successfully cleaned-up uncertainty does not require globally invalidating otherwise safe store authority. Ordinary expiry alone does not invalidate the local-store binding.

Optional advice, wake/status projections, hints, diagnostics and response handling cannot overturn known requested-operation truth. Suppress failures of optional post-commit work rather than returning a new acceptance failure. Do not carry pending hint/event identifiers out of a rolled-back transaction and publish them afterward.

Keep packages/hud-mcp/src/errors.ts and the public response contract unchanged. The internal uncertainty error must not inherit LedgerBusyError, carry code ledger_busy or expose a message that outcomeCode maps to busy. The existing unknown-error mapping to internal_error suffices. That generic error means the call did not return a known result, not a promise that nothing committed. Do not add accepted:false/notAccepted:true or retry-safe claims for uncertainty. A COMMIT failure is also not permission to write a new run.state='uncertain' event without the existing authorized reconciliation evidence and writer rules.

## 5. Recovery scope

For spawn/resume, a later fresh call with the same canonical key and digest redoes current source/store/authority checks and consults the durable record. If it finds the record, return the original outcome with zero redispatch, even if the original uncertain call delivered no ticket at all. The protocol does not guarantee external action delivery; do not recover by minting or resending a ticket. If a fresh serialized authorized lookup finds no record, existing new-intent admission may run; an unavailable read is not proof of absence. Changed parameters still conflict with an existing record.

Do not generalize that promise to report: its current API has no request key and creates a new report per submission. P065 must not add an automatic report resubmission, hidden deduplication scheme or public key. Preserve any known successful report result; otherwise retain uncertainty and rely only on existing authorized observations/recovery. For cancel and whoami, use their existing durable cancel/binding predicates, not a generic assumption that any ok:true callback is replay. A handshake that must create/remap a binding is new transactional work, even if the run was already accepted.

## 6. Required behavioral tests

Add these precision cases within the reserved tests; they supplement, not replace, the brief's full matrix:

1. Existing canonical result, successful current authorization/store proof, deterministic expiry after lookup but before COMMIT: original bytes/IDs returned, replay true internally, incidental test bookkeeping rolled back, zero extra launch/acceptance/rejection/hint.
2. Repeat for old expectedRun after currentRun advances, capacity full and capability now inadequate for a new intent. Valid replay still wins; changed digest conflicts. Preserve current-authority and local-store refusals before lookup.
3. Same late boundary with a fresh intent: all requested-operation rows/events roll back and no dispatch occurs. Separately preserve earlier committed root/death-reconciliation bookkeeping.
4. Expiry queued, after acquisition and after metadata guard: zero protected-body/replay entry. Include exact boundary sides and the acquire-await handoff.
5. Attempt to preserve a newly created row or rollback-dependent authorization as durable replay: it must not return success. A marker followed by callback failure must not rescue the callback.
6. Actual COMMIT succeeds, then time advances beyond deadline: durable spawn/cancel/handshake/report result survives, optional observer/advice/hint failures do not falsify it, and retry does not duplicate execution.
7. Fault injection on both sides of COMMIT: throw without committing, and execute the real COMMIT then throw to simulate acknowledgement loss. Both unresolved calls avoid busy, audit and dispatch. On a fresh authorized keyed retry, the first has no phantom record and the second returns the one durable record without dispatch.
8. Secondary rollback failure cannot mask uncertainty, leave a reusable dirty connection or trigger audit. Successful-late COMMIT must not be followed by rollback.
9. Known durable replay survives an incidental completion failure without falsely claiming incidental writes committed. Distinguish this from an unresolved newly created result.
10. Through the actual MCP server/error mapper, verify unchanged external shapes: clean budget exhaustion maps to busy, unresolved commit maps to internal_error, known committed/replayed results retain their original shape. Preserve no-key report behavior.

Use real SQLite for the state assertions and a trusted deterministic seam for timing/fault placement. Supply meaningful baseline or narrowly reverted behavioral negative controls, not missing-export/compile failures. Retain actual timing, cleanup and overrun evidence; no performance pass is claimed by these semantic tests.

## 7. Hook-clock ruling

The inspected hook producer already does more than record an arbitrary start: hook/process.ts maps the rounded BOOTTIME start to a conservative MONOTONIC lower bound. hookStartMonoMs is that lower bound; hookStartUncertaintyMs is its interval width. The existing real probe computes jointUpperMs = flushMonoMs - hookStartMonoMs and jointLowerMs = max(0, jointUpperMs - hookStartUncertaintyMs). Do not add the uncertainty to the deadline, subtract it from the upper-bound elapsed time, or start measurement at publication.

However, consumer validation of matching bootId/processKey/profile, finite ordered numbers and a 30-second freshness window is not itself a general proof that the producer's numeric MONOTONIC epoch equals the consumer's budget clock. Node documents hrtime relative to an arbitrary origin; Linux can virtualize MONOTONIC/BOOTTIME per time namespace. The inspected domain record contains machine/boot/PID namespace, not a verified time-domain correlation. A local performance.now/hrtime calibration alone cannot prove the remote producer domain. [Node 22.13 process timing](https://nodejs.org/download/release/v22.13.0/docs/api/process.html#processhrtimebigint), [Linux time namespaces](https://man7.org/linux/man-pages/man7/time_namespaces.7.html).

For this bounded P065 implementation:

- Keep the original start before per-call validation/source resolution and its original start+30 deadline. All hook-consumer work remains charged to it. Preserve one-shot/tombstone, native-child, profile, boot, session and premise checks. No producer/record/profile changes are released.
- Where there is no independently established trusted enclosing deadline, represent that fact as unavailable internally. Do not invent a 150 ms hard authorization deadline from the record, and do not let absent/untrusted timing extend the original 30 ms. Preserve existing joint measurements with their stated correlation assumptions and uncertainty; formal real-Claude qualification remains pending where those assumptions lack evidence.
- Where trusted composition actually establishes a correlated enclosing deadline, tighten the same object with the minimum of the original authorization deadline and every known enclosing deadline. Never reset the start or restore spent lock allowance. A missing convenience API is not grounds to discard genuinely established timing.
- If a producer-to-consumer common hrtime domain is established and the budget uses that domain, the conservative joint deadline is hookStartMonoMs + 150. For another same-rate local monotonic clock, bracket a calibration as H1=hrtime, P=budgetClock, H2=hrtime. Its offset lies in [P-H2, P-H1]; use the earlier mapped deadline (hookStartMonoMs + 150) + P - H2, subtracting any additional proven correlation error. Do not use Date.now, performance.timeOrigin alone, publication time or a newly sampled start as an origin substitute. Invalid/discontinuous/unbounded correlation cannot supply a trusted deadline.
- Deriving a cap does not guarantee response flush meets a p95 target or allow hard interruption of synchronous COMMIT. Continue measuring full same-call flush, preserving successful-late truth, all overruns and the separate wait/lifecycle boundaries.

Test that known earlier trusted caps tighten the original budget, unknown/untrusted fields cannot extend it, calibration/uncertainty cannot add time, malformed hook records still refuse under their existing source rules, and original 30 ms accounting survives source resolution. Do not claim a synthetic timing seam establishes a production cross-process clock correlation.

## 8. Disposition and sources

The marker and internal uncertainty classification are approved interpretations of already-required durable truth, not new public taxonomy or permission to weaken authorization. The hook disposition applies the brief's explicit genuinely-known/trusted qualifier; it does not relax any numerical gate or promote a capability. Preserve the separate unknown correlation/real-hook qualification limitation in the implementation report. Any proposal needing new producer facts, time-domain/profile policy or an excluded path returns for separate design/ownership disposition.

All existing acceptance commands, negative controls, complete Node 22/24 populations, local-only limits and the explicit compute lease remain in force. This consultation ran no build, test, benchmark or probe and changed no file, branch, permission or external state. A later fresh Oracle still must review the implementation and evidence.

Primary repository sources at the declared pin:

- https://github.com/CartmanFatass/codex-hud/blob/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22/docs/cloud/P065-BUDGET.md
- https://github.com/CartmanFatass/codex-hud/blob/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22/docs/cloud/rulings/p065-metadata-exception.md
- https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/rulings/p065-budget-release.md
- https://github.com/CartmanFatass/codex-hud/blob/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22/docs/contracts/02-execution.md
- https://github.com/CartmanFatass/codex-hud/blob/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22/docs/contracts/06-observation.md
- src/ledger/{ledger,transaction,intents,call-context,handshake,reconcile}.ts; packages/hud-mcp/src/{delegation,handshake,read-control,server,errors,resolvers}.ts at that pin.
- tests/hud-mcp/resume-expected-run.test.ts; tests/unit/ledger-write.test.ts; tests/hud-mcp/hook-source.test.ts at that pin.
- packages/hud-mcp/src/hook/{process,command,record,resolve}.ts and tests/hud-mcp/hook-bench-real.mjs at that pin.