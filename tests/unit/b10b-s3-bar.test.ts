/**
 * B10B-s3: the control bar of the delegation view (design §3.7; rulings B10B-s3 defaults 2-5): the buttons' place and
 * words at each width, every look and icon set, and the `older` button that reads the plan with history hidden, kept
 * beside the drawn plan so the second plan does not evict the first.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { visualLength } from '../../src/render/colors.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { setLanguage } from '../../src/render/i18n.js';
import { delegationPutAway, delegationView } from '../../src/render/delegation/panel.js';
import { planRows } from '../../src/render/delegation/rows.js';
import { NOW, S, ago, buildVm, situationC, type NodeSpec } from '../fixtures/b10b-delegation.js';
import { bar, buttons, click, draw, monitorInput, press, step, text } from '../fixtures/b10b-s3.js';
import { renderMonitor } from '../../src/render/monitor.js';

const root: NodeSpec = { id: 'main', root: true, harness: 'claude', status: S.working(ago(300)), label: null };
const live = (id: string, extra: Partial<NodeSpec> = {}): NodeSpec => ({
  id,
  parent: 'main',
  harness: 'codex',
  label: id,
  role: 'worker',
  status: S.working(ago(100)),
  run: { state: 'running', mode: 'headless' },
  createdAt: ago(2000),
  ...extra,
});
const old = (id: string, endedAgo = 400): NodeSpec =>
  live(id, {
    status: S.exited(ago(endedAgo)),
    run: { state: 'ended', mode: 'headless', endedAt: ago(endedAgo) },
    report: { status: 'completed', summary: 'done', at: ago(endedAgo) },
    createdAt: ago(3000),
  });

test('older reads the count with history hidden, as today’s button does, and stays (as Hide) while history is shown', () => {
  const { vm, keys } = buildVm([root, live('a'), old('d1'), old('d2'), old('d3', 500)]);
  const hidden = draw(vm, { selected: keys['a'], width: 80 });
  assert.match(bar(hidden), /⊕3/);
  assert.ok(
    text(hidden).some((line) => /3 put away/.test(line)),
    'the summary reads the drawn plan'
  );
  const shown = step(vm, hidden, 'show-all', { selected: keys['a'], width: 80 }).frame;
  assert.equal(shown.state.tree.showAll, true);
  assert.match(bar(shown), /⊖3/, 'the button stays, as Hide 3');
  assert.ok(
    !text(shown).some((line) => /put away/.test(line)),
    'the drawn plan puts nothing away: the summary says nothing'
  );
  assert.equal(delegationPutAway(vm, { nowMs: NOW, showHistory: true }), 3);
  assert.equal(delegationPutAway(vm, { nowMs: NOW, showHistory: false }), 3);
});

test('the second plan does not evict the drawn one from its memo (a no-change tick rebuilds nothing)', () => {
  const { vm } = buildVm([root, live('a'), old('d1'), old('d2')]);
  for (const showHistory of [false, true]) {
    const view = delegationView(vm, { nowMs: NOW, style: 'compact', showHistory });
    const drawn = view.plan;
    delegationPutAway(vm, { nowMs: NOW, showHistory });
    assert.strictEqual(planRows(view.proj, { nowMs: NOW, showHistory }), drawn, `showHistory ${showHistory}: kept`);
    assert.strictEqual(
      delegationView(vm, { nowMs: NOW + 1000, style: 'compact', showHistory }).plan,
      drawn,
      'and the next second reuses it'
    );
  }
});

test('the buttons are the selected row’s, where the legacy Switch was: focus on Agents, or the Inspector on the agent', () => {
  const c = situationC();
  const key = c.keys['impl-parser'];
  const agents = draw(c.vm, { selected: key, width: 80 });
  assert.match(bar(agents), /⇢ Open/);
  assert.ok(!/Switch/.test(bar(agents)));
  const inspector = monitorInput(c.vm, { selected: key, width: 80 });
  inspector.state.focus = 'details';
  inspector.state.modes.details = 'open';
  inspector.state.preview = 'agent';
  assert.match(renderMonitor(inspector).lines[0], /⇢ Open/, 'the Inspector on the agent');
  const changes = monitorInput(c.vm, { selected: key, width: 80 });
  changes.state.focus = 'changes';
  changes.state.modes.changes = 'open';
  assert.ok(!/⇢/.test(renderMonitor(changes).lines[0]), 'not with another pane focused');
  assert.equal(press(renderMonitor(changes), 'open-session').action, undefined, 'and then o does not act either');
});

test('the order on the bar: ⇢, ↻, the brief, the older button, help', () => {
  const { vm, keys } = buildVm([
    root,
    live('a', {
      run: { state: 'uncertain', mode: 'headless', reconciliation: 'scope_unknown' },
      reconcile: true,
      status: { cls: 'uncertain', reason: 'scope_unknown', since: ago(30) },
    }),
    old('d1'),
  ]);
  const input = monitorInput(vm, { selected: keys['a'], width: 100 });
  input.brief = { paused: false };
  const line = renderMonitor(input).lines[0].replace(/\x1b\[[0-9;]*m/g, '');
  const at = (re: RegExp) => line.search(re);
  assert.ok(at(/⇢ Log/) > 0 && at(/⇢ Log/) < at(/↻ Reconcile/), line);
  assert.ok(at(/↻ Reconcile/) < at(/ǁ/), line);
  assert.ok(at(/ǁ/) < at(/⊕1/), line);
  assert.ok(at(/⊕1/) < at(/\?\s*$/), line);
});

test('every width, look and icon set: exactly the width, the buttons present from 48 columns, words where there is room', () => {
  const c = situationC();
  const key = c.keys['impl-parser'];
  const looks = ['tab', 'band', 'tile', 'frame', 'pill'] as const;
  const icons = ['unicode', 'nerd', 'emoji', 'text'] as const;
  for (const look of looks)
    for (const iconSet of icons) {
      const previous = setDisplayConfig({ look, icons: iconSet });
      try {
        for (const width of [32, 40, 48, 56, 80]) {
          const frame = draw(c.vm, { selected: key, width, height: 20 });
          for (const line of frame.lines) assert.equal(visualLength(line), width, `${look}/${iconSet}/${width}`);
          const bars = frame.lines.slice(0, look === 'frame' ? 2 : 1).join('\n');
          if (width >= 48) assert.ok(buttons(frame).length === 1, `${look}/${iconSet}/${width}: ${bars}`);
          if (width >= 56 && look !== 'frame') assert.match(bars, /Open/, `${look}/${iconSet}/${width}`);
          for (const control of buttons(frame)) {
            assert.ok(
              control.x >= 0 && control.x + control.width <= width,
              `${look}/${iconSet}/${width}: span in the row`
            );
            assert.equal(
              click(frame, control.x, control.y).action?.type,
              'delegation-open',
              `${look}/${iconSet}/${width}`
            );
          }
        }
      } finally {
        setDisplayConfig(previous);
      }
    }
});

test('ZH at 48 columns: the words fit and the line is exactly the width', () => {
  const previous = setLanguage('zh');
  try {
    const c = situationC();
    const frame = draw(c.vm, { selected: c.keys['review-tests'], width: 48, height: 12 });
    for (const line of frame.lines) assert.equal(visualLength(line), 48);
    assert.match(bar(frame), /⇢ 日志/);
  } finally {
    setLanguage(previous);
  }
});
