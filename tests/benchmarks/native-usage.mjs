// Optional synthetic benchmark. Run after npm run build; fixture files remain in the printed temp home.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { UsageAnalytics } from '../../dist/collectors/usage-analytics.js';

const root = fs.mkdtempSync('/tmp/codex-hud-native-perf-');
const home = path.join(root, 'home');
const sessions = path.join(home, 'sessions');
fs.mkdirSync(sessions, { recursive: true });
fs.mkdirSync(path.join(home, 'archived_sessions'), { recursive: true });
const fileCount = 100, perFile = 1000, eventCount = fileCount * perFile;
const now = Date.now(), start = now - 15 * 86400000;
let bytes = 0;
for (let f = 0; f < fileCount; f++) {
  const id = `synthetic-thread-${String(f).padStart(3, '0')}`;
  const lines = [
    JSON.stringify({ type: 'session_meta', timestamp: new Date(start).toISOString(), payload: { id, model: 'gpt-6.1-sol', effort: 'high', timestamp: new Date(start).toISOString() } }),
    JSON.stringify({ type: 'turn_context', timestamp: new Date(start).toISOString(), payload: { model: 'gpt-6.1-sol', effort: 'high', thread_id: id } }),
  ];
  for (let i = 0; i < perFile; i++) {
    const n = i * fileCount + f;
    const at = start + Math.floor(n * 15 * 86400000 / (eventCount - 1));
    lines.push(JSON.stringify({ type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type: 'token_count', thread_id: id, info: { total_token_usage: { input_tokens: 100 * (i + 1), cached_input_tokens: 20 * (i + 1), output_tokens: 25 * (i + 1), reasoning_output_tokens: 5 * (i + 1), total_tokens: 125 * (i + 1) }, last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 25, reasoning_output_tokens: 5, total_tokens: 125 } } } }));
  }
  const filename = path.join(sessions, `${id}.jsonl`);
  fs.writeFileSync(filename, `${lines.join('\n')}\n`);
  bytes += fs.statSync(filename).size;
}

const svc = new UsageAnalytics({ codexHome: home });
let ticks = 0, maxGap = 0, lastTick = performance.now();
const timer = setInterval(() => { const t = performance.now(); ticks++; maxGap = Math.max(maxGap, t - lastTick); lastTick = t; }, 10);
const resetWindow = async () => { await new Promise(resolve => setTimeout(resolve, 30)); ticks = 0; maxGap = 0; lastTick = performance.now(); };
const finishWindow = async () => { await new Promise(resolve => setTimeout(resolve, 30)); return { ticks, maxGapMs: +maxGap.toFixed(1) }; };
await resetWindow();
const coldStart = performance.now();
await svc.refresh();
const coldRefreshMs = performance.now() - coldStart;
const coldLoop = await finishWindow();
await resetWindow();
const firstSnapshotStart = performance.now();
const snapshot = svc.snapshot({ period: '30d', nowMs: now });
const firstSnapshotMs = performance.now() - firstSnapshotStart;
const firstSnapshotLoop = await finishWindow();
await resetWindow();
const warmStart = performance.now();
await svc.refresh();
const warmRefreshMs = performance.now() - warmStart;
const warmLoop = await finishWindow();
await resetWindow();
const snapshotCount = 100, snapStart = performance.now();
let checksum = 0;
for (let i = 0; i < snapshotCount; i++) checksum += svc.snapshot({ period: '30d', nowMs: now + 100 + i }).totals.events;
const snapshotTotalMs = performance.now() - snapStart;
const repaintLoop = await finishWindow();
clearInterval(timer);
const report = {
  node: process.version, files: fileCount, events: eventCount, bytes,
  bytesMiB: +(bytes / 1048576).toFixed(2), coldRefreshMs: +coldRefreshMs.toFixed(1),
  warmRefreshMs: +warmRefreshMs.toFixed(1), snapshots: snapshotCount,
  firstSnapshotMs: +firstSnapshotMs.toFixed(3), snapshotTotalMs: +snapshotTotalMs.toFixed(1), snapshotAvgMs: +(snapshotTotalMs / snapshotCount).toFixed(3),
  snapshotStatus: snapshot.status, attributableEvents: snapshot.totals.events,
  threads: snapshot.totals.threads, modelBuckets: snapshot.models.length, effortBuckets: snapshot.efforts.length,
  coverage: snapshot.coverage,
  eventLoop: { coldRefresh: coldLoop, firstSnapshot: firstSnapshotLoop, warmRefresh: warmLoop, cachedRepaint: repaintLoop }, checksum,
  tempHome: home,
};
console.log(JSON.stringify(report, null, 2));
svc.close();
