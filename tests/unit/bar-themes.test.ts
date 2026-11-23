import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { barThemeScene, THEME_NOW } from '../fixtures/bar-themes.js';
import { PI_QUOTA_SCENES } from '../fixtures/bar-widths.js';
import { parityFixture } from '../fixtures/pi-footer.js';
import {
  BAR_STYLES,
  BAR_FIELDS,
  setDisplayConfig,
  resolveDisplayConfig,
} from '../../dist/render/hud-config.js';
import { renderBar, type BarFacts } from '../../dist/render/layout/bar-fields.js';
import { colors, stripAnsi, theme, visualWidth } from '../../dist/render/colors.js';
import { applyBarSettings } from '../../dist/bar-settings.js';
import { loadSettings } from '../../dist/settings.js';

test('line and p10k fit on one row in Claude, pi and Codex and keep the same pi ribbon', (t) => {
  const previous = setDisplayConfig({ theme: 'terminal' });
  t.after(() => setDisplayConfig(previous));
  t.mock.method(Date, 'now', () => THEME_NOW);
  const f = barThemeScene();
  t.after(() => f.dispose());
  const line = f.render('line');
  const p10k = f.render('p10k');
  for (const frame of [line, p10k]) {
    for (const rows of Object.values(frame)) {
      assert.equal(rows.length, 1);
      assert.ok(visualWidth(rows[0]!) <= 120 && !rows[0]!.includes('\n'));
    }
    assert.doesNotMatch(stripAnsi(frame.pi[0]!), /\$/);
  }
  assert.deepEqual(line.ribbon, p10k.ribbon);
  const ribbon = stripAnsi(line.ribbon[0]!);
  assert.match(ribbon, /other status.*example.*\$0\.420/);
});

test('NO_COLOR and theme none fall back to line', (t) => {
  const previous = setDisplayConfig({});
  t.after(() => setDisplayConfig(previous));
  const facts: BarFacts = {
    model: { name: 'M', effort: 'high' },
    context: { percent: 88, shown: '88%', window: 400000 },
    loaded: { counts: [['MCP', 2]] },
  };
  for (const style of BAR_STYLES) {
    setDisplayConfig({ ...resolveDisplayConfig({ NO_COLOR: '1', HUD_BAR_STYLE: style }), barFields: [...BAR_FIELDS] });
    const actual = renderBar(facts, 120, THEME_NOW).line;
    setDisplayConfig({ barStyle: 'line' });
    assert.equal(actual, renderBar(facts, 120, THEME_NOW).line);
    assert.doesNotMatch(actual, /\x1b/);
    setDisplayConfig({ barStyle: style, theme: 'none' });
    assert.equal(renderBar(facts, 120, THEME_NOW).line, actual);
  }
  const f = parityFixture({ name: 'no-color', width: 120, env: { NO_COLOR: '1' } });
  t.after(() => f.dispose());
  setDisplayConfig({ theme: 'terminal', barStyle: 'p10k' });
  assert.equal(f.render().length, 1);
  assert.doesNotMatch(f.render()[0]! + f.top(), /\x1b/);
  assert.match(f.render()[0]!, / │ /);
});

test('bar settings readers keep line and p10k, and load retired or unknown styles as line', (t) => {
  const previous = setDisplayConfig({});
  t.after(() => setDisplayConfig(previous));
  const home = mkdtempSync(join(tmpdir(), 'bar-settings-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, 'hud-settings.json'),
    old = process.env.HUD_SETTINGS_PATH;
  process.env.HUD_SETTINGS_PATH = file;
  t.after(() => {
    if (old === undefined) delete process.env.HUD_SETTINGS_PATH;
    else process.env.HUD_SETTINGS_PATH = old;
  });
  assert.deepEqual(BAR_STYLES, ['line', 'p10k']);
  for (const style of ['line', 'p10k', 'gauge', 'tide', 'micro', 'stacked', 'headline', 'triptych', 'unknown']) {
    const expected = style === 'p10k' ? 'p10k' : 'line';
    writeFileSync(file, JSON.stringify({ barStyle: style }));
    applyBarSettings();
    assert.equal(setDisplayConfig({}).barStyle, expected, style);
    assert.equal(resolveDisplayConfig({ CODEX_HUD_BAR_STYLE: style }).barStyle, expected, style);
    assert.equal(loadSettings().barStyle, expected, style);
  }
  writeFileSync(file, JSON.stringify({ barStyle: 'p10k', theme: 'none' }));
  applyBarSettings();
  assert.equal(setDisplayConfig({}).theme, 'none');
  assert.doesNotMatch(renderBar({ model: { name: 'M' } }, 80, THEME_NOW).line, /\x1b/);
  writeFileSync(file, JSON.stringify({ barStyle: 'p10k', theme: 'latte' }));
  applyBarSettings();
  assert.equal(
    setDisplayConfig({}).theme,
    resolveDisplayConfig().theme,
    'other saved palettes retain historical bar-only behaviour'
  );
});

test('the bar and the pi footer take their role icons from the saved Icons setting; the Nerd Font set is the default', (t) => {
  const previous = setDisplayConfig({});
  t.after(() => setDisplayConfig(previous));
  const home = mkdtempSync(join(tmpdir(), 'bar-icons-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, 'hud-settings.json'),
    old = process.env.HUD_SETTINGS_PATH;
  process.env.HUD_SETTINGS_PATH = file;
  t.after(() => {
    if (old === undefined) delete process.env.HUD_SETTINGS_PATH;
    else process.env.HUD_SETTINGS_PATH = old;
  });
  const workers = [
    { role: 'imp', state: 'working' as const },
    { role: 'frontend-imp', state: 'working' as const },
    { role: 'sonic', state: 'working' as const },
  ];
  const zone = () => stripAnsi(renderBar({ model: { name: 'M' }, workers }, 80, THEME_NOW).line);
  assert.equal(resolveDisplayConfig({}).icons, 'nerd');
  const wanted: Record<string, string> = {
    nerd: 'M │ \uF0AD1  \uF1FC1  \uF0E71',
    unicode: 'M │ ⚒1  ✎1  ⚡1',
    text: 'M │ I1  F1  *1',
  };
  for (const [icons, line] of Object.entries(wanted)) {
    writeFileSync(file, JSON.stringify({ icons }));
    applyBarSettings();
    assert.equal(zone(), line, icons);
  }
  // A missing or unknown value is the default; the environment still decides when the file says nothing.
  writeFileSync(file, JSON.stringify({ icons: 'emoji' }));
  applyBarSettings();
  assert.equal(zone(), wanted.nerd);
  writeFileSync(file, JSON.stringify({ barStyle: 'line' }));
  process.env.HUD_ICONS = 'text';
  t.after(() => delete process.env.HUD_ICONS);
  applyBarSettings();
  assert.equal(zone(), wanted.text);
});

test('pi quota uses Claude level inks; dim and pending states stay legible without color', (t) => {
  const previous = setDisplayConfig({ theme: 'terminal', icons: 'unicode', barFields: [...BAR_FIELDS] });
  t.after(() => setDisplayConfig(previous));
  const line = (scene: keyof typeof PI_QUOTA_SCENES) => renderBar(PI_QUOTA_SCENES[scene], 120, THEME_NOW, 'line').line;
  assert.ok(line('pi-quota').includes('\x1b[94m≈43%\x1b[0m'));
  assert.ok(line('pi-quota-high').includes(theme.error('92%')));
  assert.ok(line('pi-api').includes('\x1b[95m≈$12.34\x1b[0m'));
  assert.ok(line('pi-api-high').includes(theme.error('≈$2.05')));
  assert.ok(line('pi-quota-stale').includes(colors.dim('≈43%?')));
  assert.ok(line('pi-quota-pending').includes(colors.dim('↻')));

  setDisplayConfig({ theme: 'none' });
  const stale = line('pi-quota-stale');
  const pending = line('pi-quota-pending');
  assert.doesNotMatch(stale + pending, /\x1b/);
  assert.match(stale, /7d ████░░░░░░ ≈43%\?  5h ≈11%\?(?:\s|$)/);
  assert.match(pending, /7d ████░░░░░░ ≈43% \(2d4h\)  5h ↻(?:\s|$)/);
});

test('pi quota uses the capsule form in p10k; pending alone never gets a meter', (t) => {
  const previous = setDisplayConfig({ theme: 'terminal', icons: 'unicode', barFields: [...BAR_FIELDS] });
  t.after(() => setDisplayConfig(previous));
  const capsule = stripAnsi(renderBar(PI_QUOTA_SCENES['pi-quota'], 120, THEME_NOW, 'p10k').line);
  assert.match(capsule, /7d ≈43% \(2d4h\)  5h 11%/);

  setDisplayConfig({ barFields: ['quota'] });
  const pending: BarFacts = { quota: { windows: [{ label: '5h', shown: '↻', quiet: true }] } };
  for (const style of BAR_STYLES) {
    const row = stripAnsi(renderBar(pending, 120, THEME_NOW, style).line);
    assert.match(row, /5h ↻/, style);
    assert.doesNotMatch(row, /[█░%]/, style);
  }
});
