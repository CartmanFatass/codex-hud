/** home-compact/06: Home's top line counts the workers each role has started since the panel opened, in memory only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PanelJobPipeline } from '../../dist/tree-page.js';
import { WorkerCounts } from '../../dist/panel/worker-counts.js';
import { jobFrame, COUNTS } from '../fixtures/home-jobs.mjs';

const OPEN = Date.parse('2026-11-22T12:00:00Z'), MIN = 60_000;
const worker = (id, role, o = {}) => ({ id, role, startedAt: OPEN + MIN, settledAt: null, state: 'working', ...o });

test('every worker counts under its role whatever its state; a sonic child is sonic; a worker counts once', () => {
  const counts = new WorkerCounts(OPEN);
  const workers = [
    worker('a', 'imp'), worker('b', 'imp', { state: 'done', settledAt: OPEN + 2 * MIN }), worker('c', 'imp', { state: 'failed', settledAt: OPEN + 2 * MIN }),
    worker('d', 'frontend-imp'), worker('e', 'oracle'), worker('f', 'Reviewer'), worker('g', 'custom-role'),
    worker('h', 'sonic', { parentJobId: 'a' }), worker('i', 'imp', { parentJobId: 'a' }),
  ];
  counts.observe(workers);
  counts.observe(workers.slice(0, 4));
  assert.deepEqual(Object.fromEntries(counts.counts()), { imp: 3, 'frontend-imp': 1, oracle: 1, reviewer: 1, other: 1, sonic: 2 });
});

test('a worker that started before the panel opened, a queued one and a native agent are not counted; a queued one counts once it starts', () => {
  const counts = new WorkerCounts(OPEN);
  counts.observe([worker('old', 'imp', { startedAt: OPEN - 1 }), worker('queued', 'general', { startedAt: null, state: 'queued' }), worker('native', null)]);
  assert.equal(counts.counts().size, 0);
  counts.observe([worker('queued', 'general')]);
  assert.deepEqual(Object.fromEntries(counts.counts()), { general: 1 });
});

test('a finished worker stays counted after the board drops it; a restarted panel starts from zero', () => {
  const panel = new WorkerCounts(OPEN);
  panel.observe([worker('a', 'imp'), worker('b', 'sonic', { parentJobId: 'a' })]);
  panel.observe([]);
  assert.deepEqual(Object.fromEntries(panel.counts()), { imp: 1, sonic: 1 });
  assert.equal(new WorkerCounts(OPEN + 5 * MIN).counts().size, 0, 'the next panel knows nothing of them');
});

test('the panel’s job pipeline feeds the counts from each board it composes and a second pipeline starts empty', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'worker-counts-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const scope = { project: null, pane: 'w4E:p1' }, tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date() };
  const now = Date.now();
  const put = (n, role, state) => {
    const id = 'j' + n.toString(16).padStart(16, '0'), dir = join(home, 'jobs', id);
    fs.mkdirSync(join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job: id, role, herdr_pane: scope.pane, created_at: new Date(now).toISOString() }));
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state, ...(state === 'working' ? {} : { settled_at: new Date(now).toISOString() }) }));
    fs.writeFileSync(join(dir, 'brief.md'), `# Synthetic counted job ${n}`);
    fs.writeFileSync(join(dir, 'sessions/session.jsonl'), '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Synthetic progress"}]}}\n');
  };
  const panel = new PanelJobPipeline(home, scope, now - MIN);
  t.after(() => panel.dispose());
  assert.equal(panel.workerCounts.counts().size, 0, 'nothing before the first board');
  put(1, 'imp', 'working'); put(2, 'imp', 'done'); put(3, 'oracle', 'working');
  await panel.refresh();
  panel.workboard(tree);
  assert.deepEqual(Object.fromEntries(panel.workerCounts.counts()), { imp: 2, oracle: 1 });
  const restarted = new PanelJobPipeline(home, scope, now - MIN);
  t.after(() => restarted.dispose());
  assert.equal(restarted.workerCounts.counts().size, 0);
});

test('Home’s top line ends with the counts in the role order, an icon in each role’s own icon set; the left side gives way before they go; none without counts', () => {
  const top = (width, lang, icons, counts = COUNTS) => jobFrame(width, lang, undefined, undefined, icons, counts)[0];
  assert.match(top(80, 'en', 'nerd'), /^\uF059 1 waiting for you · \uF0571 +\uF0AD 5 {2}\uF1FC 2 {2}\uF0E7 7$/);
  assert.match(top(80, 'en', 'unicode'), /^\? 1 waiting for you · ✗1 +⚒ 5 {2}✎ 2 {2}⚡ 7$/);
  assert.match(top(80, 'zh', 'text'), /^\? 1 项等你处理 · x1 +I 5 {2}F 2 {2}\* 7$/);
  assert.match(top(36, 'en', 'nerd'), /^\uF059 1 waiting · \uF0571 +\uF0AD 5 {2}\uF1FC 2 {2}\uF0E7 7$/, 'the left side takes a shorter form');
  assert.match(top(20, 'en', 'nerd'), /^\uF0591 \uF0571 +\uF0AD 5 {2}\uF1FC 2 {2}\uF0E7 7$/, 'the shortest');
  assert.match(top(14, 'en', 'nerd'), /^\uF0591 \uF0571 *$/, 'no room: the left side alone');
  assert.match(top(80, 'en', 'nerd', null), /^\uF059 1 waiting for you · \uF0571 *$/, 'no counts, no right side');
});
