import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkbenchHistory } from '../../src/collectors/workbench-events.js';
import { node, treeOf } from '../fixtures/hud-data.js';

test('event history retains transitions through polling and clears on session switch', () => {
  const history = new WorkbenchHistory();
  const agent = node('worker','worker','running');
  agent.statusAt = new Date('2026-09-11T10:00:00Z');
  let tree = treeOf([agent]);
  history.update(tree, null);
  history.update(tree, null);
  assert.equal(history.values().length, 1);
  agent.status = 'completed';
  agent.statusAt = new Date('2026-09-11T10:00:10Z');
  history.update(tree, null);
  assert.deepEqual(history.values().map(event => event.status), ['completed','running']);
  tree = {...tree, rootId:'another'};
  history.update(tree, null);
  assert.equal(history.values().length, 1);
});
