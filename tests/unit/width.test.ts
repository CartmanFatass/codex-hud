/**
 * Column-width accounting. Everything the HUD prints is padded or clipped
 * against these helpers, so a wrong answer here overflows a pane.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { visualWidth, truncateAnsi, padEnd, stripAnsi, colors } from '../../src/render/colors.js';

test('CJK and emoji count as two columns, combining marks as zero', () => {
  assert.equal(visualWidth('abc'), 3);
  assert.equal(visualWidth('代码审查'), 8);
  assert.equal(visualWidth('🔥'), 2);
  assert.equal(visualWidth('é'), 1);
  assert.equal(visualWidth(colors.red('abc')), 3);
});

test('truncation never exceeds the budget, even mid wide character', () => {
  for (const text of ['代码审查员在工作', 'plain ascii text here', '🔥🔥🔥🔥🔥', colors.green('绿色') + colors.red('红色')]) {
    for (let width = 1; width <= 12; width++) {
      const clipped = truncateAnsi(text, width);
      assert.ok(
        visualWidth(clipped) <= width,
        `"${stripAnsi(text)}" at width ${width} produced ${visualWidth(clipped)} columns`
      );
    }
  }
});

test('truncation closes the colour it opened', () => {
  const clipped = truncateAnsi(colors.red('代码审查员在工作'), 6);
  assert.ok(clipped.includes('\x1b['), 'expected the colour to survive');
  assert.ok(clipped.endsWith('\x1b[0m'), 'expected a reset at the end');
});

test('padding reaches the requested column count', () => {
  assert.equal(visualWidth(padEnd('代码', 10)), 10);
  assert.equal(visualWidth(padEnd(colors.cyan('ab'), 10)), 10);
  assert.equal(visualWidth(padEnd('already wider than asked', 4)), 24);
});
