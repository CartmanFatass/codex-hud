import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodexAdapter, CODEX_READER_VERSION, type CodexCheckpoint } from '../../src/harness/codex/index.js';
import {
  RolloutParser,
  validateRolloutRecovery,
  validateCodexRecoveryIndexEntry,
} from '../../src/collectors/rollout.js';
import { checkpointBoundary, witnessObservationBoundary } from '../../src/core/checkpoint.js';
import { ObservationStoreError } from '../../src/core/collect-lease.js';
import { openObservationStore } from '../../src/core/observation-store.js';
import type { ObservationCommit } from '../../src/core/types/observation.js';
import type { ObservationRecovery } from '../../src/core/types/checkpoint.js';
import type { RecoveryIndexLookup, RecoveryIndexReference } from '../../src/core/types/checkpoint.js';
import type { ReaderResult } from '../../src/core/interfaces/harness-adapter.js';
import type { LaunchProfile } from '../../src/core/types/capabilities.js';

const AT = Date.parse('2026-03-01T12:00:00Z');
const budget = { maxBytes: 8 * 1024 * 1024, maxRecords: 20_000, budgetMs: 60_000 };
const record = (type: string, payload: object, ms = 0) =>
  JSON.stringify({ type, payload, timestamp: new Date(AT + ms).toISOString() });
const call = (id: string, ms: number, args = '{}', name = 'exec_command') =>
  record('response_item', { type: 'function_call', call_id: id, name, arguments: args }, ms);
const output = (id: string, ms: number, text: unknown = { success: true }) =>
  record('response_item', { type: 'function_call_output', call_id: id, output: text }, ms);
const usage = (tokens: number, ms: number) =>
  record(
    'event_msg',
    {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 1000, output_tokens: tokens },
        last_token_usage: { total_tokens: 2000 },
        model_context_window: 100_000,
      },
    },
    ms
  );
const inlineBytes = (result: ReaderResult) => {
  const { recoveryIndex: _index, ...inline } = result.checkpoint;
  return Buffer.byteLength(JSON.stringify(inline));
};
async function fixture(t: test.TestContext, lines: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b12r-codex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'sessions', '2026', '03', '01');
  fs.mkdirSync(dir, { recursive: true });
  const id = '11111111-1111-4111-8111-111111111111';
  const file = path.join(dir, `rollout-2026-03-01T12-00-00-${id}.jsonl`);
  fs.writeFileSync(
    file,
    [
      record('session_meta', {
        id,
        timestamp: new Date(AT).toISOString(),
        cwd: '/synthetic/project',
        cli_version: 'synthetic',
      }),
      ...lines,
    ].join('\n') + '\n'
  );
  const adapter = new CodexAdapter(budget);
  const profile: LaunchProfile = {
    name: 'synthetic',
    harness: 'codex',
    source: { root, label: 'synthetic' },
    launch: { argv: ['codex'] },
    headless: null,
    resume: null,
    resumeHeadless: null,
    host: { kind: 'none', layout: 'none' },
    env: {},
    mcpServerName: 'hud',
    claimTransport: 'config_env',
    clientToolTimeoutMs: null,
    responseMarginMs: 1000,
    orphan_policy: 'continue',
    managedShellVerified: false,
  };
  const sourceId = await adapter.resolveSource(profile, {});
  const ref = { harness: 'codex' as const, sourceId, sessionId: id, threadId: null };
  return { adapter, ref, file, root };
}

/** Deterministic pinned snapshot observer; each read counts exact keys and bounded pages. */
function persisted(result: ReaderResult) {
  const handoff = result.checkpoint.recoveryIndex!;
  const spaces = new Map<string, Map<string, string>>();
  for (const entry of handoff.delta.entries) {
    validateCodexRecoveryIndexEntry(entry);
    let space = spaces.get(entry.namespace);
    if (!space) spaces.set(entry.namespace, (space = new Map()));
    if (entry.value === null) space.delete(entry.key);
    else space.set(entry.key, entry.value);
  }
  const reference = {
    indexId: 'synthetic-index',
    contentIdentity: 'synthetic-content',
    recoveryVersion: handoff.delta.recoveryVersion,
    boundary: checkpointBoundary(result.checkpoint),
  } as RecoveryIndexReference;
  const reads = { keys: 0, pages: 0 };
  const lookup: RecoveryIndexLookup = {
    reference,
    get(namespace, key) {
      reads.keys++;
      return spaces.get(namespace)?.get(key);
    },
    page(namespace, after, limit) {
      reads.pages++;
      return [...(spaces.get(namespace) ?? [])]
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([key]) => after === null || key > after)
        .slice(0, limit)
        .map(([key, value]) => ({ namespace, key, value }));
    },
  };
  handoff.committed?.(lookup);
  const { recoveryIndex: _handoff, ...inline } = result.checkpoint;
  const checkpoint = JSON.parse(JSON.stringify(inline)) as CodexCheckpoint;
  checkpoint.recoveryIndex = {
    delta: { recoveryVersion: reference.recoveryVersion, base: reference, entries: [] },
    lookup,
  };
  return { checkpoint, reads, spaces };
}

test('B12R ten large public arguments produce compact structured recovery and preserve restart semantics', async (t) => {
  const marker = 'PUBLIC_ARGUMENT_MATERIAL_';
  const f = await fixture(t, [
    usage(100, 0),
    record('event_msg', { type: 'task_started' }, 1000),
    ...Array.from({ length: 10 }, (_, n) =>
      call(`large-${n}`, 2000 + n, JSON.stringify({ command: marker + 'x'.repeat(700_000) }))
    ),
    record('event_msg', { type: 'exec_approval_request', call_id: 'large-0', command: ['echo', 'synthetic'] }, 3000),
  ]);
  const reader = f.adapter.open(f.ref);
  const first = await reader.read(budget);
  const cp = first.checkpoint as CodexCheckpoint;
  assert.equal(cp.readerVersion, CODEX_READER_VERSION);
  assert.equal(cp.codex.rollout.version, 3);
  assert.ok(inlineBytes(first) < 256 * 1024, `${inlineBytes(first)} inline bytes`);
  assert.ok(!JSON.stringify(first.checkpoint).includes(marker));
  assert.equal(cp.codex.rollout.state.runningCount, 10);
  assert.equal(cp.codex.rollout.state.rateToolsCount, 10);
  assert.equal(cp.codex.rollout.state.cachedResult!.toolActivity.recentCalls.length, 10);
  assert.ok(
    cp.codex.rollout.state.cachedResult!.toolActivity.recentCalls.every(
      (entry) => (entry as { argumentsMissing?: boolean }).argumentsMissing
    )
  );
  assert.equal(cp.codex.rollout.state.cachedResult!.pendingApproval!.callId, 'large-0');
  const durable = persisted(first);
  const restoredReader = f.adapter.open(f.ref, durable.checkpoint);
  fs.appendFileSync(
    f.file,
    [
      output('large-9', 4000, 'PUBLIC_LONG_OUTPUT_' + 'y'.repeat(100_000)),
      output('large-0', 5000),
      usage(200, 6000),
    ].join('\n') + '\n'
  );
  const warm = await reader.read(budget);
  const restored = await restoredReader.read(budget);
  assert.deepEqual(restored.observation.spent.tokens, warm.observation.spent.tokens);
  assert.deepEqual(restored.evidence?.action, warm.evidence?.action);
  assert.equal(restored.evidence?.action?.id, 'large-8');
  assert.equal(restored.observation.statusProjection.pendingReason, 'none');
  assert.deepEqual(
    (restored.checkpoint as CodexCheckpoint).codex.rollout.state.rateTracker,
    (warm.checkpoint as CodexCheckpoint).codex.rollout.state.rateTracker
  );
  assert.equal(durable.reads.pages, 0, 'normal restoration and late results use exact-key lookups');
  assert.ok(!JSON.stringify(restored.checkpoint).includes('PUBLIC_LONG_OUTPUT_'));
  t.diagnostic(
    `large arguments inline=${inlineBytes(first)} bytes, index delta=${Buffer.byteLength(JSON.stringify(first.checkpoint.recoveryIndex!.delta))} bytes`
  );
});

test('B12R thousands of unresolved calls and hud pairs remain exact without loading historical collections', async (t) => {
  const total = 2200;
  const f = await fixture(t, [
    usage(100, 0),
    ...Array.from({ length: total }, (_, n) => call(`pending-${n}`, 1000 + n, '{}', 'mcp__hud__delegate_spawn')),
  ]);
  const reader = f.adapter.open(f.ref);
  const first = await reader.read(budget);
  const cp = first.checkpoint as CodexCheckpoint;
  assert.equal(cp.codex.pendingHudCount, total);
  assert.equal(cp.codex.rollout.state.runningCount, total);
  assert.equal(cp.codex.rollout.state.rateToolsCount, total);
  assert.deepEqual(cp.parserState.openToolWaits, []);
  assert.ok(inlineBytes(first) < 256 * 1024);
  const durable = persisted(first);
  const restored = f.adapter.open(f.ref, durable.checkpoint);
  const noOp = await restored.read(budget);
  assert.equal(noOp.evidence?.action?.id, `pending-${total - 1}`);
  assert.equal(durable.reads.pages, 0);
  fs.appendFileSync(
    f.file,
    [
      output('pending-0', 5000, { linkId: 'link-oldest', runId: 'run-oldest' }),
      output(`pending-${total - 1}`, 6000, { linkId: 'link-latest', runId: 'run-latest' }),
    ].join('\n') + '\n'
  );
  const next = await restored.read(budget);
  assert.equal(next.evidence?.action?.id, `pending-${total - 2}`);
  assert.equal((next.checkpoint as CodexCheckpoint).codex.pendingHudCount, total - 2);
  assert.deepEqual(
    next.evidence?.linkEvidence.map((entry) => (entry.kind === 'tool_result' ? entry.linkId : '')),
    ['link-oldest', 'link-latest']
  );
  assert.equal(durable.reads.pages, 0, 'normal reads never enumerate the unresolved index');
  assert.ok(durable.reads.keys < 150, `${durable.reads.keys} exact key reads`);
  t.diagnostic(`unresolved=${total}, inline=${inlineBytes(first)} bytes, keyed reads=${durable.reads.keys}`);
});

test('B12R rate wait IDs remain distinct from parser running calls across turn reset and rejected timestamps', async (t) => {
  const f = await fixture(t, [
    usage(100, 0),
    call('older-turn', 1000),
    record('event_msg', { type: 'task_started' }, 2000),
    call('time-rejected', 1500),
    usage(200, 3000),
  ]);
  const first = await f.adapter.open(f.ref).read(budget);
  const cp = first.checkpoint as CodexCheckpoint;
  assert.equal(cp.codex.rollout.state.runningCount, 2);
  assert.equal(cp.codex.rollout.state.rateToolsCount, 0);
  assert.equal(cp.codex.rollout.state.rateTracker.lastAtMs, AT + 3000);
  const durable = persisted(first);
  fs.appendFileSync(
    f.file,
    [output('older-turn', 4000), output('time-rejected', 5000), usage(300, 6000)].join('\n') + '\n'
  );
  const restored = await f.adapter.open(f.ref, durable.checkpoint).read(budget);
  const legacy = new RolloutParser();
  legacy.setRolloutPath(f.file);
  const expected = await legacy.parse();
  assert.deepEqual((restored.checkpoint as CodexCheckpoint).codex.rollout.state.cachedResult!.outputRate, {
    ...expected!.outputRate!,
    sampledAt: expected!.outputRate!.sampledAt.getTime(),
  });
  assert.equal((restored.checkpoint as CodexCheckpoint).codex.rollout.state.runningCount, 0);
  assert.equal((restored.checkpoint as CodexCheckpoint).codex.rollout.state.rateToolsCount, 0);
});

test('B12R legal large plan advances with exact counts and explicit missing display material', async (t) => {
  const steps = Array.from({ length: 1200 }, (_, n) => ({
    step: `step-${n}-` + 'p'.repeat(600),
    status: n === 1199 ? 'in_progress' : 'pending',
  }));
  const planRecord = record('event_msg', { type: 'plan_update', plan: steps }, 1000);
  assert.ok(Buffer.byteLength(planRecord) < 1024 * 1024);
  const f = await fixture(t, [planRecord]);
  const live = new RolloutParser();
  live.setRolloutPath(f.file);
  assert.equal((await live.parse())!.planProgress!.steps.length, 1200, 'legacy material remains unchanged');
  const first = await f.adapter.open(f.ref).read(budget);
  const cp = first.checkpoint as CodexCheckpoint;
  assert.equal(cp.offset, fs.statSync(f.file).size);
  assert.equal(first.observation.coverage.state, 'complete');
  assert.equal(first.evidence?.caps.codex?.plan?.steps.length, 1200, 'live facade output remains full');
  assert.equal(cp.codex.rollout.state.cachedResult!.planProgress!.totalSteps, 1200);
  assert.equal(cp.codex.rollout.state.cachedResult!.planProgress!.steps.length, 32);
  assert.equal(cp.codex.rollout.state.materialMissing!.planSteps, 1168);
  assert.equal(cp.codex.rollout.state.materialMissing!.planText, true);
  assert.ok(cp.codex.rollout.state.cachedResult!.planProgress!.steps.at(-1)!.step.startsWith('step-1199-'));
  assert.ok(inlineBytes(first) < 256 * 1024);
  const durable = persisted(first);
  const restarted = await f.adapter.open(f.ref, durable.checkpoint).read(budget);
  assert.equal(restarted.evidence?.progress?.value?.total, 1200);
  assert.deepEqual(
    (restarted.checkpoint as CodexCheckpoint).codex.rollout.state.materialMissing,
    cp.codex.rollout.state.materialMissing
  );
  t.diagnostic(`legal plan record=${Buffer.byteLength(planRecord)} bytes, inline=${inlineBytes(first)} bytes`);
});

test('B12R native validation rejects unknown material fields and old V8, with stable no-op recovery', async (t) => {
  const f = await fixture(t, [usage(100, 0), call('open', 1000)]);
  const reader = f.adapter.open(f.ref);
  const first = await reader.read(budget);
  const durable = persisted(first);
  const second = await reader.read(budget);
  const { recoveryIndex: _first, ...a } = first.checkpoint;
  const { recoveryIndex: _second, ...b } = second.checkpoint;
  assert.deepEqual(a, b);
  assert.equal(second.checkpoint.recoveryIndex!.delta.entries.length, 0);
  const native = JSON.parse(JSON.stringify((first.checkpoint as CodexCheckpoint).codex.rollout));
  native.state.cachedResult.toolActivity.recentCalls[0].arguments = { code: 'forbidden' };
  assert.throws(() => validateRolloutRecovery(native), /invalid_rollout_checkpoint/);
  const old = JSON.parse(JSON.stringify(durable.checkpoint));
  old.readerVersion = 'codex-facade-3';
  old.codex.rollout = {
    version: 2,
    runtime: process.versions.v8,
    offset: old.offset,
    fileIdentity: `${old.fileId.dev}:${old.fileId.inode}`,
    payload: '',
  };
  assert.throws(() => f.adapter.open(f.ref, old), /unsupported_codex_checkpoint/);
});

test('B12R historical tool counters and subagent metadata recover only touched keys', async (t) => {
  const total = 1100;
  const agents = Array.from({ length: total }, (_, n) => ({ thread_id: `agent-${n}`, agent_nickname: `worker-${n}` }));
  const f = await fixture(t, [
    ...Array.from({ length: total }, (_, n) => [
      call(`tool-${n}`, 1000 + n * 2, '{}', `tool_name_${n}`),
      output(`tool-${n}`, 1001 + n * 2),
    ]).flat(),
    record(
      'event_msg',
      {
        type: 'item_completed',
        item: {
          type: 'CollabAgentToolCall',
          tool: 'spawn_agent',
          receiver_agents: agents,
          model: 'model-a',
          effort: 'high',
          prompt: 'synthetic task',
        },
      },
      4000
    ),
  ]);
  const first = await f.adapter.open(f.ref).read(budget);
  const cp = first.checkpoint as CodexCheckpoint;
  assert.equal(cp.codex.rollout.state.typeCount, total);
  assert.equal(cp.codex.rollout.state.subagentCount, total);
  assert.deepEqual(cp.codex.rollout.state.cachedResult!.subagents, []);
  assert.deepEqual(cp.codex.rollout.state.cachedResult!.toolActivity.callsByType, {});
  const durable = persisted(first);
  fs.appendFileSync(
    f.file,
    [
      call('repeat', 5000, '{}', 'tool_name_0'),
      output('repeat', 5001),
      record(
        'event_msg',
        {
          type: 'item_completed',
          item: {
            type: 'CollabAgentToolCall',
            tool: 'wait',
            receiver_thread_ids: ['agent-0'],
            agents_states: { 'agent-0': { completed: true } },
          },
        },
        6000
      ),
    ].join('\n') + '\n'
  );
  const next = await f.adapter.open(f.ref, durable.checkpoint).read(budget);
  const entries = next.checkpoint.recoveryIndex!.delta.entries;
  assert.equal(
    entries.find((entry) => entry.namespace === 'codex.tool-types' && entry.key === 'tool_name_0')!.value,
    '2'
  );
  const agent = JSON.parse(
    entries.find((entry) => entry.namespace === 'codex.subagents' && entry.key === 'agent-0')!.value!
  );
  assert.equal(agent.status, 'completed');
  assert.equal(agent.model, 'model-a');
  assert.equal(agent.effort, 'high');
  assert.equal(agent.startedAt, AT + 4000);
  assert.equal(agent.lastActivityAt, AT + 6000);
  assert.equal((next.checkpoint as CodexCheckpoint).codex.rollout.state.typeCount, total);
  assert.equal((next.checkpoint as CodexCheckpoint).codex.rollout.state.subagentCount, total);
  assert.equal(durable.reads.pages, 0);
  assert.ok(durable.reads.keys < 100, `${durable.reads.keys} exact key reads`);
  assert.ok(inlineBytes(next) < 256 * 1024);
});

for (const phase of ['record', 'fixed-eof', 'aggregate'] as const) {
  test(`B12R ${phase} index busy rejects without advancing or marking legitimate records malformed`, async (t) => {
    const f = await fixture(t, [usage(100, 0), call('existing', 1000, '{}', 'existing_tool')]);
    const first = await f.adapter.open(f.ref).read(budget);
    const durable = persisted(first);
    const base = durable.checkpoint.recoveryIndex!.lookup!;
    const failure = new ObservationStoreError('observation_busy');
    let busy = true;
    const lookup: RecoveryIndexLookup = {
      ...base,
      get(namespace, key) {
        if (
          busy &&
          (phase === 'aggregate'
            ? namespace === 'codex.tool-types' && key === 'new_tool'
            : namespace === 'codex.rate-tools' && key === 'new')
        )
          throw failure;
        return base.get(namespace, key);
      },
    };
    durable.checkpoint.recoveryIndex = { ...durable.checkpoint.recoveryIndex!, lookup };
    const reader = f.adapter.open(f.ref, durable.checkpoint);
    const lines =
      phase === 'fixed-eof'
        ? [usage(200, 2000), output('existing', 3000), call('new', 4000, '{}', 'new_tool')]
        : [usage(200, 2000), call('new', 3000, '{}', 'new_tool'), output('existing', 4000)];
    fs.appendFileSync(f.file, lines.join('\n') + (phase === 'fixed-eof' ? '' : '\n'));
    await assert.rejects(reader.read(budget), (error: unknown) => error === failure);
    busy = false;
    const unchanged = await reader.read({ maxBytes: 0, maxRecords: 0, budgetMs: 0 });
    const checkpoint = unchanged.checkpoint as CodexCheckpoint;
    assert.equal(checkpoint.offset, first.checkpoint.offset);
    assert.equal(checkpoint.codex.rollout.state.cachedResult!.toolActivity.totalCalls, 1);
    assert.equal(unchanged.observation.spent.tokens.value!.output, 100);
    assert.deepEqual(checkpoint.parserState.skipped, first.checkpoint.parserState.skipped);
    assert.deepEqual(checkpoint.parserState.gaps, first.checkpoint.parserState.gaps);
    assert.equal(
      unchanged.checkpoint.recoveryIndex!.delta.entries.length,
      0,
      'failed slice never mutates the root recovery index'
    );
    const next = await reader.read(budget);
    assert.equal(next.checkpoint.offset, fs.statSync(f.file).size);
    assert.equal(next.observation.spent.tokens.value!.output, 200);
    assert.equal((next.checkpoint as CodexCheckpoint).codex.rollout.state.cachedResult!.toolActivity.totalCalls, 2);
    assert.equal((next.checkpoint as CodexCheckpoint).codex.rollout.state.runningCount, 1);
    assert.equal(next.evidence!.action!.id, 'new');
    assert.deepEqual(next.checkpoint.parserState.skipped, first.checkpoint.parserState.skipped);
    assert.deepEqual(next.checkpoint.parserState.gaps, first.checkpoint.parserState.gaps);
  });
}

test('B12R lookup TypeErrors and malformed indexed metadata propagate rather than masquerading as source records', async (t) => {
  const f = await fixture(t, [call('old', 1000)]);
  for (const failure of [
    new TypeError('synthetic metadata unavailable'),
    new SyntaxError('synthetic corrupt metadata'),
  ]) {
    const first = await f.adapter.open(f.ref).read(budget);
    const durable = persisted(first);
    const base = durable.checkpoint.recoveryIndex!.lookup!;
    let fail = true;
    durable.checkpoint.recoveryIndex = {
      ...durable.checkpoint.recoveryIndex!,
      lookup: {
        ...base,
        get(namespace, key) {
          if (fail && namespace === 'codex.running' && key === 'old') throw failure;
          return base.get(namespace, key);
        },
      },
    };
    const reader = f.adapter.open(f.ref, durable.checkpoint);
    await assert.rejects(reader.read(budget), (error: unknown) => error === failure);
    fail = false;
    const retried = await reader.read(budget);
    assert.equal(retried.evidence!.action!.id, 'old');
    assert.deepEqual(retried.checkpoint.parserState.skipped, {});
  }
});

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const sqliteSupported = nodeMajor >= 24 || (nodeMajor === 22 && nodeMinor >= 13);
for (const reset of ['truncate', 'replace'] as const) {
  test(
    `B12R physical ${reset} survives unpublished compaction and JSON restart before real publication`,
    { skip: sqliteSupported ? false : 'requires observation SQLite runtime' },
    async (t) => {
      const f = await fixture(t, [
        usage(100, 0),
        ...Array.from({ length: 12 }, (_, n) => call(`old-${n}`, 1000 + n, '{}', 'mcp__hud__delegate_spawn')),
      ]);
      const store = await openObservationStore({
        hudHome: path.join(f.root, 'hud'),
        sourceId: f.ref.sourceId,
        now: () => AT,
      });
      t.after(() => store.close());
      const lease = store.acquire(f.ref, 'synthetic');
      const publish = (result: ReaderResult, seq: number) => {
        const cp = result.checkpoint;
        const stamp = {
          ref: cp.ref,
          sourceGeneration: cp.sourceGeneration,
          seqDomain: 'b12r-codex-reset',
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
            ruleVersion: 'synthetic',
            sourceGeneration: cp.sourceGeneration,
            episodeAnchor: null,
            stateKey: 'unknown',
            stateSince: null,
            stateSinceBasis: 'unknown',
          },
          notices: [],
        };
        store.publish(
          {
            commit,
            previousCommitSeq: seq - 1,
            boundary: witnessObservationBoundary(cp, summary, checkpointBoundary(cp)),
          },
          lease
        );
      };
      const first = await f.adapter.open(f.ref).read(budget);
      publish(first, 1);
      const projection = store.readProjection(f.ref)!;
      const recovery = store.readRecovery(projection, budget) as ObservationRecovery;
      const reader = f.adapter.open(f.ref, recovery.checkpoint);
      const replacement =
        [
          record('session_meta', {
            id: f.ref.sessionId,
            timestamp: new Date(AT).toISOString(),
            cwd: '/synthetic/project',
            cli_version: 'synthetic',
          }),
          usage(50, 5000),
          record('event_msg', { type: 'context_compacted' }, 6000),
          usage(60, 7000),
        ].join('\n') + '\n';
      if (reset === 'replace') {
        fs.writeFileSync(`${f.file}.replacement`, replacement);
        fs.renameSync(`${f.file}.replacement`, f.file);
      } else fs.writeFileSync(f.file, replacement);
      const resetSlice = await reader.read({ ...budget, maxRecords: 1 });
      assert.equal(resetSlice.checkpoint.resetReason, reset === 'replace' ? 'file_changed' : 'truncated');
      assert.equal(store.readProjection(f.ref)!.commitSeq, 1, 'reset slice remains unpublished');
      const continuation =
        reset === 'replace' ? f.adapter.open(f.ref, JSON.parse(JSON.stringify(resetSlice.checkpoint))) : reader;
      const beforeCompact = await continuation.read({ ...budget, maxRecords: 1 });
      assert.equal(beforeCompact.checkpoint.resetReason, reset === 'replace' ? 'file_changed' : 'truncated');
      const compacted = await continuation.read({ ...budget, maxRecords: 1 });
      assert.equal(compacted.checkpoint.parserState.compactBoundary, String(AT + 6000));
      assert.ok(compacted.checkpoint.sourceGeneration > resetSlice.checkpoint.sourceGeneration);
      assert.equal(
        compacted.checkpoint.resetReason,
        reset === 'replace' ? 'file_changed' : 'truncated',
        'compaction retains unpublished physical reset provenance'
      );
      const restarted = f.adapter.open(f.ref, JSON.parse(JSON.stringify(compacted.checkpoint)));
      const next = await restarted.read(budget);
      assert.equal(next.checkpoint.recoveryIndex!.delta.base, null);
      assert.ok(next.checkpoint.sourceGeneration > first.checkpoint.sourceGeneration);
      assert.equal(next.checkpoint.resetReason, reset === 'replace' ? 'file_changed' : 'truncated');
      assert.equal(next.observation.spent.tokens.value!.output, 60);
      assert.equal(next.evidence?.action, undefined);
      assert.equal((next.checkpoint as CodexCheckpoint).codex.pendingHudCount, 0);
      assert.equal((next.checkpoint as CodexCheckpoint).codex.rollout.state.runningCount, 0);
      assert.equal((next.checkpoint as CodexCheckpoint).codex.rollout.state.typeCount, 0);
      publish(next, 2);
      const acknowledged = await restarted.read(budget);
      assert.equal(acknowledged.checkpoint.resetReason, undefined, 'successful publication retires reset provenance');
      const latest = store.readRecovery(store.readProjection(f.ref)!, budget) as ObservationRecovery;
      assert.equal(latest.checkpoint.recoveryIndex!.lookup!.get('codex.running', 'old-0'), undefined);
      assert.equal(latest.checkpoint.recoveryIndex!.lookup!.get('codex.hud-pending', 'old-0'), undefined);
      assert.equal(
        latest.checkpoint.recoveryIndex!.lookup!.get('codex.tool-types', 'mcp__hud__delegate_spawn'),
        undefined
      );
    }
  );
}

test('B12R facade recovery always requires its exact index, including completed tools and historical aggregates', async (t) => {
  const f = await fixture(t, [call('done', 1000, '{}', 'completed_tool'), output('done', 2000)]);
  const result = await f.adapter.open(f.ref).read(budget);
  const { recoveryIndex: _index, ...inline } = result.checkpoint;
  const cp = inline as CodexCheckpoint;
  assert.equal(cp.codex.rollout.state.runningCount, 0);
  assert.equal(cp.codex.rollout.state.rateToolsCount, 0);
  assert.equal(cp.codex.pendingHudCount, 0);
  assert.equal(cp.codex.rollout.state.typeCount, 1);
  assert.throws(() => f.adapter.open(f.ref, cp), /missing_codex_recovery_index/);
  const parser = new RolloutParser();
  parser.setRolloutPath(f.file);
  assert.throws(() => parser.restoreCheckpoint(cp.codex.rollout), /missing_codex_recovery_index/);
  const empty = await fixture(t, []);
  const emptyResult = await empty.adapter.open(empty.ref).read(budget);
  const { recoveryIndex: _emptyIndex, ...emptyInline } = emptyResult.checkpoint;
  assert.throws(() => empty.adapter.open(empty.ref, emptyInline), /missing_codex_recovery_index/);
});

test('B12R older reset publication acknowledgements cannot clear newer compaction or physical-reset provenance', async (t) => {
  const f = await fixture(t, [usage(100, 0), ...Array.from({ length: 12 }, (_, n) => call(`old-${n}`, 1000 + n))]);
  const first = await f.adapter.open(f.ref).read(budget);
  const original = persisted(first);
  const reader = f.adapter.open(f.ref, original.checkpoint);
  const meta = record('session_meta', {
    id: f.ref.sessionId,
    timestamp: new Date(AT).toISOString(),
    cwd: '/synthetic/project',
    cli_version: 'synthetic',
  });
  fs.writeFileSync(f.file, [meta, record('event_msg', { type: 'context_compacted' }, 6000)].join('\n') + '\n');
  const physical = await reader.read({ ...budget, maxRecords: 1 });
  const compacted = await reader.read(budget);
  assert.equal(compacted.checkpoint.resetReason, 'truncated');
  assert.ok(compacted.checkpoint.sourceGeneration > physical.checkpoint.sourceGeneration);
  persisted(physical);
  const afterOldAck = await reader.read({ maxBytes: 0, maxRecords: 0, budgetMs: 0 });
  assert.equal(afterOldAck.checkpoint.resetReason, 'truncated');
  assert.equal(afterOldAck.checkpoint.sourceGeneration, compacted.checkpoint.sourceGeneration);
  fs.writeFileSync(`${f.file}.next`, meta + '\n');
  fs.renameSync(`${f.file}.next`, f.file);
  const secondPhysical = await reader.read(budget);
  assert.equal(secondPhysical.checkpoint.resetReason, 'file_changed');
  assert.ok(secondPhysical.checkpoint.sourceGeneration > compacted.checkpoint.sourceGeneration);
  persisted(compacted);
  const afterSecondOldAck = await reader.read({ maxBytes: 0, maxRecords: 0, budgetMs: 0 });
  assert.equal(afterSecondOldAck.checkpoint.resetReason, 'file_changed');
  assert.equal(afterSecondOldAck.checkpoint.recoveryIndex!.delta.base, null);
});

test('B12R unpublished semantic compaction retains provenance over a published base after JSON restart', async (t) => {
  const f = await fixture(t, [usage(100, 0)]);
  const first = await f.adapter.open(f.ref).read(budget);
  const published = persisted(first);
  const reader = f.adapter.open(f.ref, published.checkpoint);
  fs.appendFileSync(f.file, record('event_msg', { type: 'context_compacted' }, 1000) + '\n');
  const compacted = await reader.read(budget);
  assert.equal(compacted.checkpoint.resetReason, 'compaction');
  assert.ok(compacted.checkpoint.recoveryIndex!.delta.base);
  assert.ok(
    compacted.checkpoint.sourceGeneration > compacted.checkpoint.recoveryIndex!.delta.base!.boundary.sourceGeneration
  );
  const restartedCheckpoint = JSON.parse(JSON.stringify(compacted.checkpoint)) as CodexCheckpoint;
  // The collector reattaches the exact pinned base lookup after decoding the JSON checkpoint.
  restartedCheckpoint.recoveryIndex = {
    ...restartedCheckpoint.recoveryIndex!,
    lookup: published.checkpoint.recoveryIndex!.lookup,
  };
  const restarted = f.adapter.open(f.ref, restartedCheckpoint);
  const beforeAck = await restarted.read({ maxBytes: 0, maxRecords: 0, budgetMs: 0 });
  assert.equal(beforeAck.checkpoint.offset, compacted.checkpoint.offset);
  assert.equal(beforeAck.checkpoint.sourceGeneration, compacted.checkpoint.sourceGeneration);
  assert.equal(beforeAck.checkpoint.resetReason, 'compaction');
  assert.equal(
    beforeAck.checkpoint.recoveryIndex!.delta.base!.boundary.sourceGeneration,
    first.checkpoint.sourceGeneration
  );
  persisted(beforeAck);
  const acknowledged = await restarted.read({ maxBytes: 0, maxRecords: 0, budgetMs: 0 });
  assert.equal(acknowledged.checkpoint.resetReason, undefined);
  assert.equal(
    acknowledged.checkpoint.recoveryIndex!.delta.base!.boundary.sourceGeneration,
    compacted.checkpoint.sourceGeneration
  );
});
