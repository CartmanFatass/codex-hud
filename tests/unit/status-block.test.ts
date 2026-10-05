import test from 'node:test';
import assert from 'node:assert/strict';
import { statusCard, type StatusCard } from '../../src/render/status-block.js';
import { initialMonitorState, renderMonitor, meterText, meterRow, METER_MIN } from '../../src/render/monitor.js';
import { setLanguage } from '../../src/render/i18n.js';
import { stripAnsi, visualLength, theme, colors } from '../../src/render/colors.js';
import { displayConfig, setDisplayConfig } from '../../src/render/hud-config.js';
import { makeHudData } from '../fixtures/hud-data.js';
import type { SubagentTree } from '../../src/types.js';

const tree: SubagentTree = { rootId: 'root', nodes: [], totalCount: 0, updatedAt: new Date() };
const plain = (text: string) => stripAnsi(text);
const withGlyphs = <T>(glyphs: 'glyph' | 'text' | 'both', run: () => T): T => {
  const previous = displayConfig();
  setDisplayConfig({ glyphs });
  try { return run(); } finally { setDisplayConfig(previous); }
};

test('the card hands over parts for its edges: state, identity, the two meters, place, reset and cache', () => {
  const data = makeHudData();
  const now = data.session!.startTime.getTime() + 3_600_000;
  const card = statusCard(data, now)!;
  assert.match(plain(card.alerts[0]), /^! /, 'an alert is a body row');
  assert.equal(card.context!.percent, 42);
  assert.equal(plain(card.context!.label!), '42%');
  assert.match(plain(card.context!.tail!), /^\d+K$/, 'the window size, in whole thousands');
  assert.equal(card.context!.tick, undefined, 'no auto-compact point in the config: no tick');
  // The tightest window is the meter; the other is a reading beside it.
  assert.equal(plain(card.quota!.text), '5h 61%');
  assert.equal(plain(card.quota!.window), '5h');
  assert.equal(card.quota!.percent, 61);
  assert.equal(plain(card.others), '7d 23%');
  assert.match(plain(card.reset), /^↺/);
  assert.ok(card.reset.startsWith(theme.tick('↺').slice(0, 8)), 'the reset is the quota meter\'s scale: the tick colour');
  assert.match(plain(card.place), new RegExp(data.project.projectName));
  assert.equal(plain(card.project!), data.project.projectName);
  assert.equal(plain(card.age), '1h');
  assert.equal(statusCard(null), null);
});

test('the auto-compact point is a tick only where the config names it', () => {
  const data = makeHudData();
  const total = data.contextUsage!.total;
  const card = statusCard({ ...data, config: { ...data.config, model_auto_compact_token_limit: total * 0.9 } })!;
  assert.equal(Math.round(card.context!.tick!), 90);
  assert.equal(statusCard({ ...data, config: { ...data.config, model_auto_compact_token_limit: total * 2 } })!.context!.tick, undefined);
});

test('while it works the state is the tool, its target and the clock, with the output rate; idle drops the word with icons', () => {
  const data = makeHudData();
  const now = data.session!.startTime.getTime() + 3_600_000;
  const working = { ...data, activity: { state: 'working' as const, updatedAt: new Date(now), turnStartedAt: new Date(now - 130_000) },
    outputRate: { tokensPerSecond: 36.2, sampleMs: 5000, sampledAt: new Date(now - 1000) } };
  for (const glyphs of ['glyph', 'text'] as const) {
    const card = withGlyphs(glyphs, () => statusCard(working, now)!);
    assert.match(plain(card.state), /^▸ Edit: src\/types\.ts · 2m10s$/, glyphs);
    assert.equal(plain(card.rate), '· ~36 tok/s');
    assert.equal(card.tone, 'needs', 'a failed tool is an alert: the frame says it needs a look');
  }
  const idle = { ...data, toolActivity: undefined, subagents: [], subagentTree: undefined, activity: { state: 'idle' as const, updatedAt: new Date(now) } };
  const calm = (glyphs: 'glyph' | 'text') => withGlyphs(glyphs, () => statusCard(idle, now)!);
  assert.equal(plain(calm('glyph').state), '✓');
  assert.equal(plain(calm('text').state), '✓ Idle', 'with glyphs off the word stays');
  assert.equal(calm('glyph').rate, '', 'no rate while idle');
  assert.equal(statusCard({ ...idle, activity: { state: 'error', updatedAt: new Date(now) } }, now)!.tone, 'error');
  assert.equal(statusCard({ ...idle, stale: true }, now)!.tone, 'stale');
});

test('the cache reminder shows only in the minutes before it lapses, as a warning', () => {
  const at = Date.parse('2026-03-01T12:00:00Z');
  const data = makeHudData({ tokenUsageAt: new Date(at) });
  assert.equal(statusCard(data, at + 40 * 60_000)!.cache, '');
  assert.equal(statusCard(data, at + 27 * 60_000)!.cache, theme.warning('◷~27m'));
  assert.equal(statusCard(data, at + 3 * 60_000)!.cache, '');
});

test('a meter is a thin line: the fill in its zone colour, the bold reading at its head, the track, the tail', () => {
  const meter = { percent: 50, tail: '246K' };
  const full = meterText(meter, 30);
  assert.equal(visualLength(full.text), 30);
  assert.match(plain(full.text), /^─+50%─+─246K$/);
  // The bar is the cells the reading and tail leave; half of it is filled, ahead of the reading.
  assert.equal(plain(full.text).indexOf('50%'), Math.round((30 - 3 - 5) / 2));
  assert.ok(full.text.includes(theme.info('─'.repeat(11))), 'under 70% the fill is info');
  assert.ok(full.text.includes(theme.bold(theme.info('50%'))), 'the reading is bold, in the zone colour');
  assert.ok(full.text.includes(theme.track('─')), 'the rest is track');
  assert.ok(full.text.includes(theme.tick('246K')), 'the tail is in the tick colour');
  const opens = (paint: (s: string) => string) => paint('X').split('X')[0] + '─';
  assert.ok(meterText({ percent: 75 }, 20).text.includes(opens(theme.warning)), '70–85% is a warning');
  assert.ok(meterText({ percent: 90 }, 20).text.includes(opens(theme.error)), '85% and above is danger');
  assert.equal(plain(meterText(meter, 3 + 5 + METER_MIN - 1).text).includes('246K'), false, 'short of room the tail goes first');
  assert.equal(plain(meterText(meter, 3).text), '50%', 'at the reading\'s width, the reading alone');
  assert.equal(plain(meterText(meter, 2).text), '──', 'under it, track');
  assert.equal(plain(meterText({ percent: 0 }, 10).text), '0%────────', 'the reading rides the fill: at 0 it leads');
  const ticked = plain(meterText({ percent: 10, tick: 75 }, 24).text);
  assert.equal(ticked.indexOf('┃'), 3 + Math.round(0.75 * 21), 'a known threshold is a tick in the track');
  assert.equal(meterRow(14, 'left ', ' right', meter, 6), null, 'no room for the bar when it is asked for');
  assert.equal(visualLength(meterRow(40, 'left ', ' right', meter)!), 40);
  assert.equal(meterRow(10, 'left ', ' right'), null);
});

test('with no colour the meter stays readable: heavy fill, light track, no escapes', () => {
  const previous = displayConfig();
  setDisplayConfig({ theme: 'none' });
  try {
    const text = meterText({ percent: 50, tail: '246K' }, 30).text;
    assert.equal(text, stripAnsi(text), 'no escapes');
    assert.match(text, /^━+50%─+─246K$/);
  } finally { setDisplayConfig(previous); }
});

const card = (extra: Partial<StatusCard> = {}): StatusCard => ({
  tone: 'idle', alerts: ['! one'], state: '✓', rate: '', tasks: '', model: '☀◆', age: '2h',
  context: { percent: 40, tail: '246K' }, place: 'repo · main *', project: 'repo', branch: '· main *',
  quota: { percent: 61, window: '5h', spent: '', text: '5h 61%' },
  others: '', forecast: '', reset: '↺1h', cache: '', ...extra,
});

test('the band carries the context meter, the corner row the quota meter with its reset', () => {
  for (const lang of ['en', 'zh'] as const) {
    const previous = setLanguage(lang);
    try {
      for (const width of [32, 40, 56, 90]) {
        const frame = renderMonitor({ tree, state: { ...initialMonitorState(), statusLevel: 'status' }, width, height: 24, status: () => card() });
        const lines = frame.lines.map(plain);
        for (const line of frame.lines) assert.equal(visualLength(line), width, `${lang} ${width}: ${stripAnsi(line)}`);
        const top = lines.at(-3)!, body = lines.at(-2)!, bottom = lines.at(-1)!;
        assert.match(top, /^ ✓ (☀◆ )?(2h )?─*40%─+(─246K)? $/, `${lang} ${width}: ${top}`);
        assert.equal(body, '│ ! one'.padEnd(width), 'a gutter on the left only');
        assert.match(bottom, /^╰─ repo (· main \* )?(5h )?─*61%─+ ↺1h$/, `${lang} ${width}: ${bottom}`);
        if (width >= 56) assert.match(bottom, /^╰─ repo · main \* 5h /);
        if (width === 90) assert.match(top, /☀◆ 2h ─+40%─+─246K $/);
        assert.ok(frame.lines.at(-3)!.startsWith(theme.band(' ').slice(0, 10)), 'the band has its own background');
        assert.ok(
          !frame.controls.some(c => c.y > 0 && (c.kind === 'settings' || c.kind === 'brief')),
          'no switch or hint on the card'
        );
        assert.ok(frame.controls.some(c => c.kind === 'level' && c.y === 24 - 3 && c.width === width), 'the band steps the level');
      }
    } finally { setLanguage(previous); }
  }
});

test('a crowded row drops the age, the tail and the model before the bar; the corner row gives up the branch, then the window', () => {
  const draw = (width: number, extra: Partial<StatusCard> = {}) =>
    renderMonitor({ tree, state: { ...initialMonitorState(), statusLevel: 'status' }, width, height: 24, status: () => card(extra) }).lines.map(plain);
  const narrow = draw(26);
  assert.match(narrow.at(-3)!, /^ ✓ (☀◆ )?(2h )?─*40%─+(─246K)? $/, narrow.at(-3)!);
  assert.match(draw(24).at(-3)!, /^ ✓ (☀◆ )?─*40%─+(246K)? $/, 'the age goes before the bar');
  assert.match(draw(56, { project: 'atlas-wsl' }).at(-1)!, /^╰─ atlas-wsl · main \* 5h ─+61%─+ ↺1h$/);
  assert.match(draw(40, { project: 'atlas-wsl' }).at(-1)!, /^╰─ atlas-wsl 5h ─+61%─+ ↺1h$/, 'at 40 the branch goes first');
  assert.match(draw(30, { project: 'atlas-wsl' }).at(-1)!, /^╰─ atlas-wsl ─+61%─+ ↺1h$/, 'then the window');
  const long = draw(30, { project: 'a-very-long-project-name-indeed', branch: '' }).at(-1)!;
  assert.equal(visualLength(long), 30);
  assert.match(long, /^╰─ a-very.*….* 61% ↺1h$/, long);
  const lines = (height: number, width = 30) =>
    renderMonitor({ tree, state: initialMonitorState(), width, height, status: () => card(), session: () => ({ text: '✓', attention: false }) }).lines.map(plain);
  assert.equal(lines(12).filter(line => line.startsWith('│')).length, 0, 'a short panel keeps its agents ten rows: one line');
  assert.match(lines(12).at(-1)!, /^ ✓ .* 5h 61% $/, 'the one line carries the quota reading');
  assert.equal(lines(40).filter(line => line.startsWith('│')).length, 1);
  assert.ok(!lines(24, 20).some(line => line.startsWith('╰')), 'too narrow for a card: no card');
});

test('the gutter and corner take the state colour; the meters keep their own', () => {
  const draw = (tone: StatusCard['tone']) =>
    renderMonitor({ tree, state: { ...initialMonitorState(), statusLevel: 'status' }, width: 60, height: 40, status: () => card({ tone }) });
  const working = draw('working');
  const y = working.statusCard!.y;
  assert.ok(working.lines[y + 1].startsWith(theme.info('│ ')));
  assert.ok(working.lines[y + 2].startsWith(theme.info('╰─')));
  assert.ok(working.lines[y].includes(theme.info('X').split('X')[0] + '─'), 'the context fill keeps its zone colour');
  assert.ok(draw('error').lines[y + 2].startsWith(theme.error('╰─')));
  assert.ok(draw('needs').lines[y + 2].startsWith(theme.warning('╰─')));
  assert.ok(draw('stale').lines[y + 2].startsWith(theme.warning('╰─')));
  assert.ok(draw('idle').lines[y + 2].startsWith(colors.dim('╰─')));
  assert.match(plain(draw('needs').lines[y]), /^ ! /, 'needing the person is "!", in place of the idle glyph');
});
