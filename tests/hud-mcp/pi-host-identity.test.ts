import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { PiEvidenceChannel } from '../../packages/hud-mcp/src/pi-channel.js';
import { test, type TestContext } from 'node:test';
import { PiHostEvidence, piHostTuple } from '../../packages/hud-mcp/src/pi-host.js';
import {
  inferHarness,
  actualSourceRoot,
  type ProcessInfo,
  type ProcessReaderPort,
} from '../../packages/hud-mcp/src/process.js';
import { deriveProcessDomain } from '../../src/core/process-domain.js';
import { PI_EXTENSION_CONTEXT_PROFILE } from '../../src/harness/pi/delegation-context.js';
import type { PiHostHello } from '../../src/harness/pi/delegation-channel.js';

function fixture(t: TestContext, version: string, bin: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hud-pi-host-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const install = join(root, 'arbitrary-install-location');
  const entry = join(install, bin);
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, '// synthetic entrypoint, never executed\n');
  const manifest = join(install, 'package.json');
  writeFileSync(manifest, JSON.stringify({ name: '@earendil-works/pi-coding-agent', version, bin: { pi: bin } }));
  const sessions = join(root, 'sessions');
  mkdirSync(sessions);
  const parent: ProcessInfo = {
    pid: process.ppid,
    ppid: 1,
    procStart: 'synthetic-parent-start',
    argv: ['pi'],
    env: {},
    pidNamespace: 'pid:[synthetic]',
  };
  const self: ProcessInfo = {
    pid: process.pid,
    ppid: parent.pid,
    procStart: 'synthetic-mcp-start',
    argv: ['node', 'hud-mcp'],
    env: {},
    pidNamespace: parent.pidNamespace,
  };
  const reader: ProcessReaderPort = {
    get: (pid) => structuredClone(pid === self.pid ? self : parent),
    domain: () =>
      deriveProcessDomain({
        machineId: 'synthetic-machine',
        bootId: 'synthetic-boot',
        pidNamespace: self.pidNamespace,
      }),
  };
  const hello: PiHostHello = {
    kind: 'host',
    profile: PI_EXTENSION_CONTEXT_PROFILE,
    version,
    pid: parent.pid,
    entrypoint: entry,
    sourceRoot: sessions,
    argv: [process.execPath, entry, '--session-dir', sessions],
  };
  return { parent, self, reader, hello, entry, manifest };
}

for (const [version, bin] of [
  ['1.4.0', 'dist/bundle/cli.js'],
  ['99.9.0-next', 'lib/current/entry.mjs'],
]) {
  test(`Pi native host accepts declared bin layout and updated version: ${version}`, (t) => {
    const f = fixture(t, version, bin);
    const discovered = { ...f.parent, argv: f.hello.argv };
    assert.equal(inferHarness(discovered), 'pi');
    assert.equal(actualSourceRoot(discovered, 'pi'), f.hello.sourceRoot);
    const host = PiHostEvidence.capture(f.reader, f.hello);
    host.assertCurrent(f.reader);
    // The diagnostic string is not an authentication factor.
    assert.equal(
      PiHostEvidence.capture(f.reader, { ...f.hello, version: 'another-diagnostic' }).rootPath,
      host.rootPath
    );
    writeFileSync(
      f.manifest,
      JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: 'updated-again', bin: { pi: bin } })
    );
    host.assertCurrent(f.reader);
    f.parent.procStart = 'reused-parent';
    assert.throws(() => host.assertCurrent(f.reader), /identity_unverified/);
  });
}

test('Pi upgraded host still rejects forged parent, changed namespace, and non-bin package file', (t) => {
  const f = fixture(t, '99.0.0', 'lib/cli.mjs');
  assert.throws(() => PiHostEvidence.capture(f.reader, { ...f.hello, pid: f.parent.pid + 1 }), /identity_unverified/);
  f.parent.pidNamespace = 'pid:[other]';
  assert.throws(() => PiHostEvidence.capture(f.reader, f.hello), /identity_unverified/);
  f.parent.pidNamespace = f.self.pidNamespace;
  writeFileSync(
    f.manifest,
    JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '99.0.0', bin: { pi: 'other.mjs' } })
  );
  writeFileSync(join(dirname(f.manifest), 'other.mjs'), '// actual declared entrypoint');
  assert.throws(() => piHostTuple(f.parent, f.entry), /unsupported/);
});

test('Pi host metadata cannot turn an unrelated package into native source evidence', (t) => {
  const f = fixture(t, '99.0.0', 'entry.mjs');
  writeFileSync(
    f.manifest,
    JSON.stringify({ name: 'not-the-pi-package', version: '99.0.0', bin: { pi: 'entry.mjs' } })
  );
  assert.throws(() => PiHostEvidence.capture(f.reader, f.hello), /unsupported/);
});

test('native extension source works with default or reordered CLI source options', (t) => {
  const f = fixture(t, '99.0.0', 'lib/entry.mjs');
  for (const tail of [[], ['--mode', 'rpc', '--session-dir', f.hello.sourceRoot]]) {
    const host = PiHostEvidence.capture(f.reader, { ...f.hello, argv: [process.execPath, f.entry, ...tail] });
    assert.equal(host.rootPath, f.hello.sourceRoot);
    host.assertCurrent(f.reader);
  }
});

test('private native root is still bound to the independently configured source', async (t) => {
  const f = fixture(t, '99.0.0', 'lib/entry.mjs');
  const input = new PassThrough();
  const channel = new PiEvidenceChannel(input);
  t.after(() => channel.close());
  input.write(JSON.stringify({ ...f.hello, argv: [process.execPath, f.entry] }) + '\n');
  await assert.rejects(channel.bindHost(f.reader, dirname(f.hello.sourceRoot)), /identity_unverified/);
  assert.equal(channel.signal.aborted, true);
});
