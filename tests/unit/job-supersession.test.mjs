import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, waitFixtureJob, paneList, ownerOf } from '../helpers/thin-mcp-harness.mjs';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { renderMonitor, initialMonitorState } from '../../dist/render/monitor.js';
import { laneTop } from '../../dist/render/split-home.js';
import { workerPriority } from '../../dist/render/work-lanes.js';
import { currentWorker, foldedWorker } from '../../dist/render/work-visibility.js';
import { stripAnsi } from '../../dist/render/colors.js';

async function setup(t) {
  const f = await fixture(t), pane = 'w4E:p1', home = f.env.HUD_HOME;
  const seed = (n, state, facts = {}, title = '', owner = pane) => {
    const j = waitFixtureJob(f, n, state, owner);
    fs.writeFileSync(join(j.dir, 'job.json'), JSON.stringify({ ...j.receipt, ...facts }));
    fs.writeFileSync(join(j.dir, 'brief.md'), title);
    return j;
  };
  const lanes = () => readThinJobs(home, { project: f.root, pane });
  const workers = () => Object.fromEntries(lanes().flatMap((l) => l.workers.map((w) => [w.id.slice(9), w])));
  const compact = async () => (await f.call('hud_read', {})).jobs.map((j) => j.job);
  return { f, home, seed, lanes, workers, compact };
}

test('linked attempts retire failures immediately; show-all keeps muted history, not the lane headline', async (t) => {
  const { f, seed, lanes, compact } = await setup(t);
  for (const [i, link] of ['retry_of', 'repair_of', 'from_jobs'].entries()) {
    const old = seed(2 * i + 1, 'failed', { package: `old-${i}` }), next = seed(2 * i + 2, 'done', {
      package: `old-${i}`, role: 'reviewer', [link]: link === 'from_jobs' ? [old.job] : old.job,
    });
    const lane = lanes().find((l) => l.label === `old-${i}`);
    assert.equal(lane.workers.find((w) => w.id.endsWith(old.job)).superseded, true);
    assert.ok(laneTop(lane, Date.now()).id.endsWith(next.job));
  }
  assert.deepEqual(await compact(), []);
  const list = lanes(), nowMs = Date.now(), state = initialMonitorState();
  const draw = () => renderMonitor({ tree: { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date() },
    workboard: { lanes: list, workers: list.flatMap((l) => l.workers), decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: null } },
    state, width: 100, height: 60, nowMs });
  assert.equal(draw().workboard.snapshot.workers.length, 3);
  state.home.showAll = true;
  assert.match(draw().lines.map(stripAnsi).join('\n'), /superseded/);
  assert.equal(draw().workboard.snapshot.workers.length, 6);
  assert.equal((await f.call('hud_read', { view: 'recent' })).jobs.length, 6);
});

test('newer same-role target wins across spellings and panes; adjacent tickets and other roles/projects do not', async (t) => {
  const { f, seed, workers, compact } = await setup(t);
  const first = seed(1, 'failed', {}, '# Slice SYNTHETIC-WORK-01: build'), other = seed(2, 'failed', { package: 'synthetic-work', ticket: '02' });
  seed(3, 'done', { package: 'synthetic-work', ticket: '01', role: 'reviewer' });
  seed(4, 'done', { package: 'synthetic-work', ticket: '01', project_root: join(f.root, 'elsewhere') });
  assert.equal(workers()[first.job].superseded, false);
  const latest = seed(5, 'failed', { ticket: 'synthetic-work/01' }, '', 'w4E:p2');
  assert.equal(workers()[first.job].superseded, true);
  assert.equal(workers()[other.job].superseded, false);
  assert.deepEqual(await compact(), [latest.job, other.job]);
  const orphan = seed(6, 'stopped', { slice: 'NEW-03' }, '', 'w4E:p8');
  seed(7, 'working', { slice: 'NEW-03' });
  paneList(f, 'w4E:p1', 'w4E:p2');
  assert.ok(!(await compact()).includes(orphan.job));
  assert.equal(ownerOf(orphan), 'w4E:p8', 'superseded orphan is not adopted');
});

test('landed STATE slice, ticket or project-specific accepted trial supersedes without a retry', async (t) => {
  const { f, home, seed, workers, compact } = await setup(t);
  const jobs = [1,2,3,4].map((i) => seed(i, 'failed', { package: 'synthetic', ticket: i }));
  assert.equal((await compact()).length, 4);
  fs.writeFileSync(join(f.root, 'STATE.md'), '## Slices\n\n- try · M1 · SYNTHETIC-01 · Ready to try.\n');
  const issues = join(f.root, '.scratch/synthetic/issues'); fs.mkdirSync(issues, { recursive: true });
  fs.writeFileSync(join(issues, '02-example.md'), '# 02: Example\n\n**Status:** resolved\n');
  fs.writeFileSync(join(home, 'tries.jsonl'), JSON.stringify({ root: f.root, action: 'accept', milestone: 'M1', slices: ['SYNTHETIC-03'] }) + '\n');
  assert.deepEqual(jobs.map(({ job }) => workers()[job].superseded), [true, true, true, false]);
  assert.deepEqual(await compact(), [jobs[3].job]);
});

test('unhandled failure expires only on Home; observing it demotes and folds the card', async (t) => {
  const { f, seed, workers, compact } = await setup(t), { job, dir } = seed(1, 'failed');
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'failed', settled_at: new Date(Date.now() - 31 * 60000) }));
  let w = workers()[job];
  assert.equal(workerPriority(w, w.settledAt), 2);
  assert.ok(currentWorker(w, w.settledAt + 30*60000 - 1));
  assert.ok(!currentWorker(w, w.settledAt + 30*60000));
  assert.ok(!currentWorker(w, Date.now()));
  assert.deepEqual(await compact(), [job]);
  await f.call('hud_read', { job });
  w = workers()[job];
  assert.equal(w.failureObserved, true);
  assert.ok(workerPriority(w, w.settledAt) > 4);
  assert.ok(foldedWorker(w, w.settledAt + 5*60000));
  assert.ok(!currentWorker(w, w.settledAt + 15*60000));
  assert.deepEqual(await compact(), []);
});
