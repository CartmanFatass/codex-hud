import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { discoverExecutable } from '../../src/cli/capability.js';
import { launchProbeEnvironment } from '../../src/core/launch/fingerprint.js';
import {
  createShippedManagedCapabilityVerifier,
  createShippedCodexCapabilityVerifier,
  verifyManagedCapability,
  verifyCodexCapability,
  type ManagedCapabilityRequest,
} from '../../src/core/launch/capability.js';
import type { CapabilityCell, CapabilityVersions } from '../../src/core/types/capabilities.js';

const versions: CapabilityVersions = {
  hudRevision: 'synthetic-revision',
  harness: '1.2.3',
  host: 'none',
  shell: 'none',
  node: '24.0.0',
  platform: 'linux',
  kernel: '6.1',
  mcpClient: 'synthetic-client',
};
function sample(harness: 'claude' | 'codex' | 'pi') {
  const request: ManagedCapabilityRequest = {
    executableIdentity: { path: '/synthetic/bin/' + harness, version: versions.harness },
    key: {
      harness,
      profileDigest: 'a'.repeat(64),
      hostKind: 'none',
      layout: 'none',
      mode: 'headless',
      operation: 'spawn',
    },
    sourceId: 'e'.repeat(64),
    profileFingerprint: 'b'.repeat(64),
  };
  const cell: CapabilityCell = {
    key: request.key,
    support: 'verified',
    versions,
    topology: 'synthetic-direct-stdio',
    sourceId: request.sourceId,
    profileFingerprint: request.profileFingerprint,
    evidence: {
      script: 'synthetic-script',
      report: 'synthetic-report',
      reportSha256: 'c'.repeat(64),
      artifactDigest: 'd'.repeat(64),
      observedAt: 1,
      reviewStatus: 'accepted',
      scope: 'product',
    },
    results: { identity: 'passed', input: 'passed', scope: 'passed', receipt: 'passed', singleSubmission: 'passed' },
    incomplete: [],
  };
  return { request, cell };
}
for (const harness of ['claude', 'codex', 'pi'] as const) {
  test(`managed capability ${harness} requires its exact evidence and runtime tuple`, () => {
    const { request, cell } = sample(harness);
    assert.equal(verifyManagedCapability(request, cell, versions).ok, true);
    for (const changed of [
      { ...request, sourceId: 'wrong' },
      { ...request, profileFingerprint: 'wrong' },
      { ...request, configurationCoverage: 'partial' as const },
      { ...request, executableIdentity: { ...request.executableIdentity, version: 'different' } },
      { ...request, key: { ...request.key, harness: harness === 'pi' ? ('claude' as const) : ('pi' as const) } },
      { ...request, key: { ...request.key, operation: 'resume' as const, resumeFrom: 'headless' as const } },
    ])
      assert.equal(verifyManagedCapability(changed, cell, versions).ok, false);
    assert.equal(
      verifyManagedCapability(
        request,
        { ...cell, versions: { ...versions, kernel: 'unverified' } },
        { ...versions, kernel: 'unverified' }
      ).ok,
      false
    );
    assert.equal(verifyCodexCapability(request, cell, versions).ok, harness === 'codex');
    assert.equal(
      createShippedManagedCapabilityVerifier({ hudRevision: versions.hudRevision, versions }).verify(request).ok,
      false
    );
  });
}
test('managed shipped loader selects per-request trusted facts, rejects ambiguity and keeps Codex wrapper narrow', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-managed-cells-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cellFile = join(dir, 'cells.json');
  const { request, cell } = sample('pi');
  writeFileSync(cellFile, JSON.stringify({ version: 1, hudRevision: versions.hudRevision, cells: [cell] }));
  const options = { hudRevision: versions.hudRevision, versions, cellFile };
  assert.equal(createShippedManagedCapabilityVerifier(options).verify(request).ok, true);
  assert.equal(createShippedCodexCapabilityVerifier(options).verify(request).ok, false);
  assert.equal(createShippedManagedCapabilityVerifier({ ...options, versions: () => null }).verify(request).ok, false);
  assert.equal(
    createShippedManagedCapabilityVerifier({ ...options, versions: () => ({ ...versions, harness: 'other' }) }).verify(
      request
    ).ok,
    false
  );
  writeFileSync(cellFile, JSON.stringify({ version: 1, hudRevision: versions.hudRevision, cells: [cell, cell] }));
  assert.equal(createShippedManagedCapabilityVerifier(options).verify(request).ok, false);
});

test(
  'native target version probes receive no inherited or profile-injected delegation authority',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'hud-managed-version-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = join(dir, 'probe.c'),
      executable = join(dir, 'probe'),
      capture = join(dir, 'capture');
    writeFileSync(
      source,
      '#include <stdio.h>\n#include <stdlib.h>\nextern char **environ;\nint main(void) { FILE *f=fopen(getenv("SYNTHETIC_CAPTURE"),"w"); if(!f)return 1; for(char **v=environ;*v;v++)fprintf(f,"%s\\n",*v); fclose(f); puts("1.2.3"); return 0; }\n'
    );
    execFileSync('cc', ['-O2', '-Wall', '-Wextra', '-Werror', source, '-o', executable]);
    const inherited = {
      HOME: dir,
      PATH: process.env.PATH,
      SYNTHETIC_CAPTURE: capture,
      HUD_CLAIM: 'inherited-secret',
      HUD_RUN: 'inherited-run',
      HUD_PI_DELEGATION_FD: '3',
      PI_SESSION_ID: 'inherited-session',
    };
    const overrides = {
      HUD_CLAIM: 'profile-secret',
      HUD_LINK: 'profile-link',
      HUD_MCP_PROFILE: 'profile',
      HUD_CLAUDE_HOOK_CONFIG: '/synthetic/hook',
      PI_SESSION_FILE: '/synthetic/session',
      PI_CODING_AGENT_SESSION_DIR: '/synthetic/sessions',
      SYNTHETIC_ORDINARY: 'preserved',
    };
    const merged = { ...inherited, ...overrides };
    const clean = launchProbeEnvironment(inherited, overrides);
    assert.equal(clean.SYNTHETIC_ORDINARY, 'preserved');
    assert.equal(
      Object.keys(clean).some((key) => key.startsWith('HUD_') || key.startsWith('PI_SESSION_')),
      false
    );
    const identity = await discoverExecutable({ argv: [executable] }, merged);
    assert.equal(identity.version, '1.2.3');
    const actual = readFileSync(capture, 'utf8');
    assert.match(actual, /SYNTHETIC_ORDINARY=preserved/);
    assert.doesNotMatch(actual, /HUD_|PI_SESSION_|PI_CODING_AGENT_SESSION_DIR|inherited-secret|profile-secret/);
    assert.equal(merged.HUD_CLAIM, 'profile-secret');
  }
);
