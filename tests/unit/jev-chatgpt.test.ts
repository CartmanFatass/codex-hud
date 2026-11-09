// ChatGPT Pro target (M1): the linked model menu, the fill/send gate, the single Send click
// and the conversation binding. A stub browser, a stub decision provider and a fake clock.
// No browser, provider, config, state dir or HOME access.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { JevFailure } from '../../src/jev/ask/error.js';
import { Browser } from '../../src/jev/browser.js';
import { hiddenChrome } from '../fixtures/jev-hidden-chrome.js';
import { errorBody, jevCall } from '../../src/jev/runtime/ipc.js';
import { JevRuntime } from '../../src/jev/runtime/executor.js';
import type { JevJob } from '../../src/jev/runtime/types.js';
import { actionDecisionDiagnostic, type ActionDecisionDiagnostic } from '../../src/jev/runtime/diagnostic.js';
import {
  promptSha256,
  readOperation,
  sha256Hex,
  squashedSha256,
  type OperationRecord,
} from '../../src/jev/ask/records.js';
import type { Answer, DecisionProvider } from '../../src/jev/decide.js';
import { awaitState } from '../../src/jev/judge.js';
import type { DecisionRequest, ObservedAction, PageState } from '../../src/jev/model.js';
import {
  bindChatgpt,
  cardsMatch,
  chips,
  chatgptTarget,
  MENU_STATE,
  type OracleBrowser,
} from '../../src/jev/runtime/chatgpt.js';
import { FOCUS_COMPOSER, PAGE_FACTS } from '../../src/jev/runtime/chatgpt-facts.js';
import { chatgptStore, runOracle, type OracleFacts, type OracleTurn } from '../../src/jev/runtime/oracle.js';
import type { JevAskInput } from '../../src/jev/runtime/types.js';

const ROOT = 'https://chatgpt.example/';
const CONVERSATION = 'https://chatgpt.example/c/00000000-0000-4000-8000-000000000000';
const PROMPT = 'synthetic prompt one';
const ANSWER = 'synthetic answer';
const KEY = 'ask-pro:synthetic0001';
const INPUT: JevAskInput = {
  tag: 'ask',
  target: 'chatgpt-pro',
  label: 'synthetic',
  prompt: PROMPT,
  conversation: 'new',
};

function failure(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof JevFailure && error.code === code;
}

async function rejects(code: string, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, failure(code));
}

/**
 * The owner CLI's command_wait reads `args.mode or data["mode"]` and command_reconcile
 * indexes `data["mode"]`; every other field those commands read must be present too.
 * A missing key is a Python KeyError, so this helper throws like one.
 */
function ownerWaitView(data: Record<string, unknown>, argsMode?: string): Record<string, unknown> {
  const mode = argsMode || data['mode'];
  if (mode === undefined) throw new Error("KeyError: 'mode'");
  const view: Record<string, unknown> = { mode };
  for (const field of [
    'prompt_sha256',
    'squashed_sha256',
    'conversation_url',
    'send_attempted',
    'sent_target_id',
    'before',
    'sidebar_before',
  ]) {
    if (data[field] === undefined) throw new Error(`KeyError: '${field}'`);
    view[field] = data[field];
  }
  return view;
}

/** Time only moves on sleep, so every wait costs its sleeps and nothing else. */
function clock(start = 1_700_000_000_000): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let time = start;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

// ---------------------------------------------------------------- stub browser

interface StubMenu {
  linked: boolean;
  allowed?: number[];
  radios?: string[];
  slider?: { now: number; max: number; effort: string } | null;
  trigger?: string;
  menu?: string;
  count?: number;
}

interface StubPageState {
  url: string;
  composer: string | null;
  turns: OracleTurn[];
  cards: string[] | null;
  send: boolean;
  stop: boolean;
  sidebar: string[];
}

interface Stub {
  browser: OracleBrowser;
  state: StubPageState;
  menu: StubMenu;
  extraFill: boolean;
  uploadedCards: string[] | null;
  uploadId: string | null;
  typed: string | null;
  fillTexts: string[];
  acts: string[];
  events: string[];
  keys: string[];
  commands: string[];
  files: string[];
  goals: string[];
  opened: string[];
  sendClicks: number;
  modeClicks: number;
  closed: number;
  detached: number;
}

interface StubOptions {
  state?: Partial<StubPageState>;
  menu?: Partial<StubMenu>;
  extraFill?: boolean;
  uploadedCards?: string[] | null;
  uploadId?: string | null;
  mode?: 'headless' | 'headed';
}

/** The model pill the page shows for the current menu state. */
function pillOf(menu: StubMenu): string {
  if (!menu.linked) return '';
  const model = menu.radios?.[0] ?? '';
  const effort = menu.slider ? menu.slider.effort : (menu.radios?.[1] ?? '');
  return `${model} ${effort}`.trim();
}

function pageFacts(stub: Stub): Record<string, unknown> {
  return {
    url: stub.state.url,
    title: 'Synthetic chat',
    readyState: 'complete',
    sidebar_hrefs: [...stub.state.sidebar],
    composer: stub.state.composer,
    send_button: stub.state.send,
    attachment_cards: stub.state.cards,
    turns: stub.state.turns.map((turn) => ({ ...turn })),
    stop_button: stub.state.stop,
  };
}

/** Node 1 is the composer, 2 Send, 3 the composer model trigger, 5 a foreign text field. */
function nodeFacts(node: number): Record<string, unknown> {
  return {
    testid: null,
    id: '',
    inside_composer_form: node !== 5,
    role: null,
    haspopup: node === 3 ? 'menu' : null,
    model_trigger: node === 3,
    expanded: node === 3 ? 'false' : null,
    is_composer: node === 1,
    is_send: node === 2,
    text: '',
  };
}

function chatgptStub(overrides: StubOptions = {}): Stub {
  const stub = {
    state: {
      url: ROOT,
      composer: '',
      turns: [],
      cards: [],
      send: true,
      stop: false,
      sidebar: [],
      ...overrides.state,
    },
    menu: {
      linked: true,
      allowed: [3],
      radios: ['GPT-6'],
      slider: { now: 10, max: 10, effort: 'Pro' },
      trigger: 'model-trigger',
      menu: 'model-menu',
      ...overrides.menu,
    },
    extraFill: overrides.extraFill ?? false,
    uploadedCards: overrides.uploadedCards ?? null,
    uploadId: overrides.uploadId === undefined ? 'upload-files' : overrides.uploadId,
    typed: null,
    fillTexts: [],
    acts: [],
    events: [],
    keys: [],
    commands: [],
    files: [],
    goals: [],
    opened: [],
    sendClicks: 0,
    modeClicks: 0,
    closed: 0,
    detached: 0,
  } as unknown as Stub;
  stub.browser = {
    id: 'target-1',
    mode: overrides.mode,
    async evaluate(expression: string): Promise<unknown> {
      if (expression === PAGE_FACTS) return pageFacts(stub);
      if (expression === MENU_STATE) {
        return {
          ...stub.menu,
          slider: stub.menu.slider ? { ...stub.menu.slider } : null,
          pill: pillOf(stub.menu),
        };
      }
      if (expression.includes('upload-files')) return stub.uploadId;
      if (expression.startsWith('(node =>')) {
        const match = /\)\((\d+)\)$/.exec(expression);
        return match ? nodeFacts(Number(match[1])) : null;
      }
      // The composer-clean check clones the form without its controls.
      if (expression.includes('cloneNode')) return '';
      // The model pill list the gate compares against the proven menu pill.
      if (expression.includes('filter(t=>t.includes(')) return [pillOf(stub.menu)];
      // The slider focus call before the code-owned End key.
      return undefined;
    },
    async command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      stub.commands.push(method);
      if (method === 'Input.dispatchKeyEvent') {
        const key = typeof params.key === 'string' ? params.key : '';
        stub.keys.push(key);
        // One key press is a keyDown and a keyUp; the page sees it once.
        if (key === 'Escape' && params.type === 'keyDown') stub.events.push('escape');
        if (key === 'Backspace' && params.type === 'keyDown') stub.state.composer = '';
        if (key === 'End' && stub.menu.slider) {
          stub.menu.slider.now = stub.menu.slider.max;
          stub.menu.slider.effort = 'Pro';
        }
        return {};
      }
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 42 };
      if (method === 'DOM.setFileInputFiles') {
        const files = params.files;
        if (Array.isArray(files)) stub.files.push(...files.map(String));
        stub.state.cards = stub.uploadedCards;
        return {};
      }
      return {};
    },
    async observe(): Promise<PageState> {
      const actions: ObservedAction[] = [
        { id: 'composer', kind: 'fill', label: 'Composer', role: 'textbox', node: 1 },
        { id: 'send', kind: 'click', label: 'Send', role: 'button', node: 2 },
        { id: 'model-trigger', kind: 'click', label: 'Model', role: 'button', node: 3 },
      ];
      if (stub.extraFill) actions.push({ id: 'search', kind: 'fill', label: 'Search field', role: 'textbox', node: 5 });
      return { url: stub.state.url, title: 'Synthetic chat', text: '', actions };
    },
    async fresh(): Promise<boolean> {
      return true;
    },
    async act(action: ObservedAction, _page: PageState, text?: string | null): Promise<void> {
      stub.acts.push(action.id);
      if (action.kind === 'fill') {
        stub.typed = text ?? null;
        stub.fillTexts.push(text ?? '');
        stub.state.composer = text ?? '';
        stub.events.push('fill');
        return;
      }
      if (action.id === 'send') {
        stub.sendClicks += 1;
        stub.events.push('send');
        return;
      }
      if (action.id === 'model-trigger') {
        stub.modeClicks += 1;
        stub.events.push('mode-trigger');
        // The click opens the menu the page had not linked yet.
        stub.menu.linked = true;
        return;
      }
      stub.events.push(`click:${action.id}`);
    },
    async close(): Promise<void> {
      stub.closed += 1;
    },
    async detach(): Promise<void> {
      stub.detached += 1;
    },
  };
  return stub;
}

function targetOptions(stub: Stub, extra: { model?: string; effortWord?: string } = {}) {
  const ticks = clock();
  return {
    root: ROOT,
    open: async (url: string) => {
      stub.opened.push(url);
      return stub.browser;
    },
    attach: async (id: string) => {
      stub.opened.push(id);
      return stub.browser;
    },
    targets: async () => [{ targetId: 'target-1', url: stub.state.url }],
    now: ticks.now,
    sleep: ticks.sleep,
    ...extra,
  };
}

// ---------------------------------------------------------------- stub provider

interface Plan {
  operation: string;
  /** A target index or a substring of the target's description. */
  target?: string;
}

type Picker = (goal: string) => Plan;

function defaultPick(goal: string): Plan {
  if (goal.startsWith('Fill')) return { operation: 'TYPE_TEXT', target: 'Composer' };
  if (goal.startsWith('Click Send')) return { operation: 'CLICK', target: 'Send' };
  return { operation: 'CLICK', target: 'Model' };
}

/** Full coverage, the choice is a maximum, the mass sums to one. */
function distribution(ids: string[], chosen: string): Record<string, number> {
  if (ids.length === 1) return { [ids[0]!]: 1 };
  const rest = 0.1 / (ids.length - 1);
  return Object.fromEntries(ids.map((id) => [id, id === chosen ? 0.9 : rest]));
}

function describe(request: DecisionRequest, name: string, id: string): string {
  const question = request.questions.find((item) => item.name === name);
  const choice = question?.choices.find((item) => item.value === id);
  if (!choice) return '';
  return typeof choice.description === 'string' ? choice.description : choice.description.element;
}

function providerOf(
  stub: Stub,
  options: { pick?: Picker; judge?: Record<string, number>; onDecide?: (goal: string) => void } = {}
): DecisionProvider {
  const pick = options.pick ?? defaultPick;
  // Hydrated empty composers use facts; unresolved page states use these judgments.
  const judged: Record<string, number> = { page_ready: 0.95, ...options.judge };
  return {
    id: 'typesafe',
    model: 'synthetic',
    async decide(request) {
      stub.goals.push(request.goal);
      options.onDecide?.(request.goal);
      const plan = pick(request.goal);
      const operation = request.questions.find((item) => item.name === 'operation');
      if (!operation) throw new Error('operation_question_missing');
      const operationIds = operation.choices.map((choice) => choice.value);
      if (!operationIds.includes(plan.operation)) throw new Error(`operation_missing:${plan.operation}`);
      const answers: Answer[] = [
        {
          name: 'operation',
          kind: 'choice',
          choice: plan.operation,
          probabilities: distribution(operationIds, plan.operation),
          confidence: 0.9,
        },
      ];
      const name = `${plan.operation.toLowerCase()}_target`;
      const target = request.questions.find((item) => item.name === name);
      if (target) {
        const ids = target.choices.map((choice) => choice.value);
        const wanted = plan.target;
        const chosen =
          (wanted !== undefined && ids.includes(wanted) ? wanted : undefined) ??
          (wanted === undefined
            ? ids[0]
            : ids.find((id) => describe(request, name, id).toLowerCase().includes(wanted.toLowerCase()))) ??
          ids[0];
        answers.push({
          name,
          kind: 'choice',
          choice: chosen,
          probabilities: distribution(ids, chosen),
          confidence: 0.9,
        });
      }
      return { answers, usage: {}, latencyMs: 0, raw: null };
    },
    async judge(request) {
      const answers: Answer[] = request.statements.map((statement) => ({
        name: statement.name,
        kind: 'predicate',
        probability: judged[statement.name] ?? 0,
      }));
      answers.push({ name: 'human_kind', kind: 'choice', choice: 'none', probabilities: { none: 1 }, confidence: 1 });
      return { answers, usage: {}, latencyMs: 0, raw: null };
    },
  };
}

// ---------------------------------------------------------------- prepare and click

test('T1: ready heavy ChatGPT facts and a long restored draft pass the real page_ready wait', async () => {
  const stub = chatgptStub({ state: { composer: 'synthetic restored draft '.repeat(4000) } });
  let elapsed = 0;
  let samples = 0;
  let readyAt = -1;
  const originalObserve = stub.browser.observe.bind(stub.browser);
  stub.browser.observe = async () => {
    samples++;
    elapsed += 75; // CDP/snapshot cost is charged to awaitState's real clock seam.
    const page = await originalObserve(false);
    return { ...page, text: 'synthetic heavy DOM '.repeat(40_000) };
  };
  const evaluate = stub.browser.evaluate.bind(stub.browser);
  stub.browser.evaluate = async (script) => {
    if (script === MENU_STATE && readyAt < 0) readyAt = elapsed;
    if (script === PAGE_FACTS && elapsed < 2_000) return { ...pageFacts(stub), composer: null };
    return evaluate(script);
  };
  const target = chatgptTarget({
    ...targetOptions(stub),
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
  });
  const provider = providerOf(stub);
  let judgments = 0;
  provider.judge = async () => {
    judgments++;
    return { answers: [{ name: 'page_ready', kind: 'predicate', probability: 0 }], usage: {}, latencyMs: 0, raw: null };
  };
  const page = await target.open(ROOT);
  await target.prepare(page, INPUT, provider, new AbortController().signal);
  assert.ok(readyAt >= 0 && readyAt < 5_000, `page_ready + draft clear cost ${readyAt}ms`);
  assert.equal(judgments, 0, 'never ask a denying judge about the unhydrated shell');
  assert.ok(samples >= 2, 'the real awaitState stability loop ran');
  assert.equal(stub.sendClicks, 0);
});

test('T1b: replay the recorded loading=.99 judgment across shell hydration, call exhaustion and changing markers', async (t) => {
  for (const mode of ['hydrates', 'never', 'changing_marker'] as const) {
    const stub = chatgptStub({ state: { composer: null } });
    let elapsed = 0;
    let judgments = 0;
    let samples = 0;
    const evaluate = stub.browser.evaluate.bind(stub.browser);
    stub.browser.evaluate = async (script) => {
      if (script === PAGE_FACTS) {
        samples++;
        const composer =
          mode === 'never' || elapsed < 3_600
            ? null
            : 'synthetic long restored draft '.repeat(1000) + (mode === 'changing_marker' ? samples : '');
        return { ...pageFacts(stub), composer };
      }
      // Readiness is the step under test. Stop before any mode/fill preparation.
      if (script === FOCUS_COMPOSER || script === MENU_STATE) throw new Error('readiness_passed');
      return evaluate(script);
    };
    stub.browser.observe = async () => ({ url: ROOT, text: 'synthetic DOM '.repeat(40_000), actions: [] });
    const provider = providerOf(stub);
    provider.judge = async () => {
      judgments++;
      return {
        answers: [
          { name: 'loading', kind: 'predicate', probability: 0.99 },
          { name: 'page_ready', kind: 'predicate', probability: 0 },
          { name: 'needs_human', kind: 'predicate', probability: 0 },
          { name: 'human_kind', kind: 'choice', choice: 'none', probabilities: { none: 1 }, confidence: 1 },
        ],
        usage: {},
        latencyMs: 0,
        raw: null,
      };
    };
    const target = chatgptTarget({
      ...targetOptions(stub),
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    });
    const page = await target.open(ROOT);
    if (mode === 'hydrates') {
      await assert.rejects(target.prepare(page, INPUT, provider, new AbortController().signal), /readiness_passed/);
      assert.ok(elapsed < 6_000, 'facts fast path is rechecked after loading/hydration');
    } else {
      await rejects('page_ready_timeout', () => target.prepare(page, INPUT, provider, new AbortController().signal));
      assert.equal(elapsed, mode === 'never' ? 30_000 : 90_000);
    }
    assert.equal(judgments, 0, 'hydration and changing markers do not spend the judge budget');
    t.diagnostic(`${mode}: elapsed=${elapsed}, samples=${samples}, calls=${judgments}`);
  }
});

test('T1b slow loading call rechecks real ChatPage facts after the load backoff no longer fits', async () => {
  const stub = chatgptStub();
  let elapsed = 0;
  const evaluate = stub.browser.evaluate.bind(stub.browser);
  stub.browser.evaluate = async (script) =>
    script === PAGE_FACTS
      ? { ...pageFacts(stub), composer: elapsed < 3_600 ? null : 'synthetic draft '.repeat(1000) }
      : evaluate(script);
  const target = chatgptTarget(targetOptions(stub));
  const page = await target.open(ROOT);
  const outcome = await awaitState(
    { name: 'page_ready', statement: 'The composer is ready and idle.' },
    {
      async observe() {
        const observation = await page.observation(await page.facts());
        // Reproduce the original adapter's document.complete shell. T1 separately
        // pins the new hydration rule; this test isolates the shared wait bug.
        observation.facts.readyState = 'complete';
        return observation;
      },
    },
    {
      async judge() {
        elapsed += 30_000;
        return {
          answers: [
            { name: 'loading', kind: 'predicate', probability: 0.99 },
            { name: 'page_ready', kind: 'predicate', probability: 0 },
            { name: 'needs_human', kind: 'predicate', probability: 0 },
            { name: 'human_kind', kind: 'choice', choice: 'none', probabilities: { none: 1 }, confidence: 1 },
          ],
          usage: {},
          latencyMs: 30_000,
          raw: null,
        };
      },
    },
    {
      maxMs: 60_000,
      maxLoadMs: 30_000,
      maxCalls: 4,
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
      fastPath: (observation) =>
        observation.facts.composer_sha256 === squashedSha256('synthetic draft '.repeat(1000)) ? 'pass' : null,
    }
  );
  assert.equal(outcome.verdict, 'pass');
  assert.equal(outcome.calls, 1);
  assert.ok(elapsed < 40_000, `rechecked the ready facts at ${elapsed}ms`);
});

test('T1 fault: a ChatGPT shell that never hydrates expires at maxLoadMs, not the stable budget', async () => {
  const stub = chatgptStub({ state: { composer: null } });
  const ticks = clock(0);
  const target = chatgptTarget({ ...targetOptions(stub), ...ticks });
  const page = await target.open(ROOT);
  await rejects('page_ready_timeout', () =>
    target.prepare(page, INPUT, providerOf(stub), new AbortController().signal)
  );
  assert.equal(ticks.now(), 30_000, 'hydration cannot consume the additional stable-page budget');
  assert.equal(stub.sendClicks, 0);
});

test('page_ready judgment deny is page_ready_denied, not a timeout', async () => {
  const stub = chatgptStub({ state: { composer: null } });
  const evaluate = stub.browser.evaluate.bind(stub.browser);
  // Affirmative page-error evidence is not hydration; a judgment may deny it.
  stub.browser.evaluate = async (script) =>
    script === PAGE_FACTS ? { ...pageFacts(stub), page_error: true } : evaluate(script);
  const target = chatgptTarget(targetOptions(stub));
  const page = await target.open(ROOT);
  await rejects('page_ready_denied', () =>
    target.prepare(page, INPUT, providerOf(stub, { judge: { page_ready: 0 } }), new AbortController().signal)
  );
});

test('T2: clear a stale draft exactly as the owner driver before filling; never mix it into the prompt', async () => {
  const draft = 'synthetic stale draft '.repeat(300);
  const stub = chatgptStub({ state: { composer: draft } });
  const events: Array<unknown> = [];
  const evaluate = stub.browser.evaluate.bind(stub.browser);
  stub.browser.evaluate = async (script) => {
    if (script === FOCUS_COMPOSER) events.push('focus');
    return evaluate(script);
  };
  const command = stub.browser.command.bind(stub.browser);
  stub.browser.command = async (method, params) => {
    if (method === 'Input.dispatchKeyEvent') events.push(params);
    return command(method, params);
  };
  const act = stub.browser.act.bind(stub.browser);
  stub.browser.act = async (action, page, text) => {
    if (action.kind === 'fill') assert.equal(stub.state.composer, '', 'clear before the hit-tested fill');
    return act(action, page, text);
  };
  const target = chatgptTarget(targetOptions(stub));
  const facts = await target.prepare(await target.open(ROOT), INPUT, providerOf(stub), new AbortController().signal);
  assert.deepEqual(events.slice(0, 5), [
    'focus',
    { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'] },
    { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 },
    { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  ]);
  assert.equal(facts.recordFields?.draft_replaced_sha256, sha256Hex(draft));
  assert.equal(facts.composer, PROMPT);
  assert.deepEqual(stub.fillTexts, [PROMPT]);
  assert.equal(stub.sendClicks, 0);
});

test('D1 cancellation during a slow observation is an abort, not page_ready_timeout', async () => {
  const stub = chatgptStub({ state: { composer: '' } });
  const controller = new AbortController();
  let time = 0;
  stub.browser.observe = async () => {
    time += 90_000;
    controller.abort(new Error('synthetic_stop'));
    return { url: ROOT, text: '', actions: [] };
  };
  const target = chatgptTarget({ ...targetOptions(stub), now: () => time });
  await assert.rejects(
    target.prepare(await target.open(ROOT), INPUT, providerOf(stub), controller.signal),
    /synthetic_stop/
  );
  assert.equal(stub.sendClicks, 0);
});

test('chatgpt target: proves the menu, fills the exact prompt and binds one Send click', async () => {
  const stub = chatgptStub();
  const target = chatgptTarget(targetOptions(stub));
  const page = await target.open(stub.state.url);
  const facts = await target.prepare(page, INPUT, providerOf(stub), new AbortController().signal);
  // The proven menu is closed with Escape before any text is typed.
  assert.deepEqual(stub.events, ['escape', 'fill']);
  assert.equal(stub.typed, PROMPT);
  assert.deepEqual(stub.fillTexts, [PROMPT]);
  assert.equal(stub.sendClicks, 0, 'prepare never clicks Send');
  assert.equal(facts.composer, PROMPT);
  assert.equal(facts.human, undefined);
  assert.equal(facts.stop, false);
  // A synthetic browser without a mode falls back to the requested headless mode.
  assert.equal(facts.recordFields?.mode, 'headless');
  assert.equal(target.matchesDraft(facts, INPUT), true);
  assert.equal(target.matchesDraft(facts, { ...INPUT, prompt: 'other prompt' }), false);
  // One fill decision, then one send decision: the slider and the radios were not provider work.
  assert.deepEqual(
    stub.goals.map((goal) => (goal.startsWith('Fill') ? 'fill' : goal.startsWith('Click Send') ? 'send' : 'mode')),
    ['fill', 'send']
  );
  await target.click(page, new AbortController().signal);
  assert.equal(stub.sendClicks, 1);
  assert.deepEqual(stub.events, ['escape', 'fill', 'send']);
  // A send is chosen once; a second click has nothing to act on.
  await rejects('send.not_chosen', () => target.click(page, new AbortController().signal));
  assert.equal(stub.sendClicks, 1);
});

test('chatgpt target: mode evidence must be linked and proven before the fill', async () => {
  const stub = chatgptStub({ menu: { linked: false, allowed: [] } });
  const target = chatgptTarget(targetOptions(stub));
  const page = await target.open(stub.state.url);
  const facts = await target.prepare(page, INPUT, providerOf(stub), new AbortController().signal);
  assert.equal(stub.modeClicks, 1, 'the unproven menu is opened by one code-checked click');
  assert.deepEqual(stub.events, ['mode-trigger', 'escape', 'fill']);
  assert.equal(stub.typed, PROMPT);
  assert.equal(target.matchesDraft(facts, INPUT), true);
  assert.equal(stub.sendClicks, 0);
});

test('chatgpt target: a model mismatch never fills and never sends', async () => {
  const stub = chatgptStub({ menu: { radios: ['GPT-5'] } });
  const target = chatgptTarget(targetOptions(stub));
  const page = await target.open(stub.state.url);
  await rejects('mode.budget', () => target.prepare(page, INPUT, providerOf(stub), new AbortController().signal));
  assert.ok(stub.modeClicks >= 1, 'the menu was approached');
  assert.equal(stub.typed, null, 'no text is typed before the mode is proven');
  assert.equal(stub.sendClicks, 0);
  assert.ok(!stub.events.includes('fill'));
});

test('chatgpt target: the code moves the reasoning slider to its maximum with End', async () => {
  const stub = chatgptStub({ menu: { slider: { now: 4, max: 10, effort: 'Medium' } } });
  const target = chatgptTarget(targetOptions(stub));
  const page = await target.open(stub.state.url);
  const facts = await target.prepare(page, INPUT, providerOf(stub), new AbortController().signal);
  assert.ok(stub.keys.includes('End'), 'the slider is moved by a key command, not by a provider click');
  assert.equal(stub.menu.slider?.now, 10);
  assert.equal(stub.menu.slider?.effort, 'Pro');
  assert.equal(stub.modeClicks, 0, 'no decision was needed for the continuous control');
  assert.deepEqual(
    stub.goals.map((goal) => (goal.startsWith('Fill') ? 'fill' : goal.startsWith('Click Send') ? 'send' : 'mode')),
    ['fill', 'send']
  );
  assert.equal(stub.typed, PROMPT);
  assert.equal(target.matchesDraft(facts, INPUT), true);
});

test('chatgpt target: a fill aimed at a non-composer field is refused before it acts', async () => {
  const stub = chatgptStub({ extraFill: true });
  const target = chatgptTarget(targetOptions(stub));
  const page = await target.open(stub.state.url);
  const provider = providerOf(stub, {
    pick: (goal) => (goal.startsWith('Fill') ? { operation: 'TYPE_TEXT', target: 'Search field' } : defaultPick(goal)),
  });
  await rejects('fill.target_not_composer', () => target.prepare(page, INPUT, provider, new AbortController().signal));
  assert.deepEqual(stub.acts, [], 'nothing was typed or clicked');
  assert.equal(stub.typed, null);
  assert.equal(stub.sendClicks, 0);
});

test('chatgpt target: a changed draft at the final gate rejects before the click', async () => {
  const stub = chatgptStub();
  const target = chatgptTarget(targetOptions(stub));
  const page = await target.open(stub.state.url);
  const provider = providerOf(stub, {
    onDecide: (goal) => {
      if (goal.startsWith('Click Send')) stub.state.composer = `${PROMPT} changed`;
    },
  });
  await rejects('gate.changed', () => target.prepare(page, INPUT, provider, new AbortController().signal));
  assert.equal(stub.typed, PROMPT);
  assert.equal(stub.sendClicks, 0, 'the gate is read again before the persisted click');
});

test('chatgpt target: an attachment card with the wrong name is refused before the send', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-chatgpt-attach-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const attachment = join(dir, 'attachment-report.txt');
  writeFileSync(attachment, 'synthetic attachment bytes\n');
  const stub = chatgptStub({ uploadedCards: ['other-file.txt'] });
  const target = chatgptTarget(targetOptions(stub));
  const page = await target.open(stub.state.url);
  const input: JevAskInput = { ...INPUT, attach: attachment };
  // The upload wait ends without the requested card, so the gate fails closed and nothing is sent.
  await rejects('attach.card_wrong', () => target.prepare(page, input, providerOf(stub), new AbortController().signal));
  assert.deepEqual(stub.files, [attachment]);
  assert.equal(stub.typed, PROMPT);
  assert.equal(stub.sendClicks, 0);
});

for (const shape of ['slow', 'slow_collision', 'in_progress', 'missing_card'] as const) {
  const finishes = shape === 'slow' || shape === 'slow_collision';
  test(`${finishes ? 'T13' : 'T14'}: real prepare polls ${shape} upload despite p=0`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-upload-progress-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const attach = join(dir, 'r4f2-file.txt');
    writeFileSync(attach, 'synthetic attachment bytes\n');
    const stub = chatgptStub();
    const options = targetOptions(stub);
    let uploadedAt: number | undefined;
    let polls = 0;
    let judgments = 0;
    const command = stub.browser.command.bind(stub.browser);
    stub.browser.command = async (method, params) => {
      const value = await command(method, params);
      if (method === 'DOM.setFileInputFiles') uploadedAt = options.now();
      return value;
    };
    const evaluate = stub.browser.evaluate.bind(stub.browser);
    stub.browser.evaluate = async (script) => {
      if (script === PAGE_FACTS && uploadedAt !== undefined) {
        polls++;
        const done = finishes && options.now() - uploadedAt >= 5_000;
        return {
          ...pageFacts(stub),
          attachment_cards: done
            ? [shape === 'slow_collision' ? 'r4f2-file(1).txt' : 'r4f2-file.txt']
            : shape === 'missing_card'
              ? []
              : null,
          send_button: shape === 'missing_card' || done,
        };
      }
      return evaluate(script);
    };
    const provider = providerOf(stub, { judge: { upload_finished: 0 } });
    const judge = provider.judge!.bind(provider);
    provider.judge = async (...args) => {
      if (args[0].statements.some((s) => s.name === 'upload_finished')) judgments++;
      return judge(...args);
    };
    const target = chatgptTarget(options);
    const input = { ...INPUT, attach, dryRun: true };
    const store = chatgptStore(dir, KEY);
    const run = () =>
      runOracle({
        stateDir: dir,
        key: KEY,
        jobId: 'jev-upload-progress',
        input,
        target,
        store,
        provider,
        signal: new AbortController().signal,
        fields: {
          prompt_sha256: promptSha256(PROMPT),
          attachment: 'r4f2-file.txt',
          attachment_sha256: sha256Hex('synthetic attachment bytes\n'),
        },
        now: options.now,
        sleep: options.sleep,
      });
    if (finishes) {
      const result = await run();
      assert.equal(result.status, 'dry_run_ok');
      assert.ok(options.now() - uploadedAt! >= 5_000);
      assert.ok(options.now() - uploadedAt! < 10_000);
    } else {
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof JevFailure);
        assert.equal(error.code, 'upload_finished_timeout');
        assert.equal(errorBody(error).code, 'upload_finished_timeout', 'must survive public IPC mapping');
        return true;
      });
      assert.ok(options.now() - uploadedAt! >= 120_000);
      assert.ok(options.now() - uploadedAt! <= 150_000, '120s stable budget plus at most 30s load');
      const record = await store.read();
      assert.equal(record?.attempts?.at(-1)?.error?.code, 'upload_finished_timeout');
    }
    assert.ok(polls >= 5, 'the incomplete card was polled, not denied');
    assert.equal(judgments, 2, 'the real awaitState judgment budget is exercised with p=0');
    const record = await store.read();
    assert.notEqual(record?.send_attempted, true);
    assert.equal(stub.sendClicks, 0);
    assert.equal(stub.closed, 1, 'the dry-run/failure tab is closed');
  });
}

test(
  'T15: live-shaped ChatGPT cards run through real DOM facts and strict cardsMatch',
  { timeout: 20_000 },
  async (t) => {
    const chrome = await hiddenChrome(t);
    if (!chrome) return;
    const browser = await Browser.open('about:blank', { cdpUrl: chrome.url, timeoutMs: 2_000 });
    try {
      // Sanitized structure from r4f2-dry-1: the named button and removal are
      // siblings in nested composer-attachment spans (not a sent resource-card).
      await browser.evaluate(
        `document.body.innerHTML = ${JSON.stringify(`<form>
    <div id="prompt-textarea" contenteditable="true" role="textbox">synthetic prompt</div>
    <span class="group/composer-attachment relative block h-30.5 w-40 shrink-0 select-none">
      <span class="composer-attachment-surface flex size-full flex-col overflow-hidden rounded-2xl bg-surface-secondary text-default">
        <button type="button" aria-label="r4f2-file.txt">r4f2-file.txt</button>
        <div>synthetic document type</div>
      </span><button type="button" aria-label="移除 r4f2-file.txt"></button>
    </span><button data-testid="send-button" type="submit" aria-label="发送"></button>
  </form>`)}`
      );
      let raw = (await browser.evaluate(PAGE_FACTS)) as RawPageFacts;
      assert.deepEqual(raw.attachment_cards, ['r4f2-file.txt']);
      assert.equal(raw.send_button, true);
      assert.equal(await chips(browser), '', 'the requested attachment is not an extra tool');
      await browser.evaluate(
        `document.querySelector('form').insertAdjacentHTML('beforeend', '<span data-synthetic-tool>synthetic extra tool</span>')`
      );
      assert.equal(await chips(browser), 'synthetic extra tool', 'unrelated tool text remains visible to the gate');
      await browser.evaluate(`document.querySelector('[data-synthetic-tool]').remove()`);
      assert.equal(cardsMatch(raw.attachment_cards, '/synthetic/r4f2-file.txt'), true);
      assert.equal(cardsMatch(raw.attachment_cards, '/synthetic/different.txt'), false);
      // Live dry-run 3 exposed ChatGPT's no-space collision name; the owner
      // driver accepts only a positive, non-zero-prefixed integer suffix.
      await browser.evaluate(`(() => {
      document.querySelector('button[aria-label="r4f2-file.txt"]').setAttribute('aria-label', 'r4f2-file(1).txt');
      document.querySelector('button[aria-label="移除 r4f2-file.txt"]').setAttribute('aria-label', '移除 r4f2-file(1).txt');
    })()`);
      raw = (await browser.evaluate(PAGE_FACTS)) as RawPageFacts;
      assert.deepEqual(raw.attachment_cards, ['r4f2-file(1).txt']);
      assert.equal(cardsMatch(raw.attachment_cards, '/synthetic/r4f2-file.txt'), true);
      for (const wrong of ['different(1).txt', 'r4f2-file(0).txt', 'r4f2-file(01).txt', 'r4f2-file (1).txt'])
        assert.equal(cardsMatch([wrong], '/synthetic/r4f2-file.txt'), false);
      await browser.evaluate(`document.querySelector('button[aria-label="r4f2-file(1).txt"]').remove()`);
      raw = (await browser.evaluate(PAGE_FACTS)) as RawPageFacts;
      assert.equal(raw.attachment_cards, null, 'in-progress removal without name is not ready');
      assert.equal(cardsMatch(raw.attachment_cards, '/synthetic/r4f2-file.txt'), false);
      assert.equal(cardsMatch([], '/synthetic/r4f2-file.txt'), false);
      assert.equal(cardsMatch(['r4f2-file.txt', 'different.txt'], '/synthetic/r4f2-file.txt'), false);
    } finally {
      await browser.close();
    }
  }
);

for (const cards of [['leftover.txt'], null]) {
  test(`T16: prepare refuses ${cards ? 'leftover' : 'ambiguous'} draft cards before fill or Send`, async () => {
    const stub = chatgptStub({ state: { cards, composer: 'synthetic restored draft' } });
    const target = chatgptTarget(targetOptions(stub));
    const page = await target.open(ROOT);
    await rejects('cards_present', () => target.prepare(page, INPUT, providerOf(stub), new AbortController().signal));
    assert.equal(stub.sendClicks, 0);
    assert.deepEqual(stub.fillTexts, []);
    assert.deepEqual(stub.files, []);
    assert.equal(stub.state.composer, 'synthetic restored draft');
    assert.equal(errorBody(new JevFailure('cards_present', 'cards_present')).code, 'cards_present');
  });
}

test('decision diagnostics: default runtime adapter logs refusal attempts and public code over its socket', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jev-decision-log-'));
  const stateDir = join(home, 'state');
  mkdirSync(stateDir);
  writeFileSync(join(home, 'jev.env'), 'TYPESAFE_API_KEY=synthetic-key\n', { mode: 0o600 });
  const stub = chatgptStub();
  const provider = providerOf(stub);
  const decide = provider.decide.bind(provider);
  provider.decide = async (...args) =>
    args[0].goal.startsWith('Click Send')
      ? { answers: [{ name: 'operation', kind: 'refusal' }], usage: {}, latencyMs: 0, raw: null }
      : decide(...args);
  const ticks = clock();
  const runtime = new JevRuntime({
    hudHome: home,
    stateDir,
    graceMs: 60_000,
    providerFactory: () => provider,
    browserFactory: async () => stub.browser,
    oracleNow: ticks.now,
    oracleSleep: ticks.sleep,
  });
  t.after(async () => {
    await runtime.stop();
    rmSync(home, { recursive: true, force: true });
  });
  await runtime.start();
  const socket = join(home, 'jev-runtime', 'runtime.sock');
  const created = (await jevCall(socket, 'createJob', {
    requestKey: 'decision-log',
    session: { namespace: 'synthetic', sessionId: 'decision-log' },
    input: { ...INPUT, dryRun: true },
  })) as JevJob;
  let job = created;
  for (let i = 0; i < 400 && (job.state === 'queued' || job.state === 'running'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    job = (await jevCall(socket, 'readJob', { jobId: created.id })) as JevJob;
  }
  assert.equal(job.state, 'failed');
  assert.equal(job.error?.code, 'decision_refused');
  const log = readFileSync(join(home, 'jev-runtime', 'child.err'), 'utf8');
  const decisions = log
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.code === 'decision')
    .map((entry) => entry.decision as ActionDecisionDiagnostic);
  assert.deepEqual(
    decisions.filter((d) => d.phase === 'send').map((d) => [d.attempt, d.code]),
    [
      [1, 'operation_refusal'],
      [2, 'operation_refusal'],
      [3, 'operation_refusal'],
    ]
  );
  assert.equal(log.includes(PROMPT), false);
  assert.ok(log.includes('DecisionRefused'));
  assert.equal(stub.sendClicks, 0);
});

for (const refusal of ['operation', 'target'] as const) {
  test(`decision diagnostics: ${refusal} refusal identifies the phase and all attempts, without page text`, async () => {
    const stub = chatgptStub();
    const traces: ActionDecisionDiagnostic[] = [];
    const target = chatgptTarget({ ...targetOptions(stub), decisionDiagnostic: (d) => traces.push(d) });
    const provider = providerOf(stub);
    const decide = provider.decide.bind(provider);
    provider.decide = async (...args) => {
      const result = await decide(...args);
      if (args[0].goal.startsWith('Click Send'))
        result.answers = result.answers.map((answer) =>
          answer.name === (refusal === 'operation' ? 'operation' : 'click_target')
            ? { name: answer.name, kind: 'refusal' }
            : answer
        );
      return result;
    };
    const page = await target.open(ROOT);
    await assert.rejects(
      () => target.prepare(page, INPUT, provider, new AbortController().signal),
      (e: unknown) => errorBody(e).code === 'decision_refused'
    );
    assert.deepEqual(
      traces.filter((d) => d.phase === 'send').map((d) => [d.attempt, d.operation, d.code]),
      [1, 2, 3].map((n) => [n, refusal === 'operation' ? 'unclassified' : 'CLICK', `${refusal}_refusal`])
    );
    assert.ok(
      traces.some(
        (d) => d.phase === 'fill' && d.operation === 'TYPE_TEXT' && d.targetNode === 1 && d.targetRole === 'textbox'
      )
    );
    assert.equal(JSON.stringify(traces).includes(PROMPT), false);
    assert.equal(stub.sendClicks, 0);
  });
}

test('decision diagnostic vocabulary rejects page-like operation, target and role strings', () => {
  const secret = 'PRIVATE_PAGE_TEXT';
  const page: PageState = {
    url: ROOT,
    text: secret,
    actions: [{ id: secret, label: secret, role: secret, kind: 'click', node: 7 }],
  };
  const decision = { choice: secret, operation: secret } as never;
  const diagnostic = actionDecisionDiagnostic(
    'send',
    1,
    page,
    [{ name: 'operation', kind: 'choice', choice: secret, confidence: 1, probabilities: {} }],
    decision
  );
  assert.deepEqual(diagnostic, {
    phase: 'send',
    attempt: 1,
    operation: 'unclassified',
    code: 'selected',
    targetNode: 7,
  });
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  const none = actionDecisionDiagnostic(
    'send',
    2,
    page,
    [
      { name: 'operation', kind: 'choice', choice: 'CLICK', confidence: 1, probabilities: {} },
      { name: 'click_target', kind: 'choice', choice: 'NONE', confidence: 1, probabilities: {} },
    ],
    { refused: true, question: 'click_target', operation: 'CLICK' }
  );
  assert.equal(none.code, 'no_target');
});

test('composer_clean keeps its deny band for an unrelated tool chip', async () => {
  const stub = chatgptStub();
  const evaluate = stub.browser.evaluate.bind(stub.browser);
  let chipReads = 0;
  stub.browser.evaluate = async (script) => {
    if (script.includes('cloneNode')) return chipReads++ === 0 ? '' : 'synthetic extra tool';
    return evaluate(script);
  };
  const target = chatgptTarget(targetOptions(stub));
  const page = await target.open(ROOT);
  await rejects('composer_clean_denied', () =>
    target.prepare(page, INPUT, providerOf(stub, { judge: { composer_clean: 0 } }), new AbortController().signal)
  );
  assert.equal(stub.sendClicks, 0);
  assert.equal(
    stub.goals.some((goal) => goal.startsWith('Click Send')),
    false
  );
});

for (const extraArrives of ['upload', 'final_gate'] as const) {
  test(`T16: requested plus leftover attachment at ${extraArrives} fails before Send`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-extra-card-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const attach = join(dir, 'r4f2-file.txt');
    writeFileSync(attach, 'synthetic bytes');
    const stub = chatgptStub({
      uploadedCards: extraArrives === 'upload' ? ['r4f2-file.txt', 'leftover.txt'] : ['r4f2-file.txt'],
    });
    const target = chatgptTarget(targetOptions(stub));
    const provider = providerOf(stub, {
      onDecide: (goal) => {
        if (extraArrives === 'final_gate' && goal.startsWith('Click Send'))
          stub.state.cards = ['r4f2-file.txt', 'leftover.txt'];
      },
    });
    const page = await target.open(ROOT);
    await rejects(extraArrives === 'upload' ? 'attach.card_wrong' : 'gate.changed', () =>
      target.prepare(page, { ...INPUT, attach }, provider, new AbortController().signal)
    );
    assert.equal(stub.sendClicks, 0);
  });
}

test('chatgpt target: an attachment changed during model selection is refused before upload', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-chatgpt-attach-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const attachment = join(dir, 'attachment-report.txt');
  writeFileSync(attachment, 'synthetic initial bytes\n');
  const committed: OperationRecord = { attachment_sha256: sha256Hex('synthetic initial bytes\n') };
  // An unlinked menu makes the model step decide and act before the upload.
  const stub = chatgptStub({ menu: { linked: false, allowed: [] } });
  const target = chatgptTarget(targetOptions(stub));
  const page = await target.open(stub.state.url);
  const provider = providerOf(stub, {
    onDecide: (goal) => {
      if (goal.startsWith('Open the composer model menu')) writeFileSync(attachment, 'synthetic changed bytes\n');
    },
  });
  const input: JevAskInput = { ...INPUT, attach: attachment };
  await rejects('attach.changed', () => target.prepare(page, input, provider, new AbortController().signal, committed));
  assert.deepEqual(stub.files, [], 'the changed bytes were never uploaded');
  assert.equal(stub.typed, PROMPT, 'the prompt fill happened before the attachment check');
  assert.equal(stub.sendClicks, 0, 'no Send happened');
});

test('chatgpt target: a new record carries the actual mode and every owner CLI wait field', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'jev-chatgpt-state-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const stub = chatgptStub({ mode: 'headed' });
  const ticks = clock();
  const target = chatgptTarget({ ...targetOptions(stub), now: ticks.now, sleep: ticks.sleep });
  // The stub submits the committed prompt on its one Send click.
  const act = stub.browser.act.bind(stub.browser);
  stub.browser.act = async (action, page, text) => {
    await act(action, page, text);
    if (action.id === 'send') {
      stub.state.url = CONVERSATION;
      stub.state.composer = null;
      stub.state.turns = [
        { role: 'user', text: PROMPT },
        { role: 'assistant', text: ANSWER, final_controls: true },
      ];
      stub.state.sidebar = [CONVERSATION];
    }
  };
  const fields: OperationRecord = {
    key: KEY,
    provider: 'chatgpt',
    prompt_sha256: promptSha256(PROMPT),
    squashed_sha256: squashedSha256(PROMPT),
    conversation: 'new',
  };
  const result = await runOracle({
    stateDir: state,
    key: KEY,
    jobId: 'job-1',
    input: INPUT,
    target,
    store: chatgptStore(state, KEY),
    provider: providerOf(stub),
    signal: new AbortController().signal,
    fields,
    now: ticks.now,
    sleep: ticks.sleep,
  });
  assert.equal(result.status, 'answered');
  assert.equal(result.answer, ANSWER);
  const record = readOperation(state, KEY)!;
  assert.equal(record.mode, 'headed', 'the persisted mode is the browser mode, not the requested one');
  const view = ownerWaitView(record);
  assert.equal(view.mode, 'headed');
  assert.equal(ownerWaitView(record, 'headed').mode, 'headed');
  assert.equal(view.prompt_sha256, promptSha256(PROMPT));
  assert.equal(view.squashed_sha256, squashedSha256(PROMPT));
  assert.equal(view.conversation_url, CONVERSATION);
  assert.equal(view.send_attempted, true);
  assert.equal(view.sent_target_id, 'target-1');
  assert.deepEqual(view.before, { url: ROOT, turns: [], sidebar: [], composer_sha256: sha256Hex(PROMPT) });
  assert.deepEqual(view.sidebar_before, []);
});

// ---------------------------------------------------------------- binding

function turnFacts(turns: OracleTurn[]): OracleFacts {
  return {
    url: CONVERSATION,
    readyState: 'complete',
    marker: 'synthetic',
    composer: null,
    stop: false,
    sidebar: [],
    turns,
    cards: [],
  };
}

function finished(turns: OracleTurn[], input: JevAskInput = INPUT, record = {}) {
  return bindChatgpt(turnFacts(turns), input, record);
}

test('bindChatgpt: the exact committed text, its inline-code candidate and the recorded hash', () => {
  assert.deepEqual(
    finished([
      { role: 'user', text: PROMPT },
      { role: 'assistant', text: ANSWER, final_controls: true },
    ]),
    { found: true, answer: ANSWER, final: true }
  );
  // The rendered text drops the backticks; the conservative Markdown candidate restores them.
  const prompt = 'run `npm test` now';
  const inline = finished(
    [
      { role: 'user', text: 'run npm test now', message_body_code_markdown: prompt },
      { role: 'assistant', text: ANSWER, final_controls: true },
    ],
    { ...INPUT, prompt }
  );
  assert.deepEqual(inline, { found: true, answer: ANSWER, final: true });
  // Without the candidate the rendered text is not the committed prompt.
  assert.equal(
    finished(
      [
        { role: 'user', text: 'run npm test now' },
        { role: 'assistant', text: ANSWER, final_controls: true },
      ],
      { ...INPUT, prompt }
    ).found,
    false
  );
  // A recorded squashed hash wins over the current prompt.
  assert.deepEqual(
    finished(
      [
        { role: 'user', text: 'recorded prompt' },
        { role: 'assistant', text: ANSWER, final_controls: true },
      ],
      INPUT,
      { squashed_sha256: squashedSha256('recorded prompt') }
    ),
    { found: true, answer: ANSWER, final: true }
  );
  // The message body is enough when the turn text carries more chrome.
  assert.equal(
    finished([
      { role: 'user', text: `You said: ${PROMPT}`, message_body: PROMPT },
      { role: 'assistant', text: ANSWER, final_controls: true },
    ]).found,
    true
  );
});

test('bindChatgpt: two turns with the same prompt are ambiguous and never bind', () => {
  assert.deepEqual(
    finished([
      { role: 'user', text: PROMPT },
      { role: 'assistant', text: ANSWER, final_controls: true },
      { role: 'user', text: PROMPT },
    ]),
    { found: false, answer: '', final: false }
  );
});

test('bindChatgpt: an attachment needs the recorded display name on the turn', () => {
  const input: JevAskInput = { ...INPUT, attach: '/synthetic/attachment-report.txt' };
  const turns: OracleTurn[] = [
    { role: 'user', text: PROMPT, attachment_names: ['attachment-report.txt'] },
    { role: 'assistant', text: ANSWER, final_controls: true },
  ];
  assert.deepEqual(finished(turns, input), { found: true, answer: ANSWER, final: true });
  // A recorded display name must match exactly.
  assert.equal(finished(turns, input, { attachment_display_name: 'other.txt' }).found, false);
  // The record's attachment path is the fallback name.
  assert.equal(finished(turns, input, { attachment: 'attachment-report.txt' }).found, true);
  // A turn without the card, or with a different one, does not bind.
  assert.equal(
    finished(
      [
        { role: 'user', text: PROMPT },
        { role: 'assistant', text: ANSWER, final_controls: true },
      ],
      input
    ).found,
    false
  );
  assert.equal(
    finished(
      [
        { role: 'user', text: PROMPT, attachment_names: ['other-file.txt'] },
        { role: 'assistant', text: ANSWER, final_controls: true },
      ],
      input
    ).found,
    false
  );
});

test('bindChatgpt: the answer stops at the next user turn and needs final controls', () => {
  assert.deepEqual(
    finished([
      { role: 'user', text: PROMPT },
      { role: 'assistant', text: ANSWER, final_controls: true },
      { role: 'user', text: 'synthetic follow-up' },
      { role: 'assistant', text: 'synthetic second answer', final_controls: true },
    ]),
    { found: true, answer: ANSWER, final: true }
  );
  // An assistant turn without the completed-response controls is a partial answer.
  assert.deepEqual(
    finished([
      { role: 'user', text: PROMPT },
      { role: 'assistant', text: ANSWER },
    ]),
    { found: true, answer: ANSWER, final: false }
  );
  // A code block is not finality: the footer is.
  const code = '```\nsynthetic code\n```';
  assert.deepEqual(
    finished([
      { role: 'user', text: PROMPT },
      { role: 'assistant', text: code },
    ]),
    { found: true, answer: code, final: false }
  );
  assert.deepEqual(
    finished([
      { role: 'user', text: PROMPT },
      { role: 'assistant', text: code, final_controls: true },
    ]),
    { found: true, answer: code, final: true }
  );
  // An empty assistant turn never becomes the answer.
  assert.deepEqual(
    finished([
      { role: 'user', text: PROMPT },
      { role: 'assistant', text: '' },
      { role: 'assistant', text: ANSWER, final_controls: true },
    ]),
    { found: true, answer: ANSWER, final: true }
  );
});

// ---------------------------------------------------------------- PAGE_FACTS in a tiny DOM

type DomText = { nodeType: 3; textContent: string };
interface DomNode {
  nodeType: 1;
  tagName: string;
  attrs: Record<string, string>;
  childNodes: Array<DomNode | DomText>;
  parentElement: DomNode | null;
  readonly textContent: string;
  readonly innerText: string;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): DomNode[];
  closest(selector: string): DomNode | null;
}

function textNode(value: string): DomText {
  return { nodeType: 3, textContent: value };
}

function element(tag: string, attrs: Record<string, string> = {}, children: Array<DomNode | DomText> = []): DomNode {
  const node: DomNode = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attrs,
    childNodes: [],
    parentElement: null,
    get textContent(): string {
      return node.childNodes.map((child) => child.textContent).join('');
    },
    get innerText(): string {
      return node.textContent;
    },
    getAttribute(name: string): string | null {
      return Object.hasOwn(node.attrs, name) ? node.attrs[name]! : null;
    },
    querySelector(selector: string): DomNode | null {
      return node.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector: string): DomNode[] {
      const found: DomNode[] = [];
      const walk = (current: DomNode | DomText): void => {
        if (current.nodeType !== 1) return;
        for (const child of current.childNodes) {
          if (child.nodeType !== 1) continue;
          if (matches(child, selector)) found.push(child);
          walk(child);
        }
      };
      walk(node);
      return found;
    },
    closest(selector: string): DomNode | null {
      let current: DomNode | null = node;
      while (current) {
        if (matches(current, selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
  };
  for (const child of children) {
    if (child.nodeType === 1) child.parentElement = node;
    node.childNodes.push(child);
  }
  return node;
}

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: Array<[string, string | null, string]>;
}

const TOKEN = /#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([*^$~]?=)\s*"?([^"\]]*)"?\s*)?\]|([a-zA-Z][\w-]*)/g;

/** `tag`, `#id`, `.class`, `[attr]`, `[attr=v]`, `[attr^=v]`, `[attr$=v]`, `[attr*=v]`, `[attr~=v]`. */
function compound(text: string): Compound | null {
  const result: Compound = { tag: null, id: null, classes: [], attrs: [] };
  let cursor = 0;
  for (const match of text.matchAll(TOKEN)) {
    if ((match.index ?? -1) !== cursor) return null;
    cursor += match[0].length;
    if (match[1]) result.id = match[1];
    else if (match[2]) result.classes.push(match[2]);
    else if (match[3]) result.attrs.push([match[3], match[5] ?? null, match[4] ?? '']);
    else if (match[6]) result.tag = match[6].toLowerCase();
  }
  return cursor === text.length ? result : null;
}

function matchesCompound(node: DomNode, parsed: Compound): boolean {
  if (parsed.tag && node.tagName.toLowerCase() !== parsed.tag) return false;
  if (parsed.id && node.getAttribute('id') !== parsed.id) return false;
  const classes = (node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  if (!parsed.classes.every((name) => classes.includes(name))) return false;
  return parsed.attrs.every(([name, value, operator]) => {
    const actual = node.getAttribute(name);
    if (actual === null) return false;
    if (value === null) return true;
    if (operator === '*=') return actual.includes(value);
    if (operator === '^=') return actual.startsWith(value);
    if (operator === '$=') return actual.endsWith(value);
    if (operator === '~=') return actual.split(/\s+/).includes(value);
    return actual === value;
  });
}

function chainFrom(node: DomNode | null, parts: string[], index: number): boolean {
  if (!node || node.nodeType !== 1) return false;
  const parsed = compound(parts[index]!);
  if (!parsed || !matchesCompound(node, parsed)) return false;
  if (index === 0) return true;
  let parent = node.parentElement;
  while (parent) {
    if (chainFrom(parent, parts, index - 1)) return true;
    parent = parent.parentElement;
  }
  return false;
}

/** Comma lists and descendant combinators are enough for the page facts selectors. */
function matches(node: DomNode, selector: string): boolean {
  return selector.split(',').some((part) => {
    const trimmed = part.trim();
    if (!trimmed) return false;
    const parts = trimmed.split(/\s+/).filter(Boolean);
    return chainFrom(node, parts, parts.length - 1);
  });
}

/** The page JavaScript's own return shape, before the target's mapping. */
interface RawPageFacts {
  url: string;
  readyState: string;
  composer: string | null;
  send_button: boolean;
  attachment_cards: string[] | null;
  sidebar_hrefs: string[];
  turns: OracleTurn[];
}

function runPageFacts(body: DomNode): RawPageFacts {
  const document = {
    title: 'Synthetic chat',
    readyState: 'complete',
    body,
    querySelector: (selector: string) => body.querySelector(selector),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
  };
  const location = { href: CONVERSATION, protocol: 'https:' };
  return vm.runInNewContext(PAGE_FACTS, { document, location }) as RawPageFacts;
}

/** The same mapping ChatPage.facts applies to the raw page facts. */
function oracleFactsOf(raw: RawPageFacts): OracleFacts {
  return {
    url: raw.url,
    readyState: raw.readyState,
    marker: 'synthetic',
    composer: raw.composer,
    stop: false,
    sidebar: raw.sidebar_hrefs,
    turns: raw.turns,
    cards: raw.attachment_cards,
  };
}

/** The current UI: one search unit per turn, inside a turn container. */
function modernConversation(): DomNode {
  const bubble = element('div', { 'data-user-message-bubble': 'true' }, [
    element('div', { class: 'whitespace-pre-wrap' }, [
      textNode('run '),
      element('code', {}, [textNode('npm test')]),
      textNode(' now'),
    ]),
  ]);
  const unit = element('div', { 'data-chatgpt-search-unit-key': 'conv:1:user' }, [bubble]);
  return element('div', { 'data-content-search-turn-key': 'conv' }, [unit]);
}

/** The legacy UI: one message element per turn, inside an article. */
function legacyConversation(): DomNode {
  return element('article', {}, [
    element('div', { 'data-message-author-role': 'user' }, [
      element('div', { class: 'whitespace-pre-wrap' }, [textNode(PROMPT)]),
    ]),
  ]);
}

test('PAGE_FACTS reads the modern turn and keeps its inline-code candidate', () => {
  const facts = runPageFacts(element('body', {}, [modernConversation()]));
  assert.equal(facts.turns.length, 1);
  const turn = facts.turns[0]!;
  assert.equal(turn.role, 'user');
  assert.equal(turn.message_body, 'run npm test now');
  assert.equal(turn.message_body_code_markdown, 'run `npm test` now');
  assert.equal(facts.composer, null);
  assert.equal(facts.send_button, false);
  assert.equal(facts.attachment_cards, null);
  assert.equal(facts.readyState, 'complete');
  assert.equal(bindChatgpt(oracleFactsOf(facts), { ...INPUT, prompt: 'run `npm test` now' }, {}).found, true);
});

test('PAGE_FACTS reads the legacy turn', () => {
  const facts = runPageFacts(element('body', {}, [legacyConversation()]));
  assert.equal(facts.turns.length, 1);
  assert.equal(facts.turns[0]!.role, 'user');
  assert.equal(facts.turns[0]!.message_body, PROMPT);
  assert.equal(bindChatgpt(oracleFactsOf(facts), INPUT, {}).found, true);
});

test('PAGE_FACTS fails closed when legacy and modern turns are both present', () => {
  const facts = runPageFacts(element('body', {}, [legacyConversation(), modernConversation()]));
  assert.equal(facts.turns.length, 0, 'a mixed page yields no turns at all');
  assert.equal(facts.composer, null);
  assert.equal(facts.send_button, false);
  assert.equal(bindChatgpt(oracleFactsOf(facts), INPUT, {}).found, false);
});
