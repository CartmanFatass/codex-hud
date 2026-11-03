// Local B10C comparison (>=1000/population), not formal B14 10k/3-start qualification.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { appendFileSync, writeFileSync } from 'node:fs';
import { publishFixture, cycle } from './b10c-fixture.mjs';
import { runtimeRow } from './b10a-runtime-fixture.mjs';
import { renderHud } from '../../dist/render/header.js';
import { renderMonitor, initialMonitorState } from '../../dist/render/monitor.js';
import { frameDiff } from '../../dist/render/frame-diff.js';
import { makeHudData, node, treeOf } from '../../dist-test/tests/fixtures/hud-data.js';
import { ObservationStore } from '../../dist/core/observation-store.js';
const samples = Number(process.env.B10C_SAMPLES ?? 1000);
assert.ok(samples >= 1000);
let decodeMs = 0,
  headMs = 0,
  publishMs = 0,
  leaseMs = 0,
  prepareMs = 0,
  recoveryMs = 0,
  publishes = 0;
for (const [method, record] of [
  [
    'publishPrepared',
    (ms) => {
      publishMs += ms;
      publishes++;
    },
  ],
  ['acquire', (ms) => (leaseMs += ms)],
  ['renew', (ms) => (leaseMs += ms)],
  ['prepareCheckpoint', (ms) => (prepareMs += ms)],
  ['readRecovery', (ms) => (recoveryMs += ms)],
  ['readProjection', (ms) => (decodeMs += ms)],
  ['readHead', (ms) => (headMs += ms)],
]) {
  const original = ObservationStore.prototype[method];
  ObservationStore.prototype[method] = function (...args) {
    const started = performance.now();
    try {
      return original.apply(this, args);
    } finally {
      record(performance.now() - started);
    }
  };
}
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
for (const entry of ['bar', 'panel']) {
  const startup = performance.now(),
    f = await publishFixture(200, 20000),
    openingMs = performance.now() - startup;
  const coldStarted = performance.now();
  let view,
    coldTicks = 0;
  try {
    for (; coldTicks < 5000; coldTicks++) {
      view = await cycle(f);
      if (
        view?.tree.nodes.length === 200 &&
        view.tree.nodes.every((n) => n.loaded) &&
        Object.values(view.details).every((d) => d.statusSource === 'committed')
      )
        break;
    }
    assert.equal(view?.tree.nodes.length, 200);
    assert.ok(view.tree.nodes.every((n) => n.loaded));
    assert.ok(Object.values(view.details).every((d) => d.statusSource === 'committed'));
    const catchupMs = performance.now() - coldStarted;
    // These real semantic deadline edges are a separate population, never called no-op samples.
    const deadlineEdges = [];
    for (let pass = 0; pass < 5; pass++) {
      const deadlines = [...f.runtime.port.readings.values()]
        .flatMap((reading) => (reading.publisher?.hasReading() ? [reading.publisher.deadline()] : []))
        .filter(Number.isFinite);
      if (!deadlines.length) break;
      const waitMs = Math.max(0, Math.max(...deadlines) - Date.now() + 2);
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 60000)));
      for (let j = 0; j < 600; j++) {
        const started = performance.now();
        await cycle(f);
        const stats = f.runtime.publicationStats();
        deadlineEdges.push({ elapsedMs: performance.now() - started, ...stats });
        if (
          !stats.attempted &&
          ![...f.runtime.port.readings.values()].some((reading) => reading.publisher?.hasPending())
        )
          break;
      }
    }
    assert.ok(
      ![...f.runtime.port.readings.values()].some(
        (reading) => reading.publisher?.hasReading() && Number.isFinite(reading.publisher.deadline())
      ),
      'all warm deadline edges must settle before a no-op population'
    );
    const tree = treeOf(Array.from({ length: 199 }, (_, i) => node(`synthetic-${i}`, `Worker ${i}`, 'running'))),
      data = makeHudData({ subagentTree: tree }),
      state = initialMonitorState();
    let prior = null,
      sink = 0;
    for (const changing of [false, true]) {
      const raw = {
        total: [],
        b9: [],
        wiring: [],
        render: [],
        publication: [],
        publishPrepared: [],
        lease: [],
        prepare: [],
        recovery: [],
        decode: [],
        head: [],
        bytes: [],
        attempts: [],
        errors: [],
      };
      for (let i = -100; i < samples; i++) {
        if (changing) {
          appendFileSync(f.file(f.targets[0].sessionId), runtimeRow('event_msg', { type: 'task_started' }, i + 101));
          f.db
            .prepare('UPDATE runs SET heartbeat_at=?,heartbeat_seq=?,heartbeat_mono_ms=?')
            .run(12000 + i, i + 101, 12000 + i);
        }
        decodeMs = headMs = publishMs = leaseMs = prepareMs = recoveryMs = publishes = 0;
        let renderMs = 0;
        const started = performance.now();
        data.delegation = await f.runtime.tick(f.parent.sessionId);
        const token = f.runtime.publicationToken();
        const paint = (next) => {
          const at = performance.now();
          data.delegation = next;
          const lines =
            entry === 'bar'
              ? renderHud(data, { width: 160, height: 1, layout: { mode: 'compact', showDuration: true } })
              : renderMonitor({ hud: data, tree, state, width: 56, height: 40, nowMs: Date.now() }).lines;
          sink += Buffer.byteLength(frameDiff(prior, lines));
          prior = lines;
          renderMs += performance.now() - at;
        };
        paint(data.delegation);
        await f.runtime.afterPaint(paint, started, token);
        const total = performance.now() - started,
          stats = f.runtime.collector.stats(),
          publication = f.runtime.publicationStats();
        assert.ok(stats.bytesRead <= 8 * 1024 * 1024);
        if (i >= 0) {
          raw.total.push(total);
          raw.b9.push(stats.b9Ms);
          raw.wiring.push(Math.max(0, total - stats.b9Ms - renderMs - publishMs - leaseMs - prepareMs - recoveryMs));
          raw.render.push(renderMs);
          raw.publication.push(publication.publishMs);
          raw.publishPrepared.push(publishMs);
          raw.lease.push(leaseMs);
          raw.prepare.push(prepareMs);
          raw.recovery.push(recoveryMs);
          raw.decode.push(decodeMs);
          raw.head.push(headMs);
          raw.bytes.push(stats.bytesRead);
          raw.attempts.push(publishes);
          raw.errors.push(publication.error);
        }
      }
      populations.push({
        nodes: 200,
        history: 20000,
        entry,
        changing,
        openingMs,
        catchupMs,
        coldTicks,
        deadlineEdges,
        total: dist(raw.total),
        b9: dist(raw.b9),
        wiring: dist(raw.wiring),
        renderPaint: dist(raw.render),
        publication: dist(raw.publication),
        publishPrepared: dist(raw.publishPrepared),
        lease: dist(raw.lease),
        prepare: dist(raw.prepare),
        recovery: dist(raw.recovery),
        publishAttempts: raw.attempts.reduce((a, b) => a + b, 0),
        errors: raw.errors.filter(Boolean),
        maxReadBytes: Math.max(...raw.bytes),
        sink,
        raw,
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
    'Real production collector/readers/catalog and WAL+FULL publication, both legacy renderers + frame-diff memory enqueue, including the committed refresh. 200 visible nodes, 20000 real headers; cold initialization/catchup separate. Local B10C sample table; B10b rendering and formal B14 qualification remain separate. B12M exact SQLite/index byte metering pending.',
  populations,
};
if (process.env.B10C_PERF_OUT) writeFileSync(process.env.B10C_PERF_OUT, JSON.stringify(result));
console.log(JSON.stringify({ ...result, populations: populations.map(({ raw, ...p }) => p) }, null, 2));
