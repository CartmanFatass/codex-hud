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
import { fixture } from '../fixtures/b21-process.mjs';
