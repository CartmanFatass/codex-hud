import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProcessKey, makeSourceId, sessionRefKey } from '../../src/core/identity.js';
import { taskDigest } from '../../src/core/lifecycle.js';
import { deriveProcessDomain } from '../../src/core/process-domain.js';
import { openLedger } from '../../src/ledger/ledger.js';
import { acceptIntent } from '../../src/ledger/intents.js';
import { beginSubmission, markSubmitted, recordScope, registerSupervisor } from '../../src/ledger/supervisor.js';
import { insertRecord } from '../../src/ledger/records.js';
import type { PreparedIntent } from '../../src/ledger/types.js';
import type { Caller, CallerContext, CallerScope, SessionRef } from '../../src/core/types/identity.js';
import type { ProcessStamp, RunMeta } from '../../src/core/types/supervision.js';
import type { ChildAuthority } from '../../src/ledger/handshake.js';
import type { Registration } from '../../packages/hud-mcp/src/registry.js';
import type { ProcessInfo, ProcessReaderPort } from '../../packages/hud-mcp/src/process.js';

export const hashClaim = (claim: string) => createHash('sha256').update(claim).digest('hex');
export async function handshakeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'hud-b45-handshake-'));
  const ledger = await openLedger(join(root, 'ledger.sqlite'));
  const sourceId = makeSourceId('codex', root);
  const source = { sourceId, harness: 'codex' as const, rootPath: root, label: 'Synthetic handshake' };
  let at = 1020;
  const now = () => at;
  const domainInputs = {
    machineId: 'synthetic-machine',
    bootId: 'synthetic-boot',
    pidNamespace: 'synthetic-pid-ns',
  };
  const domain = deriveProcessDomain(domainInputs);
  const processes = new Map<number, ProcessInfo>();
  const reader: ProcessReaderPort = {
    domain: () => domain,
    get: (pid) => {
      const p = processes.get(pid);
      if (!p) throw new Error('process_missing');
      return structuredClone(p);
    },
  };
  await ledger.transaction((tx) => insertRecord(tx, 'sources', source));
  async function actor(id: string, harnessPid: number, sessionId: string, callerPid = harnessPid + 1) {
    const harnessStart = String(harnessPid);
    const processKey = makeProcessKey('codex', sourceId, domain.pidDomain, harnessPid, harnessStart);
    const ref: SessionRef = { harness: 'codex', sourceId, sessionId, threadId: null };
    const caller: Caller = {
      callerId: id,
      instanceKind: 'dedicated',
      harness: 'codex',
      sourceId,
      pid: callerPid,
      procStart: String(callerPid),
      ppid: harnessPid,
      parentProcStart: harnessStart,
      cwd: root,
      envPane: null,
      startedAt: 1000,
      lastSeenAt: 1000,
      retiredAt: null,
    };
    const evidenceId = `identity-${id}`;
    const scope: CallerScope = {
      processKey,
      generation: 1,
      harness: 'codex',
      sourceId,
      pidDomain: domain.pidDomain,
      harnessPid,
      harnessProcStart: harnessStart,
      sessionRef: ref,
      boundBy: 'trusted_session',
      bindingEvidenceId: evidenceId,
      createdAt: 1000,
      closedAt: null,
    };
    const context: CallerContext = {
      contextId: `context-${id}`,
      generation: 1,
      callerId: id,
      kind: 'dedicated',
      contextKey: 'stdio',
      harness: 'codex',
      sourceId,
      processKey,
      procGeneration: 1,
      sessionRef: ref,
      boundBy: 'trusted_session',
      bindingEvidenceId: evidenceId,
      selectionEvidenceId: evidenceId,
      createdAt: 1000,
      closedAt: null,
    };
    await ledger.transaction((tx) => {
      tx.run(
        'INSERT OR IGNORE INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
        sessionRefKey(ref),
        'codex',
        sourceId,
        sessionId,
        ''
      );
      insertRecord(tx, 'evidence', {
        evidenceId,
        runId: null,
        linkId: null,
        kind: 'trusted_session',
        producer: 'reconciler',
        fingerprint: hashClaim(evidenceId),
        payload: {},
        observedAt: 1000,
        validatedAt: 1000,
        validation: 'accepted',
      });
      insertRecord(tx, 'callers', caller);
      if (!tx.get('SELECT 1 FROM caller_scopes WHERE process_key=? AND generation=1', processKey))
        insertRecord(tx, 'caller_scopes', scope);
      insertRecord(tx, 'caller_contexts', context);
    });
    processes.set(harnessPid, {
      pid: harnessPid,
      ppid: 15000,
      procStart: harnessStart,
      argv: ['/synthetic/bin/codex'],
      env: { CODEX_HOME: root },
      pidNamespace: 'synthetic-pid-ns',
    });
    processes.set(callerPid, {
      pid: callerPid,
      ppid: harnessPid,
      procStart: caller.procStart,
      argv: ['/synthetic/bin/node'],
      env: {},
      pidNamespace: 'synthetic-pid-ns',
    });
    const authority: ChildAuthority = {
      kind: 'mcp',
      contextId: context.contextId,
      generation: 1,
      evidence: {
        physicalCallerVerified: true,
        pidDomainVisible: true,
        profileObservesSessionSwitch: true,
        topology: 'direct_stdio',
        logicalSource: 'root',
        processKey,
        procGeneration: 1,
        sessionRef: ref,
      },
    };
    const registration: Registration = { caller, source, harnessPid, harnessProcStart: harnessStart };
    return { authority, registration, context, ref };
  }
  const parent = await actor('parent', 10000, 'synthetic-parent');
  const child = await actor('child', 20000, 'synthetic-child');
  const claim = 'synthetic-claim-with-256-bits-of-fixture-entropy';
  const input: PreparedIntent = {
    requestKey: 'synthetic-spawn',
    params: {
      sourceId,
      mode: 'headless',
      backend: 'codex',
      role: 'implementer',
      briefPath: '/synthetic/brief.md',
      briefContentHash: hashClaim('brief'),
      launchCwd: root,
    },
    link: {
      linkId: 'link-a',
      state: 'pending',
      parentCaller: 'parent',
      parentContextId: parent.context.contextId,
      parentContextGeneration: 1,
      parentRef: parent.ref,
      childRef: null,
      currentOwner: false,
      backend: 'codex',
      role: 'implementer',
      label: null,
      briefPath: '/synthetic/brief.md',
      taskDigest: taskDigest('/synthetic/brief.md', hashClaim('brief'), 'codex', sourceId, 'implementer'),
      reportPath: null,
      predecessor: null,
      routing: null,
      createdAt: 1000,
      claimedAt: null,
      boundAt: null,
      closedAt: null,
    },
    run: {
      runId: 'run-a',
      linkId: 'link-a',
      runSeq: 1,
      operation: 'spawn',
      targetSessionRef: null,
      sourceId,
      harness: 'codex',
      expectedGeneration: 1,
      mode: 'headless',
      launchCwd: root,
      workspaceSnapshot: null,
      projectOrigin: null,
      supervisionStrategy: 'headless',
      scopeKind: 'pgid',
      scopeRef: null,
      state: 'starting',
      locator: null,
      launchTokenHash: hashClaim('ticket'),
      launchDigest: hashClaim('launch'),
      launchPhase: 'reserved',
      launchCallId: 'call-a',
      launchCorrelationId: 'correlation-a',
      launchMessageId: null,
      supervisor: null,
      heartbeatAt: null,
      heartbeatSeq: 0,
      heartbeatMonoMs: null,
      cancelRequestedAt: null,
      submissionFencedAt: null,
      createdAt: 1000,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      exitSource: null,
      shellStatus: null,
      shellSignal: null,
      terminalEvidenceId: null,
      orphanPolicy: 'continue',
    },
    claim: {
      runId: 'run-a',
      claimHash: hashClaim(claim),
      sourceId,
      expectedGeneration: 1,
      supervisor: null,
      state: 'issued',
      issuedAt: 1000,
      expiresAt: 1801000,
      redeemedContextId: null,
      redeemedGeneration: null,
      redeemedSessionRef: null,
      redeemedAt: null,
    },
    authority: parent.authority,
    capabilityVerified: true,
    newSession: true,
    holder: 'synthetic-supervisor',
  };
  await acceptIntent(ledger, input);
  const supervisor: ProcessStamp = {
    pid: 15000,
    proc_start: '15000',
    boot_id: domain.bootId,
    pid_domain: domain.runPidDomain,
  };
  const registration = {
    runId: 'run-a',
    ticketHash: input.run.launchTokenHash,
    launchDigest: input.run.launchDigest,
    supervisor,
    authority: parent.authority,
    at: 1001,
    monoMs: 1,
  };
  await registerSupervisor(ledger, registration);
  await beginSubmission(ledger, { ...registration, at: 1002 });
  await markSubmitted(ledger, 'run-a', supervisor, 1003);
  const harness: ProcessStamp = {
    pid: 20000,
    proc_start: '20000',
    boot_id: domain.bootId,
    pid_domain: domain.runPidDomain,
  };
  const scope = {
    scope_id: 'scope-a',
    scope_kind: 'pgid' as const,
    boot_id: domain.bootId,
    pid_domain: domain.runPidDomain,
    pgid: 20000,
    sid: 20000,
    group_leader: harness,
  };
  const meta: RunMeta = {
    schema_version: 1,
    run_id: 'run-a',
    link_id: 'link-a',
    source_id: sourceId,
    binding_generation: 1,
    mode: 'headless',
    supervision_strategy: 'headless',
    supervisor,
    command_leader: harness,
    harness,
    scope,
    launch_digest: input.run.launchDigest,
    profile_digest: hashClaim('profile'),
    launch_call_id: 'call-a',
    launch_correlation_id: 'correlation-a',
    created_at: 1000,
    stdin_mode: 'brief',
    capture: 'file',
    launch_cwd: root,
    project_origin: null,
  };
  const startup = () => recordScope(ledger, 'run-a', supervisor, scope, 1004, meta);
  return {
    ledger,
    root,
    reader,
    domainInputs,
    source,
    child,
    parent,
    claim,
    input,
    meta,
    startup,
    actor,
    now,
    setNow: (value: number) => (at = value),
    processes,
    close: async () => {
      await ledger.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
