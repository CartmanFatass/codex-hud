import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { notifyFixture } from './b21-fixture.js';
import { recordWakeRegistered, recordWakeDelivered } from '../../src/ledger/notify-events.js';
import { readLink } from '../../src/ledger/records.js';
import { readWakeState, wakeProjection } from '../../packages/hud-mcp/src/wake-state.js';
import { openLinkLedgerReader } from '../../src/core/link-ledger-read.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
const opts = { skip: !ledgerRuntimeSupported() };

test('B10A wake matches B19 for current registration and context-only close before revoke', opts, async (t) => {
  const f = await notifyFixture();
  t.after(() => f.close());
  await f.ledger.transaction((tx) => recordWakeRegistered(tx, 'link-a', f.registration, 1100));
  const reader = await openLinkLedgerReader(join(f.root, 'ledger.sqlite'));
  t.after(() => reader.close());
  const compare = () => {
    const hud = reader.read();
    assert.equal(hud.state, 'available');
    const mcp = f.ledger.snapshot((tx) => readWakeState(tx, readLink(tx, 'link-a')));
    assert.deepEqual(
      wakeProjection(hud.wakeStates!.get('link-a')!, f.root, 'run-a', 0).wake,
      wakeProjection(mcp, f.root, 'run-a', 0).wake
    );
    return hud;
  };
  assert.equal(compare().wakeStates!.get('link-a')!.valid, true);
  const old = reader.changeToken();
  await f.ledger.transaction((tx) =>
    tx.run('UPDATE caller_contexts SET closed_at=1200 WHERE context_id=?', f.parent.context.contextId)
  );
  assert.notEqual(reader.changeToken(), old);
  assert.equal(compare().wakeStates!.get('link-a')!.reason, 'generation_changed');
});

test('B10A wake matches B19 for scope replacement and exact registration targeting', opts, async (t) => {
  const f = await notifyFixture();
  t.after(() => f.close());
  const old = await f.ledger.transaction((tx) => recordWakeRegistered(tx, 'link-a', f.registration, 1100));
  const current = await f.ledger.transaction((tx) => recordWakeRegistered(tx, 'link-a', f.registration, 1101));
  await f.ledger.transaction((tx) =>
    recordWakeDelivered(tx, 'link-a', { registrationSeq: old, throughSeq: 5, result: 'unknown', attempt: 1 }, 1102)
  );
  const reader = await openLinkLedgerReader(join(f.root, 'ledger.sqlite'));
  t.after(() => reader.close());
  let hud = reader.read();
  assert.equal(hud.state, 'available');
  assert.equal(hud.wakeStates!.get('link-a')!.seq, current);
  assert.equal(hud.wakeStates!.get('link-a')!.unconfirmed, false);
  await f.ledger.transaction((tx) =>
    tx.run('UPDATE caller_scopes SET closed_at=1200 WHERE process_key=?', f.parent.context.processKey)
  );
  hud = reader.read();
  assert.equal(hud.state, 'available');
  const mcp = f.ledger.snapshot((tx) => readWakeState(tx, readLink(tx, 'link-a')));
  assert.deepEqual(
    wakeProjection(hud.wakeStates!.get('link-a')!, f.root, 'run-a', 0).wake,
    wakeProjection(mcp, f.root, 'run-a', 0).wake
  );
  assert.equal(hud.wakeStates!.get('link-a')!.valid, false);
});

test(
  'B10A wake retains older unresolved batches, confirms same batch, and reports exhausted attempt two',
  opts,
  async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    const registrationSeq = await f.ledger.transaction((tx) =>
      recordWakeRegistered(tx, 'link-a', f.registration, 1100)
    );
    const reader = await openLinkLedgerReader(join(f.root, 'ledger.sqlite'));
    t.after(() => reader.close());
    const deliver = (throughSeq: number, result: 'accepted' | 'unknown', attempt: 1 | 2) =>
      f.ledger.transaction((tx) =>
        recordWakeDelivered(
          tx,
          'link-a',
          {
            registrationSeq,
            throughSeq,
            result,
            attempt,
            ...(result === 'unknown' && attempt === 2 ? { exhausted: true as const } : {}),
          } as any,
          1200
        )
      );
    const compare = () => {
      const hud = reader.read();
      assert.equal(hud.state, 'available');
      const mcp = f.ledger.snapshot((tx) => readWakeState(tx, readLink(tx, 'link-a')));
      assert.deepEqual(
        wakeProjection(hud.wakeStates!.get('link-a')!, f.root, 'run-a', 0).wake,
        wakeProjection(mcp, f.root, 'run-a', 0).wake
      );
      return hud;
    };
    await deliver(1, 'unknown', 1);
    await deliver(2, 'unknown', 1);
    await deliver(2, 'accepted', 1);
    assert.equal(compare().wakeAttempts!.get('link-a'), 1);
    await deliver(1, 'unknown', 2);
    assert.equal(compare().wakeAttempts!.get('link-a'), 2);
    await deliver(1, 'accepted', 2);
    assert.equal(compare().wakeAttempts!.get('link-a'), null);
    assert.equal(wakeProjection(compare().wakeStates!.get('link-a')!, f.root, 'run-a', 0).wake.state, 'registered');
  }
);
