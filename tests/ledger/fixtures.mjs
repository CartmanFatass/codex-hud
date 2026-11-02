// Synthetic process-test data. Imports deliberately use build:test output so test:core
// and the full suite exercise the same freshly compiled ledger implementation.
import { createHash } from 'node:crypto';
import { taskDigest } from '../../dist-test/src/core/lifecycle.js';
import { insertRecord } from '../../dist-test/src/ledger/records.js';

export const sourceId = 'a'.repeat(64);
export const at = 1000;
export const processKey = JSON.stringify(['codex', sourceId, 'synthetic-domain', 41001, 'synthetic-start']);
const hash = (value) => createHash('sha256').update(value).digest('hex');

export async function seedCaller(ledger) {
  await ledger.transaction((tx) => {
    insertRecord(tx, 'sources', {
      sourceId,
      harness: 'codex',
      rootPath: '/synthetic/source',
      label: 'Process acceptance',
    });
    insertRecord(tx, 'caller_scopes', {
      processKey,
      generation: 1,
      harness: 'codex',
      sourceId,
      pidDomain: 'synthetic-domain',
      harnessPid: 41001,
      harnessProcStart: 'synthetic-start',
      sessionRef: null,
      boundBy: null,
      bindingEvidenceId: null,
      createdAt: at,
      closedAt: null,
    });
    insertRecord(tx, 'callers', {
      callerId: 'parent',
      instanceKind: 'dedicated',
      harness: 'codex',
      sourceId,
      pid: 41002,
      procStart: 'synthetic-caller',
      ppid: 41001,
      parentProcStart: 'synthetic-start',
      cwd: '/synthetic/work',
      envPane: null,
      startedAt: at,
      lastSeenAt: at,
      retiredAt: null,
    });
    insertRecord(tx, 'caller_contexts', {
      contextId: 'parent-context',
      generation: 1,
      callerId: 'parent',
      contextKey: 'stdio',
      kind: 'dedicated',
      sourceId,
      harness: 'codex',
      processKey,
      procGeneration: 1,
      sessionRef: null,
      selectionEvidenceId: null,
      boundBy: null,
      bindingEvidenceId: null,
      createdAt: at,
      closedAt: null,
    });
  });
}

export function intent(id = 'one', changed = false) {
  const linkId = `link-${id}`;
  const runId = `run-${id}`;
  const briefPath = changed ? '/synthetic/changed.md' : '/synthetic/brief.md';
  const briefContentHash = hash('synthetic brief');
  return {
    requestKey: 'same-key',
    params: {
      sourceId,
      mode: 'headless',
      backend: 'codex',
      role: 'implementer',
      briefPath,
      briefContentHash,
      launchCwd: '/synthetic/work',
    },
    link: {
      linkId,
      state: 'pending',
      parentCaller: 'parent',
      parentContextId: 'parent-context',
      parentContextGeneration: 1,
      parentRef: null,
      childRef: null,
      currentOwner: false,
      backend: 'codex',
      role: 'implementer',
      label: null,
      briefPath,
      taskDigest: taskDigest(briefPath, briefContentHash, 'codex', sourceId, 'implementer'),
      reportPath: null,
      predecessor: null,
      routing: null,
      createdAt: at,
      claimedAt: null,
      boundAt: null,
      closedAt: null,
    },
    run: {
      runId,
      linkId,
      runSeq: 1,
      operation: 'spawn',
      targetSessionRef: null,
      sourceId,
      harness: 'codex',
      expectedGeneration: 1,
      mode: 'headless',
      launchCwd: '/synthetic/work',
      workspaceSnapshot: null,
      projectOrigin: null,
      supervisionStrategy: 'headless',
      scopeKind: 'pgid',
      scopeRef: null,
      state: 'starting',
      locator: null,
      launchTokenHash: hash(`launch-${id}`),
      launchDigest: hash(`digest-${id}`),
      launchPhase: 'reserved',
      launchCallId: `call-${id}`,
      launchCorrelationId: `correlation-${id}`,
      launchMessageId: null,
      supervisor: null,
      heartbeatAt: null,
      heartbeatSeq: 0,
      heartbeatMonoMs: null,
      cancelRequestedAt: null,
      submissionFencedAt: null,
      createdAt: at,
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
      runId,
      claimHash: hash(`claim-${id}`),
      sourceId,
      expectedGeneration: 1,
      supervisor: null,
      state: 'issued',
      issuedAt: at,
      expiresAt: at + 1800000,
      redeemedContextId: null,
      redeemedGeneration: null,
      redeemedSessionRef: null,
      redeemedAt: null,
    },
    authority: {
      kind: 'mcp',
      contextId: 'parent-context',
      generation: 1,
      evidence: {
        physicalCallerVerified: true,
        pidDomainVisible: true,
        profileObservesSessionSwitch: true,
        topology: 'direct_stdio',
        logicalSource: 'root',
        processKey,
        procGeneration: 1,
        sessionRef: { harness: 'codex', sourceId, sessionId: 'synthetic-parent', threadId: null },
      },
    },
    capabilityVerified: true,
    newSession: true,
    holder: 'synthetic-supervisor',
  };
}

export function evidence(id, kind) {
  return {
    evidenceId: id,
    runId: 'run-one',
    linkId: 'link-one',
    kind,
    producer: 'reconciler',
    fingerprint: hash(id),
    payload: {},
    observedAt: at + 10,
    validatedAt: at + 10,
    validation: 'accepted',
  };
}

export function staleCandidate() {
  return [
    {
      record: evidence('stale-never-submitted', 'never_submitted'),
      facts: [
        {
          evidenceId: 'stale-never-submitted',
          runId: 'run-one',
          sourceId,
          bindingGeneration: 1,
          supervisor: null,
          validation: 'accepted',
          asOf: at + 10,
          observedAt: at + 10,
          fact: { kind: 'never_submitted', permanentFence: true, launchersSealed: true, noExecution: true },
        },
        {
          evidenceId: 'stale-never-submitted',
          runId: 'run-one',
          sourceId,
          bindingGeneration: 1,
          supervisor: null,
          validation: 'accepted',
          asOf: at + 10,
          observedAt: at + 10,
          fact: { kind: 'scope', state: 'gone', complete: true, harnessTerminated: true, launchersSealed: true },
        },
      ],
    },
  ];
}
