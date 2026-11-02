import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { ledgerReadRuntimeSupported } from '../../src/core/ledger-read.js';
import { digest } from '../../src/core/canonical.js';
import { requestDigest } from '../../src/core/execution.js';
import { acceptIntent } from '../../src/ledger/intents.js';
import { bindOwnerScope } from '../../src/ledger/identity.js';
import { procOwnerKey, sessionOwnerKey } from '../../src/core/identity.js';
import { openLedger, type Ledger } from '../../src/ledger/ledger.js';
import { commitCompared, commitReconcile, readReconcileSnapshot, requestCancel } from '../../src/ledger/reconcile.js';
import {
  beginSubmission,
  createHeartbeatWriter,
  markSubmitted,
  registerSupervisor,
} from '../../src/ledger/supervisor.js';
import { captureRunWorkspace } from '../../src/ledger/workspace.js';
import { readRunEventPage } from '../../src/ledger/events.js';
import type { PreparedIntent, ValidatedEvidence } from '../../src/ledger/types.js';
import type { RunWorkspaceSnapshot } from '../../src/core/types/observation.js';
import type { ReconcileFact } from '../../src/core/types/execution.js';

const skip = ledgerReadRuntimeSupported()
  ? false
  : `Ledger requires Node 22.x >=22.13 or >=24 (23 unsupported); found ${process.versions.node}`;
const fixtureModule = pathToFileURL(resolve('tests/ledger/fixtures.mjs')).href;
async function fixture(run: (ledger: Ledger, input: PreparedIntent) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'hud-ledger-write-'));
  const ledger = await openLedger(join(dir, 'ledger.sqlite'));
  try {
    const fixtures = await import(fixtureModule);
    await fixtures.seedCaller(ledger);
    await run(ledger, fixtures.intent());
  } finally {
    await ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const workspace: RunWorkspaceSnapshot = {
  cwdSource: 'launch',
  cwdAsOf: 1000,
  gitCapturedAt: 1010,
  gitMissingReason: null,
  worktreeRoot: '/synthetic/work',
  gitCommonDir: '/synthetic/repository/.git',
  repoId: 'b'.repeat(64),
  identityKind: 'git-common-dir-v1',
  scope: 'local',
};
function evidence(input: PreparedIntent, id: string, fact: ReconcileFact, asOf: number): ValidatedEvidence {
  const entry = {
    evidenceId: id,
    runId: input.run.runId,
    sourceId: input.run.sourceId,
    bindingGeneration: 1,
    supervisor: null,
    validation: 'accepted' as const,
    asOf,
    observedAt: asOf,
    fact,
  };
  return {
    record: {
      evidenceId: id,
      runId: input.run.runId,
      linkId: input.link.linkId,
      kind:
        fact.kind === 'never_submitted'
          ? 'never_submitted'
          : fact.kind === 'scope'
            ? 'group_check'
            : fact.kind === 'receipt'
              ? 'exit_receipt'
              : 'scope_reconciled',
      producer: 'reconciler',
      fingerprint: digest(entry),
      payload: {},
      observedAt: asOf,
      validatedAt: asOf,
      validation: 'accepted',
    },
    facts: [entry],
  };
}
const gone: ReconcileFact = {
  kind: 'scope',
  state: 'gone',
  complete: true,
  harnessTerminated: true,
  launchersSealed: true,
};
const never: ReconcileFact = {
  kind: 'never_submitted',
  permanentFence: true,
  noExecution: true,
  launchersSealed: true,
};

test('ledger transaction rollback, callback lifetime and async-callback rejection', { skip }, async () => {
  await fixture(async (ledger) => {
    let escaped: Parameters<Parameters<Ledger['transaction']>[0]>[0] | undefined;
    await assert.rejects(
      ledger.transaction((tx) => {
        escaped = tx;
        tx.run("INSERT INTO events(kind,payload,at) VALUES('rollback','{}',1)");
        throw new Error('cut');
      }),
      /cut/
    );
    assert.equal(
      ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM events')?.n),
      0
    );
    assert.throws(() => escaped!.get('SELECT 1'), /transaction_finished/);
    await assert.rejects(
      ledger.transaction(async (tx) => {
        tx.run("INSERT INTO events(kind,payload,at) VALUES('async','{}',1)");
      }),
      /must_be_synchronous/
    );
    assert.equal(
      ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM events')?.n),
      0
    );
  });
});

test(
  'ledger freezes launch context, captures workspace once with event, and replays across Git metadata changes',
  { skip },
  async () => {
    await fixture(async (ledger, input) => {
      input.params.originRepoId = 'c'.repeat(64);
      input.run = { ...input.run, projectOrigin: { repoId: 'c'.repeat(64), basis: 'declared', declaredAt: 1000 } };
      const first = await acceptIntent(ledger, input);
      const replay = structuredClone(input);
      replay.run.workspaceSnapshot = workspace;
      replay.run = { ...replay.run, projectOrigin: { ...input.run.projectOrigin!, declaredAt: 2000 } };
      replay.link.label = 'Changed display label';
      assert.deepEqual((await acceptIntent(ledger, replay)).outcome, first.outcome);
      assert.equal(readReconcileSnapshot(ledger, input.run.runId).run.workspaceSnapshot, null);
      await captureRunWorkspace(ledger, input.run.runId, workspace, 1010);
      await assert.rejects(
        captureRunWorkspace(ledger, input.run.runId, { ...workspace, worktree: 'changed' }, 1011),
        /already_captured/
      );
      const current = readReconcileSnapshot(ledger, input.run.runId);
      assert.deepEqual(current.run.workspaceSnapshot, workspace);
      assert.equal(current.run.projectOrigin?.declaredAt, 1000);
      assert.equal(current.run.launchCwd, '/synthetic/work');
      await assert.rejects(
        ledger.transaction((tx) =>
          tx.run("UPDATE runs SET launch_cwd='/synthetic/other' WHERE run_id=?", input.run.runId)
        ),
        /immutable/
      );
      await assert.rejects(
        ledger.transaction((tx) => tx.run('UPDATE runs SET project_origin=NULL WHERE run_id=?', input.run.runId)),
        /immutable/
      );
      assert.equal(
        ledger.snapshot((tx) => tx.get("SELECT count(*) AS n FROM events WHERE kind='workspace.captured'")?.n),
        1
      );
      const changed = structuredClone(input);
      changed.run = { ...changed.run, launchCwd: '/synthetic/other' };
      changed.params.launchCwd = changed.run.launchCwd;
      await assert.rejects(acceptIntent(ledger, changed), /idempotency_conflict/);
      assert.notEqual(
        requestDigest('spawn', input.params),
        requestDigest('spawn', { ...input.params, originRepoId: 'd'.repeat(64) })
      );
    });
  }
);

test('ledger initial cached workspace event is atomic and unknown JSON metadata is refused', { skip }, async () => {
  await fixture(async (ledger, input) => {
    const invalid = structuredClone(input);
    invalid.run.workspaceSnapshot = { ...workspace, injectedPrompt: 'synthetic private text' } as RunWorkspaceSnapshot;
    await assert.rejects(acceptIntent(ledger, invalid), /invalid_workspace/);
    assert.equal(
      ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM runs')?.n),
      0
    );
    input.run.workspaceSnapshot = workspace;
    await acceptIntent(ledger, input);
    assert.equal(
      ledger.snapshot(
        (tx) =>
          tx.get("SELECT count(*) AS n FROM events WHERE kind='workspace.captured' AND run_id=?", input.run.runId)?.n
      ),
      1
    );
  });
});

test(
  'ledger supervisor registration persists full stamp, one ticket, one CAS heartbeat and single submission',
  { skip },
  async () => {
    await fixture(async (ledger, input) => {
      await acceptIntent(ledger, input);
      const supervisor = {
        pid: 45001,
        proc_start: '12345',
        boot_id: 'historical-boot',
        pid_domain: 'historical-domain',
      };
      const registration = {
        runId: input.run.runId,
        ticketHash: input.run.launchTokenHash,
        launchDigest: input.run.launchDigest,
        supervisor,
        authority: input.authority,
        at: 1001,
        monoMs: 20,
      };
      await registerSupervisor(ledger, registration);
      assert.deepEqual(readReconcileSnapshot(ledger, input.run.runId).run.supervisor, supervisor);
      await assert.rejects(registerSupervisor(ledger, registration), /ticket_unavailable/);
      const heartbeat = createHeartbeatWriter(ledger, input.run.runId, supervisor);
      const before = ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM events')?.n);
      const old = readReconcileSnapshot(ledger, input.run.runId);
      assert.deepEqual(await heartbeat.tick(6001, 5020), { cancelRequestedAt: null, seq: 2 });
      assert.equal(
        ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM events')?.n),
        before
      );
      assert.deepEqual(await commitReconcile(ledger, old, [], 6002), { committed: false, reason: 'stale_snapshot' });
      assert.throws(
        () => createHeartbeatWriter(ledger, input.run.runId, { ...supervisor, boot_id: 'new-boot' }),
        /producer_mismatch/
      );
      await beginSubmission(ledger, { ...registration, at: 6002 });
      await assert.rejects(beginSubmission(ledger, { ...registration, at: 6003 }), /submission_forbidden/);
      await markSubmitted(ledger, input.run.runId, supervisor, 6004);
      assert.equal(readReconcileSnapshot(ledger, input.run.runId).run.launchPhase, 'submitted');
      const snapshot = readReconcileSnapshot(ledger, input.run.runId);
      await requestCancel(ledger, snapshot, input.authority, 6005);
      assert.deepEqual(await heartbeat.tick(11001, 10020), { cancelRequestedAt: 6005, seq: 3 });
      await ledger.transaction((tx) =>
        tx.run("UPDATE claims SET supervisor_proc_start='different' WHERE run_id=?", input.run.runId)
      );
      assert.equal(readReconcileSnapshot(ledger, input.run.runId).run.supervisor, null);
      await assert.rejects(
        commitReconcile(ledger, readReconcileSnapshot(ledger, input.run.runId), [], 11002),
        /supervisor_registration_unknown/
      );
    });
  }
);

test(
  'ledger CAS includes context generations, validation changes, and evidence without an event',
  { skip },
  async () => {
    await fixture(async (ledger, input) => {
      await acceptIntent(ledger, input);
      const before = readReconcileSnapshot(ledger, input.run.runId);
      await ledger.transaction((tx) =>
        tx.run('UPDATE caller_contexts SET closed_at=1001 WHERE context_id=?', input.link.parentContextId)
      );
      assert.deepEqual(await commitCompared(ledger, before, () => assert.fail('stale callback ran')), {
        committed: false,
        reason: 'stale_snapshot',
      });
      await assert.rejects(acceptIntent(ledger, input), /stale_context/);
      await ledger.transaction((tx) =>
        tx.run('UPDATE caller_contexts SET closed_at=NULL WHERE context_id=?', input.link.parentContextId)
      );
      const candidate = evidence(input, 'pending-then-rejected', gone, 1010);
      await commitReconcile(ledger, readReconcileSnapshot(ledger, input.run.runId), [candidate], 1010);
      const beforeValidation = readReconcileSnapshot(ledger, input.run.runId);
      await ledger.transaction((tx) =>
        tx.run("UPDATE evidence SET validation='rejected' WHERE evidence_id=?", candidate.record.evidenceId)
      );
      assert.deepEqual(await commitReconcile(ledger, beforeValidation, [], 1011), {
        committed: false,
        reason: 'stale_snapshot',
      });
    });
  }
);

test(
  'ledger irreversible N counter-evidence persists X and terminal incremental import cannot rewrite completion',
  { skip },
  async () => {
    await fixture(async (ledger, input) => {
      await acceptIntent(ledger, input);
      const proof = [evidence(input, 'never', never, 1020), evidence(input, 'gone', gone, 1020)];
      const result = await commitReconcile(ledger, readReconcileSnapshot(ledger, input.run.runId), proof, 1090);
      assert.equal(result.committed && result.decision.state, 'failed');
      assert.equal(
        ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM slots')?.n),
        0
      );
      const alive = evidence(input, 'late-alive', { ...gone, state: 'alive', harnessTerminated: false }, 1030);
      const conflicting = await commitReconcile(ledger, readReconcileSnapshot(ledger, input.run.runId), [alive], 1100);
      assert.equal(conflicting.committed && conflicting.decision.blockNewOperations, true);
      await commitReconcile(
        ledger,
        readReconcileSnapshot(ledger, input.run.runId),
        [evidence(input, 'later-gone', gone, 1040)],
        1101
      );
      const current = readReconcileSnapshot(ledger, input.run.runId);
      assert.equal(current.run.state, 'failed');
      assert.equal(current.run.endedAt, 1090);
      assert.equal(current.evidence.filter((entry) => entry.kind === 'conflict').length, 1);
      assert.equal(
        ledger.snapshot((tx) => tx.get("SELECT count(*) AS n FROM events WHERE kind='run.terminal'")?.n),
        1
      );
      assert.equal(
        ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM slots')?.n),
        0
      );
    });
  }
);

test(
  'ledger full completion after cancellation with unknown chronology ends with a stable note',
  { skip },
  async () => {
    await fixture(async (ledger, input) => {
      await acceptIntent(ledger, input);
      await requestCancel(ledger, readReconcileSnapshot(ledger, input.run.runId), input.authority, 1010);
      const receipt = evidence(
        input,
        'complete',
        { kind: 'scope_reconciled', complete: true, harnessTerminated: true, launchersSealed: true, nativeExit: null },
        1009
      );
      const result = await commitReconcile(ledger, readReconcileSnapshot(ledger, input.run.runId), [receipt], 1020);
      assert.equal(result.committed && result.decision.state, 'ended');
      assert.equal(readReconcileSnapshot(ledger, input.run.runId).terminalNote, 'cancel_timing_unknown');
      await commitReconcile(ledger, readReconcileSnapshot(ledger, input.run.runId), [], 1030);
      assert.equal(readReconcileSnapshot(ledger, input.run.runId).terminalNote, 'cancel_timing_unknown');
      assert.equal(
        ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM slots')?.n),
        0
      );
    });
  }
);

test(
  'ledger owner binding atomically rekeys outcomes, preserves origin and permits the original actor to register',
  { skip },
  async () => {
    await fixture(async (ledger, input) => {
      const accepted = await acceptIntent(ledger, input);
      if (input.authority.kind !== 'mcp') assert.fail('fixture requires mcp authority');
      const sessionRef = input.authority.evidence.sessionRef!;
      const processKey = input.authority.evidence.processKey;
      const binding = {
        evidenceId: 'parent-bound',
        runId: null,
        linkId: null,
        kind: 'trusted_session' as const,
        producer: 'reconciler' as const,
        fingerprint: digest(['parent-bound']),
        payload: {},
        observedAt: 1001,
        validatedAt: 1001,
        validation: 'accepted' as const,
      };
      const before = ledger.snapshot((tx) => tx.get('SELECT * FROM idempotency'))!;
      await bindOwnerScope(ledger, {
        processKey,
        generation: 1,
        sessionRef,
        boundBy: 'trusted_session',
        evidence: binding,
        at: 1001,
      });
      const row = ledger.snapshot((tx) => tx.get('SELECT * FROM idempotency'))!;
      assert.equal(row.owner_key, sessionOwnerKey(sessionRef));
      assert.equal(row.origin_owner_key, procOwnerKey(processKey, 1));
      for (const field of ['outcome', 'at', 'params_digest', 'run_id', 'link_id'])
        assert.equal(row[field], before[field]);
      const currentLink = readReconcileSnapshot(ledger, input.run.runId).link;
      assert.deepEqual(currentLink.parentRef, sessionRef);
      const replay = { ...input, link: currentLink };
      assert.deepEqual((await acceptIntent(ledger, replay)).outcome, accepted.outcome);
      assert.equal(
        ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM idempotency')?.n),
        1
      );
      await registerSupervisor(ledger, {
        runId: input.run.runId,
        ticketHash: input.run.launchTokenHash,
        launchDigest: input.run.launchDigest,
        supervisor: { pid: 45001, proc_start: '123', boot_id: 'synthetic-boot', pid_domain: 'synthetic-domain' },
        authority: input.authority,
        at: 1002,
        monoMs: 10,
      });
    });
  }
);

test(
  'ledger alias collision rolls back binding and original idempotency instead of choosing a winner',
  { skip },
  async () => {
    await fixture(async (ledger, input) => {
      await acceptIntent(ledger, input);
      if (input.authority.kind !== 'mcp') assert.fail('fixture requires mcp authority');
      const sessionRef = input.authority.evidence.sessionRef!;
      const processKey = input.authority.evidence.processKey;
      await ledger.transaction((tx) => {
        tx.run(
          `INSERT INTO idempotency(owner_key,origin_owner_key,request_key,params_version,params_digest,link_id,run_id,outcome,at)
        SELECT ?,origin_owner_key,request_key,params_version,params_digest,link_id,run_id,'{"different":true}',at FROM idempotency`,
          sessionOwnerKey(sessionRef)
        );
      });
      await assert.rejects(
        bindOwnerScope(ledger, {
          processKey,
          generation: 1,
          sessionRef,
          boundBy: 'trusted_session',
          at: 1001,
          evidence: {
            evidenceId: 'parent-conflict',
            runId: null,
            linkId: null,
            kind: 'trusted_session',
            producer: 'reconciler',
            fingerprint: digest(['parent-conflict']),
            payload: {},
            observedAt: 1001,
            validatedAt: 1001,
            validation: 'accepted',
          },
        }),
        /idempotency_conflict/
      );
      assert.equal(
        ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM owner_aliases')?.n),
        0
      );
      assert.equal(
        ledger.snapshot((tx) => tx.get('SELECT session_ref FROM caller_contexts')?.session_ref),
        null
      );
      assert.equal(
        ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM idempotency')?.n),
        2
      );
      assert.equal(
        ledger.snapshot((tx) => tx.get("SELECT count(*) AS n FROM events WHERE kind='owner.alias_rejected'")?.n),
        1
      );
    });
  }
);

test('ledger event pages use committed per-run cursors and never mutate the ledger', { skip }, async () => {
  await fixture(async (ledger, input) => {
    input.run.workspaceSnapshot = workspace;
    await acceptIntent(ledger, input);
    const first = readRunEventPage(ledger, input.run.runId, 0, 1);
    assert.equal(first.events.length, 1);
    assert.equal(first.hasMore, true);
    const second = readRunEventPage(ledger, input.run.runId, first.nextSeq, 1);
    assert.equal(second.events[0].kind, 'workspace.captured');
    assert.equal(second.hasMore, false);
    const empty = readRunEventPage(ledger, input.run.runId, second.nextSeq, 1);
    assert.equal(empty.nextSeq, second.nextSeq);
    assert.deepEqual(empty.events, []);
    assert.equal(empty.asOfSeq, second.asOfSeq);
    assert.throws(() => readRunEventPage(ledger, input.run.runId, -1), /invalid_event_cursor/);
  });
});

test('ledger fresh reconciliation retains accepted link conflicts without normalized sidecars', { skip }, async () => {
  await fixture(async (ledger, input) => {
    await acceptIntent(ledger, input);
    await ledger.transaction((tx) =>
      tx.run(
        `INSERT INTO evidence(evidence_id,run_id,link_id,kind,producer,fingerprint,payload,observed_at,validated_at,validation)
      VALUES('linked-conflict',NULL,?,'conflict','reconciler',?,'{}',1001,1001,'accepted')`,
        input.link.linkId,
        'f'.repeat(64)
      )
    );
    const result = await commitReconcile(
      ledger,
      readReconcileSnapshot(ledger, input.run.runId),
      [evidence(input, 'never-conflict', never, 1020), evidence(input, 'gone-conflict', gone, 1020)],
      1030
    );
    assert.equal(result.committed && result.decision.state, 'uncertain');
    assert.equal(result.committed && result.decision.blockNewOperations, true);
    assert.equal(
      ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM slots')?.n),
      1
    );
    assert.equal(
      ledger.snapshot(
        (tx) => tx.get("SELECT validation FROM evidence WHERE evidence_id='linked-conflict'")?.validation
      ),
      'accepted'
    );
  });
});

for (const phase of ['register', 'submit'] as const) {
  test(`ledger revoked parent cannot cancel or ${phase} an active run`, { skip }, async () => {
    await fixture(async (ledger, input) => {
      await acceptIntent(ledger, input);
      const registration = {
        runId: input.run.runId,
        ticketHash: input.run.launchTokenHash,
        launchDigest: input.run.launchDigest,
        supervisor: { pid: 45001, proc_start: '123', boot_id: 'synthetic-boot', pid_domain: 'synthetic-domain' },
        authority: input.authority,
        at: 1001,
        monoMs: 10,
      };
      if (phase === 'submit') await registerSupervisor(ledger, registration);
      await commitCompared(ledger, readReconcileSnapshot(ledger, input.run.runId), (tx) =>
        tx.run("UPDATE links SET state='revoked',current_owner=0 WHERE link_id=?", input.link.linkId)
      );
      const current = readReconcileSnapshot(ledger, input.run.runId);
      await assert.rejects(requestCancel(ledger, current, input.authority, 1002), /unauthorized/);
      await assert.rejects(
        phase === 'register' ? registerSupervisor(ledger, registration) : beginSubmission(ledger, registration),
        /unauthorized/
      );
      assert.equal(readReconcileSnapshot(ledger, input.run.runId).run.cancelRequestedAt, null);
      assert.equal(
        ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM slots')?.n),
        1
      );
    });
  });
}

test(
  'ledger handover increases generation and revokes old binding atomically with edge transfer',
  { skip },
  async () => {
    await fixture(async (ledger, input) => {
      await acceptIntent(ledger, input);
      if (input.authority.kind !== 'mcp') assert.fail('fixture requires mcp authority');
      const parent = input.authority.evidence.sessionRef!;
      await bindOwnerScope(ledger, {
        processKey: input.authority.evidence.processKey,
        generation: 1,
        sessionRef: parent,
        boundBy: 'trusted_session',
        at: 1001,
        evidence: {
          evidenceId: 'handover-parent',
          runId: null,
          linkId: null,
          kind: 'trusted_session',
          producer: 'reconciler',
          fingerprint: digest('handover-parent'),
          payload: {},
          observedAt: 1001,
          validatedAt: 1001,
          validation: 'accepted',
        },
      });
      const child = { ...parent, sessionId: 'synthetic-child' };
      const childKey = JSON.stringify([child.harness, child.sourceId, child.sessionId, child.threadId]);
      await ledger.transaction((tx) => {
        tx.run(
          'INSERT INTO sessions(session_ref,harness,source_id,session_id) VALUES(?,?,?,?)',
          childKey,
          child.harness,
          child.sourceId,
          child.sessionId
        );
        tx.run(
          "UPDATE links SET child_ref=?,state='bound',current_owner=1,bound_at=1002 WHERE link_id=?",
          childKey,
          input.link.linkId
        );
        tx.run('UPDATE runs SET target_session_ref=? WHERE run_id=?', childKey, input.run.runId);
        // The binding is seeded structurally here; this test exercises its revocation, not B5 identity validation.
        tx.run(
          `INSERT INTO child_bindings(binding_id,run_id,session_ref,binding_generation,caller_id,caller_context_id,context_generation,bound_by,capabilities,evidence_id,created_at)
        VALUES('old-binding',?,?,1,'parent','parent-context',1,'trusted_session','mcp','handover-parent',1002)`,
          input.run.runId,
          childKey
        );
      });
      await commitReconcile(
        ledger,
        readReconcileSnapshot(ledger, input.run.runId),
        [
          evidence(
            input,
            'handover-end',
            {
              kind: 'scope_reconciled',
              complete: true,
              harnessTerminated: true,
              launchersSealed: true,
              nativeExit: null,
            },
            1003
          ),
        ],
        1004
      );
      const fixtures = await import(fixtureModule);
      const next = fixtures.intent('handover') as PreparedIntent;
      next.requestKey = 'handover-key';
      next.params.predecessor = input.link.linkId;
      next.link = {
        ...next.link,
        parentRef: parent,
        childRef: child,
        state: 'bound',
        currentOwner: true,
        predecessor: input.link.linkId,
      };
      next.run = { ...next.run, operation: 'handover', targetSessionRef: child };
      next.newSession = false;
      await assert.rejects(acceptIntent(ledger, next), /new_run_anchors_required/);
      assert.equal(
        ledger.snapshot(
          (tx) => tx.get("SELECT is_current FROM child_bindings WHERE binding_id='old-binding'")?.is_current
        ),
        1
      );
      assert.equal(readReconcileSnapshot(ledger, input.run.runId).link.state, 'bound');
      next.run.expectedGeneration = 2;
      next.claim.expectedGeneration = 2;
      await acceptIntent(ledger, next);
      assert.equal(readReconcileSnapshot(ledger, next.run.runId).run.expectedGeneration, 2);
      assert.equal(readReconcileSnapshot(ledger, input.run.runId).link.state, 'handed_over');
      assert.equal(
        ledger.snapshot(
          (tx) => tx.get("SELECT is_current FROM child_bindings WHERE binding_id='old-binding'")?.is_current
        ),
        0
      );
      assert.equal(
        ledger.snapshot((tx) => tx.get('SELECT state FROM claims WHERE run_id=?', input.run.runId)?.state),
        'revoked'
      );
      assert.equal(
        ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM slots WHERE session_ref=?', childKey)?.n),
        1
      );
    });
  }
);

test('ledger fresh reconciliation keeps conflicts from another run sharing the actual target', { skip }, async () => {
  await fixture(async (ledger, input) => {
    await acceptIntent(ledger, input);
    const fixtures = await import(fixtureModule);
    const other = fixtures.intent('other-target') as PreparedIntent;
    other.requestKey = 'other-target-key';
    await acceptIntent(ledger, other);
    const ref = JSON.stringify(['codex', input.run.sourceId, 'shared-synthetic-target', null]);
    await ledger.transaction((tx) => {
      tx.run(
        'INSERT INTO sessions(session_ref,harness,source_id,session_id) VALUES(?,?,?,?)',
        ref,
        'codex',
        input.run.sourceId,
        'shared-synthetic-target'
      );
      tx.run('UPDATE runs SET target_session_ref=? WHERE run_id IN (?,?)', ref, input.run.runId, other.run.runId);
      tx.run(
        `INSERT INTO evidence(evidence_id,run_id,link_id,kind,producer,fingerprint,payload,observed_at,validated_at,validation)
        VALUES('prior-target-conflict',?,?,'conflict','reconciler',?,'{}',1001,1001,'accepted')`,
        input.run.runId,
        input.link.linkId,
        'e'.repeat(64)
      );
    });
    const result = await commitReconcile(
      ledger,
      readReconcileSnapshot(ledger, other.run.runId),
      [evidence(other, 'target-never', never, 1020), evidence(other, 'target-gone', gone, 1020)],
      1030
    );
    assert.equal(result.committed && result.decision.state, 'uncertain');
    assert.equal(result.committed && result.decision.blockNewOperations, true);
    assert.equal(
      ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM slots')?.n),
      2
    );
  });
});

test(
  'ledger original supervisor cannot submit after reconciliation marks its armed run uncertain',
  { skip },
  async () => {
    await fixture(async (ledger, input) => {
      await acceptIntent(ledger, input);
      const registration = {
        runId: input.run.runId,
        ticketHash: input.run.launchTokenHash,
        launchDigest: input.run.launchDigest,
        supervisor: { pid: 45001, proc_start: '123', boot_id: 'synthetic-boot', pid_domain: 'synthetic-domain' },
        authority: input.authority,
        at: 1001,
        monoMs: 10,
      };
      await registerSupervisor(ledger, registration);
      const result = await commitReconcile(ledger, readReconcileSnapshot(ledger, input.run.runId), [], 32002);
      assert.equal(result.committed && result.decision.state, 'uncertain');
      await assert.rejects(beginSubmission(ledger, { ...registration, at: 32003 }), /submission_forbidden/);
      const current = readReconcileSnapshot(ledger, input.run.runId);
      assert.equal(current.run.launchPhase, 'armed');
      assert.equal(
        ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM slots')?.n),
        1
      );
    });
  }
);

test(
  'ledger terminal timing uncertainty durably prevents resume without fabricating a conflict fact',
  { skip },
  async () => {
    await fixture(async (ledger, input) => {
      await acceptIntent(ledger, input);
      const child = {
        harness: 'codex' as const,
        sourceId: input.run.sourceId,
        sessionId: 'timing-child',
        threadId: null,
      };
      const childKey = JSON.stringify([child.harness, child.sourceId, child.sessionId, child.threadId]);
      await ledger.transaction((tx) => {
        tx.run(
          'INSERT INTO sessions(session_ref,harness,source_id,session_id) VALUES(?,?,?,?)',
          childKey,
          child.harness,
          child.sourceId,
          child.sessionId
        );
        tx.run(
          "UPDATE links SET child_ref=?,state='bound',current_owner=1 WHERE link_id=?",
          childKey,
          input.link.linkId
        );
        tx.run('UPDATE runs SET target_session_ref=? WHERE run_id=?', childKey, input.run.runId);
      });
      await commitReconcile(
        ledger,
        readReconcileSnapshot(ledger, input.run.runId),
        [
          evidence(
            input,
            'timing-complete',
            {
              kind: 'scope_reconciled',
              complete: true,
              harnessTerminated: true,
              launchersSealed: true,
              nativeExit: null,
            },
            1020
          ),
        ],
        1021
      );
      const unknownTime = evidence(input, 'timing-live', { ...gone, state: 'alive', harnessTerminated: false }, 1030);
      unknownTime.facts[0].asOf = null;
      const result = await commitReconcile(ledger, readReconcileSnapshot(ledger, input.run.runId), [unknownTime], 1031);
      assert.equal(result.committed && result.decision.state, 'ended');
      assert.equal(result.committed && result.decision.cause, 'scope_unknown');
      assert.equal(result.committed && result.decision.blockNewOperations, true);
      assert.equal(
        ledger.snapshot((tx) => tx.get("SELECT count(*) AS n FROM evidence WHERE kind='conflict'")?.n),
        0
      );
      const fixtures = await import(fixtureModule);
      const next = fixtures.intent('timing-resume') as PreparedIntent;
      next.requestKey = 'timing-resume-key';
      next.link = readReconcileSnapshot(ledger, input.run.runId).link;
      next.params.linkId = input.link.linkId;
      next.params.expectedRun = input.run.runId;
      next.run = {
        ...next.run,
        linkId: input.link.linkId,
        operation: 'resume',
        runSeq: 2,
        expectedGeneration: 2,
        targetSessionRef: child,
      };
      next.claim.expectedGeneration = 2;
      next.newSession = false;
      await assert.rejects(acceptIntent(ledger, next), /unresolved_conflict/);
      await commitReconcile(ledger, readReconcileSnapshot(ledger, input.run.runId), [], 1032);
      assert.equal(
        ledger.snapshot((tx) => tx.get("SELECT count(*) AS n FROM events WHERE kind='run.reconciliation'")?.n),
        1
      );
      assert.equal(
        ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM slots')?.n),
        0
      );
    });
  }
);
