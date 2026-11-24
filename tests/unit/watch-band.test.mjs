import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bandReader } from '../../dist/cli/watch-band.js';
import { watchCommand } from '../../dist/cli/watch.js';
import { ProjectCollector, compareOwnerRequests } from '../../dist/collectors/project-board.js';
import { HomePortfolioCollector } from '../../dist/collectors/home-portfolio.js';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { handleMonitorInput, initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { renderHtmlBoard } from '../../dist/render/html-board.js';
import { NOW, TREE, onPage, plain } from '../fixtures/project-page.mjs';

const STATE = (...items) => `# State\n\nMilestone: M1\n\n## Waiting for the owner\n\n${items.map((item) => `- ${item}\n`).join('')}\n## Next\n\n- Later\n`;

/** A synthetic project: STATE waiting items and export tickets (01 resolved, 02 and 03 to try, 04 open). */
function fixture(t, lang = 'en_US.UTF-8') {
  const root = fs.mkdtempSync(join(tmpdir(), 'watch-band-')), cwd = join(root, 'project'), hud = join(root, 'hud'), home = join(root, 'home');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(home);
  const put = (path, text) => { fs.mkdirSync(join(path, '..'), { recursive: true }); fs.writeFileSync(path, text); };
  const state = (...items) => put(join(cwd, 'docs/handoff/STATE.md'), STATE(...items));
  const ticket = (n, status) => put(join(cwd, '.scratch/export/issues', `0${n}-sample.md`), `# 0${n}: Sample ${n}\n**Status:** ${status}\n**Blocked by:** none\n`);
  state('Decide the export format', 'Pick a vendor (waits on export/01)', 'Send a sample file (waits on export/04)');
  ['resolved', 'try', 'try', 'ready-for-agent'].forEach((status, i) => ticket(i + 1, status));
  const env = { HOME: home, HUD_HOME: hud, LANG: lang, HUD_SETTINGS_PATH: join(root, 'settings.json') };
  return { cwd, hud, home, env, put, state, ticket, read: bandReader(cwd, hud, env) };
}
const board = { revision: 'synthetic', workers: [], lanes: [], decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: null } };

test('the band and Project hub show explicit waiting items, not a prompt to try pending tickets', async (t) => {
  const f = fixture(t), band = await f.read(NOW);
  assert.deepEqual(band, { type: 'band', lang: 'en', waiting: 2, first: 'Decide the export format', fresh: false });

  const project = await new ProjectCollector(f.cwd, f.hud, f.env, f.home).collect('home', board, NOW);
  assert.deepEqual(project.waiting.map((item) => item.value), ['Decide the export format', 'Send a sample file (waits on export/04)']);
  const hub = plain(renderMonitor({ state: onPage(undefined), tree: TREE, workboard: board, project, width: 60, height: 40, nowMs: NOW })).join('\n');
  assert.match(hub, new RegExp(`^Needs you ─+ ${band.waiting}$`, 'm'));
  assert.equal(project.ledger.filter((row) => row.state === 'try').length, 2);
  assert.doesNotMatch(hub, /Accept all|\d+ to try/);
});

test('the band is read again only when it changes, and announces only what is new', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.read(NOW), { type: 'band', lang: 'en', first: 'Decide the export format', fresh: false, waiting: 2 });
  assert.equal(await f.read(NOW), undefined);

  f.state('Decide the export format', 'Choose a locale', 'Send a sample file (waits on export/04)');
  assert.deepEqual(await f.read(NOW), { type: 'band', lang: 'en', first: 'Decide the export format', fresh: true, waiting: 3 });

  f.state('Choose a locale'); // Two items were handled and none added: nothing new to announce.
  assert.deepEqual(await f.read(NOW), { type: 'band', lang: 'en', first: 'Choose a locale', fresh: false, waiting: 1 });

  f.ticket(4, 'try');
  assert.equal(await f.read(NOW), undefined, 'a new try does not redraw the band or announce anything');

  f.state();
  assert.deepEqual(await f.read(NOW), { type: 'band', lang: 'en', first: '', fresh: false, waiting: 0 });
});

test('the band carries the panel language, and a folder without STATE or tickets has an empty band', async (t) => {
  const f = fixture(t, 'zh_CN.UTF-8');
  assert.equal((await f.read(NOW)).lang, 'zh');
  fs.writeFileSync(join(f.cwd, '..', 'settings.json'), '{"language":"en"}');
  assert.equal((await f.read(NOW)).lang, 'en');
  const empty = bandReader(join(f.cwd, 'missing'), f.hud, f.env);
  assert.deepEqual(await empty(NOW), { type: 'band', lang: 'en', waiting: 0, first: '', fresh: false });
});

test('request order is waited-on, then project priority, then oldest dated first; undated ties keep file order', async (t) => {
  const at = (day) => Date.parse(day);
  const old = at('2026-01-05'), recent = at('2026-02-03');
  const requests = [
    { id: 'old low priority', waitedOn: true, at: old, priority: 1 },
    { id: 'not waited on', waitedOn: false, at: old, priority: 10 },
    { id: 'new high priority', waitedOn: true, at: recent, priority: 2 },
    { id: 'undated high priority', waitedOn: true, priority: 2 },
    { id: 'old high priority', waitedOn: true, at: old, priority: 2 },
  ];
  assert.deepEqual(requests.sort((a, b) => compareOwnerRequests(a, b, a.priority, b.priority)).map((r) => r.id),
    ['old high priority', 'new high priority', 'undated high priority', 'old low priority', 'not waited on']);

  const f = fixture(t);
  const items = ['2026-01-01 Optional', 'First undated (work waits)', '2026-02-03 Newer (work waits)',
    '2026-01-05 Earlier (waits on export/04)', 'Second undated (work waits)', '2025-12-31 Settled (waits on export/01)'];
  f.state(...items);
  const project = await new ProjectCollector(f.cwd, f.hud, f.env, f.home).collect('home', board, NOW);
  assert.deepEqual(project.waiting.map((r) => r.value), [items[2], items[1], items[4], items[0], items[3]]);
  assert.equal((await f.read(NOW)).first, items[2]);
});

test('a numbered request displays its ID and current Objective title on all owner surfaces', async (t) => {
  const f = fixture(t), legacy = 'Legacy question (objective measure)';
  const objective = join(f.cwd, '.hud/objectives.md');
  const title = (value) => f.put(objective, `## measure: ${value}\n**State:** active\n`);
  f.state('2026-01-01 [r7] Choose a layout (objective measure) (work waits)', legacy);
  title('Measure sample');
  const collector = new ProjectCollector(f.cwd, f.hud, f.env, f.home);
  const portfolio = new HomePortfolioCollector(f.hud);
  const draw = async () => {
    const homePortfolio = await portfolio.read([{ root: f.cwd, name: 'project' }], board, NOW);
    const project = await collector.collect('export', board, NOW);
    const render = (state) => plain(renderMonitor({ state, project, homePortfolio, tree: TREE, workboard: board, width: 100, height: 30, nowMs: NOW })).join('\n');
    return [render(initialMonitorState()), render(onPage()),
      renderHtmlBoard({ project, workboard: board, projectName: 'Sample', root: f.cwd, generatedAt: NOW })];
  };
  const expected = '2026-01-01 r7 · Choose a layout · Measure sample (work waits)';
  for (const text of await draw()) {
    assert.ok(text.includes(expected));
    assert.ok(text.includes(legacy));
    assert.ok(!text.includes('[r7]'));
  }
  assert.equal((await f.read(NOW)).first, expected);
  title('Measure another sample');
  const renamed = await f.read(NOW);
  assert.equal(renamed.fresh, false, 'a title edit does not open a request');
  assert.match(renamed.first, /Measure another sample/);
  f.state(legacy); // No log is needed to clear a hand-removed line.
  assert.deepEqual(await f.read(NOW), { type: 'band', lang: 'en', first: legacy, waiting: 1, fresh: false });
  for (const text of await draw()) {
    assert.ok(!text.includes('r7 · Choose a layout'));
    assert.ok(text.includes(legacy));
  }
});

test('M1: a routine question wakes main, stays in Jobs → Inspector, and never becomes an owner request', async (t) => {
  const f = fixture(t), run = (env) => {
    const records = [], ac = new AbortController();
    const done = watchCommand(['--mod'], { env: { ...f.env, HERDR_PANE_ID: 'w4E:p1', ...env }, stdout: (s) => records.push(JSON.parse(s)), stderr: (s) => assert.fail(s) },
      { signal: ac.signal, rescanMs: 50, settlementWindowMs: 40 });
    return { records, stop: () => { ac.abort(); return done; } };
  };
  const cwd = process.cwd();
  process.chdir(f.cwd);
  t.after(() => process.chdir(cwd));
  const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25)); assert.ok(check(), 'timed out'); };

  const legacy = run({});
  await new Promise((r) => setTimeout(r, 300));
  await legacy.stop();
  assert.deepEqual(legacy.records, []);

  f.state();
  const mod = run({ HUD_MOD_CURSOR: '' });
  try {
    await until(() => mod.records.length >= 2);
    assert.deepEqual(mod.records, [{ type: 'ready' }, { type: 'band', lang: 'en', waiting: 0, first: '', fresh: false }]);
    const id = 'j0000000000000001', job = join(f.hud, 'jobs', id), pane = 'w4E:p1';
    const question = 'Which sample layout should I use?', explicit = 'Decide the public export format (work waits)';
    f.put(join(job, 'job.json'), JSON.stringify({ job: id, role: 'imp', cwd: f.cwd, caller_pane: pane,
      created_at: new Date(NOW - 60_000).toISOString(), task: 'Build sample export' }));
    f.put(join(job, 'STATUS.json'), JSON.stringify({ state: 'waiting_orchestrator' }));
    f.put(join(job, 'qa/q1.md'), `# Question q1 from imp\n\n${question}\n\nDefault if unanswered: rows\n`);
    await until(() => mod.records.some((r) => r.type === 'wake' && r.lines.some((line) => line.includes(question))));
    const notice = mod.records.flatMap((r) => r.lines ?? []).find((s) => s.includes(question));
    assert.match(notice, new RegExp(`hud_respond job=${id} request_id=q1`));
    assert.equal(mod.records.filter((r) => r.type === 'band').length, 1, 'the question did not change the owner band');

    f.state(explicit);
    await until(() => mod.records.some((r) => r.type === 'band' && r.fresh));
    assert.deepEqual(mod.records.filter((r) => r.type === 'band').at(-1),
      { type: 'band', lang: 'en', waiting: 1, first: explicit, fresh: true });
    const lanes = readThinJobs(f.hud, { project: f.cwd, pane });
    const workboard = { ...board, lanes, workers: lanes.flatMap((lane) => lane.workers) };
    const project = await new ProjectCollector(f.cwd, f.hud, f.env, f.home).collect('export', workboard, NOW);
    assert.ok(project.active.some((j) => j.jobId === id && j.asking), 'export knows about the asking job');
    const homePortfolio = await new HomePortfolioCollector(f.hud).read([{ root: f.cwd, name: 'project' }], workboard, NOW);
    const draw = (state) => renderMonitor({ state, tree: TREE, workboard, project, homePortfolio, width: 80, height: 30, nowMs: NOW });
    const hub = plain(draw(onPage())).join('\n');
    const home = draw(initialMonitorState());
    for (const text of [hub, plain(home).join('\n'), renderHtmlBoard({ project, workboard, projectName: 'Sample', root: f.cwd, generatedAt: NOW })]) {
      assert.ok(text.includes(explicit));
      assert.ok(!text.includes(question));
    }
    assert.match(hub, /^Needs you ─+ 1$/m);
    const press = (frame, key) => draw(handleMonitorInput(frame.state, { type: 'key', key }, { frame }).state);
    const jobs = press(home, 'jobs');
    assert.equal(jobs.state.subpage.kind, 'jobs');
    const inspector = press(jobs, 'enter');
    assert.equal(inspector.state.subpage.kind, 'inspector');
    assert.ok(plain(inspector).join('\n').includes(question));
  } finally { await mod.stop(); }
});
