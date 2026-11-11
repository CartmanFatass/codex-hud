import test from 'node:test';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { skip, REF, commit, preparedCandidate, fixture, prepare } from '../fixtures/b12d-wal-perf.js';

test(
  'B12D automatic checkpoint bounds declared short-reader load, long snapshot pins WAL, release permits reclamation',
  { skip, timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    const store = await f.open();
    const lease = store.acquire(REF, 'writer');
    const c = commit();
    const token = prepare(store, c);
    store.publishPrepared(preparedCandidate(c, token), lease);
    const { DatabaseSync } = await import('node:sqlite');
    const reader = new DatabaseSync(store.databasePath, { readOnly: true });
    const bytes = () => fs.statSync(store.databasePath + '-wal').size;
    let seq = 1;
    let maxShort = bytes();
    const publish = () => {
      const next = commit(++seq);
      next.checkpoint = c.checkpoint;
      return store.publishPrepared(preparedCandidate(next, token), lease);
    };
    try {
      for (let n = 0; n < 1200; n++) {
        publish();
        reader.prepare('SELECT commit_seq FROM observation_current').get();
        maxShort = Math.max(maxShort, bytes());
      }
      assert.ok(maxShort < 8 * 1024 * 1024, `short reader WAL ${maxShort}`);
      reader.exec('BEGIN');
      const pinned = reader.prepare('SELECT commit_seq FROM observation_current').get()!.commit_seq;
      const startBytes = bytes();
      const start = performance.now();
      for (let n = 0; n < 1200; n++) publish();
      const pinnedBytes = bytes();
      assert.ok(pinnedBytes > startBytes);
      assert.equal(reader.prepare('SELECT commit_seq FROM observation_current').get()!.commit_seq, pinned);
      const maintenance = new DatabaseSync(store.databasePath);
      maintenance.exec('PRAGMA busy_timeout=10; PRAGMA synchronous=FULL');
      try {
        let before = performance.now();
        const blocked = maintenance.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!;
        const blockedMs = performance.now() - before;
        assert.equal(blocked.busy, 1);
        assert.ok(Number(blocked.log) > Number(blocked.checkpointed));
        assert.equal(bytes(), pinnedBytes);
        reader.exec('COMMIT');
        before = performance.now();
        const reclaimed = maintenance.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!;
        const reclaimMs = performance.now() - before;
        assert.equal(reclaimed.busy, 0);
        assert.equal(bytes(), 0);
        t.diagnostic(
          JSON.stringify({
            shortPublishes: 1200,
            maxShortWalBytes: maxShort,
            longSnapshotPublishes: 1200,
            longSnapshotMs: performance.now() - start,
            pinnedWalBytes: pinnedBytes,
            blockedCheckpointMs: blockedMs,
            reclaimMs,
            finalWalBytes: bytes(),
          })
        );
      } finally {
        maintenance.close();
      }
    } finally {
      reader.close();
    }
  }
);
