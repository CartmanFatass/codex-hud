/**
 * The default look's bar at the widths of a main pane beside the open panel, 144, 120, 100 and 80 columns: the vitals
 * keep their numbers, a job's name stays whole while its title gives way, and all three clients' paths fit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BAR_WIDTHS, widthFrames } from '../fixtures/bar-widths.js';
import { visualWidth } from '../../src/render/colors.js';

const golden = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/bar-widths.json'), 'utf8'));

test('default look at 144/120/100/80: golden frames, one row that fits, Claude, pi and Codex alike', () => {
  const frames = widthFrames();
  assert.deepEqual(frames, golden);
  for (const width of BAR_WIDTHS)
    for (const [name, rows] of Object.entries(frames[String(width)]!)) {
      assert.equal(rows.length, 1, `${name} at ${width}: one row`);
      assert.ok(visualWidth(rows[0]!) <= width, `${name} at ${width}: fits`);
    }
});

test('a notice gives up its title before the vitals give up their numbers', () => {
  const frames = widthFrames();
  for (const width of BAR_WIDTHS)
    for (const scene of ['quiet', 'one', 'busy'] as const) {
      const row = frames[String(width)]![scene]![0]!;
      for (const reading of ['opus-5.5', '41%', 'example', '62%'])
        assert.ok(row.includes(reading), `${scene} at ${width}: ${reading}`);
      if (scene === 'one' || (scene === 'busy' && width >= 100))
        assert.match(row, /\[✓●\] frontend-implementer/, `${scene} at ${width}: the job stays whole`);
    }
  // The output rate stays while the main pane is 120 columns or more, with or without notices.
  for (const width of [144, 120])
    for (const scene of ['quiet', 'one', 'busy']) assert.match(frames[String(width)]![scene]![0]!, /~42\.7 t\/s/);
  // Two jobs show as two items down to 100 columns; at 80 the newest stays and the title is cut at a word.
  assert.match(frames['100']!.busy![0]!, /◐ Explore .*\[✓●\] frontend-implementer/);
  assert.doesNotMatch(frames['80']!.busy![0]!, /frontend-implementer/);
});
