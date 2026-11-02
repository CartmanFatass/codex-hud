import { sameSessionRef } from '../identity.js';
import type { LedgerEvent } from '../types/execution.js';
import type { WakeRegistration, WakeDelivery } from '../../ledger/notify-events.js';
import type { Link } from '../types/lifecycle.js';
import type { CallerContext } from '../types/identity.js';

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

/** Pure B19 validity policy shared by its SQL reader and the HUD snapshot reader. */
export function wakeValidationReason(input: {
  link: Link;
  registration: WakeRegistration;
  reason: string | null;
  bindingValid: boolean;
  context: Pick<CallerContext, 'kind' | 'closedAt' | 'generation' | 'procGeneration' | 'sessionRef'>;
  currentScopeGeneration: number | null;
  ownerKey: string | null;
}): string | null {
  const { link, registration, context } = input;
  let reason = input.reason;
  if (!input.bindingValid && !reason) reason = 'session_replaced';
  if (
    !reason &&
    (context.closedAt !== null ||
      context.generation !== registration.contextGeneration ||
      (context.kind === 'dedicated' && input.currentScopeGeneration !== context.procGeneration) ||
      !context.sessionRef ||
      !sameSessionRef(context.sessionRef, registration.parentRef) ||
      !link.parentRef ||
      !sameSessionRef(link.parentRef, registration.parentRef) ||
      input.ownerKey !== registration.ownerKey)
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
  return reason;
}

/** Selected-registration reduction; one confirmed newer batch never erases an older unknown charge. */
export function wakeEventState(events: readonly LedgerEvent[], linkId: string) {
  const linked = events.filter((e) => e.linkId === linkId).sort((a, b) => a.seq - b.seq);
  const registration = linked.filter((e) => e.kind === 'wake.registered').at(-1);
  if (!registration) return null;
  const after = linked.filter((e) => e.seq > registration.seq);
  const revoked = after
    .filter((e) => e.kind === 'wake.revoked' && e.payload.registrationSeq === registration.seq)
    .at(-1);
  const deliveries = after.filter((e) => e.kind === 'wake.delivered' && e.payload.registrationSeq === registration.seq);
  const groups = new Map<number, { confirmed: boolean; attempt: number }>();
  for (const event of deliveries) {
    const batch = Number(event.payload.throughSeq),
      state = groups.get(batch) ?? { confirmed: false, attempt: 0 };
    if (['accepted', 'wait_return', 'rejected'].includes(String(event.payload.result))) state.confirmed = true;
    if (event.payload.result === 'unknown') state.attempt = Math.max(state.attempt, Number(event.payload.attempt));
    groups.set(batch, state);
  }
  const attempts = Math.max(0, ...[...groups.values()].filter((g) => !g.confirmed).map((g) => g.attempt));
  const delivery = deliveries.at(-1);
  return {
    registration,
    intent: after.find((e) => e.kind === 'intent.accepted') ?? null,
    reason: revoked ? String(revoked.payload.reason) : null,
    delivery: delivery
      ? ({ ...delivery.payload, at: delivery.at, seq: delivery.seq } as unknown as RegistrationState['delivery'])
      : null,
    unconfirmed: attempts > 0,
    attempts: attempts > 0 ? attempts : null,
  };
}
