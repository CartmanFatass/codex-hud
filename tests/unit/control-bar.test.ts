import test from 'node:test';
import assert from 'node:assert/strict';
import { controlBar, ICONS } from '../../src/render/control-bar.js';
import { initialMonitorState, type MonitorState } from '../../src/render/monitor.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { setLanguage } from '../../src/render/i18n.js';
import { stripAnsi, visualLength, truncateAnsi, theme, colors } from '../../src/render/colors.js';

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

/** What rounds 2 and 3 drew: keys (b‖, a+31, ",设置", the tabs' digits) and the old one-column icons. */
const KEY_LETTERS = /b‖|b▸|a[+−]\d|,(设置|Settings)?\s|\b[1-5] [1-5]\b/;
const OLD_ICONS = /[▦⎇±⌖⋮‖▸☰]/;
/** The Nerd Font icons as "@", so a line reads plainly. */
const at = (s: string) => s.replace(/[\ue000-\uf8ff]|[\u{f0000}-\u{ffffd}]/gu, '@');
/** Columns `x` to `x + width` of a plain line. */
const columns = (s: string, x: number, width: number) => {
  let col = 0;
  let out = '';
  for (const ch of s) {
    if (col >= x && col < x + width) out += ch;
    col += visualLength(ch);
  }
  return out;
};
const withIcons = <T>(icons: 'nerd' | 'text', run: () => T): T => {
  const previous = setDisplayConfig({ icons });
  try {
    return run();
  } finally {
    setDisplayConfig(previous);
  }
};
const everyPane = (extra: Partial<MonitorState> = {}) =>
  state({
    focus: 'worktrees',
    modes: { agents: 'open', worktrees: 'open', changes: 'open', details: 'open', timeline: 'open' },
    ...extra,
  });

test('the bar is buttons: an icon and its word where they fit, the icon alone where not, never a key', () => {
  inChinese(() => {
    assert.equal(
      at(plain(state(), 90)),
      ' @ 主会话  @ 卡片 @ 工作树 @ 改动 @ 详情 @ 时间线   @ 暂停简报 @ +31 已收起 @ 设置 @ 帮助 '
    );
    assert.equal(at(plain(everyPane(), 36)), ' @   @  @  @  @  @   @  @ +31 @  @  ', 'narrow: icons alone');
    assert.ok(
      at(plain(state({ tree: { ...initialMonitorState().tree, showAll: true } }), 90)).includes(' @ 收起 @ 设置')
    );
    assert.ok(
      at(plain(state(), 90, { brief: { paused: true }, expired: 0 }))
        .trimEnd()
        .endsWith('@ 继续简报 @ 设置 @ 帮助')
    );
    assert.ok(!plain(state(), 90, { expired: 0 } as never).includes('简报'), 'no brief configured, no button');
  });
  assert.equal(
    at(plain(state(), 104)),
    ' @ Main  @ Agents @ Trees @ Changes @ Inspect @ Timeline    @ Pause brief @ +31 older @ Settings @ Help '
  );
  for (const width of [32, 36, 40, 56, 90]) {
    for (const lang of ['en', 'zh'] as const) {
      for (const icons of ['nerd', 'text'] as const) {
        const previous = setLanguage(lang);
        try {
          for (const s of [state(), everyPane()]) {
            const text = withIcons(icons, () => plain(s, width));
            assert.doesNotMatch(text, KEY_LETTERS, `${lang} ${width}: ${text}`);
            assert.doesNotMatch(text, OLD_ICONS, `${lang} ${width}: ${text}`);
          }
        } finally {
          setLanguage(previous);
        }
      }
    }
  }
});

test('the icons are one column each, and a cut never splits the robot in two', () => {
  for (const icon of Object.values(ICONS)) assert.equal(visualLength(icon), 1, icon.codePointAt(0)!.toString(16));
  const robot = ICONS.agents;
  assert.equal(robot.length, 2, 'a surrogate pair');
  for (let width = 1; width <= 4; width++) {
    const cut = truncateAnsi(`a${robot}${robot}bcdef`, width);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(cut), `${width}: ${cut}`);
    assert.ok(visualLength(cut) <= width);
  }
});

test('short of room: tab words, then closed tabs, then the other words go, then older and the brief; back, settings and help stay', () => {
  inChinese(() => {
    const s = state({ modes: { ...initialMonitorState().modes, timeline: 'open' } });
    assert.equal(
      at(plain(s, 90)),
      ' @ 主会话  @ 卡片 @ 工作树 @ 改动 @ 详情 @ 时间线   @ 暂停简报 @ +31 已收起 @ 设置 @ 帮助 '
    );
    assert.equal(at(plain(s, 56)), ' @ 主会话  @  @   @ 暂停简报 @ +31 已收起 @ 设置 @ 帮助 ');
    assert.equal(at(plain(s, 42)), ' @ 主会话  @  @    @  @ +31 @ 设置 @ 帮助 ');
    assert.equal(at(plain(s, 40)), ' @   @  @        @  @ +31 @ 设置 @ 帮助 ');
    assert.equal(at(plain(s, 32)), ' @   @  @        @  @ +31 @  @  ');
    assert.equal(at(plain(s, 24)), ' @   @  @      @  @  @  ');
    assert.equal(at(plain(s, 18)), ' @   @  @   @  @  ');
    for (let width = 1; width <= 100; width++) {
      for (const icons of ['nerd', 'text'] as const) {
        const bar = withIcons(icons, () => controlBar(s, { brief: {}, expired: 31 }, width));
        assert.equal(visualLength(bar.line), width, `${width}: ${stripAnsi(bar.line)}`);
        const text = stripAnsi(bar.line);
        if (width >= 17 && icons === 'text') assert.match(text, /←.*设置.*帮助/, `${width}: ${text}`);
        if (width >= 11 && icons === 'nerd')
          assert.match(text, new RegExp(`${ICONS.main}.*${ICONS.settings}.*${ICONS.help}`, 'u'), `${width}: ${text}`);
        for (const c of bar.controls) assert.ok(c.y === 0 && c.x >= 0 && c.x + c.width <= width, `${width}: ${c.kind}`);
      }
    }
  });
});

test('with icons off: words, shortened and cut with … where narrow', () => {
  withIcons('text', () => {
    inChinese(() => {
      assert.equal(
        plain(state(), 90),
        ' ← 主会话  卡片 工作树 改动 详情 时间线                     暂停简报 +31 已收起 设置 帮助 '
      );
      assert.equal(plain(everyPane(), 56), ' ← 主  卡片 工作树 改动 详情 时间线  暂停 +31 设置 帮助 ');
    });
    assert.equal(plain(everyPane(), 40), ' ← Main  Ag Wt Ch In Tl   Settings Help ');
  });
  const previous = setDisplayConfig({ glyphs: 'text' });
  try {
    assert.match(
      plain(state(), 90, { brief: { paused: true }, expired: 2 }),
      / Resume brief \+2 older Settings Help $/,
      'glyphs: text means words'
    );
  } finally {
    setDisplayConfig(previous);
  }
});

test('each control sits on what it names', () => {
  const s = state({ modes: { ...initialMonitorState().modes, worktrees: 'folded' } });
  for (const width of [32, 48, 120]) {
    const bar = controlBar(s, { brief: {}, expired: 3 }, width);
    const text = stripAnsi(bar.line);
    const on = (kind: string, pane?: string) => {
      const c = bar.controls.find((c) => c.kind === kind && (!pane || c.pane === pane))!;
      return at(columns(text, c.x, c.width).trim());
    };
    const wide = width === 120;
    assert.equal(on('main'), width === 32 ? '@' : '@ Main', `${width}`);
    assert.equal(on('tab', 'agents'), wide ? '@ Agents' : '@');
    assert.equal(on('tab', 'worktrees'), wide ? '@ Trees' : '@');
    assert.equal(on('brief'), wide ? '@ Pause brief' : '@');
    assert.equal(on('older'), wide ? '@ +3 older' : '@ +3');
    assert.equal(on('settings'), width === 32 ? '@' : '@ Settings');
    assert.equal(on('help'), width === 32 ? '@' : '@ Help');
  }
});

test('the tabs: focused on its own surface, folded underlined, closed dim, every one a chip; without colour only the panes there are', () => {
  const previous = setDisplayConfig({ theme: 'terminal' });
  try {
    const s = state({
      focus: 'agents',
      modes: { ...initialMonitorState().modes, worktrees: 'folded', changes: 'open' },
    });
    const line = controlBar(s, { expired: 0 }, 90).line;
    // A chip's surface, then the face's own paint (the bar re-applies its own after each reset).
    const on = (surface: (s: string) => string, face: string) => surface(face).split('\x1b[0m')[0];
    assert.ok(
      line.includes(on(theme.tab, theme.bold(theme.value(`${ICONS.agents} Agents`)))),
      'focused on its own surface'
    );
    assert.ok(
      line.includes(on(theme.chip, '\x1b[4m' + colors.dim(`${ICONS.worktrees} Trees`))),
      'a folded tab is underlined'
    );
    assert.ok(line.includes(on(theme.chip, colors.dim(`${ICONS.details} Inspect`))), 'a closed tab is dim');
    assert.ok(line.includes(on(theme.chip, theme.value(`${ICONS.changes} Changes`))), 'an open tab in the text colour');
    assert.ok(line.includes(on(theme.chip, theme.value(`${ICONS.settings} Settings`))), 'a button is a chip');
    const narrow = controlBar(s, { expired: 0 }, 32).line;
    assert.ok(
      narrow.includes(on(theme.tab, theme.bold(theme.value(`${ICONS.agents} `)))),
      'narrow, still its own surface'
    );
    assert.ok(
      narrow.includes(on(theme.chip, '\x1b[4m' + colors.dim(`${ICONS.worktrees} `))),
      'narrow, still underlined'
    );
    setDisplayConfig({ theme: 'none' });
    assert.equal(
      at(stripAnsi(controlBar(s, { expired: 0 }, 90).line)).trimEnd(),
      ' @ Main  [@ Agents] @ Trees- @ Changes                                  @ Settings @ Help'
    );
    assert.match(at(stripAnsi(controlBar(s, { expired: 0 }, 32).line)), /^ @ {3}\[@ \] @ - @ +@ +@ +$/);
    const plainBar = controlBar(s, { expired: 0 }, 32);
    const folded = plainBar.controls.find((c) => c.kind === 'tab' && c.pane === 'worktrees')!;
    assert.equal(
      at(columns(stripAnsi(plainBar.line), folded.x, folded.width)),
      '@ -',
      'each tab is clicked where it is drawn'
    );
    const focusedFolded = controlBar({ ...s, focus: 'worktrees' }, { expired: 0 }, 32);
    assert.match(at(stripAnsi(focusedFolded.line)), /^ @ {3}@ {2}\[@ -\] @ /, 'focused and folded at once');
    assert.equal(
      controlBar(s, { expired: 0 }, 56).line,
      stripAnsi(controlBar(s, { expired: 0 }, 56).line),
      'no escapes'
    );
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
