import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  mkdtempSync,
  copyFileSync,
  renameSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { notifyFixture, reportFor } from './b21-fixture.js';
import { openObservationStore, RecoveryGrant } from '../../src/core/observation-store.js';
import { StatusWriter } from '../../src/core/status/writer.js';
import { initialParserState, displayNodeKey } from '../../src/core/observation.js';
import { mergeStatus, STATUS_RULE_VERSION } from '../../src/core/status/merge.js';
import { HudDelegationCollector } from '../../src/collectors/delegation.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import type { ReaderResult } from '../../src/core/interfaces/harness-adapter.js';
import type { ObservationRecoveryTarget, RecoveryReadGrant } from '../../src/core/types/checkpoint.js';
import { performance } from 'node:perf_hooks';
import { sameSessionRef } from '../../src/core/identity.js';
import type { LinkTreeProjection } from '../../src/core/link/types.js';
import { RecoveryClearPending } from '../../src/harness/codex/recovery-index.js';
const opts = { skip: !ledgerRuntimeSupported() };

test('real Codex recovery resumes paged turn clear and commits the completed record', opts, async (t) => {
  const f = await notifyFixture();
  t.after(() => f.close());
  await reportFor(f, 'completed');
  const dir = join(f.root, 'sessions', '2026', '11', '02');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const line = (type: string, payload: object, offset: number) =>
    JSON.stringify({ type, timestamp: new Date(now + offset).toISOString(), payload });
  const meta = (id: string) =>
    line(
      'session_meta',
      { id, cwd: '/synthetic', timestamp: new Date(now).toISOString(), cli_version: '0.synthetic' },
      0
    );
  const childPath = join(dir, `rollout-${f.child.ref.sessionId}.jsonl`);
  const initial =
    [
      meta(f.child.ref.sessionId),
      ...Array.from({ length: 5 }, (_, n) =>
        line(
          'response_item',
          { type: 'function_call', call_id: `call-${n}`, name: 'exec_command', arguments: '{}' },
          n + 1
        )
      ),
    ].join('\n') + '\n';
  writeFileSync(childPath, initial);
  writeFileSync(join(dir, `rollout-${f.parent.ref.sessionId}.jsonl`), meta(f.parent.ref.sessionId) + '\n');
  const first = await HudDelegationCollector.open({ HUD_HOME: f.root }, f.root, { publish: true });
  assert.ok(first);
  const key = displayNodeKey({ kind: 'session', ref: f.child.ref });
  const wide = { maxBytes: 4 * 1024 * 1024, maxRecords: 2000, budgetMs: 2000 };
  const firstPort = (first as any).port;
  const firstStore = firstPort.sources.get(f.child.ref.sourceId).store;
  let initialCommitted = false;
  for (let n = 0; n < 80 && !initialCommitted; n++) {
    await first.tick(f.parent.ref.sessionId);
    await first.afterPaint(() => {});
    const projection = firstStore.readProjection(f.child.ref);
    if (!projection) continue;
    const recovered = firstStore.readRecoveryMetered(projection, new RecoveryGrant(wide));
    initialCommitted =
      recovered.kind === 'recovered' && recovered.recovery.checkpoint.offset === Buffer.byteLength(initial);
  }
  assert.ok(initialCommitted, 'initial real native checkpoint is durable');
  first.close();
  const turn = line('event_msg', { type: 'task_started' }, 100) + '\n';
  appendFileSync(childPath, turn);
  const restarted = await HudDelegationCollector.open({ HUD_HOME: f.root }, f.root, { publish: true });
  assert.ok(restarted);
  t.after(() => restarted.close());
  const port = (restarted as any).port;
  const source = port.sources.get(f.child.ref.sourceId);
  let sawPending = false;
  const openNative = source.adapter.open.bind(source.adapter);
  source.adapter.open = (...args: any[]) => {
    const reader = openNative(...args);
    const read = reader.read.bind(reader);
    reader.read = async (...readArgs: any[]) => {
      try {
        return await read(...readArgs);
      } catch (error) {
        if (error instanceof RecoveryClearPending) sawPending = true;
        throw error;
      }
    };
    return reader;
  };
  for (let n = 0; n < 30 && !source.adapter.collectionState(f.child.ref, false).file; n++) {
    port.begin(performance.now() + 2000);
    await port.collect(f.child.ref, 'native_topology', wide);
  }
  assert.ok(source.adapter.collectionState(f.child.ref, false).file);
  let captured = false;
  for (let n = 0; n < 20 && !captured; n++) {
    port.begin(performance.now() + 2000, 'clear-e2e');
    await port.collect(f.child.ref, 'session', { ...wide, maxRecords: 3 });
    const reading = port.readings.get(key);
    if (sawPending && !captured && reading.checkpoint?.offset === Buffer.byteLength(initial))
      assert.equal(reading.publisher?.hasReading(), false, 'pending deletions are not captured');
    captured = reading?.checkpoint?.offset === Buffer.byteLength(initial + turn) && !!reading.publisher?.hasReading();
  }
  assert.ok(sawPending, 'the clear was left pending without publishing its record');
  assert.ok(captured, 'the same record completes after subsequent grants');
  for (let n = 0; n < 20; n++) {
    await restarted.tick(f.parent.ref.sessionId);
    await restarted.afterPaint(() => {});
    const projection = source.store.readProjection(f.child.ref);
    if (!projection) continue;
    const result = source.store.readRecoveryMetered(projection, new RecoveryGrant(wide));
    if (result.kind === 'recovered' && result.recovery.checkpoint.offset === Buffer.byteLength(initial + turn)) return;
  }
  assert.fail('completed record was not committed');
});

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
  let firstTree: LinkTreeProjection | null = null;
  for (let i = 0; i < 60; i++) {
    let view = await first.tick(f.parent.ref.sessionId);
    await first.afterPaint((next) => {
      if (next) view = next;
    });
    if (view?.details[key]?.statusSource === 'committed') {
      published = true;
      firstTree = view.tree;
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
  port.begin(performance.now() + 2000, 'synthetic-scope');
  port.readings.get(key).rateTarget = undefined;
  await port.collect(f.child.ref, 'session', budget);
  assert.equal(results[0]?.kind, 'continuation');
  assert.ok(leaseAcquisitions > 0, 'a later ordinary grant can still acquire authority');
  assert.equal(port.readings.get(key).recoveryPending, true);
  assert.deepEqual(port.takeUnattributedIO(), { bytesRead: 0, recordsRead: 0 });
  port.begin(performance.now() + 2000, 'synthetic-scope');
  port.readings.get(key).rateTarget = undefined;
  leaseReads = leaseAcquisitions = leaseRenewals = 0;
  await port.collect(f.child.ref, 'session', { ...budget, budgetMs: 0 });
  assert.deepEqual([leaseReads, leaseAcquisitions, leaseRenewals], [0, 0, 0], 'held authority is not renewed');
  assert.equal(results.length, 1);
  assert.equal(port.readings.get(key).recoveryPending, true);
  port.begin(performance.now() + 2000, 'synthetic-scope');
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
  assert.ok(port.continuation, 'exact recovery exhausted the grant and created one continuation');
  let savedTicket = port.continuation;
  assert.equal(port.rejectContinuation(), true);
  assert.equal(port.rejectContinuation(), false, 'deadline rejection spends one ticket only');
  const originalCheckpoint = port.readings.get(key).checkpoint;
  port.readings.get(key).checkpoint = { ...originalCheckpoint };
  port.continuation = savedTicket;
  assert.equal(port.rejectContinuation(), true);
  assert.equal(
    port.readings.get(key).spentRecovery,
    savedTicket.fingerprint,
    'replaced object cannot revive old priority'
  );
  port.readings.get(key).checkpoint = originalCheckpoint;
  port.continuation = savedTicket;
  assert.equal(store.recoveryAuthorityCurrent(savedTicket.target, savedTicket.lease), true);
  assert.equal(
    store.recoveryAuthorityCurrent(
      { ...savedTicket.target, commitSeq: savedTicket.target.commitSeq + 1 },
      savedTicket.lease
    ),
    false
  );
  assert.equal(
    store.recoveryAuthorityCurrent(
      {
        ...savedTicket.target,
        checkpointIdentity: {
          ...savedTicket.target.checkpointIdentity,
          contentIdentity: 'different-checkpoint',
        },
      },
      savedTicket.lease
    ),
    false,
    'same sequence with a different checkpoint is not accepted'
  );
  assert.equal(
    store.recoveryAuthorityCurrent(savedTicket.target, {
      ...savedTicket.lease,
      generation: savedTicket.lease.generation + 1,
    }),
    false
  );
  assert.equal(store.recoveryAuthorityCurrent(savedTicket.target, { ...savedTicket.lease, expires_at: 0 }), false);
  const wrongTree = structuredClone(firstTree)!;
  wrongTree.nodes.find((node) => node.key === key)!.currentRun!.expectedGeneration++;
  assert.deepEqual(port.takeContinuation('synthetic-scope', wrongTree), { key: null }, 'binding change invalidates');
  assert.equal(port.takeContinuation('synthetic-scope', firstTree), null);
  assert.equal(port.readings.get(key).recoveryPending, true);
  // Restore only the fixture for the independent scope and successful-use controls.
  port.readings.get(key).recoveryPending = false;
  port.continuation = savedTicket;
  port.begin(performance.now() + 2000, 'other-scope');
  assert.equal(port.takeContinuation('other-scope', firstTree), null, 'scope change invalidates immediately');
  port.begin(performance.now() + 2000, 'synthetic-scope');
  assert.equal(port.takeContinuation('synthetic-scope', firstTree), null, 'scope ABA cannot revive a ticket');
  assert.equal(port.takeContinuation('other-scope', firstTree), null);
  port.readings.get(key).recoveryPending = false;
  port.continuation = savedTicket;
  port.begin(performance.now() + 2000, 'synthetic-scope');
  port.readings.get(key).rateTarget = undefined;
  assert.deepEqual(port.takeContinuation('synthetic-scope', firstTree), { key });
  await port.collect(f.child.ref, 'session', { ...budget, maxRecords: 2000, budgetMs: 0 }, true);
  assert.equal(port.takeContinuation('synthetic-scope', firstTree), null, 'refusal spends the ticket');
  // A later ordinary attempt that recovers the same target cannot manufacture another ticket.
  port.readings.get(key).recoveryPending = true;
  port.begin(performance.now() + 2000, 'synthetic-scope');
  port.readings.get(key).rateTarget = undefined;
  await port.collect(f.child.ref, 'session', budget);
  assert.equal(results[2]?.kind, 'recovered');
  assert.equal(port.takeContinuation('synthetic-scope', firstTree), null, 'same recovery cannot rearm');
  savedTicket = { ...savedTicket, checkpoint: port.readings.get(key).checkpoint };
  // The lease can expire after the first check; a priority attempt must never call claim().
  const publisher = port.readings.get(key).publisher;
  const leaseCheck = publisher.continuationLease.bind(publisher);
  const originalClaim = publisher.claim.bind(publisher);
  let leaseChecks = 0;
  let claimCalls = 0;
  publisher.continuationLease = (at: number) => (++leaseChecks === 1 ? leaseCheck(at) : null);
  publisher.claim = (at: number) => {
    claimCalls++;
    return originalClaim(at);
  };
  port.continuation = savedTicket;
  port.begin(performance.now() + 2000, 'synthetic-scope');
  assert.deepEqual(port.takeContinuation('synthetic-scope', firstTree), { key });
  await port.collect(f.child.ref, 'session', { ...budget, maxRecords: 2000 }, true);
  assert.equal(claimCalls, 0, 'priority never calls the renewing or reacquiring claim path');
  assert.equal(port.readings.get(key).recoveryPending, true);
  assert.equal(publisher.hasReading(), false, 'expired authority never captures a native result');
  assert.equal(port.takeContinuation('synthetic-scope', firstTree), null);
  // Expiry while native I/O is in flight also discards the result rather than publishing it.
  leaseChecks = 0;
  publisher.continuationLease = (at: number) => (++leaseChecks <= 2 ? leaseCheck(at) : null);
  port.readings.get(key).recoveryPending = false;
  port.continuation = savedTicket;
  port.begin(performance.now() + 2000, 'synthetic-scope');
  assert.deepEqual(port.takeContinuation('synthetic-scope', firstTree), { key });
  await port.collect(f.child.ref, 'session', { ...budget, maxRecords: 2000 }, true);
  assert.ok(leaseChecks >= 3, 'authority is rechecked after the native read');
  assert.equal(claimCalls, 0);
  assert.equal(publisher.hasReading(), false, 'an in-flight expiry cannot publish the result');
  assert.equal(port.readings.get(key).recoveryPending, true);
  assert.equal(port.takeContinuation('synthetic-scope', firstTree), null);
  publisher.continuationLease = leaseCheck;
  publisher.claim = originalClaim;
  port.readings.get(key).recoveryPending = false;
  // Reinsert the saved ticket bound to the equivalent fresh checkpoint only for the separate success control.
  port.continuation = savedTicket;
  port.begin(performance.now() + 2000, 'synthetic-scope');
  assert.deepEqual(port.takeContinuation('synthetic-scope', firstTree), { key });
  await port.collect(f.child.ref, 'session', { ...budget, maxRecords: 2000 }, true);
  assert.equal(results.length, 3, 'next ordinary grant uses the recovered checkpoint without refetching');
  assert.ok(
    port.readings.get(key).publisher?.hasReading(),
    `a real native capture followed recovery: ${nativeErrors.join(', ')}`
  );
  assert.equal(port.takeContinuation('synthetic-scope', firstTree), null, 'successful capture cannot rearm');
  port.readings.get(key).publisher.close();
  assert.equal(
    store.recoveryAuthorityCurrent(savedTicket.target, savedTicket.lease),
    false,
    'released authority fails closed'
  );
  // Reinsert only to model the lease being released after a ticket was issued.
  port.readings.get(key).checkpoint = savedTicket.checkpoint;
  port.continuation = savedTicket;
  port.begin(performance.now() + 2000, 'synthetic-scope');
  assert.deepEqual(port.takeContinuation('synthetic-scope', firstTree), { key });
  await port.collect(f.child.ref, 'session', { ...budget, maxRecords: 2000 }, true);
  assert.equal(port.readings.get(key).publisher.hasReading(), false);
  assert.equal(port.readings.get(key).recoveryPending, true);
  assert.equal(results.length, 3, 'lost authority does not refetch or capture under the ticket');
  assert.equal(port.takeContinuation('synthetic-scope', firstTree), null, 'lost authority consumes the ticket');
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
