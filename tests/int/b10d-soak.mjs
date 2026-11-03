import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { sourceFixture } from './b10d-fixture.mjs';
import { hudProcess } from './b10d-process-fixture.mjs';
const seconds = Number(process.env.B10D_SOAK_SECONDS ?? 1800);
assert.ok(seconds >= 1800);
const f = await sourceFixture(200, 20000);
let bar, panel;
const observations = [],
  failures = [];
const started = performance.now();
let initialized;
try {
  bar = await hudProcess(f, 'bar');
  panel = await hudProcess(f, 'panel');
  await Promise.all([bar.rpc('warm', { count: 200 }, 180000), panel.rpc('warm', { count: 200 }, 180000)]);
  initialized = performance.now();
  await Promise.all([bar.rpc('cadence', { ms: 1000 }), panel.rpc('cadence', { ms: 1000 })]);
  let i = 0;
  while (performance.now() - initialized < seconds * 1000) {
    const now = Date.now();
    appendFileSync(
      f.file(f.targets[0].sessionId),
      JSON.stringify({ type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'task_started' } }) +
        '\n'
    );
    f.db.prepare('UPDATE runs SET heartbeat_at=?,heartbeat_seq=?,heartbeat_mono_ms=?').run(now, ++i, now);
    if (i % 5 === 0) {
      const metrics = await Promise.all([bar.rpc('metrics'), panel.rpc('metrics')]);
      let wal = 0,
        walHeader = null;
      const walFile = f.home + '/sources/' + f.parent.sourceId + '/observation.sqlite-wal';
      try {
        wal = statSync(walFile).size;
        const fd = openSync(walFile, 'r');
        try {
          const bytes = Buffer.alloc(32);
          readSync(fd, bytes, 0, 32, 0);
          walHeader = bytes.toString('hex');
        } finally {
          closeSync(fd);
        }
      } catch {}
      observations.push({ elapsedMs: performance.now() - initialized, metrics, wal, walHeader });
      for (const m of metrics) {
        if (m.workers !== 1 || m.resources?.readers > 16 || m.resources?.arrayBuffers > 24 * 1024 * 1024)
          failures.push({ elapsedMs: performance.now() - initialized, error: 'resource_limit', metrics: m });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const result = {
    profile:
      'two real HUD processes, one worker each,200 nodes/20000 headers,actual1s cadence and heartbeats; real elapsed leases; no synthetic clock',
    walHeaderVersions: [...new Set(observations.map((row) => row.walHeader).filter(Boolean))],
    durationMs: performance.now() - initialized,
    startupMs: initialized - started,
    node: process.version,
    sqlite: process.versions.sqlite,
    observations,
    failures,
    overruns: { bar: bar.overruns, panel: panel.overruns },
    final: await Promise.all([bar.rpc('metrics'), panel.rpc('metrics')]),
  };
  if (process.env.B10D_SOAK_OUT) writeFileSync(process.env.B10D_SOAK_OUT, JSON.stringify(result));
  console.log(
    JSON.stringify({
      walHeaderVersions: [...new Set(observations.map((row) => row.walHeader).filter(Boolean))],
      durationMs: result.durationMs,
      samples: observations.length,
      failures: failures.length,
      overruns: [bar.overruns.length, panel.overruns.length],
      final: result.final,
    })
  );
  assert.equal(failures.length, 0);
} finally {
  await Promise.allSettled([bar?.close(), panel?.close()]);
  f.cleanup();
}
