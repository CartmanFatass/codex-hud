import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { json, fixture } from '../fixtures/pi-dispatch-facade-perf.js';

test('PR4 cold launch samples and semantic STATUS write count', async (t) => {
  const f = await fixture(t);
  const samples: number[] = [];
  for (let n = 0; n < 3; n++) {
    const start = performance.now();
    const a = await f.create(`cold-${n}`);
    assert.equal(a.ok, true, JSON.stringify(a));
    samples.push(performance.now() - start);
    assert.equal(json(join(f.directory(a.job), '.dispatch/primary/status-writes.json')).statusWrites, 1);
  }
  t.diagnostic(
    `host=${hostname()} warmup=0 n=3 cold-create-to-ready-ms=${samples.map((n) => n.toFixed(1)).join(',')} startup-STATUS-writes=1/slot`
  );
});
