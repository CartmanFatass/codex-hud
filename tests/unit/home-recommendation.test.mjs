import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HomeRecommendation } from '../../dist-test/src/collectors/home-recommendation.js';
import { SmallModel, apiModelTier } from '../../dist-test/src/collectors/small-model.js';
import { readThinJobs } from '../../dist-test/src/collectors/thin-jobs.js';
import { renderMonitor, initialMonitorState } from '../../dist-test/src/render/monitor.js';
import { setLanguage } from '../../dist-test/src/render/i18n.js';
import { setDisplayConfig } from '../../dist-test/src/render/hud-config.js';
import { stripAnsi, visualLength } from '../../dist-test/src/render/colors.js';
import { defaultSettings, loadSettings, saveSettings } from '../../dist-test/src/settings.js';
import { SETTING_ROWS, handleSettingsInput, resetSettingsGroup, renderSettingsPage } from '../../dist-test/src/render/settings-page.js';
const NOW = Date.parse('2030-01-15T12:00:00Z');
const pause = () => new Promise((r) => setTimeout(r, 5));
function fixture(t, keys = true) {
  const home = fs.mkdtempSync(join(tmpdir(), 'home-recommendation-'));
  const env = { HOME: home, HUD_HOME: home, ...(keys ? { OPENAI_API_KEY: 'synthetic', MISTRAL_API_KEY: 'synthetic' } : {}) };
  const f = { home, env, now: NOW, calls: [], briefs: [], scores: {}, text: 'The build finished. A layout question waits on the owner.' };
  const dir = join(home, 'display/model-cache');
  f.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes('/chat/completions')) {
      f.briefs.push(body);
      if (f.briefHold) await f.briefHold;
      if (f.briefError) return new Response('{}', { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: f.text } }] }));
    }
    f.calls.push({ url: String(url), body });
    if (f.hold) await f.hold;
    if (f.error) return new Response('SYNTHETIC-FAILURE', { status: 400 });
    if (f.malformed) return new Response('not json');
    const digest = JSON.parse(body.input[0].content[1].data.page.text.replace(/^<home>|<\/home>$/g, ''));
    const answers = body.questions.map((q, i) => {
      const choice = String(f.scores[digest[i].id] ?? 2);
      return { type: 'choice', name: q.name, choice, confidence: 1,
        probabilities: q.choices.map(({ value }) => ({ value, probability: value === choice ? 1 : 0 })) };
    });
    if (f.invalid) answers.pop();
    return new Response(JSON.stringify({ answers }));
  };
  f.model = new SmallModel({ dir, env, fetch: f.fetch });
  f.model.configure({ backend: 'api', hourlyCap: 60 });
  f.service = new HomeRecommendation(dir, f.model, () => {}, env, f.fetch, () => f.now);
  f.configure = (on = true, lang = 'en', minutes = 5) => f.service.configure(on, lang, 0, 'openai', minutes);
  f.configure();
  f.put = (id, name, text) => {
    const file = join(home, 'jobs', id, name);
    fs.mkdirSync(join(file, '..'), { recursive: true });
    fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
    fs.utimesSync(file, NOW / 1000, NOW / 1000);
  };
  f.job = (n, state = 'working', pkg = 'SYNTHETIC') => {
    const id = 'j' + n.toString(16).padStart(16, '0');
    f.put(id, 'job.json', { job: id, role: 'imp', package: pkg, herdr_pane: 'w4E:p1', cwd: '/synthetic/project', created_at: new Date(NOW - 60000).toISOString() });
    f.put(id, 'brief.md', '# Synthetic card ' + n);
    f.status(id, state);
    return 'thin-job:' + id;
  };
  f.status = (id, state) => f.put(id.replace('thin-job:', ''), 'STATUS.json', { state, started_at: new Date(NOW - 60000).toISOString(),
    ...(['done', 'failed'].includes(state) ? { settled_at: new Date(NOW).toISOString() } : {}) });
  f.board = () => {
    const lanes = readThinJobs(home, { project: '/synthetic/project', pane: 'w4E:p1' });
    return { revision: '1', lanes, workers: lanes.flatMap((l) => l.workers), decisions: lanes.flatMap((l) => l.decisions), coverage: { incomplete: false, diagnostics: [], workspace: null } };
  };
  f.pump = async (board = f.board()) => {
    for (let i = 0; i < 20; i++) { f.service.update(board); await pause(); }
    return f.service.apply(board);
  };
  f.render = (board, width = 80, lang = 'en', all = false) => {
    const previous = setLanguage(lang), display = setDisplayConfig({ theme: 'none', icons: 'unicode' });
    const state = initialMonitorState(); state.tree.showAll = all;
    try { return renderMonitor({ tree: { rootId: 'synthetic', nodes: [], totalCount: 0, updatedAt: new Date(NOW) }, workboard: board, state, width, height: 55, nowMs: f.now, modelEnabled: true }); }
    finally { setLanguage(previous); setDisplayConfig(display); }
  };
  t.after(async () => { f.service.stop(); f.model.cancelAll(); await pause(); fs.rmSync(home, { recursive: true, force: true }); });
  return f;
}
const plain = (frame) => frame.lines.map(stripAnsi).join('\n');
const titles = (frame) => frame.workboard.rows.filter((r) => r.item?.includes('worker') && /Synthetic card/.test(stripAnsi(r.text))).map((r) => stripAnsi(r.text));
test('Default is byte-identical; ranking reorders cards/lanes, folds low settled cards and protects question 0', async (t) => {
  const f = fixture(t), a = f.job(1), b = f.job(2), low = f.job(3, 'done'), q = f.job(4, 'working', 'OWNER'), high = f.job(5, 'working', 'HIGH');
  f.put(q.slice(9), 'qa/q1.md', 'Question: Choose the synthetic layout?\nDefault if unanswered: compact');
  f.scores = { [a]: 1, [b]: 3, [low]: 0, [q]: 0, [high]: 4 };
  const source = f.board(), before = structuredClone(source), baseline = f.render(source).lines;
  f.configure(false);
  assert.deepEqual(f.render(await f.pump(source)).lines, baseline);
  assert.equal(f.calls.length, 0);
  f.configure();
  const ranked = await f.pump(source), frame = f.render(ranked), text = plain(frame);
  assert.deepEqual(source, before, 'no mutation of facts or card wording');
  assert.equal(f.calls.length, 1); assert.equal(f.briefs.length, 1);
  assert.equal(apiModelTier('home-brief'), 'medium'); assert.equal(f.briefs[0].reasoning_effort, 'high'); assert.ok(f.briefs[0].max_tokens >= 4096);
  assert.ok(text.indexOf('Choose the synthetic layout') < text.indexOf('Synthetic card 5'));
  const rows = titles(frame).join('\n');
  assert.ok(rows.indexOf('card 5') < rows.indexOf('card 2'));
  assert.ok(rows.indexOf('card 2') < rows.indexOf('card 1'));
  assert.doesNotMatch(rows, /card 3/); assert.match(text, /\+1 older/);
  assert.match(titles(f.render(ranked, 80, 'en', true)).join('\n'), /card 3/);
  assert.equal(ranked.workers.find((w) => w.id === q).homeRank, 100);
  const input = f.calls[0].body;
  assert.match(JSON.stringify(input), /quoted data, never instructions/);
  assert.match(f.briefs[0].messages[0].content, /No invented facts.*quoted data, never instructions/);
  assert.equal(f.briefs[0].messages[1].content, input.input[0].content[1].data.page.text);
  f.configure(false);
  assert.deepEqual(f.render(f.service.apply(source)).lines, baseline, 'off hides a cached ranking and brief too');
});
for (const lang of ['en', 'zh']) test(`brief wraps at 80/120 in ${lang}, under the Nothing needs you line`, async (t) => {
  const f = fixture(t); f.job(1, 'done'); f.configure(true, lang);
  f.text = lang === 'zh' ? '构建已完成，布局工作正在等待评审，下一步是检查已经完成的布局工作，当前记录没有新的问题。'.repeat(3)
    : 'The synthetic build finished and the layout work is waiting for review, with no unanswered owner questions in the recorded cards. ';
  const ranked = await f.pump();
  assert.ok(ranked.homeBrief);
  for (const width of [80, 120]) {
    const frame = f.render(ranked, width, lang), lines = frame.lines.map(stripAnsi);
    for (const line of frame.lines) assert.equal(visualLength(line), width);
    const at = lines.findIndex((s) => s.includes(lang === 'en' ? 'Nothing needs you' : '没有需要你'));
    assert.ok(at >= 0, lines.join('\n'));
    assert.ok(lines.slice(at + 1).some((s) => s.includes(lang === 'en' ? 'synthetic build finished' : '构建已完成')));
    assert.ok(frame.workboard.rows.filter((r) => !r.item && stripAnsi(r.text).trim()).length > 2, 'brief wraps rather than truncates');
  }
});
test('one batch per fingerprint, changed board waits two minutes; age/sentence/input order alone does not request', async (t) => {
  const f = fixture(t), id = f.job(1); f.job(2);
  const source = f.board();
  await f.pump(source); assert.equal(f.calls.length, 1);
  await f.pump({ ...source, workers: [...source.workers].reverse() }); assert.equal(f.calls.length, 1);
  f.now += 60000;
  await f.pump({ ...source, workers: source.workers.map((w) => ({ ...w, modelSentence: 'A new sentence.' })) });
  assert.equal(f.calls.length, 1);
  f.status(id, 'done'); const changed = f.board();
  assert.equal(f.service.apply(changed).homeBrief, f.text, 'last brief stays while the changed board waits');
  assert.deepEqual((await f.pump(changed)).workers, changed.workers, 'stale ranks are not applied'); assert.equal(f.calls.length, 1);
  f.now += 59999; await f.pump(changed); assert.equal(f.calls.length, 1);
  f.now++; await f.pump(changed); assert.equal(f.calls.length, 2);
  f.now += 120000; await f.pump(changed); assert.equal(f.calls.length, 2);
  const added = f.job(3); f.scores[added] = 4;
  await f.pump(); assert.equal(f.calls.length, 3, 'membership also changes the fingerprint');
});
for (const mode of ['error', 'malformed', 'invalid', 'no-key', 'off']) test(`${mode}: ranking failure is independent of brief; unchanged failures do not retry`, async (t) => {
  const f = fixture(t, mode !== 'no-key'); f.job(1); f.job(2, 'done');
  if (mode === 'off') f.configure(false); else f[mode] = true;
  const source = f.board(), lines = f.render(source).lines;
  const result = await f.pump(source);
  assert.deepEqual(result.lanes, source.lanes);
  const textUp = !['no-key', 'off'].includes(mode);
  assert.equal(result.homeBrief, textUp ? f.text : undefined);
  if (!textUp) assert.deepEqual(f.render(result).lines, lines);
  assert.doesNotMatch(plain(f.render(result)), /SYNTHETIC-FAILURE|invalid|error|brief/i);
  assert.equal(f.briefs.length, textUp ? 1 : 0);
  assert.equal(f.calls.length, ['no-key', 'off'].includes(mode) ? 0 : 1);
  f.now += 120000; await f.pump(source);
  assert.equal(f.calls.length, ['no-key', 'off'].includes(mode) ? 0 : 1);
});
test('changed sentences refresh only the independent brief after the Summary interval; trimmed newline is valid', async (t) => {
  const f = fixture(t); f.job(1);
  const source = f.board(); await f.pump(source);
  const previous = f.text;
  const changed = structuredClone(source);
  changed.workers[0].modelSentence = 'Integration checks are running.';
  f.text = 'Integration checks are running.\n';
  f.now += 299999;
  const waiting = await f.pump(changed);
  assert.equal(f.briefs.length, 1);
  assert.equal(waiting.homeBrief, previous);
  assert.match(plain(f.render(waiting)), /The build finished/);
  let release;
  f.briefHold = new Promise((resolve) => { release = resolve; });
  f.now++;
  const pending = await f.pump(changed);
  assert.equal(pending.homeBrief, previous, 'old brief stays while the replacement is in flight');
  assert.equal(f.briefs.length, 2);
  release();
  const result = await f.pump(changed);
  assert.equal(f.briefs.length, 2); assert.equal(f.calls.length, 1);
  assert.equal(result.homeBrief, f.text.trim());
  f.now += 600000; await f.pump(changed); assert.equal(f.briefs.length, 2, 'unchanged digest is not resubmitted');
});
test('text model works with no Decision API key', async (t) => {
  const f = fixture(t); delete f.env.OPENAI_API_KEY; f.configure(); f.job(1);
  assert.equal((await f.pump()).homeBrief, f.text);
  assert.equal(f.calls.length, 0); assert.equal(f.briefs.length, 1);
});
test('ranking keeps its two-minute floor; brief defaults to five minutes and interval changes apply live', async (t) => {
  const f = fixture(t), id = f.job(1);
  await f.pump(); assert.equal(f.briefs.length, 1);
  f.now += 120000; f.status(id, 'done');
  let board = await f.pump(); assert.equal(f.calls.length, 2); assert.equal(f.briefs.length, 1); assert.equal(board.homeBrief, f.text);
  f.now += 179999; await f.pump(); assert.equal(f.briefs.length, 1);
  f.now++; board = await f.pump(); assert.equal(f.briefs.length, 2); assert.ok(board.homeBrief); assert.equal(f.calls.length, 2);
  f.configure(true, 'en', 10); f.now += 120000; f.job(2);
  await f.pump(); assert.equal(f.calls.length, 3); assert.equal(f.briefs.length, 2);
  f.configure(true, 'en', 2); await f.pump(); assert.equal(f.briefs.length, 3, 'lowering interval applies without restarting');
});
test('Home ranking uses its Decision ledger; zero cap is unlimited with or without a disk store', async (t) => {
  const f = fixture(t); f.job(1); await f.pump();
  assert.equal(JSON.parse(fs.readFileSync(join(f.home, 'display/model-cache/calls.json'))).length, 1);
  const rankingCalls = JSON.parse(fs.readFileSync(join(f.home, 'display/model-cache/decision-api/calls.json')));
  assert.equal(rankingCalls.length, 1);
  assert.equal(rankingCalls[0].feature, 'home-ranking');
  assert.deepEqual(f.model.usage().byFeature, { 'home-brief': 1 });
  for (let n = 2; n <= 4; n++) { f.now += 120000; f.job(n); await f.pump(); }
  assert.equal(f.calls.length, 4, 'unlimited Decision cap never refuses');
  for (const disk of [true, false]) {
    const model = new SmallModel({ env: f.env, ...(disk ? { dir: join(f.home, 'unlimited') } : {}), fetch: f.fetch });
    model.configure({ backend: 'api', hourlyCap: 1 });
    assert.equal((await model.submit({ feature: 'title', system: '', prompt: 'first' }).result).ok, true);
    model.configure({ hourlyCap: 0 });
    for (let n = 0; n < 3; n++) assert.equal((await model.submit({ feature: 'title', system: '', prompt: 'next' + n }).result).ok, true);
    assert.deepEqual(model.usage(), { today: 4, lastHour: 4, cap: 0, byFeature: { title: 4 } }); model.cancelAll();
  }
});
test('a failed separate brief keeps a valid ranking, without Home errors', async (t) => {
  const f = fixture(t), id = f.job(1, 'done'); f.scores[id] = 0; f.briefError = true;
  const ranked = await f.pump();
  assert.equal(ranked.workers[0].homeFolded, true); assert.equal(ranked.homeBrief, undefined);
  const text = plain(f.render(ranked)); assert.match(text, /\+1 older/); assert.doesNotMatch(text, /error|invalid|unavailable/i);
});
test('an initial failed brief retries the unchanged digest after the Summary interval', async (t) => {
  const f = fixture(t); f.job(1); f.briefError = true;
  assert.equal((await f.pump()).homeBrief, undefined);
  assert.equal(f.briefs.length, 1);
  f.briefError = false; f.now += 299999;
  await f.pump(); assert.equal(f.briefs.length, 1);
  f.now++;
  const recovered = await f.pump();
  assert.equal(f.briefs.length, 2);
  assert.equal(recovered.homeBrief, f.text);
});
test('a failed brief retries after the Summary interval, preserving the last success until recovery', async (t) => {
  const f = fixture(t); f.job(1);
  const source = f.board();
  await f.pump(source);
  const previous = f.text, changed = structuredClone(source);
  changed.workers[0].modelSentence = 'Synthetic checks have started.';
  f.now += 300000; f.briefError = true;
  assert.equal((await f.pump(changed)).homeBrief, previous);
  assert.equal(f.briefs.length, 2);
  f.briefError = false; f.text = 'Synthetic checks have started.';
  f.now += 299999;
  assert.equal((await f.pump(changed)).homeBrief, previous);
  assert.equal(f.briefs.length, 2, 'failed digest still obeys the Summary interval');
  f.now++;
  assert.equal((await f.pump(changed)).homeBrief, f.text);
  assert.equal(f.briefs.length, 3, 'same failed digest retries');
});
test('never blocks a frame; off cancels late ranking/brief results', async (t) => {
  const f = fixture(t); f.job(1);
  let release; f.hold = new Promise((r) => { release = r; });
  const source = f.board(); f.service.update(source);
  assert.equal(f.service.apply(source), source);
  for (let i = 0; i < 50 && !f.calls.length; i++) await pause();
  f.configure(false); release(); await pause(); await pause();
  assert.equal(f.service.apply(source), source);
  const attempts = f.briefs.length;
  await f.pump(source); assert.equal(f.briefs.length, attempts, 'off never submits another brief');
});
test('failure and ended-human 0 stay first and never expire/fold; native subtrees rank as intact groups', async (t) => {
  const f = fixture(t), live = f.job(1), fail = f.job(2, 'failed');
  let board = f.board();
  const base = board.workers.find((w) => w.id === live);
  const native = (id, depth, state = 'working', extra = {}) => ({ ...base, id, laneId: 'native', nativeDepth: depth, state,
    settledAt: state === 'done' ? NOW : null, homeNeedsHuman: false, ...extra });
  const workers = [native('p1', 1), native('c1', 2), native('p2', 1), native('c2', 2), native('g2', 3)];
  board.lanes.push({ ...board.lanes[0], id: 'native', identity: { kind: 'native', refKey: 'synthetic' }, workers, decisions: [] });
  const human = { ...base, id: 'ended-human', settledAt: NOW - 3600000, homeNeedsHuman: true };
  board.lanes[0] = { ...board.lanes[0], workers: [...board.lanes[0].workers, human] };
  board.workers = board.lanes.flatMap((l) => l.workers);
  f.scores = { [live]: 4, [fail]: 0, 'ended-human': 0, p1: 0, c1: 1, p2: 0, c2: 4, g2: 0 };
  let ranked = await f.pump(board);
  assert.deepEqual(ranked.lanes.at(-1).workers.map((w) => w.id), ['p2', 'c2', 'g2', 'p1', 'c1']);
  assert.ok(ranked.lanes[0].workers.findIndex((w) => w.id === fail) < ranked.lanes[0].workers.findIndex((w) => w.id === live));
  assert.equal(ranked.workers.find((w) => w.id === 'ended-human').homeFolded, false);
  f.now += 3600000; ranked = await f.pump(board);
  const shown = f.render(ranked).workboard.snapshot.workers.map((w) => w.id);
  assert.ok(shown.includes(fail)); assert.ok(shown.includes('ended-human'));
});
test('Home mode settings row cycles, round-trips, resets and refuses unknown values', (t) => {
  const f = fixture(t), oldHome = process.env.HUD_HOME, oldSettings = process.env.HUD_SETTINGS_PATH;
  process.env.HUD_HOME = f.home; process.env.HUD_SETTINGS_PATH = join(f.home, 'hud-settings.json');
  t.after(() => { if (oldHome === undefined) delete process.env.HUD_HOME; else process.env.HUD_HOME = oldHome;
    if (oldSettings === undefined) delete process.env.HUD_SETTINGS_PATH; else process.env.HUD_SETTINGS_PATH = oldSettings; });
  assert.equal(defaultSettings().homeMode, 'default');
  const selected = SETTING_ROWS.findIndex((r) => r.key === 'homeMode'); assert.ok(selected >= 0);
  const state = { draft: defaultSettings(), selected, scroll: 0 };
  const changed = handleSettingsInput(state, { type: 'key', key: 'right' }, renderSettingsPage(state, 80, 45)).state;
  assert.equal(changed.draft.homeMode, 'recommended');
  saveSettings({ homeMode: changed.draft.homeMode }); assert.equal(loadSettings().homeMode, 'recommended');
  saveSettings({ homeMode: 'invented' }); assert.equal(loadSettings().homeMode, 'recommended');
  assert.equal(JSON.parse(fs.readFileSync(process.env.HUD_SETTINGS_PATH)).homeMode, 'recommended');
  assert.equal(resetSettingsGroup(changed.draft, 'Panel').homeMode, 'default');
  saveSettings({ modelCallsPerHour: 0, decisionCallsPerHour: 2000, summaryIntervalMinutes: 10 });
  assert.equal(loadSettings().modelCallsPerHour, 0); assert.equal(loadSettings().decisionCallsPerHour, 2000); assert.equal(loadSettings().summaryIntervalMinutes, 10);
  saveSettings({ summaryIntervalMinutes: 121 }); assert.equal(loadSettings().summaryIntervalMinutes, 10);
  const capState = { draft: { ...changed.draft, modelCallsPerHour: 0, decisionCallsPerHour: 0 }, selected, offset: 0 };
  const capText = renderSettingsPage(capState, 80, 55, { state: undefined, modelCalls: { today: 9, lastHour: 9, cap: 0 }, decisionCalls: { lastHour: 99, cap: 0 } }).lines.map(stripAnsi).join('\n');
  assert.match(capText, /Calls this hour\s+9\/∞/); assert.match(capText, /Decision calls this hour\s+99\/∞/); assert.doesNotMatch(capText, /at the cap|█|░/);
  assert.equal(defaultSettings().summaryIntervalMinutes, 5); assert.equal(defaultSettings().decisionCallsPerHour, 0);
  fs.writeFileSync(process.env.HUD_SETTINGS_PATH, JSON.stringify({ homeMode: 'invented' }));
  assert.equal(loadSettings().homeMode, 'default');
});
