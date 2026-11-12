import { sessionRefKey } from './identity.js';
import { isRunTerminal } from './execution.js';
import type {
  DisplayNodeIdentity,
  ProjectionRun,
  ReaderParserState,
  RunExecutionProjection,
} from './types/observation.js';

export function displayNodeKey(identity: DisplayNodeIdentity): string {
  switch (identity.kind) {
    case 'session':
      return JSON.stringify(['session', sessionRefKey(identity.ref)]);
    case 'delegationIntent':
      return JSON.stringify(['delegationIntent', identity.linkId]);
    case 'job':
      return JSON.stringify([
        'job',
        identity.ref.kind,
        identity.ref.provider,
        identity.ref.account ?? null,
        identity.ref.key,
      ]);
  }
}

export function runExecutionProjection(run: ProjectionRun | null): RunExecutionProjection {
  return {
    isRunTerminal: run ? isRunTerminal(run) : null,
    execution: run?.state === 'failed' ? 'non_execution' : run ? 'managed' : 'unmanaged',
    launchFailure: run?.state === 'failed' ? { stateKey: 'launch_failed', reason: run.reason ?? null } : null,
  };
}

export function initialParserState(): ReaderParserState {
  return {
    pendingBytes: [],
    discardingOversize: false,
    usageMessageIds: [],
    compactBoundary: null,
    openToolWaits: [],
    rateBaseline: null,
    gaps: [],
    skipped: {},
  };
}
