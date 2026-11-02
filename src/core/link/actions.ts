import { createActionDescriptor } from '../lifecycle.js';
import type { ActionDescriptor } from '../types/lifecycle.js';

/** The shipped read-only reconcile CLI template, fixed to the selected ledger target. */
export function reconcileDescriptor(hudHome: string, linkId: string, runId: string): ActionDescriptor {
  if (runId.startsWith('-')) throw new TypeError('invalid_action_target');
  return createActionDescriptor({
    operation: 'reconcile',
    hudHome,
    linkId,
    runId,
    reason: 'reconciliation_required',
    entryVerified: true,
  })!;
}
