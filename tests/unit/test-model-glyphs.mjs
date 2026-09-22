import assert from 'node:assert/strict';
import { stripAnsi } from '../../dist/render/colors.js';
import {
  classifyModelFamily,
  renderModelEffortToken,
  MODEL_GLYPHS,
  EFFORT_GLYPHS,
} from '../../dist/render/model-glyphs.js';

assert.equal(classifyModelFamily('gpt-6-astra'), 'astra');
assert.equal(classifyModelFamily('gpt-5.6-sol'), 'sol');
assert.equal(classifyModelFamily('gpt-5.6-terra'), 'terra');
assert.equal(classifyModelFamily('gpt-5.6-luna'), 'luna');
assert.equal(classifyModelFamily('gpt-5.3-codex-spark'), 'spark');
assert.equal(classifyModelFamily('gpt-5.4'), null);

// `glyph` is the symbol alone. The default is `both`, which puts the family's
// name beside it for anyone who has not learned the symbols yet, so the mode
// has to be asked for rather than assumed.
const glyph = (model, effort) => stripAnsi(renderModelEffortToken(model, effort, { mode: 'glyph' }));
assert.equal(glyph('gpt-6-astra', 'medium'), `${MODEL_GLYPHS.astra}${EFFORT_GLYPHS.medium}`);
assert.equal(glyph('gpt-5.6-sol', 'xhigh'), `${MODEL_GLYPHS.sol}${EFFORT_GLYPHS.xhigh}`);
assert.equal(glyph('gpt-5.6-terra', 'low'), `${MODEL_GLYPHS.terra}${EFFORT_GLYPHS.low}`);
assert.equal(glyph('gpt-5.6-luna', 'high'), `${MODEL_GLYPHS.luna}${EFFORT_GLYPHS.high}`);
assert.equal(glyph('gpt-5.3-codex-spark', 'max'), `${MODEL_GLYPHS.spark}${EFFORT_GLYPHS.max}`);
assert.equal(MODEL_GLYPHS.astra, '☀');
assert.equal(MODEL_GLYPHS.sol, '★');

// The other two modes, so the default is pinned rather than merely avoided.
assert.equal(
  stripAnsi(renderModelEffortToken('gpt-6-astra', 'medium', { mode: 'both' })),
  `${MODEL_GLYPHS.astra}${EFFORT_GLYPHS.medium} Astra`
);
assert.equal(stripAnsi(renderModelEffortToken('gpt-6-astra', 'medium')),
  stripAnsi(renderModelEffortToken('gpt-6-astra', 'medium', { mode: 'both' })),
  'both is the default');
assert.equal(stripAnsi(renderModelEffortToken('gpt-6-astra', 'medium', { mode: 'text' })), 'Astra·medium');

// An unrecognised model keeps its own name rather than being filed under a
// family it does not belong to, in every mode.
assert.equal(stripAnsi(renderModelEffortToken('gpt-5.4', 'high', { mode: 'glyph' })), `5.4 ${EFFORT_GLYPHS.high}`);
assert.equal(stripAnsi(renderModelEffortToken(undefined, undefined, { mode: 'glyph' })), '');

console.log('test-model-glyphs: PASS');
