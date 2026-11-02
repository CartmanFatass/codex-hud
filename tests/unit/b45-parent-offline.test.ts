import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { acceptIntent } from '../../src/ledger/intents.js';
import { readLink } from '../../src/ledger/records.js';
import { appendRunFact } from '../../src/ledger/run-facts.js';
import { PrivateLedgerGate } from '../../src/ledger/local-manager.js';
import { registerSupervisor } from '../../src/ledger/supervisor.js';
import { commitReconcile, readReconcileSnapshot } from '../../src/ledger/reconcile.js';
import { HandshakeService } from '../../packages/hud-mcp/src/handshake.js';
import { HeadlessRunControl } from '../../src/core/run/control.js';
import { LedgerRunFactPort } from '../../src/core/run/ledger-port.js';
import { readProcess } from '../../src/core/run/process.js';
import type { ProcessStamp } from '../../src/core/types/supervision.js';
import { handshakeFixture, hashClaim } from './b45-handshake-fixture.js';
const skip = ledgerRuntimeSupported() ? false : 'Ledger requires Node 22 >=22.13 or >=24';

async function resumed(initiator: 'mcp' | 'local_user') {
  const f = await handshakeFixture();
  try {
    await f.startup();
    const service = new HandshakeService({
      ledger: f.ledger,
      registration: f.child.registration,
      reader: f.reader,
      env: { HUD_CLAIM: f.claim },
      now: f.now,
    });
    await service.whoami({}, f.child.authority);
    const prior = readReconcileSnapshot(f.ledger, 'run-a');
    const fact = {
      evidenceId: 'synthetic-complete',
      runId: 'run-a',
      sourceId: f.source.sourceId,
      bindingGeneration: 1,
      supervisor: prior.run.supervisor,
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
    await commitReconcile(
      f.ledger,
      prior,
      [
        {
          record: {
            evidenceId: fact.evidenceId,
            runId: 'run-a',
            linkId: 'link-a',
            kind: 'scope_reconciled',
            producer: 'reconciler',
            fingerprint: hashClaim('complete'),
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
    const restart = await f.actor('parent-restarted', 10000, 'synthetic-parent', 10002);
    const input = structuredClone(f.input);
    input.requestKey = 'resume-parent-offline';
    input.newSession = false;
    input.params = { ...input.params, linkId: 'link-a', expectedRun: 'run-a', orphanPolicy: 'stop' };
    input.link = f.ledger.snapshot((tx) => readLink(tx, 'link-a'));
    input.run = {
      ...input.run,
      runId: 'run-resume',
      runSeq: 2,
      operation: 'resume',
      targetSessionRef: f.child.ref,
      expectedGeneration: 2,
      createdAt: 1040,
      launchTokenHash: hashClaim('resume-ticket'),
      launchDigest: hashClaim('resume-launch'),
      launchCallId: initiator === 'mcp' ? 'restarted-parent-call' : 'local:offline-test',
      launchCorrelationId: 'resume-correlation',
      orphanPolicy: 'stop',
    };
    input.claim = {
      ...input.claim,
      runId: 'run-resume',
      claimHash: hashClaim('resume-claim'),
      expectedGeneration: 2,
      issuedAt: 1040,
      expiresAt: 1801040,
    };
    input.authority =
      initiator === 'mcp'
        ? restart.authority
        : {
            kind: 'local_user',
            uid: process.getuid!(),
            ownerUid: process.getuid!(),
            invocationId: 'offline-test',
            hudHomeOwned: true,
            ledgerOwned: true,
            privatePaths: true,
          };
    const gate = initiator === 'local_user' ? new PrivateLedgerGate(f.root) : undefined;
    await acceptIntent(f.ledger, input, 20, gate ? () => gate.check() : undefined);
    const supervisor = {
      pid: 16000,
      proc_start: '16000',
      boot_id: f.meta.supervisor!.boot_id,
      pid_domain: f.meta.supervisor!.pid_domain,
    };
    await registerSupervisor(f.ledger, {
      runId: input.run.runId,
      ticketHash: input.run.launchTokenHash,
      launchDigest: input.run.launchDigest,
      supervisor,
      authority: input.authority,
      at: 1041,
      monoMs: 1,
    });
    return { f, restart, supervisor, input };
  } catch (error) {
    await f.close();
    throw error;
  }
}

test(
  'B45 orphan stop follows restarted MCP resume accepted actor and keeps original link creator history',
  { skip },
  async () => {
    const { f, restart, supervisor, input } = await resumed('mcp');
    try {
      const offline = {
        contextId: restart.context.contextId,
        generation: restart.context.generation,
        since: 1050,
        orphanPolicy: 'stop',
      };
      await assert.rejects(
        appendRunFact(f.ledger, input.run.runId, supervisor, 'parent.offline', {
          ...offline,
          contextId: f.parent.context.contextId,
          generation: f.parent.context.generation,
        }),
        /parent_mismatch/
      );
      await appendRunFact(f.ledger, input.run.runId, supervisor, 'parent.offline', offline);
      const observed = f.ledger.snapshot((tx) => ({
        events: tx.all("SELECT * FROM events WHERE run_id=? AND kind='parent.offline'", input.run.runId),
        link: readLink(tx, input.link.linkId),
      }));
      assert.equal(observed.events.length, 1);
      assert.deepEqual(JSON.parse(String(observed.events[0].payload)), offline);
      assert.equal(observed.link.parentContextId, f.parent.context.contextId);
      assert.equal(observed.link.parentCaller, f.parent.registration.caller.callerId);
      assert.notEqual(observed.link.parentContextId, restart.context.contextId);
    } finally {
      await f.close();
    }
  }
);

test('B45 local-user resume never accepts an MCP parent-offline notification', { skip }, async () => {
  const { f, restart, supervisor, input } = await resumed('local_user');
  try {
    for (const actor of [f.parent, restart])
      await assert.rejects(
        appendRunFact(f.ledger, input.run.runId, supervisor, 'parent.offline', {
          contextId: actor.context.contextId,
          generation: actor.context.generation,
          since: 1050,
          orphanPolicy: 'stop',
        }),
        /parent_mismatch/
      );
    assert.equal(
      f.ledger.snapshot(
        (tx) => tx.get("SELECT count(*) AS n FROM events WHERE run_id=? AND kind='parent.offline'", input.run.runId)?.n
      ),
      0
    );
  } finally {
    await f.close();
  }
});

test(
  'B45 supervisor full-parent notification reaches raw whitelist and accepts orphan stop cancellation',
  { skip },
  async () => {
    const { f, restart, supervisor, input } = await resumed('mcp');
    try {
      // This fixture registers a synthetic supervisor. Keep the real ledger read,
      // raw whitelist, registered-writer check and orphan cancellation transaction;
      // only the adapter's live physical-executor check is outside this unit boundary.
      class SyntheticRegisteredPort extends LedgerRunFactPort {
        override raw(runId: string, producer: ProcessStamp, kind: string, payload: Record<string, unknown>) {
          return appendRunFact(this.ledger, runId, producer, kind, payload);
        }
      }
      const gate = new PrivateLedgerGate(f.root);
      const port = new SyntheticRegisteredPort(f.ledger, gate);
      const control = new HeadlessRunControl(port, f.root, gate.actor());
      // Match the complete StartOptions.parent value passed by the supervisor's
      // physical-parent watcher. Spreading this object into raw events is invalid.
      const parent = {
        process: readProcess(process.pid)!.stamp,
        contextId: restart.context.contextId,
        generation: restart.context.generation,
      };
      await control.parentOffline(input.run.runId, parent, supervisor);
      const result = await port.read(input.run.runId);
      const events = result.events.filter((event) => event.kind === 'parent.offline');
      assert.equal(events.length, 1);
      assert.deepEqual(Object.keys(events[0].payload).sort(), ['contextId', 'generation', 'orphanPolicy', 'since']);
      assert.equal(Object.hasOwn(events[0].payload, 'process'), false);
      assert.equal(events[0].payload.contextId, restart.context.contextId);
      assert.equal(events[0].payload.generation, restart.context.generation);
      assert.equal(events[0].payload.orphanPolicy, 'stop');
      const cancellation = result.events.filter((event) => event.kind === 'cancel.accepted');
      assert.equal(cancellation.length, 1);
      assert.deepEqual(cancellation[0].payload.actor, { kind: 'orphan_policy', supervisor });
      assert.equal(result.run.state, 'cancelling');
      assert.equal(result.slotHeld, true);
      assert.equal(result.status.link.parentContextId, f.parent.context.contextId);
    } finally {
      await f.close();
    }
  }
);
