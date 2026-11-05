import assert from 'node:assert/strict';
import test from 'node:test';
import { conflictDetails } from '../../src/core/link/conflict-details.js';
import { inspectorRows } from '../../src/render/monitor-inspector.js';
import { stripAnsi } from '../../src/render/colors.js';
import { situationE } from '../fixtures/b10b-delegation.js';
import { draw, monitorInput, press } from '../fixtures/b10b-s3.js';

test('conflict Inspector lists only facts tied to the selected child and marks unknown records', () => {
  const { vm } = situationE();
  const relation = vm.tree.relations.find((item) => item.attribution === 'conflict' && item.parentKey)!;
  const key = `conflict:${relation.link.linkId}:${relation.parentKey}`;
  relation.conflict = { count: 3, since: 100, recordIds: [`link:${relation.link.linkId}`, 'evidence:unknown'] };
  const detail = conflictDetails(vm.tree, key)!;
  assert.equal(detail.records[0].parentKey, relation.parentKey);
  assert.equal(detail.records[1].parentKey, null);
  assert.equal(detail.records[1].runId, null);
  assert.equal(detail.notListed, 1);
  const frame = draw(vm, { selected: key, width: 80, height: 30 });
  const opened = press(frame, 'enter');
  assert.equal(opened.state.preview, 'agent');
  const input = monitorInput(vm, { state: opened.state, width: 80, height: 30 });
  const text = inspectorRows(input, opened.state, 80, input.nowMs!)
    .map((row) => stripAnsi(row.text))
    .join('\n');
  assert.match(text, /Conflict/);
  assert.match(text, /no run attributed/);
  assert.match(text, /evidence:unknown · parent unavailable · run unavailable/);
  assert.match(text, /\+1 not listed/);
  const rendered = draw(vm, { state: opened.state, width: 80, height: 30 }).lines.map(stripAnsi).join('\n');
  assert.match(rendered, /Conflict/);
});

test('ambiguous synthetic key and mismatched run never gain attribution', () => {
  const { vm } = situationE();
  const relation = vm.tree.relations.find((item) => item.attribution === 'conflict' && item.parentKey)!;
  relation.conflict = { count: 1, since: 100, recordIds: [`link:${relation.link.linkId}`] };
  const key = `conflict:${relation.link.linkId}:${relation.parentKey}`;
  if (relation.currentRun) relation.currentRun = { ...relation.currentRun, linkId: 'another-link' };
  assert.equal(conflictDetails(vm.tree, key)!.records[0].runId, null);
  vm.tree.relations.push({ ...relation });
  assert.equal(conflictDetails(vm.tree, key), null);
});
