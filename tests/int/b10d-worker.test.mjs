import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { sourceFixture, runtimeRow } from './b10d-fixture.mjs';
import { workerHarness, waitUntil } from './b10d-harness.mjs';
import { openObservationStore } from '../../dist/core/observation-store.js';
import { DelegationWorkerClient } from '../../dist/core/link/worker-client.js';
import { insert } from './b9-fixture.mjs';
const bootstrap = new URL('./b10d-test-bootstrap.mjs', import.meta.url).href;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function arranged(t, count = 3, options = {}) {
  const f = await sourceFixture(count, Math.max(8, count));
  const h = workerHarness(f, options);
  t.after(async () => {
    const closed = await h.close();
    assert.equal(closed.dirty, false);
    f.cleanup();
  });
  return { f, h };
}
test('B10D real worker owns publication and transfers committed original stamps; unchanged cadence and clock paints grant no extra reads', async (t) => {
  const { f, h } = await arranged(t);
  await h.warm();
  const store = await openObservationStore({ hudHome: f.home, sourceId: f.parent.sourceId, readOnly: true });
  t.after(() => store.close());
  const before = store.readProjection(f.parent);
  for (let i = 0; i < 40; i++) {
    const sample = await h.step();
    assert.equal(sample.publication, false);
    assert.equal(sample.bytesRead, 0);
  }
  const completed = h.client.diagnostics().completed;
  for (let i = 0; i < 30; i++) h.paint();
  assert.equal(h.client.diagnostics().completed, completed);
  assert.equal(store.readProjection(f.parent).commitSeq, before.commitSeq);
  appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  for (let i = 0; i < 20 && store.readProjection(f.parent).commitSeq === before.commitSeq; i++) await h.step();
  const stamp = h.client
    .current()
    .tree.nodes.find((n) => n.identity.kind === 'session' && n.identity.ref.sessionId === f.parent.sessionId)
    .observation.statusProjection.observationStamp;
  assert.deepEqual(stamp, store.readProjection(f.parent).observationStamp);
  assert.ok(
    h.client.diagnostics().lastSample.commitToPaintUpperMs >= h.client.diagnostics().lastSample.commitToPaintLowerMs
  );
  assert.equal(h.client.diagnostics().workers, 1);
});
test('B10D bounded accepted-reader eviction stays at16, does not dirty no-change state and recaptures a dormant ledger-only change', async (t) => {
  const { f, h } = await arranged(t, 20);
  await h.warm(20);
  const first = h.client.diagnostics().resources;
  assert.equal(first.readers, 16);
  assert.ok(first.evictions >= 4);
  for (let i = 0; i < 20; i++) assert.equal((await h.step()).bytesRead, 0);
  const store = await openObservationStore({ hudHome: f.home, sourceId: f.parent.sourceId, readOnly: true });
  t.after(() => store.close());
  const ref = f.targets[0],
    before = store.readProjection(ref);
  f.db.prepare("UPDATE runs SET state='uncertain' WHERE run_id='run-n1'").run();
  insert(f.db, 'events', {
    run_id: 'run-n1',
    link_id: 'link-n1',
    kind: 'run.state',
    payload: JSON.stringify({ state: 'uncertain', cause: 'scope_unknown' }),
    at: Date.now(),
  });
  for (let i = 0; i < 60 && store.readProjection(ref).commitSeq === before.commitSeq; i++) await h.step();
  const after = store.readProjection(ref);
  assert.ok(after.commitSeq > before.commitSeq);
  assert.match(after.continuity.stateKey, /^uncertain:/);
  assert.ok(h.client.diagnostics().resources.readers <= 16);
});
test('B10D fixed-EOF partial tails pin16 slots; reader17 is deferred explicitly until a real LF completes an accepted boundary', async (t) => {
  const f = await sourceFixture(18, 18);
  const tail = runtimeRow(
    'event_msg',
    { type: 'token_count', info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } } },
    1
  )
    .trimEnd()
    .slice(0, -1);
  for (const ref of f.targets) appendFileSync(f.file(ref.sessionId), tail);
  const h = workerHarness(f);
  t.after(async () => {
    await h.close();
    f.cleanup();
  });
  for (let i = 0; i < 1000; i++) {
    await h.step();
    if (h.client.diagnostics().resources?.blocked === 'reader_slots_pinned') break;
  }
  const resources = h.client.diagnostics().resources;
  assert.equal(resources.readers, 16);
  assert.equal(resources.pinnedReaders, 16);
  assert.equal(resources.blocked, 'reader_slots_pinned');
  assert.equal(h.client.current().tree.coverage.state, 'partial');
  appendFileSync(f.file(f.targets[0].sessionId), '}\n');
  for (let i = 0; i < 100; i++) {
    await h.step();
    if (h.client.diagnostics().resources.evictions > 0 && h.client.diagnostics().resources.blocked === null) break;
  }
  assert.ok(h.client.diagnostics().resources.evictions > 0);
  assert.ok(h.client.diagnostics().resources.readers <= 16);
});
test('B10D busy request coalescing keeps one pending opportunity and no new legacy grant; ACK activates it without a legacy slice', async (t) => {
  const control = new SharedArrayBuffer(64),
    flags = new Int32Array(control);
  const { f, h } = await arranged(t, 3, { testModule: bootstrap, testData: { control }, autoAck: false });
  const first = h.client.beginCollection(f.parent.sessionId);
  if (first) h.client.submitLegacy(first, { bytesRead: 0, recordsRead: 0, elapsedMs: 0 });
  await waitUntil(() => h.client.diagnostics().unconsumed === 1);
  const paints = h.paints;
  assert.equal(h.client.beginCollection(f.parent.sessionId), null);
  await sleep(30);
  assert.equal(h.client.beginCollection(f.parent.sessionId), null);
  assert.deepEqual(
    [h.client.diagnostics().active, h.client.diagnostics().pending, h.client.diagnostics().unconsumed],
    [1, 1, 1]
  );
  h.client.painted(h.data.delegation);
  await waitUntil(() => h.client.diagnostics().unconsumed === 1 && h.paints > paints);
  const result = h.client.incoming;
  assert.equal(result.trace.root.bytesRead, 0);
  assert.equal(result.trace.root.elapsedMs, 0);
  assert.ok(result.trace.activatedAt - result.trace.enqueuedAt >= 25);
  h.client.painted(h.data.delegation);
  assert.equal(h.client.diagnostics().pending, 0);
  assert.equal(Atomics.load(flags, 5), 1);
});
test('B10D delayed old-scope result is rejected after immediate invalidation and cannot paint under the new root', async (t) => {
  const control = new SharedArrayBuffer(64),
    flags = new Int32Array(control);
  const { f, h } = await arranged(t, 3, { testModule: bootstrap, testData: { control } });
  await h.warm();
  Atomics.store(flags, 0, 3);
  Atomics.store(flags, 2, 0);
  appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  const old = h.step();
  await waitUntil(() => Atomics.load(flags, 1) === 3);
  h.client.invalidateScope(f.targets[0].sessionId);
  assert.equal(h.client.current(), null);
  assert.equal(h.client.beginCollection(f.targets[0].sessionId), null);
  Atomics.store(flags, 2, 1);
  Atomics.notify(flags, 2);
  await old;
  await waitUntil(() => h.client.diagnostics().active === 0);
  assert.ok(h.client.samples().some((s) => s.outcome === 'rejected'));
  assert.equal(h.client.requestedScope(), f.targets[0].sessionId);
});
test('B10D explicit worker failure allows one confirmed-exit replacement on a later cadence and no respawn loop', async (t) => {
  const control = new SharedArrayBuffer(64),
    flags = new Int32Array(control);
  const { f, h } = await arranged(t, 3, { testModule: bootstrap, testData: { control } });
  await h.warm();
  h.client.worker.postMessage({ type: 'test_exit' });
  await waitUntil(() => h.client.diagnostics().workers === 0);
  assert.equal(h.client.diagnostics().replacements, 0);
  await h.step();
  await waitUntil(() => h.client.diagnostics().workers === 1);
  assert.equal(h.client.diagnostics().replacements, 1);
  h.client.worker.postMessage({ type: 'test_exit' });
  await waitUntil(() => h.client.diagnostics().workers === 0);
  h.client.beginCollection(f.parent.sessionId);
  await sleep(100);
  assert.equal(h.client.diagnostics().workers, 0);
  assert.equal(Atomics.load(flags, 5), 2);
});

test('B10D failed startup consumes the one later replacement and cannot form a respawn loop', async (t) => {
  const f = await sourceFixture(),
    control = new SharedArrayBuffer(64),
    flags = new Int32Array(control);
  Atomics.store(flags, 0, 9);
  const h = workerHarness(f, { testModule: bootstrap, testData: { control } });
  t.after(async () => {
    await h.close();
    f.cleanup();
  });
  await waitUntil(() => h.client.diagnostics().workers === 0);
  assert.equal(Atomics.load(flags, 5), 1);
  h.client.beginCollection(f.parent.sessionId);
  await waitUntil(() => h.client.diagnostics().workers === 0 && Atomics.load(flags, 5) === 2);
  for (let i = 0; i < 10; i++) h.client.beginCollection(f.parent.sessionId);
  await sleep(50);
  assert.equal(h.client.diagnostics().workers, 0);
  assert.equal(h.client.diagnostics().replacements, 1);
  assert.equal(Atomics.load(flags, 5), 2);
});

test('B10D one-use legacy grants share 8 MiB and a spent read deadline cannot be reset by worker activation', async (t) => {
  const { f, h } = await arranged(t);
  await h.warm();
  const grant = h.client.beginCollection(f.parent.sessionId);
  assert.ok(grant);
  assert.equal(grant.budget.maxBytes, 4 * 1024 * 1024);
  assert.equal(grant.budget.budgetMs, 20);
  await sleep(45);
  const result = new Promise((resolve) => {
    const prior = h.client.options.onSample;
    h.client.options.onSample = (s) => {
      prior?.(s);
      resolve(s);
    };
  });
  assert.equal(h.client.submitLegacy(grant, { bytesRead: 4 * 1024 * 1024, recordsRead: 2000, elapsedMs: 45 }), true);
  assert.equal(h.client.submitLegacy(grant, { bytesRead: 0, recordsRead: 0, elapsedMs: 0 }), false);
  assert.equal(h.client.active.deadlineAt, grant.deadlineAt);
  assert.equal(h.client.active.budget.budgetMs, 0);
  assert.equal(h.client.active.budget.maxBytes, 4 * 1024 * 1024);
  const sample = await result;
  assert.ok(sample.bytesRead <= 8 * 1024 * 1024);
  assert.ok(sample.operationMs >= 45);
  const obsolete = h.client.beginCollection(f.parent.sessionId);
  assert.ok(obsolete);
  h.client.invalidateScope(f.targets[0].sessionId);
  assert.equal(h.client.submitLegacy(obsolete, { bytesRead: 0, recordsRead: 0, elapsedMs: 0 }), false);
});

test('B10D no-ledger startup resolves the default under a temporary HOME, creates no directory and starts no worker', async () => {
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path'),
    { spawnSync } = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'hud-b10d-home-'));
  try {
    const code =
      "import {DelegationWorkerClient} from './dist/core/link/worker-client.js'; if(DelegationWorkerClient.open({})!==null)process.exit(99); if(DelegationWorkerClient.open({HUD_HOME:process.env.HOME+'/missing'})!==null)process.exit(98);";
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, HUD_HOME: '' },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(home, '.hud')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('B10D dormant recovery survives a spent slice and consumes a maximum legal record on the next fair grant', async (t) => {
  const control = new SharedArrayBuffer(64),
    flags = new Int32Array(control);
  const { f, h } = await arranged(t, 20, { testModule: bootstrap, testData: { control } });
  await h.warm(20);
  const store = await openObservationStore({ hudHome: f.home, sourceId: f.parent.sourceId, readOnly: true });
  t.after(() => store.close());
  const target = f.targets[0],
    before = store.readProjection(target),
    line = runtimeRow('event_msg', { type: 'task_started', padding: '' }, 3);
  const large = line.replace(
    '"padding":""',
    '"padding":"' + 'x'.repeat(1024 * 1024 + 1 - Buffer.byteLength(line)) + '"'
  );
  assert.equal(Buffer.byteLength(large), 1024 * 1024 + 1);
  appendFileSync(f.file(target.sessionId), large);
  Atomics.store(flags, 0, 10);
  Atomics.store(flags, 2, 0);
  const baseline = Atomics.load(flags, 10);
  const pending = h.step();
  await waitUntil(() => Atomics.load(flags, 1) === 10);
  await sleep(45);
  Atomics.store(flags, 2, 1);
  Atomics.notify(flags, 2);
  const first = await pending;
  assert.ok(first.operationMs >= 45);
  assert.ok(h.client.diagnostics().resources.readers <= 16);
  for (let i = 0; i < 120 && store.readProjection(target).commitSeq === before.commitSeq; i++)
    assert.ok((await h.step()).bytesRead <= 8 * 1024 * 1024);
  const after = store.readProjection(target);
  assert.ok(after.commitSeq > before.commitSeq);
  assert.equal(after.checkpointIdentity.offset, before.checkpointIdentity.offset + Buffer.byteLength(large));
  assert.equal(
    Atomics.load(flags, 10) - baseline,
    1,
    'spent read-work slice must retain the exact recovery boundary rather than reconstruct it again'
  );
  assert.ok(h.client.diagnostics().resources.readers <= 16);
});

test('B10D a cached predecessor paint cannot ACK a newer adopted result before that revision is actually rendered', async (t) => {
  const { f, h } = await arranged(t, 3, { autoAck: false });
  // Manually consume warmup frames; retain only the old committed content reference.
  for (let i = 0; i < 40; i++) {
    h.client.beginCollection(f.parent.sessionId);
    if (h.client.rootGrant)
      h.client.submitLegacy(h.client.rootGrant.grant, { bytesRead: 0, recordsRead: 0, elapsedMs: 0 });
    await waitUntil(() => h.client.diagnostics().unconsumed === 1);
    h.client.painted(h.data.delegation);
    if (h.client.current()?.tree.nodes.length === 3 && h.client.current().tree.nodes.every((n) => n.loaded)) break;
  }
  const old = h.client.current();
  appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  for (let i = 0; i < 20; i++) {
    const grant = h.client.beginCollection(f.parent.sessionId);
    if (grant) h.client.submitLegacy(grant, { bytesRead: 0, recordsRead: 0, elapsedMs: 0 });
    await waitUntil(() => h.client.diagnostics().unconsumed === 1);
    if (h.client.current() !== old) break;
    h.client.painted(h.data.delegation);
  }
  assert.equal(h.client.diagnostics().unconsumed, 1);
  h.client.painted(old);
  assert.equal(h.client.diagnostics().unconsumed, 1);
  h.client.painted(h.data.delegation);
  assert.equal(h.client.diagnostics().unconsumed, 0);
});

test('B10D thirty repeated owner opens/closes leave no worker, native directory handle or growing descriptor set', async (t) => {
  const { readdirSync } = await import('node:fs');
  const f = await sourceFixture();
  t.after(() => f.cleanup());
  const count = () => readdirSync('/proc/self/fd').length,
    before = count();
  for (let i = 0; i < 30; i++) {
    const h = workerHarness(f);
    await h.step();
    const closed = await h.close();
    assert.equal(closed.dirty, false);
    assert.equal(h.client.diagnostics().workers, 0);
    assert.equal(h.client.beginCollection(f.parent.sessionId), null);
  }
  await sleep(30);
  assert.ok(count() <= before + 2, JSON.stringify({ before, after: count() }));
});
