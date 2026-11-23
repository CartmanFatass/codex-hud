import { withState } from '../fixtures/state-helpers.mjs';
import { homeCursor, homeTarget } from '../../dist/render/monitor-state.js';
/** The owner's micro-actions on a HUD job from the panel (spec §2.2): `g` its tab, `1`–`4` / `d` on its expanded question to answer, `X` to stop. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOW, TREE, plain } from '../fixtures/project-page.mjs';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { answerJobQuestion, PanelActionLog, PANEL_ACTIONS_FILE } from '../../dist/collectors/panel-actions.js';
import { focusJobTab, stopJob } from '../../dist/cli/panel-pane.js';
import { watchCommand } from '../../dist/cli/watch.js';
import { renderMonitor, initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';

const PANE = 'w4E:p1', ASKING = 'j0123456789abcdef', RUNNING = 'j1111111111111111', DONE = 'j2222222222222222';
const QUESTION = '# Question q1 from imp@demo\n\nKeep the v1 shim for one more release?\n\nOptions:\n- keep it\n- remove it now\n\nDefault if unanswered: keep it\n\nContext: the parser still reads v1\n';
const decoder = new WorkbenchInputDecoder('workboard');
/** What the panel's own keyboard hands over for these bytes. */
const key = (bytes) => decoder.push(Buffer.from(bytes))[0];

function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'micro-actions-'));
  const display = setDisplayConfig({ theme: 'terminal', icons: 'unicode' });
  t.after(() => { setDisplayConfig(display); fs.rmSync(home, { recursive: true, force: true }); });
  const put = (id, role, status, extra = {}) => {
    const dir = join(home, 'jobs', id);
    fs.mkdirSync(join(dir, 'qa'), { recursive: true });
    const files = { 'job.json': { job: id, herdr_pane: PANE, role, package: role.toUpperCase(), created_at: new Date(NOW - 240_000).toISOString() },
      'STATUS.json': status, 'brief.md': `# ${role.toUpperCase()}: synthetic job`, ...extra };
    for (const [file, body] of Object.entries(files)) {
      fs.mkdirSync(join(dir, file, '..'), { recursive: true });
      fs.writeFileSync(join(dir, file), typeof body === 'string' ? body : JSON.stringify(body));
      fs.utimesSync(join(dir, file), new Date(NOW - 240_000), new Date(NOW - 240_000));
    }
    return dir;
  };
  put(ASKING, 'imp', { state: 'working' }, { 'qa/q1.md': QUESTION });
  put(RUNNING, 'reviewer', { state: 'working' });
  put(DONE, 'sonic', { state: 'closed' }, { 'report.md': 'Done.' });
  const lanes = readThinJobs(home, { pane: PANE, project: null });
  const board = { revision: 'micro', lanes, workers: lanes.flatMap((l) => l.workers), decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: null } };
  const worker = (id) => board.workers.find((w) => w.id === `thin-job:${id}`);
  const render = (state = initialMonitorState(), width = 60, lang = 'en', height = 30) => {
    const language = setLanguage(lang);
    try { return renderMonitor({ tree: TREE, workboard: board, state, width, height, nowMs: NOW }); } finally { setLanguage(language); }
  };
  /** Select a job's card, draw, press one key and draw again: the outcome and the frame it leaves. */
  const press = (id, bytes, state = {}) => {
    const w = worker(id);
    const frame = render(withState(initialMonitorState(), { home: { cursor: { kind: 'work', target: { kind: 'worker', laneId: w.laneId, workerId: w.id } } } }, state));
    const out = handleMonitorInput(frame.state, typeof bytes === 'string' ? key(bytes) : bytes, { tree: TREE, frame, nowMs: NOW });
    return { out, frame: render(out.state, 60, 'en') };
  };
  return { home, board, worker, render, press, dir: (id) => join(home, 'jobs', id) };
}

test('the decoder names the new keys; the digits are options, not tabs, and Changes has a letter', () => {
  assert.deepEqual([key('g'), key('d'), key('X'), key('r')].map((k) => [k.key, k.text]), [['', 'g'], ['answer-default', 'd'], ['stop-job', 'X'], ['reset', 'r']]);
  assert.deepEqual(['1', '2', '3', '4'].map((c) => [key(c).key, c]), ['1', '2', '3', '4'].map((c) => ['option', c]));
  assert.deepEqual(['1', '2', '3', '4'].map((c) => key(c).text), ['1', '2', '3', '4']);
  assert.equal(key('f').key, 'changes');
  assert.deepEqual(decoder.push(Buffer.from('\x1b[H')).map((k) => [k.key, k.text]), [['home', undefined]]);
});

test('answerJobQuestion writes qN.answer.md once with mode 0600 and records it; bad ids, a missing question and a second answer change nothing', (t) => {
  const f = fixture(t), file = join(f.dir(ASKING), 'qa/q1.answer.md');
  assert.deepEqual(answerJobQuestion(f.home, ASKING, 'q1', ' keep it \n', 'imp'), { ok: true, written: true });
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep it');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(answerJobQuestion(f.home, ASKING, 'q1', 'remove it now'), { ok: true, written: false });
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep it', 'the first answer stands');
  for (const [job, qid, answer] of [['../x', 'q1', 'a'], [ASKING, 'q1/../../x', 'a'], [ASKING, 'q9', 'a'], [ASKING, 'q1', '  ']])
    assert.equal(answerJobQuestion(f.home, job, qid, answer).ok, false, `${job} ${qid}`);
  assert.equal(fs.existsSync(join(f.dir(ASKING), 'qa/q9.answer.md')), false);
  const log = fs.readFileSync(join(f.home, PANEL_ACTIONS_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1, 'only the answer that was written is recorded');
  assert.deepEqual({ ...log[0], at: undefined }, { at: undefined, type: 'answer', job: ASKING, qid: 'q1', role: 'imp', answer: 'keep it' });
  assert.equal(fs.statSync(join(f.home, PANEL_ACTIONS_FILE)).mode & 0o777, 0o600);
});

test('PanelActionLog tells only of answers made after it started, for the jobs it follows, once', (t) => {
  const f = fixture(t);
  fs.writeFileSync(join(f.dir(ASKING), 'qa/q2.md'), QUESTION);
  assert.equal(answerJobQuestion(f.home, ASKING, 'q1', 'before', 'imp').ok, true);
  const log = new PanelActionLog(f.home);
  assert.deepEqual(log.changes(new Set([ASKING])), []);
  assert.equal(answerJobQuestion(f.home, ASKING, 'q2', 'remove it now\nnow', 'imp').ok, true);
  assert.deepEqual(log.changes(new Set([RUNNING])), [], 'another session\'s job is not this one\'s news');
  assert.deepEqual(log.changes(new Set([ASKING])), [], 'and it is read once');
  fs.writeFileSync(join(f.dir(ASKING), 'qa/q3.md'), QUESTION);
  answerJobQuestion(f.home, ASKING, 'q3', 'keep it', 'imp');
  assert.deepEqual(log.changes(new Set([ASKING])), [`[imp@${ASKING}] ANSWERED q3 from panel: keep it`]);
  // A line still being written waits for its newline.
  fs.appendFileSync(join(f.home, PANEL_ACTIONS_FILE), JSON.stringify({ type: 'answer', job: ASKING, qid: 'q4', role: null, answer: 'late' }));
  assert.deepEqual(log.changes(new Set([ASKING])), []);
  fs.appendFileSync(join(f.home, PANEL_ACTIONS_FILE), '\n');
  assert.deepEqual(log.changes(new Set([ASKING])), [`[job@${ASKING}] ANSWERED q4 from panel: late`]);
});

test('hud watch tells the main session what the owner answered from the panel', { timeout: 10000 }, async (t) => {
  const f = fixture(t), lines = [], ac = new AbortController();
  t.after(() => ac.abort());
  const running = watchCommand([], { env: { HUD_HOME: f.home, HERDR_PANE_ID: PANE }, stdout: (s) => lines.push(s.trim()), stderr: () => {} }, { signal: ac.signal, rescanMs: 60 });
  await new Promise((r) => setTimeout(r, 200));
  lines.length = 0;
  answerJobQuestion(f.home, ASKING, 'q1', 'remove it now', 'imp');
  const end = Date.now() + 4000;
  while (!lines.some((l) => l.includes('ANSWERED')) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  ac.abort();
  await running;
  assert.deepEqual(lines.filter((l) => l.includes('ANSWERED')), [`[imp@${ASKING}] ANSWERED q1 from panel: remove it now`]);
});

test('g on a HUD job card (Home and Inspector) focuses its tab; elsewhere it means nothing (the Home key is the top)', (t) => {
  const f = fixture(t);
  for (const id of [ASKING, RUNNING, DONE]) assert.deepEqual(f.press(id, 'g').out.action, { type: 'focus-job-tab', dir: f.dir(id) }, id);
  const home = f.press(RUNNING, '\x1b[H');
  assert.equal(home.out.action, undefined, 'the Home key moves, it does not focus');
  const w = f.worker(RUNNING), target = { kind: 'worker', laneId: w.laneId, workerId: w.id };
  assert.deepEqual(f.press(RUNNING, 'g', { subpage: { kind: 'inspector', scroll: 0, target } }).out.action, { type: 'focus-job-tab', dir: f.dir(RUNNING) });
  // A lane header, the progress block and the Project tab have no job: `g` does nothing.
  assert.equal(f.press(RUNNING, 'g', { activeTab: 'project' }).out.action, undefined);
  const header = f.render(), ctx = { tree: TREE, frame: header, nowMs: NOW };
  assert.equal(handleMonitorInput(withState(header.state, { home: { cursor: { kind: 'work', target: { kind: 'lane', laneId: w.laneId } } } }), key('g'), ctx).action, undefined);
  assert.equal(handleMonitorInput(withState(header.state, { home: { cursor: homeCursor(target, 'home-progress:progress') } }), key('g'), ctx).action, undefined);
});

test('r requests a retry only on a failed HUD job', (t) => {
  const f = fixture(t);
  assert.equal(f.press(RUNNING, 'r').out.action, undefined);
  assert.equal(f.press(DONE, 'r').out.action, undefined);
  f.worker(DONE).state = 'failed';
  assert.deepEqual(f.press(DONE, 'r').out.action, { type: 'request-retry', home: f.home, jobId: DONE });
});

test('1–4 switch no tab; on an expanded answerable question they pick an option and d the default, with no r first', (t) => {
  const f = fixture(t), asked = f.worker(ASKING), target = targetKey({ kind: 'worker', laneId: asked.laneId, workerId: asked.id });
  const open = { home: { expanded: new Set([target]) } };
  // The slab says its keys once it is open, and offers them nowhere else.
  const closed = plain(f.press(ASKING, 'x').frame).join('\n');
  assert.doesNotMatch(closed, /\[1\]|1-2 answer|r reply|qa\/q1\.md/);
  assert.deepEqual(f.press(ASKING, 'o').out.action, { type: 'open-files', files: [join(f.dir(ASKING), 'qa/q1.md')] });
  const { out, frame } = f.press(ASKING, 'x', open);
  const text = plain(f.render(withState(initialMonitorState(), { home: { cursor: homeCursor(homeTarget(out.state.home)) } }, open))).join('\n');
  assert.match(text, /┃ \[1\] keep it\n┃ \[2\] remove it now/);
  assert.match(text, /^┃ 1-2 answer {2}d default$/m);
  assert.doesNotMatch(text, /r reply|qa\/q1\.md/);
  const action = (answer) => ({ type: 'answer-job', home: f.home, jobId: ASKING, qid: 'q1', answer, role: 'imp' });
  assert.deepEqual(f.press(ASKING, '1', open).out.action, action('keep it'));
  assert.deepEqual(f.press(ASKING, '2', open).out.action, action('remove it now'));
  assert.deepEqual(f.press(ASKING, 'd', open).out.action, action('keep it'));
  // No third option: nothing happens. No digit changes the tab, on the slab or off it.
  for (const c of ['1', '2', '3', '4']) assert.equal(f.press(ASKING, c, open).out.state.activeTab, 'home', `${c} leaves the tab alone`);
  assert.equal(f.press(ASKING, '3', open).out.action, undefined);
  // A collapsed question is not answered by a stray digit, and the digits are no tabs there either.
  for (const c of ['1', '2', 'd']) {
    const closedOut = f.press(ASKING, c).out;
    assert.equal(closedOut.action, undefined, c);
    assert.equal(closedOut.state.activeTab, 'home', c);
  }
  // r no longer opens anything on the job: it is the Settings and Control plane key only.
  const reset = f.press(ASKING, 'r', open);
  assert.equal(reset.out.action, undefined);
  assert.equal('reply' in reset.out.state && reset.out.state.reply !== undefined, false);
  // The Inspector shows the question whole, so the keys answer there too.
  const w = f.worker(ASKING), inspect = { subpage: { kind: 'inspector', scroll: 0, target: { kind: 'worker', laneId: w.laneId, workerId: w.id } } };
  assert.deepEqual(f.press(ASKING, '2', inspect).out.action, action('remove it now'));
  assert.match(plain(f.render({ ...initialMonitorState(), ...inspect })).join('\n'), /1-2 answer d default/);
  // The tabs are the arrows, Tab and a click: still switching.
  for (const bytes of ['\x1b[C', '\t']) assert.equal(f.press(ASKING, bytes).out.state.activeTab, 'project', JSON.stringify(bytes));
  assert.equal(frame.lines.length > 0, true);
});

test('the answer keys do nothing on a job with no answerable question; a pane ask has no file to answer', (t) => {
  const f = fixture(t), expanded = (id) => ({ home: { expanded: new Set([targetKey({ kind: 'worker', laneId: f.worker(id).laneId, workerId: f.worker(id).id })]) } });
  for (const id of [RUNNING, DONE]) for (const c of ['1', 'd']) assert.equal(f.press(id, c, expanded(id)).out.action, undefined, `${id} ${c}`);
  // A pane ask (no qN file to answer) is not answerable here either.
  const asked = f.worker(ASKING), saved = asked.work.requestInfo;
  asked.work.requestInfo = { ...saved, id: 'blocked', evidence: { ...saved.evidence, relativePath: 'STATUS.json' } };
  assert.equal(f.press(ASKING, '1', expanded(ASKING)).out.action, undefined);
  asked.work.requestInfo = saved;
  assert.notEqual(f.press(ASKING, '1', expanded(ASKING)).out.action, undefined);
});

test('X asks before stopping an unsettled job: y or Enter stops it, any other input cancels, a settled job has nothing to stop', (t) => {
  const f = fixture(t);
  const { out, frame } = f.press(RUNNING, 'X');
  assert.deepEqual(out.state.overlay, { kind: 'confirm-stop', jobId: RUNNING, role: 'reviewer', dir: f.dir(RUNNING) });
  assert.equal(plain(frame)[1], 'Stop reviewer j1111111?  y confirm · Esc cancel');
  const ctx = { tree: TREE, frame, nowMs: NOW };
  assert.deepEqual(handleMonitorInput(out.state, key('y'), ctx).action, { type: 'stop-job', dir: f.dir(RUNNING) });
  assert.deepEqual(handleMonitorInput(out.state, key('\r'), ctx).action, { type: 'stop-job', dir: f.dir(RUNNING) });
  assert.equal(handleMonitorInput(out.state, key('y'), ctx).state.overlay, undefined);
  for (const input of [{ type: 'key', key: 'escape' }, key('n'), key('j'), { type: 'mouse', button: 'left', x: 2, y: 4 }]) {
    const no = handleMonitorInput(out.state, input, ctx);
    assert.equal(no.action, undefined);
    assert.equal(no.state.overlay, undefined);
    assert.equal(no.close, false);
  }
  assert.equal(f.press(DONE, 'X').out.state.overlay, undefined, 'a settled job is not stopped');
  assert.equal(f.press(RUNNING, 'X', { activeTab: 'project' }).out.state.overlay, undefined);
  const inspected = f.press(RUNNING, 'X', { subpage: { kind: 'inspector', scroll: 0, target: { kind: 'worker', laneId: f.worker(RUNNING).laneId, workerId: f.worker(RUNNING).id } } });
  assert.equal(inspected.out.state.overlay?.jobId, RUNNING);
  assert.equal(plain(inspected.frame)[1], 'Stop reviewer j1111111?  y confirm · Esc cancel');
});

test('the Split layout takes the same keys for the job its list cursor is on', (t) => {
  const f = fixture(t), split = withState(initialMonitorState(), { prefs: { panelLayout: 'split' } });
  let frame = f.render(split, 60, 'en', 30);
  const ctx = () => ({ tree: TREE, frame, nowMs: NOW });
  const run = (bytes, state = frame.state) => { const out = handleMonitorInput(state, typeof bytes === 'string' ? key(bytes) : bytes, ctx()); frame = f.render(out.state, 60, 'en', 30); return out; };
  // The cursor starts on the lane that asks: a digit does nothing until its slab is expanded.
  assert.deepEqual(run('g').action, { type: 'focus-job-tab', dir: f.dir(ASKING) });
  assert.equal(run('2').action, undefined);
  assert.equal(frame.state.activeTab, 'home');
  const asked = f.worker(ASKING);
  frame = f.render(withState(frame.state, { home: { expanded: new Set([targetKey({ kind: 'worker', laneId: asked.laneId, workerId: asked.id })]) } }), 60, 'en', 30);
  const text = plain(frame).join('\n');
  assert.match(text, /┃ \[2\] remove it now/);
  assert.match(text, /1-2 answer {2}d default/);
  assert.deepEqual(run('2').action, { type: 'answer-job', home: f.home, jobId: ASKING, qid: 'q1', answer: 'remove it now', role: 'imp' });
  frame = f.render(withState(frame.state, { home: { split: { listCursor: targetKey({ kind: 'lane', laneId: f.worker(RUNNING).laneId }) } } }), 60, 'en', 30);
  assert.equal(run('X').state.overlay?.jobId, RUNNING);
  assert.equal(plain(frame)[1], 'Stop reviewer j1111111?  y confirm · Esc cancel');
  assert.deepEqual(run('y').action, { type: 'stop-job', dir: f.dir(RUNNING) });
  // The Home key still moves the list's cursor to the top.
  assert.equal(run('\x1b[H').action, undefined);
  assert.equal(frame.state.home.split.listCursor, targetKey({ kind: 'lane', laneId: asked.laneId }));
  const zh = f.render(withState(split, { home: { expanded: new Set([targetKey({ kind: 'worker', laneId: asked.laneId, workerId: asked.id })]) } }), 60, 'zh', 30);
  assert.match(plain(zh).join('\n'), /1-2 答复 {2}d 默认/);
});

test('every row is exactly the panel width with the question expanded, a stop prompt open and the Inspector showing a question, in both layouts and languages', (t) => {
  const f = fixture(t), asking = f.worker(ASKING), running = f.worker(RUNNING);
  const at = (w) => ({ home: { cursor: { kind: 'work', target: { kind: 'worker', laneId: w.laneId, workerId: w.id } } } });
  const states = [
    withState(at(asking), { home: { expanded: new Set([targetKey({ kind: 'worker', laneId: asking.laneId, workerId: asking.id })]) } }),
    { ...at(running), overlay: { kind: 'confirm-stop', jobId: RUNNING, role: 'reviewer', dir: f.dir(RUNNING) } },
    withState(at(asking), { subpage: { kind: 'inspector', scroll: 0, target: { kind: 'worker', laneId: asking.laneId, workerId: asking.id } } }),
  ];
  for (const layout of [undefined, 'split']) for (const lang of ['en', 'zh']) for (const width of [24, 32, 40, 60, 100]) for (const [i, state] of states.entries()) {
    const frame = f.render(withState(initialMonitorState(), { prefs: { panelLayout: layout } }, state), width, lang, 28);
    for (const line of frame.lines) assert.equal(visualLength(line), width, `${layout} ${lang} ${width} state ${i}: ${stripAnsi(line)}`);
  }
  const zh = plain(f.render(withState(initialMonitorState(), states[1]), 60, 'zh'))[1];
  assert.match(zh, /^停止 reviewer j1111111？ {2}y 确认 · Esc 取消/);
  const split = plain(f.render(withState(initialMonitorState(), { prefs: { panelLayout: 'split' } }, states[1]), 60, 'en'));
  assert.equal(split[1], 'Stop reviewer j1111111?  y confirm · Esc cancel');
});

test('Classic Home at 40 columns keeps a collapsed question as its row (lane, option count, age) and the question under it, without a file or hint row', (t) => {
  const f = fixture(t);
  for (const lang of ['en', 'zh']) {
    const frame = f.render(initialMonitorState(), 40, lang), rows = plain(frame);
    const at = rows.findIndex((line) => line.startsWith('?  IMP'));
    assert.ok(at >= 0);
    assert.match(rows[at], lang === 'en' ? /^\? {2}IMP {2}asks 2 opts +4m$/ : /^\? {2}IMP {2}问 2选 +4分$/);
    assert.match(rows[at + 1], /^ {3}Keep the v1 shim for one more releas…\s*$/, 'the question, cut to the line');
    assert.doesNotMatch(rows.join('\n'), /qa\/q1\.md|\[1\]|r reply|Stop |default:|默认:/);
    for (const row of frame.lines) assert.equal(visualLength(row), 40);
  }
});

/** A herdr and a pi-role-reap that only record what they were asked. */
function stubs(t, { herdr = 0, reap = 0 } = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'micro-stubs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = (name, code) => { fs.writeFileSync(join(dir, name), `#!/bin/sh\necho "$@" >> "${join(dir, name)}.log"\nexit ${code}\n`, { mode: 0o700 }); };
  make('herdr', herdr);
  make('pi-role-reap', reap);
  const log = (name) => { try { return fs.readFileSync(join(dir, `${name}.log`), 'utf8').trim().split('\n'); } catch { return []; } };
  return { env: { PATH: dir }, log };
}

test('focusJobTab runs herdr tab focus with the TAB of SESSION.txt and says why it could not', async (t) => {
  const f = fixture(t), s = stubs(t), dir = f.dir(RUNNING);
  assert.deepEqual(await focusJobTab(dir, s.env), { ok: false, reason: 'no tab' });
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'TASK=x\nTAB=w4E:t7\nTAB_NAME=job\n');
  assert.deepEqual(await focusJobTab(dir, s.env), { ok: true });
  assert.deepEqual(s.log('herdr'), ['tab focus w4E:t7']);
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'TAB=\x07bad\n');
  assert.deepEqual(await focusJobTab(dir, s.env), { ok: false, reason: 'no tab' });
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'TAB=w4E:t7\n');
  assert.deepEqual(await focusJobTab(dir, stubs(t, { herdr: 1 }).env), { ok: false, reason: 'tab closed' });
  assert.deepEqual(await focusJobTab(dir, { PATH: join(f.home, 'nowhere') }), { ok: false, reason: 'unavailable' });
});

test('stopJob reaps the job directory, and first asks a CLI job already in its idle grace to quit', async (t) => {
  const f = fixture(t), s = stubs(t), dir = f.dir(RUNNING);
  assert.deepEqual(await stopJob(dir, s.env), { ok: true });
  assert.deepEqual(s.log('pi-role-reap'), [dir]);
  assert.equal(fs.existsSync(join(dir, 'STATUS.json.close-requested')), false, 'a working job is only reaped');
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job: RUNNING, cli: { agent: 'claude' } }));
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  assert.deepEqual(await stopJob(dir, s.env), { ok: true });
  assert.equal(fs.statSync(join(dir, 'STATUS.json.close-requested')).mode & 0o777, 0o600);
  assert.deepEqual(await stopJob(dir, s.env), { ok: true }, 'a close request that is already there is fine');
  assert.deepEqual(await stopJob(dir, stubs(t, { reap: 3 }).env), { ok: false, reason: 'reap failed' });
});
