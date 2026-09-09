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

assert.equal(stripAnsi(renderModelEffortToken('gpt-6-astra', 'medium')), `${MODEL_GLYPHS.astra}${EFFORT_GLYPHS.medium}`);
assert.equal(stripAnsi(renderModelEffortToken('gpt-5.6-sol', 'xhigh')), `${MODEL_GLYPHS.sol}${EFFORT_GLYPHS.xhigh}`);
assert.equal(stripAnsi(renderModelEffortToken('gpt-5.6-terra', 'low')), `${MODEL_GLYPHS.terra}${EFFORT_GLYPHS.low}`);
assert.equal(stripAnsi(renderModelEffortToken('gpt-5.6-luna', 'high')), `${MODEL_GLYPHS.luna}${EFFORT_GLYPHS.high}`);
assert.equal(stripAnsi(renderModelEffortToken('gpt-5.3-codex-spark', 'max')), `${MODEL_GLYPHS.spark}${EFFORT_GLYPHS.max}`);
assert.equal(MODEL_GLYPHS.astra, '☀');
assert.equal(MODEL_GLYPHS.sol, '★');

console.log('test-model-glyphs: PASS');
