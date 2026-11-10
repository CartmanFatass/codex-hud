import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fixture, priorInventoryFixture, rewriteManifest } from '../../scripts/runtime-package/test-fixture.mjs';
import { planInstall, executeInstall, inspectPrefix } from '../../scripts/runtime-package/installer.mjs';
import { planActivation } from '../../scripts/runtime-package/activation.mjs';
import { verifyBundle } from '../../scripts/runtime-package/manifest.mjs';
import { Directory } from '../../scripts/runtime-package/safety.mjs';
const preview = (f, receipt) => planInstall(f.bundle, f.prefix, receipt);
const apply = (f, receipt, hooks) => executeInstall(f.bundle, f.prefix, preview(f, receipt).planDigest, receipt, hooks);
const run = (f, command, args = []) =>
  spawnSync(path.join(f.prefix, 'bin', command), args, { cwd: f.cwd, env: f.env, encoding: 'utf8', timeout: 5000 });

function prefixSnapshot(root) {
  const result = {};
  function visit(directory, relative = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const key = relative + name;
      const stat = fs.lstatSync(file);
      result[key] = { mode: stat.mode, ino: stat.ino, dev: stat.dev };
      if (stat.isDirectory()) visit(file, key + '/');
      else result[key].bytes = fs.readFileSync(file).toString('base64');
    }
  }
  visit(root);
  return result;
}

test('retained prior inventory survives current inspection, upgrade, selection and rollback', async (t) => {
  const prior = priorInventoryFixture(t);
  const publisher = await import(pathToFileURL(path.join(prior.bundle, 'runtime-package/installer.mjs')).href);
  const initial = publisher.planInstall(prior.bundle, prior.prefix);
  const installed = publisher.executeInstall(prior.bundle, prior.prefix, initial.planDigest);
  const oldRoot = path.join(prior.prefix, 'releases', installed.manifestDigest);
  assert.ok(prior.omitted.includes('dist/roles/pi-owned/facade-context.js'));
  for (const name of ['segment', 'package-entry', 'package-native', 'package-context'])
    assert.equal(fs.existsSync(path.join(oldRoot, `dist/harness/pi/${name}.js`)), false);
  for (const name of prior.omitted) assert.equal(fs.existsSync(path.join(oldRoot, name)), false);
  const directory = new Directory(prior.prefix, true);
  try {
    assert.deepEqual(inspectPrefix(directory).releases, [installed.manifestDigest]);
  } finally {
    directory.close();
  }
  const next = fixture(t, 'next');
  next.prefix = prior.prefix;
  const upgrade = apply(next);
  assert.equal(run(prior, 'hud').stdout.trim(), 'next');
  assert.equal(fs.readdirSync(path.join(prior.prefix, 'releases')).length, 2);
  const restored = apply(next, upgrade.receipt);
  assert.equal(restored.manifestDigest, installed.manifestDigest);
  assert.equal(run(prior, 'hud').stdout.trim(), 'prior');
  assert.ok(
    planActivation({
      prefix: prior.prefix,
      release: installed.manifestDigest,
      hudHome: path.join(prior.home, 'hud'),
      shimDir: path.join(prior.root, 'public-bin'),
      path: '',
    }).planId
  );
  assert.throws(
    () => planInstall(prior.bundle, prior.prefix),
    /missing_required_entry/,
    'an old inventory is not admissible as a new incoming candidate'
  );
});

test('incoming bundle missing a current required entry is refused before any installation publication', (t) => {
  const f = fixture(t);
  const missing = 'dist/roles/pi-owned/facade-context.js';
  fs.unlinkSync(path.join(f.bundle, missing));
  rewriteManifest(f, (manifest) => {
    manifest.entries = manifest.entries.filter((entry) => entry.path !== missing);
  });
  assert.throws(() => planInstall(f.bundle, f.prefix), /missing_required_entry/);
  assert.throws(() => executeInstall(f.bundle, f.prefix, '0'.repeat(64)), /missing_required_entry/);
  assert.deepEqual(fs.readdirSync(f.prefix), []);
});

test('fix3 A-B-A refuses the old receipt even when selector identities are reused', (t) => {
  const a = fixture(t, 'A');
  const b = fixture(t, 'B');
  b.prefix = a.prefix;
  const first = apply(a);
  const firstReceiptBytes = fs.readFileSync(first.receipt);
  const fixedIdentity = JSON.parse(firstReceiptBytes).afterIdentity;
  const originalRead = Directory.prototype.read;
  let aliases = 0;
  // Deterministically emulate ordinary inode reuse at the selector-read boundary.
  // Receipt bytes and all payloads remain untouched; no filesystem timing is assumed.
  Directory.prototype.read = function (name, ...args) {
    const value = originalRead.call(this, name, ...args);
    if (this.root === a.prefix && ['current', 'install-lock/next'].includes(name)) {
      aliases++;
      return { ...value, identity: fixedIdentity };
    }
    return value;
  };
  try {
    const second = apply(b);
    const restored = apply(b, second.receipt);
    assert.equal(restored.status, 'SELECTED');
    assert.equal(JSON.parse(fs.readFileSync(path.join(a.prefix, 'current'))).manifestDigest, first.manifestDigest);
    const before = prefixSnapshot(a.prefix);
    assert.throws(() => preview(a, first.receipt), /stale/);
    assert.throws(() => executeInstall(a.bundle, a.prefix, '0'.repeat(64), first.receipt), /stale/);
    assert.deepEqual(prefixSnapshot(a.prefix), before);
    assert.deepEqual(fs.readFileSync(first.receipt), firstReceiptBytes);
    assert.ok(aliases > 0);
  } finally {
    Directory.prototype.read = originalRead;
  }
});

test('fix3 each switch binds a new generation to its receipt and no-op preserves it', (t) => {
  const a = fixture(t, 'A');
  const b = fixture(t, 'B');
  b.prefix = a.prefix;
  const first = apply(a);
  const firstReceipt = JSON.parse(fs.readFileSync(first.receipt));
  const firstSelection = JSON.parse(firstReceipt.after);
  assert.equal(firstReceipt.schemaVersion, 2);
  assert.equal(firstSelection.schemaVersion, 2);
  assert.match(firstSelection.generation, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(firstSelection.generation, firstReceipt.transaction);
  const beforeNoOp = prefixSnapshot(a.prefix);
  assert.equal(apply(a).status, 'NO_OP');
  assert.deepEqual(prefixSnapshot(a.prefix), beforeNoOp);
  const second = apply(b);
  const secondReceipt = JSON.parse(fs.readFileSync(second.receipt));
  assert.equal(secondReceipt.before, firstReceipt.after);
  const restored = apply(b, second.receipt);
  const restoredReceipt = JSON.parse(fs.readFileSync(restored.receipt));
  const restoredSelection = JSON.parse(restoredReceipt.after);
  assert.equal(restoredReceipt.operation, 'restore');
  assert.equal(restoredReceipt.before, secondReceipt.after);
  assert.equal(restoredSelection.manifestDigest, first.manifestDigest);
  assert.equal(restoredSelection.generation, restoredReceipt.transaction);
  assert.equal(
    new Set([firstSelection.generation, JSON.parse(secondReceipt.after).generation, restoredSelection.generation]).size,
    3
  );
  assert.equal(fs.readFileSync(path.join(a.prefix, 'current'), 'utf8'), restoredReceipt.after);
  for (const receipt of [first.receipt, second.receipt, restored.receipt])
    assert.throws(() => preview(a, receipt), /stale/);
});

test('fix3 inactive restore and reapply do not resurrect an original receipt', (t) => {
  const f = fixture(t);
  const first = apply(f);
  const firstReceipt = JSON.parse(fs.readFileSync(first.receipt));
  const inactive = apply(f, first.receipt);
  const inactiveReceipt = JSON.parse(fs.readFileSync(inactive.receipt));
  assert.equal(inactive.status, 'INACTIVE');
  assert.equal(inactiveReceipt.schemaVersion, 2);
  assert.equal(inactiveReceipt.after, null);
  assert.notEqual(inactiveReceipt.transaction, firstReceipt.transaction);
  const next = apply(f);
  const nextReceipt = JSON.parse(fs.readFileSync(next.receipt));
  assert.notEqual(JSON.parse(nextReceipt.after).generation, JSON.parse(firstReceipt.after).generation);
  assert.throws(() => preview(f, first.receipt), /stale/);
  assert.throws(() => preview(f, inactive.receipt), /stale/);
});

for (const [label, change] of [
  ['legacy schema', (value) => ({ schemaVersion: 1, manifestDigest: value.manifestDigest })],
  ['missing generation', (value) => ({ schemaVersion: 2, manifestDigest: value.manifestDigest })],
  ['malformed generation', (value) => ({ ...value, generation: 'not-a-uuid' })],
  ['non-v4 generation', (value) => ({ ...value, generation: '00000000-0000-0000-0000-000000000000' })],
  ['array generation', (value) => ({ ...value, generation: [value.generation] })],
  ['array manifest digest', (value) => ({ ...value, manifestDigest: [value.manifestDigest] })],
  ['unknown field', (value) => ({ ...value, extra: true })],
])
  test(`fix3 ${label} selector is refused without mutation or payload launch`, (t) => {
    const f = fixture(t);
    apply(f);
    const current = path.join(f.prefix, 'current');
    fs.writeFileSync(current, JSON.stringify(change(JSON.parse(fs.readFileSync(current)))));
    const before = prefixSnapshot(f.prefix);
    assert.throws(() => preview(f), /foreign_selector/);
    for (const command of ['hud', 'hud-run', 'hud-statusline', 'hud-mcp', 'codex-hud']) {
      const result = run(f, command);
      assert.notEqual(result.status, 0, `${command}: ${result.stderr}`);
      assert.equal(result.stdout, '', command);
      assert.match(result.stderr, /runtime_installation_inactive/);
    }
    assert.deepEqual(prefixSnapshot(f.prefix), before);
  });

for (const [label, change] of [
  ['legacy schema', (value) => ({ ...value, schemaVersion: 1 })],
  [
    'wrong generation binding',
    (value) => ({
      ...value,
      after: JSON.stringify({ ...JSON.parse(value.after), generation: '00000000-0000-4000-8000-000000000000' }),
    }),
  ],
])
  test(`fix3 ${label} receipt is refused and all evidence is retained`, (t) => {
    const f = fixture(t);
    const installed = apply(f);
    fs.writeFileSync(installed.receipt, JSON.stringify(change(JSON.parse(fs.readFileSync(installed.receipt)))));
    const before = prefixSnapshot(f.prefix);
    assert.throws(() => preview(f, installed.receipt), /foreign_receipt_contents/);
    assert.deepEqual(prefixSnapshot(f.prefix), before);
  });

for (const field of ['before', 'after'])
  test(`fix3 array-valued receipt ${field} is refused without mutation`, (t) => {
    const f = fixture(t);
    const installed = apply(f);
    const receipt = JSON.parse(fs.readFileSync(installed.receipt));
    receipt[field] = [receipt.after];
    fs.writeFileSync(installed.receipt, JSON.stringify(receipt));
    const before = prefixSnapshot(f.prefix);
    assert.throws(() => preview(f), /foreign_selector/);
    assert.deepEqual(prefixSnapshot(f.prefix), before);
  });

for (const phase of ['before-selection', 'after-selection'])
  test(`fix3 ${phase} interruption retains exact generation-bound recovery evidence`, (t) => {
    const a = fixture(t, 'A');
    const b = fixture(t, 'B');
    b.prefix = a.prefix;
    const first = apply(a);
    const firstReceipt = JSON.parse(fs.readFileSync(first.receipt));
    assert.throws(
      () =>
        apply(b, undefined, {
          checkpoint(at) {
            if (at === phase) throw Error('generation-fault');
          },
        }),
      /generation-fault.*do_not_retry/
    );
    const receiptName = fs
      .readdirSync(path.join(a.prefix, 'receipts'))
      .find((name) => path.join(a.prefix, 'receipts', name) !== first.receipt);
    const receipt = JSON.parse(fs.readFileSync(path.join(a.prefix, 'receipts', receiptName)));
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.before, firstReceipt.after);
    assert.equal(JSON.parse(receipt.after).generation, receipt.transaction);
    assert.notEqual(JSON.parse(receipt.after).generation, JSON.parse(receipt.before).generation);
    assert.equal(
      fs.readFileSync(path.join(a.prefix, 'current'), 'utf8'),
      phase === 'before-selection' ? receipt.before : receipt.after
    );
    if (phase === 'before-selection')
      assert.equal(fs.readFileSync(path.join(a.prefix, 'install-lock/next'), 'utf8'), receipt.after);
    assert.throws(() => preview(b), /locked/);
  });

test('help/default/preview are read-only and launch nothing', (t) => {
  const f = fixture(t);
  for (const args of [[], ['--help'], ['preview', '--prefix', f.prefix]]) {
    const result = spawnSync(process.execPath, [path.join(f.bundle, 'install-runtime.mjs'), ...args], {
      cwd: f.cwd,
      env: f.env,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(f.prefix), []);
    assert.deepEqual(fs.readdirSync(f.home), []);
  }
  assert.throws(() => planInstall(f.bundle, undefined));
});
test('fresh apply and explicit initially-absent restore stay standalone with punctuation in prefix', (t) => {
  const f = fixture(t);
  const plan = preview(f);
  const result = executeInstall(f.bundle, f.prefix, plan.planDigest);
  assert.equal(result.status, 'SELECTED');
  const verify = verifyBundle(path.join(f.prefix, 'releases', plan.bundleDigest));
  verify.directory.close();
  assert.equal(run(f, 'hud').stdout.trim(), 'A');
  assert.throws(() => executeInstall(f.bundle, f.prefix, plan.planDigest), /stale_plan/);
  assert.equal(apply(f).status, 'NO_OP');
  const restorePlan = preview(f, result.receipt);
  assert.equal(restorePlan.target, null);
  const restored = executeInstall(f.bundle, f.prefix, restorePlan.planDigest, result.receipt);
  assert.equal(restored.status, 'INACTIVE');
  assert.equal(fs.existsSync(path.join(f.prefix, 'current')), false);
  assert.match(run(f, 'hud').stderr, /inactive/);
  assert.equal(fs.readdirSync(path.join(f.prefix, 'releases')).length, 1);
  assert.deepEqual(fs.readdirSync(f.home), []);
});
test('A to B to A rollback preserves both immutable releases and source bundles', (t) => {
  const a = fixture(t, 'A');
  const b = fixture(t, 'B');
  b.prefix = a.prefix;
  const first = apply(a);
  const second = apply(b);
  assert.equal(run(a, 'hud').stdout.trim(), 'B');
  const restore = apply(b, second.receipt);
  assert.equal(restore.status, 'SELECTED');
  assert.equal(run(a, 'hud').stdout.trim(), 'A');
  assert.equal(fs.readdirSync(path.join(a.prefix, 'releases')).length, 2);
  assert.throws(() => preview(a, first.receipt), /stale/);
  for (const f of [a, b]) {
    const v = verifyBundle(f.bundle);
    v.directory.close();
  }
});
test('foreign paths, shims, lock and partial stage are never overwritten or cleared', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.prefix, 'foreign'), 'keep');
  assert.throws(() => preview(f), /foreign/);
  fs.unlinkSync(path.join(f.prefix, 'foreign'));
  fs.mkdirSync(path.join(f.prefix, 'install-lock'));
  assert.throws(() => preview(f), /locked/);
  fs.rmdirSync(path.join(f.prefix, 'install-lock'));
  apply(f);
  fs.writeFileSync(path.join(f.prefix, 'bin/hud'), 'foreign');
  assert.throws(() => preview(f), /foreign_shim/);
});
test('existing private canonical prefix and unchanged directory identity are required', (t) => {
  const f = fixture(t);
  assert.throws(() => planInstall(f.bundle, f.prefix + '/absent'));
  fs.chmodSync(f.prefix, 0o755);
  assert.throws(() => preview(f), /private/);
  fs.chmodSync(f.prefix, 0o700);
  fs.symlinkSync(f.prefix, path.join(f.root, 'alias'));
  assert.throws(() => planInstall(f.bundle, path.join(f.root, 'alias')));
  const plan = preview(f);
  fs.renameSync(f.prefix, f.prefix + '-old');
  fs.mkdirSync(f.prefix, { mode: 0o700 });
  assert.throws(() => executeInstall(f.bundle, f.prefix, plan.planDigest), /stale_plan/);
});
test('replaced source content and symlinked installed paths reject stale plans', (t) => {
  const f = fixture(t);
  const plan = preview(f);
  fs.appendFileSync(path.join(f.bundle, 'bin/hud'), 'change');
  assert.throws(() => executeInstall(f.bundle, f.prefix, plan.planDigest), /integrity/);
  assert.deepEqual(fs.readdirSync(f.prefix), []);
  const g = fixture(t);
  apply(g);
  fs.unlinkSync(path.join(g.prefix, 'bin/hud'));
  fs.symlinkSync('/dev/null', path.join(g.prefix, 'bin/hud'));
  assert.throws(() => preview(g));
});
test('concurrent apply is refused by the first transaction lock', (t) => {
  const f = fixture(t);
  const plan = preview(f);
  const result = executeInstall(f.bundle, f.prefix, plan.planDigest, undefined, {
    checkpoint(phase) {
      if (phase === 'locked') {
        const other = spawnSync(
          process.execPath,
          [path.join(f.bundle, 'install-runtime.mjs'), 'apply', '--prefix', f.prefix, '--expect', plan.planDigest],
          { cwd: f.cwd, env: f.env, encoding: 'utf8', timeout: 5000 }
        );
        assert.equal(other.status, 1);
        assert.match(other.stderr, /locked/);
      }
    },
  });
  assert.equal(result.status, 'SELECTED');
});
for (const phase of ['before-selection', 'after-selection'])
  test(`fault ${phase} retains inspectable receipt and lock, never auto-retries`, (t) => {
    const f = fixture(t);
    assert.throws(
      () =>
        apply(f, undefined, {
          checkpoint(at) {
            if (at === phase) throw new Error('injected-fault');
          },
        }),
      /inspect_recovery_receipt=.*do_not_retry/
    );
    assert.equal(fs.existsSync(path.join(f.prefix, 'current')), phase === 'after-selection');
    const names = fs.readdirSync(path.join(f.prefix, 'receipts'));
    assert.equal(names.length, 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(f.prefix, 'receipts', names[0])));
    assert.equal(receipt.before, null);
    assert.match(receipt.after, /manifestDigest/);
    assert.match(receipt.recovery, /Inspect current/);
    assert.throws(() => preview(f), /locked/);
  });
test('mid-transaction ancestor replacement cannot redirect writes to replacement', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      apply(f, undefined, {
        checkpoint(at) {
          if (at === 'before-selection') {
            fs.renameSync(f.prefix, f.prefix + '-moved');
            fs.mkdirSync(f.prefix, { mode: 0o700 });
          }
        },
      }),
    /identity_changed/
  );
  assert.deepEqual(fs.readdirSync(f.prefix), []);
  assert.equal(fs.existsSync(path.join(f.prefix + '-moved', 'current')), false);
});
test('restore binds original prefix, exact selected inode and owned shim state', (t) => {
  const f = fixture(t);
  const installed = apply(f);
  const selector = path.join(f.prefix, 'current');
  const bytes = fs.readFileSync(selector);
  fs.renameSync(selector, path.join(f.root, 'old-selector'));
  fs.writeFileSync(selector, bytes, { mode: 0o600 });
  assert.throws(() => preview(f, installed.receipt), /stale/);
  const g = fixture(t);
  apply(g);
  assert.throws(() => preview(g, installed.receipt), /pinned_prefix/);
});
test('source mutation during staging prevents selection and retains lock', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      apply(f, undefined, {
        checkpoint(at) {
          if (at === 'staged') fs.appendFileSync(path.join(f.bundle, 'bin/hud'), 'mutation');
        },
      }),
    /integrity.*installation_locked/
  );
  assert.equal(fs.existsSync(path.join(f.prefix, 'current')), false);
});
test('partial staging and missing installed dependency are refused without repair', (t) => {
  const f = fixture(t);
  const installed = apply(f);
  fs.mkdirSync(path.join(f.prefix, 'releases/staging-foreign'));
  assert.throws(() => preview(f), /partial_or_foreign_release/);
  fs.rmdirSync(path.join(f.prefix, 'releases/staging-foreign'));
  fs.unlinkSync(path.join(f.prefix, 'releases', installed.manifestDigest, 'node_modules/chokidar/package.json'));
  assert.throws(() => preview(f), /unlisted_or_missing/);
});
test('restore rejects changed shims and preserves current selection', (t) => {
  const f = fixture(t);
  const installed = apply(f);
  const plan = preview(f, installed.receipt);
  fs.appendFileSync(path.join(f.prefix, 'bin/hud'), '// foreign');
  assert.throws(() => executeInstall(f.bundle, f.prefix, plan.planDigest, installed.receipt), /foreign_shim/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.prefix, 'current'))).manifestDigest, installed.manifestDigest);
});
test('partial owned directories and foreign receipt contents are refused', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.prefix, 'releases'), { mode: 0o700 });
  assert.throws(() => preview(f), /partial_installation_directories/);
  const g = fixture(t);
  apply(g);
  fs.writeFileSync(path.join(g.prefix, 'receipts/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.json'), '{}', { mode: 0o600 });
  assert.throws(() => preview(g), /foreign_receipt_contents/);
});
for (const [name, mode] of [
  ['bin', 0o777],
  ['RUNTIME-MANIFEST.json', 0o777],
  ['bin/hud', 0o4700],
])
  test(`fix1 installed permission drift blocks NO_OP: ${name}`, (t) => {
    const f = fixture(t);
    const installed = apply(f);
    const plan = preview(f);
    fs.chmodSync(path.join(f.prefix, 'releases', installed.manifestDigest, name), mode);
    assert.throws(() => executeInstall(f.bundle, f.prefix, plan.planDigest), /mode|permission|private|integrity/);
  });
test('fix1 receipt capacity is reserved before apply/restore; same-package NO_OP stays available', (t) => {
  const a = fixture(t, 'A');
  const b = fixture(t, 'B');
  b.prefix = a.prefix;
  const installed = apply(a);
  const original = JSON.parse(fs.readFileSync(installed.receipt));
  for (let i = 1; i < 1024; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    fs.writeFileSync(
      path.join(a.prefix, 'receipts', id + '.json'),
      JSON.stringify({
        ...original,
        transaction: id,
        after: JSON.stringify({ ...JSON.parse(original.after), generation: id }),
      }),
      { mode: 0o600 }
    );
  }
  assert.equal(apply(a).status, 'NO_OP');
  assert.throws(() => preview(b), /receipt_capacity/);
  assert.throws(() => preview(a, installed.receipt), /receipt_capacity/);
  assert.equal(fs.existsSync(path.join(a.prefix, 'install-lock')), false);
});
test('fix1 output ENOSPC preserves selected outcome, receipt and inspection barrier', (t) => {
  const f = fixture(t);
  const plan = preview(f);
  const output = fs.openSync('/dev/full', 'w');
  let result;
  try {
    result = spawnSync(
      process.execPath,
      [path.join(f.bundle, 'install-runtime.mjs'), 'apply', '--prefix', f.prefix, '--expect', plan.planDigest],
      { cwd: f.cwd, env: f.env, encoding: 'utf8', stdio: ['ignore', output, 'pipe'], timeout: 5000 }
    );
  } finally {
    fs.closeSync(output);
  }
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /terminal_output_failed.*inspect_recovery_receipt=/s);
  assert.equal(fs.existsSync(path.join(f.prefix, 'current')), true);
  assert.equal(fs.existsSync(path.join(f.prefix, 'install-lock')), true);
});
test('fix1 lock removal fsync failure reports real state and restores an inspection barrier', async (t) => {
  const f = fixture(t);
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const mutable = createRequire(import.meta.url)('node:fs');
  const originalSync = mutable.fsyncSync;
  const originalRemove = mutable.rmdirSync;
  let removed = false;
  let injected = false;
  mutable.rmdirSync = function (file, ...args) {
    const result = originalRemove(file, ...args);
    if (String(file).endsWith('/install-lock')) removed = true;
    return result;
  };
  mutable.fsyncSync = function (fd) {
    if (removed && !injected) {
      injected = true;
      const e = Error('injected EIO after lock rmdir');
      e.code = 'EIO';
      throw e;
    }
    return originalSync(fd);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => apply(f), /finalization_uncertain.*inspection_barrier=(?:restored|present)/);
  } finally {
    mutable.fsyncSync = originalSync;
    mutable.rmdirSync = originalRemove;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  assert.equal(fs.existsSync(path.join(f.prefix, 'install-lock')), true);
});
for (const command of ['hud', 'hud-run', 'hud-statusline', 'hud-mcp'])
  test(`fix1 ${command} runs in original PID with direct parent, argv, stdin, fd3 and exit code`, async (t) => {
    const f = fixture(t);
    const { replaceFixtureFile } = await import('../../scripts/runtime-package/test-fixture.mjs');
    const { COMMANDS } = await import('../../scripts/runtime-package/manifest.mjs');
    const target = COMMANDS[command];
    replaceFixtureFile(
      f,
      target,
      "import fs from 'node:fs';console.log(JSON.stringify({pid:process.pid,ppid:process.ppid,argv:process.argv.slice(1),input:fs.readFileSync(0,'utf8'),extra:fs.readFileSync(3,'utf8')}));process.exitCode=23;\n"
    );
    const installed = apply(f);
    const extra = path.join(f.root, 'fd3');
    fs.writeFileSync(extra, 'inherited fd3');
    const fd = fs.openSync(extra, 'r');
    let result;
    const args = ['space quote \' \" $()', 'line\nbreak'];
    try {
      result = spawnSync(path.join(f.prefix, 'bin', command), args, {
        cwd: f.cwd,
        env: f.env,
        input: 'stdin then EOF',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe', fd],
        timeout: 5000,
      });
    } finally {
      fs.closeSync(fd);
    }
    assert.equal(result.status, 23, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.pid, result.pid);
    assert.equal(observed.ppid, process.pid);
    assert.equal(observed.input, 'stdin then EOF');
    assert.equal(observed.extra, 'inherited fd3');
    assert.deepEqual(observed.argv, [path.join(f.prefix, 'releases', installed.manifestDigest, target), ...args]);
  });
for (const command of ['hud-mcp', 'codex-hud'])
  for (const signal of ['SIGINT', 'SIGTERM'])
    test(`fix1 installed ${command} ${signal} leaves no payload and preserves PID/PPID`, async (t) => {
      const f = fixture(t);
      const { replaceFixtureFile, installedSignalCode } =
        await import('../../scripts/runtime-package/test-fixture.mjs');
      const { COMMANDS } = await import('../../scripts/runtime-package/manifest.mjs');
      const body =
        "const fs=require('node:fs');const stat=fs.readFileSync('/proc/self/stat','utf8');fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,ppid:process.ppid,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]}));setTimeout(()=>process.exit(0),5000);setInterval(()=>{},100);";
      const text =
        command === 'codex-hud'
          ? `#!/usr/bin/env bash\nexec node -e '${body.replaceAll("'", "'\\''")}' "$@"\n`
          : `import fs from 'node:fs';const stat=fs.readFileSync('/proc/self/stat','utf8');fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,ppid:process.ppid,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]}));setTimeout(()=>process.exit(0),5000);setInterval(()=>{},100);\n`;
      replaceFixtureFile(f, COMMANDS[command], text);
      apply(f);
      const result = spawnSync(
        '/usr/bin/python3',
        ['-c', installedSignalCode(), path.join(f.prefix, 'bin', command), f.cwd, signal],
        { env: f.env, encoding: 'utf8', timeout: 8500 }
      );
      assert.equal(result.status, 0, result.stderr);
      const observed = JSON.parse(result.stdout);
      t.diagnostic(JSON.stringify(observed));
      assert.equal(observed.error, null, JSON.stringify(observed));
      assert.equal(observed.reaped, true);
      assert.equal(observed.aliveAfterSignal, false, JSON.stringify(observed));
      assert.equal(observed.payload.pid, observed.launcherPid);
      assert.equal(observed.payload.ppid, observed.parentPid);
      assert.equal(observed.launcherCode, signal === 'SIGINT' ? -2 : -15);
    });
test('fix1 release capacity reserves a slot for upgrade but permits existing selection and restore', async (t) => {
  const a = fixture(t, 'A');
  const b = fixture(t, 'B');
  b.prefix = a.prefix;
  const installed = apply(a);
  const { digest, json } = await import('../../scripts/runtime-package/safety.mjs');
  for (let i = 1; i < 64; i++) {
    const value = { ...a.manifest, provenance: `synthetic release ${i}` };
    const raw = json(value);
    const release = path.join(a.prefix, 'releases', digest(raw));
    fs.cpSync(a.bundle, release, { recursive: true });
    fs.writeFileSync(path.join(release, 'RUNTIME-MANIFEST.json'), raw, { mode: 0o600 });
  }
  assert.equal(apply(a).status, 'NO_OP');
  assert.equal(preview(a, installed.receipt).target, null);
  assert.throws(() => preview(b), /release_capacity/);
  assert.equal(fs.existsSync(path.join(a.prefix, 'install-lock')), false);
});
test('fix1 legacy exec preserves newline prefix, metacharacter argv, stdin and natural exit', async (t) => {
  const f = fixture(t);
  const renamed = path.join(f.root, 'prefix with\nnewline \' "$()');
  fs.renameSync(f.prefix, renamed);
  f.prefix = renamed;
  const { replaceFixtureFile } = await import('../../scripts/runtime-package/test-fixture.mjs');
  const body =
    "const fs=require('node:fs');console.log(JSON.stringify({pid:process.pid,ppid:process.ppid,args:process.argv.slice(1),input:fs.readFileSync(0,'utf8')}));process.exitCode=29;";
  replaceFixtureFile(f, 'bin/codex-hud', `#!/bin/bash\nexec node -e '${body.replaceAll("'", "'\\''")}' "$@"\n`);
  apply(f);
  const args = ['with space', '\'$()"', 'line\nbreak'];
  const result = spawnSync(path.join(f.prefix, 'bin/codex-hud'), args, {
    env: f.env,
    cwd: f.cwd,
    input: 'EOF preserved',
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 29, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.pid, result.pid);
  assert.equal(observed.ppid, process.pid);
  assert.deepEqual(observed.args, args);
  assert.equal(observed.input, 'EOF preserved');
});
for (const signal of ['SIGINT', 'SIGTERM'])
  test(`fix1 legacy selector ${signal} is reaped without launching payload`, async (t) => {
    const f = fixture(t);
    const { replaceFixtureFile, installedSignalCode } = await import('../../scripts/runtime-package/test-fixture.mjs');
    const marker = path.join(f.root, 'payload-launched');
    replaceFixtureFile(f, 'bin/codex-hud', `#!/bin/bash\nprintf reached > '${marker}'\n`);
    apply(f);
    const tools = path.join(f.root, 'tools');
    fs.mkdirSync(tools, { mode: 0o700 });
    // The trusted test replacement delays only the selector, with an absolute self-deadline.
    const pidfile = path.join(f.cwd, 'payload.json');
    const body = `const fs=require('node:fs');const stat=fs.readFileSync('/proc/self/stat','utf8');fs.writeFileSync(${JSON.stringify(pidfile)},JSON.stringify({pid:process.pid,ppid:process.ppid,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]}));setTimeout(()=>process.exit(0),5000);setInterval(()=>{},100);`;
    fs.writeFileSync(
      path.join(tools, 'node'),
      `#!/bin/bash\nexec '${process.execPath}' -e '${body.replaceAll("'", "'\\''")}' runtime-installed-signal-fixture\n`,
      { mode: 0o700 }
    );
    const result = spawnSync(
      '/usr/bin/python3',
      ['-c', installedSignalCode(), path.join(f.prefix, 'bin/codex-hud'), f.cwd, signal],
      { env: { ...f.env, PATH: tools + ':' + f.env.PATH }, encoding: 'utf8', timeout: 8500 }
    );
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    t.diagnostic(JSON.stringify(observed));
    assert.equal(observed.error, null, JSON.stringify(observed));
    assert.equal(observed.reaped, true);
    assert.equal(observed.aliveAfterSignal, false, JSON.stringify(observed));
    assert.equal(fs.existsSync(marker), false);
    assert.equal(observed.launcherCode, signal === 'SIGINT' ? 130 : 143);
  });
test('fix1 legacy selector timeout is bounded and cannot start payload', async (t) => {
  const f = fixture(t);
  const { replaceFixtureFile } = await import('../../scripts/runtime-package/test-fixture.mjs');
  const marker = path.join(f.root, 'payload-launched');
  replaceFixtureFile(f, 'bin/codex-hud', `#!/bin/bash\nprintf reached > '${marker}'\n`);
  apply(f);
  const tools = path.join(f.root, 'tools');
  fs.mkdirSync(tools, { mode: 0o700 });
  const childFile = path.join(f.root, 'selector-timeout.pid');
  const body = `require('node:fs').writeFileSync(${JSON.stringify(childFile)},String(process.pid));setTimeout(()=>{},6000);`;
  fs.writeFileSync(
    path.join(tools, 'node'),
    `#!/bin/bash\nexec '${process.execPath}' -e '${body.replaceAll("'", "'\\''")}'\n`,
    { mode: 0o700 }
  );
  const result = spawnSync(path.join(f.prefix, 'bin/codex-hud'), [], {
    env: { ...f.env, PATH: tools + ':' + f.env.PATH },
    encoding: 'utf8',
    timeout: 7500,
  });
  assert.equal(result.status, 5, result.stderr);
  assert.match(result.stderr, /timed_out/);
  assert.equal(fs.existsSync(marker), false);
  const pid = Number(fs.readFileSync(childFile, 'utf8'));
  assert.equal(fs.existsSync(`/proc/${pid}`), false);
  t.diagnostic(JSON.stringify({ selectorPid: pid, reaped: true, deadlineMs: 7500 }));
});
test('fix1 restore output failure retains inactive selection and its recovery barrier', (t) => {
  const f = fixture(t);
  const installed = apply(f);
  const plan = preview(f, installed.receipt);
  const fd = fs.openSync('/dev/full', 'w');
  let result;
  try {
    result = spawnSync(
      process.execPath,
      [
        path.join(f.bundle, 'install-runtime.mjs'),
        'restore',
        '--prefix',
        f.prefix,
        '--receipt',
        installed.receipt,
        '--expect',
        plan.planDigest,
      ],
      { env: f.env, cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', fd, 'pipe'], timeout: 5000 }
    );
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(result.status, 1);
  assert.match(result.stderr, /terminal_output_failed.*inspect_recovery_receipt=/s);
  assert.equal(fs.existsSync(path.join(f.prefix, 'current')), false);
  assert.equal(fs.existsSync(path.join(f.prefix, 'install-lock')), true);
});
test('fix1 legacy selector cannot hang after emitting a valid path', async (t) => {
  const f = fixture(t);
  const { replaceFixtureFile, installedSignalCode } = await import('../../scripts/runtime-package/test-fixture.mjs');
  const marker = path.join(f.root, 'payload-launched');
  replaceFixtureFile(f, 'bin/codex-hud', `#!/bin/bash\nprintf reached > '${marker}'\n`);
  const installed = apply(f);
  const tools = path.join(f.root, 'tools');
  fs.mkdirSync(tools, { mode: 0o700 });
  const pidfile = path.join(f.cwd, 'payload.json');
  const entry = path.join(f.prefix, 'releases', installed.manifestDigest, 'bin/codex-hud');
  const body = `const fs=require('node:fs');const stat=fs.readFileSync('/proc/self/stat','utf8');fs.writeFileSync(${JSON.stringify(pidfile)},JSON.stringify({pid:process.pid,ppid:process.ppid,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]}));process.stdout.write(${JSON.stringify(entry)}+'\\0');setTimeout(()=>process.exit(0),8000);setInterval(()=>{},100);`;
  fs.writeFileSync(
    path.join(tools, 'node'),
    `#!/bin/bash\nexec '${process.execPath}' -e '${body.replaceAll("'", "'\\''")}' runtime-installed-signal-fixture\n`,
    { mode: 0o700 }
  );
  const result = spawnSync(
    '/usr/bin/python3',
    ['-c', installedSignalCode(), path.join(f.prefix, 'bin/codex-hud'), f.cwd, 'NONE'],
    { env: { ...f.env, PATH: tools + ':' + f.env.PATH }, encoding: 'utf8', timeout: 10500 }
  );
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  t.diagnostic(JSON.stringify(observed));
  assert.equal(observed.error, null, JSON.stringify(observed));
  assert.equal(observed.reaped, true);
  assert.equal(observed.launcherCode, 5);
  assert.equal(fs.existsSync(marker), false);
});
async function selectorCase(t, behavior, signal = 'NONE', unknownObservation = false) {
  const f = fixture(t);
  const { replaceFixtureFile, installedSignalCode } = await import('../../scripts/runtime-package/test-fixture.mjs');
  const marker = path.join(f.root, 'payload-launched');
  replaceFixtureFile(f, 'bin/codex-hud', `#!/bin/bash\nprintf reached > '${marker}'\n`);
  const installed = apply(f);
  const tools = path.join(f.root, 'tools');
  fs.mkdirSync(tools, { mode: 0o700 });
  const entry = path.join(f.prefix, 'releases', installed.manifestDigest, 'bin/codex-hud');
  const pidfile = path.join(f.cwd, 'payload.json');
  const observe = `fs.writeFileSync(${JSON.stringify(pidfile)},JSON.stringify({pid:process.pid,ppid:process.ppid,start}));`;
  let action = behavior === 'reading' ? observe : `fs.writeSync(1,${JSON.stringify(entry)}+'\\0');`;
  if (behavior === 'close-output') action += 'fs.closeSync(1);' + observe;
  else if (behavior === 'nonzero') action += observe + 'process.exitCode=7;';
  else if (behavior === 'success') action += observe;
  else if (behavior !== 'reading') action += `setTimeout(()=>{${observe}},100);`;
  if (!['nonzero', 'success'].includes(behavior))
    action += 'setTimeout(()=>process.exit(0),8000);setInterval(()=>{},100);';
  const body = `const fs=require('node:fs');const stat=fs.readFileSync('/proc/self/stat','utf8');const start=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];${action}`;
  fs.writeFileSync(
    path.join(tools, 'node'),
    `#!/bin/bash\nexec '${process.execPath}' -e '${body.replaceAll("'", "'\\''")}' runtime-installed-signal-fixture\n`,
    { mode: 0o700 }
  );
  const launcher = path.join(f.prefix, 'bin/codex-hud');
  if (unknownObservation)
    fs.writeFileSync(
      launcher,
      fs
        .readFileSync(launcher, 'utf8')
        .replace(
          'selector_state() {',
          'selector_state() {\n  return 2 # synthetic observation failure only; never a production override'
        )
    );
  const result = spawnSync('/usr/bin/python3', ['-c', installedSignalCode(), launcher, f.cwd, signal], {
    env: { ...f.env, PATH: tools + ':' + f.env.PATH },
    encoding: 'utf8',
    timeout: 10500,
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  t.diagnostic(JSON.stringify(observed));
  assert.equal(observed.error, null, JSON.stringify(observed));
  assert.equal(observed.reaped, true);
  assert.equal(fs.existsSync(marker), behavior === 'success');
  return observed;
}
for (const behavior of ['close-output', 'nonzero', 'success'])
  test(`fix1 selector ${behavior} requires actual timely zero exit before payload`, async (t) => {
    const observed = await selectorCase(t, behavior);
    assert.equal(observed.launcherCode, behavior === 'success' ? 0 : 5);
    assert.equal(observed.aliveAfterSignal, false);
  });
for (const [phase, signal] of [
  ['reading', 'SIGHUP'],
  ['waiting', 'SIGINT'],
  ['waiting', 'SIGTERM'],
  ['waiting', 'SIGHUP'],
])
  test(`fix1 selector ${signal} during ${phase} never launches payload`, async (t) => {
    const observed = await selectorCase(t, phase, signal);
    assert.equal(observed.launcherCode, { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal]);
    assert.equal(observed.aliveAfterSignal, false);
  });
test('fix1 unknown selector cleanup is bounded, reports UNKNOWN and does not pretend shim reap', async (t) => {
  const observed = await selectorCase(t, 'waiting', 'NONE', true);
  assert.equal(observed.launcherCode, 5);
  assert.match(observed.stderr, /cleanup=UNKNOWN/);
  assert.equal(observed.aliveAfterSignal, true);
  assert.equal(observed.reapEvidence, 'harness_waitpid');
});

const nativeExitCases = [
  ['unsettled TLA', 'await new Promise(() => {});', 13, true],
  ['unsettled TLA explicit23', 'process.exitCode=23; await new Promise(() => {});', 23, true],
  ['timer settled TLA23', 'await new Promise(r=>setTimeout(r,20)); process.exitCode=23;', 23, true],
  ['explicit exit0', 'process.exit(0);', 0, true],
  [
    'beforeExit starts work23',
    "await new Promise(r=>process.once('beforeExit',()=>setTimeout(r,20))); process.exitCode=23;",
    23,
    true,
  ],
  ['wrapper throw', "throw new Error('synthetic_wrapper_failure');", 1, false],
  ['wrapper rejected TLA', "await Promise.reject(new Error('synthetic_wrapper_failure'));", 1, false],
];
for (const [name, body, expected, realWrapper] of nativeExitCases)
  test(`fix2 native exit semantics: ${name}`, async (t) => {
    const f = fixture(t);
    const { replaceFixtureFile, rewriteManifest } = await import('../../scripts/runtime-package/test-fixture.mjs');
    const { digest } = await import('../../scripts/runtime-package/safety.mjs');
    const target = 'packages/hud-mcp/bin/hud-mcp.mjs';
    replaceFixtureFile(
      f,
      target,
      realWrapper ? fs.readFileSync(new URL('../../packages/hud-mcp/bin/hud-mcp.mjs', import.meta.url)) : body + '\n'
    );
    if (realWrapper) {
      const main = 'packages/hud-mcp/dist/packages/hud-mcp/src/main.js';
      const bytes = Buffer.from(body + '\n');
      fs.mkdirSync(path.dirname(path.join(f.bundle, main)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(f.bundle, main), bytes, { mode: 0o600 });
      f.manifest.entries.push({ path: main, bytes: bytes.length, sha256: digest(bytes), mode: '0600' });
      rewriteManifest(f, () => {});
    }
    const installed = apply(f);
    const direct = path.join(f.prefix, 'releases', installed.manifestDigest, target);
    const launcher = path.join(f.prefix, 'bin/hud-mcp');
    const invocations = [
      [process.execPath, [direct]],
      [process.execPath, [launcher]],
      [launcher, []],
    ];
    const results = invocations.map(([command, args]) => {
      const start = Date.now();
      const result = spawnSync(command, args, {
        cwd: f.cwd,
        env: f.env,
        encoding: 'utf8',
        timeout: 3000,
        killSignal: 'SIGKILL',
      });
      t.diagnostic(
        JSON.stringify({
          command: [command, ...args],
          startedAtMs: start,
          deadlineAtMs: start + 3000,
          endedAtMs: Date.now(),
          ownedPid: result.pid,
          waitedStatus: result.status,
          signal: result.signal,
          error: result.error?.message,
          stderr: result.stderr,
        })
      );
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      return result;
    });
    assert.equal(results[0].status, expected, results[0].stderr);
    for (const result of results.slice(1)) {
      assert.equal(result.status, results[0].status, result.stderr);
      if (expected === 13) assert.match(result.stderr, /unsettled top-level await/i);
      if (!realWrapper) assert.match(result.stderr, /synthetic_wrapper_failure/);
    }
  });
for (const command of ['hud', 'hud-run', 'hud-statusline', 'hud-mcp'])
  test(`fix2 ${command} has explicit ESM scope below CommonJS ancestor`, (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, 'package.json'), '{"type":"commonjs"}\n', { mode: 0o600 });
    const installed = apply(f);
    const marker = path.join(f.prefix, 'bin/package.json');
    assert.equal(fs.readFileSync(marker, 'utf8'), '{"type":"module"}\n');
    assert.equal(fs.lstatSync(marker).mode & 0o7777, 0o600);
    assert.equal(run(f, command).stdout.trim(), 'A');
    const state = preview(f).state.shims;
    assert.equal(Object.keys(state).length, 6);
    assert.deepEqual(JSON.parse(fs.readFileSync(installed.receipt)).shims, state);
  });
for (const damage of [
  'missing',
  'malformed',
  'commonjs',
  'extra',
  'mode',
  'special-mode',
  'symlink',
  'hardlink',
  'bin-mode',
  'bin-symlink',
])
  test(`fix2 launch metadata ${damage} refuses preview, no-op and payload`, (t) => {
    const f = fixture(t);
    apply(f);
    const marker = path.join(f.prefix, 'bin/package.json');
    // The expected marker must already exist; never repair a pre-marker layout.
    assert.equal(fs.readFileSync(marker, 'utf8'), '{"type":"module"}\n');
    if (damage === 'missing') fs.unlinkSync(marker);
    if (damage === 'malformed') fs.writeFileSync(marker, '{');
    if (damage === 'commonjs') fs.writeFileSync(marker, '{"type":"commonjs"}\n');
    if (damage === 'extra') fs.writeFileSync(marker, '{"type":"module","extra":1}\n');
    if (damage === 'mode') fs.chmodSync(marker, 0o644);
    if (damage === 'special-mode') fs.chmodSync(marker, 0o4600);
    if (damage === 'symlink') {
      fs.renameSync(marker, marker + '-outside');
      fs.symlinkSync(marker + '-outside', marker);
    }
    if (damage === 'hardlink') fs.linkSync(marker, path.join(f.root, 'marker-link'));
    if (damage === 'bin-mode') fs.chmodSync(path.dirname(marker), 0o755);
    if (damage === 'bin-symlink') {
      fs.renameSync(path.dirname(marker), path.join(f.prefix, 'bin-real'));
      fs.symlinkSync('bin-real', path.dirname(marker));
    }
    assert.throws(() => preview(f));
    assert.throws(() => apply(f));
    const result = run(f, 'hud');
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(result.stdout, '', 'NO_PAYLOAD: synthetic payload must not print A');
  });
test('fix2 identical marker replacement invalidates an existing plan and restore receipt', (t) => {
  const a = fixture(t);
  const b = fixture(t, 'B');
  b.prefix = a.prefix;
  const first = apply(a);
  const plan = preview(b);
  const marker = path.join(a.prefix, 'bin/package.json');
  assert.equal(fs.readFileSync(marker, 'utf8'), '{"type":"module"}\n');
  fs.renameSync(marker, path.join(a.root, 'previous-marker'));
  fs.writeFileSync(marker, '{"type":"module"}\n', { mode: 0o600 });
  assert.throws(() => executeInstall(b.bundle, b.prefix, plan.planDigest), /stale_plan/);
  assert.throws(() => preview(a, first.receipt), /stale_or_foreign_receipt/);
  assert.equal(fs.existsSync(path.join(a.prefix, 'install-lock')), false);
});
test('fix2 pre-switch marker replacement keeps selection absent and retains recovery barrier', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      apply(f, undefined, {
        checkpoint(phase) {
          if (phase !== 'before-selection') return;
          const marker = path.join(f.prefix, 'bin/package.json');
          fs.renameSync(marker, path.join(f.root, 'previous-marker'));
          fs.writeFileSync(marker, '{"type":"module"}\n', { mode: 0o600 });
        },
      }),
    /shim_changed_before_switch.*inspect_recovery_receipt=/
  );
  assert.equal(fs.existsSync(path.join(f.prefix, 'current')), false);
  assert.equal(fs.existsSync(path.join(f.prefix, 'install-lock')), true);
  assert.equal(fs.readdirSync(path.join(f.prefix, 'receipts')).length, 1);
});
test('fix2 metadata identity survives A to B to A and initially-absent restore', (t) => {
  const a = fixture(t);
  const b = fixture(t, 'B');
  b.prefix = a.prefix;
  apply(a);
  const marker = preview(a).state.shims['package.json'];
  assert.ok(marker);
  const second = apply(b);
  apply(b, second.receipt);
  assert.deepEqual(preview(a).state.shims['package.json'], marker);
  assert.equal(run(a, 'hud').stdout.trim(), 'A');
  const fresh = fixture(t);
  const first = apply(fresh);
  const original = preview(fresh).state.shims['package.json'];
  apply(fresh, first.receipt);
  assert.deepEqual(preview(fresh).state.shims['package.json'], original);
  assert.equal(fs.readFileSync(path.join(fresh.prefix, 'bin/package.json'), 'utf8'), '{"type":"module"}\n');
  assert.match(run(fresh, 'hud').stderr, /inactive/);
});

for (const command of ['hud', 'hud-run', 'hud-statusline', 'hud-mcp'])
  test(`fix2 ${command} CommonJS marker refuses both node and shebang with NO_PAYLOAD`, (t) => {
    const f = fixture(t);
    apply(f);
    const launcher = path.join(f.prefix, 'bin', command);
    // All four synthetic payloads print A. Empty output affirmatively proves
    // they were not reached, unlike an unresolved-TLA payload that prints nothing.
    assert.equal(run(f, command).stdout.trim(), 'A');
    fs.writeFileSync(path.join(f.prefix, 'bin/package.json'), '{"type":"commonjs"}\n');
    const observations = [
      [process.execPath, [launcher]],
      [launcher, []],
    ].map(([exe, args]) => {
      const startedAtMs = Date.now();
      const result = spawnSync(exe, args, {
        cwd: f.cwd,
        env: f.env,
        encoding: 'utf8',
        timeout: 3000,
        killSignal: 'SIGKILL',
      });
      t.diagnostic(
        JSON.stringify({
          command: [exe, ...args],
          startedAtMs,
          deadlineAtMs: startedAtMs + 3000,
          endedAtMs: Date.now(),
          ownedPid: result.pid,
          waitedStatus: result.status,
          signal: result.signal,
          error: result.error?.message,
          stdout: result.stdout,
          stderr: result.stderr,
        })
      );
      return result;
    });
    for (const result of observations) {
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.notEqual(result.status, 0, result.stderr);
      assert.equal(result.stdout, '', 'NO_PAYLOAD');
    }
  });
