/**
 * The default look's bar at the widths of a main pane beside the open panel, 144, 120, 100 and 80 columns: the vitals
 * keep their numbers, the worker zone keeps its counts and marks while its words give way, and all three clients' paths fit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BAR_WIDTHS, PI_QUOTA_WIDTHS, widthFrames } from '../fixtures/bar-widths.js';
import { visualWidth } from '../../dist/render/colors.js';
import { setLanguage } from '../../dist/render/i18n.js';

const golden = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/bar-widths.json'), 'utf8'));

test('default look at 144/120/100/80: golden frames, one row that fits, Claude, pi and Codex alike', () => {
  const frames = widthFrames();
  assert.deepEqual(frames, golden);
  for (const width of new Set([...BAR_WIDTHS, ...PI_QUOTA_WIDTHS]))
    for (const [name, rows] of Object.entries(frames[String(width)]!)) {
      assert.equal(rows.length, 1, `${name} at ${width}: one row`);
      assert.ok(visualWidth(rows[0]!) <= width, `${name} at ${width}: fits`);
    }
});

test('pi quota golden rows stay English when the panel language is Chinese', (t) => {
  const previous = setLanguage('zh');
  t.after(() => setLanguage(previous));
  const frames = widthFrames();
  for (const width of PI_QUOTA_WIDTHS)
    for (const [name, rows] of Object.entries(frames[String(width)]!))
      if (name.startsWith('pi-')) assert.deepEqual(rows, golden[width][name]);
});

test('the worker zone gives up its model names, then its effort glyphs, and keeps its counts and marks', () => {
  const frames = widthFrames();
  for (const width of BAR_WIDTHS)
    for (const scene of ['quiet', 'one', 'busy', 'mixed'] as const) {
      const row = frames[String(width)]![scene]![0]!;
      for (const reading of ['opus-5.5', '41%', 'example', '62%'])
        assert.ok(row.includes(reading), `${scene} at ${width}: ${reading}`);
      // Nothing of a job's own words, ever: only marks, a short model, an effort glyph and a count.
      assert.doesNotMatch(row, /frontend|general|sonic|imp\b|BAR-NARROW:/, `${scene} at ${width}`);
    }
  const zone = (width: number, scene: string) => frames[String(width)]![scene]![0]!.split(' │ ').pop()!;
  // Eight running workers, four groups: whole at 144 and 120; the model names go at 100; the effort glyphs at 80. The counts add up to eight.
  for (const width of [144, 120]) assert.match(zone(width, 'busy'), /^◎ sol-fast◕ 3 +! +▲ neon◕ 1 +✻ sonnet● 1 +⚡3$/, `busy at ${width}`);
  assert.match(zone(100, 'busy'), /^◎◕3 +! +▲◕1 +✻●1 +⚡3$/);
  assert.match(zone(80, 'busy'), /^◎3 +! +▲1 +✻1 +⚡3$/);
  // One worker: the same ladder.
  for (const width of [144, 120, 100]) assert.match(zone(width, 'one'), /^◎ sol-fast◕ 1/, `one at ${width}`);
  assert.match(zone(80, 'one'), /^◎◕1$/);
  // The output rate stays while the main pane is 120 columns or more, with or without workers.
  for (const width of [144, 120])
    for (const scene of ['quiet', 'one', 'busy', 'mixed'])
      assert.match(frames[String(width)]![scene]![0]!, /~42\.7 t\/s/);
  // A subagent beside the zone keeps its type down to 80 columns; its title is the first to go.
  assert.match(frames['144']!.mixed![0]!, /◎ sol-fast◕ 3.*◐ Explore Audit bar…$/);
  for (const width of [120, 100, 80]) assert.match(frames[String(width)]!.mixed![0]!, /◐ Explore/, `mixed at ${width}`);
  assert.doesNotMatch(frames['80']!.mixed![0]!, /Audit bar/);
});
