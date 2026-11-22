import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectControlRadar } from '../../dist/collectors/control-radar.js';
import { recordClaudeQuota } from '../../dist/statusline-parity/quota-cache.js';
import { visualLength } from '../../dist/render/colors.js';
import { NOW, onControl, plain, projectFixture, richControl } from '../fixtures/project-page.mjs';

const MINUTE = 60_000, DAY = 86_400_000;
const now = new Date(2030, 8, 24, 12).getTime(), iso = (at) => new Date(at).toISOString();
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-control-radar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'hud'), env = { HOME: join(root, 'home'), HUD_HOME: home, PI_CODING_AGENT_DIR: join(root, 'pi') };
  const put = (path, value, at = now) => {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    fs.utimesSync(path, new Date(at), new Date(at));
  };
  const state = (name) => join(home, 'display', 'state', `${name}.json`);
  const session = (dir, name) => join(env.PI_CODING_AGENT_DIR, 'sessions', dir, `${name}.jsonl`);
  const job = (id, role, ago, status, extra = {}) => {
    const dir = join(home, 'jobs', `j${id.toString(16).padStart(16, '0')}`);
    put(join(dir, 'job.json'), { role, created_at: iso(now - ago), ...extra });
    if (status) put(join(dir, 'STATUS.json'), status);
    return dir;
  };
  return { root, home, env, put, state, session, job, collect: (at = now) => collectControlRadar(home, env, at) };
}
const usage = (input, output, total, at = now) => JSON.stringify({
  type: 'message', timestamp: iso(at), message: { role: 'assistant', usage: { input, output, cost: { total } } },
});

test('quota radar picks fresh HUD windows only; Claude writes a throttled private quota-only artifact', (t) => {
  const { put, state, collect, env } = fixture(t);
  assert.equal(collect(), undefined);
  put(state('codex-old'), { updatedAt: iso(now - MINUTE), quota: [{ percent: 50 }] });
  put(state('codex-latest'), { updatedAt: iso(now), quota: [{ label: '5h', percent: 32, resetsAt: iso(now + MINUTE) },
    { label: '7d', percent: 10, resetsAt: iso(now - 1) }] });
  put(state('future'), { updatedAt: iso(now + DAY), quota: [{ percent: 90 }] });
  put(state('bad-percent'), { updatedAt: iso(now), quota: [{ percent: -1 }, { percent: '34' }] });
  put(state('malformed'), '{unreadable');
  const claude = { session_id: 'synthetic-private', rate_limits: { five_hour: { used_percentage: 18, resets_at: (now + 2 * MINUTE) / 1000 },
    seven_day: { used_percentage: 101 } } };
  recordClaudeQuota(claude, env, now);
  const cachePath = state('claude-quota');
  const cache = () => JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.deepEqual(cache(), { updatedAt: iso(now), quota: [{ label: '5h', percent: 18, resetsAt: iso(now + 2 * MINUTE) }] });
  assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);
  recordClaudeQuota({ rate_limits: { five_hour: { used_percentage: 25 } } }, env, now + 1000);
  recordClaudeQuota(claude, env, now + 10_000);
  assert.equal(cache().updatedAt, iso(now), 'rapid changes and unchanged readings do not rewrite the cache');
  assert.doesNotThrow(() => recordClaudeQuota(claude, { ...env, HUD_HOME: cachePath }, now), 'failed writes do not escape');
  assert.equal(collect(now + 4999), undefined, 'no new disk results inside the 5-second tick');
  assert.deepEqual(collect(now + 5000), { quotas: {
    codex: [{ label: '5h', remaining: 68, resetsAt: now + MINUTE }],
    claude: [{ label: '5h', remaining: 82, resetsAt: now + 2 * MINUTE }],
  } });
  assert.deepEqual(collect(now + MINUTE), { quotas: {
    codex: [{ remaining: 50 }], claude: [{ label: '5h', remaining: 82, resetsAt: now + 2 * MINUTE }],
  } });
  assert.equal(collect(now + 16 * MINUTE), undefined);
});

test('pi and role totals use local days, shared settlement facts, and refresh with changed file signatures', (t) => {
  const { put, session, job, collect } = fixture(t);
  const pi = session('project', 'current');
  put(pi, [usage(90, 9, 3, now - DAY), usage(100, 10, 0.5), usage(200, 20, 0.25), '{partial'].join('\n'));
  put(session('project', 'old'), usage(99, 9, 20), now - DAY);
  put(session('project', 'no-usage'), '{"type":"session"}');
  const imp = job(1, 'imp', 30 * MINUTE, { state: 'idle_grace', started_at: iso(now - 12 * MINUTE), settled_at: iso(now - 6 * MINUTE), ended_at: iso(now - MINUTE) });
  job(2, 'imp', 10 * MINUTE, { state: 'failed', ended_at: iso(now - 2 * MINUTE), quiet_decision: { action: 'fail', choice: 'failed', probability: 0.96 } });
  job(3, 'imp', MINUTE, { state: 'waiting_orchestrator', quiet_decision: { action: 'needs-human', choice: 'finished-no-report', probability: 0.72 } });
  job(4, 'reviewer', MINUTE, undefined, { dispatch_exit_code: 1 });
  job(5, 'reviewer', 2 * MINUTE, { state: 'stopped' });
  job(6, 'old', DAY, { state: 'done' });
  const first = collect();
  assert.deepEqual(first, { piToday: { costUsd: 0.75, tokens: 330, sessions: 1 }, roleStats: {
    imp: { total: 3, ok: 1, failed: 1, quietEscalated: 2, avgMinutes: 7 },
    reviewer: { total: 2, ok: 0, failed: 1, quietEscalated: 0, avgMinutes: null },
  } });
  put(join(imp, 'STATUS.json'), { state: 'working' });
  put(pi, usage(501, 10, 0.75));
  assert.equal(collect(now + 4999), first);
  const next = collect(now + 5000);
  assert.deepEqual(next.roleStats.imp, { total: 3, ok: 0, failed: 1, quietEscalated: 2, avgMinutes: 8 });
  assert.equal(next.piToday.tokens, 511);
  assert.equal(collect(now + DAY), undefined);
});

test('an ordinary question does not increment the quiet-escalation tally', (t) => {
  const { put, job, collect } = fixture(t);
  job(1, 'imp', 2 * MINUTE, { state: 'waiting_orchestrator', quiet_decision: { action: 'needs-human', choice: null, probability: null, reason: 'no-key' } });
  const asking = job(2, 'imp', MINUTE, { state: 'waiting_orchestrator', reason: 'open question' });
  put(join(asking, 'qa', 'q1.md'), 'Question: Which synthetic option?');
  assert.equal(collect().roleStats.imp.total, 2);
  assert.equal(collect().roleStats.imp.quietEscalated, 1);
});

test('bounded scan reads at most 16 pi session directories, 64 JSONL tails and 200 job directories', (t) => {
  const { put, session, job, collect } = fixture(t);
  // An older workspace does not use a directory slot even if one of its files has newer usage.
  for (let n = 0; n <= 16; n++) {
    const path = session(`d${n}`, 'x');
    put(path, n === 16 ? usage(99999, 0, 20) : usage(1, 0, 1), now - n);
    fs.utimesSync(dirname(path), new Date(now - n * 1000), new Date(now - n * 1000));
  }
  assert.deepEqual(collect().piToday, { costUsd: 16, tokens: 16, sessions: 16, sampled: true });
  for (let n = 0; n < 64; n++) put(session('d0', `a${n}`), usage(1, 0, 1), now + 1000 + n);
  put(session('d0', 'large'), `${usage(100000, 0, 1)}\n${'x'.repeat(262144)}\n${usage(3, 0, 1)}`, now + 2000);
  fs.utimesSync(dirname(session('d0', 'large')), new Date(now), new Date(now));
  for (let n = 0; n < 201; n++) job(n, 'imp', (201 - n) * 1000, { state: 'done' });
  const radar = collect(now + 5000);
  assert.deepEqual(radar.piToday, { costUsd: 64, tokens: 66, sessions: 64, sampled: true });
  assert.equal(radar.roleStats.imp.total, 200);
});

test('full Project collection and both Control views include radar without changing the empty baseline', async (t) => {
  const { root } = fixture(t);
  const f = await projectFixture(join(root, 'view'));
  assert.equal((await f.collector.collect('home', f.board, NOW)).radar, undefined);
  assert.ok(f.data.radar.roleStats.imp.total > 0);
  const baseline = { ...richControl(f.data), harnesses: [{ name: 'pi', ok: true }], radar: undefined };
  const empty = { ...baseline, radar: { quotas: { codex: [] }, roleStats: {} } };
  const rich = { ...baseline, radar: {
    quotas: { codex: [{ label: '5h', remaining: 68, resetsAt: NOW + MINUTE }], claude: [{ label: '7d', remaining: 82 }] },
    piToday: { costUsd: 1.42, tokens: 184000, sessions: 2 },
    roleStats: { imp: { total: 6, ok: 5, failed: 1, quietEscalated: 1, avgMinutes: 6 } },
  } };
  const split = (projectCursor, projectFolded) => onControl({ cursor: projectCursor, folded: projectFolded }, { prefs: { panelLayout: 'split' } });
  for (const width of [40, 80]) for (const lang of ['en', 'zh']) {
    const render = (snapshot, state) => f.render(width, lang, state, 80, snapshot);
    for (const state of ['control', split('project:role:imp')]) assert.deepEqual(render(empty, state).lines, render(baseline, state).lines);
    const classic = render(rich, 'control'), radar = render(rich, split('project:fold:usage', new Set(['healthy', 'files', 'agents']))), role = render(rich, split('project:role:imp'));
    for (const frame of [classic, radar, role]) assert.ok(frame.lines.every((line) => visualLength(line) === width));
    const lines = plain(classic), i = lines.findIndex((line) => /^(Usage|用量)/.test(line));
    assert.ok(i === -1 && lines.some((line) => /^▸ (Usage|用量) .*68%/.test(line)), lines.join('\n'));
    const preview = plain(radar).join('\n');
    assert.equal(radar.state.control.roles.nav.cursor, 'project:fold:usage');
    assert.match(preview, /\$1\.42.*184K/);
    assert.match(preview, /5 ok · 1 failed|5 成功 · 1 失败/);
    assert.match(preview, /Quota|额度/);
    assert.match(preview, /2026-11-12\s+12:36Z/);
    assert.match(preview, /Pi today|pi 今日/);
    assert.match(preview, /Dispatch today|今日派发/);
    assert.match(plain(role).join('\n'), lang === 'en' ? /today\s+5 ok · 1 failed · avg 6m/ : /今日\s+5 成功 · 1 失败/);
    assert.doesNotMatch(plain(render(rich, split('project:role:oracle'))).join('\n'), /today|今日/);
  }
});
