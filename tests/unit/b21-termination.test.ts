import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notifyFixture, retire, completion, factEvidence, reportFor } from './b21-fixture.js';
import { recordRetireRequested } from '../../src/ledger/notify-events.js';
import { insertRecord } from '../../src/ledger/records.js';
import { commitReconcile, readReconcileSnapshot, requestCancel } from '../../src/ledger/reconcile.js';
import { ReadControlService } from '../../packages/hud-mcp/src/read-control.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import type { Termination } from '../../src/core/types/execution.js';
const opts = { skip: !ledgerRuntimeSupported() };
async function finish(
  f: Awaited<ReturnType<typeof notifyFixture>>,
  facts = [factEvidence(f, 'complete', completion, 1050)]
) {
  const result = await commitReconcile(f.ledger, readReconcileSnapshot(f.ledger, 'run-a'), facts, 1060);
  assert.ok(result.committed);
  const service = new ReadControlService(f.ledger, f.root);
  try {
    const status = await service.status({ runId: 'run-a' }, () => f.parent.authority);
    return { result, status, termination: status.termination as Termination };
  } finally {
    service.close();
  }
}
for (const [report, outcome] of [
  ['completed', 'completed'],
  ['failed', 'failed'],
  ['blocked', 'blocked'],
  ['interrupted', 'blocked'],
] as const) {
  test(
    'B21 termination outcome ' + report + ' maps to ' + outcome + ' without changing report status',
    opts,
    async (t) => {
      const f = await notifyFixture();
      t.after(() => f.close());
      await reportFor(f, report);
      const { status, termination } = await finish(f);
      assert.equal(termination.outcome, outcome);
      assert.equal(status.latestReportForRun?.status, report);
      assert.equal(status.currentRun.state, 'ended');
      assert.equal(termination.observed.scopeEvidence, 'Q');
    }
  );
}
test(
  'B21 no attributable accepted report means unknown outcome; native exit fields stay independent',
  opts,
  async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    const { termination } = await finish(f, [
      factEvidence(
        f,
        'receipt',
        { ...completion, kind: 'receipt', nativeExit: { code: 7, signal: null, source: 'wait_status' } },
        1050
      ),
    ]);
    assert.equal(termination.outcome, 'unknown');
    assert.equal(termination.requestedCause, null);
    assert.equal(termination.observed.exitCode, 7);
    assert.equal(termination.observed.scopeEvidence, 'R');
  }
);
for (const attribution of ['caused', 'not_caused', 'unknown'] as const) {
  test(
    'B21 policy retirement attribution ' + attribution + ' ends as ended and preserves independent outcome',
    opts,
    async (t) => {
      const f = await notifyFixture();
      t.after(() => f.close());
      await reportFor(f, 'completed');
      const req = await f.ledger.transaction((tx) => recordRetireRequested(tx, 'run-a', retire, 1030));
      const facts = [];
      if (attribution === 'caused') {
        await f.ledger.transaction((tx) =>
          insertRecord(tx, 'events', {
            runId: 'run-a',
            linkId: 'link-a',
            kind: 'cancel.step',
            payload: { requestSeq: req, signal: 'SIGINT', ack: true },
            at: 1031,
          })
        );
        facts.push(
          factEvidence(
            f,
            'alive',
            { kind: 'scope', state: 'alive', complete: false, harnessTerminated: false, launchersSealed: false },
            1032
          )
        );
      }
      facts.push(factEvidence(f, 'done', completion, attribution === 'not_caused' ? 1025 : 1050));
      const { status, termination } = await finish(f, facts);
      assert.equal(status.currentRun.state, 'ended');
      assert.equal(termination.requestedCause, 'retire_after_report');
      assert.equal(termination.outcome, 'completed');
      assert.equal(termination.attribution, attribution);
      assert.equal(status.terminalNote, attribution === 'unknown' ? 'retire_timing_unknown' : null);
      assert.equal(status.capacity.active, 0);
      const count = f.ledger.snapshot((tx) =>
        Number(tx.get("SELECT count(*) AS n FROM events WHERE kind='run.terminal'")!.n)
      );
      const again = await commitReconcile(f.ledger, readReconcileSnapshot(f.ledger, 'run-a'), [], 1070);
      assert.ok(again.committed);
      assert.equal(again.decision.row, 'R-02-0');
      assert.equal(
        f.ledger.snapshot((tx) => Number(tx.get("SELECT count(*) AS n FROM events WHERE kind='run.terminal'")!.n)),
        count
      );
    }
  );
}
test(
  'B21 runtime policy cancel chronology never selects cancelled; contradictory chronology still preserves X and slot',
  opts,
  async (t) => {
    for (const conflict of [false, true]) {
      const f = await notifyFixture();
      t.after(() => f.close());
      await f.ledger.transaction((tx) => {
        recordRetireRequested(tx, 'run-a', { ...retire, cause: 'runtime_limit', rule: 'max_runtime' }, 1030);
        tx.run("UPDATE runs SET cancel_requested_at=1030,state='cancelling' WHERE run_id='run-a'");
      });
      const facts = [
        factEvidence(f, 'done', completion, 1050),
        factEvidence(f, 'before', { kind: 'cancel', chronology: 'before_exit' }, 1040),
      ];
      if (conflict) facts.push(factEvidence(f, 'after', { kind: 'cancel', chronology: 'after_exit' }, 1051));
      const result = await commitReconcile(f.ledger, readReconcileSnapshot(f.ledger, 'run-a'), facts, 1060);
      assert.ok(result.committed);
      assert.equal(result.decision.state, conflict ? 'uncertain' : 'ended');
      assert.equal(result.decision.releaseSlot, !conflict);
    }
  }
);
for (const actor of ['mcp', 'local_user', 'trusted_local', 'orphan_policy'] as const) {
  test('B21 R-02-2 remains available for ' + actor + ' accepted cancellation only', opts, async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    if (actor === 'mcp')
      await requestCancel(f.ledger, readReconcileSnapshot(f.ledger, 'run-a'), f.parent.authority, 1030);
    else
      await f.ledger.transaction((tx) => {
        if (actor === 'orphan_policy') {
          tx.run("UPDATE runs SET orphan_policy='stop' WHERE run_id='run-a'");
          insertRecord(tx, 'events', {
            runId: 'run-a',
            linkId: 'link-a',
            kind: 'parent.offline',
            payload: {
              orphanPolicy: 'stop',
              since: 1029,
              contextId: f.parent.context.contextId,
              generation: f.parent.context.generation,
            },
            at: 1029,
          });
        }
        tx.run("UPDATE runs SET cancel_requested_at=1030,state='cancelling' WHERE run_id='run-a'");
        insertRecord(tx, 'events', {
          runId: 'run-a',
          linkId: 'link-a',
          kind: 'cancel.accepted',
          payload: {
            actor:
              actor === 'orphan_policy'
                ? { kind: actor, supervisor: f.meta.supervisor }
                : actor === 'local_user'
                  ? {
                      kind: actor,
                      uid: 1000,
                      invocationId: 'synthetic-user',
                      representedOwner: f.registration.ownerKey,
                    }
                  : { kind: actor, uid: 1000, invocationId: 'synthetic-local' },
            runId: 'run-a',
            bindingGeneration: 1,
            graceMs: 10000,
          },
          at: 1030,
        });
      });
    const { status, termination } = await finish(f, [
      factEvidence(f, 'done', completion, 1050),
      factEvidence(f, 'before', { kind: 'cancel', chronology: 'before_exit' }, 1040),
    ]);
    assert.equal(status.currentRun.state, 'cancelled');
    assert.equal(termination.requestedCause, actor === 'orphan_policy' ? 'orphan_policy' : 'user_cancel');
    assert.equal(termination.attribution, 'caused');
  });
}

test(
  'B21 terminal outcome uses latest accepted report seq; concurrent report invalidates stale terminal snapshot; terminal outcome is immutable',
  opts,
  async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    await reportFor(f, 'failed');
    const snapshot = readReconcileSnapshot(f.ledger, 'run-a');
    const { HandshakeService } = await import('../../packages/hud-mcp/src/handshake.js');
    const reports = new HandshakeService({
      ledger: f.ledger,
      registration: f.child.registration,
      reader: f.reader,
      env: { HUD_CLAIM: f.claim },
      now: f.now,
    });
    await reports.report(
      { runId: 'run-a', status: 'interrupted', summary: 'Synthetic latest outcome' },
      f.child.authority
    );
    await f.ledger.transaction((tx) => tx.run("UPDATE reports SET created_at=1 WHERE status='interrupted'"));
    const stale = await commitReconcile(f.ledger, snapshot, [factEvidence(f, 'stale-end', completion, 1050)], 1060);
    assert.equal(stale.committed, false);
    const { termination } = await finish(f);
    assert.equal(termination.outcome, 'blocked');
    await reports.report({ runId: 'run-a', status: 'completed', summary: 'Synthetic late report' }, f.child.authority);
    const repeated = await finish(f, []);
    assert.equal(repeated.termination.outcome, 'blocked');
    assert.equal(repeated.result.decision.row, 'R-02-0');
  }
);
test('B21 a report row without an accepted same-run/link event cannot supply termination outcome', opts, async (t) => {
  const f = await notifyFixture();
  t.after(() => f.close());
  await reportFor(f, 'completed');
  await f.ledger.transaction((tx) => tx.run("UPDATE events SET kind='report.rejected' WHERE kind='report.received'"));
  assert.equal((await finish(f)).termination.outcome, 'unknown');
});
for (const chronology of ['after_exit', 'unknown'] as const) {
  test('B21 accepted user cancellation ' + chronology + ' preserves ended and the correct note', opts, async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    await requestCancel(f.ledger, readReconcileSnapshot(f.ledger, 'run-a'), f.parent.authority, 1030);
    const { status, termination } = await finish(f, [
      factEvidence(f, 'done', completion, 1050),
      factEvidence(f, 'chronology', { kind: 'cancel', chronology }, 1040),
    ]);
    assert.equal(status.currentRun.state, 'ended');
    assert.equal(termination.attribution, chronology === 'after_exit' ? 'not_caused' : 'unknown');
    assert.equal(status.terminalNote, chronology === 'unknown' ? 'cancel_timing_unknown' : null);
  });
}
for (const kind of ['unknown_actor', 'offline_continue', 'offline_only'] as const) {
  test('B21 ' + kind + ' never authorizes R-02-2', opts, async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    await f.ledger.transaction((tx) => {
      tx.run("UPDATE runs SET cancel_requested_at=1030,state='cancelling' WHERE run_id='run-a'");
      insertRecord(tx, 'events', {
        runId: 'run-a',
        linkId: 'link-a',
        kind: 'parent.offline',
        payload: { contextId: f.parent.context.contextId, generation: 1, since: 1029, orphanPolicy: 'continue' },
        at: 1029,
      });
      if (kind !== 'offline_only')
        insertRecord(tx, 'events', {
          runId: 'run-a',
          linkId: 'link-a',
          kind: 'cancel.accepted',
          payload: {
            actor:
              kind === 'offline_continue'
                ? { kind: 'orphan_policy', supervisor: f.meta.supervisor }
                : { kind: 'unknown' },
            runId: 'run-a',
            bindingGeneration: 1,
            graceMs: 10000,
          },
          at: 1030,
        });
    });
    const { status, termination } = await finish(f, [
      factEvidence(f, 'done', completion, 1050),
      factEvidence(f, 'before', { kind: 'cancel', chronology: 'before_exit' }, 1040),
    ]);
    assert.equal(status.currentRun.state, 'ended');
    assert.equal(termination.requestedCause, null);
  });
}
for (const variant of [
  'wrong_request',
  'unacknowledged',
  'pre_signal_alive',
  'equal_time_alive',
  'no_alive',
  'scope_end_before_recorded_step',
] as const) {
  test('B21 policy ' + variant + ' cannot fabricate caused/not_caused attribution', opts, async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    const seq = await f.ledger.transaction((tx) => recordRetireRequested(tx, 'run-a', retire, 1030));
    await f.ledger.transaction((tx) =>
      insertRecord(tx, 'events', {
        runId: 'run-a',
        linkId: 'link-a',
        kind: 'cancel.step',
        payload: {
          requestSeq: variant === 'wrong_request' ? seq - 1 : seq,
          signal: 'SIGINT',
          ack: variant !== 'unacknowledged',
        },
        at: variant === 'scope_end_before_recorded_step' ? 1055 : 1040,
      })
    );
    const facts = [factEvidence(f, 'done', completion, 1050)];
    if (variant !== 'no_alive' && variant !== 'scope_end_before_recorded_step')
      facts.push(
        factEvidence(
          f,
          'live',
          { kind: 'scope', state: 'alive', complete: false, harnessTerminated: false, launchersSealed: false },
          variant === 'pre_signal_alive' ? 1035 : variant === 'equal_time_alive' ? 1040 : 1041
        )
      );
    const { status, termination } = await finish(f, facts);
    assert.equal(termination.attribution, 'unknown');
    assert.equal(status.terminalNote, 'retire_timing_unknown');
  });
}
test(
  'B21 competing user and policy actions preserve user cause without borrowing policy timing proof',
  opts,
  async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    const seq = await f.ledger.transaction((tx) => recordRetireRequested(tx, 'run-a', retire, 1030));
    await f.ledger.transaction((tx) =>
      insertRecord(tx, 'events', {
        runId: 'run-a',
        linkId: 'link-a',
        kind: 'cancel.step',
        payload: { requestSeq: seq, signal: 'SIGINT', ack: true },
        at: 1031,
      })
    );
    await requestCancel(f.ledger, readReconcileSnapshot(f.ledger, 'run-a'), f.parent.authority, 1040);
    const { status, termination } = await finish(f, [
      factEvidence(f, 'done', completion, 1050),
      factEvidence(
        f,
        'live',
        { kind: 'scope', state: 'alive', complete: false, harnessTerminated: false, launchersSealed: false },
        1032
      ),
      factEvidence(f, 'bare-before', { kind: 'cancel', chronology: 'before_exit' }, 1035),
    ]);
    assert.equal(termination.requestedCause, 'user_cancel');
    assert.equal(termination.attribution, 'unknown');
    assert.equal(status.currentRun.state, 'ended');
    assert.equal(status.terminalNote, 'cancel_timing_unknown');
    assert.equal(termination.observed.escalatedTo, null);
  }
);
test('B21 acknowledged escalation is request-specific and remains independent of attribution', opts, async (t) => {
  const f = await notifyFixture();
  t.after(() => f.close());
  const seq = await f.ledger.transaction((tx) => recordRetireRequested(tx, 'run-a', retire, 1030));
  await f.ledger.transaction((tx) => {
    for (const [signal, ack, requestSeq] of [
      ['SIGINT', true, seq],
      ['SIGTERM', true, seq],
      ['SIGKILL', false, seq],
      ['SIGKILL', true, seq - 1],
    ] as const)
      insertRecord(tx, 'events', {
        runId: 'run-a',
        linkId: 'link-a',
        kind: 'cancel.step',
        payload: { requestSeq, signal, ack },
        at: 1040,
      });
  });
  const { termination } = await finish(f);
  assert.equal(termination.observed.escalatedTo, 'TERM');
  assert.equal(termination.attribution, 'unknown');
});

test('B21 N remains failed/non-execution with scopeEvidence N and no invented native exit', opts, async (t) => {
  const f = await notifyFixture();
  t.after(() => f.close());
  const { nextIntent, acceptIntent } = await import('./b21-fixture.js');
  const input = nextIntent(f, 'never');
  await acceptIntent(f.ledger, input);
  const facts = [
    factEvidence(
      f,
      'never',
      { kind: 'never_submitted', permanentFence: true, launchersSealed: true, noExecution: true },
      1050
    ),
    factEvidence(
      f,
      'gone',
      { kind: 'scope', state: 'gone', complete: true, harnessTerminated: true, launchersSealed: true },
      1050
    ),
  ];
  for (const e of facts) {
    e.record.runId = input.run.runId;
    e.record.linkId = input.run.linkId;
    for (const fact of e.facts) {
      fact.runId = input.run.runId;
      fact.supervisor = null;
    }
  }
  const result = await commitReconcile(f.ledger, readReconcileSnapshot(f.ledger, input.run.runId), facts, 1060);
  assert.ok(result.committed);
  assert.equal(result.decision.state, 'failed');
  const service = new ReadControlService(f.ledger, f.root);
  t.after(() => service.close());
  const status = await service.status({ runId: input.run.runId }, () => f.parent.authority);
  assert.equal(status.termination?.observed.scopeEvidence, 'N');
  assert.equal(status.termination?.observed.exitCode, null);
  assert.equal(status.termination?.outcome, 'unknown');
});
test(
  'B21 wrong-generation receipt and native-only observations cannot change Q timing or native fields',
  opts,
  async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    await f.ledger.transaction((tx) => recordRetireRequested(tx, 'run-a', retire, 1030));
    const wrong = factEvidence(
      f,
      'wrong-receipt',
      {
        kind: 'receipt',
        complete: true,
        harnessTerminated: true,
        launchersSealed: true,
        nativeExit: { code: 7, signal: null, source: 'wait_status' },
      },
      1025
    );
    wrong.facts[0].bindingGeneration = 2;
    const { termination } = await finish(f, [wrong, factEvidence(f, 'proper-Q', completion, 1050)]);
    assert.equal(termination.observed.scopeEvidence, 'Q');
    assert.equal(termination.observed.exitCode, null);
    assert.equal(termination.attribution, 'unknown');
  }
);

for (const action of ['policy', 'user'] as const)
  for (const anomalyTime of [null, 2000]) {
    test(
      'B21 ' + action + ' clock anomaly with ' + anomalyTime + ' asOf preserves unknown attribution despite full Q',
      opts,
      async (t) => {
        const f = await notifyFixture();
        t.after(() => f.close());
        const request =
          action === 'policy'
            ? await f.ledger.transaction((tx) => recordRetireRequested(tx, 'run-a', retire, 1030))
            : (await requestCancel(f.ledger, readReconcileSnapshot(f.ledger, 'run-a'), f.parent.authority, 1030),
              f.ledger.snapshot((tx) => Number(tx.get("SELECT seq FROM events WHERE kind='cancel.accepted'")!.seq)));
        await f.ledger.transaction((tx) =>
          insertRecord(tx, 'events', {
            runId: 'run-a',
            linkId: 'link-a',
            kind: 'cancel.step',
            payload: { requestSeq: request, signal: 'SIGINT', ack: true },
            at: 1031,
          })
        );
        const anomaly = factEvidence(f, 'clock', { kind: 'heartbeat', at: 1042, clockAnomaly: true }, 1042);
        anomaly.facts[0].asOf = anomalyTime;
        const { status, termination } = await finish(f, [
          anomaly,
          factEvidence(
            f,
            'live',
            { kind: 'scope', state: 'alive', complete: false, harnessTerminated: false, launchersSealed: false },
            1032
          ),
          factEvidence(f, 'before', { kind: 'cancel', chronology: 'before_exit' }, 1040),
          factEvidence(f, 'done', completion, 1050),
        ]);
        assert.equal(status.currentRun.state, 'ended');
        assert.equal(termination.attribution, 'unknown');
        assert.equal(status.terminalNote, action === 'policy' ? 'retire_timing_unknown' : 'cancel_timing_unknown');
        assert.equal(status.capacity.active, 0);
      }
    );
  }

for (const wrongRun of [false, true]) {
  test(
    'B21 raw-only clock anomaly ' +
      (wrongRun ? 'for another run stays opaque' : 'survives a sidecar-conversion crash and suppresses attribution'),
    opts,
    async (t) => {
      const f = await notifyFixture();
      t.after(() => f.close());
      const seq = await f.ledger.transaction((tx) => recordRetireRequested(tx, 'run-a', retire, 1030));
      if (wrongRun) {
        const { nextIntent, acceptIntent } = await import('./b21-fixture.js');
        await acceptIntent(f.ledger, nextIntent(f, 'other-clock'));
      }
      await f.ledger.transaction((tx) => {
        insertRecord(tx, 'events', {
          runId: 'run-a',
          linkId: 'link-a',
          kind: 'cancel.step',
          payload: { requestSeq: seq, signal: 'SIGINT', ack: true },
          at: 1031,
        });
        insertRecord(tx, 'events', {
          runId: wrongRun ? 'run-other-clock' : 'run-a',
          linkId: wrongRun ? 'link-other-clock' : 'link-a',
          kind: 'clock.anomaly',
          payload: { wallDeltaMs: -10000, monoDeltaMs: 10 },
          at: 2000,
        });
      });
      const { status, termination } = await finish(f, [
        factEvidence(
          f,
          'live',
          { kind: 'scope', state: 'alive', complete: false, harnessTerminated: false, launchersSealed: false },
          1032
        ),
        factEvidence(f, 'done', completion, 1050),
      ]);
      assert.equal(status.currentRun.state, 'ended');
      assert.equal(termination.attribution, wrongRun ? 'caused' : 'unknown');
      assert.equal(status.terminalNote, wrongRun ? null : 'retire_timing_unknown');
    }
  );
}

for (const mismatch of ['run', 'link'] as const) {
  test('B21 wrong-' + mismatch + ' report acceptance event cannot supply this run outcome', opts, async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    await reportFor(f, 'completed');
    const { nextIntent, acceptIntent } = await import('./b21-fixture.js');
    await acceptIntent(f.ledger, nextIntent(f, 'other-report'));
    await f.ledger.transaction((tx) =>
      tx.run(
        mismatch === 'run'
          ? "UPDATE events SET run_id='run-other-report' WHERE kind='report.received'"
          : "UPDATE events SET link_id='link-other-report' WHERE kind='report.received'"
      )
    );
    assert.equal((await finish(f)).termination.outcome, 'unknown');
  });
}

for (const kind of ['receipt', 'scope_reconciled'] as const)
  test('B21 ' + kind + ' terminal signal projection preserves the core accepted signal vocabulary', opts, async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    const { termination } = await finish(f, [
      factEvidence(
        f,
        'native-signal',
        {
          kind,
          complete: true,
          harnessTerminated: true,
          launchersSealed: true,
          nativeExit: { code: null, signal: 'TERM', source: 'trusted_harness_result' },
        },
        1050
      ),
    ]);
    assert.equal(termination.observed.signal, 'TERM');
    assert.equal(termination.observed.exitCode, null);
    assert.equal(termination.observed.scopeEvidence, kind === 'receipt' ? 'R' : 'Q');
  });
