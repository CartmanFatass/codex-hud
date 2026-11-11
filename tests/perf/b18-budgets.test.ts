import assert from 'node:assert/strict';
import { cpus, release } from 'node:os';
import { test } from 'node:test';
import { queryDelegationExport } from '../../src/core/export-query.js';
import { EXPORT_LIMITS } from '../../src/core/export.js';
import { goldenExportInput } from '../fixtures/contracts/observation-export.js';
import { exportFixture } from '../fixtures/export/ledger.js';
import { benchmarkSkip, base } from '../fixtures/b18-budgets-perf.js';

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
