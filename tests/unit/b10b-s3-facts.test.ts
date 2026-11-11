/** Facts are ordinary independent records; explicit reuse must not retain a previous node's values. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { comparatorFor, factsEqual, nodeFacts } from '../../src/render/delegation/facts.js';
import { situationC } from '../fixtures/b10b-delegation.js';

test('a fact name with a digit, an underscore or a dollar compares by value (no throw, every field read)', () => {
  const base = { plain: 'x', rev2: 2, snake_case: true, $dollar: null, _lead: 0, a1b2: 'y' };
  const equal = comparatorFor<typeof base>(Object.keys(base) as Array<keyof typeof base>);
  assert.equal(equal(base, { ...base }), true);
  for (const key of Object.keys(base)) assert.equal(equal(base, { ...base, [key]: 'changed' }), false, key);
});

test('a name that is not an identifier is refused, so nothing but identifiers reaches the generated code', () => {
  for (const bad of ['1leading', 'with space', 'semi;colon', 'dash-ed', 'a.b', "q'uote", '', 'ünï'])
    assert.throws(() => comparatorFor<Record<string, unknown>>([bad]), /identifiers/, JSON.stringify(bad));
});

test('facts records are independent and explicit refill matches a fresh record across nodes and absent details', () => {
  const { vm } = situationC();
  const first = vm.tree.nodes[1];
  const buffer = nodeFacts(first, vm.details[first.key], undefined, false, null);
  const copy = nodeFacts(first, vm.details[first.key], undefined, false, null);
  assert.notStrictEqual(buffer, copy);
  assert.ok(factsEqual(buffer, copy));
  buffer.key = 'synthetic-changed-copy';
  assert.equal(copy.key, first.key);
  assert.equal(factsEqual(buffer, copy), false);
  const bare = structuredClone(first);
  bare.observation = null;
  bare.currentRun = null;
  bare.host = null;
  bare.native = undefined;
  bare.loaded = false;
  for (const node of [...vm.tree.nodes, bare]) {
    for (const detail of [vm.details[node.key], undefined]) {
      const expected = nodeFacts(node, detail, undefined, false, null);
      const actual = nodeFacts(node, detail, undefined, false, null, buffer);
      assert.strictEqual(actual, buffer);
      assert.deepEqual(actual, expected);
    }
  }
});
