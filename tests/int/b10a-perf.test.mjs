import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { runtimeFixture, runtimeRow } from './b10a-runtime-fixture.mjs';
import { fixture, root, child, collected } from './b9-fixture.mjs';
import { openLinkLedgerReader } from '../../dist/core/link-ledger-read.js';
import { LinkTickCollector } from '../../dist/core/link/tick.js';
import { loadLimits } from '../../dist/core/link/limits.js';
import { displayNodeKey } from '../../dist/core/observation.js';

test('B10A perf owned zero-charge snapshots reuse only unchanged inputs and invalidate explicitly', async (t) => {
  const f = await runtimeFixture(3, 8);
  t.after(f.cleanup);
  for (let i = 0; i < 100; i++) {
    const view = await f.runtime.tick(f.parent.sessionId);
    if (view?.tree.nodes.length === 3 && view.tree.nodes.every((node) => node.loaded) && view.pendingStatus === 0)
      break;
  }
  const port = f.runtime.port;
  const before = port.sessions();
  assert.equal(before.length, 3);
  for (let i = 0; i < 3; i++) {
    await f.runtime.tick(f.parent.sessionId);
    assert.strictEqual(port.sessions(), before);
    assert.equal(f.runtime.collector.stats().projected, false);
  }
  for (const envelope of before) {
    assert.equal(envelope.bytesRead, 0);
    assert.equal(envelope.recordsRead, 0);
    assert.equal(envelope.topology.bytesRead, 0);
  }
  appendFileSync(f.file(f.targets[0].sessionId), runtimeRow('event_msg', { type: 'task_started' }));
  for (let i = 0; i < 10 && port.sessions() === before; i++) await f.runtime.tick(f.parent.sessionId);
  assert.notStrictEqual(port.sessions(), before);
  const current = port.sessions();
  port.invalidateSnapshots();
  assert.notStrictEqual(port.sessions(), current);
  const invalidated = port.sessions();
  assert.deepEqual(invalidated, current);
  port.invalidateSource(f.parent.sourceId);
  assert.notStrictEqual(port.sessions(), invalidated);
  const callerRef = { ...f.parent, sessionId: 'synthetic-history-4' };
  await port.collect(callerRef, 'session', { maxBytes: 4 * 1024 * 1024, maxRecords: 2000, budgetMs: 20 });
  const owned = port.sessions();
  assert.ok(owned.some((entry) => entry.evidence.ref.sessionId === 'synthetic-history-4'));
  callerRef.sessionId = 'synthetic-mutated-caller';
  assert.strictEqual(port.sessions(), owned);
  assert.ok(owned.some((entry) => entry.evidence.ref.sessionId === 'synthetic-history-4'));
  assert.ok(owned.every((entry) => entry.evidence.ref.sessionId !== callerRef.sessionId));
});

test('B10A perf cached snapshots still expire freshness and invalidate through repeated busy reads', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.db.exec('PRAGMA journal_mode=DELETE');
  const current = collected(child),
    status = current.evidence.observation.statusProjection;
  status.observationStamp = {
    ref: child,
    runId: 'run-a',
    bindingGeneration: 1,
    sourceGeneration: 1,
    seqDomain: 'synthetic-committed',
    commitSeq: 7,
    inputLedgerSeq: 1,
  };
  status.freshness = {
    state: 'fresh',
    sources: [
      {
        id: 'transcript',
        validity: 'current',
        lastEvidenceAt: 12000,
        observedAt: 12000,
        lastSuccessfulReadAt: 12000,
        deadlineAt: 13000,
      },
    ],
    requiredSourceIds: ['transcript'],
    staleSince: null,
    reason: null,
    clockAnomaly: false,
  };
  const evidence = [collected(root), current];
  let snapshot = evidence.slice(),
    invalidations = 0;
  const port = {
    immutableSnapshots: true,
    sessions: () => snapshot,
    pending: () => null,
    collect: async () => null,
    invalidateSnapshots() {
      invalidations++;
      snapshot = evidence.slice();
    },
  };
  const collector = new LinkTickCollector(await openLinkLedgerReader(f.path), f.home, loadLimits(f.home), port);
  t.after(() => collector.close());
  const roots = [{ kind: 'session', ref: root }],
    key = displayNodeKey({ kind: 'session', ref: child });
  await collector.tick({ roots, nowMs: 12000 });
  const fresh = await collector.tick({ roots, nowMs: 12001 });
  assert.equal(fresh.details[key].status.freshness.state, 'fresh');
  assert.equal(collector.stats().projected, false);
  const before = invalidations;
  const expired = await collector.tick({ roots, nowMs: 14000 });
  assert.equal(expired.details[key].status.freshness.state, 'stale');
  assert.equal(collector.stats().projected, false);
  assert.ok(invalidations > before);
  await collector.tick({ roots, nowMs: 12000 });
  f.db.exec('BEGIN EXCLUSIVE');
  try {
    for (const nowMs of [14000, 14001, 14002]) {
      const prior = invalidations;
      const busy = await collector.tick({ roots, nowMs });
      assert.equal(busy.details[key].status.freshness.state, 'stale');
      assert.equal(busy.tree.ledger.reason, 'ledger_busy');
      assert.ok(invalidations > prior);
    }
  } finally {
    f.db.exec('ROLLBACK');
  }
  assert.equal((await collector.tick({ roots, nowMs: 14003 })).tree.ledger.state, 'available');
});

test('B10A perf scheduling keys follow mutable caller refs retained by an earlier tree', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const pending = [];
  const port = {
    sessions: () => [],
    pending(ref, key) {
      pending.push({ ref: { ...ref }, key });
      return null;
    },
    collect: async () => null,
  };
  const collector = new LinkTickCollector(await openLinkLedgerReader(f.path), f.home, loadLimits(f.home), port);
  t.after(() => collector.close());
  const previous = { ...root },
    roots = [{ kind: 'session', ref: { ...root } }];
  await collector.tick({ roots: [{ kind: 'session', ref: previous }], nowMs: 12000 });
  previous.sessionId = 'synthetic-mutated-first-root';
  pending.length = 0;
  await collector.tick({ roots, nowMs: 12001 });
  assert.ok(pending.some((entry) => entry.ref.sessionId === previous.sessionId));
  for (const entry of pending) assert.equal(entry.key, displayNodeKey({ kind: 'session', ref: entry.ref }));
  previous.sessionId = 'synthetic-mutated-again';
  pending.length = 0;
  await collector.tick({ roots, nowMs: 12002 });
  for (const entry of pending) assert.equal(entry.key, displayNodeKey({ kind: 'session', ref: entry.ref }));
});
