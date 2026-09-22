/**
 * What a column on the status bar means when it is clicked.
 *
 * The rule being defended: a click that says "go and look" hands the panel the
 * keyboard, a click that says "show me more of this" does not, and anything
 * the bar cannot identify keeps the old meaning rather than guessing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { clickAction, clickActionFromSnapshot, segmentAt } from '../../src/utils/click-map.js';
import { buildSnapshot } from '../../src/snapshot.js';
import { fitModules } from '../../src/render/layout/engine.js';
import { buildBarModules } from '../../src/render/layout/bar-modules.js';
import { theme } from '../../src/render/colors.js';
import { makeHudData, FIXED_NOW } from '../fixtures/hud-data.js';

const segments = [
  { id: 'attention', x: 0, width: 10 },
  { id: 'identity', x: 13, width: 8 },
  { id: 'context', x: 24, width: 12 },
  { id: 'agents', x: 40, width: 9 },
  { id: 'hint', x: 56, width: 3 },
];

test('a field is found at any of its own columns and at none of anyone else’s', () => {
  assert.equal(segmentAt(segments, 0)?.id, 'attention');
  assert.equal(segmentAt(segments, 9)?.id, 'attention');
  assert.equal(segmentAt(segments, 10), undefined, 'the separator belongs to no field');
  assert.equal(segmentAt(segments, 24)?.id, 'context');
  assert.equal(segmentAt(segments, 58)?.id, 'hint');
  assert.equal(segmentAt(segments, 59), undefined, 'past the last field is padding');
  assert.equal(segmentAt(segments, -1), undefined);
  assert.equal(segmentAt(segments, Number.NaN), undefined);
});

test('going to look takes the keyboard; glancing at a meter does not', () => {
  assert.equal(clickAction(segments, 3), 'open-focus', 'the alert is why you clicked');
  assert.equal(clickAction(segments, 44), 'open-focus', 'so are the agent counts');
  assert.equal(clickAction(segments, 57), 'open-focus', 'and so is the key hint');

  assert.equal(clickAction(segments, 26), 'open', 'a meter opens the panel and leaves Codex alone');
});

test('anything the bar cannot name keeps the old meaning', () => {
  assert.equal(clickAction(segments, 15), 'toggle', 'a field with no panel behind it');
  assert.equal(clickAction(segments, 11), 'toggle', 'a separator');
  assert.equal(clickAction(segments, 200), 'toggle', 'past the end of the line');
  assert.equal(clickAction([], 4), 'toggle', 'a bar with nothing on it');
});

test('an unreadable or unrecognised snapshot is a plain toggle, not an error', () => {
  assert.equal(clickActionFromSnapshot('', 4), 'toggle');
  assert.equal(clickActionFromSnapshot('not json', 4), 'toggle');
  assert.equal(clickActionFromSnapshot('{}', 4), 'toggle');
  assert.equal(clickActionFromSnapshot('{"bar":{}}', 4), 'toggle');
  assert.equal(clickActionFromSnapshot('{"bar":{"segments":"nope"}}', 4), 'toggle');
  assert.equal(clickActionFromSnapshot('{"bar":{"segments":[{"id":5,"x":0,"width":9}]}}', 4), 'toggle');
  assert.equal(
    clickActionFromSnapshot('{"bar":{"segments":[{"id":"agents","x":0,"width":9}]}}', 4),
    'open-focus'
  );
});

test('a real snapshot maps its own columns back to its own fields', () => {
  const data = makeHudData();
  const width = 160;
  const fit = fitModules(buildBarModules(data, { nowMs: FIXED_NOW.getTime(), barWidth: 10 }), {
    width,
    separator: theme.separator(' │ '),
    groupSeparator: '  ',
  });
  const json = JSON.stringify(buildSnapshot(data, { width, segments: fit.segments }, FIXED_NOW.getTime()));

  const columnOf = (id: string) => fit.segments.find((segment) => segment.id === id)!.x;
  assert.equal(clickActionFromSnapshot(json, columnOf('attention')), 'open-focus');
  assert.equal(clickActionFromSnapshot(json, columnOf('agents')), 'open-focus');
  assert.equal(clickActionFromSnapshot(json, columnOf('context')), 'open');
  assert.equal(clickActionFromSnapshot(json, columnOf('quota')), 'open');
  assert.equal(clickActionFromSnapshot(json, columnOf('identity')), 'toggle');
});
