// Test-only independent writer. Waits on IPC; each requested lock is bounded.
import { openLedger } from '../../dist-test/src/ledger/ledger.js';
const ledger = await openLedger(process.argv[2]);
process.on('message', async (message) => {
  if (message.type === 'hold') {
    try {
      await ledger.transaction(() => {
        process.send?.({ type: 'locked' });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, message.durationMs);
      });
      process.send?.({ type: 'released' });
    } catch (error) {
      process.send?.({ type: 'failed', message: error.message });
    }
  } else if (message.type === 'close') {
    await ledger.close();
    process.disconnect();
  }
});
process.send?.({ type: 'ready' });
