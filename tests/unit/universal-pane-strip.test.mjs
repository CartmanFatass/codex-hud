import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { parityFixture } from '../../dist-test/fixtures/pi-footer.js';
import { syntheticProc } from '../fixtures/local-load.mjs';
import { visualLength } from '../../dist/render/colors.js';
import { handleSettingsInput, renderSettingsPage, SETTING_ROWS } from '../../dist/render/settings-page.js';
import { defaultSettings } from '../../dist/settings.js';

const clientPanes = { claude: 'w4E:p1', pi: 'w4E:p2', agy: 'w4E:p3', worker: 'w4E:p4' };

async function fakeFork(t, path) {
  const panes = new Map(Object.values(clientPanes).map(pane => [pane, { width: 80, rows: 30 }]));
  const sockets = new Set(), subscribers = new Set(), history = [];
  const changes = new EventEmitter();
  const server = createServer(conn => {
    sockets.add(conn);
    conn.on('error', () => {});
    conn.on('close', () => { sockets.delete(conn); subscribers.delete(conn); });
    const lines = createInterface({ input: conn });
    lines.on('line', raw => {
      const { id, method, params } = JSON.parse(raw);
      const reply = result => conn.write(JSON.stringify({ id, result }) + '\n');
      if (method === 'ping') return reply({ type: 'pong', version: '0.9.5-hud.a26432a7', capabilities: { pane_strip: true } });
      if (method === 'events.subscribe') {
        assert.deepEqual(params.subscriptions, [{ type: 'pane.resized' }]);
        subscribers.add(conn);
        return reply({ type: 'subscription_started' });
      }
      assert.ok(method === 'pane.strip.set' || method === 'pane.strip.clear', method);
      assert.equal(params.position, 'bottom');
      const state = panes.get(params.pane_id);
      assert.ok(state, params.pane_id);
      const before = state.rows;
      state.rows = method === 'pane.strip.set' ? 29 : 30;
      const strip = { pane_id: params.pane_id, width: state.width, cols: state.width - 1, rows: state.rows };
      // The first text push's old reply must not overwrite a subsequent resize on the event socket.
      if (params.line && state.width === 40) setTimeout(() => reply({ type: 'pane_strip', strip }), 40);
      else reply({ type: 'pane_strip', strip });
      const entry = { method, ...params, ...strip };
      history.push(entry);
      changes.emit('request', entry);
      if (before !== state.rows) resize(params.pane_id, state.width);
    });
  }).listen(path);
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  function resize(pane_id, width) {
    const state = panes.get(pane_id);
    state.width = width;
    // cols deliberately differs: the bar spans the full inner width, not PTY cols.
    for (const conn of subscribers) conn.write(JSON.stringify({ event: 'pane.resized',
      data: { pane_id, width, cols: width - 1, rows: state.rows } }) + '\n');
  }
  function waitFor(predicate, from, label) {
    const found = history.slice(from).find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        changes.off('request', receive);
        reject(Error(`${label}: missing strip request after ${JSON.stringify(history.slice(from))}`));
      }, 5000);
      function receive(entry) {
        if (!predicate(entry)) return;
        clearTimeout(timeout);
        changes.off('request', receive);
        resolve(entry);
      }
      changes.on('request', receive);
    });
  }
  return { history, resize, waitFor };
}

async function connectMcp(t, env, clientName) {
  const mcp = spawn(process.execPath, ['packages/hud-mcp/bin/hud-mcp.mjs'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(mcp, 'exit');
  t.after(async () => { mcp.stdin.end(); await exited; });
  const lines = createInterface({ input: mcp.stdout });
  const stderr = [];
  mcp.stderr.on('data', chunk => stderr.push(chunk));
  const response = once(lines, 'line', { signal: AbortSignal.timeout(5000) });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: clientName } } }) + '\n');
  const [line] = await Promise.race([response, exited.then(([code]) => { throw Error(`MCP ${clientName}: exit ${code}: ${Buffer.concat(stderr)}`); })]);
  assert.equal(JSON.parse(line).result.serverInfo.name, 'hud-mcp-thin', Buffer.concat(stderr).toString());
  return async () => { mcp.stdin.end(); assert.equal((await exited)[0], 0, Buffer.concat(stderr).toString()); };
}

async function nativeLine(env, input, width) {
  const launcher = spawn(resolve('bin/hud-statusline'), ['--width', String(width)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(launcher, 'close');
  const out = [], err = [];
  launcher.stdout.on('data', chunk => out.push(chunk));
  launcher.stderr.on('data', chunk => err.push(chunk));
  launcher.stdin.end(JSON.stringify(input));
  assert.equal((await exited)[0], 0, Buffer.concat(err).toString());
  const text = Buffer.concat(out).toString().replace(/\n$/, '');
  assert.ok(text && !text.includes('HUD unavailable'));
  return text;
}

const payloads = {
  claude: { product: 'claude', cwd: '/synthetic/claude-project', model: { id: 'claude-sonnet-4-6' },
    context_window: { used_percentage: 42, context_window_size: 200000 }, rate_limits: { five_hour: { used_percentage: 83 } } },
  agy: { product: 'antigravity', cwd: '/synthetic/agy-project', model: { id: 'gemini-synthetic', display_name: 'Gemini Synthetic' },
    context_window: { used_percentage: 37, context_window_size: 1000000 }, quota: { 'gemini-5h': { remaining_fraction: .18, reset_time: '2099-01-01T00:00:00Z' } } },
};

function chooseStrip(draft, key) {
  const state = { draft, original: draft, selected: SETTING_ROWS.findIndex(row => row.key === key), offset: 0, message: '' };
  const frame = renderSettingsPage(state, 48, 24);
  assert.ok(frame.rows.includes(state.selected));
  return handleSettingsInput(state, { type: 'key', key: 'right' }, frame).state.draft;
}

test('each Settings toggle mirrors only its main client at exact fork widths, and off restores the PTY', async t => {
  const home = mkdtempSync(join(tmpdir(), 'universal-strip-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const hud = join(home, 'hud'), path = join(home, 'fork.sock'), settings = join(hud, 'hud-settings.json');
  mkdirSync(hud);
  const proc = syntheticProc(home);
  proc.write('meminfo', 'MemTotal: 9000 kB\nMemAvailable: 4000 kB\n');
  const fork = await fakeFork(t, path);
  const env = { PATH: process.env.PATH, HOME: home, HUD_HOME: hud, HERDR_ENV: '1', HERDR_SOCKET_PATH: path,
    HUD_STATUSLINE_PROC_ROOT: proc.root, HUD_THEME: 'terminal', TZ: 'UTC' };
  const inPane = client => ({ ...env, HERDR_PANE_ID: clientPanes[client] });
  const workerEnv = { ...inPane('worker'), HUD_JOB_DIR: join(hud, 'jobs', 'j0000000000000000') };
  mkdirSync(workerEnv.HUD_JOB_DIR, { recursive: true });
  const claudeClose = await connectMcp(t, inPane('claude'), 'claude-code');
  const agyClose = await connectMcp(t, inPane('agy'), 'antigravity-client');
  await connectMcp(t, workerEnv, 'claude-code');
  const pi = parityFixture({ name: 'pi-main', width: 80, env: inPane('pi'),
    work: { running: 2, queued: 1, roles: { imp: { running: 2, asking: 0 } } } });
  const worker = parityFixture({ name: 'pi-worker', width: 80, env: workerEnv });
  t.after(() => { pi.dispose(); worker.dispose(); });
  const reference = new Map();
  const native = async (client, width) => client === 'pi' ? pi.render(width)[0] :
    nativeLine(inPane(client), { ...payloads[client], email: 'unused@example.invalid' }, width);
  for (const client of ['claude', 'pi', 'agy'])
    for (const width of [40, 80, 120]) reference.set(`${client}:${width}`, await native(client, width));
  worker.render();
  const mailbox = join(hud, 'display', 'pane-strip-v1');
  assert.equal(existsSync(mailbox), false);
  await delay(1100); // Give all default-off sessions a settings tick.
  assert.deepEqual(fork.history, []);

  const keys = { claude: 'claudePaneStrip', pi: 'piPaneStrip', agy: 'agyPaneStrip' };
  for (const client of ['pi', 'claude', 'agy']) {
    const key = keys[client], pane = clientPanes[client];
    const enabled = chooseStrip(defaultSettings(), key);
    const from = fork.history.length;
    fork.resize(pane, 40);
    assert.deepEqual(Object.values(keys).map(k => enabled[k]), Object.values(keys).map(k => k === key));
    writeFileSync(settings, JSON.stringify(enabled), { mode: 0o600 });
    for (const c of Object.keys(keys)) assert.equal(await native(c, 80), reference.get(`${c}:80`), `${c} native line untouched`);
    await nativeLine(workerEnv, payloads.claude, 80);
    const initial = await fork.waitFor(row => row.pane_id === pane && row.line, from, `${client} initial 40`);
    assert.equal(initial.rows, 29);
    assert.equal(initial.line, reference.get(`${client}:40`), `${client} initial fork width`);
    for (const width of [80, 120]) {
      const start = fork.history.length;
      fork.resize(pane, width);
      const shown = await fork.waitFor(row => row.pane_id === pane && row.line, start, `${client} resize ${width}`);
      assert.equal(shown.line, reference.get(`${client}:${width}`), `${client} @ ${width}`);
      assert.ok(visualLength(shown.line) <= width);
    }
    assert.ok(fork.history.slice(from).every(row => row.pane_id === pane));
    const closing = fork.history.length;
    writeFileSync(settings, JSON.stringify(chooseStrip(enabled, key)));
    const cleared = await fork.waitFor(row => row.pane_id === pane && row.method === 'pane.strip.clear', closing, `${client} clear`);
    assert.equal(cleared.rows, 30);
    assert.equal(await native(client, 80), reference.get(`${client}:80`));
  }
  assert.deepEqual(fork.history.filter(row => row.method === 'pane.strip.clear').map(row => row.pane_id),
    ['pi', 'claude', 'agy'].map(c => clientPanes[c]));
  const samples = readdirSync(mailbox);
  assert.equal(samples.length, 2, 'only Claude and Antigravity use the mailbox');
  for (const name of samples) {
    const file = join(mailbox, name);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /unused@example\.invalid|context_window|rate_limits/);
  }
  await claudeClose();
  await agyClose();
});
