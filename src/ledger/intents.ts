import { canonicalJson, requireCanonicalAbsolutePath } from '../core/canonical.js';
import { performance } from 'node:perf_hooks';
import {
  lookupIdempotency,
  makeRunSlot,
  prepareRunContext,
  validateRequestKey,
  validateRun,
} from '../core/execution.js';
import { procOwnerKey, selectCallContext, sessionOwnerKey } from '../core/identity.js';
import {
  authorizeControl,
  handoverGate,
  planResume,
  resumeGate,
  taskDigest,
  type ControlAuthority,
} from '../core/lifecycle.js';
import type { ControlInitiator } from '../core/types/identity.js';
import type { Run } from '../core/types/execution.js';
import type { Link } from '../core/types/lifecycle.js';
import type { Ledger } from './ledger.js';
import {
  decodeRecord,
  insertClaim,
  insertRecord,
  insertRun,
  readContext,
  readIdempotency,
  readLink,
  readRun,
  refValue,
  validateOrigin,
  validateWorkspace,
} from './records.js';
import type { LedgerTransaction } from './transaction.js';
import type { AcceptedActor, IntentAuthority, IntentResult, PreparedIntent } from './types.js';

export function currentAuthority(tx: LedgerTransaction, authority: IntentAuthority): ControlAuthority {
  if (authority.kind === 'local_user') return authority;
  const context = readContext(tx, authority.contextId, authority.generation);
  const scope = tx.get(
    'SELECT closed_at FROM caller_scopes WHERE process_key=? AND generation=?',
    context.processKey,
    context.procGeneration
  );
  const caller = tx.get('SELECT retired_at FROM callers WHERE caller_id=?', context.callerId);
  if (!scope || scope.closed_at !== null || !caller || caller.retired_at !== null) throw new Error('stale_context');
  return { kind: 'mcp', selection: selectCallContext(context, authority.evidence) };
}
export function linkOwner(tx: LedgerTransaction, link: Link): string {
  if (link.parentRef !== null) return sessionOwnerKey(link.parentRef);
  const context = readContext(tx, link.parentContextId, link.parentContextGeneration);
  if (context.kind !== 'dedicated') throw new Error('unsupported');
  return context.sessionRef === null
    ? procOwnerKey(context.processKey, context.procGeneration)
    : sessionOwnerKey(context.sessionRef);
}
export function acceptedActor(tx: LedgerTransaction, runId: string): AcceptedActor {
  const row = tx.get(
    "SELECT payload FROM events WHERE run_id=? AND kind='intent.accepted' ORDER BY seq LIMIT 1",
    runId
  );
  if (!row) throw new Error('accepted_actor_missing');
  const payload = JSON.parse(String(row.payload));
  return { actor: payload.actor, ownerKey: payload.ownerKey };
}
export function requireParentControl(link: Link): void {
  if (
    !['pending', 'claimed', 'bound', 'reported'].includes(link.state) ||
    ((link.state === 'bound' || link.state === 'reported') && !link.currentOwner)
  )
    throw new Error('unauthorized');
}
export function revalidateActor(tx: LedgerTransaction, run: Run, authority: IntentAuthority): ControlInitiator {
  const { actor } = acceptedActor(tx, run.runId);
  const current = currentAuthority(tx, authority);
  const link = readLink(tx, run.linkId);
  requireParentControl(link);
  const allowed = authorizeControl(
    actor.kind === 'local_user' ? 'resume' : run.operation === 'handover' ? 'predecessor' : run.operation,
    link,
    linkOwner(tx, link),
    current
  );
  if (!allowed.ok) throw new Error(allowed.reason);
  if (canonicalJson(actor) !== canonicalJson(allowed.actor)) throw new Error('initiator_mismatch');
  return actor;
}
export function hasEvidenceConflict(tx: LedgerTransaction, linkId: string, ref: string | null): boolean {
  // A conflict is cleared only by accepted explicit resolution referencing its evidence id.
  return Boolean(
    tx.get(
      `SELECT e.evidence_id FROM evidence e
    WHERE e.kind='conflict' AND e.validation='accepted'
      AND (e.link_id=? OR e.run_id IN (SELECT run_id FROM runs WHERE target_session_ref=?))
      AND NOT EXISTS (SELECT 1 FROM evidence r WHERE r.kind='conflict_resolved' AND r.validation='accepted'
        AND r.run_id IS e.run_id AND json_extract(r.payload,'$.resolves')=e.evidence_id) LIMIT 1`,
      linkId,
      ref
    )
  );
}
export function hasConflict(tx: LedgerTransaction, linkId: string, ref: string | null): boolean {
  if (hasEvidenceConflict(tx, linkId, ref)) return true;
  // Terminal R-02-0 can also prohibit reuse because timing is unknown, without inventing X.
  return Boolean(
    tx.get(
      `SELECT e.seq FROM events e JOIN runs r ON r.run_id=e.run_id
    WHERE e.kind='run.reconciliation' AND json_extract(e.payload,'$.blockNewOperations')=1
      AND (r.link_id=? OR r.target_session_ref=?)
      AND e.seq=(SELECT max(latest.seq) FROM events latest WHERE latest.run_id=e.run_id AND latest.kind='run.reconciliation') LIMIT 1`,
      linkId,
      ref
    )
  );
}
function validateNewIntent(input: PreparedIntent): string {
  const { run, link, claim, params } = input;
  validateRequestKey(input.requestKey);
  validateRun(run);
  validateWorkspace(run.workspaceSnapshot);
  validateOrigin(run.projectOrigin);
  requireCanonicalAbsolutePath(link.briefPath);
  if (link.reportPath !== null) requireCanonicalAbsolutePath(link.reportPath);
  if (
    run.linkId !== link.linkId ||
    claim.runId !== run.runId ||
    claim.sourceId !== run.sourceId ||
    claim.expectedGeneration !== run.expectedGeneration ||
    claim.state !== 'issued' ||
    claim.supervisor !== null ||
    claim.redeemedAt !== null ||
    claim.redeemedContextId !== null ||
    claim.redeemedGeneration !== null ||
    claim.redeemedSessionRef !== null ||
    claim.issuedAt !== run.createdAt ||
    claim.expiresAt !== run.createdAt + 1800000 ||
    run.state !== 'starting' ||
    run.launchPhase !== 'reserved' ||
    run.supervisor !== null ||
    run.scopeRef !== null ||
    run.cancelRequestedAt !== null ||
    run.submissionFencedAt !== null ||
    run.heartbeatSeq !== 0 ||
    run.startedAt !== null ||
    params.sourceId !== run.sourceId ||
    params.mode !== run.mode ||
    params.backend !== link.backend ||
    params.role !== link.role ||
    params.briefPath !== link.briefPath ||
    (params.reportPath ?? null) !== link.reportPath ||
    (params.orphanPolicy ?? 'continue') !== run.orphanPolicy ||
    typeof params.briefContentHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(params.briefContentHash) ||
    taskDigest(link.briefPath, params.briefContentHash, link.backend, run.sourceId, link.role) !== link.taskDigest
  )
    throw new TypeError('invalid_prepared_intent');
  const context = prepareRunContext(run.operation, params, {
    workspaceSnapshot: run.workspaceSnapshot,
    projectOrigin: run.projectOrigin,
  });
  if (
    context.launchCwd !== run.launchCwd ||
    (params.requestKey !== undefined && params.requestKey !== input.requestKey)
  )
    throw new TypeError('request_context_mismatch');
  return context.paramsDigest;
}

/** Persist intent, issued claim, execution slot, replay result and actor event atomically. */
export async function acceptIntent(ledger: Ledger, supplied: PreparedIntent): Promise<IntentResult> {
  // Clone and perform normalization/hashing outside the write transaction, before any await.
  const input = JSON.parse(canonicalJson(supplied)) as PreparedIntent;
  const paramsDigest = validateNewIntent(input);
  const writeDeadline = performance.now() + ledger.busyBudgetMs;
  try {
    return await ledger.transaction((tx) => {
      const authority = currentAuthority(tx, input.authority);
      const existing = tx.get('SELECT * FROM links WHERE link_id=?', input.link.linkId);
      let link = existing ? decodeRecord<Link>(existing) : input.link;
      const registeredOwner = existing
        ? linkOwner(tx, link)
        : authority.kind === 'mcp' && authority.selection.ok
          ? authority.selection.ownerKey
          : '';
      const allowed = authorizeControl(
        input.run.operation === 'handover' ? 'predecessor' : input.run.operation,
        link,
        registeredOwner,
        authority
      );
      if (!allowed.ok) throw new Error(allowed.reason);
      const replay = lookupIdempotency(
        readIdempotency(tx, allowed.ownerKey, input.requestKey),
        allowed.ownerKey,
        input.requestKey,
        paramsDigest
      );
      if (replay.kind === 'conflict') throw new Error(replay.reason);
      if (replay.kind === 'replay')
        return {
          replayed: true,
          outcome: replay.record.outcome,
          linkId: replay.record.linkId,
          runId: replay.record.runId,
        };
      if (!input.capabilityVerified) throw new Error('capability_unverified');
      let run = input.run;
      let claim = input.claim;
      if (run.operation === 'spawn') {
        if (
          existing ||
          !input.newSession ||
          run.targetSessionRef !== null ||
          run.runSeq !== 1 ||
          link.predecessor !== null ||
          link.state !== 'pending' ||
          link.childRef !== null ||
          link.currentOwner ||
          authority.kind !== 'mcp' ||
          !authority.selection.ok
        )
          throw new Error('new_session_required');
        const context = authority.selection.context;
        if (
          link.parentCaller !== context.callerId ||
          link.parentContextId !== context.contextId ||
          link.parentContextGeneration !== context.generation ||
          refValue(link.parentRef) !== refValue(context.sessionRef)
        )
          throw new Error('parent_context_mismatch');
        insertRecord(tx, 'links', link);
      } else if (run.operation === 'resume') {
        if (!existing || input.params.linkId !== link.linkId || typeof input.params.expectedRun !== 'string')
          throw new Error('resume_target_required');
        const previousRow = tx.get(
          'SELECT run_id FROM runs WHERE link_id=? ORDER BY run_seq DESC LIMIT 1',
          link.linkId
        );
        if (!previousRow) throw new Error('run_not_found');
        const previous = readRun(tx, String(previousRow.run_id));
        const gate = {
          link,
          registeredOwner,
          authority,
          currentRun: previous,
          expectedRun: input.params.expectedRun,
          taskDigest: input.link.taskDigest,
          slotHeld: Boolean(tx.get('SELECT 1 FROM slots WHERE session_ref=?', refValue(link.childRef))),
          unresolvedConflict: hasConflict(tx, link.linkId, refValue(link.childRef)),
          capabilityVerified: input.capabilityVerified,
        };
        const result = resumeGate(gate);
        if (!result.ok) throw new Error(result.reason);
        const plan = planResume(
          gate,
          {
            runId: run.runId,
            bindingGeneration: run.expectedGeneration,
            claimHash: claim.claimHash,
            launchTokenHash: run.launchTokenHash,
            launchDigest: run.launchDigest,
            launchCallId: run.launchCallId,
            launchCorrelationId: run.launchCorrelationId,
            mode: run.mode,
            launchCwd: run.launchCwd,
            projectOrigin: run.projectOrigin,
            workspaceSnapshot: run.workspaceSnapshot,
            at: run.createdAt,
          },
          null,
          null
        );
        if (run.runSeq !== plan.run.runSeq || refValue(run.targetSessionRef) !== refValue(plan.run.targetSessionRef))
          throw new Error('resume_context_mismatch');
        run = { ...plan.run, orphanPolicy: input.run.orphanPolicy };
        claim = plan.claim;
        tx.run("UPDATE claims SET state='revoked' WHERE run_id=?", previous.runId);
        tx.run(
          'UPDATE child_bindings SET is_current=0,revoked_at=? WHERE run_id=? AND is_current=1',
          run.createdAt,
          previous.runId
        );
        tx.run("UPDATE links SET state='bound' WHERE link_id=?", link.linkId);
      } else {
        if (existing || !link.predecessor || !link.parentRef || input.params.predecessor !== link.predecessor)
          throw new Error('predecessor_required');
        const old = readLink(tx, link.predecessor);
        const previous = tx.get('SELECT run_id FROM runs WHERE link_id=? ORDER BY run_seq DESC LIMIT 1', old.linkId);
        if (!previous) throw new Error('run_not_found');
        const previousRun = readRun(tx, String(previous.run_id));
        const gate = handoverGate({
          link: old,
          registeredOwner: linkOwner(tx, old),
          authority,
          currentRun: previousRun,
          slotHeld: Boolean(tx.get('SELECT 1 FROM slots WHERE session_ref=?', refValue(old.childRef))),
          unresolvedConflict: hasConflict(tx, old.linkId, refValue(old.childRef)),
          capabilityVerified: input.capabilityVerified,
          newParentRef: link.parentRef,
          graph: tx.all('SELECT * FROM links WHERE current_owner=1').map((row) => decodeRecord<Link>(row)),
          graphBudget: 200,
        });
        if (!gate.ok) throw new Error(gate.reason);
        if (
          run.expectedGeneration <= previousRun.expectedGeneration ||
          run.launchTokenHash === previousRun.launchTokenHash ||
          run.launchCallId === previousRun.launchCallId ||
          run.launchCorrelationId === previousRun.launchCorrelationId
        )
          throw new Error('new_run_anchors_required');
        if (
          authority.kind !== 'mcp' ||
          !authority.selection.ok ||
          link.parentCaller !== authority.selection.context.callerId ||
          link.parentContextId !== authority.selection.context.contextId ||
          link.parentContextGeneration !== authority.selection.context.generation
        )
          throw new Error('parent_context_mismatch');
        if (
          refValue(run.targetSessionRef) !== refValue(old.childRef) ||
          refValue(link.childRef) !== refValue(old.childRef) ||
          link.state !== 'bound' ||
          !link.currentOwner ||
          run.runSeq !== 1
        )
          throw new Error('handover_context_mismatch');
        tx.run("UPDATE links SET state='handed_over',current_owner=0 WHERE link_id=?", old.linkId);
        tx.run("UPDATE claims SET state='revoked' WHERE run_id=?", previousRun.runId);
        tx.run(
          'UPDATE child_bindings SET is_current=0,revoked_at=? WHERE run_id=? AND is_current=1',
          run.createdAt,
          previousRun.runId
        );
        insertRecord(tx, 'links', link);
      }
      const slot = makeRunSlot(
        run.runId,
        run.targetSessionRef,
        run.operation,
        input.newSession,
        input.holder,
        run.createdAt
      );
      if (tx.get('SELECT 1 FROM slots WHERE slot_key=?', slot.slotKey)) throw new Error('slot_busy');
      if (hasConflict(tx, link.linkId, refValue(run.targetSessionRef))) throw new Error('unresolved_conflict');
      insertRun(tx, run);
      insertClaim(tx, claim);
      insertRecord(tx, 'slots', slot);
      const outcome = { status: 'accepted', state: 'starting', linkId: link.linkId, runId: run.runId };
      insertRecord(tx, 'idempotency', {
        ownerKey: allowed.ownerKey,
        originOwnerKey: allowed.ownerKey,
        requestKey: input.requestKey,
        paramsVersion: 1,
        paramsDigest,
        linkId: link.linkId,
        runId: run.runId,
        outcome,
        at: run.createdAt,
      });
      insertRecord(tx, 'events', {
        linkId: link.linkId,
        runId: run.runId,
        kind: 'intent.accepted',
        payload: {
          actor: allowed.actor,
          ownerKey: allowed.ownerKey,
          operation: run.operation,
          requestKey: input.requestKey,
          paramsDigest,
        },
        at: run.createdAt,
      });
      if (run.workspaceSnapshot !== null)
        insertRecord(tx, 'events', {
          linkId: link.linkId,
          runId: run.runId,
          kind: 'workspace.captured',
          payload: { capturedAt: run.createdAt, snapshot: run.workspaceSnapshot },
          at: run.createdAt,
        });
      return { replayed: false, outcome, linkId: link.linkId, runId: run.runId };
    });
  } catch (error) {
    // A failed intent is entirely rolled back before a separate rejection audit is attempted.
    if (error instanceof Error && !('code' in error && error.code === 'ledger_busy')) {
      await ledger
        .transaction(
          (tx) =>
            insertRecord(tx, 'events', {
              linkId: null,
              runId: null,
              kind: 'intent.rejected',
              payload: { requestKey: input.requestKey, reason: error.message },
              at: input.run.createdAt,
            }),
          Math.max(0, writeDeadline - performance.now())
        )
        .catch(() => {});
    }
    throw error;
  }
}
