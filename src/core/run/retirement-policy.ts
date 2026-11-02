import type { LaunchProfile } from '../types/capabilities.js';
import type { RunLaunchInput } from '../types/supervision.js';

/** Private launch-ticket input, copied before acceptance and included in launchDigest.
 * It is never reloaded from the mutable delegate.json by the supervisor.
 */
export interface FrozenRetirementPolicy {
  afterReportMs: number;
  reviewerAfterReportMs: number;
  idleMs: number;
  blockedWaitMs: number;
  maxRunMs: number;
  graceMs: number;
  role: string;
  recoveryMs: number;
}
export type PolicyRunLaunchInput = RunLaunchInput & { retire?: FrozenRetirementPolicy };
export const RETIREMENT_DEFAULTS = Object.freeze({
  afterReportMs: 600_000,
  reviewerAfterReportMs: 120_000,
  idleMs: 3_600_000,
  blockedWaitMs: 3_600_000,
  maxRunMs: 14_400_000,
});

export function freezeRetirementPolicy(
  policy: LaunchProfile['retire'] = {},
  role = 'implementer',
  graceMs = 10_000,
  recoveryMs = 30_000
): Readonly<FrozenRetirementPolicy> {
  const frozen = { ...RETIREMENT_DEFAULTS, ...policy, graceMs, role, recoveryMs };
  if (
    typeof role !== 'string' ||
    !role ||
    role.length > 128 ||
    /[\x00-\x1f\x7f]/.test(role) ||
    Object.keys(policy).some((key) => !Object.hasOwn(RETIREMENT_DEFAULTS, key)) ||
    Object.keys(RETIREMENT_DEFAULTS).some((key) => {
      const value = frozen[key as keyof typeof RETIREMENT_DEFAULTS];
      return !Number.isSafeInteger(value) || value < (key === 'maxRunMs' ? 1 : 0) || value > 2_147_483_647;
    }) ||
    !Number.isSafeInteger(recoveryMs) ||
    recoveryMs < 1 ||
    recoveryMs > 2_147_483_647 ||
    !Number.isSafeInteger(graceMs) ||
    graceMs < 0 ||
    graceMs > 60_000
  )
    throw new Error('invalid_retirement_policy');
  return Object.freeze(frozen);
}

export function readFrozenRetirementPolicy(input: PolicyRunLaunchInput): Readonly<FrozenRetirementPolicy> {
  if (input.retire === undefined) return freezeRetirementPolicy();
  const { role, graceMs, recoveryMs, ...policy } = input.retire;
  return freezeRetirementPolicy(policy, role, graceMs, recoveryMs);
}
