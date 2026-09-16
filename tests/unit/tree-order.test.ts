import test from 'node:test';
import assert from 'node:assert/strict';
import { initialPanelState, visibleRows } from '../../src/render/panel-state.js';
import { node } from '../fixtures/hud-data.js';

const start = new Date('2026-09-11T10:00:00Z');
test('active sorting keeps active descendants under their completed parent', () => {
  const done = node('done', 'done', 'completed');
  const parent = node('parent', 'parent', 'completed');
  parent.children = [node('old', 'old', 'completed'), node('child', 'child', 'running')];
  const run = node('run', 'run', 'running');
  run.startedAt = start;
  parent.children[1].startedAt = new Date(start.getTime() + 1000);
  const state = { ...initialPanelState(), sort: 'active' as const };
  const rows = visibleRows([done, run, parent], state);
  assert.deepEqual(rows.map(row => row.node.id), ['parent', 'child', 'old', 'run', 'done']);
  assert.equal(rows[1].parentId, 'parent');
  assert.deepEqual(parent.children.map(child => child.id), ['old', 'child'], 'sorting must not mutate the collected tree');
  run.lastEventAt = new Date(start.getTime() + 999999);
  assert.deepEqual(visibleRows([done, run, parent], state).map(row => row.node.id), rows.map(row => row.node.id),
    'ordinary traffic must not reshuffle the list');
});

test('creation order is deterministic even when file discovery order changes', () => {
  const a = node('a', 'a', 'completed');
  const b = node('b', 'b', 'running');
  a.startedAt = start;
  b.startedAt = new Date(start.getTime() + 1000);
  const state = { ...initialPanelState(), sort: 'created' as const };
  assert.deepEqual(visibleRows([b, a], state).map(row => row.node.id), ['a', 'b']);
});

test('a follow-up turn brings an older agent ahead of a newer sibling', () => {
  const older = node('older', 'older', 'running');
  const newer = node('newer', 'newer', 'running');
  older.startedAt = start;
  newer.startedAt = new Date(start.getTime() + 1000);
  older.turnStartedAt = new Date(start.getTime() + 2000);
  const state = { ...initialPanelState(), sort: 'active' as const };
  assert.deepEqual(visibleRows([newer, older], state).map(row => row.node.id), ['older', 'newer']);
});
