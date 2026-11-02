import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { serialize, deserialize } from 'node:v8';
import { performance } from 'node:perf_hooks';
import { openObservationStore, type ObservationStore } from '../../src/core/observation-store.js';
import {
  checkpointBoundary,
  witnessObservationBoundary,
  prepareObservationCandidate,
  type ObservationCandidate,
} from '../../src/core/checkpoint.js';
import { initialParserState, projectFreshness } from '../../src/core/observation.js';
import { fixtureRun } from '../fixtures/contracts/identity-execution.js';
import { CodexAdapter, type CodexCheckpoint } from '../../src/harness/codex/index.js';
import { createClaudeReader } from '../../src/harness/claude/reader.js';
import { initial, ROOT, row } from '../fixtures/codex-facade/rollouts.js';
import type { LaunchProfile } from '../../src/core/types/capabilities.js';
import type {
  CollectLease,
  ObservationCommit,
  ReaderCheckpoint,
  ObservationView,
} from '../../src/core/types/observation.js';
import type { SessionRef } from '../../src/core/types/identity.js';

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
function candidate(c = commit(), previous = c.commitSeq - 1): ObservationCandidate {
  return {
    commit: c,
    previousCommitSeq: previous,
    boundary: witnessObservationBoundary(c.checkpoint, c.summary, checkpointBoundary(c.checkpoint)),
  };
}
async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b12-observation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = NOW;
  const options = { hudHome: root, sourceId: REF.sourceId, now: () => now };
  const stores: ObservationStore[] = [];
  const open = async (readOnly = false) => {
    const store = await openObservationStore({ ...options, readOnly });
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
  });
  return {
    root,
    options,
    open,
    now: (value: number) => {
      now = value;
    },
  };
}
const code = (expected: string) => (error: unknown) => (error as { code: string }).code === expected;

test(
  'B12 lease expiry fences old renew/release/publish; generation persists across release/restart and clocks fail closed',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const a = await f.open();
    const first = a.acquire(REF, 'panel');
    a.publish(candidate(), first);
    assert.throws(() => a.acquire(REF, 'statusline'), code('lease_held'));
    f.now(NOW + 15_000);
    assert.throws(() => a.renew(REF, first), code('lease_expired'));
    assert.throws(() => a.release(REF, first), code('lease_expired'));
    const b = await f.open();
    const next = b.acquire(REF, 'statusline');
    assert.equal(next.generation, 2);
    for (const action of [
      () => a.renew(REF, first),
      () => a.release(REF, first),
      () => a.publish(candidate(commit(2)), first),
    ])
      assert.throws(action, code('lease_fenced'));
    b.release(REF, next);
    b.close();
    const restarted = await f.open();
    const third = restarted.acquire(REF, 'restarted');
    assert.equal(third.generation, 3);
    f.now(NOW + 20_000);
    const renewed = restarted.renew(REF, third);
    assert.equal(renewed.expires_at, NOW + 35_000);
    f.now(NOW + 19_000);
    assert.throws(() => restarted.release(REF, third), code('lease_time_unknown'));
    assert.throws(() => restarted.acquire(REF, 'bad-clock'), code('lease_time_unknown'));
    assert.equal(a.readCurrent(REF)!.commitSeq, 1);
  }
);

test(
  'B12 clock rollback after no-op and refused expiry stays read-only without tick writes or lease resurrection',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const store = await f.open();
    const lease = store.acquire(REF, 'panel');
    const first = commit();
    store.publish(candidate(first), lease);
    const same = structuredClone(first);
    same.commitSeq = 2;
    same.observationStamp.commitSeq = 2;
    f.now(NOW + 1000);
    const start = process.resourceUsage().fsWrite;
    assert.equal(store.publish(candidate(same), lease).changed, false);
    f.now(NOW + 500);
    assert.throws(() => store.publish(candidate(commit(2)), lease), code('lease_time_unknown'));
    assert.equal(process.resourceUsage().fsWrite, start);
    f.now(NOW + 15_000);
    assert.throws(() => store.renew(REF, lease), code('lease_expired'));
    f.now(NOW + 10_000);
    assert.throws(() => store.renew(REF, lease), code('lease_time_unknown'));
    assert.throws(() => store.release(REF, lease), code('lease_time_unknown'));
    f.now(NOW + 15_000);
    assert.equal(store.acquire(REF, 'new-competition').generation, 2);
  }
);

test(
  'B12 one source/ref/seq CAS; durable restart continuity and gaps; no ledger created; private/read-only files',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const store = await f.open();
    const lease = store.acquire(REF, 'panel');
    const first = commit();
    first.summary.currentRun = fixtureRun();
    first.summary.currentRun.scopeRef = {
      scope_id: 'synthetic-scope',
      scope_kind: 'pgid',
      pid_domain: 'synthetic-domain',
      boot_id: 'synthetic-boot',
      pgid: 123,
      sid: 123,
      group_leader: { pid: 123, proc_start: '123', boot_id: 'synthetic-boot', pid_domain: 'synthetic-domain' },
    };
    store.publish(candidate(first), lease);
    assert.throws(() => store.publish(candidate(first), lease), code('observation_commit_conflict'));
    const rewound = commit(2);
    rewound.checkpoint.offset = 0;
    assert.throws(() => store.publish(candidate(rewound), lease), code('observation_boundary_mismatch'));
    const replaced = commit(2);
    replaced.checkpoint.fileId.inode++;
    assert.throws(() => store.publish(candidate(replaced), lease), code('observation_boundary_mismatch'));
    assert.throws(() => store.renew(REF, { ...lease, resource: 'collect:another-ref' }), code('lease_fenced'));
    assert.throws(() => store.readCurrent({ ...REF, sourceId: 'f'.repeat(64) }), code('observation_source_mismatch'));
    const isolated = { ...REF, threadId: 'synthetic-thread' };
    assert.equal(store.readCurrent(isolated), null);
    store.release(REF, lease);
    store.close();
    const reader = await f.open(true);
    assert.deepEqual(reader.readCurrent(REF), first);
    assert.throws(() => reader.release(REF, lease), code('observation_read_only'));
    const second = commit(2, 2);
    second.summary.coverage = { state: 'partial', skipped: {}, gaps: ['synthetic_history_gap'], loaded: true };
    second.checkpoint.parserState.gaps = ['synthetic_history_gap'];
    const writer = await f.open();
    const restartedLease = writer.acquire(REF, 'restarted-panel');
    writer.publish(candidate(second), restartedLease);
    assert.equal(reader.readCurrent(REF)!.continuity.stateSince, NOW);
    assert.deepEqual(reader.readCurrent(REF)!.summary.coverage.gaps, ['synthetic_history_gap']);
    assert.equal(fs.statSync(path.dirname(writer.databasePath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(writer.databasePath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(f.root), ['sources']);
  }
);

test(
  'B12 F09 gate rejects raw tails, encoded extensions, binary, tampered witness and inconsistent complete boundaries before writes',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const store = await f.open();
    const lease = store.acquire(REF, 'panel');
    const sentinel = 'SYNTHETIC_PRIVATE_TAIL_SENTINEL';
    const mutations: ((c: ObservationCommit) => void)[] = [
      (c) => {
        c.checkpoint.parserState.pendingBytes = [...Buffer.from(sentinel)];
      },
      (c) => {
        Object.assign(c.checkpoint, { rawTail: sentinel });
      },
      (c) => {
        Object.assign(c.checkpoint.parserState, { payload: Buffer.from(sentinel).toString('base64') });
      },
      (c) => {
        Object.assign(c.summary, { adapter: { nested: { payload: Buffer.from(sentinel).toString('base64') } } });
      },
      (c) => {
        Object.assign(c.summary.spent.tokens, { raw: [...Buffer.from(sentinel)] });
      },
      (c) => {
        Object.assign(c.checkpoint, { hidden: Buffer.from(sentinel) });
      },
      (c) => {
        c.continuity.stateSince = NOW - 1;
      },
      (c) => {
        c.checkpoint.parserState.tailAtEof = true;
      },
      (c) => {
        c.checkpoint.sourceGeneration = 2;
      },
    ];
    for (const mutate of mutations) {
      const c = commit();
      mutate(c);
      assert.throws(() => store.publish(candidate(c), lease));
      assert.equal(store.readCurrent(REF), null);
    }
    const mismatch = candidate();
    mismatch.boundary.summaryBoundary.offset++;
    assert.throws(() => store.publish(mismatch, lease), code('observation_boundary_mismatch'));
    const tampered = candidate();
    tampered.commit.checkpoint.offset++;
    assert.throws(() => store.publish(tampered, lease), code('observation_boundary_mismatch'));
    assert.equal(fs.readFileSync(store.databasePath).includes(Buffer.from(sentinel)), false);
  }
);

test(
  'B12 fixed evidence deadlines ignore repeated reads; a changed absolute freshness deadline persists',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const store = await f.open();
    const lease = store.acquire(REF, 'panel');
    const first = commit();
    first.summary.statusProjection.freshness = projectFreshness(
      [
        {
          id: 'synthetic',
          validity: 'current',
          lastEvidenceAt: NOW,
          observedAt: NOW,
          lastSuccessfulReadAt: NOW,
          deadlineAt: NOW + 30_000,
        },
      ],
      ['synthetic'],
      NOW
    );
    store.publish(candidate(first), lease);
    const readAgain = structuredClone(first);
    readAgain.commitSeq = 2;
    readAgain.observationStamp.commitSeq = 2;
    readAgain.summary.statusProjection.observedAt += 10_000;
    readAgain.summary.statusProjection.freshness.sources[0].observedAt = NOW + 10_000;
    readAgain.summary.statusProjection.freshness.sources[0].lastSuccessfulReadAt = NOW + 10_000;
    assert.deepEqual(store.publish(candidate(readAgain), lease), { changed: false, commitSeq: 1, bytes: 0 });
    readAgain.summary.statusProjection.freshness.sources[0].deadlineAt = NOW + 40_000;
    assert.equal(store.publish(candidate(readAgain), lease).changed, true);
    const saved = store.readCurrent(REF)!.summary.statusProjection.freshness;
    assert.equal(saved.sources[0].deadlineAt, NOW + 40_000);
    assert.equal(projectFreshness(saved.sources, saved.requiredSourceIds, NOW + 30_001).state, 'fresh');
  }
);

test(
  'B12 lock budget returns busy without publishing; read consumers get explicit unavailable and zero writes',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const store = await f.open();
    const lease = store.acquire(REF, 'panel');
    store.publish(candidate(), lease);
    const { DatabaseSync } = await import('node:sqlite');
    const blocker = new DatabaseSync(store.databasePath);
    try {
      blocker.exec('BEGIN EXCLUSIVE');
      for (const action of [
        () => store.readCurrent(REF),
        () => store.readHead(REF),
        () => store.readLease(REF),
        () => store.publish(candidate(commit(2)), lease),
      ])
        assert.throws(action, code('observation_busy'));
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
    assert.equal(store.readCurrent(REF)!.commitSeq, 1);
  }
);

test(
  'B12 controlled readerVersion rebuild removes old raw cache atomically, resets continuity and permanently fences retired readers',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const store = await f.open();
    const lease = store.acquire(REF, 'panel');
    store.publish(candidate(), lease);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(store.databasePath);
    const legacy = commit();
    legacy.checkpoint.parserState.pendingBytes = [...Buffer.from('SYNTHETIC_LEGACY_RAW_TAIL')];
    Object.assign(legacy.checkpoint, { oldRawCache: 'SYNTHETIC_LEGACY_RAW_TAIL' });
    db.prepare('UPDATE observation_current SET body=?').run(JSON.stringify(legacy));
    db.close();
    assert.equal(fs.readFileSync(store.databasePath).includes(Buffer.from('SYNTHETIC_LEGACY_RAW_TAIL')), true);
    assert.throws(() => store.readCurrent(REF));
    assert.deepEqual(store.readHead(REF), {
      commitSeq: 1,
      sourceGeneration: 1,
      readerVersion: 'synthetic-reader-1',
      seqDomain: 'synthetic-observation',
    });
    const rebuilt = commit(2);
    rebuilt.sourceGeneration = 2;
    rebuilt.observationStamp.sourceGeneration = 2;
    rebuilt.checkpoint.sourceGeneration = 2;
    rebuilt.checkpoint.readerVersion = 'synthetic-reader-2';
    rebuilt.checkpoint.offset = 0;
    rebuilt.continuity.sourceGeneration = 2;
    rebuilt.continuity.stateSince = null;
    rebuilt.continuity.stateSinceBasis = 'unknown';
    rebuilt.continuity.episodeAnchor = null;
    rebuilt.summary.statusProjection.stateSince = null;
    rebuilt.summary.statusProjection.stateSinceBasis = 'unknown';
    rebuilt.summary.coverage = { state: 'partial', skipped: {}, gaps: ['reader_version_rebuild'], loaded: true };
    rebuilt.notices = [];
    const pending = candidate(rebuilt);
    assert.throws(() => store.publish(pending, lease), code('observation_rebuild_required'));
    pending.rebuildFromReaderVersion = 'synthetic-reader-1';
    store.publish(pending, lease);
    assert.deepEqual(store.readCurrent(REF), rebuilt);
    assert.equal(fs.readFileSync(store.databasePath).includes(Buffer.from('SYNTHETIC_LEGACY_RAW_TAIL')), false);
    const downgrade = commit(3);
    downgrade.sourceGeneration = 2;
    downgrade.checkpoint.sourceGeneration = 2;
    downgrade.observationStamp.sourceGeneration = 2;
    downgrade.continuity.sourceGeneration = 2;
    assert.throws(() => store.publish(candidate(downgrade), lease), code('observation_reader_retired'));
    assert.deepEqual(fs.readdirSync(path.dirname(store.databasePath)), ['observation.sqlite']);
  }
);

async function fromReader(
  t: TestContext,
  kind: 'codex' | 'claude'
): Promise<{
  checkpoint: ReaderCheckpoint;
  observation: ObservationView;
  next: () => Promise<{ checkpoint: ReaderCheckpoint; observation: ObservationView }>;
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b12-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (kind === 'claude') {
    const target = { ...REF, harness: 'claude' as const };
    const file = path.join(root, 'synthetic.jsonl');
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        uuid: 'synthetic-message',
        sessionId: target.sessionId,
        timestamp: new Date(NOW).toISOString(),
        message: {
          id: 'synthetic-usage',
          role: 'assistant',
          model: 'synthetic-model',
          content: [{ type: 'text', text: 'Synthetic public answer' }],
          usage: { input_tokens: 2, output_tokens: 1 },
        },
      }) + '\n{"type":"api-request-blob","private":"SYNTHETIC_INCOMPLETE_TAIL'
    );
    const reader = createClaudeReader({ ref: target, resolveFile: () => file, serverNames: ['hud'] });
    const budget = {
      maxBytes: 4 * 1024 * 1024,
      maxRecords: 2000,
      budgetMs: 60_000,
    };
    return { ...(await reader.read(budget)), next: () => reader.read(budget) };
  }
  const date = new Date();
  const dir = path.join(
    root,
    'sessions',
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `rollout-${ROOT}.jsonl`),
    [
      ...initial,
      row(
        'response_item',
        {
          type: 'function_call',
          call_id: 'synthetic-public-call',
          name: 'synthetic-tool',
          arguments: JSON.stringify({
            details: 'Synthetic complete public argument',
            draw: true,
            payload: { value: 'synthetic' },
          }),
        },
        9000
      ),
    ].join('\n') + '\n{"type":"session_meta","private":"SYNTHETIC_INCOMPLETE_TAIL'
  );
  const adapter = new CodexAdapter({ maxBytes: 4 * 1024 * 1024, maxRecords: 2000, budgetMs: 60_000 });
  const sourceId = await adapter.resolveSource(
    {
      name: 'synthetic',
      harness: 'codex',
      source: { root, label: 'synthetic' },
      env: {},
      mcpServerName: 'hud',
    } as LaunchProfile,
    {}
  );
  const reader = adapter.open({ ...REF, sourceId, sessionId: ROOT });
  return { ...(await reader.read()), next: () => reader.read() };
}
function readerCommit(checkpoint: ReaderCheckpoint, observation: ObservationView): ObservationCommit {
  const c = commit();
  c.ref = checkpoint.ref;
  c.sourceGeneration = checkpoint.sourceGeneration;
  c.observationStamp = { ...c.observationStamp, ref: c.ref, sourceGeneration: c.sourceGeneration };
  c.checkpoint = checkpoint;
  c.summary = observation;
  c.summary.statusProjection = {
    ...c.summary.statusProjection,
    stateKey: c.continuity.stateKey,
    stateSince: c.continuity.stateSince,
    stateSinceBasis: c.continuity.stateSinceBasis,
    asOfSeq: null,
    observationStamp: c.observationStamp,
    // Synthetic merger policy for this store test: deadline follows evidence,
    // while B16 owns the production source/deadline semantics.
    freshness: {
      ...c.summary.statusProjection.freshness,
      sources: c.summary.statusProjection.freshness.sources.map((source) => ({
        ...source,
        deadlineAt: source.lastEvidenceAt === null ? null : source.lastEvidenceAt + 30_000,
      })),
    },
  };
  c.continuity = {
    ...c.continuity,
    nodeIdentity: { kind: 'session', ref: c.ref },
    sourceGeneration: c.sourceGeneration,
  };
  c.notices = [];
  return c;
}

test(
  'B12 real Codex V8/base64 and Claude typed checkpoints publish/restart without an incomplete private tail; nested native payloads refused',
  { skip },
  async (t) => {
    for (const kind of ['codex', 'claude'] as const) {
      const f = await fixture(t);
      const read = await fromReader(t, kind);
      const store = await openObservationStore({ ...f.options, sourceId: read.checkpoint.ref.sourceId });
      t.after(() => store.close());
      const lease = store.acquire(read.checkpoint.ref, 'panel');
      const c = readerCommit(read.checkpoint, read.observation);
      store.publish(candidate(c), lease);
      const saved = store.readCurrent(c.ref)!;
      if (kind === 'codex') {
        const savedCheckpoint = saved.checkpoint as CodexCheckpoint;
        const inputCheckpoint = c.checkpoint as CodexCheckpoint;
        assert.deepEqual(
          deserialize(Buffer.from(savedCheckpoint.codex.rollout.payload, 'base64')),
          deserialize(Buffer.from(inputCheckpoint.codex.rollout.payload, 'base64'))
        );
        savedCheckpoint.codex.rollout.payload = inputCheckpoint.codex.rollout.payload;
      }
      assert.deepEqual(saved, c);
      assert.equal(fs.readFileSync(store.databasePath).includes(Buffer.from('SYNTHETIC_INCOMPLETE_TAIL')), false);
      const repeat = await read.next();
      const unchanged = readerCommit(repeat.checkpoint, repeat.observation);
      unchanged.commitSeq = 2;
      unchanged.observationStamp.commitSeq = 2;
      assert.deepEqual(store.publish(candidate(unchanged), lease), { changed: false, commitSeq: 1, bytes: 0 });
      if (kind === 'codex') {
        const dirty = structuredClone(c);
        dirty.commitSeq = 2;
        dirty.observationStamp.commitSeq = 2;
        dirty.summary.statusProjection.observationStamp = dirty.observationStamp;
        const native = dirty.checkpoint as CodexCheckpoint;
        const decoded = deserialize(Buffer.from(native.codex.rollout.payload, 'base64'));
        const originalPayload = native.codex.rollout.payload;
        native.codex.rollout.payload = Buffer.concat([
          Buffer.from(originalPayload, 'base64'),
          Buffer.from('SYNTHETIC_PRIVATE_SUFFIX'),
        ]).toString('base64');
        assert.throws(() => store.publish(candidate(dirty), lease), code('invalid_codex_payload'));
        native.codex.rollout.payload = originalPayload;
        const duplicate = deserialize(Buffer.from(originalPayload, 'base64'));
        duplicate.runningCalls = new Map<string, unknown>([
          ['review-caly', 'SYNTHETIC_DUPLICATE_PRIVATE_TAIL'],
          ['review-call', { id: 'review-call', name: 'synthetic-tool', timestamp: new Date(0), status: 'running' }],
        ]);
        const duplicateWire = serialize(duplicate);
        const duplicateKeyOffset = duplicateWire.indexOf(Buffer.from('review-caly'));
        assert.ok(duplicateKeyOffset >= 0);
        Buffer.from('review-call').copy(duplicateWire, duplicateKeyOffset);
        assert.equal(deserialize(duplicateWire).runningCalls.size, 1);
        native.codex.rollout.payload = duplicateWire.toString('base64');
        const normalized = prepareObservationCandidate(candidate(dirty)).commit.checkpoint as CodexCheckpoint;
        assert.equal(
          Buffer.from(normalized.codex.rollout.payload, 'base64').includes(
            Buffer.from('SYNTHETIC_DUPLICATE_PRIVATE_TAIL')
          ),
          false
        );
        assert.deepEqual(
          deserialize(Buffer.from(normalized.codex.rollout.payload, 'base64')).runningCalls,
          deserialize(duplicateWire).runningCalls
        );
        native.codex.rollout.payload = originalPayload;
        for (const hidden of [
          Buffer.from('SYNTHETIC_NAMED_ARRAY_TAIL'),
          Buffer.from('SYNTHETIC_NAMED_ARRAY_TAIL').toString('base64'),
        ]) {
          decoded.readStats.state.pendingBytes = Object.assign([], { rawTail: hidden });
          native.codex.rollout.payload = serialize(decoded).toString('base64');
          assert.throws(() => store.publish(candidate(dirty), lease), code('raw_tail_refused'));
        }
        decoded.readStats.state.pendingBytes = [...Buffer.from('SYNTHETIC_HIDDEN_TAIL')];
        native.codex.rollout.payload = serialize(decoded).toString('base64');
        assert.throws(() => store.publish(candidate(dirty), lease), code('raw_tail_refused'));
        decoded.readStats.state.pendingBytes = [];
        decoded.rateTracker.rawPayload = Buffer.from('SYNTHETIC_HIDDEN_TAIL');
        native.codex.rollout.payload = serialize(decoded).toString('base64');
        assert.throws(() => store.publish(candidate(dirty), lease), code('unknown_observation_field'));
        native.codex.rollout.offset++;
        assert.throws(() => store.publish(candidate(dirty), lease), code('observation_boundary_mismatch'));
      }
    }
  }
);

class ProcessClient {
  child: ChildProcess;
  seq = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
  points = new Map<string, () => void>();
  constructor(t: TestContext) {
    this.child = fork(path.resolve('tests/int/b12-process.mjs'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    this.child.on('message', (message: any) => {
      if (message.point) {
        this.points.get(message.point)?.();
        return;
      }
      const handler = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) handler?.reject(new Error(message.error));
      else handler?.resolve(message.result);
    });
    t.after(async () => {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        const ended = once(this.child, 'exit');
        this.child.kill('SIGKILL');
        await ended;
      }
    });
  }
  call(op: string, input: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.seq;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.send({ id, op, ...input });
    return response;
  }
  point(point: string): Promise<void> {
    return new Promise((resolve) => this.points.set(point, resolve));
  }
  async kill(): Promise<void> {
    const ended = once(this.child, 'exit');
    this.child.kill('SIGKILL');
    await ended;
  }
}

test(
  'B12 reopened stores cannot inherit authority after no-op/expiry clock rollback; same holder waits and reacquires a new generation',
  { skip },
  async (t) => {
    for (const expired of [false, true]) {
      const f = await fixture(t);
      const store = await f.open();
      const lease = store.acquire(REF, 'same-holder');
      store.publish(candidate(), lease);
      if (expired) {
        f.now(NOW + 15_000);
        assert.throws(() => store.renew(REF, lease), code('lease_expired'));
        f.now(NOW + 10_000);
      } else {
        f.now(NOW + 1000);
        const same = commit();
        same.commitSeq = 2;
        same.observationStamp.commitSeq = 2;
        assert.equal(store.publish(candidate(same), lease).changed, false);
        f.now(NOW + 500);
      }
      store.close();
      const reopened = await f.open();
      assert.equal(reopened.readCurrent(REF)!.commitSeq, 1);
      assert.deepEqual(reopened.readLease(REF), lease);
      for (const action of [
        () => reopened.renew(REF, lease),
        () => reopened.release(REF, lease),
        () => reopened.publish(candidate(commit(2)), lease),
      ])
        assert.throws(action, code('lease_fenced'));
      assert.throws(() => reopened.acquire(REF, 'same-holder'), code('lease_held'));
      f.now(NOW + 15_000);
      const next = reopened.acquire(REF, 'same-holder');
      assert.equal(next.generation, 2);
      reopened.publish(candidate(commit(2, 2)), next);
    }
  }
);

test(
  'B12 a crashed collector is read-only through inherited handles; takeover waits expiry and bumps persistent generation',
  { skip, timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const initialized = await f.open();
    initialized.close();
    const actor = new ProcessClient(t);
    await actor.call('open', { options: { hudHome: f.root, sourceId: REF.sourceId }, now: NOW });
    const oldLease = await actor.call('acquire', { ref: REF, holder: 'crashed-holder' });
    await actor.call('publish', { candidate: candidate(), lease: oldLease });
    await actor.kill();
    const next = await f.open();
    assert.equal(next.readCurrent(REF)!.commitSeq, 1);
    assert.throws(() => next.renew(REF, oldLease), code('lease_fenced'));
    assert.throws(() => next.acquire(REF, 'crashed-holder'), code('lease_held'));
    f.now(NOW + 15_000);
    const newLease = next.acquire(REF, 'crashed-holder');
    assert.equal(newLease.generation, 2);
    next.publish(candidate(commit(2, 2)), newLease);
  }
);

test(
  'B12 two real panel/statusline processes elect one writer; delayed old candidate cannot overwrite takeover',
  { skip, timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const a = new ProcessClient(t);
    const b = new ProcessClient(t);
    const initialized = await f.open();
    initialized.close();
    await Promise.all(
      [a, b].map((p) => p.call('open', { options: { hudHome: f.root, sourceId: REF.sourceId }, now: NOW }))
    );
    const results = await Promise.allSettled([
      a.call('acquire', { ref: REF, holder: 'panel' }),
      b.call('acquire', { ref: REF, holder: 'statusline' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const index = results[0].status === 'fulfilled' ? 0 : 1;
    const winner = [a, b][index];
    const loser = [a, b][1 - index];
    const lease = (results[index] as PromiseFulfilledResult<CollectLease>).value;
    await winner.call('publish', { candidate: candidate(), lease });
    for (let seq = 2; seq <= 20; seq++) {
      const [published, read] = await Promise.all([
        winner.call('publish', { candidate: candidate(commit(seq)), lease }),
        loser.call('read', { ref: REF }).catch((error) => {
          assert.match(error.message, /observation_busy/);
          return null;
        }),
      ]);
      assert.equal(published.commitSeq, seq);
      if (read) {
        assert.ok(read.commitSeq === seq || read.commitSeq === seq - 1);
        assert.equal(read.checkpoint.offset, read.commitSeq * 10);
        assert.equal(read.summary.spent.tokens.value.input, read.commitSeq);
        assert.equal(read.notices[0].seq, read.commitSeq);
      }
      assert.deepEqual(await loser.call('read', { ref: REF }), commit(seq));
    }
    const newLease = await loser.call('acquire', { ref: REF, holder: 'takeover', now: NOW + 15_000 });
    assert.equal(newLease.generation, 2);
    await loser.call('publish', { candidate: candidate(commit(21, 2)), lease: newLease });
    await assert.rejects(
      winner.call('publish', { candidate: candidate(commit(21)), lease, now: NOW + 15_000 }),
      /lease_fenced/
    );
    await assert.rejects(winner.call('renew', { ref: REF, lease }), /lease_fenced/);
    await assert.rejects(winner.call('release', { ref: REF, lease }), /lease_fenced/);
    assert.equal((await loser.call('read', { ref: REF })).commitSeq, 21);
  }
);

test(
  'B12 SIGKILL before preparation, after journal writes before publish, and after publish exposes only complete versions; uncommitted leftovers cleaned',
  { skip, timeout: 30_000 },
  async (t) => {
    for (const crash of ['before_prepare', 'before_commit', 'after_commit']) {
      const f = await fixture(t);
      const seed = await f.open();
      const lease = seed.acquire(REF, 'panel');
      seed.publish(candidate(), lease);
      seed.release(REF, lease);
      seed.close();
      const actor = new ProcessClient(t);
      await actor.call('open', { options: { hudHome: f.root, sourceId: REF.sourceId }, now: NOW });
      const actorLease = await actor.call('acquire', { ref: REF, holder: 'crash-actor' });
      const large = commit(2, actorLease.generation);
      large.summary.evidenceStamp = 'synthetic-complete-content-'.repeat(100_000);
      const point = actor.point(crash);
      void actor.call('publish', { candidate: candidate(large), lease: actorLease, crash });
      await point;
      const journal = path.join(f.root, 'sources', REF.sourceId, 'observation.sqlite-journal');
      if (crash === 'before_commit') {
        assert.ok(fs.statSync(journal).size > 0);
        assert.deepEqual(
          [...fs.readFileSync(journal).subarray(0, 8)],
          [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]
        );
      }
      await actor.kill();
      const reopened = await f.open();
      const current = reopened.readCurrent(REF)!;
      assert.deepEqual(current, crash === 'after_commit' ? large : commit());
      assert.equal(fs.existsSync(journal), false);
      assert.deepEqual(fs.readdirSync(path.dirname(reopened.databasePath)), ['observation.sqlite']);
    }
  }
);

test(
  'B12 cost: 1000 publishes/reads, unchanged ages and early renewals cause zero database writes',
  {
    skip:
      skip || (process.env.B12_BENCHMARK !== '1' && 'set B12_BENCHMARK=1 for the isolated 1000-sample disk benchmark'),
    timeout: 60_000,
  },
  async (t) => {
    const f = await fixture(t);
    const store = await f.open();
    const lease = store.acquire(REF, 'panel');
    const publish: number[] = [];
    const read: number[] = [];
    let bytes = 0;
    const before = process.resourceUsage();
    const startSize = fs.statSync(store.databasePath).size;
    for (let seq = 1; seq <= 1050; seq++) {
      const prepared = candidate(commit(seq));
      let start = performance.now();
      const result = store.publish(prepared, lease);
      if (seq > 50) {
        publish.push(performance.now() - start);
        bytes += result.bytes;
      }
      start = performance.now();
      const current = store.readCurrent(REF)!;
      if (seq > 50) read.push(performance.now() - start);
      assert.equal(current.commitSeq, seq);
    }
    const afterPublish = process.resourceUsage();
    const file = fs.readFileSync(store.databasePath);
    const stat = fs.statSync(store.databasePath);
    const idleStart = process.resourceUsage();
    for (let n = 0; n < 1000; n++) {
      const same = store.readCurrent(REF)!;
      same.commitSeq++;
      same.observationStamp.commitSeq++;
      same.summary.statusProjection.observedAt += n;
      same.summary.statusProjection.observationStamp = same.observationStamp;
      assert.deepEqual(store.publish(candidate(same), lease), { changed: false, commitSeq: 1050, bytes: 0 });
      store.renew(REF, lease);
    }
    const idleEnd = process.resourceUsage();
    assert.equal(idleEnd.fsWrite - idleStart.fsWrite, 0);
    assert.equal(fs.statSync(store.databasePath).mtimeMs, stat.mtimeMs);
    assert.deepEqual(fs.readFileSync(store.databasePath), file);
    if (process.env.B12_BENCHMARK_OUTPUT)
      fs.writeFileSync(
        process.env.B12_BENCHMARK_OUTPUT,
        JSON.stringify({
          publishMs: publish,
          readMs: read,
          serializedBytesPerCommit: bytes / 1000,
          fsWrite512ByteBlocksPerCommit: (afterPublish.fsWrite - before.fsWrite) / 1050,
          unchangedTickWrites: idleEnd.fsWrite - idleStart.fsWrite,
        })
      );
    const distribution = (samples: number[]) => {
      samples.sort((a, b) => a - b);
      return {
        n: samples.length,
        p50: samples[499],
        p95: samples[949],
        p99: samples[989],
        max: samples[999],
        over50: samples.filter((n) => n >= 50).length,
      };
    };
    t.diagnostic(
      JSON.stringify({
        publishMs: distribution(publish),
        readMs: distribution(read),
        serializedBytesPerCommit: bytes / 1000,
        fsWrite512ByteBlocksPerCommit: (afterPublish.fsWrite - before.fsWrite) / 1050,
        databaseGrowthBytes: fs.statSync(store.databasePath).size - startSize,
        unchangedTickWrites: idleEnd.fsWrite - idleStart.fsWrite,
      })
    );
  }
);
