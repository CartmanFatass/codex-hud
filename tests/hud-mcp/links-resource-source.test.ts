import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HudMcpServer } from '../../packages/hud-mcp/src/server.js';
import { SessionRefResolver } from '../../packages/hud-mcp/src/resolvers.js';
import { DelegationService } from '../../packages/hud-mcp/src/delegation.js';
import type { DelegateProfile } from '../../packages/hud-mcp/src/config.js';
import { handshakeFixture, hashClaim } from '../unit/b45-handshake-fixture.js';
import { scopeSnapshot } from '../../src/ledger/call-context.js';
import { insertRecord, insertRun } from '../../src/ledger/records.js';
import { sessionRefKey } from '../../src/core/identity.js';
import type { ScopeSnapshotPort } from '../../src/core/ledger-scope-read.js';

// Synthetic production-format Codex 0.166.0 metadata and bounded rollout header.
// The trusted-session fixture establishes temporary ledger authority; these are
// not installed-client observations and do not claim a provider/account call.
const uuid = '01900000-0000-7000-8000-000000000001';
const otherUuid = '01900000-0000-7000-8000-000000000002';
function metadata(sessionId = uuid): Record<string, any> {
  return { callId: 'synthetic-links-call', sessionId, threadId: sessionId,
    'x-codex-turn-metadata': { session_id: sessionId, thread_id: sessionId,
      thread_source: 'user', codex_version: '0.166.0', turn_trigger: 'exec' } };
}
function profile(root: string): DelegateProfile {
  return { name: 'synthetic', harness: 'codex', source: { root, label: 'Synthetic' },
    launch: { argv: ['synthetic', '{{prompt}}'] }, headless: { argv: ['synthetic', 'exec'] },
    resume: null, resumeHeadless: null, host: { kind: 'none', layout: 'none' }, env: {},
    mcpServerName: 'hud', claimTransport: 'config_env', clientToolTimeoutMs: 60000, responseMarginMs: 2000,
    orphan_policy: 'continue', managedShellVerified: false,
    roles: { implementer: { model: 'synthetic-model', effort: 'low' } } };
}
async function fixture(t: test.TestContext) {
  const f = await handshakeFixture();
  const owner = await f.actor('resource-owner', 30000, uuid);
  const other = await f.actor('other-resource-owner', 40000, otherUuid);
  const sessions = join(f.root, 'sessions');
  mkdirSync(sessions);
  function header(id = uuid, payload: Record<string, unknown> = {}) {
    const file = join(sessions, `rollout-synthetic-${id}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cli_version: '0.166.0', source: 'exec', ...payload } }) + '\n');
    return file;
  }
  header(); header(otherUuid);
  const scopes: ScopeSnapshotPort = { read: (key) => f.ledger.snapshot((tx) => scopeSnapshot(tx, f.ledger.ledgerId, key)) };
  const services: DelegationService[] = [];
  const servers: HudMcpServer[] = [];
  let invokes = 0;
  function server(actor = owner, sourceScopes = scopes) {
    const service = new DelegationService({ ledger: f.ledger, home: f.root,
      config: { version: 1, profiles: [] }, registration: actor.registration, reader: f.reader,
      capability: { verify: () => { throw new Error('must_not_verify'); } },
      hudRunPath: '/synthetic/never-executed', launch: async () => { throw new Error('must_not_launch'); } });
    const invoke = service.invoke.bind(service);
    service.invoke = async (...args) => { invokes++; return invoke(...args); };
    services.push(service);
    const resolver = new SessionRefResolver(actor.registration, f.reader, profile(f.root),
      { codex: (root, id) => root === f.root ? join(sessions, `rollout-synthetic-${id}.jsonl`) : null },
      undefined, sourceScopes);
    const instance = new HudMcpServer(resolver, service);
    servers.push(instance);
    return instance;
  }
  async function add(id: string, actor = owner) {
    await f.ledger.transaction((tx) => {
      insertRecord(tx, 'links', { ...f.input.link, linkId: id,
        parentCaller: actor.context.callerId, parentContextId: actor.context.contextId,
        parentContextGeneration: actor.context.generation, parentRef: actor.ref,
        briefPath: '/PRIVATE_BRIEF_原文\u001b', reportPath: '/PRIVATE_REPORT', label: 'PRIVATE_LABEL\u202e' });
      insertRun(tx, { ...f.input.run, runId: 'run-' + id, linkId: id,
        launchTokenHash: hashClaim(id), launchCallId: 'call-' + id, launchCorrelationId: 'correlation-' + id });
    });
  }
  function snapshot() {
    return f.ledger.snapshot((tx) => JSON.stringify(['events', 'evidence', 'callers', 'caller_scopes',
      'caller_contexts', 'links', 'runs', 'claims', 'sessions'].map((table) => tx.all(`SELECT * FROM ${table}`))));
  }
  t.after(async () => { for (const instance of servers) instance.shutdown();
    for (const service of services) await service.close(); await f.close(); });
  return { ...f, owner, other, scopes, header, server, add, snapshot, invokes: () => invokes };
}
async function call(server: HudMcpServer, args: Record<string, unknown> = {}, meta: unknown = metadata()) {
  return await server.handle({ jsonrpc: '2.0', id: 'synthetic-call', method: 'tools/call',
    params: { name: 'delegate_list', arguments: { format: 'resource', ...args }, _meta: meta } }) as any;
}
function parsed(reply: any) {
  assert.equal(reply.result.isError, false);
  assert.equal(reply.result.content.length, 2);
  assert.equal(reply.result.content[1].type, 'resource');
  return JSON.parse(reply.result.content[1].resource.text);
}
function denied(reply: any, expected?: string) {
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.structuredContent.ok, false);
  if (expected) assert.equal(reply.result.structuredContent.code, expected);
  assert.equal(reply.result.content.length, 1);
  assert.equal(reply.result.content[0].type, 'text');
  assert.doesNotMatch(JSON.stringify(reply), /hud:\/\/links|PRIVATE_|owned-link|SECRET/);
}

test('actual resolver -> server -> real service/ledger: initialize, list schema, one authorized metadata page', async (t) => {
  const f = await fixture(t);
  await f.add('owned-link');
  const server = f.server();
  const before = f.snapshot();
  const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18' } }) as any;
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  const listed = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as any;
  assert.deepEqual(listed.result.tools.find((x: any) => x.name === 'delegate_list').inputSchema.properties.format,
    { type: 'string', enum: ['json', 'resource'] });
  const reply = await call(server);
  const page = parsed(reply);
  assert.deepEqual(page.items.map((x: any) => x.linkId), ['owned-link']);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.equal(page.items[0].observationAvailability, 'unavailable');
  assert.equal(page.items[0].observationStamp, null);
  assert.doesNotMatch(reply.result.content[1].resource.text, /PRIVATE_|briefPath|reportPath|claimHash|label/);
  assert.equal(f.invokes(), 1);
  assert.equal(f.snapshot(), before, 'read-only path must not write contexts, evidence, claims, runs or events');
});

const metadataChanges: [string, (meta: Record<string, any>) => unknown][] = [
  ['missing metadata', () => null],
  ['missing call id', (m) => { delete m.callId; return m; }],
  ['conflicting root', (m) => { m.sessionId = otherUuid; return m; }],
  ['conflicting thread', (m) => { m.threadId = otherUuid; return m; }],
  ['native child', (m) => { m.threadId = otherUuid; m['x-codex-turn-metadata'].thread_id = otherUuid; return m; }],
  ['subagent source', (m) => { m['x-codex-turn-metadata'].thread_source = 'subagent'; return m; }],
  ['parent metadata', (m) => { m['x-codex-turn-metadata'].parent_thread_id = otherUuid; return m; }],
  ['unmeasured version', (m) => { m['x-codex-turn-metadata'].codex_version = '999'; return m; }],
  ['non-exec trigger', (m) => { m['x-codex-turn-metadata'].turn_trigger = 'resume'; return m; }],
];
for (const [name, change] of metadataChanges) {
  test(`actual resolver rejects ${name} without reaching service or leaking page`, async (t) => {
    const f = await fixture(t); await f.add('owned-link');
    const before = f.snapshot(); const server = f.server();
    denied(await call(server, {}, change(metadata())));
    assert.equal(f.invokes(), 0);
    assert.equal(f.snapshot(), before);
    assert.equal(parsed(await call(server)).items.length, 1, 'fresh valid evidence still works');
  });
}

for (const variant of ['harness-start', 'caller-start', 'namespace', 'root', 'header-id', 'header-version', 'header-source', 'full-source'] as const) {
  test(`actual resolver/service rejects forged ${variant}`, async (t) => {
    const f = await fixture(t); await f.add('owned-link');
    if (variant === 'harness-start') f.processes.get(30000)!.procStart = 'replacement';
    if (variant === 'caller-start') f.processes.get(30001)!.procStart = 'replacement';
    if (variant === 'namespace') f.processes.get(30000)!.pidNamespace = 'different-namespace';
    if (variant === 'root') f.processes.get(30000)!.env.CODEX_HOME = '/synthetic/unrelated';
    if (variant === 'header-id') f.header(uuid, { id: otherUuid });
    if (variant === 'header-version') f.header(uuid, { cli_version: '999' });
    if (variant === 'header-source') f.header(uuid, { source: 'subagent' });
    if (variant === 'full-source') f.owner.registration.source = { ...f.source, sourceId: 'f'.repeat(64) };
    const before = f.snapshot(); denied(await call(f.server())); assert.equal(f.snapshot(), before);
    if (variant !== 'full-source') assert.equal(f.invokes(), 0);
  });
}

test('owner pages are bounded at 50; cursors are owner and context bound; no implicit page loop', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 51; i++) await f.add('owned-' + String(i).padStart(2, '0'));
  await f.add('other-owned', f.other);
  const server = f.server(); const before = f.snapshot();
  const first = parsed(await call(server, { limit: 50 }));
  assert.equal(first.items.length, 50); assert.equal(first.hasMore, true); assert.equal(f.invokes(), 1);
  const last = parsed(await call(server, { limit: 50, cursor: first.nextCursor }));
  assert.equal(last.items.length, 1); assert.equal(last.hasMore, false); assert.equal(last.nextCursor, null);
  assert.equal(new Set([...first.items, ...last.items].map((x: any) => x.linkId)).size, 51);
  // A read receipt cannot authorize another owner, even if it references a valid page.
  denied(await call(f.server(f.other), { cursor: first.nextCursor }, metadata(otherUuid)), 'invalid_list_cursor');
  assert.equal(f.snapshot(), before);
  const sameSession = await f.actor('same-session-new-context', 50000, uuid);
  denied(await call(f.server(sameSession), { cursor: first.nextCursor }), 'invalid_list_cursor');
  assert.equal(parsed(await call(f.server(sameSession), { limit: 50 })).items.length, 50);
  denied(await call(server, { cursor: 'forged-cursor' }), 'invalid_list_cursor');
});

test('same sessionId under another full source identity is excluded, and empty page still authenticates', async (t) => {
  const f = await fixture(t);
  const foreign = { ...f.owner.ref, sourceId: 'f'.repeat(64) };
  await f.ledger.transaction((tx) => {
    insertRecord(tx, 'sources', { sourceId: foreign.sourceId, harness: 'codex', rootPath: '/synthetic/foreign', label: 'foreign' });
    tx.run('INSERT INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
      sessionRefKey(foreign), 'codex', foreign.sourceId, foreign.sessionId, '');
    insertRecord(tx, 'links', { ...f.input.link, linkId: 'foreign-source', parentRef: foreign });
    insertRun(tx, { ...f.input.run, runId: 'run-foreign-source', linkId: 'foreign-source', launchTokenHash: hashClaim('foreign-source') });
  });
  const server = f.server(); const before = f.snapshot();
  assert.deepEqual(parsed(await call(server)).items, []);
  denied(await call(server, {}, null), 'identity_source_missing');
  assert.equal(f.snapshot(), before);
});

for (const retirement of ['context', 'scope', 'captured-premise'] as const) {
  test(`real ledger rejects ${retirement} retirement including empty pages`, async (t) => {
    const f = await fixture(t);
    const key = f.owner.authority.evidence.processKey;
    const captured = f.scopes.read(key);
    const server = f.server(f.owner, retirement === 'captured-premise' ? { read: () => captured } : f.scopes);
    assert.deepEqual(parsed(await call(server)).items, []);
    await f.ledger.transaction((tx) => {
      if (retirement === 'context') tx.run('UPDATE caller_contexts SET closed_at=2000 WHERE context_id=?', f.owner.context.contextId);
      else tx.run('UPDATE caller_scopes SET closed_at=2000 WHERE process_key=?', key);
    });
    const before = f.snapshot(); denied(await call(server), 'stale_context'); assert.equal(f.snapshot(), before);
  });
}
