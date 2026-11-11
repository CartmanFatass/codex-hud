import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';
import { parityFixture, FOOTER_NOW } from '../fixtures/pi-footer.js';

test('p10k footer resize/repaint: three host-labelled runs, no history traversal or launch on paint', (t) => {
  t.mock.method(Date, 'now', () => FOOTER_NOW);
  const { owner } = JSON.parse(readFileSync('tests/fixtures/pi-footer-parity/goldens.json', 'utf8'));
  const f = parityFixture({ name: 'perf', width: 160 }, owner);
  t.after(() => f.dispose());
  for (let i = 0; i < 100; i++) f.render(i % 2 ? 80 : 160);
  const captured = f.counts();
  for (let run = 0; run < 3; run++) {
    const samples: number[] = [];
    for (let i = 0; i < 500; i++) {
      const before = performance.now();
      f.render(i % 2 ? 80 : 160);
      samples.push(performance.now() - before);
    }
    samples.sort((a, b) => a - b);
    const percentile = (p: number) => samples[Math.ceil(samples.length * p) - 1];
    t.diagnostic(
      `${hostname()} node=${process.version} run=${run + 1} warmup=100 n=500 nearest-rank p50=${percentile(0.5).toFixed(4)}ms p95=${percentile(0.95).toFixed(4)}ms p99=${percentile(0.99).toFixed(4)}ms max=${samples.at(-1)!.toFixed(4)}ms`
    );
    assert.ok(percentile(0.95) < 10, 'small ribbon fitting remains sub-frame even on a noisy host');
  }
  assert.deepEqual(f.counts(), captured, 'no history walk, git launch or resource collection on resize/repaint');
});
