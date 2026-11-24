import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HomePortfolioCollector } from '../../dist/collectors/home-portfolio.js';
import { projectList } from '../../dist/roles/projects.js';
import { handleMonitorInput, initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';

const nowMs = Date.parse('2026-11-24T12:00:00Z'), updated = new Date('2026-11-24T09:30:00Z');
const board = { lanes: [], workers: [] };
function fixture(t, count = 3) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-portfolio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'hud'), roots = ['paused-study', 'state-notes', 'offline-root', ...Array.from({ length: 5 }, (_, i) => `project-${i}`)]
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

test('Home renders all three registered projects and scoped badges in EN/ZH at 120×40 and 200×55', async (t) => {
  const f = fixture(t), homePortfolio = await f.tick();
  const homeWaiting = homePortfolio.projects.find((p) => p.root === f.own).snapshot.waiting;
  for (const [width, height] of [[120, 40], [200, 55]]) for (const lang of ['en', 'zh']) {
    const previous = setLanguage(lang);
    try {
      const frame = renderMonitor({ state: initialMonitorState(), width, height, nowMs, homePortfolio, homeWaiting,
        paneLoad: { running: 2, queued: 1 } });
      const text = plain(frame);
      assert.equal(frame.lines.length, height);
      assert.ok(frame.lines.every((line) => visualLength(line) === width));
      assert.match(text, lang === 'en' ? /Home \?2/ : /首页 \?2/);
      assert.match(text, /\? paused-study · 2026-11-23 r1 · Choose alpha · Measure the sample \(work waits\)/);
      assert.match(text, /\? state-notes · 2026-11-20 r1 · Choose beta/);
      assert.match(text, lang === 'en' ? /paused-study · paused · Idle .*high priority · updated 09:30/i : /paused-study · 已暂停 · 空闲 .*高优先级 · 更新于 09:30/);
      assert.match(text, /Measure the sample · Repeat the test/);
      assert.match(text, lang === 'en' ? /Result \(2026-11-23\): The replay agreed\./ : /结果（2026-11-23）： The replay agreed\./);
      assert.match(text, lang === 'en' ? /state-notes · unknown · Idle.*\n  Now: Read the handoff\s*\n  Next: Share the example/ : /state-notes · 未知 · 空闲.*\n  现在： Read the handoff\s*\n  下一步： Share the example/);
      assert.match(text, lang === 'en' ? /offline-root · Unavailable/ : /offline-root · 不可用/);
      assert.match(text, lang === 'en' ? /This pane · 2 running · 1 queued/ : /当前窗格 · 2 个运行中 · 1 个排队/);
      assert.doesNotMatch(text, /Retired title|Not a substitute/);
    } finally { setLanguage(previous); }
  }
});

test('requests sort by waits, project priority, then age; Enter navigates to the exact request and project without an action', async (t) => {
  const f = fixture(t), homePortfolio = await f.tick();
  assert.deepEqual(homePortfolio.requests.map(({ project, item }) => [project.name, item.request]), [
    ['paused-study', 'r1'], ['state-notes', 'r1'], ['paused-study', 'r3'], ['paused-study', 'r2'], ['state-notes', 'r2'],
  ]);
  const data = { width: 120, height: 40, nowMs, homePortfolio, projects: homePortfolio.projects };
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
  const f = fixture(t), result = async () => (await f.tick()).projects.find((p) => p.root === f.paused).result;
  assert.deepEqual(await result(), { text: 'The replay agreed.', at: Date.parse('2026-11-23T11:00:00Z') });
  f.objectives(f.paused, f.header, f.tracked.replace('The reading held.', 'Hand-edited reading.'));
  assert.deepEqual(await result(), { text: 'Hand-edited reading.', at: undefined });
  f.objectives(f.paused, f.header, f.tracked);
  assert.equal((await result()).at, Date.parse(f.receipt.at));
  // Latest receipt has no result text: don't borrow the date from the older matching receipt.
  f.put(f.receiptPath, [f.receipt, { ...f.receipt, result: undefined, at: '2026-11-24T10:00:00.000Z' }].map(JSON.stringify).join('\n') + '\n');
  assert.deepEqual(await result(), { text: 'The reading held.', at: undefined });
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
