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
import { renderHud } from '../../src/render/header.js';
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

test('the session timer counts days once hours stop meaning anything', () => {
  const data = makeHudData();
  const started = data.session!.startTime.getTime();
  const timer = (elapsedMs: number) =>
    stripAnsi(
      buildBarModules(data, { nowMs: started + elapsedMs, density: 'full' })
        .find((module) => module.id === 'timer')!.variants.short!
    );
  const hour = 3_600_000;
  assert.equal(timer(45_000), '45s');
  assert.equal(timer(90_000), '1m');
  assert.equal(timer(3 * hour), '3h0m');
  assert.equal(timer(27 * hour + 10 * 60_000), '1d3h');
  assert.equal(timer(9 * 24 * hour + 23 * hour), '9d23h');
  assert.equal(timer(10 * 24 * hour), '10d');
});

test('the F12 hint retires once it has nothing left to teach', () => {
  const data = makeHudData();
  const alone = makeHudData({ subagentTree: undefined, subagents: [] });
  const hint = (source: typeof data, elapsedMs: number) =>
    buildBarModules(source, { nowMs: source.session!.startTime.getTime() + elapsedMs })
      .find((module) => module.id === 'hint')!.variants;

  assert.deepEqual(hint(alone, 9 * 60_000), hint(alone, 0), 'the hint stays for the first ten minutes');
  assert.ok(hint(alone, 9 * 60_000).full, 'a new session is still being taught the key');
  assert.deepEqual(hint(alone, 11 * 60_000), {}, 'nothing to open and the key is learned');
  assert.ok(hint(data, 11 * 60_000).full, 'agents to show keep the hint on screen');
});

test('the alert survives every pane width', () => {
  // The fixture has one failed subagent, which is an observed terminal state
  // rather than an inference from silence.
  const data = makeHudData();
  for (let width = 6; width <= 200; width += 1) {
    const lines = renderHud(data, { width, showDetails: false, layout: { ...DEFAULT_LAYOUT, mode: 'compact' } });
    const text = stripAnsi(lines[0]);
    assert.ok(text.includes('!'), `width ${width} lost the alert: ${JSON.stringify(text)}`);
    assert.ok(visualWidth(lines[0]) <= width, `width ${width} overflowed`);
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
    );
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

test('model badges can be read as words instead of symbols', () => {
  const data = makeHudData();
  const previous = setDisplayConfig({ glyphs: 'text' });
  try {
    const text = stripAnsi(
      renderHud(data, { width: 160, showDetails: false, layout: { ...DEFAULT_LAYOUT, mode: 'compact' } })[0]
    );
    assert.ok(text.includes('Astra'), `expected a spelled-out model name: ${text}`);
    assert.ok(!text.includes('☀'), 'text mode should not print the symbol');
  } finally {
    setDisplayConfig(previous);
  }
});

test('quota and context keep their own labels', () => {
  const data = makeHudData();
  const text = stripAnsi(
    renderHud(data, { width: 200, showDetails: false, layout: { ...DEFAULT_LAYOUT, mode: 'compact' } })[0]
  );
  assert.ok(/Ctx/.test(text), 'context should be labelled Ctx');
  assert.ok(/Q(uota)?/.test(text), 'the rate-limit window should be labelled as quota');
  assert.ok(!/\bPlan\b/.test(text), 'Plan must no longer name the rate-limit window');
});
