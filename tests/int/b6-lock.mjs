// Deliberate synthetic external SQLite writer contention, bounded to 200ms.
import { openLedger } from '../../dist-test/src/ledger/ledger.js';
const ledger = await openLedger(process.argv[2]);
try {
  await ledger.transaction((tx) => {
    process.send?.({ locked: true });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    tx.run("INSERT INTO events(link_id,run_id,kind,payload,at) VALUES(NULL,NULL,'b6.lock','{}',?)", Date.now());
  });
} finally {
  await ledger.close();
  process.disconnect?.();
}
