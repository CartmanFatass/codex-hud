import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { openObservationStore } from '../../dist/core/observation-store.js';
import { sourceFixture, dist, runtimeRow } from './b10d-fixture.mjs';
import { hudProcess } from './b10d-process-fixture.mjs';
const n = Number(process.env.B10D_SAMPLES ?? 1000);
assert.ok(n >= 1000);
const profiles = process.env.B10D_PROFILE ? process.env.B10D_PROFILE.split(',') : ['bar', 'panel', 'concurrent'];
const output = {
  node: process.version,
  sqlite: process.versions.sqlite,
  clockUncertaintyMs: 0.1,
  boundary:
    'Real owned Node HUD harnesses and worker entry, legacy bounded root parser, renderHud/renderMonitor/frameDiff memory enqueue. Saturated normal opportunities, real Date.now/lease elapsed; no terminal-visible timing. Four populations target native/ledger change each opportunity, and include all continued/no-commit operations. Conservative public-call COMMIT interval includes ACK; asynchronous parent fixture mutation is outside request latency. Resource samples include main and worker ArrayBuffers separately; external overlaps ArrayBuffers. Optional30-minute1s-cadence paired soak follows timed populations on the same HUDs; no extra HUD pair is added to timed populations; no gate is widened.',
  profiles: [],
};
for (const profile of profiles) {
  const sync = profile.startsWith('sync-'),
    entries = profile.endsWith('concurrent') ? ['bar', 'panel'] : [profile.replace('sync-', '')];
  const f = await sourceFixture(200, 20000, { legacyNames: true });
  let ps = [];
  try {
    const opened = performance.now();
    ps = await Promise.all(
      entries.map((e) => hudProcess(f, e, { legacy: true, pinProbe: profile === 'concurrent' }, sync))
    );
    const startup = await Promise.all(ps.map((p) => p.rpc('warm', { count: 200 }, 900000)));
    const coldMs = performance.now() - opened;
    const view = await ps[0].rpc('view'),
      refs = view.tree.nodes.filter((n) => n.identity.kind === 'session').map((n) => n.identity.ref);
    assert.equal(refs.length, 200);
    const populations = [];
    for (const name of process.env.B10D_POPULATIONS?.split(',') ?? [
      'no-change',
      'summary-only',
      'new-checkpoint',
      'mixed-changing',
    ]) {
      const raw = entries.map(() => []),
        before = await Promise.all(ps.map((p) => p.rpc('metrics')));
      let peak = before.map((m) => m.memory.rss),
        peakBuffers = before.map((m) =>
          sync ? m.memory.arrayBuffers : (m.resources?.arrayBuffers ?? 0) + m.memory.arrayBuffers
        ),
        heap = before.map((m) => m.resources?.heapUsed ?? 0),
        maxPayload = entries.map(() => 0),
        maxReaders = entries.map(() => 0),
        maxQueue = entries.map(() => 0);
      for (let i = 0; i < n; i++) {
        const r = refs[i % refs.length];
        if (name === 'summary-only' || name === 'mixed-changing') {
          const now = Date.now();
          f.db
            .prepare(
              name === 'mixed-changing'
                ? 'UPDATE runs SET heartbeat_at=?,heartbeat_seq=?,heartbeat_mono_ms=?'
                : 'UPDATE runs SET heartbeat_at=?,heartbeat_seq=?,heartbeat_mono_ms=? WHERE target_session_ref=?'
            )
            .run(
              ...(name === 'mixed-changing'
                ? [now, i + 1, now]
                : [now, i + 1, now, JSON.stringify([r.harness, r.sourceId, r.sessionId, r.threadId])])
            );
        }
        if (name === 'new-checkpoint' || name === 'mixed-changing')
          appendFileSync(
            f.file(r.sessionId),
            runtimeRow('event_msg', { type: i % 2 ? 'task_complete' : 'task_started' }, i + 1)
          );
        const samples = await Promise.all(ps.map((p) => p.rpc('step', {}, 30000)));
        samples.forEach((s, j) => {
          raw[j].push(s);
          maxPayload[j] = Math.max(maxPayload[j], s.payloadBytes);
        });
        if (i % 20 === 0 || i === n - 1) {
          const ms = await Promise.all(ps.map((p) => p.rpc('metrics')));
          ms.forEach((m, j) => {
            peak[j] = Math.max(peak[j], m.memory.rss, m.resources?.rss ?? 0, m.peakRss ?? 0);
            peakBuffers[j] = Math.max(
              peakBuffers[j],
              sync ? m.memory.arrayBuffers : (m.resources?.arrayBuffers ?? 0) + m.memory.arrayBuffers
            );
            heap[j] = Math.max(heap[j], m.resources?.heapUsed ?? 0);
            maxReaders[j] = Math.max(maxReaders[j], m.resources?.readers ?? 0);
            maxQueue[j] = Math.max(maxQueue[j], m.active ?? 0, m.pending ?? 0, m.unconsumed ?? 0);
          });
        }
      }
      console.log(JSON.stringify({ progress: profile, population: name, n }));
      const after = await Promise.all(ps.map((p) => p.rpc('metrics')));
      entries.forEach((entry, j) => {
        const rows = raw[j],
          fields = [
            'fullOperationMs',
            'mainBookkeepingMs',
            'workerWiringMs',
            'mainCollectionMs',
            'legacyMs',
            'ordinaryPaintMs',
            'operationMs',
            'paintMs',
            'rootMs',
            'b9Ms',
            'wiringMs',
            'serializationMs',
            'ipcMs',
            'decodeMs',
            'renderMs',
            'workerMs',
            'oldestEligibleWaitMs',
          ];
        const timings = Object.fromEntries(
          fields.map((k) => [k, dist(rows.flatMap((r) => (r[k] === null ? [] : [r[k] ?? 0])))])
        );
        for (const k of ['commitToPaintLowerMs', 'commitToPaintUpperMs']) {
          const xs = rows.flatMap((r) => (r[k] === null ? [] : [r[k]]));
          timings[k] = xs.length ? dist(xs) : null;
        }
        const grants = {};
        for (const r of rows) if (r.readGrant) grants[r.readGrant.key] = (grants[r.readGrant.key] ?? 0) + 1;
        populations.push({
          entry,
          name,
          timings,
          legacyNodes: {
            min: Math.min(...rows.map((r) => r.legacyNodes ?? -1)),
            max: Math.max(...rows.map((r) => r.legacyNodes ?? -1)),
          },
          resources: {
            peakRss: peak[j],
            steadyRss: after[j].memory.rss,
            peakOwnedArrayBuffers: peakBuffers[j],
            workerHeapUsed: heap[j],
            maxPayload: maxPayload[j],
            maxReaders: maxReaders[j],
            maxQueue: maxQueue[j],
            workers: after[j].workers,
            cpuBefore: before[j].cpu,
            cpuAfter: after[j].cpu,
          },
          published: rows.filter((r) => r.changed).length,
          sourceBytes: rows.reduce((a, r) => a + r.bytesRead, 0),
          errors: rows.filter((r) => r.error).map((r) => ({ requestId: r.requestId, error: r.error })),
          outcomes: Object.fromEntries(
            [...new Set(rows.map((r) => r.outcome))].map((k) => [k, rows.filter((r) => r.outcome === k).length])
          ),
          grants,
          raw: rows,
        });
      });
      if (process.env.B10D_PERF_OUT)
        writeFileSync(
          process.env.B10D_PERF_OUT + '.inflight.json',
          JSON.stringify({ ...output, active: { profile, coldMs, startup, populations } })
        );
    }
    let soak = null;
    if (profile === 'concurrent' && Number(process.env.B10D_SOAK_MS ?? 0) > 0) {
      const duration = Number(process.env.B10D_SOAK_MS);
      assert.ok(duration >= 1800000);
      const started = performance.now();
      soak = {
        durationRequestedMs: duration,
        elapsedMs: 0,
        operations: 0,
        snapshots: [],
        raw: entries.map(() => []),
        failures: [],
        pinDiagnostics: entries.map(() => ''),
        lastHeartbeatAt: null,
        drain: null,
      };
      let next = started;
      while (performance.now() - started < duration) {
        const i = soak.operations,
          now = Date.now(),
          ref = refs[i % refs.length];
        soak.lastHeartbeatAt = now;
        f.db.prepare('UPDATE runs SET heartbeat_at=?,heartbeat_seq=?,heartbeat_mono_ms=?').run(now, 100000 + i, now);
        appendFileSync(
          f.file(ref.sessionId),
          runtimeRow('event_msg', { type: i % 2 ? 'task_complete' : 'task_started' }, 10000 + i)
        );
        const rows = await Promise.all(ps.map((p) => p.rpc('step', {}, 30000)));
        rows.forEach((row, j) => soak.raw[j].push(row));
        soak.operations++;
        if (i % 5 === 0) {
          const metrics = await Promise.all(ps.map((p) => p.rpc('metrics')));
          soak.snapshots.push({ at: performance.now() - started, metrics });
          metrics.forEach((m, j) => {
            if (
              m.workers !== 1 ||
              m.resources?.readers > 16 ||
              m.resources?.arrayBuffers + m.memory.arrayBuffers > 24 * 1024 * 1024
            )
              soak.failures.push({ i, entry: entries[j], resources: m.resources, memory: m.memory });
            if (m.resources?.blocked === 'reader_slots_pinned') soak.pinDiagnostics[j] = ps[j].stdout;
          });
        }
        soak.elapsedMs = performance.now() - started;
        if (i % 60 === 0) {
          console.log(
            JSON.stringify({
              soak: 'concurrent',
              elapsedMs: soak.elapsedMs,
              operations: soak.operations,
              blocked: soak.snapshots.at(-1).metrics.map((m) => m.resources?.blocked),
            })
          );
          if (process.env.B10D_PERF_OUT) writeFileSync(process.env.B10D_PERF_OUT + '.soak.json', JSON.stringify(soak));
        }
        next += 1000;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, next - performance.now())));
      }
      soak.elapsedMs = performance.now() - started;
      // Stop fixture changes and verify actual latest heartbeat/native boundaries, without another rescue event.
      const store = await openObservationStore({ hudHome: f.home, sourceId: f.parent.sourceId, readOnly: true });
      try {
        const expected = refs.map((ref) => ({ ref, size: statSync(f.file(ref.sessionId)).size }));
        const check = () =>
          expected.filter(({ ref, size }) => {
            const p = store.readProjection(ref);
            return (
              !p ||
              p.checkpointIdentity.offset < size ||
              (ref.sessionId !== f.parent.sessionId &&
                !p.summary.statusProjection.freshness.sources.some(
                  (s) => s.id.startsWith('supervisor:') && s.lastEvidenceAt === soak.lastHeartbeatAt
                ))
            );
          });
        let remaining = check(),
          operations = 0;
        const drainStarted = performance.now();
        while (remaining.length && operations < 5000) {
          await Promise.all(ps.map((p) => p.rpc('step', {}, 30000)));
          operations++;
          if (operations % 20 === 0) remaining = check();
        }
        remaining = check();
        soak.drain = {
          operations,
          elapsedMs: performance.now() - drainStarted,
          remaining: remaining.map((x) => x.ref.sessionId),
        };
        if (remaining.length) soak.failures.push({ kind: 'final_demand_not_settled', remaining: soak.drain.remaining });
      } finally {
        store.close();
      }
      soak.final = await Promise.all(ps.map((p) => p.rpc('metrics')));
      soak.pinDiagnostics = ps.map((p, j) => soak.pinDiagnostics[j] || p.stdout);
      if (process.env.B10D_PERF_OUT) writeFileSync(process.env.B10D_PERF_OUT + '.soak.json', JSON.stringify(soak));
    }
    output.profiles.push({ profile, coldMs, startup, populations, soak });
  } catch (e) {
    output.profiles.push({
      profile,
      error: String(e),
      metrics: await Promise.all(ps.map((p) => p.rpc('metrics').catch(String))),
    });
  } finally {
    await Promise.allSettled(ps.map((p) => p.close()));
    f.cleanup();
  }
  if (process.env.B10D_PERF_OUT) writeFileSync(process.env.B10D_PERF_OUT, JSON.stringify(output));
}
console.log(
  JSON.stringify(
    {
      ...output,
      profiles: output.profiles.map((p) => ({
        ...p,
        populations: p.populations?.map(({ raw, grants, ...r }) => r),
        soak: p.soak ? { ...p.soak, raw: undefined, snapshots: p.soak.snapshots.length } : p.soak,
      })),
    },
    null,
    2
  )
);
