/**
 * How the bar gives up space.
 *
 * The rule being defended: shorten the least important field first, hide only
 * when there is nothing left to shorten, and never hide an alert.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fitModules, type BarModule } from '../../src/render/layout/engine.js';
import { buildBarModules } from '../../src/render/layout/bar-modules.js';
import { fitStatusBar, renderHud } from '../../src/render/header.js';
import { stripAnsi, visualWidth } from '../../src/render/colors.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { DEFAULT_LAYOUT } from '../../src/types.js';
import { makeHudData, makeSubagentTree, FIXED_NOW } from '../fixtures/hud-data.js';

const SEP = ' | ';

function mod(id: string, priority: number, full: string, short?: string, min?: string, pinned = false): BarModule {
  return { id, priority, pinned, variants: { full, short, min } };
}

test('the least important field shortens first', () => {
  const modules = [
    mod('high', 90, 'HIGH-FULL', 'HF'),
    mod('low', 10, 'LOW-FULL', 'LF'),
  ];
  const wide = fitModules(modules, { width: 40, separator: SEP });
  assert.equal(wide.line, 'HIGH-FULL | LOW-FULL');

  const tight = fitModules(modules, { width: 15, separator: SEP });
  assert.equal(tight.levels.low, 'short');
  assert.equal(tight.levels.high, 'full');
});

test('everything shortens before anything is hidden', () => {
  const modules = [
    mod('a', 90, 'AAAAAAAA', 'AA'),
    mod('b', 50, 'BBBBBBBB', 'BB'),
    mod('c', 10, 'CCCCCCCC', 'CC'),
  ];
  const result = fitModules(modules, { width: 14, separator: SEP });
  assert.deepEqual(result.kept, ['a', 'b', 'c']);
  assert.equal(result.line, 'AA | BB | CC');
});

test('hiding starts at the bottom of the priority order', () => {
  const modules = [
    mod('a', 90, 'AAAA'),
    mod('b', 50, 'BBBB'),
    mod('c', 10, 'CCCC'),
  ];
  const result = fitModules(modules, { width: 11, separator: SEP });
  assert.deepEqual(result.kept, ['a', 'b']);
});

test('a pinned field is shortened but never hidden', () => {
  const modules = [
    mod('alert', 100, '! two things failed', '! failed', '!', true),
    mod('noise', 10, 'NOISE-FULL', 'NOISE'),
  ];
  const result = fitModules(modules, { width: 3, separator: SEP });
  assert.deepEqual(result.kept, ['alert']);
  assert.equal(stripAnsi(result.line), '!');
});

test('fields in one group sit closer than fields in different groups', () => {
  const modules: BarModule[] = [
    { id: 'a', priority: 90, group: 'who', variants: { full: 'AAA' } },
    { id: 'b', priority: 80, group: 'who', variants: { full: 'BBB' } },
    { id: 'c', priority: 70, group: 'load', variants: { full: 'CCC' } },
  ];
  assert.equal(fitModules(modules, { width: 40, separator: SEP }).line, 'AAA  BBB | CCC');
  assert.equal(
    fitModules(modules, { width: 40, separator: SEP, groupSeparator: '' }).line,
    'AAABBB | CCC'
  );
  // The width accounting has to agree with the joining, or the bar hides a
  // field it had room for.
  assert.deepEqual(fitModules(modules, { width: 14, separator: SEP }).kept, ['a', 'b', 'c']);
  assert.deepEqual(fitModules(modules, { width: 13, separator: SEP }).kept, ['a', 'b']);
});

test('a right-aligned cluster ends at the last column, and gives that up before it clips', () => {
  const modules: BarModule[] = [
    { id: 'left', priority: 90, variants: { full: 'LEFT' } },
    { id: 'clock', priority: 30, group: 'meta', align: 'right', variants: { full: '12m' } },
    { id: 'hint', priority: 10, group: 'meta', align: 'right', variants: { full: 'F12' } },
  ];
  const wide = fitModules(modules, { width: 20, separator: SEP });
  assert.equal(wide.line, 'LEFT        12m  F12');
  assert.equal(visualWidth(wide.line), 20, 'the cluster must finish on the last column');
  assert.equal(wide.clipped, false);

  // At exactly the natural width the gap is the separator's own width, so the
  // divider gives way to the spaces rather than the line overflowing.
  const exact = fitModules(modules, { width: 15, separator: SEP });
  assert.equal(exact.line, 'LEFT   12m  F12');
  assert.equal(visualWidth(exact.line), 15);

  // One column less and the cluster gives up its least important member
  // rather than clipping the line.
  const tight = fitModules(modules, { width: 14, separator: SEP });
  assert.deepEqual(tight.kept, ['left', 'clock']);
  assert.equal(visualWidth(tight.line), 14);
});

test('the bar spends no column on a key hint', () => {
  for (const density of ['focus', 'balanced', 'full'] as const) {
    const modules = buildBarModules(makeHudData(), { density });
    assert.ok(!modules.some((module) => module.id === 'hint'), density);
    assert.doesNotMatch(modules.map((module) => module.variants.full ?? '').join(' '), /F12/);
  }
});

test('the alert survives every pane width', () => {
  // The fixture has one failed subagent, which is an observed terminal state
  // rather than an inference from silence.
  const data = makeHudData();
  for (let width = 6; width <= 200; width += 1) {
    const fit = fitStatusBar(data, { ...DEFAULT_LAYOUT, mode: 'compact' }, width);
    assert.ok(fit.kept.includes('attention'), `width ${width} lost the alert: ${JSON.stringify(stripAnsi(fit.line))}`);
    assert.ok(stripAnsi(fit.line).includes('✗'), `width ${width} lost the failure mark`);
    assert.ok(visualWidth(fit.line) <= width, `width ${width} overflowed`);
  }
});

test('a pending approval is the alert the narrow bar keeps', () => {
  // A session that asks for its first approval has not reported tokens, a
  // quota window, a plan or an agent yet, so every one of those fields is
  // absent and 40 columns is enough for the phrase itself.
  const data = makeHudData({
    toolActivity: undefined,
    subagentTree: makeSubagentTree([]),
    subagents: [],
    rateLimits: undefined,
    contextUsage: undefined,
    tokenUsage: undefined,
    planProgress: undefined,
    pendingApproval: {
      kind: 'exec',
      callId: 'call_exec_2',
      since: FIXED_NOW,
      summary: 'git push --force',
    },
  });
  const line = renderHud(data, {
    width: 40,
    showDetails: false,
    layout: { ...DEFAULT_LAYOUT, mode: 'compact' },
  })[0];
  const text = stripAnsi(line);
  assert.ok(text.includes('! approval needed'), `40 columns lost the approval: ${JSON.stringify(text)}`);
  assert.ok(visualWidth(line) <= 40, '40 columns overflowed');

  // The other kinds keep their own words rather than all reading "approval".
  const label = (kind: 'patch' | 'input') =>
    stripAnsi(
      buildBarModules({ ...data, pendingApproval: { kind, since: FIXED_NOW } }, { nowMs: FIXED_NOW.getTime() })
        .find((module) => module.id === 'attention')!.variants.short!
    ).trim();
  assert.equal(label('patch'), '! patch approval needed');
  assert.equal(label('input'), '! input needed');
});

test('a session with nothing wrong shows no alert', () => {
  const data = makeHudData({
    subagentTree: makeSubagentTree([
      { id: 'a1', name: 'explorer', status: 'running', startedAt: FIXED_NOW, model: 'gpt-5.6-astra', effort: 'high' },
    ]),
    toolActivity: undefined,
    rateLimits: undefined,
  });
  const modules = buildBarModules(data, { nowMs: FIXED_NOW.getTime() });
  const attention = modules.find((module) => module.id === 'attention');
  assert.deepEqual(attention?.variants, {});
});

test('density presets decide which fields are eligible', () => {
  const data = makeHudData();
  const ids = (density: 'focus' | 'balanced' | 'full') =>
    buildBarModules(data, { density, nowMs: FIXED_NOW.getTime() }).map((module) => module.id);

  assert.ok(!ids('focus').includes('quota'), 'focus should drop the quota field');
  assert.ok(!ids('focus').includes('tokens'), 'focus should drop the token field');
  assert.ok(ids('focus').includes('attention'), 'focus must keep alerts');
  assert.ok(ids('balanced').includes('quota'), 'balanced should show quota');
  assert.ok(!ids('balanced').includes('session'), 'balanced should drop the session id');
  assert.ok(ids('full').includes('session'), 'full should show the session id');
  assert.ok(ids('full').includes('environment'), 'full should show the environment');
});

test('themes repaint without changing the text', () => {
  const data = makeHudData();
  const render = () =>
    stripAnsi(renderHud(data, { width: 120, showDetails: false, layout: { ...DEFAULT_LAYOUT, mode: 'compact' } })[0]);
  const raw = () =>
    renderHud(data, { width: 120, showDetails: false, layout: { ...DEFAULT_LAYOUT, mode: 'compact' } })[0];

  const previous = setDisplayConfig({ theme: 'terminal' });
  try {
    const terminalText = render();

    setDisplayConfig({ theme: 'mocha' });
    assert.equal(render(), terminalText, 'a theme swap must not change the words');
    assert.ok(raw().includes('\x1b[38;2;'), 'mocha should emit truecolor');

    setDisplayConfig({ theme: 'none' });
    assert.equal(render(), terminalText, 'no-colour must not change the words');
    assert.ok(!raw().includes('\x1b['), 'the no-colour theme must emit no escapes');
  } finally {
    setDisplayConfig(previous);
  }
});

test('the bar names the model and its effort in words, whatever the badge setting', () => {
  const data = makeHudData();
  for (const glyphs of ['glyph', 'both', 'text'] as const) {
    const previous = setDisplayConfig({ glyphs });
    try {
      const text = stripAnsi(
        renderHud(data, { width: 200, showDetails: false, layout: { ...DEFAULT_LAYOUT, mode: 'compact' } })[0]
      );
      assert.ok(text.startsWith('gpt-5.6-astra xhigh │ '), `${glyphs}: ${text}`);
      assert.ok(!text.includes('☀'), `${glyphs}: the bar prints no symbol for the model`);
    } finally {
      setDisplayConfig(previous);
    }
  }
});

test('the bar reads without gaps up to the notice zone, and what Codex loaded sits at the right edge', () => {
  const calm = makeHudData({ project: { ...makeHudData().project, skillsCount: 10, hooksCount: 1 },
    subagentTree: makeSubagentTree([{ id: 'a1', name: 'explorer', status: 'running', startedAt: FIXED_NOW, model: 'gpt-5.6-astra', effort: 'high' }]),
    activity: { state: 'working', updatedAt: FIXED_NOW, turnStartedAt: FIXED_NOW },
    outputRate: { tokensPerSecond: 57.3, sampleMs: 4000, sampledAt: FIXED_NOW } });
  const fit = fitStatusBar(calm, { ...DEFAULT_LAYOUT, mode: 'compact' }, 200);
  assert.deepEqual(fit.kept, ['identity', 'context', 'project', 'quota', 'activity', 'speed', 'agents', 'tasks', 'notice', 'config']);
  const text = stripAnsi(fit.line);
  assert.match(text, /^gpt-5\.6-astra xhigh │ ━+─+ 114\.2K\/272K │ codex-hud main\*↑2 │ 5h 61% │ ▸ +\S+ │  57 tok\/s │ Agents 1▸ │ Tasks 2\/5 │ Edit src\/types\.ts {3,}MCP 2  skills 10  hooks 1$/);
  assert.ok(!/Ctx|Q61|\bPlan\b|◷/.test(text), text);
  assert.equal(visualWidth(fit.line), 200);

  // An alert takes the zone's front, and the tool at work keeps what room is left.
  const alert = stripAnsi(fitStatusBar(makeHudData({ activity: calm.activity }), { ...DEFAULT_LAYOUT, mode: 'compact' }, 170).line);
  assert.match(alert, /│ Tasks 2\/5 │  ✗ [^│]*failed {3}Edit src\/types\.ts/);
  // The zone keeps its room before what Codex loaded keeps its place.
  const noticed = makeHudData({ activity: calm.activity, project: calm.project, outputRate: calm.outputRate,
    notices: [{ kind: 'agent-done', subject: 'streaming_docs', at: new Date(FIXED_NOW.getTime() - 12_000) }] });
  const roomy = fitModules(buildBarModules(noticed, { nowMs: FIXED_NOW.getTime(), density: 'balanced' }), { width: 200, separator: ' │ ', groupSeparator: '  ' });
  assert.ok(!roomy.kept.includes('config'), roomy.kept.join(' '));
  assert.match(stripAnsi(roomy.line), /failed {3}✓ streaming_docs finished · 12s ago$/);
});

test('fields that change while the session runs keep their columns', () => {
  const start = FIXED_NOW.getTime();
  const frame = (seconds: number, tool: string | null, rate: number) => {
    const now = start + seconds * 1000;
    const data = makeHudData({
      activity: { state: 'working', updatedAt: new Date(now), turnStartedAt: new Date(start) },
      outputRate: { tokensPerSecond: rate, sampleMs: 4000, sampledAt: new Date(now - 1000) },
      toolActivity: { ...makeHudData().toolActivity!, recentCalls: tool ? [{ id: 't', name: tool, target: 'src/render/header.ts', status: 'running', timestamp: new Date(now) }] : [] },
      // Before the turn's first call, the zone tells how the last turn went.
      notices: [{ kind: 'turn-done', durationMs: 90_000, at: new Date(start - 600_000) }],
    });
    const fit = fitModules(buildBarModules(data, { nowMs: now }), { width: 170, separator: ' │ ', groupSeparator: '  ' });
    return { levels: fit.levels, columns: fit.segments.map((segment) => [segment.id, segment.x]) };
  };
  const first = frame(55, 'Edit', 9.8);
  for (const later of [frame(61, 'exec_command', 103.6), frame(125, null, 57.3), frame(601, 'apply_patch', 8), frame(3605, 'Read', 140.2)]) {
    const { notice: _later, ...laterLevels } = later.levels;
    const { notice: _first, ...firstLevels } = first.levels;
    assert.deepEqual(laterLevels, firstLevels);
    // The notice zone changes with the tool; every field before it, and the right cluster, stays put.
    assert.deepEqual(later.columns.filter(([id]) => id !== 'notice'), first.columns.filter(([id]) => id !== 'notice'));
  }
});
