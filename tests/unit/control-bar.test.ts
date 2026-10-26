import test from 'node:test';
import assert from 'node:assert/strict';
import { controlBar, paneHead, look, ICONS, UNICODE_ICONS, EMOJI_ICONS } from '../../src/render/control-bar.js';
import { initialMonitorState, MONITOR_PANES, type MonitorState, type MonitorControl } from '../../src/render/monitor.js';
import { setDisplayConfig, LOOKS, type HudDisplayConfig } from '../../src/render/hud-config.js';
import { setLanguage } from '../../src/render/i18n.js';
import { stripAnsi, visualLength, truncateAnsi, theme, colors } from '../../src/render/colors.js';
import { useDisplayFixture } from '../fixtures/display.js';

useDisplayFixture();

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
    assert.equal(plain(everyPane(), 32), ' ⌂ ▦   ≣   ±  ◫  设置   ǁ ⊕31 ? ');
    assert.equal(plain(everyPane(), 40), ' ⌂ ▦   ≣ 时间线   ±  ◫  设置    ǁ ⊕31 ? ');
    assert.equal(plain(everyPane(), 70), ' ⌂ ▦ 卡片    ≣ 时间线    ± 改动   ◫ 详情   ⚙ 设置             ǁ ⊕31 ? ');
    // Very wide, the actions take their words too, and the main session's button stands off from the tabs.
    assert.match(plain(everyPane(), 130), /^ ⌂ 主会话 {2}▦ 卡片 .*⚙ 设置 +ǁ 暂停模型 {2}⊕ 31 个已完成 {2}\? 帮助 $/);
    assert.ok(plain(state({ tree: { ...initialMonitorState().tree, showAll: true } }), 130).includes(' ⊖ 收起 '));
    assert.ok(plain(state(), 130, { brief: { paused: true }, expired: 0 }).includes(' ▶ 继续模型 '));
    assert.ok(!plain(state(), 130, { expired: 0 }).includes('模型'), 'no model backend configured, no button');
  });
  assert.equal(plain(everyPane(), 40), ' ⌂ ▦  ≣ Timeline  ± ◫ Settings  ǁ ⊕31 ? ');
  assert.equal(
    plain(everyPane(), 90),
    ' ⌂ ▦ Agents    ≣ Timeline    ± Changes   ◫ Inspect   ⚙ Settings         ǁ ⊕ 31 finished ? '
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
        for (let width = 130; width >= 12; width--) {
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
          const tabs = ['tab:agents', 'tab:timeline', 'tab:changes', 'tab:details', 'settings'];
          const actions = ['brief', 'older', 'help'];
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
        assert.ok(line.includes(theme.value('设置')) || line.includes(theme.value('⚙ 设置')), `${width}: Settings is an open navigation tab`);
        assert.ok(line.includes(colors.dim('?')), `${width}: the actions muted`);
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

test('in the tabs layout a +N older button costs the other tabs their icons, not their words', () => {
  withConfig({ theme: 'titanium', look: 'pill', icons: 'nerd' }, () => {
    inChinese(() => {
      const tabbed = state({ tabbed: true });
      const words = (line: string) => ['时间线', '改动', '详情'].every((word) => line.includes(word));
      // Settings adds a labelled tab: at 52 columns, every word with no button, and with one.
      const bare = plain(tabbed, 52, { brief: {}, expired: 0 });
      const older = plain(tabbed, 52, { brief: {}, expired: 7 });
      assert.ok(words(bare) && bare.includes(`${ICONS.timeline} 时间线`), bare);
      assert.ok(words(older) && older.includes('⊕7'), older);
      assert.ok(!older.includes(ICONS.timeline) && older.includes(`${ICONS.agents} 卡片`), `the focused tab keeps its icon: ${older}`);
      // Stacked, the icons say which panes are open: they stay, and the words go first.
      const stacked = plain(everyPane(), 48, { brief: {}, expired: 7 });
      assert.ok(stacked.includes(ICONS.changes) && stacked.includes(ICONS.details), stacked);
    });
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
          '╭─ ⌂ 主会话 ─────── ǁ ⊕ 31 个已完成 ? ─╮',
          '│ ▦    ≣ 时间线    ±   ◫   设置        │',
        ]);
        assert.deepEqual(rows(everyPane(), 20), ['╭─ ⌂ ──── ǁ ⊕31 ? ─╮', '│ ▦   ≣   ±  ◫  设 │']);
        assert.equal(look(19), 'tab', 'narrower than its sides, the tab look');
        assert.equal(rows(everyPane(), 19).length, 1);
        withConfig({ icons: 'text' }, () => {
          setLanguage('en');
          assert.deepEqual(rows(everyPane(), 20), ['╭─ ← Main ───── ? ─╮', '│  Timeline    Set │'], 'the labelled Settings tab leaves the focused pane room');
          setLanguage('zh');
        });
      });
    });
  });
});

test('Settings is labelled navigation at useful widths, with one non-pane click span and exclusive focus', () => {
  for (const lang of ['en', 'zh'] as const) {
    const previous = setLanguage(lang);
    try {
      const label = lang === 'zh' ? '设置' : 'Settings';
      for (const lk of LOOKS) {
        for (const icons of ['unicode', 'nerd', 'emoji', 'text'] as const) {
          for (const skin of ['terminal', 'none'] as const) {
            withConfig({ look: lk, icons, theme: skin }, () => {
              const focusedText = (face: string) => {
                const painted = skin === 'none' ? `[${face}]`
                  : lk === 'band' ? theme.bold(theme.accent(face))
                  : lk === 'pill' ? `${theme.tabEdge('')}${theme.tab(theme.bold(face))}${theme.tabEdge('')}`
                  : theme.tab(theme.bold(` ${face} `));
                // The band reapplies its surface after an inner reset.
                return lk === 'band' && skin !== 'none' ? painted.split('\x1b[0m')[0] : painted;
              };
              for (const width of [24, 32, 40, 48, 56]) {
                for (const active of [false, true]) {
                  for (const s of [state(), everyPane(), state({ tabbed: true, focus: 'changes' })]) {
                    const bar = controlBar(s, { ...BRIEF, settingsActive: active }, width);
                    const context = `${lang} ${lk} ${icons} ${skin} ${width} active=${active}`;
                    const settings = bar.controls.filter(c => c.kind === 'settings');
                    assert.equal(settings.length, 1, `${context}: no duplicate Settings action`);
                    const c = settings[0];
                    assert.equal(c.pane, undefined, `${context}: Settings is not a MonitorPane`);
                    assert.equal(c.y, lk === 'frame' ? 1 : 0, `${context}: on the navigation row`);
                    const own = columns(stripAnsi(bar.lines[c.y]), c.x, c.width);
                    assert.ok(own.includes(label), `${context}: entire label belongs to its click span: ${own}`);
                    for (const line of bar.lines) {
                      assert.equal(visualLength(line), width, context);
                      if (skin === 'none') assert.equal(line, stripAnsi(line), `${context}: no colour escapes`);
                    }
                    for (let y = 0; y < bar.lines.length; y++) {
                      const controls = bar.controls.filter(c => c.y === y).sort((a, b) => a.x - b.x);
                      controls.forEach((c, i) => {
                        assert.ok(c.x >= 0 && c.width > 0 && c.x + c.width <= width, context);
                        const next = controls[i + 1];
                        if (next) assert.equal(c.x + c.width, next.x, `${context}: contiguous, non-overlapping spans`);
                      });
                    }
                    const face = own.replace(/[│─╭╮\[\]]/gu, '').trim();
                    assert.equal(bar.lines[c.y].includes(focusedText(face)), active, `${context}: Settings focus follows settingsActive`);
                    if (active) {
                      for (const tab of bar.controls.filter(c => c.kind === 'tab')) {
                        const own = columns(stripAnsi(bar.lines[tab.y]), tab.x, tab.width);
                        assert.doesNotMatch(own, /[\[\]]/u, `${context}: ordinary pane is not focused`);
                        assert.ok(!bar.lines[tab.y].includes(focusedText(own.trim())), `${context}: no ordinary focused tab`);
                      }
                    }
                    const order = bar.controls.filter(c => c.y === (lk === 'frame' ? 1 : 0)).map(key);
                    const before = order.slice(0, order.indexOf('settings'));
                    assert.ok(before.every(k => k === 'main' || k.startsWith('tab:')), `${context}: after ordinary tabs, before actions`);
                  }
                }
              }
            });
          }
        }
      }
    } finally {
      setLanguage(previous);
    }
  }
});

test('below 24 columns Settings falls back to a compact label, never a gear alone', () => {
  for (const lang of ['en', 'zh'] as const) {
    const previous = setLanguage(lang);
    try {
      for (const lk of LOOKS) {
        for (const icons of ['unicode', 'nerd', 'emoji', 'text'] as const) {
          withConfig({ look: lk, icons }, () => {
            for (const width of [12, 16, 20, 23]) {
              for (const active of [false, true]) {
                const bar = controlBar(state({ tabbed: true }), { expired: 0, settingsActive: active }, width);
                for (const line of bar.lines) assert.equal(visualLength(line), width);
                const settings = bar.controls.filter(c => c.kind === 'settings');
                // Below the minimum labelled layout, only Main remains.
                if (!settings.length) {
                  assert.deepEqual(bar.controls.map(c => c.kind), ['main']);
                  continue;
                }
                const c = settings[0];
                const own = columns(stripAnsi(bar.lines[c.y]), c.x, c.width);
                assert.ok(own.includes(lang === 'zh' ? '设' : 'Set'), `${lang} ${lk} ${icons} ${width}: ${own}`);
                assert.doesNotMatch(own, /…/u, 'the compact label is a word, not an ellipsis');
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
      assert.equal(plain(state(), 24), ' ← 主  卡片   设置    ? ');
      assert.equal(plain(state(), 40), ' ← 主  卡片    设置          暂停 +31 ? ');
      assert.equal(
        plain(state(), 90),
        ' ← 主会话   卡片   时间线  改动  详情  设置                    暂停模型  +31 已收起  帮助 '
      );
    });
  });
  withConfig({ icons: 'text' }, () => {
    assert.match(plain(state(), 130, { brief: { paused: true }, expired: 2 }), /Settings +Resume models {2}\+2 older {2}Help $/, 'icons: text means words');
  });
  // The model label is the model badge's alone: set to text, the bar keeps its icons.
  withConfig({ glyphs: 'text', icons: 'unicode' }, () => {
    const bar = plain(state(), 130, { brief: { paused: true }, expired: 2 });
    assert.match(bar, /⌂ Main/, bar);
    assert.match(bar, /⚙ Settings +▶ Resume models {2}⊕ 2 finished {2}\? Help $/, bar);
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
        // Short of room what matters least goes first: the name, then the counts' words, then where the rows
        // are; the name comes back where what it made room for does not fit anyway.
        const counts = (words: boolean) => words ? '✓139 完成  ▸1 运行' : '✓139 ▸1';
        assert.equal(stripAnsi(head('agents', 31, { info: counts, right: '1–9/40' })), ' ▦  ✓139 完成  ▸1 运行  1–9/40 ');
        assert.equal(stripAnsi(head('agents', 30, { info: counts, right: '1–9/40' })), ' ▦ 卡片  ✓139 ▸1       1–9/40 ');
        assert.equal(stripAnsi(head('agents', 24, { info: counts, right: '1–9/40' })), ' ▦  ✓139 ▸1      1–9/40 ');
        assert.equal(stripAnsi(head('agents', 16, { info: counts, right: '1–9/40' })), ' ▦ 卡片  ✓139 ▸1');
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
    for (const entry of [/^m +主会话$/, /^o +切换到选中的$/, /^Enter \/ 空格 \/ v +详情$/, /^z +放大$/, /^F12 +开 \/ 关侧栏$/, /^Shift\+F12 +进入侧栏$/])
      assert.ok(lines.some(line => entry.test(line)), `${entry}\n${lines.join('\n')}`);
    assert.ok(lines.some(line => /^Ctrl\+\] +把 Ctrl\+\]/.test(line)), 'the prefix twice is one entry, its key the prefix');
    assert.equal(lines.filter(line => line.includes('Ctrl+]')).length, 2, 'nowhere else');
    const other = renderMonitor({
      tree,
      state: state({ help: true }),
      width: 32,
      height: 200,
      prefix: 'Ctrl+\\',
    }).lines.map(stripAnsi);
    assert.ok(other.some(line => /^m +主会话$/.test(line)) && other[1].includes('Ctrl+\\'), 'any prefix');
    // Too narrow for what a key does, it wraps under itself.
    const narrow = renderMonitor({ tree, state: state({ help: true }), width: 20, height: 200 }).lines.map(stripAnsi);
    const at = narrow.findIndex(line => /^r +\S/.test(line));
    const hang = narrow[at]?.match(/^r( +)/)?.[1].length;
    assert.ok(at > 0 && hang !== undefined && narrow[at + 1].startsWith(' '.repeat(hang + 1)), narrow.slice(at, at + 3).join('\n'));
  });
  for (const width of [28, 40, 70]) {
    const page = renderSettingsPage({ draft: defaultSettings(), selected: 0, offset: 0, message: '' }, width, 30);
    const foot = stripAnsi(page.lines.at(-1)!);
    assert.doesNotMatch(foot, /\bs save|r reset|Esc/, `${width}: ${foot}`);
    assert.match(stripAnsi(page.lines[0]), /^\[Back\] \[Save\] \[Reset group\]/);
  }
});

test('rich help explains selection and Inspector keys, with the latest-note field only when shown', async () => {
  const { renderMonitor } = await import('../../src/render/monitor.js');
  const tree = { rootId: 'r', nodes: [], totalCount: 0, updatedAt: new Date('2026-09-16T10:00:00Z') };
  const help = (cardSummary: boolean) => renderMonitor({tree,state:state({style:'rich',help:true,cardVisibility:{cardSummary}}),width:80,height:200}).lines.map(stripAnsi).join('\n');
  assert.match(help(true), /Click a card: select/);
  assert.match(help(true), /Enter \/ Space \/ v +inspect/);
  assert.match(help(true), /Click its name: select; double-click switches/);
  assert.match(help(true), /Latest note: written by a model/);
  assert.doesNotMatch(help(false), /Latest note: written by a model/);
  assert.doesNotMatch(help(true), /open \/ close card|Click a card: open|e \/ Space/);
});
