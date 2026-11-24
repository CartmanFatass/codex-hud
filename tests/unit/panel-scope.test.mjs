import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PanelJobPipeline } from '../../dist/tree-page.js';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { workState } from '../../dist/collectors/work-job.js';

const OPEN = Date.parse('2030-01-15T12:00:00Z'), MIN = 60000;
const scope = { project: null, pane: 'w4E:p1' };
const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(OPEN) };
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
  return { home, put, job, collect };
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

test('closing an idle job keeps its observed settlement time', (t) => {
  const f = fixture(t), settled = OPEN - 30 * MIN, { dir } = f.job(1, 'idle_grace', settled);
  const read = () => readThinJobs(f.home, scope)[0].workers[0].settledAt;
  assert.equal(read(), settled);
  f.put(dir, 'STATUS.json', { state: 'closed', settled_at: new Date(settled).toISOString(), ended_at: new Date(OPEN).toISOString() });
  assert.equal(read(), settled);
});

test('linked sessions use target mtime without reading bodies and survive job deletion', (t) => {
  const f = fixture(t), { id, dir } = f.job(1, 'working');
  const sessions = join(dir, 'sessions'), storage = join(f.home, 'native-history');
  const now = Date.now(), old = now - 22 * MIN, fresh = now - 14_000;
  f.put(dir, 'job.json', { job: id, role: 'imp', herdr_pane: scope.pane, created_at: new Date(old).toISOString() });
  for (const path of ['STATUS.json', 'report.md', 'review-1.md']) fs.utimesSync(join(dir, path), old / 1000, old / 1000);
  fs.unlinkSync(join(sessions, 'session.jsonl'));
  f.put(storage, 'old.jsonl', 'Older synthetic history');
  f.put(storage, 'fresh.jsonl', 'Newer synthetic history');
  const target = join(storage, 'fresh.jsonl');
  fs.utimesSync(join(storage, 'old.jsonl'), old / 1000, old / 1000);
  fs.utimesSync(target, fresh / 1000, fresh / 1000);
  fs.symlinkSync(target, join(sessions, 'fresh.jsonl'));
  fs.symlinkSync(join(storage, 'old.jsonl'), join(sessions, 'old.jsonl'));
  fs.symlinkSync(join(storage, 'missing.jsonl'), join(sessions, 'dangling.jsonl'));
  fs.symlinkSync(storage, join(sessions, 'directory.jsonl'));
  const read = () => readThinJobs(f.home, scope)[0].workers[0];
  const working = read();
  assert.deepEqual(working.sessionFile, { path: target, at: fresh });
  assert.equal(workState(working, now), 'in-progress');
  const open = t.mock.method(fs, 'openSync'); syncBuiltinESMExports();
  t.after(() => { open.mock.restore(); syncBuiltinESMExports(); });
  fs.utimesSync(target, old / 1000, old / 1000);
  assert.equal(workState(read(), now), 'stalled');
  assert.ok(!open.mock.calls.some(({ arguments: [path] }) => String(path).endsWith('.jsonl')), 'stall age reads no transcript body');
  fs.rmSync(dir, { recursive: true });
  assert.equal(fs.readFileSync(target, 'utf8'), 'Newer synthetic history');
});
