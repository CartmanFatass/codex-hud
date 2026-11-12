import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageFixture, TREE, NOW } from '../fixtures/kept-pages.mjs';
import { projectFixture } from '../fixtures/project-page.mjs';
import { renderMonitor } from '../../dist/render/monitor.js';
import { THEMES, setDisplayConfig, resolveDisplayConfig, isLightTheme } from '../../dist/render/hud-config.js';
import { palette, workboardPalette, paletteNames } from '../../dist/render/palette.js';
import { SETTING_ROWS } from '../../dist/render/settings-page.js';
import { setLanguage, t as say } from '../../dist/render/i18n.js';
import { defaultSettings, loadSettings, saveSettings } from '../../dist/settings.js';

const COLOUR = THEMES.filter((name) => name !== 'none');
const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** The colour a paint puts down: `38` for its text, `48` for its background. */
const colourOf = (paint, plane) => paint('x').match(new RegExp(`${plane};2;(\\d+);(\\d+);(\\d+)`))?.slice(1).map(Number);
const asTheme = (theme, fn) => {
  const previous = setDisplayConfig({ theme, icons: 'unicode' });
  try {
    return fn();
  } finally {
    setDisplayConfig(previous);
  }
};

/** Home, an Inspector card and Project, each painted in `theme`. */
async function frames(t) {
  const root = mkdtempSync(join(tmpdir(), 'themes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const kept = pageFixture(join(root, 'kept')), project = await projectFixture(join(root, 'project'));
  const draw = (page, theme) =>
    asTheme(theme, () =>
      renderMonitor({
        tree: TREE,
        workboard: kept.board,
        worktrees: kept.worktrees,
        state: { ...kept.states[page], tree: { ...kept.states[page].tree }, scroll: { ...kept.states[page].scroll } },
        width: 90,
        height: 40,
        modelEnabled: true,
        embedded: true,
        mouse: true,
        nowMs: NOW,
      }).lines.join('\n')
    );
  return (theme) => ({
    home: draw('home', theme),
    inspector: draw('asking', theme),
    project: project.render(90, 'en', undefined, 56, project.data, true, 'unicode', theme).lines.join('\n'),
  });
}

test('every theme paints Home, Project and the Inspector differently; none emits no escape', async (t) => {
  const draw = await frames(t);
  const seen = new Map(COLOUR.map((theme) => [theme, draw(theme)]));
  for (const page of ['home', 'inspector', 'project'])
    assert.equal(new Set(COLOUR.map((theme) => seen.get(theme)[page])).size, COLOUR.length, `${page}: ${COLOUR}`);
  // The surfaces and the active ink are what tell a board apart, so no two themes may share them.
  const surfaces = COLOUR.map((theme) =>
    asTheme(theme, () => {
      const board = workboardPalette();
      return [board.title('x'), board.body('x'), board.selected('x'), board.active('x')].join('|');
    })
  );
  assert.equal(new Set(surfaces).size, COLOUR.length);
  for (const [page, text] of Object.entries(draw('none'))) assert.doesNotMatch(text, /\x1b/, page);
});

test('the board of every theme reads: ink on every surface, the question header, and the palette on its selected row', () => {
  for (const theme of COLOUR)
    asTheme(theme, () => {
      const board = workboardPalette(), plain = palette();
      const surfaces = {
        title: colourOf(board.title, 48),
        body: colourOf(board.body, 48),
        failed: colourOf(board.failedBody, 48),
        question: colourOf(board.slab, 48),
        selected: colourOf(board.selected, 48),
      };
      for (const [name, surface] of Object.entries(surfaces)) assert.ok(surface, `${theme} ${name} is a surface`);
      const text = colourOf(board.text, 38);
      for (const ink of ['muted', 'attention', 'danger', 'success', 'active', 'stalled', 'identifier', 'opinion', 'text']) {
        const colour = ink === 'text' ? text : colourOf(board[ink], 38);
        // A theme without a pinned text keeps the terminal's own.
        if (!colour && ink === 'text' && theme === 'terminal') continue;
        assert.ok(colour, `${theme} ${ink}`);
        for (const [name, surface] of Object.entries(surfaces)) {
          const floor = name === 'selected' ? 3 : name === 'title' || name === 'body' ? 4.5 : 4;
          assert.ok(contrast(colour, surface) >= floor, `${theme}: ${ink} on ${name} is ${contrast(colour, surface).toFixed(2)}`);
        }
      }
      const ask = board.askTitle('x');
      assert.ok(contrast(colourOf(() => ask, 38), colourOf(() => ask, 48)) >= 4.5, `${theme}: the ask header reads`);
      assert.ok(contrast(colourOf(board.frame, 38), surfaces.body) >= 1.5, `${theme}: the rules show on the body`);
      // The bars' and Settings' selected row: the family ink meets its floors on the band it sits on.
      const band = colourOf(plain.selectedBand, 48);
      if (!band) return;
      const on = plain.onSelectedBand;
      assert.ok(contrast(colourOf(on.text, 38), band) >= 4.5, `${theme}: text on the selected band`);
      assert.ok(contrast(colourOf(on.muted, 38), band) >= 3, `${theme}: muted on the selected band`);
      for (const role of ['accent', 'success', 'warning', 'danger', 'info', 'model'])
        assert.ok(contrast(colourOf(on[role], 38), band) >= 3, `${theme}: ${role} on the selected band`);
      for (const [role, ink] of Object.entries(on.roleInk))
        assert.ok(contrast(colourOf(ink, 38), band) >= 3, `${theme}: ${role} on the selected band`);
    });
});

test('Settings offers every theme, named in English and in Chinese; env, saved settings and light bars follow', (t) => {
  const row = SETTING_ROWS.find((r) => r.key === 'theme');
  assert.deepEqual([...row.values], [...THEMES]);
  assert.deepEqual([...paletteNames()].sort(), [...THEMES].sort());
  assert.ok(THEMES.length >= 8, 'terminal, titanium, mocha, latte, none and three or four new ones');
  const previous = setLanguage('zh');
  t.after(() => setLanguage(previous));
  for (const name of THEMES) assert.notEqual(say(name), name, `${name} has a Chinese name`);
  setLanguage('en');
  for (const name of THEMES) assert.equal(say(name), name);
  const home = mkdtempSync(join(tmpdir(), 'themes-settings-')), env = { ...process.env };
  t.after(() => {
    process.env = env;
    rmSync(home, { recursive: true, force: true });
  });
  process.env.HUD_SETTINGS_PATH = join(home, 'settings.json');
  for (const name of THEMES) {
    saveSettings({ theme: name });
    assert.equal(loadSettings().theme, name);
    assert.equal(resolveDisplayConfig({ HUD_THEME: name }).theme, name === 'none' ? 'none' : name);
  }
  saveSettings({ theme: 'nord' });
  assert.equal(loadSettings().theme, 'none', 'an unknown theme is refused and the last valid one kept');
  assert.equal(resolveDisplayConfig({ HUD_THEME: 'nord' }).theme, defaultSettings().theme);
  assert.equal(resolveDisplayConfig({ HUD_THEME: 'paper', NO_COLOR: '1' }).theme, 'none');
  for (const name of THEMES)
    asTheme(name, () => assert.equal(isLightTheme(), name === 'latte' || name === 'paper'));
});
