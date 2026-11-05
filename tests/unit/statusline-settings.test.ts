import fsMutable from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { previewStatusline, applyStatusline, restoreStatusline } from '../../src/statusline-settings.js';
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
