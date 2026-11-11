import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { isEnvelope } from '../../src/core/materials/index.js';
import { subject, setup, build } from '../fixtures/materials-perf.js';

test('material building cost: pure bounded public fragments, no collection or paint hook', () => {
  const fixture = setup();
  fixture.grant();
  try {
    const inputs = Array.from({ length: 20 }, () => subject());
    const measurements: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      assert.ok(isEnvelope(build(fixture.authority, inputs)));
      measurements.push(performance.now() - start);
    }
    measurements.sort((x, y) => x - y);
    console.log(
      `B17 material file-authority n=100 fragments=20 p50=${measurements[50].toFixed(3)}ms p95=${measurements[95].toFixed(3)}ms p99=${measurements[99].toFixed(3)}ms max=${measurements.at(-1)!.toFixed(3)}ms; new HUD-tick I/O=0`
    );
  } finally {
    fixture.close();
  }
});
