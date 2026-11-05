import assert from 'node:assert/strict';
import test from 'node:test';
import { openObservationStore } from '../../src/core/observation-store.js';
import { SessionPublisher } from '../../src/core/link/publisher.js';
import { committedReaderRate, committedReaderAction } from '../../src/core/link/index.js';
import { LinkTickCollector } from '../../src/core/link/tick.js';
import { checkpointAction } from '../../src/core/link/checkpoint-action.js';
import { checkpointRate } from '../../src/core/link/checkpoint-rate.js';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAdapter, type CodexCheckpoint } from '../../src/harness/codex/index.js';
import type { LaunchProfile } from '../../src/core/types/capabilities.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import type { CollectedLinkSession } from '../../src/core/link/types.js';
import type { ObservationRecoveryTarget, RecoveryReadGrant } from '../../src/core/types/checkpoint.js';
import { stripAnsi } from '../../src/render/colors.js';
import { notifyFixture, reportFor } from './b21-fixture.js';
import { HudDelegationCollector } from '../../src/collectors/delegation.js';
import { displayNodeKey } from '../../src/core/observation.js';
import { sameSessionRef } from '../../src/core/identity.js';
import { buildVm, S, NOW } from '../fixtures/b10b-delegation.js';
import { draw, press } from '../fixtures/b10b-s3.js';

test(
  'rate receipt is available only for the exact published checkpoint and observation stamp',
  { skip: !ledgerRuntimeSupported() },
  async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    const ref = f.child.ref;
    const target = {
      nodeIdentity: { kind: 'session' as const, ref },
      sourceGeneration: 1,
      runId: 'run-a',
      bindingGeneration: 1,
    };
    const facts = {
      target,
      sources: [],
      asOfSeq: 2,
      observationStamp: null,
      ledgerFacts: [],
      history: { continuity: 'unknown' as const },
    };
    const now = Date.now();
    const dir = join(f.root, 'sessions', '2026', '11', '02');
    mkdirSync(dir, { recursive: true });
    const record = (at: number, type: string, payload: object) =>
      JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload });
    const usage = (at: number, output: number) =>
      record(at, 'event_msg', {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 1, output_tokens: output } },
      });
    writeFileSync(
      join(dir, `rollout-${ref.sessionId}.jsonl`),
      [
        record(now - 5000, 'session_meta', {
          id: ref.sessionId,
          cwd: '/synthetic',
          timestamp: new Date(now - 5000).toISOString(),
          cli_version: '0.synthetic',
        }),
        record(now - 4000, 'event_msg', { type: 'task_started' }),
        usage(now - 3000, 100),
        usage(now - 1000, 124),
      ].join('\n') + '\n'
    );
    const adapter = new CodexAdapter({ maxBytes: 1024 * 1024, maxRecords: 2000, budgetMs: 60000 });
    const profile = {
      harness: 'codex',
      source: { root: f.root, label: 'synthetic' },
      env: {},
      mcpServerName: 'hud',
    } as LaunchProfile;
    assert.equal(await adapter.resolveSource(profile, {}), ref.sourceId);
    const reading = await adapter.open(ref).read({ maxBytes: 1024 * 1024, maxRecords: 2000, budgetMs: 60000 });
    assert.ok(reading.outputRate);
    assert.deepEqual(checkpointRate(reading.checkpoint, now), reading.outputRate);
    assert.equal(checkpointRate(reading.checkpoint, reading.outputRate!.sampledAt - 1), undefined);
    const equalTurn = JSON.parse(JSON.stringify(reading.checkpoint)) as CodexCheckpoint;
    assert.equal(equalTurn.codex.rollout.version, 3);
    if (equalTurn.codex.rollout.version !== 3) throw new Error('fixture');
    equalTurn.codex.rollout.state.cachedResult!.activity!.turnStartedAt = reading.outputRate!.sampledAt;
    assert.equal(checkpointRate(equalTurn, now), undefined);
    const store = await openObservationStore({ hudHome: f.root, sourceId: ref.sourceId, now: () => now });
    const publisher = new SessionPublisher(store, ref, 'synthetic-rate');
    t.after(() => {
      publisher.close();
      store.close();
    });
    assert.equal(publisher.claim(now), 'acquired');
    publisher.capture({
      ...reading,
      outputRate: { ...reading.outputRate!, tokensPerSecond: reading.outputRate!.tokensPerSecond + 1 },
    });
    const forged = publisher.publish(facts, 'synthetic', now)!;
    assert.equal(publisher.committedRate(forged), null, 'mismatched sample cannot receive a checkpoint receipt');
    publisher.capture(reading);
    const committed = publisher.publish(facts, 'synthetic', now)!;
    const receipt = publisher.committedRate(committed)!;
    assert.ok(receipt);
    assert.equal('outputRate' in store.readProjection(ref)!.summary, false);
    const session = {
      committedOnly: true,
      loaded: true,
      sourceGeneration: 1,
      evidence: { ref },
      committedRate: receipt,
    } as unknown as CollectedLinkSession;
    assert.equal(
      committedReaderRate(session, committed.summary, now, true)?.tokensPerSecond,
      reading.outputRate!.tokensPerSecond
    );
    assert.equal(
      committedReaderRate(
        {
          ...session,
          committedRate: { ...receipt, stamp: { ...receipt.stamp, commitSeq: receipt.stamp.commitSeq + 1 } },
        },
        committed.summary,
        now,
        true
      ),
      undefined
    );
    assert.equal(
      committedReaderRate({ ...session, committedRate: undefined }, committed.summary, now, true),
      undefined
    );
    assert.equal(committedReaderRate({ ...session, sourceGeneration: 2 }, committed.summary, now, true), undefined);
    assert.equal(committedReaderRate({ ...session, loaded: false }, committed.summary, now, true), undefined);
    assert.equal(
      committedReaderRate(
        { ...session, evidence: { ...session.evidence, ref: { ...ref, sessionId: 'other' } } },
        committed.summary,
        now,
        true
      ),
      undefined
    );
    assert.equal(
      committedReaderRate(
        { ...session, committedRate: { ...receipt, stamp: { ...receipt.stamp, runId: 'other-run' } } },
        committed.summary,
        now,
        true
      ),
      undefined
    );
    assert.equal(committedReaderRate(session, committed.summary, now, false), undefined);
    assert.equal(committedReaderRate(session, null, now, true), undefined);
    const originalRate = reading.outputRate!;
    reading.outputRate = { ...originalRate, tokensPerSecond: originalRate.tokensPerSecond + 1 };
    assert.equal(
      publisher.committedRate(committed)?.rate.tokensPerSecond,
      originalRate.tokensPerSecond,
      'receipt must be detached from later mutation'
    );
    reading.outputRate = originalRate;
    publisher.capture({ ...reading, checkpoint: { ...reading.checkpoint, offset: reading.checkpoint.offset + 1 } });
    assert.equal(publisher.committedRate(committed), null, 'new uncommitted reading invalidates the old receipt');
  }
);

test('Inspector reports exact sample age and hides unavailable or future rates', () => {
  const built = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working(), label: null },
    { id: 'one', parent: 'main', harness: 'codex', label: 'target', status: S.working() },
  ]);
  built.vm.tree.ledger.state = 'available';
  const detail = built.vm.details[built.keys.one];
  detail.outputRate = {
    source: 'codex.turn_wallclock_proxy',
    tokensPerSecond: 12,
    sampleMs: 1000,
    sampledAt: NOW - 5000,
  };
  const inspect = () => {
    const frame = draw(built.vm, { selected: built.keys.one, width: 110, height: 40 });
    const opened = press(frame, 'enter');
    return draw(built.vm, { state: opened.state, width: 110, height: 40 }).lines.map(stripAnsi).join('\n');
  };
  detail.action = { id: 'tool', name: 'read', target: '/synthetic/file', startedAt: NOW - 5000 };
  assert.match(inspect(), /Action: read · \/synthetic\/file · started/);
  assert.match(inspect(), /Output rate: ~12\.0 tok\/s · estimated/);
  detail.outputRate = { ...detail.outputRate, sampledAt: NOW - 11000 };
  assert.match(inspect(), /Output rate: last ~12\.0 tok\/s · estimated/);
  detail.outputRate = { ...detail.outputRate, sampledAt: NOW + 1 };
  assert.match(inspect(), /Output rate: unavailable/);
  detail.outputRate = { ...detail.outputRate, sampledAt: NOW - 5000 };
  built.vm.tree.ledger.state = 'degraded';
  assert.match(inspect(), /Output rate: unavailable/);
  assert.match(inspect(), /Action: unavailable/);
});

test('fast committed refresh clears a previous rate when the new commit has none', async () => {
  const built = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working(), label: null },
    { id: 'one', parent: 'main', harness: 'codex', label: 'target', status: S.working() },
  ]);
  built.vm.tree.ledger.state = 'available';
  const node = built.vm.tree.nodes.find((item) => item.key === built.keys.one)!;
  assert.equal(node.identity.kind, 'session');
  if (node.identity.kind !== 'session') throw new Error('fixture');
  const ref = node.identity.ref;
  const originalKey = node.key;
  node.key = displayNodeKey({ kind: 'session', ref });
  (built.vm.details as Record<string, (typeof built.vm.details)[string]>)[node.key] = built.vm.details[originalKey];
  const stamp = {
    ref,
    sourceGeneration: 1,
    seqDomain: 'synthetic',
    commitSeq: 1,
    inputLedgerSeq: null,
    runId: node.currentRun!.runId,
    bindingGeneration: node.currentRun!.expectedGeneration,
  };
  node.observation!.statusProjection = structuredClone(built.vm.details[node.key].status!);
  node.observation!.nodeIdentity = node.identity;
  node.observation!.conflict = node.conflict;
  node.observation!.statusProjection.observationStamp = stamp;
  const rate = {
    source: 'codex.turn_wallclock_proxy' as const,
    tokensPerSecond: 12,
    sampleMs: 1000,
    sampledAt: NOW - 5000,
  };
  node.committedRate = rate;
  built.vm.details[node.key].outputRate = rate;
  node.committedAction = { id: 'old', name: 'read', startedAt: NOW - 1000 };
  built.vm.details[node.key].action = node.committedAction;
  const summary = structuredClone(node.observation!);
  summary.statusProjection.observationStamp = { ...stamp, commitSeq: 2 };
  const session = {
    evidence: { ref, observation: summary },
    loaded: true,
    committedOnly: true,
    sourceGeneration: 1,
  } as unknown as CollectedLinkSession;
  const collector = new LinkTickCollector({ close() {} } as never, '/synthetic', built.vm.limits, {
    sessions: () => [session],
  } as never);
  (collector as any).tree = built.vm.tree;
  (collector as any).view = built.vm;
  const refreshed = await collector.refreshCommitted(node.key);
  assert.equal(refreshed!.tree.nodes.find((item) => item.key === node.key)!.committedRate, undefined);
  assert.equal(refreshed!.details[node.key].outputRate, undefined);
  assert.equal(refreshed!.details[node.key].action, undefined);
  assert.equal(refreshed!.tree.nodes.find((item) => item.key === node.key)!.committedAction, undefined);
  assert.equal(refreshed!.details[node.key].status!.observationStamp!.commitSeq, 2);
});

test(
  'real collector publishes and projects its own checkpoint-bound rate',
  { skip: !ledgerRuntimeSupported() },
  async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    await reportFor(f, 'completed');
    const now = Date.now();
    const dir = join(f.root, 'sessions', '2026', '11', '02');
    mkdirSync(dir, { recursive: true });
    const entry = (at: number, type: string, payload: object) =>
      JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload });
    for (const ref of [f.parent.ref, f.child.ref]) {
      const rows = [
        entry(now - 5000, 'session_meta', {
          id: ref.sessionId,
          cwd: '/synthetic',
          timestamp: new Date(now - 5000).toISOString(),
          cli_version: '0.synthetic',
          ...(ref === f.child.ref ? { parent_thread_id: f.parent.ref.sessionId } : {}),
        }),
      ];
      if (ref === f.child.ref)
        rows.push(
          entry(now - 4000, 'event_msg', { type: 'task_started' }),
          entry(now - 3000, 'event_msg', {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 1, output_tokens: 100 } },
          }),
          entry(now - 1000, 'event_msg', {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 1, output_tokens: 124 } },
          }),
          entry(now - 900, 'response_item', {
            type: 'function_call',
            call_id: 'first',
            name: 'exec_command',
            arguments: '{\"cmd\":\"alpha\"}',
          }),
          entry(now - 800, 'response_item', {
            type: 'function_call',
            call_id: 'second',
            name: 'exec_command',
            arguments: '{\"cmd\":\"beta\"}',
          })
        );
      writeFileSync(join(dir, `rollout-${ref.sessionId}.jsonl`), rows.join('\n') + '\n');
    }
    const runtime = await HudDelegationCollector.open({ HUD_HOME: f.root }, f.root, { publish: true });
    assert.ok(runtime);
    t.after(() => runtime.close());
    const key = displayNodeKey({ kind: 'session', ref: f.child.ref });
    let view = null;
    const errors: string[] = [];
    for (let i = 0; i < 50; i++) {
      view = await runtime.tick(f.parent.ref.sessionId);
      await runtime.afterPaint((published) => {
        if (published) view = published;
      });
      const error = runtime.publicationStats().error;
      if (error) errors.push(error);
      if (view?.details[key]?.outputRate) break;
    }
    assert.equal(view?.details[key]?.outputRate?.tokensPerSecond, 12, `publication errors: ${errors.join(', ')}`);
    assert.equal(view?.details[key]?.statusSource, 'committed');
    for (let i = 0; i < 50 && !view?.details[key]?.action; i++) {
      view = await runtime.tick(f.parent.ref.sessionId);
      await runtime.afterPaint((published) => {
        if (published) view = published;
      });
    }
    assert.equal(view?.details[key]?.action?.id, 'second', 'publisher recovers its committed action');
    assert.equal(
      view?.tree.nodes.find((node) => node.key === key)?.observation?.statusProjection.observationStamp?.runId,
      'run-a'
    );
    const follower = await HudDelegationCollector.open({ HUD_HOME: f.root }, f.root);
    assert.ok(follower);
    t.after(() => follower.close());
    const followerPort = (follower as any).port;
    const followerStore = followerPort.sources.get(f.child.ref.sourceId).store;
    const recover = followerStore.readRecoveryMetered.bind(followerStore);
    const attemptedOffsets: number[] = [];
    followerStore.readRecoveryMetered = (target: ObservationRecoveryTarget, grant: RecoveryReadGrant) => {
      if (!sameSessionRef(target.ref, f.child.ref)) return recover(target, grant);
      attemptedOffsets.push(followerPort.readings.get(key)?.checkpoint?.offset ?? 0);
      const attempt = attemptedOffsets.length;
      assert.ok(grant.remaining().maxBytes <= 4 * 1024 * 1024);
      assert.ok(grant.remaining().maxRecords <= 2000);
      if (attempt <= 2) {
        const limited: RecoveryReadGrant = {
          now: () => grant.now(),
          remaining: () => ({ ...grant.remaining(), ...(attempt === 1 ? { budgetMs: 0 } : { maxRecords: 0 }) }),
          charge: (stats) => grant.charge(stats),
          drain: () => grant.drain(),
        };
        return recover(target, limited);
      }
      return recover(target, grant);
    };
    let followerView = null;
    let chargedBytes = 0;
    for (let i = 0; i < 50; i++) {
      appendFileSync(
        join(dir, `rollout-${f.child.ref.sessionId}.jsonl`),
        entry(now - 700 + i, 'event_msg', { type: 'synthetic_progress' }) + '\n'
      );
      followerView = await follower.tick(f.parent.ref.sessionId);
      chargedBytes += follower.collector.stats().bytesRead;
      if (followerView?.details[key]?.outputRate && followerView?.details[key]?.action) break;
    }
    assert.equal(
      followerView?.details[key]?.outputRate?.tokensPerSecond,
      12,
      'read-only follower recovers exact committed sample'
    );
    assert.equal(followerView?.details[key]?.statusSource, 'committed');
    assert.equal(followerView?.details[key]?.action?.id, 'second', 'latest unfinished call is recovered by key');
    const projectedNode = followerView!.tree.nodes.find((node) => node.key === key)!;
    const projectedSession = followerPort
      .sessions()
      .find((session: CollectedLinkSession) => sameSessionRef(session.evidence.ref, f.child.ref));
    assert.equal(committedReaderAction(projectedSession, projectedNode.observation, Date.now(), true)?.id, 'second');
    assert.equal(
      committedReaderAction(
        {
          ...projectedSession,
          committedAction: {
            ...projectedSession.committedAction,
            stamp: { ...projectedSession.committedAction.stamp, commitSeq: -1 },
          },
        },
        projectedNode.observation,
        Date.now(),
        true
      ),
      undefined
    );
    assert.equal(committedReaderAction(projectedSession, projectedNode.observation, Date.now(), false), undefined);
    assert.ok(chargedBytes > 0, 'recovery is charged to collection');
    assert.ok(attemptedOffsets.length >= 3, 'deadline and record refusals are retried');
    assert.ok(attemptedOffsets[1] > attemptedOffsets[0], 'ordinary source reading progresses after the first refusal');
    assert.ok(attemptedOffsets[2] > attemptedOffsets[1], 'ordinary source reading progresses after the second refusal');
    const firstSeq = view!.details[key].status!.observationStamp!.commitSeq;
    appendFileSync(
      join(dir, `rollout-${f.child.ref.sessionId}.jsonl`),
      entry(now - 600, 'response_item', { type: 'function_call_output', call_id: 'second', output: 'ok' }) + '\n'
    );
    for (let i = 0; i < 50; i++) {
      view = await runtime.tick(f.parent.ref.sessionId);
      await runtime.afterPaint((published) => {
        if (published) view = published;
      });
      if ((view?.details[key]?.status?.observationStamp?.commitSeq ?? 0) > firstSeq) break;
    }
    for (let i = 0; i < 50; i++) {
      followerView = await follower.tick(f.parent.ref.sessionId);
      if (followerView?.details[key]?.action?.id === 'first') break;
    }
    assert.equal(followerView?.details[key]?.action?.id, 'first', 'completion exposes the remaining unfinished call');
    const priorSeq = view!.details[key].status!.observationStamp!.commitSeq;
    appendFileSync(
      join(dir, `rollout-${f.child.ref.sessionId}.jsonl`),
      [
        entry(now - 499, 'response_item', { type: 'function_call_output', call_id: 'first', output: 'ok' }),
        entry(now - 498, 'event_msg', { type: 'task_started' }),
      ].join('\n') + '\n'
    );
    for (let i = 0; i < 50; i++) {
      view = await runtime.tick(f.parent.ref.sessionId);
      await runtime.afterPaint((published) => {
        if (published) view = published;
      });
      if ((view?.details[key]?.status?.observationStamp?.commitSeq ?? 0) > priorSeq) break;
    }
    assert.ok((view?.details[key]?.status?.observationStamp?.commitSeq ?? 0) > priorSeq, 'new turn published');
    assert.equal(view?.details[key]?.outputRate, undefined, 'new commit must clear old publisher rate');
    for (let i = 0; i < 50; i++) {
      followerView = await follower.tick(f.parent.ref.sessionId);
      if ((followerView?.details[key]?.status?.observationStamp?.commitSeq ?? 0) > priorSeq) break;
    }
    assert.ok(
      (followerView?.details[key]?.status?.observationStamp?.commitSeq ?? 0) > priorSeq,
      'follower observed new commit'
    );
    assert.equal(followerView?.details[key]?.outputRate, undefined, 'new commit must clear old follower rate');
    assert.equal(followerView?.details[key]?.action, undefined, 'new commit must clear old follower action');
  }
);

test('checkpoint action reads only the exact tail key and preserves refusal and old-data semantics', () => {
  const stats = { bytesRead: 0, recordsRead: 0, elapsedMs: 0 };
  const grant = {} as RecoveryReadGrant;
  let calls = 0;
  let outcome: any = {
    kind: 'value',
    value: JSON.stringify({ id: 'tail', name: 'exec_command', timestamp: 100, status: 'running', target: 'safe' }),
    stats,
  };
  const checkpoint = {
    ref: { harness: 'codex' },
    codex: { rollout: { version: 3, state: { runningTail: 'tail', runningCount: 2 } } },
    recoveryIndex: {
      lookup: {
        getMetered: (_grant: unknown, ns: string, key: string) => {
          calls++;
          assert.equal(ns, 'codex.running');
          assert.equal(key, 'tail');
          return outcome;
        },
        page: () => assert.fail('history scan'),
      },
    },
  } as unknown as CodexCheckpoint;
  assert.deepEqual(checkpointAction(checkpoint, grant, 200), {
    kind: 'value',
    action: { id: 'tail', name: 'exec_command', target: 'safe', startedAt: 100 },
  });
  assert.equal(calls, 1);
  outcome = { kind: 'refused', reason: 'deadline', stats };
  assert.deepEqual(checkpointAction(checkpoint, grant, 200), { kind: 'retry' });
  outcome = { kind: 'stale', stats };
  assert.deepEqual(checkpointAction(checkpoint, grant, 200), { kind: 'stale' });
  checkpoint.codex.rollout.state.runningTail = null;
  checkpoint.codex.rollout.state.runningCount = 0;
  assert.deepEqual(checkpointAction(checkpoint, grant, 200), { kind: 'value' });
  assert.equal(calls, 3);
});
