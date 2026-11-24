import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { main } from '../../dist/cli/hud-main.js';
import { collectJobStats, groupJobStats, localDayStart } from '../../dist/collectors/job-stats.js';
import { readJobUsage, recordJobUsage } from '../../dist/roles/job-usage.js';

const id = n => `j${n.toString(16).padStart(16, '0')}`;
const status = { state: 'closed', settled_at: '2026-11-23T10:10:00Z' };
function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-job-stats-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const put = (name, rows) => {
    const path = join(home, name);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
    return path;
  };
  return { home, put };
}

test('pi totals use native entries and copied-session timestamps; unpriced entries do not become free', t => {
  const { home, put } = fixture(t);
  const msg = (timestamp, input, cost) => ({ type: 'message', timestamp, message: { role: 'assistant',
    usage: { input, cacheRead: 2, cacheWrite: 0, output: 3, cost } } });
  const path = put('session.jsonl', [{ type: 'session' }, msg('2026-11-22T12:00:00Z', 999, { total: 20 }),
    msg('2026-11-23T10:03:00Z', 5, { total: 0 }), msg('2026-11-23T10:04:00Z', 7, { total: 0.25 }),
    { type: 'compaction', timestamp: '2026-11-23T10:05:00Z', usage: { input: 2, cacheRead: 0, cacheWrite: 5, output: 10, cost: { total: 0.1 } } }]);
  const current = { ...status, session_file: path };
  recordJobUsage(home, { retry_of: id(1), created_at: '2026-11-23T10:00:00Z' }, current);
  assert.deepEqual(readJobUsage(home, current), { input: 14, output: 16, cache_read: 4, cache_write: 5 });
  const large = put('large.jsonl', [{ type: 'session' }, JSON.stringify({ content: 'x'.repeat(2 * 1024 * 1024) }),
    msg('2026-11-23T10:04:00Z', 7, { total: 0.25 })]);
  const later = { ...current, settled_at: '2026-11-23T10:12:00Z', session_file: large };
  recordJobUsage(home, {}, later);
  assert.equal(readJobUsage(home, later), undefined, 'a tail of a per-request transcript is not a job total');
});

test('CLI results can be read after oversized output and summed across contiguous headless turns', t => {
  const { home, put } = fixture(t), job = { headless: true, cli: { agent: 'claude' } };
  const result = (input_tokens, total_cost_usd) => ({ type: 'result', usage: { input_tokens, output_tokens: 2 }, total_cost_usd });
  const first = { ...status, stdout_start: 0 };
  const path = put('stdout.jsonl', [{ type: 'assistant', text: 'x'.repeat(2 * 1024 * 1024) }, result(11, 0.125)]);
  recordJobUsage(home, job, first);
  assert.deepEqual(readJobUsage(home, first), { input: 11, output: 2, cost_usd: 0.125 });
  const next = { ...first, settled_at: '2026-11-23T11:00:00Z', stdout_start: fs.statSync(path).size };
  fs.appendFileSync(path, JSON.stringify(result(5, 0)) + '\n');
  recordJobUsage(home, job, next);
  assert.deepEqual(readJobUsage(home, next), { input: 16, output: 4, cost_usd: 0.125 });
  const paused = { state: 'waiting_orchestrator', started_at: '2026-11-23T12:00:00Z', stdout_start: fs.statSync(path).size };
  fs.appendFileSync(path, '{"type":"assistant"}\n');
  recordJobUsage(home, job, paused);
  const resumed = { ...first, settled_at: '2026-11-23T12:01:00Z', stdout_start: fs.statSync(path).size };
  fs.appendFileSync(path, JSON.stringify(result(3, 0.1)) + '\n');
  recordJobUsage(home, job, resumed);
  assert.equal(readJobUsage(home, resumed), undefined, 'cannot count the result-less turn as zero');
});

test('usage-less agy result stays unknown and Codex uses a native cumulative tail without cache double-counting', t => {
  const { home, put } = fixture(t);
  const agy = { headless: true, cli: { agent: 'agy' } };
  put('stdout.jsonl', [{ event: 'init' }, { event: 'result', result: { response: 'synthetic' } }]);
  recordJobUsage(home, agy, status);
  assert.equal(readJobUsage(home, status), undefined);
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; });
  const brain = '.gemini/antigravity-cli/brain';
  put(`${brain}/synthetic-session/.system_generated/logs/transcript_full.jsonl`, [
    { type: 'PLANNER_RESPONSE', input_tokens: 7, cache_read_tokens: 2, output_tokens: 3 },
    { type: 'PLANNER_RESPONSE', input_tokens: 2, cache_read_tokens: 0, output_tokens: 1 },
  ]);
  const nativeAgy = { ...status, settled_at: '2026-11-23T12:00:00Z', agent_session_id: 'synthetic-session' };
  recordJobUsage(home, agy, nativeAgy);
  assert.deepEqual(readJobUsage(home, nativeAgy), { input: 9, cache_read: 2, output: 4 });
  const date = new Date(), y = String(date.getFullYear()), m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0'), session = '01234567-0123-0123-0123-0123456789ab';
  const old = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; });
  put(`sessions/${y}/${m}/${d}/rollout-${y}-${m}-${d}T22-00-00-${session}.jsonl`, [
    { type: 'session_meta', payload: { id: session } }, { type: 'response_item', text: 'x'.repeat(2 * 1024 * 1024) },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 30, cached_input_tokens: 20, output_tokens: 4 } } } },
  ]);
  const codex = { ...status, settled_at: '2026-11-23T12:01:00Z', agent_session_id: session };
  recordJobUsage(home, { cli: { agent: 'codex' } }, codex);
  assert.deepEqual(readJobUsage(home, codex), { input: 10, cache_read: 20, output: 4 });
});

test('stats and day merge v1 archives, live jobs and flows; keep missing telemetry unknown', async t => {
  const { home, put } = fixture(t);
  const now = Date.parse('2026-11-23T12:00:00Z'), since = localDayStart(now), project = '/synthetic/project';
  const created_at = '2026-11-23T10:00:00Z', sha = 'a'.repeat(40);
  const base = { v: 1, archived_at: '2026-11-23T11:00:00Z', project, created_at, ...status };
  put('archive/2026-11.jsonl', [
    { ...base, job: id(1), role: 'imp', model: 'pi-model', ticket: 'sample/03', objective: { id: 'deliver', title: 'Synthetic outcome' }, summary: 'Synthetic improvement.', question_count: 2,
      route: { tier: 'standard', mode: 'tab' }, usage: { input: 12, cache_read: 0, cost_usd: 0.125 },
      land: { attempts: 1, reruns: 0, repairs: 0, state: 'failed' } },
    { ...base, job: id(2), role: 'old', state: 'failed' }, { ...base, job: id(3), role: 'stale' },
    { ...base, job: id(4), role: 'imp', project: '/synthetic/other', ticket: 'another/01',
      land: { attempts: 1, reruns: 0, repairs: 0, state: 'completed', sha, landed_at: created_at } },
    { ...base, job: id(5), role: 'sonic', parent_job: id(1) }, '{broken',
  ]);
  put(`jobs/${id(3)}/job.json`, [{ job: id(3), role: 'imp', project_root: project, created_at, headless: true }]);
  put(`jobs/${id(3)}/STATUS.json`, [{ state: 'working' }]);
  put(`flows/f${id(1).slice(1)}.json`, [{ job: id(1), wt: { main_root: project }, updated_at: created_at, state: 'failed',
    repairs: [{ outcome: 'failed' }], reruns: [{ rerun_ok: false, tests: ['not flaky'] }] }]);
  put(`flows/f${id(1).slice(1)}-2.json`, [{ job: id(1), wt: { main_root: project }, updated_at: status.settled_at,
    state: 'completed', landed_sha: sha, reruns: [{ rerun_ok: true, tests: ['synthetic.test.mjs > recovers'] }] }]);
  const s = collectJobStats(home, since, now, project), role = groupJobStats(s, 'role')[0];
  assert.deepEqual(s.coverage, { live: 1, archive: 3, flows: 2, skipped: 1, limited: false });
  assert.equal(role.jobs, 2);
  assert.equal(role.median, 10);
  assert.deepEqual(role.usage.cost_usd, { known: 1, total: 0.125 });
  assert.deepEqual(role.questions, { known: 2, total: 2 });
  assert.equal(role.sonic, 1);
  assert.deepEqual(role.land, { observed: 1, landed: 1, repaired: 1 });
  assert.deepEqual(s.flaky, [['synthetic.test.mjs > recovers', 1]]);
  assert.equal(s.landed[0].job.ticket, 'sample/03');
  assert.deepEqual(s.landed[0].job.objective, { id: 'deliver', title: 'Synthetic outcome' });
  const output = [], errors = [];
  t.mock.method(Date, 'now', () => now);
  const io = { env: { HUD_HOME: home }, stdout: s => output.push(s), stderr: s => errors.push(s) };
  assert.equal(await main(['stats', '--days', '1', '--by', 'model'], io), 0);
  assert.match(output.pop(), /cost unknown \(0\/\d+\)/);
  assert.equal(await main(['day'], io), 0);
  const day = output.pop();
  assert.match(day, /sample\/03 · aaaaaaaa · Synthetic improvement\./);
  assert.match(day, /another\/01 · aaaaaaaa · summary unknown/);
  assert.match(day, /1× synthetic\.test\.mjs > recovers/);
  assert.doesNotMatch(day, /not flaky/);
  assert.equal(await main(['stats', '--days', '0'], io), 2);
  assert.match(errors.pop(), /Usage: hud stats/);
});
