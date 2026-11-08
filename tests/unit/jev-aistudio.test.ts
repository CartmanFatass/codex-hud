// AI Studio target (M2): the driver's key algorithm, its config, the aggregate state file
// under flock, the reply Markdown reader and the target's read-only gates.
// Synthetic temp-only fixtures: no real config, browser, provider or HOME access.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { JevFailure } from '../../src/jev/ask/error.js';
import { acquireWaitLease, tryAcquireBrowserLock } from '../../src/jev/ask/lease.js';
import { aistudioTarget, STUDIO_PAGE_STATE } from '../../src/jev/runtime/aistudio.js';
import { makeReplyScript, REPLY_JS, SCROLL_JS, SETTINGS_JS } from '../../src/jev/runtime/aistudio-facts.js';
import {
  loadStudioConfig,
  normalizeStudioPrompt,
  studioKey,
  studioStore,
  withStudioLock,
} from '../../src/jev/runtime/aistudio-state.js';
import type { OracleBrowser } from '../../src/jev/runtime/chatgpt.js';
import type { JevAskInput } from '../../src/jev/runtime/types.js';

function workspace(t: { after(fn: () => void): void }, prefix = 'hud-jev-aistudio-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function failure(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof JevFailure && error.code === code;
}

async function rejects(code: string, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, failure(code));
}

// ---------------------------------------------------------------- key vectors

// The owner's driver: `hashlib.sha256("\x1f".join((model, thinking, conversation,
// cdp.normalize_prompt(prompt))).hexdigest()[:10]`, prefixed with `<label>-`.
// The expected values below come from the standalone Python algorithm
// (`text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")`, per-line `rstrip`,
// join, `strip`), not from this port.
const VECTORS: Array<[string, string, string, string, string, string]> = [
  ['synthetic-label', 'synthetic prompt', 'gemini-4-argon', 'High', 'new', 'synthetic-label-b8cfdedca4'],
  ['synthetic-labelx', 'synthetic prompt', 'gemini-4-argon', 'High', 'new', 'synthetic-labelx-b8cfdedca4'],
  ['synthetic-label', 'synthetic promptx', 'gemini-4-argon', 'High', 'new', 'synthetic-label-2f3c3b1aaf'],
  ['synthetic-label', 'synthetic prompt', 'gemini-4-argonx', 'High', 'new', 'synthetic-label-7084c7cb2c'],
  ['synthetic-label', 'synthetic prompt', 'gemini-4-argon', 'Highx', 'new', 'synthetic-label-2b20cfaeea'],
  [
    'synthetic-label',
    'synthetic prompt',
    'gemini-4-argon',
    'High',
    'https://aistudio.example/prompts/abcdefghijklmnopqrst',
    'synthetic-label-879ea304f8',
  ],
  [
    'synthetic-label',
    '\ufeff  alpha\r\n beta \r\n\r\n gamma  ',
    'gemini-4-argon',
    'High',
    'new',
    'synthetic-label-44247c450b',
  ],
  [
    'synthetic-label',
    'first line\n\nsecond line   \n third line',
    'gemini-4-argon',
    'Medium',
    'new',
    'synthetic-label-3b8e9ffde3',
  ],
  ['synthetic-label', 'line one\r\nline two', 'gemini-4-argon', 'Low', 'new', 'synthetic-label-68af6d8f3a'],
];

test('studioKey matches the Python reference vectors', () => {
  for (const [label, prompt, model, thinking, conversation, expected] of VECTORS) {
    assert.equal(studioKey(label, prompt, model, thinking, conversation), expected, `${label}/${model}/${thinking}`);
  }
});

test('studioKey changes with every one of prompt, model, thinking and conversation', () => {
  const base = ['synthetic-label', 'synthetic prompt', 'gemini-4-argon', 'High', 'new'] as const;
  const keys = new Set([
    studioKey(...base),
    studioKey(base[0], 'synthetic prompt ', ...(base.slice(2) as [string, string, string])),
    studioKey(base[0], base[1], 'gemini-4-pro', base[3], base[4]),
    studioKey(base[0], base[1], base[2], 'Low', base[4]),
    studioKey(base[0], base[1], base[2], base[3], 'https://aistudio.example/prompts/abcdefghijklmnopqrst'),
  ]);
  // A trailing space is layout: it does not make a new key.
  assert.equal(keys.size, 4);
  assert.ok(keys.has(studioKey(...base)));
});

test('studioKey refuses a label the ask API would refuse', () => {
  assert.throws(
    () => studioKey('Synthetic Label', 'synthetic prompt', 'gemini-4-argon', 'High', 'new'),
    failure('invalid_label')
  );
});

test('normalizeStudioPrompt matches the Python normalize_prompt', () => {
  const cases: Array<[string, string]> = [
    ['synthetic prompt', 'synthetic prompt'],
    ['\ufeffsynthetic prompt', 'synthetic prompt'],
    ['\ufeff\ufeffsynthetic prompt', 'synthetic prompt'],
    ['line one\r\nline two', 'line one\nline two'],
    ['line one\rline two', 'line one\nline two'],
    ['  prompt with trailing spaces   \n\n  ', 'prompt with trailing spaces'],
    ['first line\n\nsecond line   \n third line', 'first line\n\nsecond line\n third line'],
    ['\ufeff  alpha\r\n beta \r\n\r\n gamma  ', 'alpha\n beta\n\n gamma'],
    ['alpha\u00a0\u2003\nbeta\u3000', 'alpha\nbeta'],
    ['   \n\t\n ', ''],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeStudioPrompt(input), expected, JSON.stringify(input));
});

// ---------------------------------------------------------------- config

const TOML = (lines: string[]): string => lines.join('\n');

test('loadStudioConfig reads the [aistudio] table from tomlText', (t) => {
  const home = workspace(t);
  const stateDir = join(home, 'studio-state');
  mkdirSync(stateDir);
  const config = loadStudioConfig({
    home,
    tomlText: TOML([
      '[aistudio]',
      `state_dir = "${stateDir}"`,
      'models = ["gemini-4-argon", "gemini-4-pro"]',
      'default_model = "gemini-4-pro"',
      'default_thinking = "Medium"',
    ]),
  });
  assert.deepEqual(config, {
    stateDir,
    models: ['gemini-4-argon', 'gemini-4-pro'],
    model: 'gemini-4-pro',
    thinking: 'Medium',
  });
});

test('loadStudioConfig expands ~ and defaults the state dir under the given home', (t) => {
  const home = workspace(t);
  mkdirSync(join(home, 'studio'));
  const tilde = loadStudioConfig({ home, tomlText: TOML(['[aistudio]', 'state_dir = "~/studio"']) });
  assert.equal(tilde.stateDir, join(home, 'studio'));
  assert.deepEqual(tilde.models, ['gemini-4-argon']);
  assert.equal(tilde.model, 'gemini-4-argon');
  assert.equal(tilde.thinking, 'High');
  mkdirSync(join(home, '.local', 'state', 'jev-aistudio'), { recursive: true });
  const fallback = loadStudioConfig({ home, tomlText: TOML(['[aistudio]', 'models = ["gemini-4-argon"]']) });
  assert.equal(fallback.stateDir, join(home, '.local', 'state', 'jev-aistudio'));
});

test('loadStudioConfig refuses a model outside the allowlist and an unknown thinking level', (t) => {
  const home = workspace(t);
  const stateDir = join(home, 'state');
  mkdirSync(stateDir);
  const table = (extra: string[]): string => TOML(['[aistudio]', `state_dir = "${stateDir}"`, ...extra]);
  assert.throws(
    () =>
      loadStudioConfig({ home, tomlText: table(['models = ["gemini-4-argon"]', 'default_model = "gemini-4-pro"']) }),
    failure('aistudio_config')
  );
  assert.throws(
    () => loadStudioConfig({ home, tomlText: table(['default_thinking = "Ultra"']) }),
    failure('aistudio_config')
  );
  assert.throws(() => loadStudioConfig({ home, tomlText: table(['models = []']) }), failure('aistudio_config'));
  // The owner driver uses defaults when the [aistudio] table is absent.
  assert.throws(
    () => loadStudioConfig({ home, tomlText: TOML(['[other]', 'x = 1']) }),
    failure('jev_state_dir_missing')
  );
  assert.throws(() => loadStudioConfig({ home, tomlText: 'not = toml = at all' }), failure('aistudio_config'));
  // The default state dir must exist before a lock can be taken in it.
  assert.throws(() => loadStudioConfig({ home, tomlText: TOML(['[aistudio]']) }), failure('jev_state_dir_missing'));
});

// ---------------------------------------------------------------- lock

test('withStudioLock serializes two writers in the same process', async (t) => {
  const dir = workspace(t);
  const events: string[] = [];
  const writer = (name: string) =>
    withStudioLock(
      dir,
      async () => {
        events.push(`${name}:enter`);
        await new Promise((resolve) => setTimeout(resolve, 120));
        events.push(`${name}:exit`);
      },
      { lockSeconds: 10 }
    );
  await Promise.all([writer('a'), writer('b')]);
  assert.equal(events.length, 4);
  assert.equal(events[0], `${events[0]!.slice(0, 1)}:enter`);
  assert.equal(events[1], `${events[0]!.slice(0, 1)}:exit`);
  assert.equal(events[2], `${events[2]!.slice(0, 1)}:enter`);
  assert.equal(events[3], `${events[2]!.slice(0, 1)}:exit`);
  assert.notEqual(events[0]!.slice(0, 1), events[2]!.slice(0, 1));
});

test('withStudioLock waits out a foreign flock holder and then fails typed with no write', async (t) => {
  const dir = workspace(t);
  const lockPath = join(dir, 'aistudio_chat_state.lock');
  // The parent keeps the open file description, so the lock survives the helper's exit.
  const fd = openSync(lockPath, 'a+', 0o600);
  const holder = spawn('/usr/bin/flock', ['-x', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
  const code = await new Promise<number | null>((resolve) => holder.once('exit', resolve));
  assert.equal(code, 0);
  let ran = false;
  try {
    await rejects('aistudio_lock_failed', () =>
      withStudioLock(
        dir,
        () => {
          ran = true;
          return 'wrote';
        },
        { lockSeconds: 1 }
      )
    );
  } finally {
    closeSync(fd);
  }
  assert.equal(ran, false);
  assert.equal(existsSync(join(dir, 'aistudio_chat_state.json')), false);
  // With the holder gone the same call succeeds.
  assert.equal(await withStudioLock(dir, () => 'wrote', { lockSeconds: 1 }), 'wrote');
});

test('withStudioLock reports a missing flock helper as a typed failure', async (t) => {
  const dir = workspace(t);
  await rejects('aistudio_lock_unavailable', () =>
    withStudioLock(dir, () => 'never', { flockPath: join(dir, 'no-such-flock') })
  );
});

// ---------------------------------------------------------------- store

test('studioStore reserve and update preserve unknown keys and sticky fields', async (t) => {
  const dir = workspace(t);
  const key = studioKey('synthetic-label', 'synthetic prompt', 'gemini-4-argon', 'High', 'new');
  const file = join(dir, 'aistudio_chat_state.json');
  writeFileSync(
    file,
    JSON.stringify(
      { schema: 2, note: 'keep me', keys: { [key]: { key, extra_record_field: 'keep', status: 'running' } } },
      null,
      1
    )
  );
  const lease = tryAcquireBrowserLock({ stateDir: dir, jobId: 'job-1', phase: 'send' });
  t.after(() => lease.release());
  const store = studioStore(dir, key);
  assert.equal((await store.read())?.extra_record_field, 'keep');
  await store.save({ model: 'gemini-4-argon', user_turn: 1 }, lease);
  const clicked = await store.click({ thinking: 'High' }, lease);
  assert.equal(clicked.send_attempted, true);
  assert.equal(clicked.status, 'send_attempted');
  assert.equal(clicked.send_effect, 'uncertain');
  const attemptedAt = clicked.attempted_at;
  assert.equal(typeof attemptedAt, 'string');
  await rejects('already_attempted', () => store.click({}, lease));
  // A later observer save never revives an attempt or clears the reservation.
  const observed = await store.save(
    { attempted_at: '1999-01-01T00:00:00Z', send_attempted: false, status: 'running' },
    lease
  );
  assert.equal(observed.attempted_at, attemptedAt);
  assert.equal(observed.send_attempted, true);
  // `done` is terminal for the AI Studio record.
  await store.save({ status: 'done', completion: 'COMPLETE' }, lease);
  const late = await store.save({ status: 'timeout', completion: 'IN_PROGRESS' }, lease);
  assert.equal(late.status, 'done');
  assert.equal(late.completion, 'COMPLETE');
  const disk = JSON.parse(readFileSync(file, 'utf8')) as {
    schema: number;
    note: string;
    keys: Record<string, Record<string, unknown>>;
  };
  assert.equal(disk.schema, 2);
  assert.equal(disk.note, 'keep me');
  assert.equal(disk.keys[key]?.extra_record_field, 'keep');
  assert.equal(disk.keys[key]?.user_turn, 1);
  assert.equal(disk.keys[key]?.thinking, 'High');
  assert.equal(disk.keys[key]?.attempted_at, attemptedAt);
});

test('studioStore refuses a foreign lease, a corrupt file and a release', async (t) => {
  const dir = workspace(t);
  const other = workspace(t);
  const key = studioKey('synthetic-label', 'synthetic prompt', 'gemini-4-argon', 'High', 'new');
  const lease = tryAcquireBrowserLock({ stateDir: dir, jobId: 'job-1', phase: 'send' });
  t.after(() => lease.release());
  const store = studioStore(dir, key);
  const foreign = tryAcquireBrowserLock({ stateDir: other, jobId: 'job-2', phase: 'send' });
  t.after(() => foreign.release());
  await rejects('lease_required', () => store.save({ model: 'gemini-4-argon' }, foreign));
  const joined = acquireWaitLease(dir, 'some-other-key', { jobId: 'job-3', phase: 'wait' });
  assert.equal(joined.role, 'owner');
  if (joined.role === 'owner') {
    t.after(() => joined.lease.release());
    await rejects('lease_required', () => store.save({ model: 'gemini-4-argon' }, joined.lease));
  }
  await rejects('aistudio_release_forbidden', () => store.release({ released: true }, lease));
  writeFileSync(join(dir, 'aistudio_chat_state.json'), '{ not json');
  await rejects('record_corrupt', () => store.read());
});

// ---------------------------------------------------------------- reply Markdown

type DomText = { nodeType: 3; textContent: string };
interface DomElement {
  nodeType: 1;
  tagName: string;
  attrs: Record<string, string>;
  childNodes: Array<DomElement | DomText>;
  parentElement: DomElement | null;
  readonly textContent: string;
  readonly innerText: string;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): DomElement[];
  closest(selector: string): DomElement | null;
}

function textNode(value: string): DomText {
  return { nodeType: 3, textContent: value };
}

function element(tag: string, attrs: Record<string, string>, children: Array<DomElement | DomText> = []): DomElement {
  const node: DomElement = {
    nodeType: 1,
    tagName: tag.toLowerCase(),
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
    querySelector(selector: string): DomElement | null {
      return node.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector: string): DomElement[] {
      const found: DomElement[] = [];
      const walk = (current: DomElement | DomText): void => {
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
    closest(selector: string): DomElement | null {
      let current: DomElement | null = node;
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

/** A selector list of `tag`, `.class`, `[attr]`, `[attr=value]` and `[attr*=value]` compounds. */
function matches(node: DomElement, selector: string): boolean {
  return selector.split(',').some((part) => {
    const trimmed = part.trim();
    if (!trimmed) return false;
    const tokens = /([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:([*^$]?=)"?([^"\]]*)"?)?\]/g;
    let tag: string | null = null;
    const classes: string[] = [];
    const attrs: Array<[string, string | null, string]> = [];
    for (const match of trimmed.matchAll(tokens)) {
      if (match[1]) tag = match[1].toLowerCase();
      else if (match[2]) classes.push(match[2]);
      else if (match[3]) attrs.push([match[3], match[5] ?? null, match[4] ?? '']);
    }
    if (tag && node.tagName !== tag) return false;
    const classList = (node.attrs.class ?? '').split(/\s+/).filter(Boolean);
    if (!classes.every((name) => classList.includes(name))) return false;
    return attrs.every(([name, value, op]) => {
      const actual = node.getAttribute(name);
      if (actual === null) return false;
      if (value === null) return true;
      if (op === '*=') return actual.includes(value);
      if (op === '^=') return actual.startsWith(value);
      if (op === '$=') return actual.endsWith(value);
      return actual === value;
    });
  });
}

function runReply(
  script: string,
  root: DomElement
): { users: number; model_turns: number; final: boolean; text: string; error: string | null } {
  return vm.runInNewContext(script, {
    document: { querySelectorAll: (selector: string) => root.querySelectorAll(selector) },
  }) as {
    users: number;
    model_turns: number;
    final: boolean;
    text: string;
    error: string | null;
  };
}

/** `ms-chat-turn` carries the role on a descendant, as the page does. */
function turn(role: string, children: Array<DomElement | DomText>): DomElement {
  return element('ms-chat-turn', {}, [element('div', { 'data-turn-role': role }, children)]);
}

function markdownTurn(): DomElement {
  const list = element('ul', {}, [
    element('li', {}, [textNode('outer'), element('ul', {}, [element('li', {}, [textNode('inner')])])]),
  ]);
  const table = element('table', {}, [
    element('tr', {}, [element('th', {}, [textNode('a')]), element('th', {}, [textNode('b')])]),
    element('tr', {}, [element('td', {}, [textNode('1')]), element('td', {}, [textNode('pipe|cell')])]),
  ]);
  return turn('Model', [
    element('ms-thought-chunk', {}, [element('ms-text-chunk', {}, [textNode('hidden thoughts')])]),
    element('ms-text-chunk', {}, [
      element('h2', {}, [textNode('Heading')]),
      element('p', {}, [
        textNode('bold: '),
        element('strong', {}, [textNode('strong text')]),
        textNode(' and '),
        element('em', {}, [textNode('em text')]),
      ]),
      element('p', {}, [element('code', {}, [textNode('inline `code`')])]),
      element('pre', {}, [textNode('const a = 1;\nconsole.log(a);\n')]),
      element('blockquote', {}, [element('p', {}, [textNode('quoted line')])]),
      list,
      table,
    ]),
    element('button', { class: 'response-feedback-button', 'aria-label': 'Good response' }, [textNode('Good')]),
  ]);
}

test('REPLY_JS renders Markdown, skips hidden thoughts and needs the feedback bar', () => {
  const root = element('body', {}, [
    turn('User', [element('ms-text-chunk', {}, [textNode('question')])]),
    markdownTurn(),
  ]);
  const reply = runReply(makeReplyScript(0), root);
  assert.equal(reply.users, 1);
  assert.equal(reply.model_turns, 1);
  assert.equal(reply.final, true);
  assert.equal(reply.error, null);
  assert.ok(!reply.text.includes('hidden thoughts'), 'thought chunks are not rendered');
  assert.ok(reply.text.includes('## Heading'), reply.text);
  assert.ok(reply.text.includes('**strong text**') && reply.text.includes('*em text*'), reply.text);
  assert.ok(reply.text.includes('`` inline `code` ``'), 'an inline code span is fenced past its own backticks');
  assert.ok(reply.text.includes('```\nconst a = 1;\nconsole.log(a);\n```'), reply.text);
  assert.ok(reply.text.includes('> quoted line'), reply.text);
  assert.ok(reply.text.includes('- outer\n   - inner'), reply.text);
  assert.ok(reply.text.includes('| a | b |') && reply.text.includes('| --- | --- |'), reply.text);
  assert.ok(reply.text.includes('| 1 | pipe\\|cell |'), 'a cell pipe is escaped');
  assert.ok(!reply.text.includes('question'), 'the user turn is not part of the reply');
});

test('REPLY_JS calls a reply final only with the feedback bar or a later user turn', () => {
  const withoutButton = element('body', {}, [
    turn('User', [textNode('q')]),
    turn('Model', [element('ms-text-chunk', {}, [textNode('partial')])]),
  ]);
  assert.equal(runReply(makeReplyScript(0), withoutButton).final, false);
  const laterUser = element('body', {}, [
    turn('User', [textNode('q')]),
    turn('Model', [element('ms-text-chunk', {}, [textNode('first')])]),
    turn('User', [textNode('q2')]),
    turn('Model', [element('ms-text-chunk', {}, [textNode('second')])]),
  ]);
  const first = runReply(makeReplyScript(1), laterUser);
  assert.equal(first.users, 2);
  assert.equal(first.final, true);
  assert.equal(first.text, 'first');
  const outOfRange = runReply(makeReplyScript(3), laterUser);
  assert.deepEqual({ ...outOfRange }, { users: 2, model_turns: 0, final: false, text: '', error: null });
});

test('makeReplyScript is the driver wrapper and the page constants stay verbatim', () => {
  assert.equal(makeReplyScript(0), `(${REPLY_JS})(0, -1)`);
  assert.equal(makeReplyScript(2, 1.9), `(${REPLY_JS})(2, 1)`);
  assert.match(SCROLL_JS, /scrollIntoView/);
  assert.match(SETTINGS_JS, /ms-paid-api-key-button/);
  assert.match(STUDIO_PAGE_STATE, /aistudio\.google\.com/);
});

// ---------------------------------------------------------------- target gates

interface StudioStub {
  browser: OracleBrowser;
  state: Record<string, unknown>;
  settings: Record<string, unknown>;
  reply: Record<string, unknown>;
  opened: string[];
  acted: number;
}

function studioStub(
  overrides: {
    state?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    reply?: Record<string, unknown>;
  } = {}
): StudioStub {
  const stub: StudioStub = {
    state: {
      url: 'https://aistudio.google.com/prompts/new_chat?model=gemini-4-argon',
      readyState: 'complete',
      selector: 'textarea[formcontrolname="promptText"]',
      composer: '',
      login: false,
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
    browser: undefined as unknown as OracleBrowser,
  };
  const browser: OracleBrowser = {
    id: 'target-1',
    async evaluate(expression: string): Promise<unknown> {
      if (expression === STUDIO_PAGE_STATE) return { ...stub.state };
      if (expression === SETTINGS_JS) return { ...stub.settings };
      if (expression.startsWith(`(${REPLY_JS})`)) return { ...stub.reply };
      if (expression.startsWith(`(${SCROLL_JS})`)) return true;
      if (expression.includes('__jevFast')) return true;
      return true;
    },
    async command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
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
      return undefined;
    },
    async detach() {
      return undefined;
    },
  };
  stub.browser = browser;
  return stub;
}

function studioOptions(stub: StudioStub, overrides: { model?: string; thinking?: string } = {}) {
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
    sleep: async () => undefined,
  };
}

const INPUT: JevAskInput = {
  tag: 'ask',
  target: 'aistudio',
  label: 'synthetic-label',
  prompt: 'synthetic prompt',
  conversation: 'new',
};

test('aistudioTarget refuses a model outside the config allowlist and reads only settled chats', () => {
  const stub = studioStub();
  assert.throws(
    () => aistudioTarget(studioOptions(stub, { model: 'gemini-9-other' })),
    failure('aistudio_model_not_allowed')
  );
  const target = aistudioTarget(studioOptions(stub));
  assert.equal(target.provider, 'aistudio');
  assert.equal(target.root, 'https://aistudio.google.com/prompts/new_chat?model=gemini-4-argon');
  assert.equal(target.settled('https://aistudio.google.com/prompts/abcdefghijklmnopqrst'), true);
  assert.equal(target.settled('https://aistudio.google.com/prompts/new_chat?model=gemini-4-argon'), false);
  assert.equal(target.settled('https://example.test/prompts/abcdefghijklmnopqrst'), false);
  assert.equal(target.settled(undefined), false);
  assert.deepEqual(stub.opened, [], 'constructing a target opens nothing');
  assert.equal(stub.acted, 0, 'constructing a target clicks nothing');
});

test('aistudioTarget prepare stops at a paid API key, a wrong model or a human gate', async () => {
  const paid = studioStub({ settings: { key_icon: 'key_on' } });
  const page = await aistudioTarget(studioOptions(paid)).open(String(paid.state.url));
  await rejects('aistudio_paid_key_selected', () =>
    aistudioTarget(studioOptions(paid)).prepare(page, INPUT, {} as never, new AbortController().signal)
  );

  const wrongModel = studioStub({ settings: { model: 'gemini-4-pro' } });
  const wrongPage = await aistudioTarget(studioOptions(wrongModel)).open(String(wrongModel.state.url));
  await rejects('aistudio_model_mismatch', () =>
    aistudioTarget(studioOptions(wrongModel)).prepare(wrongPage, INPUT, {} as never, new AbortController().signal)
  );

  const dialog = studioStub({ state: { dialog: true } });
  const dialogPage = await aistudioTarget(studioOptions(dialog)).open(String(dialog.state.url));
  await rejects('needs_human', () =>
    aistudioTarget(studioOptions(dialog)).prepare(dialogPage, INPUT, {} as never, new AbortController().signal)
  );

  const login = studioStub({ state: { login: true } });
  const loginPage = await aistudioTarget(studioOptions(login)).open(String(login.state.url));
  await rejects('needs_human', () =>
    aistudioTarget(studioOptions(login)).prepare(loginPage, INPUT, {} as never, new AbortController().signal)
  );
  assert.equal(paid.acted + wrongModel.acted + dialog.acted + login.acted, 0, 'a refused gate never clicks');
});

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
  target.bindPage?.(page, { user_turn: 1 });
  const bound = target.binding(await page.facts(), INPUT, { user_turn: 1 });
  assert.deepEqual(bound, { found: true, answer: 'synthetic answer', final: true });
  assert.equal(target.binding(facts, INPUT, { user_turn: 2 }).found, false);
});
