import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync, mkdtempSync, copyFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { notifyFixture, reportFor } from './b21-fixture.js';
import { openObservationStore } from '../../src/core/observation-store.js';
import { StatusWriter } from '../../src/core/status/writer.js';
import { initialParserState, displayNodeKey } from '../../src/core/observation.js';
import { mergeStatus, STATUS_RULE_VERSION } from '../../src/core/status/merge.js';
import { HudDelegationCollector } from '../../src/collectors/delegation.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import type { ReaderResult } from '../../src/core/interfaces/harness-adapter.js';
import type { ObservationRecoveryTarget, RecoveryReadGrant } from '../../src/core/types/checkpoint.js';
import { performance } from 'node:perf_hooks';
import { sameSessionRef } from '../../src/core/identity.js';
const opts = { skip: !ledgerRuntimeSupported() };

async function setup(t: import('node:test').TestContext, runId = 'run-a') {
  const f = await notifyFixture();
  t.after(() => f.close());
  await reportFor(f, 'completed');
  const dir = join(f.root, 'sessions', '2026', '11', '02');
  mkdirSync(dir, { recursive: true });
  for (const ref of [f.parent.ref, f.child.ref])
    writeFileSync(
      join(dir, `rollout-${ref.sessionId}.jsonl`),
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-11-02T12:00:00Z',
        payload: {
          id: ref.sessionId,
          cwd: '/synthetic/project',
          ...(ref === f.child.ref ? { parent_thread_id: f.parent.ref.sessionId } : {}),
        },
      }) + '\n'
    );
  const ref = f.child.ref;
  const target = {
    nodeIdentity: { kind: 'session' as const, ref },
    sourceGeneration: 1,
    runId,
    bindingGeneration: 1,
  };
  const facts = {
    target,
    sources: [],
    asOfSeq: 2,
    observationStamp: null,
    ledgerFacts: [
      {
        id: 'run',
        value: { run: { runId, state: 'running' as const } },
        eventAt: 1000,
        observedAt: 1200,
        deadlineAt: null,
      },
    ],
    history: { continuity: 'unknown' as const },
  };
  const unknown = { value: null, quality: 'unknown' as const, source: 'synthetic:unknown', asOf: 1200 };
  const reading: ReaderResult = {
    checkpoint: {
      schemaVersion: 1,
      readerVersion: 'synthetic-b10a-v1',
      ref,
      fileId: { dev: 1, inode: 2 },
      offset: 10,
      sourceGeneration: 1,
      parserState: initialParserState(),
    },
    observation: {
      nodeIdentity: target.nodeIdentity,
      statusProjection: mergeStatus(facts, null, STATUS_RULE_VERSION, 1200).projection,
      conflict: null,
      spent: { tokens: unknown, costUsd: unknown },
      workspace: null,
      coverage: { state: 'complete', skipped: {}, gaps: [], loaded: true },
      loaded: true,
      depth: 0,
      evidenceStamp: 'synthetic-b10a-committed',
    },
  };
  const store = await openObservationStore({ hudHome: f.root, sourceId: ref.sourceId, now: () => 1200 });
  t.after(() => store.close());
  const lease = store.acquire(ref, 'synthetic-b10a');
  const writer = new StatusWriter(store, ref, lease);
  const committed = writer.publish(writer.prepare(reading, [], target), facts, STATUS_RULE_VERSION, 1200).committed;
  const runtime = await HudDelegationCollector.open({ HUD_HOME: f.root }, f.root);
  assert.ok(runtime);
  t.after(() => runtime.close());
  return { f, ref, store, committed, runtime };
}

test('publishing recovery charges exact checkpoint I/O and retains it across an exhausted grant', opts, async (t) => {
  const f = await notifyFixture();
  t.after(() => f.close());
  await reportFor(f, 'completed');
  const dir = join(f.root, 'sessions', '2026', '11', '02');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const ref of [f.parent.ref, f.child.ref])
    writeFileSync(
      join(dir, `rollout-${ref.sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'session_meta',
          timestamp: new Date(now - 5000).toISOString(),
          payload: {
            id: ref.sessionId,
            cwd: '/synthetic',
            timestamp: new Date(now - 5000).toISOString(),
            cli_version: '0.synthetic',
            ...(ref === f.child.ref ? { parent_thread_id: f.parent.ref.sessionId } : {}),
          },
        }),
        ...(ref === f.child.ref
          ? [
              JSON.stringify({
                type: 'event_msg',
                timestamp: new Date(now - 4000).toISOString(),
                payload: { type: 'task_started' },
              }),
            ]
          : []),
      ].join('\n') + '\n'
    );
  const first = await HudDelegationCollector.open({ HUD_HOME: f.root }, f.root, { publish: true });
  assert.ok(first);
  let firstClosed = false;
  t.after(() => {
    if (!firstClosed) first.close();
  });
  const key = displayNodeKey({ kind: 'session', ref: f.child.ref });
  let published = false;
  for (let i = 0; i < 60; i++) {
    let view = await first.tick(f.parent.ref.sessionId);
    await first.afterPaint((next) => {
      if (next) view = next;
    });
    if (view?.details[key]?.statusSource === 'committed') {
      published = true;
      break;
    }
  }
  assert.ok(published, 'real Codex checkpoint was committed');
  first.close();
  firstClosed = true;

  const restarted = await HudDelegationCollector.open({ HUD_HOME: f.root }, f.root, { publish: true });
  assert.ok(restarted);
  t.after(() => restarted.close());
  const port = (restarted as any).port;
  const source = port.sources.get(f.child.ref.sourceId);
  const store = source.store;
  const nativeErrors: string[] = [];
  const openNative = source.adapter.open.bind(source.adapter);
  source.adapter.open = (...args: any[]) => {
    try {
      const reader = openNative(...args);
      const readNative = reader.read.bind(reader);
      reader.read = async (...readArgs: any[]) => {
        try {
          return await readNative(...readArgs);
        } catch (error) {
          nativeErrors.push(String(error));
          throw error;
        }
      };
      return reader;
    } catch (error) {
      nativeErrors.push(String(error));
      throw error;
    }
  };
  const read = store.readRecoveryMetered.bind(store);
  store.readRecovery = () => assert.fail('legacy unmetered recovery must not be used');
  const results: any[] = [];
  store.readRecoveryMetered = (target: ObservationRecoveryTarget, grant: RecoveryReadGrant) => {
    assert.ok(sameSessionRef(target.ref, f.child.ref));
    const effective =
      results.length === 0
        ? {
            now: () => grant.now(),
            remaining: () => ({ ...grant.remaining(), maxRecords: 0 }),
            charge: (stats: any) => grant.charge(stats),
            drain: () => grant.drain(),
          }
        : grant;
    const result = read(target, effective);
    results.push(result);
    return result;
  };
  const budget = { maxBytes: 4 * 1024 * 1024, maxRecords: 1, budgetMs: 2000 };
  for (let i = 0; i < 30 && !source.adapter.collectionState(f.child.ref, false).file; i++) {
    port.begin(performance.now() + 2000);
    await port.collect(f.child.ref, 'native_topology', { ...budget, maxRecords: 2000 });
  }
  assert.ok(source.adapter.collectionState(f.child.ref, false).file, 'native discovery completed');
  port.takeUnattributedIO();
  let leaseReads = 0;
  let leaseAcquisitions = 0;
  let leaseRenewals = 0;
  const readLease = store.readLease.bind(store);
  const acquire = store.acquire.bind(store);
  const renew = store.renew.bind(store);
  store.readLease = (...args: any[]) => {
    leaseReads++;
    return readLease(...args);
  };
  store.acquire = (...args: any[]) => {
    leaseAcquisitions++;
    return acquire(...args);
  };
  store.renew = (...args: any[]) => {
    leaseRenewals++;
    return renew(...args);
  };
  for (const refused of [
    { ...budget, maxBytes: 0 },
    { ...budget, maxRecords: 0 },
    { ...budget, budgetMs: 0 },
    { ...budget, budgetMs: Number.NaN },
  ]) {
    port.begin(performance.now() + 2000);
    port.readings.get(key).rateTarget = undefined;
    leaseReads = leaseAcquisitions = leaseRenewals = 0;
    await port.collect(f.child.ref, 'session', refused);
    assert.deepEqual([leaseReads, leaseAcquisitions, leaseRenewals], [0, 0, 0]);
    assert.equal(results.length, 0);
    assert.equal(port.readings.get(key).publisher, undefined);
  }
  port.begin(performance.now() - 1);
  port.readings.get(key).rateTarget = undefined;
  leaseReads = leaseAcquisitions = leaseRenewals = 0;
  await port.collect(f.child.ref, 'session', budget);
  assert.deepEqual([leaseReads, leaseAcquisitions, leaseRenewals], [0, 0, 0]);
  assert.equal(results.length, 0);
  // Isolate writer recovery from the separately tested optional display-rate recovery.
  port.begin(performance.now() + 2000);
  port.readings.get(key).rateTarget = undefined;
  await port.collect(f.child.ref, 'session', budget);
  assert.equal(results[0]?.kind, 'continuation');
  assert.ok(leaseAcquisitions > 0, 'a later ordinary grant can still acquire authority');
  assert.equal(port.readings.get(key).recoveryPending, true);
  assert.deepEqual(port.takeUnattributedIO(), { bytesRead: 0, recordsRead: 0 });
  port.begin(performance.now() + 2000);
  port.readings.get(key).rateTarget = undefined;
  leaseReads = leaseAcquisitions = leaseRenewals = 0;
  await port.collect(f.child.ref, 'session', { ...budget, budgetMs: 0 });
  assert.deepEqual([leaseReads, leaseAcquisitions, leaseRenewals], [0, 0, 0], 'held authority is not renewed');
  assert.equal(results.length, 1);
  assert.equal(port.readings.get(key).recoveryPending, true);
  port.begin(performance.now() + 2000);
  port.readings.get(key).rateTarget = undefined;
  await port.collect(f.child.ref, 'session', budget);
  assert.equal(results[1]?.kind, 'recovered');
  assert.equal(port.readings.get(key).recoveryPending, false);
  assert.ok(port.readings.get(key).checkpoint);
  assert.equal(port.readings.get(key).reader, undefined, 'one-record grant ended after exact recovery');
  assert.deepEqual(port.takeUnattributedIO(), {
    bytesRead: results[1].stats.bytesRead,
    recordsRead: results[1].stats.recordsRead,
  });
  port.begin(performance.now() + 2000);
  port.readings.get(key).rateTarget = undefined;
  await port.collect(f.child.ref, 'session', { ...budget, maxRecords: 2000 });
  assert.equal(results.length, 2, 'next ordinary grant uses the recovered checkpoint without refetching');
  assert.ok(
    port.readings.get(key).publisher?.hasReading(),
    `a real native capture followed recovery: ${nativeErrors.join(', ')}`
  );
});

for (const runId of ['run-a', 'old-run'])
  test(
    `B10A committed B16 ${runId === 'run-a' ? 'stamp/continuity preserved without new notices' : 'old-run stamp rejected with bounded ledger fallback'}`,
    opts,
    async (t) => {
      const { f, ref, store, committed, runtime } = await setup(t, runId);
      let view;
      for (let i = 0; i < 30; i++) {
        view = await runtime.tick(f.parent.ref.sessionId);
        if (view?.details[displayNodeKey({ kind: 'session', ref })]?.status) break;
      }
      const detail = view!.details[displayNodeKey({ kind: 'session', ref })];
      assert.ok(detail);
      if (runId === 'run-a') {
        assert.equal(detail.statusSource, 'committed');
        assert.deepEqual(detail.status, committed.summary.statusProjection);
        assert.deepEqual(detail.status!.observationStamp, committed.observationStamp);
        assert.notEqual(detail.status!.asOfSeq, view!.tree.ledger.asOfSeq);
      } else {
        assert.equal(detail.statusSource, 'ledger');
        assert.equal(detail.status!.observationStamp, null);
        assert.notEqual(detail.status!.stateKey, undefined);
        const node = view!.tree.nodes.find((n) => n.key === displayNodeKey({ kind: 'session', ref }))!;
        assert.equal(node.lastObservation!.statusProjection.observationStamp!.runId, 'old-run');
        assert.equal(node.observation, null);
      }
      for (let i = 0; i < 3; i++) await runtime.tick(f.parent.ref.sessionId);
      const later = store.readProjection(ref)!;
      assert.equal(later.commitSeq, committed.commitSeq);
      assert.deepEqual(later.notices, committed.notices);
      assert.deepEqual(later.continuity, committed.continuity);
      assert.ok(runtime.collector.stats().immediateMerges <= 20);
    }
  );

for (const replacement of ['missing-projection', 'empty-replacement', 'failed-open-retry'])
  test(`B10A observation ${replacement} demotes old committed data`, opts, async (t) => {
    const { f, ref, store, runtime } = await setup(t);
    const key = displayNodeKey({ kind: 'session', ref });
    let view;
    for (let i = 0; i < 30; i++) view = await runtime.tick(f.parent.ref.sessionId);
    assert.equal(view!.details[key].statusSource, 'committed');
    if (replacement === 'missing-projection') {
      (store as any).db.exec('DELETE FROM observation_current');
    } else {
      store.close();
      const fresh = mkdtempSync(join(tmpdir(), 'hud-b10a-empty-store-'));
      t.after(() => rmSync(fresh, { recursive: true, force: true }));
      const empty = await openObservationStore({ hudHome: fresh, sourceId: ref.sourceId });
      const emptyFile = empty.databasePath;
      empty.close();
      const file = join(f.root, 'sources', ref.sourceId, 'observation.sqlite');
      renameSync(file, file + '.old');
      for (const suffix of ['-wal', '-shm'])
        if (existsSync(file + suffix)) renameSync(file + suffix, file + '.old' + suffix);
      copyFileSync(emptyFile, file);
      if (replacement === 'failed-open-retry') {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(file);
        db.exec('PRAGMA user_version=99');
        db.close();
        await runtime.prepare();
        assert.equal((runtime as any).port.sources.get(ref.sourceId).store, null);
        const fixed = new DatabaseSync(file);
        fixed.exec('PRAGMA user_version=2');
        fixed.close();
      }
      await runtime.prepare();
      assert.ok((runtime as any).port.sources.get(ref.sourceId).store);
    }
    for (let i = 0; i < 10; i++) view = await runtime.tick(f.parent.ref.sessionId);
    assert.notEqual(view?.details[key]?.statusSource, 'committed');
  });
