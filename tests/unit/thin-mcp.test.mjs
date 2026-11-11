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
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
const command = basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command, args }) + '\\n');
if (command === 'pi-dispatch') {
  const dir = args[args.indexOf('--task-dir') + 1];
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'PRIMARY=synthetic-primary\\n');
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'running', exit_reason: null }));
  fs.writeFileSync(join(dir, 'report.md'), 'Synthetic implementation report.');
} else if (command === 'herdr' && args[0] === 'tab' && args[1] === 'create') {
  console.log(JSON.stringify({result: {tab: {tab_id: 'synthetic-tab'}, root_pane: {pane_id: 'synthetic-worker'}}}));
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'run') {
  process.exit(spawnSync('/bin/sh', ['-c', args[3]], {stdio: 'inherit'}).status);
} else if (command === 'jev-ask' && args[0] === 'key') {
  console.log(JSON.stringify({key: 'synthetic-key'}));
} else if (command === 'jev-ask' && args[0] === 'wait') {
  fs.writeFileSync(args[args.indexOf('--answer-file') + 1], 'Synthetic Jev answer.');
} else if (command === 'jev-aistudio') {
  fs.writeFileSync(args[args.indexOf('--out') + 1], 'Synthetic Argon answer.');
} else if (command === 'jev-flow') {
  if (args[args.indexOf('--kind') + 1] === 'video' && !args.includes('--confirm-credits')) process.exit(17);
  fs.writeFileSync(join(args[args.indexOf('--out-dir') + 1], 'synthetic-media.mp4'), 'synthetic media');
} else if (command === 'pi-role-reap') {
  console.log('Reaping synthetic job');
  console.log('Synthetic reap complete');
}
`;
  for (const command of ['pi-role', 'pi-dispatch', 'pi-role-reap', 'herdr', 'jev-ask', 'jev-aistudio', 'jev-flow']) {
    fs.writeFileSync(join(bin, command), fake, { mode: 0o700 });
  }
  fs.mkdirSync(join(root, 'roles'));
  fs.writeFileSync(join(root, 'roles', 'implementer.md'), '---\nmodel: synthetic/default\nthinking: low\n---\n');
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

// Breaks if roster omits the shipped convention/path, merges overrides, or reverses project/home/default precedence.
test('thin roster returns the convention and its path with whole-file overrides', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const initialized = await f.rpc('initialize');
  assert.equal(initialized.result.instructions, 'Call hud_roster before dispatching.');
  const shipped = resolve('packages/hud-mcp/hud-convention.md');
  assert.deepEqual((await f.call('hud_roster')).convention, {
    path: shipped,
    text: fs.readFileSync(shipped, 'utf8'),
    truncated: false,
  });
  const owner = join(f.env.HUD_HOME, 'hud-convention.md');
  fs.writeFileSync(owner, 'Synthetic owner convention.');
  assert.deepEqual((await f.call('hud_roster')).convention, {
    path: owner,
    text: 'Synthetic owner convention.',
    truncated: false,
  });
  const project = join(f.root, 'hud-convention.md');
  fs.writeFileSync(project, 'Synthetic project convention.');
  assert.deepEqual((await f.call('hud_roster')).convention, {
    path: project,
    text: 'Synthetic project convention.',
    truncated: false,
  });
  fs.writeFileSync(project, 'x'.repeat(20001));
  assert.deepEqual((await f.call('hud_roster')).convention, {
    path: project,
    text: 'x'.repeat(20000),
    truncated: true,
  });
  assert.equal(fs.readFileSync(owner, 'utf8'), 'Synthetic owner convention.');
  assert.equal(fs.readFileSync(project, 'utf8'), 'x'.repeat(20001));
});

test('thin roles MCP main path over stdio', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const initialized = await f.rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(initialized.result.capabilities.tools !== undefined, true);
  const listed = await f.rpc('tools/list');
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ['hud_roster', 'hud_create', 'hud_read', 'hud_send', 'hud_respond', 'hud_close']
  );
  const args = {
    role: 'imp',
    request_key: 'synthetic-request',
    task: 'Implement the synthetic change.',
    package: 'Synthetic lane',
  };
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
  assert.equal(receipt.package, args.package);
  await f.call('hud_read', { job: job.job });
  assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).read_at, undefined);
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
  const stamp = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).read_at;
  assert.equal(new Date(stamp).toISOString(), stamp);
  await f.call('hud_read', { job: job.job });
  assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).read_at, stamp);
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
  const role = {
    role: 'synthetic-writer',
    harness: 'pi',
    pi_role: 'implementer',
    split: false,
    can_continue: true,
    model: 'synthetic/override',
    thinking: 'high',
  };
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'));
  fs.writeFileSync(join(f.env.HUD_HOME, 'roles', 'writer.json'), JSON.stringify(role));
  const roster = await f.call('hud_roster');
  assert.deepEqual(
    roster.roles.find((entry) => entry.role === role.role),
    {
      ...role,
      available: true,
      source_file: join(f.env.HUD_HOME, 'roles', 'writer.json'),
      model_source: join(f.env.HUD_HOME, 'roles', 'writer.json'),
      thinking_source: join(f.env.HUD_HOME, 'roles', 'writer.json'),
      pi_role_file: join(f.root, 'roles', 'implementer.md'),
    }
  );
  const imp = roster.roles.find((entry) => entry.role === 'imp');
  assert.equal(imp.model, 'synthetic/default');
  assert.equal(imp.thinking, 'low');
  assert.equal(imp.model_source, join(f.root, 'roles', 'implementer.md'));
  assert.equal(imp.thinking_source, imp.model_source);
  assert.deepEqual(
    roster.roles.find((entry) => entry.role === 'architect'),
    {
      role: 'architect',
      source_file: resolve('packages/hud-mcp/roles/architect.json'),
      model: null,
      thinking: null,
      model_source: null,
      thinking_source: null,
      pi_role_file: null,
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
        '--model',
        'synthetic/override',
        '--thinking',
        'high',
      ],
    },
  ]);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))), 'package'), false);
  fs.writeFileSync(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  assert.equal(
    (await f.call('hud_send', { job: job.job, message_key: 'custom-send', text: 'Synthetic follow-up.' })).sent,
    true
  );
});

test('thin Jev roles run the real wrapper in an unfocused tab and deduplicate sends', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const args = { role: 'oracle', request_key: 'oracle-once', task: 'Synthetic question.' };
  const job = await f.call('hud_create', args);
  assert.equal(fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8'), `${args.task}\n`);
  assert.deepEqual(await f.call('hud_create', args), job);
  const asks = f.commands().filter(({ command }) => command === 'jev-ask');
  assert.deepEqual(
    asks.map(({ args }) => args[0]),
    ['key', 'send', 'wait']
  );
  assert.equal(asks[1].args[asks[1].args.indexOf('--effort') + 1], '6 Pro');
  assert.equal(asks[2].args[asks[2].args.indexOf('--answer-file') + 1], join(job.task_dir, 'report.md'));
  assert.equal(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'), 'Synthetic Jev answer.');
  assert.ok(f.commands().find(({ args }) => args[0] === 'tab' && args.includes('--no-focus')));
  assert.ok(
    f
      .commands()
      .find(
        ({ command, args }) =>
          command === 'herdr' &&
          args[0] === 'agent' &&
          args[2] === 'synthetic-pane' &&
          args[3] === `[oracle@${job.job}] DONE ${job.task_dir}/report.md`
      )
  );
  const state = JSON.parse(fs.readFileSync(join(job.task_dir, 'STATUS.json')));
  assert.equal(state.state, 'closed');
  assert.equal(state.output_written, true);
  assert.equal(state.exit_reason, 'settled');
  assert.equal((await f.call('hud_read', { job: job.job })).report, 'Synthetic Jev answer.');
  assert.equal(
    (await f.call('hud_send', { job: job.job, message_key: 'no-send', text: 'Synthetic follow-up.' })).code,
    'not_continuable'
  );
  assert.equal((await f.call('hud_roster')).roles.find(({ role }) => role === 'oracle').can_continue, false);
  assert.equal((await f.call('hud_close', { job: job.job })).exit_code, 0);
  assert.deepEqual(f.commands().at(-1), { command: 'pi-role-reap', args: [job.task_dir] });
  for (const role of ['gemini', 'argon', 'flow']) {
    const other = await f.call('hud_create', { role, request_key: role, task: 'Synthetic request.' });
    assert.equal((await f.call('hud_read', { job: other.job })).state, 'closed');
  }
});

test('thin Flow video confirms only a stated credit cost', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  for (const [key, task, confirmed] of [
    ['no-cost', 'Synthetic video.', false],
    ['cost', 'Synthetic video; cost: 20 credits', true],
  ]) {
    const job = await f.call('hud_create', { role: 'flow-video', request_key: key, task });
    const args = f
      .commands()
      .filter(({ command }) => command === 'jev-flow')
      .at(-1).args;
    assert.equal(args.includes('--confirm-credits'), confirmed);
    const read = await f.call('hud_read', { job: job.job });
    assert.equal(read.state, confirmed ? 'closed' : 'failed');
    if (confirmed) {
      assert.equal(args[args.indexOf('--confirm-credits') + 1], '20');
      assert.match(read.report, /synthetic-media.mp4/);
      assert.equal(fs.existsSync(join(job.task_dir, 'media', 'synthetic-media.mp4')), true);
    } else assert.equal(read.report_exists, false);
  }
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
