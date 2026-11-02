import { randomUUID } from 'node:crypto';
import { fixtureRun, fixtureLink } from '../fixtures/contracts/identity-execution.js';
import { projectFreshness } from '../../src/core/observation.js';
import { launchDigest } from '../../src/core/run/control.js';
import { ticketHash, type FakeRunSeed } from '../../src/core/run/fake-port.js';
import type { RunLaunchInput } from '../../src/core/types/supervision.js';
import type { LifecycleStatus } from '../../src/core/types/lifecycle.js';
export function seedRun(cwd: string, argv: string[], patch: Partial<RunLaunchInput> = {}) {
  const now = Date.now(),
    id = `run_${randomUUID().replaceAll('-', '')}`;
  const input: RunLaunchInput = {
    runId: id,
    mode: 'headless',
    launch: { argv },
    cwd,
    sourceId: fixtureRun().sourceId,
    profileDigest: 'a'.repeat(64),
    stdin: 'closed',
    orphanPolicy: 'continue',
    ...patch,
  };
  const run = fixtureRun({
    runId: id,
    launchCwd: cwd,
    sourceId: input.sourceId,
    mode: input.mode,
    orphanPolicy: input.orphanPolicy,
    state: 'starting',
    scopeRef: null,
    supervisor: null,
    launchPhase: 'reserved',
    launchDigest: launchDigest(input),
    launchTokenHash: ticketHash('synthetic-ticket'),
    heartbeatAt: null,
    heartbeatSeq: 0,
    heartbeatMonoMs: null,
    createdAt: now,
    startedAt: null,
    targetSessionRef: null,
  });
  const status: LifecycleStatus = {
    link: fixtureLink(),
    currentRun: run,
    terminalNote: null,
    runHandshake: { state: 'pending', reason: null },
    latestReportForRun: null,
    reconciliation: null,
    interaction: { focus: false, input: false, resume: false },
    parentOffline: null,
    resumable: { resumable: false, reason: 'headless', subject: 'local_user' },
    asOfSeq: 0,
    observationStamp: null,
    statusProjection: {
      activity: 'unknown',
      pendingReason: 'none',
      lastTurnOutcome: 'none',
      liveness: 'unknown',
      freshness: projectFreshness([], [], now),
      stateKey: 'unknown',
      stateSince: null,
      stateSinceBasis: 'unknown',
      isRunTerminal: false,
      asOfSeq: 0,
      observationStamp: null,
      asOf: null,
      observedAt: now,
      lastEvidenceAt: null,
    },
  };
  const seed: FakeRunSeed = {
    snapshot: {
      revision: 0,
      run,
      events: [],
      facts: [],
      meta: null,
      receipt: null,
      claimSupervisor: null,
      claimState: 'issued',
      slotHeld: true,
      status,
    },
    ticketHash: ticketHash('synthetic-ticket'),
    authorized: true,
    cancel: null,
  };
  return { input, seed, ticket: 'synthetic-ticket' };
}
