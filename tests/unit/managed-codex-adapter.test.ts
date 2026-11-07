import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CodexManagedAdapterFactory,
  type CodexManagedAdapterOptions,
} from '../../src/harness/codex/managed-adapter.js';
import { NativeSessionHost } from '../../src/managed/host.js';
import { RelationStore, type NativeOwner } from '../../src/managed/relations.js';
import {
  AdapterDispatchError,
  type AdapterCreate,
  type AdapterEvent,
  type NativeResponse,
  type NativeRequest,
  type ManagedAdapterSession,
} from '../../src/managed/types.js';

async function until(predicate: () => boolean, ms = 2500): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate() && Date.now() < end) await delay(5);
  assert.ok(predicate(), 'expected event before deadline');
}
function fixture(
  t: test.TestContext,
  mode = 'normal',
  settings: {
    origin?: AdapterCreate['origin'];
    request?: (request: NativeRequest) => Promise<NativeResponse>;
    requestTimeoutMs?: number;
    profile?: Pick<CodexManagedAdapterOptions, 'approvalPolicy' | 'sandbox' | 'model'>;
  } = {}
) {
  const home = mkdtempSync(join(tmpdir(), 'hud-native-codex-'));
  const log = join(home, 'requests.jsonl');
  const events: AdapterEvent[] = [],
    nativeRequests: NativeRequest[] = [],
    sessions: ManagedAdapterSession[] = [];
  const factory = new CodexManagedAdapterFactory({
    executable: process.execPath,
    args: [resolve('tests/fakes/managed-codex-server.mjs'), mode, log],
    env: { HOME: home, HUD_HOME: join(home, '.hud'), CODEX_HOME: join(home, '.codex') },
    ...settings.profile,
    requestTimeoutMs: settings.requestTimeoutMs ?? 1500,
  });
  t.after(async () => {
    for (const session of sessions) await session.close();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    events,
    nativeRequests,
    requests: (): Record<string, any>[] =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    create: async () => {
      const session = await factory.create(
        { workspace: home, origin: settings.origin ?? { kind: 'new' } },
        {
          event: (event) => events.push(event),
          request: async (request) => {
            nativeRequests.push(request);
            return settings.request ? settings.request(request) : { result: { decision: 'decline' } };
          },
        }
      );
      sessions.push(session);
      return session;
    },
  };
}
const results = (events: AdapterEvent[]) =>
  events.filter((e): e is Extract<AdapterEvent, { kind: string }> => e.type === 'native_result');

test('native Codex: continuous turns return raw ACKs and native results, no task adjudication', async (t) => {
  const f = fixture(t),
    s = await f.create();
  assert.deepEqual(s.snapshot().nativeRef, {
    harness: 'codex',
    threadId: 'thread-owned',
    sessionId: 'session-distinct',
  });
  for (let i = 1; i <= 2; i++) {
    const receipt = await s.send({ callId: `call-${i}`, text: `synthetic-${i}` });
    assert.deepEqual(receipt.correlation, { nativeTurnId: `turn-${i}` });
    assert.equal((receipt.payload as any).turn.status, 'inProgress');
    assert.equal('disposition' in receipt, false);
    await until(() => results(f.events).length === i);
  }
  const payload = results(f.events)[1].payload as any;
  assert.equal(payload.method, 'turn/completed');
  assert.equal(payload.params.turn.status, 'completed');
  assert.equal(payload.params.turn.items[0].text, 'answer-2');
  assert.ok(f.events.every((e) => !['completed', 'activity'].includes(e.type)));
  await s.close();
  assert.equal(f.requests().filter((r) => r.method === 'initialize').length, 1);
  assert.equal(f.requests().filter((r) => r.method === 'thread/start').length, 1);
  assert.equal(f.requests().filter((r) => r.method === 'turn/interrupt').length, 0);
});

test('native Codex: pre-ACK results and future notifications remain intact', async (t) => {
  for (const mode of ['pre-ack', 'unknown-notification', 'pre-ack-overflow']) {
    const f = fixture(t, mode),
      s = await f.create();
    await s.send({ callId: 'call', text: 'synthetic' });
    if (mode === 'pre-ack-overflow') {
      await until(
        () => f.events.filter((e) => e.type === 'native_event' && e.kind === 'item/agentMessage/delta').length === 65
      );
    } else await until(() => results(f.events).length === 1);
    if (mode === 'unknown-notification')
      assert.ok(f.events.some((e) => e.type === 'native_event' && e.kind === 'future/newNotification'));
    assert.equal(s.snapshot().connected, true);
  }
});

test('native Codex: status and completed/failed/interrupted values are never rewritten', async (t) => {
  for (const [mode, status] of [
    ['normal', 'completed'],
    ['failed', 'failed'],
    ['interrupted', 'interrupted'],
    ['status-system-error', 'completed'],
  ]) {
    const f = fixture(t, mode),
      s = await f.create();
    await s.send({ callId: 'call', text: 'synthetic' });
    await until(() => results(f.events).length === 1);
    assert.equal((results(f.events)[0].payload as any).params.turn.status, status);
    if (mode === 'status-system-error')
      assert.deepEqual((s.snapshot().thread as any).status, { type: 'systemError', future: true });
    assert.equal(s.snapshot().connected, true);
  }
});

test('native Codex: resume/fork preserve official IDs; active resumes and absent optional sessionId are supported', async (t) => {
  for (const kind of ['resume', 'fork'] as const) {
    for (const mode of ['normal', 'busy-resume', 'no-session-id']) {
      const f = fixture(t, mode, { origin: { kind, source: { harness: 'codex', threadId: 'source-thread' } } });
      const s = await f.create();
      assert.equal((s.snapshot().nativeRef as any).threadId, kind === 'resume' ? 'source-thread' : 'thread-forked');
      assert.equal(f.requests().find((r) => r.method === `thread/${kind}`)!.params.threadId, 'source-thread');
    }
  }
  for (const mode of ['resume-mismatch', 'fork-mismatch', 'workspace-mismatch']) {
    const f = fixture(t, mode, {
      origin: {
        kind: mode === 'fork-mismatch' ? 'fork' : 'resume',
        source: { harness: 'codex', threadId: 'source-thread' },
      },
    });
    await assert.rejects(f.create());
    assert.equal(f.events.filter((e) => e.type === 'binding').length, 0);
  }
});

test('native Codex: read history and loaded list use public methods; read cannot substitute another thread', async (t) => {
  const f = fixture(t),
    s = await f.create();
  const history = (await s.read({ threadId: 'foreign', includeTurns: true })) as any;
  assert.equal(history.thread.id, 'thread-owned');
  assert.equal(history.thread.turns[0].items[0].text, 'stored native answer');
  assert.equal(history.thread.future, true);
  assert.deepEqual(await s.read({ method: 'thread/loaded/list' }), { data: ['thread-owned'], nextCursor: null });
  assert.equal(f.requests().find((r) => r.method === 'thread/read')!.params.threadId, 'thread-owned');
  await assert.rejects(s.read({ method: 'thread/delete' }), /unsupported_codex_read_method/);
});

test('native Codex: steer and interrupt occur only on explicit caller commands with explicit turn IDs', async (t) => {
  const f = fixture(t, 'hold'),
    s = await f.create();
  await s.send({ callId: 'one', text: 'start' });
  await assert.rejects(s.send({ callId: 'bad', text: 'steer', options: { mode: 'steer' } }), /expected_turn_required/);
  await assert.rejects(s.cancel({}), /codex_turn_required/);
  await s.send({
    callId: 'two',
    text: 'steer',
    options: { mode: 'steer', expectedTurnId: 'turn-1', threadId: 'foreign' },
  });
  assert.equal(f.requests().find((r) => r.method === 'turn/steer')!.params.threadId, 'thread-owned');
  assert.equal(results(f.events).length, 0);
  assert.deepEqual(await s.cancel({ nativeTurnId: 'turn-1' }), {});
  await until(() => results(f.events).length === 1);
  assert.equal((results(f.events)[0].payload as any).params.turn.status, 'interrupted');
  await s.close();
  assert.equal(f.requests().filter((r) => r.method === 'turn/interrupt').length, 1);
});

test('native Codex: native active activity does not disconnect or cause HUD busy adjudication', async (t) => {
  for (const mode of ['pre-binding-active', 'unowned-turn', 'unowned-active']) {
    const f = fixture(t, mode),
      s = await f.create();
    await delay(40);
    assert.equal(s.snapshot().connected, true);
    await s.send({ callId: 'call', text: 'explicit new turn' });
    assert.equal(f.requests().filter((r) => r.method === 'turn/start').length, 1);
  }
});

test('native Codex: default configuration is untouched; explicit host settings are forwarded', async (t) => {
  for (const profile of [
    undefined,
    { approvalPolicy: 'on-request' as const },
    { sandbox: 'workspace-write' as const, model: 'synthetic' },
  ]) {
    const f = fixture(t, 'native-effective-settings', { profile }),
      s = await f.create();
    const { cwd, ...options } = f.requests().find((r) => r.method === 'thread/start')!.params;
    assert.equal(typeof cwd, 'string');
    assert.deepEqual(options, profile ?? {});
    assert.equal(s.snapshot().connected, true);
  }
});

test('native Codex: typed request IDs, full payloads and opaque native responses round-trip', async (t) => {
  const decision = { decision: 'acceptForSession', future: { retained: true } };
  const f = fixture(t, 'approvals', { request: async () => ({ result: decision }) }),
    s = await f.create();
  await s.send({ callId: 'call', text: 'synthetic' });
  await until(() => results(f.events).length === 1);
  assert.deepEqual(
    f.nativeRequests.map((r) => r.requestId),
    ['number:7', 'string:7']
  );
  assert.deepEqual(
    f.nativeRequests.map((r) => (r.payload as any).id),
    [7, '7']
  );
  assert.equal((f.nativeRequests[0].payload as any).params.approvalId, 'callback-7');
  assert.deepEqual(
    f.requests().filter((r) => 'result' in r),
    [
      { id: 7, result: decision },
      { id: '7', result: decision },
    ]
  );
});

test('native Codex: command/file/permission/user-input/future/legacy requests retain native shapes', async (t) => {
  for (const mode of ['file-approval', 'permission-request', 'user-input', 'future-request', 'legacy-request']) {
    const response = ['native', 42, null];
    const f = fixture(t, mode, { request: async () => ({ result: response }) }),
      s = await f.create();
    await s.send({ callId: 'call', text: 'synthetic' });
    await until(() => results(f.events).length === 1);
    assert.equal(f.nativeRequests.length, 1);
    assert.deepEqual(f.requests().find((r) => 'result' in r)!.result, response);
    if (mode === 'legacy-request')
      assert.equal((f.nativeRequests[0].payload as any).params.conversationId, 'thread-owned');
  }
});

test('native Codex: native scoped requests cannot cross thread ownership', async (t) => {
  for (const mode of ['request-thread-mismatch', 'legacy-foreign']) {
    const f = fixture(t, mode),
      s = await f.create();
    await s.send({ callId: 'call', text: 'synthetic' });
    await delay(30);
    assert.equal(f.nativeRequests.length, 0);
    assert.equal(f.requests().filter((r) => 'result' in r).length, 0);
    assert.equal(s.snapshot().connected, true);
  }
});

test('native Codex: connection/session requests have no fabricated turn or call correlation', async (t) => {
  for (const mode of ['session-request', 'connection-request']) {
    const f = fixture(t, mode, { request: async () => ({ result: null }) });
    await f.create();
    await until(() => f.requests().some((r) => 'result' in r));
    assert.equal(f.nativeRequests[0].callId, undefined);
    assert.equal(f.requests().find((r) => 'result' in r)!.result, null);
  }
});

test('native Codex: turn completion alone does not invent withdrawal of a native callback', async (t) => {
  let answer!: (v: NativeResponse) => void;
  const f = fixture(t, 'late-approval', {
      request: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    }),
    s = await f.create();
  await s.send({ callId: 'call', text: 'synthetic' });
  await until(() => results(f.events).length === 1);
  assert.equal(f.nativeRequests[0].signal?.aborted, false);
  answer({ result: { decision: 'caller-answer' } });
  await until(() => f.requests().some((r) => 'result' in r));
});

test('native Codex: exact native resolution withdraws only the matching typed callback', async (t) => {
  const answers: ((v: NativeResponse) => void)[] = [];
  const f = fixture(t, 'resolved-exact', { request: () => new Promise((resolve) => answers.push(resolve)) }),
    s = await f.create();
  await s.send({ callId: 'call', text: 'synthetic' });
  await until(() => f.nativeRequests[0]?.signal?.aborted === true);
  assert.equal(f.nativeRequests[1].signal?.aborted, false);
  answers[0]({ result: 'stale' });
  answers[1]({ result: 'current' });
  await until(() => f.requests().some((r) => 'result' in r));
  assert.deepEqual(
    f.requests().filter((r) => 'result' in r),
    [{ id: '7', result: 'current' }]
  );
});

test('native Codex: resolution before ACK withdraws the callback and prevents late reply', async (t) => {
  let answer: ((v: NativeResponse) => void) | undefined;
  const f = fixture(t, 'pre-ack-resolved', {
    request: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  });
  const s = await f.create();
  await s.send({ callId: 'call', text: 'synthetic' });
  await until(() => results(f.events).length >= 1);
  // An already delivered request can be withdrawn; a same-frame withdrawal can suppress delivery.
  assert.ok(f.nativeRequests.every((request) => request.signal?.aborted));
  answer?.({ result: 'late-answer' });
  await delay(20);
  assert.equal(f.requests().filter((r) => 'result' in r).length, 0);
});

test('native Codex: waiting or rejected callbacks do not interrupt, deny, or close native work', async (t) => {
  for (const reject of [false, true]) {
    const f = fixture(t, 'waiting-request', {
      requestTimeoutMs: 100,
      request: () => (reject ? Promise.reject(new Error('caller unavailable')) : new Promise(() => {})),
    });
    const s = await f.create();
    await s.send({ callId: 'call', text: 'synthetic' });
    await until(() => f.nativeRequests.length === 1);
    await delay(180);
    assert.equal(s.snapshot().connected, true);
    assert.equal(f.nativeRequests[0].signal?.aborted, false);
    assert.equal(f.requests().filter((r) => 'result' in r || r.method === 'turn/interrupt').length, 0);
  }
});

test('native Codex: request timeout and RPC rejection do not kill or retry; late ACK is consumed', async (t) => {
  for (const mode of ['silent', 'late-ack', 'rpc-reject']) {
    const f = fixture(t, mode, { requestTimeoutMs: 100 }),
      s = await f.create();
    await assert.rejects(s.send({ callId: 'call', text: 'synthetic' }), AdapterDispatchError);
    await delay(300);
    assert.equal(s.snapshot().connected, true);
    const history = (await s.read()) as any;
    assert.equal(history.thread.id, 'thread-owned');
    assert.equal(f.requests().filter((r) => r.method === 'turn/start').length, 1);
    assert.equal(f.requests().filter((r) => r.method === 'turn/interrupt').length, 0);
  }
});

test('native Codex: process exit and broken framing are facts, not native result adjudication', async (t) => {
  for (const mode of ['exit-after-send', 'malformed', 'oversized', 'invalid-utf8', 'truncated']) {
    const f = fixture(t, mode),
      s = await f.create();
    await assert.rejects(s.send({ callId: 'call', text: 'synthetic' }));
    await until(() => f.events.some((e) => e.type === 'disconnected'));
    if (mode === 'exit-after-send') await until(() => f.events.some((e) => e.type === 'process_exit' && e.code === 7));
    assert.equal(results(f.events).length, 0);
    assert.equal(f.requests().filter((r) => r.method === 'turn/interrupt').length, 0);
  }
});

test('native Codex: stderr is observable and volume does not stop a healthy connection', async (t) => {
  const f = fixture(t, 'stderr-volume'),
    s = await f.create();
  await s.send({ callId: 'call', text: 'synthetic' });
  await until(() => results(f.events).length === 1);
  await until(() => f.events.some((e) => e.type === 'native_event' && e.kind === 'transport/stderr'));
  assert.equal(s.snapshot().connected, true);
});

test('native Codex: close is idempotent connection release, never implicit interrupt or workStopped claim', async (t) => {
  let answer!: (v: NativeResponse) => void;
  const f = fixture(t, 'waiting-request', {
      request: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    }),
    s = await f.create();
  await s.send({ callId: 'call', text: 'synthetic' });
  await until(() => f.nativeRequests.length === 1);
  const first = s.close();
  assert.equal(first, s.close());
  assert.equal(f.nativeRequests[0].signal?.aborted, true);
  answer({ result: { decision: 'stale' } });
  const closed = (await first) as any;
  assert.equal(closed.connectionReleased, true);
  assert.equal('workStopped' in closed, false);
  assert.equal(f.requests().filter((r) => 'result' in r || r.method === 'turn/interrupt').length, 0);
});

test('native Codex: identical request IDs on two connections never share response ownership', async (t) => {
  const answers: ((v: NativeResponse) => void)[] = [];
  const fixtures = [0, 1].map(() =>
    fixture(t, 'waiting-request', { request: () => new Promise((resolve) => answers.push(resolve)) })
  );
  const sessions: ManagedAdapterSession[] = [];
  for (const f of fixtures) {
    const s = await f.create();
    sessions.push(s);
    await s.send({ callId: 'same-call', text: 'synthetic' });
    await until(() => f.nativeRequests.length === 1);
  }
  await sessions[0].close();
  answers[0]({ result: 'stale' });
  answers[1]({ result: 'current' });
  await until(() => fixtures[1].requests().some((r) => 'result' in r));
  assert.equal(fixtures[0].requests().filter((r) => 'result' in r).length, 0);
  assert.deepEqual(
    fixtures[1].requests().filter((r) => 'result' in r),
    [{ id: 'waiting', result: 'current' }]
  );
});

test('native Codex: request withdrawal remains bound to the live callback when IDs are reused', async (t) => {
  const answers: ((v: NativeResponse) => void)[] = [];
  const f = fixture(t, 'reused-resolved-request', { request: () => new Promise((resolve) => answers.push(resolve)) }),
    s = await f.create();
  await s.send({ callId: 'one', text: 'synthetic' });
  await until(() => f.nativeRequests[0]?.signal?.aborted === true);
  await s.send({ callId: 'two', text: 'synthetic' });
  await until(() => answers.length === 2);
  answers[0]({ result: 'stale' });
  answers[1]({ result: 'current' });
  await until(() => f.requests().some((r) => 'result' in r));
  assert.deepEqual(
    f.requests().filter((r) => 'result' in r),
    [{ id: 'reused', result: 'current' }]
  );
});

test('native Codex: a future client version is diagnostic, not an admission rule', async (t) => {
  const f = fixture(t, 'future-version'),
    s = await f.create();
  await s.send({ callId: 'call', text: 'synthetic' });
  await until(() => results(f.events).length === 1);
  assert.equal(s.snapshot().connected, true);
});

test('native Codex: default command discovers installed PATH executable and preserves absolute selection', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hud-native-codex-path-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const executable = join(bin, 'codex');
  const log = join(home, 'requests.jsonl');
  const fake = pathToFileURL(resolve('tests/fakes/managed-codex-server.mjs')).href;
  writeFileSync(
    executable,
    `#!${process.execPath}
if (process.argv[2] !== 'app-server') process.exit(97);
process.argv.splice(2, process.argv.length - 2, 'normal', ${JSON.stringify(log)});
await import(${JSON.stringify(fake)});
`,
    { mode: 0o700 }
  );
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const selected of ['codex', executable]) {
    const factory = new CodexManagedAdapterFactory({
      executable: selected,
      env: { HOME: home, HUD_HOME: join(home, '.hud'), PATH: selected === 'codex' ? bin : '' },
    });
    const session = await factory.create(
      { workspace: home, origin: { kind: 'new' } },
      {
        event: () => {},
        request: async () => ({ result: {} }),
      }
    );
    try {
      assert.equal(session.snapshot().nativeRef?.harness, 'codex');
      assert.equal(session.snapshot().connected, true);
    } finally {
      await session.close();
    }
  }
  assert.equal(
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((request) => request.method === 'thread/start').length,
    2
  );
});

test('native Codex: missing installed command reports not_sent without a binding', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hud-native-codex-missing-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const events: AdapterEvent[] = [];
  for (const executable of ['codex', join(home, 'missing-codex')]) {
    const factory = new CodexManagedAdapterFactory({ executable, env: { HOME: home, PATH: home } });
    await assert.rejects(
      factory.create(
        { workspace: home, origin: { kind: 'new' } },
        {
          event: (event) => events.push(event),
          request: async () => ({ result: {} }),
        }
      ),
      (error: unknown) =>
        error instanceof AdapterDispatchError &&
        error.message === 'codex_executable_unavailable' &&
        error.certainty === 'not_sent'
    );
  }
  assert.deepEqual(events, []);
});

test('native Codex: factory rejects resume/fork alternate locators before any backend action', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hud-codex-locator-factory-'));
  const log = join(home, 'requests.jsonl');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const factory = new CodexManagedAdapterFactory({
    executable: process.execPath,
    args: [resolve('tests/fakes/managed-codex-server.mjs'), 'normal', log],
    env: { HOME: home, CODEX_HOME: join(home, '.codex') },
  });
  const callbacks = {
    event() {},
    async request() {
      return { result: null };
    },
  };
  for (const kind of ['resume', 'fork'] as const) {
    for (const options of [
      { path: join(home, 'private-b.jsonl') },
      { history: [{ type: 'message', role: 'user', content: 'private B history' }] },
      { threadId: 'private-b' },
      { path: null },
      { history: [] },
      { threadId: 'owned-a' },
      { path: join(home, 'private-b.jsonl'), history: [], threadId: 'owned-a' },
    ]) {
      await assert.rejects(
        factory.create(
          { workspace: home, origin: { kind, source: { harness: 'codex', threadId: 'owned-a' } }, options },
          callbacks
        ),
        (error: unknown) =>
          error instanceof AdapterDispatchError &&
          error.code === 'codex_source_locator_options_forbidden' &&
          error.certainty === 'not_sent'
      );
      assert.equal(existsSync(log), false, 'not even initialize may reach the backend');
    }
  }
});

test('native Codex: owning A does not authorize resume/fork path/history overrides through the host', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hud-codex-locator-host-'));
  const log = join(home, 'requests.jsonl');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const owner: NativeOwner = { harness: 'codex', sourceId: 'synthetic-source', sessionId: 'parent', threadId: null };
  const child = { harness: 'codex' as const, threadId: 'owned-a' };
  const relations = new RelationStore(home);
  relations.record({ owner, callId: 'original', child, workspace: home, profileId: 'codex', createdAt: 1 });
  const factory = new CodexManagedAdapterFactory({
    executable: process.execPath,
    args: [resolve('tests/fakes/managed-codex-server.mjs'), 'normal', log],
    env: { HOME: home, CODEX_HOME: join(home, '.codex') },
  });
  const host = new NativeSessionHost(owner, [{ id: 'codex', factory }], relations);
  for (const kind of ['resume', 'fork'] as const) {
    for (const options of [
      { path: join(home, 'private-b.jsonl') },
      { history: [{ type: 'message', role: 'user', content: 'private B history' }] },
      { threadId: 'private-b' },
    ]) {
      await assert.rejects(
        host.create({
          profileId: 'codex',
          callId: `${kind}-override`,
          workspace: home,
          origin: { kind, source: child },
          options,
        }),
        /codex_source_locator_options_forbidden/
      );
      assert.equal(existsSync(log), false, 'owned A relation must not allow any native dispatch toward B');
      assert.deepEqual(
        relations.list(owner).map((relation) => relation.child),
        [child]
      );
    }
  }
  for (const kind of ['resume', 'fork'] as const) {
    const target = (await host.create({
      profileId: 'codex',
      callId: `${kind}-valid`,
      workspace: home,
      origin: { kind, source: child },
      options: { model: 'synthetic-model', approvalPolicy: 'on-request', persistExtendedHistory: true },
    })) as { connectionId: string };
    const request = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((row) => row.method === `thread/${kind}`);
    assert.deepEqual(request.params, {
      cwd: home,
      threadId: 'owned-a',
      model: 'synthetic-model',
      approvalPolicy: 'on-request',
      persistExtendedHistory: true,
    });
    await host.close(target);
  }
});
