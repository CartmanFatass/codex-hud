import { notifyFixture } from '../unit/b21-fixture.js';
import { recordWakeRegistered } from '../../src/ledger/notify-events.js';
import { insertRecord } from '../../src/ledger/records.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';

const skip = !ledgerRuntimeSupported();
type Fixture = Awaited<ReturnType<typeof notifyFixture>>;
async function register(f: Fixture) {
  return f.ledger.transaction((tx) => recordWakeRegistered(tx, 'link-a', f.registration, Date.now()));
}
async function event(f: Fixture, count = 1) {
  return f.ledger.transaction((tx) => {
    const seqs: number[] = [];
    for (let i = 0; i < count; i++) {
      insertRecord(tx, 'events', {
        runId: 'run-a',
        linkId: 'link-a',
        kind: 'run.state',
        payload: { state: 'uncertain' },
        at: Date.now() - i,
      });
      seqs.push(Number(tx.get('SELECT last_insert_rowid() AS n')!.n));
    }
    return seqs;
  });
}
export { skip, Fixture, register, event };
