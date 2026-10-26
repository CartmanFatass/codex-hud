import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SmallModel } from '../../src/collectors/small-model.js';
import { ModelProbe } from '../../src/collectors/model-probe.js';
import { defaultSettings } from '../../src/settings.js';
import { renderSettingsPage, handleSettingsInput, SETTING_ROWS } from '../../src/render/settings-page.js';
import { stripAnsi } from '../../src/render/colors.js';

const settings = () => ({ ...defaultSettings(), briefing: 'api' as const, briefingPaused: true,
  briefingApiBase: 'http://synthetic.invalid/v1', briefingApiKey: 'synthetic-only-key',
  briefingApiLiteModel: 'fixture-none', briefingApiLowModel: 'fixture-low', briefingApiMediumModel: 'fixture-high' });

test('explicit test uses three resolved routes and bounded synthetic prompts, without saving settings or secrets', async () => {
  const bodies: Array<Record<string, any>> = [];
  const probe = new ModelProbe({ env: {}, fetch: (async (_url, options) => {
    bodies.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
  }) as typeof fetch });
  await probe.run(settings());
  assert.deepEqual(bodies.map(body => body.model), ['fixture-none', 'fixture-low', 'fixture-high']);
  assert.ok(bodies.every(body => body.max_tokens === 256 && body.messages[1].content === 'Reply with OK.'));
  assert.ok(probe.current().rows.every(row => row.status === 'ok'));
  assert.ok(!JSON.stringify(probe.current()).includes('synthetic-only-key'));
  await probe.run({ ...settings(), briefing: 'off' });
  assert.equal(bodies.length, 3); assert.equal(probe.current().unavailable, true);
});

test('failed routes are classified and leave no reflected credentials in UI results', async () => {
  const probe = new ModelProbe({ env: {}, fetch: (async () => new Response(JSON.stringify({ error: { message: 'synthetic-only-key' } }), { status: 401 })) as typeof fetch });
  await probe.run(settings());
  assert.ok(probe.current().rows.every(row => row.failure === 'auth'));
  assert.ok(!JSON.stringify(probe.current()).includes('synthetic-only-key'));
});

test('editing connection configuration cancels active probes and rejects late results', async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const probe = new ModelProbe({ env: {}, fetch: (async (_url, options) => {
    entered();
    await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return new Response('{}');
  }) as typeof fetch });
  const run = probe.run(settings()); await started;
  probe.invalidate({ ...settings(), briefingApiKey: 'new-synthetic-key' });
  await run;
  assert.deepEqual(probe.current(), { running: false, rows: [] });
});

test('settings exposes a mouse and keyboard test action and keeps failure reasons visible on narrow panes', () => {
  const state = { draft: settings(), selected: SETTING_ROWS.findIndex(row => row.key === 'briefing'), offset: 0, message: '' };
  const frame = renderSettingsPage(state, 32, 24, { state: undefined, probe: { running: false, rows: [
    { tier: 'lite', model: 'a-very-long-synthetic-model-name', status: 'failed', failure: 'auth' },
  ] } });
  assert.ok(frame.probeAction);
  assert.equal(handleSettingsInput(state, { type: 'key', key: 'next-tab' }, frame).action, 'test-api');
  assert.equal(handleSettingsInput(state, { type: 'mouse', button: 'left', x: 1, y: frame.probeAction!.y }, frame).action, 'test-api');
  assert.match(frame.lines.map(stripAnsi).join('\n'), /Authentication failed/);
});


test('synthetic probes have their own shared telemetry category without changing route payloads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-probe-telemetry-'));
  const bodies: Array<Record<string, unknown>> = [];
  const probe = new ModelProbe({ dir, env: {}, fetch: (async (_url, options) => {
    bodies.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  }) as typeof fetch });
  try {
    await probe.run(settings());
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(bodies.map(body => body.model), ['fixture-none', 'fixture-low', 'fixture-high']);
    assert.ok(bodies.every(body => !('telemetryFeature' in body) && !('feature' in body)));
    const model = new SmallModel({ dir, env: {} });
    const summary = model.telemetry();
    assert.equal(summary.features.length, 1);
    assert.equal(summary.features[0].feature, 'probe');
    assert.equal(summary.features[0].requests, 3); assert.equal(summary.features[0].successes, 3);
    assert.equal(model.usage().lastHour, 3, 'synthetic tests retain the existing shared call budget');
    assert.ok(!JSON.stringify(summary).includes('synthetic-only-key'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
