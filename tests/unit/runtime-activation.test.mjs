import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fixture, replaceFixtureFile } from '../../scripts/runtime-package/test-fixture.mjs';
import { planInstall, executeInstall } from '../../scripts/runtime-package/installer.mjs';
import { digest } from '../../scripts/runtime-package/safety.mjs';
import { ACTIVATION_PROCESS_FILES } from '../../scripts/runtime-package/manifest.mjs';
const activation = await import(process.env.R6A_ACTIVATION_MODULE ?? '../../scripts/runtime-package/activation.mjs');
const { planActivation, applyActivation, restoreActivation, planDeactivation } = activation;
function setup(t, label = 'A', prepare) {
  const f = fixture(t, label);
  prepare?.(f);
  const stage = planInstall(f.bundle, f.prefix, undefined, false, true);
  const installed = executeInstall(f.bundle, f.prefix, stage.planDigest, undefined, { stageOnly: true });
  assert.equal(installed.status, 'STAGED');
  const options = {
    prefix: f.prefix,
    release: stage.bundleDigest,
    hudHome: path.join(f.home, 'hud home'),
    shimDir: path.join(f.home, 'local bin'),
    path: '/usr/bin',
  };
  return { ...f, options };
}
function tree(root, excludeMetadata = false) {
  const result = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (excludeMetadata && name === 'installation') continue;
      const stat = fs.lstatSync(file);
      result.push([
        path.relative(root, file),
        stat.mode & 0o7777,
        stat.isFile() ? digest(fs.readFileSync(file)) : stat.isSymbolicLink() ? fs.readlinkSync(file) : 'directory',
      ]);
      if (stat.isDirectory()) walk(file);
    }
  }
  walk(root);
  return result;
}
function apply(f, hooks) {
  const p = planActivation(f.options);
  return applyActivation(f.options, p.planId, hooks);
}

test('activation preview is read-only and deterministic; wrong/stale plan and changed target refused', (t) => {
  const f = setup(t);
  const before = tree(f.home);
  const p = planActivation(f.options);
  assert.deepEqual(planActivation(f.options), p);
  assert.deepEqual(tree(f.home), before);
  assert.throws(() => applyActivation(f.options, '0'.repeat(64)), /stale_plan/);
  fs.mkdirSync(f.options.shimDir, { mode: 0o700 });
  assert.throws(() => applyActivation(f.options, p.planId), /stale_plan/);
  assert.equal(fs.existsSync(f.options.hudHome), false);
});
test('bootstrap and compiled hud CLI preview/apply/uninstall require exact plan IDs without prompts', (t) => {
  const f = setup(t);
  const bootstrap = path.resolve('scripts/activate-runtime.mjs');
  const hud = path.resolve('bin/hud');
  const flags = [
    '--prefix',
    f.prefix,
    '--release',
    f.options.release,
    '--hud-home',
    f.options.hudHome,
    '--shim-dir',
    f.options.shimDir,
  ];
  function run(entry, args) {
    return spawnSync(process.execPath, [entry, ...args], { env: f.env, cwd: f.home, encoding: 'utf8', timeout: 15000 });
  }
  const before = tree(f.home);
  const preview = run(bootstrap, ['install', 'preview', ...flags]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(tree(f.home), before);
  const p = JSON.parse(preview.stdout);
  const wrong = run(hud, ['install', 'apply', '--plan', '0'.repeat(64), ...flags]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /stale_plan/);
  const applied = run(hud, ['install', 'apply', '--plan', p.planId, ...flags]);
  assert.equal(applied.status, 0, applied.stderr);
  const receipt = JSON.parse(applied.stdout).receipt;
  const uninstall = run(hud, ['uninstall', 'preview', '--receipt', receipt]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  const removed = run(bootstrap, [
    'uninstall',
    'apply',
    '--plan',
    JSON.parse(uninstall.stdout).planId,
    '--receipt',
    receipt,
  ]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout).status, 'deactivated; release retained');
  assert.equal(fs.existsSync(f.options.shimDir), false);
});
test('only the three public names are published and restore exact prior entries', (t) => {
  const f = setup(t);
  fs.mkdirSync(f.options.shimDir, { mode: 0o755 });
  fs.writeFileSync(path.join(f.options.shimDir, 'cx'), 'untouched legacy', { mode: 0o700 });
  const before = tree(f.options.shimDir);
  const r = apply(f);
  assert.deepEqual(fs.readdirSync(f.options.shimDir).sort(), ['cx', 'hud', 'hud-mcp', 'hud-statusline']);
  assert.equal(restoreActivation(r.receipt).status, 'deactivated; release retained');
  assert.deepEqual(tree(f.options.shimDir), before);
  assert.deepEqual(fs.readdirSync(f.options.hudHome), ['installation']);
});
test('public shims supply default HUD_HOME, respect inherited override and restrict roles env to MCP', (t) => {
  const f = setup(t, 'env', (f) => {
    for (const name of ['bin/hud', 'packages/hud-mcp/bin/hud-mcp.mjs'])
      replaceFixtureFile(
        f,
        name,
        'console.log(JSON.stringify({home:process.env.HUD_HOME,surface:process.env.HUD_MCP_SURFACE}));\n'
      );
  });
  apply(f);
  for (const home of [undefined, path.join(f.home, 'explicit other HUD')]) {
    for (const command of ['hud', 'hud-mcp']) {
      const env = { PATH: f.env.PATH, HOME: f.home, ...(home ? { HUD_HOME: home } : {}) };
      const result = spawnSync(process.execPath, [path.join(f.options.shimDir, command)], {
        env,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        home: home ?? f.options.hudHome,
        ...(command === 'hud-mcp' ? { surface: 'roles' } : {}),
      });
    }
  }
});
test('foreign hud collision is refused before HUD home creation', (t) => {
  const f = setup(t);
  fs.mkdirSync(f.options.shimDir, { mode: 0o700 });
  fs.writeFileSync(path.join(f.options.shimDir, 'hud'), 'foreign', { mode: 0o700 });
  assert.throws(() => planActivation(f.options), /foreign_public_shim/);
  assert.equal(fs.existsSync(f.options.hudHome), false);
});
test('symlinked target and ancestor are refused, never followed', (t) => {
  const f = setup(t);
  const destination = path.join(f.home, 'real hud');
  fs.mkdirSync(destination, { mode: 0o700 });
  fs.symlinkSync(destination, f.options.hudHome);
  assert.throws(() => planActivation(f.options), /symlink_target_refused/);
  assert.deepEqual(fs.readdirSync(destination), []);
  fs.unlinkSync(f.options.hudHome);
  fs.symlinkSync(destination, f.options.shimDir);
  assert.throws(() => planActivation(f.options), /symlink_target_refused/);
});
test('post-preview recheck under competing runtime lock refuses cleanly', (t) => {
  const f = setup(t);
  const p = planActivation(f.options);
  assert.throws(
    () =>
      applyActivation(f.options, p.planId, {
        checkpoint(phase) {
          if (
            phase === 'before' &&
            fs.existsSync(f.options.shimDir) &&
            !fs.existsSync(path.join(f.options.shimDir, 'hud'))
          ) {
            fs.writeFileSync(path.join(f.options.shimDir, 'hud'), 'raced', { mode: 0o700 });
          }
        },
      }),
    /activation_conflict/
  );
  assert.equal(fs.readFileSync(path.join(f.options.shimDir, 'hud'), 'utf8'), 'raced');
});
test('PATH defaults to no rc mutation; opted block preserves legacy markers and restores exact bytes/mode', (t) => {
  const f = setup(t);
  const rc = path.join(f.home, '.bashrc');
  const legacy = '# >>> codex-hud >>>\necho legacy\n# <<< codex-hud <<<\n';
  fs.writeFileSync(rc, legacy, { mode: 0o640 });
  assert.ok(!planActivation(f.options).actions.some((a) => a.kind === 'rc-block'));
  f.options.rcFile = rc;
  f.options.path = f.options.shimDir + ':/usr/bin';
  assert.ok(!planActivation(f.options).actions.some((a) => a.kind === 'rc-block'));
  f.options.path = '/usr/bin';
  const r = apply(f);
  const content = fs.readFileSync(rc, 'utf8');
  assert.equal(content.split('# >>> universal-hud PATH >>>').length, 2);
  assert.ok(content.startsWith(legacy));
  restoreActivation(r.receipt);
  assert.equal(fs.readFileSync(rc, 'utf8'), legacy);
  assert.equal(fs.statSync(rc).mode & 0o777, 0o640);
});
test('rc restore removes only the owned block and preserves unrelated later edits', (t) => {
  const f = setup(t);
  f.options.rcFile = path.join(f.home, '.bashrc');
  fs.writeFileSync(f.options.rcFile, 'original\n', { mode: 0o640 });
  const r = apply(f);
  fs.appendFileSync(f.options.rcFile, 'later unrelated edit\n');
  assert.equal(restoreActivation(r.receipt).status, 'deactivated; release retained');
  assert.equal(fs.readFileSync(f.options.rcFile, 'utf8'), 'original\nlater unrelated edit\n');
});
test('hand edited rc block or installed shim is a conflict, never overwritten', (t) => {
  const f = setup(t);
  f.options.rcFile = path.join(f.home, '.profile');
  const r = apply(f);
  fs.writeFileSync(
    f.options.rcFile,
    fs.readFileSync(f.options.rcFile, 'utf8').replace('export PATH=', 'export HAND_EDITED_PATH=')
  );
  assert.equal(restoreActivation(r.receipt).status, 'CONFLICT');
  assert.match(fs.readFileSync(f.options.rcFile, 'utf8'), /HAND_EDITED/);
  assert.equal(planDeactivation(r.receipt).conflicts[0].path, f.options.rcFile);
});
test('HUD credentials/config/routing and user-created keys/history/results survive uninstall', (t) => {
  const f = setup(t);
  fs.mkdirSync(f.options.hudHome, { mode: 0o700 });
  for (const name of ['credentials.env', 'config.json', 'routing.toml'])
    fs.writeFileSync(path.join(f.options.hudHome, name), `synthetic ${name}`, { mode: 0o640 });
  const before = tree(f.options.hudHome);
  const r = apply(f);
  for (const [name, mode, hash] of before) {
    assert.equal(digest(fs.readFileSync(path.join(f.options.hudHome, name))), hash);
    assert.equal(fs.statSync(path.join(f.options.hudHome, name)).mode & 0o777, mode);
  }
  fs.mkdirSync(path.join(f.options.hudHome, 'history'), { mode: 0o700 });
  fs.writeFileSync(path.join(f.options.hudHome, 'history/result'), 'owner result', { mode: 0o600 });
  restoreActivation(r.receipt);
  assert.equal(fs.readFileSync(path.join(f.options.hudHome, 'history/result'), 'utf8'), 'owner result');
  for (const [name, mode, hash] of before) {
    assert.equal(digest(fs.readFileSync(path.join(f.options.hudHome, name))), hash);
    assert.equal(fs.statSync(path.join(f.options.hudHome, name)).mode & 0o777, mode);
  }
});
test('client adapters use declarative private dirs and owned files with explicit existing-file confirmation', (t) => {
  const f = setup(t);
  fs.mkdirSync(f.options.hudHome, { mode: 0o700 });
  const file = path.join(f.options.hudHome, 'integration.json');
  fs.writeFileSync(file, 'old', { mode: 0o600 });
  f.options.steps = [{ kind: 'owned-file', path: file, content: 'new', mode: 0o600 }];
  assert.throws(() => planActivation(f.options), /foreign_owned_file/);
  Object.assign(f.options.steps[0], {
    expectedOriginalHash: digest('old'),
    confirmation: 'Replace this exact integration file only.',
  });
  const r = apply(f);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  restoreActivation(r.receipt);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
});

for (const phase of ['before', 'mutated', 'after']) {
  // All real mutations: private display/panels/shim dirs, 3 files, rc and selector.
  for (let index = 1; index <= 8; index++)
    test(`interrupted ${phase} journal step ${index} restores exact bytes modes absence`, (t) => {
      const f = setup(t);
      f.options.rcFile = path.join(f.home, '.bashrc');
      fs.writeFileSync(f.options.rcFile, 'export OLD=1\n', { mode: 0o640 });
      const p = planActivation(f.options);
      assert.ok(p.actions[index], `missing step ${index}`);
      let receipt;
      assert.throws(
        () =>
          applyActivation(f.options, p.planId, {
            checkpoint(at, n, file) {
              if (at === phase && n === index) {
                receipt = file;
                throw new Error('injected_failure');
              }
            },
          }),
        /injected_failure/
      );
      assert.equal(restoreActivation(receipt).status, 'deactivated; release retained');
      assert.equal(fs.existsSync(f.options.shimDir), false);
      assert.deepEqual(fs.readdirSync(f.options.hudHome), ['installation']);
      assert.equal(fs.readFileSync(f.options.rcFile, 'utf8'), 'export OLD=1\n');
      assert.equal(fs.statSync(f.options.rcFile).mode & 0o777, 0o640);
      assert.equal(fs.existsSync(path.join(f.prefix, 'current')), false);
    });
}
test('metadata interruption retains usable recovery route', (t) => {
  const f = setup(t);
  let receipt;
  assert.throws(
    () =>
      apply(f, {
        checkpoint(phase, _n, file) {
          if (phase === 'metadata') {
            receipt = file;
            throw new Error('injected');
          }
        },
      }),
    /injected/
  );
  assert.equal(restoreActivation(receipt).status, 'deactivated; release retained');
  assert.deepEqual(fs.readdirSync(f.options.hudHome), ['installation']);
});
test('upgrade stages beside N; selector changes only at activation and pinned old process still runs', async (t) => {
  const f = setup(t, 'N');
  const r = apply(f);
  const oldSelector = fs.readFileSync(path.join(f.prefix, 'current'));
  const g = fixture(t, 'N+1');
  const p = planInstall(g.bundle, f.prefix, undefined, false, true);
  executeInstall(g.bundle, f.prefix, p.planDigest, undefined, { stageOnly: true });
  assert.deepEqual(fs.readFileSync(path.join(f.prefix, 'current')), oldSelector);
  const pinned = path.join(f.prefix, 'releases', f.options.release, 'bin/hud');
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', `setTimeout(()=>import(${JSON.stringify(pathToFileURL(pinned).href)}),300);`],
    { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let output = '';
  child.stdout.on('data', (b) => (output += b));
  const done = new Promise((resolve) => child.on('close', resolve));
  f.options.release = p.bundleDigest;
  const preview = planActivation(f.options);
  assert.ok(preview.actions.every((a) => ['selector', 'public-shim'].includes(a.kind)));
  const upgraded = applyActivation(f.options, preview.planId);
  assert.equal(await done, 0);
  assert.match(output, /N/);
  // Recorded owner is retained, not interpreted as authority to kill anything.
  fs.writeFileSync(
    path.join(f.options.hudHome, 'panels/owner.json'),
    JSON.stringify({ runtimeDigest: JSON.parse(oldSelector).manifestDigest }),
    { mode: 0o600 }
  );
  assert.equal(restoreActivation(upgraded.receipt).status, 'deactivated; release retained');
  assert.deepEqual(fs.readFileSync(path.join(f.prefix, 'current')), oldSelector);
  assert.equal(fs.existsSync(pinned), true);
  assert.equal(restoreActivation(r.receipt).status, 'deactivated; release retained');
  assert.equal(fs.existsSync(path.join(f.prefix, 'current')), false);
  assert.equal(fs.existsSync(path.join(f.options.hudHome, 'panels/owner.json')), true);
});
test('two real applies compete; runtime installer and activation share the prefix lock', async (t) => {
  const f = setup(t);
  const p = planActivation(f.options);
  const moduleURL = pathToFileURL(path.resolve('scripts/runtime-package/activation.mjs')).href;
  const code = `import {applyActivation} from ${JSON.stringify(moduleURL)}; try {applyActivation(${JSON.stringify(f.options)},${JSON.stringify(p.planId)},{checkpoint(p){if(p==='metadata') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);}});console.log('WIN');}catch(e){console.log('REFUSED '+e.message);process.exitCode=1;}`;
  const results = await Promise.all(
    [0, 1].map(
      () =>
        new Promise((resolve) => {
          const c = spawn(process.execPath, ['--input-type=module', '-e', code], {
            env: f.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let out = '';
          c.stdout.on('data', (b) => (out += b));
          c.stderr.on('data', (b) => (out += b));
          c.on('close', (status) => resolve({ status, out }));
        })
    )
  );
  assert.equal(results.filter((r) => r.status === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => r.status === 1).length, 1);
  // Attempt real runtime transaction while activation owns its lock.
  const g = fixture(t, 'next');
  const runtimePlan = planInstall(g.bundle, f.prefix);
  const currentOptions = { ...f.options, release: p.runtimeDigest };
  // Existing activation preview has no selector move, but still locks the prefix.
  const next = planActivation(currentOptions);
  assert.throws(
    () =>
      applyActivation(currentOptions, next.planId, {
        checkpoint(phase) {
          if (phase === 'metadata') executeInstall(g.bundle, f.prefix, runtimePlan.planDigest);
        },
      }),
    /locked_manual_inspection/
  );
});

for (const index of [4, 8])
  test(`SIGKILL journal step ${index}: matching explicit restore reclaims only dead activation locks`, async (t) => {
    const f = setup(t);
    f.options.rcFile = path.join(f.home, '.profile');
    const p = planActivation(f.options);
    const marker = path.join(f.root, 'ready.json');
    const moduleURL = pathToFileURL(path.resolve('scripts/runtime-package/activation.mjs')).href;
    const code = `import fs from 'node:fs'; import {applyActivation} from ${JSON.stringify(moduleURL)}; applyActivation(${JSON.stringify(f.options)},${JSON.stringify(p.planId)},{checkpoint(phase,n,receipt){if(phase==='mutated'&&n===${index}){fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({receipt}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);}}});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: f.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (b) => (errors += b));
    const closed = new Promise((r) => child.on('close', r));
    try {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.equal(fs.existsSync(marker), true, errors);
      const { receipt } = JSON.parse(fs.readFileSync(marker));
      assert.throws(() => planActivation(f.options), /stale_activation_lock.*restore --receipt/);
      assert.throws(() => restoreActivation(receipt), /owner_alive_or_unknown/);
      assert.throws(() => restoreActivation(receipt + '.wrong'), /invalid_activation_receipt/);
      child.kill('SIGKILL');
      await closed;
      assert.equal(restoreActivation(receipt).status, 'deactivated; release retained');
      assert.deepEqual(fs.readdirSync(f.options.hudHome), ['installation']);
      assert.equal(fs.existsSync(path.join(f.prefix, 'install-lock')), false);
      assert.equal(fs.existsSync(f.options.shimDir), false);
      assert.equal(fs.existsSync(path.join(f.prefix, 'current')), false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await closed;
      }
    }
  });
test('unknown runtime locks are never reclaimed; reused PID stamp is dead without signaling reused process', (t) => {
  const f = setup(t);
  const r = apply(f);
  const prefixLock = path.join(f.prefix, 'install-lock');
  fs.mkdirSync(prefixLock, { mode: 0o700 });
  fs.writeFileSync(path.join(prefixLock, 'owner.json'), JSON.stringify({ schemaVersion: 1, pid: process.pid }), {
    mode: 0o600,
  });
  assert.throws(() => restoreActivation(r.receipt), /manual_inspection_required.*install-lock/);
  fs.unlinkSync(path.join(prefixLock, 'owner.json'));
  fs.rmdirSync(prefixLock);
  const current = fs.readFileSync('/proc/self/stat', 'utf8');
  const start = current.slice(current.lastIndexOf(')') + 2).split(' ')[19];
  // Make real activation-owned records, then emulate a historical owner whose PID was reused by us.
  const processModule = pathToFileURL(path.resolve('dist/core/run/process.js')).href;
  return import(processModule).then(({ readProcess }) => {
    const stamp = { ...readProcess(process.pid).stamp, proc_start: start === '1' ? '2' : '1' };
    for (const lock of [prefixLock, path.join(f.options.hudHome, 'installation/activation-lock')]) {
      fs.mkdirSync(lock, { mode: 0o700 });
      fs.writeFileSync(
        path.join(lock, 'owner.json'),
        JSON.stringify({ schemaVersion: 1, kind: 'hud-activation-lock', receipt: r.receipt, stamp }),
        { mode: 0o600 }
      );
    }
    assert.throws(() => planActivation(f.options), /stale_activation_lock/);
    assert.equal(restoreActivation(r.receipt).status, 'deactivated; release retained');
    assert.equal(process.pid, stamp.pid); // reused live process still running; no signal was sent
  });
});
if (!process.env.R6A_ACTIVATION_MODULE)
  test('mutation checks kill skipped recheck, symlink following and whole-bin publication', (t) => {
    const f = fixture(t);
    const source = fs.readFileSync(new URL('../../scripts/runtime-package/activation.mjs', import.meta.url), 'utf8');
    for (const file of ACTIVATION_PROCESS_FILES) {
      fs.mkdirSync(path.dirname(path.join(f.root, file)), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.resolve(file), path.join(f.root, file));
    }
    const variants = [
      [
        'skip-recheck',
        /assertState\((?:step\.path, step\.original|file, expected)\);/g,
        'void 0;',
        'post-preview recheck',
      ],
      [
        'follow-symlink',
        'if (stat.isSymbolicLink()) throw new Error(`symlink_target_refused: ${current}`);',
        'if (stat.isSymbolicLink()) return observe(fs.realpathSync(current));',
        'symlinked target',
      ],
      [
        'whole-bin',
        "Object.freeze(['hud', 'hud-statusline', 'hud-mcp'])",
        'Object.freeze(Object.keys(COMMANDS))',
        'only the three public',
      ],
    ];
    for (const [name, needle, replacement, pattern] of variants) {
      const dir = path.join(f.root, name);
      fs.mkdirSync(dir, { mode: 0o700 });
      for (const file of [
        'safety.mjs',
        'manifest.mjs',
        'dependencies.mjs',
        'installer.mjs',
        'activation-lock.mjs',
        'claude.mjs',
        'pi.mjs',
      ])
        fs.copyFileSync(new URL(`../../scripts/runtime-package/${file}`, import.meta.url), path.join(dir, file));
      const mutant = source.replaceAll(needle, replacement);
      assert.notEqual(mutant, source, name);
      fs.writeFileSync(path.join(dir, 'activation.mjs'), mutant, { mode: 0o600 });
      const result = spawnSync(
        process.execPath,
        [
          '--test',
          '--test-reporter=tap',
          `--test-name-pattern=${pattern}`,
          new URL('./runtime-activation.test.mjs', import.meta.url).pathname,
        ],
        {
          env: { ...f.env, R6A_ACTIVATION_MODULE: pathToFileURL(path.join(dir, 'activation.mjs')).href },
          encoding: 'utf8',
          timeout: 30000,
        }
      );
      assert.equal(result.status, 1, `${name} survived: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /# fail 1/);
      assert.match(result.stdout, new RegExp('not ok.*' + pattern));
    }
  });
