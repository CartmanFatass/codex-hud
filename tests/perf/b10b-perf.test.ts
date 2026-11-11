/**
 * Design §6 #6 and #16, the shares this segment owns: compact rows for a
 * 200-node tree at 56 columns (<= 10 ms p99) and the no-change tick (<= 2 ms
 * p99). n = 1000 samples each, nearest-rank percentiles, after a warm-up.
 *
 * The strict bounds hold on a quiet machine and are asserted when
 * `B10B_PERF=1`; otherwise the same samples are checked against a bound five
 * times wider, so a loaded CI host does not flake while a real regression
 * (an order of magnitude) still fails. Numbers are printed either way:
 *
 *   B10B_PERF=1 node --test dist-test/tests/perf/b10b-perf.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { visualLength } from '../../src/render/colors.js';
import { ProjectionCache, projectDelegation } from '../../src/render/delegation/projection.js';
import { planRows, renderRows } from '../../src/render/delegation/rows.js';
import { delegationAlerts, delegationNotice } from '../../src/render/delegation/alerts.js';
import { countParts } from '../../src/render/delegation/bar.js';
import { statuslineDelegation } from '../../src/render/delegation/statusline.js';
import { glyphSet } from '../../src/render/delegation/glyphs.js';
import { plainSay } from '../../src/render/delegation/style.js';
import { NOW, S, ago, buildVm, type Built, type NodeSpec, type StatusSpec } from '../fixtures/b10b-delegation.js';

const STRICT = process.env.B10B_PERF === '1';
const SAMPLES = 1000;
const WARMUP = 200;
/** A bound five times wider than the design's when the run is not the strict one. */
const bound = (ms: number): number => (STRICT ? ms : ms * 5);

/** A deterministic 200-node tree: a root, workers of every kind of state, natives under some, three levels deep. */
function bigTree(count = 200, tweak?: { key: string; status: StatusSpec }, conflicts = 0): Built {
  const specs: NodeSpec[] = [
    {
      id: 'main',
      root: true,
      harness: 'claude',
      status: S.working(ago(300)),
      label: null,
      model: 'fable-5.1',
      effort: 'high',
      contextPercent: 41,
    },
  ];
  const harnesses = ['codex', 'pi', 'codex', 'claude'] as const;
  const ids: string[] = ['main'];
  for (let i = 1; i < count; i++) {
    const id = `n${String(i).padStart(3, '0')}`;
    // Every 6th node hangs under an earlier worker, so the tree is not a flat list.
    const parent = i % 6 === 0 && ids.length > 6 ? ids[1 + ((i * 7) % (ids.length - 1))] : 'main';
    const kind = i % 17;
    const status: StatusSpec | undefined =
      tweak && tweak.key === id
        ? tweak.status
        : kind === 3
          ? S.pending('approval', ago(5 + i))
          : kind === 8
            ? S.stale(ago(40 + i), ago(40 + i))
            : kind === 11
              ? S.failed(ago(30 + (i % 100)))
              : kind >= 13
                ? S.exited(ago(20 + (i % 100)))
                : S.working(ago(100 + i));
    const finished = kind >= 13 || kind === 11;
    specs.push({
      id,
      parent,
      harness: harnesses[i % harnesses.length],
      label: `worker-${id}`,
      status,
      run: finished
        ? {
            state: kind === 11 ? 'failed' : 'ended',
            mode: i % 3 ? 'headless' : 'visible',
            endedAt: ago(20 + (i % 100)),
          }
        : { state: 'running', mode: i % 3 ? 'headless' : 'visible' },
      report: finished
        ? {
            status: kind === 11 ? 'failed' : 'completed',
            summary: `Finished ${id} with a short synthetic summary.`,
            at: ago(20 + (i % 100)),
          }
        : null,
      model: 'gpt-6.1-sol',
      effort: i % 2 ? 'high' : 'xhigh',
      contextPercent: (i * 7) % 100,
      costUsd: i % 5 === 0 ? null : 0.01 * i,
      createdAt: ago(3000 - i),
      pane: i % 3 === 0 ? `pane ${i % 9}` : undefined,
    });
    ids.push(id);
  }
  // Conflict-only children, each claimed by the root and by `n001`: two relations each, no node of their own.
  for (let i = 0; i < conflicts; i++)
    specs.push({
      id: `x${String(i).padStart(3, '0')}`,
      parent: 'main',
      alsoClaimedBy: ['n001'],
      relationOnly: true,
      harness: harnesses[i % harnesses.length],
      conflict: { count: 2, since: ago(300 + i) },
    });
  return buildVm(specs, { capacity: { active: 6, limit: 6, mine: 4, mineLimit: 4 } });
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

interface Stats {
  n: number;
  p50: number;
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
    p99: percentile(samples, 0.99),
    max: samples[samples.length - 1],
  };
}

const report = (label: string, s: Stats): void => {
  console.log(
    `b10b-perf ${label}: n=${s.n} p50=${s.p50.toFixed(3)}ms p99=${s.p99.toFixed(3)}ms max=${s.max.toFixed(3)}ms strict=${STRICT}`
  );
};

const WIDTH = 56;
/** A clock that moves a second per tick and wraps within 40 s, so finished rows never reach the fold window. */
const tickNow = (i: number): number => NOW + (i % 40) * 1000;

test('200-node compact rows at 56 columns, every row built from nothing: p99 <= 10 ms', () => {
  const { vm } = bigTree();
  let proj = projectDelegation(vm, new ProjectionCache());
  const stats = measure(
    () => {
      renderRows(proj, { nowMs: NOW }, { width: WIDTH, say: plainSay });
    },
    // A fresh projection has fresh node objects, so no row string is cached: the worst tick, all rows changed.
    () => {
      proj = projectDelegation(vm, new ProjectionCache());
    }
  );
  const plan = planRows(proj, { nowMs: NOW });
  report(
    `rows200 cold (plan + ${plan.rows.length} row strings, ${plan.putAway} folded away, coarse=${plan.coarse})`,
    stats
  );
  const rows = renderRows(proj, { nowMs: NOW }, { width: WIDTH, say: plainSay });
  assert.ok(rows.length >= 150, `rows: ${rows.length}`);
  assert.ok(plan.coarse, 'a 200-node tree has more than 30 active rows');
  for (const row of rows) assert.equal(visualLength(row), WIDTH);
  assert.ok(stats.p99 <= bound(10), `p99 ${stats.p99.toFixed(3)} ms`);
});

test('200-node projection: cold build and a changed tick (one node differs)', () => {
  const base = bigTree();
  const cold = measure(() => {
    projectDelegation(base.vm, new ProjectionCache());
  });
  report('projection200 cold', cold);

  // Two trees that differ in one node's status; alternating them is a tick with one change in 200.
  const cache = new ProjectionCache();
  const a = bigTree(200);
  const b = bigTree(200, { key: 'n004', status: S.failed(ago(2)) });
  const changed = measure((i) => {
    projectDelegation(i % 2 ? a.vm : b.vm, cache);
  });
  report('projection200 changed tick (1 of 200 differs, rebuilt objects)', changed);
  assert.ok(cold.p99 <= bound(10) * 3, `cold ${cold.p99.toFixed(3)} ms`);
  assert.ok(changed.p99 <= bound(2) * 2.5, `changed ${changed.p99.toFixed(3)} ms`);
});

test('the no-change tick: same tree, the second moves on; p99 <= 2 ms', () => {
  const { vm } = bigTree();
  const proj0 = projectDelegation(vm);
  // Prime the row caches the way a panel that has been open does.
  renderRows(proj0, { nowMs: NOW }, { width: WIDTH, say: plainSay });
  const g = glyphSet(false);
  const stats = measure((i) => {
    const nowMs = tickNow(i);
    const proj = projectDelegation(vm);
    // What the bar and the first line read every tick: counts, alerts, notice.
    countParts(proj.counts, g);
    const alerts = delegationAlerts(proj, nowMs, plainSay);
    delegationNotice(proj, nowMs, plainSay);
    // The panel: replan for the new second and ask for the rows; unchanged ones come from the row cache.
    planRows(proj, { nowMs });
    const rows = renderRows(proj, { nowMs }, { width: WIDTH, say: plainSay });
    if (rows.length < 190) throw new Error(`rows folded away: ${rows.length}`);
    void alerts;
  });
  report('no-change tick (counts + alerts + notice + plan + 200 rows, clocks moved)', stats);
  assert.ok(stats.p99 <= bound(2), `p99 ${stats.p99.toFixed(3)} ms`);
});

test('the statusline from a warm projection, and the alerts alone', () => {
  const { vm } = bigTree();
  const proj = projectDelegation(vm);
  const line = measure((i) => {
    statuslineDelegation(vm, { width: 120, nowMs: tickNow(i), say: plainSay });
  });
  report('statusline delegation (120 cols, warm)', line);
  const alerts = measure((i) => {
    delegationAlerts(proj, tickNow(i), plainSay);
    delegationNotice(proj, tickNow(i), plainSay);
  });
  report('alerts + notice (200 nodes)', alerts);
  assert.ok(line.p99 <= bound(2) * 2.5, `statusline ${line.p99.toFixed(3)} ms`);
  assert.ok(alerts.p99 <= bound(2), `alerts ${alerts.p99.toFixed(3)} ms`);
});

test('the conflict-heavy boundary: 150 nodes and 400 conflicting children stay inside the 200-node budget', () => {
  const { vm } = bigTree(150, undefined, 400);
  const first = projectDelegation(vm, new ProjectionCache());
  assert.equal(first.nodes.length, 200, 'the budget is shared with the conflict rows');
  assert.equal(first.omittedConflictRows, 750, '800 claims, 50 drawn');
  assert.equal(first.counts.warn, 400, 'every child still counts once');
  const stats = measure(() => {
    const proj = projectDelegation(vm, new ProjectionCache());
    const alerts = delegationAlerts(proj, NOW, plainSay);
    delegationNotice(proj, NOW, plainSay);
    const rows = renderRows(proj, { nowMs: NOW }, { width: WIDTH, say: plainSay });
    if (rows.length > 200 || alerts.nodes.length === 0) throw new Error(`rows ${rows.length}`);
  });
  report(
    'conflict-heavy boundary (150 nodes + 400 conflict children: project + alerts + notice + 200 rows, cold)',
    stats
  );
  // The whole cold tick against the render share of a changed tick (§6 #6: 15 ms).
  assert.ok(stats.p99 <= bound(15), `p99 ${stats.p99.toFixed(3)} ms`);
});
