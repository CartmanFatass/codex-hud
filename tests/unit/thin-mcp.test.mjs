import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

const entry = resolve('packages/hud-mcp/bin/hud-mcp.mjs');
async function fixture(t, inHerdr = true) {
  const root = fs.mkdtempSync(join(tmpdir(), 'thin-mcp-'));
  const bin = join(root, 'bin');
  fs.mkdirSync(bin);
  const log = join(root, 'commands.jsonl');
  const fake = `#!${process.execPath}
import * as fs from 'node:fs';
import { basename, join } from 'node:path';
const command = basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command, args }) + '\\n');
if (command === 'pi-dispatch') {
  const dir = args[args.indexOf('--task-dir') + 1];
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'PRIMARY=synthetic-primary\\n');
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'running', exit_reason: null }));
  fs.writeFileSync(join(dir, 'report.md'), 'Synthetic implementation report.');
} else if (command === 'pi-role-reap') {
  console.log('Reaping synthetic job');
  console.log('Synthetic reap complete');
}
`;
  for (const command of ['pi-dispatch', 'pi-role-reap', 'herdr']) {
    fs.writeFileSync(join(bin, command), fake, { mode: 0o700 });
  }
  const env = { ...process.env, HUD_MCP_SURFACE: 'roles', PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log };
  for (const name of ['HOME', 'HUD_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR']) {
    env[name] = join(root, name.toLowerCase());
    fs.mkdirSync(env[name]);
  }
  if (inHerdr) env.HERDR_PANE_ID = 'synthetic-pane';
  else delete env.HERDR_PANE_ID;
  const child = spawn(process.execPath, [entry], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let next = 0,
    stderr = '';
  child.stderr.setEncoding('utf8').on('data', (data) => {
    stderr += data;
  });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const response = JSON.parse(line);
    const callback = pending.get(response.id);
    if (callback) {
      pending.delete(response.id);
      callback(response);
    }
  });
  t.after(async () => {
    child.stdin.end();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(stderr, '');
  });
  function rpc(method, params = {}) {
    const id = ++next;
    return new Promise((done) => {
      pending.set(id, done);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async function call(name, args = {}) {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined, JSON.stringify(response.result));
    assert.equal(response.result.content.length, 1);
    assert.equal(response.result.content[0].type, 'text');
    return JSON.parse(response.result.content[0].text);
  }
  return {
    root,
    env,
    rpc,
    call,
    commands: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
  };
}

test('thin roles MCP main path over stdio', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const initialized = await f.rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(initialized.result.capabilities.tools !== undefined, true);
  const listed = await f.rpc('tools/list');
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ['hud_roster', 'hud_create', 'hud_read', 'hud_send', 'hud_respond', 'hud_close']
  );
  const args = { role: 'imp', request_key: 'synthetic-request', task: 'Implement the synthetic change.' };
  const job = await f.call('hud_create', args);
  assert.match(job.job, /^j[0-9a-f]{16}$/);
  assert.equal(job.task_dir, join(f.env.HUD_HOME, 'jobs', job.job));
  assert.equal(job.agent, 'synthetic-primary');
  // Breaks if hud_create stops naming the report path: workers then answer in the pane and the job fails.
  assert.equal(
    fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8'),
    `${args.task}\n\nWrite your final answer to ${join(job.task_dir, 'report.md')}; the job fails without that file.\n`
  );
  assert.deepEqual(f.commands(), [
    {
      command: 'pi-dispatch',
      args: [
        'implementer',
        '--task-dir',
        job.task_dir,
        '--workdir',
        f.root,
        '--output',
        join(job.task_dir, 'report.md'),
        '--split',
      ],
    },
  ]);
  assert.deepEqual(await f.call('hud_create', args), job);
  assert.equal(f.commands().length, 1);
  const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8'));
  assert.equal(receipt.dispatch_exit_code, 0);
  assert.equal(receipt.stderr_tail, '');
  assert.equal(receipt.cwd, f.root);
  assert.equal(receipt.request_key, args.request_key);
  const waiting = f.call('hud_read', { job: job.job, wait_ms: 2000 });
  const settle = setTimeout(
    () =>
      fs.writeFileSync(
        join(job.task_dir, 'STATUS.json'),
        JSON.stringify({ state: 'idle_grace', exit_reason: 'settled' })
      ),
    100
  );
  t.after(() => clearTimeout(settle));
  const read = await waiting;
  assert.equal(read.state, 'idle_grace');
  assert.equal(read.exit_reason, 'settled');
  assert.equal(read.report_exists, true);
  assert.equal(read.report, 'Synthetic implementation report.');
  assert.equal(read.report_truncated, false);
  const answer = { job: job.job, request_id: 'q1', answer: 'Synthetic answer.' };
  assert.deepEqual(await f.call('hud_respond', answer), { ok: true, written: true });
  assert.deepEqual(await f.call('hud_respond', { ...answer, answer: 'Do not overwrite.' }), {
    ok: true,
    written: false,
  });
  assert.equal(fs.readFileSync(join(job.task_dir, 'qa', 'q1.answer.md'), 'utf8'), answer.answer);
  assert.deepEqual(await f.call('hud_close', { job: job.job }), { exit_code: 0, last_line: 'Synthetic reap complete' });
  assert.deepEqual(f.commands().at(-1), { command: 'pi-role-reap', args: [job.task_dir] });
});

test(
  'thin send records failed and successful outcomes without retrying a message key',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const job = await f.call('hud_create', { role: 'imp', request_key: 'send-outcomes', task: 'Synthetic task.' });
    fs.writeFileSync(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
    const herdr = join(f.root, 'bin', 'herdr');
    const fake = `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command: 'herdr', args: process.argv.slice(2) }) + '\\n');
`;
    fs.writeFileSync(herdr, fake + "console.error('Synthetic prompt failure'); process.exit(9);\n");
    const args = { job: job.job, message_key: 'failed-send', text: 'Synthetic continuation.' };
    const failed = await f.call('hud_send', args);
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'send_failed');
    assert.equal(failed.exit_code, 9);
    assert.match(failed.stderr_tail, /Synthetic prompt failure/);
    // The transport is now healthy, but retrying the failed key must not claim delivery or resend.
    fs.writeFileSync(herdr, fake);
    const retry = await f.call('hud_send', args);
    assert.equal(retry.ok, false);
    assert.equal(retry.sent, false);
    assert.equal(retry.code, 'send_failed');
    assert.equal(retry.exit_code, failed.exit_code);
    assert.equal(retry.stderr_tail, failed.stderr_tail);
    assert.equal(f.commands().filter((command) => command.command === 'herdr').length, 1);
    const success = await f.call('hud_send', { ...args, message_key: 'successful-send' });
    assert.equal(success.ok, true);
    assert.equal(success.sent, true);
    assert.deepEqual(await f.call('hud_send', { ...args, message_key: 'successful-send' }), { ok: true, sent: false });
    assert.equal(f.commands().filter((command) => command.command === 'herdr').length, 2);
    const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8'));
    assert.deepEqual(
      receipt.send_outcomes.map(({ key, exit_code }) => ({ key, exit_code })),
      [
        { key: 'failed-send', exit_code: 9 },
        { key: 'successful-send', exit_code: 0 },
      ]
    );
  }
);

test('thin roles load a custom role file and dispatch its mapped pi role', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const role = { role: 'synthetic-writer', harness: 'pi', pi_role: 'implementer', split: false, can_continue: true };
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'));
  fs.writeFileSync(join(f.env.HUD_HOME, 'roles', 'writer.json'), JSON.stringify(role));
  const roster = await f.call('hud_roster');
  assert.deepEqual(
    roster.roles.find((entry) => entry.role === role.role),
    { ...role, available: true }
  );
  assert.deepEqual(
    roster.roles.find((entry) => entry.role === 'architect'),
    {
      role: 'architect',
      harness: 'pi',
      pi_role: 'architect',
      split: false,
      can_continue: false,
      available: true,
    }
  );
  assert.deepEqual(await f.call('hud_create', { role: 'unknown', request_key: 'unknown', task: 'Synthetic task.' }), {
    ok: false,
    code: 'role_unavailable',
  });
  const job = await f.call('hud_create', { role: role.role, request_key: 'custom-role', task: 'Synthetic task.' });
  assert.deepEqual(f.commands(), [
    {
      command: 'pi-dispatch',
      args: [
        'implementer',
        '--task-dir',
        job.task_dir,
        '--workdir',
        f.root,
        '--output',
        join(job.task_dir, 'report.md'),
      ],
    },
  ]);
  fs.writeFileSync(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  assert.equal(
    (await f.call('hud_send', { job: job.job, message_key: 'custom-send', text: 'Synthetic follow-up.' })).sent,
    true
  );
});

test('thin create requires herdr without dispatching', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, false);
  assert.deepEqual(
    await f.call('hud_create', {
      role: 'imp',
      request_key: 'no-herdr',
      task: 'Synthetic task.',
    }),
    { ok: false, code: 'herdr_required' }
  );
  assert.deepEqual(f.commands(), []);
});
