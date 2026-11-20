import test from 'node:test';
import assert from 'node:assert/strict';
import { versionedModelLabel } from '../../dist/render/model-glyphs.js';

test('the badge keeps a model variant and ignores the provider prefix', () => {
  assert.equal(versionedModelLabel('gpt-6.1-sol'), '6.1sol');
  assert.equal(versionedModelLabel('gpt-6.2-sol-fast'), '6.2sol-fast');
  assert.equal(versionedModelLabel('openai/gpt-6.2-sol-fast'), '6.2sol-fast');
  assert.equal(versionedModelLabel('openai/gpt-6.2-astra'), '6.2astra');
});
