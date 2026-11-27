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
  const path = put('stdout.jsonl', [
    { type: 'assistant', message: { model: 'claude-prefix' }, text: 'x'.repeat(2 * 1024 * 1024) },
    { type: 'assistant', message: { model: 'claude-tail' } },
    { ...result(11, 0.125), modelUsage: { 'claude-tail': {} } },
  ]);
  recordJobUsage(home, job, first);
  assert.deepEqual(readJobUsage(home, first), { input: 11, output: 2, cost_usd: 0.125 });
  const next = { ...first, settled_at: '2026-11-23T11:00:00Z', stdout_start: fs.statSync(path).size };
  fs.appendFileSync(path, JSON.stringify({ ...result(5, 0), modelUsage: { 'claude-next': {} } }) + '\n');
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

test('AGY keeps stream totals and adds missing model history from the native transcript', t => {
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
    { type: 'PLANNER_RESPONSE', model: 'agy-a', input_tokens: 7, cache_read_tokens: 2, output_tokens: 3 },
    { type: 'PLANNER_RESPONSE', model: 'agy-b', input_tokens: 2, cache_read_tokens: 0, output_tokens: 1 },
  ]);
  put('stdout.jsonl', [{ event: 'init' }, { event: 'result', result: {
    model: 'agy-b', usage: { input_tokens: 10, cache_read_tokens: 2, output_tokens: 5 },
  } }]);
  const merged = { ...status, settled_at: '2026-11-23T12:00:00Z', agent_session_id: 'synthetic-session' };
  recordJobUsage(home, agy, merged);
  assert.deepEqual(readJobUsage(home, merged), {
    input: 10, cache_read: 2, output: 5, served_model: 'agy-b', served_models: ['agy-a', 'agy-b'],
  });
});

test('Codex retains cumulative totals but not model evidence from a cut or malformed rollout', t => {
  const { home, put } = fixture(t);
  const date = new Date(), y = String(date.getFullYear()), m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0'), session = '01234567-0123-0123-0123-0123456789ab';
  const old = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; });
  const rollout = `sessions/${y}/${m}/${d}/rollout-${y}-${m}-${d}T22-00-00-${session}.jsonl`;
  for (const [index, gap] of [{ type: 'response_item', text: 'x'.repeat(2 * 1024 * 1024) }, '{broken'].entries()) {
    put(rollout, [
      { type: 'session_meta', payload: { id: session } },
      { type: 'turn_context', payload: { model: 'codex-prefix' } },
      gap,
      { type: 'turn_context', payload: { model: 'codex-tail' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 30, cached_input_tokens: 20, output_tokens: 4 } } } },
    ]);
    const codex = { ...status, settled_at: `2026-11-23T12:0${index}:00Z`, agent_session_id: session };
    recordJobUsage(home, { cli: { agent: 'codex' } }, codex);
    assert.deepEqual(readJobUsage(home, codex), { input: 10, cache_read: 20, output: 4 });
  }
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

test('Pi, Claude, Codex and AGY settlement record served_model and served_models (<=4), ignore <synthetic>, and leave truncated/missing absent', t => {
  const { home, put } = fixture(t);
  const oldHome = process.env.HOME;
  const oldCodex = process.env.CODEX_HOME;
  const oldClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  process.env.CODEX_HOME = join(home, '.codex');
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
    if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
  });

  // 1. Pi: provider/model + fast/ultrafast tier, copied-session filter, >4 cap, <synthetic> ignored, truncated/missing absent.
  const piDir = join(home, 'job-pi');
  fs.mkdirSync(piDir, { recursive: true });
  const piMsg = (timestamp, provider, model, extra = {}) => ({
    type: 'message', timestamp,
    message: { role: 'assistant', provider, model, ...extra, usage: { input: 5, cacheRead: 1, cacheWrite: 0, output: 2 } },
  });
  const piPath = put('pi-mixed.jsonl', [
    { type: 'session' },
    { type: 'service_tier_change', serviceTier: { openai: 'priority' } },
    piMsg('2026-11-22T12:00:00Z', 'openai', 'gpt-before-retry'),
    piMsg('2026-11-23T10:01:00Z', 'openai', '<synthetic>'),
    piMsg('2026-11-23T10:02:00Z', 'openai', 'gpt-a'),
    piMsg('2026-11-23T10:03:00Z', 'openai', 'gpt-b', { serviceTier: 'ultrafast' }),
    piMsg('2026-11-23T10:04:00Z', 'anthropic', 'claude-c'),
    piMsg('2026-11-23T10:05:00Z', 'openai', 'gpt-d-fast', { serviceTier: 'fast' }),
    piMsg('2026-11-23T10:06:00Z', 'openai', 'gpt-e', { service_tier: 'standard' }),
  ]);
  const piStatus = { ...status, settled_at: '2026-11-23T10:10:00Z', session_file: piPath };
  recordJobUsage(piDir, { retry_of: id(1), created_at: '2026-11-23T10:00:00Z' }, piStatus);
  assert.deepEqual(readJobUsage(piDir, piStatus), {
    input: 30, cache_read: 6, cache_write: 0, output: 12,
    served_model: 'openai/gpt-e',
    served_models: ['openai/gpt-b:ultrafast', 'anthropic/claude-c', 'openai/gpt-d-fast', 'openai/gpt-e'],
  });
  // Invalid response snapshot falls back to the alias; a single model does not emit served_models.
  const piSingle = put('pi-single.jsonl', [
    { type: 'session' },
    { type: 'service_tier_change', serviceTier: 'fast' },
    piMsg('2026-11-23T10:02:00Z', 'openai', 'gpt-solo', { responseModel: '<synthetic>' }),
  ]);
  const piSingleStatus = { ...status, settled_at: '2026-11-23T10:11:00Z', session_file: piSingle };
  recordJobUsage(piDir, {}, piSingleStatus);
  assert.deepEqual(readJobUsage(piDir, piSingleStatus), {
    input: 5, cache_read: 1, cache_write: 0, output: 2,
    served_model: 'openai/gpt-solo:fast',
  });
  const piSnapshots = put('pi-snapshots.jsonl', [
    { type: 'session' },
    { type: 'service_tier_change', serviceTier: { openai: 'fast' } },
    piMsg('2026-11-23T10:02:00Z', 'openai', 'gpt-alias', { responseModel: 'gpt-snapshot-a' }),
    piMsg('2026-11-23T10:03:00Z', 'openai', 'gpt-alias', { responseModel: 'openai/gpt-snapshot-b', serviceTier: 'ultrafast' }),
  ]);
  const piSnapshotStatus = { ...status, settled_at: '2026-11-23T10:11:30Z', session_file: piSnapshots };
  recordJobUsage(piDir, {}, piSnapshotStatus);
  assert.deepEqual(readJobUsage(piDir, piSnapshotStatus), {
    input: 10, cache_read: 2, cache_write: 0, output: 4,
    served_model: 'openai/gpt-snapshot-b:ultrafast',
    served_models: ['openai/gpt-snapshot-a:fast', 'openai/gpt-snapshot-b:ultrafast'],
  });
  // Truncated and missing Pi transcripts leave served_model absent.
  const piCut = put('pi-cut.jsonl', [
    { type: 'session' }, JSON.stringify({ content: 'x'.repeat(2 * 1024 * 1024) }),
    piMsg('2026-11-23T10:02:00Z', 'openai', 'gpt-cut'),
  ]);
  const piCutStatus = { ...status, settled_at: '2026-11-23T10:12:00Z', session_file: piCut };
  recordJobUsage(piDir, {}, piCutStatus);
  assert.equal(readJobUsage(piDir, piCutStatus), undefined);
  const piMissing = { ...status, settled_at: '2026-11-23T10:13:00Z', session_file: join(home, 'missing.jsonl') };
  recordJobUsage(piDir, {}, piMissing);
  assert.equal(readJobUsage(piDir, piMissing), undefined);

  // 2. Claude: stdout.jsonl assistant message.model + result modelUsage keys, and native transcript.
  const claudeDir = join(home, 'job-claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudeJob = { headless: true, cli: { agent: 'claude' } };
  const claudeStdout = put('job-claude/stdout.jsonl', [
    { type: 'assistant', message: { model: '<synthetic>' } },
    { type: 'assistant', message: { model: 'claude-sonnet-5-5-20261125' } },
    { type: 'assistant', message: { model: 'claude-opus-5-5-20261125' } },
    { type: 'result', usage: { input_tokens: 10, output_tokens: 4 }, total_cost_usd: 0.2,
      modelUsage: { '<synthetic>': {}, 'claude-opus-5-5-20261125': {}, 'claude-sonnet-5-5-20261125': {} } },
  ]);
  const claudeFirst = { ...status, settled_at: '2026-11-23T11:00:00Z', stdout_start: 0 };
  recordJobUsage(claudeDir, claudeJob, claudeFirst);
  assert.deepEqual(readJobUsage(claudeDir, claudeFirst), {
    input: 10, output: 4, cost_usd: 0.2,
    served_model: 'claude-opus-5-5-20261125',
    served_models: ['claude-sonnet-5-5-20261125', 'claude-opus-5-5-20261125'],
  });
  // Second contiguous headless turn adds modelUsage-only model.
  const claudeNext = { ...status, settled_at: '2026-11-23T11:05:00Z', stdout_start: fs.statSync(claudeStdout).size };
  fs.appendFileSync(claudeStdout, JSON.stringify({
    type: 'result', usage: { input_tokens: 3, output_tokens: 1 }, total_cost_usd: 0.05,
    modelUsage: { 'claude-haiku-4-5-20251001': {} },
  }) + '\n');
  recordJobUsage(claudeDir, claudeJob, claudeNext);
  assert.deepEqual(readJobUsage(claudeDir, claudeNext), {
    input: 13, output: 5, cost_usd: 0.25,
    served_model: 'claude-haiku-4-5-20251001',
    served_models: ['claude-sonnet-5-5-20261125', 'claude-opus-5-5-20261125', 'claude-haiku-4-5-20251001'],
  });
  // Claude native transcript: ignores <synthetic>, caps mixed at 4, truncated stays absent.
  const claudeCwd = '/synthetic/claude-proj';
  const claudeSlug = claudeCwd.replace(/[^a-zA-Z0-9-]/g, '-');
  const claudeTabDir = join(home, 'job-claude-tab');
  fs.mkdirSync(claudeTabDir, { recursive: true });
  put(`.claude/projects/${claudeSlug}/claude-native-1.jsonl`, [
    { type: 'assistant', message: { model: '<synthetic>' } },
    { type: 'assistant', message: { id: 'm1', model: 'claude-1', usage: { input_tokens: 2, output_tokens: 1 } } },
    { type: 'assistant', message: { id: 'm2', model: 'claude-2', usage: { input_tokens: 2, output_tokens: 1 } } },
    { type: 'assistant', message: { id: 'm3', model: 'claude-3', usage: { input_tokens: 2, output_tokens: 1 } } },
    { type: 'assistant', message: { id: 'm4', model: 'claude-4', usage: { input_tokens: 2, output_tokens: 1 } } },
    { type: 'assistant', message: { id: 'm5', model: 'claude-5', usage: { input_tokens: 2, output_tokens: 1 } } },
  ]);
  const claudeNativeStatus = { ...status, settled_at: '2026-11-23T11:10:00Z', agent_session_id: 'claude-native-1' };
  recordJobUsage(claudeTabDir, { cli: { agent: 'claude' }, cwd: claudeCwd }, claudeNativeStatus);
  assert.deepEqual(readJobUsage(claudeTabDir, claudeNativeStatus), {
    input: 10, output: 5,
    served_model: 'claude-5',
    served_models: ['claude-2', 'claude-3', 'claude-4', 'claude-5'],
  });
  put(`.claude/projects/${claudeSlug}/claude-cut.jsonl`, [
    { type: 'assistant', text: 'x'.repeat(2 * 1024 * 1024) },
    { type: 'assistant', message: { id: 'm1', model: 'claude-cut', usage: { input_tokens: 2, output_tokens: 1 } } },
  ]);
  const claudeCutStatus = { ...status, settled_at: '2026-11-23T11:11:00Z', agent_session_id: 'claude-cut' };
  recordJobUsage(claudeTabDir, { cli: { agent: 'claude' }, cwd: claudeCwd }, claudeCutStatus);
  assert.equal(readJobUsage(claudeTabDir, claudeCutStatus), undefined);

  // 3. Codex: turn_context models (and session_meta fallback), headless stream + native rollout, truncated absent.
  const date = new Date(), y = String(date.getFullYear()), m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const codexDir = join(home, 'job-codex');
  fs.mkdirSync(codexDir, { recursive: true });
  const cxMixed = '11111111-1111-1111-1111-111111111111';
  put(`.codex/sessions/${y}/${m}/${d}/rollout-${y}-${m}-${d}T22-00-00-${cxMixed}.jsonl`, [
    { type: 'session_meta', payload: { id: cxMixed, model: 'gpt-ignored-when-turn-context' } },
    { type: 'turn_context', payload: { turn_id: 't1', model: '<synthetic>' } },
    { type: 'turn_context', payload: { turn_id: 't2', model: 'gpt-6-a' } },
    { type: 'turn_context', payload: { turn_id: 't3', model: 'gpt-6-b' } },
    { type: 'token_usage_record', payload: { turn_id: 't3', response_id: 'r1', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 7 } } },
  ]);
  put('job-codex/stdout.jsonl', [
    { type: 'thread.started' },
    { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 7 } },
  ]);
  const cxStatus = { ...status, settled_at: '2026-11-23T12:00:00Z', agent_session_id: cxMixed };
  recordJobUsage(codexDir, { headless: true, cli: { agent: 'codex' } }, cxStatus);
  assert.deepEqual(readJobUsage(codexDir, cxStatus), {
    input: 15, cache_read: 5, output: 7,
    served_model: 'gpt-6-b',
    served_models: ['gpt-6-a', 'gpt-6-b'],
  });
  const cxMetaOnly = '22222222-2222-2222-2222-222222222222';
  put(`.codex/sessions/${y}/${m}/${d}/rollout-${y}-${m}-${d}T22-01-00-${cxMetaOnly}.jsonl`, [
    { type: 'session_meta', payload: { id: cxMetaOnly, model: 'gpt-6-meta' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 3 } } } },
  ]);
  const cxMetaStatus = { ...status, settled_at: '2026-11-23T12:01:00Z', agent_session_id: cxMetaOnly };
  recordJobUsage(codexDir, { cli: { agent: 'codex' } }, cxMetaStatus);
  assert.deepEqual(readJobUsage(codexDir, cxMetaStatus), {
    input: 10, cache_read: 2, output: 3,
    served_model: 'gpt-6-meta',
  });
  const cxCut = '33333333-3333-3333-3333-333333333333';
  put(`.codex/sessions/${y}/${m}/${d}/rollout-${y}-${m}-${d}T22-02-00-${cxCut}.jsonl`, [
    { type: 'session_meta', payload: { id: cxCut, model: 'gpt-6-cut' } },
    { type: 'response_item', text: 'x'.repeat(2 * 1024 * 1024) },
    { type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-6-cut-tail' } },
    { type: 'token_usage_record', payload: { turn_id: 't1', response_id: 'r1', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } } },
  ]);
  const cxCutStatus = { ...status, settled_at: '2026-11-23T12:02:00Z', agent_session_id: cxCut };
  recordJobUsage(codexDir, { cli: { agent: 'codex' } }, cxCutStatus);
  assert.equal(readJobUsage(codexDir, cxCutStatus), undefined);

  // 4. AGY: PLANNER_RESPONSE model, mixed (>4 capped at 4), <synthetic> ignored, truncated/missing absent.
  const agyDir = join(home, 'job-agy');
  fs.mkdirSync(agyDir, { recursive: true });
  const brain = '.gemini/antigravity-cli/brain';
  put(`${brain}/agy-mixed/.system_generated/logs/transcript_full.jsonl`, [
    { type: 'PLANNER_RESPONSE', model: '<synthetic>', input_tokens: 1, cache_read_tokens: 0, output_tokens: 1 },
    { type: 'PLANNER_RESPONSE', model: 'gemini-4-m1', input_tokens: 2, cache_read_tokens: 1, output_tokens: 1 },
    { type: 'PLANNER_RESPONSE', model: 'gemini-4-m2', input_tokens: 2, cache_read_tokens: 0, output_tokens: 1 },
    { type: 'PLANNER_RESPONSE', model: 'gemini-4-m3', input_tokens: 2, cache_read_tokens: 0, output_tokens: 1 },
    { type: 'PLANNER_RESPONSE', model: 'gemini-4-m4', input_tokens: 2, cache_read_tokens: 0, output_tokens: 1 },
    { type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', input_tokens: 2, cache_read_tokens: 1, output_tokens: 1 },
  ]);
  const agyMixedStatus = { ...status, settled_at: '2026-11-23T13:00:00Z', agent_session_id: 'agy-mixed' };
  recordJobUsage(agyDir, { cli: { agent: 'agy' } }, agyMixedStatus);
  assert.deepEqual(readJobUsage(agyDir, agyMixedStatus), {
    input: 11, cache_read: 2, output: 6,
    served_model: 'gemini-4-neon-high',
    served_models: ['gemini-4-m2', 'gemini-4-m3', 'gemini-4-m4', 'gemini-4-neon-high'],
  });
  put(`${brain}/agy-cut/.system_generated/logs/transcript_full.jsonl`, [
    { type: 'USER_REQUEST', text: 'x'.repeat(2 * 1024 * 1024) },
    { type: 'PLANNER_RESPONSE', model: 'gemini-4-cut', input_tokens: 2, cache_read_tokens: 0, output_tokens: 1 },
  ]);
  const agyCutStatus = { ...status, settled_at: '2026-11-23T13:01:00Z', agent_session_id: 'agy-cut' };
  recordJobUsage(agyDir, { cli: { agent: 'agy' } }, agyCutStatus);
  assert.equal(readJobUsage(agyDir, agyCutStatus), undefined);
  const agyMissing = { ...status, settled_at: '2026-11-23T13:02:00Z', agent_session_id: 'agy-does-not-exist' };
  recordJobUsage(agyDir, { cli: { agent: 'agy' } }, agyMissing);
  assert.equal(readJobUsage(agyDir, agyMissing), undefined);
});
