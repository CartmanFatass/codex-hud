/**
 * B10B-s2 performance (design §6 #6, #11, #16; contract 06 P-06-7 as amended): the panel's delegation view.
 *
 *  - compact, 200 nodes at 56 columns, every row's text read + frame-diff, a changed tick shaped as production
 *    delivers it (a fresh view model object every tick, as `structuredClone` makes it: new tree and node objects,
 *    exactly one node of 200 differs from the tick before, the clocks move): p99 <= 10 ms;
 *  - rich, the same tree as cards (500-card cache, accordion to a 60-row pane), the same changed tick:
 *    p99 <= 15 ms;
 *  - the no-change tick (same view model, the second moves on), compact and rich, the 60 rows in view (§6 #5):
 *    p99 <= 2 ms.
 *
 * Also printed, not asserted: the same two view model objects alternated (both memoised, so this is a no-change
 * tick with one cached row swapped, not a changed tick), the cold tick (every node differs: projection, plan, every row and card built from
 * nothing) with every row read and with the 60 rows in view, and the no-change tick with every row read.
 *
 * n = 1000 samples after 200 warm-up, nearest-rank percentiles. Strict bounds when `B10B_PERF=1`; otherwise five
 * times wider so a loaded host does not flake. Numbers are printed either way:
 *
 *   B10B_PERF=1 node --test dist-test/tests/perf/b10b-s2-perf.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { visualLength } from '../../src/render/colors.js';
import { frameDiff } from '../../src/render/frame-diff.js';
import { CARD_CACHE_LIMIT, cardCacheStats } from '../../src/render/delegation/cards.js';
import { delegationAgentsRows } from '../../src/render/delegation/panel.js';
import { plainSay } from '../../src/render/delegation/style.js';
import { NOW, S, ago, buildVm, type Built, type NodeSpec, type StatusSpec } from '../fixtures/b10b-delegation.js';

const STRICT = process.env.B10B_PERF === '1';
const SAMPLES = 1000;
const WARMUP = 200;
const bound = (ms: number): number => (STRICT ? ms : ms * 5);
const WIDTH = 56;

/** A deterministic 200-node tree (the segment 1 bench's shape), every time shifted by `shift` seconds. */
function bigTree(shift = 0, tweak?: { id: string; status: StatusSpec }): Built {
  const t = (s: number) => ago(s + shift);
  const specs: NodeSpec[] = [
    {
      id: 'main',
      root: true,
      harness: 'claude',
      status: S.working(t(300)),
      label: null,
      model: 'fable-5.1',
      effort: 'high',
      contextPercent: 41,
    },
  ];
  const harnesses = ['codex', 'pi', 'codex', 'claude'] as const;
  const ids: string[] = ['main'];
  for (let i = 1; i < 200; i++) {
    const id = `n${String(i).padStart(3, '0')}`;
    const parent = i % 6 === 0 && ids.length > 6 ? ids[1 + ((i * 7) % (ids.length - 1))] : 'main';
    const kind = i % 17;
    const native = i % 9 === 0 && parent !== 'main';
    const status: StatusSpec =
      tweak && tweak.id === id
        ? tweak.status
        : kind === 3
          ? S.pending('approval', t(5 + i))
          : kind === 8
            ? S.stale(t(40 + i), t(40 + i))
            : kind === 11
              ? S.failed(t(30 + (i % 100)))
              : kind >= 13
                ? S.exited(t(20 + (i % 100)))
                : S.working(t(100 + i));
    const finished = kind >= 13 || kind === 11;
    specs.push({
      id,
      parent,
      harness: harnesses[i % harnesses.length],
      label: native ? null : `worker-${id}`,
      role: 'implementer',
      native,
      ...(native ? { nativeMeta: { title: `native-${id}`, kind: i % 2 ? 'review' : 'research' } } : {}),
      status,
      run: native
        ? false
        : finished
          ? {
              state: kind === 11 ? 'failed' : 'ended',
              mode: i % 3 ? 'headless' : 'visible',
              endedAt: t(20 + (i % 100)),
            }
          : { state: 'running', mode: i % 3 ? 'headless' : 'visible' },
      report:
        finished && !native
          ? {
              status: kind === 11 ? 'failed' : 'completed',
              summary: `Finished ${id} with a short synthetic summary.`,
              at: t(20 + (i % 100)),
            }
          : null,
      model: 'gpt-6.1-sol',
      effort: i % 2 ? 'high' : 'xhigh',
      contextPercent: (i * 7) % 100,
      costUsd: i % 5 === 0 ? null : 0.01 * i,
      createdAt: t(3000 - i),
      pane: i % 3 === 0 ? `pane ${i % 9}` : undefined,
    });
    ids.push(id);
  }
  return buildVm(specs, { capacity: { active: 6, limit: 6, mine: 4, mineLimit: 4 } });
}

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
    `b10b-s2-perf ${label}: n=${s.n} p50=${s.p50.toFixed(3)}ms p95=${s.p95.toFixed(3)}ms p99=${s.p99.toFixed(3)}ms max=${s.max.toFixed(3)}ms strict=${STRICT}`
  );
};

/** The rows a 60-row agents pane reads at the top of its scroll (§6 #5: rows out of view cost no string). */
const PANE_ROWS = 60;

/**
 * One panel tick: the agents view's rows, the text of the rows painted (all of them, or the pane's `visible`
 * first rows as `drawAgentsView` reads them), then the frame-diff against the last painted lines.
 */
function painter(style: 'rich' | 'compact', visible = Infinity) {
  let last: string[] | null = null;
  return (built: Built, nowMs: number): string[] => {
    const rows = delegationAgentsRows(built.vm, {
      width: WIDTH,
      nowMs,
      style,
      selectedId: built.keys.n004,
      viewport: style === 'rich' ? PANE_ROWS : undefined,
      say: plainSay,
    });
    const lines = rows.slice(0, Math.min(rows.length, visible)).map((row) => row.text);
    frameDiff(last, lines);
    last = lines;
    return lines;
  };
}

/**
 * A changed tick as production delivers it: every sample a fresh copy of the view model (new tree and node objects,
 * nothing memoised on object identity), alternating two trees that differ in exactly one node, the clock moving.
 */
function changedTicks(paint: (built: Built, nowMs: number) => string[]): Stats {
  const pair = [bigTree(), bigTree(0, { id: 'n004', status: S.failed(ago(2)) })];
  let fresh: Built = pair[0];
  return measure(
    (i) => paint(fresh, tickNow(i)),
    (i) => {
      const source = pair[i % 2];
      fresh = { keys: source.keys, vm: structuredClone(source.vm) };
    }
  );
}

/** A clock a second further each tick, wrapping within 40 s so nothing crosses the fold window. */
const tickNow = (i: number): number => NOW + (i % 40) * 1000;

test('the no-change tick: the same view model, the second moves on; compact and rich p99 <= 2 ms', () => {
  const tree = bigTree();
  for (const style of ['compact', 'rich'] as const) {
    // What a pane paints: the rows in view (60). Asserted.
    const paint = painter(style, PANE_ROWS);
    for (let i = 0; i < 40; i++) paint(tree, tickNow(i));
    const stats = measure((i) => paint(tree, tickNow(i)));
    report(`${style} no-change tick (same view model, clocks moved; the ${PANE_ROWS} rows in view)`, stats);
    // Every row's text read, for comparison only (a pane never reads rows out of view).
    const every = painter(style);
    for (let i = 0; i < 40; i++) every(tree, tickNow(i));
    report(
      `${style} no-change tick, every row read (not asserted)`,
      measure((i) => every(tree, tickNow(i)))
    );
    assert.ok(stats.p99 <= bound(2), `${style} p99 ${stats.p99.toFixed(3)} ms`);
  }
});

test('compact, 200 nodes at 56 columns, every row + frame-diff: a production-shaped changed tick, p99 <= 10 ms', () => {
  const a = bigTree();
  const b = bigTree(0, { id: 'n004', status: S.failed(ago(2)) });
  const paint = painter('compact');
  const lines = paint(a, NOW);
  assert.ok(lines.length >= 150, `rows: ${lines.length}`);
  for (const line of lines) assert.equal(visualLength(line), WIDTH);
  const swapped = measure((i) => paint(i % 2 ? a : b, tickNow(i)));
  report('compact no-change + one cached row (two memoised view models alternated; not asserted)', swapped);
  const changed = changedTicks(painter('compact'));
  report('compact changed tick (fresh view model, 1 of 200 differs, clocks moved; every row + frame-diff)', changed);
  const changedView = changedTicks(painter('compact', PANE_ROWS));
  report(`compact changed tick, the ${PANE_ROWS} rows in view (not asserted)`, changedView);
  // Cold: every sample is a fresh copy of the other of two trees whose every node differs (each time is shifted),
  // so the projection, the plan, every row and every card are built again.
  const pair = [bigTree(1), bigTree(2)];
  let fresh: Built = pair[0];
  const cold = measure(
    () => paint(fresh, NOW + 1000 * 3600),
    (i) => {
      const source = pair[i % 2];
      fresh = { keys: source.keys, vm: structuredClone(source.vm) };
    }
  );
  report(
    'compact cold tick, every row read (all 200 nodes differ; project + plan + rows + frame-diff; not asserted)',
    cold
  );
  const view = painter('compact', PANE_ROWS);
  const coldView = measure(
    () => view(fresh, NOW + 1000 * 3600),
    (i) => {
      const source = pair[i % 2];
      fresh = { keys: source.keys, vm: structuredClone(source.vm) };
    }
  );
  report(`compact cold tick, the ${PANE_ROWS} rows in view (not asserted)`, coldView);
  assert.ok(changed.p99 <= bound(10), `changed p99 ${changed.p99.toFixed(3)} ms`);
});

test('rich, 200 nodes as cards at 56 columns (500-card cache, accordion to 60 rows), a production-shaped changed tick: p99 <= 15 ms', () => {
  const a = bigTree();
  const b = bigTree(0, { id: 'n004', status: S.failed(ago(2)) });
  const paint = painter('rich');
  const lines = paint(a, NOW);
  for (const line of lines) assert.equal(visualLength(line), WIDTH);
  const swapped = measure((i) => paint(i % 2 ? a : b, tickNow(i)));
  report('rich no-change + one cached card (two memoised view models alternated; not asserted)', swapped);
  const before = { ...cardCacheStats };
  const changed = changedTicks(painter('rich'));
  const hits = cardCacheStats.hits - before.hits;
  const misses = cardCacheStats.misses - before.misses;
  report(
    `rich changed tick (fresh view model, 1 of 200 differs, clocks moved; every row; cards ${hits} hits / ${misses} misses, limit ${CARD_CACHE_LIMIT})`,
    changed
  );
  const changedView = changedTicks(painter('rich', PANE_ROWS));
  report(`rich changed tick, the ${PANE_ROWS} rows in view (not asserted)`, changedView);
  // Cold: every sample is a fresh copy of the other of two trees whose every node differs (each time is shifted),
  // so the projection, the plan, every row and every card are built again.
  const pair = [bigTree(1), bigTree(2)];
  let fresh: Built = pair[0];
  const cold = measure(
    () => paint(fresh, NOW + 1000 * 3600),
    (i) => {
      const source = pair[i % 2];
      fresh = { keys: source.keys, vm: structuredClone(source.vm) };
    }
  );
  report('rich cold tick, every row read (all 200 nodes differ; not asserted)', cold);
  const view = painter('rich', PANE_ROWS);
  const coldView = measure(
    () => view(fresh, NOW + 1000 * 3600),
    (i) => {
      const source = pair[i % 2];
      fresh = { keys: source.keys, vm: structuredClone(source.vm) };
    }
  );
  report(`rich cold tick, the ${PANE_ROWS} rows in view (not asserted)`, coldView);
  assert.ok(changed.p99 <= bound(15), `changed p99 ${changed.p99.toFixed(3)} ms`);
});
