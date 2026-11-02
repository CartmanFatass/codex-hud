import { sameSessionRef } from './identity.js';
import type { LedgerReadRun } from './ledger-read.js';
import type { Link } from './types/lifecycle.js';
import type { SessionRef } from './types/identity.js';

export interface CapacityLimits {
  maxActiveRuns?: number;
  maxActiveRunsPerOwner?: number;
}
export const DEFAULT_CAPACITY_LIMITS = Object.freeze({ maxActiveRuns: 6, maxActiveRunsPerOwner: 4 });
export interface CapacityOccupant {
  runId: string;
  linkId: string;
  state: 'starting' | 'running' | 'cancelling' | 'uncertain';
  since: number;
  holder: 'self' | 'other';
  retireEta: number | null;
}
export function capacityLimits(limits: CapacityLimits = {}) {
  const resolved = { ...DEFAULT_CAPACITY_LIMITS, ...limits };
  if (Object.values(resolved).some((v) => !Number.isSafeInteger(v) || v < 1))
    throw new TypeError('invalid_capacity_limits');
  return resolved;
}

/** Shared admission/status counting rule; authority-specific owner classification stays with the caller. */
export function countCapacity(occupants: readonly CapacityOccupant[], limits: CapacityLimits = {}) {
  const resolved = capacityLimits(limits);
  const self = occupants.filter((o) => o.holder === 'self');
  const ownerFull = self.length >= resolved.maxActiveRunsPerOwner;
  return {
    active: ownerFull ? self.length : occupants.length,
    limit: ownerFull ? resolved.maxActiveRunsPerOwner : resolved.maxActiveRuns,
    occupants: ownerFull ? self : [...occupants],
    full: ownerFull || occupants.length >= resolved.maxActiveRuns,
    retryAdvisable:
      !ownerFull && occupants.some((o) => o.holder === 'other') && !occupants.some((o) => o.state === 'uncertain'),
  };
}
export const CAPACITY_STATES = ['starting', 'running', 'cancelling', 'uncertain'] as const;
export function holdsCapacity(state: string): state is CapacityOccupant['state'] {
  return (CAPACITY_STATES as readonly string[]).includes(state);
}
/** HUD classification deliberately never derives a process owner for an unresolved parent. */
export function capacityProjection(
  runs: readonly LedgerReadRun[],
  links: readonly Link[],
  rootRef: SessionRef | null,
  limits: CapacityLimits = {}
) {
  const parents = new Map(links.map((link) => [link.linkId, link.parentRef]));
  const occupants: CapacityOccupant[] = runs
    .filter((run) => holdsCapacity(run.state))
    .map((run): CapacityOccupant => ({
      runId: run.runId,
      linkId: run.linkId,
      state: run.state as CapacityOccupant['state'],
      since: run.createdAt,
      holder:
        rootRef && parents.get(run.linkId) && sameSessionRef(parents.get(run.linkId)!, rootRef) ? 'self' : 'other',
      retireEta: null,
    }))
    .sort((a, b) => a.since - b.since || a.runId.localeCompare(b.runId));
  const counted = countCapacity(occupants, limits);
  const resolved = capacityLimits(limits);
  return {
    active: occupants.length,
    limit: resolved.maxActiveRuns,
    mine: occupants.filter((o) => o.holder === 'self').length,
    mineLimit: resolved.maxActiveRunsPerOwner,
    full: counted.full,
    occupants,
  };
}
