import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HomePortfolioCollector } from '../../dist/collectors/home-portfolio.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { projectList } from '../../dist/roles/projects.js';
import { handleMonitorInput, initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { deserializePanelPlace, serializePanelPlace } from '../../dist/render/monitor-reload-codec.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, visualLength, theme } from '../../dist/render/colors.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { buildFixture, NOW } from '../../docs/design/home-portfolio/gen/fixture.mjs';

const nowMs = Date.parse('2026-11-24T12:00:00Z'), updated = new Date('2026-11-24T09:30:00Z');
const board = { lanes: [], workers: [] };
function fixture(t, count = 3) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-portfolio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'hud'), roots = ['paused-study', 'state-notes', 'offline-root', ...Array.from({ length: Math.max(0, count - 3) }, (_, i) => `project-${i}`)]
    .slice(0, count).map((name) => join(dir, name));
  const [paused, own] = roots;
  const put = (file, text) => {
    fs.mkdirSync(join(file, '..'), { recursive: true });
    fs.writeFileSync(file, text);
    fs.utimesSync(file, updated, updated);
  };
  const objectives = (root, header, body) => put(join(root, '.hud/objectives.md'), `${header}\n\n${body}\n`);
  const tracked = '## measure: Measure the sample\n**State:** active\n**Result:** The reading held.';
  const recent = '## repeat: Repeat the test\n**State:** active\n**Result:** The replay agreed.';
  const retired = '## archive: Retired title\n**State:** done';
  const header = '**Stance:** paused · **Priority:** high';
  objectives(paused, header, [tracked, recent, retired].join('\n\n'));
  put(join(paused, 'STATE.md'), '## Waiting for the owner\n- 2026-11-23 [r1] Choose alpha (objective measure) (work waits)\n- 2026-11-22 [r2] Try the sample\n- 2026-11-21 [r3] Pick the chart\n\n## Now\n- Not a substitute for Objectives');
  put(join(own, 'STATE.md'), '## Waiting for the owner\n- 2026-11-20 [r1] Choose beta (work waits)\n- 2026-11-19 [r2] Decide on rows\n\n## Now\n- Read the handoff\n\n## Next\n- Share the example');
  for (const root of count === 3 ? [] : roots.slice(2)) {
    objectives(root, '**Stance:** maintenance · **Priority:** low', tracked);
    put(join(root, '.scratch/test/issues/01-demo.md'), '# 01: Test card\n\n**Status:** done\n**Blocked by:** none\n');
    put(join(root, 'STATE.md'), '## Waiting for the owner\n- Choose an example\n\n## Now\n- Synthetic study');
  }
  const at = '2026-11-23T10:00:00.000Z', receiptPath = join(home, 'events/2026-11.jsonl');
  const receipt = { v: 1, kind: 'objective', project: paused, id: 'measure', change: 'result', at, result: 'The reading held.' };
  put(receiptPath, [receipt, { ...receipt, id: 'repeat', at: '2026-11-23T11:00:00.000Z', result: 'The replay agreed.' }].map(JSON.stringify).join('\n') + '\n');
  put(join(home, 'projects.json'), JSON.stringify({ version: 1, projects: roots.map((root) => ({ root })) }));
  const collector = new HomePortfolioCollector(home);
  const tick = (now = nowMs) => collector.read(projectList(home, own), board, now);
  return { home, roots, paused, own, tick, objectives, tracked, retired, header, put, receipt, receiptPath };
}
const plain = (frame) => frame.lines.map(stripAnsi).join('\n');
const expanded = () => ({ ...initialMonitorState(), home: { scroll: 0, othersExpanded: true } });
const projectRows = (frame) => frame.workboard.rows.filter((row) => row.item?.startsWith('home:project:'));
const foldRow = (frame) => frame.workboard.rows.find((row) => row.item === 'home:other-projects');

async function design(t) {
  const f = await buildFixture();
  t.after(f.cleanup);
  const collector = new HomePortfolioCollector(f.home);
  const tick = () => collector.read(projectList(f.home, f.roots.harbor), board, NOW);
  const homePortfolio = await tick();
  const draw = (width, height, portfolio = homePortfolio, state = expanded()) => renderMonitor({
    state, width, height, nowMs: NOW, homePortfolio: portfolio, projects: portfolio.projects,
    homeWaiting: portfolio.projects[0].snapshot.waiting,
  });
  return { ...f, homePortfolio, draw, tick };
}

test('design Home at 40, 50 and 80 columns: cell-exact in EN/ZH across icon sets and themes', async (t) => {
  const f = await design(t);
  const { item } = f.homePortfolio.requests[0];
  assert.match(item.value, /^2026-11-23 r1 .* · Per-key rate limits.*\(work waits\)$/);
  assert.equal(item.sentence, 'Pick the default burst size: 20 or 60 requests per second? Main cannot ship the quota headers until it is chosen.');
  for (const [icons, blocked, paused, gone, note, bars, dots] of [
    ['unicode', '?', '‖', '✗', '¶', '█', '╌'], ['nerd', '\uF059', '\uF28B', '\uF057', '\uF249', '█', '╌'],
    ['text', '?', '=', 'x', '.', '#', '.'],
  ]) for (const width of [40, 50, 80]) for (const lang of ['en', 'zh']) {
    const prev = setDisplayConfig({ theme: 'mocha', icons }), prevLang = setLanguage(lang);
    try {
      const frame = f.draw(width, 40), rows = frame.workboard.rows;
      const text = plain(frame), goal = (id) => rows.find((r) => r.item?.startsWith('home:objective:') && r.objectiveTarget.objective.id === id).text;
      assert.ok([...frame.lines, ...rows.map((r) => r.text)].every((line) => visualLength(line) === width));
      assert.match(text, lang === 'en' ? /Home \?1/ : /首页 \?1/);
      const [head, ...body] = rows.filter((r) => r.item?.startsWith('home:wait:')).map((r) => stripAnsi(r.text).trimEnd());
      assert.match(head, lang === 'en' ? /harbor-api . rate-limits +work waits 1d$/ : /harbor-api . rate-limits +在等你 1天$/);
      assert.equal(body.length, 2);
      assert.match(body[0], /^  Pick the default burst size:/);
      assert.ok(body.every((line) => line.search(/\S/) === 2), 'sentence rows use a two-cell hang');
      assert.equal(body[1].endsWith('…'), width < 80);
      const rate = goal('rate-limits'), quill = goal('docs-site');
      assert.ok(stripAnsi(rate).startsWith(`  ${blocked} rate-limits`));
      assert.ok(rate.includes(theme.board.attention(blocked)));
      assert.match(stripAnsi(rate), /\b4\/8\b/);
      assert.ok(rate.includes(bars));
      assert.equal(stripAnsi(rate).includes(lang === 'en' ? 'blocked' : '受阻'), width >= 50);
      assert.equal(stripAnsi(rate).includes('Per-key rate limits'), width >= 80);
      assert.equal(stripAnsi(rate).includes(lang === 'en' ? '4/8 tickets' : '4/8 工单'), width >= 56);
      assert.ok(stripAnsi(quill).startsWith(`  ${paused} docs-site`));
      const [filled] = stripAnsi(quill).match(/[█#]+/);
      assert.ok(quill.includes(theme.board.muted(filled)), 'paused progress is grey');
      assert.ok(!quill.includes(theme.board.success(filled)));
      assert.match(stripAnsi(quill), /\b2\/3\b/);
      assert.ok(stripAnsi(goal('tokenizers')).includes(dots.repeat(4)));
      assert.ok(text.includes(`  ${note} Prototype the capture overlay`));
      assert.ok(text.includes(`${gone} old-mill`));
      assert.match(text, lang === 'en' ? /old-mill .+ unavailable/ : /old-mill .+ 不可用/);
      assert.match(text, lang === 'en' ? /Token-bucket core shipped;.*4h/ : /Token-bucket core shipped;.*4时/);
      assert.doesNotMatch(text, /Two of three tokenizers measured|All clients on v2|v1 removed|Pick the colour palette|This pane|当前窗格/);
      setDisplayConfig({ theme: 'none' });
      const noColour = f.draw(width, 40);
      assert.deepEqual(noColour.lines, frame.lines.map(stripAnsi));
      assert.ok(noColour.workboard.rows.every((r) => !r.text.includes('\x1b')));
    } finally { setLanguage(prevLang); setDisplayConfig(prev); }
  }
});

test('Home folds three quiet registrations behind one row after two active projects', async (t) => {
  const f = await design(t), { harbor, lab, sketch, mill, quill } = f.roots;
  const register = (roots) => fs.writeFileSync(join(f.home, 'projects.json'), JSON.stringify({ version: 1, projects: roots.map((root) => ({ root })) }));
  register([mill, quill, lab, sketch, harbor]);
  const portfolio = await f.tick(), otherRoots = [sketch, quill, mill];
  const decoder = new WorkbenchInputDecoder('workboard');
  const press = (frame, ch) => handleMonitorInput(frame.state, decoder.push(Buffer.from(ch))[0], { frame }).state;
  for (const width of [40, 80]) for (const lang of ['en', 'zh']) {
    const prev = setLanguage(lang);
    try {
      const draw = (state = initialMonitorState()) => f.draw(width, 40, portfolio, state);
      const check = (frame, open) => {
        const { rows } = frame.workboard, toggle = foldRow(frame), projects = projectRows(frame);
        assert.deepEqual(projects.map((r) => r.homeTarget.root), open ? [harbor, lab, ...otherRoots] : [harbor, lab]);
        const toggleAt = rows.indexOf(toggle);
        assert.ok(toggleAt > rows.indexOf(projects[1]));
        if (open) assert.ok(toggleAt < rows.indexOf(projects[2]));
        else assert.ok(rows.slice(toggleAt + 1).every(row => !row.item), 'only summary rows follow the folded project list');
        assert.equal(rows.filter((r) => r.item === toggle.item).length, 1);
        const label = lang === 'en' ? '3 other projects' : '其他 3 个项目';
        assert.ok(stripAnsi(toggle.text).startsWith(label));
        const hint = lang === 'en' ? open ? 'a fold' : 'a expand' : open ? 'a 折叠' : 'a 展开';
        assert.ok(stripAnsi(toggle.text).endsWith(hint));
        if (frame.state.home.cursor === toggle.item) assert.ok(stripAnsi(frame.lines.at(-1)).includes(hint));
        assert.ok([...frame.lines, ...rows.map((r) => r.text)].every((line) => visualLength(line) === width));
        assert.equal(rows.filter((r) => r.item?.startsWith('home:wait:')).length, 3);
      };
      const collapsed = draw();
      check(collapsed, false);
      const open = draw(press(collapsed, 'a'));
      check(open, true);
      const project = draw(press(open, '\t'));
      assert.equal(project.state.activeTab, 'project');
      const back = handleMonitorInput(project.state, { type: 'key', key: 'shift-tab' }, { frame: project }).state;
      check(draw(back), true);
      const restarted = deserializePanelPlace(serializePanelPlace({ state: open.state, settings: null }));
      check(draw(restarted.state), false);
      const folded = draw(press(open, 'a'));
      check(folded, false);
      check(draw(press(folded, '\r')), true);
      const help = draw(press(folded, '?'));
      assert.match(plain(help), lang === 'en' ? /a\s+expand \/ fold other projects/ : /a\s+展开／折叠其他项目/);
      const pane = folded.panes[0];
      const click = { type: 'mouse', button: 'left', x: 0, y: pane.y + folded.workboard.rows.indexOf(foldRow(folded)) - pane.offset };
      check(draw(handleMonitorInput(folded.state, click, { frame: folded }).state), true);
    } finally { setLanguage(prev); }
  }
  register(otherRoots);
  const quiet = f.draw(40, 20, await f.tick(), initialMonitorState());
  assert.deepEqual(quiet.workboard.rows.slice(1), [foldRow(quiet)]);
});

test('Home membership follows local-day activity, old live jobs and open requests', async (t) => {
  const f = fixture(t);
  const roots = Object.fromEntries(['request', 'running', 'queued', 'objective', 'state', 'started', 'settled',
    'archived', 'landed', 'archived-land', 'yesterday', 'created-only'].map((name) => [name, join(f.home, '..', name)]));
  for (const root of Object.values(roots)) fs.mkdirSync(root);
  f.put(join(f.home, 'projects.json'), JSON.stringify({ version: 1, projects: Object.values(roots).map((root) => ({ root })) }));
  const midnight = new Date(nowMs); midnight.setHours(0, 0, 0, 0);
  const today = midnight.toISOString(), past = new Date(+midnight - 1000), yesterday = past.toISOString();
  const stamp = (file, at) => fs.utimesSync(file, at, at);
  const state = (name) => join(roots[name], 'STATE.md');
  f.put(state('request'), '## Waiting for the owner\n- Choose the test input\n');
  stamp(state('request'), past);
  f.objectives(roots.objective, '**Stance:** paused', f.tracked);
  stamp(join(roots.objective, '.hud/objectives.md'), midnight);
  for (const [name, at] of [['state', midnight], ['yesterday', past]]) {
    f.put(state(name), '## Now\n- Write the sample\n');
    stamp(state(name), at);
  }
  const job = (name, n, status, created_at = yesterday) => {
    const dir = join(f.home, 'jobs', `j${String(n).padStart(16, '0')}`);
    f.put(join(dir, 'job.json'), JSON.stringify({ role: 'imp', cwd: roots[name], created_at }));
    f.put(join(dir, 'STATUS.json'), JSON.stringify(status));
  };
  job('running', 1, { state: 'working', started_at: yesterday });
  job('queued', 2, { state: 'queued' });
  job('started', 3, { state: 'done', started_at: today });
  job('settled', 4, { state: 'done', started_at: yesterday, settled_at: today });
  job('created-only', 5, { state: 'closed' }, today);
  const archive = [
    { v: 1, job: 'j0000000000000006', project: roots.archived, started_at: yesterday, ended_at: today },
    { v: 1, job: 'j0000000000000007', project: roots['archived-land'], settled_at: yesterday,
      land: { state: 'completed', attempts: 1, reruns: 0, repairs: 0, sha: '123abcd', landed_at: today } },
  ];
  f.put(join(f.home, 'archive/2026-11.jsonl'), archive.map(JSON.stringify).join('\n') + '\n');
  f.put(join(f.home, 'flows/f0000000000000008.json'), JSON.stringify({
    job: 'j0000000000000008', wt: { main_root: roots.landed }, state: 'completed', landed_at: today, landed_sha: '123abcd',
  }));
  const list = (homePortfolio, now) => {
    const frame = renderMonitor({ state: initialMonitorState(), width: 80, height: 40, nowMs: now, homePortfolio });
    assert.deepEqual(homePortfolio.requests.map((r) => r.project.root), [roots.request]);
    return new Set(projectRows(frame).map((r) => r.homeTarget.root));
  };
  assert.deepEqual(list(await f.tick(), nowMs), new Set(Object.values(roots).slice(0, -2)));
  const tomorrow = new Date(midnight); tomorrow.setDate(tomorrow.getDate() + 1);
  assert.deepEqual(list(await f.tick(+tomorrow), +tomorrow), new Set([roots.request, roots.running, roots.queued]));
});

test('Home orders project blocks by requests, stance, priority and activity, with registration-order ties', async (t) => {
  const f = fixture(t), offline = f.roots[2];
  const [bare, paused, maintenance, older, newer, high, low, legacy] = [
    'bare', 'paused', 'maintenance', 'older', 'newer', 'high', 'low', 'legacy',
  ].map((name) => join(f.home, '..', name));
  const stamp = (path, hours) => fs.utimesSync(path, new Date(nowMs - hours * 3600e3), new Date(nowMs - hours * 3600e3));
  const handoff = (root, hours) => {
    const path = join(root, 'STATE.md');
    f.put(path, '## Now\n- Compare the examples\n');
    stamp(path, hours);
  };
  fs.mkdirSync(bare);
  for (const [root, stance, priority, hours] of [
    [paused, 'paused', 'high', 1], [maintenance, 'maintenance', 'low', 30],
    [older, 'active', 'normal', 4], [newer, 'active', 'normal', 8],
    [high, 'active', 'high', 10], [low, 'active', 'low', 1],
  ]) {
    f.objectives(root, `**Stance:** ${stance} · **Priority:** ${priority}`, f.tracked);
    stamp(join(root, '.hud/objectives.md'), hours);
  }
  handoff(legacy, 2);
  handoff(newer, 2); // STATE is newer than the Objective record and ties the legacy project.
  const registered = [offline, older, bare, paused, f.paused, legacy, low, f.own, newer, maintenance, high];
  f.put(join(f.home, 'projects.json'), JSON.stringify({ version: 1, projects: registered.map((root) => ({ root })) }));
  const order = (homePortfolio, paintNow = nowMs) => projectRows(renderMonitor({
    state: expanded(), width: 80, height: 80, nowMs: paintNow, homePortfolio,
  })).map((row) => row.homeTarget.root);
  // Today's projects first; within each group the original sort still applies.
  const expected = (...normal) => [f.paused, f.own, high, ...normal, low, paused, maintenance, bare, offline];
  const portfolio = await f.tick();
  assert.deepEqual(order(portfolio), expected(legacy, newer, older));
  handoff(older, 1);
  const later = nowMs + 3600e3;
  assert.deepEqual(order(portfolio, later), expected(legacy, newer, older), 'repainting uses the collected order');
  assert.deepEqual(order(await f.tick(later), later), expected(older, legacy, newer), 'collection sees the new STATE timestamp');
});

test('Home shows a no-notes line and newest observed job age even when idle is unknown', async (t) => {
  const f = fixture(t), bare = join(f.home, '..', 'bare-study'), empty = join(f.home, '..', 'empty-study');
  for (const root of [bare, empty]) fs.mkdirSync(root);
  f.put(join(f.home, 'projects.json'), JSON.stringify({ version: 1, projects: [...f.roots, bare, empty].map((root) => ({ root })) }));
  for (const [id, hours] of [['j0000000000000001', 30], ['j0000000000000002', 4]]) {
    const dir = join(f.home, 'jobs', id);
    f.put(join(dir, 'job.json'), JSON.stringify({ role: 'imp', cwd: bare, created_at: new Date(nowMs - (hours + 2) * 3600e3).toISOString() }));
    f.put(join(dir, 'STATUS.json'), JSON.stringify({ state: 'done', settled_at: new Date(nowMs - hours * 3600e3).toISOString() }));
  }
  // An unattributed receipt makes the job scan incomplete: ○ does not imply the idle word.
  f.put(join(f.home, 'jobs/j0000000000000003/job.json'), '{}');
  const homePortfolio = await f.tick();
  assert.equal(homePortfolio.projects.find((p) => p.root === bare).snapshot.idle, undefined);
  for (const width of [40, 80]) for (const lang of ['en', 'zh']) {
    const prev = setDisplayConfig({ theme: 'mocha', icons: 'unicode' }), prevLang = setLanguage(lang);
    try {
      const frame = renderMonitor({ state: expanded(), width, height: 40, nowMs, homePortfolio });
      const { rows } = frame.workboard;
      assert.ok([...frame.lines, ...rows.map((r) => r.text)].every((line) => visualLength(line) === width));
      for (const [root, age] of [[bare, lang === 'en' ? ' 4h' : ' 4时'], [empty, '']]) {
        const i = rows.findIndex((r) => r.item === `home:project:${root}`);
        const name = root === bare ? 'bare-study' : 'empty-study';
        assert.match(stripAnsi(rows[i].text).trimEnd(), new RegExp(`^○ ${name} ─+${age}$`));
        const note = lang === 'en' ? 'no Objectives or handoff notes' : '无目标或交接记录';
        assert.ok(rows[i + 1].text.startsWith(theme.board.muted(`  ${note}`)));
      }
    } finally { setLanguage(prevLang); setDisplayConfig(prev); }
  }
});

test('Home shows both fresh done Objectives with full green bars, but no expired or undated ones', async (t) => {
  const f = await design(t), root = f.roots.lantern;
  const path = join(root, '.hud/objectives.md'), events = join(f.home, 'events/2026-11.jsonl');
  const done = [['shipped', 'Migration shipped.', 4], ['verified', 'Clients verified.', 2],
    ['retired', 'Old services retired.', 4 * 24], ['undated', 'Undated result.']];
  fs.writeFileSync(path, done.map(([id, result]) => `## ${id}: ${result}\n**State:** done\n**Result:** ${result}\n`).join('\n'));
  fs.appendFileSync(events, done.filter(([, , hours]) => hours !== undefined).map(([id, result, hours]) => JSON.stringify({
    v: 1, kind: 'objective', project: root, id, change: 'result', at: new Date(NOW - hours * 3600e3).toISOString(), result,
  })).join('\n') + '\n');
  const portfolio = await f.tick();
  const projectRows = (frame, kind) => frame.workboard.rows.filter((r) => r.item?.startsWith(`home:${kind}:${root}:`));
  for (const width of [40, 80]) for (const lang of ['en', 'zh']) {
    const prev = setDisplayConfig({ theme: 'mocha', icons: 'unicode' }), prevLang = setLanguage(lang);
    try {
      const frame = f.draw(width, 40, portfolio), goals = projectRows(frame, 'objective'), results = projectRows(frame, 'result');
      assert.ok([...frame.lines, ...frame.workboard.rows.map((r) => r.text)].every((line) => visualLength(line) === width));
      assert.deepEqual(goals.map((r) => r.objectiveTarget.objective.id), ['shipped', 'verified']);
      assert.deepEqual(results.map((r) => r.objectiveTarget.objective.id), ['shipped', 'verified']);
      for (const [i, goal] of goals.entries()) {
        const [id, result, hours] = done[i];
        assert.match(stripAnsi(goal.text), new RegExp(`^  ✓ ${id} `));
        const full = '█'.repeat(width === 40 ? 18 : 16);
        assert.ok(goal.text.includes(theme.board.success(full)), 'the entire track uses the success ink');
        assert.equal(stripAnsi(results[i].text).trim().replace(/ +/g, ' '), `✓ ${result} ${hours}${lang === 'en' ? 'h' : '时'}`);
      }
      assert.ok(!frame.workboard.rows.some((r) => r.item === `home:more:${root}`));
    } finally { setLanguage(prevLang); setDisplayConfig(prev); }
  }
  fs.appendFileSync(path, '\n## follow-up: Follow up\n**State:** active\n');
  const capped = f.draw(40, 40, await f.tick());
  assert.deepEqual(projectRows(capped, 'objective').map((r) => r.objectiveTarget.objective.id), ['follow-up', 'shipped']);
  assert.ok(capped.workboard.rows.some((r) => r.item === `home:more:${root}` && /1 more|另 1 个/.test(r.text)));
});

test('a 27-row panel keeps request prose and one row for each of 17 registrations', async (t) => {
  const f = await design(t);
  const extra = Array.from({ length: 11 }, (_, i) => join(f.dir, `study-${i}`));
  for (const root of extra) fs.mkdirSync(root);
  const roots = [...Object.values(f.roots), ...extra];
  fs.writeFileSync(join(f.home, 'projects.json'), JSON.stringify({ version: 1, projects: roots.map((root) => ({ root })) }));
  const portfolio = await f.tick();
  const rows = f.draw(40, 27, portfolio).workboard.rows;
  const projects = rows.filter((r) => r.item?.startsWith('home:project:'));
  assert.deepEqual(new Set(projects.map((r) => r.homeTarget.root)), new Set(roots));
  assert.equal(projects.length, 17);
  assert.equal(rows.length, 23, 'two headings, three request rows, seventeen project rows and the fold row');
  assert.match(stripAnsi(projects[0].text), /8\/14/);
  const tiny = f.draw(40, 6, portfolio);
  assert.deepEqual(tiny.workboard.rows, rows, 'below the minimum the same rows stay scrollable');
});

test('density drops separators, then results, then the second Objective with an updated more count', async (t) => {
  const f = await design(t);
  fs.appendFileSync(join(f.roots.harbor, '.hud/objectives.md'), '\n## follow-up: Follow up\n**State:** paused\n');
  const portfolio = await f.tick();
  for (const [height, blanks, result, objectives, more] of [[25, 4, true, 2, 1], [21, 0, true, 2, 1],
    [20, 0, false, 2, 1], [19, 0, false, 1, 2], [18, 0, false, 0, 0]]) {
    const rows = f.draw(40, height, portfolio).workboard.rows;
    assert.equal(rows.filter((r) => !r.text.trim()).length, blanks);
    assert.equal(rows.some((r) => r.item?.startsWith('home:result:')), result);
    assert.equal(rows.filter((r) => r.item?.startsWith('home:objective:') && r.objectiveTarget.root === f.roots.harbor).length, objectives);
    assert.equal(rows.find((r) => r.item === `home:more:${f.roots.harbor}`)?.text.includes(`${more} more`) ?? false, more > 0);
  }
});

test('Home bars exclude dropped tickets and omit figures for unread linked features', async (t) => {
  const f = await design(t), root = f.roots.harbor;
  fs.writeFileSync(join(root, '.scratch/rate-limit-core/issues/06-drop.md'), '# 06: Dropped\n**Status:** dropped\n**Blocked by:** none\n');
  const job = join(f.home, 'jobs/j0000000000000003');
  fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(join(job, 'job.json'), JSON.stringify({ role: 'reviewer', cwd: root }));
  fs.writeFileSync(join(job, 'STATUS.json'), JSON.stringify({ state: 'queued' }));
  const prev = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  try {
    const rows = async () => f.draw(40, 40, await f.tick()).workboard.rows;
    const rate = (rows) => rows.find((r) => r.item === `home:objective:${root}:rate-limits`).text;
    const known = await rows();
    assert.match(rate(known), /4\/8/);
    assert.match(known.find((r) => r.item === `home:project:${root}`).text, /⚒1 ⚖1 ◷⚖1/);
    const path = join(root, '.hud/objectives.md'), original = fs.readFileSync(path, 'utf8');
    fs.writeFileSync(path, original.replace('quota-headers', 'unread-feature'));
    assert.doesNotMatch(rate(await rows()), /[█▒░╌]|\d\/\d/);
    fs.writeFileSync(path, original);
    const truncated = join(root, '.scratch/rate-limit-core/issues/07-partial.md');
    fs.writeFileSync(truncated, 'x'.repeat(66_000));
    assert.doesNotMatch(rate(await rows()), /[█▒░╌]|\d\/\d/);
    fs.rmSync(truncated);
    // A finished feature outside the Tickets page preview still belongs to its Objective.
    for (const slug of ['archived-work', ...Array.from({ length: 16 }, (_, i) => `other-${i}`)]) {
      const issue = join(root, '.scratch', slug, 'issues/01-done.md');
      fs.mkdirSync(join(issue, '..'), { recursive: true });
      fs.writeFileSync(issue, '# 01: Finished\n**Status:** done\n**Blocked by:** none\n');
      if (slug === 'archived-work') fs.utimesSync(issue, new Date(NOW - 30 * 86_400_000), new Date(NOW - 30 * 86_400_000));
    }
    fs.writeFileSync(path, original.replace('quota-headers', 'quota-headers, archived-work'));
    assert.match(rate(await rows()), /5\/9/);
  } finally { setDisplayConfig(prev); }
});

/** Four features harbor's Objectives do not list: two open ones, and two finished ones with a live job. */
async function unlinkedWork(t) {
  const f = await design(t), root = f.roots.harbor;
  const feature = (slug, statuses, ageDays) => statuses.forEach((status, i) => {
    const file = join(root, '.scratch', slug, `issues/0${i + 1}-demo.md`), at = new Date(NOW - ageDays * 86_400_000);
    fs.mkdirSync(join(file, '..'), { recursive: true });
    fs.writeFileSync(file, `# 0${i + 1}: Sample ${i + 1}\n**Status:** ${status}\n**Blocked by:** none\n`);
    fs.utimesSync(file, at, at);
  });
  const job = (id, receipt, state) => {
    const dir = join(f.home, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ cwd: root, created_at: new Date(NOW - 60_000).toISOString(), ...receipt }));
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state }));
  };
  feature('workflow', ['done', ...Array(6).fill('ready-for-agent')], 1);
  feature('pi-worker', ['done', 'wontfix', 'ready-for-agent', 'needs-info', 'ready-for-human', 'claimed'], 2);
  feature('old-batch', ['done', 'wontfix'], 0);
  feature('council', ['done'], 5);
  feature('advisor', ['done'], 6);
  job('j00000000000000a1', { role: 'imp', ticket: 'council/01' }, 'working');
  job('j00000000000000a2', { role: 'oracle', package: 'advisor' }, 'queued');
  const rowOf = (rows) => rows.find((r) => r.item === `home:unlinked:${root}`);
  return { ...f, root, feature, job, rowOf };
}

test('work no Objective lists shows on one Home row, live features first, and leaves once listed', async (t) => {
  const f = await unlinkedWork(t), { root } = f;
  // Open work in a project without an Objective record is not "unlinked".
  const sketch = join(f.roots.sketch, '.scratch/loose/issues/01-demo.md');
  fs.mkdirSync(join(sketch, '..'), { recursive: true });
  fs.writeFileSync(sketch, '# 01: Sample\n**Status:** ready-for-agent\n**Blocked by:** none\n');
  const prev = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  try {
    const portfolio = await f.tick(), frame = f.draw(80, 40, portfolio);
    const rows = frame.workboard.rows, row = f.rowOf(rows);
    assert.equal(row.text.trimEnd(), '  ◌ Unlinked: council 1/1 · advisor 1/1 · workflow 1/7 · pi-worker 1/5');
    assert.deepEqual(rows.filter((r) => r.item?.startsWith('home:unlinked:')), [row]);
    const objectives = rows.filter((r) => r.item?.startsWith('home:objective:') && r.objectiveTarget.root === root);
    assert.ok(rows.indexOf(row) > rows.indexOf(objectives.at(-1)));
    assert.ok(rows.indexOf(row) < rows.findIndex((r) => r.item?.startsWith('home:project:') && r.homeTarget.root !== root));
    const { state } = handleMonitorInput({ ...frame.state, home: { ...frame.state.home, cursor: row.item } },
      { type: 'key', key: 'enter' }, { frame });
    assert.equal(state.activeTab, 'project');
    // An incompletely read feature keeps its name without a figure.
    fs.writeFileSync(join(root, '.scratch/workflow/issues/08-partial.md'), 'x'.repeat(66_000));
    assert.match(f.rowOf(f.draw(80, 40, await f.tick()).workboard.rows).text, /advisor 1\/1 · workflow · pi-worker 1\/5/);
    fs.appendFileSync(join(root, '.hud/objectives.md'), '\n## loose: Listed now\n**State:** done\n**Features:** workflow, pi-worker, council, advisor\n');
    const linked = await f.tick();
    assert.deepEqual(linked.projects.find((p) => p.root === root).snapshot.unlinked, []);
    assert.ok(!f.draw(80, 40, linked).workboard.rows.some((r) => r.item?.startsWith('home:unlinked:')));
  } finally { setDisplayConfig(prev); }
});

test('the unlinked row keeps exact width in EN and ZH and folds before any Objective row', async (t) => {
  const f = await unlinkedWork(t), portfolio = await f.tick();
  for (const icons of ['unicode', 'nerd', 'text']) for (const lang of ['en', 'zh']) for (const width of [40, 50, 80]) {
    const prev = setDisplayConfig({ theme: 'mocha', icons }), prevLang = setLanguage(lang);
    try {
      const frame = f.draw(width, 60, portfolio), row = f.rowOf(frame.workboard.rows);
      assert.ok([...frame.lines, row.text].every((line) => visualLength(line) === width));
      const text = stripAnsi(row.text).trimEnd(), shown = { 40: 1, 50: 2, 80: 4 }[width];
      assert.match(text, lang === 'en' ? / Unlinked: council 1\/1/ : / 未归入目标: council 1\/1/);
      assert.equal(text.match(/\d\/\d/g).length, shown, text);
      assert.equal(text.endsWith(` +${4 - shown}`), shown < 4, text);
    } finally { setLanguage(prevLang); setDisplayConfig(prev); }
  }
  const seen = [];
  for (let height = 60; height >= 18; height--) {
    const rows = f.draw(40, height, portfolio).workboard.rows;
    seen.push({ unlinked: !!f.rowOf(rows), results: rows.some((r) => r.item?.startsWith('home:result:')),
      objectives: rows.filter((r) => r.item?.startsWith('home:objective:') && r.objectiveTarget.root === f.root).length });
  }
  assert.ok(seen[0].unlinked);
  assert.ok(seen.every((s) => !s.unlinked || s.objectives === 2), 'never shown while an Objective row is folded');
  assert.ok(seen.some((s) => s.unlinked && !s.results), 'results fold first');
  assert.ok(seen.some((s) => !s.unlinked && s.objectives === 2), 'then the row, before any Objective');
  // One long slug is cut; its count and the number left over stay.
  const slug = 'synthetic-feature-with-a-very-long-name';
  f.feature(slug, ['ready-for-agent'], 0);
  f.job('j00000000000000a3', { role: 'imp', ticket: `${slug}/01` }, 'working');
  const prev = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  try {
    assert.match(f.rowOf(f.draw(40, 60, await f.tick()).workboard.rows).text, /synthetic-feat\S*… 0\/1 \+4$/);
  } finally { setDisplayConfig(prev); }
});

test('Project lists the unlinked features after the Objectives, with their jobs and a five-row preview', async (t) => {
  const f = await unlinkedWork(t), { root } = f;
  const collector = new ProjectCollector(root, f.home);
  const draw = (data, width, state = { ...initialMonitorState(), activeTab: 'project' }) =>
    renderMonitor({ state, width, height: 80, nowMs: NOW, project: data, projectName: 'harbor-api' });
  const data = await collector.collect(true, board, NOW);
  assert.deepEqual(data.unlinked.map((u) => u.slug), ['council', 'advisor', 'workflow', 'pi-worker']);
  const prev = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  try {
    for (const lang of ['en', 'zh']) for (const width of [40, 80]) {
      const prevLang = setLanguage(lang);
      try {
        const frame = draw(data, width), text = plain(frame);
        assert.ok(frame.lines.every((line) => visualLength(line) === width));
        const head = lang === 'en' ? 'Unlinked' : '未归入目标', jobs = lang === 'en' ? 'Jobs in Project' : '任务';
        assert.match(text, new RegExp(`${head} .*4\\n  council +█+ +1/1.*\\n {6}\\S+ 01 Sample 1.*\\n  advisor +█+ +1/1.*\\n  workflow .*1/7.*\\n  pi-worker .*1/5`));
        assert.ok(text.indexOf(head) < text.indexOf(`${jobs} `), 'a job no ticket claims stays in the jobs list');
      } finally { setLanguage(prevLang); }
    }
    const frame = draw(data, 80), row = frame.workboard.rows.find((r) => /^  workflow /.test(r.text));
    frame.state.project.nav.cursor = row.item;
    assert.deepEqual(handleMonitorInput(frame.state, { type: 'key', key: 'enter' }, { frame }).action,
      { type: 'open-files', files: [join(root, '.scratch/workflow/issues/02-demo.md')] });
    f.feature('fifth', ['ready-for-agent'], 3);
    f.feature('sixth', ['ready-for-agent'], 4);
    const more = await collector.collect(true, board, NOW), folded = draw(more, 80);
    assert.doesNotMatch(plain(folded), /^  sixth /m);
    const toggle = folded.workboard.rows.find((r) => r.item === 'project:fold:unlinked:more');
    assert.match(toggle.text, /1 more/);
    folded.state.project.nav.cursor = toggle.item;
    const { state } = handleMonitorInput(folded.state, { type: 'key', key: 'enter' }, { frame: folded });
    assert.match(plain(draw(more, 80, state)), /^  sixth [\s\S]*fewer/m);
  } finally { setDisplayConfig(prev); }
});

test('only recent dated receipts appear on Home; Objective and result rows open the same Objective', async (t) => {
  const f = await design(t), root = f.roots.harbor;
  for (const [suffix, prefix] of [['rate-limits', 'objective'], ['rate-limits', 'result']]) {
    const frame = f.draw(40, 40, f.homePortfolio, { ...initialMonitorState(), home: { cursor: `home:${prefix}:${root}:${suffix}` } });
    const { state, action } = handleMonitorInput(frame.state, { type: 'key', key: 'enter' }, { frame });
    assert.equal(action, undefined);
    assert.equal(state.subpage.kind, 'objective');
    assert.equal(state.subpage.target.root, root);
    assert.equal(state.subpage.target.objective.id, suffix);
    assert.equal(state.subpage.target.blocked, true);
  }
  const receipt = join(f.home, 'events/2026-11.jsonl');
  const harbor = f.homePortfolio.projects.find((p) => p.root === root);
  const result = harbor.snapshot.objectives.objectives.find((o) => o.id === 'rate-limits').result;
  const event = { v: 1, kind: 'objective', project: root, id: 'rate-limits', change: 'result', result };
  for (const [offset, expected] of [[3 * 86_400_000, true], [3 * 86_400_000 + 1, false], [undefined, false]]) {
    fs.writeFileSync(receipt, JSON.stringify({ ...event, at: offset === undefined ? undefined : new Date(NOW - offset).toISOString() }) + '\n');
    const rows = f.draw(40, 40, await f.tick()).workboard.rows;
    assert.equal(rows.some((r) => r.item?.startsWith('home:result:')), expected);
  }
});

test('requests sort by waits, project priority, then age; Enter navigates to the exact request and project without an action', async (t) => {
  const f = fixture(t), homePortfolio = await f.tick();
  assert.deepEqual(homePortfolio.requests.map(({ project, item }) => [project.name, item.request]), [
    ['paused-study', 'r1'], ['state-notes', 'r1'], ['paused-study', 'r3'], ['paused-study', 'r2'], ['state-notes', 'r2'],
  ]);
  const data = { width: 120, height: 40, nowMs, homePortfolio, projects: projectList(f.home, f.own) };
  const press = (frame, key) => handleMonitorInput(frame.state, { type: 'key', key }, { frame });
  const home = renderMonitor({ ...data, state: initialMonitorState() });
  const request = press(home, 'enter');
  assert.equal(request.action, undefined);
  assert.equal(request.state.activeTab, 'project');
  assert.equal(request.state.selectedProject, f.paused);
  assert.equal(request.state.project.view.kind, 'waiting');
  const source = homePortfolio.projects.find((p) => p.root === f.paused).snapshot;
  const waiting = renderMonitor({ ...data, state: request.state, projectName: 'paused-study', project: { ...source, waiting: [...source.waiting].reverse() } });
  assert.match(plain(waiting), /paused-study › Waiting[\s\S]*Choose alpha/);
  assert.doesNotMatch(plain(waiting), /Choose beta|Try the sample/);
  const cursor = { ...home.state.home, cursor: `home:project:${f.paused}` };
  const project = press(renderMonitor({ ...data, state: { ...home.state, home: cursor } }), 'enter');
  assert.equal(project.action, undefined);
  assert.equal(project.state.activeTab, 'project');
  assert.equal(project.state.selectedProject, f.paused);
  assert.equal(project.state.project.view.kind, 'hub');
});

test('Objective results without a matching latest receipt are shown without a date (hand edit and legacy)', async (t) => {
  const f = fixture(t), dates = async () => (await f.tick()).projects.find((p) => p.root === f.paused).resultDates;
  assert.deepEqual(await dates(), new Map([['measure', Date.parse(f.receipt.at)], ['repeat', Date.parse('2026-11-23T11:00:00Z')]]));
  f.objectives(f.paused, f.header, f.tracked.replace('The reading held.', 'Hand-edited reading.'));
  assert.equal(await dates(), undefined);
  f.objectives(f.paused, f.header, f.tracked);
  assert.equal((await dates()).get('measure'), Date.parse(f.receipt.at));
  // Latest receipt has no result text: don't borrow the date from the older matching receipt.
  f.put(f.receiptPath, [f.receipt, { ...f.receipt, result: undefined, at: '2026-11-24T10:00:00.000Z' }].map(JSON.stringify).join('\n') + '\n');
  assert.equal(await dates(), undefined);
});

test('Home verifies the whole long result and leaves ambiguous legacy excerpts undated', async (t) => {
  const f = fixture(t), date = async () => (await f.tick()).projects.find((p) => p.root === f.paused).resultDates?.get('measure');
  const prefix = 'x'.repeat(240), original = `${prefix} recorded`, edited = `${prefix} edited`;
  const write = (text) => f.objectives(f.paused, f.header, f.tracked.replace('The reading held.', text));
  const receipt = { ...f.receipt, result: prefix };
  f.put(f.receiptPath, JSON.stringify({ ...receipt, resultDigest: createHash('sha256').update(original).digest('hex') }) + '\n');
  write(original);
  assert.equal(await date(), Date.parse(receipt.at));
  write(edited);
  assert.equal(await date(), undefined);
  f.put(f.receiptPath, JSON.stringify(receipt) + '\n');
  write(original);
  assert.equal(await date(), undefined);
  write(prefix);
  assert.equal(await date(), Date.parse(receipt.at));
});

test('unchanged Home tick with eight registered projects only stats files', async (t) => {
  const f = fixture(t, 8);
  for (const [i, root] of f.roots.entries()) {
    const job = join(f.home, 'jobs', `j${String(i).padStart(16, '0')}`);
    f.put(join(job, 'job.json'), JSON.stringify({ cwd: root, role: 'imp', title: 'Example job' }));
    f.put(join(job, 'STATUS.json'), JSON.stringify({ state: i % 2 ? 'queued' : 'working' }));
  }
  const cold = await f.tick();
  assert.equal(cold.projects.length, 8);
  assert.ok(cold.projects.every((p) => p.snapshot.active.length === 1));
  assert.equal(cold.projects.filter((p) => p.snapshot.idle).length, 4);
  const originals = Object.fromEntries(['statSync', 'lstatSync', 'openSync', 'readFileSync', 'readdirSync', 'opendirSync'].map((key) => [key, fs[key]]));
  let stats = 0;
  const reads = [];
  for (const [key, method] of Object.entries(originals)) fs[key] = (path, ...args) => {
    if (key === 'statSync' || key === 'lstatSync') stats++;
    else reads.push([key, path]);
    return method(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    const warm = await f.tick(nowMs + 6000);
    assert.ok(stats > 0);
    assert.deepEqual(reads, []);
    for (const [i, p] of warm.projects.entries()) assert.equal(p.snapshot, cold.projects[i].snapshot);
  } finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
});
