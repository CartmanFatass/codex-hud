import test from 'node:test';
import assert from 'node:assert/strict';
import { controlBar, ICONS, UNICODE_ICONS } from '../../src/render/control-bar.js';
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

/** What round 2 drew as keys: b‖, a+31, ",设置", the tabs' digits. */
const KEY_LETTERS = /b‖|b▸|a[+−]\d|,(设置|Settings)?\s|\b[1-5] [1-5]\b/;
/** The Nerd Font icons as "@", so a line reads plainly. */
const at = (s: string) => s.replace(/[-]|[\u{f0000}-\u{ffffd}]/gu, '@');
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
const withIcons = <T>(icons: 'unicode' | 'nerd' | 'text', run: () => T): T => {
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

/** Where each icon on a plain bar is, and the columns before the first and after the last. */
const rhythm = (line: string) => {
  const at: number[] = [];
  let col = 0;
  for (const ch of line) {
    if (ch !== ' ') at.push(col);
    col += visualLength(ch);
  }
  return { steps: at.slice(1).map((c, i) => c - at[i]), lead: at[0], tail: col - at.at(-1)! - 1 };
};

test('the buttons are spread evenly at every width: one step between icons, the spare columns at the two ends', () => {
  inChinese(() => {
    assert.equal(plain(everyPane(), 32), '  ⌂  ▦  ⌥  ±  ◫  ≣  ǁ  ⊕  ⚙  ?  ');
    assert.equal(plain(everyPane(), 36), '    ⌂  ▦  ⌥  ±  ◫  ≣  ǁ  ⊕  ⚙  ?    ');
    assert.equal(plain(everyPane(), 44), '   ⌂   ▦   ⌥   ±   ◫   ≣   ǁ   ⊕   ⚙   ?    ');
    assert.equal(plain(everyPane(), 56), '     ⌂    ▦    ⌥    ±    ◫    ≣    ǁ    ⊕    ⚙    ?     ');
    for (const input of [{ brief: {}, expired: 31 }, { expired: 0 }, { brief: { paused: true }, expired: 139 }]) {
      for (const s of [state(), everyPane()]) {
        for (let width = 12; width <= 94; width++) {
          const text = plain(s, width, input as never);
          // Where every word fits the buttons carry them, and the gaps are what is even.
          if (/[\p{L}]{2}/u.test(text)) continue;
          const { steps, lead, tail } = rhythm(text);
          assert.equal(new Set(steps).size, 1, `${width}: one step from each icon to the next: "${text}"`);
          assert.ok(Math.abs(lead - tail) <= 2, `${width}: the spare columns at both ends: "${text}"`);
          assert.ok(steps[0] >= 2, `${width}: an icon never touches the next`);
        }
      }
    }
    // Wide enough for every word, each button carries its own, an equal gap between each two.
    assert.equal(
      plain(everyPane(), 110),
      '    ⌂ 主会话   ▦ 卡片   ⌥ 工作树   ± 改动   ◫ 详情   ≣ 时间线   ǁ 暂停简报   ⊕ 31 已收起   ⚙ 设置   ? 帮助    '
    );
    assert.ok(plain(state({ tree: { ...initialMonitorState().tree, showAll: true } }), 110).includes(' ⊖ 收起 '));
    assert.ok(plain(state(), 110, { brief: { paused: true }, expired: 0 }).includes(' ▶ 继续简报 '));
    assert.ok(!plain(state(), 110, { expired: 0 } as never).includes('简报'), 'no brief configured, no button');
  });
  assert.equal(
    plain(state(), 120),
    '  ⌂ Main   ▦ Agents   ⌥ Trees   ± Changes   ◫ Inspect   ≣ Timeline   ǁ Pause brief   ⊕ 31 older   ⚙ Settings   ? Help   '
  );
  assert.ok(!/[a-z]/i.test(plain(state(), 110)), 'short of one word, no button has its word');
  withIcons('nerd', () => {
    assert.equal(at(plain(everyPane(), 36)), '    @  @  @  @  @  @  @  @  @  @    ', 'each icon has a column to spill into');
    assert.equal(at(plain(everyPane(), 32)), '  @  @  @  @  @  @  @  @  @  @  ');
  });
  for (const width of [32, 36, 44, 56, 90]) {
    for (const lang of ['en', 'zh'] as const) {
      for (const icons of ['unicode', 'nerd', 'text'] as const) {
        const previous = setLanguage(lang);
        try {
          for (const s of [state(), everyPane()]) {
            const text = withIcons(icons, () => plain(s, width));
            assert.doesNotMatch(text, KEY_LETTERS, `${lang} ${icons} ${width}: ${text}`);
          }
        } finally {
          setLanguage(previous);
        }
      }
    }
  }
});

test('the Nerd Font icons are one column each, and a cut never splits the robot in two', () => {
  for (const icon of Object.values(ICONS)) assert.equal(visualLength(icon), 1, icon.codePointAt(0)!.toString(16));
  for (const icon of Object.values(UNICODE_ICONS)) assert.equal(visualLength(icon), 1, icon);
  const robot = ICONS.agents;
  assert.equal(robot.length, 2, 'a surrogate pair');
  for (let width = 1; width <= 4; width++) {
    const cut = truncateAnsi(`a${robot}${robot}bcdef`, width);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(cut), `${width}: ${cut}`);
    assert.ok(visualLength(cut) <= width);
  }
});

test('short of room the closed tabs go, then older and the brief, then the tabs; main, settings and help stay', () => {
  inChinese(() => {
    const s = state({ modes: { ...initialMonitorState().modes, timeline: 'open' } });
    assert.equal(plain(s, 24), '  ⌂ ▦ ⌥ ± ◫ ≣ ǁ ⊕ ⚙ ?   ');
    assert.equal(plain(s, 18), '  ⌂ ▦ ≣ ǁ ⊕ ⚙ ?   ', 'the closed tabs go first');
    assert.equal(plain(s, 13), '⌂ ▦ ≣ ǁ ⚙ ?  ', 'then the older agents');
    assert.equal(plain(s, 8), '⌂ ▦ ⚙ ? ', 'then the brief and the tabs but the focused one');
    assert.equal(plain(s, 6), '⌂ ⚙ ? ', 'then that one');
    for (let width = 1; width <= 130; width++) {
      for (const icons of ['unicode', 'nerd', 'text'] as const) {
        const bar = withIcons(icons, () => controlBar(s, { brief: {}, expired: 31 }, width));
        const text = stripAnsi(bar.line);
        assert.equal(visualLength(bar.line), width, `${icons} ${width}: ${text}`);
        if (width >= 17 && icons === 'text') assert.match(text, /←.*设置.*帮助/, `${width}: ${text}`);
        if (width >= 6 && icons === 'unicode') assert.match(text, /⌂.*⚙.*\?/, `${width}: ${text}`);
        if (width >= 6 && icons === 'nerd')
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
        ' ← 主会话   卡片   工作树   改动   详情   时间线      暂停简报   +31 已收起   设置   帮助 '
      );
      assert.equal(plain(everyPane(), 56), '← 主  卡片 工作… 改动 详情 时间…     暂停 +31 设置 帮助 ');
    });
    assert.equal(plain(everyPane(), 44), '← Main  Ag Wt Ch In Tl  Pause Settings Help ');
  });
  const previous = setDisplayConfig({ glyphs: 'text' });
  try {
    assert.match(
      plain(state(), 120, { brief: { paused: true }, expired: 2 }),
      / Resume brief {3}\+2 older {3}Settings {3}Help $/,
      'glyphs: text means words'
    );
  } finally {
    setDisplayConfig(previous);
  }
});

test('a click anywhere on the bar is a button: each one owns its icon and the gap after it, the ends the first and last', () => {
  const s = state({ modes: { ...initialMonitorState().modes, worktrees: 'open' } });
  for (const width of [24, 32, 36, 48, 56, 120]) {
    for (const icons of ['unicode', 'nerd'] as const) {
      const bar = withIcons(icons, () => controlBar(s, { brief: {}, expired: 3 }, width));
      const text = stripAnsi(bar.line);
      const controls = [...bar.controls].sort((a, b) => a.x - b.x);
      assert.equal(controls[0].x, 0, `${width}`);
      controls.forEach((c, i) => {
        const next = controls[i + 1];
        assert.equal(c.x + c.width, next ? next.x : width, `${width}: ${c.kind} meets the next`);
        // Each control's own columns hold exactly one icon: its button's.
        const own = columns(text, c.x, c.width).replace(/ /g, '');
        assert.ok(own.length >= 1, `${width}: ${c.kind} has its icon: "${columns(text, c.x, c.width)}"`);
      });
      assert.deepEqual(
        controls.map((c) => c.kind),
        ['main', 'tab', 'tab', 'tab', 'tab', 'tab', 'brief', 'older', 'settings', 'help'],
        `${width}: left to right`
      );
    }
  }
});

test('the tabs say their state by their chip, the icon at full brightness: focused on the accent, open on a chip, closed on the bar', () => {
  const previous = setDisplayConfig({ theme: 'terminal' });
  try {
    const s = state({
      focus: 'agents',
      modes: { ...initialMonitorState().modes, worktrees: 'open', changes: 'open' },
    });
    for (const width of [32, 44]) {
      const line = controlBar(s, { expired: 0 }, width).line;
      const pad = ' ';
      const face = (f: string) => `${pad}${f} `;
      // A chip's surface, then the face's own paint (the bar re-applies its own after each reset).
      const on = (surface: (s: string) => string, text: string) => surface(text).split('\x1b[0m')[0];
      assert.ok(line.includes(theme.tab(theme.bold(face('▦'))).split('\x1b[0m')[0]), `${width}: focused on the accent`);
      assert.ok(line.includes(theme.bold(theme.value('◫')).split('\x1b[0m')[0]), `${width}: closed, on the bar, bold`);
      assert.ok(
        !line.includes(on(theme.chip, `${pad}${theme.bold(theme.value('◫'))}`)),
        `${width}: closed has no chip`
      );
      assert.ok(line.includes(on(theme.chip, `${pad}${theme.bold(theme.value('±'))}`)), `${width}: open, on a chip`);
      assert.ok(line.includes(on(theme.chip, `${pad}${theme.bold(theme.value('⌥'))}`)), `${width}: open, on a chip`);
      assert.ok(
        line.includes(on(theme.chip, `${pad}${theme.bold(theme.value('⚙'))}`)),
        `${width}: a button is a chip`
      );
      assert.ok(!line.includes('\x1b[2m'), `${width}: nothing on the bar is dimmed`);
      assert.ok(!line.includes('\x1b[4m'), `${width}: nothing is underlined`);
    }
    setDisplayConfig({ theme: 'none' });
    // Without colour the focused tab is in brackets, in its chip's side columns, so nothing moves.
    const plainBar = controlBar(s, { expired: 0 }, 32);
    assert.equal(plainBar.line, '   ⌂   [▦]   ⌥    ±    ⚙    ?   ');
    assert.deepEqual(rhythm(plainBar.line.replace(/[[\]]/g, ' ')).steps, [5, 5, 5, 5, 5], 'the brackets move no icon');
    const open = plainBar.controls.find((c) => c.kind === 'tab' && c.pane === 'worktrees')!;
    assert.equal(columns(plainBar.line, open.x, open.width), ' ⌥   ', 'each tab is clicked where it is drawn');
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
