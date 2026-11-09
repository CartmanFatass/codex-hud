import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fixture } from '../../scripts/runtime-package/test-fixture.mjs';
import { planInstall, executeInstall } from '../../scripts/runtime-package/installer.mjs';
import {
  planActivation,
  applyActivation,
  restoreActivation,
  planDeactivation,
  activationHistory,
  ACTIVATION_HISTORY_LIMIT,
} from '../../scripts/runtime-package/activation.mjs';

function setup(t, label = 'N') {
  const f = fixture(t, label);
  const p = planInstall(f.bundle, f.prefix, undefined, false, true);
  executeInstall(f.bundle, f.prefix, p.planDigest, undefined, { stageOnly: true });
  const options = {
    prefix: f.prefix,
    release: p.bundleDigest,
    hudHome: path.join(f.home, 'hud'),
    shimDir: path.join(f.home, 'public bin'),
    path: f.env.PATH,
  };
  return { ...f, options };
}
function install(f, hooks) {
  const p = planActivation(f.options);
  assert.equal(planActivation(f.options).planId, p.planId);
  return applyActivation(f.options, p.planId, hooks);
}

test('four full install/uninstall cycles from absent home keep every receipt and permit fresh deterministic plans', (t) => {
  const f = setup(t);
  const receipts = new Set();
  for (let i = 0; i < 4; i++) {
    const r = install(f);
    assert.equal(receipts.has(r.receipt), false);
    receipts.add(r.receipt);
    assert.equal(restoreActivation(r.receipt).status, 'deactivated; release retained');
    assert.deepEqual(fs.readdirSync(f.options.hudHome), ['installation']);
    for (const file of receipts) assert.equal(fs.existsSync(file), true);
  }
  assert.equal(activationHistory(f.options.hudHome).count, 4);
});
test('interrupted before first mutation then restored can install again in an existing HUD home', (t) => {
  const f = setup(t);
  fs.mkdirSync(f.options.hudHome, { mode: 0o700 });
  const p = planActivation(f.options);
  let receipt;
  assert.throws(
    () =>
      applyActivation(f.options, p.planId, {
        checkpoint(phase, _index, file) {
          if (phase === 'before') {
            receipt = file;
            throw new Error('injected');
          }
        },
      }),
    /injected/
  );
  assert.equal(restoreActivation(receipt).status, 'deactivated; release retained');
  const saved = fs.readFileSync(receipt);
  const next = planActivation(f.options);
  assert.notEqual(next.planId, p.planId);
  assert.notEqual(next.transaction, p.transaction);
  const r = applyActivation(f.options, next.planId);
  assert.deepEqual(fs.readFileSync(receipt), saved);
  assert.equal(restoreActivation(r.receipt).status, 'deactivated; release retained');
});
test('history writes between preview/apply or at under-lock recheck make the exact plan stale', (t) => {
  const f = setup(t);
  const r = install(f);
  restoreActivation(r.receipt);
  let p = planActivation(f.options);
  fs.appendFileSync(r.receipt, '\n');
  assert.throws(() => applyActivation(f.options, p.planId), /stale_plan_preview_again/);
  p = planActivation(f.options);
  assert.throws(
    () =>
      applyActivation(f.options, p.planId, {
        checkpoint(phase) {
          if (phase === 'before-history-recheck') fs.appendFileSync(r.receipt, '\n');
        },
      }),
    /stale_plan_preview_again.*activation_history_changed/
  );
  assert.equal(activationHistory(f.options.hudHome).count, 1);
  assert.equal(fs.existsSync(f.options.shimDir), false);
});
test('receipt history refuses symlinks, wrong types and unreadable/private-mode violations without skipping', (t) => {
  const f = setup(t);
  const r = install(f);
  restoreActivation(r.receipt);
  const extra = path.join(f.options.hudHome, 'installation', 'extra.json');
  fs.symlinkSync(r.receipt, extra);
  assert.throws(() => planActivation(f.options), /symlink_target_refused/);
  fs.unlinkSync(extra);
  fs.mkdirSync(extra, { mode: 0o700 });
  assert.throws(() => planActivation(f.options), /unsafe_activation_history_receipt/);
  fs.rmdirSync(extra);
  fs.writeFileSync(extra, '{}', { mode: 0o000 });
  assert.throws(() => planActivation(f.options), /unsafe_activation_history_receipt/);
});
test('receipt history refuses the actual 4096-receipt bound rather than silently truncating', (t) => {
  assert.equal(ACTIVATION_HISTORY_LIMIT, 4096);
  const root = fs.mkdtempSync(path.join(tmpdir(), 'hud-history-bound-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadata = path.join(root, 'installation');
  fs.mkdirSync(metadata, { mode: 0o700 });
  for (let i = 0; i <= ACTIVATION_HISTORY_LIMIT; i++)
    fs.closeSync(fs.openSync(path.join(metadata, `${String(i).padStart(5, '0')}.json`), 'wx', 0o600));
  assert.throws(() => activationHistory(root), /activation_history_capacity_exceeded/);
});

for (let index = 1; index <= 8; index++)
  test(`reverse mutation ${index} interrupted before completion reconciles bytes/modes/absence`, (t) => {
    const f = setup(t);
    f.options.rcFile = path.join(f.home, '.bashrc');
    fs.writeFileSync(f.options.rcFile, 'original\n', { mode: 0o640 });
    const r = install(f);
    fs.appendFileSync(f.options.rcFile, 'unrelated later edit\n');
    assert.throws(
      () =>
        restoreActivation(r.receipt, undefined, {
          checkpoint(phase, n) {
            if (phase === 'restore-mutated' && n === index) throw new Error('reverse_injected');
          },
        }),
      /reverse_injected/
    );
    assert.equal(restoreActivation(r.receipt).status, 'deactivated; release retained');
    const journal = JSON.parse(fs.readFileSync(r.receipt)).journal.find((j) => j.index === index);
    assert.equal(journal.phase, 'restored');
    assert.ok(journal.restoredState);
    assert.equal(fs.existsSync(path.join(f.prefix, 'current')), false);
    assert.equal(fs.existsSync(f.options.shimDir), false);
    assert.deepEqual(fs.readdirSync(f.options.hudHome), ['installation']);
    assert.equal(fs.readFileSync(f.options.rcFile, 'utf8'), 'original\nunrelated later edit\n');
    assert.equal(fs.statSync(f.options.rcFile).mode & 0o777, 0o640);
  });
for (let index = 0; index <= 3; index++)
  test(`upgrade reverse mutation ${index} reconciles inode proof before older activation reversal`, (t) => {
    const f = setup(t);
    const first = install(f);
    const pinnedFiles = [
      path.join(f.prefix, 'current'),
      ...['hud', 'hud-statusline', 'hud-mcp'].map((name) => path.join(f.options.shimDir, name)),
    ];
    const held = pinnedFiles.map((file) => fs.openSync(file, 'r'));
    try {
      const g = fixture(t, 'N+1');
      const stage = planInstall(g.bundle, f.prefix, undefined, false, true);
      executeInstall(g.bundle, f.prefix, stage.planDigest, undefined, { stageOnly: true });
      f.options.release = stage.bundleDigest;
      const upgrade = install(f);
      assert.throws(
        () =>
          restoreActivation(upgrade.receipt, undefined, {
            checkpoint(phase, n) {
              if (phase === 'restore-mutated' && n === index) throw new Error('reverse_injected');
            },
          }),
        /reverse_injected/
      );
      assert.equal(restoreActivation(upgrade.receipt).status, 'deactivated; release retained');
      const journal = JSON.parse(fs.readFileSync(upgrade.receipt)).journal.find((j) => j.index === index);
      assert.equal(journal.phase, 'restored');
      assert.ok(journal.restoredState);
      assert.equal(restoreActivation(first.receipt).status, 'deactivated; release retained');
      assert.equal(fs.existsSync(path.join(f.prefix, 'current')), false);
      assert.equal(fs.existsSync(f.options.shimDir), false);
    } finally {
      for (const fd of held) fs.closeSync(fd);
    }
  });
test('bundle bootstrap and installed CLI both exit 4 for restore and uninstall conflicts', (t) => {
  const f = setup(t);
  const r = install(f);
  fs.appendFileSync(path.join(f.options.shimDir, 'hud'), '// owner change\n');
  const p = planDeactivation(r.receipt);
  assert.equal(p.conflicts.length, 1);
  for (const entry of [path.resolve('scripts/activate-runtime.mjs'), path.resolve('bin/hud')]) {
    for (const args of [
      ['install', 'restore', '--receipt', r.receipt],
      ['uninstall', 'apply', '--receipt', r.receipt, '--plan', p.planId],
    ]) {
      const result = spawnSync(process.execPath, [entry, ...args], {
        env: f.env,
        cwd: f.home,
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(result.status, 4, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, 'CONFLICT');
    }
  }
  assert.match(fs.readFileSync(path.join(f.options.shimDir, 'hud'), 'utf8'), /owner change/);
});
