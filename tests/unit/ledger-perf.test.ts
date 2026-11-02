import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { ledgerReadRuntimeSupported, openLedgerReader } from '../../src/core/ledger-read.js';
import { openLedger } from '../../src/ledger/ledger.js';
import { insertClaim, insertRecord, insertRun } from '../../src/ledger/records.js';
import type { PreparedIntent } from '../../src/ledger/types.js';

const skip = !ledgerReadRuntimeSupported()
  ? `Ledger requires Node 22.x >=22.13 or >=24 (23 unsupported); found ${process.versions.node}`
  : process.env.HUD_LEDGER_BENCHMARK !== '1'
    ? 'Run HUD_LEDGER_BENCHMARK=1 node --test dist-test/tests/unit/ledger-perf.test.js for the isolated 10000-run benchmark'
    : false;
function distribution(samples: number[]): object {
  const sorted = [...samples].sort((a, b) => a - b);
  return Object.fromEntries(
    [
      ['p50', sorted[499]],
      ['p95', sorted[949]],
      ['p99', sorted[989]],
      ['max', sorted.at(-1)!],
    ].map(([key, value]) => [key, Number(Number(value).toFixed(4))])
  );
}
function optionalFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

test('ledger benchmark: 1000 small writes and read-only snapshots with 10000 runs', { skip }, async (t) => {
  const { statfsSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'hud-ledger-benchmark-'));
  const path = join(dir, 'ledger.sqlite');
  const ledger = await openLedger(path);
  try {
    const fixtures = await import(pathToFileURL(resolve('tests/ledger/fixtures.mjs')).href);
    await fixtures.seedCaller(ledger);
    const prepared = Array.from(
      { length: 10000 },
      (_, index) => fixtures.intent(`benchmark-${index}`) as PreparedIntent
    );
    await ledger.transaction((tx) => {
      for (const input of prepared) {
        insertRecord(tx, 'links', input.link);
        insertRun(tx, input.run);
        insertClaim(tx, input.claim);
        insertRecord(tx, 'events', {
          runId: input.run.runId,
          linkId: input.link.linkId,
          kind: 'intent.accepted',
          payload: {},
          at: 1000,
        });
      }
    });
    assert.equal(
      ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM runs')?.n),
      10000
    );
    const reader = await openLedgerReader(path);
    const writes: number[] = [];
    const reads: number[] = [];
    try {
      for (let index = -50; index < 1000; index++) {
        const n = (index + 10000) % 10000;
        const target = prepared[n];
        const writeStart = performance.now();
        await ledger.transaction((tx) =>
          tx.run('UPDATE runs SET launch_message_id=? WHERE run_id=?', `message-${index}`, target.run.runId)
        );
        if (index >= 0) writes.push(performance.now() - writeStart);
        const readStart = performance.now();
        const snapshot = reader.snapshot({ linkIds: [target.link.linkId] });
        if (index >= 0) reads.push(performance.now() - readStart);
        assert.equal(snapshot.runs.length, 1);
        assert.equal(snapshot.runs[0].launchMessageId, `message-${index}`);
      }
    } finally {
      reader.close();
    }
    const filesystem = statfsSync(dir);
    const sqliteVersion = ledger.snapshot((tx) => tx.get('SELECT sqlite_version() AS version')?.version);
    const report = {
      workload:
        '10000 links/runs/claims/events; 50 warmups + 1000 iterations, one indexed run UPDATE transaction and one complete scoped link read-only snapshot, concurrency=1, WAL, busy_timeout=0',
      node: process.versions.node,
      sqlite: sqliteVersion,
      cpu: cpus()[0]?.model,
      vcpus: cpus().length,
      cpuQuota: optionalFile('/sys/fs/cgroup/cpu.max'),
      memoryBytes: totalmem(),
      os: platform(),
      kernel: release(),
      filesystemType: filesystem.type,
      blockSize: filesystem.bsize,
      databaseBytes: readFileSync(path).byteLength,
      writeMs: distribution(writes),
      readSnapshotMs: distribution(reads),
      writeSamplesMs: writes,
      readSamplesMs: reads,
    };
    t.diagnostic(`LEDGER_BENCHMARK ${JSON.stringify(report)}`);
  } finally {
    await ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
