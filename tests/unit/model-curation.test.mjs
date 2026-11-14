import test from 'node:test';
import assert from 'node:assert/strict';
import { curateModels, modelParts } from '../../dist/roles/model-curation.js';
import { MODEL_LISTS } from '../fixtures/project-page.mjs';

// Synthetic ids shaped like what pi lists: versions written 4-5 or 6.1, dated snapshots beside undated ids, a family that ended.
const IDS = MODEL_LISTS.pi;
const INCLUDE = MODEL_LISTS.include;
const names = (groups, provider) => groups.find((g) => g.provider === provider)?.models;

test('modelParts: family, version and date stamp are told apart', () => {
  assert.deepEqual(modelParts('claude-opus-4-5'), { family: 'claude-opus', version: [4, 5], date: '' });
  assert.deepEqual(modelParts('claude-opus-5'), { family: 'claude-opus', version: [5], date: '' });
  assert.deepEqual(modelParts('claude-opus-5-5-20261101'), { family: 'claude-opus', version: [5, 5], date: '20261101' });
  assert.deepEqual(modelParts('claude-opus-5-5-2026-11-01'), { family: 'claude-opus', version: [5, 5], date: '20261101' });
  assert.deepEqual(modelParts('gpt-6.1-sol'), { family: 'gpt-sol', version: [6, 1], date: '' });
  assert.deepEqual(modelParts('gpt-6-sol'), { family: 'gpt-sol', version: [6], date: '' });
  assert.deepEqual(modelParts('deepseek-v4-1-flash-1017'), { family: 'deepseek-flash', version: [4, 1], date: '1017' });
  assert.deepEqual(modelParts('o1'), { family: 'o', version: [1], date: '' });
  assert.deepEqual(modelParts('llama3.1-instruct'), { family: 'llama-instruct', version: [3, 1], date: '' });
  assert.deepEqual(modelParts('Qwen-4-Coder'), { family: 'qwen-coder', version: [4], date: '' });
});

test('curateModels: only the providers and patterns of the include list, the newest model of each family', () => {
  const groups = curateModels(IDS, INCLUDE);
  // Providers in the include list's order; google is not named, so it is not offered.
  assert.deepEqual(groups.map((g) => g.provider), ['arena', 'mistral', 'anthropic', 'openai']);
  // arena: all its models (each family once).
  assert.deepEqual(names(groups, 'arena'), ['arena/gpt-6.1-sol', 'arena/claude-opus-5-5', 'arena/deepseek-v4-1-flash-1017', 'arena/qwen-4-coder']);
  // mistral: deepseek only, and of its two dated lines the later stamp.
  assert.deepEqual(names(groups, 'mistral'), ['mistral/deepseek-v4-1-flash-1017']);
  // anthropic: opus only; 4-5, 4-6, 5 and 5-5 are one family and 5-5 is newest; its dated snapshot loses to the undated id.
  assert.deepEqual(names(groups, 'anthropic'), ['anthropic/claude-opus-5-5']);
  // openai: the gpt-6 series; gpt-6-sol gives way to gpt-6.1-sol, gpt-6-luna to gpt-6.1-luna; gpt-5-mini and o1 never show.
  assert.deepEqual(names(groups, 'openai'), ['openai/gpt-6.1-sol', 'openai/gpt-6.1-luna', 'openai/gpt-6-astra']);
});

test('curateModels: a dated snapshot shows only when no undated id of that version exists, and the later date wins between two', () => {
  const dated = ['anthropic/claude-opus-5', 'anthropic/claude-opus-5-20261001', 'anthropic/claude-opus-6-20270101', 'anthropic/claude-opus-6-20270215'];
  assert.deepEqual(names(curateModels(dated, { anthropic: ['*'] }), 'anthropic'), ['anthropic/claude-opus-6-20270215']);
  assert.deepEqual(names(curateModels(dated.slice(0, 2), { anthropic: ['*'] }), 'anthropic'), ['anthropic/claude-opus-5']);
  assert.deepEqual(names(curateModels(['anthropic/claude-opus-5-20261001', 'anthropic/claude-opus-5-20261201'], { anthropic: ['*'] }), 'anthropic'), ['anthropic/claude-opus-5-20261201']);
  // An undated lower version never beats a dated higher one.
  assert.deepEqual(names(curateModels(['anthropic/claude-opus-5-5', 'anthropic/claude-opus-6-20270101'], { anthropic: ['*'] }), 'anthropic'), ['anthropic/claude-opus-6-20270101']);
});

test('curateModels: a current model is always offered, even when the curation would hide it, in its provider or a new one', () => {
  // gpt-6-sol is superseded by gpt-6.1-sol; the role still runs it, so it stays in the list (in the discovered order).
  const kept = curateModels(IDS, INCLUDE, ['openai/gpt-6-sol']);
  assert.deepEqual(names(kept, 'openai'), ['openai/gpt-6-sol', 'openai/gpt-6.1-sol', 'openai/gpt-6.1-luna', 'openai/gpt-6-astra']);
  // A provider outside the include list shows up for it alone, after the others; so does a model the lists do not know yet.
  const other = curateModels(IDS, INCLUDE, ['google/gemini-4-argon', 'local/just-typed']);
  assert.deepEqual(other.map((g) => g.provider), ['arena', 'mistral', 'anthropic', 'openai', 'google', 'local']);
  assert.deepEqual(names(other, 'google'), ['google/gemini-4-argon']);
  assert.deepEqual(names(other, 'local'), ['local/just-typed']);
  // A model that is already offered is not listed twice.
  assert.deepEqual(names(curateModels(IDS, INCLUDE, ['anthropic/claude-opus-5-5']), 'anthropic'), ['anthropic/claude-opus-5-5']);
});

test('curateModels: all lists every provider (A to Z) with every model; patterns are globs on the name, any case', () => {
  const all = curateModels(IDS, INCLUDE, [], true);
  assert.deepEqual(all.map((g) => g.provider), ['anthropic', 'arena', 'google', 'mistral', 'openai']);
  assert.equal(names(all, 'openai').length, 7);
  assert.ok(names(all, 'openai').includes('openai/o1') && names(all, 'anthropic').includes('anthropic/claude-opus-5-5-20261101'));
  assert.equal(all.flatMap((g) => g.models).length, IDS.length);
  assert.deepEqual(names(curateModels(IDS, { openai: ['GPT-6.?-SOL', '*luna'] }), 'openai'), ['openai/gpt-6.1-sol', 'openai/gpt-6.1-luna']);
  // An empty or unknown include offers nothing (but a current model); nothing listed for a provider is no group.
  assert.deepEqual(curateModels(IDS, {}), []);
  assert.deepEqual(curateModels(IDS, { nobody: ['*'] }), []);
  assert.deepEqual(curateModels([], INCLUDE), []);
  assert.deepEqual(curateModels(IDS, {}, ['arena/qwen-4-coder']).map((g) => [g.provider, g.models]), [['arena', ['arena/qwen-4-coder']]]);
});
