import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createClaudeReader,
  CLAUDE_READER_VERSION,
  CLAUDE_RECOVERY_VERSION,
  validateClaudeRecoveryIndexEntry,
  type ClaudeCheckpoint,
  type ClaudeReaderResult,
} from '../../src/harness/claude/reader.js';
import {
  checkpointBoundary,
  checkpointFormat,
  prepareCheckpoint,
  preparedCheckpointData,
  witnessPreparedObservationBoundary,
} from '../../src/core/checkpoint.js';
import type {
  CheckpointContentIdentity,
  RecoveryIndexEntry,
  RecoveryIndexLookup,
  RecoveryIndexReference,
} from '../../src/core/types/checkpoint.js';
import { openObservationStore } from '../../src/core/observation-store.js';
import type { ObservationCommit } from '../../src/core/types/observation.js';
import { assistant, row, toolResult, SESSION } from '../fixtures/claude/transcripts.js';

function fixture(t: test.TestContext, lines: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b12r-claude-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'synthetic.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const options = {
    ref: { harness: 'claude' as const, sourceId: 'e'.repeat(64), sessionId: SESSION, threadId: null },
    resolveFile: () => file,
    serverNames: ['hud'],
  };
  return { file, options };
}

/** In-memory immutable index publication, with the same reader acknowledgement as the store. */
function memoryIndex() {
  const values = new Map<string, Map<string, string>>();
  let gets = 0;
  let pages = 0;
  let serial = 0;
  return {
    get gets() {
      return gets;
    },
    get pages() {
      return pages;
    },
    value(namespace: string, key: string) {
      return values.get(namespace)?.get(key);
    },
    size(namespace: string) {
      return values.get(namespace)?.size ?? 0;
    },
    commit(checkpoint: ClaudeCheckpoint): ClaudeCheckpoint {
      const handoff = checkpoint.recoveryIndex!;
      if (serial > 0 && handoff.delta.base === null) values.clear();
      for (const entry of handoff.delta.entries) {
        let table = values.get(entry.namespace);
        if (!table) values.set(entry.namespace, (table = new Map()));
        if (entry.value === null) table.delete(entry.key);
        else table.set(entry.key, entry.value);
      }
      const snapshot = new Map([...values].map(([namespace, table]) => [namespace, new Map(table)]));
      const reference: RecoveryIndexReference = {
        indexId: `synthetic-index-${++serial}`,
        recoveryVersion: CLAUDE_RECOVERY_VERSION,
        contentIdentity: `synthetic-content-${serial}` as CheckpointContentIdentity,
        boundary: checkpointBoundary(checkpoint),
      };
      const lookup: RecoveryIndexLookup = {
        reference,
        get(namespace, key) {
          gets++;
          return snapshot.get(namespace)?.get(key);
        },
        page(namespace, after, limit) {
          pages++;
          return [...(snapshot.get(namespace) ?? [])]
            .sort(([a], [b]) => a.localeCompare(b))
            .filter(([key]) => after === null || key > after)
            .slice(0, limit)
            .map(([key, value]): RecoveryIndexEntry => ({ namespace, key, value }));
        },
      };
      handoff.committed?.(lookup);
      const saved = JSON.parse(JSON.stringify(checkpoint)) as ClaudeCheckpoint;
      saved.recoveryIndex = { delta: { recoveryVersion: CLAUDE_RECOVERY_VERSION, base: reference, entries: [] } };
      Object.defineProperty(saved.recoveryIndex, 'lookup', { value: lookup });
      return saved;
    },
  };
}

function inlineBytes(checkpoint: ClaudeCheckpoint): number {
  const { recoveryIndex: _index, ...inline } = checkpoint;
  return Buffer.byteLength(JSON.stringify(inline));
}

test('B12R Claude historical usage IDs and fact clocks recover lazily with bounded inline state', async (t) => {
  const original = JSON.parse(assistant('synthetic-usage-0', undefined, 0));
  delete original.timestamp;
  const lines = [
    JSON.stringify(original),
    ...Array.from({ length: 6000 }, (_, n) => assistant(`synthetic-usage-${n + 1}`, undefined, n + 1)),
  ];
  const f = fixture(t, lines);
  const store = memoryIndex();
  const reader = createClaudeReader(f.options);
  let result: ClaudeReaderResult;
  let persisted: ClaudeCheckpoint;
  let maximumInlineBytes = 0;
  do {
    result = await reader.read();
    maximumInlineBytes = Math.max(maximumInlineBytes, inlineBytes(result.checkpoint));
    assert.ok(inlineBytes(result.checkpoint) <= 256 * 1024);
    assert.deepEqual(result.checkpoint.parserState.usageMessageIds, []);
    assert.deepEqual(result.checkpoint.claude.factClocks, {});
    assert.deepEqual(result.checkpoint.claude.factClockPages, []);
    persisted = store.commit(result.checkpoint);
  } while (result.observation.coverage.state === 'catching_up');
  t.diagnostic(`6001 historical entries: maximum inline recovery ${maximumInlineBytes} bytes`);
  assert.equal(result.checkpoint.readerVersion, CLAUDE_READER_VERSION);
  assert.equal(result.observation.spent.tokens.value?.input, 600100);
  assert.equal(store.size('claude.usageMessageIds'), 6001);
  assert.equal(store.size('claude.factClocks'), 6001);
  const originalClock = store.value('claude.factClocks', 'synthetic-record-0:assistant_message');
  assert.ok(originalClock);
  const beforeGets = store.gets;
  const beforePages = store.pages;
  const restored = createClaudeReader(f.options, persisted!);
  assert.equal(store.gets, beforeGets, 'restart must not load historical IDs or clocks');
  assert.equal(store.pages, beforePages, 'restart must not scan historical index pages');
  fs.appendFileSync(f.file, JSON.stringify(original) + '\n');
  const duplicate = await restored.read();
  assert.deepEqual(duplicate.observation.spent.tokens, result.observation.spent.tokens);
  assert.equal(
    duplicate.observation.statusProjection.lastEvidenceAt,
    result.observation.statusProjection.lastEvidenceAt
  );
  assert.ok(!duplicate.inputs.some((input) => input.evidenceId?.endsWith(':synthetic-record-0:assistant_message')));
  assert.equal(store.pages, beforePages);
  assert.ok(store.gets - beforeGets <= 4, 'one duplicate performs only exact-key reads');
  store.commit(duplicate.checkpoint);
  assert.equal(store.value('claude.factClocks', 'synthetic-record-0:assistant_message'), originalClock);
  assert.equal(duplicate.checkpoint.recoveryIndex!.delta.entries.length, 0);
  fs.appendFileSync(f.file, assistant('synthetic-new-after-publication', undefined, 10000) + '\n');
  const increment = await restored.read();
  assert.equal(increment.checkpoint.recoveryIndex!.delta.entries.length, 2);
  assert.ok(
    increment.checkpoint.recoveryIndex!.delta.entries.every(
      (entry) => entry.key.includes('10000') || entry.key === 'synthetic-new-after-publication'
    )
  );
  assert.equal(increment.observation.spent.tokens.value?.input, 600200);
});

test('B12R Claude preserves every open call and pending link across recovery without public arguments', async (t) => {
  const f = fixture(
    t,
    Array.from({ length: 180 }, (_, n) =>
      assistant(`synthetic-tool-message-${n}`, undefined, n, [
        {
          type: 'tool_use',
          id: `synthetic-call-${n}`,
          name: 'mcp__hud__delegate_spawn',
          input: { brief: n < 10 ? 'SYNTHETIC_PUBLIC_ARGUMENT_'.repeat(28000) : 'Synthetic task' },
        },
      ])
    )
  );
  const store = memoryIndex();
  const reader = createClaudeReader(f.options);
  let result: ClaudeReaderResult;
  let persisted: ClaudeCheckpoint;
  let maximumInlineBytes = 0;
  do {
    result = await reader.read();
    maximumInlineBytes = Math.max(maximumInlineBytes, inlineBytes(result.checkpoint));
    assert.ok(inlineBytes(result.checkpoint) <= 256 * 1024);
    assert.ok(!JSON.stringify(result.checkpoint).includes('SYNTHETIC_PUBLIC_ARGUMENT_'));
    persisted = store.commit(result.checkpoint);
  } while (result.observation.coverage.state === 'catching_up');
  t.diagnostic(`10 large public arguments / 180 open calls: maximum inline recovery ${maximumInlineBytes} bytes`);
  assert.equal(store.size('claude.openToolWaits'), 180);
  assert.equal(store.size('claude.pendingHudCalls'), 180);
  assert.deepEqual(result.checkpoint.parserState.openToolWaits, []);
  assert.deepEqual(result.checkpoint.claude.pendingHudCalls, {});
  fs.appendFileSync(f.file, toolResult('synthetic-call-0', 'synthetic-late-run', 10000) + '\n');
  const restored = await createClaudeReader(f.options, persisted!).read();
  assert.ok(
    restored.evidence.linkEvidence.some((link) => link.kind === 'tool_result' && link.runId === 'synthetic-late-run')
  );
  store.commit(restored.checkpoint);
  assert.equal(store.size('claude.openToolWaits'), 179);
  assert.equal(store.size('claude.pendingHudCalls'), 179);
  assert.equal(store.value('claude.openToolWaits', 'synthetic-call-0'), undefined);
  assert.ok(store.value('claude.openToolWaits', 'synthetic-call-1'));
});

test('B12R Claude uncommitted JSON delta preserves dedup and compaction retires live calls only', async (t) => {
  const f = fixture(t, [
    assistant('synthetic-usage', undefined, 0, [
      { type: 'tool_use', id: 'synthetic-call', name: 'mcp__hud__delegate_spawn', input: {} },
    ]),
  ]);
  const first = await createClaudeReader(f.options).read();
  const saved = JSON.parse(JSON.stringify(first.checkpoint)) as ClaudeCheckpoint;
  fs.appendFileSync(
    f.file,
    row('system', { subtype: 'compact_boundary' }, 10) + '\n' + assistant('synthetic-usage', undefined, 20) + '\n'
  );
  const restored = await createClaudeReader(f.options, saved).read();
  assert.equal(restored.checkpoint.resetReason, 'compaction');
  assert.equal(restored.observation.spent.tokens.value?.input, 100);
  const store = memoryIndex();
  store.commit(restored.checkpoint);
  assert.equal(store.size('claude.openToolWaits'), 0);
  assert.equal(store.size('claude.pendingHudCalls'), 0);
  assert.equal(store.size('claude.usageMessageIds'), 1);
});

test('B12R Claude rejects legacy reader recovery and unknown or payload-bearing index metadata', async (t) => {
  const f = fixture(t, [assistant()]);
  const first = await createClaudeReader(f.options).read();
  const old = JSON.parse(JSON.stringify(first.checkpoint)) as ClaudeCheckpoint;
  old.readerVersion = 'claude-reader-3';
  assert.throws(() => createClaudeReader(f.options, old), /unsupported_claude_checkpoint/);
  for (const entry of [
    { namespace: 'claude.raw', key: 'synthetic', value: '"SYNTHETIC_RAW"' },
    { namespace: 'claude.usageMessageIds', key: 'synthetic', value: '"SYNTHETIC_RAW"' },
    { namespace: 'claude.factClocks', key: 'synthetic:assistant_message', value: '"SYNTHETIC_RAW"' },
    { namespace: 'claude.pendingHudCalls', key: 'synthetic', value: '{"raw":"SYNTHETIC_RAW"}' },
    {
      namespace: 'claude.openToolWaits',
      key: 'synthetic',
      value: '{"startedAt":0,"lastActivityAt":0,"raw":"SYNTHETIC_RAW"}',
    },
  ])
    assert.throws(() => validateClaudeRecoveryIndexEntry(entry), /invalid_claude_recovery_index_entry/);
});

test('B12R Claude no-op durable recovery is stable while live read time advances', async (t) => {
  const f = fixture(t, [assistant()]);
  let now = Date.now();
  t.mock.method(Date, 'now', () => ++now);
  const reader = createClaudeReader(f.options);
  const first = await reader.read();
  const store = memoryIndex();
  store.commit(first.checkpoint);
  const idle = await reader.read();
  const later = await reader.read();
  assert.equal(idle.checkpoint.claude.lastSuccessfulReadAt, null);
  assert.equal(JSON.stringify(idle.checkpoint), JSON.stringify(later.checkpoint));
  assert.ok(later.inputs[0].lastSuccessfulReadAt! > idle.inputs[0].lastSuccessfulReadAt!);
});

test('B12R Claude saves byte-bounded multibyte report excerpts without changing live reports or exact metadata', async (t) => {
  const text = '漢\u0000'.repeat(8192);
  const lines = Array.from({ length: 24 }, (_, n) =>
    assistant(`synthetic-multibyte-${n}`, undefined, n, [
      { type: 'text', text },
      ...(n === 0
        ? [{ type: 'tool_use', id: 'synthetic-multibyte-call', name: 'mcp__hud__delegate_spawn', input: {} }]
        : []),
    ])
  );
  assert.ok(lines.every((line) => Buffer.byteLength(line) <= 1024 * 1024));
  const f = fixture(t, lines);
  const reader = createClaudeReader(f.options);
  let result: ClaudeReaderResult;
  do {
    result = await reader.read();
  } while (result.observation.coverage.state === 'catching_up');
  assert.equal(result.evidence.reports.length, 20);
  assert.ok(result.evidence.reports.every((report) => report.text === text.slice(0, 4096)));
  assert.equal(result.checkpoint.claude.reportsTruncated, true);
  assert.equal(result.checkpoint.claude.reports.length, 20);
  for (let i = 0; i < 20; i++) {
    const saved = result.checkpoint.claude.reports[i];
    assert.ok(Buffer.byteLength(JSON.stringify(saved.text)) <= 1024);
    assert.ok(saved.text.endsWith('…'));
    assert.equal(saved.at, result.evidence.reports[i].at);
    assert.equal(saved.kind, result.evidence.reports[i].kind);
  }
  const prepared = prepareCheckpoint({
    checkpoint: result.checkpoint,
    boundary: checkpointBoundary(result.checkpoint),
    format: checkpointFormat(result.checkpoint),
    recoveryReferences: [],
  });
  const bytes = Buffer.byteLength(preparedCheckpointData(prepared).body);
  assert.ok(bytes <= 256 * 1024);
  t.diagnostic(`24 legal multibyte/escaped reports: prepared inline recovery ${bytes} bytes`);
  assert.ok(result.checkpoint.recoveryIndex!.delta.entries.every((entry) => !entry.value?.includes('漢')));
  const store = memoryIndex();
  const persisted = store.commit(result.checkpoint);
  assert.equal(store.size('claude.usageMessageIds'), 24);
  assert.equal(store.size('claude.openToolWaits'), 1);
  assert.equal(store.size('claude.pendingHudCalls'), 1);
  fs.appendFileSync(
    f.file,
    lines[0] + '\n' + toolResult('synthetic-multibyte-call', 'synthetic-multibyte-run', 10000) + '\n'
  );
  const restored = createClaudeReader(f.options, persisted);
  let recovered: ClaudeReaderResult;
  do {
    recovered = await restored.read();
  } while (recovered.observation.coverage.state === 'catching_up');
  assert.equal(recovered.observation.spent.tokens.value?.input, 2400);
  assert.ok(
    recovered.evidence.linkEvidence.some(
      (link) => link.kind === 'tool_result' && link.runId === 'synthetic-multibyte-run'
    )
  );
  store.commit(recovered.checkpoint);
  assert.equal(store.size('claude.pendingHudCalls'), 0);
  assert.equal(store.size('claude.openToolWaits'), 0);
});

function withLookup(checkpoint: ClaudeCheckpoint, lookup: RecoveryIndexLookup): ClaudeCheckpoint {
  const saved = JSON.parse(JSON.stringify(checkpoint)) as ClaudeCheckpoint;
  Object.defineProperty(saved.recoveryIndex!, 'lookup', { value: lookup });
  return saved;
}

test('B12R Claude compaction rolls back inline state and both live indexes when lazy paging is busy', async (t) => {
  const f = fixture(t, [
    assistant('synthetic-before-compact', undefined, 0, [
      { type: 'tool_use', id: 'synthetic-pending-before-compact', name: 'mcp__hud__delegate_spawn', input: {} },
    ]),
  ]);
  const first = await createClaudeReader(f.options).read();
  const store = memoryIndex();
  const persisted = store.commit(first.checkpoint);
  const original = persisted.recoveryIndex!.lookup!;
  let failPendingPage = true;
  let sawOpenPage = false;
  const lookup: RecoveryIndexLookup = {
    reference: original.reference,
    get: (namespace, key) => original.get(namespace, key),
    page(namespace, after, limit) {
      if (namespace === 'claude.openToolWaits') sawOpenPage = true;
      if (namespace === 'claude.pendingHudCalls' && failPendingPage) {
        assert.equal(sawOpenPage, true);
        failPendingPage = false;
        throw new Error('synthetic_observation_busy');
      }
      return original.page(namespace, after, limit);
    },
  };
  const reader = createClaudeReader(f.options, withLookup(persisted, lookup));
  fs.appendFileSync(f.file, row('system', { subtype: 'compact_boundary' }, 10) + '\n');
  await assert.rejects(reader.read(), /synthetic_observation_busy/);
  const unchanged = await reader.read({ maxBytes: 0, maxRecords: 0, budgetMs: 0 });
  assert.equal(unchanged.checkpoint.offset, first.checkpoint.offset);
  assert.equal(unchanged.checkpoint.sourceGeneration, first.checkpoint.sourceGeneration);
  assert.equal(unchanged.checkpoint.parserState.compactBoundary, null);
  assert.deepEqual(unchanged.checkpoint.recoveryIndex!.delta.entries, []);
  store.commit(unchanged.checkpoint);
  assert.equal(store.size('claude.openToolWaits'), 1);
  assert.equal(store.size('claude.pendingHudCalls'), 1);
  const retried = await reader.read();
  assert.equal(retried.checkpoint.sourceGeneration, first.checkpoint.sourceGeneration + 1);
  assert.equal(retried.checkpoint.resetReason, 'compaction');
  assert.equal(retried.checkpoint.parserState.compactBoundary, 'synthetic-record-10');
  assert.ok(retried.inputs.some((input) => (input.value as { kind: string }).kind === 'compact_boundary'));
  assert.equal(retried.observation.spent.tokens.value?.input, 100);
  store.commit(retried.checkpoint);
  assert.equal(store.size('claude.openToolWaits'), 0);
  assert.equal(store.size('claude.pendingHudCalls'), 0);
  assert.equal(store.size('claude.usageMessageIds'), 1);
});

test('B12R Claude failed lazy lookup after usage changes retries without partial totals or dedup', async (t) => {
  const f = fixture(t, [assistant('synthetic-usage-baseline', undefined, 0)]);
  const first = await createClaudeReader(f.options).read();
  const store = memoryIndex();
  const persisted = store.commit(first.checkpoint);
  const original = persisted.recoveryIndex!.lookup!;
  let fail = true;
  const lookup: RecoveryIndexLookup = {
    reference: original.reference,
    page: (namespace, after, limit) => original.page(namespace, after, limit),
    get(namespace, key) {
      if (fail && namespace === 'claude.factClocks' && key === 'synthetic-record-2:assistant_message') {
        fail = false;
        throw new Error('synthetic_observation_busy');
      }
      return original.get(namespace, key);
    },
  };
  const reader = createClaudeReader(f.options, withLookup(persisted, lookup));
  fs.appendFileSync(
    f.file,
    [assistant('synthetic-usage-one', undefined, 1), assistant('synthetic-usage-two', undefined, 2)].join('\n') + '\n'
  );
  await assert.rejects(reader.read(), /synthetic_observation_busy/);
  const unchanged = await reader.read({ maxBytes: 0, maxRecords: 0, budgetMs: 0 });
  assert.equal(unchanged.checkpoint.offset, first.checkpoint.offset);
  assert.equal(unchanged.observation.spent.tokens.value?.input, 100);
  assert.deepEqual(unchanged.checkpoint.recoveryIndex!.delta.entries, []);
  const retried = await reader.read();
  assert.equal(retried.observation.spent.tokens.value?.input, 300);
  assert.equal(retried.checkpoint.offset, fs.statSync(f.file).size);
  store.commit(retried.checkpoint);
  assert.equal(store.size('claude.usageMessageIds'), 3);
  assert.equal(store.size('claude.factClocks'), 3);
});

test('B12R Claude retains unpublished truncate provenance across slices and JSON restart until acknowledgement', async (t) => {
  const f = fixture(t, [
    assistant('synthetic-old-lineage', undefined, 0, [{ type: 'text', text: 'old'.repeat(10000) }]),
  ]);
  const reader = createClaudeReader(f.options);
  const store = memoryIndex();
  const first = await reader.read();
  store.commit(first.checkpoint);
  fs.writeFileSync(f.file, assistant('synthetic-new-lineage-one', undefined, 1) + '\n');
  const reset = await reader.read();
  assert.equal(reset.checkpoint.resetReason, 'truncated');
  assert.equal(reset.checkpoint.recoveryIndex!.delta.base, null);
  assert.equal(reset.checkpoint.sourceGeneration, first.checkpoint.sourceGeneration + 1);
  // Publication is skipped (or busy): preparation alone must not acknowledge the reset.
  prepareCheckpoint({
    checkpoint: reset.checkpoint,
    boundary: checkpointBoundary(reset.checkpoint),
    format: checkpointFormat(reset.checkpoint),
    recoveryReferences: [],
  });
  fs.appendFileSync(f.file, assistant('synthetic-new-lineage-two', undefined, 2) + '\n');
  const next = await reader.read();
  assert.equal(next.checkpoint.resetReason, 'truncated');
  assert.equal(next.checkpoint.sourceGeneration, reset.checkpoint.sourceGeneration);
  assert.equal(next.observation.spent.tokens.value?.input, 200);
  const restarted = createClaudeReader(f.options, JSON.parse(JSON.stringify(next.checkpoint)) as ClaudeCheckpoint);
  const stillUnpublished = await restarted.read();
  assert.equal(stillUnpublished.checkpoint.resetReason, 'truncated');
  const committed = store.commit(stillUnpublished.checkpoint);
  assert.equal(store.size('claude.usageMessageIds'), 2);
  const acknowledged = await restarted.read();
  assert.equal(acknowledged.checkpoint.resetReason, undefined);
  assert.equal(
    acknowledged.checkpoint.recoveryIndex!.delta.base!.boundary.sourceGeneration,
    reset.checkpoint.sourceGeneration
  );
  const committedRestart = await createClaudeReader(f.options, committed).read();
  assert.equal(committedRestart.checkpoint.resetReason, undefined);
});

test('B12R Claude an older reset acknowledgement cannot clear a newer pending reset', async (t) => {
  const f = fixture(t, [
    assistant('synthetic-old-reset-baseline', undefined, 0, [{ type: 'text', text: 'old'.repeat(10000) }]),
  ]);
  const reader = createClaudeReader(f.options);
  const store = memoryIndex();
  store.commit((await reader.read()).checkpoint);
  fs.writeFileSync(
    f.file,
    assistant('synthetic-reset-one', undefined, 1, [{ type: 'text', text: 'middle'.repeat(1000) }]) + '\n'
  );
  const olderReset = await reader.read();
  assert.equal(olderReset.checkpoint.resetReason, 'truncated');
  fs.writeFileSync(f.file, assistant('synthetic-reset-two', undefined, 2) + '\n');
  const newerReset = await reader.read();
  assert.equal(newerReset.checkpoint.sourceGeneration, olderReset.checkpoint.sourceGeneration + 1);
  store.commit(olderReset.checkpoint);
  const stillPending = await reader.read();
  assert.equal(stillPending.checkpoint.resetReason, 'truncated');
  assert.equal(stillPending.checkpoint.sourceGeneration, newerReset.checkpoint.sourceGeneration);
  store.commit(stillPending.checkpoint);
  assert.equal((await reader.read()).checkpoint.resetReason, undefined);
});

for (const restart of [false, true]) {
  test(`B12R Claude physical reset followed by unpublished compaction publishes a fresh lineage${restart ? ' after JSON restart' : ''}`, async (t) => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (!((major === 22 && minor >= 13) || major >= 24)) {
      t.skip('observation SQLite requires Node 22.x >=22.13 or >=24');
      return;
    }
    const f = fixture(t, [
      assistant('synthetic-compound-old', undefined, 0, [{ type: 'text', text: 'old'.repeat(10000) }]),
    ]);
    const store = await openObservationStore({
      hudHome: path.join(path.dirname(f.file), 'hud'),
      sourceId: f.options.ref.sourceId,
      now: () => 1_700_000_000_000,
    });
    t.after(() => store.close());
    const lease = store.acquire(f.options.ref, 'synthetic-claude-compound');
    const publish = (result: ClaudeReaderResult, seq: number) => {
      const cp = result.checkpoint;
      const stamp = {
        ref: cp.ref,
        sourceGeneration: cp.sourceGeneration,
        seqDomain: 'synthetic-compound',
        commitSeq: seq,
        inputLedgerSeq: null,
      };
      const summary = structuredClone(result.observation);
      summary.statusProjection.observationStamp = stamp;
      const commit: ObservationCommit = {
        ref: cp.ref,
        sourceGeneration: cp.sourceGeneration,
        leaseGeneration: lease.generation,
        seqDomain: stamp.seqDomain,
        commitSeq: seq,
        observationStamp: stamp,
        checkpoint: cp,
        summary,
        continuity: {
          nodeIdentity: { kind: 'session', ref: cp.ref },
          ruleVersion: 'synthetic-compound-rule',
          sourceGeneration: cp.sourceGeneration,
          episodeAnchor: null,
          stateKey: 'unknown',
          stateSince: null,
          stateSinceBasis: 'unknown',
        },
        notices: [],
      };
      const prepared = store.prepareCheckpoint({
        checkpoint: cp,
        boundary: checkpointBoundary(cp),
        format: checkpointFormat(cp),
        recoveryReferences: cp.recoveryIndex?.delta.base ? [cp.recoveryIndex.delta.base] : [],
      });
      const { checkpoint: _checkpoint, ...projection } = commit;
      return store.publishPrepared(
        {
          commit: projection,
          checkpoint: prepared,
          previousCommitSeq: seq - 1,
          boundary: witnessPreparedObservationBoundary(prepared, summary, checkpointBoundary(cp)),
        },
        lease
      );
    };
    let reader = createClaudeReader(f.options);
    const first = await reader.read();
    assert.equal(publish(first, 1).changed, true);
    fs.writeFileSync(
      f.file,
      assistant('synthetic-compound-new', undefined, 1) +
        '\n' +
        row('system', { subtype: 'compact_boundary' }, 2) +
        '\n'
    );
    const physical = await reader.read({ maxBytes: 4 * 1024 * 1024, maxRecords: 1, budgetMs: 20 });
    assert.equal(physical.checkpoint.resetReason, 'truncated');
    assert.equal(physical.checkpoint.recoveryIndex!.delta.base, null);
    if (restart)
      reader = createClaudeReader(f.options, JSON.parse(JSON.stringify(physical.checkpoint)) as ClaudeCheckpoint);
    const compacted = await reader.read();
    assert.equal(compacted.checkpoint.sourceGeneration, first.checkpoint.sourceGeneration + 2);
    assert.equal(compacted.checkpoint.resetReason, 'truncated');
    assert.equal(compacted.checkpoint.parserState.compactBoundary, 'synthetic-record-2');
    assert.equal(compacted.checkpoint.recoveryIndex!.delta.base, null);
    assert.equal(compacted.observation.spent.tokens.value?.input, 100);
    assert.equal(publish(compacted, 2).changed, true);
    assert.equal(store.readProjection(f.options.ref)!.sourceGeneration, compacted.checkpoint.sourceGeneration);
    const acknowledged = await reader.read();
    assert.equal(acknowledged.checkpoint.resetReason, undefined);
    assert.equal(
      acknowledged.checkpoint.recoveryIndex!.delta.base!.boundary.sourceGeneration,
      compacted.checkpoint.sourceGeneration
    );
  });
}
