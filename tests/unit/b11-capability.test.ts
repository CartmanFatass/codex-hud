import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchProfileDigest } from '../../src/core/capabilities.js';
import {
  matchesCapability,
  shippedManifest,
  verifiedClientTimeout,
  discoverExecutable,
  clientTimeoutFingerprint,
  type CapabilityExpectation,
} from '../../src/cli/capability.js';
import type { CapabilityCell, CapabilityManifestV1, LaunchProfile } from '../../src/core/types/capabilities.js';

function fixture() {
  const profile: LaunchProfile = {
    name: 'synthetic-parent',
    harness: 'claude',
    source: { root: '/synthetic/source', label: 'Synthetic' },
    launch: { argv: ['/synthetic/claude'] },
    headless: null,
    resume: null,
    resumeHeadless: null,
    host: { kind: 'tmux', layout: 'pane' },
    env: {},
    mcpServerName: 'synthetic',
    claimTransport: 'config_env',
    clientToolTimeoutMs: 60000,
    responseMarginMs: 2000,
    orphan_policy: 'continue',
    managedShellVerified: false,
    callSource: { kind: 'claude_pre_tool_use_v1' },
  };
  const actual: CapabilityExpectation = {
    key: {
      harness: 'claude',
      profileDigest: launchProfileDigest(profile),
      hostKind: 'tmux',
      layout: 'pane',
      mode: 'visible',
      operation: 'launch',
    },
    sourceId: 'a'.repeat(64),
    profileFingerprint: 'b'.repeat(64),
    topology: 'synthetic-accepted-parent-path',
    versions: {
      hudRevision: 'synthetic-reviewed-build-1',
      harness: '2.1.305',
      mcpClient: '2.1.305',
      node: process.versions.node,
      host: '3.4',
      shell: '5.9',
      platform: process.platform,
      kernel: '6.1',
    },
  };
  const cell: CapabilityCell = {
    ...actual,
    support: 'verified',
    evidence: {
      script: 'synthetic-test',
      report: 'synthetic-report',
      reportSha256: 'c'.repeat(64),
      artifactDigest: 'd'.repeat(64),
      observedAt: 1000,
      reviewStatus: 'accepted',
      scope: 'product',
    },
    results: { identity: 'passed', input: 'passed', scope: 'passed', receipt: 'passed', singleSubmission: 'passed' },
    incomplete: [],
  };
  const manifest: CapabilityManifestV1 = { version: 1, hudRevision: actual.versions.hudRevision, cells: [cell] };
  return { profile, actual, cell, manifest };
}

test('B11 timeout proof uses the same G04 envelope and exact parent/runtime; absent, child, duplicate or placeholder evidence fails closed', () => {
  const f = fixture();
  const proof = (
    manifest: CapabilityManifestV1 = f.manifest,
    actual: CapabilityExpectation | null = f.actual,
    matchingProfiles = [f.profile]
  ) => verifiedClientTimeout({ manifest, actual, selected: f.profile, matchingProfiles });
  assert.equal(proof(), true, 'synthetic trusted proof only; not a product promotion');
  assert.equal(proof(f.manifest, null), false);
  assert.equal(proof({ version: 1, hudRevision: null, cells: [] }), false);
  assert.equal(proof({ ...f.manifest, cells: [f.cell, f.cell] }), false);
  for (const cell of [
    { ...f.cell, evidence: { ...f.cell.evidence, script: 7 } },
    { ...f.cell, results: { ...f.cell.results, deadline: 'failed' } },
    { ...f.cell, sourceId: 7 },
    { ...f.cell, topology: 7 },
  ])
    assert.equal(proof({ ...f.manifest, cells: [cell] } as unknown as CapabilityManifestV1), false);
  const other = { ...f.cell, key: { ...f.cell.key, profileDigest: 'e'.repeat(64) } };
  assert.equal(
    proof({
      ...f.manifest,
      cells: [f.cell, { ...other, versions: { ...f.actual.versions, hudRevision: 'different-build' } }],
    }),
    false
  );
  assert.equal(
    proof({
      ...f.manifest,
      cells: [f.cell, { ...other, support: 'unverified', results: 17, evidence: false }],
    } as unknown as CapabilityManifestV1),
    false
  );
  assert.equal(
    proof(f.manifest, f.actual, [
      f.profile,
      { ...f.profile, name: 'same-source-other-timeout', clientToolTimeoutMs: 120000 },
    ]),
    false
  );
  assert.equal(proof(f.manifest, { ...f.actual, key: { ...f.actual.key, harness: 'codex' } }), false);
  assert.equal(proof(f.manifest, { ...f.actual, versions: { ...f.actual.versions, mcpClient: 'unverified' } }), false);
  assert.equal(proof(f.manifest, { ...f.actual, versions: { ...f.actual.versions, harness: '2.1.306' } }), false);
  assert.equal(proof(f.manifest, { ...f.actual, sourceId: 'e'.repeat(64) }), false);
  assert.equal(proof(f.manifest, { ...f.actual, profileFingerprint: 'e'.repeat(64) }), false);
  assert.equal(matchesCapability(f.manifest, { ...f.actual, topology: 'different-path' }), false);
  assert.deepEqual(shippedManifest(), { version: 1, hudRevision: null, cells: [] });
});

test('B11 executable version discovery is bounded native startup evidence; shell/script targets stay unknown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hud-b11-version-'));
  try {
    const native = await discoverExecutable({ argv: [process.execPath] }, { PATH: '/usr/bin:/bin' });
    assert.equal(native.version, process.versions.node);
    const script = join(root, 'wrapper');
    writeFileSync(script, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    assert.equal((await discoverExecutable({ argv: [script] }, {})).version, null);
    assert.equal((await discoverExecutable({ shell: 'unknown_function', shellPath: '/bin/sh' }, {})).version, null);
    const { profile } = fixture();
    const startup = {
      executable: native,
      command: profile.launch,
      configFingerprint: 'a'.repeat(64),
      helperRevision: 'synthetic-helper-1',
    };
    const fingerprint = clientTimeoutFingerprint(profile, startup);
    assert.notEqual(fingerprint, clientTimeoutFingerprint({ ...profile, clientToolTimeoutMs: 120000 }, startup));
    assert.notEqual(
      fingerprint,
      clientTimeoutFingerprint(profile, { ...startup, helperRevision: 'synthetic-helper-2' })
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
