import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createPiAdapterFactory, type PiRpcOptions } from '../../src/harness/pi/rpc-adapter.js';
import type { PiRpcClient, PiRpcRecord, PiTransportEvent } from '../../src/harness/pi/native-rpc-transport.js';
import type { AdapterEvent, NativeRequest, NativeResponse } from '../../src/managed/types.js';
import { NativeSessionHost } from '../../src/managed/host.js';
import { RelationStore } from '../../src/managed/relations.js';

class Peer implements PiRpcClient {
  listeners = new Set<(event: PiTransportEvent) => void>();
  commands: { type: string; fields: Record<string, unknown> }[] = [];
  responses: { id: string; fields: Record<string, unknown> }[] = [];
  closes = 0;
  state = {
    sessionId: 'synthetic',
    sessionFile: '/synthetic/session.jsonl',
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
    extraNativeField: 42,
  };
  disposition = 'started';
  cancelled = false;
  async start() {}
  async close() {
    this.closes++;
    return { stdinEnded: true };
  }
  onEvent(listener: (event: PiTransportEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(record: PiRpcRecord) {
    for (const listener of this.listeners) listener({ type: 'record', record });
  }
  async respond(id: string, fields: Record<string, unknown>) {
    this.responses.push({ id, fields });
  }
  async request(type: string, fields: Record<string, unknown> = {}): Promise<PiRpcRecord> {
    this.commands.push({ type, fields });
    let data: unknown;
    if (type === 'get_state') data = { ...this.state };
    if (type === 'get_entries')
      data = {
        entries: [{ id: 'native-entry-2', type: 'message', message: { role: 'assistant', content: [] } }],
        leafId: 'native-entry-2',
      };
    if (type === 'switch_session') {
      if (!this.cancelled) this.state = { ...this.state, sessionId: 'source', sessionFile: String(fields.sessionPath) };
      data = { cancelled: this.cancelled };
    }
    if (type === 'clone') {
      this.state = { ...this.state, sessionId: 'clone', sessionFile: '/synthetic/clone.jsonl' };
      data = { cancelled: false };
    }
    if (['prompt', 'steer', 'follow_up'].includes(type)) data = { disposition: this.disposition };
    return {
      type: 'response',
      command: type,
      id: `response-${this.commands.length}`,
      success: true,
      ...(data === undefined ? {} : { data }),
    };
  }
}
function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'hud-pi-native-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const peer = new Peer();
  const events: AdapterEvent[] = [];
  const requests: NativeRequest[] = [];
  let launch: PiRpcOptions | undefined;
  let answer: (request: NativeRequest) => Promise<NativeResponse> = async () => ({ result: { confirmed: true } });
  const factory = createPiAdapterFactory({
    sessionDirectory: join(home, 'sessions'),
    env: { HOME: home, HUD_HOME: join(home, 'hud'), HUD_CUSTOM_DISPLAY: 'keep' },
    rpcClientFactory: (options) => {
      launch = options;
      return peer;
    },
  });
  const create = (origin: Parameters<typeof factory.create>[0]['origin'] = { kind: 'new' }) =>
    factory.create(
      { workspace: home, origin },
      {
        event: (event) => events.push(event),
        request: (request) => {
          requests.push(request);
          return answer(request);
        },
      }
    );
  return {
    peer,
    events,
    requests,
    create,
    home,
    get launch() {
      return launch!;
    },
    setAnswer(fn: typeof answer) {
      answer = fn;
    },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('Pi uses native configuration, preserves unknown state fields and accepts busy native state', async (t) => {
  const f = fixture(t);
  f.peer.state.isStreaming = true;
  f.peer.state.pendingMessageCount = 3;
  const session = await f.create();
  assert.equal(f.launch.cliPath, undefined); // Default is executable pi, not package rpc-entry.
  assert.deepEqual(f.launch.args, ['--session-dir', join(f.home, 'sessions')]);
  assert.equal(f.launch.env?.HUD_CUSTOM_DISPLAY, 'keep');
  assert.deepEqual(session.snapshot().state, f.peer.state);
  assert.deepEqual(((await session.read()) as PiRpcRecord).data, f.peer.state);
  assert.equal(f.peer.closes, 0);
});

test('Pi prompt, steering and follow-up return raw receipts without exclusive operation policy', async (t) => {
  const f = fixture(t);
  const session = await f.create();
  for (const disposition of ['started', 'queued', 'handled']) {
    f.peer.disposition = disposition;
    const receipt = await session.send({
      callId: disposition,
      text: '/native-command',
      options: { streamingBehavior: 'followUp' },
    });
    assert.equal((receipt.payload as PiRpcRecord).command, 'prompt');
    assert.deepEqual((receipt.payload as PiRpcRecord).data, { disposition });
  }
  await session.send({ callId: 'steer', text: 'Native steering', options: { method: 'steer' } });
  await session.send({ callId: 'follow-up', text: 'Native follow-up', options: { method: 'follow_up', images: [] } });
  assert.deepEqual(f.peer.commands.slice(-2), [
    { type: 'steer', fields: { message: 'Native steering' } },
    { type: 'follow_up', fields: { message: 'Native follow-up', images: [] } },
  ]);
  assert.equal(f.peer.closes, 0);
});

test('Pi only agent_settled is a native result, with no text or task success inference', async (t) => {
  const f = fixture(t);
  await f.create();
  f.peer.emit({ type: 'agent_start' }); // Independent extension activity is not a disconnect.
  f.peer.emit({ type: 'agent_end', messages: [], willRetry: false });
  assert.equal(f.events.filter((event) => event.type === 'native_result').length, 0);
  const settled = { type: 'agent_settled', aborted: true, newNativeField: 'preserved' };
  f.peer.emit(settled);
  assert.deepEqual(f.events.at(-1), { type: 'native_result', kind: 'pi.agent_settled', payload: settled });
  assert.equal(f.peer.closes, 0);
});

test('Pi get_entries forwards the durable native cursor and original entries', async (t) => {
  const f = fixture(t);
  const session = await f.create();
  const history = (await session.read({ method: 'get_entries', since: 'native-entry-1' })) as PiRpcRecord;
  assert.deepEqual(f.peer.commands.at(-1), { type: 'get_entries', fields: { since: 'native-entry-1' } });
  assert.deepEqual(history.data, {
    entries: [{ id: 'native-entry-2', type: 'message', message: { role: 'assistant', content: [] } }],
    leafId: 'native-entry-2',
  });
});

test('Pi resumes through switch_session and forks only through explicit clone', async (t) => {
  for (const kind of ['resume', 'fork'] as const) {
    const f = fixture(t);
    const session = await f.create({
      kind,
      source: { harness: 'pi', sessionId: 'source', sessionFile: '/synthetic/source.jsonl' },
    });
    assert.equal(
      (session.snapshot().nativeRef as { sessionId: string }).sessionId,
      kind === 'resume' ? 'source' : 'clone'
    );
    assert.deepEqual(f.peer.commands[1], {
      type: 'switch_session',
      fields: { sessionPath: '/synthetic/source.jsonl' },
    });
    assert.equal(
      f.peer.commands.some(({ type }) => type === 'clone'),
      kind === 'fork'
    );
  }
});

test('Pi cancelled switch is not silently replaced by another session', async (t) => {
  const f = fixture(t);
  f.peer.cancelled = true;
  await assert.rejects(
    f.create({
      kind: 'resume',
      source: { harness: 'pi', sessionId: 'source', sessionFile: '/synthetic/source.jsonl' },
    }),
    /pi_session_switch_cancelled/
  );
  assert.equal(
    f.peer.commands.some(({ type }) => type === 'prompt'),
    false
  );
});

test('Pi UI dialogs retain original IDs and raw response fields; notifications require no answer', async (t) => {
  const f = fixture(t);
  await f.create();
  f.setAnswer(async () => ({ result: { confirmed: false, extensionField: 'native' } }));
  for (const method of ['select', 'confirm', 'input', 'editor']) {
    f.peer.emit({ type: 'extension_ui_request', id: `original-${method}`, method, timeout: 1234 });
  }
  f.peer.emit({ type: 'extension_ui_request', id: 'notice', method: 'notify', message: 'Native notice' });
  await tick();
  assert.equal(f.requests.length, 4);
  assert.deepEqual(
    f.peer.responses.map(({ id }) => id),
    ['original-select', 'original-confirm', 'original-input', 'original-editor']
  );
  assert.deepEqual(f.peer.responses[1].fields, { confirmed: false, extensionField: 'native' });
  assert.equal(f.requests[0].requestId, 'original-select');
  assert.equal(f.requests[0].responseUnsupportedReason, undefined);
  assert.equal(f.events.at(-1)?.type, 'native_event');
});

test('Pi callback failure reports only a response error, never an invented approval or stop', async (t) => {
  const f = fixture(t);
  await f.create();
  f.setAnswer(async () => {
    throw new Error('Caller unavailable');
  });
  f.peer.emit({ type: 'extension_ui_request', id: 'dialog', method: 'confirm' });
  await tick();
  assert.deepEqual(f.peer.responses, []);
  assert.equal(f.peer.closes, 0);
  assert.equal(f.events.at(-1)?.type, 'native_event');
});

test('Pi explicit cancel is abort only; close is connection EOF only', async (t) => {
  const f = fixture(t);
  const session = await f.create();
  await session.cancel({});
  assert.equal(f.peer.commands.at(-1)?.type, 'abort');
  assert.equal(f.peer.closes, 0);
  await session.close();
  assert.equal(f.peer.closes, 1);
  assert.equal(f.peer.commands.filter(({ type }) => type === 'abort').length, 1);
});

test('Pi actual disconnect and process exit are separate facts, not automatic close', async (t) => {
  const f = fixture(t);
  await f.create();
  for (const listener of f.peer.listeners) listener({ type: 'disconnected', reason: 'pi_stdout_eof' });
  for (const listener of f.peer.listeners) listener({ type: 'process_exit', code: 2, signal: null });
  assert.deepEqual(f.events.slice(-2), [
    { type: 'disconnected', reason: 'pi_stdout_eof' },
    { type: 'process_exit', code: 2, signal: null },
  ]);
  assert.equal(f.peer.closes, 0);
});

test('Pi observations past the former 30-minute deadline neither stop nor disconnect', async (t) => {
  const f = fixture(t);
  const session = await f.create();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await session.send({ callId: 'long-native-work', text: 'Synthetic long work' });
  t.mock.timers.tick(31 * 60_000);
  assert.equal(f.peer.closes, 0);
  assert.equal(
    f.events.some((event) => event.type === 'disconnected'),
    false
  );
  assert.equal(
    f.peer.commands.some(({ type }) => type === 'abort'),
    false
  );
  f.peer.emit({ type: 'agent_settled', aborted: false });
  assert.equal(f.events.at(-1)?.type, 'native_result');
});

test('Pi explicit native dialog timeout clears managed_requests without answer, abort or backend stop', async (t) => {
  const f = fixture(t);
  const factory = createPiAdapterFactory({ env: { HOME: f.home }, rpcClientFactory: () => f.peer });
  const host = new NativeSessionHost(
    { harness: 'pi', sourceId: 'synthetic-source', sessionId: 'synthetic-parent', threadId: null },
    [{ id: 'pi-native', factory }],
    new RelationStore(f.home)
  );
  const target = (await host.create({
    profileId: 'pi-native',
    callId: 'create',
    workspace: f.home,
    origin: { kind: 'new' },
  })) as { connectionId: string };
  const observed: AdapterEvent[] = [];
  host.subscribe((message) => {
    if (message.event) observed.push(message.event);
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.peer.emit({ type: 'extension_ui_request', id: 'native-expiring', method: 'confirm', timeout: 100 });
  assert.equal((host.requests(target) as unknown[]).length, 1);
  t.mock.timers.tick(99);
  assert.equal((host.requests(target) as unknown[]).length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(host.requests(target), []);
  assert.throws(() => host.respond(target, 'native-expiring', { confirmed: true }), /native_request_not_pending/);
  await tick();
  assert.deepEqual(f.peer.responses, []);
  assert.equal(f.peer.closes, 0);
  assert.equal(
    f.peer.commands.some(({ type }) => type === 'abort'),
    false
  );
  assert.deepEqual(observed.at(-1), {
    type: 'native_event',
    kind: 'pi.extension_ui_expired',
    payload: { requestId: 'native-expiring', timeout: 100, source: 'native_request_timeout' },
  });
  assert.equal(((await host.read(target)) as PiRpcRecord).success, true);
});

test('Pi late callback cannot send an answer after native timeout; no timeout is invented when omitted', async (t) => {
  const f = fixture(t);
  await f.create();
  let answer!: (value: NativeResponse) => void;
  f.setAnswer(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      })
  );
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.peer.emit({ type: 'extension_ui_request', id: 'expiring', method: 'input', timeout: 50 });
  t.mock.timers.tick(50);
  assert.equal(f.requests[0].signal?.aborted, true);
  answer({ result: { value: 'Too late' } });
  await tick();
  assert.deepEqual(f.peer.responses, []);
  f.peer.emit({ type: 'extension_ui_request', id: 'untimed', method: 'input' });
  t.mock.timers.tick(31 * 60_000);
  assert.equal(f.requests[1].signal?.aborted, false);
  answer({ result: { value: 'Native answer' } });
  await tick();
  assert.deepEqual(f.peer.responses, [{ id: 'untimed', fields: { value: 'Native answer' } }]);
  assert.deepEqual(f.events.at(-1), {
    type: 'native_event',
    kind: 'pi.extension_ui_response_sent',
    payload: { requestId: 'untimed', wireSent: true, nativeAcknowledged: false },
  });
  assert.equal(f.peer.closes, 0);
});

test('Pi response clears native timeout observation and wire send is never called native ACK', async (t) => {
  const f = fixture(t);
  await f.create();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.peer.emit({ type: 'extension_ui_request', id: 'answered', method: 'confirm', timeout: 50 });
  await tick();
  t.mock.timers.tick(100);
  assert.equal(f.requests[0].signal?.aborted, false);
  assert.deepEqual(f.events.at(-1), {
    type: 'native_event',
    kind: 'pi.extension_ui_response_sent',
    payload: { requestId: 'answered', wireSent: true, nativeAcknowledged: false },
  });
  assert.equal(
    f.events.some((event) => 'kind' in event && event.kind === 'pi.extension_ui_expired'),
    false
  );
});
