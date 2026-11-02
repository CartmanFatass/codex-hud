import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openObservationStore } from '../../src/core/observation-store.js';
import {
  checkpointBoundary,
  checkpointFormat,
  witnessPreparedObservationBoundary,
  RecoveryIndexOverlay,
  attachRecoveryIndex,
} from '../../src/core/checkpoint.js';
import { initialParserState, projectFreshness } from '../../src/core/observation.js';
import type { SessionRef } from '../../src/core/types/identity.js';
import type { ObservationCommit } from '../../src/core/types/observation.js';
import type { PreparedCheckpoint, ObservationRecovery } from '../../src/core/types/checkpoint.js';
const [major, minor] = process.versions.node.split('.').map(Number);
const supported = (major === 22 && minor >= 13) || major >= 24;
const skip = supported ? false : 'observation SQLite requires Node 22.x >=22.13 or >=24';
const NOW = 1_700_000_000_000;
const REF: SessionRef = { harness: 'codex', sourceId: 'e'.repeat(64), sessionId: 'synthetic-session', threadId: null };

function commit(seq = 1, generation = 1): ObservationCommit {
  const stamp = {
    ref: REF,
    sourceGeneration: 1,
    seqDomain: 'synthetic-observation',
    commitSeq: seq,
    inputLedgerSeq: null,
  };
  return {
    ref: REF,
    sourceGeneration: 1,
    leaseGeneration: generation,
    seqDomain: stamp.seqDomain,
    commitSeq: seq,
    observationStamp: stamp,
    checkpoint: {
      schemaVersion: 1,
      readerVersion: 'synthetic-reader-1',
      ref: REF,
      fileId: { dev: 1, inode: 2 },
      offset: seq * 10,
      sourceGeneration: 1,
      parserState: initialParserState(),
    },
    summary: {
      nodeIdentity: { kind: 'session', ref: REF },
      statusProjection: {
        activity: 'working',
        pendingReason: 'none',
        lastTurnOutcome: 'none',
        liveness: 'alive',
        freshness: projectFreshness([], [], NOW),
        stateKey: 'working',
        stateSince: NOW,
        stateSinceBasis: 'event',
        isRunTerminal: null,
        asOfSeq: null,
        observationStamp: stamp,
        asOf: NOW,
        observedAt: NOW,
        lastEvidenceAt: NOW,
      },
      conflict: null,
      spent: {
        tokens: { value: { input: seq, output: 0 }, quality: 'reported', source: 'synthetic', asOf: NOW },
        costUsd: { value: null, quality: 'unknown', source: 'synthetic', asOf: NOW },
      },
      workspace: null,
      coverage: { state: 'complete', skipped: {}, gaps: [], loaded: true },
      loaded: true,
      depth: 0,
      evidenceStamp: `synthetic-${seq}`,
    },
    continuity: {
      nodeIdentity: { kind: 'session', ref: REF },
      ruleVersion: 'synthetic-rule-1',
      sourceGeneration: 1,
      episodeAnchor: 'synthetic-turn',
      stateKey: 'working',
      stateSince: NOW,
      stateSinceBasis: 'event',
    },
    notices: [
      { seq, seqDomain: stamp.seqDomain, created_at: NOW, ref: REF, kind: 'pending', inputStamp: `synthetic-${seq}` },
    ],
  };
}
const BUDGET = { maxBytes: 256 * 1024, maxRecords: 2000, budgetMs: 20 };
function preparedCandidate(c: ObservationCommit, checkpoint: PreparedCheckpoint) {
  const { checkpoint: _checkpoint, ...projection } = c;
  return {
    commit: projection,
    checkpoint,
    previousCommitSeq: c.commitSeq - 1,
    boundary: witnessPreparedObservationBoundary(checkpoint, c.summary, checkpointBoundary(c.checkpoint)),
  };
}
async function setup(t: import('node:test').TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b12r-store-'));
  let now = NOW;
  const store = await openObservationStore({ hudHome: root, sourceId: REF.sourceId, now: () => now });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const lease = store.acquire(REF, 'synthetic-reader');
  const prepare = (c: ObservationCommit) =>
    store.prepareCheckpoint({
      checkpoint: c.checkpoint,
      boundary: checkpointBoundary(c.checkpoint),
      format: checkpointFormat(c.checkpoint),
      recoveryReferences: c.checkpoint.recoveryIndex?.delta.base ? [c.checkpoint.recoveryIndex.delta.base] : [],
    });
  return {
    root,
    store,
    lease,
    prepare,
    advance: (value: number) => {
      now = value;
    },
  };
}

test(
  'B12R immutable checkpoint reused for summary edges; projection reads never select recovery body',
  { skip },
  async (t) => {
    const f = await setup(t);
    const c = commit();
    const token = f.prepare(c);
    assert.equal(f.store.publishPrepared(preparedCandidate(c, token), f.lease).changed, true);
    const first = f.store.readProjection(REF)!;
    assert.equal('checkpoint' in first, false);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(f.store.databasePath);
    t.after(() => db.close());
    assert.equal(db.prepare('SELECT count(*) AS n FROM checkpoint_blobs').get()!.n, 1);
    // A corrupt blob cannot affect the projection-only path, and is refused by recovery.
    const body = db.prepare('SELECT body FROM checkpoint_blobs').get()!.body;
    db.prepare('UPDATE checkpoint_blobs SET body=?').run('{"corrupt":true}');
    assert.deepEqual(f.store.readProjection(REF), first);
    assert.throws(() => f.store.readRecovery(first, BUDGET));
    db.prepare('UPDATE checkpoint_blobs SET body=?').run(body!);
    const edge = structuredClone(c);
    edge.commitSeq = 2;
    edge.observationStamp.commitSeq = 2;
    edge.summary.evidenceStamp = 'freshness-edge';
    edge.summary.statusProjection.observationStamp = edge.observationStamp;
    assert.equal(f.store.publishPrepared(preparedCandidate(edge, token), f.lease).changed, true);
    assert.equal(db.prepare('SELECT count(*) AS n FROM checkpoint_blobs').get()!.n, 1);
    assert.equal(
      f.store.readProjection(REF)!.checkpointIdentity.contentIdentity,
      first.checkpointIdentity.contentIdentity
    );
    assert.equal(f.store.readRecovery(first, BUDGET), null);
    const repeat = structuredClone(edge);
    repeat.commitSeq = 3;
    repeat.observationStamp.commitSeq = 3;
    repeat.summary.statusProjection.observationStamp = repeat.observationStamp;
    const candidate = preparedCandidate(repeat, token);
    assert.deepEqual(f.store.publishPrepared(candidate, f.lease), { changed: false, commitSeq: 2, bytes: 0 });
    f.advance(NOW + 15_000);
    assert.throws(() => f.store.publishPrepared(candidate, f.lease), /lease_expired/);
    assert.equal(f.store.readProjection(REF)!.commitSeq, 2);
  }
);

test(
  'B12R exact indexed snapshots, bounded lookup and acknowledgement preserve history without inline growth',
  { skip },
  async (t) => {
    const f = await setup(t);
    const overlay = new RecoveryIndexOverlay('synthetic-index-1');
    for (let n = 0; n < 5000; n++) overlay.set('synthetic.ids', String(n).padStart(5, '0'), JSON.stringify(n));
    const c = commit();
    attachRecoveryIndex(c.checkpoint, overlay);
    const token = f.prepare(c);
    assert.ok(Buffer.byteLength(JSON.stringify({ ...c.checkpoint, recoveryIndex: undefined })) < 256 * 1024);
    f.store.publishPrepared(preparedCandidate(c, token), f.lease);
    assert.equal(overlay.snapshot().delta.entries.length, 0);
    const first = f.store.readProjection(REF)!;
    const restored = f.store.readRecovery(first, BUDGET) as ObservationRecovery;
    const lookup = restored.checkpoint.recoveryIndex!.lookup!;
    assert.equal(lookup.get('synthetic.ids', '00001'), '1');
    assert.equal(lookup.page('synthetic.ids', null, 3).length, 3);
    assert.throws(() => lookup.page('synthetic.ids', null, 257), /invalid_recovery_budget/);
    overlay.set('synthetic.ids', '00001', '10001');
    overlay.delete('synthetic.ids', '00002');
    const next = commit(2);
    attachRecoveryIndex(next.checkpoint, overlay);
    const prepared = f.prepare(next);
    assert.equal(next.checkpoint.recoveryIndex!.delta.entries.length, 2);
    f.store.publishPrepared(preparedCandidate(next, prepared), f.lease);
    assert.equal(lookup.get('synthetic.ids', '00001'), '1');
    assert.equal(lookup.get('synthetic.ids', '00002'), '2');
    const current = f.store.readProjection(REF)!;
    const newLookup = (f.store.readRecovery(current, BUDGET) as ObservationRecovery).checkpoint.recoveryIndex!.lookup!;
    assert.equal(newLookup.get('synthetic.ids', '00001'), '10001');
    assert.equal(newLookup.get('synthetic.ids', '00002'), undefined);
    const progress = f.store.readRecovery(current, { ...BUDGET, budgetMs: 0 });
    assert.ok(progress && 'kind' in progress && progress.kind === 'recovery_catching_up');
    const tooSmall = f.store.readRecovery(current, { ...BUDGET, maxBytes: 1 });
    assert.ok(tooSmall && 'kind' in tooSmall && tooSmall.kind === 'record_needs_larger_slice');
    const wrong = { ...current, checkpointIdentity: { ...current.checkpointIdentity, offset: 999 } };
    assert.throws(() => f.store.readRecovery(wrong, BUDGET), /invalid_recovery_reference/);
  }
);

test(
  'B12R preparation detaches mutable input and rejects forged tokens, wrong formats, oversize and stale CAS',
  { skip },
  async (t) => {
    const f = await setup(t);
    const c = commit();
    const token = f.prepare(c);
    c.checkpoint.offset = 999;
    const correct = commit();
    f.store.publishPrepared(preparedCandidate(correct, token), f.lease);
    const fake = { identity: token.identity } as unknown as PreparedCheckpoint;
    assert.throws(
      () => f.store.publishPrepared(preparedCandidate(commit(2), fake), f.lease),
      /invalid_prepared_checkpoint/
    );
    assert.throws(
      () => f.store.publishPrepared(preparedCandidate(correct, token), f.lease),
      /observation_commit_conflict/
    );
    assert.throws(
      () =>
        f.store.prepareCheckpoint({
          checkpoint: correct.checkpoint,
          boundary: checkpointBoundary(correct.checkpoint),
          format: { name: 'reader-json', version: 99, runtime: null },
          recoveryReferences: [],
        }),
      /observation_boundary_mismatch/
    );
    correct.checkpoint.parserState.gaps.push('x'.repeat(256 * 1024));
    assert.throws(
      () => f.prepare(correct),
      (error: unknown) => {
        assert.ok(error instanceof Error && error.message === 'checkpoint_state_oversize');
        assert.deepEqual((error as Error & { coverage: { gaps: string[] } }).coverage.gaps, [
          'checkpoint_state_oversize',
        ]);
        return true;
      }
    );
    assert.equal(f.store.readProjection(REF)!.commitSeq, 1);
  }
);

test(
  'B12R stale index base cannot branch through a newer source generation or mutate a pinned snapshot',
  { skip },
  async (t) => {
    const f = await setup(t);
    const overlay = new RecoveryIndexOverlay('synthetic-index-1');
    overlay.set('synthetic.ids', 'a', '1');
    const first = commit();
    attachRecoveryIndex(first.checkpoint, overlay);
    f.store.publishPrepared(preparedCandidate(first, f.prepare(first)), f.lease);
    const old = f.store.readRecovery(f.store.readProjection(REF)!, BUDGET) as ObservationRecovery;
    const stale = new RecoveryIndexOverlay('synthetic-index-1', old.checkpoint.recoveryIndex);
    overlay.set('synthetic.ids', 'b', '2');
    const second = commit(2);
    attachRecoveryIndex(second.checkpoint, overlay);
    f.store.publishPrepared(preparedCandidate(second, f.prepare(second)), f.lease);
    const pinned = (f.store.readRecovery(f.store.readProjection(REF)!, BUDGET) as ObservationRecovery).checkpoint
      .recoveryIndex!.lookup!;
    stale.set('synthetic.ids', 'c', '3');
    const next = commit(3);
    next.sourceGeneration =
      next.checkpoint.sourceGeneration =
      next.continuity.sourceGeneration =
      next.observationStamp.sourceGeneration =
        2;
    attachRecoveryIndex(next.checkpoint, stale);
    assert.throws(
      () => f.store.publishPrepared(preparedCandidate(next, f.prepare(next)), f.lease),
      /recovery_base_conflict/
    );
    assert.equal(pinned.get('synthetic.ids', 'c'), undefined);
    assert.equal(pinned.get('synthetic.ids', 'b'), '2');
    assert.equal(f.store.readProjection(REF)!.commitSeq, 2);
  }
);

test(
  'B12R publication uses only detached CAS values and acknowledgements cannot lose newer reader changes',
  { skip },
  async (t) => {
    const f = await setup(t);
    const index = new RecoveryIndexOverlay('synthetic-index-1');
    index.set('synthetic.ids', 'a', '1');
    const c = commit();
    attachRecoveryIndex(c.checkpoint, index);
    const token = f.prepare(c);
    index.set('synthetic.ids', 'a', '2');
    assert.throws(() => {
      (c.checkpoint.recoveryIndex!.delta.entries[0] as { value: string }).value = '2';
    }, TypeError);
    f.store.publishPrepared(preparedCandidate(c, token), f.lease);
    assert.equal(index.get('synthetic.ids', 'a'), '2');
    assert.equal(index.snapshot().delta.entries.length, 1);
    const edge = commit(2);
    edge.checkpoint = c.checkpoint;
    f.store.publishPrepared(preparedCandidate(edge, token), f.lease);
    let reads = 0;
    const malicious = preparedCandidate(c, token);
    Object.defineProperty(malicious, 'previousCommitSeq', { get: () => (reads++ === 0 ? 0 : 2) });
    assert.throws(() => f.store.publishPrepared(malicious, f.lease), /observation_commit_conflict/);
    assert.equal(f.store.readProjection(REF)!.commitSeq, 2);
    const missing = commit(3);
    missing.checkpoint.offset = c.checkpoint.offset;
    assert.throws(
      () => f.store.publishPrepared(preparedCandidate(missing, f.prepare(missing)), f.lease),
      /recovery_base_conflict/
    );
  }
);

test(
  'B12R schema-v1 upgrade fences a pre-opened old writer; leased rebuild erases old raw cache',
  { skip },
  async (t) => {
    const f = await setup(t);
    const c = commit();
    f.store.publishPrepared(preparedCandidate(c, f.prepare(c)), f.lease);
    f.store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const old = new DatabaseSync(path.join(f.root, 'sources', REF.sourceId, 'observation.sqlite'));
    t.after(() => old.close());
    old.exec(`DROP TABLE observation_current; DROP TABLE observation_legacy; DROP TABLE checkpoint_blobs;
    DROP TABLE recovery_indexes; DROP TABLE recovery_entries;
    CREATE TABLE observation_current (ref TEXT PRIMARY KEY, commit_seq INTEGER NOT NULL, source_generation INTEGER NOT NULL,
      reader_version TEXT NOT NULL, seq_domain TEXT NOT NULL, content_digest TEXT NOT NULL, body TEXT NOT NULL,
      file_id TEXT NOT NULL, checkpoint_offset INTEGER NOT NULL) STRICT; PRAGMA user_version=1`);
    const sentinel = 'SYNTHETIC_LEGACY_RAW_RECOVERY';
    c.checkpoint.parserState.pendingBytes = [...Buffer.from(sentinel)];
    const { sessionRefKey } = await import('../../src/core/identity.js');
    old
      .prepare('INSERT INTO observation_current VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        sessionRefKey(REF),
        1,
        1,
        c.checkpoint.readerVersion,
        c.seqDomain,
        'legacy-digest',
        JSON.stringify(c),
        JSON.stringify(c.checkpoint.fileId),
        c.checkpoint.offset
      );
    const oldWriter = old.prepare('INSERT OR REPLACE INTO observation_current VALUES(?,?,?,?,?,?,?,?,?)');
    const modern = await openObservationStore({ hudHome: f.root, sourceId: REF.sourceId, now: () => NOW + 15_000 });
    t.after(() => modern.close());
    assert.equal(old.prepare('PRAGMA user_version').get()!.user_version, 2);
    assert.throws(() =>
      oldWriter.run(sessionRefKey(REF), 2, 1, 'synthetic-reader-1', c.seqDomain, 'legacy', '{}', '{}', 10)
    );
    assert.equal(modern.readProjection(REF), null);
    assert.throws(() => modern.readCurrent(REF), /raw_tail_refused/);
    assert.equal(modern.readHead(REF)!.readerVersion, 'synthetic-reader-1');
    const lease = modern.acquire(REF, 'new-reader');
    const rebuilt = commit(2, lease.generation);
    rebuilt.sourceGeneration =
      rebuilt.checkpoint.sourceGeneration =
      rebuilt.continuity.sourceGeneration =
      rebuilt.observationStamp.sourceGeneration =
        2;
    rebuilt.checkpoint.readerVersion = 'synthetic-reader-2';
    rebuilt.checkpoint.offset = 0;
    rebuilt.continuity.stateSince = rebuilt.summary.statusProjection.stateSince = null;
    rebuilt.continuity.stateSinceBasis = rebuilt.summary.statusProjection.stateSinceBasis = 'unknown';
    rebuilt.continuity.episodeAnchor = null;
    rebuilt.notices = [];
    rebuilt.summary.coverage = { state: 'partial', gaps: ['reader_version_rebuild'], skipped: {}, loaded: true };
    const token = modern.prepareCheckpoint({
      checkpoint: rebuilt.checkpoint,
      boundary: checkpointBoundary(rebuilt.checkpoint),
      format: checkpointFormat(rebuilt.checkpoint),
      recoveryReferences: [],
    });
    modern.publishPrepared(
      { ...preparedCandidate(rebuilt, token), rebuildFromReaderVersion: 'synthetic-reader-1' },
      lease
    );
    assert.equal(modern.readProjection(REF)!.sourceGeneration, 2);
    assert.equal(old.prepare('SELECT count(*) AS n FROM observation_legacy').get()!.n, 0);
    assert.equal(fs.readFileSync(modern.databasePath).includes(Buffer.from(sentinel)), false);
  }
);

test(
  'B12R indexed publication crash cuts retain an entire old or new projection/recovery/index commit',
  { skip, timeout: 15_000 },
  async (t) => {
    const { fork } = await import('node:child_process');
    const { witnessObservationBoundary } = await import('../../src/core/checkpoint.js');
    for (const cut of ['before_commit', 'after_commit']) {
      const f = await setup(t);
      const overlay = new RecoveryIndexOverlay('synthetic-index-1');
      overlay.set('synthetic.ids', 'a', '1');
      const c = commit();
      attachRecoveryIndex(c.checkpoint, overlay);
      f.store.publishPrepared(preparedCandidate(c, f.prepare(c)), f.lease);
      const first = f.store.readProjection(REF)!;
      f.store.release(REF, f.lease);
      const child = fork(path.resolve('tests/int/b12r-process.mjs'), [], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await once(child, 'exit');
        }
      });
      let id = 0;
      const rpc = (op: string, fields: Record<string, unknown> = {}) =>
        new Promise<any>((resolve, reject) => {
          const requestId = ++id;
          const handler = (message: any) => {
            if (message.id !== requestId) return;
            child.off('message', handler);
            if (message.error) reject(new Error(message.error));
            else resolve(message.result);
          };
          child.on('message', handler);
          child.send({ id: requestId, op, ...fields });
        });
      await rpc('open', { options: { hudHome: f.root, sourceId: REF.sourceId }, now: NOW });
      const lease = await rpc('acquire', { ref: REF, holder: 'crash-reader' });
      const next = commit(2, lease.generation);
      next.checkpoint.recoveryIndex = {
        delta: {
          recoveryVersion: 'synthetic-index-1',
          base: first.checkpointIdentity.recoveryReferences[0],
          entries: [
            { namespace: 'synthetic.ids', key: 'a', value: '2' },
            { namespace: 'synthetic.ids', key: 'b', value: '3' },
          ],
        },
      };
      const reached = new Promise<void>((resolve) => {
        child.on('message', (m: any) => {
          if (m.point === cut) resolve();
        });
      });
      child.send({
        id: ++id,
        op: 'publish',
        crash: cut,
        lease,
        candidate: {
          commit: next,
          previousCommitSeq: 1,
          boundary: witnessObservationBoundary(next.checkpoint, next.summary, checkpointBoundary(next.checkpoint)),
        },
      });
      await reached;
      child.kill('SIGKILL');
      await once(child, 'exit');
      const projection = f.store.readProjection(REF)!;
      assert.equal(projection.commitSeq, cut === 'before_commit' ? 1 : 2);
      const recovery = f.store.readRecovery(projection, BUDGET) as ObservationRecovery;
      assert.equal(recovery.target.commitSeq, projection.commitSeq);
      assert.equal(recovery.checkpoint.offset, projection.commitSeq * 10);
      assert.equal(recovery.checkpoint.recoveryIndex!.lookup!.get('synthetic.ids', 'a'), String(projection.commitSeq));
      assert.equal(
        recovery.checkpoint.recoveryIndex!.lookup!.get('synthetic.ids', 'b'),
        cut === 'before_commit' ? undefined : '3'
      );
      assert.deepEqual(f.store.readProjection(REF)!.notices, projection.notices);
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(f.store.databasePath);
      assert.equal(db.prepare('SELECT count(*) AS n FROM checkpoint_blobs').get()!.n, 1);
      db.close();
    }
  }
);

test('B12R standalone preparation cannot relabel an inherited index recovery version', { skip }, async (t) => {
  const f = await setup(t);
  const index = new RecoveryIndexOverlay('synthetic-index-1');
  index.set('synthetic.ids', 'a', '1');
  const c = commit();
  attachRecoveryIndex(c.checkpoint, index);
  f.store.publishPrepared(preparedCandidate(c, f.prepare(c)), f.lease);
  const base = f.store.readProjection(REF)!.checkpointIdentity.recoveryReferences[0];
  const next = commit(2);
  next.checkpoint.recoveryIndex = { delta: { recoveryVersion: 'synthetic-index-2', base, entries: [] } };
  const { prepareCheckpoint } = await import('../../src/core/checkpoint.js');
  assert.throws(
    () =>
      prepareCheckpoint({
        checkpoint: next.checkpoint,
        boundary: checkpointBoundary(next.checkpoint),
        format: checkpointFormat(next.checkpoint),
        recoveryReferences: [base],
      }),
    /invalid_recovery_reference/
  );
  assert.equal(f.store.readProjection(REF)!.commitSeq, 1);
});

test(
  'B12R real Claude reader restarts from SQLite without re-counting old IDs or losing late pending results',
  { skip },
  async (t) => {
    const f = await setup(t);
    const { createClaudeReader } = await import('../../src/harness/claude/reader.js');
    const target: SessionRef = { ...REF, harness: 'claude' };
    const file = path.join(f.root, 'synthetic-transcript.jsonl');
    const rows = Array.from({ length: 220 }, (_, n) =>
      JSON.stringify({
        type: 'assistant',
        uuid: `synthetic-message-${n}`,
        sessionId: target.sessionId,
        timestamp: new Date(NOW + n).toISOString(),
        message: {
          id: `synthetic-usage-${n}`,
          role: 'assistant',
          model: 'synthetic-model',
          usage: { input_tokens: 3, output_tokens: 1 },
          content: [
            {
              type: 'tool_use',
              id: `synthetic-call-${n}`,
              name: 'mcp__hud__delegate_spawn',
              input: { brief: 'Synthetic task' },
            },
          ],
        },
      })
    );
    fs.writeFileSync(file, rows.join('\n') + '\n');
    const options = { ref: target, resolveFile: () => file, serverNames: ['hud'] };
    const original = createClaudeReader(options);
    const lease = f.store.acquire(target, 'claude-reader');
    const make = (result: Awaited<ReturnType<typeof original.read>>, seq: number) => {
      const c = commit(seq, lease.generation);
      c.ref = target;
      c.sourceGeneration = result.checkpoint.sourceGeneration;
      c.checkpoint = result.checkpoint;
      c.summary = result.observation;
      c.notices = [];
      c.observationStamp = { ...c.observationStamp, ref: target, sourceGeneration: c.sourceGeneration };
      c.continuity = {
        ...c.continuity,
        nodeIdentity: { kind: 'session', ref: target },
        sourceGeneration: c.sourceGeneration,
      };
      c.summary.statusProjection = {
        ...c.summary.statusProjection,
        observationStamp: c.observationStamp,
        stateKey: c.continuity.stateKey,
        stateSince: c.continuity.stateSince,
        stateSinceBasis: c.continuity.stateSinceBasis,
        asOfSeq: null,
      };
      return c;
    };
    let result = await original.read();
    let seq = 0;
    while (true) {
      const c = make(result, ++seq);
      f.store.publishPrepared(preparedCandidate(c, f.prepare(c)), lease);
      if (result.observation.coverage.state !== 'catching_up') break;
      result = await original.read();
    }
    const projection = f.store.readProjection(target)!;
    const recovery = f.store.readRecovery(projection, BUDGET) as ObservationRecovery;
    const restarted = createClaudeReader(options, recovery.checkpoint);
    fs.appendFileSync(
      file,
      rows[0] +
        '\n' +
        JSON.stringify({
          type: 'user',
          uuid: 'synthetic-late-result',
          sessionId: target.sessionId,
          timestamp: new Date(NOW + 10_000).toISOString(),
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'synthetic-call-0',
                content: JSON.stringify({ linkId: 'synthetic-link', runId: 'synthetic-late-run' }),
              },
            ],
          },
        }) +
        '\n'
    );
    const expected = await original.read();
    const actual = await restarted.read();
    assert.deepEqual(actual.observation.spent.tokens, expected.observation.spent.tokens);
    assert.equal(actual.observation.spent.tokens.value!.input, 660);
    const facts = (inputs: typeof actual.inputs) =>
      inputs.map(({ observedAt: _observed, lastSuccessfulReadAt: _read, ...input }) => input);
    assert.deepEqual(facts(actual.inputs), facts(expected.inputs));
    assert.deepEqual(actual.evidence.linkEvidence, expected.evidence.linkEvidence);
    assert.ok(
      actual.evidence.linkEvidence.some((link) => link.kind === 'tool_result' && link.runId === 'synthetic-late-run')
    );
    const next = make(actual, seq + 1);
    f.store.publishPrepared(preparedCandidate(next, f.prepare(next)), lease);
    const updated = f.store.readRecovery(f.store.readProjection(target)!, BUDGET) as ObservationRecovery;
    assert.equal(updated.checkpoint.recoveryIndex!.lookup!.get('claude.openToolWaits', 'synthetic-call-0'), undefined);
    assert.equal(
      updated.checkpoint.recoveryIndex!.lookup!.get('claude.pendingHudCalls', 'synthetic-call-0'),
      undefined
    );
  }
);

test('B12R compatibility readCurrent pins projection and recovery across a competing publish', { skip }, async (t) => {
  const f = await setup(t);
  const first = commit();
  f.store.publishPrepared(preparedCandidate(first, f.prepare(first)), f.lease);
  f.store.release(REF, f.lease);
  const writer = await openObservationStore({ hudHome: f.root, sourceId: REF.sourceId, now: () => NOW });
  try {
    const lease = writer.acquire(REF, 'competitor');
    const next = commit(2, lease.generation);
    const prepared = writer.prepareCheckpoint({
      checkpoint: next.checkpoint,
      boundary: checkpointBoundary(next.checkpoint),
      format: checkpointFormat(next.checkpoint),
      recoveryReferences: [],
    });
    const pending = preparedCandidate(next, prepared);
    const original = f.store.readProjection.bind(f.store);
    let competitorError: unknown;
    f.store.readProjection = (ref) => {
      const projection = original(ref);
      try {
        writer.publishPrepared(pending, lease);
      } catch (error) {
        competitorError = error;
      }
      return projection;
    };
    try {
      const current = f.store.readCurrent(REF)!;
      assert.equal(current.commitSeq, 1);
      assert.equal(current.checkpoint.offset, 10);
      assert.ok(competitorError instanceof Error && competitorError.message === 'observation_busy');
    } finally {
      f.store.readProjection = original;
    }
    writer.publishPrepared(pending, lease);
    assert.equal(f.store.readCurrent(REF)!.commitSeq, 2);
  } finally {
    writer.close();
  }
});
