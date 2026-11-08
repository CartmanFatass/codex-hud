// ChatGPT Pro target (M1): the linked model menu, the fill/send gate, the single Send click
// and the conversation binding. A stub browser, a stub decision provider and a fake clock.
// No browser, provider, config, state dir or HOME access.

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { JevFailure } from '../../src/jev/ask/error.js';
import { squashedSha256 } from '../../src/jev/ask/records.js';
import type { Answer, DecisionProvider } from '../../src/jev/decide.js';
import type { DecisionRequest, ObservedAction, PageState } from '../../src/jev/model.js';
import { bindChatgpt, chatgptTarget, MENU_STATE, type OracleBrowser } from '../../src/jev/runtime/chatgpt.js';
import { PAGE_FACTS } from '../../src/jev/runtime/chatgpt-facts.js';
import type { OracleFacts, OracleTurn } from '../../src/jev/runtime/oracle.js';
import type { JevAskInput } from '../../src/jev/runtime/types.js';

const ROOT = 'https://chatgpt.example/';
const CONVERSATION = 'https://chatgpt.example/c/00000000-0000-4000-8000-000000000000';
const PROMPT = 'synthetic prompt one';
const ANSWER = 'synthetic answer';
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
      composer: null,
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
  // The composer is empty on a fresh page, so the readiness judgment is the provider's.
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

test('chatgpt target: an attachment card with the wrong name is refused before the send', async () => {
  const stub = chatgptStub({ uploadedCards: ['other-file.txt'] });
  const target = chatgptTarget(targetOptions(stub));
  const page = await target.open(stub.state.url);
  const input: JevAskInput = { ...INPUT, attach: '/synthetic/attachment-report.txt' };
  // The upload wait ends without the requested card, so the gate fails closed and nothing is sent.
  await rejects('upload_finished_timeout', () =>
    target.prepare(page, input, providerOf(stub), new AbortController().signal)
  );
  assert.deepEqual(stub.files, ['/synthetic/attachment-report.txt']);
  assert.equal(stub.typed, PROMPT);
  assert.equal(stub.sendClicks, 0);
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
