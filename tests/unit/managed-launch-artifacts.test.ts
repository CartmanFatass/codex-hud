import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeLaunchArtifact,
  decodeLaunchArtifacts,
  validateLaunchArtifacts,
  launchArtifactPath,
  type LaunchArtifactPayload,
} from '../../src/core/run/launch-artifacts.js';
import { RunArtifacts } from '../../src/core/run/artifacts.js';
import { HeadlessRunControl, launchDigest } from '../../src/core/run/control.js';
import { MemoryRunFactPort } from '../../src/core/run/fake-port.js';
import { seedRun } from '../run/fixtures.js';
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const local = { kind: 'trusted_local' as const, uid: process.getuid?.() ?? -1, invocationId: 'synthetic-artifacts' };

test('private artifacts are hash-addressed, bounded, fixed-kind JSON and reachable only through frozen argv', () => {
  const hook = encodeLaunchArtifact('claude-hook', json({ synthetic: true }));
  const home = '/synthetic/hud',
    id = 'run-synthetic';
  const hookPath = launchArtifactPath(home, id, hook.name);
  const settings = encodeLaunchArtifact('claude-settings', json({ command: `node hook --config ${hookPath}` }));
  const settingsPath = launchArtifactPath(home, id, settings.name);
  const command = { argv: ['/synthetic/claude', '--settings', settingsPath] };
  assert.equal(validateLaunchArtifacts([hook, settings], home, id, command).length, 2);
  assert.throws(() => validateLaunchArtifacts([hook], home, id, command), /invalid_launch_artifacts/);
  assert.throws(
    () => validateLaunchArtifacts([hook, settings], home, 'different-run', command),
    /invalid_launch_artifacts/
  );
  assert.throws(
    () => validateLaunchArtifacts([hook], home, id, { shell: 'irrelevant', shellPath: '/bin/sh' }),
    /invalid_launch_artifacts/
  );
  for (const payload of [
    { ...hook, name: '../escape.json' },
    { ...hook, base64: json({ tampered: true }).toString('base64') },
    { ...hook, base64: hook.base64 + '\n' },
    { ...hook, other: 'not allowed' },
  ])
    assert.throws(() => decodeLaunchArtifacts([payload as LaunchArtifactPayload]), /invalid_launch_artifacts/);
  assert.throws(() => decodeLaunchArtifacts([hook, hook]), /invalid_launch_artifacts/);
  assert.throws(() => encodeLaunchArtifact('claude-mcp', Buffer.alloc(131073)), /invalid_launch_artifacts/);
  assert.throws(() => encodeLaunchArtifact('claude-mcp', Buffer.from('null')), /invalid_launch_artifacts/);
  assert.throws(() => launchArtifactPath('/synthetic/../hud', id, hook.name), /invalid_launch_artifacts/);
  assert.throws(() => launchArtifactPath(home, '../escape', hook.name), /invalid_launch_artifacts/);
  const changed = encodeLaunchArtifact('claude-settings', json({ command: 'changed' }));
  const a = seedRun(home, command.argv).input;
  assert.notEqual(
    launchDigest(a),
    launchDigest({
      ...a,
      launch: { argv: ['/synthetic/claude', '--settings', launchArtifactPath(home, id, changed.name)] },
    })
  );
});

test(
  'artifact files are exclusive 0600, symlink resistant, read-only in recovery and retained privately',
  { skip: process.platform !== 'linux' },
  (t) => {
    const home = mkdtempSync(join(tmpdir(), 'hud-managed-artifacts-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const payload = encodeLaunchArtifact('claude-mcp', json({ env: { HUD_CLAIM: 'synthetic-secret' } }));
    const bytes = decodeLaunchArtifacts([payload]);
    const writer = RunArtifacts.create(home, 'one');
    writer.writeLaunchArtifacts(bytes);
    const path = launchArtifactPath(home, 'one', payload.name);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(path), bytes[0].bytes);
    assert.throws(() => writer.writeLaunchArtifacts(bytes), /EEXIST/);
    assert.throws(() => RunArtifacts.open(home, 'one').writeLaunchArtifacts(bytes), /read_only/);
    const second = RunArtifacts.create(home, 'two');
    const outside = join(home, 'outside');
    writeFileSync(outside, 'untouched');
    symlinkSync(outside, launchArtifactPath(home, 'two', payload.name));
    assert.throws(() => second.writeLaunchArtifacts(bytes), /EEXIST/);
    assert.equal(readFileSync(outside, 'utf8'), 'untouched');
    // No automatic cleanup can delete private credentials while scope is uncertain.
    assert.equal(existsSync(path), true);
  }
);

test(
  'invalid payload and a losing execution ticket materialize no artifact or process',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'hud-managed-ticket-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const payload = encodeLaunchArtifact('claude-settings', json({ synthetic: true }));
    const seed = seedRun(home, ['/bin/true']);
    seed.input.launch = { argv: ['/bin/true', launchArtifactPath(home, seed.input.runId, payload.name)] };
    seed.seed.snapshot.run.launchDigest = launchDigest(seed.input);
    const port = new MemoryRunFactPort(seed.seed);
    const control = new HeadlessRunControl(port, home, local);
    await assert.rejects(
      control.start({ input: seed.input, ticket: seed.ticket, launchArtifacts: [{ ...payload, base64: 'changed' }] }),
      /invalid_launch_artifacts/
    );
    assert.equal(existsSync(join(home, 'runs')), false);
    await assert.rejects(
      control.start({ input: seed.input, ticket: 'wrong-ticket', launchArtifacts: [payload] }),
      /ticket|authorization/
    );
    assert.equal(existsSync(join(home, 'runs')), false);
    assert.equal((await port.read(seed.input.runId)).events.length, 0);
  }
);
