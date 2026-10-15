import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SmallModel, modelCommand, modelHttpRequest, callsToday, callsWithin, requestDigest, DEFAULT_API_MODELS, type ModelApi } from '../../src/collectors/small-model.js';

const now = Date.parse('2026-10-01T10:00:00Z');
const api: ModelApi = { base: 'http://synthetic.invalid/v1', model: '', key: '' };
const question = { feature: 'labels', system: 's', prompt: 'p' };
const reply = (text = 'answer') => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
function http(config: ModelApi = api, request = question, env: NodeJS.ProcessEnv = {}) {
  const result = modelHttpRequest(config, request, env);
  assert.ok(!('error' in result));
  return result;
}
function deferredFetch() {
  const pending: Array<{ url: string; init: RequestInit; resolve: (response: Response) => void }> = [];
  const fetcher = ((url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    pending.push({ url: String(url), init, resolve });
    init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  })) as typeof fetch;
  return { pending, fetcher };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('AGY retains named effort models and explicit override flags without a shell', () => {
  const low = modelCommand('agy', question, {});
  assert.equal(low.file, 'agy');
  assert.equal(low.args[low.args.indexOf('--model') + 1], 'gemini-3.8-flash-low');
  assert.ok(!low.args.includes('--effort'));
  assert.equal(low.args[1], 's\n\np');
  const medium = modelCommand('agy', { ...question, thinking: 'medium' }, {});
  assert.equal(medium.args[medium.args.indexOf('--model') + 1], 'gemini-3.8-flash-medium');
  const max = modelCommand('agy', { ...question, thinking: 'max' }, {});
  assert.equal(max.args[max.args.indexOf('--effort') + 1], 'max');
  const chosen = modelCommand('agy', { ...question, thinking: 'high' }, { CODEX_HUD_BRIEF_MODEL: 'synthetic-model' });
  assert.equal(chosen.args[chosen.args.indexOf('--model') + 1], 'synthetic-model');
  assert.equal(chosen.args[chosen.args.indexOf('--effort') + 1], 'high');
  assert.ok(!modelCommand('agy', { ...question, thinking: 'auto' }, {}).args.includes('--effort'));
});

test('API task routes, configurable tier models, and global overrides', () => {
  for (const [tier, features] of Object.entries({ lite: ['labels', 'title', 'approval'], low: ['progress', 'brief', 'digest', 'changes', 'unknown'], medium: ['recap', 'cause'] })) {
    for (const feature of features) {
      assert.equal(JSON.parse(http(api, { ...question, feature }).body).model, DEFAULT_API_MODELS[tier as keyof typeof DEFAULT_API_MODELS]);
      assert.equal(JSON.parse(http({ ...api, models: { lite: 'L', low: 'W', medium: 'M' } }, { ...question, feature }).body).model, { lite: 'L', low: 'W', medium: 'M' }[tier]);
      assert.equal(JSON.parse(http({ ...api, model: 'global' }, { ...question, feature }).body).model, 'global');
      assert.equal(JSON.parse(http({ ...api, model: 'global' }, { ...question, feature }, { CODEX_HUD_BRIEF_MODEL: 'environment' }).body).model, 'environment');
    }
  }
  assert.equal(http({ ...api, base: '' }).url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(http({ ...api, base: 'http://synthetic.invalid/v1/chat/completions/' }).url, api.base + '/chat/completions');
});

test('custom endpoints never receive the general OpenAI key; deliberate HUD keys still work', () => {
  const env = { OPENAI_API_KEY: 'synthetic-openai-key' };
  for (const base of [api.base, 'https://api.openai.com.evil.invalid/v1', 'http://api.openai.com/v1', 'https://api.openai.com:8443/v1']) {
    assert.equal(http({ ...api, base }, question, env).headers.authorization, undefined);
  }
  assert.equal(http({ ...api, base: '' }, question, env).headers.authorization, 'Bearer synthetic-openai-key');
  assert.equal(http(api, question, { ...env, CODEX_HUD_BRIEF_API_KEY: 'synthetic-hud-key' }).headers.authorization, 'Bearer synthetic-hud-key');
  assert.equal(http({ ...api, key: 'synthetic-explicit-key' }, question, env).headers.authorization, 'Bearer synthetic-explicit-key');
  assert.ok('error' in modelHttpRequest({ ...api, base: 'not a URL' }, question, env));
  assert.ok('error' in modelHttpRequest({ ...api, base: 'https://user:pass@api.openai.com/v1' }, question, env));
});

test('reasoning_effort is opt-in and unknown efforts are omitted', () => {
  const request = { ...question, thinking: 'high' as const };
  const plain = modelHttpRequest(api, request, {});
  const marked = modelHttpRequest({ ...api, reasoning: true }, request, {});
  const unknown = modelHttpRequest({ ...api, reasoning: true }, { ...question, thinking: 'max' }, {});
  assert.ok(!('error' in plain) && !('reasoning_effort' in JSON.parse(plain.body)));
  assert.ok(!('error' in marked) && JSON.parse(marked.body).reasoning_effort === 'high');
  assert.ok(!('error' in unknown) && !('reasoning_effort' in JSON.parse(unknown.body)));
});

test('call counts: last hour and since midnight', () => {
  assert.equal(callsWithin([now - 7200_000, now - 3000_000, now - 60_000, now], now, 3600_000), 3);
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  assert.equal(callsToday([midnight.getTime() - 1, midnight.getTime(), now], now), 2);
});

test('single flight, queued cancellation, active cancellation, and cancelAll', async () => {
  const { pending, fetcher } = deferredFetch();
  const model = new SmallModel({ env: {}, fetch: fetcher });
  model.configure({ backend: 'api', api });
  const first = model.submit(question);
  const second = model.submit({ ...question, prompt: 'two' });
  const third = model.submit({ ...question, prompt: 'three' });
  assert.equal(pending.length, 1);
  second.cancel();
  assert.deepEqual(await second.result, { ok: false, error: 'cancelled', cancelled: true });
  pending[0].resolve(reply());
  assert.equal((await first.result).ok, true);
  assert.equal(pending.length, 2);
  third.cancel();
  assert.equal(pending[1].init.signal?.aborted, true);
  assert.ok(!(await third.result).ok);
  await tick(); // The active slot is released only after the aborted fetch settles.
  const fourth = model.submit(question);
  const fifth = model.submit(question);
  model.cancelAll();
  for (const job of [fourth, fifth]) assert.deepEqual(await job.result, { ok: false, error: 'cancelled', cancelled: true });
  assert.equal(model.usage().lastHour, 3);
});

test('cancelled active fetch holds its slot until stopping finishes, also across configure/cancelAll', async () => {
  for (const kind of ['cancel', 'configure', 'cancelAll'] as const) {
    let completeStop!: () => void;
    let calls = 0;
    let finishNext!: () => void;
    const fetcher = ((_url: string, init: RequestInit) => {
      calls++;
      if (calls === 1) return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => { completeStop = () => reject(new Error('stopped')); }, { once: true });
      });
      return new Promise<Response>(resolve => { finishNext = () => resolve(reply()); });
    }) as typeof fetch;
    const model = new SmallModel({ env: {}, fetch: fetcher });
    model.configure({ backend: 'api', api });
    const first = model.submit(question);
    if (kind === 'cancel') first.cancel();
    else if (kind === 'configure') model.configure({ api: { ...api, model: 'new-model' } });
    else model.cancelAll();
    assert.ok(!(await first.result).ok);
    const next = model.submit({ ...question, prompt: 'replacement' });
    await tick();
    assert.equal(calls, 1, `${kind}: aborted request is still stopping`);
    completeStop();
    await tick();
    assert.equal(calls, 2, `${kind}: replacement starts after stopping`);
    finishNext();
    assert.equal((await next.result).ok, true);
  }
});

test('API redirects are refused and reflected credentials are removed from errors', async () => {
  const key = 'synthetic-secret';
  for (const transport of [false, true]) {
    const fetcher = (async (_url: string, init: RequestInit) => {
      assert.equal(init.redirect, 'error');
      if (transport) throw new Error(`unable to use ${key}`);
      return new Response(JSON.stringify({ error: { message: `invalid key ${key}` } }), { status: 401 });
    }) as typeof fetch;
    const model = new SmallModel({ env: {}, fetch: fetcher });
    model.configure({ backend: 'api', api: { ...api, key } });
    const result = await model.submit(question).result;
    assert.ok(!result.ok);
    if (!result.ok) { assert.ok(!result.error.includes(key)); assert.match(result.error, /\[redacted\]/); }
  }
});

test('freeze request, route, and environment at submission; configure cancels changed destinations', async () => {
  const { pending, fetcher } = deferredFetch();
  const env: NodeJS.ProcessEnv = { CODEX_HUD_BRIEF_MODEL: 'old' };
  const config = { ...api, models: { lite: 'original' } };
  const model = new SmallModel({ env, fetch: fetcher });
  model.configure({ backend: 'api', api: config });
  const first = model.submit(question);
  const request = { ...question, prompt: 'queued' };
  const second = model.submit(request);
  env.CODEX_HUD_BRIEF_MODEL = 'new'; request.prompt = 'mutated'; config.models.lite = 'mutated';
  pending[0].resolve(reply()); await first.result;
  assert.equal(JSON.parse(String(pending[1].init.body)).model, 'old');
  assert.equal(JSON.parse(String(pending[1].init.body)).messages[1].content, 'queued');
  const queued = model.submit(question);
  model.configure({ api: { ...api, base: 'http://other.invalid/v1' } });
  for (const job of [second, queued]) assert.deepEqual(await job.result, { ok: false, error: 'cancelled', cancelled: true });
  assert.equal(pending[1].init.signal?.aborted, true);
  const next = model.submit(question);
  await tick();
  assert.equal(pending[2].url, 'http://other.invalid/v1/chat/completions');
  model.configure({ backend: 'off' });
  assert.ok(!(await next.result).ok);
  assert.ok(!(await model.submit(question).result).ok);
});

test('cap, free cache, restart persistence, private files, and cache endpoint/model/thinking/feature identity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-model-cache-'));
  let calls = 0; let clock = now;
  const fetcher = (async () => { calls++; return reply(); }) as typeof fetch;
  try {
    const model = new SmallModel({ dir, env: {}, fetch: fetcher, clock: () => clock });
    model.configure({ backend: 'api', api, hourlyCap: 2 });
    const request = { ...question, cacheKey: 'synthetic-agent' };
    assert.deepEqual(await model.submit(request).result, { ok: true, text: 'answer' });
    assert.deepEqual(await model.submit(request).result, { ok: true, text: 'answer', cached: true });
    assert.equal(calls, 1);
    assert.equal((await model.submit({ ...question, prompt: 'two' }).result).ok, true);
    const refused = await model.submit({ ...question, prompt: 'three' }).result;
    assert.ok(!refused.ok && refused.refused && /cap reached \(2 per hour\)/.test(refused.error));
    clock += 3600_001;
    assert.equal((await model.submit({ ...question, prompt: 'three' }).result).ok, true);
    for (const name of ['cache.json', 'calls.json']) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
    const restarted = new SmallModel({ dir, env: {}, fetch: fetcher, clock: () => clock });
    restarted.configure({ backend: 'api', api, hourlyCap: 100 });
    assert.deepEqual(await restarted.submit(request).result, { ok: true, text: 'answer', cached: true });
    assert.equal(restarted.usage().lastHour, 1);
    restarted.configure({ api: { ...api, key: 'different-synthetic-secret' } });
    assert.deepEqual(await restarted.submit(request).result, { ok: true, text: 'answer', cached: true }, 'secrets are not cache identity');
    for (const config of [{ ...api, base: 'http://other.invalid/v1' }, { ...api, model: 'another-model' }, { ...api, reasoning: true }]) {
      restarted.configure({ api: config });
      assert.deepEqual(await restarted.submit(request).result, { ok: true, text: 'answer' });
    }
    restarted.configure({ api });
    assert.deepEqual(await restarted.submit({ ...request, thinking: 'high' }).result, { ok: true, text: 'answer' });
    assert.deepEqual(await restarted.submit({ ...request, feature: 'title' }).result, { ok: true, text: 'answer' });
    restarted.configure({ backend: 'off' });
    const off = await restarted.submit(request).result;
    assert.ok(!off.ok && off.refused);
    assert.notEqual(requestDigest(request), requestDigest({ ...request, prompt: 'other' }));
    assert.notEqual(requestDigest(request, { backend: 'api', model: 'm' }), requestDigest(request, { backend: 'agy', model: 'm' }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('off and invalid configuration do not call fetch or spend budget; HTTP, transport, malformed and empty errors', async () => {
  let calls = 0;
  const model = new SmallModel({ env: {}, fetch: (async () => { calls++; return reply(); }) as typeof fetch });
  assert.ok(!(await model.submit(question).result).ok);
  model.configure({ backend: 'api', api: { ...api, base: 'invalid' } });
  assert.deepEqual(await model.submit(question).result, { ok: false, error: 'api: invalid endpoint' });
  assert.equal(calls, 0); assert.equal(model.usage().lastHour, 0);
  for (const [response, expected] of [
    [new Response('{"error":{"message":"synthetic error"}}', { status: 429 }), 'api HTTP 429: synthetic error'],
    [new Response('not JSON'), 'api: reply is not JSON'],
    [new Response('{}'), 'api returned nothing'],
  ] as const) {
    const failing = new SmallModel({ env: {}, fetch: (async () => response) as typeof fetch });
    failing.configure({ backend: 'api', api });
    assert.deepEqual(await failing.submit(question).result, { ok: false, error: expected });
  }
  const failing = new SmallModel({ env: {}, fetch: (async () => { throw new Error('synthetic connection error'); }) as typeof fetch });
  failing.configure({ backend: 'api', api });
  assert.deepEqual(await failing.submit(question).result, { ok: false, error: 'api: synthetic connection error' });
  await tick();
});

test('public handle lifecycle notifies queued-to-running, holds cancellation slot, and retains cache generation time', async () => {
  let clock = now;
  const pending: Array<(response: Response) => void> = [];
  // Deliberately ignores abort: cancelling must not open a second network slot.
  const fetcher = (() => new Promise<Response>(resolve => pending.push(resolve))) as typeof fetch;
  const model = new SmallModel({ env: {}, fetch: fetcher, clock: () => clock });
  model.configure({ backend: 'api', api });
  const first = model.submit(question);
  const second = model.submit({ ...question, cacheKey: 'status-cache', prompt: 'two' });
  assert.equal(first.status, 'running');
  assert.equal(second.status, 'queued');
  const transitions: string[] = [];
  second.subscribe(() => { throw new Error('Synthetic broken observer'); });
  const unsubscribe = second.subscribe(() => transitions.push(second.status));
  first.cancel();
  assert.equal(first.status, 'settled');
  assert.equal(second.status, 'queued');
  assert.equal(pending.length, 1);
  pending[0](reply());
  await tick();
  assert.equal(second.status, 'running');
  assert.deepEqual(transitions, ['running']);
  clock += 1234;
  pending[1](reply('cached sentence'));
  await second.result;
  assert.equal(second.status, 'settled');
  assert.equal(second.generatedAt, clock);
  assert.deepEqual(transitions, ['running', 'settled']);
  unsubscribe();
  clock += 5678;
  const cached = model.submit({ ...question, cacheKey: 'status-cache', prompt: 'two' });
  assert.equal(cached.status, 'settled');
  assert.equal(cached.generatedAt, now + 1234);
  assert.equal((await cached.result).ok, true);
  assert.equal(pending.length, 2);
  assert.deepEqual(Object.keys(second).sort(), ['cancel','generatedAt','result','status','subscribe']);
});
