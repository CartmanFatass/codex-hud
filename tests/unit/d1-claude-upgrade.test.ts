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
import { openObservationStore, type ObservationStore } from '../../src/core/observation-store.js';
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
