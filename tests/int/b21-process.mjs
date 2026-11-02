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
test(
  'B21 capacity race: eight separate writer processes accept exactly six; full replay precedes capacity; no slot/idempotency leaks',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const workers = [f.seed];
    for (let i = 1; i < 8; i++) workers.push(await f.worker());
    let results = await Promise.allSettled(workers.map((w, i) => w.call('intent', { variant: 'race-' + i })));
    // Preserve the simultaneous first attempts; retry only an explicit,
    // uncommitted busy result after every contender has returned. Serial caller
    // retries avoid turning scheduler pressure into another artificial lock race.
    for (let i = 0; i < results.length; i++) {
      for (
        let retry = 0;
        retry < 3 && results[i].status === 'rejected' && results[i].reason.code === 'ledger_busy';
        retry++
      ) {
        t.diagnostic('Explicit same-key caller retry after the concurrent attempts exhausted a 20 ms budget.');
        try {
          results[i] = { status: 'fulfilled', value: await workers[i].call('intent', { variant: 'race-' + i }) };
        } catch (reason) {
          results[i] = { status: 'rejected', reason };
        }
      }
    }
    const values = results.map((r) => {
      if (r.status === 'rejected') throw r.reason;
      return r.value;
    });
    assert.equal(values.filter((v) => v.runId !== null).length, 6);
    assert.equal(values.filter((v) => v.outcome.code === 'concurrency_limit').length, 2);
    const counts = await f.seed.call('inspect');
    assert.deepEqual(counts, { runs: 6, slots: 6, idempotency: 6, links: 6 });
    const winner = values.findIndex((v) => v.runId);
    const replay = await f.seed.call('intent', { variant: 'new-material', key: 'key-race-' + winner });
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, values[winner].runId);
  }
);
test(
  'B21 kill -9 writer inside capacity transaction rolls back reserved run and slot',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const writer = await f.worker();
    const request = writer.call('intent', { variant: 'crashed', cut: true }).catch((e) => e);
    await writer.wait((m) => m.type === 'cut');
    await writer.kill();
    assert.equal(writer.child.signalCode, 'SIGKILL');
    assert.ok((await request) instanceof Error);
    assert.deepEqual(await f.seed.call('inspect'), { runs: 0, slots: 0, idempotency: 0, links: 0 });
    assert.equal((await f.seed.call('intent', { variant: 'crashed' })).runId, 'run-crashed');
  }
);
function stats(values) {
  const a = values.toSorted((x, y) => x - y);
  return {
    n: a.length,
    p50: a[Math.floor(a.length * 0.5)] ?? null,
    p95: a[Math.floor(a.length * 0.95)] ?? null,
    max: a.at(-1) ?? null,
  };
}
test(
  'B21 acceptIntent and delegate_status p95 below 50ms with four concurrent real SQLite writers and six occupants',
  { timeout: 60000, skip: process.env.B21_PERF !== '1' ? 'Run B21_PERF=1 for isolated performance acceptance' : false },
  async (t) => {
    const f = await fixture(t);
    for (let i = 0; i < 6; i++) await f.seed.call('intent', { variant: 'perf-' + i });
    const writers = [];
    for (let i = 0; i < 4; i++) writers.push(await f.worker());
    const ledger = await openLedger(join(f.home, 'ledger.sqlite'));
    const service = new ReadControlService(
      ledger,
      f.home,
      undefined,
      {},
      { maxActiveRuns: 6, maxActiveRunsPerOwner: 6 }
    );
    t.after(async () => {
      service.close();
      await ledger.close();
    });
    const loads = writers.map((w) => w.call('load', { count: 2000 }));
    const measurements = { accept_replay: [], accept_refusal: [], accept_busy: [], delegate_status: [] };
    for (let i = 0; i < 500; i++) {
      const p = intent('probe-' + i);
      p.requestKey = i % 2 === 0 ? 'key-perf-0' : 'new-' + i;
      let start = performance.now();
      try {
        const result = await acceptIntent(ledger, p, 20, undefined, { maxActiveRuns: 6, maxActiveRunsPerOwner: 6 });
        measurements[result.replayed ? 'accept_replay' : 'accept_refusal'].push(performance.now() - start);
      } catch (e) {
        if (e.code !== 'ledger_busy') throw e;
        measurements.accept_busy.push(performance.now() - start);
      }
      start = performance.now();
      const status = await service.status({ runId: 'run-perf-0' }, () => p.authority);
      assert.equal(status.capacity.active, 6);
      measurements.delegate_status.push(performance.now() - start);
    }
    await Promise.all(loads);
    const output = Object.fromEntries(Object.entries(measurements).map(([k, v]) => [k, stats(v)]));
    console.log(
      'B21_PERF ' +
        JSON.stringify({
          node: process.versions.node,
          sqlite: ledger.snapshot((tx) => tx.get('SELECT sqlite_version() AS version').version),
          writers: 4,
          occupants: 6,
          ...output,
        })
    );
    for (const [name, s] of Object.entries(output)) if (s.n) assert.ok(s.p95 < 50, name + ' p95=' + s.p95);
    assert.ok(output.accept_replay.n > 0);
    assert.ok(output.accept_refusal.n > 0);
    assert.equal(output.delegate_status.n, 500);
  }
);
