import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openLedger } from '../../dist-test/src/ledger/ledger.js';
import { acceptIntent } from '../../dist-test/src/ledger/intents.js';
import { ReadControlService } from '../../dist-test/packages/hud-mcp/src/read-control.js';
import { intent } from '../ledger/fixtures.mjs';
class Worker {
  constructor(home) {
    this.pending = [];
    this.serial = 0;
    this.messages = [];
    this.child = fork(resolve('tests/int/b21-worker.mjs'), [join(home, 'ledger.sqlite')], {
      env: { ...process.env, HUD_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: [],
    });
    this.stderr = '';
    this.child.stderr.on('data', (x) => (this.stderr += x));
    this.child.on('message', (m) => {
      const i = this.pending.findIndex((x) => x.match(m));
      if (i < 0) this.messages.push(m);
      else this.pending.splice(i, 1)[0].resolve(m);
    });
    this.done = new Promise((r) =>
      this.child.once('exit', () => {
        this.ended = true;
        for (const w of this.pending.splice(0)) w.reject(new Error('child exited ' + this.stderr));
        r();
      })
    );
  }
  wait(match) {
    const i = this.messages.findIndex(match);
    if (i >= 0) return Promise.resolve(this.messages.splice(i, 1)[0]);
    return new Promise((resolve, reject) => this.pending.push({ match, resolve, reject }));
  }
  async call(action, args = {}) {
    const id = ++this.serial;
    const answer = this.wait((m) => m.id === id);
    this.child.send({ id, action, ...args });
    const m = await answer;
    if (m.error) throw Object.assign(new Error(m.error), { code: m.code });
    return m.result;
  }
  async kill() {
    if (!this.ended) this.child.kill('SIGKILL');
    await this.done;
  }
}
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'hud-b21-process-'));
  const children = [];
  t.after(async () => {
    await Promise.all(children.map((c) => c.kill()));
    await rm(home, { recursive: true, force: true });
  });
  async function worker() {
    const w = new Worker(home);
    children.push(w);
    await w.wait((m) => m.type === 'ready');
    return w;
  }
  const seed = await worker();
  await seed.call('seed');
  return { home, worker, seed };
}
export { fixture };
