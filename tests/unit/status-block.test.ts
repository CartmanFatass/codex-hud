import test from 'node:test';
import assert from 'node:assert/strict';
import { statusCard, type StatusCard } from '../../src/render/status-block.js';
import { initialMonitorState, renderMonitor, meterGap, edgeLine, METER_MIN } from '../../src/render/monitor.js';
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
  assert.equal(plain(card.quota!.label!), '5h 61%');
  assert.equal(plain(card.others), '7d 23%');
  assert.match(plain(card.reset), /^↺/);
  assert.match(plain(card.place), new RegExp(data.project.projectName));
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

test('the cache reminder is dim once lapsed, a warning only in the minutes before', () => {
  const at = Date.parse('2026-03-01T12:00:00Z');
  const data = makeHudData({ tokenUsageAt: new Date(at) });
  assert.equal(statusCard(data, at + 40 * 60_000)!.cache, colors.dim('◷~30m+'));
  assert.equal(statusCard(data, at + 27 * 60_000)!.cache, theme.warning('◷~27m'));
  assert.equal(statusCard(data, at + 3 * 60_000)!.cache, colors.dim('◷~03m'));
});

test('a meter fills its gap in proportion, giving up its tail, then its bar, then its label', () => {
  const meter = { percent: 50, paint: (s: string) => s, label: '50%', tail: '246K' };
  const full = plain(meterGap(30, meter).text);
  assert.equal(visualLength(full), 30);
  assert.match(full, /^50%━+╸?─+─246K$/);
  const bar = full.slice(3, full.length - 5);
  assert.equal([...bar].filter(ch => ch !== '─').length, Math.ceil(bar.length / 2));
  assert.equal(plain(meterGap(3 + 1 + 4 + METER_MIN - 1, meter).text).includes('246K'), false, 'short of room the tail goes first');
  assert.equal(plain(meterGap(3 + METER_MIN - 1, meter).text), '50%' + '─'.repeat(METER_MIN - 1), 'under the minimum: the label alone');
  assert.equal(plain(meterGap(2, meter).text), '──');
  const ticked = plain(meterGap(24, { ...meter, tail: undefined, label: '', tick: 75 }).text);
  assert.equal(ticked.indexOf('┃'), 18);
  const line = edgeLine(40, '╭─', '─╮', 'left', 'right', meter)!;
  assert.equal(visualLength(line.line), 40);
  assert.match(plain(line.line), /^╭─ left 50%━+╸?─+─246K right ─╮$/);
  assert.equal(edgeLine(14, '╭─', '─╮', 'left', 'right', meter, true), null, 'no room for the bar when it is asked for');
});

const card = (extra: Partial<StatusCard> = {}): StatusCard => ({
  tone: 'idle', alerts: ['! one'], state: '✓', rate: '', tasks: '', model: '☀◆', age: '2h',
  context: { percent: 40, paint: theme.success, label: '40%', tail: '246K' },
  place: 'repo · main *', quota: { percent: 61, paint: theme.success, label: '5h 61%', text: '5h 61%' },
  others: '', forecast: '', reset: '↺1h', cache: '◷~03m', ...extra,
});

test('the edges carry the meters: context on the top with the hints, quota on the bottom with reset and cache', () => {
  for (const lang of ['en', 'zh'] as const) {
    const previous = setLanguage(lang);
    try {
      for (const width of [32, 56, 90]) {
        const frame = renderMonitor({ tree, state: { ...initialMonitorState(), statusLevel: 'status' }, width, height: 24, status: () => card() });
        const lines = frame.lines.map(plain);
        for (const line of frame.lines) assert.equal(visualLength(line), width, `${lang} ${width}: ${stripAnsi(line)}`);
        const top = lines.at(-3)!, body = lines.at(-2)!, bottom = lines.at(-1)!;
        assert.match(top, /^╭─ ✓ (☀◆ )?(2h )?40%[━╸]+─+(─246K)?( , \? ─╮| ─╮)$/, `${lang} ${width}: ${top}`);
        assert.match(body, /^│ ! one +│$/);
        assert.match(bottom, /^╰─ repo · main \* 5h 61%[━╸─]+ (↺1h )?(◷~03m )?─╯$/, `${lang} ${width}: ${bottom}`);
        if (width === 90) assert.match(top, /☀◆ 2h 40%[━╸]+─+─246K , \?/);
        const control = frame.controls.find(c => c.kind === 'settings')!;
        assert.equal(control.y, 24 - 3);
        assert.equal(top.slice(control.x).replace(/^(.).*/, '$1'), ',', 'the hint opens settings');
      }
    } finally { setLanguage(previous); }
  }
});

test('a crowded edge drops the hints, the age, the model and the tail before the bar; the place is cut in the middle', () => {
  const draw = (width: number, extra: Partial<StatusCard> = {}) =>
    renderMonitor({ tree, state: { ...initialMonitorState(), statusLevel: 'status' }, width, height: 24, status: () => card(extra) }).lines.map(plain);
  const wide = draw(40);
  assert.ok(wide.at(-3)!.includes('━'));
  const narrow = draw(26);
  assert.match(narrow.at(-3)!, /^╭─ ✓ (☀◆ )?40%[━╸]+─*(─246K ─╮|─╮)$/, narrow.at(-3)!);
  const long = draw(30, { place: 'a-very-long-project-name › repo · main *' }).at(-1)!;
  assert.equal(visualLength(long), 30);
  assert.match(long, /^╰─ a-very.*….*main \* /, long);
  const lines = (height: number, width = 30) =>
    renderMonitor({ tree, state: initialMonitorState(), width, height, status: () => card(), session: () => ({ text: '✓', attention: false }) }).lines.map(plain);
  assert.equal(lines(12).filter(line => line.startsWith('│')).length, 0, 'a short panel keeps its agents ten rows: one line');
  assert.match(lines(12).at(-1)!, /^╶─ ✓ /);
  assert.equal(lines(40).filter(line => line.startsWith('│')).length, 1);
  assert.ok(!lines(24, 20).some(line => line.startsWith('╭')), 'too narrow for a frame: no card');
});

test('the frame takes the state colour; the meters keep their own', () => {
  const draw = (tone: StatusCard['tone']) =>
    renderMonitor({ tree, state: { ...initialMonitorState(), statusLevel: 'status' }, width: 60, height: 40, status: () => card({ tone }) });
  const working = draw('working');
  const y = working.statusCard!.y;
  assert.ok(working.lines[y].startsWith(theme.info('╭─')));
  assert.ok(working.lines[y + 1].startsWith(theme.info('│ ')));
  assert.ok(working.lines[y].includes(theme.success('X').split('X')[0] + '━'), 'the context fill keeps its threshold colour');
  assert.ok(draw('error').lines[y].startsWith(theme.error('╭─')));
  assert.ok(draw('needs').lines[y].startsWith(theme.warning('╭─')));
  assert.ok(draw('idle').lines[y].startsWith(colors.dim('╭─')));
});
