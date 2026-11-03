/**
 * B10B-s2: the selection, render only (design §5.2 "选中行"; rulings B10B-s2 Q5, Q6). The `⊕N` row is the one
 * selectable row that is not a node: on a palette with a band it paints in the band's ink like a node row; without
 * one (`none`, `terminal`) it is the `›` and bold text. A selection that is not a planned row selects nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stripAnsi } from '../../src/render/colors.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { palette, type Palette } from '../../src/render/palette.js';
import { delegationAgentsRows } from '../../src/render/delegation/panel.js';
import { ProjectionCache, projectDelegation } from '../../src/render/delegation/projection.js';
import { planRows } from '../../src/render/delegation/rows.js';
import { cells, cellsOf } from '../fixtures/b10b-sgr.js';
import { NOW, situationD, situationC } from '../fixtures/b10b-delegation.js';

const BAND = ['mocha', 'latte', 'titanium'] as const;
const BANDLESS = ['none', 'terminal'] as const;

function withTheme(name: string, run: (p: Palette) => void): void {
  const previous = setDisplayConfig({ theme: name as never });
  try {
    run(palette());
  } finally {
    setDisplayConfig(previous);
  }
}
const fg = (paint: (t: string) => string) => cells(paint('x'))[0].fg;

function putAwayKey(): { vm: ReturnType<typeof situationD>['vm']; key: string } {
  const { vm } = situationD();
  const plan = planRows(projectDelegation(vm, new ProjectionCache()), { nowMs: NOW });
  const row = plan.rows.find((r) => r.kind === 'putAway')!;
  return { vm, key: row.key };
}

test('⊕N selected on a band palette: every cell on the band, in the family ink, `›` first (mocha, latte, titanium)', () => {
  for (const name of BAND)
    withTheme(name, (p) => {
      const { vm, key } = putAwayKey();
      for (const style of ['compact', 'rich'] as const) {
        const rows = delegationAgentsRows(vm, { width: 48, nowMs: NOW, style, selectedId: key });
        const row = rows.find((r) => r.item === key)!.text;
        const band = cells(p.selectedBand('x'))[0].bg;
        const family = new Set(
          (['text', 'muted', 'accent', 'success', 'warning', 'danger', 'info', 'model'] as const).map((r) =>
            fg(p.onSelectedBand[r])
          )
        );
        const all = cells(row);
        assert.equal(all[0].ch, '›', `${name} ${style}`);
        assert.equal(all[0].fg, fg(p.onSelectedBand.accent));
        for (const cell of all) {
          assert.equal(cell.bg, band, `${name} ${style}: "${cell.ch}" on the band`);
          if (cell.ch !== ' ') assert.ok(family.has(cell.fg), `${name} ${style}: "${cell.ch}" in the family ink`);
        }
        assert.ok(
          cellsOf(row, '9 done · t-02').every((c) => c.bold),
          `${name}: the text is bold`
        );
        // Unselected, the same row has no band.
        const plain = delegationAgentsRows(vm, { width: 48, nowMs: NOW, style }).find((r) => r.item === key)!.text;
        assert.ok(cells(plain).every((c) => c.bg !== band));
      }
    });
});

test('⊕N selected without a band (none, terminal): `›` and bold text, no surface', () => {
  for (const name of BANDLESS)
    withTheme(name, () => {
      const { vm, key } = putAwayKey();
      const row = delegationAgentsRows(vm, { width: 48, nowMs: NOW, style: 'compact', selectedId: key }).find(
        (r) => r.item === key
      )!.text;
      const all = cells(row);
      assert.equal(all[0].ch, '›', name);
      assert.ok(
        all.every((c) => c.bg === null),
        `${name}: no band`
      );
      assert.ok(
        cellsOf(row, '9 done · t-02').every((c) => c.bold),
        `${name}: the text is bold`
      );
      assert.match(stripAnsi(row), /^›└ ✓ 9 done · t-02/);
    });
});

test('a rich card selected on a band palette: its head is on the band with `›` for the corner', () => {
  for (const name of BAND)
    withTheme(name, (p) => {
      const c = situationC();
      const key = c.keys['impl-parser'];
      const rows = delegationAgentsRows(c.vm, { width: 48, nowMs: NOW, style: 'rich', selectedId: key });
      const head = rows.find((r) => r.item === key)!.text;
      const band = cells(p.selectedBand('x'))[0].bg;
      const all = cells(head);
      assert.equal(all.find((c) => c.ch !== ' ')!.ch, '›');
      assert.ok(
        all.slice(2).every((cell) => cell.bg === band),
        `${name}: the head's own surface`
      );
    });
});

test('a selection that is no planned row selects nothing (the legacy ids of today, Q6)', () => {
  const c = situationC();
  for (const style of ['compact', 'rich'] as const) {
    const rows = delegationAgentsRows(c.vm, { width: 48, nowMs: NOW, style, selectedId: 'legacy-agent-id' });
    const none = delegationAgentsRows(c.vm, { width: 48, nowMs: NOW, style, selectedId: null });
    assert.deepEqual(
      rows.map((r) => r.text),
      none.map((r) => r.text),
      style
    );
    assert.ok(
      rows.every((r) => !stripAnsi(r.text).includes('›')),
      style
    );
  }
  // A planned row's key selects it, and only it carries the micro card.
  const key = c.keys['review-tests'];
  const rows = delegationAgentsRows(c.vm, { width: 48, nowMs: NOW, style: 'compact', selectedId: key });
  assert.equal(rows.filter((r) => stripAnsi(r.text).startsWith('›')).length, 1);
  assert.equal(rows.filter((r) => r.item === key).length, 3, 'the row and its two micro card lines');
});

test('micro card under a selected row: no band and the plain ink, never the band family (mocha, latte, titanium)', () => {
  for (const name of BAND)
    withTheme(name, (p) => {
      const d = situationD();
      const key = d.keys['t-11'];
      const rows = delegationAgentsRows(d.vm, { width: 48, nowMs: NOW, style: 'compact', selectedId: key });
      const at = rows.findIndex((r) => r.item === key);
      const micro = rows.slice(at + 1, at + 3);
      assert.equal(micro.length, 2);
      assert.ok(micro.every((r) => r.item === key));
      const band = cells(p.selectedBand('x'))[0].bg;
      const plain = new Set(
        [p.text, p.muted, p.accent, p.warning, p.danger, p.info, p.success, p.model].map((paint) => fg(paint))
      );
      for (const row of micro)
        for (const cell of cells(row.text)) {
          assert.notEqual(cell.bg, band, `${name}: "${cell.ch}" is off the band`);
          if (cell.ch !== ' ') assert.ok(plain.has(cell.fg), `${name}: "${cell.ch}" in a plain role (${cell.fg})`);
        }
      // The warnings are the plain warning, not the band's calibrated one (they differ on latte).
      assert.equal(cellsOf(micro[1].text, '?')[0].fg, fg(p.warning), `${name}: ? in the plain warning`);
      assert.equal(cellsOf(micro[0].text, 'slot held')[0].fg, fg(p.warning), `${name}: slot held`);
      if (name === 'latte') assert.notEqual(fg(p.warning), fg(p.onSelectedBand.warning), 'latte tells them apart');
      // The selected row itself is on the band.
      assert.ok(cells(rows[at].text).every((cell) => cell.bg === band));
    });
});
