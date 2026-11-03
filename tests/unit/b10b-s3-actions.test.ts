/**
 * B10B-s3: the `⇢` and `↻` buttons of the selected delegation row, the keys that go with them, and the typed actions
 * (design §3.7; rulings B10B-s3 Q1, Q3, Q4). The panel executes nothing and builds no command; a key acts exactly when
 * its button is drawn and does what a click on that button does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { setLanguage } from '../../src/render/i18n.js';
import type { MonitorFrame } from '../../src/render/monitor.js';
import { RESUME_DIAGNOSTIC, rowActions } from '../../src/render/delegation/actions.js';
import { S, ago, buildVm, situationE, type NodeSpec, type RunSpec } from '../fixtures/b10b-delegation.js';
import { makeNestedTree } from '../fixtures/hud-data.js';
import { bar, buttons, click, draw, press, selectedOf } from '../fixtures/b10b-s3.js';

const root: NodeSpec = { id: 'main', root: true, harness: 'claude', status: S.working(ago(300)), label: null };
const w = (extra: Partial<NodeSpec> = {}): NodeSpec => ({
  id: 'w',
  parent: 'main',
  harness: 'codex',
  label: 'w',
  role: 'worker',
  status: S.working(ago(100)),
  run: { state: 'running', mode: 'headless' },
  createdAt: ago(2000),
  ...extra,
});
const ended = (mode: 'headless' | 'visible', report: NodeSpec['report'], run: RunSpec = {}): NodeSpec =>
  w({
    status: S.exited(ago(30)),
    run: { state: 'ended', mode, endedAt: ago(30), ...run },
    report,
  });
const done = { status: 'completed' as const, summary: 'done', at: ago(30) };

/** A panel (wide enough for the words) with `spec` selected. */
function on(spec: NodeSpec | NodeSpec[], width = 80) {
  const specs = Array.isArray(spec) ? spec : [spec];
  const built = buildVm([root, ...specs]);
  const key = built.keys[specs.at(-1)!.id];
  return { ...built, key, frame: draw(built.vm, { selected: key, width, height: 24 }) };
}
const words = (frame: MonitorFrame) => bar(frame);

// ---------------------------------------------------------------------------
// Q1: Log

test('Log: a headless run in any state reads ⇢ Log; L and the button emit delegation-log; o does nothing', () => {
  const cases: Array<[string, NodeSpec]> = [
    ['running', w()],
    ['starting', w({ run: { state: 'starting', mode: 'headless' }, status: S.starting(ago(5)) })],
    ['cancelling', w({ run: { state: 'cancelling', mode: 'headless', cancelRequestedAt: ago(5) } })],
    [
      'uncertain',
      w({
        run: { state: 'uncertain', mode: 'headless', reconciliation: 'scope_unknown' },
        status: { cls: 'uncertain', reason: 'scope_unknown', since: ago(30) },
        reconcile: true,
      }),
    ],
    ['ended with a report', ended('headless', done)],
    ['ended without one', ended('headless', null)],
    ['failed', ended('headless', { status: 'failed', summary: 'x', at: ago(30) }, { state: 'failed' })],
  ];
  for (const [name, spec] of cases) {
    const { frame, key } = on(spec);
    assert.match(words(frame), /⇢ Log/, name);
    assert.deepEqual(press(frame, 'log').action, { type: 'delegation-log', key }, `${name}: L`);
    assert.equal(press(frame, 'open-session').action, undefined, `${name}: o is Open and Switch only`);
    const control = frame.controls.find((c) => c.kind === 'delegation-open')!;
    assert.equal(control.disabled, undefined, name);
    assert.deepEqual(click(frame, control.x, control.y).action, { type: 'delegation-log', key }, `${name}: the button`);
  }
});

test('Log: a visible run has none (its ⇢ is Open); the root, a native, a conflict row and ⊕N have none either', () => {
  const visible = on(w({ run: { state: 'running', mode: 'visible' }, pane: 'pane 4' }));
  assert.match(words(visible.frame), /⇢ Open/);
  assert.equal(press(visible.frame, 'log').action, undefined);

  const e = situationE();
  const e0 = draw(e.vm, { selected: e.keys['main'], height: 30 });
  assert.equal(press(e0, 'log').action, undefined, 'the root');
  const conflict = e0.delegation!.plan.rows.find((r) => r.pn?.node === null)!;
  const e1 = draw(e.vm, { selected: conflict.key, height: 30 });
  assert.equal(selectedOf(e1), conflict.key);
  assert.equal(press(e1, 'log').action, undefined, 'the synthetic ⚠ row');
  assert.equal(buttons(e1).length, 0, 'and it draws neither button');

  const native = on([
    w({ id: 'impl', run: { state: 'running', mode: 'headless' } }),
    {
      id: 'nat',
      parent: 'impl',
      native: true,
      harness: 'codex',
      label: 'nat',
      status: S.working(ago(30)),
    },
  ]);
  assert.equal(press(native.frame, 'log').action, undefined, 'a native');

  const away = buildVm([
    root,
    w({ id: 'live' }),
    { ...ended('headless', done, { endedAt: ago(400) }), id: 'old', createdAt: ago(3000) },
  ]);
  const aged = draw(away.vm, { height: 24 });
  const put = aged.delegation!.plan.rows.find((r) => r.kind === 'putAway')!;
  const onPut = draw(away.vm, { selected: put.key, width: 80, height: 24 });
  assert.equal(selectedOf(onPut), put.key);
  assert.equal(buttons(onPut).length, 0, '⊕N has neither button');
  for (const key of ['log', 'open-session', 'resume-reconcile']) assert.equal(press(onPut, key).action, undefined, key);
});

// ---------------------------------------------------------------------------
// Q4: Switch and Open

test('Switch: a Codex native in the root’s own native subtree switches, with today’s action', () => {
  const direct = on({
    id: 'nat',
    parent: 'main',
    native: true,
    harness: 'codex',
    label: 'nat',
    status: S.working(ago(30)),
  });
  assert.match(words(direct.frame), /⇢ Switch/);
  assert.deepEqual(press(direct.frame, 'open-session').action, { type: 'switch', id: 'nat-0001' });
  const control = direct.frame.controls.find((c) => c.kind === 'delegation-open')!;
  assert.deepEqual(click(direct.frame, control.x, control.y).action, { type: 'switch', id: 'nat-0001' });
  // A chain of native edges from the root counts too: exactly the agents the legacy tree lists.
  const nested = on([
    { id: 'nat', parent: 'main', native: true, harness: 'codex', label: 'nat', status: S.working(ago(30)) },
    { id: 'deep', parent: 'nat', native: true, harness: 'codex', label: 'deep', status: S.working(ago(20)) },
  ]);
  assert.deepEqual(press(nested.frame, 'open-session').action, { type: 'switch', id: 'deep-0001' });
});

test('Switch: no ⇢ for a native under a delegated session, a native of another harness, or the root', () => {
  const under = on([
    w({ id: 'impl', run: { state: 'running', mode: 'visible' }, pane: 'pane 4' }),
    { id: 'nat', parent: 'impl', native: true, harness: 'codex', label: 'nat', status: S.working(ago(30)) },
  ]);
  assert.equal(buttons(under.frame).length, 0);
  assert.equal(press(under.frame, 'open-session').action, undefined);
  const other = on({
    id: 'nat',
    parent: 'main',
    native: true,
    harness: 'pi',
    label: 'nat',
    status: S.working(ago(30)),
  });
  assert.equal(buttons(other.frame).length, 0);
  assert.equal(press(other.frame, 'open-session').action, undefined);
  const rootOnly = buildVm([root, w()]);
  const frame = draw(rootOnly.vm, { selected: rootOnly.keys['main'] });
  assert.equal(buttons(frame).length, 0);
  assert.equal(press(frame, 'open-session').action, undefined, 'o on the root: m and ⌂ are the root’s keys');
  assert.deepEqual(press(frame, 'main').action, { type: 'switch', id: makeNestedTree().rootId }, 'm is unchanged');
});

test('Open: a visible run with a verified host reads ⇢ Open and emits delegation-open with the row key', () => {
  const { frame, key } = on(w({ run: { state: 'running', mode: 'visible' }, pane: 'pane 4' }));
  assert.match(words(frame), /⇢ Open/);
  assert.deepEqual(press(frame, 'open-session').action, { type: 'delegation-open', key });
  const control = frame.controls.find((c) => c.kind === 'delegation-open')!;
  assert.equal(control.disabled, undefined);
  assert.deepEqual(click(frame, control.x, control.y).action, { type: 'delegation-open', key });
});

test('Open is greyed, and does nothing, for each way the gate fails', () => {
  const visible: RunSpec = { state: 'running', mode: 'visible' };
  const reasons: Array<[string, NodeSpec]> = [
    ['no host at all', w({ run: visible })],
    ['locator stale', w({ run: visible, pane: 'pane 4', hostCheck: 'stale' })],
    ['occupant does not match', w({ run: visible, pane: 'pane 4', hostCheck: 'mismatch' })],
    [
      'the state key is uncertain',
      w({
        run: { ...visible, state: 'uncertain', reconciliation: 'scope_unknown' },
        pane: 'pane 4',
        status: { cls: 'uncertain', reason: 'scope_unknown', since: ago(30) },
      }),
    ],
    [
      'supervisor lost',
      w({
        run: { ...visible, state: 'uncertain', reconciliation: 'supervisor_dead' },
        pane: 'pane 4',
        status: { cls: 'uncertain', reason: 'supervisor_dead', since: ago(30) },
      }),
    ],
    ['the run has ended', ended('visible', done)],
  ];
  for (const [name, spec] of reasons) {
    const { frame } = on(spec);
    assert.match(words(frame), /⇢ Open/, `${name}: the button is drawn`);
    const control = frame.controls.find((c) => c.kind === 'delegation-open')!;
    assert.equal(control.disabled, true, `${name}: greyed`);
    assert.equal(press(frame, 'open-session').action, undefined, `${name}: o`);
    assert.equal(click(frame, control.x, control.y).action, undefined, `${name}: the click`);
  }
});

test('a plain session (no managed run) has no ⇢', () => {
  const { frame } = on(w({ run: false }));
  assert.equal(buttons(frame).length, 0);
  assert.equal(press(frame, 'open-session').action, undefined);
});

// ---------------------------------------------------------------------------
// Q3: Reconcile and Resume

test('Reconcile: ↻ copies exactly the descriptor the view model holds, displayCommand included; o and L stay out of it', () => {
  const built = buildVm([
    root,
    w({
      run: { state: 'uncertain', mode: 'visible', reconciliation: 'supervisor_dead' },
      pane: 'pane 4',
      status: { cls: 'uncertain', reason: 'supervisor_dead', since: ago(30) },
      reconcile: true,
    }),
  ]);
  const key = built.keys['w'];
  const frame = draw(built.vm, { selected: key, width: 80 });
  assert.match(words(frame), /⇢ Open.*↻ Reconcile/);
  const descriptor = built.vm.details[key].reconcile!;
  const out = press(frame, 'resume-reconcile').action as { type: string; key: string; descriptor: unknown };
  assert.equal(out.type, 'delegation-copy');
  assert.equal(out.key, key);
  assert.strictEqual(out.descriptor, descriptor, 'the object as given, not a copy');
  assert.match(descriptor.displayCommand, /hud run reconcile/);
  const control = frame.controls.find((c) => c.kind === 'delegation-recover')!;
  assert.equal(control.disabled, undefined);
  assert.strictEqual((click(frame, control.x, control.y).action as { descriptor: unknown }).descriptor, descriptor);
  assert.equal(press(frame, 'open-session').action, undefined, 'o: Open is greyed here');
  assert.equal(press(frame, 'log').action, undefined);
  // The panel never makes a command of its own: the action holds the descriptor and nothing else.
  assert.deepEqual(Object.keys(out).sort(), ['descriptor', 'key', 'type']);
});

test('Resume: an ended run with a report of any status draws ↻ Resume greyed and answers with the diagnostic only', () => {
  for (const status of ['completed', 'failed', 'blocked', 'interrupted'] as const) {
    const { frame, key } = on(ended('headless', { status, summary: 'x', at: ago(30) }));
    assert.match(words(frame), /↻ Resume/, status);
    const out = press(frame, 'resume-reconcile').action;
    assert.deepEqual(out, { type: 'delegation-diagnostic', key, text: RESUME_DIAGNOSTIC }, status);
    const control = frame.controls.find((c) => c.kind === 'delegation-recover')!;
    assert.equal(control.disabled, undefined, 'greyed is a paint, not a dead control');
    assert.deepEqual(click(frame, control.x, control.y).action, out, `${status}: the click`);
    assert.ok(!JSON.stringify(out).includes('copy'));
  }
});

test('Resume: the diagnostic is the §5.5 sentence in English and in Chinese', () => {
  const { frame } = on(ended('headless', done));
  assert.equal(
    (press(frame, 'resume-reconcile').action as { text: string }).text,
    'resume not verified on this machine · ask the parent to delegate_resume'
  );
  const previous = setLanguage('zh');
  try {
    const zh = on(ended('headless', done));
    assert.equal(
      (press(zh.frame, 'resume-reconcile').action as { text: string }).text,
      '本机 resume 入口未验证 · 请原父调用 delegate_resume'
    );
    assert.match(words(zh.frame), /恢复/);
  } finally {
    setLanguage(previous);
  }
});

test('Resume is not drawn without an ended run with a report: no report, still alive, the root, a native', () => {
  const none = (spec: NodeSpec | NodeSpec[], name: string) => {
    const { frame } = on(spec);
    assert.ok(!/↻/.test(words(frame)), `${name}: ${words(frame)}`);
    assert.equal(press(frame, 'resume-reconcile').action, undefined, name);
  };
  none(ended('headless', null), 'ended without a report');
  none(
    w({ run: { state: 'running', mode: 'headless' }, report: done, status: S.working(ago(10)) }),
    'alive, reported (headless)'
  );
  none(
    w({ run: { state: 'running', mode: 'visible' }, pane: 'pane 4', report: done }),
    'alive, reported (visible, close pane)'
  );
  none(
    { id: 'nat', parent: 'main', native: true, harness: 'codex', label: 'nat', status: S.working(ago(30)) },
    'a native'
  );
});

test('Reconcile wins over Resume when the node has a descriptor', () => {
  const { frame } = on({ ...ended('headless', done), reconcile: true });
  assert.match(words(frame), /↻ Reconcile/);
  assert.ok(!/Resume/.test(words(frame)));
});

// ---------------------------------------------------------------------------
// The buttons on the bar

test('the bar: the word follows the selected row, the legacy Switch is gone, ZH has the table’s words', () => {
  const e = situationE();
  const frame = draw(e.vm, { selected: e.keys['impl-b'], width: 80, height: 30 });
  assert.ok(!/Switch/.test(bar(frame)));
  assert.match(bar(frame), /⇢ Log/);
  const previous = setLanguage('zh');
  try {
    const zh = draw(e.vm, { selected: e.keys['impl-b'], width: 80, height: 30 });
    assert.match(bar(zh), /⇢ 日志/);
    const open = on(w({ run: { state: 'running', mode: 'visible' }, pane: 'pane 4' }));
    assert.match(bar(open.frame), /⇢ 打开/);
    const sw = on({
      id: 'nat',
      parent: 'main',
      native: true,
      harness: 'codex',
      label: 'nat',
      status: S.working(ago(30)),
    });
    assert.match(bar(sw.frame), /⇢ 切换/);
    const rec = on({ ...ended('headless', done), reconcile: true });
    assert.match(bar(rec.frame), /↻ 对账/);
  } finally {
    setLanguage(previous);
  }
});

test('a greyed and a live button differ in paint, not only in a flag (and the control says which)', () => {
  const grey = on(w({ run: { state: 'running', mode: 'visible' } }));
  const live = on(w({ run: { state: 'running', mode: 'visible' }, pane: 'pane 4' }));
  const raw = (frame: MonitorFrame) => frame.lines[0];
  assert.notEqual(raw(grey.frame), raw(live.frame));
  assert.equal(grey.frame.controls.find((c) => c.kind === 'delegation-open')!.disabled, true);
  assert.equal(live.frame.controls.find((c) => c.kind === 'delegation-open')!.disabled, undefined);
});

test('rowActions reads what the frame showed: the descriptor is the very object, the key the row’s', () => {
  const built = buildVm([
    root,
    w({ reconcile: true, run: { state: 'uncertain', mode: 'headless', reconciliation: 'scope_unknown' } }),
  ]);
  const frame = draw(built.vm, { selected: built.keys['w'] });
  const view = frame.delegation!;
  const row = view.plan.rows[view.plan.index.get(built.keys['w'])!];
  const actions = rowActions(row, view.proj);
  assert.strictEqual(actions.descriptor, built.vm.details[built.keys['w']].reconcile);
  assert.equal(actions.key, built.keys['w']);
});

// ---------------------------------------------------------------------------
// Painting never acts

test('painting, a tick, or a row jumping into trouble produces no action: only a key or a click does', () => {
  const calm = buildVm([root, w({ run: { state: 'running', mode: 'visible' }, pane: 'pane 4' })]);
  let frame = draw(calm.vm, { selected: calm.keys['w'] });
  assert.ok(!('action' in frame));
  const troubled = buildVm([
    root,
    w({
      run: { state: 'uncertain', mode: 'visible', reconciliation: 'scope_unknown' },
      pane: 'pane 4',
      status: { cls: 'uncertain', reason: 'scope_unknown', since: ago(1) },
      reconcile: true,
    }),
  ]);
  for (let i = 0; i < 3; i++) frame = draw(i % 2 ? calm.vm : troubled.vm, { state: frame.state });
  assert.ok(!('action' in frame));
  assert.equal(buttons(frame).length > 0, true);
  // The buttons changed under the reader’s hands; the one press that follows acts on what the frame it was pressed on drew.
  assert.equal(
    press(frame, 'resume-reconcile').action?.type === 'delegation-copy',
    frame.delegation!.proj.vm === troubled.vm
  );
});
