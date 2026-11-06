import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CodexAppServerObserver } from '../../src/harness/codex/app-server.js';
import { CodexAppServerTransport } from '../../src/harness/codex/app-server-transport.js';
import { CONFIG_PROJECTION_LIMITS, type ConfigReadOptions } from '../../src/harness/codex/config-observation.js';
import { verifyManagedCapability, type ManagedCapabilityRequest } from '../../src/core/launch/capability.js';
import type { CapabilityCell, CapabilityVersions } from '../../src/core/types/capabilities.js';

const SECRET = 'SYNTHETIC_PRIVATE_SENTINEL';
const wire = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
function fixture(t: test.TestContext, mode = 'full', requestTimeoutMs = 3000) {
  const home = mkdtempSync(join(tmpdir(), 'hud-config-observation-'));
  const record = join(home, 'wire.jsonl');
  const client = new CodexAppServerTransport({
    executable: process.execPath,
    args: [resolve('tests/fixtures/codex-config-server.mjs'), mode, record],
    cwd: home,
    env: { HOME: home, HUD_HOME: join(home, '.hud'), CODEX_HOME: join(home, '.codex') },
    requestTimeoutMs,
    lifetimeMs: 15000,
  });
  t.after(async () => {
    const closed = await client.shutdown();
    assert.equal(closed.reaped, true);
    rmSync(home, { recursive: true, force: true });
  });
  const records = (): { id?: number; method: string; params?: Record<string, unknown> }[] =>
    readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return { client, home, records };
}
function noSecrets(...values: unknown[]) {
  const publicText = JSON.stringify(values);
  assert.ok(!publicText.includes(SECRET));
  assert.ok(!publicText.includes('/synthetic/private'));
  assert.ok(!publicText.includes('api_key'));
  assert.ok(!publicText.includes('instructions'));
}
function readyObserver() {
  const observer = new CodexAppServerObserver();
  observer.initialize(1, { name: 'synthetic', version: '1' });
  observer.push(wire({ id: 1, result: { userAgent: 'synthetic' } }));
  observer.initialized();
  return observer;
}
function minimal() { return { config: {}, origins: {}, layers: null }; }

test('actual transport initializes, reads only explicit config, projects provenance and reaps', async (t) => {
  const { client, home, records } = fixture(t);
  assert.deepEqual(client.configurationSnapshot().reasons, ['not_requested']);
  await client.initialize();
  const observed = await client.configRead({ cwd: home });
  assert.equal(observed.schema, 1);
  assert.equal(observed.protocolCommit, 'd786ff91fad8e7ddab8653ee07bc6313a6fcb03d');
  assert.equal(observed.status, 'available');
  assert.equal(observed.qualification, 'not_qualified');
  assert.equal(observed.sequence, 1);
  assert.deepEqual(observed.requestedCwd, {
    kind: 'sha256_exact_utf8', fingerprint: createHash('sha256').update(home).digest('hex'), binding: 'not_verified',
  });
  assert.deepEqual(observed.fields.model, {
    state: 'known', value: 'synthetic-model', origin: { state: 'known', type: 'project', version: 'synthetic-v1' },
  });
  assert.equal(observed.fields.model_reasoning_effort.value, 'future-effort');
  assert.deepEqual(observed.layers, {
    coverage: 'included', inventory: [{ index: 0, source: observed.fields.model.origin, disabled: false }],
  });
  assert.equal(client.snapshot().observation.threadId, null);
  assert.deepEqual(Object.keys(client.snapshot()), ['observation', 'stopped', 'reason']);
  assert.deepEqual(records().map((r) => r.method), ['initialize', 'initialized', 'config/read']);
  assert.deepEqual(records()[2], { id: 2, method: 'config/read', params: { cwd: home, includeLayers: true } });
  noSecrets(observed, client.configurationSnapshot(), client.snapshot());
  observed.fields.model.value = 'mutated';
  assert.equal(client.configurationSnapshot().fields.model.value, 'synthetic-model');
  assert.equal((await client.shutdown()).reaped, true);
});

test('actual transport rejects invalid explicit requests before wire; omits unsupported options', async (t) => {
  const { client, home, records } = fixture(t);
  await assert.rejects(client.configRead({ cwd: home }), /not_ready/);
  await client.initialize();
  for (const cwd of ['relative', '', '/synthetic/\0invalid', '/' + 'x'.repeat(CONFIG_PROJECTION_LIMITS.cwdBytes)])
    await assert.rejects(client.configRead({ cwd }), /invalid_config_request/);
  await assert.rejects(client.configRead({ cwd: home, includeLayers: 'yes' } as unknown as ConfigReadOptions));
  const result = await client.configRead({ cwd: home, includeLayers: false, injected: SECRET } as ConfigReadOptions);
  assert.equal(result.layers.coverage, 'omitted');
  assert.deepEqual(result.layers.inventory, []);
  assert.deepEqual(records().map((r) => r.method), ['initialize', 'initialized', 'config/read']);
  assert.deepEqual(records()[2].params, { cwd: home, includeLayers: false });
  noSecrets(records(), result);
});

test('actual transport preserves sparse/null/invalid values without zero or false coercion', async (t) => {
  for (const [mode, status, reason] of [
    ['sparse', 'unknown', 'missing'], ['nulls', 'unknown', 'null_value'], ['invalid-fields', 'invalid', 'invalid_value'],
  ] as const) {
    const { client, home } = fixture(t, mode);
    await client.initialize();
    const result = await client.configRead({ cwd: home });
    assert.equal(result.status, 'partial');
    assert.equal(result.fields.model_provider.state, status);
    if (result.fields.model_provider.state !== 'known') assert.equal(result.fields.model_provider.reason, reason);
    assert.equal(result.fields.model_provider.value, null);
    assert.equal(result.fields.sandbox_mode.value, null);
    noSecrets(result);
    await client.shutdown();
  }
});

test('actual transport uses unique IDs and keeps reordered receipt/cwd/provenance association', async (t) => {
  const { client, home, records } = fixture(t, 'reorder');
  await client.initialize();
  const firstCwd = join(home, 'first');
  const secondCwd = join(home, 'second');
  const [first, second] = await Promise.all([
    client.configRead({ cwd: firstCwd }), client.configRead({ cwd: secondCwd }),
  ]);
  assert.equal(first.fields.model.value, 'synthetic-first');
  assert.equal(second.fields.model.value, 'synthetic-second');
  assert.deepEqual(first.fields.model.origin, { state: 'known', type: 'project', version: 'synthetic-first-v1' });
  assert.deepEqual(second.fields.model.origin, { state: 'known', type: 'project', version: 'synthetic-second-v1' });
  assert.equal(first.layers.inventory[0].source.state === 'known' && first.layers.inventory[0].source.version, 'synthetic-first-v1');
  assert.equal(second.layers.inventory[0].source.state === 'known' && second.layers.inventory[0].source.version, 'synthetic-second-v1');
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.notEqual(first.requestedCwd?.fingerprint, second.requestedCwd?.fingerprint);
  assert.equal(client.configurationSnapshot().fields.model.value, 'synthetic-second');
  assert.equal(client.configurationSnapshot().sequence, 2);
  assert.deepEqual(records().filter((r) => r.method === 'config/read').map((r) => r.id), [2, 3]);
  assert.equal(client.snapshot().observation.pending, 0);
});

test('actual transport never reports old facts as fresh after failure, including a late older success', async (t) => {
  const { client, home } = fixture(t, 'success-error');
  await client.initialize();
  await client.configRead({ cwd: home });
  await assert.rejects(client.configRead({ cwd: home }), { message: 'app_server_request_failed' });
  assert.equal(client.configurationSnapshot().sequence, 2);
  assert.equal(client.configurationSnapshot().status, 'unavailable');
  assert.equal(client.configurationSnapshot().fields.model.value, null);
  assert.deepEqual(client.configurationSnapshot().reasons, ['request_failed']);
  noSecrets(client.configurationSnapshot(), client.snapshot());
  const other = fixture(t, 'reorder-error');
  await other.client.initialize();
  const settled = await Promise.allSettled([
    other.client.configRead({ cwd: other.home }), other.client.configRead({ cwd: other.home }),
  ]);
  assert.equal(settled[0].status, 'fulfilled');
  assert.equal(settled[1].status, 'rejected');
  assert.equal(other.client.configurationSnapshot().sequence, 2);
  assert.equal(other.client.configurationSnapshot().fields.model.value, null);
});

test('actual transport identifies unknown/invalid provenance, omitted layers and bounds', async (t) => {
  for (const [mode, reason] of [
    ['unknown-source', 'unsupported_source'], ['invalid-origin', 'invalid_origin'],
    ['missing-origins', 'origins_unavailable'], ['omitted-layers', 'layers_unavailable'],
    ['missing-layers', 'layers_unavailable'], ['field-limit', 'invalid_value'],
  ] as const) {
    const { client, home } = fixture(t, mode);
    await client.initialize();
    const result = await client.configRead({ cwd: home });
    assert.equal(result.status, 'partial');
    assert.ok(result.reasons.includes(reason));
    noSecrets(result);
    await client.shutdown();
  }
  const { client, home } = fixture(t, 'disabled');
  await client.initialize();
  const result = await client.configRead({ cwd: home });
  assert.equal(result.layers.inventory[0].disabled, true);
  noSecrets(result);
});

test('actual transport rejects malformed and over-bound envelopes, not an empty effective config', async (t) => {
  for (const mode of ['malformed-config', 'malformed-origins', 'malformed-layers', 'malformed-layer', 'origins-limit', 'layers-limit']) {
    const { client, home } = fixture(t, mode);
    await client.initialize();
    await assert.rejects(client.configRead({ cwd: home }), { message: 'app_server_request_failed' });
    const result = client.configurationSnapshot();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.fields.model.value, null);
    assert.deepEqual(result.reasons, [mode.endsWith('limit') ? 'projection_limit' : 'malformed_response']);
    noSecrets(result);
    await client.shutdown();
  }
});

test('actual transport refuses wrong/reused IDs, oversized frames and the cumulative connection limit', async (t) => {
  for (const mode of ['wrong-id', 'duplicate-id', 'frame-limit', 'connection-limit', 'malformed-json']) {
    const { client, home, records } = fixture(t, mode);
    await client.initialize();
    if (mode === 'duplicate-id') await client.configRead({ cwd: home });
    await assert.rejects(client.configRead({ cwd: home }), /protocol_gap/);
    assert.equal(client.snapshot().reason, 'protocol_gap');
    assert.equal(client.configurationSnapshot().status, 'unavailable');
    assert.equal((await client.closed).reaped, true);
    assert.equal(records().filter((r) => r.method === 'config/read').length, mode === 'duplicate-id' ? 2 : 1);
  }
});

test('actual transport bounds requests, times out without retries and does not answer approval', async (t) => {
  for (const [mode, expected] of [['silent', 'request_timeout'], ['exit', 'closed'], ['approval', 'unsupported_server_request']] as const) {
    const { client, home, records } = fixture(t, mode, 1000);
    await client.initialize();
    await assert.rejects(client.configRead({ cwd: home }));
    assert.equal((await client.closed).reaped, true);
    assert.equal(client.snapshot().reason, expected);
    assert.equal(client.configurationSnapshot().status, 'unavailable');
    assert.deepEqual(records().map((r) => r.method), ['initialize', 'initialized', 'config/read']);
    noSecrets(client.configurationSnapshot(), client.snapshot());
  }
  const { client, home } = fixture(t, 'silent', 1000);
  await client.initialize();
  const reads = Promise.allSettled(Array.from({ length: 8 }, () => client.configRead({ cwd: home })));
  await assert.rejects(client.configRead({ cwd: home }), /pending_limit/);
  assert.ok((await reads).every((r) => r.status === 'rejected'));
  assert.equal((await client.closed).reaped, true);
});

test('observer validates all pinned source variants and preserves the old snapshot shape', () => {
  const observer = readyObserver();
  const sources = [
    { type: 'packagedDefaults', file: '/synthetic/private/' + SECRET },
    { type: 'mdm', domain: SECRET, key: SECRET },
    { type: 'system', file: '/synthetic/private/' + SECRET },
    { type: 'enterpriseManaged', id: SECRET, name: SECRET },
    { type: 'user', file: '/synthetic/private/' + SECRET, profile: SECRET },
    { type: 'project', dotCodexFolder: '/synthetic/private/' + SECRET },
    { type: 'sessionFlags' },
    { type: 'legacyManagedConfigTomlFromFile', file: '/synthetic/private/' + SECRET },
    { type: 'legacyManagedConfigTomlFromMdm' },
  ];
  const snapshotKeys = Object.keys(observer.snapshot());
  observer.configRead(2, { cwd: '/synthetic' });
  const response = minimal();
  const layers = sources.map((name) => ({ name, version: 'v1', config: { env: SECRET }, disabledReason: null }));
  observer.push(wire({ id: 2, result: { ...response, layers } }));
  assert.deepEqual(observer.configurationSnapshot().layers.inventory.map((l) => l.source.state === 'known' && l.source.type),
    sources.map((s) => s.type));
  assert.deepEqual(Object.keys(observer.snapshot()), snapshotKeys);
  noSecrets(observer.configurationSnapshot(), observer.snapshot());
  assert.throws(() => observer.configRead(2, { cwd: '/synthetic' }), /reused_id/);
  assert.equal(observer.configurationSnapshot().status, 'unavailable');
});

test('same-chunk protocol gap or approval cannot commit a subsequent successful configuration', () => {
  for (const bad of [{ id: 999, result: minimal() }, { id: 900, method: 'approval', params: {} }]) {
    const observer = readyObserver();
    observer.configRead(2, { cwd: '/synthetic' });
    const events = observer.push(Buffer.concat([wire(bad), wire({ id: 2, result: minimal() })]));
    assert.equal(observer.configurationSnapshot().status, 'unavailable');
    const last = events[events.length - 1];
    assert.ok(last.kind === 'response' && !last.ok);
  }
});

test('actual owned child: ignored signals retain reaped:false uncertainty, then test cleans up exact child', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-config-reap-'));
  const client = new CodexAppServerTransport({
    executable: process.execPath, args: [resolve('tests/fixtures/codex-config-server.mjs'), 'unreaped'], cwd: home,
    env: { HOME: home, HUD_HOME: join(home, '.hud') }, requestTimeoutMs: 3000, lifetimeMs: 10000,
  });
  const child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
  const kill = child.kill.bind(child);
  try {
    await client.initialize();
    await client.configRead({ cwd: home });
    // Suppress only this test-owned child's two signals, not the product transport or peer path.
    child.kill = () => true;
    assert.deepEqual(await client.shutdown(), { code: null, signal: null, reaped: false });
  } finally {
    child.kill = kill;
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      kill('SIGKILL');
      await closed;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test('configuration receipt cannot serve as a verified capability cell; shipped manifests stay empty', async (t) => {
  const { client, home } = fixture(t);
  await client.initialize();
  const receipt = await client.configRead({ cwd: home });
  const request: ManagedCapabilityRequest = {
    configurationCoverage: 'partial', executableIdentity: { path: '/synthetic/codex', version: 'synthetic' },
    key: { harness: 'codex', profileDigest: 'synthetic', hostKind: 'none', layout: 'none', mode: 'headless', operation: 'spawn' },
    sourceId: 'synthetic', profileFingerprint: 'synthetic',
  };
  const versions: CapabilityVersions = {
    hudRevision: 'synthetic', harness: 'synthetic', host: 'synthetic', shell: 'synthetic', node: 'synthetic',
    platform: 'synthetic', kernel: 'synthetic', mcpClient: 'synthetic',
  };
  for (const configurationCoverage of ['partial', 'complete'] as const) {
    assert.equal(verifyManagedCapability({ ...request, configurationCoverage }, receipt as unknown as CapabilityCell, versions).ok, false);
    assert.equal(verifyManagedCapability({ ...request, configurationCoverage }, null, versions).ok, false);
  }
  for (const file of ['codex-cells.json', 'managed-cells.json']) {
    const manifest = JSON.parse(readFileSync(resolve('src/core/launch', file), 'utf8'));
    assert.deepEqual(manifest.cells, []);
  }
});

test('observer accepts exact projection/frame bounds and rejects over-bound versions without echo', () => {
  const observer = readyObserver();
  observer.configRead(2, { cwd: '/synthetic' });
  const metadata = { name: { type: 'sessionFlags' }, version: '"'.repeat(128) };
  const names = ['model', 'model_provider', 'model_reasoning_effort', 'sandbox_mode'];
  const origins = Object.fromEntries(names.map((name) => [name, metadata]));
  for (let i = 0; i < 60; i++) origins['ignored-' + i] = metadata;
  const config = {
    model: '"'.repeat(256), model_provider: 'é'.repeat(128), model_reasoning_effort: '"'.repeat(256),
    sandbox_mode: 'read-only', padding: '',
  };
  const response = {
    id: 2,
    result: {
      config, origins,
      layers: Array.from({ length: 32 }, () => ({ ...metadata, config: { secret: SECRET }, disabledReason: null })),
    },
  };
  config.padding = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(response)));
  assert.equal(wire(response).byteLength, 65537); // 64 KiB record plus its LF.
  observer.push(wire(response));
  const receipt = observer.configurationSnapshot();
  assert.equal(receipt.status, 'available');
  assert.equal(receipt.layers.inventory.length, 32);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 16384);
  noSecrets(receipt);
  observer.configRead(3, { cwd: '/synthetic' });
  observer.push(wire({
    id: 3, result: { config: {}, origins: { model: { ...metadata, version: SECRET.repeat(10) } }, layers: [] },
  }));
  assert.equal(observer.configurationSnapshot().fields.model.origin.state, 'unknown');
  noSecrets(observer.configurationSnapshot());
});
