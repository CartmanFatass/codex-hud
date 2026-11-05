import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeJevBrowser } from '../fakes/jev-browser.js';
import { mvpOperationPolicy } from '../../src/core/execution.js';
import { leaseReleasePolicy } from '../../src/core/supervision.js';

const owner = 'synthetic-owner',
  browser = 'synthetic-browser';
const ref = (account: string, key: string) => ({
  kind: 'jev' as const,
  provider: 'synthetic-provider',
  account: `synthetic-${account}`,
  key: `synthetic-${key}`,
});
const input = (account: string, key: string, target = browser) => ({
  ref: ref(account, key),
  owner,
  browser: target,
  requestId: `synthetic-id-${key}`,
  requestFingerprint: `synthetic-request-${key}`,
});

test('two accounts queue on one browser and independent browser proceeds', () => {
  const f = new FakeJevBrowser(),
    a = input('one', 'one'),
    b = { ...input('two', 'two'), owner: 'synthetic-owner-two' },
    c = input('two', 'three', 'synthetic-browser-two');
  f.enqueue(a);
  f.enqueue(b);
  f.enqueue(c);
  const aRun = f.dispatch(owner, a.ref, 'received');
  assert.throws(() => f.dispatch(b.owner, b.ref, 'received'), /browser_busy/);
  assert.equal(f.view(b.owner, b.ref).fakeState, 'queued');
  assert.equal(f.view(b.owner, b.ref).holderLabel, owner);
  assert.equal(f.dispatch(owner, c.ref, 'received').state, 'sent');
  f.observe(owner, a.ref, aRun.generation, 'answered');
  assert.throws(() => f.dispatch(b.owner, b.ref, 'received'), /browser_busy/);
  f.reconcile(owner, a.ref, aRun.generation, 'answered', 'synthetic-answer');
  const bRun = f.dispatch(b.owner, b.ref, 'received');
  assert.ok(bRun.generation > aRun.generation);
  assert.equal(f.view(b.owner, b.ref).holderLabel, b.owner);
  f.reconcile(owner, a.ref, aRun.generation, 'answered', 'synthetic-answer');
  assert.equal(f.view(b.owner, b.ref).holderLabel, b.owner);
  assert.throws(() => f.reconcile(owner, a.ref, aRun.generation, 'answered', 'synthetic-other'), /terminal_conflict/);
  assert.throws(() => f.reconcile(owner, a.ref, aRun.generation, 'failed'), /terminal_conflict/);
  assert.throws(() => f.reconcile(owner, a.ref, bRun.generation, 'answered', 'synthetic-answer'), /terminal_conflict/);
  assert.equal(f.view(b.owner, b.ref).holderGeneration, bRun.generation);
  assert.throws(() => f.observe(owner, a.ref, aRun.generation, 'failed'), /stale_or_foreign/);
});

test('same full JobRef/request replays without dispatch and conflicting reuse is refused', () => {
  const f = new FakeJevBrowser(),
    a = input('one', 'one');
  assert.equal(f.enqueue(a).replay, false);
  assert.equal(f.enqueue(a).replay, true);
  assert.throws(() => f.enqueue({ ...a, requestFingerprint: 'synthetic-other' }), /request_conflict/);
  assert.throws(() => f.enqueue({ ...a, owner: 'synthetic-other-owner' }), /request_conflict/);
  assert.throws(() => f.enqueue({ ...a, browser: 'synthetic-other-browser' }), /request_conflict/);
  assert.throws(() => f.enqueue({ ...a, ref: ref('one', 'different') }), /request_conflict/);
  assert.throws(() => f.enqueue({ ...a, requestId: 'synthetic-other-id' }), /request_conflict/);
  f.dispatch(owner, a.ref, 'received');
  assert.throws(() => f.dispatch(owner, a.ref, 'received'), /no_retry/);
  assert.equal(f.view(owner, a.ref).dispatches, 1);
});

test('lost response, runner loss, timeout and needs human retain ownership until reconciled terminal', () => {
  const f = new FakeJevBrowser(),
    a = input('one', 'one'),
    b = input('two', 'two');
  f.enqueue(a);
  f.enqueue(b);
  const { generation } = f.dispatch(owner, a.ref, 'lost');
  assert.equal(f.view(owner, a.ref).fakeState, 'uncertain');
  assert.throws(() => f.dispatch(owner, a.ref, 'received'), /no_retry/);
  for (const event of ['timeout', 'human', 'runner-loss'] as const) {
    if (event === 'timeout') f.simulateTimeout(owner, a.ref, generation);
    else if (event === 'runner-loss') f.simulateRunnerLoss(owner, a.ref, generation);
    else f.observe(owner, a.ref, generation, 'needs_human');
    assert.equal(f.view(owner, a.ref).browserHeld, true);
    assert.throws(() => f.dispatch(owner, b.ref, 'received'), /browser_busy/);
  }
  assert.throws(() => f.reconcile(owner, a.ref, generation, 'answered'), /outcome_mismatch/);
  f.observe(owner, a.ref, generation, 'failed');
  assert.throws(() => f.reconcile(owner, a.ref, generation, 'answered'), /outcome_mismatch/);
  f.reconcile(owner, a.ref, generation, 'failed');
  assert.equal(f.view(owner, a.ref).browserHeld, false);
  assert.equal(f.dispatch(owner, b.ref, 'received').state, 'sent');
});

test('fake view keeps unloaded HUD identity and synthetic outcome separate; no early answer or model authority', () => {
  const f = new FakeJevBrowser(),
    a = input('one', 'one');
  f.enqueue(a);
  const gen = f.dispatch(owner, a.ref, 'received').generation;
  f.observe(owner, a.ref, gen, 'answered');
  const before = f.view(owner, a.ref);
  assert.equal(before.provenance, 'SIMULATED');
  assert.equal(before.hudNode.identity.kind, 'job');
  assert.deepEqual(before.counts, { jobs: 1, sessions: 0 });
  assert.equal(before.hudNode.loaded, false);
  assert.equal(before.hudNode.observation, null);
  assert.equal('syntheticAnswer' in before, false);
  assert.equal(before.reconciled, false);
  assert.throws(() => f.reconcile('synthetic-foreign', a.ref, gen, 'answered', 'synthetic-answer'), /not_owned/);
  f.reconcile(owner, a.ref, gen, 'answered', 'synthetic-answer');
  const after = f.view(owner, a.ref);
  assert.equal(after.syntheticAnswer, 'synthetic-answer');
  assert.equal(after.hudNode.loaded, false);
  assert.equal(after.browserHeld, false);
  assert.deepEqual(mvpOperationPolicy('jev_send'), { allowed: false, reason: 'unsupported', dispatches: 0 });
  assert.deepEqual(mvpOperationPolicy('browser_control'), { allowed: false, reason: 'unsupported', dispatches: 0 });
  assert.equal(leaseReleasePolicy({ kind: 'browser', outcome: 'needs_human', reconciled: true }), 'hold');
});

test('full JobRef separates accounts and detached views cannot mutate the fake', () => {
  const f = new FakeJevBrowser(),
    a = input('one', 'shared'),
    b = { ...input('two', 'shared', 'synthetic-other-browser'), requestId: 'synthetic-id-other' };
  f.enqueue(a);
  f.enqueue(b);
  f.dispatch(owner, a.ref, 'received');
  f.dispatch(owner, b.ref, 'received');
  const x = f.view(owner, a.ref),
    y = f.view(owner, b.ref);
  assert.notEqual(x.hudNode.key, y.hudNode.key);
  x.identity.ref.key = 'synthetic-altered';
  assert.equal(f.view(owner, a.ref).identity.ref.key, 'synthetic-shared');
});

test('strict synthetic-only input and bounded jobs', () => {
  const f = new FakeJevBrowser();
  assert.throws(() => f.enqueue({ ...input('one', 'one'), owner: 'real-user' }), /invalid_input/);
  for (let i = 0; i < 128; i++) f.enqueue(input('one', `job-${i}`));
  assert.throws(() => f.enqueue(input('one', 'overflow')), /job_limit/);
});
