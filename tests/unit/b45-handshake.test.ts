import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { commitHandshake, readHandshakeSnapshot } from '../../src/ledger/handshake.js';
import { commitReconcile, readReconcileSnapshot } from '../../src/ledger/reconcile.js';
import { acceptIntent } from '../../src/ledger/intents.js';
import { readLink, refValue } from '../../src/ledger/records.js';
import { HandshakeService } from '../../packages/hud-mcp/src/handshake.js';
import { handshakeFixture, hashClaim } from './b45-handshake-fixture.js';
const skip = ledgerRuntimeSupported() ? false : 'Ledger requires Node 22 >=22.13 or >=24';

function service(f: Awaited<ReturnType<typeof handshakeFixture>>) {
  return new HandshakeService({
    ledger: f.ledger,
    registration: f.child.registration,
    reader: f.reader,
    env: { HUD_CLAIM: f.claim },
    now: f.now,
  });
}
test(
  'B45 handshake compares context and target snapshot after external proof; stale writers cannot consume',
  { skip },
  async () => {
    const f = await handshakeFixture();
    try {
      await f.startup();
      const expected = await readHandshakeSnapshot(f.ledger, hashClaim(f.claim), f.child.authority);
      await f.ledger.transaction((tx) =>
        tx.run(
          'UPDATE caller_contexts SET selection_evidence_id=? WHERE context_id=?',
          'identity-parent',
          f.child.context.contextId
        )
      );
      await assert.rejects(
        commitHandshake(
          f.ledger,
          expected,
          f.child.authority,
          hashClaim(f.claim),
          {
            evidenceId: 'synthetic-proof',
            runId: 'run-a',
            linkId: 'link-a',
            kind: 'launch_receipt',
            producer: 'reconciler',
            fingerprint: hashClaim('proof'),
            payload: {},
            observedAt: 1020,
            validatedAt: 1020,
            validation: 'accepted',
          },
          1020
        ),
        /stale_context/
      );
      assert.equal(
        f.ledger.snapshot((tx) => tx.get('SELECT state FROM claims')?.state),
        'armed'
      );
      assert.equal(
        f.ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM child_bindings')?.n),
        0
      );
    } finally {
      await f.close();
    }
  }
);

test(
  'B45 independent launch proof rejects reused PID, wrong domain, changed source and broad shared ancestry',
  { skip },
  async () => {
    for (const kind of ['pid', 'domain', 'source', 'ancestry'] as const) {
      const f = await handshakeFixture();
      try {
        await f.startup();
        const harness = f.processes.get(20000)!;
        if (kind === 'pid') harness.procStart = '999999';
        if (kind === 'source') harness.env.CODEX_HOME = '/missing-synthetic-source';
        if (kind === 'ancestry') f.processes.get(20001)!.ppid = 15000;
        const reader =
          kind === 'domain'
            ? { get: f.reader.get, domain: () => ({ ...f.reader.domain(), bootId: 'other-boot' }) }
            : f.reader;
        await assert.rejects(
          new HandshakeService({
            ledger: f.ledger,
            registration: f.child.registration,
            reader,
            env: { HUD_CLAIM: f.claim },
            now: f.now,
          }).whoami({}, f.child.authority),
          /claim_anchor_mismatch/
        );
        assert.equal(
          f.ledger.snapshot((tx) => tx.get('SELECT state FROM claims')?.state),
          'armed'
        );
      } finally {
        await f.close();
      }
    }
  }
);

test(
  'B45 report remains fixed to old run and rejects late reports after real resume acceptance',
  { skip },
  async () => {
    const f = await handshakeFixture();
    try {
      await f.startup();
      const child = service(f);
      await child.whoami({}, f.child.authority);
      assert.equal(
        (await child.report({ runId: 'run-a', status: 'completed', summary: 'Before resume' }, f.child.authority)).ok,
        true
      );
      const expected = readReconcileSnapshot(f.ledger, 'run-a');
      const fact = {
        evidenceId: 'synthetic-ended',
        runId: 'run-a',
        sourceId: f.source.sourceId,
        bindingGeneration: 1,
        supervisor: expected.run.supervisor,
        validation: 'accepted' as const,
        asOf: 1030,
        observedAt: 1030,
        fact: {
          kind: 'scope_reconciled' as const,
          complete: true,
          harnessTerminated: true,
          launchersSealed: true,
          nativeExit: null,
        },
      };
      const ended = await commitReconcile(
        f.ledger,
        expected,
        [
          {
            record: {
              evidenceId: fact.evidenceId,
              runId: 'run-a',
              linkId: 'link-a',
              kind: 'scope_reconciled',
              producer: 'reconciler',
              fingerprint: hashClaim('ended'),
              payload: {},
              observedAt: 1030,
              validatedAt: 1030,
              validation: 'accepted',
            },
            facts: [fact],
          },
        ],
        1030
      );
      assert.equal(ended.committed && ended.decision.state, 'ended');
      const resume = structuredClone(f.input);
      resume.requestKey = 'synthetic-resume';
      resume.newSession = false;
      resume.params = { ...resume.params, linkId: 'link-a', expectedRun: 'run-a' };
      resume.link = f.ledger.snapshot((tx) => readLink(tx, 'link-a'));
      resume.run = {
        ...resume.run,
        runId: 'run-b',
        runSeq: 2,
        operation: 'resume',
        targetSessionRef: f.child.ref,
        expectedGeneration: 2,
        launchTokenHash: hashClaim('ticket-b'),
        launchDigest: hashClaim('digest-b'),
        launchCallId: 'call-b',
        launchCorrelationId: 'correlation-b',
        createdAt: 1040,
      };
      resume.claim = {
        ...resume.claim,
        runId: 'run-b',
        claimHash: hashClaim('claim-b'),
        expectedGeneration: 2,
        issuedAt: 1040,
        expiresAt: 1801040,
      };
      await acceptIntent(f.ledger, resume);
      const rejected = await child.report(
        { runId: 'run-a', status: 'completed', summary: 'Late old run' },
        f.child.authority
      );
      assert.equal(rejected.ok, false);
      const rows = f.ledger.snapshot((tx) => ({
        reports: tx.all('SELECT * FROM reports'),
        rejected: tx.all("SELECT * FROM events WHERE kind='report.rejected'"),
        next: tx.get('SELECT * FROM runs WHERE run_id=?', 'run-b'),
        link: tx.get('SELECT state FROM links'),
      }));
      assert.equal(rows.reports.length, 1);
      assert.equal(rows.reports[0].run_id, 'run-a');
      assert.equal(rows.rejected.at(-1)?.run_id, 'run-a');
      assert.equal(rows.link?.state, 'bound');
      assert.equal(rows.next?.state, 'starting');
    } finally {
      await f.close();
    }
  }
);

test('B45 provisional slot collision makes both runs uncertain and preserves both slots', { skip }, async () => {
  const f = await handshakeFixture();
  try {
    await f.startup();
    const other = structuredClone(f.input);
    other.requestKey = 'second-spawn';
    other.link.linkId = 'link-other';
    other.run = {
      ...other.run,
      runId: 'run-other',
      linkId: 'link-other',
      launchCallId: 'call-other',
      launchCorrelationId: 'correlation-other',
      launchTokenHash: hashClaim('ticket-other'),
    };
    other.claim = { ...other.claim, runId: 'run-other', claimHash: hashClaim('claim-other') };
    await acceptIntent(f.ledger, other);
    await f.ledger.transaction((tx) =>
      tx.run(
        'UPDATE slots SET slot_key=?,session_ref=? WHERE run_id=?',
        refValue(f.child.ref),
        refValue(f.child.ref),
        'run-other'
      )
    );
    assert.deepEqual(await service(f).whoami({}, f.child.authority), { ok: false, code: 'provisional_conflict' });
    const rows = f.ledger.snapshot((tx) => ({
      runs: tx.all('SELECT state FROM runs'),
      slots: tx.all('SELECT * FROM slots'),
      bindings: tx.all('SELECT * FROM child_bindings'),
    }));
    assert.ok(rows.runs.every((run) => run.state === 'uncertain'));
    assert.equal(rows.slots.length, 2);
    assert.equal(rows.bindings.length, 0);
  } finally {
    await f.close();
  }
});

test('B45 exhausted per-call deadline rolls back report and accepts no claim', { skip }, async () => {
  const f = await handshakeFixture();
  try {
    await f.startup();
    const child = service(f);
    await assert.rejects(
      child.whoami({}, f.child.authority, { deadline: performance.now() - 1, lockBudgetMs: 20 }),
      /Ledger busy/
    );
    assert.equal(
      f.ledger.snapshot((tx) => tx.get('SELECT state FROM claims')?.state),
      'armed'
    );
    await child.whoami({}, f.child.authority);
    await assert.rejects(
      child.report({ runId: 'run-a', status: 'completed', summary: 'Expired budget' }, f.child.authority, {
        deadline: performance.now() - 1,
        lockBudgetMs: 20,
      }),
      /Ledger busy/
    );
    assert.equal(
      f.ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM reports')?.n),
      0
    );
  } finally {
    await f.close();
  }
});
