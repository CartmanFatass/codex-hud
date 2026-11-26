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
  deliverSelection,
  formatSelectionMessage,
  handleSelectionAction,
  normalizeSelectionExcerpt,
  readAndRemoveSelectionHandoff,
  resolveSelectionTarget,
} from '../../dist/roles/select-send.js';
import {
  applyComposerKey,
  createComposerState,
  renderSelectSendComposer,
} from '../../dist/render/select-send-composer.js';
import { ComposerKeyDecoder, runComposerSession, selectSendCommand } from '../../dist/cli/select-send.js';
import { panelActionLine } from '../../dist/collectors/panel-actions.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { visualLength } from '../../dist/render/colors.js';

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
else process.exit(2);
const c = net.createConnection(sock);
let buf = '';
c.on('connect', () => c.write(JSON.stringify({ id: 'cli', method, params }) + '\\n'));
c.on('data', d => {
  buf += d.toString('utf8');
  const nl = buf.indexOf('\\n');
  if (nl >= 0) { process.stdout.write(buf.slice(0, nl + 1)); c.destroy(); }
});
c.on('error', () => process.exit(1));
`,
    { mode: 0o755 }
  );
  const env = {
    ...process.env,
    HOME: join(dir, 'home'),
    HUD_HOME: home,
    HERDR_SOCKET_PATH: socketPath,
    HERDR_BIN_PATH: join(bin, 'herdr'),
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    NO_COLOR: '1',
  };
  return { dir, home, bin, socketPath, env };
}

function writeJob(home, id, { role = 'imp', callerPane, leftPane, projectRoot, socketPath, createdAt = '2026-11-26T10:00:00.000Z', reapedAt } = {}) {
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
    })
  );
  const sessionLines = [
    `LEFT=${leftPane}`,
    `ORCH=${callerPane}`,
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

test('empty selection does nothing and Esc cancels without sending', async (t) => {
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
  const opened = await handleSelectionAction(f.home, {
    ...f.env,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: 'w1:p2', selected_text: 'failing line' }),
  });
  assert.equal(opened.opened, true);
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
  assert.equal(manifest.panes[0].id, 'composer');
  assert.equal(manifest.panes[0].placement, 'popup');
  assert.equal(fs.existsSync(join(pluginDir, manifest.actions[0].command[1])), true);
  assert.equal(fs.existsSync(join(pluginDir, manifest.panes[0].command[1])), true);
});
