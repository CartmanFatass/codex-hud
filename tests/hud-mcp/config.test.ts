import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDelegateConfig, loadDelegateConfig } from '../../packages/hud-mcp/src/config.js';
import type { DelegateConfig, DelegateProfile } from '../../src/core/types/capabilities.js';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hud-config-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile: DelegateProfile = {
    name: 'synthetic',
    harness: 'claude',
    source: { root, label: 'Synthetic' },
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
  return { root, profile };
}

test('shared delegate config accepts optional roles and the exact Claude call-source mechanism', (t) => {
  const f = fixture(t);
  const config: DelegateConfig = {
    version: 1,
    profiles: [
      {
        ...f.profile,
        roles: { implementer: { model: 'synthetic-model', effort: 'high' }, reviewer: { model: 'synthetic-review' } },
        callSource: { kind: 'claude_pre_tool_use_v1' },
      },
    ],
  };
  assert.deepEqual(validateDelegateConfig(config), config);
  assert.deepEqual(validateDelegateConfig({ version: 1, profiles: [f.profile] }).profiles[0], f.profile);
  const file = join(f.root, 'delegate.json');
  writeFileSync(file, JSON.stringify(config));
  assert.deepEqual(loadDelegateConfig(file), config);
});

test('call-source selection is Claude-only and rejects unknown keys, kinds and malformed shapes', (t) => {
  const f = fixture(t);
  const invalid: unknown[] = [
    { ...f.profile, harness: 'codex', callSource: { kind: 'claude_pre_tool_use_v1' } },
    { ...f.profile, harness: 'pi', callSource: { kind: 'claude_pre_tool_use_v1' } },
    { ...f.profile, callSource: { kind: 'claude_pre_tool_use_v2' } },
    { ...f.profile, callSource: { kind: 'claude_pre_tool_use_v1', verified: true } },
    { ...f.profile, callSource: {} },
    { ...f.profile, callSource: null },
    { ...f.profile, callSource: 'claude_pre_tool_use_v1' },
    { ...f.profile, callSource: [] },
    { ...f.profile, resources: { cpu: 2 } },
    { ...f.profile, roles: { reviewer: { model: 'synthetic', command: 'synthetic' } } },
    { ...f.profile, roles: { reviewer: { effort: 'high' } } },
    { ...f.profile, roles: { reviewer: { model: 'synthetic', effort: 1 } } },
  ];
  for (const profile of invalid)
    assert.throws(() => validateDelegateConfig({ version: 1, profiles: [profile] }), /configuration_invalid/);
});

test('delegate envelope keeps its version, unique-name, profile-count and file-byte bounds', (t) => {
  const f = fixture(t);
  for (const config of [
    { version: 2, profiles: [] },
    { version: 1, profiles: [], extra: true },
    { version: 1, profiles: [f.profile, f.profile] },
    { version: 1, profiles: Array.from({ length: 129 }, (_, n) => ({ ...f.profile, name: `synthetic-${n}` })) },
  ])
    assert.throws(() => validateDelegateConfig(config), /configuration_invalid/);
  const file = join(f.root, 'oversized.json');
  writeFileSync(
    file,
    JSON.stringify({ version: 1, profiles: [{ ...f.profile, env: { SYNTHETIC: 'x'.repeat(262144) } }] })
  );
  assert.throws(() => loadDelegateConfig(file), /configuration_invalid/);
});
