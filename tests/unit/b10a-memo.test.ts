import assert from 'node:assert/strict';
import test from 'node:test';
import { JsonVersion, LinkProjectionMemo } from '../../src/core/link/memo.js';

const ref = { harness: 'codex', sourceId: 'a'.repeat(64), sessionId: 'synthetic', threadId: null };
const coverage = {
  state: 'complete',
  skipped: { bytes: 2 },
  gaps: ['synthetic-gap'],
  loaded: true,
  reason: 'synthetic',
  remainingBytes: 0,
};
function fixture(): any {
  return structuredClone({
    ledger: ['ledger-a', 7, 'version-a'],
    sessions: [
      {
        evidence: {
          ref,
          observation: {
            evidenceStamp: 'evidence-a',
            statusProjection: {
              observationStamp: {
                ref,
                sourceGeneration: 1,
                runId: 'run-a',
                bindingGeneration: 1,
                seqDomain: 'domain-a',
                commitSeq: 2,
                inputLedgerSeq: 3,
              },
            },
            coverage,
          },
        },
        sourceGeneration: 1,
        loaded: true,
        linkEvidenceCurrent: true,
        topology: { sourceGeneration: 1, children: [{ ...ref, sessionId: 'child' }], loaded: true, coverage },
        bytesRead: 0,
        recordsRead: 0,
      },
    ],
    hosts: [
      {
        runId: 'run-a',
        bindingGeneration: 1,
        locator: { pane: 'synthetic-pane' },
        check: {
          state: 'valid',
          checkedAt: 1000,
          occupantMatches: true,
          evidence: ['synthetic-check'],
          foregroundInteractive: true,
        },
        state: { foreground: 'synthetic' },
      },
    ],
    roots: [{ kind: 'session', ref }],
    budget: { maxNodes: 200, maxBytes: 8388608, maxCrossHarnessDepth: 4 },
    selectionMap: { 'intent-a': 'session-a' },
  });
}
// Independent frozen definition of the old serialized key, deliberately not
// imported from the implementation whose field coverage this test verifies.
function oldKey(x: any) {
  return JSON.stringify([
    x.ledger,
    x.sessions.map((s: any) => [
      s.evidence.ref,
      s.sourceGeneration,
      s.loaded,
      s.linkEvidenceCurrent,
      s.evidence.observation.evidenceStamp,
      s.evidence.observation.statusProjection.observationStamp,
      s.evidence.observation.coverage,
      s.topology ? [s.topology.sourceGeneration, s.topology.children, s.topology.loaded, s.topology.coverage] : null,
    ]),
    x.hosts,
    x.roots,
    x.budget,
    x.selectionMap,
  ]);
}
function key(memo: LinkProjectionMemo, x: any) {
  return memo.key(x.ledger, x.sessions, x.hosts, x.roots, x.budget, x.selectionMap);
}
const leaves = (value: any, path: (string | number)[] = []): (string | number)[][] =>
  value !== null && typeof value === 'object'
    ? Object.keys(value).flatMap((part) => leaves(value[part], [...path, part]))
    : [path];

test('B10A perf every field in the old memo changes the structural version, including in-place mutations', () => {
  const paths = leaves(fixture()).filter((p) => !['bytesRead', 'recordsRead'].includes(String(p.at(-1))));
  assert.ok(paths.length > 50);
  for (const path of paths) {
    const x = fixture(),
      memo = new LinkProjectionMemo();
    const before = key(memo, x),
      old = oldKey(x);
    assert.equal(key(memo, structuredClone(x)), before);
    let parent = x;
    for (const part of path.slice(0, -1)) parent = parent[part];
    const last = path.at(-1)!;
    parent[last] =
      typeof parent[last] === 'number'
        ? parent[last] + 1
        : typeof parent[last] === 'boolean'
          ? !parent[last]
          : `${parent[last]}-changed`;
    assert.notEqual(oldKey(x), old, path.join('.'));
    assert.notEqual(key(memo, x), before, path.join('.'));
    assert.equal(key(memo, structuredClone(x)), key(memo, x), path.join('.'));
  }
});

test('B10A perf memo retains old equality for structure, order, null/undefined and non-key charges', () => {
  for (const mutate of [
    (x: any) => {
      x.ledger = ['ledger_busy'];
    },
    (x: any) => {
      delete x.sessions[0].topology;
    },
    (x: any) => {
      x.sessions[0].topology.children.push({ ...ref, sessionId: 'next-child' });
    },
    (x: any) => {
      x.sessions.push(structuredClone(x.sessions[0]));
    },
    (x: any) => {
      x.sessions[0].evidence.observation.coverage.gaps = [];
    },
    (x: any) => {
      x.selectionMap = { next: 'next', ...x.selectionMap };
    },
    (x: any) => {
      x.roots = [{ kind: 'delegationIntent', linkId: 'synthetic-intent' }];
    },
    (x: any) => {
      x.roots = [{ kind: 'job', ref: { kind: 'job', provider: 'synthetic', account: null, key: 'synthetic-job' } }];
    },
    (x: any) => {
      x.budget.optional = undefined;
    },
    (x: any) => {
      x.sessions[0].bytesRead = 500;
      x.sessions[0].recordsRead = 2;
    },
  ]) {
    const x = fixture(),
      memo = new LinkProjectionMemo();
    const old = oldKey(x),
      before = key(memo, x);
    mutate(x);
    assert.equal(key(memo, x) === before, oldKey(x) === old);
  }
  const version = new JsonVersion();
  assert.equal(version.update([undefined, NaN, -0, { ignored: undefined }]), version.update([null, null, 0, {}]));
  assert.notEqual(version.update({ a: 1, b: 2 }), version.update({ b: 2, a: 1 }));
});

test('same-commit action receipt addition, replacement and removal invalidate the projection memo', () => {
  const x = fixture();
  const memo = new LinkProjectionMemo();
  const initial = key(memo, x);
  const stamp = structuredClone(x.sessions[0].evidence.observation.statusProjection.observationStamp);
  x.sessions[0].committedAction = { stamp, action: { id: 'one', name: 'read', startedAt: 100 } };
  const added = key(memo, x);
  assert.notEqual(added, initial);
  assert.equal(key(memo, structuredClone(x)), added);
  x.sessions[0].committedAction.action.name = 'write';
  const replaced = key(memo, x);
  assert.notEqual(replaced, added);
  delete x.sessions[0].committedAction;
  assert.notEqual(key(memo, x), replaced);
});
