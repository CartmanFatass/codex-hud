/** SIMULATED main only. Not the MCP service, launch preparer, ledger or supervisor. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDelegateConfig } from './config.js';
import { LinuxProcessReader } from './process.js';
import { MemoryCallerRegistry, registerCaller } from './registry.js';
import { createManagedNativeRuntime } from './managed-runtime.js';
import { launchProfileDigest } from '../../../src/core/capabilities.js';
import { makeSourceId } from '../../../src/core/identity.js';
import { parseCapabilityManifest, matchesCapability } from '../../../src/core/capability-manifest.js';
import { launchProbeEnvironment } from '../../../src/core/launch/fingerprint.js';

const input = JSON.parse(readFileSync(process.env.SYNTHETIC_COMPOSE_INPUT, 'utf8'));
const birth = readFileSync('/proc/self/stat', 'utf8');
writeFileSync(input.marker, JSON.stringify({ pid: process.pid, start: birth.slice(birth.lastIndexOf(')') + 2).split(' ')[19] }), { mode: 0o600 });
const source = join(input.root, 'source');
const targetSource = join(input.root, 'target-source');
const base = {
  name: 'SIMULATED-parent', harness: 'codex', source: { root: source, label: 'SIMULATED parent' },
  launch: { argv: [input.native] }, headless: null, resume: null, resumeHeadless: null,
  host: { kind: 'none', layout: 'none' }, env: {}, mcpServerName: 'hud', claimTransport: 'config_env',
  clientToolTimeoutMs: null, responseMarginMs: 1000, orphan_policy: 'continue', managedShellVerified: false,
  roles: { worker: { model: 'SIMULATED-model', effort: 'low' } },
};
const config = validateDelegateConfig({ version: 1, profiles: [base, {
  ...base, name: 'SIMULATED-target', source: { root: targetSource, label: 'SIMULATED target' },
  headless: { argv: [input.target, 'exec', '-'] },
  resumeHeadless: { argv: [input.target, 'exec', 'resume', '{{sessionId}}', '-'] },
  env: { HUD_CLAIM: 'SIMULATED-profile', HUD_HOME: 'SIMULATED-profile', HUD_LINK: 'SIMULATED-profile', HUD_RUN: 'SIMULATED-profile',
    PI_SESSION_ID: 'SIMULATED-profile', PI_SESSION_CHANNEL: 'SIMULATED-profile', PI_CODING_AGENT_SESSION_DIR: 'SIMULATED-profile' },
}] });
const reader = new LinuxProcessReader();
const registration = await registerCaller({ reader, registry: new MemoryCallerRegistry(), profile: config.profiles[0],
  pid: process.pid, cwd: () => process.cwd(), envPane: null, nowMs: Date.now() });
let selected = config.profiles[0];
if (input.wrongSelected === 'profile') selected = structuredClone(selected);
if (input.wrongSelected === 'source') { selected = config.profiles[1]; }
const scrubbed = launchProbeEnvironment(process.env, config.profiles[1].env);
assert.ok(Object.keys(scrubbed).every((key) => !key.startsWith('HUD_') && !key.startsWith('PI_SESSION_') && key !== 'PI_CODING_AGENT_SESSION_DIR'));
const runtime = await createManagedNativeRuntime({ registration, reader, config, selected, env: process.env,
  // Deliberately ignored extras exercise that the factory has no configurable path seam.
  root: input.fakeRoot, manifestPath: input.fakeManifest, bootstrapPaths: ['/not/a/helper'] });
const profile = config.profiles[1];
const digestProfile = { ...profile, env: Object.fromEntries(Object.entries(profile.env).filter(([key]) =>
  !['HUD_CLAIM', 'HUD_RUN', 'HUD_LINK', 'HUD_HOME'].includes(key))) };
const request = (operation) => ({
  key: { harness: 'codex', profileDigest: launchProfileDigest(digestProfile), hostKind: 'none', layout: 'none',
    mode: 'headless', operation, ...(operation === 'resume' ? { resumeFrom: 'headless' } : {}) },
  sourceId: makeSourceId('codex', targetSource), profileFingerprint: 'd'.repeat(64), configurationCoverage: 'complete',
  executableIdentity: runtime.launchExecutableIdentities.get(JSON.stringify([profile.name, operation, 'headless']))
    ?? { path: input.target, version: '0.166.0' },
});
const requests = [request('spawn'), request('resume')];
const expected = requests.map((r) => runtime.expectation(r));
const verification = requests.map((r) => runtime.capability.verify(r));
const negative = [];
if (input.exactMatchNegatives) {
  assert.ok(verification.every((v) => v.ok));
  const mutations = {
    sourceId: (r) => { r.sourceId = 'e'.repeat(64); },
    profileDigest: (r) => { r.key.profileDigest = 'e'.repeat(64); },
    profileFingerprint: (r) => { r.profileFingerprint = 'e'.repeat(64); },
    executablePath: (r) => { r.executableIdentity.path += '-wrong'; },
    executableVersion: (r) => { r.executableIdentity.version = '0.165.0'; },
    operation: (r) => { r.key.operation = 'launch'; },
    host: (r) => { r.key.hostKind = 'tmux'; r.key.layout = 'pane'; },
    layout: (r) => { r.key.layout = 'split'; },
    visible: (r) => { r.key.mode = 'visible'; },
    coverage: (r) => { r.configurationCoverage = 'partial'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const changed = structuredClone(requests[0]); mutate(changed);
    const result = runtime.capability.verify(changed); assert.equal(result.ok, false, name);
    negative.push({ name, result });
  }
  const changed = structuredClone(requests[1]); changed.key.resumeFrom = 'visible';
  assert.equal(runtime.capability.verify(changed).ok, false); negative.push({ name: 'resume-origin', refused: true });
  const manifestPath = fileURLToPath(new URL('../../../src/core/launch/managed-cells.json', import.meta.url));
  const raw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  assert.ok(parseCapabilityManifest(Buffer.from(raw)));
  for (const name of Object.keys(expected[0].versions)) {
    const altered = structuredClone(expected[0]); altered.versions[name] += '-wrong';
    assert.equal(matchesCapability(parseCapabilityManifest(Buffer.from(raw)), altered), false, name);
    negative.push({ name: `version:${name}`, refused: true });
  }
  const eligibility = {
    review: (c) => { c.evidence.reviewStatus = 'pending'; },
    incomplete: (c) => { c.incomplete = ['SIMULATED missing check']; },
    ...Object.fromEntries(['identity', 'input', 'scope', 'receipt', 'singleSubmission'].map((key) =>
      [`result:${key}`, (c) => { delete c.results[key]; }])),
  };
  for (const [name, mutate] of Object.entries(eligibility)) {
    const altered = structuredClone(manifest); mutate(altered.cells[0]);
    assert.equal(matchesCapability(parseCapabilityManifest(Buffer.from(JSON.stringify(altered))), expected[0]), false, name);
    negative.push({ name, refused: true });
  }
}
const self = reader.get(process.pid), parent = reader.get(process.ppid);
const selection = input.prefix ? JSON.parse(readFileSync(join(input.prefix, 'current'), 'utf8')) : null;
process.stdout.write(JSON.stringify({ simulated: true, selection, argv: process.argv.slice(1), stdin: readFileSync(0, 'utf8'),
  descriptor: readFileSync(3, 'utf8'), cwd: process.cwd(), wrapper: realpathSync(process.argv[1]),
  module: fileURLToPath(new URL('./managed-runtime.js', import.meta.url)),
  physical: { pid: self.pid, ppid: self.ppid, start: self.procStart, parentStart: parent.procStart,
    sameNamespace: self.pidNamespace === parent.pidNamespace, registrationPid: registration.caller.pid,
    registrationParent: registration.caller.ppid, harnessPid: registration.harnessPid,
    sourceMatches: registration.source?.rootPath === source },
  startup: runtime.startup, requests, expected, verification, negative,
  probeEnvironmentScrubbed: true }) + '\n');
