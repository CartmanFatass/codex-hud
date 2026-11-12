import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { OWNER_CONFIG } from '../fixtures/claude-hud-parity/fixture.js';
import { barThemeScene, THEME_NOW } from '../fixtures/bar-themes.js';
import { parityFixture } from '../fixtures/pi-footer.js';
import {
  BAR_STYLES,
  BAR_FIELDS,
  setDisplayConfig,
  resolveDisplayConfig,
  barStyleOf,
} from '../../src/render/hud-config.js';
import { renderBar, agentEvent, type BarFacts } from '../../src/render/layout/bar-fields.js';
import { stripAnsi, visualWidth } from '../../src/render/colors.js';
import { applyBarSettings } from '../../src/bar-settings.js';
import { loadSettings } from '../../src/settings.js';

const golden = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/bar-themes.json'), 'utf8'));
function scene(t: test.TestContext) {
  const previous = setDisplayConfig({ theme: 'terminal' });
  t.after(() => setDisplayConfig(previous));
  t.mock.method(Date, 'now', () => THEME_NOW);
  const f = barThemeScene();
  t.after(() => f.dispose());
  return f;
}

for (const style of BAR_STYLES)
  test(`${style}: busy 120-column golden frames, real Claude/pi/Codex paths and ribbon`, (t) => {
    const f = scene(t);
    const previous = process.env.COLORTERM;
    process.env.COLORTERM = 'truecolor';
    t.after(() => {
      if (previous === undefined) delete process.env.COLORTERM;
      else process.env.COLORTERM = previous;
    });
    const frame = f.render(style);
    assert.deepEqual(frame, golden[style]);
    assert.equal(frame.claude.length, style === 'stacked' ? 2 : 1);
    assert.equal(frame.pi.length, style === 'stacked' ? 2 : 1);
    assert.equal(frame.codex.length, 1, 'fixed-height Codex pane falls back to line for Stacked');
    for (const rows of Object.values(frame))
      for (const row of rows) assert.ok(visualWidth(row) <= 120 && !row.includes('\n'));
    assert.ok(
      stripAnsi(frame.ribbon[0]!).indexOf('other status') < stripAnsi(frame.ribbon[0]!).indexOf('example'),
      'extensions precede the ribbon'
    );
    assert.match(stripAnsi(frame.ribbon[0]!), /\$0\.420/);
    assert.doesNotMatch(frame.pi.map(stripAnsi).join(' '), /\$/);
  });

for (const style of ['micro', 'triptych'] as const)
  test(`${style}: width ladder at 160/120/80 on all clients and ribbon`, (t) => {
    const f = scene(t);
    const frames = [160, 120, 80].map((width) => f.render(style, width));
    for (const [i, frame] of frames.entries())
      for (const rows of Object.values(frame))
        for (const row of rows) assert.ok(visualWidth(row) <= [160, 120, 80][i]!);
    for (const client of ['claude', 'pi', 'codex'] as const) {
      const wide = frames[0]![client].map(stripAnsi).join(' '),
        narrow = frames[2]![client].map(stripAnsi).join(' ');
      assert.match(wide, /MCP/);
      assert.match(wide, /skills/);
      assert.ok(narrow.length > 0);
      assert.match(narrow, client === 'claude' ? /opus-5\.5/ : client === 'pi' ? /v4\.1-flash/ : /5\.6-astra/);
      assert.notEqual(wide, narrow, 'ladder changes forms, not just overflowing a fixed frame');
    }
  });

test('all six looks: NO_COLOR/theme none and unknown settings fall back to line', (t) => {
  scene(t);
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
  assert.equal(barStyleOf('unknown'), 'line');
  assert.equal(resolveDisplayConfig({ HUD_BAR_STYLE: 'unknown' }).barStyle, 'line');
  const f = parityFixture({ name: 'no-color', width: 120, env: { NO_COLOR: '1' } });
  t.after(() => f.dispose());
  setDisplayConfig({ theme: 'terminal', barStyle: 'stacked' });
  assert.equal(f.render().length, 1);
  assert.doesNotMatch(f.render()[0]! + f.top(), /\x1b/);
  assert.match(f.render()[0]!, / │ /);
});

test('all bar settings readers accept the six ids; malformed values remain line', (t) => {
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
  for (const style of [...BAR_STYLES, 'unknown']) {
    writeFileSync(file, JSON.stringify({ barStyle: style }));
    applyBarSettings();
    assert.equal(setDisplayConfig({}).barStyle, barStyleOf(style));
    assert.equal(resolveDisplayConfig({ CODEX_HUD_BAR_STYLE: style }).barStyle, barStyleOf(style));
    assert.equal(loadSettings().barStyle, barStyleOf(style));
  }
  writeFileSync(file, JSON.stringify({ barStyle: 'gauge', theme: 'none' }));
  applyBarSettings();
  assert.equal(setDisplayConfig({}).theme, 'none');
  assert.doesNotMatch(renderBar({ model: { name: 'M' } }, 80, THEME_NOW).line, /\x1b/);
  writeFileSync(file, JSON.stringify({ barStyle: 'gauge', theme: 'latte' }));
  applyBarSettings();
  assert.equal(
    setDisplayConfig({}).theme,
    resolveDisplayConfig().theme,
    'other saved palettes retain historical bar-only behaviour'
  );
});

test('Stacked survives the actual Claude statusline command as two rows', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'stacked-statusline-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ statusline: OWNER_CONFIG }));
  writeFileSync(join(home, 'hud-settings.json'), JSON.stringify({ barStyle: 'stacked' }));
  const result = spawnSync(process.execPath, [join(process.cwd(), 'bin/hud-statusline'), '--width', '120'], {
    env: {
      ...process.env,
      HOME: home,
      HUD_HOME: home,
      CLAUDE_CONFIG_DIR: home,
      HUD_SETTINGS_PATH: join(home, 'hud-settings.json'),
      NO_COLOR: '',
      HUD_THEME: 'terminal',
    },
    input: JSON.stringify({
      model: { id: 'claude-opus-5-5' },
      effort: 'high',
      cwd: join(home, 'example'),
      context_window: { used_percentage: 86, context_window_size: 400000 },
    }),
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = stripAnsi(result.stdout).trimEnd().split('\n');
  assert.equal(rows.length, 2);
  assert.match(rows[0]!, /opus-5\.5.*ctx 86%/);
  assert.match(rows[1]!, /high.*400K/);
  for (const row of rows) assert.ok(visualWidth(row) <= 120);
});

test('Tide truecolor tints by column, preserves alert backgrounds, 256 fallback has no tint', (t) => {
  const old = process.env.COLORTERM;
  t.after(() => {
    if (old === undefined) delete process.env.COLORTERM;
    else process.env.COLORTERM = old;
  });
  const previous = setDisplayConfig({ theme: 'terminal', barStyle: 'tide', barFields: [...BAR_FIELDS] });
  t.after(() => setDisplayConfig(previous));
  const facts = {
    model: { name: '模型' },
    context: { percent: 50, shown: '50%', window: 400000 },
    needs: ['needs you'],
  };
  process.env.COLORTERM = 'truecolor';
  const colored = renderBar(facts, 80, THEME_NOW).line;
  assert.match(colored, /\x1b\[48;2;21;48;58m/);
  assert.match(colored, /\x1b\[48;2;18;18;20m/);
  assert.match(colored, /\x1b\[48;5;209m/);
  assert.equal(visualWidth(colored), 80);
  process.env.COLORTERM = '';
  const fallback = renderBar(facts, 80, THEME_NOW).line;
  assert.doesNotMatch(fallback, /48;2;/);
  assert.equal(stripAnsi(fallback), stripAnsi(colored));
});

test('all six looks: needs-you remains visible, absent facts are absent, event expiry is shared', (t) => {
  const previous = setDisplayConfig({ theme: 'terminal', barFields: [...BAR_FIELDS] });
  t.after(() => setDisplayConfig(previous));
  const facts = {
    model: { name: 'M' },
    needs: ['needs you'],
    events: [agentEvent('done', { name: 'reviewer' }, THEME_NOW)],
  };
  for (const style of BAR_STYLES.slice(2)) {
    setDisplayConfig({ barStyle: style });
    const busy = stripAnsi(renderBar(facts, 80, THEME_NOW).line);
    assert.match(busy, /! needs you/);
    assert.match(busy, /reviewer/);
    assert.doesNotMatch(busy, /MCP|skills|%|\$/);
    assert.doesNotMatch(stripAnsi(renderBar(facts, 80, THEME_NOW + 180000).line), /reviewer/);
  }
});

// The concepts' colour roles and idioms (docs/reference.md "The looks"): quiet 160-column facts, one agent notice.
const conceptFacts: BarFacts = {
  model: { name: 'opus-5.5', effort: 'high', id: 'claude-opus-5-5', provider: 'anthropic' },
  context: { percent: 40, shown: '40%', window: 400000 },
  project: { name: 'example', branch: 'main', marks: '*' },
  quota: { windows: [{ label: '5h', percent: 8, reset: '1h19m' }] },
  loaded: {
    counts: [
      ['MCP', 4],
      ['skills', 1],
    ],
  },
};
function conceptRows(style: (typeof BAR_STYLES)[number], extra: Partial<BarFacts> = {}, width = 160) {
  setDisplayConfig({ barStyle: style, theme: 'terminal', barFields: [...BAR_FIELDS] });
  const line = renderBar({ ...conceptFacts, ...extra }, width, THEME_NOW).line;
  return { line, rows: line.split('\n').map(stripAnsi) };
}

test('the six looks paint with the concepts own 256-colour inks, never the terminal palette', (t) => {
  const previous = setDisplayConfig({});
  t.after(() => setDisplayConfig(previous));
  const events = [agentEvent('started', { name: 'imp', model: 'gpt-6.1-sol', effort: 'high' }, THEME_NOW - 1000)];
  for (const style of BAR_STYLES.slice(2)) {
    const { line } = conceptRows(style, { events });
    assert.doesNotMatch(line, /\x1b\[(?:[39][0-7]|2)m/, `${style} uses basic ANSI colours or dim`);
    assert.match(line, /;5;71m/, `${style}: the 40% context is the concept's green (71)`);
  }
  assert.match(
    conceptRows('gauge').line,
    /\x1b\[1m\x1b\[48;5;71m\x1b\[38;5;233m/,
    'filled plate text is bold dark on the level colour'
  );
});

test('each look keeps its concept idiom: ctx label, group order, aligned columns, flush-right vitals, leaders', (t) => {
  const previous = setDisplayConfig({});
  t.after(() => setDisplayConfig(previous));
  assert.match(
    conceptRows('tide').rows[0]!,
    /high {3}ctx 40%\/400K {3}example main\*/,
    'airy spacing and the ctx label'
  );
  const micro = conceptRows('micro').rows[0]!;
  assert.match(micro, /⋔ example main\*/);
  assert.match(micro, /↻1h19m/);
  assert.ok(micro.indexOf('example') < micro.indexOf('40%'), 'who before the meters');
  const stacked = conceptRows('stacked').rows;
  assert.equal(stacked[1]!.indexOf('high'), stacked[0]!.indexOf('opus-5.5'), 'effort under the name, past the mark');
  assert.match(stacked[1]!, /━.* 400K/);
  assert.doesNotMatch(stacked[1]!, /\/400K/);
  const headline = conceptRows('headline').rows[0]!;
  assert.match(headline, /^ {20,}✻ opus-5\.5 high/, 'quiet: the left is empty');
  assert.match(headline, /skills 1$/);
  assert.match(conceptRows('triptych').rows[0]!, /example main\* ·{5,} /);
  const needs = conceptRows('headline', { needs: ['Work: 1 needs you'] }).rows[0]!;
  assert.match(needs, /^ ! Work: 1 needs you {5,}✻ opus-5\.5/, 'the alert leads and the vitals stay flush right');
});

test('the six looks fit every width, in both light and dark', (t) => {
  const previous = setDisplayConfig({});
  t.after(() => setDisplayConfig(previous));
  const events = [
    agentEvent(
      'started',
      { name: 'frontend-implementer', model: 'claude-sonnet-5-5', effort: 'xhigh' },
      THEME_NOW - 1000
    ),
    agentEvent('done', { name: 'reviewer' }, THEME_NOW - 2000),
  ];
  const variants: Partial<BarFacts>[] = [
    { events },
    { needs: ['Work: 1 needs you'] },
    { events, needs: ['Work: 1 needs you'] },
    {},
  ];
  for (const theme of ['terminal', 'latte'] as const)
    for (const style of BAR_STYLES.slice(2))
      for (const extra of variants)
        for (let width = 1; width <= 200; width += 3) {
          setDisplayConfig({ barStyle: style, theme, barFields: [...BAR_FIELDS] });
          const rows = renderBar(
            { ...conceptFacts, context: { percent: 90, shown: '90%', window: 400000 }, ...extra },
            width,
            THEME_NOW
          ).line.split('\n');
          assert.ok(rows.length <= (style === 'stacked' ? 2 : 1));
          for (const row of rows)
            assert.ok(visualWidth(row) <= width, `${style} ${theme} ${width}: ${visualWidth(row)}`);
        }
});
