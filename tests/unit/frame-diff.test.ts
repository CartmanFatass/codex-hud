import test from 'node:test';
import assert from 'node:assert/strict';
import { frameDiff } from '../../src/render/frame-diff.js';

test('clock-only updates write one row instead of the whole nested terminal panel', () => {
  const before = Array.from({ length: 48 }, (_, i) => `row ${i}`.padEnd(48));
  const after = before.slice();
  after[46] = 'Working 2s'.padEnd(48);
  const full = frameDiff(null, after);
  const delta = frameDiff(before, after);
  assert.match(delta, /^\x1b\[47;1H/);
  assert.equal((delta.match(/;1H/g) ?? []).length, 1);
  assert.ok(Buffer.byteLength(delta) < Buffer.byteLength(full) / 20);
  assert.equal(frameDiff(after, after), '');
  assert.equal((frameDiff(null, after).match(/;1H/g) ?? []).length, 48, 'resize invalidates every row');
});

test('shorter rows, removed rows and ANSI styling are erased without scrolling', () => {
  const update = frameDiff(['long text', 'stale row'], ['\x1b[31m短\x1b[0m']);
  assert.equal(update, '\x1b[1;1H\x1b[0m\x1b[31m短\x1b[0m\x1b[0m\x1b[K\x1b[2;1H\x1b[0m\x1b[0m\x1b[K');
  assert.doesNotMatch(update, /[\r\n]/, 'no wrap/scroll from printing a newline at the bottom edge');
});
