import type { SQLOutputValue } from 'node:sqlite';
import { sessionOwnerKey } from '../identity.js';
import { decodeRecord } from '../../ledger/records.js';
import { wakeContextBinding } from '../wake/binding.js';
import { wakeEventState, wakeValidationReason, type RegistrationState } from '../wake/projection.js';
import type { LedgerReadSnapshot } from '../ledger-read.js';
import type { CallerContext } from '../types/identity.js';

/** Read-only metadata port valid only in the already pinned B9 transaction. */
export function readLinkWakeStates(
  snapshot: LedgerReadSnapshot,
  get: (sql: string, ...values: (string | number)[]) => Record<string, SQLOutputValue> | undefined
) {
  const states = new Map<string, RegistrationState | null>();
  const attempts = new Map<string, number | null>();
  const contexts = new Map<string, CallerContext>();
  const scopes = new Map<string, number | null>();
  for (const link of snapshot.links) {
    const state = wakeEventState(snapshot.events, link.linkId);
    if (!state) {
      states.set(link.linkId, null);
      attempts.set(link.linkId, null);
      continue;
    }
    const registration = state.registration.payload as unknown as RegistrationState['registration'];
    const binding = wakeContextBinding(link, state.intent);
    const contextId = binding?.contextId ?? link.parentContextId,
      generation = binding?.generation ?? link.parentContextGeneration;
    const key = JSON.stringify([contextId, generation]);
    let context = contexts.get(key);
    if (!context) {
      const row = get(
        'SELECT kind,closed_at,generation,proc_generation,session_ref,process_key FROM caller_contexts WHERE context_id=? AND generation=?',
        contextId,
        generation
      );
      if (!row) continue; // Missing validation is unavailable, never a false registered/none state.
      const decoded: CallerContext = decodeRecord(row);
      contexts.set(key, decoded);
      context = decoded;
    }
    if (!context) continue;
    if (context.kind === 'dedicated' && !scopes.has(context.processKey)) {
      const row = get(
        'SELECT generation FROM caller_scopes WHERE process_key=? AND closed_at IS NULL',
        context.processKey
      );
      scopes.set(context.processKey, row ? Number(row.generation) : null);
    }
    const reason = wakeValidationReason({
      link,
      registration,
      reason: state.reason,
      bindingValid: binding !== null,
      context,
      currentScopeGeneration: context.processKey ? (scopes.get(context.processKey) ?? null) : null,
      ownerKey: link.parentRef ? sessionOwnerKey(link.parentRef) : null,
    });
    states.set(link.linkId, {
      seq: state.registration.seq,
      link,
      registration,
      valid: reason === null,
      reason,
      delivery: state.delivery,
      unconfirmed: state.unconfirmed,
    });
    attempts.set(link.linkId, state.attempts);
  }
  return { states, attempts };
}
