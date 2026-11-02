import { openLedger } from '../../dist-test/src/ledger/ledger.js';
import { acceptIntent } from '../../dist-test/src/ledger/intents.js';
import { LedgerTransaction } from '../../dist-test/src/ledger/transaction.js';
import { insertRecord } from '../../dist-test/src/ledger/records.js';
import { intent, seedCaller } from '../ledger/fixtures.mjs';
const ledger = await openLedger(process.argv[2]);
let cut = false;
const original = LedgerTransaction.prototype.run;
LedgerTransaction.prototype.run = function (sql, ...args) {
  const result = original.call(this, sql, ...args);
  if (cut && /^INSERT INTO runs/i.test(sql)) {
    process.send({ type: 'cut' });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
    throw new Error('kill_not_received');
  }
  return result;
};
process.on('message', async (m) => {
  try {
    let result;
    if (m.action === 'seed') await seedCaller(ledger);
    if (m.action === 'intent') {
      const p = intent(m.variant);
      p.requestKey = m.key ?? 'key-' + m.variant;
      cut = m.cut === true;
      result = await acceptIntent(ledger, p, 20, undefined, { maxActiveRuns: 6, maxActiveRunsPerOwner: 6 });
    } else if (m.action === 'inspect')
      result = ledger.snapshot((tx) =>
        Object.fromEntries(
          ['runs', 'slots', 'idempotency', 'links'].map((table) => [
            table,
            Number(tx.get('SELECT count(*) AS n FROM ' + table).n),
          ])
        )
      );
    else if (m.action === 'load') {
      for (let i = 0; i < m.count; i++) {
        try {
          await ledger.transaction((tx) =>
            insertRecord(tx, 'events', { linkId: null, runId: null, kind: 'b21.load', payload: {}, at: Date.now() })
          );
        } catch (e) {
          if (e.code !== 'ledger_busy') throw e;
        }
        await new Promise((r) => setImmediate(r));
      }
      result = true;
    } else if (m.action === 'close') {
      await ledger.close();
      process.send({ id: m.id, result: true }, () => process.disconnect());
      return;
    }
    process.send({ id: m.id, result: result ?? true });
  } catch (e) {
    process.send({ id: m.id, error: e.message, code: e.code });
  }
});
process.send({ type: 'ready' });
