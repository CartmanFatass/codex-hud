/**
 * B10B-s3: the width order of a row without a state word at 39 columns or fewer (B10B-s2 review F7; design §3.4
 * "≤ 39 列：先丢 ⊟，再丢状态词，最后才截名字", §4.13's 32-column sample). The `⊟` goes before the name is cut.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { ProjectionCache, projectDelegation } from '../../src/render/delegation/projection.js';
import { renderRows } from '../../src/render/delegation/rows.js';
import { NOW, S, buildVm, type NodeSpec } from '../fixtures/b10b-delegation.js';

function workers(...names: string[]) {
  const specs: NodeSpec[] = [
    {
      id: 'main',
      root: true,
      harness: 'claude',
      status: S.working(NOW - 300_000),
      label: null,
      model: 'fable-5.1',
      effort: 'high',
      contextPercent: 41,
    },
    ...names.map((label, i): NodeSpec => ({
      id: `w${i}`,
      parent: 'main',
      harness: 'pi',
      label,
      role: 'reviewer',
      status: S.working(NOW - 200_000),
      run: { state: 'running', mode: 'headless' },
      model: 'gpt-6.1-sol',
      effort: 'high',
      contextPercent: 24,
      createdAt: NOW - 3_000_000 + i,
    })),
  ];
  return buildVm(specs);
}

function lines(names: string[], width: number): string[] {
  const { vm } = workers(...names);
  const proj = projectDelegation(vm, new ProjectionCache());
  const rows = renderRows(proj, { nowMs: NOW }, { width });
  for (const row of rows) assert.equal(visualLength(row), width, `exactly ${width} columns`);
  return rows.map(stripAnsi);
}

test('32 columns: a headless row without a state word keeps its whole name and drops ⊟ (the §4.13 sample)', () => {
  const [, worker] = lines(['review-tests'], 32);
  assert.match(worker, /^ [├└] ▸ π review-tests /);
  assert.ok(!worker.includes('⊟'), worker);
  assert.ok(!worker.includes('…'), 'the name is not cut');
});

test('39 columns: ⊟ stays while the whole name fits beside it, and is the first thing to go when it does not', () => {
  const [, fits, cut] = lines(['review-tests', 'parser-slow-lane-review-with-a-long-name'], 39);
  assert.match(fits, /^ [├└] ▸ π review-tests ⊟ /, 'room for both: nothing is shed');
  assert.ok(!cut.includes('⊟'), `the long name loses ⊟ before it is cut: ${cut}`);
  assert.match(cut, /^ └ ▸ π parser-slow-lane-r…/);
});

test('34 columns: the boundary, ⊟ kept by the name that fits, dropped by the one that does not', () => {
  const [, fits, cut] = lines(['review-tests', 'parser-slow-lane-review-with-a-long-name'], 34);
  assert.match(fits, /review-tests ⊟/);
  assert.ok(!cut.includes('⊟'), cut);
  assert.ok(cut.includes('…'), cut);
});

test('the name is cut to its 8-column floor at most, and the ⊟ stays gone', () => {
  for (const width of [32, 33, 36, 39]) {
    const [, row] = lines(['a-very-long-reviewer-name-that-never-fits-anywhere'], width);
    assert.ok(!row.includes('⊟'), `${width}: ${row}`);
    assert.ok(/[^\s]{8,}…/.test(row), `${width}: at least the 8-column floor survives: ${row}`);
  }
});

test('40 columns and up are untouched: the name is cut to its floor beside ⊟ (segment 1)', () => {
  const [, row] = lines(['review-tests'], 40);
  assert.match(row, /review-tes… ⊟/);
});

test('a row with a state word keeps its segment 1 order (the word goes, then ⊟ comes back if it fits)', () => {
  const { vm } = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working(NOW - 300_000), label: null },
    {
      id: 'w0',
      parent: 'main',
      harness: 'pi',
      label: 'review-tests',
      role: 'reviewer',
      status: S.pending('approval', NOW - 10_000),
      run: { state: 'running', mode: 'headless' },
      createdAt: NOW - 3_000_000,
    },
  ]);
  const proj = projectDelegation(vm, new ProjectionCache());
  const rows = renderRows(proj, { nowMs: NOW }, { width: 32 }).map(stripAnsi);
  assert.match(rows[1], /^ └ ⚑ π review-tests ⊟ +10s$/);
});
