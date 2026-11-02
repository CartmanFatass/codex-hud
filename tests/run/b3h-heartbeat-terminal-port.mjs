// Test-only gate immediately after the final file exists and before SQLite import.
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRunFactPort as realPort } from '../../dist/core/run/ledger-port.js';
export async function createRunFactPort(home) {
  const port = await realPort(home);
  const receipt = port.receipt.bind(port);
  port.receipt = async (...args) => {
    writeFileSync(`${home}/heartbeat-import-ready`, '', { mode: 0o600 });
    const deadline = Date.now() + 10000;
    while (!existsSync(`${home}/heartbeat-import-go`)) {
      if (Date.now() >= deadline) throw new Error('synthetic receipt gate deadline');
      await sleep(5);
    }
    return receipt(...args);
  };
  return port;
}
