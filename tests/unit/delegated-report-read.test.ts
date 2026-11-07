import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { openCompletedReport } from '../../src/core/delegated-report-read.js';
import { sessionRefKey } from '../../src/core/identity.js';
import { DigestFailure } from '../../src/core/materials/source-config.js';
import { digestFixture, SUMMARY } from '../fixtures/delegated-digest.js';

for (const harness of ['codex', 'claude', 'pi'] as const) {
  test(`accepted completed ${harness} full ref is lazy and is not run-terminal evidence`, async () => {
    const f = await digestFixture(harness, 'synthetic-thread');
    const queries: string[] = [];
    try {
      const target = await openCompletedReport(f.home, f.input.runId, f.input.reportId, {
        onQuery: (q) => queries.push(q),
      });
      try {
        assert.deepEqual(target.metadata.ref, f.ref);
        assert.ok(queries.every((q) => !/SELECT\s+(?:\*|summary\b)/i.test(q)));
        assert.ok(queries.every((q) => !/report_path|brief_path|claim_hash|SELECT.*payload\s+FROM/i.test(q)));
        assert.equal(target.subject.read(), SUMMARY);
        assert.equal(queries.filter((q) => q.startsWith('SELECT summary')).length, 1);
        assert.equal(target.current(), true);
        assert.equal(f.db.prepare('SELECT state FROM runs').get()!.state, 'running');
        f.db
          .prepare("INSERT INTO events(run_id,link_id,kind,payload,at) VALUES(?,?,'synthetic.heartbeat','{}',101)")
          .run(f.input.runId, 'synthetic-link');
        assert.equal(target.current(), true);
        f.db.exec(
          "UPDATE child_bindings SET is_current=0,revoked_at=101; UPDATE links SET state='closed',closed_at=101"
        );
        assert.equal(target.current(), true);
        assert.equal(target.subject.read(), SUMMARY);
      } finally {
        target.close();
      }
    } finally {
      f.cleanup();
    }
  });
}
for (const [name, sql] of [
  ['missing accepted event', "DELETE FROM events WHERE kind='report.received'"],
  [
    'duplicate accepted event',
    'INSERT INTO events(run_id,link_id,kind,payload,at) SELECT run_id,link_id,kind,payload,at FROM events',
  ],
  ['unaccepted binding', "UPDATE evidence SET validation='rejected' WHERE evidence_id='proof'"],
  ['missing parent', 'UPDATE links SET parent_ref=NULL'],
  ['handover', "UPDATE links SET current_owner=0,state='handed_over'"],
  ['source mismatch', "UPDATE runs SET source_id='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'"],
  ['harness mismatch', "UPDATE runs SET harness='pi'"],
  ['report context mismatch', 'UPDATE reports SET context_generation=2'],
  ['binding generation mismatch', 'UPDATE child_bindings SET binding_generation=2'],
  ['noncompleted', "UPDATE reports SET status='blocked'"],
]) {
  test(`actual metadata selection refuses ${name}`, async () => {
    const f = await digestFixture();
    try {
      // Deliberately corrupt only this disposable fixture to exercise read-side validation.
      f.db.exec('PRAGMA foreign_keys=OFF');
      f.db.exec(sql);
      await assert.rejects(openCompletedReport(f.home, f.input.runId, f.input.reportId));
    } finally {
      f.cleanup();
    }
  });
}

test('actual metadata selection refuses thread mismatch in a disposable schema-preserving fixture', async () => {
  const f = await digestFixture();
  try {
    const valid = await openCompletedReport(f.home, f.input.runId, f.input.reportId);
    try {
      assert.deepEqual(valid.metadata.ref, f.ref);
    } finally {
      valid.close();
    }

    const originalRef = sessionRefKey(f.ref);
    const otherRef = { ...f.ref, threadId: 'other' };
    const otherKey = sessionRefKey(otherRef);
    assert.notEqual(otherRef.threadId, f.ref.threadId);
    const originalRun = f.db.prepare('SELECT * FROM runs WHERE run_id=?').get(f.input.runId);
    assert.ok(originalRun);
    assert.equal(originalRun.target_session_ref, originalRef);
    const replacementRun: Record<string, string | number | null> = {};
    for (const [column, value] of Object.entries(originalRun)) {
      assert.ok(value === null || typeof value === 'string' || typeof value === 'number');
      replacementRun[column] = value;
    }
    replacementRun.target_session_ref = otherKey;
    const triggers = () =>
      f.db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
    const originalTriggers = triggers();
    const attribution = () => ({
      bindings: f.db.prepare('SELECT * FROM child_bindings ORDER BY binding_id').all(),
      links: f.db.prepare('SELECT * FROM links ORDER BY link_id').all(),
      reports: f.db.prepare('SELECT * FROM reports ORDER BY report_id').all(),
      contexts: f.db.prepare('SELECT * FROM caller_contexts ORDER BY context_id, generation').all(),
      evidence: f.db.prepare('SELECT * FROM evidence ORDER BY evidence_id').all(),
      events: f.db.prepare('SELECT * FROM events ORDER BY seq').all(),
    });
    const originalAttribution = attribution();
    assert.equal(originalAttribution.bindings.length, 1);
    assert.equal(originalAttribution.bindings[0].session_ref, originalRef);
    assert.equal(originalAttribution.bindings[0].run_id, f.input.runId);
    assert.equal(originalAttribution.links.length, 1);
    assert.equal(originalAttribution.links[0].child_ref, originalRef);
    assert.equal(originalAttribution.links[0].link_id, originalRun.link_id);
    assert.equal(originalAttribution.reports.length, 1);
    assert.equal(originalAttribution.reports[0].report_id, f.input.reportId);
    assert.equal(originalAttribution.reports[0].run_id, f.input.runId);
    assert.equal(originalAttribution.reports[0].link_id, originalRun.link_id);
    assert.equal(originalAttribution.reports[0].child_binding_id, originalAttribution.bindings[0].binding_id);
    assert.equal(f.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);

    // Ordinary writers must still be unable to replace a known target.
    assert.throws(
      () => f.db.prepare('UPDATE runs SET target_session_ref=? WHERE run_id=?').run(otherKey, f.input.runId),
      { message: 'known target ref cannot be replaced' }
    );
    assert.deepEqual(f.db.prepare('SELECT * FROM runs WHERE run_id=?').get(f.input.runId), originalRun);

    f.insert('sessions', {
      session_ref: otherKey,
      harness: otherRef.harness,
      source_id: otherRef.sourceId,
      session_id: otherRef.sessionId,
      thread_id: otherRef.threadId,
    });
    // Offline corruption of this disposable fixture only, never a production write path.
    // Keep every schema guard and stored run column; defer only the temporary missing-parent FKs.
    f.db.exec('BEGIN');
    try {
      f.db.exec('PRAGMA defer_foreign_keys=ON');
      assert.equal(f.db.prepare('DELETE FROM runs WHERE run_id=?').run(f.input.runId).changes, 1);
      f.insert('runs', replacementRun);
      f.db.exec('COMMIT');
    } catch (error) {
      f.db.exec('ROLLBACK');
      throw error;
    }

    assert.deepEqual({ ...f.db.prepare('SELECT * FROM runs WHERE run_id=?').get(f.input.runId) }, replacementRun);
    const originalSession = f.db.prepare('SELECT * FROM sessions WHERE session_ref=?').get(originalRef);
    const otherSession = f.db.prepare('SELECT * FROM sessions WHERE session_ref=?').get(otherKey);
    assert.ok(originalSession);
    assert.ok(otherSession);
    assert.deepEqual({ ...otherSession }, { ...originalSession, session_ref: otherKey, thread_id: 'other' });
    assert.deepEqual(JSON.parse(otherKey), [f.ref.harness, f.ref.sourceId, f.ref.sessionId, 'other']);
    assert.deepEqual(attribution(), originalAttribution);
    assert.equal(f.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
    assert.equal(f.db.prepare('PRAGMA defer_foreign_keys').get()!.defer_foreign_keys, 0);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(triggers(), originalTriggers);

    // Setup must finish successfully before observing the actual reader's refusal.
    const queries: string[] = [];
    await assert.rejects(
      async () => {
        const unexpected = await openCompletedReport(f.home, f.input.runId, f.input.reportId, {
          onQuery: (q) => queries.push(q),
        });
        unexpected.close();
      },
      (error: unknown) => error instanceof DigestFailure && error.reason === 'target_unavailable'
    );
    assert.equal(
      queries.filter((q) => /^\s*SELECT p\.report_id, p\.run_id,/.test(q) && q.includes('FROM reports p')).length,
      1
    );
    assert.equal(
      queries.some((q) => /^\s*SELECT\s+(?:\*|summary\b)/i.test(q)),
      false
    );
  } finally {
    f.cleanup();
  }
});

test('latest accepted report is selected by event sequence, never createdAt, with permanent target invalidation', async () => {
  const f = await digestFixture();
  try {
    const target = await openCompletedReport(f.home, f.input.runId, f.input.reportId);
    f.db.exec(
      "INSERT INTO reports SELECT 'new-report',run_id,link_id,child_binding_id,caller_id,caller_context_id,context_generation,status,summary,path,1 FROM reports"
    );
    f.db
      .prepare("INSERT INTO events(run_id,link_id,kind,payload,at) VALUES(?,?,'report.received',?,1)")
      .run(f.input.runId, 'synthetic-link', JSON.stringify({ reportId: 'new-report' }));
    assert.equal(target.current(), false);
    await assert.rejects(openCompletedReport(f.home, f.input.runId, f.input.reportId));
    const latest = await openCompletedReport(f.home, f.input.runId, 'new-report');
    latest.close();
    f.db.exec(
      "DELETE FROM events WHERE json_extract(payload,'$.reportId')='new-report'; DELETE FROM reports WHERE report_id='new-report'"
    );
    assert.equal(target.current(), false);
    target.close();
    await assert.rejects(openCompletedReport(f.home, 'wrong-run', f.input.reportId));
    await assert.rejects(openCompletedReport(f.home, f.input.runId, 'wrong-report'));
  } finally {
    f.cleanup();
  }
});

test('conflict on another relation with the same full target blocks until explicitly resolved', async () => {
  const f = await digestFixture();
  try {
    f.db.exec(
      "INSERT INTO links SELECT 'other-link',state,parent_caller,parent_context_id,parent_context_generation,parent_ref,child_ref,0,backend,role,label,brief_path,task_digest,report_path,predecessor,routing,created_at,claimed_at,bound_at,closed_at FROM links"
    );
    f.insert('evidence', {
      evidence_id: 'conflict',
      run_id: null,
      link_id: 'other-link',
      kind: 'conflict',
      producer: 'reconciler',
      fingerprint: '1'.repeat(64),
      payload: '{}',
      observed_at: 101,
      validated_at: 101,
      validation: 'accepted',
    });
    await assert.rejects(openCompletedReport(f.home, f.input.runId, f.input.reportId));
    f.insert('evidence', {
      evidence_id: 'resolution',
      run_id: null,
      link_id: 'other-link',
      kind: 'conflict_resolved',
      producer: 'reconciler',
      fingerprint: '2'.repeat(64),
      payload: JSON.stringify({ resolves: 'conflict' }),
      observed_at: 102,
      validated_at: 102,
      validation: 'accepted',
    });
    const target = await openCompletedReport(f.home, f.input.runId, f.input.reportId);
    target.close();
  } finally {
    f.cleanup();
  }
});

test('oversize metadata stays lazy; body bounds, empty and sealed summary fail without truncation', async () => {
  const f = await digestFixture();
  try {
    for (const value of ['a'.repeat(32769), 'x'.repeat(8001), '', 'gAAAAA_SYNTHETIC_SEALED']) {
      f.db.prepare('UPDATE reports SET summary=?').run(value);
      const queries: string[] = [];
      const target = await openCompletedReport(f.home, f.input.runId, f.input.reportId, {
        onQuery: (q) => queries.push(q),
      });
      assert.equal(target.metadata.summaryBytes, Buffer.byteLength(value));
      assert.throws(() => target.subject.read(), /material_invalid/);
      if (Buffer.byteLength(value) > 32768)
        assert.equal(
          queries.some((q) => q.startsWith('SELECT summary')),
          false
        );
      target.close();
    }
  } finally {
    f.cleanup();
  }
});

test('replaced ledger inode invalidates the opened target without reopening another database', async () => {
  const f = await digestFixture();
  try {
    const target = await openCompletedReport(f.home, f.input.runId, f.input.reportId);
    const file = join(f.home, 'ledger.sqlite');
    fs.renameSync(file, file + '.original');
    fs.copyFileSync(file + '.original', file);
    fs.chmodSync(file, 0o600);
    assert.equal(target.current(), false);
    fs.unlinkSync(file);
    fs.renameSync(file + '.original', file);
    assert.equal(target.current(), false);
    target.close();
  } finally {
    f.cleanup();
  }
});

test('new current run preserves report attribution but invalidates the selected old run', async () => {
  const f = await digestFixture();
  try {
    const target = await openCompletedReport(f.home, f.input.runId, f.input.reportId);
    f.insert('runs', {
      run_id: 'next-run',
      link_id: 'synthetic-link',
      run_seq: 2,
      operation: 'resume',
      target_session_ref: JSON.stringify([f.ref.harness, f.ref.sourceId, f.ref.sessionId, f.ref.threadId]),
      source_id: f.ref.sourceId,
      harness: f.ref.harness,
      expected_generation: 2,
      mode: 'headless',
      launch_cwd: '/synthetic',
      state: 'starting',
      launch_token_hash: '3'.repeat(64),
      launch_digest: '4'.repeat(64),
      launch_call_id: 'next-call',
      launch_correlation_id: 'next-correlation',
      created_at: 101,
    });
    assert.equal(target.current(), false);
    await assert.rejects(openCompletedReport(f.home, 'next-run', f.input.reportId));
    assert.equal(
      f.db.prepare('SELECT run_id FROM reports WHERE report_id=?').get(f.input.reportId)!.run_id,
      f.input.runId
    );
    target.close();
  } finally {
    f.cleanup();
  }
});
