import { collectResource } from './observation.js';
import type { CollectLease } from './types/observation.js';
import type { SessionRef } from './types/identity.js';

export const COLLECT_LEASE_TTL_MS = 15_000;
export const COLLECT_RENEW_INTERVAL_MS = 5_000;

export class ObservationStoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ObservationStoreError';
  }
}

/** These checks confer observation authority only, never execution/ledger authority. */
export function requireCollectLease(
  lease: CollectLease | null,
  ref: SessionRef,
  holder: string,
  generation: number,
  now: number,
  previousNow: number
): asserts lease is CollectLease {
  if (!Number.isFinite(now) || now < previousNow) throw new ObservationStoreError('lease_time_unknown');
  if (!lease || lease.resource !== collectResource(ref) || lease.holder !== holder || lease.generation !== generation)
    throw new ObservationStoreError('lease_fenced');
  if (now >= lease.expires_at) throw new ObservationStoreError('lease_expired');
}

export function requireLeaseRequest(holder: string, ttl: number): void {
  if (!holder || holder.length > 256 || !Number.isSafeInteger(ttl) || ttl < COLLECT_RENEW_INTERVAL_MS || ttl > 60_000)
    throw new ObservationStoreError('invalid_lease_request');
}
