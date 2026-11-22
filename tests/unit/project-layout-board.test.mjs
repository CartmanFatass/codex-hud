import { withState, sliceState } from '../fixtures/state-helpers.mjs';
/** PROJECT-LAYOUTS 01: `projectLayout` setting and the Board project layout (Split and Classic, EN and ZH at 40 columns). */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings, loadSettings, saveSettings } from '../../dist/settings.js';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { SETTING_ROWS, handleSettingsInput, renderSettingsPage, resetSettingsGroup } from '../../dist/render/settings-page.js';
import { withDisplaySettings } from '../../dist/settings-runtime.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { tryCount } from '../../dist/render/project-view.js';
import { splitFixture, split, layoutDriver as driver, assertWidth, assertNoMidWordCut } from '../fixtures/split-layout.mjs';
import { listFixture } from '../fixtures/project-list.mjs';
import { NOW, onPage, plain } from '../fixtures/project-page.mjs';

let sharedRoot, busy, lists;
before(async () => {
  sharedRoot = fs.mkdtempSync(join(tmpdir(), 'project-board-'));
  [busy, lists] = await Promise.all([splitFixture(join(sharedRoot, 'busy')), listFixture(join(sharedRoot, 'lists'))]);
});
after(() => fs.rmSync(sharedRoot, { recursive: true, force: true }));
async function fixture() { return { root: sharedRoot, busy, lists }; }

test('Settings → Panel → Project layout defaults to Timeline, cycles Timeline/Board/Inbox, saves, resets and translates', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'board-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'hud-settings.json'), saved = { ...process.env };
  process.env.HUD_SETTINGS_PATH = path;
  t.after(() => { process.env = saved; });

  assert.equal(defaultSettings().projectLayout, 'timeline');
  assert.equal(initialMonitorState(defaultSettings()).prefs.projectLayout, 'timeline');

  const selected = SETTING_ROWS.findIndex((r) => r.key === 'projectLayout');
  assert.ok(selected >= 0, 'projectLayout setting row exists');
  assert.equal(SETTING_ROWS[selected].group, 'Panel');
  assert.deepEqual(SETTING_ROWS[selected].values, ['timeline', 'board', 'inbox']);

  let state = { draft: defaultSettings(), original: defaultSettings(), selected, offset: 0, message: '' };
  for (const expected of ['board', 'inbox', 'timeline']) {
    const frame = withDisplaySettings(state.draft, () => renderSettingsPage(state, 40, 24));
    assertWidth(frame, 40, `settings en ${state.draft.projectLayout}`);
    state = handleSettingsInput(state, { type: 'key', key: 'right' }, frame).state;
    assert.equal(state.draft.projectLayout, expected);
  }
  state = handleSettingsInput(state, { type: 'key', key: 'right' }, renderSettingsPage(state, 40, 24)).state;
  saveSettings(state.draft);
  assert.equal(loadSettings().projectLayout, 'board');
  assert.equal(initialMonitorState(loadSettings()).prefs.projectLayout, 'board');
  assert.equal(resetSettingsGroup(state.draft, 'Panel').projectLayout, 'timeline');

  // Unknown value falls back to default timeline.
  fs.writeFileSync(path, JSON.stringify({ projectLayout: 'unknown-layout' }));
  assert.equal(loadSettings().projectLayout, 'timeline');

  // EN and ZH settings labels fit 40 columns.
  const prev = setLanguage('zh');
  try {
    const zh = withDisplaySettings({ ...defaultSettings(), projectLayout: 'board', theme: 'none' }, () =>
      renderSettingsPage({ draft: { ...defaultSettings(), projectLayout: 'board' }, selected, offset: 0, message: '' }, 40, 24));
    assertWidth(zh, 40, 'settings zh');
    assert.match(plain(zh).join('\n'), /项目布局\s+‹ 看板 ›/);
  } finally { setLanguage(prev); }
});

test('Board leaves Home, Control plane and Tickets unchanged and has no Control page on the hub', async (t) => {
  const { busy } = await fixture(t);
  const control = { ...busy.control, radar: undefined };
  for (const panelLayout of ['classic', 'split']) {
    const base = (extra) => (withState(sliceState(), { prefs: { panelLayout } }, extra));
    assert.deepEqual(plain(busy.render(40, 'en', 32, base({ activeTab: 'home', prefs: { projectLayout: 'board' } }))),
      plain(busy.render(40, 'en', 32, base({ activeTab: 'home', prefs: { projectLayout: 'timeline' } }))), `${panelLayout}: Home unchanged`);
    assert.deepEqual(plain(busy.render(40, 'en', 32, base({ activeTab: 'project', prefs: { projectLayout: 'board' }, project: { view: { kind: 'tickets' } } }))),
      plain(busy.render(40, 'en', 32, base({ activeTab: 'project', prefs: { projectLayout: 'timeline' }, project: { view: { kind: 'tickets' } } }))), `${panelLayout}: Tickets unchanged`);
    for (const lang of ['en', 'zh']) {
      const board = { prefs: { panelLayout, projectLayout: 'board' } };
      const hub = busy.render(40, lang, 36, onPage(undefined, board), control);
      assert.ok(!hub.workboard.rows.some((r) => r.item === 'project:page:control'));
      const controlState = withState(split(), { activeTab: 'control', prefs: { panelLayout } });
      assert.deepEqual(busy.render(40, lang, 36, { ...controlState, ...board }, control).lines, busy.render(40, lang, 36, controlState, control).lines);
    }
  }
});

test('Board hub at 40 cols EN and ZH (Split and Classic): exact width, no mid-word cut, counts equal Timeline, +N on full milestone', async (t) => {
  const { busy } = await fixture(t);
  const tries = tryCount(busy.control, 'slice');
  for (const lang of ['en', 'zh']) {
    for (const layout of ['split', 'classic']) {
      const state = layout === 'split' ? split({ activeTab: 'project', prefs: { projectLayout: 'board' } }) : onPage(undefined, { prefs: { projectLayout: 'board' } });
      const timelineState = layout === 'split' ? split({ activeTab: 'project', prefs: { projectLayout: 'timeline' } }) : onPage(undefined, { prefs: { projectLayout: 'timeline' } });
      const frame = busy.render(40, lang, 34, state, busy.control);
      const timeline = busy.render(40, lang, 34, timelineState, busy.control);
      assertWidth(frame, 40, `hub ${layout} ${lang}`);
      const lines = plain(frame), text = lines.join('\n'), tText = plain(timeline).join('\n');
      const corpus = [busy.control.summary, ...busy.control.waiting.map((w) => w.value), ...busy.control.active.map((j) => j.title ?? ''), ...busy.control.ledger.map((r) => r.text)].join(' ');
      assertNoMidWordCut(lines, corpus, `hub ${layout} ${lang}`);
      // Tab badge ?N and Waiting/Progress to-try counts match Timeline exactly.
      assert.equal(lines[0], plain(timeline)[0], `${layout} ${lang}: tab row identical`);
      const tryWord = lang === 'zh' ? `${tries} 待试用` : `${tries} to try`;
      assert.ok(tText.includes(tryWord) && text.includes(tryWord), `${layout} ${lang}: to-try count equals Timeline (${tryWord})`);
      // Milestone map rows, latest line, legend row, gauges.
      assert.match(text, /0\.1\.3 ◐◆◇○/);
      assert.match(text, lang === 'zh' ? /最近 ◇ DATA-ONE/ : /latest ◇ DATA-ONE/);
      assert.match(text, lang === 'zh' ? /✓ 完成 ◇ 待试用 ◐ 现在 ◆ 受阻 ○ 待办/ : /✓ done ◇ to try ◐ now ◆ blocked ○ todo/);
      assert.ok(!frame.workboard.rows.some((r) => r.item === 'project:page:control'));
      if (lang === 'zh') assert.doesNotMatch(text, /\b(latest|In flight|on fallback|to try|blocked|working|Control plane|Working tree)\b/);
    }
  }
  // Overflow: a milestone with 30 slices says +N rather than overflowing 40 columns.
  const huge = {
    ...busy.rich,
    ledger: Array.from({ length: 30 }, (_, i) => ({ id: `S-${i + 1}`, state: i < 20 ? 'accepted' : 'todo', milestone: '0.1.3', text: `slice ${i + 1}`, at: NOW - 3600_000 })),
  };
  for (const lang of ['en', 'zh']) {
    const frame = busy.render(40, lang, 30, onPage(undefined, { prefs: { projectLayout: 'board' } }), huge);
    assertWidth(frame, 40, `hub overflow ${lang}`);
    assert.match(plain(frame).join('\n'), /0\.1\.3 [✓○]+\+\d+\s+20\/30/);
  }
});

test('Board Progress at 40 cols EN and ZH (Split and Classic): cell order, brief sentence + details, Space/y/n, older milestones, unsliced jobs, Next', async (t) => {
  const { busy } = await fixture(t);
  const briefed = {
    ...busy.rich,
    ledger: busy.rich.ledger.map((r) => (r.id === 'DATA-ONE'
      ? { ...r, brief: { brief: 'Board layout added beside Timeline. Older milestones stay compact.', steps: ['Open Project tab', 'Check 40 columns'] } }
      : r)),
  };
  const tries = tryCount(briefed, 'slice');
  for (const lang of ['en', 'zh']) {
    for (const layout of ['split', 'classic']) {
      const state = layout === 'split' ? split({ activeTab: 'project', prefs: { projectLayout: 'board' }, project: { view: { kind: 'progress' } } }) : onPage('progress', { prefs: { projectLayout: 'board' } });
      const frame = busy.render(40, lang, 38, state, briefed);
      assertWidth(frame, 40, `progress ${layout} ${lang}`);
      const lines = plain(frame), text = lines.join('\n');
      const corpus = [briefed.summary, ...briefed.active.map((j) => j.title ?? ''), ...briefed.next.map((n) => n.value), ...briefed.ledger.map((r) => `${r.text} ${r.brief?.brief ?? ''}`)].join(' ');
      assertNoMidWordCut(lines, corpus, `progress ${layout} ${lang}`);
      // Current milestone slices appear in ledger cell order: PAGE-ONE, PAGE-TWO, DATA-ONE, LATER-ONE.
      const order = ['PAGE-ONE', 'PAGE-TWO', 'DATA-ONE', 'LATER-ONE'].map((id) => text.indexOf(id));
      assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2] && order[2] < order[3], `${layout} ${lang}: cell order preserved`);
      // Brief's first sentence shown on the to-try row; older milestones as map rows; unsliced jobs and Next present.
      assert.match(text, /Board layout added beside Timeline\./);
      assert.match(text, /M4\s+✓◇◇◇\s+1\/4/);
      assert.match(text, lang === 'zh' ? /台账外任务/ : /Outside the ledger/);
      assert.match(text, lang === 'zh' ? /下一步/ : /Next/);
      assert.ok(text.includes(lang === 'zh' ? `${tries} 待试用` : `${tries} to try`), `${layout} ${lang}: Progress to-try count equals Timeline`);
      // No state word repeated twice on any row.
      for (const line of lines) for (const word of ['working', 'blocked', 'to try', '工作中', '受阻', '待试用']) {
        assert.ok(line.split(word).length <= 2, `${layout} ${lang}: duplicate "${word}" in "${line}"`);
      }
      if (lang === 'zh') assert.doesNotMatch(text, /\b(Milestones|Outside the ledger|Next|to try|working|blocked)\b/);
    }
  }
  // Split: selecting DATA-ONE previews brief, steps and folded Ledger line; Space/y/n act on it.
  const sp = driver(busy, { data: briefed, state: split({ activeTab: 'project', project: { nav: { cursor: 'project:slice:DATA-ONE' }, view: { kind: 'progress' } }, prefs: { projectLayout: 'board' } }) });
  const spText = sp.lines().join('\n');
  assert.match(spText, /How to try/);
  assert.match(spText, /1\. Open Project tab/);
  assert.match(spText, /▸ Ledger line/);
  sp.run('space');
  assert.match(sp.lines().join('\n'), /▣ ◇ DATA-ONE/);
  assert.deepEqual(sp.run('try-accept').action.target.slices.map((s) => s.id), ['DATA-ONE']);
  assert.equal(sp.run({ type: 'key', key: 'try-flag', text: 'n' }).action.action, 'flag');

  // Classic: Enter on DATA-ONE expands brief + steps + folded Ledger line; Space/y/n work directly without projectTry.
  const cl = driver(busy, { data: briefed, state: onPage('progress', { project: { nav: { cursor: 'project:fold:hist:DATA-ONE' } }, prefs: { projectLayout: 'board' } }) });
  cl.run('enter');
  assert.match(cl.lines().join('\n'), /How to try/);
  assert.match(cl.lines().join('\n'), /▸ Ledger line/);
  cl.run('space');
  assert.deepEqual(cl.run('try-accept').action.target.slices.map((s) => s.id), ['DATA-ONE']);
});

test('Board Projects list at 40 and 80 cols EN and ZH: aligned one-row-per-project table, exact width, no STATE.md whole', async (t) => {
  const { lists } = await fixture(t);
  for (const width of [40, 80]) for (const lang of ['en', 'zh']) for (const icons of ['unicode', 'text']) {
    const frame = lists.list(width, lang, onPage(undefined, { prefs: { projectLayout: 'board' }, project: { view: { kind: 'projects-list' } } }), 18, icons);
    assertWidth(frame, width, `list ${width} ${lang} ${icons}`);
    const text = plain(frame).join('\n');
    assert.match(text, /demo-project/);
    assert.match(text, lang === 'zh' ? /无 STATE\.md/ : /no STATE\.md/);
    assert.match(text, lang === 'zh' ? /等你处理/ : /waiting for you/);
    if (lang === 'zh') {
      const uiLines = plain(frame).filter((l) => !/^[a-z]+-project/.test(l)).join('\n');
      assert.doesNotMatch(uiLines, /\b(waiting for you|jobs running|project|ledger|age|ms)\b/);
    }
  }
});
