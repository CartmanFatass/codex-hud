import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openLedger } from '../../dist-test/src/ledger/ledger.js';
import { acceptIntent } from '../../dist-test/src/ledger/intents.js';
import { ReadControlService } from '../../dist-test/packages/hud-mcp/src/read-control.js';
import { intent } from '../ledger/fixtures.mjs';
function stats(values) {
  const a = values.toSorted((x, y) => x - y);
  return {
    n: a.length,
    p50: a[Math.floor(a.length * 0.5)] ?? null,
    p95: a[Math.floor(a.length * 0.95)] ?? null,
    max: a.at(-1) ?? null,
  };
}
test(
  'B21 acceptIntent and delegate_status p95 below 50ms with four concurrent real SQLite writers and six occupants',
  { timeout: 60000, skip: process.env.B21_PERF !== '1' ? 'Run B21_PERF=1 for isolated performance acceptance' : false },
  async (t) => {
    const f = await fixture(t);
    for (let i = 0; i < 6; i++) await f.seed.call('intent', { variant: 'perf-' + i });
    const writers = [];
    for (let i = 0; i < 4; i++) writers.push(await f.worker());
    const ledger = await openLedger(join(f.home, 'ledger.sqlite'));
    const service = new ReadControlService(
      ledger,
      f.home,
      undefined,
      {},
      { maxActiveRuns: 6, maxActiveRunsPerOwner: 6 }
    );
    t.after(async () => {
      service.close();
      await ledger.close();
    });
    const loads = writers.map((w) => w.call('load', { count: 2000 }));
    const measurements = { accept_replay: [], accept_refusal: [], accept_busy: [], delegate_status: [] };
    for (let i = 0; i < 500; i++) {
      const p = intent('probe-' + i);
      p.requestKey = i % 2 === 0 ? 'key-perf-0' : 'new-' + i;
      let start = performance.now();
      try {
        const result = await acceptIntent(ledger, p, 20, undefined, { maxActiveRuns: 6, maxActiveRunsPerOwner: 6 });
        measurements[result.replayed ? 'accept_replay' : 'accept_refusal'].push(performance.now() - start);
      } catch (e) {
        if (e.code !== 'ledger_busy') throw e;
        measurements.accept_busy.push(performance.now() - start);
      }
      start = performance.now();
      const status = await service.status({ runId: 'run-perf-0' }, () => p.authority);
      assert.equal(status.capacity.active, 6);
      measurements.delegate_status.push(performance.now() - start);
    }
    await Promise.all(loads);
    const output = Object.fromEntries(Object.entries(measurements).map(([k, v]) => [k, stats(v)]));
    console.log(
      'B21_PERF ' +
        JSON.stringify({
          node: process.versions.node,
          sqlite: ledger.snapshot((tx) => tx.get('SELECT sqlite_version() AS version').version),
          writers: 4,
          occupants: 6,
          ...output,
        })
    );
    for (const [name, s] of Object.entries(output)) if (s.n) assert.ok(s.p95 < 50, name + ' p95=' + s.p95);
    assert.ok(output.accept_replay.n > 0);
    assert.ok(output.accept_refusal.n > 0);
    assert.equal(output.delegate_status.n, 500);
  }
);
import { fixture } from '../fixtures/b21-process.mjs';
