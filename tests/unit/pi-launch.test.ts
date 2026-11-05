import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parsePiLaunch, piLaunchEnvironment, piLaunchCommand, PI_LAUNCH_HELP } from '../../src/cli/pi-launch.js';
import { main } from '../../src/cli/hud.js';

test('native pi arguments preserve bytes and shell metacharacters without shell execution', () => {
  const native = ['--session', '/a path/session.jsonl', '--print', '$(touch /not-executed); x', '', '--', '-prompt'];
  assert.deepEqual(parsePiLaunch(['--', ...native]), { argv: ['pi', ...native] });
  assert.deepEqual(parsePiLaunch([]), { argv: ['pi'] });
  assert.deepEqual(parsePiLaunch(['--executable', '/path with spaces/pi', '--', '--help']), {
    argv: ['/path with spaces/pi', '--help'],
  });
  for (const args of [['--print'], ['--executable', 'relative'], ['--executable'], ['--shell', 'pi'], ['--', 'x\0y']])
    assert.throws(() => parsePiLaunch(args), /invalid_pi_launch_arguments/);
});

test('local launch removes inherited managed authority and session identity without mutating parent env', () => {
  const env = {
    PATH: '/native/bin',
    PI_CODING_AGENT_DIR: '/native/config',
    API_KEY: 'synthetic-secret',
    HUD_HOME: '/hud',
    HUD_CLAIM: 'claim',
    HUD_RUN: 'run',
    HUD_LINK: 'link',
    HUD_MCP_REGISTRY_DIR: '/registry',
    HUD_RUN_PORT_MODULE: '/module',
    PI_SESSION_ID: 'parent-id',
    PI_SESSION_FILE: '/parent.jsonl',
  };
  assert.deepEqual(piLaunchEnvironment(env), {
    PATH: '/native/bin',
    PI_CODING_AGENT_DIR: '/native/config',
    API_KEY: 'synthetic-secret',
    HUD_HOME: '/hud',
  });
  assert.equal(env.HUD_CLAIM, 'claim');
});

test('launch executes exactly once, preserves child result, and refuses invalid args before dispatch', async () => {
  let calls = 0;
  const io = { env: { HUD_CLAIM: 'secret' }, stdout() {}, stderr() {} };
  assert.equal(
    await piLaunchCommand(['--', '--continue'], io, async (command, env) => {
      calls++;
      assert.deepEqual(command, { argv: ['pi', '--continue'] });
      assert.equal(env.HUD_CLAIM, undefined);
      return 7;
    }),
    7
  );
  assert.equal(calls, 1);
  await assert.rejects(
    piLaunchCommand(['--executable', 'relative'], io, async () => {
      calls++;
      return 0;
    }),
    /invalid_pi_launch_arguments/
  );
  assert.equal(calls, 1);
  await assert.rejects(
    piLaunchCommand([], io, async () => {
      calls++;
      throw new Error('PRIVATE_ARG');
    }),
    (error: unknown) => error instanceof Error && error.message === 'pi_launch_failed'
  );
  assert.equal(calls, 2);
});

test('shared HUD launch help needs no home, process, configuration or capability promotion', async () => {
  let stdout = '',
    stderr = '';
  assert.equal(
    await main(['pi', 'launch', '--help'], {
      env: { HUD_HOME: 'invalid-relative' },
      stdout: (s) => {
        stdout += s;
      },
      stderr: (s) => {
        stderr += s;
      },
    }),
    0
  );
  assert.equal(stdout, PI_LAUNCH_HELP);
  assert.equal(stderr, '');
});

test('built hud launches a synthetic native process with exact argv/cwd/env and preserves nonzero exit', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hud-pi-local-launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'fake pi.mjs');
  writeFileSync(
    script,
    `console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),claim:process.env.HUD_CLAIM??null,session:process.env.PI_SESSION_ID??null,config:process.env.PI_CODING_AGENT_DIR}));process.exitCode=7;`
  );
  const args = ['--session', '/synthetic file', '--print', '$(echo unsafe); literal'];
  const child = spawnSync(
    process.execPath,
    [resolve('bin/hud'), 'pi', 'launch', '--executable', process.execPath, '--', script, ...args],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        HOME: root,
        HUD_HOME: 'invalid-relative',
        HUD_CLAIM: 'parent',
        PI_SESSION_ID: 'parent',
        PI_CODING_AGENT_DIR: root,
      },
    }
  );
  assert.equal(child.status, 7, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { args, cwd: root, claim: null, session: null, config: root });
});

test('missing executable yields typed failure without retry or secret diagnostics', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hud-pi-no-executable-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = spawnSync(
    process.execPath,
    [resolve('bin/hud'), 'pi', 'launch', '--executable', join(root, 'missing'), '--', 'PRIVATE'],
    {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, HOME: root, HUD_HOME: root },
    }
  );
  assert.equal(child.status, 4);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, 'pi_launch_failed\n');
});

test('synthetic child signal exits follow the documented foreground compatibility mapping', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hud-pi-signal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'signal.mjs');
  writeFileSync(script, 'process.kill(process.pid, process.argv[2]);');
  for (const [signal, expected] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGKILL', 1],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      [resolve('bin/hud'), 'pi', 'launch', '--executable', process.execPath, '--', script, signal],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, HOME: root, HUD_HOME: root },
      }
    );
    assert.equal(result.status, expected, result.stderr);
    assert.equal(result.stdout, '');
  }
});
