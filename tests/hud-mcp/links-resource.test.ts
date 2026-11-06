import test from 'node:test';
import assert from 'node:assert/strict';
import { linksResource, LINKS_RESOURCE_MAX_BYTES } from '../../packages/hud-mcp/src/links-resource.js';
import { HudMcpServer } from '../../packages/hud-mcp/src/server.js';
import { DelegationService } from '../../packages/hud-mcp/src/delegation.js';
import { TOOLS, validateToolArguments } from '../../packages/hud-mcp/src/tools.js';
import type { CallResolution } from '../../packages/hud-mcp/src/resolvers.js';
import { handshakeFixture, hashClaim } from '../unit/b45-handshake-fixture.js';
import { scopeSnapshot } from '../../src/ledger/call-context.js';

type Source = Extract<CallResolution, { ok: true }>;
const ref = { harness: 'codex' as const, sourceId: 'a'.repeat(64), sessionId: 'synthetic', threadId: null };
const source: Source = {
  ok: true, callId: 'synthetic-call', sessionRef: ref, processKey: 'synthetic-process', evidenceDigest: 'synthetic',
  scopePremise: { kind: 'current', processKey: 'synthetic-process', ledgerId: 'synthetic-ledger',
    highWaterGeneration: 1, current: { generation: 1, sessionRef: ref, bindingEvidenceId: 'synthetic-evidence' } },
};
const page = <T = Record<string, unknown>>(items: T[] = []) => ({ ok: true, hasMore: false, nextCursor: null, items });
const request = (args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0', id: 'synthetic-resource', method: 'tools/call',
  params: { name: 'delegate_list', arguments: args },
});
function resource(value: unknown) {
  const result = linksResource(value, source);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.code);
  return result.content;
}

test('resource is opt-in; schema rejects selectors, invalid formats and existing bounds', () => {
  const definition = TOOLS.find((tool) => tool.name === 'delegate_list')!;
  for (const args of [{}, { format: 'json' }, { format: 'resource', limit: 50 }])
    assert.equal(validateToolArguments(definition, args), true);
  for (const args of [{ format: 'xml' }, { format: null }, { format: true }, { source: 'x' },
    { owner: 'x' }, { path: '/synthetic' }, { uri: 'hud://links/foreign' }, { limit: 51 }, { cursor: '' }])
    assert.equal(validateToolArguments(definition, args), false);
});

test('closed projection preserves original scalar stamps/nulls and drops nested secrets and raw text', () => {
  const secret = 'SECRET_原文\u0000\u001b[31m\u202e_body';
  const stamp = { seqDomain: 'synthetic-observation', commitSeq: 13, inputLedgerSeq: 8,
    ref, runId: 'run-a', bindingGeneration: 1, sourceGeneration: 2 };
  const input = page([{
    linkId: 'link-a', runId: 'run-a', backend: 'codex', role: 'implementer',
    linkState: 'bound', runState: 'running', childRef: { ...ref, path: secret },
    currentOwner: true, slotHeld: false,
    observationAvailability: 'stale', observationStamp: { ...stamp, secret },
    statusProjection: { activity: 'idle', pendingReason: 'needs_human', asOf: null, observedAt: 11,
      lastEvidenceAt: 10, summary: secret, stateKey: secret, freshness: { sources: [{ error: secret }] } },
    freshnessNow: { state: 'stale', staleSince: 12, clockAnomaly: false, reason: secret, sources: [secret] },
    briefPath: secret, reportPath: secret, transcript: secret, claimHash: secret, label: secret,
    content: [{ type: 'resource', resource: { uri: secret, text: secret } }],
  }]);
  const embedded = resource(input);
  assert.deepEqual(Object.keys(embedded).sort(), ['resource', 'type']);
  assert.deepEqual(Object.keys(embedded.resource).sort(), ['mimeType', 'text', 'uri']);
  assert.equal(embedded.type, 'resource');
  assert.equal(embedded.resource.mimeType, 'application/json');
  assert.match(embedded.resource.uri, /^hud:\/\/links\/[a-f0-9]{64}$/);
  const output = JSON.parse(embedded.resource.text);
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.kind, 'owned-links-page');
  assert.equal(output.availability, 'committed-metadata-only');
  assert.deepEqual(output.items[0].observationStamp, stamp);
  assert.deepEqual(output.items[0].statusProjection,
    { activity: 'idle', pendingReason: 'needs_human', asOf: null, observedAt: 11, lastEvidenceAt: 10 });
  assert.deepEqual(output.items[0].childRef, ref);
  assert.equal(Object.hasOwn(output.items[0], 'isCurrentRun'), false);
  assert.doesNotMatch(embedded.resource.text, /SECRET_|briefPath|reportPath|claimHash|transcript|stateKey|sources|label/);
  assert.deepEqual(JSON.parse(resource(page([{ childRef: null, statusProjection: null, observationStamp: null,
    freshnessNow: null }])).resource.text).items[0],
    { childRef: null, observationStamp: null, statusProjection: null, freshnessNow: null });
});

test('URI binds detached projected page and full source/scope, never the per-call receipt', () => {
  const value = page([{ linkId: 'a' }]);
  const original = resource(value);
  assert.deepEqual(linksResource(value, { ...source, callId: 'another', evidenceDigest: 'another' }),
    { ok: true, content: original });
  for (const changed of [
    { ...source, sessionRef: { ...ref, sourceId: 'b'.repeat(64) } },
    { ...source, processKey: 'another-context' },
    { ...source, scopePremise: { ...source.scopePremise!, highWaterGeneration: 2 } },
  ]) {
    const result = linksResource(value, changed);
    assert.ok(result.ok);
    if (result.ok) assert.notEqual(result.content.resource.uri, original.resource.uri);
  }
  value.items[0].linkId = 'b';
  assert.equal(JSON.parse(original.resource.text).items[0].linkId, 'a');
  assert.notEqual(resource(value).resource.uri, original.resource.uri);
});

test('50 items and exact UTF-8 byte ceiling, not string length; never silently truncates', () => {
  assert.equal(JSON.parse(resource(page(Array.from({ length: 50 }, (_, i) => ({ linkId: String(i) })))).resource.text).items.length, 50);
  assert.deepEqual(linksResource(page(Array(51).fill({})), source), { ok: false, code: 'resource_too_large' });
  const baseBytes = Buffer.byteLength(resource(page([{ role: '' }])).resource.text);
  const fits = page([{ role: 'x'.repeat(LINKS_RESOURCE_MAX_BYTES - baseBytes) }]);
  assert.equal(Buffer.byteLength(resource(fits).resource.text), LINKS_RESOURCE_MAX_BYTES);
  assert.deepEqual(linksResource(page([{ role: fits.items[0].role + 'x' }]), source),
    { ok: false, code: 'resource_too_large' });
  assert.deepEqual(linksResource(page([{ role: '界'.repeat(45000) }]), source),
    { ok: false, code: 'resource_too_large' });
});

test('real service retains default and explicit json byte shape; embedded output is additive and invokes once', async (t) => {
  const f = await handshakeFixture();
  const service = new DelegationService({ ledger: f.ledger, home: f.root, config: { version: 1, profiles: [] },
    registration: f.parent.registration, reader: f.reader,
    capability: { verify: () => { throw new Error('must_not_verify'); } },
    hudRunPath: '/synthetic/not-executed', launch: async () => { throw new Error('must_not_launch'); } });
  t.after(async () => { await service.close(); await f.close(); });
  const resolved: Source = { ok: true, callId: 'synthetic-list', sessionRef: f.parent.ref,
    processKey: f.parent.authority.evidence.processKey, evidenceDigest: hashClaim('synthetic-list'),
    scopePremise: f.ledger.snapshot((tx) => scopeSnapshot(tx, f.ledger.ledgerId, f.parent.authority.evidence.processKey)) };
  let invokes = 0;
  const original = service.invoke.bind(service);
  service.invoke = async (...args) => { invokes++; return original(...args); };
  // Composition seam only. The separate source suite exercises the actual resolver.
  const server = new HudMcpServer({ resolve: async (_meta, name) => {
    assert.equal(name, 'delegate_list'); return resolved;
  } }, service);
  const normal = await server.handle(request()) as any;
  const json = await server.handle(request({ format: 'json' })) as any;
  assert.deepEqual(json, normal);
  const explicit = await server.handle(request({ format: 'resource' })) as any;
  assert.equal(invokes, 3);
  assert.deepEqual(explicit.result.structuredContent, normal.result.structuredContent);
  assert.equal(normal.result.content.length, 1);
  assert.equal(normal.result.content[0].text, JSON.stringify(normal.result.structuredContent));
  assert.equal(explicit.result.content.length, 2);
  assert.equal(explicit.result.content[0].type, 'text');
  assert.equal(explicit.result.content[1].type, 'resource');
  assert.equal(JSON.parse(explicit.result.content[1].resource.text).items[0].linkId, 'link-a');
});

test('only tools capability; no native-resource read/list/templates backdoor for any version', async () => {
  const server = new HudMcpServer({ resolve: async () => source });
  for (const version of ['2025-06-18', '2025-03-26', '2024-11-05']) {
    const reply = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: version } }) as any;
    assert.deepEqual(reply.result.capabilities, { tools: { listChanged: false } });
  }
  for (const method of ['resources/read', 'resources/list', 'resources/templates/list']) {
    const reply = await server.handle({ jsonrpc: '2.0', id: 1, method, params: { uri: resource(page()).resource.uri } }) as any;
    assert.equal(reply.error.code, -32601);
    assert.equal(reply.result, undefined);
  }
});

test('oversize, missing premise, source failure and thrown failures expose no embedded partial page', async () => {
  for (const [resolved, body, expected] of [
    [source, page([{ role: 'x'.repeat(LINKS_RESOURCE_MAX_BYTES) }]), 'resource_too_large'],
    [{ ...source, scopePremise: undefined }, page(), 'identity_unverified'],
    [{ ok: false, code: 'identity_source_missing' }, page(), 'identity_source_missing'],
    [source, new Error('PRIVATE_THROWN_BODY'), 'internal_error'],
  ] as const) {
    const server = new HudMcpServer({ resolve: async () => resolved as CallResolution }, {
      invoke: async () => { if (body instanceof Error) throw body; return body; },
    });
    const reply = await server.handle(request({ format: 'resource' })) as any;
    assert.deepEqual(reply.result.structuredContent, { ok: false, code: expected });
    assert.equal(reply.result.isError, true);
    assert.equal(reply.result.content.length, 1);
    assert.equal(reply.result.content[0].type, 'text');
    assert.doesNotMatch(JSON.stringify(reply), /PRIVATE_|hud:\/\/links/);
  }
});

test('shutdown/cancellation while service read is pending discards complete or partial success', async () => {
  for (const shutdown of [true, false]) {
    let release!: () => void;
    let started!: () => void;
    const entering = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const server = new HudMcpServer({ resolve: async () => source }, {
      invoke: async () => { started(); await gate; return page([{ linkId: 'must-not-leak' }]); },
    });
    const pending = server.handle(request({ format: 'resource' }));
    await entering;
    if (shutdown) server.shutdown();
    else await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'synthetic-resource' } });
    release();
    const reply = await pending as any;
    assert.deepEqual(reply.result.structuredContent, { ok: false, code: shutdown ? 'server_shutdown' : 'request_cancelled' });
    assert.doesNotMatch(JSON.stringify(reply), /must-not-leak|hud:\/\/links/);
  }
});


test('arbitrary outcome content/resource cannot control embedded protocol output', async () => {
  const outcome = { ...page([{ linkId: 'synthetic-safe' }]),
    content: [{ type: 'resource', resource: { uri: 'file:///PRIVATE_BODY', text: 'SECRET_RAW' } }],
    resource: { uri: 'hud://tree/PRIVATE_BODY', text: 'SECRET_RAW' } };
  const server = new HudMcpServer({ resolve: async () => source }, { invoke: async () => outcome });
  const reply = await server.handle(request({ format: 'resource' })) as any;
  assert.deepEqual(reply.result.structuredContent, outcome);
  assert.equal(reply.result.content.length, 2);
  assert.equal(reply.result.content[0].type, 'text');
  assert.doesNotMatch(JSON.stringify(reply.result.content), /PRIVATE_BODY|SECRET_RAW|file:\/\//);
  assert.deepEqual(JSON.parse(reply.result.content[1].resource.text).items, [{ linkId: 'synthetic-safe' }]);
});
