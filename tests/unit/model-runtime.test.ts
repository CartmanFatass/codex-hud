import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { SmallModel, modelHttpRequest, requestDigest, type ModelResult } from '../../src/collectors/small-model.js';

const question = { feature: 'labels', system: 'Synthetic test instructions', prompt: 'Synthetic test input' };
const api = { base: 'http://synthetic.invalid/v1', model: '', key: '' };
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: 'Synthetic answer' } }] }));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hud-model-runtime-'));
const moduleUrl = new URL('../../src/collectors/small-model.js', import.meta.url).href;

// Real child processes share only the synthetic endpoint and private state directory.
const childScript = `
import { SmallModel } from ${JSON.stringify(moduleUrl)};
const [dir, base, key] = process.argv.slice(1);
const model = new SmallModel({ dir, env: {} });
model.configure({ backend: 'api', api: { base, model: '', key: '' }, hourlyCap: Number(process.env.SYNTHETIC_MODEL_CAP) });
let handle;
process.on('message', command => {
  if (command === 'go') {
    handle = model.submit({ feature: 'labels', system: 'Synthetic test instructions', prompt: 'Synthetic test input', cacheKey: key });
    process.send({ type: 'submitted', status: handle.status });
    handle.result.then(result => process.send({ type: 'result', result, generatedAt: handle.generatedAt }));
  } else if (command === 'cancel') handle?.cancel();
  else if (command === 'close') { model.cancelAll(); process.disconnect(); }
});
process.send({ type: 'ready' });
`;

interface Event { type: string; result?: ModelResult; generatedAt?: number; status?: string }
function worker(dir: string, base: string, key: string, cap: number) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, dir, base, key], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, SYNTHETIC_MODEL_CAP: String(cap) },
  });
  let error = '';
  child.stderr?.on('data', chunk => { error += String(chunk); });
  const events: Event[] = [];
  const waiters = new Set<() => void>();
  child.on('message', event => { events.push(event as Event); for (const wake of waiters) wake(); });
  let closed = false;
  child.on('close', () => { closed = true; for (const wake of waiters) wake(); });
  const event = async (type: string): Promise<Event> => {
    const deadline = Date.now() + 10_000;
    while (true) {
      const index = events.findIndex(value => value.type === type);
      if (index >= 0) return events.splice(index, 1)[0];
      if (closed) throw new Error(`Synthetic worker exited before ${type}: ${error}`);
      if (Date.now() > deadline) throw new Error(`Synthetic worker timed out before ${type}`);
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, 100);
        function done() { clearTimeout(timer); waiters.delete(done); resolve(); }
        waiters.add(done);
      });
    }
  };
  return { child, event, send: (command: string) => child.send(command) };
}

async function stop(children: ChildProcess[]) {
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  }));
}

async function endpoint(respond: (response: ServerResponse, index: number) => void = response => {
  response.end(JSON.stringify({ choices: [{ message: { content: 'Synthetic answer' } }] }));
}) {
  let calls = 0;
  const server = createServer((request, response) => { request.resume(); respond(response, ++calls); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { base: `http://127.0.0.1:${address.port}/v1`, calls: () => calls,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('real processes atomically reserve the shared hourly budget without losing calls', async () => {
  const dir = temp();
  const service = await endpoint(response => setTimeout(() => response.end(JSON.stringify({ choices: [{ message: { content: 'Synthetic answer' } }] })), 40));
  const workers = Array.from({ length: 10 }, (_, index) => worker(dir, service.base, `synthetic-${index}`, 3));
  try {
    await Promise.all(workers.map(value => value.event('ready')));
    workers.forEach(value => value.send('go'));
    const results = await Promise.all(workers.map(value => value.event('result')));
    assert.equal(results.filter(value => value.result?.ok).length, 3);
    assert.equal(results.filter(value => value.result && !value.result.ok && value.result.reason === 'hourly-cap').length, 7);
    assert.equal(service.calls(), 3);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'calls.json'), 'utf8')).length, 3);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'cache.json'), 'utf8'))).length, 3);
    for (const name of ['calls.json', 'cache.json', 'claims.json']) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, '.coordination')).mode & 0o777, 0o700);
  } finally { await stop(workers.map(value => value.child)); await service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('independent concurrent cache writes merge and a live panel reloads another panel cache', async () => {
  const dir = temp();
  const service = await endpoint((response, index) => setTimeout(() => response.end(JSON.stringify({ choices: [{ message: { content: `Synthetic answer ${index}` } }] })), (7 - index) * 15));
  const workers = Array.from({ length: 6 }, (_, index) => worker(dir, service.base, `synthetic-${index}`, 20));
  try {
    const reader = new SmallModel({ dir, env: {} });
    reader.configure({ backend: 'api', api: { ...api, base: service.base } });
    assert.equal(reader.usage().today, 0);
    await Promise.all(workers.map(value => value.event('ready')));
    workers.forEach(value => value.send('go'));
    const results = await Promise.all(workers.map(value => value.event('result')));
    assert.ok(results.every(value => value.result?.ok));
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'cache.json'), 'utf8'))).length, 6);
    for (let index = 0; index < workers.length; index++) {
      const result = await reader.submit({ ...question, cacheKey: `synthetic-${index}` }).result;
      assert.ok(result.ok && result.cached);
    }
    assert.equal(service.calls(), 6);
    assert.equal(reader.usage().lastHour, 6);
  } finally { await stop(workers.map(value => value.child)); await service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cross-process same-input claim deduplicates before the cap and preserves generation time', async () => {
  const dir = temp();
  const service = await endpoint(response => setTimeout(() => response.end(JSON.stringify({ choices: [{ message: { content: 'Synthetic shared answer' } }] })), 120));
  const workers = Array.from({ length: 7 }, () => worker(dir, service.base, 'synthetic-shared', 1));
  try {
    await Promise.all(workers.map(value => value.event('ready')));
    workers.forEach(value => value.send('go'));
    const results = await Promise.all(workers.map(value => value.event('result')));
    assert.ok(results.every(value => value.result?.ok));
    assert.equal(results.filter(value => value.result?.ok && value.result.cached).length, 6);
    assert.equal(new Set(results.map(value => value.generatedAt)).size, 1);
    assert.equal(service.calls(), 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'calls.json'), 'utf8')).length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8')), {});
  } finally { await stop(workers.map(value => value.child)); await service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a killed claim owner is recovered while its reserved call remains charged', async () => {
  const dir = temp();
  let received!: () => void;
  const sent = new Promise<void>(resolve => { received = resolve; });
  const service = await endpoint((response, index) => {
    if (index === 1) received();
    else response.end(JSON.stringify({ choices: [{ message: { content: 'Synthetic recovered answer' } }] }));
  });
  const owner = worker(dir, service.base, 'synthetic-dead-owner', 3);
  const successor = worker(dir, service.base, 'synthetic-dead-owner', 3);
  try {
    await Promise.all([owner.event('ready'), successor.event('ready')]);
    owner.send('go'); await sent;
    await stop([owner.child]);
    successor.send('go');
    const result = await successor.event('result');
    assert.ok(result.result?.ok);
    assert.equal(service.calls(), 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'calls.json'), 'utf8')).length, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8')), {});
  } finally { await stop([owner.child, successor.child]); await service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cross-process waiting cancellation is free and cancelling the owner releases its claim', async () => {
  const dir = temp();
  let received!: () => void;
  const sent = new Promise<void>(resolve => { received = resolve; });
  const service = await endpoint((response, index) => {
    if (index === 1) received();
    else response.end(JSON.stringify({ choices: [{ message: { content: 'Synthetic replacement' } }] }));
  });
  const owner = worker(dir, service.base, 'synthetic-cancel', 3);
  const follower = worker(dir, service.base, 'synthetic-cancel', 3);
  const successor = worker(dir, service.base, 'synthetic-cancel', 3);
  try {
    await Promise.all([owner.event('ready'), follower.event('ready'), successor.event('ready')]);
    owner.send('go'); await sent;
    follower.send('go');
    assert.equal((await follower.event('submitted')).status, 'queued');
    follower.send('cancel');
    const cancelled = await follower.event('result');
    assert.ok(cancelled.result && !cancelled.result.ok && cancelled.result.cancelled);
    assert.equal(service.calls(), 1);
    owner.send('cancel');
    const cancelledOwner = await owner.event('result');
    assert.ok(cancelledOwner.result && !cancelledOwner.result.ok && cancelledOwner.result.cancelled);
    successor.send('go');
    assert.ok((await successor.event('result')).result?.ok);
    assert.equal(service.calls(), 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8')), {});
  } finally { await stop([owner.child, follower.child, successor.child]); await service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('malformed or unwritable shared budget state fails closed without a request', async () => {
  for (const broken of ['malformed', 'directory']) {
    const dir = temp(); let calls = 0;
    try {
      if (broken === 'malformed') fs.writeFileSync(path.join(dir, 'calls.json'), 'broken synthetic JSON');
      else fs.mkdirSync(path.join(dir, 'calls.json'));
      const model = new SmallModel({ dir, env: {}, fetch: (async () => { calls++; return reply(); }) as typeof fetch });
      model.configure({ backend: 'api', api });
      const result = await model.submit(question).result;
      assert.ok(!result.ok && result.reason === 'runtime-unavailable' && result.refused);
      assert.equal(calls, 0);
      assert.deepEqual(fs.readdirSync(path.join(dir, '.coordination')), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('approval and visible progress overtake queued summaries; background has a dispatch bound', async () => {
  let now = 1_000;
  const sent: string[] = [];
  const finishes: Array<() => void> = [];
  let concurrent = 0; let peak = 0;
  const fetcher = ((_url: string, init: RequestInit) => {
    const prompt = JSON.parse(String(init.body)).messages[1].content;
    sent.push(prompt); peak = Math.max(peak, ++concurrent);
    return new Promise<Response>(resolve => finishes.push(() => { concurrent--; resolve(reply()); }));
  }) as typeof fetch;
  const model = new SmallModel({ env: {}, fetch: fetcher, clock: () => now });
  model.configure({ backend: 'api', api });
  const first = model.submit({ ...question, prompt: 'active' });
  const background = model.submit({ ...question, prompt: 'background' });
  const progress = model.submit({ ...question, feature: 'progress', prompt: 'visible' });
  const approvals = Array.from({ length: 6 }, (_, index) => model.submit({ ...question, feature: 'approval', prompt: `approval-${index}` }));
  assert.equal(model.diagnostics().queued, 8);
  assert.equal(peak, 1);
  finishes.shift()!(); await first.result;
  assert.equal(sent[1], 'approval-0');
  for (let index = 0; index < 4; index++) { finishes.shift()!(); await tick(); }
  assert.equal(sent[5], 'background', 'oldest background dispatches after at most four overtakes');
  now += 31_000;
  finishes.shift()!(); await background.result; await tick();
  assert.equal(sent[6], 'visible', 'an aged visible request keeps its original FIFO position');
  while (finishes.length) { finishes.shift()!(); await tick(); }
  await Promise.all([progress.result, ...approvals.map(value => value.result)]);
  assert.equal(peak, 1);
});

test('local queued duplicate cache inputs are sent once without extra budget', async () => {
  let finish!: () => void; let calls = 0;
  const model = new SmallModel({ env: {}, fetch: (() => { calls++; return new Promise<Response>(resolve => { finish = () => resolve(reply()); }); }) as typeof fetch });
  model.configure({ backend: 'api', api, hourlyCap: 1 });
  const request = { ...question, cacheKey: 'synthetic-local-duplicate' };
  const first = model.submit(request); const second = model.submit(request);
  finish();
  assert.ok((await first.result).ok);
  const result = await second.result;
  assert.ok(result.ok && result.cached);
  assert.equal(calls, 1); assert.equal(model.usage().lastHour, 1);
});

test('output limits are bounded and change cache identity; timeouts and diagnostic notifications are safe', async () => {
  for (const [input, expected] of [[0, 1], [32.9, 32], [100_000, 8192]] as const) {
    const request = modelHttpRequest(api, { ...question, maxOutputTokens: input }, {});
    assert.ok(!('error' in request)); assert.equal(JSON.parse(request.body).max_tokens, expected);
  }
  assert.notEqual(requestDigest(question), requestDigest({ ...question, maxOutputTokens: 32 }));
  assert.equal(requestDigest(question), requestDigest({ ...question, timeoutMs: 200 }));
  let changes = 0;
  const model = new SmallModel({ env: {}, onChange: () => { changes++; }, fetch: ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('Synthetic transport timeout')), { once: true });
  })) as typeof fetch });
  model.configure({ backend: 'api', api });
  const handle = model.submit({ ...question, timeoutMs: 1 });
  assert.equal(model.diagnostics().running?.feature, question.feature);
  const result = await handle.result;
  assert.ok(!result.ok && result.classification === 'timeout');
  const diagnostics = model.diagnostics();
  assert.equal(diagnostics.running, undefined);
  assert.equal(diagnostics.lastFailure?.classification, 'timeout');
  assert.ok(changes >= 3);
  assert.ok(!JSON.stringify(diagnostics).includes('Synthetic test input'));
  assert.ok(!JSON.stringify(diagnostics).includes(api.base));
});

test('backend failure classifications distinguish authentication, model, throttle, timeout, server and invalid replies', async () => {
  for (const [status, body, classification] of [
    [401, '{}', 'auth'], [403, '{}', 'auth'], [404, '{}', 'model-not-found'],
    [400, '{"error":{"code":"model_not_found"}}', 'model-not-found'],
    [400, '{"error":{"message":"/chat/completions: Invalid model name passed in model=synthetic-retired. Call `/v1/models` to view available models for your key."}}', 'model-not-found'],
    [429, '{}', 'rate-limit'],
    [408, '{}', 'timeout'], [504, '{}', 'timeout'], [503, '{}', 'server'], [400, '{}', 'invalid-response'],
    [200, 'not JSON', 'invalid-response'],
  ] as const) {
    const model = new SmallModel({ env: {}, fetch: (async () => new Response(body, { status })) as typeof fetch });
    model.configure({ backend: 'api', api });
    const result = await model.submit(question).result;
    assert.ok(!result.ok); assert.equal(result.classification, classification);
    assert.equal(model.diagnostics().lastFailure?.classification, classification);
  }
});

test('budget time is captured inside the transaction and clock rollback cannot reopen reserved slots', async () => {
  const dir = temp(); let now = 1000; let calls = 0;
  const lockDir = path.join(dir, '.coordination');
  fs.mkdirSync(lockDir, { mode: 0o700 });
  const blocker = path.join(lockDir, 'synthetic-blocker.ticket');
  fs.writeFileSync(blocker, JSON.stringify({ pid: process.pid, start: '', host: os.hostname(), choosing: false, number: 1 }), { mode: 0o600 });
  const model = new SmallModel({ dir, env: {}, clock: () => now, fetch: (async () => { calls++; return reply(); }) as typeof fetch });
  model.configure({ backend: 'api', api, hourlyCap: 1 });
  try {
    const handle = model.submit(question);
    assert.equal(calls, 0);
    assert.equal(model.diagnostics().queued, 1);
    now = 5000;
    fs.unlinkSync(blocker);
    assert.ok((await handle.result).ok);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'calls.json'), 'utf8')), [5000]);
    now = 4000;
    const refused = await model.submit(question).result;
    assert.ok(!refused.ok && refused.reason === 'hourly-cap');
    assert.equal(calls, 1);
    assert.equal(model.diagnostics().lastFailure?.reason, 'hourly-cap');
    // Usage retains the historical public window semantics; reservations
    // still enforce the conservative budget when the wall clock moves back.
    assert.equal(model.usage().lastHour, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed cache commit abandons its live owner claim so a later request can recover', async () => {
  const dir = temp(); let calls = 0;
  const model = new SmallModel({ dir, env: {}, fetch: (async () => {
    if (++calls === 1) fs.mkdirSync(path.join(dir, 'cache.json'));
    return reply();
  }) as typeof fetch });
  model.configure({ backend: 'api', api });
  try {
    const request = { ...question, cacheKey: 'synthetic-failed-commit' };
    const first = await model.submit(request).result;
    assert.ok(!first.ok && first.reason === 'runtime-unavailable');
    assert.equal(model.diagnostics().lastFailure?.reason, 'runtime-unavailable');
    assert.deepEqual(fs.readdirSync(path.join(dir, '.coordination')), []);
    fs.rmdirSync(path.join(dir, 'cache.json'));
    assert.ok((await model.submit(request).result).ok);
    assert.equal(calls, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8')), {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cancellation from a running lifecycle observer never sends the queued request', async () => {
  for (const persistent of [false, true]) {
    const dir = persistent ? temp() : undefined;
    let finish!: () => void; let calls = 0;
    const model = new SmallModel({ dir, env: {}, fetch: (() => {
      calls++;
      return new Promise<Response>(resolve => { finish = () => resolve(reply()); });
    }) as typeof fetch });
    model.configure({ backend: 'api', api });
    try {
      const first = model.submit(question);
      const second = model.submit({ ...question, cacheKey: 'synthetic-cancel-on-running', prompt: 'Synthetic observer cancellation' });
      second.subscribe(() => { if (second.status === 'running') second.cancel(); });
      if (persistent) await tick();
      finish(); await first.result;
      const result = await second.result;
      assert.ok(!result.ok && result.cancelled);
      await tick();
      assert.equal(calls, 1);
      if (dir) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8')), {});
    } finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('real process death recovers a registered choosing ticket', async () => {
  const dir = temp();
  const script = `
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const dir = path.join(process.argv[1], '.coordination'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(dir, process.pid + '-synthetic.ticket'), JSON.stringify({ pid: process.pid, start: '', host: os.hostname(), choosing: true, number: 0 }), { mode: 0o600 });
process.on('message', () => {}); process.send('ready');
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await once(child, 'message'); await stop([child]);
    const model = new SmallModel({ dir, env: {}, fetch: (async () => reply()) as typeof fetch });
    model.configure({ backend: 'api', api });
    assert.ok((await model.submit(question).result).ok);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.coordination')), []);
  } finally { await stop([child]); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('large hourly caps retain every reservation instead of truncating away spend', async () => {
  const dir = temp(); const now = Date.now(); let calls = 0;
  fs.writeFileSync(path.join(dir, 'calls.json'), JSON.stringify(Array.from({ length: 5001 }, () => now)));
  const model = new SmallModel({ dir, env: {}, clock: () => now, fetch: (async () => { calls++; return reply(); }) as typeof fetch });
  model.configure({ backend: 'api', api, hourlyCap: 5001 });
  try {
    const result = await model.submit(question).result;
    assert.ok(!result.ok && result.reason === 'hourly-cap');
    assert.equal(model.usage().lastHour, 5001);
    assert.equal(calls, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('waiting for another panel cache claim yields the local slot to an approval', async () => {
  const dir = temp();
  let finishOwner!: () => void;
  let ownerStarted!: () => void;
  const ownerSent = new Promise<void>(resolve => { ownerStarted = resolve; });
  const owner = new SmallModel({ dir, env: {}, fetch: (() => new Promise<Response>(resolve => {
    finishOwner = () => resolve(reply()); ownerStarted();
  })) as typeof fetch });
  let approvalStarted!: () => void;
  const approvalSent = new Promise<void>(resolve => { approvalStarted = resolve; });
  let calls = 0;
  const local = new SmallModel({ dir, env: {}, fetch: (async (_url: string, init: RequestInit) => {
    calls++; assert.equal(JSON.parse(String(init.body)).messages[1].content, 'Synthetic approval');
    approvalStarted(); return reply();
  }) as typeof fetch });
  for (const model of [owner, local]) model.configure({ backend: 'api', api });
  try {
    const request = { ...question, cacheKey: 'synthetic-peer-claim' };
    const active = owner.submit(request); await ownerSent;
    const waiting = local.submit(request);
    const approval = local.submit({ ...question, feature: 'approval', prompt: 'Synthetic approval' });
    await approvalSent;
    assert.equal(waiting.status, 'queued');
    assert.ok((await approval.result).ok);
    assert.equal(calls, 1);
    finishOwner(); await active.result;
    const reused = await waiting.result;
    assert.ok(reused.ok && reused.cached);
    assert.equal(calls, 1);
    assert.equal(local.usage().lastHour, 2);
  } finally { owner.cancelAll(); local.cancelAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cache limit retains the newest completions when generation timestamps tie', async () => {
  const dir = temp(); let calls = 0;
  const model = new SmallModel({ dir, env: {}, clock: () => 10_000, fetch: (async () => { calls++; return reply(); }) as typeof fetch });
  model.configure({ backend: 'api', api, hourlyCap: 300 });
  try {
    for (let index = 0; index <= 200; index++) {
      assert.ok((await model.submit({ ...question, cacheKey: `synthetic-cache-${index}` }).result).ok);
    }
    const newest = await model.submit({ ...question, cacheKey: 'synthetic-cache-200' }).result;
    assert.ok(newest.ok && newest.cached);
    assert.equal(calls, 201);
    const oldest = await model.submit({ ...question, cacheKey: 'synthetic-cache-0' }).result;
    assert.ok(oldest.ok && !oldest.cached);
    assert.equal(calls, 202);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'cache.json'), 'utf8'))).length, 200);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('empty public text truncated at the output limit is classified without exposing reasoning or retrying', async () => {
  for (const text of ['', 'Synthetic partial answer']) {
    let calls = 0;
    const model = new SmallModel({ env: {}, fetch: (async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: text, reasoning_content: 'Synthetic private reasoning' } }] }));
    }) as typeof fetch });
    model.configure({ backend: 'api', api });
    const result = await model.submit({ ...question, maxOutputTokens: 32 }).result;
    assert.equal(calls, 1);
    if (text) assert.deepEqual(result, { ok: true, text });
    else {
      assert.ok(!result.ok && result.classification === 'output-limit');
      assert.equal(model.diagnostics().lastFailure?.classification, 'output-limit');
      assert.ok(!JSON.stringify(result).includes('Synthetic private reasoning'));
    }
  }
});

test('cancelling while a cache commit waits for its lock drops the obsolete result', async () => {
  const dir = temp(); let calls = 0; let finish!: () => void; let started!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  const model = new SmallModel({ dir, env: {}, fetch: (() => {
    if (++calls > 1) return Promise.resolve(reply());
    return new Promise<Response>(resolve => { finish = () => resolve(reply()); started(); });
  }) as typeof fetch });
  model.configure({ backend: 'api', api });
  try {
    const request = { ...question, cacheKey: 'synthetic-cancelled-commit' };
    const first = model.submit(request); await dispatched;
    const blocker = path.join(dir, '.coordination', 'synthetic-commit-blocker.ticket');
    fs.writeFileSync(blocker, JSON.stringify({ pid: process.pid, start: '', host: os.hostname(), choosing: false, number: 1 }), { mode: 0o600 });
    finish(); await tick();
    first.cancel(); fs.unlinkSync(blocker);
    const cancelled = await first.result;
    assert.ok(!cancelled.ok && cancelled.cancelled);
    const next = await model.submit(request).result;
    assert.ok(next.ok && !next.cached);
    assert.equal(calls, 2);
  } finally { model.cancelAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});
