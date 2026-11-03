import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, root, ref, collected } from './b9-fixture.mjs';
import { openLinkLedgerReader } from '../../dist/core/link-ledger-read.js';
import { LinkTickCollector } from '../../dist/core/link/tick.js';
import { loadLimits } from '../../dist/core/link/limits.js';
import { displayNodeKey } from '../../dist/core/observation.js';

test('B10D tick planning retains a completed cursor node while followers remain eligible', async (t) => {
  const f = await fixture({ links: 0 }),
    ids = [root, ...['F1', 'A', 'B'].map((id) => ref(id))];
  ids.slice(1).forEach((id, i) => f.addLink('fair' + i, root, id));
  let enabled = false;
  const eligible = new Set(ids.map((r) => r.sessionId)),
    grants = [];
  const port = {
    immutableSnapshots: true,
    sessions: () => ids.map((r) => collected(r)),
    pending: (r) => (enabled && eligible.has(r.sessionId) ? 'session' : null),
    collect: async (r) => {
      grants.push(r.sessionId);
      if (r.sessionId === 'A') eligible.delete('A');
      return null;
    },
  };
  const reader = await openLinkLedgerReader(f.path),
    c = new LinkTickCollector(reader, f.home, loadLimits(f.home), port);
  t.after(() => {
    c.close();
    f.cleanup();
  });
  const roots = [{ kind: 'session', ref: root }];
  await c.tick({ roots });
  // Fixed retained order is root,F1,A,B for this tree; obtain the actual bounded order before granting.
  const order = c.current().tree.nodes.map((n) => n.identity.ref.sessionId);
  assert.equal(order.length, 4);
  const a = order.indexOf('A'),
    next = order[(a + 1) % order.length];
  c.cursor = displayNodeKey({ kind: 'session', ref: ids.find((r) => r.sessionId === 'A') });
  eligible.delete('A');
  enabled = true;
  await c.tick({ roots, deadline: performance.now() + 100 });
  assert.deepEqual(grants, [next]);
  assert.equal(c.stats().eligibleBacklog, 3);
});
