import { withState } from '../fixtures/state-helpers.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acceptanceTasks } from '../../dist/collectors/acceptance-tasks.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { handleMonitorInput, renderMonitor } from '../../dist/render/monitor.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { loadSettings } from '../../dist/settings.js';
import { SETTING_ROWS } from '../../dist/render/settings-page.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { visualLength } from '../../dist/render/colors.js';
import { NOW, TREE, plain, onPage } from '../fixtures/project-page.mjs';

const temp = (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'project-acceptance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const press = (frame, key, text) => handleMonitorInput(frame.state, { type: 'key', key, text }, { tree: TREE, frame, nowMs: NOW });

test('board milestone grouping excludes other states and keeps rows without a milestone separate', () => {
  const row = (id, milestone, state = 'try', at) => ({ id, milestone, state, at, text: id });
  const ledger = [row('a', 'M1', 'try', 500), row('b', 'M1', 'accepted', 100), row('c', 'M1', 'try', 200),
    row('d', 'M1'), row('e', '—'), row('f', '—'), row('g', ''), row('h', '')];
  const groups = acceptanceTasks(ledger);
  assert.deepEqual(groups.map(task => task.slices.map(r => r.id)), [['a', 'c', 'd'], ['e'], ['f'], ['g'], ['h']]);
  assert.equal(groups[0].oldest, 200);
});

test('the old Detail setting is ignored without rewriting the preference file', (t) => {
  const path = join(temp(t), 'hud-settings.json'), saved = JSON.stringify({ acceptance: 'slice', panelLayout: 'split' });
  fs.writeFileSync(path, saved);
  const settings = loadSettings({ ...process.env, HUD_SETTINGS_PATH: path });
  assert.equal(settings.panelLayout, 'split');
  assert.ok(!Object.hasOwn(settings, 'acceptance'));
  assert.ok(!SETTING_ROWS.some(row => row.key === 'acceptance'));
  assert.equal(fs.readFileSync(path, 'utf8'), saved);
});

test('task pages group actual features and mixed ledger states; drilling in and filtering preserve all members without try actions', async (t) => {
  const cwd = temp(t), board = { revision: 'synthetic', workers: [], lanes: [], decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: cwd } };
  const put = (parts, text) => {
    const path = join(cwd, ...parts);
    fs.mkdirSync(join(path, '..'), { recursive: true });
    fs.writeFileSync(path, text);
    fs.utimesSync(path, NOW / 1000, NOW / 1000);
    return path;
  };
  const issue = (feature, n, title, status, checklist) => put(['.scratch', feature, 'issues', `${n}-ticket.md`],
    `# ${n}: ${title}\n**Status:** ${status}\n**Blocked by:** None\n- [${checklist ? 'x' : ' '}] Inspect the sample output\n`);
  issue('export', '01', 'Save as text', 'resolved', true);
  const oldest = issue('export', '02', 'Choose columns', 'needs-info', false);
  const newer = issue('export', '03', 'Download CSV', 'try', false);
  fs.utimesSync(oldest, NOW / 1000, NOW / 1000); // more recently edited, but created first
  fs.utimesSync(newer, NOW / 1000 - 60, NOW / 1000 - 60);
  issue('search', '01', 'Find phrases', 'resolved', true);
  issue('search', '02', 'Add fuzzy search', 'wontfix', false);
  put(['STATE.md'], 'Milestone: M-EXPORT\n## Waiting for the owner\n- Bring a sample file.\n');
  const project = await new ProjectCollector(cwd, join(cwd, 'hud')).collect('home', board, NOW);
  const draw = (page, state, width, lang) => {
    const display = setDisplayConfig({ theme: 'none', icons: 'unicode' }), previous = setLanguage(lang);
    try { return renderMonitor({ state: onPage(page, state), tree: TREE, workboard: board, project, width, height: 23, nowMs: NOW }); }
    finally { setDisplayConfig(display); setLanguage(previous); }
  };
  const feature = 'project:fold:feature:export', milestone = 'project:fold:task:milestone:export';
  const frames = [];
  const record = (label, frame, width, lang) => {
    assert.ok(frame.lines.every((line) => visualLength(line) === width));
    const lines = plain(frame).map((line) => line.trimEnd());
    while (lines.length > 2 && !lines.at(-2)) lines.splice(-2, 1);
    frames.push(`### ${label}, ${lang.toUpperCase()}, ${width} columns\n\n\x60\x60\x60text\n${lines.join('\n')}\n\x60\x60\x60\n`);
  };
  for (const lang of ['en', 'zh']) for (const width of [40, 120]) for (const panelLayout of ['classic', 'split']) {
    const text = (frame) => plain(frame).join('\n');
    const render = (page, cursor, extra = {}) => draw(page, withState({ project: { nav: { cursor } }, prefs: { panelLayout } }, extra), width, lang);
    const tickets = render('tickets', feature);
    assert.match(text(tickets), lang === 'en' ? /export\s+1\/3\s+needs-info/ : /export\s+1\/3\s+待补充/);
    assert.match(text(tickets), /search\s+2\/2/);
    const ticketsDetail = panelLayout === 'classic' ? draw('tickets', press(tickets, 'enter').state, width, lang) : tickets;
    assert.match(text(ticketsDetail), /Download CSV/);
    assert.match(text(ticketsDetail), /Save as text/);
    assert.doesNotMatch(text(ticketsDetail), /Find phrases/);
    const filteredTickets = render('tickets', feature, { project: { filter: { query: 'download csv', editing: false } } });
    assert.match(text(filteredTickets), lang === 'en' ? /1 match/ : /1 个匹配/);
    assert.doesNotMatch(text(filteredTickets), /search/);
    record(`Tickets — ${panelLayout}`, tickets, width, lang);

    const progress = render('progress', milestone);
    assert.match(text(progress), /◆ export\s+◆ 1  ◇ 1  ✓ 1/);
    assert.match(text(progress), /✓ search\s+✓ 1  – 1/);
    const progressDetail = panelLayout === 'classic' ? draw('progress', press(progress, 'enter').state, width, lang) : progress;
    for (const id of ['EXPORT-01', 'EXPORT-02', 'EXPORT-03']) assert.match(text(progressDetail), new RegExp(id));
    for (const key of ['space', 'y', 'n', 'm', 't']) assert.equal(press(progress, '', key).action, undefined);
    const filtered = render('progress', milestone, { project: { filter: { query: 'choose columns', editing: false } } });
    const filteredDetail = panelLayout === 'classic' ? draw('progress', press(filtered, 'enter').state, width, lang) : filtered;
    assert.match(text(filteredDetail), /Download CSV/);
    const hub = render(undefined);
    assert.doesNotMatch(text(hub), /Accept all|全部验收/);
    assert.match(text(hub), lang === 'en' ? /Tickets\s+2 features/ : /工单\s+2 个功能/);
    const accept = render('tickets', 'project:accept-all');
    assert.match(text(accept), lang === 'en' ? /Accept all\s+1 to try/ : /全部验收\s+1 待试用/);
    assert.deepEqual(press(accept, 'enter').action, { type: 'accept-all' });
    record(`Progress — ${panelLayout}`, progress, width, lang);
  }
  if (process.env.OWNER_VIEW_TASK_FRAMES) fs.writeFileSync(process.env.OWNER_VIEW_TASK_FRAMES, frames.join('\n'));
});
