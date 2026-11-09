import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { visualLength } from '../../src/render/colors.js';
import { workboardFrames } from '../fixtures/workboard-frames.js';

test('passive Home and transitional Work disk-pipeline frame baselines (25 ordinary P1 fixtures)', async (t) => {
  const frames = await workboardFrames(t);
  assert.equal(Object.keys(frames).length, 25);
  for (const [id, text] of Object.entries(frames)) {
    const width = Number(id.match(/-(44|56|110)(?:-ansi)?$/)![1]);
    for (const line of text.split('\n').slice(0, -1)) assert.equal(visualLength(line), width, id);
    const saved = readFileSync(new URL(`../../../tests/fixtures/workboard-frames/${id}.txt`, import.meta.url), 'utf8');
    assert.equal(text, saved, id);
  }
});
