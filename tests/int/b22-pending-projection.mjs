// Synthetic B16/SQLite regression for a fresh approval with an older blocked semantic interval.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const local = (path) => import(pathToFileURL(resolve(path)).href);
const { openObservationStore } = await local('dist-test/src/core/observation-store.js');
const { StatusWriter } = await local('dist-test/src/core/status/writer.js');
const { RetirementEvidenceReader } = await local('dist-test/src/core/run/retirement-evidence.js');
const { initialParserState } = await local('dist-test/src/core/observation.js');
const home = mkdtempSync(join(tmpdir(), 'b22-review-pending-'));
const step = JSON.parse(readFileSync('tests/fixtures/status-merge/C18.json', 'utf8')).steps[1];
const input = step.input;
const target = input.target;
const ref = target.nodeIdentity.ref;
const now = Date.now();
const native = input.sources[0];
Object.assign(native.evidence, { eventAt: now - 50, observedAt: now, lastSuccessfulReadAt: now });
native.deadlineAt = now + 60000;
Object.assign(input.ledgerFacts[0], { eventAt: now - 1000, observedAt: now, deadlineAt: now + 60000 });
input.ledgerFacts.push({
  id: 'ledger:old-blocked',
  value: { report: { reportId: 'old-blocked', runId: target.runId, status: 'blocked', createdAt: now - 3600000 } },
  seq: 9,
  eventAt: now - 3600000,
  observedAt: now,
  deadlineAt: now + 60000,
});
const resolver = {
  id: 'registry:resolved-report',
  evidence: {
    ...native.evidence,
    origin: 'registry',
    eventAt: now - 100,
    observedAt: now,
    lastSuccessfulReadAt: now,
    value: { pendingReason: 'none', pendingResolution: { episodeAnchor: 'report:old-blocked', eventAt: now - 100 } },
  },
  deadlineAt: now + 60000,
};
const store = await openObservationStore({ hudHome: home, sourceId: ref.sourceId });
const reader = new RetirementEvidenceReader(home);
try {
  const lease = store.acquire(ref, 'b22-review');
  const writer = new StatusWriter(store, ref, lease);
  const reading = {
    checkpoint: {
      schemaVersion: 1,
      readerVersion: 'synthetic-b16-v1',
      ref,
      sourceGeneration: 1,
      fileId: { dev: 1, inode: 2 },
      offset: 10,
      parserState: initialParserState(),
    },
    observation: {
      nodeIdentity: target.nodeIdentity,
      statusProjection: {},
      conflict: null,
      workspace: null,
      spent: {
        tokens: { value: null, quality: 'unknown', source: 'synthetic', asOf: now },
        costUsd: { value: null, quality: 'unknown', source: 'synthetic', asOf: now },
      },
      coverage: { state: 'complete', gaps: [], skipped: {}, loaded: true },
      loaded: true,
      depth: 0,
      evidenceStamp: 'synthetic',
    },
  };
  const publication = writer.publish(
    writer.prepare(reading, [native], target),
    { ...input, sources: [resolver] },
    step.ruleVersion,
    now
  );
  const projection = publication.committed.summary.statusProjection;
  const evidence = await reader.read({
    run: { runId: target.runId, expectedGeneration: 1, targetSessionRef: ref },
    status: { link: { childRef: ref }, asOfSeq: 11 },
  });
  assert.equal(projection.pendingReason, 'approval');
  assert.equal(projection.stateKey, 'pending:blocked');
  assert.equal(evidence.pendingInput, 'approval');
  assert.equal(evidence.pendingSince, null);
  assert.equal(evidence.quiescent, false);
  console.log(
    JSON.stringify({
      projection: {
        pending: projection.pendingReason,
        key: projection.stateKey,
        sinceAgeMs: now - projection.stateSince,
      },
      currentApprovalAgeMs: 50,
      evidence,
      expectedPendingSince: null,
    })
  );
} finally {
  reader.close();
  store.close();
  rmSync(home, { recursive: true, force: true });
}
