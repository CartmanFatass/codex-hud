// Trusted test composition: actual supervisor process, real ledger and group;
// synthetic typed evidence is supplied through the in-process evidence port.
import { HeadlessRunControl } from '../../dist/core/run/control.js';
import { createRunFactPort } from '../../dist/core/run/ledger-port.js';
import { PrivateLedgerGate } from '../../dist/ledger/local-manager.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
const home = process.env.HUD_HOME;
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const options = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const createPort = process.env.HUD_RUN_PORT_MODULE
  ? (await import(process.env.HUD_RUN_PORT_MODULE)).createRunFactPort
  : createRunFactPort;
const port = await createPort(home);
options.retirementEvidence = async () => {
  const value = JSON.parse(readFileSync(`${home}/synthetic-evidence.json`, 'utf8'));
  if (value.delayMs) await sleep(value.delayMs);
  return value.returnsNull ? null : { ...value, asOf: Date.now() };
};
try {
  await new HeadlessRunControl(port, home, new PrivateLedgerGate(home).actor()).start(options);
} finally {
  await port.close();
}
