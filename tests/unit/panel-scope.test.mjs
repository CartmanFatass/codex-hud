import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PanelJobPipeline } from '../../dist-test/src/tree-page.js';
import { readThinJobs } from '../../dist-test/src/collectors/thin-jobs.js';
import { initialMonitorState, renderMonitor, handleMonitorInput } from '../../dist-test/src/render/monitor.js';
import { targetKey } from '../../dist-test/src/collectors/workboard-types.js';
import { SmallModel } from '../../dist-test/src/collectors/small-model.js';
import { JobSentences } from '../../dist-test/src/collectors/job-sentences.js';
import { DecisionTitles } from '../../dist-test/src/collectors/decision-titles.js';
import { DecisionLabels } from '../../dist-test/src/collectors/decision-labels.js';
import { HomeRecommendation } from '../../dist-test/src/collectors/home-recommendation.js';

const OPEN = Date.parse('2030-01-15T12:00:00Z'), MIN = 60000;
const scope = { project: null, pane: 'w4E:p1' };
const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(OPEN) };
const pause = () => new Promise((r) => setTimeout(r, 5));
function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'panel-scope-'));
  const put = (dir, file, value) => {
    const path = join(dir, file);
    fs.mkdirSync(join(path, '..'), { recursive: true });
    fs.writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    fs.utimesSync(path, OPEN / 1000, OPEN / 1000);
  };
  const job = (n, state, settled = OPEN - 1) => {
    const id = 'j' + n.toString(16).padStart(16, '0'), dir = join(home, 'jobs', id);
    put(dir, 'job.json', { job: id, role: 'imp', herdr_pane: scope.pane, created_at: new Date(OPEN - 30 * 86400000).toISOString() });
    put(dir, 'STATUS.json', { state, settled_at: new Date(settled).toISOString(), ended_at: new Date(OPEN + MIN).toISOString() });
    put(dir, 'brief.md', '# Synthetic scope job ' + n);
    put(dir, 'report.md', 'Synthetic result.');
    put(dir, 'review-1.md', 'Verdict: accept\n- Synthetic check.');
    put(dir, 'qa/q1.md', '# Question\n\nKeep the synthetic layout?\n\nDefault if unanswered: yes');
    put(dir, 'qa/q1.answer.md', 'yes');
    put(dir, 'sessions/session.jsonl', '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Synthetic progress"}]}}\n');
    return { id, dir };
  };
  const pipeline = new PanelJobPipeline(home, null, { live: false }, null, scope, OPEN);
  t.after(() => { pipeline.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  const collect = async () => { await pipeline.refresh(); return pipeline.workboard(tree); };
  const draw = (board, nowMs = OPEN + MIN, state = initialMonitorState()) =>
    renderMonitor({ tree, workboard: board, state, width: 100, height: 100, nowMs });
  return { home, put, job, collect, draw };
}

for (const state of ['done', 'closed', 'idle_grace', 'failed', 'stopped']) test(`${state} settled before open: not loaded, even with a later process exit or show-all`, async (t) => {
  const f = fixture(t); f.job(1, state);
  const board = await f.collect(), first = f.draw(board);
  const all = handleMonitorInput(first.state, { type: 'key', key: 'show-all' }, { tree, frame: first }).state;
  assert.deepEqual({ workers: board.workers, decisions: board.decisions, lanes: board.lanes }, { workers: [], decisions: [], lanes: [] });
  assert.equal(f.draw(board, OPEN + MIN, all).workboard.snapshot.workers.length, 0);
  assert.equal(f.draw(board, OPEN + MIN, all).workboard.snapshot.decisions.length, 0);
});

test('legacy settlement fallbacks, including receipt-only dispatch failure, obey the opening boundary', async (t) => {
  const f = fixture(t);
  const ended = f.job(1, 'closed'), unstamped = f.job(2, 'failed'), failed = f.job(3, 'failed'), active = f.job(4, 'working');
  f.put(ended.dir, 'STATUS.json', { state: 'closed', ended_at: new Date(OPEN - 1).toISOString() });
  f.put(unstamped.dir, 'STATUS.json', { state: 'failed' });
  fs.utimesSync(join(unstamped.dir, 'STATUS.json'), (OPEN - 1) / 1000, (OPEN - 1) / 1000);
  fs.rmSync(join(failed.dir, 'STATUS.json'));
  f.put(failed.dir, 'job.json', { job: failed.id, role: 'imp', herdr_pane: scope.pane, created_at: '2029-01-01', dispatch_exit_code: 1 });
  fs.utimesSync(join(failed.dir, 'job.json'), (OPEN - 1) / 1000, (OPEN - 1) / 1000);
  fs.rmSync(join(active.dir, 'STATUS.json'));
  const board = await f.collect();
  assert.deepEqual(board.workers.map((w) => w.id), ['thin-job:' + active.id]);
  assert.equal(board.decisions.length, 1, 'only the active job contributes its decision');
});

test('excluded jobs cost zero artifact reads and zero requests with every model feature enabled', async (t) => {
  const f = fixture(t); const { dir } = f.job(1, 'done');
  const calls = { chat: 0, labels: 0, ranking: 0 };
  const env = { HOME: f.home, HUD_HOME: f.home, MISTRAL_API_KEY: 'synthetic', OPENAI_API_KEY: 'synthetic' };
  const fetcher = (kind) => async () => { calls[kind]++; return new Response('{}', { status: 400 }); };
  const cache = join(f.home, 'display/model-cache');
  const model = new SmallModel({ dir: cache, env, fetch: fetcher('chat'), clock: () => OPEN + MIN });
  model.configure({ backend: 'api', hourlyCap: 60 });
  const sentences = new JobSentences(model, join(cache, 'sentences.json'), () => {}, () => OPEN + MIN);
  const titles = new DecisionTitles(model, join(cache, 'titles.json'));
  const labels = new DecisionLabels(cache, () => {}, env, fetcher('labels'), () => OPEN + MIN);
  const ranking = new HomeRecommendation(cache, model, () => {}, env, fetcher('ranking'), () => OPEN + MIN);
  sentences.configure(true, 'en'); titles.configure(true, 'en'); labels.configure(true, 0); ranking.configure(true, 'en', 0, 'openai');
  t.after(async () => { sentences.stop(); titles.stop(); labels.stop(); ranking.stop(); model.cancelAll(); await pause(); });
  let reads = 0;
  const originals = { openSync: fs.openSync, readFileSync: fs.readFileSync };
  for (const method of Object.keys(originals)) fs[method] = (file, ...args) => {
    if (String(file).startsWith(dir + '/') && !String(file).endsWith('/STATUS.json') && !String(file).endsWith('/job.json')) reads++;
    return originals[method](file, ...args);
  };
  syncBuiltinESMExports();
  try {
    const board = await f.collect();
    for (let i = 0; i < 20; i++) {
      sentences.update(board, f.home, tree); titles.update(board, f.home); labels.update(board, f.home, tree); ranking.update(board);
      await pause();
    }
    assert.deepEqual({ reads, ...calls }, { reads: 0, chat: 0, labels: 0, ranking: 0 });
    // Positive control: the same real collectors/services do read/request for an admitted settlement.
    f.put(dir, 'STATUS.json', { state: 'done', settled_at: new Date(OPEN).toISOString() });
    const admitted = await f.collect();
    for (let i = 0; i < 20; i++) {
      sentences.update(admitted, f.home, tree); titles.update(admitted, f.home); labels.update(admitted, f.home, tree); ranking.update(admitted);
      await pause();
    }
    assert.ok(reads > 0); assert.ok(calls.chat >= 3, 'sentence, title and Home brief use the real SmallModel');
    assert.ok(calls.labels > 0); assert.ok(calls.ranking > 0);
  } finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
});

test('settlement at/after open shows, folds at five minutes, hides at fifteen, and a reveals it', async (t) => {
  const f = fixture(t);
  f.job(1, 'done', OPEN); f.job(2, 'done', OPEN + MIN);
  const board = await f.collect();
  assert.equal(board.workers.length, 2);
  const worker = board.workers.find((w) => w.id.endsWith('2'));
  const key = targetKey({ kind: 'worker', laneId: worker.laneId, workerId: worker.id });
  const rows = (frame) => frame.workboard.rows.filter((r) => r.item === key);
  assert.ok(rows(f.draw(board, worker.settledAt + 5 * MIN - 1)).length > 1);
  assert.equal(rows(f.draw(board, worker.settledAt + 5 * MIN)).length, 1);
  const hidden = f.draw(board, worker.settledAt + 15 * MIN);
  assert.equal(hidden.workboard.snapshot.workers.length, 0);
  const all = handleMonitorInput(hidden.state, { type: 'key', key: 'show-all' }, { tree, frame: hidden }).state;
  assert.equal(rows(f.draw(board, worker.settledAt + 15 * MIN, all)).length, 1);
  assert.equal((await f.collect()).workers.length, 2, 'later refreshes retain the original opening boundary');
});

test('old running, waiting, asking, launching and unknown jobs always show despite stale settlement facts', async (t) => {
  const f = fixture(t);
  const states = ['working', 'waiting_helper', 'waiting_answer', 'asking', 'launching', 'unknown'];
  states.forEach((state, n) => f.job(n, state));
  const board = await f.collect();
  assert.equal(board.workers.length, states.length);
  assert.ok(board.workers.every((w) => w.state === 'working' && w.settledAt === null));
});

test('panel filtering leaves the bars existing process-end cutoff unchanged', (t) => {
  const f = fixture(t); f.job(1, 'closed');
  assert.equal(readThinJobs(f.home, scope, JSON.parse, { settledBefore: OPEN }).flatMap((l) => l.workers).length, 1);
  assert.equal(readThinJobs(f.home, scope, JSON.parse, { openedAt: OPEN }).flatMap((l) => l.workers).length, 0);
});
