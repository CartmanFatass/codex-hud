/** HISTORICAL legacy-runtime qualification tests, not native-default admission,
 * a distributable or a provider smoke. Current native entry is covered by
 * tests/hud-mcp/managed-native-isolation.test.ts and managed-core.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CELLS, DEPENDENCIES } from '../../scripts/runtime-package/manifest.mjs';
import {
  SOURCE,
  createContext,
  finish,
  compile,
  bundle,
  cloneBundle,
  seal,
  cells,
  installerIntegrity,
  install,
  launch,
  run,
  write,
  json,
  sha256,
  alive,
} from '../fixtures/runtime-compose.mjs';

const selected = (prefix) => JSON.parse(fs.readFileSync(path.join(prefix, 'current'), 'utf8'));
function privatePrefix(context, name) {
  const prefix = path.join(context.root, `${name} private space ';$() prefix`);
  fs.mkdirSync(prefix, { mode: 0o700 });
  return prefix;
}
function joint(result, context, native, prefix, accepted) {
  assert.equal(result.status, 0, result.stderr);
  const value = result.value;
  const release = path.join(prefix, 'releases', selected(prefix).manifestDigest);
  assert.equal(value.wrapper, path.join(release, 'packages/hud-mcp/bin/hud-mcp.mjs'));
  assert.equal(value.module, path.join(release, 'packages/hud-mcp/dist/packages/hud-mcp/src/managed-runtime.js'));
  assert.deepEqual(value.argv, [value.wrapper, 'literal space', "';$()", '']);
  assert.equal(value.stdin, 'literal stdin\n');
  assert.equal(value.descriptor, 'literal descriptor\n');
  assert.equal(value.cwd, context.cwd);
  assert.equal(value.physical.ppid, result.receipt.pid);
  assert.equal(value.physical.parentStart, result.receipt.identity.start);
  assert.equal(value.physical.registrationParent, result.receipt.pid);
  assert.equal(value.physical.harnessPid, result.receipt.pid);
  assert.equal(value.physical.registrationPid, value.physical.pid);
  assert.equal(value.physical.sameNamespace, true);
  assert.equal(value.physical.sourceMatches, true);
  assert.ok(!alive({ pid: value.physical.pid, start: value.physical.start }));
  assert.equal(value.startup.parentObserved, true);
  assert.equal(value.startup.bootstrapObserved, true);
  assert.ok(value.startup.buildId);
  assert.equal(value.startup.probes, 2);
  assert.equal(result.probes.length, 2);
  assert.ok(result.probes.every((p) => p.version === '0.166.0'));
  assert.equal(value.probeEnvironmentScrubbed, true);
  for (const result of value.verification)
    assert.deepEqual(result, accepted ? { ok: true, reason: null } : { ok: false, reason: 'capability_unverified' });
  assert.equal(installerIntegrity(release).ok, true);
  assert.equal(context.runtime.observeRuntimeBuild(release)?.buildId, value.startup.buildId);
  context.checks.push({ name: accepted ? 'joint-accepted-SIMULATED-cells' : 'joint-empty-cells', value });
  return value;
}

test('HISTORICAL SIMULATED installed legacy qualification: installer, direct parent and bounded negative matrix', async (t) => {
  const context = await createContext('runtime-compose');
  const generated = await import('../../dist/core/runtime-dependencies.js');
  assert.deepEqual(generated.DEPENDENCIES, DEPENDENCIES, 'both library metadata targets must match');
  t.after(() => finish(context));
  const native = await compile(context);
  const oldNative = await compile(context, '0.165.0');
  const compiler = await run(context, 'compiler-version', '/usr/bin/cc', ['--version']);
  assert.equal(compiler.status, 0);
  const a = bundle(context, 'A');
  const aDigest = installerIntegrity(a).digest;
  const prefix = privatePrefix(context, 'joint');
  let aValue, b, bValue, appliedB, initialSelection;
  await t.test('A: common manifest and installed direct-parent path refuse empty capabilities', async () => {
    assert.equal(installerIntegrity(a).ok, true);
    assert.ok(context.runtime.observeRuntimeBuild(a));
    await install(context, a, prefix);
    initialSelection = selected(prefix);
    const result = await launch(context, native, prefix);
    aValue = joint(result, context, native, prefix, false);
    assert.ok(aValue.expected.every(Boolean));
  });
  assert.ok(aValue, 'stop matrix if initial joint path fails');
  await t.test('B: only excluded cells change full manifest digest; exact simulated spawn/resume match', async () => {
    b = cloneBundle(context, a, 'B');
    const bDigest = cells(b, aValue.expected);
    assert.notEqual(bDigest, aDigest);
    assert.equal(context.runtime.observeRuntimeBuild(b)?.buildId, aValue.startup.buildId);
    appliedB = await install(context, b, prefix);
    const result = await launch(context, native, prefix, { exactMatchNegatives: true });
    bValue = joint(result, context, native, prefix, true);
    assert.equal(bValue.negative.length, 26);
    assert.deepEqual(
      fs.readFileSync(path.join(a, 'packages/hud-mcp/bin/hud-mcp.mjs')),
      fs.readFileSync(path.join(SOURCE, 'packages/hud-mcp/bin/hud-mcp.mjs'))
    );
  });
  assert.ok(bValue, 'stop matrix if accepted joint path fails');
  await t.test('A restore uses fresh generation; no-op preserves it; stale receipts and plans refuse', async () => {
    const stalePreview = await run(context, 'old-plan-preview', process.execPath, [
      path.join(b, 'install-runtime.mjs'),
      'preview',
      '--prefix',
      prefix,
    ]);
    const plan = JSON.parse(stalePreview.stdout);
    const before = selected(prefix);
    await install(context, b, prefix, appliedB.result.receipt);
    const after = selected(prefix);
    assert.equal(after.manifestDigest, initialSelection.manifestDigest);
    assert.notEqual(after.generation, initialSelection.generation);
    assert.notEqual(after.generation, before.generation);
    joint(await launch(context, native, prefix), context, native, prefix, false);
    const noOp = await install(context, a, prefix);
    assert.equal(noOp.result.status, 'NO_OP');
    assert.deepEqual(selected(prefix), after);
    const staleReceipt = await run(context, 'stale-receipt', process.execPath, [
      path.join(b, 'install-runtime.mjs'),
      'preview',
      '--prefix',
      prefix,
      '--restore-receipt',
      appliedB.result.receipt,
    ]);
    assert.notEqual(staleReceipt.status, 0);
    assert.match(staleReceipt.stderr, /stale_or_foreign_receipt/);
    const stalePlan = await run(context, 'stale-plan', process.execPath, [
      path.join(b, 'install-runtime.mjs'),
      'apply',
      '--prefix',
      prefix,
      '--expect',
      plan.planDigest,
    ]);
    assert.notEqual(stalePlan.status, 0);
    assert.match(stalePlan.stderr, /plan/);
    assert.deepEqual(selected(prefix), after);
  });

  await t.test('reviewed nested library is accepted; bundled clients and unknown nested packages are refused', () => {
    assert.ok(fs.existsSync(path.join(b, 'node_modules/express/node_modules/content-type/package.json')));
    assert.ok(context.runtime.observeRuntimeBuild(b));
    for (const name of ['@anthropic-ai/claude-agent-sdk-linux-x64', 'express/node_modules/foreign']) {
      const candidate = cloneBundle(context, b, name.replaceAll('/', '-'));
      write(path.join(candidate, 'node_modules', name, 'package.json'), json({ name, version: '1.0.0' }));
      seal(candidate);
      assert.equal(context.runtime.observeRuntimeBuild(candidate), null);
    }
    const wrong = cloneBundle(context, b, 'wrong-nested-library');
    write(
      path.join(wrong, 'node_modules/express/node_modules/content-type/package.json'),
      json({ name: 'content-type', version: '0.0.0' })
    );
    seal(wrong);
    assert.equal(context.runtime.observeRuntimeBuild(wrong), null);
  });
  const manifestCases = {
    dirty: {
      mutate: (r) =>
        seal(r, (m) => {
          m.dirty = true;
        }),
      installer: true,
    },
    'wrong-MCP-name': {
      mutate: (r) => {
        write(path.join(r, 'packages/hud-mcp/package.json'), json({ name: 'wrong', type: 'module' }));
        seal(r);
      },
      installer: true,
    },
    'missing-managed-anchor': {
      mutate: (r) => {
        fs.unlinkSync(path.join(r, 'dist/core/run/control.js'));
        seal(r);
      },
      installer: true,
    },
    'wrong-dependency-resolution': {
      mutate: (r) => {
        write(
          path.join(r, 'node_modules/chokidar/package.json'),
          json({ name: 'chokidar', version: '5.0.0', main: './wrong.js' })
        );
        seal(r);
      },
      installer: true,
    },
    'payload-hash': { mutate: (r) => fs.appendFileSync(path.join(r, 'dist/index.js'), 'changed'), installer: false },
    'payload-mode': { mutate: (r) => fs.chmodSync(path.join(r, 'dist/index.js'), 0o700), installer: false },
    'unlisted-file': { mutate: (r) => write(path.join(r, 'extra.js'), 'SIMULATED'), installer: false },
    'missing-file': { mutate: (r) => fs.unlinkSync(path.join(r, 'dist/index.js')), installer: false },
    ...Object.fromEntries(
      CELLS.map((name, index) => [
        `malformed-cell-${index}`,
        {
          mutate: (r) => {
            write(path.join(r, name), '{');
            seal(r);
          },
          installer: true,
        },
      ])
    ),
    'duplicate-members': {
      mutate: (r) => {
        write(path.join(r, CELLS[3]), '{"version":1,"version":1,"hudRevision":null,"cells":[]}');
        seal(r);
      },
      installer: true,
    },
    'malformed-sibling': {
      mutate: (r) => {
        const file = path.join(r, CELLS[3]);
        const value = JSON.parse(fs.readFileSync(file));
        value.cells.push({ key: 'invalid' });
        write(file, json(value));
        seal(r);
      },
      installer: true,
    },
  };
  for (const [name, item] of Object.entries(manifestCases)) {
    await t.test(`manifest boundary: ${name}`, async () => {
      const candidate = cloneBundle(context, b, name);
      item.mutate(candidate);
      const installer = installerIntegrity(candidate);
      assert.equal(installer.ok, item.installer);
      assert.equal(context.runtime.observeRuntimeBuild(candidate), null);
      context.checks.push({ name, installer, managed: null });
      if (name === 'dirty') {
        const dirtyPrefix = privatePrefix(context, 'dirty');
        await install(context, candidate, dirtyPrefix);
        const result = await launch(context, native, dirtyPrefix);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.value.startup.buildId, null);
        assert.equal(result.value.startup.parentObserved, true);
        assert.ok(result.value.verification.every((v) => !v.ok));
      }
    });
  }
  await t.test('other three cell files cannot replace fixed MCP managed-cell file', async () => {
    const candidate = cloneBundle(context, b, 'other-cells');
    write(path.join(candidate, CELLS[3]), json({ version: 1, hudRevision: null, cells: [] }));
    seal(candidate);
    const p = privatePrefix(context, 'other-cells');
    await install(context, candidate, p);
    joint(await launch(context, native, p), context, native, p, false);
  });
  await t.test('resealed ordinary payload mutation changes build ID and invalidates old cell', async () => {
    const candidate = cloneBundle(context, b, 'ordinary-payload');
    fs.appendFileSync(path.join(candidate, 'dist/index.js'), '// ordinary-byte-change\n');
    seal(candidate);
    const observed = context.runtime.observeRuntimeBuild(candidate);
    assert.ok(observed);
    assert.notEqual(observed.buildId, bValue.startup.buildId);
    const p = privatePrefix(context, 'ordinary-payload');
    await install(context, candidate, p);
    const value = joint(await launch(context, native, p), context, native, p, false);
    assert.equal(value.startup.buildId, observed.buildId);
  });
  await t.test('source-shaped module cannot gain installed status via env, input fields or manifest path', async () => {
    const driver = path.join(context.emitted, 'packages/hud-mcp/src/main.js');
    write(driver, fs.readFileSync(path.join(SOURCE, 'tests/fixtures/runtime-compose-main.mjs')));
    const result = await launch(context, native, prefix, {
      driver,
      fakeRoot: b,
      fakeManifest: path.join(b, 'RUNTIME-MANIFEST.json'),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.value.startup.buildId, null);
    assert.equal(result.value.startup.parentObserved, true);
    assert.ok(result.value.expected.every((v) => v === null));
  });
  await t.test('physical Node proxy cannot borrow native grandparent authority', async () => {
    const proxy = path.join(context.root, 'proxy.mjs');
    const proxyReceipt = path.join(context.root, 'proxy.json');
    write(
      proxy,
      `import { spawn } from 'node:child_process';\nimport { readFileSync,writeFileSync } from 'node:fs';\nconst stat=readFileSync('/proc/self/stat','utf8');writeFileSync(${JSON.stringify(proxyReceipt)},JSON.stringify({pid:process.pid,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]}));\nconst child=spawn(process.execPath,[${JSON.stringify(path.join(prefix, 'bin/hud-mcp'))},...process.argv.slice(2)],{stdio:['inherit','inherit','inherit',3],env:process.env});\nprocess.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('error',()=>{process.exitCode=1});child.on('close',(code)=>{process.exitCode=code??1});\n`
    );
    const result = await launch(context, native, prefix, { driver: proxy });
    assert.equal(result.status, 0, result.stderr);
    const identity = JSON.parse(fs.readFileSync(proxyReceipt));
    assert.equal(result.value.physical.ppid, identity.pid);
    assert.equal(result.value.physical.parentStart, identity.start);
    assert.equal(result.value.physical.harnessPid, result.receipt.pid);
    assert.notEqual(result.value.physical.ppid, result.receipt.pid);
    assert.equal(result.value.startup.parentObserved, false);
    assert.ok(result.value.verification.every((v) => !v.ok));
    assert.ok(!alive(identity));
    context.checks.push({ name: 'owned-proxy', identity, ended: true });
  });
  for (const [name, parent, extra] of [
    ['parent-version', oldNative, { target: native }],
    ['target-version', native, { target: oldNative }],
    ['wrong-selected-profile', native, { wrongSelected: 'profile' }],
    ['wrong-selected-source', native, { wrongSelected: 'source' }],
    ['missing-executable', native, { target: path.join(context.root, 'missing') }],
    ['script-executable', native, { target: path.join(context.root, 'script-codex') }],
  ]) {
    await t.test(`identity boundary: ${name}`, async () => {
      if (name === 'script-executable') write(extra.target, '#!/bin/sh\necho codex-cli 0.166.0\n', 0o700);
      const result = await launch(context, parent, prefix, extra);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.value.verification.every((v) => !v.ok));
      assert.ok(result.value.expected.every((v) => v === null));
      if (['parent-version', 'wrong-selected-profile', 'wrong-selected-source'].includes(name))
        assert.equal(result.value.startup.parentObserved, false);
      else assert.equal(result.value.startup.parentObserved, true);
      if (name === 'parent-version')
        assert.deepEqual(
          result.probes.map((p) => p.version),
          ['0.165.0', '0.166.0']
        );
      if (name === 'target-version')
        assert.deepEqual(
          result.probes.map((p) => p.version),
          ['0.166.0', '0.165.0']
        );
      if (['missing-executable', 'script-executable'].includes(name)) assert.equal(result.probes.length, 1);
      context.checks.push({ name, startup: result.value.startup, verification: result.value.verification });
    });
  }
  for (const name of ['selector', 'module-marker']) {
    await t.test(`broken ${name} prevents synthetic-main execution`, async () => {
      const p = privatePrefix(context, name);
      await install(context, a, p);
      write(path.join(p, name === 'selector' ? 'current' : 'bin/package.json'), '{}\n');
      const result = await launch(context, native, p);
      assert.notEqual(result.status, 0);
      assert.equal(fs.existsSync(result.marker), false);
      context.checks.push({ name, stderr: result.stderr, payloadStarted: false });
    });
  }
  await t.test('bounded regression entrypoint refuses unknown arguments', async () => {
    const result = await run(context, 'unknown-regression-option', process.execPath, [
      path.join(SOURCE, 'tests/fixtures/runtime-compose.mjs'),
      '--unknown',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /only --check-runtime-build/);
  });
  await t.test('production source capability files are unchanged and empty', () => {
    for (const name of ['codex-cells.json', 'managed-cells.json']) {
      const raw = fs.readFileSync(path.join(SOURCE, 'src/core/launch', name));
      assert.deepEqual(JSON.parse(raw).cells, []);
      context.checks.push({ name, sha256: sha256(raw), cells: 0 });
    }
  });
});
