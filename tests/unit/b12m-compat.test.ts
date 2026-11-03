// B12M compatibility: callers without budget/grant arguments get byte-identical
// results to the pre-B12M store. The fixture was recorded from universal-hud at
// 6fcf08a (before B12M) by running this file with B12M_RECORD=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecoveryIndexOverlay, attachRecoveryIndex } from '../../src/core/checkpoint.js';
import type { ObservationRecovery, RecoveryIndexLookup } from '../../src/core/types/checkpoint.js';
import { BUDGET, REF, commit, setup, skip } from './b12m-helpers.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/unit/b12m-compat-fixture.json'
);

function outcome(work: () => unknown): string {
  try {
    const value = work();
    return JSON.stringify({ value: value === undefined ? '<undefined>' : value });
  } catch (error) {
    return JSON.stringify({ error: (error as Error).message });
  }
}

function lookupReads(lookup: RecoveryIndexLookup): string[] {
  return [
    JSON.stringify(lookup.reference),
    outcome(() => lookup.get('synthetic.ids', '00001')),
    outcome(() => lookup.get('synthetic.ids', '00002')),
    outcome(() => lookup.get('synthetic.ids', 'absent')),
    outcome(() => lookup.get('synthetic.text', 'ünïcode')),
    outcome(() => lookup.get('other.namespace', '00001')),
    outcome(() => lookup.page('synthetic.ids', null, 3)),
    outcome(() => lookup.page('synthetic.ids', '00010', 5)),
    outcome(() => lookup.page('synthetic.ids', '00297', 256)),
    outcome(() => lookup.page('synthetic.text', null, 256)),
    outcome(() => lookup.page('synthetic.ids', null, 0)),
    outcome(() => lookup.page('synthetic.ids', null, 257)),
  ];
}

test('B12M compatibility callers without grants match the pre-change recorded fixture', { skip }, async (t) => {
  const f = await setup(t, 'b12m-compat-');
  const overlay = new RecoveryIndexOverlay('synthetic-index-1');
  for (let n = 0; n < 300; n++) overlay.set('synthetic.ids', String(n).padStart(5, '0'), JSON.stringify({ n }));
  overlay.set('synthetic.text', 'ünïcode', JSON.stringify('synthetic välue ✓'));
  const first = commit();
  let acknowledged: RecoveryIndexLookup | undefined;
  attachRecoveryIndex(first.checkpoint, overlay, (lookup) => (acknowledged = lookup));
  const records: Record<string, unknown> = {};
  records.publish1 = JSON.stringify(f.publish(first));
  const projection = f.store.readProjection(REF)!;
  records.projection = JSON.stringify(projection);
  const recovery = f.store.readRecovery(projection, BUDGET) as ObservationRecovery;
  records.recovery = JSON.stringify(recovery);
  records.recoveryHandoffKeys = JSON.stringify(Object.getOwnPropertyNames(recovery.checkpoint.recoveryIndex));
  const lookup = recovery.checkpoint.recoveryIndex!.lookup!;
  records.recoveryLookup = lookupReads(lookup);
  records.ackLookup = lookupReads(acknowledged!);
  records.current = JSON.stringify(f.store.readCurrent(REF));
  const { recoveryIndex: _index, ...inline } = recovery.checkpoint;
  const bodyBytes = Buffer.byteLength(JSON.stringify(inline));
  records.budgets = [
    { ...BUDGET, budgetMs: 0 },
    { ...BUDGET, maxRecords: 0 },
    { ...BUDGET, maxBytes: 1 },
    { ...BUDGET, maxBytes: 0 },
    { maxBytes: 1024 * 1024, maxRecords: 1, budgetMs: 1 },
    { ...BUDGET, maxBytes: -1 },
    { ...BUDGET, budgetMs: Number.NaN },
  ].map((budget) => outcome(() => f.store.readRecovery(projection, budget)));
  // Exact-fit and one-byte-short checks around the stored body length.
  records.exactBudgets = [-1, 0, 1, 64].map((delta) =>
    outcome(() => {
      const result = f.store.readRecovery(projection, { ...BUDGET, maxBytes: bodyBytes + delta });
      return result && 'kind' in result ? result : 'recovered';
    })
  );
  records.wrongIdentity = outcome(() =>
    f.store.readRecovery(
      { ...projection, checkpointIdentity: { ...projection.checkpointIdentity, offset: 999 } },
      BUDGET
    )
  );
  overlay.set('synthetic.ids', '00001', JSON.stringify({ n: 10001 }));
  overlay.delete('synthetic.ids', '00002');
  overlay.set('synthetic.ids', 'zzz-new', JSON.stringify('new'));
  const second = commit(2);
  attachRecoveryIndex(second.checkpoint, overlay, (next) => (acknowledged = next));
  records.publish2 = JSON.stringify(f.publish(second));
  // A lookup retained across a replacing commit keeps its legacy (index-snapshot) behaviour.
  records.retainedLookup = lookupReads(lookup);
  records.secondAck = lookupReads(acknowledged!);
  records.staleTarget = outcome(() => f.store.readRecovery(projection, BUDGET));
  const current = f.store.readProjection(REF)!;
  records.secondRecovery = JSON.stringify(f.store.readRecovery(current, BUDGET));
  records.secondCurrent = JSON.stringify(f.store.readCurrent(REF));
  const repeat = commit(3);
  repeat.checkpoint = second.checkpoint;
  repeat.checkpoint.recoveryIndex = undefined;
  attachRecoveryIndex(repeat.checkpoint, overlay, (next) => (acknowledged = next));
  records.publish3 = outcome(() => f.publish(repeat));
  records.thirdAck = lookupReads(acknowledged!);
  if (process.env.B12M_RECORD === '1') {
    fs.writeFileSync(FIXTURE, JSON.stringify(records, null, 1) + '\n');
    return;
  }
  // Every recorded value is the exact serialized output string, so string equality is byte equality; the fixture
  // file's own whitespace (prettier) does not matter.
  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(records), Object.keys(expected));
  for (const name of Object.keys(expected)) assert.deepStrictEqual(records[name], expected[name], name);
});
