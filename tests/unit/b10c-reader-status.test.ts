import assert from 'node:assert/strict';
import test from 'node:test';
import { readerStatusSources, restoreNativeStatusMemory } from '../../src/core/link/reader-status.js';
import { initialParserState } from '../../src/core/observation.js';
import type { ReaderResult } from '../../src/core/interfaces/harness-adapter.js';
import type { ObservationEvidence } from '../../src/core/types/observation.js';
const ref = { harness: 'claude' as const, sourceId: '4'.repeat(64), sessionId: 'synthetic-claude', threadId: null };
const target = { nodeIdentity: { kind: 'session' as const, ref }, sourceGeneration: 1 };
function reading(inputs: ObservationEvidence[]): ReaderResult {
  return {
    checkpoint: {
      schemaVersion: 1,
      readerVersion: 'synthetic-claude',
      ref,
      sourceGeneration: 1,
      fileId: { dev: 1, inode: 2 },
      offset: 10,
      parserState: initialParserState(),
    },
    observation: { statusProjection: {} } as ReaderResult['observation'],
    evidence: { inputs } as unknown as ReaderResult['evidence'],
  };
}
function input(value: unknown, eventAt: number | null = 1000): ObservationEvidence {
  return {
    origin: 'transcript',
    ref,
    sourceGeneration: 1,
    validity: 'current',
    evidenceId: 'synthetic-record',
    eventAt,
    observedAt: 2000,
    lastSuccessfulReadAt: 2000,
    value,
  };
}
test('B10C Claude native event time stays separate from collection time; timestamp-less facts retain the stable observed anchor', () => {
  const value = { kind: 'assistant_message', stopReason: 'end_turn', firstObservedAt: 1000 };
  const native = readerStatusSources(reading([input(value)]), target)[0];
  assert.equal(native.evidence.eventAt, 1000);
  assert.equal(native.evidence.observedAt, 2000);
  assert.equal(native.evidence.lastSuccessfulReadAt, 2000);
  assert.equal(native.deadlineAt, 7000);
  const observed = readerStatusSources(reading([input(value, null)]), target)[0];
  assert.equal(observed.evidence.eventAt, null);
  assert.equal(observed.evidence.observedAt, 1000);
  assert.equal(observed.evidence.lastSuccessfulReadAt, 2000);
});
test('B10C Claude tool result pairs only its exact recent call and never fabricates a model-turn outcome or timeout', () => {
  const sources = readerStatusSources(
    reading([
      input({ kind: 'user_message', firstObservedAt: 1000 }),
      input({ kind: 'tool_started', callId: 'synthetic-a', firstObservedAt: 1000 }),
      input({ kind: 'tool_started', callId: 'synthetic-b', firstObservedAt: 1000 }),
      input({ kind: 'tool_finished', callId: 'synthetic-a', isError: true, firstObservedAt: 1000 }),
    ]),
    target
  );
  assert.equal(sources.length, 1);
  assert.equal(sources[0].evidence.value.openTool!.id, 'synthetic-b');
  assert.equal(sources[0].evidence.value.openTool!.deadlineAt, null);
  assert.equal(sources[0].evidence.value.lastTurnOutcome, undefined);
  assert.equal(sources[0].evidence.value.activity, undefined);
});

test('B10C a new Claude native activity record supersedes prior idle without inventing working or erasing the previous outcome', () => {
  const sources = readerStatusSources(
    reading([
      input({ kind: 'assistant_message', stopReason: 'end_turn', firstObservedAt: 1000 }, 1000),
      input({ kind: 'user_message', firstObservedAt: 1500 }, 1500),
      input({ kind: 'tool_started', callId: 'synthetic-new-call', firstObservedAt: 1500 }, 1500),
    ]),
    target
  );
  assert.ok(sources.some((s) => s.evidence.value.lastTurnOutcome === 'completed'));
  assert.ok(sources.every((s) => s.evidence.value.activity === undefined));
});

test('B10C native episode restoration rejects malformed, future and backwards native boundaries', () => {
  assert.equal(restoreNativeStatusMemory('codex-working-v1:[1000,1500]', 1, 2000).known, true);
  for (const anchor of [
    'legacy:1000',
    'codex-working-v1:[1000,900]',
    'codex-working-v1:[1000,3000]',
    'codex-working-v1:[null,0]',
  ])
    assert.equal(restoreNativeStatusMemory(anchor, 1, 2000).known, false);
});
