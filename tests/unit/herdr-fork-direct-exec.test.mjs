import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { isHudHerdrFork, isHudHerdrVersion } from '../../dist/runtime/herdr-socket.js';
import { directExecEnv } from '../../dist/mcp/dispatch/proc.js';
import { reapWorkerTree, rememberWorkerTree, tabTreeGrant } from '../../dist/roles/worker-tree.js';
import { procStat } from '../../dist/utils/proc.js';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { cliState, fixture, readCloseReaped, until, writeCliRole } from '../helpers/thin-mcp-harness.mjs';

const reapBin = resolve('packages/hud-mcp/bin/hud-reap.mjs');

test('fork detection recognizes -hud version suffix and rejects stock versions', async (t) => {
  assert.equal(isHudHerdrVersion('0.9.5-hud.3027f8dd'), true);
  assert.equal(isHudHerdrVersion('0.9.5-hud'), true);
  assert.equal(isHudHerdrVersion('0.9.5'), false);
  assert.equal(isHudHerdrVersion('0.9.5-preview.1'), false);
  assert.equal(isHudHerdrVersion(undefined), false);

  const root = fs.mkdtempSync(join(tmpdir(), 'hud-fork-ping-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let version = '0.9.5-hud.3027f8dd';
  const sock = join(root, 'herdr.sock');
  const server = createServer((conn) => {
    createInterface({ input: conn }).on('line', (line) => {
      const req = JSON.parse(line);
      if (req.method === 'ping') conn.end(JSON.stringify({ id: req.id, result: { type: 'pong', version, protocol: 22 } }) + '\n');
    });
  });
  server.listen(sock);
  await once(server, 'listening');
  t.after(() => new Promise((done) => server.close(done)));

  const prior = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = sock;
  try {
    assert.equal(await isHudHerdrFork(), true);
    version = '0.9.5';
    assert.equal(await isHudHerdrFork(), false);
  } finally {
    if (prior === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = prior;
  }
});

test('directExecEnv forwards HUD process env plus job vars and strips parent nesting vars', () => {
  const env = directExecEnv(
    { HUD_JOB_DIR: '/tmp/job', HUD_HOME: '/tmp/hud', GIT_OPTIONAL_LOCKS: '0' },
    {
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/home/synthetic',
      GOOGLE_CLOUD_PROJECT: 'synth',
      NVM_DIR: '/home/synthetic/.nvm',
      CODEX_HOME: '/home/synthetic/.codex',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CODEX_THREAD_ID: 'parent-thread',
      OMPCODE: '1',
      HUD_MCP_SURFACE: 'roles',
      HUD_MCP_PI_SESSION_ID: 'parent-pi',
      HUD_TAB_LAUNCH: 'stale-uuid',
      HUD_INVOCATION_TOKEN: 'stale-token',
      HERDR_PANE_ID: 'w4E:p1',
      HERDR_TAB_ID: 'w4E:t1',
      HERDR_WORKSPACE_ID: 'w4E',
    }
  );
  assert.equal(env.PATH, '/usr/local/bin:/usr/bin');
  assert.equal(env.GOOGLE_CLOUD_PROJECT, 'synth');
  assert.equal(env.NVM_DIR, '/home/synthetic/.nvm');
  assert.equal(env.HUD_JOB_DIR, '/tmp/job');
  assert.equal(env.HUD_HOME, '/tmp/hud');
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
  for (const stripped of [
    'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'OMPCODE',
    'HUD_MCP_SURFACE', 'HUD_MCP_PI_SESSION_ID', 'HUD_TAB_LAUNCH', 'HUD_INVOCATION_TOKEN',
    'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID',
  ]) {
    assert.equal(Object.hasOwn(env, stripped), false, `expected ${stripped} stripped`);
  }
});

/** Fake herdr fork socket + CLI state speaking 0.9.5-hud.3027f8dd (protocol 22). */
async function startForkHerdr(t, f, { reusedTabId = false } = {}) {
  const startRequests = [];
  const socketRequests = [];
  const subscriptions = [];
  const subscribers = new Set();
  const tabs = new Map(); // launch_id -> { tab_id, pane_id, name, label, kind, pid, pid_start_time, status, agent_session, closed }
  let seq = 0;

  const spawnAgentProcess = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
    t.after(() => { try { child.kill('SIGKILL'); } catch {} });
    const start = Number(procStat(child.pid).start);
    return { child, pid: child.pid, pid_start_time: start };
  };

  const server = createServer((conn) => {
    const client = { conn, types: new Set(), pane: null };
    const lines = createInterface({ input: conn });
    lines.on('line', (line) => {
      const req = JSON.parse(line);
      socketRequests.push(req);
      const reply = (result) => conn.write(JSON.stringify({ id: req.id, result }) + '\n');
      const err = (code, message = code) => conn.write(JSON.stringify({ id: req.id, error: { code, message } }) + '\n');
      if (req.method === 'ping') {
        reply({ type: 'pong', version: '0.9.5-hud.3027f8dd', protocol: 22 });
        return;
      }
      if (req.method === 'events.subscribe') {
        subscriptions.push(req.params);
        for (const sub of req.params?.subscriptions ?? []) {
          client.types.add(sub.type);
          if (sub.type === 'pane.agent_status_changed' && sub.pane_id) client.pane = sub.pane_id;
        }
        subscribers.add(client);
        reply({ type: 'subscription_started' });
        return;
      }
      if (req.method === 'agent.start') {
        startRequests.push(req.params);
        seq += 1;
        const tabNum = reusedTabId ? 2 : seq + 1;
        const tab_id = `w4E:t${tabNum}`;
        const pane_id = `w4E:p${tabNum}`;
        const launch_id = `launch_synth${seq.toString(16)}`;
        const terminal_id = `term_synth${seq.toString(16)}`;
        const proc = spawnAgentProcess();
        const entry = {
          tab_id, pane_id, launch_id, terminal_id,
          name: req.params.name, label: req.params.label, kind: req.params.kind,
          cwd: req.params.cwd, env: req.params.env,
          pid: proc.pid, pid_start_time: proc.pid_start_time, child: proc.child,
          status: 'working', closed: false,
          agent_session: { kind: 'id', value: `synthetic-${req.params.kind}-session-${seq}`, source: 'synthetic', agent: req.params.kind },
        };
        tabs.set(launch_id, entry);
        // If Pi, write STATUS.json with session metadata as pi-roles does on session_start.
        if (req.params.kind === 'pi' && req.params.env?.HUD_JOB_DIR) {
          const dir = req.params.env.HUD_JOB_DIR;
          const sf = join(dir, 'pi-session.jsonl');
          writeFixtureFile(sf, JSON.stringify({ type: 'session', id: `pi-sess-${seq}`, cwd: req.params.cwd }) + '\n');
          writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({
            version: 1, task_dir: dir, slot: 'primary', harness: 'pi', state: 'working',
            pid: proc.pid, pid_start_time: String(proc.pid_start_time),
            session_id: `pi-sess-${seq}`, session_file: sf,
          }));
        }
        reply({
          type: 'agent_started',
          agent: {
            terminal_id, launch_id, name: entry.name, agent: entry.kind,
            agent_status: 'unknown', workspace_id: 'w4E', tab_id, pane_id, focused: false, revision: 1,
          },
          argv: [req.params.executable, ...(req.params.argv ?? [])],
          tab: { tab_id, launch_id, terminal_id, workspace_id: 'w4E', number: tabNum, label: entry.label, focused: false, pane_count: 1, agent_status: 'unknown' },
          root_pane: { pane_id, terminal_id, launch_id, workspace_id: 'w4E', tab_id, focused: false, agent: entry.kind, agent_status: 'unknown', revision: 1 },
          pid: proc.pid,
          pid_start_time: proc.pid_start_time,
          launch_id,
        });
        return;
      }
      if (req.method === 'agent.get') {
        const entry = [...tabs.values()].reverse().find((e) => !e.closed && (e.name === req.params.target || e.pane_id === req.params.target));
        if (!entry) { err('agent_not_found'); return; }
        reply({
          type: 'agent_info',
          agent: {
            terminal_id: entry.terminal_id, launch_id: entry.launch_id, name: entry.name,
            pane_id: entry.pane_id, tab_id: entry.tab_id, agent: entry.kind,
            agent_status: entry.status, agent_session: entry.agent_session,
          },
        });
        return;
      }
      if (req.method === 'tab.get') {
        const entry = [...tabs.values()].reverse().find((e) => !e.closed && e.tab_id === req.params.tab_id);
        if (!entry) { err('tab_not_found'); return; }
        reply({ type: 'tab_info', tab: { tab_id: entry.tab_id, launch_id: entry.launch_id, terminal_id: entry.terminal_id, workspace_id: 'w4E', label: entry.label } });
        return;
      }
      if (req.method === 'pane.get') {
        const entry = [...tabs.values()].reverse().find((e) => !e.closed && e.pane_id === req.params.pane_id);
        if (!entry) { err('pane_not_found'); return; }
        reply({ type: 'pane_info', pane: { pane_id: entry.pane_id, tab_id: entry.tab_id, launch_id: entry.launch_id, workspace_id: 'w4E' } });
        return;
      }
      if (req.method === 'pane.process_info') {
        err('unexpected_process_info', 'fork path must not query pane.process_info');
        return;
      }
      reply({});
    });
    conn.on('error', () => {});
    lines.on('error', () => {});
    conn.on('close', () => { subscribers.delete(client); lines.close(); });
  });
  await new Promise((done) => server.listen(f.env.HERDR_SOCKET_PATH, done));
  f.onCleanup(() => {
    for (const c of subscribers) c.conn.destroy();
    return new Promise((done) => server.close(done));
  });

  const emit = (event, data) => {
    const line = JSON.stringify({ event, data }) + '\n';
    for (const c of subscribers) {
      if (c.types.has(event) || c.types.size === 0) {
        try { c.conn.write(line); } catch {}
      }
    }
  };

  return {
    startRequests,
    socketRequests,
    subscriptions,
    tabs,
    emit,
    hasWatcher: () => [...subscribers].some((c) => c.types.has('tab.closed') && !c.pane),
    emitPaneExited(entry, exitCode, signal = null, { closeOnZero = true } = {}) {
      try { entry.child.kill('SIGKILL'); } catch {}
      emit('pane.exited', {
        type: 'pane_exited',
        pane_id: entry.pane_id,
        workspace_id: 'w4E',
        launch_id: entry.launch_id,
        terminal_id: entry.terminal_id,
        exit_code: exitCode,
        signal,
      });
      if (closeOnZero && exitCode === 0 && !signal) {
        entry.closed = true;
        emit('tab.closed', {
          type: 'tab_closed',
          tab_id: entry.tab_id,
          workspace_id: 'w4E',
          launch_id: entry.launch_id,
          terminal_id: entry.terminal_id,
        });
      }
    },
    emitTabClosedRaw(tab_id, launch_id, terminal_id = 'term_stale') {
      emit('tab.closed', { type: 'tab_closed', tab_id, workspace_id: 'w4E', launch_id, terminal_id });
    },
    emitPaneExitedRaw(pane_id, launch_id, exit_code, signal = null) {
      emit('pane.exited', { type: 'pane_exited', pane_id, workspace_id: 'w4E', launch_id, terminal_id: 'term_stale', exit_code, signal });
    },
  };
}

test('fork CLI tab worker: direct exec, launch_id identity, pane.exited clean & crash, reused tab_id ignored', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { failedRetentionMs: 250 });
  const fork = await startForkHerdr(t, f, { reusedTabId: true });
  writeCliRole(f, 'forkcli', 60, true, 'claude');

  // 1) Launch first CLI job on the fork.
  const first = await f.call('hud_create', { role: 'forkcli', task: 'Synthetic fork CLI task 1.' });
  const dir1 = first.task_dir;
  assert.equal(fork.startRequests.length, 1);
  const req1 = fork.startRequests[0];
  assert.equal(req1.kind, 'claude');
  assert.equal(req1.on_exit, 'close_on_zero');
  assert.equal(req1.focus, false);
  assert.equal(req1.workspace_id, 'w4E');
  assert.equal(req1.cwd, f.root);
  assert.ok(req1.executable.endsWith('/claude'), `expected claude executable, got ${req1.executable}`);
  assert.equal(req1.env.HUD_JOB_DIR, dir1);
  assert.equal(req1.env.HUD_HOME, f.env.HUD_HOME);
  assert.equal(req1.env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(req1.env.HUD_TAB_LAUNCH, undefined);
  assert.equal(req1.env.HUD_INVOCATION_TOKEN, undefined);
  assert.equal(req1.env.CLAUDECODE, undefined);
  // Zero stock artifacts: no tab create, no witness/ZDOTDIR, no tab-shells.json.
  assert.equal(f.commands().some((c) => c.command === 'herdr' && c.args[0] === 'tab' && c.args[1] === 'create'), false);
  assert.equal(fs.existsSync(join(dir1, 'cli-invocations')), false);
  assert.equal(fs.existsSync(join(dir1, 'tab-shells.json')), false);

  const session1 = Object.fromEntries(fs.readFileSync(join(dir1, 'SESSION.txt'), 'utf8').trim().split('\n').map((l) => l.split('=')));
  const entry1 = fork.tabs.get(session1.LAUNCH_ID);
  assert.ok(entry1);
  assert.equal(session1.DIRECT_EXEC, '1');
  assert.equal(session1.LAUNCH, undefined);
  assert.equal(Number(session1.PID), entry1.pid);
  assert.equal(session1.PID_START, String(entry1.pid_start_time));

  // Supervisor adopts exact (pid, pid_start_time) from launch without pane.process_info.
  await until(() => cliState(dir1)?.supervisor_pid && cliState(dir1)?.pid === entry1.pid && cliState(dir1)?.pid_start_time === String(entry1.pid_start_time), t.signal);
  assert.equal(fork.socketRequests.some((r) => r.method === 'pane.process_info'), false);

  // Stale tab.closed & pane.exited for the SAME public tab_id/pane_id with another launch_id are ignored.
  const tabProbesBefore = fork.socketRequests.filter((r) => r.method === 'tab.get' || r.method === 'pane.get').length;
  fork.emitTabClosedRaw(entry1.tab_id, 'launch_stale_000');
  fork.emitPaneExitedRaw(entry1.pane_id, 'launch_stale_000', 1);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(cliState(dir1).state, 'working');
  assert.equal(fork.socketRequests.filter((r) => r.method === 'tab.get' || r.method === 'pane.get').length, tabProbesBefore);

  // Clean exit (exit_code: 0) with report -> settled & reaped; tab closed by close_on_zero.
  writeFixtureFile(join(dir1, 'report.md'), 'Synthetic fork CLI report.\n');
  fork.emitPaneExited(entry1, 0, null);
  await until(() => cliState(dir1)?.state === 'closed' && Boolean(readCloseReaped(first)), t.signal);
  assert.equal(cliState(dir1).exit_reason, 'settled');
  assert.equal(cliState(dir1).runner_exit_code, 0);

  // 2) Launch second CLI job on the SAME reused public tab_id (w4E:t2) and crash with exit_code: 1.
  const second = await f.call('hud_create', { role: 'forkcli', task: 'Synthetic fork CLI crash.' });
  const dir2 = second.task_dir;
  const session2 = Object.fromEntries(fs.readFileSync(join(dir2, 'SESSION.txt'), 'utf8').trim().split('\n').map((l) => l.split('=')));
  const entry2 = fork.tabs.get(session2.LAUNCH_ID);
  assert.equal(entry2.tab_id, entry1.tab_id, 'test reuses public tab_id');
  assert.notEqual(entry2.launch_id, entry1.launch_id);
  await until(() => cliState(dir2)?.supervisor_pid && cliState(dir2)?.pid === entry2.pid && fork.hasWatcher(), t.signal);

  // Delayed close of the first job's launch_id on the SAME public tab_id must not affect job 2.
  fork.emitTabClosedRaw(entry2.tab_id, entry1.launch_id);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(cliState(dir2).state, 'working');

  // Crash with exit_code: 1 (even if a partial report exists): judged failed, tab stays open until failure retention!
  writeFixtureFile(join(dir2, 'report.md'), 'Partial crashed output.\n');
  const crashedAt = Date.now();
  fork.emitPaneExited(entry2, 1, null);
  await until(() => cliState(dir2)?.state === 'failed', t.signal);
  assert.equal(cliState(dir2).exit_reason, 'worker exited (code 1)');
  assert.equal(cliState(dir2).runner_exit_code, 1);
  assert.equal(entry2.closed, false, 'crashed tab stays open under close_on_zero');
  await until(() => Boolean(readCloseReaped(second)), t.signal);
  assert.ok(Date.parse(readCloseReaped(second)) >= crashedAt + 200, 'failed job held until retention deadline');
});

test('fork Pi tab worker: execs pi-role directly without --args-json; handles clean exit, crash retention, and launch_id isolation', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { failedRetentionMs: 250 });
  const fork = await startForkHerdr(t, f, { reusedTabId: true });

  // 1) Launch Pi tab worker on the fork.
  const first = await f.call('hud_create', { role: 'imp', task: 'Synthetic fork Pi task.' });
  const dir1 = first.task_dir;
  assert.equal(fork.startRequests.length, 1);
  const req1 = fork.startRequests[0];
  assert.equal(req1.kind, 'pi');
  assert.equal(req1.on_exit, 'close_on_zero');
  assert.equal(req1.focus, false);
  assert.ok(req1.executable.endsWith('/pi-role'), `expected pi-role executable, got ${req1.executable}`);
  assert.equal(req1.argv.includes('--args-json'), false, 'direct-exec pi-role must not pass --args-json');
  assert.ok(req1.argv.includes('--task-dir'));
  assert.ok(req1.argv.includes(dir1));
  assert.equal(req1.env.HUD_JOB_DIR, dir1);
  assert.equal(req1.env.HUD_TAB_LAUNCH, undefined);
  // Zero stock pi-role --args-json subprocess or tab create or tab-shells.json.
  assert.equal(f.commands().some((c) => c.command === 'pi-role'), false);
  assert.equal(f.commands().some((c) => c.command === 'herdr' && c.args[0] === 'tab' && c.args[1] === 'create'), false);
  assert.equal(fs.existsSync(join(dir1, 'tab-shells.json')), false);

  const session1 = Object.fromEntries(fs.readFileSync(join(dir1, 'SESSION.txt'), 'utf8').trim().split('\n').map((l) => l.split('=')));
  const entry1 = fork.tabs.get(session1.LAUNCH_ID);
  assert.equal(session1.DIRECT_EXEC, '1');
  assert.equal(Number(session1.PID), entry1.pid);
  assert.equal(cliState(dir1).session_id, 'pi-sess-1', 'Pi STATUS.json session_id preserved on fork launch');

  // Watcher subscribes to both tab.closed and pane.exited on the fork.
  await until(() => fork.subscriptions.some((s) =>
    s.subscriptions?.some((x) => x.type === 'tab.closed') && s.subscriptions?.some((x) => x.type === 'pane.exited')), t.signal);

  // Stale tab.closed / pane.exited with different launch_id on SAME tab_id is ignored.
  fork.emitTabClosedRaw(entry1.tab_id, 'launch_other_pi');
  fork.emitPaneExitedRaw(entry1.pane_id, 'launch_other_pi', 1);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(cliState(dir1).state, 'working');

  // Crash Pi worker with exit_code: 2 -> watcher marks failed from pane.exited, keeps tab open until retention, then reaps.
  const crashedAt = Date.now();
  fork.emitPaneExited(entry1, 2, null);
  await until(() => cliState(dir1)?.state === 'failed', t.signal);
  assert.equal(cliState(dir1).exit_reason, 'worker exited (code 2)');
  assert.equal(cliState(dir1).runner_exit_code, 2);
  assert.equal(entry1.closed, false);
  await until(() => Boolean(readCloseReaped(first)), t.signal);
  assert.ok(Date.parse(readCloseReaped(first)) >= crashedAt + 200);

  // 2) Clean Pi exit (exit_code: 0 with report & output_written: true) -> closes & reaps cleanly.
  const second = await f.call('hud_create', { role: 'imp', task: 'Synthetic fork Pi clean.' });
  const dir2 = second.task_dir;
  const session2 = Object.fromEntries(fs.readFileSync(join(dir2, 'SESSION.txt'), 'utf8').trim().split('\n').map((l) => l.split('=')));
  const entry2 = fork.tabs.get(session2.LAUNCH_ID);
  await until(() => fork.hasWatcher(), t.signal);
  writeFixtureFile(join(dir2, 'report.md'), 'Synthetic clean Pi report.\n');
  writeFixtureFile(join(dir2, 'STATUS.json'), JSON.stringify({
    ...cliState(dir2), state: 'working', output_written: true,
  }));
  fork.emitPaneExited(entry2, 0, null);
  await until(() => cliState(dir2)?.state === 'closed' && Boolean(readCloseReaped(second)), t.signal);
  assert.equal(entry2.closed, true);
});

test('reap-tab direct-exec: exact PID+start, launch_id tab matching, zero shell checks, cleans detached descendants after close_on_zero', async (t) => {
  const fakeHerdr = String.raw`
const fs = require('node:fs');
const path = process.env.STATE;
const s = JSON.parse(fs.readFileSync(path));
const args = process.argv.slice(2), [kind, op, target] = args;
fs.appendFileSync(path + '.log', JSON.stringify(args) + '\n');
const out = result => console.log(JSON.stringify({ result }));
if (op === 'process-info') throw Error('direct-exec reap must never call pane process-info');
if (op === 'list') out({ [kind + 's']: s[kind + 's'] });
else if (kind === 'agent' && op === 'get') out({ agent: s.agents.find(a => a.pane_id === target) });
else if (kind === 'tab' && op === 'close') { s.tabs = s.tabs.filter(t => t.tab_id !== target); out({}); }
else throw Error('unexpected fake herdr command: ' + args);
fs.writeFileSync(path, JSON.stringify(s));`;

  function makeDirectFixture(t, { tabs, panes, agents, label = 'synthetic', orch = 'main-pane', pid, start, statusPid, statusStart } = {}) {
    const root = fs.mkdtempSync(join(tmpdir(), 'hud-reap-direct-'));
    const dir = join(root, 'job');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(dir);
    fs.writeFileSync(join(root, 'herdr'), `#!${process.execPath}\n${fakeHerdr}`, { mode: 0o700 });
    const state = join(root, 'state'), log = `${state}.log`;
    const launchId = 'launch_direct_1';
    fs.writeFileSync(state, JSON.stringify({
      tabs: tabs ?? [{ tab_id: 'worker-tab', launch_id: launchId, label }],
      panes: panes ?? [
        { pane_id: 'worker-pane', tab_id: 'worker-tab', launch_id: launchId, agent: 'claude' },
        { pane_id: 'main-pane', tab_id: 'main-tab', launch_id: 'launch_main', agent: 'claude' },
      ],
      agents: agents ?? [],
    }));
    // Deliberately NO tab-shells.json and NO witness.json!
    fs.writeFileSync(
      join(dir, 'SESSION.txt'),
      `LAUNCH_ID=${launchId}\nDIRECT_EXEC=1\nPID=${pid}\nPID_START=${start}\nTAB=worker-tab\nTAB_NAME=synthetic\nLEFT=worker-pane\nORCH=${orch}\nPRIMARY=worker\n`
    );
    fs.writeFileSync(
      join(dir, 'STATUS.json'),
      JSON.stringify({ version: 1, task_dir: dir, slot: 'primary', harness: 'cli', agent: 'claude', state: 'working', pid: statusPid ?? pid, pid_start_time: statusStart ?? start })
    );
    const env = { ...process.env, HOME: root, HUD_HOME: root, STATE: state, PATH: root };
    const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l)) : [];
    return { dir, env, calls, state, launchId, run: () => spawnSync(process.execPath, [reapBin, dir], { env, encoding: 'utf8', timeout: 15000 }) };
  }

  // 1) Refuses when STATUS.json PID does not match direct-exec SESSION.txt PID.
  {
    const child = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
    t.after(() => child.kill('SIGKILL'));
    const start = procStat(child.pid).start;
    const f = makeDirectFixture(t, { pid: child.pid, start, statusPid: child.pid + 999 });
    const r = f.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not match direct-exec launch/);
    assert.equal(f.calls().length, 0);
  }

  // 1b) Refuses renamed tab (preserving single-line watch-runtime diagnostic) and orchestrator tab.
  for (const [opts, pattern] of [
    [{ label: 'renamed-by-user' }, /: TAB worker-tab name changed or missing; not closing\n$/],
    [{ orch: 'worker-pane' }, /orchestrator tab; not closing/],
  ]) {
    const child = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
    t.after(() => child.kill('SIGKILL'));
    const start = procStat(child.pid).start;
    const f = makeDirectFixture(t, { pid: child.pid, start, ...opts });
    const r = f.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, pattern);
    assert.equal(f.calls().some((c) => c[1] === 'close'), false);
    assert.equal(procStat(child.pid)?.start, start);
  }

  // 2) Never closes a reused public tab_id carrying a DIFFERENT launch_id.
  {
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const start = procStat(dead.pid)?.start ?? '1';
    await once(dead, 'exit');
    const f = makeDirectFixture(t, {
      pid: dead.pid, start,
      tabs: [{ tab_id: 'worker-tab', launch_id: 'launch_reused_other', label: 'synthetic' }],
      panes: [{ pane_id: 'worker-pane', tab_id: 'worker-tab', launch_id: 'launch_reused_other', agent: 'claude' }],
    });
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.calls().some((c) => c[1] === 'close'), false, 'must not close reused tab with different launch_id');
  }

  // 3) Signals live worker by exact (pid, start) and closes remaining tab with zero pane.process_info calls.
  {
    const child = spawn(process.execPath, ['-e', 'console.log("up"); setInterval(() => {}, 60000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
    t.after(() => child.kill('SIGKILL'));
    await once(child.stdout, 'data');
    const start = procStat(child.pid).start;
    const exited = once(child, 'exit');
    const f = makeDirectFixture(t, { pid: child.pid, start });
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(await exited, [null, 'SIGTERM']);
    assert.ok(f.calls().some((c) => c[0] === 'tab' && c[1] === 'close' && c[2] === 'worker-tab'));
    assert.match(r.stdout, new RegExp(`^tree-owner ${child.pid}:${start}`, 'm'));
    assert.equal(fs.existsSync(join(f.dir, 'STATUS.json.stop-requested')), true);
  }

  // 4) Already-closed tab (close_on_zero) still cleans captured detached descendants via worker-tree!
  {
    const rootProc = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const d = spawn('/bin/sleep', ['600'], { detached: true, stdio: 'ignore' });
      d.unref();
      console.log(d.pid);
      process.stdin.resume();
    `], { stdio: ['pipe', 'pipe', 'ignore'] });
    t.after(() => rootProc.kill('SIGKILL'));
    const detachedPid = Number((await once(rootProc.stdout, 'data'))[0].toString().trim());
    const detachedStart = procStat(detachedPid).start;
    t.after(() => { if (procStat(detachedPid)?.start === detachedStart) process.kill(detachedPid, 'SIGKILL'); });
    const rootStart = procStat(rootProc.pid).start;
    const f = makeDirectFixture(t, { pid: rootProc.pid, start: rootStart, tabs: [], panes: [], agents: [] });
    const status = JSON.parse(fs.readFileSync(join(f.dir, 'STATUS.json'), 'utf8'));
    const snap = rememberWorkerTree(f.dir, status);
    assert.equal(snap.issue, undefined);
    assert.ok(snap.snapshot.members.some((m) => m.pid === detachedPid && m.start === detachedStart));
    // Root exits cleanly and herdr's close_on_zero already closed the tab (tabs: []).
    const rootDone = once(rootProc, 'exit');
    rootProc.kill('SIGTERM');
    await rootDone;
    const cleaned = await reapWorkerTree(f.dir, status, () => {
      const r = f.run();
      return { ok: r.status === 0, reason: r.status === 0 ? 'ok' : 'failed', stdout: r.stdout, stderr: r.stderr };
    }, (r) => r.ok, { treeGrant: tabTreeGrant });
    assert.equal(cleaned.complete, true, cleaned.issue);
    assert.equal(procStat(detachedPid), null, 'detached descendant must be cleaned up');
  }
});
