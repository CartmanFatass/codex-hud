import type { WakeRegistration, WakeDelivery } from '../../../src/ledger/notify-events.js';
import type { LedgerTransaction } from '../../../src/ledger/transaction.js';
import type { LedgerEvent } from '../../../src/core/types/execution.js';
import type { Link } from '../../../src/core/types/lifecycle.js';
import { decodeRecord, readContext } from '../../../src/ledger/records.js';
import { sameSessionRef } from '../../../src/core/identity.js';
import { linkOwner } from '../../../src/ledger/intents.js';
import type { WaitUntil } from '../../../src/core/types/lifecycle.js';
import type { CallerContext } from '../../../src/core/types/identity.js';
import { wakeContextBinding } from '../../../src/core/wake/binding.js';

export interface WakeWaitObserver {
  opened(token: symbol, runId: string, afterSeq: number, until: WaitUntil[]): void;
  returned(token: symbol, events: LedgerEvent[]): void;
  closed(token: symbol): void;
}

export interface RegistrationState {
  seq: number;
  link: Link;
  registration: WakeRegistration;
  valid: boolean;
  reason: string | null;
  delivery: (WakeDelivery & { at: number; seq: number }) | null;
  unconfirmed?: boolean;
  context?: CallerContext;
}
export function readWakeState(tx: LedgerTransaction, link: Link): RegistrationState | null {
  const row = tx.get(
    "SELECT * FROM events WHERE link_id=? AND kind='wake.registered' ORDER BY seq DESC LIMIT 1",
    link.linkId
  );
  if (!row) return null;
  const event = decodeRecord<LedgerEvent>(row);
  const registration = event.payload as unknown as WakeRegistration;
  const revoked = tx.get(
    "SELECT payload FROM events WHERE link_id=? AND kind='wake.revoked' AND seq>? AND json_extract(payload,'$.registrationSeq')=? ORDER BY seq DESC LIMIT 1",
    link.linkId,
    event.seq,
    event.seq
  );
  let reason: string | null = revoked ? String(JSON.parse(String(revoked.payload)).reason) : null;
  const intentRow = tx.get(
    `SELECT * FROM events WHERE link_id=? AND kind='intent.accepted' AND seq>?
    AND seq<coalesce((SELECT min(seq) FROM events WHERE link_id=? AND kind='wake.registered' AND seq>?),9223372036854775807)
    ORDER BY seq LIMIT 1`,
    link.linkId,
    event.seq,
    link.linkId,
    event.seq
  );
  const binding = wakeContextBinding(link, intentRow ? decodeRecord<LedgerEvent>(intentRow) : null);
  if (!binding && !reason) reason = 'session_replaced';
  const context = readContext(
    tx,
    binding?.contextId ?? link.parentContextId,
    binding?.generation ?? link.parentContextGeneration
  );
  const currentScope =
    context.kind === 'dedicated'
      ? tx.get('SELECT generation FROM caller_scopes WHERE process_key=? AND closed_at IS NULL', context.processKey)
      : null;
  if (
    !reason &&
    (context.closedAt !== null ||
      context.generation !== registration.contextGeneration ||
      (context.kind === 'dedicated' && Number(currentScope?.generation) !== context.procGeneration) ||
      !context.sessionRef ||
      !sameSessionRef(context.sessionRef, registration.parentRef) ||
      !link.parentRef ||
      !sameSessionRef(link.parentRef, registration.parentRef) ||
      linkOwner(tx, link) !== registration.ownerKey)
  )
    reason = 'generation_changed';
  if (!reason && ['closed', 'revoked', 'handed_over', 'failed'].includes(link.state)) reason = 'link_closed';
  if (
    !reason &&
    registration.adapter === 'codex_queue_v1' &&
    ('threadId' in registration.target ? registration.target.threadId : undefined) !==
      (link.parentRef?.threadId ?? link.parentRef?.sessionId)
  )
    reason = 'session_replaced';
  const delivered = tx.get(
    "SELECT * FROM events WHERE link_id=? AND kind='wake.delivered' AND seq>? AND json_extract(payload,'$.registrationSeq')=? ORDER BY seq DESC LIMIT 1",
    link.linkId,
    event.seq,
    event.seq
  );
  const last = delivered ? decodeRecord<LedgerEvent>(delivered) : null;
  const unconfirmed = !!tx.get(
    `SELECT 1 FROM (SELECT json_extract(payload,'$.throughSeq') AS batch,
      max(CASE WHEN json_extract(payload,'$.result')='unknown' THEN 1 ELSE 0 END) AS charged,
      max(CASE WHEN json_extract(payload,'$.result') IN ('accepted','wait_return','rejected') THEN 1 ELSE 0 END) AS confirmed
      FROM events WHERE link_id=? AND seq>? AND kind='wake.delivered' AND json_extract(payload,'$.registrationSeq')=? GROUP BY batch)
      WHERE charged=1 AND confirmed=0 LIMIT 1`,
    link.linkId,
    event.seq,
    event.seq
  );
  return {
    seq: event.seq,
    link,
    registration,
    valid: reason === null,
    reason,
    delivery: last ? { ...(last.payload as unknown as WakeDelivery), at: last.at, seq: last.seq } : null,
    unconfirmed,
    context,
  };
}
const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
export function wakeProjection(state: RegistrationState | null, home: string, runId: string, cursor: number) {
  const registration = state?.registration;
  const status =
    !registration || registration.adapter === 'none'
      ? 'none'
      : !state.valid
        ? 'degraded'
        : (state.unconfirmed ?? state.delivery?.result === 'unknown')
          ? 'unconfirmed'
          : 'registered';
  const wake = {
    adapter: registration?.adapter ?? 'none',
    state: status,
    reason:
      state?.reason === 'adapter_rejected' && state.delivery?.result === 'rejected'
        ? state.delivery.reason
        : (state?.reason ?? registration?.reason ?? null),
  };
  const armCommand =
    registration?.adapter === 'claude_background_wait_v1' && state?.valid
      ? `HUD_HOME=${quote(home)} hud run wait ${quote(runId)} --after-seq ${cursor} --owner-generation ${registration.contextGeneration} --notify`
      : undefined;
  return {
    wake,
    advice: { wake: { adapter: wake.adapter, state: wake.state, ...(armCommand ? { armCommand } : {}) } },
  };
}
