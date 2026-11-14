import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { projectList } from '../../dist/roles/projects.js';

const NOW = Date.parse('2026-11-14T10:00:00Z');
const EMPTY_BOARD = { revision: 'synthetic', lanes: [], workers: [], decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: '' } };

function makeTemp(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-data-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'), hud = join(root, 'hud'), home = join(root, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(hud, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const put = (path, content) => {
    fs.mkdirSync(join(path, '..'), { recursive: true });
    fs.writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  };
  return { root, cwd, hud, home, env: { HOME: home, HUD_HOME: hud, PATH: process.env.PATH ?? '' }, put };
}

function initRepo(cwd, commits) {
  const git = (args, date) => execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@invalid', ...args], {
    cwd, stdio: 'pipe', encoding: 'utf8',
    env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  }).trim();
  git(['init', '-b', 'synthetic-main']);
  const hashes = [];
  for (const [i, { file, msg, date }] of commits.entries()) {
    fs.writeFileSync(join(cwd, file), `line ${i}\n`);
    git(['add', file]);
    git(['commit', '-m', msg], date);
    hashes.push(git(['rev-parse', '--short=7', 'HEAD']));
  }
  return hashes;
}

test('ledger parses ## Slices in order with milestone, commit and batched git commit date', async (t) => {
  const f = makeTemp(t);
  const [h1, h2] = initRepo(f.cwd, [
    { file: 'a.txt', msg: 'first', date: '2026-11-10T08:00:00Z' },
    { file: 'b.txt', msg: 'second', date: '2026-11-12T09:30:00Z' },
  ]);
  f.put(join(f.cwd, 'docs/handoff/STATE.md'), [
    '# State', '', '## Slices', '',
    `- accepted · M1 · FIRST · landed first (${h1})`,
    `- try · 0.1.3 · SECOND · multi hash (deadbee, ${h2})`,
    '- working · M4 · NO-HASH · still building',
    '- todo · M4 · UNKNOWN · bogus commit (0000000)',
    '- mystery · M4 · IGNORED · unknown state',
  ].join('\n'));
  const data = await new ProjectCollector(f.cwd, f.hud, f.env, f.home).collect(true, EMPTY_BOARD, NOW);
  assert.deepEqual(data.ledger, [
    { id: 'FIRST', state: 'accepted', milestone: 'M1', text: `landed first (${h1})`, commit: h1, at: Date.parse('2026-11-10T08:00:00Z') },
    { id: 'SECOND', state: 'try', milestone: '0.1.3', text: `multi hash (deadbee, ${h2})`, commit: h2, at: Date.parse('2026-11-12T09:30:00Z') },
    { id: 'NO-HASH', state: 'working', milestone: 'M4', text: 'still building' },
    { id: 'UNKNOWN', state: 'todo', milestone: 'M4', text: 'bogus commit (0000000)', commit: '0000000' },
  ]);
  assert.equal('at' in data.ledger[2], false);
  assert.equal('at' in data.ledger[3], false);
});

test('active lists only unsettled jobs under project root; settled and other-root jobs excluded', async (t) => {
  const f = makeTemp(t);
  const sub = join(f.cwd, 'packages/sub'), alias = join(f.root, 'sub-link'), sibling = join(f.root, 'project-other');
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.symlinkSync(sub, alias);
  const addJob = (n, job, status, ageMin = n) => {
    const id = `j${String(n).padStart(16, '0')}`, dir = join(f.hud, 'jobs', id);
    f.put(join(dir, 'job.json'), { job: id, created_at: new Date(NOW - ageMin * 60000).toISOString(), ...job });
    if (status) f.put(join(dir, 'STATUS.json'), status);
    fs.utimesSync(dir, new Date(NOW - ageMin * 60000), new Date(NOW - ageMin * 60000));
    return id;
  };
  const jWork = addJob(1, { role: 'imp', cwd: f.cwd, package: 'hub' }, { state: 'working', started_at: new Date(NOW - 5 * 60000).toISOString() });
  const jAsk = addJob(2, { role: 'reviewer', cwd: alias, task: 'Review   hub  data' }, { state: 'waiting_orchestrator', started_at: new Date(NOW - 2 * 60000).toISOString() });
  const jHelper = addJob(3, { role: 'oracle', cwd: sub }, { state: 'waiting_helper' });
  for (const [i, state] of ['idle_grace', 'closed', 'done', 'failed', 'stopped'].entries()) {
    addJob(10 + i, { role: 'imp', cwd: f.cwd }, { state });
  }
  addJob(20, { role: 'imp', cwd: sibling }, { state: 'working' });
  addJob(21, { role: 'imp', cwd: f.cwd, reaped_at: new Date(NOW).toISOString() }, { state: 'working' });
  const board = { ...EMPTY_BOARD, workers: [{ id: `thin-job:${jWork}`, laneId: 'l1', task: 'Build hub data', evidence: [{ sourceId: jWork }] }] };
  const data = await new ProjectCollector(f.cwd, f.hud, f.env, f.home).collect(true, board, NOW);
  assert.deepEqual(data.active, [
    { jobId: jWork, role: 'imp', state: 'working', package: 'hub', title: 'Build hub data', at: NOW - 5 * 60000, asking: false },
    { jobId: jAsk, role: 'reviewer', state: 'waiting_orchestrator', title: 'Review hub data', at: NOW - 2 * 60000, asking: true },
    { jobId: jHelper, role: 'oracle', state: 'waiting_helper', at: NOW - 3 * 60000, asking: false },
  ]);
});

test('ticket items and latest ## Comments bullet parsed; absent comments omitted and >600 chars capped', async (t) => {
  const f = makeTemp(t);
  const longText = 'x'.repeat(650);
  f.put(join(f.cwd, '.scratch/hub/issues/01-with-comments.md'), [
    '# 01: With comments', '', '**Blocked by:** None', '**Status:** ready-for-agent', '',
    '- [x] Done item', '* [X] Uppercase done', '- [ ]   Open   item  ', '',
    '## Comments', '', '- first comment', '- 2026-11-14 imp: second', '  wrapped line',
  ].join('\n'));
  f.put(join(f.cwd, '.scratch/hub/issues/02-no-comments.md'), [
    '# 02: No comments', '**Blocked by:** None', '**Status:** ready-for-agent', '- [ ] One item',
  ].join('\n'));
  f.put(join(f.cwd, '.scratch/hub/issues/03-long-comment.md'), [
    '# 03: Long comment', '**Blocked by:** None', '**Status:** ready-for-agent', '',
    '## Comments', '', `- ${longText}`,
  ].join('\n'));
  const data = await new ProjectCollector(f.cwd, f.hud, f.env, f.home).collect(true, EMPTY_BOARD, NOW);
  const tickets = data.tickets[0].tickets;
  assert.deepEqual(tickets[0].items, [
    { done: true, text: 'Done item' },
    { done: true, text: 'Uppercase done' },
    { done: false, text: 'Open item' },
  ]);
  assert.equal(tickets[0].comment, '2026-11-14 imp: second wrapped line');
  assert.equal('comment' in tickets[1], false);
  assert.equal(tickets[2].comment.length, 600);
});

test('projectList orders panel root first, deduplicates by realpath, drops missing dirs, caps at 16, tolerates bad files', async (t) => {
  const f = makeTemp(t);
  const panelLink = join(f.root, 'panel-link');
  fs.symlinkSync(f.cwd, panelLink);
  assert.deepEqual(projectList(f.hud, panelLink), [{ root: fs.realpathSync(f.cwd), name: 'project' }]);
  f.put(join(f.hud, 'projects.json'), '{not json');
  assert.deepEqual(projectList(f.hud, f.cwd), [{ root: fs.realpathSync(f.cwd), name: 'project' }]);
  f.put(join(f.hud, 'projects.json'), { version: 2, projects: [{ root: f.root }] });
  assert.deepEqual(projectList(f.hud, f.cwd), [{ root: fs.realpathSync(f.cwd), name: 'project' }]);

  const extra = [];
  for (let i = 0; i < 18; i++) {
    const dir = join(f.root, `proj-${String(i).padStart(2, '0')}`);
    fs.mkdirSync(dir);
    extra.push(dir);
  }
  const dupLink = join(f.root, 'dup-proj-00'), regularFile = join(f.root, 'not-a-dir');
  fs.symlinkSync(extra[0], dupLink);
  fs.writeFileSync(regularFile, 'file');
  f.put(join(f.hud, 'projects.json'), {
    version: 1,
    projects: [
      { root: panelLink },
      { root: join(f.root, 'missing-dir') },
      { root: regularFile },
      { root: extra[0] },
      { root: dupLink },
      ...extra.slice(1).map((root) => ({ root })),
    ],
  });
  const listed = projectList(f.hud, f.cwd);
  assert.equal(listed.length, 16);
  assert.deepEqual(listed[0], { root: fs.realpathSync(f.cwd), name: 'project' });
  assert.deepEqual(listed[1], { root: fs.realpathSync(extra[0]), name: 'proj-00' });
  assert.equal(listed.at(-1).name, 'proj-14');
  // Listed project without STATE.md still collects cleanly.
  const listedSnap = await new ProjectCollector(listed[1].root, f.hud, f.env, f.home).collect(true, EMPTY_BOARD, NOW);
  assert.deepEqual(listedSnap.ledger, []);
  assert.deepEqual(listedSnap.active, []);
});

test('home-mode collection spawns no git or job reads; full collection gates git to 5 seconds', async (t) => {
  const f = makeTemp(t);
  const [h1] = initRepo(f.cwd, [{ file: 'a.txt', msg: 'init', date: '2026-11-12T10:00:00Z' }]);
  f.put(join(f.cwd, 'docs/handoff/STATE.md'), `# State\n\n## Slices\n- try · M4 · SLICE · landed (${h1})\n`);
  f.put(join(f.cwd, '.scratch/hub/issues/01-item.md'), '# 01: Item\n**Blocked by:** None\n**Status:** ready-for-agent\n- [ ] Check\n## Comments\n- note\n');
  const jobDir = join(f.hud, 'jobs', 'j0000000000000001');
  f.put(join(jobDir, 'job.json'), { job: 'j0000000000000001', role: 'imp', cwd: f.cwd, created_at: new Date(NOW).toISOString() });
  f.put(join(jobDir, 'STATUS.json'), { state: 'working' });

  const opened = [], spawned = [];
  const origOpen = fs.openSync, origExec = childProcess.execFile;
  fs.openSync = (path, ...args) => { opened.push(String(path)); return origOpen(path, ...args); };
  childProcess.execFile = (...args) => { spawned.push(args[0]); return origExec(...args); };
  syncBuiltinESMExports();
  t.after(() => { fs.openSync = origOpen; childProcess.execFile = origExec; syncBuiltinESMExports(); });

  const collector = new ProjectCollector(f.cwd, f.hud, f.env, f.home);
  const homeSnap = await collector.collect('home', EMPTY_BOARD, NOW);
  assert.deepEqual(spawned, []);
  assert.ok(opened.every((p) => p.endsWith('/STATE.md') || /\/issues\/01-item\.md$/.test(p)));
  assert.equal(homeSnap.ledger[0].commit, h1);
  assert.equal('at' in homeSnap.ledger[0], false);
  assert.deepEqual(homeSnap.active, []);
  assert.equal(homeSnap.tickets[0].tickets[0].comment, 'note');

  const first = await collector.collect(true, EMPTY_BOARD, NOW);
  assert.equal(first.ledger[0].at, Date.parse('2026-11-12T10:00:00Z'));
  const spawnsAfterCold = spawned.length;
  assert.ok(spawnsAfterCold > 0);
  fs.renameSync(join(f.cwd, '.git'), join(f.cwd, '.git-hidden'));
  const warm = await collector.collect(true, EMPTY_BOARD, NOW + 4999);
  assert.equal(spawned.length, spawnsAfterCold);
  assert.equal(warm.ledger[0].at, Date.parse('2026-11-12T10:00:00Z'));
  const expired = await collector.collect(true, EMPTY_BOARD, NOW + 5000);
  assert.ok(spawned.length > spawnsAfterCold);
  assert.equal('at' in expired.ledger[0], false);
});
