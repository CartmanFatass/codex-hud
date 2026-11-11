import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyFixture } from '../unit/b21-fixture.js';
import { recordWakeDelivered } from '../../src/ledger/notify-events.js';
import { insertRecord } from '../../src/ledger/records.js';
import { ReadControlService } from '../../packages/hud-mcp/src/read-control.js';
import { skip, register, event } from '../fixtures/b19-drainer-perf.js';

test(
  'B19 status reduction stays below50ms with1000 accepted batches and preserves an older unconfirmed interval',
  { skip },
  async (t) => {
    const f = await notifyFixture();
    const reg = await register(f);
    t.after(() => f.close());
    await f.ledger.transaction((tx) => {
      for (let i = 0; i < 1000; i++) {
        insertRecord(tx, 'events', {
          runId: 'run-a',
          linkId: 'link-a',
          kind: 'run.state',
          payload: { state: 'uncertain' },
          at: Date.now(),
        });
        const throughSeq = Number(tx.get('SELECT last_insert_rowid() AS n')!.n);
        recordWakeDelivered(
          tx,
          'link-a',
          { registrationSeq: reg, throughSeq, result: 'unknown', attempt: 1 },
          Date.now()
        );
        recordWakeDelivered(
          tx,
          'link-a',
          { registrationSeq: reg, throughSeq, result: 'accepted', attempt: 1 },
          Date.now()
        );
      }
    });
    const service = new ReadControlService(f.ledger, f.root);
    t.after(() => service.close());
    const samples: number[] = [];
    for (let i = 0; i < 25; i++) {
      const start = performance.now();
      const status = await service.status({ runId: 'run-a' }, () => f.parent.authority);
      samples.push(performance.now() - start);
      assert.equal(status.wake.state, 'registered');
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    assert.ok(p95 < 50, String(p95));
    t.diagnostic(
      `1000-batch status p50=${samples[12].toFixed(3)} p95=${p95.toFixed(3)} max=${samples.at(-1)!.toFixed(3)} ms`
    );
    const events = await event(f, 2);
    await f.ledger.transaction((tx) => {
      recordWakeDelivered(
        tx,
        'link-a',
        { registrationSeq: reg, throughSeq: events[0], result: 'unknown', attempt: 1 },
        Date.now()
      );
      recordWakeDelivered(
        tx,
        'link-a',
        { registrationSeq: reg, throughSeq: events[1], result: 'accepted', attempt: 1 },
        Date.now()
      );
    });
    assert.equal((await service.status({ runId: 'run-a' }, () => f.parent.authority)).wake.state, 'unconfirmed');
  }
);
