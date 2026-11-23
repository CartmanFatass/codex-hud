import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { ModelRuntimeStore, callsByFeature } from '../../dist/collectors/model-runtime-store.js';
import { SmallModel, requestDigest } from '../../dist/collectors/small-model.js';
import { DecisionLabels } from '../../dist/collectors/decision-labels.js';
import { ModelProbe } from '../../dist/collectors/model-probe.js';
import { defaultSettings } from '../../dist/settings.js';
import { renderSettingsPage, SETTING_ROWS } from '../../dist/render/settings-page.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { setLanguage } from '../../dist/render/i18n.js';
const NOW = Date.parse('2030-01-15T12:00:00Z');
const HOUR = 3600000;
function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'call-breakdown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const reserve = (store, feature, cap = 0, now = NOW) =>
  store.reserve(null, randomUUID(), cap, () => now, () => false, undefined, feature);

test('mixed old/new reservations count only the last hour by feature and retain the existing pruning/cap', async (t) => {
  const dir = fixture(t), store = new ModelRuntimeStore(dir);
  fs.writeFileSync(join(dir, 'calls.json'), JSON.stringify([NOW - 86400000, NOW - HOUR - 1, NOW - HOUR, NOW - 1000]));
  for (const feature of ['job-sentence', 'title', 'job-sentence', 'try-brief', 'native-sentence', 'probe'])
    assert.equal((await reserve(store, feature)).kind, 'reserved');
  assert.deepEqual(callsByFeature(store.calls(), NOW), {
    'earlier-format': 1, 'job-sentence': 2, title: 1, 'try-brief': 1, 'native-sentence': 1, probe: 1,
  });
  const raw = JSON.parse(fs.readFileSync(join(dir, 'calls.json')));
  assert.equal(raw.length, 9, 'yesterday pruned, today retained even outside the hour');
  assert.ok(raw.every((call) => typeof call.at === 'number' && typeof call.feature === 'string'));
  assert.equal((await reserve(store, 'title', 7)).kind, 'refused', 'old entries still consume budget');
  assert.equal((await reserve(store, 'title', 0, NOW + HOUR)).kind, 'reserved');
  assert.deepEqual(callsByFeature(store.calls(), NOW + HOUR), { title: 1 });
  // A future reservation is absent from display but conservatively blocks clock-rollback overspend.
  assert.deepEqual(callsByFeature(store.calls(), NOW - HOUR), { 'earlier-format': 2 });
  assert.equal((await reserve(store, 'probe', 1, NOW - HOUR)).kind, 'refused');
});

for (const disk of [false, true]) test(`real SmallModel dispatch accounts features, not routing/cache names (disk=${disk})`, async (t) => {
  const dir = fixture(t), bodies = [];
  const model = new SmallModel({ ...(disk ? { dir } : {}), clock: () => NOW,
    env: { HOME: dir, HUD_HOME: dir, MISTRAL_API_KEY: 'synthetic' },
    fetch: async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ choices: [{ message: { content: 'Synthetic response.' } }] })); },
  });
  t.after(() => model.cancelAll()); model.configure({ backend: 'api', hourlyCap: 0 });
  const request = { feature: 'job-sentence', cacheKey: 'synthetic', system: '', prompt: 'synthetic' };
  assert.equal(requestDigest(request), requestDigest({ ...request, callFeature: 'native-sentence' }));
  for (const r of [request, { ...request, callFeature: 'native-sentence' },
    { ...request, cacheKey: 'native', callFeature: 'native-sentence' },
    { ...request, feature: 'title' }, { ...request, feature: 'try-brief' }])
    assert.equal((await model.submit(r).result).ok, true);
  assert.equal(bodies.length, 4, 'cache hit is not a reservation');
  assert.deepEqual(model.usage(), { today: 4, lastHour: 4, cap: 0,
    byFeature: { 'job-sentence': 1, 'native-sentence': 1, title: 1, 'try-brief': 1 } });
  assert.ok(bodies.every((body) => !JSON.stringify(body).includes('callFeature')));
});

test('real API probe reserves three probe calls without changing tier routing', async (t) => {
  const dir = fixture(t), efforts = [];
  const probe = new ModelProbe({ dir, clock: () => NOW, env: { HOME: dir, HUD_HOME: dir, MISTRAL_API_KEY: 'synthetic' },
    fetch: async (_url, init) => { efforts.push(JSON.parse(init.body).reasoning_effort); return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); },
  });
  t.after(() => probe.cancel());
  await probe.run({ ...defaultSettings(), modelEnabled: true });
  assert.deepEqual(efforts, ['none', 'low', 'high']);
  assert.ok(probe.current().rows.every((row) => row.status === 'ok'));
  assert.deepEqual(callsByFeature(new ModelRuntimeStore(dir).calls(), NOW), { probe: 3 });
});

test('concurrent panel processes share one labelled ledger and cap', async (t) => {
  const dir = fixture(t), module = new URL('../../dist/collectors/model-runtime-store.js', import.meta.url).href;
  const code = `import { ModelRuntimeStore } from ${JSON.stringify(module)};
    import { randomUUID } from 'node:crypto';
    const store = new ModelRuntimeStore(process.argv[1]);
    let n = 0;
    for (let i = 0; i < 8; i++) if ((await store.reserve(null, randomUUID(), 17, () => ${NOW}, () => false, undefined, process.argv[2])).kind === 'reserved') n++;
    console.log(n);`;
  const results = await Promise.all(['outcome', 'question-category', 'looping', 'review-severity'].map((feature) =>
    promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, dir, feature], { timeout: 15000 })));
  assert.equal(results.reduce((n, result) => n + Number(result.stdout), 0), 17);
  const calls = new ModelRuntimeStore(dir).calls();
  assert.equal(calls.length, 17);
  const counts = callsByFeature(calls, NOW);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 17);
  assert.ok(Object.values(counts).every((n) => n <= 8));
  assert.deepEqual(fs.readdirSync(join(dir, '.coordination')), []);
});

for (const lang of ['en', 'zh']) for (const width of [80, 120])
  test(`Settings breakdown lines are largest-first, width-cut, read-free and absent at zero: ${lang}/${width}`, (t) => {
    const dir = fixture(t), decisionDir = join(dir, 'decision-api'); fs.mkdirSync(decisionDir);
    const llm = [NOW, ...Array.from({ length: 40 }, () => ({ at: NOW, feature: 'job-sentence' })),
      ...Array.from({ length: 3 }, () => ({ at: NOW, feature: 'title' })), { at: NOW, feature: 'home-brief' }];
    const decisions = ['outcome', 'kind', 'looping', 'question-category', 'review-severity', 'home-ranking', 'quiet-job']
      .flatMap((feature, i) => Array.from({ length: i + 1 }, () => ({ at: NOW, feature })));
    fs.writeFileSync(join(dir, 'calls.json'), JSON.stringify(llm));
    fs.writeFileSync(join(decisionDir, 'calls.json'), JSON.stringify(decisions));
    const model = new SmallModel({ dir, clock: () => NOW });
    const labels = new DecisionLabels(dir, () => {}, { HOME: dir, HUD_HOME: dir }, undefined, () => NOW);
    const read = t.mock.method(fs, 'readFileSync');
    syncBuiltinESMExports();
    t.after(() => { read.mock.restore(); syncBuiltinESMExports(); });
    const health = { state: undefined, modelCalls: model.usage(), decisionCalls: labels.usage() };
    assert.equal(read.mock.callCount(), 2, 'one existing read per ledger supplies counters and features');
    const previous = setLanguage(lang); t.after(() => setLanguage(previous));
    const state = { draft: defaultSettings(), selected: SETTING_ROWS.findIndex((r) => r.key === 'modelCallsPerHour'), offset: 0, message: '', advanced: true };
    const frame = renderSettingsPage(state, width, 60, health), lines = frame.lines.map(stripAnsi);
    assert.ok(frame.lines.every((line) => visualLength(line) === width));
    const modelAt = lines.findIndex((line) => line.includes(lang === 'en' ? 'Calls this hour' : '本小时调用'));
    const decisionAt = lines.findIndex((line) => line.includes(lang === 'en' ? 'Decision calls this hour' : '本小时决策调用'));
    assert.match(lines[modelAt], /45\/60\s*$/, 'old Home brief still counts toward the hourly cap');
    assert.match(lines[decisionAt], /28\/∞\s*$/, 'old kind and ranking calls still count toward the total');
    assert.equal(lines[modelAt + 1].trim(), lang === 'en'
      ? 'Job sentence 40 · Decision title 3 · Earlier format 1'
      : '任务句子 40 · 决定标题 3 · 早期格式 1');
    assert.ok(lines[decisionAt + 1].trim().startsWith(lang === 'en' ? 'Quiet job 7 · Review severity 5' : '静默任务 7 · 评审严重度 5'));
    assert.doesNotMatch(lines[decisionAt + 1], /\bkind\b|Home ranking|类型|首页排序/);
    const breakdowns = (rows) => rows.filter((line) => line.includes(' · ') && !/^(?:\*| ) (?:Display|Panel|Models|Workers|Codex|显示|面板|模型|工作者) · /.test(line));
    assert.equal(breakdowns(lines).length, 2, 'exactly one breakdown per counter');
    const zero = renderSettingsPage(state, width, 60, { state: undefined,
      modelCalls: { today: 0, lastHour: 0, cap: 60, byFeature: {} }, decisionCalls: { lastHour: 0, cap: 0, byFeature: {} } });
    assert.equal(breakdowns(zero.lines.map(stripAnsi)).length, 0);
    assert.equal(read.mock.callCount(), 2, 'rendering adds no file reads');
  });
