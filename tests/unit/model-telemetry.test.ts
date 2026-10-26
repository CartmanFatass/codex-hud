import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SmallModel, modelHttpRequest, requestDigest } from '../../src/collectors/small-model.js';
import { ModelRuntimeStore } from '../../src/collectors/model-runtime-store.js';
import { boundedTelemetry, TELEMETRY_RECORD_LIMIT, TELEMETRY_WINDOW_MS, type ModelTelemetryRecord } from '../../src/collectors/model-telemetry.js';
import { modelTelemetryLines } from '../../src/render/model-telemetry.js';
import { visualLength } from '../../src/render/colors.js';
import { setLanguage } from '../../src/render/i18n.js';

const SECRET = 'SYNTHETIC_SECRET_DO_NOT_EXPORT';
const request = { feature: 'recap', system: SECRET, prompt: SECRET, cacheKey: SECRET };
const api = { base: `https://synthetic.invalid/v1?token=${SECRET}`, model: SECRET, key: SECRET };
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: SECRET } }] }));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('per-feature accounting separates generated replies, cached consumers, failures, limits and unknown billing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-telemetry-'));
  let now = 1_000_000; let calls = 0;
  const model = new SmallModel({ dir, env: {}, clock: () => now, fetch: (async () => {
    calls++; now += 125;
    return calls === 2 ? new Response(JSON.stringify({ error: { message: `${SECRET} /private/path?token=${SECRET}` } }), { status: 429 }) : reply();
  }) as typeof fetch });
  model.configure({ backend: 'api', api, hourlyCap: 2 });
  try {
    assert.ok((await model.submit(request).result).ok);
    const cached = await model.submit(request).result;
    assert.ok(cached.ok && cached.cached);
    const failed = await model.submit({ ...request, feature: 'labels', cacheKey: undefined }).result;
    assert.ok(!failed.ok && failed.classification === 'rate-limit');
    assert.ok(!JSON.stringify(failed).includes(SECRET));
    const limited = await model.submit({ ...request, feature: 'changes', cacheKey: undefined }).result;
    assert.ok(!limited.ok && limited.reason === 'hourly-cap');
    await model.flushTelemetry();
    const summary = model.telemetry();
    const recap = summary.features.find(row => row.feature === 'recap')!;
    assert.deepEqual(recap, { feature: 'recap', requests: 2, pending: 0, successes: 1, failures: 0,
      cacheHits: 1, cancelled: 0, limited: 0, refused: 0, durationSamples: 1, meanDurationMs: 125, tokens: null, cost: null });
    const labels = summary.features.find(row => row.feature === 'labels')!;
    assert.equal(labels.failures, 1); assert.equal(labels.limited, 1); assert.equal(labels.meanDurationMs, 125);
    const changes = summary.features.find(row => row.feature === 'changes')!;
    assert.equal(changes.limited, 1); assert.equal(changes.refused, 1); assert.equal(changes.meanDurationMs, null);
    assert.equal(calls, 2, 'telemetry cannot send probes or retry a failure');
    const stored = fs.readFileSync(path.join(dir, 'telemetry', 'telemetry.json'), 'utf8');
    assert.ok(!stored.includes(SECRET));
    assert.ok(!JSON.stringify(summary).includes(SECRET));
    assert.equal(fs.statSync(path.join(dir, 'telemetry', 'telemetry.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, 'telemetry', '.coordination')).mode & 0o777, 0o700);
    const next = new SmallModel({ dir, env: {}, clock: () => now });
    assert.deepEqual(next.telemetry().features, summary.features, 'restart reads bounded shared history');
    assert.equal(summary.persistence, 'shared');
  } finally { await model.flushTelemetry(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pending and cancellation are lifecycle facts, never successes or token estimates', async () => {
  let now = 10_000; let finish!: () => void; let sent = 0;
  const model = new SmallModel({ env: {}, clock: () => now, fetch: (() => {
    sent++; return new Promise<Response>(resolve => { finish = () => resolve(reply()); });
  }) as typeof fetch });
  model.configure({ backend: 'api', api });
  const first = model.submit(request);
  const queued = model.submit({ ...request, feature: SECRET, cacheKey: undefined });
  assert.equal(model.telemetry().features.find(row => row.feature === 'recap')?.pending, 1);
  assert.equal(model.telemetry().features.find(row => row.feature === 'other')?.pending, 1);
  now += 200; queued.cancel(); first.cancel();
  assert.ok(!(await queued.result).ok); assert.ok(!(await first.result).ok);
  assert.equal(model.telemetry().features.find(row => row.feature === 'recap')?.meanDurationMs, 200);
  assert.equal(model.telemetry().features.find(row => row.feature === 'other')?.meanDurationMs, null);
  assert.equal(model.telemetry().features.find(row => row.feature === 'other')?.cancelled, 1);
  finish(); await tick();
  assert.equal(sent, 1); assert.ok(!JSON.stringify(model.telemetry()).includes(SECRET));
});

test('shared telemetry merges concurrent writers under its own lock and bounds records and time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-telemetry-merge-'));
  const now = 100_000_000;
  const a = new ModelRuntimeStore(dir); const b = new ModelRuntimeStore(dir);
  const record = (at = now): ModelTelemetryRecord => ({ id: randomUUID(), feature: 'labels', at,
    outcome: 'success', durationMs: 10, failure: null });
  try {
    await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? a : b).recordTelemetry(record(), now)));
    assert.equal(a.telemetry().length, 24);
    const records = Array.from({ length: TELEMETRY_RECORD_LIMIT + 10 }, (_, i) => record(now + i));
    records.push(record(now - TELEMETRY_WINDOW_MS - 1));
    assert.equal(boundedTelemetry(records, now).length, TELEMETRY_RECORD_LIMIT);
    fs.writeFileSync(path.join(dir, 'telemetry.json'), JSON.stringify(records));
    await a.recordTelemetry(record(), now);
    assert.equal(a.telemetry().length, TELEMETRY_RECORD_LIMIT);
    assert.ok(a.telemetry().every(row => row.at >= now - TELEMETRY_WINDOW_MS));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('telemetry corruption is visible and cannot disable model requests or expose source errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-telemetry-error-'));
  fs.mkdirSync(path.join(dir, 'telemetry')); fs.writeFileSync(path.join(dir, 'telemetry', 'telemetry.json'), SECRET);
  let calls = 0;
  const model = new SmallModel({ dir, env: {}, fetch: (async () => { calls++; return reply(); }) as typeof fetch });
  model.configure({ backend: 'api', api });
  try {
    assert.ok((await model.submit(request).result).ok);
    await model.flushTelemetry();
    assert.equal(calls, 1); assert.equal(model.telemetry().persistence, 'unavailable');
    assert.ok(!JSON.stringify(model.telemetry()).includes(SECRET));
  } finally { await model.flushTelemetry(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('telemetry rendering wraps both languages and states unavailable measurements explicitly', () => {
  const model = new SmallModel({ env: {} });
  for (const lang of ['en', 'zh'] as const) {
    const old = setLanguage(lang);
    try { for (const width of [24, 32, 56]) {
      const lines = modelTelemetryLines(model.telemetry(10_000), width);
      assert.ok(lines.every(line => visualLength(line) <= width));
      assert.ok(lines.length > 0);
    } } finally { setLanguage(old); }
  }
  assert.match(modelTelemetryLines(undefined, 120).join(' '), /unavailable/);
});

test('bursts coalesce into bounded persistence without adding requests or retaining source inputs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-telemetry-burst-'));
  const model = new SmallModel({ dir, env: {}, clock: () => 100_000_000 });
  try {
    // Backend remains off: these are observed refusals, not provider calls.
    const handles = Array.from({ length: TELEMETRY_RECORD_LIMIT + 25 }, () => model.submit({ ...request, cacheKey: undefined }));
    assert.equal(model.telemetry().retained, TELEMETRY_RECORD_LIMIT);
    await Promise.all(handles.map(handle => handle.result));
    await model.flushTelemetry();
    const stored = fs.readFileSync(path.join(dir, 'telemetry', 'telemetry.json'), 'utf8');
    assert.equal(JSON.parse(stored).length, TELEMETRY_RECORD_LIMIT);
    assert.ok(!stored.includes(SECRET));
    assert.equal(model.usage().today, 0);
    assert.equal(model.telemetry().atCapacity, true);
  } finally { await model.flushTelemetry(); fs.rmSync(dir, { recursive: true, force: true }); }
});


test('telemetry category override is excluded from provider bodies and cache identity', async () => {
  const base = { ...request, feature: 'labels' };
  const overridden = { ...base, telemetryFeature: 'probe' as const };
  assert.equal(requestDigest(base), requestDigest(overridden));
  assert.deepEqual(modelHttpRequest(api, base, {}), modelHttpRequest(api, overridden, {}));
  const model = new SmallModel({ env: {}, fetch: (async () => reply()) as typeof fetch });
  model.configure({ backend: 'api', api });
  await model.submit(base).result;
  const cached = await model.submit(overridden).result;
  assert.ok(cached.ok && cached.cached);
  assert.equal(model.telemetry().features.find(row => row.feature === 'labels')?.successes, 1);
  assert.equal(model.telemetry().features.find(row => row.feature === 'probe')?.cacheHits, 1);
  assert.equal(model.usage().lastHour, 1);
});

test('wall clock rollback leaves elapsed model time unavailable rather than inventing zero duration', async () => {
  let now = 10_000;
  const model = new SmallModel({ env: {}, clock: () => now, fetch: (async () => { now -= 1000; return reply(); }) as typeof fetch });
  model.configure({ backend: 'api', api });
  await model.submit(request).result;
  now = 10_000;
  assert.equal(model.telemetry().features[0].meanDurationMs, null);
  assert.equal(model.telemetry().features[0].durationSamples, 0);
});
