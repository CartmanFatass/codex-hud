import { ProcessClient } from '../int/process-client.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkpointBoundary, checkpointFormat } from '../../src/core/checkpoint.js';
import type { SessionRef } from '../../src/core/types/identity.js';
import type { ObservationRecovery } from '../../src/core/types/checkpoint.js';

const BUDGET = { maxBytes: 256 * 1024, maxRecords: 2000, budgetMs: 20 };

test(
  'B12D WAL FULL opens once, keeps busy limit and private db/wal/shm; read-only projection does not write',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const { DatabaseSync } = await import('node:sqlite');
    const nativeExec = DatabaseSync.prototype.exec;
    let settings: Record<string, unknown> | undefined;
    DatabaseSync.prototype.exec = function (sql: string) {
      const result = nativeExec.call(this, sql);
      if (sql.includes('synchronous=FULL'))
        settings = {
          synchronous: this.prepare('PRAGMA synchronous').get()!.synchronous,
          busy: this.prepare('PRAGMA busy_timeout').get()!.timeout,
          autocheckpoint: this.prepare('PRAGMA wal_autocheckpoint').get()!.wal_autocheckpoint,
          secureDelete: this.prepare('PRAGMA secure_delete').get()!.secure_delete,
        };
      return result;
    };
    let store;
    try {
      store = await f.open();
    } finally {
      DatabaseSync.prototype.exec = nativeExec;
    }
    assert.deepEqual(settings, { synchronous: 2, busy: 10, autocheckpoint: 1000, secureDelete: 1 });
    const lease = store.acquire(REF, 'synthetic');
    const c = commit();
    store.publishPrepared(preparedCandidate(c, prepare(store, c)), lease);
    const observer = new DatabaseSync(store.databasePath, { readOnly: true });
    try {
      assert.equal(observer.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
    } finally {
      observer.close();
    }
    for (const suffix of ['', '-wal', '-shm'])
      assert.equal(fs.statSync(store.databasePath + suffix).mode & 0o777, 0o600);
    const reader = await f.open(true);
    const bytes = fs.readFileSync(store.databasePath + '-wal');
    for (let n = 0; n < 20; n++) assert.equal(reader.readProjection(REF)!.commitSeq, 1);
    assert.deepEqual(fs.readFileSync(store.databasePath + '-wal'), bytes);
    reader.close();
    store.close();
    assert.equal(fs.existsSync(store.databasePath + '-wal'), false);
    assert.equal(fs.existsSync(store.databasePath + '-shm'), false);
  }
);

test(
  'B12D read-only projection during uncommitted publication sees old complete commit, then new complete recovery; stale lease/CAS refused',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const store = await f.open();
    const lease = store.acquire(REF, 'writer');
    const c = commit();
    store.publishPrepared(preparedCandidate(c, prepare(store, c)), lease);
    const reader = await f.open(true);
    const { DatabaseSync } = await import('node:sqlite');
    const nativeExec = DatabaseSync.prototype.exec;
    let sawUncommitted = false;
    DatabaseSync.prototype.exec = function (sql: string) {
      if (sql === 'COMMIT' && !sawUncommitted) {
        sawUncommitted = true;
        const p = reader.readProjection(REF)!;
        assert.equal(p.commitSeq, 1);
        assert.equal(p.notices[0].seq, 1);
        assert.equal(p.summary.spent.tokens.value!.input, 1);
        const r = reader.readRecovery(p, BUDGET) as ObservationRecovery;
        assert.equal(r.checkpoint.offset, 10);
        sawUncommitted = true;
      }
      return nativeExec.call(this, sql);
    };
    const next = commit(2);
    try {
      store.publishPrepared(preparedCandidate(next, prepare(store, next)), lease);
    } finally {
      DatabaseSync.prototype.exec = nativeExec;
    }
    assert.equal(sawUncommitted, true);
    const p = reader.readProjection(REF)!;
    assert.equal(p.commitSeq, 2);
    assert.equal((reader.readRecovery(p, BUDGET) as ObservationRecovery).checkpoint.offset, 20);
    assert.throws(
      () => store.publishPrepared(preparedCandidate(next, prepare(store, next)), lease),
      /observation_commit_conflict/
    );
    f.advance(NOW + 15_000);
    const takeover = await f.open();
    const newLease = takeover.acquire(REF, 'takeover');
    assert.throws(
      () => store.publishPrepared(preparedCandidate(commit(3), prepare(store, commit(3))), lease),
      /lease_fenced/
    );
    const final = commit(3, newLease.generation);
    takeover.publishPrepared(preparedCandidate(final, prepare(takeover, final)), newLease);
    assert.equal(reader.readProjection(REF)!.commitSeq, 3);
  }
);

test('B12D refuses public or symlinked WAL and SHM before SQLite opens them', { skip }, async (t) => {
  for (const suffix of ['-wal', '-shm']) {
    const f = await fixture(t);
    const store = await f.open();
    store.close();
    const file = store.databasePath + suffix;
    fs.writeFileSync(file, 'synthetic', { mode: 0o644 });
    await assert.rejects(f.open(), /observation_file_not_private/);
    fs.unlinkSync(file);
    const target = path.join(f.root, 'synthetic-sidecar');
    fs.writeFileSync(target, 'synthetic', { mode: 0o600 });
    fs.symlinkSync(target, file);
    await assert.rejects(f.open(), /observation_file_not_private/);
    fs.unlinkSync(file);
  }
});

async function dirtyDeleteStore(f: Awaited<ReturnType<typeof fixture>>) {
  const store = await f.open();
  const lease = store.acquire(REF, 'seed');
  const c = commit();
  store.publishPrepared(preparedCandidate(c, prepare(store, c)), lease);
  store.release(REF, lease);
  store.close();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(store.databasePath);
  const sentinel = 'SYNTHETIC_PRE_WAL_RAW_TAIL';
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA secure_delete=OFF');
    c.checkpoint.parserState.pendingBytes = [...Buffer.from(sentinel)];
    Object.assign(c.checkpoint, { oldRawCache: sentinel });
    db.prepare('UPDATE checkpoint_blobs SET body=?').run(JSON.stringify(c.checkpoint));
  } finally {
    db.close();
  }
  assert.equal(fs.readFileSync(store.databasePath).includes(Buffer.from(sentinel)), true);
  return { file: store.databasePath, sentinel };
}
function rebuild(generation: number) {
  const c = commit(2, generation);
  c.sourceGeneration =
    c.checkpoint.sourceGeneration =
    c.continuity.sourceGeneration =
    c.observationStamp.sourceGeneration =
      2;
  c.checkpoint.readerVersion = 'synthetic-reader-2';
  c.checkpoint.offset = 0;
  c.continuity.stateSince = c.summary.statusProjection.stateSince = null;
  c.continuity.stateSinceBasis = c.summary.statusProjection.stateSinceBasis = 'unknown';
  c.continuity.episodeAnchor = null;
  c.notices = [];
  c.summary.coverage = { state: 'partial', loaded: true, skipped: {}, gaps: ['reader_version_rebuild'] };
  return c;
}

test(
  'B12D unsafe DELETE ref refuses ordinary publication, fenced rebuild clears guard, reopen scrubs before WAL and does not inherit authority',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const { file, sentinel } = await dirtyDeleteStore(f);
    const store = await f.open();
    const lease = store.acquire(REF, 'rebuild');
    const bad = commit(2, lease.generation);
    assert.throws(
      () => store.publishPrepared(preparedCandidate(bad, prepare(store, bad)), lease),
      /observation_rebuild_required/
    );
    const { DatabaseSync } = await import('node:sqlite');
    let inspect = new DatabaseSync(file);
    assert.equal(inspect.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete');
    inspect.close();
    const c = rebuild(lease.generation);
    store.publishPrepared(
      { ...preparedCandidate(c, prepare(store, c)), rebuildFromReaderVersion: 'synthetic-reader-1' },
      lease
    );
    const ordinary = structuredClone(c);
    ordinary.commitSeq = 3;
    ordinary.observationStamp.commitSeq = 3;
    ordinary.summary.evidenceStamp = 'post-rebuild-edge';
    ordinary.summary.statusProjection.observationStamp = ordinary.observationStamp;
    store.publishPrepared(preparedCandidate(ordinary, prepare(store, ordinary)), lease);
    assert.equal(store.readProjection(REF)!.commitSeq, 3);
    store.close();
    const reopened = await f.open();
    inspect = new DatabaseSync(file);
    try {
      assert.equal(inspect.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
    } finally {
      inspect.close();
    }
    assert.throws(() => reopened.renew(REF, lease), /lease_fenced/);
    for (const suffix of ['', '-wal', '-shm'])
      if (fs.existsSync(file + suffix))
        assert.equal(fs.readFileSync(file + suffix).includes(Buffer.from(sentinel)), false);
    assert.equal(reopened.readProjection(REF)!.commitSeq, 3);
  }
);

test(
  'B12D DELETE migration requires stopped snapshots and scrubs historic freed bytes before WAL',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const store = await f.open();
    store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(store.databasePath);
    const sentinel = 'SYNTHETIC_FREED_RAW_CACHE';
    try {
      db.exec('PRAGMA journal_mode=DELETE;PRAGMA secure_delete=OFF;CREATE TABLE old_raw(body TEXT)');
      db.prepare('INSERT INTO old_raw VALUES(?)').run(sentinel.repeat(200));
      db.exec('DROP TABLE old_raw');
      assert.equal(fs.readFileSync(store.databasePath).includes(Buffer.from(sentinel)), true);
      db.exec('BEGIN');
      db.prepare('SELECT * FROM observation_current').all();
      await assert.rejects(f.open(), /observation_busy/);
      assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete');
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    const reopened = await f.open();
    const observer = new DatabaseSync(store.databasePath, { readOnly: true });
    try {
      assert.equal(observer.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
    } finally {
      observer.close();
    }
    for (const suffix of ['', '-wal', '-shm'])
      if (fs.existsSync(store.databasePath + suffix))
        assert.equal(fs.readFileSync(store.databasePath + suffix).includes(Buffer.from(sentinel)), false);
    reopened.close();
  }
);

test(
  'B12D SIGKILL during fenced DELETE rebuild retains old complete storage; after COMMIT exposes all rebuilt state before WAL',
  { skip, timeout: 30_000 },
  async (t) => {
    const { fork } = await import('node:child_process');
    const { DatabaseSync } = await import('node:sqlite');
    const { witnessObservationBoundary } = await import('../../src/core/checkpoint.js');
    for (const cut of ['before_commit', 'after_commit']) {
      const f = await fixture(t);
      const { file, sentinel } = await dirtyDeleteStore(f);
      const child = fork(path.resolve('tests/int/b12r-process.mjs'), [], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      const client = new ProcessClient(child, 'b12r-process');
      t.after(() => client.kill());
      const rpc = (op: string, fields: Record<string, unknown> = {}) => client.call(op, fields);
      await rpc('open', { options: { hudHome: f.root, sourceId: REF.sourceId }, now: NOW });
      const lease = await rpc('acquire', { ref: REF, holder: 'rebuild' });
      const c = rebuild(lease.generation);
      const reached = client.point(cut);
      client.send({
        op: 'publish',
        crash: cut,
        lease,
        candidate: {
          commit: c,
          previousCommitSeq: 1,
          rebuildFromReaderVersion: 'synthetic-reader-1',
          boundary: witnessObservationBoundary(c.checkpoint, c.summary, checkpointBoundary(c.checkpoint)),
        },
      });
      await reached;
      await client.kill();
      const reopened = await f.open();
      const inspect = new DatabaseSync(file);
      try {
        assert.equal(reopened.readHead(REF)!.commitSeq, cut === 'before_commit' ? 1 : 2);
        if (cut === 'before_commit') {
          assert.equal(inspect.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete');
          const raw = String(inspect.prepare('SELECT body FROM checkpoint_blobs').get()!.body);
          assert.deepEqual(JSON.parse(raw).parserState.pendingBytes, [...Buffer.from(sentinel)]);
          const ordinary = commit(2);
          assert.throws(
            () => reopened.publishPrepared(preparedCandidate(ordinary, prepare(reopened, ordinary)), lease),
            /observation_rebuild_required/
          );
        } else {
          assert.equal(inspect.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
          assert.deepEqual(reopened.readCurrent(REF), c);
          for (const suffix of ['', '-wal', '-shm'])
            if (fs.existsSync(file + suffix))
              assert.equal(fs.readFileSync(file + suffix).includes(Buffer.from(sentinel)), false);
        }
      } finally {
        inspect.close();
      }
    }
  }
);

test(
  'B12D pre-WAL qualification refuses duplicate JSON shadow bytes and preserves safe indexed metadata',
  { skip },
  async (t) => {
    const { DatabaseSync } = await import('node:sqlite');
    const { RecoveryIndexOverlay, attachRecoveryIndex } = await import('../../src/core/checkpoint.js');
    for (const shadow of [false, true]) {
      const f = await fixture(t);
      const store = await f.open();
      const lease = store.acquire(REF, 'seed');
      const c = commit();
      const index = new RecoveryIndexOverlay('synthetic-index-1');
      index.set('synthetic.ids', 'one', '1');
      attachRecoveryIndex(c.checkpoint, index);
      const token = store.prepareCheckpoint({
        checkpoint: c.checkpoint,
        boundary: checkpointBoundary(c.checkpoint),
        format: checkpointFormat(c.checkpoint),
        recoveryReferences: [],
      });
      store.publishPrepared(preparedCandidate(c, token), lease);
      store.release(REF, lease);
      store.close();
      const db = new DatabaseSync(store.databasePath);
      try {
        db.exec('PRAGMA journal_mode=DELETE');
        if (shadow) {
          const row = db.prepare('SELECT body FROM checkpoint_blobs').get()!;
          const body = String(row.body);
          const dirty = body.replace('"pendingBytes":[]', '"pendingBytes":[83,89,78],"pendingBytes":[]');
          assert.notEqual(dirty, body);
          db.prepare('UPDATE checkpoint_blobs SET body=?').run(dirty);
        }
      } finally {
        db.close();
      }
      const reopened = await f.open();
      const inspect = new DatabaseSync(store.databasePath);
      try {
        assert.equal(inspect.prepare('PRAGMA journal_mode').get()!.journal_mode, shadow ? 'delete' : 'wal');
      } finally {
        inspect.close();
      }
      const acquired = reopened.acquire(REF, 'next');
      if (shadow) {
        const edge = commit(2, acquired.generation);
        assert.throws(
          () => reopened.publishPrepared(preparedCandidate(edge, prepare(reopened, edge)), acquired),
          /observation_rebuild_required/
        );
      } else {
        const p = reopened.readProjection(REF)!;
        const r = reopened.readRecovery(p, BUDGET) as ObservationRecovery;
        assert.equal(r.checkpoint.recoveryIndex!.lookup!.get('synthetic.ids', 'one'), '1');
      }
    }
  }
);

test(
  'B12D transition removes literal orphan raw bytes while preserving live head, lease and reader fences',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const store = await f.open();
    const lease = store.acquire(REF, 'seed');
    const c = commit();
    store.publishPrepared(preparedCandidate(c, prepare(store, c)), lease);
    const head = store.readHead(REF);
    store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const { sessionRefKey } = await import('../../src/core/identity.js');
    let db = new DatabaseSync(store.databasePath);
    const sentinel = 'SYNTHETIC_ORPHAN_RAW_BYTES';
    try {
      db.exec('PRAGMA journal_mode=DELETE;PRAGMA secure_delete=OFF');
      db.prepare('INSERT INTO checkpoint_blobs VALUES(?,?,?,?)').run('orphan', sentinel, '{}', 'orphan-lineage');
      db.prepare('INSERT INTO recovery_entries VALUES(?,?,?,?,?)').run('orphan-lineage', 1, 'orphan', 'raw', sentinel);
      db.prepare('INSERT INTO recovery_indexes VALUES(?,?,?,?,?,?)').run(
        'orphan-index',
        sessionRefKey(REF),
        'orphan-version',
        'orphan-lineage',
        1,
        sentinel
      );
      db.prepare('INSERT INTO retired_readers VALUES(?,?)').run(sessionRefKey(REF), 'synthetic-retired-reader');
    } finally {
      db.close();
    }
    assert.equal(fs.readFileSync(store.databasePath).includes(Buffer.from(sentinel)), true);
    const reopened = await f.open();
    assert.deepEqual(reopened.readHead(REF), head);
    assert.deepEqual(reopened.readLease(REF), lease);
    assert.deepEqual(reopened.readCurrent(REF), c);
    db = new DatabaseSync(store.databasePath);
    try {
      assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
      assert.equal(db.prepare('SELECT count(*) AS n FROM checkpoint_blobs').get()!.n, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM recovery_entries').get()!.n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM recovery_indexes').get()!.n, 0);
      assert.equal(db.prepare('SELECT version FROM retired_readers').get()!.version, 'synthetic-retired-reader');
    } finally {
      db.close();
    }
    reopened.close();
    assert.equal(fs.readFileSync(store.databasePath).includes(Buffer.from(sentinel)), false);
    assert.equal(fs.existsSync(store.databasePath + '-wal'), false);
    assert.equal(fs.existsSync(store.databasePath + '-shm'), false);
  }
);

test(
  'B12D genuine native indexed Claude checkpoint qualifies on DELETE-to-WAL reopen without rebuilding',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const target: SessionRef = { ...REF, harness: 'claude' };
    const { createClaudeReader } = await import('../../src/harness/claude/reader.js');
    const file = path.join(f.root, 'synthetic-transcript.jsonl');
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        uuid: 'synthetic-message',
        sessionId: target.sessionId,
        timestamp: new Date(NOW).toISOString(),
        message: {
          id: 'synthetic-usage',
          role: 'assistant',
          model: 'synthetic-model',
          usage: { input_tokens: 3, output_tokens: 1 },
          content: [{ type: 'text', text: 'Synthetic public answer' }],
        },
      }) + '\n'
    );
    const reader = createClaudeReader({ ref: target, resolveFile: () => file, serverNames: ['hud'] });
    const result = await reader.read();
    const store = await f.open();
    const lease = store.acquire(target, 'native');
    const c = commit();
    c.ref = target;
    c.sourceGeneration = result.checkpoint.sourceGeneration;
    c.leaseGeneration = lease.generation;
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
      stateKey: c.continuity.stateKey,
      stateSince: c.continuity.stateSince,
      stateSinceBasis: c.continuity.stateSinceBasis,
      observationStamp: c.observationStamp,
      asOfSeq: null,
    };
    store.publishPrepared(preparedCandidate(c, prepare(store, c)), lease);
    store.close();
    const { DatabaseSync } = await import('node:sqlite');
    let db = new DatabaseSync(store.databasePath);
    try {
      db.exec('PRAGMA journal_mode=DELETE');
    } finally {
      db.close();
    }
    const reopened = await f.open();
    db = new DatabaseSync(store.databasePath);
    try {
      assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
    } finally {
      db.close();
    }
    const p = reopened.readProjection(target)!;
    const r = reopened.readRecovery(p, BUDGET) as ObservationRecovery;
    assert.equal(r.checkpoint.readerVersion, 'claude-reader-5');
    assert.ok(r.checkpoint.recoveryIndex!.lookup);
    assert.equal(p.summary.spent.tokens.value!.input, 3);
    assert.equal(p.commitSeq, 1);
  }
);

test(
  'B12D refuses incomplete legacy-bearing WAL and gates inconsistent blob/current/index joins before cleanup',
  { skip },
  async (t) => {
    const { DatabaseSync } = await import('node:sqlite');
    for (const mutation of ['legacyWal', 'blobId', 'projectionIdentity', 'indexLineage']) {
      const f = await fixture(t);
      const store = await f.open();
      const lease = store.acquire(REF, 'seed');
      const c = commit();
      const { RecoveryIndexOverlay, attachRecoveryIndex } = await import('../../src/core/checkpoint.js');
      const index = new RecoveryIndexOverlay('synthetic-index-1');
      index.set('synthetic.ids', 'one', '1');
      attachRecoveryIndex(c.checkpoint, index);
      store.publishPrepared(preparedCandidate(c, prepare(store, c)), lease);
      store.release(REF, lease);
      store.close();
      const db = new DatabaseSync(store.databasePath);
      try {
        if (mutation === 'legacyWal')
          db.exec("INSERT INTO observation_legacy VALUES('synthetic-legacy-ref',1,1,'old','old','old','{}','{}',0)");
        else {
          db.exec('PRAGMA journal_mode=DELETE');
          if (mutation === 'blobId')
            db.exec(
              "UPDATE checkpoint_blobs SET id='wrong-id';UPDATE observation_current SET checkpoint_id='wrong-id'"
            );
          if (mutation === 'projectionIdentity') {
            const p = JSON.parse(
              String(db.prepare('SELECT projection_body FROM observation_current').get()!.projection_body)
            );
            p.checkpointIdentity.offset++;
            db.prepare('UPDATE observation_current SET projection_body=?').run(JSON.stringify(p));
          }
          if (mutation === 'indexLineage') db.exec("UPDATE checkpoint_blobs SET index_lineage='wrong-lineage'");
        }
      } finally {
        db.close();
      }
      if (mutation === 'legacyWal') {
        await assert.rejects(f.open(), /observation_wal_rebuild_required/);
        await assert.rejects(f.open(true), /observation_wal_rebuild_required/);
      } else {
        const reopened = await f.open();
        const inspect = new DatabaseSync(store.databasePath);
        try {
          assert.equal(inspect.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete');
          assert.equal(inspect.prepare('SELECT count(*) AS n FROM recovery_entries').get()!.n, 1);
        } finally {
          inspect.close();
        }
        const next = reopened.acquire(REF, 'next');
        const ordinary = commit(2, next.generation);
        assert.throws(
          () => reopened.publishPrepared(preparedCandidate(ordinary, prepare(reopened, ordinary)), next),
          /observation_rebuild_required/
        );
      }
    }
  }
);
import { skip, NOW, REF, commit, preparedCandidate, fixture, prepare } from '../fixtures/b12d-wal-perf.js';

test(
  'semantic residue: automatic checkpoint reuses WAL; a short pinned snapshot blocks reclamation until release',
  { skip },
  async (t) => {
    const f = await fixture(t),
      store = await f.open();
    const lease = store.acquire(REF, 'writer');
    const c = commit(),
      token = prepare(store, c);
    let seq = 0;
    const publish = () => {
      const next = commit(++seq);
      next.checkpoint = c.checkpoint;
      // Few commits cross the real 1000-page automatic checkpoint boundary.
      next.summary.evidenceStamp = `synthetic-${seq}`.repeat(32768);
      store.publishPrepared(preparedCandidate(next, token), lease);
    };
    for (let n = 0; n < 24; n++) publish();
    const { DatabaseSync } = await import('node:sqlite');
    const reader = new DatabaseSync(store.databasePath, { readOnly: true });
    const maintenance = new DatabaseSync(store.databasePath);
    const bytes = () => fs.statSync(store.databasePath + '-wal').size;
    try {
      assert.ok(bytes() < 8 * 1024 * 1024, 'automatic checkpoint bounds the short-reader WAL');
      reader.exec('BEGIN');
      const pinned = reader.prepare('SELECT commit_seq FROM observation_current').get()!.commit_seq;
      publish();
      publish();
      assert.equal(reader.prepare('SELECT commit_seq FROM observation_current').get()!.commit_seq, pinned);
      maintenance.exec('PRAGMA busy_timeout=10');
      assert.equal(maintenance.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!.busy, 1);
      assert.ok(bytes() > 0);
      reader.exec('COMMIT');
      assert.equal(maintenance.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!.busy, 0);
      assert.equal(bytes(), 0);
    } finally {
      reader.close();
      maintenance.close();
    }
  }
);
