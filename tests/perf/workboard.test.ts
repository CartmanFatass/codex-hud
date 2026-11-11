import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { initialMonitorState, renderMonitor } from '../../src/render/monitor.js';
import { fixture } from '../fixtures/workboard-perf.js';

test('workboard render-on-change quiet timing evidence, three runs on this host (not WSL qualification)', async (t) => {
  const f = fixture(t),
    d = f.task();
  f.status(d);
  f.qa(d, 1, 'B');
  const data = await f.collect();
  for (let run = 0; run < 3; run++) {
    const samples: number[] = [];
    for (let n = 0; n < 120; n++) {
      const start = performance.now();
      renderMonitor({
        tree: data.tree,
        workboard: data.board,
        state: initialMonitorState(),
        width: 56,
        height: 50,
        nowMs: f.now(),
      });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        measurement: 'workboard-full-render',
        host: process.platform,
        run,
        n: samples.length,
        p50: samples[59],
        p95: samples[113],
        p99: samples[118],
        max: samples[119],
      })
    );
  }
});
