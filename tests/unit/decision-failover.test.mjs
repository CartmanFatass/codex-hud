import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { FailoverDecisionProvider } from '../../dist/jev/failover.js';
import { OpenAIDecisionProvider } from '../../dist/jev/providers/openai.js';
import { TypeSafeDecisionProvider } from '../../dist/jev/providers/typesafe.js';
import { resolveDecisions } from '../../dist/jev/ask/config.js';
import { choose } from '../../dist/jev/decide.js';
import { JevRuntime } from '../../dist/jev/runtime/executor.js';
import { connectJevExecutor } from '../../dist/jev/runtime/client.js';
const page = {
  url: 'https://example.invalid',
  title: 'Synthetic',
  text: 'Synthetic page',
  actions: [],
  fingerprint: 'test',
};
const judgment = {
  page,
  elements: [],
  facts: {},
  deltas: {},
  statements: [{ name: 'ready', statement: 'The page is ready.' }],
};
function payload(id, method, body, kind = 'success') {
  if (kind === 'malformed') return { answers: [] };
  if (kind === 'refusal')
    return id === 'openai'
      ? { answers: [{ name: method === 'judge' ? 'ready' : 'operation', type: 'refusal' }] }
      : { answers: { operation: { choice: 'REFUSED', probabilities: {}, confidence: 0 } } };
  if (method === 'judge')
    return id === 'openai'
      ? { answers: [{ name: 'ready', type: 'predicate', probability: 0.99 }] }
      : { answers: { ready: { choice: 'yes', probabilities: { yes: 0.99, no: 0.01 }, confidence: 0.99 } } };
  const choices =
    id === 'openai' ? body.questions[0].choices.map((x) => x.value) : Object.keys(body.questions.operation.criteria);
  const probabilities = Object.fromEntries(choices.map((c) => [c, c === 'DONE' ? 1 : 0]));
  return id === 'openai'
    ? {
        answers: [
          {
            name: 'operation',
            type: 'choice',
            choice: 'DONE',
            confidence: 1,
            probabilities: Object.entries(probabilities).map(([value, probability]) => ({ value, probability })),
          },
        ],
      }
    : { answers: { operation: { choice: 'DONE', confidence: 1, probabilities } } };
}
async function localProvider(t, id, handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const b of req) text += b;
    const body = JSON.parse(text);
    calls.push(body);
    handler(body, res, calls.length);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    calls,
    make: (timeoutMs = 2000, model) =>
      id === 'typesafe'
        ? new TypeSafeDecisionProvider({ apiKey: 'synthetic-typesafe', url, timeoutMs, model })
        : new OpenAIDecisionProvider({ apiKey: 'synthetic-openai', baseUrl: url, timeoutMs }),
  };
}
test('primary/fallback × key presence × failure kinds: actual transports, one fallback maximum, no invalid/refusal failover', async (t) => {
  for (const method of ['decide', 'judge'])
    for (const primary of ['typesafe', 'openai'])
      for (const fallback of ['typesafe', 'openai'])
        for (const mask of [0, 1, 2, 3])
          for (const failure of ['quota', 'auth', 'server', 'timeout', 'malformed', 'refusal', 'success'])
            await t.test(`${method} ${primary}->${fallback} keys=${mask} ${failure}`, async (sub) => {
              const records = [];
              const first = await localProvider(sub, primary, (body, res) => {
                if (failure === 'timeout') return;
                if (['quota', 'auth', 'server'].includes(failure)) {
                  res.statusCode = { quota: 429, auth: 401, server: 500 }[failure];
                  res.end('{}');
                  return;
                }
                res.end(JSON.stringify(payload(primary, method, body, failure)));
              });
              const second = await localProvider(sub, fallback, (body, res) =>
                res.end(JSON.stringify(payload(fallback, method, body)))
              );
              const has = (id) => Boolean(mask & (id === 'typesafe' ? 1 : 2));
              const p = new FailoverDecisionProvider(
                primary,
                has(primary) ? first.make(failure === 'timeout' ? 150 : 2000) : undefined,
                primary !== fallback && has(fallback) ? second.make() : undefined,
                (r) => records.push(r)
              );
              const transport = ['quota', 'auth', 'server', 'timeout'].includes(failure),
                canFallback = primary !== fallback && has(fallback),
                expectedFallback = canFallback && (!has(primary) || transport);
              let result, error;
              try {
                result =
                  method === 'decide'
                    ? await choose(page, 'Finish synthetic task', [], p, { cacheKey: 'synthetic' })
                    : await p.judge(judgment, { cacheKey: 'synthetic' });
              } catch (e) {
                error = e;
              }
              assert.equal(second.calls.length, expectedFallback ? 1 : 0);
              assert.equal(first.calls.length, has(primary) ? 1 : 0);
              if (expectedFallback) {
                assert.equal(error, undefined);
                assert.equal(records.length, 1);
                assert.equal(records[0].provider, fallback);
                assert.equal(records[0].fallbackReason, has(primary) ? failure : 'credentials_missing');
              } else if (!has(primary) || transport) {
                assert.ok(error);
                assert.equal(records.length, 0);
              } else {
                assert.equal(records.length, 1);
                assert.equal(records[0].provider, primary);
                assert.equal(records[0].fallbackReason, undefined);
                if (failure === 'malformed' && method === 'decide') assert.equal(error?.code, 'decision_invalid');
                if (failure === 'refusal' && method === 'decide')
                  assert.ok(result?.refused || error?.code === 'decision_invalid');
              }
            });
});
test('a response-body timeout also takes exactly one fallback', async (t) => {
  const first = await localProvider(t, 'typesafe', (_body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
  });
  const second = await localProvider(t, 'openai', (body, res) =>
    res.end(JSON.stringify(payload('openai', 'judge', body)))
  );
  const records = [];
  await new FailoverDecisionProvider('typesafe', first.make(200), second.make(), (entry) => records.push(entry)).judge(
    judgment,
    { cacheKey: 'body-timeout' }
  );
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
  assert.equal(records[0].fallbackReason, 'timeout');
  assert.equal(records[0].outcome, 'answered');
});
test('configuration precedence is primary, top-level provider, nested HUD provider, typesafe; fallback defaults openai', () => {
  const cases = [
    [{}, 'typesafe'],
    [{ decisions: { provider: 'openai' } }, 'openai'],
    [{ jev: { decisions: { provider: 'openai' } } }, 'openai'],
    [
      { decisions: { primary: 'typesafe', provider: 'openai' }, jev: { decisions: { provider: 'openai' } } },
      'typesafe',
    ],
  ];
  for (const [raw, primary] of cases) {
    const c = resolveDecisions(raw);
    assert.equal(c.primary, primary);
    assert.equal(c.fallback, 'openai');
  }
  assert.equal(resolveDecisions({ decisions: { fallback: 'typesafe' } }).fallback, 'typesafe');
  assert.throws(() => resolveDecisions({ decisions: { primary: 'invalid' } }));
});
test('fallback failure is final, cancellation and non-timeout network failures never fail over', async (t) => {
  const first = await localProvider(t, 'typesafe', (_body, res) => {
    res.statusCode = 403;
    res.end('{}');
  });
  const second = await localProvider(t, 'openai', (_body, res) => {
    res.statusCode = 500;
    res.end('{}');
  });
  const records = [];
  const p = new FailoverDecisionProvider('typesafe', first.make(), second.make(), (entry) => records.push(entry));
  await assert.rejects(p.judge(judgment, { cacheKey: 'x' }));
  assert.equal(records.length, 1);
  assert.equal(records[0].provider, 'openai');
  assert.equal(records[0].fallbackReason, 'auth');
  assert.equal(records[0].outcome, 'failed');
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(p.judge(judgment, { cacheKey: 'x', signal: abort.signal }));
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
  const network = new TypeSafeDecisionProvider({
    apiKey: 'synthetic',
    fetcher: async () => {
      throw new Error('connection reset');
    },
  });
  await assert.rejects(
    new FailoverDecisionProvider('typesafe', network, second.make()).judge(judgment, { cacheKey: 'x' })
  );
  assert.equal(second.calls.length, 1);
});
test('runtime persists actual responder/reason in the job record; same request never repeats browser work', async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'hud-failover-job-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  fs.writeFileSync(
    path.join(root, 'credentials.env'),
    'TYPESAFE_API_KEY=synthetic-typesafe\nOPENAI_API_KEY=synthetic-openai\n',
    { mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({
      jev: { stateDir: state, cdpUrl: 'http://offline.invalid', chrome: process.execPath, profile: state },
      decisions: { primary: 'typesafe', fallback: 'openai' },
    })
  );
  const first = await localProvider(t, 'typesafe', (_body, res) => {
    res.statusCode = 429;
    res.end('{}');
  });
  const second = await localProvider(t, 'openai', (body, res, n) => {
    if (n > 1) {
      res.end(JSON.stringify(payload('openai', 'decide', body)));
      return;
    }
    const answers = body.questions.map((q) => {
      const choice = q.name === 'operation' ? 'CLICK' : q.choices[0].value;
      return {
        name: q.name,
        type: 'choice',
        choice,
        confidence: 1,
        probabilities: q.choices.map((c) => ({ value: c.value, probability: c.value === choice ? 1 : 0 })),
      };
    });
    res.end(JSON.stringify({ answers }));
  });
  let opens = 0,
    actions = 0;
  const runtime = new JevRuntime({
    hudHome: root,
    graceMs: 60000,
    providerFactory: (c) => (c.id === 'typesafe' ? first.make() : second.make()),
    browserFactory: () => {
      opens++;
      return {
        fresh: async () => true,
        observe: async () => ({
          ...structuredClone(page),
          fingerprint: String(actions),
          actions: actions ? [] : [{ id: 'send-once', kind: 'click', label: 'Synthetic Send', node: 1 }],
        }),
        act: async () => {
          actions++;
          return { executed: 'send-once' };
        },
        close: async () => {},
      };
    },
  });
  await runtime.start();
  t.after(() => runtime.stop());
  const request = {
    requestKey: 'one-key',
    session: { namespace: 'hud', sessionId: 'synthetic' },
    input: { tag: 'browse', goal: 'Finish', url: page.url },
  };
  const job = await runtime.createJob(request);
  let done = job;
  const deadline = Date.now() + 10000;
  while (!['completed', 'failed'].includes(done.state) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    done = await runtime.readJob(job.id);
  }
  assert.equal(done.state, 'completed', JSON.stringify(done.error));
  assert.equal(done.provider.id, 'openai');
  assert.equal(done.decisionCalls[0].fallbackReason, 'quota');
  assert.equal(done.decisionCalls[0].primary, 'typesafe');
  assert.equal(done.decisionCalls[0].provider, 'openai');
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'jev-runtime', 'jobs', `${job.id}.json`), 'utf8'));
  assert.deepEqual(stored.decisionCalls, done.decisionCalls);
  assert.ok(!JSON.stringify(stored).includes('synthetic-openai'));
  assert.ok(!JSON.stringify(stored).includes('synthetic-typesafe'));
  assert.equal((await runtime.createJob(request)).id, job.id);
  assert.equal(opens, 1);
  assert.equal(actions, 1);
  assert.equal(first.calls.length, 2);
  assert.equal(second.calls.length, 2);
});

function oracleJudgment(id, body, human) {
  const questions = Array.isArray(body.questions)
    ? body.questions.map((q) => [q.name, q])
    : Object.entries(body.questions);
  const entries = questions.map(([name, q]) => {
    const probability = name === 'loading' ? 0 : name === 'needs_human' ? Number(human) : 1;
    if (name !== 'human_kind')
      return [
        name,
        id === 'openai'
          ? { name, type: 'predicate', probability }
          : {
              choice: probability ? 'yes' : 'no',
              confidence: 1,
              probabilities: { yes: probability, no: 1 - probability },
            },
      ];
    const values = q.choices ? q.choices.map((c) => c.value) : Object.keys(q.criteria);
    const choice = values.find((v) => (human ? v === 'challenge' : v === 'none'));
    assert.ok(choice, 'fixture uses an actual advertised human-kind choice');
    const probabilities = Object.fromEntries(values.map((v) => [v, Number(v === choice)]));
    return [
      name,
      id === 'openai'
        ? {
            name,
            type: 'choice',
            choice,
            confidence: 1,
            probabilities: Object.entries(probabilities).map(([value, probability]) => ({ value, probability })),
          }
        : { choice, confidence: 1, probabilities },
    ];
  });
  return { answers: id === 'openai' ? entries.map(([, value]) => value) : Object.fromEntries(entries) };
}

for (const { receiptKind, primaryId, recover } of [
  { receiptKind: 'binding', primaryId: 'typesafe', recover: true },
  { receiptKind: 'missing-with-fallback-audit', primaryId: 'typesafe', recover: true },
  { receiptKind: 'legacy-no-audit', primaryId: 'typesafe', recover: true },
  { receiptKind: 'binding', primaryId: 'typesafe', recover: false },
  { receiptKind: 'binding', primaryId: 'openai', recover: false },
])
  test(`ask restart after real transport fallback: ${primaryId}/${receiptKind}/recover=${recover}; never repeats Send`, async (t) => {
    const fallbackId = primaryId === 'typesafe' ? 'openai' : 'typesafe';
    const primaryModel = primaryId === 'typesafe' ? 'pinned-primary-model' : 'gpt-6-luna';
    const root = fs.mkdtempSync(path.join(tmpdir(), 'hud-failover-resume-'));
    const runtimes = [];
    t.after(async () => {
      for (const runtime of runtimes) await runtime.stop();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const state = path.join(root, 'state');
    fs.mkdirSync(state);
    fs.writeFileSync(
      path.join(root, 'credentials.env'),
      'TYPESAFE_API_KEY=synthetic-typesafe\nOPENAI_API_KEY=synthetic-openai\n',
      { mode: 0o600 }
    );
    const writeConfig = (typesafeModel = 'configured-model') =>
      fs.writeFileSync(
        path.join(root, 'config.json'),
        JSON.stringify({
          jev: {
            stateDir: state,
            cdpUrl: 'http://offline.invalid',
            chrome: '/synthetic/chrome',
            profile: '/synthetic/profile',
          },
          decisions: { primary: primaryId, fallback: fallbackId, typesafe: { model: typesafeModel } },
        })
      );
    writeConfig();
    let human = false,
      recovered = false,
      clicks = 0,
      prepares = 0,
      opens = 0;
    let clock = 1700000000000;
    const constructed = [];
    const primary = await localProvider(t, primaryId, (body, res) => {
      if (!recovered) {
        res.statusCode = 429;
        res.end('{}');
      } else res.end(JSON.stringify(oracleJudgment(primaryId, body, false)));
    });
    const fallback = await localProvider(t, fallbackId, (body, res) =>
      res.end(JSON.stringify(oracleJudgment(fallbackId, body, human)))
    );
    const settled = 'https://oracle.example/settled',
      prompt = 'synthetic restart prompt';
    const oraclePage = {
      id: 'sent-tab',
      async facts() {
        return {
          url: clicks ? settled : 'https://oracle.example/',
          readyState: 'complete',
          marker: 'stable',
          composer: clicks ? '' : prompt,
          stop: false,
          sidebar: [],
          cards: [],
          turns: clicks
            ? [
                { role: 'user', text: prompt },
                { role: 'assistant', text: 'synthetic answer', final_controls: true },
              ]
            : [],
          ...(human ? { human: 'challenge' } : {}),
        };
      },
      async observation(facts) {
        return {
          page: { url: facts.url, title: 'Synthetic', text: 'Synthetic page' },
          elements: [],
          facts: { readyState: 'complete', marker: 'stable', ...(human ? { human: 'challenge' } : {}) },
          deltas: {},
        };
      },
      async close() {},
      async detach() {},
    };
    const target = {
      provider: 'chatgpt',
      root: 'https://oracle.example/',
      settled: (url) => url === settled,
      async open() {
        opens++;
        return oraclePage;
      },
      async attach() {
        opens++;
        return oraclePage;
      },
      async targets() {
        return [{ targetId: 'sent-tab', url: settled }];
      },
      async prepare(_page, _input, provider, signal) {
        prepares++;
        await provider.judge(judgment, { cacheKey: 'resume-prepare', signal });
        return oraclePage.facts();
      },
      async click() {
        clicks++;
        human = true;
      },
      binding(_facts, _input, record) {
        return record.send_effect === 'sent'
          ? { found: true, answer: 'synthetic answer', final: true }
          : { found: false, answer: '', final: false };
      },
      matchesDraft() {
        return false;
      },
    };
    const makeRuntime = () => {
      const runtime = new JevRuntime({
        hudHome: root,
        graceMs: 60000,
        oracleTargets: { 'chatgpt-pro': target },
        oracleNow: () => clock,
        oracleSleep: async (ms) => {
          clock += ms;
        },
        providerFactory: (resolved) => {
          constructed.push({ id: resolved.id, model: resolved.model, fallback: resolved.fallback?.id });
          return (resolved.id === primaryId ? primary : fallback).make(2000, resolved.model);
        },
      });
      runtimes.push(runtime);
      return runtime;
    };
    const finish = async (runtime, id) => {
      let job;
      const deadline = Date.now() + 10000;
      do {
        job = await runtime.readJob(id);
        if (job.state === 'completed' || job.state === 'failed') return job;
        await new Promise((r) => setTimeout(r, 5));
      } while (Date.now() < deadline);
      assert.fail('synthetic ask did not settle');
    };
    const runtime = makeRuntime();
    await runtime.start();
    const created = await runtime.createJob({
      requestKey: 'resume-one-send',
      session: { namespace: 'synthetic', sessionId: 'resume' },
      jevDecisions: {
        provider: primaryId,
        model: primaryId === 'typesafe' ? primaryModel : 'ignored-cross-provider-model',
      },
      input: { tag: 'ask', target: 'chatgpt-pro', label: 'resume', prompt, maxWaitMs: 60000 },
    });
    const first = await finish(runtime, created.id);
    assert.equal(first.state, 'completed', JSON.stringify(first));
    assert.equal(first.result.status, 'needs_human');
    assert.equal(first.provider.id, fallbackId);
    assert.equal(first.provider.model, fallbackId === 'openai' ? 'gpt-6-luna' : 'configured-model');
    assert.ok(
      first.decisionCalls.some(
        (call) => call.primary === primaryId && call.provider === fallbackId && call.fallbackReason === 'quota'
      )
    );
    assert.ok(fallback.calls.length > 0);
    assert.ok(
      fallback.calls.every((body) => body.model === (fallbackId === 'openai' ? 'gpt-6-luna' : 'configured-model')),
      'fresh fallback never receives a primary/profile model from the other provider'
    );
    assert.equal(Object.hasOwn(first, 'decisionBinding'), false, 'private binding is not a public response field');
    assert.equal(clicks, 1);
    await runtime.stop();
    const file = path.join(root, 'jev-runtime', 'jobs', `${created.id}.json`);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(stored.decisionBinding, { provider: primaryId, model: primaryModel });
    if (receiptKind !== 'binding') delete stored.decisionBinding;
    if (receiptKind === 'legacy-no-audit') {
      delete stored.decisionCalls;
      stored.provider = { id: 'typesafe', model: 'legacy-primary-model' };
    }
    fs.writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
    recovered = recover;
    human = false;
    if (primaryId === 'openai') writeConfig('current-resume-model');
    constructed.length = 0;
    const callsBefore = [primary.calls.length, fallback.calls.length],
      opensBefore = opens;
    const operationBefore = fs.readFileSync(
      path.join(
        state,
        'operations',
        fs.readdirSync(path.join(state, 'operations')).find((name) => name.endsWith('.json'))
      ),
      'utf8'
    );
    const restarted = makeRuntime();
    await restarted.start();
    if (receiptKind === 'missing-with-fallback-audit') {
      const receiptBefore = fs.readFileSync(file, 'utf8');
      const expectedMessage = `job ${created.id}: decision_binding_missing; a new ask is required`;
      const refusal = (error) => error.code === 'decision_binding_missing' && error.message === expectedMessage;
      await assert.rejects(restarted.readJob(created.id, { resume: true }), refusal);
      const connected = await connectJevExecutor(root);
      await assert.rejects(connected.readJob(created.id, { resume: true }), refusal);
      assert.equal(
        fs.readFileSync(file, 'utf8'),
        receiptBefore,
        'direct and production socket refusals never rewrite the receipt'
      );
      assert.deepEqual(constructed, []);
      assert.deepEqual([primary.calls.length, fallback.calls.length], callsBefore);
      assert.equal(opens, opensBefore);
      assert.equal(
        fs.readFileSync(
          path.join(
            state,
            'operations',
            fs.readdirSync(path.join(state, 'operations')).find((name) => name.endsWith('.json'))
          ),
          'utf8'
        ),
        operationBefore
      );
      assert.equal(clicks, 1);
      return;
    }
    await restarted.readJob(created.id, { resume: true });
    const resumed = await finish(restarted, created.id);
    assert.equal(resumed.state, 'completed', JSON.stringify(resumed));
    assert.equal(resumed.result.status, 'answered');
    const resumedPrimaryModel = receiptKind === 'legacy-no-audit' ? 'legacy-primary-model' : primaryModel;
    const resumedFallbackModel = fallbackId === 'openai' ? 'gpt-6-luna' : 'current-resume-model';
    assert.equal(resumed.provider.id, recover ? primaryId : fallbackId);
    assert.equal(resumed.provider.model, recover ? resumedPrimaryModel : resumedFallbackModel);
    assert.equal(constructed[0].id, primaryId, 'last fallback responder is never promoted to primary');
    assert.equal(constructed[0].model, resumedPrimaryModel);
    assert.equal(constructed[0].fallback, fallbackId, 'fallback still comes from current config');
    assert.ok(primary.calls.length > callsBefore[0], 'resume performs real judgments against original primary');
    if (recover) assert.equal(fallback.calls.length, callsBefore[1], 'recovered primary does not call fallback');
    else {
      assert.ok(fallback.calls.length > callsBefore[1], 'continued primary failure takes one-call fallback on resume');
      assert.equal(primary.calls.length, fallback.calls.length, 'each failed primary call has exactly one fallback');
      assert.ok(
        fallback.calls.slice(callsBefore[1]).every((body) => body.model === resumedFallbackModel),
        'resumed fallback model comes from current provider config, never the primary binding'
      );
    }
    assert.equal(clicks, 1);
    assert.equal(prepares, 1, 'resume never prepares or sends again');
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(persisted.decisionBinding, {
      provider: primaryId,
      model: resumedPrimaryModel,
    });
    assert.equal(Object.hasOwn(resumed, 'decisionBinding'), false);
  });
