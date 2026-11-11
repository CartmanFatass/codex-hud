import test from 'node:test';
import assert from 'node:assert/strict';
import { useDisplayFixture } from '../fixtures/display.js';
import { projectWorkCard } from '../../src/collectors/work-card.js';
import { renderWorkCard } from '../../src/render/work-card.js';
import { visualLength } from '../../src/render/colors.js';
import { setLanguage } from '../../src/render/i18n.js';
import { fixture } from '../fixtures/job-progress-perf.js';

test('P3b unchanged render performance: 3 runs, exact widths and default <=3 rows', async (t) => {
  const f = await fixture(t);
  f.grant();
  f.poll();
  await f.settle();
  for (const lang of ['en', 'zh'] as const) {
    setLanguage(lang);
    for (const width of [44, 56, 110]) {
      const frame = f.draw(width);
      for (const line of frame.lines) assert.equal(visualLength(line), width);
      const worker = f.board.workers[0];
      const note = f.progress.state().get(worker.id)?.note;
      assert.ok(renderWorkCard(projectWorkCard(worker, f.f.now()), f.state, width, note?.line).length <= 3);
    }
  }
  for (let run = 0; run < 3; run++) {
    for (let i = 0; i < 100; i++) f.draw(110, 30);
    const samples: number[] = [];
    for (let i = 0; i < 300; i++) {
      const start = performance.now();
      f.draw(110, 30);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    console.log(
      'P3B unchanged render',
      JSON.stringify({ run, p50: samples[149], p95: samples[284], p99: samples[296], max: samples[299] })
    );
    assert.ok(samples[284] <= 2, `unchanged p95 ${samples[284]}ms`);
  }
});
useDisplayFixture();
