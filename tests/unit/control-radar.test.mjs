import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectControlRadar } from '../../dist/collectors/control-radar.js';
import { getJobIndexCache } from '../../dist/roles/job-index-cache.js';
import { recordClaudeQuota } from '../../dist/statusline-parity/quota-cache.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { radarFacts, radarRows, roleToday } from '../../dist/render/control-view.js';
import { NOW, onControl, plain, projectFixture, richControl } from '../fixtures/project-page.mjs';
import { ROLE_STATS, dispatchFrames } from '../fixtures/control-usage.mjs';

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
    assert.match(preview, width === 80 ? /5 ok · 1 failed|5 成功 · 1 失败/ : / jobs · 5✓ 1✗| 个任务 · 5✓ 1✗/, 'counts as words while they fit, else as marks, on the role\'s one row');
    assert.match(preview, /Quota|额度/);
    assert.match(preview, /2026-11-12\s+12:36Z/);
    assert.match(preview, /Pi today|pi 今日/);
    assert.match(preview, /Dispatch today|今日派发/);
    assert.match(plain(role).join('\n'), lang === 'en' ? /today\s+5 ok · 1 failed · avg 6m/ : /今日\s+5 成功 · 1 失败/);
    assert.doesNotMatch(plain(render(rich, split('project:role:oracle'))).join('\n'), /today|今日/);
  }
});

test('per-place dispatch health attributes attempts, fallbacks, legacy places, quota marks and quiet escalations', (t) => {
  const { put, job, collect } = fixture(t);
  // 1. Pre-input launch failure then fallback success on second place.
  job(1, 'imp', 30 * MINUTE, { state: 'done' }, {
    attempts: [
      { index: 0, place: 'cli/agy (h)', reason: 'launch timed out' },
      { index: 1, place: 'pi (m)' },
    ],
    used_place: 'pi (m)',
  });
  // 2. All attempts fail before input (no used_place): only launchFailed on places, role still counts failed.
  job(2, 'imp', 25 * MINUTE, { state: 'failed' }, {
    attempts: [
      { index: 0, place: 'cli/agy (h)', reason: 'spawn failed' },
      { index: 1, place: 'cli/grok (g)', reason: 'launch timed out' },
    ],
  });
  // 3. Legacy job without attempts: inferred from place + model with 1 launch.
  job(3, 'imp', 20 * MINUTE, { state: 'done' }, {
    place: { harness: 'pi' },
    model: 'synthetic/legacy',
  });
  // 4. Quota-marked failure on an adopted place (post-input reason on used_place is not a launch failure).
  job(4, 'imp', 15 * MINUTE, { state: 'failed' }, {
    attempts: [{ index: 0, place: 'pi (m)', reason: 'rate limit exceeded' }],
    used_place: 'pi (m)',
    exhaustion_marked: true,
  });
  // 5. Quiet escalation increments place quietEscalated; ordinary open question does not.
  job(5, 'imp', 10 * MINUTE, { state: 'waiting_orchestrator', quiet_decision: { action: 'needs-human' } }, {
    attempts: [{ index: 0, place: 'pi (m)' }],
    used_place: 'pi (m)',
  });
  const asking = job(6, 'imp', 5 * MINUTE, { state: 'waiting_orchestrator', reason: 'open question' }, {
    attempts: [{ index: 0, place: 'pi (m)' }],
    used_place: 'pi (m)',
  });
  put(join(asking, 'qa', 'q1.md'), 'Question: Synthetic question?');
  // 6. Yesterday's job is ignored.
  job(7, 'imp', DAY, { state: 'done' }, {
    attempts: [{ index: 0, place: 'cli/claude (yesterday)' }],
    used_place: 'cli/claude (yesterday)',
  });
  // 7. Bounded to first 8 attempts; place text truncated to 64 chars.
  const longPlace = `pi (${'x'.repeat(80)})`;
  job(8, 'bounded', 2 * MINUTE, { state: 'failed' }, {
    attempts: [
      { index: 0, place: longPlace, reason: 'fail 0' },
      ...Array.from({ length: 9 }, (_, i) => ({ index: i + 1, place: `cli/p${i + 1}`, reason: `fail ${i + 1}` })),
    ],
  });

  const radar = collect();
  assert.equal(radar.roleStats.imp.total, 6);
  assert.equal(radar.roleStats.imp.ok, 2);
  assert.equal(radar.roleStats.imp.failed, 2);
  assert.equal(radar.roleStats.imp.quietEscalated, 1);
  assert.deepEqual(radar.roleStats.imp.places, {
    'cli/agy (h)': { launches: 2, launchFailed: 2, ok: 0, failed: 0, quietEscalated: 0, quota: 0 },
    'pi (m)': { launches: 4, launchFailed: 0, ok: 1, failed: 1, quietEscalated: 1, quota: 1 },
    'cli/grok (g)': { launches: 1, launchFailed: 1, ok: 0, failed: 0, quietEscalated: 0, quota: 0 },
    'pi (synthetic/legacy)': { launches: 1, launchFailed: 0, ok: 1, failed: 0, quietEscalated: 0, quota: 0 },
  });
  assert.equal(Object.keys(radar.roleStats.bounded.places).length, 8);
  assert.ok(longPlace.slice(0, 64) in radar.roleStats.bounded.places);
  assert.ok(!('cli/p8' in radar.roleStats.bounded.places));
  assert.ok(!('cli/p9' in radar.roleStats.bounded.places));
});

test('Control Dispatch today splits by place at 40 and 80 columns in EN and ZH without changing compact or role detail views', async (t) => {
  const { root } = fixture(t);
  const f = await projectFixture(join(root, 'places-view'));
  const baseline = { ...richControl(f.data), harnesses: [{ name: 'pi', ok: true }], radar: undefined };
  const roleStats = {
    imp: {
      total: 5, ok: 3, failed: 1, quietEscalated: 1, avgMinutes: 12,
      places: {
        'cli/claude (opus)': { launches: 3, launchFailed: 0, ok: 3, failed: 0, quietEscalated: 0, quota: 0 },
        'pi (deepseek-v4-1-flash)': { launches: 1, launchFailed: 0, ok: 0, failed: 1, quietEscalated: 1, quota: 0 },
        'cli/agy (hydrogen)': { launches: 1, launchFailed: 1, ok: 0, failed: 0, quietEscalated: 0, quota: 1 },
      },
    },
    reviewer: {
      total: 2, ok: 2, failed: 0, quietEscalated: 0, avgMinutes: 4,
      places: { 'pi (clean-only)': { launches: 2, launchFailed: 0, ok: 2, failed: 0, quietEscalated: 0, quota: 0 } },
    },
    oracle: {
      total: 1, ok: 0, failed: 0, quietEscalated: 0, avgMinutes: null,
      places: { 'cli/agy (single-fail)': { launches: 1, launchFailed: 1, ok: 0, failed: 0, quietEscalated: 0, quota: 0 } },
    },
    sonic: {
      total: 6, ok: 5, failed: 1, quietEscalated: 1, avgMinutes: 1,
      places: {
        'pi (alpha)': { launches: 5, launchFailed: 0, ok: 5, failed: 0, quietEscalated: 0, quota: 0 },
        'pi (beta)': { launches: 4, launchFailed: 1, ok: 0, failed: 1, quietEscalated: 1, quota: 1 },
        'pi (gamma)': { launches: 3, launchFailed: 0, ok: 0, failed: 0, quietEscalated: 0, quota: 0 },
        'cli/delta\x1b[31m': { launches: 2, launchFailed: 0, ok: 0, failed: 0, quietEscalated: 0, quota: 0 },
        'pi (epsilon)': { launches: 1, launchFailed: 0, ok: 0, failed: 0, quietEscalated: 0, quota: 0 },
      },
    },
  };
  const roleStatsWithoutPlaces = Object.fromEntries(Object.entries(roleStats).map(([k, { places: _p, ...rest }]) => [k, rest]));
  const rich = { ...baseline, radar: { roleStats } };
  const split = (cursor, folded) => onControl({ cursor, folded }, { prefs: { panelLayout: 'split' } });

  for (const width of [40, 80]) for (const lang of ['en', 'zh']) for (const theme of ['none', 'titanium']) {
    const prevDisplay = setDisplayConfig({ theme, icons: 'unicode' }), prevLang = setLanguage(lang);
    try {
      // Compact mode and roleToday are byte-identical with or without places.
      assert.deepEqual(
        radarRows(radarFacts({ roleStats }), width, false),
        radarRows(radarFacts({ roleStats: roleStatsWithoutPlaces }), width, false),
      );
      assert.equal(roleToday(roleStats.imp), roleToday(roleStatsWithoutPlaces.imp));
      assert.equal(roleToday(roleStats.imp, true), roleToday(roleStatsWithoutPlaces.imp, true));
    } finally {
      setDisplayConfig(prevDisplay); setLanguage(prevLang);
    }

    const usageFrame = f.render(width, lang, split('project:fold:usage', new Set(['healthy', 'files', 'agents'])), 80, rich, true, 'unicode', theme);
    const roleFrame = f.render(width, lang, split('project:role:imp'), 80, rich, true, 'unicode', theme);
    for (const frame of [usageFrame, roleFrame]) {
      assert.ok(frame.lines.every((line) => visualLength(line) === width), `width mismatch at ${width}/${lang}/${theme}`);
    }
    const text = plain(usageFrame).join('\n');
    assert.match(text, /cli\/claude \(opus\).*3✓ 0✗/);
    assert.match(text, lang === 'en' ? /0✓ 1✗ · quiet 1/ : /0✓ 1✗ · 转交 1/);
    assert.match(text, lang === 'en' ? /launch ✗1 · quota 1/ : /启动 ✗1 · 配额 1/);
    assert.doesNotMatch(text, /pi \(clean-only\)/, 'single clean place shows no sub-row');
    assert.match(text, /cli\/agy \(single-fail\)|cli\/agy \(…fail\)|cli\/agy \(sin…fail\)/);
    assert.match(text, lang === 'en' ? /\+1 more/ : /另 1 个/);
    assert.doesNotMatch(text, /pi \(epsilon\)/, 'places beyond top 4 by launches are folded into +n');
    assert.ok(!usageFrame.lines.some((line) => stripAnsi(line).includes('\x1b')), 'control characters in place names are escaped');
    // Role detail preview has no chain-row dispatch note (§6 default #2).
    assert.doesNotMatch(plain(roleFrame).join('\n'), /launch ✗|启动 ✗|quota \d|配额 \d/);
  }
});

test('Dispatch today at 42 columns: one row per role that drops avg and quiet before wrapping, place names cut at the end', () => {
  const golden = JSON.parse(fs.readFileSync(new URL('../fixtures/control-usage-frames.json', import.meta.url), 'utf8'));
  assert.deepEqual(dispatchFrames(), golden);
  for (const [name, lines] of Object.entries(golden)) {
    for (const line of lines) assert.ok(visualLength(line) <= 42, `${name}: ${line}`);
    for (const role of Object.keys(ROLE_STATS)) assert.equal(lines.filter((l) => l.startsWith(`  ${role}  `)).length, 1, `${name}: ${role} is one row`);
    assert.ok(!lines.some((l) => /^ {2}(?:·|avg|平均)/.test(l)), `${name}: no row carries on from another`);
    assert.ok(lines.filter((l) => l.includes('…')).every((l) => /^ +\S.*…\s+\d+✓ \d+✗$/.test(l)), `${name}: a long place name is cut at its end`);
  }
  for (const lang of ['en', 'zh']) for (const width of [24, 30, 36, 42, 60, 80]) {
    const display = setDisplayConfig({ theme: 'none', icons: 'unicode' }), previous = setLanguage(lang);
    try {
      for (const row of radarRows(radarFacts({ roleStats: ROLE_STATS }), width, true)) assert.equal(visualLength(row.text), width, `${lang} ${width}: ${row.text}`);
    } finally { setDisplayConfig(display); setLanguage(previous); }
  }
});

test('roleRadar shares JobIndexCache without re-opening unchanged job files after the 5-second throttle', (t) => {
  const { home, job, put, collect } = fixture(t);
  const dir1 = job(1, 'imp', 10 * MINUTE, { state: 'done', started_at: iso(now - 9 * MINUTE), settled_at: iso(now - 3 * MINUTE) });
  job(2, 'reviewer', 5 * MINUTE, { state: 'working' });
  const cache = getJobIndexCache(home);
  // Pre-warm via the shared cache before Control radar runs.
  for (const id of cache.listJobIds()) {
    cache.readJob(id);
    cache.readStatus(id);
  }
  const opened = [];
  const origOpen = fs.openSync;
  fs.openSync = (path, ...args) => { opened.push(String(path)); return origOpen(path, ...args); };
  syncBuiltinESMExports();
  t.after(() => { fs.openSync = origOpen; syncBuiltinESMExports(); });
  const jobOpens = () => opened.filter((p) => /\/jobs\/j[0-9a-f]{16}\/(job|STATUS)\.json$/.test(p));

  const first = collect(now);
  assert.deepEqual(jobOpens(), [], 'warm JobIndexCache avoids opening job.json and STATUS.json');
  assert.deepEqual(first.roleStats, {
    imp: { total: 1, ok: 1, failed: 0, quietEscalated: 0, avgMinutes: 6 },
    reviewer: { total: 1, ok: 0, failed: 0, quietEscalated: 0, avgMinutes: null },
  });

  // Next scan after 5s still opens 0 job files when unchanged.
  assert.deepEqual(collect(now + 5000).roleStats, first.roleStats);
  assert.deepEqual(jobOpens(), []);

  // Mutating one STATUS.json opens only that file on the next unthrottled scan.
  const statusFile = join(dir1, 'STATUS.json');
  put(statusFile, { state: 'failed', ended_at: iso(now - MINUTE) }, now + 6000);
  const next = collect(now + 10000);
  assert.deepEqual(jobOpens(), [statusFile]);
  assert.equal(next.roleStats.imp.ok, 0);
  assert.equal(next.roleStats.imp.failed, 1);
});
