import test from 'node:test';
import assert from 'node:assert/strict';
import { fitModelEffortToken, renderModelEffortToken } from '../../src/render/model-glyphs.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { useDisplayFixture } from '../fixtures/display.js';

useDisplayFixture();

test('a model badge is the widest whole form that fits, never a cut one', () => {
  const plain = (max: number, mode: 'text' | 'glyph' | 'both') => stripAnsi(fitModelEffortToken('gpt-6.1-sol', 'xhigh', max, mode));
  // Text: with the effort, then without, then nothing (no glyph where words were asked for).
  assert.equal(plain(20, 'text'), '6.1sol·xhigh');
  assert.equal(plain(8, 'text'), '6.1sol');
  assert.equal(plain(5, 'text'), '');
  // Both: words and glyphs, then the glyphs alone.
  const both = stripAnsi(renderModelEffortToken('gpt-6.1-sol', 'xhigh', { mode: 'both' }));
  assert.equal(plain(visualLength(both), 'both'), both);
  assert.equal(plain(4, 'both'), stripAnsi(renderModelEffortToken('gpt-6.1-sol', 'xhigh', { mode: 'glyph' })));
  assert.equal(plain(1, 'both'), '');
  for (let max = 0; max <= 24; max++) for (const mode of ['text', 'glyph', 'both'] as const) {
    const fitted = plain(max, mode);
    assert.ok(visualLength(fitted) <= max, `${mode} ${max}: ${fitted}`);
    assert.doesNotMatch(fitted, /…/, `${mode} ${max}`);
  }
});
