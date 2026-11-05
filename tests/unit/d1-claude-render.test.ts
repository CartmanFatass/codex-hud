/** Synthetic committed display receipts on the real agents rendering route; no live harness required. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DelegationViewModel } from '../../src/core/link/view-model.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { glyphSet } from '../../src/render/delegation/glyphs.js';
import { focusLine, focusText } from '../../src/render/delegation/lines.js';
import { delegationAgentsRows, delegationView } from '../../src/render/delegation/panel.js';
import { ProjectionCache, projectDelegation } from '../../src/render/delegation/projection.js';
import { PLAIN_INK } from '../../src/render/delegation/rows.js';
import { plainSay } from '../../src/render/delegation/style.js';
import { setLanguage } from '../../src/render/i18n.js';
import { inspectorRows } from '../../src/render/monitor-inspector.js';
import { NOW, ago, buildVm, S, type NodeSpec } from '../fixtures/b10b-delegation.js';
import { draw, monitorInput } from '../fixtures/b10b-s3.js';

function fixture(spec: Partial<NodeSpec> = {}) {
  const built = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.idle(), label: null },
    { id: 'worker', parent: 'main', harness: 'claude', native: true, label: 'worker', status: S.idle(), ...spec },
  ]);
  built.vm.tree.ledger.state = 'available';
  const key = built.keys.worker;
  const detail = built.vm.details[key];
  detail.action = {
    id: 'tool-background-1',
    name: 'Bash (background)',
    target: 'task bg-1',
    startedAt: ago(30),
    source: 'claude.background.last_confirmed',
    asOf: ago(25),
  };
  detail.progress = {
    value: { done: 1, total: 3, current: '检查中文任务' },
    quality: 'reported',
    source: 'claude.TodoWrite.last_confirmed',
    asOf: ago(20),
  };
  return { ...built, key, detail, node: built.vm.tree.nodes.find((node) => node.key === key)! };
}

function focus(vm: DelegationViewModel, key: string, cache = new ProjectionCache()): string | null {
  const pn = projectDelegation(vm, cache).byKey.get(key)!;
  const line = focusLine(pn, NOW, glyphSet(false), plainSay);
  return line ? focusText(line, 160, 160, glyphSet(false), PLAIN_INK) : null;
}

function inspect(vm: DelegationViewModel, key: string, width = 160) {
  const input = monitorInput(vm, { selected: key, width, height: 60 });
  input.state.preview = 'agent';
  const view = delegationView(vm, { nowMs: NOW, style: 'compact', showHistory: true });
  return inspectorRows(input, input.state, width, NOW, view).map((row) => stripAnsi(row.text));
}

test('committed Claude action reaches compact selected micro-card and rich card without claiming liveness', () => {
  const f = fixture();
  const before = projectDelegation(f.vm, new ProjectionCache()).byKey.get(f.key)!.proj.marker;
  assert.equal(focus(f.vm, f.key), 'Last confirmed: Bash (background) · task bg-1');
  for (const style of ['compact', 'rich'] as const) {
    const rows = delegationAgentsRows(f.vm, { nowMs: NOW, selectedId: f.key, width: 120, style });
    assert.match(rows.map((row) => stripAnsi(row.text)).join('\n'), /Last confirmed: Bash \(background\) · task bg-1/);
    assert.ok(rows.every((row) => visualLength(row.text) === 120));
    const frame = draw(f.vm, { selected: f.key, style, width: 120, height: 60 });
    assert.match(frame.lines.map(stripAnsi).join('\n'), /Last confirmed: Bash \(background\) · task bg-1/);
  }
  const cleared = structuredClone(f.vm);
  delete cleared.details[f.key].action;
  assert.deepEqual(projectDelegation(cleared, new ProjectionCache()).byKey.get(f.key)!.proj.marker, before);
  assert.equal(focus(cleared, f.key), null);
});

test('committed Todo Inspector preserves confirmation timestamp/source and separates tasks from summaries', () => {
  const f = fixture();
  const text = inspect(f.vm, f.key).join('\n');
  assert.match(text, /Action: last confirmed Bash \(background\) · task bg-1/);
  assert.ok(text.includes(`Last confirmed: ${new Date(ago(25)).toISOString()}`));
  assert.ok(text.includes(`Tasks: 1/3 · last confirmed ${new Date(ago(20)).toISOString()}`));
  assert.match(text, /Current task: 检查中文任务/);
  assert.match(text, /Source: claude\.background\.last_confirmed/);
  assert.match(text, /Source: claude\.TodoWrite\.last_confirmed/);
  assert.doesNotMatch(text, /Progress:/);
});

test('empty confirmed Todo is 0/0 and says no tasks, while missing/unknown Todo draws no Tasks line', () => {
  const f = fixture();
  f.detail.progress!.value = { done: 0, total: 0 };
  let text = inspect(f.vm, f.key).join('\n');
  assert.match(text, /Tasks: 0\/0/);
  assert.match(text, /No tasks in the last confirmed list/);
  assert.doesNotMatch(text, /all complete|Current task:/i);
  delete f.detail.progress;
  assert.doesNotMatch(inspect(structuredClone(f.vm), f.key).join('\n'), /Tasks:|Current task:/);
  f.detail.progress = { value: null, quality: 'unknown', source: 'claude.TodoWrite.last_confirmed', asOf: ago(20) };
  assert.doesNotMatch(inspect(structuredClone(f.vm), f.key).join('\n'), /Tasks:|Current task:/);
});

test('last-confirmed action remains lower priority than stop-in-pane, conflict, pending, fault, report and terminal', () => {
  const specs: Partial<NodeSpec>[] = [
    { native: false, run: { state: 'cancelling', mode: 'visible' }, status: S.working() },
    { conflict: { count: 2, since: ago(5) } },
    { status: S.pending('approval', ago(5)) },
    { status: S.stale(ago(60), ago(60)) },
    { status: S.failed(ago(5)) },
    { native: false, report: { status: 'completed', summary: 'Reviewed the results', at: ago(5) } },
    { native: false, run: { state: 'ended', endedAt: ago(5) }, status: S.exited(ago(5)) },
  ];
  for (const spec of specs) {
    const f = fixture(spec);
    const withAction = focus(f.vm, f.key);
    const cleared = structuredClone(f.vm);
    delete cleared.details[f.key].action;
    assert.equal(withAction, focus(cleared, f.key), JSON.stringify(spec));
    assert.ok(withAction, `existing priority has content: ${JSON.stringify(spec)}`);
    assert.doesNotMatch(withAction, /Last confirmed|task bg-1/);
  }
});

test('unavailable observation and ledger suppress display additions, including warm cache with retained nodes', () => {
  for (const unavailable of ['ledger', 'unloaded', 'observation', 'reason'] as const) {
    const f = fixture();
    const cache = new ProjectionCache();
    assert.match(focus(f.vm, f.key, cache)!, /Last confirmed/);
    const next =
      unavailable === 'ledger'
        ? { ...f.vm, tree: { ...f.vm.tree, ledger: { ...f.vm.tree.ledger } } }
        : structuredClone(f.vm);
    const node = next.tree.nodes.find((node) => node.key === f.key)!;
    if (unavailable === 'ledger') next.tree.ledger.state = 'degraded';
    if (unavailable === 'unloaded') node.loaded = false;
    if (unavailable === 'observation') node.observation = null;
    if (unavailable === 'reason') next.details[f.key].observationUnavailableReason = 'not loaded';
    assert.doesNotMatch(focus(next, f.key, cache) ?? '', /Last confirmed|task bg-1/, unavailable);
    const text = inspect(next, f.key).join('\n');
    assert.match(text, /Action: unavailable/);
    assert.doesNotMatch(text, /Tasks:|Current task:|Source: claude/);
    assert.deepEqual(
      projectDelegation(next, cache).byKey.get(f.key)!.proj,
      projectDelegation(next, new ProjectionCache()).byKey.get(f.key)!.proj
    );
    assert.match(focus(f.vm, f.key, cache)!, /Last confirmed/, 'authority restoration projects again');
  }
});

test('future/invalid timestamps and malformed counts do not become confirmed display claims', () => {
  for (const at of [NOW + 1, Number.NaN, -1]) {
    const f = fixture();
    f.detail.action!.asOf = at;
    f.detail.progress!.asOf = at;
    assert.equal(focus(f.vm, f.key), null);
    assert.doesNotMatch(inspect(f.vm, f.key).join('\n'), /Tasks:|Action: last confirmed/);
  }
  for (const value of [
    { done: -1, total: 3 },
    { done: 4, total: 3 },
    { done: 0.5, total: 3 },
    { done: 0, total: 2001 },
  ]) {
    const f = fixture();
    f.detail.progress!.value = value;
    assert.doesNotMatch(inspect(f.vm, f.key).join('\n'), /Tasks:/);
  }
});

test('CJK and external controls are safe at narrow widths and last-confirmed labels translate', () => {
  for (const lang of ['en', 'zh'] as const) {
    const previous = setLanguage(lang);
    try {
      const f = fixture();
      f.detail.action!.target = 'task 中文\n下一行\x1b[31m\u202e';
      f.detail.progress!.value = { done: 1, total: 3, current: '检查\n中文\x1b[31m\u202e' };
      const projected = focus(f.vm, f.key)!;
      assert.ok(projected.includes('task 中文 下一行\\x1b[31m\\u202e'));
      assert.doesNotMatch(projected, /[\x00-\x1f\u202e]/);
      for (const width of [32, 40, 56, 80, 120]) {
        for (const style of ['compact', 'rich'] as const) {
          const rows = delegationAgentsRows(f.vm, { nowMs: NOW, selectedId: f.key, width, style });
          assert.ok(
            rows.every((row) => visualLength(row.text) === width),
            `${lang} ${style} ${width}`
          );
          assert.ok(rows.every((row) => !/[\x00-\x1f\u202e]/.test(stripAnsi(row.text))));
        }
        assert.ok(inspect(f.vm, f.key, width).every((line) => visualLength(line) <= width));
      }
      const inspector = inspect(f.vm, f.key).join('\n');
      assert.match(inspector, lang === 'zh' ? /任务：1\/3 · 最近确认/ : /Tasks: 1\/3 · last confirmed/);
      assert.ok(inspector.includes('检查 中文\\x1b[31m\\u202e'));
      if (lang === 'zh') {
        const rows = delegationAgentsRows(f.vm, { nowMs: NOW, selectedId: f.key, width: 120, style: 'compact' });
        assert.match(rows.map((row) => stripAnsi(row.text)).join('\n'), /最近确认：Bash \(background\)/);
      }
    } finally {
      setLanguage(previous);
    }
  }
});

test('observed-time confirmation works without a native event asOf and zero remains a valid confirmation time', () => {
  const f = fixture();
  f.detail.status!.asOf = null;
  f.detail.action!.startedAt = 0;
  f.detail.action!.asOf = 0;
  f.detail.progress = {
    value: { done: 0, total: 1, current: 'Synthetic task' },
    quality: 'reported',
    source: 'claude.TodoWrite.last_confirmed.observed-time',
    asOf: 0,
  };
  assert.match(focus(f.vm, f.key)!, /Last confirmed/);
  const text = inspect(f.vm, f.key).join('\n');
  assert.match(text, /Tasks: 0\/1 · last confirmed 1970-01-01T00:00:00.000Z/);
  assert.match(text, /Source: claude\.TodoWrite\.last_confirmed\.observed-time/);
});

test('generic Claude unknown keeps its marker and appends only the last-confirmed background fact', () => {
  // The real collector can report idle/end_turn while liveness and freshness remain unknown.
  // Do not repair this fixture by inventing an alive process.
  for (const root of [false, true]) {
    const f = fixture({
      root,
      parent: root ? null : 'main',
      native: !root,
      status: { cls: 'unknown', liveness: 'unknown', freshness: 'unknown', outcome: 'completed', since: ago(5) },
    });
    f.detail.status!.activity = 'idle';
    const original = projectDelegation(f.vm, new ProjectionCache()).byKey.get(f.key)!.proj.marker;
    assert.equal(focus(f.vm, f.key), '? unknown · Last confirmed: Bash (background) · task bg-1');
    for (const style of ['compact', 'rich'] as const) {
      const rows = delegationAgentsRows(f.vm, { nowMs: NOW, selectedId: f.key, width: 120, style, showHistory: true });
      assert.match(
        rows.map((row) => stripAnsi(row.text)).join('\n'),
        /\? unknown · Last confirmed: Bash \(background\) · task bg-1/
      );
      assert.ok(rows.every((row) => visualLength(row.text) === 120));
    }
    const cleared = structuredClone(f.vm);
    delete cleared.details[f.key].action;
    assert.equal(focus(cleared, f.key), '? unknown');
    assert.deepEqual(projectDelegation(cleared, new ProjectionCache()).byKey.get(f.key)!.proj.marker, original);
  }
});

test('generic unknown cannot append confirmation over reconciliation, missing evidence, reports or terminal facts', () => {
  const variants: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      f.node.execution.reconciliation = { cause: 'scope_unknown', missing: [] };
    },
    (f) => {
      f.node.execution.reconciliation = {
        cause: 'supervisor_dead',
        missing: ['exit_receipt'],
      };
    },
    (f) => {
      f.node.execution.isRunTerminal = true;
    },
    (f) => {
      f.detail.latestReportForRun = {
        reportId: 'r',
        runId: 'run',
        linkId: 'link',
        childBindingId: 'binding',
        callerId: 'caller',
        callerContextId: 'context',
        contextGeneration: 1,
        status: 'completed',
        summary: 'Synthetic report',
        path: null,
        createdAt: ago(5),
      };
    },
    (f) => {
      delete f.detail.action!.source;
    },
  ];
  for (const variant of variants) {
    const f = fixture({ status: S.unknown() });
    variant(f);
    const withAction = focus(f.vm, f.key);
    const cleared = structuredClone(f.vm);
    delete cleared.details[f.key].action;
    assert.equal(withAction, focus(cleared, f.key));
    assert.doesNotMatch(withAction ?? '', /Last confirmed|task bg-1/);
  }
});
