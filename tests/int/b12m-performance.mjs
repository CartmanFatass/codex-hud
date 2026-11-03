// B12M local measurement: size-probe overhead per recovery (not a B14 qualification run).
// Usage: npm run build:test && node tests/int/b12m-performance.mjs   (B12M_SAMPLES, default 2000, >= 1000)
// Uses a temporary HUD_HOME and synthetic data only.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs';
import { RecoveryGrant } from '../../dist-test/src/core/observation-store.js';
import { RecoveryIndexOverlay, attachRecoveryIndex } from '../../dist-test/src/core/checkpoint.js';
import { BUDGET, REF, commit, setup } from '../../dist-test/tests/unit/b12m-helpers.js';

const samples = Number(process.env.B12M_SAMPLES ?? 2000);
const warmup = 200;
assert.ok(samples >= 1000);
const cleanups = [];
const f = await setup({ after: (fn) => cleanups.push(fn) }, 'b12m-perf-');
try {
  const overlay = new RecoveryIndexOverlay('synthetic-index-1');
  for (let n = 0; n < 2000; n++) overlay.set('synthetic.ids', String(n).padStart(5, '0'), JSON.stringify({ n }));
  const first = commit();
  attachRecoveryIndex(first.checkpoint, overlay);
  f.publish(first);
  const projection = f.store.readProjection(REF);
  const { DatabaseSync } = await import('node:sqlite');
  const probeDb = new DatabaseSync(f.store.databasePath, { readOnly: true });
  const reference = projection.checkpointIdentity.recoveryReferences[0];
  const { sessionRefKey } = await import('../../dist-test/src/core/identity.js');
  const key = sessionRefKey(REF);
  // The exact admission query readRecoveryMetered runs (prepared per call, as the store does).
  const probe = () =>
    probeDb
      .prepare(
        `SELECT octet_length(b.body) AS body, octet_length(b.identity) AS identity,
          (SELECT octet_length(i.lineage) FROM recovery_indexes i WHERE i.id=?) AS lineage
        FROM observation_current c JOIN checkpoint_blobs b ON b.id=c.checkpoint_id
        WHERE c.ref=? AND c.commit_seq=? AND c.source_generation=? AND c.seq_domain=? AND c.checkpoint_id=?`
      )
      .get(
        reference.indexId,
        key,
        projection.commitSeq,
        projection.sourceGeneration,
        projection.seqDomain,
        projection.checkpointIdentity.contentIdentity
      );
  assert.ok(probe(), 'probe must hit the current commit');
  const populations = {
    legacyReadRecovery: () => {
      const r = f.store.readRecovery(projection, BUDGET);
      assert.ok(r && !('kind' in r));
    },
    meteredReadRecovery: () => {
      const r = f.store.readRecoveryMetered(projection, new RecoveryGrant(BUDGET));
      assert.equal(r.kind, 'recovered');
    },
    probeQueryOnly: () => assert.ok(probe()),
  };
  const timings = Object.fromEntries(Object.keys(populations).map((name) => [name, []]));
  for (let i = 0; i < warmup + samples; i++) {
    // Interleave populations so drift and GC affect each equally.
    for (const [name, work] of Object.entries(populations)) {
      const started = performance.now();
      work();
      const elapsed = performance.now() - started;
      if (i >= warmup) timings[name].push(elapsed);
    }
  }
  const dist = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p) => sorted[Math.ceil(sorted.length * p) - 1];
    const r = (x) => Math.round(x * 1000) / 1000;
    return { n: values.length, p50: r(at(0.5)), p95: r(at(0.95)), p99: r(at(0.99)), max: r(sorted.at(-1)) };
  };
  const report = {
    method: 'nearest-rank, ms, performance.now() around one call, warm-up ' + warmup + ' per population, interleaved',
    node: process.versions.node,
    sqlite: probeDb.prepare('SELECT sqlite_version() AS v').get().v,
    populations: Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, dist(values)])),
  };
  probeDb.close();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (process.env.B12M_OUT) fs.writeFileSync(process.env.B12M_OUT, JSON.stringify(report, null, 2) + '\n');
} finally {
  for (const fn of cleanups) fn();
}
