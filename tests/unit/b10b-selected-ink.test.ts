/**
 * Design §5.2 "选中行": the ink of a selected row. The palette's `onSelectedBand` family is calibrated for the
 * `selectedBand` surface (text >= 4.5:1, muted >= 3:1 and >= 1.5:1 from text, hues >= 3:1 with hue and saturation
 * kept), and every span of a selected row goes through it: nothing on the band is a plain `theme.*` colour.
 *
 * Three groups: the family's own numbers (per palette, from the SGR of the paints themselves); the badge's paint
 * table in `model-glyphs.ts` (the default reproduces today's output, a given table recolours exactly the spans the
 * ruling names); and the rows as drawn, cell by cell.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { colors, theme } from '../../src/render/colors.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { fitModelEffortToken, renderModelEffortToken, type ModelTokenPaints } from '../../src/render/model-glyphs.js';
import { palette, type OnSelectedBand, type Palette } from '../../src/render/palette.js';
import { projectDelegation } from '../../src/render/delegation/projection.js';
import { renderRows, type RowOptions } from '../../src/render/delegation/rows.js';
import { plainSay } from '../../src/render/delegation/style.js';
import type { DelegationViewModel } from '../../src/core/link/view-model.js';
import { NOW, S, ago, buildVm, type NodeSpec } from '../fixtures/b10b-delegation.js';
import { cells, cellsOf } from '../fixtures/b10b-sgr.js';

const BAND_PALETTES = ['mocha', 'latte', 'titanium'] as const;
const HUES = ['info', 'success', 'warning', 'danger', 'accent', 'model'] as const;
const ROLES = ['text', 'muted', 'accent', 'success', 'warning', 'danger', 'info', 'model'] as const;
type Role = (typeof ROLES)[number];

// ---------------------------------------------------------------------------
// Colour arithmetic on the SGR value `2;r;g;b` a paint writes.

const rgbOf = (value: string): [number, number, number] => {
  const parts = value.split(';').map(Number);
  assert.equal(parts[0], 2, `a 24-bit colour: ${value}`);
  return [parts[1], parts[2], parts[3]];
};
const linear = (c: number): number => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const luminance = (value: string): number => {
  const [r, g, b] = rgbOf(value);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** Hue in degrees and saturation in percent (HSL). */
const hs = (value: string): { h: number; s: number } => {
  const [r, g, b] = rgbOf(value).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: s * 100 };
};
const hex = (value: string): string => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
  return `2;${r};${g};${b}`;
};

const fgOf = (paint: (text: string) => string): string => {
  const fg = cells(paint('x'))[0].fg;
  assert.ok(fg, 'the paint sets a foreground');
  return fg;
};
const bandOf = (p: Palette): string => {
  const bg = cells(p.selectedBand('x'))[0].bg;
  assert.ok(bg, 'the band sets a background');
  return bg;
};

function withTheme(name: string, run: (p: Palette) => void, extra: object = {}): void {
  const previous = setDisplayConfig({ theme: name as never, ...extra });
  try {
    run(palette());
  } finally {
    setDisplayConfig(previous);
  }
}

// ---------------------------------------------------------------------------
// The family.

test('onSelectedBand: the floors against selectedBand, and a role that meets its floor is the plain role', () => {
  const changed: Record<string, string[]> = {};
  for (const name of BAND_PALETTES) {
    withTheme(name, (p) => {
      const band = bandOf(p);
      const family = p.onSelectedBand;
      const text = fgOf(family.text);
      const muted = fgOf(family.muted);
      assert.ok(contrast(text, band) >= 4.5, `${name} text ${contrast(text, band).toFixed(2)}`);
      assert.ok(contrast(muted, band) >= 3, `${name} muted ${contrast(muted, band).toFixed(2)}`);
      assert.ok(contrast(text, muted) >= 1.5, `${name}: muted is visibly quieter than text`);
      for (const role of HUES) {
        const ratio = contrast(fgOf(family[role]), band);
        assert.ok(ratio >= 3, `${name} ${role} ${ratio.toFixed(2)}`);
        // Lightness is the only thing that may move: the hue stays the plain role's, within 6 degrees and 6 points.
        const was = hs(fgOf(p[role]));
        const now = hs(fgOf(family[role]));
        const turn = Math.abs(was.h - now.h);
        assert.ok(Math.min(turn, 360 - turn) <= 6, `${name} ${role}: hue ${was.h.toFixed(0)} -> ${now.h.toFixed(0)}`);
        assert.ok(
          Math.abs(was.s - now.s) <= 6,
          `${name} ${role}: saturation ${was.s.toFixed(0)} -> ${now.s.toFixed(0)}`
        );
      }
      // Unchanged when it passes (byte for byte the plain paint), calibrated only when it does not.
      changed[name] = ROLES.filter((role: Role) => {
        const plain = p[role]('x');
        const mine = family[role]('x');
        const ratio = contrast(fgOf(p[role]), band);
        const passes =
          role === 'text'
            ? ratio >= 4.5
            : role === 'muted'
              ? ratio >= 3 && contrast(text, fgOf(p.muted)) >= 1.5
              : ratio >= 3;
        assert.equal(mine === plain, passes, `${name} ${role}: ${passes ? 'unchanged' : 'calibrated'}`);
        return mine !== plain;
      });
    });
  }
  // Only three constants, all latte; mocha and titanium are the plain roles throughout.
  assert.deepEqual(changed, { mocha: [], latte: ['success', 'warning', 'info'], titanium: [] });
  withTheme('latte', (p) => {
    assert.equal(fgOf(p.onSelectedBand.warning), hex('#9C6414'));
    assert.equal(fgOf(p.onSelectedBand.success), hex('#337F22'));
    assert.equal(fgOf(p.onSelectedBand.info), hex('#0378A6'));
  });
});

test('onSelectedBand: without a band (none, terminal) the family is the plain roles', () => {
  for (const name of ['none', 'terminal']) {
    withTheme(name, (p) => {
      for (const role of ROLES) assert.equal(p.onSelectedBand[role]('x'), p[role]('x'), `${name} ${role}`);
    });
  }
});

// ---------------------------------------------------------------------------
// The badge's paint table.

const SENTINELS: ModelTokenPaints = {
  model: (text) => `[m:${text}]`,
  muted: (text) => `[d:${text}]`,
  warning: (text) => `[w:${text}]`,
};

test('model badge: the default paints are the palette roles, and a given table recolours exactly its spans', () => {
  const plainTable: ModelTokenPaints = {
    model: (text) => theme.model(text),
    muted: (text) => colors.dim(text),
    warning: (text) => theme.warning(text),
  };
  for (const name of ['mocha', 'latte', 'titanium', 'terminal', 'none']) {
    withTheme(name, () => {
      for (const model of ['gpt-6.1-sol', 'gpt-6.1-astra', 'some-unknown-model'])
        for (const effort of [undefined, 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'odd'])
          for (const mode of ['glyph', 'text', 'both'] as const) {
            const label = `${name} ${model} ${effort} ${mode}`;
            assert.equal(
              renderModelEffortToken(model, effort, { mode, paints: plainTable }),
              renderModelEffortToken(model, effort, { mode }),
              label
            );
            for (const max of [4, 8, 13])
              assert.equal(
                fitModelEffortToken(model, effort, max, mode, plainTable),
                fitModelEffortToken(model, effort, max, mode),
                `${label} fit ${max}`
              );
          }
    });
  }
  const render = (effort: string | undefined, mode: 'glyph' | 'text' | 'both') =>
    renderModelEffortToken('gpt-6.1-sol', effort, { mode, paints: SENTINELS });
  // The symbol and the family words are `model`; low and medium glyphs and every `·effort` and the words beside a
  // symbol are `muted`; high and xhigh glyphs are `model`; max and ultra glyphs are `warning`.
  assert.equal(render('low', 'glyph'), '[m:★][d:○]');
  assert.equal(render('medium', 'glyph'), '[m:★][d:◐]');
  assert.equal(render('high', 'glyph'), '[m:★][m:◕]');
  assert.equal(render('xhigh', 'glyph'), '[m:★][m:●]');
  assert.equal(render('max', 'glyph'), '[m:★][w:◆]');
  assert.equal(render('ultra', 'glyph'), '[m:★][w:✦]');
  assert.equal(render('high', 'text'), '[m:6.1sol][d:·high]');
  assert.equal(render('max', 'text'), '[m:6.1sol][d:·max]');
  assert.equal(render('high', 'both'), '[m:★][m:◕] [d:6.1sol]');
  assert.equal(
    renderModelEffortToken('odd-model', 'odd', { mode: 'both', paints: SENTINELS }),
    '[m:odd-model] [d:·odd]'
  );
  // `fit` hands the table to every form it tries, the bare one included.
  assert.equal(fitModelEffortToken('gpt-6.1-sol', 'high', 40, 'text', SENTINELS), '[m:6.1sol][d:·high]');
  assert.equal(fitModelEffortToken('gpt-6.1-sol', 'high', 12, 'text', SENTINELS), '[m:6.1sol]');
  assert.equal(fitModelEffortToken('gpt-6.1-sol', 'max', 40, 'both', SENTINELS), '[m:★][w:◆] [d:6.1sol]');
});

// ---------------------------------------------------------------------------
// The rows as drawn.

const MAIN: NodeSpec = { id: 'main', root: true, harness: 'claude', status: S.working(ago(30)), label: null };

function tree(extra: NodeSpec[]): { vm: DelegationViewModel; keys: Record<string, string> } {
  return buildVm([MAIN, ...extra]);
}

function drawRaw(vm: DelegationViewModel, width: number, options: Partial<RowOptions> & { selectedKey?: string } = {}) {
  const { selectedKey, ...rest } = options;
  return renderRows(projectDelegation(vm), { nowMs: NOW, ...rest }, { width, selectedKey, say: plainSay });
}

/** One of each state, in three harnesses (so every row has its icon slot), fresh enough to keep its hue. */
const STATES: NodeSpec[] = [
  {
    id: 'unc-1',
    parent: 'main',
    harness: 'codex',
    run: { state: 'uncertain', reconciliation: 'scope_unknown' },
    status: { cls: 'uncertain', since: ago(100) },
    createdAt: ago(900),
  },
  { id: 'cfl-1', parent: 'main', harness: 'codex', relationOnly: true, conflict: { count: 2, since: ago(300) } },
  {
    id: 'int-1',
    parent: 'main',
    harness: 'codex',
    run: { state: 'ended' },
    status: S.interrupted(ago(20)),
    createdAt: ago(800),
  },
  {
    id: 'fai-1',
    parent: 'main',
    harness: 'pi',
    run: { state: 'failed' },
    status: S.failed(ago(20)),
    createdAt: ago(700),
  },
  {
    id: 'don-1',
    parent: 'main',
    harness: 'codex',
    run: { state: 'ended' },
    report: { status: 'completed', at: ago(20) },
    status: S.exited(ago(20)),
    createdAt: ago(600),
  },
  {
    id: 'old-1',
    parent: 'main',
    harness: 'codex',
    run: { state: 'ended' },
    report: { status: 'completed', at: ago(100) },
    status: S.exited(ago(100)),
    createdAt: ago(550),
  },
  {
    id: 'wrk-1',
    parent: 'main',
    harness: 'codex',
    status: S.working(ago(60)),
    model: 'gpt-6.1-sol',
    effort: 'high',
    contextPercent: 50,
    createdAt: ago(500),
  },
  {
    id: 'apr-1',
    parent: 'main',
    harness: 'pi',
    status: S.pending('approval', ago(40)),
    createdAt: ago(400),
  },
];

/** What each state's marker and word are painted with, and whether the marker is bold. */
const EXPECT: Array<{ id: string; key: string; marker: string; word: string; role: Role }> = [
  { id: 'unc-1', key: 'codex:unc-1', marker: '?', word: 'uncertain', role: 'warning' },
  { id: 'cfl-1', key: 'conflict:l_cfl-1:claude:main', marker: '⚠', word: 'conflict', role: 'warning' },
  { id: 'int-1', key: 'codex:int-1', marker: '■', word: 'interrupted', role: 'warning' },
  { id: 'fai-1', key: 'pi:fai-1', marker: '!', word: 'launch failed', role: 'danger' },
  { id: 'don-1', key: 'codex:don-1', marker: '✓', word: 'reported', role: 'success' },
  { id: 'wrk-1', key: 'codex:wrk-1', marker: '▸', word: 'working', role: 'info' },
  { id: 'apr-1', key: 'pi:apr-1', marker: '⚑', word: 'approval', role: 'danger' },
];

test('selected row: markers and words carry the family hue of their role, on the band (mocha, latte, titanium)', () => {
  for (const name of BAND_PALETTES) {
    withTheme(name, (p) => {
      const band = bandOf(p);
      const { vm, keys } = tree(STATES);
      for (const e of EXPECT) {
        const key = e.id === 'cfl-1' ? e.key : keys[e.id];
        const row = drawRaw(vm, 100, { selectedKey: key }).find((r) => r.includes(e.marker) && r.includes(e.id));
        assert.ok(row, `${name} ${e.id}: the row`);
        const want = fgOf(p.onSelectedBand[e.role]);
        const marker = cellsOf(row!, e.marker)[0];
        assert.equal(marker.fg, want, `${name} ${e.id}: marker hue`);
        assert.equal(marker.bg, band, `${name} ${e.id}: marker on the band`);
        assert.equal(marker.bold, true, `${name} ${e.id}: the marker is bold on the selection`);
        if (e.id === 'wrk-1') continue; // the working row's `working` is no word; its hue is the marker's
        for (const cell of cellsOf(row!, e.word)) assert.equal(cell.fg, want, `${name} ${e.id}: the word "${e.word}"`);
      }
    });
  }
});

test("selected row: every cell is the band's own ink, at 3:1 or better (clock, badge, meter, tree, name, harness mark)", () => {
  for (const name of BAND_PALETTES) {
    withTheme(name, (p) => {
      const band = bandOf(p);
      const family = new Set(ROLES.map((role) => fgOf(p.onSelectedBand[role])));
      const { vm, keys } = tree(STATES);
      for (const e of EXPECT) {
        const key = e.id === 'cfl-1' ? e.key : keys[e.id];
        for (const width of [48, 100]) {
          const row = drawRaw(vm, width, { selectedKey: key }).find((r) => r.includes(e.id) && r.includes(e.marker));
          assert.ok(row, `${name} ${e.id} ${width}`);
          for (const cell of cells(row!)) {
            assert.equal(cell.bg, band, `${name} ${e.id} ${width}: the band`);
            if (cell.ch === ' ') continue;
            assert.ok(
              family.has(cell.fg ?? 'none'),
              `${name} ${e.id} ${width}: "${cell.ch}" is ${cell.fg}, not the family's`
            );
            assert.ok(contrast(cell.fg!, band) >= 3, `${name} ${e.id} ${width}: "${cell.ch}" legible on the band`);
          }
        }
      }
    });
  }
});

test('selected row: the latte status hues are the calibrated ones, and never the plain ones', () => {
  withTheme('latte', () => {
    const { vm, keys } = tree(STATES);
    const plain = [hex('#DF8E1D'), hex('#40A02B'), hex('#04A5E5')];
    const seen = new Set<string>();
    for (const e of EXPECT) {
      const key = e.id === 'cfl-1' ? e.key : keys[e.id];
      for (const cell of cells(drawRaw(vm, 100, { selectedKey: key }).find((r) => r.includes(e.id))!))
        if (cell.fg) seen.add(cell.fg);
    }
    for (const value of plain) assert.equal(seen.has(value), false, `${value} is not drawn on the band`);
    for (const value of ['#9C6414', '#337F22', '#0378A6']) assert.equal(seen.has(hex(value)), true, `${value} is`);
    // The unselected rows keep the plain hues.
    const rows = drawRaw(vm, 100);
    assert.equal(
      cellsOf(
        rows.find((r) => r.includes('unc-1') && r.includes('?'))!,
        '?'
      )[0].fg,
      hex('#DF8E1D')
    );
  });
});

test('selected row: the selection mark, the tree, the name and the harness mark', () => {
  for (const name of BAND_PALETTES) {
    withTheme(name, (p) => {
      const f = p.onSelectedBand;
      const { vm, keys } = tree(STATES);
      const row = drawRaw(vm, 100, { selectedKey: keys['unc-1'] }).find((r) => r.includes('unc-1'))!;
      const all = cells(row);
      assert.equal(all[0].ch, '›');
      assert.equal(all[0].fg, fgOf(f.accent), `${name}: › is the accent`);
      assert.equal(cellsOf(row, '├')[0].fg, fgOf(f.muted), `${name}: the tree is muted`);
      for (const cell of cellsOf(row, 'unc-1')) {
        assert.equal(cell.fg, fgOf(f.text), `${name}: the name is text`);
        assert.equal(cell.bold, true, `${name}: and bold`);
      }
      const slot = cellsOf(row, '⌬')[0];
      assert.equal(slot.fg, fgOf(f.text), `${name}: the harness mark is text`);
      assert.equal(slot.bold, true, `${name}: and strong`);
      // The same mark off the selection is muted and plain.
      const other = drawRaw(vm, 100).find((r) => r.includes('unc-1'))!;
      assert.equal(cellsOf(other, '⌬')[0].fg, fgOf(p.muted), `${name}: muted when not selected`);
      assert.equal(cellsOf(other, '⌬')[0].bold, false);
      // A history row's name is muted, and bold on the selection.
      const old = drawRaw(vm, 100, { selectedKey: keys['old-1'] }).find((r) => r.includes('old-1'))!;
      for (const cell of cellsOf(old, 'old-1')) {
        assert.equal(cell.fg, fgOf(f.muted), `${name}: a settled row's name is muted`);
        assert.equal(cell.bold, true);
      }
    });
  }
});

test('selected row: the model badge is painted with the family (text, glyph and both modes)', () => {
  const efforts = ['low', 'high', 'max'];
  const specs = (model: string): NodeSpec[] =>
    efforts.map((effort, i): NodeSpec => ({
      id: `e-${effort}`,
      parent: 'main',
      harness: 'codex',
      status: S.working(ago(60)),
      model,
      effort,
      createdAt: ago(500 - i),
    }));
  for (const name of BAND_PALETTES) {
    withTheme(
      name,
      (p) => {
        const f = p.onSelectedBand;
        const { vm, keys } = tree(specs('gpt-6.1-sol'));
        const row = (effort: string) =>
          drawRaw(vm, 100, { selectedKey: keys[`e-${effort}`] }).find((r) => r.includes(`e-${effort}`))!;
        // Text mode: the family words are `model` and `·effort` is `muted` (for every effort, today's rule).
        for (const effort of efforts) {
          for (const cell of cellsOf(row(effort), '6.1sol')) assert.equal(cell.fg, fgOf(f.model), `${name} ${effort}`);
          for (const cell of cellsOf(row(effort), `·${effort}`))
            assert.equal(cell.fg, fgOf(f.muted), `${name} ·${effort}`);
        }
      },
      { glyphs: 'text' }
    );
    withTheme(
      name,
      (p) => {
        const f = p.onSelectedBand;
        const { vm, keys } = tree(specs('gpt-6.1-sol'));
        const row = (effort: string) =>
          drawRaw(vm, 100, { selectedKey: keys[`e-${effort}`] }).find((r) => r.includes(`e-${effort}`))!;
        // Glyph mode: the symbol is `model`; low is `muted`, high `model`, max `warning`.
        assert.equal(cellsOf(row('low'), '★')[0].fg, fgOf(f.model));
        assert.equal(cellsOf(row('low'), '○')[0].fg, fgOf(f.muted), `${name}: low effort`);
        assert.equal(cellsOf(row('high'), '◕')[0].fg, fgOf(f.model), `${name}: high effort`);
        assert.equal(cellsOf(row('max'), '◆')[0].fg, fgOf(f.warning), `${name}: max effort keeps its meaning`);
        // Both: the words beside the symbol recede.
        setDisplayConfig({ glyphs: 'both' });
        for (const cell of cellsOf(row('high'), '6.1sol')) assert.equal(cell.fg, fgOf(f.muted), `${name}: both`);
      },
      { glyphs: 'glyph' }
    );
  }
  // Off the selection the badge is the plain palette (the table is the default one).
  withTheme(
    'latte',
    (p) => {
      const { vm } = tree(specs('gpt-6.1-sol'));
      const row = drawRaw(vm, 100).find((r) => r.includes('e-max'))!;
      assert.equal(cellsOf(row, '◆')[0].fg, fgOf(p.warning));
    },
    { glyphs: 'glyph' }
  );
});

test('selected row: the context meter is painted with the family zones (70 and 85 as ever)', () => {
  const percents = [50, 75, 90];
  const specs = percents.map((percent): NodeSpec => ({
    id: `ctx-${percent}`,
    parent: 'main',
    harness: 'codex',
    status: S.working(ago(60)),
    contextPercent: percent,
    createdAt: ago(500 - percent),
  }));
  for (const name of BAND_PALETTES) {
    withTheme(name, (p) => {
      const f = p.onSelectedBand;
      const { vm, keys } = tree(specs);
      const zones: Array<[number, (text: string) => string]> = [
        [50, f.success],
        [75, f.warning],
        [90, f.danger],
      ];
      for (const [percent, paint] of zones) {
        const row = drawRaw(vm, 100, { selectedKey: keys[`ctx-${percent}`] }).find((r) =>
          r.includes(`ctx-${percent}`)
        )!;
        const fill = cells(row).filter((cell) => cell.ch === '━' || cell.ch === '╸');
        assert.ok(fill.length >= 2, `${name} ${percent}: the fill`);
        for (const cell of fill) assert.equal(cell.fg, fgOf(paint), `${name} ${percent}%: zone hue`);
        const track = cells(row).filter((cell) => cell.ch === '─');
        for (const cell of track) assert.equal(cell.fg, fgOf(f.muted), `${name} ${percent}%: the track recedes`);
      }
      // Unselected, the same meter is the plain palette's zones.
      const plain = drawRaw(vm, 100).find((r) => r.includes('ctx-90'))!;
      assert.equal(cells(plain).find((cell) => cell.ch === '━')!.fg, fgOf(p.danger));
    });
  }
});
