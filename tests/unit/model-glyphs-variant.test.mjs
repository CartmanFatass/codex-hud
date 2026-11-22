import test from 'node:test';
import assert from 'node:assert/strict';
import { versionedModelLabel, workerModelName } from '../../dist/render/model-glyphs.js';
import { lookupModelEntry } from '../../dist/models/catalog.js';

test('the badge keeps a model variant and ignores the provider prefix', () => {
  assert.equal(versionedModelLabel('gpt-6.1-sol'), '6.1sol');
  assert.equal(versionedModelLabel('gpt-6.2-sol-fast'), '6.2sol-fast');
  assert.equal(versionedModelLabel('openai/gpt-6.2-sol-fast'), '6.2sol-fast');
  assert.equal(versionedModelLabel('openai/gpt-6.2-astra'), '6.2astra');
});

test('the worker zone names every catalog model in one word, read from the catalog rather than a second table', () => {
  const names = {
    'gpt-6.2-sol-fast': 'sol-fast',
    'openai/gpt-6.2-sol-fast': 'sol-fast',
    'gpt-6.2-sol': 'sol',
    'gpt-6-astra': 'astra',
    'gpt-6.1-terra': 'terra',
    'gpt-6-luna': 'luna',
    'claude-opus-5-5': 'opus',
    'claude-sonnet-5-5': 'sonnet',
    'claude-fable-5-2': 'fable',
    haiku: 'haiku',
    'gemini-4-hydrogen-high': 'hydrogen',
    'gemini-4-argon-high': 'argon',
    'gemini-3.8-flash-high': 'flash',
    'gemini-4-neon-high': 'neon',
    'gemini-4-carbon-high': 'carbon',
    'deepseek-v4-1-flash-1017': 'ds',
    'zai-glm-5-3': 'glm',
    'mistral-large-4': 'mis',
    'grok-4.7': 'xai',
  };
  for (const [id, name] of Object.entries(names)) assert.equal(workerModelName(id), name, id);
  // neon, carbon and the fast Sol are catalog entries now; an id the catalog and the vendors do not know keeps its short form.
  for (const id of ['gemini-4-neon-high', 'gemini-4-carbon-high', 'gpt-6.2-sol-fast']) assert.ok(lookupModelEntry(id), id);
  assert.equal(workerModelName('custom-2'), 'custom-2');
  assert.equal(workerModelName(undefined), '');
});
