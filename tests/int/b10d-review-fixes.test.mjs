import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { sourceFixture, runtimeRow } from './b10d-fixture.mjs';
import { workerHarness, waitUntil } from './b10d-harness.mjs';
import { HudDelegationCollector } from '../../dist/collectors/delegation.js';
import { openObservationStore } from '../../dist/core/observation-store.js';
import { insert } from './b9-fixture.mjs';
const bootstrap = new URL('./b10d-test-bootstrap.mjs', import.meta.url).href;
async function direct(t, count = 20) {
  const f = await sourceFixture(count, count);
  const c = await HudDelegationCollector.open({ HUD_HOME: f.home }, f.sourceRoot, {
    publish: true,
    boundedWorker: true,
  });
  const store = await openObservationStore({ hudHome: f.home, sourceId: f.parent.sourceId, readOnly: true });
  t.after(() => {
    store.close();
    c.close();
    f.cleanup();
  });
  const cycle = async () => {
    await c.tick(f.parent.sessionId);
    await c.afterPaint(() => {});
    return c.collector.current();
  };
  for (let i = 0; i < 1000; i++) {
    const v = await cycle();
    if (v.tree.nodes.length === count && Object.values(v.details).every((d) => d.statusSource === 'committed')) break;
    if (i === 999) assert.fail('warm did not converge');
  }
  return { f, c, store, cycle };
}
test('B10D final ledger update survives observe-before-eviction without any rescue event', async (t) => {
  const { f, c, store, cycle } = await direct(t);
  const port = c.port;
  const victim = [...port.readings.values()].find((r) => r.ref.sessionId !== f.parent.sessionId && port.quiescent(r));
  const dormant = [...port.readings.values()].find((r) => r.evicted);
  assert.ok(victim && dormant);
  const before = store.readProjection(victim.ref);
  for (const r of port.readings.values()) r.grantedAt = 1e12;
  victim.grantedAt = -1e12;
  const run = c.collector
    .current()
    .tree.nodes.find(
      (n) => n.identity.kind === 'session' && n.identity.ref.sessionId === victim.ref.sessionId
    ).currentRun;
  f.db.prepare("UPDATE runs SET state='uncertain' WHERE run_id=?").run(run.runId);
  insert(f.db, 'events', {
    run_id: run.runId,
    link_id: run.linkId,
    kind: 'run.state',
    payload: JSON.stringify({ state: 'uncertain', cause: 'scope_unknown' }),
    at: Date.now(),
  });
  appendFileSync(f.file(dormant.ref.sessionId), runtimeRow('event_msg', { type: 'task_complete' }, 1));
  // Capture the exact ordering in production admit: observeLedger has run, but no publication yet.
  let seen = false;
  const admit = port.admit.bind(port);
  port.admit = (r) => {
    const answer = admit(r);
    if (victim.evicted && victim.owedLedger) seen = true;
    return answer;
  };
  for (let i = 0; i < 100 && !seen; i++) await cycle();
  assert.equal(seen, true, 'updated accepted reader must actually be evicted with explicit debt');
  const age = victim.owedSince;
  port.observeLedger(port.observedDemand);
  port.observeLedger(port.observedDemand);
  if (victim.owedLedger) assert.equal(victim.owedSince, age);
  for (let i = 0; i < 200 && store.readProjection(victim.ref).commitSeq === before.commitSeq; i++) await cycle();
  const after = store.readProjection(victim.ref);
  assert.ok(after.commitSeq > before.commitSeq);
  assert.match(after.continuity.stateKey, /^uncertain:/);
  assert.equal(victim.owedLedger, false);
  assert.ok(c.resources().readers <= 16);
});
test('B10D continuously changing relevance makes real accepted progress beyond16 without relaxing the reader limit', async (t) => {
  const { f, c, store, cycle } = await direct(t, 24);
  const baseline = new Map(f.targets.map((r) => [r.sessionId, store.readProjection(r).commitSeq]));
  const advanced = new Set();
  let captures = 0;
  for (let i = 0; i < 600 && advanced.size < 20; i++) {
    const now = Date.now();
    f.db.prepare('UPDATE runs SET heartbeat_at=?,heartbeat_seq=?,heartbeat_mono_ms=?').run(now + i, i + 1, now + i);
    await cycle();
    if (c.collector.stats().readGrant) captures++;
    for (const r of f.targets)
      if (store.readProjection(r).commitSeq > baseline.get(r.sessionId)) advanced.add(r.sessionId);
    assert.ok(c.resources().readers <= 16);
  }
  assert.ok(captures > 16);
  assert.ok(advanced.size >= 20, JSON.stringify({ advanced: [...advanced], resources: c.resources() }));
});
test('B10D affirmative structural retirement releases accepted partial tails; unknown does not, and reentry recovers', async (t) => {
  const { f, c, store, cycle } = await direct(t, 4);
  const ref = f.targets[0],
    port = c.port;
  appendFileSync(f.file(ref.sessionId), '{"type":"synthetic-partial"');
  for (let i = 0; i < 20; i++) await cycle();
  const [key, reading] = [...port.readings].find(([, r]) => r.ref.sessionId === ref.sessionId);
  assert.equal(port.quiescent(reading), false);
  assert.equal(reading.caughtUp, true);
  const before = store.readProjection(ref),
    view = c.collector.current();
  const currentRuns = new Map(view.tree.nodes.map((n) => [n.key, n.currentRun]));
  const present = new Set([...port.readings.keys()].filter((k) => k !== key));
  assert.deepEqual(port.reconcileMembership({ present, complete: false, currentRuns }, view), []);
  assert.equal(port.readings.get(key), reading);
  assert.deepEqual(port.reconcileMembership({ present, complete: true, currentRuns }, view), [key]);
  assert.equal(port.readings.has(key), false);
  assert.equal(store.readProjection(ref).commitSeq, before.commitSeq);
  assert.equal(port.minimumBytes.has(key), false);
  assert.equal(port.pendingCommits.has(key), false);
  // Existing authoritative tree still includes it: next ordinary operation rediscovers/recoveries.
  for (let i = 0; i < 40 && !port.readings.get(key)?.checkpoint; i++) await cycle();
  assert.notEqual(port.readings.get(key), reading);
  assert.ok(port.readings.get(key)?.checkpoint);
});
test('B10D observed working continuity without a restorable anchor is pinned across ledger-only changes', async (t) => {
  const actual = Date.now;
  let now = actual();
  Date.now = () => now;
  t.after(() => {
    Date.now = actual;
  });
  const { f, c, store, cycle } = await direct(t, 4),
    ref = f.targets[0];
  f.db
    .prepare("UPDATE runs SET heartbeat_at=?,heartbeat_seq=1,heartbeat_mono_ms=? WHERE run_id='run-n1'")
    .run(now, now);
  appendFileSync(f.file(ref.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  for (let i = 0; i < 15; i++) await cycle();
  let rows =
    runtimeRow('event_msg', { type: 'exec_approval_request', call_id: 'synthetic-hidden', command: ['true'] }, 2) +
    runtimeRow('event_msg', { type: 'exec_command_begin', call_id: 'synthetic-hidden' }, 3);
  for (let i = 0; i < 65; i++)
    rows +=
      runtimeRow('event_msg', { type: 'token_count', rate_limits: { primary: { used_percent: 0 } } }, 4 + i * 2) +
      runtimeRow('event_msg', { type: 'token_count', rate_limits: { primary: { used_percent: 85 } } }, 5 + i * 2);
  appendFileSync(f.file(ref.sessionId), rows);
  for (let i = 0; i < 25; i++) await cycle();
  const before = store.readProjection(ref),
    reading = [...c.port.readings.values()].find((r) => r.ref.sessionId === ref.sessionId);
  assert.equal(before.continuity.stateSinceBasis, 'observed');
  assert.equal(reading.publisher.canEvictAcceptedReading(), false);
  now += 1000;
  f.db
    .prepare("UPDATE runs SET heartbeat_at=?,heartbeat_seq=heartbeat_seq+1,heartbeat_mono_ms=? WHERE run_id='run-n1'")
    .run(now, now);
  for (let i = 0; i < 25; i++) await cycle();
  assert.equal(store.readProjection(ref).continuity.stateSince, before.continuity.stateSince);
  assert.equal(reading.publisher.canEvictAcceptedReading(), false);
});
for (const code of [13, 14])
  test(`B10D rejected ${code === 13 ? 'commit-then-oversize' : 'invalid envelope'} retains last view, records no pseudo paint and recovers on an authorized full result`, async (t) => {
    const f = await sourceFixture(3, 3),
      control = new SharedArrayBuffer(64),
      flags = new Int32Array(control);
    const h = workerHarness(f, { testModule: bootstrap, testData: { control } });
    t.after(async () => {
      await h.close();
      f.cleanup();
    });
    await h.warm();
    const before = h.client.current(),
      completed = h.client.diagnostics().completed;
    Atomics.store(flags, 0, code);
    Atomics.store(flags, 2, 1);
    appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
    for (let i = 0; i < 30 && Atomics.load(flags, 1) !== code; i++) await h.step();
    await waitUntil(() => h.client.diagnostics().completed > completed);
    const sample = h.client.samples().find((s) => s.outcome === 'rejected');
    assert.ok(sample);
    assert.equal(sample.paintMs, null);
    assert.equal(sample.commitToPaintUpperMs, null);
    assert.equal(sample.renderMs, null);
    if (code === 13) {
      assert.ok(sample.commits.length);
      assert.equal(h.client.current(), before);
    }
    assert.equal(h.client.diagnostics().unconsumed, 0);
    for (let i = 0; i < 30 && h.client.current() === before; i++) await h.step();
    assert.notEqual(h.client.current(), before);
    assert.equal(h.client.diagnostics().unconsumed, 0);
  });
test('B10D superseded root and shutdown retain admitted charges exactly once, including pending and known commits', async (t) => {
  const f = await sourceFixture(3, 3),
    h = workerHarness(f, { autoAck: false });
  t.after(async () => {
    await h.close();
    f.cleanup();
  });
  await waitUntil(() => h.client.ready);
  const g = h.client.beginCollection(f.parent.sessionId);
  assert.ok(g);
  h.client.invalidateScope(f.targets[0].sessionId);
  assert.equal(h.client.beginCollection(f.targets[0].sessionId), null);
  assert.equal(h.client.submitLegacy(g, { bytesRead: 123, recordsRead: 2, elapsedMs: 7 }), false);
  assert.equal(h.client.samples().filter((s) => s.requestId === g.requestId).length, 1);
  assert.equal(h.client.samples().find((s) => s.requestId === g.requestId).bytesRead, 123);
  await waitUntil(() => h.client.diagnostics().unconsumed === 1);
  h.client.beginCollection(f.targets[0].sessionId);
  const known = h.client.incoming.trace.commits.map((c) => c.commitSeq);
  await h.close();
  const cancelled = h.client.samples().filter((s) => s.outcome === 'cancelled');
  assert.ok(cancelled.length >= 2);
  assert.ok(cancelled.every((s) => s.paintMs === null && s.commitToPaintUpperMs === null));
  assert.deepEqual(
    cancelled.flatMap((s) => s.commits.map((c) => c.commitSeq)),
    known
  );
  const count = h.client.samples().length;
  assert.equal(h.client.submitLegacy(g, { bytesRead: 999, recordsRead: 1, elapsedMs: 9 }), false);
  assert.equal(h.client.samples().length, count);
});

test('B10D nested malformed DTOs reject before adoption while declared public descriptors survive', async (t) => {
  const { encodeView, decodeView } = await import('../../dist/core/link/worker-codec.js');
  const f = await sourceFixture(3, 3),
    h = workerHarness(f);
  t.after(async () => {
    await h.close();
    f.cleanup();
  });
  await h.warm();
  const input = h.client.current(),
    key = input.tree.nodes[0].key;
  assert.deepEqual(decodeView(encodeView(input)), input);
  const bad = [
    (v) => {
      v.details[key] = null;
    },
    (v) => {
      delete v.details[key].status.freshness;
    },
    (v) => {
      v.details[key].status = structuredClone(v.details[key].status);
      v.details[key].status.observationStamp.commitSeq++;
    },
    (v) => {
      v.tree.nodes[0].execution.lease = { holder: 'synthetic', generation: 1 };
    },
    (v) => {
      v.tree.nodes[0].observation.spent.costUsd.prepared = { token: 'synthetic' };
    },
    (v) => {
      v.details[key].status = structuredClone(v.details[key].status);
      v.details[key].status.observationStamp.inputLedgerSeq =
        (v.details[key].status.observationStamp.inputLedgerSeq ?? 0) + 1;
    },
    (v) => {
      v.details[key].status = structuredClone(v.details[key].status);
      v.details[key].status.observationStamp = null;
      v.tree.nodes[0].observation = null;
    },
  ];
  for (const mutate of bad) {
    const v = structuredClone(input);
    mutate(v);
    assert.throws(() => encodeView(v), /worker_dto_schema/);
  }
  const unavailable = structuredClone(input);
  unavailable.tree.nodes[0].observation = null;
  unavailable.tree.nodes[0].loaded = false;
  unavailable.details[key].status = null;
  unavailable.details[key].statusSource = 'unavailable';
  assert.deepEqual(decodeView(encodeView(unavailable)), unavailable);
  const { validWorkerEnvelope } = await import('../../dist/core/link/worker-envelope.js');
  let header = null;
  const message = h.client.message.bind(h.client);
  h.client.message = (v) => {
    if (v?.type === 'result' && !header) header = structuredClone(v);
    return message(v);
  };
  await h.step();
  assert.ok(validWorkerEnvelope(header));
  for (const mutate of [
    (v) => {
      v.trace.root.failed = 'true';
    },
    (v) => {
      delete v.trace.stages.leaseMs;
    },
    (v) => {
      v.publication.lease = { holder: 'synthetic' };
    },
    (v) => {
      v.trace.stages = new Date();
    },
  ]) {
    const invalid = structuredClone(header);
    mutate(invalid);
    assert.equal(validWorkerEnvelope(invalid), false);
  }
  // Real reconciliation is a public copy-only descriptor, not a transferred capability.
  f.db.prepare("UPDATE runs SET state='uncertain' WHERE run_id='run-n1'").run();
  insert(f.db, 'events', {
    run_id: 'run-n1',
    link_id: 'link-n1',
    kind: 'run.state',
    payload: JSON.stringify({ state: 'uncertain', cause: 'scope_unknown' }),
    at: Date.now(),
  });
  for (let i = 0; i < 30; i++) {
    await h.step();
    if (Object.values(h.client.current().details).some((d) => d.reconcile)) break;
  }
  const actual = h.client.current();
  assert.ok(Object.values(actual.details).some((d) => d.reconcile?.operation === 'reconcile'));
  assert.deepEqual(decodeView(encodeView(actual)), actual);
});

test('B10D B10B-s1 bar frame consumes a visibly changed committed child status', async (t) => {
  const { renderHud } = await import('../../dist/render/header.js');
  const f = await sourceFixture(),
    h = workerHarness(f);
  t.after(async () => {
    await h.close();
    f.cleanup();
  });
  const now = Date.now();
  f.db.prepare('UPDATE runs SET heartbeat_at=?,heartbeat_seq=1,heartbeat_mono_ms=?').run(now, now);
  await h.warm();
  const render = () => {
    h.data.delegation = h.client.current();
    return renderHud(h.data, { width: 160, height: 1, layout: { mode: 'compact', showDuration: true } });
  };
  const node = () =>
    h.client
      .current()
      .tree.nodes.find((n) => n.identity.kind === 'session' && n.identity.ref.sessionId === f.targets[0].sessionId);
  const before = render(),
    seq = node().observation.statusProjection.observationStamp.commitSeq;
  appendFileSync(f.file(f.targets[0].sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  for (let i = 0; i < 30 && node().observation.statusProjection.observationStamp.commitSeq === seq; i++) await h.step();
  assert.ok(node().observation.statusProjection.observationStamp.commitSeq > seq);
  assert.notDeepEqual(render(), before);
});

for (const code of [15, 16])
  test(`B10D oversized failure header uses bounded fatal and retains known commit once${code === 16 ? ' while cleanup blocks' : ''}`, async (t) => {
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
    const before = h.client.current(),
      revision = h.client.revision;
    Atomics.store(flags, 0, code);
    Atomics.store(flags, 2, 0);
    appendFileSync(f.file(f.parent.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
    let result;
    for (let i = 0; i < 30 && !result; i++) {
      const s = await h.step();
      if (s.error === 'worker_metadata_limit') result = s;
    }
    assert.ok(result);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.commits.length, 1);
    assert.equal(result.paintMs, null);
    assert.equal(result.commitToPaintUpperMs, null);
    assert.equal(result.workerStatsUnknown, true);
    assert.ok(Atomics.load(flags, 12) < 16384);
    assert.equal(h.client.current(), before);
    assert.equal(h.client.revision, revision);
    assert.equal(h.client.samples().filter((s) => s.requestId === result.requestId).length, 1);
    if (code === 16) {
      await waitUntil(() => Atomics.load(flags, 1) === 17);
      for (let i = 0; i < 5; i++) h.client.beginCollection(f.parent.sessionId);
      assert.equal(h.client.diagnostics().workers, 1);
      assert.equal(h.client.diagnostics().replacements, 0);
    }
    await waitUntil(() => h.client.diagnostics().workers === 0, 5000);
    assert.equal(h.client.samples().filter((s) => s.requestId === result.requestId).length, 1);
    assert.equal(h.client.diagnostics().replacements, 0);
    await h.step();
    assert.equal(h.client.diagnostics().replacements, 1);
  });
test('B10D close at an admitted root grant charges its full unknown slice once and rejects the late callback', async (t) => {
  const f = await sourceFixture(),
    h = workerHarness(f);
  t.after(async () => {
    await h.close();
    f.cleanup();
  });
  await waitUntil(() => h.client.ready);
  const grant = h.client.beginCollection(f.parent.sessionId);
  assert.ok(grant);
  await h.close();
  const sample = h.client.samples().find((s) => s.requestId === grant.requestId);
  assert.equal(sample.outcome, 'cancelled');
  assert.equal(sample.bytesRead, 4 * 1024 * 1024);
  assert.equal(sample.paintMs, null);
  assert.equal(h.client.submitLegacy(grant, { bytesRead: 12, recordsRead: 1, elapsedMs: 2 }), false);
  assert.equal(h.client.samples().filter((s) => s.requestId === grant.requestId).length, 1);
});

async function capturedChild(c, f, cycle) {
  const ref = f.targets[0];
  appendFileSync(f.file(ref.sessionId), runtimeRow('event_msg', { type: 'task_failed' }, 1));
  for (let i = 0; i < 40; i++) {
    await c.tick(f.parent.sessionId);
    const row = [...c.port.readings.entries()].find(([, r]) => r.ref.sessionId === ref.sessionId);
    if (row[1].publisher?.hasPending()) {
      c.abandonCollection();
      return row;
    }
    await c.afterPaint(() => {});
  }
  assert.fail('expected an actual captured unaccepted child');
}
test('B10D retiring captured candidate remains pinned during busy, uses one ordinary publication opportunity and preserves its notice', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const { f, c, store, cycle } = await direct(t, 4),
    [key, reading] = await capturedChild(c, f, cycle),
    port = c.port;
  const full = c.collector.current(),
    view = {
      ...full,
      tree: { ...full.tree, nodes: full.tree.nodes.filter((n) => n.key !== key) },
      details: Object.fromEntries(Object.entries(full.details).filter(([k]) => k !== key)),
    };
  const cert = {
    present: new Set(view.tree.nodes.map((n) => n.key)),
    complete: true,
    currentRuns: new Map(full.tree.nodes.map((n) => [n.key, n.currentRun])),
  };
  const before = store.readProjection(reading.ref),
    publisher = reading.publisher;
  assert.deepEqual(port.reconcileMembership(cert, view), []);
  assert.equal(reading.retiring, true);
  port.setPublicationView(view);
  const lock = new DatabaseSync(store.databasePath);
  t.after(() => lock.close());
  lock.exec('BEGIN IMMEDIATE');
  try {
    const result = port.publishOne(Date.now());
    assert.equal(result.attempted, true);
    assert.equal(result.error, 'observation_busy');
    assert.equal(publisher.hasPending(), true);
    assert.equal(port.quiescent(reading), false);
    assert.equal(store.readProjection(reading.ref).commitSeq, before.commitSeq);
  } finally {
    lock.exec('ROLLBACK');
  }
  // A later normal operation retries exactly the same candidate; no extra native read or fresh authority.
  port.begin(performance.now() + 40);
  port.setPublicationView(view);
  const accepted = port.publishOne(Date.now());
  assert.equal(accepted.attempted, true);
  assert.equal(accepted.changed, true);
  assert.equal(publisher.hasPending(), false);
  const after = store.readProjection(reading.ref);
  assert.equal(after.commitSeq, before.commitSeq + 1);
  assert.equal(after.notices.filter((n) => n.kind === 'failed').length, 1);
  assert.deepEqual(port.reconcileMembership(cert, view), [], 'result delivery still pins the retiring record');
  port.begin(performance.now() + 40);
  assert.deepEqual(port.reconcileMembership(cert, view), [key]);
  assert.equal(port.readings.has(key), false);
  assert.equal(publisher.hasReading(), false);
  assert.equal(store.readProjection(reading.ref).commitSeq, after.commitSeq);
});
test('B10D incompatible binding supersedes a retiring captured candidate without publishing or acknowledging its newer boundary', async (t) => {
  const { f, c, store, cycle } = await direct(t, 4),
    [key, reading] = await capturedChild(c, f, cycle),
    port = c.port;
  const before = store.readProjection(reading.ref),
    publisher = reading.publisher;
  const old = f.db.prepare("SELECT * FROM runs WHERE run_id='run-n1'").get();
  f.evidence('synthetic-retirement-terminal', 'scope_reconciled', {}, 'link-n1', 'run-n1');
  f.db
    .prepare(
      "UPDATE runs SET state='ended',ended_at=12000,terminal_evidence_id='synthetic-retirement-terminal',submission_fenced_at=12000 WHERE run_id='run-n1'"
    )
    .run();
  insert(f.db, 'runs', {
    ...old,
    run_id: 'run-n1-next',
    run_seq: 2,
    operation: 'resume',
    expected_generation: 2,
    state: 'running',
    launch_token_hash: '7'.repeat(64),
    launch_call_id: 'synthetic-next-call',
    launch_correlation_id: 'synthetic-next-correlation',
    launch_message_id: 'synthetic-next-message',
    created_at: 13000,
    started_at: 13001,
  });
  await c.tick(f.parent.sessionId);
  c.abandonCollection();
  const view = c.collector.current(),
    run = view.tree.nodes.find((n) => n.key === key).currentRun;
  assert.equal(run.expectedGeneration, 2);
  const cert = {
    present: new Set(view.tree.nodes.filter((n) => n.key !== key).map((n) => n.key)),
    complete: true,
    currentRuns: new Map(view.tree.nodes.map((n) => [n.key, n.currentRun])),
  };
  port.reconcileMembership(cert, view);
  assert.equal(publisher.hasReading(), false);
  assert.equal(store.readProjection(reading.ref).checkpointIdentity.offset, before.checkpointIdentity.offset);
  assert.equal(store.readProjection(reading.ref).commitSeq, before.commitSeq);
  assert.ok(port.takeLifecycleOutcomes().some((o) => o.reason === 'retirement_context_superseded'));
});

test('B10D an expired owner becoming a follower releases its old native slot and later reacquires only through exact recovery', async (t) => {
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  t.after(() => {
    Date.now = clock;
  });
  const { f, c, store, cycle } = await direct(t, 2),
    ref = f.targets[0];
  const reading = [...c.port.readings.values()].find((r) => r.ref.sessionId === ref.sessionId);
  assert.ok(reading.reader && reading.checkpoint && reading.publisher.hasReading());
  const partial = runtimeRow('event_msg', { type: 'task_complete' }, 1).trimEnd().slice(0, -1);
  appendFileSync(f.file(ref.sessionId), partial);
  for (let i = 0; i < 10; i++) await cycle();
  assert.equal(c.port.quiescent(reading), false);
  const before = store.readProjection(ref),
    other = await openObservationStore({ hudHome: f.home, sourceId: f.parent.sourceId });
  t.after(() => other.close());
  let oldReads = 0,
    targetPublishes = 0,
    targetRenewals = 0,
    recoveries = 0;
  const native = reading.reader,
    read = native.read.bind(native);
  native.read = (...args) => {
    oldReads++;
    return read(...args);
  };
  const own = reading.publisher.store,
    publish = own.publishPrepared.bind(own),
    renew = own.renew.bind(own),
    recover = own.readRecovery.bind(own);
  own.publishPrepared = (candidate, ...args) => {
    if (candidate.commit.ref.sessionId === ref.sessionId) targetPublishes++;
    return publish(candidate, ...args);
  };
  own.renew = (r, ...args) => {
    if (r.sessionId === ref.sessionId) targetRenewals++;
    return renew(r, ...args);
  };
  own.readRecovery = (projection, ...args) => {
    if (projection.ref.sessionId === ref.sessionId) recoveries++;
    return recover(projection, ...args);
  };
  now += 20000;
  const lease = other.acquire(ref, 'synthetic-competing-owner');
  appendFileSync(f.file(ref.sessionId), '}\n');
  for (let i = 0; i < 10 && reading.publisher.lease; i++) await cycle();
  assert.equal(reading.publisher.lease, null);
  assert.equal(reading.publisher.hasReading(), false);
  console.log(
    JSON.stringify({
      probe: 'expired-owner-to-follower',
      readers: c.resources().readers,
      pinned: c.resources().pinnedReaders,
      retainedReader: Boolean(reading.reader),
      retainedCheckpoint: Boolean(reading.checkpoint),
      generation: lease.generation,
    })
  );
  assert.equal(reading.reader, undefined);
  assert.equal(reading.checkpoint, undefined);
  assert.equal(reading.recoveryPending, true);
  assert.equal(store.readProjection(ref).commitSeq, before.commitSeq);
  const outcomes = c.takeLifecycleOutcomes();
  assert.equal(outcomes.filter((o) => o.reason === 'reader_authority_retired').length, 1);
  for (let i = 0; i < 5; i++) {
    await cycle();
    assert.equal(oldReads, 0);
    assert.equal(targetPublishes, 0);
    assert.equal(targetRenewals, 0);
  }
  assert.equal(c.takeLifecycleOutcomes().filter((o) => o.reason === 'reader_authority_retired').length, 0);
  assert.deepEqual(other.readLease(ref), lease);
  other.release(ref, lease);
  for (let i = 0; i < 40 && store.readProjection(ref).commitSeq === before.commitSeq; i++) await cycle();
  assert.ok(store.readProjection(ref).commitSeq > before.commitSeq);
  assert.ok(c.resources().readers <= 16);
  assert.equal(store.readProjection(ref).commitSeq, before.commitSeq + 1);
  assert.ok(recoveries > 0);
  assert.equal(oldReads, 0);
});

test('B10D expired active pending authority records one invalidation without acknowledging or publishing that candidate', async (t) => {
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  t.after(() => {
    Date.now = clock;
  });
  const { f, c, store, cycle } = await direct(t, 2),
    [key, reading] = await capturedChild(c, f, cycle),
    port = c.port;
  const before = store.readProjection(reading.ref),
    publisher = reading.publisher;
  now += 20000;
  port.setPublicationView(c.collector.current());
  for (let i = 0; i < 3 && publisher.hasPending(); i++) {
    port.begin(performance.now() + 40);
    const result = port.publishOne(now);
    assert.equal(result.attempted, false);
  }
  assert.equal(publisher.hasPending(), false);
  assert.equal(reading.reader, undefined);
  assert.equal(reading.checkpoint, undefined);
  const outcomes = c.takeLifecycleOutcomes().filter((o) => o.reason === 'publication_lease_invalidated');
  assert.equal(outcomes.length, 1);
  assert.equal(store.readProjection(reading.ref).commitSeq, before.commitSeq);
  assert.equal(store.readProjection(reading.ref).checkpointIdentity.offset, before.checkpointIdentity.offset);
  port.begin(performance.now() + 40);
  port.publishOne(now);
  assert.equal(c.takeLifecycleOutcomes().filter((o) => o.reason === 'publication_lease_invalidated').length, 0);
});
test('B10D worker exit preserves a validated unconsumed commit once without claiming paint', async (t) => {
  const f = await sourceFixture(3, 3),
    options = { autoAck: true },
    h = workerHarness(f, options);
  t.after(async () => {
    await h.close();
    f.cleanup();
  });
  await h.warm();
  options.autoAck = false;
  appendFileSync(f.file(f.targets[0].sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  const operation = h.step().catch(() => null);
  await waitUntil(() => h.client.incoming?.trace.commits.length > 0);
  const commits = h.client.incoming.trace.commits.map(({ refKey, commitSeq }) => ({ refKey, commitSeq }));
  await h.client.worker.terminate();
  await waitUntil(() => h.client.diagnostics().workers === 0);
  await operation;
  const rows = h.client.samples().filter((x) => x.outcome === 'worker_exit');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].commits, commits);
  assert.equal(rows[0].paintMs, null);
  assert.equal(rows[0].commitToPaintUpperMs, null);
});
test('B10D accepted retiring debt is excluded from ordinary LRU victims and retirement contexts never exceed16', async (t) => {
  const { c, cycle } = await direct(t, 40),
    port = c.port;
  // Existing authoritative ledger snapshot supplies real accepted relevance debt; the certificate hook is tested separately from B9 traversal.
  const readings = [...port.readings.values()],
    resident = readings.filter((r) => port.residency(r)),
    nonresident = readings.filter((r) => !port.residency(r));
  assert.equal(resident.length, 16);
  assert.ok(nonresident.length >= 16);
  for (const r of nonresident.slice(0, 16)) {
    r.owedLedger = true;
    r.owedSince = 1;
  }
  const view = c.collector.current(),
    currentRuns = new Map(view.tree.nodes.map((n) => [n.key, n.currentRun]));
  const absent = new Set(nonresident.slice(0, 16).map((r) => [...port.readings].find(([, v]) => v === r)[0]));
  const present = new Set([...port.readings.keys()].filter((k) => !absent.has(k)));
  port.reconcileMembership({ present, complete: true, currentRuns }, view);
  assert.equal([...port.readings.values()].filter((r) => r.retiring).length, 16);
  const victim = resident.find((r) => port.quiescent(r));
  assert.ok(victim);
  victim.owedLedger = true;
  victim.owedSince = 1;
  present.delete([...port.readings].find(([, r]) => r === victim)[0]);
  port.reconcileMembership({ present, complete: true, currentRuns }, view);
  assert.equal([...port.readings.values()].filter((r) => r.retiring).length, 16);
  assert.equal(victim.retirementBlocked, true);
  assert.equal(port.quiescent(victim), false);
  // Even a fully quiescent accepted retiring reader cannot be surrendered before its owed publication.
  victim.retirementBlocked = false;
  victim.retiring = true;
  assert.equal(port.quiescent(victim), false);
  victim.retiring = false;
  victim.retirementBlocked = true;
  await cycle();
  assert.ok(c.resources().retiring <= 16);
});
for (const scenario of ['full-one', 'near-multi', 'nonmonotonic-duplicate', 'lose-all-proof', 'spent-recovery'])
  test(`B10D exact durable recovery marker matches retained control across ${scenario} window`, async (t) => {
    const actualNow = Date.now,
      fixed = actualNow();
    Date.now = () => fixed;
    t.after(() => {
      Date.now = actualNow;
    });
    const { f, c, store, cycle } = await direct(t, 4),
      [ref, control] = f.targets;
    const quota = (at) =>
      runtimeRow('event_msg', { type: 'token_count', rate_limits: { primary: { used_percent: 0 } } }, at) +
      runtimeRow('event_msg', { type: 'token_count', rate_limits: { primary: { used_percent: 85 } } }, at);
    const heartbeat = Date.now();
    f.db.prepare('UPDATE runs SET heartbeat_at=?,heartbeat_seq=1,heartbeat_mono_ms=?').run(heartbeat, heartbeat);
    const count = scenario === 'near-multi' ? 58 : 60;
    let rows = runtimeRow('event_msg', { type: 'task_started' }, 1);
    for (let i = 0; i < count; i++) rows += quota(scenario === 'nonmonotonic-duplicate' && i >= count - 2 ? 1 : i + 1);
    for (const r of [ref, control]) appendFileSync(f.file(r.sessionId), rows);
    const settled = async () => {
      for (let i = 0; i < 150; i++) {
        await cycle();
        if ([ref, control].every((r) => store.readProjection(r).checkpointIdentity.offset === awaitSize(r))) return;
      }
      assert.fail('checkpoint did not settle');
    };
    const awaitSize = (r) => requireSize(f.file(r.sessionId));
    await settled();
    const reading = [...c.port.readings.values()].find((r) => r.ref.sessionId === ref.sessionId),
      retained = [...c.port.readings.values()].find((r) => r.ref.sessionId === control.sessionId),
      publisher = reading.publisher;
    const baseline = store.readProjection(ref),
      cp = reading.checkpoint;
    assert.equal(cp.codex.rollout.state.cachedResult.events.length, count);
    assert.equal(baseline.continuity.stateSinceBasis, 'event');
    assert.equal(publisher.canEvictAcceptedReading(), true);
    const beforeMemory = structuredClone(publisher.nativeMemory),
      beforeStats = structuredClone(publisher.result.stats);
    assert.equal(publisher.canEvictAcceptedReading(), true);
    assert.deepEqual(publisher.nativeMemory, beforeMemory);
    assert.deepEqual(publisher.result.stats, beforeStats);
    // This is the same surrender used by the separately exercised ordinary LRU; the recapture below is real readRecovery + native append.
    assert.equal(publisher.evictAcceptedReading(), true);
    reading.reader = undefined;
    reading.checkpoint = undefined;
    reading.evicted = true;
    reading.recoveryPending = true;
    assert.equal(publisher.nativeMemory, undefined);
    assert.equal(publisher.acceptedRecovery, null);
    let exactRecoveries = 0,
      descriptorSeen = false;
    const accept = publisher.acceptRecovery.bind(publisher);
    publisher.acceptRecovery = (prior, recovery) => {
      exactRecoveries++;
      const accepted = accept(prior, recovery);
      descriptorSeen = !!publisher.acceptedRecovery;
      return accepted;
    };
    const nativeStore = publisher.store,
      recover = nativeStore.readRecovery.bind(nativeStore);
    let delayed = false;
    if (scenario === 'spent-recovery')
      nativeStore.readRecovery = (...args) => {
        const result = recover(...args);
        if (!delayed && args[0].ref.sessionId === ref.sessionId) {
          delayed = true;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
        return result;
      };
    let appended = '';
    const added = scenario === 'lose-all-proof' ? 65 : scenario === 'near-multi' ? 4 : 1;
    for (let i = 0; i < added; i++) appended += quota(100 + i);
    for (const r of [ref, control]) appendFileSync(f.file(r.sessionId), appended);
    if (scenario === 'spent-recovery') {
      for (let i = 0; i < 30 && !delayed; i++) await cycle();
      assert.equal(delayed, true);
      assert.ok(publisher.acceptedRecovery);
      assert.equal(reading.reader, undefined);
    }
    await settled();
    assert.equal(exactRecoveries, 1);
    assert.equal(descriptorSeen, true);
    assert.equal(publisher.acceptedRecovery, null);
    const after = store.readProjection(ref),
      other = store.readProjection(control);
    assert.equal(after.continuity.stateSince, other.continuity.stateSince);
    assert.equal(after.continuity.stateSinceBasis, other.continuity.stateSinceBasis);
    assert.equal(after.continuity.episodeAnchor, other.continuity.episodeAnchor);
    assert.deepEqual(publisher.nativeMemory, retained.publisher.nativeMemory);
    if (scenario !== 'lose-all-proof') assert.equal(after.continuity.stateSince, baseline.continuity.stateSince);
    else
      assert.equal(
        publisher.nativeMemory.known,
        false,
        'old accepted marker must not be replaced by a newly appended marker'
      );
    assert.equal(after.noticeState.noticeSeq, other.noticeState.noticeSeq);
  });
import { statSync as requireSizeStat } from 'node:fs';
const requireSize = (file) => requireSizeStat(file).size;
test('B10D recovery marker provenance rejects mismatched accepted tuples and forget discards all continuity state', async (t) => {
  const { f, c, store } = await direct(t, 3),
    ref = f.targets[0],
    reading = [...c.port.readings.values()].find((r) => r.ref.sessionId === ref.sessionId),
    publisher = reading.publisher;
  const prior = store.readProjection(ref),
    recovery = publisher.store.readRecovery(prior, { maxBytes: 4 * 1024 * 1024, maxRecords: 2000, budgetMs: 20 });
  assert.ok(recovery && !('kind' in recovery));
  for (const alter of [
    (p) => (p.ref.sessionId += 'other'),
    (p) => (p.seqDomain += 'other'),
    (p) => p.commitSeq++,
    (p) => p.sourceGeneration++,
    (p) => (p.checkpointIdentity.contentIdentity += 'other'),
    (p) => (p.observationStamp.runId += 'other'),
    (p) => p.observationStamp.bindingGeneration++,
    (p) => p.observationStamp.inputLedgerSeq++,
  ]) {
    const wrong = structuredClone(prior);
    alter(wrong);
    assert.equal(publisher.acceptRecovery(wrong, recovery), false);
    assert.equal(publisher.acceptedRecovery, null);
  }
  assert.equal(publisher.acceptRecovery(prior, recovery), true);
  assert.ok(publisher.acceptedRecovery);
  publisher.forget();
  assert.equal(publisher.acceptedRecovery, null);
  assert.equal(publisher.nativeMemory, undefined);
});
test('B10D null and continued exact recovery cannot install a marker or advance the native accepted boundary', async (t) => {
  const { f, c, store, cycle } = await direct(t, 3),
    ref = f.targets[0],
    reading = [...c.port.readings.values()].find((r) => r.ref.sessionId === ref.sessionId),
    publisher = reading.publisher;
  const baseline = store.readProjection(ref);
  assert.equal(publisher.evictAcceptedReading(), true);
  reading.reader = undefined;
  reading.checkpoint = undefined;
  reading.evicted = true;
  reading.recoveryPending = true;
  appendFileSync(f.file(ref.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  const source = publisher.store,
    read = source.readRecovery.bind(source);
  let attempts = 0;
  source.readRecovery = (target, budget) => {
    if (target.ref.sessionId !== ref.sessionId) return read(target, budget);
    attempts++;
    if (attempts === 1) return null;
    if (attempts === 2)
      return {
        kind: 'recovery_catching_up',
        coverage: { state: 'catching_up', loaded: false, skipped: {}, gaps: [], reason: 'synthetic_slice_end' },
      };
    return read(target, budget);
  };
  for (let i = 0; i < 30 && attempts < 2; i++) {
    await cycle();
    if (attempts <= 2) {
      assert.equal(publisher.acceptedRecovery, null);
      assert.equal(reading.reader, undefined);
      assert.equal(store.readProjection(ref).commitSeq, baseline.commitSeq);
    }
  }
  assert.equal(attempts, 2);
  for (let i = 0; i < 30 && !reading.reader; i++) await cycle();
  assert.equal(attempts, 3);
  assert.ok(reading.reader);
  assert.equal(publisher.acceptedRecovery, null);
});
test('B10D empty unknown exact recapture converges and a later real turn matches the retained control', async (t) => {
  const original = Date.now,
    now = original();
  Date.now = () => now;
  t.after(() => {
    Date.now = original;
  });
  const { f, c, store, cycle } = await direct(t, 4),
    [ref, control] = f.targets;
  const reading = [...c.port.readings.values()].find((r) => r.ref.sessionId === ref.sessionId),
    retained = [...c.port.readings.values()].find((r) => r.ref.sessionId === control.sessionId),
    p = reading.publisher;
  assert.equal(p.result.observation.statusProjection.activity, 'unknown');
  assert.equal(p.canEvictAcceptedReading(), true);
  assert.equal(p.evictAcceptedReading(), true);
  reading.reader = undefined;
  reading.checkpoint = undefined;
  reading.evicted = true;
  reading.recoveryPending = true;
  f.db.prepare('UPDATE runs SET heartbeat_at=?,heartbeat_seq=1,heartbeat_mono_ms=?').run(now, now);
  for (let i = 0; i < 40 && !reading.reader; i++) await cycle();
  assert.ok(reading.reader);
  assert.equal(p.result.stats.recordsRead, 0);
  for (let i = 0; i < 20; i++) await cycle();
  assert.equal(reading.owedLedger, false);
  assert.equal(retained.owedLedger, false);
  assert.equal(store.readProjection(ref).continuity.stateKey, store.readProjection(control).continuity.stateKey);
  assert.deepEqual(p.nativeMemory, retained.publisher.nativeMemory);
  assert.equal(p.canEvictAcceptedReading(), true);
  for (const r of [ref, control])
    appendFileSync(f.file(r.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  for (let i = 0; i < 40; i++) await cycle();
  assert.deepEqual(p.nativeMemory, retained.publisher.nativeMemory);
  assert.equal(store.readProjection(ref).continuity.stateSince, store.readProjection(control).continuity.stateSince);
  assert.equal(store.readProjection(ref).continuity.stateSinceBasis, 'event');
});
test('B10D non-working approval and ended-turn history do not bypass exact continuity eviction proof', async (t) => {
  const { f, c, store, cycle } = await direct(t, 3),
    ref = f.targets[0],
    reading = [...c.port.readings.values()].find((r) => r.ref.sessionId === ref.sessionId),
    p = reading.publisher;
  const now = Date.now();
  f.db.prepare('UPDATE runs SET heartbeat_at=?,heartbeat_seq=1,heartbeat_mono_ms=?').run(now, now);
  appendFileSync(
    f.file(ref.sessionId),
    runtimeRow('event_msg', { type: 'task_started' }, 1) +
      runtimeRow('event_msg', { type: 'exec_approval_request', call_id: 'latent', command: ['true'] }, 2)
  );
  for (let i = 0; i < 30; i++) await cycle();
  assert.equal(p.result.observation.statusProjection.activity, 'waiting_input');
  assert.equal(p.canEvictAcceptedReading(), false);
  assert.equal(p.evictAcceptedReading(), false);
  appendFileSync(
    f.file(ref.sessionId),
    runtimeRow('event_msg', { type: 'exec_command_begin', call_id: 'latent' }, 3) +
      runtimeRow('event_msg', { type: 'task_complete' }, 4)
  );
  for (let i = 0; i < 30; i++) await cycle();
  assert.equal(p.result.observation.statusProjection.activity, 'idle');
  assert.equal(p.canEvictAcceptedReading(), false);
  let rows = '';
  for (let i = 0; i < 65; i++)
    rows +=
      runtimeRow('event_msg', { type: 'token_count', rate_limits: { primary: { used_percent: 0 } } }, 10 + i) +
      runtimeRow('event_msg', { type: 'token_count', rate_limits: { primary: { used_percent: 85 } } }, 10 + i);
  appendFileSync(f.file(ref.sessionId), rows);
  for (let i = 0; i < 30; i++) await cycle();
  assert.equal(p.result.checkpoint.codex.rollout.state.cachedResult.events.length, 60);
  assert.equal(p.canEvictAcceptedReading(), false);
  // Same timestamp is legal input; ended history must not have been discarded before this transition.
  appendFileSync(f.file(ref.sessionId), runtimeRow('event_msg', { type: 'task_started' }, 1));
  for (let i = 0; i < 30; i++) await cycle();
  assert.equal(p.result.observation.statusProjection.activity, 'working');
  assert.equal(p.nativeMemory.turnAt, 1772366401000);
  assert.equal(p.canEvictAcceptedReading(), false);
  assert.equal(reading.evicted, false);
  assert.ok(store.readProjection(ref));
});
