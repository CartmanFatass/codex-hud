# E4-HEADLESS-CLOSE: authenticated-parent headless closure

## Decision and fixed inputs

The owner approved the bounded headless-only option on 2026-11-06: cancel stops the current run while preserving a possible later resume; close ends the delegation relationship after independently confirmed termination. Preserve the underlying session, reports, code and history. Visible close, reopening, real-time send/ask and the paused HUD chat UI are excluded.

Base candidate: `60625488804bed0eff637d0a1b570fd31f158f41`, tree `4bcfc1123db6124e59d4d17a18ae54c4d3ac6e39`, branch `dots/runtime-compose-20261106`. Shared integration was `ba6887ccddc9332971985113f9862a29146d13d1` at design read-back. Use a new independent candidate and never advance integration/main as part of this package.

This is an explicit exception to contract 02 §Deferred and contract 03 I-03-11/12, the closed row, §Deferred and T-03-6/T-03-26. The prior blanket close refusal is real and must be reconciled, not hidden behind an alias or contradicted by an appendix. The unscoped legacy `mvpOperationPolicy('close')` remains unsupported.

The source snapshot is reconstructed, not a complete checkout. Recover missing unchanged inputs at the fixed base and verify their Git blob IDs against the complete base inventory. Keep the approved initial tree and every meaningful failure/evidence record. Do not borrow old validation for new code.

## Approved contract amendment: headless close version 1

### Meaning and scope

`delegate_close` ends an existing delegation relationship. It does not mean stdin EOF, closing an MCP connection, cancelling a single run, deleting history or destroying a host surface.

The sole new entry is authenticated-parent MCP close for a `bound` or `reported`, `current_owner=true` relationship whose latest run is headless and whose stored child identity matches that run. Unconfirmed `pending`/`claimed` relationships remain outside this exception; their existing fixed-run cancellation remains available.

Visible close, local-manager/local-user close, reopening, cross-owner grants, send and ask remain unsupported.

### Input

`{linkId, expectedRun, request_key, grace?}`

- `expectedRun` is mandatory and uses the existing RunId validation.
- `request_key` uses existing 1–256-character validation.
- `grace` is an integer 0–60000 ms, default 10000.
- Reject unknown fields.
- The caller cannot supply owner, caller context, target SessionRef, binding generation, process stamp, backend override or administrative authority.

### Authority and exact target

Every call first passes existing current-source/context/scope-generation authorization. Derive canonical OwnerKey through the existing identity machinery.

For a new close, within the admitting transaction require:

1. The authenticated logical owner matches the link's recorded owner.
2. The link is currently controllable, confirmed and current-owned.
3. `expectedRun` equals the maximum committed `run_seq` for that link.
4. The run is headless.
5. `link.childRef` and `run.targetSessionRef` are non-null, equal full SessionRefs, and consistent with run harness/source.
6. Capture the link, owner, run ID, run sequence, expected binding generation and complete target ref.

Labels, paths, pane hints, inherited markers and matching session ID strings never grant control. Parent identity is not rewritten. One-level creation restrictions remain unchanged, including the restrictive durable history retained after close.

### Idempotency

Use existing canonical OwnerKey × request_key storage, not a second key namespace.

Canonical digest covers `operation:'close'`, `linkId`, `expectedRun` and normalized requested `grace`. Keep `params_version=1`; do not change existing operation encodings. Derived current state, timestamps, labels and later evidence must not change the digest.

Order:

1. Validate current calling authority and captured source premises.
2. Look up the canonical request key.
3. Same digest returns the original immutable outcome; changed digest returns `idempotency_conflict`.
4. Only a new request reaches latest-run and close gates.

A replay never creates cancellation, advances cleanup, changes grace or finalizes closure. Obtain progress from a separate current projection, `delegate_status`, or existing fixed-run wait. Replay remains read-only even after closure or a later historical change.

### Acceptance and cancellation

In one short transaction, record:

- One versioned `close.requested` event anchored to the fixed link/run.
- Frozen actor, owner, full target identity, run sequence/binding generation and requested grace.
- The immutable idempotency outcome.
- If the run is nonterminal and lacks cancellation intent, the existing `cancel.accepted` intent and cancellation fields.

If cancellation already exists, retain its original acceptance time, effective grace and steps. Close cannot restart its clock. Record/reference the existing cancellation sequence in the close outcome.

Do not insert another `intent.accepted` launch event or add `close` to `runs.operation`. No new run, claim, slot or launch ticket is created.

An accepted close immediately fences new resume and predecessor handover for this link. It does not discard the child's reports or rewrite run state into a synthetic terminal state.

A different key while the same close is pending returns `close_already_requested`, without another close/cancel intent. A fresh key on an already closed relationship is an authenticated `already_closed` no-op. An original key still replays its original outcome first.

### Completion

Only the existing reconciler, or the admitting transaction when the run is already terminal, may finalize:

- The frozen owner/link/target/run/binding identities still match.
- It is still the same current run and eligible current relationship.
- A committed, validated terminal decision under unchanged R-02 rules exists.
- Required submission fencing and terminal evidence exist.
- The run and actual target hold no execution slot.
- No unresolved same-target/link conflict exists.

Then atomically set `links.state='closed'`, `current_owner=0`, and `closed_at`; revoke remaining authorization for that closed run; record `link.closed` referencing the close-request sequence and terminal evidence; and revoke its wake registration with existing reason `link_closed`.

Preserve run outcome, terminal note, report, evidence, exit receipt and their original chronology. A close does not turn `ended` into `cancelled`, fabricate native exit status or erase `cancel_timing_unknown`.

Pending close is represented by durable events, not a new link/run state.

### Recovery and changed authority

- Before acceptance, stale/revoked caller context refuses even replay.
- After acceptance, original cancellation and close intent remain durable. Parent disconnect/context retirement does not undo them.
- The reconciler may finish the originally authorized close without recreating a live parent context.
- A subsequently revoked/handed-over relation or changed target must never be overwritten as `closed`. Preserve the accepted record and expose the incompatible relationship state.
- An old request never follows latest to a replacement run.
- Unknown scope, missing evidence or ambiguous cleanup leaves close pending. Slots follow existing R-02 rules.
- No polling service, recovery daemon, relaunch, force-release or new signal path is introduced.
- Status/list/wait remain read-only. Existing explicit reconciliation is the recovery route.
- Closed relationships cannot reopen through resume, handover, observation, binding or a late report.

### Budget and compatibility

Add `delegate_close` to the existing original-receipt 250 ms write-admission budget, including the shared 100 ms contention allowance and all existing COMMIT/cleanup semantics.

A known late COMMIT remains accepted. An unknown COMMIT is `ledger_commit_uncertain`, not retry-safe busy. Failed cleanup poisons the connection. No callback/COMMIT retry.

Declare the two close events with closed, versioned payload schemas; unknown-event readers remain opaque. Existing ledger DDL/user_version and public export schema need not change. Mixed old/new writers are not supported for this behavioral change: retain contract 07's existing prohibition on incompatible writers sharing the same writable store. No automatic migration or rollback of a live ledger is included.

## Contract/document ownership

Apply these approved amendments before implementation, reconciling contradictory clauses rather than merely appending:

- `docs/contracts/02-execution.md`: close event payloads and idempotency/acceptance; exact exception to Deferred; preserve R-02/slot/cancellation evidence.
- `docs/contracts/03-lifecycle.md`: I-03-11/12, link transition table/closed row, resume/handover/deferred, T-03-6/T-03-26 and new headless cases; pending-close fence and no reopening.
- `docs/contracts/06-observation.md`: add only `delegate_close` to existing write-admission amendment; no budget change.
- `docs/contracts/07-outbound-compat.md`: exact deferred-close exception and event/writer compatibility; no outbound grant.
- `docs/universal-hud-concept.md`: distinguish delivered list from close in §6.6.1, narrow deferral, record this owner decision in §15.
- `docs/handoff/questions/e4-headless-close.md`: record the approved bounded technical decision without publishing private conversation transcripts.
- This brief, relevant MCP README/delegation skill instructions, and a technical implementation/check handoff.

Contracts 01, 04 and 05 remain authoritative and unchanged except optional cross-references. No new local-user exception, ScopeControl mechanism, supported provider profile or capability promotion. No HUD information-design/UI amendment.

## Implementation ownership and seam

Implement one MCP → ledger → existing cancellation/reconciliation → status vertical slice. Suggested core paths:

- New `src/core/types/close.ts` and `src/ledger/close.ts` for narrow close request/types/ledger semantics.
- `packages/hud-mcp/src/tools.ts`: strict schema and truthful description.
- `packages/hud-mcp/src/delegation.ts`: dispatch after existing authorization.
- `packages/hud-mcp/src/errors.ts`: sanitized close-specific codes.
- `packages/hud-mcp/src/hook/record.ts`: exact new tool in existing Claude source-verification allowlist; no broader matcher/identity shortcut.
- `src/core/lifecycle.ts`: MCP close authorization only; local-user remains resume-only.
- `src/ledger/reconcile.ts`: reusable in-transaction cancellation-intent seam and close finalization.
- `src/ledger/intents.ts`: pending-close fence for fresh resume/handover, after immutable replay.
- `src/ledger/delegation-read.ts` and relevant status composition: read-only close progress/non-resumability.
- `src/core/run/ledger-port.ts` only for necessary projection consistency.
- Reuse the existing wake-revocation helper unchanged where possible.

Do not change the signal ladder, group helper, process census, RunControl process API, visible control gate, launch capability verifiers, production matrices, installer or paused HUD chat UI. Do not add `RunControl.close()`. Keep generic legacy `mvpOperationPolicy('close')` unsupported and document the qualified entry separately.

Call one idempotent close-finalization helper inside `commitReconcile` after terminal evidence/state/slot handling, including an already-terminal run with no new state transition. Invoke the same helper from close acceptance for an already-terminal run. This prevents a new-writer terminal/close transaction gap. Recovery uses the stored request through existing reconciliation, not replay-triggered writes or a new scheduler.

## Response contract

Separate immutable acceptance from observation:

- `ok`, `replayed`.
- `outcome`: fixed operation/link/run/target generation, close-request sequence/time, cancellation reference and effective grace.
- `current`: close progress, link/run state, terminal-evidence reference, slot status and snapshot sequence; nullable if postcommit observation fails.

Accepted never means process exited or relationship closed. `current.closeState` distinguishes pending, closed and incompatible/superseded relationship state. Preserve explicit uncertainty reasons.

Use existing identity/owner/stale/idempotency/latest-run refusal codes plus narrow unconfirmed-target, unsupported-close-target and close-already-requested codes. Never emit raw exception text or private paths.

## Finite acceptance matrix

Each new behavior needs a test failing without it:

1. Active qualified headless close writes one close and one existing-format cancel intent, with no early closed state.
2. Already-terminal current R/Q/N closes without signalling or another cancel event.
3. Cancellation before/after/unknown chronology preserves existing classifications and receipts.
4. Same-key replay before/after closure returns immutable outcome with zero writes/dispatch; changed target/grace conflicts.
5. Source/context revoked before acceptance/replay refuses; context retirement after acceptance permits only original-target completion.
6. Wrong owner, same ID under different source/thread, wrong binding generation or replaced latest run causes no control.
7. Visible, ordinary/unmanaged and unconfirmed targets refuse close with no cancel/surface effect; existing cancel stays independent.
8. Resume/handover races are transaction-ordered; pending close fences new work, not immutable replay.
9. Unknown cleanup, supervisor loss, wrong scope instance, leader-only exit and conflicting evidence do not fabricate completion or release slots.
10. Relation revoked after acceptance preserves original intent and never overwrites revoked/history or controls a successor.
11. Crash/rollback around acceptance/completion cannot leave half intent or duplicate closure; existing reconciliation recovers without new workers.
12. Late reports/observations and legacy history never reopen; one-level restriction survives close.
13. Budget exhaustion, known late COMMIT, unknown COMMIT and cleanup failure retain exact existing semantics.
14. Claude exact-tool source check, Pi dynamic schema, and rejection of forged owner/admin/generation fields.
15. Synthetic public data only, unchanged production manifests, and no new send/input/surface/process-kill path.

At least one fixture must traverse actual HudMcpServer/DelegationService, temporary SQLite and existing reconciliation, not a duplicate state model. An owned-process simulation proves the real runner seam only if it executes it; otherwise call it ledger/MCP simulation.

## Verification and stopping conditions

The current reconstructed subset and missing compiler/dependencies cannot establish a built-service pass. The exact prerequisite is complete pinned build/test input plus repository-compatible locked TypeScript, Node types, Prettier and runtime dependencies in an authorized environment.

Do not retry blocked registries, obtain replacement compilers, borrow unrelated dependencies, change executor to evade restrictions, or expand the prior bounded startup transform into a general build replacement. Contract and source preparation may proceed; report concrete unavailable verification separately instead of inventing a provider prerequisite.

When prerequisites exist, run final-candidate root/build-test/MCP builds; new ledger/MCP close tests; relevant authorization, delegate-list, resume-expected-run, hook-source, skeleton, run-control and ledger-run regressions; `node --test tests/unit/relaxed-delegation-budget.test.mjs`; scoped formatting, fixture hygiene and exact-diff checks. Preserve all failures and distinguish NOT_RUN from PASS. Existing hosted CI covers only its actual command list. Do not materialize dependencies through CI to bypass the environment restriction.

Real provider/control qualification remains NOT_RUN unless actually exercised. No unrelated historic B qualification replay. Use fresh final Oracle and at most two focused fix/review rounds. Stop for a concrete missing prerequisite, relevant failure, ambiguous cleanup or deviation from the approved scope. The owner decision above resolves the contract fork; no further fork is needed while the implementation stays inside it.
