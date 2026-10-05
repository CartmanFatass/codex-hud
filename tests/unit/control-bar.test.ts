import test from 'node:test';
import assert from 'node:assert/strict';
import { controlBar, paneHead, look, ICONS, UNICODE_ICONS, EMOJI_ICONS } from '../../src/render/control-bar.js';
import { initialMonitorState, MONITOR_PANES, type MonitorState, type MonitorControl } from '../../src/render/monitor.js';
import { setDisplayConfig, LOOKS, type HudDisplayConfig } from '../../src/render/hud-config.js';
import { setLanguage } from '../../src/render/i18n.js';
import { stripAnsi, visualLength, truncateAnsi, theme, colors } from '../../src/render/colors.js';

const state = (extra: Partial<MonitorState> = {}): MonitorState => ({ ...initialMonitorState(), ...extra });
type Input = Parameters<typeof controlBar>[1];
const BRIEF: Input = { brief: {}, expired: 31 };
const rows = (s: MonitorState, width: number, input: Input = BRIEF) => controlBar(s, input, width).lines.map(stripAnsi);
const plain = (s: MonitorState, width: number, input: Input = BRIEF) => rows(s, width, input)[0];
const inChinese = <T>(run: () => T): T => {
  const previous = setLanguage('zh');
  try {
    return run();
  } finally {
    setLanguage(previous);
  }
};
const withConfig = <T>(config: Partial<HudDisplayConfig>, run: () => T): T => {
  const previous = setDisplayConfig(config);
  try {
    return run();
  } finally {
    setDisplayConfig(previous);
  }
};

/** What round 2 drew as keys: b‖, a+31, ",设置", the tabs' digits. */
const KEY_LETTERS = /b‖|b▸|a[+−]\d|,(设置|Settings)?\s|\b[1-5] [1-5]\b/;
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
const everyPane = (extra: Partial<MonitorState> = {}) =>
  state({
    focus: 'timeline',
    modes: { agents: 'open', timeline: 'open', changes: 'open', details: 'open' },
    ...extra,
  });
/** Cards focused, the timeline and changes open, the inspector closed. */
const some = () =>
  state({ focus: 'agents', modes: { ...initialMonitorState().modes, timeline: 'open', changes: 'open' } });
const key = (c: MonitorControl) => (c.pane ? `${c.kind}:${c.pane}` : c.kind);
/** Every width a panel is likely to be, then a few wider. */
const WIDTHS = [...Array.from({ length: 57 }, (_, i) => i + 8), 70, 80, 90, 100, 110, 120, 130];

test('the tab look: the focused pane a filled tab with its word, the other panes their icons, the actions at the right end', () => {
  inChinese(() => {
    assert.equal(plain(everyPane(), 32), ' ⌂ ▦  ≣ 时间线  ± ◫   ǁ ⊕31 ⚙ ? ');
    assert.equal(plain(everyPane(), 40), ' ⌂ ▦    ≣ 时间线    ±   ◫     ǁ ⊕31 ⚙ ? ');
    assert.equal(plain(everyPane(), 70), ' ⌂ ▦ 卡片    ≣ 时间线    ± 改动   ◫ 详情                    ǁ ⊕31 ⚙ ? ');
    // Very wide, the actions take their words too, and the main session's button stands off from the tabs.
    assert.match(plain(everyPane(), 130), /^ ⌂ 主会话 {2}▦ 卡片 .* ǁ 暂停简报 {2}⊕31 已收起 {2}⚙ 设置 {2}\? 帮助 $/);
    assert.ok(plain(state({ tree: { ...initialMonitorState().tree, showAll: true } }), 130).includes(' ⊖31 收起 '));
    assert.ok(plain(state(), 130, { brief: { paused: true }, expired: 0 }).includes(' ▶ 继续简报 '));
    assert.ok(!plain(state(), 130, { expired: 0 }).includes('简报'), 'no brief configured, no button');
  });
  assert.equal(plain(everyPane(), 40), ' ⌂ ▦   ≣ Timeline   ±  ◫      ǁ ⊕31 ⚙ ? ');
  assert.equal(
    plain(everyPane(), 90),
    ' ⌂ ▦ Agents    ≣ Timeline    ± Changes   ◫ Inspect                              ǁ ⊕31 ⚙ ? '
  );
  // Once every button is on the bar, words come with the width and never go
  // again: the focused tab's first, then every open tab's. (Narrower, a
  // button is kept before a word: fewer buttons can leave a word room.)
  inChinese(() => {
    for (const s of [everyPane(), some(), state()]) {
      let focused = false;
      let all = false;
      const buttons = controlBar(s, BRIEF, 200).controls.length;
      for (let width = 12; width <= 130; width++) {
        if (controlBar(s, BRIEF, width).controls.length < buttons) continue;
        const text = plain(s, width);
        const has = MONITOR_PANES.filter((id) => s.modes[id] === 'open').map((id) => text.includes({ agents: '卡片', changes: '改动', details: '详情', timeline: '时间线' }[id]));
        const focusedHas = text.includes(s.focus === 'agents' ? '卡片' : '时间线');
        assert.ok(!focused || focusedHas, `${width}: the focused tab keeps its word: "${text}"`);
        assert.ok(!all || has.every(Boolean), `${width}: the open tabs keep their words: "${text}"`);
        focused ||= focusedHas;
        all ||= has.every(Boolean);
      }
      assert.ok(focused && all);
    }
  });
});

test('every look fits the bar to the column, at every width, in both languages and with every icon set', () => {
  for (const lang of ['en', 'zh'] as const) {
    const previous = setLanguage(lang);
    try {
      for (const lk of LOOKS) {
        for (const icons of ['unicode', 'nerd', 'emoji', 'text'] as const) {
          withConfig({ look: lk, icons }, () => {
            for (const input of [BRIEF, { expired: 0 }, { brief: { paused: true }, expired: 139 }] as Input[]) {
              for (const s of [state(), everyPane(), some(), state({ tabbed: true, focus: 'changes' })]) {
                for (const width of WIDTHS) {
                  const bar = controlBar(s, input, width);
                  const framed = lk === 'frame' && width >= 20;
                  assert.equal(bar.lines.length, framed ? 2 : 1, `${lang} ${lk} ${icons} ${width}`);
                  for (const line of bar.lines) {
                    assert.equal(visualLength(line), width, `${lang} ${lk} ${icons} ${width}: "${stripAnsi(line)}"`);
                    assert.doesNotMatch(stripAnsi(line), KEY_LETTERS, `${lang} ${lk} ${icons} ${width}`);
                  }
                  for (const c of bar.controls) assert.ok(c.x >= 0 && c.x + c.width <= width && c.y < bar.lines.length, `${lk} ${width}: ${key(c)}`);
                  if (width >= 12 && icons !== 'text') {
                    const kinds = bar.controls.map((c) => c.kind);
                    assert.ok(kinds.includes('main') && kinds.includes('settings') && kinds.includes('help'), `${lk} ${icons} ${width}: ${kinds}`);
                  }
                }
              }
            }
          });
        }
      }
    } finally {
      setLanguage(previous);
    }
  }
});

test('short of room the closed tabs go, then older and the brief, then the tabs; main, settings and help stay', () => {
  inChinese(() => {
    for (const lk of LOOKS) {
      withConfig({ look: lk }, () => {
        const s = state({ modes: { ...initialMonitorState().modes, timeline: 'open' } });
        const gone = new Map<string, number>();
        let before = new Set<string>();
        for (let width = 130; width >= 10; width--) {
          const now = new Set(controlBar(s, BRIEF, width).controls.map(key));
          for (const k of now) assert.ok(width === 130 || before.has(k), `${lk} ${width}: ${k} comes back`);
          for (const k of before) if (!now.has(k)) gone.set(k, width);
          before = now;
        }
        const at = (k: string) => gone.get(k) ?? 0;
        assert.ok(at('tab:changes') >= at('older') && at('older') >= at('brief'), `${lk}: closed tabs, then older, then the brief`);
        assert.ok(at('brief') >= at('tab:timeline') && at('tab:timeline') >= at('tab:agents'), `${lk}: then the tabs, the focused one last`);
        for (const k of ['main', 'settings', 'help']) assert.ok(!gone.has(k), `${lk}: ${k} stays`);
      });
    }
  });
});

test('a click anywhere on the bar is a button: each owns its face and half the gaps beside it', () => {
  for (const lk of LOOKS) {
    for (const icons of ['unicode', 'nerd', 'emoji', 'text'] as const) {
      withConfig({ look: lk, icons }, () => {
        for (const width of [24, 32, 36, 48, 56, 120]) {
          const s = some();
          const bar = controlBar(s, { brief: {}, expired: 3 }, width);
          const text = bar.lines.map(stripAnsi);
          for (let y = 0; y < bar.lines.length; y++) {
            const controls = bar.controls.filter((c) => c.y === y).sort((a, b) => a.x - b.x);
            const [from, to] = lk === 'frame' && y === 1 ? [1, width - 1] : [0, width];
            assert.equal(controls[0].x, from, `${lk} ${icons} ${width}`);
            controls.forEach((c, i) => {
              const next = controls[i + 1];
              assert.equal(c.x + c.width, next ? next.x : to, `${lk} ${icons} ${width}: ${key(c)} meets the next`);
              const own = columns(text[y], c.x, c.width).replace(/[ │─╭╮]/g, '');
              assert.ok(own.length >= 1, `${lk} ${icons} ${width}: ${key(c)} has its face: "${columns(text[y], c.x, c.width)}"`);
            });
          }
          // Left to right (the frame's top edge first): main, the tabs, the actions.
          const order = [...bar.controls].sort((a, b) => a.y - b.y || a.x - b.x).map(key);
          const tabs = ['tab:agents', 'tab:timeline', 'tab:changes', 'tab:details'];
          const actions = ['brief', 'older', 'settings', 'help'];
          const all = lk === 'frame' ? ['main', ...actions, ...tabs] : ['main', ...tabs, ...actions];
          assert.deepEqual(order, all.filter((k) => order.includes(k)), `${lk} ${icons} ${width}`);
          if (width >= 48) assert.deepEqual(order, all, `${lk} ${icons} ${width}: every button`);
        }
      });
    }
  }
});

test('colour says each tab\'s state: focused filled, open in the text colour, closed and the actions muted', () => {
  withConfig({ theme: 'terminal' }, () => {
    inChinese(() => {
      for (const width of [32, 44]) {
        const line = controlBar(some(), { brief: { paused: true }, expired: 3 }, width).lines[0];
        const focused = stripAnsi(line).includes('▦ 卡片') ? ' ▦ 卡片 ' : ' ▦ ';
        assert.ok(line.includes(theme.tab(theme.bold(focused))), `${width}: the focused tab filled`);
        const open = (glyph: string, word: string) => line.includes(theme.value(glyph)) || line.includes(theme.value(`${glyph} ${word}`));
        assert.ok(open('≣', '时间线') && open('±', '改动'), `${width}: open, in the text colour`);
        assert.ok(line.includes(colors.dim('◫')), `${width}: closed, muted`);
        assert.ok(line.includes(colors.dim('⚙')) && line.includes(colors.dim('?')), `${width}: the actions muted`);
        assert.ok(line.includes(theme.accent('▶')), `${width}: the paused brief's resume in the accent`);
        assert.ok(!line.includes('\x1b[4m'), `${width}: nothing is underlined`);
      }
    });
  });
  withConfig({ theme: 'none' }, () => {
    // Without colour the focused tab is in brackets, and a closed pane has no tab.
    const bar = controlBar(some(), { expired: 0 }, 44);
    assert.equal(bar.lines[0], stripAnsi(bar.lines[0]), 'no escapes');
    assert.match(bar.lines[0], /\[▦ Agents\]|\[▦\]/);
    assert.ok(!bar.lines[0].includes('◫') && bar.lines[0].includes('≣'), bar.lines[0]);
  });
  // In the tabs layout every pane has a tab, none of them closed.
  withConfig({ theme: 'terminal' }, () => {
    const line = controlBar(state({ tabbed: true, focus: 'changes' }), { expired: 0 }, 44).lines[0];
    for (const id of ['agents', 'details', 'timeline'] as const) assert.ok(line.includes(theme.value(UNICODE_ICONS[id])), id);
    assert.match(stripAnsi(line), / ± Changes /);
  });
});

test('the band, tile, pill and frame looks', () => {
  withConfig({ theme: 'titanium' }, () => {
    inChinese(() => {
      // The band: its two groups on the band, the accent's rule between them; a word two columns from the next tab.
      withConfig({ look: 'band' }, () => {
        for (let width = 24; width <= 90; width++) {
          const line = controlBar(everyPane(), BRIEF, width).lines[0];
          assert.ok(line.startsWith(theme.band(' ').split(' ')[0]), `${width}: on the band`);
          assert.match(stripAnsi(line), / ─{2,} /, `${width}: the rule`);
          assert.doesNotMatch(stripAnsi(line), /[\p{Script=Han}a-z] [▦±◫≣]/u, `${width}: "${stripAnsi(line)}"`);
        }
        // The band paints its surface again after every reset inside it: compare up to the first one.
        const opened = (text: string) => text.split('\x1b[0m')[0];
        assert.ok(controlBar(everyPane(), BRIEF, 44).lines[0].includes(opened(theme.bold(theme.accent('≣ 时间线')))), 'the focused tab in the accent');
      });
      // Tiles: an open tab on a chip, with a column each side where the tabs are apart.
      withConfig({ look: 'tile', icons: 'emoji' }, () => {
        assert.ok(controlBar(everyPane(), BRIEF, 32).lines[0].includes(theme.chip('🤖')));
        assert.ok(controlBar(everyPane(), BRIEF, 56).lines[0].includes(theme.chip(' 🤖 ')));
        for (const id of MONITOR_PANES) assert.equal(visualLength(EMOJI_ICONS[id]), 2, id);
      });
      // Pills: the focused tab rounded.
      withConfig({ look: 'pill', icons: 'nerd' }, () => {
        const line = controlBar(everyPane(), BRIEF, 40).lines[0];
        assert.ok(line.includes(`${theme.tabEdge('')}${theme.tab(theme.bold(`${ICONS.timeline} 时间线`))}${theme.tabEdge('')}`));
      });
      // The frame: the main session its title and the actions in its top edge, the tabs between its sides.
      withConfig({ look: 'frame' }, () => {
        assert.deepEqual(rows(everyPane(), 40), [
          '╭─ ⌂ 主会话 ─────────────── ǁ ⊕31 ⚙ ? ─╮',
          '│ ▦ 卡片   ≣ 时间线   ± 改动  ◫ 详情   │',
        ]);
        assert.deepEqual(rows(everyPane(), 20), ['╭─ ⌂ ── ǁ ⊕31 ⚙ ? ─╮', '│ ▦  ≣ 时间线  ± ◫ │']);
        assert.equal(look(19), 'tab', 'narrower than its sides, the tab look');
        assert.equal(rows(everyPane(), 19).length, 1);
        withConfig({ icons: 'text' }, () => {
          setLanguage('en');
          assert.deepEqual(rows(everyPane(), 20), ['╭─ ← ─ Settings ? ─╮', '│ Ag   Tl   Ch  In │'], 'the title down to its arrow');
          setLanguage('zh');
        });
      });
    });
  });
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

test('with icons off: words, shortened where narrow, the main session an arrow and a word', () => {
  withConfig({ icons: 'text' }, () => {
    inChinese(() => {
      assert.equal(plain(state(), 24), ' ← 主  卡片      设置 ? ');
      assert.equal(plain(state(), 40), ' ← 主  卡片             暂停 +31 设置 ? ');
      assert.equal(
        plain(state(), 90),
        ' ← 主会话   卡片   时间线  改动  详情                    暂停简报  +31 已收起  设置  帮助 '
      );
    });
  });
  withConfig({ glyphs: 'text' }, () => {
    assert.match(plain(state(), 130, { brief: { paused: true }, expired: 2 }), / Resume brief {2}\+2 older {2}Settings {2}Help $/, 'glyphs: text means words');
  });
});

test('a pane\'s title in each look: its icon and name, the counts after it, where its rows are at the right end', () => {
  const head = (id: (typeof MONITOR_PANES)[number], width: number, o: Partial<Parameters<typeof paneHead>[2]> = {}) =>
    paneHead(id, width, { focused: false, zoomed: false, ...o });
  withConfig({ theme: 'titanium' }, () => {
    inChinese(() => {
      withConfig({ look: 'tab' }, () => {
        assert.equal(stripAnsi(head('timeline', 32, { right: '5 个' })), ' ≣ 时间线                  5 个 ');
        assert.equal(stripAnsi(head('agents', 32, { info: '✓139 完成', right: '1–9/40' })), ' ▦ 卡片  ✓139 完成       1–9/40 ');
        assert.ok(head('timeline', 32, { focused: true }).includes(theme.bold(theme.accent('≣ 时间线'))), 'the accent where the focus is');
        assert.ok(head('timeline', 32, { focused: true, zoomed: true }).includes(theme.tab(theme.bold(' ≣ 时间线 '))), 'zoomed, a filled tab');
        // Short of room the name goes, then the counts' words, then where the rows are.
        const counts = ['✓139 完成  ▸1 运行', '✓139 ▸1'];
        assert.equal(stripAnsi(head('agents', 31, { info: counts, right: '1–9/40' })), ' ▦  ✓139 完成  ▸1 运行  1–9/40 ');
        assert.equal(stripAnsi(head('agents', 30, { info: counts, right: '1–9/40' })), ' ▦ 卡片  ✓139 ▸1       1–9/40 ');
        assert.equal(stripAnsi(head('agents', 24, { info: counts, right: '1–9/40' })), ' ▦  ✓139 ▸1      1–9/40 ');
        assert.equal(stripAnsi(head('agents', 16, { info: counts, right: '1–9/40' })), ' ▦  ✓139 ▸1     ');
        assert.equal(stripAnsi(head('changes', 16, { right: '1–9/2987' })), ' ±     1–9/2987 ');
      });
      withConfig({ look: 'band' }, () => {
        assert.ok(head('changes', 32).startsWith(theme.band(' ').split(' ')[0]), 'on the band');
        assert.ok(head('changes', 32, { focused: true, zoomed: true }).startsWith(theme.tab(' ').split(' ')[0]), 'zoomed, on the tab');
      });
      withConfig({ look: 'tile' }, () => {
        assert.equal(stripAnsi(head('changes', 24, { right: '3 个' })), ' ± 改动 ────────── 3 个 ');
        const opened = (text: string) => text.split('\x1b[0m')[0];
        assert.ok(head('changes', 24, { focused: true }).includes(opened(theme.accent('─'))), 'the rule in the accent where the focus is');
        assert.ok(head('changes', 24).includes(opened(theme.frame('─'))));
      });
      withConfig({ look: 'frame' }, () => {
        assert.equal(stripAnsi(head('changes', 24, { right: '3 个' })), '├─ ± 改动 ────── 3 个 ─┤');
        assert.equal(stripAnsi(head('changes', 24)), '├─ ± 改动 ─────────────┤');
      });
      withConfig({ look: 'pill', icons: 'nerd' }, () => {
        assert.ok(head('changes', 32).includes(theme.chip(theme.bold(theme.value(`${ICONS.changes} 改动`)))), 'a chip pill');
        assert.ok(head('changes', 32, { focused: true }).includes(theme.tab(theme.bold(`${ICONS.changes} 改动`))), 'the deep blue where the focus is');
      });
      for (const lk of LOOKS) {
        for (const icons of ['unicode', 'nerd', 'emoji', 'text'] as const) {
          withConfig({ look: lk, icons }, () => {
            for (let width = 12; width <= 80; width++) {
              for (const id of MONITOR_PANES) {
                const line = head(id, width, { info: id === 'agents' ? '✓139 完成  ▸1 运行  ◈5 审查' : undefined, right: '1–20/139', focused: id === 'changes' });
                assert.equal(visualLength(line), width, `${lk} ${icons} ${width} ${id}: "${stripAnsi(line)}"`);
              }
            }
          });
        }
      }
    });
  });
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
  // The shortcuts are a table: the prefix said once, in the heading; each key in a column, what it does beside it.
  inChinese(() => {
    const lines = renderMonitor({ tree, state: state({ help: true }), width: 32, height: 200 }).lines.map(stripAnsi);
    assert.equal(lines[1], '快捷键：先按 Ctrl+]，再按一键');
    for (const entry of ['m          主会话', 'o          切换到选中的', 'Enter / v  查看详情', 'z          放大', 'F12        开 / 关侧栏', 'Shift+F12  进入侧栏'])
      assert.ok(lines.includes(entry), `${entry}\n${lines.join('\n')}`);
    assert.ok(lines.some(line => line.startsWith('Ctrl+]     把 Ctrl+]')), 'the prefix twice is one entry, its key the prefix');
    assert.equal(lines.filter(line => line.includes('Ctrl+]')).length, 2, 'nowhere else');
    const other = renderMonitor({
      tree,
      state: state({ help: true }),
      width: 32,
      height: 200,
      prefix: 'Ctrl+\\',
    }).lines.map(stripAnsi);
    assert.ok(other.includes('m          主会话') && other[1].includes('Ctrl+\\'), 'any prefix');
    // Too narrow for what a key does, it wraps under itself.
    const narrow = renderMonitor({ tree, state: state({ help: true }), width: 20, height: 200 }).lines.map(stripAnsi);
    const at = narrow.findIndex(line => line.startsWith('r          '));
    assert.ok(at > 0 && /^ {11}\S/.test(narrow[at + 1]), narrow.slice(at, at + 3).join('\n'));
  });
  for (const width of [28, 40, 70]) {
    const page = renderSettingsPage({ draft: defaultSettings(), selected: 0, offset: 0, message: '' }, width, 30);
    const foot = stripAnsi(page.lines.at(-1)!);
    assert.doesNotMatch(foot, /\bs save|r reset|Esc/, `${width}: ${foot}`);
    assert.match(stripAnsi(page.lines[0]), /^\[Back\] \[Save\] \[Reset\]/);
  }
});
