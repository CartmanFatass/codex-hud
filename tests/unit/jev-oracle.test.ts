// Owned web-oracle lifecycle (M1): send once, confirm, wait, reconcile and collect.
// Synthetic targets, a fake clock and temporary state dirs. No browser, provider, env or HOME access.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { JevFailure } from '../../src/jev/ask/error.js';
import { operationPath } from '../../src/jev/ask/names.js';
import {
  promptSha256,
  readOperation,
  sha256Hex,
  squashedSha256,
  type OperationRecord,
} from '../../src/jev/ask/records.js';
import type { Answer, DecisionProvider } from '../../src/jev/decide.js';
import type { JudgmentRequest, PageObservation } from '../../src/jev/judge.js';
import { bindChatgpt } from '../../src/jev/runtime/chatgpt.js';
import {
  chatgptStore,
  runOracle,
  type OracleContext,
  type OracleFacts,
  type OraclePage,
  type OracleResult,
  type OracleTarget,
  type OracleTurn,
} from '../../src/jev/runtime/oracle.js';
import type { JevAskInput } from '../../src/jev/runtime/types.js';

const ROOT = 'https://chatgpt.example/';
const CONVERSATION = 'https://chatgpt.example/c/00000000-0000-4000-8000-000000000000';
const PROMPT = 'synthetic prompt one';
const KEY = 'ask-pro:synthetic0001';
const ANSWER = 'synthetic answer';
const FIELDS: OperationRecord = {
  key: KEY,
  provider: 'chatgpt',
  prompt_sha256: promptSha256(PROMPT),
  squashed_sha256: squashedSha256(PROMPT),
  conversation: 'new',
  effort: 'Pro',
};

function settled(url: unknown): url is string {
  return typeof url === 'string' && /^https:\/\/chatgpt\.example\/c\/[0-9a-f]{8}-[0-9a-f-]{27}$/.test(url);
}

interface World {
  url: string;
  composer: string | null;
  stop: boolean;
  human?: string;
  error?: boolean;
  sidebar: string[];
  cards: string[] | null;
  turns: OracleTurn[];
}

function makeWorld(overrides: Partial<World> = {}): World {
  return { url: ROOT, composer: null, stop: false, sidebar: [], cards: [], turns: [], ...overrides };
}

function factsOf(world: World): OracleFacts {
  return {
    url: world.url,
    readyState: 'complete',
    marker: JSON.stringify([world.url, world.composer, world.stop, world.turns.length, world.sidebar.length]),
    composer: world.composer,
    stop: world.stop,
    human: world.human,
    error: world.error,
    sidebar: [...world.sidebar],
    turns: world.turns.map((turn) => ({ ...turn })),
    cards: world.cards,
  };
}

/** The page after the committed message was submitted: new address, user turn, final answer. */
function submit(world: World, prompt: string, answer = ANSWER): void {
  world.url = CONVERSATION;
  world.composer = null;
  world.turns = [
    { role: 'user', text: prompt },
    { role: 'assistant', text: answer, final_controls: true },
  ];
  world.sidebar = [CONVERSATION];
}

class FakePage implements OraclePage {
  closed = 0;
  detached = 0;
  constructor(
    private readonly world: World,
    readonly id: string | null
  ) {}
  async facts(): Promise<OracleFacts> {
    return factsOf(this.world);
  }
  async observation(facts: OracleFacts): Promise<PageObservation> {
    return {
      page: { url: facts.url, title: '', text: '' },
      elements: [],
      facts: { readyState: facts.readyState, marker: facts.marker },
      deltas: {},
    };
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
  async detach(): Promise<void> {
    this.detached += 1;
  }
}

interface Harness {
  target: OracleTarget;
  world: World;
  pages: FakePage[];
  events: string[];
  count(name: string): number;
}

function harness(world: World, hooks: { click?: (page: FakePage) => void | Promise<void> } = {}): Harness {
  const events: string[] = [];
  const pages: FakePage[] = [];
  const open = (id: string | null): FakePage => {
    const page = new FakePage(world, id);
    pages.push(page);
    return page;
  };
  const target: OracleTarget = {
    provider: 'chatgpt',
    root: ROOT,
    settled,
    async open(url) {
      events.push(`open:${url}`);
      return open(settled(url) ? 'conversation-target' : 'root-target');
    },
    async attach(id) {
      events.push(`attach:${id}`);
      return open(id);
    },
    async targets() {
      return [{ targetId: 'send-target', url: world.url }];
    },
    async prepare(_page, input) {
      events.push('prepare');
      world.composer = input.prompt;
      return factsOf(world);
    },
    async click(page) {
      events.push('click');
      if (hooks.click) await hooks.click(page as FakePage);
      else submit(world, PROMPT);
    },
    binding(facts, input, record) {
      return bindChatgpt(facts, input, record);
    },
    matchesDraft(facts, input) {
      return facts.composer === input.prompt;
    },
  };
  return { target, world, pages, events, count: (name) => events.filter((event) => event === name).length };
}

interface JudgeScript {
  submitted?: number;
  loading?: number;
  needs_human?: number;
  humanKind?: string;
}

function judge(script: JudgeScript = {}): DecisionProvider {
  return {
    id: 'typesafe',
    model: 'synthetic',
    async decide() {
      throw new Error('decide_not_used');
    },
    async judge(request: JudgmentRequest) {
      const answers: Answer[] = [
        { name: 'loading', kind: 'predicate', probability: script.loading ?? 0 },
        { name: 'needs_human', kind: 'predicate', probability: script.needs_human ?? 0 },
      ];
      for (const statement of request.statements) {
        if (statement.name === 'submitted') {
          answers.push({ name: 'submitted', kind: 'predicate', probability: script.submitted ?? 0 });
        }
      }
      if (script.humanKind) {
        answers.push({
          name: 'human_kind',
          kind: 'choice',
          choice: script.humanKind,
          probabilities: {},
          confidence: 1,
        });
      }
      return { answers, usage: {}, latencyMs: 0, raw: null };
    },
  };
}

/** Time only moves on sleep, so a wait costs its sleeps and nothing else. */
function clock(start = 1_700_000_000_000): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let time = start;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

function stateDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-oracle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seed(state: string, record: OperationRecord): void {
  mkdirSync(join(state, 'operations'), { recursive: true, mode: 0o700 });
  writeFileSync(
    operationPath(state, KEY),
    JSON.stringify({
      key: KEY,
      provider: 'chatgpt',
      prompt_sha256: promptSha256(PROMPT),
      squashed_sha256: squashedSha256(PROMPT),
      ...record,
    })
  );
}

function run(
  state: string,
  h: Harness,
  provider: DecisionProvider,
  overrides: Partial<OracleContext> = {}
): Promise<OracleResult> {
  const ticks = clock();
  return runOracle({
    stateDir: state,
    key: KEY,
    jobId: 'job-1',
    input: { tag: 'ask', target: 'chatgpt-pro', label: 'note', prompt: PROMPT },
    target: h.target,
    store: chatgptStore(state, KEY),
    provider,
    signal: new AbortController().signal,
    fields: FIELDS,
    now: ticks.now,
    sleep: ticks.sleep,
    ...overrides,
  });
}

test('oracle: one send persisted before the click, then the whole answer', async (t) => {
  const state = stateDir(t);
  const world = makeWorld();
  const persisted: OperationRecord[] = [];
  const h = harness(world, {
    click: () => {
      const record = readOperation(state, KEY);
      if (record) persisted.push(record);
      submit(world, PROMPT);
    },
  });
  const result = await run(state, h, judge({ submitted: 0.95 }));
  assert.equal(result.status, 'answered');
  assert.equal(result.key, KEY);
  assert.equal(result.answer, ANSWER);
  assert.equal(h.count('prepare'), 1);
  assert.equal(h.count('click'), 1);
  const atClick = persisted[0]!;
  assert.equal(atClick.send_attempted, true);
  assert.equal(atClick.send_effect, 'uncertain');
  assert.equal(atClick.sent_target_id, 'root-target');
  assert.deepEqual(atClick.tabs, { sent: 'root-target' });
  assert.deepEqual(atClick.before, {
    url: ROOT,
    turns: [],
    sidebar: [],
    composer_sha256: sha256Hex(PROMPT),
  });
  const record = readOperation(state, KEY)!;
  assert.equal(record.send_effect, 'sent');
  assert.equal(record.conversation_url, CONVERSATION);
  assert.equal(record.completion, 'COMPLETE');
  assert.equal(record.chars, ANSWER.length);
  assert.equal(record.answer_sha256, sha256Hex(ANSWER));
  assert.notEqual(record.answer_sha256, sha256Hex(`${ANSWER}\n`));
  const file = record.answer_file as string;
  assert.equal(result.answer_file, file);
  assert.equal(readFileSync(file, 'utf8'), `${ANSWER}\n`);
});

test('oracle: a thrown click still confirms from the facts and waits', async (t) => {
  const state = stateDir(t);
  const world = makeWorld();
  const h = harness(world, {
    click: () => {
      submit(world, PROMPT);
      throw new Error('synthetic transport failure');
    },
  });
  const result = await run(state, h, judge({ submitted: 0.95 }));
  assert.equal(result.status, 'answered');
  assert.equal(result.answer, ANSWER);
  assert.equal(h.count('click'), 1);
  const record = readOperation(state, KEY)!;
  assert.equal(record.send_attempted, true);
  assert.equal(record.send_effect, 'sent');
  assert.equal(record.completion, 'COMPLETE');
});

test('oracle: an attempted key reconciles the surviving send target and never clicks', async (t) => {
  const state = stateDir(t);
  seed(state, {
    send_attempted: true,
    send_effect: 'uncertain',
    before: { url: ROOT, turns: [], sidebar: [] },
    sidebar_before: [],
    sent_target_id: 'send-target',
  });
  const world = makeWorld();
  submit(world, PROMPT);
  const h = harness(world);
  const result = await run(state, h, judge({ submitted: 0.95 }));
  assert.equal(result.status, 'answered');
  assert.equal(result.answer, ANSWER);
  assert.equal(h.count('prepare'), 0);
  assert.equal(h.count('click'), 0);
  assert.equal(h.count('attach:send-target'), 1);
  assert.equal(readOperation(state, KEY)!.send_effect, 'sent');
});

test('oracle: a confirmed record recovers the conversation; a completed record answers without a page', async (t) => {
  const state = stateDir(t);
  seed(state, {
    send_attempted: true,
    send_effect: 'sent',
    conversation_url: CONVERSATION,
    sent_target_id: 'send-target',
  });
  const world = makeWorld();
  submit(world, PROMPT);
  const h = harness(world);
  const first = await run(state, h, judge({ submitted: 0.95 }));
  assert.equal(first.status, 'answered');
  assert.equal(first.answer, ANSWER);
  assert.equal(h.count('prepare'), 0);
  assert.equal(h.count('click'), 0);
  assert.equal(h.count('attach:send-target'), 0);
  const opened = h.events.filter((event) => event.startsWith('open:'));
  assert.ok(opened.length > 0);
  assert.ok(opened.every((event) => event === `open:${CONVERSATION}`));
  const pages = h.pages.length;
  const second = await run(state, h, judge({ submitted: 0.95 }));
  assert.equal(second.status, 'answered');
  assert.equal(second.answer, ANSWER);
  assert.equal(h.pages.length, pages);
});

test('oracle: two stable draft reads release the key, and a resend needs confirmation', async (t) => {
  const state = stateDir(t);
  seed(state, {
    send_attempted: true,
    send_effect: 'uncertain',
    before: { url: ROOT, turns: [], sidebar: [] },
    sidebar_before: [],
    sent_target_id: 'send-target',
  });
  const world = makeWorld({ composer: PROMPT });
  const h = harness(world);
  const released = await run(state, h, judge({ submitted: 0.05 }));
  assert.equal(released.status, 'not_submitted');
  assert.equal(h.count('click'), 0);
  const record = readOperation(state, KEY)!;
  assert.equal(record.released, true);
  assert.equal(record.send_attempted, false);
  assert.equal(record.send_effect, 'not submitted');
  assert.equal((record.released_judgments as unknown[]).length, 2);
  await assert.rejects(
    run(state, h, judge({ submitted: 0.95 })),
    (error: unknown) => error instanceof JevFailure && error.code === 'resend_needs_confirmation'
  );
  assert.equal(h.count('prepare'), 0);
  const resent = await run(state, h, judge({ submitted: 0.95 }), {
    input: { tag: 'ask', target: 'chatgpt-pro', label: 'note', prompt: PROMPT, confirmResend: true },
  });
  assert.equal(resent.status, 'answered');
  assert.equal(h.count('prepare'), 1);
  assert.equal(h.count('click'), 1);
});

test('oracle: a judgment pass without hard evidence stays uncertain', async (t) => {
  const state = stateDir(t);
  seed(state, {
    send_attempted: true,
    send_effect: 'uncertain',
    before: { url: ROOT, turns: [], sidebar: [] },
    sidebar_before: [],
    sent_target_id: 'send-target',
  });
  const h = harness(makeWorld());
  const result = await run(state, h, judge({ submitted: 0.95 }));
  assert.equal(result.status, 'uncertain');
  assert.equal(h.count('click'), 0);
  const record = readOperation(state, KEY)!;
  assert.equal(record.send_effect, 'uncertain');
  assert.notEqual(record.released, true);
});

test('oracle binding: duplicates, final controls and the next user turn', () => {
  const input: JevAskInput = { tag: 'ask', target: 'chatgpt-pro', label: 'note', prompt: PROMPT };
  const facts = (turns: OracleTurn[]): OracleFacts => ({
    url: CONVERSATION,
    readyState: 'complete',
    marker: 'synthetic',
    composer: null,
    stop: false,
    sidebar: [],
    turns,
    cards: [],
  });
  const duplicate = bindChatgpt(
    facts([
      { role: 'user', text: PROMPT },
      { role: 'assistant', text: ANSWER, final_controls: true },
      { role: 'user', text: PROMPT },
    ]),
    input,
    {}
  );
  assert.equal(duplicate.found, false);
  const unfinished = bindChatgpt(
    facts([
      { role: 'user', text: PROMPT },
      { role: 'assistant', text: ANSWER },
    ]),
    input,
    {}
  );
  assert.deepEqual(unfinished, { found: true, answer: ANSWER, final: false });
  const stopped = bindChatgpt(
    facts([
      { role: 'user', text: PROMPT },
      { role: 'assistant', text: ANSWER, final_controls: true },
      { role: 'user', text: 'synthetic follow-up' },
      { role: 'assistant', text: 'synthetic second answer', final_controls: true },
    ]),
    input,
    {}
  );
  assert.deepEqual(stopped, { found: true, answer: ANSWER, final: true });
});

test('oracle: dryRun never persists an attempt and never clicks', async (t) => {
  const state = stateDir(t);
  const h = harness(makeWorld());
  const result = await run(state, h, judge(), {
    input: { tag: 'ask', target: 'chatgpt-pro', label: 'note', prompt: PROMPT, dryRun: true },
  });
  assert.equal(result.status, 'dry_run_ok');
  assert.equal(h.count('prepare'), 1);
  assert.equal(h.count('click'), 0);
  const record = readOperation(state, KEY)!;
  assert.equal(record.dry_run, 'ok');
  assert.equal(record.send_attempted, undefined);
  assert.equal(record.send_effect, undefined);
  assert.equal(h.pages[0]!.closed, 1);
  assert.equal(h.pages[0]!.detached, 0);
});

test('oracle: an abort after the persisted attempt detaches the send tab', async (t) => {
  const state = stateDir(t);
  const controller = new AbortController();
  const world = makeWorld();
  const h = harness(world, {
    click: () => {
      submit(world, PROMPT);
      controller.abort(new Error('synthetic abort'));
    },
  });
  await assert.rejects(run(state, h, judge({ submitted: 0.95 }), { signal: controller.signal }), /synthetic abort/);
  const record = readOperation(state, KEY)!;
  assert.equal(record.send_attempted, true);
  assert.equal(record.send_effect, 'uncertain');
  assert.equal(h.count('click'), 1);
  assert.equal(h.pages[0]!.detached, 1);
  assert.equal(h.pages[0]!.closed, 0);
});
