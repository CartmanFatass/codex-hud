import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DurableJevLab, SimulatedJevReader } from '../fakes/jev-durable.js';
import { projectLinkTree, type CollectedLinkSession, type LinkTreeInput } from '../../src/core/link/index.js';
import { LinkTickCollector } from '../../src/core/link/tick.js';
import { simulationJobsSnapshot } from '../../src/core/link/job-display.js';
import { displayNodeKey } from '../../src/core/observation.js';
import { mergeStatus, STATUS_RULE_VERSION } from '../../src/core/status/merge.js';
import { loadLimits } from '../../src/core/link/limits.js';
import type { SessionRef } from '../../src/core/types/identity.js';
import type { LinkLedgerRead } from '../../src/core/link-ledger-read.js';
import { delegationView } from '../../src/render/delegation/panel.js';
import { resolveSelection } from '../../src/render/delegation/selection.js';

const parent: SessionRef = {
  harness: 'claude',
  sourceId: '1'.repeat(64),
  sessionId: 'synthetic-parent',
  threadId: null,
};
function collected(ref = parent): CollectedLinkSession {
  const identity = { kind: 'session' as const, ref },
    unknown = { value: null, quality: 'unknown' as const, source: 'synthetic:unavailable', asOf: 1000 };
  const coverage = { state: 'complete' as const, skipped: {}, gaps: [], loaded: true };
  const statusProjection = mergeStatus(
    {
      target: { nodeIdentity: identity, sourceGeneration: 1 },
      sources: [],
      asOfSeq: null,
      observationStamp: null,
      history: { continuity: 'unknown' },
    },
    null,
    STATUS_RULE_VERSION,
    1000
  ).projection;
  return {
    evidence: {
      ref,
      observation: {
        nodeIdentity: identity,
        statusProjection,
        conflict: null,
        spent: { tokens: unknown, costUsd: unknown },
        workspace: null,
        coverage,
        loaded: true,
        depth: 0,
        evidenceStamp: 'synthetic',
      },
      cwd: null,
      cwdSource: 'unknown',
      cwdAsOf: null,
      startedAt: 1000,
      version: null,
      model: unknown,
      context: unknown,
      reports: [],
      native: [],
      linkEvidence: [],
      caps: {},
    },
    sourceGeneration: 1,
    linkEvidenceCurrent: true,
    bytesRead: 0,
    recordsRead: 0,
    loaded: true,
    topology: { ref, sourceGeneration: 1, children: [], loaded: true, bytesRead: 0, recordsRead: 0, coverage },
  };
}
const ledger = (ledgerId = 'synthetic-ledger'): LinkLedgerRead => ({
  state: 'available',
  snapshot: {
    ledgerId,
    asOfSeq: 37,
    links: [],
    runs: [],
    claims: [],
    bindings: [],
    reports: [],
    events: [],
    evidence: [],
    slots: [],
  },
  claimChecks: [],
  conflictTargets: new Map(),
  reason: null,
});
const request = (id = 'one') => ({
  ref: { kind: 'jev' as const, provider: 'synthetic-provider', account: 'synthetic-account', key: `synthetic-${id}` },
  owner: 'synthetic-owner',
  browser: 'synthetic-browser',
  requestId: `synthetic-request-${id}`,
  requestFingerprint: `synthetic-fingerprint-${id}`,
  parentContext: { ledgerId: 'synthetic-ledger', ref: parent },
});
function fixture(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), 'jev-tree-')),
    path = join(home, 'jobs.sqlite'),
    lab = DurableJevLab.create(path);
  lab.enqueue(request());
  const reader = new SimulatedJevReader(path, lab.snapshot().storeId);
  t.after(() => {
    reader.close();
    lab.close();
    rmSync(home, { recursive: true, force: true });
  });
  const input = (): LinkTreeInput => ({
    ledger: ledger(),
    roots: [{ kind: 'session', ref: parent }],
    sessions: [collected()],
    simulationJobs: reader.snapshot(),
    nowMs: 1000,
  });
  return { home, path, lab, reader, input };
}

test('canonical full job identity, exact parent and separate counts, without managed/session authority', (t) => {
  const f = fixture(t),
    a = request();
  f.lab.enqueue({ ...request('two'), ref: { ...a.ref, account: 'synthetic-other' } });
  f.lab.enqueue({ ...request('three'), ref: { ...a.ref, provider: 'synthetic-other' } });
  const tree = projectLinkTree(f.input()),
    jobs = tree.nodes.filter((n) => n.identity.kind === 'job');
  assert.equal(jobs.length, 3);
  assert.equal(tree.counts.confirmedSessions, 1);
  assert.equal(tree.counts.jobs, 3);
  assert.equal(tree.ledger.asOfSeq, 37);
  assert.equal(tree.simulationJobs?.revision, 3);
  for (const node of jobs) {
    assert.equal(node.parentKey, displayNodeKey({ kind: 'session', ref: parent }));
    assert.equal(node.edge, 'simulation-job');
    assert.equal(node.observation, null);
    assert.equal(node.currentRun, null);
    assert.deepEqual(node.links, []);
    assert.equal(node.host, null);
    assert.equal(node.loaded, true);
    assert.equal(node.simulationJob?.provenance, 'SIMULATED');
  }
  const raw = f.lab.snapshot();
  raw.jobs[0].ref = { key: a.ref.key, account: a.ref.account, provider: a.ref.provider, kind: 'jev' };
  assert.equal(
    projectLinkTree({ ...f.input(), simulationJobs: raw }).nodes.find((n) => n.key === jobs[0].key)?.key,
    jobs[0].key
  );
});

test('different source, session parent, ledger or absent binding cannot acquire a display edge', (t) => {
  const f = fixture(t);
  for (const changed of [
    { ...parent, sourceId: '2'.repeat(64) },
    { ...parent, sessionId: 'synthetic-foreign' },
  ]) {
    const tree = projectLinkTree({
      ...f.input(),
      roots: [{ kind: 'session', ref: changed }],
      sessions: [collected(changed)],
    });
    assert.equal(tree.counts.jobs, 0);
  }
  assert.equal(projectLinkTree({ ...f.input(), ledger: ledger('synthetic-new-ledger') }).counts.jobs, 0);
  const raw = f.lab.snapshot();
  delete raw.jobs[0].parentContext;
  assert.equal(projectLinkTree({ ...f.input(), simulationJobs: raw }).counts.jobs, 0);
  assert.equal(
    projectLinkTree({ ...f.input(), ledger: { state: 'degraded', snapshot: null, reason: 'ledger_unavailable' } })
      .counts.jobs,
    0
  );
});

test('job-only collector updates invalidate warm memo, preserve selection, and never get run controls', async (t) => {
  const f = fixture(t),
    collector = new LinkTickCollector(
      { changeToken: () => 'fixed', read: () => ledger(), close() {} },
      f.home,
      loadLimits(f.home)
    );
  t.after(() => collector.close());
  const tick = () => collector.tick({ ...f.input() });
  let vm = (await tick())!;
  assert.ok(vm);
  assert.ok(collector.stats().projected);
  const key = displayNodeKey({ kind: 'job', ref: request().ref });
  const select = () => {
    const v = delegationView(vm, { nowMs: 1000, style: 'compact', showHistory: true });
    assert.equal(v.dest.rows.filter((r) => r.key === key).length, 1);
    assert.equal(resolveSelection(key, v.proj, v.plan, v.dest), key);
  };
  select();
  await tick();
  assert.equal(collector.stats().projected, false);
  const ticket = f.lab.consumeDispatch('synthetic-owner', request().ref, f.lab.snapshot().jobs[0].revision);
  vm = (await tick())!;
  assert.ok(collector.stats().projected);
  assert.equal(vm.tree.nodes.find((n) => n.key === key)?.simulationJob?.state, 'uncertain');
  select();
  f.lab.observe('synthetic-owner', request().ref, ticket.generation, ticket.revision, 'needs_human');
  vm = (await tick())!;
  assert.ok(collector.stats().projected);
  select();
  assert.equal(vm.tree.ledger.asOfSeq, 37);
  assert.equal(vm.details[key].statusSource, 'unavailable');
  assert.equal(vm.details[key].status, null);
  assert.equal(vm.details[key].reconcile, null);
  assert.equal(vm.details[key].resumable?.resumable, false);
  const changed = f.lab.snapshot();
  changed.jobs[0].label = 'synthetic-visible';
  changed.jobs[0].holderLabel = 'synthetic-visible';
  vm = (await collector.tick({ ...f.input(), simulationJobs: changed }))!;
  assert.ok(collector.stats().projected);
  assert.equal(vm.tree.nodes.find((n) => n.key === key)?.simulationJob?.holderLabel, 'synthetic-visible');
  const next = structuredClone(changed);
  next.jobs[0].generation = 2;
  next.jobs[0].lease!.generation = 2;
  vm = (await collector.tick({ ...f.input(), simulationJobs: next }))!;
  assert.ok(collector.stats().projected);
  assert.equal(vm.tree.nodes.find((n) => n.key === key)?.simulationJob?.generation, 2);
  const plain = new LinkTickCollector(
    { changeToken: () => 'fixed', read: () => ledger(), close() {} },
    f.home,
    loadLimits(f.home)
  );
  assert.equal(await plain.tick({ roots: f.input().roots, sessions: [collected()], nowMs: 1000 }), null);
  plain.close();
});

test('readonly consumers see reopen commits; unavailable snapshots retain only labelled same-store history', async (t) => {
  const f = fixture(t),
    second = new SimulatedJevReader(f.path, f.lab.snapshot().storeId);
  t.after(() => second.close());
  const writer = DurableJevLab.open(f.path, f.lab.snapshot().storeId);
  t.after(() => writer.close());
  const ticket = writer.consumeDispatch('synthetic-owner', request().ref, writer.snapshot().jobs[0].revision);
  assert.deepEqual(second.snapshot(), f.reader.snapshot());
  const collector = new LinkTickCollector(
    { changeToken: () => 'fixed', read: () => ledger(), close() {} },
    f.home,
    loadLimits(f.home)
  );
  t.after(() => collector.close());
  const current = (await collector.tick(f.input()))!;
  const key = displayNodeKey({ kind: 'job', ref: request().ref });
  for (const reason of ['store_busy', 'missing_store', 'corrupt_store']) {
    const unavailable = {
      provenance: 'SIMULATED',
      availability: 'unavailable',
      storeId: f.lab.snapshot().storeId,
      revision: null,
      jobs: [],
      reason,
    };
    const vm = (await collector.tick({ ...f.input(), simulationJobs: unavailable }))!;
    assert.equal(vm.tree.counts.jobs, 1);
    assert.equal(vm.tree.simulationJobs?.availability, 'unavailable');
    assert.equal(vm.tree.nodes.find((n) => n.key === key)?.simulationJob?.availability, 'last_known');
    assert.equal(vm.tree.nodes.find((n) => n.key === key)?.simulationJob?.answer, null);
    assert.equal(vm.tree.coverage.state, 'partial');
    assert.ok(collector.stats().projected || reason === 'store_busy');
  }
  const foreign = {
    provenance: 'SIMULATED',
    availability: 'unavailable',
    storeId: 'synthetic-store-00000000-0000-0000-0000-000000000000',
    revision: null,
    jobs: [],
    reason: 'missing_store',
  };
  const rejected = (await collector.tick({ ...f.input(), simulationJobs: foreign }))!;
  assert.equal(rejected.tree.counts.jobs, 0);
  assert.equal(rejected.tree.simulationJobs?.availability, 'unavailable');
  assert.equal(current.tree.nodes.find((n) => n.key === key)?.simulationJob?.generation, ticket.generation);
  const raw = new DatabaseSync(f.path);
  raw.exec('BEGIN EXCLUSIVE');
  const busy = f.reader.snapshot();
  assert.equal(busy.availability, 'unavailable');
  raw.exec('ROLLBACK');
  raw.exec('PRAGMA user_version=99');
  assert.equal(f.reader.snapshot().availability, 'unavailable');
  raw.close();
});

test('jobs share the 200-node and cross-depth budgets and exact omitted accounting', (t) => {
  const f = fixture(t);
  for (let i = 1; i < 128; i++) f.lab.enqueue(request(`job-${i}`));
  const others = Array.from({ length: 79 }, (_, i) => ({ ...parent, sessionId: `synthetic-root-${i}` }));
  const roots = [parent, ...others];
  const tree = projectLinkTree({
    ...f.input(),
    roots: roots.map((ref) => ({ kind: 'session', ref })),
    sessions: roots.map((ref) => collected(ref)),
    budget: { maxNodes: 999 },
  });
  assert.equal(tree.nodes.length, 200);
  assert.equal(tree.counts.omitted, 8);
  assert.equal(tree.counts.confirmedSessions + tree.counts.jobs, 200);
  assert.equal(new Set(tree.nodes.map((n) => n.key)).size, 200);
  const depth = projectLinkTree({ ...f.input(), budget: { maxCrossHarnessDepth: 0 } });
  assert.ok(
    depth.nodes
      .filter((n) => n.identity.kind === 'job')
      .every((n) => !n.loaded && !n.simulationJob && n.coverage.reason === 'depth')
  );
  assert.equal(projectLinkTree({ ...f.input(), budget: { maxNodes: 0 } }).counts.omitted, 129);
});

test('malformed display DTOs become explicit unavailable and never carry unsafe text or forged holder', (t) => {
  const f = fixture(t);
  for (const change of [
    (v: any) => (v.jobs[0].ref.key = 'unsafe\u001b[31m'),
    (v: any) => (v.jobs[0].holderLabel = 'synthetic-forged'),
    (v: any) => (v.jobs[0].parentContext.ref.sourceId = 'missing'),
    (v: any) => v.jobs.push(v.jobs[0]),
  ]) {
    const raw = f.lab.snapshot();
    change(raw);
    const result = simulationJobsSnapshot(raw);
    assert.equal(result.availability, 'unavailable');
    assert.deepEqual(result.jobs, []);
  }
});

test('retention allowlist never survives null/foreign identity, explicit mismatch, or a different parent ledger', async (t) => {
  const f = fixture(t),
    a = request(),
    ticket = f.lab.consumeDispatch(a.owner, a.ref, f.lab.snapshot().jobs[0].revision);
  f.lab.observe(a.owner, a.ref, ticket.generation, ticket.revision, 'answered', 'synthetic-evidence');
  f.lab.reconcile(
    a.owner,
    a.ref,
    ticket.generation,
    f.lab.snapshot().jobs[0].revision,
    'answered',
    'synthetic-evidence',
    'synthetic-answer'
  );
  let currentLedger = ledger(),
    token = 0;
  const collector = new LinkTickCollector(
    { changeToken: () => String(token), read: () => currentLedger, close() {} },
    f.home,
    loadLimits(f.home)
  );
  t.after(() => collector.close());
  const raw = f.lab.snapshot(),
    failed = (reason: string, storeId: string | null = raw.storeId) => ({
      provenance: 'SIMULATED',
      availability: 'unavailable',
      storeId,
      revision: null,
      jobs: [],
      reason,
    });
  for (const reason of [
    'store_busy',
    'missing_store',
    'private_path_required',
    'unsupported_format',
    'corrupt_store',
    'reader_closed',
  ]) {
    await collector.tick(f.input());
    const vm = (await collector.tick({ ...f.input(), simulationJobs: failed(reason) }))!;
    const node = vm.tree.nodes.find((n) => n.simulationJob)!;
    assert.ok(node);
    assert.equal(node.simulationJob!.availability, 'last_known');
    assert.equal(node.simulationJob!.answer, null);
    assert.equal(vm.tree.simulationJobs?.lastKnownRevision, raw.revision);
  }
  for (const [reason, id] of [
    ['store_identity_mismatch', raw.storeId],
    ['missing_store', null],
    ['missing_store', 'synthetic-store-00000000-0000-0000-0000-000000000000'],
  ] as const) {
    await collector.tick(f.input());
    const vm = (await collector.tick({ ...f.input(), simulationJobs: failed(reason, id) }))!;
    assert.equal(vm.tree.counts.jobs, 0);
    assert.equal(vm.tree.simulationJobs?.availability, 'unavailable');
    assert.equal(vm.tree.simulationJobs?.lastKnownRevision, null);
    const later = (await collector.tick({ ...f.input(), simulationJobs: failed('store_busy') }))!;
    assert.equal(later.tree.counts.jobs, 0);
  }
  await collector.tick(f.input());
  currentLedger = ledger('synthetic-other-ledger');
  token++;
  const changed = (await collector.tick({ ...f.input(), simulationJobs: failed('store_busy') }))!;
  assert.equal(changed.tree.counts.jobs, 0);
  currentLedger = ledger();
  token++;
  await collector.tick(f.input());
  const foreign = { ...parent, sourceId: '3'.repeat(64) };
  const scoped = (await collector.tick({
    ...f.input(),
    roots: [{ kind: 'session', ref: foreign }],
    sessions: [collected(foreign)],
    simulationJobs: failed('store_busy'),
  }))!;
  assert.equal(scoped.tree.counts.jobs, 0);
  assert.doesNotMatch(JSON.stringify(projectLinkTree(f.input())), /requestFingerprint|requestId|synthetic-owner/);
});

test('fix1 reader replacement cannot revive old-ledger job edges on busy or foreign first reads', async (t) => {
  const f = fixture(t);
  const collector = new LinkTickCollector(
    { changeToken: () => 'old', read: () => ledger(), close() {} },
    f.home,
    loadLimits(f.home)
  );
  t.after(() => collector.close());
  assert.equal((await collector.tick(f.input()))!.tree.counts.jobs, 1);
  let replacement: LinkLedgerRead = { state: 'degraded', snapshot: null, reason: 'ledger_busy' };
  collector.replaceReader({ changeToken: () => 'replacement', read: () => replacement, close() {} });
  const busy = (await collector.tick(f.input()))!;
  assert.equal(busy.tree.counts.jobs, 0);
  assert.equal(busy.tree.ledger.ledgerId, null);
  replacement = ledger('synthetic-replacement-ledger');
  const foreign = (await collector.tick(f.input()))!;
  assert.equal(foreign.tree.counts.jobs, 0);
  assert.equal(foreign.tree.ledger.ledgerId, 'synthetic-replacement-ledger');
});

test('fix1 whole-snapshot custody rejects null and competing browser holders before parent filtering', (t) => {
  const f = fixture(t),
    a = request(),
    b = request('two');
  b.ref.account = 'synthetic-other-account';
  f.lab.enqueue(b);
  const ticket = f.lab.consumeDispatch(a.owner, a.ref, f.lab.snapshot().jobs[0].revision);
  const held = f.lab.snapshot();
  const reject = (raw: any) => {
    assert.equal(simulationJobsSnapshot(raw).availability, 'unavailable');
    assert.equal(projectLinkTree({ ...f.input(), simulationJobs: raw }).counts.jobs, 0);
  };
  const queued = structuredClone(held);
  queued.jobs[1].lease = null;
  queued.jobs[1].parentContext!.ledgerId = 'synthetic-foreign-ledger';
  reject(queued);
  const competing = structuredClone(held);
  const second = competing.jobs[1];
  second.state = 'uncertain';
  second.dispatches = 1;
  second.generation = 1;
  second.lease = { ...competing.jobs[0].lease!, key: second.key };
  reject(competing);
  const generation = structuredClone(held);
  generation.jobs[1].lease!.generation++;
  reject(generation);
  f.lab.observe(a.owner, a.ref, ticket.generation, ticket.revision, 'answered', 'synthetic-evidence');
  f.lab.reconcile(
    a.owner,
    a.ref,
    ticket.generation,
    f.lab.snapshot().jobs[0].revision,
    'answered',
    'synthetic-evidence',
    'synthetic-answer'
  );
  f.lab.consumeDispatch(b.owner, b.ref, f.lab.snapshot().jobs[1].revision);
  const reconciled = f.lab.snapshot();
  assert.equal(simulationJobsSnapshot(reconciled).availability, 'available');
  reconciled.jobs[0].lease = null;
  reject(reconciled);
});

test('fix1 caches only bounded normalized fields and retains them without reparsing raw custody', async (t) => {
  const f = fixture(t);
  f.lab.consumeDispatch(request().owner, request().ref, f.lab.snapshot().jobs[0].revision);
  const collector = new LinkTickCollector(
    { changeToken: () => 'fixed', read: () => ledger(), close() {} },
    f.home,
    loadLimits(f.home)
  );
  t.after(() => collector.close());
  const raw: any = f.lab.snapshot();
  raw.extraFunction = () => 'not display';
  raw.jobs[0].extra = { callback: () => 'not display', text: 'private-extra-canary' };
  const vm = (await collector.tick({ ...f.input(), simulationJobs: raw }))!;
  assert.equal(vm.tree.counts.jobs, 1);
  const cache = (collector as any).lastSimulationJobs;
  assert.doesNotMatch(JSON.stringify(cache), /owner|requestId|requestFingerprint|private-extra-canary|extraFunction/);
  assert.equal((collector as any).lastInput.simulationJobs, cache);
  assert.ok(Object.isFrozen(cache) && Object.isFrozen(cache.jobs) && Object.isFrozen(cache.jobs[0].lease));
  assert.equal(Object.hasOwn(cache, 'extraFunction'), false);
  assert.equal(Object.hasOwn(cache.jobs[0], 'extra'), false);
  await collector.tick({ ...f.input(), simulationJobs: raw });
  assert.equal(collector.stats().projected, false);
  const historical = (await collector.tick({
    ...f.input(),
    simulationJobs: {
      provenance: 'SIMULATED',
      availability: 'unavailable',
      storeId: raw.storeId,
      revision: null,
      jobs: [],
      reason: 'store_busy',
    },
  }))!;
  assert.equal(historical.tree.counts.jobs, 1);
  const job = historical.tree.nodes.find((n) => n.simulationJob)!.simulationJob!;
  assert.equal(job.availability, 'last_known');
  assert.equal(job.lease!.generation, 1);
  assert.equal(job.answer, null);
  assert.doesNotMatch(JSON.stringify(historical), /private-extra-canary|synthetic-owner|requestFingerprint/);
});
