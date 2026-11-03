import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { writeFileSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import { sourceFixture, runtimeRow } from './b10d-fixture.mjs';
async function waitUntil(predicate, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > until) throw Error('boundary_wait_timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function start(t, entry) {
  const f = await sourceFixture(3, 3),
    trace = join(f.home, 'boundary.jsonl');
  writeFileSync(trace, '');
  const settings = join(f.home, 'settings.json');
  writeFileSync(
    settings,
    JSON.stringify({
      briefing: 'off',
      briefAgents: false,
      briefMain: false,
      agentProgress: false,
      agentLabels: false,
      resultDigest: false,
      notify: false,
    })
  );
  const refs = [f.parent, ...f.targets].map((ref) => ({
    sessionId: ref.sessionId,
    path: f.file(ref.sessionId),
    modifiedAt: new Date(),
    timestamp: new Date(),
    size: statSync(f.file(ref.sessionId)).size,
  }));
  const child = fork(resolve(entry === 'panel' ? 'dist/tree-page.js' : 'dist/index.js'), [], {
    cwd: f.sourceRoot,
    execArgv: ['--import', new URL('./b10d-boundary-preload.mjs', import.meta.url).href],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: f.home,
      HUD_HOME: f.home,
      CODEX_HOME: f.sourceRoot,
      CODEX_HUD_CWD: '/synthetic/project',
      CODEX_HUD_SETTINGS_PATH: settings,
      TERM: 'xterm-256color',
      B10D_BOUNDARY_TRACE: trace,
      B10D_BOUNDARY_REFS: JSON.stringify(refs),
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  let seq = 0,
    stderr = '';
  const pending = new Map();
  child.stderr.on('data', (b) => (stderr += b));
  child.stdout.resume();
  child.on('message', (m) => {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      clearTimeout(p.timer);
      m.error ? p.reject(Error(m.error)) : p.resolve(m.result);
    }
  });
  const done = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
      await done;
      clearTimeout(timer);
    }
    f.cleanup();
  });
  const rpc = (command, value = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq,
        timer = setTimeout(() => reject(Error(command + ' ' + stderr)), 15000);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, command, ...value });
    });
  const rows = () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  await waitUntil(() => rows().some((r) => r.kind === 'setup'), 15000);
  return { f, child, rpc, rows, stderr: () => stderr };
}
test('B10D real panel defers startup/scope/build-failure/ABA results and consumes each hidden surface without pseudo paint', async (t) => {
  const p = await start(t, 'panel'),
    { rpc, rows } = p;
  await waitUntil(() => rows().some((r) => r.kind === 'gate'), 15000);
  await waitUntil(async () => (await rpc('state')).diagnostics.unconsumed === 1, 15000);
  let s = await rpc('state');
  assert.equal(s.hud, undefined);
  assert.equal(
    rows().some((r) => r.kind === 'sample'),
    false
  );
  await rpc('render');
  assert.equal(rows().filter((r) => r.kind === 'paint_attempt').length, 0);
  await rpc('release');
  await waitUntil(() => rows().some((r) => r.kind === 'sample'), 15000);
  assert.ok(
    rows()
      .filter((r) => r.kind === 'paint_attempt')
      .every((r) => r.compatible && r.exact)
  );
  // B's real result arrives while the yielding legacy collection still has A's successful HUD.
  await rpc('hold');
  await rpc('select', { index: 1 });
  await rpc('collect');
  await waitUntil(async () => (await rpc('state')).held && (await rpc('state')).diagnostics.unconsumed === 1, 15000);
  s = await rpc('state');
  assert.equal(s.hud, p.f.parent.sessionId);
  assert.equal(s.compatible, false);
  const count = rows().filter((r) => r.kind === 'sample').length,
    grants = rows().filter((r) => r.kind === 'root_submit').length;
  await rpc('render');
  assert.equal(rows().filter((r) => r.kind === 'sample').length, count);
  await rpc('fail', { enabled: true });
  await rpc('release');
  await waitUntil(() => rows().some((r) => r.kind === 'build_failure'), 15000);
  await rpc('render');
  assert.equal((await rpc('state')).diagnostics.unconsumed, 1);
  assert.equal(rows().filter((r) => r.kind === 'sample').length, count);
  // A -> B again is a different epoch; stale A HUD cannot consume B even if session strings repeat.
  await rpc('select', { index: 0 });
  await rpc('select', { index: 1 });
  await rpc('render');
  assert.equal(rows().filter((r) => r.kind === 'sample').length, count);
  await rpc('fail', { enabled: false });
  await rpc('collect');
  await waitUntil(async () => (await rpc('state')).compatible, 15000);
  await rpc('render');
  // The old-epoch result is explicitly rejected; the coalesced current request then uses zero root.
  await waitUntil(async () => (await rpc('state')).diagnostics.unconsumed === 0, 15000);
  assert.equal(rows().filter((r) => r.kind === 'root_submit').length, grants);
  for (const mode of ['settings', 'activity', 'observability']) {
    await rpc('surface', { mode });
    const n = rows().filter((r) => r.kind === 'sample').length;
    appendFileSync(p.f.file(p.f.targets[0].sessionId), runtimeRow('event_msg', { type: 'task_started' }, 50 + n));
    await rpc('collect');
    await waitUntil(() => rows().filter((r) => r.kind === 'sample').length > n, 15000);
    const sample = rows()
      .filter((r) => r.kind === 'sample')
      .at(-1);
    assert.equal(sample.presentationReason, 'hidden_' + mode);
    assert.equal(sample.paintMs, null);
    assert.equal(sample.renderMs, null);
    assert.equal(sample.commitToPaintUpperMs, null);
    assert.ok(sample.outcome === 'continued' || sample.outcome === 'failed');
    if (sample.changed) assert.ok(sample.commits.length > 0);
    s = await rpc('state');
    assert.ok(s.diagnostics.pending <= 1 && s.diagnostics.active <= 1 && s.diagnostics.unconsumed === 0);
  }
  // A compatible hidden build also rejects an obsolete epoch without pretending to paint it.
  await rpc('hold');
  await rpc('select', { index: 0 });
  await rpc('collect');
  await waitUntil(async () => (await rpc('state')).held && (await rpc('state')).diagnostics.unconsumed === 1);
  await rpc('select', { index: 1 });
  await rpc('select', { index: 0 });
  await rpc('release');
  await waitUntil(async () => !(await rpc('state')).held);
  await rpc('collect');
  await waitUntil(
    async () =>
      (await rpc('state')).compatible &&
      (await rpc('state')).diagnostics.unconsumed === 0 &&
      (await rpc('state')).diagnostics.active === 0
  );
  for (const row of rows().filter((r) => r.kind === 'sample' && r.outcome === 'rejected')) {
    assert.equal(row.paintMs, null);
    assert.equal(row.renderMs, null);
    assert.equal(row.commitToPaintUpperMs, null);
  }
  const n = rows().filter((r) => r.kind === 'sample').length,
    roots = rows().filter((r) => r.kind === 'root_submit').length;
  const newest = (await rpc('state')).latestSeq;
  await rpc('surface', { mode: 'monitor' });
  await rpc('render');
  assert.equal(
    rows()
      .filter((r) => r.kind === 'monitor')
      .at(-1).latestSeq,
    newest
  );
  assert.equal(rows().filter((r) => r.kind === 'sample').length, n);
  assert.equal(rows().filter((r) => r.kind === 'root_submit').length, roots);
  assert.ok(
    rows()
      .filter((r) => r.kind === 'paint_attempt')
      .every((r) => r.compatible && r.exact)
  );
});
test('B10D real bar parser scope ABA conservatively charges a stats-clearing read and never marks it healthy', async (t) => {
  const p = await start(t, 'bar'),
    { rpc, rows } = p;
  await waitUntil(() => rows().some((r) => r.kind === 'sample'), 15000);
  await waitUntil(async () => (await rpc('state')).diagnostics.active === 0, 15000);
  await rpc('parseRace');
  appendFileSync(p.f.file(p.f.parent.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  await rpc('collect');
  await waitUntil(() => rows().some((r) => r.kind === 'parse_superseded'), 15000);
  const xs = rows(),
    at = xs.findIndex((r) => r.kind === 'parse_superseded'),
    submission = xs.slice(at).find((r) => r.kind === 'root_submit');
  assert.ok(submission?.failed);
  assert.equal(xs[at].statsCleared, true);
  assert.equal(
    xs.slice(at, xs.indexOf(submission)).some((r) => r.kind === 'health_read'),
    false
  );
  await waitUntil(() => rows().some((r) => r.kind === 'sample' && r.requestId === submission.requestId), 15000);
  const outcome = rows().find((r) => r.kind === 'sample' && r.requestId === submission.requestId);
  assert.ok(outcome.bytesRead >= 4 * 1024 * 1024);
  assert.ok(outcome.outcome === 'rejected' || outcome.outcome === 'failed');
});
test('B10D actual bar entry enqueues visibly changed committed delegation counts before its paint sample', async (t) => {
  const p = await start(t, 'bar'),
    { rpc, rows } = p;
  await waitUntil(() => rows().some((r) => r.kind === 'sample'), 15000);
  for (let i = 0; i < 12; i++) {
    await rpc('collect');
    await waitUntil(async () => (await rpc('state')).diagnostics.active === 0, 15000);
  }
  const before = rows()
    .filter((r) => r.kind === 'frame')
    .map((r) => r.text)
    .join('');
  assert.doesNotMatch(before.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''), /1▸/);
  const at = Date.now();
  p.f.db.prepare('UPDATE runs SET heartbeat_at=?,heartbeat_seq=1,heartbeat_mono_ms=?').run(at, at);
  appendFileSync(p.f.file(p.f.targets[0].sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  const startIndex = rows().length;
  for (let i = 0; i < 30; i++) {
    await rpc('collect');
    await waitUntil(async () => (await rpc('state')).diagnostics.active === 0, 15000);
    if (
      rows()
        .slice(startIndex)
        .some((r) => r.kind === 'frame' && /1▸/.test(r.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')))
    )
      break;
  }
  const xs = rows().slice(startIndex),
    frameIndex = xs.findIndex((r) => r.kind === 'frame' && /1▸/.test(r.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')));
  assert.ok(frameIndex >= 0, JSON.stringify({ rows: xs.slice(-8), stderr: p.stderr() }));
  const sample = xs
    .slice(frameIndex + 1)
    .find((r) => r.kind === 'sample' && r.commits.length && r.commitToPaintUpperMs !== null);
  assert.ok(sample, 'the actual B10B-s1 frame must precede a known committed visible paint sample');
  assert.ok(sample.commitToPaintUpperMs >= sample.commitToPaintLowerMs);
  assert.ok(sample.paintMs >= 0);
  console.log(
    JSON.stringify({
      probe: 'actual-production-bar-commit-to-content',
      lowerMs: sample.commitToPaintLowerMs,
      upperMs: sample.commitToPaintUpperMs,
      paintMs: sample.paintMs,
      operationMs: sample.operationMs,
    })
  );
});
