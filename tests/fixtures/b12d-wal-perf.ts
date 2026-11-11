import assert from 'node:assert/strict';
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
const supported = (major === 22 && minor >= 13) || major >= 24;
const skip = supported ? false : 'observation SQLite requires Node 22.x >=22.13 or >=24';
const NOW = 1_700_000_000_000;
const REF: SessionRef = { harness: 'codex', sourceId: 'e'.repeat(64), sessionId: 'synthetic-session', threadId: null };

function commit(seq = 1, generation = 1): ObservationCommit {
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
function preparedCandidate(c: ObservationCommit, checkpoint: PreparedCheckpoint) {
  const { checkpoint: _checkpoint, ...projection } = c;
  return {
    commit: projection,
    checkpoint,
    previousCommitSeq: c.commitSeq - 1,
    boundary: witnessPreparedObservationBoundary(checkpoint, c.summary, checkpointBoundary(c.checkpoint)),
  };
}

async function fixture(t: import('node:test').TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b12d-wal-'));
  assert.notEqual(fs.statfsSync(root).type, 0x01021994, 'native disk required');
  const stores: Awaited<ReturnType<typeof openObservationStore>>[] = [];
  let now = NOW;
  const open = async (readOnly = false) => {
    const store = await openObservationStore({ hudHome: root, sourceId: REF.sourceId, readOnly, now: () => now });
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, open, advance: (value: number) => (now = value) };
}
function prepare(store: Awaited<ReturnType<typeof openObservationStore>>, c: ObservationCommit) {
  return store.prepareCheckpoint({
    checkpoint: c.checkpoint,
    boundary: checkpointBoundary(c.checkpoint),
    format: checkpointFormat(c.checkpoint),
    recoveryReferences: [],
  });
}
export { supported, skip, NOW, REF, commit, preparedCandidate, fixture, prepare };
