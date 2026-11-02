import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, chmodSync, readFileSync, existsSync, symlinkSync, unlinkSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { HeadlessRunControl } from '../../src/core/run/control.js';
import { readProcess } from '../../src/core/run/process.js';
import { createRunFactPort } from '../../src/core/run/ledger-port.js';
import { PrivateLedgerGate } from '../../src/ledger/local-manager.js';
const skip = ledgerRuntimeSupported() ? false : 'Integration requires Node 22 >=22.13 or >=24';
const helpers = () => import(pathToFileURL(resolve('tests/int/fixture.mjs')).href);

test('int accepted intent to real CLI registration/submission/receipt/reconcile releases slot', { skip }, async () => {
  const { fixture, cli } = await helpers();
  const f = await fixture([
    process.execPath,
    '-e',
    "setTimeout(()=>{process.stdout.write('synthetic');process.exit(7)},350)",
  ]);
  try {
    const child = cli(f, ['start'], { input: f.input, ticket: f.ticket });
    const done = await child.done;
    assert.equal(done.code, 0, done.stderr);
    const s = await f.port.read(f.input.runId);
    assert.equal(s.run.state, 'ended');
    assert.equal(s.slotHeld, false);
    assert.equal(s.run.exitCode, 7);
    assert.equal(s.claimState, 'revoked');
    assert.equal(s.run.launchPhase, 'submitted');
    assert.ok(s.receipt);
    const registration = s.events.filter((e: any) => e.kind === 'supervisor.registered');
    assert.equal(registration.length, 1);
    assert.deepEqual(registration[0].payload.supervisor, s.run.supervisor);
    assert.ok(s.run.supervisor?.boot_id);
    assert.ok(s.run.supervisor?.pid_domain);
    assert.equal(readFileSync(join(f.home, 'runs', f.input.runId, 'stdout.log'), 'utf8'), 'synthetic');
    const again = cli(f, ['start'], { input: f.input, ticket: f.ticket });
    assert.notEqual((await again.done).code, 0);
    assert.equal(
      (await f.port.read(f.input.runId)).events.filter((e: any) => e.kind === 'supervisor.registered').length,
      1
    );
  } finally {
    await f.cleanup();
  }
});

test('int supervisor SIGKILL holds uncertain slot until real Q, never resubmits', { skip }, async () => {
  const { fixture, cli, until } = await helpers();
  const f = await fixture([
    process.execPath,
    '-e',
    "require('fs').appendFileSync('submissions','one\\n');setTimeout(()=>{},1800)",
  ]);
  try {
    const child = cli(f, ['start'], { input: f.input, ticket: f.ticket });
    await until(async () => {
      const s = await f.port.read(f.input.runId);
      return s.meta?.scope && s.run.state === 'running';
    });
    child.child.kill('SIGKILL');
    await child.done;
    const control = new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor());
    const uncertain = await control.reconcile(f.input.runId);
    assert.equal(uncertain.currentRun?.state, 'uncertain');
    assert.equal((await f.port.read(f.input.runId)).slotHeld, true);
    await until(async () => (await control.reconcile(f.input.runId)).currentRun?.state === 'ended');
    const final = await f.port.read(f.input.runId);
    assert.equal(final.slotHeld, false);
    assert.equal(final.run.exitCode, null);
    assert.equal(readFileSync(join(f.home, 'submissions'), 'utf8'), 'one\n');
    const before = final.events.filter((e: any) => e.kind === 'launch.submitting').length;
    await control.reconcile(f.input.runId);
    await control.reconcile(f.input.runId);
    assert.equal(
      (await f.port.read(f.input.runId)).events.filter((e: any) => e.kind === 'launch.submitting').length,
      before
    );
  } finally {
    await f.cleanup();
  }
});

test(
  'int F05 fixed unbound local cancel/reconcile gate and audit, duplicate grace and old-run isolation',
  { skip },
  async () => {
    const { fixture, addIntent } = await helpers();
    const f = await fixture([process.execPath, '-e', 'setTimeout(()=>{},500)']);
    try {
      const actor = new PrivateLedgerGate(f.home).actor(),
        id = f.input.runId;
      assert.equal((await f.port.read(id)).status.link.parentRef, null);
      for (const bad of [
        { ...actor, uid: actor.uid + 1 },
        { kind: 'mcp', uid: actor.uid, invocationId: 'forged' },
        { ...actor, admin: true },
      ]) {
        await assert.rejects(() => f.port.acceptCancel(id, bad, 0), /unauthorized/);
        await assert.rejects(() => f.port.authorizeManager(id, bad, 'reconcile'), /unauthorized/);
      }
      const accepted = await f.port.acceptCancel(id, actor, 123);
      assert.deepEqual(await f.port.acceptCancel(id, actor, 999), accepted);
      const next = await addIntent(f.ledger, f.home, [process.execPath, '-e', 'setTimeout(()=>{},500)']);
      const control = new HeadlessRunControl(f.port, f.home, actor);
      await control.reconcile(id);
      await control.reconcile(id);
      const old = await f.port.read(id),
        fresh = await f.port.read(next.input.runId);
      assert.equal(fresh.run.state, 'starting');
      assert.equal(fresh.run.cancelRequestedAt, null);
      assert.equal(fresh.run.supervisor, null);
      assert.equal(fresh.claimState, 'issued');
      const event = old.events.find((e: any) => e.kind === 'cancel.accepted');
      assert.deepEqual(event.payload.actor, actor);
      assert.equal(event.payload.runId, id);
      assert.equal(event.payload.bindingGeneration, old.run.expectedGeneration);
      chmodSync(join(f.home, 'ledger.sqlite'), 0o644);
      await assert.rejects(() => f.port.acceptCancel(id, actor, 0), /unsafe/);
      await assert.rejects(() => control.reconcile(id), /unsafe/);
      await assert.rejects(() => createRunFactPort(f.home), /unsafe/);
      chmodSync(join(f.home, 'ledger.sqlite'), 0o600);
    } finally {
      await f.cleanup();
    }
  }
);

test('int launch ticket revalidates stored context/generation/owner before any backend call', { skip }, async () => {
  const { fixture, cli } = await helpers();
  for (const sql of [
    "UPDATE caller_contexts SET closed_at=2000 WHERE context_id='parent-context'",
    'UPDATE caller_scopes SET closed_at=2000 WHERE generation=1',
    "UPDATE links SET state='revoked'",
  ]) {
    const f = await fixture([process.execPath, '-e', "require('fs').writeFileSync('must-not-exist','bad')"]);
    try {
      await f.ledger.transaction((tx: any) => tx.run(sql));
      const done = await cli(f, ['start'], { input: f.input, ticket: f.ticket }).done;
      assert.notEqual(done.code, 0, done.stderr);
      const s = await f.port.read(f.input.runId);
      assert.equal(s.claimState, 'issued');
      assert.equal(s.run.supervisor, null);
      assert.equal(s.events.filter((e: any) => e.kind === 'launch.submitting').length, 0);
      assert.equal(existsSync(join(f.home, 'must-not-exist')), false);
    } finally {
      await f.cleanup();
    }
  }
});

test(
  'int registration single winner, beginSubmission rechecks context, and stale reconcile imports nothing',
  { skip },
  async () => {
    const { fixture } = await helpers();
    const f = await fixture([process.execPath, '-e', 'setTimeout(()=>{},500)']);
    try {
      const id = f.input.runId,
        stamp = readProcess(process.pid)!.stamp;
      const results = await Promise.allSettled([
        f.port.register(id, f.ticket, f.prepared.run.launchDigest, stamp),
        f.port.register(id, f.ticket, f.prepared.run.launchDigest, stamp),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const actor = new PrivateLedgerGate(f.home).actor();
      await f.port.authorizeManager(id, actor, 'reconcile');
      const before = await f.port.read(id);
      await f.port.acceptCancel(id, actor, 0);
      assert.equal(await f.port.reconcile(id, before.revision, [], Date.now()), null);
      await f.ledger.transaction((tx: any) =>
        tx.run("UPDATE caller_contexts SET closed_at=2000 WHERE context_id='parent-context'")
      );
      await assert.rejects(() => f.port.phase(id, stamp, 'submitting'), /stale/);
      assert.equal((await f.port.read(id)).run.launchPhase, 'armed');
    } finally {
      await f.cleanup();
    }
  }
);

test('int shell receipt projects shell 137 while native status stays unknown', { skip }, async () => {
  const { fixture, until } = await helpers();
  const home = mkdtempSync(join(tmpdir(), 'hud-int-shell-'));
  const marker = join(home, 'harness.pid');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>{},400)`;
  const f = await fixture(
    { shell: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}; exit 137`, shellPath: '/bin/sh' },
    home
  );
  try {
    const control = new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor());
    await control.start({
      input: f.input,
      ticket: f.ticket,
      managedShellVerified: true,
      identifyHarness: async () => {
        await until(() => existsSync(marker));
        return readProcess(Number(readFileSync(marker, 'utf8')))!.stamp;
      },
    });
    const s = await f.port.read(f.input.runId);
    assert.equal(s.run.state, 'ended');
    assert.equal(s.run.shellStatus, 137);
    assert.equal(s.run.shellSignal, null);
    assert.equal(s.run.exitCode, null);
    assert.equal(s.receipt?.native_exit, null);
    assert.equal(s.receipt?.shell_exit?.exit_code, 137);
  } finally {
    await f.cleanup();
  }
});

test(
  'int private store refuses symlinks, foreign paths and permission changes after manager authorization',
  { skip },
  async () => {
    const { fixture } = await helpers();
    const f = await fixture([process.execPath, '-e', '']);
    try {
      const actor = new PrivateLedgerGate(f.home).actor();
      await f.port.authorizeManager(f.input.runId, actor, 'reconcile');
      const snapshot = await f.port.read(f.input.runId);
      chmodSync(f.home, 0o755);
      await assert.rejects(() => f.port.reconcile(f.input.runId, snapshot.revision, [], Date.now()), /unsafe/);
      chmodSync(f.home, 0o700);
      const path = join(f.home, 'ledger.sqlite'),
        saved = join(f.home, 'saved.sqlite');
      renameSync(path, saved);
      symlinkSync(saved, path);
      assert.throws(() => new PrivateLedgerGate(f.home), /unsafe/);
      unlinkSync(path);
      renameSync(saved, path);
      // Actual root-owned directory metadata; no contents or user state is read.
      assert.throws(() => new PrivateLedgerGate('/proc'), /unsafe/);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'int stored local_user resume initiator uses private store gate, never trusted_local launch power',
  { skip },
  async () => {
    const { fixture, cli } = await helpers();
    const f = await fixture([process.execPath, '-e', 'setTimeout(()=>{},250)']);
    try {
      assert.equal((await cli(f, ['start'], { input: f.input, ticket: f.ticket }).done).code, 0);
      const { acceptIntent } = await import('../../src/ledger/intents.js');
      const { readReconcileSnapshot } = await import('../../src/ledger/reconcile.js');
      const { refValue } = await import('../../src/ledger/records.js');
      const { launchDigest } = await import('../../src/core/run/control.js');
      const { createHash } = await import('node:crypto');
      const parent = {
        harness: 'codex' as const,
        sourceId: f.input.sourceId,
        sessionId: 'synthetic-parent-local',
        threadId: null,
      };
      const child = { ...parent, sessionId: 'synthetic-child-local' };
      await f.ledger.transaction((tx: any) => {
        for (const ref of [parent, child])
          tx.run(
            'INSERT INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
            refValue(ref),
            ref.harness,
            ref.sourceId,
            ref.sessionId,
            ''
          );
        tx.run(
          "UPDATE links SET state='bound',parent_ref=?,child_ref=?,current_owner=1 WHERE link_id=?",
          refValue(parent),
          refValue(child),
          f.prepared.link.linkId
        );
      });
      const at = Date.now(),
        invocationId = 'synthetic-local-resume';
      const next = structuredClone(f.prepared);
      const input = { ...f.input, runId: 'run-local-resume' };
      const ticket = 'synthetic-local-resume-ticket';
      next.requestKey = 'local-resume-key';
      next.params = { ...next.params, linkId: next.link.linkId, expectedRun: f.input.runId };
      next.link = readReconcileSnapshot(f.ledger, f.input.runId).link;
      next.run = {
        ...next.run,
        runId: input.runId,
        runSeq: 2,
        operation: 'resume',
        expectedGeneration: 2,
        targetSessionRef: child,
        createdAt: at,
        launchCallId: `local:${invocationId}`,
        launchCorrelationId: 'synthetic-local-correlation',
        launchTokenHash: createHash('sha256').update(ticket).digest('hex'),
        launchDigest: launchDigest(input),
      };
      next.claim = {
        ...next.claim,
        runId: input.runId,
        expectedGeneration: 2,
        claimHash: 'b'.repeat(64),
        issuedAt: at,
        expiresAt: at + 1800000,
      };
      next.authority = {
        kind: 'local_user',
        uid: process.getuid!(),
        ownerUid: process.getuid!(),
        invocationId,
        hudHomeOwned: true,
        ledgerOwned: true,
        privatePaths: true,
      };
      next.newSession = false;
      await acceptIntent(f.ledger, next);
      const result = await cli(f, ['start'], { input, ticket }).done;
      assert.equal(result.code, 0, result.stderr);
      const state = await f.port.read(input.runId);
      assert.equal(state.run.state, 'ended');
      assert.equal(state.slotHeld, false);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'int next identity generation and revoked binding owner refuse the accepted execution ticket',
  { skip },
  async () => {
    const { fixture, cli } = await helpers();
    const f = await fixture([process.execPath, '-e', "require('fs').writeFileSync('must-not-exist','bad')"]);
    try {
      await f.ledger.transaction((tx: any) => {
        tx.run("UPDATE caller_contexts SET closed_at=2000 WHERE context_id='parent-context'");
        tx.run('UPDATE caller_scopes SET closed_at=2000 WHERE generation=1');
        tx.run(
          `INSERT INTO caller_scopes SELECT process_key,2,harness,source_id,pid_domain,harness_pid,harness_proc_start,NULL,NULL,NULL,2000,NULL FROM caller_scopes WHERE generation=1`
        );
        tx.run(
          `INSERT INTO caller_contexts SELECT context_id,2,caller_id,context_key,kind,source_id,harness,process_key,2,NULL,NULL,NULL,NULL,2000,NULL FROM caller_contexts WHERE generation=1`
        );
      });
      const result = await cli(f, ['start'], { input: f.input, ticket: f.ticket }).done;
      assert.notEqual(result.code, 0, result.stderr);
      assert.equal((await f.port.read(f.input.runId)).run.supervisor, null);
      assert.equal(existsSync(join(f.home, 'must-not-exist')), false);
    } finally {
      await f.cleanup();
    }
  }
);

test('int raw writer has no transition setter and normalized Q cannot forge a release', { skip }, async () => {
  const { fixture } = await helpers();
  const f = await fixture([process.execPath, '-e', '']);
  try {
    const id = f.input.runId,
      stamp = readProcess(process.pid)!.stamp;
    await f.port.register(id, f.ticket, f.prepared.run.launchDigest, stamp);
    await assert.rejects(() => f.port.raw(id, stamp, 'run.terminal', { state: 'ended' }), /forbidden/);
    await f.port.authorizeManager(id, new PrivateLedgerGate(f.home).actor(), 'reconcile');
    const s = await f.port.read(id),
      at = Date.now();
    await assert.rejects(
      () =>
        f.port.reconcile(
          id,
          s.revision,
          [
            {
              evidenceId: 'forged-Q',
              runId: id,
              sourceId: s.run.sourceId,
              bindingGeneration: s.run.expectedGeneration,
              supervisor: s.run.supervisor,
              validation: 'accepted',
              asOf: at,
              observedAt: at,
              fact: {
                kind: 'scope_reconciled',
                complete: true,
                harnessTerminated: true,
                launchersSealed: true,
                nativeExit: null,
              },
            },
          ],
          at
        ),
      /scope_proof_invalid/
    );
    const after = await f.port.read(id);
    assert.equal(after.slotHeld, true);
    assert.equal(after.run.state, 'starting');
    assert.equal(after.facts.length, 0);
  } finally {
    await f.cleanup();
  }
});

test(
  'int review same-owner replacement MCP can execute an accepted resume with historical parent tuple',
  { skip },
  async () => {
    const { fixture, cli, acceptResume } = await helpers();
    const f = await fixture([process.execPath, '-e', 'setTimeout(()=>{},250)']);
    try {
      assert.equal((await cli(f, ['start'], { input: f.input, ticket: f.ticket }).done).code, 0);
      const next = await acceptResume(f, 'mcp');
      const result = await cli(f, ['start'], { input: next.input, ticket: next.ticket }).done;
      assert.equal(result.code, 0, result.stderr);
      const s = await f.port.read(next.input.runId);
      assert.equal(s.run.state, 'ended');
      assert.equal(s.status.link.parentCaller, 'parent');
      assert.equal(s.events.find((e: any) => e.kind === 'intent.accepted').payload.actor.callerId, 'parent-new');
    } finally {
      await f.cleanup();
    }
  }
);

test('int review revoked local_user resume claim forbids beginSubmission', { skip }, async () => {
  const { fixture, cli, acceptResume } = await helpers();
  const f = await fixture([process.execPath, '-e', 'setTimeout(()=>{},250)']);
  try {
    assert.equal((await cli(f, ['start'], { input: f.input, ticket: f.ticket }).done).code, 0);
    const next = await acceptResume(f),
      stamp = readProcess(process.pid)!.stamp;
    await f.port.register(next.input.runId, next.ticket, next.prepared.run.launchDigest, stamp);
    await f.ledger.transaction((tx: any) =>
      tx.run("UPDATE claims SET state='revoked' WHERE run_id=?", next.input.runId)
    );
    await assert.rejects(() => f.port.phase(next.input.runId, stamp, 'submitting'), /claim_not_current/);
    assert.equal((await f.port.read(next.input.runId)).run.launchPhase, 'armed');
  } finally {
    await f.cleanup();
  }
});

test(
  'int review final receipt recovery imports shell facts atomically and refuses conflicting receipts',
  { skip },
  async () => {
    const { fixture, until } = await helpers();
    const home = mkdtempSync(join(tmpdir(), 'hud-int-receipt-cut-')),
      marker = join(home, 'harness.pid');
    const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>{},350)`;
    const f = await fixture(
      { shell: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}; exit 137`, shellPath: '/bin/sh' },
      home
    );
    try {
      const control = new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor());
      const receipt = f.port.receipt.bind(f.port);
      f.port.receipt = async () => {
        throw new Error('synthetic-crash-after-file');
      };
      await assert.rejects(
        () =>
          control.start({
            input: f.input,
            ticket: f.ticket,
            managedShellVerified: true,
            identifyHarness: async () => {
              await until(() => existsSync(marker));
              return readProcess(Number(readFileSync(marker, 'utf8')))!.stamp;
            },
          }),
        /synthetic-crash-after-file/
      );
      f.port.receipt = receipt;
      assert.equal((await f.port.read(f.input.runId)).receipt, null);
      await control.reconcile(f.input.runId);
      const s = await f.port.read(f.input.runId);
      assert.equal(s.run.state, 'ended');
      assert.equal(s.slotHeld, false);
      assert.equal(s.run.shellStatus, 137);
      assert.equal(s.receipt.shell_exit.exit_code, 137);
      assert.equal(s.events.filter((e: any) => e.kind === 'exit.receipt').length, 1);
      await control.reconcile(f.input.runId);
      assert.equal((await f.port.read(f.input.runId)).events.filter((e: any) => e.kind === 'exit.receipt').length, 1);
      await assert.rejects(
        () =>
          f.port.receipt(f.input.runId, s.run.supervisor, {
            ...s.receipt,
            receipt_id: 'synthetic-conflicting-receipt',
          }),
        /receipt_conflict/
      );
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'int review verified future stored heartbeat becomes clock_anomaly, arbitrary future facts refuse',
  { skip },
  async () => {
    const { fixture } = await helpers();
    const f = await fixture([process.execPath, '-e', '']);
    const originalNow = Date.now;
    try {
      await f.port.register(f.input.runId, f.ticket, f.prepared.run.launchDigest, readProcess(process.pid)!.stamp);
      const before = await f.port.read(f.input.runId),
        rollback = before.run.createdAt - 10000;
      Date.now = () => rollback;
      const control = new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor());
      const status = await control.reconcile(f.input.runId);
      assert.equal(status.currentRun?.state, 'uncertain');
      assert.equal(status.reconciliation?.cause, 'clock_anomaly');
      const s = await f.port.read(f.input.runId);
      assert.equal(s.slotHeld, true);
      assert.equal(s.run.heartbeatAt, before.run.heartbeatAt);
      await assert.rejects(
        () =>
          f.port.reconcile(
            f.input.runId,
            s.revision,
            [
              {
                evidenceId: 'arbitrary-future',
                runId: f.input.runId,
                sourceId: s.run.sourceId,
                bindingGeneration: s.run.expectedGeneration,
                supervisor: s.run.supervisor,
                validation: 'accepted',
                asOf: rollback + 1000,
                observedAt: rollback,
                fact: { kind: 'supervisor', state: 'alive' },
              },
            ],
            rollback
          ),
        /provenance/
      );
    } finally {
      Date.now = originalNow;
      await f.cleanup();
    }
  }
);

test(
  'int review status projects committed bound handshake, latest event-ordered report and cause without writes',
  { skip },
  async () => {
    const { fixture } = await helpers();
    const f = await fixture([process.execPath, '-e', '']);
    try {
      const { insertRecord, refValue } = await import('../../src/ledger/records.js');
      const id = f.input.runId,
        linkId = f.prepared.link.linkId,
        at = Date.now();
      const child = {
        harness: 'codex' as const,
        sourceId: f.input.sourceId,
        sessionId: 'synthetic-status-child',
        threadId: null,
      };
      await f.ledger.transaction((tx: any) => {
        tx.run(
          'INSERT INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
          refValue(child),
          child.harness,
          child.sourceId,
          child.sessionId,
          ''
        );
        insertRecord(tx, 'evidence', {
          evidenceId: 'status-binding-proof',
          runId: id,
          linkId,
          kind: 'trusted_session',
          producer: 'reconciler',
          fingerprint: 'b'.repeat(64),
          payload: {},
          observedAt: at,
          validatedAt: at,
          validation: 'accepted',
        });
        insertRecord(tx, 'child_bindings', {
          bindingId: 'status-binding',
          runId: id,
          sessionRef: child,
          bindingGeneration: 1,
          callerId: 'parent',
          callerContextId: 'parent-context',
          contextGeneration: 1,
          boundBy: 'trusted_session',
          capabilities: 'mcp',
          evidenceId: 'status-binding-proof',
          isCurrent: true,
          createdAt: at,
          revokedAt: null,
        });
        for (const [reportId, createdAt] of [
          ['status-first', at],
          ['status-latest', at - 1],
        ] as const) {
          insertRecord(tx, 'reports', {
            reportId,
            runId: id,
            linkId,
            childBindingId: 'status-binding',
            callerId: 'parent',
            callerContextId: 'parent-context',
            contextGeneration: 1,
            status: 'completed',
            summary: 'synthetic summary',
            path: null,
            createdAt,
          });
          insertRecord(tx, 'events', { runId: id, linkId, kind: 'report.received', payload: { reportId }, at });
        }
        insertRecord(tx, 'events', {
          runId: id,
          linkId,
          kind: 'run.state',
          payload: { cause: 'supervisor_dead', evidenceIds: ['status-proof'] },
          at,
        });
      });
      const before = f.ledger.snapshot((tx: any) => tx.get('SELECT count(*) AS n FROM events').n);
      const status = await new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor()).status(id);
      assert.equal(status.runHandshake.state, 'bound');
      assert.equal(status.latestReportForRun?.reportId, 'status-latest');
      assert.equal(status.reconciliation?.cause, 'supervisor_dead');
      assert.deepEqual(status.reconciliation?.evidenceIds, ['status-proof']);
      assert.equal(status.resumable.resumable, false);
      assert.equal(
        f.ledger.snapshot((tx: any) => tx.get('SELECT count(*) AS n FROM events').n),
        before
      );
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'int final review queued reads allow management and heartbeat overlap on one real connection',
  { skip },
  async () => {
    const { fixture } = await helpers();
    const f = await fixture([process.execPath, '-e', '']);
    try {
      const id = f.input.runId,
        stamp = readProcess(process.pid)!.stamp,
        actor = new PrivateLedgerGate(f.home).actor();
      await f.port.register(id, f.ticket, f.prepared.run.launchDigest, stamp);
      await f.port.authorizeManager(id, actor, 'reconcile');
      let pending = f.port.ledger.transaction(() => undefined);
      await Promise.resolve();
      assert.ok(await f.port.acceptCancel(id, actor, 0));
      await pending;
      const s = await f.port.read(id);
      pending = f.port.ledger.transaction(() => undefined);
      await Promise.resolve();
      assert.ok(await f.port.reconcile(id, s.revision, [], Date.now()));
      await pending;
      pending = f.port.ledger.transaction(() => undefined);
      await Promise.resolve();
      const h = await f.port.heartbeat(id, stamp, 1, performance.now());
      await pending;
      assert.equal(h?.seq, 2);
      assert.ok(h?.cancel);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'int final review separate recovery process cannot impersonate original raw/startup/receipt writer',
  { skip },
  async () => {
    const { fixture } = await helpers();
    const f = await fixture([process.execPath, '-e', '']);
    const { spawn } = await import('node:child_process');
    try {
      await f.port.register(f.input.runId, f.ticket, f.prepared.run.launchDigest, readProcess(process.pid)!.stamp);
      const child = spawn(process.execPath, ['tests/int/recovery-writer.mjs', f.input.runId], {
        env: { ...process.env, HUD_HOME: f.home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (x) => (stdout += x));
      child.stderr.on('data', (x) => (stderr += x));
      const done = new Promise<number | null>((r) => child.once('exit', r));
      f.processes.push({ child, done });
      assert.equal(await done, 0, stderr);
      assert.deepEqual(
        JSON.parse(stdout).map((r: any) => [r.operation, r.accepted, r.reason]),
        [
          ['raw', false, 'original_executor_required'],
          ['startup', false, 'original_executor_required'],
          ['receipt', false, 'original_executor_required'],
        ]
      );
      assert.equal(
        (await f.port.read(f.input.runId)).events.some((e: any) => e.kind === 'clock.anomaly'),
        false
      );
      assert.equal((await f.port.read(f.input.runId)).meta, null);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'int final review historical final R imports after labelled current-boot mismatch without requiring Q',
  { skip },
  async () => {
    const { fixture } = await helpers();
    const f = await fixture([process.execPath, '-e', 'setTimeout(()=>process.exit(7),250)']);
    const { spawn } = await import('node:child_process');
    try {
      const control = new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor());
      f.port.receipt = async () => {
        throw new Error('synthetic-receipt-cut');
      };
      await assert.rejects(() => control.start({ input: f.input, ticket: f.ticket }), /synthetic-receipt-cut/);
      const child = spawn(process.execPath, ['tests/int/recover-next-boot.mjs', f.input.runId], {
        env: { ...process.env, HUD_HOME: f.home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (x) => (stdout += x));
      child.stderr.on('data', (x) => (stderr += x));
      const done = new Promise<number | null>((r) => child.once('exit', r));
      f.processes.push({ child, done });
      assert.equal(await done, 0, stderr);
      assert.equal(JSON.parse(stdout).currentRun.state, 'ended');
      const s = await f.port.read(f.input.runId);
      assert.equal(s.run.exitCode, 7);
      assert.equal(s.slotHeld, false);
      assert.ok(s.receipt);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'int final review same uncertain state persists a changed cause once, status reads latest summary',
  { skip },
  async () => {
    const { fixture } = await helpers();
    const f = await fixture([process.execPath, '-e', '']);
    try {
      const id = f.input.runId,
        stamp = readProcess(process.pid)!.stamp;
      await f.port.register(id, f.ticket, f.prepared.run.launchDigest, stamp);
      const control = new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor());
      const first = await control.reconcile(id);
      assert.equal(first.currentRun?.state, 'uncertain');
      assert.equal(first.reconciliation?.cause, 'scope_unknown');
      await f.port.raw(id, stamp, 'clock.anomaly', { wallDeltaMs: -1000, monoDeltaMs: 1 });
      const changed = await control.reconcile(id);
      assert.equal(changed.currentRun?.state, 'uncertain');
      assert.equal(changed.reconciliation?.cause, 'clock_anomaly');
      const count = (await f.port.read(id)).events.filter((e: any) => e.kind === 'run.reconciliation').length;
      await control.reconcile(id);
      assert.equal((await f.port.read(id)).events.filter((e: any) => e.kind === 'run.reconciliation').length, count);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'int final review a reserved-run reconciliation summary does not fence its original execution ticket',
  { skip },
  async () => {
    const { fixture, cli } = await helpers();
    const f = await fixture([process.execPath, '-e', 'setTimeout(()=>{},250)']);
    try {
      const control = new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor());
      assert.equal((await control.reconcile(f.input.runId)).currentRun?.state, 'starting');
      const result = await cli(f, ['start'], { input: f.input, ticket: f.ticket }).done;
      assert.equal(result.code, 0, result.stderr);
      assert.equal((await f.port.read(f.input.runId)).run.state, 'ended');
    } finally {
      await f.cleanup();
    }
  }
);

test('int final review an OS proof changed during revalidation requests a fresh probe', { skip }, async () => {
  const { fixture, cli } = await helpers();
  const f = await fixture([process.execPath, '-e', 'setTimeout(()=>{},250)']);
  try {
    assert.equal((await cli(f, ['start'], { input: f.input, ticket: f.ticket }).done).code, 0);
    await f.port.authorizeManager(f.input.runId, new PrivateLedgerGate(f.home).actor(), 'reconcile');
    const s = await f.port.read(f.input.runId),
      at = Date.now();
    assert.equal(
      await f.port.reconcile(
        f.input.runId,
        s.revision,
        [
          {
            evidenceId: 'earlier-live-observation',
            runId: f.input.runId,
            sourceId: s.run.sourceId,
            bindingGeneration: s.run.expectedGeneration,
            supervisor: s.run.supervisor,
            validation: 'accepted',
            asOf: s.run.startedAt,
            observedAt: at,
            fact: { kind: 'scope', state: 'alive', complete: false, harnessTerminated: false, launchersSealed: false },
          },
        ],
        at
      ),
      null
    );
    assert.equal((await f.port.read(f.input.runId)).run.state, 'ended');
  } finally {
    await f.cleanup();
  }
});

test(
  'int final review a blocked terminal run persists a changed cause without rewriting completion',
  { skip },
  async () => {
    const { fixture, cli } = await helpers();
    const f = await fixture([process.execPath, '-e', 'setTimeout(()=>process.exit(7),250)']);
    try {
      assert.equal((await cli(f, ['start'], { input: f.input, ticket: f.ticket }).done).code, 0);
      const { commitReconcile, readReconcileSnapshot } = await import('../../src/ledger/reconcile.js');
      const { digest } = await import('../../src/core/canonical.js');
      const id = f.input.runId,
        now = Date.now();
      // Explicit synthetic accepted chronology/conflict fixtures exercise A4 decisions.
      const entry = (evidenceId: string, kind: 'scope_reconciled' | 'conflict', asOf: number, fact: any) => {
        const run = readReconcileSnapshot(f.ledger, id).run;
        return {
          record: {
            evidenceId,
            runId: id,
            linkId: run.linkId,
            kind,
            producer: 'reconciler' as const,
            fingerprint: digest(fact),
            payload: {},
            observedAt: now,
            validatedAt: now,
            validation: 'accepted' as const,
          },
          facts: [
            {
              evidenceId,
              runId: id,
              sourceId: run.sourceId,
              bindingGeneration: run.expectedGeneration,
              supervisor: run.supervisor,
              validation: 'accepted' as const,
              asOf,
              observedAt: now,
              fact,
            },
          ],
        };
      };
      await commitReconcile(
        f.ledger,
        readReconcileSnapshot(f.ledger, id),
        [
          entry('synthetic-future-Q', 'scope_reconciled', now + 10000, {
            kind: 'scope_reconciled',
            complete: true,
            harnessTerminated: true,
            launchersSealed: true,
            nativeExit: null,
          }),
        ],
        now
      );
      assert.equal((await f.port.read(id)).status.reconciliation?.cause, 'clock_anomaly');
      await commitReconcile(
        f.ledger,
        readReconcileSnapshot(f.ledger, id),
        [entry('synthetic-terminal-X', 'conflict', now, { kind: 'conflict', cause: 'scope_conflict' })],
        now
      );
      const s = await f.port.read(id);
      assert.equal(s.status.reconciliation?.cause, 'scope_conflict');
      assert.equal(s.run.state, 'ended');
      assert.equal(s.run.exitCode, 7);
      assert.equal(s.slotHeld, false);
      assert.equal(s.events.filter((e: any) => e.kind === 'run.terminal').length, 1);
    } finally {
      await f.cleanup();
    }
  }
);
