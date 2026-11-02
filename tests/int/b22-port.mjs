// Trusted deterministic crash/race cuts around the real original-writer port.
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRunFactPort as realPort } from '../../dist/core/run/ledger-port.js';
export async function createRunFactPort(home) {
  const port = await realPort(home);
  const config = JSON.parse(readFileSync(`${home}/b22-cut.json`, 'utf8'));
  const mark = (name) => writeFileSync(`${home}/${name}`, '', { mode: 0o600 });
  const wait = async (name) => {
    const until = performance.now() + 15000;
    while (!existsSync(`${home}/${name}`)) {
      if (performance.now() > until) throw new Error('B22 synthetic cut deadline: ' + name);
      await sleep(5);
    }
  };
  if (config.metrics) {
    let reads = 0;
    const read = port.read.bind(port);
    port.read = async (...args) => {
      const result = await read(...args);
      writeFileSync(`${home}/read-count`, String(++reads), { mode: 0o600 });
      return result;
    };
  }
  const request = port.requestRetirement.bind(port);
  port.requestRetirement = async (id, stamp, revision, payload) => {
    if (config.beforeRequest) {
      mark('before-request');
      await wait('release-request');
      const fresh = await port.read(id);
      revision = fresh.revision;
    }
    const result = await request(id, stamp, revision, payload);
    if (result) {
      mark('retirement-committed');
      if (config.afterRequest) await wait('release-signal');
    }
    return result;
  };
  const raw = port.raw.bind(port);
  port.raw = async (id, stamp, kind, payload) => {
    const result = await raw(id, stamp, kind, payload);
    if (config.rollback && kind === 'launch.sealed')
      setTimeout(() => {
        const now = Date.now;
        Date.now = () => now() - 2000;
      }, 500);
    if (kind === 'cancel.step') {
      mark(payload.signal);
    }
    if (config.import && kind === 'submission.fenced') {
      mark('terminal-import');
      await wait('release-import');
    }
    return result;
  };
  const reconcile = port.reconcile.bind(port);
  port.reconcile = async (...args) => {
    const result = await reconcile(...args);
    if (
      config.clock &&
      args[2].some((e) => e.fact.kind === 'scope' && e.fact.state === 'alive') &&
      args[2].length === 1
    ) {
      const now = Date.now;
      Date.now = () => now() + 60000;
    }
    return result;
  };
  const receipt = port.receipt.bind(port);
  port.receipt = async (...args) => {
    if (config.natural) {
      mark('natural-import');
      await wait('release-natural');
    }
    return receipt(...args);
  };
  return port;
}
