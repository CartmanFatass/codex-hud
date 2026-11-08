// AI Studio target (M2): the driver's key algorithm, its config, the aggregate state file
// under flock, the reply Markdown reader and the target's read-only gates.
// Synthetic temp-only fixtures: no real config, browser, provider or HOME access.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { hiddenChrome } from '../fixtures/jev-hidden-chrome.js';
import { Browser } from '../../src/jev/browser.js';
import vm from 'node:vm';

import { JevFailure } from '../../src/jev/ask/error.js';
import { acquireWaitLease, tryAcquireBrowserLock } from '../../src/jev/ask/lease.js';
import { aistudioTarget, STUDIO_PAGE_STATE } from '../../src/jev/runtime/aistudio.js';
import {
  makeReplyScript,
  makeUserPromptScript,
  makeUserPromptScrollScript,
  REPLY_JS,
  SCROLL_JS,
  SETTINGS_JS,
} from '../../src/jev/runtime/aistudio-facts.js';
import { promptSha256 } from '../../src/jev/ask/records.js';
import { runOracle } from '../../src/jev/runtime/oracle.js';
import { JevRuntime } from '../../src/jev/runtime/executor.js';
import type { JevJob } from '../../src/jev/runtime/types.js';
import {
  loadStudioConfig,
  normalizeStudioPrompt,
  studioKey,
  studioStore,
  withStudioLock,
} from '../../src/jev/runtime/aistudio-state.js';
import type { OracleBrowser } from '../../src/jev/runtime/chatgpt.js';
import { jevCall } from '../../src/jev/runtime/ipc.js';
import { createRoleJevExecutor, hudCreate, hudRead } from '../../src/roles/facade.js';
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

/** Time only moves on sleep, and every sleep is recorded. */
function clock(start = 1_700_000_000_000): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sleeps: number[];
} {
  let time = start;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

/** A real timer only to prove a promise settles; the timer is cleared either way. */
async function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test(
  'T9: real hidden Chrome scripts confirm, wait and collect without compositor or renderer waits',
  { timeout: 30_000 },
  async (t) => {
    const isolated = await hiddenChrome(t);
    if (!isolated) return;
    const { cdp, url } = isolated;
    let id: string | undefined;
    let screenshots = 0;
    try {
      id = ((await cdp.call('Target.createTarget', { url: 'about:blank', background: true })) as { targetId: string })
        .targetId;
      const browser = await Browser.attach(id, { cdpUrl: url, timeoutMs: 1_000 });
      // All writes and scrolls are confined to this owned synthetic background tab.
      await browser.evaluate(
        `document.body.innerHTML=${JSON.stringify('<ms-account-switcher><button aria-label="synthetic@example.test">Account</button></ms-account-switcher><textarea formcontrolname="promptText"></textarea><ms-chat-turn><div data-turn-role="User"><ms-text-chunk>synthetic prompt</ms-text-chunk></div></ms-chat-turn><ms-chat-turn><div data-turn-role="Model"><ms-text-chunk>437</ms-text-chunk><button class="response-feedback-button" aria-label="Good response"></button></div></ms-chat-turn>')}`
      );
      assert.equal(await browser.evaluate('document.visibilityState'), 'hidden', 'never bring the owned tab forward');
      const command = browser.command.bind(browser);
      browser.command = (method, params, ms) => {
        if (method === 'Page.captureScreenshot') screenshots++;
        assert.notEqual(method, 'Page.bringToFront');
        return command(method, params, ms);
      };
      let clicks = 0;
      browser.act = async () => {
        clicks++;
        throw new Error('unexpected_send');
      };
      const dir = workspace(t);
      const ticks = clock();
      const target = aistudioTarget({
        config: { stateDir: dir, models: ['gemini-4-argon'], model: 'gemini-4-argon', thinking: 'High' },
        model: 'gemini-4-argon',
        thinking: 'High',
        open: async () => Browser.attach(id!, { cdpUrl: url, timeoutMs: 1_000 }),
        attach: async () => {
          const attached = await Browser.attach(id!, { cdpUrl: url, timeoutMs: 1_000 });
          const command = attached.command.bind(attached);
          attached.command = (method, params, ms) => {
            if (method === 'Page.captureScreenshot') screenshots++;
            assert.notEqual(method, 'Page.bringToFront');
            return command(method, params, ms);
          };
          attached.act = async () => {
            clicks++;
            throw new Error('unexpected_send');
          };
          return attached;
        },
        targets: async () => [{ targetId: id!, url: 'about:blank' }],
        readTimeoutMs: 1_000,
        now: ticks.now,
        sleep: async (ms) => {
          await ticks.sleep(ms);
        },
      });
      await browser.detach();
      const key = studioKey(INPUT.label, INPUT.prompt, 'gemini-4-argon', 'High', 'new');
      writeFileSync(
        join(dir, 'aistudio_chat_state.json'),
        JSON.stringify({
          keys: {
            [key]: {
              send_attempted: true,
              attempted_at: '2026-01-01T00:00:00Z',
              status: 'send_attempted',
              send_effect: 'uncertain',
              unresolved: 'confirm',
              user_turn: 1,
              sent_target_id: id,
              conversation_url: null,
              before: { url: target.root, turns: [], sidebar: [] },
            },
          },
        })
      );
      const phases: string[] = [];
      const result = await within(
        8_000,
        runOracle({
          stateDir: dir,
          key,
          jobId: 'jev-t9',
          input: INPUT,
          target,
          store: studioStore(dir, key),
          provider: {} as never,
          fields: {},
          resumeOnly: true,
          signal: new AbortController().signal,
          now: ticks.now,
          sleep: ticks.sleep,
          readTimeoutMs: 1_000,
          phase: (phase) => {
            phases.push(phase);
          },
        })
      );
      assert.equal(result.status, 'answered', JSON.stringify(result));
      assert.equal(result.answer, '437');
      assert.deepEqual(phases, ['reconcile', 'confirm', 'wait', 'collect']);
      assert.equal(clicks, 0);
      assert.equal(screenshots, 0, 'oracle facts must not use the compositor');
    } finally {
      if (id) await cdp.call('Target.closeTarget', { targetId: id }).catch(() => undefined);
    }
  }
);

for (const heldPhase of ['prepare', 'confirm', 'wait', 'collect', 'cross_check'] as const) {
  test(`T10: never-settling CDP in ${heldPhase} has a finite public result and post-send resume never clicks`, async (t) => {
    const home = workspace(t);
    const dir = join(home, 'state');
    mkdirSync(dir);
    writeFileSync(join(home, 'jev.env'), 'TYPESAFE_API_KEY=synthetic-t10\n', { mode: 0o600 });
    const ticks = clock();
    const stub = studioStub();
    virtualStudioDom(stub);
    let phase = 'execute';
    let blocked = true;
    let crossChecking = false;
    const evaluate = stub.browser.evaluate.bind(stub.browser);
    stub.browser.evaluate = (script, ...args) =>
      blocked && (heldPhase === 'cross_check' ? crossChecking : phase === heldPhase)
        ? new Promise<never>(() => {})
        : evaluate(script, ...args);
    stub.browser.act = async () => {
      stub.acted++;
      stub.state.composer = '';
      stub.state.url = 'https://aistudio.google.com/prompts/abcdefghijklmnopqrst';
      stub.reply = { users: 1, model_turns: 1, final: true, text: '437', error: null };
    };
    const options = studioOptions(stub, ticks);
    const target = aistudioTarget({
      ...options,
      readTimeoutMs: 40,
      open: async (url) => {
        crossChecking = phase === 'collect';
        return options.open(url);
      },
    });
    const runtime = new JevRuntime({
      hudHome: home,
      stateDir: dir,
      fake: true,
      graceMs: 60_000,
      oracleTargets: { aistudio: target },
      oracleReadTimeoutMs: 40,
      oracleNow: ticks.now,
      oracleSleep: ticks.sleep,
      studioConfigLoader: () => ({ ...options.config, stateDir: dir }),
    });
    const lifecycle = runtime.lifecycle.bind(runtime);
    runtime.lifecycle = (event, code, job, metrics) => {
      if (event === 'phase' && code && !code.startsWith('failed.')) phase = code;
      lifecycle(event, code, job, metrics);
    };
    await runtime.start();
    t.after(() => runtime.stop());
    const socket = join(home, 'jev-runtime', 'runtime.sock');
    const handle = {
      createJob: (request: unknown) =>
        jevCall(socket, 'createJob', request as Record<string, unknown>) as Promise<JevJob>,
      readJob: (jobId: string, opts = {}) => jevCall(socket, 'readJob', { jobId, ...opts }) as Promise<JevJob>,
      closeJob: (jobId: string) => jevCall(socket, 'closeJob', { jobId }) as Promise<JevJob>,
      sendFollowUp: (jobId: string, followUp: unknown) =>
        jevCall(socket, 'sendFollowUp', { jobId, followUp }) as Promise<JevJob>,
    };
    writeFileSync(
      join(home, 'routing.toml'),
      `schema=1
 default_preset="test"
 [backends.web]
 executor="jev"
 target="aistudio"
 [backends.cli]
 executor="herdr"
 harness="pi"
 model="synthetic"
 recipe="pi-role"
 [jev_decisions.test]
 provider="typesafe"
 [presets.test]
 description="Synthetic timeout fixture"
 jev_decisions="test"
 [presets.test.roles]
 "oracle.propose"="web"
 "oracle.converge"="cli"
 imp="cli"
 reviewer="cli"
 sonic="cli"
 jev="web"
 `
    );
    const ctx = {
      home,
      root: { namespace: 'synthetic', sessionId: 't10' },
      env: {},
      jev: createRoleJevExecutor(home, handle),
    };
    const launched = await hudCreate(ctx, {
      role: 'oracle',
      phase: 'propose',
      request_key: 'timeout',
      task: INPUT.prompt,
      cwd: home,
    });
    assert.equal(launched.ok, true, JSON.stringify(launched));
    const id = (launched.executor as { job: string }).job;
    const terminal = async () => {
      for (let i = 0; i < 400; i++) {
        const job = await handle.readJob(id);
        if (job.state !== 'queued' && job.state !== 'running') return job;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('job_did_not_settle');
    };
    const done = await within(3_000, terminal());
    assert.notEqual(done.error?.code, 'internal', JSON.stringify(done));
    if (heldPhase === 'prepare') {
      assert.equal(done.state, 'failed');
      assert.equal(done.error?.code, 'browser_timeout');
      const observed = await hudRead(ctx, { job: launched.job });
      assert.equal(observed.status, 'browser_timeout');
      assert.equal((observed.error as { code: string }).code, 'browser_timeout');
      assert.equal(stub.acted, 0);
    } else if (heldPhase === 'cross_check') {
      assert.equal(done.state, 'completed', JSON.stringify(done));
      assert.equal(done.recoverable, false);
      assert.equal((done.result as { answer: string }).answer, '437');
      assert.equal((done.result as { cross_check: string }).cross_check, 'browser_timeout');
      const log = readFileSync(join(home, 'jev-runtime', 'child.err'), 'utf8');
      assert.ok(log.includes('cross_check.browser_timeout'));
      const observed = await hudRead(ctx, { job: launched.job });
      assert.equal(observed.state, 'done', JSON.stringify(observed));
      assert.ok(JSON.stringify(observed).includes('browser_timeout'));
      assert.equal(stub.acted, 1);
    } else {
      assert.equal(done.state, 'completed', JSON.stringify(done));
      assert.equal(done.recoverable, true);
      assert.equal((done.result as { reason: string }).reason, 'browser_timeout');
      assert.equal(done.error, undefined, 'completed outcomes carry a reason, not an error');
      const observed = await hudRead(ctx, { job: launched.job });
      assert.equal(observed.state, 'open');
      assert.ok(JSON.stringify(observed).includes('browser_timeout'), JSON.stringify(observed));
      // hudRead may already have admitted the next read-only resume; let it time
      // out again before releasing the fake transport and explicitly resuming.
      await terminal();
      const clicks = stub.acted;
      blocked = false;
      await handle.readJob(id, { resume: true });
      const resumed = await within(3_000, terminal());
      assert.equal((resumed.result as { answer: string }).answer, '437', JSON.stringify(resumed));
      assert.equal(stub.acted, clicks, 'a timeout resume never clicks or sends again');
      assert.equal(clicks, 1, 'only the original, reserved send');
      const disk = JSON.parse(readFileSync(join(home, 'jev-runtime', 'jobs', `${id}.json`), 'utf8'));
      const key = studioKey(disk.input.label, INPUT.prompt, options.model, options.thinking, 'new');
      const record = await studioStore(dir, key).read();
      assert.equal(record?.send_attempted, true);
      assert.equal(record?.completion, 'COMPLETE');
    }
  });
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
  scrollIntoView?(options?: { block: string }): void;
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
  // Login is affirmative sign-in evidence; an absent account/composer is hydration.
  assert.match(STUDIO_PAGE_STATE, /accounts\.google\.com/);
  assert.match(STUDIO_PAGE_STATE, /authenticated:/);
});

// ---------------------------------------------------------------- target gates

/** CDP-only fake: execute the shipped user/model extraction and scroll scripts
 * against virtualised turn DOM. The role containers survive; off-screen chunks
 * are removed exactly like AI Studio's placeholders. */
function virtualStudioDom(stub: StudioStub) {
  const userChunk = element('ms-text-chunk', {}, [textNode(INPUT.prompt)]);
  const modelChunk = element('ms-text-chunk', {}, [textNode('437')]);
  const feedback = element('button', { class: 'response-feedback-button', 'aria-label': 'Good response' });
  const user = turn('User', []);
  const model = turn('Model', [modelChunk, feedback]);
  const userBody = user.querySelector('[data-turn-role="User"]')!;
  const modelBody = model.querySelector('[data-turn-role="Model"]')!;
  const root = element('body', {}, []);
  let userVisible = false;
  let userRenders = 0;
  let modelRenders = 0;
  const render = (isUser: boolean) => {
    userVisible = isUser;
    userBody.childNodes = isUser ? [userChunk] : [];
    modelBody.childNodes = isUser ? [] : [modelChunk, feedback];
    userChunk.parentElement = userBody;
    modelChunk.parentElement = modelBody;
    feedback.parentElement = modelBody;
  };
  user.scrollIntoView = () => {
    userRenders++;
    render(true);
  };
  model.scrollIntoView = () => {
    modelRenders++;
    render(false);
  };
  const evaluate = stub.browser.evaluate.bind(stub.browser);
  stub.browser.evaluate = async (script) => {
    if (
      script === STUDIO_PAGE_STATE ||
      script === SETTINGS_JS ||
      script.includes('__jevFast') ||
      script.includes('e.focus();e.select();')
    )
      return evaluate(script);
    root.childNodes = Number(stub.reply.users) > 0 ? [user, model] : [];
    return vm.runInNewContext(script, {
      document: { querySelectorAll: (selector: string) => root.querySelectorAll(selector) },
    });
  };
  return { userVisible: () => userVisible, userRenders: () => userRenders, modelRenders: () => modelRenders };
}

test('R1: real Studio facts bind a virtualised user before scrolling to the final model response', async () => {
  const stub = studioStub({ reply: { users: 1 } });
  const dom = virtualStudioDom(stub);
  const target = aistudioTarget(studioOptions(stub));
  const page = await target.attach('target-1');
  target.bindPage?.(page, { user_turn: 1 }, new AbortController().signal);
  const facts = await page.facts();
  assert.ok(dom.userRenders() > 0, 'render the numeric user before extracting its hash');
  assert.ok(dom.modelRenders() > 0, 'then render the model response');
  assert.equal(dom.userVisible(), false, 'the user is an empty placeholder again after model scrolling');
  assert.deepEqual(target.binding(facts, INPUT, { user_turn: 1 }), { found: true, answer: '437', final: true });
});

test('T11: a single facts sample preserves exact prompt proof through same-document URL settlement', async () => {
  const stub = studioStub({ reply: { users: 1 } });
  const dom = virtualStudioDom(stub);
  const evaluate = stub.browser.evaluate.bind(stub.browser);
  const url = 'https://aistudio.google.com/prompts/abcdefghijklmnopqrst';
  stub.state.documentId = 1;
  stub.browser.evaluate = async (script) => {
    if (script === STUDIO_PAGE_STATE && dom.modelRenders() > 0) return { ...stub.state, url };
    return evaluate(script);
  };
  const target = aistudioTarget(studioOptions(stub));
  const page = await target.attach('target-1');
  target.bindPage?.(page, { user_turn: 1 }, new AbortController().signal);
  const facts = await page.facts();
  assert.equal(facts.url, url);
  assert.deepEqual(target.binding(facts, INPUT, { user_turn: 1 }), { found: true, answer: '437', final: true });
});

for (const url of [
  'https://aistudio.google.com/prompts/abcdefghijklmnopqrst',
  'https://other.example/prompts/abcdefghijklmnopqrst',
  'https://aistudio.google.com/prompts/new_chat?model=other',
]) {
  test(`R4F2: changed documents or unrelated URL transitions never preserve prompt proof (${new URL(url).hostname}/${new URL(url).search})`, async () => {
    const stub = studioStub({ reply: { users: 1 } });
    const dom = virtualStudioDom(stub);
    const evaluate = stub.browser.evaluate.bind(stub.browser);
    stub.state.documentId = 1;
    stub.browser.evaluate = async (script) => {
      if (script === STUDIO_PAGE_STATE && dom.modelRenders() > 0)
        return { ...stub.state, url, documentId: url.includes('other') ? 1 : 2 };
      return evaluate(script);
    };
    const target = aistudioTarget(studioOptions(stub));
    const page = await target.attach('target-1');
    target.bindPage?.(page, { user_turn: 1 }, new AbortController().signal);
    assert.equal(target.binding(await page.facts(), INPUT, { user_turn: 1 }).found, false);
  });
}

test('R1: a prompt proof is discarded if the tab navigates during model extraction', async () => {
  const stub = studioStub({ reply: { users: 1 } });
  const dom = virtualStudioDom(stub);
  const evaluate = stub.browser.evaluate.bind(stub.browser);
  stub.browser.evaluate = async (script) => {
    if (script === STUDIO_PAGE_STATE && dom.modelRenders() > 0) return { ...stub.state, documentId: 2 };
    return evaluate(script);
  };
  const target = aistudioTarget(studioOptions(stub));
  const page = await target.attach('target-1');
  target.bindPage?.(page, { user_turn: 1 }, new AbortController().signal);
  const facts = await page.facts();
  assert.equal(target.binding(facts, INPUT, { user_turn: 1 }).found, false);
});

test('T4: Studio numeric prompt binding confirms and collects from the live tab with new_chat throughout', async (t) => {
  const stateDir = workspace(t);
  const ticks = clock();
  const stub = studioStub();
  virtualStudioDom(stub);
  const click = stub.browser.act.bind(stub.browser);
  stub.browser.act = async (action, page, text) => {
    await click(action, page, text);
    stub.state.composer = '';
    stub.reply = { users: 1, model_turns: 1, final: true, text: '437', error: null };
  };
  const target = aistudioTarget(studioOptions(stub, ticks));
  const key = studioKey(INPUT.label, INPUT.prompt, 'gemini-4-argon', 'High', 'new');
  const phases: string[] = [];
  const result = await within(
    5_000,
    runOracle({
      stateDir,
      key,
      jobId: 'jev-t4',
      input: INPUT,
      target,
      store: studioStore(stateDir, key),
      provider: {} as never,
      signal: new AbortController().signal,
      now: ticks.now,
      sleep: ticks.sleep,
      phase: (phase) => {
        phases.push(phase);
      },
      fields: { prompt_sha256: promptSha256(INPUT.prompt), conversation_url: null },
    })
  );
  assert.equal(result.status, 'answered', JSON.stringify(result));
  assert.equal(result.answer, '437');
  assert.deepEqual(phases, ['prepare', 'click', 'confirm', 'wait', 'collect']);
  assert.equal(stub.acted, 1, 'one reserved Run click');
  const record = await studioStore(stateDir, key).read();
  assert.equal(record?.send_effect, 'sent');
  assert.equal(record?.conversation_url, null);
  assert.equal(record?.completion, 'COMPLETE');
  assert.equal(stub.opened.length, 2, 'prepare opens; wait attaches to the same live tab, never a saved view');
  assert.equal(stub.closed, 0, 'unsaved send tab is retained');
});

test('T5: runtime resumes the D3 send_attempted/uncertain/confirm record with zero Run clicks or preparations', async (t) => {
  await resumeStudio(t, 'none');
});
for (const settlement of ['before', 'during'] as const) {
  test(`T11: runtime resumes D3 with URL settlement ${settlement} attach/sample and zero sends`, async (t) => {
    await resumeStudio(t, settlement);
  });
}
async function resumeStudio(t: TestContext, settlement: 'none' | 'before' | 'during') {
  const home = workspace(t);
  const stateDir = join(home, 'state');
  const jobs = join(home, 'jev-runtime', 'jobs');
  mkdirSync(stateDir);
  mkdirSync(jobs, { recursive: true });
  writeFileSync(join(home, 'jev.env'), 'TYPESAFE_API_KEY=synthetic-t5\n', { mode: 0o600 });
  const ticks = clock();
  const stub = studioStub({ reply: { users: 1, model_turns: 1, final: true, text: '437', error: null } });
  const dom = virtualStudioDom(stub);
  const settledUrl = 'https://aistudio.google.com/prompts/abcdefghijklmnopqrst?model=gemini-4-argon';
  stub.state.documentId = 1;
  if (settlement === 'before') stub.state.url = settledUrl;
  if (settlement === 'during') {
    const evaluate = stub.browser.evaluate.bind(stub.browser);
    stub.browser.evaluate = async (script) => {
      if (script === STUDIO_PAGE_STATE && dom.modelRenders() > 0) stub.state.url = settledUrl;
      return evaluate(script);
    };
  }
  const options = studioOptions(stub, ticks);
  const target = aistudioTarget(options);
  const key = studioKey(INPUT.label, INPUT.prompt, options.model, options.thinking, 'new');
  writeFileSync(
    join(stateDir, 'aistudio_chat_state.json'),
    JSON.stringify({
      keys: {
        [key]: {
          key,
          status: 'send_attempted',
          send_effect: 'uncertain',
          unresolved: 'confirm',
          send_attempted: true,
          attempted_at: '2026-01-01T00:00:00Z',
          user_turn: 1,
          conversation_url: null,
          sent_target_id: 'target-1',
          prompt_sha256: promptSha256(INPUT.prompt),
          before: { url: target.root, turns: [], sidebar: [] },
        },
      },
    }),
    { mode: 0o600 }
  );
  writeFileSync(
    join(jobs, 'jev-t5.json'),
    JSON.stringify({
      executor: 'jev',
      id: 'jev-t5',
      requestKey: 't5',
      fingerprint: 'synthetic',
      session: { namespace: 'synthetic', sessionId: 't5' },
      tag: 'ask',
      input: { ...INPUT, model: options.model, thinking: options.thinking },
      askStateDir: stateDir,
      decisionProfile: null,
      provider: { id: 'typesafe', model: 'synthetic' },
      state: 'running',
      closed: false,
      seq: 2,
      result: null,
      createdAt: '2026-01-01T00:00:00Z',
      run: { startedAt: '2026-01-01T00:00:00Z' },
    }),
    { mode: 0o600 }
  );
  const runtime = new JevRuntime({
    hudHome: home,
    stateDir,
    fake: true,
    graceMs: 60_000,
    oracleTargets: { aistudio: target },
    oracleNow: ticks.now,
    oracleSleep: ticks.sleep,
    studioConfigLoader: () => ({ ...options.config, stateDir }),
  });
  await runtime.start();
  t.after(() => runtime.stop());
  assert.equal(
    (await runtime.readJob('jev-t5')).state,
    'interrupted',
    'T8: orphan running job is interrupted on startup'
  );
  await runtime.readJob('jev-t5', { resume: true });
  let job: JevJob = await runtime.readJob('jev-t5');
  for (let poll = 0; poll < 500 && job.state !== 'completed'; poll++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    job = await runtime.readJob('jev-t5');
  }
  assert.equal(job.state, 'completed', JSON.stringify(job));
  assert.equal((job.result as { answer: string }).answer, '437');
  assert.equal(stub.acted, 0, 'resumption never clicks Run');
  assert.ok(!stub.opened.includes(target.root), 'resume never enters prepare/open-new-chat');
  const final = await studioStore(stateDir, key).read();
  assert.equal(final?.completion, 'COMPLETE');
  if (settlement !== 'none') {
    assert.equal(final?.conversation_url, settledUrl);
    assert.equal(final?.conversation_url_source, 'tab');
  }
}

test('Studio numeric binding refuses a different prompt at the expected user turn', async () => {
  const stub = studioStub({ reply: { users: 1, model_turns: 1, final: true, text: '437' } });
  const evaluate = stub.browser.evaluate.bind(stub.browser);
  stub.browser.evaluate = async (script) =>
    script === makeUserPromptScript(1) ? 'a different synthetic prompt' : evaluate(script);
  const target = aistudioTarget(studioOptions(stub));
  const page = await target.attach('target-1');
  target.bindPage?.(page, { user_turn: 1 }, new AbortController().signal);
  const bound = target.binding(await page.facts(), INPUT, { user_turn: 1 });
  assert.deepEqual(bound, { found: false, answer: '', final: false });
});

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
  target.bindPage?.(page, { user_turn: 1 }, new AbortController().signal);
  const bound = target.binding(await page.facts(), INPUT, { user_turn: 1 });
  assert.deepEqual(bound, { found: true, answer: 'synthetic answer', final: true });
  assert.equal(target.binding(facts, INPUT, { user_turn: 2 }).found, false);
});

test('aistudioTarget prepare waits out an unhydrated page instead of calling it a login gate', async () => {
  const url = 'https://aistudio.google.com/prompts/new_chat?model=gemini-4-argon';
  const shell = {
    url,
    readyState: 'complete',
    selector: null,
    composer: null,
    login: false,
    authenticated: false,
    dialog: false,
    stop: false,
    page_error: false,
  };
  const hydrated = { ...shell, selector: 'textarea[formcontrolname="promptText"]', composer: '', authenticated: true };
  const stub = studioStub({ states: [shell, hydrated] });
  const ticks = clock();
  const target = aistudioTarget(studioOptions(stub, { sleep: ticks.sleep, now: ticks.now }));
  const page = await target.open(url);
  const facts = await target.prepare(page, INPUT, {} as never, new AbortController().signal);
  // The absent account/composer was hydration, not affirmative login evidence.
  assert.equal(facts.human, undefined);
  assert.equal(facts.readyState, 'complete');
  assert.equal(facts.composer, 'synthetic prompt');
  assert.equal(stub.acted, 0, 'prepare never sends');
  assert.ok(ticks.sleeps.length >= 2, 'the loading shell was polled, not refused');
  // A streaming answer changes the exchange, not the page marker.
  stub.reply = { users: 1, model_turns: 1, final: false, text: 'streaming one', error: null };
  const first = await page.facts();
  stub.reply.text = 'streaming two';
  const second = await page.facts();
  assert.notEqual(first.exchange?.text, second.exchange?.text);
  assert.equal(first.marker, second.marker);
});

test('aistudioTarget facts stops a long virtualized read when the job signal aborts', async () => {
  for (const mode of ['attach', 'open'] as const) {
    const stub = studioStub({ reply: { users: 1, model_turns: 100, final: false, text: '', error: null } });
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldSleeps = 0;
    const target = aistudioTarget(
      studioOptions(stub, {
        sleep: async (ms) => {
          if (ms === 1500 && heldSleeps++ === 0) {
            entered();
            await gate;
          }
        },
      })
    );
    const controller = new AbortController();
    const page = mode === 'attach' ? await target.attach('target-1') : await target.open(String(stub.state.url));
    target.bindPage?.(page, { user_turn: 1 }, controller.signal);
    const reading = page.facts();
    await held; // the first 1500ms render pause is in flight
    const atHold = { screenshots: stub.screenshots, scrolls: stub.scrolls, replies: stub.replies };
    controller.abort(new Error('synthetic abort'));
    try {
      await within(1_000, assert.rejects(reading, /synthetic abort/));
    } finally {
      release();
      await page.detach();
    }
    assert.equal(stub.detached, 1, `${mode}: the observer was detached`);
    assert.deepEqual(
      { screenshots: stub.screenshots, scrolls: stub.scrolls, replies: stub.replies },
      atHold,
      `${mode}: no read continued after the abort`
    );
    assert.equal(stub.acted, 0);
  }
});
