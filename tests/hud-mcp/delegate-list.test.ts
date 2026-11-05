import { HudMcpServer } from '../../packages/hud-mcp/src/server.js';
import { readFileSync } from 'node:fs';
import { openObservationStore } from '../../src/core/observation-store.js';
import { StatusWriter } from '../../src/core/status/writer.js';
import { initialParserState } from '../../src/core/observation.js';
import { refValue } from '../../src/ledger/records.js';
import type { MergeInput } from '../../src/core/status/merge.js';
import type { ReaderResult } from '../../src/core/interfaces/harness-adapter.js';
import { DelegationService } from '../../packages/hud-mcp/src/delegation.js';
import { scopeSnapshot } from '../../src/ledger/call-context.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { handshakeFixture, hashClaim } from '../unit/b45-handshake-fixture.js';
import { insertRecord, insertRun } from '../../src/ledger/records.js';
import { ReadControlService } from '../../packages/hud-mcp/src/read-control.js';
import { HUD_TOOLS, makeHookSettings } from '../../packages/hud-mcp/src/hook/record.js';
import { sessionRefKey } from '../../src/core/identity.js';
import { TOOLS, validateToolArguments } from '../../packages/hud-mcp/src/tools.js';

async function fixture(t: test.TestContext) {
  const f = await handshakeFixture();
  const reads = new ReadControlService(f.ledger, f.root);
  t.after(async () => {
    reads.close();
    await f.close();
  });
  async function add(id: string, actor = f.parent, at = 1000) {
    await f.ledger.transaction((tx) => {
      insertRecord(tx, 'links', {
        ...f.input.link,
        linkId: id,
        parentCaller: actor.context.callerId,
        parentContextId: actor.context.contextId,
        parentContextGeneration: actor.context.generation,
        parentRef: actor.ref,
        createdAt: at,
        briefPath: '/PRIVATE_BRIEF',
        label: 'PRIVATE_LABEL',
      });
      insertRun(tx, {
        ...f.input.run,
        runId: 'run-' + id,
        linkId: id,
        launchTokenHash: hashClaim(id),
        launchCallId: 'call-' + id,
        launchCorrelationId: 'correlation-' + id,
      });
    });
  }
  return { ...f, reads, add };
}

test('delegate_list schema accepts bounded page only, never owner selectors', () => {
  const tool = TOOLS.find((t) => t.name === 'delegate_list')!;
  assert.ok(tool);
  assert.equal(validateToolArguments(tool, {}), true);
  assert.equal(validateToolArguments(tool, { limit: 50 }), true);
  for (const args of [
    { limit: 0 },
    { limit: 51 },
    { limit: 1.2 },
    { cursor: '' },
    { owner: 'other' },
    { runId: 'run-a' },
  ])
    assert.equal(validateToolArguments(tool, args), false);
});

test('owner pages preserve historical same-session links, exclude unrelated owner and no private bodies', async (t) => {
  const f = await fixture(t);
  const same = await f.actor('same-owner', 30000, f.parent.ref.sessionId);
  const other = await f.actor('other-owner', 40000, 'foreign');
  await f.add('link-b', same);
  await f.add('link-0-foreign', other);
  await f.ledger.transaction((tx) => {
    tx.run("UPDATE links SET state='closed',closed_at=2000 WHERE link_id='link-b'");
    tx.run("UPDATE links SET predecessor='link-a' WHERE link_id='link-0-foreign'");
  });
  await f.add('link-c', f.parent, 1001);
  const first = await f.reads.list({ limit: 1 }, () => same.authority);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].linkId, 'link-a');
  assert.equal(first.hasMore, true);
  const second = await f.reads.list({ limit: 1, cursor: first.nextCursor! }, () => same.authority);
  assert.equal(second.items[0].linkId, 'link-b');
  const last = await f.reads.list({ limit: 1, cursor: second.nextCursor! }, () => same.authority);
  assert.equal(last.items[0].linkId, 'link-c');
  assert.equal(last.hasMore, false);
  assert.equal(last.nextCursor, null);
  assert.equal(last.items[0].observationAvailability, 'unavailable');
  assert.doesNotMatch(
    JSON.stringify([first, second, last]),
    /PRIVATE_|briefPath|reportPath|claimHash|foreign|totalCount/
  );
  await assert.rejects(
    f.reads.list({ cursor: first.nextCursor! }, () => other.authority),
    /invalid_list_cursor/
  );
  await assert.rejects(
    f.reads.list({ cursor: first.nextCursor! }, () => f.parent.authority),
    /invalid_list_cursor/
  );
  const foreign = await f.reads.list({}, () => other.authority);
  assert.deepEqual(
    foreign.items.map((x) => x.linkId),
    ['link-0-foreign']
  );
});

test('empty pages still authorize and stale contexts refuse; cursor cannot select a foreign owner', async (t) => {
  const f = await fixture(t);
  const empty = await f.actor('empty-owner', 50000, 'empty');
  assert.deepEqual(await f.reads.list({}, () => empty.authority), {
    ok: true,
    items: [],
    hasMore: false,
    nextCursor: null,
  });
  await f.ledger.transaction((tx) =>
    tx.run('UPDATE caller_contexts SET closed_at=2000 WHERE context_id=?', empty.context.contextId)
  );
  await assert.rejects(
    f.reads.list({}, () => empty.authority),
    /stale_context/
  );
  await assert.rejects(
    f.reads.list({ cursor: 'malformed' }, () => f.parent.authority),
    /invalid_list_cursor/
  );
  for (const limit of [0, 51, 1.5])
    await assert.rejects(
      f.reads.list({ limit }, () => f.parent.authority),
      /invalid/
    );
});

test('bounded owner pagination does not let foreign rows consume capacity and reads cause no ledger writes', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 51; i++) await f.add('page-' + String(i).padStart(2, '0'));
  const before = f.ledger.snapshot((tx) => tx.get('SELECT max(seq) AS seq FROM events')!.seq);
  const page = await f.reads.list({ limit: 50 }, () => f.parent.authority);
  assert.equal(page.items.length, 50);
  assert.equal(page.hasMore, true);
  const rest = await f.reads.list({ limit: 50, cursor: page.nextCursor! }, () => f.parent.authority);
  assert.equal(rest.items.length, 2);
  assert.equal(rest.hasMore, false);
  assert.equal(new Set([...page.items, ...rest.items].map((x) => x.linkId)).size, 52);
  assert.equal(
    f.ledger.snapshot((tx) => tx.get('SELECT max(seq) AS seq FROM events')!.seq),
    before
  );
});

test('same sessionId in another source cannot enter the owner page', async (t) => {
  const f = await fixture(t);
  const foreign = { ...f.parent.ref, sourceId: 'f'.repeat(64) };
  await f.ledger.transaction((tx) => {
    insertRecord(tx, 'sources', {
      sourceId: foreign.sourceId,
      harness: 'codex',
      rootPath: '/synthetic/foreign',
      label: 'foreign',
    });
    tx.run(
      'INSERT INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
      sessionRefKey(foreign),
      'codex',
      foreign.sourceId,
      foreign.sessionId,
      ''
    );
    insertRecord(tx, 'links', { ...f.input.link, linkId: 'foreign-source', parentRef: foreign });
    insertRun(tx, {
      ...f.input.run,
      runId: 'run-foreign-source',
      launchTokenHash: hashClaim('foreign-source'),
      linkId: 'foreign-source',
    });
  });
  assert.deepEqual(
    (await f.reads.list({}, () => f.parent.authority)).items.map((x) => x.linkId),
    ['link-a']
  );
});

test('Claude hook matcher captures delegate_list but not other names', () => {
  assert.ok(HUD_TOOLS.includes('delegate_list'));
  const settings = makeHookSettings(
    { serverName: 'hud' } as Parameters<typeof makeHookSettings>[0],
    '/synthetic/record'
  ) as { hooks: { PreToolUse: { matcher: string }[] } };
  const matcher = new RegExp(settings.hooks.PreToolUse[0].matcher);
  assert.ok(matcher.test('mcp__hud__delegate_list'));
  assert.equal(matcher.test('mcp__other__delegate_list'), false);
  assert.equal(matcher.test('mcp__hud__delegate_list_extra'), false);
});

test('real DelegationService routes list through current context without launch or capability verification', async (t) => {
  const f = await fixture(t);
  const service = new DelegationService({
    ledger: f.ledger,
    home: f.root,
    config: { version: 1, profiles: [] },
    registration: f.parent.registration,
    reader: f.reader,
    capability: {
      verify: () => {
        throw new Error('must_not_verify');
      },
    },
    hudRunPath: '/synthetic/not-executed',
    launch: async () => {
      throw new Error('must_not_launch');
    },
  });
  t.after(() => service.close());
  const source = {
    ok: true as const,
    callId: 'synthetic-list',
    sessionRef: f.parent.ref,
    processKey: f.parent.authority.evidence.processKey,
    evidenceDigest: hashClaim('synthetic-list'),
    scopePremise: f.ledger.snapshot((tx) =>
      scopeSnapshot(tx, f.ledger.ledgerId, f.parent.authority.evidence.processKey)
    ),
  };
  const result = (await service.invoke(source, 'delegate_list', {})) as { items: { linkId: string }[] };
  assert.deepEqual(
    result.items.map((x) => x.linkId),
    ['link-a']
  );
  const server = new HudMcpServer({ resolve: async () => source }, service);
  const refusal = (await server.handle({
    jsonrpc: '2.0',
    id: 'list-invalid-cursor',
    method: 'tools/call',
    params: { name: 'delegate_list', arguments: { cursor: 'malformed' } },
  })) as { result: { structuredContent: { ok: boolean; code: string } } };
  assert.equal(refusal.result.structuredContent.ok, false);
  assert.equal(refusal.result.structuredContent.code, 'invalid_list_cursor');
  server.shutdown();
  await f.ledger.transaction((tx) =>
    tx.run('UPDATE caller_contexts SET closed_at=2000 WHERE context_id=?', f.parent.context.contextId)
  );
  await assert.rejects(service.invoke(source, 'delegate_list', {}), /stale_context/);
});

test('list preserves committed status stamp and rejects binding mismatch without reading transcripts', async (t) => {
  const f = await fixture(t);
  const step = JSON.parse(
    readFileSync('tests/fixtures/status-merge/C30.json', 'utf8')
      .replaceAll('run-b', 'run-a')
      .replaceAll('a'.repeat(64), f.source.sourceId)
  ).steps[0] as { input: MergeInput; ruleVersion: string; nowMs: number };
  const ref = f.child.ref;
  step.input.target = {
    ...step.input.target,
    nodeIdentity: { kind: 'session', ref },
    runId: 'run-a',
    bindingGeneration: 1,
    sourceGeneration: 1,
  };
  step.input.sources = step.input.sources.map((s) =>
    s.evidence.origin === 'ledger'
      ? s
      : { ...s, evidence: { ...s.evidence, ref, runId: 'run-a', bindingGeneration: 1, sourceGeneration: 1 } }
  );
  await f.ledger.transaction((tx) =>
    tx.run('UPDATE runs SET target_session_ref=? WHERE run_id=?', refValue(ref), 'run-a')
  );
  const store = await openObservationStore({ hudHome: f.root, sourceId: ref.sourceId, now: () => step.nowMs });
  t.after(() => store.close());
  const lease = store.acquire(ref, 'synthetic-b6');
  const writer = new StatusWriter(store, ref, lease);
  const reading: ReaderResult = {
    checkpoint: {
      schemaVersion: 1,
      readerVersion: 'synthetic',
      ref,
      sourceGeneration: 1,
      fileId: { dev: 1, inode: 2 },
      offset: 1,
      parserState: initialParserState(),
    },
    observation: {
      nodeIdentity: { kind: 'session', ref },
      statusProjection: {} as any,
      conflict: null,
      workspace: null,
      spent: {
        tokens: { value: null, quality: 'unknown', source: 'synthetic', asOf: 1000 },
        costUsd: { value: null, quality: 'unknown', source: 'synthetic', asOf: 1000 },
      },
      coverage: { state: 'complete', gaps: [], skipped: {}, loaded: true },
      loaded: true,
      depth: 0,
      evidenceStamp: 'synthetic',
    },
  };
  const native = step.input.sources.filter((s) => s.evidence.origin === 'transcript');
  const publication = writer.publish(
    writer.prepare(reading, native, step.input.target),
    { ...step.input, sources: step.input.sources.filter((s) => s.evidence.origin !== 'transcript') },
    step.ruleVersion,
    step.nowMs
  );

  const one = (await f.reads.list({}, () => f.parent.authority)).items[0];
  assert.deepEqual(one.observationStamp, publication.committed.observationStamp);
  assert.deepEqual(one.statusProjection, publication.committed.summary.statusProjection);
  assert.equal(one.observationAvailability, 'stale');
  assert.equal(one.statusProjection?.pendingReason, 'needs_human');
  await f.ledger.transaction((tx) => {
    tx.run('PRAGMA defer_foreign_keys=ON');
    tx.run('UPDATE runs SET expected_generation=2 WHERE run_id=?', 'run-a');
    tx.run('UPDATE claims SET expected_generation=2 WHERE run_id=?', 'run-a');
  });
  const stale = (await f.reads.list({}, () => f.parent.authority)).items[0];
  assert.equal(stale.statusProjection, null);
  assert.equal(stale.observationUnavailableReason, 'binding_generation_mismatch');
});
