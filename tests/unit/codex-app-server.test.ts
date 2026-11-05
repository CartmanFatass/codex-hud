import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppServerObserver } from '../../src/harness/codex/app-server.js';

const wire = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
function initialize(o: CodexAppServerObserver) {
  assert.deepEqual(o.initialize(1, { name: 'synthetic-hud', version: '0.synthetic' }), {
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: 'synthetic-hud', version: '0.synthetic', title: null }, capabilities: null },
  });
  o.push(
    wire({
      id: 1,
      result: { userAgent: 'synthetic', codexHome: '/synthetic/private', platformFamily: 'unix', platformOs: 'linux' },
    })
  );
  assert.deepEqual(o.initialized(), { method: 'initialized' });
}

test('handshake gates start, matches request ID, and never implies provider access', () => {
  const o = new CodexAppServerObserver();
  assert.throws(() => o.threadStart(2), /not_ready/);
  o.initialize(1, { name: 'synthetic-hud', version: '0.synthetic' });
  assert.deepEqual(o.push(wire({ id: '1', result: { userAgent: 'synthetic' } })), [{ kind: 'gap' }]);
  assert.throws(() => o.initialized(), /initialize_state/);
  o.push(wire({ id: 1, result: { userAgent: 'synthetic', codexHome: '/synthetic/private' } }));
  o.initialized();
  assert.throws(() => o.initialize(3, { name: 'x', version: 'y' }), /initialize_state/);
  assert.deepEqual(o.threadStart(2), { id: 2, method: 'thread/start', params: {} });
  assert.ok(!JSON.stringify(o.snapshot()).includes('/synthetic/private'));
});

test('thread start/resume correlates out-of-order IDs without treating notifications as identity', () => {
  const o = new CodexAppServerObserver();
  initialize(o);
  o.threadStart('new');
  o.threadResume(3, 'thread-synthetic');
  assert.deepEqual(o.push(wire({ method: 'thread/started', params: { thread: { id: 'untrusted-notification' } } })), [
    { kind: 'notification', method: 'thread/started' },
  ]);
  assert.equal(o.snapshot().threadId, null);
  o.push(wire({ id: 3, result: { thread: { id: 'thread-synthetic' } } }));
  assert.equal(o.snapshot().threadId, 'thread-synthetic');
  o.push(wire({ id: 'new', result: { thread: { id: 'thread-other' } } }));
  assert.equal(o.snapshot().threadId, 'thread-other');
  assert.equal(o.snapshot().pending, 0);
  assert.throws(() => o.threadStart('new'), /reused_id/);
});

test('resume mismatch, invalid response, duplicate and failure remain bounded observations', () => {
  const o = new CodexAppServerObserver();
  initialize(o);
  o.threadResume(2, 'expected');
  o.push(wire({ id: 2, result: { thread: { id: 'wrong' } } }));
  assert.equal(o.snapshot().threadId, null);
  assert.equal(o.snapshot().pending, 1);
  o.push(wire({ id: 2, error: { code: -32600, message: 'SYNTHETIC_SECRET' } }));
  o.push(wire({ id: 2, result: { thread: { id: 'expected' } } }));
  assert.equal(o.snapshot().errors, 1);
  assert.equal(o.snapshot().gaps, 2);
  assert.ok(!JSON.stringify(o.snapshot()).includes('SYNTHETIC_SECRET'));
});

test('notifications and unsupported server requests never produce approval or response', () => {
  const o = new CodexAppServerObserver();
  initialize(o);
  const events = o.push(
    Buffer.concat([
      wire({ method: 'turn/started', params: { threadId: 'synthetic', turn: { id: 'turn-1' } } }),
      wire({
        method: 'item/commandExecution/requestApproval',
        id: 'server-1',
        params: { command: 'SYNTHETIC_SECRET' },
      }),
      wire({ method: 'future/notification', params: {} }),
    ])
  );
  assert.deepEqual(events, [
    { kind: 'notification', method: 'turn/started' },
    { kind: 'unsupported_request', method: 'item/commandExecution/requestApproval', id: 'server-1' },
    { kind: 'notification', method: 'future/notification' },
  ]);
  assert.equal(o.snapshot().unsupportedRequests, 1);
  assert.equal(o.snapshot().unknownNotifications, 1);
  assert.ok(!JSON.stringify(events).includes('SYNTHETIC_SECRET'));
});

test('split UTF-8 and JSON lines, malformed records and EOF are explicit', () => {
  const o = new CodexAppServerObserver();
  initialize(o);
  o.threadStart(2);
  const bytes = wire({ id: 2, result: { thread: { id: 'thread-中文' } } });
  for (const byte of bytes) o.push(Uint8Array.of(byte));
  assert.equal(o.snapshot().threadId, 'thread-中文');
  o.push(Buffer.from('{"method":'));
  assert.equal(o.finish().gaps, 1);
  assert.throws(() => o.push(Buffer.from('x')), /transport_closed/);
});

test('JSONL exec and rollout records are not app-server responses; transport errors do not manufacture success', () => {
  const o = new CodexAppServerObserver();
  o.push(wire({ type: 'thread.started', thread_id: 'fake' }));
  o.push(wire({ type: 'session_meta', payload: { id: 'fake' } }));
  assert.equal(o.snapshot().threadId, null);
  assert.equal(o.snapshot().gaps, 2);
  assert.equal(o.finish().transport, 'closed');
});

test('oversized and malformed UTF-8 input interrupts or records gaps', () => {
  const a = new CodexAppServerObserver();
  a.push(Buffer.from([0xff, 0x0a]));
  assert.equal(a.snapshot().gaps, 1);
  a.push(Buffer.alloc(65537, 0x61));
  assert.equal(a.snapshot().transport, 'interrupted');
  assert.throws(() => a.push(Buffer.from('x')), /transport_closed/);
});

test('initialization error and unfinished requests do not establish readiness', () => {
  const o = new CodexAppServerObserver();
  o.initialize('init', { name: 'synthetic', version: '1' });
  o.push(wire({ id: 'init', error: { code: -32600, message: 'synthetic' } }));
  assert.equal(o.snapshot().handshake, 'failed');
  assert.throws(() => o.initialized(), /initialize_state/);
  assert.throws(() => o.threadStart(2), /not_ready/);
  const p = new CodexAppServerObserver();
  initialize(p);
  p.threadStart(2);
  assert.equal(p.finish().gaps, 1);
});

test('bounded request history prevents unbounded outstanding state', () => {
  const o = new CodexAppServerObserver();
  initialize(o);
  for (let i = 0; i < 255; i++) o.threadStart(`r${i}`);
  assert.throws(() => o.threadStart('overflow'), /invalid_or_reused_id/);
  assert.equal(o.snapshot().pending, 255);
});
