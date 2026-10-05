import test from 'node:test';
import assert from 'node:assert/strict';
import { controlBar, SETTINGS_ICON } from '../../src/render/control-bar.js';
import { initialMonitorState, type MonitorState } from '../../src/render/monitor.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { setLanguage } from '../../src/render/i18n.js';
import { stripAnsi, visualLength, theme, colors } from '../../src/render/colors.js';

const state = (extra: Partial<MonitorState> = {}): MonitorState => ({ ...initialMonitorState(), ...extra });
const plain = (s: MonitorState, width: number, input = { brief: {}, expired: 31 }) =>
  stripAnsi(controlBar(s, input, width).line);
const inChinese = <T>(run: () => T): T => {
  const previous = setLanguage('zh');
  try {
    return run();
  } finally {
    setLanguage(previous);
  }
};

/** What round 2 drew as keys: b‖, a+31, ",设置", the tabs' digits. */
const KEY_LETTERS = /b‖|b▸|a[+−]\d|,(设置|Settings)?\s|\b[1-5] [1-5]\b/;

test('the bar is buttons: words where they fit, never a key', () => {
  inChinese(() => {
    assert.equal(plain(state(), 56), ' ← 主会话  ▦ ⎇ ± ⌖ ⋮        ‖ 简报 +31 已收起 设置 帮助 ');
    assert.equal(
      plain(state(), 92).trim().startsWith('← 主会话    卡片   工作树'),
      true,
      'tab names where there is room'
    );
    assert.ok(plain(state({ tree: { ...initialMonitorState().tree, showAll: true } }), 56).includes(' 收起 设置'));
    assert.ok(
      plain(state(), 56, { brief: { paused: true }, expired: 0 })
        .trimEnd()
        .endsWith('▸ 简报 设置 帮助')
    );
    assert.ok(!plain(state(), 56, { expired: 0 } as never).includes('简报'), 'no brief configured, no button');
  });
  assert.equal(plain(state(), 56), ' ← Main  ▦ ⎇ ± ⌖ ⋮      ‖ Brief +31 older Settings Help ');
  for (const width of [32, 40, 56, 90]) {
    for (const lang of ['en', 'zh'] as const) {
      const previous = setLanguage(lang);
      try {
        const text = plain(state(), width);
        assert.doesNotMatch(text, KEY_LETTERS, `${lang} ${width}: ${text}`);
      } finally {
        setLanguage(previous);
      }
    }
  }
});

test('short of room: tab names, then the other words become icons, then closed tabs and older go; ←, settings and help stay', () => {
  inChinese(() => {
    const s = state({ modes: { ...initialMonitorState().modes, timeline: 'open' } });
    assert.equal(plain(s, 40), ' ← 主会话  ▦ ⎇ ± ⌖ ⋮    ‖ +31 设置 帮助 ');
    assert.equal(plain(s, 32), ' ←  ▦ ⎇ ± ⌖ ⋮   ‖ +31 设置 帮助 ');
    assert.equal(plain(s, 28), ` ←  ▦ ⎇ ± ⌖ ⋮     ‖ +31 ${SETTINGS_ICON} ? `);
    assert.equal(plain(s, 22), ` ←  ▦ ⋮     ‖ +31 ${SETTINGS_ICON} ? `);
    assert.equal(plain(s, 18), ` ←  ▦ ⋮     ‖ ${SETTINGS_ICON} ? `);
    for (let width = 1; width <= 100; width++) {
      const bar = controlBar(s, { brief: {}, expired: 31 }, width);
      assert.equal(visualLength(bar.line), width, `${width}: ${stripAnsi(bar.line)}`);
      const text = stripAnsi(bar.line);
      if (width >= 12) assert.match(text, /←.*(☰|设置).*(\?|帮助)/, `${width}: ${text}`);
      for (const c of bar.controls) assert.ok(c.y === 0 && c.x >= 0 && c.x + c.width <= width, `${width}: ${c.kind}`);
    }
  });
});

test('each control sits on what it names', () => {
  const s = state({ modes: { ...initialMonitorState().modes, worktrees: 'folded' } });
  for (const width of [32, 56, 100]) {
    const bar = controlBar(s, { brief: {}, expired: 3 }, width);
    const text = stripAnsi(bar.line);
    const at = (kind: string, pane?: string) => {
      const c = bar.controls.find((c) => c.kind === kind && (!pane || c.pane === pane))!;
      return text.slice(c.x, c.x + c.width).trim();
    };
    const wide = width === 100;
    assert.equal(at('main'), width === 32 ? '←' : '← Main', `${width}`);
    assert.equal(at('tab', 'agents'), wide ? 'Agents' : '▦');
    assert.equal(at('tab', 'timeline'), wide ? 'Timeline' : '⋮');
    assert.equal(at('brief'), width === 32 ? '‖' : '‖ Brief');
    assert.equal(at('older'), width === 32 ? '+3' : '+3 older');
    assert.equal(at('settings'), width === 32 ? SETTINGS_ICON : 'Settings');
    assert.equal(at('help'), width === 32 ? '?' : 'Help');
  }
});

test('the tabs: focused on its own surface, folded underlined, closed dim, every one a chip; without colour only the panes there are', () => {
  const previous = setDisplayConfig({ theme: 'terminal' });
  try {
    const s = state({
      focus: 'agents',
      modes: { ...initialMonitorState().modes, worktrees: 'folded', changes: 'open' },
    });
    const line = controlBar(s, { expired: 0 }, 56).line;
    // A chip's surface, then the face's own paint (the bar re-applies its own after each reset).
    const on = (surface: (s: string) => string, face: string) => surface(face).split('\x1b[0m')[0];
    assert.ok(line.includes(on(theme.tab, theme.bold(theme.value('▦')))), 'focused on its own surface');
    assert.ok(line.includes(on(theme.chip, '\x1b[4m' + colors.dim('⎇'))), 'a folded tab is underlined');
    assert.ok(line.includes(on(theme.chip, colors.dim('⌖'))), 'a closed tab is dim');
    assert.ok(line.includes(on(theme.chip, theme.value('±'))), 'an open tab in the text colour');
    assert.ok(line.includes(on(theme.chip, theme.value('Settings'))), 'a button is a chip');
    setDisplayConfig({ theme: 'none' });
    assert.match(
      stripAnsi(controlBar(s, { expired: 0 }, 56).line),
      /^ ← Main {2}\[Agents\] Trees- Changes +Settings Help $/
    );
    assert.match(stripAnsi(controlBar(s, { expired: 0 }, 40).line), /^ ← Main {2}\[▦\] ⎇- ± +Settings Help $/);
    const plainBar = controlBar(s, { expired: 0 }, 40);
    const folded = plainBar.controls.find((c) => c.kind === 'tab' && c.pane === 'worktrees')!;
    assert.equal(
      stripAnsi(plainBar.line).slice(folded.x, folded.x + folded.width),
      '⎇-',
      'each tab is clicked where it is drawn'
    );
    const focusedFolded = controlBar({ ...s, focus: 'worktrees' }, { expired: 0 }, 40);
    assert.match(stripAnsi(focusedFolded.line), /^ ← Main {2}▦ \[⎇-\] ± /, 'focused and folded at once');
    assert.equal(
      controlBar(s, { expired: 0 }, 56).line,
      stripAnsi(controlBar(s, { expired: 0 }, 56).line),
      'no escapes'
    );
  } finally {
    setDisplayConfig(previous);
  }
});

test('with glyphs set to text the bar is the same buttons', () => {
  const previous = setDisplayConfig({ glyphs: 'text' });
  try {
    const text = plain(state(), 90, { brief: { paused: true }, expired: 2 });
    assert.match(text, / ▸ Brief \+2 older Settings Help $/);
  } finally {
    setDisplayConfig(previous);
  }
});

test('the help is a modal with a [Back] button; the settings page names only its moves, its buttons the rest', async () => {
  const { renderMonitor, handleMonitorInput } = await import('../../src/render/monitor.js');
  const { renderSettingsPage } = await import('../../src/render/settings-page.js');
  const { defaultSettings } = await import('../../src/settings.js');
  const tree = { rootId: 'r', nodes: [], totalCount: 0, updatedAt: new Date() };
  const frame = renderMonitor({ tree, state: state({ help: true }), width: 40, height: 20 });
  assert.match(stripAnsi(frame.lines[0]), /^\[Back\] Help/);
  assert.doesNotMatch(stripAnsi(frame.lines.at(-1)!), /Esc/);
  const click = (x: number, y: number) => ({ type: 'mouse' as const, button: 'left' as const, x, y });
  assert.equal(handleMonitorInput(frame.state, click(2, 0), { tree, frame }).state.help, false, '[Back] closes it');
  assert.equal(handleMonitorInput(frame.state, click(20, 5), { tree, frame }).state.help, true, 'elsewhere it stays');
  // Too narrow for two shortcuts on a line, they split between the two, not inside one.
  inChinese(() => {
    const lines = renderMonitor({ tree, state: state({ help: true }), width: 32, height: 200 }).lines.map(stripAnsi);
    for (const entry of ['Ctrl+] m 主会话', 'Ctrl+] o 切换到选中的', 'Ctrl+] Enter / v 查看详情', 'Ctrl+] z 放大'])
      assert.ok(lines.includes(entry), `${entry}\n${lines.join('\n')}`);
    assert.ok(
      lines.some((l) => l.startsWith('Ctrl+] Ctrl+] 把 Ctrl+]')),
      'the prefix twice is one entry'
    );
    assert.ok(lines.includes('F12 开 / 关侧栏') && lines.includes('Shift+F12 进入侧栏'), 'F12 and Shift+F12 apart');
    const other = renderMonitor({
      tree,
      state: state({ help: true }),
      width: 32,
      height: 200,
      prefix: 'Ctrl+\\',
    }).lines.map(stripAnsi);
    assert.ok(other.includes('Ctrl+\\ m 主会话') && other.includes('Ctrl+\\ o 切换到选中的'), 'any prefix');
    const wide = renderMonitor({ tree, state: state({ help: true }), width: 70, height: 200 }).lines.map(stripAnsi);
    assert.ok(wide.includes('Ctrl+] m 主会话 Ctrl+] o 切换到选中的'), 'two to a line where they fit');
  });
  for (const width of [28, 40, 70]) {
    const page = renderSettingsPage({ draft: defaultSettings(), selected: 0, offset: 0, message: '' }, width, 30);
    const foot = stripAnsi(page.lines.at(-1)!);
    assert.doesNotMatch(foot, /\bs save|r reset|Esc/, `${width}: ${foot}`);
    assert.match(stripAnsi(page.lines[0]), /^\[Back\] \[Save\] \[Reset\]/);
  }
});
