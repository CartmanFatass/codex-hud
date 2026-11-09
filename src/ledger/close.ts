import { canonicalJson, digest } from '../core/canonical.js';
import { isRunTerminal, lookupIdempotency, reconcileRun, validateRequestKey } from '../core/execution.js';
import { sameSessionRef, validateSessionRef } from '../core/identity.js';
import { authorizeControl } from '../core/lifecycle.js';
import type { CloseOutcome, CloseProgress, CloseRequest, CloseRequested, LinkClosed } from '../core/types/close.js';
import type { LedgerEvent, Run } from '../core/types/execution.js';
import type { Link } from '../core/types/lifecycle.js';
import type { CallBudget } from './call-budget.js';
import { currentAuthority, hasConflict, linkOwner } from './intents.js';
import type { Ledger } from './ledger.js';
import { terminalNote } from './run-facts.js';
import { recordWakeRevoked } from './notify-events.js';
import { decodeRecord, insertRecord, readIdempotency, readLink, readRun, refValue } from './records.js';
import { acceptCancellationIn, factsFromSnapshot, snapshotInTransaction } from './reconcile.js';
import type { LedgerTransaction } from './transaction.js';
import type { IntentAuthority } from './types.js';

function keys(value: unknown, required: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== required.length ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw new TypeError('invalid_close_payload');
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new TypeError('invalid_close_payload');
}
function text(value: unknown): void {
  if (typeof value !== 'string' || !value) throw new TypeError('invalid_close_payload');
}
/** Closed schemas: no implicit version upgrade or authority-bearing extension fields. */
export function validateCloseRequested(value: unknown): asserts value is CloseRequested {
  keys(value, [
    'version',
    'actor',
    'ownerKey',
    'linkId',
    'runId',
    'runSeq',
    'bindingGeneration',
    'targetSessionRef',
    'requestedGraceMs',
    'cancelSeq',
    'effectiveGraceMs',
  ]);
  if (value.version !== 1) throw new TypeError('invalid_close_payload');
  keys(value.actor, ['kind', 'callerId', 'contextId', 'contextGeneration']);
  if (value.actor.kind !== 'mcp') throw new TypeError('invalid_close_payload');
  text(value.actor.callerId);
  text(value.actor.contextId);
  integer(value.actor.contextGeneration, 1);
  for (const key of ['ownerKey', 'linkId', 'runId']) text(value[key]);
  integer(value.runSeq, 1);
  integer(value.bindingGeneration, 1);
  keys(value.targetSessionRef, ['harness', 'sourceId', 'sessionId', 'threadId']);
  validateSessionRef(value.targetSessionRef as unknown as CloseRequested['targetSessionRef']);
  integer(value.requestedGraceMs, 0, 60000);
  if ((value.cancelSeq === null) !== (value.effectiveGraceMs === null)) throw new TypeError('invalid_close_payload');
  if (value.cancelSeq !== null) {
    integer(value.cancelSeq, 1);
    integer(value.effectiveGraceMs, 0, 60000);
  }
}
export function validateLinkClosed(value: unknown): asserts value is LinkClosed {
  keys(value, ['version', 'closeRequestSeq', 'terminalEvidenceId', 'terminalSeq']);
  if (value.version !== 1) throw new TypeError('invalid_close_payload');
  integer(value.closeRequestSeq, 1);
  integer(value.terminalSeq, 1);
  text(value.terminalEvidenceId);
}
export function closeRequestIn(tx: LedgerTransaction, linkId: string): LedgerEvent | null {
  const row = tx.get("SELECT * FROM events WHERE link_id=? AND kind='close.requested' ORDER BY seq LIMIT 1", linkId);
  return row ? decodeRecord<LedgerEvent>(row) : null;
}
/** Deliberately restrictive even if a future/unknown close payload cannot be decoded. */
export function requireNoCloseIn(tx: LedgerTransaction, linkId: string): void {
  if (closeRequestIn(tx, linkId)) throw new Error('close_already_requested');
}
function matches(tx: LedgerTransaction, link: Link, run: Run, request: CloseRequested): boolean {
  const latest = tx.get('SELECT run_id FROM runs WHERE link_id=? ORDER BY run_seq DESC LIMIT 1', link.linkId);
  return (
    link.linkId === request.linkId &&
    run.linkId === request.linkId &&
    run.runId === request.runId &&
    latest?.run_id === request.runId &&
    run.runSeq === request.runSeq &&
    run.expectedGeneration === request.bindingGeneration &&
    run.mode === 'headless' &&
    linkOwner(tx, link) === request.ownerKey &&
    link.childRef !== null &&
    run.targetSessionRef !== null &&
    sameSessionRef(link.childRef, request.targetSessionRef) &&
    sameSessionRef(run.targetSessionRef, request.targetSessionRef) &&
    run.sourceId === request.targetSessionRef.sourceId &&
    run.harness === request.targetSessionRef.harness
  );
}
export function closeProgressIn(tx: LedgerTransaction, link: Link, run: Run): CloseProgress {
  const event = closeRequestIn(tx, link.linkId);
  const slotHeld = !!tx.get(
    'SELECT 1 FROM slots WHERE run_id=? OR session_ref=?',
    run.runId,
    refValue(run.targetSessionRef)
  );
  const lastState = tx.get(
    "SELECT payload FROM events WHERE run_id=? AND kind IN ('run.state','run.terminal','run.reconciliation') ORDER BY seq DESC LIMIT 1",
    run.runId
  );
  const lastTerminal = tx.get(
    "SELECT payload FROM events WHERE run_id=? AND kind='run.terminal' ORDER BY seq DESC LIMIT 1",
    run.runId
  );
  const statePayload = lastState ? JSON.parse(String(lastState.payload)) : null;
  const terminalPayload = lastTerminal ? JSON.parse(String(lastTerminal.payload)) : null;
  const acceptedTerminal =
    run.terminalEvidenceId !== null &&
    !!tx.get(
      "SELECT 1 FROM evidence WHERE evidence_id=? AND run_id=? AND validation='accepted' AND validated_at IS NOT NULL",
      run.terminalEvidenceId,
      run.runId
    );
  let closeState: CloseProgress['closeState'] = link.state === 'closed' ? 'closed' : 'none';
  let reason: string | null = null;
  if (event) {
    try {
      validateCloseRequested(event.payload);
      const compatible = event.runId === event.payload.runId && matches(tx, link, run, event.payload);
      closeState = !compatible
        ? 'incompatible'
        : link.state === 'closed'
          ? 'closed'
          : link.currentOwner && ['bound', 'reported'].includes(link.state)
            ? 'pending'
            : 'incompatible';
      reason =
        closeState === 'incompatible'
          ? 'relationship_changed'
          : closeState === 'pending'
            ? hasConflict(tx, link.linkId, refValue(run.targetSessionRef))
              ? 'unresolved_conflict'
              : slotHeld
                ? typeof statePayload?.cause === 'string'
                  ? statePayload.cause
                  : 'slot_held'
                : isRunTerminal(run)
                  ? acceptedTerminal && lastTerminal
                    ? 'reconciliation_required'
                    : 'terminal_evidence_required'
                  : typeof statePayload?.cause === 'string'
                    ? statePayload.cause
                    : 'termination_unconfirmed'
            : null;
    } catch {
      closeState = 'incompatible';
      reason = 'close_evidence_unavailable';
    }
  }
  return {
    closeState,
    closeRequestSeq: event?.seq ?? null,
    runId: run.runId,
    linkState: link.state,
    runState: run.state,
    terminalEvidenceId: run.terminalEvidenceId,
    terminalNote: terminalNote(terminalPayload?.terminalNote),
    slotHeld,
    reason,
    asOfSeq: Number(tx.get('SELECT coalesce(max(seq),0) AS seq FROM events')!.seq),
  };
}
/** Called in the accepting/reconciling transaction, never by replay, status or wait. */
export function finalizeCloseIn(tx: LedgerTransaction, runId: string, at: number): boolean {
  const run = readRun(tx, runId);
  const link = readLink(tx, run.linkId);
  const event = closeRequestIn(tx, link.linkId);
  if (!event || !link.currentOwner || !['bound', 'reported'].includes(link.state) || !isRunTerminal(run)) return false;
  let request: CloseRequested;
  try {
    validateCloseRequested(event.payload);
    request = event.payload;
  } catch {
    return false;
  } // Unknown evidence cannot authorize a close.
  if (
    event.runId !== runId ||
    !matches(tx, link, run, request) ||
    run.submissionFencedAt === null ||
    run.terminalEvidenceId === null ||
    tx.get('SELECT 1 FROM slots WHERE run_id=? OR session_ref=?', runId, refValue(run.targetSessionRef)) ||
    hasConflict(tx, link.linkId, refValue(run.targetSessionRef))
  )
    return false;
  const evidence = tx.get(
    "SELECT * FROM evidence WHERE evidence_id=? AND run_id=? AND link_id=? AND validation='accepted' AND validated_at IS NOT NULL",
    run.terminalEvidenceId,
    runId,
    link.linkId
  );
  const terminal = tx.get(
    "SELECT * FROM events WHERE run_id=? AND link_id=? AND kind='run.terminal' ORDER BY seq DESC LIMIT 1",
    runId,
    link.linkId
  );
  if (!evidence || !terminal) return false;
  const payload = JSON.parse(String(terminal.payload));
  if (payload.state !== run.state || !['R-02-2', 'R-02-3', 'R-02-4'].includes(payload.row)) return false;
  const snapshot = snapshotInTransaction(tx, runId);
  const facts = factsFromSnapshot(snapshot);
  // Re-evaluate the stored terminal basis and current counter-evidence under unchanged R-02.
  const decision = reconcileRun(run, facts, at, {
    slotHeld: false,
    ticketConsumed: run.launchPhase !== 'reserved',
    terminalBasis: { evidence: facts, terminalNote: snapshot.terminalNote },
  });
  if (decision.blockNewOperations) return false;
  // R-02-0 preserves an existing terminal state; it is not a substitute for its
  // independently validated R/Q/N basis if that basis is missing or damaged.
  const proof = reconcileRun({ ...run, state: 'running', endedAt: null, terminalEvidenceId: null }, facts, at, {
    slotHeld: true,
    ticketConsumed: run.launchPhase !== 'reserved',
  });
  if (!isRunTerminal({ state: proof.state }) || proof.blockNewOperations) return false;
  const closed: LinkClosed = {
    version: 1,
    closeRequestSeq: event.seq,
    terminalEvidenceId: run.terminalEvidenceId,
    terminalSeq: Number(terminal.seq),
  };
  validateLinkClosed(closed);
  tx.run("UPDATE links SET state='closed',current_owner=0,closed_at=? WHERE link_id=?", at, link.linkId);
  tx.run("UPDATE claims SET state='revoked' WHERE run_id=?", runId);
  tx.run('UPDATE child_bindings SET is_current=0,revoked_at=? WHERE run_id=? AND is_current=1', at, runId);
  insertRecord(tx, 'events', { runId, linkId: link.linkId, kind: 'link.closed', payload: closed, at });
  const wakes = tx.all(
    `SELECT e.seq FROM events e WHERE e.link_id=? AND e.kind='wake.registered'
    AND NOT EXISTS (SELECT 1 FROM events r WHERE r.link_id=e.link_id AND r.kind='wake.revoked'
    AND json_extract(r.payload,'$.registrationSeq')=e.seq)`,
    link.linkId
  );
  for (const wake of wakes)
    recordWakeRevoked(tx, link.linkId, { registrationSeq: Number(wake.seq), reason: 'link_closed' }, at);
  return true;
}
export async function requestClose(
  ledger: Ledger,
  supplied: CloseRequest,
  authority: IntentAuthority,
  at: number,
  budget: number | CallBudget = ledger.busyBudgetMs
): Promise<{ replayed: boolean; outcome: CloseOutcome }> {
  const input = JSON.parse(canonicalJson(supplied)) as CloseRequest;
  if (
    Object.keys(input).some((key) => !['linkId', 'expectedRun', 'request_key', 'grace'].includes(key)) ||
    typeof input.linkId !== 'string' ||
    !input.linkId ||
    typeof input.expectedRun !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.expectedRun)
  )
    throw new TypeError('invalid');
  validateRequestKey(input.request_key);
  const grace = input.grace === undefined ? 10000 : input.grace;
  if (!Number.isSafeInteger(grace) || grace < 0 || grace > 60000) throw new TypeError('invalid_grace');
  if (!Number.isSafeInteger(at) || at < 0) throw new TypeError('invalid_close_time');
  const paramsDigest = digest({ operation: 'close', linkId: input.linkId, expectedRun: input.expectedRun, grace });
  return ledger.transaction((tx) => {
    const current = currentAuthority(tx, authority);
    if (current.kind !== 'mcp') throw new Error('unsupported');
    if (!current.selection.ok) throw new Error(current.selection.reason);
    const ownerKey = current.selection.ownerKey;
    const replay = lookupIdempotency(
      readIdempotency(tx, ownerKey, input.request_key),
      ownerKey,
      input.request_key,
      paramsDigest
    );
    if (replay.kind === 'conflict') throw new Error(replay.reason);
    if (replay.kind === 'replay')
      return tx.priorDurableResult({ replayed: true, outcome: replay.record.outcome as unknown as CloseOutcome });
    const link = readLink(tx, input.linkId);
    const allowed = authorizeControl('close', link, linkOwner(tx, link), current);
    if (!allowed.ok) throw new Error(allowed.reason);
    if (allowed.actor.kind !== 'mcp') throw new Error('unsupported');
    const latest = tx.get('SELECT run_id FROM runs WHERE link_id=? ORDER BY run_seq DESC LIMIT 1', link.linkId);
    if (latest?.run_id !== input.expectedRun) throw new Error('expected_run_mismatch');
    const run = readRun(tx, input.expectedRun);
    if (run.mode !== 'headless') throw new Error('unsupported_close_target');
    if (!link.childRef || !run.targetSessionRef || !['bound', 'reported', 'closed'].includes(link.state))
      throw new Error('unconfirmed_close_target');
    if (
      !sameSessionRef(link.childRef, run.targetSessionRef) ||
      run.sourceId !== link.childRef.sourceId ||
      run.harness !== link.childRef.harness
    )
      throw new Error('identity_conflict');
    if (link.state !== 'closed' && !link.currentOwner) throw new Error('not_current_owner');
    let event = closeRequestIn(tx, link.linkId);
    if (event && link.state !== 'closed') throw new Error('close_already_requested');
    let cancel = tx.get(
      "SELECT seq,payload FROM events WHERE run_id=? AND kind='cancel.accepted' ORDER BY seq LIMIT 1",
      run.runId
    );
    if (link.state !== 'closed') {
      if (run.cancelRequestedAt !== null && !cancel) throw new Error('identity_conflict');
      acceptCancellationIn(tx, run, allowed.actor, at, grace);
      cancel = tx.get(
        "SELECT seq,payload FROM events WHERE run_id=? AND kind='cancel.accepted' ORDER BY seq LIMIT 1",
        run.runId
      );
      const payload: CloseRequested = {
        version: 1,
        actor: allowed.actor,
        ownerKey,
        linkId: link.linkId,
        runId: run.runId,
        runSeq: run.runSeq,
        bindingGeneration: run.expectedGeneration,
        targetSessionRef: run.targetSessionRef,
        requestedGraceMs: grace,
        cancelSeq: cancel ? Number(cancel.seq) : null,
        effectiveGraceMs: cancel ? Number(JSON.parse(String(cancel.payload)).graceMs) : null,
      };
      validateCloseRequested(payload);
      insertRecord(tx, 'events', { runId: run.runId, linkId: link.linkId, kind: 'close.requested', payload, at });
      event = closeRequestIn(tx, link.linkId);
    }
    const outcome: CloseOutcome = {
      operation: 'close',
      status: link.state === 'closed' ? 'already_closed' : 'accepted',
      linkId: link.linkId,
      runId: run.runId,
      runSeq: run.runSeq,
      bindingGeneration: run.expectedGeneration,
      targetSessionRef: run.targetSessionRef,
      closeRequestSeq: event?.seq ?? null,
      closeRequestedAt: event?.at ?? null,
      cancelSeq: cancel ? Number(cancel.seq) : null,
      effectiveGraceMs: cancel ? Number(JSON.parse(String(cancel.payload)).graceMs) : null,
    };
    insertRecord(tx, 'idempotency', {
      ownerKey,
      originOwnerKey: ownerKey,
      requestKey: input.request_key,
      paramsVersion: 1,
      paramsDigest,
      linkId: link.linkId,
      runId: run.runId,
      outcome,
      at,
    });
    if (link.state !== 'closed') finalizeCloseIn(tx, run.runId, at);
    return { replayed: false, outcome };
  }, budget);
}
