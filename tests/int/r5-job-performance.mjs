/** Non-gating synthetic panel observation benchmark. Build + build:test first. */
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { r5Fixture, ROOT_R5 } from '../../dist-test/tests/fixtures/r5-jobs.js';
import { PanelJobPipeline } from '../../dist/tree-page.js';
import { buildSubagentTreeYielding } from '../../dist/collectors/subagent-tree.js';
import { renderMonitor, initialMonitorState } from '../../dist/render/monitor.js';

const runs = Math.max(3, Number(process.env.R5_PERF_RUNS) || 3);
const samples = Math.max(3, Number(process.env.R5_PERF_SAMPLES) || 30);
const quantiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { n: values.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted.at(-1) };
};
console.log(
  JSON.stringify({
    host: os.hostname(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    node: process.version,
    runs,
    samplesPerRun: samples,
    percentile: 'nearest-rank',
    units: 'ms',
    note: 'Synthetic on-disk fixtures, no real Herdr/provider/WSL qualification. Collection includes composition; repaint is renderMonitor only, no terminal writes. Baseline is native-only panel collection over the same empty native listing (no job observer).',
  })
);
for (const scenario of ['base-no-jobs', 'quiet', 'changed', 'discovery', '5000-records', 'herdr-unavailable']) {
  const collection = [],
    repaint = [],
    reads = [],
    bytes = [],
    entries = [],
    rss = [];
  let liveMax = 0;
  const perRun = [];
  for (let run = 0; run < runs; run++) {
    const sampleStart = collection.length;
    const cleanup = [];
    const f = r5Fixture({ after: (fn) => cleanup.push(fn) });
    let live = 0;
    const observer = new PanelJobPipeline(f.home, ROOT_R5, {
      now: f.now,
      herdr: async () => {
        live++;
        liveMax = Math.max(liveMax, live);
        try {
          if (scenario === 'herdr-unavailable') throw new Error('synthetic outage');
          return '{"result":{"agents":[]}}';
        } finally {
          live--;
        }
      },
    });
    const count = scenario === '5000-records' ? 5000 : scenario === 'base-no-jobs' ? 0 : 12;
    const associations = [];
    for (let n = 1; n <= count; n++) {
      const a = f.association(n);
      f.receipt(a);
      associations.push(a);
    }
    // Fixed warm-up; large-history remains incremental/partial, not an unbounded preload.
    if (scenario !== 'base-no-jobs') for (let n = 0; n < 20; n++) await observer.refresh();
    let next = count + 1;
    try {
      for (let n = 0; n < samples; n++) {
        f.advance(1000);
        if (scenario === 'changed')
          f.receipt(associations[n % associations.length], { state: n % 2 ? 'open' : 'done' });
        if (scenario === 'discovery') {
          const a = f.association(next++);
          f.receipt(a);
        }
        let charge = { bytes: 0, entries: 0 };
        const start = performance.now();
        const native = await buildSubagentTreeYielding('main', [], 3, f.now(), []);
        let tree = native;
        if (scenario !== 'base-no-jobs') {
          await observer.refresh((b, e) => {
            charge = { bytes: b, entries: e };
          });
          const result = observer.compose(native, null, f.now());
          tree = result.tree;
          // Projection coverage reports attempts (including signature-cache hits), not OS syscall counts.
          reads.push(result.coverage.files);
          bytes.push(charge.bytes);
          entries.push(result.coverage.entries);
        } else {
          reads.push(0);
          bytes.push(0);
          entries.push(0);
        }
        collection.push(performance.now() - start);
        const state = initialMonitorState();
        state.style = 'compact';
        state.tree.showAll = true;
        const paint = performance.now();
        renderMonitor({ tree, state, width: 56, height: 60, nowMs: f.now() });
        repaint.push(performance.now() - paint);
        rss.push(process.memoryUsage().rss / 1024 / 1024);
      }
    } finally {
      observer.dispose();
      for (const fn of cleanup.reverse()) await fn();
    }
    perRun.push({
      run: run + 1,
      collection: quantiles(collection.slice(sampleStart)),
      repaint: quantiles(repaint.slice(sampleStart)),
      rssMiB: quantiles(rss.slice(sampleStart)),
    });
  }
  console.log(
    JSON.stringify({
      scenario,
      collection: quantiles(collection),
      repaint: quantiles(repaint),
      filesPerRefresh: quantiles(reads),
      bytesPerRefresh: quantiles(bytes),
      entriesPerRefresh: quantiles(entries),
      rssMiB: quantiles(rss),
      herdrMaxConcurrent: liveMax,
      perRun,
    })
  );
}
