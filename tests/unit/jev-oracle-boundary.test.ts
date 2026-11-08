// R4 runtime boundary: completed-but-recoverable receipts, pre-send human gates and
// target refusals as the runtime and its socket report them. Injected synthetic targets,
// a fake clock and temporary state dirs. No browser, provider, key or user config is touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connectJevExecutor } from '../../src/jev/runtime/client.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { JevFailure } from '../../src/jev/ask/error.js';
import { operationPath } from '../../src/jev/ask/names.js';
import { promptSha256, readOperation, squashedSha256, type OperationRecord } from '../../src/jev/ask/records.js';
import { studioKey, withStudioLock } from '../../src/jev/runtime/aistudio-state.js';
import { aistudioTarget, STUDIO_PAGE_STATE } from '../../src/jev/runtime/aistudio.js';
import {
  makeUserPromptScript,
  makeUserPromptScrollScript,
  REPLY_JS,
  SCROLL_JS,
} from '../../src/jev/runtime/aistudio-facts.js';
import type { OracleBrowser } from '../../src/jev/runtime/chatgpt.js';
import { JevRuntime, askRecordKey } from '../../src/jev/runtime/executor.js';
import { jevCall } from '../../src/jev/runtime/ipc.js';
import type { OracleFacts, OraclePage, OracleTarget, OracleTurn } from '../../src/jev/runtime/oracle.js';
import type { JevJob } from '../../src/jev/runtime/types.js';
import { facadeState, readRoleJevJob } from '../../src/roles/jev-adapter.js';
import { createRoleJevExecutor, hudCreate, hudRead } from '../../src/roles/facade.js';

const SESSION = { namespace: 'synthetic', sessionId: 'r4-boundary' };
const PROMPT = 'synthetic boundary question';
const ANSWER = 'synthetic boundary answer';
const ROOT = 'https://oracle.example/';
const CONVERSATION = 'https://oracle.example/settled';
const MODEL = 'fixture-model';
const THINKING = 'High';
const SECRET = 'synthetic-r4-boundary-key';
type TargetId = 'chatgpt-pro' | 'aistudio';

interface World {
  url: string;
  turns: OracleTurn[];
  sidebar: string[];
  exchange?: { users: number; text: string; final: boolean };
  human?: string;
}

interface Fixture {
  target: OracleTarget;
  world: World;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  opens(): number;
  attaches(): number;
  pages(): number;
  prepares(): number;
  clicks(): number;
  samples(): number;
}

interface Hooks {
  prepare?: () => void;
  click?: () => void;
}

/** Time only moves on sleep, so a wait costs its sleeps and nothing else. */
function fixture(targetId: TargetId, world: World, hooks: Hooks = {}): Fixture {
  let opens = 0;
  let attaches = 0;
  let prepares = 0;
  let clicks = 0;
  let samples = 0;
  let clock = 1_700_000_000_000;
  const factsOf = (): OracleFacts => ({
    url: world.url,
    readyState: 'complete',
    marker: `${world.url}|${world.turns.length}|${world.sidebar.length}`,
    composer: null,
    stop: false,
    ...(world.human ? { human: world.human } : {}),
    sidebar: [...world.sidebar],
    turns: world.turns.map((turn) => ({ ...turn })),
    cards: [],
    ...(world.exchange ? { exchange: { ...world.exchange } } : {}),
  });
  const page = (id: string | null): OraclePage => ({
    id,
    async facts() {
      samples += 1;
      return factsOf();
    },
    async observation(facts) {
      return {
        page: { url: facts.url, title: '', text: '' },
        elements: [],
        facts: { readyState: facts.readyState, marker: facts.marker },
        deltas: {},
      };
    },
    async close() {},
    async detach() {},
  });
  const target: OracleTarget = {
    provider: targetId === 'aistudio' ? 'aistudio' : 'chatgpt',
    root: ROOT,
    settled(value): value is string {
      return value === CONVERSATION;
    },
    async open(url) {
      opens += 1;
      return page(url === CONVERSATION ? 'conversation-target' : 'root-target');
    },
    async attach(id) {
      attaches += 1;
      return page(id);
    },
    async targets() {
      return [{ targetId: 'send', url: world.url }];
    },
    async prepare() {
      prepares += 1;
      hooks.prepare?.();
      return factsOf();
    },
    async click() {
      clicks += 1;
      hooks.click?.();
    },
    binding(facts, _input, record) {
      if (targetId === 'aistudio') {
        const nth = typeof record.user_turn === 'number' ? record.user_turn : 1;
        const reply = facts.exchange;
        return {
          found: Boolean(reply && reply.users >= nth),
          answer: reply?.text ?? '',
          final: reply?.final === true,
        };
      }
      const asked = facts.turns.some((turn) => turn.role === 'user' && turn.text === PROMPT);
      const reply = facts.turns.find((turn) => turn.role === 'assistant' && turn.text);
      return {
        found: asked && Boolean(reply),
        answer: asked && reply ? reply.text : '',
        final: Boolean(reply?.final_controls),
      };
    },
    matchesDraft() {
      return false;
    },
  };
  return {
    target,
    world,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    opens: () => opens,
    attaches: () => attaches,
    pages: () => opens + attaches,
    prepares: () => prepares,
    clicks: () => clicks,
    samples: () => samples,
  };
}

interface Env {
  runtime: JevRuntime;
  home: string;
  stateDir: string;
  jobs: string;
  socket: string;
}

/** A private HUD home, state dir and job dir. Nothing outside the temp tree is read. */
function setup(t: TestContext, targetId: TargetId, h: Fixture): Env {
  const home = mkdtempSync(join(tmpdir(), 'r4-boundary-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateDir = join(home, 'state');
  mkdirSync(stateDir, { mode: 0o700 });
  writeFileSync(join(home, 'jev.env'), `TYPESAFE_API_KEY=${SECRET}\n`, { mode: 0o600 });
  const jobs = join(home, 'jev-runtime', 'jobs');
  mkdirSync(jobs, { recursive: true, mode: 0o700 });
  const runtime = new JevRuntime({
    hudHome: home,
    stateDir,
    fake: true,
    graceMs: 60_000,
    oracleTargets: { [targetId]: h.target },
    oracleNow: h.now,
    oracleSleep: h.sleep,
    studioConfigLoader: () => ({ stateDir, models: [MODEL], model: MODEL, thinking: THINKING }),
  });
  return { runtime, home, stateDir, jobs, socket: join(home, 'jev-runtime', 'runtime.sock') };
}

function keyFor(targetId: TargetId, label: string, prompt: string): string {
  return targetId === 'chatgpt-pro'
    ? askRecordKey('chatgpt-pro', label, prompt)
    : studioKey(label, prompt, MODEL, THINKING, 'new');
}

function recordFor(env: Env, targetId: TargetId, key: string): OperationRecord | null {
  if (targetId === 'chatgpt-pro') return readOperation(env.stateDir, key);
  const file = join(env.stateDir, 'aistudio_chat_state.json');
  if (!existsSync(file)) return null;
  const state = JSON.parse(readFileSync(file, 'utf8')) as { keys: Record<string, OperationRecord> };
  return state.keys[key] ?? null;
}

/** A persisted attempt whose send was confirmed: the only state a resume may observe. */
function seedAttempted(env: Env, targetId: TargetId, key: string): void {
  const record = {
    key,
    provider: targetId === 'chatgpt-pro' ? 'chatgpt' : 'aistudio',
    send_attempted: true,
    send_effect: 'sent',
    prompt_sha256: promptSha256(PROMPT),
    squashed_sha256: squashedSha256(PROMPT),
    sent_target_id: 'send',
    sidebar_before: [],
    before: { url: ROOT, turns: [], sidebar: [] },
    conversation_url: CONVERSATION,
    ...(targetId === 'aistudio' ? { attempted_at: '2026-01-01T00:00:00+00:00', user_turn: 1 } : {}),
  };
  if (targetId === 'chatgpt-pro') {
    mkdirSync(join(env.stateDir, 'operations'), { recursive: true, mode: 0o700 });
    writeFileSync(operationPath(env.stateDir, key), JSON.stringify(record), { mode: 0o600 });
    return;
  }
  writeFileSync(join(env.stateDir, 'aistudio_chat_state.json'), JSON.stringify({ keys: { [key]: record } }), {
    mode: 0o600,
  });
}

/** A receipt left behind by a crashed or finished process. */
function seedJob(env: Env, targetId: TargetId, input: Record<string, unknown>, result: unknown): void {
  writeFileSync(
    join(env.jobs, 'jev-boundary.json'),
    JSON.stringify({
      executor: 'jev',
      id: 'jev-boundary',
      requestKey: 'boundary',
      fingerprint: 'fixture',
      session: SESSION,
      tag: 'ask',
      input,
      decisionProfile: null,
      provider: { id: 'typesafe', model: 'fixture' },
      state: 'completed',
      closed: false,
      seq: 5,
      result,
      createdAt: '2026-01-01T00:00:00.000Z',
      run: { startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z' },
      ...(targetId === 'aistudio' ? { askStateDir: env.stateDir } : {}),
    }),
    { mode: 0o600 }
  );
}

async function untilTerminal(runtime: JevRuntime, id: string): Promise<JevJob> {
  let job = await runtime.readJob(id);
  for (let poll = 0; poll < 800 && (job.state === 'queued' || job.state === 'running'); poll++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    job = await runtime.readJob(id);
  }
  return job;
}

/** A resume is asynchronous: poll until the receipt carries the collected answer. */
async function untilAnswered(runtime: JevRuntime, id: string): Promise<JevJob> {
  let job = await runtime.readJob(id);
  for (let poll = 0; poll < 800 && (job.result as { status?: string } | null)?.status !== 'answered'; poll++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    job = await runtime.readJob(id);
  }
  return job;
}

for (const phase of ['confirm', 'wait'] as const) {
  for (const heldAt of ['reply-read', 'render-pause'] as const) {
    test(`T6: aistudio close during ${phase}/${heldAt} is closed and recoverable with no further reads`, async (t) => {
      const h = fixture('aistudio', { url: CONVERSATION, turns: [], sidebar: [] });
      const env = setup(t, 'aistudio', h);
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let releaseReply!: () => void;
      const replyGate = new Promise<void>((resolve) => {
        releaseReply = resolve;
      });
      let reads = 0;
      let detached = 0;
      const browser: OracleBrowser = {
        id: 'send',
        async evaluate(script) {
          reads++;
          if (script === STUDIO_PAGE_STATE)
            return {
              url: CONVERSATION,
              readyState: 'complete',
              authenticated: true,
              selector: 'textarea',
              composer: '',
              login: false,
              dialog: false,
              stop: false,
              page_error: false,
            };
          if (script === makeUserPromptScrollScript(1)) return true;
          if (script === makeUserPromptScript(1)) return PROMPT;
          if (script.startsWith(`(${REPLY_JS})`)) {
            if (heldAt === 'reply-read') {
              entered();
              await replyGate;
            }
            return { users: 1, model_turns: 100, final: false, text: '', error: null };
          }
          if (script.startsWith(`(${SCROLL_JS})`)) return true;
          throw new Error('unexpected_browser_read');
        },
        async command() {
          reads++;
          return {};
        },
        async observe() {
          throw new Error('no_judgment_needed');
        },
        async fresh() {
          return true;
        },
        async act() {
          throw new Error('recovery_must_not_send');
        },
        async close() {},
        async detach() {
          detached++;
        },
      };
      Object.assign(
        h.target,
        aistudioTarget({
          config: { stateDir: env.stateDir, model: MODEL, models: [MODEL], thinking: THINKING },
          model: MODEL,
          thinking: THINKING,
          open: async () => browser,
          attach: async () => browser,
          targets: async () => [{ targetId: 'send', url: CONVERSATION }],
          sleep: async () => {
            entered();
            await new Promise<void>(() => undefined);
          },
        })
      );
      const key = keyFor('aistudio', 'closing', PROMPT);
      seedAttempted(env, 'aistudio', key);
      if (phase === 'confirm') {
        const path = join(env.stateDir, 'aistudio_chat_state.json');
        const state = JSON.parse(readFileSync(path, 'utf8'));
        Object.assign(state.keys[key], {
          send_effect: 'uncertain',
          status: 'send_attempted',
          unresolved: 'confirm',
          conversation_url: null,
        });
        writeFileSync(path, JSON.stringify(state));
      }
      seedJob(env, 'aistudio', askInput('aistudio', 'closing'), null);
      const jobPath = join(env.jobs, 'jev-boundary.json');
      const orphan = JSON.parse(readFileSync(jobPath, 'utf8'));
      orphan.state = 'running';
      writeFileSync(jobPath, JSON.stringify(orphan));
      await env.runtime.start();
      t.after(() => env.runtime.stop());
      await env.runtime.readJob('jev-boundary', { resume: true });
      await held;
      const atHold = reads;
      let timer: NodeJS.Timeout | undefined;
      try {
        const closing = env.runtime.closeJob('jev-boundary');
        releaseReply(); // the in-flight CDP read settles only after close has aborted
        const closed = await Promise.race([
          closing,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('close_not_bounded')), 1_000);
          }),
        ]);
        assert.equal(closed.state, 'closed');
        assert.equal(closed.closed, true);
        assert.equal(closed.recoverable, true);
        const record = recordFor(env, 'aistudio', key);
        assert.equal(record?.send_attempted, true);
        assert.ok(record?.attempted_at, 'the attempted record remains recoverable');
        await env.runtime.readJob('jev-boundary', { resume: true });
        assert.equal(reads, atHold, 'no additional virtual-turn reads after hud_close');
        assert.equal(detached, 1);
        assert.equal(h.clicks(), 0);
      } finally {
        clearTimeout(timer);
      }
    });
  }
}

test('T7/T8: runtime survives its client process-group exit, retains work and recovers an orphan only after lease takeover', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'r4f-lifetime-'));
  const stateDir = join(home, 'state');
  mkdirSync(stateDir);
  mkdirSync(join(home, 'jev-runtime'));
  writeFileSync(join(home, 'jev.env'), 'TYPESAFE_API_KEY=synthetic-lifetime\n', { mode: 0o600 });
  writeFileSync(join(home, 'jev-runtime', 'hold'), '1');
  const clientModule = new URL('../../src/jev/runtime/client.js', import.meta.url).href;
  const script = `import {connectJevExecutor} from ${JSON.stringify(clientModule)};
    const h=await connectJevExecutor(${JSON.stringify(home)}, {fake:true,graceMs:50,stateDir:${JSON.stringify(stateDir)}});
    const j=await h.createJob({requestKey:'lifetime',session:{namespace:'synthetic',sessionId:'life'},input:{tag:'browse',goal:'Read synthetic page',url:'https://example.invalid/'}});
    console.log(JSON.stringify({pid:(await h.status()).pid,id:j.id}));setInterval(()=>{},1000);`;
  const client = spawn(process.execPath, ['--input-type=module', '-e', script], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const owned = new Set<number>();
  t.after(() => {
    client.kill('SIGKILL');
    for (const pid of owned) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    rmSync(home, { recursive: true, force: true });
  });
  const started = await new Promise<{ pid: number; id: string }>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('client_start_timeout')), 8_000);
    client.once('error', reject);
    client.stdout!.on('data', (chunk) => {
      output += String(chunk);
      if (!output.includes('\n')) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(output.split('\n')[0]!));
      } catch (error) {
        reject(error);
      }
    });
  });
  owned.add(started.pid);
  assert.notEqual(started.pid, client.pid);
  const exited = new Promise<void>((resolve) => client.once('exit', () => resolve()));
  process.kill(-client.pid!, 'SIGTERM');
  await exited;
  const socket = join(home, 'jev-runtime', 'runtime.sock');
  const lock = join(home, 'jev-runtime', 'runtime.lock');
  const before = JSON.parse(readFileSync(lock, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 5_300)); // > heartbeat period and >> idle grace
  const status = (await jevCall(socket, 'status', {})) as { pid: number; retained: number };
  assert.equal(status.pid, started.pid, 'same detached runtime survives the old process group');
  assert.equal(status.retained, 1, 'an outstanding observation pins the runtime past idle grace');
  const after = JSON.parse(readFileSync(lock, 'utf8'));
  assert.ok(after.heartbeat > before.heartbeat, 'async CDP waits do not stall the lease heartbeat');
  // Even an unavailable socket does not let a second runtime take a live lease.
  // Taking that lease directly follows the same admission primitive as start().
  const contender = new JevRuntime({ hudHome: home, stateDir, fake: true });
  await assert.rejects(contender.start(), (e: { code?: string }) => e.code === 'already_running');
  process.kill(started.pid, 'SIGKILL');
  const file = join(home, 'jev-runtime', 'jobs', `${started.id}.json`);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).state, 'running', 'SIGKILL leaves an orphan receipt');
  assert.ok(existsSync(lock), 'SIGKILL leaves its fresh lease on disk');
  const handle = await connectJevExecutor(home, { fake: true, graceMs: 60_000, stateDir });
  const replacement = await handle.status();
  owned.add(replacement.pid);
  assert.notEqual(replacement.pid, started.pid);
  const replacementLock = JSON.parse(readFileSync(lock, 'utf8'));
  assert.notEqual(
    replacementLock.nonce,
    after.nonce,
    'dead-PID stale rule must take over before replacing runtime.json'
  );
  const job = await handle.readJob(started.id);
  assert.equal(job.state, 'interrupted');
  assert.equal(job.error?.code, 'interrupted');
  assert.ok(job.seq > 2, 'startup recovery publishes a newer observation');
  const logs = readFileSync(join(home, 'jev-runtime', 'child.err'), 'utf8');
  assert.match(logs, /"event":"start"/);
  assert.match(logs, /"code":"interrupted"/);
  assert.ok(!logs.includes('Read synthetic page') && !logs.includes('synthetic-lifetime'));
  process.kill(replacement.pid, 'SIGTERM');
  // Wait for the owned runtime to finish before removing its temp tree.
  for (let poll = 0; poll < 200 && existsSync(lock); poll++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(lock), false);
});

async function drainRegisteredRuns(runtime: JevRuntime): Promise<void> {
  // SAFETY: this test-only view names the runtime's actual task registry. A pending
  // read returns before its registered async run; drain it before checking for late work.
  const active = runtime as unknown as { runs: Map<string, Promise<void>> };
  await Promise.allSettled([...active.runs.values()]);
}

for (const action of ['close', 'stop'] as const) {
  test(`boundary aistudio: ${action} fences a resume waiting for the CLI record lock`, async (t) => {
    const h = fixture('aistudio', {
      url: CONVERSATION,
      turns: [],
      sidebar: [],
      exchange: { users: 1, text: ANSWER, final: true },
    });
    const env = setup(t, 'aistudio', h);
    seedAttempted(env, 'aistudio', keyFor('aistudio', 'pending', PROMPT));
    seedJob(env, 'aistudio', askInput('aistudio', 'pending'), { status: 'timed_out', recoverable: true });
    await env.runtime.start();
    t.after(() => env.runtime.stop());
    let entered!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = withStudioLock(env.stateDir, async () => {
      entered();
      await gate;
    });
    await locked;
    // readJob synchronously enters store.read(), then awaits the held aggregate flock.
    const pending = env.runtime.readJob('jev-boundary', { resume: true });
    let readsAtCleanup = -1;
    try {
      if (action === 'close') await env.runtime.closeJob('jev-boundary');
      else await env.runtime.stop();
      assert.equal(h.pages(), 0, 'cleanup returned before any observation was admitted');
      readsAtCleanup = h.samples();
    } finally {
      release();
    }
    await writer;
    const after = await pending;
    await drainRegisteredRuns(env.runtime);
    assert.equal(h.pages(), 0, 'releasing the CLI lock must not admit work after cleanup');
    assert.equal(h.samples(), readsAtCleanup, 'cleanup forbids any additional observer reads');
    assert.equal(h.prepares(), 0);
    assert.equal(h.clicks(), 0);
    assert.equal(after.state, 'completed', 'the settled receipt must never return to running');
    assert.equal(after.closed, action === 'close');
    const disk = JSON.parse(readFileSync(join(env.jobs, 'jev-boundary.json'), 'utf8'));
    assert.equal(disk.state, 'completed');
    assert.equal(disk.seq, 5, 'terminal close preserves seq; no late markRunning/complete write');
  });
}

const askInput = (target: TargetId, label: string) => ({
  tag: 'ask' as const,
  target,
  label,
  prompt: PROMPT,
  ...(target === 'aistudio' ? { model: MODEL, thinking: THINKING, conversation: 'new' } : {}),
});

// A bounded observation that ended uncertain, needs_human, timed_out or wait_failed is
// settled for now, not final. Resume must reconcile the same job and collect the answer.
for (const targetId of ['chatgpt-pro', 'aistudio'] as const) {
  for (const status of ['uncertain', 'needs_human', 'timed_out', 'wait_failed'] as const) {
    test(`boundary ${targetId}/${status}: a recoverable completed receipt resumes to the answer`, async (t) => {
      const h = fixture(targetId, {
        url: CONVERSATION,
        turns: [
          { role: 'user', text: PROMPT },
          { role: 'assistant', text: ANSWER, final_controls: true },
        ],
        sidebar: [CONVERSATION],
        exchange: { users: 1, text: ANSWER, final: true },
      });
      const env = setup(t, targetId, h);
      const key = keyFor(targetId, 'resume', PROMPT);
      seedAttempted(env, targetId, key);
      seedJob(env, targetId, askInput(targetId, 'resume'), { status, key, recoverable: true });
      await env.runtime.start();
      t.after(() => env.runtime.stop());

      const before = await env.runtime.readJob('jev-boundary');
      assert.equal(before.state, 'completed');
      assert.equal((before.result as { status: string }).status, status);
      assert.equal((before.result as { recoverable?: boolean }).recoverable, true);
      assert.equal(before.recoverable, true);
      assert.equal(facadeState(before.state, before.result), 'open');
      assert.equal(h.prepares(), 0);
      assert.equal(h.clicks(), 0);

      const seq = before.seq;
      await Promise.all([
        env.runtime.readJob('jev-boundary', { resume: true }),
        env.runtime.readJob('jev-boundary', { resume: true }),
      ]);
      const done = await untilAnswered(env.runtime, 'jev-boundary');
      assert.equal(done.state, 'completed', JSON.stringify(done));
      assert.equal((done.result as { status: string }).status, 'answered');
      assert.equal((done.result as { answer: string }).answer, ANSWER);
      assert.equal(done.recoverable, false);
      assert.equal(h.prepares(), 0, 'a resume never prepares');
      assert.equal(h.clicks(), 0, 'a resume never sends');
      // One task marks running and completes once; a second concurrent resume would do both again.
      assert.equal(done.seq - seq, 2, 'concurrent resumes start exactly one wait/reconcile task');
      // ChatGPT collects from the observer alone; AI Studio also rereads the saved view once.
      assert.equal(h.pages(), targetId === 'aistudio' ? 2 : 1);
    });
  }
}

// The facade helper (hud_read) must recover the same receipt without a second task.
for (const targetId of ['chatgpt-pro', 'aistudio'] as const) {
  test(`boundary ${targetId}: readRoleJevJob recovers a completed uncertain receipt`, async (t) => {
    const h = fixture(targetId, {
      url: CONVERSATION,
      turns: [
        { role: 'user', text: PROMPT },
        { role: 'assistant', text: ANSWER, final_controls: true },
      ],
      sidebar: [CONVERSATION],
      exchange: { users: 1, text: ANSWER, final: true },
    });
    const env = setup(t, targetId, h);
    const key = keyFor(targetId, 'facade', PROMPT);
    seedAttempted(env, targetId, key);
    seedJob(env, targetId, askInput(targetId, 'facade'), { status: 'uncertain', key, recoverable: true });
    await env.runtime.start();
    t.after(() => env.runtime.stop());

    const observed = await readRoleJevJob(env.runtime, 'jev-boundary', {});
    assert.equal(observed.id, 'jev-boundary');
    const done = await untilAnswered(env.runtime, 'jev-boundary');
    assert.equal((done.result as { status: string }).status, 'answered');
    assert.equal((done.result as { answer: string }).answer, ANSWER);
    assert.equal(h.prepares(), 0);
    assert.equal(h.clicks(), 0);
    assert.equal(h.pages(), targetId === 'aistudio' ? 2 : 1);
  });
}

// One real transition: the injected target reports an uncertain send, the conversation
// becomes readable later, and the same job resumes into the answer.
for (const targetId of ['chatgpt-pro', 'aistudio'] as const) {
  test(`boundary ${targetId}: an uncertain send resumes the same job once the page is readable`, async (t) => {
    const world: World = { url: ROOT, turns: [], sidebar: [] };
    const h = fixture(targetId, world);
    const env = setup(t, targetId, h);
    await env.runtime.start();
    t.after(() => env.runtime.stop());

    const created = await env.runtime.createJob({
      requestKey: 'transition',
      session: SESSION,
      input: askInput(targetId, 'transition'),
    });
    const first = await untilTerminal(env.runtime, created.id);
    assert.equal(first.state, 'completed', JSON.stringify(first));
    assert.equal((first.result as { status: string }).status, 'uncertain');
    assert.equal((first.result as { recoverable?: boolean }).recoverable, true);
    assert.equal(first.recoverable, true);
    assert.equal(facadeState(first.state, first.result), 'open');
    assert.equal(h.prepares(), 1);
    assert.equal(h.clicks(), 1);

    // The send landed; the page was unreadable while the observation was bounded.
    world.url = CONVERSATION;
    world.turns = [
      { role: 'user', text: PROMPT },
      { role: 'assistant', text: ANSWER, final_controls: true },
    ];
    world.sidebar = [CONVERSATION];
    if (targetId === 'aistudio') world.exchange = { users: 1, text: ANSWER, final: true };

    const seq = first.seq;
    await env.runtime.readJob(created.id, { resume: true });
    const done = await untilAnswered(env.runtime, created.id);
    assert.equal(done.state, 'completed');
    assert.equal((done.result as { status: string }).status, 'answered');
    assert.equal((done.result as { answer: string }).answer, ANSWER);
    assert.equal(done.recoverable, false);
    assert.equal(h.prepares(), 1, 'the resume never prepares again');
    assert.equal(h.clicks(), 1, 'the resume never sends again');
    assert.equal(done.seq - seq, 2);
  });
}

// A pre-send login gate is an actionable completed outcome, never a send and never an
// internal failure. Reading it again must not prepare or click.
for (const targetId of ['chatgpt-pro', 'aistudio'] as const) {
  test(`boundary ${targetId}: a pre-send login gate completes needs_human without a send`, async (t) => {
    const h = fixture(
      targetId,
      { url: ROOT, turns: [], sidebar: [] },
      {
        prepare: () => {
          throw new JevFailure('needs_human', 'login');
        },
      }
    );
    const env = setup(t, targetId, h);
    await env.runtime.start();
    t.after(() => env.runtime.stop());

    const created = await env.runtime.createJob({
      requestKey: 'gate',
      session: SESSION,
      input: askInput(targetId, 'gate'),
    });
    const done = await untilTerminal(env.runtime, created.id);
    assert.equal(done.state, 'completed', JSON.stringify(done));
    const result = done.result as { status: string; reason?: string; recoverable?: boolean };
    assert.equal(result.status, 'needs_human');
    assert.equal(result.reason, 'login');
    assert.equal(result.recoverable, false);
    assert.equal(done.recoverable, false);
    assert.equal(facadeState(done.state, done.result), 'done');
    assert.equal(h.clicks(), 0, 'a human gate never clicks');

    const record = recordFor(env, targetId, keyFor(targetId, 'gate', PROMPT));
    assert.notEqual(record?.send_attempted, true);
    assert.equal(record?.attempted_at, undefined);

    const prepares = h.prepares();
    await readRoleJevJob(env.runtime, created.id, {});
    await env.runtime.readJob(created.id, { resume: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.prepares(), prepares, 'a non-recoverable receipt is never prepared again');
    assert.equal(h.clicks(), 0);
    const again = await env.runtime.readJob(created.id);
    assert.equal(again.state, 'completed');
    assert.equal((again.result as { status: string }).status, 'needs_human');
  });
}

// A finite target refusal keeps its code through the runtime, the job file and the socket.
const REFUSALS: Array<{ code: string; targets: TargetId[] }> = [
  ...[
    'page_ready_timeout',
    'page_ready_denied',
    'upload_finished_denied',
    'composer_clean_denied',
    'draft_cleared_denied',
    'page_facts_invalid',
    'already_submitted',
    'cards_present',
    'draft_cleared_timeout',
    'draft_clear_failed',
    'upload_finished_timeout',
    'composer_clean_timeout',
    'mode.budget',
    'mode.wrong_menu',
    'fill.budget',
    'fill.no_composer',
    'fill.text_mismatch',
    'fill.target_not_composer',
    'send.budget',
    'send.not_chosen',
    'gate.changed',
    'gate.stale',
    'attach.no_input',
    'attach.card_wrong',
    'attach.changed',
    'empty_conversation',
    'exchange_too_large',
    'aistudio_not_ready',
    'aistudio_config',
    'aistudio_lock_failed',
    'aistudio_lock_unavailable',
    'aistudio_release_forbidden',
    'chrome',
    'prompt_encoding',
    'lease_required',
    'lease_lost',
    'wait_busy',
    'browser_busy',
    'already_sent',
    'already_released',
    'already_attempted',
    'resend_needs_confirmation',
    'provider_mismatch',
    'invalid_label',
    'empty_prompt',
    'invalid_key',
    'record_corrupt',
    'association_conflict',
  ].map((code) => ({ code, targets: ['chatgpt-pro'] as TargetId[] })),
  { code: 'aistudio_paid_key_selected', targets: ['aistudio'] },
  { code: 'aistudio_model_not_allowed', targets: ['aistudio'] },
  { code: 'aistudio_model_mismatch', targets: ['aistudio'] },
  { code: 'aistudio_thinking_mismatch', targets: ['aistudio'] },
  { code: 'unsupported_attachment', targets: ['chatgpt-pro', 'aistudio'] },
];
for (const refusal of REFUSALS) {
  for (const targetId of refusal.targets) {
    test(`boundary ${targetId}/${refusal.code}: a pre-send refusal keeps its code`, async (t) => {
      const h = fixture(
        targetId,
        { url: ROOT, turns: [], sidebar: [] },
        {
          prepare: () => {
            throw new JevFailure(refusal.code, refusal.code);
          },
        }
      );
      const env = setup(t, targetId, h);
      await env.runtime.start();
      t.after(() => env.runtime.stop());

      const created = await env.runtime.createJob({
        requestKey: 'refusal',
        session: SESSION,
        input: askInput(targetId, 'refusal'),
      });
      const done = await untilTerminal(env.runtime, created.id);
      assert.equal(done.state, 'failed', JSON.stringify(done));
      assert.equal(done.error?.code, refusal.code);
      assert.equal(done.error?.message, refusal.code);
      assert.equal(h.clicks(), 0, 'a refusal never clicks');
      assert.ok(!JSON.stringify(done).includes(SECRET), 'a job never carries the credential');

      const record = recordFor(env, targetId, keyFor(targetId, 'refusal', PROMPT));
      assert.notEqual(record?.send_attempted, true);
      assert.equal(record?.attempted_at, undefined);

      // The same code survives the socket framing the role facade reads through.
      const overIpc = (await jevCall(env.socket, 'readJob', { jobId: created.id })) as JevJob;
      assert.equal(overIpc.state, 'failed');
      assert.equal(overIpc.error?.code, refusal.code);
      assert.equal(overIpc.error?.message, refusal.code);
      assert.ok(!JSON.stringify(overIpc).includes(SECRET));
      // T3: the real facade uses a handle whose every operation crosses the socket.
      // No fake substitutes for serialization, job failure or facade observation.
      const handle = {
        createJob: (request: unknown) =>
          jevCall(env.socket, 'createJob', request as Record<string, unknown>) as Promise<JevJob>,
        readJob: (jobId: string, options = {}) =>
          jevCall(env.socket, 'readJob', { jobId, ...options }) as Promise<JevJob>,
        sendFollowUp: (jobId: string, followUp: unknown) =>
          jevCall(env.socket, 'sendFollowUp', { jobId, followUp }) as Promise<JevJob>,
        closeJob: (jobId: string) => jevCall(env.socket, 'closeJob', { jobId }) as Promise<JevJob>,
      };
      writeFileSync(
        join(env.home, 'routing.toml'),
        `schema = 1
 default_preset = "test"
 [backends.web]
 executor = "jev"
 target = "${targetId}"
 [backends.cli]
 executor = "herdr"
 harness = "pi"
 model = "synthetic"
 recipe = "pi-role"
 [jev_decisions.test]
 provider = "typesafe"
 [presets.test]
 description = "Synthetic refusal fixture"
 jev_decisions = "test"
 [presets.test.roles]
 "oracle.propose" = "web"
 "oracle.converge" = "cli"
 imp = "cli"
 reviewer = "cli"
 sonic = "cli"
 jev = "web"
 `,
        { mode: 0o600 }
      );
      const ctx = { home: env.home, root: SESSION, env: {}, jev: createRoleJevExecutor(env.home, handle) };
      const launched = await hudCreate(ctx, {
        role: 'oracle',
        phase: 'propose',
        request_key: 'facade-refusal',
        task: PROMPT,
        cwd: env.home,
      });
      assert.equal(launched.ok, true, JSON.stringify(launched));
      const runtimeId = (launched.executor as { job: string }).job;
      await untilTerminal(env.runtime, runtimeId);
      const observed = await hudRead(ctx, { job: launched.job });
      assert.equal(observed.state, 'error');
      assert.equal(observed.status, refusal.code);
      assert.equal((observed.error as { code: string }).code, refusal.code);
    });
  }
}
