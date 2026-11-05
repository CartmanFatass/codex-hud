import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  createClaudeReader,
  createClaudeReaderRebuild,
  type ClaudeReaderResult,
} from '../../src/harness/claude/reader.js';
import { openObservationStore, ObservationStore } from '../../src/core/observation-store.js';
import { HudDelegationCollector } from '../../src/collectors/delegation.js';
import { PublicationWorker } from '../../src/core/link/publication-worker.js';
import { makeSourceId, sessionRefKey } from '../../src/core/identity.js';
import { insertRecord } from '../../src/ledger/records.js';
import { notifyFixture } from './b21-fixture.js';
import { checkpointBoundary, checkpointFormat, witnessPreparedObservationBoundary } from '../../src/core/checkpoint.js';
import type { CollectLease } from '../../src/core/types/observation.js';
import { assistant, row, SESSION, TIME } from '../fixtures/claude/transcripts.js';

function candidate(store: ObservationStore, result: ClaudeReaderResult, lease: CollectLease, seq: number) {
  const cp = result.checkpoint;
  const stamp = {
    ref: cp.ref,
    sourceGeneration: cp.sourceGeneration,
    seqDomain: 'synthetic-d1-upgrade',
    commitSeq: seq,
    inputLedgerSeq: null,
  };
  const summary = structuredClone(result.observation);
  summary.statusProjection.observationStamp = stamp;
  const checkpoint = store.prepareCheckpoint({
    checkpoint: cp,
    boundary: checkpointBoundary(cp),
    format: checkpointFormat(cp),
    recoveryReferences: cp.recoveryIndex?.delta.base ? [cp.recoveryIndex.delta.base] : [],
  });
  return {
    checkpoint,
    previousCommitSeq: seq - 1,
    boundary: witnessPreparedObservationBoundary(checkpoint, summary, checkpointBoundary(cp)),
    commit: {
      ref: cp.ref,
      sourceGeneration: cp.sourceGeneration,
      leaseGeneration: lease.generation,
      seqDomain: stamp.seqDomain,
      commitSeq: seq,
      observationStamp: stamp,
      summary,
      continuity: {
        nodeIdentity: { kind: 'session' as const, ref: cp.ref },
        ruleVersion: 'synthetic-d1-rule',
        sourceGeneration: cp.sourceGeneration,
        episodeAnchor: null,
        stateKey: 'unknown',
        stateSince: null,
        stateSinceBasis: 'unknown' as const,
      },
      notices: [],
    },
  };
}

for (const emptyIdentity of [false, true])
  test(`D1 explicit v4-to-v5 rebuild is fenced and replayable (${emptyIdentity ? 'unopened' : 'opened'} v4 source)`, async (t) => {
    t.mock.method(performance, 'now', () => 0);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-claude-upgrade-'));
    const file = path.join(root, 'synthetic.jsonl');
    fs.writeFileSync(file, assistant() + '\n');
    const options = {
      ref: { harness: 'claude' as const, sourceId: 'e'.repeat(64), sessionId: SESSION, threadId: null },
      resolveFile: () => file,
      serverNames: ['hud'],
    };
    const store = await openObservationStore({
      hudHome: path.join(root, 'hud'),
      sourceId: options.ref.sourceId,
      now: () => TIME,
    });
    t.after(() => {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    // Before TodoWrite data exists, this is the unchanged v4 schema and index namespace set.
    const legacy = await createClaudeReader(options).read(
      emptyIdentity ? { maxBytes: 0, maxRecords: 0, budgetMs: 0 } : undefined
    );
    legacy.checkpoint.readerVersion = 'claude-reader-4';
    const lease = store.acquire(options.ref, 'synthetic-v4');
    store.publishPrepared(candidate(store, legacy, lease, 1), lease);
    const prior = store.readProjection(options.ref)!;
    assert.throws(
      () => createClaudeReader(options, store.readCurrent(options.ref)!.checkpoint),
      /unsupported_claude_checkpoint/
    );

    const rebuilt = createClaudeReaderRebuild(prior.checkpointIdentity, TIME + 1000);
    assert.equal(rebuilt.checkpoint.readerVersion, 'claude-reader-5');
    assert.equal(rebuilt.checkpoint.sourceGeneration, prior.sourceGeneration + 1);
    assert.equal(rebuilt.checkpoint.offset, 0);
    assert.deepEqual(rebuilt.checkpoint.recoveryIndex!.delta, {
      recoveryVersion: 'claude-recovery-1',
      base: null,
      entries: [],
    });
    assert.deepEqual(rebuilt.stats, { bytesRead: 0, recordsRead: 0, elapsedMs: 0 });
    assert.equal(rebuilt.evidence.progress, undefined);
    assert.equal(rebuilt.observation.coverage.state, 'catching_up');
    const pending = candidate(store, rebuilt, lease, 2);
    assert.throws(() => store.publishPrepared(pending, lease), /observation_rebuild_required/);
    assert.throws(
      () =>
        store.publishPrepared(
          { ...candidate(store, rebuilt, lease, 3), rebuildFromReaderVersion: 'claude-reader-4' },
          lease
        ),
      /observation_commit_conflict/
    );
    store.release(options.ref, lease);
    const fresh = store.acquire(options.ref, 'synthetic-v5');
    assert.throws(
      () => store.publishPrepared({ ...pending, rebuildFromReaderVersion: 'claude-reader-4' }, lease),
      /collect_lease_.*|observation_lease_.*|lease_.*|observation_fenced/
    );
    const accepted = candidate(store, rebuilt, fresh, 2);
    store.publishPrepared({ ...accepted, rebuildFromReaderVersion: 'claude-reader-4' }, fresh);
    assert.equal(store.readHead(options.ref)?.readerVersion, 'claude-reader-5');

    fs.appendFileSync(
      file,
      [
        row(
          'assistant',
          {
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'synthetic-todo',
                  name: 'TodoWrite',
                  input: { todos: [{ content: 'Synthetic task', status: 'in_progress' }] },
                },
              ],
            },
          },
          3000
        ),
        row(
          'user',
          {
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'synthetic-todo', content: 'Synthetic success' }],
            },
          },
          4000
        ),
      ].join('\n') + '\n'
    );
    const restored = createClaudeReader(options, store.readCurrent(options.ref)!.checkpoint);
    const first = await restored.read({ maxBytes: 4096, maxRecords: 1, budgetMs: 20 });
    assert.equal(first.checkpoint.sourceGeneration, rebuilt.checkpoint.sourceGeneration + (emptyIdentity ? 1 : 0));
    assert.equal(first.observation.coverage.state, 'catching_up');
    assert.equal(first.evidence.progress, undefined);
    let complete = first;
    while (complete.observation.coverage.state === 'catching_up')
      complete = await restored.read({ maxBytes: 4096, maxRecords: 1, budgetMs: 20 });
    assert.deepEqual(complete.evidence.progress?.value, { done: 0, total: 1, current: 'Synthetic task' });
    store.publishPrepared(candidate(store, complete, fresh, 3), fresh);
    const persisted = await createClaudeReader(options, store.readCurrent(options.ref)!.checkpoint).read();
    assert.deepEqual(persisted.evidence.progress, complete.evidence.progress);
    assert.equal(persisted.stats!.bytesRead, 0);

    store.release(options.ref, fresh);
    const oldLease = store.acquire(options.ref, 'synthetic-v4-restarted');
    const downgrade = await createClaudeReader(options).read();
    downgrade.checkpoint.readerVersion = 'claude-reader-4';
    downgrade.checkpoint.sourceGeneration = complete.checkpoint.sourceGeneration + 1;
    assert.throws(
      () => store.publishPrepared(candidate(store, downgrade, oldLease, 4), oldLease),
      /observation_reader_retired/
    );
    assert.equal(store.readHead(options.ref)?.commitSeq, 3);
  });

test('D1 rebuild refuses unrelated versions, non-Claude identities and exhausted source generations', () => {
  const previous = {
    ref: { harness: 'claude' as const, sourceId: 'e'.repeat(64), sessionId: SESSION, threadId: null },
    readerVersion: 'claude-reader-4',
    sourceGeneration: 1,
    fileId: { dev: 1, inode: 2 },
  };
  assert.throws(
    () => createClaudeReaderRebuild({ ...previous, readerVersion: 'claude-reader-3' }),
    /unsupported_claude_rebuild/
  );
  assert.throws(
    () => createClaudeReaderRebuild({ ...previous, sourceGeneration: Number.MAX_SAFE_INTEGER }),
    /unsupported_claude_rebuild/
  );
  assert.throws(
    () => createClaudeReaderRebuild({ ...previous, ref: { ...previous.ref, harness: 'codex' } }),
    /unsupported_claude_rebuild/
  );
});

async function persistedUpgrade(t: test.TestContext) {
  const f = await notifyFixture();
  const root = path.join(f.root, 'synthetic-claude');
  const project = path.join(root, 'projects', 'synthetic-project');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, `${SESSION}.jsonl`);
  fs.writeFileSync(file, assistant() + '\n');
  const ref = {
    harness: 'claude' as const,
    sourceId: makeSourceId('claude', root),
    sessionId: SESSION,
    threadId: null,
  };
  fs.writeFileSync(
    path.join(f.root, 'delegate.json'),
    JSON.stringify({
      version: 1,
      profiles: [
        {
          name: 'synthetic-upgrade',
          harness: 'claude',
          source: { root, label: 'Synthetic' },
          env: {},
          mcpServerName: 'hud',
        },
      ],
    })
  );
  await f.ledger.transaction((tx) => {
    insertRecord(tx, 'sources', { sourceId: ref.sourceId, harness: 'claude', rootPath: root, label: 'Synthetic' });
    tx.run(
      'INSERT INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
      sessionRefKey(ref),
      ref.harness,
      ref.sourceId,
      ref.sessionId,
      ''
    );
    insertRecord(tx, 'links', { ...f.input.link, linkId: 'synthetic-upgrade-link', parentRef: ref });
  });
  const store = await openObservationStore({ hudHome: f.root, sourceId: ref.sourceId });
  t.after(async () => {
    store.close();
    await f.close();
  });
  const options = { ref, resolveFile: () => file, serverNames: ['hud'] };
  const legacy = await createClaudeReader(options).read();
  // No TodoWrite state exists in this snapshot; this is the unchanged v4 schema.
  legacy.checkpoint.readerVersion = 'claude-reader-4';
  const lease = store.acquire(ref, 'synthetic-legacy-writer');
  store.publishPrepared(candidate(store, legacy, lease, 1), lease);
  store.release(ref, lease);
  const original = store.readProjection(ref)!;
  const todo = [
    row(
      'assistant',
      {
        uuid: 'synthetic-todo-call',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'synthetic-todo',
              name: 'TodoWrite',
              input: { todos: [{ content: 'Synthetic replay task', status: 'in_progress' }] },
            },
          ],
        },
      },
      3000
    ),
    row(
      'user',
      {
        uuid: 'synthetic-todo-result',
        message: { content: [{ type: 'tool_result', tool_use_id: 'synthetic-todo', content: 'Synthetic success' }] },
      },
      4000
    ),
  ];
  fs.appendFileSync(
    file,
    [
      ...Array.from({ length: 2100 }, (_, i) =>
        row(
          'user',
          {
            uuid: `synthetic-replay-${i}`,
            message: { content: 'Synthetic replay history' },
          },
          2000
        )
      ),
      ...todo,
    ].join('\n') + '\n'
  );
  return { ...f, ref, store, original, options, legacy };
}

test('D1 default collector publishes one fenced rebuild before budgeted replay and retries a refused boundary', async (t) => {
  t.mock.method(performance, 'now', () => 0);
  const f = await persistedUpgrade(t);
  const runtime = await HudDelegationCollector.open({ HUD_HOME: f.root }, undefined, {
    publish: true,
    boundedWorker: true,
  });
  assert.ok(runtime);
  t.after(() => runtime.close());
  let attempts = 0;
  let refused = false;
  const originalRecovery = ObservationStore.prototype.readRecoveryMetered;
  t.mock.method(
    ObservationStore.prototype,
    'readRecoveryMetered',
    function (this: ObservationStore, ...args: Parameters<ObservationStore['readRecoveryMetered']>) {
      assert.notEqual(args[0].checkpointIdentity.readerVersion, 'claude-reader-4', 'old index is never recovered');
      return originalRecovery.apply(this, args);
    }
  );
  const originalPublish = ObservationStore.prototype.publishPrepared;
  t.mock.method(
    ObservationStore.prototype,
    'publishPrepared',
    function (this: ObservationStore, ...args: Parameters<ObservationStore['publishPrepared']>) {
      if (args[0].commit.ref.sourceId === f.ref.sourceId) {
        attempts++;
        if (args[0].rebuildFromReaderVersion && !refused) {
          refused = true;
          throw new Error('synthetic_rebuild_busy');
        }
      }
      return originalPublish.apply(this, args);
    }
  );
  let rebuilt = false;
  let partial = false;
  for (let i = 0; i < 80; i++) {
    const before = attempts;
    const oldHead = f.store.readHead(f.ref)!;
    await runtime.tick(undefined, undefined, 64 * 1024);
    assert.ok(runtime.collector.stats().bytesRead <= 64 * 1024);
    assert.ok(runtime.collector.stats().recordsRead <= 2000);
    assert.equal(f.store.readHead(f.ref)!.commitSeq, oldHead.commitSeq, 'collection itself never publishes');
    await runtime.afterPaint(() => {});
    assert.ok(attempts - before <= 1, 'one publication attempt per operation');
    await runtime.afterPaint(() => assert.fail('second publication tail'));
    assert.ok(attempts - before <= 1);
    const current = f.store.readCurrent(f.ref)!;
    if (runtime.publicationStats().error === 'synthetic_rebuild_busy') {
      assert.equal(current.checkpoint.readerVersion, 'claude-reader-4');
      assert.equal(current.commitSeq, 1);
      assert.equal(runtime.hasPendingPublication(), true);
      continue;
    }
    assert.equal(runtime.publicationStats().error, null);
    if (current.checkpoint.readerVersion !== 'claude-reader-5') continue;
    if (!rebuilt) {
      rebuilt = true;
      assert.equal(current.commitSeq, 2);
      assert.equal(current.checkpoint.offset, 0, 'migration is a separate empty boundary');
      assert.equal(current.sourceGeneration, f.original.sourceGeneration + 1);
      assert.equal(current.summary.coverage.state, 'catching_up');
      assert.deepEqual(current.summary.coverage.gaps, ['reader_version_rebuild']);
      assert.equal(current.continuity.stateSince, null);
      assert.equal(current.continuity.episodeAnchor, null);
      assert.deepEqual(current.notices, []);
      assert.notEqual(
        f.store.readProjection(f.ref)!.checkpointIdentity.recoveryReferences[0]?.indexId,
        f.original.checkpointIdentity.recoveryReferences[0]?.indexId
      );
      continue;
    }
    if (current.checkpoint.offset > 0 && current.summary.coverage.state === 'catching_up') partial = true;
    if (current.summary.coverage.state === 'complete') break;
  }
  assert.ok(refused && rebuilt && partial);
  const final = f.store.readCurrent(f.ref)!;
  assert.equal(final.summary.coverage.state, 'complete');
  const replayed = await createClaudeReader(f.options, final.checkpoint).read();
  assert.deepEqual(replayed.evidence.progress?.value, { done: 0, total: 1, current: 'Synthetic replay task' });
  assert.equal(replayed.stats!.bytesRead, 0);
  assert.equal(runtime.close(), true);
  const oldLease = f.store.acquire(f.ref, 'synthetic-retired-writer');
  f.legacy.checkpoint.sourceGeneration = final.sourceGeneration + 1;
  assert.throws(
    () => f.store.publishPrepared(candidate(f.store, f.legacy, oldLease, final.commitSeq + 1), oldLease),
    /observation_reader_retired/
  );
  f.store.release(f.ref, oldLease);
});

test('D1 real default publication worker upgrades persisted v4 and replays TodoWrite', async (t) => {
  const f = await persistedUpgrade(t);
  const panel = await HudDelegationCollector.open({ HUD_HOME: f.root });
  assert.ok(panel);
  t.after(() => panel.close());
  await panel.tick(undefined);
  await panel.afterPaint(() => assert.fail('read-only panel cannot publish'));
  assert.equal(f.store.readHead(f.ref)!.readerVersion, 'claude-reader-4');
  assert.equal(f.store.readHead(f.ref)!.commitSeq, 1);
  let settle: ((error: string | null) => void) | undefined;
  const worker = new PublicationWorker(f.root, undefined, (_changed, error) => settle?.(error));
  t.after(() => worker.close());
  let sawBoundary = false;
  let complete = false;
  for (let i = 0; i < 80 && !complete; i++) {
    const before = f.store.readHead(f.ref)!.commitSeq;
    const error = await new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('synthetic_upgrade_worker_timeout')), 5000);
      settle = (error) => {
        clearTimeout(timer);
        settle = undefined;
        resolve(error);
      };
      worker.request();
    });
    assert.equal(error, null);
    const current = f.store.readCurrent(f.ref)!;
    assert.ok(current.commitSeq - before <= 1);
    if (current.checkpoint.readerVersion === 'claude-reader-5' && current.checkpoint.offset === 0) {
      sawBoundary = true;
      assert.equal(current.summary.coverage.state, 'catching_up');
      assert.equal(current.sourceGeneration, f.original.sourceGeneration + 1);
    }
    complete = current.checkpoint.readerVersion === 'claude-reader-5' && current.summary.coverage.state === 'complete';
  }
  assert.ok(sawBoundary && complete, 'worker publishes the empty upgrade boundary then finishes replay');
  assert.equal(await worker.close(), true);
  await panel.tick(undefined);
  const published = f.store.readProjection(f.ref)!;
  assert.equal(published.checkpointIdentity.readerVersion, 'claude-reader-5');
  const result = await createClaudeReader(f.options, f.store.readCurrent(f.ref)!.checkpoint).read();
  assert.deepEqual(result.evidence.progress?.value, { done: 0, total: 1, current: 'Synthetic replay task' });
  assert.equal(f.store.readLease(f.ref), null);
});
