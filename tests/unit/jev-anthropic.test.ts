import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { decisionFallback, decisionKeys, readHudCredentials, resolveDecisions } from '../../dist/jev/ask/config.js';
import { choose, decideProviderId, JevCredentialsMissing, selectDecisionProvider } from '../../dist/jev/decide.js';
import { FailoverDecisionProvider } from '../../dist/jev/failover.js';
import type { JudgmentRequest } from '../../dist/jev/judge.js';
import { DecisionInvalid, DecisionProviderError, type DecisionRequest } from '../../dist/jev/model.js';
import { AnthropicDecisionProvider } from '../../dist/jev/providers/anthropic.js';
import { OpenAIDecisionProvider } from '../../dist/jev/providers/openai.js';

const page = { url: 'https://example.invalid/', title: 'Synthetic', text: 'A blue mug.' };
const state = { ...page, actions: [{ id: 'blue-mug', kind: 'click', node: 1, label: 'Blue mug', role: 'button' }] };
const request: DecisionRequest = {
  page, elements: [], recentActions: [], goal: 'Finish the synthetic task.',
  questions: [{ name: 'operation', rules: 'Use the observed page.', choices: [
    { value: 'DONE', description: 'Finish' }, { value: 'BLOCKED', description: 'Blocked' },
  ] }],
};
const judgment: JudgmentRequest = {
  page, elements: [], facts: { ready: true }, deltas: {},
  statements: [{ name: 'ready', statement: 'Is the synthetic page ready?' }],
  choices: [{ name: 'mug', statement: 'Which mug is visible?', choices: [{ value: 'BLUE', description: 'Blue mug' }] }],
};
const options = { cacheKey: 'synthetic-cache-key' };
const usage = { input_tokens: 30, output_tokens: 20 };

function choice(name: string, choice: string, probabilities: Record<string, number>) {
  return { name, type: 'choice', choice, confidence: 0.9,
    probabilities: Object.entries(probabilities).map(([value, probability]) => ({ value, probability })) };
}

function message(answers: unknown[], stop_reason = 'end_turn') {
  return Response.json({ stop_reason, content: [
    { type: 'thinking', thinking: 'Synthetic reasoning' },
    { type: 'text', text: JSON.stringify({ answers }) },
  ], usage });
}

function fixture(t: TestContext, credentials: string) {
  const home = mkdtempSync(join(tmpdir(), 'anthropic-unit-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'credentials.env'), credentials, { mode: 0o600 });
  return { HUD_HOME: home, HOME: home, ANTHROPIC_API_KEY: 'synthetic-ignored-env' };
}

function wireBody(init?: RequestInit) {
  return JSON.parse(String(init?.body));
}

const done = choice('operation', 'DONE', { DONE: 0.9, BLOCKED: 0.1 });

test('Anthropic Messages uses low-effort structured output and resolves a real padded target', async () => {
  const provider = new AnthropicDecisionProvider({ apiKey: 'synthetic-anthropic', fetcher: async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-api-key'), 'synthetic-anthropic');
    assert.equal(headers.get('anthropic-version'), '2023-06-01');
    assert.equal(headers.get('content-type'), 'application/json');
    const body = wireBody(init);
    assert.equal(body.model, 'claude-haiku-5-5');
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.output_config.effort, 'low');
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.deepEqual(body.output_config.format.schema.required, ['answers']);
    assert.equal(body.messages[0].role, 'user');
    const input = JSON.parse(body.messages[0].content);
    assert.deepEqual(input.page, page);
    assert.equal(input.goal, 'Pick the blue mug.');
    assert.deepEqual(input.questions[1].choices.map((item: { value: string }) => item.value), ['1', 'NONE']);
    assert.ok(!String(init?.body).includes(options.cacheKey));
    return message([choice('operation', 'CLICK', { CLICK: 0.9, DONE: 0.1, BLOCKED: 0 }),
      choice('click_target', '1', { '1': 0.9, NONE: 0.1 })]);
  } });
  const result = await choose(state, 'Pick the blue mug.', [], provider, options);
  assert.ok(!('refused' in result));
  assert.equal(result.choice, 'blue-mug');
  assert.equal(result.model, 'claude-haiku-5-5');
  assert.deepEqual(result.usage, usage);
});

test('Anthropic judges statements and choices with only the shared-file credential', async (t) => {
  const env = fixture(t, 'ANTHROPIC_API_KEY=synthetic-file-key\n');
  const provider = await selectDecisionProvider('anthropic', env, async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'synthetic-file-key');
    const { facts, statements, choices } = JSON.parse(wireBody(init).messages[0].content);
    assert.deepEqual(facts, judgment.facts);
    assert.deepEqual(statements, judgment.statements);
    assert.deepEqual(choices[0].choices.map((item: { value: string }) => item.value), ['BLUE', 'NONE']);
    return message([{ name: 'ready', type: 'predicate', probability: 0.97 }, choice('mug', 'BLUE', { BLUE: 0.9, NONE: 0.1 })]);
  });
  const result = await provider.judge!(judgment, options);
  assert.equal(result.provider, 'anthropic');
  assert.deepEqual(result.answers, [
    { name: 'ready', kind: 'predicate', probability: 0.97 },
    { name: 'mug', kind: 'choice', choice: 'BLUE', confidence: 0.9, probabilities: { BLUE: 0.9, NONE: 0.1 } },
  ]);
});

test('refusal does not fall back; truncated or unparseable output is invalid and does not fall back', async () => {
  const fallback = new OpenAIDecisionProvider({ apiKey: 'synthetic', fetcher: async () => {
    assert.fail('refusals and malformed answers must not fall back');
  } });
  const withResponse = (fetcher: typeof fetch) => new FailoverDecisionProvider('anthropic',
    new AnthropicDecisionProvider({ apiKey: 'synthetic', fetcher }), fallback);
  const refused = withResponse(async () => Response.json({ stop_reason: 'refusal', content: [] }));
  assert.deepEqual(await choose(state, request.goal, [], refused, options), { refused: true, question: 'operation' });
  assert.deepEqual((await refused.judge(judgment, options)).answers, [
    { name: 'ready', kind: 'refusal' }, { name: 'mug', kind: 'refusal' },
  ]);
  await assert.rejects(withResponse(async () => message([done], 'max_tokens')).decide(request, options), DecisionInvalid);
  await assert.rejects(withResponse(async () => Response.json({ stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'synthetic invalid JSON' }],
  })).decide(request, options), DecisionInvalid);
});

test('Anthropic attempt timeout uses the existing one-fallback rule', async () => {
  let attempts = 0;
  const primary = new AnthropicDecisionProvider({ apiKey: 'synthetic', timeoutMs: 15, fetcher: async (_url, init) => {
    attempts++;
    await setTimeout(1_000, undefined, { signal: init?.signal ?? undefined });
    assert.fail('the provider must abort this request');
  } });
  const fallback = new OpenAIDecisionProvider({ apiKey: 'synthetic', fetcher: async () => Response.json({ answers: [done] }) });
  const records: string[] = [];
  const provider = new FailoverDecisionProvider('anthropic', primary, fallback, (entry) => {
    if (entry.fallbackReason) records.push(entry.fallbackReason);
  });
  assert.equal((await provider.decide(request, options)).provider, 'openai');
  assert.deepEqual(records, ['timeout']);
  assert.equal(attempts, 1);
});

test('default is OpenAI; automatic fallback prefers Gemini and OpenAI, then Anthropic before TypeSafe', async (t) => {
  const env = fixture(t, 'OPENAI_API_KEY=synthetic-openai\nANTHROPIC_API_KEY=synthetic-file-key\nTYPESAFE_API_KEY=synthetic-typesafe\n');
  const creds = readHudCredentials(env);
  const allKeys = { ...creds, geminiApiKey: 'synthetic-gemini' };
  const config = resolveDecisions({});
  assert.equal(config.primary, 'openai');
  assert.equal(decisionFallback(config, allKeys), 'gemini');
  assert.equal(decisionFallback(config, allKeys, 'gemini'), 'openai');
  assert.equal(decisionFallback(config, creds), 'anthropic');
  assert.equal(decisionFallback(config, { ...creds, anthropicApiKey: undefined }), 'typesafe');
  assert.equal(resolveDecisions({ decisions: { fallback: 'anthropic' } }).fallback, 'anthropic');
  assert.deepEqual(decideProviderId('anthropic', decisionKeys(creds)), { ok: true, provider: 'anthropic' });
  const calls: string[] = [];
  const provider = await selectDecisionProvider(undefined, env, async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return Response.json({ error: 'synthetic auth failure' }, { status: 401 });
    return message([done]);
  });
  assert.equal((await provider.decide(request, options)).provider, 'anthropic');
  assert.deepEqual(calls, ['https://api.openai.com/v1/decisions', 'https://api.anthropic.com/v1/messages']);
});

test('environment-only Anthropic key is ignored and missing credential names the variable', async (t) => {
  const env = fixture(t, '');
  const creds = readHudCredentials(env);
  assert.deepEqual(decideProviderId('anthropic', decisionKeys(creds)), {
    ok: false, provider: 'anthropic', variable: 'ANTHROPIC_API_KEY',
  });
  await assert.rejects(selectDecisionProvider('anthropic', env), (error: unknown) =>
    error instanceof JevCredentialsMissing && error.variable === 'ANTHROPIC_API_KEY' && /ANTHROPIC_API_KEY/.test(error.message));
});

test('Anthropic HTTP failure is classified without propagating the response body', async () => {
  const provider = new AnthropicDecisionProvider({ apiKey: 'synthetic', fetcher: async () =>
    Response.json({ error: 'synthetic-private-body' }, { status: 429 }) });
  await assert.rejects(provider.decide(request, options), (error: unknown) =>
    error instanceof DecisionProviderError && error.status === 429 && error.message === 'decision_provider_error:429');
});
