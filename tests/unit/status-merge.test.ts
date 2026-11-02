import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import {
  mergeStatus,
  isRunTerminal,
  type MergeInput,
  type MergeResult,
  STATUS_RULE_VERSION,
} from '../../src/core/status/merge.js';
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
  for (const kind of ['missing', 'ref', 'binding', 'generation', 'deadline', 'clock']) {
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

test('H09 registry activity responsibility preserves transcript pending/outcome and explicit conflicts', () => {
  for (const pending of ['none', 'approval', 'question'] as const) {
    for (const outcome of ['none', 'failed', 'interrupted'] as const) {
      const step = fixture('C01').steps[0];
      const transcript = step.input.sources.find((s) => s.id === 'transcript')!;
      transcript.evidence.value.pendingReason = pending;
      transcript.evidence.value.lastTurnOutcome = outcome;
      const result = runStep(step);
      assert.equal(result.projection.activity, 'working');
      assert.equal(result.selectedSources.activity, 'registry');
      assert.equal(result.projection.pendingReason, pending);
      assert.equal(result.projection.lastTurnOutcome, outcome);
      assert.equal(result.conflict, null);
      assert.equal(
        result.semanticClass,
        pending !== 'none'
          ? 'pending'
          : outcome === 'failed'
            ? 'failed'
            : outcome === 'interrupted'
              ? 'interrupted'
              : 'working'
      );
      step.input.conflict = { count: 1, recordIds: ['explicit-contradiction'], since: 1500 };
      assert.equal(runStep(step).semanticClass, 'conflict');
      delete step.input.conflict;
      transcript.evidence.validity = 'conflict';
      assert.equal(runStep(step).semanticClass, 'conflict');
      // Contradictions from a different session are not evidence about this subject.
      if (transcript.evidence.origin !== 'ledger') transcript.evidence.ref.sessionId = 'foreign';
      assert.equal(runStep(step).conflict, null);
    }
  }
});

test('H10 tool expiry preserves independent pending, outcome, liveness and source deadline', () => {
  for (const pending of ['none', 'approval', 'question'] as const) {
    for (const outcome of ['none', 'completed', 'failed', 'interrupted'] as const) {
      const step = fixture('C04').steps[0];
      const source = step.input.sources[0];
      source.evidence.value.pendingReason = pending;
      source.evidence.value.lastTurnOutcome = outcome;
      const result = runStep(step);
      assert.equal(result.projection.activity, 'unknown');
      assert.equal(result.projection.pendingReason, pending);
      assert.equal(result.projection.lastTurnOutcome, outcome);
      assert.equal(result.projection.liveness, 'alive');
      assert.equal(result.projection.freshness.state, 'fresh');
      assert.equal(result.projection.freshness.sources[0].deadlineAt, 90000);
      assert.deepEqual(result.projection.freshness.requiredSourceIds, ['transcript']);
      assert.equal(result.projection.isRunTerminal, null);
      assert.deepEqual(result.notices, []);
    }
  }
  const step = fixture('C04').steps[0];
  const source = step.input.sources[0];
  const atDeadline = mergeStatus(step.input, null, step.ruleVersion, 2000);
  assert.equal(atDeadline.projection.activity, 'working');
  const expired = runStep(step, atDeadline);
  assert.equal(expired.projection.stateSince, 2000);
  assert.equal(expired.projection.stateSinceBasis, 'event');
  assert.deepEqual(runStep(step, expired).projection, expired.projection);
  source.deadlineAt = 2500;
  const stale = runStep(step);
  assert.equal(stale.projection.freshness.state, 'stale');
  assert.equal(stale.projection.stateSince, 2500);
  source.deadlineAt = 90000;
  delete source.evidence.value.liveness;
  const noLive = runStep(step);
  assert.equal(noLive.projection.liveness, 'unknown');
  assert.equal(noLive.projection.freshness.state, 'unknown');
  assert.ok(noLive.projection.freshness.requiredSourceIds.includes('missing:liveness'));
  const registry = fixture('C01').steps[0].input.sources.find((s) => s.id === 'registry')!;
  step.input.sources = [source, registry];
  source.evidence.value.liveness = 'alive';
  const fallback = runStep(step);
  assert.equal(fallback.projection.activity, 'working');
  assert.equal(fallback.projection.stateSince, 1000);
  assert.equal(fallback.selectedSources.activity, 'registry');
  assert.equal(fallback.conflict, null);
});

test('H13 resolution requires full source identity and a trusted outer time boundary', () => {
  const row = fixture('C54');
  const previous = runStep(row.steps[1]);
  const mutations: Record<string, (s: MergeInput['sources'][number]) => void> = {
    wrongAnchor: (s) => {
      s.evidence.value.pendingResolution!.episodeAnchor = 'different';
    },
    anonymous: (s) => {
      s.evidence.value.pendingResolution!.episodeAnchor = '';
    },
    beforeOpening: (s) => {
      s.evidence.value.pendingResolution!.eventAt = 2999;
    },
    afterNow: (s) => {
      s.evidence.value.pendingResolution!.eventAt = 4001;
    },
    afterEvent: (s) => {
      s.evidence.eventAt = 3800;
    },
    afterObservation: (s) => {
      s.evidence.observedAt = 3800;
    },
    afterRead: (s) => {
      s.evidence.lastSuccessfulReadAt = 3800;
    },
    missingEvent: (s) => {
      s.evidence.eventAt = null;
    },
    negativeObservation: (s) => {
      s.evidence.observedAt = -1;
    },
    invalidOuterEvent: (s) => {
      s.evidence.eventAt = NaN;
    },
    negativeRead: (s) => {
      s.evidence.lastSuccessfulReadAt = -1;
    },
    missingRead: (s) => {
      s.evidence.lastSuccessfulReadAt = null;
    },
    invalidTime: (s) => {
      s.evidence.value.pendingResolution!.eventAt = NaN;
    },
    expired: (s) => {
      s.deadlineAt = 3800;
    },
    stale: (s) => {
      s.evidence.validity = 'stale';
    },
    unknown: (s) => {
      s.evidence.validity = 'unknown';
    },
    anomaly: (s) => {
      s.clockAnomaly = true;
    },
    foreignRef: (s) => {
      if (s.evidence.origin !== 'ledger') s.evidence.ref.sessionId = 'foreign';
    },
    foreignRun: (s) => {
      if (s.evidence.origin !== 'ledger') s.evidence.runId = 'foreign';
    },
    foreignBinding: (s) => {
      if (s.evidence.origin !== 'ledger') s.evidence.bindingGeneration = 99;
    },
    foreignGeneration: (s) => {
      if (s.evidence.origin !== 'ledger') s.evidence.sourceGeneration = 99;
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const step = structuredClone(row.steps[2]);
    mutate(step.input.sources.find((s) => s.id === 'resolution')!);
    const result = runStep(step, previous);
    assert.equal(result.projection.pendingReason, 'approval', name);
    assert.equal(result.projection.stateSince, 3000, name);
    assert.deepEqual(result.notices, [], name);
  }
  const anonymous = structuredClone(row.steps[2]);
  anonymous.input.sources.find((s) => s.id === 'registry')!.evidence.value.episodes!.pendingReason = '';
  anonymous.input.sources.find((s) => s.id === 'resolution')!.evidence.value.pendingResolution!.episodeAnchor = '';
  assert.equal(
    runStep(anonymous, previous).projection.pendingReason,
    'approval',
    'empty anchors cannot identify an episode'
  );
  const tied = structuredClone(row.steps[2]);
  const proof = tied.input.sources.find((s) => s.id === 'resolution')!;
  proof.evidence.value.pendingResolution!.eventAt = 3000;
  assert.equal(runStep(tied, previous).projection.pendingReason, 'none', 'explicit same-episode tie is legal');
  delete proof.evidence.value.pendingResolution;
  assert.equal(runStep(tied, previous).projection.pendingReason, 'approval', 'a generic none cannot resolve a tie');
});

test('H09–H13 six policy fixtures assert every required public output', () => {
  for (const id of ['C01', 'C04', 'C21', 'C30', 'C33', 'C46']) {
    for (const step of fixture(id).steps) {
      assert.equal(step.ruleVersion, STATUS_RULE_VERSION);
      const projection = step.expected.projection as Record<string, unknown>;
      for (const field of [
        'activity',
        'pendingReason',
        'lastTurnOutcome',
        'liveness',
        'freshness',
        'stateKey',
        'stateSince',
        'stateSinceBasis',
        'isRunTerminal',
        'observationStamp',
      ])
        assert.ok(Object.hasOwn(projection, field), `${id}.${field}`);
      assert.ok(Object.hasOwn(step.expected, 'notices'), id);
      assert.deepEqual(step.input.noticeState, undefined);
    }
  }
});

test('H12 latest blocked report remains independent of other requests, outcomes and run terminality', () => {
  for (const outcome of ['none', 'completed', 'failed', 'interrupted'] as const) {
    for (const state of ['running', 'cancelling', 'ended'] as const) {
      const step = fixture('C30').steps[0];
      const native = step.input.sources[0];
      native.evidence.value.lastTurnOutcome = outcome;
      native.evidence.value.pendingReason = 'approval';
      native.evidence.value.episodes = { pendingReason: 'approval:independent' };
      const run = step.input.ledgerFacts!.find((s) => s.value.run)!;
      run.value.run!.state = state;
      const resolution = structuredClone(native);
      resolution.id = 'resolution';
      resolution.evidence.eventAt = resolution.evidence.observedAt = resolution.evidence.lastSuccessfulReadAt = 3900;
      resolution.evidence.value = {
        pendingReason: 'none',
        pendingResolution: { episodeAnchor: 'approval:independent', eventAt: 3900 },
      };
      step.input.sources = [native, resolution];
      const result = runStep(step);
      assert.equal(result.projection.pendingReason, 'needs_human');
      assert.equal(result.projection.lastTurnOutcome, outcome);
      assert.equal(result.projection.stateKey, 'pending:blocked');
      assert.equal(result.projection.stateSince, 3200);
      assert.equal(result.projection.isRunTerminal, state === 'ended');
      assert.equal(result.selectedSources.pendingReason, 'ledger:report');
      assert.ok(result.projection.freshness.requiredSourceIds.includes('resolution'));
      assert.deepEqual(result.notices, []);
      const replacement = structuredClone(step.input.ledgerFacts!.find((s) => s.value.report)!);
      replacement.id = 'ledger:new-report';
      replacement.seq = 12;
      replacement.eventAt = replacement.observedAt = 3950;
      replacement.value.report = {
        ...replacement.value.report!,
        reportId: 'replacement',
        status: 'completed',
        createdAt: 3950,
      };
      step.input.asOfSeq = 12;
      step.input.ledgerFacts = [...step.input.ledgerFacts!, replacement];
      const replaced = runStep(step, result);
      assert.equal(replaced.projection.pendingReason, 'none');
      assert.notEqual(replaced.projection.stateKey, 'pending:blocked');
      assert.equal(replaced.projection.isRunTerminal, state === 'ended');
      assert.deepEqual(
        replaced.notices.map((n) => [n.kind, n.sourceEventSeq]),
        [['report', 12]]
      );
    }
  }
});

test('H10 withdrawal starts only the semantic interval actually interrupted by tool activity', () => {
  const step = fixture('C21').steps[0];
  const native = step.input.sources[0];
  native.evidence.value.activity = 'working';
  native.evidence.value.openTool = { id: 'expired', startedAt: 1000, lastActivityAt: 1000, deadlineAt: 3700 };
  const result = runStep(step);
  assert.equal(result.projection.stateKey, 'exited:reported');
  assert.equal(result.projection.stateSince, 3700, 'completed report was hidden by working until expiry');
  assert.equal(result.projection.stateSinceBasis, 'event');
  assert.equal(runStep(step, result).projection.stateSince, 3700);
  // A higher-priority failure or blocked report was never interrupted by working.
  const report = step.input.ledgerFacts!.find((s) => s.value.report)!;
  report.value.report!.status = 'failed';
  assert.equal(runStep(step).projection.stateSince, 3200);
  report.value.report!.status = 'blocked';
  assert.equal(runStep(step).projection.stateSince, 3200);
  report.value.report!.status = 'completed';
  const registry = fixture('C01').steps[0].input.sources.find((s) => s.id === 'registry')!;
  if (registry.evidence.origin !== 'ledger') {
    registry.evidence.runId = step.input.target.runId;
    registry.evidence.bindingGeneration = step.input.target.bindingGeneration;
  }
  registry.evidence.value.registry!.activity = 'idle';
  step.input.sources = [native, registry];
  const registryWins = runStep(step);
  assert.equal(registryWins.projection.stateKey, 'exited:reported');
  assert.equal(registryWins.projection.stateSince, 3200, 'registry idle already displaced the lower-ranked tool');
});

test('H10 overlapping tools use the last effective withdrawal and compatible episode selection', () => {
  function toolSource(
    id: string,
    origin: 'registry' | 'transcript' | 'job',
    deadlineAt: number,
    episode: string | null = null
  ) {
    const source = fixture('C04').steps[0].input.sources[0];
    source.id = id;
    if (source.evidence.origin !== 'ledger') source.evidence.origin = origin;
    source.evidence.eventAt = 1000;
    source.evidence.observedAt = source.evidence.lastSuccessfulReadAt = 1000;
    source.evidence.value.episodes = episode ? { activity: episode } : {};
    source.evidence.value.openTool!.deadlineAt = deadlineAt;
    return source;
  }
  function idleSource() {
    const source = fixture('C14').steps[0].input.sources[0];
    source.id = 'fallback';
    if (source.evidence.origin !== 'ledger') source.evidence.origin = 'job';
    source.evidence.value.episodes = { activity: 'idle:fallback' };
    return source;
  }
  for (const otherDeadline of [3000, 2000]) {
    const step = fixture('C04').steps[0];
    step.input.sources = [
      toolSource('registry', 'registry', 2000),
      toolSource('transcript', 'transcript', otherDeadline),
      idleSource(),
    ];
    const result = runStep(step);
    assert.equal(result.projection.stateKey, 'idle:idle');
    assert.equal(result.projection.stateSince, otherDeadline);
    assert.equal(result.projection.stateSinceBasis, 'event');
    assert.deepEqual(result.projection.freshness.requiredSourceIds, ['fallback', 'transcript']);
    assert.deepEqual(runStep(step, result).notices, []);
    assert.equal(runStep(step, result).projection.stateSince, otherDeadline);
  }
  const step = fixture('C04').steps[0];
  const idle = idleSource();
  if (idle.evidence.origin !== 'ledger') idle.evidence.origin = 'transcript';
  step.input.sources = [toolSource('registry', 'registry', 2000), idle, toolSource('unused-job', 'job', 3500)];
  assert.equal(runStep(step).projection.stateSince, 2000, 'a never-selected later tool cannot move the interval');
  const active = toolSource('registry', 'registry', 3000, 'working:first');
  const replacement = toolSource('replacement', 'transcript', 90000, 'working:second');
  step.input.sources = [active, replacement];
  const changedEpisode = runStep(step);
  assert.equal(changedEpisode.projection.stateKey, 'working:working');
  assert.equal(changedEpisode.projection.stateSince, 3000);
  assert.equal(changedEpisode.continuity.episodeAnchor, 'working:second');
  replacement.evidence.value.episodes = { activity: 'working:first' };
  const sameEpisode = runStep(step);
  assert.equal(sameEpisode.projection.stateSince, 100, 'a compatible working fallback keeps its entering event');
  delete active.evidence.value.openTool;
  active.evidence.value.activity = 'idle';
  active.evidence.value.episodes = { activity: 'idle:prior' };
  replacement.evidence.value.openTool!.deadlineAt = 3500;
  assert.equal(runStep(step).projection.stateSince, 1000, 'a higher-ranked idle fact already won');
});

test('H10 a same-key return after an unsampled tool interval does not keep the earlier start', () => {
  const row = fixture('C21');
  const base = row.steps[0];
  const first = runStep(base);
  const step = structuredClone(base);
  const native = step.input.sources[0];
  native.evidence.value.activity = 'working';
  native.evidence.value.openTool = { id: 'intervening', startedAt: 3300, lastActivityAt: 3400, deadlineAt: 3700 };
  const resumed = runStep(step, first);
  assert.equal(resumed.projection.stateKey, first.projection.stateKey);
  assert.equal(resumed.projection.stateSince, 3700);
  assert.deepEqual(resumed.notices, []);
  assert.equal(runStep(step, resumed).projection.stateSince, 3700);
  const report = step.input.ledgerFacts!.find((s) => s.value.report)!;
  report.value.report!.createdAt = report.eventAt = report.observedAt = 3900;
  const laterEvent = runStep(step, first);
  assert.equal(laterEvent.projection.stateSince, 3900, 'a later entering event still records the interruption');
  assert.equal(runStep(step, laterEvent).projection.stateSince, 3900);
});

test('H10 a stale report newly required after withdrawal starts stale semantics at the withdrawal', () => {
  const step = fixture('C21').steps[0];
  const native = step.input.sources[0];
  native.evidence.value.activity = 'working';
  native.evidence.value.lastTurnOutcome = 'completed';
  native.evidence.value.openTool = { id: 'tool', startedAt: 1000, lastActivityAt: 1000, deadlineAt: 3700 };
  const report = step.input.ledgerFacts!.find((s) => s.value.report)!;
  report.deadlineAt = 3600;
  const result = runStep(step);
  assert.equal(result.projection.stateKey, 'stale:source_deadline_exceeded');
  assert.equal(result.projection.stateSince, 3700);
  assert.equal(result.projection.freshness.state, 'stale');
  assert.ok(result.projection.freshness.requiredSourceIds.includes('ledger:report'));
  assert.equal(result.projection.lastTurnOutcome, 'completed');
});

test('H10 rebaseline after a tool deadline uses the first semantic observation and stays stable', () => {
  for (const cause of ['rule', 'generation', 'gap', 'first_observation'] as const) {
    const before = fixture('C04').steps[0];
    before.input.sources[0].evidence.value.openTool!.deadlineAt = 3000;
    before.nowMs = 2000;
    before.ruleVersion = cause === 'rule' ? 'b16-v1' : STATUS_RULE_VERSION;
    const previous = runStep(before);
    assert.equal(previous.projection.stateKey, 'working:working');
    const step = structuredClone(before);
    step.ruleVersion = STATUS_RULE_VERSION;
    step.nowMs = 4000;
    if (cause === 'generation') {
      step.input.target.sourceGeneration = 2;
      step.input.observationStamp!.sourceGeneration = 2;
      for (const source of step.input.sources)
        if (source.evidence.origin !== 'ledger') source.evidence.sourceGeneration = 2;
    }
    if (cause === 'gap') step.input.history.gap = true;
    if (cause === 'first_observation') step.input.history.continuity = 'first_observation';
    const baseline = runStep(step, previous);
    assert.equal(baseline.projection.stateKey, 'unknown:insufficient_evidence', cause);
    assert.equal(baseline.projection.stateSince, 4000, cause);
    assert.equal(baseline.projection.stateSinceBasis, 'observed', cause);
    assert.equal(runStep(step, baseline).projection.stateSince, 4000, cause);
    // Once the collector can prove continuation from this new baseline, time
    // advances without changing the committed observed interval.
    const continued = structuredClone(step);
    continued.nowMs = 4500;
    continued.input.history = { continuity: 'proven' };
    const again = runStep(continued, baseline);
    assert.equal(again.projection.stateSince, 4000, cause);
    assert.equal(again.projection.stateSinceBasis, 'observed', cause);
    assert.deepEqual(again.notices, [], cause);
    step.input.history = { continuity: 'proven', rebuildFromEvent: true, ...(cause === 'gap' ? { gap: true } : {}) };
    const rebuilt = runStep(step, previous);
    assert.equal(rebuilt.projection.stateSince, 3000, cause);
    assert.equal(rebuilt.projection.stateSinceBasis, 'event', cause);
  }
});

test('H10 stale recovery cannot reuse a pre-deadline observation under either the same or a new rule', () => {
  for (const priorRule of ['b16-v1', STATUS_RULE_VERSION]) {
    const before = fixture('C04').steps[0];
    before.input.sources[0].evidence.value.openTool!.deadlineAt = 3000;
    before.ruleVersion = priorRule;
    before.nowMs = 2000;
    before.input.requiredSourceIds = ['missing:prior'];
    before.input.history.continuity = 'unknown';
    const prior = runStep(before);
    assert.equal(prior.projection.stateSince, null);
    const next = structuredClone(before);
    next.ruleVersion = STATUS_RULE_VERSION;
    next.nowMs = 4000;
    next.input.history.continuity = 'proven';
    delete next.input.requiredSourceIds;
    const result = runStep(next, prior);
    assert.equal(result.projection.stateSince, 4000, priorRule);
    assert.equal(result.projection.stateSinceBasis, 'observed', priorRule);
    assert.equal(runStep(next, result).projection.stateSince, 4000, priorRule);
    next.input.history.rebuildFromEvent = true;
    const rebuilt = runStep(next, prior);
    assert.equal(rebuilt.projection.stateSince, 3000, priorRule);
    assert.equal(rebuilt.projection.stateSinceBasis, 'event', priorRule);
  }
});
