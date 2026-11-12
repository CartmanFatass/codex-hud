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
