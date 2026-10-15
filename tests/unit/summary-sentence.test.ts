import test from 'node:test';
import assert from 'node:assert/strict';
import { summarySentence } from '../../src/utils/summary-sentence.js';

test('model summaries retain only one Chinese or English sentence', () => {
  assert.equal(summarySentence('正在检查缓存。随后验证边界。'), '正在检查缓存。');
  assert.equal(summarySentence('Reading parser tests. Then checking performance.'), 'Reading parser tests.');
  assert.equal(summarySentence('检查完成！仍需复核。'), '检查完成！');
  assert.equal(summarySentence('Testing v1.2 behavior. No result yet.'), 'Testing v1.2 behavior.');
  assert.equal(summarySentence('Reading tests; no result yet'), 'Reading tests; no result yet');
});

test('digest evidence and caveats stay off the card sentence', () => {
  assert.equal(summarySentence('\nSynthetic result is valid\nBasis: unit tests\nCaveats: no benchmark'), 'Synthetic result is valid');
  assert.equal(summarySentence('- Reading tests. Extra work.'), 'Reading tests.');
  assert.equal(summarySentence('1. Checking synthetic evidence. Still running.'), 'Checking synthetic evidence.');
  assert.equal(summarySentence(' \n\t'), '');
});

test('sentence caps count code points, not UTF-16 units', () => {
  assert.equal(summarySentence('证据'.repeat(100), 7), '证据证据证据…');
  assert.equal(summarySentence('🧪'.repeat(8), 4), '🧪🧪🧪…');
  assert.equal(summarySentence('long', 1), '…');
});
