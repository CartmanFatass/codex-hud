import { withState } from '../fixtures/state-helpers.mjs';
import { homeTarget } from '../../dist/render/monitor-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageFixture, pageFrames, plainFrame, TREE, NOW } from '../fixtures/kept-pages.mjs';
import { renderMonitor, handleMonitorInput, initialMonitorState } from '../../dist/render/monitor.js';
import {
  renderSettingsPage,
  handleSettingsInput,
  SETTING_ROWS,
  resetSettingsGroup,
} from '../../dist/render/settings-page.js';
import { renderSettingsConfirmation, handleSettingsConfirmation } from '../../dist/render/settings-confirmation.js';
import { defaultSettings, loadSettings, saveSettings } from '../../dist/settings.js';
import { BAR_STYLES, setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, theme, visualLength } from '../../dist/render/colors.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
const expected = JSON.parse(readFileSync(new URL('../fixtures/kept-pages-frames.json', import.meta.url), 'utf8'));
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'kept-pages-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return pageFixture(home);
}
test("frames: all seven kept pages in Home's kit", (t) => {
  const f = fixture(t),
    frames = pageFrames(f);
  assert.deepEqual(frames, expected);
  for (const page of ['home', 'older', 'job', 'asking', 'settings', 'help', 'changes']) {
    // Read the scrolling Help body separately from the visible frame.
    const frame = f.render(page, 80, 'en', page === 'help' ? 54 : 40),
      text = plainFrame(frame).join('\n');
    if (page === 'older') {
      assert.match(text, /3 older shown · a hide/);
      assert.match(text, /✓●? imp  Add the retry helper\s+.*1h12m/);
    }
    if (page === 'home') {
      assert.match(text, /\+3 older · a/);
      assert.doesNotMatch(text, /Decided for you|Backoff with jitter, cap 30s/);
      assert.doesNotMatch(text, /Add the retry helper/);
    }
    if (page === 'job') {
      assert.match(text, /◉ imp  Retry on HTTP 429/);
      assert.match(text, /Files ─+ 4/);
      assert.doesNotMatch(text, /Time basis|Source details|Evidence time/);
    }
    if (page === 'settings') {
      assert.match(text, /Advanced \(13\)/);
      assert.doesNotMatch(text, /Bar style|imp cap/);
      assert.match(text, /Calls this hour\s+██▍░░░░░░░ 14\/60/);
      assert.match(text, /\* Call cap\s+‹ 120\/h ›/);
      assert.doesNotMatch(text, /Preview|Reset all|HUD read the session/);
    }
    if (page === 'help') {
      assert.doesNotMatch(text, /Home · Project/);
      const help = frame.workboard.rows.map((row) => stripAnsi(row.text)).join('\n');
      assert.match(help, /Backup skills ─+ 17/);
      assert.match(help, /m\s+role\/place: picker in this\s+pane;/);
      assert.match(help, /one click or Enter sets/);
      assert.match(help, /Esc\s+back; clear a filter first;\s+does nothing at a tab root/);
      assert.match(help, /Esc\s+picker: clear filter, then\s+close/);
      assert.match(help, /\^R\s+picker: refresh model lists/);
      assert.match(help, /Space\s+mark a to-try row/);
      assert.match(help, /Space\s+harness: on \/ off/);
      assert.match(help, /y n\s+accept \/ flag the marked/);
      assert.match(help, /i Del\s+place: add \/ remove; harness:\s+add back \/ off/);
      assert.match(help, /h\s+Roles \/ Harnesses/);
      assert.doesNotMatch(text, /\+ - K J|n N /);
      assert.match(text, /f\s+Changes/);
      assert.match(text, /← → Tab\s+switch tab \(a click too\)/);
      assert.match(text, /1-4 d\s+job: answer its open question/);
      assert.doesNotMatch(text, /Timeline|Mouse\s+Legend/);
    }
    if (page === 'changes') {
      assert.match(text, /^‹ Changes/m);
      assert.match(text, /branch\s+universal-hud/);
      assert.match(text, /untracked\s+2/);
    }
  }
});

test('all kept frames stay cell-exact in EN/ZH at 32–120 columns', (t) => {
  const f = fixture(t);
  for (const width of [32, 40, 56, 80, 120])
    for (const lang of ['en', 'zh'])
      for (const page of ['home', 'older', 'job', 'asking', 'settings', 'help', 'changes']) {
        const frame = f.render(page, width, lang, 40);
        assert.equal(frame.lines.length, 40);
        for (const line of frame.lines)
          assert.equal(visualLength(line), width, `${page} ${lang} ${width}: ${stripAnsi(line)}`);
      }
});
test('short Chinese minutes keep the Home ask slab and card rows clean at 38 and 40 columns', (t) => {
  const f = fixture(t);
  const askRow = (width) => plainFrame(f.render('home', width, 'zh', 40)).find((line) => line.startsWith('? imp · R5-UX'));
  assert.match(askRow(38), /提问中 4分$/);
  assert.match(askRow(40), /提问中 4分$/);
  const cardRow = (width) => plainFrame(f.render('home', width, 'zh', 40)).find((line) => line.includes('Retry on HTTP'));
  assert.match(cardRow(38), /47分$/);
  assert.match(cardRow(40), /47分$/);
});

test('the Inspector and expanded running cards show exactly one localized milestone in Classic and Split', (t) => {
  const f = fixture(t);
  const { id: workerId, laneId } = f.apiWorker;
  const target = { kind: 'worker', laneId, workerId };
  for (const [lang, label] of [['en', 'Milestone'], ['zh', '里程碑']]) for (const width of [40, 80]) {
    const lines = (frame) => frame.lines.filter((line) => stripAnsi(line).includes(`${label}: Retry cap verified`));
    const check = (frame) => {
      const rows = lines(frame);
      assert.equal(rows.length, 1);
      assert.equal(visualLength(rows[0]), width);
    };
    check(f.render('job', width, lang));
    const previous = setLanguage(lang);
    try {
      for (const panelLayout of ['classic', 'split']) {
        const state = withState(initialMonitorState(), { home: { split: { listCursor: targetKey({ kind: 'lane', laneId }) }, cursor: { kind: 'work', target: target } }, prefs: { panelLayout } });
        const draw = (expanded) => renderMonitor({ tree: TREE, workboard: f.board, width, height: 48, nowMs: NOW,
          state: withState(state, { home: { expanded: new Set(expanded ? [targetKey(target)] : []) } }),
        });
        assert.equal(lines(draw(false)).length, 0);
        check(draw(true));
      }
    } finally { setLanguage(previous); }
  }
});

test('Inspector shows elapsed run time for running and settled jobs, not for unknown endpoints', (t) => {
  const f = fixture(t);
  const nowMs = NOW + 18 * 60000;
  const draw = (worker) => {
    const board = { ...f.board, lanes: f.board.lanes.map((lane) => ({
      ...lane, workers: lane.workers.map((w) => w.id === worker.id ? worker : w),
    })), workers: f.board.workers.map((w) => w.id === worker.id ? worker : w) };
    return plainFrame(renderMonitor({
      tree: TREE, workboard: board, width: 40, height: 30, nowMs,
      state: withState(f.states.job, { subpage: { kind: 'inspector', scroll: 0, target: { kind: 'worker', laneId: worker.laneId, workerId: worker.id } } }),
    })).join('\n');
  };
  const settled = f.board.workers.find((w) => w.task === 'Add the retry helper');
  assert.match(draw(settled), /started\s+10:15[^\n]*\nended\s+11:23[^\n]*\nran\s+1h08m/);
  assert.match(draw(f.apiWorker), /started\s+11:48[^\n]*\nactivity[^\n]*\nran\s+1h05m/);
  assert.match(plainFrame(f.render('job', 40, 'zh')).join('\n'), /^用时\s+47分$/m);
  assert.doesNotMatch(draw({ ...f.apiWorker, startedAt: null }), /^ran\s/m);
  assert.doesNotMatch(draw({ ...settled, settledAt: null }), /^ran\s/m);
});

test('Inspector uses collected files, selects the open question/report/brief and opens exact QA pairs', (t) => {
  const f = fixture(t);
  const ctx = (frame) => ({ tree: TREE, frame, nowMs: NOW, standalone: true });
  let frame = f.render('asking', 80);
  assert.equal(frame.state.subpage?.cursor, 'file:' + join(f.ux, 'qa/q3.md'));
  const press = (key) => handleMonitorInput(frame.state, { type: 'key', key }, ctx(frame));
  assert.deepEqual(press('enter').action.files, [join(f.ux, 'qa/q3.md')]);
  const before = press('up').state;
  frame = renderMonitor({ tree: TREE, workboard: f.board, state: before, width: 80, height: 40, nowMs: NOW });
  assert.deepEqual(press('open-session').action.files, [join(f.ux, 'qa/q2.md'), join(f.ux, 'qa/q2.answer.md')]);
  for (const key of ['home-tab', 'project-tab', 'left', 'right', 'tab'])
    assert.equal(press(key).state.subpage?.kind, 'inspector');
  const rowAt = frame.lines.findIndex((s) => stripAnsi(s).startsWith('◇ q1'));
  assert.deepEqual(
    handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: 2, y: rowAt }, ctx(frame)).action.files,
    [join(f.ux, 'qa/q1.md'), join(f.ux, 'qa/q1.answer.md')]
  );
  const home = handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: 0, y: 0 }, ctx(frame)).state;
  assert.equal(home.subpage, undefined);
  assert.equal(f.render('job', 80).state.subpage?.cursor, 'file:' + join(f.api, 'brief.md'));
  const done = f.board.workers.find((w) => w.task === 'Check the retry tests');
  const report = renderMonitor({
    tree: TREE,
    workboard: f.board,
    state: withState(initialMonitorState(), { subpage: { kind: 'inspector', scroll: 0, target: { kind: 'worker', laneId: done.laneId, workerId: done.id } } }),
    width: 80,
    height: 40,
    nowMs: NOW,
  });
  assert.match(report.state.subpage?.cursor, /report\.md$/);
});
test('old rows have only muted ink, no band; expansion restores the card and a returns to a nearby row', (t) => {
  const f = fixture(t),
    previous = setDisplayConfig({ theme: 'titanium', icons: 'unicode' }),
    lang = setLanguage('en');
  t.after(() => {
    setDisplayConfig(previous);
    setLanguage(lang);
  });
  const old = f.board.workers.find((w) => w.task === 'Add the retry helper'),
    target = { kind: 'worker', laneId: old.laneId, workerId: old.id },
    key = targetKey(target);
  const draw = (state) => renderMonitor({ tree: TREE, workboard: f.board, state, width: 80, height: 60, nowMs: NOW });
  const frame = draw(withState(f.states.older, { home: { cursor: { kind: 'work', target: target } } }));
  const oldRow = frame.workboard.rows.find((r) => r.item === key);
  assert.equal(oldRow.text, theme.board.muted(stripAnsi(oldRow.text)));
  assert.ok(f.board.decisions.length);
  assert.ok(![...frame.workboard.targets.values()].some((target) => target.kind === 'decision'));
  const oldLane = f.board.lanes.find((l) => l.label === 'R5');
  const laneRow = frame.workboard.rows.find((r) => r.item === targetKey({ kind: 'lane', laneId: oldLane.id }));
  assert.equal(laneRow.text, theme.board.muted(stripAnsi(laneRow.text)));
  const act = (key) => handleMonitorInput(frame.state, { type: 'key', key }, { tree: TREE, frame, nowMs: NOW }).state;
  const expanded = draw(act('enter')).workboard.rows.filter((r) => r.item === key);
  assert.ok(expanded.length > 1);
  assert.notEqual(expanded[0].text, theme.board.muted(stripAnsi(expanded[0].text)));
  const hidden = draw(act('show-all'));
  assert.notDeepEqual(homeTarget(hidden.state.home), target);
  assert.equal(homeTarget(hidden.state.home).laneId, target.laneId);
});
test('Settings Bar style cycles the exported styles, saves barStyle, and ignores retired keys', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'page-settings-')),
    saved = { ...process.env };
  t.after(() => {
    process.env = saved;
    rmSync(home, { recursive: true, force: true });
  });
  process.env.HUD_SETTINGS_PATH = join(home, 'settings.json');
  writeFileSync(
    process.env.HUD_SETTINGS_PATH,
    JSON.stringify({
      modelEnabled: false,
      icons: 'emoji',
      look: 'pill',
      motion: 'full',
      art: 'ascii',
      artImage: '/synthetic/picture',
      statusCard: 'full',
      panelStyle: 'compact',
      cardCorners: 'round',
      cardClock: false,
      density: 'full',
      context: 'remaining',
      glyphs: 'glyph',
      sort: 'created',
      importantRoles: 'critic, oracle',
      agentColors: 'off',
      finishedLingerMs: 0,
    })
  );
  let draft = loadSettings();
  assert.equal(draft.icons, 'unicode');
  const retired = [
    'sort',
    'importantRoles',
    'agentColors',
    'finishedLingerMs',
    'look',
    'motion',
    'art',
    'artImage',
    'statusCard',
    'panelStyle',
    'cardCorners',
    'cardClock',
    'density',
    'context',
    'glyphs',
  ];
  for (const key of retired) {
    assert.equal(key in draft, false, key);
    assert.equal(SETTING_ROWS.some((row) => row.key === key), false, key);
  }
  const selected = SETTING_ROWS.findIndex((r) => r.key === 'barStyle');
  let state = { draft, original: draft, selected, offset: 0, message: '' };
  for (let i = 1; i <= BAR_STYLES.length; i++) {
    const frame = renderSettingsPage(state, 80, 40);
    state = handleSettingsInput(state, { type: 'key', key: 'right' }, frame).state;
    assert.equal(state.draft.barStyle, BAR_STYLES[i % BAR_STYLES.length]);
  }
  state = handleSettingsInput(state, { type: 'key', key: 'left' }, renderSettingsPage(state, 80, 40)).state;
  saveSettings(state.draft);
  assert.equal(loadSettings().barStyle, BAR_STYLES.at(-1));
  const stored = JSON.parse(readFileSync(process.env.HUD_SETTINGS_PATH, 'utf8'));
  for (const key of retired) assert.equal(key in stored, false, key);
  const sonic = SETTING_ROWS.findIndex((row) => row.key === 'sonicAutoThinking');
  assert.equal(loadSettings().sonicAutoThinking, false);
  state = { ...state, selected: sonic };
  state = handleSettingsInput(state, { type: 'key', key: 'right' }, renderSettingsPage(state, 80, 40)).state;
  saveSettings(state.draft);
  assert.equal(loadSettings().sonicAutoThinking, true);
  const reset = resetSettingsGroup({ ...state.draft, modelEnabled: true }, 'Models');
  assert.equal(reset.modelEnabled, false);
  assert.equal(reset.sonicAutoThinking, false);
  assert.equal(reset.model, state.draft.model);
  assert.equal(reset.modelCallsPerHour, state.draft.modelCallsPerHour);
});
test('Settings s saves and t tests through the standalone decoder', (t) => {
  const f = fixture(t), saved = { ...process.env };
  process.env.HUD_SETTINGS_PATH = join(f.api, 'keyboard-settings.json');
  t.after(() => { process.env = saved; });
  const decoder = new WorkbenchInputDecoder('workboard');
  const input = (raw) => decoder.push(Buffer.from(raw))[0];
  const draft = { ...defaultSettings(), modelEnabled: false };
  let state = { draft, original: draft, selected: SETTING_ROWS.findIndex((r) => r.key === 'barStyle'), offset: 0, message: '' };
  const press = (raw) => handleSettingsInput(state, input(raw), renderSettingsPage(state, 80, 40));
  state = press('\x1b[C').state;
  assert.equal(state.draft.barStyle, 'p10k');
  const save = press('s');
  assert.equal(save.action, 'save');
  saveSettings(save.state.draft);
  assert.equal(loadSettings().barStyle, 'p10k');
  assert.equal(press('t').action, undefined, 'test is Models-only');
  state = { ...state, selected: SETTING_ROWS.findIndex((r) => r.group === 'Models') };
  assert.equal(press('t').action, 'test-api');
  const dialog = renderSettingsConfirmation([], { choice: 'cancel' }, 80, 16, 0, state);
  assert.equal(handleSettingsConfirmation({ choice: 'cancel' }, input('s'), dialog).action, 'save');
  assert.equal(handleSettingsConfirmation({ choice: 'cancel' }, input('d'), dialog).action, 'discard');
  assert.equal(handleSettingsConfirmation({ choice: 'cancel' }, input('c'), dialog).action, 'cancel');
});

test('Settings keeps draft confirmation, selected help, and a one-row synthetic API result', (t) => {
  const draft = { ...defaultSettings(), modelCallsPerHour: 120, modelEnabled: true },
    original = { ...draft, modelCallsPerHour: 60 };
  const selected = SETTING_ROWS.findIndex((r) => r.key === 'modelCallsPerHour'),
    state = { draft, original, selected, offset: 0, message: '' };
  const frame = renderSettingsPage(state, 80, 40, {
    state: undefined,
    modelCalls: { today: 60, lastHour: 60, cap: 60 },
    probe: { running: false, rows: [{ tier: 'lite', model: 'synthetic', status: 'ok', elapsedMs: 412 }] },
  });
  const text = plainFrame(frame).join('\n');
  assert.match(text, /at the cap: sentences wait/);
  assert.match(text, /Test API\s+✓ 412 ms/);
  assert.doesNotMatch(text, /lite:|medium:/);
  assert.equal(
    handleSettingsInput(state, { type: 'mouse', button: 'left', y: 0, x: frame.saveX }, frame).action,
    'save'
  );
  const dialog = renderSettingsConfirmation(frame.lines, { choice: 'cancel' }, 80, 16, 1, state);
  assert.match(plainFrame(dialog).join('\n'), /┃ Call cap 60\/h → 120\/h/);
  assert.equal(
    handleSettingsConfirmation({ choice: 'cancel' }, { type: 'key', key: 'escape' }, dialog).action,
    'cancel'
  );
  assert.match(plainFrame(dialog).join('\n'), /1 changed/);
  for (const [choice, action] of [
    ['save', 'save'],
    ['discard', 'discard'],
    ['cancel', 'cancel'],
  ]) {
    const selected = { choice };
    assert.equal(handleSettingsConfirmation(selected, { type: 'key', key: 'enter' }, dialog).action, action);
  }
  for (const lang of ['en', 'zh']) {
    const previous = setLanguage(lang);
    try {
      const short = renderSettingsPage(state, 40, 10, {
        state: undefined,
        modelCalls: { today: 14, lastHour: 14, cap: 60 },
      });
      const body = plainFrame(short).join('\n');
      assert.match(body, lang === 'en' ? /Call cap/ : /调用上限/);
      assert.match(body, /14\/60/);
      const footer = stripAnsi(short.lines.at(-1));
      assert.match(footer, lang === 'en' ? /Esc back  \? help$/ : /Esc 返回(?:  t 测试)?  \? 帮助$/);
      assert.doesNotMatch(footer, /t test|r reset|r 重置/);
      assert.ok(short.state.offset > 0);
    } finally {
      setLanguage(previous);
    }
  }
});

test('Help is one contextual page, preserves Inspector selection, and marks have text-icon fallbacks', (t) => {
  const f = fixture(t),
    previous = setDisplayConfig({ theme: 'none', icons: 'text' }),
    lang = setLanguage('en');
  t.after(() => {
    setDisplayConfig(previous);
    setLanguage(lang);
  });
  const draw = (state, options = {}) =>
    renderMonitor({ tree: TREE, workboard: f.board, state, width: 80, height: 58, nowMs: NOW, ...options });
  const home = draw(f.states.home),
    text = plainFrame(home).join('\n');
  assert.match(text, /@ imp  Retry/);
  assert.doesNotMatch(text, /◉|●/);
  const asking = draw(f.states.asking),
    cursor = asking.state.subpage?.cursor;
  const ctx = (frame) => ({ tree: TREE, frame, nowMs: NOW });
  const opened = handleMonitorInput(asking.state, { type: 'key', key: 'help' }, ctx(asking)).state;
  const help = draw(opened, { mouse: false });
  const body = plainFrame(help).join('\n');
  assert.match(body, /jobs\s+@ running\s+\? asking\s+~ stalled/);
  assert.match(body, /\+ done\s+x failed\s+- stopped/);
  assert.doesNotMatch(body, /click|Codex's own panel|Timeline|press .* first/);
  assert.match(body, /switch tab/);
  assert.equal(help.state.subpage?.cursor, cursor);
  const returned = handleMonitorInput(help.state, { type: 'key', key: 'escape' }, ctx(help)).state;
  assert.equal(!!returned.help, false);
  assert.equal(returned.subpage?.kind, 'inspector');
  assert.equal(draw(returned).state.subpage?.cursor, cursor);
  const withMouse = plainFrame(draw({ ...opened, subpage: undefined }, { mouse: true })).join('\n');
  assert.match(withMouse, /click\s+select; again = ⏎; wheel\s+scrolls/);
  assert.doesNotMatch(withMouse, /press .* first/);
  setLanguage('zh');
  const chinese = plainFrame(draw({ ...opened, subpage: undefined }, { width: 120 })).join('\n');
  assert.doesNotMatch(chinese, /在 Codex 自带的面板中|press .*first/);
  assert.match(chinese, /c C\s+角色：下一个／上一个预设[\s\S]*m\s+角色或位置：本窗格选模型/);
  assert.match(chinese, /单击或按 Enter 设定。有\s*草稿则填入/);
  assert.match(chinese, /Esc\s+选择器：先清空筛选，再关闭/);
  assert.match(chinese, /\^R\s+选择器：刷新模型列表/);
  assert.doesNotMatch(chinese, /On Control|pick a model/);
});
