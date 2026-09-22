/**
 * The two meters.
 *
 * A meter is read at a glance, so two things have to hold whatever the
 * percentage: it occupies exactly the columns it was given, and it never
 * shrinks as the number it reports grows. The eighth-block cell makes the
 * second one easy to get wrong, because the partial cell has to take the
 * place of an empty one rather than be added to the end.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { coloredBar, completionBar, stripAnsi, visualWidth } from '../../src/render/colors.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';

const WIDTHS = [4, 6, 10];
const METERS: Array<[string, (percent: number, width: number) => string]> = [
  ['coloredBar', coloredBar],
  ['completionBar', completionBar],
];

/** Columns that are not the empty cell: whole blocks plus any partial one. */
function filledColumns(bar: string): number {
  return stripAnsi(bar).split('').filter((char) => char !== '░').length;
}

test('a meter is exactly as wide as it was asked to be', () => {
  const previous = setDisplayConfig({ theme: 'terminal' });
  try {
    for (const [name, meter] of METERS) {
      for (const width of WIDTHS) {
        for (let percent = 0; percent <= 100; percent++) {
          assert.equal(
            visualWidth(meter(percent, width)),
            width,
            `${name} at ${percent}% in ${width} columns`
          );
        }
      }
    }
  } finally {
    setDisplayConfig(previous);
  }
});

test('a rising percentage never gives back a filled column', () => {
  const previous = setDisplayConfig({ theme: 'terminal' });
  try {
    for (const [name, meter] of METERS) {
      for (const width of WIDTHS) {
        let last = 0;
        for (let percent = 0; percent <= 100; percent++) {
          const filled = filledColumns(meter(percent, width));
          assert.ok(
            filled >= last,
            `${name} fell from ${last} to ${filled} columns at ${percent}% in ${width} columns`
          );
          assert.ok(filled <= width, `${name} overflowed at ${percent}% in ${width} columns`);
          last = filled;
        }
        assert.equal(filledColumns(meter(0, width)), 0, `${name} shows fill at 0%`);
        assert.equal(filledColumns(meter(100, width)), width, `${name} shows a gap at 100%`);
      }
    }
  } finally {
    setDisplayConfig(previous);
  }
});

test('the partial cell reports the eighths a whole cell would round away', () => {
  const previous = setDisplayConfig({ theme: 'none' });
  try {
    // Half of one cell out of four is 12.5%, which a whole-cell meter cannot
    // distinguish from 0%.
    assert.equal(coloredBar(12.5, 4), '▌░░░');
    assert.equal(coloredBar(25, 4), '█░░░');
    assert.equal(coloredBar(0, 4), '░░░░');
    assert.equal(coloredBar(100, 4), '████');
    assert.equal(completionBar(50, 6), '███░░░');
  } finally {
    setDisplayConfig(previous);
  }
});
