// Page judgments: wire bodies, thresholds, NONE padding, and load-aware awaitState.
// The live smoke is skipped unless JEV_LIVE_DECISIONS is openai or typesafe.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  awaitState,
  awaitStates,
  classifyProbability,
  readPredicateProbability,
  type JudgmentRequest,
} from '../../src/jev/judge.js';
import { DecisionInvalid, OPENAI_NONE_CHOICE, OPENAI_NONE_DESCRIPTION } from '../../src/jev/model.js';
import {
  OPENAI_DECISION_MODEL,
  OpenAIDecisionProvider,
  buildOpenAIJudgmentBody,
  parseOpenAIAnswers,
} from '../../src/jev/providers/openai.js';
import {
  TypeSafeDecisionProvider,
  buildTypeSafeJudgmentBody,
  parseTypeSafeJudgment,
} from '../../src/jev/providers/typesafe.js';
import type { Answer, DecisionResult } from '../../src/jev/decide.js';

const PAGE = {
  url: 'https://example.invalid/fixture',
  title: 'Fixture',
  text: 'synthetic page',
};

function request(extra: Partial<JudgmentRequest> = {}): JudgmentRequest {
  return {
    page: PAGE,
    elements: [],
    facts: { readyState: 'complete', marker: 'm' },
    deltas: {},
    statements: [{ name: 'page_ready', statement: 'The page is ready.' }],
    choices: [
      {
        name: 'human_kind',
        statement: 'What kind of human action is the page asking for?',
        choices: [{ value: 'login', description: 'The page is asking the person to sign in.' }],
      },
    ],
    ...extra,
  };
}

function predicate(name: string, probability: number): Answer {
  return { name, kind: 'predicate', probability };
}

function result(answers: Answer[]): DecisionResult {
  return { answers, usage: {}, latencyMs: 1, raw: { model: 'fake' } };
}

test('judgment bodies keep provider shapes and the one-choice NONE pad', () => {
  const body = request();
  const openai = buildOpenAIJudgmentBody(body, 'hud-jev:judge');
  const typesafe = buildTypeSafeJudgmentBody(body, 'custom-jev');
  assert.equal(openai.model, OPENAI_DECISION_MODEL);
  assert.equal(typesafe.model, 'custom-jev');
  const questions = openai.questions as Array<{
    type: string;
    name: string;
    choices?: Array<{ value: string; description: string }>;
  }>;
  const ready = questions.find((item) => item.name === 'page_ready');
  const kind = questions.find((item) => item.name === 'human_kind');
  assert.equal(ready?.type, 'predicate');
  assert.equal(kind?.type, 'choice');
  assert.deepEqual(
    kind?.choices?.map((item) => item.value),
    ['login', OPENAI_NONE_CHOICE]
  );
  assert.equal(kind?.choices?.[1]?.description, OPENAI_NONE_DESCRIPTION);
  const input = (openai.input as Array<{ content: Array<{ type: string; data?: Record<string, unknown> }> }>)[0]
    .content;
  assert.deepEqual(input[2]?.data, { facts: body.facts, deltas: body.deltas });
  assert.equal(JSON.stringify(openai).includes('recent_actions'), false);

  const tsQuestions = typesafe.questions as Record<string, { type: string; criteria: Record<string, unknown> }>;
  assert.equal(tsQuestions.page_ready.type, 'choice');
  assert.deepEqual(Object.keys(tsQuestions.page_ready.criteria), ['yes', 'no']);
  assert.equal(Object.hasOwn(tsQuestions.human_kind.criteria, OPENAI_NONE_CHOICE), false);
  assert.deepEqual(Object.keys(tsQuestions.human_kind.criteria), ['login']);
  assert.equal(JSON.stringify(typesafe).includes(OPENAI_NONE_CHOICE), false);
});

test('predicate parsers and thresholds', () => {
  const parsed = parseTypeSafeJudgment({
    answers: { page_ready: { choice: 'yes', probabilities: { yes: 0.91, no: 0.09 }, confidence: 0.91 } },
  });
  assert.deepEqual(parsed[0], { name: 'page_ready', kind: 'predicate', probability: 0.91 });
  const openai = parseOpenAIAnswers({
    answers: [{ name: 'page_ready', type: 'predicate', probability: 0.7 }],
  });
  assert.deepEqual(openai[0], { name: 'page_ready', kind: 'predicate', probability: 0.7 });
  assert.equal(classifyProbability('loading', 0.7), 'pass');
  assert.equal(classifyProbability('loading', 0.699), 'unsettled');
  assert.equal(classifyProbability('page_ready', 0.8), 'pass');
  assert.equal(classifyProbability('page_ready', 0.2), 'deny');
  assert.equal(classifyProbability('page_ready', 0.5), 'unsettled');
  assert.equal(classifyProbability('needs_human', 0.8), 'pass');
  assert.equal(classifyProbability('needs_human', 0.1), 'unsettled');
  assert.equal(classifyProbability('still_generating', 0.6), 'pass');
  assert.equal(classifyProbability('custom_fact', 0.85), 'pass');
  assert.equal(classifyProbability('custom_fact', 0.15), 'deny');
  assert.equal(classifyProbability('page_ready', Number.NaN), 'unsettled');
  assert.equal(classifyProbability('page_ready', 1.2), 'unsettled');
  assert.equal(classifyProbability('page_ready', undefined), 'unsettled');
  assert.throws(() => readPredicateProbability(predicate('page_ready', Number.NaN)), DecisionInvalid);
  assert.throws(() => readPredicateProbability({ name: 'page_ready', kind: 'refusal' }), DecisionInvalid);
});

function clocked(readyUntil: number) {
  let clock = 0;
  const calls: number[] = [];
  const observer = {
    async observe() {
      return {
        page: PAGE,
        elements: [],
        facts: { readyState: clock >= readyUntil ? 'complete' : 'interactive', marker: 'm' },
        deltas: {},
      };
    },
  };
  const provider = {
    async judge(body: JudgmentRequest): Promise<DecisionResult> {
      calls.push(clock);
      return result(
        body.statements.map((statement) =>
          predicate(statement.name, statement.name === 'loading' || statement.name === 'needs_human' ? 0.05 : 0.95)
        )
      );
    },
  };
  return {
    calls,
    observer,
    provider,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

test('awaitState extends the deadline while the page is loading and then judges once', async () => {
  const world = clocked(1500);
  const outcome = await awaitState(
    { name: 'page_ready', statement: 'The page is ready.' },
    world.observer,
    world.provider,
    { maxMs: 1000, maxCalls: 4, maxLoadMs: 5000, pollMs: 500, now: world.now, sleep: world.sleep }
  );
  assert.equal(outcome.verdict, 'pass');
  assert.equal(outcome.calls, 1);
  assert.equal(outcome.extendedMs, 1500);
  assert.deepEqual(world.calls, [1500]);
});

test('awaitState times out on a stable unsettled page without spending the load budget', async () => {
  const world = clocked(0);
  world.provider.judge = async (body) => {
    world.calls.push(0);
    return result(body.statements.map((statement) => predicate(statement.name, 0.5)));
  };
  const outcome = await awaitState(
    { name: 'page_ready', statement: 'The page is ready.' },
    world.observer,
    world.provider,
    { maxMs: 1000, maxCalls: 4, maxLoadMs: 5000, now: world.now, sleep: world.sleep }
  );
  assert.equal(outcome.verdict, 'timeout');
  assert.equal(outcome.calls, 1);
  assert.equal(outcome.extendedMs, 0);
});

test('a page that stays loading spends maxLoadMs and does not call the model', async () => {
  const world = clocked(1_000_000);
  let judged = 0;
  world.provider.judge = async () => {
    judged += 1;
    return result([]);
  };
  const outcome = await awaitState(
    { name: 'page_ready', statement: 'The page is ready.' },
    world.observer,
    world.provider,
    { maxMs: 1000, maxCalls: 4, maxLoadMs: 5000, pollMs: 500, now: world.now, sleep: world.sleep }
  );
  assert.equal(outcome.verdict, 'timeout');
  assert.equal(outcome.calls, 0);
  assert.equal(outcome.extendedMs, 5000);
  assert.equal(judged, 0);
});

test('needs_human stops only for a real kind, and an invalid judgment stays unsettled', async () => {
  const observation = {
    page: PAGE,
    elements: [],
    facts: { readyState: 'complete', marker: 'm' },
    deltas: {},
  };
  const observer = {
    async observe() {
      return observation;
    },
  };
  let clock = 0;
  const sleep = async (ms: number) => {
    clock += ms;
  };
  const human = await awaitState(
    { name: 'page_ready', statement: 'The page is ready.' },
    observer,
    {
      async judge() {
        return result([
          predicate('loading', 0.05),
          predicate('needs_human', 0.8),
          predicate('page_ready', 0.99),
          { name: 'human_kind', kind: 'choice', choice: 'login', probabilities: { login: 1 }, confidence: 1 },
        ]);
      },
    },
    { maxMs: 1000, maxCalls: 2, now: () => clock, sleep }
  );
  assert.equal(human.verdict, 'needs_human');
  assert.equal(human.humanKind, 'login');

  clock = 0;
  const none = await awaitState(
    { name: 'page_ready', statement: 'The page is ready.' },
    observer,
    {
      async judge() {
        return result([
          predicate('loading', 0.05),
          predicate('needs_human', 0.9),
          predicate('page_ready', 0.95),
          { name: 'human_kind', kind: 'choice', choice: 'none', probabilities: { none: 1 }, confidence: 1 },
        ]);
      },
    },
    { maxMs: 1000, maxCalls: 2, now: () => clock, sleep }
  );
  assert.equal(none.verdict, 'pass');
  assert.equal(none.humanKind, undefined);

  clock = 0;
  const invalid = await awaitState(
    { name: 'page_ready', statement: 'The page is ready.' },
    observer,
    {
      async judge() {
        throw new DecisionInvalid('Invalid judgment probability; no action executed.');
      },
    },
    { maxMs: 1000, maxCalls: 2, now: () => clock, sleep }
  );
  assert.equal(invalid.verdict, 'timeout');
  assert.ok(invalid.calls >= 1);
  await assert.rejects(
    awaitState(
      { name: 'page_ready', statement: 'ready' },
      observer,
      {
        async judge() {
          return result([]);
        },
      },
      { maxMs: 0, maxCalls: 1 }
    )
  );
});

test('one observation judges every pending statement in one call', async () => {
  const world = clocked(0);
  const seen: string[][] = [];
  world.provider.judge = async (body) => {
    seen.push(body.statements.map((statement) => statement.name));
    world.calls.push(world.now());
    return result(
      body.statements.map((statement) =>
        predicate(statement.name, statement.name === 'loading' || statement.name === 'needs_human' ? 0.05 : 0.95)
      )
    );
  };
  const outcome = await awaitStates(
    [
      { name: 'page_ready', statement: 'The page is ready.' },
      { name: 'composer_clean', statement: 'The composer is empty.' },
    ],
    world.observer,
    world.provider,
    { maxMs: 1000, maxCalls: 4, maxLoadMs: 5000, pollMs: 500, now: world.now, sleep: world.sleep }
  );
  assert.equal(outcome.calls, 1);
  assert.deepEqual(
    outcome.statements.map((statement) => statement.verdict),
    ['pass', 'pass']
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.includes('page_ready'), true);
  assert.equal(seen[0]?.includes('composer_clean'), true);
  assert.equal(seen[0]?.includes('loading'), true);
});

test('two refusals drop that statement from later model calls', async () => {
  const world = clocked(0);
  let judged = 0;
  world.provider.judge = async (body) => {
    judged += 1;
    world.calls.push(world.now());
    return result(body.statements.map((statement) => ({ name: statement.name, kind: 'refusal' as const })));
  };
  const outcome = await awaitState(
    { name: 'page_ready', statement: 'The page is ready.' },
    world.observer,
    world.provider,
    { maxMs: 10_000, maxCalls: 4, maxLoadMs: 10_000, pollMs: 500, now: world.now, sleep: world.sleep }
  );
  assert.equal(outcome.verdict, 'timeout');
  assert.equal(outcome.calls, 2);
  assert.equal(judged, 2);
});

test('a backoff sleep counts the model call already in flight', async () => {
  let clock = 0;
  const observation = {
    page: PAGE,
    elements: [],
    facts: { readyState: 'complete' as const, marker: 'm' },
    deltas: {},
  };
  let slept = 0;
  const outcome = await awaitState(
    { name: 'page_ready', statement: 'The page is ready.' },
    {
      async observe() {
        return observation;
      },
    },
    {
      async judge() {
        clock += 2_000;
        throw new DecisionInvalid('synthetic');
      },
    },
    {
      maxMs: 5_000,
      maxCalls: 4,
      maxLoadMs: 5_000,
      pollMs: 500,
      now: () => clock,
      sleep: async (ms: number) => {
        slept += ms;
        clock += ms;
      },
    }
  );
  assert.equal(outcome.verdict, 'timeout');
  assert.equal(outcome.calls, 1);
  assert.equal(slept, 500);
});

test(
  'optional live judgment smoke',
  {
    skip:
      process.env.JEV_LIVE_DECISIONS !== 'openai' && process.env.JEV_LIVE_DECISIONS !== 'typesafe'
        ? 'set JEV_LIVE_DECISIONS=openai or typesafe to send a judgment'
        : false,
    timeout: 90_000,
  },
  async () => {
    const path = process.env.HUD_JEV_ENV;
    if (!path) throw new Error('HUD_JEV_ENV is required for the live smoke');
    const env: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const eq = line.indexOf('=');
      if (eq < 1 || line.trim().startsWith('#')) continue;
      env[line.slice(0, eq).trim()] = line
        .slice(eq + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '');
    }
    const which = process.env.JEV_LIVE_DECISIONS;
    const secrets = [env.OPENAI_API_KEY, env.TYPESAFE_API_KEY].filter((value) => Boolean(value));
    const body = request({ choices: undefined });
    let sent = '';
    const fetcher: typeof fetch = async (url, init) => {
      sent = String(init?.body ?? '');
      for (const secret of secrets) {
        if (secret && sent.includes(secret)) throw new Error('live_body_leaked_credential');
      }
      return fetch(url, init);
    };
    const provider =
      which === 'openai'
        ? new OpenAIDecisionProvider({ apiKey: env.OPENAI_API_KEY ?? '', fetcher })
        : new TypeSafeDecisionProvider({ apiKey: env.TYPESAFE_API_KEY ?? '', model: env.TYPESAFE_MODEL, fetcher });
    const decided = await provider.judge(body, { cacheKey: 'hud-jev:j1b-live', signal: AbortSignal.timeout(60_000) });
    const expected =
      which === 'openai'
        ? JSON.stringify(buildOpenAIJudgmentBody(body, 'hud-jev:j1b-live'))
        : JSON.stringify(buildTypeSafeJudgmentBody(body, provider.model));
    assert.equal(sent, expected);
    assert.ok(Array.isArray(decided.answers));
  }
);
