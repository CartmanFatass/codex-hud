import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { panelCommand } from '../../src/cli/panel.js';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'hud-routing-'));
  mkdirSync(join(home, '.claude'), { mode: 0o700 });
  const run = (bin: string, args: string[], input = '', env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [bin, ...args], {
      encoding: 'utf8',
      input,
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: join(home, 'missing-codex'),
        HUD_HOME: join(home, 'missing'),
        COLUMNS: '80',
        ...env,
      },
    });
  return { home, run, close: () => rmSync(home, { recursive: true, force: true }) };
}

test('root help discovers statusline without opening a ledger; render aliases agree', () => {
  const f = fixture();
  try {
    const help = f.run('bin/hud', ['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /hud statusline --help/);
    const dedicated = f.run('bin/hud-statusline', ['--help']);
    const routed = f.run('bin/hud', ['statusline', '--help']);
    assert.equal(routed.status, 0);
    assert.equal(routed.stdout, dedicated.stdout);
    const input = JSON.stringify({
      model: { display_name: 'Synthetic' },
      context_window: { used_percentage: 25 },
      cost: { total_cost_usd: 0 },
    });
    const a = f.run('bin/hud', ['statusline', '--width', '80'], input);
    const b = f.run('bin/hud-statusline', ['--width', '80'], input);
    assert.equal(a.status, 0);
    assert.equal(a.stdout, b.stdout);
    assert.match(a.stdout, /Synthetic/);
    assert.deepEqual(readdirSync(join(f.home, '.claude')), []);
    assert.equal(f.run('bin/hud', ['statusline', '--bogus'], input).status, 2);
  } finally {
    f.close();
  }
});

test(
  'routed settings preserve preview/apply/restore safeguards in temporary HOME',
  { skip: process.platform !== 'linux' },
  () => {
    const f = fixture();
    try {
      const target = join(f.home, '.claude', 'settings.json');
      const original = '{"unrelated":true}\n';
      writeFileSync(target, original, { mode: 0o600 });
      const preview = f.run('bin/hud', ['statusline', 'settings', 'preview']);
      assert.equal(preview.status, 0, preview.stderr);
      assert.equal(readFileSync(target, 'utf8'), original);
      const plan = join(f.home, 'plan.json');
      writeFileSync(plan, preview.stdout, { mode: 0o600 });
      const apply = f.run('bin/hud', ['statusline', 'settings', 'apply', '--plan', plan]);
      assert.equal(apply.status, 0, apply.stderr);
      const changed = JSON.parse(readFileSync(target, 'utf8'));
      assert.equal(changed.unrelated, true);
      assert.match(changed.statusLine.command, /bin\/hud-statusline/);
      const receipt = JSON.parse(apply.stdout);
      const restored = f.run('bin/hud', ['statusline', 'settings', 'restore', '--backup', receipt.backup]);
      assert.equal(restored.status, 0, restored.stderr);
      assert.equal(readFileSync(target, 'utf8'), original);
    } finally {
      f.close();
    }
  }
);

test('package and lock agree on executable aliases', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  for (const [name, file] of Object.entries(pkg.bin) as [string, string][]) {
    assert.equal(lock.packages[''].bin[name], file.replace(/^\.\//, ''));
  }
  assert.equal(pkg.bin['hud-statusline'], './bin/hud-statusline');
});

test('E2 panel help is read-only with neutral selectors and missing or unsafe homes', () => {
  const f = fixture();
  try {
    const unsafeHome = join(f.home, 'not-a-directory');
    writeFileSync(unsafeHome, 'Synthetic unchanged file', { mode: 0o600 });
    const before = readdirSync(f.home).sort();
    for (const hudHome of [join(f.home, 'missing'), unsafeHome]) {
      const env = {
        HUD_HOME: hudHome,
        CODEX_HOME: unsafeHome,
        HUD_SETTINGS_PATH: join(f.home, 'missing settings B.json'),
        CODEX_HUD_SETTINGS_PATH: join(f.home, 'missing settings A.json'),
        HUD_THEME: 'latte',
      };
      const rootHelp = f.run('bin/hud', ['--help'], '', env);
      assert.equal(rootHelp.status, 0, rootHelp.stderr);
      assert.match(rootHelp.stdout, /hud panel/);
      const help = f.run('bin/hud', ['panel', '--help'], '', env);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /HUD_SETTINGS_PATH/);
      assert.match(help.stdout, /HUD_THEME/);
      assert.equal(f.run('bin/hud', ['panel', '--bogus'], '', env).status, 2);
      assert.deepEqual(readdirSync(f.home).sort(), before);
      assert.deepEqual(readdirSync(join(f.home, '.claude')), []);
      assert.equal(readFileSync(unsafeHome, 'utf8'), 'Synthetic unchanged file');
    }
  } finally {
    f.close();
  }
});

test('E2 existing panel entry receives neutral and legacy environment unchanged (mock spawn only)', async () => {
  const f = fixture();
  const native = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
  const original = native.spawn;
  const calls: Array<{ file: string; args: string[]; options: SpawnOptions }> = [];
  try {
    Object.assign(native, {
      spawn(file: string, args: string[], options: SpawnOptions) {
        calls.push({ file, args, options });
        const child = Object.assign(new EventEmitter(), { kill: () => true });
        setImmediate(() => child.emit('exit', 0, null));
        return child;
      },
    });
    syncBuiltinESMExports();
    const env = {
      HOME: f.home,
      HUD_HOME: join(f.home, 'missing'),
      CODEX_HOME: join(f.home, 'missing-codex'),
      HUD_SETTINGS_PATH: join(f.home, 'settings B with spaces.json'),
      CODEX_HUD_SETTINGS_PATH: join(f.home, 'settings A.json'),
      HUD_THEME: 'latte',
      CODEX_HUD_THEME: 'mocha',
    };
    const before = { ...env };
    assert.equal(await panelCommand({ env, stdout: () => {}, stderr: () => {} }), 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, process.execPath);
    assert.equal(calls[0].args.length, 1);
    assert.ok(calls[0].args[0].endsWith(join('dist', 'tree-page.js')));
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.stdio, 'inherit');
    assert.deepEqual(calls[0].options.env, {
      ...env,
      CODEX_HUD_PANEL_ALL_DELEGATIONS: '1',
      CODEX_HUD_STANDALONE_PANEL: '1',
    });
    assert.deepEqual(env, before);
    assert.deepEqual(readdirSync(f.home), ['.claude']);
  } finally {
    Object.assign(native, { spawn: original });
    syncBuiltinESMExports();
    f.close();
  }
});

test('F4 installed digest help and syntax refusals do not open missing or unsafe HUD homes', () => {
  const f = fixture();
  try {
    const file = join(f.home, 'unsafe-home');
    writeFileSync(file, 'synthetic', { mode: 0o600 });
    for (const home of [join(f.home, 'missing'), file]) {
      const help = f.run('bin/hud', ['digest', '--help'], '', { HUD_HOME: home });
      assert.equal(help.status, 0);
      assert.match(help.stdout, /hud digest run/);
      const bad = f.run('bin/hud', ['digest', 'run', '--json'], '', { HUD_HOME: home });
      assert.equal(bad.status, 2);
      assert.equal(bad.stdout, '');
      const plan = f.run('bin/hud', ['digest', 'plan', '--run', 'r', '--report', 'p', '--json'], '', {
        HUD_HOME: home,
      });
      assert.equal(plan.status, 3);
      assert.equal(plan.stdout, '');
    }
    assert.match(f.run('bin/hud', ['--help']).stdout, /hud digest --help/);
  } finally {
    f.close();
  }
});
