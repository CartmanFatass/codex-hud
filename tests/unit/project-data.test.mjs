import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { ProjectOverviews } from '../../dist/collectors/project-visits.js';
import { clearJobIndexCaches } from '../../dist/roles/job-index-cache.js';
import { appendTry, TryLog } from '../../dist/collectors/try-records.js';
import { currentRows, homeProgressRows, pageRows } from '../../dist/render/project-view.js';
import { renderHtmlBoard } from '../../dist/render/html-board.js';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { stripAnsi } from '../../dist/render/colors.js';
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

test('an active job with no workboard description is titled from its brief.md, through the cached bounded read, in full collection only', async (t) => {
  const f = makeTemp(t);
  const add = (n, brief, job = {}, extra = {}) => {
    const id = `j${String(n).padStart(16, '0')}`, dir = join(f.hud, 'jobs', id);
    // Another pane's job: normal MCP job.json has no title or task.
    f.put(join(dir, 'job.json'), { job: id, role: 'imp', cwd: f.cwd, herdr_pane: 'w4E:p9', created_at: new Date(NOW - n * 60000).toISOString(), ...job });
    f.put(join(dir, 'STATUS.json'), { state: 'working', started_at: new Date(NOW - n * 60000).toISOString() });
    if (brief !== undefined) f.put(join(dir, 'brief.md'), brief);
    for (const [name, text] of Object.entries(extra)) f.put(join(dir, name), text);
    return id;
  };
  const heading = add(1, '# Build   the Project tab\n\nSecond paragraph that is not the title.');
  const late = add(2, 'Some context first.\n\n## The real heading\ntext');
  const line = add(3, '\n  \n  Fix   the flaky test\nmore text');
  const long = add(4, `# ${'w'.repeat(300)}`);
  const none = add(5, undefined);
  const empty = add(6, '\n\n  \n');
  const explicit = add(7, '# Brief heading', { title: 'Explicit title' });
  const reported = add(8, '# Reported job', {}, { 'report.md': '# Report' });
  const big = add(9, `# Heading of a large brief\n${'x'.repeat(300000)}`);
  const board = { ...EMPTY_BOARD, workers: [{ id: 'w', laneId: 'l', task: 'Workboard description', evidence: [{ sourceId: heading }] }] };
  const opened = [];
  const origOpen = fs.openSync;
  fs.openSync = (path, ...args) => { opened.push(String(path)); return origOpen(path, ...args); };
  syncBuiltinESMExports();
  t.after(() => { fs.openSync = origOpen; syncBuiltinESMExports(); });
  const collector = new ProjectCollector(f.cwd, f.hud, f.env, f.home);
  await collector.collect('home', board, NOW);
  assert.equal(opened.some((p) => p.endsWith('/brief.md')), false, 'Home never looks at a brief');
  const data = await collector.collect(true, { ...board, workers: [] }, NOW);
  const by = (id) => data.active.find((a) => a.jobId === id);
  assert.equal(by(heading).title, 'Build the Project tab');
  assert.equal(by(late).title, 'The real heading', 'the first heading wins over an earlier line');
  assert.equal(by(line).title, 'Fix the flaky test', 'no heading: the first non-empty line');
  assert.equal(by(long).title.length, 120);
  assert.ok(by(long).title.endsWith('…'));
  assert.equal('title' in by(none), false);
  assert.equal('title' in by(empty), false);
  assert.equal(by(explicit).title, 'Explicit title', 'the job record\'s own title is not replaced');
  assert.equal(by(big).title, 'Heading of a large brief');
  // The row opens the report when there is one, else the brief; a job with neither opens nothing.
  assert.equal(by(heading).path, join(f.hud, 'jobs', heading, 'brief.md'));
  assert.equal(by(reported).path, join(f.hud, 'jobs', reported, 'report.md'));
  assert.equal('path' in by(none), false);
  // An unchanged brief is not opened again; a changed one is.
  const cold = opened.filter((p) => p.endsWith('/brief.md')).length;
  assert.equal(cold, 7, 'every brief that titles a job was read once (not the one whose job.json has a title)');
  await collector.collect(true, { ...board, workers: [] }, NOW + 1);
  assert.equal(opened.filter((p) => p.endsWith('/brief.md')).length, cold, 'signature-cached: nothing re-read');
  fs.writeFileSync(join(f.hud, 'jobs', heading, 'brief.md'), '# Renamed later\n');
  fs.utimesSync(join(f.hud, 'jobs', heading, 'brief.md'), new Date(NOW + 9000), new Date(NOW + 9000));
  const changed = await collector.collect(true, { ...board, workers: [] }, NOW + 2);
  assert.equal(changed.active.find((a) => a.jobId === heading).title, 'Renamed later');
  assert.equal(opened.filter((p) => p.endsWith('/brief.md')).length, cold + 1, 'only the changed brief');
  // The workboard's description still wins over the brief.
  const described = await collector.collect(true, board, NOW + 3);
  assert.equal(described.active.find((a) => a.jobId === heading).title, 'Workboard description');
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

test('Home and Project derive ledger, commit, job, and cross-feature dependency states without tracker writes', async (t) => {
  const f = makeTemp(t);
  initRepo(f.cwd, [{ file: 'a', msg: 'deliver base/02; not OTHER-BASE-03', date: '2026-11-10T08:00:00Z' }]);
  const issue = (slug, n, blocked = 'none', state = 'ready-for-agent') => {
    const file = join(f.cwd, `.scratch/${slug}/issues/${n}-item.md`);
    f.put(file, `# ${n}: Item ${n}\n**Status:** ${state}\n**Blocked by:** ${blocked}\n`);
    return file;
  };
  const file = issue('base', '01');
  issue('base', '02'); issue('base', '03'); issue('next', '01', 'base/01, base/02');
  issue('next', '02', 'base/03'); issue('next', '03', '02'); issue('next', '04', 'absent/01');
  const receipt = (id, cwd, state) => {
    const dir = join(f.hud, `jobs/j${id.padStart(16, '0')}`);
    f.put(join(dir, 'job.json'), { cwd, role: 'imp', ticket: 'base/03', slice: 'BUILD-MODE', created_at: new Date(NOW + Number(id)).toISOString() });
    f.put(join(dir, 'STATUS.json'), { state });
    return dir;
  };
  const job = receipt('1', f.cwd, 'working'); receipt('2', f.root, 'failed');
  f.put(join(f.cwd, 'docs/spec.md'), '## 5. Milestones\n- **M1, old**\n- **M2, current**\n');
  f.put(join(f.cwd, 'STATE.md'), 'Milestone: M2\n## Waiting for the owner\n- Try it (waits on BASE-01, base/01)\n- Owner 2026-11-22: decided\n## Slices\n- try · STREAM · BASE-01 · delivered\n- accepted · M1/sub · OLD · shipped\n');
  const collector = new ProjectCollector(f.cwd, f.hud, f.env, f.home), get = mode => collector.collect(mode, EMPTY_BOARD, NOW);
  const states = (d, slug) => d.tickets.find(f => f.slug === slug).tickets.map(t => t.state);
  for (const mode of ['home', true]) {
    const d = await get(mode);
    assert.deepEqual(states(d, 'base'), ['try', 'try', 'working']);
    assert.deepEqual(states(d, 'next'), ['ready', 'queued', 'queued', 'blocked']);
    assert.deepEqual(d.ladder.ids, ['M1', 'M2']);
    assert.deepEqual(currentRows(d).rows.map(r => [r.id, r.milestone]), [['BASE-01', 'STREAM'], ['BUILD-MODE', 'base']]);
    assert.equal(d.waiting.length, 1);
  }
  const original = fs.readFileSync(file, 'utf8');
  appendTry(f.hud, f.cwd, 'flag', { milestone: 'STREAM', slices: [{ id: 'BASE-01', text: 'delivered' }] });
  assert.deepEqual((await get('home')).waiting.map(w => w.value), ['Try it (waits on BASE-01, base/01)']);
  assert.equal(new TryLog(f.hud).marks(f.cwd, [{ id: 'BASE-01', state: 'try', milestone: 'STREAM', text: 'delivered' }]).get('BASE-01'), 'flag');
  appendTry(f.hud, f.cwd, 'accept', { milestone: 'STREAM', slices: [{ id: 'BASE-01', text: 'delivered' }] });
  f.put(join(job, 'STATUS.json'), { state: 'waiting_orchestrator' });
  const accepted = await get('home');
  assert.equal(accepted.waiting.length, 0); assert.equal(accepted.counts.try, 0); assert.equal(accepted.counts.accepted, 2);
  assert.deepEqual(states(accepted, 'base'), ['done', 'try', 'blocked']);
  assert.deepEqual(states(accepted, 'next'), ['ready', 'blocked', 'blocked', 'blocked']);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('a managed worktree without a job starts a ticket; stale claims, unknown edges and cycles stall', async (t) => {
  const f = makeTemp(t);
  initRepo(f.cwd, [{ file: 'a', msg: 'baseline', date: '2026-11-10T08:00:00Z' }]);
  const dir = join(f.cwd, '.scratch/demo/issues');
  for (const [n, blocked, status] of [['01', 'none', 'ready-for-agent'], ['02', '03', 'ready-for-agent'],
    ['03', '02', 'ready-for-agent'], ['04', 'none', 'claimed']]) f.put(join(dir, `${n}-item.md`), `# ${n}: Item ${n}\n**Status:** ${status}\n**Blocked by:** ${blocked}`);
  fs.utimesSync(join(dir, '04-item.md'), new Date(NOW - 7200001), new Date(NOW - 7200001));
  const collector = new ProjectCollector(f.cwd, f.hud, f.env, f.home), tick = () => collector.collect('home', EMPTY_BOARD, NOW);
  const tree = join(f.root, 'separate');
  execFileSync('git', ['worktree', 'add', '-b', 'wt/DEMO-01', tree], { cwd: f.cwd, stdio: 'pipe' });
  const start = await tick();
  assert.deepEqual(start.tickets[0].tickets.map(t => t.state), ['working', 'blocked', 'blocked', 'blocked']);
  assert.deepEqual(start.ledger.map(r => [r.id, r.state]), [['DEMO-01', 'working']]);
  execFileSync('git', ['worktree', 'remove', tree], { cwd: f.cwd, stdio: 'pipe' });
  assert.equal((await tick()).tickets[0].tickets[0].state, 'ready');
});

test('subject cache follows the resolved SHA of a linked checkout (packed and loose refs)', async (t) => {
  const f = makeTemp(t), tree = join(f.root, 'linked');
  initRepo(f.cwd, [{ file: 'a', msg: 'OTHER-DEMO-01 and DEMO-010 are not DEMO/01a', date: '2026-11-10T08:00:00Z' }]);
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@invalid', ...args], { cwd, stdio: 'pipe' });
  git(f.cwd, 'worktree', 'add', '-b', 'side', tree); git(tree, 'pack-refs', '--all');
  f.put(join(tree, '.scratch/demo/issues/01-item.md'), '# 01: Item\n**Status:** ready-for-agent\n**Blocked by:** none\n');
  const collector = new ProjectCollector(tree, f.hud, f.env, f.home), calls = [], orig = childProcess.execFile;
  childProcess.execFile = (file, args, ...rest) => { calls.push(args); return orig(file, args, ...rest); }; syncBuiltinESMExports();
  t.after(() => { childProcess.execFile = orig; syncBuiltinESMExports(); });
  const tick = async () => (await collector.collect('home', EMPTY_BOARD, NOW)).tickets[0].tickets[0].state;
  assert.equal(await tick(), 'ready'); assert.equal(await tick(), 'ready'); assert.equal(calls.length, 1);
  git(tree, 'commit', '--allow-empty', '-m', 'deliver DEMO-01');
  assert.equal(await tick(), 'try'); assert.equal(await tick(), 'try'); assert.equal(calls.length, 2);
  git(tree, 'checkout', '--detach'); assert.equal(await tick(), 'try'); assert.equal(calls.length, 2);
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

test('Home shares the subject scan and project job facts; full working-tree probes retain their five-second gate', async (t) => {
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
  assert.deepEqual(spawned, ['git']);
  assert.ok(opened.every((p) => /\/STATE\.md$|\/issues\/01-item\.md$|\/\.git\/|\/jobs\/j\w+\/(job|STATUS)\.json$/.test(p)));
  assert.equal(homeSnap.ledger[0].commit, h1);
  assert.equal('at' in homeSnap.ledger[0], false);
  assert.deepEqual(homeSnap.active.map(a => a.jobId), ['j0000000000000001']);
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

test('multiple ProjectCollectors, ProjectOverviews and Control share one JobIndexCache parse per job on the same HUD_HOME', async (t) => {
  const f = makeTemp(t);
  t.after(() => clearJobIndexCaches());
  clearJobIndexCaches();
  const rootA = fs.realpathSync(f.cwd);
  const rootB = join(f.root, 'project-b');
  fs.mkdirSync(rootB, { recursive: true });
  const realB = fs.realpathSync(rootB);

  const addJob = (n, job, status) => {
    const id = `j${String(n).padStart(16, '0')}`;
    const dir = join(f.hud, 'jobs', id);
    f.put(join(dir, 'job.json'), { job: id, created_at: new Date(NOW - n * 60000).toISOString(), ...job });
    f.put(join(dir, 'STATUS.json'), status);
    return id;
  };
  const jAWork = addJob(1, { role: 'imp', cwd: rootA, title: 'Alpha work' }, { state: 'working', started_at: new Date(NOW - 5 * 60000).toISOString() });
  const jBAsk = addJob(2, { role: 'reviewer', cwd: realB, title: 'Beta question' }, { state: 'waiting_orchestrator', started_at: new Date(NOW - 2 * 60000).toISOString() });
  addJob(3, { role: 'imp', cwd: rootA }, { state: 'done', started_at: new Date(NOW - 10 * 60000).toISOString(), settled_at: new Date(NOW - 4 * 60000).toISOString() });
  addJob(4, { role: 'oracle', cwd: realB }, { state: 'failed', started_at: new Date(NOW - 8 * 60000).toISOString(), ended_at: new Date(NOW - 3 * 60000).toISOString() });
  addJob(5, { role: 'imp', cwd: rootA, reaped_at: new Date(NOW).toISOString() }, { state: 'working' });

  const opened = [];
  const origOpen = fs.openSync;
  fs.openSync = (path, ...args) => { opened.push(String(path)); return origOpen(path, ...args); };
  syncBuiltinESMExports();
  t.after(() => { fs.openSync = origOpen; syncBuiltinESMExports(); });
  const jobOpens = () => opened.filter((p) => /\/jobs\/j[0-9a-f]{16}\/(job|STATUS)\.json$/.test(p));

  const collectorA = new ProjectCollector(rootA, f.hud, f.env, f.home);
  const collectorB = new ProjectCollector(realB, f.hud, f.env, f.home);
  const overviews = new ProjectOverviews((r) => new ProjectCollector(r, f.hud, f.env, f.home), rootA);

  // First full Project collection reads each job.json and STATUS.json once (and shares with Control radar in the same tick).
  const projA = await collectorA.collect(true, EMPTY_BOARD, NOW);
  assert.deepEqual(projA.active.map((a) => a.jobId), [jAWork]);
  assert.equal(projA.radar.roleStats.imp.total, 3);
  assert.equal(projA.radar.roleStats.imp.ok, 1);
  assert.equal(projA.radar.roleStats.reviewer.total, 1);
  assert.equal(projA.radar.roleStats.oracle.failed, 1);
  const coldOpens = jobOpens();
  assert.equal(coldOpens.length, 10, `expected 5 job.json + 5 STATUS.json opens once, got: ${coldOpens.join(', ')}`);
  assert.equal(new Set(coldOpens).size, 10, 'no job file parsed twice across Project + Control radar');

  // Home, second ProjectCollector (ProjectVisits), Projects list (liveCwds) and Control all reuse the shared cache.
  opened.length = 0;
  const homeA = await collectorA.collect('home', EMPTY_BOARD, NOW + 1000);
  const projB = await collectorB.collect(true, EMPTY_BOARD, NOW + 1000);
  const list = await overviews.read([rootA, realB], EMPTY_BOARD, NOW + 1000);
  const ctrlA = await collectorA.collect('control', EMPTY_BOARD, NOW + 6000);
  const ctrlB = await collectorB.collect('control', EMPTY_BOARD, NOW + 12000);

  assert.deepEqual(jobOpens(), [], 'unchanged jobs are not re-opened across Home, Project, Projects, and Control');
  assert.deepEqual(homeA.active.map((a) => a.jobId), [jAWork]);
  assert.deepEqual(projB.active.map((a) => a.jobId), [jBAsk]);
  assert.equal(list.get(rootA).running, 1);
  assert.equal(list.get(realB).running, 1);
  assert.deepEqual(ctrlA.radar.roleStats, projA.radar.roleStats);
  assert.deepEqual(ctrlB.radar.roleStats, projA.radar.roleStats);

  // Updating one job's STATUS.json invalidates only that file across all readers.
  opened.length = 0;
  const statusFile = join(f.hud, 'jobs', jAWork, 'STATUS.json');
  f.put(statusFile, { state: 'done', started_at: new Date(NOW - 5 * 60000).toISOString(), settled_at: new Date(NOW - 1 * 60000).toISOString() });
  const updatedList = await overviews.read([rootA, realB], EMPTY_BOARD, NOW + 18000);
  const updatedHome = await collectorA.collect('home', EMPTY_BOARD, NOW + 18000);
  const updatedCtrl = await collectorA.collect('control', EMPTY_BOARD, NOW + 18000);
  assert.deepEqual(jobOpens(), [statusFile]);
  assert.equal(updatedList.get(rootA).running, 0);
  assert.equal(updatedList.get(realB).running, 1);
  assert.deepEqual(updatedHome.active, []);
  assert.equal(updatedCtrl.radar.roleStats.imp.ok, 2);
});

test('Progress, Home, HTML board and TryLog read landed slices from .scratch tickets while keeping STATE rows as history', async (t) => {
  const f = makeTemp(t);
  const git = (args, date) => execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@invalid', ...args], {
    cwd: f.cwd, stdio: 'pipe', encoding: 'utf8',
    env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  }).trim();
  git(['init', '-b', 'synthetic-main']);
  const t1 = '.scratch/orch-lean-2/issues/01-auto-done.md';
  const t2 = '.scratch/orch-lean-2/issues/02-needs-try.md';
  const t3 = '.scratch/orch-lean-2/issues/03-legacy-state.md';
  f.put(join(f.cwd, 'src/a.txt'), 'v1\n');
  f.put(join(f.cwd, t1), '# 01: Automated slice\n\n**Status:** done\n**Owner try:** no\n**Blocked by:** none\n- [x] covered by tests\n\n## Comments\n\n- Landed a1b2c3d4; gate 1/1 passed.\n');
  git(['add', '.']); git(['commit', '-m', 'land auto slice'], '2026-11-11T09:00:00Z');
  const h1 = git(['rev-parse', 'HEAD']);

  f.put(join(f.cwd, 'src/b.txt'), 'v2\n');
  f.put(join(f.cwd, t2), '# 02: Visible panel change\n\n**Status:** ready-for-human\n**Owner try:** yes\n**Blocked by:** 01\n- [x] panel works\n\n## Comments\n\n- Landed b2c3d4e5; gate 1/1 passed.\n');
  git(['add', '.']); git(['commit', '-m', 'land ui slice'], '2026-11-12T10:00:00Z');
  const h2 = git(['rev-parse', 'HEAD']);

  f.put(join(f.cwd, 'src/c.txt'), 'v3\n');
  git(['add', 'src/c.txt']); git(['commit', '-m', 'legacy state slice'], '2026-11-10T08:00:00Z');
  const h3 = git(['rev-parse', 'HEAD']);
  f.put(join(f.cwd, t3), `# 03: Legacy state slice\n\n**Status:** ready-for-human\n**Blocked by:** none\n- [x] done\n\n## Comments\n\n- Landed ${h3}; gate 1/1 passed.\n`);
  f.put(join(f.cwd, 'docs/handoff/STATE.md'), [
    '# State', 'Milestone: 0.2.0', '', '## Now: Shipping lean orchestration', '',
    '## Waiting for the owner', '- Verify UI change (waits on ORCH-LEAN-2-02)', '',
    '## Slices',
    `- try · ORCH-LEAN-2 · ORCH-LEAN2-03 · Legacy state slice (${h3.slice(0, 8)})`,
    `- accepted · M1 · LEGACY-OLD · Old milestone history (${h3.slice(0, 7)})`,
  ].join('\n'));
  f.put(join(f.cwd, 'docs/spec.md'), '## 5. Milestones\n- **M1, usable**\n- **0.2.0, current**\n');

  const collector = new ProjectCollector(f.cwd, f.hud, f.env, f.home);
  const full = await collector.collect(true, EMPTY_BOARD, NOW);
  // Existing STATE history kept; ORCH-LEAN2-03 deduplicated by commit against t3; t1 (owner_try: no -> done) is accepted, NOT to-try; t2 (ready-for-human) is to-try.
  assert.deepEqual(full.ledger.map((r) => [r.id, r.state, r.milestone]), [
    ['ORCH-LEAN2-03', 'try', 'ORCH-LEAN-2'],
    ['LEGACY-OLD', 'accepted', 'M1'],
    ['ORCH-LEAN-2-01', 'accepted', 'ORCH-LEAN-2'],
    ['ORCH-LEAN-2-02', 'try', 'ORCH-LEAN-2'],
  ]);
  const s1 = full.ledger.find((r) => r.id === 'ORCH-LEAN-2-01');
  const s2 = full.ledger.find((r) => r.id === 'ORCH-LEAN-2-02');
  assert.equal(s1.commit, h1);
  assert.equal(s1.at, Date.parse('2026-11-11T09:00:00Z'));
  assert.equal(s2.commit, h2);
  assert.equal(s2.at, Date.parse('2026-11-12T10:00:00Z'));
  assert.equal(s2.diff?.totalFiles, 2);
  assert.equal(s2.ticketPath, t2);
  assert.equal(full.counts.accepted, 2);
  assert.equal(full.counts.try, 2);
  assert.equal(full.slices.length, 0, 'landed ticket slices do not pollute in-flight Now slices');

  const home = await collector.collect('home', EMPTY_BOARD, NOW);
  const homeText = homeProgressRows(home, 80, 20, false).map((r) => stripAnsi(r.text)).join('\n');
  assert.match(homeText, /1\/3/);
  assert.match(homeText, /✓ 1 accepted.*◇ 2 to try/);
  const state = initialMonitorState();
  state.project.folded = new Set(['task:milestone:ORCH-LEAN-2']);
  const progress = pageRows('progress', full, state, 80, NOW, EMPTY_BOARD).map((r) => stripAnsi(r.text)).join('\n');
  assert.match(progress, /ORCH-LEAN-2-02/);
  assert.match(progress, /ORCH-LEAN-2-01/);
  const html = renderHtmlBoard({ projectName: 'Synthetic', root: f.cwd, project: full, workboard: EMPTY_BOARD, generatedAt: NOW, lang: 'en' });
  assert.match(html, /ORCH-LEAN-2-02/);
  assert.match(html, /panel works/, 'HTML board links ticket checklist from ticketPath');
  assert.doesNotMatch(html, /<article class="card try"><header><span class="id">ORCH-LEAN-2-01</);

  // An old flag still reaches TryLog readers, but no synthetic flag row is added to STATE Waiting.
  appendTry(f.hud, f.cwd, 'flag', { milestone: s2.milestone, slices: [{ id: s2.id, text: s2.text }] });
  const flagged = await collector.collect('home', EMPTY_BOARD, NOW + 1);
  assert.deepEqual(flagged.waiting.map(w => w.value), ['Verify UI change (waits on ORCH-LEAN-2-02)']);
  assert.deepEqual(new TryLog(f.hud).changes(f.cwd), [`try flagged project ${s2.id}`]);

  appendTry(f.hud, f.cwd, 'accept', { milestone: s2.milestone, slices: [{ id: s2.id, text: s2.text }] });
  const accepted = await collector.collect('home', EMPTY_BOARD, NOW + 2);
  assert.equal(accepted.ledger.find((r) => r.id === 'ORCH-LEAN-2-02').state, 'accepted');
  assert.equal(accepted.tickets[0].tickets.find((tk) => tk.number === '02').state, 'done');
  assert.equal(accepted.waiting.length, 0, 'accepting ticket-derived try slice settles waits-on item');
  assert.deepEqual(new TryLog(f.hud).changes(f.cwd), [`try accepted project ${s2.milestone}: ${s2.id}`]);

  // Projects list overview derives pending counts from tickets even with no STATE.md at all.
  fs.unlinkSync(join(f.cwd, 'docs/handoff/STATE.md'));
  const overviews = new ProjectOverviews((r) => new ProjectCollector(r, f.hud, f.env, f.home), f.cwd);
  const overview = (await overviews.read([f.cwd], EMPTY_BOARD, NOW + 3)).get(f.cwd);
  assert.equal(overview.hasState, true);
  assert.equal(overview.counts.try, 2);
});
