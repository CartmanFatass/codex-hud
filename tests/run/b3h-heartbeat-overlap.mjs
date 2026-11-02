// Test-only supervisor: retain real SQLite publication and real kernel group wait,
// gating only their promise delivery to force the heartbeat/finalization race.
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { HeadlessRunControl } from '../../dist/core/run/control.js';
import { createRunFactPort } from '../../dist/core/run/ledger-port.js';
import { launchGroup } from '../../dist/core/run/process.js';
import { PrivateLedgerGate } from '../../dist/ledger/local-manager.js';
import { LedgerBusyError } from '../../dist/ledger/transaction.js';
const home = process.env.HUD_HOME;
const gate = async (name) => {
  const deadline = Date.now() + 10000;
  while (!existsSync(`${home}/${name}`)) {
    if (Date.now() >= deadline) throw new Error(`synthetic overlap gate deadline: ${name}`);
    await sleep(5);
  }
};
const port = await createRunFactPort(home);
const heartbeat = port.heartbeat.bind(port);
port.heartbeat = async (...args) => {
  try {
    return await heartbeat(...args);
  } catch (error) {
    if (!(error instanceof LedgerBusyError)) throw error;
    writeFileSync(`${home}/heartbeat-busy-held`, '', { mode: 0o600 });
    await gate('release-busy');
    // The controller's rejection microtasks run before this marker's callback.
    setImmediate(() => writeFileSync(`${home}/busy-delivered`, '', { mode: 0o600 }));
    throw error;
  }
};
try {
  let json = '';
  for await (const chunk of process.stdin) json += chunk;
  const control = new HeadlessRunControl(port, home, new PrivateLedgerGate(home).actor(), async (options) => {
    const group = await launchGroup(options);
    return {
      ...group,
      exited: group.exited.then(async (exit) => {
        writeFileSync(`${home}/group-waited`, '', { mode: 0o600 });
        await gate('release-wait');
        return exit;
      }),
    };
  });
  await control.start(JSON.parse(json));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  await port.close();
}
