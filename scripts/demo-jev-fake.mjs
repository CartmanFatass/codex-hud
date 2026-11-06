// SIMULATED only: independent temporary SQLite, no provider/browser/network action.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableJevLab, SimulatedJevReader } from '../dist-test/tests/fakes/jev-durable.js';
const root = mkdtempSync(join(tmpdir(), 'jev-durable-demo-'));
const path = join(root, 'simulation.sqlite'),
  owner = 'synthetic-owner';
const first = { kind: 'jev', provider: 'synthetic-ask', account: 'synthetic-one', key: 'synthetic-question' };
const second = { kind: 'jev', provider: 'synthetic-ask', account: 'synthetic-two', key: 'synthetic-followup' };
let lab, reader;
try {
  lab = DurableJevLab.create(path);
  for (const ref of [first, second])
    lab.enqueue({
      owner,
      label: 'synthetic-holder',
      browser: 'synthetic-browser',
      ref,
      requestId: `synthetic-id-${ref.key}`,
      requestFingerprint: `synthetic-request-${ref.key}`,
    });
  const storeId = lab.snapshot().storeId;
  reader = new SimulatedJevReader(path, storeId);
  const readAvailable = () => {
    const view = reader.snapshot();
    if (view.availability !== 'available') throw Error(`simulation_store_unavailable:${view.reason}`);
    return view;
  };
  const current = (ref) => readAvailable().jobs.find((j) => j.ref.key === ref.key);
  const show = () => {
    const view = readAvailable();
    for (const j of view.jobs)
      console.log(
        `SIMULATED durable Jev ${j.ref.key} · ${j.state} · holder ${j.holderLabel ?? 'unlabelled'} · generation ${j.lease?.generation ?? 'none'} · revision ${view.revision}`
      );
  };
  const ticket = lab.consumeDispatch(owner, first, current(first).revision);
  lab.close();
  lab = DurableJevLab.open(path, storeId); // Lost acknowledgement; consumed ticket stays uncertain.
  show();
  lab.observe(owner, first, ticket.generation, current(first).revision, 'needs_human');
  show();
  lab.observe(owner, first, ticket.generation, current(first).revision, 'answered', 'synthetic-evidence');
  lab.reconcile(
    owner,
    first,
    ticket.generation,
    current(first).revision,
    'answered',
    'synthetic-evidence',
    'synthetic-answer'
  );
  const next = lab.consumeDispatch(owner, second, current(second).revision);
  lab.observe(owner, second, next.generation, next.revision, 'sent');
  show();
  console.log('SIMULATED only: no live recovery, external exactly-once guarantee or production capability.');
} finally {
  reader?.close();
  lab?.close();
  rmSync(root, { recursive: true, force: true });
}
