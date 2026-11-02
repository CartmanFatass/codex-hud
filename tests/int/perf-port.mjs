// Measurement shim around the production ledger adapter, running in the supervisor.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRunFactPort as createRealPort } from '../../dist/core/run/ledger-port.js';
export async function createRunFactPort(home) {
  const port = await createRealPort(home),
    heartbeat = port.heartbeat.bind(port),
    samples = [];
  port.heartbeat = async (...args) => {
    const begin = performance.now();
    try {
      return await heartbeat(...args);
    } finally {
      samples.push(performance.now() - begin);
    }
  };
  process.once('exit', () =>
    writeFileSync(join(home, 'heartbeat-times.json'), JSON.stringify(samples), { mode: 0o600 })
  );
  return port;
}
