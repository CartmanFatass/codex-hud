import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acceptanceTasks } from '../../dist/collectors/acceptance-tasks.js';
import { defaultSettings, loadSettings, saveSettings } from '../../dist/settings.js';
import { handleMonitorInput, monitorSettings } from '../../dist/render/monitor.js';
import { handleSettingsInput, renderSettingsPage, SETTING_ROWS } from '../../dist/render/settings-page.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { renderHtmlBoard } from '../../dist/render/html-board.js';
import { visualLength } from '../../dist/render/colors.js';
import { NOW, TREE, plain, onPage } from '../fixtures/project-page.mjs';
import { splitFixture } from '../fixtures/split-layout.mjs';

const taskItem = 'project:fold:task:milestone:M-ALPHA';
const memberIds = ['THIRD', 'SECOND', 'FIRST'];
const temp = (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'project-acceptance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

async function fixture(t) {
  const f = await splitFixture(temp(t), { idle: true });
  const row = (id, milestone, text, age) => ({ id, milestone, text, state: 'try', at: NOW - age * 3600000 });
  const ledger = [row('FIRST', 'M-ALPHA', 'First slice: keep the old route.', 30), row('SECOND', 'M-ALPHA', 'Second slice: add a compact detail.', 12),
    { ...row('THIRD', 'M-ALPHA', 'Third slice: original ledger text.', 8), brief: { brief: 'Third slice: show the preview.', steps: ['Open the preview.'] } },
    row('SOLO', '—', 'An independent slice.', 5)];
  const data = { ...f.data, summary: 'Synthetic acceptance queue', ledger, tickets: [], slices: [], active: [], next: [],
    counts: { working: 0, blocked: 0, try: 4, accepted: 0, todo: 0, dropped: 0 }, ladder: { ids: ['M-ALPHA'], current: 'M-ALPHA' },
    waiting: [{ value: 'Confirm the sample workspace.', path: f.data.statePath }] };
  const draw = (state, width = 40, lang = 'en') => f.render(width, lang, 36, state, data);
  return { ...f, data, draw };
}
const press = (frame, key, text) => handleMonitorInput(frame.state, { type: 'key', key, text }, { tree: TREE, frame, nowMs: NOW });
const targetIds = (target) => target?.slices.map((r) => r.id);

test('grouping excludes other states and keeps rows without a milestone separate', () => {
  const row = (id, milestone, state = 'try', at) => ({ id, milestone, state, at, text: id });
  const ledger = [row('a', 'M1', 'try', 500), row('b', 'M1', 'accepted', 100), row('c', 'M1', 'try', 200),
    row('d', 'M1'), row('e', '—'), row('f', '—'), row('g', ''), row('h', '')];
  const groups = acceptanceTasks(ledger);
  assert.deepEqual(groups.map(targetIds), [['a', 'c', 'd'], ['e'], ['f'], ['g'], ['h']]);
  assert.equal(groups[0].oldest, 200);
});

test('Acceptance defaults to task and the Panel setting persists slice, with bilingual labels', (t) => {
  const path = join(temp(t), 'hud-settings.json'), previousPath = process.env.HUD_SETTINGS_PATH;
  process.env.HUD_SETTINGS_PATH = path;
  t.after(() => { if (previousPath === undefined) delete process.env.HUD_SETTINGS_PATH; else process.env.HUD_SETTINGS_PATH = previousPath; });
  assert.equal(loadSettings().acceptance, 'task');
  const selected = SETTING_ROWS.findIndex((row) => row.key === 'acceptance' && row.group === 'Panel');
  assert.ok(selected >= 0);
  const state = { selected, offset: 0, message: '', draft: defaultSettings(), original: defaultSettings() };
  const previous = setLanguage('en');
  t.after(() => setLanguage(previous));
  let frame = renderSettingsPage(state, 40, 24);
  assert.match(plain(frame).join('\n'), /Acceptance\s+‹ task ›/);
  const draft = handleSettingsInput(frame.state, { type: 'key', key: 'right' }, frame).state;
  saveSettings(draft.draft);
  assert.equal(JSON.parse(fs.readFileSync(path)).acceptance, 'slice');
  assert.equal(monitorSettings(loadSettings()).acceptance, 'slice');
  setLanguage('zh');
  frame = renderSettingsPage(draft, 40, 24);
  assert.match(plain(frame).join('\n'), /验收\s+‹ 按切片 ›/);
  fs.writeFileSync(path, JSON.stringify({ acceptance: 'unknown' }));
  assert.equal(loadSettings().acceptance, 'task');
});

test('task acceptance in all Progress layouts keeps one row, the oldest age and all slices under filter and keys', async (t) => {
  const f = await fixture(t);
  for (const panelLayout of ['classic', 'split']) for (const projectLayout of ['timeline', 'board', 'inbox']) {
    const state = () => onPage('progress', { acceptance: undefined, panelLayout, projectLayout, projectCursor: taskItem });
    const frame = f.draw(state());
    const rows = frame.panes[0].rows.filter((r) => r.tryTarget);
    assert.equal(rows.length, 2, `${panelLayout}/${projectLayout}`);
    assert.match(rows.find((r) => r.item === taskItem).text, /M-ALPHA.*3 slices.*1d/);
    assert.deepEqual(targetIds(rows.find((r) => r.item === taskItem).tryTarget), memberIds);
    assert.deepEqual(targetIds(rows.find((r) => r.item.endsWith(':SOLO')).tryTarget), ['SOLO']);
    const detail = panelLayout === 'classic' ? f.draw(press(frame, 'enter').state) : frame;
    assert.match(plain(detail).join('\n'), /First slice: keep the old route\./);
    assert.match(plain(detail).join('\n'), /Third slice: show the preview\./);
    assert.match(plain(detail).join('\n'), /Open the preview\./);
    const marked = f.draw(press(frame, 'space').state);
    assert.deepEqual(targetIds(marked.state.trySelection.get(taskItem)), memberIds);
    for (const key of ['try-accept', 'try-flag']) {
      const out = press(marked, key);
      assert.equal(out.action?.type, 'record-try');
      assert.equal(out.action?.target.milestone, 'M-ALPHA');
      assert.deepEqual(targetIds(out.action?.target), memberIds);
    }
    const filtered = f.draw({ ...state(), filterQuery: 'compact detail' });
    assert.match(plain(filtered).join('\n'), /1 match/);
    assert.deepEqual(targetIds(press(filtered, 'try-accept').action?.target), memberIds);
  }
});

test('Home task rows expose the same members and acceptance actions in Classic and Split', async (t) => {
  const f = await fixture(t);
  for (const panelLayout of ['classic', 'split']) {
    const state = { ...onPage(undefined, { acceptance: 'task', panelLayout }), mainTab: 'home', boardAnchor: taskItem,
      splitCursor: 'home-progress:waiting', splitFocus: 'preview', splitSub: taskItem };
    const frame = f.draw(state, 80);
    assert.equal(frame.state.boardAnchor, taskItem);
    assert.deepEqual(targetIds(press(frame, 'space').state.trySelection.get(taskItem)), memberIds);
    assert.deepEqual(targetIds(press(frame, 'try-accept').action.target), memberIds);
    const opened = f.draw(press(frame, 'enter').state, 80);
    assert.match(plain(opened).join('\n'), /First slice: keep the old route\./);
  }
});

test('Home and the hub use task counts; the synthetic HTML board honors both modes', async (t) => {
  const f = await fixture(t);
  const frames = [];
  for (const lang of ['en', 'zh']) for (const width of [40, 120]) for (const panelLayout of ['classic', 'split']) {
    const render = (label, state) => {
      const frame = f.draw({ panelLayout, ...state }, width, lang), lines = plain(frame);
      assert.ok(frame.lines.every((line) => visualLength(line) === width));
      frames.push(`### ${label} — ${panelLayout}, ${lang.toUpperCase()}, ${width} columns\n\n\x60\x60\x60text\n${lines.map((line) => line.trimEnd()).join('\n')}\n\x60\x60\x60\n`);
      return frame;
    };
    assert.ok(f.board.decisions.length > 0);
    const home = render('Home', { ...onPage(undefined, { acceptance: 'task' }), mainTab: 'home', splitCursor: 'home-progress:waiting' });
    assert.doesNotMatch(plain(home).join('\n'), /Decided for you|已替你决定|Use the synthetic layout/);
    assert.ok(![...home.workboard.targets.values()].some((target) => target.kind === 'decision'));
    assert.equal(home.workboard.snapshot.decisions.length, f.board.decisions.length);
    for (const acceptance of ['task', 'slice']) {
      const hub = render(`Project hub — ${acceptance}`, onPage(undefined, { acceptance, projectCursor: 'project:page:progress' }));
      const n = acceptance === 'task' ? 2 : 4;
      assert.match(plain(hub).join('\n'), new RegExp(`${n} ${lang === 'zh' ? '待试用' : 'to try'}`));
      const progress = onPage('progress', { acceptance,
        projectCursor: acceptance === 'task' ? taskItem : 'project:slice:THIRD',
        ...(panelLayout === 'classic' && acceptance === 'slice' ? { projectTry: { scroll: 0 } } : {}) });
      render(`Progress — ${acceptance}`, progress);
    }
  }
  const html = (acceptance) => renderHtmlBoard({ projectName: 'Synthetic', root: '/synthetic', project: f.data, workboard: f.board, generatedAt: NOW, lang: 'en', acceptance });
  assert.match(html(undefined), /href="#try">To try 2<\/a>/);
  assert.match(html(undefined), /<summary><span class="id">M-ALPHA<\/span>.*?3 slices.*?30h ago/);
  assert.match(html(undefined), /<summary><span class="id">— SOLO<\/span>.*?1 slice/);
  assert.match(html(undefined), /Open the preview\./);
  assert.doesNotMatch(html(undefined), /Decided for you|Use the synthetic layout/);
  assert.match(html('slice'), /href="#try">To try 4<\/a>/);
  assert.doesNotMatch(html('slice'), /<summary><span class="id">/);
  if (process.env.ACCEPTANCE_FRAMES) fs.writeFileSync(process.env.ACCEPTANCE_FRAMES, frames.join('\n'));
});
