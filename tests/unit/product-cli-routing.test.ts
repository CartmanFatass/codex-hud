import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'hud-routing-'));
  mkdirSync(join(home, '.claude'), { mode: 0o700 });
  const run = (bin: string, args: string[], input = '') =>
    spawnSync(process.execPath, [bin, ...args], {
      encoding: 'utf8',
      input,
      timeout: 5000,
      env: { PATH: process.env.PATH, HOME: home, HUD_HOME: join(home, 'missing'), COLUMNS: '80' },
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
