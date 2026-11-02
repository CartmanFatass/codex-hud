import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDelegateConfig } from '../../packages/hud-mcp/src/config.js';
import { delegationBenchmarkFixture } from './b45-delegation-fixture.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';

test(
  'B21 A5 partial settings merge defaults; version stays 1 and bounds/unknown keys are rejected',
  { skip: !ledgerRuntimeSupported() },
  async (t) => {
    const f = await delegationBenchmarkFixture();
    t.after(() => f.close());
    // A real existing root is required by the production loader.
    const profile = {
      name: 'synthetic',
      harness: 'codex',
      source: { root: f.root, label: 'Synthetic' },
      launch: { argv: ['synthetic'] },
      headless: null,
      resume: null,
      resumeHeadless: null,
      host: { kind: 'none', layout: 'none' },
      env: {},
      mcpServerName: 'hud',
      claimTransport: 'config_env',
      clientToolTimeoutMs: null,
      responseMarginMs: 2000,
      orphan_policy: 'continue',
      managedShellVerified: false,
    };
    const value = validateDelegateConfig({
      version: 1,
      profiles: [{ ...profile, retire: { afterReportMs: 0 } }],
      limits: { maxActiveRuns: 8 },
      wake: { recoveryMs: 1000 },
    });
    assert.equal(value.version, 1);
    assert.deepEqual(value.limits, { maxActiveRuns: 8, maxActiveRunsPerOwner: 4 });
    assert.equal(value.profiles[0].retire?.afterReportMs, 0);
    assert.equal(value.profiles[0].retire?.maxRunMs, 14400000);
    const upper = validateDelegateConfig({
      version: 1,
      profiles: [
        {
          ...profile,
          retire: {
            afterReportMs: 2147483647,
            reviewerAfterReportMs: 2147483647,
            idleMs: 2147483647,
            blockedWaitMs: 2147483647,
            maxRunMs: 2147483647,
          },
        },
      ],
      limits: { maxActiveRuns: Number.MAX_SAFE_INTEGER, maxActiveRunsPerOwner: Number.MAX_SAFE_INTEGER },
      wake: { recoveryMs: 2147483647 },
    });
    assert.equal(upper.limits?.maxActiveRuns, Number.MAX_SAFE_INTEGER);
    assert.equal(upper.profiles[0].retire?.maxRunMs, 2147483647);
    const lower = validateDelegateConfig({
      version: 1,
      profiles: [
        {
          ...profile,
          retire: { afterReportMs: 0, reviewerAfterReportMs: 0, idleMs: 0, blockedWaitMs: 0, maxRunMs: 1 },
        },
      ],
      limits: { maxActiveRuns: 1, maxActiveRunsPerOwner: Number.MAX_SAFE_INTEGER },
      wake: { recoveryMs: 1 },
    });
    assert.equal(lower.profiles[0].retire?.idleMs, 0);
    assert.equal(lower.limits?.maxActiveRunsPerOwner, Number.MAX_SAFE_INTEGER);
    for (const extra of [
      { waitCapMs: 10 },
      { limits: { maxActiveRuns: 0 } },
      { limits: { maxActiveRunsPerOwner: -1 } },
      { limits: { maxActiveRuns: 1.5 } },
      { limits: { maxActiveRuns: Number.MAX_SAFE_INTEGER + 1 } },
      { limits: { extra: 2 } },
      { wake: { recoveryMs: 0 } },
      { wake: { recoveryMs: 2147483648 } },
      { wake: { extra: 2 } },
      { profiles: [{ ...profile, retire: { maxRunMs: 0 } }] },
      { profiles: [{ ...profile, retire: { idleMs: Infinity } }] },
      { profiles: [{ ...profile, retire: { afterReportMs: -1 } }] },
      { profiles: [{ ...profile, retire: { idleMs: 2147483648 } }] },
      { profiles: [{ ...profile, retire: { extra: 1 } }] },
      { profiles: [{ ...profile, waitCapMs: 1 }] },
    ])
      assert.throws(
        () => validateDelegateConfig({ version: 1, profiles: [profile], ...extra }),
        /configuration_invalid/
      );
  }
);
