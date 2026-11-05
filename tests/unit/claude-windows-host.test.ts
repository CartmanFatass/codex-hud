import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mapWindowsPath, observeWindowsHost, type WindowsHostPorts } from '../../src/cli/claude-windows-host.js';
import { safeConfigurationReason } from '../../src/cli/claude-diagnostics.js';
import { CliError } from '../../src/cli/runtime.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const mount = String.raw`38 25 0:47 / /drives/z rw - 9p Z:\134 rw,aname=drvfs;path=Z:\134;uid=1000`;
function fixture() {
  const source = Buffer.from('synthetic-source');
  const artifact = Buffer.from('MZ synthetic-not-a-real-executable');
  const binary = '/synthetic/hud/dist/windows-policy/observer-amd64.exe';
  const files = new Map([
    [binary, artifact],
    [
      binary + '.json',
      Buffer.from(
        JSON.stringify({ protocol: 1, arch: 'amd64', sourceSha256: hash(source), artifactSha256: hash(artifact) })
      ),
    ],
    ['/synthetic/hud/tools/windows-policy/main.go', source],
    [`/proc/${process.pid}/mountinfo`, Buffer.from(mount)],
  ]);
  let runs = 0;
  const ports: WindowsHostPorts = {
    platform: 'linux',
    kernel: 'synthetic-microsoft-WSL2',
    arch: 'x64',
    root: '/synthetic/hud',
    file: (path, limit) => {
      const bytes = files.get(path);
      assert.ok(bytes, path);
      assert.ok(bytes.length <= limit);
      return { bytes: Buffer.from(bytes), identity: hash(bytes) };
    },
    interop: () => ({ locator: '/run/WSL/123_interop', identity: 'synthetic-verified-ancestor-socket-binfmt' }),
    directory: (path) => {
      assert.equal(path, '/drives/z/Windows/System32');
      return 'synthetic-directory-identity';
    },
    run: (path, locator) => {
      assert.equal(path, binary);
      assert.equal(locator, '/run/WSL/123_interop');
      runs++;
      return JSON.stringify({
        protocol: 1,
        systemDirectory: String.raw`Z:\Windows\System32`,
        programFiles: String.raw`Z:\Program Files`,
        hklm: { state: 'missing', code: 2 },
        hkcu: { state: 'denied', code: 5 },
      });
    },
  };
  return { ports, files, binary, runs: () => runs };
}

test('Claude default Windows host binds installed helper, observed system folders, mapped drive and original identities', () => {
  const f = fixture();
  const result = observeWindowsHost(f.ports);
  assert.equal(result.system.managedRoot, '/drives/z/Program Files/ClaudeCode');
  assert.equal(result.system.observerExe, f.binary);
  assert.deepEqual(result.registry.HKLM, { state: 'missing', code: 2 });
  assert.deepEqual(result.registry.HKCU, { state: 'denied', code: 5 });
  assert.equal(f.runs(), 1);
  const run = f.ports.run;
  f.ports.run = (...args) => {
    const output = run(...args);
    f.files.set(f.binary, Buffer.from('MZ replaced'));
    return output;
  };
  assert.throws(() => observeWindowsHost(f.ports), /configuration_windows_system_changed/);
});

test('Claude Windows default rejects absent or mismatched helper, unknown interop and ambiguous or shadowed mappings', () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.ports.kernel = 'synthetic-linux';
    },
    (f: ReturnType<typeof fixture>) => {
      f.files.delete(f.binary);
    },
    (f: ReturnType<typeof fixture>) => {
      f.files.set(f.binary, Buffer.from('MZ tampered'));
    },
    (f: ReturnType<typeof fixture>) => {
      f.ports.interop = () => {
        throw new Error('configuration_windows_interop_ancestry_unknown');
      };
    },
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => observeWindowsHost(f.ports), /configuration_windows_/);
    assert.equal(f.runs(), 0);
  }
  assert.throws(() => mapWindowsPath(String.raw`C:\Windows\System32`, mount), /mount_ambiguous/);
  assert.throws(() => mapWindowsPath(String.raw`Z:\Windows\System32`, mount + '\n' + mount), /mount_ambiguous/);
  assert.throws(
    () =>
      mapWindowsPath(
        String.raw`Z:\Windows\System32`,
        mount + '\n39 38 0:2 / /drives/z/Windows rw - ext4 /dev/synthetic rw'
      ),
    /mount_shadowed/
  );
  assert.throws(() => mapWindowsPath(String.raw`Z:\..\credentials`, mount), /system_path_unknown/);
});

test('Claude refusal details expose only fixed safe reasons while preserving capability_unverified and exit code', () => {
  const known = 'configuration_windows_registry_denied';
  const error = new CliError('capability_unverified', 4, safeConfigurationReason(known));
  assert.equal(error.reason, 'capability_unverified');
  assert.equal(error.exitCode, 4);
  assert.equal(error.message, `capability_unverified: ${known}`);
  for (const unsafe of ['configuration_/private/secret', 'configuration_invented_secret', 'raw helper output', null])
    assert.equal(safeConfigurationReason(unsafe), 'configuration_incomplete');
});
