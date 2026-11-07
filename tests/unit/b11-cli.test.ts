import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { main } from '../../src/cli/hud.js';
import { parseResume, runCommand } from '../../src/cli/run.js';
import { parseWait, runWait } from '../../src/cli/run-wait.js';
import { claudeCommand, foreground, appendArguments, parseClaude } from '../../src/cli/launcher.js';
import { launchProfileDigest, resolveLaunchCommand, shellQuote } from '../../src/core/capabilities.js';
import { delegationBenchmarkFixture } from './b45-delegation-fixture.js';
import { handshakeFixture } from './b45-handshake-fixture.js';
import { RETIRE_DEFAULTS } from '../../packages/hud-mcp/src/config.js';
import { DelegationService, type DelegationOptions } from '../../packages/hud-mcp/src/delegation.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import type { HudIO } from '../../src/cli/link-export.js';
import type { PreparedRunLaunch } from '../../src/core/launch/index.js';
import type { ResumeServiceOptions } from '../../src/cli/runtime.js';
import { LedgerRunFactPort } from '../../src/core/run/ledger-port.js';
import { LedgerTransaction } from '../../src/ledger/transaction.js';
import type { LaunchProfile } from '../../src/core/types/capabilities.js';

const skip = ledgerRuntimeSupported() ? false : 'B11 requires Node 22.x >=22.13 or >=24';
test('B11 explicit argv and shell forms are distinct, literal overrides and cannot replace resume', () => {
  assert.equal(
    parseResume([
      'link-a',
      '--request-key',
      '--opaque',
      '--expected-run',
      'run-a',
      '--mode',
      'headless',
      '--prompt',
      '--literal',
    ]).request_key,
    '--opaque'
  );
  assert.deepEqual(parseClaude(['--profile', 'synthetic', '--', '/synthetic/claude', '{{literal}}']).argv, [
    '/synthetic/claude',
    '{{literal}}',
  ]);
  assert.equal(parseClaude(['--profile', 'synthetic', '--shell', 'synthetic_function']).shell, 'synthetic_function');
  for (const args of [
    ['--', 'claude'],
    ['--profile', 'synthetic', '--'],
    ['--profile', 'synthetic', '--shell', 'x', '--', 'y'],
    ['--profile', 'synthetic', '--resume', 'session-a', '--', 'x'],
  ])
    assert.throws(() => parseClaude(args));
});

test('B11 compatibility bin routes codex directly to the existing wrapper help without HUD_HOME', () => {
  const result = spawnSync(process.execPath, [resolve('bin/hud'), 'codex', '--help'], {
    env: { PATH: '/usr/bin:/bin', HOME: '/synthetic/unused' },
    encoding: 'utf8',
    timeout: 5000,
  });
  const original = spawnSync(resolve('bin/codex-hud'), ['--help'], {
    env: { PATH: '/usr/bin:/bin', HOME: '/synthetic/unused' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, original.status);
  assert.equal(result.stdout, original.stdout);
  assert.equal(result.stderr, original.stderr);
});

test('hud panel help and invalid arguments need no HUD_HOME', { skip }, () => {
  const env = { PATH: '/usr/bin:/bin', HOME: '/synthetic/unused', HUD_HOME: 'not-absolute' };
  const help = spawnSync(process.execPath, [resolve('bin/hud'), 'panel', '--help'], {
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: hud panel/);
  assert.equal(help.stderr, '');
  const invalid = spawnSync(process.execPath, [resolve('bin/hud'), 'panel', '--unexpected'], {
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /invalid_arguments/);
});

test('hud panel starts the actual panel and closes when its input closes', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'hud-panel-entry-'));
  try {
    const result = spawnSync(process.execPath, [resolve('bin/hud'), 'panel'], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: root, HUD_HOME: join(root, 'missing-hud') },
      input: '',
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\x1b\[\?1049h/);
    assert.match(result.stdout, /\x1b\[\?1049l/);
    assert.equal(existsSync(join(root, 'missing-hud', 'ledger.sqlite')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const explicitPane of [false, true])
  test(
    `standalone panel never uses inherited tmux ${explicitPane ? 'pane' : 'fallback'} for input or cleanup`,
    { skip },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'hud-panel-standalone-'));
      const trace = join(root, 'commands.log');
      const fakeTmux = join(root, 'tmux');
      const toggle = join(root, 'toggle');
      const keys = join(root, 'codex-hud-keys');
      const script = '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PANEL_COMMAND_TRACE"\nprintf "%%123\\n"\n';
      for (const file of [fakeTmux, toggle, keys]) writeFileSync(file, script, { mode: 0o700 });
      const child = spawn(process.execPath, [resolve('bin/hud'), 'panel'], {
        cwd: root,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: root,
          CODEX_HOME: root,
          HUD_HOME: join(root, 'missing'),
          TMUX: '/synthetic/tmux,1,0',
          TMUX_PANE: '%456',
          CODEX_HUD_TMUX_BIN: fakeTmux,
          CODEX_HUD_TOGGLE_CMD: toggle,
          CODEX_HUD_TMUX_SESSION: 'synthetic',
          PANEL_COMMAND_TRACE: trace,
          ...(explicitPane ? { CODEX_HUD_MAIN_PANE: '%123' } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      let output = '';
      let errors = '';
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => {
        errors += chunk;
      });
      try {
        await new Promise<void>((resolvePromise, reject) => {
          const timer = setTimeout(() => reject(new Error('panel_start_timeout')), 8000);
          child.stdout!.on('data', (chunk: string) => {
            output += chunk;
            if (output.includes('\x1b[?1049h')) {
              clearTimeout(timer);
              resolvePromise();
            }
          });
          child.once('exit', () => {
            clearTimeout(timer);
            reject(new Error('panel_exited_early'));
          });
        });
        const closed = once(child, 'close');
        child.stdin!.write('\x1b[200~synthetic paste\x1b[201~q');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('panel_close_timeout')), 8000);
          }),
        ]).finally(() => clearTimeout(timer));
        assert.equal(result[0], 0, errors);
        assert.equal(existsSync(trace), false, 'no tmux, prefix or toggle command should run');
      } finally {
        if (child.exitCode === null) {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
          await once(child, 'close');
        }
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

for (const unrelatedSession of [false, true])
  test(
    `hud panel displays ledger delegation ${unrelatedSession ? 'with an unrelated Codex session' : 'without a selected Codex session'}`,
    { skip },
    async () => {
      const { notifyFixture, reportFor } = await import('./b21-fixture.js');
      const f = await notifyFixture();
      const emptyCodex = mkdtempSync(join(tmpdir(), 'hud-panel-source-'));
      let child: ReturnType<typeof spawn> | undefined;
      try {
        await reportFor(f, 'completed');
        if (unrelatedSession) {
          const date = new Date();
          const day = join(
            emptyCodex,
            'sessions',
            String(date.getFullYear()),
            String(date.getMonth() + 1).padStart(2, '0'),
            String(date.getDate()).padStart(2, '0')
          );
          mkdirSync(day, { recursive: true });
          const stamp = date.toISOString().slice(0, 19).replaceAll(':', '-');
          writeFileSync(
            join(day, `rollout-${stamp}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl`),
            JSON.stringify({
              type: 'session_meta',
              timestamp: date.toISOString(),
              payload: {
                id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                cwd: emptyCodex,
                timestamp: date.toISOString(),
                cli_version: 'synthetic',
              },
            }) + '\n'
          );
          const finderModule = pathToFileURL(resolve('dist/collectors/session-finder.js')).href;
          const probe = spawnSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `const m = await import(${JSON.stringify(finderModule)}); process.stdout.write(new m.SessionFinder(process.cwd()).check()?.sessionId ?? '');`,
            ],
            {
              cwd: emptyCodex,
              env: { PATH: '/usr/bin:/bin', HOME: emptyCodex, CODEX_HOME: emptyCodex },
              encoding: 'utf8',
              timeout: 5000,
            }
          );
          assert.equal(probe.status, 0, probe.stderr);
          assert.equal(
            probe.stdout,
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'the unrelated Codex session is selectable'
          );
        }
        child = spawn(process.execPath, [resolve('bin/hud'), 'panel'], {
          cwd: emptyCodex,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: emptyCodex,
            CODEX_HOME: emptyCodex,
            HUD_HOME: f.root,
            COLUMNS: '120',
            LINES: '50',
            LANG: 'C',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        });
        let output = '';
        let errors = '';
        child.stderr!.setEncoding('utf8');
        child.stderr!.on('data', (chunk: string) => {
          errors += chunk;
        });
        const matched = await new Promise<boolean>((resolvePromise) => {
          const timer = setTimeout(() => resolvePromise(false), 8000);
          child!.stdout!.setEncoding('utf8');
          child!.stdout!.on('data', (chunk: string) => {
            output += chunk;
            if (/implementer|Synthetic B21 task outcome/.test(output)) {
              clearTimeout(timer);
              resolvePromise(true);
            }
          });
          child!.once('exit', () => {
            clearTimeout(timer);
            resolvePromise(false);
          });
        });
        assert.ok(matched, `delegation was not rendered; stderr=${errors}; output=${output.slice(-12000)}`);
        child.stdin!.end();
        const [code] = await once(child, 'close');
        assert.equal(code, 0, errors);
        child = undefined;
      } finally {
        if (child && child.exitCode === null) {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
          await once(child, 'close');
        }
        await f.close();
        rmSync(emptyCodex, { recursive: true, force: true });
      }
    }
  );

test('B11 real bin entry reports an unavailable MCP build in an installation path with spaces', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'hud b11 install '));
  try {
    mkdirSync(join(root, 'bin'));
    cpSync(resolve('dist'), join(root, 'dist'), { recursive: true });
    cpSync(resolve('bin/hud'), join(root, 'bin/hud'));
    writeFileSync(join(root, 'bin/hud-run'), '');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const result = spawnSync(process.execPath, [join(root, 'bin/hud'), 'claude'], {
      env: { PATH: '/usr/bin:/bin', HOME: root, HUD_HOME: root },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /hud_mcp_unbuilt_run_npm_run_build_hud_mcp/);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(join(root, 'ledger.sqlite')), false);
    const compiled = join(root, 'packages/hud-mcp/dist/packages/hud-mcp/src');
    mkdirSync(compiled, { recursive: true });
    writeFileSync(join(compiled, 'config.js'), "import './missing-built-dependency.js';\n");
    const partial = spawnSync(process.execPath, [join(root, 'bin/hud'), 'claude'], {
      env: { PATH: '/usr/bin:/bin', HOME: root, HUD_HOME: root },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(partial.status, 1);
    assert.match(partial.stderr, /hud_mcp_unbuilt_run_npm_run_build_hud_mcp/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'B11 waiter generation check observes scope/context retirement during the registration gap',
  { skip },
  async () => {
    const f = await handshakeFixture();
    let change: Promise<unknown> | undefined;
    try {
      await assert.rejects(
        runWait(parseWait(['run-a', '--owner-generation', '1', '--timeout-ms', '100']), f.root, io(f.root).value, {
          subscribe: () => {
            change = f.ledger.transaction((tx) =>
              tx.run("UPDATE caller_contexts SET closed_at=2000 WHERE context_id='context-parent'")
            );
            return { unavailable: true, close() {} };
          },
        }),
        /stale_generation/
      );
      await change;
    } finally {
      await change;
      await f.close();
    }
  }
);

function io(home: string) {
  let stdout = '',
    stderr = '';
  const value: HudIO = {
    env: { ...process.env, HUD_HOME: home },
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  };
  return { value, output: () => ({ stdout, stderr }) };
}

for (const command of ['status', 'cancel', 'reconcile', 'resume', 'wait', 'claude']) {
  test(`B11 ${command} --help succeeds before HUD_HOME access or argument validation without a ledger`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'hud-b11-help-'));
    try {
      const args = command === 'claude' ? ['claude', '--help'] : ['run', command, '--help'];
      const usage = `Usage: hud ${command === 'claude' ? 'claude' : `run ${command}`} `;
      const output = io(root);
      assert.equal(await main(args, output.value), 0);
      assert.ok(output.output().stdout.startsWith(usage), output.output().stdout);
      assert.equal(output.output().stderr, '');
      assert.deepEqual(readdirSync(root), []);

      const unreadHome = io(join(root, 'missing'));
      Object.defineProperty(unreadHome.value.env, 'HUD_HOME', {
        get() {
          assert.fail('help must not read HUD_HOME');
        },
      });
      assert.equal(await main(args, unreadHome.value), 0);
      assert.deepEqual(unreadHome.output(), output.output());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('B11 run --help describes independent parent checks and ledger/watch recovery', async () => {
  const output = io('relative');
  assert.equal(await main(['run', '--help'], output.value), 0);
  assert.match(output.output().stdout, /parent process every 2 seconds; ledger\/watch recovery is every 29 seconds/);
  assert.equal(output.output().stderr, '');
});

test('B11 cancellation remains durably accepted when the subsequent status refresh fails', { skip }, async () => {
  const f = await handshakeFixture();
  const output = io(f.root);
  const original = LedgerRunFactPort.prototype.read;
  let reads = 0;
  LedgerRunFactPort.prototype.read = async function (id) {
    if (++reads > 1) throw new Error('synthetic_post_commit_read_failure');
    return original.call(this, id);
  };
  try {
    assert.equal(await runCommand(['cancel', 'run-a', '--grace', '0'], f.root, output.value), 0);
    const result = JSON.parse(output.output().stdout);
    assert.equal(result.accepted, true);
    assert.equal(result.status, null);
    assert.equal(
      f.ledger.snapshot(
        (tx) => tx.get("SELECT count(*) AS n FROM events WHERE run_id='run-a' AND kind='cancel.accepted'")!.n
      ),
      1
    );
  } finally {
    LedgerRunFactPort.prototype.read = original;
    await f.close();
  }
});

test('B11 strict local resume and wait parameters reject incomplete or ambiguous intents', () => {
  for (const args of [
    [],
    ['link-a'],
    ['link-a', '--request-key', 'key', '--mode', 'headless'],
    ['link-a', '--request-key', 'key', '--expected-run', 'run-a'],
    ['link-a', '--request-key', 'key', '--expected-run', 'run-a', '--mode', 'auto'],
  ])
    assert.throws(() => parseResume(args));
  const request = parseResume([
    'link-a',
    '--request-key',
    'opaque key:☃',
    '--expected-run',
    'run-a',
    '--mode',
    'headless',
    '--prompt',
    'x;$(touch never)',
  ]);
  assert.equal(request.request_key, 'opaque key:☃');
  assert.equal(request.prompt, 'x;$(touch never)');
  for (const args of [
    [],
    ['run-a', '--link', 'link-a'],
    ['run-a', '--notify', '--json'],
    ['run-a', '--timeout-ms', '-1'],
    ['run-a', '--until', 'report,report'],
    ['run-a', '--owner-generation', '0'],
  ])
    assert.throws(() => parseWait(args));
  assert.equal(parseWait(['--link', 'link-a']).timeoutMs, 7_200_000);
});

test('B11 unsafe HUD_HOME refuses before creating files or dispatching', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'hud-b11-home-'));
  try {
    const target = join(root, 'private');
    mkdirSync(target, { mode: 0o700 });
    const publicHome = join(root, 'public');
    mkdirSync(publicHome, { mode: 0o755 });
    chmodSync(publicHome, 0o755);
    const alias = join(root, 'alias');
    symlinkSync(target, alias);
    const parentAlias = join(root, 'parent');
    symlinkSync(root, parentAlias);
    for (const home of [
      'relative',
      join(root, 'missing'),
      publicHome,
      alias,
      alias + '/.',
      join(parentAlias, 'private'),
    ]) {
      const f = io(home);
      for (const args of [
        ['claude'],
        ['run', 'status', 'run-a'],
        ['run', 'wait', 'run-a', '--timeout-ms', '0'],
        ['run', 'cancel', 'run-a'],
        ['run', 'resume', 'link-a', '--request-key', 'x', '--expected-run', 'run-a', '--mode', 'headless'],
      ])
        assert.equal(await main(args, f.value), 3, JSON.stringify({ home, args }));
    }
    assert.deepEqual(readdirSync(target), []);
    assert.deepEqual(readdirSync(publicHome), []);
    assert.equal(existsSync(join(root, 'missing')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B11 wait registration race and lost hint recover using the real ledger, without writes', { skip }, async () => {
  for (const race of [true, false]) {
    const f = await handshakeFixture();
    const output = io(f.root);
    const cursor = f.ledger.snapshot((tx) => Number(tx.get('SELECT max(seq) AS n FROM events')!.n));
    let writes = 0;
    const commit = () => {
      writes++;
      const child = spawnSync(process.execPath, [resolve('tests/int/b6-commit.mjs'), join(f.root, 'ledger.sqlite')], {
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(child.status, 0, child.stderr);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!race) timer = setTimeout(commit, 20);
      const result = await runWait(
        parseWait(['run-a', '--after-seq', String(cursor), '--timeout-ms', '150', '--json']),
        f.root,
        output.value,
        {
          subscribe: () => {
            if (race) commit();
            return { unavailable: true, close() {} };
          },
        }
      );
      assert.equal(result, 0);
      const page = JSON.parse(output.output().stdout);
      assert.equal(page.matched, true);
      assert.equal(page.current.state, 'uncertain');
      assert.equal(page.watchUnavailable, true);
      assert.equal(writes, 1);
      assert.equal(
        f.ledger.snapshot((tx) => Number(tx.get('SELECT max(seq) AS n FROM events')!.n)),
        cursor + 1
      );
      assert.equal(
        f.ledger.snapshot(
          (tx) => tx.get('SELECT cancel_requested_at FROM runs WHERE run_id=?', 'run-a')!.cancel_requested_at
        ),
        null
      );
    } finally {
      clearTimeout(timer);
      await f.close();
    }
  }
});

test(
  'B11 notify drains multi-page high-water, strips bodies and leaves the caller cursor independent',
  { skip },
  async () => {
    const f = await handshakeFixture();
    const output = io(f.root);
    try {
      await f.ledger.transaction((tx) => {
        for (let i = 0; i < 405; i++)
          tx.run(
            "INSERT INTO events(link_id,run_id,kind,payload,at) VALUES('link-a','run-a','test.progress',?,?)",
            JSON.stringify({ summary: 'PRIVATE-SYNTHETIC', path: '/synthetic/private' }),
            4000 - i
          );
        tx.run("UPDATE runs SET state='uncertain' WHERE run_id='run-a'");
      });
      const through = f.ledger.snapshot((tx) => Number(tx.get('SELECT max(seq) AS n FROM events')!.n));
      await runWait(parseWait(['--link', 'link-a', '--timeout-ms', '0', '--notify']), f.root, output.value, {
        afterWait: async () => {
          await f.ledger.transaction((tx) => {
            tx.run(
              "INSERT INTO events(link_id,run_id,kind,payload,at) VALUES('link-a','run-a','test.later','{}',5000)"
            );
          });
        },
      });
      const line = output.output().stdout;
      assert.equal(line.split('\n').length, 2);
      assert.ok(Buffer.byteLength(line) <= 512);
      assert.match(line, /kinds=run:uncertain/);
      assert.match(line, /afterSeq:<your cursor>/);
      assert.ok(line.includes('throughSeq=' + through + ' '), 'concurrent commit cannot expand the captured drain');
      assert.doesNotMatch(line, /PRIVATE|\/synthetic/);
      const json = io(f.root);
      await runWait(parseWait(['run-a', '--timeout-ms', '0', '--json']), f.root, json.value);
      const page = JSON.parse(json.output().stdout);
      assert.equal(page.events.length, 200);
      assert.equal(page.hasMore, true);
      assert.doesNotMatch(json.output().stdout, /PRIVATE|\/synthetic|launchTokenHash|launchCwd/);
    } finally {
      await f.close();
    }
  }
);

test('B11 local resume preserves all parameters, rejects stale/active, replays once through B4', { skip }, async () => {
  const f = await delegationBenchmarkFixture();
  let launches = 0;
  try {
    await f.bindAndEnd();
    const profile = { ...f.service['options'].config.profiles[0] };
    writeFileSync(join(f.root, 'delegate.json'), JSON.stringify({ version: 1, profiles: [profile] }), { mode: 0o600 });
    const trusted = {
      capability: { verify: () => ({ ok: true as const, reason: null }) },
      resumeService: (options: ResumeServiceOptions) =>
        new DelegationService({
          ...options,
          launch: async (launch: PreparedRunLaunch) => {
            launches++;
            assert.equal(launch.payload.parent, undefined);
            return { pid: 123, completion: Promise.resolve({ code: 0, signal: null }) };
          },
        } as unknown as DelegationOptions),
    };
    const command = [
      'resume',
      'link-a',
      '--request-key',
      'b11-key',
      '--expected-run',
      'run-a',
      '--mode',
      'headless',
      '--prompt',
      'synthetic supplement',
    ];
    const first = io(f.root);
    await runCommand(command, f.root, first.value, trusted);
    const accepted = JSON.parse(first.output().stdout);
    assert.equal(accepted.ok, true);
    assert.notEqual(accepted.runId, 'run-a');
    const replay = io(f.root);
    await runCommand(command, f.root, replay.value, trusted);
    assert.deepEqual(JSON.parse(replay.output().stdout), accepted);
    assert.equal(launches, 1);
    await assert.rejects(
      runCommand(
        command.map((s) => (s === 'b11-key' ? 'b11-new-stale' : s)),
        f.root,
        io(f.root).value,
        trusted
      ),
      /expected_run_mismatch/
    );
    const current = command.map((s) => (s === 'b11-key' ? 'b11-active' : s === 'run-a' ? accepted.runId : s));
    await assert.rejects(runCommand(current, f.root, io(f.root).value, trusted), /slot_busy/);
    const audit = f.ledger.snapshot((tx) =>
      tx.get("SELECT payload FROM events WHERE run_id=? AND kind='intent.accepted'", accepted.runId)
    );
    assert.equal(JSON.parse(String(audit!.payload)).actor.kind, 'local_user');
  } finally {
    await f.close();
  }
});

test('B11 standalone argv and explicit shell preserve special argument bytes in real processes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hud b11 argv '));
  const special = ["space and 'quote", 'line\nnext', '$HOME;$(touch INJECTED)', '`whoami`', 'a=b'];
  try {
    const script = join(root, 'capture.mjs');
    writeFileSync(
      script,
      'import {writeFileSync} from "node:fs";writeFileSync(process.argv[2],JSON.stringify(process.argv.slice(3)));'
    );
    for (const shell of [false, true]) {
      const output = join(root, shell ? 'shell.json' : 'argv.json');
      const command = shell
        ? { shell: `${shellQuote(process.execPath)} ${shellQuote(script)} {{out}}`, shellPath: '/bin/sh' }
        : { argv: [process.execPath, script, '{{out}}'] };
      assert.equal(
        await foreground(appendArguments(resolveLaunchCommand(command, { out: output }), special), {
          PATH: process.env.PATH,
        }),
        0
      );
      assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), special);
    }
    assert.equal(existsSync('INJECTED'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'B11 Claude hook --settings preserves explicit user hooks and exact env without qualification gates',
  { skip },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'hud-b11-claude-'));
    const profile = {
      name: 'claude-test',
      harness: 'claude',
      source: { root, label: 'Synthetic' },
      launch: { argv: [process.execPath] },
      headless: null,
      resume: { argv: [process.execPath, '--resume', '{{sessionId}}'] },
      resumeHeadless: null,
      host: { kind: 'tmux', layout: 'pane' },
      env: {},
      mcpServerName: 'hud.synthetic',
      claimTransport: 'config_env',
      clientToolTimeoutMs: 60000,
      responseMarginMs: 2000,
      orphan_policy: 'continue',
      managedShellVerified: false,
      callSource: { kind: 'claude_pre_tool_use_v1' },
    };
    const settingsFile = join(root, 'existing.json');
    const settings = {
      permissions: { allow: ['synthetic'] },
      hooks: {
        PreToolUse: [{ matcher: 'old', hooks: [{ type: 'command', command: 'true' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'true' }] }],
      },
    };
    writeFileSync(join(root, 'delegate.json'), JSON.stringify({ version: 1, profiles: [profile] }));
    writeFileSync(settingsFile, JSON.stringify(settings));
    try {
      const before = readdirSync(root);
      assert.equal(
        await claudeCommand([], root, io(root).value, {
          verify: async () => {
            throw new Error('ordinary launch must not query qualification');
          },
          launch: async () => 0,
        }),
        0
      );
      assert.deepEqual(readdirSync(root), before);
      let launched = 0;
      await claudeCommand(['--resume', 'synthetic-session', '--settings', settingsFile], root, io(root).value, {
        verify: async () => true,
        launch: async (command, env) => {
          launched++;
          assert.ok(command.argv);
          assert.deepEqual(command.argv.slice(1, 3), ['--resume', 'synthetic-session']);
          const settings = JSON.parse(readFileSync(command.argv.at(-1)!, 'utf8'));
          assert.equal(settings.hooks.PreToolUse.length, 2);
          assert.equal(settings.hooks.PreToolUse[0].matcher, 'old');
          assert.deepEqual(settings.permissions.allow, ['synthetic']);
          assert.equal(settings.hooks.Stop.length, 1);
          assert.equal(env.HUD_HOME, root);
          assert.equal(env.CLAUDE_CONFIG_DIR, root);
          assert.equal(env.HUD_MCP_PROFILE, profile.name);
          const hook = JSON.parse(readFileSync(env.HUD_CLAUDE_HOOK_CONFIG!, 'utf8'));
          assert.equal(hook.serverName, profile.mcpServerName);
          assert.equal(hook.sourceRoot, root);
          return 0;
        },
      });
      assert.equal(launched, 1);
      for (const override of [['--profile', profile.name, '--', process.execPath, 'synthetic-argument']]) {
        const overrideIO = io(root);
        overrideIO.value.env.SHELL = '/bin/sh';
        await claudeCommand(override, root, overrideIO.value, {
          verify: async (effective) => {
            assert.notEqual(launchProfileDigest(effective), launchProfileDigest(profile as LaunchProfile));
            return true;
          },
          launch: async (_command, env) => {
            const hook = JSON.parse(readFileSync(env.HUD_CLAUDE_HOOK_CONFIG!, 'utf8'));
            assert.equal(hook.profileFingerprint, launchProfileDigest(profile as LaunchProfile));
            return 0;
          },
        });
      }
      const shellIO = io(root);
      shellIO.value.env.SHELL = '/bin/sh';
      await assert.rejects(
        claudeCommand(['--profile', profile.name, '--shell', shellQuote(process.execPath)], root, shellIO.value, {
          verify: async () => true,
          launch: async () => {
            assert.fail('shellPath cannot stand in for the actual Claude executable');
          },
        }),
        /shell_hook_target_unverified/
      );
      for (const settingsArgs of [['--settings', settingsFile], ['--settings=' + settingsFile]]) {
        const configured = {
          ...profile,
          launch: { argv: [process.execPath, ...settingsArgs, '--', 'literal prompt', '--settings', '$HOME;not-code'] },
        };
        writeFileSync(join(root, 'delegate.json'), JSON.stringify({ version: 1, profiles: [configured] }));
        await claudeCommand([], root, io(root).value, {
          verify: async () => true,
          launch: async (command, env) => {
            const argv = command.argv!;
            const at = argv.indexOf('--settings');
            assert.ok(at < argv.indexOf('--'));
            assert.deepEqual(argv.slice(argv.indexOf('--')), ['--', 'literal prompt', '--settings', '$HOME;not-code']);
            assert.equal(argv.slice(0, argv.indexOf('--')).filter((arg) => arg === '--settings').length, 1);
            const merged = JSON.parse(readFileSync(argv[at + 1], 'utf8'));
            assert.equal(merged.hooks.PreToolUse[0].matcher, 'old');
            assert.equal(merged.hooks.PreToolUse.length, 2);
            assert.deepEqual(merged.permissions, settings.permissions);
            const hook = JSON.parse(readFileSync(env.HUD_CLAUDE_HOOK_CONFIG!, 'utf8'));
            assert.equal(hook.profileFingerprint, launchProfileDigest(configured as LaunchProfile));
            return 0;
          },
        });
        await assert.rejects(
          claudeCommand(['--settings', settingsFile], root, io(root).value, { verify: async () => true }),
          /multiple_settings_sources/
        );
      }
      assert.deepEqual(readdirSync(root), before);
      assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), settings);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test('B11 large-history wait pages never query or decode unbounded event history', { skip }, async () => {
  const f = await handshakeFixture();
  const original = LedgerTransaction.prototype.all;
  let eventRows = 0;
  let child: ReturnType<typeof spawn> | undefined;
  let done: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  try {
    await f.ledger.transaction((tx) => {
      for (let i = 0; i < 10_000; i++)
        tx.run(
          "INSERT INTO events(link_id,run_id,kind,payload,at) VALUES('link-a','run-a','test.progress','{}',?)",
          i + 2000
        );
    });
    LedgerTransaction.prototype.all = function (sql, ...params) {
      if (/\bFROM\s+events\b/i.test(sql))
        assert.match(sql, /\bLIMIT\s+201\b/i, 'wait must use the indexed bounded cursor query');
      const rows = original.call(this, sql, ...params);
      if (/\bFROM\s+events\b/i.test(sql)) eventRows += rows.length;
      return rows;
    };
    const output = io(f.root);
    await runWait(parseWait(['run-a', '--timeout-ms', '0', '--json']), f.root, output.value);
    assert.equal(JSON.parse(output.output().stdout).events.length, 200);
    assert.equal(eventRows, 201);
    LedgerTransaction.prototype.all = original;
    child = spawn(process.execPath, [resolve('tests/int/b11-drain-signal.mjs'), f.root], {
      env: { PATH: '/usr/bin:/bin', HOME: f.root, HUD_HOME: f.root },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '',
      stderr = '';
    child.stdout!.on('data', (data) => (stdout += data));
    child.stderr!.on('data', (data) => (stderr += data));
    done = new Promise((resolve) => child!.once('exit', (code, signal) => resolve({ code, signal })));
    await Promise.race([
      once(child, 'message'),
      done.then(() => {
        throw new Error('drainer exited before its checkpoint: ' + stderr);
      }),
    ]);
    child.kill('SIGTERM');
    assert.equal((await done).code, 143, stderr);
    assert.match(stderr, /terminated/);
    assert.equal(stdout, '');
  } finally {
    LedgerTransaction.prototype.all = original;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done;
    await f.close();
  }
});
