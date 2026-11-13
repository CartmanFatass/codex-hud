import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { createServer } from 'node:net';
import { readThinJobs, runningVerb } from '../../dist/collectors/thin-jobs.js';
import { cliKinds } from '../../dist/roles/cli-kinds.js';
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
  if (fs.existsSync(join(process.env.HOME, 'start-not-ready'))) {
    console.log(JSON.stringify({ error: { code: 'agent_not_ready', message: 'agent synthetic is blocked during startup and is not ready for prompts' } }));
    process.exit(1);
  }
  if (fs.existsSync(join(process.env.HOME, 'fail-start'))) { console.error('synthetic start failed'); process.exit(1); }
  const at = args.indexOf('--task-dir');
  if (at >= 0) {
    const dir = args[at + 1];
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working', exit_reason: null }));
    fs.writeFileSync(join(dir, 'report.md'), 'Synthetic implementation report.');
  }
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'read') {
  const dialog = join(process.env.HOME, 'trust-dialog');
  const text = fs.existsSync(dialog)
    ? (fs.readFileSync(dialog, 'utf8').trim() || 'Do you trust the contents of this directory?') + '\\n'
    : 'synthetic grok ready\\n';
  console.log(JSON.stringify({ result: { type: 'pane_read', read: { text, pane_id: args[2], workspace_id: 'w4E', tab_id: 'w4E:t2', source: 'recent', format: 'text', revision: 1, truncated: false } } }));
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'process-info') {
  const line = fs.readFileSync('/proc/self/status', 'utf8').split('\\n').find((row) => row.startsWith('PPid:'));
  const ppid = Number(line.split(':')[1]);
  console.log(JSON.stringify({ result: { type: 'pane_process_info', process_info: { pane_id: args[args.indexOf('--pane') + 1], shell_pid: 1, foreground_processes: [{ pid: ppid, name: 'grok' }] } } }));
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'get') {
  const goneId = args[2].replace(/-primary$/, '');
  if (fs.existsSync(join(process.env.HOME, 'late-session-gone')) || fs.existsSync(join(process.env.HUD_HOME, 'jobs', goneId, 'agent-gone')) || ['cli-gone', 'cli-exit', 'cli-unknown'].some((name) => fs.existsSync(join(process.env.HOME, name)))) {
    console.error('agent_not_found');
    process.exit(1);
  }
  let session = { kind: 'id', value: 'synthetic-grok-session', source: 'synthetic', agent: 'grok' };
  const late = join(process.env.HOME, 'late-session');
  if (fs.existsSync(late)) {
    const n = Number(fs.readFileSync(late, 'utf8') || '0') + 1;
    fs.writeFileSync(late, String(n));
    if (n === 1) session = null;
  }
  console.log(JSON.stringify({ result: { type: 'agent_info', agent: { name: args[2], agent_status: 'working', agent_session: session } } }));
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'wait') {
  const until = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--until') until.push(args[i + 1]);
  const id = args[2].replace(/-primary$/, '');
  const dir = join(process.env.HUD_HOME, 'jobs', id);
  const home = process.env.HOME;
  const matched = (agent_status) => console.log(JSON.stringify({ result: { type: 'wait_matched', event: { event: 'pane_agent_status_changed', data: { agent_status, pane_id: 'w4E:p2', workspace_id: 'w4E' } } } }));
  const left = () => fs.existsSync(join(dir, 'agent-gone')) || fs.existsSync(join(dir, 'STATUS.json.stop-requested')) || fs.existsSync(join(dir, 'STATUS.json.close-requested'));
  const poll = (ms, check) => {
    const end = Date.now() + ms;
    let hit = null;
    while (Date.now() < end && !hit) {
      hit = check();
      if (!hit) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    return hit;
  };
  const cap = Math.min(Number(args[args.indexOf('--timeout') + 1]) || 8000, 12000);
  if (fs.existsSync(join(home, 'cli-blocked'))) {
    const released = () => fs.existsSync(join(home, 'release-blocked'));
    if (until.includes('blocked') && !released()) { matched('blocked'); process.exit(0); }
    if (until.includes('working') && until.includes('done') && !until.includes('blocked')) {
      const blockedQuiet = join(home, 'blocked-quiet');
      if (fs.existsSync(blockedQuiet) && (until.includes('idle') || until.includes('unknown')) && !fs.existsSync(join(home, 'blocked-quiet-seen'))) {
        fs.writeFileSync(join(home, 'blocked-quiet-seen'), '');
        if (fs.existsSync(join(home, 'blocked-quiet-gone'))) fs.writeFileSync(join(dir, 'agent-gone'), '');
        matched(fs.readFileSync(blockedQuiet, 'utf8').trim() || 'idle');
        process.exit(0);
      }
      const hit = poll(cap, () => (released() ? 'working' : left() ? 'idle' : null));
      if (hit === 'working') { matched('working'); process.exit(0); }
      if (hit === 'idle') { matched('idle'); process.exit(0); }
      console.error('timeout');
      process.exit(1);
    }
  }
  if (until.includes('done') && until.includes('idle') && !until.includes('blocked') && !until.includes('working')) {
    if (fs.existsSync(join(home, 'phantom-working')) && !fs.existsSync(join(home, 'phantom-settled'))) {
      fs.writeFileSync(join(home, 'phantom-settled'), '');
      matched('done');
      process.exit(0);
    }
    matched('idle');
    process.exit(0);
  }
  if (args.includes('--timeout') && until.includes('working') && !until.includes('done')) {
    const statusFile = join(dir, 'STATUS.json');
    if (fs.existsSync(statusFile)) fs.writeFileSync(join(home, 'seen-grace.json'), fs.readFileSync(statusFile));
    const graceQuiet = join(home, 'grace-quiet');
    if (fs.existsSync(graceQuiet) && !fs.existsSync(join(home, 'grace-quiet-seen'))) {
      fs.writeFileSync(join(home, 'grace-quiet-seen'), '');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
      if (fs.existsSync(join(home, 'grace-quiet-gone'))) fs.writeFileSync(join(dir, 'agent-gone'), '');
      matched(fs.readFileSync(graceQuiet, 'utf8').trim() || 'idle');
      process.exit(0);
    }
    if (!fs.existsSync(join(home, 'hold-grace'))) { console.error('timeout'); process.exit(1); }
    const log = process.env.FAKE_LOG;
    const mark = fs.existsSync(log) ? fs.statSync(log).size : 0;
    const hit = poll(cap, () => {
      if (left()) return 'idle';
      const extra = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').slice(mark) : '';
      return extra.includes('"prompt"') && extra.includes(id) && !extra.includes('/quit') ? 'working' : null;
    });
    if (hit === 'working') { matched('working'); process.exit(0); }
    if (hit === 'idle') { matched('idle'); process.exit(0); }
    console.error('timeout');
    process.exit(1);
  }
  if (until.includes('done') && until.includes('blocked')) {
    const seenPrompt = fs.existsSync(process.env.FAKE_LOG) && fs.readFileSync(process.env.FAKE_LOG, 'utf8').includes('brief.md');
    if (fs.existsSync(join(home, 'startup-done')) && !seenPrompt) { matched('done'); process.exit(0); }
    if (fs.existsSync(join(home, 'phantom-working')) && !fs.existsSync(join(home, 'phantom-settled'))) { matched('done'); process.exit(0); }
    const quietHold = join(home, 'quiet-hold');
    if (fs.existsSync(quietHold) && (until.includes('idle') || until.includes('unknown'))) {
      matched(fs.readFileSync(quietHold, 'utf8').trim() || 'idle');
      process.exit(0);
    }
    if (fs.existsSync(join(home, 'cli-exit'))) { matched('idle'); process.exit(0); }
    if (fs.existsSync(join(home, 'cli-unknown'))) { matched('unknown'); process.exit(0); }
    if (fs.existsSync(join(home, 'cli-gone'))) { console.error('agent_not_found'); process.exit(1); }
    if (fs.existsSync(join(home, 'hold-turn'))) {
      const hit = poll(cap, () => (left() ? 'idle' : fs.existsSync(join(home, 'release-turn')) ? 'done' : null));
      if (hit === 'idle') { matched('idle'); process.exit(0); }
      if (hit !== 'done') { console.error('timeout'); process.exit(1); }
    }
    if (!fs.existsSync(join(home, 'missing-report'))) {
      const countFile = join(home, 'done-count');
      const n = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0) + 1;
      fs.writeFileSync(countFile, String(n));
      const report = join(dir, 'report.md');
      if (n > 1 && !fs.existsSync(join(home, 'unchanged-report'))) fs.writeFileSync(report, 'Synthetic grok report two.' + String.fromCharCode(10));
      else if (!fs.existsSync(report)) fs.writeFileSync(report, 'Synthetic grok report.' + String.fromCharCode(10));
    }
    matched('done');
  } else if (until.includes('idle') || until.includes('unknown')) matched('idle');
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt' && args[3] === '/quit' && fs.existsSync(join(process.env.HOME, 'late-session'))) {
  fs.writeFileSync(join(process.env.HOME, 'late-session-gone'), '');
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
  try {
    const dir = args[0];
    const status = JSON.parse(fs.readFileSync(join(dir, 'STATUS.json'), 'utf8'));
    if (status && !['closed', 'failed', 'stopped', 'idle_grace'].includes(status.state))
      fs.writeFileSync(join(dir, 'STATUS.json.stop-requested'), '');
    fs.writeFileSync(join(dir, 'agent-gone'), '');
  } catch {}
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
    const jobsDir = join(env.HUD_HOME, 'jobs');
    if (fs.existsSync(jobsDir))
      for (const id of fs.readdirSync(jobsDir)) {
        const pidFile = join(jobsDir, id, 'supervisor.pid');
        if (!fs.existsSync(pidFile)) continue;
        try {
          process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM');
        } catch {}
      }
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
    '--tui-mode',
    'regular',
  ]);
  assert.equal(commands.find((c) => c.args[1] === 'start').args.includes('--session-dir'), false);
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

test('thin resume forwards the session ID without overriding pi default lookup', { timeout: 10000 }, async (t) => {
  const f=await fixture(t);
  await f.call('hud_create',{role:'imp',request_key:'synthetic-resume',task:'Continue synthetic history',pi_args:['--session','11111111-2222-4333-8444-555555555555']});
  const start=f.commands().find((c)=>c.args[0]==='agent' && c.args[1]==='start').args;
  assert.deepEqual(start.slice(-2),['--session','11111111-2222-4333-8444-555555555555']);
  assert.equal(start.includes('--session-dir'),false);
});
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
  assert.equal(runningVerb('grok-imp', 'cli'), 'build');
});

const cliStatusKeys = [
  'version', 'task_dir', 'slot', 'harness', 'agent', 'role', 'model', 'thinking', 'state', 'output_path',
  'output_written', 'pid', 'pid_start_time', 'agent_session_id', 'started_at', 'settled_at', 'idle_deadline_at',
  'ended_at', 'exit_reason', 'error', 'updated_at',
];
function assertCliStatus(status, dir) {
  for (const key of cliStatusKeys) assert.equal(Object.hasOwn(status, key), true, key);
  assert.equal(Object.hasOwn(status, 'session_id'), false);
  assert.equal(status.version, 1);
  assert.equal(status.slot, 'primary');
  assert.equal(status.harness, 'cli');
  assert.equal(status.agent, 'grok');
  assert.equal(status.task_dir, fs.realpathSync(dir));
}

test('cli kind table holds launch facts and the registry accepts only a valid cli role', async (t) => {
  assert.deepEqual(cliKinds.grok.model('grok-4.7'), ['-m', 'grok-4.7']);
  assert.deepEqual(cliKinds.grok.effort('high'), ['--reasoning-effort', 'high']);
  assert.deepEqual(cliKinds.grok.bypass, ['--permission-mode', 'bypassPermissions']);
  assert.equal(cliKinds.grok.trust.decline[0], 'n');
  assert.equal(cliKinds.grok.startTimeoutMs, null);
  assert.equal(cliKinds.agy.startupQuirk, 'done-before-prompt');
  assert.equal(cliKinds.agy.trust.text, 'Do you trust the contents of this project?');
  assert.deepEqual([...cliKinds.agy.trust.decline], ['down', 'enter']);
  assert.deepEqual(cliKinds.agy.model('gemini-4-argon-high'), ['--model', 'gemini-4-argon-high']);
  assert.deepEqual(cliKinds.agy.bypass, ['--dangerously-skip-permissions']);
  assert.equal(cliKinds.claude.trust.text, 'Is this a project you created or one you trust?');
  assert.deepEqual([...cliKinds.claude.trust.decline], ['enter']);
  assert.deepEqual(cliKinds.claude.model('opus'), ['--model', 'opus']);
  assert.deepEqual(cliKinds.claude.effort('high'), ['--effort', 'high']);
  assert.deepEqual(cliKinds.claude.bypass, ['--dangerously-skip-permissions']);
  assert.equal(cliKinds.codex.startTimeoutMs, 90000);
  assert.equal(cliKinds.codex.startupQuirk, 'phantom-working');
  assert.equal(cliKinds.codex.trust, null);
  assert.deepEqual(cliKinds.codex.model('gpt-6.1-sol'), ['-m', 'gpt-6.1-sol']);
  assert.deepEqual(cliKinds.codex.effort('high'), ['-c', 'model_reasoning_effort=high']);
  assert.deepEqual(cliKinds.codex.bypass, ['--dangerously-bypass-approvals-and-sandbox']);
  const f = await fixture(t);
  const roster = (await f.call('hud_roster')).roles;
  const role = roster.find((entry) => entry.role === 'grok-imp');
  assert.equal(role.harness, 'cli');
  assert.equal(role.agent, 'grok');
  assert.equal(role.model, 'grok-4.7');
  assert.equal(role.thinking, 'high');
  const agy = roster.find((entry) => entry.role === 'agy-imp');
  assert.equal(agy.harness, 'cli');
  assert.equal(agy.agent, 'agy');
  assert.equal(agy.model, 'gemini-4-argon-high');
  assert.equal(agy.thinking, null);
  assert.equal(agy.can_continue, true);
  const claude = roster.find((entry) => entry.role === 'claude-imp');
  assert.equal(claude.harness, 'cli');
  assert.equal(claude.agent, 'claude');
  assert.equal(claude.model, 'opus');
  assert.equal(claude.thinking, 'high');
  assert.equal(claude.can_continue, true);
  const codex = roster.find((entry) => entry.role === 'codex-imp');
  assert.equal(codex.harness, 'cli');
  assert.equal(codex.agent, 'codex');
  assert.equal(codex.model, 'gpt-6.1-sol');
  assert.equal(codex.thinking, 'high');
  assert.equal(codex.can_continue, true);
  assert.equal(role.can_continue, true);
  assert.deepEqual(role.accepts_options, ['model', 'thinking']);
  assert.equal(role.pi_role_file, null);
  const bad = async (body) => {
    fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
    fs.writeFileSync(join(f.env.HUD_HOME, 'roles', 'bad.json'), JSON.stringify(body));
    const response = await f.rpc('tools/call', { name: 'hud_roster', arguments: {} });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /invalid_role/);
  };
  await bad({ role: 'bad', harness: 'cli', agent: 'nope', can_continue: true });
  await bad({ role: 'bad', harness: 'cli', agent: 'grok' });
  await bad({ role: 'bad', harness: 'cli', agent: 'grok', can_continue: true, idle_grace_s: -1 });
  await bad({ role: 'bad', harness: 'cli', agent: 'grok', can_continue: true, args: 'not-an-array' });
  fs.unlinkSync(join(f.env.HUD_HOME, 'roles', 'bad.json'));
  assert.equal((await f.call('hud_roster')).roles.some((entry) => entry.role === 'imp'), true);
});

test('a grok role runs a brief through idle grace and the watcher reaps the closed tab', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const job = await f.call('hud_create', { role: 'grok-imp', request_key: 'grok-life', task: 'Synthetic grok task.' });
  const start = f.commands().find((c) => c.args[0] === 'agent' && c.args[1] === 'start').args;
  const dash = start.indexOf('--');
  assert.deepEqual(start.slice(0, dash), ['agent', 'start', `${job.job}-primary`, '--kind', 'grok', '--pane', 'w4E:p2']);
  assert.deepEqual(start.slice(dash + 1), ['-m', 'grok-4.7', '--reasoning-effort', 'high', '--permission-mode', 'bypassPermissions']);
  assert.equal(start.some((arg) => /^--(home|session|config|profile|worktree)/.test(arg)), false);
  const prompt = f.commands().find((c) => c.args[1] === 'prompt' && c.args[3] !== '/quit').args[3];
  assert.match(prompt, /instructions\/implementer\.md/);
  assert.match(prompt, /brief\.md/);
  assert.match(prompt, /do exactly what the brief asks/);
  const session = Object.fromEntries(
    fs.readFileSync(join(job.task_dir, 'SESSION.txt'), 'utf8').trim().split('\n').map((line) => line.split('='))
  );
  assert.equal(session.TASK, job.job);
  assert.equal(session.TAB, 'w4E:t2');
  assert.ok(session.TAB_NAME);
  assert.equal(session.LEFT, 'w4E:p2');
  assert.equal(session.RIGHT, '');
  assert.equal(session.ORCH, 'w4E:p1');
  assert.equal(session.BASE, 'HEAD');
  assert.equal(session.PRIMARY, `${job.job}-primary`);
  await until(() => fs.existsSync(join(f.env.HOME, 'seen-grace.json')));
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
  const graceWait = f.commands().find((c) => c.args[1] === 'wait' && c.args.includes('working'));
  assert.equal(graceWait.args[graceWait.args.indexOf('--timeout') + 1], '600000');
  await until(() => {
    const file = join(job.task_dir, 'STATUS.json');
    return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).state === 'closed';
  });
  const closed = JSON.parse(fs.readFileSync(join(job.task_dir, 'STATUS.json'), 'utf8'));
  assertCliStatus(closed, job.task_dir);
  assert.equal(closed.state, 'closed');
  assert.equal(closed.exit_reason, 'settled');
  assert.equal(closed.output_written, true);
  assert.equal(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'), 'Synthetic grok report.\n');
  assert.ok(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'));
  assert.match(cardText(workerFor(f, job.job)), /grok-imp/);
  assert.match(cardText(workerFor(f, job.job)), /Synthetic grok report/);
  await until(() => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at);
  assert.ok(f.commands().some((c) => c.command === 'pi-role-reap' && c.args[0] === job.task_dir));
});

test('cli launch accepts model and thinking overrides and refuses pi-only switches', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  for (const [key, value] of [['pi_args', ['--tools', 'read']], ['lens', true]])
    assert.deepEqual(
      await f.call('hud_create', { role: 'grok-imp', request_key: 'reject-' + key, task: 'Synthetic.', [key]: value }),
      { ok: false, code: 'invalid_arguments' }
    );
  assert.deepEqual(f.commands(), []);
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'roles', 'plain.json'),
    JSON.stringify({ role: 'plain-grok', harness: 'cli', agent: 'grok', can_continue: false, args: ['--extra', 'literal space'] })
  );
  const job = await f.call('hud_create', {
    role: 'grok-imp', request_key: 'grok-override', task: 'Synthetic override.', model: 'grok-4.7-build-fast', thinking: 'low',
  });
  const start = f.commands().find((c) => c.args[1] === 'start').args;
  assert.deepEqual(start.slice(start.indexOf('--') + 1), [
    '-m', 'grok-4.7-build-fast', '--reasoning-effort', 'low', '--permission-mode', 'bypassPermissions',
  ]);
  const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8'));
  assert.equal(receipt.model, 'grok-4.7-build-fast');
  assert.equal(receipt.thinking, 'low');
  assert.equal(receipt.model_source, 'hud_create');
  await until(() => {
    const file = join(job.task_dir, 'STATUS.json');
    return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).state === 'closed';
  });
  const plain = await f.call('hud_create', { role: 'plain-grok', request_key: 'plain', task: 'Synthetic plain.' });
  const plainStart = f.commands().filter((c) => c.args[1] === 'start').at(-1).args;
  assert.deepEqual(plainStart.slice(plainStart.indexOf('--') + 1), ['--permission-mode', 'bypassPermissions', '--extra', 'literal space']);
  await until(() => {
    const file = join(plain.task_dir, 'STATUS.json');
    return fs.existsSync(file) && ['closed', 'failed'].includes(JSON.parse(fs.readFileSync(file, 'utf8')).state);
  });
});

test('a grok trust dialog is declined and the job fails naming the directory', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'trust-dialog'), '');
  const job = await f.call('hud_create', { role: 'grok-imp', request_key: 'grok-trust', task: 'Synthetic trust.' });
  const status = JSON.parse(fs.readFileSync(join(job.task_dir, 'STATUS.json'), 'utf8'));
  const cwd = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8')).cwd;
  assertCliStatus(status, job.task_dir);
  assert.equal(status.state, 'failed');
  assert.equal(status.error, `grok has not trusted ${cwd}; run grok there once and trust it`);
  assert.equal(status.exit_reason, status.error);
  const commands = f.commands();
  const decline = commands.find((c) => c.args[1] === 'send-keys');
  assert.deepEqual(decline.args.slice(3), ['n']);
  assert.ok(commands.some((c) => c.args[1] === 'wait' && c.args.includes('idle')));
  assert.equal(commands.some((c) => c.args[1] === 'prompt'), false);
  assert.equal(fs.existsSync(join(job.task_dir, 'supervisor.pid')), false);
});

test('a cli job with no report fails and quits', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  const job = await f.call('hud_create', { role: 'grok-imp', request_key: 'grok-missing', task: 'Synthetic missing.' });
  await until(() => {
    const file = join(job.task_dir, 'STATUS.json');
    return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).state === 'failed';
  });
  const status = JSON.parse(fs.readFileSync(join(job.task_dir, 'STATUS.json'), 'utf8'));
  assertCliStatus(status, job.task_dir);
  assert.equal(status.error, 'output missing, empty or unchanged');
  assert.equal(status.output_written, false);
  assert.ok(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'));
});

function cliState(dir) {
  const file = join(dir, 'STATUS.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function graceArmed(env, dir) {
  const seen = join(env.HOME, 'seen-grace.json');
  return cliState(dir)?.state === 'idle_grace' && fs.existsSync(seen) && fs.readFileSync(seen, 'utf8').includes(dir.split('/').at(-1));
}

test('a cli continuation in grace is judged against the report at that turn\'s start', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-grace'), '');
  const job = await f.call('hud_create', { role: 'grok-imp', request_key: 'grok-cont', task: 'Synthetic continuation.' });
  await until(() => graceArmed(f.env, job.task_dir), 5000);
  const sent = await f.call('hud_send', { job: job.job, message_key: 'more', text: 'Synthetic continuation.' });
  assert.equal(sent.sent, true);
  assert.equal(sent.queued, undefined);
  await until(() => fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8').includes('two'), 5000);
  await until(() => cliState(job.task_dir)?.state === 'idle_grace' && cliState(job.task_dir)?.output_written === true, 5000);
});

test('an unchanged cli report after continuation fails', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-grace'), '');
  fs.writeFileSync(join(f.env.HOME, 'unchanged-report'), '');
  const job = await f.call('hud_create', { role: 'grok-imp', request_key: 'grok-same', task: 'Synthetic same.' });
  await until(() => graceArmed(f.env, job.task_dir), 5000);
  await f.call('hud_send', { job: job.job, message_key: 'same', text: 'Synthetic continuation.' });
  await until(() => cliState(job.task_dir)?.state === 'failed', 5000);
  assert.equal(cliState(job.task_dir).error, 'output missing, empty or unchanged');
  assert.equal(cliState(job.task_dir).output_written, false);
});

test('hud_send queues into a working cli job', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const job = await f.call('hud_create', { role: 'grok-imp', request_key: 'grok-queue', task: 'Synthetic queue.' });
  await until(() => cliState(job.task_dir)?.state === 'working');
  const sent = await f.call('hud_send', { job: job.job, message_key: 'q', text: 'Synthetic addendum.' });
  assert.equal(sent.queued, true);
  assert.equal(sent.sent, true);
  assert.equal(f.commands().filter((c) => c.args[1] === 'prompt').at(-1).args.at(-1), 'Synthetic addendum.');
});

test('hud_close stops a working cli job and closes an idle-grace one', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const working = await f.call('hud_create', { role: 'grok-imp', request_key: 'grok-stop', task: 'Synthetic stop.' });
  await until(() => cliState(working.task_dir)?.state === 'working');
  assert.equal(typeof cliState(working.task_dir).pid, 'number');
  assert.match(cliState(working.task_dir).pid_start_time, /^\d+$/);
  assert.deepEqual(await f.call('hud_close', { job: working.job }), { exit_code: 0, last_line: 'Synthetic reap complete' });
  await until(() => cliState(working.task_dir)?.state === 'stopped');
  assert.equal(cliState(working.task_dir).exit_reason, 'stop requested');
  assert.equal(fs.existsSync(join(working.task_dir, 'STATUS.json.stop-requested')), true);
  fs.unlinkSync(join(f.env.HOME, 'hold-turn'));
  fs.writeFileSync(join(f.env.HOME, 'hold-grace'), '');
  const grace = await f.call('hud_create', { role: 'grok-imp', request_key: 'grok-close', task: 'Synthetic close.' });
  await until(() => cliState(grace.task_dir)?.state === 'idle_grace');
  await f.call('hud_close', { job: grace.job });
  await until(() => cliState(grace.task_dir)?.state === 'closed');
  assert.equal(cliState(grace.task_dir).exit_reason, 'settled');
  assert.equal(fs.existsSync(join(grace.task_dir, 'STATUS.json.close-requested')), true);
});

test('a cli that exits fails, and a closed tab fails', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'cli-exit'), '');
  const exited = await f.call('hud_create', { role: 'grok-imp', request_key: 'grok-exit', task: 'Synthetic exit.' });
  await until(() => cliState(exited.task_dir)?.state === 'failed');
  assert.equal(cliState(exited.task_dir).error, 'agent exited');
  fs.unlinkSync(join(f.env.HOME, 'cli-exit'));
  fs.writeFileSync(join(f.env.HOME, 'cli-gone'), '');
  const missing = await f.call('hud_create', { role: 'grok-imp', request_key: 'grok-gone', task: 'Synthetic gone.' });
  await until(() => cliState(missing.task_dir)?.state === 'failed');
  assert.equal(cliState(missing.task_dir).error, 'agent exited');
});

test('closing a cli job tab fails it', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
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
  const job = await f.call('hud_create', { role: 'grok-imp', request_key: 'grok-tab', task: 'Synthetic tab.' });
  await until(() => request && cliState(job.task_dir)?.state === 'working');
  socket.write(JSON.stringify({ event: 'tab_closed', data: { type: 'tab_closed', tab_id: 'w4E:t2', workspace_id: 'w4E' } }) + '\n');
  await until(() => cliState(job.task_dir)?.exit_reason === 'tab closed');
  assert.equal(cliState(job.task_dir).state, 'failed');
});

function runAsk(env, args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-ask.mjs'), ...args], {
      env: { ...process.env, PATH: env.PATH, FAKE_LOG: env.FAKE_LOG, HOME: env.HOME, HUD_HOME: env.HUD_HOME },
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => done({ code, stdout, stderr }));
  });
}

test('implementer instructions tell a CLI worker to ask through hud-ask', () => {
  const text = fs.readFileSync(resolve('packages/hud-mcp/instructions/implementer.md'), 'utf8');
  assert.match(text, /hud-ask/);
  assert.match(text, /absolute path/);
  assert.match(text, /never a terminal prompt/);
  assert.match(text, /Keep working/);
  assert.doesNotMatch(text, /write the question in your report and stop/);
});

test('hud-ask round trip notifies the orchestrator and prints the hud_respond answer', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const id = 'j00000000000000a1', dir = join(f.env.HUD_HOME, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({
    job: id, role: 'grok-imp', cwd: '/synthetic/MyHUD', herdr_pane: 'w4E:p1', created_at: new Date().toISOString(),
  }));
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working', harness: 'cli', agent: 'grok' }));
  fs.writeFileSync(join(dir, 'brief.md'), '# Synthetic ask\n');
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'LEFT=w4E:p2\nORCH=w4E:p1\n');
  const pending = runAsk(f.env, ['--dir', dir, '--question', 'Which layout?', '--option', 'rows', '--option', 'columns', '--default', 'rows', '--context', 'card width', '--timeout', '30']);
  await until(() => fs.existsSync(join(dir, 'qa', 'q1.md')));
  const body = fs.readFileSync(join(dir, 'qa', 'q1.md'), 'utf8');
  assert.match(body, /^# Question q1 from grok-imp@MyHUD\n/);
  assert.match(body, /Which layout\?/);
  assert.match(body, /Options:\n- rows\n- columns/);
  assert.match(body, /Default if unanswered: rows/);
  assert.match(body, /Context: card width/);
  assert.match(body, /Answer: write the answer to .*q1\.answer\.md/);
  await until(() => f.commands().some((c) => String(c.args.at(-1)).includes('QUESTION q1')));
  const notice = f.commands().find((c) => String(c.args.at(-1)).includes('QUESTION q1'));
  assert.equal(notice.args[2], 'w4E:p1');
  assert.match(notice.args.at(-1), /^\[grok-imp@MyHUD\] QUESTION q1: Which layout\? \| options: rows \/ columns \| default: rows \| full text: /);
  const read = await f.call('hud_read', { job: id });
  assert.equal(read.questions[0].id, 'q1');
  assert.match(read.questions[0].text, /Which layout\?/);
  const asking = workerFor(f, id);
  assert.equal(asking.homeNeedsHuman, true);
  assert.equal(asking.ask, 'Which layout?');
  await f.call('hud_respond', { job: id, request_id: 'q1', answer: 'columns' });
  const result = await pending;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /ANSWER from the orchestrator \(q1, after \d+s\):\n\ncolumns/);
  assert.equal((await f.call('hud_read', { job: id })).questions.length, 0);
});

test('hud-ask prints the default when no answer arrives', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const id = 'j00000000000000a2', dir = join(f.env.HUD_HOME, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({
    job: id, role: 'grok-imp', cwd: '/synthetic/MyHUD', herdr_pane: 'w4E:p1', created_at: new Date().toISOString(),
  }));
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'ORCH=w4E:p1\n');
  const result = await runAsk(f.env, ['--dir', dir, '--question', 'Which layout?', '--default', 'rows', '--timeout', '1']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /No answer to q1 within 1s \(pushed via "herdr agent prompt w4E:p1"\)\. Proceed with your default: rows\. Record the open question in your report/);
  assert.equal(fs.existsSync(join(dir, 'qa', 'q1.md')), true);
});

test('a blocked CLI turn needs the owner once, then returns to working', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'cli-blocked'), '');
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const job = await f.call('hud_create', { role: 'grok-imp', request_key: 'grok-blocked', task: 'Synthetic blocked.' });
  assert.match(fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8'), /node ".*\/hud-ask\.mjs" --dir ".*" --question/);
  const notices = () => f.commands().filter((c) => c.args[1] === 'prompt' && String(c.args.at(-1)).includes('BLOCKED:'));
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator' && notices().length === 1);
  const blocked = cliState(job.task_dir);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.harness, 'cli');
  assert.equal(notices().length, 1);
  assert.equal(notices()[0].args[2], 'w4E:p1');
  assert.equal(notices()[0].args.at(-1), `[grok-imp@${basename(f.root)}] BLOCKED: grok is waiting for interactive input in pane w4E:p2`);
  const worker = workerFor(f, job.job);
  assert.equal(worker.homeNeedsHuman, true);
  assert.equal(worker.phase, 'asking');
  assert.equal(worker.ask, 'grok needs input in its pane');
  assert.match(cardText(worker), /grok needs input in its pane/);
  assert.match(cardText(worker), /asking/);
  fs.writeFileSync(join(f.env.HOME, 'release-blocked'), '');
  await until(() => cliState(job.task_dir)?.state === 'working' && cliState(job.task_dir)?.blocked === false, 5000);
  assert.equal(notices().length, 1);
  const resumed = workerFor(f, job.job);
  assert.equal(resumed.homeNeedsHuman, false);
  assert.equal(resumed.ask, undefined);
  fs.writeFileSync(join(f.env.HOME, 'release-turn'), '');
  await until(() => cliState(job.task_dir)?.state === 'closed', 5000);
});

function graceTimeouts(f) {
  return f.commands()
    .filter((c) => c.args[1] === 'wait' && c.args.includes('working') && !c.args.includes('done'))
    .map((c) => Number(c.args[c.args.indexOf('--timeout') + 1]));
}

test('an agy role launches without an effort flag, and a startup done does not settle the job', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'startup-done'), '');
  const job = await f.call('hud_create', { role: 'agy-imp', request_key: 'agy-life', task: 'Synthetic agy task.' });
  const start = f.commands().find((c) => c.args[1] === 'start').args;
  assert.deepEqual(start.slice(start.indexOf('--') + 1), ['--model', 'gemini-4-argon-high', '--dangerously-skip-permissions']);
  assert.equal(start.includes('--effort'), false);
  await until(() => cliState(job.task_dir)?.state === 'closed', 8000);
  const commands = f.commands();
  const promptAt = commands.findIndex((c) => c.args[1] === 'prompt' && c.args[3] !== '/quit');
  const doneWaitAt = commands.findIndex((c) => c.args[1] === 'wait' && c.args.includes('done'));
  assert.ok(promptAt >= 0 && doneWaitAt > promptAt);
  const closed = cliState(job.task_dir);
  assert.equal(closed.agent, 'agy');
  assert.equal(closed.model, 'gemini-4-argon-high');
  assert.equal(closed.thinking, null);
  assert.equal(closed.state, 'closed');
  assert.equal(closed.exit_reason, 'settled');
  assert.equal(closed.error, null);
  assert.equal(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'), 'Synthetic grok report.\n');
  assert.ok(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'));
});

test('agent_not_ready runs the trust check for any kind, and a start error without that text is unchanged', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'start-not-ready'), '');
  fs.writeFileSync(join(f.env.HOME, 'trust-dialog'), 'Do you trust the contents of this project?');
  const agy = await f.call('hud_create', { role: 'agy-imp', request_key: 'agy-trust', task: 'Synthetic trust.' });
  const agyStatus = cliState(agy.task_dir);
  const cwd = JSON.parse(fs.readFileSync(join(agy.task_dir, 'job.json'), 'utf8')).cwd;
  assert.equal(agyStatus.state, 'failed');
  assert.equal(agyStatus.error, `agy has not trusted ${cwd}; run agy there once and trust it`);
  assert.deepEqual(f.commands().find((c) => c.args[1] === 'send-keys').args.slice(3), ['down', 'enter']);
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt'), false);
  assert.equal(fs.existsSync(join(agy.task_dir, 'supervisor.pid')), false);
  fs.unlinkSync(join(f.env.HOME, 'trust-dialog'));
  const bare = await f.call('hud_create', { role: 'agy-imp', request_key: 'agy-not-ready', task: 'Synthetic not ready.' });
  assert.equal(f.commands().filter((c) => c.args[1] === 'send-keys').length, 1);
  assert.match(cliState(bare.task_dir).exit_reason, /agent_not_ready/);
  assert.equal(fs.existsSync(join(bare.task_dir, 'supervisor.pid')), false);
  fs.writeFileSync(join(f.env.HOME, 'trust-dialog'), '');
  const grok = await f.call('hud_create', { role: 'grok-imp', request_key: 'grok-not-ready', task: 'Synthetic grok trust.' });
  assert.deepEqual(f.commands().filter((c) => c.args[1] === 'send-keys').at(-1).args.slice(3), ['n']);
  assert.match(cliState(grok.task_dir).error, /^grok has not trusted /);
});

test('a claude role launches with its flags and settles through idle grace', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const job = await f.call('hud_create', { role: 'claude-imp', request_key: 'claude-life', task: 'Synthetic claude task.' });
  const start = f.commands().find((c) => c.args[1] === 'start').args;
  const dash = start.indexOf('--');
  assert.deepEqual(start.slice(0, dash), ['agent', 'start', `${job.job}-primary`, '--kind', 'claude', '--pane', 'w4E:p2']);
  assert.deepEqual(start.slice(dash + 1), ['--model', 'opus', '--effort', 'high', '--dangerously-skip-permissions']);
  assert.equal(start.includes('--timeout'), false);
  await until(() => cliState(job.task_dir)?.state === 'closed', 8000);
  const closed = cliState(job.task_dir);
  assert.equal(closed.agent, 'claude');
  assert.equal(closed.model, 'opus');
  assert.equal(closed.thinking, 'high');
  assert.equal(closed.state, 'closed');
  assert.equal(closed.exit_reason, 'settled');
  assert.equal(closed.error, null);
  assert.ok(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'));
  assert.equal(f.commands().some((c) => c.args[1] === 'send-keys'), false);
});

test('a claude trust dialog is declined with enter and the launch fails with the reason', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'start-not-ready'), '');
  fs.writeFileSync(join(f.env.HOME, 'trust-dialog'), 'Is this a project you created or one you trust?');
  const job = await f.call('hud_create', { role: 'claude-imp', request_key: 'claude-trust', task: 'Synthetic trust.' });
  const status = cliState(job.task_dir);
  const cwd = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8')).cwd;
  assert.equal(status.state, 'failed');
  assert.equal(status.error, `claude has not trusted ${cwd}; run claude there once and trust it`);
  assert.deepEqual(f.commands().find((c) => c.args[1] === 'send-keys').args.slice(3), ['enter']);
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt'), false);
  assert.equal(fs.existsSync(join(job.task_dir, 'supervisor.pid')), false);
});

test('idle and unknown while the agent is present do not settle the job', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  for (const status of ['idle', 'unknown']) {
    fs.writeFileSync(join(f.env.HOME, 'quiet-hold'), status);
    const job = await f.call('hud_create', { role: 'grok-imp', request_key: 'quiet-' + status, task: 'Synthetic quiet.' });
    await until(() => cliState(job.task_dir)?.state === 'closed', 8000);
    assert.equal(cliState(job.task_dir).error, null);
    assert.equal(cliState(job.task_dir).exit_reason, 'settled');
    const waits = f.commands().filter((c) => c.args[1] === 'wait' && c.args.includes('done') && c.args[2] === `${job.job}-primary`);
    assert.ok(waits.some((c) => c.args.includes(status)));
    assert.ok(waits.some((c) => !c.args.includes('idle') && !c.args.includes('unknown')));
  }
});

test('unknown while the agent is gone settles the job', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'cli-unknown'), '');
  const job = await f.call('hud_create', { role: 'grok-imp', request_key: 'unknown-gone', task: 'Synthetic unknown.' });
  await until(() => cliState(job.task_dir)?.state === 'failed');
  assert.equal(cliState(job.task_dir).error, 'agent exited');
});

test('grace keeps its deadline when idle is not an exit, and unknown with the agent gone leaves', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'grace-quiet'), 'idle');
  const held = await f.call('hud_create', { role: 'grok-imp', request_key: 'grace-idle', task: 'Synthetic grace.' });
  await until(() => cliState(held.task_dir)?.state === 'closed', 8000);
  const timeouts = graceTimeouts(f);
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts[1] < timeouts[0]);
  assert.equal(cliState(held.task_dir).exit_reason, 'settled');
  assert.equal(cliState(held.task_dir).error, null);
  const seen = JSON.parse(fs.readFileSync(join(f.env.HOME, 'seen-grace.json'), 'utf8'));
  assert.equal(cliState(held.task_dir).idle_deadline_at, seen.idle_deadline_at);
  fs.unlinkSync(join(f.env.HOME, 'grace-quiet-seen'));
  fs.writeFileSync(join(f.env.HOME, 'grace-quiet'), 'unknown');
  fs.writeFileSync(join(f.env.HOME, 'grace-quiet-gone'), '');
  const gone = await f.call('hud_create', { role: 'grok-imp', request_key: 'grace-gone', task: 'Synthetic grace gone.' });
  await until(() => cliState(gone.task_dir)?.state === 'failed', 8000);
  assert.equal(cliState(gone.task_dir).error, 'agent exited');
});

test('a blocked resume treats idle as present and unknown as gone', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'cli-blocked'), '');
  fs.writeFileSync(join(f.env.HOME, 'blocked-quiet'), 'idle');
  const held = await f.call('hud_create', { role: 'grok-imp', request_key: 'blocked-idle', task: 'Synthetic blocked quiet.' });
  await until(() => cliState(held.task_dir)?.state === 'waiting_orchestrator');
  fs.writeFileSync(join(f.env.HOME, 'release-blocked'), '');
  await until(() => cliState(held.task_dir)?.state === 'closed', 8000);
  assert.equal(cliState(held.task_dir).exit_reason, 'settled');
  assert.equal(cliState(held.task_dir).error, null);
  fs.unlinkSync(join(f.env.HOME, 'release-blocked'));
  fs.unlinkSync(join(f.env.HOME, 'blocked-quiet-seen'));
  fs.writeFileSync(join(f.env.HOME, 'blocked-quiet'), 'unknown');
  fs.writeFileSync(join(f.env.HOME, 'blocked-quiet-gone'), '');
  const gone = await f.call('hud_create', { role: 'grok-imp', request_key: 'blocked-gone', task: 'Synthetic blocked gone.' });
  await until(() => cliState(gone.task_dir)?.state === 'failed', 8000);
  assert.equal(cliState(gone.task_dir).error, 'agent exited');
});

test('a codex role waits out a phantom startup and passes the start timeout', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'phantom-working'), '');
  const job = await f.call('hud_create', { role: 'codex-imp', request_key: 'codex-life', task: 'Synthetic codex task.' });
  const start = f.commands().find((c) => c.args[1] === 'start').args;
  const dash = start.indexOf('--');
  assert.deepEqual(start.slice(0, dash), [
    'agent', 'start', `${job.job}-primary`, '--kind', 'codex', '--pane', 'w4E:p2', '--timeout', '90000',
  ]);
  assert.deepEqual(start.slice(dash + 1), [
    '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', '--dangerously-bypass-approvals-and-sandbox',
  ]);
  assert.equal(start.some((arg) => /^--(home|session|config|profile|worktree)/.test(arg) || arg.includes('CODEX_HOME')), false);
  const commands = f.commands();
  const settleAt = commands.findIndex(
    (c) => c.args[1] === 'wait' && c.args.includes('done') && c.args.includes('idle') && !c.args.includes('blocked')
  );
  const promptAt = commands.findIndex((c) => c.args[1] === 'prompt' && c.args[3] !== '/quit');
  assert.ok(settleAt >= 0 && promptAt > settleAt);
  assert.equal(commands[settleAt].args[commands[settleAt].args.indexOf('--timeout') + 1], '60000');
  assert.equal(fs.existsSync(join(f.env.HOME, 'phantom-settled')), true);
  await until(() => cliState(job.task_dir)?.state === 'closed', 8000);
  const closed = cliState(job.task_dir);
  assert.equal(closed.agent, 'codex');
  assert.equal(closed.model, 'gpt-6.1-sol');
  assert.equal(closed.thinking, 'high');
  assert.equal(closed.state, 'closed');
  assert.equal(closed.exit_reason, 'settled');
  assert.equal(closed.error, null);
  assert.equal(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'), 'Synthetic grok report.\n');
  assert.ok(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'));
  assert.equal(f.commands().some((c) => c.args[1] === 'send-keys'), false);
});

test('a cli job records agent_session_id when herdr publishes it after the first get', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'late-session'), '0');
  const job = await f.call('hud_create', { role: 'grok-imp', request_key: 'late-session', task: 'Synthetic late session.' });
  await until(() => fs.existsSync(join(f.env.HOME, 'seen-grace.json')));
  const grace = JSON.parse(fs.readFileSync(join(f.env.HOME, 'seen-grace.json'), 'utf8'));
  assert.equal(grace.state, 'idle_grace');
  assert.equal(grace.agent_session_id, 'synthetic-grok-session');
  await until(() => cliState(job.task_dir)?.state === 'closed');
  assert.equal(cliState(job.task_dir).agent_session_id, 'synthetic-grok-session');
});

test('a failed cli job records agent_session_id published after start, before quit', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'late-session'), '0');
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  const job = await f.call('hud_create', { role: 'grok-imp', request_key: 'late-fail', task: 'Synthetic late fail.' });
  await until(() => cliState(job.task_dir)?.state === 'failed');
  assert.equal(cliState(job.task_dir).error, 'output missing, empty or unchanged');
  assert.equal(cliState(job.task_dir).agent_session_id, 'synthetic-grok-session');
});
