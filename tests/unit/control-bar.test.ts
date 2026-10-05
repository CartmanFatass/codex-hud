import test from 'node:test';
import assert from 'node:assert/strict';
import { controlBar } from '../../src/render/control-bar.js';
import { initialMonitorState, type MonitorState } from '../../src/render/monitor.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { setLanguage } from '../../src/render/i18n.js';
import { stripAnsi, visualLength, theme } from '../../src/render/colors.js';

const state = (extra: Partial<MonitorState> = {}): MonitorState => ({ ...initialMonitorState(), ...extra });
const plain = (s: MonitorState, width: number, input = { brief: {}, expired: 31 }) =>
  stripAnsi(controlBar(s, input, width).line);

test('the bar: back, the tabs, then the switches, as the preview has it', () => {
  const previous = setLanguage('zh');
  try {
    assert.equal(plain(state(), 56), ' ← 主会话  1 2 3 4 5                 b‖  a+31  ,设置  ? ');
    assert.equal(plain(state({ tree: { ...initialMonitorState().tree, showAll: true } }), 56).includes(' a−31 '), true);
    assert.equal(
      plain(state(), 56, { brief: { paused: true }, expired: 0 })
        .trimEnd()
        .endsWith('b▸  ,设置  ?'),
      true
    );
    assert.ok(!plain(state(), 56, { expired: 0 } as never).includes('b'), 'no brief configured, no switch');
  } finally {
    setLanguage(previous);
  }
});

test('short of room: the words go, then closed tabs, then a+N; ←, "," and "?" stay', () => {
  const previous = setLanguage('zh');
  try {
    const s = state({ modes: { ...initialMonitorState().modes, timeline: 'open' } });
    assert.equal(plain(s, 40), ' ← 主会话  1 2 3 4 5     b‖  a+31  ,  ? ');
    assert.equal(plain(s, 32), ' ← 主会话  1 5   b‖  a+31  ,  ? ');
    assert.equal(plain(s, 28), ' ← 主会话  1 5     b‖  ,  ? ');
    assert.equal(plain(s, 24), ' ← 主会话  1 5   b‖ , ? ');
    for (let width = 1; width <= 90; width++) {
      const bar = controlBar(s, { brief: {}, expired: 31 }, width);
      assert.equal(visualLength(bar.line), width, `${width}: ${stripAnsi(bar.line)}`);
      const text = stripAnsi(bar.line);
      if (width >= 10) assert.match(text, /←.*,.*\?/, `${width}: ${text}`);
      for (const c of bar.controls) assert.ok(c.y === 0 && c.x >= 0 && c.x + c.width <= width, `${width}: ${c.kind}`);
    }
  } finally {
    setLanguage(previous);
  }
});

test('each control sits on what it names', () => {
  const s = state({ modes: { ...initialMonitorState().modes, worktrees: 'folded' } });
  const bar = controlBar(s, { brief: {}, expired: 3 }, 56);
  const text = stripAnsi(bar.line);
  const at = (kind: string, pane?: string) => {
    const c = bar.controls.find((c) => c.kind === kind && (!pane || c.pane === pane))!;
    return text.slice(c.x, c.x + c.width);
  };
  assert.equal(at('main'), ' ← Main session');
  assert.equal(at('tab', 'agents'), '1');
  assert.equal(at('tab', 'timeline'), '5');
  assert.equal(at('brief'), 'b‖');
  assert.equal(at('older'), 'a+3');
  assert.equal(at('settings'), ',Settings');
  assert.equal(at('help'), '?');
});

test('the tabs: focused on its own surface, folded underlined, closed dim; without colour only the panes there are', () => {
  const previous = setDisplayConfig({ theme: 'terminal' });
  try {
    const s = state({
      focus: 'agents',
      modes: { ...initialMonitorState().modes, worktrees: 'folded', changes: 'open' },
    });
    const line = controlBar(s, { expired: 0 }, 56).line;
    assert.ok(line.includes(theme.tab(theme.bold(theme.value('1'))).split('1')[0] + '1'), 'focused on its own surface');
    assert.ok(line.includes('\x1b[4m'), 'a folded tab is underlined');
    assert.ok(line.includes(theme.track('4')), 'a closed tab is dim');
    assert.ok(line.includes(theme.value('3')), 'an open tab in the text colour');
    setDisplayConfig({ theme: 'none' });
    assert.match(
      stripAnsi(controlBar(s, { expired: 0 }, 56).line),
      /^ ← Main session {2}\[1\] 2- 3 +,Settings {2}\? $/
    );
    const plainBar = controlBar(s, { expired: 0 }, 56);
    const folded = plainBar.controls.find((c) => c.kind === 'tab' && c.pane === 'worktrees')!;
    assert.equal(
      stripAnsi(plainBar.line).slice(folded.x, folded.x + folded.width),
      '2-',
      'each tab is clicked where it is drawn'
    );
    const focusedFolded = controlBar({ ...s, focus: 'worktrees' }, { expired: 0 }, 56);
    assert.match(stripAnsi(focusedFolded.line), /^ ← Main session {2}1 \[2-\] 3 /, 'focused and folded at once');
  } finally {
    setDisplayConfig(previous);
  }
});

test('with glyphs set to text the switches say what they do', () => {
  const previous = setDisplayConfig({ glyphs: 'text' });
  try {
    const text = plain(state(), 90, { brief: { paused: true }, expired: 2 });
    assert.match(text, / b resume {2}a \+2 older {2},Settings {2}\? $/);
  } finally {
    setDisplayConfig(previous);
  }
});
