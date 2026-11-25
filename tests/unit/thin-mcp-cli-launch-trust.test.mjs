import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import * as TOML from '@iarna/toml';
import { parseProcStat } from '../../dist/utils/proc.js';

const roleText = fs.readFileSync('packages/hud-mcp/instructions/general.md', 'utf8');
import {
  workerFor,
  cardText,
  withoutHint,
  withoutCallerLookups,
  legacyFixture as fixture,
  until,
  assertCliStatus,
  cliState,
} from '../helpers/thin-mcp-harness.mjs';

test(
  'a grok role runs a brief through idle grace and the watcher reaps the closed tab',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const job = await f.call('hud_create', {
      role: 'general',
      on: 'grok',
      request_key: 'grok-life',
      task: 'Synthetic grok task.',
    });
    const tab = f.commands().find(({ command, args }) => command === 'herdr' && args[0] === 'tab' && args[1] === 'create').args;
    assert.equal(tab[tab.indexOf('--env') + 1], `HUD_JOB_DIR=${job.task_dir}`);
    const start = f.commands().find((c) => c.args[0] === 'agent' && c.args[1] === 'start').args;
    const dash = start.indexOf('--');
    assert.deepEqual(start.slice(0, dash), [
      'agent',
      'start',
      `${job.job}-primary`,
      '--kind',
      'grok',
      '--pane',
      'w4E:p2',
    ]);
    assert.match(tab.find((arg, i) => tab[i - 1] === '--env' && arg.startsWith('HUD_INVOCATION_TOKEN=')), /^HUD_INVOCATION_TOKEN=[a-f0-9-]+$/);
    assert.deepEqual(start.slice(dash + 1), [
      '-m',
      'grok-4.7',
      '--reasoning-effort',
      'high',
      '--permission-mode',
      'bypassPermissions',
    ]);
    assert.equal(
      start.some((arg) => /^--(home|session|config|profile|worktree)/.test(arg)),
      false
    );
    const prompt = f.commands().find((c) => c.args[1] === 'prompt' && c.args[3] !== '/quit').args[3];
    assert.ok(prompt.startsWith(`${roleText.trimEnd()}\n\nCarry out this brief:`));
    assert.ok(prompt.includes(fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8')));
    assert.match(prompt, /Synthetic grok task/);
    const session = Object.fromEntries(
      fs
        .readFileSync(join(job.task_dir, 'SESSION.txt'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('='))
    );
    assert.equal(session.TASK, job.job);
    assert.equal(session.TAB, 'w4E:t2');
    assert.ok(session.TAB_NAME);
    assert.equal(session.LEFT, 'w4E:p2');
    assert.equal(session.RIGHT, '');
    assert.equal(session.ORCH, 'w4E:p1');
    assert.equal(session.BASE, 'HEAD');
    assert.equal(session.PRIMARY, `${job.job}-primary`);
    await until(() => fs.existsSync(join(f.env.HOME, 'seen-grace.json')), t.signal);
    const grace = JSON.parse(fs.readFileSync(join(f.env.HOME, 'seen-grace.json'), 'utf8'));
    assertCliStatus(grace, job.task_dir);
    assert.equal(grace.state, 'idle_grace');
    assert.equal(grace.output_written, true);
    assert.equal(grace.model, 'grok-4.7');
    assert.equal(grace.thinking, 'high');
    assert.equal(grace.agent_session_id, 'synthetic-grok-session');
    assert.equal(typeof grace.pid, 'number');
    assert.match(grace.pid_start_time, /^\d+$/);
    assert.equal(String(grace.supervisor_pid), fs.readFileSync(join(job.task_dir, 'supervisor.pid'), 'utf8').trim());
    assert.equal(f.commands().some((c) => c.args[1] === 'wait' && c.args.includes('blocked')), false);
    assert.ok(f.socketRequests.some((req) => req.method === 'agent.get'));
    await until(() => {
      const file = join(job.task_dir, 'STATUS.json');
      return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).state === 'closed';
    }, t.signal);
    const closed = JSON.parse(fs.readFileSync(join(job.task_dir, 'STATUS.json'), 'utf8'));
    assertCliStatus(closed, job.task_dir);
    assert.equal(closed.state, 'closed');
    assert.equal(closed.exit_reason, 'settled');
    assert.equal(closed.output_written, true);
    assert.equal(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'), 'Synthetic grok report.\n');
    assert.ok(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'));
    assert.match(cardText(workerFor(f, job.job)), /\bgeneral\b/);
    assert.match(cardText(workerFor(f, job.job)), /Synthetic grok report/);
    await until(() => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at, t.signal);
    assert.ok(f.commands().some((c) => c.command === 'hud-reap' && c.args[0] === job.task_dir));
  }
);

// This scenario launches and settles two CLI jobs; the timeout is a hang guard, not a launch SLA.
test('cli launch accepts model and thinking overrides and refuses pi-only switches', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  for (const [key, value] of [
    ['pi_args', ['--tools', 'read']],
    ['lens', true],
  ])
    assert.deepEqual(
      withoutHint(await f.call('hud_create', { role: 'general', on: 'grok', request_key: 'reject-' + key, task: 'Synthetic.', [key]: value })),
      { ok: false, code: 'invalid_arguments' }
    );
  assert.deepEqual(withoutCallerLookups(f.commands()), []);
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'roles', 'plain.json'),
    JSON.stringify({
      role: 'plain-grok',
      harness: 'cli',
      agent: 'grok',
      can_continue: false,
      args: ['--extra', 'literal space'],
    })
  );
  const job = await f.call('hud_create', {
    role: 'general',
    on: 'grok',
    request_key: 'grok-override',
    task: 'Synthetic override.',
    model: 'grok-4.7-build-fast',
    thinking: 'low',
  });
  const start = f.commands().find((c) => c.args[1] === 'start').args;
  assert.deepEqual(start.slice(start.indexOf('--') + 1), [
    '-m',
    'grok-4.7-build-fast',
    '--reasoning-effort',
    'low',
    '--permission-mode',
    'bypassPermissions',
  ]);
  const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8'));
  assert.equal(receipt.model, 'grok-4.7-build-fast');
  assert.equal(receipt.thinking, 'low');
  assert.equal(receipt.model_source, 'hud_create');
  await until(() => cliState(job.task_dir)?.state === 'closed', 15000);
  const plain = await f.call('hud_create', { role: 'plain-grok', request_key: 'plain', task: 'Synthetic plain.' });
  const plainStart = f
    .commands()
    .filter((c) => c.args[1] === 'start')
    .at(-1).args;
  assert.deepEqual(plainStart.slice(plainStart.indexOf('--') + 1), [
    '--permission-mode',
    'bypassPermissions',
    '--extra',
    'literal space',
  ]);
  await until(() => ['closed', 'failed'].includes(cliState(plain.task_dir)?.state), 15000);
});

test('unsafe configured CLI arguments skip the place before opening a tab', async (t) => {
  const f = await fixture(t);
  const roles = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(roles);
  fs.writeFileSync(join(roles, 'unsafe-args.json'), JSON.stringify({ role: 'unsafe-args', instructions: 'implementer',
    can_continue: false, run: [
      { harness: 'cli', agent: 'claude', args: ['--extra', 'synthetic\u0085value'] },
      { harness: 'cli', agent: 'grok' },
    ] }));
  const job = await f.call('hud_create', { role: 'unsafe-args', task: 'Synthetic fallback.' });
  assert.ok(job.job);
  const commands = f.commands();
  assert.equal(commands.filter(({ args }) => args[0] === 'tab' && args[1] === 'create').length, 1);
  const starts = commands.filter(({ args }) => args[0] === 'agent' && args[1] === 'start');
  assert.deepEqual(starts.map(({ args }) => args[args.indexOf('--kind') + 1]), ['grok']);
});

test('local CLI trust refuses missing grants without creating a tab', async (t) => {
  const f = await fixture(t);
  const cwd = join(f.root, 'quota fixtures');
  fs.mkdirSync(cwd);
  fs.unlinkSync(join(f.env.HOME, '.gemini', 'antigravity-cli', 'settings.json'));
  for (const agent of ['grok', 'agy', 'claude']) {
    const args = { role: 'general', on: agent, request_key: `not-trusted-${agent}`, task: 'Synthetic task.', cwd };
    const job = await f.call('hud_create', args);
    assert.equal(job.ok, false);
    assert.equal(job.code, 'untrusted_cwd');
    assert.equal(job.reason, `${agent} has not trusted ${cwd}; run hud trust ${cwd}`);
    assert.equal(job.agent, null);
    assert.equal(cliState(job.task_dir).state, 'failed');
    assert.deepEqual(await f.call('hud_create', args), withoutHint(job));
  }
  assert.equal(f.commands().some(({ args }) => args[0] === 'tab' && args[1] === 'create'), false);
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'exhausted.json')), false);
});

test('a grok trust dialog is declined and the job fails naming the directory', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'trust-dialog'), '');
  const args = { role: 'general', on: 'grok', request_key: 'grok-trust', task: 'Synthetic trust.' };
  const job = await f.call('hud_create', args);
  const status = JSON.parse(fs.readFileSync(join(job.task_dir, 'STATUS.json'), 'utf8'));
  const cwd = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8')).cwd;
  assert.equal(job.ok, false);
  assert.equal(job.code, 'dispatch_failed');
  assert.equal(job.reason, `grok has not trusted ${cwd}; run hud trust ${cwd}`);
  assert.deepEqual(await f.call('hud_create', args), withoutHint(job));
  assertCliStatus(status, job.task_dir);
  assert.equal(status.state, 'failed');
  assert.equal(status.error, `grok has not trusted ${cwd}; run hud trust ${cwd}`);
  assert.equal(status.exit_reason, 'untrusted_cwd');
  const commands = f.commands();
  const decline = commands.find((c) => c.args[1] === 'send-keys');
  assert.deepEqual(decline.args.slice(3), ['n']);
  assert.ok(commands.some((c) => c.args[1] === 'wait' && c.args.includes('idle')));
  assert.equal(
    commands.some((c) => c.args[1] === 'prompt'),
    false
  );
  assert.equal(fs.existsSync(join(job.task_dir, 'supervisor.pid')), false);
  assert.ok(commands.some((c) => c.args[0] === 'tab' && c.args[1] === 'close' && c.args[2] === 'w4E:t2'));
});

test(
  'an agy role launches without an effort flag, and a startup done does not settle the job',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(join(f.env.HOME, 'startup-done'), '');
    const job = await f.call('hud_create', { role: 'general', on: 'agy', request_key: 'agy-life', task: 'Synthetic agy task.' });
    const start = f.commands().find((c) => c.args[1] === 'start').args;
    assert.deepEqual(start.slice(start.indexOf('--') + 1), [
      '--model',
      'gemini-4-argon-high',
      '--dangerously-skip-permissions',
    ]);
    assert.equal(start.includes('--effort'), false);
    await until(() => cliState(job.task_dir)?.state === 'closed', t.signal);
    const commands = f.commands();
    const promptAt = commands.findIndex((c) => c.args[1] === 'prompt' && c.args[3] !== '/quit');
    assert.ok(promptAt >= 0);
    const firstPrompt = commands[promptAt].args[3];
    assert.ok(firstPrompt.startsWith(`${roleText.trimEnd()}\n\nCarry out this brief:\n\nSynthetic agy task.`));
    assert.doesNotMatch(firstPrompt, /Read .*instructions\/general\.md/);
    assert.equal(commands.some((c) => c.args[1] === 'wait' && c.args.includes('blocked')), false);
    const closed = cliState(job.task_dir);
    assert.equal(closed.agent, 'agy');
    assert.equal(closed.model, 'gemini-4-argon-high');
    assert.equal(closed.thinking, null);
    assert.equal(closed.state, 'closed');
    assert.equal(closed.exit_reason, 'settled');
    assert.equal(closed.error, null);
    assert.equal(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'), 'Synthetic grok report.\n');
    assert.ok(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'));
  }
);

test(
  'an agy worker prepends role instructions and a registered standing brief within bounds, falling back when oversized',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const hudDir = join(f.root, '.hud');
    const standing = join(hudDir, 'brief.md');
    const standingBody = '# Synthetic standing brief\nKeep all synthetic rules.\n';
    fs.mkdirSync(hudDir);
    fs.writeFileSync(standing, standingBody);

    const unregistered = await f.call('hud_create', {
      role: 'general',
      on: 'agy',
      request_key: 'agy-unreg-standing',
      task: 'Synthetic unregistered task.',
    });
    const unregPrompt = f.commands().find((c) => c.args[1] === 'prompt' && c.args[2] === `${unregistered.job}-primary`).args[3];
    assert.ok(unregPrompt.startsWith(`${roleText.trimEnd()}\n\nCarry out this brief:\n\nSynthetic unregistered task.`));
    assert.equal(unregPrompt.includes(standingBody.trimEnd()), false);
    assert.doesNotMatch(unregPrompt, /Read .*instructions\/general\.md/);
    await until(() => cliState(unregistered.task_dir)?.state === 'closed', 20000);

    fs.writeFileSync(join(f.env.HUD_HOME, 'projects.json'), JSON.stringify({
      version: 1,
      projects: [{ root: fs.realpathSync(f.root), registered_at: new Date().toISOString() }],
    }));

    const registered = await f.call('hud_create', {
      role: 'general',
      on: 'agy',
      request_key: 'agy-reg-standing',
      task: 'Synthetic registered task.',
    });
    const regPrompt = f.commands().find((c) => c.args[1] === 'prompt' && c.args[2] === `${registered.job}-primary`).args[3];
    assert.ok(regPrompt.startsWith(
      `${roleText.trimEnd()}\n\nProject standing brief (${JSON.stringify(join(fs.realpathSync(f.root), '.hud', 'brief.md'))}):\n\n${standingBody.trimEnd()}\n\nCarry out this brief:\n\nSynthetic registered task.`
    ));
    assert.doesNotMatch(regPrompt, /Read .*instructions\/general\.md/);
    assert.equal(regPrompt.includes('Read the project standing brief:'), false);
    assert.ok(fs.readFileSync(join(registered.task_dir, 'brief.md'), 'utf8').includes('Read the project standing brief:'));
    await until(() => cliState(registered.task_dir)?.state === 'closed', 20000);

    const oversizedBody = 'synthetic-rule\n'.repeat(1200);
    fs.writeFileSync(standing, oversizedBody);
    const oversized = await f.call('hud_create', {
      role: 'general',
      on: 'agy',
      request_key: 'agy-big-standing',
      task: 'Synthetic oversized standing task.',
    });
    const bigPrompt = f.commands().find((c) => c.args[1] === 'prompt' && c.args[2] === `${oversized.job}-primary`).args[3];
    assert.ok(bigPrompt.startsWith(`${roleText.trimEnd()}\n\nCarry out this brief:\n\nSynthetic oversized standing task.`));
    assert.equal(bigPrompt.includes(oversizedBody.trimEnd()), false);
    assert.ok(bigPrompt.includes(`Read the project standing brief: ${JSON.stringify(join(fs.realpathSync(f.root), '.hud', 'brief.md'))}.`));
    await until(() => cliState(oversized.task_dir)?.state === 'closed', 20000);
  }
);

test(
  'agent_not_ready runs the trust check for any kind, and a start error without that text is unchanged',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(join(f.env.HOME, 'start-not-ready'), '');
    fs.writeFileSync(join(f.env.HOME, 'trust-dialog'), 'Do you trust the contents of this project?');
    const agy = await f.call('hud_create', { role: 'general', on: 'agy', request_key: 'agy-trust', task: 'Synthetic trust.' });
    const agyStatus = cliState(agy.task_dir);
    const cwd = JSON.parse(fs.readFileSync(join(agy.task_dir, 'job.json'), 'utf8')).cwd;
    assert.equal(agyStatus.state, 'failed');
    assert.equal(agyStatus.error, `agy has not trusted ${cwd}; run hud trust ${cwd}`);
    assert.deepEqual(
      f
        .commands()
        .find((c) => c.args[1] === 'send-keys')
        .args.slice(3),
      ['down', 'enter']
    );
    assert.equal(
      f.commands().some((c) => c.args[1] === 'prompt'),
      false
    );
    assert.equal(fs.existsSync(join(agy.task_dir, 'supervisor.pid')), false);
    fs.unlinkSync(join(f.env.HOME, 'trust-dialog'));
    const bare = await f.call('hud_create', {
      role: 'general',
      on: 'agy',
      request_key: 'agy-not-ready',
      task: 'Synthetic not ready.',
    });
    assert.equal(f.commands().filter((c) => c.args[1] === 'send-keys').length, 1);
    assert.equal(cliState(bare.task_dir).exit_reason, 'agent_not_ready');
    const bareReceipt = JSON.parse(fs.readFileSync(join(bare.task_dir, 'job.json')));
    assert.equal(JSON.parse(bareReceipt.stderr_tail).error.code, 'agent_not_ready', 'JSON emitted on stdout is retained');
    assert.equal(fs.existsSync(join(bare.task_dir, 'supervisor.pid')), false);
    fs.writeFileSync(join(f.env.HOME, 'trust-dialog'), '');
    const grok = await f.call('hud_create', {
      role: 'general',
      on: 'grok',
      request_key: 'grok-not-ready',
      task: 'Synthetic grok trust.',
    });
    assert.deepEqual(
      f
        .commands()
        .filter((c) => c.args[1] === 'send-keys')
        .at(-1)
        .args.slice(3),
      ['n']
    );
    assert.match(cliState(grok.task_dir).error, /^grok has not trusted /);
  }
);

for (const witnessed of [true, false]) test(`Claude's versioned PATH symlink keeps the agent name (${witnessed ? 'witnessed' : 'plain'})`, { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const versioned = join(f.root, '2.1.999');
  // Use a native executable that leaves the kernel's comm intact (Node renames its main thread).
  fs.copyFileSync('/bin/sh', versioned);
  const claude = join(f.root, 'bin', 'claude');
  fs.unlinkSync(claude);
  fs.symlinkSync(versioned, claude);
  // Let dispatch generate the real shim, but stop fake Herdr before it creates its synthetic witness.
  fs.writeFileSync(join(f.env.HOME, 'fail-start-claude'), 'Synthetic start refusal.');
  const job = await f.call('hud_create', { role: 'general', on: 'claude', task: 'Synthetic versioned agent.' });
  assert.equal(job.code, 'dispatch_failed');
  const tab = f.commands().find(({ args }) => args[0] === 'tab' && args[1] === 'create').args;
  const env = { ...f.env, ...Object.fromEntries(tab.filter((_, i) => tab[i - 1] === '--env').map(arg => arg.split(/=(.*)/s, 2))) };
  if (!witnessed) delete env.HUD_INVOCATION_TOKEN;
  const shims = env.PATH.split(':')[0], proof = join(shims, 'witness.json');
  const nativeArgs = ['-c', '"$1" -e "$2" -- "$$"; exit $?', 'synthetic', process.execPath, `
    const pid = Number(process.argv[1]);
    const read = file => require('node:fs').readFileSync('/proc/' + pid + '/' + file, 'utf8');
    const [argv0, ...args] = read('cmdline').slice(0, -1).split('\\0');
    console.log(JSON.stringify({ comm: read('comm').trim(), argv0, pid, args, stat: read('stat'), token: !!process.env.HUD_INVOCATION_TOKEN }));
  `, 'native arg'];
  const child = spawnSync(join(shims, 'claude'), nativeArgs, { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  const { comm, argv0, pid, stat, args, token } = JSON.parse(child.stdout);
  assert.deepEqual({ comm, argv0 }, { comm: 'claude', argv0: 'claude' });
  assert.equal(pid, child.pid);
  assert.deepEqual(args, nativeArgs);
  assert.equal(token, false);
  if (witnessed) assert.deepEqual(JSON.parse(fs.readFileSync(proof, 'utf8')), { pid, start: parseProcStat(stat).start });
  else assert.equal(fs.existsSync(proof), false);
});

test('a claude role launches with its flags and settles through idle grace', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const owner = join(f.env.CLAUDE_CONFIG_DIR, '.claude.json');
  fs.writeFileSync(owner, JSON.stringify({ ...JSON.parse(fs.readFileSync(owner)), mcpServers: { extra: { command: 'synthetic' } } }));
  const job = await f.call('hud_create', {
    role: 'general',
    on: 'claude',
    request_key: 'claude-life',
    task: 'Synthetic claude task.',
  });
  const start = f.commands().find((c) => c.args[1] === 'start').args;
  const dash = start.indexOf('--');
  assert.deepEqual(start.slice(0, dash), [
    'agent',
    'start',
    `${job.job}-primary`,
    '--kind',
    'claude',
    '--pane',
    'w4E:p2',
  ]);
  const config = join(job.task_dir, 'worker-mcp.json');
  const roleFile = start.at(-1);
  assert.deepEqual(start.slice(dash + 1), ['--model', 'opus', '--effort', 'high', '--dangerously-skip-permissions',
    '--strict-mcp-config', '--mcp-config', config, '--append-system-prompt-file', roleFile]);
  assert.ok(start.slice(dash + 1).every((arg) => !/\p{Cc}/u.test(arg)));
  assert.equal(fs.readFileSync(roleFile, 'utf8'), roleText);
  const { mcpServers } = JSON.parse(fs.readFileSync(config));
  assert.deepEqual(Object.keys(mcpServers), ['hud']);
  assert.equal(mcpServers.hud.env.HUD_JOB_DIR, job.task_dir);
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.match(f.commands().find((c) => c.args[1] === 'prompt').args[3], /^Carry out this brief:\n\nSynthetic claude task\./);
  assert.equal(start.includes('--timeout'), false);
  await until(() => cliState(job.task_dir)?.state === 'closed', 20000);
  const closed = cliState(job.task_dir);
  assert.equal(closed.agent, 'claude');
  assert.equal(closed.model, 'opus');
  assert.equal(closed.thinking, 'high');
  assert.equal(closed.state, 'closed');
  assert.equal(closed.exit_reason, 'settled');
  assert.equal(closed.error, null);
  assert.ok(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'));
  assert.equal(
    f.commands().some((c) => c.args[1] === 'send-keys'),
    false
  );
});

test(
  'a claude trust dialog is declined with enter and the launch fails with the reason',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(join(f.env.HOME, 'start-not-ready'), '');
    fs.writeFileSync(join(f.env.HOME, 'trust-dialog'), 'Is this a project you created or one you trust?');
    const job = await f.call('hud_create', {
      role: 'general',
      on: 'claude',
      request_key: 'claude-trust',
      task: 'Synthetic trust.',
    });
    const status = cliState(job.task_dir);
    const cwd = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8')).cwd;
    assert.equal(status.state, 'failed');
    assert.equal(status.error, `claude has not trusted ${cwd}; run hud trust ${cwd}`);
    assert.deepEqual(
      f
        .commands()
        .find((c) => c.args[1] === 'send-keys')
        .args.slice(3),
      ['enter']
    );
    assert.equal(
      f.commands().some((c) => c.args[1] === 'prompt'),
      false
    );
    assert.equal(fs.existsSync(join(job.task_dir, 'supervisor.pid')), false);
  }
);

for (const agent of ['claude', 'codex']) test(`${agent}: role allowlist survives preset selection without changing owner config`, async (t) => {
  const f = await fixture(t);
  const roles = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(roles);
  const place = { harness: 'cli', agent };
  fs.writeFileSync(join(roles, 'scoped.json'), JSON.stringify({ role: 'scoped', instructions: 'implementer',
    can_continue: false, run: [place], active_preset: 'test', presets: [{ name: 'test', run: [place] }],
    mcp_servers: ['chrome-devtools'] }));
  let cwd = f.root;
  const ownerFile = agent === 'claude' ? join(f.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(f.env.CODEX_HOME, 'config.toml');
  const owner = agent === 'claude' ? JSON.stringify({ ...JSON.parse(fs.readFileSync(ownerFile)), mcpServers: {
    'chrome-devtools': { command: 'synthetic', args: ['private-value'] }, unrelated: { command: 'other' },
  } }) : '[mcp_servers.chrome-devtools]\ncommand="synthetic"\nargs=["private-value"]\n[mcp_servers.other]\ncommand="other"\n';
  fs.writeFileSync(ownerFile, owner);
  if (agent === 'codex') {
    cwd = join(f.root, 'nested');
    fs.mkdirSync(join(f.root, '.git'));
    for (const [dir, name] of [[f.root, 'root_only'], [cwd, 'nested_only']]) {
      fs.mkdirSync(join(dir, '.codex'), { recursive: true });
      fs.writeFileSync(join(dir, '.codex', 'config.toml'), `[mcp_servers.${name}]\ncommand="synthetic"\n`);
    }
  }
  const task = agent === 'claude' ? 'synthetic'.repeat(2048) : 'Synthetic allowlist.';
  const job = await f.call('hud_create', { role: 'scoped', cwd, task });
  const args = f.commands().find((c) => c.args[1] === 'start').args;
  assert.ok(!JSON.stringify(args).includes('private-value'));
  if (agent === 'claude') {
    const { mcpServers } = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1]));
    assert.deepEqual(Object.keys(mcpServers).sort(), ['chrome-devtools', 'hud']);
    assert.equal(mcpServers.hud.alwaysLoad, true);
    assert.deepEqual(mcpServers['chrome-devtools'], { command: 'synthetic', args: ['private-value'] });
    const prompt = f.commands().find((c) => c.args[1] === 'prompt').args[3];
    assert.ok(prompt.startsWith(`Read ${join(job.task_dir, 'brief.md')} and do exactly what it asks.`));
    assert.ok(!prompt.includes(task));
  } else {
    const scoped = TOML.parse(args.find((arg) => arg.startsWith('mcp_servers='))).mcp_servers;
    assert.equal(scoped['chrome-devtools'], undefined, 'keeps configured transport and enabled state');
    for (const name of ['root_only', 'nested_only', 'other']) assert.equal(scoped[name].enabled, false);
    assert.equal(scoped.hud.env.HUD_JOB_DIR, job.task_dir);
  }
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), owner);
});

test('unparseable Codex layer leaves MCPs untouched and reports the fallback without its contents', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.CODEX_HOME, 'config.toml'), '[private-value');
  const job = await f.call('hud_create', { role: 'general', on: 'codex', task: 'Synthetic fallback.' });
  const args = f.commands().find((c) => c.args[1] === 'start').args;
  assert.ok(!args.some((arg) => arg.startsWith('mcp_servers=')));
  const { diagnostics } = await f.call('hud_peek', { job: job.job, detail: true });
  assert.match(diagnostics.mcp_scope_warning, /^mcp scope not applied: cannot read or parse /);
  assert.ok(!JSON.stringify(diagnostics).includes('private-value'));
});

test('a codex role waits out a phantom startup and passes the start timeout', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'phantom-working'), '');
  const owner = '[mcp_servers."unrelated.server"]\ncommand="synthetic"\n[mcp_servers.hud]\ncommand="old"\n';
  const ownerFile = join(f.env.CODEX_HOME, 'config.toml');
  fs.writeFileSync(ownerFile, owner);
  const job = await f.call('hud_create', {
    role: 'general',
    on: 'codex',
    request_key: 'codex-life',
    task: 'Synthetic codex task.',
  });
  const start = f.commands().find((c) => c.args[1] === 'start').args;
  const dash = start.indexOf('--');
  assert.deepEqual(start.slice(0, dash), [
    'agent',
    'start',
    `${job.job}-primary`,
    '--kind',
    'codex',
    '--pane',
    'w4E:p2',
    '--timeout',
    '90000',
  ]);
  assert.deepEqual(start.slice(dash + 1, dash + 6), [
    '-m',
    'gpt-6.1-sol',
    '-c',
    'model_reasoning_effort=high',
    '--dangerously-bypass-approvals-and-sandbox',
  ]);
  assert.equal(
    start.some((arg) => /^--(home|session|config|profile|worktree)/.test(arg) || arg.includes('CODEX_HOME')),
    false
  );
  const config = TOML.parse(start.find((arg) => arg.startsWith('mcp_servers='))).mcp_servers;
  assert.equal(config['unrelated.server'].enabled, false);
  assert.equal(config.hud.enabled, false);
  assert.equal(config.hud_worker.env.HUD_JOB_DIR, job.task_dir);
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), owner);
  assert.equal(TOML.parse(start.find((arg) => arg.startsWith('developer_instructions='))).developer_instructions, roleText);
  const commands = f.commands();
  assert.match(commands.find((c) => c.args[1] === 'prompt').args[3], /^Carry out this brief:\n\nSynthetic codex task\./);
  const settleAt = commands.findIndex(
    (c) => c.args[1] === 'wait' && c.args.includes('done') && c.args.includes('idle') && !c.args.includes('blocked')
  );
  const promptAt = commands.findIndex((c) => c.args[1] === 'prompt' && c.args[3] !== '/quit');
  assert.ok(settleAt >= 0 && promptAt > settleAt);
  assert.equal(commands[settleAt].args[commands[settleAt].args.indexOf('--timeout') + 1], '60000');
  assert.equal(fs.existsSync(join(f.env.HOME, 'phantom-settled')), true);
  await until(() => cliState(job.task_dir)?.state === 'closed', t.signal);
  const closed = cliState(job.task_dir);
  assert.equal(closed.agent, 'codex');
  assert.equal(closed.model, 'gpt-6.1-sol');
  assert.equal(closed.thinking, 'high');
  assert.equal(closed.state, 'closed');
  assert.equal(closed.exit_reason, 'settled');
  assert.equal(closed.error, null);
  assert.equal(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'), 'Synthetic grok report.\n');
  assert.ok(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'));
  assert.equal(
    f.commands().some((c) => c.args[1] === 'send-keys'),
    false
  );
});

test(
  'a cli job records agent_session_id when herdr publishes it after the first get',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(join(f.env.HOME, 'late-session'), '0');
    const job = await f.call('hud_create', {
      role: 'general',
      on: 'grok',
      request_key: 'late-session',
      task: 'Synthetic late session.',
    });
    await until(() => fs.existsSync(join(f.env.HOME, 'seen-grace.json')), t.signal).catch((error) => {
      t.diagnostic(JSON.stringify({ status: cliState(job.task_dir), requests: f.socketRequests }));
      throw error;
    });
    const grace = JSON.parse(fs.readFileSync(join(f.env.HOME, 'seen-grace.json'), 'utf8'));
    assert.equal(grace.state, 'idle_grace');
    assert.equal(grace.agent_session_id, 'synthetic-grok-session');
    await until(() => cliState(job.task_dir)?.state === 'closed', t.signal);
    assert.equal(cliState(job.task_dir).agent_session_id, 'synthetic-grok-session');
  }
);

test('a failed cli job records agent_session_id published after start, before exit', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'late-session'), '0');
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(join(f.env.HOME, 'exit-after-done'), '');
  const job = await f.call('hud_create', { role: 'general', on: 'grok', request_key: 'late-fail', task: 'Synthetic late fail.' });
  await until(() => cliState(job.task_dir)?.state === 'failed', t.signal);
  assert.equal(cliState(job.task_dir).error, 'worker exited');
  assert.equal(cliState(job.task_dir).agent_session_id, 'synthetic-grok-session');
});
