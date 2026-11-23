import { withState } from '../fixtures/state-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jobBoard, nativeBoard, drawAt, rowsOf, MIN, NOW } from '../fixtures/card-fold.mjs';
import { initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { SETTING_ROWS, handleSettingsInput, renderSettingsPage, resetSettingsGroup } from '../../dist/render/settings-page.js';
import { defaultSettings, loadSettings, saveSettings } from '../../dist/settings.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { currentWorker, foldedWorker } from '../../dist/render/work-visibility.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';

const temp = (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'card-fold-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const text = (frame) => frame.lines.map(stripAnsi).join('\n');
const press = (frame, key, target, tree) =>
  handleMonitorInput(withState(frame.state, { home: { cursor: { kind: 'work', target: target } } }), { type: 'key', key }, { tree, frame }).state;
const targetOf = (w) => ({ kind: 'worker', laneId: w.laneId, workerId: w.id });
// A settled HUD job and a settled native subagent, each as [board, tree, the card, its title].
const subjects = (t) => {
  const jobs = jobBoard(temp(t)), native = nativeBoard(temp(t));
  const child = native.board.workers.find((w) => w.task === 'Check parser tests');
  return [
    ['HUD job', jobs, undefined, jobs.workers.find((w) => w.task.startsWith('Add the retry')), /Add the retry helper/],
    ['native subagent', native.board, native.tree, child, /Check parser tests/],
  ];
};

test('a settled native subagent: default hides at 5 min; with Hide after 15m, folds at 5 min, Enter opens/folds, hides at 15 and shown by a', (t) => {
  // A HUD job's row is one row throughout and folds into the finished row at once: home-jobs.test.mjs.
  for (const [kind, board, tree, card, title] of subjects(t).filter(([kind]) => kind !== 'HUD job'))
    for (const [width, lang] of [[80, 'en'], [80, 'zh'], [120, 'en'], [120, 'zh']]) {
      const longHide = withState(initialMonitorState(), { prefs: { cardFoldMinutes: 5, cardHideMinutes: 15 } });
      const at = (m, state = longHide) => drawAt(board, state, m, width, lang, tree);
      const label = `${kind} ${width} ${lang}`;
      // Default settings (fold 5, hide 5): visible at 4.9m, hidden at 5m.
      assert.ok(rowsOf(drawAt(board, initialMonitorState(), 4.9, width, lang, tree), card).length > 1, `${label}: visible before 5 min`);
      assert.equal(rowsOf(drawAt(board, initialMonitorState(), 5, width, lang, tree), card).length, 0, `${label}: hidden at 5 min by default`);
      const early = at(4.9);
      assert.ok(rowsOf(early, card).length > 1, `${label}: not folded before 5 min`);
      assert.match(text(early), title);
      const folded = at(5);
      assert.equal(rowsOf(folded, card).length, 1, `${label}: one row at 5 min`);
      assert.match(stripAnsi(rowsOf(folded, card)[0].text), new RegExp(`^\\s*✓●? \\S+  ${title.source}.*\\d`), label);
      const open = at(5, press(folded, 'enter', targetOf(card), tree));
      assert.ok(rowsOf(open, card).length > 1, `${label}: Enter opens it in full`);
      assert.equal(rowsOf(at(5, press(open, 'enter', targetOf(card), tree)), card).length, 1, `${label}: Enter again folds it`);
      assert.equal(rowsOf(at(14.9), card).length, 1, `${label}: still on Home before 15 min`);
      const gone = at(15);
      assert.equal(rowsOf(gone, card).length, 0, `${label}: hidden at 15 min`);
      assert.match(text(gone), lang === 'en' ? /\+\d+ older · a/ : /另有 \d+ 项较早 · a/);
      const shown = at(15, press(gone, 'show-all', undefined, tree));
      assert.equal(rowsOf(shown, card).length, 1, `${label}: a shows it on one muted row`);
      if (lang === 'en') assert.match(text(shown), /\d+ older shown · a hide/);
      assert.equal(rowsOf(at(15, press(shown, 'show-all', undefined, tree)), card).length, 0, `${label}: a hides it again`);
      for (const frame of [early, folded, open, gone, shown]) for (const line of frame.lines) assert.equal(visualLength(line), width, label);
    }
});

test('a HUD job row never opens by itself; a card the owner opened stays open', (t) => {
  const board = jobBoard(temp(t)),
    newest = board.workers.find((w) => w.task.startsWith('Add the retry'));
  const longHide = withState(initialMonitorState(), { prefs: { cardFoldMinutes: 5, cardHideMinutes: 15 } });
  for (const m of [3.9, 5, 14]) {
    const frame = drawAt(board, longHide, m);
    assert.equal(frame.state.home.newestCard, undefined, `${m} min`);
    assert.equal(rowsOf(frame, newest).length, 1, `${m} min: one row, its sentence is in the Inspector`);
  }
  // Opened at 5 min by Enter, a card stays open until Enter folds it, past the next frames.
  const state = press(drawAt(board, longHide, 5), 'enter', targetOf(newest));
  assert.ok(rowsOf(drawAt(board, state, 9), newest).length > 1);
});

test('Fold after and Hide after: defaults, validator, rows, save, reset, and a changed value applies on the next frame', (t) => {
  const dir = temp(t), saved = { ...process.env };
  Object.assign(process.env, { HUD_HOME: dir, HUD_SETTINGS_PATH: join(dir, 'hud-settings.json') });
  t.after(() => { process.env = saved; });
  assert.deepEqual([defaultSettings().cardFoldMinutes, defaultSettings().cardHideMinutes], [5, 5]);
  const fold = SETTING_ROWS.find((r) => r.key === 'cardFoldMinutes'), hide = SETTING_ROWS.find((r) => r.key === 'cardHideMinutes');
  assert.deepEqual([fold.group, fold.label, fold.values], ['Panel', 'Fold after', [1, 2, 5, 10, 15, 30]]);
  assert.deepEqual([hide.group, hide.label, hide.values], ['Panel', 'Hide after', [5, 10, 15, 30, 60, 120]]);
  for (const bad of [0, 1441, 2.5, '5', null]) {
    saveSettings({ cardFoldMinutes: bad, cardHideMinutes: bad });
    assert.deepEqual([loadSettings().cardFoldMinutes, loadSettings().cardHideMinutes], [5, 5], String(bad));
  }
  saveSettings({ cardFoldMinutes: 1440, cardHideMinutes: 1 });
  assert.deepEqual([loadSettings().cardFoldMinutes, loadSettings().cardHideMinutes], [1440, 1]);
  // The page cycles each row and writes the value it shows.
  let state = { draft: defaultSettings(), selected: SETTING_ROWS.indexOf(fold), offset: 0, message: '' };
  const next = () => (state = handleSettingsInput(state, { type: 'key', key: 'right' }, renderSettingsPage(state, 80, 50)).state);
  next();
  assert.equal(state.draft.cardFoldMinutes, 10);
  state = { ...state, selected: SETTING_ROWS.indexOf(hide) };
  next();
  next();
  next();
  assert.equal(state.draft.cardHideMinutes, 30);
  const page = renderSettingsPage(state, 120, 50).lines.map(stripAnsi).join('\n');
  assert.match(page, /\* Panel · Fold after\s+10m/);
  assert.match(page, /Hide after\s+‹ 30m ›/);
  saveSettings(state.draft);
  assert.deepEqual([loadSettings().cardFoldMinutes, loadSettings().cardHideMinutes], [10, 30]);
  const reset = resetSettingsGroup(state.draft, 'Panel');
  assert.deepEqual([reset.cardFoldMinutes, reset.cardHideMinutes], [5, 5]);
  // Applied without a restart: the same board, the saved values on the next frame.
  const board = jobBoard(temp(t)), card = board.workers[0];
  const frame = (m, settings) => drawAt(board, initialMonitorState(settings), m);
  assert.equal(rowsOf(frame(7, defaultSettings()), card).length, 0, 'default: hidden at 7 min');
  assert.equal(rowsOf(frame(7, loadSettings()), card).length, 1, 'hide 30: on Home at 7 min');
  assert.equal(rowsOf(frame(29, loadSettings()), card).length, 1, 'hide 30: on Home at 29 min');
  assert.equal(rowsOf(frame(30, loadSettings()), card).length, 0, 'hide 30: gone at 30 min');
});

test('a hide time before the fold time is the fold time; failures and owner needs keep their own rules', (t) => {
  const board = jobBoard(temp(t)), card = board.workers[0];
  const short = { cardFoldMinutes: 10, cardHideMinutes: 5 };
  assert.equal(rowsOf(drawAt(board, initialMonitorState({ ...defaultSettings(), ...short }), 9), card).length, 1, 'on Home before the hide time');
  assert.equal(rowsOf(drawAt(board, initialMonitorState({ ...defaultSettings(), ...short }), 10), card).length, 0, 'gone when it would fold');
  const settled = { settledAt: NOW, homeNeedsHuman: false, state: 'done' };
  const worker = (extra) => ({ ...card, ...settled, ...extra });
  assert.ok(!currentWorker(worker({}), NOW + 5 * MIN) && currentWorker(worker({}), NOW + 5 * MIN - 1));
  const failed = worker({ state: 'failed' });
  for (const state of ['failed', 'stopped']) {
    const item = worker({ state });
    assert.ok(currentWorker(item, NOW + 29 * MIN) && !currentWorker(item, NOW + 30 * MIN), `unhandled ${state} caps at 30 min`);
  }
  assert.ok(!currentWorker(failed, NOW + 30 * MIN, { cardHideMinutes: 90 }), 'the cap also applies with a long hide time');
  assert.ok(foldedWorker(failed, NOW + 5 * MIN) && !foldedWorker(failed, NOW + 5 * MIN - 1));
  assert.ok(!foldedWorker(worker({ homeNeedsHuman: true }), NOW + 60 * MIN), 'a card needing the owner never folds');
  assert.ok(!foldedWorker(worker({ settledAt: null }), NOW + 60 * MIN), 'a running card never folds');
  assert.ok(currentWorker(worker({ state: 'failed', homeNeedsHuman: true }), NOW + 48 * 60 * MIN), 'a card needing the owner never hides');
});
