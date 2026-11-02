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
