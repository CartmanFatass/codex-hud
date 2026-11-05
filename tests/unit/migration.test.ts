import { migrateCommand } from '../../src/cli/migrate.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { applyMigration, previewMigration, restoreMigration, MAPPING } from '../../src/core/migration/index.js';
const mutable = createRequire(import.meta.url)('node:fs') as typeof fs;
function fixture(t: TestContext, existing = true) {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-migration-'));
  const source = join(home, 'source'),
    target = join(home, 'target');
  fs.mkdirSync(source, { mode: 0o700 });
  fs.mkdirSync(target, { mode: 0o700 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const input = join(source, 'hud-settings.json'),
    output = join(target, 'hud-settings.json');
  fs.writeFileSync(
    input,
    JSON.stringify({
      theme: 'latte',
      timelinePane: 'folded',
      language: 'zh',
      briefing: 'api',
      briefingApiKey: 'SOURCE-SECRET',
      notify: true,
      authorization: 'DO-NOT-COPY',
    }),
    { mode: 0o600 }
  );
  const original = '{  "theme" : "mocha", "briefing":"off", "briefingApiKey":"TARGET-SECRET", "unrelated": [3,2,1] }\n';
  if (existing) fs.writeFileSync(output, original, { mode: 0o600 });
  const selection = { source, target, mapping: MAPPING };
  const preview = () => previewMigration(selection);
  const apply = () => applyMigration(selection, preview().inputDigest);
  const run = (args: string[]) =>
    spawnSync(process.execPath, [resolve('bin/hud'), ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        HUD_HOME: join(home, 'never-open'),
        CODEX_HOME: join(home, 'never-read'),
      },
      encoding: 'utf8',
      timeout: 5000,
    });
  return { home, source, target, input, output, original, selection, preview, apply, run };
}
test('preview is exact/read-only and only allowlisted presentation changes are copied', (t) => {
  const f = fixture(t);
  const before = fs.readdirSync(f.target);
  const plan = f.preview();
  assert.deepEqual(fs.readdirSync(f.target), before);
  assert.equal(fs.readFileSync(f.output, 'utf8'), f.original);
  assert.equal(plan.target, f.output);
  assert.equal(plan.source, f.input);
  assert.equal(plan.excludedSourceKeys, 4);
  assert.deepEqual(plan.changes, [
    { key: 'theme', before: 'mocha', after: 'latte' },
    { key: 'timelinePane', before: null, after: 'closed' },
    { key: 'language', before: null, after: 'zh' },
  ]);
  assert.doesNotMatch(JSON.stringify(plan), /SECRET|DO-NOT-COPY/);
  const result = f.apply();
  assert.equal(result.status, 'applied');
  assert.equal(result.plan.backup, plan.backup);
  assert.equal(fs.statSync(plan.backup!).mode & 0o777, 0o600);
  const target = JSON.parse(fs.readFileSync(f.output, 'utf8'));
  assert.deepEqual(target, {
    theme: 'latte',
    briefing: 'off',
    briefingApiKey: 'TARGET-SECRET',
    unrelated: [3, 2, 1],
    timelinePane: 'closed',
    language: 'zh',
  });
  assert.doesNotMatch(fs.readFileSync(plan.backup!, 'utf8'), /SOURCE-SECRET|DO-NOT-COPY/);
  assert.throws(() => applyMigration(f.selection, plan.inputDigest), /migration_input_changed/);
  const noOp = f.apply();
  assert.equal(noOp.status, 'unchanged');
  assert.equal(noOp.plan.backup, null);
  restoreMigration(f.target, plan.backup!);
  assert.equal(fs.readFileSync(f.output, 'utf8'), f.original);
  assert.throws(() => restoreMigration(f.target, plan.backup!), /migration_restore_conflict/);
});
test('missing destination restores to absence, private mode and exact bytes round trip', (t) => {
  const f = fixture(t, false);
  const plan = f.preview();
  f.apply();
  assert.equal(fs.statSync(f.output).mode & 0o777, 0o600);
  restoreMigration(f.target, plan.backup!);
  assert.equal(fs.existsSync(f.output), false);
  fs.writeFileSync(f.output, f.original, { mode: 0o400 });
  const next = f.apply();
  assert.equal(fs.statSync(f.output).mode & 0o777, 0o400);
  restoreMigration(f.target, next.plan.backup!);
  assert.equal(fs.statSync(f.output).mode & 0o777, 0o400);
});
test('source and destination input changes, same-byte replacements and mode changes reject stale apply', (t) => {
  const f = fixture(t);
  for (const file of [f.input, f.output]) {
    let plan = f.preview();
    fs.appendFileSync(file, ' ');
    assert.throws(() => applyMigration(f.selection, plan.inputDigest), /migration_input_changed/);
    plan = f.preview();
    const bytes = fs.readFileSync(file);
    fs.unlinkSync(file);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    assert.throws(() => applyMigration(f.selection, plan.inputDigest), /migration_input_changed/);
    plan = f.preview();
    fs.chmodSync(file, 0o400);
    assert.throws(() => applyMigration(f.selection, plan.inputDigest), /migration_input_changed/);
    fs.chmodSync(file, 0o600);
  }
  assert.deepEqual(fs.readdirSync(f.target), ['hud-settings.json']);
});
test('restore refuses intervening edits, replacements, mode changes and touched files', (t) => {
  const f = fixture(t);
  const result = f.apply();
  const saved = fs.readFileSync(f.output);
  fs.appendFileSync(f.output, ' ');
  assert.throws(() => restoreMigration(f.target, result.plan.backup!), /migration_restore_conflict/);
  fs.writeFileSync(f.output, saved);
  assert.throws(() => restoreMigration(f.target, result.plan.backup!), /migration_restore_conflict/);
  fs.chmodSync(f.output, 0o400);
  assert.throws(() => restoreMigration(f.target, result.plan.backup!), /migration_restore_conflict/);
  fs.unlinkSync(f.output);
  fs.writeFileSync(f.output, saved, { mode: 0o600 });
  assert.throws(() => restoreMigration(f.target, result.plan.backup!), /migration_restore_conflict/);
});
test('symlinks, hard links, public files, special files and unsafe roots are refused', (t) => {
  const f = fixture(t);
  const original = fs.readFileSync(f.input);
  const other = join(f.home, 'other');
  fs.writeFileSync(other, original, { mode: 0o600 });
  fs.unlinkSync(f.input);
  fs.symlinkSync(other, f.input);
  assert.throws(f.preview, /migration_unsafe_file/);
  fs.unlinkSync(f.input);
  fs.linkSync(other, f.input);
  assert.throws(f.preview, /migration_unsafe_file/);
  fs.unlinkSync(f.input);
  fs.writeFileSync(f.input, original, { mode: 0o644 });
  assert.throws(f.preview, /migration_unsafe_file/);
  fs.unlinkSync(f.input);
  execFileSync('mkfifo', [f.input]);
  assert.throws(f.preview, /migration_unsafe_file/);
  fs.unlinkSync(f.input);
  fs.writeFileSync(f.input, original, { mode: 0o600 });
  fs.chmodSync(f.target, 0o755);
  assert.throws(f.preview, /migration_unsafe_directory/);
  fs.chmodSync(f.target, 0o700);
  const alias = join(f.home, 'alias');
  fs.symlinkSync(f.source, alias);
  assert.throws(() => previewMigration({ ...f.selection, source: alias }), /migration_unsafe_directory/);
  assert.throws(() => previewMigration({ ...f.selection, source: alias + '/' }), /migration_unsafe_directory/);
  assert.throws(() => previewMigration({ ...f.selection, target: f.source }), /migration_same_directory/);
  assert.throws(() => previewMigration({ ...f.selection, mapping: 'arbitrary' }), /migration_unsupported_mapping/);
});
test('unknown/oversize/invalid inputs do not create state or copy authorization', (t) => {
  const f = fixture(t);
  for (const input of ['[]', '{', '{"theme":"unknown"}', '{"briefing":"api","token":"secret"}', 'x'.repeat(65537)]) {
    fs.writeFileSync(f.input, input);
    assert.throws(f.preview, /migration_/);
    assert.deepEqual(fs.readdirSync(f.target), ['hud-settings.json']);
  }
});
test('no transcripts, credentials, grants, verification or cache files are read/copied', (t) => {
  const f = fixture(t);
  for (const name of ['sessions', 'auth.json', 'delegate.json', 'cache.json', 'ledger.sqlite', 'capabilities.json']) {
    fs.symlinkSync('/no-such-path', join(f.source, name));
    fs.writeFileSync(join(f.target, name), name, { mode: 0o600 });
  }
  f.apply();
  for (const name of ['sessions', 'auth.json', 'delegate.json', 'cache.json', 'ledger.sqlite', 'capabilities.json'])
    assert.equal(fs.readFileSync(join(f.target, name), 'utf8'), name);
});
test('private backup validation and busy lock refuse rather than overwrite', (t) => {
  const f = fixture(t);
  const plan = f.preview();
  fs.writeFileSync(join(f.target, '.hud-migrate.lock'), '', { mode: 0o600 });
  assert.throws(f.apply, /migration_busy/);
  fs.unlinkSync(join(f.target, '.hud-migrate.lock'));
  f.apply();
  assert.throws(() => restoreMigration(f.source, plan.backup!), /migration_invalid_backup/);
  fs.chmodSync(plan.backup!, 0o644);
  assert.throws(() => restoreMigration(f.target, plan.backup!), /migration_unsafe_file/);
  fs.chmodSync(plan.backup!, 0o600);
  const backup = JSON.parse(fs.readFileSync(plan.backup!, 'utf8'));
  backup.original = Buffer.from('tampered').toString('base64');
  fs.writeFileSync(plan.backup!, JSON.stringify(backup));
  assert.throws(() => restoreMigration(f.target, plan.backup!), /migration_invalid_backup/);
});
test('backup precedes replacement and injected rename failure leaves original recoverable', (t) => {
  const f = fixture(t);
  const plan = f.preview();
  const rename = mutable.renameSync;
  mutable.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[1]).endsWith('/hud-settings.json')) {
      assert.ok(fs.existsSync(plan.backup!));
      assert.equal(fs.readFileSync(f.output, 'utf8'), f.original);
      throw new Error('synthetic rename failure');
    }
    return rename(...args);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    assert.throws(f.apply, /synthetic rename failure/);
  } finally {
    mutable.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.equal(fs.readFileSync(f.output, 'utf8'), f.original);
  assert.equal(
    Buffer.from(JSON.parse(fs.readFileSync(plan.backup!, 'utf8')).original, 'base64').toString(),
    f.original
  );
  assert.throws(f.apply, /migration_recovery_exists/);
  assert.equal(fs.existsSync(join(f.target, '.hud-migrate.lock')), false);
});
test('directory substitution cannot redirect writes outside the pinned target', (t) => {
  const f = fixture(t);
  const other = join(f.home, 'other'),
    moved = join(f.home, 'moved');
  fs.mkdirSync(other, { mode: 0o700 });
  fs.writeFileSync(join(other, 'hud-settings.json'), f.original, { mode: 0o600 });
  const write = mutable.writeFileSync;
  let swapped = false;
  mutable.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
    write(...args);
    if (typeof args[0] === 'number' && !swapped) {
      swapped = true;
      fs.renameSync(f.target, moved);
      fs.symlinkSync(other, f.target);
    }
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try {
    assert.throws(f.apply, /migration_unsafe_directory|migration_directory_changed/);
  } finally {
    mutable.writeFileSync = write;
    syncBuiltinESMExports();
  }
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(other), ['hud-settings.json']);
  assert.equal(fs.readFileSync(join(other, 'hud-settings.json'), 'utf8'), f.original);
  assert.equal(fs.readFileSync(join(moved, 'hud-settings.json'), 'utf8'), f.original);
});
test('product CLI help, preview, apply and restore operate only in temporary homes', (t) => {
  const f = fixture(t);
  for (const args of [['--help'], ['migrate'], ['migrate', '--help'], ['migrate', 'apply', '--help']]) {
    const result = f.run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /hud migrate/);
  }
  const flags = ['--mapping', MAPPING, '--source', f.source, '--target', f.target];
  const preview = f.run(['migrate', 'preview', ...flags]);
  assert.equal(preview.status, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout);
  assert.deepEqual(fs.readdirSync(f.target), ['hud-settings.json']);
  assert.equal(f.run(['migrate', 'apply', ...flags]).status, 2);
  assert.equal(f.run(['migrate', 'preview', ...flags, '--mapping', MAPPING]).status, 2);
  const apply = f.run(['migrate', 'apply', ...flags, '--expect', plan.inputDigest]);
  assert.equal(apply.status, 0, apply.stderr);
  const restore = f.run(['migrate', 'restore', '--target', f.target, '--backup', plan.backup]);
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(fs.readFileSync(f.output, 'utf8'), f.original);
  assert.equal(fs.existsSync(join(f.home, 'never-open')), false);
  assert.equal(fs.existsSync(join(f.home, 'never-read')), false);
});

test('apply verifies both inputs again after backup persistence, before replacement', (t) => {
  for (const which of ['source', 'target'] as const) {
    const f = fixture(t);
    const plan = f.preview();
    const write = mutable.writeFileSync;
    let writes = 0;
    mutable.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
      write(...args);
      if (typeof args[0] === 'number' && ++writes === 2)
        fs.appendFileSync(which === 'source' ? f.input : f.output, ' ');
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    try {
      assert.throws(f.apply, /migration_input_changed/);
    } finally {
      mutable.writeFileSync = write;
      syncBuiltinESMExports();
    }
    assert.equal(fs.readFileSync(f.output, 'utf8'), f.original + (which === 'target' ? ' ' : ''));
    assert.equal(fs.existsSync(plan.backup!), true);
  }
});
test('target consumption uses existing settings path and keeps outbound/model choice disabled', (t) => {
  const f = fixture(t);
  f.apply();
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import {loadSettings} from './dist/settings.js'; const s=loadSettings(); console.log(JSON.stringify({theme:s.theme,language:s.language,briefing:s.briefing}));",
    ],
    { env: { HOME: f.home, CODEX_HUD_SETTINGS_PATH: f.output }, encoding: 'utf8', timeout: 5000 }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { theme: 'latte', language: 'zh', briefing: 'off' });
});

test('unrepresentable unrelated JSON numbers are refused without changing target values', (t) => {
  const f = fixture(t);
  for (const value of ['1e400', '-1e400', '9007199254740993']) {
    const original = `{"theme":"mocha","unrelated":{"nested":[${value}]}}`;
    fs.writeFileSync(f.output, original);
    assert.throws(f.preview, /migration_invalid_json/);
    assert.equal(fs.readFileSync(f.output, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(f.target), ['hud-settings.json']);
  }
});
test('partial temporary and backup writes leave the target unchanged and refuse blind retry', (t) => {
  for (const failAt of [1, 2]) {
    const f = fixture(t);
    const plan = f.preview();
    const write = mutable.writeFileSync;
    let count = 0;
    mutable.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[0] === 'number' && ++count === failAt) {
        write(args[0], '{');
        throw new Error('synthetic partial write');
      }
      write(...args);
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    try {
      assert.throws(f.apply, /synthetic partial write/);
    } finally {
      mutable.writeFileSync = write;
      syncBuiltinESMExports();
    }
    assert.equal(fs.readFileSync(f.output, 'utf8'), f.original);
    const recovery = failAt === 1 ? plan.temporary! : plan.backup!;
    assert.equal(fs.readFileSync(recovery, 'utf8'), '{');
    assert.equal(fs.statSync(recovery).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(join(f.target, '.hud-migrate.lock')), false);
    assert.throws(f.apply, /migration_recovery_exists/);
  }
});
test('failure after replacement still leaves a guarded exact restore', (t) => {
  const f = fixture(t);
  const plan = f.preview();
  const sync = mutable.fsyncSync;
  let count = 0;
  mutable.fsyncSync = ((fd: number) => {
    if (++count === 4) throw new Error('synthetic post-rename sync failure');
    sync(fd);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try {
    assert.throws(f.apply, /synthetic post-rename sync failure/);
  } finally {
    mutable.fsyncSync = sync;
    syncBuiltinESMExports();
  }
  assert.equal(JSON.parse(fs.readFileSync(f.output, 'utf8')).theme, 'latte');
  restoreMigration(f.target, plan.backup!);
  assert.equal(fs.readFileSync(f.output, 'utf8'), f.original);
});
test('stdout failure after apply reports uncertainty without discarding the backup', async (t) => {
  const f = fixture(t);
  const plan = f.preview();
  let error = '';
  const status = await migrateCommand(
    ['apply', '--mapping', MAPPING, '--source', f.source, '--target', f.target, '--expect', plan.inputDigest],
    {
      env: { HOME: f.home },
      stdout: () => {
        throw new Error('synthetic broken pipe');
      },
      stderr: (s) => {
        error += s;
      },
    }
  );
  assert.equal(status, 2);
  assert.equal(error, 'migration_io_or_output_failure\n');
  restoreMigration(f.target, plan.backup!);
  assert.equal(fs.readFileSync(f.output, 'utf8'), f.original);
});

test('selection digest is independent of caller object property order', (t) => {
  const f = fixture(t);
  const reordered = { mapping: MAPPING, target: f.target, source: f.source };
  assert.equal(f.preview().inputDigest, previewMigration(reordered).inputDigest);
  const applied = applyMigration(reordered, f.preview().inputDigest);
  restoreMigration(f.target, applied.plan.backup!);
  assert.equal(fs.readFileSync(f.output, 'utf8'), f.original);
});
