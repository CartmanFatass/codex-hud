// AI Studio target: the fill, the gates and the single Run click.
// A stub browser and a stub decision provider. No browser, config, state dir or HOME access.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { JevFailure } from '../../src/jev/ask/error.js';
import { aistudioTarget, STUDIO_PAGE_STATE } from '../../src/jev/runtime/aistudio.js';
import {
  makeUserPromptScript,
  makeUserPromptScrollScript,
  REPLY_JS,
  SCROLL_JS,
  SETTINGS_JS,
} from '../../src/jev/runtime/aistudio-facts.js';
import type { OracleBrowser } from '../../src/jev/runtime/chatgpt.js';
import type { JevAskInput } from '../../src/jev/runtime/types.js';

function failure(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof JevFailure && error.code === code;
}

async function rejects(code: string, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, failure(code));
}

interface StudioStub {
  browser: OracleBrowser;
  state: Record<string, unknown>;
  settings: Record<string, unknown>;
  reply: Record<string, unknown>;
  opened: string[];
  acted: number;
  screenshots: number;
  scrolls: number;
  replies: number;
  closed: number;
  detached: number;
}

function studioStub(
  overrides: {
    state?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    reply?: Record<string, unknown>;
    /** Successive page-state reads before the stub settles on `state`. */
    states?: Array<Record<string, unknown>>;
  } = {}
): StudioStub {
  const stub: StudioStub = {
    state: {
      url: 'https://aistudio.google.com/prompts/new_chat?model=gemini-4-argon',
      readyState: 'complete',
      selector: 'textarea[formcontrolname="promptText"]',
      composer: '',
      login: false,
      authenticated: true,
      dialog: false,
      stop: false,
      page_error: false,
      ...overrides.state,
    },
    settings: {
      model: 'gemini-4-argon',
      selects: { 'Thinking Level': 'High' },
      key_icon: 'key_off',
      run_disabled: false,
      ...overrides.settings,
    },
    reply: { users: 0, model_turns: 0, final: false, text: '', error: null, ...overrides.reply },
    opened: [],
    acted: 0,
    screenshots: 0,
    scrolls: 0,
    replies: 0,
    closed: 0,
    detached: 0,
    browser: undefined as unknown as OracleBrowser,
  };
  let stateCursor = 0;
  const browser: OracleBrowser = {
    id: 'target-1',
    async evaluate(expression: string): Promise<unknown> {
      if (expression === STUDIO_PAGE_STATE) {
        const states = overrides.states;
        if (states && stateCursor < states.length) return { ...states[stateCursor++] };
        return { ...stub.state };
      }
      if (expression === SETTINGS_JS) return { ...stub.settings };
      if (expression === makeUserPromptScrollScript(1) || expression === makeUserPromptScrollScript(2)) return true;
      if (expression === makeUserPromptScript(1) || expression === makeUserPromptScript(2))
        return Number(stub.reply.users) > 0 ? INPUT.prompt : null;
      if (expression.startsWith(`(${REPLY_JS})`)) {
        stub.replies += 1;
        return { ...stub.reply };
      }
      if (expression.startsWith(`(${SCROLL_JS})`)) {
        stub.scrolls += 1;
        return true;
      }
      if (expression.includes('__jevFast')) return true;
      return true;
    },
    async command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      if (method === 'Page.captureScreenshot') stub.screenshots += 1;
      if (method === 'Input.insertText' && typeof params.text === 'string') stub.state.composer = params.text;
      return {};
    },
    async observe() {
      return { url: String(stub.state.url), text: '', actions: [{ id: 'run', kind: 'click', label: 'Run', node: 7 }] };
    },
    async fresh() {
      return true;
    },
    async act() {
      stub.acted += 1;
    },
    async close() {
      stub.closed += 1;
    },
    async detach() {
      stub.detached += 1;
    },
  };
  stub.browser = browser;
  return stub;
}

function studioOptions(
  stub: StudioStub,
  overrides: {
    model?: string;
    thinking?: string;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {}
) {
  return {
    config: {
      stateDir: join(tmpdir(), 'synthetic-state'),
      models: ['gemini-4-argon', 'gemini-4-pro'],
      model: 'gemini-4-argon',
      thinking: 'High',
    },
    model: overrides.model ?? 'gemini-4-argon',
    thinking: overrides.thinking ?? 'High',
    open: async (url: string) => {
      stub.opened.push(url);
      return stub.browser;
    },
    attach: async (id: string) => {
      stub.opened.push(id);
      return stub.browser;
    },
    targets: async () => [{ targetId: 'target-1', url: String(stub.state.url) }],
    sleep: overrides.sleep ?? (async () => undefined),
    now: overrides.now,
  };
}

const INPUT: JevAskInput = {
  tag: 'ask',
  target: 'aistudio',
  label: 'synthetic-label',
  prompt: 'synthetic prompt',
  conversation: 'new',
};

test('aistudioTarget prepare fills, gates and binds the single Run click; click acts once', async () => {
  const stub = studioStub({ reply: { users: 1, model_turns: 1, final: true, text: 'synthetic answer', error: null } });
  const options = studioOptions(stub);
  const target = aistudioTarget(options);
  const page = await target.open(String(stub.state.url));
  const facts = await target.prepare(page, INPUT, {} as never, new AbortController().signal);
  assert.equal(stub.state.composer, 'synthetic prompt');
  assert.equal(facts.composer, 'synthetic prompt');
  assert.equal(facts.human, undefined);
  assert.equal(target.matchesDraft(facts, INPUT), true);
  assert.equal(target.matchesDraft(facts, { ...INPUT, prompt: 'other prompt' }), false);
  await target.click(page, new AbortController().signal);
  assert.equal(stub.acted, 1);
  await rejects('send.not_chosen', () => target.click(page, new AbortController().signal));
  target.bindPage?.(page, { user_turn: 1 }, new AbortController().signal);
  const bound = target.binding(await page.facts(), INPUT, { user_turn: 1 });
  assert.deepEqual(bound, { found: true, answer: 'synthetic answer', final: true });
  assert.equal(target.binding(facts, INPUT, { user_turn: 2 }).found, false);
});
