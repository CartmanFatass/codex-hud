import assert from 'node:assert/strict';
import test from 'node:test';
import { conflictDetails } from '../../src/core/link/conflict-details.js';
import { stripAnsi } from '../../src/render/colors.js';
import { situationE } from '../fixtures/b10b-delegation.js';
import { draw, press } from '../fixtures/b10b-s3.js';

test('conflict Inspector preserves aggregate records without attributing a historical run', () => {
  const { vm } = situationE();
  const relation = vm.tree.relations.find((item) => item.attribution === 'conflict' && item.parentKey)!;
  const key = `conflict:${relation.link.linkId}:${relation.parentKey}`;
  relation.conflict = { count: 3, since: 100, recordIds: [`link:${relation.link.linkId}`, 'evidence:unknown'] };
  assert.equal(conflictDetails(relation)!.notListed, 1);
  const frame = draw(vm, { selected: key, width: 100, height: 40 });
  const opened = press(frame, 'enter');
  assert.equal(opened.state.preview, 'agent');
  const rendered = draw(vm, { state: opened.state, width: 100, height: 40 }).lines.map(stripAnsi).join('\n');
  assert.match(rendered, /Conflict/);
  assert.match(rendered, /no run attributed/);
  assert.match(rendered, /evidence:unknown · provenance unavailable/);
  assert.doesNotMatch(rendered, /r_impl-c/);
  assert.match(rendered, /\+1 not listed/);
  assert.doesNotMatch(rendered, /hud run reconcile/);
});

test('a non-conflict relation is not conflict evidence', () => {
  const { vm } = situationE();
  const relation = vm.tree.relations.find((item) => item.attribution === 'conflict')!;
  assert.equal(conflictDetails({ ...relation, attribution: 'confirmed' }), null);
});
