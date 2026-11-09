import test from 'node:test';
import assert from 'node:assert/strict';
import { createLabPiChannelState } from '../../scripts/workbench/pi-channel-state.mjs';
const frame = (seq, epoch = 'epoch-a') => ({
  seq,
  tool: 'delegate_whoami',
  snapshot: { epoch, toolName: 'delegate_whoami' },
});
const snapshot = { epoch: 'epoch-a', sessionId: 'id', sessionFile: '/tmp/a', sessionDir: '/tmp' };
test('private channel requires serial sequence, same epoch and same session', () => {
  const c = createLabPiChannelState();
  c.admit(frame(1));
  c.pin(snapshot);
  assert.throws(() => c.admit(frame(1)), /invalid_pi_channel_request/);
  c.admit(frame(2));
  assert.throws(() => c.pin({ ...snapshot, sessionId: 'other' }), /retarget/);
  assert.throws(() => c.admit(frame(3)), /channel_closed/);
});
test('shutdown rejects delayed old-epoch frames and new epochs cannot retarget a helper', () => {
  const c = createLabPiChannelState();
  c.admit(frame(1));
  c.shutdown();
  assert.throws(() => c.admit(frame(2)), /channel_closed/);
  const d = createLabPiChannelState();
  d.admit(frame(1));
  assert.throws(() => d.admit(frame(2, 'epoch-b')), /stale_pi_extension_epoch/);
  assert.throws(() => d.admit(frame(2)), /channel_closed/);
});
