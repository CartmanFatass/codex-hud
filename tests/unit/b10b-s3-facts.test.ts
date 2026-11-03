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

// A callable type with a sixth argument also compiles against the five-argument baseline,
// so the negative is an actual policy assertion, never a missing-symbol/compiler failure.
type FactInputs = [
  Parameters<typeof nodeFacts>[0],
  Parameters<typeof nodeFacts>[1],
  Parameters<typeof nodeFacts>[2],
  boolean,
  string | null,
];
const refillFacts: (...args: [...FactInputs, ReturnType<typeof nodeFacts>]) => ReturnType<typeof nodeFacts> = nodeFacts;

test('facts materialization: default calls return independent complete ordinary records', () => {
  const { vm } = situationC();
  const node = vm.tree.nodes[1];
  const args: FactInputs = [
    node,
    vm.details[node.key],
    vm.tree.relations.find((r) => r.childKey === node.key),
    false,
    null,
  ];
  const a = nodeFacts(...args);
  const b = nodeFacts(...args);
  assert.notStrictEqual(a, b);
  assert.deepEqual(a, b);
  assert.strictEqual(Object.getPrototypeOf(a), Object.prototype);
  assert.equal(Object.keys(a).length, 66);
  a.key = 'synthetic-changed-copy';
  assert.equal(b.key, node.key);
});

test('facts materialization policy: opt-in refill writes every field and returns the supplied record', () => {
  const { vm } = situationC();
  const initial = vm.tree.nodes[1];
  const buffer = nodeFacts(initial, vm.details[initial.key], undefined, false, null);
  const names = Object.keys(buffer);
  const writes: string[] = [];
  const observed = new Proxy(buffer, {
    set(target, name, value) {
      writes.push(String(name));
      return Reflect.set(target, name, value);
    },
  });
  // Every kind in the fixture, in both directions, then no details/relation/observation/run.
  const cases: FactInputs[] = vm.tree.nodes.flatMap(
    (node) =>
      [
        [
          node,
          vm.details[node.key],
          vm.tree.relations.find((r) => r.childKey === node.key),
          node.depth === 0,
          'synthetic conflict',
        ],
        [node, undefined, undefined, false, null],
      ] as FactInputs[]
  );
  const bare = structuredClone(initial);
  bare.observation = null;
  bare.currentRun = null;
  bare.host = null;
  bare.native = undefined;
  bare.loaded = false;
  bare.conflict = { count: 0, recordIds: [], since: 0 };
  bare.execution = {
    ...bare.execution,
    isRunTerminal: null,
    reconciliation: null,
    terminal: null,
    launchFailure: null,
  };
  cases.push([bare, undefined, undefined, false, null]);
  for (const args of [...cases, ...cases.slice().reverse()]) {
    const expected = nodeFacts(...args);
    // Poison even null/false fields: equality alone could otherwise miss a skipped refill write.
    for (const name of names) Reflect.set(buffer, name, Symbol(name));
    writes.length = 0;
    const actual = refillFacts(...args, observed);
    assert.strictEqual(actual, observed, 'new reuse policy; the old constructor ignores the sixth argument');
    assert.deepEqual(writes, names, 'each field is unconditionally assigned once, in constructor order');
    assert.deepEqual(Object.keys(actual), names);
    assert.deepEqual(actual, expected);
    assert.strictEqual(Object.getPrototypeOf(actual), Object.prototype);
  }
  const absent = refillFacts(bare, undefined, undefined, false, null, buffer);
  assert.equal(absent.hasStatus, false);
  assert.equal(absent.clockAnomaly, false);
  assert.equal(absent.launchFailed, false);
  assert.equal(absent.loaded, false);
  assert.equal(absent.costValue, null);
  assert.equal(absent.runId, null);
  assert.equal(absent.linkId, null);
  assert.equal(absent.reportSummary, null);
});
