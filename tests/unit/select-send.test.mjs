import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import toml from '@iarna/toml';
import {
  DEFAULT_INVESTIGATE_LINE,
  deliverSelection,
  formatSelectionMessage,
  handleInvestigatePaneAction,
  handleSelectionAction,
  normalizePaneExcerpt,
  normalizeSelectionExcerpt,
  openAdvisorPopup,
  retrySelectionAction,
  readAndRemoveSelectionHandoff,
  resolveSelectionTarget,
} from '../../dist/roles/select-send.js';
import {
  applyComposerKey,
  createComposerState,
  renderAdvisorConversation,
  renderSelectSendComposer,
} from '../../dist/render/select-send-composer.js';
import { ComposerKeyDecoder, runComposerSession, selectSendCommand } from '../../dist/cli/select-send.js';
import { panelActionLine } from '../../dist/collectors/panel-actions.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { visualLength } from '../../dist/render/colors.js';
import { getJobIndexCache } from '../../dist/roles/job-index-cache.js';
import { readSelectionExcerpts } from '../../dist/roles/selection-excerpts.js';
import { PanelExecution } from '../../dist/panel/execution.js';
import { executionRows } from '../../dist/render/execution-view.js';
import { selectionExcerptRows } from '../../dist/render/selection-excerpts.js';
import { workInspectorRows } from '../../dist/render/work-inspector.js';

const root = resolve(new URL('../..', import.meta.url).pathname);
const guardedPong = { result: { type: 'pong', version: '0.9.5-hud.a26432a7', capabilities: { guarded_prompt: true, hidden_tabs: true, pane_strip: true } } };
const prompted = { result: { type: 'agent_prompted' } };

async function fakeFork(t, handler) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-select-send-'));
  const home = join(dir, 'hud-home');
  const bin = join(dir, 'bin');
  const socketPath = join(dir, 'herdr.sock');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(bin, { recursive: true });
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!raw.trim()) continue;
        const req = JSON.parse(raw);
        const reply = handler(req.method, req.params ?? {}, socket);
        if (reply !== undefined) {
          socket.write(JSON.stringify({ id: req.id, ...reply }) + '\n');
        }
      }
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  t.after(async () => {
    for (const s of sockets) s.destroy();
    server.close();
    await once(server, 'close');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // Fake `herdr` CLI for paneInfo() calls made by notify().
  fs.writeFileSync(
    join(bin, 'herdr'),
    `#!${process.execPath}
const net = require('node:net');
const args = process.argv.slice(2);
const sock = process.env.HERDR_SOCKET_PATH;
if (!sock) process.exit(1);
let method, params = {};
if (args[0] === 'pane' && args[1] === 'get') { method = 'pane.get'; params = { pane_id: args[2] }; }
else if (args[0] === 'pane' && args[1] === 'list') { method = 'pane.list'; }
else if (args[0] === 'agent' && args[1] === 'prompt') { method = 'agent.prompt'; params = { target: args[2], text: args[3] }; }
else process.exit(2);
const c = net.createConnection(sock);
let buf = '';
c.on('connect', () => c.write(JSON.stringify({ id: 'cli', method, params }) + '\\n'));
c.on('data', d => {
  buf += d.toString('utf8');
  const nl = buf.indexOf('\\n');
  if (nl >= 0) {
    const response = buf.slice(0, nl + 1);
    if (JSON.parse(response).error) { process.stderr.write(response); process.exitCode = 1; }
    else process.stdout.write(response);
    c.destroy();
  }
});
c.on('error', () => process.exit(1));
`,
    { mode: 0o755 }
  );
  const env = {
    ...process.env,
    HOME: join(dir, 'home'),
    HUD_HOME: home,
    HUD_SETTINGS_PATH: join(home, 'hud-settings.json'),
    HERDR_SOCKET_PATH: socketPath,
    HERDR_BIN_PATH: join(bin, 'herdr'),
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    NO_COLOR: '1',
  };
  return { dir, home, bin, socketPath, env };
}

function writeJob(home, id, { role = 'imp', callerPane, leftPane, projectRoot, socketPath, createdAt = '2026-11-26T10:00:00.000Z', reapedAt,
  primary, ticket, packageName } = {}) {
  const dir = join(home, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    join(dir, 'job.json'),
    JSON.stringify({
      job: id,
      role,
      request_key: `req-${id}`,
      cwd: projectRoot,
      project_root: projectRoot,
      caller_pane: callerPane,
      created_at: createdAt,
      dispatch_exit_code: 0,
      stderr_tail: '',
      ...(reapedAt ? { reaped_at: reapedAt } : {}),
      ...(ticket ? { ticket } : {}),
      ...(packageName ? { package: packageName } : {}),
    })
  );
  const sessionLines = [
    `LEFT=${leftPane}`,
    `ORCH=${callerPane}`,
    ...(primary ? [`PRIMARY=${primary}`, `LAUNCH_ID=launch-${primary}`, 'DIRECT_EXEC=1'] : []),
    ...(socketPath ? [`HERDR_SOCKET_PATH=${socketPath}`] : []),
  ];
  fs.writeFileSync(join(dir, 'SESSION.txt'), sessionLines.join('\n') + '\n');
  return dir;
}

function fakeTtyStreams(columns = 80, rows = 18) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = columns;
  stdout.rows = rows;
  return { stdin, stdout };
}

async function until(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timed out waiting for condition');
}

test('worker pane selection delivers excerpt, job source, and question once to job dispatcher', async (t) => {
  const projA = fs.mkdtempSync(join(tmpdir(), 'hud-proj-a-'));
  t.after(() => fs.rmSync(projA, { recursive: true, force: true }));
  const panes = [
    { pane_id: 'w1:p1', workspace_id: 'w1', cwd: projA, agent: 'claude', agent_status: 'idle' },
    { pane_id: 'w1:p2', workspace_id: 'w1', cwd: projA, agent: 'pi', agent_status: 'working' },
    { pane_id: 'w1:p3', workspace_id: 'w1', cwd: projA, agent: 'codex', agent_status: 'idle' },
  ];
  const prompts = [];
  const f = await fakeFork(t, (method, params) => {
    if (method === 'ping') return guardedPong;
    if (method === 'pane.list') return { result: { type: 'pane_list', panes } };
    if (method === 'pane.get') return { result: { type: 'pane_info', pane: panes.find((p) => p.pane_id === params.pane_id) } };
    if (method === 'pane.read') return { result: { type: 'pane_read', read: { text: 'FAIL test/foo.test.mjs\nExpected 2 to equal 3' } } };
    if (method === 'agent.prompt') {
      prompts.push(params);
      return prompted;
    }
    return { error: { code: 'unsupported' } };
  });

  writeJob(f.home, 'j0000000000000001', {
    role: 'imp',
    callerPane: 'w1:p1',
    leftPane: 'w1:p2',
    projectRoot: projA,
    socketPath: f.socketPath,
  });

  const { stdin, stdout } = fakeTtyStreams(80, 18);
  const frames = [];
  const fixedNow = new Date('2026-11-26T12:00:00.000Z');
  const sessionPromise = runComposerSession({
    context: {
      workspace_id: 'w1',
      focused_pane_id: 'w1:p2',
      focused_pane_cwd: projA,
      selected_text: 'FAIL test/foo.test.mjs\nExpected 2 to equal 3',
    },
    hudHome: f.home,
    env: f.env,
    stdin,
    stdout,
    now: () => fixedNow,
    onFrame: (lines) => frames.push(lines),
  });

  await until(() => frames.length > 0);
  // Composer shows the exact excerpt before sending.
  assert.ok(frames[0].join('\n').includes('FAIL test/foo.test.mjs'));
  assert.ok(frames[0].join('\n').includes('Expected 2 to equal 3'));
  assert.ok(frames[0].join('\n').includes('w1:p1'));

  stdin.write('is this from your last change?\r');
  const outcome = await sessionPromise;
  assert.equal(outcome.code, 0);
  assert.equal(outcome.sent, true);
  assert.equal(outcome.targetPane, 'w1:p1');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].target, 'w1:p1');
  assert.equal(prompts[0].guarded, true);
  assert.match(prompts[0].text, /^\[HUD selection\]/);
  assert.match(prompts[0].text, /pane=w1:p2/);
  assert.match(prompts[0].text, /job=j0000000000000001 \(imp\)/);
  assert.match(prompts[0].text, /time=2026-11-26T12:00:00\.000Z/);
  assert.ok(prompts[0].text.includes('FAIL test/foo.test.mjs\nExpected 2 to equal 3'));
  assert.ok(prompts[0].text.includes('Question: is this from your last change?'));
});

test('composer saves a note without sending and a closed job shows it as undelivered', { timeout: 10_000 }, async (t) => {
  const target = 'j000000000000000a', pane = 'w1:p2';
  let panes = [], paneText = 'Synthetic log line';
  const prompts = [];
  const f = await fakeFork(t, (method, params) => {
    if (method === 'pane.list') return { result: { panes } };
    if (method === 'pane.read') return { result: { read: { text: paneText } } };
    if (method === 'agent.prompt') { prompts.push(params); return prompted; }
    return { error: { code: 'unsupported' } };
  });
  const project = join(f.dir, 'project');
  fs.mkdirSync(project);
  panes = [{ pane_id: pane, cwd: project, workspace_id: 'w1', agent: 'pi', agent_status: 'working' }];
  const dir = writeJob(f.home, target, { leftPane: pane, primary: 'agent-a', projectRoot: project, socketPath: f.socketPath });
  const status = join(dir, 'STATUS.json');
  fs.writeFileSync(status, JSON.stringify({ state: 'working' }));
  const { stdin, stdout } = fakeTtyStreams();
  const input = text => queueMicrotask(() => stdin.write(text));
  const onFrame = (lines, state) => {
    const screen = lines.join('\n');
    if (step === 0) { step++; input('\t'); }
    else if (step === 1) {
      assert.match(screen, /Note for next turn -> imp[\s\S]*Ask an advisor/);
      step++; input('\x1b[F\x1b[A\r'); // The note entry is just above Ask an advisor.
    } else if (step === 2 && state.noteForNextTurn) {
      assert.match(screen, /Note: /);
      assert.match(screen, /Enter save note/);
      paneText = 'New log output scrolls the selection away';
      step++; input('Check this assertion\r');
    }
  };
  let step = 0;
  const outcome = await runComposerSession({
    context: { workspace_id: 'w1', focused_pane_id: pane, focused_pane_cwd: project, selected_text: 'Synthetic log line' },
    hudHome: f.home, env: f.env, stdin, stdout, onFrame,
  });
  assert.equal(step, 3);
  assert.equal(outcome.sent, true);
  assert.deepEqual(prompts, []);
  const cache = getJobIndexCache(f.home);
  const card = () => selectionExcerptRows(readSelectionExcerpts(f.home, cache, { project }), 80, true).map(row => row.text).join('\n');
  assert.match(card(), /pending[\s\S]*Synthetic log line[\s\S]*Note[\s\S]*Check this assertion/);
  panes = [];
  fs.writeFileSync(status, JSON.stringify({ state: 'closed' }));
  assert.match(card(), /undelivered[\s\S]*Synthetic log line[\s\S]*Check this assertion/);
});

test('working jobs cross-send selections, bind reverse-order replies, and offer main if a picked job ended', { timeout: 15_000 }, async (t) => {
  const a = 'j000000000000000a', b = 'j000000000000000b';
  const main = 'w1:p1', leftA = 'w1:p2', leftB = 'w1:p3';
  let panes = [];
  const prompts = [];
  const f = await fakeFork(t, (method, params) => {
    if (method === 'ping') return guardedPong;
    if (method === 'pane.list') return { result: { panes } };
    if (method === 'pane.get') return { result: { pane: panes.find(pane => pane.pane_id === params.pane_id) } };
    if (method === 'agent.prompt') {
      prompts.push(params);
      return params.text.includes('uncertain excerpt') ? { error: { code: 'agent_prompt_stalled' } } : prompted;
    }
    return { error: { code: 'unsupported' } };
  });
  const project = join(f.dir, 'project');
  fs.mkdirSync(project);
  const initialPanes = [main, leftA, leftB].map((pane_id, i) => ({
    pane_id, cwd: project, workspace_id: 'w1', agent: 'pi', agent_status: i ? 'working' : 'idle',
  }));
  panes = initialPanes;
  const writeWorker = (id, leftPane, primary, info) => {
    const dir = writeJob(f.home, id, { callerPane: main, leftPane, primary, projectRoot: project, socketPath: f.socketPath,
      createdAt: new Date().toISOString(), ...info });
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
    return dir;
  };
  const dirA = writeWorker(a, leftA, 'agent-a', { ticket: 'feature/01' });
  const dirB = writeWorker(b, leftB, 'agent-b', { role: 'reviewer', packageName: 'checks' });
  const cache = getJobIndexCache(f.home);
  const excerpts = () => readSelectionExcerpts(f.home, cache, { project });
  const run = async (script, env) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env: { ...f.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'], signal: t.signal });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  };
  const compose = (pane, target, text, mode) => run(`
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    import { PassThrough } from 'node:stream';
    import { runComposerSession } from './dist/cli/select-send.js';
    const { PROJECT, PANE, TARGET, TEXT, MODE, CLOSE_STATUS } = process.env;
    const stdin = new PassThrough(), stdout = new PassThrough();
    const input = text => queueMicrotask(() => stdin.write(text));
    let stage = 0;
    const result = await runComposerSession({
      context: { workspace_id: 'w1', focused_pane_id: PANE, focused_pane_cwd: PROJECT, selected_text: TEXT },
      hudHome: process.env.HUD_HOME, env: process.env, stdin, stdout,
      onFrame(lines, state) {
        if (stage === 0) { stage++; input('\\t'); }
        else if (stage === 1) {
          assert.notEqual(state.picker, null);
          const screen = lines.join('\\n');
          assert.match(screen, /imp · working · feature\\/01/);
          assert.match(screen, /reviewer · working · checks/);
          const at = state.jobs.findIndex(job => job.job === TARGET);
          assert.notEqual(at, -1);
          stage++; input('\\x1b[B'.repeat(at + 1) + '\\r');
        } else if (stage === 2 && state.targetJob?.job === TARGET) {
          if (MODE === 'ended') writeFileSync(CLOSE_STATUS, JSON.stringify({ state: 'closed' }));
          stage++; input('Why?\\r');
        } else if (stage === 3 && state.error?.startsWith('Target ended.')) {
          assert.equal(MODE, 'ended');
          assert.match(lines.join('\\n'), /Enter sends to main/);
          assert.equal(state.targetJob, undefined);
          stage++; input('\\r');
        } else if (stage === 3 && state.error === 'Selection delivery unknown.') {
          assert.equal(MODE, 'unknown');
          stage++; input('\\x1b');
        }
      },
    });
    assert.equal(stage, MODE ? 4 : 3);
    console.log(JSON.stringify(result));
  `, { PROJECT: project, PANE: pane, TARGET: target, TEXT: text, MODE: mode ?? '', CLOSE_STATUS: join(dirB, 'STATUS.json') });
  const reply = (jobDir, message, reply_to) => run(`
    import { callWorkerTool } from './dist/worker/tools.js';
    console.log(JSON.stringify(await callWorkerTool('hud_progress', JSON.parse(process.env.REPLY))));
  `, { HUD_JOB_DIR: jobDir, REPLY: JSON.stringify({ message, reply_to }) });

  assert.equal((await compose(leftA, b, 'error from A')).sent, true);
  assert.equal((await compose(leftB, a, 'error from B')).sent, true);
  const [toA, toB] = excerpts();
  assert.deepEqual([toA, toB].map(row => [row.source.job, row.target, row.question, row.delivery]), [[b, a, 'Why?', 'queued'], [a, b, 'Why?', 'queued']]);
  assert.deepEqual(prompts.map(p => p.target), ['agent-b', 'agent-a']);
  assert.ok(prompts[0].text.includes(`Excerpt ID: ${toB.id}`));
  assert.ok(prompts[1].text.includes(`Excerpt ID: ${toA.id}`));
  assert.equal(fs.statSync(join(f.home, 'selection-excerpts.json')).mode & 0o777, 0o600);

  panes = [initialPanes[0]]; // Answers do not depend on source panes or their contents.
  assert.equal((await reply(dirA, 'Normal milestone')).ok, true);
  assert.equal((await reply(dirA, 'Wrong job', toB.id)).ok, false);
  assert.equal((await reply(dirB, 'Unknown ID', 'not-an-excerpt')).ok, false);
  assert.ok(excerpts().every(row => row.answer === undefined));
  assert.equal((await reply(dirA, 'A answered B', toA.id)).ok, true);
  assert.equal((await reply(dirB, 'B answered A', toB.id)).ok, true);
  assert.deepEqual(excerpts().map(row => [row.excerpt, row.answer.text]), [['error from B', 'A answered B'], ['error from A', 'B answered A']]);

  panes = initialPanes;
  assert.equal((await compose(leftA, b, 'uncertain excerpt', 'unknown')).sent, false);
  assert.equal(excerpts()[0].delivery, 'delivery unknown');
  assert.equal((await compose(leftA, b, 'new error', 'ended')).targetPane, main);
  assert.deepEqual(prompts.map(p => p.target), ['agent-b', 'agent-a', 'agent-b', main]);
  assert.equal(prompts.at(-1).guarded, true);
  assert.equal(excerpts()[0].delivery, 'target ended');
  assert.equal(JSON.parse(fs.readFileSync(join(dirB, 'STATUS.json'), 'utf8')).state, 'closed');
  assert.deepEqual(cache.listJobIds().toSorted(), [a, b]);

  const view = new PanelExecution(f.home, main, f.env, () => {});
  t.after(() => view.dispose());
  view.sync(project, false);
  await view.refresh(`thin-job:${b}`);
  const worker = view.board().workers.find(w => w.id === `thin-job:${b}`);
  const board = executionRows(view.view(project), undefined, 80, Date.now());
  const card = board.filter(row => row.item === `project:excerpt:${toA.id}`).map(row => row.text).join('\n');
  assert.match(card, /answered/);
  assert.match(card, /error from B/);
  assert.match(card, /A answered B/);
  assert.doesNotMatch(card, /B answered A/);
  const inspector = workInspectorRows(worker, 80, Date.now()).map(row => row.text).join('\n');
  assert.match(inspector, /error from A/);
  assert.match(inspector, /B answered A/);
  assert.match(inspector, /target ended/);
  assert.doesNotMatch(inspector, /A answered B/);
});

test('non-worker pane routes to its own project main session (not another project)', async (t) => {
  const projA = fs.mkdtempSync(join(tmpdir(), 'hud-proj-a-'));
  const projB = fs.mkdtempSync(join(tmpdir(), 'hud-proj-b-'));
  t.after(() => {
    fs.rmSync(projA, { recursive: true, force: true });
    fs.rmSync(projB, { recursive: true, force: true });
  });
  const panes = [
    { pane_id: 'w1:p1', workspace_id: 'w1', cwd: projA, agent: 'claude', agent_status: 'idle' },
    { pane_id: 'w2:p1', workspace_id: 'w2', cwd: projB, agent: 'pi', agent_status: 'idle' },
    { pane_id: 'w2:p5', workspace_id: 'w2', cwd: projB },
  ];
  const prompts = [];
  const f = await fakeFork(t, (method, params) => {
    if (method === 'ping') return guardedPong;
    if (method === 'pane.list') return { result: { type: 'pane_list', panes } };
    if (method === 'pane.get') return { result: { type: 'pane_info', pane: panes.find((p) => p.pane_id === params.pane_id) } };
    if (method === 'pane.read') return { result: { type: 'pane_read', read: { text: 'Error: EACCES permission denied' } } };
    if (method === 'agent.prompt') {
      prompts.push(params);
      return prompted;
    }
    return { error: { code: 'unsupported' } };
  });

  const resolved = await resolveSelectionTarget(
    { workspace_id: 'w2', focused_pane_id: 'w2:p5', focused_pane_cwd: projB, selected_text: 'Error: EACCES permission denied' },
    f.home,
    f.env,
    new Date('2026-11-26T12:30:00.000Z')
  );
  assert.equal(resolved.targetPane, 'w2:p1');
  assert.equal(resolved.source.job, null);
  assert.equal(resolved.source.pane, 'w2:p5');

  const msg = formatSelectionMessage({
    excerpt: 'Error: EACCES permission denied',
    source: resolved.source,
    question: 'why did this fail?',
  });
  const delivery = await deliverSelection(resolved.targetPane, msg, f.home, f.env);
  assert.equal(delivery.ok, true);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].target, 'w2:p1');
  assert.equal(prompts[0].guarded, true);
  assert.doesNotMatch(prompts[0].text, /job=/);
  assert.match(prompts[0].text, /pane=w2:p5/);
  assert.ok(prompts[0].text.includes('Error: EACCES permission denied'));
  assert.ok(prompts[0].text.includes('Question: why did this fail?'));
});

async function fakeDraftFork(t) {
  const pane = { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'idle' };
  const attempts = [];
  const subscriptions = [];
  const subscribed = Promise.withResolvers();
  let draft = true;
  const f = await fakeFork(t, (method, params, socket) => {
    if (method === 'ping') return guardedPong;
    if (method === 'pane.list') return { result: { type: 'pane_list', panes: [pane] } };
    if (method === 'pane.get') return { result: { type: 'pane_info', pane } };
    if (method === 'events.subscribe') {
      subscriptions.push(socket);
      subscribed.resolve(socket);
      return { result: { type: 'subscription_started' } };
    }
    if (method === 'agent.prompt') {
      attempts.push(params);
      return draft ? { error: { code: 'draft_present' } } : prompted;
    }
    return { error: { code: 'unsupported' } };
  });
  return {
    ...f, attempts, subscriptions, subscribed: subscribed.promise,
    clearDraft(socket) {
      draft = false;
      socket.write(JSON.stringify({ event: 'pane.updated', data: { pane } }) + '\n');
    },
  };
}

test('one-shot selection delivery returns a guarded refusal without starting a retry', async (t) => {
  const f = await fakeDraftFork(t);
  const result = await deliverSelection('w1:p1', '[HUD selection]\nexample excerpt', f.home, f.env);
  assert.equal(result.ok, false);
  assert.match(result.error, /Selection not sent/);
  assert.equal(typeof result.retryPrompt, 'function');
  assert.deepEqual(f.attempts.map((p) => p.guarded), [true]);
  assert.equal(f.subscriptions.length, 0);
  assert.equal(fs.existsSync(join(f.home, 'select-send')), false);
});

for (const cancel of [false, true]) {
  test(cancel ? 'Esc cancels a guarded wait without sending' : 'composer waits on draft_present and sends once after the draft clears', { timeout: 5000 }, async (t) => {
    const f = await fakeDraftFork(t);
    const { stdin, stdout } = fakeTtyStreams();
    const ready = Promise.withResolvers();
    const frames = [];
    const session = runComposerSession({
      context: { workspace_id: 'w1', focused_pane_id: 'w1:p2', selected_text: 'example excerpt' },
      hudHome: f.home,
      env: { ...f.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
      stdin, stdout,
      onFrame(lines) { frames.push(lines); ready.resolve(); },
    });
    t.after(() => stdin.end());
    await ready.promise;
    stdin.write('what changed?\r');
    const socket = await f.subscribed;
    assert.equal(f.attempts.length, 1);
    assert.equal(f.attempts[0].guarded, true);
    assert.equal(fs.existsSync(join(f.home, 'select-send')), false, 'pending retry must not persist a file');
    const frame = frames.at(-1);
    assert.deepEqual(frame.filter((line) => line.includes('Esc cancel')).map((line) => line.trim()), [
      "Waiting for the main session's prompt to be empty · Esc cancels",
    ]);
    assert.ok(frame.some((line) => line.includes('Question: what changed?')));

    // Escape may close the socket before the queued pane event is read.
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.on('error', (err) => {
      if (!cancel || err.code !== 'ECONNRESET') throw err;
    });
    f.clearDraft(socket);
    if (cancel) stdin.write('\x1b');
    const result = await session;
    await closed;
    assert.equal(result.code, 0);
    assert.equal(result.sent, !cancel);
    assert.equal(f.attempts.length, cancel ? 1 : 2);
    if (!cancel) assert.deepEqual(f.attempts[1], f.attempts[0]);
  });
}

test('select-send rejects the removed retry CLI', async () => {
  await assert.rejects(selectSendCommand(['--retry', 'unused.json'], {}), (error) => {
    assert.match(error.message, /^Usage: hud select-send/);
    assert.doesNotMatch(error.message, /--retry/);
    return true;
  });
});

test('active pane watcher delivers selection once via panel-actions.jsonl without duplicate typing or cross-pane leak', async (t) => {
  const prompts = [];
  const f = await fakeFork(t, (method, params) => {
    if (method === 'ping') return guardedPong;
    if (method === 'agent.prompt') {
      prompts.push(params);
      return prompted;
    }
    return { error: { code: 'unsupported' } };
  });

  const modOut = [];
  const child = spawn(process.execPath, [join(root, 'bin/hud'), 'watch', '--mod'], {
    env: { ...f.env, HERDR_PANE_ID: 'w1:p1', HUD_MOD_CURSOR: '0:0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      modOut.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });

  await until(() => modOut.some((line) => line.includes('"type":"ready"')));

  // Multi-line excerpt containing duplicate lines must arrive intact.
  const msg = formatSelectionMessage({
    excerpt: 'if (ok) {\n}\n}',
    source: { project: 'demo', projectRoot: '/tmp/demo', pane: 'w1:p2', job: 'j0000000000000001', role: 'imp', time: '2026-11-26T12:00:00.000Z' },
    question: 'why two braces?',
  });
  const res = await deliverSelection('w1:p1', msg, f.home, f.env);
  assert.equal(res.ok, true);
  assert.equal(res.delivered, 'watcher');

  const wakeLine = await until(() => modOut.find((line) => line.includes('"type":"wake"')));
  const wake = JSON.parse(wakeLine);
  assert.equal(wake.lines.length, 1);
  assert.equal(wake.lines[0], msg);
  assert.equal(prompts.length, 0, 'watcher delivery must not also type via agent.prompt');

  // Another pane or MCP panelDelivery (without pane scope) must ignore this select-send record.
  const rawRecord = fs.readFileSync(join(f.home, 'panel-actions.jsonl'), 'utf8').trim().split('\n').at(-1);
  assert.equal(panelActionLine(rawRecord, () => true, '/tmp/demo'), undefined);
  assert.equal(panelActionLine(rawRecord, () => true, '/tmp/demo', 'w1:p3'), undefined);
  assert.equal(panelActionLine(rawRecord, () => true, '/tmp/demo', 'w1:p1'), msg);

  child.kill('SIGTERM');
  await once(child, 'exit');
});

test('stale_content refreshes composer to show latest text before sending', async (t) => {
  const proj = fs.mkdtempSync(join(tmpdir(), 'hud-proj-stale-'));
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  const panes = [
    { pane_id: 'w1:p1', workspace_id: 'w1', cwd: proj, agent: 'claude', agent_status: 'idle' },
    { pane_id: 'w1:p2', workspace_id: 'w1', cwd: proj },
  ];
  const prompts = [];
  const f = await fakeFork(t, (method, params) => {
    if (method === 'ping') return guardedPong;
    if (method === 'pane.list') return { result: { type: 'pane_list', panes } };
    if (method === 'pane.get') return { result: { type: 'pane_info', pane: panes.find((p) => p.pane_id === params.pane_id) } };
    if (method === 'pane.selection.read') {
      if (params.content_revision === 10) {
        return { error: { code: 'stale_content', message: 'pane content changed' } };
      }
      return { result: { type: 'pane_selection', pane_id: 'w1:p2', text: 'NEW failing line\nactual=42' } };
    }
    if (method === 'agent.prompt') {
      prompts.push(params);
      return prompted;
    }
    return { error: { code: 'unsupported' } };
  });

  const { stdin, stdout } = fakeTtyStreams(80, 18);
  const frames = [];
  const sessionPromise = runComposerSession({
    context: {
      workspace_id: 'w1',
      focused_pane_id: 'w1:p2',
      focused_pane_cwd: proj,
      selected_text: 'OLD stale line',
      selection: {
        pane_id: 'w1:p2',
        anchor: { row: 1, col: 0 },
        cursor: { row: 2, col: 10 },
        content_revision: 10,
      },
    },
    hudHome: f.home,
    env: f.env,
    stdin,
    stdout,
    now: () => new Date('2026-11-26T12:45:00.000Z'),
    onFrame: (lines, state) => frames.push({ lines, state }),
  });

  await until(() => frames.length > 0);
  assert.ok(frames[0].lines.join('\n').includes('OLD stale line'));

  // First Enter hits stale_content -> updates composer to latest text, does NOT send yet!
  stdin.write('what changed?\r');
  await until(() => frames.some((frame) => frame.lines.join('\n').includes('NEW failing line')));
  assert.equal(prompts.length, 0, 'must show latest text before sending');
  const latestFrame = frames.at(-1).lines.join('\n');
  assert.ok(latestFrame.includes('NEW failing line'));
  assert.ok(latestFrame.includes('actual=42'));
  assert.match(latestFrame, /Content changed/);

  // Second Enter confirms and sends the latest text once!
  stdin.write('\r');
  const outcome = await sessionPromise;
  assert.equal(outcome.sent, true);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].text.includes('NEW failing line\nactual=42'));
  assert.ok(!prompts[0].text.includes('OLD stale line'));
  assert.ok(prompts[0].text.includes('Question: what changed?'));
});

test('stale_content flag on open immediately shows latest pane text before sending', async (t) => {
  const proj = fs.mkdtempSync(join(tmpdir(), 'hud-proj-stale-open-'));
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  const panes = [
    { pane_id: 'w1:p1', workspace_id: 'w1', cwd: proj, agent: 'claude', agent_status: 'idle' },
    { pane_id: 'w1:p2', workspace_id: 'w1', cwd: proj },
  ];
  const prompts = [];
  const f = await fakeFork(t, (method, params) => {
    if (method === 'ping') return guardedPong;
    if (method === 'pane.list') return { result: { type: 'pane_list', panes } };
    if (method === 'pane.get') return { result: { type: 'pane_info', pane: panes.find((p) => p.pane_id === params.pane_id) } };
    if (method === 'pane.read') return { result: { type: 'pane_read', read: { text: 'header\nUPDATED line 1\nUPDATED line 2' } } };
    if (method === 'agent.prompt') {
      prompts.push(params);
      return prompted;
    }
    return { error: { code: 'unsupported' } };
  });

  const { stdin, stdout } = fakeTtyStreams(80, 18);
  const frames = [];
  const sessionPromise = runComposerSession({
    context: {
      workspace_id: 'w1',
      focused_pane_id: 'w1:p2',
      focused_pane_cwd: proj,
      selected_text: 'STALE line 1\nSTALE line 2',
      stale_content: true,
    },
    hudHome: f.home,
    env: f.env,
    stdin,
    stdout,
    now: () => new Date('2026-11-26T12:46:00.000Z'),
    onFrame: (lines) => frames.push(lines),
  });

  await until(() => frames.length > 0);
  const initial = frames[0].join('\n');
  assert.ok(initial.includes('UPDATED line 1'));
  assert.ok(initial.includes('UPDATED line 2'));
  assert.match(initial, /Content changed/);

  stdin.write('\r');
  const outcome = await sessionPromise;
  assert.equal(outcome.sent, true);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].text.includes('UPDATED line 1\nUPDATED line 2'));
});

test('pane content changing while composer is open refreshes excerpt before sending', async (t) => {
  const proj = fs.mkdtempSync(join(tmpdir(), 'hud-proj-drift-'));
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  const panes = [
    { pane_id: 'w1:p1', workspace_id: 'w1', cwd: proj, agent: 'claude', agent_status: 'idle' },
    { pane_id: 'w1:p2', workspace_id: 'w1', cwd: proj },
  ];
  let screen = 'ok line\ninitial error line\nfooter';
  const prompts = [];
  const f = await fakeFork(t, (method, params) => {
    if (method === 'ping') return guardedPong;
    if (method === 'pane.list') return { result: { type: 'pane_list', panes } };
    if (method === 'pane.get') return { result: { type: 'pane_info', pane: panes.find((p) => p.pane_id === params.pane_id) } };
    if (method === 'pane.read') return { result: { type: 'pane_read', read: { text: screen } } };
    if (method === 'agent.prompt') {
      prompts.push(params);
      return prompted;
    }
    return { error: { code: 'unsupported' } };
  });

  const { stdin, stdout } = fakeTtyStreams(80, 18);
  const frames = [];
  const sessionPromise = runComposerSession({
    context: {
      workspace_id: 'w1',
      focused_pane_id: 'w1:p2',
      focused_pane_cwd: proj,
      selected_text: 'initial error line',
    },
    hudHome: f.home,
    env: f.env,
    stdin,
    stdout,
    now: () => new Date('2026-11-26T12:47:00.000Z'),
    onFrame: (lines) => frames.push(lines),
  });

  await until(() => frames.length > 0);
  // Pane content changes while user is typing in the composer.
  screen = 'ok line\nreplaced error line\nfooter';
  stdin.write('still failing?\r');
  await until(() => frames.some((lines) => lines.join('\n').includes('replaced error line')));
  assert.equal(prompts.length, 0);

  stdin.write('\r');
  const outcome = await sessionPromise;
  assert.equal(outcome.sent, true);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].text.includes('replaced error line'));
  assert.ok(!prompts[0].text.includes('initial error line'));
});

for (const [language, context, title] of [
  ['en', {}, 'No selection to send — select text with the mouse first.'],
  ['zh', { selected_text: ' \n\t ' }, '没有可发送的选中内容，请先用鼠标选中文本。'],
]) {
  test(`plugin action shows an empty-selection toast in ${language} without sending`, async (t) => {
    const calls = [];
    const f = await fakeFork(t, (method, params) => {
      calls.push({ method, params });
      return { result: { type: 'notification_show', shown: true, reason: 'shown' } };
    });
    fs.writeFileSync(f.env.HUD_SETTINGS_PATH, JSON.stringify({ language }));
    const action = spawn(process.execPath, [join(root, 'integrations/herdr/plugin/action.mjs')], {
      env: {
        ...f.env,
        LC_ALL: language === 'en' ? 'zh_CN.UTF-8' : 'C',
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context),
      },
    });
    assert.deepEqual(await once(action, 'close'), [0, null]);
    assert.deepEqual(calls, [{ method: 'notification.show', params: { title } }]);
    assert.equal(fs.existsSync(join(f.home, 'select-send')), false);
    assert.equal(fs.existsSync(join(f.home, 'panel-actions.jsonl')), false);
  });
}

test('plugin action logs the empty-selection hint when herdr does not show the toast', async (t) => {
  const f = await fakeFork(t, () => ({ result: { type: 'notification_show', shown: false, reason: 'disabled' } }));
  const action = spawn(process.execPath, [join(root, 'integrations/herdr/plugin/action.mjs')], {
    env: { ...f.env, LC_ALL: 'C', HERDR_PLUGIN_CONTEXT_JSON: '{}' },
  });
  let stderr = '';
  action.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  assert.deepEqual(await once(action, 'close'), [0, null]);
  assert.match(stderr, /No selection to send/);
});

test('plugin action toasts a popup failure, removes the handoff and does not send', async (t) => {
  const calls = [];
  const f = await fakeFork(t, (method, params) => {
    calls.push({ method, params });
    if (method === 'plugin.pane.open') {
      return { error: { code: 'popup_open_denied', message: 'Popup unavailable' } };
    }
    return { result: { type: 'notification_show', shown: true, reason: 'shown' } };
  });
  const action = spawn(process.execPath, [join(root, 'integrations/herdr/plugin/action.mjs')], {
    env: { ...f.env, LC_ALL: 'C', HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ selected_text: 'example excerpt' }) },
  });
  assert.deepEqual(await once(action, 'close'), [1, null]);
  assert.deepEqual(calls.map(({ method }) => method), ['plugin.pane.open', 'notification.show']);
  assert.deepEqual(calls[1].params, {
    title: 'Could not open the selection composer.',
    body: 'popup_open_denied: Popup unavailable',
  });
  assert.equal(fs.existsSync(calls[0].params.env.HUD_SELECT_SEND_FILE), false);
  assert.equal(fs.existsSync(join(f.home, 'panel-actions.jsonl')), false);
});

test('ui_busy keeps a private selection draft for retry and preserves the advisor reopen binding', async t => {
  const opens = [];
  let busy = true;
  const f = await fakeFork(t, (method, params) => {
    assert.equal(method, 'plugin.pane.open');
    opens.push(params);
    return busy ? { error: { code: 'ui_busy', message: 'Another popup is open' } } : { result: { type: 'ok' } };
  });
  const env = { ...f.env, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ selected_text: '+ synthetic guard', focused_pane_id: 'w1:p2' }) };
  const first = await handleSelectionAction(f.home, env);
  assert.equal(first.reason, 'ui_busy');
  assert.equal(fs.statSync(first.handoffFile).mode & 0o777, 0o600);
  assert.deepEqual(await retrySelectionAction(f.home, f.env), { opened: false, reason: 'ui_busy' });
  assert.equal((await openAdvisorPopup('excerpt-id', f.env)).error, 'ui_busy');
  busy = false;
  assert.equal(await selectSendCommand(['--recover-draft'], { env: f.env }), 0);
  assert.equal(readAndRemoveSelectionHandoff(opens.at(-1).env.HUD_SELECT_SEND_FILE).selected_text, '+ synthetic guard');
  assert.equal((await openAdvisorPopup('excerpt-id', f.env)).ok, true);
  assert.deepEqual(opens.at(-1).env, opens[2].env);
});

test('empty selection makes no handoff and Esc cancels without sending', async (t) => {
  const calls = [];
  const f = await fakeFork(t, (method, params) => {
    calls.push({ method, params });
    if (method === 'plugin.pane.open') return { result: { type: 'ok' } };
    return guardedPong;
  });

  for (const selected_text of [undefined, '', '   \n\t  ']) {
    const res = await handleSelectionAction(f.home, {
      ...f.env,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: 'w1:p2', ...(selected_text !== undefined ? { selected_text } : {}) }),
    });
    assert.equal(res.opened, false);
    assert.equal(res.reason, 'empty_selection');
  }
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(join(f.home, 'select-send')), false);

  // Non-empty selection opens popup with private 0600 handoff file.
  const action = spawn(process.execPath, [join(root, 'integrations/herdr/plugin/action.mjs')], {
    env: {
      ...f.env,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: 'w1:p2', selected_text: 'failing line' }),
    },
  });
  assert.deepEqual(await once(action, 'close'), [0, null]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'plugin.pane.open');
  assert.equal(calls[0].params.plugin_id, 'hud.select-send');
  assert.equal(calls[0].params.entrypoint, 'composer');
  assert.equal(calls[0].params.placement, 'popup');
  const file = calls[0].params.env.HUD_SELECT_SEND_FILE;
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const loaded = readAndRemoveSelectionHandoff(file);
  assert.equal(loaded.selected_text, 'failing line');
  assert.equal(fs.existsSync(file), false);

  // Esc in composer cancels with zero deliveries.
  const { stdin, stdout } = fakeTtyStreams(60, 12);
  const frames = [];
  const cancelled = runComposerSession({
    context: { focused_pane_id: 'w1:p2', selected_text: 'failing line' },
    hudHome: f.home,
    env: f.env,
    stdin,
    stdout,
    onFrame: (lines) => frames.push(lines),
  });
  await until(() => frames.length > 0);
  stdin.write('\x1b');
  const out = await cancelled;
  assert.equal(out.sent, false);
  assert.equal(out.code, 0);
});

test('composer renderer keeps exact columns, escapes external text once, respects NO_COLOR and EN/ZH', () => {
  const prevLang = setLanguage('en');
  try {
    setDisplayConfig({ theme: 'none' });
    const state = createComposerState({
      source: {
        project: 'demo\x1b[31m',
        projectRoot: '/tmp/demo',
        pane: 'w1:p2',
        job: 'j0000000000000001',
        role: 'imp',
        time: '2026-11-26T12:00:00.000Z',
      },
      targetPane: 'w1:p1',
      targetAgent: 'claude',
      excerpt: normalizeSelectionExcerpt('line 1\nline 2\twith\x1b[31mraw\x1b[0m'),
      stale: true,
    });

    for (const [width, height] of [[40, 8], [60, 12], [80, 18], [120, 20]]) {
      const lines = renderSelectSendComposer(state, { width, height, nowMs: 1_700_000_000_000 });
      assert.equal(lines.length, height);
      for (const line of lines) {
        assert.equal(visualLength(line), width, `width mismatch at ${width}x${height}`);
        assert.equal(line.includes('\x1b'), false, 'theme=none must emit zero ANSI escapes');
      }
    }

    const waiting = { ...state, phase: 'waiting' };
    const narrowWait = renderSelectSendComposer(waiting, { width: 20, height: 6, nowMs: 0 });
    assert.ok(narrowWait.includes('Waiting · Esc cancel'));
    assert.ok(narrowWait.every((line) => visualLength(line) === 20));

    setLanguage('zh');
    const zhWait = renderSelectSendComposer(waiting, { width: 80, height: 14, nowMs: 0 });
    assert.match(zhWait[1], /正在等待主会话清空输入行 · Esc 取消/);
    const zhLines = renderSelectSendComposer(state, { width: 80, height: 14, nowMs: 1_700_000_000_000 });
    assert.equal(zhLines.length, 14);
    for (const line of zhLines) assert.equal(visualLength(line), 80);
    assert.ok(zhLines.join('\n').includes('发送选中内容'));
    assert.ok(zhLines.join('\n').includes('摘录'));
    assert.ok(zhLines.join('\n').includes('问题：'));

    const advisor = { ...state, excerpt: '示例摘录', answer: { text: '因为有保护条件。\x1b[31m', at: state.source.time } };
    const conversation = renderAdvisorConversation(advisor, state, 'ready', 29, 8).lines;
    assert.equal(conversation.length, 8);
    assert.ok(conversation.every(line => visualLength(line) === 29 && !line.includes('\x1b')));
    assert.match(conversation.join('\n'), /摘录顾问[\s\S]*因为有保护条件/);

    // Key decoding and state editing.
    const dec = new ComposerKeyDecoder();
    let cur = state;
    for (const key of dec.push('hi!\x7f?\x1b[D!\x1b[B')) {
      cur = applyComposerKey(cur, key, 10).state;
    }
    assert.equal(cur.question, 'hi!?');
  } finally {
    setLanguage(prevLang);
  }
});

test('herdr plugin manifest is valid and points to shipped entrypoints', () => {
  const pluginDir = join(root, 'integrations/herdr/plugin');
  const manifest = toml.parse(fs.readFileSync(join(pluginDir, 'herdr-plugin.toml'), 'utf8'));
  assert.equal(manifest.id, 'hud.select-send');
  assert.equal(manifest.actions[0].id, 'send');
  assert.deepEqual(manifest.actions[0].contexts, ['selection']);
  assert.equal(manifest.actions[1].id, 'investigate');
  assert.equal(manifest.actions[1].title, 'Investigate this');
  assert.deepEqual(manifest.actions[1].contexts, ['pane']);
  assert.equal(manifest.panes[0].id, 'composer');
  assert.equal(manifest.panes[0].placement, 'popup');
  assert.equal(fs.existsSync(join(pluginDir, manifest.actions[0].command[1])), true);
  assert.equal(fs.existsSync(join(pluginDir, manifest.actions[1].command[1])), true);
  assert.equal(fs.existsSync(join(pluginDir, manifest.panes[0].command[1])), true);
});

test('investigate pane action reads visible output into handoff and handles empty panes and popup failures', async (t) => {
  const calls = [];
  let visibleText = '\n  FAIL test/auth.test.mjs  \n  Expected 200, got 500\n\n\n';
  let failPopup = false;
  const f = await fakeFork(t, (method, params) => {
    calls.push({ method, params });
    if (method === 'pane.read') return { result: { type: 'pane_read', read: { text: visibleText } } };
    if (method === 'plugin.pane.open') {
      return failPopup
        ? { error: { code: 'popup_open_denied', message: 'Popup unavailable' } }
        : { result: { type: 'ok' } };
    }
    if (method === 'notification.show') return { result: { type: 'notification_show', shown: true, reason: 'shown' } };
    return guardedPong;
  });

  const action = spawn(process.execPath, [join(root, 'integrations/herdr/plugin/investigate.mjs')], {
    env: {
      ...f.env,
      LC_ALL: 'C',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: 'w1', focused_pane_id: 'w1:p5' }),
    },
  });
  assert.deepEqual(await once(action, 'close'), [0, null]);
  assert.deepEqual(calls.map((c) => c.method), ['pane.read', 'plugin.pane.open']);
  assert.deepEqual(calls[0].params, { pane_id: 'w1:p5', source: 'visible', format: 'text', strip_ansi: true });
  assert.equal(calls[1].params.plugin_id, 'hud.select-send');
  assert.equal(calls[1].params.entrypoint, 'composer');
  const file = calls[1].params.env.HUD_SELECT_SEND_FILE;
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const loaded = readAndRemoveSelectionHandoff(file);
  assert.equal(loaded.mode, 'investigate');
  assert.equal(loaded.pane_id, 'w1:p5');
  assert.equal(loaded.default_question, DEFAULT_INVESTIGATE_LINE);
  assert.equal(loaded.selected_text, '  FAIL test/auth.test.mjs\n  Expected 200, got 500');

  // Empty visible output shows a toast and makes no handoff file.
  calls.length = 0;
  visibleText = '   \n\t\n  ';
  for (const [language, title] of [
    ['en', 'No visible pane output to send.'],
    ['zh', '窗格没有可发送的可见输出。'],
  ]) {
    calls.length = 0;
    fs.writeFileSync(f.env.HUD_SETTINGS_PATH, JSON.stringify({ language }));
    const emptyRun = spawn(process.execPath, [join(root, 'integrations/herdr/plugin/investigate.mjs')], {
      env: { ...f.env, LC_ALL: 'C', HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: 'w1:p5' }) },
    });
    assert.deepEqual(await once(emptyRun, 'close'), [0, null]);
    assert.deepEqual(calls.map((c) => c.method), ['pane.read', 'notification.show']);
    assert.deepEqual(calls[1].params, { title });
  }
  assert.equal(fs.readdirSync(join(f.home, 'select-send')).length, 0);

  // Popup open failure cleans up the handoff file and exits non-zero.
  calls.length = 0;
  visibleText = 'Error: connection refused';
  failPopup = true;
  fs.writeFileSync(f.env.HUD_SETTINGS_PATH, JSON.stringify({ language: 'en' }));
  const failed = spawn(process.execPath, [join(root, 'integrations/herdr/plugin/investigate.mjs')], {
    env: { ...f.env, LC_ALL: 'C', HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: 'w1:p5' }) },
  });
  assert.deepEqual(await once(failed, 'close'), [1, null]);
  assert.deepEqual(calls.map((c) => c.method), ['pane.read', 'plugin.pane.open', 'notification.show']);
  assert.equal(fs.existsSync(calls[1].params.env.HUD_SELECT_SEND_FILE), false);
  assert.deepEqual(calls[2].params, {
    title: 'Could not open the investigate composer.',
    body: 'popup_open_denied: Popup unavailable',
  });

  // Missing pane ID returns cleanly without touching disk.
  const noPane = await handleInvestigatePaneAction(f.home, { ...f.env, HERDR_PLUGIN_CONTEXT_JSON: '{}' });
  assert.equal(noPane.opened, false);
  assert.equal(noPane.reason, 'no_pane');
});

test('investigate pane sends visible region once with source to chosen working job, binds answer, and refuses closed targets', { timeout: 15_000 }, async (t) => {
  const a = 'j000000000000001a', b = 'j000000000000001b', c = 'j000000000000001c';
  const main = 'w1:p1', leftA = 'w1:p2', leftB = 'w1:p3', leftC = 'w1:p4', testPane = 'w1:p5';
  let panes = [];
  const prompts = [];
  const paneReads = [];
  const visibleOutput = 'FAIL test/auth.test.mjs\n  AssertionError: expected 200 to equal 500\n\n\n';
  const f = await fakeFork(t, (method, params) => {
    if (method === 'ping') return guardedPong;
    if (method === 'pane.list') return { result: { panes } };
    if (method === 'pane.get') return { result: { pane: panes.find((p) => p.pane_id === params.pane_id) } };
    if (method === 'pane.read') {
      paneReads.push(params);
      return { result: { type: 'pane_read', read: { text: visibleOutput } } };
    }
    if (method === 'plugin.pane.open') return { result: { type: 'ok' } };
    if (method === 'agent.prompt') {
      prompts.push(params);
      return prompted;
    }
    return { error: { code: 'unsupported' } };
  });

  const project = join(f.dir, 'project');
  fs.mkdirSync(project);
  const initialPanes = [
    { pane_id: main, cwd: project, workspace_id: 'w1', agent: 'claude', agent_status: 'idle' },
    { pane_id: leftA, cwd: project, workspace_id: 'w1', agent: 'pi', agent_status: 'working' },
    { pane_id: leftB, cwd: project, workspace_id: 'w1', agent: 'pi', agent_status: 'working' },
    { pane_id: leftC, cwd: project, workspace_id: 'w1', agent: 'pi', agent_status: 'idle' },
    { pane_id: testPane, cwd: project, workspace_id: 'w1' },
  ];
  panes = initialPanes;

  const writeWorker = (id, leftPane, primary, state, info) => {
    const dir = writeJob(f.home, id, {
      callerPane: main,
      leftPane,
      primary,
      projectRoot: project,
      socketPath: f.socketPath,
      createdAt: new Date().toISOString(),
      ...info,
    });
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state }));
    return dir;
  };
  const dirA = writeWorker(a, leftA, 'agent-a', 'working', { ticket: 'auth/01' });
  const dirB = writeWorker(b, leftB, 'agent-b', 'working', { role: 'reviewer', packageName: 'auth-tests' });
  writeWorker(c, leftC, 'agent-c', 'closed', { ticket: 'auth/00' });

  const cache = getJobIndexCache(f.home);
  const excerpts = () => readSelectionExcerpts(f.home, cache, { project });
  const run = async (script, env) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      env: { ...f.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: t.signal,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  };

  // Trigger the real investigate action -> handoff file -> composer session.
  const opened = await handleInvestigatePaneAction(f.home, {
    ...f.env,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: 'w1', focused_pane_id: testPane, focused_pane_cwd: project }),
  });
  assert.equal(opened.opened, true);
  assert.ok(paneReads.some((p) => p.pane_id === testPane && p.source === 'visible'));

  const sendResult = await run(`
    import assert from 'node:assert/strict';
    import { PassThrough } from 'node:stream';
    import { runComposerSession } from './dist/cli/select-send.js';
    import { readAndRemoveSelectionHandoff } from './dist/roles/select-send.js';
    const context = readAndRemoveSelectionHandoff(process.env.HANDOFF);
    const stdin = new PassThrough(), stdout = new PassThrough();
    const input = text => queueMicrotask(() => stdin.write(text));
    let stage = 0;
    const result = await runComposerSession({
      context,
      hudHome: process.env.HUD_HOME,
      env: process.env,
      stdin,
      stdout,
      onFrame(lines, state) {
        const screen = lines.join('\\n');
        if (stage === 0) {
          assert.equal(state.mode, 'investigate');
          assert.equal(state.picker, 0);
          assert.match(screen, /Choose working job/);
          assert.doesNotMatch(screen, /Main:/);
          assert.doesNotMatch(screen, /auth\\/00/);
          const at = state.jobs.findIndex(job => job.job === process.env.TARGET);
          assert.notEqual(at, -1);
          stage++;
          input('\\x1b[B'.repeat(at) + '\\r');
        } else if (stage === 1 && state.picker === null && state.targetJob?.job === process.env.TARGET) {
          assert.match(screen, /Investigate pane ->/);
          assert.match(screen, /FAIL test\\/auth\\.test\\.mjs/);
          assert.match(screen, /Question: Investigate this/);
          stage++;
          input('\\r');
        }
      },
    });
    assert.equal(stage, 2);
    console.log(JSON.stringify(result));
  `, { HANDOFF: opened.handoffFile, TARGET: b });

  assert.equal(sendResult.sent, true);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].target, 'agent-b');
  const [record] = excerpts();
  assert.equal(record.target, b);
  assert.equal(record.delivery, 'queued');
  assert.equal(record.source.pane, testPane);
  assert.equal(record.source.job, null);
  assert.equal(record.question, DEFAULT_INVESTIGATE_LINE);
  assert.equal(record.excerpt, 'FAIL test/auth.test.mjs\n  AssertionError: expected 200 to equal 500');
  assert.ok(prompts[0].text.includes(`Excerpt ID: ${record.id}`));
  assert.ok(prompts[0].text.includes(`pane=${testPane}`));
  assert.ok(prompts[0].text.includes('FAIL test/auth.test.mjs\n  AssertionError: expected 200 to equal 500'));
  assert.ok(prompts[0].text.includes('Question: Investigate this'));

  // Even after the failing test pane closes, the worker's answer binds back and shows on the excerpt cards.
  panes = [initialPanes[0], initialPanes[1], initialPanes[2]];
  const replyOut = await run(`
    import { callWorkerTool } from './dist/worker/tools.js';
    console.log(JSON.stringify(await callWorkerTool('hud_progress', JSON.parse(process.env.REPLY))));
  `, { HUD_JOB_DIR: dirB, REPLY: JSON.stringify({ message: 'Missing null guard in auth middleware', reply_to: record.id }) });
  assert.equal(replyOut.ok, true);

  const view = new PanelExecution(f.home, main, f.env, () => {});
  t.after(() => view.dispose());
  view.sync(project, false);
  await view.refresh(`thin-job:${b}`);
  const worker = view.board().workers.find((w) => w.id === `thin-job:${b}`);
  const board = executionRows(view.view(project), undefined, 80, Date.now());
  const card = board.filter((row) => row.item === `project:excerpt:${record.id}`).map((row) => row.text).join('\n');
  assert.match(card, /answered/);
  assert.match(card, /FAIL test\/auth\.test\.mjs/);
  assert.match(card, /Missing null guard in auth middleware/);
  const inspector = workInspectorRows(worker, 80, Date.now()).map((row) => row.text).join('\n');
  assert.match(inspector, /Investigate this/);
  assert.match(inspector, /Missing null guard in auth middleware/);

  // Closed target refusal #1: picked working job closes before Enter -> refused, never falls back to main or reopens.
  panes = initialPanes;
  const closedMidway = await run(`
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    import { PassThrough } from 'node:stream';
    import { runComposerSession } from './dist/cli/select-send.js';
    const stdin = new PassThrough(), stdout = new PassThrough();
    const input = text => queueMicrotask(() => stdin.write(text));
    let stage = 0;
    const result = await runComposerSession({
      context: { mode: 'investigate', workspace_id: 'w1', focused_pane_id: process.env.PANE, focused_pane_cwd: process.env.PROJECT },
      hudHome: process.env.HUD_HOME,
      env: process.env,
      stdin,
      stdout,
      onFrame(lines, state) {
        if (stage === 0) {
          const at = state.jobs.findIndex(job => job.job === process.env.TARGET);
          assert.notEqual(at, -1);
          stage++;
          input('\\x1b[B'.repeat(at) + '\\r');
        } else if (stage === 1 && state.targetJob?.job === process.env.TARGET) {
          writeFileSync(process.env.CLOSE_STATUS, JSON.stringify({ state: 'closed' }));
          stage++;
          input('\\r');
        } else if (stage === 2 && state.error?.startsWith('Target ended.')) {
          assert.doesNotMatch(lines.join('\\n'), /Enter sends to main/);
          assert.equal(state.targetJob, undefined);
          stage++;
          input('\\r'); // Pressing Enter again without picking a working job stays refused.
        } else if (stage === 3 && state.error === 'Choose a working job first.') {
          stage++;
          input('\\x1b');
        }
      },
    });
    assert.equal(stage, 4);
    console.log(JSON.stringify(result));
  `, { PANE: testPane, PROJECT: project, TARGET: b, CLOSE_STATUS: join(dirB, 'STATUS.json') });

  assert.equal(closedMidway.sent, false);
  assert.equal(prompts.length, 1, 'closed target must not deliver to worker or fall back to main');
  assert.equal(excerpts()[0].delivery, 'target ended');
  assert.equal(JSON.parse(fs.readFileSync(join(dirB, 'STATUS.json'), 'utf8')).state, 'closed');
  assert.deepEqual(cache.listJobIds().toSorted(), [a, b, c]);

  // Closed target refusal #2: when all project jobs are closed, Enter refuses and writes no excerpt.
  fs.writeFileSync(join(dirA, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
  const excerptCountBefore = excerpts().length;
  const noWorking = await run(`
    import assert from 'node:assert/strict';
    import { PassThrough } from 'node:stream';
    import { runComposerSession } from './dist/cli/select-send.js';
    const stdin = new PassThrough(), stdout = new PassThrough();
    const input = text => queueMicrotask(() => stdin.write(text));
    let stage = 0;
    const result = await runComposerSession({
      context: { mode: 'investigate', workspace_id: 'w1', focused_pane_id: process.env.PANE, focused_pane_cwd: process.env.PROJECT },
      hudHome: process.env.HUD_HOME,
      env: process.env,
      stdin,
      stdout,
      onFrame(lines, state) {
        if (stage === 0) {
          assert.equal(state.picker, null);
          assert.equal(state.jobs.length, 0);
          assert.match(lines.join('\\n'), /No working jobs found for this project/);
          stage++;
          input('\\r');
        } else if (stage === 1) {
          stage++;
          input('\\x1b');
        }
      },
    });
    assert.equal(stage, 2);
    console.log(JSON.stringify(result));
  `, { PANE: testPane, PROJECT: project });

  assert.equal(noWorking.sent, false);
  assert.equal(prompts.length, 1);
  assert.equal(excerpts().length, excerptCountBefore);
});

test('investigate composer renderer keeps exact columns, NO_COLOR, EN/ZH, picker cancel, and tail truncation', () => {
  const prevLang = setLanguage('en');
  try {
    setDisplayConfig({ theme: 'none' });
    const job = { job: 'j0000000000000009', launchId: 'launch-9', role: 'imp', ticket: 'fine-interact/02', nextTurnNote: true };
    const state = createComposerState({
      mode: 'investigate',
      source: {
        project: 'demo',
        projectRoot: '/tmp/demo',
        pane: 'w1:p5',
        job: null,
        role: null,
        time: '2026-11-26T12:00:00.000Z',
      },
      targetPane: 'w1:p1',
      targetAgent: 'claude',
      jobs: [job],
      excerpt: normalizePaneExcerpt('\n  FAIL line 1\n  FAIL line 2\n\n'),
      initialQuestion: DEFAULT_INVESTIGATE_LINE,
    });
    assert.equal(state.picker, 0);
    assert.equal(state.question, DEFAULT_INVESTIGATE_LINE);
    assert.equal(state.cursor, DEFAULT_INVESTIGATE_LINE.length);

    // Esc on the initial picker cancels without sending.
    assert.equal(applyComposerKey(state, { type: 'cancel' }).intent, 'cancel');

    for (const [width, height] of [[40, 8], [80, 14]]) {
      const pickerLines = renderSelectSendComposer(state, { width, height, nowMs: 0 });
      assert.equal(pickerLines.length, height);
      for (const line of pickerLines) {
        assert.equal(visualLength(line), width);
        assert.equal(line.includes('\x1b'), false);
      }
      assert.ok(pickerLines.join('\n').includes('Choose working job'));
      assert.doesNotMatch(pickerLines.join('\n'), /Main:|Ask an advisor|Note for next turn/);
    }

    // Choose job -> editor shows Investigate pane, Tab reopens picker, Esc returns to editor.
    const last = applyComposerKey(state, { type: 'end' }).state;
    assert.equal(last.picker, 0, 'the only target in Investigate is the working job');
    const picked = applyComposerKey(last, { type: 'enter' }).state;
    assert.equal(picked.picker, null);
    assert.equal(picked.targetJob, job);
    assert.equal(picked.targetAdvisor, false);
    assert.equal(picked.noteForNextTurn, false);
    const editorLines = renderSelectSendComposer(picked, { width: 80, height: 14, nowMs: 0 });
    for (const line of editorLines) assert.equal(visualLength(line), 80);
    assert.ok(editorLines.join('\n').includes('Investigate pane ->'));
    assert.ok(editorLines.join('\n').includes('Pane output (visible region to send)'));
    assert.ok(editorLines.join('\n').includes('Question: Investigate this'));

    const reopened = applyComposerKey(picked, { type: 'targets' }).state;
    assert.equal(reopened.picker, 0);
    const back = applyComposerKey(reopened, { type: 'cancel' });
    assert.equal(back.intent, 'none');
    assert.equal(back.state.picker, null);
    assert.equal(back.state.targetJob, job);

    setLanguage('zh');
    const zhPicker = renderSelectSendComposer(state, { width: 80, height: 12, nowMs: 0 });
    assert.ok(zhPicker.join('\n').includes('选择运行中的任务'));
    const zhEditor = renderSelectSendComposer(picked, { width: 80, height: 12, nowMs: 0 });
    for (const line of zhEditor) assert.equal(visualLength(line), 80);
    assert.ok(zhEditor.join('\n').includes('排查此窗格'));
    assert.ok(zhEditor.join('\n').includes('窗格输出（将发送可见区域）'));

    const trunc = normalizePaneExcerpt('old line\n' + 'x'.repeat(100) + '\nTAIL_MARKER', 50);
    assert.equal(trunc.truncated, true);
    assert.ok(trunc.text.startsWith('… (truncated)\n'));
    assert.ok(trunc.text.endsWith('TAIL_MARKER'));
    assert.ok(trunc.text.length <= 50);
  } finally {
    setLanguage(prevLang);
  }
});
