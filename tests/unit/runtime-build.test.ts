import { DEPENDENCIES } from '../../src/core/runtime-dependencies.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeRuntimeBuild, RUNTIME_CAPABILITY_FILES, MINIMUM_RUNTIME_FILES } from '../../src/core/runtime-build.js';
import { syntheticBuild, sealSyntheticBuild, sha256 } from '../fixtures/managed-native-build.js';
const fixture = (t: { after(fn: () => void): void }) => {
  const root = mkdtempSync(join(tmpdir(), 'managed-native-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = syntheticBuild(root);
  return {
    root,
    manifest,
    save: (value: unknown) => writeFileSync(join(root, 'RUNTIME-MANIFEST.json'), JSON.stringify(value)),
  };
};
test('SIMULATED complete private runtime inventory derives frozen build ID and excludes only four cell files', (t) => {
  const f = fixture(t);
  const result = observeRuntimeBuild(f.root)!;
  assert.ok(result);
  const selected = f.manifest.entries
    .filter((e) => !(RUNTIME_CAPABILITY_FILES as readonly string[]).includes(e.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => [e.path, e.mode, e.bytes, e.sha256]);
  assert.equal(result.buildId, 'sha256:' + sha256(JSON.stringify(['hud-runtime-build-v1', selected])));
  assert.equal(result.files, MINIMUM_RUNTIME_FILES.length + 1);
  assert.equal(result.capabilityManifests.size, 4);
  writeFileSync(join(f.root, RUNTIME_CAPABILITY_FILES[0]), ' { "version": 1, "hudRevision": null, "cells": [] }\n');
  sealSyntheticBuild(f.root);
  assert.equal(observeRuntimeBuild(f.root)?.buildId, result.buildId);
  writeFileSync(join(f.root, 'synthetic.js'), 'changed');
  sealSyntheticBuild(f.root);
  assert.notEqual(observeRuntimeBuild(f.root)?.buildId, result.buildId);
  chmodSync(join(f.root, 'synthetic.js'), 0o700);
  sealSyntheticBuild(f.root);
  assert.notEqual(observeRuntimeBuild(f.root)?.buildId, result.buildId);
});
for (const kind of [
  'dirty',
  'missing',
  'changed',
  'unlisted',
  'symlink',
  'directory-link',
  'duplicate',
  'escape',
  'oversize',
  'total',
  'too-many',
  'mode',
  'unknown',
  'bad-meta',
  'tree-alias',
  'dot-path',
  'duplicate-json',
  'bad-cells',
  'truncated',
  'invalid-utf8',
] as const)
  test(`runtime refuses ${kind}`, (t) => {
    const f = fixture(t);
    const m = structuredClone(f.manifest) as any;
    if (kind === 'dirty') m.dirty = true;
    if (kind === 'missing') {
      rmSync(join(f.root, 'RUNTIME-MANIFEST.json'));
      assert.equal(observeRuntimeBuild(f.root), null);
      return;
    }
    if (kind === 'changed') writeFileSync(join(f.root, 'synthetic.js'), 'changed');
    if (kind === 'unlisted') writeFileSync(join(f.root, 'extra'), 'extra');
    if (kind === 'symlink') {
      rmSync(join(f.root, 'synthetic.js'));
      symlinkSync('bin/hud-run', join(f.root, 'synthetic.js'));
    }
    if (kind === 'directory-link') {
      rmSync(join(f.root, 'bin'), { recursive: true });
      symlinkSync('dist', join(f.root, 'bin'));
    }
    if (kind === 'duplicate') m.entries.push(m.entries[0]);
    if (kind === 'escape') m.entries[0].path = '../outside';
    if (kind === 'oversize') m.entries[0].bytes = 4 * 1024 * 1024 + 1;
    if (kind === 'total')
      m.entries = Array.from({ length: 49 }, (_, i) => ({ ...m.entries[0], path: `x${i}`, bytes: 2097152 }));
    if (kind === 'too-many') m.entries = Array.from({ length: 12001 }, (_, i) => ({ ...m.entries[0], path: `x${i}` }));
    if (kind === 'mode') chmodSync(join(f.root, 'synthetic.js'), 0o644);
    if (kind === 'unknown') m.override = true;
    if (kind === 'bad-meta') m.provenance = { load: '/outside' };
    if (kind === 'tree-alias') {
      m.tree = m.repositoryTree;
      delete m.repositoryTree;
    }
    if (kind === 'dot-path') m.entries[0].path = '.hidden/file';
    if (kind === 'bad-cells') {
      writeFileSync(join(f.root, RUNTIME_CAPABILITY_FILES[2]), '{"version":1,"hudRevision":null,"cells":[{}]}');
      sealSyntheticBuild(f.root);
      assert.equal(observeRuntimeBuild(f.root), null);
      return;
    }
    f.save(m);
    if (kind === 'duplicate-json')
      writeFileSync(
        join(f.root, 'RUNTIME-MANIFEST.json'),
        readFileSync(join(f.root, 'RUNTIME-MANIFEST.json'), 'utf8').replace(
          '"schemaVersion":1',
          '"schemaVersion":1,"schemaVersion":1'
        )
      );
    if (kind === 'truncated') writeFileSync(join(f.root, 'RUNTIME-MANIFEST.json'), '{');
    if (kind === 'invalid-utf8') writeFileSync(join(f.root, 'RUNTIME-MANIFEST.json'), Buffer.from([0xff]));
    assert.equal(observeRuntimeBuild(f.root), null);
  });

test('runtime metadata uses the exact inert shared whitelist and primitive types', (t) => {
  const f = fixture(t);
  const valid = {
    ...f.manifest,
    platform: 'linux',
    nodeRequirement: '^22.13.0 || ^24.0.0',
    sourceContentSha256: 'd'.repeat(64),
    builtWithNode: '24.22.1-vendor.1+build.2',
    dependencies: { ...DEPENDENCIES },
    capabilityLimitation: 'SIMULATED only',
  };
  f.save(valid);
  assert.ok(observeRuntimeBuild(f.root));
  for (const [key, value] of Object.entries({
    platform: 'other',
    nodeRequirement: '*',
    sourceContentSha256: ['d'.repeat(64)],
    builtWithNode: '024.22.1',
    repositorySha: ['a'.repeat(40)],
    repositoryTree: ['b'.repeat(40)],
    lockfileSha256: ['c'.repeat(64)],
    dependencies: { ...DEPENDENCIES, other: '1.0.0' },
    provenance: '\ud800',
    capabilityLimitation: 'bad\0text',
  })) {
    f.save({ ...valid, [key]: value });
    assert.equal(observeRuntimeBuild(f.root), null, key);
  }
  const extras = structuredClone(valid) as any;
  extras.entries[0].loader = 'never load';
  f.save(extras);
  assert.equal(observeRuntimeBuild(f.root), null);
  delete extras.entries[0].loader;
  extras.entries[0].origin = {};
  f.save(extras);
  assert.equal(observeRuntimeBuild(f.root), null);
});

test('inert builtWithNode validates standard SemVer without trusting it as actual Node', (t) => {
  const f = fixture(t);
  for (const version of ['24.0.0-01', '24.0.0-rc.00', '24.0.0-00+build']) {
    f.save({ ...f.manifest, builtWithNode: version });
    assert.equal(observeRuntimeBuild(f.root), null, version);
  }
  for (const version of ['24.0.0', '24.0.0-0', '24.0.0-rc.0', '24.0.0-01a', '24.0.0-rc.1+build.00', '24.0.0+001']) {
    f.save({ ...f.manifest, builtWithNode: version });
    assert.ok(observeRuntimeBuild(f.root), version);
  }
});

for (const missing of MINIMUM_RUNTIME_FILES)
  test(`minimum runtime anchor cannot be omitted: ${missing}`, (t) => {
    const f = fixture(t);
    rmSync(join(f.root, missing));
    sealSyntheticBuild(f.root);
    assert.equal(observeRuntimeBuild(f.root), null);
  });
for (const name of ['@iarna/toml', 'chokidar', 'readdirp'])
  test(`dependency package identity is independently checked: ${name}`, (t) => {
    const f = fixture(t);
    const path = join(f.root, `node_modules/${name}/package.json`);
    writeFileSync(path, JSON.stringify({ name, version: '99.0.0' }));
    sealSyntheticBuild(f.root);
    assert.equal(observeRuntimeBuild(f.root), null);
  });

for (const name of ['@iarna/toml', 'chokidar', 'readdirp'])
  for (const change of ['name', 'main', 'type', 'exports'])
    test(`fixed dependency resolution refuses ${name} ${change}`, (t) => {
      const f = fixture(t);
      const path = join(f.root, `node_modules/${name}/package.json`);
      const pkg = JSON.parse(readFileSync(path, 'utf8'));
      pkg[change] = change === 'exports' ? { '.': '../outside.js' } : 'SIMULATED-wrong';
      writeFileSync(path, JSON.stringify(pkg));
      sealSyntheticBuild(f.root);
      assert.equal(observeRuntimeBuild(f.root), null);
    });
for (const relative of [
  'node_modules/fourth/index.js',
  'packages/hud-mcp/node_modules/@iarna/toml/toml.js',
  'node_modules/chokidar/node_modules/readdirp/index.js',
])
  test(`unexpected or nested dependency path refuses: ${relative}`, (t) => {
    const f = fixture(t);
    const path = join(f.root, relative);
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o700 });
    writeFileSync(path, 'SIMULATED not executed', { mode: 0o600 });
    sealSyntheticBuild(f.root);
    assert.equal(observeRuntimeBuild(f.root), null);
  });
test('missing local entrypoint cannot borrow a same-name ancestor dependency', (t) => {
  const outer = fixture(t);
  const inner = join(outer.root, 'nested-runtime');
  syntheticBuild(inner);
  rmSync(join(inner, 'node_modules/@iarna/toml/toml.js'));
  sealSyntheticBuild(inner);
  assert.equal(observeRuntimeBuild(inner), null);
});
