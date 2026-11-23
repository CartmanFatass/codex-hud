/**
 * The default look's bar at the widths of a main pane beside the open panel, 144, 120, 100 and 80 columns: the vitals
 * keep their numbers, the machine counts are the same at each, and all three clients' paths fit.
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

test('machine counts keep the same form at normal widths, without exposing job metadata', () => {
  const frames = widthFrames();
  for (const width of BAR_WIDTHS)
    for (const scene of ['quiet', 'one', 'busy', 'mixed'] as const) {
      const row = frames[String(width)]![scene]![0]!;
      for (const reading of ['opus-5.5', '41%', 'example', '62%'])
        assert.ok(row.includes(reading), `${scene} at ${width}: ${reading}`);
      // Nothing of a job's own words, ever: only machine counts.
      assert.doesNotMatch(row, /frontend|general|sonic|imp\b|sol-fast|neon|BAR-NARROW:/, `${scene} at ${width}`);
    }
  const zone = (width: number, scene: string) => frames[String(width)]![scene]![0]!.split(' │ ').pop()!;
  for (const width of BAR_WIDTHS) {
    assert.match(zone(width, 'busy'), /^HUD \(OS\): 8 running, 2 queued/, `busy at ${width}`);
    assert.match(zone(width, 'one'), /^HUD \(OS\): 1 running, 0 queued/, `one at ${width}`);
  }
  // The output rate stays while the main pane is 120 columns or more, with or without workers.
  for (const width of [144, 120])
    for (const scene of ['quiet', 'one', 'busy', 'mixed'])
      assert.match(frames[String(width)]![scene]![0]!, /~42\.7 t\/s/);
  // A wider bar carries the subagent alongside the complete machine counts.
  assert.match(frames['144']!.mixed![0]!, /HUD \(OS\): 8 running, 2 queued.*◐ Explore Audit bar fitting ladder$/);
  for (const width of [120, 100]) assert.match(frames[String(width)]!.mixed![0]!, /◐ Explore/, `mixed at ${width}`);
  assert.doesNotMatch(frames['80']!.mixed![0]!, /Audit bar/);
});
