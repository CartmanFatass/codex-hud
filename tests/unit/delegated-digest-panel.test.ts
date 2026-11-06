/** Synthetic only: real private SQLite/source files and fake network, plus controllable late promises. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { SmallModel } from '../../src/collectors/small-model.js';
import { loadLedgerSqlite } from '../../src/ledger/runtime.js';
import { frameDiff } from '../../src/render/frame-diff.js';
import { DelegatedDigestPanel, DelegatedDigestPage, type DigestPageContext, type DigestPanelServices } from '../../src/collectors/delegated-digest-panel.js';
import { planDelegatedDigest, runDelegatedDigest, type DigestDocument } from '../../src/core/materials/delegated-digest.js';
import { renderDigestModal, digestModalOwnsInput, type DigestPanelTarget } from '../../src/render/delegated-digest.js';
import { renderMonitor } from '../../src/render/monitor.js';
import { digestFixture, response, deferredTransport, until, tick, withResponseText } from '../fixtures/delegated-digest.js';
import { prepareDelegatedDigestPlan, revalidateDelegatedDigestPlan, disposeDelegatedDigestPlan,
  type DigestPlanLifetime } from '../../src/core/materials/delegated-digest-lifetime.js';
import { buildVm, S, NOW } from '../fixtures/b10b-delegation.js';
import { press, monitorInput } from '../fixtures/b10b-s3.js';

const target: DigestPanelTarget = { key: 'synthetic-selection', ledgerId: 'synthetic-ledger', linkId: 'synthetic-link',
  runId: 'synthetic-run', reportId: 'synthetic-report',
  ref: { harness: 'claude', sourceId: 'a'.repeat(64), sessionId: 'synthetic-child', threadId: null } };
const input = { home: '/synthetic/unused', env: {}, runId: target.runId, reportId: target.reportId };
function plan(): Awaited<ReturnType<typeof planDelegatedDigest>> {
  return { format: 'hud-delegated-digest-plan', schemaVersion: 1, ...target, origin: 'delegated', purpose: 'digest',
    field: 'result', material: { kind: 'completed_report_summary', status: 'completed', bytes: 12,
      acceptedSeq: 1, acceptedAt: 100, coverage: 'one_report_summary' },
    configuration: { model: `sources/${target.ref.sourceId}/model.json`, outbound: `sources/${target.ref.sourceId}/outbound.json` },
    recipientId: 'synthetic-recipient', endpoint: 'https://synthetic.invalid/v1/chat/completions',
    account: 'synthetic-account', model: 'synthetic-model', language: 'en', readiness: { ready: true, reason: 'ready' } };
}
const document = (): DigestDocument => ({ format: 'hud-delegated-digest', schemaVersion: 1, ...target,
  origin: 'delegated', purpose: 'digest', material: 'completed_report_summary', recipientId: 'synthetic-recipient',
  model: 'synthetic-model', language: 'en', generatedAt: 100, cached: false, digest: { conclusion: 'Synthetic conclusion.' } });
const coreServices: DigestPanelServices = { prepare: prepareDelegatedDigestPlan,
  revalidate: revalidateDelegatedDigestPlan, dispose: disposeDelegatedDigestPlan, run: runDelegatedDigest };
function mockServices(overrides: Partial<DigestPanelServices> = {}): DigestPanelServices {
  return { prepare: async () => ({ plan: plan(), lifetime: Object.freeze({}) as DigestPlanLifetime }),
    revalidate: () => true, dispose: () => {}, run: async () => document(), ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('production page read/completion/ordinary-collection seam uses real core and records underlying metadata I/O', async (context) => {
  const f = await digestFixture();
  let controller: DelegatedDigestPanel | undefined;
  try {
    const planned = await planDelegatedDigest(f.input);
    const built = buildVm([{ id: 'main', root: true, status: S.working() },
      { id: 'child', parent: 'main', harness: 'claude', status: S.working(), report: { status: 'completed', at: NOW } }]);
    built.vm.tree.ledger.state = 'available'; built.vm.tree.ledger.ledgerId = planned.ledgerId;
    const node = built.vm.tree.nodes.find((row) => row.key === built.keys.child)!;
    node.identity = { kind: 'session', ref: { ...f.ref } };
    node.currentRun = { ...node.currentRun!, runId: planned.runId, linkId: planned.linkId }; node.links = [planned.linkId];
    const report = built.vm.details[node.key].latestReportForRun!;
    report.runId = planned.runId; report.linkId = planned.linkId; report.reportId = planned.reportId;
    const data = monitorInput(built.vm, { selected: node.key, width: 120, height: 50 });
    const frame = renderMonitor(data);
    const action = press(frame, 'delegation-digest').action;
    if (action?.type !== 'delegation-digest') throw new Error('missing real frame action');
    let sends = 0; let plans = 0; let validations = 0;
    const queries: string[] = [];
    const trace: Array<{ kind: string; queries: number; phase: string }> = [];
    // Observe real file opens/reads and real SQLite transactions, without substituting their behavior.
    const { DatabaseSync } = await loadLedgerSqlite();
    const exec = context.mock.method(DatabaseSync.prototype, 'exec');
    const opens = context.mock.method(fs, 'openSync');
    const reads = context.mock.method(fs, 'readSync');
    syncBuiltinESMExports();
    const io = () => ({ queries: queries.length,
      begin: exec.mock.calls.filter((call) => call.arguments[0] === 'BEGIN').length,
      commit: exec.mock.calls.filter((call) => call.arguments[0] === 'COMMIT').length,
      model: opens.mock.calls.filter((call) => call.arguments[0] === join(f.dir, 'model.json')).length,
      outbound: opens.mock.calls.filter((call) => call.arguments[0] === join(f.dir, 'outbound.json')).length,
      // readPrivateJson performs one nonempty read plus one EOF read on each small synthetic JSON file.
      reads: reads.mock.calls.length,
    });
    type IO = ReturnType<typeof io>;
    const delta = (before: IO) => Object.fromEntries(Object.entries(io()).map(([key, value]) => [key, value - before[key as keyof IO]]));
    const record = (kind: string) => trace.push({ kind, queries: queries.length, phase: controller!.snapshot.phase });
    controller = new DelegatedDigestPanel({ ...coreServices,
      prepare: (value) => { plans++; return prepareDelegatedDigestPlan(value, { onQuery: (sql) => queries.push(sql) }); },
      revalidate: (lifetime) => { validations++; record('revalidate'); return revalidateDelegatedDigestPlan(lifetime); },
      run: (value, options, deliver) => runDelegatedDigest(value, { ...options, fetch: (async () => {
        sends++; return response();
      }) as typeof fetch }, deliver),
    });
    const panel = controller;
    const state: DigestPageContext = { state: data.state, monitor: { tree: data.tree, frame },
      surfaces: { settingsPage: null, settingsLeave: null, activityHub: null, observability: null, logsOpen: false },
      mouse: true, mainPane: false, closed: false, home: f.home, env: f.env, target: action.target, scope: 'synthetic-root',
      frameRoot: 'root', currentRoot: 'root', frameEpoch: 1, currentEpoch: 1 };
    let lastPaint: string[] | null = null;
    let queuedBytes = 0;
    let modal = renderDigestModal(panel.snapshot, 120, 50);
    const timerSamples: number[] = [];
    const paint = () => {
      page.synchronize();
      const drawn = renderMonitor({ ...data, state: state.state, delegatedDigest: panel.snapshot });
      modal = renderDigestModal(panel.snapshot, 120, 50, page.offset);
      const lines = digestModalOwnsInput(panel.snapshot) ? modal.lines : drawn.lines;
      const update = frameDiff(lastPaint, lines); lastPaint = lines;
      if (update) queuedBytes += Buffer.byteLength(update); // Synthetic write enqueue, never a terminal write.
      state.monitor.frame = drawn; state.frameEpoch = state.currentEpoch;
      record('paint');
    };
    const page = new DelegatedDigestPage(panel, { context: () => state, sync: () => page.synchronize(),
      modalFrame: () => modal, setState: (next) => { state.state = next; }, paint,
      focusPanel: () => {}, focusMain: () => {}, pauseModels: () => {}, close: () => { state.closed = true; },
      forward: () => { throw new Error('must not forward'); },
      timeAsync: async (name, work) => { assert.equal(name, 'digest.revalidate'); record('timer-start');
        const start = performance.now(); await work(); timerSamples.push(performance.now() - start); record('timer-end'); },
    });
    page.synchronize();
    const read = () => assert.deepEqual([...page.inputs([{ type: 'command', command: 'delegation-digest' }])], []);
    const preparationSamples: number[] = [];
    // Focused current target only: no historical populations, all-node scans, model calls or account operations.
    for (let i = 0; i < 13; i++) {
      const before = io(); const start = performance.now();
      read(); await until(() => panel.snapshot.phase === 'confirm');
      if (i >= 3) preparationSamples.push(performance.now() - start);
      assert.deepEqual(delta(before), { queries: 18, begin: 6, commit: 6, model: 4, outbound: 4, reads: 16 });
      assert.equal(sends, 0);
      if (i !== 12) [...page.inputs([{ type: 'key', key: 'escape' }])];
    }
    assert.ok(queries.every((sql) => !/SELECT\s+(?:[\w.]+\.)?summary\b/i.test(sql)), 'preparation projects metadata only');
    await Promise.all([page.confirm(), page.confirm()]);
    assert.equal(sends, 1); assert.equal(panel.snapshot.phase, 'result');
    assert.equal(state.state.focus, 'details'); assert.equal(state.state.keys, true);
    const retained = panel.snapshot;
    const resultFrame = renderMonitor({ ...data, state: { ...state.state, zoom: true }, delegatedDigest: panel.snapshot });
    const details = resultFrame.panes.find((pane) => pane.id === 'details')!.rows.map((row) => row.text).join('\n');
    assert.match(details, /Model summary · one completed report/); assert.match(details, /Input validation is implemented/);
    assert.equal(node.currentRun.state, 'running');
    const noIo = io();
    for (const cause of ['clock', 'model', 'unchanged'] as const) {
      if (cause === 'model') state.currentEpoch++;
      for (let i = 0; i < 5; i++) paint();
      assert.deepEqual(io(), noIo, `${cause} paints must not read target or config`);
    }
    const before = io(); const beforeTrace = trace.length; const beforePlans = plans;
    const completion = page.ordinaryCollectionCompleted();
    assert.equal(panel.snapshot.result, undefined, 'actual hook hides before the first metadata observation');
    assert.equal(validations, 0);
    for (let i = 0; i < 5; i++) paint();
    await Promise.all([completion, page.ordinaryCollectionCompleted()]);
    assert.equal(validations, 1); assert.equal(plans, beforePlans); assert.equal(panel.snapshot, retained);
    assert.deepEqual(delta(before), { queries: 9, begin: 3, commit: 3, model: 2, outbound: 2, reads: 8 });
    const observed = trace.slice(beforeTrace);
    assert.equal(observed[0].kind, 'timer-start');
    assert.equal(observed.at(-1)!.kind, 'timer-end');
    const firstCheck = observed.findIndex((entry) => entry.kind === 'revalidate');
    assert.ok(firstCheck > 0);
    assert.ok(observed.slice(1, firstCheck).every((entry) => entry.kind === 'paint' && entry.phase === 'rechecking' && entry.queries === before.queries));
    assert.ok(observed.slice(firstCheck + 1).some((entry) => entry.kind === 'paint' && entry.phase === 'result' && entry.queries === before.queries + 9));
    assert.ok(queuedBytes > 0);
    const describe = (scope: string, values: number[], warmup: number) => {
      const sorted = [...values].sort((a, b) => a - b);
      const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
      context.diagnostic(JSON.stringify({ scope, host: `${process.platform}/${process.arch}/${process.version}`,
        n: sorted.length, warmup, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: sorted.at(-1) }));
      return sorted;
    };
    assert.ok(describe('real metadata preparation + page settle; no transport', preparationSamples, 3).at(-1)! < 3000);
    for (let run = 0; run < 3; run++) {
      const samples: number[] = [];
      for (let i = 0; i < 23; i++) {
        const before = io(); await page.ordinaryCollectionCompleted();
        assert.deepEqual(delta(before), { queries: 9, begin: 3, commit: 3, model: 2, outbound: 2, reads: 8 });
        if (i >= 3) samples.push(timerSamples.at(-1)!);
      }
      const sorted = describe(`ordinary completion hook ${run}: real metadata + two render/diff/memory enqueue paints; excludes preceding collectors and real stdout`, samples, 3);
      assert.ok(sorted[Math.ceil(sorted.length * .99) - 1] < 50, 'focused completion p99 < 50 ms');
      assert.ok(sorted.at(-1)! < 200, 'focused completion max < 200 ms');
    }
    f.write('outbound.json', { ...f.policy, revision: 2, grants: [] });
    await page.ordinaryCollectionCompleted(); assert.equal(panel.snapshot.result, undefined);
    f.write('outbound.json', f.policy);
    const invalidated = io(); const checks = validations;
    await page.ordinaryCollectionCompleted(); paint();
    assert.deepEqual(io(), invalidated); assert.equal(validations, checks); assert.equal(sends, 1);
    page.shutdown();
  } finally {
    controller?.cancel(); context.mock.restoreAll(); syncBuiltinESMExports(); f.cleanup();
  }
});

test('real current core rejects policy changed after confirmation metadata and before run with zero sends', async () => {
  const f = await digestFixture();
  let sends = 0;
  let controller: DelegatedDigestPanel | undefined;
  try {
    const p = await planDelegatedDigest(f.input);
    const selected = { ...target, ledgerId: p.ledgerId, ref: p.ref };
    controller = new DelegatedDigestPanel({ ...coreServices, run: (value, options, deliver) => {
      f.write('outbound.json', { ...f.policy, revision: 2, grants: [] });
      return runDelegatedDigest(value, { ...options, fetch: (async () => { sends++; return response(); }) as typeof fetch }, deliver);
    } });
    await controller.activate(selected, f.input);
    await controller.confirm();
    assert.equal(sends, 0);
    assert.equal(controller.snapshot.phase, 'failed');
    assert.equal(controller.snapshot.result, undefined);
  } finally { controller?.cancel(); f.cleanup(); }
});

test('off, paused, disabled, absent scope and absent grants never call run or send', async () => {
  for (const mode of ['off', 'paused', 'disabled', 'scope', 'grant'] as const) {
    const f = await digestFixture();
    let runs = 0;
    let controller: DelegatedDigestPanel | undefined;
    try {
      const p = await planDelegatedDigest(f.input);
      if (mode === 'off') f.write('model.json', { ...f.config, connection: { backend: 'off' } });
      if (mode === 'paused') f.write('model.json', { ...f.config, delegatedDigest: { ...f.config.delegatedDigest, paused: true } });
      if (mode === 'disabled') f.write('model.json', { ...f.config, delegatedDigest: { ...f.config.delegatedDigest, enabled: false } });
      if (mode === 'scope') f.write('model.json', { ...f.config, materials: [] });
      if (mode === 'grant') f.write('outbound.json', { ...f.policy, grants: [] });
      controller = new DelegatedDigestPanel({ ...coreServices, run: async () => { runs++; throw new Error('must not run'); } });
      await controller.activate({ ...target, ledgerId: p.ledgerId, ref: p.ref }, f.input);
      await controller.confirm();
      assert.equal(runs, 0, mode);
      assert.equal(controller.snapshot.confirmation?.ready, false, mode);
    } finally { controller?.cancel(); f.cleanup(); }
  }
});

test('selection/root/report/ledger/thread invalidation discards delayed plan and does not replace the target', async () => {
  for (const replacement of [null, { ...target, reportId: 'next-report' }, { ...target, ledgerId: 'other-ledger' },
    { ...target, ref: { ...target.ref, threadId: 'other-thread' } }]) {
    const pending = deferred<Awaited<ReturnType<typeof prepareDelegatedDigestPlan>>>();
    let disposed = 0;
    let runs = 0;
    const controller = new DelegatedDigestPanel(mockServices({ prepare: () => pending.promise,
      dispose: () => { disposed++; }, run: async () => { runs++; return document(); } }));
    controller.bind(target, 'root-1');
    const work = controller.activate(target, input);
    controller.bind(replacement, 'root-2');
    pending.resolve({ plan: plan(), lifetime: Object.freeze({}) as DigestPlanLifetime });
    await work;
    assert.equal(controller.snapshot.phase, 'idle');
    assert.equal(runs, 0);
    assert.equal(disposed, 1, 'late preparation closes its original connection');
  }
});

test('one request, repeated activation/confirm, cancel and newer target suppress an uncooperative completion', async () => {
  let runs = 0;
  const pending = deferred<DigestDocument>();
  let signal: AbortSignal | undefined;
  const controller = new DelegatedDigestPanel(mockServices({ run: async (_input, options) => {
    runs++; signal = options?.signal; return pending.promise;
  } }));
  controller.bind(target, 'root');
  await controller.activate(target, input);
  const request = controller.confirm();
  await tick();
  await controller.confirm();
  await controller.activate(target, input);
  assert.equal(runs, 1);
  controller.cancel();
  assert.equal(signal?.aborted, true);
  controller.bind({ ...target, reportId: 'new-report' }, 'root');
  pending.resolve(document());
  await request;
  assert.equal(controller.snapshot.result, undefined);
});

test('concurrent ordinary completion has one original-baseline check; failure permanently erases the result', async () => {
  let preparations = 0;
  let validations = 0;
  let disposed = 0;
  const controller = new DelegatedDigestPanel(mockServices({ prepare: async () => {
    preparations++; return { plan: plan(), lifetime: Object.freeze({}) as DigestPlanLifetime };
  }, revalidate: () => { validations++; return false; }, dispose: () => { disposed++; } }));
  await controller.activate(target, input);
  await controller.confirm();
  const first = controller.collectionCompleted();
  const second = controller.collectionCompleted();
  assert.equal(controller.snapshot.result, undefined);
  assert.equal(validations, 0, 'display hidden before the scheduled metadata check');
  await Promise.all([first, second]);
  assert.equal(validations, 1);
  assert.equal(preparations, 1);
  assert.equal(controller.snapshot.phase, 'failed');
  assert.equal(disposed, 1);
  await controller.collectionCompleted();
  assert.equal(validations, 1);
});

test('real core cancellation during headers and abort-uncooperative body never admits late text', async () => {
  for (const phase of ['headers', 'body'] as const) {
    const f = await digestFixture();
    const transport = deferredTransport();
    const body = deferred<string>();
    let bodyRead = false;
    let controller: DelegatedDigestPanel | undefined;
    try {
      const p = await planDelegatedDigest(f.input);
      controller = new DelegatedDigestPanel({ ...coreServices,
        run: (value, options, deliver) => runDelegatedDigest(value, { ...options, fetch: transport.fetcher }, deliver) });
      await controller.activate({ ...target, ledgerId: p.ledgerId, ref: p.ref }, f.input);
      const request = controller.confirm();
      await until(() => transport.calls.length === 1);
      if (phase === 'body') {
        transport.calls[0].resolve(withResponseText(response(), () => { bodyRead = true; return body.promise; }));
        await until(() => bodyRead);
      }
      controller.cancel();
      await request;
      if (phase === 'headers') transport.calls[0].resolve(response());
      else body.resolve(await response().text());
      await tick();
      assert.equal(controller.snapshot.phase, 'idle');
      assert.equal(controller.snapshot.result, undefined);
    } finally { controller?.cancel(); f.cleanup(); }
  }
});


test('real original lifetime rejects invisible config/credential changes at confirm and retained collection', async () => {
  for (const change of ['model-revision', 'outbound-revision', 'reasoning', 'cap', 'credential'] as const) {
    for (const when of ['confirm', 'retained'] as const) {
      const f = await digestFixture();
      let sends = 0;
      let checks = 0;
      const controller = new DelegatedDigestPanel({ ...coreServices,
        revalidate: (lifetime) => { checks++; return revalidateDelegatedDigestPlan(lifetime); },
        run: (value, options, deliver) => runDelegatedDigest(value, { ...options, fetch: (async () => {
          sends++; return response();
        }) as typeof fetch }, deliver) });
      try {
        const initial = await planDelegatedDigest(f.input);
        await controller.activate({ ...target, ledgerId: initial.ledgerId, ref: initial.ref }, f.input);
        if (when === 'retained') { await controller.confirm(); assert.equal(controller.snapshot.phase, 'result'); }
        if (change === 'model-revision') f.write('model.json', { ...f.config, revision: 2 });
        if (change === 'outbound-revision') f.write('outbound.json', { ...f.policy, revision: 2 });
        if (change === 'reasoning' && f.config.connection.backend === 'api')
          f.write('model.json', { ...f.config, connection: { ...f.config.connection, reasoning: true } });
        if (change === 'cap') f.write('model.json', { ...f.config, delegatedDigest: { ...f.config.delegatedDigest, hourlyCap: 59 } });
        if (change === 'credential') f.env.SYNTHETIC_DIGEST_KEY = 'synthetic-rotated-key';
        assert.deepEqual(await planDelegatedDigest(f.input), initial, 'public plan equality is not lifetime continuity');
        if (when === 'confirm') await controller.confirm();
        else {
          const pending = controller.collectionCompleted();
          assert.equal(controller.snapshot.result, undefined);
          await pending;
        }
        assert.equal(controller.snapshot.phase, 'failed', `${change}/${when}`);
        assert.equal(sends, when === 'retained' ? 1 : 0);
        f.write('model.json', f.config); f.write('outbound.json', f.policy);
        f.env.SYNTHETIC_DIGEST_KEY = 'synthetic-key';
        const oldChecks = checks;
        await controller.collectionCompleted();
        assert.equal(controller.snapshot.result, undefined);
        assert.equal(checks, oldChecks);
      } finally { controller.cancel(); f.cleanup(); }
    }
  }
});

test('cancelled pending preparation keeps its single slot, disposes late lifetime and requires a new manual attempt', async () => {
  const pending = deferred<Awaited<ReturnType<typeof prepareDelegatedDigestPlan>>>();
  let preparations = 0;
  let disposals = 0;
  const controller = new DelegatedDigestPanel(mockServices({ prepare: () => { preparations++; return pending.promise; },
    dispose: () => { disposals++; } }));
  const first = controller.activate(target, input);
  controller.cancel();
  await controller.activate({ ...target, reportId: 'new-report' }, input);
  assert.equal(preparations, 1, 'no second pending preparation or implicit queue');
  pending.resolve({ plan: plan(), lifetime: Object.freeze({}) as DigestPlanLifetime });
  await first;
  assert.equal(disposals, 1);
  assert.equal(controller.snapshot.phase, 'idle');
  await controller.collectionCompleted();
  assert.equal(preparations, 1);
});

test('controller display DTO never serializes lifetime, environment, full plan or unparsed output', async () => {
  const credential = 'PRIVATE_SYNTHETIC_CREDENTIAL_SENTINEL';
  let validated = 0;
  const controller = new DelegatedDigestPanel(mockServices({ revalidate: () => { validated++; return true; } }));
  await controller.collectionCompleted();
  assert.equal(validated, 0);
  const env = { SELECTED_SYNTHETIC_KEY: credential };
  await controller.activate(target, { ...input, env });
  assert.doesNotMatch(JSON.stringify(controller.snapshot), /PRIVATE_SYNTHETIC_CREDENTIAL_SENTINEL|lifetime|SELECTED_SYNTHETIC_KEY/);
  await controller.confirm();
  assert.doesNotMatch(JSON.stringify(controller.snapshot), /PRIVATE_SYNTHETIC_CREDENTIAL_SENTINEL|lifetime|SELECTED_SYNTHETIC_KEY/);
  const before = controller.snapshot.result!.generatedAt;
  await controller.collectionCompleted();
  assert.equal(controller.snapshot.result!.generatedAt, before);
  assert.equal(validated, 1);
  controller.cancel();
});


test('actual core asynchronous telemetry cleanup cannot apply page success effects after Cancel or shutdown', async (context) => {
  for (const shutdown of [false, true]) {
    const f = await digestFixture();
    const gate = deferred<void>();
    let entered = false; let paints = 0;
    let controller: DelegatedDigestPanel | undefined;
    let pending: Promise<void> | undefined;
    const oldFlush = SmallModel.prototype.flushTelemetry;
    const flush = context.mock.method(SmallModel.prototype, 'flushTelemetry', async function (this: SmallModel) {
      entered = true; await gate.promise; await oldFlush.call(this);
    });
    try {
      const plan = await planDelegatedDigest(f.input);
      const selected = { ...target, ledgerId: plan.ledgerId, ref: plan.ref };
      const panel = controller = new DelegatedDigestPanel({ ...coreServices,
        run: (value, options, deliver) => runDelegatedDigest(value, { ...options, fetch: (async () => response()) as typeof fetch }, deliver) });
      const data = monitorInput(null);
      const state: DigestPageContext = { state: data.state, monitor: { tree: data.tree },
        surfaces: { settingsPage: null, settingsLeave: null, activityHub: null, observability: null, logsOpen: false },
        mainPane: false, mouse: true, closed: false, home: f.home, env: f.env, target: selected, scope: 'root',
        frameRoot: 'root', currentRoot: 'root', frameEpoch: 1, currentEpoch: 1 };
      const page = new DelegatedDigestPage(panel, { context: () => state, sync: () => page.synchronize(),
        modalFrame: () => renderDigestModal(panel.snapshot, 80, 20), setState: (next) => { state.state = next; },
        paint: () => { paints++; }, focusPanel: () => {}, focusMain: () => {}, pauseModels: () => {},
        close: () => { state.closed = true; }, forward: () => { throw new Error('modal cannot forward'); },
        timeAsync: async (_name, work) => { await work(); } });
      page.synchronize(); await panel.activate(selected, f.input);
      pending = page.confirm(); await until(() => entered);
      assert.equal(panel.snapshot.phase, 'running', 'real core has not returned during its cleanup await');
      if (shutdown) { state.closed = true; page.shutdown(); }
      else assert.deepEqual([...page.inputs([{ type: 'key', key: 'escape' }, { type: 'key', key: 'enter', raw: '\r' }])], []);
      const ui = state.state; const count = paints;
      gate.resolve(); await pending;
      assert.equal(state.state, ui); assert.equal(paints, count); assert.equal(panel.snapshot.phase, 'idle');
    } finally {
      gate.resolve(); controller?.cancel(); await pending; flush.mock.restore(); f.cleanup();
    }
  }
});
