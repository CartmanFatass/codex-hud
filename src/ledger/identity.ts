import { canonicalJson } from '../core/canonical.js';
import { performance } from 'node:perf_hooks';
import { planOwnerAlias, procOwnerKey, sameSessionRef, sessionOwnerKey, sessionRefKey } from '../core/identity.js';
import type { BoundBy, CallerScope, OwnerAlias, SessionRef } from '../core/types/identity.js';
import type { Evidence, IdempotencyRecord } from '../core/types/execution.js';
import type { Ledger } from './ledger.js';
import { decodeRecord, insertRecord } from './records.js';

/** B1 supplies independently verified binding evidence; alias/rekey/context/parent updates commit together. */
export async function bindOwnerScope(
  ledger: Ledger,
  supplied: {
    processKey: string;
    generation: number;
    sessionRef: SessionRef;
    boundBy: BoundBy;
    evidence: Evidence;
    at: number;
  }
): Promise<void> {
  const input = JSON.parse(canonicalJson(supplied)) as typeof supplied;
  const targetRef = sessionRefKey(input.sessionRef);
  const writeDeadline = performance.now() + ledger.busyBudgetMs;
  if (
    input.evidence.validation !== 'accepted' ||
    input.evidence.validatedAt === null ||
    input.evidence.runId !== null ||
    input.evidence.linkId !== null ||
    !['launch_receipt', 'trusted_session', 'transcript'].includes(input.evidence.kind)
  )
    throw new TypeError('binding_evidence_required');
  try {
    await ledger.transaction((tx) => {
      const row = tx.get(
        'SELECT * FROM caller_scopes WHERE process_key=? AND generation=?',
        input.processKey,
        input.generation
      );
      if (!row) throw new Error('stale_context');
      const scope = decodeRecord<CallerScope>(row);
      if (
        scope.closedAt !== null ||
        scope.sourceId !== input.sessionRef.sourceId ||
        scope.harness !== input.sessionRef.harness ||
        (scope.sessionRef !== null && !sameSessionRef(scope.sessionRef, input.sessionRef))
      )
        throw new Error('alias_conflict');
      const bound = {
        ...scope,
        sessionRef: input.sessionRef,
        boundBy: scope.boundBy ?? input.boundBy,
        bindingEvidenceId: scope.bindingEvidenceId ?? input.evidence.evidenceId,
      } as CallerScope;
      const from = procOwnerKey(input.processKey, input.generation);
      const to = sessionOwnerKey(input.sessionRef);
      const records = tx
        .all('SELECT * FROM idempotency WHERE owner_key IN (?,?)', from, to)
        .map((entry) => decodeRecord<IdempotencyRecord>(entry));
      const aliases = tx
        .all('SELECT * FROM owner_aliases WHERE process_key=? AND generation=?', input.processKey, input.generation)
        .map((entry) => decodeRecord<OwnerAlias>(entry));
      const plan = planOwnerAlias(bound, aliases, records, bound.bindingEvidenceId!, input.at);
      if (!plan.ok) throw new Error(plan.reason);
      tx.run(
        'INSERT OR IGNORE INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
        targetRef,
        input.sessionRef.harness,
        input.sessionRef.sourceId,
        input.sessionRef.sessionId,
        input.sessionRef.threadId ?? ''
      );
      const existing = tx.get('SELECT * FROM evidence WHERE evidence_id=?', input.evidence.evidenceId);
      if (existing && canonicalJson(decodeRecord(existing)) !== canonicalJson(input.evidence))
        throw new Error('evidence_id_conflict');
      if (!existing) insertRecord(tx, 'evidence', input.evidence);
      for (const record of records.filter((entry) => entry.ownerKey === from)) {
        tx.run('DELETE FROM idempotency WHERE owner_key=? AND request_key=?', to, record.requestKey);
        tx.run('UPDATE idempotency SET owner_key=? WHERE owner_key=? AND request_key=?', to, from, record.requestKey);
      }
      tx.run(
        'UPDATE caller_scopes SET session_ref=?,bound_by=?,binding_evidence_id=? WHERE process_key=? AND generation=?',
        targetRef,
        bound.boundBy,
        bound.bindingEvidenceId,
        input.processKey,
        input.generation
      );
      tx.run(
        'UPDATE caller_contexts SET session_ref=?,bound_by=?,binding_evidence_id=? WHERE process_key=? AND proc_generation=? AND closed_at IS NULL',
        targetRef,
        bound.boundBy,
        bound.bindingEvidenceId,
        input.processKey,
        input.generation
      );
      tx.run(
        `UPDATE links SET parent_ref=? WHERE parent_ref IS NULL AND (parent_context_id,parent_context_generation) IN
        (SELECT context_id,generation FROM caller_contexts WHERE process_key=? AND proc_generation=?)`,
        targetRef,
        input.processKey,
        input.generation
      );
      if (aliases.length === 0) {
        insertRecord(tx, 'owner_aliases', plan.alias);
        insertRecord(tx, 'events', {
          linkId: null,
          runId: null,
          kind: 'owner.aliased',
          payload: {
            processKey: input.processKey,
            generation: input.generation,
            from,
            to,
            evidenceId: bound.bindingEvidenceId,
          },
          at: input.at,
        });
      }
    });
  } catch (error) {
    if (error instanceof Error && ['alias_conflict', 'idempotency_conflict'].includes(error.message))
      await ledger
        .transaction(
          (tx) =>
            insertRecord(tx, 'events', {
              linkId: null,
              runId: null,
              kind: 'owner.alias_rejected',
              payload: { processKey: input.processKey, generation: input.generation, reason: error.message },
              at: input.at,
            }),
          Math.max(0, writeDeadline - performance.now())
        )
        .catch(() => {});
    throw error;
  }
}
