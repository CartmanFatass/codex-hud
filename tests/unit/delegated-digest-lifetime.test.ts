/** Real private SQLite/source fixtures and fake transport only; no renderer or live provider work. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { SmallModel } from '../../src/collectors/small-model.js';
import { loadLedgerSqlite } from '../../src/ledger/runtime.js';
import { planDelegatedDigest, runDelegatedDigest } from '../../src/core/materials/delegated-digest.js';
import { prepareDelegatedDigestPlan, revalidateDelegatedDigestPlan, disposeDelegatedDigestPlan,
  type DigestPlanLifetime } from '../../src/core/materials/delegated-digest-lifetime.js';
import { DigestFailure } from '../../src/core/materials/source-config.js';
import { digestFixture, deferredTransport, response, withResponseText, until, tick, SUMMARY, PRIVATE } from '../fixtures/delegated-digest.js';

const fetcher = (async () => response()) as typeof fetch;
const runtime = (f: Awaited<ReturnType<typeof digestFixture>>) => join(f.dir, 'model-runtime-v1');
const cached = (f: Awaited<ReturnType<typeof digestFixture>>) => {
  const dir = join(runtime(f), 'materials-v1');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
};
async function prepare(f: Awaited<ReturnType<typeof digestFixture>>) {
  const result = await prepareDelegatedDigestPlan(f.input);
  assert.ok(result.lifetime); assert.equal(result.plan.readiness.ready, true);
  return { plan: result.plan, lifetime: result.lifetime };
}
function change(f: Awaited<ReturnType<typeof digestFixture>>, kind: string) {
  if (kind === 'model-revision') f.write('model.json', { ...f.config, revision: 2 });
  if (kind === 'outbound-revision') f.write('outbound.json', { ...f.policy, revision: 2 });
  if (kind === 'reasoning') f.write('model.json', { ...f.config, connection: { ...f.config.connection, reasoning: true } });
  if (kind === 'cap') f.write('model.json', { ...f.config, delegatedDigest: { ...f.config.delegatedDigest, hourlyCap: 59 } });
  if (kind === 'key') f.env.SYNTHETIC_DIGEST_KEY = 'synthetic-rotated-key';
}
function restore(f: Awaited<ReturnType<typeof digestFixture>>) {
  f.write('model.json', f.config); f.write('outbound.json', f.policy);
  f.env.SYNTHETIC_DIGEST_KEY = 'synthetic-key';
}

for (const kind of ['model-revision', 'outbound-revision', 'reasoning', 'cap', 'key']) {
  test(`identical visible plan after ${kind} does not replace the original pre-confirm baseline`, async () => {
    const f = await digestFixture(); let lifetime: DigestPlanLifetime | undefined; const queries: string[] = [];
    let sends = 0;
    try {
      const original = await prepare(f); lifetime = original.lifetime;
      change(f, kind);
      assert.deepEqual(await planDelegatedDigest(f.input), original.plan);
      await assert.rejects(runDelegatedDigest(f.input, { planLifetime: lifetime,
        onQuery: (sql) => queries.push(sql), fetch: (async () => { sends++; return response(); }) as typeof fetch }),
        (e: unknown) => e instanceof DigestFailure && e.reason === 'plan_lifetime_invalid');
      assert.equal(sends, 0); assert.equal(queries.length, 0);
      assert.equal(fs.existsSync(runtime(f)), false);
      assert.equal(revalidateDelegatedDigestPlan(lifetime), false);
      restore(f); assert.equal(revalidateDelegatedDigestPlan(lifetime), false);
    } finally { if (lifetime) disposeDelegatedDigestPlan(lifetime); f.cleanup(); }
  });

  test(`retained ${kind} change permanently invalidates display authority; a new explicit action gets a different lifetime`, async () => {
    const f = await digestFixture(); let lifetime: DigestPlanLifetime | undefined;
    try {
      lifetime = (await prepare(f)).lifetime;
      const result = await runDelegatedDigest(f.input, { planLifetime: lifetime, fetch: fetcher });
      const generatedAt = result.generatedAt;
      assert.equal(revalidateDelegatedDigestPlan(lifetime), true);
      change(f, kind);
      assert.equal(revalidateDelegatedDigestPlan(lifetime), false);
      restore(f); assert.equal(revalidateDelegatedDigestPlan(lifetime), false);
      const next = await prepare(f);
      try { assert.notEqual(next.lifetime, lifetime); assert.equal(revalidateDelegatedDigestPlan(next.lifetime), true); }
      finally { disposeDelegatedDigestPlan(next.lifetime); }
      assert.equal(result.generatedAt, generatedAt); // The service never retimestamps returned immutable-by-convention DTOs.
    } finally { if (lifetime) disposeDelegatedDigestPlan(lifetime); f.cleanup(); }
  });
}

test('prepared handle is opaque, unforgeable and one-use; ordinary plan/run DTOs and delivery remain compatible', async () => {
  const f = await digestFixture();
  const original = await prepare(f);
  try {
    assert.equal(Object.isFrozen(original.lifetime), true);
    assert.deepEqual(Reflect.ownKeys(original.lifetime), []);
    assert.equal(JSON.stringify(original.lifetime), '{}');
    assert.deepEqual(await planDelegatedDigest(f.input), original.plan);
    let delivered: unknown;
    const result = await runDelegatedDigest(f.input, { planLifetime: original.lifetime, fetch: fetcher }, (value) => { delivered = value; });
    assert.equal(delivered, result); assert.equal(result.format, 'hud-delegated-digest');
    assert.equal(Object.hasOwn(result, 'lifetime'), false);
    assert.equal(Object.hasOwn(result, 'retention'), false);
    assert.equal(revalidateDelegatedDigestPlan(original.lifetime), true);
    const serialized = JSON.stringify({ plan: original.plan, result, lifetime: original.lifetime });
    for (const secret of ['synthetic-key', 'forbidden-key', SUMMARY, PRIVATE, f.home, 'SourceSnapshot', 'envelope'])
      assert.equal(serialized.includes(secret), false);
    await assert.rejects(runDelegatedDigest(f.input, { planLifetime: original.lifetime, fetch: fetcher }));
    assert.equal(revalidateDelegatedDigestPlan(original.lifetime), false);
    // Ordinary callers continue to use the existing fresh-invocation cache behavior.
    assert.equal((await runDelegatedDigest(f.input, { fetch: fetcher })).cached, true);
  } finally { disposeDelegatedDigestPlan(original.lifetime); disposeDelegatedDigestPlan(original.lifetime); f.cleanup(); }
});

for (const kind of ['forged', 'cloned', 'plan-as-token', 'disposed', 'home', 'run', 'report', 'ledger', 'recipient', 'env', 'mutated-input']) {
  test(`guarded ${kind} refuses before runtime, summary, cache/budget or fetch`, async () => {
    const f = await digestFixture(); const original = await prepare(f); let queries = 0; let sends = 0;
    try {
      let lifetime = original.lifetime; const input = { ...f.input };
      if (kind === 'forged') lifetime = Object.freeze({}) as DigestPlanLifetime;
      if (kind === 'cloned') lifetime = { ...original.lifetime } as DigestPlanLifetime;
      if (kind === 'plan-as-token') lifetime = original.plan as unknown as DigestPlanLifetime;
      if (kind === 'disposed') disposeDelegatedDigestPlan(lifetime);
      if (kind === 'home') input.home = join(f.home, 'different');
      if (kind === 'run') input.runId = 'other-run';
      if (kind === 'report') input.reportId = 'other-report';
      if (kind === 'ledger') input.expectedLedger = 'other-ledger';
      if (kind === 'recipient') input.expectedRecipient = '0'.repeat(64);
      if (kind === 'env') input.env = { ...f.env };
      if (kind === 'mutated-input') { f.input.runId = 'mutated-after-prepare'; input.runId = f.input.runId; }
      await assert.rejects(runDelegatedDigest(input, { planLifetime: lifetime, onQuery: () => { queries++; },
        fetch: (async () => { sends++; return response(); }) as typeof fetch }));
      assert.equal(queries, 0); assert.equal(sends, 0); assert.equal(fs.existsSync(runtime(f)), false);
    } finally { disposeDelegatedDigestPlan(original.lifetime); f.cleanup(); }
  });
}

test('guarded run freezes caller scalar identities but retains the live original env object', async () => {
  const f = await digestFixture(); const original = await prepare(f); const input = { ...f.input };
  let mutated = false;
  try {
    const result = await runDelegatedDigest(input, { planLifetime: original.lifetime, fetch: fetcher, onQuery() {
      if (!mutated) { mutated = true; input.home = '/synthetic/not-selected'; input.env = { SYNTHETIC_DIGEST_KEY: 'other-key' }; }
    } });
    assert.equal(result.runId, f.input.runId); assert.equal(mutated, true);
    f.env.SYNTHETIC_DIGEST_KEY = 'synthetic-rotated-key';
    assert.equal(revalidateDelegatedDigestPlan(original.lifetime), false);
  } finally { disposeDelegatedDigestPlan(original.lifetime); f.cleanup(); }
});

test('change after claim but before fresh source/material access is vetoed by the original authority chain', async () => {
  const f = await digestFixture(); const original = await prepare(f); let changed = false; let sends = 0;
  const queries: string[] = [];
  try {
    await assert.rejects(runDelegatedDigest(f.input, { planLifetime: original.lifetime,
      onQuery(sql) {
        queries.push(sql);
        if (!changed) { changed = true; f.env.SYNTHETIC_DIGEST_KEY = 'synthetic-rotated-key'; }
      }, fetch: (async () => { sends++; return response(); }) as typeof fetch }));
    assert.equal(changed, true); assert.equal(sends, 0);
    assert.equal(queries.some((sql) => sql.startsWith('SELECT summary')), false);
    assert.equal(fs.existsSync(runtime(f)), false);
    restore(f); assert.equal(revalidateDelegatedDigestPlan(original.lifetime), false);
  } finally { disposeDelegatedDigestPlan(original.lifetime); f.cleanup(); }
});

for (const phase of ['headers', 'body']) {
  test(`deferred ${phase} disposal cancels promptly and late completion cannot return or cache a result`, async () => {
    const f = await digestFixture(); const original = await prepare(f); const transport = deferredTransport();
    let readBody = false; let settleBody!: (value: string) => void;
    const body = new Promise<string>((resolve) => { settleBody = resolve; });
    let delivered = false;
    const pending = runDelegatedDigest(f.input, { planLifetime: original.lifetime, fetch: transport.fetcher }, () => { delivered = true; });
    const rejected = assert.rejects(pending);
    try {
      await until(() => transport.calls.length === 1);
      if (phase === 'body') {
        transport.calls[0].resolve(withResponseText(response(), () => { readBody = true; return body; }));
        await until(() => readBody);
      }
      disposeDelegatedDigestPlan(original.lifetime);
      await rejected;
      transport.calls[0].resolve(response()); settleBody(await response().text()); await tick(); await tick();
      assert.equal(delivered, false); assert.deepEqual(cached(f), []);
      assert.equal(transport.calls.length, 1); // Those transmitted bytes are not recalled.
      assert.equal(revalidateDelegatedDigestPlan(original.lifetime), false);
    } finally { disposeDelegatedDigestPlan(original.lifetime); transport.calls.forEach((c) => c.resolve(response())); settleBody(await response().text()); await pending.catch(() => {}); f.cleanup(); }
  });
}

test('revocation while waiting for generic coordination cannot reuse the first response/cache or send again', async () => {
  const f = await digestFixture(); const original = await prepare(f); const transport = deferredTransport();
  const firstController = new AbortController(); let delivered = false;
  const first = runDelegatedDigest(f.input, { fetch: transport.fetcher, signal: firstController.signal });
  const firstRejected = assert.rejects(first);
  let second: Promise<unknown> | undefined;
  try {
    await until(() => transport.calls.length === 1);
    let reads = 0;
    second = runDelegatedDigest(f.input, { planLifetime: original.lifetime, fetch: transport.fetcher,
      onQuery(sql) { if (sql.startsWith('SELECT summary')) reads++; } }, () => { delivered = true; });
    const secondRejected = assert.rejects(second);
    await until(() => reads > 0);
    f.write('outbound.json', { ...f.policy, revision: 2, grants: [] });
    assert.equal(revalidateDelegatedDigestPlan(original.lifetime), false);
    restore(f);
    firstController.abort(); transport.calls[0].resolve(response());
    await firstRejected; await secondRejected; await tick(); await tick();
    assert.equal(delivered, false); assert.equal(transport.calls.length, 1); assert.deepEqual(cached(f), []);
  } finally { firstController.abort(); disposeDelegatedDigestPlan(original.lifetime); transport.calls.forEach((c) => c.resolve(response())); await first.catch(() => {}); await second?.catch(() => {}); f.cleanup(); }
});

for (const during of ['dispose', 'key', 'abort']) {
  test(`${during} during asynchronous cleanup vetoes a successful return and disposes the original baseline`, async () => {
    const f = await digestFixture(); const original = await prepare(f); const controller = new AbortController();
    const oldFlush = SmallModel.prototype.flushTelemetry;
    let entered = false; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    SmallModel.prototype.flushTelemetry = async function () { entered = true; await gate; await oldFlush.call(this); };
    const pending = runDelegatedDigest(f.input, { planLifetime: original.lifetime, fetch: fetcher, signal: controller.signal });
    const rejected = assert.rejects(pending);
    try {
      await until(() => entered);
      if (during === 'dispose') disposeDelegatedDigestPlan(original.lifetime);
      if (during === 'key') f.env.SYNTHETIC_DIGEST_KEY = 'synthetic-rotated-key';
      if (during === 'abort') controller.abort();
      release(); await rejected;
      assert.equal(revalidateDelegatedDigestPlan(original.lifetime), false);
      restore(f); assert.equal(revalidateDelegatedDigestPlan(original.lifetime), false);
    } finally { release(); await pending.catch(() => {}); SmallModel.prototype.flushTelemetry = oldFlush; disposeDelegatedDigestPlan(original.lifetime); f.cleanup(); }
  });
}

test('preparation and revalidation stay metadata-only without runtime scans, writes, material hashes or network', async () => {
  const f = await digestFixture(); let lifetime: DigestPlanLifetime | null = null;
  const queries: string[] = []; const opened: string[] = [];
  const oldOpen = fs.openSync; const oldReadDir = fs.readdirSync; const oldMkdir = fs.mkdirSync; const oldWrite = fs.writeFileSync;
  const oldFetch = globalThis.fetch;
  try {
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      opened.push(String(args[0])); return oldOpen(...args);
    }) as typeof fs.openSync;
    fs.readdirSync = (() => { throw new Error('no runtime scan'); }) as typeof fs.readdirSync;
    fs.mkdirSync = (() => { throw new Error('no directory creation'); }) as typeof fs.mkdirSync;
    fs.writeFileSync = (() => { throw new Error('no writes'); }) as typeof fs.writeFileSync;
    globalThis.fetch = (async () => { throw new Error('no transport'); }) as typeof fetch;
    syncBuiltinESMExports();
    const prepared = await prepareDelegatedDigestPlan(f.input, { onQuery: (sql) => queries.push(sql) });
    lifetime = prepared.lifetime; assert.ok(lifetime);
    assert.equal(revalidateDelegatedDigestPlan(lifetime), true);
    assert.equal(queries.some((sql) => sql.startsWith('SELECT summary')), false);
    assert.equal(queries.some((sql) => /SELECT\s+(?:\*|path|claim|payload)/i.test(sql)), false);
    assert.ok(opened.length > 0);
    assert.equal(opened.some((path) => path.includes('model-runtime-v1')), false);
    assert.equal(fs.existsSync(runtime(f)), false);
    assert.equal(JSON.stringify(prepared).includes(SUMMARY), false);
  } finally {
    fs.openSync = oldOpen; fs.readdirSync = oldReadDir; fs.mkdirSync = oldMkdir; fs.writeFileSync = oldWrite;
    globalThis.fetch = oldFetch; syncBuiltinESMExports(); if (lifetime) disposeDelegatedDigestPlan(lifetime); f.cleanup();
  }
});

test('owned read-only connections close on ordinary plan, late preparation, failure and retained disposal; no transaction spans awaits', async () => {
  const f = await digestFixture(); const { DatabaseSync: Constructor } = await loadLedgerSqlite();
  const oldExec = Constructor.prototype.exec; const oldClose = Constructor.prototype.close;
  const live = new Set<DatabaseSync>(); const transactions = new Set<DatabaseSync>();
  Constructor.prototype.exec = function (sql: string) {
    if (this !== f.db) live.add(this);
    if (sql === 'BEGIN') transactions.add(this);
    try { return oldExec.call(this, sql); }
    finally { if (sql === 'COMMIT' || sql === 'ROLLBACK') transactions.delete(this); }
  };
  Constructor.prototype.close = function () {
    try { return oldClose.call(this); } finally { live.delete(this); transactions.delete(this); }
  };
  let lifetime: DigestPlanLifetime | undefined;
  try {
    await planDelegatedDigest(f.input); assert.equal(live.size, 0); assert.equal(transactions.size, 0);
    // Simulate a controller epoch becoming stale while the factory is still awaiting preparation.
    const pendingPlan = prepareDelegatedDigestPlan(f.input);
    const stale = await pendingPlan;
    assert.ok(stale.lifetime); disposeDelegatedDigestPlan(stale.lifetime);
    assert.equal(live.size, 0);
    lifetime = (await prepare(f)).lifetime;
    assert.equal(live.size, 1); assert.equal(transactions.size, 0);
    const result = await runDelegatedDigest(f.input, { planLifetime: lifetime, fetch: (async () => {
      assert.equal(live.size, 2); assert.equal(transactions.size, 0);
      await tick(); assert.equal(transactions.size, 0); return response();
    }) as typeof fetch });
    assert.equal(result.format, 'hud-delegated-digest');
    assert.equal(live.size, 1); assert.equal(transactions.size, 0);
    assert.equal(revalidateDelegatedDigestPlan(lifetime), true);
    disposeDelegatedDigestPlan(lifetime); assert.equal(live.size, 0);
    const bad = await prepare(f);
    f.env.SYNTHETIC_DIGEST_KEY = 'synthetic-rotated-key';
    await assert.rejects(runDelegatedDigest(f.input, { planLifetime: bad.lifetime, fetch: fetcher }));
    assert.equal(live.size, 0); assert.equal(transactions.size, 0);
  } finally {
    if (lifetime) disposeDelegatedDigestPlan(lifetime);
    Constructor.prototype.exec = oldExec; Constructor.prototype.close = oldClose; f.cleanup();
  }
});

test('not-ready plan returns no lifetime and does not initialize anything', async () => {
  const f = await digestFixture();
  try {
    f.write('model.json', { ...f.config, materials: [] });
    const prepared = await prepareDelegatedDigestPlan(f.input);
    assert.equal(prepared.lifetime, null);
    assert.deepEqual(prepared.plan, await planDelegatedDigest(f.input));
    assert.equal(prepared.plan.readiness.reason, 'material_scope_denied');
    assert.equal(fs.existsSync(runtime(f)), false);
  } finally { f.cleanup(); }
});

test('duplicate concurrent claim starts no second request and terminally cancels the attempted lifetime', async () => {
  const f = await digestFixture(); const original = await prepare(f); const transport = deferredTransport();
  const first = runDelegatedDigest(f.input, { planLifetime: original.lifetime, fetch: transport.fetcher });
  const rejected = assert.rejects(first);
  try {
    await until(() => transport.calls.length === 1);
    let queries = 0;
    await assert.rejects(runDelegatedDigest(f.input, { planLifetime: original.lifetime,
      onQuery: () => { queries++; }, fetch: transport.fetcher }));
    await rejected;
    assert.equal(queries, 0); assert.equal(transport.calls.length, 1);
    transport.calls[0].resolve(response()); await tick(); await tick();
    assert.deepEqual(cached(f), []); assert.equal(revalidateDelegatedDigestPlan(original.lifetime), false);
  } finally { disposeDelegatedDigestPlan(original.lifetime); transport.calls.forEach((c) => c.resolve(response())); await first.catch(() => {}); f.cleanup(); }
});

test('successful release removes its stop listener before retained disposal', async () => {
  const f = await digestFixture(); const original = await prepare(f);
  const oldCancel = SmallModel.prototype.cancelAll; let cancellations = 0;
  SmallModel.prototype.cancelAll = function () { cancellations++; return oldCancel.call(this); };
  try {
    await runDelegatedDigest(f.input, { planLifetime: original.lifetime, fetch: fetcher });
    const before = cancellations; assert.ok(before > 0);
    disposeDelegatedDigestPlan(original.lifetime);
    assert.equal(cancellations, before);
    assert.equal(revalidateDelegatedDigestPlan(original.lifetime), false);
  } finally { SmallModel.prototype.cancelAll = oldCancel; disposeDelegatedDigestPlan(original.lifetime); f.cleanup(); }
});

for (const kind of ['pre-abort', 'timeout', 'model-failure']) {
  test(`${kind} disposes the consumed or attempted lifetime`, async () => {
    const f = await digestFixture(); const original = await prepare(f); const transport = deferredTransport();
    const controller = new AbortController();
    if (kind === 'pre-abort') controller.abort();
    const pending = runDelegatedDigest(f.input, { planLifetime: original.lifetime, signal: controller.signal,
      ...(kind === 'timeout' ? { deadlineMs: 500 } : {}),
      fetch: kind === 'model-failure' ? (async () => { throw new Error(PRIVATE); }) as typeof fetch : transport.fetcher });
    try {
      await assert.rejects(pending);
      assert.equal(revalidateDelegatedDigestPlan(original.lifetime), false);
      if (kind === 'pre-abort') assert.equal(fs.existsSync(runtime(f)), false);
      transport.calls.forEach((c) => c.resolve(response())); await tick(); await tick();
      assert.deepEqual(cached(f), []);
    } finally { controller.abort(); disposeDelegatedDigestPlan(original.lifetime); transport.calls.forEach((c) => c.resolve(response())); await pending.catch(() => {}); f.cleanup(); }
  });
}
