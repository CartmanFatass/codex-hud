import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { queryDelegationExport } from '../../src/core/export-query.js';
import { decodeDelegationExport, serializeDelegationExport } from '../../src/core/export.js';
import type { ExportInputRecord } from '../../src/core/types/export.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { Ledger } from '../../src/ledger/ledger.js';
import type { LedgerTransaction } from '../../src/ledger/transaction.js';
import { insertRecord } from '../../src/ledger/records.js';
import { goldenExportInput } from '../fixtures/contracts/observation-export.js';
import { exportFixture, SENTINEL } from '../fixtures/export/ledger.js';

const skip = ledgerRuntimeSupported()
  ? false
  : `B18 requires Node 22.x >=22.13 or >=24 (23 unsupported); found ${process.versions.node}`;
const entry = resolve('tests/fixtures/export/entry.mjs');
const golden = goldenExportInput();
function one(patch: Partial<ExportInputRecord> = {}): ExportInputRecord {
  return { ...golden.records.find((record) => record.runId === 'synthetic-run-a1')!, isCurrentRun: true, ...patch };
}

test(
  'B18 fixture containers protect active uncommitted fixtures from the former cleanup predicate',
  { skip },
  async (t) => {
    const transaction = Ledger.prototype.transaction;
    let inspected = false;
    t.mock.method(Ledger.prototype, 'transaction', function <
      T,
    >(this: Ledger, callback: (tx: LedgerTransaction) => T, budgetMs?: number): Promise<T> {
      return transaction.call(
        this,
        (tx) => {
          const value = callback(tx);
          if (tx.get('SELECT count(*) AS n FROM runs')?.n === 1) {
            const home = dirname(String(tx.get('PRAGMA database_list')!.file));
            const probe = spawnSync(process.execPath, [entry, 'fixture-cleanup-probe', home], {
              encoding: 'utf8',
              timeout: 5000,
            });
            assert.equal(probe.status, 0, probe.stderr);
            assert.deepEqual(JSON.parse(probe.stdout), {
              rows: 0,
              events: 0,
              homeMatchesLegacyPredicate: true,
              containerMatchesLegacyPredicate: false,
            });
            assert.equal(existsSync(join(home, 'ledger.sqlite')), true);
            inspected = true;
          }
          return value;
        },
        budgetMs
      ) as Promise<T>;
    });
    const fixture = await exportFixture([one()]);
    try {
      assert.equal(inspected, true);
      assert.equal(dirname(fixture.home), fixture.container);
      const result = await queryDelegationExport(fixture.home, { schemaVersion: 1 });
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(result.value.recordCount, 1);
    } finally {
      await fixture.cleanup();
    }
    assert.equal(existsSync(fixture.container), false);
  }
);

test(
  'B18 producer matches A4 golden run shapes, historical binding, sources, handover and decoder',
  { skip },
  async (t) => {
    t.mock.method(Date, 'now', () => golden.exportedAt);
    const fixture = await exportFixture(golden.records);
    try {
      const result = await queryDelegationExport(fixture.home, { schemaVersion: 1 });
      assert.ok(result.ok, JSON.stringify(result));
      const expectedInput = {
        ...golden,
        ledgerId: fixture.ledger.ledgerId,
        asOfSeq: golden.records.length,
        records: golden.records.map((record) =>
          record.runId === 'synthetic-run-b1'
            ? { ...record, runHandshake: { state: 'pending' as const, reason: 'claim_revoked' } }
            : record
        ),
      };
      const expected = serializeDelegationExport(expectedInput, { readElapsedMs: 0, assemblyElapsedMs: 0 });
      assert.ok(expected.ok);
      assert.equal(result.value.json, expected.value.json);
      assert.deepEqual(decodeDelegationExport(result.value.json), { ok: true, value: result.value.envelope });
      assert.equal(result.value.recordCount, 7);
      assert.equal(result.value.bytes, Buffer.byteLength(result.value.json));
      assert.ok(result.value.readTransactionMs < result.value.elapsedMs);
      // A4's b1 is an illustrative missing-source diagnostic; B2 persists a revoked claim after N.
      const rawGolden = JSON.parse(readFileSync(resolve('tests/fixtures/contracts/export-v1.golden.json'), 'utf8'));
      assert.deepEqual(
        result.value.envelope.records.filter((record) => record.linkId !== 'synthetic-link-b'),
        rawGolden.records.filter((record: ExportInputRecord) => record.linkId !== 'synthetic-link-b')
      );
    } finally {
      await fixture.cleanup();
    }
  }
);

test(
  'B18 privacy: paths only on opt-in, no brief/report/claim/event data, unknown codes become null',
  { skip },
  async () => {
    const record = one({
      workspaceSnapshot: {
        ...one().workspaceSnapshot!,
        cwdSource: SENTINEL,
        gitMissingReason: SENTINEL,
        gitCommonDir: `/synthetic/${SENTINEL}/.git`,
        worktree: SENTINEL,
      },
    });
    const fixture = await exportFixture([record]);
    try {
      for (const paths of ['none', 'local'] as const) {
        const result = await queryDelegationExport(fixture.home, { schemaVersion: 1, paths });
        assert.ok(result.ok, JSON.stringify(result));
        assert.equal(result.value.json.includes(SENTINEL), false);
        assert.equal(result.value.json.includes(fixture.inputs[0].claim.claimHash), false);
        const actual = result.value.envelope.records[0];
        assert.equal(Object.hasOwn(actual, 'launchCwd'), paths === 'local');
        assert.equal(Object.hasOwn(actual.workspaceSnapshot!, 'worktreeRoot'), paths === 'local');
        assert.equal(actual.workspaceSnapshot!.cwdSource, null);
        assert.equal(actual.workspaceSnapshot!.gitMissingReason, null);
        if (result.value.envelope.paths === 'local') {
          assert.equal(result.value.envelope.records[0].launchCwd, record.launchCwd);
          assert.equal(
            result.value.envelope.records[0].workspaceSnapshot!.worktreeRoot,
            record.workspaceSnapshot!.worktreeRoot
          );
        }
      }
    } finally {
      await fixture.cleanup();
    }
  }
);

test('B18 endpoint proof is per run; unbound and uncertain records keep explicit nulls', { skip }, async () => {
  const fixture = await exportFixture([
    one(),
    one({
      runId: 'synthetic-run-a2',
      runSeq: 2,
      operation: 'spawn',
      runState: 'uncertain',
      childRef: null,
      runHandshake: { state: 'pending', reason: null },
      createdAt: golden.exportedAt,
      cwdCapturedAt: golden.exportedAt,
      endedAt: null,
      startedAt: null,
    }),
  ]);
  try {
    // A relation can have a known child while a different run still has no proven endpoint.
    const result = await queryDelegationExport(fixture.home, { schemaVersion: 1 });
    assert.ok(result.ok, JSON.stringify(result));
    const actual = result.value.envelope.records[1];
    assert.equal(actual.childRef, null);
    assert.equal(actual.relationshipConfirmed, false);
    assert.equal(actual.runState, 'uncertain');
    assert.equal(actual.runHandshake.state, 'pending');
  } finally {
    await fixture.cleanup();
  }
});

test(
  'B18 scope is stable, complete, not truncated to display limits; shared-target conflict and resolution',
  { skip },
  async () => {
    const fixture = await exportFixture(golden.records);
    try {
      await fixture.ledger.transaction((tx) =>
        insertRecord(tx, 'evidence', {
          evidenceId: 'conflict',
          runId: 'synthetic-run-c1',
          linkId: 'synthetic-link-c',
          kind: 'conflict',
          producer: 'reconciler',
          fingerprint: 'b'.repeat(64),
          payload: { cause: 'identity_conflict', privateText: SENTINEL },
          observedAt: 1700000010000,
          validatedAt: 1700000010000,
          validation: 'accepted',
        })
      );
      const result = await queryDelegationExport(fixture.home, {
        schemaVersion: 1,
        scope: { kind: 'links', linkIds: ['synthetic-link-d', 'absent'] },
      });
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(result.value.envelope.scope, { kind: 'links', linkIds: ['absent', 'synthetic-link-d'] });
      assert.equal(result.value.recordCount, 2);
      assert.equal(result.value.envelope.asOfSeq, 7);
      for (const record of result.value.envelope.records) {
        assert.equal(record.hasUnresolvedConflict, true);
        assert.equal(record.bindingReason, 'identity_conflict');
        assert.equal(record.predecessor, 'synthetic-link-c');
      }
      await fixture.ledger.transaction((tx) =>
        insertRecord(tx, 'evidence', {
          evidenceId: 'resolved',
          runId: 'synthetic-run-c1',
          linkId: 'synthetic-link-c',
          kind: 'conflict_resolved',
          producer: 'reconciler',
          fingerprint: 'c'.repeat(64),
          payload: { resolves: 'conflict' },
          observedAt: 1700000010001,
          validatedAt: 1700000010001,
          validation: 'accepted',
        })
      );
      const cleared = await queryDelegationExport(fixture.home, { schemaVersion: 1 });
      assert.ok(cleared.ok);
      assert.equal(
        cleared.value.envelope.records.some((record) => record.hasUnresolvedConflict),
        false
      );
      const empty = await queryDelegationExport(fixture.home, {
        schemaVersion: 1,
        scope: { kind: 'links', linkIds: [] },
      });
      assert.ok(empty.ok);
      assert.equal(empty.value.recordCount, 0);
      assert.equal(empty.value.envelope.asOfSeq, 7);
    } finally {
      await fixture.cleanup();
    }
  }
);

test('B18 native read-only connection leaves DB bytes/mtime and WAL bytes/mtime unchanged', { skip }, async () => {
  const fixture = await exportFixture(golden.records);
  try {
    const paths = [join(fixture.home, 'ledger.sqlite'), join(fixture.home, 'ledger.sqlite-wal')];
    const before = paths.map((path) => ({ bytes: readFileSync(path), mtime: statSync(path).mtimeMs }));
    const result = await queryDelegationExport(fixture.home, { schemaVersion: 1, paths: 'local' });
    assert.ok(result.ok);
    paths.forEach((path, i) => {
      assert.deepEqual(readFileSync(path), before[i].bytes);
      assert.equal(statSync(path).mtimeMs, before[i].mtime);
    });
  } finally {
    await fixture.cleanup();
  }
});

test(
  'B18 missing/unsupported ledger is an explicit failure, with empty stdout and no initialization',
  { skip },
  async () => {
    const fixture = await exportFixture();
    try {
      const missing = join(fixture.home, 'missing-home');
      assert.deepEqual(await queryDelegationExport(missing, { schemaVersion: 1 }), {
        ok: false,
        reason: 'ledger_missing',
      });
      assert.equal(existsSync(missing), false);
      const command = spawnSync(process.execPath, [entry, 'export', missing], { encoding: 'utf8' });
      assert.equal(command.status, 1);
      assert.equal(command.stdout, '');
      assert.match(command.stderr, /ledger_missing/);
      await fixture.ledger.transaction((tx) => tx.run('PRAGMA user_version=2'));
      assert.deepEqual(await queryDelegationExport(fixture.home, { schemaVersion: 1 }), {
        ok: false,
        reason: 'unsupported_ledger_schema',
      });
      assert.equal(
        fixture.ledger.snapshot((tx) => tx.get('PRAGMA user_version')?.user_version),
        2
      );
      assert.deepEqual(await queryDelegationExport(fixture.home, { schemaVersion: 2 as 1 }), {
        ok: false,
        reason: 'unsupported_export_schema',
      });
    } finally {
      await fixture.cleanup();
    }
  }
);

test(
  'B18 real second-process commit during export cannot mix rows and event high-water',
  { skip, timeout: 10000 },
  async () => {
    const fixture = await exportFixture(golden.records);
    const exporter = fork(entry, ['race', fixture.home], { silent: true });
    const owned = [exporter];
    const exited = once(exporter, 'exit');
    let stdout = '';
    let stderr = '';
    exporter.stdout!.on('data', (data) => {
      stdout += data;
    });
    exporter.stderr!.on('data', (data) => {
      stderr += data;
    });
    try {
      const [message] = await once(exporter, 'message');
      assert.equal(message, 'snapshot-pinned');
      const writer = fork(entry, ['writer', fixture.home], { silent: true });
      owned.push(writer);
      let writerError = '';
      writer.stderr!.on('data', (data) => {
        writerError += data;
      });
      const [writerCode] = await once(writer, 'exit');
      assert.equal(writerCode, 0, writerError);
      const [exportCode] = await exited;
      assert.equal(exportCode, 0, stderr);
      const decoded = decodeDelegationExport(stdout);
      assert.ok(decoded.ok, stdout);
      assert.equal(decoded.value.asOfSeq, 7);
      assert.equal(decoded.value.records.find((record) => record.runId === 'synthetic-run-a3')!.runState, 'starting');
      const after = await queryDelegationExport(fixture.home, { schemaVersion: 1 });
      assert.ok(after.ok);
      assert.equal(after.value.envelope.asOfSeq, 8);
      assert.equal(
        after.value.envelope.records.find((record) => record.runId === 'synthetic-run-a3')!.runState,
        'uncertain'
      );
    } finally {
      for (const child of owned)
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await once(child, 'exit');
        }
      await fixture.cleanup();
    }
  }
);

test('B18 encoding time is included in the soft deadline and failure writes no stdout', { skip }, async () => {
  const fixture = await exportFixture([one()]);
  try {
    const command = spawnSync(process.execPath, [entry, 'slow-encoding', fixture.home], { encoding: 'utf8' });
    assert.equal(command.status, 1);
    assert.equal(command.stdout, '');
    assert.match(command.stderr, /export_time_budget_exceeded/);
  } finally {
    await fixture.cleanup();
  }
});

test('B18 handshake states and claim boundaries are independent of confirmed relationships', { skip }, async (t) => {
  const now = golden.exportedAt;
  t.mock.method(Date, 'now', () => now);
  const fixture = await exportFixture([
    one({
      operation: 'resume',
      runState: 'starting',
      endedAt: null,
      startedAt: null,
      createdAt: now,
      cwdCapturedAt: now,
      runHandshake: { state: 'pending', reason: null },
    }),
  ]);
  try {
    const check = async (state: string, reason: string | null) => {
      const result = await queryDelegationExport(fixture.home, { schemaVersion: 1 });
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(result.value.envelope.records[0].relationshipConfirmed, true);
      assert.deepEqual(result.value.envelope.records[0].runHandshake, { state, reason });
    };
    await check('pending', null);
    await fixture.ledger.transaction((tx) =>
      tx.run(
        `UPDATE claims SET state='redeemed',supervisor_pid=123,supervisor_proc_start='synthetic-start',
      redeemed_at=?,redeemed_context_id='parent-context',redeemed_generation=1 WHERE run_id=?`,
        now,
        'synthetic-run-a1'
      )
    );
    await check('claimed', null);
    t.mock.method(Date, 'now', () => now + 1800000);
    await check('pending', 'claim_expired');
    await fixture.ledger.transaction((tx) => tx.run("UPDATE claims SET state='revoked'"));
    await check('pending', 'claim_revoked');
    await fixture.ledger.transaction((tx) => tx.run('DELETE FROM claims'));
    await check('pending', 'claim_missing');
  } finally {
    await fixture.cleanup();
  }
});
