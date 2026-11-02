import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { appendFileSync, writeFileSync } from 'node:fs';
import { runtimeFixture, runtimeRow } from './b10a-runtime-fixture.mjs';
import { renderHud } from '../../dist/render/header.js';
import { renderMonitor, initialMonitorState } from '../../dist/render/monitor.js';
import { frameDiff } from '../../dist/render/frame-diff.js';
import { makeHudData, node, treeOf } from '../../dist-test/tests/fixtures/hud-data.js';
const samples = Number(process.env.B10A_SAMPLES ?? 1000);
assert.ok(samples >= 1000);
const dist = (values) => {
  const sorted = [...values].sort((a, b) => a - b),
    at = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return {
    n: values.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1),
    over50: values.filter((x) => x >= 50).length,
    over200: values.filter((x) => x >= 200).length,
  };
};
const populations = [];
for (const count of [20, 200]) {
  const startup = performance.now();
  const f = await runtimeFixture(count, 20000);
  const openingMs = performance.now() - startup;
  let view;
  const warmStarted = performance.now();
  let warmTicks = 0;
  try {
    for (; warmTicks < 3000; warmTicks++) {
      view = await f.runtime.tick(f.parent.sessionId);
      if (view?.tree.nodes.length === count && view.tree.nodes.every((n) => n.loaded) && view.pendingStatus === 0)
        break;
    }
    assert.equal(view.tree.nodes.length, count);
    assert.ok(view.tree.nodes.every((n) => n.loaded));
    const catchupMs = performance.now() - warmStarted;
    const tree = treeOf(Array.from({ length: count - 1 }, (_, i) => node(`synthetic-${i}`, `Worker ${i}`, 'running'))),
      data = makeHudData({ subagentTree: tree });
    for (const changing of [false, true])
      for (const entry of ['bar', 'panel']) {
        const total = [],
          b9 = [],
          wiring = [],
          render = [],
          bytes = [];
        let prior = null,
          sink = 0;
        const state = initialMonitorState();
        for (let i = -100; i < samples; i++) {
          if (changing) {
            appendFileSync(f.file(f.targets[0].sessionId), runtimeRow('event_msg', { type: 'task_started' }, i + 101));
            f.db
              .prepare('UPDATE runs SET heartbeat_at=?,heartbeat_seq=?,heartbeat_mono_ms=?')
              .run(12000 + i, i + 101, 12000 + i);
          }
          const started = performance.now();
          data.delegation = await f.runtime.tick(f.parent.sessionId);
          const readAt = performance.now();
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
          const ended = performance.now(),
            stats = f.runtime.collector.stats();
          assert.ok(stats.bytesRead <= 8 * 1024 * 1024);
          if (i >= 0) {
            total.push(ended - started);
            b9.push(stats.b9Ms);
            wiring.push(stats.wiringMs);
            render.push(ended - readAt);
            bytes.push(stats.bytesRead);
          }
        }
        populations.push({
          nodes: count,
          history: 20000,
          changing,
          entry,
          openingMs,
          catchupMs,
          warmTicks,
          total: dist(total),
          b9: dist(b9),
          wiring: dist(wiring),
          renderPaint: dist(render),
          maxReadBytes: Math.max(...bytes),
          sink,
          raw: { total, b9, wiring, render, bytes },
        });
      }
  } finally {
    f.cleanup();
  }
}
const result = {
  node: process.version,
  sqlite: process.versions.sqlite,
  boundary:
    'Actual HudDelegationCollector runtime with real WAL, production Codex readers/catalog and 20000 real source headers; existing legacy rendering/frame-diff/memory enqueue. Cold catchup separate; B12 publisher and B10b rendering not included.',
  populations,
};
if (process.env.B10A_PERF_OUT) writeFileSync(process.env.B10A_PERF_OUT, JSON.stringify(result));
console.log(JSON.stringify({ ...result, populations: populations.map(({ raw, ...p }) => p) }, null, 2));
