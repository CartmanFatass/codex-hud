import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { runtimeFixture } from './b10a-runtime-fixture.mjs';
import { ledgerRuntimeSupported } from '../../dist/ledger/runtime.js';

test(
  'B10A actual runtime bounds metadata polling with 20000 real source headers',
  { skip: !ledgerRuntimeSupported() },
  async (t) => {
    const f = await runtimeFixture(200, 20000);
    t.after(f.cleanup);
    let view;
    for (let tick = 0; tick < 3000; tick++) {
      view = await f.runtime.tick(f.parent.sessionId);
      assert.ok(f.runtime.collector.stats().bytesRead <= 8 * 1024 * 1024);
      if (view?.tree.nodes.length === 200 && view.tree.nodes.every((n) => n.loaded) && view.pendingStatus === 0) break;
    }
    assert.equal(view.tree.nodes.length, 200);
    assert.ok(view.tree.nodes.every((n) => n.loaded));
    const source = f.runtime.port.sources.get(f.parent.sourceId),
      catalog = source.adapter.topologies.get(f.parent.sourceId);
    assert.equal(catalog.headers.size, 20000);
    for (let i = 0; i < 100; i++) {
      catalog.pollMetadata(performance.now() + 20, 32, f.parent);
      assert.ok(catalog.metadataChecks() <= 32);
      assert.ok(catalog.file(f.parent));
      catalog.changed();
    }
  }
);
