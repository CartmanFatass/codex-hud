/**
 * B10B-s2: native children (design §3.4 icon slot, §4.2, §7 #33; rulings B10B-s2 Q7, Q8): the name from
 * `native.title`, the kind icon from `native.kind`, both with their fallbacks; the ASCII slot; the `◈N` chip.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stripAnsi } from '../../src/render/colors.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { palette } from '../../src/render/palette.js';
import { delegationAgentsRows } from '../../src/render/delegation/panel.js';
import { UNICODE_GLYPHS } from '../../src/render/delegation/glyphs.js';
import { KIND_GLYPHS } from '../../src/render/agent-title.js';
import { cells, cellsOf } from '../fixtures/b10b-sgr.js';
import { NOW, S, ago, buildVm, type NodeSpec } from '../fixtures/b10b-delegation.js';

const ROOT: NodeSpec = {
  id: 'main',
  root: true,
  harness: 'codex',
  status: S.working(ago(60)),
  label: null,
  model: 'gpt-6.1-sol',
  effort: 'high',
};
const native = (id: string, meta: NodeSpec['nativeMeta'] | undefined, extra: Partial<NodeSpec> = {}): NodeSpec => ({
  id,
  parent: 'main',
  native: true,
  label: null,
  status: S.working(ago(30)),
  model: 'gpt-6.1-sol',
  ...(meta === undefined ? {} : { nativeMeta: meta }),
  ...extra,
});
const draw = (specs: NodeSpec[], width = 48, ascii = false, style: 'rich' | 'compact' = 'compact') =>
  delegationAgentsRows(buildVm(specs).vm, { width, nowMs: NOW, style, ascii }).map((r) => stripAnsi(r.text));

test('native: the name is native.title; null title falls back to the session short form', () => {
  const rows = draw([
    ROOT,
    native('s1', { title: 'scout  parser\tcall sites', kind: 'research' }),
    native('s2', { title: null, kind: 'fix' }),
  ]);
  assert.ok(
    rows.some((r) => /▸ ⌕ scout parser call sites +◷0m30s$/.test(r)),
    rows.join('\n')
  );
  assert.ok(
    rows.some((r) => /▸ ⚒ codex:s200 +◷0m30s$/.test(r)),
    'null title: the short form'
  );
});

test('native: the kind icon from native.kind; null and `other` leave the slot blank', () => {
  const rows = draw([
    ROOT,
    native('a', { title: 'alpha', kind: 'review' }),
    native('b', { title: 'beta', kind: null }),
    native('c', { title: 'gamma', kind: 'other' }),
    native('d', undefined, { label: 'delta' }),
  ]);
  assert.ok(rows.some((r) => / ▸ ◈ alpha /.test(r)));
  for (const name of ['beta', 'gamma', 'delta'])
    assert.ok(
      rows.some((r) => new RegExp(` ▸ {3}${name} `).test(r)),
      name
    );
});

test('native: with no kind icon anywhere, a single-harness tree has no slot column (segment 1 unchanged)', () => {
  const rows = draw([ROOT, native('b', { title: 'beta', kind: null }), native('c', { title: 'gamma', kind: 'other' })]);
  assert.ok(
    rows.some((r) => / ├ ▸ beta /.test(r)),
    rows.join('\n')
  );
});

test('native: the table is the panel`s KIND_GLYPHS', () => {
  assert.deepEqual(UNICODE_GLYPHS.kind, KIND_GLYPHS);
});

test('ASCII: no kind column in a single-harness tree; a blank native slot beside the harness letters', () => {
  const single = draw([ROOT, native('a', { title: 'alpha', kind: 'review' })], 48, true);
  assert.ok(
    single.some((r) => /^ \\ > alpha /.test(r)),
    single.join('\n')
  );
  assert.ok(
    single.some((r) => /^ {2}> main /.test(r)),
    'the root has no slot either'
  );
  const cross = draw(
    [
      { ...ROOT, harness: 'claude' },
      { id: 'w', parent: 'main', harness: 'pi', status: S.working(ago(30)) },
      native('a', { title: 'alpha', kind: 'review' }, { parent: 'w' }),
    ],
    48,
    true
  );
  assert.ok(
    cross.some((r) => /^ {2}> C main /.test(r)),
    cross.join('\n')
  );
  assert.ok(cross.some((r) => /^ \\ > P w /.test(r)));
  assert.ok(
    cross.some((r) => /^ {3}\\ > {3}alpha /.test(r)),
    'the native slot is blank in ASCII'
  );
});

test('◈N: on compact rows from 56 columns, before the badge; not at 55, not on a rich card head', () => {
  const specs: NodeSpec[] = [
    ROOT,
    native('r1', { title: 'review-a', kind: 'review' }),
    native('r2', { title: 'review-b', kind: 'review' }, { status: S.failed(ago(20)) }),
  ];
  const wide = draw(specs, 56);
  assert.match(wide[1], /main +◈2 +\S/, wide[1]);
  assert.doesNotMatch(draw(specs, 55)[1], /◈/);
  const rich = draw(specs, 80, false, 'rich');
  assert.doesNotMatch(rich[1], /◈2/, 'not on the card head');
  // ASCII: rN.
  assert.match(draw(specs, 56, true)[1], /main +r2 +/);
  // Red when a review failed (today's reviewChip).
  const previous = setDisplayConfig({ theme: 'mocha' });
  try {
    const { vm } = buildVm(specs);
    const row = delegationAgentsRows(vm, { width: 56, nowMs: NOW, style: 'compact' })[1].text;
    assert.equal(cellsOf(row, '◈2')[0].fg, cells(palette().danger('x'))[0].fg);
  } finally {
    setDisplayConfig(previous);
  }
});
