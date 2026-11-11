import fsMutable from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { previewStatusline, applyStatusline, restoreStatusline } from '../../src/statusline-settings.js';
import { importStatusline } from '../../src/statusline-parity/settings.js';
import { draftInventory, parity } from '../../src/integrations/claude/setup.js';
import type { ClaudeBinding } from '../../src/integrations/claude/binding.js';
import { OWNER_CONFIG } from '../fixtures/claude-hud-parity/fixture.js';
import { setTimeout as sleep } from 'node:timers/promises';
function fixture(
  t: test.TestContext,
  original: string | null = '{"theme":"synthetic","statusLine":{"type":"command","command":"old"}}\n'
) {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-statusline-settings-'));
  fs.mkdirSync(join(home, '.claude'), { mode: 0o700 });
  const file = join(home, '.claude', 'settings.json');
  if (original !== null) fs.writeFileSync(file, original, { mode: 0o640 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, file, original, plan: () => previewStatusline(home, process.execPath, resolve('bin/hud-statusline')) };
}
test('preview read-only; explicit apply preserves other settings and restore returns exact bytes/mode', (t) => {
  const f = fixture(t);
  const before = fs.readdirSync(join(f.home, '.claude'));
  const plan = f.plan();
  assert.deepEqual(fs.readdirSync(join(f.home, '.claude')), before);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  const result = applyStatusline(f.home, plan);
  const installed = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(installed.theme, 'synthetic');
  assert.match(installed.statusLine.command, /hud-statusline/);
  assert.equal(fs.statSync(result.backup).mode & 0o777, 0o600);
  restoreStatusline(f.home, result.backup);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o640);
});
test('new file is removed on explicit restore, backup retained', (t) => {
  const f = fixture(t, null);
  const r = applyStatusline(f.home, f.plan());
  restoreStatusline(f.home, r.backup);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.existsSync(r.backup), true);
});
test('stale preview and post-install edit conflict, no overwrite', (t) => {
  const f = fixture(t);
  const plan = f.plan();
  fs.appendFileSync(f.file, ' ');
  assert.throws(() => applyStatusline(f.home, plan), /settings_changed/);
  const r = applyStatusline(f.home, f.plan());
  fs.appendFileSync(f.file, ' ');
  const edited = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => restoreStatusline(f.home, r.backup), /settings_changed/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), edited);
});
test('symlink, wrong target, invalid JSON and cooperative lock fail closed', (t) => {
  const f = fixture(t);
  const plan = f.plan();
  assert.throws(() => applyStatusline(f.home, { ...plan, target: '/tmp/elsewhere' }));
  fs.writeFileSync(f.file + '.hud-statusline.lock', '');
  assert.throws(() => applyStatusline(f.home, plan));
  fs.unlinkSync(f.file + '.hud-statusline.lock');
  fs.unlinkSync(f.file);
  fs.symlinkSync('/tmp/not-a-settings-target', f.file);
  assert.throws(() => f.plan());
  fs.unlinkSync(f.file);
  fs.writeFileSync(f.file, '[]');
  assert.throws(() => f.plan());
});
test('actual product entry renders stdin and explicit preview/apply/restore in temporary HOME only', (t) => {
  const f = fixture(t);
  const command = (args: string[], input?: string) =>
    spawnSync(process.execPath, [resolve('bin/hud-statusline'), ...args], {
      env: { HOME: f.home },
      input,
      encoding: 'utf8',
      timeout: 3000,
    });
  const render = command(
    [],
    JSON.stringify({
      model: { display_name: 'Synthetic' },
      context_window: { used_percentage: 42 },
      cost: { total_cost_usd: 0.12 },
    })
  );
  assert.equal(render.status, 0);
  assert.equal(render.stdout.trim(), 'Synthetic · ctx 42% · $0.12');
  const preview = command(['settings', 'preview']);
  assert.equal(preview.status, 0);
  const plan = join(f.home, 'plan.json');
  fs.writeFileSync(plan, preview.stdout, { mode: 0o600 });
  const applied = command(['settings', 'apply', '--plan', plan]);
  assert.equal(applied.status, 0);
  const backup = JSON.parse(applied.stdout).backup;
  assert.equal(command(['settings', 'restore', '--backup', backup]).status, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
});

test('large valid settings have a readable exact backup; tampered backup cannot restore', (t) => {
  const f = fixture(t, JSON.stringify({ synthetic: 'x'.repeat(800000) }) + '\n');
  const r = applyStatusline(f.home, f.plan());
  restoreStatusline(f.home, r.backup);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  const r2 = applyStatusline(f.home, f.plan());
  const backup = JSON.parse(fs.readFileSync(r2.backup, 'utf8'));
  backup.original = 'YQ==';
  fs.writeFileSync(r2.backup, JSON.stringify(backup));
  assert.throws(() => restoreStatusline(f.home, r2.backup), /invalid_statusline_backup/);
});

test(
  'actual FIFO settings, plan and backup are refused promptly without waiting for writers',
  { skip: process.platform === 'win32' },
  (t) => {
    const f = fixture(t);
    const run = (args: string[]) => {
      const r = spawnSync(process.execPath, [resolve('bin/hud-statusline'), ...args], {
        env: { HOME: f.home },
        encoding: 'utf8',
        timeout: 3000,
      });
      assert.ifError(r.error);
      assert.equal(r.status, 2);
    };
    fs.unlinkSync(f.file);
    execFileSync('mkfifo', [f.file]);
    run(['settings', 'preview']);
    fs.unlinkSync(f.file);
    fs.writeFileSync(f.file, '{}');
    const plan = join(f.home, 'fifo-plan');
    execFileSync('mkfifo', [plan]);
    run(['settings', 'apply', '--plan', plan]);
    const backup = f.file + '.hud-statusline-backup-fifo.json';
    execFileSync('mkfifo', [backup]);
    run(['settings', 'restore', '--backup', backup]);
  }
);

test('directory substitution cannot redirect apply mutations to another directory', (t) => {
  const f = fixture(t);
  const plan = f.plan();
  const dir = join(f.home, '.claude'),
    moved = join(f.home, 'old-claude'),
    other = join(f.home, 'other');
  fs.mkdirSync(other, { mode: 0o700 });
  const marker = join(other, 'settings.json');
  fs.writeFileSync(marker, '{"untouched":true}', { mode: 0o600 });
  const original = fsMutable.writeFileSync;
  let swapped = false;
  fsMutable.writeFileSync = ((...args: Parameters<typeof fsMutable.writeFileSync>) => {
    original(...args);
    if (typeof args[0] === 'number' && !swapped) {
      swapped = true;
      fs.renameSync(dir, moved);
      fs.symlinkSync(other, dir);
    }
  }) as typeof fsMutable.writeFileSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => applyStatusline(f.home, plan));
    assert.equal(swapped, true);
    assert.equal(fs.readFileSync(marker, 'utf8'), '{"untouched":true}');
    assert.deepEqual(fs.readdirSync(other), ['settings.json']);
    assert.equal(fs.readFileSync(join(moved, 'settings.json'), 'utf8'), f.original);
  } finally {
    fsMutable.writeFileSync = original;
    syncBuiltinESMExports();
    if (swapped) {
      fs.unlinkSync(dir);
      fs.renameSync(moved, dir);
    }
  }
});
test('parity import previews without writes; apply preserves only HUD section and rejects lossy settings', (t) => {
  const f = fixture(t),
    hud = join(f.home, 'hud'),
    source = join(f.home, 'claude-hud.json');
  fs.mkdirSync(hud, { mode: 0o700 });
  const config = join(hud, 'config.json');
  fs.writeFileSync(config, '{"other":{"keep":true}}', { mode: 0o600 });
  fs.writeFileSync(source, JSON.stringify(OWNER_CONFIG));
  const env = { HOME: f.home, HUD_HOME: hud };
  const before = fs.readFileSync(config);
  importStatusline(['--from', source], env);
  assert.deepEqual(fs.readFileSync(config), before);
  assert.deepEqual(fs.readdirSync(hud), ['config.json']);
  importStatusline(['--from', source, '--apply'], env);
  const result = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.deepEqual(result.other, { keep: true });
  assert.deepEqual(result.statusline.display, OWNER_CONFIG.display);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  for (const invalid of [
    { ...OWNER_CONFIG, pathLevels: 2 },
    { ...OWNER_CONFIG, display: { showTools: true } },
  ]) {
    fs.writeFileSync(source, JSON.stringify(invalid));
    assert.throws(() => importStatusline(['--from', source, '--apply'], env), /unsupported/);
  }
  fs.writeFileSync(source, JSON.stringify({ ...OWNER_CONFIG, pathLevels: 1 }));
  assert.match(JSON.stringify(importStatusline(['--from', source], env)), /defaultsOutsideSubset/);
  const missing = join(f.home, 'absent-hud');
  importStatusline(['--from', source], { ...env, HUD_HOME: missing });
  assert.equal(fs.existsSync(missing), false);
});

test('explicit known wrapper import migrates absolute forwarding and width; unknown shell jobs still block activation', (t) => {
  const f = fixture(t),
    hud = join(f.home, 'hud'),
    config = join(f.home, 'owner-config.json');
  const wrapper = fs.readFileSync(resolve('tests/fixtures/claude-hud-parity/wrapper.txt'), 'utf8').trim();
  fs.writeFileSync(f.file, JSON.stringify({ statusLine: { type: 'command', command: wrapper } }));
  fs.writeFileSync(config, JSON.stringify(OWNER_CONFIG));
  const env = { HOME: f.home, HUD_HOME: hud };
  importStatusline(['--from', config, '--settings', f.file, '--apply'], env);
  const saved = JSON.parse(fs.readFileSync(join(hud, 'config.json'), 'utf8')).statusline;
  assert.deepEqual(saved.forward, [join(f.home, '.cargo/bin/toktrack'), 'quota', 'record-claude']);
  assert.equal(saved.widthMargin, 4);
  const inventory = join(hud, 'parity.json');
  const binding = { hudHome: hud, parityInventory: inventory } as ClaudeBinding;
  fs.writeFileSync(inventory, JSON.stringify(draftInventory(f.home, config)));
  assert.equal(parity(binding, f.home).status, 'PASS');
  fs.writeFileSync(f.file, JSON.stringify({ statusLine: { command: wrapper + '; echo extra-job' } }));
  assert.throws(
    () => importStatusline(['--from', config, '--settings', f.file], env),
    /unsupported_statusline_wrapper/
  );
  fs.writeFileSync(inventory, JSON.stringify(draftInventory(f.home, config)));
  assert.deepEqual(parity(binding, f.home).gaps, ['statusline_wrapper']);
});

test('public shim preview is plain, reports absence, and apply refuses until publication', (t) => {
  const f = fixture(t),
    dir = join(f.home, 'custom bin');
  const plan = previewStatusline(f.home, process.execPath, resolve('bin/hud-statusline'), dir);
  assert.equal(plan.shimExists, false);
  assert.equal(plan.command, "'" + join(dir, 'hud-statusline') + "'");
  assert.throws(() => applyStatusline(f.home, plan), /public_shim/);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(join(dir, 'hud-statusline'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  applyStatusline(f.home, previewStatusline(f.home, process.execPath, resolve('bin/hud-statusline'), dir));
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).statusLine.command, plan.command);
  const hud = join(f.home, 'hud');
  fs.mkdirSync(hud, { mode: 0o700 });
  fs.writeFileSync(join(hud, 'config.json'), JSON.stringify({ statusline: OWNER_CONFIG }));
  const automatic = previewStatusline(f.home, process.execPath, resolve('bin/hud-statusline'), undefined, {
    HOME: f.home,
    HUD_HOME: hud,
  });
  assert.equal(automatic.shimPath, join(f.home, '.local/bin/hud-statusline'));
  assert.equal(automatic.shimExists, false);
  assert.throws(() => applyStatusline(f.home, automatic), /public_shim/);
});

test('forward receives exact stdin bytes; a hanging argv never delays or changes statusline output', async (t) => {
  const f = fixture(t),
    hud = join(f.home, 'hud'),
    script = join(f.home, 'forward.mjs'),
    received = join(f.home, 'received');
  fs.mkdirSync(hud, { mode: 0o700 });
  fs.writeFileSync(
    script,
    "import fs from 'node:fs';const chunks=[];for await(const b of process.stdin) chunks.push(b);fs.writeFileSync(process.argv[2],Buffer.concat(chunks));"
  );
  const config = join(hud, 'config.json');
  const env = {
    HOME: f.home,
    HUD_HOME: hud,
    CODEX_HOME: join(f.home, 'codex'),
    CLAUDE_CONFIG_DIR: join(f.home, '.claude'),
  };
  const run = () =>
    spawnSync(process.execPath, [resolve('bin/hud-statusline')], {
      env,
      input: bytes,
      encoding: 'utf8',
      timeout: 1000,
    });
  const bytes = Buffer.from(' \r\n{ "model": {"display_name":"Synthetic 中文"} }\n\t');
  fs.writeFileSync(
    config,
    JSON.stringify({ statusline: { ...OWNER_CONFIG, forward: [process.execPath, script, received] } })
  );
  const result = run();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  for (let i = 0; i < 100 && !fs.existsSync(received); i++) await sleep(25);
  assert.deepEqual(fs.readFileSync(received), bytes);
  fs.writeFileSync(
    script,
    "import fs from 'node:fs';fs.writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);"
  );
  const pidfile = join(f.home, 'forward-pid');
  fs.writeFileSync(
    config,
    JSON.stringify({ statusline: { ...OWNER_CONFIG, forward: [process.execPath, script, pidfile] } })
  );
  const hanging = run();
  assert.ifError(hanging.error);
  assert.equal(hanging.status, 0, hanging.stderr);
  assert.equal(hanging.stdout, result.stdout);
  for (let i = 0; i < 100 && !fs.existsSync(pidfile); i++) await sleep(25);
  const pid = Number(fs.readFileSync(pidfile, 'utf8'));
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* worker already reaped it */
    }
  });
  let alive = true;
  for (let i = 0; i < 160; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
      break;
    }
    // Linux may retain the killed child as a zombie until its subreaper's next pass.
    try {
      if (/^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))) {
        alive = false;
        break;
      }
    } catch {
      alive = false;
      break;
    }
    await sleep(25);
  }
  assert.equal(alive, false, 'detached worker kills its owned process group at the deadline');
});

test('group/world-writable settings, plan and backup are rejected', (t) => {
  const f = fixture(t);
  fs.chmodSync(f.file, 0o666);
  assert.throws(() => f.plan(), /unsafe_settings_file/);
  fs.chmodSync(f.file, 0o600);
  const plan = f.plan();
  const r = applyStatusline(f.home, plan);
  fs.chmodSync(r.backup, 0o620);
  assert.throws(() => restoreStatusline(f.home, r.backup), /unsafe_settings_file/);
  fs.chmodSync(r.backup, 0o600);
  const altered = JSON.parse(fs.readFileSync(r.backup, 'utf8'));
  altered.mode = 0o666;
  fs.writeFileSync(r.backup, JSON.stringify(altered));
  assert.throws(() => restoreStatusline(f.home, r.backup), /invalid_statusline_backup/);
  const planFile = join(f.home, 'unsafe-plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  fs.chmodSync(planFile, 0o662);
  const result = spawnSync(process.execPath, [resolve('bin/hud-statusline'), 'settings', 'apply', '--plan', planFile], {
    env: { HOME: f.home },
    encoding: 'utf8',
    timeout: 3000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 2);
});
