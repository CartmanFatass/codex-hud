import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { buildCardsFixture, NOW } from '../../docs/design/home-cards/gen/fixture.mjs';
import { HomeCardsCollector } from '../../dist/collectors/home-cards.js';
import { HomePortfolioCollector } from '../../dist/collectors/home-portfolio.js';
import { localDayStart } from '../../dist/collectors/job-stats.js';
import { projectList } from '../../dist/roles/projects.js';
import { stripAnsi, theme, visualLength } from '../../dist/render/colors.js';
import { homeCardRows, scheduleView } from '../../dist/render/home-cards.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { handleMonitorInput, initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';

const DAY = 86_400_000;
const stamp = (ms = NOW) => new Date(ms).toISOString();
const rows = frame => frame.workboard.rows;
const plain = row => stripAnsi(row.text).trimEnd();
const scheduleItems = frame => rows(frame).filter(row => row.item?.startsWith('home:card:schedule:'));
const todayLines = (frame, lang = 'en') => rows(frame).map(plain).filter(text => text.startsWith(lang === 'zh' ? '今天 ' : 'Today '));
const exact = (frame, width) => assert.ok([...frame.lines, ...rows(frame).map(row => row.text)].every(text => visualLength(text) === width));

async function fixture(t, day, lang) {
  const f = await buildCardsFixture(undefined, { day, lang });
  t.after(f.cleanup);
  const collector = new HomeCardsCollector(f.home), portfolio = new HomePortfolioCollector(f.home);
  const projects = projectList(f.home, f.roots.harbor);
  const tick = async (now = NOW) => {
    const homePortfolio = await portfolio.read(projects, { lanes: [], workers: [] }, now);
    return { homePortfolio, homeToday: collector.readToday(homePortfolio.projects, now), openSchedule: collector.readOpenSchedule() };
  };
  const draw = (input, width, height = 48, state = initialMonitorState(), nowMs = NOW) => renderMonitor({
    ...input, projects, homeWaiting: input.homePortfolio.projects.find(p => p.root === f.roots.harbor).snapshot.waiting,
    state, width, height, nowMs,
  });
  return { ...f, tick, draw };
}

for (const lang of ['en', 'zh']) test(`Home cards: busy, quiet and short frames at 40/50/80 (${lang})`, async t => {
  const busy = await fixture(t, 'busy', lang), quiet = await fixture(t, 'quiet', lang);
  const [busyData, quietData] = await Promise.all([busy.tick(), quiet.tick()]);
  const zh = lang === 'zh', prevLang = setLanguage(lang), prev = setDisplayConfig({ theme: 'mocha', icons: 'unicode' });
  try {
    for (const width of [40, 50, 80]) {
      const frame = busy.draw(busyData, width), all = rows(frame).map(plain);
      exact(frame, width);
      const today = all.findIndex(text => text.startsWith(zh ? '今天 ' : 'Today '));
      const schedule = all.findIndex(text => text.startsWith(zh ? '日程 ' : 'Schedule '));
      assert.equal(rows(frame)[today - 2].item, 'home:other-projects');
      const summary = zh ? '今天 7 落地 · 1 失败 · 2 在跑' : 'Today 7 landed · 1 failed · 2 running';
      assert.deepEqual(all.slice(today, schedule), [summary, '']);
      assert.ok(all[schedule].endsWith(zh ? '6 项' : '6 items'));
      assert.ok(all.includes(zh ? '  另 2 项' : '  2 more'));
      const items = scheduleItems(frame).map(plain);
      assert.deepEqual(items.filter(x => /^\S/.test(x)).map(x => x.slice(2, 7)), ['11-22', '11-24', '11-27', '12-01']);
      assert.equal(items.includes('  harbor-api › rate-limits'), width < 80);
      assert.ok(items[1].endsWith(zh ? '今天' : 'today'));
      assert.ok(all.includes(zh ? '○ 静默 sketchbook 3周' : '○ quiet sketchbook 3w'));

      const still = quiet.draw(quietData, width);
      exact(still, width);
      assert.deepEqual(todayLines(still, lang), [zh ? '今天 2 在跑' : 'Today 2 running'], 'yesterday’s landings stay out');
      assert.ok(scheduleItems(still).some(row => plain(row).includes('12-??') && plain(row).endsWith(zh ? '下月' : 'next mo')));
      assert.doesNotMatch(stripAnsi(still.lines[0]), /◉/);

      const prefix = rows(frame).slice(0, today - 1), fullPortfolio = prefix.length + 2;
      for (const [spare, nCards] of [[7, 7], [3, 3], [1, 1], [0, 0]]) {
        const short = busy.draw(busyData, width, fullPortfolio + spare);
        exact(short, width);
        assert.deepEqual(rows(short).slice(0, prefix.length), prefix, 'cards yield before any project rows');
        const cards = rows(short).slice(prefix.length);
        assert.equal(cards.length, nCards);
        assert.deepEqual(todayLines(short, lang), spare >= 3 ? [summary] : []);
        assert.equal(scheduleItems(short).length, spare === 7 ? 3 : 0);
        assert.match(stripAnsi(short.lines[0]), width === 40 && !zh ? /\?1/ : /\?1 ◉2/);
        if (spare === 1) assert.ok(plain(cards[0]).endsWith(zh ? '逾期 1 · 今天 1' : 'overdue 1 · today 1'));
      }
      const squeezed = busy.draw(busyData, width, fullPortfolio - 1);
      exact(squeezed, width);
      assert.ok(rows(squeezed).length < prefix.length);
      assert.ok(!rows(squeezed).some(row => plain(row).startsWith(zh ? '日程 ' : 'Schedule ')));
    }
  } finally { setLanguage(prevLang); setDisplayConfig(prev); }
});

test('due badge and row inks follow the shared calendar; done items disappear on collection', async t => {
  const f = await fixture(t, 'busy', 'en');
  const prev = setDisplayConfig({ theme: 'mocha', icons: 'nerd' }), prevLang = setLanguage('en');
  try {
    const data = await f.tick();
    const frame = f.draw(data, 50);
    exact(f.draw(data, 40), 40);
    const find = (frame, id) => scheduleItems(frame).find(row => row.item.endsWith(`:${id}`));
    assert.ok(find(frame, 's1').text.includes(theme.board.attention('\uF06A')));
    assert.ok(find(frame, 's1').text.includes(theme.board.attention('2d late')));
    assert.ok(find(frame, 's2').text.includes(theme.board.active('\uF073')));
    assert.ok(frame.lines[0].includes(theme.board.attention('\uF0732')));
    assert.deepEqual(data.homePortfolio.requests.map(r => r.item.request), ['r1']);
    const projectTab = f.draw(data, 50, 48, { ...initialMonitorState(), activeTab: 'project' });
    assert.ok(projectTab.lines[0].includes(theme.board.attention('\uF0732')));
    const doc = JSON.parse(fs.readFileSync(f.schedulePath, 'utf8'));
    doc.items[0].done_at = stamp();
    const moved = f.schedulePath + '.new';
    fs.writeFileSync(moved, JSON.stringify(doc));
    fs.renameSync(moved, f.schedulePath);
    const changedData = await f.tick(), after = f.draw(changedData, 50);
    assert.ok(after.lines[0].includes(theme.board.active('\uF0731')));
    assert.equal(find(after, 's1'), undefined);
    assert.ok(changedData.openSchedule.some(item => item.date === '2026-12'));
    const monthEnd = f.draw(changedData, 50, 48, initialMonitorState(), Date.parse('2026-12-31T12:00:00Z'));
    assert.match(stripAnsi(monthEnd.lines[0]), /\uF0735/);
    assert.match(plain(find(monthEnd, 's4')), /12-\?\?.+today$/);
    assert.deepEqual(todayLines(monthEnd), ['Today 2 running'], 'a repaint on a new day omits stale history but still shows observed running jobs');
    const raw = fs.readFileSync(f.schedulePath, 'utf8');
    assert.equal(raw, JSON.stringify(doc), 'paint and collection leave the schedule untouched');
    fs.writeFileSync(f.schedulePath, '{bad');
    const invalid = await f.tick();
    assert.equal(invalid.openSchedule, undefined);
    assert.doesNotMatch(stripAnsi(f.draw(invalid, 50).lines[0]), /\uF073/);
  } finally { setDisplayConfig(prev); setLanguage(prevLang); }
});

test('quiet line skips old paused and maintenance projects', async t => {
  const f = await fixture(t, 'quiet', 'en');
  const old = new Date(NOW - 21 * DAY);
  for (const file of [join(f.roots.quill, 'STATE.md'), join(f.roots.quill, '.hud/objectives.md')]) fs.utimesSync(file, old, old);
  const prev = setDisplayConfig({ theme: 'none', icons: 'text' }), prevLang = setLanguage('en');
  try {
    const frame = f.draw(await f.tick(), 40);
    const quiet = rows(frame).map(plain).find(text => text.startsWith('o quiet '));
    assert.equal(quiet, 'o quiet sketchbook 3w');
    assert.ok(frame.lines.every(text => !text.includes('\x1b')));
  } finally { setDisplayConfig(prev); setLanguage(prevLang); }
});

test('Schedule links navigate without actions; an unlinked item only selects', async t => {
  const f = await fixture(t, 'busy', 'en'), data = await f.tick();
  const frame = f.draw(data, 50);
  const apply = (frame, input) => handleMonitorInput(frame.state, input, { frame });
  const click = row => apply(frame, { type: 'mouse', button: 'left', x: 4, y: frame.panes[0].y + rows(frame).indexOf(row) });
  const linked = scheduleItems(frame).find(row => row.item.endsWith(':s5'));
  const viaMouse = click(linked);
  assert.equal(viaMouse.action, undefined);
  assert.equal(viaMouse.state.selectedProject, f.roots.lab);
  assert.equal(viaMouse.state.activeTab, 'project');
  const unlinked = scheduleItems(frame)[0];
  const justSelected = click(unlinked);
  assert.equal(justSelected.state.home.cursor, unlinked.item);
  const noAction = apply(f.draw(data, 50, 48, justSelected.state), { type: 'key', key: 'enter' });
  assert.equal(noAction.action, undefined);
  assert.equal(noAction.state.activeTab, 'home');
});

test('Today counts local failures and live jobs waiting for main, not stops or queued jobs', async t => {
  const f = await fixture(t, 'empty', 'en'), path = join(f.home, 'archive/2026-11.jsonl');
  const status = (n, state) => fs.writeFileSync(join(f.home, 'jobs', `j000000000000000${n}`, 'STATUS.json'), JSON.stringify({ state }));
  status(1, 'waiting_orchestrator');
  status(2, 'queued');
  const fact = (n, role, state, fields = {}) => ({ v: 1, job: `j${String(n).padStart(16, '0')}`, project: f.roots.harbor,
    role, state, created_at: stamp(NOW - DAY), settled_at: stamp(NOW - 1000), ...fields });
  fs.mkdirSync(join(f.home, 'archive'));
  fs.writeFileSync(path, [fact(100, 'sonic', 'idle_grace'), fact(101, 'oracle', 'stopped', { dispatch_exit_code: 1 }),
    fact(102, 'imp', 'closed', { dispatch_exit_code: -1 }), fact(103, 'reviewer', 'failed', { settled_at: stamp(NOW - DAY) }),
    fact(104, 'imp', 'failed', { project: join(f.dir, 'unregistered') })]
    .map(item => JSON.stringify(item)).join('\n'));
  const data = await f.tick();
  assert.equal(data.homeToday.failed, 1);
  assert.deepEqual(todayLines(f.draw(data, 40)), ['Today 1 failed · 1 running']);
  fs.appendFileSync(path, '\n{bad json');
  const invalid = await f.tick(NOW + 30_001);
  assert.equal(invalid.homeToday, undefined);
  assert.deepEqual(todayLines(f.draw(invalid, 40)), ['Today 1 running']);
});

for (const lang of ['en', 'zh']) test(`Today drops whole facts in attention order (${lang})`, () => {
  const zh = lang === 'zh', prevLang = setLanguage(lang), prev = setDisplayConfig({ theme: 'mocha', icons: 'unicode' });
  try {
    const draw = (width, { failed = 1, running = 3, limited = false } = {}) => {
      const active = Array.from({ length: running }, (_, i) => ({ jobId: String(i), state: 'running' }));
      const today = { since: localDayStart(NOW), landed: 29, failed, limited };
      const { rows: cardRows } = homeCardRows(today, scheduleView([], NOW), [{ snapshot: { active } }], width, NOW, 2);
      assert.ok(cardRows.every(row => visualLength(row.text) === width));
      return cardRows.map(plain);
    };
    assert.deepEqual(draw(zh ? 28 : 32), ['', zh ? '今天 1 失败 · 3 在跑' : 'Today 1 failed · 3 running']);
    assert.deepEqual(draw(zh ? 12 : 14), ['', zh ? '今天 1 失败' : 'Today 1 failed']);
    assert.deepEqual(draw(8), ['', zh ? '今天' : 'Today']);
    assert.deepEqual(draw(56), ['', zh ? '今天 29 落地 · 1 失败 · 3 在跑' : 'Today 29 landed · 1 failed · 3 running']);
    const bounded = { failed: 11, running: 12, limited: true };
    assert.deepEqual(draw(40, bounded), ['', zh ? '今天 ~29 落地 · ~11 失败 · 12 在跑' : 'Today ~11 failed · 12 running']);
    assert.deepEqual(draw(56, bounded), ['', zh ? '今天 ~29 落地 · ~11 失败 · 12 在跑' : 'Today ~29 landed · ~11 failed · 12 running']);
  } finally { setLanguage(prevLang); setDisplayConfig(prev); }
});

test('Today is omitted when all three counts are zero', async t => {
  const f = await fixture(t, 'quiet', 'en');
  for (const id of ['j0000000000000001', 'j0000000000000002']) {
    fs.writeFileSync(join(f.home, 'jobs', id, 'STATUS.json'), JSON.stringify({ state: 'closed', settled_at: stamp() }));
  }
  const data = await f.tick();
  assert.deepEqual(todayLines(f.draw(data, 40)), []);
});

test('a Latin word inside Chinese text is cut at the Chinese boundary, not the last space', async () => {
  const { cutSentence } = await import('../../dist/render/monitor-text.js');
  const text = '删除 toktrack 旧缓存备份（cache-pre-overhaul-backup）和旧程序';
  const cut = cutSentence(text, 30);
  assert.ok(cut.startsWith('删除 toktrack 旧缓存备份'), cut);
  assert.ok(visualLength(cut) <= 30, cut);
  assert.equal(cutSentence('alpha beta gammadelta', 15), 'alpha beta…');
});
