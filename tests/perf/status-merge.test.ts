import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { mergeStatus } from '../../src/core/status/merge.js';
import { fixtures, fixture } from '../fixtures/status-merge-perf.js';

test('10,000 representative pure merges microbenchmark', (t) => {
  const steps = fixtures.map((f) => f.fixture.steps.at(-1)!);
  for (let i = 0; i < 500; i++) {
    const step = steps[i % steps.length];
    mergeStatus(step.input, null, step.ruleVersion, step.nowMs);
  }
  const samples: number[] = [];
  for (let i = 0; i < 10000; i++) {
    const step = steps[i % steps.length];
    const start = performance.now();
    mergeStatus(step.input, null, step.ruleVersion, step.nowMs);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  t.diagnostic(
    JSON.stringify({
      merges: samples.length,
      unit: 'ms/merge',
      p50: samples[5000],
      p95: samples[9500],
      max: samples.at(-1),
    })
  );
});
