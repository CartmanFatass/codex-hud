// ChatGPT Pro target: the linked model menu, the fill/send gate and the single Send click.
// A stub browser, a stub decision provider and a fake clock.
// No browser, provider, config, state dir or HOME access.

import assert from 'node:assert/strict';
import test from 'node:test';

import { JevFailure } from '../../src/jev/ask/error.js';
import type { Answer, DecisionProvider } from '../../src/jev/decide.js';
import type { DecisionRequest, ObservedAction, PageState } from '../../src/jev/model.js';
import { chatgptTarget, MENU_STATE, type OracleBrowser } from '../../src/jev/runtime/chatgpt.js';
import { PAGE_FACTS } from '../../src/jev/runtime/chatgpt-facts.js';
import type { OracleTurn } from '../../src/jev/runtime/oracle.js';
import type { JevAskInput } from '../../src/jev/runtime/types.js';

const ROOT = 'https://chatgpt.example/';
const PROMPT = 'synthetic prompt one';
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
