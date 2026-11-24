import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  collectWorkSummary,
  createWorkSummaryPublisher,
  readFreshWorkSummary,
  readMachineWork,
  WORK_SUMMARY_MAX_BYTES,
  WORK_SUMMARY_MCP_TTL_MS,
  workSummaryPath,
} from '../../dist/collectors/work-summary-snapshot.js';
import { createPiSegment } from '../../dist/harness/pi/segment.js';
import { readCodexStatusline } from '../../dist/mcp/codex-statusline.js';
import { fitStatusBar } from '../../dist/render/header.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { DEFAULT_LAYOUT } from '../../dist/types.js';
import { makeHudData } from '../../dist-test/fixtures/hud-data.js';
import { parityFixture } from '../../dist-test/fixtures/pi-footer.js';
import { writePrivateFile } from '../../dist/utils/atomic-fs.js';
import { until } from '../helpers/until.mjs';

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
      project_root: opts.project ?? '/synthetic/first',
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

test('collectWorkSummary separates queued and settled jobs and counts asking workers as live', (t) => {
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
  assert.equal(summary.global.queued, 1);
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
  writePrivateFile(file, JSON.stringify({ ...fresh.snapshot, global: { ...fresh.snapshot.global, asking: 2 } }));
  assert.equal(readFreshWorkSummary(home, PANE_A, t0), null);
  for (const queued of [undefined, -1, 0.5, '1']) {
    writePrivateFile(file, JSON.stringify({ ...fresh.snapshot, global: { ...fresh.snapshot.global, queued } }));
    assert.equal(readMachineWork(home, t0), undefined);
  }
  writePrivateFile(file, ' '.repeat(WORK_SUMMARY_MAX_BYTES + 16));
  assert.equal(readFreshWorkSummary(home, PANE_A, t0), null);
});

test('hud-watch updates work-summary.v1.json within 200 ms of job changes and staleness is detected on watcher exit', { timeout: 60_000 }, async (t) => {
  const { home, addJob } = makeFixture(t);
  const j1 = addJob({ role: 'imp', pane: PANE_A, status: { state: 'working' } });
  const j2 = addJob({ role: 'sonic', pane: PANE_B, status: { state: 'working' } });
  assert.ok(j2.id);
  fs.mkdirSync(join(j1.dir, 'qa')); // Attach the recursive watch before publishing the question.

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

  const summaryFile = workSummaryPath(home);
  const readSummary = async (matches = () => true) => {
    let result;
    await until(() => {
      result = readFreshWorkSummary(home, PANE_A);
      return result && matches(result.scope);
    }, t.signal);
    return result;
  };
  const initial = await readSummary();
  assert.equal(initial.snapshot.producer, 'hud-watch');
  assert.equal(initial.snapshot.watching, true);
  assert.equal(fs.statSync(summaryFile).mode & 0o777, 0o600);
  assert.deepEqual(initial.scope, { running: 1, asking: 0, roles: { imp: { running: 1, asking: 0 } } });
  assert.equal(initial.snapshot.global.running, 2);

  const update = async (file, value, matches, action) => {
    const input = join(j1.dir, file);
    writePrivateFile(input, value);
    const changedAt = fs.statSync(input).ctimeMs;
    const result = await readSummary(matches);
    // Linux stamps ctime at each atomic rename. Measure publication to publication,
    // not the test process's scheduling delay before the write or after the snapshot.
    const elapsed = fs.statSync(summaryFile).ctimeMs - changedAt;
    assert.ok(elapsed < 200, `expected <200ms update on ${action}, got ${elapsed.toFixed(1)}ms`);
    return result;
  };

  const asked = await update('qa/q1.md', '# Question q1 from imp\n\nSynthetic?', scope => scope.asking === 1, 'question');
  assert.ok(asked.snapshot.generation > initial.snapshot.generation);
  const answered = await update('qa/q1.answer.md', 'Synthetic answer', scope => scope.asking === 0, 'answer');
  assert.ok(answered.snapshot.generation > asked.snapshot.generation);
  // j2 keeps the watcher alive after j1 closes.
  const closed = await update('STATUS.json', JSON.stringify({ state: 'closed', settled_at: new Date().toISOString() }),
    scope => scope.running === 0, 'close');
  assert.equal(closed.snapshot.global.running, 1);

  // Kill watcher with SIGKILL (simulating crash where watch.pid remains) -> stale immediately detected.
  child.kill('SIGKILL');
  await exited;
  assert.equal(readFreshWorkSummary(home, PANE_A), null);
  assert.equal(readFreshWorkSummary(home, null), null);
});

test('pi reads a fresh machine census without scanning jobs and omits it when the watcher exits', { timeout: 15_000 }, async (t) => {
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

  const signalsLog = [];
  let timer;
  const segment = createPiSegment({
    env: { HUD_HOME: home, HERDR_PANE_ID: PANE_A },
    schedule(fn) { timer = fn; return () => {}; },
    onSignals(signals) { signalsLog.push(signals); },
    statusVisible: () => false,
  });
  t.after(() => {
    segment.stop();
    fs.readdirSync = origReaddir;
    syncBuiltinESMExports();
  });

  let lastStatus;
  const ctx = { mode: 'tui', hasUI: true, ui: { setStatus(_k, v) { lastStatus = v; } } };
  segment.start(ctx, () => true);
  assert.equal(lastStatus, undefined, 'the owned footer already shows the load');
  assert.deepEqual(signalsLog.at(-1), { running: 1, queued: 0, roles: { imp: { running: 1, asking: 0 } } });
  assert.equal(jobsScans, 0, 'fresh snapshot path must not enumerate jobs/');

  // Update job -> watcher updates snapshot -> segment picks it up without scanning jobs/.
  writePrivateFile(join(j1.dir, 'qa', 'q1.md'), '# Question q1 from imp\n\nSynthetic?');
  await waitFor(() => readFreshWorkSummary(home, PANE_A)?.scope.asking === 1);
  timer();
  assert.equal(lastStatus, undefined);
  assert.deepEqual(signalsLog.at(-1), { running: 1, queued: 0, roles: { imp: { running: 1, asking: 1 } } });
  assert.equal(jobsScans, 0);

  child.kill('SIGTERM');
  await exited;
  timer();
  assert.equal(signalsLog.at(-1), undefined);
  assert.equal(jobsScans, 0, 'do not substitute a pane scan for stale machine data');
});

test('Claude, Antigravity, pi and Codex show identical per-role load in every pane', (t) => {
  const { home, addJob } = makeFixture(t);
  const previous = setDisplayConfig({});
  t.after(() => setDisplayConfig(previous));
  const workers = Object.entries({ imp: 3, general: 2, oracle: 1, sonic: 4 }).flatMap(([role, n]) =>
    Array.from({ length: n }, (_, i) => addJob(i ? { role, pane: PANE_B, project: '/synthetic/second' } : { role })));
  writePrivateFile(join(workers[0].dir, 'qa', 'q1.md'), '# Synthetic question for main');
  const queued = [addJob({ status: { state: 'queued' } }), addJob({ status: { state: 'queued' } })];
  const publisher = createWorkSummaryPublisher(home, 'hud-watch');
  writePrivateFile(join(home, 'watch.pid'), `${process.pid}\n`);
  const panes = [PANE_A, PANE_B, 'idle-pane'];
  const procRoot = join(home, 'missing-proc');
  const oldProcRoot = process.env.HUD_STATUSLINE_PROC_ROOT;
  process.env.HUD_STATUSLINE_PROC_ROOT = procRoot;
  t.after(() => {
    if (oldProcRoot === undefined) delete process.env.HUD_STATUSLINE_PROC_ROOT;
    else process.env.HUD_STATUSLINE_PROC_ROOT = oldProcRoot;
  });
  const clients = panes.map((pane, i) => {
    const env = { ...process.env, HOME: home, HUD_HOME: home, HERDR_PANE_ID: pane, NO_COLOR: '1' };
    const footer = parityFixture({ name: `machine-work-${i}`, width: 160, env: { HUD_HOME: home, HERDR_PANE_ID: pane, NO_COLOR: '1' } });
    const segment = createPiSegment({ env, schedule: () => () => {}, statusVisible: () => false,
      onSignals(work) { footer.controller.setWork(work); } });
    segment.start(footer.ctx, () => true);
    t.after(() => { segment.stop(); footer.dispose(); });
    return () => {
      footer.controller.settled();
      segment.refresh();
      const render = (cmd, args, input) => {
        const result = spawnSync(cmd, [...args, '--width', '160'], {
          env, encoding: 'utf8', input: JSON.stringify(input), timeout: 5000,
        });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      const input = { model: { display_name: 'Synthetic' } };
      const cli = [resolve('bin/hud-statusline')];
      const claude = render(process.execPath, cli, input);
      const agy = render(process.execPath, cli, { ...input, product: 'antigravity' });
      const native = resolve('dist/native/hud-statusline');
      if (fs.existsSync(native)) assert.equal(render(native, [], input), claude);
      const codexNative = JSON.parse(readCodexStatusline({}, home).contents[0].text).children.map((node) => node.children.join('')).join(' ');
      const codexBar = fitStatusBar(makeHudData({ work: readMachineWork(home, Date.now()) }), DEFAULT_LAYOUT, 160).line;
      return [claude, agy, footer.render()[0], codexNative, codexBar];
    };
  });
  const assertCounts = (icons, expected) => {
    writePrivateFile(join(home, 'hud-settings.json'), JSON.stringify({ icons, theme: 'none' }));
    assert.equal(readFreshWorkSummary(home, panes[2]).scope.running, 0);
    for (const render of clients) for (const line of render()) {
      if (expected) assert.ok(line.includes(expected), line);
      else assert.doesNotMatch(line, /⚒|✦|◈|⚡|◷/);
      assert.doesNotMatch(line, /\x1b|!1|needs you|asks/);
    }
  };
  assert.equal(publisher.publish({ watching: true }), true);
  assertCounts('unicode', '⚒3  ✦2  ◈1  ⚡4  ◷2');
  assertCounts('text', 'I3  G2  O1  *4  Q2');
  const close = (jobs) => {
    for (const job of jobs) job.setStatus({ state: 'closed' });
    assert.equal(publisher.publish({ watching: true }), true);
  };
  close(queued);
  assertCounts('unicode', '⚒3  ✦2  ◈1  ⚡4');
  close(workers);
  assertCounts('unicode', '');
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

test('markDegraded republishes watching=false without touching jobs/ and collectWorkSummary skips reaped_at STATUS reads', (t) => {
  const { home, addJob } = makeFixture(t);
  addJob({ role: 'imp', pane: PANE_A, status: { state: 'working' } });
  const reaped = addJob({ role: 'imp', pane: PANE_A, status: { state: 'closed' } });
  const reapedJobPath = join(reaped.dir, 'job.json');
  const reapedJob = JSON.parse(fs.readFileSync(reapedJobPath, 'utf8'));
  writePrivateFile(reapedJobPath, JSON.stringify({ ...reapedJob, reaped_at: new Date().toISOString() }));
  writePrivateFile(join(home, 'watch.pid'), `${process.pid}\n`);

  const statusStats = [];
  let jobsDirStats = 0;
  const origLstat = fs.lstatSync;
  fs.lstatSync = (target, ...args) => {
    const p = String(target);
    if (p === join(home, 'jobs')) jobsDirStats++;
    if (p.endsWith('/STATUS.json')) statusStats.push(p);
    return origLstat(target, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.lstatSync = origLstat;
    syncBuiltinESMExports();
  });

  const pub = createWorkSummaryPublisher(home, 'hud-watch');
  const now = Date.now();
  assert.equal(pub.publish({ watching: true, now, ids: fs.readdirSync(join(home, 'jobs')), jobsExist: true }), true);
  assert.equal(jobsDirStats, 0, 'prelisted ids must not lstat jobs/');
  assert.equal(statusStats.some((p) => p.includes(reaped.id)), false, 'reaped job must not lstat STATUS.json');
  assert.equal(readFreshWorkSummary(home, PANE_A, now)?.snapshot.watching, true);

  statusStats.length = 0;
  assert.equal(pub.markDegraded(now + 50), true);
  assert.equal(jobsDirStats, 0, 'markDegraded must not lstat jobs/');
  assert.equal(statusStats.length, 0, 'markDegraded must not re-read STATUS.json');
  assert.equal(readFreshWorkSummary(home, PANE_A, now + 50)?.snapshot.watching, false);
  assert.equal(pub.markDegraded(now + 60), false, 'duplicate markDegraded is a no-op');
});
