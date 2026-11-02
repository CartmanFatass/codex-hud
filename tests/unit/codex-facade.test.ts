import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { CodexAdapter, CODEX_RECOVERY_VERSION, type CodexCheckpoint } from '../../src/harness/codex/index.js';
import { observeLinkEvidence, LINK_EVIDENCE_LIMIT, type LinkScanState } from '../../src/harness/codex/link-evidence.js';
import { RolloutParser } from '../../src/collectors/rollout.js';
import { RecoveryIndexOverlay } from '../../src/core/checkpoint.js';
import { TreeScanStore, SCAN_VERSION, SAVE_MIN_BYTES } from '../../src/collectors/tree-scan-store.js';
import {
  buildSubagentTreeYielding,
  resetSubagentLinkCache,
  useTreeScanStore,
  flushTreeScans,
} from '../../src/collectors/subagent-tree.js';
import type { LaunchProfile } from '../../src/core/types/capabilities.js';
import type {
  BindContext,
  ReaderBudget,
  ReaderResult,
  SessionReader,
} from '../../src/core/interfaces/harness-adapter.js';
import type { SessionRef } from '../../src/core/types/identity.js';
import type { UniversalSnapshotV3 } from '../../src/core/interfaces/snapshot-v3.js';
import { fixtureUniversalSnapshotV3 } from '../fixtures/contracts/observation-export.js';
import {
  ROOT,
  CHILD,
  GRANDCHILD,
  FORK,
  TIME,
  meta,
  row,
  call,
  output,
  initial,
  resumed,
} from '../fixtures/codex-facade/rollouts.js';

/**
 * Deterministic reader budget: CodexAdapter caps every read at its constructor budget, so tests
 * construct adapters with a slice large enough to consume a whole fixture in one read. Progress
 * then depends on bytes, not on how much CPU a loaded machine gives the 20 ms production slice.
 */
const TEST_BUDGET: ReaderBudget = { maxBytes: 4 * 1024 * 1024, maxRecords: 2000, budgetMs: 60_000 };
const DRAIN_DEADLINE_MS = 180_000;
const DRAIN_STALL_READS = 3;

function toolResults(result: ReaderResult) {
  return result.evidence?.linkEvidence.filter((entry) => entry.kind === 'tool_result') ?? [];
}

function profile(root: string): LaunchProfile {
  return {
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
}
async function fixture(t: test.TestContext, lines = initial) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-facade-'));
  t.after(() => {
    useTreeScanStore(undefined);
    resetSubagentLinkCache();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const today = new Date();
  const directory = path.join(
    root,
    'sessions',
    String(today.getFullYear()),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0')
  );
  fs.mkdirSync(directory, { recursive: true });
  const fileFor = (id: string) => path.join(directory, `rollout-2026-03-01T12-00-00-${id}.jsonl`);
  const file = fileFor(ROOT);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const adapter = new CodexAdapter(TEST_BUDGET);
  const sourceId = await adapter.resolveSource(profile(root), {});
  const ref: SessionRef = { harness: 'codex', sourceId, sessionId: ROOT, threadId: null };
  const context: BindContext = {
    sourceId,
    explicitSession: null,
    registry: [],
    locator: null,
    processes: [],
    cwd: '/synthetic/project',
    startedAt: TIME,
  };
  return { root, file, fileFor, adapter, ref, context };
}
async function drain(
  reader: SessionReader,
  budget: ReaderBudget = TEST_BUDGET,
  options: { timeoutMs?: number; now?: () => number } = {}
): Promise<ReaderResult> {
  const now = options.now ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? DRAIN_DEADLINE_MS;
  const deadline = now() + timeoutMs;
  let previous: ReaderResult | undefined;
  let stalled = 0;
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('reader did not catch up before deadline');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: ReaderResult;
    try {
      result = await Promise.race([
        reader.read(budget),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('reader did not catch up before deadline')), remaining);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    // A terminal response that arrives after the deadline must fail too.
    if (now() >= deadline) throw new Error('reader did not catch up before deadline');
    if (previous) {
      assert.ok(result.checkpoint.offset >= previous.checkpoint.offset, 'reader checkpoint offset never regresses');
      const cursor = (r: ReaderResult) =>
        r.checkpoint.parserState.discardOffset ?? r.checkpoint.offset + (r.checkpoint.parserState.tailBytesSeen ?? 0);
      stalled = cursor(result) === cursor(previous) ? stalled + 1 : 0;
      if (stalled >= DRAIN_STALL_READS)
        throw new Error(
          `reader made no progress across ${DRAIN_STALL_READS} reads: ${result.observation.coverage.remainingBytes ?? 'unknown'} bytes remain`
        );
    }
    if (result.observation.coverage.state !== 'catching_up') return result;
    previous = result;
  }
}

test('A6 observation fits the shared nullable-root v3 fixture and full node shape', async (t) => {
  const f = await fixture(t);
  const read = await drain(f.adapter.open(f.ref));
  const snapshot: UniversalSnapshotV3 = fixtureUniversalSnapshotV3(read.observation);
  assert.equal(snapshot.universal.rootRef, null);
  assert.deepEqual(snapshot.universal.tree.counts, { confirmedSessions: 1, delegationIntents: 1, jobs: 0 });
  const node = snapshot.universal.tree.nodes[0];
  assert.deepEqual(node.nodeIdentity, { kind: 'session', ref: f.ref });
  assert.deepEqual([node.parent, node.links, node.candidates, node.host, node.actions], [null, [], [], null, []]);
});

test('Codex source is explicit and verified; binding needs a unique full ref, with no managed identity', async (t) => {
  const f = await fixture(t);
  const binding = await f.adapter.bind(f.context);
  assert.deepEqual(binding, { sessionRef: f.ref, harness: null, occupantGeneration: null, managed: null });
  fs.writeFileSync(f.fileFor(FORK), meta(FORK) + '\n');
  assert.equal(await f.adapter.bind(f.context), null);
  assert.deepEqual((await f.adapter.bind({ ...f.context, explicitSession: f.ref }))?.sessionRef, f.ref);
  assert.equal(await f.adapter.bind({ ...f.context, explicitSession: { ...f.ref, sourceId: 'f'.repeat(64) } }), null);
  await assert.rejects(
    f.adapter.resolveSource(profile(f.root), { CODEX_HOME: path.dirname(f.root) }),
    /source_mismatch/
  );
  await assert.rejects(f.adapter.resolveSource(profile(path.join(f.root, 'missing')), {}));
});

test('budgeted parser checkpoints restore exact merge/tool/rate state after JSON round trip', async (t) => {
  const f = await fixture(t);
  const reader = f.adapter.open(f.ref);
  const first = await reader.read({ maxBytes: 200, maxRecords: 2, budgetMs: TEST_BUDGET.budgetMs });
  assert.ok(first.checkpoint.offset <= 200);
  assert.equal(first.observation.coverage.state, 'partial');
  assert.equal(first.observation.coverage.reason, 'record_needs_larger_slice');
  let result = first;
  const actionDeadline = performance.now() + DRAIN_DEADLINE_MS;
  while (result.evidence?.action?.id !== 'spawn-call') {
    assert.ok(performance.now() < actionDeadline, 'action search respects deadline');
    result = await reader.read({ maxBytes: 4096, maxRecords: 1, budgetMs: TEST_BUDGET.budgetMs });
  }
  const checkpoint = JSON.parse(JSON.stringify(result.checkpoint)) as CodexCheckpoint;
  assert.deepEqual(checkpoint.parserState.openToolWaits, []);
  assert.ok(
    checkpoint.recoveryIndex?.delta.entries.some(
      (entry) => entry.namespace === 'codex.running' && entry.key === 'spawn-call'
    )
  );
  const restored = await drain(f.adapter.open(f.ref, checkpoint));
  const legacy = new RolloutParser();
  legacy.setRolloutPath(f.file);
  const expected = await legacy.parse();
  assert.equal(restored.evidence?.action, undefined);
  assert.equal(restored.evidence?.linkEvidence.length, 1);
  assert.equal(restored.evidence?.model.value?.id, expected?.session?.model);
  assert.equal(
    restored.evidence?.reports[0].text,
    expected?.transcript.find((entry) => entry.role === 'assistant')?.text
  );
  assert.equal(restored.evidence?.progress?.value?.done, expected?.planProgress?.completedSteps);
  assert.ok(!JSON.stringify(restored.evidence).includes('PRIVATE_SENTINEL'));
  assert.ok(!JSON.stringify(restored.evidence).includes('DO_NOT_RETAIN'));
  assert.equal(restored.observation.spent.costUsd.value, null);
  assert.equal(restored.observation.spent.costUsd.quality, 'unknown');
  assert.strictEqual(restored.observation, restored.evidence?.observation);
  const invalid = { ...checkpoint, readerVersion: 'future' };
  assert.throws(() => f.adapter.open(f.ref, invalid), /unsupported_codex_checkpoint/);
  assert.throws(() => f.adapter.open({ ...f.ref, sessionId: FORK }, checkpoint), /unsupported_codex_checkpoint/);
});

test('reader honors record/zero budgets, restores split UTF-8/CRLF, and consumes a complete final record', async (t) => {
  const f = await fixture(t, [meta()]);
  const message = row('response_item', {
    type: 'message',
    role: 'assistant',
    channel: 'final',
    content: [{ type: 'output_text', text: '合成结果' }],
  });
  fs.writeFileSync(f.file, meta() + '\r\n' + message);
  const reader = f.adapter.open(f.ref);
  const zero = await reader.read({ maxBytes: 0, maxRecords: 0, budgetMs: 0 });
  assert.equal(zero.checkpoint.offset, 0);
  const first = await reader.read({ maxBytes: 4096, maxRecords: 1, budgetMs: TEST_BUDGET.budgetMs });
  assert.equal(first.checkpoint.offset, Buffer.byteLength(meta() + '\r\n'));
  const bytes = Buffer.from(message);
  const splitAt = bytes.indexOf(Buffer.from('合')) + 1;
  const split = await reader.read({ maxBytes: splitAt, maxRecords: 1, budgetMs: TEST_BUDGET.budgetMs });
  assert.deepEqual(split.checkpoint.parserState.pendingBytes, []);
  assert.equal(split.checkpoint.offset, first.checkpoint.offset);
  assert.ok(split.checkpoint.parserState.tailBytesSeen! > 0);
  assert.equal(split.continuation?.kind, 'record_needs_larger_slice');
  const restored = await drain(f.adapter.open(f.ref, JSON.parse(JSON.stringify(split.checkpoint))));
  assert.equal(restored.evidence?.reports[0].text, '合成结果');
  assert.equal(restored.checkpoint.offset, fs.statSync(f.file).size);
  assert.equal(restored.observation.coverage.state, 'complete');
  assert.equal(
    (await reader.read({ maxBytes: 100, maxRecords: 0, budgetMs: TEST_BUDGET.budgetMs })).checkpoint.offset,
    split.checkpoint.offset
  );
});

test('resumed sessions keep identity and cumulative totals, while forked threads remain distinct', async (t) => {
  const f = await fixture(t);
  const reader = f.adapter.open(f.ref);
  const before = await drain(reader);
  fs.appendFileSync(f.file, resumed.join('\n') + '\n');
  const after = await drain(reader);
  assert.deepEqual(after.evidence?.ref, before.evidence?.ref);
  assert.equal(toolResults(after)[1].runId, 'run-resumed');
  assert.equal(after.observation.spent.tokens.value?.input, 27000);
  assert.equal(after.evidence?.context.value?.used, 4000);
  assert.equal(after.evidence?.context.value?.afterCompaction, true);
  assert.equal(after.checkpoint.resetReason, 'compaction');
  fs.writeFileSync(f.fileFor(FORK), meta(FORK) + '\n');
  const fork = await drain(f.adapter.open({ ...f.ref, sessionId: FORK }));
  assert.equal(fork.evidence?.ref.sessionId, FORK);
  assert.deepEqual(fork.evidence?.linkEvidence, []);
  const usageAt = after.observation.spent.tokens.asOf;
  fs.appendFileSync(
    f.file,
    row(
      'event_msg',
      { type: 'token_count', info: { total_token_usage: { input_tokens: 27000, output_tokens: 1100 } } },
      13000
    ) + '\n'
  );
  assert.equal((await drain(reader)).observation.spent.tokens.asOf, usageAt);
});

test('children delegates native topology, returns only direct children, and caps preserve quota/goal/plan/todos', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.fileFor(CHILD), meta(CHILD, ROOT) + '\n');
  fs.writeFileSync(f.fileFor(GRANDCHILD), meta(GRANDCHILD, CHILD) + '\n');
  fs.writeFileSync(f.fileFor(FORK), meta(FORK) + '\n');
  const children = await f.adapter.children(f.ref);
  assert.deepEqual(children, [{ ...f.ref, sessionId: CHILD }]);
  const result = await drain(f.adapter.open(f.ref));
  assert.deepEqual(result.evidence?.native, children);
  assert.equal(result.evidence?.caps.codex?.quota?.primary?.usedPercent, 25);
  assert.deepEqual(result.evidence?.caps.codex?.goals, []);
  assert.equal(result.evidence?.caps.codex?.plan?.total, 2);
  assert.deepEqual(result.evidence?.caps.codex?.todos, []);
  assert.equal(result.evidence?.version, '0.synthetic');
  assert.equal(result.evidence?.model.value?.provider, 'openai');
});

test('link evidence requires an exact hud-mcp call/output pair, bounds state and never retains claims', () => {
  const state: LinkScanState = {};
  for (const line of [
    call('bad', 'exec_command'),
    output('bad'),
    row('event_msg', { type: 'function_call_output', call_id: 'x', output: { linkId: 'bad', runId: 'bad' } }),
    output('unpaired'),
  ])
    observeLinkEvidence(JSON.parse(line), state);
  assert.equal(state.linkEvidence, undefined);
  for (let n = 0; n < 105; n++) {
    observeLinkEvidence(JSON.parse(call(`call-${n}`)), state);
    observeLinkEvidence(JSON.parse(output(`call-${n}`)), state);
  }
  assert.equal((state.linkEvidence as unknown[] | undefined)?.length, LINK_EVIDENCE_LIMIT);
  for (let n = 0; n < 105; n++) observeLinkEvidence(JSON.parse(call(`pending-${n}`)), state);
  assert.equal(Object.keys(state.pendingHudCalls!).length, 105);
  assert.ok(!JSON.stringify(state).includes('DO_NOT_RETAIN'));
});

test('oversized/incomplete records remain bounded and gaps survive EOF and checkpoint recovery', async (t) => {
  const f = await fixture(t, [meta()]);
  fs.appendFileSync(f.file, 'x'.repeat(1024 * 1024 + 100));
  const partial = await drain(f.adapter.open(f.ref));
  assert.equal(partial.checkpoint.parserState.discardingOversize, true);
  assert.equal(partial.checkpoint.parserState.pendingBytes.length, 0);
  assert.deepEqual(partial.observation.coverage.gaps, ['oversize_unknown']);
  fs.appendFileSync(
    f.file,
    '\n' +
      row('response_item', {
        type: 'message',
        role: 'assistant',
        channel: 'final',
        content: [{ type: 'output_text', text: 'Recovered' }],
      }) +
      '\n'
  );
  const restored = await drain(f.adapter.open(f.ref, JSON.parse(JSON.stringify(partial.checkpoint))));
  assert.equal(restored.evidence?.reports[0].text, 'Recovered');
  assert.equal(restored.observation.coverage.state, 'partial');
  assert.deepEqual(restored.observation.coverage.gaps, ['oversize_unknown']);
});

test('truncation and inode replacement reset checkpoint lineage and old evidence', async (t) => {
  const f = await fixture(t);
  const reader = f.adapter.open(f.ref);
  const first = await drain(reader);
  fs.writeFileSync(f.file, meta() + '\n');
  const truncated = await drain(reader);
  assert.equal(truncated.checkpoint.resetReason, 'truncated');
  assert.ok(truncated.checkpoint.sourceGeneration > first.checkpoint.sourceGeneration);
  assert.deepEqual(truncated.evidence?.linkEvidence, []);
  const replacement = f.file + '.new';
  fs.writeFileSync(replacement, meta() + '\n' + call() + '\n' + output() + '\n');
  fs.renameSync(replacement, f.file);
  const replaced = await drain(reader);
  assert.equal(replaced.checkpoint.resetReason, 'file_changed');
  assert.ok(replaced.checkpoint.sourceGeneration > truncated.checkpoint.sourceGeneration);
  assert.equal(replaced.evidence?.linkEvidence.length, 1);
});

test('scan version 4 persists bounded pending calls and evidence across scanner restart, rejects v3', async (t) => {
  const f = await fixture(t, [meta()]);
  fs.writeFileSync(
    f.fileFor(CHILD),
    meta(CHILD, ROOT) +
      '\n' +
      row('event_msg', { type: 'synthetic_padding', text: 'x'.repeat(SAVE_MIN_BYTES) }) +
      '\n' +
      call() +
      '\n'
  );
  const directory = path.join(f.root, 'scan');
  const store = new TreeScanStore(directory);
  useTreeScanStore(store);
  const listing = () =>
    [f.fileFor(CHILD)].map((file) => {
      const stat = fs.statSync(file);
      return {
        path: file,
        sessionId: CHILD,
        timestamp: new Date(TIME),
        size: stat.size,
        modifiedAt: stat.mtime,
        ino: stat.ino,
      };
    });
  await buildSubagentTreeYielding(ROOT, [], 3, TIME, listing());
  flushTreeScans();
  const saved = store.load(f.fileFor(CHILD))!;
  assert.equal(SCAN_VERSION, 4);
  assert.equal(
    saved.fields.pendingHudCalls && (saved.fields.pendingHudCalls as Record<string, string>)['spawn-call'],
    'mcp__hud__delegate_spawn'
  );
  resetSubagentLinkCache();
  fs.appendFileSync(f.fileFor(CHILD), output() + '\n');
  await buildSubagentTreeYielding(ROOT, [], 3, TIME + 1000, listing());
  flushTreeScans();
  assert.equal((store.load(f.fileFor(CHILD))?.fields.linkEvidence as unknown[]).length, 1);
  const cacheFile = path.join(
    directory,
    createHash('sha1').update(f.fileFor(CHILD)).digest('hex').slice(0, 20) + '.json'
  );
  fs.writeFileSync(cacheFile, JSON.stringify({ ...saved, version: 3 }));
  assert.equal(store.load(f.fileFor(CHILD)), undefined);
});

test('registry bindings require the same known occupant and complete source-scoped identity', async (t) => {
  const f = await fixture(t);
  const process = {
    pid: 1234,
    proc_start: 'synthetic-start',
    boot_id: 'synthetic-boot',
    pid_domain: 'synthetic-domain',
  };
  const locator = {
    kind: 'tmux' as const,
    server: 'synthetic-server',
    session: 'synthetic-session',
    pane: '%123',
    process,
    occupantGeneration: 7,
  };
  const record = {
    locator,
    binding: null,
    evidence: {
      origin: 'registry' as const,
      ref: f.ref,
      sourceGeneration: 11,
      validity: 'current' as const,
      eventAt: TIME,
      observedAt: TIME + 100,
      lastSuccessfulReadAt: TIME + 100,
      value: {
        server: locator.server,
        occupant: f.ref,
        completionSeq: null,
        sourceClockAt: TIME,
        activity: 'working' as const,
        pendingReason: 'none' as const,
      },
    },
  };
  const selected = await f.adapter.bind({ ...f.context, cwd: null, locator, processes: [process], registry: [record] });
  assert.equal(selected?.occupantGeneration, 7);
  assert.equal(selected?.managed, null);
  assert.deepEqual(selected?.harness, process);
  assert.equal(
    await f.adapter.bind({
      ...f.context,
      cwd: null,
      locator: { ...locator, occupantGeneration: null },
      registry: [record],
    }),
    null
  );
  assert.equal(
    await f.adapter.bind({
      ...f.context,
      cwd: null,
      locator,
      registry: [{ ...record, evidence: { ...record.evidence, validity: 'stale' } }],
    }),
    null
  );
  const other = { ...f.ref, sessionId: FORK };
  assert.equal(
    await f.adapter.bind({
      ...f.context,
      cwd: null,
      locator,
      registry: [
        record,
        {
          ...record,
          evidence: { ...record.evidence, ref: other, value: { ...record.evidence.value, occupant: other } },
        },
      ],
    }),
    null
  );
});

test('checkpoint restore preserves token-rate tool-wait union and concurrent reads serialize', async (t) => {
  const count = (tokens: number, offset: number) =>
    row(
      'event_msg',
      {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 1000, output_tokens: tokens },
          last_token_usage: { total_tokens: 2000 },
        },
      },
      offset
    );
  const f = await fixture(t, [
    meta(),
    count(100, 0),
    row('event_msg', { type: 'task_started' }, 1000),
    call(),
    output(),
    count(200, 5000),
  ]);
  const reader = f.adapter.open(f.ref);
  const [a, b] = await Promise.all([
    reader.read({ maxBytes: 4096, maxRecords: 2, budgetMs: TEST_BUDGET.budgetMs }),
    reader.read({ maxBytes: 4096, maxRecords: 2, budgetMs: TEST_BUDGET.budgetMs }),
  ]);
  assert.ok(b.checkpoint.offset > a.checkpoint.offset);
  assert.equal((b.checkpoint as CodexCheckpoint).codex.rollout.state.runningTail, 'spawn-call');
  assert.equal(b.checkpoint.parserState.rateBaseline?.outputTokens, 100);
  const restored = await drain(f.adapter.open(f.ref, JSON.parse(JSON.stringify(b.checkpoint))));
  const parser = new RolloutParser();
  parser.setRolloutPath(f.file);
  await parser.parse();
  const resumeParser = new RolloutParser();
  resumeParser.setRolloutPath(f.file);
  resumeParser.configureRecoveryIndex(
    new RecoveryIndexOverlay(CODEX_RECOVERY_VERSION, restored.checkpoint.recoveryIndex)
  );
  resumeParser.restoreCheckpoint((restored.checkpoint as CodexCheckpoint).codex.rollout);
  assert.deepEqual(resumeParser.getCached()?.outputRate, parser.getCached()?.outputRate);
  assert.equal(restored.stats?.recordsRead, 2);
  assert.ok(typeof restored.stats?.elapsedMs === 'number');
});

test('identical session IDs in two explicit sources do not cross-read, and custom hud server names are exact', async (t) => {
  const a = await fixture(t, [
    meta(),
    call('custom', 'mcp__custom_hud__delegate_whoami'),
    output('custom', 'run-custom'),
  ]);
  const b = await fixture(t, [meta(), call(), output('spawn-call', 'run-other-home')]);
  await a.adapter.resolveSource({ ...profile(a.root), mcpServerName: 'custom_hud' }, {});
  const first = await drain(a.adapter.open(a.ref));
  const second = await drain(b.adapter.open(b.ref));
  assert.notEqual(a.ref.sourceId, b.ref.sourceId);
  assert.equal(toolResults(first)[0].runId, 'run-custom');
  assert.equal(toolResults(second)[0].runId, 'run-other-home');
  assert.throws(() => a.adapter.open(b.ref), /unknown_codex_source/);
});

test('read statistics count fetched chunk bytes separately from the committed record cursor', async (t) => {
  const f = await fixture(t);
  const result = await f.adapter.open(f.ref).read({ maxBytes: 4096, maxRecords: 1, budgetMs: TEST_BUDGET.budgetMs });
  assert.equal(result.stats?.bytesRead, fs.statSync(f.file).size);
  assert.equal(result.checkpoint.offset, Buffer.byteLength(initial[0] + '\n'));
  assert.equal(result.stats?.recordsRead, 1);
  assert.ok(result.stats!.bytesRead > result.checkpoint.offset);
});

test('model/context clocks survive checkpoints and unrelated replies; baseline context is estimated', async (t) => {
  const f = await fixture(t);
  const first = await drain(f.adapter.open(f.ref));
  assert.equal(first.evidence?.model.asOf, TIME);
  assert.equal(first.observation.model?.asOf, TIME);
  assert.equal(first.observation.effort?.asOf, TIME);
  assert.equal(first.evidence?.context.asOf, TIME + 4000);
  assert.equal(first.observation.context?.asOf, TIME + 4000);
  assert.equal(first.evidence?.context.quality, 'estimated');
  assert.equal(first.observation.context?.quality, 'estimated');
  assert.equal(first.evidence?.context.source, 'codex.token_count.baseline_adjusted');
  fs.appendFileSync(
    f.file,
    row(
      'response_item',
      {
        type: 'message',
        role: 'assistant',
        channel: 'final',
        content: [{ type: 'output_text', text: 'Unrelated public reply' }],
      },
      9000
    ) + '\n'
  );
  const after = await drain(f.adapter.open(f.ref, JSON.parse(JSON.stringify(first.checkpoint))));
  assert.equal(after.evidence?.model.asOf, TIME);
  assert.equal(after.evidence?.context.asOf, TIME + 4000);
  assert.equal(after.observation.spent.tokens.asOf, TIME + 4000);
});

test('cumulative counter growth has its own clock and equal counters after file replacement start a new clock', async (t) => {
  const f = await fixture(t);
  const reader = f.adapter.open(f.ref);
  const first = await drain(reader);
  const count = (offset: number) =>
    row(
      'event_msg',
      { type: 'token_count', info: { total_token_usage: { input_tokens: 26000, output_tokens: 1100 } } },
      offset
    );
  fs.appendFileSync(f.file, count(9000) + '\n');
  const grown = await drain(reader);
  assert.equal(grown.observation.spent.tokens.asOf, TIME + 9000);
  assert.equal(grown.evidence?.context.asOf, first.evidence?.context.asOf);
  const replacement = f.file + '.new';
  fs.writeFileSync(replacement, meta() + '\n' + count(20000) + '\n');
  fs.renameSync(replacement, f.file);
  const replaced = await drain(reader);
  assert.equal(replaced.checkpoint.resetReason, 'file_changed');
  assert.equal(replaced.observation.spent.tokens.asOf, TIME + 20000);
  assert.equal(replaced.evidence?.context.value, null);
});

test('malformed known records produce a gap preserved across recovery and EOF', async (t) => {
  const f = await fixture(t, [meta(), row('event_msg', { type: 'task_started' })]);
  fs.appendFileSync(
    f.file,
    JSON.stringify({ type: 'event_msg', timestamp: new Date(TIME).toISOString(), payload: null }) + '\n'
  );
  const first = await drain(f.adapter.open(f.ref));
  assert.equal(first.observation.coverage.state, 'partial');
  assert.equal(first.observation.coverage.skipped.malformed_record, 1);
  const recovered = await drain(f.adapter.open(f.ref, JSON.parse(JSON.stringify(first.checkpoint))));
  assert.deepEqual(recovered.observation.coverage.gaps, ['malformed_record']);
  assert.equal(recovered.observation.coverage.state, 'partial');
});

test('strict bind recovers a quiet older session and unique registry ref without a locator', async (t) => {
  const f = await fixture(t);
  const yesterday = new Date(Date.now() - 86400000);
  const dir = path.join(
    f.root,
    'sessions',
    String(yesterday.getFullYear()),
    String(yesterday.getMonth() + 1).padStart(2, '0'),
    String(yesterday.getDate()).padStart(2, '0')
  );
  fs.mkdirSync(dir, { recursive: true });
  const older = path.join(dir, path.basename(f.file));
  fs.renameSync(f.file, older);
  fs.utimesSync(older, yesterday, yesterday);
  assert.deepEqual((await f.adapter.bind({ ...f.context, startedAt: Date.now() }))?.sessionRef, f.ref);
  const selected = await f.adapter.bind({
    ...f.context,
    cwd: null,
    registry: [
      {
        locator: null,
        binding: null,
        evidence: {
          origin: 'registry',
          ref: f.ref,
          sourceGeneration: 19,
          validity: 'current',
          eventAt: TIME,
          observedAt: TIME,
          lastSuccessfulReadAt: TIME,
          value: {
            server: 'synthetic-server',
            occupant: f.ref,
            completionSeq: null,
            sourceClockAt: TIME,
            activity: 'idle',
            pendingReason: 'none',
          },
        },
      },
    ],
  });
  assert.deepEqual(selected, { sessionRef: f.ref, harness: null, occupantGeneration: null, managed: null });
});

test('current action uses open calls after the bounded recent-call history evicts it', async (t) => {
  const lines = [meta(), call('long-open', 'exec_command')];
  for (let n = 0; n < 12; n++) lines.push(call(`short-${n}`, 'exec_command'), output(`short-${n}`));
  const f = await fixture(t, lines);
  const result = await drain(f.adapter.open(f.ref));
  assert.equal(result.evidence?.action?.id, 'long-open');
  assert.equal((result.checkpoint as CodexCheckpoint).codex.rollout.state.runningTail, 'long-open');
});

test('source-scoped candidates and native topology exclude rollout symlinks escaping the source', async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  fs.writeFileSync(b.fileFor(CHILD), meta(CHILD, ROOT) + '\n');
  fs.writeFileSync(b.fileFor(FORK), meta(FORK) + '\n');
  fs.symlinkSync(b.fileFor(CHILD), a.fileFor(CHILD));
  fs.symlinkSync(b.fileFor(FORK), a.fileFor(FORK));
  assert.deepEqual((await a.adapter.bind(a.context))?.sessionRef, a.ref);
  assert.deepEqual(await a.adapter.children(a.ref), []);
});

test('multiple profiles sharing one source retain every explicitly configured hud-mcp alias', async (t) => {
  const f = await fixture(t, [meta(), call('alpha', 'mcp__hud_alpha__delegate_whoami'), output('alpha', 'run-alpha')]);
  await f.adapter.resolveSource({ ...profile(f.root), mcpServerName: 'hud_alpha' }, {});
  const reader = f.adapter.open(f.ref);
  const source = await f.adapter.resolveSource({ ...profile(f.root), mcpServerName: 'hud_beta' }, {});
  assert.equal(source, f.ref.sourceId);
  const result = await drain(reader);
  assert.equal(toolResults(result)[0].runId, 'run-alpha');
  fs.appendFileSync(f.file, call('beta', 'mcp__hud_beta__delegate_resume') + '\n' + output('beta', 'run-beta') + '\n');
  const resumed = await drain(reader);
  assert.deepEqual(
    toolResults(resumed).map((e) => e.runId),
    ['run-alpha', 'run-beta']
  );
});

test('unknown metrics use the time absence was confirmed, including cost and compact-invalidated context', async (t) => {
  const f = await fixture(t);
  const reader = f.adapter.open(f.ref);
  const beforeRead = Date.now();
  const first = await drain(reader);
  assert.equal(first.observation.spent.costUsd.value, null);
  assert.ok(first.observation.spent.costUsd.asOf >= beforeRead);
  assert.equal(first.observation.spent.tokens.asOf, TIME + 4000);
  fs.appendFileSync(f.file, row('event_msg', { type: 'context_compacted' }, 9000) + '\n');
  const beforeCompactRead = Date.now();
  const compacted = await drain(reader);
  assert.equal(compacted.evidence?.context.value, null);
  assert.equal(compacted.evidence?.context.quality, 'unknown');
  assert.ok(compacted.evidence!.context.asOf >= beforeCompactRead);
  assert.ok(compacted.observation.spent.costUsd.asOf >= beforeCompactRead);
});

test('production-default Codex reads advance despite 30 ms open/stat/read latency', async (t) => {
  const f = await fixture(t, [meta(), call(), output()]);
  for (const delayed of ['open', 'stat', 'read'] as const) {
    const adapter = new CodexAdapter();
    await adapter.resolveSource(profile(f.root), {});
    const reader = adapter.open(f.ref);
    const open = fs.promises.open;
    const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
    fs.promises.open = (async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await open(...args);
      if (String(args[0]) !== f.file) return handle;
      if (delayed === 'open') await pause();
      else if (delayed === 'stat') {
        const stat = handle.stat.bind(handle);
        handle.stat = (async (...statArgs: Parameters<typeof handle.stat>) => {
          const result = await stat(...statArgs);
          await pause();
          return result;
        }) as typeof handle.stat;
      } else {
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: unknown[]) => {
          const result = await (read as (...args: unknown[]) => Promise<unknown>)(...readArgs);
          await pause();
          return result;
        }) as typeof handle.read;
      }
      return handle;
    }) as typeof open;
    try {
      let previous = 0;
      for (let n = 0; n < 3; n++) {
        const result = await reader.read({ maxBytes: 4096, maxRecords: 1, budgetMs: 20 });
        assert.ok(result.checkpoint.offset > previous, `${delayed}: every positive-budget read advances`);
        assert.equal(result.stats?.recordsRead, 1);
        assert.ok(result.stats!.bytesRead <= 4096);
        previous = result.checkpoint.offset;
      }
      const stopped = await reader.read({ maxBytes: 4096, maxRecords: 0, budgetMs: 20 });
      assert.equal(stopped.checkpoint.offset, previous);
      assert.equal(stopped.stats?.bytesRead, 0);
    } finally {
      fs.promises.open = open;
    }
  }
});

test('controlled time slicing consumes one bounded step and preserves byte/record caps', async (t) => {
  const f = await fixture(t, [meta(), call(), output()]);
  const adapter = new CodexAdapter();
  await adapter.resolveSource(profile(f.root), {});
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const open = fs.promises.open;
  fs.promises.open = (async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await open(...args);
    if (String(args[0]) === f.file) {
      const read = handle.read.bind(handle);
      handle.read = (async (...readArgs: unknown[]) => {
        const result = await (read as (...args: unknown[]) => Promise<unknown>)(...readArgs);
        clock += 30;
        return result;
      }) as typeof handle.read;
    }
    return handle;
  }) as typeof open;
  try {
    const reader = adapter.open(f.ref);
    const first = await reader.read();
    assert.equal(first.checkpoint.offset, Buffer.byteLength(meta() + '\n'));
    assert.equal(first.stats?.recordsRead, 1);
    assert.ok(first.stats!.elapsedMs >= 30);
    assert.equal(first.observation.coverage.state, 'catching_up');
    const zero = await reader.read({ maxBytes: 1, maxRecords: 1, budgetMs: 0 });
    assert.equal(zero.stats?.bytesRead, 0);
    assert.equal(zero.checkpoint.offset, first.checkpoint.offset);
    const tiny = await reader.read({ maxBytes: 5, maxRecords: 1, budgetMs: 20 });
    assert.equal(tiny.stats?.bytesRead, 5);
    assert.equal(tiny.checkpoint.offset, first.checkpoint.offset);
    assert.equal(tiny.checkpoint.parserState.tailBytesSeen, 5);
    assert.equal(tiny.continuation, undefined, 'elapsed time is not a byte-only continuation');
  } finally {
    fs.promises.open = open;
  }
});

test('drain bounds every await and rejects late terminal responses', async (t) => {
  const f = await fixture(t, [meta()]);
  const terminal = await drain(f.adapter.open(f.ref));
  let clock = 0;
  await assert.rejects(
    drain(
      {
        read: async () => {
          clock = 11;
          return terminal;
        },
      },
      TEST_BUDGET,
      { timeoutMs: 10, now: () => clock }
    ),
    /deadline/
  );
  clock = 0;
  let calls = 0;
  await assert.rejects(
    drain(
      {
        read: async () => {
          calls++;
          clock += 6;
          const result = structuredClone(terminal);
          result.observation.coverage.state = calls === 1 ? 'catching_up' : 'complete';
          return result;
        },
      },
      TEST_BUDGET,
      { timeoutMs: 10, now: () => clock }
    ),
    /deadline/
  );
  assert.equal(calls, 2);
  await assert.rejects(drain({ read: () => new Promise(() => {}) }, TEST_BUDGET, { timeoutMs: 10 }), /deadline/);
  await assert.rejects(
    drain({
      read: async () => {
        const result = structuredClone(terminal);
        result.observation.coverage.state = 'catching_up';
        return result;
      },
    }),
    /made no progress/
  );
});

function assertPrivateCheckpoint(result: ReaderResult, sentinel: string) {
  const checkpoint = result.checkpoint as CodexCheckpoint;
  const native = checkpoint.codex.rollout.state;
  for (const artifact of [result, native]) {
    assert.ok(!JSON.stringify(artifact).includes(sentinel), 'source sentinel never reaches serializable state');
  }
  assert.deepEqual(checkpoint.parserState.pendingBytes, []);
  assert.equal(checkpoint.offset, checkpoint.codex.rollout.offset);
}

test('F09/F10 Codex crash cuts recover UTF-8/CRLF, private blobs and fallback claims without raw state', async (t) => {
  const sentinel = 'CRASH_PRIVATE_SENTINEL';
  const records = [
    row('response_item', {
      type: 'message',
      role: 'assistant',
      channel: 'final',
      content: [{ type: 'output_text', text: '合成结果' }],
    }),
    row('response_item', { type: 'api-request-blob', body: sentinel }),
    row('response_item', {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '[hud-launch] ' + JSON.stringify({ linkId: 'synthetic-link', claim: sentinel }) },
      ],
    }),
  ];
  for (const record of records) {
    const f = await fixture(t, [meta()]);
    const bytes = Buffer.from(meta() + '\r\n' + record + '\r\n');
    fs.writeFileSync(f.file, bytes);
    const firstEnd = Buffer.byteLength(meta() + '\r\n');
    const cuts = [bytes.length - 1, bytes.length - 8];
    const unicode = bytes.indexOf(Buffer.from('合'));
    if (unicode >= 0) cuts.push(unicode + 1);
    for (const cut of cuts) {
      const partial = await f.adapter.open(f.ref).read({ ...TEST_BUDGET, maxBytes: cut });
      assert.equal(partial.checkpoint.offset, firstEnd);
      assertPrivateCheckpoint(partial, sentinel);
      assert.equal(partial.evidence?.observation.statusProjection.lastEvidenceAt, TIME);
      const restored = await drain(f.adapter.open(f.ref, JSON.parse(JSON.stringify(partial.checkpoint))));
      const whole = await drain(f.adapter.open(f.ref));
      assert.equal(restored.checkpoint.offset, bytes.length);
      assert.deepEqual(restored.observation.spent.tokens.value, whole.observation.spent.tokens.value);
      assert.deepEqual(restored.observation.spent.costUsd.value, whole.observation.spent.costUsd.value);
      assert.deepEqual(restored.evidence?.reports, whole.evidence?.reports);
      assertPrivateCheckpoint(restored, sentinel);
    }
  }
});

test('F10 Codex maximum legal record, typed recovery continuation and oversize discard across restarts', async (t) => {
  const MiB = 1024 * 1024;
  const f = await fixture(t, [meta()]);
  const base = row('event_msg', { type: 'synthetic_padding', text: '' });
  const maximum = base.replace('"text":""', '"text":"' + 'x'.repeat(MiB - Buffer.byteLength(base) - 1) + '"') + '\r\n';
  assert.equal(Buffer.byteLength(maximum), MiB + 1);
  fs.appendFileSync(f.file, maximum);
  const checkpoint = await f.adapter.open(f.ref).read({ ...TEST_BUDGET, maxRecords: 1 });
  const small = await f.adapter.open(f.ref, checkpoint.checkpoint).read({ ...TEST_BUDGET, maxBytes: 100 });
  assert.equal(small.checkpoint.offset, checkpoint.checkpoint.offset);
  assert.equal(small.observation.coverage.state, 'partial');
  assert.equal(small.observation.coverage.reason, 'record_needs_larger_slice');
  assert.deepEqual(small.continuation, { kind: 'record_needs_larger_slice', minimumBytes: MiB + 1 });
  const recovered = await f.adapter.open(f.ref, JSON.parse(JSON.stringify(small.checkpoint))).read({
    ...TEST_BUDGET,
    maxBytes: small.continuation!.minimumBytes,
  });
  assert.equal(recovered.checkpoint.offset, fs.statSync(f.file).size);
  assert.equal(recovered.stats?.bytesRead, MiB + 1);
  assert.equal(recovered.observation.coverage.state, 'complete');
  fs.appendFileSync(f.file, 'x'.repeat(2 * MiB + 200));
  let result = await f.adapter.open(f.ref, recovered.checkpoint).read({ ...TEST_BUDGET, maxBytes: MiB + 1 });
  assert.equal(result.checkpoint.parserState.discardingOversize, true);
  let cursor = result.checkpoint.parserState.discardOffset!;
  while (result.observation.coverage.state === 'catching_up') {
    result = await f.adapter
      .open(f.ref, JSON.parse(JSON.stringify(result.checkpoint)))
      .read({ ...TEST_BUDGET, maxBytes: 300000 });
    assert.ok(result.checkpoint.parserState.discardOffset! > cursor);
    assert.ok(result.stats!.bytesRead <= 300000);
    cursor = result.checkpoint.parserState.discardOffset!;
  }
  assert.equal(result.observation.coverage.skipped.oversize_unknown, 1);
  assert.equal(result.observation.coverage.state, 'partial');
  fs.appendFileSync(f.file, '\n' + row('event_msg', { type: 'task_complete' }, 9000) + '\n');
  const finished = await drain(f.adapter.open(f.ref, JSON.parse(JSON.stringify(result.checkpoint))));
  assert.equal(finished.observation.coverage.skipped.oversize_unknown, 1);
  assert.equal(finished.checkpoint.offset, fs.statSync(f.file).size);
  assert.equal(finished.checkpoint.parserState.discardingOversize, false);
});

test('F10 Codex truncation or replacement drops old transient and repeated recovery preserves usage clocks', async (t) => {
  const f = await fixture(t);
  const reader = f.adapter.open(f.ref);
  const whole = await drain(reader);
  const oldTime = whole.observation.spent.tokens.asOf;
  fs.appendFileSync(f.file, '{"type":"event_msg","payload":{"private":"OLD_TRANSIENT');
  const tail = await drain(reader);
  assert.equal(tail.checkpoint.offset, whole.checkpoint.offset);
  assert.equal(tail.observation.coverage.reason, 'incomplete_tail');
  assertPrivateCheckpoint(tail, 'OLD_TRANSIENT');
  const replay = await drain(f.adapter.open(f.ref, JSON.parse(JSON.stringify(tail.checkpoint))));
  assert.equal(replay.observation.spent.tokens.asOf, oldTime);
  fs.writeFileSync(f.file, meta() + '\n' + row('event_msg', { type: 'task_complete' }, 20000) + '\n');
  const reset = await drain(reader);
  assert.ok(reset.checkpoint.sourceGeneration > tail.checkpoint.sourceGeneration);
  assert.equal(reset.evidence?.observation.statusProjection.lastEvidenceAt, TIME + 20000);
  assert.deepEqual(reset.observation.coverage.gaps, []);
  assert.equal(reset.observation.spent.tokens.value, null);
  assertPrivateCheckpoint(reset, 'OLD_TRANSIENT');
});

test('F10 Codex rereads a replaced growing tail before compaction instead of grafting old bytes', async (t) => {
  const f = await fixture(t, [meta()]);
  const prefix = meta() + '\n';
  const old = row('response_item', {
    type: 'message',
    role: 'assistant',
    channel: 'final',
    content: [{ type: 'output_text', text: 'OLD_TRANSIENT' }],
  });
  fs.appendFileSync(f.file, old.slice(0, -8));
  const reader = f.adapter.open(f.ref);
  const partial = await drain(reader);
  assert.equal(partial.checkpoint.offset, Buffer.byteLength(prefix));
  assertPrivateCheckpoint(partial, 'OLD_TRANSIENT');
  const next = row(
    'response_item',
    {
      type: 'message',
      role: 'assistant',
      channel: 'final',
      content: [{ type: 'output_text', text: 'New complete public answer' }],
    },
    3000
  );
  const replacement = prefix + row('event_msg', { type: 'context_compacted' }, 2000) + '\n' + next + '\n';
  assert.ok(Buffer.byteLength(replacement) > fs.statSync(f.file).size);
  fs.writeFileSync(f.file, replacement);
  const time = fs.statSync(f.file).mtimeMs + 1000;
  fs.utimesSync(f.file, time / 1000, time / 1000);
  const result = await drain(reader);
  assert.equal(result.checkpoint.resetReason, 'compaction');
  assert.ok(result.checkpoint.sourceGeneration > partial.checkpoint.sourceGeneration);
  assert.deepEqual(result.observation.coverage.gaps, []);
  assert.equal(result.evidence?.reports[0].text, 'New complete public answer');
  assertPrivateCheckpoint(result, 'OLD_TRANSIENT');
});

test('F10 Codex maximum fixed-EOF JSON consumes 1 MiB without a nonexistent delimiter', async (t) => {
  const MiB = 1024 * 1024;
  const base = row('event_msg', { type: 'synthetic_padding', text: '' });
  const record = base.replace('"text":""', '"text":"' + 'x'.repeat(MiB - Buffer.byteLength(base)) + '"');
  const f = await fixture(t, [meta()]);
  fs.appendFileSync(f.file, record);
  const before = await f.adapter.open(f.ref).read({ ...TEST_BUDGET, maxRecords: 1 });
  const result = await f.adapter.open(f.ref, before.checkpoint).read({ ...TEST_BUDGET, maxBytes: MiB });
  assert.equal(result.stats?.bytesRead, MiB);
  assert.equal(result.stats?.recordsRead, 1);
  assert.equal(result.checkpoint.offset, fs.statSync(f.file).size);
  assert.equal(result.observation.coverage.state, 'complete');
});

test('F09/F10 no-content budgeted rereads preserve the nested checkpoint event clock', async (t) => {
  const f = await fixture(t);
  const reader = f.adapter.open(f.ref);
  const first = await drain(reader);
  const clock = (result: ReaderResult) => {
    const cp = result.checkpoint as CodexCheckpoint;
    return cp.codex.rollout.state.cachedResult!.toolActivity.lastUpdateTime;
  };
  assert.equal(clock(first), TIME + 7000);
  const zero = await reader.read({ ...TEST_BUDGET, maxBytes: 0 });
  assert.equal(zero.stats?.bytesRead, 0);
  assert.equal(zero.stats?.recordsRead, 0);
  assert.equal(clock(zero), clock(first));
  fs.appendFileSync(f.file, '{"type":"event_msg","timestamp":"2026-03-01T12:01:00Z","payload":');
  const tail = await reader.read(TEST_BUDGET);
  assert.equal(tail.stats?.recordsRead, 0);
  assert.equal(tail.checkpoint.offset, first.checkpoint.offset);
  assert.equal(clock(tail), clock(first));
  assert.equal(tail.observation.spent.tokens.asOf, first.observation.spent.tokens.asOf);
  const restored = await f.adapter.open(f.ref, JSON.parse(JSON.stringify(tail.checkpoint))).read(TEST_BUDGET);
  assert.equal(restored.stats?.recordsRead, 0);
  assert.equal(restored.checkpoint.offset, first.checkpoint.offset);
  assert.equal(clock(restored), clock(first));
  assert.equal(restored.evidence?.observation.statusProjection.lastEvidenceAt, TIME + 7000);
});
