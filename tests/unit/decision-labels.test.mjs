import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsMutable from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DecisionLabels, reviewFindings } from '../../dist-test/src/collectors/decision-labels.js';
import { SmallModel } from '../../dist-test/src/collectors/small-model.js';
import { readThinJobs } from '../../dist-test/src/collectors/thin-jobs.js';
import { jobActivity, JobSentences } from '../../dist-test/src/collectors/job-sentences.js';
import { homeRows } from '../../dist-test/src/render/home-view.js';
import { workInspectorRows } from '../../dist-test/src/render/work-inspector.js';
import { projectRows } from '../../dist-test/src/render/project-view.js';
import { initialMonitorState, renderMonitor } from '../../dist-test/src/render/monitor.js';
import { setLanguage, t as tr } from '../../dist-test/src/render/i18n.js';
import { setDisplayConfig } from '../../dist-test/src/render/hud-config.js';
import { stripAnsi, visualLength } from '../../dist-test/src/render/colors.js';
import { saveSettings } from '../../dist-test/src/settings.js';

const pause = () => new Promise((r) => setTimeout(r, 5));
const empty = (workers = [], decisions = []) => ({ revision: '1', coverage: { incomplete: false, diagnostics: [], workspace: null },
  workers, decisions, lanes: [{ id: 'lane', label: 'SYNTHETIC', title: '', identity: { kind: 'native', refKey: 'test' }, workers, decisions, startedAt: null, phase: null, evidence: [] }] });
function fixture(t, keys = { GEMINI_API_KEY: 'synthetic-gemini', OPENAI_API_KEY: 'synthetic-openai' }) {
  const home = fs.mkdtempSync(join(tmpdir(), 'decision-labels-')), dir = join(home, 'display/model-cache');
  const f = { home, dir, now: Date.parse('2030-01-15T12:00:00Z'), calls: [], reply: null, quota: false };
  const env = { HOME: home, HUD_HOME: home, ...keys };
  f.put = (id, name, value) => {
    const file = join(home, 'jobs', id, name);
    fs.mkdirSync(join(file, '..'), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    fs.utimesSync(file, f.now / 1000, f.now / 1000);
    return file;
  };
  f.job = (n = 1, state = 'done', age = 0, role = 'imp') => {
    const id = 'j' + n.toString(16).padStart(16, '0');
    f.put(id, 'job.json', { job: id, role, package: 'SYNTHETIC', herdr_pane: 'w4E:p1', cwd: '/synthetic/project', created_at: new Date(f.now - age - 120000).toISOString() });
    f.put(id, 'STATUS.json', { state, started_at: new Date(f.now - age - 120000).toISOString(), settled_at: new Date(f.now - age).toISOString(), model: 'synthetic-model', thinking: 'high' });
    return id;
  };
  f.board = () => {
    const lanes = readThinJobs(home, { pane: 'w4E:p1', project: '/synthetic/project' });
    return { ...empty(), lanes, workers: lanes.flatMap((l) => l.workers), decisions: lanes.flatMap((l) => l.decisions) };
  };
  f.config = (decisions) => fs.writeFileSync(join(home, 'config.json'), JSON.stringify({ decisions }));
  f.fetch = async (url, init) => {
    const body = JSON.parse(init.body), gemini = String(url).includes('googleapis'), keyed = !Array.isArray(body.questions);
    f.calls.push({ url: String(url), body });
    if (f.quota && gemini) return new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), { status: 429, headers: { 'retry-after': '60' } });
    const status = f.fail?.(String(url));
    if (status) return new Response(JSON.stringify({ error: { message: 'prepayment credits depleted SYNTHETIC-HTTP-BODY' } }), { status });
    const qs = keyed ? Object.entries(body.questions).map(([name, q]) => ({ name, values: Object.keys(q.criteria) }))
      : body.questions.map((q) => ({ name: q.name, values: q.choices.map((c) => c.value) }));
    const input = JSON.stringify(body.input ?? body.state);
    const answers = qs.map(({ name, values }) => {
      const choice = f.reply?.(name, input, values) ?? (name === 'outcome' ? 'partial' : name === 'progress' ? (input.includes('failed command') ? 'looping' : 'progressing')
        : name === 'category' ? (input.includes('authorise') ? 'owner authorisation' : 'clarification')
        : name.startsWith('f') && /^f\d+$/.test(name) ? ['must fix', 'should fix', 'optional'][Number(name.slice(1)) % 3]
        : name === 'feature' || name === 'ui' ? 'included' : 'excluded');
      const probabilities = Object.fromEntries(values.map((v) => [v, v === choice ? 0.9 : 0.1 / (values.length - 1)]));
      return { name, type: 'choice', choice, confidence: 0.9, probabilities };
    });
    return new Response(JSON.stringify({ answers: keyed ? Object.fromEntries(answers.map(({ name, ...a }) => [name, a])) : answers.map((a) => ({ ...a, probabilities: Object.entries(a.probabilities).map(([value, probability]) => ({ value, probability })) })) }));
  };
  f.open = () => { f.service = new DecisionLabels(dir, () => {}, env, f.fetch, () => f.now); f.service.configure(true, f.cap ?? 60); };
  f.open();
  f.pump = async (board = f.board, tree, rounds = 16) => {
    for (let i = 0; i < rounds; i++) { f.service.update(board(), home, tree); await pause(); }
    return f.service.apply(board());
  };
  const previous = setDisplayConfig({ theme: 'terminal', icons: 'unicode' });
  t.after(async () => { f.service.stop(); await pause(); setDisplayConfig(previous); fs.rmSync(home, { recursive: true, force: true }); });
  return f;
}

test('01: one bounded outcome per settlement, cache reopen, no lifecycle mutations', async (t) => {
  const f = fixture(t), id = f.job();
  f.put(id, 'report.md', 'Required live validation was not run.\n' + 'head\n'.repeat(20) + 'NOT-OUTBOUND');
  const status = fs.readFileSync(join(f.home, 'jobs', id, 'STATUS.json'), 'utf8');
  let board = await f.pump();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(board.workers[0].labels.outcome, { value: 'partial', confidence: 0.9 });
  assert.doesNotMatch(JSON.stringify(f.calls), /NOT-OUTBOUND/);
  assert.equal(fs.readFileSync(join(f.home, 'jobs', id, 'STATUS.json'), 'utf8'), status);
  f.open(); board = await f.pump();
  assert.equal(f.calls.length, 1, 'reopening consumes no call');
  f.now += 1000; f.put(id, 'report.md', 'Edited report, same settlement');
  await f.pump(); assert.equal(f.calls.length, 1);
  f.now += 1000; f.put(id, 'STATUS.json', { state: 'done', settled_at: new Date(f.now).toISOString() });
  await f.pump(); assert.equal(f.calls.length, 2, 'a new settlement is eligible');
});
for (const mode of ['off', 'no-key']) test(`01: ${mode} hides labels and sends nothing`, async (t) => {
  const f = fixture(t, mode === 'off' ? undefined : {});
  const id = f.job(); f.put(id, 'report.md', 'Done');
  if (mode === 'off') f.service.configure(false, 60);
  const board = await f.pump(); assert.equal(f.calls.length, 0); assert.equal(board.workers[0].labels, undefined);
});

test('02: multi-kind once, bounded title/goal, newest-first within one day; no two-day backfill', async (t) => {
  const f = fixture(t); f.cap = 2; f.open();
  const newest = f.job(1), older = f.job(2, 'done', 86400000), oldest = f.job(3, 'done', 2 * 86400000), expired = f.job(4, 'done', 31 * 86400000);
  for (const [id, title] of [[newest, 'newest'], [older, 'older'], [oldest, 'oldest'], [expired, 'expired']])
    f.put(id, 'brief.md', `# ${title}\n\nGoal: feature UI.\n\nNOT-OUTBOUND\n` + 'x'.repeat(2000));
  let board = await f.pump();
  assert.equal(f.calls.length, 2);
  assert.match(JSON.stringify(f.calls[0].body.input), /newest/); assert.match(JSON.stringify(f.calls[1].body.input), /older/);
  assert.doesNotMatch(JSON.stringify(f.calls), /NOT-OUTBOUND|expired/);
  assert.deepEqual(board.workers[0].labels.kinds, ['ui', 'feature']);
  assert.deepEqual(f.service.usage().byFeature, { kind: 2 });
  f.open(); await f.pump(); assert.equal(f.calls.length, 2);
  f.now += 3600001; board = await f.pump(); assert.equal(f.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(f.calls), /oldest|expired/, 'no kind call for a job settled two days ago');
  assert.equal(board.workers.find((w) => w.id.endsWith(expired)).labels.kinds.length, 0);
  f.now += 3600001; f.put(newest, 'brief.md', '# Changed title\n\nNew goal');
  await f.pump(); assert.equal(f.calls.length, 2, 'kind is frozen per job');
});

function transcript(command, n = 12, format = 'pi') {
  return Array.from({ length: n }, (_, i) => {
    const id = `call-${i}`;
    if (format === 'codex') return [
      { type: 'response_item', payload: { type: 'function_call', call_id: id, name: 'exec_command', arguments: JSON.stringify({ command }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: command.includes('failed') ? 'exit=1' : 'passed' } }];
    if (format === 'claude') return [
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE-REASONING' }, { type: 'tool_use', id, name: 'Bash', input: { command } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'exit=1' }] } }];
    return [
      { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE-REASONING' }, { type: 'toolCall', id, name: 'bash', arguments: { command } }] } },
      { message: { role: 'toolResult', toolCallId: id, content: [{ type: 'text', text: command.includes('failed') ? 'exit=1' : 'passed' }] } }];
  }).flat().map((v) => JSON.stringify(v)).join('\n') + '\n';
}
for (const format of ['pi', 'claude', 'codex']) test(`04: quiet ${format} loop, progress, five-minute floor, clear on new activity`, async (t) => {
  const f = fixture(t), id = f.job(1, 'working');
  const file = f.put(id, 'sessions/synthetic.jsonl', transcript('failed command', 18, format));
  const native = { id: 'native-synthetic', rolloutPath: file, name: 'synthetic', depth: 1, children: [], status: 'running' };
  const source = f.board().workers[0], w = { ...source, id: native.id, nativeDepth: 1, evidence: [], files: [], work: { ...source.work, activityAt: f.now } };
  const tree = { rootId: 'synthetic', nodes: [native], totalCount: 1, updatedAt: new Date(f.now) };
  const board = () => empty([w]);
  await f.pump(board, tree); assert.equal(f.calls.length, 0, 'fresh activity is not judged');
  f.now += 180001;
  let labelled = await f.pump(board, tree); assert.equal(f.calls.length, 1); assert.equal(labelled.workers[0].labels.looping, 0.9);
  assert.deepEqual(f.service.usage().byFeature, { looping: 1 });
  assert.equal(jobActivity(f.home, w, native).items.length, 12);
  assert.doesNotMatch(JSON.stringify(f.calls), /PRIVATE-REASONING/);
  assert.match(JSON.stringify(f.calls), /exit=1/);
  f.open(); await f.pump(board, tree); assert.equal(f.calls.length, 1, 'cached quiet verdict survives reopen');
  f.now += 1000; f.put(id, 'sessions/synthetic.jsonl', transcript('tests passed', 3, format));
  labelled = await f.pump(board, tree); assert.equal(labelled.workers[0].labels.looping, undefined);
  f.now += 180001; await f.pump(board, tree); assert.equal(f.calls.length, 1, 'different revision is still within five minutes');
  f.now += 120001; labelled = await f.pump(board, tree); assert.equal(f.calls.length, 2); assert.equal(labelled.workers[0].labels.looping, undefined);
});

test('04: HUD job uses the same public activity input as its sentence', async (t) => {
  const f = fixture(t), id = f.job(1, 'working'); f.put(id, 'sessions/synthetic.jsonl', transcript('failed command'));
  f.now += 180001;
  const board = await f.pump(); assert.equal(board.workers[0].labels.looping, 0.9);
  let outbound;
  const model = new SmallModel({ env: { HUD_HOME: f.home, MISTRAL_API_KEY: 'synthetic' }, fetch: async (_u, init) => {
    outbound = JSON.parse(init.body).messages[1].content; return new Response(JSON.stringify({ choices: [{ message: { content: 'Checking commands.' } }] }));
  } }); model.configure({ backend: 'api' });
  const sentences = new JobSentences(model, join(f.dir, 'sentences.json'), () => {}, () => f.now);
  sentences.configure(true, 'en'); sentences.update(f.board(), f.home); await pause();
  assert.match(outbound, /failed command/); assert.match(outbound, /exit=1/); assert.doesNotMatch(outbound, /PRIVATE-REASONING/);
  sentences.stop(); model.cancelAll();
});

test('05: question revisions, pending and decided chips, permission first without answering', async (t) => {
  const f = fixture(t), a = f.job(1, 'working'), b = f.job(2, 'working');
  f.put(a, 'qa/q1.md', '# Question\nQuestion: clarify the width?\n' + 'x'.repeat(5000) + 'NOT-OUTBOUND');
  f.put(b, 'qa/q1.md', '# Question\nQuestion: authorise deleting the synthetic fixture?\nDefault if unanswered: B');
  f.put(b, 'qa/q2.md', 'Question: authorise a synthetic change?\nDefault if unanswered: A\nOptions:\nA: keep\nB: change');
  f.put(b, 'qa/q2.answer.md', 'B: change');
  let board = await f.pump(); assert.equal(f.calls.length, 3);
  assert.deepEqual(f.service.usage().byFeature, { 'question-category': 3 });
  assert.equal(board.workers.find((w) => w.id.endsWith(b)).labels.category, 'owner authorisation');
  assert.equal(board.decisions[0].category, 'owner authorisation');
  assert.doesNotMatch(JSON.stringify(f.calls), /NOT-OUTBOUND/);
  const state = initialMonitorState();
  const text = homeRows(board, state, 120, f.now, { workboard: board }).map((r) => stripAnsi(r.text)).join('\n');
  assert.ok(text.indexOf('authorise deleting') < text.indexOf('clarify the width'));
  assert.match(text, /owner authorisation/);
  assert.equal(fs.existsSync(join(f.home, 'jobs', a, 'qa/q1.answer.md')), false);
  f.open(); await f.pump(); assert.equal(f.calls.length, 3);
  f.now += 1000; f.put(a, 'qa/q1.md', 'Question: authorise a revised synthetic fixture?');
  board = await f.pump(); assert.equal(f.calls.length, 4); assert.equal(board.workers.find((w) => w.id.endsWith(a)).labels.category, 'owner authorisation');
});

test('06: findings split independently of headings, bounded, revision cached, empty means no counts/call', async (t) => {
  const f = fixture(t), id = f.job(1, 'working');
  f.put(id, 'review-1.md', '# Unusual headings\n' + Array.from({ length: 30 }, (_, i) => `${i + 1}. finding ${i} ${'x'.repeat(500)}`).join('\n') + '\nNOT-OUTBOUND');
  let board = await f.pump(); assert.equal(f.calls.length, 1);
  assert.deepEqual(board.workers[0].labels.severity, [8, 8, 8]);
  assert.deepEqual(f.service.usage().byFeature, { 'review-severity': 1 });
  assert.equal(f.calls[0].body.questions.length, 24);
  assert.ok(f.calls[0].body.input[0].content[1].data.page.text.length <= 24 * 410);
  assert.doesNotMatch(JSON.stringify(f.calls), /Unusual headings|NOT-OUTBOUND/);
  f.open(); await f.pump(); assert.equal(f.calls.length, 1);
  f.now += 1000; f.put(id, 'review-1.md', '# Anything\n- Fix this\n  continued detail\n- Consider that\n');
  board = await f.pump(); assert.equal(f.calls.length, 2); assert.deepEqual(board.workers[0].labels.severity, [1, 1, 0]);
  assert.deepEqual(reviewFindings('- Fix this\n  continued detail\n'), ['- Fix this\n  continued detail']);
  f.now += 1000; f.put(id, 'review-1.md', 'Verdict: accept\nNo findings.');
  board = await f.pump(); assert.equal(f.calls.length, 2); assert.equal(board.workers[0].labels.severity, undefined);
});

test('06: a reviewer job classifies findings from its own report', async (t) => {
  const f = fixture(t), id = f.job(1, 'done', 0, 'reviewer');
  f.put(id, 'report.md', '# Findings\n- Correct the synthetic boundary');
  const board = await f.pump(); assert.equal(f.calls.length, 2); assert.deepEqual(board.workers[0].labels.severity, [1, 0, 0]);
});

for (const lang of ['en', 'zh']) for (const width of [80, 120]) test(`01–06: Home, Inspector and progress rows ${lang}/${width}`, async (t) => {
  const f = fixture(t), id = f.job();
  f.put(id, 'brief.md', '# Synthetic UI feature\n\nGoal: build interface');
  f.put(id, 'report.md', 'Live validation not run');
  f.put(id, 'review-1.md', '## Observations\n- Fix boundary\n- Improve style\n- Optional name');
  const board = await f.pump();
  const previous = setLanguage(lang); t.after(() => setLanguage(previous));
  const state = initialMonitorState(), w = board.workers[0];
  const project = { waiting: [], docs: [], control: [], agents: [], keys: [], editing: [], roleCount: 0,
    ladder: { ids: [] }, ledger: [], active: [], counts: { working: 1, blocked: 0, try: 0, accepted: 0, todo: 0, dropped: 0 },
    slices: [{ label: 'SYNTHETIC', value: 'synthetic slice', jobId: id }], next: [], tickets: [] };
  const inspector = workInspectorRows(w, state, width, f.now), progress = projectRows(project, { ...state, projectPage: 'progress' }, width, f.now, board, true);
  const frame = renderMonitor({ tree: { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(f.now) }, workboard: board,
    modelEnabled: true, state, width, height: 80, nowMs: f.now });
  for (const rows of [inspector, progress]) for (const r of rows) assert.ok(visualLength(r.text) <= width, stripAnsi(r.text));
  for (const line of frame.lines) assert.equal(visualLength(line), width);
  assert.match(frame.lines.map(stripAnsi).join('\n'), new RegExp(tr('partial')));
  const inspectText = inspector.map((r) => stripAnsi(r.text)).join('\n');
  for (const label of ['kind', 'feature', 'ui', 'partial', 'must fix', 'should fix', 'optional']) assert.ok(inspectText.includes(tr(label)), inspectText);
  assert.match(inspectText, /90%/);
  const projectText = progress.map((r) => stripAnsi(r.text)).join('\n');
  for (const label of ['partial', 'must fix']) assert.ok(projectText.includes(tr(label)), projectText);
  assert.doesNotMatch(projectText, /Model fit|模型适配/, 'Model fit was removed (owner, 2026-11-12)');
  // Pending/decided category and looping marks use the same translated bounded rows.
  const running = { ...w, settledAt: null, homeNeedsHuman: true, labels: { ...w.labels, looping: 0.9, category: 'owner authorisation' } };
  const d = { id: 'q1', laneId: w.laneId, title: 'Synthetic choice', option: 'Keep fixture', departure: false, category: 'owner authorisation', evidence: [], kind: 'answer', stale: false };
  const live = { ...empty([running], [d]), lanes: [{ ...board.lanes[0], workers: [running], decisions: [d] }] };
  const rows = homeRows(live, state, width, f.now, { workboard: live });
  assert.ok(rows.map((r) => stripAnsi(r.text)).join('\n').includes(tr('owner authorisation')));
  for (const r of rows) assert.ok(visualLength(r.text) <= width);
  const loopInspector = workInspectorRows(running, state, width, f.now).map((r) => stripAnsi(r.text)).join('\n');
  assert.ok(loopInspector.includes(tr('looping'))); assert.match(loopInspector, /90%/);
});

test('cached overlays/repaints do no file or model I/O; parallel panels coalesce the same revision', async (t) => {
  const f = fixture(t), id = f.job(); f.put(id, 'report.md', 'Partial work');
  const peer = new DecisionLabels(f.dir, () => {}, { HUD_HOME: f.home, GEMINI_API_KEY: 'synthetic' }, f.fetch, () => f.now);
  peer.configure(true, 60);
  t.after(() => peer.stop());
  for (let i = 0; i < 20; i++) {
    f.service.update(f.board(), f.home); peer.update(f.board(), f.home); await pause();
  }
  assert.equal(f.calls.length, 1);
  assert.equal(peer.apply(f.board()).workers[0].labels.outcome.value, 'partial');
  const board = f.board();
  const reads = t.mock.method(fsMutable, 'readSync', () => { throw new Error('painting must not read'); });
  for (let i = 0; i < 10; i++) assert.equal(f.service.apply(board).workers[0].labels.outcome.value, 'partial');
  assert.equal(reads.mock.callCount(), 0);
});

test('quiet activity excludes private/unknown channels and bounds tool/result pairs', async (t) => {
  const f = fixture(t), id = f.job(1, 'working');
  f.put(id, 'sessions/synthetic.jsonl', transcript('public command', 20) + JSON.stringify({ message: { role: 'assistant', channel: 'analysis', content: [{ type: 'toolCall', name: 'PRIVATE-TOOL', arguments: { command: 'PRIVATE-COMMAND' } }] } }) + '\n');
  const a = jobActivity(f.home, f.board().workers[0]);
  assert.equal(a.items.length, 12); assert.doesNotMatch(JSON.stringify(a.items), /PRIVATE-/);
  assert.ok(a.items.every((s) => s.length <= 1203));
});

test('06: a review with only non-finding check bullets shows no severity counts', async (t) => {
  const f = fixture(t), id = f.job(1, 'working');
  f.reply = () => 'not a finding';
  f.put(id, 'review-1.md', 'No findings.\n- Synthetic tests passed\n- Build passed');
  const board = await f.pump();
  assert.deepEqual(board.workers[0].labels.severity, [0, 0, 0]);
  const text = workInspectorRows(board.workers[0], initialMonitorState(), 80, f.now).map((r) => stripAnsi(r.text)).join('\n');
  assert.doesNotMatch(text, /must fix|should fix|optional/);
});

test('master off aborts an in-flight label and excludes its late result', async (t) => {
  const f = fixture(t), id = f.job(); f.put(id, 'report.md', 'Partial work');
  let release, entered;
  const started = new Promise((r) => { entered = r; });
  const held = new Promise((r) => { release = r; });
  const service = new DecisionLabels(f.dir, () => {}, { HUD_HOME: f.home, GEMINI_API_KEY: 'synthetic' }, async (url, init) => {
    entered(); await held; return f.fetch(url, init);
  }, () => f.now);
  service.configure(true, 60); service.update(f.board(), f.home); await started;
  service.configure(false, 60); release(); await pause(); await pause();
  assert.equal(service.apply(f.board()).workers[0].labels, undefined);
  assert.equal(fs.existsSync(join(f.dir, 'decision-labels')), false);
});

test('Decision API defaults to OpenAI and Settings switches the next uncached label to Gemini/TypeSafe', async (t) => {
  const f = fixture(t, { OPENAI_API_KEY: 'synthetic-openai', GEMINI_API_KEY: 'synthetic-gemini', TYPESAFE_API_KEY: 'synthetic-typesafe' });
  for (const [i, primary, url] of [[1, undefined, /api.openai.com/], [2, 'gemini', /googleapis/], [3, 'typesafe', /typesafe/]]) {
    if (primary) {
      const before = process.env.HUD_HOME;
      process.env.HUD_HOME = f.home;
      try { saveSettings({ decisionApi: primary }); }
      finally { if (before === undefined) delete process.env.HUD_HOME; else process.env.HUD_HOME = before; }
      assert.equal(JSON.parse(fs.readFileSync(join(f.home, 'config.json'), 'utf8')).decisions.primary, primary);
    }
    const id = f.job(i); f.put(id, 'report.md', 'Synthetic completed work');
    const board = await f.pump();
    assert.equal(f.calls.length, i, 'one call per new settlement; existing labels remain cached');
    assert.match(f.calls.at(-1).url, url);
    assert.equal(board.workers.find((w) => w.id.endsWith(id)).labels.outcome.value, 'partial');
  }
});

for (const mode of ['missing-primary', 'automatic', 'explicit', 'same-as-primary', 'typesafe-only'])
  test(`labels reuse the shared provider fallback: ${mode}`, async (t) => {
    const f = fixture(t, mode === 'missing-primary' ? { GEMINI_API_KEY: 'synthetic' }
      : mode === 'typesafe-only' ? { TYPESAFE_API_KEY: 'synthetic' }
      : { OPENAI_API_KEY: 'synthetic', GEMINI_API_KEY: 'synthetic', TYPESAFE_API_KEY: 'synthetic' });
    f.config({ primary: 'openai', ...(mode === 'explicit' ? { fallback: 'typesafe' } : mode === 'same-as-primary' ? { fallback: 'openai' } : {}) });
    f.fail = (url) => url.includes('openai') ? 503 : undefined;
    const id = f.job(); f.put(id, 'report.md', 'Partial synthetic work');
    const board = await f.pump();
    assert.equal(f.calls.length, ['missing-primary', 'typesafe-only'].includes(mode) ? 1 : 2);
    assert.match(f.calls.at(-1).url, ['explicit', 'typesafe-only'].includes(mode) ? /typesafe/ : /googleapis/);
    assert.equal(board.workers[0].labels.outcome.value, 'partial');
  });

for (const primary of ['openai', 'gemini']) test(`failed ${primary} label hides HTTP 402 text and retains revision retry rules`, async (t) => {
  const f = fixture(t); f.config({ primary });
  f.fail = () => 402;
  const id = f.job(); f.put(id, 'report.md', 'Synthetic work');
  let board = await f.pump();
  assert.equal(f.calls.length, 1, '402 does not change the existing failover rule');
  assert.equal(board.workers[0].labels.outcome, undefined);
  const texts = [homeRows(board, initialMonitorState(), 120, f.now, { workboard: board }),
    workInspectorRows(board.workers[0], initialMonitorState(), 120, f.now)];
  for (const rows of texts) assert.doesNotMatch(rows.map((r) => stripAnsi(r.text)).join('\n'), /402|prepayment|SYNTHETIC-HTTP-BODY|decision_provider_error/);
  for (const file of fs.readdirSync(join(f.dir, 'decision-labels')))
    assert.doesNotMatch(fs.readFileSync(join(f.dir, 'decision-labels', file), 'utf8'), /402|prepayment|SYNTHETIC-HTTP-BODY/);
  f.fail = undefined; f.open(); await f.pump();
  assert.equal(f.calls.length, 1, 'failed unchanged revision stays quiet across reopen');
  f.now += 1000; f.put(id, 'STATUS.json', { state: 'done', settled_at: new Date(f.now).toISOString() });
  board = await f.pump();
  assert.equal(f.calls.length, 2, 'a new settlement retries normally');
  assert.equal(board.workers[0].labels.outcome.value, 'partial');
});

test('01: Gemini 429 and fallback share the separate Decision cap, never the LLM ledger', async (t) => {
  const f = fixture(t); f.config({ primary: 'gemini' }); f.quota = true; f.cap = 3; f.open();
  const id = f.job(); f.put(id, 'report.md', 'Partial synthetic work');
  let board = await f.pump(); assert.equal(f.calls.length, 2); assert.match(f.calls[0].url, /googleapis/); assert.match(f.calls[1].url, /api.openai.com/);
  assert.equal(board.workers[0].labels.outcome.value, 'partial');
  const b = f.job(2); f.put(b, 'report.md', 'Partial second job');
  board = await f.pump(); assert.equal(f.calls.length, 3); assert.match(f.calls[2].url, /api.openai.com/, 'cooldown skips Gemini');
  const text = new SmallModel({ dir: f.dir, env: { HUD_HOME: f.home, MISTRAL_API_KEY: 'synthetic' }, clock: () => f.now,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Synthetic sentence.' } }] })) });
  text.configure({ backend: 'api', hourlyCap: 3 });
  const result = await text.submit({ feature: 'job-sentence', system: 'test', prompt: 'synthetic' }).result;
  assert.equal(result.ok, true); assert.equal(text.usage().lastHour, 1); assert.equal(f.service.usage().lastHour, 3);
  assert.deepEqual(f.service.usage().byFeature, { outcome: 3 }, 'fallback retains its original feature');
  assert.deepEqual(text.usage().byFeature, { 'job-sentence': 1 });
  assert.equal(JSON.parse(fs.readFileSync(join(f.dir, 'calls.json'))).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(join(f.dir, 'decision-api/calls.json'))).length, 3); text.cancelAll();
  f.open(); await f.pump(); assert.equal(f.calls.length, 3);
});

test('closing an idle job keeps its settlement time, so its age and outcome label do not reset', (t) => {
  const home = fsMutable.mkdtempSync(join(tmpdir(), 'settle-close-'));
  t.after(() => fsMutable.rmSync(home, { recursive: true, force: true }));
  const dir = join(home, 'jobs', 'j0123456789abcdef');
  fsMutable.mkdirSync(dir, { recursive: true });
  fsMutable.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job: 'j0123456789abcdef', herdr_pane: 'w4E:p1', role: 'imp', created_at: '2026-11-12T10:00:00Z' }));
  const settled = '2026-11-12T10:10:00.000Z';
  const read = (status) => {
    fsMutable.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify(status));
    return readThinJobs(home, { pane: 'w4E:p1', project: null }).flatMap((l) => l.workers)[0].settledAt;
  };
  const idle = read({ state: 'idle_grace', settled_at: settled, output_written: true });
  const closed = read({ state: 'closed', settled_at: settled, ended_at: '2026-11-12T10:40:00.000Z', output_written: true });
  assert.equal(idle, Date.parse(settled));
  assert.equal(closed, idle);
});
