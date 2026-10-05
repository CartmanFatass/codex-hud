import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SmallModel, modelCommand, modelHttpRequest, callsToday, callsWithin, requestDigest } from '../../src/collectors/small-model.js';

const now = Date.parse('2026-10-01T10:00:00Z');

function fakeBin(script: string): { bin: string; calls: string; restore: () => void } {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-model-bin-'));
  const calls = path.join(bin, 'calls');
  fs.writeFileSync(path.join(bin, 'omp'), `#!/bin/sh\necho "$@" >> '${calls}'\n${script}\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  return { bin, calls, restore: () => { process.env.PATH = oldPath; fs.rmSync(bin, { recursive: true, force: true }); } };
}
const callCount = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').length : 0;

test('thinking levels reach each backend in the form it takes, and low is the command as it always was', () => {
  const low = modelCommand('omp', { system: 's', prompt: 'p' }, {});
  assert.equal(low.args[low.args.indexOf('--thinking') + 1], 'low');
  const high = modelCommand('omp', { system: 's', prompt: 'p', thinking: 'high' }, {});
  assert.equal(high.args[high.args.indexOf('--thinking') + 1], 'high');

  const agy = modelCommand('agy', { system: 's', prompt: 'p' }, {});
  assert.equal(agy.args[agy.args.indexOf('--model') + 1], 'gemini-3.8-flash-low');
  assert.ok(!agy.args.includes('--effort'), 'the default agy command is unchanged');
  const medium = modelCommand('agy', { system: 's', prompt: 'p', thinking: 'medium' }, {});
  assert.equal(medium.args[medium.args.indexOf('--model') + 1], 'gemini-3.8-flash-medium', 'a level agy names picks that model');
  const max = modelCommand('agy', { system: 's', prompt: 'p', thinking: 'max' }, {});
  assert.equal(max.args[max.args.indexOf('--effort') + 1], 'max');
  const chosen = modelCommand('agy', { system: 's', prompt: 'p', thinking: 'high' }, { CODEX_HUD_BRIEF_MODEL: 'claude-sonnet-5-5-low' });
  assert.equal(chosen.args[chosen.args.indexOf('--model') + 1], 'claude-sonnet-5-5-low');
  assert.equal(chosen.args[chosen.args.indexOf('--effort') + 1], 'high', 'a chosen model gets the level as a flag');
  assert.ok(!modelCommand('agy', { system: 's', prompt: 'p', thinking: 'auto' }, {}).args.includes('--effort'));
});

test('an api request sends reasoning_effort only when the endpoint is marked as taking it', () => {
  const plain = modelHttpRequest({ base: 'http://x/v1', model: 'm', key: '' }, { system: 's', prompt: 'p', thinking: 'high' }, {});
  assert.ok(!('error' in plain) && !('reasoning_effort' in JSON.parse(plain.body)));
  const marked = modelHttpRequest({ base: 'http://x/v1', model: 'm', key: '', reasoning: true }, { system: 's', prompt: 'p', thinking: 'high' }, {});
  assert.ok(!('error' in marked) && JSON.parse(marked.body).reasoning_effort === 'high');
  const unknown = modelHttpRequest({ base: 'http://x/v1', model: 'm', key: '', reasoning: true }, { system: 's', prompt: 'p', thinking: 'max' }, {});
  assert.ok(!('error' in unknown) && !('reasoning_effort' in JSON.parse(unknown.body)), 'a level with no api name is left out');
});

test('call counts: the last hour and since midnight', () => {
  const calls = [now - 2 * 3600_000, now - 3000_000, now - 60_000, now];
  assert.equal(callsWithin(calls, now, 3600_000), 3);
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  assert.equal(callsToday([midnight.getTime() - 1, midnight.getTime(), now], now), 2);
});

test('one request in flight at a time; a waiting one can be cancelled and never runs', async () => {
  const fake = fakeBin('sleep 0.2; echo "$7"');
  try {
    const model = new SmallModel();
    model.configure({ backend: 'omp' });
    const first = model.submit({ feature: 'a', system: 's', prompt: 'one' });
    const second = model.submit({ feature: 'b', system: 's', prompt: 'two' });
    const third = model.submit({ feature: 'c', system: 's', prompt: 'three' });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(callCount(fake.calls), 1, 'the others wait');
    second.cancel();
    assert.deepEqual(await second.result, { ok: false, error: 'cancelled', cancelled: true });
    assert.equal((await first.result).ok, true);
    assert.equal((await third.result).ok, true);
    assert.equal(callCount(fake.calls), 2, 'the cancelled request was never sent');
    assert.equal(model.usage().lastHour, 2);
  } finally { fake.restore(); }
});

test('the cap refuses with a reason, and a cached answer is free and survives a restart, 0600', async () => {
  const fake = fakeBin('echo answer');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-model-cache-'));
  try {
    let clock = now;
    const model = new SmallModel({ dir, clock: () => clock });
    model.configure({ backend: 'omp', hourlyCap: 2 });
    const request = { feature: 'label', system: 's', prompt: 'same', cacheKey: 'agent-1' };
    assert.deepEqual(await model.submit(request).result, { ok: true, text: 'answer' });
    assert.deepEqual(await model.submit(request).result, { ok: true, text: 'answer', cached: true });
    assert.equal(callCount(fake.calls), 1, 'the same input is never sent twice');
    assert.equal((await model.submit({ feature: 'x', system: 's', prompt: 'two' }).result).ok, true);
    const refused = await model.submit({ feature: 'x', system: 's', prompt: 'three' }).result;
    assert.ok(!refused.ok && refused.refused && /cap reached \(2 per hour\)/.test(refused.error));
    assert.equal(callCount(fake.calls), 2);
    clock += 3600_001;
    assert.equal((await model.submit({ feature: 'x', system: 's', prompt: 'three' }).result).ok, true, 'an hour later there is room again');

    for (const name of ['cache.json', 'calls.json']) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600, name);
    const restarted = new SmallModel({ dir, clock: () => clock });
    restarted.configure({ backend: 'omp', hourlyCap: 2 });
    assert.deepEqual(await restarted.submit(request).result, { ok: true, text: 'answer', cached: true });
    assert.equal(restarted.usage(clock).lastHour, 1, 'the call log holds across a restart');
    assert.notEqual(requestDigest(request), requestDigest({ ...request, prompt: 'other' }));
  } finally { fake.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an api request goes through the injected fetch; a misconfigured one is not counted', async () => {
  const seen: string[] = [];
  const fetcher = (async (url: string, init: { body: string }) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.parse(init.body).messages[1].content.toUpperCase() } }] }));
  }) as unknown as typeof fetch;
  const model = new SmallModel({ fetch: fetcher, env: {} });
  model.configure({ backend: 'api', api: { base: '', model: '', key: '' } });
  assert.deepEqual(await model.submit({ feature: 'x', system: 's', prompt: 'p' }).result, { ok: false, error: 'api: set briefingApiModel' });
  assert.equal(model.usage().lastHour, 0);
  model.configure({ api: { base: 'http://local/v1', model: 'm', key: '' } });
  assert.deepEqual(await model.submit({ feature: 'x', system: 's', prompt: 'hello' }).result, { ok: true, text: 'HELLO' });
  assert.deepEqual(seen, ['http://local/v1/chat/completions']);
  model.configure({ backend: 'off' });
  const off = await model.submit({ feature: 'x', system: 's', prompt: 'p' }).result;
  assert.ok(!off.ok && off.refused);
});
