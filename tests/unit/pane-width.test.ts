import test from 'node:test';
import assert from 'node:assert/strict';
import { TreeWidthKeeper } from '../../src/utils/pane-width.js';

function keeper(requested = 0) {
  const window = { width: 120 as number | null };
  const resizes: number[] = [];
  const keep = new TreeWidthKeeper(async () => window.width, async (width) => { resizes.push(width); }, () => requested);
  return { window, resizes, keep };
}

test('an attach at a wider terminal takes the tree back to its policy width', async () => {
  const { window, resizes, keep } = keeper();
  // Launched detached, where the shell reported 120 columns.
  await keep.apply();
  assert.deepEqual(resizes, [24]);
  // The client attaches at 188 and tmux hands the tree half of the growth.
  window.width = 188;
  await keep.follow();
  assert.deepEqual(resizes, [24, 30]);
});

test('a border drag leaves the window width alone, and the pane where it was put', async () => {
  const { resizes, keep } = keeper();
  await keep.apply();
  // Dragging the border, and the resize that follows our own resize-pane,
  // both arrive as a pane resize with the window width unchanged.
  await keep.follow();
  await keep.follow();
  assert.deepEqual(resizes, [24]);
});

test('a saved width applies at once, and follows the window after that', async () => {
  let requested = 0;
  const window = { width: 160 as number | null };
  const resizes: number[] = [];
  const keep = new TreeWidthKeeper(async () => window.width, async (width) => { resizes.push(width); }, () => requested);
  await keep.apply();
  requested = 45;
  await keep.apply();
  window.width = 100;
  await keep.follow();
  assert.deepEqual(resizes, [30, 45, 45]);
  window.width = 80;
  await keep.follow();
  assert.deepEqual(resizes, [30, 45, 45, 39], 'the main session keeps its minimum');
});

test('an unreadable window width changes nothing', async () => {
  const { window, resizes, keep } = keeper();
  window.width = null;
  await keep.apply();
  await keep.follow();
  assert.deepEqual(resizes, []);
  window.width = 120;
  await keep.follow();
  assert.deepEqual(resizes, [24], 'the first readable width is applied');
});
