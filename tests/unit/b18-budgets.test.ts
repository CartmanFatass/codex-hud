import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpus, release } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { queryDelegationExport } from '../../src/core/export-query.js';
import { EXPORT_LIMITS } from '../../src/core/export.js';
import type { ExportInputRecord } from '../../src/core/types/export.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { goldenExportInput } from '../fixtures/contracts/observation-export.js';
import { exportFixture } from '../fixtures/export/ledger.js';

const runtimeSkip = ledgerRuntimeSupported() ? false : 'B18 requires Node 22.x >=22.13 or >=24 (23 unsupported)';
const benchmarkSkip =
  runtimeSkip ||
  (process.env.HUD_EXPORT_BENCHMARK === '1'
    ? false
    : 'Run HUD_EXPORT_BENCHMARK=1 for isolated export budget measurements');
const base: ExportInputRecord = {
  ...goldenExportInput().records[0],
  linkId: 'b18-link',
  runId: 'b18-run',
  linkState: 'pending',
  runState: 'starting',
  isCurrentRun: true,
  currentOwner: false,
  parentRef: null,
  childRef: null,
  relationshipConfirmed: false,
  runHandshake: { state: 'pending', reason: null },
  workspaceSnapshot: null,
  createdAt: 1700000000000,
  cwdCapturedAt: 1700000000000,
  startedAt: null,
  endedAt: null,
};
const entry = resolve('tests/fixtures/export/entry.mjs');

test(
  'B18 10001-run scope refuses without partial stdout; explicit smaller scope succeeds',
  { skip: runtimeSkip },
  async () => {
    const records = Array.from({ length: 10001 }, (_, i) => ({ ...base, linkId: `link-${i}`, runId: `run-${i}` }));
    const fixture = await exportFixture(records);
    try {
      assert.deepEqual(await queryDelegationExport(fixture.home, { schemaVersion: 1 }), {
        ok: false,
        reason: 'export_record_budget_exceeded',
      });
      const command = spawnSync(process.execPath, [entry, 'export', fixture.home], { encoding: 'utf8' });
      assert.equal(command.status, 1);
      assert.equal(command.stdout, '');
      assert.match(command.stderr, /export_record_budget_exceeded/);
      const scoped = await queryDelegationExport(fixture.home, {
        schemaVersion: 1,
        scope: { kind: 'links', linkIds: ['link-0'] },
      });
      assert.ok(scoped.ok, JSON.stringify(scoped));
      assert.equal(scoped.value.recordCount, 1);
      assert.equal(scoped.value.envelope.asOfSeq, 10001);
    } finally {
      await fixture.cleanup();
    }
  }
);

test(
  'B18 benchmark: 10000 rows, complete encoded bytes, wall clock and read-transaction lifetime',
  { skip: benchmarkSkip },
  async (t) => {
    // Include 5000 independently confirmed endpoints and 5000 unbound intents.
    const bound = goldenExportInput().records.find((record) => record.runId === 'synthetic-run-a1')!;
    const records = Array.from({ length: 10000 }, (_, i) => ({
      ...(i % 2 ? { ...bound, isCurrentRun: true, childRef: { ...bound.childRef!, sessionId: `child-${i}` } } : base),
      linkId: `link-${String(i).padStart(5, '0')}`,
      runId: `run-${i}`,
    }));
    const fixture = await exportFixture(records);
    try {
      const result = await queryDelegationExport(fixture.home, { schemaVersion: 1 });
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(result.value.recordCount, 10000);
      assert.equal(result.value.envelope.coverage.recordCount, 10000);
      assert.equal(result.value.bytes, Buffer.byteLength(result.value.json));
      assert.ok(result.value.bytes <= EXPORT_LIMITS.bytes);
      assert.ok(result.value.elapsedMs <= EXPORT_LIMITS.softMs);
      t.diagnostic(
        `EXPORT_BENCHMARK ${JSON.stringify({
          node: process.versions.node,
          sqlite: fixture.ledger.snapshot((tx) => tx.get('SELECT sqlite_version() AS version')?.version),
          cpu: cpus()[0]?.model,
          kernel: release(),
          rows: result.value.recordCount,
          bytes: result.value.bytes,
          elapsedMs: result.value.elapsedMs,
          readTransactionMs: result.value.readTransactionMs,
          workload:
            '10000 runs, 5000 bound with accepted proof and report, 5000 unbound; single on-demand read-only export',
        })}`
      );
    } finally {
      await fixture.cleanup();
    }
  }
);

test(
  'B18 byte budget: exactly 16 MiB succeeds, one byte over fails with empty stdout',
  { skip: benchmarkSkip },
  async () => {
    const initial = await exportFixture([base]);
    let filler: number;
    try {
      const measured = await queryDelegationExport(initial.home, { schemaVersion: 1, paths: 'local' });
      assert.ok(measured.ok);
      filler = EXPORT_LIMITS.bytes - measured.value.bytes;
    } finally {
      await initial.cleanup();
    }
    for (const excess of [0, 1]) {
      const fixture = await exportFixture([{ ...base, launchCwd: base.launchCwd + 'x'.repeat(filler + excess) }]);
      try {
        const result = await queryDelegationExport(fixture.home, { schemaVersion: 1, paths: 'local' });
        if (excess === 0) {
          assert.ok(result.ok, JSON.stringify(result));
          assert.equal(result.value.bytes, EXPORT_LIMITS.bytes);
        } else {
          assert.deepEqual(result, { ok: false, reason: 'export_byte_budget_exceeded' });
          const command = spawnSync(
            process.execPath,
            [entry, 'export', fixture.home, '{"schemaVersion":1,"paths":"local"}'],
            { encoding: 'utf8' }
          );
          assert.equal(command.status, 1);
          assert.equal(command.stdout, '');
          assert.match(command.stderr, /export_byte_budget_exceeded/);
        }
        const noPaths = await queryDelegationExport(fixture.home, { schemaVersion: 1 });
        assert.ok(noPaths.ok);
        assert.equal(Object.hasOwn(noPaths.value.envelope.records[0], 'launchCwd'), false);
      } finally {
        await fixture.cleanup();
      }
    }
  }
);
