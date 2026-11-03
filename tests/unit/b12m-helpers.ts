// Shared synthetic setup for the B12M observation-store tests. Synthetic data only.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openObservationStore } from '../../src/core/observation-store.js';
import { checkpointBoundary, checkpointFormat, witnessPreparedObservationBoundary } from '../../src/core/checkpoint.js';
import { initialParserState, projectFreshness } from '../../src/core/observation.js';
import type { SessionRef } from '../../src/core/types/identity.js';
import type { ObservationCommit } from '../../src/core/types/observation.js';
import type { PreparedCheckpoint } from '../../src/core/types/checkpoint.js';

const [major, minor] = process.versions.node.split('.').map(Number);
export const supported = (major === 22 && minor >= 13) || major >= 24;
export const skip = supported ? false : 'observation SQLite requires Node 22.x >=22.13 or >=24';
export const NOW = 1_700_000_000_000;
export const REF: SessionRef = {
  harness: 'codex',
  sourceId: 'b'.repeat(64),
  sessionId: 'synthetic-b12m-session',
  threadId: null,
};
export const BUDGET = { maxBytes: 256 * 1024, maxRecords: 2000, budgetMs: 20 };

export function commit(seq = 1, generation = 1): ObservationCommit {
  const stamp = {
    ref: REF,
    sourceGeneration: 1,
    seqDomain: 'synthetic-observation',
    commitSeq: seq,
    inputLedgerSeq: null,
  };
  return {
    ref: REF,
    sourceGeneration: 1,
    leaseGeneration: generation,
    seqDomain: stamp.seqDomain,
    commitSeq: seq,
    observationStamp: stamp,
    checkpoint: {
      schemaVersion: 1,
      readerVersion: 'synthetic-reader-1',
      ref: REF,
      fileId: { dev: 1, inode: 2 },
      offset: seq * 10,
      sourceGeneration: 1,
      parserState: initialParserState(),
    },
    summary: {
      nodeIdentity: { kind: 'session', ref: REF },
      statusProjection: {
        activity: 'working',
        pendingReason: 'none',
        lastTurnOutcome: 'none',
        liveness: 'alive',
        freshness: projectFreshness([], [], NOW),
        stateKey: 'working',
        stateSince: NOW,
        stateSinceBasis: 'event',
        isRunTerminal: null,
        asOfSeq: null,
        observationStamp: stamp,
        asOf: NOW,
        observedAt: NOW,
        lastEvidenceAt: NOW,
      },
      conflict: null,
      spent: {
        tokens: { value: { input: seq, output: 0 }, quality: 'reported', source: 'synthetic', asOf: NOW },
        costUsd: { value: null, quality: 'unknown', source: 'synthetic', asOf: NOW },
      },
      workspace: null,
      coverage: { state: 'complete', skipped: {}, gaps: [], loaded: true },
      loaded: true,
      depth: 0,
      evidenceStamp: `synthetic-${seq}`,
    },
    continuity: {
      nodeIdentity: { kind: 'session', ref: REF },
      ruleVersion: 'synthetic-rule-1',
      sourceGeneration: 1,
      episodeAnchor: 'synthetic-turn',
      stateKey: 'working',
      stateSince: NOW,
      stateSinceBasis: 'event',
    },
    notices: [
      { seq, seqDomain: stamp.seqDomain, created_at: NOW, ref: REF, kind: 'pending', inputStamp: `synthetic-${seq}` },
    ],
  };
}

export function preparedCandidate(c: ObservationCommit, checkpoint: PreparedCheckpoint) {
  const { checkpoint: _checkpoint, ...projection } = c;
  return {
    commit: projection,
    checkpoint,
    previousCommitSeq: c.commitSeq - 1,
    boundary: witnessPreparedObservationBoundary(checkpoint, c.summary, checkpointBoundary(c.checkpoint)),
  };
}

export async function setup(t: import('node:test').TestContext, prefix = 'b12m-store-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let now = NOW;
  const store = await openObservationStore({ hudHome: root, sourceId: REF.sourceId, now: () => now });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const lease = store.acquire(REF, 'synthetic-reader');
  const prepare = (c: ObservationCommit) =>
    store.prepareCheckpoint({
      checkpoint: c.checkpoint,
      boundary: checkpointBoundary(c.checkpoint),
      format: checkpointFormat(c.checkpoint),
      recoveryReferences: c.checkpoint.recoveryIndex?.delta.base ? [c.checkpoint.recoveryIndex.delta.base] : [],
    });
  const publish = (c: ObservationCommit) => store.publishPrepared(preparedCandidate(c, prepare(c)), lease);
  return {
    root,
    store,
    lease,
    prepare,
    publish,
    advance: (value: number) => {
      now = value;
    },
  };
}
