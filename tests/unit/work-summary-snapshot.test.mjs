import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import {
  collectWorkSummary,
  createWorkSummaryPublisher,
  readFreshWorkSummary,
  WORK_SUMMARY_MAX_BYTES,
  WORK_SUMMARY_MCP_TTL_MS,
  workSummaryPath,
} from '../../dist/collectors/work-summary-snapshot.js';
import { createPiSegment } from '../../dist/harness/pi/segment.js';
import {
  renderWorkSummary,
  renderWorkSummaryFromCounts,
  workSignals,
  workSignalsFromSummary,
} from '../../dist/render/work-summary.js';
import { writePrivateFile } from '../../dist/utils/atomic-fs.js';

const PANE_A = 'w4E:p1';
const PANE_B = 'w4E:p2';

function makeFixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-work-summary-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let seq = 0;
  function addJob(opts = {}) {
    const n = ++seq;
    const id = 'j' + n.toString(16).padStart(16, '0');
    const dir = join(home, 'jobs', id);
    const created_at = new Date().toISOString();
    const job = {
      job: id,
      role: opts.role ?? 'imp',
      herdr_pane: opts.pane ?? PANE_A,
      created_at,
      ...(opts.cli ? { cli: { agent: 'codex', can_continue: true, idle_grace_s: 30 } } : {}),
    };
    writePrivateFile(join(dir, 'job.json'), JSON.stringify(job));
    const setStatus = (value) => writePrivateFile(join(dir, 'STATUS.json'), JSON.stringify(value));
    if (opts.status !== null) setStatus(opts.status ?? { state: 'working' });
    return { id, dir, setStatus };
  }
  return { home, addJob };
}

async function waitFor(predicate, timeoutMs = 5_000, stepMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor timed out');
}

test('collectWorkSummary matches workSignals and renderWorkSummary across roles, panes, asking, queued and settled jobs', (t) => {
  const { home, addJob } = makeFixture(t);
  const j1 = addJob({ role: 'imp', pane: PANE_A, status: { state: 'working' } });
  const j2 = addJob({ role: 'imp', pane: PANE_A, status: { state: 'working' } });
  writePrivateFile(join(j2.dir, 'qa', 'q1.md'), '# Question q1 from imp\n\nSynthetic choice?');
  const j3 = addJob({ role: 'general', pane: PANE_A, status: { state: 'working' } });
  writePrivateFile(join(j3.dir, 'qa', 'q1.md'), '# Question q1 from general\n\nAnswered?');
  writePrivateFile(join(j3.dir, 'qa', 'q1.answer.md'), 'Yes');
  addJob({ role: 'oracle', pane: PANE_A, cli: true, status: { state: 'working', harness: 'cli', blocked: true } });
  addJob({ role: 'reviewer', pane: PANE_A, cli: true, status: { state: 'waiting_orchestrator', harness: 'cli' } });
  addJob({ role: 'imp', pane: PANE_A, status: { state: 'queued' } });
  addJob({ role: 'imp', pane: PANE_A, status: { state: 'closed' } });
  addJob({ role: 'sonic', pane: PANE_B, status: { state: 'working' } });
  assert.ok(j1.id);

  const summary = collectWorkSummary(home);
  assert.equal(summary.complete, true);
  assert.deepEqual(summary.panes[PANE_A], {
    running: 5,
    asking: 3,
    roles: {
      general: { running: 1, asking: 0 },
      imp: { running: 2, asking: 1 },
      oracle: { running: 1, asking: 1 },
      reviewer: { running: 1, asking: 1 },
    },
  });
  assert.deepEqual(summary.panes[PANE_B], {
    running: 1,
    asking: 0,
    roles: { sonic: { running: 1, asking: 0 } },
  });
  assert.equal(summary.global.running, 6);
  assert.equal(summary.global.asking, 3);

  const now = Date.now();
  const lanesA = readThinJobs(home, { project: null, pane: PANE_A });
  const sortWorkers = (ws) => [...ws].sort((a, b) => a.role.localeCompare(b.role) || a.state.localeCompare(b.state));
  assert.deepEqual(
    sortWorkers(workSignalsFromSummary(summary.panes[PANE_A]).workers),
    sortWorkers(workSignals(lanesA, now).workers)
  );
  assert.equal(
    renderWorkSummaryFromCounts(summary.panes[PANE_A], 160),
    renderWorkSummary(lanesA, 160, now)
  );
});

test('publisher writes private bounded snapshots only on meaningful changes and reader rejects corrupt, oversize or stale data', (t) => {
  const { home, addJob } = makeFixture(t);
  addJob({ role: 'imp', pane: PANE_A });
  const pub = createWorkSummaryPublisher(home, 'hud-mcp');
  const t0 = Date.now();
  assert.equal(pub.publish({ now: t0 }), true);
  const file = workSummaryPath(home);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const st1 = fs.statSync(file, { bigint: true });
  assert.equal(pub.generation, 1);
  // No meaningful change -> no rewrite.
  assert.equal(pub.publish({ now: t0 + 100 }), false);
  const st2 = fs.statSync(file, { bigint: true });
  assert.equal(st2.ino, st1.ino);
  assert.equal(pub.generation, 1);

  const fresh = readFreshWorkSummary(home, PANE_A, t0 + 1000);
  assert.ok(fresh);
  assert.equal(fresh.scope.running, 1);
  assert.equal(fresh.snapshot.producer, 'hud-mcp');
  // Absent pane in complete snapshot reads as 0 running/asking.
  const emptyPane = readFreshWorkSummary(home, PANE_B, t0 + 1000);
  assert.deepEqual(emptyPane?.scope, { running: 0, asking: 0, roles: {} });
  // Stale once MCP TTL expires.
  assert.equal(readFreshWorkSummary(home, PANE_A, t0 + WORK_SUMMARY_MCP_TTL_MS + 1), null);
  // Future timestamp rejected.
  assert.equal(readFreshWorkSummary(home, PANE_A, t0 - 60_000), null);

  // Corrupt JSON, incomplete flag, invalid counts, wrong version, oversize file -> null.
  writePrivateFile(file, '{not-json');
  assert.equal(readFreshWorkSummary(home, PANE_A, t0), null);
  writePrivateFile(file, JSON.stringify({ ...fresh.snapshot, version: 2 }));
  assert.equal(readFreshWorkSummary(home, PANE_A, t0), null);
  writePrivateFile(file, JSON.stringify({ ...fresh.snapshot, complete: false }));
  assert.equal(readFreshWorkSummary(home, PANE_A, t0), null);
  writePrivateFile(file, JSON.stringify({ ...fresh.snapshot, global: { running: 1, asking: 2, roles: { imp: { running: 1, asking: 2 } } } }));
  assert.equal(readFreshWorkSummary(home, PANE_A, t0), null);
  writePrivateFile(file, ' '.repeat(WORK_SUMMARY_MAX_BYTES + 16));
  assert.equal(readFreshWorkSummary(home, PANE_A, t0), null);
});

test('hud-watch updates work-summary.v1.json within 200 ms of job changes and staleness is detected on watcher exit', { timeout: 15_000 }, async (t) => {
  const { home, addJob } = makeFixture(t);
  const j1 = addJob({ role: 'imp', pane: PANE_A, status: { state: 'working' } });
  const j2 = addJob({ role: 'sonic', pane: PANE_B, status: { state: 'working' } });
  assert.ok(j2.id);

  const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], {
    env: { ...process.env, HUD_HOME: home },
    stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  });

  const initial = await waitFor(() => readFreshWorkSummary(home, PANE_A), 5_000, 10);
  assert.equal(initial.snapshot.producer, 'hud-watch');
  assert.equal(initial.snapshot.watching, true);
  assert.equal(fs.statSync(workSummaryPath(home)).mode & 0o777, 0o600);
  assert.deepEqual(initial.scope, { running: 1, asking: 0, roles: { imp: { running: 1, asking: 0 } } });
  assert.equal(initial.snapshot.global.running, 2);

  // Open a question -> snapshot must reflect asking=1 within 200 ms.
  const tAsk = performance.now();
  writePrivateFile(join(j1.dir, 'qa', 'q1.md'), '# Question q1 from imp\n\nSynthetic?');
  const asked = await waitFor(() => {
    const r = readFreshWorkSummary(home, PANE_A);
    return r?.scope.asking === 1 ? r : null;
  }, 1_000, 5);
  const askMs = performance.now() - tAsk;
  assert.ok(askMs < 200, `expected <200ms update on question, got ${askMs.toFixed(1)}ms`);
  assert.ok(asked.snapshot.generation > initial.snapshot.generation);

  // Answer the question -> asking returns to 0 within 200 ms.
  const tAns = performance.now();
  writePrivateFile(join(j1.dir, 'qa', 'q1.answer.md'), 'Synthetic answer');
  const answered = await waitFor(() => {
    const r = readFreshWorkSummary(home, PANE_A);
    return r?.scope.asking === 0 ? r : null;
  }, 1_000, 5);
  const ansMs = performance.now() - tAns;
  assert.ok(ansMs < 200, `expected <200ms update on answer, got ${ansMs.toFixed(1)}ms`);
  assert.ok(answered.snapshot.generation > asked.snapshot.generation);

  // Close j1 -> PANE_A running drops to 0 within 200 ms (j2 keeps watcher alive).
  const tClose = performance.now();
  j1.setStatus({ state: 'closed', settled_at: new Date().toISOString() });
  const closed = await waitFor(() => {
    const r = readFreshWorkSummary(home, PANE_A);
    return r?.scope.running === 0 ? r : null;
  }, 1_000, 5);
  const closeMs = performance.now() - tClose;
  assert.ok(closeMs < 200, `expected <200ms update on close, got ${closeMs.toFixed(1)}ms`);
  assert.equal(closed.snapshot.global.running, 1);

  // Kill watcher with SIGKILL (simulating crash where watch.pid remains) -> stale immediately detected.
  child.kill('SIGKILL');
  await exited;
  assert.equal(readFreshWorkSummary(home, PANE_A), null);
  assert.equal(readFreshWorkSummary(home, null), null);
});

test('pi segment reads fresh work-summary.v1.json without scanning jobs and falls back when watcher exits', { timeout: 15_000 }, async (t) => {
  const { home, addJob } = makeFixture(t);
  const j1 = addJob({ role: 'imp', pane: PANE_A, status: { state: 'working' } });
  const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], {
    env: { ...process.env, HUD_HOME: home },
    stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  });
  await waitFor(() => readFreshWorkSummary(home, PANE_A)?.scope.running === 1);

  let jobsScans = 0;
  const origReaddir = fs.readdirSync;
  fs.readdirSync = (target, ...args) => {
    if (String(target) === join(home, 'jobs')) jobsScans++;
    return origReaddir(target, ...args);
  };
  syncBuiltinESMExports();

  const statuses = new EventEmitter();
  const signalsLog = [];
  let timer;
  const segment = createPiSegment({
    env: { HUD_HOME: home, HERDR_PANE_ID: PANE_A },
    schedule(fn) { timer = fn; return () => {}; },
    onSignals(signals) { signalsLog.push(signals); },
  });
  t.after(() => {
    segment.stop();
    fs.readdirSync = origReaddir;
    syncBuiltinESMExports();
  });

  const ctx = { mode: 'tui', hasUI: true, ui: { setStatus(_k, v) { statuses.emit('status', v); } } };
  let lastStatus;
  statuses.on('status', (v) => { lastStatus = v; });

  segment.start(ctx, '/tmp', () => true);
  assert.equal(lastStatus, 'Work: 1 running');
  assert.deepEqual(signalsLog.at(-1), { workers: [{ role: 'imp', state: 'working' }] });
  assert.equal(jobsScans, 0, 'fresh snapshot path must not enumerate jobs/');

  // Update job -> watcher updates snapshot -> segment picks it up without scanning jobs/.
  writePrivateFile(join(j1.dir, 'qa', 'q1.md'), '# Question q1 from imp\n\nSynthetic?');
  await waitFor(() => readFreshWorkSummary(home, PANE_A)?.scope.asking === 1);
  timer();
  assert.equal(lastStatus, 'Work: 1 needs you');
  assert.deepEqual(signalsLog.at(-1), { workers: [{ role: 'imp', state: 'asking' }] });
  assert.equal(jobsScans, 0);

  // Watcher exits -> snapshot becomes stale -> segment falls back to jobLaneSnapshot and sees answer.
  child.kill('SIGTERM');
  await exited;
  assert.equal(readFreshWorkSummary(home, PANE_A), null);
  writePrivateFile(join(j1.dir, 'qa', 'q1.answer.md'), 'Answered after watcher exit');
  const next = once(statuses, 'status');
  timer();
  // Wait until fallback scan publishes the updated running status.
  await waitFor(() => lastStatus === 'Work: 1 running', 5_000, 15);
  await next;
  assert.deepEqual(signalsLog.at(-1), { workers: [{ role: 'imp', state: 'working' }] });
});

test('hud-mcp updates work-summary.v1.json on hud_respond without overriding a fresh matching hud-watch snapshot', { timeout: 15_000 }, async (t) => {
  const { home, addJob } = makeFixture(t);
  const j1 = addJob({ role: 'imp', pane: PANE_A, status: { state: 'working' } });
  writePrivateFile(join(j1.dir, 'qa', 'q1.md'), '# Question q1 from imp\n\nSynthetic?');

  // First verify publisher does not overwrite a fresh hud-watch snapshot when counts are identical.
  writePrivateFile(join(home, 'watch.pid'), `${process.pid}\n`);
  const watchPub = createWorkSummaryPublisher(home, 'hud-watch');
  const mcpPub = createWorkSummaryPublisher(home, 'hud-mcp');
  const now = Date.now();
  assert.equal(watchPub.publish({ watching: true, now }), true);
  assert.equal(mcpPub.publish({ now: now + 10 }), false);
  assert.equal(readFreshWorkSummary(home, PANE_A, now + 20)?.snapshot.producer, 'hud-watch');
  fs.unlinkSync(join(home, 'watch.pid'));

  // Spawn real hud-mcp and call hud_respond -> should publish updated work-summary.v1.json.
  const mcp = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-mcp.mjs')], {
    env: { ...process.env, HUD_HOME: home, HERDR_PANE_ID: PANE_A },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exited = once(mcp, 'exit');
  t.after(async () => {
    mcp.stdin.end();
    if (mcp.exitCode === null) { mcp.kill('SIGTERM'); await exited; }
    // Also clean up any watcher spawned by hud_respond.
    try {
      const pid = Number(fs.readFileSync(join(home, 'watch.pid'), 'utf8').trim());
      if (pid > 1) process.kill(pid, 'SIGKILL');
    } catch { /* gone */ }
  });

  const rpc = (msg) => {
    mcp.stdin.write(JSON.stringify(msg) + '\n');
  };
  let buf = '';
  const replies = new Map();
  mcp.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const parsed = JSON.parse(line);
      if (parsed.id !== undefined) replies.get(parsed.id)?.(parsed);
    }
  });
  const call = (id, method, params) => new Promise((res) => {
    replies.set(id, res);
    rpc({ jsonrpc: '2.0', id, method, params });
  });

  await call(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  rpc({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  const resp = await call(2, 'tools/call', { name: 'hud_respond', arguments: { job: j1.id, request_id: 'q1', answer: 'Synthetic' } });
  assert.ok(!resp.result?.isError);

  const summary = await waitFor(() => readFreshWorkSummary(home, PANE_A), 3_000, 10);
  assert.equal(summary.scope.running, 1);
  assert.equal(summary.scope.asking, 0);
});
