import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { before, test } from 'node:test';
import { main } from '../../src/cli/hud.js';
import { EXPORT_HELP, EXPORT_USAGE } from '../../src/cli/link-export.js';
import { queryDelegationExport, type ExportQueryOptions } from '../../src/core/export-query.js';
import { decodeDelegationExport } from '../../src/core/export.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { goldenExportInput } from '../fixtures/contracts/observation-export.js';
import { exportFixture, SENTINEL } from '../fixtures/export/ledger.js';

import {
  validateStartup,
  startupStderr,
  retainCapture,
  traceHint,
  type DiagnosticProfile,
} from '../int/node-startup-diagnostics.js';

let profile: DiagnosticProfile;
before(() => {
  profile = validateStartup();
});

const command = ['link', 'export', '--json', '--schema-version', '1'];
const entry = resolve('bin/hud');
const golden = goldenExportInput();
const skip = ledgerRuntimeSupported() ? false : 'Requires native read-only ledger runtime';

async function invoke(args: readonly string[], home: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const status = await main(args, {
    env: { HUD_HOME: home },
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => stderr.push(text),
  });
  return { status, stdout: stdout.join(''), stderr: stderr.join(''), writes: stdout.length };
}

function child(args: readonly string[], home: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    env: { ...process.env, HUD_HOME: home, ...env },
    timeout: 10_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  retainCapture('export', result);
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return {
    ...result,
    rawStdout: result.stdout,
    rawStderr: result.stderr,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  };
}

function assertChildStderr(result: { pid: number; rawStderr: Buffer }, application = '') {
  assert.deepEqual(result.rawStderr, Buffer.concat([startupStderr(profile, result.pid), Buffer.from(application)]));
}

test('hud help and strict argument refusals never access or create a ledger', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-o2c-args-'));
  try {
    for (const args of [['--help'], ['link', '--help'], ['link', 'export', '--help']]) {
      const result = await invoke(args, home);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, EXPORT_HELP);
      assert.equal(result.stderr, '');
      assert.ok(
        result.stdout.includes(
          'HUD failures emit one reason-code line on stderr and no JSON.\nNode/runtime diagnostics may also appear on stderr; stdout remains the machine-readable channel.'
        )
      );
      const launchedHelp = child(args, home);
      assert.equal(launchedHelp.status, 0);
      assert.deepEqual(launchedHelp.rawStdout, Buffer.from(EXPORT_HELP));
      assertChildStderr(launchedHelp);
      assert.deepEqual(readdirSync(home), []);
    }
    const cases: [string[], string][] = [
      [[], 'invalid_command'],
      [['link'], 'invalid_command'],
      [['link', 'list'], 'invalid_command'],
      [['link', 'export'], 'json_required'],
      [['link', 'export', '--json'], 'schema_version_required'],
      [['link', 'export', '--schema-version', '1'], 'json_required'],
      [['link', 'export', '--json', '--schema-version', '2'], 'unsupported_export_schema'],
      [['link', 'export', '--json', '--schema-version', '01'], 'unsupported_export_schema'],
      [['link', 'export', '--json', '--schema-version'], 'missing_option_value'],
      [[...command, '--paths'], 'missing_option_value'],
      [[...command, '--paths', 'none'], 'invalid_paths'],
      [[...command, '--paths', 'remote'], 'invalid_paths'],
      [[...command, '--paths', 'local', '--paths', 'local'], 'duplicate_option'],
      [[...command, '--link'], 'missing_option_value'],
      [[...command, '--link', '--paths', 'local'], 'missing_option_value'],
      [[...command, '--link', ''], 'invalid_scope'],
      [[...command, '--link', 'a\nb'], 'invalid_scope'],
      [[...command, '--link', 'a'.repeat(257)], 'invalid_scope'],
      [[...command, '--link', 'a', '--link', 'a'], 'invalid_scope'],
      [[...command, '--json'], 'duplicate_option'],
      [[...command, '--schema-version', '1'], 'duplicate_option'],
      [[...command, '--output', join(home, 'never-created.json')], 'invalid_arguments'],
      [[...command, '--afterSeq', '1'], 'invalid_arguments'],
      [[...command, '--json=true'], 'invalid_arguments'],
      [[...command, 'extra'], 'invalid_arguments'],
      [[...command, '--help', '--unknown'], 'invalid_arguments'],
    ];
    for (const [args, reason] of cases) {
      const result = await invoke(args, home);
      assert.equal(result.status, 2, JSON.stringify(args));
      assert.equal(result.stdout, '');
      assert.match(result.stderr, new RegExp(`^${reason}: Usage: hud link export [^\\n]+\\n$`));
    }
    assert.deepEqual(readdirSync(home), []);
    const launched = child(['unknown'], home);
    assert.equal(launched.status, 2);
    assert.equal(launched.stdout, '');
    assertChildStderr(launched, `invalid_command: ${EXPORT_USAGE}\n`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('hud rejects missing, relative, public, symlink, file and foreign-owned HUD_HOME without writes', async (t) => {
  const container = mkdtempSync(join(tmpdir(), 'hud-o2c-home-'));
  const home = join(container, 'private');
  mkdirSync(home, { mode: 0o700 });
  try {
    const missing = join(container, 'absent');
    const file = join(container, 'file');
    writeFileSync(file, 'synthetic', { mode: 0o600 });
    const symlink = join(container, 'symlink');
    symlinkSync(home, symlink);
    for (const candidate of ['', 'relative', missing, file, symlink]) {
      const result = await invoke(command, candidate);
      assert.equal(result.status, 3, candidate);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^(invalid_hud_home|hud_home_unavailable)\n$/);
    }
    chmodSync(home, 0o755);
    const result = child(command, home);
    assert.equal(result.status, 3);
    assert.equal(result.stdout, '');
    assertChildStderr(result, 'invalid_hud_home\n');
    chmodSync(home, 0o700);
    if (process.getuid) {
      const uid = process.getuid();
      t.mock.method(process as NodeJS.Process & { getuid(): number }, 'getuid', () => uid + 1);
      assert.equal((await invoke(command, home)).status, 3);
      t.mock.restoreAll();
    }
    assert.equal(existsSync(missing), false);
    assert.deepEqual(readdirSync(home), []);
    assert.equal(readFileSync(file, 'utf8'), 'synthetic');
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test('hud missing and unreadable ledgers fail with no stdout or initialization', { skip }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-o2c-missing-'));
  try {
    const missing = child(command, home);
    assert.equal(missing.status, 4);
    assert.equal(missing.stdout, '');
    assertChildStderr(missing, 'ledger_missing\n');
    assert.deepEqual(readdirSync(home), []);
    mkdirSync(join(home, 'ledger.sqlite'), { mode: 0o700 });
    const unreadable = await invoke(command, home);
    assert.equal(unreadable.status, 4);
    assert.equal(unreadable.stdout, '');
    assert.equal(unreadable.stderr, 'ledger_unavailable\n');
    assert.deepEqual(readdirSync(join(home, 'ledger.sqlite')), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('hud rejects symlink HUD_HOME with trailing slashes and dot components in real processes', { skip }, async () => {
  const fixture = await exportFixture(golden.records);
  try {
    const alias = join(fixture.container, 'alias');
    symlinkSync(fixture.home, alias);
    for (const suffix of ['', '/', '/.', '/./', '//.//./']) {
      const actual = child(command, alias + suffix);
      assert.equal(actual.status, 3, suffix);
      assert.equal(actual.stdout, '');
      assertChildStderr(actual, 'invalid_hud_home\n');
    }
    // The same suffixes on a real private directory continue to work.
    for (const suffix of ['/', '/.', '//.//./']) {
      const actual = child(command, fixture.home + suffix);
      assert.equal(actual.status, 0, actual.stderr);
      assertChildStderr(actual);
      assert.equal(JSON.parse(actual.stdout).coverage.recordCount, golden.records.length);
    }
  } finally {
    await fixture.cleanup();
  }
});

test(
  'hud unsearchable HUD_HOME returns home exit 3 while an unreadable ledger returns exit 4',
  { skip: skip || (process.getuid?.() === 0 ? 'Root bypasses filesystem access permissions' : false) },
  async () => {
    const fixture = await exportFixture(golden.records);
    const ledgerPath = join(fixture.home, 'ledger.sqlite');
    const mode = lstatSync(ledgerPath).mode & 0o777;
    try {
      const before = readdirSync(fixture.home).sort();
      for (const homeMode of [0o000, 0o600]) {
        chmodSync(fixture.home, homeMode);
        try {
          const actual = child(command, fixture.home);
          assert.equal(actual.status, 3);
          assert.equal(actual.stdout, '');
          assertChildStderr(actual, 'hud_home_unavailable\n');
        } finally {
          chmodSync(fixture.home, 0o700);
        }
        assert.deepEqual(readdirSync(fixture.home).sort(), before);
      }
      chmodSync(ledgerPath, 0o000);
      try {
        const actual = child(command, fixture.home);
        assert.equal(actual.status, 4);
        assert.equal(actual.stdout, '');
        assertChildStderr(actual, 'ledger_unavailable\n');
      } finally {
        chmodSync(ledgerPath, mode);
      }
      assert.deepEqual(readdirSync(fixture.home).sort(), before);
    } finally {
      chmodSync(fixture.home, 0o700);
      chmodSync(ledgerPath, mode);
      await fixture.cleanup();
    }
  }
);

test('hud reports asynchronous stdout failures for export and help without Node stack traces', { skip }, async () => {
  const fixture = await exportFixture(golden.records);
  try {
    const outputPath = join(fixture.container, 'read-only-stdout');
    writeFileSync(outputPath, 'synthetic unchanged output', { mode: 0o600 });
    const fd = openSync(outputPath, 'r');
    try {
      for (const args of [command, ['--help']]) {
        const actual = spawnSync(process.execPath, [entry, ...args], {
          env: { ...process.env, HUD_HOME: fixture.home },
          stdio: ['ignore', fd, 'pipe'],
          timeout: 10_000,
        });
        retainCapture('export-readonly-output', actual);
        assert.ifError(actual.error);
        assert.equal(actual.signal, null);
        assert.equal(actual.status, 1);
        assert.equal(actual.stdout, null);
        assert.deepEqual(
          actual.stderr,
          Buffer.concat([startupStderr(profile, actual.pid), Buffer.from('internal_or_output_failure\n')])
        );
        assert.equal(readFileSync(outputPath, 'utf8'), 'synthetic unchanged output');
      }
    } finally {
      closeSync(fd);
    }
    for (const args of [command, ['--help']]) {
      const launched = spawn(process.execPath, [entry, ...args], {
        env: { ...process.env, HUD_HOME: fixture.home },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      });
      const closed = once(launched, 'close');
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      launched.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      launched.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      launched.stdout.destroy();
      const [status, signal] = await closed;
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      retainCapture('export-closed-output', { stdout, stderr, pid: launched.pid!, status, signal });
      assert.equal(signal, null);
      assert.equal(status, 1);
      assert.deepEqual(stdout, Buffer.alloc(0));
      assert.deepEqual(
        stderr,
        Buffer.concat([startupStderr(profile, launched.pid!), Buffer.from('internal_or_output_failure\n')])
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test(
  'hud consumes producer JSON byte for byte, preserving full refs, scopes, history and path opt-in',
  { skip },
  async (t) => {
    const fixture = await exportFixture(golden.records);
    t.mock.method(Date, 'now', () => golden.exportedAt);
    try {
      const before = readdirSync(fixture.home).sort();
      const cases: [string[], ExportQueryOptions][] = [
        [command, { schemaVersion: 1 }],
        [[...command, '--paths', 'local'], { schemaVersion: 1, paths: 'local' }],
        [
          [...command, '--link', 'synthetic-link-d', '--link', 'synthetic-link-a'],
          { schemaVersion: 1, scope: { kind: 'links', linkIds: ['synthetic-link-d', 'synthetic-link-a'] } },
        ],
        [
          ['link', 'export', '--link', 'synthetic-link-d', '--schema-version', '1', '--json', '--paths', 'local'],
          { schemaVersion: 1, paths: 'local', scope: { kind: 'links', linkIds: ['synthetic-link-d'] } },
        ],
        [
          [...command, '--link', 'synthetic-unknown-link'],
          { schemaVersion: 1, scope: { kind: 'links', linkIds: ['synthetic-unknown-link'] } },
        ],
      ];
      for (const [args, options] of cases) {
        const expected = await queryDelegationExport(fixture.home, options);
        assert.ok(expected.ok, JSON.stringify(expected));
        const actual = await invoke(args, fixture.home);
        assert.equal(actual.status, 0, actual.stderr);
        assert.equal(actual.stderr, '');
        assert.equal(actual.stdout, expected.value.json);
        assert.equal(actual.writes, 1);
        assert.equal(actual.stdout.endsWith('\n'), true);
        assert.equal(actual.stdout.includes(SENTINEL), false);
        const decoded = decodeDelegationExport(actual.stdout);
        assert.ok(decoded.ok);
        assert.deepEqual(decoded.value, expected.value.envelope);
        if (!options.paths) assert.equal(actual.stdout.includes('/synthetic/'), false);
        else {
          assert.equal(decoded.value.paths, 'local');
          if (decoded.value.paths === 'local') {
            assert.ok(decoded.value.records.every((record) => record.launchCwd.startsWith('/synthetic/')));
            assert.ok(decoded.value.records.some((record) => record.workspaceSnapshot?.worktreeRoot));
          }
        }
      }
      assert.deepEqual(readdirSync(fixture.home).sort(), before);
    } finally {
      await fixture.cleanup();
    }
  }
);

test(
  'hud real launcher matches the query JSON and leaves database/WAL bytes and mtime unchanged',
  { skip },
  async (t) => {
    const fixture = await exportFixture(golden.records);
    try {
      const paths = ['ledger.sqlite', 'ledger.sqlite-wal'].map((name) => join(fixture.home, name));
      const before = paths.map((path) => ({ bytes: readFileSync(path), mtime: lstatSync(path).mtimeMs }));
      const args = [...command, '--paths', 'local', '--link', 'synthetic-link-d'];
      const actual = child(args, fixture.home);
      assert.equal(actual.status, 0, actual.stderr);
      assertChildStderr(actual);
      const envelope = JSON.parse(actual.stdout);
      t.mock.method(Date, 'now', () => envelope.exportedAt);
      const expected = await queryDelegationExport(fixture.home, {
        schemaVersion: 1,
        paths: 'local',
        scope: { kind: 'links', linkIds: ['synthetic-link-d'] },
      });
      assert.ok(expected.ok);
      assert.equal(actual.stdout, expected.value.json);
      assert.deepEqual(actual.rawStdout, Buffer.from(expected.value.json));
      assert.deepEqual(
        envelope.records.map((record: { operation: string }) => record.operation),
        ['handover', 'resume']
      );
      assert.ok(envelope.records.every((record: { predecessor: string }) => record.predecessor === 'synthetic-link-c'));
      paths.forEach((path, index) => {
        assert.deepEqual(readFileSync(path), before[index].bytes);
        assert.equal(lstatSync(path).mtimeMs, before[index].mtime);
      });
    } finally {
      await fixture.cleanup();
    }
  }
);

test('hud refuses unknown ledger versions without migrating or emitting JSON', { skip }, async () => {
  const fixture = await exportFixture(golden.records);
  try {
    await fixture.ledger.transaction((tx) => tx.run('PRAGMA user_version=2'));
    const actual = child(command, fixture.home);
    assert.equal(actual.status, 5);
    assert.equal(actual.stdout, '');
    assertChildStderr(actual, 'unsupported_ledger_schema\n');
    assert.equal(
      fixture.ledger.snapshot((tx) => tx.get('PRAGMA user_version')?.user_version),
      2
    );
  } finally {
    await fixture.cleanup();
  }
});

test('hud producer validation refusal writes no partial JSON', { skip }, async () => {
  const record = golden.records.find((record) => record.runId === 'synthetic-run-a1')!;
  const fixture = await exportFixture([
    { ...record, workspaceSnapshot: { ...record.workspaceSnapshot!, worktreeRoot: 'relative' } },
  ]);
  try {
    const actual = child([...command, '--paths', 'local'], fixture.home);
    assert.equal(actual.status, 6);
    assert.equal(actual.stdout, '');
    assertChildStderr(actual, 'invalid_worktree_root\n');
  } finally {
    await fixture.cleanup();
  }
});

test('hud defaults to ~/.hud only inside an isolated synthetic HOME', { skip }, async () => {
  const fixture = await exportFixture(golden.records);
  try {
    await fixture.ledger.close();
    const home = join(fixture.container, '.hud');
    renameSync(fixture.home, home);
    const actual = child(command, home, { HUD_HOME: undefined, HOME: fixture.container });
    assert.equal(actual.status, 0, actual.stderr);
    assertChildStderr(actual);
    const decoded = decodeDelegationExport(actual.stdout);
    assert.ok(decoded.ok);
    assert.equal(decoded.value.coverage.recordCount, golden.records.length);
    assert.equal(decoded.value.ledgerId, fixture.ledger.ledgerId);
  } finally {
    await fixture.cleanup();
  }
});

test('hud export leaves fresh-process raw stderr free of SQLite initialization warnings', { skip }, async () => {
  const fixture = await exportFixture(golden.records);
  try {
    const result = child(command, fixture.home);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /SQLite is an experimental feature and might change at any time/);
    assertChildStderr(result);
    assert.ok(decodeDelegationExport(result.stdout).ok);
  } finally {
    await fixture.cleanup();
  }
});

test('ledger initialization restores emitWarning and preserves unrelated warnings', { skip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-warning-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { loadLedgerSqlite } from './dist/ledger/runtime.js';
      import Module from 'node:module';
      const emit = process.emitWarning;
      const load = Module._load;
      Module._load = function(request, ...args) {
        if (request === 'node:sqlite') throw new Error('synthetic initialization failure');
        return load.call(this, request, ...args);
      };
      await assert.rejects(loadLedgerSqlite(), /requires unflagged node:sqlite/);
      assert.equal(process.emitWarning, emit);
      Module._load = function(request, ...args) {
        if (request === 'node:sqlite') process.emitWarning('synthetic loader warning mentioning SQLite', 'SyntheticWarning');
        return load.call(this, request, ...args);
      };
      await Promise.all([loadLedgerSqlite(), loadLedgerSqlite()]);
      assert.equal(process.emitWarning, emit);
      process.emitWarning('synthetic unrelated warning', 'SyntheticWarning');
    `,
      ],
      {
        env: { ...process.env, HOME: home, HUD_HOME: home },
        timeout: 10_000,
      }
    );
    retainCapture('warning-restoration', result);
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.deepEqual(result.stdout, Buffer.alloc(0));
    const startup = startupStderr(profile, result.pid);
    const loader = `(node:${result.pid}) SyntheticWarning: synthetic loader warning mentioning SQLite\n`;
    const expected = Buffer.concat([
      startup,
      Buffer.from(
        loader +
          (startup.length ? '' : traceHint()) +
          loader +
          `(node:${result.pid}) SyntheticWarning: synthetic unrelated warning\n`
      ),
    ]);
    assert.deepEqual(result.stderr, expected);
    assert.doesNotMatch(result.stderr.toString(), /ExperimentalWarning/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
