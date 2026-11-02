import assert from 'node:assert/strict';
import { digest } from '../../../src/core/canonical.js';
import { makeSourceId, selectCallContext, sessionOwnerKey } from '../../../src/core/identity.js';
import { heartbeatQuality, reconcileRun, requestDigest, updateRun } from '../../../src/core/execution.js';
import {
  actionTargetMatches,
  authorizeControl,
  createActionDescriptor,
  prepareResume,
  resumeGate,
  type ResumeGateInput,
} from '../../../src/core/lifecycle.js';
import { codexHudOverrides, injectCodexHudEnv } from '../../../src/core/capabilities.js';
import {
  initialParserState,
  readJsonlBytes,
  JSONL_READER_VERSION,
  runExecutionProjection,
  selectCurrentObservation,
  workspaceDiscoveryPlan,
} from '../../../src/core/observation.js';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  checkScope,
  heartbeatUpdateAllowed,
  inspectReceipt,
  leaseReleasePolicy,
  nativeExit,
  receiptEligibility,
  registeredSupervisor,
  resolveHarness,
  sameProcessStamp,
  scopeUpdateAllowed,
  stdinPlan,
  submissionAllowed,
  supervisionSupport,
  supervisorRegistrationEvent,
  validateRunDirectory,
} from '../../../src/core/supervision.js';
import type {
  FinalExitReceipt,
  ProcessScope,
  ProcessStamp,
  RunMeta,
  ScopeFacts,
} from '../../../src/core/types/supervision.js';
import type { IdempotencyRecord, LedgerEvent, ReconcileEvidence } from '../../../src/core/types/execution.js';
import { fixtureCallEvidence, fixtureContext, fixtureLink, fixtureRun } from './identity-execution.js';

const NOW = 1_700_000_000_000;
const SOURCE = makeSourceId('codex', '/synthetic/home-a');
const OTHER_SOURCE = makeSourceId('codex', '/synthetic/home-b');
const SUPERVISOR: ProcessStamp = {
  pid: 120,
  proc_start: '10001',
  boot_id: 'synthetic-boot-a',
  pid_domain: 'synthetic-machine-a/boot-a/pidns-a',
};
const HARNESS: ProcessStamp = { ...SUPERVISOR, pid: 121, proc_start: '10002' };
const SHELL: ProcessStamp = { ...SUPERVISOR, pid: 122, proc_start: '10003' };
const SCOPE: ProcessScope = {
  scope_id: 'synthetic-scope-a',
  scope_kind: 'pgid',
  pid_domain: HARNESS.pid_domain,
  boot_id: HARNESS.boot_id,
  pgid: HARNESS.pid,
  sid: 119,
  group_leader: HARNESS,
};

function scopeFacts(overrides: Partial<ScopeFacts> = {}): ScopeFacts {
  return {
    scope: SCOPE,
    visibleDomain: true,
    matchingBoot: true,
    sameMachinePreviousBootEnded: false,
    visibility: 'complete',
    memberStates: [],
    harnessTerminated: true,
    launchersSealed: true,
    escapedOriginalWriterAlive: false,
    ...overrides,
  };
}

function meta(): RunMeta {
  return {
    schema_version: 1,
    run_id: 'synthetic-run-a',
    link_id: 'synthetic-link-a',
    source_id: SOURCE,
    binding_generation: 1,
    mode: 'visible',
    supervision_strategy: 'wrapper',
    supervisor: SUPERVISOR,
    command_leader: SHELL,
    harness: HARNESS,
    scope: SCOPE,
    launch_digest: 'a'.repeat(64),
    profile_digest: 'b'.repeat(64),
    launch_call_id: 'synthetic-call-a',
    launch_correlation_id: 'synthetic-correlation-a',
    created_at: NOW,
    stdin_mode: 'tty',
    capture: 'tty_passthrough',
    launch_cwd: '/synthetic/repo-a',
    project_origin: null,
  };
}

function receipt(overrides: Partial<FinalExitReceipt> = {}): FinalExitReceipt {
  return {
    schema_version: 1,
    receipt_id: 'synthetic-receipt-a',
    run_id: 'synthetic-run-a',
    link_id: 'synthetic-link-a',
    source_id: SOURCE,
    binding_generation: 1,
    mode: 'visible',
    strategy: 'wrapper',
    supervisor: SUPERVISOR,
    command_leader: SHELL,
    harness: HARNESS,
    scope: SCOPE,
    coverage: 'scope',
    created_at: NOW,
    started_at: NOW + 100,
    ended_at: NOW + 2_000,
    recorded_at: NOW + 2_010,
    duration_ms: 1_900,
    native_exit: null,
    shell_exit: {
      process: SHELL,
      subject: 'command_leader',
      observed_at: NOW + 1_900,
      exit_code: 137,
      signal: null,
      status_source: 'wait_status',
      evidence_id: 'synthetic-shell-exit',
    },
    reason: 'scope_ended',
    scope_check: {
      scope_id: SCOPE.scope_id,
      checked_at: NOW + 2_000,
      result: 'gone',
      visibility: 'complete',
      member_evidence_ids: [],
      zombie_evidence_ids: ['synthetic-zombie'],
      launcher_seal_evidence_ids: ['synthetic-launcher-seal'],
      harness_termination_evidence_ids: ['synthetic-harness-ended'],
    },
    submission_fence: { event_seq: 12, at: NOW + 1_900, proof_ids: ['synthetic-launcher-seal'] },
    cancel_request_seq: null,
    logs: { stdout: null, stderr: null, capture: 'tty_passthrough' },
    ...overrides,
  };
}

function artifact(value: FinalExitReceipt) {
  return { final: true, complete: true, fingerprint: digest(value), receipt: value };
}

function copyActionsCase(): void {
  const input = {
    linkId: 'synthetic-link-a',
    runId: 'synthetic-run-a',
    reason: 'scope_unknown',
    hudHome: "/synthetic/hud folder/quote'path",
    entryVerified: true,
    operation: 'resume' as const,
    expectedRun: 'synthetic-run-a',
    mode: 'visible' as const,
    requestKey: "synthetic-key'; $(synthetic-command)",
  };
  const first = createActionDescriptor(input);
  const untrustedStrings = {
    ...input,
    label: '$(synthetic-label-command)',
    report: 'synthetic-report; synthetic-command',
  };
  const second = createActionDescriptor(untrustedStrings);
  assert.ok(first);
  assert.deepEqual(first, second);
  assert.equal(first.subject, 'local_user');
  assert.equal(first.delivery, 'copy_only');
  assert.equal(first.operation, 'resume');
  assert.equal(
    first.displayCommand,
    `HUD_HOME='/synthetic/hud folder/quote'"'"'path' hud run resume 'synthetic-link-a' --request-key 'synthetic-key'"'"'; $(synthetic-command)' --expected-run 'synthetic-run-a' --mode 'visible'`
  );
  assert.equal(first.displayCommand.includes('synthetic-label-command'), false);
  assert.equal(first.displayCommand.includes('synthetic-report'), false);
  assert.equal(actionTargetMatches(first, 'synthetic-run-b'), false);
  assert.equal(actionTargetMatches(first, 'synthetic-run-a'), true);
  assert.equal(createActionDescriptor({ ...input, entryVerified: false }), null);
  assert.throws(() => createActionDescriptor({ ...input, expectedRun: 'synthetic-run-b' }), /fixed_action_target/);
  assert.throws(() => createActionDescriptor({ ...input, expectedRun: undefined as never }), /fixed_action_target/);
  assert.throws(() => createActionDescriptor({ ...input, requestKey: '' }), /request_key/);
  assert.throws(() => createActionDescriptor({ ...input, mode: undefined as never }), /fixed_action_target/);
  const reconcile = createActionDescriptor({
    operation: 'reconcile',
    linkId: input.linkId,
    runId: input.runId,
    reason: 'scope_unknown',
    hudHome: '/synthetic/hud',
    entryVerified: true,
  });
  assert.ok(reconcile);
  assert.equal(reconcile.operation, 'reconcile');
  assert.equal(reconcile.displayCommand, "HUD_HOME='/synthetic/hud' hud run reconcile 'synthetic-run-a'");
  assert.equal('force' in reconcile, false);
}

function localResumeCase(): void {
  const parentRef = { harness: 'codex' as const, sourceId: SOURCE, sessionId: 'synthetic-parent-a', threadId: null };
  const childRef = { ...parentRef, sessionId: 'synthetic-child-a' };
  const link = fixtureLink({ parentRef, childRef, state: 'bound', currentOwner: true });
  const run = fixtureRun({
    runId: 'synthetic-run-a',
    linkId: link.linkId,
    targetSessionRef: childRef,
    sourceId: SOURCE,
    state: 'ended',
    endedAt: NOW + 1_000,
    terminalEvidenceId: 'synthetic-terminal-a',
    submissionFencedAt: NOW + 900,
  });
  const ownerKey = sessionOwnerKey(parentRef);
  const authority = {
    kind: 'local_user' as const,
    uid: 1_000,
    ownerUid: 1_000,
    invocationId: 'synthetic-local-invocation',
    hudHomeOwned: true,
    ledgerOwned: true,
    privatePaths: true,
  };
  const gate: ResumeGateInput = {
    link,
    registeredOwner: ownerKey,
    authority,
    currentRun: run,
    expectedRun: run.runId,
    taskDigest: link.taskDigest,
    slotHeld: false,
    unresolvedConflict: false,
    capabilityVerified: true,
  };
  const request = { launchCwd: '/synthetic/repo-a', mode: 'visible', expectedRun: run.runId, linkId: link.linkId };
  const paramsDigest = requestDigest('resume', request);
  const record: IdempotencyRecord = {
    ownerKey,
    originOwnerKey: ownerKey,
    requestKey: 'synthetic-resume-key',
    paramsVersion: 1,
    paramsDigest,
    linkId: link.linkId,
    runId: 'synthetic-run-b',
    outcome: { accepted: true, runId: 'synthetic-run-b' },
    at: NOW + 2_000,
  };
  const changedRun = { ...gate, currentRun: { ...run, runId: 'synthetic-run-b', runSeq: run.runSeq + 1 } };
  const replay = prepareResume(changedRun, [record], record.requestKey, paramsDigest);
  assert.equal(replay.kind, 'replay');
  if (replay.kind === 'replay') {
    assert.deepEqual(replay.record, record);
    assert.deepEqual(replay.actor, {
      kind: 'local_user',
      uid: 1_000,
      invocationId: authority.invocationId,
      representedOwner: ownerKey,
    });
    assert.equal('callerId' in replay.actor, false);
  }
  assert.deepEqual(prepareResume(changedRun, [record], 'synthetic-new-key', paramsDigest), {
    kind: 'rejected',
    reason: 'expected_run_mismatch',
  });
  assert.deepEqual(
    prepareResume(gate, [record], record.requestKey, requestDigest('resume', { ...request, mode: 'headless' })),
    { kind: 'rejected', reason: 'idempotency_conflict' }
  );
  assert.equal(
    prepareResume({ ...changedRun, authority: { ...authority, uid: 999 } }, [record], record.requestKey, paramsDigest)
      .kind,
    'rejected'
  );
  assert.equal(
    prepareResume({ ...gate, link: { ...link, parentRef: null } }, [record], record.requestKey, paramsDigest).kind,
    'rejected'
  );
  assert.equal(
    authorizeControl('resume', link, ownerKey, {
      kind: 'mcp',
      selection: { ok: false, reason: 'stale_context', invalidate: false },
    }).ok,
    false
  );
  for (const operation of ['spawn', 'report', 'predecessor'] as const) {
    assert.equal(authorizeControl(operation, link, ownerKey, authority).ok, false);
  }
  for (const change of [
    { slotHeld: true },
    { unresolvedConflict: true },
    { capabilityVerified: false },
    { taskDigest: 'f'.repeat(64) },
    { link: { ...link, currentOwner: false } },
  ])
    assert.equal(resumeGate({ ...gate, ...change }).ok, false);
  assert.equal(resumeGate(gate).ok, true);
}

export const supervisionCases: Record<string, () => void> = {
  'T-04-2': () => {
    assert.notEqual(SOURCE, OTHER_SOURCE);
    assert.equal(
      resolveHarness(
        [{ stamp: HARNESS, sourceId: OTHER_SOURCE, harness: 'codex', independentLaunchProof: true }],
        SOURCE
      ),
      null
    );
    assert.deepEqual(stdinPlan('headless', 'brief'), { accepted: true, closeAfterBrief: true, readTerminal: false });
    assert.deepEqual(stdinPlan('headless', 'closed'), { accepted: true, closeAfterBrief: false, readTerminal: false });
    assert.deepEqual(stdinPlan('visible', 'tty'), { accepted: true, closeAfterBrief: false, readTerminal: false });
    assert.equal(stdinPlan('visible', 'brief').accepted, false);
  },
  'T-04-4': () => {
    const candidate = { stamp: HARNESS, sourceId: SOURCE, harness: 'codex' as const, independentLaunchProof: true };
    assert.deepEqual(resolveHarness([candidate], SOURCE), HARNESS);
    assert.equal(resolveHarness([candidate, { ...candidate, stamp: SHELL }], SOURCE), null);
    assert.equal(resolveHarness([{ ...candidate, independentLaunchProof: false }], SOURCE), null);
    assert.equal(resolveHarness([], SOURCE), null);
    assert.equal(sameProcessStamp(HARNESS, SHELL), false);
    assert.equal(sameProcessStamp(HARNESS, { ...HARNESS, proc_start: 'reused-pid' }), false);
  },
  'T-04-6': () => {
    assert.equal(supervisionSupport('wrapper', 'pgid', true), null);
    assert.equal(supervisionSupport('wrapper', 'cgroup', true), 'unsupported');
    assert.equal(supervisionSupport('wrapper', 'pgid', false), 'scope_unknown');
    assert.equal(scopeUpdateAllowed(SCOPE, { ...SCOPE, pgid: 999 }), false);
    assert.equal(scopeUpdateAllowed(SCOPE, null), false);
  },
  'T-04-7': () => {
    assert.equal(scopeUpdateAllowed(null, SCOPE), true);
    assert.equal(scopeUpdateAllowed(SCOPE, { ...SCOPE }), true);
    assert.equal(scopeUpdateAllowed(SCOPE, { ...SCOPE, scope_id: 'guessed-from-cwd' }), false);
    assert.equal(checkScope(scopeFacts()).result, 'gone');
    assert.equal(checkScope(scopeFacts({ escapedOriginalWriterAlive: true })).conflict, true);
    assert.equal(checkScope(scopeFacts({ escapedOriginalWriterAlive: true })).result, 'unknown');
    assert.equal(checkScope(scopeFacts({ scope: null })).result, 'unknown');
  },
  'T-04-8': () => {
    const directory = {
      runId: 'synthetic-run-a',
      hudHome: '/synthetic/hud',
      currentUid: 1_000,
      ownerUid: 1_000,
      symlinkEncountered: false,
      existingRunMatches: true,
      ticketWinner: true,
    };
    const good = validateRunDirectory(directory);
    assert.equal(good.allowed, true);
    assert.equal(good.directoryMode, 0o700);
    assert.equal(good.fileMode, 0o600);
    for (const override of [
      { runId: '../escape' },
      { runId: 'a/b' },
      { runId: '' },
      { hudHome: '/synthetic/../hud' },
      { hudHome: 'relative' },
      { symlinkEncountered: true },
      { ownerUid: 999 },
      { existingRunMatches: false },
      { ticketWinner: false },
    ]) {
      assert.equal(validateRunDirectory({ ...directory, ...override }).allowed, false);
    }
  },
  'T-04-9': () => {
    const value = receipt();
    const complete = artifact(value);
    const imported = new Map([[value.receipt_id, complete.fingerprint]]);
    assert.equal(inspectReceipt({ ...complete, final: false }, meta(), imported).decision, 'ignore');
    assert.equal(inspectReceipt({ ...complete, complete: false }, meta(), imported).decision, 'ignore');
    assert.equal(inspectReceipt(complete, meta(), imported).decision, 'duplicate');
    assert.equal(
      inspectReceipt({ ...complete, fingerprint: 'f'.repeat(64) }, meta(), imported).reason,
      'receipt_conflict'
    );
    assert.equal(inspectReceipt(complete, meta(), new Map()).decision, 'adopt');
    assert.equal('revision' in value, false);
  },
  'T-04-12': () => {
    const value = receipt();
    assert.equal(nativeExit(value.shell_exit), null);
    assert.equal(receiptEligibility({ ...value, scope: null, scope_check: null }), 'scope_unknown');
    assert.equal(receiptEligibility(value), null);
    assert.equal(value.native_exit, null);
    assert.equal(value.shell_exit?.exit_code, 137);
    assert.equal(
      inspectReceipt({ final: false, complete: true, fingerprint: 'a'.repeat(64), receipt: null }, meta(), new Map())
        .decision,
      'ignore'
    );
  },
  'T-04-13': () => {
    const value = receipt();
    assert.equal(
      receiptEligibility({ ...value, scope_check: { ...value.scope_check!, result: 'alive' } }),
      'scope_not_ended'
    );
    assert.equal(
      receiptEligibility({ ...value, submission_fence: { ...value.submission_fence, proof_ids: [] } }),
      'launcher_seal_missing'
    );
    assert.equal(inspectReceipt(artifact({ ...value, binding_generation: 2 }), meta(), new Map()).decision, 'audit');
    assert.equal(
      inspectReceipt(
        artifact({ ...value, supervisor: { ...SUPERVISOR, boot_id: 'synthetic-boot-b' } }),
        meta(),
        new Map()
      ).decision,
      'audit'
    );
    assert.deepEqual(checkScope(scopeFacts({ matchingBoot: false, sameMachinePreviousBootEnded: true })), {
      result: 'gone',
      conflict: false,
      inspectCurrentBootGroup: false,
    });
    for (const state of ['S', 'T', 'D'])
      assert.equal(checkScope(scopeFacts({ memberStates: [state] })).result, 'alive');
    assert.equal(checkScope(scopeFacts({ memberStates: ['Z'] })).result, 'gone');
    assert.equal(checkScope(scopeFacts({ visibility: 'partial' })).result, 'unknown');
  },
  'T-04-14': () => {
    const value = receipt();
    const input = artifact(value);
    assert.deepEqual(inspectReceipt(input, meta(), new Map()), { decision: 'adopt', reason: null });
    assert.equal(inspectReceipt(input, meta(), new Map([[value.receipt_id, input.fingerprint]])).decision, 'duplicate');
    // A Q decision consumes scope facts without creating an absent dead-writer receipt.
    const missingArtifact = { final: false, complete: false, fingerprint: '', receipt: null };
    assert.equal(inspectReceipt(missingArtifact, meta(), new Map()).decision, 'ignore');
    assert.equal(checkScope(scopeFacts()).result, 'gone');
    assert.equal(value.native_exit, null);
    const run = fixtureRun({
      runId: value.run_id,
      linkId: value.link_id,
      sourceId: SOURCE,
      state: 'uncertain',
      expectedGeneration: 1,
      supervisor: SUPERVISOR,
      cancelRequestedAt: null,
    });
    const facts: ReconcileEvidence[] = [
      {
        evidenceId: 'synthetic-scope-recheck',
        runId: run.runId,
        sourceId: SOURCE,
        bindingGeneration: 1,
        supervisor: SUPERVISOR,
        validation: 'accepted',
        asOf: NOW + 3_000,
        observedAt: NOW + 3_000,
        fact: { kind: 'scope', state: 'gone', complete: true, harnessTerminated: true, launchersSealed: true },
      },
      {
        evidenceId: 'synthetic-q',
        runId: run.runId,
        sourceId: SOURCE,
        bindingGeneration: 1,
        supervisor: SUPERVISOR,
        validation: 'accepted',
        asOf: NOW + 3_000,
        observedAt: NOW + 3_000,
        fact: {
          kind: 'scope_reconciled',
          complete: true,
          harnessTerminated: true,
          launchersSealed: true,
          nativeExit: null,
        },
      },
    ];
    const reconciled = reconcileRun(run, facts, NOW + 3_000);
    assert.equal(reconciled.state, 'ended');
    assert.equal(reconciled.releaseSlot, true);
    assert.equal(reconciled.exitCode, null);
    assert.equal(reconciled.exitSignal, null);
    assert.equal(run.state, 'uncertain');
  },
  'T-04-15': () => {
    const first = Buffer.from('{"type":"message","text":"合成"}\r\n', 'utf8');
    const second = Buffer.from([0, 0xff, 0xc3]);
    const appended = Buffer.concat([first, second]);
    const parsed = readJsonlBytes({
      checkpoint: {
        schemaVersion: 1,
        readerVersion: JSONL_READER_VERSION,
        ref: { harness: 'codex', sourceId: SOURCE, sessionId: 'synthetic-session-a', threadId: null },
        fileId: { dev: 1, inode: 2 },
        offset: 0,
        sourceGeneration: 1,
        parserState: initialParserState(),
      },
      bytes: appended,
      knownEndOffset: appended.byteLength,
    });
    assert.equal(parsed.checkpoint.offset, first.byteLength);
    assert.deepEqual(parsed.records, [{ type: 'message', byteEnd: first.byteLength }]);
    assert.deepEqual(parsed.checkpoint.parserState.pendingBytes, []);
    assert.equal(parsed.nextReadOffset, appended.byteLength);
    assert.deepEqual(appended.subarray(first.byteLength), second);
    assert.notEqual(first.toString('utf8').length, first.byteLength);
    const value = receipt();
    assert.equal(value.logs.capture, 'tty_passthrough');
    assert.equal(value.logs.stdout, null);
    assert.equal(value.logs.stderr, null);
    assert.equal('pty' in value.logs, false);
  },
  'T-04-16': () => {
    assert.equal(HEARTBEAT_INTERVAL_MS, 5_000);
    assert.equal(HEARTBEAT_STALE_MS, 30_000);
    assert.equal(heartbeatQuality(NOW, NOW + 30_000), 'fresh');
    assert.equal(heartbeatQuality(NOW, NOW + 30_001), 'stale');
    assert.equal(heartbeatQuality(NOW, NOW - 1), 'unknown');
    assert.equal(heartbeatQuality(null, NOW), 'unknown');
    const update = {
      producer: SUPERVISOR,
      registeredSupervisor: SUPERVISOR,
      expectedSeq: 4,
      storedSeq: 4,
      terminal: false,
      recoveryObserver: false,
    };
    assert.equal(heartbeatUpdateAllowed(update), true);
    assert.equal(heartbeatUpdateAllowed({ ...update, expectedSeq: 3 }), false);
    assert.equal(heartbeatUpdateAllowed({ ...update, producer: { ...SUPERVISOR, proc_start: 'reused' } }), false);
    assert.equal(heartbeatUpdateAllowed({ ...update, recoveryObserver: true }), false);
    assert.equal(heartbeatUpdateAllowed({ ...update, terminal: true }), false);
  },
  'T-04-20': () => {
    const intent = {
      phase: 'armed' as const,
      originalExecutor: true,
      ticketConsumed: true,
      fenced: false,
      authorized: true,
      recoveryObserver: false,
    };
    assert.equal(submissionAllowed(intent), true);
    assert.equal(submissionAllowed({ ...intent, phase: 'submitting' }), false);
    assert.equal(submissionAllowed({ ...intent, phase: 'submitted' }), false);
    assert.equal(submissionAllowed({ ...intent, originalExecutor: false }), false);
    assert.equal(submissionAllowed({ ...intent, recoveryObserver: true, phase: 'reserved' }), false);
    assert.equal(submissionAllowed({ ...intent, fenced: true }), false);
    assert.equal(submissionAllowed({ ...intent, authorized: false }), false);
  },
  'T-04-31': () => {
    assert.equal(supervisionSupport('sidecar', 'pgid', true), 'unsupported');
    assert.equal(supervisionSupport('wrapper', 'pgid', true), null);
    assert.equal(
      submissionAllowed({
        phase: 'submitting',
        originalExecutor: false,
        ticketConsumed: true,
        fenced: false,
        authorized: true,
        recoveryObserver: true,
      }),
      false
    );
    assert.equal(checkScope(scopeFacts({ scope: null })).result, 'unknown');
  },
  'T-04-32': () => {
    const config = {
      mcp_servers: {
        'hud.synthetic': { command: '/synthetic/hud-mcp', args: ['--stdio'], env: { KEEP: 'synthetic-value' } },
        other: { command: '/synthetic/other', env: { KEEP_OTHER: 'synthetic-other' } },
      },
    };
    const env = {
      HUD_CLAIM: 'synthetic-claim-a',
      HUD_RUN: 'synthetic-run-a',
      HUD_LINK: 'synthetic-link-a',
      HUD_HOME: '/synthetic/hud',
    };
    const injected = injectCodexHudEnv(config, 'hud.synthetic', env);
    assert.deepEqual(injected.config.mcp_servers.other, config.mcp_servers.other);
    assert.equal(injected.config.mcp_servers['hud.synthetic'].command, '/synthetic/hud-mcp');
    assert.equal(injected.config.mcp_servers['hud.synthetic'].env.KEEP, 'synthetic-value');
    assert.equal(config.mcp_servers['hud.synthetic'].env.KEEP, 'synthetic-value');
    assert.equal('HUD_CLAIM' in config.mcp_servers['hud.synthetic'].env, false);
    assert.notDeepEqual(
      injected.argv,
      codexHudOverrides('hud.synthetic', { ...env, HUD_CLAIM: 'synthetic-claim-b', HUD_RUN: 'synthetic-run-b' })
    );
    assert.ok(injected.argv.includes('mcp_servers."hud.synthetic".env.HUD_HOME="/synthetic/hud"'));
    assert.equal('claim' in meta(), false);
    const context = fixtureContext();
    const call = fixtureCallEvidence();
    // initialize/list cannot supply this call's trusted logical source; prompt arguments cannot fill it.
    assert.equal(selectCallContext(context, { ...call, logicalSource: 'missing' }).ok, false);
    assert.equal(selectCallContext(context, { ...call, logicalSource: 'native_child' }).ok, false);
    assert.equal(selectCallContext(context, call).ok, true);
    assert.equal(
      resolveHarness(
        [{ stamp: HARNESS, sourceId: OTHER_SOURCE, harness: 'codex', independentLaunchProof: true }],
        SOURCE
      ),
      null
    );
    assert.equal(
      resolveHarness([{ stamp: HARNESS, sourceId: SOURCE, harness: 'codex', independentLaunchProof: false }], SOURCE),
      null
    );
    assert.deepEqual(
      resolveHarness([{ stamp: HARNESS, sourceId: SOURCE, harness: 'codex', independentLaunchProof: true }], SOURCE),
      HARNESS
    );
  },
  'T-04-33': () => {
    assert.equal(HEARTBEAT_INTERVAL_MS, 5_000);
    assert.equal(HEARTBEAT_STALE_MS, 30_000);
    const value = receipt();
    assert.equal(receiptEligibility(value), null);
    assert.equal(nativeExit(value.shell_exit), null);
    assert.equal(sameProcessStamp(value.command_leader, value.harness), false);
    assert.equal(receiptEligibility({ ...value, reason: 'signal_exit' }), 'native_result_missing');
  },
  'T-04-35': () => {
    assert.equal(leaseReleasePolicy({ kind: 'run', terminalProof: false }), 'hold');
    assert.equal(leaseReleasePolicy({ kind: 'run', terminalProof: true }), 'release');
    for (const outcome of ['needs_human', 'unknown'] as const) {
      assert.equal(leaseReleasePolicy({ kind: 'browser', outcome, reconciled: false }), 'hold');
      assert.equal(leaseReleasePolicy({ kind: 'browser', outcome, reconciled: true }), 'hold');
    }
    assert.equal(leaseReleasePolicy({ kind: 'collect', expired: true, clockKnown: true }), 'takeover');
    assert.equal(leaseReleasePolicy({ kind: 'collect', expired: true, clockKnown: false }), 'read_only');
  },
  'T-04-40': () => {
    const value = meta();
    const observed = { cwd: '/synthetic/elsewhere', cwdSource: 'verified_harness', cwdAsOf: NOW + 500 };
    const historical = JSON.parse(JSON.stringify(value)) as RunMeta;
    assert.notEqual(observed.cwd, historical.launch_cwd);
    assert.equal(historical.launch_cwd, '/synthetic/repo-a');
    assert.equal(historical.project_origin, null);
    assert.equal('workspace' in historical, false);
    assert.equal('heartbeat' in historical, false);
    const savedRun = fixtureRun({ launchCwd: value.launch_cwd, projectOrigin: value.project_origin });
    assert.throws(() => updateRun(savedRun, { launchCwd: observed.cwd }), /launch_context_immutable/);
    for (const path of ['accepted', 'paint', 'statusline', 'transaction'] as const) {
      assert.deepEqual(workspaceDiscoveryPlan({ cwd: value.launch_cwd, generation: 1, path, cache: null }), {
        action: 'unavailable',
        maxProcesses: 0,
        softBudgetMs: 0,
      });
    }
  },
  'T-04-41': () => {
    copyActionsCase();
    localResumeCase();
    assert.equal(
      submissionAllowed({
        phase: 'armed',
        originalExecutor: true,
        ticketConsumed: true,
        fenced: false,
        authorized: true,
        recoveryObserver: false,
      }),
      true
    );
    assert.equal(
      submissionAllowed({
        phase: 'armed',
        originalExecutor: true,
        ticketConsumed: true,
        fenced: false,
        authorized: false,
        recoveryObserver: false,
      }),
      false
    );
  },
  'T-04-43': () => {
    const run = fixtureRun({ supervisor: null, heartbeatAt: null, heartbeatSeq: 0, heartbeatMonoMs: null });
    const record: LedgerEvent = { ...supervisorRegistrationEvent(run, SUPERVISOR, NOW), seq: 1 };
    const committed = JSON.parse(JSON.stringify(record)) as LedgerEvent;
    // Registration survived, meta never did. Only the committed event supplies the historical instance.
    assert.deepEqual(registeredSupervisor(run, [committed]), SUPERVISOR);
    assert.equal(registeredSupervisor(run, []), null);
    const current = { ...SUPERVISOR, boot_id: 'synthetic-boot-b', pid_domain: 'synthetic-other-domain' };
    const historical = registeredSupervisor(run, [committed]);
    assert.equal(sameProcessStamp(historical, current), false);
    assert.throws(
      () => updateRun(fixtureRun({ supervisor: SUPERVISOR }), { supervisor: current }),
      /supervisor_instance_immutable/
    );
    assert.equal(
      heartbeatUpdateAllowed({
        producer: current,
        registeredSupervisor: historical,
        expectedSeq: 1,
        storedSeq: 1,
        terminal: false,
        recoveryObserver: false,
      }),
      false
    );
    assert.equal(checkScope(scopeFacts({ visibleDomain: false, matchingBoot: false })).result, 'unknown');
    for (const payload of [
      { ...record.payload, sourceId: OTHER_SOURCE },
      { ...record.payload, bindingGeneration: 2 },
      { ...record.payload, supervisor: { pid: SUPERVISOR.pid, proc_start: SUPERVISOR.proc_start } },
      { ...record.payload, supervisor: { ...SUPERVISOR, boot_id: '' } },
      { ...record.payload, supervisor: { ...SUPERVISOR, pid_domain: '' } },
    ])
      assert.equal(registeredSupervisor(run, [{ ...record, payload }]), null);
    assert.equal(
      registeredSupervisor(run, [
        record,
        { ...record, seq: 2, payload: { ...record.payload, supervisor: { ...current } } },
      ]),
      null
    );
    const copy = registeredSupervisor(run, [record])!;
    copy.boot_id = 'synthetic-mutated-copy';
    assert.deepEqual(registeredSupervisor(run, [record]), SUPERVISOR);
    assert.throws(() => supervisorRegistrationEvent(run, { ...SUPERVISOR, pid_domain: '' }, NOW), /invalid_supervisor/);
  },
};

export const integrationCases: Record<string, () => void> = {
  'T-03-34': copyActionsCase,
  'T-03-35': () => {
    const failed = runExecutionProjection({ state: 'failed', reason: 'non_execution' });
    assert.equal(failed.isRunTerminal, true);
    assert.equal(failed.execution, 'non_execution');
    assert.deepEqual(failed.launchFailure, { stateKey: 'launch_failed', reason: 'non_execution' });
    assert.equal('lastTurnOutcome' in failed, false);
    const failedReport = { status: 'failed', runId: 'synthetic-run-a' };
    assert.equal(failedReport.status, 'failed');
    assert.equal(runExecutionProjection({ state: 'running' }).isRunTerminal, false);
    assert.equal(runExecutionProjection({ state: 'cancelling' }).isRunTerminal, false);
    assert.equal(runExecutionProjection(null).isRunTerminal, null);
  },
  'T-03-36': () => {
    const ref = { harness: 'codex' as const, sourceId: SOURCE, sessionId: 'synthetic-session-a', threadId: null };
    const stamp = {
      seqDomain: 'synthetic-observation-a',
      commitSeq: 7,
      inputLedgerSeq: 10,
      ref,
      runId: 'synthetic-run-a',
      bindingGeneration: 1,
      sourceGeneration: 2,
    };
    const old = {
      stamp,
      value: { report: 'synthetic-old-completed', stateSince: NOW, cwd: '/synthetic/old-run-cwd' },
    };
    const target = { asOfSeq: 20, ref, runId: 'synthetic-run-b', bindingGeneration: 2, sourceGeneration: 2 };
    const mismatch = selectCurrentObservation(target, old);
    assert.equal(mismatch.asOfSeq, 20);
    assert.equal(mismatch.observation, null);
    assert.notEqual(mismatch.unavailableReason, null);
    assert.deepEqual(mismatch.rejectedObservationStamp, stamp);
    const current = { ...old, stamp: { ...stamp, runId: target.runId, bindingGeneration: 2 } };
    const selected = selectCurrentObservation({ ...target, asOfSeq: 500 }, current);
    assert.deepEqual(selected.observation, current.value);
    assert.equal(selected.observationStamp?.inputLedgerSeq, 10);
    assert.equal(selectCurrentObservation({ ...target, asOfSeq: null }, null).asOfSeq, null);
    assert.equal(selectCurrentObservation({ ...target, asOfSeq: 0 }, null).asOfSeq, 0);
  },
  'T-03-37': localResumeCase,
};
