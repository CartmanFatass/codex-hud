// Real competing WAL writer, controlled by its owning test through IPC.
import { openLedger } from '../../dist-test/src/ledger/ledger.js';
const ledger = await openLedger(process.argv[2]);
const limit = Number(process.argv[3] ?? 300);
process.send?.({ ready: true });
let stopping = false;
process.on('message', async (message) => {
  if (message === 'stop') {
    stopping = true;
    return;
  }
  if (message !== 'go') return;
  const start = performance.now();
  let committed = 0,
    busy = 0;
  try {
    for (let i = 0; i < limit && !stopping; i++) {
      try {
        await ledger.transaction((tx) =>
          tx.run(
            "INSERT INTO events(link_id,run_id,kind,payload,at) VALUES('link-a','run-a','synthetic.progress','{}',?)",
            Date.now()
          )
        );
        committed++;
      } catch (error) {
        if (error?.code !== 'ledger_busy') throw error;
        busy++;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const elapsedMs = performance.now() - start;
    process.send?.({ committed, busy, elapsedMs, commitsPerSecond: (committed / elapsedMs) * 1000 });
  } finally {
    await ledger.close();
    process.disconnect?.();
  }
});
