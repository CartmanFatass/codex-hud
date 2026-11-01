import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchProfileDigest, launchProfileUsable, planHostSelection } from '../../src/core/capabilities.js';
import { reconcileRun } from '../../src/core/execution.js';
import { sessionRefKey } from '../../src/core/identity.js';
import { createActionDescriptor, interactionPolicy } from '../../src/core/lifecycle.js';
import {
  displayNodeKey,
  initialParserState,
  makeMetric,
  mergeBoundIntent,
  planTree,
  projectFreshness,
} from '../../src/core/observation.js';
import type { BindContext, HarnessAdapter, ReaderResult } from '../../src/core/interfaces/harness-adapter.js';
import type { HostAdapter } from '../../src/core/interfaces/host-adapter.js';
import type { RegistryProvider, RegistryRecord } from '../../src/core/interfaces/registry-provider.js';
import type { RunControl } from '../../src/core/interfaces/run-control.js';
import type { SessionBinding, SurfaceLocator } from '../../src/core/interfaces/session-binding.js';
import type { HostLocator, LaunchProfile, LocatorCheck } from '../../src/core/types/capabilities.js';
import type { Run } from '../../src/core/types/execution.js';
import type { RunBinding, SessionRef } from '../../src/core/types/identity.js';
import type { LifecycleStatus } from '../../src/core/types/lifecycle.js';
import type { ObservationView, TreeInputNode } from '../../src/core/types/observation.js';
import { FakeHarnessAdapter, FakeSessionReader } from '../fakes/harness-adapter.js';
import { FakeHostAdapter } from '../fakes/host-adapter.js';
import { FakeRegistryProvider } from '../fakes/registry-provider.js';
import { FakeRunControl } from '../fakes/run-control.js';
import {
  FIXTURE_CHILD as REF,
  FIXTURE_NOW as NOW,
  FIXTURE_SUPERVISOR,
  fixtureLink,
  fixtureReconcileEvidence,
  fixtureRun,
} from '../fixtures/contracts/identity-execution.js';

const LOCATOR: HostLocator = {
  kind: 'tmux',
  server: 'synthetic-server',
  session: 'synthetic-session',
  pane: '%1',
  runId: 'run-a',
  bindingGeneration: 17,
  process: FIXTURE_SUPERVISOR,
};
const BINDING: RunBinding = {
  runId: 'run-a',
  sessionRef: REF,
  bindingGeneration: 17,
  supervisor: FIXTURE_SUPERVISOR,
  harness: { ...FIXTURE_SUPERVISOR, pid: 121 },
  occupantGeneration: 29,
  childBinding: null,
};
const SESSION_BINDING: SessionBinding = {
  sessionRef: REF,
  harness: BINDING.harness,
  occupantGeneration: 29,
  managed: null,
};
const { runId: _managedRunId, bindingGeneration: _managedBindingGeneration, ...location } = LOCATOR;
const SURFACE: SurfaceLocator = { ...location, occupantGeneration: 29 };
// @ts-expect-error A resolved observation always has a complete SessionRef.
const invalidSessionRef: SessionBinding['sessionRef'] = null;
void invalidSessionRef;
const CONTEXT: BindContext = {
  sourceId: REF.sourceId,
  explicitSession: REF,
  registry: [],
  locator: SURFACE,
  processes: [],
  cwd: '/synthetic/repo',
  startedAt: NOW,
};
const PROFILE: LaunchProfile = {
  name: 'synthetic-codex',
  harness: 'codex',
  source: { root: '/synthetic/home-a', label: 'synthetic' },
  launch: { argv: ['synthetic-codex', 'argument with spaces;$literal'] },
  headless: null,
  resume: null,
  resumeHeadless: null,
  host: { kind: 'tmux', layout: 'pane' },
  env: { SYNTHETIC: 'value' },
  mcpServerName: 'synthetic-mcp',
  claimTransport: 'config_env',
  clientToolTimeoutMs: 60_000,
  responseMarginMs: 2_000,
  orphan_policy: 'continue',
  managedShellVerified: false,
};

function observation(ref: SessionRef = REF): ObservationView {
  return {
    nodeIdentity: { kind: 'session', ref },
    statusProjection: {
      activity: 'unknown',
      pendingReason: 'none',
      lastTurnOutcome: 'none',
      liveness: 'unknown',
      freshness: projectFreshness([], [], NOW),
      stateKey: 'unknown',
      stateSince: null,
      stateSinceBasis: 'unknown',
      isRunTerminal: null,
      asOfSeq: null,
      observationStamp: null,
      asOf: null,
      observedAt: NOW,
      lastEvidenceAt: null,
    },
    conflict: null,
    spent: {
      tokens: makeMetric({ input: 12, output: 3 }, { source: 'synthetic-usage', asOf: NOW, quality: 'reported' }),
      costUsd: makeMetric<number>(null, { source: 'synthetic-price-unavailable', asOf: NOW, quality: 'unknown' }),
    },
    workspace: null,
    coverage: { state: 'complete', skipped: {}, gaps: [], loaded: true },
    loaded: true,
    depth: 0,
    evidenceStamp: 'synthetic-evidence',
  };
}

function readerResult(ref: SessionRef = REF): ReaderResult {
  return {
    observation: observation(ref),
    checkpoint: {
      schemaVersion: 1,
      readerVersion: 'synthetic-v1',
      ref,
      fileId: { dev: 1, inode: 2 },
      offset: 123,
      sourceGeneration: 7,
      parserState: initialParserState(),
    },
  };
}

function lifecycle(run: Run): LifecycleStatus {
  return {
    link: fixtureLink(),
    currentRun: run,
    terminalNote: null,
    runHandshake: { state: 'bound', reason: null },
    latestReportForRun: null,
    reconciliation: null,
    interaction: interactionPolicy({
      run,
      unresolvedConflict: false,
      occupantMatches: true,
      foregroundInteractive: true,
      focusVerified: true,
      inputVerified: true,
      resumable: false,
    }),
    parentOffline: null,
    resumable: { resumable: false, reason: 'slot_busy', subject: 'mcp' },
    asOfSeq: 1,
    observationStamp: null,
    statusProjection: observation().statusProjection,
  };
}

test('empty optional registry still supports binding, reading and a core session tree', async () => {
  const registry = new FakeRegistryProvider();
  registry.listScript.responses.push([]);
  registry.getScript.responses.push(null);
  registry.sessionOfScript.responses.push(null);
  const provider: RegistryProvider = registry;
  assert.equal(await provider.get(SURFACE), null);
  assert.equal(await provider.sessionOf(SURFACE), null);

  const fake = new FakeHarnessAdapter('codex');
  const reader = new FakeSessionReader();
  const result = readerResult();
  fake.resolveSourceScript.responses.push(REF.sourceId);
  const observedOnly: SessionBinding = { sessionRef: REF, harness: null, occupantGeneration: null, managed: null };
  fake.bindScript.responses.push(observedOnly);
  fake.childrenScript.responses.push([]);
  reader.readScript.responses.push(result);
  fake.readers.set(sessionRefKey(REF), reader);
  const harness: HarnessAdapter = fake;
  const sourceId = await harness.resolveSource(PROFILE, {});
  const bound = await harness.bind({ ...CONTEXT, sourceId, locator: null, registry: await provider.list() });
  assert.ok(bound?.sessionRef);
  assert.equal('runId' in bound, false);
  assert.equal(bound.managed, null);
  assert.equal(fake.bindScript.calls[0][0].locator, null);
  assert.equal(bound.harness, null);
  assert.equal(bound.occupantGeneration, null);
  for (const field of ['bindingGeneration', 'supervisor', 'childBinding']) assert.equal(field in bound, false);
  const read = await harness.open(bound.sessionRef).read();
  const key = displayNodeKey(read.observation.nodeIdentity);
  const tree = planTree(
    key,
    new Map([
      [
        key,
        {
          identity: read.observation.nodeIdentity,
          readBytes: read.checkpoint.offset,
          children: (await harness.children(bound.sessionRef)).map((ref) => ({
            key: displayNodeKey({ kind: 'session', ref }),
            kind: 'current' as const,
          })),
        },
      ],
    ])
  );
  assert.equal(tree.confirmedSessionCount, 1);
  assert.equal(tree.nodes[0].loaded, true);
  assert.equal(read.observation.spent.costUsd.value, null);
  assert.equal(fake.bindScript.calls[0][0].registry.length, 0);
  assert.equal(harness.capabilities.navigate, undefined);
});

test('06 T-06-6: cached unmanaged registry records retain validity, generation and observation clocks', async () => {
  const registry = new FakeRegistryProvider();
  const record: RegistryRecord = {
    locator: SURFACE,
    binding: SESSION_BINDING,
    evidence: {
      origin: 'registry',
      ref: REF,
      sourceGeneration: 7,
      eventAt: NOW - 1000,
      observedAt: NOW,
      lastSuccessfulReadAt: NOW,
      validity: 'current',
      value: {
        server: SURFACE.server,
        occupant: REF,
        completionSeq: 5,
        sourceClockAt: NOW - 1000,
        activity: 'idle',
        pendingReason: 'none',
      },
    },
  };
  const cached: RegistryRecord = {
    ...record,
    evidence: { ...record.evidence, validity: 'stale', reason: 'synthetic-socket-unavailable' },
  };
  registry.listScript.responses.push([record], [cached], [cached]);
  registry.getScript.responses.push(cached);
  registry.sessionOfScript.responses.push(null);
  const provider: RegistryProvider = registry;
  const first = (await provider.list())[0];
  for (const nowMs of [NOW, NOW + 5000, NOW + 6000]) {
    const entry = nowMs === NOW ? first : (await provider.list())[0];
    const evidence = entry.evidence;
    const freshness = projectFreshness(
      [
        {
          id: 'synthetic-registry',
          validity: evidence.validity,
          lastEvidenceAt: evidence.eventAt,
          observedAt: evidence.observedAt,
          lastSuccessfulReadAt: evidence.lastSuccessfulReadAt,
          deadlineAt: evidence.lastSuccessfulReadAt! + 3000,
          reason: evidence.reason,
        },
      ],
      ['synthetic-registry'],
      nowMs
    );
    assert.equal(freshness.state, nowMs === NOW ? 'fresh' : 'stale');
    assert.equal(evidence.observedAt, NOW);
    assert.equal(evidence.lastSuccessfulReadAt, NOW);
    assert.equal(evidence.value.sourceClockAt, NOW - 1000);
    assert.equal(evidence.sourceGeneration, 7);
    for (const field of ['runId', 'bindingGeneration', 'supervisor']) assert.equal(field in entry.locator!, false);
    assert.equal(entry.locator!.occupantGeneration, 29);
    assert.notEqual(entry.binding!.occupantGeneration, evidence.sourceGeneration);
    assert.equal(entry.binding?.managed, null);
  }
  assert.deepEqual(await provider.get(SURFACE), cached);
  assert.equal(await provider.sessionOf(SURFACE), null);
  assert.equal('runId' in first.evidence, false);
  const fake = new FakeHarnessAdapter('codex');
  fake.bindScript.responses.push(SESSION_BINDING);
  const bound = await fake.bind({ ...CONTEXT, registry: [first] });
  assert.deepEqual(bound, SESSION_BINDING);
  const host = new FakeHostAdapter('tmux');
  host.openSurfaceScript.responses.push(SURFACE);
  host.locateScript.responses.push(SURFACE);
  assert.deepEqual(
    await host.openSurface('pane', {
      managed: null,
      cwd: '/synthetic/repo',
      env: {},
    }),
    SURFACE
  );
  assert.deepEqual(await host.locate(REF), SURFACE);
});

test('valid, stale and unknown locator occupants drive the core interaction policy', async () => {
  const fake = new FakeHostAdapter('tmux');
  const host: HostAdapter = fake;
  const checks: LocatorCheck[] = [
    {
      state: 'valid',
      occupantMatches: true,
      checkedAt: NOW,
      evidence: ['synthetic-current'],
      foregroundInteractive: true,
    },
    {
      state: 'stale',
      occupantMatches: false,
      checkedAt: NOW,
      evidence: ['synthetic-reused'],
      foregroundInteractive: true,
    },
    {
      state: 'unknown',
      occupantMatches: null,
      checkedAt: NOW,
      evidence: ['synthetic-transport-error'],
      foregroundInteractive: null,
    },
  ];
  fake.checkLocatorScript.responses.push(...checks);
  fake.focusScript.responses.push(undefined);
  fake.sendKeysScript.responses.push(undefined);
  for (const [index, expected] of [true, false, false].entries()) {
    const check = await host.checkLocator(SURFACE);
    const interaction = interactionPolicy({
      run: fixtureRun({ mode: 'visible' }),
      unresolvedConflict: false,
      occupantMatches: check.state === 'valid' ? check.occupantMatches : null,
      foregroundInteractive: check.foregroundInteractive === true,
      focusVerified: true,
      inputVerified: true,
      resumable: false,
    });
    assert.deepEqual(interaction, { focus: expected, input: expected, resume: false }, checks[index].state);
    if (interaction.focus) await host.focus(SURFACE);
    if (interaction.input) await host.sendKeys(SURFACE, ['synthetic-input']);
  }
  assert.deepEqual(fake.focusScript.calls, [[SURFACE]]);
  assert.deepEqual(fake.sendKeysScript.calls, [[SURFACE, ['synthetic-input']]]);
});

test('lost supervisor refuses RunControl input even with a matching visible occupant', async () => {
  const run = fixtureRun({ mode: 'visible', supervisionStrategy: 'wrapper' });
  const decision = reconcileRun(run, [fixtureReconcileEvidence({ kind: 'supervisor', state: 'dead' })], NOW);
  assert.equal(decision.state, 'uncertain');
  assert.equal(decision.cause, 'supervisor_dead');
  const fake = new FakeRunControl();
  const status = lifecycle({ ...run, state: decision.state });
  assert.deepEqual(status.interaction, { focus: false, input: false, resume: false });
  fake.statusScript.responses.push(status);
  const control: RunControl = fake;
  // The consumer gate uses the core decision; the data-only fake cannot enforce policy.
  await assert.rejects(async () => {
    const current = await control.status(run.runId);
    if (!current.interaction.input) throw new Error('interaction_unavailable');
    await control.sendInput?.(run.runId, 'synthetic-followup');
  }, /interaction_unavailable/);
  assert.deepEqual(fake.statusScript.calls, [[run.runId]]);
  assert.deepEqual(fake.sendInputScript.calls, []);
  assert.deepEqual(fake.cancelScript.calls, []);
});

test('05 T-05-8: absent or unavailable optional host selects a verified tmux fake before submission', async () => {
  for (const reason of ['disabled', 'schema_mismatch', 'socket_unavailable']) {
    const optional = new FakeHostAdapter('herdr');
    const fallback = new FakeHostAdapter('tmux');
    const profile = { ...PROFILE, host: { kind: 'herdr', layout: 'tab' } } as const;
    const params = {
      finalProfileDigest: launchProfileDigest(profile),
      hostKind: optional.kind,
      preflight: 'failed' as const,
      neverSubmitted: true,
      dispatchMayHaveOccurred: false,
      runId: 'run-a',
      fallback: { profileDigest: launchProfileDigest(PROFILE), hostKind: fallback.kind, support: 'verified' as const },
      paramsDigest: 'synthetic-final-params',
    };
    const selection = planHostSelection(params);
    assert.equal(selection.action, 'select', reason);
    if (selection.action !== 'select') assert.fail('expected host selection');
    assert.equal(selection.hostKind, 'tmux');
    assert.equal(selection.profileDigest, launchProfileDigest(PROFILE));
    const host: HostAdapter = fallback;
    const command = launchProfileUsable(PROFILE, 'spawn', 'visible').command;
    assert.ok(command);
    fallback.openSurfaceScript.responses.push(SURFACE);
    fallback.runInSurfaceScript.responses.push(undefined);
    const locator = await host.openSurface('pane', {
      managed: { runId: BINDING.runId, bindingGeneration: BINDING.bindingGeneration },
      cwd: '/synthetic/repo',
      env: PROFILE.env,
    });
    await host.runInSurface(locator, command);
    assert.deepEqual(fallback.runInSurfaceScript.calls, [[SURFACE, PROFILE.launch]]);
    assert.deepEqual(optional.openSurfaceScript.calls, []);
    assert.deepEqual(optional.runInSurfaceScript.calls, []);
    assert.deepEqual(planHostSelection({ ...params, dispatchMayHaveOccurred: true }), {
      action: 'reconcile',
      runId: 'run-a',
    });
    assert.deepEqual(planHostSelection({ ...params, neverSubmitted: false }), {
      action: 'reject',
      reason: 'host_preflight_unavailable',
    });
  }
});

test('05 T-05-10: accepted replay cannot switch host or dispatch a fallback', () => {
  const fake = new FakeHostAdapter('tmux');
  const params = {
    finalProfileDigest: 'new-profile',
    hostKind: fake.kind,
    preflight: 'failed' as const,
    neverSubmitted: true,
    dispatchMayHaveOccurred: false,
    runId: 'run-a',
    paramsDigest: 'accepted-params',
    fallback: { profileDigest: 'fallback-profile', hostKind: fake.kind, support: 'verified' as const },
    accepted: { paramsDigest: 'accepted-params', profileDigest: 'accepted-profile', result: { runId: 'run-a' } },
  };
  assert.deepEqual(planHostSelection(params), {
    action: 'replay',
    profileDigest: 'accepted-profile',
    result: { runId: 'run-a' },
  });
  assert.deepEqual(planHostSelection({ ...params, paramsDigest: 'changed-params' }), {
    action: 'reject',
    reason: 'idempotency_conflict',
  });
  assert.deepEqual(fake.runInSurfaceScript.calls, []);
});

test('bind/open/children feed an intent-to-session merge with native topology and selection preserved', async () => {
  const native: SessionRef = { ...REF, sessionId: 'synthetic-native' };
  const intent = { kind: 'delegationIntent', linkId: 'link-a' } as const;
  const intentKey = displayNodeKey(intent);
  const refKey = displayNodeKey({ kind: 'session', ref: REF });
  const nativeKey = displayNodeKey({ kind: 'session', ref: native });
  const fake = new FakeHarnessAdapter('codex');
  fake.bindScript.responses.push(null, { ...SESSION_BINDING, managed: BINDING });
  assert.equal(await fake.bind({ ...CONTEXT, explicitSession: null }), null);
  const reader = new FakeSessionReader();
  const result = readerResult();
  reader.readScript.responses.push(result);
  fake.readers.set(sessionRefKey(REF), reader);
  fake.childrenScript.responses.push([native]);
  const harness: HarnessAdapter = fake;
  const bound = await harness.bind(CONTEXT);
  assert.ok(bound?.sessionRef);
  assert.deepEqual(bound.managed, BINDING);
  assert.equal(bound.managed?.bindingGeneration, 17);
  assert.deepEqual(bound.managed?.supervisor, BINDING.supervisor);
  assert.equal(bound.occupantGeneration, 29);
  assert.notEqual(bound.managed?.bindingGeneration, bound.occupantGeneration);
  assert.equal('supervisor' in bound, false);
  const read = await harness
    .open(bound.sessionRef, result.checkpoint)
    .read({ maxBytes: 4096, maxRecords: 20, budgetMs: 5 });
  const children = await harness.children(bound.sessionRef);
  const inputs = new Map<string, TreeInputNode>([
    [
      intentKey,
      {
        identity: intent,
        readBytes: 0,
        children: [
          { key: refKey, kind: 'current' },
          { key: nativeKey, kind: 'current' },
        ],
      },
    ],
    [
      refKey,
      {
        identity: read.observation.nodeIdentity,
        readBytes: read.checkpoint.offset,
        children: children.map((ref) => ({ key: displayNodeKey({ kind: 'session', ref }), kind: 'current' })),
      },
    ],
    [nativeKey, { identity: { kind: 'session', ref: native }, readBytes: 0, children: [] }],
  ]);
  const before = planTree(intentKey, inputs);
  assert.equal(before.confirmedSessionCount, 2);
  const merged = mergeBoundIntent(before.nodes, intent.linkId, bound.sessionRef);
  assert.deepEqual(merged.selectionMap, { [intentKey]: refKey });
  assert.equal(merged.nodes.length, 2);
  assert.ok(merged.nodes.every((node) => node.identity.kind === 'session'));
  assert.equal(merged.nodes.find((node) => node.key === nativeKey)?.parentKey, refKey);
  assert.deepEqual(fake.openCalls, [[REF, result.checkpoint]]);
  assert.deepEqual(fake.childrenScript.calls, [[REF]]);
  assert.deepEqual(reader.readScript.calls, [[{ maxBytes: 4096, maxRecords: 20, budgetMs: 5 }]]);
});

test('05 T-05-18: resume descriptor is copy-only with no RunControl or host dispatch', () => {
  const control = new FakeRunControl();
  const host = new FakeHostAdapter('tmux');
  const action = createActionDescriptor({
    operation: 'resume',
    linkId: 'link-a',
    runId: 'run-a',
    expectedRun: 'run-a',
    mode: 'visible',
    requestKey: 'synthetic-resume-1',
    reason: 'synthetic-completed',
    hudHome: '/synthetic/hud home',
    entryVerified: true,
  });
  assert.ok(action);
  assert.equal(action.delivery, 'copy_only');
  assert.match(action.displayCommand, /^HUD_HOME='\/synthetic\/hud home' hud run resume 'link-a'/);
  assert.match(action.displayCommand, /--request-key 'synthetic-resume-1' --expected-run 'run-a' --mode 'visible'$/);
  assert.deepEqual(
    [
      control.statusScript.calls,
      control.cancelScript.calls,
      control.reconcileScript.calls,
      control.sendInputScript.calls,
    ],
    [[], [], [], []]
  );
  assert.deepEqual(host.runInSurfaceScript.calls, []);
  assert.equal(
    createActionDescriptor({
      operation: 'resume',
      linkId: 'link-a',
      runId: 'run-a',
      expectedRun: 'run-a',
      mode: 'visible',
      requestKey: 'synthetic-resume-1',
      reason: 'unverified',
      hudHome: '/synthetic/hud',
      entryVerified: false,
    }),
    null
  );
});
