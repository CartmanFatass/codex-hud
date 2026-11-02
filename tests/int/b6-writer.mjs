// Synthetic competing writer, one real SQLite connection and no external processes.
import { openLedger } from '../../dist-test/src/ledger/ledger.js';
let ledger;
for (let attempt = 0; !ledger; attempt++) {
  try {
    ledger = await openLedger(process.argv[2]);
  } catch (error) {
    if (attempt >= 20) {
      process.send?.({ error: String(error) });
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
let stopped = false,
  writes = 0;
process.on('message', () => {
  stopped = true;
});
process.send?.({ ready: true });
while (!stopped) {
  try {
    await ledger.transaction((tx) =>
      tx.run("INSERT INTO events(link_id,run_id,kind,payload,at) VALUES(NULL,NULL,'b6.load','{}',?)", Date.now())
    );
    writes++;
  } catch (error) {
    if (error.code !== 'ledger_busy') throw error;
  }
  // Synthetic contention without monopolizing the writer lock indefinitely.
  await new Promise((resolve) => setTimeout(resolve, 3));
}
await ledger.close();
process.send?.({ writes });
process.disconnect?.();
