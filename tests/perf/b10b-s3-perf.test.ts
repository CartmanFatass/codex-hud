/**
 * B10B-s3 performance (design §6 #6, #11, #16; contract 06 P-06-7 as amended; acceptance #4): segment 2's gated ticks
 * with the selection added to each: 200 nodes at 56 columns, the selection reconcile (`reconcileMonitor` against the
 * view model), a key press (↓ and ↑ alternating, so the selection and its two rows really change), the agents view's
 * rows, the text of the rows painted, the frame-diff.
 *
 *  - compact, a production-shaped changed tick (a fresh view model object every tick, as `structuredClone` makes it,
 *    exactly one node of 200 differs, the clocks move), every row read: p99 <= 10 ms;
 *  - rich, the same tree as cards (500-card cache, accordion to a 60-row pane): p99 <= 15 ms;
 *  - the no-change tick (same view model, the second moves on), the 60 rows in view: p99 <= 2 ms, compact and rich.
 *
 * Printed, not asserted: the same ticks through the whole `renderMonitor` (the control bar, the pane layout and the
 * frame on top of the rows), the selection resolved from a miss (the selected node hidden each tick, so the ancestor
 * walk runs), and the cold tick.
 *
 * n = 1000 samples after 200 warm-up, nearest-rank percentiles. Strict bounds when `B10B_PERF=1`; otherwise five
 * times wider so a loaded host does not flake. Numbers are printed either way:
 *
 *   B10B_PERF=1 node --test dist-test/tests/perf/b10b-s3-perf.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { DelegationViewModel } from '../../src/core/link/view-model.js';
import { frameDiff } from '../../src/render/frame-diff.js';
import {
  handleMonitorInput,
  initialMonitorState,
  reconcileMonitor,
  renderMonitor,
  type MonitorFrame,
  type MonitorState,
} from '../../src/render/monitor.js';
import { delegationAgentsRows, delegationView } from '../../src/render/delegation/panel.js';
import { plainSay } from '../../src/render/delegation/style.js';
import { makeHudData, makeNestedTree } from '../fixtures/hud-data.js';
import { NOW, S, ago, bigTree, type Built } from '../fixtures/b10b-big.js';

const STRICT = process.env.B10B_PERF === '1';
const SAMPLES = 1000;
const WARMUP = 200;
const bound = (ms: number): number => (STRICT ? ms : ms * 5);
const WIDTH = 56;
const HEIGHT = 60;
const TREE = makeNestedTree();
const HUD = makeHudData();

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
interface Stats {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}
function measure(fn: (i: number) => void, prepare?: (i: number) => void): Stats {
  for (let i = 0; i < WARMUP; i++) {
    prepare?.(i);
    fn(i);
  }
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    prepare?.(WARMUP + i);
    const start = process.hrtime.bigint();
    fn(WARMUP + i);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return {
    n: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    max: samples[samples.length - 1],
  };
}
const report = (label: string, s: Stats): void => {
  console.log(
    `b10b-s3-perf ${label}: n=${s.n} p50=${s.p50.toFixed(3)}ms p95=${s.p95.toFixed(3)}ms p99=${s.p99.toFixed(3)}ms max=${s.max.toFixed(3)}ms strict=${STRICT}`
  );
};

/** A clock a second further each tick, wrapping within 40 s so nothing crosses the put-away window. */
const tickNow = (i: number): number => NOW + (i % 40) * 1000;

/**
 * One panel tick as the page runs it: a key press on the frame the user saw, then the render of the next view model.
 * `visible` is how many agents rows are read (all, or the pane’s own); then the frame-diff against the last paint.
 */
function panel(style: 'rich' | 'compact', visible = Infinity) {
  let frame: MonitorFrame | null = null;
  let last: string[] | null = null;
  let state: MonitorState = initialMonitorState();
  state.style = style;
  return (built: Built, nowMs: number, i: number, key?: string): MonitorFrame => {
    if (frame) {
      const out = handleMonitorInput(
        frame.state,
        { type: 'key', key: key ?? (i % 2 ? 'up' : 'down') },
        { tree: TREE, frame, nowMs }
      );
      state = out.state;
    }
    frame = renderMonitor({
      tree: TREE,
      state,
      width: WIDTH,
      height: HEIGHT,
      nowMs,
      hud: { ...HUD, delegation: built.vm },
    });
    const rows = frame.panes.find((p) => p.id === 'agents')!.rows;
    for (let r = 0; r < Math.min(rows.length, visible); r++) rows[r].text;
    frameDiff(last, frame.lines);
    last = frame.lines;
    state = frame.state;
    return frame;
  };
}

/**
 * Segment 2's painter with the selection in it: the reconcile against the view model, a key press on the frame the
 * user saw (only the part of it a key reads: the view), then the agents view's rows, the text of `visible` of them, and
 * the frame-diff. This is what the gates are about.
 */
function rowsPanel(style: 'rich' | 'compact', visible = Infinity) {
  let last: string[] | null = null;
  let state: MonitorState = initialMonitorState();
  state.style = style;
  return (built: Built, nowMs: number, i: number): string[] => {
    const options = { nowMs, style, collapsed: state.tree.collapsed };
    const seen = {
      lines: [],
      panes: [],
      controls: [],
      state,
      delegation: delegationView(built.vm, options),
    } as MonitorFrame;
    state = handleMonitorInput(
      state,
      { type: 'key', key: i % 2 ? 'up' : 'down' },
      { tree: TREE, frame: seen, nowMs }
    ).state;
    state = reconcileMonitor(state, TREE, undefined, undefined, nowMs, built.vm);
    const rows = delegationAgentsRows(built.vm, {
      ...options,
      width: WIDTH,
      selectedId: state.tree.selectedId,
      viewport: style === 'rich' ? 60 : undefined,
      say: plainSay,
    });
    const lines = rows.slice(0, Math.min(rows.length, visible)).map((row) => row.text);
    frameDiff(last, lines);
    last = lines;
    return lines;
  };
}

/** A changed tick as production delivers it: a fresh copy of one of two trees that differ in exactly one node. */
function changedTicks(paint: (built: Built, nowMs: number, i: number) => unknown): Stats {
  const pair = [bigTree(), bigTree(0, { id: 'n004', status: S.failed(ago(2)) })];
  let fresh: Built = pair[0];
  return measure(
    (i) => paint(fresh, tickNow(i), i),
    (i) => {
      const source = pair[i % 2];
      fresh = { keys: source.keys, vm: structuredClone(source.vm) as DelegationViewModel };
    }
  );
}

test('the no-change tick: same view model, a key press, the second moves on; compact and rich p99 <= 2 ms', () => {
  const tree = bigTree();
  for (const style of ['compact', 'rich'] as const) {
    const paint = rowsPanel(style, 60);
    for (let i = 0; i < 40; i++) paint(tree, tickNow(i), i);
    const stats = measure((i) => paint(tree, tickNow(i), i));
    report(`${style} no-change tick (reconcile + key press + rows + the 60 rows in view)`, stats);
    const every = rowsPanel(style);
    for (let i = 0; i < 40; i++) every(tree, tickNow(i), i);
    report(
      `${style} no-change tick, every row read (not asserted)`,
      measure((i) => every(tree, tickNow(i), i))
    );
    const whole = panel(style, 60);
    for (let i = 0; i < 40; i++) whole(tree, tickNow(i), i);
    report(
      `${style} no-change tick through the whole renderMonitor (not asserted)`,
      measure((i) => whole(tree, tickNow(i), i))
    );
    assert.ok(stats.p99 <= bound(2), `${style} p99 ${stats.p99.toFixed(3)} ms`);
  }
});

test('compact, 200 nodes at 56 columns: reconcile + key press + every row + frame-diff, a changed tick, p99 <= 10 ms', () => {
  const changed = changedTicks(rowsPanel('compact'));
  report(
    'compact changed tick (fresh view model, 1 of 200 differs, clocks moved, a key pressed; every row read)',
    changed
  );
  report('compact changed tick, the 60 rows in view (not asserted)', changedTicks(rowsPanel('compact', 60)));
  report('compact changed tick through the whole renderMonitor (not asserted)', changedTicks(panel('compact')));
  assert.ok(changed.p99 <= bound(10), `changed p99 ${changed.p99.toFixed(3)} ms`);
});

test('rich, 200 nodes as cards at 56 columns: reconcile + key press + every row + frame-diff, a changed tick, p99 <= 15 ms', () => {
  const changed = changedTicks(rowsPanel('rich'));
  report(
    'rich changed tick (fresh view model, 1 of 200 differs, clocks moved, a key pressed; every row read)',
    changed
  );
  report('rich changed tick, the 60 rows in view (not asserted)', changedTicks(rowsPanel('rich', 60)));
  report('rich changed tick through the whole renderMonitor (not asserted)', changedTicks(panel('rich')));
  assert.ok(changed.p99 <= bound(15), `changed p99 ${changed.p99.toFixed(3)} ms`);
});

test('printed: the selection resolved from a miss (a hidden node every tick), and the cold tick', () => {
  for (const style of ['compact', 'rich'] as const) {
    // The selected node is hidden under a collapsed ancestor: every tick walks up to the nearest destination.
    const tree = bigTree();
    const paint = panel(style, 60);
    for (let i = 0; i < 40; i++) paint(tree, tickNow(i), i);
    const hidden = Object.values(tree.keys).filter((key) => key !== tree.keys['main']);
    let frame = paint(tree, NOW, 0);
    const start = frame.state;
    let n = 0;
    const missing = measure(() => {
      const state: MonitorState = { ...start, tree: { ...start.tree, selectedId: hidden[n++ % hidden.length] } };
      frame = renderMonitor({
        tree: TREE,
        state,
        width: WIDTH,
        height: HEIGHT,
        nowMs: NOW,
        hud: { ...HUD, delegation: tree.vm },
      });
    });
    report(`${style} reconcile + render from a selection that is not a destination (not asserted)`, missing);
    const pair = [bigTree(1), bigTree(2)];
    let fresh: Built = pair[0];
    const cold = measure(
      (i) => paint(fresh, NOW + 3600_000, i),
      (i) => {
        const source = pair[i % 2];
        fresh = { keys: source.keys, vm: structuredClone(source.vm) as DelegationViewModel };
      }
    );
    report(`${style} cold tick, the 60 rows in view (all 200 nodes differ; not asserted)`, cold);
  }
});
