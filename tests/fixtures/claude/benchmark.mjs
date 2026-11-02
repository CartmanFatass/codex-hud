#!/usr/bin/env node
/** Run after npm run build && npm run build:test. All files belong to this process and are removed. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createClaudeReader } from '../../../dist/harness/claude/reader.js';
import { appendSyntheticTranscript, MiB, SESSION } from '../../../dist-test/tests/fixtures/claude/transcripts.js';

function argument(name, fallback) {
  const value = process.argv.find((item) => item.startsWith(`--${name}=`));
  const n = value ? Number(value.slice(name.length + 3)) : fallback;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
}

const coldIterations = argument('cold-iterations', 3);
const appendIterations = argument('append-iterations', 100);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-benchmark-'));
const originalHome = process.env.HUD_HOME;
process.env.HUD_HOME = path.join(root, 'hud');
fs.mkdirSync(process.env.HUD_HOME);
const file = path.join(root, SESSION + '.jsonl');
const options = {
  ref: { harness: 'claude', sourceId: 'e'.repeat(64), sessionId: SESSION, threadId: null },
  resolveFile: () => file,
  serverNames: ['hud'],
  statusline: {
    session_id: SESSION,
    transcript_path: file,
    context_window: { context_window_size: 200000 },
  },
};
const slice = { maxBytes: 4 * MiB, maxRecords: 2000, budgetMs: 20 };

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
  return {
    samples: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? 0,
  };
}

async function catchUp(reader, budget = slice) {
  const samples = [];
  let result;
  do {
    const start = performance.now();
    result = await reader.read(budget);
    const wallMs = performance.now() - start;
    samples.push({
      wallMs,
      elapsedMs: result.stats?.elapsedMs ?? null,
      bytesRead: result.stats?.bytesRead ?? null,
      recordsRead: result.stats?.recordsRead ?? null,
      continuation: result.observation.coverage.state === 'catching_up',
    });
    if (samples.length > 100000) throw new Error('reader did not finish synthetic workload');
  } while (result.observation.coverage.state === 'catching_up');
  return { result, samples };
}

function summarize(samples) {
  return {
    wallMs: distribution(samples.map((item) => item.wallMs)),
    measuredElapsedMs: distribution(samples.map((item) => item.elapsedMs ?? 0)),
    bytesRead: samples.reduce((sum, item) => sum + (item.bytesRead ?? 0), 0),
    recordsRead: samples.reduce((sum, item) => sum + (item.recordsRead ?? 0), 0),
    continuationCount: samples.filter((item) => item.continuation).length,
    wallOver20Ms: samples.filter((item) => item.wallMs > 20).length,
    wallOver50Ms: samples.filter((item) => item.wallMs > 50).length,
  };
}

try {
  const generatedColdRecords = appendSyntheticTranscript(file, 100 * MiB);
  const cold = [];
  let reader;
  for (let i = 0; i < coldIterations; i++) {
    reader = createClaudeReader(options);
    const start = performance.now();
    const reading = await catchUp(reader);
    cold.push({ iteration: i + 1, fullReadWallMs: performance.now() - start, ...summarize(reading.samples) });
  }
  const incrementalSamples = [];
  const incrementalFullTicks = [];
  let generatedAppendRecords = 0;
  for (let i = 0; i < appendIterations; i++) {
    generatedAppendRecords += appendSyntheticTranscript(file, MiB, 1000000 + i * 10000);
    const start = performance.now();
    const reading = await catchUp(reader);
    incrementalFullTicks.push(performance.now() - start);
    incrementalSamples.push(...reading.samples);
  }
  // Deliberately force continuation to demonstrate recovery independently of machine speed.
  appendSyntheticTranscript(file, MiB, 9000000);
  const forced = await catchUp(reader, { ...slice, maxRecords: 8 });
  appendSyntheticTranscript(file, MiB, 10000000);
  const beforeDeadline = forced.result.checkpoint.offset;
  const expiredStart = performance.now();
  const expired = await reader.read({ ...slice, deadlineMs: performance.now() - 1 });
  const expiredWallMs = performance.now() - expiredStart;
  const deadlineStart = performance.now();
  const shared = await reader.read({ ...slice, deadlineMs: performance.now() + 2 });
  const sharedWallMs = performance.now() - deadlineStart;
  const resumed = await catchUp(reader);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        cpu: os.cpus()[0]?.model ?? 'unknown',
        cache: 'Fresh reader instances; OS page cache is warm after generation. No OS cache eviction.',
        coldBytes: 100 * MiB,
        appendedBytesPerIteration: MiB,
        slice,
        generatedColdRecords,
        cold,
        incremental: {
          appendIterations,
          generatedAppendRecords,
          fullTickWallMs: distribution(incrementalFullTicks),
          ...summarize(incrementalSamples),
        },
        forcedRecordContinuation: summarize(forced.samples),
        sharedDeadline: {
          clock: 'absolute performance.now() milliseconds',
          expired: {
            wallMs: expiredWallMs,
            bytesRead: expired.stats?.bytesRead,
            recordsRead: expired.stats?.recordsRead,
            cursorUnchanged: expired.checkpoint.offset === beforeDeadline,
            coverage: expired.observation.coverage.state,
          },
          remaining2Ms: { wallMs: sharedWallMs, ...shared.stats, coverage: shared.observation.coverage.state },
          resumed: summarize(resumed.samples),
        },
      },
      null,
      2
    )
  );
  if (expired.checkpoint.offset !== beforeDeadline || expired.stats?.bytesRead !== 0) {
    process.exitCode = 1;
  }
} finally {
  if (originalHome === undefined) delete process.env.HUD_HOME;
  else process.env.HUD_HOME = originalHome;
  fs.rmSync(root, { recursive: true, force: true });
}
