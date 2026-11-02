import { canonicalJson, digest, type JsonObject } from '../core/canonical.js';
import { isRunTerminal, reconcileRun, updateRun } from '../core/execution.js';
import { advanceLink } from '../core/lifecycle.js';
import type { ReconcileDecision, ReconcileEvidence } from '../core/types/execution.js';
import type { FinalExitReceipt } from '../core/types/supervision.js';
import { authorizeControl } from '../core/lifecycle.js';
import type { Ledger } from './ledger.js';
import { currentAuthority, hasEvidenceConflict, linkOwner, requireParentControl } from './intents.js';
import { decodeRecord, insertRecord, readEvidence, readEvents, readLink, readRun, refValue } from './records.js';
import type { LedgerTransaction } from './transaction.js';
import type { IntentAuthority, ReconcileSnapshot, ValidatedEvidence } from './types.js';

function versionRows(tx: LedgerTransaction, runId: string): object {
  const row = tx.get('SELECT * FROM runs WHERE run_id=?', runId);
  if (!row) throw new Error('run_not_found');
  const link = tx.get('SELECT * FROM links WHERE link_id=?', row.link_id);
  if (!link) throw new Error('link_not_found');
  const context = tx.get(
    'SELECT * FROM caller_contexts WHERE context_id=? AND generation=?',
    link.parent_context_id,
    link.parent_context_generation
  );
  return {
    ledger: tx.get('SELECT ledger_id FROM ledger_metadata WHERE singleton=1'),
    run: row,
    link,
    latest: tx.get(
      'SELECT run_id,run_seq,expected_generation FROM runs WHERE link_id=? ORDER BY run_seq DESC LIMIT 1',
      row.link_id
    ),
    claims: tx.all('SELECT * FROM claims WHERE run_id=?', runId),
    bindings: tx.all('SELECT * FROM child_bindings WHERE run_id=? ORDER BY binding_id', runId),
    context: context ?? null,
    caller: context ? (tx.get('SELECT * FROM callers WHERE caller_id=?', context.caller_id) ?? null) : null,
    scope:
      context?.process_key === null || !context
        ? null
        : (tx.get(
            'SELECT * FROM caller_scopes WHERE process_key=? AND generation=?',
            context.process_key,
            context.proc_generation
          ) ?? null),
    aliases: context
      ? tx.all(
          'SELECT * FROM owner_aliases WHERE process_key=? AND generation=?',
          context.process_key,
          context.proc_generation
        )
      : [],
    childContexts: tx.all(
      `SELECT c.* FROM caller_contexts c JOIN child_bindings b ON c.context_id=b.caller_context_id
      AND c.generation=b.context_generation WHERE b.run_id=? ORDER BY b.binding_id`,
      runId
    ),
    slots: tx.all(
      'SELECT * FROM slots WHERE run_id=? OR session_ref=? ORDER BY slot_key',
      runId,
      row.target_session_ref
    ),
    evidence: tx.all(
      `SELECT * FROM evidence WHERE run_id=? OR link_id=?
      OR run_id IN (SELECT run_id FROM runs WHERE target_session_ref=?) ORDER BY evidence_id`,
      runId,
      row.link_id,
      row.target_session_ref
    ),
    events: tx.all(
      `SELECT * FROM events WHERE run_id=? OR link_id=?
      OR run_id IN (SELECT run_id FROM runs WHERE target_session_ref=?) ORDER BY seq`,
      runId,
      row.link_id,
      row.target_session_ref
    ),
  };
}
export function snapshotInTransaction(tx: LedgerTransaction, runId: string): ReconcileSnapshot {
  const run = readRun(tx, runId);
  const terminal = [...readEvents(tx, runId)].reverse().find((event) => event.kind === 'run.terminal');
  return {
    run,
    link: readLink(tx, run.linkId),
    evidence: readEvidence(tx, runId),
    version: canonicalJson(versionRows(tx, runId)),
    asOfSeq: Number(tx.get('SELECT coalesce(max(seq),0) AS seq FROM events')?.seq),
    terminalNote: terminal?.payload.terminalNote === 'cancel_timing_unknown' ? 'cancel_timing_unknown' : null,
  };
}
/** Gather this snapshot BEFORE OS/file probes; commit compares all relevant persisted facts again. */
export function readReconcileSnapshot(ledger: Ledger, runId: string): ReconcileSnapshot {
  return ledger.snapshot((tx) => snapshotInTransaction(tx, runId));
}
function factsFromSnapshot(snapshot: ReconcileSnapshot): ReconcileEvidence[] {
  const resolved = new Set(
    snapshot.evidence
      .filter((entry) => entry.kind === 'conflict_resolved' && entry.validation === 'accepted')
      .map((entry) => entry.payload.resolves)
  );
  return snapshot.evidence.flatMap((entry) => {
    if (entry.validation !== 'accepted' || resolved.has(entry.evidenceId)) return [];
    const facts = entry.payload.reconcileFacts;
    return Array.isArray(facts) ? (facts as unknown as ReconcileEvidence[]) : [];
  });
}
function preparedEvidence(supplied: readonly ValidatedEvidence[], runId: string): ValidatedEvidence[] {
  const result = JSON.parse(canonicalJson(supplied)) as ValidatedEvidence[];
  for (const entry of result) {
    if (
      entry.record.runId !== runId ||
      entry.record.validation !== 'accepted' ||
      entry.record.validatedAt === null ||
      entry.facts.some(
        (fact) => fact.runId !== runId || fact.evidenceId !== entry.record.evidenceId || fact.validation !== 'accepted'
      )
    )
      throw new TypeError('invalid_validated_evidence');
    entry.record.payload = { ...entry.record.payload, reconcileFacts: JSON.parse(canonicalJson(entry.facts)) };
  }
  return result;
}
function persistEvidence(tx: LedgerTransaction, entry: ValidatedEvidence): void {
  const existing = tx.get('SELECT * FROM evidence WHERE evidence_id=?', entry.record.evidenceId);
  if (existing) {
    if (canonicalJson(decodeRecord(existing)) !== canonicalJson(entry.record)) throw new Error('evidence_id_conflict');
    return;
  }
  insertRecord(tx, 'evidence', entry.record);
}
function persistConflict(
  tx: LedgerTransaction,
  snapshot: ReconcileSnapshot,
  decision: ReconcileDecision,
  at: number
): void {
  if (!decision.blockNewOperations || decision.cause === null) return;
  if (!['scope_conflict', 'identity_conflict', 'resume_ref_mismatch', 'provisional_conflict'].includes(decision.cause))
    return;
  if (
    hasEvidenceConflict(
      tx,
      snapshot.link.linkId,
      snapshot.run.targetSessionRef === null
        ? null
        : JSON.stringify([
            snapshot.run.targetSessionRef.harness,
            snapshot.run.targetSessionRef.sourceId,
            snapshot.run.targetSessionRef.sessionId,
            snapshot.run.targetSessionRef.threadId,
          ])
    )
  )
    return;
  const evidenceId = `conflict:${digest([snapshot.run.runId, decision.cause, [...decision.evidenceIds].sort()])}`;
  const fact: ReconcileEvidence = {
    evidenceId,
    runId: snapshot.run.runId,
    sourceId: snapshot.run.sourceId,
    bindingGeneration: snapshot.run.expectedGeneration,
    supervisor: snapshot.run.supervisor,
    validation: 'accepted',
    asOf: at,
    observedAt: at,
    fact: { kind: 'conflict', cause: decision.cause },
  };
  insertRecord(tx, 'evidence', {
    evidenceId,
    runId: snapshot.run.runId,
    linkId: snapshot.link.linkId,
    kind: 'conflict',
    producer: 'reconciler',
    fingerprint: digest(fact),
    payload: { reconcileFacts: [fact], cause: decision.cause, evidenceIds: decision.evidenceIds },
    observedAt: at,
    validatedAt: at,
    validation: 'accepted',
  });
  insertRecord(tx, 'events', {
    runId: snapshot.run.runId,
    linkId: snapshot.link.linkId,
    kind: 'run.conflict',
    payload: { evidenceId, cause: decision.cause },
    at,
  });
}

/** Stale writers do not even import their evidence. They must gather a fresh snapshot and revalidate. */
export async function commitReconcile(
  ledger: Ledger,
  expected: ReconcileSnapshot,
  supplied: readonly ValidatedEvidence[],
  nowMs: number,
  gate?: (tx: LedgerTransaction) => void
): Promise<{ committed: false; reason: 'stale_snapshot' } | { committed: true; decision: ReconcileDecision }> {
  const runId = expected.run.runId;
  const expectedVersion = expected.version;
  const incoming = preparedEvidence(supplied, runId);
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new TypeError('invalid_reconcile_time');
  return ledger.transaction((tx) => {
    if (canonicalJson(versionRows(tx, runId)) !== expectedVersion)
      return { committed: false as const, reason: 'stale_snapshot' as const };
    gate?.(tx);
    const projected = tx.get('SELECT supervisor_pid FROM runs WHERE run_id=?', runId);
    if (projected?.supervisor_pid !== null && readRun(tx, runId).supervisor === null)
      throw new Error('supervisor_registration_unknown');
    for (const entry of incoming) persistEvidence(tx, entry);
    const current = snapshotInTransaction(tx, runId);
    const facts = factsFromSnapshot(current);
    // Accepted X may originate on a relation or a prior run sharing the actual target. A fresh
    // snapshot must retain it even when its producer did not attach normalized fact sidecars.
    const conflicts = tx.all(
      `SELECT e.* FROM evidence e WHERE e.kind='conflict' AND e.validation='accepted'
      AND (e.link_id=? OR e.run_id IN (SELECT run_id FROM runs WHERE target_session_ref=?))
      AND NOT EXISTS (SELECT 1 FROM evidence r WHERE r.kind='conflict_resolved' AND r.validation='accepted'
        AND r.run_id IS e.run_id AND json_extract(r.payload,'$.resolves')=e.evidence_id) ORDER BY e.evidence_id`,
      current.link.linkId,
      refValue(current.run.targetSessionRef)
    );
    for (const conflict of conflicts)
      facts.push({
        evidenceId: String(conflict.evidence_id),
        runId,
        sourceId: current.run.sourceId,
        bindingGeneration: current.run.expectedGeneration,
        supervisor: current.run.supervisor,
        validation: 'accepted',
        asOf: null,
        observedAt: Number(conflict.observed_at),
        fact: { kind: 'conflict', cause: 'scope_conflict' },
      });
    const slotHeld = Boolean(tx.get('SELECT 1 FROM slots WHERE run_id=?', runId));
    const decision = reconcileRun(current.run, facts, nowMs, {
      slotHeld,
      ticketConsumed: current.run.launchPhase !== 'reserved',
      terminalBasis: { evidence: facts, terminalNote: current.terminalNote },
    });
    const receipt = readEvents(tx, runId).find((event) => event.kind === 'exit.receipt')?.payload.receipt as unknown as
      FinalExitReceipt | undefined;
    const shell = receipt?.shell_exit;
    {
      const previous = tx.get(
        "SELECT payload FROM events WHERE run_id=? AND kind='run.reconciliation' ORDER BY seq DESC LIMIT 1",
        runId
      );
      const wasBlocked = previous ? JSON.parse(String(previous.payload)).blockNewOperations === true : false;
      const previousState = [...readEvents(tx, runId)]
        .reverse()
        .find((event) => ['run.state', 'run.terminal', 'run.reconciliation'].includes(event.kind));
      const causeChanged = !decision.emitTransition && (previousState?.payload.cause ?? null) !== decision.cause;
      if (wasBlocked !== decision.blockNewOperations || causeChanged)
        insertRecord(tx, 'events', {
          runId,
          linkId: current.link.linkId,
          kind: 'run.reconciliation',
          payload: {
            blockNewOperations: decision.blockNewOperations,
            cause: decision.cause,
            evidenceIds: decision.evidenceIds,
          },
          at: nowMs,
        });
    }
    persistConflict(tx, current, decision, nowMs);
    if (decision.emitTransition) {
      const terminal = isRunTerminal({ state: decision.state });
      let terminalEvidenceId: string | null = null;
      if (terminal) {
        // Store all adopted fact boundaries, not the reconciliation/discovery time as a proof boundary.
        terminalEvidenceId = `terminal:${runId}`;
        const payload: JsonObject = {
          reconcileFacts: JSON.parse(canonicalJson(facts)),
          evidenceIds: decision.evidenceIds,
          terminalNote: decision.terminalNote,
        };
        insertRecord(tx, 'evidence', {
          evidenceId: terminalEvidenceId,
          runId,
          linkId: current.link.linkId,
          kind: decision.state === 'failed' ? 'never_submitted' : 'scope_reconciled',
          producer: 'reconciler',
          fingerprint: digest(payload),
          payload,
          observedAt: nowMs,
          validatedAt: nowMs,
          validation: 'accepted',
        });
      }
      const next = updateRun(current.run, {
        state: decision.state,
        endedAt: terminal ? nowMs : null,
        terminalEvidenceId,
        submissionFencedAt: terminal ? (current.run.submissionFencedAt ?? nowMs) : current.run.submissionFencedAt,
        exitCode: decision.exitCode,
        exitSignal: decision.exitSignal,
        exitSource: decision.exitSource,
      });
      tx.run(
        `UPDATE runs SET state=?,ended_at=?,terminal_evidence_id=?,submission_fenced_at=?,exit_code=?,exit_signal=?,exit_source=?,shell_status=?,shell_signal=? WHERE run_id=?`,
        next.state,
        next.endedAt,
        next.terminalEvidenceId,
        next.submissionFencedAt,
        next.exitCode,
        next.exitSignal,
        next.exitSource,
        terminal ? (shell?.exit_code ?? current.run.shellStatus) : null,
        terminal ? (shell?.signal ?? current.run.shellSignal) : null,
        runId
      );
      if (terminal) {
        tx.run("UPDATE claims SET state='revoked' WHERE run_id=?", runId);
        if (decision.releaseSlot) tx.run('DELETE FROM slots WHERE run_id=?', runId);
        if (decision.state === 'failed') {
          const nextLink = advanceLink(current.link, { kind: 'non_execution', firstRun: current.run.runSeq === 1 });
          tx.run(
            'UPDATE links SET state=?,current_owner=? WHERE link_id=?',
            nextLink.state,
            Number(nextLink.currentOwner),
            nextLink.linkId
          );
        }
      }
      insertRecord(tx, 'events', {
        runId,
        linkId: current.link.linkId,
        kind: terminal ? 'run.terminal' : 'run.state',
        payload: {
          from: current.run.state,
          state: decision.state,
          row: decision.row,
          evidenceIds: decision.evidenceIds,
          cause: decision.cause,
          terminalNote: decision.terminalNote,
        },
        at: nowMs,
      });
    }
    if (isRunTerminal(current.run) && receipt) {
      tx.run(
        'UPDATE runs SET shell_status=?,shell_signal=? WHERE run_id=?',
        shell?.exit_code ?? null,
        shell?.signal ?? null,
        runId
      );
    }
    return { committed: true as const, decision };
  });
}

/** Same CAS boundary for identity/import/cancel writers that gathered evidence outside SQLite. */
export async function commitCompared<T>(
  ledger: Ledger,
  expected: ReconcileSnapshot,
  callback: (tx: LedgerTransaction, current: ReconcileSnapshot) => T
): Promise<{ committed: false; reason: 'stale_snapshot' } | { committed: true; result: T }> {
  const runId = expected.run.runId;
  const version = expected.version;
  return ledger.transaction((tx) => {
    if (canonicalJson(versionRows(tx, runId)) !== version)
      return { committed: false as const, reason: 'stale_snapshot' as const };
    const result = callback(tx, snapshotInTransaction(tx, runId));
    if (result !== null && typeof result === 'object' && 'then' in result)
      throw new TypeError('ledger_transaction_callback_must_be_synchronous');
    return { committed: true as const, result };
  });
}

export async function requestCancel(
  ledger: Ledger,
  expected: ReconcileSnapshot,
  authority: IntentAuthority,
  at: number
): Promise<
  | { committed: false; reason: 'stale_snapshot' }
  | { committed: true; result: { accepted: boolean; cancelRequestedAt: number | null } }
> {
  if (!Number.isSafeInteger(at) || at < 0) throw new TypeError('invalid_cancel_time');
  return commitCompared(ledger, expected, (tx, current) => {
    requireParentControl(current.link);
    const allowed = authorizeControl(
      'cancel',
      current.link,
      linkOwner(tx, current.link),
      currentAuthority(tx, authority)
    );
    if (!allowed.ok) throw new Error(allowed.reason);
    if (isRunTerminal(current.run)) return { accepted: false, cancelRequestedAt: current.run.cancelRequestedAt };
    if (current.run.cancelRequestedAt !== null)
      return { accepted: true, cancelRequestedAt: current.run.cancelRequestedAt };
    tx.run("UPDATE runs SET cancel_requested_at=?,state='cancelling' WHERE run_id=?", at, current.run.runId);
    insertRecord(tx, 'events', {
      runId: current.run.runId,
      linkId: current.link.linkId,
      kind: 'cancel.accepted',
      payload: { actor: allowed.actor },
      at,
    });
    return { accepted: true, cancelRequestedAt: at };
  });
}
