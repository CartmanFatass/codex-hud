import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { nextIntent, notifyFixture, acceptIntent, completion, factEvidence, reportFor } from './b21-fixture.js';
import { readCapacity } from '../../src/ledger/intents.js';
import { sessionOwnerKey } from '../../src/core/identity.js';
import { commitReconcile, readReconcileSnapshot } from '../../src/ledger/reconcile.js';
import { ReadControlService } from '../../packages/hud-mcp/src/read-control.js';
import { delegationBenchmarkFixture } from './b45-delegation-fixture.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
const opts = { skip: !ledgerRuntimeSupported() };

test(
  'B21 per-owner and global limits compose; same-key replay wins at capacity, refusal has no idempotency/slot leak',
  opts,
  async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    const other = await f.actor('other', 40000, 'other-parent');
    for (let i = 0; i < 3; i++) assert.ok((await acceptIntent(f.ledger, nextIntent(f, 'self-' + i))).runId);
    let refusal = await acceptIntent(f.ledger, nextIntent(f, 'self-full'));
    assert.equal((refusal.outcome as any).code, 'concurrency_limit');
    assert.equal((refusal.outcome as any).limit, 4);
    assert.equal((refusal.outcome as any).retryAdvisable, false);
    assert.equal(refusal.runId, null);
    for (let i = 0; i < 2; i++) assert.ok((await acceptIntent(f.ledger, nextIntent(f, 'other-' + i, other))).runId);
    refusal = await acceptIntent(f.ledger, nextIntent(f, 'global-full', other));
    assert.equal((refusal.outcome as any).active, 6);
    assert.equal((refusal.outcome as any).limit, 6);
    assert.equal((refusal.outcome as any).retryAdvisable, true);
    const replay = await acceptIntent(f.ledger, nextIntent(f, 'other-0', other));
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, 'run-other-0');
    assert.equal(
      f.ledger.snapshot((tx) => Number(tx.get('SELECT count(*) AS n FROM idempotency')!.n)),
      6
    );
    assert.equal(
      f.ledger.snapshot((tx) => Number(tx.get('SELECT count(*) AS n FROM slots')!.n)),
      6
    );
    await f.ledger.transaction((tx) => tx.run("UPDATE runs SET state='uncertain' WHERE run_id='run-a'"));
    refusal = await acceptIntent(f.ledger, nextIntent(f, 'uncertain-full', other));
    assert.equal((refusal.outcome as any).retryAdvisable, false);
    const service = new ReadControlService(f.ledger, f.root);
    t.after(() => service.close());
    const status = await service.status({ runId: 'run-other-0' }, () => other.authority);
    assert.deepEqual(
      (status as any).capacity,
      f.ledger.snapshot((tx) => {
        const { active, limit, occupants } = readCapacity(tx, sessionOwnerKey(other.ref));
        return { active, limit, occupants };
      })
    );
    assert.equal((status as any).termination, null);
  }
);

test(
  'B21 reported-but-alive and uncertain runs retain slots; only established termination frees capacity and refusal key may succeed later',
  opts,
  async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    const limits = { maxActiveRuns: 1, maxActiveRunsPerOwner: 1 };
    // A report state is independent of the execution slot, including a final report.
    await reportFor(f, 'completed');
    const proposal = nextIntent(f, 'later');
    assert.equal(
      ((await acceptIntent(f.ledger, proposal, 20, undefined, limits)).outcome as any).code,
      'concurrency_limit'
    );
    const end = await commitReconcile(
      f.ledger,
      readReconcileSnapshot(f.ledger, 'run-a'),
      [factEvidence(f, 'end', completion, 1050)],
      1050
    );
    assert.ok(end.committed);
    assert.equal(end.decision.state, 'ended');
    assert.equal((await acceptIntent(f.ledger, proposal, 20, undefined, limits)).runId, 'run-later');
  }
);

test('B21 real-SQLite MCP refusal is stable and never dispatches a launch', opts, async (t) => {
  const f = await delegationBenchmarkFixture();
  t.after(() => {
    f.service.close();
    return f.close();
  });
  // Default owner cap 4, including fixture run-a.
  for (let i = 0; i < 3; i++) await acceptIntent(f.ledger, nextIntent(f, 'occupied-' + i));
  const source = f.source();
  const result: any = await f.service.invoke(
    source,
    'delegate_spawn',
    { ...f.spawnArgs, request_key: 'refused-mcp' },
    performance.now()
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'concurrency_limit');
  assert.equal(result.active, 4);
  assert.equal(result.retryAdvisable, false);
  assert.equal(f.launches.length, 0);
  assert.equal(
    f.ledger.snapshot((tx) => tx.get("SELECT 1 FROM idempotency WHERE request_key='refused-mcp'")),
    undefined
  );
});

test('B21 configured limits reach MCP admission and the same status snapshot', opts, async (t) => {
  const f = await delegationBenchmarkFixture();
  t.after(() => f.close());
  const { DelegationService } = await import('../../packages/hud-mcp/src/delegation.js');
  const profile = {
    name: 'codex',
    harness: 'codex' as const,
    source: { root: f.root, label: 'Synthetic' },
    launch: { argv: [process.execPath] },
    headless: { argv: [process.execPath, 'exec', '-'] },
    resume: null,
    resumeHeadless: null,
    host: { kind: 'none' as const, layout: 'none' as const },
    env: { CODEX_HOME: f.root },
    mcpServerName: 'hud',
    claimTransport: 'config_env' as const,
    clientToolTimeoutMs: 60000,
    responseMarginMs: 2000,
    orphan_policy: 'continue' as const,
    managedShellVerified: false,
    roles: { implementer: { model: 'synthetic-model', effort: 'low' } },
  };
  let dispatched = 0;
  const service = new DelegationService({
    ledger: f.ledger,
    home: f.root,
    config: { version: 1, profiles: [profile], limits: { maxActiveRuns: 1, maxActiveRunsPerOwner: 1 } },
    registration: f.parent.registration,
    reader: f.reader,
    env: {},
    hudRunPath: 'bin/hud-run',
    capability: { verify: () => ({ ok: true, reason: null }) },
    launch: async () => {
      dispatched++;
      return { pid: 123, completion: Promise.resolve({ code: 0, signal: null }) };
    },
  });
  t.after(() => service.close());
  const response: any = await service.invoke(
    f.source(),
    'delegate_spawn',
    { ...f.spawnArgs, request_key: 'configured-refusal' },
    performance.now()
  );
  assert.equal(response.code, 'concurrency_limit');
  assert.equal(response.limit, 1);
  assert.equal(dispatched, 0);
  const status: any = await service.invoke(f.source(), 'delegate_status', { runId: 'run-a' });
  assert.equal(status.capacity.active, 1);
  assert.equal(status.capacity.limit, 1);
});

test(
  'B21 canonical proc-to-session owner alias preserves capacity occupancy and replay at owner limit',
  opts,
  async (t) => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join, resolve } = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const { openLedger } = await import('../../src/ledger/ledger.js');
    const { bindOwnerScope } = await import('../../src/ledger/identity.js');
    const fixtures = await import(pathToFileURL(resolve('tests/ledger/fixtures.mjs')).href);
    const home = await mkdtemp(join(tmpdir(), 'hud-b21-alias-'));
    const ledger = await openLedger(join(home, 'ledger.sqlite'));
    t.after(async () => {
      await ledger.close();
      await rm(home, { recursive: true, force: true });
    });
    await fixtures.seedCaller(ledger);
    const original = fixtures.intent('alias-original');
    const limits = { maxActiveRuns: 6, maxActiveRunsPerOwner: 1 };
    const accepted = await acceptIntent(ledger, original, 20, undefined, limits);
    const ref = original.authority.evidence.sessionRef;
    await bindOwnerScope(ledger, {
      processKey: original.authority.evidence.processKey,
      generation: 1,
      sessionRef: ref,
      boundBy: 'trusted_session',
      evidence: {
        evidenceId: 'alias-binding',
        runId: null,
        linkId: null,
        kind: 'trusted_session',
        producer: 'reconciler',
        fingerprint: 'a'.repeat(64),
        payload: {},
        observedAt: 1001,
        validatedAt: 1001,
        validation: 'accepted',
      },
      at: 1001,
    });
    const capacity = ledger.snapshot((tx) => readCapacity(tx, sessionOwnerKey(ref), limits));
    assert.equal(capacity.active, 1);
    assert.equal(capacity.occupants[0].holder, 'self');
    assert.equal(capacity.limit, 1);
    assert.equal((await acceptIntent(ledger, original, 20, undefined, limits)).runId, accepted.runId);
    const next = fixtures.intent('alias-next');
    next.requestKey = 'alias-new-key';
    next.link.parentRef = ref;
    const refused = await acceptIntent(ledger, next, 20, undefined, limits);
    assert.equal((refused.outcome as any).code, 'concurrency_limit');
    assert.equal((refused.outcome as any).retryAdvisable, false);
    assert.equal(
      ledger.snapshot((tx) => tx.get('SELECT owner_key FROM idempotency')!.owner_key),
      sessionOwnerKey(ref)
    );
  }
);
