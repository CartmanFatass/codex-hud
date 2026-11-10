// Jev runtime: provider selection, grace, the lease, close, and the executor surface.
// Every HUD home and state directory is temporary. Credentials are synthetic.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { operationPath } from '../../src/jev/ask/names.js';
import { promptSha256, pyStrip, squashedSha256 } from '../../src/jev/ask/records.js';
import { Browser, DEFAULT_CDP_TIMEOUT_MS } from '../../src/jev/browser.js';
import {
  connectJevExecutor,
  detectEnvProxySupport,
  readDeadlineMs,
  retryableJevError,
  type EnvProxySupport,
} from '../../src/jev/runtime/client.js';
import { STOP_DEADLINE_MS, stopDeadlineMs } from '../../src/jev/runtime/entry.js';
import { cappedReadWaitMs, JevRuntime, askRecordKey, type AskTarget } from '../../src/jev/runtime/executor.js';
import { fakeProvider } from '../../src/jev/runtime/fake.js';
import { jevCall, serveLine } from '../../src/jev/runtime/ipc.js';
import type { JevCreateRequest, JevJob } from '../../src/jev/runtime/types.js';
import { startFakeCdp } from './jev-cdp-fake.js';

const SENTINEL = 'synthetic-r3-sentinel';
const session = { namespace: 'hud', sessionId: 'sess-1' };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A decision that waits, and rejects when the agent aborts so close and stop can finish. */
function blockingProvider(gate: Promise<void>, entered: () => void) {
  return {
    id: 'typesafe' as const,
    model: 'fake',
    async decide(
      request: Parameters<ReturnType<typeof fakeProvider>['decide']>[0],
      options: Parameters<ReturnType<typeof fakeProvider>['decide']>[1]
    ) {
      entered();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(options.signal?.reason ?? new Error('aborted'));
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        options.signal?.addEventListener('abort', onAbort, { once: true });
        void gate.then(() => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        });
      });
      return fakeProvider().decide(request, options);
    },
  };
}

function home(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-r3-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeEnv(dir: string, body: string): void {
  const file = join(dir, 'credentials.env');
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function bothKeys(dir: string): void {
  writeEnv(dir, `TYPESAFE_API_KEY=${SENTINEL}\nOPENAI_API_KEY=${SENTINEL}-openai\nTYPESAFE_MODEL=from-env\n`);
}

function tempState(hudHome: string): string {
  const stateDir = join(hudHome, 'jev-state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return stateDir;
}

async function started(
  t: TestContext,
  hudHome: string,
  extra: ConstructorParameters<typeof JevRuntime>[0] = { hudHome }
): Promise<JevRuntime> {
  const stateDir = extra.stateDir ?? join(hudHome, 'jev-state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const runtime = new JevRuntime({
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    cdpUrl: 'http://offline.invalid',
    graceMs: 60_000,
    fake: true,
    ...extra,
    hudHome,
    stateDir,
  });
  await runtime.start();
  t.after(() => runtime.stop());
  return runtime;
}

function ask(requestKey: string, prompt = 'hello synthetic', confirmResend = false): JevCreateRequest {
  return {
    requestKey,
    session,
    input: {
      tag: 'ask',
      target: 'chatgpt-pro',
      label: 'note',
      prompt,
      ...(confirmResend ? { confirmResend: true } : {}),
    },
  };
}

function browse(requestKey: string, goal = 'Read the synthetic page.'): JevCreateRequest {
  return {
    requestKey,
    session,
    input: { tag: 'browse', goal, url: 'https://example.invalid/fixture' },
  };
}

async function until(read: () => Promise<JevJob>, state: string): Promise<JevJob> {
  let latest = await read();
  for (let i = 0; i < 50 && latest.state !== state; i += 1) {
    latest = await read();
    if (latest.state === state) break;
    await delay(20);
  }
  return latest;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await delay(20);
  }
  return !alive(pid);
}

test('provider selection records TypeSafe by default and never stores the key', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  let model = '';
  let keyOk = false;
  const runtime = await started(t, hudHome, {
    hudHome,
    providerFactory: (resolved) => {
      if (resolved.id === 'typesafe') {
        model = resolved.model;
        keyOk = resolved.apiKey === SENTINEL;
      }
      return fakeProvider();
    },
  });
  const job = await runtime.createJob({
    ...ask('ask-both'),
    jevDecisions: { id: 'page-judge', model: 'from-profile' },
  });
  assert.equal(job.provider?.id, 'typesafe');
  assert.equal(job.provider?.model, 'from-profile');
  assert.equal(job.decisionProfile, 'page-judge');
  assert.equal(model, 'from-profile');
  assert.equal(keyOk, true);
  const file = join(hudHome, 'jev-runtime', 'jobs', `${job.id}.json`);
  const text = readFileSync(file, 'utf8');
  assert.equal(text.includes(SENTINEL), false);
  assert.equal(statSync(file).mode & 0o077, 0);
  const emptyHome = join(hudHome, 'empty');
  const emptyState = join(hudHome, 'empty-state');
  mkdirSync(emptyHome, { mode: 0o700 });
  mkdirSync(emptyState, { mode: 0o700 });
  const missing = new JevRuntime({
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    cdpUrl: 'http://offline.invalid',
    hudHome: emptyHome,
    stateDir: emptyState,
    graceMs: 60_000,
    fake: true,
  });
  await missing.start();
  t.after(() => missing.stop());
  await assert.rejects(
    missing.createJob(ask('ask-missing')),
    (error: { code?: string; variable?: string; message?: string }) => {
      assert.equal(error.code, 'jev_credentials_missing');
      assert.equal(error.variable, 'TYPESAFE_API_KEY');
      assert.equal(JSON.stringify(error).includes(SENTINEL), false);
      return true;
    }
  );
});

test('an explicit OpenAI profile records gpt-6-luna', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  const runtime = await started(t, hudHome);
  const created = await runtime.createJob({
    ...ask('ask-openai'),
    jevDecisions: { provider: 'openai', model: 'not-this' },
  });
  const job = await until(() => runtime.readJob(created.id), 'completed');
  assert.equal(job.provider?.id, 'openai');
  assert.equal(job.provider?.model, 'gpt-6-luna');
  assert.equal(job.state, 'completed');
  assert.deepEqual(job.result, {
    status: 'target_pending',
    target: 'chatgpt-pro',
    key: askRecordKey('chatgpt-pro', 'note', 'hello synthetic'),
  });
  assert.equal(existsSync(operationPath(runtime.stateDir, (job.result as { key: string }).key)), false);
});

test('a pending target does not consume the send key', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  const stateDir = join(hudHome, 'jev-state');
  const pending = await started(t, hudHome, { hudHome, stateDir });
  await pending.createJob(ask('ask-pending'));
  const key = askRecordKey('chatgpt-pro', 'note', 'hello synthetic');
  assert.equal(existsSync(operationPath(stateDir, key)), false);
  let clicks = 0;
  const sender = new JevRuntime({
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    cdpUrl: 'http://offline.invalid',
    hudHome: join(hudHome, 'sender'),
    stateDir,
    graceMs: 60_000,
    fake: true,
    askTargets: {
      'chatgpt-pro': {
        id: 'chatgpt-pro',
        sends: true,
        async click() {
          clicks += 1;
        },
      },
    },
  });
  mkdirSync(join(hudHome, 'sender'), { mode: 0o700 });
  writeEnv(join(hudHome, 'sender'), `TYPESAFE_API_KEY=${SENTINEL}\n`);
  await sender.start();
  t.after(() => sender.stop());
  const job = await sender.createJob(ask('ask-later'));
  const done = await until(() => sender.readJob(job.id), 'completed');
  assert.equal((done.result as { status: string }).status, 'clicked');
  assert.equal(clicks, 1);
});

test('one click is persisted before it happens and is not repeated', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  let clicks = 0;
  let sawAttempt = false;
  let sawLock = false;
  const target: AskTarget = {
    id: 'chatgpt-pro',
    sends: true,
    async click({ stateDir, key }) {
      clicks += 1;
      const record = JSON.parse(readFileSync(operationPath(stateDir, key), 'utf8')) as { send_attempted?: boolean };
      sawAttempt = record.send_attempted === true;
      sawLock = existsSync(join(stateDir, 'browser.lock'));
    },
  };
  const runtime = await started(t, hudHome, { hudHome, askTargets: { 'chatgpt-pro': target } });
  const first = await runtime.createJob(ask('click-1'));
  const done = await until(() => runtime.readJob(first.id), 'completed');
  assert.equal((done.result as { status: string }).status, 'clicked');
  assert.equal(clicks, 1);
  assert.equal(sawAttempt, true);
  assert.equal(sawLock, true);
  const clicked = JSON.parse(
    readFileSync(operationPath(runtime.stateDir, askRecordKey('chatgpt-pro', 'note', 'hello synthetic')), 'utf8')
  ) as {
    provider?: string;
    prompt_sha256?: string;
    squashed_sha256?: string;
  };
  const stripped = pyStrip('hello synthetic');
  assert.equal(clicked.provider, 'chatgpt');
  assert.equal(clicked.prompt_sha256, promptSha256(stripped));
  assert.equal(clicked.squashed_sha256, squashedSha256(stripped));
  assert.equal(existsSync(join(runtime.stateDir, 'browser.lock')), false);
  const again = await runtime.createJob(ask('click-1'));
  assert.equal(again.id, first.id);
  assert.equal(clicks, 1);
  const second = await runtime.createJob(ask('click-2'));
  const blocked = await until(() => runtime.readJob(second.id), 'completed');
  assert.equal((blocked.result as { status: string }).status, 'already_attempted');
  assert.equal(clicks, 1);
});

test('a thrown click is not retried', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  let clicks = 0;
  const runtime = await started(t, hudHome, {
    hudHome,
    askTargets: {
      'chatgpt-pro': {
        id: 'chatgpt-pro',
        sends: true,
        async click() {
          clicks += 1;
          throw new Error(SENTINEL);
        },
      },
    },
  });
  const first = await runtime.createJob(ask('throw-1'));
  const failed = await until(() => runtime.readJob(first.id), 'failed');
  assert.equal(failed.error?.message, 'internal');
  assert.equal(JSON.stringify(failed).includes(SENTINEL), false);
  assert.equal(clicks, 1);
  const same = await runtime.createJob(ask('throw-1'));
  assert.equal(same.id, first.id);
  const second = await runtime.createJob(ask('throw-2'));
  const blocked = await until(() => runtime.readJob(second.id), 'completed');
  assert.equal((blocked.result as { status: string }).status, 'already_attempted');
  assert.equal(clicks, 1);
});

test('a released key needs confirmResend before another click', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  let clicks = 0;
  const runtime = await started(t, hudHome, {
    hudHome,
    askTargets: {
      'chatgpt-pro': {
        id: 'chatgpt-pro',
        sends: true,
        async click() {
          clicks += 1;
        },
      },
    },
  });
  const key = askRecordKey('chatgpt-pro', 'note', 'hello synthetic');
  mkdirSync(join(runtime.stateDir, 'operations'), { mode: 0o700 });
  writeFileSync(operationPath(runtime.stateDir, key), JSON.stringify({ key, provider: 'chatgpt', released: true }), {
    mode: 0o600,
  });
  const blocked = await runtime.createJob(ask('released-1'));
  const held = await until(() => runtime.readJob(blocked.id), 'completed');
  assert.equal((held.result as { status: string }).status, 'resend_needs_confirmation');
  assert.equal(clicks, 0);
  const confirmed = await runtime.createJob(ask('released-2', 'hello synthetic', true));
  const sent = await until(() => runtime.readJob(confirmed.id), 'completed');
  assert.equal((sent.result as { status: string }).status, 'clicked');
  assert.equal(clicks, 1);
});

test('close is idempotent and preserves a completed result', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  const runtime = await started(t, hudHome);
  const created = await runtime.createJob(ask('close-1'));
  const job = await until(() => runtime.readJob(created.id), 'completed');
  assert.equal(job.state, 'completed');
  const closed = await runtime.closeJob(job.id);
  const again = await runtime.closeJob(job.id);
  assert.equal(closed.state, 'completed');
  assert.equal(closed.closed, true);
  assert.deepEqual(closed.result, job.result);
  assert.equal(closed.seq, job.seq);
  assert.equal(again.seq, job.seq);
  assert.deepEqual(again.result, job.result);
});

test('closing a running job does not replace its result', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const startedDecide = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const runtime = await started(t, hudHome, {
    hudHome,
    providerFactory: () => blockingProvider(gate, entered),
  });
  const job = await runtime.createJob(browse('close-run'));
  await startedDecide;
  const [left, right] = await Promise.all([runtime.closeJob(job.id), runtime.closeJob(job.id)]);
  release();
  assert.equal(left.state, 'closed');
  assert.equal(right.state, 'closed');
  assert.equal(left.result, null);
  assert.equal(left.seq, right.seq);
  const after = await runtime.readJob(job.id);
  assert.equal(after.state, 'closed');
  assert.equal(after.result, null);
  assert.equal(after.closed, true);
});

test('disconnect ends observation and leaves the job running', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const startedDecide = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const runtime = await started(t, hudHome, {
    hudHome,
    providerFactory: () => blockingProvider(gate, entered),
  });
  const job = await runtime.createJob(browse('watch-1'));
  await startedDecide;
  const controller = new AbortController();
  const pending = runtime.readJob(job.id, { waitMs: 5_000, afterSeq: job.seq, signal: controller.signal });
  await delay(30);
  controller.abort();
  const ended = await pending;
  assert.equal(ended.observationEnded, true);
  assert.equal(ended.state, 'running');
  assert.equal(ended.closed, false);
  const ipc = new AbortController();
  const call = jevCall(
    join(hudHome, 'jev-runtime', 'runtime.sock'),
    'readJob',
    { jobId: job.id, waitMs: 5_000, afterSeq: ended.seq },
    ipc.signal
  );
  await delay(30);
  ipc.abort();
  await assert.rejects(call, (error: { code?: string }) => error.code === 'observation_ended');
  const still = await runtime.readJob(job.id);
  assert.equal(still.state, 'running');
  assert.equal(still.closed, false);
  release();
  const finished = await until(() => runtime.readJob(job.id), 'completed');
  assert.equal((finished.result as { status: string }).status, 'done');
});

test('the same request key conflicts on session or input and otherwise returns the job', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  const runtime = await started(t, hudHome);
  const job = await runtime.createJob(ask('same-1'));
  const same = await runtime.createJob(ask('same-1'));
  assert.equal(same.id, job.id);
  await assert.rejects(
    runtime.createJob({ ...ask('same-1'), session: { namespace: 'hud', sessionId: 'other' } }),
    (error: { code?: string }) => error.code === 'association_conflict'
  );
  await assert.rejects(
    runtime.createJob(ask('same-1', 'different synthetic')),
    (error: { code?: string }) => error.code === 'conflict'
  );
  assert.equal(readdirSync(join(hudHome, 'jev-runtime', 'jobs')).length, 1);
  const index = JSON.parse(readFileSync(join(hudHome, 'jev-runtime', 'request-keys.json'), 'utf8')) as {
    keys: Array<{ requestKey: string; id: string }>;
  };
  assert.equal(
    index.keys.some((item) => item.requestKey === 'same-1' && item.id === job.id),
    true
  );
});

test('follow-up is applied once while a browse agent is live', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const startedDecide = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const runtime = await started(t, hudHome, {
    hudHome,
    providerFactory: () => blockingProvider(gate, entered),
  });
  const job = await runtime.createJob(browse('follow-1'));
  await startedDecide;
  const blank = await runtime.sendFollowUp(job.id, { key: 'blank', text: '   ' });
  assert.deepEqual(blank.followUp, { supported: false, code: 'unsupported' });
  let applied: JevJob | undefined;
  for (let i = 0; i < 20; i += 1) {
    const next = await runtime.sendFollowUp(job.id, { key: 'more', text: 'Look at the heading.' });
    if (!next.followUp) {
      applied = next;
      break;
    }
    await delay(10);
  }
  assert.ok(applied);
  const repeat = await runtime.sendFollowUp(job.id, { key: 'more', text: 'A different heading.' });
  assert.equal(repeat.seq, applied?.seq);
  assert.equal(repeat.followUp, undefined);
  release();
  const finished = await until(() => runtime.readJob(job.id), 'completed');
  assert.equal((finished.result as { goal: string }).goal, 'Look at the heading.');
  const late = await runtime.sendFollowUp(job.id, { key: 'later', text: 'Too late.' });
  assert.deepEqual(late.followUp, { supported: false, code: 'unsupported' });
  assert.deepEqual(late.result, finished.result);
});

test('restart marks a leftover job interrupted and does not replay it', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  let clicks = 0;
  let providers = 0;
  const jobs = join(hudHome, 'jev-runtime', 'jobs');
  mkdirSync(jobs, { recursive: true, mode: 0o700 });
  const stored = {
    executor: 'jev',
    id: 'jev-restart-1',
    requestKey: 'restart-1',
    fingerprint: 'abc',
    session,
    tag: 'ask',
    input: { tag: 'ask', target: 'chatgpt-pro', label: 'note', prompt: 'hello synthetic' },
    decisionProfile: null,
    provider: { id: 'typesafe', model: 'jev-latest' },
    state: 'queued',
    closed: false,
    seq: 3,
    result: { status: 'keep-me' },
    createdAt: '2026-11-07T00:00:00.000Z',
    run: null,
  };
  writeFileSync(join(jobs, `${stored.id}.json`), JSON.stringify(stored), { mode: 0o600 });
  const runtime = await started(t, hudHome, {
    hudHome,
    providerFactory: () => {
      providers += 1;
      return fakeProvider();
    },
    askTargets: {
      'chatgpt-pro': {
        id: 'chatgpt-pro',
        sends: true,
        async click() {
          clicks += 1;
        },
      },
    },
  });
  const job = await runtime.readJob(stored.id);
  assert.equal(job.state, 'interrupted');
  assert.equal(job.error?.code, 'interrupted');
  assert.deepEqual(job.result, { status: 'keep-me' });
  assert.equal(clicks, 0);
  assert.equal(providers, 0);
});

test('an in-process runtime leaves after grace once work is released', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  const runtime = new JevRuntime({
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    cdpUrl: 'http://offline.invalid',
    hudHome,
    stateDir: tempState(hudHome),
    graceMs: 200,
    fake: true,
  });
  await runtime.start();
  t.after(() => runtime.stop());
  const socketPath = join(hudHome, 'jev-runtime', 'runtime.sock');
  writeFileSync(join(hudHome, 'jev-runtime', 'hold'), '1');
  const job = await runtime.createJob(browse('held'));
  await delay(500);
  assert.equal((await jevCall(socketPath, 'status', {})) !== null, true);
  assert.equal((await runtime.readJob(job.id)).state, 'running');
  unlinkSync(join(hudHome, 'jev-runtime', 'hold'));
  const finished = await until(() => runtime.readJob(job.id), 'completed');
  assert.equal((finished.result as { status: string }).status, 'done');
  await delay(700);
  await assert.rejects(Promise.resolve().then(() => jevCall(socketPath, 'status', {}, AbortSignal.timeout(500))));
});

test('one process serves a HUD home and exits after grace', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  const saved = {
    LC_ALL: process.env.LC_ALL,
    LC_SECRET: process.env.LC_SECRET,
    SYNTHETIC_API_KEY: process.env.SYNTHETIC_API_KEY,
    PARENT_SECRET_SENTINEL: process.env.PARENT_SECRET_SENTINEL,
  };
  process.env.LC_ALL = 'C';
  process.env.LC_SECRET = 'synthetic-lc-secret';
  process.env.SYNTHETIC_API_KEY = SENTINEL;
  process.env.PARENT_SECRET_SENTINEL = SENTINEL;
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const stateDir = tempState(hudHome);
  const first = await connectJevExecutor(hudHome, {
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    cdpUrl: 'http://offline.invalid',
    fake: true,
    graceMs: 4_000,
    stateDir,
  });
  const second = await connectJevExecutor(hudHome, {
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    cdpUrl: 'http://offline.invalid',
    fake: true,
    graceMs: 4_000,
    stateDir,
  });
  const status = await first.status();
  assert.equal((await second.status()).pid, status.pid);
  assert.equal(status.pid === process.pid, false);
  const environ = readFileSync(`/proc/${status.pid}/environ`).toString('utf8');
  const cmdline = readFileSync(`/proc/${status.pid}/cmdline`).toString('utf8');
  assert.equal(environ.includes(SENTINEL), false);
  assert.equal(environ.includes('synthetic-lc-secret'), false);
  assert.equal(environ.includes('SYNTHETIC_API_KEY'), false);
  assert.equal(environ.split('\0').includes(`HOME=${process.env.HOME}`), true);
  assert.equal(environ.split('\0').includes(`HOME=${hudHome}`), false);
  assert.equal(environ.split('\0').includes('LC_ALL=C'), true);
  assert.equal(cmdline.includes('--use-env-proxy'), true);
  const noProxy = environ.split('\0').find((entry) => entry.startsWith('NO_PROXY='));
  assert.equal(noProxy?.includes('127.0.0.1'), true);
  assert.equal(noProxy?.includes('localhost'), true);
  t.after(() => {
    if (alive(status.pid)) {
      try {
        process.kill(status.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  });
  const idleHome = home(t);
  bothKeys(idleHome);
  const idle = await connectJevExecutor(idleHome, {
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    cdpUrl: 'http://offline.invalid',
    fake: true,
    graceMs: 150,
    stateDir: tempState(idleHome),
  });
  const idlePid = (await idle.status()).pid;
  t.after(() => {
    if (alive(idlePid)) process.kill(idlePid, 'SIGTERM');
  });
  assert.equal(await waitDead(idlePid, 3_000), true);

  const heldHome = home(t);
  bothKeys(heldHome);
  const hold = join(heldHome, 'jev-runtime', 'hold');
  mkdirSync(join(heldHome, 'jev-runtime'), { recursive: true, mode: 0o700 });
  writeFileSync(hold, '1');
  const held = await connectJevExecutor(heldHome, {
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    cdpUrl: 'http://offline.invalid',
    fake: true,
    graceMs: 1_500,
    stateDir: tempState(heldHome),
  });
  const heldPid = (await held.status()).pid;
  t.after(() => {
    if (alive(heldPid)) process.kill(heldPid, 'SIGTERM');
  });
  const job = await held.createJob(browse('proc-hold'));
  await delay(1_800);
  assert.equal(alive(heldPid), true);
  assert.equal((await held.readJob(job.id)).state, 'running');
  unlinkSync(hold);
  const finished = await until(() => held.readJob(job.id), 'completed');
  assert.equal((finished.result as { status: string }).status, 'done');
  assert.equal(await waitDead(heldPid, 3_000), true);
});

test('browse completes through the fake CDP browser', { timeout: DEFAULT_CDP_TIMEOUT_MS + 5_000 }, async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  const stateDir = tempState(hudHome);
  const fake = await startFakeCdp();
  t.after(() => fake.close());
  // complete() publishes the job before finally closes the browser. Wait for that close.
  let browserClosed = Promise.resolve();
  const runtime = await started(t, hudHome, {
    hudHome,
    stateDir,
    fake: false,
    browserFactory: async (url) => {
      const browser = await Browser.open(url, { cdpUrl: fake.httpUrl, timeoutMs: DEFAULT_CDP_TIMEOUT_MS });
      const finish = browser.close.bind(browser);
      browserClosed = new Promise((resolve, reject) => {
        browser.close = () =>
          finish().then(
            () => resolve(),
            (error: unknown) => {
              reject(error);
              throw error;
            }
          );
      });
      browserClosed.catch(() => undefined);
      // The loopback CDP stand-in does not run page JavaScript, so the marker check cannot pass.
      browser.fresh = async () => true;
      return browser;
    },
    providerFactory: () => fakeProvider(),
  });
  const job = await runtime.createJob({
    requestKey: 'cdp-1',
    session,
    input: { tag: 'browse', goal: 'Stop on the synthetic page.', url: 'http://127.0.0.1/synthetic' },
  });
  const deadline = Date.now() + DEFAULT_CDP_TIMEOUT_MS;
  let finished = await runtime.readJob(job.id);
  while (finished.state !== 'completed' && finished.state !== 'failed' && Date.now() < deadline) {
    await delay(20);
    finished = await runtime.readJob(job.id);
  }
  assert.equal(finished.state, 'completed', JSON.stringify(finished.error ?? finished.result));
  await browserClosed;
  assert.equal((finished.result as { status: string }).status, 'done');
  assert.equal(finished.provider?.id, 'typesafe');
  assert.ok(fake.navigated.includes('http://127.0.0.1/synthetic'));
  assert.equal(fake.closedTargets.length > 0, true);
  assert.equal(new URL(fake.httpUrl).hostname, '127.0.0.1');
});

test('judge runs read-only against the fake page', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  const runtime = await started(t, hudHome);
  const job = await runtime.createJob({
    requestKey: 'judge-1',
    session,
    input: {
      tag: 'judge',
      url: 'https://example.invalid/fixture',
      statements: [{ name: 'page_ready', statement: 'The page is ready.' }],
    },
  });
  const finished = await until(() => runtime.readJob(job.id), 'completed');
  const result = finished.result as { statements: Array<{ name: string; verdict: string }> };
  assert.equal(result.statements[0]?.verdict, 'pass');
  assert.equal(result.statements[0]?.name, 'page_ready');
});

test('importing the entry does not start a runtime, and a relative home exits 2', async () => {
  const entry = new URL('../../src/jev/runtime/entry.js', import.meta.url);
  const imported = spawn(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(entry.href)})`],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  const importCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      imported.kill('SIGTERM');
      reject(new Error('import hung'));
    }, 4_000);
    imported.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
  assert.equal(importCode, 0);

  const rejected = spawn(process.execPath, [fileURLToPath(entry), 'relative-home'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  rejected.stderr?.setEncoding('utf8');
  rejected.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise<number>((resolve) => {
    rejected.on('exit', (status) => resolve(status ?? 1));
  });
  assert.equal(code, 2);
  assert.equal(stderr, 'jev-runtime: hud home must be absolute\n');
  assert.equal(stderr.includes(SENTINEL), false);
});

test('AI Studio stays pending and has no invented key', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  const runtime = await started(t, hudHome, {
    hudHome,
    askTargets: {
      aistudio: {
        id: 'aistudio',
        sends: true,
        async click() {
          throw new Error('clicked');
        },
      },
    },
  });
  const created = await runtime.createJob({
    requestKey: 'studio-1',
    session,
    input: { tag: 'ask', target: 'aistudio', label: 'note', prompt: 'hello synthetic' },
  });
  const job = await until(() => runtime.readJob(created.id), 'completed');
  assert.equal(job.state, 'completed');
  assert.deepEqual(job.result, { status: 'target_pending', target: 'aistudio' });
  assert.equal(askRecordKey('aistudio', 'note', 'hello synthetic'), undefined);
});

test('OpenAI base URL stays in memory and off the job file', async (t) => {
  const hudHome = home(t);
  writeEnv(hudHome, `OPENAI_API_KEY=${SENTINEL}-openai\nOPENAI_BASE_URL=https://synthetic.example/v1\n`);
  let baseUrl = '';
  const runtime = await started(t, hudHome, {
    hudHome,
    providerFactory: (resolved) => {
      baseUrl = resolved.baseUrl ?? '';
      return fakeProvider();
    },
  });
  const job = await runtime.createJob({ ...ask('base-1'), jevDecisions: { provider: 'openai' } });
  assert.equal(baseUrl, 'https://synthetic.example/v1');
  const text = readFileSync(join(hudHome, 'jev-runtime', 'jobs', `${job.id}.json`), 'utf8');
  assert.equal(text.includes('synthetic.example'), false);
  assert.equal(text.includes(SENTINEL), false);
});

test('a reserved statement name is rejected', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  const runtime = await started(t, hudHome);
  await assert.rejects(
    runtime.createJob({
      requestKey: 'reserved-1',
      session,
      input: {
        tag: 'judge',
        url: 'https://example.invalid/fixture',
        statements: [{ name: 'loading', statement: 'The page is still loading.' }],
      },
    }),
    (error: { code?: string }) => error.code === 'invalid_request'
  );
});

test('a missing record directory is not created', async (t) => {
  const hudHome = home(t);
  const stateDir = join(hudHome, 'missing-state');
  const runtime = new JevRuntime({
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    cdpUrl: 'http://offline.invalid',
    hudHome,
    stateDir,
    fake: true,
    graceMs: 60_000,
  });
  await assert.rejects(runtime.start(), (error: { code?: string }) => error.code === 'jev_state_dir_missing');
  assert.equal(existsSync(stateDir), false);
});

test('a second runtime leaves a live socket and its jobs alone', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  mkdirSync(join(hudHome, 'jev-runtime'), { recursive: true, mode: 0o700 });
  const hold = join(hudHome, 'jev-runtime', 'hold');
  writeFileSync(hold, '1');
  const runtime = await started(t, hudHome);
  const job = await runtime.createJob(browse('live-lock'));
  const running = await until(() => runtime.readJob(job.id), 'running');
  assert.equal(running.state, 'running');
  const second = new JevRuntime({
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    cdpUrl: 'http://offline.invalid',
    hudHome,
    stateDir: runtime.stateDir,
    graceMs: 60_000,
    fake: true,
  });
  await assert.rejects(second.start(), (error: { code?: string }) => error.code === 'already_running');
  const stored = JSON.parse(readFileSync(join(hudHome, 'jev-runtime', 'jobs', `${job.id}.json`), 'utf8')) as {
    state: string;
  };
  assert.equal(stored.state, 'running');
  const status = (await jevCall(join(hudHome, 'jev-runtime', 'runtime.sock'), 'status', {})) as { pid: number };
  assert.equal(status.pid, process.pid);
  unlinkSync(hold);
  await runtime.stop();
});

test('a call times out when the socket closes without a reply', async (t) => {
  const dir = home(t);
  const file = join(dir, 'runtime.sock');
  const server = await serveLine(file, () => new Promise(() => undefined));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  );
  await assert.rejects(
    jevCall(file, 'status', {}, undefined, 200),
    (error: { code?: string; deadline?: boolean }) => error.code === 'runtime_timeout' && error.deadline === true
  );
  const pending = jevCall(file, 'status', {}, undefined, 5_000);
  await delay(30);
  server.close();
  await assert.rejects(
    pending,
    (error: { code?: string; deadline?: boolean }) => error.code === 'runtime_timeout' && error.deadline !== true
  );
});

test('the same handle reads a completed job after the idle runtime exits', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  const handle = await connectJevExecutor(hudHome, {
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    cdpUrl: 'http://offline.invalid',
    fake: true,
    graceMs: 200,
    stateDir: tempState(hudHome),
  });
  const job = await handle.createJob(browse('regrace'));
  const done = await until(() => handle.readJob(job.id), 'completed');
  assert.equal(done.state, 'completed');
  const pid = (await handle.status()).pid;
  t.after(() => {
    if (alive(pid)) process.kill(pid, 'SIGTERM');
  });
  assert.equal(await waitDead(pid, 3_000), true);
  const again = await handle.readJob(job.id);
  assert.equal(again.id, job.id);
  assert.equal(again.state, 'completed');
});

test('SIGTERM marks a running job interrupted', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  mkdirSync(join(hudHome, 'jev-runtime'), { recursive: true, mode: 0o700 });
  const hold = join(hudHome, 'jev-runtime', 'hold');
  writeFileSync(hold, '1');
  const handle = await connectJevExecutor(hudHome, {
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    cdpUrl: 'http://offline.invalid',
    fake: true,
    graceMs: 30_000,
    stateDir: tempState(hudHome),
  });
  const pid = (await handle.status()).pid;
  t.after(() => {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
  const job = await handle.createJob(browse('term-1'));
  const running = await until(() => handle.readJob(job.id), 'running');
  assert.equal(running.state, 'running');
  process.kill(pid, 'SIGTERM');
  assert.equal(await waitDead(pid, 3_000), true);
  const stored = JSON.parse(readFileSync(join(hudHome, 'jev-runtime', 'jobs', `${job.id}.json`), 'utf8')) as {
    state: string;
  };
  assert.equal(stored.state, 'interrupted');
});

test('judge uses the configured CDP endpoint', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  const fake = await startFakeCdp();
  t.after(() => fake.close());
  const runtime = await started(t, hudHome, {
    hudHome,
    fake: false,
    cdpUrl: fake.httpUrl,
    providerFactory: () => fakeProvider(),
  });
  const job = await runtime.createJob({
    requestKey: 'cdp-judge',
    session,
    input: {
      tag: 'judge',
      url: 'http://127.0.0.1/synthetic',
      statements: [{ name: 'page_ready', statement: 'The page is ready.' }],
    },
  });
  let finished = await runtime.readJob(job.id);
  for (let i = 0; i < 80 && finished.state !== 'completed' && finished.state !== 'failed'; i += 1) {
    await delay(50);
    finished = await runtime.readJob(job.id);
  }
  assert.equal(finished.state, 'completed', JSON.stringify(finished.error ?? finished.result));
  const result = finished.result as { statements: Array<{ verdict: string }>; calls: number };
  assert.equal(result.statements[0]?.verdict, 'pass');
  assert.equal(result.calls, 1);
  assert.equal(
    fake.paths.some((item) => item.startsWith('/json/version')),
    true
  );
  assert.equal(
    fake.expressions.some((expression) => expression.trim() === 'document.readyState'),
    true
  );
});

test('a read deadline is the capped wait plus a margin, and that deadline is not retried', () => {
  assert.equal(cappedReadWaitMs(200_000), 120_000);
  assert.equal(cappedReadWaitMs(11_000), 11_000);
  assert.equal(cappedReadWaitMs(undefined), 0);
  assert.equal(readDeadlineMs(11_000), 16_000);
  assert.equal(readDeadlineMs(200_000), 125_000);
  assert.equal(readDeadlineMs(undefined), 5_000);
  const deadline = Object.assign(new Error('runtime_timeout'), { code: 'runtime_timeout', deadline: true });
  const closed = Object.assign(new Error('runtime_timeout'), { code: 'runtime_timeout' });
  assert.equal(retryableJevError(deadline, 'readJob'), false);
  assert.equal(retryableJevError(closed, 'readJob'), true);
  assert.equal(retryableJevError(deadline, 'createJob'), true);
  assert.equal(retryableJevError(Object.assign(new Error('missing'), { code: 'ENOENT' }), 'readJob'), true);
});

test('readJob waits longer than the default call deadline', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  mkdirSync(join(hudHome, 'jev-runtime'), { recursive: true, mode: 0o700 });
  const hold = join(hudHome, 'jev-runtime', 'hold');
  writeFileSync(hold, '1');
  const handle = await connectJevExecutor(hudHome, {
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    cdpUrl: 'http://offline.invalid',
    fake: true,
    graceMs: 60_000,
    stateDir: tempState(hudHome),
  });
  const pid = (await handle.status()).pid;
  t.after(() => {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
  const job = await handle.createJob(browse('long-poll'));
  const running = await until(() => handle.readJob(job.id), 'running');
  assert.equal(running.state, 'running');
  const startedAt = Date.now();
  const held = await handle.readJob(job.id, { waitMs: 11_000, afterSeq: running.seq });
  const elapsed = Date.now() - startedAt;
  assert.equal(held.state, 'running');
  assert.equal(held.id, job.id);
  assert.ok(elapsed >= 10_000, String(elapsed));
  assert.ok(elapsed < 15_000, String(elapsed));
  unlinkSync(hold);
  if (alive(pid)) process.kill(pid, 'SIGTERM');
  assert.equal(await waitDead(pid, 3_000), true);
});

test('runtime flags come from connect options, not the parent environment', async (t) => {
  const saved = {
    JEV_RUNTIME_FAKE: process.env.JEV_RUNTIME_FAKE,
    JEV_RUNTIME_GRACE_MS: process.env.JEV_RUNTIME_GRACE_MS,
    JEV_RUNTIME_STATE_DIR: process.env.JEV_RUNTIME_STATE_DIR,
    JEV_RUNTIME_CDP_URL: process.env.JEV_RUNTIME_CDP_URL,
  };
  process.env.JEV_RUNTIME_FAKE = '1';
  process.env.JEV_RUNTIME_GRACE_MS = '17';
  process.env.JEV_RUNTIME_STATE_DIR = '/tmp/jev-parent-sentinel-state';
  process.env.JEV_RUNTIME_CDP_URL = 'http://parent-sentinel.invalid';
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const hudHome = home(t);
  bothKeys(hudHome);
  const stateDir = tempState(hudHome);
  const handle = await connectJevExecutor(hudHome, {
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    cdpUrl: 'http://offline.invalid',
    graceMs: 30_000,
    stateDir,
  });
  const pid = (await handle.status()).pid;
  t.after(() => {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
  const rows = readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0');
  assert.equal(
    rows.some((row) => row.startsWith('JEV_RUNTIME_FAKE=')),
    false
  );
  assert.equal(rows.includes('JEV_RUNTIME_GRACE_MS=17'), false);
  assert.equal(rows.includes('JEV_RUNTIME_GRACE_MS=30000'), true);
  assert.equal(rows.includes('JEV_RUNTIME_STATE_DIR=/tmp/jev-parent-sentinel-state'), false);
  assert.equal(rows.includes(`JEV_RUNTIME_STATE_DIR=${stateDir}`), true);
  assert.equal(rows.includes('JEV_RUNTIME_CDP_URL=http://offline.invalid'), true);
  if (alive(pid)) process.kill(pid, 'SIGTERM');
  assert.equal(await waitDead(pid, 3_000), true);
});

test('the env-proxy flag follows the injected detection', async (t) => {
  assert.deepEqual(detectEnvProxySupport(new Set(['--use-env-proxy']), '18.0.0'), { flag: true, envVar: true });
  assert.deepEqual(detectEnvProxySupport(new Set(['NODE_USE_ENV_PROXY']), '18.0.0'), { flag: false, envVar: true });
  assert.deepEqual(detectEnvProxySupport(new Set(), '22.13.0'), { flag: false, envVar: false });
  assert.deepEqual(detectEnvProxySupport(new Set(), '22.20.0'), { flag: false, envVar: false });
  assert.deepEqual(detectEnvProxySupport(new Set(), '22.21.0'), { flag: true, envVar: true });
  assert.deepEqual(detectEnvProxySupport(new Set(), '24.0.0'), { flag: true, envVar: true });
  assert.deepEqual(detectEnvProxySupport(new Set(), 'v24.22.1'), { flag: true, envVar: true });

  const spawnWith = async (support: EnvProxySupport) => {
    const hudHome = home(t);
    bothKeys(hudHome);
    const handle = await connectJevExecutor(hudHome, {
      chrome: '/synthetic/chrome',
      profile: '/synthetic/profile',
      cdpUrl: 'http://offline.invalid',
      fake: true,
      graceMs: 30_000,
      stateDir: tempState(hudHome),
      envProxy: support,
    });
    const pid = (await handle.status()).pid;
    t.after(() => {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    });
    const rows = readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0');
    const cmdline = readFileSync(`/proc/${pid}/cmdline`).toString('utf8');
    return { pid, rows, cmdline };
  };

  const flagged = await spawnWith({ flag: true, envVar: true });
  assert.equal(flagged.cmdline.includes('--use-env-proxy'), true);
  assert.equal(flagged.rows.includes('NODE_USE_ENV_PROXY=1'), true);
  process.kill(flagged.pid, 'SIGTERM');
  assert.equal(await waitDead(flagged.pid, 3_000), true);

  const variable = await spawnWith({ flag: false, envVar: true });
  assert.equal(variable.cmdline.includes('--use-env-proxy'), false);
  assert.equal(variable.rows.includes('NODE_USE_ENV_PROXY=1'), true);
  const noProxy = variable.rows.find((row) => row.startsWith('NO_PROXY='));
  assert.equal(noProxy?.includes('127.0.0.1'), true);
  assert.equal(noProxy?.includes('localhost'), true);
  process.kill(variable.pid, 'SIGTERM');
  assert.equal(await waitDead(variable.pid, 3_000), true);

  const overlay = await spawnWith({ flag: false, envVar: false });
  assert.equal(overlay.cmdline.includes('--use-env-proxy'), false);
  assert.equal(
    overlay.rows.some((row) => row.startsWith('NODE_USE_ENV_PROXY=')),
    false
  );
  const overlayProxy = overlay.rows.find((row) => row.startsWith('NO_PROXY='));
  assert.equal(overlayProxy?.includes('127.0.0.1'), true);
  assert.equal(overlayProxy?.includes('localhost'), true);
  process.kill(overlay.pid, 'SIGTERM');
  assert.equal(await waitDead(overlay.pid, 3_000), true);
});

test('a missing state directory fails fast with the child code', async (t) => {
  const hudHome = home(t);
  const stateDir = join(hudHome, 'missing-state');
  const startedAt = Date.now();
  await assert.rejects(
    connectJevExecutor(hudHome, {
      chrome: '/synthetic/chrome',
      profile: '/synthetic/profile',
      cdpUrl: 'http://offline.invalid',
      stateDir,
      graceMs: 60_000,
    }),
    (error: { code?: string }) => error.code === 'jev_state_dir_missing'
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 3_000, String(elapsed));
  assert.equal(existsSync(stateDir), false);
  const errFile = join(hudHome, 'jev-runtime', 'child.err');
  const err = existsSync(errFile) ? readFileSync(errFile, 'utf8') : '';
  assert.match(err, /jev-runtime: jev_state_dir_missing/);
  assert.equal(err.includes(SENTINEL), false);
});

test('SIGTERM exits when stop does not finish', async (t) => {
  assert.equal(STOP_DEADLINE_MS, 10_000);
  assert.equal(stopDeadlineMs(undefined), 10_000);
  assert.equal(stopDeadlineMs('400'), 400);
  assert.equal(stopDeadlineMs('999999'), 10_000);
  assert.equal(stopDeadlineMs(''), 10_000);
  const hudHome = mkdtempSync(join(tmpdir(), 'jev-r3-'));
  chmodSync(hudHome, 0o700);
  let pid = 0;
  t.after(() => {
    if (pid && alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    rmSync(hudHome, { recursive: true, force: true });
  });
  bothKeys(hudHome);
  const stateDir = tempState(hudHome);
  mkdirSync(join(hudHome, 'jev-runtime'), { recursive: true, mode: 0o700 });
  writeFileSync(join(hudHome, 'jev-runtime', 'close-hold'), '1');
  const entry = fileURLToPath(new URL('../../src/jev/runtime/entry.js', import.meta.url));
  const child = spawn(process.execPath, [entry, hudHome], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin',
      HOME: process.env.HOME ?? '/tmp',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      JEV_RUNTIME_FAKE: '1',
      JEV_RUNTIME_STATE_DIR: stateDir,
      JEV_RUNTIME_CDP_URL: 'http://offline.invalid',
      JEV_RUNTIME_CHROME: '/synthetic/chrome',
      JEV_RUNTIME_PROFILE: '/synthetic/profile',
      JEV_RUNTIME_GRACE_MS: '60000',
      JEV_RUNTIME_STOP_DEADLINE_MS: '400',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  pid = child.pid ?? 0;
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? 1));
  });
  const socketPath = join(hudHome, 'jev-runtime', 'runtime.sock');
  let up = false;
  for (let i = 0; i < 100 && !up; i += 1) {
    try {
      await jevCall(socketPath, 'status', {}, AbortSignal.timeout(200), 200);
      up = true;
    } catch {
      await delay(20);
    }
  }
  assert.equal(up, true);
  const handle = await connectJevExecutor(hudHome, {
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    cdpUrl: 'http://offline.invalid',
    fake: true,
    graceMs: 60_000,
    stateDir,
  });
  const job = await handle.createJob(browse('stop-deadline'));
  let latest = await handle.readJob(job.id);
  for (let i = 0; i < 50 && latest.state === 'queued'; i += 1) {
    await delay(20);
    latest = await handle.readJob(job.id);
  }
  await delay(200);
  assert.equal(alive(pid), true);
  assert.equal(latest.state === 'running' || latest.state === 'completed', true);
  const startedAt = Date.now();
  process.kill(pid, 'SIGTERM');
  const code = await exited;
  const elapsed = Date.now() - startedAt;
  assert.equal(stderr.includes(SENTINEL), false);
  assert.equal(code, 1);
  assert.ok(elapsed >= 250, String(elapsed));
  assert.ok(elapsed < 2_000, String(elapsed));
});
