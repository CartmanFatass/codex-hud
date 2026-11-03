import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { sourceFixture, runtimeRow } from './b10d-fixture.mjs';
import { workerHarness, waitUntil } from './b10d-harness.mjs';
const bootstrap = new URL('./b10d-test-bootstrap.mjs', import.meta.url).href;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (const [name, code, delay] of [
  ['acquisition', 1, 3600],
  ['renewal', 2, 5500],
  ['publication', 3, 6500],
])
  test(`B10D blocked ${name} leaves keyboard/resize/clock paints responsive and records a failed observation-operation gate`, async (t) => {
    const f = await sourceFixture();
    const control = new SharedArrayBuffer(64),
      flags = new Int32Array(control);
    const now = Date.now();
    f.db.prepare('UPDATE runs SET heartbeat_at=?,heartbeat_seq=1,heartbeat_mono_ms=?').run(now, now);
    appendFileSync(f.file(f.targets[0].sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
    const h = workerHarness(f, { entry: 'panel', testModule: bootstrap, testData: { control } });
    t.after(async () => {
      Atomics.store(flags, 2, 1);
      Atomics.notify(flags, 2);
      await h.close();
      f.cleanup();
    });
    if (code !== 1) await h.warm();
    if (code === 2) await sleep(5500); // actual wall time, no lease-clock substitution
    Atomics.store(flags, 0, code);
    Atomics.store(flags, 2, 0);
    if (code !== 1)
      appendFileSync(f.file(f.targets[0].sessionId), runtimeRow('event_msg', { type: 'task_started' }, 2));
    let pending;
    for (let i = 0; i < 60; i++) {
      let settled = false;
      pending = h.step().then((sample) => {
        settled = true;
        return sample;
      });
      await waitUntil(() => settled || Atomics.load(flags, 1) === code);
      if (Atomics.load(flags, 1) === code) break;
      await pending;
    }
    assert.equal(Atomics.load(flags, 1), code);
    const latencies = [];
    let due = performance.now() + 16;
    const timer = setInterval(() => {
      const at = performance.now();
      h.paint();
      latencies.push(performance.now() - due);
      due = at + 16;
    }, 16);
    const before = h.paints;
    assert.equal(h.key('help').help, true);
    assert.equal(h.key('escape').help, false);
    assert.equal(h.resize(72, 35).lines.length, 35);
    await sleep(delay);
    clearInterval(timer);
    assert.ok(h.paints > before + 20);
    assert.ok(Math.max(...latencies) < 200, JSON.stringify({ latencies }));
    if (code === 3) {
      const node = h.client
        .current()
        .tree.nodes.find((n) => n.identity.kind === 'session' && n.identity.ref.sessionId === f.targets[0].sessionId);
      assert.equal(h.client.current().details[node.key].status.freshness.state, 'stale');
    }
    Atomics.store(flags, 2, 1);
    Atomics.notify(flags, 2);
    const sample = await pending;
    assert.ok(sample.operationMs >= delay);
    assert.ok(sample.paintMs < 200);
    assert.equal(h.client.diagnostics().performanceFailure, 'observation_worker_performance_unqualified');
    if (code === 2)
      assert.equal(
        Atomics.load(flags, 9),
        0,
        'successful slow renewal must not be renewed again immediately for that session'
      );
    console.log(
      JSON.stringify({
        injected: name,
        operationMs: sample.operationMs,
        resultPaintMs: sample.paintMs,
        independentPaintMaxMs: Math.max(...latencies),
        qualification: 'operation gate failed as expected',
      })
    );
  });
test('B10D real SQLite busy publication retains the complete old commit and retries without overwriting its unacknowledged candidate', async (t) => {
  const f = await sourceFixture(),
    h = workerHarness(f);
  await h.warm();
  const db = new DatabaseSync(join(f.home, 'sources', f.parent.sourceId, 'observation.sqlite'));
  t.after(async () => {
    db.close();
    await h.close();
    f.cleanup();
  });
  const before = Number(
    db
      .prepare('SELECT commit_seq FROM observation_current WHERE ref=?')
      .get(JSON.stringify([f.parent.harness, f.parent.sourceId, f.parent.sessionId, f.parent.threadId])).commit_seq
  );
  db.exec('BEGIN IMMEDIATE');
  appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_failed' }, 2));
  try {
    for (let i = 0; i < 5; i++) {
      await h.step();
      h.paint();
    }
    assert.equal(h.client.diagnostics().error, 'observation_busy');
  } finally {
    db.exec('ROLLBACK');
  }
  for (let i = 0; i < 20; i++) await h.step();
  const row = db
    .prepare('SELECT commit_seq,projection_body FROM observation_current WHERE ref=?')
    .get(JSON.stringify([f.parent.harness, f.parent.sourceId, f.parent.sessionId, f.parent.threadId]));
  assert.equal(Number(row.commit_seq), before + 1);
  assert.equal(JSON.parse(row.projection_body).notices.filter((n) => n.kind === 'failed').length, 1);
});
test('B10D owner close returns within the2-second allowance during a synchronous worker stall and never starts a replacement', async (t) => {
  const f = await sourceFixture(),
    control = new SharedArrayBuffer(64),
    flags = new Int32Array(control);
  const h = workerHarness(f, { testModule: bootstrap, testData: { control } });
  t.after(async () => {
    Atomics.store(flags, 2, 1);
    Atomics.notify(flags, 2);
    await h.close();
    f.cleanup();
  });
  await h.warm();
  Atomics.store(flags, 0, 3);
  appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  const pending = h.step().catch(() => {});
  await waitUntil(() => Atomics.load(flags, 1) === 3);
  const started = performance.now(),
    closed = await h.client.close();
  assert.equal(closed.dirty, true);
  assert.ok(performance.now() - started < 2300);
  assert.equal(h.client.beginCollection(f.parent.sessionId), null);
  await waitUntil(() => h.client.diagnostics().workers === 0, 5000);
  assert.equal(h.client.diagnostics().replacements, 0);
  // Settle only the test waiter's timer; the production close did not await this native operation.
  await h.close();
  await pending;
});
