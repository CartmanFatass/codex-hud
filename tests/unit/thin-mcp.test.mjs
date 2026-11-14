import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { readThinJobs, runningVerb } from '../../dist/collectors/thin-jobs.js';
import { cliKinds } from '../../dist/roles/cli-kinds.js';
import { projectWorkCard } from '../../dist/collectors/work-card.js';
import { renderWorkCard, workStateInk } from '../../dist/render/work-card.js';
import { workInspectorRows } from '../../dist/render/work-inspector.js';
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
import { spawn, spawnSync } from 'node:child_process';
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
  if (['cli-exit', 'cli-unknown', 'cli-gone', 'grace-quiet-gone', 'blocked-quiet-gone', 'exit-after-done'].some((name) => fs.existsSync(join(process.env.HOME, name)))) {
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    fs.writeFileSync(join(process.env.HOME, 'fake-agent-pid'), String(sleeper.pid));
  }
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'read') {
  const paneFile = join(process.env.HOME, 'pane-read');
  const dialog = join(process.env.HOME, 'trust-dialog');
  const text = fs.existsSync(paneFile)
    ? fs.readFileSync(paneFile, 'utf8')
    : fs.existsSync(dialog)
      ? (fs.readFileSync(dialog, 'utf8').trim() || 'Do you trust the contents of this directory?') + '\\n'
      : 'synthetic grok ready\\n';
  console.log(JSON.stringify({ result: { type: 'pane_read', read: { text, pane_id: args[2], workspace_id: 'w4E', tab_id: 'w4E:t2', source: 'recent', format: 'text', revision: 1, truncated: false } } }));
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'process-info') {
  if (fs.existsSync(join(process.env.HOME, 'no-pid'))) {
    console.log(JSON.stringify({ result: { type: 'pane_process_info', process_info: { pane_id: args[args.indexOf('--pane') + 1], shell_pid: 1, foreground_processes: [] } } }));
    process.exit(0);
  }
  const pidFile = join(process.env.HOME, 'cli-pid');
  const fakePidFile = join(process.env.HOME, 'fake-agent-pid');
  const line = fs.readFileSync('/proc/self/status', 'utf8').split('\\n').find((row) => row.startsWith('PPid:'));
  const ppid = fs.existsSync(pidFile)
    ? Number(fs.readFileSync(pidFile, 'utf8').trim())
    : fs.existsSync(fakePidFile)
      ? Number(fs.readFileSync(fakePidFile, 'utf8').trim())
      : Number(line.split(':')[1]);
  console.log(JSON.stringify({ result: { type: 'pane_process_info', process_info: { pane_id: args[args.indexOf('--pane') + 1], shell_pid: 1, foreground_processes: [{ pid: ppid, name: 'grok' }] } } }));
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'get') {
  const goneId = args[2].replace(/-primary$/, '');
  if (fs.existsSync(join(process.env.HOME, 'herdr-errors')) || fs.existsSync(join(process.env.HOME, 'late-session-gone')) || fs.existsSync(join(process.env.HUD_HOME, 'jobs', goneId, 'agent-gone')) || ['cli-gone', 'cli-exit', 'cli-unknown'].some((name) => fs.existsSync(join(process.env.HOME, name)))) {
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
  const killFakeAgent = () => {
    const fakePidFile = join(home, 'fake-agent-pid');
    if (fs.existsSync(fakePidFile)) {
      const fpid = Number(fs.readFileSync(fakePidFile, 'utf8').trim());
      if (fpid > 0) {
        try { process.kill(fpid, 'SIGKILL'); } catch {}
        const end = Date.now() + 200;
        while (Date.now() < end) {
          try {
            const st = fs.readFileSync('/proc/' + fpid + '/stat', 'utf8');
            if (st.slice(st.lastIndexOf(')') + 1).trim().startsWith('Z ')) break;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          } catch {
            break;
          }
        }
      }
    }
  };
  if (fs.existsSync(join(home, 'herdr-errors'))) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    console.error('herdr_error');
    process.exit(1);
  }
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
        if (fs.existsSync(join(home, 'blocked-quiet-gone'))) { fs.writeFileSync(join(dir, 'agent-gone'), ''); killFakeAgent(); }
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
  if (until.includes('working') && until.includes('blocked') && !until.includes('done')) {
    if (fs.existsSync(join(home, 'exit-after-done'))) { fs.writeFileSync(join(dir, 'agent-gone'), ''); killFakeAgent(); }
    if (fs.existsSync(join(home, 'cli-exit'))) { killFakeAgent(); matched('idle'); process.exit(0); }
    if (fs.existsSync(join(home, 'cli-unknown'))) { killFakeAgent(); matched('unknown'); process.exit(0); }
    if (fs.existsSync(join(home, 'cli-gone'))) { killFakeAgent(); console.error('agent_not_found'); process.exit(1); }
    const hit = poll(cap, () => (left() ? 'idle' : fs.existsSync(join(home, 'wake-turn')) ? 'working' : null));
    if (hit === 'working') { matched('working'); process.exit(0); }
    if (hit === 'idle') { matched('idle'); process.exit(0); }
    console.error('timeout');
    process.exit(1);
  }
  if (args.includes('--timeout') && until.includes('working') && !until.includes('done') && !until.includes('blocked')) {
    const statusFile = join(dir, 'STATUS.json');
    if (fs.existsSync(statusFile)) fs.writeFileSync(join(home, 'seen-grace.json'), fs.readFileSync(statusFile));
    const graceQuiet = join(home, 'grace-quiet');
    if (fs.existsSync(graceQuiet) && !fs.existsSync(join(home, 'grace-quiet-seen'))) {
      fs.writeFileSync(join(home, 'grace-quiet-seen'), '');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
      if (fs.existsSync(join(home, 'grace-quiet-gone'))) { fs.writeFileSync(join(dir, 'agent-gone'), ''); killFakeAgent(); }
      matched(fs.readFileSync(graceQuiet, 'utf8').trim() || 'idle');
      process.exit(0);
    }
    if (!fs.existsSync(join(home, 'hold-grace'))) {
      if (fs.existsSync(join(home, 'report-while-working')) && !fs.existsSync(join(home, 'release-done'))) {
        matched('working');
        process.exit(0);
      }
      console.error('timeout');
      process.exit(1);
    }
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
    if (fs.existsSync(join(home, 'cli-exit'))) { killFakeAgent(); matched('idle'); process.exit(0); }
    if (fs.existsSync(join(home, 'cli-unknown'))) { killFakeAgent(); matched('unknown'); process.exit(0); }
    if (fs.existsSync(join(home, 'cli-gone'))) { killFakeAgent(); console.error('agent_not_found'); process.exit(1); }
    if (fs.existsSync(join(home, 'report-while-working'))) {
      const stageFile = join(home, 'report-while-working-stage');
      const stage = fs.existsSync(stageFile) ? Number(fs.readFileSync(stageFile, 'utf8')) : 0;
      fs.writeFileSync(stageFile, String(stage + 1));
      if (stage === 0) {
        fs.writeFileSync(join(dir, 'report.md'), 'Synthetic mid-turn report.\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
        console.error('timeout');
        process.exit(1);
      }
      const hit = poll(cap, () => (left() ? 'idle' : fs.existsSync(join(home, 'release-done')) ? 'done' : null));
      if (hit === 'done') { matched('done'); process.exit(0); }
      if (hit === 'idle') { matched('idle'); process.exit(0); }
      console.error('timeout');
      process.exit(1);
    }
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
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt' && String(args[3]).startsWith('Write your report to ') && fs.existsSync(join(process.env.HOME, 'write-on-report-prompt'))) {
  const reportPath = String(args[3]).slice('Write your report to '.length).split(' now;')[0];
  fs.writeFileSync(reportPath, 'Synthetic report after prompt.\\n');
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt' && fs.existsSync(join(process.env.HOME, 'stalled-prompt'))) {
  console.error('agent_prompt_stalled after submit'); process.exit(1);
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt' && fs.existsSync(join(process.env.HOME, 'rejected-prompt'))) {
  console.error('agent_not_ready before input'); process.exit(1);
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
  for (const command of ['pi-role', 'pi-dispatch', 'pi-role-reap', 'herdr', 'jev-ask', 'jev-aistudio', 'jev-flow', 'grok', 'agy', 'claude', 'codex']) {
    fs.writeFileSync(join(bin, command), fake, { mode: 0o700 });
  }
  fs.mkdirSync(join(root, 'roles'));
  fs.writeFileSync(join(root, 'roles', 'implementer.md'), '---\nmodel: synthetic/default\nthinking: low\n---\n');
  // Accelerate deadlines, not observations: production still wakes from real socket/file events.
  const clock = join(root, 'clock.mjs');
  fs.writeFileSync(clock, `import * as fs from 'node:fs';
import { join } from 'node:path';
if (process.argv[1]?.endsWith('/hud-cli.mjs')) {
  const now = Date.now, timer = globalThis.setTimeout, anchor = Date.now();
  Date.now = () => anchor + (now() - anchor) * 20;
  globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms === 250 ? 15 : ms / 20, ...args);
  const readdir = fs.readdirSync;
  fs.default.readdirSync = (...args) => {
    if (args[0] === '/proc') fs.appendFileSync(join(process.env.HOME, 'proc-scans'), 'scan\\n');
    return readdir(...args);
  };
  const rename = fs.renameSync;
  fs.default.renameSync = (...args) => {
    if (args[1].endsWith('/STATUS.json')) fs.appendFileSync(join(process.env.HOME, 'status-writes'), args[1] + '\\n');
    return rename(...args);
  };
  const { syncBuiltinESMExports } = await import('node:module');
  syncBuiltinESMExports();
}`);
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${clock}`,
    HUD_MCP_SURFACE: 'roles',
    HUD_WATCH_FAILED_RETENTION_MS: '1000',
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_LOG: log,
    HERDR_SOCKET_PATH: join(root, 'events.sock'),
  };
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'GEMINI_API_KEY', 'TYPESAFE_API_KEY', 'MISTRAL_API_KEY']) {
    delete env[key];
  }
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
  let cliSocket;
  const socketRequests = [];
  const subscribers = new Set();
  const has = (name) => fs.existsSync(join(env.HOME, name));
  const push = (client, state) => {
    client.state = state;
    client.socket.write(JSON.stringify({ event: 'pane_agent_status_changed', data: { pane_id: 'w4E:p2', workspace_id: 'w4E', agent_status: state } }) + '\n');
  };
  async function startCliSocket() {
    if (cliSocket || fs.existsSync(env.HERDR_SOCKET_PATH)) return;
    cliSocket = createServer((socket) => {
      const client = { socket, id: null, state: null, reported: 0 };
      const lines = createInterface({ input: socket });
      lines.on('line', (line) => {
        const req = JSON.parse(line);
        socketRequests.push(req);
        const reply = (result) => socket.write(JSON.stringify({ id: req.id, result }) + '\n');
        if (req.method === 'events.subscribe') {
          client.supervisor = req.params.subscriptions.some((sub) => sub.type === 'pane.agent_status_changed');
          subscribers.add(client); reply({ type: 'subscribed' });
        }
        else if (req.method === 'agent.get') {
          const id = req.params.target.replace(/-primary$/, '');
          const sub = [...subscribers].reverse().find((item) => item.supervisor && !item.id) ?? [...subscribers].find((item) => item.supervisor && item.id === id);
          if (sub) sub.id = id;
          if (has('herdr-errors') || has('no-pid')) { socket.write(JSON.stringify({ id: req.id, error: { code: 'agent_not_found' } }) + '\n'); return; }
          reply({ agent: { agent_status: sub?.state ?? 'working', agent_session: has('late-session') && !has('exit-after-done') && !has('socket-got-session') ? null : { kind: 'id', value: 'synthetic-grok-session' } } });
          fs.writeFileSync(join(env.HOME, 'socket-got-session'), '');
        } else if (req.method === 'pane.process_info') {
          const pidFile = ['cli-pid', 'fake-agent-pid'].map((file) => join(env.HOME, file)).find((file) => fs.existsSync(file));
          const id = [...subscribers].filter((item) => item.supervisor).at(-1)?.id;
          const supervisor = id && join(env.HUD_HOME, 'jobs', id, 'supervisor.pid');
          reply({ process_info: { shell_pid: 1, foreground_processes: has('no-pid') ? [] : [{ pid: pidFile ? Number(fs.readFileSync(pidFile)) : supervisor && fs.existsSync(supervisor) ? Number(fs.readFileSync(supervisor)) : child.pid }] } });
        }
      });
      socket.on('error', () => {});
      lines.on('error', () => {});
      socket.on('close', () => { subscribers.delete(client); lines.close(); });
    });
    await new Promise((done) => cliSocket.listen(env.HERDR_SOCKET_PATH, done));
    const simulation = setInterval(() => {
      for (const client of subscribers) {
        if (!client.id || has('manual-socket')) continue;
        const dir = join(env.HUD_HOME, 'jobs', client.id);
        if (!fs.existsSync(join(dir, 'turn.json'))) continue;
        if (has('herdr-errors')) { client.socket.destroy(); continue; }
        const turn = JSON.parse(fs.readFileSync(join(dir, 'turn.json')));
        const status = cliState(dir);
        if (status?.state === 'idle_grace') fs.writeFileSync(join(env.HOME, 'seen-grace.json'), JSON.stringify(status));
        let state = has('hold-turn') && !has('release-turn') ? 'working' : 'done';
        if (has('cli-blocked') && !has('release-blocked')) state = 'blocked';
        const report = join(dir, 'report.md');
        if (has('report-while-working')) {
          if (!fs.existsSync(report)) fs.writeFileSync(report, 'Synthetic mid-turn report.\n');
          fs.writeFileSync(join(env.HOME, 'report-while-working-stage'), '1');
          if (!has('release-done')) state = 'working';
        } else if (state === 'done' && !has('missing-report') && client.reported !== turn.seq) {
          if (turn.seq > 1 && !has('unchanged-report')) fs.writeFileSync(report, 'Synthetic grok report two.\n');
          else if (!fs.existsSync(report)) fs.writeFileSync(report, 'Synthetic grok report.\n');
          client.reported = turn.seq;
        }
        if (['cli-exit', 'cli-unknown', 'cli-gone', 'exit-after-done'].some(has) || (status?.state === 'idle_grace' && has('grace-quiet-gone')) || (has('cli-blocked') && has('blocked-quiet-gone'))) {
          if (['cli-exit', 'cli-unknown', 'cli-gone', 'exit-after-done'].some(has)) { try { fs.unlinkSync(report); } catch {} }
          const pidFile = join(env.HOME, 'fake-agent-pid');
          if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile)), 'SIGKILL'); } catch {} }
          push(client, 'unknown'); continue;
        }
        if (has('quiet-hold')) state = fs.readFileSync(join(env.HOME, 'quiet-hold'), 'utf8').trim();
        if (status?.state === 'idle_grace' && has('grace-quiet')) state = fs.readFileSync(join(env.HOME, 'grace-quiet'), 'utf8').trim();
        if (client.state !== state) push(client, state);
      }
    }, 20);
    t.after(() => { clearInterval(simulation); for (const client of subscribers) client.socket.destroy(); cliSocket.close(); });
  }
  async function call(name, args = {}) {
    if (name === 'hud_create') {
      const roleFile = join(env.HUD_HOME, 'roles', `${args.role}.json`);
      let role;
      try { role = JSON.parse(fs.readFileSync(roleFile)); } catch {}
      if (['grok', 'agy', 'claude', 'codex'].includes(args.on) || role?.harness === 'cli' || role?.run?.some((place) => place.harness === 'cli')) {
        if (args.role === 'imp' && !role) {
          fs.mkdirSync(join(env.HUD_HOME, 'roles'), { recursive: true });
          const imp = JSON.parse(fs.readFileSync(resolve('packages/hud-mcp/roles/imp.json')));
          fs.writeFileSync(roleFile, JSON.stringify({ ...imp, idle_grace_s: 40 }));
        }
        await startCliSocket();
      }
    }
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
    socketRequests,
    push: (id, state) => { for (const client of subscribers) if (client.id === id) push(client, state); },
    drop: () => { for (const client of subscribers) client.socket.destroy(); },
    dropWorker: (id) => { for (const client of subscribers) if (client.id === id) client.socket.destroy(); },
    closeTab: () => { for (const client of subscribers) client.socket.write(JSON.stringify({ event: 'tab_closed', data: { tab_id: 'w4E:t2', workspace_id: 'w4E' } }) + '\n'); },
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

async function until(check, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, 'condition did not settle');
    await new Promise((done) => setTimeout(done, 20));
  }
}

test('supervisor events: report then long summary, flapping, explicit continuation and rewritten report', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'event-cli', 4);
  const job = await f.call('hud_create', { role: 'event-cli', request_key: 'events', task: 'Synthetic event sequences.' });
  await until(() => cliState(job.task_dir)?.pid);
  fs.writeFileSync(join(job.task_dir, 'report.md'), 'Report before the long summary.\n');
  await new Promise((r) => setTimeout(r, 750));
  assert.equal(cliState(job.task_dir).state, 'working');
  assert.equal(cliState(job.task_dir).quiet_decision, undefined);
  f.push(job.job, 'done');
  // One virtual second per flap. No advisory event may create/re-baseline a turn.
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 50));
    f.push(job.job, i % 2 ? 'done' : 'working');
  }
  assert.equal(cliState(job.task_dir).state, 'working');
  await until(() => cliState(job.task_dir)?.state === 'idle_grace');
  assert.equal(cliState(job.task_dir).output_written, true);
  assert.equal(cliState(job.task_dir).quiet_decision, undefined);
  const first = JSON.parse(fs.readFileSync(join(job.task_dir, 'turn.json')));
  const sent = await f.call('hud_send', { job: job.job, message_key: 'continue', text: 'Synthetic continuation.' });
  assert.equal(sent.sent, true);
  const second = JSON.parse(fs.readFileSync(join(job.task_dir, 'turn.json')));
  assert.equal(second.seq, first.seq + 1);
  assert.match(second.report_sig, /:/);
  await until(() => cliState(job.task_dir)?.state === 'working');
  await f.call('hud_send', { job: job.job, message_key: 'continue', text: 'Synthetic retry.' });
  assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'turn.json'))).seq, second.seq);
  fs.writeFileSync(join(job.task_dir, 'report.md'), 'Report before the long summary.\n'); // same bytes, new signature
  await until(() => cliState(job.task_dir)?.state === 'idle_grace');
  assert.equal(cliState(job.task_dir).output_written, true);
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[2] === 'w4E:p1'), false);
  assert.equal(f.commands().some((c) => c.args[1] === 'wait' && c.args.includes('blocked')), false);
});

test('supervisor events: done with background tests stays working; report settles even with child alive', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const marker = join(f.env.HOME, 'child-ready');
  const worker = spawn(process.execPath, ['-e', `const fs = require('node:fs'); const {spawn} = require('node:child_process'); let child; process.on('SIGUSR1', () => { child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']); fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid)); }); process.on('SIGTERM', () => { child?.kill('SIGKILL'); process.exit(); }); setInterval(()=>{},1000);`], { stdio: 'ignore' });
  t.after(() => worker.kill('SIGTERM'));
  fs.writeFileSync(join(f.env.HOME, 'cli-pid'), String(worker.pid));
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'background-events', 1, false);
  const job = await f.call('hud_create', { role: 'background-events', request_key: 'background-events', task: 'Synthetic background work.' });
  await until(() => cliState(job.task_dir)?.pid === worker.pid);
  worker.kill('SIGUSR1');
  await until(() => fs.existsSync(marker));
  f.push(job.job, 'done');
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(cliState(job.task_dir).state, 'working');
  assert.equal(cliState(job.task_dir).quiet_decision, undefined);
  fs.writeFileSync(join(job.task_dir, 'report.md'), 'Report while tests finish.\n');
  await until(() => cliState(job.task_dir)?.state === 'idle_grace');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(cliState(job.task_dir).state, 'idle_grace', 'child holds quit, not report settlement');
  assert.equal(f.commands().some((c) => c.args[3] === '/quit'), false);
  process.kill(Number(fs.readFileSync(marker)), 'SIGKILL');
  f.push(job.job, 'done');
  await until(() => cliState(job.task_dir)?.state === 'closed');
  assert.equal(cliState(job.task_dir).output_written, true);
});

test('supervisor events: 60s at rest means zero spawns and zero STATUS writes; socket loss stays working', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'rest-events', 10);
  const job = await f.call('hud_create', { role: 'rest-events', request_key: 'rest-events', task: 'Synthetic rest.' });
  await until(() => cliState(job.task_dir)?.agent_session_id);
  await new Promise((r) => setTimeout(r, 100));
  const writes = fs.readFileSync(join(f.env.HOME, 'status-writes'), 'utf8');
  const commands = f.commands().length, requests = f.socketRequests.length;
  for (let i = 0; i < 6; i++) {
    f.push(job.job, i % 2 ? 'working' : 'done');
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(fs.readFileSync(join(f.env.HOME, 'status-writes'), 'utf8'), writes, 'no-report status flaps do not write STATUS');
  assert.equal(fs.existsSync(join(f.env.HOME, 'proc-scans')), false, 'flaps never sample descendants');
  await new Promise((r) => setTimeout(r, 3100)); // >60 virtual seconds, two real safety ticks
  assert.equal(f.commands().length, commands);
  assert.equal(f.socketRequests.length, requests);
  assert.equal(fs.existsSync(join(f.env.HOME, 'proc-scans')), false, 'working ticks never sample descendants');
  assert.equal(fs.readFileSync(join(f.env.HOME, 'status-writes'), 'utf8'), writes);
  assert.equal(cliState(job.task_dir).state, 'working');
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  f.drop();
  await new Promise((r) => setTimeout(r, 3100));
  assert.equal(cliState(job.task_dir).state, 'working');
  assert.equal(cliState(job.task_dir).error, null);
  assert.equal(f.commands().length, commands);
});

test('supervisor edges: stalled submission stays supervised; pre-input rejection closes its tab', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  fs.writeFileSync(join(f.env.HOME, 'stalled-prompt'), '');
  const live = await f.call('hud_create', { role: 'imp', on: 'agy', request_key: 'stalled', task: 'Synthetic stall.' });
  assert.notEqual(live.ok, false);
  await until(() => cliState(live.task_dir)?.state === 'working');
  assert.equal(JSON.parse(fs.readFileSync(join(live.task_dir, 'turn.json'))).seq, 1);
  assert.ok(fs.existsSync(join(live.task_dir, 'supervisor.pid')));
  assert.equal(f.commands().some((c) => c.args[0] === 'tab' && c.args[1] === 'close'), false);
  fs.unlinkSync(join(f.env.HOME, 'stalled-prompt'));
  fs.writeFileSync(join(f.env.HOME, 'rejected-prompt'), '');
  const rejected = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'rejected', task: 'Synthetic rejection.' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'dispatch_failed');
  assert.equal(fs.existsSync(join(rejected.task_dir, 'supervisor.pid')), false);
  assert.ok(f.commands().some((c) => c.args[0] === 'tab' && c.args[1] === 'close'));
});

test('supervisor edges: outage with a report settles at 60s, PID death closes with report or fails without quota scans', { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'outage-events', 10);
  const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => worker.kill('SIGKILL'));
  fs.writeFileSync(join(f.env.HOME, 'cli-pid'), String(worker.pid));
  const job = await f.call('hud_create', { role: 'outage-events', request_key: 'outage-report', task: 'Synthetic outage.' });
  await until(() => cliState(job.task_dir)?.pid === worker.pid);
  fs.writeFileSync(join(job.task_dir, 'report.md'), 'Report survives a socket outage.\n');
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  f.drop();
  await until(() => cliState(job.task_dir)?.state === 'idle_grace', 5000);
  assert.equal(cliState(job.task_dir).output_written, true);
  worker.kill('SIGKILL');
  await until(() => cliState(job.task_dir)?.state === 'closed', 3000);
  assert.equal(cliState(job.task_dir).exit_reason, 'settled');
  fs.unlinkSync(join(f.env.HOME, 'herdr-errors'));
  const worker2 = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => worker2.kill('SIGKILL'));
  fs.writeFileSync(join(f.env.HOME, 'cli-pid'), String(worker2.pid));
  const failed = await f.call('hud_create', { role: 'outage-events', request_key: 'no-report-death', task: 'Task text says quota but that is not a quota fact.' });
  await until(() => cliState(failed.task_dir)?.pid === worker2.pid);
  fs.writeFileSync(join(f.env.HOME, 'pane-read'), 'quota exceeded');
  worker2.kill('SIGKILL');
  await until(() => cliState(failed.task_dir)?.state === 'failed', 3000);
  assert.equal(cliState(failed.task_dir).exit_reason, 'worker exited');
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'exhausted.json')), false);
  assert.equal(f.commands().filter((c) => c.args[0] === 'pane' && c.args[1] === 'read').length, 2, 'only the two dispatch trust reads, no exit scan');
});

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
  assert.equal(job.ok, false);
  assert.equal(job.code, 'dispatch_failed');
  assert.match(job.reason, /synthetic start failed/);
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

test('model-supplied pi_args cannot override the inherited caller notification binding', async (t) => {
  const f = await fixture(t);
  for (const pi_args of [
    ['--orchestrator', 'wBAD:p99'],
    ['--orchestrator=wBAD:p99'],
    ['--notify', 'fake command'],
    ['--notify=fake command'],
  ]) {
    const result = await f.call('hud_create', {
      role: 'imp',
      request_key: 'reserved-' + pi_args[0],
      task: 'Synthetic task',
      pi_args,
    });
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
  const f = await fixture(
    t,
    true,
    `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync;
fs.openSync = function(path, ...args) {
  if (/\\/(report\\.md|qa\\/q\\d+\\.md)$/.test(String(path)))
    fs.appendFileSync(process.env.HOME + '/reads', String(path) + '\\n');
  return open.call(this, path, ...args);
};
syncBuiltinESMExports();`
  );
  const job = 'j0000000000000001',
    dir = join(f.env.HUD_HOME, 'jobs', job);
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  const receipt = { job, role: 'imp', created_at: '2026-01-01', dispatch_exit_code: 0, stderr_tail: '' };
  const save = () => fs.writeFileSync(join(dir, 'job.json'), JSON.stringify(receipt));
  const status = (state) => fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state, exit_reason: null }));
  const reads = () =>
    fs.existsSync(join(f.env.HOME, 'reads'))
      ? fs.readFileSync(join(f.env.HOME, 'reads'), 'utf8').trim().split('\n')
      : [];
  const read = (wait_ms = 0) => f.call('hud_read', { job, wait_ms });
  save();
  status('working');
  fs.writeFileSync(join(dir, 'report.md'), 'r'.repeat(65537));
  fs.writeFileSync(join(dir, 'qa', 'q1.md'), 'Synthetic question.');
  assert.equal((await f.call('hud_read')).jobs[0].state, 'working');
  assert.deepEqual(reads(), []);
  const question = await read();
  assert.deepEqual(question.questions, [{ id: 'q1', text: 'Synthetic question.' }]);
  await f.call('hud_respond', { job, request_id: 'q1', answer: 'Synthetic answer.' });
  const before = reads().length,
    waiting = read(1100);
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
  for (const [state, display_state] of [
    ['idle_grace', 'done'],
    ['closed', 'done'],
    ['failed', 'failed'],
    ['stopped', 'stopped'],
    [null, 'working'],
  ]) {
    save();
    status('working');
    const pending = read(700);
    const timer = setTimeout(() => (state === null ? fs.unlinkSync(join(dir, 'STATUS.json')) : status(state)), 100);
    t.after(() => clearTimeout(timer));
    assert.deepEqual(await pending, { ...timeout, state, display_state });
    assert.equal(Boolean(JSON.parse(fs.readFileSync(join(dir, 'job.json'))).read_at), state !== null);
  }
  receipt.dispatch_exit_code = 1;
  save();
  assert.deepEqual(await read(), { ...timeout, state: 'failed', display_state: 'failed', dispatch_exit_code: 1 });
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
  const place = {
    harness: 'pi',
    pi_role: 'implementer',
    split: false,
    model: 'synthetic/override',
    thinking: 'high',
  };
  assert.deepEqual(
    roster.roles.find((entry) => entry.role === role.role),
    {
      ...role,
      instructions: 'implementer',
      run: [place],
      runs_on: place,
      exhausted: [],
      accepts_options: ['on', 'model', 'thinking', 'lens', 'mcp', 'tps', 'ui_ext', 'skills', 'split', 'pi_args'],
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
      instructions: 'architect',
      source_file: resolve('packages/hud-mcp/roles/architect.json'),
      model: null,
      thinking: null,
      model_source: null,
      thinking_source: null,
      pi_role_file: null,
      accepts_options: ['on', 'model', 'thinking', 'lens', 'mcp', 'tps', 'ui_ext', 'skills', 'split', 'pi_args'],
      harness: 'pi',
      pi_role: 'architect',
      split: false,
      can_continue: false,
      available: true,
      run: [{ harness: 'pi', pi_role: 'architect', split: false }],
      runs_on: { harness: 'pi', pi_role: 'architect', split: false },
      exhausted: [],
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
  const f = await fixture(t);
  await f.call('hud_create', {
    role: 'imp',
    request_key: 'synthetic-resume',
    task: 'Continue synthetic history',
    pi_args: ['--session', '11111111-2222-4333-8444-555555555555'],
  });
  const start = f.commands().find((c) => c.args[0] === 'agent' && c.args[1] === 'start').args;
  assert.deepEqual(start.slice(-2), ['--session', '11111111-2222-4333-8444-555555555555']);
  assert.equal(start.includes('--session-dir'), false);
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
    assert.match(fs.readFileSync(join(job.task_dir, 'SESSION.txt'), 'utf8'), enabled ? /^RIGHT=$/m : /^RIGHT=w4E:p3$/m);
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
  assert.deepEqual((await f.call('hud_roster')).roles.find((r) => r.role === 'pro').accepts_options, ['on']);
  for (const key of keys) {
    const value = key === 'pi_args' ? ['--tools', 'read'] : false;
    assert.deepEqual(
      await f.call('hud_create', { role: 'pro', request_key: 'jev-launch', task: 'Synthetic.', [key]: value }),
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
        role: 'pro',
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
  const args = { role: 'pro', request_key: 'pro-once', task: 'Synthetic question.' };
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
          args[0] === 'tab' && args.includes('--no-focus') && args[args.indexOf('--workspace') + 1] === 'w4E'
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
          args[3] === `[pro@${job.job}] DONE ${job.task_dir}/report.md`
      )
  );
  const state = JSON.parse(fs.readFileSync(join(job.task_dir, 'STATUS.json')));
  assert.equal(state.state, 'closed');
  assert.equal(state.harness, 'bro');
  assert.equal(state.provider, 'openai');
  assert.equal(workerFor(f, job.job).harness, 'bro');
  assert.match(cardText(workerFor(f, job.job)), /pro.*Synthetic question/);
  assert.equal(state.output_written, true);
  assert.equal(state.exit_reason, 'settled');
  assert.equal((await f.call('hud_read', { job: job.job })).report, 'Synthetic Jev answer.');
  assert.equal(
    (await f.call('hud_send', { job: job.job, message_key: 'no-send', text: 'Synthetic follow-up.' })).code,
    'not_continuable'
  );
  assert.equal((await f.call('hud_roster')).roles.find(({ role }) => role === 'pro').can_continue, false);
  assert.equal((await f.call('hud_close', { job: job.job })).exit_code, 0);
  assert.deepEqual(f.commands().at(-1), { command: 'pi-role-reap', args: [job.task_dir] });
  for (const args of [
    { role: 'pro', on: 'gemini', request_key: 'gemini', task: 'Synthetic request.' },
    { role: 'pro', on: 'argon', request_key: 'argon', task: 'Synthetic request.' },
    { role: 'flow', request_key: 'flow', task: 'Synthetic request.' },
  ]) {
    const other = await f.call('hud_create', args);
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
    const job = await f.call('hud_create', { role: 'flow', kind: 'video', request_key: key, task });
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
  assert.equal(runningVerb('oracle', 'bro'), 'asking web');
  assert.equal(runningVerb('pro', 'bro'), 'asking web');
  assert.equal(runningVerb('flow', 'bro'), 'generating');
  assert.equal(runningVerb('sonic', 'pi'), 'working');
  assert.equal(runningVerb('grok-imp', 'cli'), 'build');
});

const cliStatusKeys = [
  'version',
  'task_dir',
  'slot',
  'harness',
  'agent',
  'role',
  'model',
  'thinking',
  'state',
  'output_path',
  'output_written',
  'pid',
  'pid_start_time',
  'agent_session_id',
  'started_at',
  'settled_at',
  'idle_deadline_at',
  'ended_at',
  'exit_reason',
  'error',
  'updated_at',
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
  assert.deepEqual(cliKinds.agy.model('gemini-4-hydrogen-high'), ['--model', 'gemini-4-hydrogen-high']);
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
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  const customCli = join(f.env.HUD_HOME, 'roles', 'cli-check.json');
  fs.writeFileSync(
    customCli,
    JSON.stringify({ role: 'cli-check', harness: 'cli', agent: 'grok', model: 'grok-4.7', thinking: 'high', can_continue: true })
  );
  const roster = (await f.call('hud_roster')).roles;
  for (const deleted of ['grok-imp', 'agy-imp', 'claude-imp', 'codex-imp', 'argon', 'gemini', 'flow-video']) {
    assert.equal(roster.some((entry) => entry.role === deleted), false, deleted);
  }
  const role = roster.find((entry) => entry.role === 'cli-check');
  assert.equal(role.harness, 'cli');
  assert.equal(role.agent, 'grok');
  assert.equal(role.model, 'grok-4.7');
  assert.equal(role.thinking, 'high');
  assert.equal(role.can_continue, true);
  assert.deepEqual(role.accepts_options, ['on', 'model', 'thinking']);
  assert.equal(role.pi_role_file, null);
  const imp = roster.find((entry) => entry.role === 'imp');
  // Shipped roles run on pi only; fallbacks are the owner's choice under $HUD_HOME.
  assert.deepEqual(imp.run.map((place) => place.harness), ['pi']);
  const reviewer = roster.find((entry) => entry.role === 'reviewer');
  assert.deepEqual(reviewer.run.map((place) => place.harness), ['pi']);
  fs.unlinkSync(customCli);
  const bad = async (body) => {
    fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
    const path = join(f.env.HUD_HOME, 'roles', 'bad.json');
    fs.writeFileSync(path, JSON.stringify(body));
    const roster = await f.call('hud_roster');
    assert.equal(
      roster.roles.some((entry) => entry.role === 'imp'),
      true
    );
    assert.deepEqual(roster.invalid, [{ path, reason: 'bad cli fields' }]);
    assert.equal(JSON.stringify(roster.invalid).includes('not-an-array'), false);
  };
  await bad({ role: 'bad', harness: 'cli', agent: 'nope', can_continue: true });
  await bad({ role: 'bad', harness: 'cli', agent: 'grok' });
  await bad({ role: 'bad', harness: 'cli', agent: 'grok', can_continue: true, idle_grace_s: -1 });
  await bad({ role: 'bad', harness: 'cli', agent: 'grok', can_continue: true, args: 'not-an-array' });
  fs.unlinkSync(join(f.env.HUD_HOME, 'roles', 'bad.json'));
  const cleared = await f.call('hud_roster');
  assert.equal(
    cleared.roles.some((entry) => entry.role === 'imp'),
    true
  );
  assert.deepEqual(cleared.invalid, []);
});

test('a bad role file is skipped; roster and create name it without dropping other roles', async (t) => {
  const f = await fixture(t);
  const rolesDir = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(rolesDir, { recursive: true });
  const writer = { role: 'synthetic-writer', harness: 'pi', pi_role: 'implementer', split: false, can_continue: true };
  fs.writeFileSync(join(rolesDir, 'writer.json'), JSON.stringify(writer));
  const badPath = join(rolesDir, 'bad.json');
  const secret = 'SECRET_ROLE_FILE_BODY_MUST_NOT_LEAK';
  const cases = [
    [`{${secret}`, 'unparseable JSON', null],
    [JSON.stringify({ role: 'bad', harness: 'browser' }), 'unknown harness browser', 'bad'],
    [JSON.stringify({ role: 'bad', harness: secret }), 'unknown harness invalid', 'bad'],
    [JSON.stringify({ harness: 'pi', note: secret }), 'missing role', null],
    [JSON.stringify({ role: 'bad', harness: 'pi', split: false, can_continue: true }), 'bad pi fields', 'bad'],
    [JSON.stringify({ role: 'bad', harness: 'cli', agent: 'nope', can_continue: true }), 'bad cli fields', 'bad'],
    [JSON.stringify({ role: 'bad', harness: 'jev', tool: 'jev-ask' }), 'bad bro fields', 'bad'],
    [
      JSON.stringify({
        role: 'bad',
        harness: 'pi',
        pi_role: 'implementer',
        split: false,
        can_continue: true,
        model: 1,
      }),
      'bad model/thinking/effort',
      'bad',
    ],
  ];
  for (const [body, reason, roleName] of cases) {
    fs.writeFileSync(badPath, body);
    const roster = await f.call('hud_roster');
    assert.equal(
      roster.roles.some((entry) => entry.role === 'imp'),
      true,
      reason
    );
    assert.equal(
      roster.roles.some((entry) => entry.role === 'synthetic-writer'),
      true,
      reason
    );
    assert.deepEqual(roster.invalid, [{ path: badPath, reason }], reason);
    assert.equal(JSON.stringify(roster.invalid).includes(secret), false, reason);
    assert.deepEqual(
      await f.call('hud_create', { role: roleName ?? 'bad', request_key: `bad-${reason}`, task: 'Synthetic task.' }),
      roleName ? { ok: false, code: 'role_unavailable', path: badPath } : { ok: false, code: 'role_unavailable' },
      reason
    );
  }
  assert.deepEqual(
    await f.call('hud_create', { role: 'missing-entirely', request_key: 'none', task: 'Synthetic task.' }),
    {
      ok: false,
      code: 'role_unavailable',
    }
  );
  assert.deepEqual(await f.call('hud_read'), { jobs: [] });
  fs.writeFileSync(join(rolesDir, 'imp.json'), '{');
  const kept = await f.call('hud_roster');
  assert.equal(
    kept.roles.find((entry) => entry.role === 'imp').source_file,
    resolve('packages/hud-mcp/roles/imp.json')
  );
  assert.ok(
    kept.invalid.some((item) => item.path === join(rolesDir, 'imp.json') && item.reason === 'unparseable JSON')
  );
  fs.writeFileSync(badPath, secret);
  fs.chmodSync(badPath, 0);
  const blocked = await f.call('hud_roster');
  assert.ok(blocked.invalid.some((item) => item.path === badPath && item.reason === 'unreadable'));
  assert.equal(JSON.stringify(blocked).includes(secret), false);
  assert.equal(
    blocked.roles.some((entry) => entry.role === 'imp'),
    true
  );
  fs.chmodSync(badPath, 0o600);
});

test(
  'a grok role runs a brief through idle grace and the watcher reaps the closed tab',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const job = await f.call('hud_create', {
      role: 'imp',
      on: 'grok',
      request_key: 'grok-life',
      task: 'Synthetic grok task.',
    });
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
    assert.match(prompt, /instructions\/implementer\.md/);
    assert.match(prompt, /brief\.md/);
    assert.match(prompt, /do exactly what the brief asks/);
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
    assert.equal(f.commands().some((c) => c.args[1] === 'wait' && c.args.includes('blocked')), false);
    assert.ok(f.socketRequests.some((req) => req.method === 'agent.get'));
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
    assert.match(cardText(workerFor(f, job.job)), /\bimp\b/);
    assert.match(cardText(workerFor(f, job.job)), /Synthetic grok report/);
    await until(() => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at);
    assert.ok(f.commands().some((c) => c.command === 'pi-role-reap' && c.args[0] === job.task_dir));
  }
);

test('cli launch accepts model and thinking overrides and refuses pi-only switches', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  for (const [key, value] of [
    ['pi_args', ['--tools', 'read']],
    ['lens', true],
  ])
    assert.deepEqual(
      await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'reject-' + key, task: 'Synthetic.', [key]: value }),
      { ok: false, code: 'invalid_arguments' }
    );
  assert.deepEqual(f.commands(), []);
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
    role: 'imp',
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
  await until(() => {
    const file = join(job.task_dir, 'STATUS.json');
    return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).state === 'closed';
  });
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
  await until(() => {
    const file = join(plain.task_dir, 'STATUS.json');
    return fs.existsSync(file) && ['closed', 'failed'].includes(JSON.parse(fs.readFileSync(file, 'utf8')).state);
  });
});

test('a grok trust dialog is declined and the job fails naming the directory', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'trust-dialog'), '');
  const args = { role: 'imp', on: 'grok', request_key: 'grok-trust', task: 'Synthetic trust.' };
  const job = await f.call('hud_create', args);
  const status = JSON.parse(fs.readFileSync(join(job.task_dir, 'STATUS.json'), 'utf8'));
  const cwd = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8')).cwd;
  assert.equal(job.ok, false);
  assert.equal(job.code, 'dispatch_failed');
  assert.equal(job.reason, `grok has not trusted ${cwd}; run hud trust ${cwd}`);
  assert.deepEqual(await f.call('hud_create', args), job);
  assertCliStatus(status, job.task_dir);
  assert.equal(status.state, 'failed');
  assert.equal(status.error, `grok has not trusted ${cwd}; run hud trust ${cwd}`);
  assert.equal(status.exit_reason, status.error);
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

function writeCliRole(f, role, idle_grace_s = 1, can_continue = true) {
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'roles', `${role}.json`),
    JSON.stringify({ role, harness: 'cli', agent: 'grok', model: 'grok-4.7', thinking: 'high', can_continue, idle_grace_s: idle_grace_s * 20 })
  );
}

test('done without report keeps the job open and a later report settles it', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'short-cli', 4, true);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  const job = await f.call('hud_create', { role: 'short-cli', request_key: 'grok-missing', task: 'Synthetic missing.' });
  await until(() => cliState(job.task_dir)?.state === 'working' && cliState(job.task_dir)?.pid);
  assertCliStatus(cliState(job.task_dir), job.task_dir);
  assert.equal(cliState(job.task_dir).output_written, false);
  assert.equal(cliState(job.task_dir).reason, null);
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'), false);
  assert.equal(f.commands().filter((c) => c.args[1] === 'prompt').length, 1);
  // done -> working -> done + report
  fs.unlinkSync(join(f.env.HOME, 'missing-report'));
  fs.writeFileSync(join(f.env.HOME, 'wake-turn'), '');
  await until(() => cliState(job.task_dir)?.state === 'closed', 8000);
  const closed = cliState(job.task_dir);
  assert.equal(closed.exit_reason, 'settled');
  assert.equal(closed.output_written, true);
  assert.equal(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'), 'Synthetic grok report.\n');
  // A report written directly while done (without a self-wake) also settles the turn.
  fs.unlinkSync(join(f.env.HOME, 'wake-turn'));
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  const job2 = await f.call('hud_create', { role: 'short-cli', request_key: 'grok-late-report', task: 'Synthetic late report.' });
  await until(() => cliState(job2.task_dir)?.state === 'working' && cliState(job2.task_dir)?.pid);
  fs.writeFileSync(join(job2.task_dir, 'report.md'), 'Synthetic direct report.\n');
  await until(() => cliState(job2.task_dir)?.state === 'closed', 8000);
  assert.equal(cliState(job2.task_dir).output_written, true);
});

function cliState(dir) {
  const file = join(dir, 'STATUS.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function graceArmed(env, dir) {
  const seen = join(env.HOME, 'seen-grace.json');
  return (
    cliState(dir)?.state === 'idle_grace' &&
    fs.existsSync(seen) &&
    fs.readFileSync(seen, 'utf8').includes(dir.split('/').at(-1))
  );
}

test("a cli continuation in grace is judged against the report at that turn's start", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-grace'), '');
  const job = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'grok-cont',
    task: 'Synthetic continuation.',
  });
  await until(() => graceArmed(f.env, job.task_dir), 5000);
  const sent = await f.call('hud_send', { job: job.job, message_key: 'more', text: 'Synthetic continuation.' });
  assert.equal(sent.sent, true);
  assert.equal(sent.queued, undefined);
  await until(() => fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8').includes('two'), 5000);
  await until(
    () => cliState(job.task_dir)?.state === 'idle_grace' && cliState(job.task_dir)?.output_written === true,
    5000
  );
});

test('an unchanged cli report after continuation stays open without failing', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'short-cont', 1, true);
  fs.writeFileSync(join(f.env.HOME, 'hold-grace'), '');
  fs.writeFileSync(join(f.env.HOME, 'unchanged-report'), '');
  const job = await f.call('hud_create', { role: 'short-cont', request_key: 'grok-same', task: 'Synthetic same.' });
  await until(() => graceArmed(f.env, job.task_dir), 5000);
  await f.call('hud_send', { job: job.job, message_key: 'same', text: 'Synthetic continuation.' });
  await until(() => cliState(job.task_dir)?.state === 'working' && cliState(job.task_dir)?.output_written === false, 5000);
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', 5000);
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'), false);
  fs.writeFileSync(join(job.task_dir, 'report.md'), 'Synthetic grok report two.\n');
  await until(() => cliState(job.task_dir)?.state === 'idle_grace' && cliState(job.task_dir)?.output_written === true, 5000);
});

test('a live background child keeps the job busy until it ends', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'bg-cli', 1, false);
  const childPidFile = join(f.env.HOME, 'bg-child-pid');
  const helperReady = join(f.env.HOME, 'helper-ready');
  const fakeCli = spawn(
    process.execPath,
    [
      '-e',
      `const { spawn } = require('node:child_process');
       const fs = require('node:fs');
       const helper = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)']);
       let bg = null;
       process.on('SIGUSR1', () => {
         bg = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)']);
         fs.writeFileSync(${JSON.stringify(childPidFile)}, String(bg.pid));
       });
       process.on('SIGUSR2', () => {
         if (bg) bg.kill('SIGKILL');
       });
       process.on('SIGTERM', () => {
         helper.kill('SIGKILL');
         if (bg) bg.kill('SIGKILL');
         process.exit(0);
       });
       fs.writeFileSync(${JSON.stringify(helperReady)}, String(helper.pid));
       setInterval(()=>{}, 1000);`,
    ],
    { stdio: 'ignore' }
  );
  t.after(() => { try { fakeCli.kill('SIGTERM'); } catch {} });
  await until(() => fs.existsSync(helperReady));
  fs.writeFileSync(join(f.env.HOME, 'cli-pid'), String(fakeCli.pid));
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  const notices = () =>
    f.commands().filter((c) => c.args[1] === 'prompt' && String(c.args.at(-1)).includes('quiet without a report'));
  const job = await f.call('hud_create', { role: 'bg-cli', request_key: 'bg-child', task: 'Synthetic bg child.' });
  await until(() => cliState(job.task_dir)?.pid === fakeCli.pid);
  fakeCli.kill('SIGUSR1');
  await until(() => fs.existsSync(childPidFile));
  fs.writeFileSync(join(f.env.HOME, 'release-turn'), '');
  await new Promise((done) => setTimeout(done, 1300));
  assert.equal(cliState(job.task_dir).state, 'working');
  assert.equal(notices().length, 0);
  fakeCli.kill('SIGUSR2');
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', 5000);
  assert.equal(notices().length, 0);
});

test('quiet past grace turns waiting_orchestrator without pane notices and self-wake returns to working', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'quiet-cli', 1, false);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  const notices = () =>
    f.commands().filter((c) => c.args[1] === 'prompt' && String(c.args.at(-1)).includes('quiet without a report'));
  const job = await f.call('hud_create', { role: 'quiet-cli', request_key: 'quiet-grace', task: 'Synthetic quiet grace.' });
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', 5000);
  assert.equal(notices().length, 0);
  const asking = workerFor(f, job.job);
  assert.equal(asking.homeNeedsHuman, true);
  assert.equal(asking.phase, 'asking');
  assert.match(cardText(asking), /quiet without a report/);
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'), false);
  assert.equal(f.commands().filter((c) => c.args[1] === 'prompt' && c.args[2] !== 'w4E:p1').length, 1);
  await new Promise((done) => setTimeout(done, 350));
  assert.equal(notices().length, 0);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  fs.writeFileSync(join(f.env.HOME, 'wake-turn'), '');
  await until(() => cliState(job.task_dir)?.state === 'working' && cliState(job.task_dir)?.reason === null, 5000);
  assert.equal(workerFor(f, job.job).homeNeedsHuman, false);
  fs.unlinkSync(join(f.env.HOME, 'missing-report'));
  fs.writeFileSync(join(f.env.HOME, 'release-turn'), '');
  await until(() => cliState(job.task_dir)?.state === 'closed', 5000);
  assert.equal(notices().length, 0);
});

test('hud_send queues into a working cli job', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const job = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grok-queue', task: 'Synthetic queue.' });
  await until(() => cliState(job.task_dir)?.state === 'working');
  const sent = await f.call('hud_send', { job: job.job, message_key: 'q', text: 'Synthetic addendum.' });
  assert.equal(sent.queued, true);
  assert.equal(sent.sent, true);
  assert.equal(
    f
      .commands()
      .filter((c) => c.args[1] === 'prompt')
      .at(-1)
      .args.at(-1),
    'Synthetic addendum.'
  );
});

test('hud_close stops a working cli job and closes an idle-grace one', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const working = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grok-stop', task: 'Synthetic stop.' });
  await until(() => cliState(working.task_dir)?.state === 'working');
  assert.equal(typeof cliState(working.task_dir).pid, 'number');
  assert.match(cliState(working.task_dir).pid_start_time, /^\d+$/);
  assert.deepEqual(await f.call('hud_close', { job: working.job }), {
    exit_code: 0,
    last_line: 'Synthetic reap complete',
  });
  await until(() => cliState(working.task_dir)?.state === 'stopped');
  assert.equal(cliState(working.task_dir).exit_reason, 'stop requested');
  assert.equal(fs.existsSync(join(working.task_dir, 'STATUS.json.stop-requested')), true);
  fs.unlinkSync(join(f.env.HOME, 'hold-turn'));
  fs.writeFileSync(join(f.env.HOME, 'hold-grace'), '');
  const grace = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grok-close', task: 'Synthetic close.' });
  await until(() => cliState(grace.task_dir)?.state === 'idle_grace');
  await f.call('hud_close', { job: grace.job });
  await until(() => cliState(grace.task_dir)?.state === 'closed');
  assert.equal(cliState(grace.task_dir).exit_reason, 'settled');
  assert.equal(fs.existsSync(join(grace.task_dir, 'STATUS.json.close-requested')), true);
});

test('a cli that exits fails, and a closed tab fails', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'cli-exit'), '');
  const exited = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grok-exit', task: 'Synthetic exit.' });
  await until(() => cliState(exited.task_dir)?.state === 'failed');
  assert.equal(cliState(exited.task_dir).error, 'worker exited');
  fs.unlinkSync(join(f.env.HOME, 'cli-exit'));
  fs.writeFileSync(join(f.env.HOME, 'cli-gone'), '');
  const missing = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grok-gone', task: 'Synthetic gone.' });
  await until(() => cliState(missing.task_dir)?.state === 'failed');
  assert.equal(cliState(missing.task_dir).error, 'worker exited');
});

test('closing a cli job tab fails it', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const job = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grok-tab', task: 'Synthetic tab.' });
  await until(() => cliState(job.task_dir)?.pid);
  f.closeTab();
  await until(() => cliState(job.task_dir)?.exit_reason === 'tab closed');
  assert.equal(cliState(job.task_dir).state, 'failed');
});

test('supervisor preserves the watcher tab-close fact when its own push socket was lost', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'lost-close', 10);
  const job = await f.call('hud_create', { role: 'lost-close', request_key: 'lost-close', task: 'Synthetic tab-close outage.' });
  await until(() => cliState(job.task_dir)?.pid);
  f.dropWorker(job.job);
  f.closeTab();
  await until(() => cliState(job.task_dir)?.exit_reason === 'tab closed');
  fs.writeFileSync(join(job.task_dir, 'report.md'), 'A late report must not overwrite tab closure.\n');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(cliState(job.task_dir).state, 'failed');
  assert.equal(cliState(job.task_dir).exit_reason, 'tab closed');
});

function runAsk(env, args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-ask.mjs'), ...args], {
      env: { ...process.env, PATH: env.PATH, FAKE_LOG: env.FAKE_LOG, HOME: env.HOME, HUD_HOME: env.HUD_HOME },
    });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
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

test(
  'hud-ask round trip notifies the orchestrator and prints the hud_respond answer',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const id = 'j00000000000000a1',
      dir = join(f.env.HUD_HOME, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      join(dir, 'job.json'),
      JSON.stringify({
        job: id,
        role: 'grok-imp',
        cwd: '/synthetic/MyHUD',
        herdr_pane: 'w4E:p1',
        created_at: new Date().toISOString(),
      })
    );
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working', harness: 'cli', agent: 'grok' }));
    fs.writeFileSync(join(dir, 'brief.md'), '# Synthetic ask\n');
    fs.writeFileSync(join(dir, 'SESSION.txt'), 'LEFT=w4E:p2\nORCH=w4E:p1\n');
    const pending = runAsk(f.env, [
      '--dir',
      dir,
      '--question',
      'Which layout?',
      '--option',
      'rows',
      '--option',
      'columns',
      '--default',
      'rows',
      '--context',
      'card width',
      '--timeout',
      '30',
    ]);
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
    assert.match(
      notice.args.at(-1),
      /^\[grok-imp@MyHUD\] QUESTION q1: Which layout\? \| options: rows \/ columns \| default: rows \| full text: /
    );
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
  }
);

test('hud-ask prints the default when no answer arrives', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const id = 'j00000000000000a2',
    dir = join(f.env.HUD_HOME, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    join(dir, 'job.json'),
    JSON.stringify({
      job: id,
      role: 'grok-imp',
      cwd: '/synthetic/MyHUD',
      herdr_pane: 'w4E:p1',
      created_at: new Date().toISOString(),
    })
  );
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'ORCH=w4E:p1\n');
  const result = await runAsk(f.env, [
    '--dir',
    dir,
    '--question',
    'Which layout?',
    '--default',
    'rows',
    '--timeout',
    '1',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /No answer to q1 within 1s \(pushed via "herdr agent prompt w4E:p1"\)\. Proceed with your default: rows\. Record the open question in your report/
  );
  assert.equal(fs.existsSync(join(dir, 'qa', 'q1.md')), true);
});

test('a blocked CLI turn needs the owner once, then returns to working', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'cli-blocked'), '');
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const job = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grok-blocked', task: 'Synthetic blocked.' });
  assert.match(
    fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8'),
    /node ".*\/hud-ask\.mjs" --dir ".*" --question/
  );
  const notices = () =>
    f.commands().filter((c) => c.args[1] === 'prompt' && String(c.args.at(-1)).includes('BLOCKED:'));
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator');
  const blocked = cliState(job.task_dir);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.harness, 'cli');
  assert.equal(notices().length, 0);
  const worker = workerFor(f, job.job);
  assert.equal(worker.homeNeedsHuman, true);
  assert.equal(worker.phase, 'asking');
  assert.equal(worker.ask, 'grok needs input in its pane');
  assert.match(cardText(worker), /grok needs input in its pane/);
  assert.match(cardText(worker), /asking/);
  fs.writeFileSync(join(f.env.HOME, 'release-blocked'), '');
  await until(() => cliState(job.task_dir)?.state === 'working' && cliState(job.task_dir)?.blocked === false, 5000);
  assert.equal(notices().length, 0);
  const resumed = workerFor(f, job.job);
  assert.equal(resumed.homeNeedsHuman, false);
  assert.equal(resumed.ask, undefined);
  fs.writeFileSync(join(f.env.HOME, 'release-turn'), '');
  await until(() => cliState(job.task_dir)?.state === 'closed', 5000);
});

test(
  'an agy role launches without an effort flag, and a startup done does not settle the job',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(join(f.env.HOME, 'startup-done'), '');
    const job = await f.call('hud_create', { role: 'imp', on: 'agy', request_key: 'agy-life', task: 'Synthetic agy task.' });
    const start = f.commands().find((c) => c.args[1] === 'start').args;
    assert.deepEqual(start.slice(start.indexOf('--') + 1), [
      '--model',
      'gemini-4-argon-high',
      '--dangerously-skip-permissions',
    ]);
    assert.equal(start.includes('--effort'), false);
    await until(() => cliState(job.task_dir)?.state === 'closed', 8000);
    const commands = f.commands();
    const promptAt = commands.findIndex((c) => c.args[1] === 'prompt' && c.args[3] !== '/quit');
    assert.ok(promptAt >= 0);
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
  'agent_not_ready runs the trust check for any kind, and a start error without that text is unchanged',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(join(f.env.HOME, 'start-not-ready'), '');
    fs.writeFileSync(join(f.env.HOME, 'trust-dialog'), 'Do you trust the contents of this project?');
    const agy = await f.call('hud_create', { role: 'imp', on: 'agy', request_key: 'agy-trust', task: 'Synthetic trust.' });
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
      role: 'imp',
      on: 'agy',
      request_key: 'agy-not-ready',
      task: 'Synthetic not ready.',
    });
    assert.equal(f.commands().filter((c) => c.args[1] === 'send-keys').length, 1);
    assert.match(cliState(bare.task_dir).exit_reason, /agent_not_ready/);
    assert.equal(fs.existsSync(join(bare.task_dir, 'supervisor.pid')), false);
    fs.writeFileSync(join(f.env.HOME, 'trust-dialog'), '');
    const grok = await f.call('hud_create', {
      role: 'imp',
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

test('a claude role launches with its flags and settles through idle grace', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const job = await f.call('hud_create', {
    role: 'imp',
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
  assert.equal(
    f.commands().some((c) => c.args[1] === 'send-keys'),
    false
  );
});

test(
  'a claude trust dialog is declined with enter and the launch fails with the reason',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(join(f.env.HOME, 'start-not-ready'), '');
    fs.writeFileSync(join(f.env.HOME, 'trust-dialog'), 'Is this a project you created or one you trust?');
    const job = await f.call('hud_create', {
      role: 'imp',
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

test('idle and unknown with a live agent settle only a stable new report', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  for (const status of ['idle', 'unknown']) {
    fs.writeFileSync(join(f.env.HOME, 'quiet-hold'), status);
    const job = await f.call('hud_create', {
      role: 'imp',
      on: 'grok',
      request_key: 'quiet-' + status,
      task: 'Synthetic quiet.',
    });
    await until(() => cliState(job.task_dir)?.state === 'closed', 8000);
    assert.equal(cliState(job.task_dir).error, null);
    assert.equal(cliState(job.task_dir).exit_reason, 'settled');
    assert.equal(f.commands().some((c) => c.args[1] === 'wait' && c.args.includes('blocked')), false);
  }
});

test('unknown while the agent is gone settles the job', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'cli-unknown'), '');
  const job = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'unknown-gone', task: 'Synthetic unknown.' });
  await until(() => cliState(job.task_dir)?.state === 'failed');
  assert.equal(cliState(job.task_dir).error, 'worker exited');
});

test(
  'grace keeps its deadline when idle is not an exit, and unknown with the agent gone leaves',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(join(f.env.HOME, 'grace-quiet'), 'idle');
    const held = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grace-idle', task: 'Synthetic grace.' });
    await until(() => cliState(held.task_dir)?.state === 'closed', 8000);
    assert.equal(f.commands().some((c) => c.args[1] === 'wait' && c.args.includes('blocked')), false);
    assert.equal(cliState(held.task_dir).exit_reason, 'settled');
    assert.equal(cliState(held.task_dir).error, null);
    const seen = JSON.parse(fs.readFileSync(join(f.env.HOME, 'seen-grace.json'), 'utf8'));
    assert.equal(cliState(held.task_dir).idle_deadline_at, seen.idle_deadline_at);
    // A pushed unknown cannot override the /proc exit fact.
    fs.writeFileSync(join(f.env.HOME, 'grace-quiet'), 'unknown');
    fs.writeFileSync(join(f.env.HOME, 'grace-quiet-gone'), '');
    const gone = await f.call('hud_create', {
      role: 'imp',
      on: 'grok',
      request_key: 'grace-gone',
      task: 'Synthetic grace gone.',
    });
    await until(() => cliState(gone.task_dir)?.state === 'closed', 8000);
    assert.equal(cliState(gone.task_dir).exit_reason, 'settled');
    assert.equal(cliState(gone.task_dir).output_written, true);
  }
);

test('a blocked resume treats idle as present and unknown as gone', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'cli-blocked'), '');
  fs.writeFileSync(join(f.env.HOME, 'blocked-quiet'), 'idle');
  const held = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'blocked-idle',
    task: 'Synthetic blocked quiet.',
  });
  await until(() => cliState(held.task_dir)?.state === 'waiting_orchestrator');
  fs.writeFileSync(join(f.env.HOME, 'release-blocked'), '');
  await until(() => cliState(held.task_dir)?.state === 'closed', 8000);
  assert.equal(cliState(held.task_dir).exit_reason, 'settled');
  assert.equal(cliState(held.task_dir).error, null);
  fs.unlinkSync(join(f.env.HOME, 'release-blocked'));
  // A missing worker on blocked resume still fails by its PID.
  fs.writeFileSync(join(f.env.HOME, 'blocked-quiet'), 'unknown');
  fs.writeFileSync(join(f.env.HOME, 'blocked-quiet-gone'), '');
  const gone = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'blocked-gone',
    task: 'Synthetic blocked gone.',
  });
  await until(() => cliState(gone.task_dir)?.state === 'failed', 8000);
  assert.equal(cliState(gone.task_dir).error, 'worker exited');
});

test('a codex role waits out a phantom startup and passes the start timeout', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'phantom-working'), '');
  const job = await f.call('hud_create', {
    role: 'imp',
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
  assert.deepEqual(start.slice(dash + 1), [
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
  assert.equal(
    f.commands().some((c) => c.args[1] === 'send-keys'),
    false
  );
});

test(
  'a cli job records agent_session_id when herdr publishes it after the first get',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(join(f.env.HOME, 'late-session'), '0');
    const job = await f.call('hud_create', {
      role: 'imp',
      on: 'grok',
      request_key: 'late-session',
      task: 'Synthetic late session.',
    });
    await until(() => fs.existsSync(join(f.env.HOME, 'seen-grace.json'))).catch((error) => {
      t.diagnostic(JSON.stringify({ status: cliState(job.task_dir), requests: f.socketRequests }));
      throw error;
    });
    const grace = JSON.parse(fs.readFileSync(join(f.env.HOME, 'seen-grace.json'), 'utf8'));
    assert.equal(grace.state, 'idle_grace');
    assert.equal(grace.agent_session_id, 'synthetic-grok-session');
    await until(() => cliState(job.task_dir)?.state === 'closed');
    assert.equal(cliState(job.task_dir).agent_session_id, 'synthetic-grok-session');
  }
);

test('a failed cli job records agent_session_id published after start, before exit', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'late-session'), '0');
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(join(f.env.HOME, 'exit-after-done'), '');
  const job = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'late-fail', task: 'Synthetic late fail.' });
  await until(() => cliState(job.task_dir)?.state === 'failed');
  assert.equal(cliState(job.task_dir).error, 'worker exited');
  assert.equal(cliState(job.task_dir).agent_session_id, 'synthetic-grok-session');
});

test('hud_roster cwd and hud_create use a registered project role', async (t) => {
  const f = await fixture(t);
  const proj = join(f.root, 'proj');
  fs.mkdirSync(join(proj, 'sub'), { recursive: true });
  assert.equal(spawnSync('git', ['init'], { cwd: proj, encoding: 'utf8' }).status, 0);
  const root = fs.realpathSync(proj);
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'projects.json'),
    JSON.stringify({ version: 1, projects: [{ root, registered_at: '2026-11-13T00:00:00.000Z' }] })
  );
  const role = {
    role: 'frontend',
    harness: 'pi',
    pi_role: 'implementer',
    split: false,
    can_continue: true,
    model: 'project/model',
    thinking: 'low',
    skills: ['to-tickets'],
  };
  fs.mkdirSync(join(proj, '.hud/roles'), { recursive: true });
  fs.writeFileSync(join(proj, '.hud/roles/frontend.json'), JSON.stringify(role));
  fs.writeFileSync(join(proj, '.hud/roles/imp.json'), JSON.stringify({ ...role, role: 'imp', model: 'project/imp' }));
  fs.writeFileSync(
    join(proj, '.hud/roles/cli.json'),
    JSON.stringify({
      role: 'local-cli',
      harness: 'cli',
      agent: 'grok',
      can_continue: true,
      note: 'SECRET_PROJECT_ROLE_BODY',
    })
  );
  fs.writeFileSync(join(proj, '.hud/project.json'), JSON.stringify({ version: 1, roles: ['frontend', 'nope'] }));
  fs.writeFileSync(join(proj, '.hud/hud-convention.md'), 'Project convention only.');
  fs.writeFileSync(join(proj, 'hud-convention.md'), 'Cwd convention must lose.');
  const roster = await f.call('hud_roster', { cwd: join(proj, 'sub') });
  assert.deepEqual(roster.project, { root, registered: true });
  assert.equal(roster.project_config_ignored, undefined);
  assert.equal(roster.roles.find((entry) => entry.role === 'frontend').model, 'project/model');
  assert.equal(
    roster.roles.find((entry) => entry.role === 'frontend').source_file,
    join(root, '.hud/roles/frontend.json')
  );
  assert.deepEqual(roster.roles.find((entry) => entry.role === 'frontend').skills, ['to-tickets']);
  assert.equal(
    roster.roles.some((entry) => entry.role === 'imp'),
    false
  );
  assert.deepEqual(roster.invalid, [{ path: join(root, '.hud/roles/cli.json'), reason: 'project roles are pi only' }]);
  assert.equal(JSON.stringify(roster.invalid).includes('SECRET_PROJECT_ROLE_BODY'), false);
  assert.equal(roster.convention.path, join(root, '.hud/hud-convention.md'));
  assert.equal(roster.convention.text, 'Project convention only.');
  const server = await f.call('hud_roster');
  assert.equal(server.project.registered, false);
  assert.equal(server.project.root, fs.realpathSync(f.root));
  assert.equal(
    server.roles.some((entry) => entry.role === 'frontend'),
    false
  );
  assert.equal(
    server.roles.some((entry) => entry.role === 'imp'),
    true
  );
  const created = await f.call('hud_create', {
    role: 'frontend',
    request_key: 'project-role',
    task: 'Synthetic project task.',
    cwd: proj,
  });
  const receipt = JSON.parse(fs.readFileSync(join(created.task_dir, 'job.json'), 'utf8'));
  assert.equal(receipt.model, 'project/model');
  assert.equal(receipt.cwd, resolve(proj));
  const launch = f.commands().find((entry) => entry.command === 'pi-role').args;
  assert.equal(launch[launch.indexOf('--args-json') + 1], 'implementer');
  assert.equal(launch.includes('--skill'), false);
  assert.deepEqual(
    await f.call('hud_create', { role: 'imp', request_key: 'hidden-imp', task: 'Synthetic task.', cwd: proj }),
    { ok: false, code: 'role_unavailable' }
  );
  const home = await f.call('hud_create', { role: 'imp', request_key: 'home-imp', task: 'Synthetic task.' });
  assert.equal(JSON.parse(fs.readFileSync(join(home.task_dir, 'job.json'), 'utf8')).model, 'synthetic/default');
});

test('an unregistered .hud is ignored and roster says so', async (t) => {
  const f = await fixture(t);
  const proj = join(f.root, 'unreg');
  fs.mkdirSync(join(proj, '.hud/roles'), { recursive: true });
  fs.writeFileSync(
    join(proj, '.hud/roles/frontend.json'),
    JSON.stringify({
      role: 'frontend',
      harness: 'pi',
      pi_role: 'implementer',
      split: false,
      can_continue: true,
      model: 'secret/model',
    })
  );
  fs.writeFileSync(join(proj, '.hud/hud-convention.md'), 'SECRET_CONVENTION');
  const roster = await f.call('hud_roster', { cwd: proj });
  assert.equal(roster.project.registered, false);
  assert.equal(roster.project.root, fs.realpathSync(proj));
  assert.equal(roster.project_config_ignored, fs.realpathSync(proj));
  assert.equal(
    roster.roles.some((entry) => entry.role === 'frontend'),
    false
  );
  assert.equal(JSON.stringify(roster).includes('SECRET_CONVENTION'), false);
  assert.equal(JSON.stringify(roster).includes('secret/model'), false);
  assert.deepEqual(
    await f.call('hud_create', { role: 'frontend', request_key: 'ignored-role', task: 'Synthetic task.', cwd: proj }),
    { ok: false, code: 'role_unavailable' }
  );
});

function skillFlags(argv) {
  const paths = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--skill') paths.push(argv[i + 1]);
  return paths;
}

test('pi dispatch passes role skills and the worker prompt, and records skips', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const proj = join(f.root, 'proj');
  fs.mkdirSync(proj);
  assert.equal(spawnSync('git', ['init'], { cwd: proj, encoding: 'utf8' }).status, 0);
  const root = fs.realpathSync(proj);
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'projects.json'),
    JSON.stringify({ version: 1, projects: [{ root, registered_at: '2026-11-13T00:00:00.000Z' }] })
  );
  const linked = join(f.root, 'skills', 'to-tickets');
  const absolute = join(f.root, 'skills', 'absolute');
  fs.mkdirSync(linked, { recursive: true });
  fs.mkdirSync(absolute);
  fs.mkdirSync(join(root, '.hud', 'skills'), { recursive: true });
  fs.symlinkSync(linked, join(root, '.hud', 'skills', 'to-tickets'));
  fs.symlinkSync(join(f.root, 'skills', 'missing-target'), join(root, '.hud', 'skills', 'gone'));
  const prompt = join(root, '.hud', 'agents', 'frontend.md');
  const promptTarget = join(f.root, 'prompt-target.md');
  fs.mkdirSync(join(root, '.hud', 'agents'), { recursive: true });
  fs.writeFileSync(prompt, 'Synthetic worker prompt.\n');
  fs.writeFileSync(promptTarget, 'Linked worker prompt.\n');
  fs.symlinkSync(promptTarget, join(root, '.hud', 'agents', 'linked.md'));
  fs.symlinkSync(join(f.root, 'missing-prompt.md'), join(root, '.hud', 'agents', 'broken.md'));
  const role = (name, skills) => ({
    role: name,
    harness: 'pi',
    pi_role: 'implementer',
    split: false,
    can_continue: true,
    ...(skills ? { skills } : {}),
  });
  fs.mkdirSync(join(root, '.hud', 'roles'));
  fs.writeFileSync(
    join(root, '.hud', 'roles', 'frontend.json'),
    JSON.stringify(role('frontend', ['to-tickets', 'gone', 'no-such', '../escape', absolute]))
  );
  for (const name of ['plain', 'linked', 'broken'])
    fs.writeFileSync(join(root, '.hud', 'roles', `${name}.json`), JSON.stringify(role(name)));
  fs.writeFileSync(
    join(root, '.hud', 'project.json'),
    JSON.stringify({ version: 1, roles: ['frontend', 'plain', 'linked', 'broken'] })
  );
  const piArgs = ['--tools', 'read'];
  const created = await f.call('hud_create', {
    role: 'frontend',
    request_key: 'skills',
    task: 'Synthetic task.',
    cwd: proj,
    pi_args: piArgs,
  });
  const argv = f.commands().find((entry) => entry.command === 'pi-role').args;
  const dash = argv.indexOf('--');
  const skillAt = argv.indexOf('--skill');
  const promptAt = argv.indexOf('--append-system-prompt');
  assert.deepEqual(skillFlags(argv), [join(root, '.hud', 'skills', 'to-tickets'), absolute]);
  assert.equal(argv[promptAt + 1], prompt);
  assert.ok(dash >= 0 && dash < skillAt && skillAt < promptAt && promptAt < argv.indexOf('--tools'));
  assert.deepEqual(argv.slice(-piArgs.length), piArgs);
  assert.equal(
    argv.some((arg) => arg.includes('..')),
    false
  );
  const expected = {
    role_skills: [
      { name: 'to-tickets', path: join(root, '.hud', 'skills', 'to-tickets') },
      { name: absolute, path: absolute },
    ],
    skipped_skills: [
      { name: 'gone', reason: 'broken' },
      { name: 'no-such', reason: 'missing' },
      { name: '../escape', reason: 'invalid' },
    ],
    worker_prompt: prompt,
  };
  const receipt = JSON.parse(fs.readFileSync(join(created.task_dir, 'job.json'), 'utf8'));
  const read = await f.call('hud_read', { job: created.job });
  for (const value of [receipt, read]) {
    assert.deepEqual(value.role_skills, expected.role_skills);
    assert.deepEqual(value.skipped_skills, expected.skipped_skills);
    assert.equal(value.worker_prompt, expected.worker_prompt);
    assert.deepEqual(value.pi_args, piArgs);
  }
  assert.equal(receipt.dispatch_exit_code, 0);
  assert.equal(read.state, 'working');
  assert.equal(read.skills, undefined);

  const plain = await f.call('hud_create', {
    role: 'plain',
    request_key: 'no-prompt',
    task: 'Synthetic task.',
    cwd: proj,
  });
  const plainArgv = f
    .commands()
    .filter((entry) => entry.command === 'pi-role')
    .at(-1).args;
  assert.equal(plainArgv.includes('--skill'), false);
  assert.equal(plainArgv.includes('--append-system-prompt'), false);
  const plainRead = await f.call('hud_read', { job: plain.job });
  assert.deepEqual(plainRead.role_skills, []);
  assert.deepEqual(plainRead.skipped_skills, []);
  assert.equal(plainRead.worker_prompt, null);

  const linkedJob = await f.call('hud_create', {
    role: 'linked',
    request_key: 'linked-prompt',
    task: 'Synthetic task.',
    cwd: proj,
  });
  const linkedArgv = f
    .commands()
    .filter((entry) => entry.command === 'pi-role')
    .at(-1).args;
  assert.equal(linkedArgv[linkedArgv.indexOf('--append-system-prompt') + 1], join(root, '.hud', 'agents', 'linked.md'));
  assert.equal(
    (await f.call('hud_read', { job: linkedJob.job })).worker_prompt,
    join(root, '.hud', 'agents', 'linked.md')
  );

  const broken = await f.call('hud_create', {
    role: 'broken',
    request_key: 'broken-prompt',
    task: 'Synthetic task.',
    cwd: proj,
  });
  const brokenArgv = f
    .commands()
    .filter((entry) => entry.command === 'pi-role')
    .at(-1).args;
  assert.equal(brokenArgv.includes('--append-system-prompt'), false);
  assert.equal((await f.call('hud_read', { job: broken.job })).worker_prompt, null);
  assert.equal(JSON.parse(fs.readFileSync(join(broken.task_dir, 'job.json'), 'utf8')).dispatch_exit_code, 0);
});

test('STATUS table matches across the panel reader and hud_read', async (t) => {
  const f = await fixture(t);
  const cases = [
    { name: 'working', status: { state: 'working', exit_reason: null }, display: 'working', raw: 'working', reason: null, blocked: false },
    {
      name: 'waiting-quiet',
      status: { state: 'waiting_orchestrator', blocked: false, reason: 'quiet', harness: 'cli' },
      display: 'working',
      raw: 'waiting_orchestrator',
      reason: 'quiet',
      blocked: false,
    },
    {
      name: 'waiting-blocked',
      status: { state: 'waiting_orchestrator', blocked: true, reason: null, harness: 'cli', agent: 'grok' },
      display: 'working',
      raw: 'waiting_orchestrator',
      reason: 'grok needs input in its pane',
      blocked: true,
    },
    { name: 'idle-grace', status: { state: 'idle_grace', exit_reason: 'settled' }, display: 'done', raw: 'idle_grace', reason: 'settled', blocked: false },
    { name: 'closed', status: { state: 'closed', exit_reason: 'settled' }, display: 'done', raw: 'closed', reason: 'settled', blocked: false },
    { name: 'done', status: { state: 'done', exit_reason: 'settled' }, display: 'done', raw: 'done', reason: 'settled', blocked: false },
    { name: 'stopped-empty', status: { state: 'stopped', output_written: false, exit_reason: 'stop requested' }, display: 'stopped', raw: 'stopped', reason: 'stop requested', blocked: false },
    { name: 'stopped-output', status: { state: 'stopped', output_written: true, exit_reason: 'stop requested' }, display: 'done', raw: 'stopped', reason: 'stop requested', blocked: false },
    { name: 'failed', status: { state: 'failed', exit_reason: 'tab closed' }, display: 'failed', raw: 'failed', reason: 'tab closed', blocked: false },
    { name: 'empty-status', status: {}, display: 'working', raw: null, reason: null, blocked: false },
    { name: 'missing-ok', status: null, dispatch_exit_code: 0, display: 'working', raw: null, reason: null, blocked: false },
    { name: 'missing-fail', status: null, dispatch_exit_code: 1, display: 'failed', raw: 'failed', reason: null, blocked: false },
  ];
  const ids = cases.map((entry, idx) => {
    const id = `j${(idx + 1).toString(16).padStart(16, '0')}`;
    const dir = join(f.env.HUD_HOME, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      join(dir, 'job.json'),
      JSON.stringify({
        job: id,
        role: 'imp',
        herdr_pane: 'w4E:p1',
        created_at: new Date(1000 + idx * 1000).toISOString(),
        dispatch_exit_code: entry.dispatch_exit_code ?? 0,
        stderr_tail: '',
      })
    );
    if (entry.status !== null) fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify(entry.status));
    return { id, entry };
  });
  const listed = (await f.call('hud_read')).jobs;
  for (const { id, entry } of ids) {
    const panel = workerFor(f, id);
    const single = await f.call('hud_read', { job: id });
    const row = listed.find((item) => item.job === id);
    assert.equal(panel.state, entry.display, `${entry.name} panel.state`);
    assert.equal(single.display_state, entry.display, `${entry.name} hud_read.display_state`);
    assert.equal(single.state, entry.raw, `${entry.name} hud_read.state`);
    assert.equal(single.reason, entry.reason, `${entry.name} hud_read.reason`);
    assert.equal(single.blocked, entry.blocked, `${entry.name} hud_read.blocked`);
    assert.equal(row.display_state, entry.display, `${entry.name} list.display_state`);
    assert.equal(row.state, entry.raw, `${entry.name} list.state`);
    assert.equal(row.reason, entry.reason, `${entry.name} list.reason`);
    assert.equal(row.blocked, entry.blocked, `${entry.name} list.blocked`);
  }
});

test('hud_read wait_ms wakes on waiting_orchestrator and session changes ride once per response', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const created = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'wait-seed',
    task: 'Seed session cursor without self-reporting create.',
  });
  assert.equal('changes' in created, false);
  const createdStatus = join(created.task_dir, 'STATUS.json');
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(createdStatus) && JSON.parse(fs.readFileSync(createdStatus, 'utf8')).state === 'working') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await f.call('hud_close', { job: created.job });
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(createdStatus) && JSON.parse(fs.readFileSync(createdStatus, 'utf8')).state === 'stopped') break;
    await new Promise((r) => setTimeout(r, 50));
  }

  const writeSyntheticJob = (id, pane, pkg, state) => {
    const dir = join(f.env.HUD_HOME, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      join(dir, 'job.json'),
      JSON.stringify({
        job: id,
        role: 'imp',
        package: pkg,
        herdr_pane: pane,
        created_at: new Date().toISOString(),
        cli: { agent: 'grok' },
        dispatch_exit_code: 0,
        stderr_tail: '',
      })
    );
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state, exit_reason: null }));
    return dir;
  };

  const w1Dir = writeSyntheticJob('j00000000000001a1', 'w4E:p1', '02-wait', 'working');
  await f.call('hud_roster');
  const settledSeed = await f.call('hud_roster');
  assert.equal('changes' in settledSeed, false);

  const waitPromise = f.call('hud_read', { job: 'j00000000000001a1', wait_ms: 5000 });
  await new Promise((r) => setTimeout(r, 80));
  fs.writeFileSync(
    join(w1Dir, 'STATUS.json'),
    JSON.stringify({ state: 'waiting_orchestrator', blocked: false, reason: 'quiet', harness: 'cli' })
  );
  const waited = await waitPromise;
  assert.equal(waited.state, 'waiting_orchestrator');
  assert.equal(waited.blocked, false);
  assert.equal(waited.changes?.length, 1);
  assert.match(waited.changes[0], /^j00000000000001a1 imp 02-wait: waiting_orchestrator \| quiet$/);

  const afterWait = await f.call('hud_roster');
  assert.equal('changes' in afterWait, false);

  const w2Dir = writeSyntheticJob('j00000000000001a2', 'w4E:p1', '02-roster', 'working');
  const foreignDir = writeSyntheticJob('j00000000000001f9', 'w4E:p9', 'foreign-pane', 'working');
  const baseline = await f.call('hud_roster');
  assert.equal(baseline.changes?.length, 1);
  assert.match(baseline.changes[0], /^j00000000000001a2 imp 02-roster: working$/);

  fs.writeFileSync(join(w2Dir, 'STATUS.json'), JSON.stringify({ state: 'waiting_orchestrator', exit_reason: null }));
  fs.writeFileSync(
    join(foreignDir, 'STATUS.json'),
    JSON.stringify({ state: 'waiting_orchestrator', exit_reason: null })
  );

  const roster1 = await f.call('hud_roster');
  assert.equal(roster1.changes?.length, 1);
  assert.match(roster1.changes[0], /^j00000000000001a2 imp 02-roster: waiting_orchestrator\b/);

  const roster2 = await f.call('hud_roster');
  assert.equal('changes' in roster2, false);
});

test('unregistered skill names are skipped and a CLI role is not given skill flags', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const absolute = join(f.root, 'abs-skill');
  fs.mkdirSync(absolute);
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'roles', 'home-skilled.json'),
    JSON.stringify({
      role: 'home-skilled',
      harness: 'pi',
      pi_role: 'implementer',
      split: false,
      can_continue: true,
      skills: ['to-tickets', absolute],
    })
  );
  fs.mkdirSync(join(f.root, '.hud', 'agents'), { recursive: true });
  fs.writeFileSync(join(f.root, '.hud', 'agents', 'home-skilled.md'), 'Must not load.\n');
  const job = await f.call('hud_create', {
    role: 'home-skilled',
    request_key: 'home-skills',
    task: 'Synthetic task.',
    pi_args: ['--tools', 'read'],
  });
  const argv = f.commands().find((entry) => entry.command === 'pi-role').args;
  assert.deepEqual(skillFlags(argv), [absolute]);
  assert.equal(argv.includes('--append-system-prompt'), false);
  assert.ok(argv.indexOf('--') < argv.indexOf('--skill') && argv.indexOf('--skill') < argv.indexOf('--tools'));
  assert.deepEqual(argv.slice(-2), ['--tools', 'read']);
  const read = await f.call('hud_read', { job: job.job });
  assert.deepEqual(read.role_skills, [{ name: absolute, path: absolute }]);
  assert.deepEqual(read.skipped_skills, [{ name: 'to-tickets', reason: 'unresolved' }]);
  assert.equal(read.worker_prompt, null);

  const cli = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'cli-untouched',
    task: 'Synthetic cli task.',
  });
  const receipt = JSON.parse(fs.readFileSync(join(cli.task_dir, 'job.json'), 'utf8'));
  assert.equal(Object.hasOwn(receipt, 'role_skills'), false);
  assert.equal(Object.hasOwn(receipt, 'skipped_skills'), false);
  assert.equal(Object.hasOwn(receipt, 'worker_prompt'), false);
  const start = f.commands().find((entry) => entry.args[1] === 'start' && entry.args[2] === `${cli.job}-primary`);
  assert.equal(start.args.includes('--skill'), false);
  assert.equal(start.args.includes('--append-system-prompt'), false);
  const cliRead = await f.call('hud_read', { job: cli.job });
  assert.equal(Object.hasOwn(cliRead, 'role_skills'), false);
  assert.equal(Object.hasOwn(cliRead, 'skipped_skills'), false);
  assert.equal(Object.hasOwn(cliRead, 'worker_prompt'), false);
});

async function fakeDecisionServer(t, handler) {
  const requests = [];
  const server = createHttpServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const reply = await handler(body, requests.length, req);
      if (reply?.status && reply.status !== 200) {
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply.body ?? { error: 'synthetic error' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const port = server.address().port;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function decisionAnswer(choice, probability, rest = 0.02) {
  const choices = ['still-working', 'finished-no-report', 'failed', 'needs-human'];
  const remainder = Math.max(0, 1 - probability);
  const perOther = remainder / (choices.length - 1);
  return {
    answers: [
      {
        name: 'quiet_job',
        type: 'choice',
        choice,
        probabilities: choices.map((value) => ({ value, probability: value === choice ? probability : perOther })),
        confidence: Math.max(0, probability - rest),
      },
    ],
  };
}

function configureFakeDecision(f, baseUrl, cap = 0) {
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'credentials.env'),
    `OPENAI_API_KEY=synthetic-openai-key\nOPENAI_BASE_URL=${baseUrl}\n`,
    { mode: 0o600 }
  );
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'config.json'),
    JSON.stringify({ decisions: { primary: 'openai', openai: { baseUrl } } }),
    { mode: 0o600 }
  );
  if (cap > 0) {
    fs.writeFileSync(
      join(f.env.HUD_HOME, 'hud-settings.json'),
      JSON.stringify({ decisionCallsPerHour: cap }),
      { mode: 0o600 }
    );
  }
}

test('quiet decision discards a stale reply after working/done pushes during the API call', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'decision-race', 0.25);
  let job;
  const server = await fakeDecisionServer(t, async (_body, count) => {
    if (count === 1) {
      f.push(job.job, 'working');
      await new Promise((r) => setTimeout(r, 50));
      f.push(job.job, 'done');
      await new Promise((r) => setTimeout(r, 50));
      return decisionAnswer('finished-no-report', 0.95);
    }
    return decisionAnswer('needs-human', 0.95);
  });
  configureFakeDecision(f, server.baseUrl);
  job = await f.call('hud_create', { role: 'decision-race', request_key: 'decision-race', task: 'Synthetic decision race.' });
  await until(() => cliState(job.task_dir)?.pid);
  f.push(job.job, 'done');
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator');
  assert.equal(server.requests.length, 2);
  assert.equal(f.commands().some((c) => String(c.args[3]).startsWith('Write your report to ')), false);
});

test('quiet decision still-working keeps waiting up to 3 questions then escalates, showing on card and Inspector', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'qd-wait', 1, false);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(
    join(f.env.HOME, 'pane-read'),
    Array.from({ length: 70 }, (_, i) => `line ${i + 1}: waiting on background build`).join('\n') + '\n'
  );
  const server = await fakeDecisionServer(t, () => decisionAnswer('still-working', 0.91));
  configureFakeDecision(f, server.baseUrl);
  const job = await f.call('hud_create', { role: 'qd-wait', request_key: 'qd-wait', task: 'Synthetic quiet wait.' });
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', 12000);
  assert.equal(server.requests.length, 3);
  const sentBody = server.requests[0];
  const pageText = sentBody.input[0].content[1].data.page.text;
  assert.equal(pageText.split('\n').length, 60);
  assert.ok(pageText.startsWith('line 11:'));
  const facts = sentBody.input[0].content[2].data.facts;
  assert.equal(facts.background_child_alive, false);
  assert.equal(typeof facts.minutes_quiet, 'number');
  assert.equal(facts.job_state, 'working');
  const status = cliState(job.task_dir);
  assert.equal(status.quiet_decision.action, 'needs-human');
  assert.equal(status.quiet_decision.reason, 'max-questions');
  const calls = JSON.parse(fs.readFileSync(join(f.env.HUD_HOME, 'display/model-cache/decision-api/calls.json'), 'utf8'));
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.feature === 'quiet-job'));
  const worker = workerFor(f, job.job);
  assert.equal(worker.quietDecision.action, 'needs-human');
  assert.match(cardText(worker), /needs-human \(max questions\)/);
  const inspectText = workInspectorRows(worker, initialMonitorState(), 80, Date.now()).map((r) => stripAnsi(r.text)).join('\n');
  assert.match(inspectText, /quiet\s+needs-human \(max questions\)/);
});

test('quiet decision finished-no-report sends fixed prompt once per job and settles; second never sends twice', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'qd-prompt', 1, false);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(join(f.env.HOME, 'write-on-report-prompt'), '');
  const server = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.93));
  configureFakeDecision(f, server.baseUrl);
  const job = await f.call('hud_create', { role: 'qd-prompt', request_key: 'qd-prompt-1', task: 'Synthetic report prompt.' });
  await until(() => cliState(job.task_dir)?.state === 'closed', 10000);
  const expectedPrompt = `Write your report to ${join(job.task_dir, 'report.md')} now; if work remains, finish it first.`;
  const prompts = f.commands().filter((c) => c.args[1] === 'prompt' && c.args[3] === expectedPrompt);
  assert.equal(prompts.length, 1);
  assert.equal(cliState(job.task_dir).quiet_decision.choice, 'finished-no-report');
  assert.equal(cliState(job.task_dir).quiet_decision.probability, 0.93);
  assert.equal(cliState(job.task_dir).quiet_decision.action, 'prompt-report');

  // Second finished-no-report in the same job must NOT send the prompt twice -> needs-human.
  const f2 = await fixture(t);
  writeCliRole(f2, 'qd-prompt2', 1, false);
  fs.writeFileSync(join(f2.env.HOME, 'missing-report'), '');
  const server2 = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.94));
  configureFakeDecision(f2, server2.baseUrl);
  const job2 = await f2.call('hud_create', { role: 'qd-prompt2', request_key: 'qd-prompt-2', task: 'Synthetic no repeat.' });
  await until(() => cliState(job2.task_dir)?.state === 'waiting_orchestrator', 10000);
  const expectedPrompt2 = `Write your report to ${join(job2.task_dir, 'report.md')} now; if work remains, finish it first.`;
  const prompts2 = f2.commands().filter((c) => c.args[1] === 'prompt' && c.args[3] === expectedPrompt2);
  assert.equal(prompts2.length, 1);
  assert.equal(server2.requests.length, 2);
  const status2 = cliState(job2.task_dir);
  assert.equal(status2.quiet_decision.choice, 'finished-no-report');
  assert.equal(status2.quiet_decision.probability, 0.94);
  assert.equal(status2.quiet_decision.action, 'needs-human');
  const worker2 = workerFor(f2, job2.job);
  assert.match(cardText(worker2), /finished-no-report 94%/);
  const inspect2 = workInspectorRows(worker2, initialMonitorState(), 110, Date.now()).map((r) => stripAnsi(r.text)).join('\n');
  assert.match(inspect2, /finished-no-report 94% → needs-human/);
});

test('quiet decision failed uses screen line and quota marks place exhausted', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'roles', 'qd-fail.json'),
    JSON.stringify({
      role: 'qd-fail',
      instructions: 'implementer',
      can_continue: false,
      idle_grace_s: 1,
      run: [
        { harness: 'cli', agent: 'grok', model: 'grok-4.7' },
        { harness: 'cli', agent: 'claude', model: 'opus-5.5' },
      ],
    })
  );
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(join(f.env.HOME, 'pane-read'), 'working...\nError: 429 rate limit exceeded for grok-4.7\n> \n');
  const server = await fakeDecisionServer(t, () => decisionAnswer('failed', 0.96));
  configureFakeDecision(f, server.baseUrl);
  const job = await f.call('hud_create', { role: 'qd-fail', request_key: 'qd-fail', task: 'Synthetic quota fail.' });
  await until(() => cliState(job.task_dir)?.state === 'failed', 8000);
  const status = cliState(job.task_dir);
  assert.match(status.exit_reason, /429 rate limit exceeded/);
  assert.match(status.exit_reason, /next dispatch will use cli\/claude \(opus-5\.5\)/);
  assert.equal(status.quiet_decision.choice, 'failed');
  assert.equal(status.quiet_decision.probability, 0.96);
  assert.equal(status.quiet_decision.action, 'fail');
  const exhausted = JSON.parse(fs.readFileSync(join(f.env.HUD_HOME, 'exhausted.json'), 'utf8'));
  assert.ok(exhausted.places['cli:grok:grok-4.7']);
  const worker = workerFor(f, job.job);
  assert.match(cardText(worker), /failed 96% → fail/);
});

test('quiet decision failed without quota regex falls back to needs-human without exhausting', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'qd-nonquota', 1, false);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(join(f.env.HOME, 'pane-read'), 'working...\nError: segmentation fault in worker\n> \n');
  const server = await fakeDecisionServer(t, () => decisionAnswer('failed', 0.95));
  configureFakeDecision(f, server.baseUrl);
  const job = await f.call('hud_create', { role: 'qd-nonquota', request_key: 'qd-nonquota', task: 'Synthetic non-quota error.' });
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', 8000);
  const status = cliState(job.task_dir);
  assert.equal(status.reason, 'quiet without a report; hud_send to continue or hud_close to stop');
  assert.equal(status.quiet_decision.choice, 'failed');
  assert.equal(status.quiet_decision.probability, 0.95);
  assert.equal(status.quiet_decision.action, 'needs-human');
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'exhausted.json')), false);
  assert.equal(f.commands().filter((c) => c.args[1] === 'prompt' && c.args[2] !== 'w4E:p1').length, 1);
});

test('low probability, cap reached, and provider error all fall back to needs-human without prompting worker', { timeout: 20000 }, async (t) => {
  // 1. Low probability (< 0.8)
  const fLow = await fixture(t);
  writeCliRole(fLow, 'qd-low', 1, false);
  fs.writeFileSync(join(fLow.env.HOME, 'missing-report'), '');
  const sLow = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.79));
  configureFakeDecision(fLow, sLow.baseUrl);
  const jLow = await fLow.call('hud_create', { role: 'qd-low', request_key: 'qd-low', task: 'Synthetic low prob.' });
  await until(() => cliState(jLow.task_dir)?.state === 'waiting_orchestrator', 8000);
  assert.equal(cliState(jLow.task_dir).quiet_decision.choice, 'finished-no-report');
  assert.equal(cliState(jLow.task_dir).quiet_decision.probability, 0.79);
  assert.equal(cliState(jLow.task_dir).quiet_decision.action, 'needs-human');
  assert.equal(fLow.commands().filter((c) => c.args[1] === 'prompt' && c.args[2] !== 'w4E:p1').length, 1);

  // 2. Cap reached
  const fCap = await fixture(t);
  writeCliRole(fCap, 'qd-cap', 1, false);
  fs.writeFileSync(join(fCap.env.HOME, 'missing-report'), '');
  const sCap = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.95));
  configureFakeDecision(fCap, sCap.baseUrl, 1);
  const apiDir = join(fCap.env.HUD_HOME, 'display/model-cache/decision-api');
  fs.mkdirSync(apiDir, { recursive: true });
  fs.writeFileSync(join(apiDir, 'calls.json'), JSON.stringify([{ at: Date.now(), feature: 'outcome' }]));
  const jCap = await fCap.call('hud_create', { role: 'qd-cap', request_key: 'qd-cap', task: 'Synthetic cap.' });
  await until(() => cliState(jCap.task_dir)?.state === 'waiting_orchestrator', 8000);
  assert.equal(sCap.requests.length, 0);
  assert.equal(cliState(jCap.task_dir).quiet_decision.action, 'needs-human');
  assert.equal(cliState(jCap.task_dir).quiet_decision.reason, 'cap');
  assert.equal(fCap.commands().filter((c) => c.args[1] === 'prompt' && c.args[2] !== 'w4E:p1').length, 1);

  // 3. Provider error (HTTP 500)
  const fErr = await fixture(t);
  writeCliRole(fErr, 'qd-err', 1, false);
  fs.writeFileSync(join(fErr.env.HOME, 'missing-report'), '');
  const sErr = await fakeDecisionServer(t, () => ({ status: 500, body: { error: 'boom' } }));
  configureFakeDecision(fErr, sErr.baseUrl);
  const jErr = await fErr.call('hud_create', { role: 'qd-err', request_key: 'qd-err', task: 'Synthetic error.' });
  await until(() => cliState(jErr.task_dir)?.state === 'waiting_orchestrator', 8000);
  assert.equal(sErr.requests.length, 1);
  assert.equal(cliState(jErr.task_dir).quiet_decision.action, 'needs-human');
  assert.equal(cliState(jErr.task_dir).quiet_decision.reason, 'error');
  assert.equal(fErr.commands().filter((c) => c.args[1] === 'prompt' && c.args[2] !== 'w4E:p1').length, 1);
});

test('hud_roster convention and hud_create result carry the hud watch Monitor hint', async (t) => {
  const f = await fixture(t);
  const roster = await f.call('hud_roster');
  assert.match(roster.convention.text, /Claude Code: run `hud watch` under Monitor/);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const created = await f.call('hud_create', {
    role: 'imp',
    request_key: 'watch-hint',
    task: 'Check watch hint.',
  });
  assert.equal(created.hint, 'Claude Code: run `hud watch` under Monitor');
});

test('report written while working settles only at turn end, not mid-turn slice timeout', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'mid-report-cli', 1, true);
  fs.writeFileSync(join(f.env.HOME, 'report-while-working'), '');
  const job = await f.call('hud_create', {
    role: 'mid-report-cli',
    request_key: 'mid-report',
    task: 'Write report mid-turn while still working.',
  });
  await until(() => fs.existsSync(join(job.task_dir, 'report.md')), 5000);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(cliState(job.task_dir).state, 'working');
  assert.equal(cliState(job.task_dir).output_written, false);
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'), false);

  fs.writeFileSync(join(f.env.HOME, 'release-done'), '');
  await until(() => cliState(job.task_dir)?.state === 'idle_grace' && cliState(job.task_dir)?.output_written === true, 5000);
  await until(() => cliState(job.task_dir)?.state === 'closed', 5000);
  assert.equal(cliState(job.task_dir).output_written, true);
  assert.equal(cliState(job.task_dir).exit_reason, 'settled');
});

test('no /quit before done and a live background child holds idle_grace until exit', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'no-cont-mid', 1, false);
  fs.writeFileSync(join(f.env.HOME, 'report-while-working'), '');
  const noCont = await f.call('hud_create', {
    role: 'no-cont-mid',
    request_key: 'no-quit-early',
    task: 'Must not send /quit before done.',
  });
  await until(() => fs.existsSync(join(noCont.task_dir, 'report.md')), 5000);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(cliState(noCont.task_dir).state, 'working');
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'), false);
  fs.writeFileSync(join(f.env.HOME, 'release-done'), '');
  await until(() => cliState(noCont.task_dir)?.state === 'closed', 5000);
  assert.equal(cliState(noCont.task_dir).output_written, true);
  assert.ok(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'));

  // Now check live background child holding idle_grace past the 1s grace deadline.
  fs.unlinkSync(join(f.env.HOME, 'report-while-working'));
  fs.unlinkSync(join(f.env.HOME, 'report-while-working-stage'));
  fs.unlinkSync(join(f.env.HOME, 'release-done'));
  writeCliRole(f, 'grace-bg-cli', 1, true);
  const childPidFile = join(f.env.HOME, 'grace-bg-child');
  const helperReady = join(f.env.HOME, 'grace-helper-ready');
  const fakeCli = spawn(
    process.execPath,
    [
      '-e',
      `const { spawn } = require('node:child_process');
       const fs = require('node:fs');
       const helper = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)']);
       let bg = null;
       process.on('SIGUSR1', () => {
         bg = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)']);
         fs.writeFileSync(${JSON.stringify(childPidFile)}, String(bg.pid));
       });
       process.on('SIGUSR2', () => { if (bg) bg.kill('SIGKILL'); });
       process.on('SIGTERM', () => { helper.kill('SIGKILL'); if (bg) bg.kill('SIGKILL'); process.exit(0); });
       fs.writeFileSync(${JSON.stringify(helperReady)}, String(helper.pid));
       setInterval(()=>{}, 1000);`,
    ],
    { stdio: 'ignore' }
  );
  t.after(() => { try { fakeCli.kill('SIGTERM'); } catch {} });
  await until(() => fs.existsSync(helperReady));
  fs.writeFileSync(join(f.env.HOME, 'cli-pid'), String(fakeCli.pid));
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const graceJob = await f.call('hud_create', {
    role: 'grace-bg-cli',
    request_key: 'grace-bg-hold',
    task: 'Background child holds grace.',
  });
  await until(() => cliState(graceJob.task_dir)?.pid === fakeCli.pid);
  fakeCli.kill('SIGUSR1');
  await until(() => fs.existsSync(childPidFile));
  fs.writeFileSync(join(graceJob.task_dir, 'report.md'), 'Report ready.\n');
  fs.writeFileSync(join(f.env.HOME, 'release-turn'), '');
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(['working', 'idle_grace'].includes(cliState(graceJob.task_dir).state), true);
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[2] === `${graceJob.job}-primary` && c.args[3] === '/quit'), false);
  fakeCli.kill('SIGUSR2');
  await until(() => cliState(graceJob.task_dir)?.state === 'closed', 5000);
  assert.equal(cliState(graceJob.task_dir).output_written, true);
});

test('exit is a /proc pid check: herdr errors keep working while pid lives, PID gone closes or fails, unknown PID asks after 3 ticks', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const spawnDummy = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
    t.after(() => { try { child.kill('SIGKILL'); } catch {} });
    return child;
  };

  // 1. Live pid stays working across repeated herdr errors, then closes cleanly once herdr recovers.
  const liveProc = spawnDummy();
  fs.writeFileSync(join(f.env.HOME, 'cli-pid'), String(liveProc.pid));
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  const keepAlive = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'herdr-errors-alive',
    task: 'Keep working when herdr errors while pid lives.',
  });
  await until(
    () =>
      f.socketRequests.filter((req) => req.method === 'agent.get' && req.params.target === `${keepAlive.job}-primary`).length >= 5,
    5000
  );
  assert.equal(cliState(keepAlive.task_dir).state, 'working');
  assert.equal(cliState(keepAlive.task_dir).pid, liveProc.pid);
  fs.unlinkSync(join(f.env.HOME, 'herdr-errors'));
  await until(() => cliState(keepAlive.task_dir)?.state === 'closed', 8000);

  // 2. Pid gone without a report -> failed.
  const procNoReport = spawnDummy();
  fs.writeFileSync(join(f.env.HOME, 'cli-pid'), String(procNoReport.pid));
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const failJob = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'pid-gone-fail',
    task: 'Pid dies without report.',
  });
  await until(() => cliState(failJob.task_dir)?.pid === procNoReport.pid);
  procNoReport.kill('SIGKILL');
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  await until(() => cliState(failJob.task_dir)?.state === 'failed', 5000);
  assert.equal(cliState(failJob.task_dir).exit_reason, 'worker exited');
  assert.equal(cliState(failJob.task_dir).output_written, false);
  fs.unlinkSync(join(f.env.HOME, 'herdr-errors'));

  // 3. Pid gone with a report -> closed (output_written true).
  const procWithReport = spawnDummy();
  fs.writeFileSync(join(f.env.HOME, 'cli-pid'), String(procWithReport.pid));
  const closeJob = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'pid-gone-report',
    task: 'Pid dies after writing report.',
  });
  await until(() => cliState(closeJob.task_dir)?.pid === procWithReport.pid);
  fs.writeFileSync(join(closeJob.task_dir, 'report.md'), 'Finished before exit.\n');
  procWithReport.kill('SIGKILL');
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  await until(() => cliState(closeJob.task_dir)?.state === 'closed', 5000);
  assert.equal(cliState(closeJob.task_dir).exit_reason, 'settled');
  assert.equal(cliState(closeJob.task_dir).output_written, true);

  // 4. Unknown PID and three consecutive missing ticks hand off, never fail.
  fs.unlinkSync(join(f.env.HOME, 'herdr-errors'));
  fs.unlinkSync(join(f.env.HOME, 'cli-pid'));
  fs.writeFileSync(join(f.env.HOME, 'no-pid'), '');
  const nullPidJob = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'null-pid-3-misses',
    task: 'Null pid requires 3 consecutive misses.',
  });
  await until(() => cliState(nullPidJob.task_dir)?.state === 'waiting_orchestrator', 6000);
  const agentGets = f.socketRequests.filter((req) => req.method === 'agent.get' && req.params.target === `${nullPidJob.job}-primary`);
  assert.ok(agentGets.length >= 4);
  assert.equal(cliState(nullPidJob.task_dir).reason, 'worker not found');
});
