import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withState } from '../fixtures/state-helpers.mjs';
import { PanelJobPipeline } from '../../dist/tree-page.js';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { initialMonitorState, renderMonitor, handleMonitorInput } from '../../dist/render/monitor.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';
import { SmallModel } from '../../dist/collectors/small-model.js';
import { JobSentences } from '../../dist/collectors/job-sentences.js';
import { DecisionTitles } from '../../dist/collectors/decision-titles.js';
import { DecisionLabels } from '../../dist/collectors/decision-labels.js';

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
  const pipeline = new PanelJobPipeline(home, scope, OPEN);
  t.after(() => { pipeline.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  const collect = async () => { await pipeline.refresh(); return pipeline.workboard(tree); };
  const draw = (board, nowMs = OPEN + MIN, state = initialMonitorState()) =>
    renderMonitor({ tree, workboard: board, state, width: 100, height: 100, nowMs });
  return { home, put, job, collect, draw };
}

test('retained settlements include legacy and receipt-only dispatch failures', async (t) => {
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
  assert.equal(board.workers.length, 4);
  assert.equal(board.decisions.length, 4);
  assert.equal(board.workers.find((w) => w.id === 'thin-job:' + active.id).settledAt, null);
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
