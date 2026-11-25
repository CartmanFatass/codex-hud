import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { isHudHerdrFork, isHudHerdrVersion, probeHerdrTarget } from '../../dist/runtime/herdr-socket.js';
import { directExecEnv } from '../../dist/mcp/dispatch/proc.js';
import { codexPromptReady, parseDirectStartReply, rollbackDirectLaunch } from '../../dist/mcp/dispatch/direct-exec.js';
import { terminalFact } from '../../dist/mcp/cli-judge.js';
import { reapWorkerTree, rememberWorkerTree, tabTreeGrant } from '../../dist/roles/worker-tree.js';
import { procStat } from '../../dist/utils/proc.js';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { cliState, fallbackRole, fixture, readCloseReaped, until, writeCliRole } from '../helpers/thin-mcp-harness.mjs';

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
      else if (req.method === 'pane.get') {
        if (version === '0.9.5') conn.end(JSON.stringify({ id: req.id, error: { code: 'pane_not_found', message: 'not found' } }) + '\n');
        else conn.end(JSON.stringify({ id: req.id, result: { pane: { pane_id: 'w4E:p2', launch_id: 'launch_1', terminal_id: 'term_1' } } }) + '\n');
      }
    });
  });
  server.listen(sock);
  await once(server, 'listening');
  t.after(() => new Promise((done) => server.close(done)));

  const prior = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = sock;
  try {
    assert.equal(await isHudHerdrFork(), true);
    assert.equal(
      await probeHerdrTarget({ left: 'w4E:p2', tab: 'w4E:t2', herdrSocket: sock, launchId: 'launch_1', terminalId: 'term_1', directExec: '1' }),
      'present'
    );
    version = '0.9.5';
    assert.equal(await isHudHerdrFork(), false);
    // Rollback to stock herdr: pane_not_found on direct-exec target is 'unknown', never 'absent'.
    assert.equal(
      await probeHerdrTarget({ left: 'w4E:p2', tab: 'w4E:t2', herdrSocket: sock, launchId: 'launch_1', terminalId: 'term_1', directExec: '1' }),
      'unknown'
    );
  } finally {
    if (prior === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = prior;
  }
});

test('directExecEnv forwards auth/toolchain vars and strips job, session, control, and outer-terminal handles', () => {
  const env = directExecEnv(
    { HUD_JOB_DIR: '/tmp/job', HUD_HOME: '/tmp/hud', GIT_OPTIONAL_LOCKS: '0', PI_ROLES_KEEP_TAB: '1' },
    {
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/home/synthetic',
      GOOGLE_CLOUD_PROJECT: 'synth',
      NVM_DIR: '/home/synthetic/.nvm',
      CODEX_HOME: '/home/synthetic/.codex-custom',
      OPENAI_API_KEY: 'synth-key',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CODEX_THREAD_ID: 'parent-thread',
      OMPCODE: '1',
      HUD_MCP_SURFACE: 'roles',
      HUD_MCP_PI_SESSION_ID: 'parent-pi',
      HUD_TAB_LAUNCH: 'stale-uuid',
      HUD_INVOCATION_TOKEN: 'stale-token',
      HUD_RESUME_SESSION_ID: 'parent-resume-id',
      PI_ROLE_NOTIFY: 'parent-notify',
      PI_ORCHESTRATOR_PANE: 'w4E:p1',
      HERDR_PANE_ID: 'w4E:p1',
      HERDR_TAB_ID: 'w4E:t1',
      HERDR_WORKSPACE_ID: 'w4E',
      TMUX: '/tmp/tmux-1000/default,123,0',
      TMUX_PANE: '%1',
      ZELLIJ: '0',
      WEZTERM_PANE: '1',
      KITTY_WINDOW_ID: '1',
    }
  );
  assert.equal(env.PATH, '/usr/local/bin:/usr/bin');
  assert.equal(env.GOOGLE_CLOUD_PROJECT, 'synth');
  assert.equal(env.NVM_DIR, '/home/synthetic/.nvm');
  assert.equal(env.CODEX_HOME, '/home/synthetic/.codex-custom');
  assert.equal(env.OPENAI_API_KEY, 'synth-key');
  assert.equal(env.HUD_JOB_DIR, '/tmp/job');
  assert.equal(env.HUD_HOME, '/tmp/hud');
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(env.PI_ROLES_KEEP_TAB, '1');
  for (const stripped of [
    'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'OMPCODE',
    'HUD_MCP_SURFACE', 'HUD_MCP_PI_SESSION_ID', 'HUD_TAB_LAUNCH', 'HUD_INVOCATION_TOKEN',
    'HUD_RESUME_SESSION_ID', 'PI_ROLE_NOTIFY', 'PI_ORCHESTRATOR_PANE',
    'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID',
    'TMUX', 'TMUX_PANE', 'ZELLIJ', 'WEZTERM_PANE', 'KITTY_WINDOW_ID',
  ]) {
    assert.equal(Object.hasOwn(env, stripped), false, `expected ${stripped} stripped`);
  }
  // Explicit HUD_RESUME_SESSION_ID intended for this job passes through `extra`.
  const resumed = directExecEnv({ HUD_RESUME_SESSION_ID: 'job-resume-id' }, { HUD_RESUME_SESSION_ID: 'parent-id' });
  assert.equal(resumed.HUD_RESUME_SESSION_ID, 'job-resume-id');
});

test('terminalFact directExec never settles missed exit as closed even with partial report', () => {
  const turn = { seq: 1, sent_at: '2026-11-25T00:00:00.000Z', report_sig: null };
  // Stock keeps legacy behavior when alive === false and report exists.
  assert.deepEqual(
    terminalFact({ stop: false, alive: false, paneExit: null, directExec: false, tabClosed: false, turn, reportSig: 'partial' }),
    { state: 'closed', exitReason: 'settled', outputWritten: true }
  );
  // Direct-exec with no exit code MUST fail with exit unknown, never settle as closed.
  assert.deepEqual(
    terminalFact({ stop: false, alive: false, paneExit: null, directExec: true, tabClosed: false, turn, reportSig: 'partial' }),
    { state: 'failed', exitReason: 'worker exited (exit unknown)', outputWritten: true }
  );
  // Direct-exec with explicit code 0 settles as closed when report written.
  assert.deepEqual(
    terminalFact({ stop: false, alive: false, paneExit: { exitCode: 0, signal: null }, directExec: true, tabClosed: true, turn, reportSig: 'complete' }),
    { state: 'closed', exitReason: 'settled', outputWritten: true }
  );
  // Direct-exec with null code and null signal fails as exit unknown.
  assert.deepEqual(
    terminalFact({ stop: false, alive: false, paneExit: { exitCode: null, signal: null }, directExec: true, tabClosed: false, turn, reportSig: 'partial' }),
    { state: 'failed', exitReason: 'worker exited (exit unknown)', outputWritten: true }
  );
});

test('codexPromptReady mirrors herdr screen composer detection', () => {
  assert.equal(codexPromptReady('header\n› Ask Codex to do anything\n'), true);
  assert.equal(codexPromptReady('model: loading\n› Ask Codex to do anything\n'), false);
  assert.equal(codexPromptReady('Resuming session...\n› Ask Codex to do anything\n'), false);
  assert.equal(codexPromptReady('starting up...\n'), false);
});

test('parseDirectStartReply and rollbackDirectLaunch refuse incomplete/ambiguous identities', async () => {
  assert.equal(parseDirectStartReply({ result: { tab: { tab_id: 'w4E:t2' }, root_pane: { pane_id: 'w4E:p2' }, pid: 123, pid_start_time: 456 } }), null);
  assert.equal(
    parseDirectStartReply({
      result: {
        tab: { tab_id: 'w4E:t2', launch_id: 'launch_1' },
        root_pane: { pane_id: 'w4E:p2', launch_id: 'launch_1', terminal_id: 'term_a' },
        agent: { terminal_id: 'term_b' },
        pid: 123,
        pid_start_time: 456,
        launch_id: 'launch_1',
      },
    }),
    null,
    'mismatched terminal_id must be rejected'
  );
  // rollbackDirectLaunch without launchId refuses to close and marks unknown/cleanupFailed.
  const res = await rollbackDirectLaunch({ exit_code: 1, stdout: '', stderr: 'bad' }, { tabId: 'w4E:t2', launchId: '' });
  assert.equal(res.preInput, false);
  assert.equal(res.cleanupFailed, true);
});

/** Fake herdr fork socket + CLI state speaking 0.9.5-hud.3027f8dd (protocol 22). */
async function startForkHerdr(t, f, opts = {}) {
  const {
    reusedTabId = false,
    onAgentStart,
    initialStatus = 'idle',
    interactiveReady = false,
    paneReadText = '',
    crashOnStart = false,
  } = opts;
  const startRequests = [];
  const socketRequests = [];
  const subscriptions = [];
  const subscribers = new Set();
  const tabs = new Map(); // launch_id -> entry
  let seq = 0;

  const spawnAgentProcess = (immediateCrash = false) => {
    const child = spawn(
      process.execPath,
      ['-e', immediateCrash ? 'process.exit(2)' : 'setInterval(() => {}, 60000)'],
      { stdio: 'ignore' }
    );
    t.after(() => { try { child.kill('SIGKILL'); } catch {} });
    const start = Number(procStat(child.pid)?.start ?? 1);
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
        if (onAgentStart) {
          const custom = onAgentStart(req, conn, reply, err);
          if (custom === 'handled') return;
        }
        seq += 1;
        const tabNum = reusedTabId ? 2 : seq + 1;
        const tab_id = `w4E:t${tabNum}`;
        const pane_id = `w4E:p${tabNum}`;
        const launch_id = `launch_synth${seq.toString(16)}`;
        const terminal_id = `term_synth${seq.toString(16)}`;
        const proc = spawnAgentProcess(crashOnStart);
        const entry = {
          tab_id, pane_id, launch_id, terminal_id,
          name: req.params.name, label: req.params.label, kind: req.params.kind,
          cwd: req.params.cwd, env: req.params.env,
          pid: proc.pid, pid_start_time: proc.pid_start_time, child: proc.child,
          status: typeof initialStatus === 'function' ? initialStatus(req.params) : initialStatus,
          interactive_ready: typeof interactiveReady === 'function' ? interactiveReady(req.params) : interactiveReady,
          pane_read_text: typeof paneReadText === 'function' ? paneReadText(req.params) : paneReadText,
          closed: false,
          agent_session: { kind: 'id', value: `synthetic-${req.params.kind}-session-${seq}`, source: 'synthetic', agent: req.params.kind },
        };
        tabs.set(launch_id, entry);
        // If Pi (and not crashing immediately), write STATUS.json with session metadata as pi-roles does on session_start.
        if (!crashOnStart && req.params.kind === 'pi' && req.params.env?.HUD_JOB_DIR) {
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
            agent_status: entry.status, interactive_ready: entry.interactive_ready,
            workspace_id: 'w4E', tab_id, pane_id, focused: false, revision: 1,
          },
          argv: [req.params.executable, ...(req.params.argv ?? [])],
          tab: { tab_id, launch_id, terminal_id, workspace_id: 'w4E', number: tabNum, label: entry.label, focused: false, pane_count: 1, agent_status: entry.status },
          root_pane: { pane_id, terminal_id, launch_id, workspace_id: 'w4E', tab_id, focused: false, agent: entry.kind, agent_status: entry.status, revision: 1 },
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
            agent_status: entry.status, interactive_ready: entry.interactive_ready,
            agent_session: entry.agent_session,
          },
        });
        return;
      }
      if (req.method === 'pane.read') {
        const entry = [...tabs.values()].reverse().find((e) => !e.closed && e.pane_id === req.params.pane_id);
        if (!entry) { err('pane_not_found'); return; }
        reply({ type: 'pane_read', read: { text: entry.pane_read_text || '', pane_id: entry.pane_id } });
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
        reply({ type: 'pane_info', pane: { pane_id: entry.pane_id, tab_id: entry.tab_id, launch_id: entry.launch_id, terminal_id: entry.terminal_id, workspace_id: 'w4E' } });
        return;
      }
      if (req.method === 'pane.process_info') {
        err('unexpected_process_info', 'fork path must not query pane.process_info during supervision');
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
    subscribers,
    tabs,
    emit,
    hasWatcher: () => [...subscribers].some((c) => c.types.has('tab.closed') && !c.pane),
    dropWatchers() {
      for (const c of [...subscribers]) {
        if (!c.pane) c.conn.destroy();
      }
    },
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
    emitSiblingPaneExited(entry, exitCode, signal = null) {
      emit('pane.exited', {
        type: 'pane_exited',
        pane_id: 'w4E:p99',
        workspace_id: 'w4E',
        launch_id: entry.launch_id,
        terminal_id: 'term_sibling_99',
        exit_code: exitCode,
        signal,
      });
      emit('pane.closed', {
        type: 'pane_closed',
        pane_id: 'w4E:p99',
        workspace_id: 'w4E',
        launch_id: entry.launch_id,
        terminal_id: 'term_sibling_99',
      });
    },
    emitTabClosedRaw(tab_id, launch_id, terminal_id = 'term_stale') {
      emit('tab.closed', { type: 'tab_closed', tab_id, workspace_id: 'w4E', launch_id, terminal_id });
    },
    emitPaneExitedRaw(pane_id, launch_id, exit_code, signal = null, terminal_id = 'term_stale') {
      emit('pane.exited', { type: 'pane_exited', pane_id, workspace_id: 'w4E', launch_id, terminal_id, exit_code, signal });
    },
  };
}

test('fork CLI tab worker: direct exec, launch_id+terminal_id identity, sibling exit ignored, pane.exited clean & crash', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { failedRetentionMs: 250 });
  const fork = await startForkHerdr(t, f, { reusedTabId: true });
  writeCliRole(f, 'forkcli', 60, true, 'claude');

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
  assert.equal(f.commands().some((c) => c.command === 'herdr' && c.args[0] === 'tab' && c.args[1] === 'create'), false);
  assert.equal(fs.existsSync(join(dir1, 'cli-invocations')), false);
  assert.equal(fs.existsSync(join(dir1, 'tab-shells.json')), false);

  const session1 = Object.fromEntries(fs.readFileSync(join(dir1, 'SESSION.txt'), 'utf8').trim().split('\n').map((l) => l.split('=')));
  const entry1 = fork.tabs.get(session1.LAUNCH_ID);
  assert.ok(entry1);
  assert.equal(session1.DIRECT_EXEC, '1');
  assert.equal(session1.TERMINAL_ID, entry1.terminal_id);
  assert.equal(session1.LAUNCH, undefined);
  assert.equal(Number(session1.PID), entry1.pid);
  assert.equal(session1.PID_START, String(entry1.pid_start_time));

  await until(() => cliState(dir1)?.supervisor_pid && cliState(dir1)?.pid === entry1.pid && cliState(dir1)?.pid_start_time === String(entry1.pid_start_time), t.signal);
  assert.equal(fork.socketRequests.some((r) => r.method === 'pane.process_info'), false);

  // Sibling pane exit & close in the SAME launch_id (different terminal_id) must NOT retire the live root worker!
  fork.emitSiblingPaneExited(entry1, 0, null);
  fork.emitSiblingPaneExited(entry1, 1, null);
  // Stale tab.closed & pane.exited for the SAME public tab_id/pane_id with another launch_id are also ignored.
  fork.emitTabClosedRaw(entry1.tab_id, 'launch_stale_000');
  fork.emitPaneExitedRaw(entry1.pane_id, 'launch_stale_000', 1, null, entry1.terminal_id);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(cliState(dir1).state, 'working', 'sibling pane exit/close must not retire live root worker');

  // Clean exit (exit_code: 0) with report -> settled & reaped; tab closed by close_on_zero.
  writeFixtureFile(join(dir1, 'report.md'), 'Synthetic fork CLI report.\n');
  fork.emitPaneExited(entry1, 0, null);
  await until(() => cliState(dir1)?.state === 'closed' && Boolean(readCloseReaped(first)), t.signal);
  assert.equal(cliState(dir1).exit_reason, 'settled');
  assert.equal(cliState(dir1).runner_exit_code, 0);

  // 2) Second CLI job on reused public tab_id crashes with exit_code: 1.
  const second = await f.call('hud_create', { role: 'forkcli', task: 'Synthetic fork CLI crash.' });
  const dir2 = second.task_dir;
  const session2 = Object.fromEntries(fs.readFileSync(join(dir2, 'SESSION.txt'), 'utf8').trim().split('\n').map((l) => l.split('=')));
  const entry2 = fork.tabs.get(session2.LAUNCH_ID);
  assert.equal(entry2.tab_id, entry1.tab_id, 'test reuses public tab_id');
  assert.notEqual(entry2.launch_id, entry1.launch_id);
  await until(() => cliState(dir2)?.supervisor_pid && cliState(dir2)?.pid === entry2.pid && fork.hasWatcher(), t.signal);

  fork.emitTabClosedRaw(entry2.tab_id, entry1.launch_id);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(cliState(dir2).state, 'working');

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

test('fork Pi tab worker: PI_ROLES_KEEP_TAB=1, sibling exit ignored, clean exit & crash retention', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { failedRetentionMs: 250 });
  const fork = await startForkHerdr(t, f, { reusedTabId: true });

  const first = await f.call('hud_create', { role: 'imp', task: 'Synthetic fork Pi task.' });
  const dir1 = first.task_dir;
  assert.equal(fork.startRequests.length, 1);
  const req1 = fork.startRequests[0];
  assert.equal(req1.kind, 'pi');
  assert.equal(req1.on_exit, 'close_on_zero');
  assert.equal(req1.focus, false);
  assert.ok(req1.executable.endsWith('/pi-role'));
  assert.equal(req1.argv.includes('--args-json'), false);
  assert.equal(req1.env.HUD_JOB_DIR, dir1);
  assert.equal(req1.env.PI_ROLES_KEEP_TAB, '1', 'direct Pi launches must set PI_ROLES_KEEP_TAB=1');
  assert.equal(req1.env.HUD_TAB_LAUNCH, undefined);
  assert.equal(f.commands().some((c) => c.command === 'pi-role'), false);
  assert.equal(f.commands().some((c) => c.command === 'herdr' && c.args[0] === 'tab' && c.args[1] === 'create'), false);
  assert.equal(fs.existsSync(join(dir1, 'tab-shells.json')), false);

  const session1 = Object.fromEntries(fs.readFileSync(join(dir1, 'SESSION.txt'), 'utf8').trim().split('\n').map((l) => l.split('=')));
  const entry1 = fork.tabs.get(session1.LAUNCH_ID);
  assert.equal(session1.DIRECT_EXEC, '1');
  assert.equal(session1.TERMINAL_ID, entry1.terminal_id);
  assert.equal(cliState(dir1).session_id, 'pi-sess-1');

  await until(() => fork.subscriptions.some((s) =>
    s.subscriptions?.some((x) => x.type === 'tab.closed') &&
    s.subscriptions?.some((x) => x.type === 'pane.exited') &&
    s.subscriptions?.some((x) => x.type === 'pane.closed')), t.signal);

  // Sibling pane exit/close in the same launch_id must NOT retire the live Pi root worker.
  fork.emitSiblingPaneExited(entry1, 1, null);
  fork.emitTabClosedRaw(entry1.tab_id, 'launch_other_pi');
  fork.emitPaneExitedRaw(entry1.pane_id, 'launch_other_pi', 1, null, entry1.terminal_id);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(cliState(dir1).state, 'working', 'sibling exit must not retire live Pi worker');

  const crashedAt = Date.now();
  fork.emitPaneExited(entry1, 2, null);
  await until(() => cliState(dir1)?.state === 'failed', t.signal);
  assert.equal(cliState(dir1).exit_reason, 'worker exited (code 2)');
  assert.equal(cliState(dir1).runner_exit_code, 2);
  assert.equal(entry1.closed, false);
  await until(() => Boolean(readCloseReaped(first)), t.signal);
  assert.ok(Date.parse(readCloseReaped(first)) >= crashedAt + 200);

  // Clean Pi exit (exit_code: 0 with report & output_written: true) -> closes & reaps cleanly.
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

test('watcher disconnected during crash with partial report reconciles dead root on retained tab as exit unknown, never closed', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { failedRetentionMs: 250, watcherTickMs: 200 });
  const fork = await startForkHerdr(t, f);
  writeCliRole(f, 'forkcli', 60, true, 'claude');

  const job = await f.call('hud_create', { role: 'forkcli', task: 'Crash while watcher disconnected.' });
  const dir = job.task_dir;
  const session = Object.fromEntries(fs.readFileSync(join(dir, 'SESSION.txt'), 'utf8').trim().split('\n').map((l) => l.split('=')));
  const entry = fork.tabs.get(session.LAUNCH_ID);
  await until(() => cliState(dir)?.supervisor_pid && fork.hasWatcher(), t.signal);

  // Disconnect watcher and kill supervisor so NEITHER receives pane.exited.
  fork.dropWatchers();
  try { process.kill(cliState(dir).supervisor_pid, 'SIGKILL'); } catch {}
  await until(() => procStat(cliState(dir).supervisor_pid) === null, t.signal);

  // Write a partial report, then crash the worker root PID WITHOUT emitting pane.exited; tab stays retained!
  writeFixtureFile(join(dir, 'report.md'), 'Partial report before crash.\n');
  const exited = once(entry.child, 'exit');
  entry.child.kill('SIGKILL');
  await exited;
  assert.equal(entry.closed, false, 'retained tab stays present in herdr');

  // Watcher reconnects / ticks, reconciles pane.get + exact root PID -> dead root on retained tab = failed (exit unknown).
  await until(() => cliState(dir)?.state === 'failed', t.signal);
  assert.equal(cliState(dir).exit_reason, 'worker exited (exit unknown)');
  assert.notEqual(cliState(dir).state, 'closed', 'must never settle missed exit as closed on partial report');
  await until(() => Boolean(readCloseReaped(job)), t.signal);
});

test('startup crash on direct-exec keeps receipt and retained tab for failure retention without closing', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { failedRetentionMs: 300 });
  const fork = await startForkHerdr(t, f, { crashOnStart: true, initialStatus: 'unknown' });
  // Configure TWO places so we also prove canTryNext does NOT launch a second place after a direct-exec startup crash!
  fallbackRole(f, 'crashcli', [
    { harness: 'cli', agent: 'claude' },
    { harness: 'cli', agent: 'grok' },
  ]);

  const res = await f.call('hud_create', { role: 'crashcli', task: 'Immediate startup crash.' });
  assert.equal(res.ok, false);
  const dir = res.task_dir;
  assert.equal(fork.startRequests.length, 1, 'must not try second place after direct-exec startup crash');
  assert.equal(fs.existsSync(join(dir, 'SESSION.txt')), true, 'SESSION receipt must be retained');
  const session = Object.fromEntries(fs.readFileSync(join(dir, 'SESSION.txt'), 'utf8').trim().split('\n').map((l) => l.split('=')));
  const entry = fork.tabs.get(session.LAUNCH_ID);
  assert.ok(entry);
  assert.equal(entry.closed, false, 'retained crashed pane must not be closed during launch');
  assert.equal(
    f.commands().some((c) => c.command === 'herdr' && c.args[0] === 'tab' && c.args[1] === 'close'),
    false,
    'must not rejectLaunch-close the retained tab'
  );
  assert.equal(cliState(dir)?.state, 'failed');
  assert.equal(cliState(dir)?.pid, entry.pid);
  // Watcher reaps after failure retention deadline.
  await until(() => Boolean(readCloseReaped(res)), t.signal);
});

test('missing or ambiguous agent.start reply is unknown: never closes by public tab ID and does not start second place', { timeout: 60000 }, async (t) => {
  for (const mode of ['lost_reply', 'ambiguous_reply']) {
    const f = await fixture(t);
    const fork = await startForkHerdr(t, f, {
      onAgentStart(_req, conn, reply) {
        if (mode === 'lost_reply') {
          conn.destroy();
          return 'handled';
        }
        // Ambiguous reply: has public tab_id but missing launch_id/terminal_id/pid!
        reply({
          type: 'agent_started',
          tab: { tab_id: 'w4E:t2' },
          root_pane: { pane_id: 'w4E:p2' },
        });
        return 'handled';
      },
    });
    fallbackRole(f, 'fallbackcli', [
      { harness: 'cli', agent: 'claude' },
      { harness: 'cli', agent: 'grok' },
    ]);

    const res = await f.call('hud_create', { role: 'fallbackcli', task: `Synthetic ${mode}.` });
    assert.equal(res.ok, false, `${mode} must fail`);
    assert.equal(fork.startRequests.length, 1, `${mode}: canTryNext must NOT start a second place`);
    assert.equal(
      f.commands().some((c) => c.command === 'herdr' && c.args[0] === 'tab' && c.args[1] === 'close'),
      false,
      `${mode}: must NEVER close by public tab ID alone without matching launch_id`
    );
  }
});

test('Codex prompt-ready with agent_status unknown counts as ready (screen signal and interactive_ready) and preserves CODEX_HOME', { timeout: 60000 }, async (t) => {
  for (const viaInteractiveFlag of [false, true]) {
    const f = await fixture(t);
    const fork = await startForkHerdr(t, f, {
      initialStatus: 'unknown',
      interactiveReady: viaInteractiveFlag,
      paneReadText: viaInteractiveFlag ? '' : 'Codex ready\n› Ask Codex to do anything\n',
    });
    writeCliRole(f, 'forkcodex', 60, true, 'codex');

    const res = await f.call('hud_create', { role: 'forkcodex', task: 'Synthetic Codex prompt-ready unknown.' });
    assert.equal(res.ok, undefined, `Codex launch should succeed (got ${JSON.stringify(res)})`);
    assert.equal(fork.startRequests.length, 1);
    assert.equal(fork.startRequests[0].kind, 'codex');
    // Fixture sets CODEX_HOME to a custom path; direct-exec forwards the caller's CODEX_HOME.
    assert.equal(fork.startRequests[0].env.CODEX_HOME, f.env.CODEX_HOME);
    const dir = res.task_dir;
    const session = Object.fromEntries(fs.readFileSync(join(dir, 'SESSION.txt'), 'utf8').trim().split('\n').map((l) => l.split('=')));
    const entry = fork.tabs.get(session.LAUNCH_ID);
    await until(() => cliState(dir)?.supervisor_pid, t.signal);
    writeFixtureFile(join(dir, 'report.md'), 'Codex report.\n');
    fork.emitPaneExited(entry, 0, null);
    await until(() => cliState(dir)?.state === 'closed' && Boolean(readCloseReaped(res)), t.signal);
  }

  // When CODEX_HOME is unset on the caller (e.g. trimmed MCP env), direct-exec must NOT overwrite it with ~/.codex.
  const fUnset = await fixture(t, { probe: 'delete process.env.CODEX_HOME;' });
  const forkUnset = await startForkHerdr(t, fUnset, {
    initialStatus: 'unknown',
    interactiveReady: true,
  });
  writeCliRole(fUnset, 'forkcodex', 60, true, 'codex');
  const resUnset = await fUnset.call('hud_create', { role: 'forkcodex', task: 'Unset CODEX_HOME must not inject ~/.codex.' });
  assert.equal(resUnset.ok, undefined, `Codex launch with unset CODEX_HOME should succeed (got ${JSON.stringify(resUnset)})`);
  assert.equal(Object.hasOwn(forkUnset.startRequests[0].env, 'CODEX_HOME'), false, 'must not synthesize ~/.codex when caller CODEX_HOME is unset');
  const dirUnset = resUnset.task_dir;
  const sessionUnset = Object.fromEntries(fs.readFileSync(join(dirUnset, 'SESSION.txt'), 'utf8').trim().split('\n').map((l) => l.split('=')));
  const entryUnset = forkUnset.tabs.get(sessionUnset.LAUNCH_ID);
  await until(() => cliState(dirUnset)?.supervisor_pid, t.signal);
  writeFixtureFile(join(dirUnset, 'report.md'), 'Codex report.\n');
  forkUnset.emitPaneExited(entryUnset, 0, null);
  await until(() => cliState(dirUnset)?.state === 'closed' && Boolean(readCloseReaped(resUnset)), t.signal);
});

test('cli-supervisor guards pane-exit-only writes against SESSION replacement', { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { failedRetentionMs: 250 });
  const fork = await startForkHerdr(t, f);
  writeCliRole(f, 'forkcli', 60, true, 'claude');

  const job = await f.call('hud_create', { role: 'forkcli', task: 'Guard pane-exit against session replacement.' });
  const dir = job.task_dir;
  const session = Object.fromEntries(fs.readFileSync(join(dir, 'SESSION.txt'), 'utf8').trim().split('\n').map((l) => l.split('=')));
  const entry = fork.tabs.get(session.LAUNCH_ID);
  await until(() => cliState(dir)?.supervisor_pid && fork.hasWatcher(), t.signal);
  const oldSupPid = cliState(dir).supervisor_pid;

  // Simulate resume replacing SESSION.txt with a new launch while old supervisor is still connected.
  writeFixtureFile(
    join(dir, 'SESSION.txt'),
    `TASK=${job.job}\nLAUNCH_ID=launch_replacement_9\nTERMINAL_ID=term_replacement_9\nDIRECT_EXEC=1\nPID=${entry.pid}\nPID_START=${entry.pid_start_time}\nHERDR_SOCKET_PATH=${f.env.HERDR_SOCKET_PATH}\nTAB=w4E:t9\nTAB_NAME=synthetic\nLEFT=w4E:p9\nRIGHT=\nORCH=w4E:p1\nBASE=HEAD\nPRIMARY=${job.job}-primary\n`
  );
  // Emit non-zero pane.exited (no tab.closed!) for the OLD launch_id + terminal_id.
  fork.emitPaneExited(entry, 1, null, { closeOnZero: false });
  await until(() => procStat(oldSupPid) === null, t.signal);
  assert.equal(cliState(dir).state, 'working', 'old supervisor must NOT overwrite replaced session STATUS on pane.exited');
});

test('reap-tab direct-exec: exact PID+start, stock rollback refusal, restored shell refusal, split helper safety, delayed reap after resume', async (t) => {
  const fakeHerdr = String.raw`
const fs = require('node:fs');
const path = process.env.STATE;
const s = JSON.parse(fs.readFileSync(path));
const args = process.argv.slice(2), [kind, op, target] = args;
fs.appendFileSync(path + '.log', JSON.stringify(args) + '\n');
const out = result => console.log(JSON.stringify({ result }));
if (op === 'list') out({ [kind + 's']: s[kind + 's'] });
else if (op === 'process-info') {
  const pane = args[3];
  const info = s.processInfo?.[pane] ?? { pane_id: pane, shell_pid: s.rootShellPid ?? null, foreground_process_group_id: s.rootShellPid ?? null, foreground_processes: [] };
  out({ process_info: info });
}
else if (kind === 'agent' && op === 'get') out({ agent: s.agents.find(a => a.pane_id === target) });
else if (kind === 'tab' && op === 'close') { s.tabs = s.tabs.filter(t => t.tab_id !== target); out({}); }
else throw Error('unexpected fake herdr command: ' + args);
fs.writeFileSync(path, JSON.stringify(s));`;

  function makeDirectFixture(t, {
    tabs, panes, agents, label = 'synthetic', orch = 'main-pane', pid, start, statusPid, statusStart,
    right = '', rightTerminalId = '', rootShellPid, processInfo, launchId = 'launch_direct_1', terminalId = 'term_direct_1',
    statusState = 'working',
  } = {}) {
    const root = fs.mkdtempSync(join(tmpdir(), 'hud-reap-direct-'));
    const dir = join(root, 'job');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(dir);
    fs.writeFileSync(join(root, 'herdr'), `#!${process.execPath}\n${fakeHerdr}`, { mode: 0o700 });
    const state = join(root, 'state'), log = `${state}.log`;
    fs.writeFileSync(state, JSON.stringify({
      tabs: tabs ?? [{ tab_id: 'worker-tab', launch_id: launchId, label }],
      panes: panes ?? [
        { pane_id: 'worker-pane', tab_id: 'worker-tab', launch_id: launchId, terminal_id: terminalId, agent: 'claude' },
        { pane_id: 'main-pane', tab_id: 'main-tab', launch_id: 'launch_main', terminal_id: 'term_main', agent: 'claude' },
      ],
      agents: agents ?? [],
      rootShellPid: rootShellPid !== undefined ? rootShellPid : pid,
      processInfo,
    }));
    const sessionLines = [
      `LAUNCH_ID=${launchId}`,
      `TERMINAL_ID=${terminalId}`,
      'DIRECT_EXEC=1',
      `PID=${pid}`,
      `PID_START=${start}`,
      'TAB=worker-tab',
      'TAB_NAME=synthetic',
      'LEFT=worker-pane',
      `RIGHT=${right}`,
      ...(rightTerminalId ? [`RIGHT_TERMINAL_ID=${rightTerminalId}`] : []),
      `ORCH=${orch}`,
      'PRIMARY=worker',
    ].join('\n') + '\n';
    fs.writeFileSync(join(dir, 'SESSION.txt'), sessionLines);
    fs.writeFileSync(
      join(dir, 'STATUS.json'),
      JSON.stringify({ version: 1, task_dir: dir, slot: 'primary', harness: 'cli', agent: 'claude', state: statusState, pid: statusPid ?? pid, pid_start_time: statusStart ?? start })
    );
    const env = { ...process.env, HOME: root, HUD_HOME: root, STATE: state, PATH: root };
    delete env.HERDR_SOCKET_PATH;
    const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l)) : [];
    return {
      dir, env, calls, state, launchId,
      run: (...extra) => spawnSync(process.execPath, [reapBin, dir, ...extra], { env, encoding: 'utf8', timeout: 15000 }),
    };
  }

  // 1) Stock inventory after rollback (tabs/panes lack launch_id): refuses as unknown, never treats as absence!
  {
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const start = procStat(dead.pid)?.start ?? '1';
    await once(dead, 'exit');
    const f = makeDirectFixture(t, {
      pid: dead.pid, start,
      tabs: [{ tab_id: 'worker-tab', label: 'synthetic' }], // NO launch_id!
      panes: [{ pane_id: 'worker-pane', tab_id: 'worker-tab', agent: 'claude' }], // NO launch_id!
    });
    const r = f.run();
    assert.equal(r.status, 1, 'stock inventory must refuse, not exit 0 as absent');
    assert.match(r.stderr, /missing launch_id|lacks launch_id capability/);
    assert.equal(f.calls().some((c) => c[1] === 'close'), false);
  }

  // 2) Surviving tab after fork-to-fork handoff (restore respawned a fresh shell with a different live PID): refuses to close!
  {
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const start = procStat(dead.pid)?.start ?? '1';
    await once(dead, 'exit');
    const restoredShell = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
    t.after(() => restoredShell.kill('SIGKILL'));
    const f = makeDirectFixture(t, {
      pid: dead.pid, start,
      rootShellPid: restoredShell.pid,
    });
    const r = f.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /hosts a different live process/);
    assert.equal(f.calls().some((c) => c[1] === 'close'), false);
  }

  // 3) Delayed reap after resume: --launch mismatch refuses BEFORE writing stop-requested and never signals resumed worker!
  {
    const resumedWorker = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
    t.after(() => resumedWorker.kill('SIGKILL'));
    const resumedStart = procStat(resumedWorker.pid).start;
    const f = makeDirectFixture(t, {
      pid: resumedWorker.pid, start: resumedStart, launchId: 'launch_resumed_2', statusState: 'working',
    });
    const r = f.run('--launch', 'launch_prior_1');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /launch stamp changed; nothing reaped/);
    assert.equal(fs.existsSync(join(f.dir, 'STATUS.json.stop-requested')), false, 'must NOT write stop intent on stale reap');
    assert.equal(procStat(resumedWorker.pid)?.start, resumedStart, 'resumed worker must stay alive');
    assert.equal(f.calls().length, 0);
  }

  // 4) Split tab: clean close_on_zero removes root pane and leaves helper; idle HUD helper closes, busy/unverified helper stays!
  {
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const start = procStat(dead.pid)?.start ?? '1';
    await once(dead, 'exit');
    const launchId = 'launch_split_1';
    const root = fs.mkdtempSync(join(tmpdir(), 'hud-reap-split-'));
    const dir = join(root, 'job');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(dir);
    const helperTags = { HUD_JOB_DIR: dir, HERDR_PANE_ID: 'helper-pane', HERDR_TAB_ID: 'worker-tab', HUD_TAB_LAUNCH: launchId };
    const helperShell = spawn('/bin/sh', ['-c', 'read line'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: helperTags });
    t.after(() => helperShell.kill('SIGKILL'));
    const helperPid = helperShell.pid;
    const exe = `/proc/${helperPid}/exe`, image = fs.statSync(exe, { bigint: true });
    const helperStamp = { pane: 'helper-pane', pid: helperPid, start: procStat(helperPid).start, exe: fs.readlinkSync(exe), inode: `${image.dev}:${image.ino}` };
    const busyFg = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
    t.after(() => busyFg.kill('SIGKILL'));

    const state = join(root, 'state'), log = `${state}.log`;
    fs.writeFileSync(join(root, 'herdr'), `#!${process.execPath}\n${fakeHerdr}`, { mode: 0o700 });
    fs.writeFileSync(
      join(dir, 'SESSION.txt'),
      `LAUNCH_ID=${launchId}\nTERMINAL_ID=term_root\nRIGHT_TERMINAL_ID=term_helper\nDIRECT_EXEC=1\nPID=${dead.pid}\nPID_START=${start}\nTAB=worker-tab\nTAB_NAME=synthetic\nLEFT=worker-pane\nRIGHT=helper-pane\nORCH=main-pane\nPRIMARY=worker\n`
    );
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ version: 1, task_dir: dir, slot: 'primary', harness: 'pi', state: 'closed', pid: dead.pid, pid_start_time: start }));
    fs.writeFileSync(join(dir, 'tab-shells.json'), JSON.stringify({ launch: launchId, tab: 'worker-tab', shells: [helperStamp] }));
    const env = { ...process.env, HOME: root, HUD_HOME: root, STATE: state, PATH: root };
    delete env.HERDR_SOCKET_PATH;

    // 4a) Busy foreground program in helper -> NEVER whole-tab close!
    fs.writeFileSync(state, JSON.stringify({
      tabs: [{ tab_id: 'worker-tab', launch_id: launchId, label: 'synthetic' }],
      panes: [
        { pane_id: 'helper-pane', tab_id: 'worker-tab', launch_id: launchId, terminal_id: 'term_helper' },
        { pane_id: 'main-pane', tab_id: 'main-tab', launch_id: 'launch_main', terminal_id: 'term_main' },
      ],
      agents: [],
      processInfo: {
        'helper-pane': { pane_id: 'helper-pane', shell_pid: helperPid, foreground_process_group_id: busyFg.pid, foreground_processes: [{ pid: busyFg.pid, name: 'sleep' }] },
      },
    }));
    const busyRes = spawnSync(process.execPath, [reapBin, dir, '--launch', launchId], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(busyRes.status, 1);
    assert.match(busyRes.stderr, /helper pane has active foreground process; not closing/);
    assert.equal(fs.readFileSync(log, 'utf8').includes('"close"'), false);

    // 4b) Idle HUD helper shell (after root-only close_on_zero removed LEFT) -> closes cleanly!
    fs.writeFileSync(state, JSON.stringify({
      tabs: [{ tab_id: 'worker-tab', launch_id: launchId, label: 'synthetic' }],
      panes: [
        { pane_id: 'helper-pane', tab_id: 'worker-tab', launch_id: launchId, terminal_id: 'term_helper' },
        { pane_id: 'main-pane', tab_id: 'main-tab', launch_id: 'launch_main', terminal_id: 'term_main' },
      ],
      agents: [],
      processInfo: {
        'helper-pane': { pane_id: 'helper-pane', shell_pid: helperPid, foreground_process_group_id: helperPid, foreground_processes: [{ pid: helperPid, name: 'sh' }] },
      },
    }));
    const idleRes = spawnSync(process.execPath, [reapBin, dir, '--launch', launchId], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(idleRes.status, 0, idleRes.stderr);
    assert.match(idleRes.stdout, new RegExp(`^tree-owner ${dead.pid}:${start}`, 'm'));
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).tabs.length, 0);
  }

  // 5) Standard direct-exec safety: mismatched STATUS PID, renamed tab, orchestrator tab, reused tab_id, live SIGTERM, detached descendants.
  {
    const child = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
    t.after(() => child.kill('SIGKILL'));
    const start = procStat(child.pid).start;
    const f = makeDirectFixture(t, { pid: child.pid, start, statusPid: child.pid + 999 });
    const r = f.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not match direct-exec launch/);
  }
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
  {
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const start = procStat(dead.pid)?.start ?? '1';
    await once(dead, 'exit');
    const f = makeDirectFixture(t, {
      pid: dead.pid, start,
      tabs: [{ tab_id: 'worker-tab', launch_id: 'launch_reused_other', label: 'synthetic' }],
      panes: [{ pane_id: 'worker-pane', tab_id: 'worker-tab', launch_id: 'launch_reused_other', terminal_id: 'term_other', agent: 'claude' }],
    });
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.calls().some((c) => c[1] === 'close'), false);
  }
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
