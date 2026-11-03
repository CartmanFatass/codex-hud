import { isCallBudget, type CallBudget } from './call-budget.js';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../core/canonical.js';
import { sameSessionRef, sessionRefKey } from '../core/identity.js';
import type { ScopeSnapshot } from '../core/ledger-scope-read.js';
import type { CallerContext, CallerScope, SessionRef } from '../core/types/identity.js';
import type { Ledger } from './ledger.js';
import { recordWakeRevoked } from './notify-events.js';
import { decodeRecord, insertRecord, readContext, readLink } from './records.js';
import { wakeContextBinding } from '../core/wake/binding.js';
import type { LedgerEvent } from '../core/types/execution.js';
import type { LedgerTransaction } from './transaction.js';
import type { IntentAuthority } from './types.js';

/** Read before external source verification; compare exactly after acquiring the lock. */
export function scopeSnapshot(tx: LedgerTransaction, ledgerId: string, processKey: string): ScopeSnapshot {
  const highWaterGeneration = Number(
    tx.get('SELECT coalesce(max(generation),0) AS g FROM caller_scopes WHERE process_key=?', processKey)!.g
  );
  const row = tx.get('SELECT * FROM caller_scopes WHERE process_key=? AND closed_at IS NULL', processKey);
  if (!row) return { kind: 'no_current', processKey, ledgerId, highWaterGeneration, current: null };
  const scope = decodeRecord<CallerScope>(row);
  return {
    kind: 'current',
    processKey,
    ledgerId,
    highWaterGeneration,
    current: { generation: scope.generation, sessionRef: scope.sessionRef, bindingEvidenceId: scope.bindingEvidenceId },
  };
}

export function requireScopePremise(tx: LedgerTransaction, ledgerId: string, premise: ScopeSnapshot): void {
  if (canonicalJson(scopeSnapshot(tx, ledgerId, premise.processKey)) !== canonicalJson(premise))
    throw new Error('stale_context');
}

export interface VerifiedRootCall {
  callerId: string;
  processKey: string;
  sessionRef: SessionRef;
  evidenceDigest: string;
  premise: ScopeSnapshot;
  at: number;
}

/** Reconciler entry: only independently verified ROOT evidence can reach this function. */
export async function authorizeRootCall(
  ledger: Ledger,
  supplied: VerifiedRootCall,
  budgetMs: number | CallBudget = 20
): Promise<Extract<IntentAuthority, { kind: 'mcp' }>> {
  if (isCallBudget(budgetMs)) budgetMs.check();
  const input = structuredClone(supplied);
  return ledger.transaction((tx) => {
    requireScopePremise(tx, ledger.ledgerId, input.premise);
    const physical = tx.get('SELECT * FROM callers WHERE caller_id=? AND retired_at IS NULL', input.callerId);
    if (
      !physical ||
      physical.instance_kind !== 'dedicated' ||
      physical.source_id !== input.sessionRef.sourceId ||
      physical.harness !== input.sessionRef.harness
    )
      throw new Error('identity_unverified');
    const key = JSON.parse(input.processKey) as [string, string, string, number, string];
    if (key[0] !== input.sessionRef.harness || key[1] !== input.sessionRef.sourceId)
      throw new Error('identity_unverified');
    const ref = sessionRefKey(input.sessionRef);
    const old = input.premise.current;
    const switching = old !== null && old.sessionRef !== null && !sameSessionRef(old.sessionRef, input.sessionRef);
    // Historical source evidence cannot reverse a committed switch (A→B→A replay).
    if (
      switching &&
      tx.get(
        'SELECT 1 FROM caller_scopes WHERE process_key=? AND session_ref=? AND closed_at IS NOT NULL',
        input.processKey,
        ref
      )
    )
      throw new Error('stale_context');
    const generation = old === null || switching ? input.premise.highWaterGeneration + 1 : old.generation;
    if (switching) {
      // Revoke every registration bound to this process's closing generation,
      // including registrations made through another MCP of the same root.
      const registrations = tx.all(
        `SELECT e.seq,e.link_id FROM events e
        JOIN links l ON l.link_id=e.link_id
        WHERE e.kind='wake.registered' AND l.parent_ref=?
          AND json_extract(e.payload,'$.contextGeneration')=?
          AND NOT EXISTS (SELECT 1 FROM events r WHERE r.link_id=e.link_id AND r.kind='wake.revoked'
            AND json_extract(r.payload,'$.registrationSeq')=e.seq)`,
        sessionRefKey(old!.sessionRef!),
        old!.generation
      );
      for (const registration of registrations) {
        const link = readLink(tx, String(registration.link_id));
        const nextIntent = tx.get(
          `SELECT * FROM events WHERE link_id=? AND kind='intent.accepted' AND seq>?
          AND seq<coalesce((SELECT min(seq) FROM events WHERE link_id=? AND kind='wake.registered' AND seq>?),9223372036854775807)
          ORDER BY seq LIMIT 1`,
          link.linkId,
          registration.seq,
          link.linkId,
          registration.seq
        );
        const binding = wakeContextBinding(link, nextIntent ? decodeRecord<LedgerEvent>(nextIntent) : null);
        if (!binding) continue;
        const context = readContext(tx, binding.contextId, binding.generation);
        if (
          context.kind !== 'dedicated' ||
          context.processKey !== input.processKey ||
          context.procGeneration !== old!.generation
        )
          continue;
        recordWakeRevoked(
          tx,
          String(registration.link_id),
          {
            registrationSeq: Number(registration.seq),
            reason: 'generation_changed',
          },
          input.at
        );
      }
      tx.run(
        'UPDATE caller_scopes SET closed_at=? WHERE process_key=? AND generation=? AND closed_at IS NULL',
        input.at,
        input.processKey,
        old!.generation
      );
      tx.run(
        'UPDATE caller_contexts SET closed_at=? WHERE process_key=? AND proc_generation=? AND closed_at IS NULL',
        input.at,
        input.processKey,
        old!.generation
      );
      tx.run(
        'UPDATE owner_aliases SET closed_at=? WHERE process_key=? AND generation=? AND closed_at IS NULL',
        input.at,
        input.processKey,
        old!.generation
      );
      tx.run(
        'UPDATE child_bindings SET is_current=0,revoked_at=? WHERE is_current=1 AND (caller_context_id,context_generation) IN (SELECT context_id,generation FROM caller_contexts WHERE process_key=? AND proc_generation=?)',
        input.at,
        input.processKey,
        old!.generation
      );
      insertRecord(tx, 'events', {
        linkId: null,
        runId: null,
        kind: 'caller.generation_closed',
        payload: { processKey: input.processKey, generation: old!.generation },
        at: input.at,
      });
    }
    tx.run(
      'INSERT OR IGNORE INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
      ref,
      input.sessionRef.harness,
      input.sessionRef.sourceId,
      input.sessionRef.sessionId,
      input.sessionRef.threadId ?? ''
    );
    const evidenceId = old !== null && !switching ? (old.bindingEvidenceId ?? randomUUID()) : randomUUID();
    if (!tx.get('SELECT 1 FROM evidence WHERE evidence_id=?', evidenceId))
      insertRecord(tx, 'evidence', {
        evidenceId,
        runId: null,
        linkId: null,
        kind: 'trusted_session',
        producer: 'reconciler',
        fingerprint: input.evidenceDigest,
        payload: { processKey: input.processKey, sessionRef: ref },
        observedAt: input.at,
        validatedAt: input.at,
        validation: 'accepted',
      });
    if (old === null || switching)
      insertRecord(tx, 'caller_scopes', {
        processKey: input.processKey,
        generation,
        harness: input.sessionRef.harness,
        sourceId: input.sessionRef.sourceId,
        pidDomain: key[2],
        harnessPid: key[3],
        harnessProcStart: key[4],
        sessionRef: input.sessionRef,
        boundBy: 'trusted_session',
        bindingEvidenceId: evidenceId,
        createdAt: input.at,
        closedAt: null,
      });
    else if (old.sessionRef === null) {
      // Production roots are selected with a SessionRef before any intent; proc aliases
      // already containing intents must use bindOwnerScope's atomic re-key entry.
      if (tx.get('SELECT 1 FROM idempotency WHERE owner_key=?', JSON.stringify(['proc', input.processKey, generation])))
        throw new Error('owner_alias_required');
      tx.run(
        "UPDATE caller_scopes SET session_ref=?,bound_by='trusted_session',binding_evidence_id=? WHERE process_key=? AND generation=?",
        ref,
        evidenceId,
        input.processKey,
        generation
      );
      tx.run(
        "UPDATE caller_contexts SET session_ref=?,bound_by='trusted_session',binding_evidence_id=? WHERE process_key=? AND proc_generation=? AND closed_at IS NULL",
        ref,
        evidenceId,
        input.processKey,
        generation
      );
    }
    let row = tx.get(
      "SELECT * FROM caller_contexts WHERE caller_id=? AND context_key='stdio' AND closed_at IS NULL",
      input.callerId
    );
    if (!row) {
      const context: CallerContext = {
        contextId: randomUUID(),
        generation,
        callerId: input.callerId,
        contextKey: 'stdio',
        kind: 'dedicated',
        sourceId: input.sessionRef.sourceId,
        harness: input.sessionRef.harness,
        processKey: input.processKey,
        procGeneration: generation,
        sessionRef: input.sessionRef,
        selectionEvidenceId: null,
        boundBy: 'trusted_session',
        bindingEvidenceId: evidenceId,
        createdAt: input.at,
        closedAt: null,
      };
      insertRecord(tx, 'caller_contexts', context);
      row = tx.get('SELECT * FROM caller_contexts WHERE context_id=? AND generation=?', context.contextId, generation);
    }
    const context = decodeRecord<CallerContext>(row!);
    if (
      context.generation !== generation ||
      context.kind !== 'dedicated' ||
      context.processKey !== input.processKey ||
      context.sessionRef === null ||
      !sameSessionRef(context.sessionRef, input.sessionRef)
    )
      throw new Error('stale_context');
    return {
      kind: 'mcp',
      contextId: context.contextId,
      generation,
      scopePremise: scopeSnapshot(tx, ledger.ledgerId, input.processKey),
      evidence: {
        physicalCallerVerified: true,
        pidDomainVisible: true,
        profileObservesSessionSwitch: true,
        topology: 'direct_stdio',
        logicalSource: 'root',
        processKey: input.processKey,
        procGeneration: generation,
        sessionRef: input.sessionRef,
      },
    };
  }, budgetMs);
}
