import assert from 'node:assert/strict';
import test from 'node:test';
import { freezeRetirementPolicy, readFrozenRetirementPolicy } from '../../src/core/run/retirement-policy.js';
import { launchDigest } from '../../src/core/run/control.js';
import type { RunLaunchInput } from '../../src/core/types/supervision.js';

test('B22 policy copies finite A5 defaults and rejects invalid private launch policy', () => {
  const input = { idleMs: 1234 };
  const frozen = freezeRetirementPolicy(input, 'reviewer');
  input.idleMs = 9999;
  assert.equal(frozen.idleMs, 1234);
  assert.equal(frozen.afterReportMs, 600_000);
  assert.equal(frozen.reviewerAfterReportMs, 120_000);
  assert.equal(frozen.maxRunMs, 14_400_000);
  assert.equal(frozen.recoveryMs, 30_000);
  assert.ok(Object.isFrozen(frozen));
  for (const value of [0, -1, Infinity, NaN, 2_147_483_648])
    assert.throws(() => freezeRetirementPolicy({ maxRunMs: value }), /invalid_retirement_policy/);
  assert.throws(() => freezeRetirementPolicy({}, 'reviewer', 60_001), /invalid_retirement_policy/);
  assert.throws(() => freezeRetirementPolicy({}, 'reviewer', 10_000, 0), /invalid_retirement_policy/);
  assert.throws(() => freezeRetirementPolicy({ unknown: 1 } as never), /invalid_retirement_policy/);
});

test('B22 private policy participates in launch ticket digest; legacy launches use finite defaults', () => {
  const input = {} as RunLaunchInput;
  const retire = freezeRetirementPolicy();
  assert.notEqual(launchDigest(input), launchDigest({ ...input, retire } as RunLaunchInput));
  assert.notEqual(launchDigest({ ...input, retire }), launchDigest({ ...input, retire: { ...retire, maxRunMs: 1 } }));
  assert.deepEqual(readFrozenRetirementPolicy(input), retire);
});
