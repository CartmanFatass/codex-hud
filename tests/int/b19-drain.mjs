import { openLedger } from '../../dist-test/src/ledger/ledger.js';
import { WakeAdapters } from '../../dist-test/src/core/wake/adapters.js';
import { WakeDrainer } from '../../dist-test/packages/hud-mcp/src/wake-drainer.js';
const [home, processKey, executable, fault] = process.argv.slice(2);
const ledger = await openLedger(home + '/ledger.sqlite');
const drainer = new WakeDrainer({
  ledger,
  home,
  processKey,
  recoveryMs: 100,
  adapters: new WakeAdapters({ codexExecutable: executable }),
  ...(fault === 'reserve' ? { afterReservation: () => process.exit(71) } : {}),
  ...(fault === 'transport' ? { afterTransport: () => process.exit(72) } : {}),
});
const keep = setInterval(() => {}, 1000);
const stop = async () => {
  clearInterval(keep);
  await drainer.close();
  await ledger.close();
};
if (fault === 'lifetime') {
  process.stdin.resume();
  process.stdin.once('end', () => {
    void stop();
  });
}
process.once('SIGTERM', () => {
  void stop();
});
process.send?.({ ready: true });
