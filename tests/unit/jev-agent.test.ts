// Translation of Jev Ultrafast tests/test_agent.py, plus setGoal, the snapshot asset, and a fake CDP tab.
// The flight-verification case is not ported: it lives in examples/flights.py, outside the J1 list.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Agent, textProviderFromEnv, type BrowserPort, type TextProvider } from '../../src/jev/agent.js';
import {
  Browser,
  StalePage,
  browserOperation,
  fingerprint,
  locateJevSnapshot,
  type CdpInvoker,
} from '../../src/jev/browser.js';
import { DecisionRefused, choose, type DecisionProvider, type ResolvedDecision } from '../../src/jev/decide.js';
import {
  DecisionInvalid,
  actionSpace,
  buildDecisionRequest,
  fieldText,
  validateChoice,
  type ChoiceAnswer,
  type DecisionRequest,
  type FieldContext,
  type PageState,
} from '../../src/jev/model.js';
import { buildTypeSafeBody } from '../../src/jev/providers/typesafe.js';
import { startFakeCdp } from './jev-cdp-fake.js';
import { FIXTURE_GOAL, choiceAnswer, searchPage } from './jev-page.js';

const SNAPSHOT_BODY_SHA256 = 'e50473501c8fb8e70f3b21866d987393e3f2315c639d638bd477d170e81ed78d';

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../../..');
}

function choice(ids: string[], selected: string): ChoiceAnswer {
  const probabilities: Record<string, number> = {};
  for (const id of ids) probabilities[id] = id === selected ? 1 : 0;
  return { choice: selected, confidence: 1, probabilities };
}

function emptyRequest(): DecisionRequest {
  return { page: { url: '', title: '', text: '' }, elements: [], recentActions: [], goal: '', questions: [] };
}

function decision(action = 'e1', operation = 'TYPE_TEXT', target: string | null = '1'): ResolvedDecision {
  return {
    choice: action,
    operation,
    target,
    confidence: 1,
    probabilities: { [action]: 1 },
    operation_probabilities: { [operation]: 1 },
    target_probabilities: target == null ? {} : { [target]: 1 },
    target_confidence: target == null ? null : 1,
    raw_answers: [],
    model: 'test',
    usage: {},
    latency_ms: 10,
    request: emptyRequest(),
  };
}

function answering(operation = 'CLICK', target = '2'): DecisionProvider {
  return {
    id: 'typesafe',
    model: 'test',
    async decide(request) {
      const answers = request.questions.map((question) => {
        const ids = question.choices.map((item) => item.value);
        const selected =
          question.name === 'operation'
            ? operation
            : question.name === `${operation.toLowerCase()}_target`
              ? target
              : ids[0];
        return choiceAnswer(question.name, ids, selected);
      });
      return { answers, usage: {}, latencyMs: 1, raw: { model: 'test' } };
    },
  };
}

function harness(options: { text?: TextProvider | null; provider?: DecisionProvider } = {}) {
  const page = searchPage();
  const seen = { act: 0, observe: 0 };
  let freshImpl: BrowserPort['fresh'] = async () => true;
  let observeImpl: BrowserPort['observe'] = async () => {
    seen.observe += 1;
    return page;
  };
  let actImpl: BrowserPort['act'] = async () => {
    seen.act += 1;
    return { executed: 'x' };
  };
  const browser: BrowserPort = {
    fresh: (current, action) => freshImpl(current, action),
    observe: (screenshot) => observeImpl(screenshot),
    act: (action, current, text) => actImpl(action, current, text),
    close: async () => undefined,
  };
  const agent = new Agent(options.provider ?? answering(), options.text === undefined ? null : options.text, {
    browser,
    goal: FIXTURE_GOAL,
    page,
    decision: decision(),
    history: [],
    status: 'predicted',
    plan: [FIXTURE_GOAL],
    plan_index: 0,
    decisions: [],
    text_calls: [],
    elapsed_ms: 0,
    started_at: null,
    record: false,
  });
  return {
    agent,
    seen,
    page,
    setFresh(impl: BrowserPort['fresh']) {
      freshImpl = impl;
    },
    setObserve(impl: BrowserPort['observe']) {
      observeImpl = impl;
    },
    setAct(impl: BrowserPort['act']) {
      actImpl = impl;
    },
  };
}

function fieldContext(goal: string): FieldContext {
  return {
    goal,
    field: { label: 'Search', role: 'textbox', value: '' },
    page: { title: 'Search', text: 'Search' },
    recent_actions: [],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

for (const mutation of ['unknown', 'nan', 'missing', 'negative', 'non_max', 'confidence'] as const) {
  test(`invalid choice is rejected (${mutation})`, () => {
    const answer = choice(['a', 'b'], 'a');
    if (mutation === 'unknown') answer.choice = 'invented';
    else if (mutation === 'nan') answer.probabilities.a = Number.NaN;
    else if (mutation === 'missing') delete answer.probabilities.b;
    else if (mutation === 'negative') answer.probabilities.b = -1;
    else if (mutation === 'non_max') answer.choice = 'b';
    else answer.confidence = 5;
    assert.throws(
      () => validateChoice(answer, ['a', 'b']),
      (error) => {
        assert.ok(error instanceof DecisionInvalid);
        assert.match(error.message, /Invalid TypeSafe/);
        return true;
      }
    );
  });
}

test('one index per node, with one target list per operation', () => {
  const [elements, targets, controls] = actionSpace(searchPage().actions);
  assert.equal(elements.length, 2);
  assert.deepEqual(elements[0].operations, ['TYPE_TEXT', 'CLICK']);
  assert.equal(targets.TYPE_TEXT['1'].id, 'e1');
  assert.equal(targets.CLICK['1'].id, 'e2');
  assert.equal(targets.CLICK['2'].id, 'e3');
  assert.ok('WAIT' in controls);
});

test('a missing text model omits fill candidates', () => {
  const [elements, targets, controls] = actionSpace(
    [
      { id: 'only', kind: 'fill', label: 'Name', node: 1, role: 'textbox', value: '' },
      { id: 'wait', kind: 'wait', label: 'Wait' },
    ],
    false
  );
  assert.equal(elements.length, 0);
  assert.equal(targets.TYPE_TEXT, undefined);
  assert.ok('WAIT' in controls);
  const { agent } = harness();
  assert.equal(agent.snapshot().text_model, 'unconfigured');
  assert.deepEqual(agent.snapshot().elements[0].operations, ['CLICK']);
});

test('all heads are one request and only the selected head executes', async () => {
  let seen: DecisionRequest | undefined;
  const provider: DecisionProvider = {
    id: 'typesafe',
    model: 'test',
    async decide(request) {
      seen = request;
      const operationIds = request.questions[0].choices.map((item) => item.value);
      return {
        answers: [
          choiceAnswer('operation', operationIds, 'TYPE_TEXT'),
          choiceAnswer('type_text_target', ['1'], '1'),
          { name: 'click_target', kind: 'choice', choice: 'invented', probabilities: {}, confidence: Number.NaN },
        ],
        usage: {},
        latencyMs: 1,
        raw: { model: 'test' },
      };
    },
  };
  const result = await choose(searchPage(), FIXTURE_GOAL, [], provider, { cacheKey: 'hud-jev:test' });
  assert.ok(seen);
  assert.deepEqual(
    seen.questions.map((question) => question.name),
    ['operation', 'type_text_target', 'click_target']
  );
  assert.ok(!('refused' in result));
  assert.equal(result.operation, 'TYPE_TEXT');
  assert.equal(result.target, '1');
  assert.equal(result.choice, 'e1');
});

test('click cannot consume a text target', async () => {
  const provider: DecisionProvider = {
    id: 'typesafe',
    model: 'test',
    async decide(request) {
      return {
        answers: [
          choiceAnswer(
            'operation',
            request.questions[0].choices.map((item) => item.value),
            'CLICK'
          ),
          choiceAnswer('type_text_target', ['1'], '1'),
          choiceAnswer('click_target', ['1', '2', '999'], '999'),
        ],
        usage: {},
        latencyMs: 1,
        raw: { model: 'test' },
      };
    },
  };
  await assert.rejects(
    () => choose(searchPage(), FIXTURE_GOAL, [], provider, { cacheKey: 'hud-jev:test' }),
    (error) => {
      assert.ok(error instanceof DecisionInvalid);
      assert.match(error.message, /Invalid TypeSafe/);
      return true;
    }
  );
});

test('a target head receives control state and the full next-step rules', async () => {
  const page = searchPage();
  page.actions.unshift({
    id: 'toggle',
    kind: 'click',
    label: 'Free cancellation',
    node: 30,
    role: 'checkbox',
    checked: 'true',
    selected: false,
  });
  page.fingerprint = fingerprint(page);
  const built = buildDecisionRequest(page, 'Search with free cancellation', []);
  const body = buildTypeSafeBody(built.request, 'jev-latest') as {
    questions: Record<
      string,
      { criteria: Record<string, { checked?: string; selected?: boolean }>; instructions: { rules: string | string[] } }
    >;
  };
  const target = body.questions.click_target;
  assert.equal(target.criteria['1'].checked, 'true');
  assert.equal(target.criteria['1'].selected, false);
  const operationRules = body.questions.operation.instructions.rules;
  assert.ok(Array.isArray(target.instructions.rules));
  assert.ok(target.instructions.rules.includes(operationRules as string));
  const provider: DecisionProvider = {
    id: 'typesafe',
    model: 'test',
    async decide(request) {
      const click = request.questions.find((question) => question.name === 'click_target');
      return {
        answers: [
          choiceAnswer(
            'operation',
            request.questions[0].choices.map((item) => item.value),
            'CLICK'
          ),
          choiceAnswer('click_target', click?.choices.map((item) => item.value) ?? [], '3'),
        ],
        usage: {},
        latencyMs: 1,
        raw: { model: 'test' },
      };
    },
  };
  const result = await choose(page, 'Search with free cancellation', [], provider, { cacheKey: 'hud-jev:test' });
  assert.ok(!('refused' in result));
  assert.equal(result.choice, 'e3');
});

test('quoted task text still calls the text model', async () => {
  let calls = 0;
  let sent = '';
  const fetcher: typeof fetch = async (_url, init) => {
    calls += 1;
    sent = String(init?.body);
    return jsonResponse({ choices: [{ message: { content: '{"text":"Zurich"}' } }] });
  };
  const goal = 'Fly from "Zurich" to London';
  const [text] = await fieldText(fieldContext(goal), { TEXT_MODEL_API_KEY: 'test' }, fetcher);
  assert.equal(text, 'Zurich');
  assert.equal(calls, 1);
  const body = JSON.parse(sent) as { messages: Array<{ content: string }> };
  assert.equal(JSON.parse(body.messages[1].content).goal, goal);
});

test('a missing text credential stops before guessing', async () => {
  await assert.rejects(() => fieldText(fieldContext('Enter "Zurich"'), {}), /TEXT_MODEL_API_KEY/);
});

for (const content of ['Thinking: Zurich', '{"text":null}', '{"text":"Zurich","extra":true}', '{"text":123}']) {
  test(`text helper rejects invalid values (${content})`, async () => {
    const fetcher: typeof fetch = async () => jsonResponse({ choices: [{ message: { content } }] });
    await assert.rejects(
      () => fieldText(fieldContext('Find a flight'), { TEXT_MODEL_API_KEY: 'test' }, fetcher),
      /nothing typed/
    );
  });
}

test('a stale decision is consumed before any mutation', async () => {
  const box = harness();
  box.setFresh(async () => false);
  await assert.rejects(
    () => box.agent.command('act', { fingerprint: box.page.fingerprint }),
    (error) => error instanceof StalePage
  );
  assert.equal(box.seen.act, 0);
  assert.equal(box.agent.state.decision, null);
});

test('generated text is reused only for an identical retry context', async () => {
  const text = {
    count: 0,
    model: 'test',
    async fieldText() {
      text.count += 1;
      return { text: 'book', helper: { model: 'test', latency_ms: 10, usage: {} } };
    },
  };
  const box = harness({ text });
  let attempts = 0;
  box.setAct(async () => {
    attempts += 1;
    if (attempts === 1) throw new StalePage('Changed before input');
    return { executed: 'e1' };
  });
  await assert.rejects(() => box.agent.command('act', { fingerprint: box.page.fingerprint }), StalePage);
  box.agent.state.decision = decision();
  await box.agent.command('act', { fingerprint: box.page.fingerprint });
  assert.equal(text.count, 1);
  assert.equal(attempts, 2);
  assert.equal(box.agent.pendingText, null);
});

test('a changed field context does not reuse generated text', async () => {
  const text = {
    count: 0,
    model: 'test',
    async fieldText() {
      text.count += 1;
      return { text: 'book', helper: { model: 'test', latency_ms: 10, usage: {} } };
    },
  };
  const box = harness({ text });
  let attempts = 0;
  box.setAct(async () => {
    attempts += 1;
    if (attempts === 1) throw new StalePage('Changed before input');
    return { executed: 'e1' };
  });
  await assert.rejects(() => box.agent.command('act', { fingerprint: box.page.fingerprint }), StalePage);
  box.page.text = 'Different page context';
  box.agent.state.decision = decision();
  await box.agent.command('act', { fingerprint: box.page.fingerprint });
  assert.equal(text.count, 2);
});

test('loading waits do not trigger the no-progress stop', async () => {
  const box = harness();
  for (let i = 0; i < 5; i++) {
    box.agent.state.decision = decision('wait');
    await box.agent.command('act', { fingerprint: box.agent.state.page.fingerprint });
  }
  assert.equal(box.agent.state.history.length, 5);
  assert.equal(box.agent.state.status, 'ready');
});

test('a stale observation preserves the executed action', async () => {
  const box = harness();
  box.agent.state.decision = decision('e3');
  box.setObserve(async () => {
    throw new StalePage('changed');
  });
  await assert.rejects(() => box.agent.command('act', { fingerprint: box.page.fingerprint }), StalePage);
  assert.equal(box.agent.state.history.at(-1)?.action, 'Go');
  assert.equal(box.seen.act, 1);
});

test('observation is one atomic browser read', async () => {
  const calls: string[] = [];
  const cdp: CdpInvoker = async (method) => {
    calls.push(method);
    return { result: { value: searchPage() } };
  };
  const actual = (await browserOperation(
    { operation: 'observe', session: 'test', screenshot: false },
    cdp
  )) as PageState;
  assert.deepEqual(actual.actions, searchPage().actions);
  assert.deepEqual(calls, ['Runtime.evaluate']);
});

test('the executor rejects a stale page before browser input', async () => {
  const browser = Browser.bare();
  let operated = false;
  browser.fresh = async () => false;
  browser.operate = async () => {
    operated = true;
    return { executed: 'e1' };
  };
  await assert.rejects(
    () => browser.act(searchPage().actions[0], searchPage(), 'book'),
    (error) => error instanceof StalePage
  );
  assert.equal(operated, false);
});

for (const response of [{ exceptionDetails: { text: 'Execution context destroyed' } }, { result: {} }]) {
  test(`an interrupted dropdown cannot be retried as stale (${'exceptionDetails' in response ? 'exception' : 'empty'})`, async () => {
    let calls = 0;
    const cdp: CdpInvoker = async () => {
      calls += 1;
      return response;
    };
    await assert.rejects(
      () =>
        browserOperation(
          {
            operation: 'act',
            session: 'test',
            action: { id: 'e1', kind: 'select', node: 1, value: 'Design', label: 'Design' },
          },
          cdp
        ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof StalePage));
        assert.match(error.message, /Dropdown execution/);
        return true;
      }
    );
    assert.equal(calls, 1);
  });
}

test('fingerprint tracks values and identity, not screenshots', () => {
  const first = searchPage();
  const other = searchPage();
  other.screenshot = 'changed';
  assert.equal(fingerprint(first), fingerprint(other));
  other.actions[0].node = 99;
  assert.notEqual(fingerprint(first), fingerprint(other));
});

test('navigation during prediction reobserves without an action', async () => {
  const box = harness();
  box.setFresh(async () => {
    throw new StalePage('Document navigating');
  });
  await box.agent.command('tick');
  assert.equal(box.agent.state.status, 'ready');
  assert.equal(box.agent.state.decision, null);
  assert.equal(box.seen.act, 0);
  assert.equal(box.seen.observe, 1);
});

test('setGoal after DONE allows another predict and keeps history', async () => {
  const box = harness({ provider: answering() });
  box.agent.state.decision = decision('e3', 'CLICK', '2');
  await box.agent.command('act', { fingerprint: box.page.fingerprint });
  assert.equal(box.agent.state.history.length, 1);
  box.agent.state.decision = decision('DONE', 'DONE', null);
  await box.agent.command('act', { fingerprint: box.agent.state.page.fingerprint });
  assert.equal(box.agent.state.status, 'done');
  assert.equal(box.agent.state.plan_index, 1);
  await assert.rejects(() => box.agent.command('predict'), /stopped/);
  box.agent.setGoal('Fill the origin');
  assert.equal(box.agent.state.status, 'ready');
  assert.equal(box.agent.state.plan_index, 0);
  assert.equal(box.agent.state.goal, 'Fill the origin');
  assert.equal(box.agent.state.history.length, 1);
  assert.equal(box.agent.snapshot().decision, null);
  await box.agent.command('predict');
  assert.equal(box.agent.state.status, 'predicted');
  assert.equal(box.agent.snapshot().decision?.choice, 'e3');
});

test('no-progress is counted inside the current phase', async () => {
  const box = harness();
  const click = () => {
    box.agent.state.decision = decision('e3', 'CLICK', '2');
    return box.agent.command('act', { fingerprint: box.agent.state.page.fingerprint });
  };
  await click();
  await click();
  assert.equal(box.agent.state.status, 'ready');
  box.agent.setGoal('Fill the origin');
  await click();
  await click();
  assert.equal(box.agent.state.status, 'ready');
  assert.equal(box.agent.state.history.length, 4);
  await click();
  assert.equal(box.agent.state.status, 'blocked');
  assert.equal(box.agent.state.history.length, 5);
});

test('two refusals on the same fingerprint block without acting', async () => {
  let calls = 0;
  const provider: DecisionProvider = {
    id: 'openai',
    model: 'gpt-6-luna',
    async decide() {
      calls += 1;
      return { answers: [{ name: 'operation', kind: 'refusal' }], usage: {}, latencyMs: 1, raw: {} };
    },
  };
  const box = harness({ provider });
  box.agent.state.status = 'ready';
  await assert.rejects(
    () => box.agent.command('predict'),
    (error) => error instanceof DecisionRefused
  );
  assert.equal(calls, 2);
  assert.equal(box.seen.act, 0);
  assert.equal(box.seen.observe, 1);
  assert.equal(box.agent.state.status, 'blocked');
  assert.equal(box.agent.state.decision, null);
});

test('a changing page cannot loop paid calls after a refusal', async () => {
  let calls = 0;
  const provider: DecisionProvider = {
    id: 'openai',
    model: 'gpt-6-luna',
    async decide() {
      calls += 1;
      return { answers: [{ name: 'operation', kind: 'refusal' }], usage: {}, latencyMs: 1, raw: {} };
    },
  };
  const box = harness({ provider });
  let ticks = 0;
  box.setObserve(() => {
    box.seen.observe += 1;
    ticks += 1;
    const next = searchPage();
    next.text = `changed ${ticks}`;
    next.fingerprint = fingerprint(next);
    return next;
  });
  box.agent.state.status = 'ready';
  const started = Date.now();
  await assert.rejects(
    () => box.agent.command('predict'),
    (error) => error instanceof DecisionRefused
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(calls, 2);
  assert.equal(box.seen.act, 0);
  assert.equal(box.seen.observe, 1);
  assert.equal(box.agent.state.status, 'blocked');
  assert.equal(box.agent.state.decision, null);
  const refusals = box.agent.state.decisions as Array<{ fingerprint?: string }>;
  assert.equal(refusals.length, 2);
  assert.notEqual(refusals[0]?.fingerprint, refusals[1]?.fingerprint);
});

test('close aborts an in-flight decision and in-flight field text', async () => {
  let decisionArrived: (value?: void) => void = () => undefined;
  const decisionGate = new Promise<void>((resolve) => {
    decisionArrived = resolve;
  });
  const provider: DecisionProvider = {
    id: 'typesafe',
    model: 'test',
    decide(_request, options) {
      decisionArrived();
      return new Promise((_resolve, reject) => {
        const signal = options.signal;
        if (!signal) {
          reject(new Error('missing signal'));
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
    },
  };
  const box = harness({ provider });
  box.agent.state.status = 'ready';
  const pending = box.agent.command('predict');
  await decisionGate;
  await box.agent.close();
  await assert.rejects(pending);
  assert.equal(box.seen.act, 0);

  let textArrived: (value?: void) => void = () => undefined;
  const textGate = new Promise<void>((resolve) => {
    textArrived = resolve;
  });
  const fetcher: typeof fetch = (_url, init) => {
    textArrived();
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('missing signal'));
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
    });
  };
  const text = textProviderFromEnv(
    { TEXT_MODEL_API_KEY: 'configured', TEXT_MODEL_BASE_URL: 'https://example.test/v1' },
    fetcher
  );
  assert.ok(text);
  const fill = harness({ text });
  fill.agent.state.decision = decision('e1', 'TYPE_TEXT', '1');
  const acting = fill.agent.command('act', { fingerprint: fill.page.fingerprint });
  await textGate;
  await fill.agent.close();
  await assert.rejects(acting);
  assert.equal(fill.seen.act, 0);
});

test('snapshot.js body matches upstream and node --check accepts it', () => {
  const source = readFileSync(join(repoRoot(), 'src', 'jev', 'snapshot.js'));
  const newline = source.indexOf(0x0a);
  assert.equal(
    createHash('sha256')
      .update(source.subarray(newline + 1))
      .digest('hex'),
    SNAPSHOT_BODY_SHA256
  );
  assert.equal(source.subarray(newline + 1).length, 6490);
  const checked = spawnSync(process.execPath, ['--check', join(repoRoot(), 'src', 'jev', 'snapshot.js')], {
    encoding: 'utf8',
  });
  assert.equal(checked.status, 0, checked.stderr);
});

test('the snapshot locator prefers an adjacent file, then walks up to src/jev', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'jev-asset-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nested = join(root, 'dist', 'jev');
  mkdirSync(nested, { recursive: true });
  assert.throws(() => locateJevSnapshot(nested), /jev_snapshot_asset_missing/);
  mkdirSync(join(root, 'src', 'jev'), { recursive: true });
  writeFileSync(join(root, 'src', 'jev', 'snapshot.js'), 'walk\n');
  assert.equal(locateJevSnapshot(nested), join(root, 'src', 'jev', 'snapshot.js'));
  writeFileSync(join(nested, 'snapshot.js'), 'adjacent\n');
  assert.equal(locateJevSnapshot(nested), join(nested, 'snapshot.js'));
});

test('the build copies snapshot.js next to the compiled module', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(manifest.scripts.build, /copy-jev-assets\.mjs dist\b/);
  assert.match(manifest.scripts['build:test'], /copy-jev-assets\.mjs dist-test\b/);
  const destDir = mkdtempSync(join(tmpdir(), 'jev-copy-'));
  try {
    const dest = join(destDir, 'snapshot.js');
    const copied = spawnSync(process.execPath, [join(repoRoot(), 'scripts', 'copy-jev-assets.mjs'), dest], {
      encoding: 'utf8',
    });
    assert.equal(copied.status, 0, copied.stderr);
    const source = readFileSync(join(repoRoot(), 'src', 'jev', 'snapshot.js'));
    assert.deepEqual(readFileSync(dest), source);
    assert.equal(locateJevSnapshot(destDir), dest);
  } finally {
    rmSync(destDir, { recursive: true, force: true });
  }
});

test('the compiled module directory can locate the snapshot asset', () => {
  const moduleDir = dirname(fileURLToPath(new URL('../../src/jev/browser.js', import.meta.url)));
  const found = locateJevSnapshot(moduleDir);
  const source = readFileSync(found);
  const newline = source.indexOf(0x0a);
  assert.equal(
    createHash('sha256')
      .update(source.subarray(newline + 1))
      .digest('hex'),
    SNAPSHOT_BODY_SHA256
  );
});

test('a fake CDP server replays Runtime.evaluate on one owned tab', async () => {
  const fake = await startFakeCdp();
  try {
    const browser = await Browser.open('http://127.0.0.1/synthetic', { cdpUrl: fake.httpUrl, timeoutMs: 3000 });
    const state = await browser.observe(false);
    assert.equal(state.url, 'http://127.0.0.1/synthetic');
    assert.equal(state.title, 'Synthetic');
    assert.ok(fake.methods.includes('Runtime.evaluate'));
    assert.ok(fake.expressions.some((expression) => expression.includes('location.href')));
    assert.deepEqual(fake.created[0], { url: 'about:blank', background: true });
    assert.deepEqual(fake.navigated, ['http://127.0.0.1/synthetic']);
    assert.equal(
      fake.paths.some((path) => path.includes('/json/list')),
      false
    );
    await browser.close();
    assert.deepEqual(fake.closedTargets, ['jev1-owned-tab']);
  } finally {
    await fake.close();
  }
});

test('open accepts a normalised location without waiting out the deadline', async () => {
  const fake = await startFakeCdp({
    reportedHref: (url) => (url === 'about:blank' ? url : `${url}/`),
  });
  try {
    const started = Date.now();
    const browser = await Browser.open('http://127.0.0.1/synthetic', { cdpUrl: fake.httpUrl, timeoutMs: 3000 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `open took ${elapsed}ms`);
    assert.ok(fake.expressions.some((expression) => expression.includes("location.href !== 'about:blank'")));
    await browser.close();
  } finally {
    await fake.close();
  }
});
