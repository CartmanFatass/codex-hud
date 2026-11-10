import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { r5Fixture, idR5, ROOT_R5 } from '../fixtures/r5-jobs.js';
import { LIVE_CADENCE_MS } from '../../src/collectors/job-live-observation.js';
import { JobObservationCollector } from '../../src/collectors/job-observations.js';
import { composeJobTree } from '../../src/collectors/job-tree.js';
const web = {
  id: 'synthetic-web',
  executor: 'jev' as const,
  harness: null,
  model: 'target-model',
  effort: null,
  env_profile: null,
  recipe: null,
};

test('R5 roots, frozen bindings, null ids, metadata-only and contradictory first-seen records never guess joins', async (t) => {
  const f = r5Fixture(t),
    c = f.observer();
  const a = f.association(1);
  f.receipt(a);
  const b = f.association(2, { root: 'other/main' });
  f.receipt(b);
  f.association(3, { task_label: a.task_label }); // Missing receipt is an honest metadata-only row.
  const d = f.association(4);
  f.receipt(d, { parent: 'other/main' });
  f.put(join(f.home, 'assoc', `${idR5(5)}.json`), { schema: 1, job: idR5(5), root: '../main' });
  const n = f.association(6, { herdr: { agent: 'synthetic-agent', pane_id: null, tab_id: null, workspace_id: null } });
  f.receipt(n);
  const result = await f.collect(c);
  assert.deepEqual(result.tree.nodes.map((n) => n.id).sort(), [1, 3, 6].map((n) => `role-job:${idR5(n)}`).sort());
  assert.equal(result.tree.nodes[0]!.job!.backend!.model, 'launch-model');
  assert.equal(result.snapshot.jobs.find((j) => j.jobId === idR5(3))!.freshness.state, 'unavailable');
  assert.ok(result.coverage.diagnostics.some((d) => d.includes('receipt_mismatch')));
  assert.ok(result.coverage.diagnostics.some((d) => d.includes('association_invalid')));
  assert.equal(
    result.tree.nodes.every((n) => n.job!.root === ROOT_R5),
    true
  );
});

test('R5 damaged sources keep stale last-known, never-valid is unavailable, QA unreadable is unknown', async (t) => {
  const f = r5Fixture(t),
    c = f.observer();
  const a = f.association(1);
  f.dispatch(a);
  const directory = join(f.home, 'jobs', a.job);
  f.put(join(directory, 'qa', 'q1.md'), 'Synthetic question');
  let result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.requests!.length, 1);
  for (const mode of ['malformed', 'oversized', 'fifo', 'symlink', 'eacces', 'missing'] as const) {
    f.status(a);
    await f.collect(c);
    const status = join(directory, 'STATUS.json');
    fs.unlinkSync(status);
    if (mode === 'malformed') f.put(status, '{');
    if (mode === 'oversized') f.put(status, 'x'.repeat(65537));
    if (mode === 'fifo') execFileSync('mkfifo', [status]);
    if (mode === 'symlink') {
      const target = join(directory, 'synthetic-target');
      f.put(target, '{}');
      fs.symlinkSync(target, status);
    }
    if (mode === 'eacces') {
      f.put(status, '{}');
      fs.chmodSync(status, 0);
    }
    result = await f.collect(c);
    assert.equal(result.snapshot.jobs[0]!.freshness.state, 'stale', mode);
    assert.equal(result.tree.nodes[0]!.status, 'unknown', mode);
    assert.equal(result.snapshot.jobs[0]!.lifecycle, 'working', mode);
    if (fs.existsSync(status)) fs.unlinkSync(status);
  }
  f.status(a);
  fs.chmodSync(join(directory, 'qa'), 0);
  result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.requests, null, 'QA unreadable cannot fabricate zero pending requests');
  fs.chmodSync(join(directory, 'qa'), 0o700);
  fs.rmSync(join(directory, 'qa'), { recursive: true });
  result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.requests, null);
  const invalid = f.association(2);
  f.receipt(invalid);
  f.put(join(f.home, 'jobs', invalid.job, 'STATUS.json'), '{');
  // A required but never-valid STATUS cannot become an active row.
  f.dispatch(invalid);
  f.put(join(f.home, 'jobs', invalid.job, 'STATUS.json'), '{');
  result = await f.collect(c);
  assert.equal(result.snapshot.jobs.find((j) => j.jobId === invalid.job)!.freshness.state, 'unavailable');
  f.receipt(a, { parent: 'other/main' });
  result = await f.collect(c);
  assert.equal(result.snapshot.jobs.find((j) => j.jobId === a.job)!.root, ROOT_R5);
  assert.equal(result.snapshot.jobs.find((j) => j.jobId === a.job)!.freshness.state, 'stale');
});

test('R5 all pi states, historical questions, answer eligibility and continuation do not infer success from a report', async (t) => {
  const f = r5Fixture(t),
    c = f.observer();
  const a = f.association(1);
  f.dispatch(a);
  const directory = join(f.home, 'jobs', a.job),
    q = join(directory, 'qa', 'q1.md'),
    answer = join(directory, 'qa', 'q1.answer.md');
  f.put(q, 'Synthetic question');
  f.put(join(directory, 'report.md'), 'Verdict: accept\nOld synthetic report.');
  for (const [state, status, outcome] of [
    ['working', 'running', null],
    ['waiting_helper', 'running', null],
    ['waiting_orchestrator', 'unknown', null],
    ['idle_grace', 'completed', 'completed'],
    ['closed', 'completed', 'completed'],
    ['failed', 'error', 'failed'],
  ] as const) {
    f.status(a, state);
    const result = await f.collect(c);
    const job = result.snapshot.jobs[0]!;
    assert.equal(result.tree.nodes[0]!.status, status, state);
    assert.equal(job.outcome, outcome, state);
    assert.equal(job.requests![0]!.current, state === 'waiting_orchestrator');
  }
  f.status(a, 'waiting_orchestrator');
  f.put(answer, '');
  let result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.requests![0]!.state, 'unanswered');
  f.put(answer, 'Synthetic answer');
  fs.utimesSync(answer, new Date(1), new Date(1));
  result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.requests![0]!.state, 'unanswered');
  fs.utimesSync(answer, new Date(f.now()), new Date(f.now()));
  result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.requests![0]!.state, 'written_consumption_unconfirmed');
  f.receipt(a, {
    pi_dispatch: {
      contract_version: 1,
      role: 'implementer',
      executable: '/synthetic/dispatch',
      reaper: '/synthetic/reap',
      launch: 'acked',
      continuation: {
        message_key: 'synthetic-next',
        previous_session_id: 'synthetic-primary',
        previous_settled_at: '2026-11-09T00:01:00Z',
      },
    },
  });
  f.status(a, 'working', { output_written: true, settled_at: '2026-11-09T00:01:00Z' });
  result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.outcome, null);
  assert.notEqual(result.tree.nodes[0]!.status, 'completed');
  fs.unlinkSync(join(directory, 'report.md'));
  result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.report!.available, null);
  assert.equal(result.snapshot.jobs[0]!.freshness.state, 'stale');
});

test('R5 Jev statuses are exact; runtime absence, dead/reused pid are stale; answered survives close', async (t) => {
  const f = r5Fixture(t);
  let alive = true,
    cmdline = '/synthetic/dist/jev/runtime/entry.js\0';
  const c = f.observer(ROOT_R5, { alive: () => alive, cmdline: () => cmdline });
  const a = f.association(1, {
    backend: web,
    role: 'oracle',
    phase: 'propose',
    herdr: { agent: null, pane_id: null, tab_id: null, workspace_id: null },
  });
  for (const outcome of [
    'answered',
    'failed',
    'uncertain',
    'needs_human',
    'timed_out',
    'wait_failed',
    'incomplete',
    'already_attempted',
  ]) {
    f.jev(a, 'completed', { status: outcome, recoverable: outcome !== 'answered' });
    const result = await f.collect(c);
    assert.equal(result.snapshot.jobs[0]!.outcome, outcome);
    assert.equal(result.tree.totalCount, 1);
    assert.equal(result.tree.nodes[0]!.job!.backend!.model, 'target-model');
    assert.equal(result.tree.nodes[0]!.job!.decision!.model, 'decision-model');
    if (outcome !== 'answered' && outcome !== 'failed') assert.equal(result.tree.nodes[0]!.status, 'unknown');
  }
  for (const state of ['running', 'queued', 'interrupted']) {
    f.jev(a, state);
    await f.collect(c);
    alive = false;
    let result = await f.collect(c);
    assert.equal(result.snapshot.jobs[0]!.freshness.state, 'stale');
    assert.equal(result.tree.nodes[0]!.status, 'unknown');
    alive = true;
    cmdline = '/synthetic/not-runtime.js\0';
    result = await f.collect(c);
    assert.equal(result.snapshot.jobs[0]!.freshness.state, 'stale', 'live pid is not enough');
    cmdline = '/synthetic/dist/jev/runtime/entry.js\0';
    f.jev(a, state);
    await f.collect(c);
    fs.unlinkSync(join(f.home, 'jev-runtime', 'runtime.json'));
    result = await f.collect(c);
    assert.equal(result.snapshot.jobs[0]!.freshness.state, 'stale');
  }
  f.jev(a, 'closed', { status: 'answered' }, true);
  fs.unlinkSync(join(f.home, 'jev-runtime', 'runtime.json'));
  const result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.outcome, 'answered');
  assert.equal(result.tree.nodes[0]!.status, 'completed');
});

test('R5 repeated Jev observation is file-only and performs no socket connection or durable writes', async (t) => {
  const f = r5Fixture(t),
    c = f.observer();
  const a = f.association(1, { backend: web });
  f.jev(a, 'running');
  let connects = 0;
  const server = createServer((socket) => {
    connects++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(join(f.home, 'jev-runtime', 'runtime.sock'), resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const snapshot = (path: string): string =>
    JSON.stringify(
      fs
        .readdirSync(path, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => [
          e.name,
          e.isDirectory()
            ? snapshot(join(path, e.name))
            : e.isFile()
              ? fs.readFileSync(join(path, e.name)).toString('base64')
              : 'socket',
        ])
    );
  const before = snapshot(f.home);
  const require = createRequire(import.meta.url);
  const originals: Array<[Record<string, unknown>, string, unknown]> = [];
  let writes = 0,
    launches = 0;
  const spy = (target: Record<string, unknown>, methods: string[], kind: 'write' | 'launch') => {
    for (const method of methods) {
      originals.push([target, method, target[method]]);
      target[method] = () => {
        if (kind === 'write') writes++;
        else launches++;
        throw new Error(`unexpected_${kind}_${method}`);
      };
    }
  };
  spy(
    require('node:fs'),
    ['writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'unlinkSync', 'rmSync', 'linkSync', 'symlinkSync'],
    'write'
  );
  spy(
    require('node:fs/promises'),
    ['writeFile', 'appendFile', 'rename', 'mkdir', 'unlink', 'rm', 'link', 'symlink'],
    'write'
  );
  spy(
    require('node:child_process'),
    ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
    'launch'
  );
  syncBuiltinESMExports();
  try {
    await f.collect(c, 50);
    assert.equal(snapshot(f.home), before);
    assert.equal(connects, 0);
    assert.equal(writes, 0);
    assert.equal(launches, 0);
  } finally {
    for (const [target, method, value] of originals) target[method] = value;
    syncBuiltinESMExports();
  }
});

test('R5 Herdr sampling is single-flight/cadenced/bounded and never discovers unregistered agents', async (t) => {
  const f = r5Fixture(t);
  const a = f.association(1);
  f.receipt(a);
  let calls = 0,
    mode = 'ok';
  let release: (() => void) | undefined;
  const c = new JobObservationCollector(f.home, {
    root: ROOT_R5,
    now: f.now,
    herdr: async () => {
      calls++;
      if (mode === 'slow')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (mode === 'absent') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (mode === 'malformed') return '{';
      return JSON.stringify({
        result: {
          agents: [
            {
              name: mode === 'missing' ? 'unregistered' : a.herdr.agent,
              pane_id: mode === 'reuse' ? 'different-pane' : a.herdr.pane_id,
              tab_id: a.herdr.tab_id,
              agent_status: 'working',
            },
            { name: 'unmatched', pane_id: 'other', tab_id: 'other', agent_status: 'working' },
          ],
        },
      });
    },
  });
  t.after(() => c.dispose());
  let result = await f.collect(c);
  assert.equal(result.tree.totalCount, 1);
  assert.equal(result.tree.nodes[0]!.status, 'running');
  assert.equal(calls, 1);
  for (mode of ['absent', 'malformed', 'missing', 'reuse', 'ok']) {
    f.advance(LIVE_CADENCE_MS);
    await c.refresh();
    await c.live.settled();
    result = await f.collect(c);
    assert.equal(result.tree.totalCount, 1);
    assert.equal(result.tree.nodes[0]!.status, mode === 'ok' ? 'running' : 'unknown');
  }
  mode = 'slow';
  f.advance(LIVE_CADENCE_MS);
  await c.refresh();
  await new Promise((resolve) => setTimeout(resolve, 280));
  const slowCalls = calls;
  for (let n = 0; n < 10; n++) {
    f.advance(5000);
    await c.refresh();
  }
  assert.equal(calls, slowCalls, 'timeout must not release a still-in-flight runner');
  const slow = composeJobTree({ tree: f.emptyTree(), snapshot: await c.refresh(), root: ROOT_R5, nowMs: f.now() });
  assert.equal(slow.tree.nodes[0]!.status, 'unknown');
  release!();
  await c.live.settled();
  mode = 'ok';
  f.advance(5000);
  await c.refresh();
  await c.live.settled();
  result = await f.collect(c);
  assert.equal(result.tree.nodes[0]!.status, 'running');
});

test('R5 snapshots are reduced/immutable, dispatch session changes advance evidence, and failure survives cleanup', async (t) => {
  const f = r5Fixture(t),
    c = f.observer(),
    a = f.association(1);
  f.dispatch(a, 'failed');
  const file = join(f.home, 'assoc', `${a.job}.json`),
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.prompt = 'DO_NOT_COPY';
  raw.backend.credentials = 'DO_NOT_COPY';
  raw.herdr.environment = 'DO_NOT_COPY';
  f.put(file, raw);
  let result = await f.collect(c);
  assert.equal(JSON.stringify(result.snapshot).includes('DO_NOT_COPY'), false);
  assert.equal(Object.isFrozen(result.snapshot.jobs[0]!.backend), true);
  assert.throws(() => {
    (result.snapshot.jobs[0]!.backend as { model: string }).model = 'changed';
  }, TypeError);
  f.status(a, 'closed');
  result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.outcome, 'failed');
  assert.equal(result.tree.nodes[0]!.status, 'error');
  f.status(a, 'working', { session_id: 'first-session' });
  result = await f.collect(c);
  const first = result.snapshot.jobs[0]!.freshness.evidenceAt;
  f.advance(1); // A distinct evidence date is explicit, not elapsed filesystem wall time.
  f.status(a, 'working', { session_id: 'second-session' });
  result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.dispatchSession, 'second-session');
  assert.notEqual(result.snapshot.jobs[0]!.freshness.evidenceAt, first);
  const evidence = result.snapshot.jobs[0]!.freshness.evidenceAt;
  f.advance(1000);
  result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.freshness.evidenceAt, evidence);
  f.receipt(a);
  f.put(join(f.home, 'jobs', a.job, 'qa', 'q1.md'), 'Question');
  f.put(join(f.home, 'jobs', a.job, 'qa', 'q1.answer.md'), '');
  result = await f.collect(c);
  assert.equal(
    result.snapshot.jobs[0]!.requests![0]!.state,
    'written_consumption_unconfirmed',
    'direct-Pi answer protocol differs from dispatch'
  );
});

test('R5 an absent private home remains absent under idle observation', async (t) => {
  const f = r5Fixture(t),
    home = join(f.home, 'absent');
  const c = new JobObservationCollector(home, { herdr: async () => '{"agents":[]}' });
  t.after(() => c.dispose());
  assert.equal((await c.refresh()).jobs.length, 0);
  assert.equal(fs.existsSync(home), false);
});

test('R5 reviewed Jev results preserve blocked browse and per-statement judge verdicts without fabricated success', async (t) => {
  const f = r5Fixture(t),
    c = f.observer(),
    a = f.association(1, { role: 'jev', backend: web });
  for (const outcome of ['done', 'blocked']) {
    f.jev(a, 'completed', { status: outcome, steps: 1, goal: 'Synthetic goal' }, false, {
      tag: 'browse',
      input: { tag: 'browse', url: 'https://example.test/', goal: 'Synthetic goal' },
    });
    const result = await f.collect(c);
    assert.equal(result.snapshot.jobs[0]!.outcome, outcome);
    assert.equal(result.tree.nodes[0]!.status, outcome === 'done' ? 'completed' : 'unknown');
  }
  for (const verdicts of [['pass', 'deny'], ['pass', 'unsettled'], ['timeout'], ['needs_human'], []]) {
    const statements = verdicts.map((verdict, i) => ({ name: `synthetic-${i}`, verdict, privateField: 'DO_NOT_COPY' }));
    for (const state of ['completed', 'closed']) {
      f.jev(a, state, { statements, calls: 1, extendedMs: 0 }, state === 'closed', {
        tag: 'judge',
        input: {
          tag: 'judge',
          url: 'https://example.test/',
          statements: statements.map((s) => ({ name: s.name, statement: 'Synthetic statement' })),
        },
      });
      const result = await f.collect(c);
      assert.equal(result.snapshot.jobs[0]!.outcome, null);
      assert.deepEqual(
        result.snapshot.jobs[0]!.judgments,
        statements.map(({ name, verdict }) => ({ name, verdict }))
      );
      assert.equal(
        result.tree.nodes[0]!.status,
        verdicts.length > 0 && verdicts.every((v) => v === 'pass' || v === 'deny') ? 'completed' : 'unknown'
      );
      assert.equal(JSON.stringify(result.snapshot).includes('DO_NOT_COPY'), false);
    }
  }
  f.jev(a, 'failed', null, false, { tag: 'judge' });
  let result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.outcome, 'failed');
  assert.equal(result.tree.nodes[0]!.status, 'error');
  for (const [n, tag] of [
    [2, 'browse'],
    [3, 'judge'],
  ] as const) {
    const invalid = f.association(n, { role: 'jev', backend: web });
    f.jev(invalid, 'completed', undefined, false, { tag, result: undefined });
    result = await f.collect(c);
    const job = result.snapshot.jobs.find((j) => j.jobId === invalid.job)!;
    assert.equal(job.freshness.state, 'unavailable');
    assert.notEqual(job.status, 'completed');
    assert.ok(result.coverage.diagnostics.some((d) => d.includes('runtime_result_invalid')));
  }
});

test('R5 reviewed Jev expiry demotes all pending rows while a multi-slice scheduler catches up', async (t) => {
  const f = r5Fixture(t);
  let alive = true;
  const c = f.observer(ROOT_R5, { alive: () => alive, cmdline: () => '/synthetic/dist/jev/runtime/entry.js\0' });
  for (let n = 1; n <= 150; n++) f.jev(f.association(n, { role: 'jev', backend: web }));
  let result = await f.collect(c, 200);
  assert.equal(result.snapshot.jobs.length, 150);
  assert.ok(result.snapshot.jobs.every((j) => j.status === 'running' && j.freshness.state === 'current'));
  alive = false;
  f.advance(20000);
  const snapshot = await c.refresh();
  const composed = composeJobTree({ tree: f.emptyTree(), snapshot, root: ROOT_R5, nowMs: f.now() });
  assert.equal(snapshot.jobs.length, 150);
  assert.ok(snapshot.jobs.every((j) => j.status === 'unknown' && j.freshness.state === 'stale'));
  assert.ok(composed.tree.nodes.every((n) => n.status === 'unknown'));
  assert.ok(snapshot.coverage.files <= 32);
  alive = true;
  result = await f.collect(c, 200);
  assert.ok(result.snapshot.jobs.every((j) => j.status === 'running' && j.freshness.state === 'current'));
});

test('R5 reviewed direct Herdr cleanup never resurrects running or erases a known outcome', async (t) => {
  const f = r5Fixture(t),
    c = f.observer();
  for (const [n, state, outcome, status] of [
    [1, 'open', null, 'unknown'],
    [2, 'done', 'completed', 'completed'],
    [3, 'failed', 'failed', 'error'],
  ] as const) {
    const a = f.association(n);
    f.receipt(a, { state });
    await f.collect(c);
    f.receipt(a, { state: 'closed' });
    let result = await f.collect(c);
    let job = result.snapshot.jobs.find((j) => j.jobId === a.job)!;
    assert.equal(job.lifecycle, 'closed');
    assert.equal(job.outcome, outcome);
    assert.equal(job.status, status);
    f.list('{"agents":[]}');
    f.advance(5000);
    await c.refresh();
    await c.live.settled();
    result = await f.collect(c);
    job = result.snapshot.jobs.find((j) => j.jobId === a.job)!;
    assert.equal(job.outcome, outcome);
    assert.equal(job.status, status);
    f.list(
      JSON.stringify({
        agents: [{ name: 'synthetic-agent', pane_id: 'pane-1', tab_id: 'tab-1', agent_status: 'working' }],
      })
    );
    f.advance(5000);
    await c.refresh();
    await c.live.settled();
  }
});

test('R5 reviewed QA file errors remain unknown on every scan and recover independently of an absent report', async (t) => {
  const f = r5Fixture(t),
    c = f.observer(),
    a = f.association(1);
  f.dispatch(a);
  const dir = join(f.home, 'jobs', a.job),
    q = join(dir, 'qa', 'q1.md'),
    answer = join(dir, 'qa', 'q1.answer.md');
  f.put(q, 'Synthetic question');
  let result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.report!.available, false);
  for (const file of [q, answer]) {
    if (file === answer) f.put(answer, 'Synthetic answer');
    fs.chmodSync(file, 0);
    for (let tick = 0; tick < 8; tick++) {
      result = await f.collect(c);
      assert.equal(result.snapshot.jobs[0]!.requests, null);
      assert.equal(result.snapshot.jobs[0]!.report!.available, false);
    }
    fs.chmodSync(file, 0o600);
    result = await f.collect(c);
    assert.equal(result.snapshot.jobs[0]!.freshness.state, 'current');
    assert.equal(result.snapshot.jobs[0]!.status, 'running');
    assert.equal(result.snapshot.jobs[0]!.report!.available, false);
  }
  fs.chmodSync(join(dir, 'qa'), 0);
  await f.collect(c);
  fs.chmodSync(join(dir, 'qa'), 0o700);
  result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.freshness.state, 'current');
  assert.equal(result.snapshot.jobs[0]!.report!.available, false);
});

test('R5 reviewed historical helper questions require the primary active-helper relation and readable evidence', async (t) => {
  const f = r5Fixture(t),
    c = f.observer(),
    a = f.association(1);
  f.dispatch(a);
  f.status(a, 'waiting_orchestrator', {}, 'review-1');
  f.put(join(f.home, 'jobs', a.job, 'qa', 'q1.md'), 'Historical synthetic question');
  let result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.requests![0]!.current, false);
  f.status(a, 'waiting_helper', {
    helper_pending: {
      kind: 'review',
      n: 1,
      status_file: join(f.home, 'jobs', a.job, '.dispatch', 'review-1', 'STATUS.json'),
    },
  });
  result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.requests![0]!.current, true);
  f.put(join(f.home, 'jobs', a.job, '.dispatch', 'review-1', 'STATUS.json'), '{');
  result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.helpers[0]!.freshness.state, 'stale');
  assert.equal(result.snapshot.jobs[0]!.requests![0]!.current, false);
  f.status(a, 'waiting_orchestrator', {}, 'review-1');
  result = await f.collect(c);
  assert.equal(result.snapshot.jobs[0]!.requests![0]!.current, true);
});

test('R5 root change/dispose fences late file/live callbacks', async (t) => {
  const f = r5Fixture(t),
    a = f.association(1);
  f.receipt(a);
  const c = f.observer();
  const pending = c.refresh();
  c.setRoot('other/main');
  await pending;
  const result = await c.refresh();
  assert.equal(result.jobs.length, 0);
  c.dispose();
  assert.equal((await c.refresh()).jobs.length, 0);
});
