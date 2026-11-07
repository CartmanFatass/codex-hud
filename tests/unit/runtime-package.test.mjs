import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, rewriteManifest } from '../../scripts/runtime-package/test-fixture.mjs';
import {
  verifyBundle,
  parseManifest,
  HELPERS,
  DEPENDENCIES,
  REQUIRED,
} from '../../scripts/runtime-package/manifest.mjs';
import { validateLock, validateInstalledClosure } from '../../scripts/pack-runtime.mjs';
import { selectedOutputs, EXTRA_FILES } from '../../scripts/pack-cloud-preview.mjs';
import { json, Directory, MAX_FILE, MAX_ENTRIES } from '../../scripts/runtime-package/safety.mjs';

test('manifest validates complete bounded payload and exact locked production identities', (t) => {
  const f = fixture(t);
  const bundle = verifyBundle(f.bundle);
  bundle.directory.close();
  const lock = JSON.parse(fs.readFileSync(new URL('../../package-lock.json', import.meta.url)));
  assert.deepEqual(validateLock(lock), DEPENDENCIES);
  assert.ok(DEPENDENCIES['@anthropic-ai/claude-agent-sdk']);
  assert.equal(DEPENDENCIES['@earendil-works/pi-coding-agent'], undefined);
  lock.packages['node_modules/foreign'] = { version: '1' };
  assert.throws(() => validateLock(lock), /closure/);
  assert.ok(HELPERS.includes('bin/codex-with-herdr-context'));
});
test('Jev Python asset is explicitly selected for preview and runtime bundles', () => {
  assert.ok(EXTRA_FILES.includes('src/managed/jev-bridge.py'));
  assert.ok(REQUIRED.includes('src/managed/jev-bridge.py'));
  assert.ok(EXTRA_FILES.includes('src/jev/snapshot.js'));
  assert.ok(REQUIRED.includes('src/jev/snapshot.js'));
  assert.ok(EXTRA_FILES.includes('THIRD_PARTY_NOTICES.md'));
  assert.ok(REQUIRED.includes('THIRD_PARTY_NOTICES.md'));
});
test('spawned native host entry is packed when the mcp build emits it', () => {
  const source = 'src/managed/host-entry.ts';
  const mcpOutput = 'packages/hud-mcp/dist/src/managed/host-entry.js';
  const generated = 'mcp/src/managed/host-entry.js';
  assert.deepEqual(
    selectedOutputs([source], () => false).map((entry) => entry.output),
    ['dist/managed/host-entry.js']
  );
  assert.deepEqual(
    selectedOutputs([source], (file) => file === generated).map((entry) => entry.output),
    ['dist/managed/host-entry.js', mcpOutput]
  );
  assert.ok(REQUIRED.includes(mcpOutput));
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
  assert.deepEqual(
    selectedOutputs([source], () => false),
    [main]
  );
  assert.deepEqual(
    selectedOutputs([source], (file) => file === mcp.generatedPath),
    [main, mcp]
  );
  assert.deepEqual(
    selectedOutputs([source], (file) => file === 'mcp/src/unrelated.js'),
    [main]
  );
});
for (const name of [
  'bin/hud',
  'bin/codex-with-herdr-context',
  'node_modules/chokidar/package.json',
  'src/managed/jev-bridge.py',
  'src/jev/snapshot.js',
  'THIRD_PARTY_NOTICES.md',
]) {
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
  fs.writeFileSync(path.join(f.bundle, 'huge'), Buffer.alloc(MAX_FILE + 1));
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
    dependencies: { ...DEPENDENCIES },
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
  assert.throws(() => parseManifest(Buffer.alloc(MAX_FILE + 1)), /manifest_byte_limit/);
});
test('annotation aggregate and payload total are independently bounded', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 650; i++)
    f.manifest.entries.push({
      ...f.manifest.entries[0],
      path: `extra-${i}`,
      origin: 'x'.repeat(1024),
      provenance: 'x'.repeat(4096),
    });
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
test('exactly MAX_ENTRIES payload files plus manifest is valid; one extra is rejected', (t) => {
  const f = fixture(t);
  while (f.manifest.entries.length < MAX_ENTRIES) {
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
  fs.ftruncateSync(fd, MAX_FILE + 1);
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

test('F4 digest exact source output mapping', () => {
  const sources = [
    'src/cli/digest.ts',
    'src/core/delegated-report-read.ts',
    'src/core/materials/source-config.ts',
    'src/core/materials/delegated-digest.ts',
  ];
  const ordinary = selectedOutputs(sources, () => false);
  assert.deepEqual(
    ordinary.map((entry) => entry.output),
    sources.map((file) => `dist/${file.slice(4, -3)}.js`)
  );
  const actualMcp = 'mcp/src/core/materials/source-config.js';
  const withMcp = selectedOutputs(sources, (file) => file === actualMcp);
  assert.deepEqual(
    withMcp.filter((entry) => entry.generatedPath.startsWith('mcp/')).map((entry) => entry.generatedPath),
    [actualMcp]
  );
  assert.equal(withMcp.length, ordinary.length + 1);
});

test('declared SDK library stays required; client executables are not HUD runtime dependencies', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url)));
  const lock = JSON.parse(fs.readFileSync(new URL('../../package-lock.json', import.meta.url)));
  assert.equal(
    manifest.dependencies['@anthropic-ai/claude-agent-sdk'],
    lock.packages[''].dependencies['@anthropic-ai/claude-agent-sdk']
  );
  assert.equal(manifest.dependencies['@earendil-works/pi-coding-agent'], undefined);
  assert.ok(!Object.keys(lock.packages).some((name) => name.includes('@earendil-works/pi-coding-agent')));
  for (const mutate of [
    (l) => {
      l.packages['node_modules/@anthropic-ai/claude-agent-sdk'].version = '0.0.0';
    },
    (l) => {
      l.packages['node_modules/@anthropic-ai/claude-agent-sdk'].peerDependencies.zod = '*';
    },
    (l) => {
      l.packages['node_modules/@anthropic-ai/claude-agent-sdk-linux-x64'].integrity = 'sha512-AAAA';
    },
    (l) => {
      l.packages['node_modules/chokidar'].hasInstallScript = true;
    },
    (l) => {
      delete l.packages['node_modules/express/node_modules/content-type'];
    },
  ]) {
    const changed = structuredClone(lock);
    mutate(changed);
    assert.throws(() => validateLock(changed), /unreviewed/);
  }
});

test('installed closure rejects extra packages, client bundles, and identity drift including nested dependencies', (t) => {
  const f = fixture(t);
  const modules = path.join(f.bundle, 'node_modules');
  validateInstalledClosure(modules);
  fs.mkdirSync(path.join(modules, 'foreign'));
  assert.throws(() => validateInstalledClosure(modules), /unexpected_dependency_tree/);
  fs.rmdirSync(path.join(modules, 'foreign'));
  fs.mkdirSync(path.join(modules, '@anthropic-ai', 'claude-agent-sdk-linux-x64'));
  assert.throws(() => validateInstalledClosure(modules), /unexpected_scope_tree/);
  fs.rmdirSync(path.join(modules, '@anthropic-ai', 'claude-agent-sdk-linux-x64'));
  const nested = path.join(modules, 'express/node_modules/content-type/package.json');
  fs.writeFileSync(nested, JSON.stringify({ name: 'content-type', version: '0.0.0' }));
  assert.throws(() => validateInstalledClosure(modules), /dependency_identity_mismatch/);
});

test('actual SDK imports and selects explicit simulated user executable without bundled clients', (t) => {
  const f = fixture(t);
  const root = new URL('../../', import.meta.url);
  const isolated = path.join(f.root, 'sdk-import');
  fs.mkdirSync(isolated);
  for (const location of Object.keys(DEPENDENCIES)) {
    const source = new URL(`node_modules/${location}/`, root);
    if (!fs.existsSync(source)) {
      t.skip(`Installed development dependency unavailable: ${location}`);
      return;
    }
    const target = path.join(isolated, 'node_modules', location);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, {
      recursive: true,
      filter: (name) => !name.slice(source.pathname.length).split(path.sep).includes('node_modules'),
    });
  }
  validateInstalledClosure(path.join(isolated, 'node_modules'));
  const fake = path.join(isolated, 'user-claude.mjs');
  const receipt = path.join(isolated, 'executable-receipt.json');
  fs.writeFileSync(
    fake,
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv)); process.exit(42);\n`,
    { mode: 0o700 }
  );
  fs.writeFileSync(
    path.join(isolated, 'check.mjs'),
    `import {query} from '@anthropic-ai/claude-agent-sdk';
     if (typeof query !== 'function') throw new Error('query unavailable');
     const stream = query({prompt:'synthetic packaging probe', options:{pathToClaudeCodeExecutable:${JSON.stringify(fake)}, cwd:${JSON.stringify(isolated)}, settingSources:[], env:process.env}});
     try { for await (const message of stream) {} } catch (error) { console.log('Simulated client exit:', error.message); } finally { stream.close(); }
     console.log('SDK import OK');\n`
  );
  const result = spawnSync(process.execPath, [path.join(isolated, 'check.mjs')], {
    cwd: isolated,
    env: f.env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SDK import OK/);
  assert.ok(fs.existsSync(receipt), result.stdout);
  assert.equal(JSON.parse(fs.readFileSync(receipt))[1], fake);
});

test('Pi wake entrypoint loads from a relocated package without any src tree', async (t) => {
  const { transpileModule, ModuleKind, ScriptTarget } = await import('typescript');
  const { REQUIRED } = await import('../../scripts/runtime-package/manifest.mjs');
  const f = fixture(t);
  const root = new URL('../../', import.meta.url);
  const destination = path.join(f.root, 'relocated');
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({ type: 'module' }));
  const entry = 'integrations/pi/hud-wake.ts';
  assert.ok(EXTRA_FILES.includes(entry));
  assert.ok(REQUIRED.includes(entry));
  for (const source of ['src/harness/pi/wake-extension.ts', 'src/managed/wake-message.ts']) {
    const [mapping] = selectedOutputs([source], () => false);
    assert.ok(mapping);
    assert.ok(REQUIRED.includes(mapping.output));
    const compiled = transpileModule(fs.readFileSync(new URL(source, root), 'utf8'), {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
      fileName: source,
    }).outputText;
    const target = path.join(destination, mapping.output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, compiled);
  }
  fs.mkdirSync(path.join(destination, 'integrations/pi'), { recursive: true });
  fs.copyFileSync(new URL(entry, root), path.join(destination, entry));
  assert.equal(fs.existsSync(path.join(destination, 'src')), false);
  fs.writeFileSync(
    path.join(destination, 'probe.mjs'),
    `
    import assert from 'node:assert/strict';
    import wake from './integrations/pi/hud-wake.ts';
    import { nativeWakeMessage } from './dist/managed/wake-message.js';
    import { validWakeRequest, deliverPiWake } from './dist/harness/pi/wake-extension.js';
    const handlers = new Map();
    const messages = [];
    const api = {on:(event,handler)=>handlers.set(event,handler),sendMessage:(...args)=>messages.push(args)};
    wake(api);
    assert.equal(typeof handlers.get('session_start'), 'function');
    assert.equal(typeof handlers.get('session_shutdown'), 'function');
    const details = {connectionId:'connection-a',nativeRef:{harness:'codex',threadId:'thread-a'},eventSeq:1,kind:'result'};
    const request = {parentSessionId:'parent-a',content:nativeWakeMessage(details),details,command:'read native session'};
    assert.equal(validWakeRequest(request),true);
    assert.equal(deliverPiWake(api,request,'parent-a',{sessionManager:{getSessionId:()=> 'parent-a'}}).result,'accepted');
    assert.deepEqual(messages[0][1],{triggerTurn:true,deliverAs:'followUp'});
    await handlers.get('session_shutdown')();
    console.log('relocated Pi wake OK');
  `
  );
  const result = spawnSync(process.execPath, ['--experimental-strip-types', path.join(destination, 'probe.mjs')], {
    cwd: f.cwd,
    env: f.env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /relocated Pi wake OK/);
});
