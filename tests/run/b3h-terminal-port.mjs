// Test-only asynchronous gate in the real SQLite writer's terminal import.
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRunFactPort as realPort } from '../../dist/core/run/ledger-port.js';
export async function createRunFactPort(home) {
  const port = await realPort(home);
  const receipt = port.receipt.bind(port);
  port.receipt = async (...args) => {
    writeFileSync(`${home}/terminal-import`, '', { mode: 0o600 });
    const deadline = Date.now() + 10000;
    while (!existsSync(`${home}/release-import`)) {
      if (Date.now() >= deadline) throw new Error('synthetic import gate deadline');
      await sleep(10);
    }
    return receipt(...args);
  };
  return port;
}
