import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectorRows } from '../../src/render/monitor-inspector.js';
import { stripAnsi } from '../../src/render/colors.js';
import { buildVm, S, ago } from '../fixtures/b10b-delegation.js';
import { draw, monitorInput, press } from '../fixtures/b10b-s3.js';

function inspect(vm: ReturnType<typeof buildVm>['vm'], key: string) {
  const frame = draw(vm, { selected: key, width: 140, height: 50 });
  const opened = press(frame, 'enter');
  const next = draw(vm, { state: opened.state, width: 140, height: 50 });
  const input = monitorInput(vm, { state: next.state, width: 140, height: 50 });
  const rows = inspectorRows(input, next.state, 140, input.nowMs!, next.delegation).map((row) => stripAnsi(row.text));
  return { rows: rows.join('\n'), frame: next.lines.map(stripAnsi).join('\n'), controls: next.controls };
}

function fixture() {
  const built = buildVm(
    [
      { id: 'main', root: true, harness: 'claude', status: S.working(), label: null },
      {
        id: 'one',
        parent: 'main',
        harness: 'codex',
        label: 'same-label',
        status: S.working(),
        run: { state: 'uncertain', mode: 'headless' },
      },
      {
        id: 'two',
        parent: 'main',
        harness: 'codex',
        label: 'same-label',
        status: S.exited(ago(10)),
        run: { state: 'running', mode: 'visible' },
        report: { status: 'completed', at: ago(10) },
      },
    ],
    { capacity: { active: 3, limit: 6, mine: 2, mineLimit: 4 } }
  );
  built.vm.tree.ledger.state = 'available';
  const a = built.vm.tree.nodes.find((node) => node.key === built.keys.one)!;
  const b = built.vm.tree.nodes.find((node) => node.key === built.keys.two)!;
  const cap = built.vm.capacity!;
  cap.occupants = [
    {
      runId: a.currentRun!.runId,
      linkId: a.currentRun!.linkId,
      state: 'uncertain',
      since: 1,
      holder: 'self',
      retireEta: null,
    },
    {
      runId: b.currentRun!.runId,
      linkId: b.currentRun!.linkId,
      state: 'running',
      since: 2,
      holder: 'self',
      retireEta: null,
    },
    { runId: 'outside', linkId: 'outside-link', state: 'running', since: 3, holder: 'other', retireEta: null },
  ];
  return { ...built, a, b };
}

test('root Slots uses capacity counts and exact run facts, without adding actions', () => {
  const f = fixture();
  const result = inspect(f.vm, f.keys.main);
  assert.match(result.rows, /3\/6 held · mine 2\/4/);
  assert.match(result.rows, /Limits: default/);
  assert.match(result.rows, /uncertain · reconcile first/);
  assert.match(result.rows, /running · close pane/);
  assert.match(result.rows, /Other holders: 1/);
  assert.match(result.frame, /3\/6 held/);
  assert.doesNotMatch(result.rows, /hud run reconcile/);
  const other = inspect(f.vm, f.keys.one);
  assert.doesNotMatch(other.rows, /3\/6 held|Other holders/);
});

test('unavailable or degraded capacity is never displayed as zero occupancy', () => {
  const f = fixture();
  f.vm.tree.ledger.state = 'degraded';
  f.vm.tree.ledger.reason = 'ledger_busy';
  const result = inspect(f.vm, f.keys.main);
  assert.match(result.rows, /Slots unavailable/);
  assert.doesNotMatch(result.rows, /3\/6 held|0\/6 held/);
  f.vm.tree.ledger.state = 'available';
  f.vm.capacity = null;
  assert.match(inspect(f.vm, f.keys.main).rows, /Slots unavailable/);
});

test('a reported agent still working does not acquire a close-pane hint', () => {
  const f = fixture();
  const detail = f.vm.details[f.keys.two];
  detail.status!.activity = 'working';
  detail.status!.stateKey = 'working';
  assert.doesNotMatch(inspect(f.vm, f.keys.main).rows, /close pane/);
});

test('known zero capacity is shown without inventing holders', () => {
  const f = fixture();
  f.vm.capacity = { active: 0, limit: 6, mine: 0, mineLimit: 4, full: false, occupants: [] };
  const result = inspect(f.vm, f.keys.main);
  assert.match(result.rows, /0\/6 held · mine 0\/4/);
  assert.doesNotMatch(result.rows, /Other holders/);
});

test('candidate scope uses complete session ref or exact link, never matching labels', () => {
  const f = fixture();
  assert.equal(f.a.identity.kind, 'session');
  assert.equal(f.b.identity.kind, 'session');
  if (f.a.identity.kind !== 'session' || f.b.identity.kind !== 'session') throw new Error('fixture');
  const make = (ref: typeof f.a.identity.ref, reason: string, linkId: string | null = null) => ({
    ref,
    reason,
    linkId,
    kind: 'transcript' as const,
    recordId: reason,
    asOf: null,
    observedAt: 1,
  });
  const foreign = { ...f.a.identity.ref, sourceId: 'cd'.repeat(32) };
  f.vm.tree.candidates = [
    make(f.a.identity.ref, 'selected-ref'),
    make(foreign, 'foreign-source'),
    make(f.b.identity.ref, 'other-node'),
  ];
  const selected = inspect(f.vm, f.keys.one);
  assert.match(selected.rows, /selected-ref/);
  assert.doesNotMatch(selected.rows, /foreign-source|other-node/);
  assert.match(selected.rows, /unconfirmed/);
  f.vm.tree.truncation.candidates = 2;
  const root = inspect(f.vm, f.keys.main);
  assert.match(root.rows, /Candidates · tree-wide · unconfirmed/);
  assert.match(root.rows, /foreign-source/);
  assert.match(root.rows, /\+2 candidate metadata entries not listed/);
  f.a.links.push('explicit-link');
  f.vm.tree.candidates.push(make(foreign, 'linked\u001b[31m', 'explicit-link'));
  const linked = inspect(f.vm, f.keys.one);
  assert.match(linked.rows, /linked\\x1b\[31m/);
  assert.doesNotMatch(linked.rows, /\u001b/);
});
