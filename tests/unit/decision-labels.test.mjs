import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsMutable from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DecisionLabels, reviewFindings } from '../../dist-test/src/collectors/decision-labels.js';
import { modelFit } from '../../dist-test/src/collectors/model-fit.js';
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
  f.fetch = async (url, init) => {
    const body = JSON.parse(init.body), gemini = String(url).includes('googleapis');
    f.calls.push({ url: String(url), body });
    if (f.quota && gemini) return new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), { status: 429, headers: { 'retry-after': '60' } });
    const qs = gemini ? Object.entries(body.questions).map(([name, q]) => ({ name, values: Object.keys(q.criteria) }))
      : body.questions.map((q) => ({ name: q.name, values: q.choices.map((c) => c.value) }));
    const input = JSON.stringify(body.input);
    const answers = qs.map(({ name, values }) => {
      const choice = f.reply?.(name, input, values) ?? (name === 'outcome' ? 'partial' : name === 'progress' ? (input.includes('failed command') ? 'looping' : 'progressing')
        : name === 'category' ? (input.includes('authorise') ? 'owner authorisation' : 'clarification')
        : name.startsWith('f') && /^f\d+$/.test(name) ? ['must fix', 'should fix', 'optional'][Number(name.slice(1)) % 3]
        : name === 'feature' || name === 'ui' ? 'included' : 'excluded');
      const probabilities = Object.fromEntries(values.map((v) => [v, v === choice ? 0.9 : 0.1 / (values.length - 1)]));
      return { name, type: 'choice', choice, confidence: 0.9, probabilities };
    });
    return new Response(JSON.stringify({ answers: gemini ? Object.fromEntries(answers.map(({ name, ...a }) => [name, a])) : answers.map((a) => ({ ...a, probabilities: Object.entries(a.probabilities).map(([value, probability]) => ({ value, probability })) })) }));
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
for (const mode of ['off', 'no-key', 'typesafe-only']) test(`01: ${mode} hides labels and sends nothing`, async (t) => {
  const f = fixture(t, mode === 'off' ? undefined : mode === 'typesafe-only' ? { TYPESAFE_API_KEY: 'synthetic' } : {});
  const id = f.job(); f.put(id, 'report.md', 'Done');
  if (mode === 'off') f.service.configure(false, 60);
  const board = await f.pump(); assert.equal(f.calls.length, 0); assert.equal(board.workers[0].labels, undefined);
});

test('02: multi-kind once, bounded title/goal, newest-first 30-day backfill inside the cap', async (t) => {
  const f = fixture(t); f.cap = 2; f.open();
  const newest = f.job(1), older = f.job(2, 'done', 86400000), oldest = f.job(3, 'done', 2 * 86400000), expired = f.job(4, 'done', 31 * 86400000);
  for (const [id, title] of [[newest, 'newest'], [older, 'older'], [oldest, 'oldest'], [expired, 'expired']])
    f.put(id, 'brief.md', `# ${title}\n\nGoal: feature UI.\n\nNOT-OUTBOUND\n` + 'x'.repeat(2000));
  let board = await f.pump();
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].body.input, /newest/); assert.match(f.calls[1].body.input, /older/);
  assert.doesNotMatch(JSON.stringify(f.calls), /NOT-OUTBOUND|expired/);
  assert.deepEqual(board.workers[0].labels.kinds, ['ui', 'feature']);
  f.open(); await f.pump(); assert.equal(f.calls.length, 2);
  f.now += 3600001; board = await f.pump(); assert.equal(f.calls.length, 3);
  assert.match(f.calls[2].body.input, /oldest/);
  assert.equal(board.workers.find((w) => w.id.endsWith(expired)).labels.kinds.length, 0);
  f.now += 3600001; f.put(newest, 'brief.md', '# Changed title\n\nNew goal');
  await f.pump(); assert.equal(f.calls.length, 3, 'kind is frozen per job');
});

test('03: model-fit groups assignments, exact splits, even median, and unlabelled jobs', () => {
  const worker = (n, duration, outcome, kinds = ['feature'], effort = 'high') => ({ id: `thin-job:j${n}`, role: 'imp', model: 'model-a', effort,
    startedAt: 1000, settledAt: 1000 + duration, labels: { kinds, outcome: outcome ? { value: outcome, confidence: 0.9 } : undefined } });
  const rows = modelFit([worker(1, 10000, 'done'), worker(2, 30000, 'partial'), worker(3, 20000, 'failed'), worker(4, 40000, 'blocked'), worker(5, 9000, undefined, [], 'low')]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].outcomes, [1, 1, 1, 1]); assert.equal(rows[0].runs, 4); assert.equal(rows[0].median, 25000);
  assert.equal(rows[1].kind, 'unlabelled'); assert.equal(rows[1].unlabelled, 1); assert.equal(rows[1].median, 9000);
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
  assert.equal(Object.keys(f.calls[0].body.questions).length, 24);
  assert.ok(JSON.parse(f.calls[0].body.input.split('\n').slice(1).join('\n')).page.text.length <= 24 * 410);
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

for (const lang of ['en', 'zh']) for (const width of [80, 120]) test(`01–06: Home, Inspector, progress and Model fit rows ${lang}/${width}`, async (t) => {
  const f = fixture(t), id = f.job();
  f.put(id, 'brief.md', '# Synthetic UI feature\n\nGoal: build interface');
  f.put(id, 'report.md', 'Live validation not run');
  f.put(id, 'review-1.md', '## Observations\n- Fix boundary\n- Improve style\n- Optional name');
  const board = await f.pump();
  const previous = setLanguage(lang); t.after(() => setLanguage(previous));
  const state = initialMonitorState(), w = board.workers[0];
  const project = { waiting: [], docs: [], control: [], agents: [], keys: [], editing: [], roleCount: 0,
    ladder: { ids: [] }, counts: { working: 1, blocked: 0, try: 0, accepted: 0, todo: 0, dropped: 0 },
    slices: [{ label: 'SYNTHETIC', value: 'synthetic slice', jobId: id }], next: [], tickets: [] };
  const inspector = workInspectorRows(w, state, width, f.now), progress = projectRows(project, state, width, f.now, board, true);
  const frame = renderMonitor({ tree: { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(f.now) }, workboard: board,
    modelEnabled: true, state, width, height: 80, nowMs: f.now });
  for (const rows of [inspector, progress]) for (const r of rows) assert.ok(visualLength(r.text) <= width, stripAnsi(r.text));
  for (const line of frame.lines) assert.equal(visualLength(line), width);
  assert.match(frame.lines.map(stripAnsi).join('\n'), new RegExp(tr('partial')));
  const inspectText = inspector.map((r) => stripAnsi(r.text)).join('\n');
  for (const label of ['kind', 'feature', 'ui', 'partial', 'must fix', 'should fix', 'optional']) assert.ok(inspectText.includes(tr(label)), inspectText);
  assert.match(inspectText, /90%/);
  const projectText = progress.map((r) => stripAnsi(r.text)).join('\n');
  for (const label of ['Model fit', 'partial', 'must fix', 'unlabelled', 'median']) assert.ok(projectText.includes(tr(label)), projectText);
  const fitRows = progress.filter((r) => stripAnsi(r.text).includes('imp · synthetic-model · high'));
  assert.equal(fitRows.length, 2, 'one assignment row for each of the two kinds');
  for (const r of fitRows) assert.match(stripAnsi(r.text), /1 · 0\/1\/0\/0 · 0 · 120s/);
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

test('03: running unlabelled jobs count as runs but never invent a duration', () => {
  const rows = modelFit([{ id: 'thin-job:j0123456789abcdef', role: 'imp', model: null, effort: null, startedAt: 1000, settledAt: null }]);
  assert.equal(rows[0].runs, 1); assert.equal(rows[0].unlabelled, 1); assert.equal(rows[0].median, null);
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

test('01: Gemini 429 reuses cooldown and OpenAI failover; every HTTP attempt shares the text hourly cap', async (t) => {
  const f = fixture(t); f.quota = true; f.cap = 3; f.open();
  const id = f.job(); f.put(id, 'report.md', 'Partial synthetic work');
  let board = await f.pump(); assert.equal(f.calls.length, 2); assert.match(f.calls[0].url, /googleapis/); assert.match(f.calls[1].url, /api.openai.com/);
  assert.equal(board.workers[0].labels.outcome.value, 'partial');
  const b = f.job(2); f.put(b, 'report.md', 'Partial second job');
  board = await f.pump(); assert.equal(f.calls.length, 3); assert.match(f.calls[2].url, /api.openai.com/, 'cooldown skips Gemini');
  const text = new SmallModel({ dir: f.dir, env: { HUD_HOME: f.home, MISTRAL_API_KEY: 'synthetic' }, clock: () => f.now, fetch: async () => { throw new Error('cap must prevent fetch'); } });
  text.configure({ backend: 'api', hourlyCap: 3 });
  const result = await text.submit({ feature: 'job-sentence', system: 'test', prompt: 'synthetic' }).result;
  assert.equal(result.ok, false); assert.equal(result.reason, 'hourly-cap'); assert.equal(text.usage().lastHour, 3); text.cancelAll();
  f.open(); await f.pump(); assert.equal(f.calls.length, 3);
});
