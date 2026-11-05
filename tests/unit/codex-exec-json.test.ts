import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CodexExecJsonReader } from '../../src/harness/codex/exec-json.js';
const fixture = readFileSync('tests/fixtures/codex-exec/completed.jsonl');
const row = (e: unknown) => Buffer.from(JSON.stringify(e) + '\n');
function started() {
  const r = new CodexExecJsonReader();
  r.push(row({ type: 'thread.started', thread_id: 't' }));
  r.push(row({ type: 'turn.started' }));
  return r;
}
test('official exec fixture, arbitrary byte chunking including split UTF-8, no raw bodies retained', () => {
  for (const size of [1, 7, fixture.length]) {
    const r = new CodexExecJsonReader();
    for (let i = 0; i < fixture.length; i += size) r.push(fixture.subarray(i, i + size));
    assert.equal(r.snapshot().complete, false);
    const s = r.finish({ code: 0 });
    assert.equal(s.complete, true);
    assert.equal(s.itemEvents, 4);
    assert.deepEqual(s.usage, { input: 20, cachedInput: 5, output: 7 });
    assert.ok(!JSON.stringify(s).includes('Synthetic response'));
  }
});
test('partial last line waits; valid EOF without newline accepted; truncated JSON is incomplete', () => {
  const r = new CodexExecJsonReader();
  r.push(fixture.subarray(0, 10));
  assert.equal(r.snapshot().threadId, null);
  r.push(fixture.subarray(10, fixture.length - 1));
  assert.equal(r.finish({ code: 0 }).complete, true);
  const t = new CodexExecJsonReader();
  t.push(fixture.subarray(0, fixture.length - 8));
  assert.equal(t.finish({ code: 0 }).malformed, 1);
});
test('turn failure, fatal stream error, nonzero exit and signal never become successful completion', () => {
  const r = started();
  r.push(row({ type: 'turn.failed', error: { message: 'private error' } }));
  assert.equal(r.finish({ code: 1 }).turn, 'failed');
  const f = started();
  f.push(row({ type: 'error', message: 'private fatal' }));
  assert.equal(f.finish({ code: 0 }).complete, false);
  for (const exit of [{ code: 1 }, { code: null, signal: 'SIGINT' }]) {
    const x = new CodexExecJsonReader();
    x.push(fixture);
    const s = x.finish(exit);
    assert.equal(s.turn, 'completed');
    assert.equal(s.complete, false);
    assert.equal(s.transport, 'interrupted');
  }
  assert.equal(started().finish({ code: 0 }).complete, false);
});
test('unknown future events are counted, not treated as app-server or success', () => {
  const r = new CodexExecJsonReader();
  r.push(fixture);
  r.push(row({ type: 'future.event' }));
  assert.equal(r.finish({ code: 0 }).unknownEvents, 1);
  assert.equal(r.snapshot().complete, false);
  const rpc = new CodexExecJsonReader();
  rpc.push(row({ jsonrpc: '2.0', method: 'thread/started' }));
  assert.equal(rpc.finish({ code: 0 }).malformed, 1);
});
test('resume validates expected thread but never creates identity authority or inherits prior turn completion', () => {
  const r = new CodexExecJsonReader('synthetic-thread-1');
  r.push(fixture);
  assert.equal(r.finish({ code: 0 }).complete, true);
  const mismatch = new CodexExecJsonReader('other-thread');
  mismatch.push(fixture);
  assert.equal(mismatch.finish({ code: 0 }).complete, false);
  assert.equal(new CodexExecJsonReader('synthetic-thread-1').finish({ code: 0 }).complete, false);
});
test('malformed ordering, invalid UTF-8, bounds and post-close input fail closed', () => {
  const r = new CodexExecJsonReader();
  r.push(row({ type: 'turn.started' }));
  assert.equal(r.finish({ code: 0 }).malformed, 1);
  assert.throws(() => r.push(Buffer.from('x')));
  const utf = new CodexExecJsonReader();
  utf.push(Buffer.from([255, 10]));
  assert.equal(utf.finish({ code: 0 }).malformed, 1);
  const big = new CodexExecJsonReader();
  big.push(Buffer.alloc(65537, 32));
  assert.equal(big.finish({ code: 0 }).complete, false);
  const total = new CodexExecJsonReader();
  total.push(Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.equal(total.finish({ code: 0 }).transport, 'interrupted');
});

test('transport termination is latched and snapshots are independent', () => {
  const r = new CodexExecJsonReader();
  r.push(fixture);
  const s = r.finish({ code: 1 });
  s.transport = 'closed';
  assert.equal(r.finish({ code: 0 }).transport, 'interrupted');
  assert.equal(r.snapshot().complete, false);
});
