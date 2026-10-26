/**
 * Synthetic single-rollout responsiveness probe. Compile to an isolated output:
 *   node node_modules/typescript/bin/tsc -p tsconfig.test.json --outDir /tmp/hud-probe
 *   node tests/performance/adaptive-scan.mjs /tmp/hud-probe/src /tmp/hud-probe-result.json
 * No live rollouts, panes, API or model calls. Optional result is created with wx.
 * A queued callback models input dispatch, not a native terminal acceptance test.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL, fileURLToPath } from 'node:url';

const compiledSource = path.resolve(process.argv[2] ?? 'dist');
const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceNames = ['src/collectors/subagent-tree.ts', 'src/collectors/adaptive-poll.ts', 'tests/performance/adaptive-scan.mjs'];
const compiledNames = ['collectors/subagent-tree.js', 'collectors/adaptive-poll.js'];
const hashes = (root, names) => Object.fromEntries(names.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
const sourceHashes = hashes(checkout, sourceNames);
const compiledHashes = hashes(compiledSource, compiledNames);
const { buildSubagentTree, buildSubagentTreeYielding, resetSubagentLinkCache, useTreeScanStore } = await import(
  pathToFileURL(path.join(compiledSource, 'collectors/subagent-tree.js')).href
);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-adaptive-probe-'));
const now = Date.parse('2026-10-25T12:00:00Z');
const line = value => `${JSON.stringify(value)}\n`;
const immediate = () => new Promise(resolve => setImmediate(resolve));
const file = path.join(dir, 'worker.jsonl');
const meta = line({ type: 'session_meta', payload: { id: 'worker', parent_thread_id: 'root', agent_path: '/root/worker' } });
const event = type => line({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type, turn_id: 't1' } });
const filler = line({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'x'.repeat(1024) } });
const listed = () => {
  const stat = fs.statSync(file);
  return [{ path: file, sessionId: 'worker', timestamp: new Date(now), size: stat.size, modifiedAt: stat.mtime, ino: stat.ino }];
};

async function measure(yielding) {
  resetSubagentLinkCache();
  useTreeScanStore(undefined);
  const files = listed();
  let lastTimer = performance.now();
  let maxTimerGapMs = 0;
  let timerCallbacks = 0;
  const timer = setInterval(() => {
    const at = performance.now();
    maxTimerGapMs = Math.max(maxTimerGapMs, at - lastTimer);
    lastTimer = at;
    timerCallbacks++;
  }, 2);
  let completed = false;
  let inputDelayMs;
  let inputDuringScan;
  const started = performance.now();
  const input = new Promise(resolve => setImmediate(() => {
    inputDelayMs = performance.now() - started;
    inputDuringScan = !completed;
    resolve();
  }));
  const cpu = process.cpuUsage();
  const tree = yielding
    ? await buildSubagentTreeYielding('root', [], 3, now, files)
    : buildSubagentTree('root', [], 3, now, files);
  const wallMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  completed = true;
  await input;
  await new Promise(resolve => setTimeout(resolve, 3));
  clearInterval(timer);
  return { tree, metrics: { wallMs, cpuMs: (used.user + used.system) / 1000, inputDelayMs, inputDuringScan, maxTimerGapMs, timerCallbacks } };
}

try {
  const cases = [];
  for (const [name, content] of [
    ['many-records', filler.repeat(40_000)],
    ['large-record', filler.repeat(20_000) + line({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: '字🙂'.repeat(800_000) } })],
  ]) {
    fs.writeFileSync(file, meta + event('task_started') + content + event('task_complete'));
    const rounds = [];
    for (let round = 0; round < 3; round++) {
      const sync = await measure(false);
      const yielding = await measure(true);
      assert.deepEqual(yielding.tree, sync.tree);
      assert.equal(yielding.tree.nodes[0].status, 'completed');
      rounds.push({ sync: sync.metrics, yielding: yielding.metrics, identicalTree: true });
    }
    cases.push({ name, fileBytes: fs.statSync(file).size, rounds });
  }
  const result = {
    measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    sourceHashes, compiledHashes,
    boundary: 'Synthetic cached-filesystem run; queued callback and timer delay, not native terminal input. Individual JSON parsing, first-line peeks, listing and cache writes remain synchronous. No universal throughput or latency claim.',
    cases,
  };
  assert.deepEqual(hashes(checkout, sourceNames), sourceHashes, 'source files changed during the probe');
  assert.deepEqual(hashes(compiledSource, compiledNames), compiledHashes, 'compiled files changed during the probe');
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (process.argv[3]) fs.writeFileSync(process.argv[3], json, { flag: 'wx', mode: 0o600 });
  process.stdout.write(json);
} finally {
  resetSubagentLinkCache();
  fs.rmSync(dir, { recursive: true, force: true });
}
