import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { capacityLimits, type CapacityLimits } from '../capacity.js';

export interface LoadedLimits {
  limits: Required<CapacityLimits>;
  source: 'default' | 'configured';
  reason: string | null;
}

/** Shared validation for the read-only HUD loader and the delegate configuration. */
export function parseLimits(value: unknown): Required<CapacityLimits> {
  if (value === undefined) return capacityLimits();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid_capacity_limits');
  if (Object.keys(value).some((key) => !['maxActiveRuns', 'maxActiveRunsPerOwner'].includes(key)))
    throw new TypeError('invalid_capacity_limits');
  return capacityLimits(value as CapacityLimits);
}

/** Startup-only; no migration, writes, home fallback, or launch-profile execution. */
export function loadLimits(hudHome: string): LoadedLimits {
  try {
    const value = JSON.parse(readFileSync(join(hudHome, 'delegate.json'), 'utf8'));
    if (!value || value.version !== 1) throw new TypeError('invalid_delegate_config');
    return {
      limits: parseLimits(value.limits),
      source: value.limits === undefined ? 'default' : 'configured',
      reason: null,
    };
  } catch (error) {
    return {
      limits: capacityLimits(),
      source: 'default',
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'limits_unavailable',
    };
  }
}
