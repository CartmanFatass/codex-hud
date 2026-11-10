import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workCardFrames } from '../fixtures/work-card-p2-frames.js';
import { useDisplayFixture } from '../fixtures/display.js';
useDisplayFixture();
test('P2 final Home/Work/real handoff/Inspector disk-pipeline frames: EN/ZH 44/56/110 colour and no-colour (48)', async (t) => {
  const frames = await workCardFrames(t);
  const expected = JSON.parse(
    fs.readFileSync(new URL('../../../tests/fixtures/work-card-p2-frames.json', import.meta.url), 'utf8')
  ) as Record<string, string>;
  assert.equal(Object.keys(frames).length, 48);
  assert.deepEqual(Object.keys(frames).sort(), Object.keys(expected).sort());
  for (const [key, frame] of Object.entries(frames)) assert.equal(frame, expected[key], key);
});
