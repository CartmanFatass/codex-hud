import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { openLedger } from '../../dist-test/src/ledger/ledger.js';
import { acceptIntent } from '../../dist-test/src/ledger/intents.js';
import { createRunFactPort } from '../../dist-test/src/core/run/ledger-port.js';
import { launchDigest } from '../../dist-test/src/core/run/control.js';
import { readProcess, processState } from '../../dist-test/src/core/run/process.js';
import { sameProcessStamp } from '../../dist-test/src/core/supervision.js';
import { seedCaller, intent } from '../ledger/fixtures.mjs';

export async function fixture(argv, home = mkdtempSync(join(tmpdir(), 'hud-int-'))) {
  const ledger = await openLedger(join(home, 'ledger.sqlite'));
  await seedCaller(ledger);
  const data = await addIntent(ledger, home, argv);
  const port = await createRunFactPort(home);
  const processes = [];
  return {
    home,
    ledger,
    port,
    ...data,
    processes,
    async cleanup() {
      let snapshot;
      try {
        snapshot = await port.read(data.input.runId);
      } catch {}
      const meta = snapshot?.meta;
      if (
        meta?.scope &&
        processState(meta.scope.group_leader) === 'alive' &&
        sameProcessStamp(readProcess(meta.scope.pgid)?.stamp ?? null, meta.scope.group_leader)
      ) {
        try {
          process.kill(-meta.scope.pgid, 'SIGKILL');
        } catch {}
      }
      if (
        meta?.harness &&
        processState(meta.harness) === 'alive' &&
        sameProcessStamp(readProcess(meta.harness.pid)?.stamp ?? null, meta.harness)
      ) {
        try {
          process.kill(meta.harness.pid, 'SIGKILL');
        } catch {}
      }
      for (const p of processes) {
        if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill('SIGKILL');
        await p.done;
      }
      await port.close();
      await ledger.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
export async function addIntent(ledger, home, argv, id = randomUUID().replaceAll('-', '')) {
  const prepared = intent(id),
    at = Date.now();
  const input = {
    runId: prepared.run.runId,
    mode: 'headless',
    launch: Array.isArray(argv) ? { argv } : argv,
    cwd: home,
    sourceId: prepared.run.sourceId,
    profileDigest: 'a'.repeat(64),
    stdin: 'closed',
    orphanPolicy: 'continue',
  };
  const ticket = `synthetic-ticket-${id}`;
  prepared.requestKey = `request-${id}`;
  prepared.params.launchCwd = home;
  prepared.link.createdAt = at;
  prepared.run = {
    ...prepared.run,
    launchCwd: home,
    createdAt: at,
    launchTokenHash: createHash('sha256').update(ticket).digest('hex'),
    launchDigest: launchDigest(input),
  };
  prepared.claim.issuedAt = at;
  prepared.claim.expiresAt = at + 1800000;
  await acceptIntent(ledger, prepared);
  return { input, ticket, prepared };
}
export function cli(f, args, input) {
  const env = { ...process.env, HUD_HOME: f.home };
  delete env.HUD_RUN_PORT_MODULE;
  const child = spawn(process.execPath, ['bin/hud-run', ...args], {
    cwd: resolve('.'),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (x) => (stdout += x));
  child.stderr.on('data', (x) => (stderr += x));
  const done = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal, stdout, stderr })));
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  const result = { child, done, stderr: () => stderr };
  f.processes.push(result);
  return result;
}
export async function until(fn, limit = 10000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(20);
  }
  throw new Error('integration event deadline');
}

// Synthetic accepted resume fixture. B4 supplies these typed records in production.
export async function acceptResume(f, kind = 'local_user') {
  const { readReconcileSnapshot } = await import('../../dist-test/src/ledger/reconcile.js');
  const { insertRecord, refValue } = await import('../../dist-test/src/ledger/records.js');
  const parent = { harness: 'codex', sourceId: f.input.sourceId, sessionId: 'synthetic-resume-parent', threadId: null };
  const child = { ...parent, sessionId: 'synthetic-resume-child' };
  const at = Date.now(),
    newKey = JSON.stringify(['codex', parent.sourceId, 'synthetic-domain-new', 42001, 'synthetic-start-new']);
  await f.ledger.transaction((tx) => {
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
    if (kind === 'mcp') {
      insertRecord(tx, 'evidence', {
        evidenceId: 'synthetic-reconnect',
        runId: null,
        linkId: null,
        kind: 'trusted_session',
        producer: 'reconciler',
        fingerprint: 'b'.repeat(64),
        payload: {},
        observedAt: at,
        validatedAt: at,
        validation: 'accepted',
      });
      tx.run(
        "INSERT INTO callers SELECT 'parent-new',instance_kind,harness,source_id,42002,'synthetic-caller-new',42001,'synthetic-start-new',cwd,env_pane,started_at,last_seen_at,NULL FROM callers WHERE caller_id='parent'"
      );
      insertRecord(tx, 'caller_scopes', {
        processKey: newKey,
        generation: 1,
        harness: 'codex',
        sourceId: parent.sourceId,
        pidDomain: 'synthetic-domain-new',
        harnessPid: 42001,
        harnessProcStart: 'synthetic-start-new',
        sessionRef: parent,
        boundBy: 'trusted_session',
        bindingEvidenceId: 'synthetic-reconnect',
        createdAt: at,
        closedAt: null,
      });
      insertRecord(tx, 'caller_contexts', {
        contextId: 'context-new',
        generation: 1,
        callerId: 'parent-new',
        contextKey: 'stdio',
        kind: 'dedicated',
        sourceId: parent.sourceId,
        harness: 'codex',
        processKey: newKey,
        procGeneration: 1,
        sessionRef: parent,
        selectionEvidenceId: null,
        boundBy: 'trusted_session',
        bindingEvidenceId: 'synthetic-reconnect',
        createdAt: at,
        closedAt: null,
      });
      tx.run("UPDATE callers SET retired_at=? WHERE caller_id='parent'", at);
      tx.run("UPDATE caller_contexts SET closed_at=? WHERE caller_id='parent'", at);
      tx.run('UPDATE caller_scopes SET closed_at=? WHERE harness_pid=41001', at);
    }
  });
  const prepared = structuredClone(f.prepared),
    invocationId = 'synthetic-resume-invocation';
  const input = { ...f.input, runId: `run-resume-${kind}` },
    ticket = `synthetic-resume-ticket-${kind}`;
  prepared.requestKey = `resume-key-${kind}`;
  prepared.params = { ...prepared.params, linkId: prepared.link.linkId, expectedRun: f.input.runId };
  prepared.link = readReconcileSnapshot(f.ledger, f.input.runId).link;
  prepared.run = {
    ...prepared.run,
    runId: input.runId,
    runSeq: 2,
    operation: 'resume',
    expectedGeneration: 2,
    targetSessionRef: child,
    createdAt: at,
    launchCallId: kind === 'local_user' ? `local:${invocationId}` : 'synthetic-new-mcp-call',
    launchCorrelationId: `synthetic-resume-correlation-${kind}`,
    launchTokenHash: createHash('sha256').update(ticket).digest('hex'),
    launchDigest: launchDigest(input),
  };
  prepared.claim = {
    ...prepared.claim,
    runId: input.runId,
    expectedGeneration: 2,
    claimHash: 'b'.repeat(64),
    issuedAt: at,
    expiresAt: at + 1800000,
  };
  prepared.authority =
    kind === 'local_user'
      ? {
          kind: 'local_user',
          uid: process.getuid(),
          ownerUid: process.getuid(),
          invocationId,
          hudHomeOwned: true,
          ledgerOwned: true,
          privatePaths: true,
        }
      : {
          kind: 'mcp',
          contextId: 'context-new',
          generation: 1,
          evidence: {
            physicalCallerVerified: true,
            pidDomainVisible: true,
            profileObservesSessionSwitch: true,
            topology: 'direct_stdio',
            logicalSource: 'root',
            processKey: newKey,
            procGeneration: 1,
            sessionRef: parent,
          },
        };
  prepared.newSession = false;
  await acceptIntent(f.ledger, prepared);
  return { input, ticket, prepared };
}
