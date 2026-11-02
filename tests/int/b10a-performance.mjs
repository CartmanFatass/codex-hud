import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { openLinkLedgerReader } from '../../dist/core/link-ledger-read.js';
import { LinkTickCollector } from '../../dist/core/link/tick.js';
import { loadLimits } from '../../dist/core/link/limits.js';
import { HudDelegationCollector } from '../../dist/collectors/delegation.js';
import { renderHud } from '../../dist/render/header.js';
import { renderMonitor, initialMonitorState } from '../../dist/render/monitor.js';
import { frameDiff } from '../../dist/render/frame-diff.js';
import { makeHudData, node, treeOf } from '../../dist-test/tests/fixtures/hud-data.js';
import { fixture, root, child, ref, collected } from './b9-fixture.mjs';
import { ledgerRuntimeSupported } from '../../dist/ledger/runtime.js';
if (!ledgerRuntimeSupported()) {
  console.log('B10A performance skipped: requires Node 22.x >=22.13 or >=24');
  process.exit(0);
}
const samples = Number(process.env.B10A_SAMPLES ?? 1000);
assert.ok(samples >= 1000);
const distribution = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return {
    n: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1),
    over50: values.filter((x) => x >= 50).length,
    over200: values.filter((x) => x >= 200).length,
  };
};
const populations = [];
for (const count of [0, 20, 200])
  for (const changing of count ? [false, true] : [false]) {
    const f = await fixture({ links: Math.max(0, count - 1) });
    const startup = performance.now();
    const reader = count ? await openLinkLedgerReader(f.path) : null;
    const collector = count ? new LinkTickCollector(reader, f.home, loadLimits(f.home)) : null;
    assert.equal(await HudDelegationCollector.open({}), null);
    const startupMs = performance.now() - startup;
    const sessions = count
      ? [
          collected(root),
          collected(child),
          ...Array.from({ length: Math.max(0, count - 2) }, (_, i) => collected(ref(`synthetic-${i + 1}`))),
        ]
      : [];
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      s.evidence.observation.statusProjection.observationStamp = {
        ref: s.evidence.ref,
        sourceGeneration: 1,
        seqDomain: 'synthetic-b10a-benchmark',
        commitSeq: 1,
        inputLedgerSeq: 0,
        ...(i ? { runId: i === 1 ? 'run-a' : `run-n${i - 1}`, bindingGeneration: 1 } : {}),
      };
    }
    const roots = count ? [{ kind: 'session', ref: root }] : [];
    const legacyTree = treeOf(
      Array.from({ length: Math.max(0, count - 1) }, (_, i) => node(`synthetic-${i}`, `Worker ${i}`, 'running'))
    );
    const data = makeHudData({ subagentTree: legacyTree });
    for (const entry of ['bar', 'panel']) {
      const total = [],
        b9 = [],
        wiring = [],
        render = [],
        projected = [];
      const state = initialMonitorState();
      let previous = null,
        enqueuedBytes = 0;
      for (let i = -100; i < samples; i++) {
        if (changing) {
          f.db
            .prepare('UPDATE runs SET heartbeat_at=?,heartbeat_seq=?,heartbeat_mono_ms=?')
            .run(12000 + i, Math.max(1, i + 101), 12000 + i);
          for (const s of sessions) {
            s.evidence.observation.evidenceStamp = `synthetic-${i}`;
            s.evidence.observation.statusProjection.observationStamp.commitSeq = i + 101;
          }
        }
        const start = performance.now();
        data.delegation = collector ? await collector.tick({ roots, sessions, nowMs: 12000 + Math.max(0, i) }) : null;
        const collectedAt = performance.now();
        const lines =
          entry === 'bar'
            ? renderHud(data, { width: 160, height: 1, layout: { mode: 'compact', showDuration: true } })
            : renderMonitor({
                hud: data,
                tree: legacyTree,
                state,
                width: 56,
                height: 40,
                nowMs: 1772366400000 + Math.max(0, i) * 1000,
              }).lines;
        const painted = frameDiff(previous, lines);
        previous = lines;
        // Synchronous enqueue into an owned memory sink, not terminal-visible timing.
        enqueuedBytes += Buffer.byteLength(painted);
        const end = performance.now();
        if (i >= 0) {
          const stats = collector?.stats();
          total.push(end - start);
          b9.push(stats?.b9Ms ?? 0);
          wiring.push(stats?.wiringMs ?? 0);
          render.push(end - collectedAt);
          projected.push(stats?.projected ?? false);
        }
      }
      populations.push({
        nodes: count,
        changing,
        entry,
        samples,
        startupMs,
        total: distribution(total),
        b9: distribution(b9),
        wiring: distribution(wiring),
        renderPaint: distribution(render),
        projectedTicks: projected.filter(Boolean).length,
        enqueuedBytes,
        raw: { total, b9, wiring, render },
      });
    }
    collector?.close();
    f.cleanup();
  }
const result = {
  node: process.version,
  sqlite: process.versions.sqlite,
  boundary:
    'Local shared collector with real WAL snapshots and injected synthetic committed observation envelopes, existing legacy bar/panel renderer, frame-diff and memory paint enqueue. Excludes B12 publisher and forthcoming B10b delegation rendering; not B14 production qualification.',
  populations,
};
if (process.env.B10A_PERF_OUT) writeFileSync(process.env.B10A_PERF_OUT, JSON.stringify(result));
console.log(
  JSON.stringify({ ...result, populations: populations.map(({ raw, ...population }) => population) }, null, 2)
);
