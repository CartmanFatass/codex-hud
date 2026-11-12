import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { createServer } from 'node:net';
import { readThinJobs, runningVerb } from '../../dist/collectors/thin-jobs.js';
import { projectWorkCard } from '../../dist/collectors/work-card.js';
import { renderWorkCard, workStateInk } from '../../dist/render/work-card.js';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { stripAnsi, theme } from '../../dist/render/colors.js';
import { PI_ROLE_TOOLS } from '../../dist/harness/pi/role-client.js';
const workerFor = (f, id) =>
  readThinJobs(f.env.HUD_HOME, { project: null, pane: 'w4E:p1' })
    .flatMap((lane) => lane.workers)
    .find((worker) => worker.id === 'thin-job:' + id);
const cardText = (worker) =>
  renderWorkCard(projectWorkCard(worker, Date.now()), { ...initialMonitorState(), mainTab: 'home' }, 56)
    .map(stripAnsi)
    .join('\n');

const entry = resolve('packages/hud-mcp/bin/hud-mcp.mjs');
async function fixture(t, inHerdr = true, probe = '') {
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
  process.exit(99); // The MCP must never use this legacy launcher.
} else if (command === 'pi-role') {
  console.log(JSON.stringify(args.slice(2)));
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'start') {
  if (fs.existsSync(join(process.env.HOME, 'fail-start'))) { console.error('synthetic start failed'); process.exit(1); }
  const dir = args[args.indexOf('--task-dir') + 1];
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working', exit_reason: null }));
  fs.writeFileSync(join(dir, 'report.md'), 'Synthetic implementation report.');
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt' && fs.existsSync(join(process.env.HOME, 'fail-prompt'))) {
  console.error('synthetic prompt timeout'); process.exit(1);
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'split') {
  if (fs.existsSync(join(process.env.HOME, 'fail-split'))) { console.error('synthetic split failed'); process.exit(1); }
  console.log(JSON.stringify({result: {pane: {pane_id: 'w4E:p3'}}}));
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'get') {
  console.log(JSON.stringify({result: {pane: {workspace_id: 'w4E'}}}));
} else if (command === 'herdr' && args[0] === 'tab' && args[1] === 'create') {
  console.log(JSON.stringify({result: {tab: {tab_id: 'w4E:t2'}, root_pane: {pane_id: 'w4E:p2'}}}));
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
  const env = {
    ...process.env,
    HUD_MCP_SURFACE: 'roles',
    HUD_WATCH_FAILED_RETENTION_MS: '1000',
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_LOG: log,
    HERDR_SOCKET_PATH: join(root, 'events.sock'),
  };
  for (const name of ['HOME', 'HUD_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR']) {
    env[name] = join(root, name.toLowerCase());
    fs.mkdirSync(env[name]);
  }
  if (inHerdr) env.HERDR_PANE_ID = 'w4E:p1';
  else delete env.HERDR_PANE_ID;
  const preload = probe ? ['--import', 'data:text/javascript,' + encodeURIComponent(probe)] : [];
  const child = spawn(process.execPath, [...preload, entry], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    const watchLog = join(env.HUD_HOME, 'watch.log');
    if (fs.existsSync(watchLog))
      for (const match of fs.readFileSync(watchLog, 'utf8').matchAll(/start pid=(\d+)/g)) {
        try {
          process.kill(Number(match[1]), 'SIGTERM');
        } catch {}
      }
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

async function until(check, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, 'condition did not settle');
    await new Promise((done) => setTimeout(done, 20));
  }
}

test('pi role tools match the real MCP tools/list', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(PI_ROLE_TOOLS, (await f.rpc('tools/list')).result.tools);
});

test('working worker STATUS survives a nonzero prompt result', { timeout: 7000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'fail-prompt'), '');
  const job = await f.call('hud_create', { role: 'imp', request_key: 'prompt-timeout', task: 'Synthetic task.' });
  const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
  assert.equal(receipt.dispatch_exit_code, 1);
  assert.match(receipt.stderr_tail, /synthetic prompt timeout/);
  assert.equal(
    fs.readFileSync(join(job.task_dir, 'STATUS.json'), 'utf8'),
    JSON.stringify({ state: 'working', exit_reason: null })
  );
  assert.equal((await f.call('hud_read', { job: job.job })).state, 'working');
});

test('dispatch failure writes a reason for the panel and is reaped', { timeout: 7000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'fail-start'), '');
  const job = await f.call('hud_create', { role: 'imp', request_key: 'failed-launch', task: 'Synthetic task.' });
  const status = JSON.parse(fs.readFileSync(join(job.task_dir, 'STATUS.json')));
  assert.equal(status.state, 'failed');
  assert.match(status.exit_reason, /synthetic start failed/);
  assert.ok(Number.isFinite(Date.parse(status.ended_at)));
  assert.match(cardText(workerFor(f, job.job)), /synthetic start failed/);
  await until(() => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at);
  assert.ok(f.commands().some((c) => c.command === 'pi-role-reap' && c.args[0] === job.task_dir));
  await until(() => !fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')));
});

test('stopped jobs read immediately, render neutral and are terminal to the watcher', { timeout: 7000 }, async (t) => {
  const f = await fixture(t);
  const job = await f.call('hud_create', { role: 'imp', request_key: 'stopped', task: 'Synthetic stop.' });
  fs.writeFileSync(
    join(job.task_dir, 'STATUS.json'),
    JSON.stringify({ state: 'stopped', ended_at: new Date().toISOString() })
  );
  assert.equal((await f.call('hud_read', { job: job.job, wait_ms: 120000 })).state, 'stopped');
  const worker = workerFor(f, job.job);
  assert.equal(worker.state, 'stopped');
  assert.equal(worker.work.failed, false);
  assert.equal(projectWorkCard(worker, Date.now()).state, 'done');
  assert.equal(workStateInk(projectWorkCard(worker, Date.now())), theme.board.muted);
  assert.match(cardText(worker), /stopped/);
  await until(() => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at);
  await until(() => !fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')));
});

test('failed STATUS uses its mtime when ended_at is absent or invalid', { timeout: 7000 }, async (t) => {
  const f = await fixture(t);
  for (const ended_at of [undefined, 'not-a-date']) {
    const job = await f.call('hud_create', { role: 'imp', request_key: String(ended_at), task: 'Synthetic task.' });
    const file = join(job.task_dir, 'STATUS.json');
    fs.writeFileSync(file, JSON.stringify({ state: 'failed', ended_at }));
    const mtime = fs.statSync(file).mtimeMs;
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at, undefined);
    assert.ok(fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')));
    await until(() => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at);
    assert.ok(Date.parse(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at) >= mtime + 999);
  }
});

test('watcher subscribes to herdr and fails only a nonfinal job whose tab closes', { timeout: 7000 }, async (t) => {
  const f = await fixture(t);
  let socket, request;
  const server = createServer((client) => {
    socket = client;
    createInterface({ input: client }).on('line', (line) => {
      request = JSON.parse(line);
      client.write(JSON.stringify({ id: request.id, result: {} }) + '\n');
    });
  });
  t.after(() => {
    socket?.destroy();
    server.close();
  });
  server.listen(f.env.HERDR_SOCKET_PATH);
  await once(server, 'listening');
  const job = await f.call('hud_create', { role: 'imp', request_key: 'tab-close', task: 'Synthetic task.' });
  await until(() => request);
  assert.equal(request.method, 'events.subscribe');
  assert.deepEqual(request.params, { subscriptions: [{ type: 'tab.closed' }] });
  const statusFile = join(job.task_dir, 'STATUS.json');
  const emit = (tab_id) =>
    socket.write(
      JSON.stringify({
        event: 'tab_closed',
        data: {
          type: 'tab_closed',
          tab_id,
          workspace_id: 'w4E',
        },
      }) + '\n'
    );
  emit('foreign-tab');
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(JSON.parse(fs.readFileSync(statusFile)).state, 'working');
  const finalDir = join(f.env.HUD_HOME, 'jobs', 'j0000000000000000');
  fs.mkdirSync(finalDir);
  fs.writeFileSync(join(finalDir, 'SESSION.txt'), 'TAB=w4E:t2\n');
  fs.writeFileSync(
    join(finalDir, 'STATUS.json'),
    JSON.stringify({ state: 'failed', exit_reason: 'original', ended_at: new Date().toISOString() })
  );
  emit('w4E:t2');
  await until(() => JSON.parse(fs.readFileSync(statusFile)).state === 'failed');
  assert.equal(JSON.parse(fs.readFileSync(statusFile)).exit_reason, 'tab closed');
  assert.equal(JSON.parse(fs.readFileSync(join(finalDir, 'STATUS.json'))).exit_reason, 'original');
  await until(() => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at);
  await until(() => !fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')));
  assert.ok(f.commands().some((c) => c.command === 'pi-role-reap' && c.args[0] === job.task_dir));
  assert.ok(!f.commands().some((c) => c.command === 'herdr' && c.args[1] === 'get' && c.args[2] !== 'w4E:p1'));
});

test('thin watcher catches up without a new file event and exits', { timeout: 5000 }, async (t) => {
  const f = await fixture(t),
    dir = join(f.env.HUD_HOME, 'jobs', 'j0000000000000000');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job: 'j0000000000000000' }));
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'TAB=synthetic-catchup\n');
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
  const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], {
    env: f.env,
    stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  await until(() => f.commands().some((c) => c.command === 'pi-role-reap' && c.args[0] === dir));
  await exited;
  assert.equal(child.exitCode, 0);
});

test(
  'thin watcher starts once, catches up, respects grace and failed deadline, then exits',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const jobs = join(f.env.HUD_HOME, 'jobs');
    const caught = join(jobs, 'j0000000000000000');
    fs.mkdirSync(caught, { recursive: true });
    fs.writeFileSync(join(caught, 'job.json'), JSON.stringify({ job: 'j0000000000000000' }));
    fs.writeFileSync(join(caught, 'SESSION.txt'), 'TAB=synthetic-catchup\n');
    fs.writeFileSync(join(caught, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
    const first = await f.call('hud_create', { role: 'imp', request_key: 'watch-one', task: 'Synthetic task.' });
    const reaped = (dir) => f.commands().filter((c) => c.command === 'pi-role-reap' && c.args[0] === dir).length;
    await until(() => reaped(caught) === 1);
    const pidFile = join(f.env.HUD_HOME, 'watch.pid');
    const pid = fs.readFileSync(pidFile, 'utf8');
    process.kill(Number(pid), 0);
    assert.ok(fs.readFileSync(`/proc/${pid.trim()}/cmdline`, 'utf8').includes('hud-watch.mjs'));
    const second = await f.call('hud_create', { role: 'imp', request_key: 'watch-two', task: 'Synthetic task.' });
    assert.equal(fs.readFileSync(pidFile, 'utf8'), pid);
    const watchLog = () => fs.readFileSync(join(f.env.HUD_HOME, 'watch.log'), 'utf8');
    assert.equal(
      watchLog()
        .split('\n')
        .filter((l) => l.includes('start pid=')).length,
      1
    );
    fs.writeFileSync(join(first.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
    fs.writeFileSync(join(second.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(reaped(first.task_dir), 0);
    assert.equal(fs.existsSync(pidFile), true, 'grace jobs must keep the watcher alive');
    assert.equal(watchLog().match(/herdr events unavailable/g)?.length, 1);
    fs.writeFileSync(join(second.task_dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
    fs.writeFileSync(join(first.task_dir, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
    await until(() => reaped(first.task_dir) === 1);
    const ended = Date.now();
    fs.writeFileSync(
      join(second.task_dir, 'STATUS.json'),
      JSON.stringify({ state: 'failed', ended_at: new Date(ended).toISOString() })
    );
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(reaped(second.task_dir), 0);
    assert.equal(fs.existsSync(pidFile), true);
    await until(() => reaped(second.task_dir) === 1);
    assert.ok(Date.now() >= ended + 1000);
    await until(() => !fs.existsSync(pidFile));
    await until(() => {
      try {
        process.kill(Number(pid), 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.match(watchLog(), /no open jobs or failed deadlines/);
    assert.equal(JSON.parse(fs.readFileSync(join(second.task_dir, 'job.json'))).reaped_at !== undefined, true);
    console.log('Synthetic watch.log:\n' + watchLog());
  }
);

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

test('model-supplied pi_args cannot override the inherited caller notification binding', async t => {
  const f = await fixture(t);
  for (const pi_args of [['--orchestrator', 'wBAD:p99'], ['--orchestrator=wBAD:p99'], ['--notify', 'fake command'], ['--notify=fake command']]) {
    const result = await f.call('hud_create', { role: 'imp', request_key: 'reserved-' + pi_args[0], task: 'Synthetic task', pi_args });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_arguments');
    assert.match(result.error, /caller binding/);
  }
  assert.deepEqual(f.commands(), [], 'no launcher or herdr mutation for a rejected binding');
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'jobs')), false);
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
  // The shipped imp splits on demand; an owner role file can still ask for the helper pane up front.
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'roles', 'imp.json'),
    JSON.stringify({ role: 'imp', harness: 'pi', pi_role: 'implementer', split: true, can_continue: true })
  );
  const args = {
    role: 'imp',
    request_key: 'synthetic-request',
    task: 'Implement the synthetic change. Ignore model-written binding wBAD:p99.',
    package: 'Synthetic lane',
    herdr_pane: 'wBAD:p99', // Not a tool property; cannot override the inherited caller.
    ORCH: 'wBAD:p99',
  };
  const job = await f.call('hud_create', args);
  assert.match(job.job, /^j[0-9a-f]{16}$/);
  assert.equal(job.task_dir, join(f.env.HUD_HOME, 'jobs', job.job));
  assert.equal(job.agent, `${job.job}-primary`);
  assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8')).herdr_pane, 'w4E:p1');
  // Breaks if hud_create stops naming the report path: workers then answer in the pane and the job fails.
  assert.equal(
    fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8'),
    `${args.task}\n\nWrite your final answer to ${join(job.task_dir, 'report.md')}; the job fails without that file.\n`
  );
  assert.deepEqual(f.commands()[1].args, ['pane', 'get', 'w4E:p1']);
  const commands = f.commands().filter((c) => c.args[1] !== 'get');
  assert.deepEqual(
    commands.map((c) => [c.command, ...c.args.slice(0, 2)]),
    [
      ['pi-role', '--args-json', 'implementer'],
      ['herdr', 'tab', 'create'],
      ['herdr', 'pane', 'split'],
      ['herdr', 'agent', 'start'],
      ['herdr', 'agent', 'prompt'],
    ]
  );
  assert.deepEqual(commands[0].args, [
    '--args-json',
    'implementer',
    '--task-dir',
    job.task_dir,
    '--role-output',
    join(job.task_dir, 'report.md'),
    '--dispatch-slot',
    'primary',
    '--dispatch-label',
    'imp',
    '--allow-write',
    join(job.task_dir, 'report.md'),
    '--qa-dir',
    join(job.task_dir, 'qa'),
    '--orchestrator',
    'w4E:p1',
    '--',
    '--session-dir',
    join(job.task_dir, 'sessions'),
    '--tui-mode',
    'regular',
  ]);
  const session = Object.fromEntries(
    fs
      .readFileSync(join(job.task_dir, 'SESSION.txt'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split('='))
  );
  assert.deepEqual(session, {
    TASK: job.job,
    TAB: 'w4E:t2',
    TAB_NAME: session.TAB_NAME,
    LEFT: 'w4E:p2',
    RIGHT: 'w4E:p3',
    ORCH: 'w4E:p1',
    BASE: 'HEAD',
    PRIMARY: job.agent,
  });
  assert.ok(commands[1].args.includes('--no-focus'));
  assert.equal(commands[1].args[commands[1].args.indexOf('--label') + 1], 'imp Synthetic lane');
  assert.equal(commands[1].args[commands[1].args.indexOf('--workspace') + 1], 'w4E');
  assert.deepEqual(commands[2].args.slice(2), [
    'w4E:p2',
    '--direction',
    'right',
    '--ratio',
    '0.5',
    '--cwd',
    f.root,
    '--no-focus',
  ]);
  assert.deepEqual(commands[3].args, [
    'agent',
    'start',
    job.agent,
    '--kind',
    'pi',
    '--pane',
    'w4E:p2',
    '--',
    ...commands[0].args.slice(2),
  ]);
  assert.deepEqual(commands[4].args, [
    'agent',
    'prompt',
    job.agent,
    `Read ${job.task_dir}/brief.md and do exactly what it asks.`,
    '--wait',
    '--until',
    'working',
    '--timeout',
    '30000',
  ]);
  assert.deepEqual(await f.call('hud_create', args), job);
  assert.equal(f.commands().length, commands.length + 1);
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

test('thin read lists and waits without opening discarded bodies, preserving observations', async (t) => {
  const f = await fixture(t, true, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync;
fs.openSync = function(path, ...args) {
  if (/\\/(report\\.md|qa\\/q\\d+\\.md)$/.test(String(path)))
    fs.appendFileSync(process.env.HOME + '/reads', String(path) + '\\n');
  return open.call(this, path, ...args);
};
syncBuiltinESMExports();`);
  const job = 'j0000000000000001', dir = join(f.env.HUD_HOME, 'jobs', job);
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  const receipt = { job, role: 'imp', created_at: '2026-01-01', dispatch_exit_code: 0, stderr_tail: '' };
  const save = () => fs.writeFileSync(join(dir, 'job.json'), JSON.stringify(receipt));
  const status = (state) => fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state, exit_reason: null }));
  const reads = () => fs.existsSync(join(f.env.HOME, 'reads')) ? fs.readFileSync(join(f.env.HOME, 'reads'), 'utf8').trim().split('\n') : [];
  const read = (wait_ms = 0) => f.call('hud_read', { job, wait_ms });
  save(); status('working');
  fs.writeFileSync(join(dir, 'report.md'), 'r'.repeat(65537));
  fs.writeFileSync(join(dir, 'qa', 'q1.md'), 'Synthetic question.');
  assert.equal((await f.call('hud_read')).jobs[0].state, 'working');
  assert.deepEqual(reads(), []);
  const question = await read();
  assert.deepEqual(question.questions, [{ id: 'q1', text: 'Synthetic question.' }]);
  await f.call('hud_respond', { job, request_id: 'q1', answer: 'Synthetic answer.' });
  const before = reads().length, waiting = read(1100);
  await new Promise((done) => setTimeout(done, 600));
  assert.equal(reads().length, before);
  const timeout = await waiting;
  assert.deepEqual(timeout, { ...question, questions: [] });
  assert.equal(reads().length, before + 1);
  assert.equal(timeout.report.length, 65536);
  assert.equal(timeout.report_truncated, true);
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'job.json'))).read_at, undefined);
  const newQuestion = read(3000);
  setTimeout(() => fs.writeFileSync(join(dir, 'qa', 'q2.md'), 'New question.'), 100);
  assert.deepEqual(await newQuestion, { ...timeout, questions: [{ id: 'q2', text: 'New question.' }] });
  await f.call('hud_respond', { job, request_id: 'q2', answer: 'Answered.' });
  for (const state of ['idle_grace', 'closed', 'failed', 'stopped', null]) {
    save(); status('working');
    const pending = read(700);
    const timer = setTimeout(() => state === null ? fs.unlinkSync(join(dir, 'STATUS.json')) : status(state), 100);
    t.after(() => clearTimeout(timer));
    assert.deepEqual(await pending, { ...timeout, state });
    assert.equal(Boolean(JSON.parse(fs.readFileSync(join(dir, 'job.json'))).read_at), state !== null);
  }
  receipt.dispatch_exit_code = 1; save();
  assert.deepEqual(await read(), { ...timeout, state: 'failed', dispatch_exit_code: 1 });
});

test('thin send queues a message for a working pi job and refuses a finished one', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const job = await f.call('hud_create', { role: 'reviewer', request_key: 'send-queue', task: 'Synthetic task.' });
  fs.writeFileSync(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  const sent = await f.call('hud_send', { job: job.job, message_key: 'queued', text: 'Synthetic addendum.' });
  assert.equal(sent.sent, true);
  assert.equal(sent.queued, true);
  assert.deepEqual(f.commands().at(-1).args.slice(0, 2), ['agent', 'prompt']);
  assert.equal(f.commands().at(-1).args.at(-1), 'Synthetic addendum.');
  fs.writeFileSync(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
  const late = await f.call('hud_send', { job: job.job, message_key: 'late', text: 'Synthetic late.' });
  assert.equal(late.code, 'not_continuable');
});

test(
  'thin send records failed and successful outcomes without retrying a message key',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const job = await f.call('hud_create', { role: 'imp', request_key: 'send-outcomes', task: 'Synthetic task.' });
    const before = f.commands().filter((c) => c.command === 'herdr').length;
    fs.writeFileSync(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
    await f.call('hud_read', { job: job.job });
    const receiptFile = join(job.task_dir, 'job.json');
    const stamp = JSON.parse(fs.readFileSync(receiptFile)).read_at;
    assert.ok(stamp);
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
    assert.equal(JSON.parse(fs.readFileSync(receiptFile)).read_at, stamp);
    // The transport is now healthy, but retrying the failed key must not claim delivery or resend.
    fs.writeFileSync(herdr, fake);
    const retry = await f.call('hud_send', args);
    assert.equal(retry.ok, false);
    assert.equal(retry.sent, false);
    assert.equal(retry.code, 'send_failed');
    assert.equal(retry.exit_code, failed.exit_code);
    assert.equal(retry.stderr_tail, failed.stderr_tail);
    assert.equal(f.commands().filter((command) => command.command === 'herdr').length, before + 1);
    const success = await f.call('hud_send', { ...args, message_key: 'successful-send' });
    assert.equal(success.ok, true);
    assert.equal(success.sent, true);
    assert.equal(JSON.parse(fs.readFileSync(receiptFile)).read_at, undefined);
    fs.writeFileSync(join(job.task_dir, 'report.md'), 'Second report after repairs.');
    const settled = Date.now();
    fs.writeFileSync(
      join(job.task_dir, 'STATUS.json'),
      JSON.stringify({ state: 'idle_grace', settled_at: new Date(settled).toISOString() })
    );
    // Settled is done, read or not: the panel has no "report unread" stage (owner, 2026-11-11).
    const unread = workerFor(f, job.job);
    assert.equal(projectWorkCard(unread, settled).state, 'done');
    assert.doesNotMatch(cardText(unread), /report ready/);
    assert.equal((await f.call('hud_read', { job: job.job })).report, 'Second report after repairs.');
    const secondStamp = JSON.parse(fs.readFileSync(receiptFile)).read_at;
    assert.ok(secondStamp);
    assert.deepEqual(await f.call('hud_send', { ...args, message_key: 'successful-send' }), { ok: true, sent: false });
    assert.equal(JSON.parse(fs.readFileSync(receiptFile)).read_at, secondStamp);
    assert.equal(f.commands().filter((command) => command.command === 'herdr').length, before + 2);
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
      accepts_options: ['model', 'thinking', 'lens', 'mcp', 'tps', 'ui_ext', 'skills', 'split', 'pi_args'],
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
      accepts_options: ['model', 'thinking', 'lens', 'mcp', 'tps', 'ui_ext', 'skills', 'split', 'pi_args'],
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
  const argv = f.commands()[0].args;
  assert.ok(argv.includes('--dispatch-effort-source'));
  assert.equal(argv[argv.indexOf('--dispatch-label') + 1], role.role);
  assert.deepEqual(argv.slice(-4), ['--model', 'synthetic/override', '--thinking', 'high']);
  assert.equal(
    f.commands().some((c) => c.command === 'pi-dispatch' || c.args[1] === 'split'),
    false
  );
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))), 'package'), false);
  fs.writeFileSync(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  assert.equal(
    (await f.call('hud_send', { job: job.job, message_key: 'custom-send', text: 'Synthetic follow-up.' })).sent,
    true
  );
});

test(
  'thin create overrides pi argv and records the job assignment without changing defaults',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const args = {
      role: 'imp',
      request_key: 'model-override',
      task: 'Synthetic task.',
      model: 'synthetic/any-model',
      thinking: 'max',
    };
    const job = await f.call('hud_create', args);
    const argv = f.commands().find((c) => c.command === 'pi-role').args;
    assert.deepEqual(argv.slice(-4), ['--model', args.model, '--thinking', args.thinking]);
    assert.ok(argv.indexOf('--model') > argv.indexOf('--'));
    assert.ok(
      f
        .commands()
        .find((c) => c.args[0] === 'agent' && c.args[1] === 'start')
        .args.includes(args.model)
    );
    const receipt = () => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
    for (const value of [receipt(), await f.call('hud_read', { job: job.job })]) {
      assert.equal(value.model, args.model);
      assert.equal(value.thinking, args.thinking);
      assert.equal(value.model_source, 'hud_create');
    }
    const launches = () => f.commands().filter((c) => c.command === 'pi-role').length;
    assert.deepEqual(await f.call('hud_create', { ...args, model: '', thinking: 'low' }), job);
    assert.equal(launches(), 1);
    assert.equal(receipt().model, args.model);
    const defaults = await f.call('hud_create', { role: 'imp', request_key: 'model-default', task: 'Synthetic task.' });
    const original = JSON.parse(fs.readFileSync(join(defaults.task_dir, 'job.json')));
    assert.equal(original.model, 'synthetic/default');
    assert.equal(original.thinking, 'low');
    assert.equal(launches(), 2);
    const thinkingOnly = await f.call('hud_create', {
      role: 'imp',
      request_key: 'thinking-only',
      task: 'Synthetic task.',
      thinking: 'max',
    });
    for (const value of [
      JSON.parse(fs.readFileSync(join(thinkingOnly.task_dir, 'job.json'))),
      await f.call('hud_read', { job: thinkingOnly.job }),
    ]) {
      assert.equal(value.model, 'synthetic/default');
      assert.equal(value.thinking, 'max');
      assert.equal(value.model_source, join(f.root, 'roles', 'implementer.md'));
    }
  }
);

test('thin pi launch switches and verbatim arguments reach argv, receipts and reads', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  for (const enabled of [false, true]) {
    const options = {
      lens: enabled,
      mcp: !enabled,
      tps: enabled,
      ui_ext: enabled,
      skills: !enabled,
      split: !enabled,
      pi_args: ['--tools', 'read', 'literal space;$(not-a-command)'],
    };
    const args = { role: 'imp', request_key: `launch-${enabled}`, task: 'Synthetic task.', ...options };
    const job = await f.call('hud_create', args);
    const argv = f
      .commands()
      .filter((c) => c.command === 'pi-role')
      .at(-1).args;
    const before = argv.slice(0, argv.indexOf('--'));
    for (const key of ['lens', 'mcp', 'tps']) assert.ok(before.includes(`--${options[key] ? '' : 'no-'}${key}`));
    assert.equal(before.includes('--no-ui-ext'), !enabled);
    assert.equal(before.includes('--skills'), !enabled);
    assert.deepEqual(argv.slice(-options.pi_args.length), options.pi_args);
    assert.ok(argv.indexOf('--tools') > argv.indexOf('--'));
    const start = f
      .commands()
      .filter((c) => c.args[0] === 'agent' && c.args[1] === 'start')
      .at(-1).args;
    assert.deepEqual(start.slice(-options.pi_args.length), options.pi_args);
    assert.equal(start[start.indexOf('--pane') + 1], 'w4E:p2');
    const receipt = () => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
    for (const value of [receipt(), await f.call('hud_read', { job: job.job })])
      for (const [key, expected] of Object.entries(options)) assert.deepEqual(value[key], expected);
    assert.match(
      fs.readFileSync(join(job.task_dir, 'SESSION.txt'), 'utf8'),
      enabled ? /^RIGHT=$/m : /^RIGHT=w4E:p3$/m
    );
    assert.deepEqual(await f.call('hud_create', { ...args, lens: !enabled, pi_args: [] }), job);
    assert.equal(receipt().lens, enabled);
    assert.deepEqual(receipt().pi_args, options.pi_args);
  }
  assert.equal(f.commands().filter((c) => c.command === 'pi-role').length, 2);
  const defaults = await f.call('hud_create', { role: 'imp', request_key: 'launch-default', task: 'Synthetic task.' });
  const original = await f.call('hud_read', { job: defaults.job });
  assert.equal(original.split, false);
  assert.equal(original.lens, undefined);
  assert.deepEqual(original.pi_args, []);
});

test('thin launch options reject Jev roles and invalid pi values before dispatch', async (t) => {
  const f = await fixture(t);
  const keys = ['lens', 'mcp', 'tps', 'ui_ext', 'skills', 'split', 'pi_args'];
  assert.deepEqual((await f.call('hud_roster')).roles.find((r) => r.role === 'oracle').accepts_options, []);
  for (const key of keys) {
    const value = key === 'pi_args' ? ['--tools', 'read'] : false;
    assert.deepEqual(
      await f.call('hud_create', { role: 'oracle', request_key: 'jev-launch', task: 'Synthetic.', [key]: value }),
      { ok: false, code: 'invalid_arguments' }
    );
    assert.deepEqual(
      await f.call('hud_create', { role: 'imp', request_key: 'bad-launch', task: 'Synthetic.', [key]: 'invalid' }),
      { ok: false, code: 'invalid_arguments' }
    );
  }
  for (const pi_args of [[1], Array(129).fill('a'), ['a'.repeat(4097)], null])
    assert.deepEqual(
      await f.call('hud_create', { role: 'imp', request_key: 'bad-args', task: 'Synthetic.', pi_args }),
      { ok: false, code: 'invalid_arguments' }
    );
  assert.deepEqual(f.commands(), []);
});

test('thin create rejects model or thinking overrides for Jev roles', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  for (const override of [{ model: 'synthetic/other' }, { thinking: 'max' }]) {
    assert.deepEqual(
      await f.call('hud_create', {
        role: 'oracle',
        request_key: 'jev-override',
        task: 'Synthetic question.',
        ...override,
      }),
      {
        ok: false,
        code: 'invalid_arguments',
      }
    );
  }
  assert.deepEqual(f.commands(), []);
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
  assert.ok(
    f
      .commands()
      .find(
        ({ args }) =>
          args[0] === 'tab' &&
          args.includes('--no-focus') &&
          args[args.indexOf('--workspace') + 1] === 'w4E'
      )
  );
  assert.ok(
    f
      .commands()
      .find(
        ({ command, args }) =>
          command === 'herdr' &&
          args[0] === 'agent' &&
          args[2] === 'w4E:p1' &&
          args[3] === `[oracle@${job.job}] DONE ${job.task_dir}/report.md`
      )
  );
  const state = JSON.parse(fs.readFileSync(join(job.task_dir, 'STATUS.json')));
  assert.equal(state.state, 'closed');
  assert.equal(state.harness, 'jev');
  assert.equal(state.provider, 'openai');
  assert.equal(workerFor(f, job.job).harness, 'jev');
  assert.match(cardText(workerFor(f, job.job)), /oracle.*Synthetic question/);
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

test(
  'worker tab labels read as role and title on one line, with a suffix only on a clash',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const create = (request_key, task) => f.call('hud_create', { role: 'sonic', request_key, task });
    const task = '# Fix the panel footer\n\nA longer description.';
    const [first, second] = [await create('a', task), await create('b', task)];
    const cjk = await create('c', '大型任务：请把面板底部的按键提示改成不会被截断的版本，并且保持中文宽度正确');
    const labels = f
      .commands()
      .filter((c) => c.command === 'herdr' && c.args[0] === 'tab' && c.args[1] === 'create')
      .map((c) => c.args[c.args.indexOf('--label') + 1]);
    assert.equal(labels[0], 'sonic Fix the panel footer');
    assert.match(labels[1], /^sonic Fix the panel \S+ [0-9a-f]{4}$/);
    assert.ok(labels[1].endsWith(second.job.slice(-4)));
    assert.match(labels[2], /^sonic 大型任务.*…$/);
    for (const label of labels) assert.ok(label.replace(/[\u2e80-\ua4cf\uff00-\uff60]/g, 'xx').length <= 28, label);
    // pi-role-reap compares the recorded name with the tab, so it must be the same single line.
    for (const [job, label] of [
      [first, labels[0]],
      [second, labels[1]],
      [cjk, labels[2]],
    ])
      assert.match(fs.readFileSync(join(job.task_dir, 'SESSION.txt'), 'utf8'), new RegExp(`^TAB_NAME=${label}$`, 'm'));
  }
);

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

test('a running job says what its role does: only an implementer builds', () => {
  assert.equal(runningVerb('imp', 'pi'), 'build');
  assert.equal(runningVerb('glm-imp', 'pi'), 'build');
  assert.equal(runningVerb('reviewer', 'pi'), 'reviewing');
  assert.equal(runningVerb('architect', 'pi'), 'researching');
  assert.equal(runningVerb('oracle', 'jev'), 'asking web');
  assert.equal(runningVerb('flow-video', 'jev'), 'generating');
  assert.equal(runningVerb('sonic', 'pi'), 'working');
});
