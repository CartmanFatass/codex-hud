// Diagnostic instrumentation is injected by a loader; production files stay unchanged.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';

const clock = {
  values: {},
  at: 0,
  reset() {
    this.values = {};
    this.at = performance.now();
  },
  mark(name) {
    const now = performance.now();
    this.values[name] = (this.values[name] ?? 0) + now - this.at;
    this.at = now;
  },
};
globalThis.__b10aStages = clock;
const hook = registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith('/dist/core/link/tick.js')) return loaded;
    let source = String(loaded.source);
    const inject = (needle, replacement) => {
      assert.equal(source.split(needle).length, 2, `unique instrumentation boundary: ${needle}`);
      source = source.replace(needle, replacement);
    };
    const mark = (stage) => `globalThis.__b10aStages.mark('${stage}');\n`;
    inject(
      'const started = performance.now();',
      'globalThis.__b10aStages.reset();\nconst started = performance.now();'
    );
    inject('let retained =', mark('setup') + 'let retained =');
    inject(
      'let b9Start = performance.now();',
      mark('initial_envelopes_launch_key') + 'let b9Start = performance.now();'
    );
    inject(
      'stats.b9Ms += performance.now() - b9Start;\n        if',
      'stats.b9Ms += performance.now() - b9Start;\n' + mark('high_water_check') + '        if'
    );
    inject(
      'this.port?.begin?.(deadline);',
      mark('degraded_empty_guards') + 'this.port?.begin?.(deadline);\n' + mark('committed_envelope_checks')
    );
    inject('// Scheduling metadata only.', mark('retained_envelopes_index') + '// Scheduling metadata only.');
    inject(
      'const sessions = !didCollect && immutableSnapshots && unique.size === retained.length ? retained : [...unique.values()];',
      mark('source_metadata_and_scheduler') +
        'const sessions = !didCollect && immutableSnapshots && unique.size === retained.length ? retained : [...unique.values()];'
    );
    inject('const ledgerKey =', mark('io_accounting') + 'const ledgerKey =');
    inject('const memo = keyOf();', 'const memo = keyOf();\n' + mark('memo_key_compute'));
    inject(
      'if (!this.view || !this.tree)',
      mark('projection_selection_view_rebuild') + 'if (!this.view || !this.tree)'
    );
    inject('return this.view;\n        };', mark('cached_view_freshness_finish') + 'return this.view;\n        };');
    return { ...loaded, source };
  },
});
const { runtimeFixture } = await import('./b10a-runtime-fixture.mjs');
const { renderHud } = await import('../../dist/render/header.js');
const { renderMonitor, initialMonitorState } = await import('../../dist/render/monitor.js');
const { frameDiff } = await import('../../dist/render/frame-diff.js');
const { makeHudData, node, treeOf } = await import('../../dist-test/tests/fixtures/hud-data.js');
const n = Number(process.env.B10A_SAMPLES ?? 1000);
assert.ok(n >= 1000);
const dist = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Object.fromEntries([
    ['n', values.length],
    ...[0.5, 0.95, 0.99, 1].map((p, i) => [['p50', 'p95', 'p99', 'max'][i], sorted[Math.ceil(p * n) - 1]]),
  ]);
};
const f = await runtimeFixture(200, 20000);
const populations = [];
try {
  let view;
  for (let i = 0; i < 3000; i++) {
    view = await f.runtime.tick(f.parent.sessionId);
    if (view?.tree.nodes.length === 200 && view.tree.nodes.every((node) => node.loaded) && view.pendingStatus === 0)
      break;
  }
  assert.equal(view.tree.nodes.length, 200);
  assert.ok(view.tree.nodes.every((node) => node.loaded));
  assert.equal(view.pendingStatus, 0);
  const tree = treeOf(Array.from({ length: 199 }, (_, i) => node(`synthetic-${i}`, `Worker ${i}`, 'running')));
  const data = makeHudData({ subagentTree: tree });
  for (const entry of ['bar', 'panel']) {
    const raw = {};
    const push = (stage, value) => (raw[stage] ??= []).push(value);
    const state = initialMonitorState();
    let prior = null,
      sink = 0;
    for (let i = -100; i < n; i++) {
      const started = performance.now();
      data.delegation = await f.runtime.tick(f.parent.sessionId);
      const collected = performance.now();
      const stages = { ...clock.values };
      const stats = f.runtime.collector.stats();
      assert.equal(stats.projected, false);
      assert.equal(stats.ledgerReads, 0);
      assert.equal(stats.bytesRead, 0);
      const lines =
        entry === 'bar'
          ? renderHud(data, { width: 160, height: 1, layout: { mode: 'compact', showDuration: true } })
          : renderMonitor({
              hud: data,
              tree,
              state,
              width: 56,
              height: 40,
              nowMs: 1772366400000 + Math.max(0, i) * 1000,
            }).lines;
      sink += Buffer.byteLength(frameDiff(prior, lines));
      prior = lines;
      const ended = performance.now();
      if (i < 0) continue;
      for (const [stage, value] of Object.entries(stages)) push(stage, value);
      const attributed = Object.values(stages).reduce((sum, value) => sum + value, 0);
      push('runtime_wrapper_and_instrumentation', collected - started - attributed);
      push('render_diff_enqueue', ended - collected);
      push('collector_runtime', collected - started);
      push('wiring_including_wrapper', collected - started - stats.b9Ms);
      push('total', ended - started);
    }
    populations.push({
      entry,
      nodes: 200,
      history: 20000,
      n,
      stages: Object.fromEntries(Object.entries(raw).map(([key, values]) => [key, dist(values)])),
      sink,
      raw,
    });
  }
} finally {
  f.cleanup();
  hook.deregister();
  delete globalThis.__b10aStages;
}
const result = {
  node: process.version,
  boundary:
    'Instrumented production collector + existing legacy render/diff/memory enqueue; no root-parser entry-point pass, B12 publication or B10b rendering. Non-overlapping stage intervals include instrumentation overhead; percentiles are not additive. No host probes are supplied in this fixture.',
  populations,
};
if (process.env.B10A_PERF_OUT) writeFileSync(process.env.B10A_PERF_OUT, JSON.stringify(result));
console.log(JSON.stringify({ ...result, populations: populations.map(({ raw, ...rest }) => rest) }, null, 2));
