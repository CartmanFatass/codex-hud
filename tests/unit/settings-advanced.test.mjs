import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADVANCED,
  SETTING_ROWS,
  handleSettingsInput,
  renderSettingsPage,
  settingsDirty,
} from '../../dist/render/settings-page.js';
import { defaultSettings } from '../../dist/settings.js';
import { stripAnsi, theme, visualLength } from '../../dist/render/colors.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';

const EXPECTED_ADVANCED_LABELS = [
  'Bar style',
  'Icons',
  'Refresh',
  'Mouse',
  'Decision cap',
  'imp cap',
  'general cap',
  'imp→general overflow',
];

const plain = (frame) => frame.lines.map((line) => stripAnsi(line).trimEnd()).join('\n');

test('Settings folds the 8 rarely changed rows under Advanced by default and shows Models on the first screen at 40 and 100 columns', () => {
  const prevLang = setLanguage('en');
  const prevDisplay = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  try {
    const advancedRows = SETTING_ROWS.filter((row) => row.advanced);
    assert.deepEqual(advancedRows.map((row) => row.label), EXPECTED_ADVANCED_LABELS);
    assert.equal(ADVANCED, SETTING_ROWS.length);

    const draft = defaultSettings();
    const state = { draft, original: draft, selected: 0, offset: 0, message: '' };

    // 1. Default 40x24 frame: exact width, no advanced labels, Models visible on first screen.
    const narrow = renderSettingsPage(state, 40, 24);
    assert.equal(narrow.lines.length, 24);
    for (const line of narrow.lines) assert.equal(visualLength(line), 40, stripAnsi(line));
    const narrowText = plain(narrow);
    for (const row of advancedRows) assert.doesNotMatch(narrowText, new RegExp(`\\b${row.label}\\b`), row.label);
    assert.match(narrowText, /Models ─+/);
    assert.match(narrowText, /Decision API/);
    assert.doesNotMatch(narrowText, /Model text|Call cap/);
    assert.match(narrowText, /Sonic auto-thinking/);

    // At 40x36 and 100x36, both the pane strips and Advanced (8) are visible and exact width.
    for (const width of [40, 100]) {
      const tall = renderSettingsPage(state, width, 36);
      for (const line of tall.lines) assert.equal(visualLength(line), width, `${width}: ${stripAnsi(line)}`);
      const text = plain(tall);
      assert.match(text, /Herdr pane strips ─+.*\n.*Claude Code\s+off\n.*pi\s+off\n.*Antigravity\s+off/);
      assert.match(text, /Advanced \(8\)/);
      assert.match(text, /Models ─+/);
      for (const row of advancedRows) assert.doesNotMatch(text, new RegExp(`\\b${row.label}\\b`), `${width}:${row.label}`);
    }

    // Also verify Advanced (8) at 40x24 when selected on ADVANCED.
    const atAdvanced = renderSettingsPage({ ...state, selected: ADVANCED }, 40, 24);
    for (const line of atAdvanced.lines) assert.equal(visualLength(line), 40, stripAnsi(line));
    assert.match(plain(atAdvanced), /Advanced \(8\)/);
  } finally {
    setLanguage(prevLang);
    setDisplayConfig(prevDisplay);
  }
});

test('Enter, Left/Right and mouse click on Advanced toggle the 8 rows with source-group prefixes', () => {
  const prevLang = setLanguage('en');
  const prevDisplay = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  try {
    const draft = defaultSettings();
    let state = { draft, original: draft, selected: ADVANCED, offset: 0, message: '' };
    let frame = renderSettingsPage(state, 80, 48);
    assert.equal(frame.state.advanced, false);

    // 2. Enter expands Advanced and shows all 8 rows with source group prefixes.
    state = handleSettingsInput(state, { type: 'key', key: 'enter' }, frame).state;
    assert.equal(state.advanced, true);
    frame = renderSettingsPage(state, 80, 48);
    const expanded = plain(frame);
    for (const row of SETTING_ROWS.filter((r) => r.advanced)) {
      assert.match(expanded, new RegExp(`${row.group} · ${row.label}`), row.label);
    }

    // Enter again collapses Advanced.
    state = handleSettingsInput(state, { type: 'key', key: 'enter' }, frame).state;
    assert.equal(state.advanced, false);
    frame = renderSettingsPage(state, 80, 48);
    assert.doesNotMatch(plain(frame), /Bar style|Refresh|Decision cap|imp cap/);

    // Left/Right also toggle on ADVANCED.
    state = handleSettingsInput(state, { type: 'key', key: 'right' }, frame).state;
    assert.equal(state.advanced, true);
    frame = renderSettingsPage(state, 80, 48);
    state = handleSettingsInput(state, { type: 'key', key: 'left' }, frame).state;
    assert.equal(state.advanced, false);

    // 7. Mouse click on Advanced row toggles expansion and maps frame.rows to ADVANCED.
    frame = renderSettingsPage({ ...state, selected: 0 }, 80, 48);
    const advY = frame.rows.indexOf(ADVANCED);
    assert.ok(advY > 0, 'ADVANCED row mapped in frame.rows');
    const clicked = handleSettingsInput({ ...state, selected: 0 }, { type: 'mouse', button: 'left', x: 4, y: advY }, frame).state;
    assert.equal(clicked.selected, ADVANCED);
    assert.equal(clicked.advanced, true);
    const openFrame = renderSettingsPage(clicked, 80, 48);
    const clickedAgain = handleSettingsInput(clicked, { type: 'mouse', button: 'left', x: 4, y: openFrame.rows.indexOf(ADVANCED) }, openFrame).state;
    assert.equal(clickedAgain.advanced, false);
  } finally {
    setLanguage(prevLang);
    setDisplayConfig(prevDisplay);
  }
});

test('Folded unsaved changes and non-default values show * and active highlight on Advanced', () => {
  const prevLang = setLanguage('en');
  const prevDisplay = setDisplayConfig({ theme: 'titanium', icons: 'unicode' });
  try {
    const original = defaultSettings();
    const draft = { ...original, refreshMs: 2000 };
    const state = { draft, original, selected: 0, offset: 0, message: '', advanced: false };
    assert.equal(settingsDirty(state), true);

    // 3. Collapsed Advanced row shows * and active colour when a folded row changed.
    const frame = renderSettingsPage(state, 60, 40);
    const advLine = frame.lines[frame.rows.indexOf(ADVANCED)];
    assert.match(stripAnsi(advLine), /^\* Advanced \(8\)/);
    assert.ok(advLine.includes(theme.board.attention('*')), 'attention ink on *');
    assert.ok(advLine.includes(theme.board.active('closed ›')), 'active ink on folded non-default tail');
  } finally {
    setLanguage(prevLang);
    setDisplayConfig(prevDisplay);
  }
});

test('Collapsed navigation walks only visible rows plus ADVANCED; PageDown/PageUp/Home/End treat Advanced as one group', () => {
  const draft = defaultSettings();
  const start = { draft, original: draft, selected: 0, offset: 0, message: '' };
  for (const [impPlacement, sonicPlacement] of [['fixed', 'fixed'], ['even', 'fixed'], ['auto', 'even']]) {
    const expectedVisible = [
      ...SETTING_ROWS.flatMap((row, i) =>
        row.advanced ||
        row.key === 'dockHeight' ||
        (row.key === 'impEvenPool' && impPlacement !== 'even') ||
        (row.key === 'sonicEvenPool' && sonicPlacement !== 'even')
          ? [] : [i]),
      ADVANCED,
    ];
    let state = { ...start, draft: { ...draft, impPlacement, sonicPlacement } };
    const visited = [state.selected];
    // Down visits each pool row only in Even mode, and skips all folded rows.
    for (let step = 0; step < SETTING_ROWS.length + 2; step++) {
      const frame = renderSettingsPage(state, 80, 40);
      const next = handleSettingsInput(state, { type: 'key', key: 'down' }, frame).state;
      if (next.selected !== state.selected) visited.push(next.selected);
      state = next;
    }
    assert.deepEqual(visited, expectedVisible, `${impPlacement}/${sonicPlacement}`);
  }

  // Home/End while collapsed.
  let state = { ...start, selected: ADVANCED };
  state = handleSettingsInput(state, { type: 'key', key: 'home' }, renderSettingsPage(state, 80, 40)).state;
  assert.equal(state.selected, 0);
  state = handleSettingsInput(state, { type: 'key', key: 'end' }, renderSettingsPage(state, 80, 40)).state;
  assert.equal(state.selected, ADVANCED);

  // PageDown jumps Display -> Panel -> Models -> Codex -> Herdr pane strips -> Advanced.
  state = { ...state, selected: 0 };
  const jumped = [state.selected];
  for (let i = 0; i < 6; i++) {
    const next = handleSettingsInput(state, { type: 'key', key: 'page-down' }, renderSettingsPage(state, 80, 40)).state;
    if (next.selected !== state.selected) jumped.push(next.selected);
    state = next;
  }
  assert.deepEqual(jumped, [
    SETTING_ROWS.findIndex((r) => r.key === 'theme'),
    SETTING_ROWS.findIndex((r) => r.key === 'treeWidth'),
    SETTING_ROWS.findIndex((r) => r.key === 'decisionApi'),
    SETTING_ROWS.findIndex((r) => r.key === 'statusline'),
    SETTING_ROWS.findIndex((r) => r.key === 'claudePaneStrip'),
    ADVANCED,
  ]);
});

test('Reset on ADVANCED returns a hint without reset action; self-healing expands when selected points to a folded row', () => {
  const prevLang = setLanguage('en');
  const prevDisplay = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  try {
    const draft = defaultSettings();
    const advState = { draft, original: draft, selected: ADVANCED, offset: 0, message: '' };
    const advFrame = renderSettingsPage(advState, 80, 40);

    // 5. Pressing r on ADVANCED sets message and never returns 'reset'.
    const resetRes = handleSettingsInput(advState, { type: 'key', key: 'reset' }, advFrame);
    assert.notEqual(resetRes.action, 'reset');
    assert.equal(resetRes.action, undefined);
    assert.ok(resetRes.state.message.length > 0);
    assert.match(plain(renderSettingsPage(resetRes.state, 80, 40)), /Choose a row to reset its group/);

    // 6. Hot-reload self-healing: selected on refreshMs without advanced flag auto-expands.
    const foldIndex = SETTING_ROWS.findIndex((r) => r.key === 'refreshMs');
    const healed = renderSettingsPage({ draft, original: draft, selected: foldIndex, offset: 0, message: '' }, 40, 24);
    assert.equal(healed.state.advanced, true);
    assert.ok(healed.rows.includes(foldIndex), 'selected folded row is visible after self-heal');
    assert.match(plain(healed), /Panel · Refresh/);
  } finally {
    setLanguage(prevLang);
    setDisplayConfig(prevDisplay);
  }
});

test('Chinese locale localizes Advanced section, toggle, help, reset hint, and expanded group prefixes at 40 columns', () => {
  const prevLang = setLanguage('zh');
  const prevDisplay = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  try {
    const draft = defaultSettings();
    const collapsed = renderSettingsPage({ draft, original: draft, selected: ADVANCED, offset: 0, message: '' }, 40, 24);
    for (const line of collapsed.lines) assert.equal(visualLength(line), 40, stripAnsi(line));
    const collapsedText = plain(collapsed);
    assert.match(collapsedText, /高级 ─+/);
    assert.match(collapsedText, /高级（8）/);
    assert.match(collapsedText, /关闭 ›/);
    assert.match(collapsedText, /较少修改的设置/);

    const resetRes = handleSettingsInput(collapsed.state, { type: 'key', key: 'reset' }, collapsed);
    assert.equal(resetRes.action, undefined);
    assert.match(resetRes.state.message, /选择一行以重置该分组/);

    const expanded = renderSettingsPage({ ...collapsed.state, advanced: true }, 40, 48);
    for (const line of expanded.lines) assert.equal(visualLength(line), 40, stripAnsi(line));
    const expandedText = plain(expanded);
    assert.match(expandedText, /打开 ▾/);
    assert.match(expandedText, /显示 · 底栏样式/);
    assert.match(expandedText, /面板 · 刷新/);
    assert.match(expandedText, /模型 · 决策调用上限/);
    assert.match(expandedText, /工作者 · imp→general 溢出/);
  } finally {
    setLanguage(prevLang);
    setDisplayConfig(prevDisplay);
  }
});
