import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, rewriteManifest } from '../../scripts/runtime-package/test-fixture.mjs';
import { verifyBundle, parseManifest, HELPERS } from '../../scripts/runtime-package/manifest.mjs';
import { validateLock } from '../../scripts/pack-runtime.mjs';
import { selectedOutputs } from '../../scripts/pack-cloud-preview.mjs';
import { json, Directory } from '../../scripts/runtime-package/safety.mjs';

test('manifest validates complete bounded payload and exact locked production identities', (t) => {
  const f = fixture(t);
  const bundle = verifyBundle(f.bundle);
  bundle.directory.close();
  const lock = JSON.parse(fs.readFileSync(new URL('../../package-lock.json', import.meta.url)));
  assert.deepEqual(Object.keys(validateLock(lock)), ['@iarna/toml', 'chokidar', 'readdirp']);
  lock.packages['node_modules/foreign'] = { version: '1' };
  assert.throws(() => validateLock(lock), /closure/);
  assert.ok(HELPERS.includes('bin/codex-with-herdr-context'));
});
test('exact shared source mapping never selects arbitrary output or source files', () => {
  const outputs = selectedOutputs(
    ['src/cli/hud.ts', 'packages/hud-mcp/src/main.ts', 'src/type.d.ts', 'dist/secret.js', 'tests/x.ts'],
    () => false
  );
  assert.deepEqual(
    outputs.map((entry) => entry.output),
    ['dist/cli/hud.js', 'packages/hud-mcp/dist/packages/hud-mcp/src/main.js']
  );
});
test('E2 shared helper mapping', () => {
  const source = 'src/utils/hud-env.ts';
  const main = { source, output: 'dist/utils/hud-env.js', generatedPath: 'main/utils/hud-env.js' };
  const mcp = {
    source,
    output: 'packages/hud-mcp/dist/src/utils/hud-env.js',
    generatedPath: 'mcp/src/utils/hud-env.js',
  };
  assert.deepEqual(selectedOutputs([source], () => false), [main]);
  assert.deepEqual(selectedOutputs([source], (file) => file === mcp.generatedPath), [main, mcp]);
  assert.deepEqual(selectedOutputs([source], (file) => file === 'mcp/src/unrelated.js'), [main]);
});
for (const name of ['bin/hud', 'bin/codex-with-herdr-context', 'node_modules/chokidar/package.json']) {
  test(`tampered and missing runtime closure fails: ${name}`, (t) => {
    const f = fixture(t);
    const file = path.join(f.bundle, name);
    fs.appendFileSync(file, 'tampered');
    assert.throws(() => verifyBundle(f.bundle), /integrity/);
    fs.unlinkSync(file);
    assert.throws(() => verifyBundle(f.bundle), /missing/);
  });
}
for (const mutation of [
  (m) => m.entries.push({ ...m.entries[0] }),
  (m) => (m.entries[0].path = '../escape'),
  (m) => (m.entries[0].bytes = -1),
  (m) => (m.entries[0].bytes = 2 ** 53),
  (m) => (m.entries[0].sha256 = 'bad'),
  (m) => (m.entries[0].mode = '777'),
  (m) => (m.repositoryTree = 'bad'),
  (m) => m.entries.splice(0, 1),
])
  test('malformed manifest is refused before copy', (t) => {
    const f = fixture(t);
    rewriteManifest(f, mutation);
    assert.throws(() => parseManifest(json(f.manifest)));
  });
test('unlisted files, links, devices and hard links cannot enter the bundle', (t) => {
  const f = fixture(t);
  const file = path.join(f.bundle, 'extra');
  fs.writeFileSync(file, 'foreign');
  assert.throws(() => verifyBundle(f.bundle), /unlisted/);
  fs.unlinkSync(file);
  fs.symlinkSync('/dev/null', file);
  assert.throws(() => verifyBundle(f.bundle), /links/);
  fs.unlinkSync(file);
  fs.linkSync(path.join(f.bundle, 'bin/hud'), file);
  assert.throws(() => verifyBundle(f.bundle), /links/);
  fs.unlinkSync(file);
  const result = spawnSync('/usr/bin/mkfifo', [file], { env: f.env, timeout: 1000 });
  assert.equal(result.status, 0);
  assert.throws(() => verifyBundle(f.bundle), /links/);
});
test('bounded regular read rejects FIFO and oversize file without blocking', (t) => {
  const f = fixture(t);
  const d = new Directory(f.bundle);
  t.after(() => d.close());
  fs.writeFileSync(path.join(f.bundle, 'huge'), Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.throws(() => d.read('huge'), /oversize/);
  spawnSync('/usr/bin/mkfifo', [path.join(f.bundle, 'fifo')], { env: f.env, timeout: 1000 });
  assert.throws(() => d.read('fifo'), /unsafe/);
});
test('source parent symlink and replaced pinned parent are rejected', (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.bundle, path.join(f.root, 'alias'));
  assert.throws(() => verifyBundle(path.join(f.root, 'alias')));
  const pinned = new Directory(f.bundle);
  t.after(() => pinned.close());
  fs.renameSync(f.bundle, f.bundle + '-old');
  fs.mkdirSync(f.bundle, { mode: 0o700 });
  assert.throws(() => pinned.read('package.json'), /identity_changed/);
});
test('unlisted empty directories are rejected', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.bundle, 'empty'));
  assert.throws(() => verifyBundle(f.bundle), /unlisted_bundle_directory/);
});
test('a file changing while its bytes are read is rejected', async (t) => {
  const f = fixture(t);
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const mutable = createRequire(import.meta.url)('node:fs');
  const original = mutable.readSync;
  const directory = new Directory(f.bundle);
  let changed = false;
  mutable.readSync = function (fd, ...args) {
    const result = original(fd, ...args);
    if (!changed && fs.readlinkSync(`/proc/self/fd/${fd}`) === path.join(f.bundle, 'bin/hud')) {
      changed = true;
      fs.appendFileSync(path.join(f.bundle, 'bin/hud'), 'changed');
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => directory.read('bin/hud'), /source_changed_during_read/);
  } finally {
    mutable.readSync = original;
    syncBuiltinESMExports();
    directory.close();
  }
});
for (const mutation of [
  (m) => (m.tree = m.repositoryTree),
  (m) => (m.entries[0].unexpected = true),
  (m) => (m.provenance = { arbitrary: 'nested' }),
  (m) => (m.entries[0].origin = '\ud800'),
  (m) => (m.entries[0].provenance = 'bad\0text'),
  (m) => (m.entries[0].origin = 'x'.repeat(1025)),
  (m) => (m.capabilityLimitation = 'x'.repeat(4097)),
  (m) => (m.builtWithNode = 'v24.0.0'),
  (m) => (m.builtWithNode = '24.00.0'),
  (m) => (m.dependencies = { ...m.dependencies, extra: '1' }),
  (m) => (m.dependencies = []),
  (m) => (m.sourceContentSha256 = 'not-a-hash'),
])
  test('frozen shared metadata envelope rejects malformed or unknown fields', (t) => {
    const f = fixture(t);
    mutation(f.manifest);
    assert.throws(() => parseManifest(json(f.manifest)));
  });
test('valid optional metadata stays inert; dirty development bundles remain valid', (t) => {
  const f = fixture(t);
  Object.assign(f.manifest, {
    builtWithNode: '24.0.0-vendor.1+build.2',
    dependencies: { '@iarna/toml': '2.2.5', chokidar: '5.0.0', readdirp: '5.0.0' },
    sourceContentSha256: 'd'.repeat(64),
  });
  f.manifest.entries[0].provenance = 'inert synthetic text';
  assert.equal(parseManifest(json(f.manifest)).dirty, true);
  for (const key of [
    'platform',
    'nodeRequirement',
    'provenance',
    'capabilityLimitation',
    'builtWithNode',
    'dependencies',
    'sourceContentSha256',
  ])
    delete f.manifest[key];
  for (const entry of f.manifest.entries) delete entry.origin;
  assert.equal(parseManifest(json(f.manifest)).schemaVersion, 1);
  assert.throws(() => parseManifest(Buffer.from([0xff])), /encoded data/);
  assert.throws(() => parseManifest(Buffer.alloc(2 * 1024 * 1024 + 1)), /manifest_byte_limit/);
});
test('annotation aggregate and payload total are independently bounded', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 80; i++)
    f.manifest.entries.push({ ...f.manifest.entries[0], path: `extra-${i}`, provenance: 'x'.repeat(4096) });
  assert.throws(() => parseManifest(json(f.manifest)), /annotation_total_limit/);
  const g = fixture(t);
  for (const entry of g.manifest.entries) entry.bytes = 2 * 1024 * 1024;
  assert.throws(() => parseManifest(json(g.manifest)), /bundle_size_limit/);
});
test('builder help and unknown arguments never start a build; unsupported cache flag is refused', (t) => {
  const f = fixture(t);
  const builder = new URL('../../scripts/pack-runtime.mjs', import.meta.url);
  for (const [args, expected] of [
    [['--help'], 0],
    [['--offline-cache', f.root], 1],
    [['--help', '--unknown'], 1],
  ]) {
    const result = spawnSync(process.execPath, [builder.pathname, ...args], {
      cwd: f.cwd,
      env: f.env,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, expected, result.stderr);
    assert.match(result.stdout, /Usage/);
    assert.deepEqual(fs.readdirSync(f.home), []);
    assert.deepEqual(fs.readdirSync(f.prefix), []);
  }
});
for (const version of ['24.0.0-01', '24.0.0-rc.00', '24.0.0-00+build'])
  test(`fix1 SemVer rejects numeric prerelease leading zero: ${version}`, (t) => {
    const f = fixture(t);
    f.manifest.builtWithNode = version;
    assert.throws(() => parseManifest(json(f.manifest)), /node_metadata/);
  });
for (const version of [
  '24.0.0',
  '24.0.0-0',
  '24.0.0-rc.0',
  '24.0.0-01a',
  '24.0.0-rc.1+build.00',
  '24.0.0+001',
  '24.0.0+build-01',
])
  test(`fix1 SemVer accepts standard prerelease/build: ${version}`, (t) => {
    const f = fixture(t);
    f.manifest.builtWithNode = version;
    assert.equal(parseManifest(json(f.manifest)).builtWithNode, version);
  });
for (const [name, mode] of [
  ['bin', 0o777],
  ['RUNTIME-MANIFEST.json', 0o777],
  ['bin/hud', 0o4700],
])
  test(`fix1 bundle rejects unsafe full permission mode: ${name}`, (t) => {
    const f = fixture(t);
    fs.chmodSync(path.join(f.bundle, name), mode);
    assert.throws(() => verifyBundle(f.bundle), /mode|permission|private|integrity/);
  });
test('fix1 exactly 5000 payload files plus manifest is valid; 5001 payload files is rejected', (t) => {
  const f = fixture(t);
  while (f.manifest.entries.length < 5000) {
    const name = `padding/file-${String(f.manifest.entries.length).padStart(4, '0')}`;
    const file = path.join(f.bundle, name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, '', { mode: 0o600 });
    f.manifest.entries.push({
      path: name,
      bytes: 0,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      mode: '0600',
    });
  }
  rewriteManifest(f, () => {});
  const verified = verifyBundle(f.bundle);
  verified.directory.close();
  f.manifest.entries.push({ ...f.manifest.entries.at(-1), path: 'padding/over-limit' });
  assert.throws(() => parseManifest(json(f.manifest)), /manifest/);
});
test('fix1 builder selected-input reader bounds allocation and avoids readFileSync', async (t) => {
  assert.doesNotMatch(
    fs.readFileSync(new URL('../../scripts/pack-runtime.mjs', import.meta.url), 'utf8'),
    /\breadFileSync\s*\(/
  );
  const f = fixture(t);
  const module = await import('../../scripts/pack-runtime.mjs');
  assert.equal(typeof module.readBuildInput, 'function');
  const file = path.join(f.root, 'oversize');
  const fd = fs.openSync(file, 'wx', 0o600);
  fs.ftruncateSync(fd, 2097153);
  fs.closeSync(fd);
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const mutable = createRequire(import.meta.url)('node:fs');
  const original = mutable.readFileSync;
  mutable.readFileSync = () => {
    throw Error('unbounded_readFileSync_called');
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => module.readBuildInput(f.root, 'oversize'), /unsafe_or_oversize_file/);
    assert.equal(module.readBuildInput(f.bundle, 'bin/hud').data.length > 0, true);
  } finally {
    mutable.readFileSync = original;
    syncBuiltinESMExports();
  }
});
for (const signal of ['SIGINT', 'SIGTERM'])
  test(`fix1 interrupted builder ${signal} reaps owned child and writes failure receipt`, async (t) => {
    const f = fixture(t);
    const { interruptedRunnerCode } = await import('../../scripts/runtime-package/test-fixture.mjs');
    const result = spawnSync(
      '/usr/bin/python3',
      [
        '-c',
        interruptedRunnerCode(),
        process.execPath,
        new URL('../../scripts/pack-runtime.mjs', import.meta.url).href,
        f.cwd,
        signal,
      ],
      { env: f.env, encoding: 'utf8', timeout: 8500 }
    );
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    t.diagnostic(JSON.stringify(observed));
    assert.equal(observed.error, null);
    assert.equal(observed.reaped, true);
    assert.equal(observed.aliveAfterDeadline, false, JSON.stringify(observed));
    assert.equal(observed.receipt?.reason, `interrupted_${signal}`);
    assert.equal(observed.receipt?.cleanupUncertain, false);
  });
test('fix1 owned runner records a quick normal child without uncertainty', async (t) => {
  const f = fixture(t);
  const { runOwned } = await import('../../scripts/pack-runtime.mjs');
  const result = await runOwned('quick', '/bin/true', [], f.cwd, f.env, f.cwd, 1000);
  assert.equal(result.status, 'PASS');
  assert.equal(result.cleanupUncertain, false);
  assert.match(result.ownedStart, /^[0-9]+$/);
  t.diagnostic(JSON.stringify(result));
});
