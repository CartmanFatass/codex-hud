import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { skip, REF, commit, candidate, fixture } from '../fixtures/b12-store-perf.js';

test(
  'B12 cost: 1000 publishes/reads, unchanged ages and early renewals cause zero database writes',
  {
    skip:
      skip || (process.env.B12_BENCHMARK !== '1' && 'set B12_BENCHMARK=1 for the isolated 1000-sample disk benchmark'),
    timeout: 60_000,
  },
  async (t) => {
    const f = await fixture(t);
    const store = await f.open();
    const lease = store.acquire(REF, 'panel');
    const publish: number[] = [];
    const read: number[] = [];
    let bytes = 0;
    const before = process.resourceUsage();
    const startSize = fs.statSync(store.databasePath).size;
    for (let seq = 1; seq <= 1050; seq++) {
      const prepared = candidate(commit(seq));
      let start = performance.now();
      const result = store.publish(prepared, lease);
      if (seq > 50) {
        publish.push(performance.now() - start);
        bytes += result.bytes;
      }
      start = performance.now();
      const current = store.readCurrent(REF)!;
      if (seq > 50) read.push(performance.now() - start);
      assert.equal(current.commitSeq, seq);
    }
    const afterPublish = process.resourceUsage();
    const file = fs.readFileSync(store.databasePath);
    const stat = fs.statSync(store.databasePath);
    const idleStart = process.resourceUsage();
    for (let n = 0; n < 1000; n++) {
      const same = store.readCurrent(REF)!;
      same.commitSeq++;
      same.observationStamp.commitSeq++;
      same.summary.statusProjection.observedAt += n;
      same.summary.statusProjection.observationStamp = same.observationStamp;
      assert.deepEqual(store.publish(candidate(same), lease), { changed: false, commitSeq: 1050, bytes: 0 });
      store.renew(REF, lease);
    }
    const idleEnd = process.resourceUsage();
    assert.equal(idleEnd.fsWrite - idleStart.fsWrite, 0);
    assert.equal(fs.statSync(store.databasePath).mtimeMs, stat.mtimeMs);
    assert.deepEqual(fs.readFileSync(store.databasePath), file);
    if (process.env.B12_BENCHMARK_OUTPUT)
      fs.writeFileSync(
        process.env.B12_BENCHMARK_OUTPUT,
        JSON.stringify({
          publishMs: publish,
          readMs: read,
          serializedBytesPerCommit: bytes / 1000,
          fsWrite512ByteBlocksPerCommit: (afterPublish.fsWrite - before.fsWrite) / 1050,
          unchangedTickWrites: idleEnd.fsWrite - idleStart.fsWrite,
        })
      );
    const distribution = (samples: number[]) => {
      samples.sort((a, b) => a - b);
      return {
        n: samples.length,
        p50: samples[499],
        p95: samples[949],
        p99: samples[989],
        max: samples[999],
        over50: samples.filter((n) => n >= 50).length,
      };
    };
    t.diagnostic(
      JSON.stringify({
        publishMs: distribution(publish),
        readMs: distribution(read),
        serializedBytesPerCommit: bytes / 1000,
        fsWrite512ByteBlocksPerCommit: (afterPublish.fsWrite - before.fsWrite) / 1050,
        databaseGrowthBytes: fs.statSync(store.databasePath).size - startSize,
        unchangedTickWrites: idleEnd.fsWrite - idleStart.fsWrite,
      })
    );
  }
);
