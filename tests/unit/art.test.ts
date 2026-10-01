import test from 'node:test';
import assert from 'node:assert/strict';
import { artSize, renderArt, type ArtBitmap } from '../../src/render/art.js';
import { initialMonitorState, renderMonitor } from '../../src/render/monitor.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import type { SubagentTree } from '../../src/types.js';

/** Left half dark blue, right half white; the bottom quarter transparent. */
function bitmap(width = 80, height = 80): ArtBitmap {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const dark = x < width / 2;
    data.set(dark ? [10, 20, 90, 255] : [250, 250, 250, 255], i);
    if (y >= height * 0.75) data[i + 3] = 0;
  }
  return { width, height, data };
}

test('the art keeps the picture’s proportions and fits the room or stays away', () => {
  const square = bitmap();
  assert.deepEqual(artSize(square, 40, 30), { cols: 40, rows: 20 }, 'a square is twice as many columns as rows');
  assert.deepEqual(artSize(square, 100, 12), { cols: 24, rows: 12 });
  assert.equal(artSize(square, 10, 30), null, 'too narrow to be a picture');
  assert.equal(artSize(square, 40, 5), null, 'too short to be a picture');
  assert.equal(artSize(bitmap(160, 80), 60, 30)!.rows, 15, 'a wide picture is shorter');
});

test('dots fill where the picture is dark, nothing where it is light or transparent', () => {
  const lines = renderArt(bitmap(), 'dots', 20, 10).map(stripAnsi);
  assert.equal(lines.length, 10);
  assert.equal(lines[0], '⣿'.repeat(10), 'dark half solid, light half blank and trimmed');
  assert.equal(lines[9].trim(), '', 'transparent is background');
  assert.ok(lines.every(line => visualLength(line) <= 20));
  const ascii = renderArt(bitmap(), 'ascii', 20, 10).map(stripAnsi);
  assert.equal(ascii[0], '@'.repeat(10));
  assert.equal(ascii[9].trim(), '');
});

test('colour dots take the picture’s colour, lifted until a dark one still shows', () => {
  const line = renderArt(bitmap(), 'color', 20, 10)[0];
  const [r, g, b] = line.match(/38;2;(\d+);(\d+);(\d+)m/)!.slice(1).map(Number);
  assert.ok(b > r && b > g, 'still blue');
  assert.ok(0.2126 * r + 0.7152 * g + 0.0722 * b >= 100, 'bright enough for a dark background');
  const once = bitmap();
  assert.equal(renderArt(once, 'color', 20, 10), renderArt(once, 'color', 20, 10), 'a drawing is made once per size');
});

test('the panel draws the art only on empty lines, centred, clear of the brief and the foot', () => {
  const tree: SubagentTree = { rootId: 'root', nodes: [], totalCount: 0, updatedAt: new Date() };
  const art = (cols: number, rows: number) => {
    const size = artSize(bitmap(), cols, rows);
    return size ? renderArt(bitmap(), 'dots', size.cols, size.rows) : null;
  };
  const frame = renderMonitor({ tree, state: initialMonitorState(), width: 40, height: 30, art, brief: { text: 'one line' } });
  const lines = frame.lines.map(line => stripAnsi(line));
  const first = lines.findIndex(line => line.includes('⣿'));
  assert.ok(first > 0);
  assert.equal(lines[first - 1].trim(), '', 'a blank line above the art');
  assert.equal(lines.at(-2)!.trim(), '', 'never touching the foot');
  assert.ok(lines.some(line => line.includes('one line')), 'the brief is untouched');
  assert.match(lines.at(-1)!, /^, Settings/);
  const indent = lines[first].indexOf('⣿');
  assert.ok(indent > 5, 'centred, not at the left edge');
  assert.ok(frame.lines.every(line => visualLength(line) <= 40));
  const cramped = renderMonitor({ tree, state: initialMonitorState(), width: 40, height: 12, art, brief: { text: 'one line' } });
  assert.ok(!cramped.lines.some(line => stripAnsi(line).includes('⣿')), 'no room: no art');
});
