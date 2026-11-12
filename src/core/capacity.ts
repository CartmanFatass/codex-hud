export interface CapacityLimits {
  maxActiveRuns?: number;
  maxActiveRunsPerOwner?: number;
}
export const DEFAULT_CAPACITY_LIMITS = Object.freeze({ maxActiveRuns: 6, maxActiveRunsPerOwner: 4 });
export function capacityLimits(limits: CapacityLimits = {}) {
  const resolved = { ...DEFAULT_CAPACITY_LIMITS, ...limits };
  if (Object.values(resolved).some((v) => !Number.isSafeInteger(v) || v < 1))
    throw new TypeError('invalid_capacity_limits');
  return resolved;
}
