/**
 * The panel repaints on new data, input and resize, and between those only
 * because its clocks move. They count whole seconds, so a once-a-second
 * repaint timed to the main turn clock is enough: these tests pin both the
 * timing and the claim that nothing on screen changes faster than that.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { initialMonitorState, nextRepaintDelay, renderMonitor } from '../../src/render/monitor.js';
import { statusCard } from '../../src/render/status-block.js';
import { setDisplayConfig, displayConfig } from '../../src/render/hud-config.js';
import { makeHudData, makeSubagentTree, FIXED_NOW, at } from '../fixtures/hud-data.js';

const NOW = FIXED_NOW.getTime();

test('a repaint lands just after the next second of the turn clock, or of the wall clock', () => {
  const start = NOW - 4_300; // the turn clock turns over at NOW + 700
  assert.equal(nextRepaintDelay(NOW, start), 720);
  assert.equal(nextRepaintDelay(NOW + 720, start), 1000, 'once on the beat it stays on it');
  assert.equal(nextRepaintDelay(NOW + 990, start), 730);
  assert.equal(nextRepaintDelay(NOW + 690, start), 30, 'just before the turn: wait for it');
  assert.equal(nextRepaintDelay(NOW), 1020, 'no turn running: the wall clock second');
  assert.equal(nextRepaintDelay(NOW + 250), 770);
  assert.equal(nextRepaintDelay(NOW, Number.NaN), 1020);
  for (let ms = 0; ms < 3000; ms += 37) {
    const delay = nextRepaintDelay(NOW + ms, start);
    assert.ok(delay > 0 && delay <= 1020, `delay ${delay} at +${ms}`);
    // The clock reads one second more at the repaint than it did a moment before it.
    assert.equal(Math.floor((NOW + ms + delay - start) / 1000) - Math.floor((NOW + ms + delay - 21 - start) / 1000), 1);
  }
});

test('nothing in the panel changes within a second, even with live traffic and full motion', () => {
  const previous = displayConfig().motion;
  setDisplayConfig({ ...displayConfig(), motion: 'full' });
  try {
    const turnStartedAt = new Date(NOW - 4_300);
    const data = makeHudData({ activity: { state: 'working', updatedAt: at(-1), turnStartedAt } });
    // An agent talking to the main session right now: the bar animates this.
    const tree = makeSubagentTree();
    const draw = (nowMs: number) => renderMonitor({
      tree, state: initialMonitorState(), width: 32, height: 30, nowMs,
      status: (rowWidth, maxRows) => statusCard(data, rowWidth, maxRows, nowMs),
    }).lines.join('\n');
    // From just after one turn of the turn clock to just before the next.
    const first = NOW + 720;
    for (const step of [0, 250, 500, 750, 950]) assert.equal(draw(first + step), draw(first), `+${step}ms`);
    assert.notEqual(draw(first + 1000), draw(first), 'the turn clock moves on the second');
  } finally {
    setDisplayConfig({ ...displayConfig(), motion: previous });
  }
});
