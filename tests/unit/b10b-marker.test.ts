/**
 * Design §3.3: five state dimensions plus the ledger's run facts become one
 * marker, first matching row wins. One test per row (and the order between
 * rows), through the same projection the bar, the statusline and the panel use.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ProjectionCache, projectDelegation } from '../../src/render/delegation/projection.js';
import { planRows } from '../../src/render/delegation/rows.js';
import type { NodeMarker } from '../../src/render/delegation/marker.js';
import { W } from '../../src/render/delegation/style.js';
import { NOW, S, ago, buildVm, type NodeSpec } from '../fixtures/b10b-delegation.js';

function markerOf(child: Partial<NodeSpec>, extra: NodeSpec[] = []): NodeMarker {
  const { vm } = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.idle() },
    { id: 'c', parent: 'main', ...child },
    ...extra,
  ]);
  const proj = projectDelegation(vm, new ProjectionCache());
  return proj.byKey.get('codex:c')!.proj.marker;
}

test('row 1: conflicting records are a warning, before anything the node itself says', () => {
  const m = markerOf({ conflict: { count: 2, since: ago(360) }, status: S.pending('approval', ago(10)) });
  assert.equal(m.glyph, 'warn');
  assert.equal(m.role, 'warning');
  assert.deepEqual(m.words, [W.conflict]);
  assert.equal(m.rank, 0);
  assert.equal(m.trouble, true);
  assert.deepEqual(m.clock, { kind: 'dwell', at: ago(360), approx: true }, 'the conflict clock is always approximate');
});

test('row 2a: a dead supervisor is `? supervisor lost`, warning, with the evidence age as its clock', () => {
  const m = markerOf({
    run: { state: 'uncertain', mode: 'visible', reconciliation: 'supervisor_dead' },
    status: { cls: 'uncertain', reason: 'supervisor_dead', since: ago(420), evidenceAt: ago(430) },
  });
  assert.equal(m.glyph, 'unknown');
  assert.equal(m.role, 'warning');
  assert.deepEqual(m.words, [W.supervisorLost]);
  assert.equal(m.supervisorLost, true);
  assert.equal(m.uncertain, true);
  assert.equal(m.clock.kind, 'evidence');
  assert.equal(m.clock.at, ago(430));
});

test('row 2b: any other uncertain run is `? uncertain`, warning', () => {
  const m = markerOf({
    run: { state: 'uncertain', mode: 'headless', reconciliation: 'scope_unknown', heartbeatAt: ago(134) },
    status: { cls: 'uncertain', reason: 'scope_unknown', since: ago(840), evidenceAt: ago(834) },
  });
  assert.equal(m.glyph, 'unknown');
  assert.equal(m.role, 'warning');
  assert.deepEqual(m.words, [W.uncertain]);
  assert.equal(m.supervisorLost, false);
  assert.equal(m.rank, 0);
});

test('row 3: something waits for a person is the alert marker, with its own word', () => {
  for (const [reason, word] of [
    ['approval', W.approval],
    ['question', W.question],
    ['needs_human', W.needsHuman],
  ] as const) {
    const m = markerOf({ status: S.pending(reason, ago(10)) });
    assert.equal(m.glyph, 'flag', reason);
    assert.equal(m.role, 'alert', reason);
    assert.deepEqual(m.words, [word], reason);
    assert.equal(m.rank, 0);
    assert.equal(m.sinceMs, ago(10));
    assert.deepEqual(m.clock, { kind: 'dwell', at: ago(10), approx: false });
  }
  const blocked = markerOf({
    status: S.working(),
    report: { status: 'blocked', summary: 'needs a decision', at: ago(30) },
  });
  assert.equal(blocked.glyph, 'flag');
  assert.deepEqual(blocked.words, [W.blocked]);
  const observed = markerOf({
    status: { cls: 'pending', reason: 'approval', pending: 'approval', since: ago(10), basis: 'observed' },
  });
  assert.deepEqual(observed.clock, { kind: 'dwell', at: ago(10), approx: true }, '`observed` is a `~` age');
});

test('row 4: failure is `!`, danger, and not a guess from the exit shell status', () => {
  const turn = markerOf({ status: S.failed(ago(45)) });
  assert.equal(turn.glyph, 'fail');
  assert.equal(turn.role, 'danger');
  assert.deepEqual(turn.words, [W.failed]);
  assert.equal(turn.rank, 0, 'a failed turn on a live node still needs a look');

  const native = markerOf({
    run: { state: 'ended', endedAt: ago(100), exit: { code: 1, signal: null, source: 'wait_status' } },
    status: S.exited(ago(100)),
  });
  assert.equal(native.glyph, 'fail', 'a sourced non-zero exit is a failure');
  assert.equal(native.rank, 3);
  assert.equal(native.historyEligible, true);

  const unsourced = markerOf({
    run: { state: 'ended', endedAt: ago(100) },
    status: S.exited(ago(100)),
  });
  assert.notEqual(unsourced.glyph, 'fail', 'no exit source, no exit failure');

  const report = markerOf({
    run: { state: 'ended', endedAt: ago(100) },
    status: S.exited(ago(100)),
    report: { status: 'failed', summary: 'Lint rule 12 unresolved.', at: ago(100) },
  });
  assert.equal(report.glyph, 'fail');
  assert.equal(report.rank, 3);

  const launch = markerOf({ run: { state: 'failed', endedAt: ago(20), launchFailure: true }, status: null });
  assert.equal(launch.glyph, 'fail');
  assert.deepEqual(launch.words, [W.launchFailed]);
});

test('row 5a: a visible cancel that cannot be delivered is `⚑ stop in pane`, alive, alert', () => {
  const m = markerOf({
    run: { state: 'cancelling', mode: 'visible', cancelRequestedAt: ago(130) },
    // B16 maps a cancelling run to `interrupted:cancelling`, entered when the intent was accepted.
    status: { cls: 'interrupted', reason: 'cancelling', since: ago(130), outcome: 'none' },
  });
  assert.equal(m.glyph, 'flag');
  assert.equal(m.role, 'alert');
  assert.deepEqual(m.words, [W.stopInPane]);
  assert.equal(m.stopInPane, true);
  assert.equal(m.rank, 0);
  assert.equal(m.clock.at, ago(130), 'the dwell is the time since the cancel was accepted');
  const unpublished = markerOf({
    run: { state: 'cancelling', mode: 'visible', cancelRequestedAt: ago(75) },
    status: null,
  });
  assert.equal(unpublished.glyph, 'flag', 'the ledger alone is enough to know the cancel is waiting on the pane');
  assert.equal(unpublished.clock.at, ago(75), 'without a status the ledger time stands in');
});

test('row 5b: interrupted, a headless cancelling ladder and a cancelled run are `■`, warning', () => {
  const interrupted = markerOf({ status: S.interrupted(ago(40)) });
  assert.equal(interrupted.glyph, 'stop');
  assert.equal(interrupted.role, 'warning');
  assert.deepEqual(interrupted.words, [W.interrupted]);

  const cancelling = markerOf({
    run: { state: 'cancelling', mode: 'headless', cancelRequestedAt: ago(3) },
    status: S.working(ago(100)),
  });
  assert.equal(cancelling.glyph, 'stop');
  assert.deepEqual(cancelling.words, [W.cancelling]);
  assert.equal(cancelling.rank, 2, 'cancelling is alive in fact: the tail of the alive bucket');
  assert.equal(cancelling.historyEligible, false);

  const cancelled = markerOf({
    run: { state: 'cancelled', endedAt: ago(5400), cancelRequestedAt: ago(5410) },
    status: S.exited(ago(5400)),
  });
  assert.equal(cancelled.glyph, 'stop');
  assert.deepEqual(cancelled.words, [W.cancelled]);
  assert.equal(cancelled.rank, 3);
  assert.equal(cancelled.historyEligible, true);

  const reported = markerOf({ report: { status: 'interrupted', summary: '', at: ago(30) }, status: S.working() });
  assert.equal(reported.glyph, 'stop');
});

test('row 6: lost sources are a muted `?`, never the last known good marker', () => {
  const stale = markerOf({ status: S.stale(ago(48), ago(48)) });
  assert.equal(stale.glyph, 'unknown');
  assert.equal(stale.role, 'muted');
  assert.deepEqual(stale.words, [W.stale]);
  assert.equal(stale.stale, true);
  assert.equal(stale.muteName, 'always');
  assert.deepEqual(stale.clock, { kind: 'evidence', at: ago(48), approx: false });

  const unknown = markerOf({
    status: { cls: 'unknown', freshness: 'unknown', since: null, basis: 'unknown', evidenceAt: null },
  });
  assert.deepEqual(unknown.words, [W.unknown]);
  assert.equal(unknown.clock.at, null, 'no evidence time, no age');
});

test('row 7: working is `▸`, info, with a turn clock', () => {
  const m = markerOf({ status: S.working(ago(724)) });
  assert.equal(m.glyph, 'working');
  assert.equal(m.role, 'info');
  assert.deepEqual(m.words, []);
  assert.equal(m.rank, 1);
  assert.deepEqual(m.clock, { kind: 'turn', at: ago(724), approx: false });
});

test('row 8: starting is a quiet `·`', () => {
  const m = markerOf({ run: { state: 'starting', createdAt: ago(12) }, status: S.starting(ago(12)) });
  assert.equal(m.glyph, 'starting');
  assert.equal(m.role, 'muted');
  assert.deepEqual(m.words, [W.starting]);
  assert.equal(m.trouble, true, 'a starting row drops its badge and meter');
  const waiting = markerOf({ linkState: 'pending', run: false, status: null }, []);
  assert.equal(waiting.glyph, 'starting', 'a link that is only pending, with no activity, is starting');
});

test('row 9a: an ended run is `✓` with a report and `■` without; the cause stays on the row', () => {
  const reported = markerOf({
    run: { state: 'ended', endedAt: ago(600) },
    status: S.exited(ago(600)),
    report: { status: 'completed', summary: 'Done.', at: ago(610) },
  });
  assert.equal(reported.glyph, 'done');
  assert.equal(reported.role, 'success');
  assert.deepEqual(reported.words, [W.reported]);
  assert.equal(reported.rank, 3);
  assert.equal(reported.historyEligible, true);
  assert.equal(reported.fadesAfterMs, 60_000);

  const ended = markerOf({ run: { state: 'ended', endedAt: ago(600) }, status: S.exited(ago(600)) });
  assert.equal(ended.glyph, 'stop');
  assert.deepEqual(ended.words, [W.ended]);

  for (const [cause, word] of [
    ['runtime_limit', W.runtimeLimit],
    ['retire_idle', W.idleLimit],
    ['retire_blocked_wait', W.blockedLimit],
    ['orphan_policy', W.parentGone],
  ] as const) {
    const limited = markerOf({
      run: { state: 'ended', endedAt: ago(7200), requestedCause: cause },
      status: S.exited(ago(7200)),
    });
    assert.deepEqual(limited.words, [W.ended, word], cause);
  }
  const retired = markerOf({
    run: { state: 'ended', endedAt: ago(7200), requestedCause: 'retire_after_report' },
    status: S.exited(ago(7200)),
  });
  assert.deepEqual(retired.words, [W.ended], '`retire_after_report` adds no word');

  const plain = markerOf({ run: false, native: true, status: S.exited(ago(3600)) });
  assert.equal(plain.glyph, 'stop');
  assert.deepEqual(plain.words, [W.exited], 'a session with no managed run exits as `■ exited`');
});

test('row 9b: a reported agent that is still alive keeps its slot and says so', () => {
  const visible = markerOf({
    run: { state: 'running', mode: 'visible' },
    status: S.exited(ago(480)),
    report: { status: 'completed', summary: 'Done.', at: ago(480) },
  });
  assert.equal(visible.glyph, 'done');
  assert.deepEqual(visible.words, [W.closePane]);
  assert.equal(visible.closePane, true);
  assert.equal(visible.rank, 2, 'alive, at the tail of its bucket');
  assert.equal(visible.historyEligible, false);

  const headless = markerOf({
    run: { state: 'running', mode: 'headless' },
    status: S.exited(ago(30)),
    report: { status: 'completed', summary: 'Done.', at: ago(30) },
  });
  assert.equal(headless.glyph, 'done');
  assert.deepEqual(headless.words, [W.reported]);
  assert.equal(headless.closePane, false);
  assert.equal(headless.rank, 2);

  const failed = markerOf({
    run: { state: 'running', mode: 'visible' },
    status: S.working(),
    report: { status: 'failed', summary: 'Gave up.', at: ago(60) },
  });
  assert.equal(failed.glyph, 'fail');
  assert.equal(failed.closePane, true, 'a failed report on a visible agent is also closed in the pane');
  assert.deepEqual(failed.words, [W.failed], 'the `!` row keeps `failed`');
});

test('row 10: idle is `✓` for a session and `·` for a delegation that has not reported', () => {
  const { vm } = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.idle(ago(120)) },
    { id: 'managed', parent: 'main', status: S.idle(ago(90)) },
    { id: 'nat', parent: 'main', native: true, status: S.idle(ago(90)) },
  ]);
  const proj = projectDelegation(vm, new ProjectionCache());
  const root = proj.byKey.get('claude:main')!.proj.marker;
  assert.equal(root.glyph, 'done');
  assert.equal(root.rank, 1, 'the root is never history');
  assert.equal(root.historyEligible, false);
  const managed = proj.byKey.get('codex:managed')!.proj.marker;
  assert.equal(managed.glyph, 'starting', 'only a report earns the green check');
  assert.deepEqual(managed.words, [W.idle]);
  const native = proj.byKey.get('codex:nat')!.proj.marker;
  assert.equal(native.glyph, 'done');
  assert.equal(native.rank, 3);
  assert.equal(native.historyEligible, true);
});

test('row 11: no evidence is `? unknown`, muted, and an unavailable status is never healthy', () => {
  const unavailable = markerOf({ status: null });
  assert.equal(unavailable.glyph, 'unknown');
  assert.equal(unavailable.role, 'muted');
  assert.deepEqual(unavailable.words, [W.unknown]);
  assert.equal(unavailable.clock.at, null);

  const odd = markerOf({
    status: { cls: 'unknown', freshness: 'fresh', liveness: 'alive', since: null, basis: 'unknown' },
  });
  assert.equal(odd.glyph, 'unknown');
  assert.deepEqual(odd.words, [W.unknown]);
});

test('a node the observation did not load is `? not loaded`, or a history row when the ledger knows it ended', () => {
  const live = markerOf({ loaded: false, run: { state: 'running' } });
  assert.equal(live.glyph, 'unknown');
  assert.deepEqual(live.words, [W.notLoaded]);
  assert.equal(live.notLoaded, true);
  assert.equal(live.role, 'muted');
  assert.equal(live.clock.at, null, 'the old summary is history, not a current clock');

  const ended = markerOf({
    loaded: false,
    run: { state: 'ended', endedAt: ago(3 * 86_400) },
    report: { status: 'completed', summary: 'Done.', at: ago(3 * 86_400) },
  });
  assert.equal(ended.glyph, 'done', 'a terminal run the ledger knows about is a history row');
  assert.equal(ended.notLoaded, false);
});

test('the first matching row wins: the order of the table', () => {
  // 1 beats 2: a conflicting node is not also uncertain.
  assert.equal(
    markerOf({ conflict: { count: 2, since: ago(60) }, run: { state: 'uncertain', reconciliation: 'scope_unknown' } })
      .glyph,
    'warn'
  );
  // 2 beats 3 and 4: reconcile first.
  const uncertain = markerOf({
    run: { state: 'uncertain', reconciliation: 'scope_unknown' },
    status: S.pending('approval', ago(10)),
    report: { status: 'failed', summary: '', at: ago(5) },
  });
  assert.deepEqual(uncertain.words, [W.uncertain]);
  // 3 beats 4: a person is needed before the failure is read.
  const pending = markerOf({
    status: S.pending('question', ago(10)),
    report: { status: 'failed', summary: '', at: ago(5) },
  });
  assert.deepEqual(pending.words, [W.question]);
  // 4 beats 5b and 7.
  assert.equal(
    markerOf({
      status: { cls: 'failed', reason: 'turn', outcome: 'failed', since: ago(5) },
      report: { status: 'interrupted', summary: '', at: ago(9) },
    }).glyph,
    'fail'
  );
  // 5a beats 5b and 7.
  assert.equal(
    markerOf({ run: { state: 'cancelling', mode: 'visible', cancelRequestedAt: ago(5) }, status: S.working() }).glyph,
    'flag'
  );
  // 6 beats 7: a working node with lost sources is not shown as working.
  assert.equal(markerOf({ status: S.stale(ago(40), ago(40)) }).glyph, 'unknown');
});

test('only the delegation words the design lists are used', () => {
  const words = new Set<string>(Object.values(W));
  for (const needed of [
    'approval',
    'question',
    'needs human',
    'blocked',
    'stop in pane',
    'close pane',
    'conflict',
    'supervisor lost',
  ])
    assert.ok(words.has(needed), needed);
  assert.equal(NOW > 0, true);
});

test('§3.2: a native child that has ended is history whether it ended well, badly or interrupted', () => {
  const ended = (status: object, native = true) => markerOf({ native, status: status as never });
  // Failure with the process gone: still `!`, but a finished row with a known finish time.
  const failed = ended({ cls: 'failed', reason: 'turn', since: ago(400), liveness: 'gone' });
  assert.equal(failed.glyph, 'fail');
  assert.equal(failed.rank, 3);
  assert.equal(failed.historyEligible, true);
  assert.equal(failed.finishedAt, ago(400));
  assert.equal(failed.muteName, 'afterFade');
  assert.deepEqual(failed.clock, { kind: 'age', at: ago(400), approx: false });
  // The same with the process alive is a failure that still needs a look.
  const alive = ended({ cls: 'failed', reason: 'turn', since: ago(400), liveness: 'alive' });
  assert.equal(alive.rank, 0);
  assert.equal(alive.historyEligible, false);
  // Interrupted, gone: `■`, rank 3, history; alive: rank 2.
  const stopped = ended({ cls: 'interrupted', reason: 'turn', since: ago(400), liveness: 'gone' });
  assert.equal(stopped.glyph, 'stop');
  assert.equal(stopped.rank, 3);
  assert.equal(stopped.historyEligible, true);
  assert.equal(stopped.finishedAt, ago(400));
  assert.equal(ended({ cls: 'interrupted', reason: 'turn', since: ago(400) }).rank, 2);
  // Only a process that is known to be gone ends it.
  assert.equal(ended({ cls: 'failed', reason: 'turn', since: ago(400), liveness: 'unknown' }).rank, 0);
  // A managed run's end is the ledger's alone: a gone process under a running run is not history.
  const managed = markerOf({
    run: { state: 'running' },
    status: { cls: 'failed', reason: 'turn', since: ago(400), liveness: 'gone' },
  });
  assert.equal(managed.rank, 0);
  assert.equal(managed.historyEligible, false);
  // The viewpoint root is never history.
  const { vm } = buildVm([
    {
      id: 'main',
      root: true,
      harness: 'claude',
      status: { cls: 'failed', reason: 'turn', since: ago(400), liveness: 'gone' },
    },
  ]);
  const root = projectDelegation(vm, new ProjectionCache()).byKey.get('claude:main')!.proj.marker;
  assert.equal(root.historyEligible, false);
});

test('§3.2: a finished failed native lets its finished subtree fold after the linger window', () => {
  const { vm } = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working() },
    {
      id: 'p',
      parent: 'main',
      run: { state: 'ended', endedAt: ago(500) },
      status: S.exited(ago(500)),
      report: { status: 'completed', summary: 'ok', at: ago(500) },
    },
    {
      id: 'n',
      parent: 'p',
      native: true,
      label: 'probe',
      status: { cls: 'failed', reason: 'turn', since: ago(400), liveness: 'gone' },
    },
  ]);
  const rows = planRows(projectDelegation(vm, new ProjectionCache()), { nowMs: NOW }).rows;
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['node', 'putAway'],
    'the parent and its failed native go together, as one row'
  );
  assert.equal(rows[1].put?.count, 2);
});

test('§3.3 row 6: the current freshness decides, never a retained `stale` state key', () => {
  const retained = (freshness: 'fresh' | 'stale' | 'unknown') =>
    markerOf({ status: { cls: 'stale', reason: 'heartbeat', since: ago(60), freshness } });
  // Sources are back: the node is what its activity says, whatever key the commit still carries.
  const recovered = retained('fresh');
  assert.equal(recovered.glyph, 'working');
  assert.deepEqual(recovered.words, []);
  // Sources are lost: `stale`. Unreadable: `unknown`, not `stale`.
  assert.deepEqual(retained('stale').words, [W.stale]);
  assert.deepEqual(retained('unknown').words, [W.unknown]);
  // Both directions through the projection cache with the commit stamps untouched.
  const cache = new ProjectionCache();
  const glyphs = (freshness: 'fresh' | 'stale') => {
    const { vm } = buildVm([
      { id: 'main', root: true, harness: 'claude', status: S.idle() },
      { id: 'c', parent: 'main', status: { cls: 'stale', reason: 'heartbeat', since: ago(60), freshness } },
    ]);
    return projectDelegation(vm, cache).byKey.get('codex:c')!.proj.marker.glyph;
  };
  assert.deepEqual(
    ['fresh', 'stale', 'fresh', 'stale'].map((f) => glyphs(f as 'fresh' | 'stale')),
    ['working', 'unknown', 'working', 'unknown']
  );
});

test('§3.4: a clock that ran backwards leaves the clock empty and the node without an entering time', () => {
  const m = markerOf({
    status: { cls: 'unknown', since: ago(100), basis: 'event', evidenceAt: NOW + 60_000, clockAnomaly: true },
  });
  assert.equal(m.glyph, 'unknown');
  assert.deepEqual(m.clock, { kind: 'none', at: null, approx: false });
  assert.equal(m.sinceMs, null);
  assert.equal(m.sinceBasis, 'unknown');
  // A working node: no turn clock either.
  const working = markerOf({ status: { cls: 'working', since: ago(100), clockAnomaly: true } });
  assert.equal(working.glyph, 'working');
  assert.equal(working.clock.kind, 'none');
  assert.equal(working.clock.at, null);
  // The same node with a sane clock keeps both.
  assert.equal(markerOf({ status: { cls: 'working', since: ago(100) } }).clock.at, ago(100));
});
