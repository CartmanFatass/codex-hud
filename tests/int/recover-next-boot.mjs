// Labelled boot mismatch simulation, not a real reboot. Only current-domain
// discovery changes; the saved receipt and historical ProcessStamps stay intact.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync;
fs.readFileSync = (path, ...args) =>
  path === '/proc/sys/kernel/random/boot_id' ? 'synthetic-next-boot\n' : read(path, ...args);
syncBuiltinESMExports();
const { createRunFactPort } = await import('../../dist-test/src/core/run/ledger-port.js');
const { HeadlessRunControl } = await import('../../dist-test/src/core/run/control.js');
const { PrivateLedgerGate } = await import('../../dist-test/src/ledger/local-manager.js');
const port = await createRunFactPort(process.env.HUD_HOME);
try {
  const result = await new HeadlessRunControl(
    port,
    process.env.HUD_HOME,
    new PrivateLedgerGate(process.env.HUD_HOME).actor()
  ).reconcile(process.argv[2]);
  process.stdout.write(JSON.stringify(result));
} finally {
  await port.close();
}
