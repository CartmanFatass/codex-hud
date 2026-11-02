import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { mergeStatus, isRunTerminal, type MergeInput, type MergeResult } from '../../src/core/status/merge.js';
import { checkpointBoundary, witnessObservationBoundary } from '../../src/core/checkpoint.js';
import { initialParserState } from '../../src/core/observation.js';
import type { ObservationView } from '../../src/core/types/observation.js';

interface Step {
  input: MergeInput;
  nowMs: number;
  ruleVersion: string;
  expected: Record<string, unknown>;
}
interface Fixture {
  id: string;
  title: string;
  steps: Step[];
  otherNodes?: Step[];
  parentChild?: { parentRef: unknown; childRef: unknown };
}
const fixtureDir = resolve('tests/fixtures/status-merge');
const fixtures = readdirSync(fixtureDir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => ({
    name,
    fixture: JSON.parse(readFileSync(resolve(fixtureDir, name), 'utf8')) as Fixture,
  }));
const fixture = (id: string) => structuredClone(fixtures.find((f) => f.fixture.id === id)!.fixture);

/** Expected values are hand-authored projections, not regenerated from the merger. */
function matches(actual: unknown, expected: unknown, path = 'result'): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), path);
    assert.equal(actual.length, expected.length, `${path}.length`);
    expected.forEach((item, index) => matches(actual[index], item, `${path}[${index}]`));
  } else if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', path);
    for (const [key, value] of Object.entries(expected))
      matches((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
  } else assert.deepEqual(actual, expected, path);
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(frozen);
  }
  return value;
}
function runStep(step: Step, previous: MergeResult | null = null): MergeResult {
  const input = structuredClone(step.input);
  if (previous) input.noticeState = previous.noticeState;
  return mergeStatus(frozen(input), previous ? frozen(previous.continuity) : null, step.ruleVersion, step.nowMs);
}

for (const { name, fixture: row } of fixtures) {
  test(`${row.id}: ${row.title} (${name})`, () => {
    let previous: MergeResult | null = null;
    for (const [index, step] of row.steps.entries()) {
      const result = runStep(step, previous);
      matches(result, step.expected, `${row.id}.step${index + 1}`);
      assert.deepEqual(result.notices, step.expected.notices, `${row.id}: complete notice edges`);
      const expectedProjection = step.expected.projection as Record<string, unknown>;
      const expectedFreshness = expectedProjection.freshness as Record<string, unknown>;
      for (const field of ['asOfSeq', 'observationStamp', 'asOf', 'observedAt', 'lastEvidenceAt'] as const) {
        assert.ok(Object.hasOwn(expectedProjection, field), `${row.id} must assert ${field}`);
        assert.deepEqual(result.projection[field], expectedProjection[field], `${row.id}.${field}`);
      }
      assert.ok(Object.hasOwn(expectedFreshness, 'requiredSourceIds'), `${row.id} must assert the source set`);
      assert.deepEqual(result.projection.freshness.requiredSourceIds, expectedFreshness.requiredSourceIds);
      assert.equal(result.projection.stateSince, result.continuity.stateSince);
      assert.equal(result.projection.stateKey, result.continuity.stateKey);
      assert.deepEqual(result, runStep(step, previous), 'same inputs give identical output');
      for (const notice of result.notices) {
        assert.equal('seq' in notice, false, 'caller assigns notice-domain sequence at commit');
        assert.equal('seqDomain' in notice, false);
      }
      previous = result;
    }
    for (const child of row.otherNodes ?? []) matches(runStep(child), child.expected);
    if (row.parentChild) {
      assert.notDeepEqual(row.parentChild.parentRef, row.parentChild.childRef, 'parent/child have distinct full refs');
      assert.deepEqual(row.steps[0].input.target.nodeIdentity, { kind: 'session', ref: row.parentChild.parentRef });
      assert.deepEqual(row.otherNodes![0].input.target.nodeIdentity, {
        kind: 'session',
        ref: row.parentChild.childRef,
      });
      assert.equal(runStep(row.steps[0]).projection.activity, 'idle');
      assert.equal(runStep(row.otherNodes![0]).projection.activity, 'working');
    }
  });
}

test('every truth-table row has exactly one fixture and every fixture has a table row', () => {
  const appendix = readFileSync(resolve('docs/contracts/06-observation.md'), 'utf8').split(
    '## 附录：B16 唯一真值表的填入位置'
  )[1];
  const ids = [...appendix.matchAll(/^\| (C\d+) \|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(ids, fixtures.map((f) => f.fixture.id).sort());
  assert.equal(new Set(ids).size, ids.length);
});

test('all fixture ledger events fit their snapshot high-water, including empty-ledger zero', () => {
  let empty = false;
  for (const { fixture: row } of fixtures)
    for (const step of [...row.steps, ...(row.otherNodes ?? [])]) {
      const input = step.input;
      const seqs = [
        ...(input.ledgerFacts ?? []).map((f) => f.seq),
        ...input.sources
          .filter((s) => s.evidence.origin === 'ledger' || s.evidence.origin === 'report')
          .map((s) => s.evidence.seq),
      ].filter((seq): seq is number => seq !== undefined);
      if (seqs.length) {
        assert.notEqual(input.asOfSeq, null, row.id);
        for (const seq of seqs) assert.ok(seq <= input.asOfSeq!, `${row.id}: ledger seq ${seq} beyond snapshot`);
      }
      if (input.asOfSeq === 0) {
        assert.deepEqual(seqs, []);
        assert.deepEqual(input.ledgerFacts ?? [], []);
        empty = true;
      }
    }
  assert.equal(empty, true);
});

test('repeated reads preserve stateSince, evidence age and notice deduplication across restart', () => {
  for (const { fixture: row } of fixtures) {
    let result: MergeResult | null = null;
    for (const step of row.steps) result = runStep(step, result);
    const step = row.steps.at(-1)!;
    const input = structuredClone(step.input);
    input.noticeState = structuredClone(result!.noticeState);
    const again = mergeStatus(input, structuredClone(result!.continuity), step.ruleVersion, step.nowMs);
    assert.deepEqual(again.notices, [], row.id);
    assert.equal(again.projection.stateSince, result!.projection.stateSince, row.id);
    assert.equal(again.projection.lastEvidenceAt, result!.projection.lastEvidenceAt, row.id);
  }
});

test('freshness follows exact heartbeat boundary at many distinct event times', () => {
  for (let n = 0; n < 100; n++) {
    const step = fixture('C05').steps[0];
    const at = 10000 + n * 731;
    step.input.sources.find((s) => s.id === 'heartbeat')!.evidence.value.heartbeatAt = at;
    step.input.sources.find((s) => s.id === 'heartbeat')!.evidence.eventAt = at;
    step.input.sources.find((s) => s.id === 'heartbeat')!.evidence.observedAt = at;
    step.input.sources.find((s) => s.id === 'heartbeat')!.evidence.lastSuccessfulReadAt = at;
    step.input.sources[0].deadlineAt = 1000000;
    step.input.sources.find((s) => s.id === 'heartbeat')!.deadlineAt = 1000000;
    step.input.ledgerFacts![0].deadlineAt = 1000000;
    const fresh = mergeStatus(step.input, null, 'v1', at + 30000);
    const stale = mergeStatus(step.input, fresh.continuity, 'v1', at + 30001);
    assert.equal(fresh.projection.freshness.state, 'fresh');
    assert.equal(stale.projection.freshness.state, 'stale');
    assert.equal(stale.projection.stateSince, at + 30000);
    assert.equal(stale.projection.lastEvidenceAt, at);
    assert.equal(stale.projection.isRunTerminal, false);
  }
});

test('source permutation and independent sequence domains do not change the merge', () => {
  for (const { fixture: row } of fixtures) {
    const step = row.steps[0];
    const input = structuredClone(step.input);
    input.sources = [...input.sources].reverse();
    input.ledgerFacts = [...(input.ledgerFacts ?? [])].reverse();
    assert.deepEqual(mergeStatus(input, null, step.ruleVersion, step.nowMs), runStep(step), row.id);
  }
  const step = fixture('C26').steps[0];
  const first = runStep(step);
  for (const seq of [10, 11, 100, 1000000]) {
    const input = structuredClone(step.input);
    input.asOfSeq = seq;
    input.observationStamp!.commitSeq = 1000001 - seq;
    input.observationStamp!.inputLedgerSeq = 7;
    input.noticeState = { ...first.noticeState, inputStamps: ['notice:domain:sequence:9999999'] };
    const result = mergeStatus(input, first.continuity, step.ruleVersion, step.nowMs);
    assert.equal(result.projection.asOfSeq, seq);
    assert.equal(result.projection.observationStamp!.inputLedgerSeq, 7);
    assert.equal(result.projection.stateSince, first.projection.stateSince);
    assert.deepEqual(result.notices, []);
  }
});

test('ledger high-water validation stays within the ledger sequence domain', () => {
  const step = fixture('C26').steps[0];
  for (const highWater of [null, 0, 1, 9]) {
    const input = structuredClone(step.input);
    input.asOfSeq = highWater;
    assert.throws(() => mergeStatus(input, null, step.ruleVersion, step.nowMs), /invalid_ledger_snapshot/);
  }
  const empty = fixture('C27').steps[0];
  assert.equal(runStep(empty).projection.asOfSeq, 0);
});

test('new run, proven episode and semantic class reset while rereads do not', () => {
  for (const id of ['C18', 'C34', 'C35', 'C39']) {
    const row = fixture(id);
    let previous = runStep(row.steps[0]);
    for (const step of row.steps.slice(1)) {
      const result = runStep(step, previous);
      assert.notEqual(result.projection.stateSince, previous.projection.stateSince, id);
      previous = result;
    }
  }
});

test('missing sources, wrong identity and unusable source clocks cannot become fresh', () => {
  for (const kind of ['missing', 'ref', 'binding', 'generation', 'deadline', 'clock', 'toolDeadline']) {
    const step = fixture('C14').steps[0];
    const source = step.input.sources[0];
    switch (kind) {
      case 'missing':
        step.input.requiredSourceIds = ['absent'];
        break;
      case 'ref':
        if (source.evidence.origin !== 'ledger') source.evidence.ref.sessionId = 'other';
        break;
      case 'binding':
        if (source.evidence.origin !== 'ledger') source.evidence.bindingGeneration = 7;
        break;
      case 'generation':
        if (source.evidence.origin !== 'ledger') source.evidence.sourceGeneration = 2;
        break;
      case 'deadline':
        source.deadlineAt = null;
        break;
      case 'clock':
        source.clockAnomaly = true;
        break;
      case 'toolDeadline':
        source.evidence.value.openTool = { id: 'tool', startedAt: 1, lastActivityAt: 1, deadlineAt: null };
        break;
    }
    assert.equal(runStep(step).projection.freshness.state, 'unknown', kind);
  }
});

test('run terminal predicate follows execution states and ignores report status', () => {
  for (const state of ['starting', 'running', 'uncertain', 'cancelling', 'ended', 'failed', 'cancelled'] as const)
    assert.equal(isRunTerminal({ state }), ['ended', 'failed', 'cancelled'].includes(state));
  assert.equal(runStep(fixture('C10').steps[1]).projection.isRunTerminal, false);
  assert.equal(runStep(fixture('C11').steps[0]).projection.isRunTerminal, false);
});

test('shared G05 boundary can be captured before merging and witnessed after assembling summary', () => {
  const step = fixture('C14').steps[0];
  const ref = step.input.observationStamp!.ref;
  const checkpoint = {
    schemaVersion: 1 as const,
    readerVersion: 'synthetic-v1',
    ref,
    sourceGeneration: 1,
    fileId: { dev: 1, inode: 2 },
    offset: 17,
    parserState: initialParserState(),
  };
  const boundary = checkpointBoundary(checkpoint);
  step.input.boundary = boundary;
  const result = runStep(step);
  assert.deepEqual(result.boundary, boundary);
  const summary = {
    nodeIdentity: step.input.target.nodeIdentity,
    statusProjection: result.projection,
  } as ObservationView;
  const witness = witnessObservationBoundary(checkpoint, summary, result.boundary!);
  assert.deepEqual(witness.checkpointBoundary, witness.summaryBoundary);
  assert.equal(witness.checkpointBoundary.offset, 17);
  assert.notEqual(witness.checkpointDigest, witness.summaryDigest);
  const bad = structuredClone(step.input);
  bad.boundary!.sourceGeneration++;
  assert.throws(() => mergeStatus(bad, null, 'v1', step.nowMs), /boundary_mismatch/);
});

test('evidence age changes independently of the semantic interval', () => {
  const step = fixture('C05').steps[0];
  const first = runStep(step);
  const input = structuredClone(step.input);
  input.sources.find((s) => s.id === 'heartbeat')!.evidence.value.heartbeatAt = 20000;
  const next = mergeStatus(input, first.continuity, step.ruleVersion, 40001);
  assert.equal(next.projection.stateSince, first.projection.stateSince);
  assert.equal(next.projection.lastEvidenceAt, 20000);
});

test('semantic priority preserves dimension notice edges even when conflict wins', () => {
  const baseline = fixture('C14').steps[0];
  const first = runStep(baseline);
  const input = structuredClone(baseline.input);
  input.conflict = { count: 2, recordIds: ['one', 'two'], since: 3000 };
  input.sources[0].evidence.value.pendingReason = 'approval';
  input.sources[0].evidence.value.episodes!.pendingReason = 'approval:conflicted';
  input.sources[0].evidence.eventAt = 3000;
  input.noticeState = first.noticeState;
  const result = mergeStatus(input, first.continuity, baseline.ruleVersion, 4000);
  assert.equal(result.semanticClass, 'conflict');
  assert.deepEqual(
    result.notices.map((n) => n.kind),
    ['pending']
  );
});

test('notice event-time fallback distinguishes recurring uncertainty without ledger seq', () => {
  let previous: MergeResult | null = null;
  const edges: string[] = [];
  for (const step of fixture('C47').steps) {
    const fact = step.input.ledgerFacts![0];
    delete fact.seq;
    fact.evidenceId = 'same-observation-slot';
    previous = runStep(step, previous);
    for (const notice of previous.notices) {
      assert.equal(notice.sourceEventSeq, undefined);
      edges.push(notice.inputStamp);
    }
  }
  assert.equal(edges.length, 2);
  assert.notEqual(edges[0], edges[1]);
});

test('heartbeat missing source deadline and source clock anomaly remain unknown', () => {
  for (const cause of ['deadline', 'clock']) {
    const step = fixture('C05').steps[0];
    const heartbeat = step.input.sources.find((s) => s.id === 'heartbeat')!;
    if (cause === 'deadline') heartbeat.deadlineAt = null;
    else heartbeat.clockAnomaly = true;
    const result = runStep(step);
    assert.equal(result.projection.freshness.state, 'unknown');
    assert.equal(result.projection.lastEvidenceAt, 10000);
  }
});

test('anchor-free replacement preserves time only with proven unchanged lineage', () => {
  const row = fixture('C51');
  const previous = runStep(row.steps[0]);
  for (const change of ['none', 'gap', 'rule', 'generation']) {
    const step = structuredClone(row.steps[1]);
    if (change === 'gap') step.input.history.gap = true;
    if (change === 'rule') step.ruleVersion = 'b16-v2';
    if (change === 'generation') {
      step.input.target.sourceGeneration = 2;
      step.input.observationStamp!.sourceGeneration = 2;
      for (const source of step.input.sources)
        if (source.evidence.origin !== 'ledger') source.evidence.sourceGeneration = 2;
    }
    const result = runStep(step, previous);
    assert.equal(result.projection.stateSince, change === 'none' ? 1000 : 3500, change);
    assert.equal(result.projection.stateSinceBasis, change === 'none' ? 'event' : 'observed', change);
  }
});

test('adding a known anchor to the same proved interval preserves its observed start', () => {
  const step = fixture('C51').steps[1];
  const previous = runStep(step);
  assert.equal(previous.continuity.episodeAnchor, null);
  const registry = step.input.sources.find((s) => s.id === 'registry')!;
  registry.evidence.value.episodes = { activity: 'same-turn' };
  registry.evidence.observedAt = registry.evidence.lastSuccessfulReadAt = 3900;
  const next = runStep(step, previous);
  assert.equal(next.continuity.episodeAnchor, 'same-turn');
  assert.equal(next.projection.stateSince, previous.projection.stateSince);
  assert.equal(next.projection.stateSinceBasis, previous.projection.stateSinceBasis);
});

test('10,000 representative pure merges microbenchmark', (t) => {
  const steps = fixtures.map((f) => f.fixture.steps.at(-1)!);
  for (let i = 0; i < 500; i++) {
    const step = steps[i % steps.length];
    mergeStatus(step.input, null, step.ruleVersion, step.nowMs);
  }
  const samples: number[] = [];
  for (let i = 0; i < 10000; i++) {
    const step = steps[i % steps.length];
    const start = performance.now();
    mergeStatus(step.input, null, step.ruleVersion, step.nowMs);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  t.diagnostic(
    JSON.stringify({
      merges: samples.length,
      unit: 'ms/merge',
      p50: samples[5000],
      p95: samples[9500],
      max: samples.at(-1),
    })
  );
});
