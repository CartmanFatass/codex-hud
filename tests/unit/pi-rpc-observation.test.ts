import test from 'node:test';
import assert from 'node:assert/strict';
import { PiRpcObserver, PI_RPC_LEGACY, PI_RPC_SETTLED } from '../../src/harness/pi/rpc-observation.js';
const start = { type: 'agent_start' };
const end = { type: 'agent_end', messages: [] };
const settled = { type: 'agent_settled', aborted: false };
test('legacy run end is visible but never promises quiescence; bounded idle observation', () => {
  const r = new PiRpcObserver(PI_RPC_LEGACY, 0, 100);
  r.observe(start, 1);
  assert.equal(r.observe(end, 2).state, 'run_ended');
  assert.equal(r.snapshot().quiescence, 'unknown');
  assert.equal(r.tick(100).stopped, 'deadline');
  assert.equal(r.observe(settled, 101).quiescence, 'unknown');
});
test('modern end can be followed by retry and compaction; only settled reports no automatic work', () => {
  const r = new PiRpcObserver(PI_RPC_SETTLED, 0);
  r.observe(start, 1);
  r.observe(end, 2);
  assert.equal(r.snapshot().quiescence, 'unknown');
  r.observe({ type: 'auto_retry_start', attempt: 1 }, 3);
  r.observe({ type: 'auto_retry_end', success: true }, 4);
  r.observe({ type: 'compaction_start', reason: 'overflow' }, 5);
  r.observe({ type: 'compaction_end', aborted: false, willRetry: true }, 6);
  assert.equal(r.snapshot().quiescence, 'unknown');
  r.observe(start, 7);
  r.observe(end, 8);
  const s = r.observe(settled, 9);
  assert.equal(s.quiescence, 'reported');
  assert.equal(s.endedRuns, 2);
  assert.equal(r.observe(start, 10).quiescence, 'unknown');
});
test('unknown schema never trusts agent_settled and stops at deadline', () => {
  const r = new PiRpcObserver('unrecognized-version', 0, 10);
  r.observe(start, 1);
  r.observe(end, 2);
  r.observe(settled, 3);
  assert.equal(r.snapshot().unknownEvents, 1);
  assert.equal(r.snapshot().quiescence, 'unknown');
  assert.equal(r.tick(10).stopped, 'deadline');
});
test('handled prompt response is correlated and only accepted on modern schema', () => {
  for (const commit of [PI_RPC_LEGACY, PI_RPC_SETTLED]) {
    const r = new PiRpcObserver(commit, 0);
    r.observe({ type: 'response', id: 'other', command: 'prompt', success: true, data: { disposition: 'handled' } }, 1);
    assert.equal(r.snapshot().state, 'waiting');
    const s = r.observe(
      { type: 'response', id: 'prompt-1', command: 'prompt', success: true, data: { disposition: 'handled' } },
      2
    );
    assert.equal(s.state, commit === PI_RPC_SETTLED ? 'no_run' : 'waiting');
    assert.equal(s.quiescence, 'unknown');
  }
});
test('abort, failure and transport close do not become task success or synthetic settled', () => {
  const r = new PiRpcObserver(PI_RPC_SETTLED, 0);
  r.observe(start, 1);
  assert.equal(r.observe({ ...settled, aborted: true }, 2).state, 'aborted');
  const e = new PiRpcObserver(PI_RPC_SETTLED, 0);
  e.observe({ type: 'response', id: 'prompt-1', command: 'prompt', success: false, error: 'private' }, 1);
  assert.equal(e.close().commandFailed, true);
  assert.equal(e.snapshot().quiescence, 'unknown');
  assert.ok(!JSON.stringify(e.snapshot()).includes('private'));
});
test('unknown/malformed events, maximum event count and detached snapshots', () => {
  const r = new PiRpcObserver(PI_RPC_SETTLED, 0);
  r.observe(null, 1);
  r.observe({ type: 'new_future_event' }, 2);
  assert.equal(r.snapshot().malformed, 1);
  for (let i = 0; i < 2000; i++) r.observe({ type: 'message_update' }, 3);
  assert.equal(r.snapshot().stopped, 'limit');
  const s = r.snapshot();
  s.state = 'settled';
  assert.notEqual(r.snapshot().state, 'settled');
  assert.throws(() => r.tick(NaN));
});
