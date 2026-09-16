import test from 'node:test';
import assert from 'node:assert/strict';
import { tmuxFocusPaneArgs, tmuxForwardKeyArgs } from '../../src/utils/hud-input.js';

test('forwards printable keys without chaining select-pane in the same tmux argv', () => {
  assert.deepEqual(tmuxForwardKeyArgs('%1', Buffer.from('a')), [
    'send-keys', '-t', '%1', '-H', '61',
  ]);
  assert.deepEqual(tmuxFocusPaneArgs('%1'), ['select-pane', '-t', '%1']);
});

test('forwards Ctrl+C and Ctrl+T so Codex shortcuts survive HUD focus', () => {
  assert.deepEqual(tmuxForwardKeyArgs('%2', Buffer.from('\x03')), [
    'send-keys', '-t', '%2', '-H', '03',
  ]);
  assert.deepEqual(tmuxForwardKeyArgs('%2', Buffer.from('\x14')), [
    'send-keys', '-t', '%2', '-H', '14',
  ]);
});

test('forwards arrows but drops application mouse reports', () => {
  assert.ok(tmuxForwardKeyArgs('%1', Buffer.from('\x1b[A')));
  assert.equal(tmuxForwardKeyArgs('%1', Buffer.from('\x1b[<0;1;1M')), null);
  assert.equal(tmuxForwardKeyArgs('%1', Buffer.from('\x1b[M #!')), null);
  assert.equal(tmuxForwardKeyArgs('', Buffer.from('a')), null);
});
