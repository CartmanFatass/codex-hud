/**
 * B10B-s3: the generated facts comparator (segment 2 re-check, P3). Its name guard admits every plain identifier a
 * fact may be called, a digit, `_` or `$` included; anything else is refused before it can reach `new Function`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { comparatorFor, factsEqual, nodeFacts } from '../../src/render/delegation/facts.js';
import { situationC } from '../fixtures/b10b-delegation.js';

interface Odd {
  plain: string;
  rev2: number;
  snake_case: boolean;
  $dollar: string | null;
  _lead: number;
  a1b2: string;
}
const KEYS: Array<keyof Odd & string> = ['plain', 'rev2', 'snake_case', '$dollar', '_lead', 'a1b2'];
const base: Odd = { plain: 'x', rev2: 2, snake_case: true, $dollar: null, _lead: 0, a1b2: 'y' };

test('a fact name with a digit, an underscore or a dollar compares by value (no throw, every field read)', () => {
  const equal = comparatorFor<Odd>(KEYS);
  assert.equal(equal(base, { ...base }), true);
  for (const key of KEYS) {
    const changed = { ...base, [key]: key === 'rev2' || key === '_lead' ? 99 : key === 'snake_case' ? false : 'z' };
    assert.equal(equal(base, changed as Odd), false, `${key} is compared`);
  }
});

test('a name that is not an identifier is refused, so nothing but identifiers reaches the generated code', () => {
  for (const bad of ['1leading', 'with space', 'semi;colon', 'dash-ed', 'a.b', "q'uote", '', 'ünï'])
    assert.throws(() => comparatorFor<Record<string, unknown>>([bad]), /identifiers/, JSON.stringify(bad));
});

test('the real facts still compare field by field through the same comparator', () => {
  const c = situationC();
  const node = c.vm.tree.nodes[1];
  const facts = nodeFacts(node, c.vm.details[node.key], undefined, false, null);
  assert.equal(factsEqual(facts, { ...facts }), true);
  assert.equal(factsEqual(facts, { ...facts, stateKey: 'other' }), false);
});
