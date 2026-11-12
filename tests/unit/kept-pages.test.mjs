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
const expected = JSON.parse(readFileSync(new URL('../fixtures/kept-pages-frames.json', import.meta.url), 'utf8'));
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'kept-pages-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return pageFixture(home);
}
for (const page of ['home', 'older', 'job', 'asking', 'decision', 'settings', 'help', 'changes'])
  test(`frame: ${page} in Home's kit`, (t) => {
    const f = fixture(t),
      frames = pageFrames(f);
    for (const [key, text] of Object.entries(frames).filter(([key]) => key.startsWith(page + '-')))
      assert.deepEqual(text, expected[key], key);
    const frame = f.render(page, 80),
      text = plainFrame(frame).join('\n');
    if (page === 'older') {
      assert.match(text, /5 older shown · a hide/);
      assert.match(text, /✓ imp  Add the retry helper\s+done 1h12m/);
    }
    if (page === 'home') {
      assert.match(text, /\+5 older · a/);
      assert.doesNotMatch(text, /Add the retry helper/);
    }
    if (page === 'job') {
      assert.match(text, /◉ imp  Retry on HTTP 429/);
      assert.match(text, /Files ─+ 4/);
      assert.doesNotMatch(text, /Time basis|Source details|Evidence time/);
    }
    if (page === 'decision') {
      assert.match(text, /instead of\s+a: fixed 5s retry/);
      assert.match(text, /why\s+same policy as the payment client/);
    }
    if (page === 'settings') {
      assert.match(text, /Bar style\s+line/);
      assert.match(text, /Calls this hour\s+██▍░░░░░░░ 14\/60/);
      assert.match(text, /\* Call cap\s+‹ 120\/h ›/);
      assert.doesNotMatch(text, /Preview|Reset all|HUD read the session/);
    }
    if (page === 'help') {
      assert.match(text, /1\s+Home/);
      assert.match(text, /3\s+Changes/);
      assert.doesNotMatch(text, /Project|Timeline|Mouse\s+Legend/);
    }
    if (page === 'changes') {
      assert.match(text, /^‹ Changes/m);
      assert.match(text, /branch\s+universal-hud/);
      assert.match(text, /untracked\s+2/);
    }
  });

test('all kept frames stay cell-exact in EN/ZH at 32–120 columns', (t) => {
  const f = fixture(t);
  for (const width of [32, 40, 56, 80, 120])
    for (const lang of ['en', 'zh'])
      for (const page of ['home', 'older', 'job', 'asking', 'decision', 'settings', 'help', 'changes']) {
        const frame = f.render(page, width, lang, 40);
        assert.equal(frame.lines.length, 40);
        for (const line of frame.lines)
          assert.equal(visualLength(line), width, `${page} ${lang} ${width}: ${stripAnsi(line)}`);
      }
});
test('Inspector uses collected files, selects the open question/report/brief and opens exact QA pairs', (t) => {
  const f = fixture(t);
  const ctx = (frame) => ({ tree: TREE, frame, nowMs: NOW, standalone: true });
  let frame = f.render('asking', 80);
  assert.equal(frame.state.inspectCursor, 'file:' + join(f.ux, 'qa/q3.md'));
  const press = (key) => handleMonitorInput(frame.state, { type: 'key', key }, ctx(frame));
  assert.deepEqual(press('enter').action.files, [join(f.ux, 'qa/q3.md')]);
  const before = press('up').state;
  frame = renderMonitor({ tree: TREE, workboard: f.board, state: before, width: 80, height: 40, nowMs: NOW });
  assert.deepEqual(press('open-session').action.files, [join(f.ux, 'qa/q2.md'), join(f.ux, 'qa/q2.answer.md')]);
  for (const key of ['home-tab', 'project-tab', 'left', 'right', 'tab'])
    assert.equal(press(key).state.focus, 'details');
  const rowAt = frame.lines.findIndex((s) => stripAnsi(s).startsWith('◇ q1'));
  assert.deepEqual(
    handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: 2, y: rowAt }, ctx(frame)).action.files,
    [join(f.ux, 'qa/q1.md'), join(f.ux, 'qa/q1.answer.md')]
  );
  const home = handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: 0, y: 0 }, ctx(frame)).state;
  assert.equal(home.focus, 'agents');
  assert.equal(f.render('job', 80).state.inspectCursor, 'file:' + join(f.api, 'brief.md'));
  const done = f.board.workers.find((w) => w.task === 'Check the retry tests');
  const report = renderMonitor({
    tree: TREE,
    workboard: f.board,
    state: {
      ...initialMonitorState(),
      focus: 'details',
      modes: { agents: 'open', details: 'open', changes: 'closed' },
      boardInspect: { kind: 'worker', laneId: done.laneId, workerId: done.id },
    },
    width: 80,
    height: 40,
    nowMs: NOW,
  });
  assert.match(report.state.inspectCursor, /report\.md$/);
  frame = f.render('decision', 80);
  assert.deepEqual(press('enter').action.files, [join(f.api, 'qa/q2.md')]);
  frame = renderMonitor({
    tree: TREE,
    workboard: f.board,
    state: press('down').state,
    width: 80,
    height: 40,
    nowMs: NOW,
  });
  assert.deepEqual(press('enter').action.files, [join(f.api, 'qa/q2.answer.md')]);
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
  const frame = draw({ ...f.states.older, homeTarget: target });
  const oldRow = frame.workboard.rows.find((r) => r.item === key);
  assert.equal(oldRow.text, theme.board.muted(stripAnsi(oldRow.text)));
  const oldDecision = f.board.decisions.find(
    (d) => d.evidence[0].relativePath === 'qa/q1.md' && d.evidence[0].sourceId.endsWith('1')
  );
  const decisionRow = frame.workboard.rows.find(
    (r) => r.item === targetKey({ kind: 'decision', laneId: oldDecision.laneId, decisionId: oldDecision.id })
  );
  assert.equal(decisionRow.text, theme.board.muted(stripAnsi(decisionRow.text)));
  const oldLane = f.board.lanes.find((l) => l.label === 'R5');
  const laneRow = frame.workboard.rows.find((r) => r.item === targetKey({ kind: 'lane', laneId: oldLane.id }));
  assert.equal(laneRow.text, theme.board.muted(stripAnsi(laneRow.text)));
  const act = (key) => handleMonitorInput(frame.state, { type: 'key', key }, { tree: TREE, frame, nowMs: NOW }).state;
  const expanded = draw(act('enter')).workboard.rows.filter((r) => r.item === key);
  assert.ok(expanded.length > 1);
  assert.notEqual(expanded[0].text, theme.board.muted(stripAnsi(expanded[0].text)));
  const hidden = draw(act('show-all'));
  assert.notDeepEqual(hidden.state.homeTarget, target);
  assert.equal(hidden.state.homeTarget.laneId, target.laneId);
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
  const reset = resetSettingsGroup({ ...state.draft, modelEnabled: true }, 'Models');
  assert.equal(reset.modelEnabled, false);
  assert.equal(reset.model, state.draft.model);
  assert.equal(reset.modelCallsPerHour, state.draft.modelCallsPerHour);
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
      assert.match(stripAnsi(short.lines.at(-1)), lang === 'en' ? /esc back/ : /esc 返回/);
      assert.doesNotMatch(stripAnsi(short.lines.at(-1)), /t test|t 测试/);
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
    renderMonitor({ tree: TREE, workboard: f.board, state, width: 80, height: 40, nowMs: NOW, ...options });
  const home = draw(f.states.home),
    text = plainFrame(home).join('\n');
  assert.match(text, /@ imp  Retry/);
  assert.doesNotMatch(text, /◉|●/);
  const asking = draw(f.states.asking),
    cursor = asking.state.inspectCursor;
  const ctx = (frame) => ({ tree: TREE, frame, nowMs: NOW });
  const opened = handleMonitorInput(asking.state, { type: 'key', key: 'help' }, ctx(asking)).state;
  const help = draw(opened, { mouse: false, embedded: false });
  const body = plainFrame(help).join('\n');
  assert.match(body, /\+ done\s+@ running/);
  assert.doesNotMatch(body, /click selects|Codex's own panel|Project|Timeline/);
  assert.equal(help.state.inspectCursor, cursor);
  const returned = handleMonitorInput(help.state, { type: 'key', key: 'escape' }, ctx(help)).state;
  assert.equal(returned.help, false);
  assert.equal(returned.focus, 'details');
  assert.equal(draw(returned).state.inspectCursor, cursor);
  const embedded = plainFrame(
    draw({ ...opened, focus: 'agents' }, { mouse: true, embedded: true, prefix: 'Ctrl+X' })
  ).join('\n');
  assert.match(embedded, /click selects/);
  assert.match(embedded, /press Ctrl\+X first/);
});
