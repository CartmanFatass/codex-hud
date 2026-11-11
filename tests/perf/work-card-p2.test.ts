import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { p2Fixture } from '../fixtures/work-card-p2.js';
import { renderMonitor } from '../../src/render/monitor.js';
import { stripAnsi } from '../../src/render/colors.js';
import { useDisplayFixture } from '../fixtures/display.js';
import { work } from '../fixtures/work-card-p2-perf.js';

test('P2 measured quiet/change/large-history/scroll/resize rendering, three runs on named host', async (t) => {
  const f = p2Fixture(t);
  for (let i = 0; i < 60; i++) {
    const d = f.task(`History-${i}`);
    f.status(d);
    for (let q = 1; q <= 4; q++) {
      f.put(join(d, `qa/q${q}.md`), '# Question\nOptions:\n- A) Keep\n- B) Drop\nDefault if unanswered: A\n');
      f.put(join(d, `qa/q${q}.answer.md`), 'B');
    }
  }
  let data = await f.collect([], 500);
  // Wall-clock slice budgets intentionally yield under load. Drain real observations
  // before timing; never benchmark a partially admitted history as the full dataset.
  for (let attempt = 0; attempt < 9 && data.board.decisions.length < 240; attempt++) data = await f.collect([], 500);
  assert.equal(data.board.workers.length, 60, 'real source collection admitted every history worker');
  assert.equal(data.board.decisions.length, 240, 'all four answered questions per real source reached the renderer');
  let state = work();
  const args = { tree: data.tree, workboard: data.board, width: 110, height: 32, nowMs: f.now() };
  const warm = renderMonitor({ ...args, state });
  state = warm.state;
  assert.match(warm.lines.map(stripAnsi).join('\n'), /imp History-\d+/, 'a real history worker is painted');
  assert.match(warm.lines.map(stripAnsi).join('\n'), /\bB\b/, 'a real answered decision is painted');
  const modes = ['quiet', 'change', 'large-history', 'scroll', 'resize'];
  for (const mode of modes) {
    const samples: number[] = [];
    for (let run = 0; run < 3; run++) {
      const runSamples: number[] = [];
      for (let n = 0; n < 30; n++) {
        const start = performance.now();
        renderMonitor({
          ...args,
          state: mode === 'scroll' ? { ...state, workScroll: n % 15 } : state,
          width: mode === 'resize' && n % 2 ? 56 : 110,
          nowMs: mode === 'change' ? f.now() + n * 60_000 : f.now(),
        });
        const elapsed = performance.now() - start;
        samples.push(elapsed);
        runSamples.push(elapsed);
      }
      runSamples.sort((a, b) => a - b);
      t.diagnostic(
        `${os.hostname()} ${mode} run ${run + 1}: p50=${runSamples[15].toFixed(3)}ms p95=${runSamples[28].toFixed(3)}ms n=30`
      );
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)],
      p95 = samples[Math.floor(samples.length * 0.95)];
    t.diagnostic(
      `${os.hostname()} ${mode}: p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms n=${samples.length} (3 runs)`
    );
    if (mode === 'quiet') assert.ok(p95 <= 2, `quiet p95 ${p95}ms > 2ms`);
  }
});
useDisplayFixture();
