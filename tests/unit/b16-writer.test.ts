import { ProcessClient } from '../int/process-client.js';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { openObservationStore, type ObservationStore } from '../../src/core/observation-store.js';
import { StatusWriter } from '../../src/core/status/writer.js';
import { checkpointBoundary, checkpointFormat, witnessPreparedObservationBoundary } from '../../src/core/checkpoint.js';
import { initialParserState } from '../../src/core/observation.js';
import type { ReaderResult } from '../../src/core/interfaces/harness-adapter.js';
import type { MergeInput } from '../../src/core/status/merge.js';
import type { ObservationProjection } from '../../src/core/types/checkpoint.js';
import type { SessionRef } from '../../src/core/types/identity.js';

const [major, minor] = process.versions.node.split('.').map(Number);
const skip = (major === 22 && minor >= 13) || major >= 24 ? false : 'B16 SQLite requires Node 22.x >=22.13 or >=24';
interface Step {
  input: MergeInput;
  ruleVersion: string;
  nowMs: number;
}
const steps = (id: string): Step[] =>
  JSON.parse(readFileSync(resolve(`tests/fixtures/status-merge/${id}.json`), 'utf8')).steps;
function reading(step: Step, offset = 10): ReaderResult {
  const target = step.input.target;
  assert.equal(target.nodeIdentity.kind, 'session');
  const ref = (target.nodeIdentity as { kind: 'session'; ref: SessionRef }).ref;
  return {
    checkpoint: {
      schemaVersion: 1,
      readerVersion: 'synthetic-b16-v1',
      ref,
      sourceGeneration: target.sourceGeneration!,
      fileId: { dev: 1, inode: 2 },
      offset,
      parserState: initialParserState(),
    },
    observation: {
      nodeIdentity: { kind: 'session', ref },
      statusProjection: {} as ReaderResult['observation']['statusProjection'],
      conflict: null,
      workspace: null,
      spent: {
        tokens: { value: null, quality: 'unknown', source: 'synthetic:unavailable', asOf: 1000 },
        costUsd: { value: null, quality: 'unknown', source: 'synthetic:unavailable', asOf: 1000 },
      },
      coverage: { state: 'complete', gaps: [], skipped: {}, loaded: true },
      loaded: true,
      depth: 0,
      evidenceStamp: 'synthetic-b16-reading',
    },
  };
}
async function setup(t: import('node:test').TestContext, step = steps('C18')[0]) {
  const home = mkdtempSync(join(tmpdir(), 'b16-writer-'));
  const ref = reading(step).checkpoint.ref;
  let now = 4000;
  const stores: ObservationStore[] = [];
  const open = async () => {
    const store = await openObservationStore({ hudHome: home, sourceId: ref.sourceId, now: () => now });
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const store = await open();
  const lease = store.acquire(ref, 'synthetic-b16');
  return {
    home,
    ref,
    store,
    lease,
    writer: new StatusWriter(store, ref, lease),
    open,
    advance: (time: number) => {
      now = time;
    },
  };
}
function nativeSources(step: Step) {
  return step.input.sources.filter((s) => s.evidence.origin === 'transcript');
}
function external(step: Step) {
  return { ...step.input, sources: step.input.sources.filter((s) => s.evidence.origin !== 'transcript') };
}
function publish(writer: StatusWriter, step: Step, offset = 10) {
  return writer.publish(
    writer.prepare(reading(step, offset), nativeSources(step), step.input.target),
    external(step),
    step.ruleVersion,
    step.nowMs
  );
}

test(
  'B16 restart restores committed continuity and exact notice baseline; consumers only reread',
  { skip },
  async (t) => {
    const f = await setup(t);
    const row = steps('C18');
    publish(f.writer, row[0]);
    const entered = publish(f.writer, row[1], 20);
    assert.equal(entered.committed.summary.statusProjection.stateSince, 3000);
    assert.deepEqual(
      entered.notices.map((n) => [n.kind, n.seq]),
      [['pending', 1]]
    );
    const persisted = f.store.readProjection(f.ref)!;
    assert.deepEqual(persisted.noticeState, entered.committed.noticeState);
    const recovery = f.store.readRecovery(persisted, { maxBytes: 256 * 1024, maxRecords: 2000, budgetMs: 20 });
    assert.ok(recovery && 'checkpoint' in recovery);
    assert.equal(recovery.checkpoint.offset, 20);
    for (let i = 0; i < 20; i++) assert.deepEqual(f.store.readProjection(f.ref), persisted);
    f.store.release(f.ref, f.lease);
    f.store.close();
    const reopened = await f.open();
    const lease = reopened.acquire(f.ref, 'synthetic-restarted');
    const writer = new StatusWriter(reopened, f.ref, lease);
    const again = publish(writer, row[1], 20);
    assert.deepEqual(again.notices, []);
    assert.equal(again.committed.continuity.stateSince, 3000);
    assert.equal(again.committed.noticeState!.noticeSeq, 1);
    // Lease-generation change can publish once; subsequent no-op retains the original accepted stamp.
    const token = writer.prepare(reading(row[1], 20), nativeSources(row[1]), row[1].input.target);
    const noop = writer.publish(token, external(row[1]), row[1].ruleVersion, 4500);
    assert.equal(noop.publication.changed, false);
    assert.deepEqual(noop.committed.observationStamp, again.committed.observationStamp);
  }
);

test('B16 retained prepared reading never re-prepares no-op or summary-only paths', { skip }, async (t) => {
  const f = await setup(t);
  const row = steps('C47');
  let preparations = 0;
  const prepare = f.store.prepareCheckpoint.bind(f.store);
  f.store.prepareCheckpoint = (input) => {
    preparations++;
    return prepare(input);
  };
  const token = f.writer.prepare(reading(row[0]), nativeSources(row[0]), row[0].input.target);
  const first = f.writer.publish(token, external(row[0]), row[0].ruleVersion, 4000);
  for (let i = 0; i < 20; i++) {
    const result = f.writer.publish(token, external(row[0]), row[0].ruleVersion, 4000 + i);
    assert.equal(result.publication.changed, false);
    assert.deepEqual(result.notices, []);
    assert.equal(result.committed.commitSeq, first.committed.commitSeq);
  }
  const changed = f.writer.publish(token, external(row[1]), row[1].ruleVersion, 4500);
  assert.equal(changed.publication.changed, true);
  assert.equal(changed.notices[0].kind, 'uncertain');
  assert.equal(
    changed.committed.checkpointIdentity.contentIdentity,
    first.committed.checkpointIdentity.contentIdentity
  );
  assert.equal(preparations, 1);
});

test('B16 prepares each new ReaderResult even at unchanged offset; captured inputs detached', { skip }, async (t) => {
  const f = await setup(t);
  const step = steps('C18')[0];
  const result = reading(step);
  const token = f.writer.prepare(result, nativeSources(step), step.input.target);
  result.observation.evidenceStamp = 'mutated-after-capture';
  result.checkpoint.offset = 999;
  const first = f.writer.publish(token, external(step), step.ruleVersion, step.nowMs);
  assert.equal(first.committed.checkpointIdentity.offset, 10);
  assert.equal(first.committed.summary.evidenceStamp, 'synthetic-b16-reading');
  result.checkpoint.offset = 10;
  result.checkpoint.parserState.usageMessageIds.push('synthetic-new-id');
  const second = f.writer.publish(
    f.writer.prepare(result, nativeSources(step), step.input.target),
    external(step),
    step.ruleVersion,
    step.nowMs
  );
  assert.notEqual(
    first.committed.checkpointIdentity.contentIdentity,
    second.committed.checkpointIdentity.contentIdentity
  );
  second.committed.ref.sessionId = 'external-mutation';
  assert.equal(publish(f.writer, step).committed.ref.sessionId, f.ref.sessionId);
});

test(
  'B16 stale lease, wrong instance and stale previousCommitSeq fail without advancing baseline',
  { skip },
  async (t) => {
    const f = await setup(t);
    const row = steps('C18');
    const stale = new StatusWriter(f.store, f.ref, f.lease);
    publish(f.writer, row[0]);
    assert.throws(() => publish(stale, row[1]), /observation_commit_conflict/);
    assert.equal(f.store.readProjection(f.ref)!.commitSeq, 1);
    const other = await f.open();
    const imposter = new StatusWriter(other, f.ref, f.lease);
    assert.throws(() => publish(imposter, row[1]), /lease_fenced/);
    f.advance(20000);
    const nextLease = other.acquire(f.ref, 'synthetic-takeover');
    const next = new StatusWriter(other, f.ref, nextLease);
    publish(next, row[1], 20);
    assert.throws(() => publish(f.writer, row[1], 20), /lease_fenced|lease_expired/);
    assert.equal(other.readProjection(f.ref)!.continuity.stateSince, 3000);
  }
);

test('B16 notice sequences advance only in their observation domain and survive new runs', { skip }, async (t) => {
  const f = await setup(t);
  const row = steps('C47');
  let last: ObservationProjection | undefined;
  const sequences: number[] = [];
  for (const [i, step] of row.entries()) {
    const result = publish(f.writer, step, 10 + i);
    last = result.committed;
    sequences.push(...result.notices.map((n) => n.seq));
    for (const n of result.notices) assert.equal(n.seqDomain, last.seqDomain);
  }
  assert.deepEqual(sequences, [1, 2]);
  const step = steps('C35')[1];
  const freshRun = publish(f.writer, step, 100);
  assert.deepEqual(freshRun.notices, []);
  assert.equal(freshRun.committed.noticeState!.noticeSeq, 2);
  const pending = structuredClone(step);
  pending.input.sources[0].evidence.value.pendingReason = 'approval';
  pending.input.sources[0].evidence.value.episodes = { pendingReason: 'synthetic-new-run-approval' };
  assert.equal(publish(f.writer, pending, 110).notices[0].seq, 3);
  const foreign = steps('C18')[0];
  const foreignRef = { ...f.ref, sessionId: 'synthetic-independent-domain' };
  foreign.input.target.nodeIdentity = { kind: 'session', ref: foreignRef };
  for (const s of foreign.input.sources) if (s.evidence.origin !== 'ledger') s.evidence.ref = foreignRef;
  const foreignWriter = new StatusWriter(f.store, foreignRef, f.store.acquire(foreignRef, 'synthetic-other-domain'));
  publish(foreignWriter, foreign);
  foreign.input.sources[0].evidence.value.pendingReason = 'approval';
  const first = publish(foreignWriter, foreign, 20);
  assert.equal(first.notices[0].seq, 1);
  assert.notEqual(first.notices[0].seqDomain, last!.seqDomain);
});

test(
  'B16 report cursor is bounded across history, ignores missing seq without losing status facts',
  { skip },
  async (t) => {
    const f = await setup(t);
    const base = steps('C45')[0];
    publish(f.writer, base);
    const step = steps('C45')[1];
    let result = publish(f.writer, step, 20);
    assert.deepEqual(
      result.notices.map((n) => n.sourceEventSeq),
      [11, 12]
    );
    for (let seq = 13; seq <= 150; seq++) {
      const fact = step.input.ledgerFacts![1];
      fact.seq = seq;
      fact.value.report!.reportId = `synthetic-report-${seq}`;
      step.input.ledgerFacts = [step.input.ledgerFacts![0], fact];
      step.input.asOfSeq = seq;
      result = publish(f.writer, step, 20);
      assert.equal(result.notices.filter((n) => n.kind === 'report').length, 1);
      assert.equal(result.committed.noticeState!.reportSeq, seq);
      assert.deepEqual(result.committed.noticeState!.inputStamps, []);
      assert.ok(JSON.stringify(result.committed.noticeState).length < 600);
    }
    const old = publish(f.writer, steps('C45')[1], 20);
    assert.deepEqual(old.notices, []);
    assert.equal(old.committed.noticeState!.reportSeq, 150);
    const noSeq = steps('C49')[0];
    delete noSeq.input.ledgerFacts![1].seq;
    const missing = publish(f.writer, noSeq, 20);
    assert.equal(missing.merge.projection.stateKey, 'exited:reported');
    assert.deepEqual(missing.notices, []);
    assert.ok(missing.merge.unavailableReasons.some((r) => r.reason === 'report_seq_unavailable'));
    assert.deepEqual(publish(f.writer, noSeq, 20).notices, []);
  }
);

test(
  'B16 old commits without noticeState establish one silent baseline and preserve continuity',
  { skip },
  async (t) => {
    const f = await setup(t);
    const step = steps('C30')[0];
    const first = publish(f.writer, step);
    // A legacy envelope is valid with the optional additive field absent.
    const { checkpointIdentity: _identity, noticeState: _state, ...commit } = first.committed;
    commit.commitSeq++;
    commit.observationStamp.commitSeq++;
    commit.summary.statusProjection.observationStamp!.commitSeq++;
    const cp = reading(step).checkpoint;
    const token = f.store.prepareCheckpoint({
      checkpoint: cp,
      boundary: checkpointBoundary(cp),
      format: checkpointFormat(cp),
      recoveryReferences: [],
    });
    f.store.publishPrepared(
      {
        commit: { ...commit, notices: [...commit.notices] },
        checkpoint: token,
        previousCommitSeq: 1,
        boundary: witnessPreparedObservationBoundary(token, commit.summary, checkpointBoundary(cp)),
      },
      f.lease
    );
    assert.equal(f.store.readProjection(f.ref)!.noticeState, undefined);
    const restarted = new StatusWriter(f.store, f.ref, f.lease);
    const baseline = publish(restarted, step);
    assert.deepEqual(baseline.notices, []);
    assert.equal(baseline.committed.continuity.stateSince, 3200);
    assert.equal(baseline.committed.noticeState!.reportSeq, 11);
    assert.deepEqual(publish(restarted, step).notices, []);
  }
);

test(
  'B16 bounded noticeState accepts three active stamps, refuses fourth/unknown fields and mismatched state',
  { skip },
  async (t) => {
    const f = await setup(t);
    const step = steps('C19')[1];
    step.input.sources[0].evidence.value.lastTurnOutcome = 'failed';
    const first = publish(f.writer, step);
    const state = first.committed.noticeState!;
    assert.equal(state.inputStamps.length, 3);
    assert.equal(state.eventStamps.length, 3);
    const snapshot = f.store.readProjection(f.ref)!;
    for (const fault of ['fourth', 'fourthAlias', 'unknown', 'duplicate', 'identity', 'pending', 'noticeSeq']) {
      const { checkpointIdentity: _identity, ...commit } = structuredClone(snapshot);
      commit.commitSeq++;
      commit.observationStamp.commitSeq++;
      commit.summary.statusProjection.observationStamp!.commitSeq++;
      const s = commit.noticeState!;
      if (fault === 'fourth') s.inputStamps.push(s.inputStamps[0]);
      if (fault === 'fourthAlias') s.eventStamps.push(s.eventStamps[0]);
      if (fault === 'unknown') Object.assign(s, { arbitrary: 'refused' });
      if (fault === 'duplicate') s.inputStamps[1] = s.inputStamps[0];
      if (fault === 'identity') s.identityKey = 'foreign';
      if (fault === 'pending') s.pendingReason = 'none';
      if (fault === 'noticeSeq') s.noticeSeq = -1;
      const cp = reading(step).checkpoint;
      const token = f.store.prepareCheckpoint({
        checkpoint: cp,
        boundary: checkpointBoundary(cp),
        format: checkpointFormat(cp),
        recoveryReferences: [],
      });
      assert.throws(
        () =>
          f.store.publishPrepared(
            {
              commit: { ...commit, notices: [...commit.notices] },
              checkpoint: token,
              previousCommitSeq: snapshot.commitSeq,
              boundary: witnessPreparedObservationBoundary(token, commit.summary, checkpointBoundary(cp)),
            },
            f.lease
          ),
        /invalid_observation|unknown_observation_field|observation_notice_state_mismatch/
      );
      assert.deepEqual(f.store.readProjection(f.ref), snapshot);
    }
  }
);

test('B16 failed publication does not acknowledge an edge; corrected retry emits it once', { skip }, async (t) => {
  const f = await setup(t);
  const row = steps('C18');
  publish(f.writer, row[0]);
  const broken = reading(row[1]);
  broken.checkpoint.offset = 1;
  assert.throws(
    () =>
      f.writer.publish(
        f.writer.prepare(broken, nativeSources(row[1]), row[1].input.target),
        external(row[1]),
        row[1].ruleVersion,
        4000
      ),
    /observation_boundary_mismatch/
  );
  assert.equal(publish(f.writer, row[1], 20).notices.length, 1);
  assert.deepEqual(publish(f.writer, row[1], 20).notices, []);
});

test(
  'B16 process crash before/after COMMIT exposes old or complete new checkpoint/summary/baseline',
  { skip },
  async (t) => {
    for (const point of ['before_commit', 'after_commit']) {
      const f = await setup(t);
      const row = steps('C18');
      const initial = publish(f.writer, row[0]);
      f.store.release(f.ref, f.lease);
      const child = fork(resolve('tests/int/b16-process.mjs'), [], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, HUD_HOME: f.home },
      });
      const client = new ProcessClient(child, 'b16-process');
      t.after(() => client.kill());
      const reached = client.point(point);
      client.send({ home: f.home, ref: f.ref, step: row[1], reading: reading(row[1], 20), point });
      assert.deepEqual(await reached, { point });
      await client.kill();
      const committed = f.store.readProjection(f.ref)!;
      assert.equal(
        committed.commitSeq,
        point === 'before_commit' ? initial.committed.commitSeq : initial.committed.commitSeq + 1
      );
      assert.equal(committed.checkpointIdentity.offset, point === 'before_commit' ? 10 : 20);
      assert.equal(committed.summary.statusProjection.pendingReason, point === 'before_commit' ? 'none' : 'approval');
      assert.equal(committed.continuity.stateSince, point === 'before_commit' ? 1000 : 3000);
      assert.equal(committed.noticeState!.noticeSeq, point === 'before_commit' ? 0 : 1);
      assert.equal(committed.notices.length, point === 'before_commit' ? 0 : 1);
      f.advance(20000);
      const next = new StatusWriter(f.store, f.ref, f.store.acquire(f.ref, 'synthetic-after-crash'));
      const retry = publish(next, row[1], 20);
      assert.equal(retry.notices.length, point === 'before_commit' ? 1 : 0);
    }
  }
);

test(
  'B16 active stamp compaction never orders event identities as text; renewed stale deadlines still publish',
  { skip },
  async (t) => {
    const f = await setup(t);
    const step = steps('C47')[1];
    delete step.input.ledgerFacts![0].value.episodes;
    for (const [seq, expected] of [
      [99, 0],
      [100, 1],
      [100, 0],
    ]) {
      step.input.ledgerFacts![0].seq = seq;
      step.input.asOfSeq = seq;
      const result = publish(f.writer, step);
      assert.equal(result.notices.length, expected);
    }
    const state = f.store.readProjection(f.ref)!.noticeState!;
    assert.equal(state.inputStamps.length, 1);
    assert.ok(state.inputStamps[0].includes('100'));
    assert.equal(state.noticeSeq, 1);
    const row = steps('C62');
    const first = publish(f.writer, row[0]);
    const later = publish(f.writer, row[1]);
    assert.equal(first.committed.continuity.stateSince, 40000);
    assert.equal(later.committed.continuity.stateSince, 75000);
    assert.equal(later.publication.changed, true);
  }
);

test('B16 retained token rejects changed native facts until a new ReaderResult is prepared', { skip }, async (t) => {
  const f = await setup(t);
  const row = steps('C18');
  const token = f.writer.prepare(reading(row[0]), nativeSources(row[0]), row[0].input.target);
  f.writer.publish(token, external(row[0]), row[0].ruleVersion, 4000);
  assert.throws(
    () => f.writer.publish(token, row[1].input, row[1].ruleVersion, 4000),
    /status_transcript_requires_new_reading/
  );
  assert.throws(
    () => f.writer.publish(token, external(steps('C35')[1]), row[1].ruleVersion, 4000),
    /status_reading_mismatch/
  );
  const changedBinding = external(row[0]);
  changedBinding.target = { ...changedBinding.target, bindingGeneration: 999 };
  assert.throws(() => f.writer.publish(token, changedBinding, row[0].ruleVersion, 4000), /status_reading_mismatch/);
  assert.equal(f.store.readProjection(f.ref)!.checkpointIdentity.offset, 10);
  assert.equal(f.store.readProjection(f.ref)!.summary.statusProjection.pendingReason, 'none');
  assert.equal(publish(f.writer, row[1], 20).notices[0].kind, 'pending');
});

test('B16 restart preserves event aliases when the same open episode gains an ID', { skip }, async (t) => {
  const f = await setup(t);
  const row = steps('C66');
  publish(f.writer, row[0]);
  publish(f.writer, row[1], 20);
  f.store.release(f.ref, f.lease);
  f.store.close();
  const store = await f.open();
  const writer = new StatusWriter(store, f.ref, store.acquire(f.ref, 'synthetic-alias-restart'));
  const enriched = publish(writer, row[2], 20);
  assert.deepEqual(enriched.notices, []);
  assert.equal(enriched.committed.noticeState!.noticeSeq, 1);
  assert.equal(enriched.committed.continuity.stateSince, 3100);
});

test('H09–H13 policy rows restore exact committed intervals and bounded dedup from SQLite', { skip }, async (t) => {
  for (const id of ['C01', 'C04', 'C21', 'C30', 'C33', 'C46']) {
    const row = steps(id);
    const f = await setup(t, row[0]);
    for (const step of row) publish(f.writer, step);
    const before = f.store.readProjection(f.ref)!;
    f.store.release(f.ref, f.lease);
    f.store.close();
    const store = await f.open();
    const writer = new StatusWriter(store, f.ref, store.acquire(f.ref, `synthetic-${id}-restart`));
    const again = publish(writer, row.at(-1)!);
    assert.deepEqual(again.notices, [], id);
    assert.equal(again.committed.continuity.stateSince, before.continuity.stateSince, id);
    assert.equal(again.committed.continuity.stateSinceBasis, before.continuity.stateSinceBasis, id);
    assert.deepEqual(again.committed.noticeState, before.noticeState, id);
    assert.ok(again.committed.noticeState!.inputStamps.length <= 3);
    assert.ok(again.committed.noticeState!.eventStamps!.length <= 3);
    const recovery = store.readRecovery(again.committed, { maxBytes: 256 * 1024, maxRecords: 2000, budgetMs: 20 });
    assert.ok(recovery && 'checkpoint' in recovery, id);
    assert.equal(recovery.checkpoint.offset, 10, id);
  }
});

test(
  'H11 recovered report cursor emits only new reports, even across rule upgrade and failed publication',
  { skip },
  async (t) => {
    const base = steps('C21')[0];
    const f = await setup(t, base);
    const initial = publish(f.writer, { ...base, ruleVersion: 'b16-v1' });
    assert.deepEqual(initial.notices, []);
    assert.equal(initial.committed.noticeState!.reportSeq, 11);
    // Rule changes re-baseline continuity, without rebuilding identical native recovery
    // or discarding the successfully committed report cursor.
    const token = f.writer.prepare(reading(base), nativeSources(base), base.input.target);
    const upgraded = f.writer.publish(token, external(base), 'b16-v2', 4000);
    assert.equal(upgraded.committed.continuity.ruleVersion, 'b16-v2');
    assert.equal(upgraded.committed.continuity.stateSince, 3600);
    assert.equal(upgraded.committed.continuity.stateSinceBasis, 'observed');
    assert.deepEqual(upgraded.notices, []);
    assert.equal(
      upgraded.committed.checkpointIdentity.contentIdentity,
      initial.committed.checkpointIdentity.contentIdentity
    );
    const next = structuredClone(base);
    next.input.asOfSeq = 12;
    const report = next.input.ledgerFacts!.find((s) => s.value.report)!;
    report.seq = 12;
    report.value.report!.reportId = 'synthetic-unconsumed-after-restart';
    report.value.report!.createdAt = report.eventAt = report.observedAt = 3900;
    f.store.release(f.ref, f.lease);
    f.store.close();
    const store = await f.open();
    const writer = new StatusWriter(store, f.ref, store.acquire(f.ref, 'synthetic-cursor-restart'));
    const publishPrepared = store.publishPrepared.bind(store);
    store.publishPrepared = () => {
      throw new Error('synthetic-before-publication');
    };
    assert.throws(() => publish(writer, next), /synthetic-before-publication/);
    assert.equal(store.readProjection(f.ref)!.noticeState!.reportSeq, 11);
    store.publishPrepared = publishPrepared;
    const accepted = publish(writer, next);
    assert.deepEqual(
      accepted.notices.map((n) => [n.kind, n.sourceEventSeq]),
      [['report', 12]]
    );
    assert.equal(accepted.committed.noticeState!.reportSeq, 12);
    assert.deepEqual(publish(writer, next).notices, []);
    // B16 owns no parent delegate_wait cursor: its only ledger-domain cursor is
    // noticeState.reportSeq, and the caller's original snapshot facts stay intact.
    assert.equal(base.input.asOfSeq, 11);
    assert.equal(base.input.ledgerFacts!.find((s) => s.value.report)!.seq, 11);
  }
);

test('H10 a retained reading publishes deadline withdrawal without rebuilding native recovery', { skip }, async (t) => {
  const step = steps('C04')[0];
  const f = await setup(t, step);
  const token = f.writer.prepare(reading(step), nativeSources(step), step.input.target);
  const working = f.writer.publish(token, external(step), step.ruleVersion, 2000);
  assert.equal(working.committed.summary.statusProjection.stateKey, 'working:working');
  const expired = f.writer.publish(token, external(step), step.ruleVersion, 4000);
  assert.equal(expired.publication.changed, true);
  assert.equal(expired.committed.summary.statusProjection.stateKey, 'unknown:insufficient_evidence');
  assert.equal(expired.committed.continuity.stateSince, 2000);
  assert.equal(expired.committed.continuity.stateSinceBasis, 'event');
  assert.equal(
    expired.committed.checkpointIdentity.contentIdentity,
    working.committed.checkpointIdentity.contentIdentity
  );
  assert.deepEqual(expired.notices, []);
  const again = f.writer.publish(token, external(step), step.ruleVersion, 4500);
  assert.equal(again.publication.changed, false);
  assert.deepEqual(again.committed.observationStamp, expired.committed.observationStamp);
  assert.deepEqual(again.notices, []);
});

test('H10 rule upgrade and stale recovery establish stable observed intervals across restart', { skip }, async (t) => {
  for (const cause of ['rule', 'stale']) {
    const step = steps('C04')[0];
    step.input.sources[0].evidence.value.openTool!.deadlineAt = 3000;
    if (cause === 'stale') {
      step.input.requiredSourceIds = ['missing:prior'];
      step.input.history.continuity = 'unknown';
    }
    const f = await setup(t, step);
    const token = f.writer.prepare(reading(step), nativeSources(step), step.input.target);
    const old = f.writer.publish(token, external(step), cause === 'rule' ? 'b16-v1' : 'b16-v2', 2000);
    assert.equal(old.committed.continuity.stateSince, cause === 'rule' ? 100 : null);
    assert.equal(old.committed.continuity.stateSinceBasis, cause === 'rule' ? 'event' : 'unknown');
    delete step.input.requiredSourceIds;
    step.input.history.continuity = 'proven';
    const upgraded = f.writer.publish(token, external(step), 'b16-v2', 4000);
    assert.equal(upgraded.committed.continuity.stateSince, 4000);
    assert.equal(upgraded.committed.continuity.stateSinceBasis, 'observed');
    assert.equal(
      upgraded.committed.checkpointIdentity.contentIdentity,
      old.committed.checkpointIdentity.contentIdentity
    );
    assert.deepEqual(upgraded.notices, []);
    const reread = f.writer.publish(token, external(step), 'b16-v2', 4500);
    assert.equal(reread.publication.changed, false);
    assert.equal(reread.committed.continuity.stateSince, 4000);
    assert.equal(reread.committed.continuity.stateSinceBasis, 'observed');
    f.store.release(f.ref, f.lease);
    f.store.close();
    const store = await f.open();
    const writer = new StatusWriter(store, f.ref, store.acquire(f.ref, `synthetic-${cause}-restart`));
    const restored = publish(writer, step);
    assert.equal(restored.committed.continuity.stateSince, 4000);
    assert.equal(restored.committed.continuity.stateSinceBasis, 'observed');
    assert.deepEqual(restored.notices, []);
  }
});
