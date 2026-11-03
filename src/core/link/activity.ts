import type { DelegationViewModel } from './view-model.js';

/** Existing adaptive cadence also observes the universal tree, with the legacy no-ledger signal unchanged. */
export function withDelegationObservation<
  T extends { activity: 'active' | 'quiet' | 'uncertain'; fingerprint?: string },
>(observation: T, view: DelegationViewModel | null | undefined): T {
  if (!view) return observation;
  const statuses = Object.values(view.details).map((detail) => detail.status);
  const activity =
    observation.activity === 'active' || statuses.some((status) => status?.activity === 'working')
      ? 'active'
      : observation.activity === 'quiet' &&
          view.tree.ledger.state === 'available' &&
          view.pendingStatus === 0 &&
          view.tree.continuation.length === 0 &&
          statuses.every((status) => status?.activity === 'idle' || status?.isRunTerminal === true)
        ? 'quiet'
        : 'uncertain';
  return {
    ...observation,
    activity,
    fingerprint: JSON.stringify([
      observation.fingerprint,
      view.tree.ledger.ledgerId,
      view.tree.ledger.asOfSeq,
      statuses.map((status) =>
        status ? [status.stateKey, status.observationStamp?.seqDomain, status.observationStamp?.commitSeq] : null
      ),
    ]),
  };
}
