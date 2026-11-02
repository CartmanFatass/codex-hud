import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { delegationBenchmarkFixture } from '../../dist-test/tests/unit/b45-delegation-fixture.js';
import { loadLedgerSqlite, ledgerRuntimeSupported } from '../../dist-test/src/ledger/runtime.js';
import { LedgerBusyError } from '../../dist-test/src/ledger/transaction.js';

// Run explicitly after npm run build:test; excluded from normal unit-test discovery.
const samplesPerOutcome = 200;
const output = process.argv[2];
if (!ledgerRuntimeSupported()) throw new Error('Benchmark requires Node 22 >=22.13 or >=24');
const { DatabaseSync } = await loadLedgerSqlite();
const distributions = [];

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(3));
  return {
    n: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: Number(sorted.at(-1).toFixed(3)),
    over30Ms: sorted.filter((value) => value > 30).length,
    over50Ms: sorted.filter((value) => value >= 50).length,
  };
}

function acceptedCount(f) {
  return f.ledger.snapshot((tx) => Number(tx.get("SELECT count(*) AS n FROM events WHERE kind='intent.accepted'").n));
}

async function measure(f, tool, outcome, index, blocker) {
  const args = {
    ...(tool === 'delegate_spawn' ? f.spawnArgs : f.resumeArgs),
    request_key: `synthetic-benchmark-${tool}-${outcome}-${index}`,
  };
  const source = f.source();
  const before = acceptedCount(f);
  const launches = f.launches.length;
  let transactionWallMs = 0;
  let transactionCount = 0;
  const originalTransaction = f.ledger.transaction;
  f.ledger.transaction = function (...args) {
    const start = performance.now();
    transactionCount++;
    return originalTransaction.apply(this, args).finally(() => {
      transactionWallMs += performance.now() - start;
    });
  };
  let held = false;
  let result;
  let error;
  let wallMs;
  try {
    if (outcome === 'busy') {
      blocker.exec('BEGIN IMMEDIATE');
      held = true;
    }
    const started = performance.now();
    try {
      result = await f.service.invoke(source, tool, args, started);
    } catch (failure) {
      error = failure;
    } finally {
      wallMs = performance.now() - started;
    }
  } finally {
    if (held) blocker.exec('ROLLBACK');
    f.ledger.transaction = originalTransaction;
  }
  if (error instanceof LedgerBusyError && outcome !== 'busy') {
    assert.equal(acceptedCount(f), before);
    assert.equal(f.launches.length, launches);
    return { wallMs, transactionWallMs, transactionCount, actualOutcome: 'uncontended_busy' };
  }
  if (outcome === 'success') {
    assert.ifError(error);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'accepted');
    assert.equal(acceptedCount(f), before + 1);
    assert.equal(f.launches.length, launches + 1);
    if (tool === 'delegate_resume') {
      const row = f.ledger.snapshot((tx) => tx.get('SELECT operation,run_seq FROM runs WHERE run_id=?', result.runId));
      assert.equal(row.operation, 'resume');
      assert.equal(row.run_seq, 2);
    }
  } else {
    assert.ok(error, `${tool}/${outcome} must refuse rather than accept`);
    if (outcome === 'busy') assert.ok(error instanceof LedgerBusyError, String(error));
    else assert.match(error.message, /capability_unverified/);
    assert.equal(acceptedCount(f), before);
    assert.equal(f.launches.length, launches);
  }
  return { wallMs, transactionWallMs, transactionCount, actualOutcome: outcome };
}

for (const tool of ['delegate_spawn', 'delegate_resume']) {
  for (const outcome of ['success', 'refusal', 'busy']) {
    const wall = [];
    const tx = [];
    const counts = [];
    const attempts = [];
    const uncontendedBusy = [];
    // Resume success gets a fresh real, bound/ended ledger per sample. This
    // avoids manufacturing terminal state or replaying one accepted operation.
    const freshEachSample = tool === 'delegate_resume' && outcome === 'success';
    let shared;
    let blocker;
    try {
      if (!freshEachSample) {
        shared = await delegationBenchmarkFixture(outcome !== 'refusal');
        if (tool === 'delegate_resume') await shared.bindAndEnd();
        if (outcome === 'busy') {
          blocker = new DatabaseSync(join(shared.root, 'ledger.sqlite'));
          blocker.exec('PRAGMA busy_timeout=0');
        }
      }
      for (let n = 0; wall.length < samplesPerOutcome && n < samplesPerOutcome * 2; n++) {
        const f = freshEachSample ? await delegationBenchmarkFixture(true) : shared;
        try {
          if (freshEachSample) await f.bindAndEnd();
          const measured = await measure(f, tool, outcome, n, blocker);
          attempts.push(measured);
          if (measured.actualOutcome === 'uncontended_busy') {
            uncontendedBusy.push(measured);
            continue;
          }
          wall.push(measured.wallMs);
          tx.push(measured.transactionWallMs);
          counts.push(measured.transactionCount);
        } finally {
          if (freshEachSample) await f.close();
        }
      }
      assert.equal(
        wall.length,
        samplesPerOutcome,
        `${tool}/${outcome} must collect 200 actual outcomes within 400 attempts`
      );
      const distribution = {
        kind: 'synthetic',
        tool,
        outcome,
        mcpInternalMs: stats(wall),
        authorizationPlusTransactionUpperBoundMs: stats(wall),
        summedLedgerTransactionWallMs: stats(tx),
        transactionsPerSample: { min: Math.min(...counts), max: Math.max(...counts) },
        allAttemptMs: stats(attempts.map((attempt) => attempt.wallMs)),
        uncontendedBusyAttempts: {
          n: uncontendedBusy.length,
          mcpInternalMs: stats(uncontendedBusy.map((attempt) => attempt.wallMs)),
          summedLedgerTransactionWallMs: stats(uncontendedBusy.map((attempt) => attempt.transactionWallMs)),
          meaning:
            'Additional non-accepted calls exhausted the ordinary service budget without an external writer lock; retained here rather than silently discarded or counted as successes/refusals.',
        },
        budgetChecks: {
          mcpInternalP95Below50Ms: stats(wall).p95 < 50,
          authPlusTxUpperBoundP95AtMost30Ms: stats(wall).p95 <= 30,
          authPlusTxUpperBoundEverySampleAtMost30Ms: Math.max(...wall) <= 30,
        },
        setup:
          tool === 'delegate_resume'
            ? 'Synthetic registered supervisor/submission and source/process proof; actual whoami binding plus scope_reconciled writer APIs establish bound/ended/empty-slot before measurement. No direct run-state/slot/binding mutation.'
            : 'Real SQLite ledger; each success uses a new request key and produces one new durable accepted intent and one captured launch.',
        contention:
          outcome === 'busy'
            ? 'Second real DatabaseSync connection holds BEGIN IMMEDIATE throughout invoke; all samples must throw LedgerBusyError with zero accepted-intent/launch increase.'
            : null,
      };
      distributions.push(distribution);
      process.stdout.write(JSON.stringify(distribution) + '\n');
    } finally {
      blocker?.close();
      if (shared) await shared.close();
    }
  }
}

const report = {
  schemaVersion: 1,
  kind: 'synthetic',
  generatedAt: new Date().toISOString(),
  runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
  samplesPerOutcome,
  totalSamples: distributions.reduce((sum, row) => sum + row.mcpInternalMs.n, 0),
  totalAttempts: distributions.reduce((sum, row) => sum + row.allAttemptMs.n, 0),
  distributions,
  limitations: [
    'No real harness, paid model, MCP stdio framing, cold-start latency, native call-source resolver or Claude required-hook transport is measured.',
    'The capability verifier is an explicit test-only injection; these samples neither promote production capability cells nor provide production identity evidence.',
    'Process/source/ancestry and terminal scope proof are synthetic fixture facts; genuine SQLite transactions, source authorization, intent acceptance, binding and reconciliation code execute.',
    'Elapsed invoke is a conservative authorization+transaction upper bound: it also includes brief/config filesystem preparation, hashes, and the captured launch callback. Summed transaction wall times include commit/lock acquisition and instrumentation overhead.',
    'The source-premise fixture snapshot, terminal setup, writer-lock acquisition/release and assertions are outside timed invoke. Busy lock wait inside authorizeRootCall is included.',
    'Spawn samples accumulate independent pending intents in one ledger; resume successes each use a fresh ledger with one prior properly bound/ended run. This does not characterize long-history resume scaling.',
    'No warmup samples are discarded: any uncontended LedgerBusyError is retained as an additional actual busy diagnostic and a new unique request key is used to collect the requested 200 actual outcomes (at most 400 attempts). Budget flags report observed misses.',
  ],
};
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(
  JSON.stringify({ kind: 'synthetic-summary', totalSamples: report.totalSamples, output: output ?? null }) + '\n'
);
