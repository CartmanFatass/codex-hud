import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import { launchOwned } from '../../src/roles/pi-owned/launch.js';
import { reapOwned } from '../../src/roles/pi-owned/reap.js';
import { fixture, installedPi } from '../fixtures/pi-owned-orchestration-perf.js';

test('cost: cold fake launch n=20; launcher STATUS writes=0, unchanged journal reads=0 writes', async (t) => {
  const times: number[] = [];
  const journalWrites: number[] = [];
  for (let n = 0; n < 20; n++) {
    const f = await fixture(t, 'sonic');
    const started = performance.now();
    const result = await launchOwned(f.context, f.options);
    times.push(performance.now() - started);
    assert.equal(result.state, 'acked', result.reason);
    assert.equal(fs.existsSync(join(f.directory, 'STATUS.json')), false);
    await pause(10);
    journalWrites.push(f.writeCounts.journal);
    assert.equal(f.writeCounts.status, 0);
    const resultClose = await reapOwned(f.context, { ...f.options, graceMs: 200 });
    assert.equal(resultClose.state, 'closed', resultClose.remaining.join(','));
  }
  times.sort((a, b) => a - b);
  t.diagnostic(
    `host=${hostname()} n=20 warmup=0 cold fake launch p50=${times[9]!.toFixed(1)}ms p95=${times[18]!.toFixed(1)}ms STATUS writes=0; observed atomic journal replacements=${Math.min(...journalWrites)}..${Math.max(...journalWrites)}`
  );
});
test('cost: cold real pi loader worker start n=20 and semantic STATUS write count', async (t) => {
  const pkg = await installedPi();
  if (!pkg) {
    t.skip('pi loader unavailable on PATH and PI_PACKAGE_DIR');
    return;
  }
  const times: number[] = [];
  const writes: number[] = [];
  for (let n = 0; n < 20; n++) {
    const f = await fixture(t, 'sonic', true);
    f.mode({ startup: 'real-loader' });
    const start = performance.now();
    const outcome = await launchOwned(f.context, { ...f.options, budgetMs: 20000 });
    times.push(performance.now() - start);
    assert.equal(outcome.state, 'acked', outcome.reason);
    await pause(10);
    writes.push(f.writeCounts.status);
    assert.equal(f.writeCounts.status, 1);
    const inode = fs.statSync(join(f.directory, 'STATUS.json'), { bigint: true }).ino;
    for (let i = 0; i < 10; i++) fs.readFileSync(join(f.directory, 'STATUS.json'));
    assert.equal(fs.statSync(join(f.directory, 'STATUS.json'), { bigint: true }).ino, inode);
    const closed = await reapOwned(f.context, { ...f.options, graceMs: 200 });
    assert.equal(closed.state, 'closed', closed.remaining.join(','));
  }
  times.sort((a, b) => a - b);
  t.diagnostic(
    `host=${hostname()} pi=${pkg.version} n=20 warmup=0 cold fake-herdr real-loader worker startup p50=${times[9]!.toFixed(1)}ms p95=${times[18]!.toFixed(1)}ms startup STATUS writes=${Math.min(...writes)}..${Math.max(...writes)}; unchanged reads=0 writes`
  );
});
